/* LightPlayer 启动参数解析（纯 Node，不依赖 Electron，便于单独测试）
   来源：命令行路径、资源管理器「打开方式」、把文件拖到 exe 图标、快捷方式附加参数、macOS open-file。
   输出只保留真实存在且扩展名受支持的媒体文件绝对路径；其余参数（--switch、目录、非法路径）一律忽略。 */
'use strict';
const path = require('path');
const fs = require('fs');

// 与「打开视频」对话框 / 文件夹扫描共用同一份可播放类型清单（带点，小写）
const MEDIA_EXTENSIONS = ['.mp4', '.mkv', '.webm', '.mov', '.avi', '.m4v', '.mp3', '.wav', '.flac'];
const MEDIA_EXT_SET = new Set(MEDIA_EXTENSIONS);

// file:///C:/a%20b.mp4 → C:/a b.mp4；解析失败返回空串
function fromFileUrl(raw) {
  try {
    let p = decodeURIComponent(new URL(raw).pathname);
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);   // 去掉 Windows 盘符前的斜杠
    return process.platform === 'win32' ? p.replace(/\//g, '\\') : p;   // 统一成反斜杠，避免同一文件出现两种路径写法
  } catch (_) { return ''; }
}

function normalizeMediaPath(raw, baseDir) {
  if (typeof raw !== 'string') return '';
  let p = raw.trim();
  if (!p || p.startsWith('-')) return '';            // Electron/Chromium 开关（--xxx、-psn_xxx）一律忽略
  if (/^file:\/\//i.test(p)) p = fromFileUrl(p);
  if (!p) return '';
  try {
    if (!path.isAbsolute(p)) p = path.resolve(baseDir || process.cwd(), p);   // 相对路径按调用方工作目录解析
    if (!fs.statSync(p).isFile()) return '';          // 目录、不存在的路径、无权限路径
    if (!MEDIA_EXT_SET.has(path.extname(p).toLowerCase())) return '';
    return p;
  } catch (_) { return ''; }
}

/**
 * 从 argv 中挑出媒体文件路径。
 * @param {string[]} argv 完整 argv（含 argv[0]）
 * @param {{packaged?:boolean, defaultApp?:boolean, baseDir?:string}} opts
 *   packaged：打包后为 true（argv[0] 是 exe）；开发模式 false，需再跳过应用目录
 *   defaultApp：Electron 以 `electron .` 启动时为 true
 *   baseDir：相对路径的基准目录（二次启动用 second-instance 的 workingDirectory）
 */
function mediaPathsFromArgv(argv, opts = {}) {
  if (!Array.isArray(argv) || !argv.length) return [];
  const { packaged = true, defaultApp = false, baseDir } = opts;
  // 打包后：[exe, file...]；开发模式：[electron, appDir, file...]
  const rest = argv.slice(packaged ? 1 : (defaultApp ? 2 : 1));
  const out = [];
  const seen = new Set();
  for (const raw of rest) {
    const p = normalizeMediaPath(raw, baseDir);
    if (!p) continue;
    const key = process.platform === 'win32' ? p.toLowerCase() : p;   // Windows 路径大小写不敏感
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

module.exports = { MEDIA_EXTENSIONS, normalizeMediaPath, mediaPathsFromArgv };
