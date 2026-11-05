import { WebApiError } from './webAcquisition';

export type WebApiFallbackReason = 'unsupported' | 'transient';

/** Only transport/time-budget and temporary server failures may change route.
 * Auth, balance, rate limiting, unsafe URLs, bad data and explicit Stop do not. */
export function isTransientWebApiError(error: unknown): boolean {
  return error instanceof WebApiError ? error.status === 0 || error.status === 408 || error.status >= 500 && error.status <= 599
    : error instanceof Error && error.name === 'TimeoutError';
}

/** One API attempt, then let the caller use its existing isolated fallback.
 * A temporary failure is NOT cached as unsupported. The local time budget leaves
 * room for fallback within the caller's original overall deadline. */
export async function attemptWebApi<T>(call: (signal: AbortSignal) => Promise<T | null>,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<{ value: T | null; fallbackReason?: WebApiFallbackReason }> {
  options.signal?.throwIfAborted();
  const budget = new AbortController(), signal = options.signal ? AbortSignal.any([options.signal, budget.signal]) : budget.signal;
  const timer = setTimeout(() => budget.abort(new WebApiError(0, '联网 API 等待超时，尝试网页后备')), options.timeoutMs ?? 8000);
  let abort!: () => void;
  try {
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
    });
    const value = await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return call(signal); }), cancelled]);
    options.signal?.throwIfAborted();
    return value === null ? { value: null, fallbackReason: 'unsupported' } : { value };
  } catch (error) {
    options.signal?.throwIfAborted();
    if (!isTransientWebApiError(error)) throw error;
    return { value: null, fallbackReason: 'transient' };
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
}
