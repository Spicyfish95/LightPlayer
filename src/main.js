const { app, BrowserWindow, dialog, ipcMain, Menu, Tray, nativeImage, utilityProcess, nativeTheme, shell, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { resolveModelDir } = require('./asr/models');
const { MEDIA_EXTENSIONS, mediaPathsFromArgv, normalizeMediaPath } = require('./launch-args');
let asrProcess = null;   // 常驻 ASR worker（sherpa-onnx，模型只加载一次，会话经消息控制）
let asrNextSid = 1;      // 会话自增 id（渲染端据此过滤旧会话残留事件）
const asrSidWaiters = new Map();   // sid → resolve()，等待某会话停止/结束
let asrActiveSid = 0;    // 当前运行中的会话 sid（0 表示空闲）

// 单实例：再次点击快捷方式 / exe 不再新开进程，而是把已打开的窗口唤到最前（见 app.requestSingleInstanceLock）
if (!app.requestSingleInstanceLock()) app.quit();

// 本地播放器场景：允许无用户手势自动播放（重启后自动续播上次视频依赖此能力）
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// 任务栏身份：打包后由 electron-builder 按 build.appId 自动设置 AppUserModelID。
// 开发模式刻意不设置：设置了显式 AppUserModelID 后，Windows 10+ 会把托盘气泡（displayBalloon）
// 转成操作中心的“系统通知”；不设置时保留经典气泡，从托盘图标上方弹出（见 showTrayBalloonOnce）。

let mainWindow = null;      // 主窗口（唯一）
let appQuitting = false;    // 真正退出（托盘菜单「退出」或系统关闭）时为 true，close 事件据此区分“关闭”与“隐藏到托盘”
let closeToTrayOn = true;   // 关闭到托盘开关（渲染端写 userData/close-to-tray.json，主进程据此决定关闭按钮的行为）

/* ---------- 启动参数 / 外部打开（命令行、「打开方式」、拖到 exe、快捷方式参数） ----------
   启动时的路径先存在 pendingLaunchFiles，等页面加载完（did-finish-load）再推给渲染端；
   软件已在运行时由 second-instance 的 argv 转发（macOS 走 open-file）。
   渲染端收到后会在「会话恢复完成」之后才载入并强制起播，避免被“恢复上次视频”覆盖。 */
let pendingLaunchFiles = mediaPathsFromArgv(process.argv, {
  packaged: app.isPackaged,
  defaultApp: process.defaultApp,
  baseDir: process.cwd()
});
let rendererReady = false;   // 页面是否已加载完；reload 期间短暂置 false，事件先排队
function flushLaunchFiles() {
  if (!rendererReady || !mainWindow || mainWindow.isDestroyed() || !pendingLaunchFiles.length) return;
  const files = pendingLaunchFiles;
  pendingLaunchFiles = [];
  mainWindow.webContents.send('launch:open', files);
}
function queueLaunchFiles(files) {
  if (!Array.isArray(files) || !files.length) return;
  pendingLaunchFiles = [...new Set([...pendingLaunchFiles, ...files])];
  flushLaunchFiles();
}
// macOS：Finder 里双击 / 拖到 Dock 时不会走 argv，而是触发 open-file（必须在 ready 前注册）
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  const p = normalizeMediaPath(filePath, process.cwd());
  if (p) queueLaunchFiles([p]);
});

