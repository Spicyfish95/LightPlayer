const { app, BrowserWindow, dialog, ipcMain, utilityProcess } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { resolveModelDir } = require('./asr/models');
let asrProcess = null;   // 常驻 ASR worker（sherpa-onnx，模型只加载一次，会话经消息控制）
let asrNextSid = 1;      // 会话自增 id（渲染端据此过滤旧会话残留事件）
const asrSidWaiters = new Map();   // sid → resolve()，等待某会话停止/结束
let asrActiveSid = 0;    // 当前运行中的会话 sid（0 表示空闲）

// 本地播放器场景：允许无用户手势自动播放（重启后自动续播上次视频依赖此能力）
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// 硬件加速开关：由渲染进程通过 marker 文件持久化，主进程启动时读取
// （Electron 的 GPU 开关必须在 app ready 之前设置，localStorage 主进程无法访问）
function readHwAccel() {
  try {
    const marker = path.join(app.getPath('userData'), 'hw-accel.json');
    if (fs.existsSync(marker)) return JSON.parse(fs.readFileSync(marker, 'utf8')).enabled !== false;
  } catch (_) {}
  return true;   // 默认开启
}
if (!readHwAccel()) app.disableHardwareAcceleration();

function resolveAsrWorker() {
  // 开发模式：源码路径；打包模式：worker 与 sherpa-onnx 原生模块经 asarUnpack 解包到 app.asar.unpacked
  if (!app.isPackaged) return path.join(__dirname, 'asr', 'asr_worker.js');
  return path.join(process.resourcesPath, 'app.asar.unpacked', 'src', 'asr', 'asr_worker.js');
}

// 结束子进程的整棵进程树（Windows 下 utilityProcess.kill() 不保证带走 ffmpeg 孙进程）
function killProcessTree(proc) {
  if (!proc || proc.pid == null) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { windowsHide: true });
    } else {
      try { proc.kill(); } catch (_) {}
    }
  } catch (_) {
    try { proc.kill(); } catch (_) {}
  }
}

