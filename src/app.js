/* LightPlayer 渲染进程：播放器 UI、播放控制、播放列表树、字幕样式、实时字幕阶段与缓存 */
'use strict';

/* ---------- 统一 SVG 图标集（24px 网格 / 1.8 描边 / 圆角端点，风格一致） ---------- */
const ICONS = {
  play: '<path d="M8 5.3v13.4L19 12z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M7.2 5h3.2v14H7.2zM13.6 5h3.2v14h-3.2z" fill="currentColor" stroke="none"/>',
  back10: '<path d="M3 3v5h5"/><path d="M3.5 8A9 9 0 1 1 3 12"/><text x="12" y="15.5" text-anchor="middle" font-size="7.5" font-weight="700" fill="currentColor" stroke="none">10</text>',
  forward10: '<path d="M21 3v5h-5"/><path d="M20.5 8A9 9 0 1 0 21 12"/><text x="12" y="15.5" text-anchor="middle" font-size="7.5" font-weight="700" fill="currentColor" stroke="none">10</text>',
  volume: '<path d="M11 5 6.5 9H3v6h3.5L11 19z" fill="currentColor" stroke="none"/><path d="M15 8.6a4.6 4.6 0 0 1 0 6.8"/><path d="M17.8 5.6a8.6 8.6 0 0 1 0 12.8"/>',
  mute: '<path d="M11 5 6.5 9H3v6h3.5L11 19z" fill="currentColor" stroke="none"/><path d="m15.5 9.5 5 5M20.5 9.5l-5 5"/>',
  full: '<path d="M8.5 3.5H5.5a2 2 0 0 0-2 2v3M15.5 3.5h3a2 2 0 0 1 2 2v3M8.5 20.5H5.5a2 2 0 0 1-2-2v-3M15.5 20.5h3a2 2 0 0 0 2-2v-3"/>',
  cc: '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M10.2 10.3a2.4 2.4 0 1 0 0 3.4"/><path d="M16.8 10.3a2.4 2.4 0 1 0 0 3.4"/>',
  speed: '<path d="m12 14.5 3.8-3.8"/><path d="M3.8 18.5a10 10 0 1 1 16.4 0"/>',
  folder: '<path d="M3.5 7a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  panel: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M15 4.5v15"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  min: '<path d="M5 12h14"/>',
  max: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  video: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m10 9 5 3-5 3z" fill="currentColor" stroke="none"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M4 7h16"/><path d="M9.5 7V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v2"/><path d="M6.5 7l1 12a2 2 0 0 0 2 1.8h5a2 2 0 0 0 2-1.8l1-12"/><path d="M10 11v6M14 11v6"/>',
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  brand: '<defs><linearGradient id="lpBrandG" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7c5cff"/><stop offset="1" stop-color="#25d0d2"/></linearGradient></defs><rect x="2" y="2" width="20" height="20" rx="6" fill="url(#lpBrandG)" stroke="none"/><path d="M10 8.1v7.8L16.4 12z" fill="#fff" stroke="none"/>'
};
const icon = name => `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- 页面模板 ---------- */
const app = document.getElementById('app');
app.innerHTML = `
<header class="titlebar">
  <div class="brand" id="brandBtn" title="主菜单">${icon('brand')}<span>LightPlayer</span><span class="brand-caret">${icon('chevron')}</span></div>
  <div class="app-menu hidden" id="appMenu">
    <div class="menu-item" id="menuOpen">打开视频…</div>
    <div class="menu-item" data-modal="sub" data-tab="file">字幕</div>
    <div class="menu-item" data-modal="settings">设置</div>
    <div class="menu-item" data-modal="data">数据管理</div>
    <div class="menu-item" data-modal="hotkeys">快捷键</div>
    <div class="menu-item" data-modal="about">关于</div>
  </div>
  <span class="title" id="windowTitle">本地视频播放器</span>
  <div class="window-actions"><button id="minBtn" title="最小化">${icon('min')}</button><button id="maxBtn" title="最大化/还原">${icon('max')}</button><button class="close" id="closeBtn" title="关闭">${icon('close')}</button></div>
</header>
<div class="layout" id="layout">
<main class="main">
  <div class="video-wrap" id="videoWrap">
    <video id="video" preload="metadata"></video>
    <div class="empty-state" id="empty"><div class="empty-icon">${icon('video')}</div><h2>打开一个视频开始播放</h2><p>支持 MP4、MKV、WebM、MOV 等格式</p><div class="drop-hint">拖放文件到此处，或按 Ctrl + O</div></div>
    <div class="top-chip hidden" id="qualityChip">原画</div>
    <div class="resume-toast hidden" id="resumeToast">
      <span id="resumeToastText">已从上次位置续播</span>
      <button id="resumeRestart">从头开始播放</button>
      <i class="resume-bar" id="resumeBar"></i>
    </div>
    <div class="caption cap-bottom hidden" id="caption"></div>
    <div class="fs-ui" id="fsUi">
      <div class="fs-top">
        <div class="fs-title" id="fsTitle">本地视频播放器</div>
        <button class="fs-btn" id="fsExitTop" title="退出全屏">${icon('close')}</button>
      </div>
      <div class="fs-bottom">
        <div class="fs-progress"><div class="fs-fill" id="fsFill"></div><input type="range" id="fsSeek" min="0" max="1000" value="0"></div>
        <div class="fs-row">
          <button class="fs-btn" id="fsBack" title="后退 10 秒">${icon('back10')}</button>
          <button class="fs-btn primary" id="fsPlay" title="播放/暂停">${icon('play')}</button>
          <button class="fs-btn" id="fsForward" title="快进 10 秒">${icon('forward10')}</button>
          <span class="fs-time" id="fsTime">00:00 / 00:00</span>
          <div class="fs-volume"><button class="fs-btn" id="fsMute" title="静音">${icon('volume')}</button><input type="range" id="fsVolume" min="0" max="1" step="0.01" value="1"></div>
          <div class="spacer"></div>
          <button class="fs-btn" id="fsSpeedBtn" title="播放倍速">1×</button>
          <button class="fs-btn toggle-cc" id="fsSubBtn" title="开启/关闭实时字幕">${icon('cc')}</button>
          <button class="fs-btn" id="fsExit" title="退出全屏">${icon('full')}</button>
        </div>
      </div>
      <div class="speed-menu fs-speed-menu hidden" id="fsSpeedMenu"></div>
    </div>
  </div>
  <div class="controls">
    <div class="progress" id="progress"><div class="fill" id="fill"></div><input type="range" id="seek" min="0" max="1000" value="0"></div>
    <div class="control-row">
      <button class="ctrl" id="back" title="后退 10 秒">${icon('back10')}</button>
      <button class="ctrl primary" id="play" title="播放/暂停">${icon('play')}</button>
      <button class="ctrl" id="forward" title="快进 10 秒">${icon('forward10')}</button>
      <span class="time" id="time">00:00 / 00:00</span>
      <div class="volume"><button class="ctrl" id="mute" title="静音">${icon('volume')}</button><input type="range" id="volume" min="0" max="1" step="0.01" value="1"></div>
      <div class="spacer"></div>
      <button class="ctrl" id="speed" title="播放倍速">1×</button>
      <button class="ctrl" id="playSettingsBtn" title="播放设置">${icon('gear')}</button>
      <button class="ctrl toggle-cc" id="subBtn" title="开启/关闭实时字幕">${icon('cc')}</button>
      <button class="ctrl" id="folderBtn" title="显示/隐藏目录栏">${icon('panel')}</button>
      <button class="ctrl" id="full" title="全屏">${icon('full')}</button>
    </div>
    <div class="speed-menu hidden" id="speedMenu"></div>
  </div>
</main>
<aside class="side">
  <section class="panel active" id="playlist">
    <div class="section sec-now"><h3>正在播放</h3><div class="file-card"><div class="file-thumb">${icon('video')}</div><div class="file-info"><div class="file-name" id="fileName">暂无媒体文件</div><div class="file-meta" id="fileMeta">打开视频后显示信息</div></div></div></div>
    <div class="section sec-list"><h3>播放列表 <span class="list-count" id="listCount">0 个文件</span><span class="h3-actions"><button class="icon-btn" id="addFolderBtn" title="添加文件夹">${icon('folder')}</button><button class="icon-btn" id="addPlaylistBtn" title="添加文件">${icon('plus')}</button><button class="icon-btn" id="clearPlaylistBtn" title="清空播放列表">${icon('trash')}</button></span></h3><div class="playlist" id="playlistItems"></div></div>
  </section>
</aside>
</div>

