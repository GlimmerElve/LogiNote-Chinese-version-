"""SenseVoice (sherpa-onnx) WebSocket 服务端

监听 ws://127.0.0.1:8765，供前端（FlowMode / ReviewChat）做本地语音转文字。

识别引擎：sherpa-onnx 的 OfflineRecognizer（SenseVoice q8 量化模型，纯 ONNX）。
录音 + 分句：pyaudio 采集 16kHz 单声道，silero VAD 检测静音切分句子，
            每个完整句子喂给 sherpa-onnx 识别。

通信协议（JSON，与旧 RealtimeSTT 版本保持一致，前端无感知）：
  客户端 -> 服务端：
      {"type": "start"}    开始持续监听并累积转写
      {"type": "stop"}     停止监听，返回逗号拼接后的最终文本
      {"type": "warmup"}   预加载模型（提前初始化）
      {"type": "shutdown"} 释放资源
  服务端 -> 客户端：
      {"type": "partial", "text": "..."}  实时累积进度
      {"type": "final",   "text": "..."}  停止后最终文本
      {"type": "ready"}                   模型预加载完成
      {"type": "error",   "message": "..."} 出错
"""

import asyncio
import json
import logging
import os
import threading
import wave
import io
import sys

import numpy as np
import sherpa_onnx
import websockets

# 延迟导入重依赖，避免 warmup 前占用
_pyaudio = None


def _get_pyaudio():
    global _pyaudio
    if _pyaudio is None:
        import pyaudio
        _pyaudio = pyaudio
    return _pyaudio


HOST = "127.0.0.1"
PORT = 8765
SAMPLE_RATE = 16000
CHANNELS = 1
CHUNK = 512  # 每次读取的采样点（约 32ms @16k）

# 模型目录解析优先级：
# 1) 环境变量 LOGINOTE_MODELS_DIR（由 Electron 主进程 spawn 时注入，打包模式下必需）
# 2) 源码运行时按 __file__ 推导（python/stt_server.py → 上级 models/）
_ENV_MODELS_DIR = os.environ.get("LOGINOTE_MODELS_DIR", "")
if _ENV_MODELS_DIR:
    MODELS_DIR = _ENV_MODELS_DIR
else:
    _BASE_DIR = os.path.dirname(os.path.abspath(__file__))
    MODELS_DIR = os.path.join(os.path.dirname(_BASE_DIR), "models")

SENSEVOICE_DIR = os.path.join(MODELS_DIR, "sherpa-onnx-sense-voice")
MODEL_PATH = os.path.join(SENSEVOICE_DIR, "model_q8.onnx")
TOKENS_PATH = os.path.join(SENSEVOICE_DIR, "tokens.txt")

# 热词列表（英文），识别后通过编辑距离纠错；后续可移动态配置
HOTWORDS = [
    # 例如 "React", "PyTorch", "Kaggle"
]

logging.basicConfig(level=logging.INFO, format="[stt] %(asctime)s %(levelname)s %(message)s")

_recognizer = None
_recognizer_lock = threading.Lock()
_recognizer_ready = threading.Event()

_session = None


class SttSession:
    def __init__(self):
        self.buffer = []
        self.listening = False
        self.worker = None
        self.lock = threading.Lock()

    def append(self, sentence: str):
        with self.lock:
            self.buffer.append(sentence)

    def clear(self):
        with self.lock:
            self.buffer = []

    def joined(self) -> str:
        with self.lock:
            return "".join(self.buffer)


def get_session() -> SttSession:
    global _session
    if _session is None:
        _session = SttSession()
    return _session


def get_recognizer():
    """懒加载 sherpa-onnx 识别器。"""
    global _recognizer
    if _recognizer is None:
        with _recognizer_lock:
            if _recognizer is None:
                logging.info("初始化 sherpa-onnx SenseVoice（%s）...", MODEL_PATH)
                _recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
                    model=MODEL_PATH,
                    tokens=TOKENS_PATH,
                    provider="cpu",
                    num_threads=max(2, (os.cpu_count() or 4) // 2),
                    use_itn=True,
                    sample_rate=SAMPLE_RATE,
                    debug=False,
                )
                _recognizer_ready.set()
                logging.info("sherpa-onnx SenseVoice 初始化完成")
    return _recognizer


def recognize_audio(audio: np.ndarray) -> str:
    """识别一段 float32 音频，返回文本。"""
    rec = get_recognizer()
    stream = rec.create_stream()
    stream.accept_waveform(SAMPLE_RATE, audio)
    rec.decode_stream(stream)
    return stream.result.text.strip()


def _normalize_punctuation(text: str) -> str:
    text = text.replace(",", "，").replace(".", "。")
    return text


def _edit_distance(s1: str, s2: str) -> int:
    """Levenshtein 距离（小写比较）。"""
    a, b = s1.lower(), s2.lower()
    m, n = len(a), len(b)
    if m == 0:
        return n
    if n == 0:
        return m
    prev = list(range(n + 1))
    for i in range(1, m + 1):
        cur = [i] + [0] * n
        for j in range(1, n + 1):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
        prev = cur
    return prev[n]


def apply_hotwords(text: str) -> str:
    """识别后热词纠错：把与热词相差 1~2 个字母的词替换为正确热词。"""
    if not HOTWORDS or not text:
        return text
    words = text.split()
    out = []
    for w in words:
        matched = None
        for hw in HOTWORDS:
            if abs(len(w) - len(hw)) <= 2 and _edit_distance(w, hw) <= 2:
                matched = hw
                break
        out.append(matched if matched else w)
    return " ".join(out)


