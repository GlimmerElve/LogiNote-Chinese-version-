/** STT WebSocket 客户端（与 Electron 主进程 spawn 的 python stt_server.py 通信，动态端口） */

async function getSttWsUrl(): Promise<string> {
  const api = (window as any).electronAPI?.stt;
  if (api?.getPort) {
    const port = await api.getPort();
    if (port && port > 0) return `ws://127.0.0.1:${port}`;
  }
  // 兜底：开发态/无 IPC 时回退固定端口
  return 'ws://127.0.0.1:8765';
}

type SttPartialCallback = (text: string) => void;
type SttFinalCallback = (text: string) => void;
type SttErrorCallback = (message: string) => void;

interface PendingStop {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
}

let ws: WebSocket | null = null;
let currentPartial: SttPartialCallback | null = null;
let currentFinal: SttFinalCallback | null = null;
let currentError: SttErrorCallback | null = null;
let pendingStop: PendingStop | null = null;
let stopTimer: ReturnType<typeof setTimeout> | null = null;

// 模型就绪状态（warmup 完成后置 true，供 UI 显示加载态）
let modelReady = false;
const modelReadyListeners = new Set<() => void>();

function setModelReady(ready: boolean): void {
  modelReady = ready;
  for (const listener of modelReadyListeners) {
    listener();
  }
}

async function ensureConnected(): Promise<WebSocket> {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    if (ws.readyState === WebSocket.OPEN) {
      return ws;
    }
    return new Promise((resolve, reject) => {
      ws!.addEventListener('open', () => resolve(ws as WebSocket), { once: true });
      ws!.addEventListener('error', () => reject(new Error('STT 服务连接失败')), { once: true });
    });
  }

  const url = await getSttWsUrl();

  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    ws = socket;

    socket.addEventListener('open', () => resolve(socket), { once: true });
    socket.addEventListener('error', () => {
      ws = null;
      reject(new Error('无法连接本地 STT 服务，请确认语音服务已启动'));
    }, { once: true });

    socket.addEventListener('message', (event: MessageEvent) => handleMessage(event));
    socket.addEventListener('close', () => {
      ws = null;
      if (pendingStop) {
        pendingStop.reject(new Error('STT 服务已断开'));
        clearStopTimer();
      }
    });
  });
}

function clearStopTimer(): void {
  if (stopTimer) {
    clearTimeout(stopTimer);
    stopTimer = null;
  }
  pendingStop = null;
}

function handleMessage(event: MessageEvent): void {
  let data: { type?: string; text?: string; message?: string };
  try {
    data = JSON.parse(String(event.data));
  } catch {
    return;
  }

  if (data.type === 'partial' && typeof data.text === 'string') {
    currentPartial?.(data.text);
  } else if (data.type === 'final') {
    if (pendingStop) {
      pendingStop.resolve(data.text ?? '');
      clearStopTimer();
    } else {
      currentFinal?.(data.text ?? '');
    }
  } else if (data.type === 'ready') {
    setModelReady(true);
  } else if (data.type === 'error') {
    const msg = data.message || '语音识别出错';
    if (pendingStop) {
      pendingStop.reject(new Error(msg));
      clearStopTimer();
    } else {
      currentError?.(msg);
    }
  }
}

/** 开始录音转写 */
export async function startStt(
  onPartial: SttPartialCallback,
  onFinal: SttFinalCallback,
  onError: SttErrorCallback,
): Promise<void> {
  currentPartial = onPartial;
  currentFinal = onFinal;
  currentError = onError;

  const socket = await ensureConnected();
  socket.send(JSON.stringify({ type: 'start', lang: 'zh' }));
}

/** 查询模型是否已就绪 */
export function isModelReady(): boolean {
  return modelReady;
}

/** 订阅模型就绪状态变化；返回取消订阅函数 */
export function subscribeModelReady(listener: () => void): () => void {
  modelReadyListeners.add(listener);
  return () => modelReadyListeners.delete(listener);
}

/** 预加载模型（提前初始化，避免首次语音等待 18 秒左右） */
export async function warmupStt(): Promise<void> {
  const socket = await ensureConnected();

  // 已就绪则直接返回
  if (modelReady) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      let data: { type?: string; message?: string };
      try {
        data = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (data.type === 'ready') {
        socket.removeEventListener('message', onMessage);
        setModelReady(true);
        resolve();
      } else if (data.type === 'error') {
        socket.removeEventListener('message', onMessage);
        reject(new Error(data.message || '模型加载失败'));
      }
    };
    socket.addEventListener('message', onMessage);
    socket.send(JSON.stringify({ type: 'warmup' }));

    // 超时保护（模型加载通常 18s 左右，给足 60s）
    setTimeout(() => {
      socket.removeEventListener('message', onMessage);
      reject(new Error('模型加载超时'));
    }, 60000);
  });
}

/** 停止录音，返回最终转写文本；超时或出错会 reject */
export function stopStt(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error('STT 服务未连接'));
      return;
    }

    pendingStop = { resolve, reject };
    stopTimer = setTimeout(() => {
      reject(new Error('语音识别超时'));
      clearStopTimer();
    }, 120000);

    ws.send(JSON.stringify({ type: 'stop' }));
  });
}

/** 断开连接（组件卸载时调用） */
export function disconnectStt(): void {
  if (stopTimer) {
    clearTimeout(stopTimer);
    stopTimer = null;
  }
  pendingStop = null;
  currentPartial = null;
  currentFinal = null;
  currentError = null;
  if (ws) {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    ws = null;
  }
}