// 关闭到托盘：与硬件加速开关同一套路（marker 文件），因为窗口的关闭行为在主进程，读不到渲染端 localStorage。
// enabled 省略时仅读取；默认开启。
function closeToTrayMarker() { return path.join(app.getPath('userData'), 'close-to-tray.json'); }
function readCloseToTray() {
  try {
    const marker = closeToTrayMarker();
    if (fs.existsSync(marker)) return JSON.parse(fs.readFileSync(marker, 'utf8')).enabled !== false;
  } catch (_) {}
  return true;
}
function writeCloseToTray(enabled) {
  try {
    fs.writeFileSync(closeToTrayMarker(), JSON.stringify({ enabled: !!enabled }));
    closeToTrayOn = !!enabled;
    if (!closeToTrayOn && tray) { tray.destroy(); tray = null; }   // 关掉后托盘图标不再驻留
    // 关闭后再重新开启：把托盘建回来（app ready 之前 createTray 无意义，用 isReady 守卫）
    else if (closeToTrayOn && app.isReady() && !tray) createTray();
    return true;
  } catch (_) { return false; }
}
closeToTrayOn = readCloseToTray();

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
  // win.webContents.openDevTools();
  // 启动参数里的视频要等页面可接收 IPC 后再发；reload（开发热更新）期间先排队，加载完补发
  win.webContents.on('did-start-loading', () => { rendererReady = false; });
  win.webContents.on('did-finish-load', () => { rendererReady = true; flushLaunchFiles(); });
  win.loadFile(path.join(__dirname, 'index.html'));
  // 关闭到托盘：点标题栏 ×（或 Alt+F4）不退出、不弹通知，只隐藏窗口，应用与播放状态都留在后台。
  // 只有 appQuitting（托盘菜单「退出」/ 系统关机）时才真正关闭，避免托盘菜单的「退出」也被拦成隐藏。
  win.on('close', e => {
    if (appQuitting || !closeToTrayOn) return;
    e.preventDefault();
    win.hide();
    showTrayBalloonOnce();   // 本次运行第一次最小化到托盘时，用气泡提示“程序未退出”
  });
  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });
  return win;
}

/* ---------- 托盘（关闭到托盘 / 托盘右键菜单） ---------- */
const APP_NAME = 'LightPlayer';
let tray = null;
let trayBalloonShown = false;   // 本次运行只提示一次（进程重启后自然重置）

