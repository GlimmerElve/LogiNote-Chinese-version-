import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

// Application-process coordination only. This cannot exclude another process or
// an external editor; authority readers still recheck saved bytes before/after.
const tails = new Map<string, Promise<void>>();
const context = new AsyncLocalStorage<{ active: boolean }>();

function rootKey(root: string): string {
  if (typeof root !== 'string' || !root.length || !path.isAbsolute(root) || /[\u0000-\u001f\u007f]/u.test(root)) {
    throw new Error('rag_source_invalid_root');
  }
  const resolved = path.resolve(root);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Reserve every root synchronously, then wait on the prior reservations. Reserving
 * the whole set (rather than acquiring one root at a time) avoids reversed-order
 * multi-root deadlocks. Callbacks must use unlocked helpers, never another public
 * transaction, and must not wait for a model, user approval or another store queue.
 */
export async function withRagSourceTransaction<T>(roots: string[], action: () => Promise<T>): Promise<T> {
  if (!Array.isArray(roots) || !roots.length || roots.length > 16 || typeof action !== 'function') {
    throw new Error('rag_source_invalid_transaction');
  }
  if (context.getStore()?.active) throw new Error('rag_source_nested_transaction');
  const keys = [...new Set(roots.map(rootKey))].sort();
  const previous = keys.map(key => tails.get(key) ?? Promise.resolve());
  let release!: () => void;
  const reservation = new Promise<void>(resolve => { release = resolve; });
  for (const key of keys) tails.set(key, reservation);
  const held = { active: true };
  try {
    await Promise.all(previous);
    return await context.run(held, action);
  } finally {
    held.active = false;
    release();
    for (const key of keys) if (tails.get(key) === reservation) tails.delete(key);
  }
}