<!-- 字幕弹窗：字幕 / 实时字幕 两个标签页 -->
<div class="modal-overlay hidden" id="modalSub">
  <div class="modal">
    <div class="modal-head"><h3>字幕</h3><button class="modal-close" data-close>${icon('close')}</button></div>
    <div class="modal-tabs"><button class="mtab active" data-mtab="file">字幕</button><button class="mtab" data-mtab="asr">实时字幕</button></div>
    <div class="modal-body">
      <div class="mpanel active" data-mpanel="file">
        <div class="section"><h3>字幕文件</h3>
          <button class="btn wide" id="loadSub">载入字幕文件（SRT / VTT）</button><button class="btn wide" id="clearSub">清除字幕</button><button class="btn wide" id="exportSrt">导出字幕为 SRT</button>
          <p class="hint-text">实时识别的字幕会自动缓存在视频所在目录，下次打开直接复用。</p>
        </div>
        <div class="section"><h3>字幕样式</h3>
          <div class="style-row"><label>字号</label><input type="range" id="capSize" min="16" max="48" step="1"><span class="val" id="capSizeVal"></span></div>
          <div class="style-row"><label>颜色</label><input type="color" id="capColor"><label class="mid">背景</label><input type="color" id="capBg"></div>
          <div class="style-row"><label>不透明度</label><input type="range" id="capBgAlpha" min="0" max="100" step="5"><span class="val" id="capBgAlphaVal"></span></div>
          <div class="style-row"><label>位置</label><select class="select" id="capPos"><option value="bottom">底部</option><option value="lower">靠下</option><option value="center">居中</option><option value="top">顶部</option><option value="custom">自定义</option></select></div>
          <div class="style-row custom-pos hidden" id="capCustomPos"><label>上</label><input type="number" class="num" id="capTop" min="0" step="1" placeholder="auto"><span class="unit">px / auto</span></div>
          <div class="style-row custom-pos hidden"><label>下</label><input type="number" class="num" id="capBottomIn" min="0" step="1" placeholder="auto"><span class="unit">px / auto</span></div>
          <div class="style-row custom-pos hidden"><label>左</label><input type="number" class="num" id="capLeft" min="0" step="1" placeholder="auto"><span class="unit">px / auto</span></div>
          <div class="style-row custom-pos hidden"><label>右</label><input type="number" class="num" id="capRight" min="0" step="1" placeholder="auto"><span class="unit">px / auto</span></div>
          <p class="hint-text custom-pos hidden">自定义位置：填写数值按 px 计算边距，留空为 auto（未指定的边不约束）。</p>
          <button class="btn wide" id="capReset">恢复默认样式</button>
        </div>
      </div>
      <div class="mpanel" data-mpanel="asr">
        <div class="section"><h3>实时字幕</h3>
          <div class="subtitle-box">
            <div class="subtitle-status"><span class="dot" id="asrDot"></span><span id="asrStatus">实时字幕已关闭</span><span class="device-badge" id="deviceBadge">设备：未运行</span><div class="switch" id="asrSwitch"></div></div>
            <select class="select" id="model"><option value="qwen">Qwen3-ASR-0.6B · 本地识别</option></select>
            <div class="model-note" id="modelNote">字幕在本机处理，不上传视频。Qwen3-ASR-0.6B 适合中文与多语种视频。</div>
            <div class="model-path-label">本地模型路径</div>
            <div class="model-path-row"><input class="model-path" id="modelPath" readonly placeholder="尚未设置模型目录"><button class="btn" id="chooseModelPath">选择</button></div>
            <button class="btn path-clear" id="clearModelPath">清除路径</button>
            <div class="asr-progress hidden" id="asrProgress">
              <div class="asr-progress-head"><span>当前阶段：<b id="asrStageLabel">准备中</b></span><span id="asrPercent">0%</span></div>
              <div class="asr-bar"><i id="asrBar"></i></div>
              <div class="asr-steps">
                <div class="step" id="step-dependency">检查/安装 ASR 依赖</div>
                <div class="step" id="step-model">加载 ASR 模型</div>
                <div class="step" id="step-audio">分析视频音频</div>
                <div class="step" id="step-transcribe">实时识别与转写</div>
              </div>
              <div class="asr-message" id="asrMessage"></div>
              <button class="btn wide" id="asrSkip" style="margin-top:8px">跳过排队，优先识别当前播放位置</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- 设置弹窗 -->
<div class="modal-overlay hidden" id="modalSettings">
  <div class="modal modal-sm">
    <div class="modal-head"><h3>设置</h3><button class="modal-close" data-close>${icon('close')}</button></div>
    <div class="modal-body">
      <div class="section sec-play"><h3>播放设置</h3><div class="settings-row">播放后操作
        <select class="select" id="afterPlay" style="width:150px">
          <option value="none">无操作</option>
          <option value="next">自动连播</option>
          <option value="loop">循环播放</option>
        </select></div>
      <div class="settings-row">自动播放上次未播完内容 <div class="switch" id="autoResume"></div></div><div class="settings-row">记住播放进度 <div class="switch" id="resumePlay"></div></div><div class="settings-row">记住播放列表 <div class="switch" id="keepPlaylist"></div></div><div class="settings-row">硬件加速 <div class="switch" id="hwAccel"></div></div></div>
      <div class="section sec-device"><h3>识别设备</h3>
        <div class="settings-row">语音识别设备
          <select class="select" id="deviceSelect" style="width:170px">
            <option value="auto">自动（GPU + CPU）</option>
            <option value="gpu">仅 GPU</option>
            <option value="cpu">仅 CPU</option>
          </select>
        </div>
        <p class="hint-text">自动：检测到 CUDA GPU 时 GPU 与 CPU 同时识别，速度最快；仅 GPU / 仅 CPU：强制使用指定设备；未检测到 GPU 时自动回退 CPU。更改后下次开启实时字幕生效。</p>
      </div>
    </div>
  </div>
</div>

<!-- 快捷键弹窗：开关 + 可配置快捷键列表 -->
<div class="modal-overlay hidden" id="modalHotkeys">
  <div class="modal modal-sm">
    <div class="modal-head"><h3>快捷键</h3><button class="modal-close" data-close>${icon('close')}</button></div>
    <div class="modal-body">
      <div class="section"><h3>快捷键开关</h3><div class="settings-row">启用键盘快捷键 <div class="switch" id="hotkeys"></div></div></div>
      <div class="section"><h3>快捷键配置 <span class="list-count">点击按键框后按下新按键</span></h3>
        <div id="hotkeyList"></div>
        <button class="btn wide" id="hotkeysReset" style="margin-top:10px">恢复默认快捷键</button>
      </div>
    </div>
  </div>
</div>

<!-- 关于弹窗 -->
<div class="modal-overlay hidden" id="modalAbout">
  <div class="modal modal-sm">
    <div class="modal-head"><h3>关于</h3><button class="modal-close" data-close>${icon('close')}</button></div>
    <div class="modal-body">
      <div class="section" style="text-align:center;padding:18px 0">
        <div style="display:inline-flex;width:56px;height:56px;border-radius:14px;overflow:hidden;margin-bottom:12px">${icon('brand')}</div>
        <h2 style="margin:0 0 6px;font-size:20px">LightPlayer</h2>
        <p class="hint-text" style="margin:0">轻量、隐私优先的本地播放器<br>版本 1.0.0</p>
      </div>
      <div class="section"><h3>特性</h3><p class="hint-text">本地视频/音频播放 · 播放列表管理 · 续播记忆<br>Qwen3-ASR 实时字幕（本机识别，不上传视频）<br>字幕样式自定义 · SRT 导出 · GPU + CPU 混合加速</p></div>
    </div>
  </div>
</div>

<!-- 数据管理弹窗：清理本应用保留的数据 -->
<div class="modal-overlay hidden" id="modalData">
  <div class="modal modal-sm">
    <div class="modal-head"><h3>数据管理</h3><button class="modal-close" data-close>${icon('close')}</button></div>
    <div class="modal-body">
      <div class="section"><h3>应用保留的数据</h3>
        <div class="cache-info" id="dataInfo">正在统计…</div>
        <div class="cache-info" id="cacheInfo">尚未打开视频</div>
        <p class="hint-text">字幕缓存：识别结果自动保存在视频同目录（视频名.lightplayer-subs.json）。再次打开该视频直接复用缓存字幕，仅识别缺失部分；清除字幕时也会同时删除缓存。</p>
        <button class="btn wide" id="dataRefresh">刷新统计</button>
      </div>
      <div class="section"><h3>清理选项</h3>
        <button class="btn wide" id="dataClearProgress">清除播放进度记录</button>
        <button class="btn wide" id="dataClearPlaylist">清除播放列表记录</button>
        <button class="btn wide" id="dataClearSettings">清除播放器设置（音量/样式/设备等）</button>
        <button class="btn wide" id="dataClearCache">清除当前视频字幕缓存</button>
        <button class="btn wide danger" id="dataClearAll">清除以上全部数据</button>
        <p class="hint-text">播放进度、播放列表、设置保存在本机（不清除视频文件本身）；字幕缓存保存在视频同目录（视频名.lightplayer-subs.json）。</p>
      </div>
    </div>
  </div>
