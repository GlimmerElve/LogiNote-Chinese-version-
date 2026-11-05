import { MERMAID_CARD_TIMEOUT_MS, MERMAID_IMPORT_TIMEOUT_MS } from './mermaidRenderQueue';
import type { TextbookVisualInput } from './textbookVisualTypes';

export interface MermaidFrameResult { svg: string; readingWidth: number }
export interface MermaidFrameRequest extends TextbookVisualInput { signal: AbortSignal }
interface MermaidFrameEnvironment {
  owner: Document;
  eventTarget: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  frameUrl: string;
  bootTimeoutMs?: number;
  renderTimeoutMs?: number;
  nonce?: () => string;
}
interface ActiveRequest {
  requestId: string;
  resolve: (result: MermaidFrameResult) => void;
  reject: (error: unknown) => void;
  signal: AbortSignal;
  abort: () => void;
  timer: ReturnType<typeof setTimeout>;
}
function aborted(): Error { const error = new Error('图示任务已取消'); error.name = 'AbortError'; return error; }

/** One lazy, reusable frame per reader window. Callers serialize cards using the
 * shared render queue. Removing a failed/aborted frame prevents its stale result
 * from poisoning retry; successful renders keep the parsed Mermaid module warm. */
export function createMermaidFrameRenderer(environment: MermaidFrameEnvironment) {
  let frame: HTMLIFrameElement | undefined, session = '', sequence = 0, listening = false;
  let ready: Promise<void> | undefined, readyResolve: (() => void) | undefined, readyReject: ((error: unknown) => void) | undefined;
  let bootTimer: ReturnType<typeof setTimeout> | undefined, active: ActiveRequest | undefined;
  const destroyFrame = (error: unknown) => {
    clearTimeout(bootTimer); bootTimer = undefined;
    const reject = readyReject;
    ready = undefined; readyResolve = undefined; readyReject = undefined;
    const old = frame; frame = undefined; session = '';
    old?.remove(); reject?.(error);
  };
  const finish = (error?: unknown, result?: MermaidFrameResult) => {
    const current = active; if (!current) return;
    active = undefined;
    clearTimeout(current.timer); current.signal.removeEventListener('abort', current.abort);
    if (error !== undefined) { destroyFrame(error); current.reject(error); }
    else current.resolve(result!);
  };
  const receive = (event: MessageEvent) => {
    const value = event.data;
    // file: frames have opaque "null" origins. Exact source identity and a fresh
    // session nonce bind both ready and result messages to our packaged frame.
    if (!frame || event.source !== frame.contentWindow || !value || typeof value !== 'object' || value.session !== session) return;
    if (value.kind === 'loginote-mermaid-ready') {
      clearTimeout(bootTimer); bootTimer = undefined;
      readyResolve?.(); readyResolve = undefined; readyReject = undefined;
      return;
    }
    if (!active || value.requestId !== active.requestId) return;
    if (value.kind === 'loginote-mermaid-error') {
      finish(new Error(typeof value.error === 'string' ? value.error.slice(0, 500) : '图示渲染失败')); return;
    }
    if (value.kind !== 'loginote-mermaid-result') return;
    if (typeof value.svg !== 'string' || value.svg.length > 1_000_000 || !Number.isFinite(value.readingWidth)
      || value.readingWidth < 1 || value.readingWidth > 4096) { finish(new Error('图示返回结果无效')); return; }
    finish(undefined, { svg: value.svg, readingWidth: value.readingWidth });
  };
  const ensureFrame = () => {
    if (ready) return ready;
    if (!listening) { environment.eventTarget.addEventListener('message', receive as EventListener); listening = true; }
    session = environment.nonce?.() || globalThis.crypto.randomUUID();
    const url = new URL(environment.frameUrl); url.searchParams.set('session', session);
    const created = environment.owner.createElement('iframe'); frame = created;
    created.dataset.textbookMermaidFrame = 'true'; created.setAttribute('title', '图示后台渲染');
    created.setAttribute('aria-hidden', 'true'); created.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    created.inert = true; created.tabIndex = -1;
    Object.assign(created.style, { position: 'fixed', left: '-100000px', top: '0', width: '960px', height: '1000px',
      contain: 'strict', opacity: '0', border: '0', pointerEvents: 'none' });
    ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    bootTimer = setTimeout(() => finish(new Error('图示组件加载超时，请重试；原始源码仍保留。')), environment.bootTimeoutMs ?? MERMAID_IMPORT_TIMEOUT_MS);
    created.addEventListener('error', () => { if (frame === created) finish(new Error('图示组件加载失败，请重试')); });
    created.src = url.href;
    environment.owner.body.appendChild(created);
    return ready;
  };
  return {
    render(request: MermaidFrameRequest): Promise<MermaidFrameResult> {
      if (request.signal.aborted) return Promise.reject(request.signal.reason || aborted());
      if (active) return Promise.reject(new Error('图示渲染任务仍在运行'));
      if (!/^[\w-]{1,160}$/u.test(request.id) || request.code.length > (request.visualKind && request.visualKind !== 'mermaid' ? 32_000 : 8_000)) return Promise.reject(new Error('图示请求无效'));
      return new Promise<MermaidFrameResult>((resolve, reject) => {
        const requestId = `render-${++sequence}`;
        const abort = () => finish(request.signal.reason || aborted());
        const timer = setTimeout(() => finish(new Error('图示加载超时，已保留源码；可重试加载图示。')), environment.renderTimeoutMs ?? MERMAID_CARD_TIMEOUT_MS);
        active = { requestId, resolve, reject, signal: request.signal, abort, timer };
        request.signal.addEventListener('abort', abort, { once: true });
        try {
          void ensureFrame().then(() => {
            if (active?.requestId !== requestId) return;
            try { frame!.contentWindow!.postMessage({ kind: 'loginote-mermaid-render', session, requestId,
              id: request.id, code: request.code, dark: request.dark,
              ...(request.visualKind ? { visualKind: request.visualKind, width: request.width } : {}) }, '*'); }
            catch (error) { finish(error); }
          }, error => { if (active?.requestId === requestId) finish(error); });
        } catch (error) { finish(error); }
      });
    },
    dispose() {
      if (active) finish(aborted()); else destroyFrame(aborted());
      if (listening) { environment.eventTarget.removeEventListener('message', receive as EventListener); listening = false; }
    },
  };
}

