import argparse
import importlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import types
import urllib.request
import zipfile

os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")
os.environ.setdefault("CUDA_MODULE_LOADING", "LAZY")
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS", "1")
os.environ.setdefault("PYTORCH_JIT", "0")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")


def emit(kind, **data):
    print(json.dumps({"kind": kind, **data}, ensure_ascii=False), flush=True)


class AsrState:
    """播放器位置与跳转请求的共享状态，由 stdin 线程写入、转写循环读取。"""

    def __init__(self):
        self.lock = threading.Lock()
        self.pending_seek = None          # 用户 seek 后待处理的目标位置（秒）
        self.playhead = (0.0, 1.0, time.monotonic())  # (位置, 倍速, 接收时间)


def stdin_reader(state):
    """逐行读取主进程发来的 JSON 命令：seek（跳转）/ pos（位置同步）。"""
    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            try:
                pos = max(0.0, float(msg.get("start", 0.0)))
                rate = max(0.0, float(msg.get("rate", 1.0)))
            except (TypeError, ValueError):
                continue
            with state.lock:
                state.playhead = (pos, rate, time.monotonic())
                if msg.get("cmd") == "seek":
                    state.pending_seek = pos
    except Exception:
        pass


def mark_completed(intervals, start, end):
    """记录已转写区间并合并相邻项。"""
    intervals.append((start, end))
    intervals.sort()
    merged = []
    for a, b in intervals:
        if merged and a <= merged[-1][1] + 0.01:
            merged[-1] = (merged[-1][0], max(merged[-1][1], b))
        else:
            merged.append((a, b))
    intervals[:] = merged


def next_uncovered(intervals, pos):
    """返回 >= pos 且尚未转写的最早位置。"""
    for a, b in intervals:
        if pos < a - 0.01:
            return pos
        if pos <= b + 0.01:
            pos = b
    return pos


def coverage_seconds(intervals):
    return sum(b - a for a, b in intervals)


def covered_limit(intervals, pos):
    """返回 pos 之后最近的已覆盖区间起点；无则 None。"""
    best = None
    for a, b in intervals:
        if a > pos + 0.01 and (best is None or a < best):
            best = a
    return best


def load_pcm(path):
    import array
    import wave
    with wave.open(path, "rb") as handle:
        rate = handle.getframerate()
        samples = array.array("h")
        samples.frombytes(handle.readframes(handle.getnframes()))
    return rate, samples


def frame_rms(samples, rate, frame_ms=20):
    """按 20ms 帧计算 RMS 能量。"""
    import math
    step = max(1, int(rate * frame_ms / 1000))
    frames = []
    for i in range(0, len(samples), step):
        seg = samples[i:i + step]
        if not seg:
            break
        acc = 0
        for v in seg:
            acc += v * v
        frames.append(math.sqrt(acc / len(seg)))
    return frames, step


def snap_to_silence(path, target_s, min_s, max_s):
    """在探测窗口的 [min_s, max_s] 内寻找最接近 target_s 的静音中点，
    返回切片时长（秒）；找不到合适静音则返回 None。"""
    try:
        rate, samples = load_pcm(path)
    except Exception:
        return None
    if not samples:
        return None
    frames, step = frame_rms(samples, rate)
    if not frames:
        return None
    peak = max(frames)
    threshold = max(peak * 0.04, 25.0)
    frame_s = step / rate
    runs = []
    run_start = None
    for idx, energy in enumerate(frames):
        silent = energy <= threshold
        if silent and run_start is None:
            run_start = idx
        elif not silent and run_start is not None:
            runs.append((run_start, idx - 1))
            run_start = None
    if run_start is not None:
        runs.append((run_start, len(frames) - 1))
    min_frames = max(1, int(0.12 / frame_s))  # 静音至少 120ms 才算有效停顿
    best = None
    for a, b in runs:
        if b - a + 1 < min_frames:
            continue
        center = (a + b) / 2.0 * frame_s
        if center < min_s or center > max_s:
            continue
        if best is None or abs(center - target_s) < abs(best - target_s):
            best = center
    return best


def slice_wav(path, out_path, seconds):
    """把探测 WAV 截取前 seconds 秒，避免二次调用 FFmpeg。"""
    import wave
    with wave.open(path, "rb") as src:
        rate = src.getframerate()
        frames = src.readframes(int(seconds * rate))
        with wave.open(out_path, "wb") as dst:
            dst.setnchannels(1)
            dst.setsampwidth(2)
            dst.setframerate(rate)
            dst.writeframes(frames)


