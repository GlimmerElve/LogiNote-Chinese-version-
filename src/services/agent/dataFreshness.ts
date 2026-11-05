const pendingFlushers = new Set<() => Promise<void>>();
const pendingCaptures = new Set<() => void>();
export async function flushPendingChanges():Promise<void>{
  // Publish buffered UI state before ANY persistence participant takes a snapshot.
  // A normal parallel flusher cannot guarantee this ordering (mount order varies).
  capturePendingChanges();
  await Promise.all([...pendingFlushers].map(flush=>flush()));
}

export function capturePendingChanges(): void {
  for (const capture of [...pendingCaptures]) capture();
}

export function registerPendingCapture(capture: () => void): () => void {
  pendingCaptures.add(capture);
  return () => { pendingCaptures.delete(capture); };
}

export function registerPendingFlush(flush: () => Promise<void>): () => void {
  pendingFlushers.add(flush);
  return () => pendingFlushers.delete(flush);
}

/** Agent 查询前提交所有相关写入，并确认主进程版本在一个 IPC 往返内保持稳定。 */
export async function ensureDataFresh(): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await flushPendingChanges();
    const api = (window as any).electronAPI?.agent;
    if (!api) return;
    const before = await api.dataVersion();
    const after = await api.dataVersion();
    if (before === after) return;
  }
  throw new Error('学习数据仍在更新，请稍后重试');
}
