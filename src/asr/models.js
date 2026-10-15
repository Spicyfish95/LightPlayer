'use strict';
// 模型与外部运行时（FFmpeg）管理：全程 URL 直链下载（https，不依赖 pip/npm/git）。
// 下载源均为公开仓库，按「国内 CDN 优先、官方源兜底、多源故障转移」排列，
// 全部在编码前用 HEAD/GET 实测过文件存在、字节数、Range 支持：
//   - 识别模型：魔搭 ModelScope（cdn-lfs-cn 国内 CDN，约 13MB/s）→ HuggingFace 官方
//   - VAD：GitHub Releases 直链 → ghfast/ghproxy/gh-proxy 三个 GitHub 代理
//   - FFmpeg：gyan.dev → BtbN（GitHub 代理优先，直连兜底）
// 首次开启字幕时按需下载到 %LOCALAPPDATA%\LightPlayer\models\<版本>，断点续传、字节校验。
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const MODEL_VERSION = 'sensevoice-2024-07-17';

const MS_API = 'https://www.modelscope.cn/api/v1/models/fengge2024/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/repo?Revision=master&FilePath=';
const MS_RESOLVE = 'https://modelscope.cn/models/fengge2024/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/master/';
const HF_RESOLVE = 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/';

const GH_VAD = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx';
const GH_PROXIES = ['https://ghfast.top/', 'https://ghproxy.net/', 'https://gh-proxy.com/'];

// 模型清单：文件名 + 精确字节数 + 直链源（按优先级顺序故障转移）
const MODEL_FILES = [
  {
    name: 'model.int8.onnx',
    size: 239233841,
    urls: [MS_API + 'model.int8.onnx', MS_RESOLVE + 'model.int8.onnx', HF_RESOLVE + 'model.int8.onnx'],
  },
  {
    name: 'tokens.txt',
    size: 315894,
    urls: [MS_API + 'tokens.txt', MS_RESOLVE + 'tokens.txt', HF_RESOLVE + 'tokens.txt'],
  },
  {
    name: 'silero_vad.onnx',
    size: 643854,
    urls: [GH_VAD, ...GH_PROXIES.map(p => p + GH_VAD)],
  },
];

