# LightPlayer

现代化本地视频播放器，支持实时语音转字幕。

![icon](build/icon.png)

## 功能

- **视频播放**：MP4 / WebM / MKV 等常见格式，硬件加速可开关
- **实时字幕**：基于 sherpa-onnx（SenseVoice）本地语音识别，边播边转字幕，无需联网；也支持外挂 SRT / VTT / ASS 字幕
- **播放列表**：打开文件或整个文件夹，记住播放进度与列表，下次续播
- **字幕缓存**：识别结果可缓存到视频同名 JSON，二次播放即时加载
- **关闭到托盘**：关闭窗口后台驻留，首次最小化有气泡提示；再次启动唤回窗口，不重复开进程
- **外部打开直接播放**：支持命令行 `LightPlayer.exe "D:\video.mp4"`、资源管理器「打开方式」、把视频拖到 exe 图标或快捷方式附加参数；软件已打开时转给现有窗口，立刻播放并自动加入播放列表
- **深色 / 亮色主题**

## 开发

```bash
npm install
npm start
```

需要 Node.js 18+。语音识别模型首次使用时在应用内下载。

## 打包

```bash
npm run dist
```

## 结构

```
src/main.js     主进程（窗口、托盘、单实例、ASR daemon）
src/preload.js  预加载桥（contextBridge）
src/app.js      渲染层（无框架，单文件）
src/launch-args.js  启动参数解析（命令行 /「打开方式」路径）
src/asr/        语音识别 worker 与模型管理
```

架构细节与踩坑记录见 [CodeWiki.md](CodeWiki.md)。
