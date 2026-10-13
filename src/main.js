const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
let asrProcess = null;

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
  // 开发模式：直接用源码路径；打包模式：优先 app.asar.unpacked，
  // 缺失时从 asar 内复制到 userData 再执行（Python 无法读取 asar 内的文件）
  const inAsar = path.join(__dirname, 'asr_worker.py');
  if (!app.isPackaged) return inAsar;
  const unpacked = path.join(process.resourcesPath, 'app.asar.unpacked', 'src', 'asr_worker.py');
  if (fs.existsSync(unpacked)) return unpacked;
  try {
    const target = path.join(app.getPath('userData'), 'asr_worker.py');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, fs.readFileSync(inAsar));
    return target;
  } catch (_) { return unpacked; }
}

let _cachedPython = null;
function findPython() {
  if (_cachedPython) return _cachedPython;
  // Windows：优先 py 启动器指定小版本，逐级回退到 PATH 中的 python
  const candidates = process.platform === 'win32'
    ? [['py', ['-3.12']], ['py', ['-3.13']], ['py', ['-3.11']], ['py', ['-3']], ['python', []], ['python3', []]]
    : [['python3', []], ['python', []]];
  for (const [cmd, pre] of candidates) {
    try {
      const probe = spawnSync(cmd, [...pre, '--version'], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
      if (probe.status === 0 && `${probe.stdout || ''}${probe.stderr || ''}`.includes('Python')) { _cachedPython = [cmd, pre]; return _cachedPython; }
    } catch (_) {}
  }
  return null;
}

function createWindow() {
  const win = new BrowserWindow({ width: 1440, height: 900, minWidth: 1080, minHeight: 680, backgroundColor: '#080b12', frame: false, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
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
  ipcMain.handle('dialog:open-model-directory', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0];
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
  ipcMain.handle('captions:clear-cache', (event, video) => {
    if (!video || typeof video !== 'string') return false;
    try { fs.unlinkSync(captionCachePath(video)); } catch (_) {}
    return true;
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
  ipcMain.handle('asr:start', async (event, options) => {
    if (asrProcess) { asrProcess.kill(); asrProcess = null; }   // 置空后旧进程的 close 事件不再下发，避免污染新视频的 ASR 状态
    const sender = event.sender;
    const safeSend = (data) => { if (!sender.isDestroyed()) sender.send('asr:event', data); };
    const worker = resolveAsrWorker();
    if (!fs.existsSync(worker)) {
      safeSend({ kind: 'error', message: '找不到 ASR 工作进程文件：' + worker });
      return false;
    }
    const found = findPython();
    if (!found) {
      safeSend({ kind: 'error', message: '未找到可用的 Python 3。请安装 Python 3.10+（Windows 建议用官方安装器并勾选 py 启动器）。' });
      return false;
    }
    const [python, pythonPre] = found;
    const args = [worker, '--video', options.video, '--model', options.modelPath || '', '--model-kind', options.modelKind || 'qwen', '--duration', String(options.duration || 0), '--start', String(options.start || 0), '--device', ['auto', 'cpu', 'gpu'].includes(options.device) ? options.device : 'auto'];
    const proc = spawn(python, [...pythonPre, ...args], { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
    asrProcess = proc;
    let buffer = '';
    let stderrTail = '';
    proc.stdout.on('data', chunk => {
      if (proc !== asrProcess) return;   // 进程已停止/替换（切换视频）：丢弃残留输出，避免旧视频字幕串入新视频
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/); buffer = lines.pop();
      for (const line of lines) { try { safeSend(JSON.parse(line)); } catch (_) {} }
    });
    proc.stderr.on('data', chunk => {
      if (proc !== asrProcess) return;
      const text = chunk.toString();
      stderrTail = (stderrTail + text).slice(-800);
      safeSend({ kind: 'log', message: text.trim() });
    });
    proc.on('error', err => safeSend({ kind: 'error', message: `无法启动 Python ASR：${err.message}。请安装 Python 3.12，并确认命令 py -3.12 可用。` }));
    proc.on('close', code => {
      // 进程已被停止/替换（切换视频、关闭字幕）或窗口已销毁时，不下发 exit 事件
      if (proc !== asrProcess) return;
      if (buffer.trim()) { try { safeSend(JSON.parse(buffer.trim())); } catch (_) {} }
      const detail = stderrTail.split(/\r?\n/).map(s => s.trim()).filter(Boolean).slice(-3).join(' | ');
      safeSend({ kind: 'exit', code, detail: detail.slice(0, 260) }); asrProcess = null;
    });
    return true;
  });
  ipcMain.on('asr:stop', () => { if (asrProcess) { asrProcess.kill(); asrProcess = null; } });
  ipcMain.on('asr:seek', (event, payload) => {
    if (!asrProcess || asrProcess.killed) return;
    const msg = { cmd: payload && payload.seek ? 'seek' : 'pos', start: Number(payload && payload.start) || 0, rate: Number(payload && payload.rate) || 1 };
    try { asrProcess.stdin.write(JSON.stringify(msg) + '\n'); } catch (_) {}
  });
  ipcMain.on('window:minimize', e => BrowserWindow.fromWebContents(e.sender)?.minimize());
  ipcMain.on('window:maximize', e => { const w = BrowserWindow.fromWebContents(e.sender); w.isMaximized() ? w.unmaximize() : w.maximize(); });
  ipcMain.on('window:close', e => { if (asrProcess) { asrProcess.kill(); asrProcess = null; } BrowserWindow.fromWebContents(e.sender)?.close(); });
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
