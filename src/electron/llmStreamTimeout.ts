import type { LlmStreamTimeoutPolicy } from './ipcTypes';

export const MAX_LLM_STREAM_TIMEOUT_MS = 900_000;
const LEGACY_STREAM_TOTAL_MS = 90_000;
export type LlmStreamTimeoutPhase = 'first-response' | 'idle' | 'total';

export class LlmStreamTimeoutError extends Error {
  readonly code: string;
  constructor(readonly phase: LlmStreamTimeoutPhase, readonly timeoutMs: number, legacy = false) {
    const description = phase === 'first-response' ? '等待首个响应片段' : phase === 'idle' ? '响应中断、未收到新片段' : '请求总时长';
    super(legacy ? 'LLM 请求超时' : `LLM 请求超时：${description}超过 ${timeoutMs / 1000} 秒。`);
    this.name = 'LlmStreamTimeoutError';
    this.code = phase === 'first-response' ? 'LLM_STREAM_TIMEOUT_FIRST_RESPONSE' : phase === 'idle' ? 'LLM_STREAM_TIMEOUT_IDLE' : 'LLM_STREAM_TIMEOUT_TOTAL';
  }
}

/** Recheck at the main-process boundary, even if preload already validated it.
 * All three values are required; no null/NaN/Infinity/zero/unbounded deadline. */
export function normalizeLlmStreamTimeoutPolicy(value: unknown): LlmStreamTimeoutPolicy | undefined {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('流式请求超时策略无效。');
  const policy = value as LlmStreamTimeoutPolicy;
  for (const field of ['firstResponseMs', 'idleMs', 'totalMs'] as const) {
    if (typeof policy[field] !== 'number' || !Number.isSafeInteger(policy[field]) || policy[field] <= 0 || policy[field] > MAX_LLM_STREAM_TIMEOUT_MS) {
      throw Error('流式请求超时策略无效。');
    }
  }
  if (policy.totalMs < policy.firstResponseMs || policy.totalMs < policy.idleMs) throw Error('流式请求超时策略无效。');
  return Object.freeze({ firstResponseMs: policy.firstResponseMs, idleMs: policy.idleMs, totalMs: policy.totalMs });
}

export interface LlmStreamTimeoutClock {
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
}
const systemClock: LlmStreamTimeoutClock = {
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Headers alone are not a stream response. Any nonempty body bytes (including
 * reasoning or SSE keepalive/partial packets) end first-response waiting and
 * refresh idle; total time never resets. This owns no provider text or content. */
export function createLlmStreamTimeout(externalSignal: AbortSignal | undefined, rawPolicy?: unknown, clock: LlmStreamTimeoutClock = systemClock) {
  const policy = normalizeLlmStreamTimeoutPolicy(rawPolicy);
  const controller = new AbortController();
  let firstTimer: unknown, idleTimer: unknown, totalTimer: unknown, disposed = false;
  const clear = () => {
    for (const handle of [firstTimer, idleTimer, totalTimer]) if (handle !== undefined) clock.clearTimeout(handle);
    firstTimer = idleTimer = totalTimer = undefined;
  };
  const abort = (reason: unknown) => {
    if (disposed || controller.signal.aborted) return;
    clear(); externalSignal?.removeEventListener('abort', externalAbort);
    controller.abort(reason);
  };
  const externalAbort = () => abort(externalSignal?.reason);
  const timeout = (phase: LlmStreamTimeoutPhase, milliseconds: number, legacy = false) =>
    clock.setTimeout(() => abort(new LlmStreamTimeoutError(phase, milliseconds, legacy)), milliseconds);
  if (externalSignal?.aborted) externalAbort();
  else {
    externalSignal?.addEventListener('abort', externalAbort, { once: true });
    totalTimer = timeout('total', policy?.totalMs ?? LEGACY_STREAM_TOTAL_MS, !policy);
    if (policy) firstTimer = timeout('first-response', policy.firstResponseMs);
  }
  return {
    signal: controller.signal,
    touch() {
      if (!policy || disposed || controller.signal.aborted) return;
      if (firstTimer !== undefined) { clock.clearTimeout(firstTimer); firstTimer = undefined; }
      if (idleTimer !== undefined) clock.clearTimeout(idleTimer);
      idleTimer = timeout('idle', policy.idleMs);
    },
    dispose() {
      if (disposed) return;
      disposed = true; clear(); externalSignal?.removeEventListener('abort', externalAbort);
    },
  };
}
