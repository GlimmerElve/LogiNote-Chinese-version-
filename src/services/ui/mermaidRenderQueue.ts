export const MERMAID_CARD_TIMEOUT_MS = 15_000;
export const MERMAID_IMPORT_TIMEOUT_MS = 10_000;

function aborted(): Error { const error = new Error('图示任务已取消'); error.name = 'AbortError'; return error; }
export interface MermaidRenderContext {
  signal: AbortSignal;
  throwIfCancelled(): void;
}

/** A card deadline does not release Mermaid's shared configuration lock. A
 * renderer which has already started must actually settle before another may
 * initialize the singleton; expired/hidden jobs waiting behind it never run. */
export function createMermaidRenderQueue(yieldTask: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve, 0))) {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    enqueue<T>(run: (context: MermaidRenderContext) => Promise<T>, timeoutMs = MERMAID_CARD_TIMEOUT_MS) {
      const controller = new AbortController();
      let settled = false, resolveResult!: (value: T) => void, rejectResult!: (error: unknown) => void;
      const result = new Promise<T>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
      const finish = (error?: unknown, value?: T) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (error !== undefined) { controller.abort(error); rejectResult(error); }
        else resolveResult(value as T);
      };
      const timer = setTimeout(() => finish(new Error('图示加载超时，已保留源码；可重试加载图示。')), timeoutMs);
      const context: MermaidRenderContext = { signal: controller.signal,
        throwIfCancelled() { if (settled) throw controller.signal.reason || aborted(); } };
      tail = tail.catch(() => {}).then(async () => {
        if (settled) return;
        // A macrotask between diagrams gives input/paint a chance even when the
        // module and layout data are already cached.
        await yieldTask();
        if (settled) return;
        try { const value = await run(context); if (!settled) finish(undefined, value); }
        catch (error) { finish(error); }
      });
      return { result, cancel: () => finish(aborted()) };
    },
  };
}

/** Dynamic import cannot be cancelled, but its late result must never start
 * initialization after its card has timed out or left the active page. */
export function loadMermaidRuntime<T>(load: () => Promise<T>, signal: AbortSignal, timeoutMs = MERMAID_IMPORT_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, value?: T) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal.removeEventListener('abort', cancel);
      if (error !== undefined) reject(error); else resolve(value as T);
    };
    const cancel = () => finish(signal.reason || aborted());
    const timer = setTimeout(() => finish(new Error('图示组件加载超时，请重试；原始源码仍保留。')), timeoutMs);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) { cancel(); return; }
    try { void load().then(value => finish(undefined, value), error => finish(error)); }
    catch (error) { finish(error); }
  });
}