async def safe_send(ws, payload):
    try:
        await ws.send(json.dumps(payload, ensure_ascii=False))
    except Exception:
        pass


def listen_worker(loop, ws):
    """后台线程：录音 + VAD 分句 + 识别 + 推 partial。"""
    session = get_session()
    pa = _get_pyaudio()

    try:
        p = pa.PyAudio()
    except Exception as e:
        logging.error("打开 pyaudio 失败: %s", e)
        asyncio.run_coroutine_threadsafe(
            safe_send(ws, {"type": "error", "message": "无法打开麦克风设备"}),
            loop,
        )
        return

    try:
        stream = p.open(
            format=pa.paInt16,
            channels=CHANNELS,
            rate=SAMPLE_RATE,
            input=True,
            frames_per_buffer=CHUNK,
        )
    except Exception as e:
        logging.error("打开麦克风流失败: %s", e)
        p.terminate()
        asyncio.run_coroutine_threadsafe(
            safe_send(ws, {"type": "error", "message": "无法打开麦克风流"}),
            loop,
        )
        return

    frames = []          # 当前句子的原始 int16 数据
    is_speech = False    # 当前是否在说话
    silence_frames = 0   # 连续静音帧计数
    # 静音判定阈值：约 0.6 秒静音（每帧 32ms）即认为一句结束
    SILENCE_THRESHOLD = int(0.6 * SAMPLE_RATE / CHUNK)

    def flush_sentence():
        nonlocal frames, is_speech, silence_frames
        if len(frames) == 0:
            return
        audio = np.concatenate(frames).astype(np.float32) / 32768.0
        frames = []
        is_speech = False
        silence_frames = 0
        try:
            text = recognize_audio(audio)
            text = _normalize_punctuation(text)
            text = apply_hotwords(text)
            if text:
                # 逐句增量：每停顿一句推这一句（不再累积全文），前端追加写框
                asyncio.run_coroutine_threadsafe(
                    safe_send(ws, {"type": "partial", "text": text}),
                    loop,
                )
        except Exception as e:
            logging.warning("识别异常: %s", e)

    try:
        while session.listening:
            data = stream.read(CHUNK, exception_on_overflow=False)
            chunk = np.frombuffer(data, dtype=np.int16)

            # 纯能量阈值分句（不依赖 torch / silero VAD，便于打包分发）
            voiced = (np.abs(chunk).mean() > 300)

            if voiced:
                is_speech = True
                silence_frames = 0
                frames.append(chunk.copy())
            else:
                if is_speech:
                    silence_frames += 1
                    frames.append(chunk.copy())
                    if silence_frames >= SILENCE_THRESHOLD:
                        flush_sentence()

        # 循环结束时冲刷剩余音频
        flush_sentence()
    except Exception as e:
        logging.warning("录音循环异常: %s", e)
    finally:
        stream.stop_stream()
        stream.close()
        p.terminate()


async def handle(ws):
    loop = asyncio.get_running_loop()
    session = get_session()

    async for raw in ws:
        try:
            msg = json.loads(raw)
        except Exception:
            continue

        typ = msg.get("type")

        if typ == "start":
            session.clear()
            session.listening = True

            def _start():
                try:
                    get_recognizer()
                except Exception as e:
                    logging.error("初始化识别器失败: %s", e)
                    asyncio.run_coroutine_threadsafe(
                        safe_send(ws, {"type": "error", "message": str(e)}), loop
                    )
                    session.listening = False
                    return
                session.worker = threading.Thread(
                    target=listen_worker, args=(loop, ws), daemon=True
                )
                session.worker.start()

            threading.Thread(target=_start, daemon=True).start()
            logging.info("开始监听，累积转写")

        elif typ == "warmup":
            if _recognizer_ready.is_set():
                await safe_send(ws, {"type": "ready"})
            else:
                def _do_warmup(w=ws):
                    try:
                        get_recognizer()
                        asyncio.run_coroutine_threadsafe(
                            safe_send(w, {"type": "ready"}), loop
                        )
                    except Exception as e:
                        logging.warning("warmup 失败: %s", e)
                        asyncio.run_coroutine_threadsafe(
                            safe_send(w, {"type": "error", "message": str(e)}), loop
                        )

                threading.Thread(target=_do_warmup, daemon=True).start()
                logging.info("开始预加载模型")

        elif typ == "stop":
            session.listening = False
            if session.worker and session.worker.is_alive():
                session.worker.join(timeout=5.0)
            # worker 退出前会把最后半句识别并投递 partial；
            # 让出控制权，确保该 partial 先于下面的 final 发出，避免竞态。
            await asyncio.sleep(0)
            logging.info("停止监听")
            # final 仅作「结束信号」，不再携带文本（内容已由 partial 逐句推送）
            await safe_send(ws, {"type": "final", "text": ""})

        elif typ == "shutdown":
            session.listening = False
            if session.worker and session.worker.is_alive():
                session.worker.join(timeout=2.0)


async def main(port: int):
    logging.info("STT WebSocket 服务监听 ws://%s:%d", HOST, port)
    async with websockets.serve(handle, HOST, port):
        await asyncio.Future()


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="SenseVoice STT WebSocket server")
    parser.add_argument("--port", type=int, default=8765, help="WebSocket 监听端口")
    args = parser.parse_args()
    try:
        asyncio.run(main(args.port))
    except KeyboardInterrupt:
        pass