def duration(path, ffmpeg_hint=None):
    """读取媒体时长。优先 PATH 中的 ffprobe；找不到时使用随 ensure_ffmpeg 下载的 ffprobe。"""
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        # 与 ensure_ffmpeg 相同的下载目录：bin/ffprobe(.exe)
        root = os.path.join(os.environ.get("LOCALAPPDATA", tempfile.gettempdir()), "LightPlayer", "runtime", "ffmpeg", "bin")
        candidate = os.path.join(root, "ffprobe.exe" if os.name == "nt" else "ffprobe")
        if os.path.isfile(candidate):
            ffprobe = candidate
        elif ffmpeg_hint:
            sibling = os.path.join(os.path.dirname(ffmpeg_hint), "ffprobe.exe" if os.name == "nt" else "ffprobe")
            if os.path.isfile(sibling):
                ffprobe = sibling
    if not ffprobe:
        ffprobe = "ffprobe"
    try:
        out = subprocess.check_output([ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path], text=True)
        return float(out.strip())
    except FileNotFoundError:
        emit("error", message="找不到 ffprobe。请安装 FFmpeg，并将 ffmpeg 和 ffprobe 加入 PATH。")
        return 0.0
    except Exception as exc:
        emit("error", message="无法读取视频时长：" + str(exc))
        return 0.0


def ensure_ffmpeg():
    found = shutil.which("ffmpeg")
    if found:
        return found
    if os.name != "nt":
        return "ffmpeg"
    root = os.path.join(os.environ.get("LOCALAPPDATA", tempfile.gettempdir()), "LightPlayer", "runtime", "ffmpeg")
    bin_dir = os.path.join(root, "bin")
    ffmpeg_exe = os.path.join(bin_dir, "ffmpeg.exe")
    if not os.path.isfile(ffmpeg_exe):
        os.makedirs(bin_dir, exist_ok=True)
        archive = os.path.join(root, "ffmpeg-release-essentials.zip")
        url = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
        emit("status", stage="dependency", message="未找到 FFmpeg，正在自动下载 FFmpeg · 0%", percent=10)
        with urllib.request.urlopen(url, timeout=30) as response, open(archive, "wb") as out:
            total_size = int(response.headers.get("Content-Length", "0"))
            received = 0
            while True:
                chunk = response.read(1024 * 256)
                if not chunk:
                    break
                out.write(chunk); received += len(chunk)
                pct = int(received * 100 / total_size) if total_size else 0
                emit("status", stage="dependency", message=f"正在下载 FFmpeg · {pct}%", percent=10 + min(9, int(pct * 0.09)))
        extract_dir = os.path.join(root, "extract")
        shutil.rmtree(extract_dir, ignore_errors=True)
        with zipfile.ZipFile(archive) as z:
            z.extractall(extract_dir)
        from pathlib import Path as FilePath
        source = next(iter(FilePath(extract_dir).rglob("ffmpeg.exe")), None)
        source_probe = next(iter(FilePath(extract_dir).rglob("ffprobe.exe")), None)
        if source is None:
            raise FileNotFoundError("下载的 FFmpeg 压缩包中没有 ffmpeg.exe")
        shutil.copy2(source, ffmpeg_exe)
        if source_probe:
            shutil.copy2(source_probe, os.path.join(bin_dir, "ffprobe.exe"))
    return ffmpeg_exe


def extract(ffmpeg, source, target, start, seconds):
    cmd = [ffmpeg, "-hide_banner", "-loglevel", "error", "-threads", "0", "-y", "-ss", str(start), "-t", str(seconds), "-i", source, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", target]
    subprocess.run(cmd, check=True)


def run_pip_with_progress(command, label, network=True, idle_timeout=60, pbase=4, pspan=0.06):
    """运行 pip 命令并把进度映射到依赖阶段的 [pbase, pbase+100*pspan] 区间。"""
    import queue
    output = ""
    chunks = queue.Queue()

    def reader():
        while True:
            chunk = proc.stdout.read(256)
            chunks.put(chunk)
            if not chunk:
                break

    proc = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, bufsize=0)
    thread = threading.Thread(target=reader, daemon=True)
    thread.start()
    started = time.monotonic()
    last_report = started
    no_data_since = started
    while thread.is_alive() or not chunks.empty():
        try:
            chunk = chunks.get(timeout=0.5)
        except queue.Empty:
            chunk = None
        if chunk is None:
            if time.monotonic() - no_data_since >= idle_timeout and proc.poll() is None:
                if network:
                    emit("status", stage="dependency", message=f"{label}连接超时，正在切换下载源", percent=pbase)
                else:
                    emit("status", stage="dependency", message=f"{label}本地安装超时", percent=pbase)
                proc.terminate()
                try:
                    proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
                return 124, output
            if time.monotonic() - last_report >= 2:
                elapsed = int(time.monotonic() - started)
                if network:
                    emit("status", stage="dependency", message=f"{label}（正在连接/解析下载源，0%，已等待 {elapsed} 秒）", percent=pbase)
                else:
                    emit("status", stage="dependency", message=f"{label}（正在本地解包/安装，已等待 {elapsed} 秒）", percent=pbase)
                last_report = time.monotonic()
            continue
        if not chunk:
            break
        no_data_since = time.monotonic()
        text = chunk.decode("utf-8", errors="replace")
        output += text
        matches = re.findall(r"(\d{1,3})%", text)
        if matches:
            pct = min(99, max(0, int(matches[-1])))
            emit("status", stage="dependency", message=f"{label} · {pct}%", percent=pbase + int(pct * pspan))
        else:
            clean = text.replace("\r", " ").replace("\n", " ").strip()
            if clean:
                emit("status", stage="dependency", message=clean[-180:], percent=pbase + 1)
            last_report = time.monotonic()
    code = proc.wait()
    return code, output