// 最小化到托盘时的气泡提示：让用户知道软件还在运行、没有退出。
// Win10+ 已把原生托盘气泡（displayBalloon）一律转成系统 toast 条幅，无法得到“图标上方小气泡”的效果，
// 所以自绘一个无边框置顶小窗，定位在托盘图标正上方，数秒后淡出。只显示第一次，之后保持静默。
let balloonWin = null;
let balloonHideTimer = null;
function showTrayBalloonOnce() {
  if (trayBalloonShown || !tray) return;
  trayBalloonShown = true;
  if (!tray.getBounds || tray.isDestroyed()) return;
  const b = tray.getBounds();
  if (!b || (!b.x && !b.y)) return;   // 托盘刚创建时 bounds 可能为 0，取不到就放弃提示（一次性，不影响后续使用）
  if (balloonWin && !balloonWin.isDestroyed()) balloonWin.destroy();
  const W = 288, H = 90, TIP = 9, MARGIN = 12, DIP = 6;
  // 托盘通常在屏幕底部：气泡出现在图标上方；任务栏在顶部时改为下方
  const wa = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 }).workArea;
  const above = b.y > wa.y + wa.height / 2;
  // 窗体 = 卡片 + 三角小尾巴：尾巴必须对准托盘图标中心（水平方向可能被屏幕边缘截断，三角随之偏移）
  const cx = b.x + b.width / 2;                                   // 托盘图标中心（屏幕坐标）
  const unclampedX = cx - W / 2;                                  // 不裁边时的窗口左缘
  const x = Math.min(Math.max(unclampedX, wa.x + MARGIN), wa.x + wa.width - W - MARGIN);
  const tailX = Math.round(Math.min(Math.max(cx - x - TIP, MARGIN), W - MARGIN - TIP * 2));   // 三角在窗口内的左缘（指向图标）
  const y = above ? b.y - H - DIP : b.y + b.height + DIP;
  balloonWin = new BrowserWindow({
    x: Math.round(x), y: Math.round(y), width: W, height: H,
    frame: false, transparent: true, resizable: false, movable: false,
    minimizable: false, maximizable: false, skipTaskbar: true, alwaysOnTop: true,
    focusable: false, show: false, hasShadow: false
    // 注意不能开 offscreen：offscreen 模式的窗口在屏幕上显示不出内容（No content under offscreen mode），
    // 普通渲染的透明无边框窗口即可
  });
  balloonWin.setAlwaysOnTop(true, 'screen-saver');
  // 三角与卡片同色同描边，旋转 45° 的方块：上半（指向卡片外）盖住卡片底边与描边，视觉上连成一体
  const tailCss = above ? `bottom:-${TIP - 1}px` : `top:-${TIP - 1}px`;
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body{margin:0;font-family:"Segoe UI","Microsoft YaHei",sans-serif;background:transparent;overflow:hidden}
    .tip{box-sizing:border-box;width:100%;height:${H - TIP}px;background:rgba(28,32,42,.96);border:1px solid rgba(255,255,255,.14);
      border-radius:10px;padding:12px 14px;color:#e8ebf2;display:flex;gap:10px;align-items:center;position:relative}
    .tail{position:absolute;width:${TIP * 2 - 2}px;height:${TIP * 2 - 2}px;background:rgba(28,32,42,.96);
      border:1px solid rgba(255,255,255,.14);transform:rotate(45deg);${tailCss};
      border-left-color:transparent;border-top-color:transparent;clip-path:polygon(100% 0,100% 100%,0 100%)}
    .ic{flex:0 0 28px;width:28px;height:28px}
    b{display:block;font-size:13px;margin-bottom:3px}
    p{margin:0;font-size:12px;color:#aab2c0;line-height:1.5}
  </style></head><body><div class="tip">
    <svg class="ic" viewBox="0 0 24 24"><rect x="1" y="1" width="22" height="22" rx="6" fill="#1a2030"/><path d="M9.5 7.2v9.6L17.2 12z" fill="#7c5cff"/></svg>
    <div><b>LightPlayer 仍在运行</b><p>已最小化到系统托盘，右键托盘图标可退出</p></div>
    <div class="tail" style="left:${tailX}px"></div>
  </div></body></html>`;
  balloonWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  balloonWin.once('ready-to-show', () => { balloonWin.showInactive(); });
  clearTimeout(balloonHideTimer);
  balloonHideTimer = setTimeout(() => {
    if (balloonWin && !balloonWin.isDestroyed()) {
      // 直接销毁即可（transparent+offscreen 窗口做淡出动画收益小，还可能留下残影）
      balloonWin.destroy();
      balloonWin = null;
    }
  }, 3500);
}

// 窗口从托盘 / 任务栏唤回：隐藏的只 show 不会自动成前台，必须再 focus（Windows 下最小化状态要先 restore）
function revealMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) { mainWindow = createWindow(); return; }
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

// 托盘菜单里的「打开视频 / 关闭视频」转给渲染端执行：打开走系统文件对话框（与 Ctrl+O 同一条路径），
// 关闭走 stopPlayback（等同移除当前视频，回到空状态）。统一走 tray:action，渲染端按 action 分发。
function sendToRenderer(action) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const send = () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('tray:action', action);
  };
  // 窗口刚创建 / 正在重载时 webContents.send 会丢包，等页面加载完成再发
  if (mainWindow.webContents.isLoading()) mainWindow.webContents.once('did-finish-load', send);
  else send();
}

// 托盘右键菜单。每次单独构造一份：Windows 在弹出瞬间取当前 Menu，菜单项状态变了重建即可生效（旧对象由 GC 回收）
// 「关闭视频」始终发给渲染端，由渲染端判断当前有没有视频（没有时 stopPlayback 本身是幂等的），菜单不必随状态变化。
function trayMenu() {
  return Menu.buildFromTemplate([
    { label: `显示${APP_NAME}`, click: () => revealMainWindow() },
    { type: 'separator' },
    { label: '打开视频…', click: () => sendToRenderer('open-video') },
    { label: '关闭视频', click: () => sendToRenderer('close-video') },
    { type: 'separator' },
    { label: `退出${APP_NAME}`, click: () => { appQuitting = true; app.quit(); } }
  ]);
}

function createTray() {
  if (tray || !closeToTrayOn) return;
  // Windows 托盘优先用 .ico（内含 16/24/32px 多尺寸帧，系统按 DPI 取帧，避免 PNG 单尺寸被缩放糊掉）；
  // 其他平台回退 32px PNG。图标显示空白/发暗时先检查这里的图片是否加载成功。
  const trayIconPath = path.join(__dirname, '..', 'build', 'tray.ico');
  const img = process.platform === 'win32' && fs.existsSync(trayIconPath)
    ? nativeImage.createFromPath(trayIconPath)
    : nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'tray.png'));
  tray = new Tray(img);
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(trayMenu());
  // 左键单击 / 双击直接唤回窗口；右键菜单由 Windows 自动弹出，不用自己处理
  tray.on('click', () => revealMainWindow());
  tray.on('double-click', () => revealMainWindow());
}

app.whenReady().then(() => {
  const VIDEO_FILTER_EXTS = MEDIA_EXTENSIONS.map(e => e.slice(1));   // 对话框 filters 不带点
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
  // 在系统文件资源管理器中打开某个文件夹（播放列表的目录图标使用）
  ipcMain.handle('shell:open-folder', async (event, dir) => {
    try {
      if (typeof dir !== 'string' || !dir) return false;
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return false;
      const err = await shell.openPath(dir);
      return !err;
    } catch (_) { return false; }
  });
  ipcMain.handle('dialog:open-video', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'], filters: [{ name: '视频文件', extensions: VIDEO_FILTER_EXTS }] });
    return result.canceled ? [] : result.filePaths;
  });
  ipcMain.handle('dialog:open-video-folder', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return [];
    const extensions = new Set(MEDIA_EXTENSIONS);
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
      chunk: Number(options.chunk) || 4,
      // 透传「是否使用缓存」：渲染端关闭时必须原样送达 worker（缺省视为开启），
      // 否则 worker 端 msg.cache === undefined 会按默认开启处理，关闭开关仍会写缓存文件。
      cache: options.cache !== false,
      // 识别语言：'' = 自动，zh/en/yue/ja/ko（worker 端校验，非法值回退自动）
      language: String(options.language || '')
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
  // 主题：跟随系统时由主进程读取 OS 亮/暗并广播变化（nativeTheme.shouldUseDarkColors）
  ipcMain.handle('theme:system', () => ({ dark: nativeTheme.shouldUseDarkColors }));
  ipcMain.on('theme:mode', (e, mode) => {
    // 同步原生主题来源，让窗口控件（滚动条、默认右键菜单、titlebar 覆盖色）与界面一致
    nativeTheme.themeSource = mode === 'light' || mode === 'dark' ? mode : 'system';
  });
  nativeTheme.on('updated', () => {
    const payload = { dark: nativeTheme.shouldUseDarkColors };
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('theme:system-changed', payload);
  });
  ipcMain.on('window:minimize', e => BrowserWindow.fromWebContents(e.sender)?.minimize());  ipcMain.on('window:maximize', e => { const w = BrowserWindow.fromWebContents(e.sender); w.isMaximized() ? w.unmaximize() : w.maximize(); });
  ipcMain.on('window:close', e => {
    // 关闭到托盘时窗口只是隐藏、进程仍在，不结束 ASR 常驻 worker，
    // 否则从托盘恢复后继续识别要从零冷启动；真正退出由 before-quit 兜底清理。
    if (!closeToTrayOn) shutdownAsrDaemon();
    BrowserWindow.fromWebContents(e.sender)?.close();
  });

  // 关闭到托盘设置（渲染端写入 → 主进程即时生效；不带参数时为读取）
  ipcMain.handle('settings:close-to-tray', (event, enabled) => (
    typeof enabled === 'boolean' ? writeCloseToTray(enabled) : closeToTrayOn
  ));

  // 应用整体退出时兜底关闭常驻 worker（utilityProcess 子进程也会随父进程退出）
  app.on('before-quit', () => { appQuitting = true; shutdownAsrDaemon(); });
  mainWindow = createWindow();
  createTray();   // 关闭到托盘开启时驻留托盘；单实例再次启动由托盘 / revealMainWindow 唤回同一个窗口
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow(); });

  // 第二个实例被唤醒：这是用户又点了一次快捷方式 / exe，或对另一个视频选了「打开方式」。
  // 把已打开的窗口还原并顶到最前，不新开进程；argv 里的视频经 launch:open 转给渲染端直接播放。
  app.on('second-instance', (event, argv, workingDirectory) => {
    revealMainWindow();
    queueLaunchFiles(mediaPathsFromArgv(argv, {
      packaged: app.isPackaged,
      defaultApp: process.defaultApp,
      baseDir: workingDirectory || process.cwd()   // 相对路径按第二个进程的工作目录解析
    }));
  });
});
// 关闭到托盘时窗口全部隐藏并不等于退出：只有 appQuitting 才真正退出（托盘「退出」或系统关机）。
// 注意 close-window 被拦截时窗口从未真正销毁，window-all-closed 不会触发，这里只是退出路径的最后一道闸。
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
