import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWriteTextFile } from './atomicWrite';
import { withRagSourceTransaction } from './ragSourceTransactions';

export const NOTE_INDEX_CLEANUP_FILE = 'pending-note-index-cleanup.json';
export interface NoteIndexCleanupJob { noteId: string; token: string }
interface CleanupFile { version: 1; vaultRoot: string; userStateDir: string; pending: NoteIndexCleanupJob[] }
const canonical = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const validId = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 300;
export function validateNoteIndexCleanupIds(ids: unknown): asserts ids is string[] {
  if (!Array.isArray(ids) || ids.length > 100000 || ids.some(id => !validId(id))) throw new Error('笔记清理范围无效');
}
export function parseNoteIndexCleanupFile(text: string, root: string, states: string): CleanupFile {
  const value = JSON.parse(text) as CleanupFile;
  if (!value || value.version !== 1 || Object.keys(value).some(key => !['version', 'vaultRoot', 'userStateDir', 'pending'].includes(key))
    || typeof value.vaultRoot !== 'string' || !path.isAbsolute(value.vaultRoot) || canonical(value.vaultRoot) !== canonical(root)
    || typeof value.userStateDir !== 'string' || !path.isAbsolute(value.userStateDir) || canonical(value.userStateDir) !== canonical(states)
    || !Array.isArray(value.pending) || value.pending.length > 100000) throw new Error('待清理记录损坏或不属于当前资料库，原文件已保留');
  const seen = new Set<string>();
  for (const job of value.pending) {
    if (!job || Object.keys(job).some(key => !['noteId', 'token'].includes(key)) || !validId(job.noteId) || seen.has(job.noteId)
      || typeof job.token !== 'string' || !/^[a-f0-9-]{36}$/u.test(job.token)) throw new Error('待清理任务无效，原文件已保留');
    seen.add(job.noteId);
  }
  return value;
}
async function readUnlocked(root: string, states: string): Promise<CleanupFile> {
  try { return parseNoteIndexCleanupFile(await fs.readFile(path.join(states, NOTE_INDEX_CLEANUP_FILE), 'utf8'), root, states); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { version: 1, vaultRoot: path.resolve(root), userStateDir: path.resolve(states), pending: [] };
  }
}

/** Caller MUST hold the saved-source transaction. Return bytes for the SAME
 * recoverable vault delta, before its metadata commit; never write separately. */
export async function prepareNoteIndexCleanupDelta(root: string, states: string, removedIds: string[]): Promise<[string, string] | null> {
  validateNoteIndexCleanupIds(removedIds);
  if (!removedIds.length) return null;
  const file = await readUnlocked(root, states);
  const jobs = new Map(file.pending.map(job => [job.noteId, job]));
  for (const noteId of removedIds) jobs.set(noteId, { noteId, token: randomUUID() });
  if (jobs.size > 100000) throw new Error('待清理任务过多，请完成索引维护后重试删除');
  return [path.join(states, NOTE_INDEX_CLEANUP_FILE), JSON.stringify({ ...file, pending: [...jobs.values()] })];
}

/** Explicit whole-library migration only; caller holds both source/target locks.
 * Runtime cleanup never follows a root from a file or writes into a foreign root. */
export async function copyNoteIndexCleanupForMigration(root: string, states: string, targetRoot: string, targetStates: string): Promise<void> {
  let text: string;
  try { text = await fs.readFile(path.join(states, NOTE_INDEX_CLEANUP_FILE), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  const file = parseNoteIndexCleanupFile(text, root, states);
  await fs.mkdir(targetStates, { recursive: true });
  await atomicWriteTextFile(path.join(targetStates, NOTE_INDEX_CLEANUP_FILE), JSON.stringify({ ...file,
    vaultRoot: path.resolve(targetRoot), userStateDir: path.resolve(targetStates) }), { allowCopyFallback: false });
}

export function readPendingNoteIndexCleanup(root: string, states: string, isCurrent: () => boolean): Promise<NoteIndexCleanupJob[]> {
  return withRagSourceTransaction([root, states], async () => {
    if (!isCurrent()) throw new Error('资料库已变化，未读取旧清理任务');
    const file = await readUnlocked(root, states);
    if (!isCurrent()) throw new Error('资料库已变化，未读取旧清理任务');
    return file.pending;
  });
}
export function acknowledgeNoteIndexCleanup(root: string, states: string, completed: NoteIndexCleanupJob[], isCurrent: () => boolean): Promise<void> {
  // Reserve the same source lock as new deletions. An old receipt must not erase
  // a newer deletion of a restored/reused ID, or recreate files after reset.
  return withRagSourceTransaction([root, states], async () => {
    if (!isCurrent()) throw new Error('资料库已变化，旧清理回执未写入');
    const file = await readUnlocked(root, states);
    const tokens = new Map(completed.map(job => [job.noteId, job.token]));
    const pending = file.pending.filter(job => tokens.get(job.noteId) !== job.token);
    if (pending.length === file.pending.length) return;
    if (!isCurrent()) throw new Error('资料库已变化，旧清理回执未写入');
    // No copy fallback: interruption retains either the old valid pending list or
    // the new valid receipt. Repeating a completed derived cleanup is harmless.
    await atomicWriteTextFile(path.join(states, NOTE_INDEX_CLEANUP_FILE), JSON.stringify({ ...file, pending }), { allowCopyFallback: false });
  });
}

/** In-memory runner only schedules work; the journal is its durable authority.
 * Stop never waits for a model. Unacknowledged batches remain for next launch. */
export function createNoteIndexCleanupWorker(dependencies: {
  isCurrent: () => boolean;
  read: () => Promise<NoteIndexCleanupJob[]>;
  clean: (ids: string[]) => Promise<void>;
  acknowledge: (jobs: NoteIndexCleanupJob[]) => Promise<void>;
}) {
  let running: Promise<void> | undefined, requested = false, stopped = false;
  async function drain() {
    while (requested && !stopped && dependencies.isCurrent()) {
      requested = false;
      try {
        const jobs = await dependencies.read();
        if (stopped || !dependencies.isCurrent()) return;
        if (!jobs.length) { if (requested) continue; return; }
        await dependencies.clean(jobs.map(job => job.noteId));
        if (stopped || !dependencies.isCurrent()) return;
        await dependencies.acknowledge(jobs);
        requested = true; // A deletion may have been committed during this batch.
      } catch (error) {
        // A concurrent save can invalidate this batch and also wake us while it
        // is still running. Consume that NEW wake instead of losing its retry.
        // Without a new request, leave failures durable; never spin on bad IO.
        if (requested && !stopped && dependencies.isCurrent()) continue;
        throw error;
      }
    }
  }
  return {
    wake(): Promise<void> {
      if (stopped || !dependencies.isCurrent()) return Promise.resolve();
      requested = true;
      if (!running) running = drain().finally(() => { running = undefined; });
      return running;
    },
    stop() { stopped = true; requested = false; },
  };
}