</div>`;

/* ---------- 状态 ---------- */
const $ = s => document.querySelector(s);
const video = $('#video'), empty = $('#empty');
let subtitles = [];        // [{start,end,text,asr?}]
let activeFile = '';
let playlist = [];
let expandedGroups = new Set();   // 默认折叠，仅记录用户手动展开的目录

/* ---------- 会话持久化（音量 / 播放列表 / 播放进度 / 设置开关） ---------- */
const store = {
  get(key, fallback) { try { const v = JSON.parse(localStorage.getItem('lightplayer-' + key)); return v === null || v === undefined ? fallback : v; } catch (_) { return fallback; } },
  set(key, value) { try { localStorage.setItem('lightplayer-' + key, JSON.stringify(value)); } catch (_) {} },
  del(key) { try { localStorage.removeItem('lightplayer-' + key); } catch (_) {} }
};
const settings = {
  resumePlay: store.get('resume-play', true),    // 记住播放进度（续播）
  keepPlaylist: store.get('keep-playlist', true) // 记住播放列表
};
function saveProgress() {
  if (!settings.resumePlay || !activeFile || !isFinite(video.duration) || video.duration <= 0) return;
  store.set('progress-' + activeFile, { t: video.currentTime, d: video.duration });
}
function loadProgress(file) {
  if (!settings.resumePlay) return null;
  const p = store.get('progress-' + file, null);
  if (p && isFinite(p.t) && isFinite(p.d) && p.t > 5 && p.t < p.d - 5) return p;   // 片头片尾 5 秒内视为已完成/未开始
  return null;
}
function savePlaylistState() {
  if (!settings.keepPlaylist) return;
  const payload = { files: playlist, active: activeFile };
  store.set('playlist', payload);
  // 双写：主进程同步落盘文件（localStorage 异步提交在快速关闭时可能丢失）
  try { window.lightPlayer.saveSession({ kind: 'playlist', data: payload }); } catch (_) {}
}
const progressSaveTimer = setInterval(saveProgress, 3000);   // 每 3 秒记录一次播放位置

/* ---------- 字幕显示 ---------- */
const fmt = s => { if (!isFinite(s)) return '00:00'; s = Math.max(0, Math.floor(s)); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
let subsDirty = false;   // 字幕列表脏标记：插入时置位，显示前统一排序一次（避免逐条插入逐条排序）
function displayCurrentCaption() {
  if (subsDirty) { subtitles.sort((a, b) => a.start - b.start); subsDirty = false; }
  const t = video.currentTime;
  const hit = subtitles.find(x => t >= x.start - 0.05 && t < x.end + 0.05);
  if (hit) { $('#caption').textContent = hit.text; $('#caption').classList.remove('hidden'); return true; }
  $('#caption').classList.add('hidden'); return false;
}

/* ---------- 字幕样式（颜色 / 背景 / 大小 / 位置，持久化） ---------- */
const DEFAULT_CAP_STYLE = { size: 22, color: '#ffffff', bg: '#000000', bgAlpha: 0, pos: 'bottom', inset: { top: '', bottom: '', left: '', right: '' } };
let capStyle = { ...DEFAULT_CAP_STYLE };
try { capStyle = { ...DEFAULT_CAP_STYLE, ...JSON.parse(localStorage.getItem('lightplayer-caption-style') || '{}') }; } catch (_) {}
const hexToRgba = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`; };
function applyCaptionStyle() {
  const c = $('#caption');
  c.style.fontSize = capStyle.size + 'px';
  c.style.color = capStyle.color;
  if (capStyle.bgAlpha > 0) {
    c.style.background = hexToRgba(capStyle.bg, capStyle.bgAlpha / 100);
    c.style.padding = '2px 12px'; c.style.borderRadius = '6px'; c.style.textShadow = 'none';
  } else {
    c.style.background = 'transparent';
    c.style.padding = '0'; c.style.borderRadius = '0'; c.style.textShadow = '0 2px 12px #000,0 1px 3px #000';
  }
  ['cap-bottom', 'cap-lower', 'cap-center', 'cap-top'].forEach(k => c.classList.remove(k));
  // 位置：预设 or 自定义（数值 px / 空 = auto）
  const inset = { ...(capStyle.inset || {}) };
  const pxOrAuto = v => (v === '' || v === null || v === undefined || !isFinite(Number(v))) ? 'auto' : Math.max(0, Number(v)) + 'px';
  if (capStyle.pos === 'custom') {
    c.style.top = pxOrAuto(inset.top); c.style.bottom = pxOrAuto(inset.bottom);
    c.style.left = pxOrAuto(inset.left); c.style.right = pxOrAuto(inset.right);
    c.style.transform = 'none';
  } else {
    c.style.top = ''; c.style.bottom = ''; c.style.left = ''; c.style.right = '';
    c.style.transform = '';
    c.classList.add('cap-' + capStyle.pos);
  }
  document.querySelectorAll('.custom-pos').forEach(el => el.classList.toggle('hidden', capStyle.pos !== 'custom'));
  localStorage.setItem('lightplayer-caption-style', JSON.stringify(capStyle));
  $('#capSize').value = capStyle.size; $('#capSizeVal').textContent = capStyle.size + 'px';
  $('#capColor').value = capStyle.color; $('#capBg').value = capStyle.bg;
  $('#capBgAlpha').value = capStyle.bgAlpha; $('#capBgAlphaVal').textContent = capStyle.bgAlpha + '%';
  $('#capPos').value = capStyle.pos;
  $('#capTop').value = inset.top ?? ''; $('#capBottomIn').value = inset.bottom ?? '';
  $('#capLeft').value = inset.left ?? ''; $('#capRight').value = inset.right ?? '';
}
$('#capSize').oninput = e => { capStyle.size = Number(e.target.value); applyCaptionStyle(); };
$('#capColor').oninput = e => { capStyle.color = e.target.value; applyCaptionStyle(); };
$('#capBg').oninput = e => { capStyle.bg = e.target.value; applyCaptionStyle(); };
$('#capBgAlpha').oninput = e => { capStyle.bgAlpha = Number(e.target.value); applyCaptionStyle(); };
$('#capPos').onchange = e => { capStyle.pos = e.target.value; applyCaptionStyle(); };
// 自定义位置：输入数值（px）或留空（auto）
$('#capTop').oninput = e => { capStyle.inset = { ...(capStyle.inset || {}), top: e.target.value }; applyCaptionStyle(); };
$('#capBottomIn').oninput = e => { capStyle.inset = { ...(capStyle.inset || {}), bottom: e.target.value }; applyCaptionStyle(); };
$('#capLeft').oninput = e => { capStyle.inset = { ...(capStyle.inset || {}), left: e.target.value }; applyCaptionStyle(); };
$('#capRight').oninput = e => { capStyle.inset = { ...(capStyle.inset || {}), right: e.target.value }; applyCaptionStyle(); };
$('#capReset').onclick = () => { capStyle = { ...DEFAULT_CAP_STYLE }; applyCaptionStyle(); };
applyCaptionStyle();

