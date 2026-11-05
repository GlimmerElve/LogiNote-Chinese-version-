/** Cleanup is derived maintenance, never authority to delete saved notes. */
export async function cleanupDeletedNoteIndexes(noteIds: unknown, dependencies: {
  isCurrent: () => boolean;
  readLiveIds: () => Promise<string[]>;
  removeReferences: (ids: string[]) => Promise<void>;
  removeDerivatives: (id: string) => Promise<void>;
}): Promise<void> {
  if (!Array.isArray(noteIds) || noteIds.length > 100000
    || noteIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 300)) throw new Error('笔记清理范围无效');
  const check = () => { if (!dependencies.isCurrent()) throw new Error('资料库已变化，旧索引清理未在新库执行'); };
  check();
  const live = new Set(await dependencies.readLiveIds());
  check();
  // Undo/recreation may have completed while this cleanup waited behind indexing.
  const removed = [...new Set(noteIds as string[])].filter(id => !live.has(id));
  if (!removed.length) return;
  await dependencies.removeReferences(removed);
  check();
  for (const id of removed) {
    check();
    await dependencies.removeDerivatives(id);
  }
}