function createWindow() {
  const win = new BrowserWindow({ width: 1440, height: 900, minWidth: 1080, minHeight: 680, backgroundColor: '#080b12', frame: false, icon: path.join(__dirname, '..', 'build', 'icon.ico'), webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  win.loadFile(path.join(__dirname, 'index.html'));
}
app.whenReady().then(() => {
  // 硬件加速设置持久化（marker 文件 + localStorage 双写，保证主进程下次启动能读到）
  ipcMain.handle('settings:hw-accel', (event, enabled) => {
    try {
      const marker = path.join(app.getPath('userData'), 'hw-accel.json');
      if (typeof enabled === 'boolean') fs.writeFileSync(marker, JSON.stringify({ enabled }));
      else if (fs.existsSync(marker)) return JSON.parse(fs.readFileSync(marker, 'utf8')).enabled !== false;
      return true;
    } catch (_) { return true; }
  });
  // 会话状态同步落盘（localStorage 异步提交在快速关闭时可能丢失）
  const sessionFile = () => path.join(app.getPath('userData'), 'session.json');
  ipcMain.handle('session:save', (event, payload) => {
    try { fs.writeFileSync(sessionFile(), JSON.stringify(payload)); return true; } catch (_) { return false; }
  });
  ipcMain.handle('session:load', () => {
    try { return JSON.parse(fs.readFileSync(sessionFile(), 'utf8')); } catch (_) { return null; }
  });
  ipcMain.handle('dialog:open-video', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'], filters: [{ name: '视频文件', extensions: ['mp4','mkv','webm','mov','avi','m4v','mp3','wav','flac'] }] });
    return result.canceled ? [] : result.filePaths;
  });
  ipcMain.handle('dialog:open-video-folder', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return [];
    const extensions = new Set(['.mp4','.mkv','.webm','.mov','.avi','.m4v','.mp3','.wav','.flac']);
    const files = [];
    const walk = dir => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (extensions.has(path.extname(entry.name).toLowerCase())) files.push(full);
      }
    };
    walk(result.filePaths[0]);
    return files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  });
  ipcMain.handle('dialog:open-subtitle', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: '字幕文件', extensions: ['srt','vtt','ass','ssa','txt'] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    return { path: result.filePaths[0], content: fs.readFileSync(result.filePaths[0], 'utf8') };
  });
  const captionCachePath = video => video + '.lightplayer-subs.json';
  ipcMain.handle('captions:read-cache', (event, video) => {
    if (!video || typeof video !== 'string') return null;
    try {
      const p = captionCachePath(video);
      if (fs.existsSync(p)) {
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (Array.isArray(data)) return data;                       // v1：字幕数组
        if (data && Array.isArray(data.captions)) return data.captions; // v2：{version, captions, covered}
      }
    } catch (_) {}
    return null;
  });
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  ipcMain.handle('captions:clear-cache', async (event, video) => {
    if (!video || typeof video !== 'string') return { ok: false, deleted: false };
    // 常驻 daemon 仍在运行：先优雅停止当前识别会话（等其落盘），避免缓存被重写；进程本身保留
    await asrStopSession();
    const targets = [captionCachePath(video), captionCachePath(video) + '.tmp'];
    // 进程退出与杀软释放句柄有短暂延迟，最多重试约 3 秒
    for (let attempt = 0; attempt < 10; attempt++) {
      if (!targets.some(fs.existsSync)) return { ok: true, deleted: true };
      for (const p of targets) {
        try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {}
      }
      if (!targets.some(fs.existsSync)) return { ok: true, deleted: true };
      await sleep(attempt === 0 ? 300 : 250);
    }
    return { ok: false, deleted: false, message: '文件被占用或无写入权限' };
  });
  ipcMain.handle('captions:clear-all-caches', async (event, videos) => {
    // 清除所有视频字幕缓存：先优雅停止识别会话，再扫描播放列表涉及的每个目录，
    // 删除其中全部 *.lightplayer-subs.json(.tmp)（含列表外、已删视频残留的缓存）
    await asrStopSession();
    const dirs = new Set();
    for (const v of Array.isArray(videos) ? videos : []) {
      if (v && typeof v === 'string') dirs.add(path.dirname(v));
    }
    let deleted = 0;
    for (const dir of dirs) {
      let entries = [];
      try { entries = fs.readdirSync(dir); } catch (_) { continue; }
      for (const name of entries) {
        if (!name.endsWith('.lightplayer-subs.json') && !name.endsWith('.lightplayer-subs.json.tmp')) continue;
        const p = path.join(dir, name);
        for (let attempt = 0; attempt < 4; attempt++) {
          try { if (fs.existsSync(p)) { fs.unlinkSync(p); deleted++; } break; }
          catch (_) { await sleep(attempt === 0 ? 200 : 250); }
        }
      }
    }
    return { ok: true, deleted };
  });
  ipcMain.handle('captions:export-srt', async (event, payload) => {
    if (!payload || typeof payload.srt !== 'string' || !payload.srt.trim()) return { ok: false, message: '没有字幕内容' };
    const fallbackName = 'subtitles.srt';
    let defaultPath = fallbackName;
    if (payload.video && typeof payload.video === 'string') {
      const base = payload.video.replace(/\.[^.]+$/, '') + '.srt';
      defaultPath = path.join(path.dirname(payload.video), base.split(/[\\/]/).pop());
    }
    const result = await dialog.showSaveDialog({ defaultPath, filters: [{ name: 'SRT 字幕', extensions: ['srt'] }] });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    try {
      fs.writeFileSync(result.filePath, '\ufeff' + payload.srt, 'utf8');   // BOM 兼容 Windows 记事本
      return { ok: true, path: result.filePath };
    } catch (e) { return { ok: false, message: e.message }; }
  });
  // 向常驻 worker 发一条消息
  function asrSend(obj) {
    try {
      if (asrProcess && !asrProcess.killed) { asrProcess.postMessage(obj); return true; }
    } catch (_) {}
    return false;
  }
  // 等待某会话结束（stopped/done/error 或进程退出）；超时也放行，避免删除缓存被无限阻塞
  function waitSidSettled(sid, timeoutMs = 9000) {
    return new Promise(resolve => {
      if (!asrProcess || asrActiveSid !== sid) return resolve();
      const done = () => { asrSidWaiters.delete(sid); resolve(); };
      asrSidWaiters.set(sid, done);
      setTimeout(done, timeoutMs);
    });
  }
  // 停止当前会话（不杀常驻 worker），等其落盘并真正停下来，供清除缓存前调用
  async function asrStopSession() {
    if (!asrProcess || !asrActiveSid) return;
    const sid = asrActiveSid;
    asrSend({ cmd: 'stop', sid });
    await waitSidSettled(sid);
  }
  // 懒启动常驻 worker；模型在首次 start 时于 worker 内加载，事件全程带 sid 透传
  function ensureAsrDaemon(sender) {
    if (asrProcess) return true;
    const worker = resolveAsrWorker();
    if (!fs.existsSync(worker)) { sender.send('asr:event', { kind: 'error', message: '找不到识别引擎文件：' + worker }); return false; }
    let proc;
    try {
      proc = utilityProcess.fork(worker, [], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      sender.send('asr:event', { kind: 'error', message: `无法启动本地识别引擎：${err.message}` });
      return false;
    }
    asrProcess = proc;
    let stderrTail = '';
    proc.on('message', d => {
      if (!d || typeof d !== 'object') return;
      if ((d.kind === 'stopped' || d.kind === 'done') && d.sid) {
        if (asrActiveSid === d.sid) asrActiveSid = 0;
        const w = asrSidWaiters.get(d.sid); if (w) w();
      }
      if (d.kind === 'error' && d.sid && asrActiveSid === d.sid) {
        asrActiveSid = 0;
        const w = asrSidWaiters.get(d.sid); if (w) w();
      }
      if (!sender.isDestroyed()) sender.send('asr:event', d);
    });
    if (proc.stderr) {
      proc.stderr.on('data', chunk => { stderrTail = (stderrTail + chunk.toString()).slice(-800); });
    }
    proc.on('exit', code => {
      const exitedSid = asrActiveSid;
      asrProcess = null; asrActiveSid = 0;
      for (const w of asrSidWaiters.values()) w();
      asrSidWaiters.clear();
      if (!sender.isDestroyed() && exitedSid) {
        const detail = stderrTail.split(/\r?\n/).map(s => s.trim()).filter(Boolean).slice(-3).join(' | ');
        sender.send('asr:event', { kind: 'exit', code, sid: exitedSid, detail: detail.slice(0, 260) });
      }
    });
    return true;
  }
  // 应用退出：优雅关闭 worker，超时兜底进程树终止
  function shutdownAsrDaemon() {
    if (!asrProcess) return;
    const p = asrProcess;
    asrProcess = null; asrActiveSid = 0;
    try { p.postMessage({ cmd: 'shutdown' }); } catch (_) {}
    setTimeout(() => killProcessTree(p), 700);
  }

  ipcMain.handle('asr:start', async (event, options) => {
    const sender = event.sender;
    if (!ensureAsrDaemon(sender)) return { ok: false, sid: 0 };
    const sid = asrNextSid++;
    asrActiveSid = sid;
    const ok = asrSend({
      cmd: 'start', sid,
      video: options.video,
      modelDir: resolveModelDir(app.isPackaged, app.getAppPath(), process.resourcesPath),
      duration: Number(options.duration) || 0,
      start: Number(options.start) || 0,
      chunk: Number(options.chunk) || 4
    });
    return { ok, sid };
  });
  // 关闭字幕：仅通知会话停止，常驻 worker 与模型保留，下次开启零冷启动
  ipcMain.on('asr:stop', () => { asrStopSession(); });
  ipcMain.on('asr:seek', (event, payload) => {
    if (!asrProcess) return;
    asrSend({ cmd: payload && payload.seek ? 'seek' : 'pos', sid: asrActiveSid || undefined,
              start: Number(payload && payload.start) || 0, rate: Number(payload && payload.rate) || 1 });
  });
  ipcMain.on('window:minimize', e => BrowserWindow.fromWebContents(e.sender)?.minimize());
  ipcMain.on('window:maximize', e => { const w = BrowserWindow.fromWebContents(e.sender); w.isMaximized() ? w.unmaximize() : w.maximize(); });
  ipcMain.on('window:close', e => {
    shutdownAsrDaemon();
    BrowserWindow.fromWebContents(e.sender)?.close();
  });
  // 应用整体退出时兜底关闭常驻 worker（utilityProcess 子进程也会随父进程退出）
  app.on('before-quit', shutdownAsrDaemon);
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// 开发模式热更新：监听 src 目录变更并自动刷新渲染进程，保存代码后即可预览结果。
// 生效范围：app.js / index.html / styles.css / preload.js（保存后窗口自动重载）；
// main.js 属于主进程，改动需重启应用。
if (!app.isPackaged) {
  let devReloadTimer = null;
  try {
    fs.watch(path.join(__dirname), { recursive: true }, (eventType, filename) => {
      if (!filename || !/\.(js|html|css)$/i.test(filename)) return;
      clearTimeout(devReloadTimer);
      devReloadTimer = setTimeout(() => {
        for (const w of BrowserWindow.getAllWindows()) {
          if (!w.isDestroyed()) w.webContents.reloadIgnoringCache();
        }
      }, 150);
    });
  } catch (_) {}
}
