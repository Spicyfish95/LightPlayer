'use strict';
// 常驻 ASR worker（Electron utilityProcess）：
// sherpa-onnx（SenseVoice INT8 + Silero VAD，纯 CPU、ONNX Runtime 内置）
// 替代旧版 Python + PyTorch + Qwen3-ASR 方案。
// 协议与旧版保持一致：主进程 postMessage 下发 start/stop/seek/pos/shutdown，
// worker 回发 status/caption/captions/error/stopped/done（均带 sid）。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
// 注意：utilityProcess 中 require('electron') 仅暴露 net/systemPreferences，没有 app，
// 模型目录等环境信息由主进程在 start 消息中传入。
const sherpa = require('sherpa-onnx-node');
const { ensureModels, ensureFfmpeg } = require('./models');

// Electron >=21 禁用 N-API external buffer，读 wav / 取 VAD 段必须传 false
const NO_EXTERNAL = false;

function emit(obj) {
  try { process.parentPort.postMessage(obj); } catch (_) {}
}

// ---------------------------------------------------------------------------
// 已转写区间（含静音段）合并/查询 —— 与旧 Python 实现语义一致
// ---------------------------------------------------------------------------
function markCompleted(intervals, start, end) {
  intervals.push([start, end]);
  intervals.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [a, b] of intervals) {
    if (merged.length && a <= merged[merged.length - 1][1] + 0.01) {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], b);
    } else merged.push([a, b]);
  }
  intervals.length = 0;
  intervals.push(...merged);
}
function nextUncovered(intervals, pos) {
  for (const [a, b] of intervals) {
    if (pos < a - 0.01) return pos;
    if (pos <= b + 0.01) pos = b;
  }
  return pos;
}
function coverageSeconds(intervals) {
  return intervals.reduce((s, [a, b]) => s + (b - a), 0);
}
function coveredLimit(intervals, pos) {
  let best = null;
  for (const [a] of intervals) {
    if (a > pos + 0.01 && (best === null || a < best)) best = a;
  }
  return best;
}

// ---------------------------------------------------------------------------
// ffmpeg / ffprobe
// ---------------------------------------------------------------------------
function runProcess(cmd, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let stderr = '';
    p.stderr.on('data', d => { stderr += d.toString(); });
    p.on('error', rejectPromise);
    p.on('close', code => code === 0 ? resolvePromise() : rejectPromise(new Error(`${path.basename(cmd)} 退出 ${code}: ${stderr.slice(-300)}`)));
  });
}

function extract(ffmpeg, source, target, start, seconds) {
  return runProcess(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
    '-ss', String(start), '-t', String(seconds), '-i', source,
    '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', target]);
}

function probeDuration(ffprobe, file) {
  return new Promise((resolvePromise, rejectPromise) => {
    const p = spawn(ffprobe, ['-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', file], { windowsHide: true });
    let out = '';
    p.stdout.on('data', d => { out += d.toString(); });
    p.on('error', rejectPromise);
    p.on('close', code => {
      const v = parseFloat(out.trim());
      code === 0 && isFinite(v) && v > 0 ? resolvePromise(v) : rejectPromise(new Error('无法读取媒体时长'));
    });
  });
}

// ---------------------------------------------------------------------------
// 引擎：SenseVoice 识别器 + Silero VAD（daemon 生命周期内只构造一次）
// ---------------------------------------------------------------------------
let recognizer = null;
let vad = null;
let ffmpegReady = null;
// 当前识别语言（SenseVoice 支持的取值：'' = 自动 / zh / en / yue / ja / ko）。
// recognizer 的 language 在构造时固定，切换语言需要重建 recognizer（模型文件不变，重建很快）。
let asrLanguage = '';
// SenseVoice 支持的语言集合（auto 由空字符串表示）
const ASR_LANGUAGES = new Set(['', 'zh', 'en', 'yue', 'ja', 'ko']);
function normalizeAsrLanguage(lang) {
  const v = String(lang || '').trim().toLowerCase();
  return ASR_LANGUAGES.has(v) ? v : '';
}

