/** Small session-only LRU. Keys are immutable source bytes, not mutable document IDs.
 * All requests finish in order; the reader queues before loading image bytes. */
export function createPreviewCache(render: (source: string) => Promise<string>, maxBytes = 8 * 1024 * 1024) {
  const cache = new Map<string, { promise: Promise<string>; bytes: number }>();
  const pending = new Map<string, Promise<string>>();
  let bytes = 0;
  let tail: Promise<unknown> = Promise.resolve();
  return (source: string): Promise<string> => {
    const hit = cache.get(source);
    if (hit) { cache.delete(source); cache.set(source, hit); return hit.promise; }
    const queued = pending.get(source);
    if (queued) return queued;
    const size = source.length * 2;
    if (size === 0) return Promise.resolve(source);
    const promise = tail.then(() => render(source)).then(preview => {
      pending.delete(source);
      const required = size + (preview === source ? 0 : preview.length * 2);
      // Cache budget limits retention, never whether a requested crop is made.
      if (required <= maxBytes) {
        for (const [key, item] of cache) {
          if (bytes + required <= maxBytes && cache.size < 16) break;
          bytes -= item.bytes; cache.delete(key);
        }
        cache.set(source, { promise, bytes: required }); bytes += required;
      }
      return preview;
    }, () => { pending.delete(source); return source; });
    tail = promise.then(() => undefined);
    pending.set(source, promise);
    return promise;
  };
}

/** Queue lightweight read closures BEFORE fetching raster bytes. Only a bounded
 * number can hold decoded/source images; unmounted queued consumers are removed. */
export function createPreviewWorkQueue(concurrency = 2) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('Invalid image work concurrency');
  const waiting: Array<{ start: () => void }> = [];
  let active = 0;
  const drain = () => {
    while (active < concurrency && waiting.length) { active++; waiting.shift()!.start(); }
  };
  return <T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> => new Promise((resolve, reject) => {
    const abort = () => {
      const index = waiting.indexOf(job);
      if (index >= 0) waiting.splice(index, 1);
      signal?.removeEventListener('abort', abort);
      reject(new DOMException('Image read cancelled', 'AbortError'));
    };
    const job = { start: () => {
      signal?.removeEventListener('abort', abort);
      void Promise.resolve().then(work).then(resolve, reject).finally(() => { active--; drain(); });
    } };
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    waiting.push(job); drain();
  });
}
