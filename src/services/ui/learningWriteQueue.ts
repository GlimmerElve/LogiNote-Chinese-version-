/** App-level snapshot writers must share this queue, not only the disk writer queue. */
export interface LearningWriteQueue { current: Promise<unknown> }

export function enqueueLearningWrite<T>(queue: LearningWriteQueue, work: () => Promise<T>): Promise<T> {
  const write = queue.current.catch(() => {}).then(work);
  queue.current = write;
  return write;
}

/** Resolve the visible snapshot when the queued write actually starts, never at enqueue time. */
const pendingLatestSaves = new WeakMap<LearningWriteQueue, {
  promise: Promise<void>; run: () => Promise<void>;
}>();

export function enqueueLatestNotesSave<T>(queue: LearningWriteQueue, readLatest: () => T, save: (latest: T) => Promise<void>): Promise<void> {
  const pending = pendingLatestSaves.get(queue);
  // Coalesce only consecutive, not-yet-started autosaves. An ordered learning
  // mutation is a barrier; never move a save across it or merge an in-flight IO.
  if (pending && queue.current === pending.promise) {
    pending.run = () => save(readLatest());
    return pending.promise;
  }
  const request = { promise: null! as Promise<void>, run: () => save(readLatest()) };
  request.promise = enqueueLearningWrite(queue, async () => {
    if (pendingLatestSaves.get(queue) === request) pendingLatestSaves.delete(queue);
    await request.run();
  });
  pendingLatestSaves.set(queue, request);
  return request.promise;
}

/** Background commits may rebase a draft while an earlier save acknowledges.
 * Exit must drain the resulting latest draft, not just a captured queue tail. */
export async function flushLatestNoteWrites<T>(queue: LearningWriteQueue, pending: () => T | null,
  flush: (snapshot: T) => Promise<void>, settle = () => new Promise<void>(resolve => setTimeout(resolve, 0))) {
  for (let attempt = 0; attempt < 5; attempt++) {
    await queue.current.catch(() => {});
    const snapshot = pending();
    if (snapshot !== null) await flush(snapshot);
    const acknowledged = queue.current;
    await acknowledged.catch(() => {});
    await settle();
    if (queue.current === acknowledged && pending() === null) return;
  }
  throw Error('笔记仍有新的后台写入，请等待保存完成后再退出');
}