async function ensureEngine(control, modelDir, language) {
  const send = (percent, message) => control.alive && emit({ kind: 'status', sid: control.sid, stage: 'model', percent, message });

  if (!ffmpegReady) {
    send(3, '正在检查 FFmpeg');
    ffmpegReady = ensureFfmpeg(({ percent, message }) => send(Math.min(4, percent), message));
  }
  const ff = await ffmpegReady;

  send(5, '正在准备本地识别模型（SenseVoice，中/英/粤/日/韩）');
  const signal = control.abort.signal;
  const paths = await ensureModels(modelDir, ({ percent, message }) => {
    // 下载进度映射到 5%~14%
    send(5 + Math.round(percent * 9 / 100), message);
  }, signal);
  if (control.shouldStop()) throw new Error('stopped');

  send(15, '正在加载识别模型');
  asrLanguage = normalizeAsrLanguage(language);
  recognizer = new sherpa.OfflineRecognizer({
    modelConfig: {
      senseVoice: { model: paths.model, language: asrLanguage, useInverseTextNormalization: 1 },
      tokens: paths.tokens,
      numThreads: Math.max(1, Math.min(8, os.cpus().length || 1)),
      provider: 'cpu',
      debug: 0,
    },
    decodingMethod: 'greedy_search',
  });
  vad = new sherpa.Vad({
    sileroVad: {
      model: paths.vad,
      threshold: 0.5,
      minSilenceDuration: 0.3,
      minSpeechDuration: 0.2,
      windowSize: 512,
      maxSpeechDuration: 20.0,
    },
    sampleRate: 16000,
    numThreads: 1,
    provider: 'cpu',
    debug: 0,
  }, 120);
  // 预热：触发 onnxruntime 图优化/内存池初始化，避免首条字幕承担冷启动
  const warm = recognizer.createStream();
  const warmSamples = new Float32Array(16000 * 0.5);
  warm.acceptWaveform({ samples: warmSamples, sampleRate: 16000 });
  recognizer.decode(warm);
  send(17, `识别模型已加载（CPU 本地识别 · ${asrLanguage ? asrLanguage.toUpperCase() : '自动语言'}）`);
  return ff;
}

// 对一整段 16k 采样运行 VAD，返回语音区间（秒）+ 采样，调用前可先 reset。
function vadSegments(samples, doReset) {
  if (doReset) vad.reset();
  for (let i = 0; i < samples.length; i += 512) {
    vad.acceptWaveform(samples.subarray(i, Math.min(i + 512, samples.length)));
  }
  vad.flush();
  const segs = [];
  while (!vad.isEmpty()) {
    const s = vad.front(NO_EXTERNAL);
    segs.push({ start: s.start / 16000, end: (s.start + s.samples.length) / 16000, samples: s.samples });
    vad.pop();
  }
  return segs;
}

// 识别一个 wav 切片：VAD 去静音后逐语音段识别并拼接；无语音返回 null。
function recognizeWav(wavPath) {
  const wave = sherpa.readWave(wavPath, NO_EXTERNAL);
  const segs = vadSegments(wave.samples, true);
  if (!segs.length) return null;
  const texts = [];
  for (const seg of segs) {
    const stream = recognizer.createStream();
    stream.acceptWaveform({ samples: seg.samples, sampleRate: 16000 });
    recognizer.decode(stream);
    const text = (recognizer.getResult(stream).text || '').trim();
    if (text) texts.push(text);
  }
  return texts.join('').trim() || null;
}

// 在探测窗口内寻找最接近 target 的静音中点（VAD 版旧 snap_to_silence）。
function snapToSilence(wavPath, targetS, minS, maxS) {
  let wave;
  try { wave = sherpa.readWave(wavPath, NO_EXTERNAL); } catch (_) { return null; }
  if (!wave.samples.length) return null;
  const probeDur = wave.samples.length / wave.sampleRate;
  const segs = vadSegments(wave.samples, true);
  // 由语音区间反解静音区间
  const silences = [];
  let cursor = 0;
  for (const s of segs) {
    if (s.start - cursor >= 0.12) silences.push([cursor, s.start]);
    cursor = Math.max(cursor, s.end);
  }
  if (probeDur - cursor >= 0.12) silences.push([cursor, probeDur]);
  let best = null;
  for (const [a, b] of silences) {
    const center = (a + b) / 2;
    if (center < minS || center > maxS) continue;
    if (best === null || Math.abs(center - targetS) < Math.abs(best - targetS)) best = center;
  }
  return best;
}