function runtimeRoot() {
  // 与历史版本保持一致：已有 FFmpeg 缓存在 %LOCALAPPDATA%\LightPlayer\runtime
  const local = process.env.LOCALAPPDATA || (process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support') : os.tmpdir());
  return path.join(local, 'LightPlayer');
}

// 模型目录解析（优先级）：
// 1) 环境变量 LIGHTPLAYER_MODELS_DIR
// 2) 打包后随包内置 resources/models（未来离线分发用）
// 3) 开发模式项目内 models-dev（避免开发期重复下载 240MB）
// 4) %LOCALAPPDATA%\LightPlayer\models\<版本>（首用时下载到这里）
function resolveModelDir(isPackaged, appPath, resourcesPath) {
  if (process.env.LIGHTPLAYER_MODELS_DIR) return process.env.LIGHTPLAYER_MODELS_DIR;
  if (isPackaged && resourcesPath) {
    const bundled = path.join(resourcesPath, 'models', MODEL_VERSION);
    if (fs.existsSync(path.join(bundled, 'model.int8.onnx'))) return bundled;
  }
  if (!isPackaged && appPath) {
    const devDir = path.join(appPath, 'models-dev');
    if (fs.existsSync(path.join(devDir, 'model.int8.onnx'))) return devDir;
  }
  return path.join(runtimeRoot(), 'models', MODEL_VERSION);
}

function modelsReady(modelDir) {
  return MODEL_FILES.every(f => {
    try { return fs.statSync(path.join(modelDir, f.name)).size === f.size; } catch (_) { return false; }
  });
}

// ---------------------------------------------------------------------------
// 纯 URL 直链下载器：自动跟随重定向、浏览器 UA、Range 断点续传、socket 级超时
// ---------------------------------------------------------------------------

function requestUrl(url, { headers = {}, redirects = 0, signal } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (redirects > 8) return rejectPromise(new Error('重定向次数过多'));
    let lib;
    try { lib = url.startsWith('https:') ? https : http; }
    catch (_) { return rejectPromise(new Error('非法 URL')); }
    // ModelScope 等站点的 WAF 会拦截没有浏览器 UA 的请求（返回 403），统一携带
    const finalHeaders = Object.assign({
      'User-Agent': UA,
      Accept: '*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    }, headers);
    const req = lib.get(url, { headers: finalHeaders, timeout: 30000 }, res => {
      const { statusCode, headers: h } = res;
      if (statusCode >= 300 && statusCode < 400 && h.location) {
        res.resume();
        const next = new URL(h.location, url).toString();
        return resolvePromise(requestUrl(next, { headers, redirects: redirects + 1, signal }));
      }
      // 403/404 等立即失败，交由外层切换下一个源（错误体读出来便于诊断）
      if (statusCode !== 200 && statusCode !== 206) {
        let tail = '';
        res.on('data', c => { if (tail.length < 200) tail += c; });
        res.on('end', () => rejectPromise(new Error(`HTTP ${statusCode}${tail ? ' ' + String(tail).slice(0, 120) : ''}`)));
        return;
      }
      resolvePromise(res);
    });
    req.on('timeout', () => req.destroy(new Error('连接/读取超时（30 秒无响应）')));
    req.on('error', rejectPromise);
    if (signal) signal.addEventListener('abort', () => req.destroy(new Error('已取消')), { once: true });
  });
}

async function downloadOne(url, dest, expectedSize, onProgress, signal) {
  const part = dest + '.part';
  let existing = 0;
  try { existing = fs.statSync(part).size; } catch (_) {}
  if (existing > expectedSize) { fs.rmSync(part, { force: true }); existing = 0; }
  // 注意：不能用 'wb'/'ab'——Electron 的 fs（asar 补丁）flags 白名单不含 'b'，
  // 会抛 "The argument 'flags' is invalid"；Windows 下文本/二进制无差异，'w'/'a' 即可
  let mode = 'w';
  let response;
  if (existing > 0) {
    // 断点续传：206 追加；服务器不支持 Range（200）则丢弃 .part 重新下载
    response = await requestUrl(url, { headers: { Range: `bytes=${existing}-` }, signal });
    if (response.statusCode === 206) {
      mode = 'a';
    } else {
      response.resume();
      existing = 0;
      response = await requestUrl(url, { signal });
    }
  } else {
    response = await requestUrl(url, { signal });
  }
  // 总大小：优先 Content-Range，其次 Content-Length + 已存在
  let total = expectedSize;
  const cr = response.headers['content-range'];
  if (cr) {
    const m = /\/(\d+)\s*$/.exec(cr);
    if (m) total = parseInt(m[1], 10);
  } else if (response.headers['content-length']) {
    total = existing + parseInt(response.headers['content-length'], 10);
  }
  await new Promise((resolvePromise, rejectPromise) => {
    const out = fs.createWriteStream(part, { flags: mode });
    let done = existing;
    let lastReport = Date.now();
    const window = [];
    response.pipe(out);
    response.on('data', chunk => {
      done += chunk.length;
      const now = Date.now();
      window.push({ t: now, b: chunk.length });
      while (window.length && now - window[0].t > 5000) window.shift();
      if (now - lastReport >= 500) {
        lastReport = now;
        const span = Math.max(1, now - window[0].t) / 1000;
        const speed = window.reduce((a, x) => a + x.b, 0) / span;
        onProgress && onProgress({ done, total, speed });
      }
    });
    out.on('error', rejectPromise);
    out.on('finish', resolvePromise);
    response.on('error', rejectPromise);
    if (signal) signal.addEventListener('abort', () => {
      try { response.destroy(); out.destroy(); } catch (_) {}
      rejectPromise(new Error('已取消'));
    }, { once: true });
  });
  const actual = fs.statSync(part).size;
  if (actual !== expectedSize) throw new Error(`文件大小不一致（${actual}/${expectedSize}）`);
  fs.renameSync(part, dest);
}

async function downloadFile(file, modelDir, onProgress, onMessage, signal) {
  const dest = path.join(modelDir, file.name);
  const errors = [];
  for (let i = 0; i < file.urls.length; i++) {
    if (signal && signal.aborted) throw new Error('已取消');
    const host = new URL(file.urls[i]).host;
    if (i > 0) onMessage && onMessage(`正在切换下载源（${i + 1}/${file.urls.length}）：${host}`);
    try {
      await downloadOne(file.urls[i], dest, file.size, onProgress, signal);
      return;
    } catch (err) {
      if (String(err.message).includes('已取消')) throw err;
      errors.push(`${host}: ${err.message}`);
    }
  }
  throw new Error(`「${file.name}」所有下载源均失败：${errors.join(' | ')}`);
}

// 确保模型就绪；onEvent({percent, message}) 上报整体下载进度（0-100）。已就绪零开销返回。
async function ensureModels(modelDir, onEvent, signal) {
  if (modelsReady(modelDir)) {
    return {
      model: path.join(modelDir, 'model.int8.onnx'),
      tokens: path.join(modelDir, 'tokens.txt'),
      vad: path.join(modelDir, 'silero_vad.onnx'),
    };
  }
  fs.mkdirSync(modelDir, { recursive: true });
  const totalBytes = MODEL_FILES.reduce((a, f) => a + f.size, 0);
  const doneBytes = new Map(MODEL_FILES.map(f => [f.name, 0]));
  for (const f of MODEL_FILES) {
    const fullPath = path.join(modelDir, f.name);
    try {
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).size === f.size) {
        doneBytes.set(f.name, f.size);
        continue;
      }
    } catch (_) {}
    onEvent({ percent: Math.round(pctSoFar(doneBytes, totalBytes)), message: `正在下载识别模型组件：${f.name}` });
    await downloadFile(f, modelDir,
      ({ done, total, speed }) => {
        doneBytes.set(f.name, done);
        onEvent({
          percent: Math.round(pctSoFar(doneBytes, totalBytes)),
          message: `正在下载识别模型（${formatBytes(sumMap(doneBytes))} / ${formatBytes(totalBytes)}，${formatBytes(speed)}/s）`,
        });
      },
      message => onEvent({ percent: Math.round(pctSoFar(doneBytes, totalBytes)), message }),
      signal);
    doneBytes.set(f.name, f.size);
  }
  onEvent({ percent: 100, message: '识别模型准备完成' });
  return {
    model: path.join(modelDir, 'model.int8.onnx'),
    tokens: path.join(modelDir, 'tokens.txt'),
    vad: path.join(modelDir, 'silero_vad.onnx'),
  };
}

