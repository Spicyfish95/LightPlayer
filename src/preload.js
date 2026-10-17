const { contextBridge, ipcRenderer, webUtils } = require('electron');
contextBridge.exposeInMainWorld('lightPlayer', {
  openVideo: () => ipcRenderer.invoke('dialog:open-video'),
  openVideoFolder: () => ipcRenderer.invoke('dialog:open-video-folder'),
  openSubtitle: () => ipcRenderer.invoke('dialog:open-subtitle'),
  readCaptionCache: video => ipcRenderer.invoke('captions:read-cache', video),
  clearCaptionCache: video => ipcRenderer.invoke('captions:clear-cache', video),
  clearAllCaptionCaches: videos => ipcRenderer.invoke('captions:clear-all-caches', videos),
  exportSrt: payload => ipcRenderer.invoke('captions:export-srt', payload),
  setHwAccel: enabled => ipcRenderer.invoke('settings:hw-accel', enabled),
  getHwAccel: () => ipcRenderer.invoke('settings:hw-accel', null),
  saveSession: payload => ipcRenderer.invoke('session:save', payload),
  loadSession: () => ipcRenderer.invoke('session:load'),
  startAsr: options => ipcRenderer.invoke('asr:start', options),
  stopAsr: () => ipcRenderer.send('asr:stop'),
  seekAsr: payload => ipcRenderer.send('asr:seek', payload),
  onAsrEvent: callback => ipcRenderer.on('asr:event', (_, data) => callback(data)),
  pathForFile: file => { try { return webUtils.getPathForFile(file); } catch (_) { return file && file.path || ''; } },
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),
  // 主题：系统亮/暗查询 + 变化订阅 + 通知主进程当前模式（同步原生控件配色）
  getSystemTheme: () => ipcRenderer.invoke('theme:system'),
  setThemeMode: mode => ipcRenderer.send('theme:mode', mode),
  onSystemThemeChange: callback => ipcRenderer.on('theme:system-changed', (_, data) => callback(!!(data && data.dark)))
});