// ---------------------------------------------------------------------------
// 会话控制
// ---------------------------------------------------------------------------
class SessionControl {
  constructor(sid) {
    this.sid = sid;
    this.alive = true;        // 被新会话取代/进程退出时置 false（事件随之静默）
    this.stopping = false;   // 用户关闭字幕：停止本轮但仍需回发 stopped
    this.abort = new AbortController();
    this.pendingSeek = null;
    this.playhead = [0, 1, Date.now()]; // [位置秒, 倍速, 接收时间(ms)]
  }
  shouldStop() { return this.stopping || !this.alive; }
  requestStop() { this.stopping = true; try { this.abort.abort(); } catch (_) {} }
  kill() { this.alive = false; this.stopping = true; try { this.abort.abort(); } catch (_) {} }
  emit(kind, data) {
    if (!this.alive) return;
    emit(Object.assign({ kind, sid: this.sid }, data));
  }
}

let curControl = null;

// ---------------------------------------------------------------------------
// 单个视频的转写循环（移植旧 Python 追赶式调度 + v2 字幕缓存）
// ---------------------------------------------------------------------------
async function transcribeVideoSession(cfg, ff, control) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lightplayer-asr-'));
  const cachePath = cfg.video + '.lightplayer-subs.json';
  let allCaptions = [];
  let completed = [];
  let cacheLast = 0;
  let cacheDirty = false;

  function saveCache(force) {
    if (!cfg.cache) return;   // 未开启“是否使用缓存”：本次会话不写入任何缓存文件（含 .json 与 .tmp）
    const now = Date.now() / 1000;
    if (!force && now - cacheLast < 10) { cacheDirty = true; return; }
    try {
      cacheLast = now;
      cacheDirty = false;
      allCaptions.sort((a, b) => a.start - b.start);
      const payload = {
        version: 2,
        captions: allCaptions,
        covered: completed.map(([a, b]) => [Math.round(a * 1000) / 1000, Math.round(b * 1000) / 1000]),
      };
      const tmp = cachePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
      fs.renameSync(tmp, cachePath);
    } catch (_) {}
  }

  try {
    const total = cfg.total;
    control.emit('status', { stage: 'audio', percent: 18, message: '模型已加载，开始分析视频音频' });

    // 载入缓存字幕：立即下发并标记已覆盖（仅在开启“是否使用缓存”时读取缓存）
    if (cfg.cache && fs.existsSync(cachePath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        let capItems, coveredItems;
        if (Array.isArray(raw)) { capItems = raw; coveredItems = null; }
        else if (raw && Array.isArray(raw.captions)) { capItems = raw.captions; coveredItems = raw.covered || null; }
        else { capItems = []; coveredItems = null; }
        const cachedItems = [];
        for (const item of capItems) {
          const cs = parseFloat(item.start), ce = parseFloat(item.end), ct = String(item.text || '').trim();
          if (isFinite(cs) && isFinite(ce) && ce > cs && cs >= 0 && cs < total && ct) {
            const end = Math.min(ce, total);
            allCaptions.push({ start: cs, end, text: ct });
            cachedItems.push({ start: cs, end, text: ct });
          }
        }
        if (cachedItems.length) control.emit('captions', { items: cachedItems });
        if (Array.isArray(coveredItems)) {
          for (const pair of coveredItems) {
            const a = parseFloat(pair[0]), b = parseFloat(pair[1]);
            if (isFinite(a) && isFinite(b) && b > a && a < total) markCompleted(completed, a, Math.min(b, total));
          }
        } else {
          for (const c of allCaptions) markCompleted(completed, c.start, c.end);
        }
      } catch (_) { allCaptions = []; completed = []; }
    }
    if (allCaptions.length || completed.length) {
      control.emit('status', {
        stage: 'transcribe',
        message: `已加载缓存字幕 ${allCaptions.length} 条，仅识别未覆盖部分`,
        percent: Math.min(96, 18 + Math.floor(coverageSeconds(completed) / total * 78)),
        device: 'CPU',
      });
      saveCache();
    }

    const chunkTarget = Math.max(2, cfg.chunk || 4);
    const chunkMin = Math.max(1, chunkTarget * 0.55);
    const chunkMax = Math.max(chunkTarget + 1, chunkTarget * 1.6);
    const probeLen = chunkMax + 2;
    const behind = Math.max(3, chunkTarget);
    const ahead = 30;
    const lead = 12;
    let start = Math.max(0, Math.min(cfg.start || 0, Math.max(0, total - 0.1)));
    control.playhead = [start, 1, Date.now()];
    let batchSize = 2;
    const batchMin = 2, batchMax = 6;
    let firstBatch = true;
    let speedEma = null;
    const wavProbe = path.join(tmpDir, 'probe.wav');

    while (!control.shouldStop()) {
      let pending = control.pendingSeek;
      control.pendingSeek = null;
      const [pos, rate, stamp] = control.playhead;
      const elapsed = Math.max(0, (Date.now() - stamp) / 1000);
      const desired = rate > 0 ? Math.min(total, pos + rate * elapsed) : pos;
      if (pending !== null) {
        start = nextUncovered(completed, Math.min(Math.max(0, pending), Math.max(0, total - 0.1)));
        control.emit('status', { stage: 'transcribe', message: `已跟随跳转，从 ${Math.floor(start)}s 附近继续识别`,
          percent: Math.min(96, 18 + Math.floor(coverageSeconds(completed) / total * 78)), device: 'CPU' });
      } else {
        if (start < desired - behind) start = nextUncovered(completed, desired);
        else if (start > desired + ahead) start = nextUncovered(completed, 0);
      }
      if (start >= total - 0.05) {
        const gap = nextUncovered(completed, 0);
        if (gap >= total - 0.05) break;
        start = gap;
      }

      const segments = [];
      let cursor = start;
      const targetBatch = firstBatch ? 1 : batchSize;
      while (segments.length < targetBatch) {
        cursor = nextUncovered(completed, cursor);
        if (cursor >= total - 0.25) break;
        if (segments.length && cursor > desired + lead) break;
        const limit = coveredLimit(completed, cursor);
        if (limit !== null && limit - cursor <= 0.25) {
          markCompleted(completed, cursor, limit);
          continue;
        }
        const remaining = total - cursor;
        const wavPath = path.join(tmpDir, `chunk-${segments.length}.wav`);
        let dur;
        try {
          if (firstBatch) {
            dur = Math.min(chunkTarget, remaining);
            await extract(ff.ffmpeg, cfg.video, wavPath, cursor, dur);
          } else if (remaining <= chunkMax) {
            await extract(ff.ffmpeg, cfg.video, wavPath, cursor, remaining);
            dur = remaining;
          } else {
            // 先取探测窗口，用神经 VAD 在目标时长附近的静音处切分，避免拦腰截断句子
            await extract(ff.ffmpeg, cfg.video, wavProbe, cursor, probeLen);
            const boundary = snapToSilence(wavProbe, chunkTarget, chunkMin, chunkMax);
            dur = boundary !== null ? boundary : chunkTarget;
            // 从探测 wav 直接切出需要的长度，避免二次调用 ffmpeg
            const wave = sherpa.readWave(wavProbe, NO_EXTERNAL);
            const n = Math.floor(dur * wave.sampleRate);
            sherpa.writeWave(wavPath, { samples: wave.samples.subarray(0, n), sampleRate: wave.sampleRate });
          }
        } catch (exc) {
          control.emit('error', { message: `音频片段 ${Math.floor(cursor)}s 提取失败：${exc.message}` });
          return 3;
        }
        if (limit !== null) dur = Math.min(dur, limit - cursor);
        segments.push([cursor, dur, wavPath]);
        cursor += dur;
      }
      if (!segments.length) { markCompleted(completed, start, total); break; }
      if (control.shouldStop()) break;

      const audioSec = segments.reduce((a, [, d]) => a + d, 0);
      if (firstBatch) {
        control.emit('status', { stage: 'transcribe', message: '正在识别当前位置的对白…', percent: 18, device: 'CPU' });
      }
      const t0 = Date.now() / 1000;
      const results = segments.map(([, , p]) => recognizeWav(p));
      const wall = Math.max(1e-6, Date.now() / 1000 - t0);
      const speed = audioSec / wall;
      speedEma = speedEma === null ? speed : speedEma * 0.7 + speed * 0.3;
      firstBatch = false;
      if (speedEma < 0.95 && batchSize < batchMax) batchSize += 1;
      else if (speedEma > 1.8 && batchSize > batchMin) batchSize -= 1;

      if (control.shouldStop()) break;
      control.emit('status', {
        stage: 'transcribe',
        message: `识别音频片段 ${Math.floor(segments[0][0])}s–${Math.floor(segments[segments.length - 1][0] + segments[segments.length - 1][1])}s · 速度 ${speedEma.toFixed(1)}×播放`,
        percent: Math.min(96, 18 + Math.floor(coverageSeconds(completed) / total * 78)),
        device: 'CPU',
      });
      segments.forEach(([segStart, dur], idx) => {
        const text = results[idx] ? results[idx].trim() : '';
        const end = Math.min(total, segStart + dur);
        if (text) {
          control.emit('caption', { start: segStart, end, text });
          allCaptions.push({ start: segStart, end, text });
        }
        markCompleted(completed, segStart, end);
      });
      saveCache();
      start = nextUncovered(completed, cursor);
    }

    saveCache(true);
    if (control.shouldStop()) { control.emit('stopped', {}); return 'stopped'; }
    control.emit('status', { stage: 'display', message: '实时字幕识别完成', percent: 100 });
    control.emit('done', {});
    return 'done';
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// 主循环：parentPort 命令驱动 start/stop/seek/pos/shutdown
// ---------------------------------------------------------------------------
function killCurrent() {
  if (!curControl) return;
  curControl.kill();
  curControl = null;
}

process.parentPort.on('message', async e => {
  // utilityProcess 收到的是 MessageEvent，真正的消息在 e.data
  const msg = (e && e.data && typeof e.data === 'object') ? e.data : {};
  const cmd = msg.cmd;
  if (cmd === 'shutdown') { killCurrent(); process.exit(0); }
  if (cmd === 'stop') {
    if (curControl && (msg.sid == null || msg.sid === curControl.sid)) {
      // 仅停止本会话：保留 alive 以便会话线程回发 stopped 事件（主进程据此解除等待）
      curControl.requestStop();
    }
    return;
  }
  if (cmd === 'seek' || cmd === 'pos') {
    if (curControl && curControl.sid === msg.sid) {
      const p = Math.max(0, parseFloat(msg.start) || 0);
      const r = Math.max(0, parseFloat(msg.rate) || 0);
      curControl.playhead = [p, r, Date.now()];
      if (cmd === 'seek') curControl.pendingSeek = p;
    }
    return;
  }
  if (cmd === 'start') {
    const sid = parseInt(msg.sid, 10) || 0;
    const video = String(msg.video || '');
    if (!video || !fs.existsSync(video)) { emit({ kind: 'error', sid, message: '找不到视频文件' }); return; }
    killCurrent();
    const control = new SessionControl(sid);
    curControl = control;
    try {
      const modelDir = String(msg.modelDir || '');
      if (!modelDir) throw new Error('缺少模型目录参数');
      const ff = await ensureEngine(control, modelDir, msg.language).catch(exc => {
        // FFmpeg 准备失败不缓存 rejected Promise，下次开启可重试
        ffmpegReady = null;
        throw exc;
      });
      if (control.shouldStop()) return;
      let total = parseFloat(msg.duration) || 0;
      if (!(total > 0)) {
        control.emit('status', { stage: 'audio', percent: 18, message: '正在读取视频时长…' });
        total = await probeDuration(ff.ffprobe, video);
      }
      if (!(total > 0)) { control.emit('error', { message: '无法读取视频时长' }); return; }
      await transcribeVideoSession({
        video,
        total,
        start: parseFloat(msg.start) || 0,
        chunk: parseFloat(msg.chunk) || 4,
        cache: msg.cache !== false,   // 是否使用缓存（渲染端经主进程透传，默认开启；false 时不读写任何缓存文件）
      }, ff, control);
    } catch (exc) {
      if (control.shouldStop() || String(exc.message) === 'stopped') {
        control.emit('stopped', {});
      } else {
        control.emit('error', { message: '识别失败：' + exc.message });
      }
    } finally {
      if (curControl === control) curControl = null;
    }
  }
});

// 兜底：任何未捕获异常都回报渲染端，而不是让进程静默消失
process.on('uncaughtException', err => {
  emit({ kind: 'error', sid: curControl ? curControl.sid : 0, message: '识别引擎异常：' + (err && err.message) });
});
process.on('unhandledRejection', err => {
  emit({ kind: 'error', sid: curControl ? curControl.sid : 0, message: '识别引擎任务异常：' + (err && err.message) });
});
