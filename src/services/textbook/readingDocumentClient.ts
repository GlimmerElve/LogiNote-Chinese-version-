import type { Root } from 'hast';
import type { ReadingIndex, ReadingInput } from './readingDocument';
let sessionSequence = 0;
const CACHE_PAGES = 16, CACHE_UNITS = 4_000_000, RETAINED_PAGES = 4;

export interface ReadingDocumentSession {
  readonly id: number;
  readonly isDisposed: boolean;
  readonly ready: Promise<ReadingIndex>;
  dispose(error?: Error): void;
  subscribeClosed(notify: (error: Error) => void): () => void;
  cachedPage(index: number): Root | undefined;
  wasPresented(index: number): boolean;
  retains(index: number): boolean;
  subscribeRetained(index: number, notify: () => void): () => void;
  markPresented(index: number, tree: Root): void;
  page(index: number): Promise<Root>;
  fragment(input: ReadingInput): ReadingDocumentSession;
}

interface SessionOwner {
  scope?: string;
  disposed: boolean;
  closedReason?: Error;
  closedListeners: Set<(error: Error) => void>;
  weights: WeakMap<Root, number>;
  close(error: Error): void;
}

/** One transport per reader surface. Nested fragments own only scoped state. */
export function createReadingDocumentSession(input: ReadingInput): ReadingDocumentSession {
  const worker = new Worker(new URL('./readingDocumentWorker.ts', import.meta.url), { type: 'module' });
  let sequence = 0, disposed = false;
  let transportClosedReason: Error | undefined;
  const owners = new Set<SessionOwner>();
  const pending = new Map<number, { owner: SessionOwner; resolve: (value: any) => void; reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout> }>();
  const closedError = () => new DOMException('阅读页面已关闭', 'AbortError');
  const disposeTransport = (error: Error = closedError()) => {
    if (disposed) return;
    disposed = true;
    transportClosedReason = error;
    worker.terminate();
    for (const owner of [...owners]) owner.close(error);
  };
  worker.onerror = event => {
    console.warn('[long-reading] worker failed:', event.message);
    disposeTransport(new Error('后台长文解析失败；请重试，不会改动原文'));
  };
  worker.onmessage = (event: MessageEvent<{ id: number; index?: ReadingIndex; tree?: Root; cacheUnits?: number; error?: string }>) => {
    const request = pending.get(event.data.id); if (!request) return;
    pending.delete(event.data.id); clearTimeout(request.timer);
    if (event.data.tree && Number.isSafeInteger(event.data.cacheUnits) && event.data.cacheUnits! > 0)
      request.owner.weights.set(event.data.tree, event.data.cacheUnits!);
    if (event.data.error) {
      const error = new Error(event.data.error); request.reject(error);
      if (!request.owner.scope) disposeTransport(error);
    } else request.resolve(event.data.index || event.data.tree);
  };
  const send = <T>(owner: SessionOwner, payload: { input?: ReadingInput; page?: number }): Promise<T> => new Promise((resolve, reject) => {
    if (disposed || owner.disposed) { reject(owner.closedReason || transportClosedReason || closedError()); return; }
    const id = ++sequence;
    const timer = setTimeout(() => disposeTransport(new Error('长文后台解析超时，请重试；原文未改动')), 30_000);
    pending.set(id, { owner, resolve, reject, timer });
    try { worker.postMessage({ id, ...(owner.scope ? { scope: owner.scope } : {}), ...payload }); }
    catch (error) {
      pending.delete(id); clearTimeout(timer); reject(error);
      if (!owner.scope) disposeTransport(error instanceof Error ? error : new Error('后台阅读请求失败'));
    }
  });
  const createSession = (source: ReadingInput, root = false, parentError?: Error): ReadingDocumentSession => {
    const id = ++sessionSequence;
    // Page requests carry the same captured fragment input so an evicted worker
    // document can be reconstructed without reading mutable props or real files.
    const fragmentInput = root ? source : structuredClone(source);
    const initialError = parentError || (disposed ? transportClosedReason || closedError() : undefined);
    const owner: SessionOwner = { scope: root ? undefined : `fragment-${id}`, disposed: Boolean(initialError),
      closedReason: initialError, closedListeners: new Set(), weights: new WeakMap(), close: () => {} };
    const pages = new Map<number, { tree: Root; units: number; shown: boolean }>();
    const retained = new Map<number, true>();
    const presented = new Set<number>();
    const listeners = new Map<number, Set<() => void>>();
    const inFlight = new Map<number, Promise<Root>>();
    let cacheUnits = 0;
    const forgetRetained = (index: number) => {
      if (retained.delete(index)) listeners.get(index)?.forEach(notify => notify());
    };
    const touch = (index: number) => { const value = pages.get(index); if (value) { pages.delete(index); pages.set(index, value); } return value; };
    const remember = (index: number, tree: Root) => {
      const units = owner.weights.get(tree);
      if (disposed || owner.disposed || !units || units > CACHE_UNITS) return;
      cacheUnits -= pages.get(index)?.units || 0;
      pages.delete(index); pages.set(index, { tree, units, shown: presented.has(index) }); cacheUnits += units;
      while (pages.size > CACHE_PAGES || cacheUnits > CACHE_UNITS) {
        const oldest = pages.keys().next().value!;
        cacheUnits -= pages.get(oldest)!.units; pages.delete(oldest); forgetRetained(oldest);
      }
    };
    owner.close = (error: Error) => {
      if (owner.disposed) return;
      owner.disposed = true; owner.closedReason = error; owners.delete(owner);
      pages.clear(); retained.clear(); presented.clear(); listeners.clear(); inFlight.clear(); cacheUnits = 0;
      for (const [requestId, request] of pending) if (request.owner === owner) {
        clearTimeout(request.timer); pending.delete(requestId); request.reject(error);
      }
      const notifications = [...owner.closedListeners]; owner.closedListeners.clear();
      for (const notify of notifications) {
        try { notify(error); } catch { console.warn('[long-reading] closure listener failed'); }
      }
    };
    const dispose = (error: Error = closedError()) => {
      if (root) { disposeTransport(error); return; }
      if (owner.disposed) return;
      owner.close(transportClosedReason || error);
      // No response/timer is needed for release. It cannot terminate siblings or
      // replace the parent document; a root transport failure is handled above.
      if (!disposed) try { worker.postMessage({ id: ++sequence, scope: owner.scope, release: true }); } catch { /* Already closed. */ }
    };
    if (!owner.disposed) owners.add(owner);
    const ready = send<ReadingIndex>(owner, { input: fragmentInput });
    void ready.catch(() => {}); // Disposal may precede the consumer's effect.
    return { id, dispose, get isDisposed() { return owner.disposed; }, ready,
      fragment(next: ReadingInput) { return createSession(next, false, owner.closedReason); },
      subscribeClosed(notify: (error: Error) => void) {
        if (owner.closedReason) {
          try { notify(owner.closedReason); } catch { console.warn('[long-reading] closure listener failed'); }
          return () => {};
        }
        owner.closedListeners.add(notify);
        return () => { owner.closedListeners.delete(notify); };
      },
      cachedPage(index: number): Root | undefined {
        if (disposed || owner.disposed) return;
        const value = touch(index); return value?.shown ? value.tree : undefined;
      },
      wasPresented(index: number) { return presented.has(index); },
      retains(index: number) { return retained.has(index); },
      subscribeRetained(index: number, notify: () => void) {
        if (owner.disposed) return () => {};
        const set = listeners.get(index) || new Set(); listeners.set(index, set); set.add(notify);
        return () => { set.delete(notify); if (!set.size) listeners.delete(index); };
      },
      markPresented(index: number, tree: Root) {
        if (disposed || owner.disposed) return;
        presented.add(index);
        const value = touch(index); if (value?.tree !== tree) return;
        value.shown = true;
        const wasRetained = retained.has(index); retained.delete(index); retained.set(index, true);
        if (!wasRetained) listeners.get(index)?.forEach(notify => notify());
        while (retained.size > RETAINED_PAGES) forgetRetained(retained.keys().next().value!);
      },
      page(index: number): Promise<Root> {
        if (disposed || owner.disposed) return Promise.reject(owner.closedReason || transportClosedReason || closedError());
        const cached = touch(index); if (cached) return Promise.resolve(cached.tree);
        const current = inFlight.get(index); if (current) return current;
        const result = send<Root>(owner, { page: index, ...(root ? {} : { input: fragmentInput }) })
          .then(tree => { remember(index, tree); return tree; }).finally(() => inFlight.delete(index));
        inFlight.set(index, result); return result;
      },
    };
  };
  return createSession(input, true);
}
