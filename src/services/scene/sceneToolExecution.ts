import type { SceneRuntimeToolId } from '../../types';

/** Host-owned limits, not model arguments or an obligation to call every authorized tool. */
export const SCENE_TOOL_EXECUTION_CONTRACTS: Record<SceneRuntimeToolId, {
  timeoutMs: number;
  effect: 'read-only' | 'budgeted-model-experiment';
  repeat: 'deduplicate-request' | 'reuse-experiment-receipt';
}> = {
  'knowledge-notes': { timeoutMs: 12000, effect: 'read-only', repeat: 'deduplicate-request' },
  documents: { timeoutMs: 12000, effect: 'read-only', repeat: 'deduplicate-request' },
  'document-arguments': { timeoutMs: 18000, effect: 'read-only', repeat: 'deduplicate-request' },
  'argument-chain': { timeoutMs: 12000, effect: 'read-only', repeat: 'deduplicate-request' },
  'learner-profile': { timeoutMs: 12000, effect: 'read-only', repeat: 'deduplicate-request' },
  'model-experiment': { timeoutMs: 180000, effect: 'budgeted-model-experiment', repeat: 'reuse-experiment-receipt' },
};

export class SceneToolTimeoutError extends Error {
  constructor() { super('工具执行超时。'); this.name = 'SceneToolTimeoutError'; }
}

export function assertSceneToolActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('请求已停止', 'AbortError');
}

/** A non-cooperative IPC reader may finish later; only the winner can publish a result. */
export function runSceneToolExecution<T>(id: SceneRuntimeToolId, execute: (signal: AbortSignal) => Promise<T> | T,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
  assertSceneToolActive(options.signal);
  const limit = SCENE_TOOL_EXECUTION_CONTRACTS[id].timeoutMs;
  // Tests/hosts may shorten a deadline, but neither callers nor the model can enlarge it.
  const timeoutMs = typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
    ? Math.max(1, Math.min(limit, Math.floor(options.timeoutMs))) : limit;
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    let finished = false;
    const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort); };
    const finish = (publish: () => void) => {
      if (finished) return;
      finished = true; cleanup(); publish();
    };
    const onAbort = () => finish(() => { controller.abort(); reject(new DOMException('请求已停止', 'AbortError')); });
    const timer = setTimeout(() => finish(() => { controller.abort(); reject(new SceneToolTimeoutError()); }), timeoutMs);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    // Defer invocation so cancellation before dispatch cannot start a new paid operation.
    Promise.resolve().then(() => {
      assertSceneToolActive(controller.signal);
      return execute(controller.signal);
    }).then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
    if (options.signal?.aborted) onAbort();
  });
}

/** Use inside the experiment's injected provider so cancellation settles its reserved receipt too. */
export function awaitSceneToolSignal<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  assertSceneToolActive(signal);
  return new Promise<T>((resolve, reject) => {
    let finished = false;
    const finish = (publish: () => void) => {
      if (finished) return;
      finished = true; signal.removeEventListener('abort', onAbort); publish();
    };
    const onAbort = () => finish(() => reject(new DOMException('请求已停止', 'AbortError')));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(() => { assertSceneToolActive(signal); return operation(); })
      .then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
    if (signal.aborted) onAbort();
  });
}