def install_packages(packages):
    emit("status", stage="dependency", message="检测到缺少 ASR 依赖，正在自动安装：" + ", ".join(packages), percent=4)
    base = [sys.executable, "-m", "pip", "install", "--no-input", "--disable-pip-version-check", "--timeout", "10", "--retries", "1", "--prefer-binary", "--progress-bar", "raw"]
    sources = [("清华 PyPI 镜像", "https://pypi.tuna.tsinghua.edu.cn/simple"), ("阿里云 PyPI 镜像", "https://mirrors.aliyun.com/pypi/simple/"), ("中科大 PyPI 镜像", "https://pypi.mirrors.ustc.edu.cn/simple"), ("官方 PyPI", "https://pypi.org/simple")]
    if os.name != "nt":
        sources = [("官方 PyPI", "https://pypi.org/simple")]
    code = 1
    output = ""
    command = base + ["--index-url", sources[0][1], *packages]
    for index, (source_name, source_url) in enumerate(sources):
        if index:
            emit("status", stage="dependency", message=f"{sources[0][0]}连接失败，正在切换{source_name}", percent=4)
        command = base + ["--index-url", source_url, *packages]
        code, chunk_output = run_pip_with_progress(command, f"正在从{source_name}下载/安装 ASR 依赖")
        output += chunk_output
        if code == 0:
            break
    if code != 0:
        raise subprocess.CalledProcessError(code, command, output=output)
    emit("status", stage="dependency", message="ASR 依赖安装完成", percent=10)


def detect_nvidia_gpu():
    """检测 NVIDIA GPU 型号；找不到返回 None。不依赖 torch。"""
    # nvidia-smi：优先 PATH，再试常见安装路径（部分机器 PATH 里没有它）
    candidates = ["nvidia-smi"]
    if os.name == "nt":
        candidates += [r"C:\Windows\System32\nvidia-smi.exe",
                       os.path.join(os.environ.get("ProgramFiles", r"C:\Program Files"), "NVIDIA Corporation\\NVSMI\\nvidia-smi.exe")]
    for exe in candidates:
        try:
            out = subprocess.check_output([exe, "--query-gpu=name", "--format=csv,noheader"],
                                          text=True, timeout=15, stderr=subprocess.DEVNULL)
            name = out.strip().splitlines()[0].strip()
            if name:
                return name
        except Exception:
            continue
    if os.name == "nt":
        keywords = ("nvidia", "geforce", "rtx", "quadro")
        # wmic 在 Windows 11 24H2+ 已移除，PowerShell CIM 兜底
        probes = [["wmic", "path", "win32_VideoController", "get", "name"],
                  ["powershell", "-NoProfile", "-Command", "(Get-CimInstance Win32_VideoController).Name"]]
        for probe in probes:
            try:
                out = subprocess.check_output(probe, text=True, timeout=20, stderr=subprocess.DEVNULL)
                for line in out.splitlines():
                    line = line.strip()
                    if line and line.lower() != "name" and any(k in line.lower() for k in keywords):
                        return line
            except Exception:
                continue
    return None


