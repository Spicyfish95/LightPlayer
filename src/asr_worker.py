import argparse
import collections
import importlib
import importlib.util
import json
import os
import platform
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
# numba（librosa 依赖）默认把 JIT 缓存写到 site-packages/librosa/**/__pycache__。
# 当该目录只读（Program Files 安装、企业管控、安全软件拦截）时，Windows 上 tempfile 创建
# 临时文件会收到 PermissionError 并按 TMP_MAX 次无限重试，表现为单核 100% 卡死、首条字幕永不出现。
# 把缓存目录重定向到用户可写的应用运行目录，从根上消除该问题（必须在 import numba/librosa 前设置）。
if not os.environ.get("NUMBA_CACHE_DIR"):
    _cache_candidates = [
        os.path.join(os.environ.get("LOCALAPPDATA", ""), "LightPlayer", "runtime", "numba-cache"),
        os.path.join(tempfile.gettempdir(), "LightPlayer", "numba-cache"),
    ]
    for _cache_dir in _cache_candidates:
        if not _cache_dir:
            continue
        try:
            os.makedirs(_cache_dir, exist_ok=True)
            # 实际写一个探针文件，确认目录可写（makedirs 成功不代表有写权限）
            _probe = os.path.join(_cache_dir, ".write-probe")
            with open(_probe, "wb") as _fh:
                _fh.write(b"x")
            os.remove(_probe)
            os.environ["NUMBA_CACHE_DIR"] = _cache_dir
            break
        except OSError:
            continue
    else:
        # 所有候选目录都不可写：直接禁用 JIT。librosa 用到的 njit 均为毫秒级小工具函数，
        # 纯 Python 回退可接受，远好于在 tempfile 中无限自旋
        os.environ.setdefault("NUMBA_DISABLE_JIT", "1")

# GPU + CPU 双模式下，CUDA 版 PyTorch 等 GPU 依赖安装到该目录（由主进程经 --lib-dir 传入）
LIB_DIR = ""
# True 表示当前进程是「设置里选中双模式后」的独立依赖安装流程，进度事件走 gpu-setup 通道
SETUP_MODE = False
# 独立安装流程当前所处阶段：check（检测）/ download（下载）/ install（安装）
SETUP_PHASE = "check"
# 用户取消安装：由 stdin 监听线程置位，pip 循环内轮询后结束 pip 进程树
CANCEL_EVENT = threading.Event()
_PIP_LOCK = threading.Lock()
_PIP_PROC = None


def emit(kind, **data):
    print(json.dumps({"kind": kind, **data}, ensure_ascii=False), flush=True)


def set_setup_phase(phase):
    global SETUP_PHASE
    SETUP_PHASE = phase


def progress_emit(stage, message, percent=None, **extra):
    """进度事件：ASR 流程走 status 通道，独立安装流程走 gpu-setup 通道并带上当前阶段。"""
    if SETUP_MODE:
        emit("gpu-setup", phase=SETUP_PHASE, stage=stage, message=message, percent=percent, **extra)
    else:
        emit("status", stage=stage, message=message, percent=percent, **extra)


def _kill_tree(proc):
    """结束 pip 及其子进程的整个进程树（Windows 下必须用 taskkill /T）。"""
    if proc is None or proc.poll() is not None:
        return
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
        else:
            proc.terminate()
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass


def cancel_watcher():
    """监听 stdin 的取消命令，用于中止依赖下载/安装。"""
    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            if msg.get("cmd") == "cancel":
                CANCEL_EVENT.set()
                with _PIP_LOCK:
                    proc = _PIP_PROC
                _kill_tree(proc)
                return
    except Exception:
        pass


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


_ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
_SIZE_UNITS = {"B": 1, "KB": 1024, "MB": 1024 ** 2, "GB": 1024 ** 3, "TB": 1024 ** 4}


def _parse_bar_bytes(text):
    """从 pip 进度条文本解析「已完成/总量」字节数（如 "1.1/2.4 GB"）。"""
    m = re.findall(r"(\d+(?:\.\d+)?)\s*([KMGT]?B)\s*/\s*(\d+(?:\.\d+)?)\s*([KMGT]?B)", text, re.I)
    if m:
        a, ua, b, ub = m[-1]
        try:
            return float(a) * _SIZE_UNITS[ua.upper()], float(b) * _SIZE_UNITS[ub.upper()]
        except (KeyError, ValueError):
            return None
    m = re.findall(r"(\d+(?:\.\d+)?)\s*/\s*(\d+(?:\.\d+)?)\s*([KMGT]?B)", text, re.I)
    if m:
        a, b, u = m[-1]
        try:
            unit = _SIZE_UNITS[u.upper()]
            return float(a) * unit, float(b) * unit
        except (KeyError, ValueError):
            return None
    return None


def parse_progress_percent(text):
    """从 pip 输出中提取下载百分比：优先 "45%"，其次进度条的 "45.3/245.6 MB"。"""
    matches = re.findall(r"(\d{1,3})%", text)
    if matches:
        return min(99, max(0, int(matches[-1])))
    bar = _parse_bar_bytes(text)
    if bar and bar[1] > 0:
        return min(99, max(0, int(bar[0] * 100 / bar[1])))
    return None


def _scan_dir_size(path):
    """递归统计目录下所有文件总字节，作为 pip 在管道下不输出进度条时的可靠下载进度来源。"""
    total = 0
    if not path or not os.path.isdir(path):
        return total
    try:
        for root, _dirs, files in os.walk(path):
            for f in files:
                try:
                    total += os.path.getsize(os.path.join(root, f))
                except OSError:
                    pass
    except OSError:
        pass
    return total


def _format_bytes(num):
    """字节数格式化为带单位的可读字符串。"""
    try:
        num = float(num)
    except (TypeError, ValueError):
        return "?"
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if num < 1024 or unit == "TB":
            return f"{num:.1f} {unit}"
        num /= 1024
    return f"{num:.1f} TB"