function sumMap(m) { let s = 0; for (const v of m.values()) s += v; return s; }
function pctSoFar(m, total) { return total ? Math.min(99, sumMap(m) * 100 / total) : 0; }

function formatBytes(n) {
  n = Number(n) || 0;
  for (const u of ['B', 'KB', 'MB', 'GB']) {
    if (n < 1024 || u === 'GB') return `${n.toFixed(1)} ${u}`;
    n /= 1024;
  }
  return `${n.toFixed(1)} GB`;
}

// ---------------------------------------------------------------------------
// FFmpeg / ffprobe：优先 PATH；找不到则从公开直链下载静态构建
// ---------------------------------------------------------------------------

function which(bin) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const d of dirs) {
    for (const e of exts) {
      const p = path.join(d, bin + e);
      try { if (fs.statSync(p).isFile()) return p; } catch (_) {}
    }
  }
  return null;
}

// 下载源（直链 zip，多源故障转移）。gyan 为静态构建约 109MB；
// BtbN gpl 为静态构建约 191MB，经 GitHub 代理国内可达。
function ffmpegSources() {
  const btbn = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip';
  return [
    { name: 'gyan.dev 官方构建', url: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' },
    { name: 'ghfast 代理 BtbN 构建', url: GH_PROXIES[0] + btbn },
    { name: 'ghproxy 代理 BtbN 构建', url: GH_PROXIES[1] + btbn },
    { name: 'gh-proxy 代理 BtbN 构建', url: GH_PROXIES[2] + btbn },
    { name: 'GitHub BtbN 官方构建', url: btbn },
  ];
}

async function downloadToFile(url, dest, { signal, onProgress } = {}) {
  const response = await requestUrl(url, { signal });
  const total = parseInt(response.headers['content-length'] || '0', 10);
  await new Promise((resolvePromise, rejectPromise) => {
    const out = fs.createWriteStream(dest);
    let done = 0;
    let lastReport = Date.now();
    const window = [];
    response.pipe(out);
    response.on('data', chunk => {
      done += chunk.length;
      const now = Date.now();
      window.push({ t: now, b: chunk.length });
      while (window.length && now - window[0].t > 5000) window.shift();
      if (onProgress && now - lastReport >= 500) {
        lastReport = now;
        const span = Math.max(1, now - window[0].t) / 1000;
        onProgress({ done, total, speed: window.reduce((a, x) => a + x.b, 0) / span });
      }
    });
    out.on('error', rejectPromise);
    out.on('finish', resolvePromise);
    response.on('error', rejectPromise);
    if (signal) signal.addEventListener('abort', () => {
      try { response.destroy(); out.destroy(); } catch (_) {}
      rejectPromise(new Error('已取消'));
    }, { once: true });
  });
  return fs.statSync(dest).size;
}

async function ensureFfmpeg(onEvent) {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const probeExe = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
  const found = which('ffmpeg');
  if (found) {
    let foundProbe = which('ffprobe');
    const sibling = path.join(path.dirname(found), probeExe);
    if (!foundProbe && fs.existsSync(sibling)) foundProbe = sibling;
    return { ffmpeg: found, ffprobe: foundProbe || found.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1') };
  }
  if (process.platform !== 'win32') {
    // macOS/Linux 交给系统包管理，用户环境通常有 ffmpeg 或可自行安装
    return { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' };
  }
  const binDir = path.join(runtimeRoot(), 'runtime', 'ffmpeg', 'bin');
  const ffmpegExe = path.join(binDir, 'ffmpeg.exe');
  const ffprobeExePath = path.join(binDir, 'ffprobe.exe');
  if (fs.existsSync(ffmpegExe)) {
    return { ffmpeg: ffmpegExe, ffprobe: fs.existsSync(ffprobeExePath) ? ffprobeExePath : ffmpegExe };
  }

  fs.mkdirSync(binDir, { recursive: true });
  const root = path.dirname(binDir);
  const extractRoot = path.join(root, 'extract');
  fs.rmSync(extractRoot, { recursive: true, force: true });
  fs.mkdirSync(extractRoot, { recursive: true });

  const errors = [];
  let lastArchive = '';
  for (let i = 0; i < ffmpegSources().length; i++) {
    const src = ffmpegSources()[i];
    const archive = path.join(root, `ffmpeg-${i}.zip`);
    fs.rmSync(archive, { force: true });
    try {
      onEvent({ percent: 5, message: i === 0 ? `正在从${src.name}下载 FFmpeg` : `切换下载源：${src.name}` });
      const size = await downloadToFile(src.url, archive, {
        onProgress: ({ done, total, speed }) => {
          if (total) {
            onEvent({ percent: 5 + Math.round(done * 9 / total),
              message: `正在下载 FFmpeg（${formatBytes(done)} / ${formatBytes(total)}，${formatBytes(speed)}/s）· ${src.name}` });
          }
        },
      });
      if (size < 5 * 1024 * 1024) throw new Error('下载文件过小，可能是错误页');
      lastArchive = archive;
      break;
    } catch (err) {
      errors.push(`${src.name}: ${err.message}`);
      fs.rmSync(archive, { force: true });
    }
  }
  if (!lastArchive) {
    throw new Error(`FFmpeg 所有下载源均失败：${errors.join(' | ')}`);
  }

  // Windows 10+ 自带 bsdtar，直接解 zip（zip 自带 CRC，损坏会解包失败）
  onEvent({ percent: 14, message: '正在解压 FFmpeg' });
  await new Promise((resolvePromise, rejectPromise) => {
    const tar = spawn('tar', ['-xf', lastArchive, '-C', extractRoot], { windowsHide: true });
    let err = '';
    tar.stderr.on('data', d => { err += d; });
    tar.on('close', code => code === 0 ? resolvePromise() : rejectPromise(new Error('FFmpeg 解压失败（压缩包可能损坏）：' + err.slice(-160))));
    tar.on('error', rejectPromise);
  });
  // 两个源的压缩包都在解压目录的某层 bin/ 下，统一递归查找
  const targets = [];
  const walk = d => {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else if (/^(ffmpeg|ffprobe)\.exe$/i.test(name)) targets.push(p);
    }
  };
  walk(extractRoot);
  const srcFf = targets.find(p => /ffmpeg\.exe$/i.test(p));
  if (!srcFf) throw new Error('下载的 FFmpeg 压缩包中没有 ffmpeg.exe');
  fs.copyFileSync(srcFf, ffmpegExe);
  const srcProbe = targets.find(p => /ffprobe\.exe$/i.test(p));
  if (srcProbe) fs.copyFileSync(srcProbe, ffprobeExePath);
  fs.rmSync(lastArchive, { force: true });
  fs.rmSync(extractRoot, { recursive: true, force: true });
  onEvent({ percent: 15, message: 'FFmpeg 准备完成' });
  return { ffmpeg: ffmpegExe, ffprobe: fs.existsSync(ffprobeExePath) ? ffprobeExePath : ffmpegExe };
}

module.exports = {
  MODEL_VERSION,
  MODEL_FILES,
  resolveModelDir,
  modelsReady,
  ensureModels,
  ensureFfmpeg,
  formatBytes,
};