def torch_cuda_ok():
    """子进程探测当前 Python 环境的 torch 是否支持 CUDA（避免污染本进程导入状态）。
    返回 (可用, 原因说明)。"""
    try:
        proc = subprocess.run(
            [sys.executable, "-c",
             "import torch;print('OK' if torch.cuda.is_available() else 'NO');print(torch.__version__)"],
            capture_output=True, text=True, timeout=180)
        lines = [l.strip() for l in (proc.stdout or "").splitlines() if l.strip()]
        if lines and lines[0] == "OK":
            return True, f"torch {lines[1] if len(lines) > 1 else ''} CUDA 可用"
        if lines and lines[0] == "NO":
            version = lines[1] if len(lines) > 1 else ""
            is_cpu_build = "+cpu" in version or "cpu" in version.split("+")[-1:]
            reason = f"当前 torch {version} 为 CPU 版" if is_cpu_build else f"torch {version} 检测不到可用 CUDA（可能显卡驱动过旧或无 NVIDIA 显卡）"
            return False, reason
        # import 失败：看 stderr
        err = (proc.stderr or "").strip().splitlines()
        if err and "No module named" in (proc.stderr or ""):
            return False, "未安装 PyTorch"
        return False, "PyTorch 探测失败：" + ((proc.stderr or "").strip()[-120:] or f"退出码 {proc.returncode}")
    except Exception as exc:
        return False, f"PyTorch 探测异常：{exc}"


def install_cuda_torch(gpu_name):
    """安装 CUDA 版 PyTorch，进度映射到依赖阶段 10–17%。
    必须在本进程 import torch 之前调用（覆盖安装对已加载模块不安全）。"""
    emit("status", stage="dependency",
         message=f"检测到 {gpu_name}，当前 PyTorch 不支持 CUDA，正在安装 CUDA 版（体积较大，请耐心等待）",
         percent=10)
    base = [sys.executable, "-m", "pip", "install", "--no-input", "--disable-pip-version-check",
            "--timeout", "60", "--retries", "3", "--prefer-binary", "--progress-bar", "raw",
            "--ignore-installed", "--index-url", "https://download.pytorch.org/whl/cu121", "torch"]
    code, output = run_pip_with_progress(base, "正在安装 CUDA 版 PyTorch", network=True, idle_timeout=180, pbase=10, pspan=0.06)
    cuda_ok, why = torch_cuda_ok()
    if code == 0 and cuda_ok:
        emit("status", stage="dependency", message="CUDA 版 PyTorch 安装完成", percent=17)
        return True
    tail = "；".join(l.strip() for l in output.splitlines() if l.strip())[-220:]
    reason = f"：{tail}" if tail else ""
    if code == 124:
        reason = "：下载超时（CUDA 版约 2.4GB，请检查网络后重试）"
    emit("status", stage="dependency", message=f"CUDA 版 PyTorch 安装失败，将使用 CPU 推理{reason}", percent=17)
    return False


def prepare_cuda_environment(device_pref):
    """依赖阶段内的 GPU / CUDA 环境检查与安装（GPU / auto 模式）。
    返回 (gpu_name or None, cuda_ready)。"""
    if device_pref == "cpu":
        return None, False
    emit("status", stage="dependency", message="正在检查 GPU 与 CUDA 环境", percent=1)
    gpu_name = detect_nvidia_gpu()
    if not gpu_name:
        # 列出系统实际显卡，帮助判断是“无独立显卡”还是“检测失败”
        cards = []
        try:
            out = subprocess.check_output(
                ["powershell", "-NoProfile", "-Command", "(Get-CimInstance Win32_VideoController).Name"],
                text=True, timeout=20, stderr=subprocess.DEVNULL) if os.name == "nt" else ""
            cards = [l.strip() for l in out.splitlines() if l.strip() and l.strip().lower() != "name"]
        except Exception:
            pass
        card_note = f"（检测到显卡：{'、'.join(cards[:3])}）" if cards else "（未检测到任何显卡信息）"
        emit("status", stage="dependency",
             message=f"未检测到 NVIDIA GPU，将使用 CPU 推理{card_note}。GPU 识别需要 NVIDIA 显卡（GeForce/RTX/Quadro）+ 最新驱动", percent=10)
        return None, False
    cuda_ok, why = torch_cuda_ok()
    if cuda_ok:
        emit("status", stage="dependency", message=f"检测到 {gpu_name}，CUDA PyTorch 已就绪", percent=10)
        return gpu_name, True
    emit("status", stage="dependency", message=f"检测到 {gpu_name}，但 {why}，正在尝试安装 CUDA 版 PyTorch…", percent=10)
    return gpu_name, install_cuda_torch(gpu_name)


def load_qwen_backend():
    spec=importlib.util.find_spec("qwen_asr")
    if not spec or not spec.submodule_search_locations: raise ModuleNotFoundError("qwen_asr")
    package_dir=str(next(iter(spec.submodule_search_locations)))
    package=types.ModuleType("qwen_asr"); package.__path__=[package_dir]; package.__package__="qwen_asr"; package.__spec__=spec
    sys.modules["qwen_asr"]=package
    inference_dir=os.path.join(package_dir,"inference")
    inference=types.ModuleType("qwen_asr.inference"); inference.__path__=[inference_dir]; inference.__package__="qwen_asr.inference"; sys.modules["qwen_asr.inference"]=inference
    aligner=types.ModuleType("qwen_asr.inference.qwen3_forced_aligner"); aligner.Qwen3ForcedAligner=object; sys.modules["qwen_asr.inference.qwen3_forced_aligner"]=aligner
    return importlib.import_module("qwen_asr.inference.qwen3_asr").Qwen3ASRModel