let renderer: ReturnType<typeof createMermaidFrameRenderer> | undefined;
export function renderMermaidInFrame(request: MermaidFrameRequest): Promise<MermaidFrameResult> {
  const electron = (window as any).electronAPI;
  if (electron?.isElectron) {
    if (!electron.mermaid?.render) return Promise.reject(new Error('独立图示组件尚未就绪，请重启应用后重试。'));
    if (request.signal.aborted) return Promise.reject(request.signal.reason || aborted());
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const cancel = () => { electron.mermaid.cancel(requestId); reject(request.signal.reason || aborted()); };
      request.signal.addEventListener('abort', cancel, { once: true });
      void electron.mermaid.render({ requestId, id: request.id, code: request.code, dark: request.dark,
        ...(request.visualKind ? { visualKind: request.visualKind, width: request.width } : {}) })
        .then((result: MermaidFrameResult) => {
          request.signal.removeEventListener('abort', cancel);
          if (!request.signal.aborted) resolve(result);
        }, (error: unknown) => { request.signal.removeEventListener('abort', cancel); reject(error); });
    });
  }
  renderer ??= createMermaidFrameRenderer({ owner: document, eventTarget: window,
    frameUrl: new URL(`${import.meta.env.BASE_URL}mermaid-renderer.html`, document.baseURI).href });
  return renderer.render(request);
}
export function disposeMermaidFrameRenderer(): void { renderer?.dispose(); renderer = undefined; }