def run_pip_with_progress(command, label, network=True, idle_timeout=60, pbase=4, pspan=0.06, mode="single", watch_dir=None):
    """运行 pip 命令并把进度映射到 [pbase, pbase+100*pspan] 区间，并支持用户取消。
    mode="single"   单个 pip 的进度条百分比（ASR 依赖安装）；
    mode="download" 多文件聚合下载进度（已下载字节 / 已知总字节），用于「下载」阶段；
    mode="install"  安装阶段按时间平滑推进（安装过程 pip 无可靠百分比）。"""
    import queue
    global _PIP_PROC
    output = ""
    chunks = queue.Queue()

    def reader():
        while True:
            chunk = proc.stdout.read(256)
            chunks.put(chunk)
            if not chunk:
                break

    proc = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, bufsize=0)
    with _PIP_LOCK:
        _PIP_PROC = proc
    thread = threading.Thread(target=reader, daemon=True)
    thread.start()
    started = time.monotonic()
    last_report = started
    no_data_since = started
    last_percent = -1
    last_clean = ""
    line_buf = ""
    current_file = ""
    install_phase = False
    known_total = 0.0        # download 模式：已知文件总字节
    completed_bytes = 0.0    # download 模式：已完成文件字节（按 Saved 事件累计，作为辅助）
    cur_size = 0.0           # download 模式：当前文件字节
    last_agg = 0.0           # download 模式：已上报的聚合百分比（单调不回退）
    last_watch = started     # download 模式：上次 watch_dir 扫描时间戳
    cur_dir_bytes = 0        # download 模式：watch_dir 当前已落盘字节数

    def show(msg, percent):
        progress_emit("dependency", msg, percent=max(pbase, min(pbase + int(100 * pspan), int(percent))))

    def maybe_scan_watch():
        """扫描 watch_dir 实际文件大小作为最可靠的下载进度来源。
        pip 在管道模式下不输出 rich 进度条，唯有从文件系统层面统计已落盘字节才能实时反映进度。"""
        nonlocal last_watch, last_agg, cur_dir_bytes
        if mode != "download" or not watch_dir or known_total <= 0:
            return
        if time.monotonic() - last_watch < 2:
            return
        last_watch = time.monotonic()
        cur_dir_bytes = _scan_dir_size(watch_dir)
        agg = min(99.0, cur_dir_bytes * 100.0 / known_total)
        if agg > last_agg:
            last_agg = agg

    try:
        while thread.is_alive() or not chunks.empty():
            if CANCEL_EVENT.is_set():
                _kill_tree(proc)
                return 130, output
            maybe_scan_watch()
            try:
                chunk = chunks.get(timeout=0.5)
            except queue.Empty:
                chunk = None
            if chunk is None:
                if time.monotonic() - no_data_since >= idle_timeout and proc.poll() is None:
                    note = f"{label}连接超时，正在切换下载源" if network else f"{label}本地安装超时"
                    show(note, pbase)
                    _kill_tree(proc)
                    return 124, output
                if time.monotonic() - last_report >= 2:
                    elapsed = int(time.monotonic() - started)
                    if mode == "install":
                        # 安装阶段：按时间平滑推进，最多到区间的 95%，完成时由调用方置 100%
                        creep = min(0.95, (time.monotonic() - started) / 60.0)
                        show(last_clean or f"{label}…", pbase + creep * 100 * pspan)
                    elif mode == "download" and known_total > 0:
                        # 下载中：显示聚合百分比 + 已下载字节/总字节 + 已用秒数
                        show(f"{label} · {current_file or ''} {int(last_agg)}%"
                             f"（{_format_bytes(cur_dir_bytes)} / {_format_bytes(known_total)}，已用 {elapsed} 秒）",
                             pbase + last_agg * pspan)
                    else:
                        note = "正在连接/解析下载源" if network else "正在本地解包/安装"
                        show(f"{label}（{note}，已等待 {elapsed} 秒）", pbase)
                    last_report = time.monotonic()
                continue
            if not chunk:
                break
            no_data_since = time.monotonic()
            text = chunk.decode("utf-8", errors="replace")
            output += text
            line_buf += text
            parts = re.split(r"[\r\n]", line_buf)
            line_buf = parts.pop()          # 最后一段可能是半行，留到下次拼接
            for seg in parts:
                seg = _ANSI_RE.sub("", seg).strip()
                if not seg:
                    continue
                if mode == "download":
                    # 聚合进度：解析每个文件的声明大小（Downloading 行）+ 当前文件进度条（管道下 pip 不输出，作辅助）
                    if "Downloading " in seg:
                        size_match = re.search(r"\(([\d.]+)\s*([KMGT]?B)\)", seg, re.I)
                        if size_match:
                            try:
                                size = float(size_match.group(1)) * _SIZE_UNITS[size_match.group(2).upper()]
                            except (KeyError, ValueError):
                                size = 0.0
                            cur_size = size
                            known_total += size
                            found = re.search(r"([\w.+-]+\.(?:whl|tar\.gz|zip))", seg)
                            if found:
                                current_file = found.group(1)
                            if seg != last_clean:
                                last_clean = seg
                                show(f"{label} · 正在下载 {current_file or ''}"
                                     f"（{_format_bytes(size)}，已用 {int(time.monotonic() - started)} 秒）",
                                     pbase + last_agg * pspan)
                                last_report = time.monotonic()
                            continue
                    # Saved 事件：pip download 完成一个 wheel 时输出 "Saved /path/xxx.whl"
                    if seg.startswith("Saved "):
                        completed_bytes += cur_size
                        found = re.search(r"([\w.+-]+\.(?:whl|tar\.gz|zip))", seg)
                        done_name = found.group(1) if found else (current_file or "文件")
                        show(f"{label} · 已完成 {done_name}", pbase + last_agg * pspan)
                        last_report = time.monotonic()
                        continue
                    bar = _parse_bar_bytes(seg)
                    if bar is not None and known_total > 0:
                        done, _total = bar
                        agg = min(99.0, (completed_bytes + min(done, cur_size or done)) * 100.0 / known_total)
                        if agg > last_agg:
                            last_agg = agg
                            show(f"{label} · {current_file or ''} {int(agg)}%", pbase + agg * pspan)
                            last_report = time.monotonic()
                    continue
                if mode == "install":
                    if seg != last_clean:
                        last_clean = seg
                        creep = min(0.95, (time.monotonic() - started) / 60.0)
                        show(seg[-180:], pbase + creep * 100 * pspan)
                        last_report = time.monotonic()
                    continue
                # single 模式：沿用原来的「当前文件百分比 + 安装阶段」判定
                if "Installing collected packages" in seg or "Successfully installed" in seg:
                    install_phase = True
                if "Downloading" in seg or "Collecting" in seg:
                    found = re.search(r"([\w.+-]+\.(?:whl|tar\.gz|zip))", seg)
                    if found:
                        current_file = found.group(1)
                    install_phase = False
                pct = parse_progress_percent(seg)
                if pct is not None:
                    if pct != last_percent:
                        last_percent = pct
                        last_report = time.monotonic()
                        shown = pbase + int(pct * pspan)
                        if install_phase:
                            shown = max(shown, pbase + int(0.92 * 100 * pspan))
                        name = f"{current_file} " if current_file else ""
                        show(f"{label} · {name}{pct}%", shown)
                elif seg != last_clean:
                    last_clean = seg
                    show(seg[-180:], pbase + 1)
                    last_report = time.monotonic()
        return proc.wait(), output
    finally:
        with _PIP_LOCK:
            _PIP_PROC = None


def install_packages(packages):
    progress_emit("dependency", "检测到缺少 ASR 依赖，正在自动安装：" + ", ".join(packages), percent=4)
    base = [sys.executable, "-m", "pip", "install", "--no-input", "--disable-pip-version-check", "--timeout", "10", "--retries", "1", "--prefer-binary", "--progress-bar", "on"]
    sources = [("清华 PyPI 镜像", "https://pypi.tuna.tsinghua.edu.cn/simple"), ("阿里云 PyPI 镜像", "https://mirrors.aliyun.com/pypi/simple/"), ("中科大 PyPI 镜像", "https://pypi.mirrors.ustc.edu.cn/simple"), ("官方 PyPI", "https://pypi.org/simple")]
    if os.name != "nt":
        sources = [("官方 PyPI", "https://pypi.org/simple")]
    code = 1
    output = ""
    command = base + ["--index-url", sources[0][1], *packages]
    for index, (source_name, source_url) in enumerate(sources):
        if index:
            progress_emit("dependency", f"{sources[0][0]}连接失败，正在切换{source_name}", percent=4)
        command = base + ["--index-url", source_url, *packages]
        code, chunk_output = run_pip_with_progress(command, f"正在从{source_name}下载/安装 ASR 依赖")
        output += chunk_output
        if code in (130,):      # 用户取消
            raise subprocess.CalledProcessError(code, command, output=output)
        if code == 0:
            break
    if code != 0:
        raise subprocess.CalledProcessError(code, command, output=output)
    progress_emit("dependency", "ASR 依赖安装完成", percent=10)


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


def torch_installed_version():
    """不导入 torch，直接解析 torch/version.py 拿到 __version__（毫秒级，避免数秒的 import 开销）。
    未安装返回 None。sys.path 已含 lib，因此能读到 CUDA 版或全局 CPU 版中优先级最高的那个。"""
    try:
        spec = importlib.util.find_spec("torch")
        if spec is None:
            return None
        version_file = os.path.join(os.path.dirname(spec.origin), "version.py")
        with open(version_file, "r", encoding="utf-8", errors="replace") as handle:
            m = re.search(r"__version__\s*=\s*['\"]([^'\"]+)['\"]", handle.read())
        return m.group(1) if m else None
    except Exception:
        return None


