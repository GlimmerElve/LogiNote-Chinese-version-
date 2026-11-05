"""SenseVoice (sherpa-onnx) WebSocket 服务端

监听 ws://127.0.0.1:8765，供前端（FlowMode / ReviewChat）做本地语音转文字。

识别引擎：sherpa-onnx 的 OfflineRecognizer（SenseVoice q8 量化模型，纯 ONNX）。
录音 + 分句：pyaudio 采集 16kHz 单声道，Silero VAD 检测语音边界，
            每个完整句子喂给 sherpa-onnx 识别。

通信协议（JSON，与旧 RealtimeSTT 版本保持一致，前端无感知）：
  客户端 -> 服务端：
      {"type": "start", "endSilenceMs": 1200}
                             开始持续监听并累积转写；可选句末静音时长
      {"type": "stop"}     停止监听，冲刷末句后返回结束信号
      {"type": "warmup"}   预加载模型（提前初始化）
      {"type": "shutdown"} 释放资源
  服务端 -> 客户端：
      {"type": "partial", "text": "..."}  实时累积进度
      {"type": "final",   "text": ""}     停止后的结束信号（正文已逐句推送）
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
DEFAULT_END_SILENCE_MS = 1200
MIN_END_SILENCE_MS = 500
MAX_END_SILENCE_MS = 3000
FALLBACK_ENERGY_THRESHOLD = 300

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
VAD_MODEL_PATH = os.path.join(SENSEVOICE_DIR, "silero-vad", "model.onnx")

# 会话级热词缓存（识别后中文纠错用，由 start 消息动态更新）
_hotwords = []


def set_hotwords(words):
    global _hotwords
    # 两字词容许 1 字编辑距离会将大量正常词误改（如“事情”→“共情”）。
    # 两字词若已精确识别无需替换，因此只将 3 字及以上词条用于模糊纠错。
    _hotwords = [w.strip() for w in (words or []) if isinstance(w, str) and len(w.strip()) >= 3]
    # 长词优先，保证更长的专有名词先参与匹配
    _hotwords.sort(key=len, reverse=True)

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
        self.end_silence_ms = DEFAULT_END_SILENCE_MS

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


def create_vad(end_silence_ms: int):
    """创建真实的 Silero VAD。

    SenseVoice 是离线句级识别器，因此切句质量会直接影响识别质量。
    1.2s 的默认句末静音更适合“边想边说”的学习复述；输入仍可在
    start 消息中覆盖，便于后续做设置项或 A/B 测试。
    """
    silero = sherpa_onnx.SileroVadModelConfig(
        model=VAD_MODEL_PATH,
        threshold=0.5,
        min_silence_duration=end_silence_ms / 1000.0,
        min_speech_duration=0.25,
        window_size=CHUNK,
        max_speech_duration=30,
    )
    config = sherpa_onnx.VadModelConfig(
        silero_vad=silero,
        sample_rate=SAMPLE_RATE,
        num_threads=1,
        provider="cpu",
        debug=False,
    )
    if not config.validate():
        raise RuntimeError(f"Silero VAD 配置无效: {VAD_MODEL_PATH}")
    return sherpa_onnx.VoiceActivityDetector(config, buffer_size_in_seconds=60)


def normalize_end_silence_ms(value) -> int:
    """解析客户端分句配置，并限制在可用范围内。"""
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = DEFAULT_END_SILENCE_MS
    return max(MIN_END_SILENCE_MS, min(MAX_END_SILENCE_MS, parsed))


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
    """识别后热词纠错（中文友好）：
    不按空格分词，而是对整段文本做「字符级滑动窗口 + 编辑距离 ≤1」匹配，
    把与 3 字及以上热词相差 1 个字的连续子串替换为正确热词。
    热词已按长度降序，长词优先。
    """
    if not _hotwords or not text:
        return text

    for hw in _hotwords:
        hlen = len(hw)
        if hlen <= 0:
            continue
        # 依次尝试：等长 / 多一字 / 少一字 的窗口（覆盖识别多字或漏字）
        for win_len in (hlen, hlen + 1, hlen - 1):
            if win_len <= 0 or win_len > len(text):
                continue
            replaced = False
            i = 0
            while i <= len(text) - win_len:
                sub = text[i:i + win_len]
                # 跳过纯空白/纯标点窗口，避免把标点误替成热词
                if sub.strip() and _edit_distance(sub, hw) <= 1:
                    text = text[:i] + hw + text[i + win_len:]
                    replaced = True
                    # 替换后跳过已替换的热词长度，继续向后扫描，避免在本位置重复匹配造成死循环
                    i += len(hw)
                    continue
                i += 1
            if replaced:
                break
    return text


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

    frames = []          # Silero 不可用时的能量分句兜底缓冲
    is_speech = False
    silence_frames = 0
    silence_threshold = max(
        1, int(session.end_silence_ms * SAMPLE_RATE / CHUNK / 1000)
    )

    try:
        vad = create_vad(session.end_silence_ms)
        logging.info("使用 Silero VAD，句末静音 %dms", session.end_silence_ms)
    except Exception as e:
        vad = None
        logging.warning("Silero VAD 初始化失败，回退能量分句: %s", e)

    def emit_transcript(audio: np.ndarray):
        if audio.size == 0:
            return
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

    def drain_vad_segments():
        while vad is not None and not vad.empty():
            segment = vad.front
            audio = np.asarray(segment.samples, dtype=np.float32)
            vad.pop()
            emit_transcript(audio)

    def flush_fallback_sentence():
        nonlocal frames, is_speech, silence_frames
        if len(frames) == 0:
            return
        audio = np.concatenate(frames).astype(np.float32) / 32768.0
        frames = []
        is_speech = False
        silence_frames = 0
        emit_transcript(audio)

    try:
        while session.listening:
            data = stream.read(CHUNK, exception_on_overflow=False)
            chunk = np.frombuffer(data, dtype=np.int16)

            if vad is not None:
                vad.accept_waveform(chunk.astype(np.float32) / 32768.0)
                drain_vad_segments()
                continue

            # Silero 不可用时才使用纯能量阈值分句。
            voiced = (np.abs(chunk).mean() > FALLBACK_ENERGY_THRESHOLD)

            if voiced:
                is_speech = True
                silence_frames = 0
                frames.append(chunk.copy())
            else:
                if is_speech:
                    silence_frames += 1
                    frames.append(chunk.copy())
                    if silence_frames >= silence_threshold:
                        flush_fallback_sentence()

        # 循环结束时冲刷剩余音频
        if vad is not None:
            vad.flush()
            drain_vad_segments()
        else:
            flush_fallback_sentence()
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
            # 更新本会话热词库（knowledge 标题 + 别名，由前端随 start 下发）
            set_hotwords(msg.get("hotwords"))
            session.end_silence_ms = normalize_end_silence_ms(msg.get("endSilenceMs"))
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
            logging.info(
                "开始监听，累积转写（句末静音 %dms，热词 %d 个）",
                session.end_silence_ms,
                len(_hotwords),
            )

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