/* ---------- 播放列表（按文件夹分组，可折叠） ---------- */
function buildGroups() {
  const map = new Map();
  for (const f of playlist) {
    const dir = f.replace(/[\\/][^\\/]+$/, '') || '/';
    if (!map.has(dir)) map.set(dir, []);
    map.get(dir).push(f);
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
    .map(([dir, files]) => ({ dir, files }));
}
function renderPlaylist() {
  const box = $('#playlistItems');
  $('#listCount').textContent = playlist.length + ' 个文件';
  if (!playlist.length) { box.innerHTML = '<div class="pl-empty">添加文件夹后显示视频</div>'; return; }
  const groups = buildGroups();
  box.innerHTML = groups.map(g => {
    // 当前播放文件所在目录保持展开，其余默认折叠（用户点开过的记录在 expandedGroups）
    const activeDir = activeFile ? activeFile.replace(/[\\/][^\\/]+$/, '') || '/' : '';
    const expanded = expandedGroups.has(g.dir) || g.dir === activeDir;
    const name = g.dir.split(/[\\/]/).pop() || g.dir;
    return `<div class="pl-group">
      <div class="pl-group-head" title="${escapeHtml(g.dir)}">
        <span class="pl-chevron${expanded ? ' open' : ''}">${icon('chevron')}</span>
        <span class="pl-folder">${icon('folder')}</span>
        <span class="pl-group-name">${escapeHtml(name)}</span>
        <span class="pl-count">${g.files.length}</span>
        <button class="pl-remove" data-dir="${escapeHtml(g.dir)}" title="从播放列表移除该文件夹">${icon('close')}</button>
      </div>
      <div class="pl-group-items${expanded ? '' : ' hidden'}">
        ${g.files.map(f => `<div class="playlist-item${f === activeFile ? ' selected' : ''}" data-index="${playlist.indexOf(f)}" title="${escapeHtml(f)}"><span class="playlist-name">${escapeHtml(f.split(/[\\/]/).pop())}</span><button class="pl-remove" data-file="${escapeHtml(f)}" title="从播放列表移除">${icon('close')}</button></div>`).join('')}
      </div>
    </div>`;
  }).join('');
  box.querySelectorAll('.pl-group-head').forEach((head, i) => {
    head.onclick = () => { const dir = groups[i].dir; expandedGroups.has(dir) ? expandedGroups.delete(dir) : expandedGroups.add(dir); renderPlaylist(); };
  });
  box.querySelectorAll('.pl-remove').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      if (btn.hasAttribute('data-dir')) removeGroup(btn.dataset.dir);
      else if (btn.dataset.file) removeFile(btn.dataset.file);
    };
  });
  box.querySelectorAll('.playlist-item').forEach(item => { item.onclick = () => { const f = playlist[Number(item.dataset.index)]; if (f && f !== activeFile) loadFile(f); }; });
}
const dirOf = f => f.replace(/[\\/][^\\/]+$/, '') || '/';
function stopPlayback() {
  if ($('#asrSwitch').classList.contains('on')) window.lightPlayer.stopAsr();
  window.asrLastError = false;
  $('#asrProgress').classList.add('hidden');
  STAGES.forEach(id => setStepState('step-' + id, 'pending'));
  $('#asrStageLabel').textContent = '准备中'; $('#asrPercent').textContent = '0%'; $('#asrBar').style.width = '0%'; $('#asrMessage').textContent = '';
  setAsrUi(false); setDeviceBadge(null);
  $('#asrStatus').textContent = '实时字幕已关闭';
  $('#caption').classList.add('hidden');
  video.pause(); video.removeAttribute('src'); video.load();
  activeFile = ''; subtitles = [];
  empty.classList.remove('hidden'); $('#qualityChip').classList.add('hidden');
  $('#fileName').textContent = '暂无媒体文件'; $('#fileMeta').textContent = '打开视频后显示信息';
  $('#windowTitle').textContent = '本地视频播放器'; $('#fsTitle').textContent = '本地视频播放器';
  setPlayIcon();
}
function removeFile(file) {
  playlist = playlist.filter(x => x !== file);
  if (file === activeFile) stopPlayback();
  renderPlaylist(); savePlaylistState();
}
function removeGroup(dir) {
  playlist = playlist.filter(x => dirOf(x) !== dir);
  if (!playlist.includes(activeFile)) stopPlayback();
  renderPlaylist(); savePlaylistState();
}
function clearPlaylist() {
  playlist = [];
  stopPlayback();
  renderPlaylist(); savePlaylistState();
}

/* ---------- 文件载入（含字幕缓存读取） ---------- */
let resumeToastTimer = null;
function showResumeToast(seconds) {
  const toast = $('#resumeToast');
  $('#resumeToastText').textContent = `已从上次位置续播 · ${fmt(seconds)}`;
  toast.classList.remove('hidden');
  // 5 秒倒计时条：CSS transition 从 100% 缩到 0
  const bar = $('#resumeBar');
  bar.style.transition = 'none'; bar.style.width = '100%';
  void bar.offsetWidth;   // 强制回流，确保 transition 生效
  bar.style.transition = 'width 5s linear'; bar.style.width = '0%';
  clearTimeout(resumeToastTimer);
  resumeToastTimer = setTimeout(() => toast.classList.add('hidden'), 5000);
}
$('#resumeRestart').onclick = () => {
  video.currentTime = 0;
  $('#resumeToast').classList.add('hidden');
  clearTimeout(resumeToastTimer);
};
function fileUrl(f) {
  if (f.startsWith('file://')) return f;
  // Windows 路径规范化：反斜杠→正斜杠，补第三根斜杠（file:///C:/...），中文/空格按 URL 编码
  let p = f.replace(/\\/g, '/');
  if (/^[A-Za-z]:/.test(p)) p = '/' + p;   // C:/... → /C:/...
  return 'file://' + encodeURI(p);
}
function loadFile(file, opts = {}) {
  const autoPlay = opts.autoPlay !== false;   // 启动恢复场景传 false，仅在自动续播开关开启时自动播放
  // 切换视频前记录实时字幕开关状态：切换后自动为新视频重启识别
  const asrWasOn = $('#asrSwitch').classList.contains('on');
  if (asrWasOn) window.lightPlayer.stopAsr();
  // 切换视频：重置实时字幕进度面板与激活状态，避免残留上一个视频的数据
  window.asrLastError = false;
  $('#asrProgress').classList.add('hidden');
  STAGES.forEach(id => setStepState('step-' + id, 'pending'));
  $('#asrStageLabel').textContent = '准备中'; $('#asrPercent').textContent = '0%'; $('#asrBar').style.width = '0%'; $('#asrMessage').textContent = '';
  $('#caption').classList.add('hidden');
  activeFile = file; subtitles = [];
  video.src = fileUrl(file);
  video.load(); setPlayIcon();   // load() 不触发 pause 事件，需手动同步图标
  empty.classList.add('hidden'); $('#qualityChip').classList.remove('hidden');
  $('#fileName').textContent = file.split(/[\\/]/).pop();
  $('#fileMeta').textContent = '本地媒体 · 等待载入';
  $('#windowTitle').textContent = $('#fileName').textContent; $('#fsTitle').textContent = $('#fileName').textContent;
  $('#asrStatus').textContent = '实时字幕已关闭'; setAsrUi(false);
  setDeviceBadge(null);
  renderPlaylist(); savePlaylistState();
  // 续播：恢复上次播放位置；左下角提示带“从头播放”按钮，5 秒倒计时条
  const resume = loadProgress(file);
  const resumeAt = () => {
    if (!resume) return;
    video.currentTime = resume.t;
    showResumeToast(resume.t);
  };
  video.addEventListener('loadedmetadata', () => {
    resumeAt();
    if (!autoPlay) return;
    video.play().then(() => {}).catch(() => {
      // Chromium 自动播放策略：无用户手势时非静音播放被拒绝。
      // 先静音启动播放，1.5 秒后尝试恢复音量（期间用户有交互则直接成功）。
      const wantMuted = video.muted, wantVolume = video.volume;
      video.muted = true;
      video.play().then(() => {
        setTimeout(() => {
          video.muted = wantMuted;
          video.volume = wantVolume;
          updateMuteIcons();
        }, 1500);
      }).catch(() => {});
    });
  }, { once: true });
  $('#seek').title = resume ? `上次播放到 ${fmt(resume.t)}，已续播；拖动可从头选择位置` : '拖动跳转播放位置';  window.lightPlayer.readCaptionCache(file).then(cached => {
    if (activeFile !== file || !Array.isArray(cached) || !cached.length || subtitles.length) return;
    subtitles = cached.map(c => ({ start: c.start, end: c.end, text: c.text, asr: true }));
    $('#asrStatus').textContent = `已加载缓存字幕 · ${subtitles.length} 条`;
    $('#asrDot').classList.add('on');
    displayCurrentCaption();
  });
  // 切换前实时字幕是开启状态：自动为新视频重新启动识别
  if (asrWasOn) startAsrRun();
}
async function openFiles() { const files = await window.lightPlayer.openVideo(); if (files?.length) { playlist = [...new Set([...playlist, ...files])]; loadFile(files[0]); renderPlaylist(); savePlaylistState(); } }
async function openFolder() { const files = await window.lightPlayer.openVideoFolder(); if (files?.length) { playlist = [...new Set([...playlist, ...files])]; loadFile(files[0]); renderPlaylist(); savePlaylistState(); } else { $('#fileMeta').textContent = '该文件夹内未找到支持的视频'; } }

/* ---------- 播放控制 ---------- */
const setPlayIcon = () => { const html = video.paused ? icon('play') : icon('pause'); $('#play').innerHTML = html; $('#fsPlay').innerHTML = html; };
function updateMuteIcons() { const html = video.muted ? icon('mute') : icon('volume'); $('#mute').innerHTML = html; $('#fsMute').innerHTML = html; }
$('#addPlaylistBtn').onclick = openFiles; $('#addFolderBtn').onclick = openFolder; $('#clearPlaylistBtn').onclick = clearPlaylist;
$('#play').onclick = () => video.paused ? video.play() : video.pause();
$('#back').onclick = () => video.currentTime = Math.max(0, video.currentTime - 10);
$('#forward').onclick = () => video.currentTime = Math.min(video.duration || 0, video.currentTime + 10);
$('#mute').onclick = () => { video.muted = !video.muted; updateMuteIcons(); store.set('volume', { v: video.volume, m: video.muted }); };
$('#volume').oninput = e => { video.volume = e.target.value; $('#fsVolume').value = video.volume; store.set('volume', { v: video.volume, m: video.muted }); };
$('#full').onclick = () => document.fullscreenElement ? document.exitFullscreen() : $('#videoWrap').requestFullscreen();
$('#seek').oninput = e => { if (video.duration) video.currentTime = video.duration * e.target.value / 1000; };