def torch_cuda_dll_present():
    """静态检查 torch 是否带 CUDA 运行库（毫秒级）：
    CUDA 版 wheel 在 torch/lib 内含 c10_cuda.dll/libc10_cuda.so，CPU 版没有此文件。
    用文件存在性代替昂贵的 import torch + cuda.is_available()（冷加载 2.5GB DLL 常需数十秒）。"""
    try:
        spec = importlib.util.find_spec("torch")
        if spec is None or not spec.origin:
            return False
        lib_dir = os.path.join(os.path.dirname(spec.origin), "lib")
        return any(os.path.isfile(os.path.join(lib_dir, name))
                   for name in ("c10_cuda.dll", "libc10_cuda.so", "libc10_cuda.dylib"))
    except Exception:
        return False


def torch_cuda_ok(heartbeat_start=4, heartbeat_end=9, deep=False, gpu_name=None):
    """探测当前 Python 环境的 torch 是否支持 CUDA。默认走毫秒级静态判定：
    1) torch/version.py 后缀：未安装 / "+cpu" 直接返回；
    2) "+cuXXX" 构建：检查 torch/lib 内 c10_cuda 运行库是否存在 + 是否检测到 NVIDIA 显卡；
       两者满足即视为就绪——真正的 cuda.is_available() 会在 ASR 启动加载模型时执行，
       无需为安装流程额外付出一次 20-60 秒的子进程冷 import。
    deep=True 时才起子进程 import torch 做驱动级验证（用于安装完整性兜底）。
    返回 (可用, 原因说明)。"""
    version = torch_installed_version()
    if not version:
        return False, "未安装 PyTorch"
    # 版本后缀一锤定音：CPU 构建不可能支持 CUDA
    if "+cu" not in version:
        return False, f"当前 torch {version} 为 CPU 版"
    if not torch_cuda_dll_present():
        return False, f"torch {version} 缺少 CUDA 运行库（c10_cuda），安装可能不完整"
    if gpu_name is None:
        gpu_name = detect_nvidia_gpu()
    if not gpu_name:
        return False, f"torch {version} 为 CUDA 版，但当前未检测到 NVIDIA 显卡或驱动"
    if not deep:
        return True, f"torch {version} CUDA 运行库已就绪（{gpu_name}）"
    code = ("import torch;print('OK' if torch.cuda.is_available() else 'NO');"
            "print(torch.__version__)")
    try:
        proc = subprocess.Popen([sys.executable, "-c", code],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    except Exception as exc:
        return False, f"PyTorch 探测进程启动失败：{exc}"
    started = time.monotonic()
    last_beat = 0
    timeout_s = 120
    while proc.poll() is None:
        if CANCEL_EVENT.is_set():
            _kill_tree(proc)
            return False, "已取消 CUDA 探测"
        time.sleep(0.5)
        elapsed = int(time.monotonic() - started)
        if elapsed - last_beat >= 2:
            last_beat = elapsed
            beat_pct = min(heartbeat_end, heartbeat_start + elapsed // 15)
            progress_emit("dependency",
                          f"正在验证 CUDA 运行时（加载 torch，已用 {elapsed} 秒）",
                          percent=beat_pct)
        if elapsed >= timeout_s:
            _kill_tree(proc)
            return False, f"PyTorch 探测超时（已等待 {elapsed} 秒，可能被安全软件拦截或 torch 安装损坏）"
    stdout, stderr = proc.communicate()
    lines = [l.strip() for l in (stdout or "").splitlines() if l.strip()]
    if lines and lines[0] == "OK":
        return True, f"torch {lines[1] if len(lines) > 1 else version} CUDA 可用"
    if lines and lines[0] == "NO":
        return False, f"torch {lines[1] if len(lines) > 1 else version} 检测不到可用 CUDA（可能显卡驱动过旧）"
    return False, "PyTorch 探测失败：" + ((stderr or "").strip()[-120:] or f"退出码 {proc.returncode}")


def _module_available(name):
    """判断模块是否可导入（不实际导入，仅查规格），用于依赖阶段检查 CPU 相关依赖。"""
    try:
        return importlib.util.find_spec(name) is not None
    except Exception:
        return False


class _DownloadCanceled(Exception):
    pass


# cu126 wheel 直链镜像，按国内实测速度排序（南大/上交约 30MB/s，阿里云较慢兜底，官方源常被墙）
TORCH_CU126_BASES = [
    ("南京大学镜像", "https://mirrors.nju.edu.cn/pytorch/whl/cu126"),
    ("上海交大镜像", "https://mirror.sjtu.edu.cn/pytorch-wheels/cu126"),
    ("阿里云镜像", "https://mirrors.aliyun.com/pytorch-wheels/cu126"),
    ("官方 PyTorch 源", "https://download.pytorch.org/whl/cu126"),
]
# 未安装 torch、无法按同版本选 wheel 时的兜底版本
TORCH_CU126_FALLBACK_VER = "2.14.1"
_UA = {"User-Agent": "LightPlayer/1.0"}


def _wheel_tags():
    """返回当前解释器的 (cp 标签, 平台标签)，用于拼 torch cu126 wheel 文件名。"""
    vi = sys.version_info
    cp = f"cp{vi.major}{vi.minor}"
    machine = platform.machine().lower()
    if sys.platform == "win32":
        plat = {"amd64": "win_amd64", "x86": "win32", "arm64": "win_arm64"}.get(machine)
    elif sys.platform.startswith("linux") and machine in ("x86_64", "amd64"):
        plat = "manylinux_2_28_x86_64"
    else:
        plat = None
    return f"{cp}-{cp}", plat


def _http_head_size(url, timeout=10):
    """HEAD 请求拿文件大小；不存在/失败返回 None。"""
    try:
        req = urllib.request.Request(url, method="HEAD", headers=_UA)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            if resp.status == 200:
                return int(resp.headers.get("Content-Length", 0)) or None
    except Exception:
        return None
    return None


def _parse_index_for_latest(base, tag, plat, timeout=20):
    """兜底：拉取镜像目录索引页，解析适配当前解释器的最高版本 cu126 torch wheel。"""
    try:
        req = urllib.request.Request(base + "/", headers=_UA)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            html = resp.read().decode("utf-8", errors="ignore")
        pat = re.compile(r"torch-(\d+\.\d+\.\d+)%2[Bb]cu126-" + re.escape(tag) + r"-" + re.escape(plat) + r"\.whl")
        versions = sorted({m.group(1) for m in pat.finditer(html)},
                          key=lambda v: tuple(int(x) for x in v.split(".")))
        return versions[-1] if versions else None
    except Exception:
        return None


def resolve_cuda_wheel():
    """确定要下载的 cu126 torch wheel：(文件名, 首个可用镜像名, 直链, 字节数)。
    优先与当前已装 torch 同版本（保证与 qwen-asr 兼容），否则用兜底版本/索引最高版本。"""
    tag, plat = _wheel_tags()
    if not plat:
        return None
    cur = torch_installed_version()
    wanted = []
    if cur:
        wanted.append(cur.split("+")[0])
    wanted.append(TORCH_CU126_FALLBACK_VER)
    for ver in wanted:
        fname = f"torch-{ver}+cu126-{tag}-{plat}.whl"
        for sname, base in TORCH_CU126_BASES:
            size = _http_head_size(base + "/" + fname)
            if size:
                return fname, sname, base + "/" + fname, size
    # 直链都没命中：抓索引页找最高版本
    for sname, base in TORCH_CU126_BASES:
        ver = _parse_index_for_latest(base, tag, plat)
        if not ver:
            continue
        fname = f"torch-{ver}+cu126-{tag}-{plat}.whl"
        size = _http_head_size(base + "/" + fname)
        if size:
            return fname, sname, base + "/" + fname, size
    return None


def _download_one_source(url, dest, total, label, pbase, pspan, stall_timeout=30):
    """从单个 URL 下载（支持断点续传的 .part 文件），实时上报百分比/字节/速度。
    完成返回 True；取消抛 _DownloadCanceled；网络中断抛异常由外层换源（.part 保留，换源后续传）。"""
    part = dest + ".part"
    existing = os.path.getsize(part) if os.path.isfile(part) else 0
    if existing >= total:
        os.replace(part, dest)
        return True
    headers = dict(_UA)
    if existing:
        headers["Range"] = f"bytes={existing}-"
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=stall_timeout) as resp:
        mode = "ab"
        if resp.status != 206:      # 服务器不支持 Range：重新下载
            existing = 0
            mode = "wb"
        done = existing
        started = time.monotonic()
        last_report = started
        window = collections.deque()
        with open(part, mode) as out:
            while True:
                if CANCEL_EVENT.is_set():
                    raise _DownloadCanceled()
                chunk = resp.read(1024 * 512)    # socket 超时即视为停滞，抛异常换源
                if not chunk:
                    break
                out.write(chunk)
                done += len(chunk)
                now = time.monotonic()
                window.append((now, len(chunk)))
                while window and now - window[0][0] > 5:
                    window.popleft()
                if now - last_report >= 0.5:
                    last_report = now
                    span = max(1e-6, now - window[0][0])
                    speed = sum(b for _, b in window) / span
                    pct = min(99, int(done * 100 / total)) if total else 0
                    progress_emit("dependency",
                                  f"{label} · {pct}%（{_format_bytes(done)} / {_format_bytes(total)}，"
                                  f"{_format_bytes(speed)}/s）",
                                  percent=int(pbase + pct * pspan))
    if os.path.getsize(part) != total:
        raise IOError("下载文件大小与服务器不一致")
    os.replace(part, dest)
    return True


def download_cuda_wheel(wheels, pbase=0, pspan=0.9):
    """多镜像故障转移下载 torch cu126 主 wheel，断点续传。返回 (文件路径, 文件名, 版本) 或 None。"""
    info = resolve_cuda_wheel()
    if not info:
        progress_emit("dependency",
                      "未找到适用于当前 Python 版本/系统的 CUDA 版 PyTorch，请确认显卡驱动为最新版后重试",
                      percent=0)
        return None
    fname, first_name, first_url, size = info
    dest = os.path.join(wheels, fname)
    if os.path.isfile(dest) and os.path.getsize(dest) == size:
        return dest, fname, fname.split("-")[1]
    progress_emit("dependency",
                  f"正在下载 CUDA 版 PyTorch（{_format_bytes(size)}）· 首选{first_name}",
                  percent=int(pbase))
    # 首选源放最前，其余镜像作为备选；每个源最多尝试 2 次（.part 跨源续传）
    ordered = [(first_name, first_url)] + [(n, b + "/" + fname) for n, b in TORCH_CU126_BASES
                                           if b + "/" + fname != first_url]
    last_err = ""
    for idx, (sname, url) in enumerate(ordered):
        if CANCEL_EVENT.is_set():
            return None
        if idx:
            progress_emit("dependency", f"正在切换到{sname}并从断点继续下载", percent=int(pbase))
        for attempt in (1, 2):
            if CANCEL_EVENT.is_set():
                return None
            try:
                _download_one_source(url, dest, size, sname, pbase, pspan)
                return dest, fname, fname.split("-")[1]
            except _DownloadCanceled:
                return None
            except Exception as exc:
                last_err = str(exc)
                done = os.path.getsize(dest + ".part") if os.path.isfile(dest + ".part") else 0
                progress_emit("dependency",
                              f"{sname} 下载中断（{_format_bytes(done)} 已保存，可断点续传）：{exc}",
                              percent=int(pbase))
                if attempt == 1:
                    time.sleep(1)
    progress_emit("dependency", f"所有下载源均失败：{last_err}", percent=0)
    return None


def install_cuda_torch(gpu_name):
    """两阶段把 CUDA 版 PyTorch（含依赖）装到软件目录 lib：
    阶段一「下载」：urllib 直链下载 2.6GB 的 torch 主 wheel（绕开 pip 巨型索引页解析，
    多镜像故障转移 + 断点续传，进度占 0-90%），再用国内 PyPI 镜像下载小依赖（90-100%）；
    阶段二「安装」：用本地 wheels 离线安装到 lib，进度独立从 0% 走到 100%。
    必须在本进程 import torch 之前调用（覆盖安装对已加载模块不安全）。"""
    target = LIB_DIR
    if target:
        try:
            os.makedirs(target, exist_ok=True)
        except OSError:
            target = ""
    wheels = os.path.join(target or tempfile.gettempdir(), "_gpu_wheels")
    # 注意：不再在启动时清空 wheels，保留 .part 以支持失败后再次进入时断点续传；结束时统一清理
    try:
        os.makedirs(wheels, exist_ok=True)
    except OSError as exc:
        progress_emit("dependency", f"无法创建下载目录：{exc}", percent=0)
        return False

    try:
        # ---------- 阶段一：下载 ----------
        set_setup_phase("download")
        progress_emit("dependency", f"阶段 1/2 · 准备下载 CUDA 版 PyTorch（{gpu_name}）", percent=0)
        got = download_cuda_wheel(wheels, pbase=0, pspan=0.9)
        if CANCEL_EVENT.is_set() or got is None:
            if not CANCEL_EVENT.is_set():
                progress_emit("dependency", "CUDA 版 PyTorch 下载失败，请检查网络后重试（已下载部分会保留，重试可断点续传）", percent=0)
            else:
                progress_emit("dependency", "已取消下载（已下载部分会保留，重试可断点续传）", percent=0)
            return False
        wheel_path, wheel_fname, torch_ver = got
        progress_emit("dependency", "主安装包下载完成，正在下载配套依赖", percent=89)

        # 小依赖（filelock/typing-extensions/sympy/networkx/jinja2/fsspec 等纯 Python 包）走国内 PyPI 镜像。
        # 这些依赖通常已随系统里的 CPU 版 torch 装在全局 site-packages，运行时可直接复用，
        # 因此此步「尽力而为」：失败不阻断，安装阶段改用 --no-deps 只装 torch 主包。
        spec = f"torch=={torch_ver}"
        dep_base = [sys.executable, "-m", "pip", "download", "--no-input",
                    "--disable-pip-version-check", "--timeout", "30", "--retries", "3",
                    "--prefer-binary", "--progress-bar", "on",
                    "--dest", wheels, "--find-links", wheels, spec]
        pypi_sources = ["https://pypi.tuna.tsinghua.edu.cn/simple",
                        "https://mirrors.aliyun.com/pypi/simple/",
                        "https://pypi.mirrors.ustc.edu.cn/simple"]
        deps_ok = False
        dep_tail = ""
        for index, idx_url in enumerate(pypi_sources):
            if CANCEL_EVENT.is_set():
                progress_emit("dependency", "已取消下载", percent=0)
                return False
            if index:
                progress_emit("dependency", f"正在切换 PyPI 镜像重试（{index + 1}/{len(pypi_sources)}）", percent=90)
            dep_code, dep_output = run_pip_with_progress(
                dep_base + ["--index-url", idx_url], "正在下载 PyTorch 配套依赖",
                network=True, idle_timeout=60, pbase=90, pspan=0.08, mode="single")
            if dep_code == 130:
                progress_emit("dependency", "已取消下载", percent=0)
                return False
            if dep_code == 0:
                deps_ok = True
                break
            dep_tail = "；".join(l.strip() for l in dep_output.splitlines() if l.strip())[-200:]
        if deps_ok:
            progress_emit("dependency", "阶段 1/2 · 下载完成 100%", percent=100)
        else:
            # 不判死：主 wheel 已就绪，纯 Python 依赖复用系统环境，安装阶段以 --no-deps 方式继续
            progress_emit("dependency",
                          "配套依赖在线下载失败，将复用系统已有依赖继续安装（主安装包已就绪，无需重新下载）"
                          + (f"：{dep_tail}" if dep_tail else ""),
                          percent=96)

        # ---------- 阶段二：安装 ----------
        set_setup_phase("install")
        progress_emit("dependency", "阶段 2/2 · 正在安装到 lib 目录", percent=0)
        inst = [sys.executable, "-m", "pip", "install", "--no-input", "--disable-pip-version-check",
                "--no-index", "--find-links", wheels, "--prefer-binary", "--progress-bar", "on",
                "--ignore-installed", "--upgrade"]
        if not deps_ok:
            # wheels 中依赖不全时 --no-index 无法解析依赖，改为只装 torch 主包；
            # filelock/sympy 等纯 Python 依赖运行时从全局 site-packages 复用
            inst.append("--no-deps")
        if target:
            inst += ["--target", target]
        inst += [spec]
        code, output = run_pip_with_progress(
            inst, "正在安装 CUDA 版 PyTorch 到 lib 目录",
            network=False, idle_timeout=300, pbase=0, pspan=1.0, mode="install")
        if CANCEL_EVENT.is_set() or code == 130:
            progress_emit("dependency", "已取消安装", percent=0)
            return False
        if code != 0:
            tail = "；".join(l.strip() for l in output.splitlines() if l.strip())[-220:]
            progress_emit("dependency", "CUDA 依赖安装失败" + (f"：{tail}" if tail else ""), percent=0)
            return False
        progress_emit("dependency", "阶段 2/2 · 安装完成 100%", percent=100)

        cuda_ok, why = torch_cuda_ok(gpu_name=gpu_name)
        if cuda_ok:
            # 成功后才清理 wheels；失败/取消时保留主 wheel 与 .part，下次进入可断点续传、免重下 2.6GB
            shutil.rmtree(wheels, ignore_errors=True)
            return True
        progress_emit("dependency", f"安装完成但 CUDA 仍不可用：{why}", percent=100)
        return False
    except Exception as exc:
        progress_emit("dependency", f"安装流程异常：{exc}（已下载部分会保留，重试可断点续传）", percent=0)
        return False


def prepare_cuda_environment(device_pref):
    """ASR 启动阶段只「检查」GPU/CUDA 环境，不在此下载 CUDA 依赖。
    CPU 相关依赖（torch / qwen-asr / FFmpeg）仍由本流程的依赖阶段负责安装；
    CUDA 版依赖的下装由设置里选中双模式时弹出的安装流程负责（--gpu-setup）。
    返回 (gpu_name or None, cuda_ready)。"""
    if device_pref != "auto":
        return None, False
    progress_emit("dependency", "正在检查 GPU 与 CUDA 环境", percent=1)
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
        progress_emit("dependency",
                      f"未检测到 NVIDIA GPU，将使用 CPU 识别{card_note}", percent=10)
        return None, False
    cuda_ok, why = torch_cuda_ok(gpu_name=gpu_name)
    if cuda_ok:
        progress_emit("dependency", f"检测到 {gpu_name}，CUDA PyTorch 已就绪", percent=10)
        return gpu_name, True
    progress_emit("dependency",
                  f"检测到 {gpu_name}，但 {why}；请到「设置 → 识别设备」重新选择「GPU + CPU 双模式」以安装 CUDA 依赖，本次先用 CPU 识别",
                  percent=10)
    return gpu_name, False


def run_gpu_setup():
    """设置中选中「GPU + CPU 双模式」后独立运行的依赖安装流程。
    依次经历 检测(check) → 下载(download) → 安装(install) 三个阶段，
    通过 gpu-setup 事件回报进度，支持用户经 stdin 取消。"""
    global SETUP_MODE
    SETUP_MODE = True
    threading.Thread(target=cancel_watcher, daemon=True).start()
    set_setup_phase("check")
    progress_emit("dependency", "正在检测显卡与 CUDA 环境", percent=2)
    if CANCEL_EVENT.is_set():
        emit("gpu-setup", phase="canceled", message="已取消安装，将使用 CPU 识别")
        return 130
    gpu_name = detect_nvidia_gpu()
    if not gpu_name:
        emit("gpu-setup", phase="error", percent=0,
             message="未检测到 NVIDIA 显卡（需要 GeForce/RTX/Quadro + 最新驱动），将使用 CPU 识别")
        return 3
    progress_emit("dependency", f"检测到 {gpu_name}，正在检查 CUDA 版 PyTorch", percent=4)
    ok, why = torch_cuda_ok(gpu_name=gpu_name)
    if ok:
        emit("gpu-setup", phase="ready", percent=100, message=f"{gpu_name} 的 CUDA 依赖已就绪，无需重复下载")
        return 0
    progress_emit("dependency", f"{why}，准备下载 CUDA 版 PyTorch", percent=5)
    ok = install_cuda_torch(gpu_name)
    if CANCEL_EVENT.is_set():
        emit("gpu-setup", phase="canceled", message="已取消安装，将使用 CPU 识别")
        return 130
    if ok:
        emit("gpu-setup", phase="ready", percent=100, message="CUDA 依赖安装完成，GPU + CPU 双模式已就绪")
        return 0
    emit("gpu-setup", phase="error", percent=0, message="CUDA 依赖安装失败，将使用 CPU 识别")
    return 4


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


def warmup_audio_stack():
    """在主线程预先导入 librosa 并预热 numba JIT：
    - 避免首次推理时 CPU/GPU 两个线程并发懒加载 librosa 造成 import 锁竞争（GPU 线程会被阻塞到 CPU 线程导完）；
    - numba 缓存初始化（NamedTemporaryFile）移到主线程受控执行，缓存目录已由 NUMBA_CACHE_DIR 重定向到可写位置；
    - 一次性开销计入模型加载阶段并有心跳，首条字幕不再被音频库导入/编译阻塞。"""
    started = time.monotonic()
    done = threading.Event()

    def report():
        while not done.wait(2):
            elapsed = int(time.monotonic() - started)
            emit("status", stage="model", message=f"正在初始化音频预处理库 librosa（已用 {elapsed} 秒）", percent=17)

    thread = threading.Thread(target=report, daemon=True)
    thread.start()
    try:
        # 仅预导入：qwen 加载的 WAV 固定 16kHz，不会触发 librosa.resample，
        # 故不主动调用（首次 JIT 编译重采样函数要约 1 分钟，纯属浪费首条字幕等待时间）
        import librosa  # noqa: F401
    except Exception as exc:
        emit("status", stage="model", message=f"音频预处理库初始化异常（仍将尝试识别）：{exc}", percent=17)
    finally:
        done.set()
        thread.join(timeout=0.2)


# ==========================================================================
# 常驻热进程（daemon）：模型只加载一次，后续「开启/切换/关闭字幕」通过 stdin 命令
# 控制单个视频会话，不再重启 Python，省去每次约 20 秒的 torch/模型冷启动。
# ==========================================================================

class SessionControl:
    """一个视频识别会话的控制柄：携带播放状态、取消事件与会话有效性。"""

    def __init__(self, sid):
        self.sid = sid
        self.stop_event = threading.Event()
        self.alive = True                 # 会话被新会话取代或停止后置 False，事件随即静默
        self.state = AsrState()

    def should_stop(self):
        return self.stop_event.is_set() or not self.alive


def make_session_emit(control):
    """生成带 sid、且在会话失效后自动静默的事件发送函数。"""
    def _emit(kind, **data):
        if control.alive:
            data["sid"] = control.sid
            emit(kind, **data)
    return _emit


def make_transcriber(models, emit_fn):
    """根据模型列表构造批量转写函数（CPU+GPU 双模型并行；单模型直接调用）。"""
    def _run_model(model, paths):
        try:
            return list(model.transcribe(audio=list(paths), language=None))
        except TypeError:
            return [model.transcribe(audio=p, language=None)[0] for p in paths]

    def transcribe_paths(paths):
        if len(models) > 1 and len(paths) > 1:
            from concurrent.futures import ThreadPoolExecutor
            half = (len(paths) + 1) // 2
            cpu_part, gpu_part = paths[:half], paths[half:]
            cpu_results = gpu_results = None
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
                except Exception:
                    gpu_error = None
            if gpu_error is not None and len(models) > 1:
                models.pop()
                emit_fn("status", stage="transcribe", message=f"GPU 推理异常，已切换为纯 CPU：{gpu_error}", device="CPU")
            if cpu_results is not None and gpu_results is not None:
                return cpu_results + gpu_results
            if cpu_results is not None:
                return cpu_results + _run_model(models[0][1], gpu_part)
            if gpu_results is not None:
                return _run_model(models[0][1], cpu_part) + gpu_results
        return _run_model(models[0][1], paths)

    return transcribe_paths


def transcribe_video_session(cfg, models, ffmpeg, total, control):
    """单个视频的转写循环（由一次性进程或常驻 daemon 的会话线程调用）。
    cfg: 含 video/start/chunk；control: SessionControl。返回 'done' / 'stopped' / 错误码。"""
    emit_fn = make_session_emit(control)
    state = control.state
    transcribe_paths = make_transcriber(models, emit_fn)

    emit_fn("status", stage="audio", message="模型已加载，开始分析视频音频", percent=18)
    cache_path = cfg["video"] + ".lightplayer-subs.json"
    all_captions = []

    def save_cache(force=False):
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
        chunk_target = max(2.0, cfg.get("chunk", 4.0))
        chunk_min = max(1.0, chunk_target * 0.55)
        chunk_max = max(chunk_target + 1.0, chunk_target * 1.6)
        probe_len = chunk_max + 2.0
        behind = max(3.0, chunk_target)
        ahead = 30.0
        lead = 12.0
        completed = []
        start = max(0.0, min(cfg.get("start", 0.0), max(0.0, total - 0.1)))
        state.playhead = (start, 1.0, time.monotonic())
        batch_size = 2
        batch_min, batch_max = 2, 6
        first_batch = True
        speed_ema = None
        wav_probe = os.path.join(tmp, "probe.wav")
        video = cfg["video"]

        # 载入缓存字幕：立即下发并标记已覆盖，仅识别未覆盖部分
        if os.path.isfile(cache_path):
            try:
                with open(cache_path, "r", encoding="utf-8") as fh:
                    raw = json.load(fh)
                if isinstance(raw, dict):
                    cap_items = raw.get("captions") or []
                    covered_items = raw.get("covered") or []
                elif isinstance(raw, list):
                    cap_items, covered_items = raw, None
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
                    emit_fn("captions", items=cached_items)
                if covered_items is not None:
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
            emit_fn("status", stage="transcribe",
                    message=f"已加载缓存字幕 {len(all_captions)} 条，仅识别未覆盖部分",
                    percent=min(96, 18 + int(coverage_seconds(completed) / total * 78)))
            save_cache()

        while not control.should_stop():
            with state.lock:
                pending = state.pending_seek
                state.pending_seek = None
                pos, rate, stamp = state.playhead
            elapsed = max(0.0, time.monotonic() - stamp)
            desired = min(total, pos + rate * elapsed) if rate > 0 else pos
            if pending is not None:
                start = next_uncovered(completed, min(max(0.0, pending), max(0.0, total - 0.1)))
                emit_fn("status", stage="transcribe", message=f"已跟随跳转，从 {int(start)}s 附近继续识别",
                        percent=min(96, 18 + int(coverage_seconds(completed) / total * 78)))
            else:
                if start < desired - behind:
                    start = next_uncovered(completed, desired)
                elif start > desired + ahead:
                    start = next_uncovered(completed, 0.0)
            if start >= total - 0.05:
                gap = next_uncovered(completed, 0.0)
                if gap >= total - 0.05:
                    break
                start = gap
            segments = []
            cursor = start
            target_batch = 1 if first_batch else batch_size
            while len(segments) < target_batch:
                cursor = next_uncovered(completed, cursor)
                if cursor >= total - 0.25:
                    break
                if segments and cursor > desired + lead:
                    break
                limit = covered_limit(completed, cursor)
                if limit is not None:
                    if limit - cursor <= 0.25:
                        mark_completed(completed, cursor, limit)
                        continue
                remaining = total - cursor
                wav_path = os.path.join(tmp, f"chunk-{len(segments)}.wav")
                try:
                    if first_batch:
                        dur = min(chunk_target, remaining)
                        extract(ffmpeg, video, wav_path, cursor, dur)
                    elif remaining <= chunk_max:
                        extract(ffmpeg, video, wav_path, cursor, remaining)
                        dur = remaining
                    else:
                        extract(ffmpeg, video, wav_probe, cursor, probe_len)
                        boundary = snap_to_silence(wav_probe, chunk_target, chunk_min, chunk_max)
                        dur = boundary if boundary else chunk_target
                        slice_wav(wav_probe, wav_path, dur)
                except Exception as exc:
                    emit_fn("error", message=f"音频片段 {int(cursor)}s 提取失败：{exc}")
                    return 3
                if limit is not None:
                    dur = min(dur, limit - cursor)
                segments.append((cursor, dur, wav_path))
                cursor += dur
            if not segments:
                mark_completed(completed, start, total)
                break
            # 长批次推理期间也要响应停止：批前再检查一次
            if control.should_stop():
                break
            audio_sec = sum(d for _, d, _ in segments)
            if first_batch:
                emit_fn("status", stage="transcribe", message="正在识别当前位置的对白…", percent=18,
                        device=" + ".join(name for name, _ in models) if models else "CPU")
            t0 = time.monotonic()
            results = transcribe_paths([p for _, _, p in segments])
            wall = max(1e-6, time.monotonic() - t0)
            speed = audio_sec / wall
            speed_ema = speed if speed_ema is None else speed_ema * 0.7 + speed * 0.3
            first_batch = False
            if speed_ema < 0.95 and batch_size < batch_max:
                batch_size += 1
            elif speed_ema > 1.8 and batch_size > batch_min:
                batch_size -= 1
            # 推理期间可能已被停止/切换：丢弃本批结果
            if control.should_stop():
                break
            emit_fn("status", stage="transcribe",
                    message=f"识别音频片段 {int(segments[0][0])}s–{int(segments[-1][0] + segments[-1][1])}s · 速度 {speed_ema:.1f}×播放",
                    percent=min(96, 18 + int(coverage_seconds(completed) / total * 78)),
                    device=" + ".join(name for name, _ in models) if models else "CPU")
            try:
                for (seg_start, dur, _), res in zip(segments, results):
                    text = (res.text if res else "").strip()
                    end = min(total, seg_start + dur)
                    if text:
                        emit_fn("caption", start=seg_start, end=end, text=text)
                        all_captions.append({"start": seg_start, "end": end, "text": text})
                    mark_completed(completed, seg_start, end)
            except Exception as exc:
                emit_fn("error", message=f"音频片段 {int(segments[0][0])}s 识别失败：{exc}")
                return 3
            save_cache()
            start = next_uncovered(completed, cursor)

    if control.should_stop():
        save_cache(force=True)
        emit_fn("stopped")
        return "stopped"
    save_cache(force=True)
    emit_fn("status", stage="display", message="实时字幕识别完成", percent=100)
    emit_fn("done")
    return "done"


def setup_lib_dir(libdir):
    global LIB_DIR
    LIB_DIR = (libdir or "").strip()
    if LIB_DIR:
        try:
            os.makedirs(LIB_DIR, exist_ok=True)
            if LIB_DIR not in sys.path:
                sys.path.insert(0, LIB_DIR)
            os.environ["PYTHONPATH"] = LIB_DIR + os.pathsep + os.environ.get("PYTHONPATH", "")
        except OSError:
            pass


def load_asr_models(model_path, device_pref, emit_fn, gpu_name=None):
    """加载 torch + Qwen3 ASR 模型（常驻，仅在路径/设备变化时重复调用）。返回 (models, torch, device_pref)。"""
    if device_pref == "cpu":
        os.environ["CUDA_VISIBLE_DEVICES"] = ""
    try:
        emit_fn("status", stage="model", message="正在初始化 Qwen3-ASR：加载 PyTorch", percent=5)
        torch = import_with_heartbeat(lambda: __import__("torch"), "PyTorch")
        Qwen3ASRModel = import_with_heartbeat(load_qwen_backend, "qwen-asr Transformers 后端")
    except ModuleNotFoundError as exc:
        if getattr(exc, "name", "") == "qwen_asr":
            install_packages(["qwen-asr"])
        else:
            install_packages(["torch", "qwen-asr"])
        torch = import_with_heartbeat(lambda: __import__("torch"), "PyTorch")
        Qwen3ASRModel = import_with_heartbeat(load_qwen_backend, "qwen-asr Transformers 后端")
    torch.set_num_threads(max(1, min(8, os.cpu_count() or 1)))
    try:
        torch.set_num_interop_threads(1)
    except RuntimeError:
        pass
    cuda_ok = torch.cuda.is_available()
    if not cuda_ok and device_pref == "auto":
        emit_fn("status", stage="model",
                message=f"torch {torch.__version__}（CUDA {getattr(torch.version, 'cuda', None)}）不可用，回退 CPU 识别", percent=8)
        device_pref = "cpu"
    models = []
    if device_pref in ("auto", "cpu"):
        models.append(("CPU", load_with_heartbeat(
            lambda: Qwen3ASRModel.from_pretrained(model_path, dtype=torch.float32, device_map="cpu",
                                                  max_inference_batch_size=6, max_new_tokens=128, local_files_only=True),
            "CPU 加速模式")))
    if device_pref == "auto" and cuda_ok:
        try:
            emit_fn("status", stage="model", message="检测到 CUDA GPU，正在加载 GPU 模型（float16）", percent=13)
            gpu_name = torch.cuda.get_device_name(0)
            models.append(("GPU", load_with_heartbeat(
                lambda: Qwen3ASRModel.from_pretrained(model_path, dtype=torch.float16, device_map="cuda",
                                                      max_inference_batch_size=6, max_new_tokens=128, local_files_only=True),
                "GPU 加速模式")))
            emit_fn("status", stage="model", message=f"GPU（{gpu_name}）模型已加载，将同时使用 GPU 与 CPU 识别", percent=17)
        except Exception as exc:
            emit_fn("status", stage="model", message=f"GPU 模型加载失败，将仅使用 CPU：{exc}", percent=17)
    mode_text = " + ".join(name for name, _ in models) if models else "CPU"
    emit_fn("status", stage="model", message=f"当前识别设备：{mode_text}", percent=17, device=mode_text)
    warmup_audio_stack()
    return models, torch, device_pref


def run_daemon(libdir):
    """常驻进程：模型加载一次；stdin 命令驱动 start/stop/seek/pos/shutdown。"""
    import queue
    setup_lib_dir(libdir)
    cmd_q = queue.Queue()
    shutdown_evt = threading.Event()

    def reader():
        try:
            for line in sys.stdin:
                line = line.strip()
                if not line:
                    continue
                try:
                    cmd_q.put(json.loads(line))
                except ValueError:
                    continue
        except Exception:
            pass
        finally:
            cmd_q.put({"cmd": "shutdown"})   # 父进程关闭 stdin（退出/崩溃）时随之退出
    threading.Thread(target=reader, daemon=True).start()

    ffmpeg = None
    models = []
    loaded_key = None          # (model_path, device_pref)
    cur_control = None
    cur_thread = None
    cur_total = 0.0

    def ensure_models(model_path, device_pref, emit_fn):
        nonlocal models, loaded_key, ffmpeg
        if ffmpeg is None:
            ffmpeg = ensure_ffmpeg()
        key = (model_path, device_pref)
        if models and loaded_key == key:
            return True
        # 依赖检查（首次）
        missing = [pkg for pkg, mod in (("torch", "torch"), ("qwen-asr", "qwen_asr")) if not _module_available(mod)]
        if missing:
            emit_fn("status", stage="dependency", message="缺少 CPU 依赖：" + "、".join(missing) + "，正在安装", percent=2)
            install_packages(missing)
        else:
            emit_fn("status", stage="dependency", message="CPU 相关依赖已就绪", percent=8)
        gpu_name = None
        if device_pref == "auto":
            gpu_name, _ = prepare_cuda_environment("auto")
        emit_fn("status", stage="model", message="正在加载本地 ASR 模型", percent=8)
        models, _torch, device_pref = load_asr_models(model_path, device_pref, emit_fn, gpu_name)
        loaded_key = (model_path, device_pref)
        return True

    def stop_current(join_timeout=40):
        nonlocal cur_control, cur_thread
        c, t = cur_control, cur_thread
        if c is None:
            return
        c.alive = False
        c.stop_event.set()
        if t is not None and t.is_alive() and threading.current_thread() is not t:
            t.join(timeout=join_timeout)
        cur_control, cur_thread = None, None

    while not shutdown_evt.is_set():
        try:
            msg = cmd_q.get(timeout=0.5)
        except Exception:
            continue
        cmd = msg.get("cmd")
        if cmd == "shutdown":
            stop_current()
            break
        if cmd == "stop":
            sid = msg.get("sid")
            if cur_control is not None and (sid is None or sid == cur_control.sid):
                # 标记停止但保留 alive 直到线程退出，由会话线程发 stopped；这里置 stop_event
                cur_control.stop_event.set()
            continue
        if cmd in ("seek", "pos"):
            if cur_control is not None and cur_control.sid == msg.get("sid"):
                try:
                    p = max(0.0, float(msg.get("start", 0.0)))
                    r = max(0.0, float(msg.get("rate", 1.0)))
                except (TypeError, ValueError):
                    continue
                with cur_control.state.lock:
                    cur_control.state.playhead = (p, r, time.monotonic())
                    if cmd == "seek":
                        cur_control.state.pending_seek = p
            continue
        if cmd == "start":
            sid = int(msg.get("sid", 0))
            video = msg.get("video", "")
            model_path = msg.get("model", "")
            device_pref = msg.get("device", "cpu")
            if not video or not os.path.isfile(video):
                emit("error", sid=sid, message="找不到视频文件")
                continue
            if not os.path.isdir(model_path):
                emit("error", sid=sid, message="模型路径不存在：" + model_path)
                continue
            # 串行化：停掉并等待上一个会话结束（最多等一个批次），避免并发抢 GPU/CPU
            stop_current()
            control = SessionControl(sid)

            def session_main():
                nonlocal cur_total
                try:
                    ensure_models(model_path, device_pref, make_session_emit(control))
                    if control.should_stop():
                        return
                    total = float(msg.get("duration", 0) or 0)
                    if total <= 0:
                        total = duration(video, ffmpeg)
                    cur_total = total
                    if total <= 0:
                        make_session_emit(control)("error", message="无法读取视频时长")
                        return
                    cfg = {"video": video, "start": float(msg.get("start", 0) or 0), "chunk": float(msg.get("chunk", 4) or 4)}
                    transcribe_video_session(cfg, models, ffmpeg, total, control)
                except Exception as exc:
                    make_session_emit(control)("error", message="识别失败：" + str(exc))

            cur_control, cur_thread = control, threading.Thread(target=session_main, daemon=True)
            cur_thread.start()
            continue

    shutdown_evt.set()
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", default="")
    ap.add_argument("--model", default="")
    ap.add_argument("--model-kind", default="qwen")
    ap.add_argument("--duration", type=float, default=0.0)
    ap.add_argument("--start", type=float, default=0.0)
    ap.add_argument("--chunk", type=float, default=4.0)
    ap.add_argument("--device", default="cpu", help="识别设备：cpu（默认）/ auto（GPU + CPU 双模式）")
    ap.add_argument("--lib-dir", default="", help="GPU 相关依赖的安装目录（软件目录下的 lib）")
    ap.add_argument("--gpu-setup", action="store_true", help="仅执行 GPU 依赖检测与安装，不启动转写")
    ap.add_argument("--daemon", action="store_true", help="常驻热进程：模型加载一次，通过 stdin 命令管理会话")
    args = ap.parse_args()
    # 常驻热进程模式（主进程正常使用的路径）：不需要 --video，由 stdin 命令驱动
    if args.daemon:
        return run_daemon(args.lib_dir)
    # 把 lib 目录加入模块搜索路径，使安装到 lib 的 CUDA 版 torch 优先于全局版本
    global LIB_DIR
    LIB_DIR = (args.lib_dir or "").strip()
    if LIB_DIR:
        try:
            os.makedirs(LIB_DIR, exist_ok=True)
            if LIB_DIR not in sys.path:
                sys.path.insert(0, LIB_DIR)
            os.environ["PYTHONPATH"] = LIB_DIR + os.pathsep + os.environ.get("PYTHONPATH", "")
        except OSError:
            pass
    # 设置里选中双模式后触发的独立依赖安装流程（不涉及视频/模型）
    if args.gpu_setup:
        return run_gpu_setup()
    if not args.video:
        emit("error", message="缺少视频参数")
        return 2
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
    # 依赖阶段：只检查和安装 CPU 相关依赖（torch / qwen-asr / FFmpeg）；
    # CUDA 版依赖不在此安装，需在「设置 → 识别设备」选择 GPU + CPU 双模式时安装。
    if args.model_kind == "qwen":
        missing = [pkg for pkg, mod in (("torch", "torch"), ("qwen-asr", "qwen_asr")) if not _module_available(mod)]
        if missing:
            progress_emit("dependency", "缺少 CPU 依赖：" + "、".join(missing) + "，正在自动下载并安装", percent=2)
            try:
                install_packages(missing)
            except subprocess.CalledProcessError as exc:
                if exc.returncode == 130:
                    emit("error", message="已取消依赖安装")
                else:
                    emit("error", message=f"自动安装 CPU 依赖失败（退出码 {exc.returncode}）。请检查网络连接和 pip 权限。")
                return 2
        else:
            progress_emit("dependency", "CPU 相关依赖已就绪（CUDA 依赖请在设置中选择双模式安装）", percent=8)
    # 设备模式：cpu（默认，仅 CPU）/ auto（GPU + CPU 双模式）；GPU 检查纳入依赖阶段
    device_pref = (args.device or "cpu").lower()
    if device_pref not in ("auto", "cpu"):
        device_pref = "cpu"
    if device_pref == "cpu":
        # 仅 CPU 模式隐藏 GPU；auto 模式必须保留 CUDA 可见性，否则 torch 永远检测不到 GPU
        os.environ["CUDA_VISIBLE_DEVICES"] = ""
    gpu_name = None
    if args.model_kind == "qwen":
        gpu_name, cuda_ready = prepare_cuda_environment(device_pref)
    emit("status", stage="model", message="正在加载本地 ASR 模型", percent=8)
    try:
        if args.model_kind == "qwen":
            try:
                emit("status", stage="model", message="正在初始化 Qwen3-ASR：加载 PyTorch", percent=5)
                torch=import_with_heartbeat(lambda: __import__("torch"), "PyTorch")
                Qwen3ASRModel=import_with_heartbeat(load_qwen_backend, "qwen-asr Transformers 后端")
            except ModuleNotFoundError as exc:
                missing=getattr(exc,"name","")
                # GPU 依赖只在「设置 → 识别设备」选中双模式时安装；此处仅补装 CPU 版基础依赖
                if missing == "qwen_asr":
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
            if not cuda_ok and device_pref == "auto":
                # 本进程已 import torch，直接用进程内信息汇总原因，不再起子进程重复冷加载
                try:
                    why = f"torch {torch.__version__}（CUDA {getattr(torch.version, 'cuda', None)}）初始化 GPU 失败，" \
                          f"可能是驱动过旧或显存被占满"
                except Exception as exc:
                    why = str(exc)
                gpu_note = f"已检测到显卡 {gpu_name}，" if gpu_name else "未检测到 NVIDIA 显卡，"
                emit("status", stage="model", message=f"GPU + CPU 双模式回退 CPU：{gpu_note}{why}", percent=8)
                device_pref = "cpu"
            models = []
            if device_pref in ("auto", "cpu"):
                models.append(("CPU", load_with_heartbeat(lambda: Qwen3ASRModel.from_pretrained(args.model,dtype=torch.float32,device_map="cpu",max_inference_batch_size=6,max_new_tokens=128,local_files_only=True), "CPU 加速模式")))
            if device_pref == "auto" and cuda_ok:
                try:
                    emit("status", stage="model", message="检测到 CUDA GPU，正在加载 GPU 模型（float16）", percent=13)
                    gpu_name = torch.cuda.get_device_name(0)
                    models.append(("GPU", load_with_heartbeat(lambda: Qwen3ASRModel.from_pretrained(args.model,dtype=torch.float16,device_map="cuda",max_inference_batch_size=6,max_new_tokens=128,local_files_only=True), "GPU 加速模式")))
                    emit("status", stage="model", message=f"GPU（{gpu_name}）模型已加载，将同时使用 GPU 与 CPU 识别", percent=17)
                except Exception as exc:
                    emit("status", stage="model", message=f"GPU 模型加载失败，将仅使用 CPU：{exc}", percent=17)
            mode_text = " + ".join(name for name, _ in models) if models else "CPU"
            emit("status", stage="model", message=f"当前识别设备：{mode_text}", percent=17, device=mode_text)
            # 主线程预热 librosa/numba，避免首条字幕被懒加载与缓存初始化卡住
            warmup_audio_stack()
        else:
            emit("error", message="系统语音识别不能处理本地视频音轨，请选择 Qwen3-ASR")
            return 2
    except ModuleNotFoundError as exc:
        missing=getattr(exc,"name","依赖包")
        emit("error", message=f"模型加载失败：缺少 Python 依赖 {missing}。请安装 torch 和 qwen-asr。")
        return 2
    except subprocess.CalledProcessError as exc:
        if exc.returncode == 130:
            emit("error", message="已取消依赖安装")
        else:
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
        first_batch = True      # 首批只取 1 段，尽快把首条字幕送到画面，之后再按批量吞吐
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
            # 首批仅组 1 段：单段走单模型推理，省掉第二段音频提取与 GPU 线程同步等待
            target_batch = 1 if first_batch else batch_size
            while len(segments) < target_batch:
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
                    if first_batch:
                        # 首批直接提取 chunk_target 秒（跳过 VAD 探测），最快拿到首个推理输入
                        dur = min(chunk_target, remaining)
                        extract(ffmpeg, args.video, wav_path, cursor, dur)
                    elif remaining <= chunk_max:
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
            if first_batch:
                # 首批立即把 UI 从「分析音频」切到「实时转写」，让用户知道已进入识别
                emit("status", stage="transcribe", message="正在识别当前位置的对白…", percent=18,
                     device=" + ".join(name for name, _ in models) if models else "CPU")
            t0 = time.monotonic()
            results = transcribe_paths([p for _, _, p in segments])
            wall = max(1e-6, time.monotonic() - t0)
            speed = audio_sec / wall
            speed_ema = speed if speed_ema is None else speed_ema * 0.7 + speed * 0.3
            first_batch = False
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