def import_with_heartbeat(importer, name):
    started = time.monotonic()
    done = threading.Event()

    def report():
        while not done.wait(2):
            elapsed = int(time.monotonic() - started)
            emit("status", stage="model", message=f"正在初始化 Qwen3-ASR：加载 {name}（已用 {elapsed} 秒）", percent=min(8, 5 + elapsed // 10))

    thread = threading.Thread(target=report, daemon=True)
    thread.start()
    try:
        return importer()
    finally:
        done.set()
        thread.join(timeout=0.2)


def load_with_heartbeat(loader, hardware):
    started = time.monotonic()
    done = threading.Event()

    def report():
        while not done.wait(2):
            elapsed = int(time.monotonic() - started)
            note = "；请检查模型目录完整性和内存" if elapsed >= 60 else ""
            emit("status", stage="model", message=f"正在加载本地 ASR 模型（{hardware}，已用 {elapsed} 秒）{note}", percent=min(17, 9 + elapsed // 6))

    thread = threading.Thread(target=report, daemon=True)
    thread.start()
    try:
        return loader()
    finally:
        done.set()
        thread.join(timeout=0.2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--model-kind", default="qwen")
    ap.add_argument("--duration", type=float, default=0.0)
    ap.add_argument("--start", type=float, default=0.0)
    ap.add_argument("--chunk", type=float, default=4.0)
    ap.add_argument("--device", default="auto", help="推理设备：auto（GPU+CPU 混合）/ cpu / gpu")
    args = ap.parse_args()
    if not os.path.isfile(args.video):
        emit("error", message="找不到视频文件")
        return 2
    if not os.path.isdir(args.model) and args.model_kind != "browser":
        emit("error", message="模型路径不存在：" + args.model)
        return 2
    try:
        ffmpeg = ensure_ffmpeg()
    except Exception as exc:
        emit("error", message="FFmpeg 自动准备失败：" + str(exc))
        return 2
    total = args.duration if args.duration > 0 else duration(args.video, ffmpeg)
    if total <= 0:
        emit("error", message="无法读取视频时长")
        return 2
    # 设备模式：auto（GPU+CPU 混合）/ cpu / gpu；GPU 相关检查与 CUDA 安装纳入依赖阶段
    device_pref = (args.device or "auto").lower()
    if device_pref not in ("auto", "cpu", "gpu"):
        device_pref = "auto"
    if device_pref == "cpu":
        # 仅 CPU 模式才隐藏 GPU；auto/gpu 模式必须保留 CUDA 可见性，否则 torch 永远检测不到 GPU
        os.environ["CUDA_VISIBLE_DEVICES"] = ""
    gpu_name = None
    if args.model_kind == "qwen":
        gpu_name, _cuda_ready = prepare_cuda_environment(device_pref)
    need_cuda = gpu_name is not None   # 需要 CUDA 版 torch（用于缺失依赖时的安装选择）
    emit("status", stage="model", message="正在加载本地 ASR 模型", percent=8)
    try:
        if args.model_kind == "qwen":
            try:
                emit("status", stage="model", message="正在初始化 Qwen3-ASR：加载 PyTorch", percent=5)
                torch=import_with_heartbeat(lambda: __import__("torch"), "PyTorch")
                Qwen3ASRModel=import_with_heartbeat(load_qwen_backend, "qwen-asr Transformers 后端")
            except ModuleNotFoundError as exc:
                missing=getattr(exc,"name","")
                if missing == "qwen_asr":
                    install_packages(["qwen-asr"])
                elif missing == "torch" and need_cuda:
                    install_cuda_torch(gpu_name)      # 直接安装 CUDA 版，避免装 CPU 版后重装
                    install_packages(["qwen-asr"])
                else:
                    install_packages(["torch", "qwen-asr"])
                torch=import_with_heartbeat(lambda: __import__("torch"), "PyTorch")
                Qwen3ASRModel=import_with_heartbeat(load_qwen_backend, "qwen-asr Transformers 后端")
            torch.set_num_threads(max(1,min(8,os.cpu_count() or 1)))
            try:
                torch.set_num_interop_threads(1)
            except RuntimeError:
                pass
            # 推理设备（device_pref 已在依赖阶段解析）
            cuda_ok = torch.cuda.is_available()
            if not cuda_ok and device_pref in ("gpu", "auto"):
                # 汇总具体原因：显卡检测 + torch 版本 + 驱动
                why = "未知原因"
                try:
                    ok2, why = torch_cuda_ok()
                    if ok2: why = "CUDA 子进程可用但本进程不可用（罕见，可能显存被占满）"
                except Exception as exc:
                    why = str(exc)
                gpu_note = f"已检测到显卡 {gpu_name}，" if gpu_name else "未检测到 NVIDIA 显卡，"
                mode = "GPU 模式" if device_pref == "gpu" else "自动模式"
                emit("status", stage="model", message=f"{mode}回退 CPU：{gpu_note}{why}。如需 GPU：NVIDIA 显卡 + 更新驱动 + 安装 CUDA 版 PyTorch（pip install torch --index-url https://download.pytorch.org/whl/cu121）", percent=8)
                device_pref = "cpu"
            models = []
            if device_pref in ("auto", "cpu"):
                models.append(("CPU", load_with_heartbeat(lambda: Qwen3ASRModel.from_pretrained(args.model,dtype=torch.float32,device_map="cpu",max_inference_batch_size=6,max_new_tokens=128,local_files_only=True), "CPU 加速模式")))
            if device_pref in ("auto", "gpu") and cuda_ok:
                try:
                    emit("status", stage="model", message="检测到 CUDA GPU，正在加载 GPU 模型（float16）", percent=13)
                    gpu_name = torch.cuda.get_device_name(0)
                    models.append(("GPU", load_with_heartbeat(lambda: Qwen3ASRModel.from_pretrained(args.model,dtype=torch.float16,device_map="cuda",max_inference_batch_size=6,max_new_tokens=128,local_files_only=True), "GPU 加速模式")))
                    emit("status", stage="model",
                         message=f"GPU（{gpu_name}）模型已加载，将同时使用 GPU 与 CPU 识别" if device_pref == "auto" else f"GPU（{gpu_name}）模型已加载，使用 GPU 识别",
                         percent=17)
                except Exception as exc:
                    emit("status", stage="model", message=f"GPU 模型加载失败：{exc}", percent=17)
                    if not models:
                        models.append(("CPU", load_with_heartbeat(lambda: Qwen3ASRModel.from_pretrained(args.model,dtype=torch.float32,device_map="cpu",max_inference_batch_size=6,max_new_tokens=128,local_files_only=True), "CPU 加速模式")))
            mode_text = " + ".join(name for name, _ in models) if models else "CPU"
            emit("status", stage="model", message=f"当前识别设备：{mode_text}", percent=17, device=mode_text)
        else:
            emit("error", message="系统语音识别不能处理本地视频音轨，请选择 Qwen3-ASR")
            return 2
    except ModuleNotFoundError as exc:
        missing=getattr(exc,"name","依赖包")
        emit("error", message=f"模型加载失败：缺少 Python 依赖 {missing}。请安装 torch 和 qwen-asr。")
        return 2
    except subprocess.CalledProcessError as exc:
        emit("error", message=f"自动安装 ASR 依赖失败（退出码 {exc.returncode}）。请检查网络连接和 pip 权限。")
        return 2
    except Exception as exc:
        emit("error", message="模型加载失败："+str(exc)); return 2

    def _run_model(model, paths):
        try:
            return list(model.transcribe(audio=list(paths), language=None))
        except TypeError:
            return [model.transcribe(audio=p, language=None)[0] for p in paths]

    def transcribe_paths(paths):
        """批量转写；GPU+CPU 双模型时用两个线程并行分担同一批片段。
        任一侧失败只重试失败的那部分，绝不重复计算已成功的结果。"""
        if len(models) > 1 and len(paths) > 1:
            from concurrent.futures import ThreadPoolExecutor
            half = (len(paths) + 1) // 2
            cpu_part, gpu_part = paths[:half], paths[half:]
            cpu_results = None
            gpu_results = None
            gpu_error = None
            with ThreadPoolExecutor(max_workers=2) as pool:
                f_cpu = pool.submit(models[0][1].transcribe, audio=cpu_part, language=None)
                f_gpu = pool.submit(models[1][1].transcribe, audio=gpu_part, language=None)
                try:
                    cpu_results = list(f_cpu.result())
                except Exception:
                    cpu_results = None
                try:
                    gpu_results = list(f_gpu.result())
                except Exception as exc:
                    gpu_error = exc
            if gpu_error is not None and len(models) > 1:
                models.pop()  # GPU 异常时摘除，后续批次全部走 CPU
                emit("status", stage="transcribe", message=f"GPU 推理异常，已切换为纯 CPU：{gpu_error}", device="CPU")
            if cpu_results is not None and gpu_results is not None:
                return cpu_results + gpu_results
            if cpu_results is not None:      # 仅 GPU 失败：只补算 GPU 部分
                return cpu_results + _run_model(models[0][1], gpu_part)
            if gpu_results is not None:      # 仅 CPU 失败：只补算 CPU 部分
                return _run_model(models[0][1], cpu_part) + gpu_results
        return _run_model(models[0][1], paths)

    emit("status", stage="audio", message="模型已加载，开始分析视频音频", percent=18)
    state = AsrState()
    threading.Thread(target=stdin_reader, args=(state,), daemon=True).start()

    # 字幕缓存：与视频同目录的 <video>.lightplayer-subs.json，命中则直接复用
    # v2 格式：{"version":2,"captions":[...],"covered":[[a,b],...]}
    # covered 记录所有已处理区间（含无语音的静音片段），确保任何识别过的音频都不会重复识别
    cache_path = args.video + ".lightplayer-subs.json"
    all_captions = []
    cached_count = 0

    def save_cache(force=False):
        """写字幕缓存；节流 10 秒（force 用于收尾/跳转等关键节点）。"""
        now = time.monotonic()
        if not force and now - save_cache.last < 10.0:
            save_cache.dirty = True
            return
        try:
            save_cache.last = now
            save_cache.dirty = False
            all_captions.sort(key=lambda c: c["start"])
            payload = {"version": 2, "captions": all_captions,
                       "covered": [[round(a, 3), round(b, 3)] for a, b in completed]}
            tmp_path = cache_path + ".tmp"
            with open(tmp_path, "w", encoding="utf-8") as fh:
                json.dump(payload, fh, ensure_ascii=False)
            os.replace(tmp_path, cache_path)
        except Exception:
            pass
    save_cache.last = 0.0
    save_cache.dirty = False

    with tempfile.TemporaryDirectory(prefix="lightplayer-asr-") as tmp:
        chunk_target = max(2.0, args.chunk)
        chunk_min = max(1.0, chunk_target * 0.55)
        chunk_max = max(chunk_target + 1.0, chunk_target * 1.6)
        probe_len = chunk_max + 2.0
        behind = max(3.0, chunk_target)   # 落后播放头超过该值即跳回播放头附近（越小跟随越紧）
        ahead = 30.0                       # 领先播放头超过该值回头补齐空洞
        lead = 12.0                        # 播放头窗口：批量组装最多覆盖到播放头前方该秒数，保证首批字幕尽快到达
        completed = []
        start = max(0.0, min(args.start, max(0.0, total - 0.1)))
        state.playhead = (start, 1.0, time.monotonic())  # 收到前端位置前以起始位置为准
        batch_size = 2          # 批量推理段数，按实测吞吐自适应（2–6）
        batch_min, batch_max = 2, 6
        speed_ema = None        # 识别速度（音频秒/墙钟秒）的指数滑动平均
        wav_probe = os.path.join(tmp, "probe.wav")
        # 载入缓存字幕：立即下发已识别内容并标记为已覆盖，仅识别未覆盖部分
        if os.path.isfile(cache_path):
            try:
                with open(cache_path, "r", encoding="utf-8") as fh:
                    raw = json.load(fh)
                if isinstance(raw, dict):
                    cap_items = raw.get("captions") or []
                    covered_items = raw.get("covered") or []
                elif isinstance(raw, list):
                    cap_items = raw          # v1 格式：仅有字幕，区间从字幕反推
                    covered_items = None
                else:
                    cap_items, covered_items = [], None
                cached_items = []
                for item in cap_items:
                    try:
                        cs, ce, ct = float(item["start"]), float(item["end"]), str(item["text"]).strip()
                        if ce > cs and 0 <= cs < total and ct:
                            ce = min(ce, total)
                            all_captions.append({"start": cs, "end": ce, "text": ct})
                            cached_items.append({"start": cs, "end": ce, "text": ct})
                    except (KeyError, TypeError, ValueError):
                        continue
                if cached_items:
                    # 批量一次性下发，避免逐条 IPC 造成渲染端逐条排序（O(n²)）的卡顿
                    emit("captions", items=cached_items)
                if covered_items is not None:
                    # v2：直接恢复全部已处理区间（含静音片段），杜绝重复识别
                    for pair in covered_items:
                        try:
                            a, b = float(pair[0]), float(pair[1])
                            if b > a and a < total:
                                mark_completed(completed, a, min(b, total))
                        except (TypeError, ValueError, IndexError):
                            continue
                else:
                    for c in all_captions:
                        mark_completed(completed, c["start"], c["end"])
            except Exception:
                all_captions = []
                completed[:] = []
        if all_captions or completed:
            cached_count = len(all_captions)
            emit("status", stage="transcribe",
                 message=f"已加载缓存字幕 {cached_count} 条，仅识别未覆盖部分",
                 percent=min(96, 18 + int(coverage_seconds(completed) / total * 78)))
            save_cache()
        while True:
            with state.lock:
                pending = state.pending_seek
                state.pending_seek = None
                pos, rate, stamp = state.playhead
            # 统一计算播放头当前位置（组批与调度共用），识别始终围绕播放头展开
            elapsed = max(0.0, time.monotonic() - stamp)
            desired = min(total, pos + rate * elapsed) if rate > 0 else pos
            if pending is not None:
                # 用户 seek：从未覆盖区域中定位新目标，已转写部分不重复识别
                start = next_uncovered(completed, min(max(0.0, pending), max(0.0, total - 0.1)))
                emit("status", stage="transcribe", message=f"已跟随跳转，从 {int(start)}s 附近继续识别",
                     percent=min(96, 18 + int(coverage_seconds(completed) / total * 78)))
            else:
                # 追赶式调度：按最新播放位置 + 倍速预测“当前需要字幕的位置”
                if start < desired - behind:
                    start = next_uncovered(completed, desired)
                elif start > desired + ahead:
                    start = next_uncovered(completed, 0.0)
            if start >= total - 0.05:
                gap = next_uncovered(completed, 0.0)
                if gap >= total - 0.05:
                    break
                start = gap
            # 组装一批片段：批量提取 + 一次 generate 同时转写，提高 CPU 吞吐
            # 每段都跳到未覆盖位置，避免与已转写区间重复
            # 播放头窗口：已组装至少 1 段且下一段超出播放头前方 lead 秒时停止组批，
            # 优先把贴近播放头的片段尽快送去识别，让用户更早看到当前对白
            segments = []
            cursor = start
            while len(segments) < batch_size:
                cursor = next_uncovered(completed, cursor)
                if cursor >= total - 0.25:
                    break
                if segments and cursor > desired + lead:
                    break
                limit = covered_limit(completed, cursor)
                if limit is not None:
                    if limit - cursor <= 0.25:
                        mark_completed(completed, cursor, limit)  # 过短空洞直接忽略
                        continue
                remaining = total - cursor
                wav_path = os.path.join(tmp, f"chunk-{len(segments)}.wav")
                try:
                    if remaining <= chunk_max:
                        extract(ffmpeg, args.video, wav_path, cursor, remaining)
                        dur = remaining
                    else:
                        # 能量 VAD：在目标时长附近的静音处切分，避免拦腰截断句子
                        extract(ffmpeg, args.video, wav_probe, cursor, probe_len)
                        boundary = snap_to_silence(wav_probe, chunk_target, chunk_min, chunk_max)
                        dur = boundary if boundary else chunk_target
                        slice_wav(wav_probe, wav_path, dur)
                except Exception as exc:
                    emit("error", message=f"音频片段 {int(cursor)}s 提取失败：{exc}")
                    return 3
                if limit is not None:
                    dur = min(dur, limit - cursor)  # 不越过后方已覆盖区间
                segments.append((cursor, dur, wav_path))
                cursor += dur
            if not segments:
                mark_completed(completed, start, total)
                break
            audio_sec = sum(d for _, d, _ in segments)
            t0 = time.monotonic()
            results = transcribe_paths([p for _, _, p in segments])
            wall = max(1e-6, time.monotonic() - t0)
            speed = audio_sec / wall
            speed_ema = speed if speed_ema is None else speed_ema * 0.7 + speed * 0.3
            # 自适应批大小：吞吐不足时加大批量，明显富余时减小批量以降低延迟
            if speed_ema < 0.95 and batch_size < batch_max:
                batch_size += 1
            elif speed_ema > 1.8 and batch_size > batch_min:
                batch_size -= 1
            emit("status", stage="transcribe",
                 message=f"识别音频片段 {int(segments[0][0])}s–{int(segments[-1][0] + segments[-1][1])}s · 速度 {speed_ema:.1f}×播放",
                 percent=min(96, 18 + int(coverage_seconds(completed) / total * 78)),
                 device=" + ".join(name for name, _ in models) if models else "CPU")
            try:
                for (seg_start, dur, _), res in zip(segments, results):
                    text = (res.text if res else "").strip()
                    end = min(total, seg_start + dur)
                    if text:
                        emit("caption", start=seg_start, end=end, text=text)
                        all_captions.append({"start": seg_start, "end": end, "text": text})
                    mark_completed(completed, seg_start, end)
            except Exception as exc:
                emit("error", message=f"音频片段 {int(segments[0][0])}s 识别失败：{exc}")
                return 3
            save_cache()
            start = next_uncovered(completed, cursor)
    save_cache(force=True)
    emit("status", stage="display", message="实时字幕识别完成", percent=100)
    emit("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