/* 画面交互：单击切换播放/暂停，双击切换全屏（单击延迟 250ms 等待双击判定） */
const videoWrap = $('#videoWrap');
let videoClickTimer = null;
videoWrap.addEventListener('click', e => {
  if (e.target.closest('.caption, .empty-state, .top-chip, .resume-toast, .fs-ui')) return;   // 字幕/空态/角标/续播提示/全屏工具栏不触发
  if (videoClickTimer) return;
  videoClickTimer = setTimeout(() => { videoClickTimer = null; video.paused ? video.play() : video.pause(); }, 250);
});
videoWrap.addEventListener('dblclick', e => {
  if (e.target.closest('.caption, .empty-state, .top-chip, .resume-toast, .fs-ui')) return;
  if (videoClickTimer) { clearTimeout(videoClickTimer); videoClickTimer = null; }
  document.fullscreenElement ? document.exitFullscreen() : videoWrap.requestFullscreen();
});

/* ---------- 全屏工具栏（顶部信息栏 + 底部控制条，与主控制条状态同步） ---------- */
let fsIdleTimer = null;
function syncFsControls() {
  $('#fsTitle').textContent = activeFile ? activeFile.split(/[\\/]/).pop() : '本地视频播放器';
  setPlayIcon();
  updateMuteIcons();
  $('#fsVolume').value = video.volume;
  $('#fsSpeedBtn').textContent = video.playbackRate + '×';
  const p = video.duration ? video.currentTime / video.duration : 0;
  $('#fsFill').style.width = p * 100 + '%'; $('#fsSeek').value = p * 1000;
  $('#fsTime').textContent = fmt(video.currentTime) + ' / ' + fmt(video.duration);
}
// 播放中且无操作 2.6 秒后自动隐藏工具栏并隐藏鼠标指针（移动鼠标立即恢复）
function fsShowUi() {
  videoWrap.classList.remove('fs-idle');
  clearTimeout(fsIdleTimer);
  if (document.fullscreenElement === videoWrap && !video.paused) {
    fsIdleTimer = setTimeout(() => videoWrap.classList.add('fs-idle'), 2600);
  }
}
videoWrap.addEventListener('mousemove', fsShowUi);
$('#fsPlay').onclick = () => (video.paused ? video.play() : video.pause());
$('#fsBack').onclick = () => { video.currentTime = Math.max(0, video.currentTime - 10); };
$('#fsForward').onclick = () => { video.currentTime = Math.min(video.duration || 0, video.currentTime + 10); };
$('#fsMute').onclick = () => { video.muted = !video.muted; updateMuteIcons(); store.set('volume', { v: video.volume, m: video.muted }); };
$('#fsVolume').oninput = e => { video.volume = e.target.value; $('#volume').value = video.volume; store.set('volume', { v: video.volume, m: video.muted }); };
$('#fsSeek').oninput = e => { if (video.duration) video.currentTime = video.duration * e.target.value / 1000; };
$('#fsSubBtn').onclick = toggleAsr;
$('#fsExit').onclick = () => document.exitFullscreen();
$('#fsExitTop').onclick = () => document.exitFullscreen();
document.addEventListener('fullscreenchange', () => {
  if (document.fullscreenElement === videoWrap) { syncFsControls(); hideSpeedMenus(); fsShowUi(); }
  else { videoWrap.classList.remove('fs-idle'); clearTimeout(fsIdleTimer); }
});

/* 倍速：点击弹出子菜单 */
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3];
// 统一设置倍速：同时写 playbackRate 与 defaultPlaybackRate。
// video.load()（切源/换片）会把 playbackRate 重置为 defaultPlaybackRate，只设 playbackRate 会导致
// 重启或换片后实际倍速丢失、下拉菜单勾选与实际不一致。
function setSpeed(rate, persist = true) {
  rate = Number(rate);
  if (!isFinite(rate) || rate <= 0) return;
  video.playbackRate = rate;
  video.defaultPlaybackRate = rate;
  $('#speed').textContent = rate + '×';
  $('#fsSpeedBtn').textContent = rate + '×';
  if (persist) store.set('speed', rate);
}
function renderSpeedMenu() {
  const html = SPEEDS.map(s => `<div class="speed-item${video.playbackRate === s ? ' active' : ''}" data-s="${s}">${s}×</div>`).join('');
  $('#speedMenu').innerHTML = html;
  $('#fsSpeedMenu').innerHTML = html;
}
function hideSpeedMenus() { $('#speedMenu').classList.add('hidden'); $('#fsSpeedMenu').classList.add('hidden'); }
function onSpeedPick(e) {
  const item = e.target.closest('.speed-item'); if (!item) return;
  setSpeed(Number(item.dataset.s));
  hideSpeedMenus();
  syncAsrPosition();
}
$('#speed').onclick = e => { e.stopPropagation(); renderSpeedMenu(); const open = $('#speedMenu').classList.contains('hidden'); hideSpeedMenus(); if (open) $('#speedMenu').classList.remove('hidden'); };
$('#fsSpeedBtn').onclick = e => { e.stopPropagation(); renderSpeedMenu(); const open = $('#fsSpeedMenu').classList.contains('hidden'); hideSpeedMenus(); if (open) $('#fsSpeedMenu').classList.remove('hidden'); };
$('#speedMenu').onclick = onSpeedPick;
$('#fsSpeedMenu').onclick = onSpeedPick;
document.addEventListener('click', e => {
  if (!e.target.closest('#speed') && !e.target.closest('#speedMenu')) $('#speedMenu').classList.add('hidden');
  if (!e.target.closest('#fsSpeedBtn') && !e.target.closest('#fsSpeedMenu')) $('#fsSpeedMenu').classList.add('hidden');
});

/* 播放后操作：无操作 / 自动连播 / 循环播放（单选下拉，持久化，默认无操作） */
const AFTER_PLAY_OPTS = ['none', 'next', 'loop'];
function afterPlay() { const v = store.get('after-play', 'none'); return AFTER_PLAY_OPTS.includes(v) ? v : 'none'; }
$('#afterPlay').value = afterPlay();
$('#afterPlay').onchange = () => {
  store.set('after-play', $('#afterPlay').value);
  syncVideoLoop();
};
function syncVideoLoop() { video.loop = afterPlay() === 'loop'; }
syncVideoLoop();
// 视频播放结束：播放后操作为“自动连播”时播下一个视频（当前文件夹下一个，或下一个文件夹的第一个）
video.onended = () => {
  if (afterPlay() !== 'next') return;
  const idx = playlist.indexOf(activeFile);
  if (idx < 0 || idx >= playlist.length - 1) return;   // 列表末尾或不在列表中
  loadFile(playlist[idx + 1]);
};
// 记住播放进度 / 记住播放列表（持久化开关）
function bindSettingSwitch(id, key, get, set) {
  const el = $('#' + id);
  el.classList.toggle('on', get());
  el.onclick = () => { const on = el.classList.toggle('on'); set(on); store.set(key, on); };
}
bindSettingSwitch('resumePlay', 'resume-play', () => settings.resumePlay, on => { settings.resumePlay = on; if (!on) { /* 关闭时清除所有已存进度 */ Object.keys(localStorage).filter(k => k.startsWith('lightplayer-progress-')).forEach(k => localStorage.removeItem(k)); } });
bindSettingSwitch('keepPlaylist', 'keep-playlist', () => settings.keepPlaylist, on => { settings.keepPlaylist = on; if (on) savePlaylistState(); else store.del('playlist'); });
// 自动播放上次未播完内容：开启时强制联动“记住播放进度”和“记住播放列表”，二者锁定为开，仅当本开关关闭后才能单独调整
function syncDependentSwitches() {
  const locked = store.get('auto-resume', true);
  if (locked) {
    settings.resumePlay = true; store.set('resume-play', true);
    settings.keepPlaylist = true; store.set('keep-playlist', true);
    $('#resumePlay').classList.add('on');
    $('#keepPlaylist').classList.add('on');
  }
  $('#resumePlay').style.pointerEvents = locked ? 'none' : '';
  $('#resumePlay').style.opacity = locked ? '.55' : '';
  $('#keepPlaylist').style.pointerEvents = locked ? 'none' : '';
  $('#keepPlaylist').style.opacity = locked ? '.55' : '';
}
$('#autoResume').onclick = () => {
  const on = $('#autoResume').classList.toggle('on');
  store.set('auto-resume', on);
  syncDependentSwitches();
};
$('#autoResume').classList.toggle('on', store.get('auto-resume', true));
syncDependentSwitches();
// 硬件加速：marker 文件（主进程下次启动读取）+ localStorage 双写，重启后生效
let hwAccelOn = store.get('hw-accel', true);
$('#hwAccel').classList.toggle('on', hwAccelOn);
$('#hwAccel').onclick = () => {
  hwAccelOn = $('#hwAccel').classList.toggle('on');
  store.set('hw-accel', hwAccelOn);
  window.lightPlayer.setHwAccel(hwAccelOn);
};
// 快捷键：即时生效（空格/方向键/F/Ctrl+O）
let hotkeysOn = store.get('hotkeys', true);
$('#hotkeys').classList.toggle('on', hotkeysOn);
$('#hotkeys').onclick = () => { hotkeysOn = $('#hotkeys').classList.toggle('on'); store.set('hotkeys', hotkeysOn); };
const savedDevice = ['auto', 'cpu', 'gpu'].includes(localStorage.getItem('lightplayer-device')) ? localStorage.getItem('lightplayer-device') : 'auto';
$('#deviceSelect').value = savedDevice;
$('#deviceSelect').onchange = e => localStorage.setItem('lightplayer-device', e.target.value);

