/** 语音识别 Hook — 内部改用 RealtimeSTT（WebSocket 到本地 Python 服务） */
import { useState, useRef, useEffect, useCallback } from 'react';
import {
  startStt,
  stopStt,
  disconnectStt,
  warmupStt,
  isModelReady,
  subscribeModelReady,
} from './sttClient';

export function useSpeechRecognition() {
  const [isListening, setIsListening] = useState(false);
  const [status, setStatus] = useState<'idle' | 'listening' | 'detected' | 'converting'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [modelReady, setModelReadyState] = useState(isModelReady());
  const isListeningRef = useRef(false);
  /** 本轮 partial 回调（逐句增量写入），stop 后清空 */
  const onPartialRef = useRef<((text: string) => void) | null>(null);

  useEffect(() => {
    // 订阅模型就绪状态变化，同步到 React state
    const unsubscribe = subscribeModelReady(() => setModelReadyState(true));
    return unsubscribe;
  }, []);

  /** 预加载模型（组件挂载时调用，提前初始化避免首次语音等待） */
  const warmup = useCallback(() => {
    if (isModelReady()) return;
    warmupStt().catch((e: Error) => {
      console.warn('模型预热失败:', e?.message);
    });
  }, []);

  function _stopRecognition() {
    disconnectStt();
    isListeningRef.current = false;
    setIsListening(false);
    setStatus('idle');
  }

  function startListening(onPartial?: (text: string) => void) {
    onPartialRef.current = onPartial ?? null;
    setError(null);
    isListeningRef.current = true;
    setIsListening(true);
    setStatus('listening');

    startStt(
      (text) => {
        // 收到 partial：逐句增量，立即写入输入框
        setStatus('detected');
        onPartialRef.current?.(text);
      },
      () => {
        // 服务端仅在 stop 时回 final（现为空信号），不承载正文
      },
      (message: string) => {
        console.warn('语音识别错误:', message);
        setError(message);
        _stopRecognition();
      },
    ).catch((e: Error) => {
      console.warn('启动语音识别失败:', e?.message);
      setError(e?.message || '启动语音识别失败');
      _stopRecognition();
    });
  }

  async function stopListening(): Promise<void> {
    isListeningRef.current = false;
    setIsListening(false);
    setStatus('idle');

    try {
      // final 现为空信号，正文已由 partial 逐句写入，无需再取返回值
      await stopStt();
    } catch (e: any) {
      console.warn('停止语音识别失败:', e?.message);
      setError(e?.message || '语音识别出错');
    } finally {
      onPartialRef.current = null;
    }
  }

  return {
    isListening,
    status,
    error,
    modelReady,
    startListening,
    stopListening,
    warmup,
    _stopRecognition,
  };
}