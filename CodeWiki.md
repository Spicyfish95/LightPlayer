# LightPlayer Code Wiki

> 轻量、隐私优先的本地视频播放器，内置 **SenseVoice 实时字幕**（sherpa-onnx / ONNX Runtime，纯 CPU 本机识别，不上传视频，免安装、无需 Python 与独立显卡）。
> 本文档面向开发者，覆盖：整体架构、模块职责、关键类与函数、依赖关系、IPC/数据协议、模型下载、运行与打包方式。

---

## 目录

1. [项目概览](#1-项目概览)
2. [技术栈与依赖关系](#2-技术栈与依赖关系)
3. [整体架构](#3-整体架构)
4. [目录结构](#4-目录结构)
5. [模块职责详解](#5-模块职责详解)
6. [关键类与函数说明](#6-关键类与函数说明)
7. [IPC 与数据协议](#7-ipc-与数据协议)
8. [数据持久化](#8-数据持久化)
9. [模型与 FFmpeg 下载](#9-模型与-ffmpeg-下载)
10. [核心流程](#10-核心流程)
11. [运行方式](#11-运行方式)
12. [打包与发布](#12-打包与发布)
13. [设计要点与踩坑记录](#13-设计要点与踩坑记录)

---

## 1. 项目概览

LightPlayer 是一个基于 **Electron** 的桌面端本地视频/音频播放器。核心特色是**实时字幕（ASR）**：

- 开启字幕后，播放器围绕**当前播放头**动态识别音频并实时显示字幕。
- 识别在**本机**完成：内置 ONNX Runtime + 量化小模型，**不需要 Python、不需要独立显卡/GPU**，普通 CPU 即可实时（实测约 7–15× 播放速度）。
- 识别引擎为 **SenseVoiceSmall INT8**（中/英/粤/日/韩多语种，CTC 非自回归）+ **Silero VAD**（神经语音活动检测、静音切分）。
- 模型与 FFmpeg 在首次使用时通过**公开仓库 URL 直链**按需下载（无需自建服务器），缓存到本机；之后完全离线可用。
- 识别结果缓存在视频同目录（`<视频名>.lightplayer-subs.json`），下次打开直接复用，仅识别缺失部分。

| 项目属性 | 值 |
| --- | --- |
| 名称 / 版本 | `lightplayer` / `1.0.0` |
| 主入口 | `src/main.js`（Electron 主进程） |
| 运行时 | Electron `^33.2.1`（Chromium 130 / Node 20） |
| ASR 引擎 | `sherpa-onnx-node` `^1.13.8`（绑定 `sherpa-onnx-win-x64`，内置 onnxruntime 1.28） |
| 打包工具 | electron-builder `^25.1.8` |
| 目标平台 / 产物 | Windows x64 / portable 免安装 zip |
| 许可证 | MIT |
| 界面语言 | 简体中文 |

### 功能特性

- 本地视频/音频播放（MP4、MKV、WebM、MOV、AVI、M4V、MP3、WAV、FLAC）
- 播放列表管理（按文件夹分组、可折叠、去重）
- 续播记忆（进度 / 播放列表）；「自动开播」（默认关）决定载入后是否起播，「自动定位上次观看位置」（默认开）决定是否跳到上次进度
- 播放后操作（无操作 / 自动连播 / 循环播放）
- 倍速播放（0.5×–3×）、音量记忆（音量按钮位于右侧工具组最左，点击在按钮正上方居中弹出**竖向**滑条子菜单并显示百分比）、硬件加速开关
- 可配置快捷键（录制替换、冲突解除、恢复默认）
- 外部字幕载入（SRT / VTT / ASS / SSA / TXT）、字幕样式自定义、SRT 导出
- SenseVoice 实时字幕（中/英/粤/日/韩，纯 CPU，首用自动下载约 240MB 模型）
- 字幕缓存复用与数据管理（缓存读写在实时字幕弹窗顶部「是否使用缓存」开关控制，默认关闭；可清理进度 / 列表 / 设置 / 缓存）

---

## 2. 技术栈与依赖关系

### 2.1 npm 依赖（`package.json`）

| 依赖 | 类型 | 版本 | 用途 |
| --- | --- | --- | --- |
| `electron` | devDependencies | `^33.2.1` | 桌面运行容器（主进程 / 渲染进程 / utilityProcess） |
| `electron-builder` | devDependencies | `^25.1.8` | 打包为 Windows portable zip |
| `sherpa-onnx-node` | **dependencies** | `^1.13.8` | k2-fsa 官方 Node 绑定，封装 SenseVoice / Silero VAD / readWave 等 API |
| `sherpa-onnx-win-x64` | 可选依赖（随绑定自动安装） | `^1.13.8` | Windows x64 预编译原生模块：`sherpa-onnx.node` + `onnxruntime.dll` + `sherpa-onnx-c-api.dll` |

> 历史版本曾依赖用户自装 Python + PyTorch（CUDA 包约 2.6GB）。现已**完全移除 Python 链路**，改用随包分发的原生 ONNX Runtime（约 22MB），无任何运行期安装步骤。

Electron 内置模块：`app`、`BrowserWindow`、`dialog`、`ipcMain`、`contextBridge`、`ipcRenderer`、`webUtils`、`utilityProcess`；Node 内置模块：`path`、`fs`、`os`、`https`、`http`、`child_process`（`spawn` / `spawnSync`）。

### 2.2 外部运行时（按需自动下载，非 npm）

| 组件 | 用途 | 存放位置 |
| --- | --- | --- |
| SenseVoice INT8 模型 + tokens + Silero VAD（共约 240MB） | 语音识别 / 静音切分 | `%LOCALAPPDATA%\LightPlayer\models\sensevoice-2024-07-17\` |
| ffmpeg / ffprobe（缺失时） | 音频抽取、时长读取 | `%LOCALAPPDATA%\LightPlayer\runtime\ffmpeg\bin\`（PATH 中存在则直接复用） |

### 2.3 依赖关系图

```
LightPlayer（Electron 应用）
├── 主进程 src/main.js
│   ├── 窗口 / 对话框 / IPC / 文件系统
│   └── utilityProcess.fork ──→ ASR Worker（独立 Node 子进程）
│                                ├── src/asr/asr_worker.js  识别流水线（常驻）
│                                ├── src/asr/models.js      模型/FFmpeg 直链下载
│                                └── sherpa-onnx-node
│                                    └── sherpa-onnx-win-x64（onnxruntime.dll 原生）
├── 预加载 src/preload.js（contextBridge → window.lightPlayer）
└── 渲染进程 src/app.js（UI / 播放 / 字幕 / localStorage）
    ├── src/index.html
    └── src/styles.css
```

---

## 3. 整体架构

Electron **三进程模型**，其中 ASR 跑在 Electron 官方的 `utilityProcess`（轻量 Node 子进程，无渲染环境、可加载原生模块）：

- **主进程（main，`main.js`）**：窗口、系统对话框、文件读写、ASR worker 的生命周期与消息转发。
- **渲染进程（renderer，`app.js`）**：浏览器沙箱（`contextIsolation: true`、`nodeIntegration: false`），全部 UI、`<video>` 播放、字幕渲染、localStorage。系统能力一律经 `window.lightPlayer` 走 IPC。
- **预加载脚本（preload，`preload.js`）**：`contextBridge.exposeInMainWorld` 白名单桥接。
- **ASR Worker（utilityProcess，`asr_worker.js`）**：常驻进程，模型只加载一次；负责下载模型、ffmpeg 抽音、VAD 切分、SenseVoice 推理、字幕缓存。与主进程通过 **MessagePort（`postMessage`）** 通信，而非 stdio。

### 3.1 架构图

```mermaid
flowchart LR
  subgraph Renderer["渲染进程 app.js (沙箱)"]
    UI[UI / 播放器 / 字幕]
    LS[(localStorage)]
  end

  subgraph Preload["预加载 preload.js"]
    BR["window.lightPlayer (contextBridge)"]
  end

  subgraph Main["主进程 main.js"]
    WIN[BrowserWindow]
    DLG[dialog]
    FS[fs 文件/缓存]
    PROC["utilityProcess.fork + 消息转发"]
  end

  subgraph Worker["ASR Worker (utilityProcess)"]
    DL["models.js 直链下载"]
    SHERPA["sherpa-onnx-node"]
    VAD[Silero VAD]
    ASR[SenseVoice INT8]
    FFMPEG[ffmpeg / ffprobe]
    CACHE[字幕缓存 json]
  end

  UI <-->|invoke / send| BR
  BR <-->|ipcRenderer| Main
  PROC <-->|parentPort postMessage| Worker
  DL --> SHERPA
  SHERPA --> VAD
  SHERPA --> ASR
  FFMPEG --> SHERPA
```

### 3.2 关键启动与安全配置

- 启动前 `app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')`，支持重启后自动续播。
- 启动前读 `userData/hw-accel.json`，关闭时 `app.disableHardwareAcceleration()`（Chromium GPU 开关必须在 ready 前设置）。
- `BrowserWindow`：`frame: false`（自绘标题栏）、`contextIsolation: true`、`nodeIntegration: false`、预加载 `preload.js`。
- CSP：`default-src 'self' blob: data:; media-src 'self' blob: file:; style-src 'self' 'unsafe-inline'; script-src 'self'`。

---

## 4. 目录结构

```
LightPlayer/
├── package.json            # 元信息、脚本、electron-builder 配置
├── CodeWiki.md             # 本文档
├── build/
│   ├── icon.ico            # Windows 应用图标
│   ├── icon.png            # 界面内图标（标题栏左上角 / 关于弹窗引用）
│   └── after-build.js      # electron-builder 收尾钩子：构建后删除中间产物
└── src/
    ├── main.js             # 主进程（286 行）：窗口/对话框/IPC/ASR worker 管理
    ├── preload.js          # 预加载（22 行）：contextBridge API
    ├── app.js              # 渲染进程（1373 行）：UI/播放/字幕/持久化
    ├── index.html          # 页面骨架（CSP + #app）
    ├── styles.css          # 全部样式（329 行，暗色主题）
    └── asr/
        ├── models.js       # 模型/FFmpeg 清单与 URL 直链下载器（401 行）
        └── asr_worker.js   # ASR 常驻 worker（496 行）：VAD + 推理 + 调度 + 缓存
```

> 开发期可在项目根放置 `models-dev/`（含 `model.int8.onnx`、`tokens.txt`、`silero_vad.onnx`），`resolveModelDir()` 会优先使用它，避免开发时重复下载；该目录在 `.gitignore` 中，不打包、不入库。

---

## 5. 模块职责详解

### 5.1 `src/main.js`（主进程）

1. **启动配置**：自动播放策略、硬件加速 marker。
2. **窗口管理**：无边框窗口、最小化/最大化/关闭。
3. **系统对话框**：打开视频、打开文件夹（递归扫描扩展名并自然序排序）、打开字幕、SRT 保存。
4. **文件系统能力**：`session.json` 落盘、硬件加速 marker、字幕缓存读取/清除（清除前先优雅停止识别会话）、SRT 导出（UTF-8 BOM）。
5. **ASR worker 管理**：`utilityProcess.fork` 常驻 worker；转发 worker 消息为 `asr:event`；管理会话 id、等待会话结束、退出时清理。

关键设计：

- `resolveAsrWorker()`：开发模式返回 `src/asr/asr_worker.js`；打包模式返回 `app.asar.unpacked/src/asr/asr_worker.js`（worker 与原生模块都在 asarUnpack 中）。
- `ensureAsrDaemon(sender)`：懒启动唯一常驻 worker，`stdio: ['ignore','ignore','pipe']`（stderr 用于错误诊断）；监听 `proc.on('message')` 与 `proc.on('exit')`。
- **会话串行化**：每次 `asr:start` 携带自增 `sid`，渲染端据此丢弃旧会话残留事件；停止/切换只影响当前 sid。
- `asr:start` 时由主进程用 `resolveModelDir(app.isPackaged, app.getAppPath(), process.resourcesPath)` 解析模型目录并随消息下发（utilityProcess 内没有 `app` 对象，无法自行解析）。
- 退出：先发 `{cmd:'shutdown'}`，700ms 后 `taskkill /T` 兜底带走 ffmpeg 孙进程。

### 5.2 `src/preload.js`（预加载桥接）

`contextBridge.exposeInMainWorld('lightPlayer', {...})`，全部为薄封装：

- `invoke`：`openVideo`、`openVideoFolder`、`openSubtitle`、`readCaptionCache`、`clearCaptionCache`、`clearAllCaptionCaches`、`exportSrt`、`setHwAccel`、`getHwAccel`、`saveSession`、`loadSession`、`startAsr`。
- `send`：`stopAsr`、`seekAsr`、`minimize`、`maximize`、`close`。
- 事件订阅：`onAsrEvent(callback)`。
- 工具：`pathForFile(file)`（`webUtils.getPathForFile`，回退 `file.path`）。

> 已移除的旧 API：`openModelDirectory`、`startGpuSetup`、`cancelGpuSetup`、`onGpuSetupEvent`。

### 5.3 `src/app.js`（渲染进程）

无框架单文件脚本，以注释分区：

- **图标与模板**：`ICONS` SVG 图标集（标题栏左上角与「关于」不使用 SVG，而是引用 `build/icon.png` 真实图标）；一次性写入主界面与各弹窗（实时字幕 / 字幕样式 / 设置 / 数据管理 / 快捷键 / 关于 / 二次确认）。
- **状态 / 持久化**：`store`（localStorage 包装）、`settings`、进度与列表保存。
- **播放控制 / 播放列表 / 倍速 / 全屏 / 拖放**。
- **字幕**：外部字幕解析、样式、实时字幕事件处理、SRT 导出。
- **实时字幕阶段 UI**：三阶段步骤条（**准备识别模型 → 分析视频音频 → 实时转写**）+ 进度条 + 引擎徽章（固定显示“SenseVoice · CPU”）。
- **数据管理 / 快捷键 / 弹窗 / 自绘窗口按钮**。

实时字幕相关 UI 状态：`asrSid`（当前会话 id）、`STAGES=['model','audio','transcribe']`、`STAGE_LABELS`、`setDeviceBadge`、`updateAsrProgress`、`setAsrUi`、`startAsrRun`、`toggleAsr`、`turnAsrOff`。

### 5.4 `src/asr/models.js`（模型与 FFmpeg 下载管理）

纯 https URL 直链下载器（不依赖 pip / npm / git / 任何安装器）。职责：

- 声明模型清单 `MODEL_FILES`（文件名 + 精确字节数 + 多个直链源）与版本目录 `MODEL_VERSION`。
- `resolveModelDir(...)`：按优先级解析模型目录（环境变量 → 随包内置 → 开发目录 `models-dev` → `%LOCALAPPDATA%` 下载目录）。
- `ensureModels(dir, onEvent, signal)`：校验完整性，缺文件则多源故障转移下载，带断点续传与进度事件。
- `ensureFfmpeg(onEvent)`：优先复用 PATH，否则从公开静态构建直链下载 zip，用系统 `tar` 解压并取出 ffmpeg/ffprobe。
- 详细下载源与策略见[第 9 节](#9-模型与-ffmpeg-下载)。

### 5.5 `src/asr/asr_worker.js`（ASR 常驻 worker）

运行于 utilityProcess，职责：

1. **引擎准备** `ensureEngine()`：FFmpeg 检查 → 模型下载/校验 → 构造 `OfflineRecognizer`（SenseVoice）与 `Vad`（Silero）→ 空音频预热。
2. **VAD 分段** `vadSegments()`：按 512 样本窗口喂入 Silero，输出语音段（自动跳过静音）。
3. **切片识别** `recognizeWav()`：对 16kHz wav 做 VAD，逐语音段 SenseVoice 解码并拼接文本；无语音返回 `null`。
4. **静音切分** `snapToSilence()`：在探测窗口的静音中点切片，避免拦腰截断句子。
5. **转写主循环** `transcribeVideoSession()`：围绕播放头追赶式调度、组批、自适应批大小、缓存加载/写入（移植自旧 Python 实现，业务语义保持一致）。
6. **命令处理**：`parentPort` 接收 `start/stop/seek/pos/shutdown`；事件经 `process.parentPort.postMessage` 回发。

### 5.6 `index.html` 与 `styles.css`

- `index.html`：CSP、`#app` 挂载点、引入样式与脚本。
- `styles.css`：CSS 变量暗色主题，覆盖标题栏、菜单、弹窗、控制条、侧栏列表、字幕面板、ASR 进度（三态步骤条）、设置面板等。

---

## 6. 关键类与函数说明

### 6.1 主进程 `main.js`

| 函数 | 说明 |
| --- | --- |
| `readHwAccel()` | 读 `userData/hw-accel.json`，默认启用硬件加速。 |
| `resolveAsrWorker()` | 返回 worker 路径（开发源码 / 打包后的 app.asar.unpacked）。 |
| `killProcessTree(proc)` | Windows 下 `taskkill /F /T` 结束进程树（带走 ffmpeg 孙进程）。 |
| `ensureAsrDaemon(sender)` | 懒启动唯一常驻 utilityProcess，绑定 message/exit 转发。 |
| `asrSend(obj)` | `asrProcess.postMessage(obj)`。 |
| `asrStopSession()` / `waitSidSettled(sid)` | 停止当前会话并等待其落盘（清缓存前调用，9s 超时兜底）。 |
| `shutdownAsrDaemon()` | 发 shutdown，超时强杀进程树。 |
| `ipcMain.handle('asr:start')` | fork（如需）→ 分配 sid → 下发 `{cmd:'start', video, modelDir, duration, start, chunk}`。 |

### 6.2 渲染进程 `app.js`（分组摘录）

| 名称 | 说明 |
| --- | --- |
| `store.get/set/del` | localStorage 包装（前缀 `lightplayer-`，JSON，异常安全）。 |
| `saveProgress/loadProgress` | 进度记忆（3s 节流；读取忽略片头片尾 5s）。 |
| `savePlaylistState()` | 列表双写 localStorage + 主进程 `session:save`。 |
| `displayCurrentCaption()` | 按时间命中字幕显示；`subsDirty` 延迟排序。 |
| `parseSub/toSrtTime` | 外部字幕解析、SRT 时间格式化。 |
| `applyCaptionStyle/captionScale/syncCaptionFontSize` | 字幕样式应用；字号按播放区高度相对基准 `CAPTION_REF_H=800` 缩放（夹在 0.5–2.5），`ResizeObserver` 监听 `#videoWrap`，保证小窗口与全屏下字幕视觉大小一致。 |
| `positionFloatingPopover(pop, anchor, align)` | 统一弹窗定位：默认右缘对齐按钮右缘，`align='center'` 时相对按钮水平居中（音量弹窗）；优先显示在按钮上方，空间不足转下方，并夹在视口内。 |
| `buildGroups/renderPlaylist/loadFile/fileUrl` | 列表分组渲染、文件载入、`file:///` URL 构造、自动播放静音回退。 |
| `startAsrRun/toggleAsr/turnAsrOff` | 启动（等元数据→`startAsr`）、开关、关闭复位。 |
| `updateAsrProgress/setStepState/setDeviceBadge/setAsrUi` | 阶段/进度/徽章/开关 UI。 |
| `onAsrEvent` | 处理 `status/captions/caption/stopped/error/done/exit`，按 sid 过滤。 |
| `syncAsrPosition` | 每 2.5s 与 seek/暂停时把 `{start,rate,seek?}` 同步给 worker。 |

### 6.3 worker `asr_worker.js`

| 名称 | 说明 |
| --- | --- |
| `emit(obj)` | `process.parentPort.postMessage`（无 sid 的进程级事件）。 |
| `class SessionControl` | 单会话控制柄：`sid/alive/stopping/abort/pendingSeek/playhead`；`shouldStop()`、`requestStop()`、`kill()`、`emit()`（会话级，失效后静默并自动带 sid）。 |
| `markCompleted/nextUncovered/coverageSeconds/coveredLimit` | 已覆盖区间的合并与查询（含静音段，保证不重复识别）。 |
| `extract/probeDuration/runProcess` | ffmpeg 抽取 16k 单声道 PCM、ffprobe 读时长。 |
| `ensureEngine(control, modelDir)` | 准备 FFmpeg + 模型，构造并预热识别器/VAD。 |
| `vadSegments(samples, reset)` | Silero VAD 分段（必须 512 样本/窗口喂入）。 |
| `recognizeWav(wavPath)` | VAD 去静音 → 逐段 SenseVoice 解码 → 拼接。 |
| `snapToSilence(wavPath,...)` | 探测窗口内基于 VAD 静音区间找切片边界。 |
| `transcribeVideoSession(cfg, ff, control)` | 主循环：缓存恢复、追赶调度、组批、自适应批量、写缓存。 |
| `saveCache(force)` | 原子写 v2 缓存（`.tmp` + rename，10s 节流）。 |

### 6.4 下载器 `models.js`

| 名称 | 说明 |
| --- | --- |
| `MODEL_VERSION` / `MODEL_FILES` | 版本目录名与文件清单（名称、字节数、URL 列表）。 |
| `resolveModelDir(isPackaged, appPath, resourcesPath)` | 模型目录解析（环境变量/内置/开发目录/下载目录）。 |
| `modelsReady(dir)` | 三个文件字节数全部匹配才算就绪。 |
| `requestUrl(url, opts)` | https.get 封装：浏览器 UA、自动跟随重定向（≤8 次）、socket 30s 超时、非 2xx 立即失败。 |
| `downloadOne(url, dest, size, onProgress, signal)` | 单文件下载：Range 断点续传（`.part`）、206 追加/200 重下、字节校验、近 5s 滑动测速。 |
| `downloadFile(file, dir, ...)` | 多源顺序故障转移，聚合并抛出每个源的错误。 |
| `ensureModels(dir, onEvent, signal)` | 整体模型准备（0–100% 进度）。 |
| `ensureFfmpeg(onEvent)` / `ffmpegSources()` / `downloadToFile()` | FFmpeg 多源下载与 `tar` 解压。 |

---

## 7. IPC 与数据协议

### 7.1 渲染进程 ↔ 主进程

| 通道 | 类型 | 载荷 / 返回 |
| --- | --- | --- |
| `dialog:open-video` / `dialog:open-video-folder` / `dialog:open-subtitle` | invoke | 文件/文件夹/字幕选择 |
| `captions:read-cache` | invoke | 入参视频路径，返回字幕数组或 `null`（兼容 v1/v2） |
| `captions:clear-cache` / `captions:clear-all-caches` | invoke | 删除缓存（先停识别会话） |
| `captions:export-srt` | invoke | `{video, srt}` → `{ok, path}` / `{ok:false,message}` |
| `settings:hw-accel` | invoke | 读/写硬件加速 marker |
| `session:save` / `session:load` | invoke | 播放列表会话落盘/读取 |
| `asr:start` | invoke | 入参 `{video, duration, start, chunk?}`；返回 `{ok, sid}`。**modelDir 由主进程解析，渲染端不再传模型路径/设备** |
| `asr:stop` | send | 停止当前会话（常驻 worker 与模型保留） |
| `asr:seek` | send | `{start, rate, seek?}` |
| `window:minimize/maximize/close` | send | 窗口控制 |
| `asr:event` | send（M→R） | worker 事件转发 |

### 7.2 主进程 ↔ ASR Worker（utilityProcess MessagePort）

> 不再是 stdio JSON 行，而是 `postMessage`。worker 收到的是 **MessageEvent，真正的消息在 `e.data`**。

**主进程 → Worker（`postMessage`）**

```jsonc
{ "cmd": "start", "sid": 1, "video": "C:/.../x.mp4", "modelDir": "...", "duration": 0, "start": 12.5, "chunk": 4 }
{ "cmd": "stop",  "sid": 1 }
{ "cmd": "seek",  "sid": 1, "start": 30.0, "rate": 1.0 }   // 用户跳转
{ "cmd": "pos",   "sid": 1, "start": 30.2, "rate": 1.0 }   // 常规位置同步
{ "cmd": "shutdown" }
```

**Worker → 主进程（均带会话 `sid`）**

| kind | 关键字段 | 含义 |
| --- | --- | --- |
| `status` | `stage`(**model/audio/transcribe/display**)、`message`、`percent`、`device?` | 阶段与进度（首用下载模型时 stage=`model`，percent 5–14 为下载） |
| `caption` | `start`,`end`,`text` | 单条实时字幕 |
| `captions` | `items:[{start,end,text}]` | 缓存恢复批量字幕 |
| `stopped` | — | 用户停止，会话线程已落盘退出 |
| `done` | — | 全部识别完成 |
| `error` | `message` | 错误（含下载失败的多源聚合原因） |

进程级 `exit` 事件由主进程在 `proc.on('exit')` 时合成下发（`{kind:'exit', code, sid, detail}`，detail 取 stderr 尾部）。

### 7.3 渲染端事件处理（`onAsrEvent`）

按 `sid` 过滤旧会话；`status` 更新三阶段步骤/进度/徽章；`captions` 批量入列；`caption` 去重入库；`stopped` 仅停计时；`error/exit` 复位开关并展示原因；`done` 全部置完成。

---

## 8. 数据持久化

### 8.1 localStorage（前缀 `lightplayer-`）

| 键 | 内容 |
| --- | --- |
| `lightplayer-volume` | `{v, m}` 音量/静音 |
| `lightplayer-speed` | 倍速 |
| `lightplayer-playlist` | `{files:[...], active}` |
| `lightplayer-progress-<file>` | `{t, d}` 播放进度 |
| `lightplayer-resume-play` / `lightplayer-keep-playlist` | 自动续播 / 记住列表开关 |
| `lightplayer-auto-play` | 自动开播开关（默认 `false`：载入视频后不自动播放） |
| `lightplayer-auto-resume` | 自动定位上次观看位置开关（默认 `true`：定位到上次进度，是否起播由自动开播决定） |
| `lightplayer-asr-cache` | 是否使用缓存开关（默认 `false`：实时字幕不读也不写视频同目录缓存） |
| `lightplayer-after-play` | `none/next/loop` |
| `lightplayer-hw-accel` | 硬件加速开关 |
| `lightplayer-hotkeys` | 快捷键映射 |
| `lightplayer-caption-style` | 字幕样式对象 |
| `lightplayer-caption-visible` / `lightplayer-asr-enabled` | 字幕显示 / 实时字幕开关 |

> 已移除旧键：`lightplayer-model-path`（模型改自动下载）、`lightplayer-device`（无 GPU 选项）。

### 8.2 主进程 / 外部运行时落盘

| 路径 | 内容 |
| --- | --- |
| `userData/session.json` | 播放列表同步落盘 |
| `userData/hw-accel.json` | `{enabled}` 硬件加速 marker |
| `%LOCALAPPDATA%\LightPlayer\models\sensevoice-2024-07-17\` | 识别模型三件套（+ `.part` 下载临时分片） |
| `%LOCALAPPDATA%\LightPlayer\runtime\ffmpeg\bin\` | 自动下载的 ffmpeg/ffprobe（PATH 已有则不落盘） |
| `<视频名>.lightplayer-subs.json` | 视频同目录字幕缓存 |

字幕缓存 v2 格式：

```jsonc
{
  "version": 2,
  "captions": [ { "start": 0.0, "end": 4.0, "text": "…" } ],
  "covered":  [ [0.0, 4.0] ]   // 已覆盖区间（含静音段），杜绝重复识别
}
```

---

## 9. 模型与 FFmpeg 下载

全部为**公开仓库 URL 直链**（无需自建服务器）。源在编码前逐一实测过文件存在、字节数、Range 支持，顺序按“国内 CDN 优先、官方兜底”。

### 9.1 模型清单（`MODEL_FILES`）

| 文件 | 字节数 | 直链源（顺序故障转移） |
| --- | --- | --- |
| `model.int8.onnx` | 239233841（约 228MB） | ① 魔搭 ModelScope 镜像 `fengge2024/sherpa-onnx-sense-voice-...`（302 到 `cdn-lfs-cn-*.modelscope.cn`，实测 40–52MB/s）② ModelScope resolve 备用域名 ③ HuggingFace 官方 `csukuangfj/sherpa-onnx-sense-voice-...`（兜底） |
| `tokens.txt` | 315894 | 同上 |
| `silero_vad.onnx` | 643854 | ① GitHub Releases `k2-fsa/sherpa-onnx`（asr-models）②③④ ghfast.top / ghproxy.net / gh-proxy.com 代理前缀 |

> 已弃用 hf-mirror.com：实测它对所有 `/resolve/` 请求 **308 回 huggingface.co**，不提供实际镜像，国内反而连不通。

### 9.2 FFmpeg（`ffmpegSources()`）

PATH 中找不到 ffmpeg 时按序下载 zip：① `www.gyan.dev` release-essentials（约 109MB，静态）→ ②③④ GitHub 代理前缀 + BtbN `ffmpeg-master-latest-win64-gpl.zip`（约 191MB，静态）→ ⑤ GitHub 直连。下载后用 Windows 自带 `tar -xf` 解压，递归取出 bin 下的 `ffmpeg.exe`/`ffprobe.exe`。

### 9.3 下载机制要点

- 统一浏览器 UA（`Mozilla/5.0 ... Chrome/130 ...`）：**ModelScope WAF 对无 UA 请求返回 403**。
- 自动跟随重定向；socket 级 30s 超时（慢而不断不杀，停滞才切源）。
- `.part` 分片 + `Range` 断点续传：206 追加、200 重下；跨源续传；`.part` 大于目标则丢弃。
- 模型按精确字节数校验；FFmpeg zip 靠 `tar` 解压完整性校验（文件大小随版本变化不固定）。
- 进度经 `status(stage=model, percent=5..14)` 实时上报，含已下载/总量与近 5s 滑动速度。
- 所有源失败时聚合错误（`host: 原因 | ...`）通过 `error` 事件显示，便于定位。
- `AbortController` 支持取消（会话被停止/替换时中断下载）。

---

## 10. 核心流程

### 10.1 启动与会话恢复

读硬件加速 marker → 建窗 → 恢复音量/倍速 →（记住列表时）优先读 `session.json` 回退 localStorage，恢复列表与上次视频并按开关自动续播。

### 10.2 打开/切换视频

对话框/拖放得到路径去重入列表 → `loadFile` 停止在跑识别并重置 ASR UI → 设置 `video.src` → `loadedmetadata` 由「自动定位上次观看位置」决定是否跳到上次进度、由「自动开播」决定是否起播（默认关闭；被浏览器策略拦截则静音启动再恢复音量）→ 仅当「是否使用缓存」开启时读字幕缓存显示 → 若字幕开关偏好开启则自动启动识别（并透传 `cache` 开关：渲染端→preload→主进程 `asr:start`→worker start 消息；主进程构造 worker 消息时必须显式带上 `cache: options.cache !== false`，否则 worker 收到 `undefined` 会按开启处理，这正是开关关闭仍生成缓存文件的历史根因）。

### 10.3 实时字幕流水线

```mermaid
sequenceDiagram
  participant R as 渲染进程
  participant M as 主进程
  participant W as ASR Worker (utilityProcess)

  R->>M: asr:start {video, duration, start}
  M->>W: fork（首次） + postMessage start{..., modelDir}
  W-->>M: status(model) 检查 FFmpeg / 下载模型(首用) / 加载预热
  W-->>M: status(audio) 读时长、开始分析
  loop 识别主循环
    R->>M: asr:seek {start, rate}
    M->>W: postMessage seek/pos
    W->>W: ffmpeg 抽 16k 片段 → Silero VAD 切句 → SenseVoice 解码
    W-->>M: caption / status(transcribe, 速度 N×)
    M-->>R: asr:event
  end
  W-->>M: status(display) + done
  M-->>R: asr:event(done)
```

主循环要点（与旧 Python 版业务语义一致）：

- 按**播放头 + 倍速 + 时间戳**预测当前所需位置 `desired`。
- **追赶式调度**：落后超过 `behind`（≈4s）跳回播放头；领先超过 `ahead`（30s）回头补空洞；seek 时从最近未覆盖位置继续。
- **组批**：围绕播放头组装片段，`lead`（12s）窗口保证首批字幕尽快到达；首批只取 1 段。
- **VAD 切句**：对长片段先抽探测窗口，用神经 VAD 在目标时长附近静音处切片，并用 `writeWave` 从探测 wav 直接切出，避免二次调用 ffmpeg。
- **自适应批大小**：按识别速度 EMA 在 2–6 间调整（<0.95× 加大、>1.8× 减小）。
- 纯 CPU、单一引擎，不再有 GPU+CPU 双模型并行逻辑。
- 缓存 10s 节流写，收尾/停止时 `force` 落盘；`saveCache()` 在 `cfg.cache === false`（渲染端「是否使用缓存」关闭）时直接跳过写入（连 `.tmp` 临时文件也不产生），同时主循环也不再读取已有缓存（既不读也不写）。

---

## 11. 运行方式

### 11.1 环境要求

- Node.js（安装/运行 electron 与 electron-builder）。
- **终端用户无需安装 Python、无需独立显卡、无需手动选择模型目录**。
- 首次开启字幕需联网（下载约 240MB 模型与可能缺失的 ffmpeg），之后离线可用。

### 11.2 安装与启动

```bash
cd d:\AIWorkSpace\LightPlayer
npm install          # 会自动安装 sherpa-onnx-node 及 win-x64 原生包
npm start            # = electron . （等价 npm run dev）
```

> 开发期把模型三件套放到项目根 `models-dev/` 可跳过下载（见[第 4 节](#4-目录结构)）。

### 11.3 脚本

| 脚本 | 命令 | 说明 |
| --- | --- | --- |
| `start` / `dev` | `electron .` | 启动应用 |
| `dist:win` / `dist` | `electron-builder --win zip` | 打包 Windows 免安装 zip |

---

## 12. 打包与发布

`package.json` → `build`：

| 项 | 值 |
| --- | --- |
| `appId` / `productName` | `com.lightplayer.desktop` / `LightPlayer` |
| `npmRebuild` | `false`（sherpa-onnx 为预编译二进制，禁止 electron-builder 尝试本地重编译） |
| `directories.output` | `dist` |
| `files` | `src/**/*`、`build/icon.ico`、`build/icon.png`（png 供界面内引用）、`package.json` |
| `asarUnpack` | `src/asr/**`、`node_modules/sherpa-onnx-node/**`、`node_modules/sherpa-onnx-win-x64/**`（worker 脚本与 `.node`/`.dll` 必须以真实文件存在，不能进 asar） |
| `afterAllArtifactBuild` | `build/after-build.js`：压缩包生成后删除中间产物 `win-unpacked/` 与 `builder-debug.yml`，使 `dist/` 只留最终压缩包 |
| `win.icon` | `build/icon.ico`（自定义图标，非 Electron 默认） |
| `win.target` | 仅 `zip` / `x64` |
| `win.artifactName` | `LightPlayer-${version}-win-${arch}-portable.zip` |

打包命令与注意：

```powershell
$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"   # zip 免安装包不做代码签名，跳过 signtool/winCodeSign 签名流程
npx electron-builder --win zip
```

- 产物：`dist/LightPlayer-1.0.0-win-x64-portable.zip`（约 114MB；解压即用）。**`dist/` 下只有这一个文件**——`win-unpacked/`（zip 的来源目录）与 `builder-debug.yml`（electron-builder 的 DebugLogger 默认写出，无配置项可关闭）都由 `build/after-build.js` 在构建收尾时删除。
- 随包关键路径：`LightPlayer.exe`、`resources/app.asar`、`resources/app.asar.unpacked/src/asr/*.js`、`resources/app.asar.unpacked/node_modules/sherpa-onnx-win-x64/{sherpa-onnx.node,onnxruntime.dll,...}`。
- 若某次构建需要保留免安装目录（直接跑 `win-unpacked/LightPlayer.exe` 调试），把 `package.json` 里的 `afterAllArtifactBuild` 临时去掉再打包即可。
- 模型不进安装包（首用下载）；如需做完全离线发行版，把模型放到 `resources/models/sensevoice-2024-07-17/`，`resolveModelDir()` 会自动识别。

---

## 13. 设计要点与踩坑记录

1. **安全边界**：渲染进程沙箱化（`contextIsolation`、无 `nodeIntegration`）+ CSP；系统能力仅经 `window.lightPlayer` 白名单。
2. **重负载隔离在 utilityProcess**：模型加载/推理在独立常驻子进程，不阻塞主进程与 UI；模型只加载一次，开关/切换字幕零冷启动。
3. **utilityProcess 与普通进程的差异（重要）**：
   - worker 内 `require('electron')` 只暴露 `net`/`systemPreferences`，**没有 `app`**——模型目录等环境信息必须由主进程在 `start` 消息中传入。
   - 收到的消息是 `MessageEvent`，业务对象在 **`e.data`**，不能直接当命令对象用。
4. **Electron 禁 N-API external buffer**：Electron ≥21 下 sherpa-onnx 的 `readWave(path, false)`、`vad.front(false)`（以及 CircularBuffer.get）必须传 `enableExternalBuffer=false`，否则报 `External buffers are not allowed`。
5. **Electron fs flags 白名单不含 `'b'`**：`fs.createWriteStream({flags:'wb'})` 会抛 `The argument 'flags' is invalid. Received 'wb'`；下载落盘用 `'w'`/`'a'`（Windows 下无文本/二进制差异）。
6. **Silero VAD 的喂入方式**：必须按 `windowSize=512` 样本（32ms@16k）逐窗口 `acceptWaveform`，整段一次性喂入会只吐出尾部残段。
7. **下载源必须实测**：hf-mirror 对 resolve 全部 308 回源（无镜像价值）；ModelScope 无浏览器 UA 返回 403；GitHub 大文件需代理兜底。错误按源聚合上报，避免笼统的“识别失败”。
8. **断点续识别**：`covered` 区间（含静音段）+ v2 缓存保证识别过的音频不重复处理，seek/重开仅识别空洞。
9. **围绕播放头调度**：优先贴近播放头出字幕，支持倍速预测与跳转跟随；批大小按吞吐自适应。
10. **会话隔离防串流**：自增 `sid` + `alive/stopping` 双标记；新会话 kill 旧会话，旧会话事件自动静默；停止只置 `stopping` 以便回发 `stopped` 解除主进程等待。
11. **数据落盘双保险**：localStorage（渲染）+ `session.json`（主进程同步写），并在关闭/`before-quit` 强制保存。
12. **清缓存前先停识别**：worker 会周期性重写缓存，`clear-cache` 先 `asrStopSession()` 等待落盘并加重试删除。
13. **字幕排序优化**：批量入列用 `subsDirty` 延迟到显示前统一排序，避免逐条 O(n²)。
14. **弹窗统一用 `position:fixed` + `getBoundingClientRect` 定位**：不再用 `right/bottom` 硬编码（倍速菜单曾因此与按钮错位）；`#speedMenu/#fsSpeedMenu`、`#subPopover`、`#volPopover/#fsVolPopover` 都由 `positionFloatingPopover()` 贴着触发按钮计算，滚动/缩放窗口时会随全屏切换重算。
15. **点击外部关闭要用捕获阶段**：工具按钮的 `onclick` 普遍 `e.stopPropagation()`（避免触发展开态被立刻关掉），冒泡阶段的 document 监听收不到事件，导致「打开音量弹窗后点其他按钮不关闭」。现改为 `document.addEventListener('click', handler, true)`，并跳过 `#mute/#fsMute/#volPopover/#fsVolPopover` 内部点击。
16. **字幕字号随视窗缩放**：固定 px 会让小窗口字幕显得过大、全屏显得过小；现按 `播放区高度 / 800` 缩放基础字号（0.5–2.5 夹取），配合 `em` 单位的内边距/圆角使字幕底衬等比放大。
17. **界面内图标必须打包**：`build/icon.png` 需列入 `build.files` 才会进 asar；渲染层用相对路径 `../build/icon.png`（页面为 `src/index.html`，解析到 asar 根 `build/icon.png`），CSP 的 `default-src 'self'` 已覆盖 `img-src`。

---

*本文档基于仓库当前源码（LightPlayer v1.0.0，sherpa-onnx 架构）整理；源码变更时请同步更新对应章节。*