/* 恢复上次会话：音量 → 倍速 → 播放列表与上次视频
   异常不中断后续事件绑定；恢复结果记录到 __resumeDebug 便于诊断 */
(function restoreSession() {
  function resumeFromSaved(saved) {
    try {
      if (saved && Array.isArray(saved.files) && saved.files.length) {
        playlist = saved.files;
        renderPlaylist();
        // 自动播放上次未播完内容：恢复视频并自动播放（loadFile 内续播到上次进度）
        // 仅记住列表（未开自动续播）：恢复列表与视频但不自动播放
        if (saved.active && playlist.includes(saved.active)) {
          loadFile(saved.active, { autoPlay: store.get('auto-resume', true) });
          window.__resumeDebug = 'restored:' + saved.active;
        } else {
          window.__resumeDebug = 'no-active:' + (saved.active || '(空)');
        }
      } else {
        window.__resumeDebug = 'no-playlist-saved';
      }
    } catch (err) {
      console.error('会话恢复失败', err);
      window.__resumeDebug = 'error:' + (err && err.message);
      const emptyBox = $('#empty');
      if (emptyBox) { const p = document.createElement('p'); p.textContent = '会话恢复失败：' + (err && err.message); p.style.color = '#ff7a7a'; emptyBox.appendChild(p); }
    }
  }
  try {
    const vol = store.get('volume', { v: 0.6, m: false });   // 初始默认音量 60%
    if (vol && isFinite(vol.v)) {
      video.volume = Math.min(1, Math.max(0, vol.v));
      video.muted = !!vol.m;
      $('#volume').value = video.volume;
      updateMuteIcons();
    }
    const savedSpeed = store.get('speed', 1);
    if (isFinite(savedSpeed) && savedSpeed > 0 && savedSpeed !== 1) setSpeed(savedSpeed, false);
    if (settings.keepPlaylist) {
      // localStorage 快速关闭时可能丢失：优先读主进程同步落盘的会话文件，回退 localStorage
      window.lightPlayer.loadSession()
        .then(s => resumeFromSaved(s && s.kind === 'playlist' && s.data ? s.data : store.get('playlist', null)))
        .catch(() => resumeFromSaved(store.get('playlist', null)));
    } else {
      window.__resumeDebug = 'keep-playlist-off';
    }
  } catch (err) { console.error('会话基础恢复失败', err); }
})();

video.ontimeupdate = () => {
  const p = video.duration ? video.currentTime / video.duration : 0;
  $('#fill').style.width = p * 100 + '%'; $('#seek').value = p * 1000;
  $('#fsFill').style.width = p * 100 + '%'; $('#fsSeek').value = p * 1000;
  const t = fmt(video.currentTime) + ' / ' + fmt(video.duration);
  $('#time').textContent = t; $('#fsTime').textContent = t;
  displayCurrentCaption();
};
video.onplay = () => { setPlayIcon(); fsShowUi(); }; video.onpause = () => { setPlayIcon(); videoWrap.classList.remove('fs-idle'); clearTimeout(fsIdleTimer); };
video.onloadedmetadata = () => $('#fileMeta').textContent = fmt(video.duration) + ' · ' + (video.videoWidth || '') + '×' + (video.videoHeight || '');
video.onseeked = () => { displayCurrentCaption(); if ($('#asrSwitch').classList.contains('on') && activeFile) window.lightPlayer.seekAsr({ start: video.currentTime, rate: video.paused ? 0 : video.playbackRate, seek: true }); };
function syncAsrPosition() { if ($('#asrSwitch').classList.contains('on') && activeFile) window.lightPlayer.seekAsr({ start: video.currentTime, rate: video.paused ? 0 : video.playbackRate }); }
setInterval(syncAsrPosition, 2500);

/* ---------- 字幕文件（SRT / VTT） ---------- */
function parseSub(raw) {
  raw = raw.replace(/\r/g, ''); const out = [];
  for (const b of raw.split(/\n\n+/)) {
    const m = b.match(/(\d{1,2}:\d{2}(?::\d{2})?[,.]\d{3})\s*-->\s*(\d{1,2}:\d{2}(?::\d{2})?[,.]\d{3})/);
    if (m) {
      const t = x => { const a = x.replace(',', '.').split(':').map(Number); return a.length === 3 ? a[0] * 3600 + a[1] * 60 + a[2] : a[0] * 60 + a[1]; };
      out.push({ start: t(m[1]), end: t(m[2]), text: b.slice(m.index + m[0].length).replace(/^\s+|\n?\d+\s*$/g, '').replace(/\n/g, ' ') });
    }
  }
  return out;
}

/* ---------- 模型路径 ---------- */
const savedModelPath = localStorage.getItem('lightplayer-model-path') || '';
$('#modelPath').value = savedModelPath;
$('#chooseModelPath').onclick = async () => { const p = await window.lightPlayer.openModelDirectory(); if (p) { $('#modelPath').value = p; localStorage.setItem('lightplayer-model-path', p); $('#modelNote').textContent = '模型目录已更新，将优先从该位置加载。'; } };
$('#clearModelPath').onclick = () => { localStorage.removeItem('lightplayer-model-path'); $('#modelPath').value = ''; $('#modelNote').textContent = '未设置模型目录，将使用默认模型位置。'; };
$('#model').onchange = () => {};   // 仅 Qwen3-ASR 一种后端，无切换逻辑
$('#loadSub').onclick = async () => { const r = await window.lightPlayer.openSubtitle(); if (r) { subtitles = parseSub(r.content); displayCurrentCaption(); $('#asrStatus').textContent = `已载入字幕 · ${subtitles.length} 条`; $('#asrDot').classList.add('on'); } };
$('#clearSub').onclick = async () => {
  subtitles = []; $('#caption').classList.add('hidden');
  $('#asrStatus').textContent = '实时字幕已关闭'; setAsrUi(false);
  if (activeFile) await window.lightPlayer.clearCaptionCache(activeFile);};

/* ---------- SRT 导出 ---------- */
const toSrtTime = s => { const ms = Math.max(0, Math.round(s * 1000)); return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; };
$('#exportSrt').onclick = async () => {
  if (!subtitles.length) { $('#asrStatus').textContent = '当前没有可导出的字幕'; return; }
  const items = [...subtitles].sort((a, b) => a.start - b.start);
  const srt = items.map((c, i) => `${i + 1}\n${toSrtTime(c.start)} --> ${toSrtTime(c.end)}\n${c.text}\n`).join('\n');
  const r = await window.lightPlayer.exportSrt({ video: activeFile, srt });
  if (r && r.ok) { $('#asrStatus').textContent = '字幕已导出：' + r.path; $('#asrMessage').textContent = '已导出到 ' + r.path; }
  else if (r && r.message) { $('#asrStatus').textContent = '导出失败：' + r.message; }
};

/* ---------- 实时字幕：阶段与进度 ---------- */
const STAGES = ['dependency', 'model', 'audio', 'transcribe'];
const STAGE_LABELS = { dependency: '检查依赖', model: '加载模型', audio: '分析音频', transcribe: '识别转写', display: '完成' };
function setStepState(id, state) { const el = $('#' + id); if (el) el.dataset.state = state; }
function setDeviceBadge(device) {
  const el = $('#deviceBadge');
  if (!device) { el.textContent = '设备：未运行'; el.className = 'device-badge'; return; }
  el.textContent = '设备：' + device;
  el.className = 'device-badge' + (device === 'CPU + GPU' ? ' gpu' : device === 'GPU' ? ' gpu' : ' cpu');
}
function updateAsrProgress(data) {
  if (data.percent != null) { $('#asrBar').style.width = data.percent + '%'; $('#asrPercent').textContent = data.percent + '%'; }
  if (data.device) setDeviceBadge(data.device);
  const stage = data.stage;
  if (stage && STAGE_LABELS[stage]) {
    $('#asrStageLabel').textContent = STAGE_LABELS[stage];
    if (stage === 'display') { STAGES.forEach(id => setStepState('step-' + id, 'done')); $('#asrPercent').textContent = '100%'; $('#asrBar').style.width = '100%'; }
    else {
      const idx = STAGES.indexOf(stage);
      // 当前阶段之前的算完成、当前阶段进行中、之后的全部回到待处理（不显示进行中图标）
      STAGES.forEach((id, i) => setStepState('step-' + id, i < idx ? 'done' : i === idx ? 'active' : 'pending'));
    }
  }
  if (data.message) $('#asrMessage').textContent = data.message;
}
function setAsrUi(on) {
  $('#asrSwitch').classList.toggle('on', on);
  $('#asrDot').classList.toggle('on', on);
  $('#subBtn').classList.toggle('on', on);   // 播放器栏 CC 按钮激活态
  $('#fsSubBtn').classList.toggle('on', on); // 全屏工具栏 CC 按钮激活态
}
async function startAsrRun() {
  if (!activeFile) { $('#asrStatus').textContent = '请先打开视频'; $('#caption').textContent = '请先打开视频'; $('#caption').classList.remove('hidden'); setAsrUi(false); return; }
  const modelPath = $('#modelPath').value.trim();
  if (!modelPath) { $('#asrStatus').textContent = '请先设置本地模型路径（菜单 → 字幕）'; $('#caption').textContent = '请先设置本地模型路径'; $('#caption').classList.remove('hidden'); setAsrUi(false); return; }
  setAsrUi(true);
  // 等待新视频元数据就绪（load() 后 duration 还是 NaN，直接启动会导致“无法读取视频时长”）
  if (!isFinite(video.duration) || video.duration <= 0) {
    $('#asrStatus').textContent = '正在读取视频信息…';
    await new Promise(resolve => {
      const done = () => { video.removeEventListener('loadedmetadata', done); clearTimeout(timer); resolve(); };
      const timer = setTimeout(done, 8000);   // 最多等 8 秒，超时交给 worker 用 ffprobe 读取
      video.addEventListener('loadedmetadata', done);
    });
    if (activeFile !== video.src && !video.src) return;   // 视频已被切换/清除
  }
  window.asrLastError = false;
  $('#asrProgress').classList.remove('hidden');
  STAGES.forEach(id => setStepState('step-' + id, 'pending'));
  $('#asrStageLabel').textContent = '准备中'; $('#asrPercent').textContent = '0%'; $('#asrBar').style.width = '0%'; $('#asrMessage').textContent = '';
  setDeviceBadge(null);
  $('#caption').textContent = '正在检查 ASR 依赖…'; $('#caption').classList.remove('hidden');
  $('#asrStatus').textContent = '正在检查本地 ASR 依赖…';
  await window.lightPlayer.startAsr({ video: activeFile, modelPath, modelKind: $('#model').value, duration: video.duration, start: video.currentTime, device: $('#deviceSelect').value });
}
async function toggleAsr() {
  const on = !$('#asrSwitch').classList.contains('on');
  if (on) {
    await startAsrRun();
  } else {
    setAsrUi(false);
    window.lightPlayer.stopAsr();
    $('#asrProgress').classList.add('hidden');
    $('#asrStatus').textContent = '实时字幕已关闭';
    $('#caption').classList.add('hidden');
    setDeviceBadge(null);
  }
}
$('#asrSwitch').onclick = toggleAsr;
$('#subBtn').onclick = toggleAsr;   // 播放器栏 CC 按钮：只负责开/关实时字幕
$('#asrSkip').onclick = () => {   // 取消当前识别队列，立即回到播放位置附近识别
  if (!activeFile) return;
  window.lightPlayer.seekAsr({ start: video.currentTime, rate: video.paused ? 0 : video.playbackRate, seek: true });
  $('#asrMessage').textContent = '已跳过排队，优先识别当前播放位置';
};
window.lightPlayer.onAsrEvent(data => {
  if (data.kind === 'status') { updateAsrProgress(data); return; }
  if (data.kind === 'captions') {   // 批量字幕（缓存恢复）：一次入列，排序延迟到显示时
    for (const it of data.items || []) subtitles.push({ start: it.start, end: it.end, text: it.text, asr: true });
    subsDirty = true; displayCurrentCaption();
    return;
  }
  if (data.kind === 'caption') {
    const item = { start: data.start, end: data.end, text: data.text, asr: true };
    subtitles = subtitles.filter(x => !(x.asr && x.start < item.end - 0.01 && x.end > item.start + 0.01));
    subtitles.push(item); subsDirty = true;
    displayCurrentCaption();
    $('#asrStatus').textContent = '实时字幕运行中 · 已生成至 ' + fmt(data.end);
    return;
  }
  if (data.kind === 'error') {
    window.asrLastError = true;
    $('#asrStatus').textContent = data.message;
    $('#asrStageLabel').textContent = '出错';
    $('#asrMessage').textContent = data.message;
    $('#caption').textContent = 'ASR 错误：' + data.message; $('#caption').classList.remove('hidden');
    setAsrUi(false);
    return;
  }
  if (data.kind === 'done') {
    STAGES.forEach(id => setStepState('step-' + id, 'done'));
    $('#asrStageLabel').textContent = '完成'; $('#asrPercent').textContent = '100%'; $('#asrBar').style.width = '100%';
    $('#asrMessage').textContent = '字幕识别完成';
    $('#asrStatus').textContent = '实时字幕识别完成';
    return;
  }
  if (data.kind === 'exit' && data.code !== 0 && !window.asrLastError && $('#asrSwitch').classList.contains('on')) {
    const detail = data.detail ? `（${String(data.detail).slice(0, 220)}）` : '';
    $('#asrStatus').textContent = 'ASR 进程已退出，请检查模型路径和 Python 依赖' + detail;
    $('#asrMessage').textContent = 'ASR 进程已退出' + detail;
    setAsrUi(false);
  }
});

/* ---------- 主菜单 / 弹窗 / 目录栏切换 ---------- */
const MODALS = { sub: '#modalSub', settings: '#modalSettings', data: '#modalData', hotkeys: '#modalHotkeys', about: '#modalAbout' };
let recordingHotkey = null;   // 快捷键录制态（在 keydown 系统前声明，openModal 会引用）
function openModal(name, tab, playOnly) {
  const overlay = $(MODALS[name]); if (!overlay) return;
  overlay.classList.remove('hidden');
  if (name === 'sub' && tab) switchModalTab(tab);
  if (name === 'data') { refreshDataInfo(); refreshCacheInfo(); }
  if (name === 'hotkeys') { recordingHotkey = null; renderHotkeyList(null); }
  if (name === 'settings') {
    // 工具栏入口：仅显示播放设置分区；菜单入口：显示完整设置
    overlay.querySelectorAll('.sec-device').forEach(s => s.classList.toggle('hidden', !!playOnly));
  }
}
function closeModals() { document.querySelectorAll('.modal-overlay').forEach(m => m.classList.add('hidden')); }
function switchModalTab(tab) {
  document.querySelectorAll('#modalSub .mtab').forEach(t => t.classList.toggle('active', t.dataset.mtab === tab));
  document.querySelectorAll('#modalSub .mpanel').forEach(p => p.classList.toggle('active', p.dataset.mpanel === tab));
}
$('#brandBtn').onclick = e => { e.stopPropagation(); $('#appMenu').classList.toggle('hidden'); };
document.addEventListener('click', e => {
  if (!e.target.closest('#brandBtn') && !e.target.closest('#appMenu')) $('#appMenu').classList.add('hidden');
  if (!e.target.closest('#speed') && !e.target.closest('#speedMenu')) $('#speedMenu').classList.add('hidden');
});
document.querySelectorAll('.menu-item').forEach(item => {
  item.onclick = e => { e.stopPropagation(); $('#appMenu').classList.add('hidden'); openModal(item.dataset.modal, item.dataset.tab); };
});
$('#menuOpen').onclick = e => { e.stopPropagation(); $('#appMenu').classList.add('hidden'); openFiles(); };
$('#playSettingsBtn').onclick = () => openModal('settings', null, true);   // 工具栏：仅播放设置分区
document.querySelectorAll('#modalSub .mtab').forEach(t => t.onclick = () => switchModalTab(t.dataset.mtab));
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => { if (e.target === overlay) closeModals(); });
  overlay.querySelectorAll('[data-close]').forEach(btn => btn.onclick = closeModals);
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModals(); });

/* 目录栏显示/隐藏 */
$('#folderBtn').onclick = () => {
  const hidden = $('#layout').classList.toggle('no-side');
  $('#folderBtn').classList.toggle('on', !hidden);
};

/* 字幕缓存信息（数据管理弹窗内展示） */
async function refreshCacheInfo() {
  const info = $('#cacheInfo');
  if (!info) return;
  if (!activeFile) { info.textContent = '当前视频：未打开视频，无字幕缓存'; info.className = 'cache-info'; return; }
  const cached = await window.lightPlayer.readCaptionCache(activeFile);
  const caps = Array.isArray(cached) ? cached : (cached && cached.captions) || [];
  if (caps.length) { info.textContent = `当前视频字幕缓存：${caps.length} 条`; info.className = 'cache-info has'; }
  else { info.textContent = '当前视频暂无字幕缓存'; info.className = 'cache-info'; }
}

/* ---------- 数据管理弹窗 ---------- */
function lpKeys(prefix) { return Object.keys(localStorage).filter(k => k.startsWith('lightplayer-' + prefix)); }
function refreshDataInfo() {
  const info = $('#dataInfo');
  const progressCount = lpKeys('progress-').length;
  const hasPlaylist = !!store.get('playlist', null);
  // 设置项 = 全部 lightplayer-* 键，扣除进度与播放列表（这两类单独统计展示）
  const settingKeys = Object.keys(localStorage).filter(k => k.startsWith('lightplayer-') && !k.startsWith('lightplayer-progress-') && k !== 'lightplayer-playlist').length;
  const styleSaved = !!store.get('caption-style', null);
  info.innerHTML = `播放进度记录：<b>${progressCount}</b> 个视频<br>播放列表：<b>${hasPlaylist ? store.get('playlist', {}).files.length + ' 个文件' : '无'}</b><br>播放器设置项：<b>${settingKeys}</b> 项（含字幕样式${styleSaved ? '已自定义' : '默认'}、音量、倍速、设备等）`;
}
function clearProgressData() { lpKeys('progress-').forEach(k => localStorage.removeItem(k)); }
$('#dataRefresh').onclick = () => { refreshDataInfo(); refreshCacheInfo(); };
$('#dataClearProgress').onclick = () => { clearProgressData(); refreshDataInfo(); };
$('#dataClearPlaylist').onclick = () => {
  store.del('playlist');
  playlist = [];              // 同步清空内存列表与界面，否则 renderPlaylist 会重新渲染旧数据
  renderPlaylist();
  refreshDataInfo();
};
// 清除设置时的排除项：模型路径（重新选择成本高，用户明确要求保留）
const EXCLUDED_CLEAR_KEYS = ['lightplayer-progress-', 'lightplayer-playlist', 'lightplayer-model-path'];
function clearSettingsKeys() {
  Object.keys(localStorage).filter(k => k.startsWith('lightplayer-') && !EXCLUDED_CLEAR_KEYS.some(ex => k === ex || k.startsWith(ex))).forEach(k => localStorage.removeItem(k));
}
$('#dataClearSettings').onclick = () => {
  clearSettingsKeys();
  refreshDataInfo();
};
$('#dataClearCache').onclick = async () => {
  if (activeFile) {
    await window.lightPlayer.clearCaptionCache(activeFile);
    subtitles = subtitles.filter(x => !x.asr);
    displayCurrentCaption();
  }
  refreshDataInfo(); refreshCacheInfo();
};
$('#dataClearAll').onclick = () => {
  clearProgressData();
  store.del('playlist');
  clearSettingsKeys();   // 模型路径同样保留
  window.lightPlayer.setHwAccel(true);   // 设置清空后硬件加速恢复默认（开）
  refreshDataInfo(); refreshCacheInfo();
};

/* ---------- 快捷键（可配置） / 拖放 / 窗口 ---------- */
// 动作注册表：id → { label, 默认键, 执行 }
const HOTKEY_ACTIONS = [
  { id: 'play', label: '播放 / 暂停', def: 'Space', run: () => $('#play').click() },
  { id: 'back', label: '后退 10 秒', def: 'ArrowLeft', run: () => $('#back').click() },
  { id: 'forward', label: '快进 10 秒', def: 'ArrowRight', run: () => $('#forward').click() },
  { id: 'full', label: '全屏', def: 'KeyF', run: () => $('#full').click() },
  { id: 'mute', label: '静音', def: 'KeyM', run: () => $('#mute').click() },
  { id: 'open', label: '打开视频', def: 'Ctrl+KeyO', run: () => openFiles() },
  { id: 'volup', label: '音量 +10%', def: 'ArrowUp', run: () => { video.volume = Math.min(1, video.volume + 0.1); $('#volume').value = video.volume; store.set('volume', { v: video.volume, m: video.muted }); } },
  { id: 'voldown', label: '音量 -10%', def: 'ArrowDown', run: () => { video.volume = Math.max(0, video.volume - 0.1); $('#volume').value = video.volume; store.set('volume', { v: video.volume, m: video.muted }); } }
];
let hotkeyMap = null;   // { actionId: 'Key' 或 'Ctrl+Key' }
try { hotkeyMap = JSON.parse(localStorage.getItem('lightplayer-hotkeys') || 'null'); } catch (_) {}
const defaultHotkeyMap = () => Object.fromEntries(HOTKEY_ACTIONS.map(a => [a.id, a.def]));
if (!hotkeyMap || typeof hotkeyMap !== 'object') hotkeyMap = defaultHotkeyMap();
// 旧版单键迁移：Space/箭头/F 等继续有效；缺失的动作用默认键补齐
HOTKEY_ACTIONS.forEach(a => { if (!hotkeyMap[a.id]) hotkeyMap[a.id] = a.def; });
function saveHotkeys() { localStorage.setItem('lightplayer-hotkeys', JSON.stringify(hotkeyMap)); }
function keyLabel(code) {
  const map = { Space: '空格', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓' };
  let s = map[code] || code.replace(/^Key/, '').replace(/^Digit/, '');
  return s.replace('Control+', 'Ctrl+');
}
function renderHotkeyList(recordingId) {
  const box = $('#hotkeyList');
  box.innerHTML = HOTKEY_ACTIONS.map(a => `<div class="hotkey-row">
    <span class="hotkey-label">${a.label}</span>
    <button class="hotkey-key${recordingId === a.id ? ' recording' : ''}" data-action="${a.id}" title="点击后按下新按键">${recordingId === a.id ? '按下新按键…' : keyLabel(hotkeyMap[a.id])}</button>
  </div>`).join('');
  box.querySelectorAll('.hotkey-key').forEach(btn => {
    btn.onclick = () => renderHotkeyList(btn.dataset.action);   // 进入录制态
  });
}
document.addEventListener('keydown', e => {
  if (recordingHotkey) {
    // 录制快捷键：接受普通键或 Ctrl+键；Esc 取消
    e.preventDefault(); e.stopPropagation();
    if (e.code === 'Escape') { recordingHotkey = null; renderHotkeyList(null); return; }
    if (e.ctrlKey || e.altKey || /^Key|^Digit|^Arrow|^Space$/i.test(e.code)) {
      const key = (e.ctrlKey ? 'Ctrl+' : '') + e.code;
      // 防冲突：该键已被其他动作占用时先解除旧绑定
      HOTKEY_ACTIONS.forEach(a => { if (a.id !== recordingHotkey && hotkeyMap[a.id] === key) hotkeyMap[a.id] = ''; });
      hotkeyMap[recordingHotkey] = key;
      saveHotkeys();
      recordingHotkey = null;
      renderHotkeyList(null);
    }
    return;
  }
  if (!hotkeysOn) return;   // 快捷键开关关闭时不响应
  if (e.target.matches('input,select,textarea') || e.target.isContentEditable) return;
  const combo = (e.ctrlKey ? 'Ctrl+' : '') + e.code;
  const action = HOTKEY_ACTIONS.find(a => hotkeyMap[a.id] === combo);
  if (action) { e.preventDefault(); action.run(); }
});
$('#hotkeysReset').onclick = () => { hotkeyMap = defaultHotkeyMap(); saveHotkeys(); renderHotkeyList(null); };
document.body.ondragover = e => e.preventDefault();
document.body.ondrop = e => {
  e.preventDefault();
  const paths = [...e.dataTransfer.files].map(f => window.lightPlayer.pathForFile(f)).filter(Boolean);
  if (paths.length) { playlist = [...new Set([...playlist, ...paths])]; loadFile(paths[0]); renderPlaylist(); savePlaylistState(); }
};
$('#minBtn').onclick = () => window.lightPlayer.minimize();
$('#maxBtn').onclick = () => window.lightPlayer.maximize();
$('#closeBtn').onclick = () => {
  saveProgress(); savePlaylistState();
  // localStorage 落盘是异步的：延迟关闭给 Chromium 提交时间，否则数据可能丢失（重启后视频不恢复的根因）
  setTimeout(() => window.lightPlayer.close(), 120);
};
// 兜底：系统方式关闭（Alt+F4 / 任务栏 / 标题栏右键）不经过 closeBtn，卸载前强制保存
window.addEventListener('beforeunload', () => { saveProgress(); savePlaylistState(); });
