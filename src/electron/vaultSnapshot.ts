import fs from 'node:fs/promises';
import path from 'node:path';
import type { NoteItem, UserNoteState } from '../types.ts';
import { serializeMetadata, markdownFileName, markdownFileMap } from '../services/vaultFsService.ts';
import { splitSharableFields, splitUserStateFields, hasAnyUserState, serializeUserStateFile, USER_STATE_FILES } from '../services/userStateService.ts';
import { atomicWriteTextFile } from './atomicWrite.ts';
import { withRagSourceTransaction } from './ragSourceTransactions.ts';
import { NOTE_INDEX_CLEANUP_FILE, parseNoteIndexCleanupFile, prepareNoteIndexCleanupDelta } from './noteIndexCleanupJournal';
import { validateKnowledgeLifecycle } from '../services/knowledgeLifecycle';

const JOURNAL = 'vault-pending-snapshot.json';
type Writer = (file: string, text: string) => Promise<unknown>;
type DeltaFile = { target: 'body'; noteId: string; text: string } | { target: 'metadata' | 'personal' | 'index-cleanup' | 'knowledge-lifecycle'; text: string };

function encodeDelta(vaultRoot: string, userStateDir: string, files: [string, string][]): DeltaFile[] {
  return files.map(([file, text]) => file === path.join(userStateDir, USER_STATE_FILES.noteStates) ? { target: 'personal', text }
    : file === path.join(vaultRoot, 'metadata.json') ? { target: 'metadata', text }
      : file === path.join(userStateDir, NOTE_INDEX_CLEANUP_FILE) ? { target: 'index-cleanup', text }
      : file === path.join(userStateDir, USER_STATE_FILES.knowledgeLifecycle) ? { target: 'knowledge-lifecycle', text }
      : { target: 'body', noteId: path.basename(file, '.md'), text });
}

function decodeDelta(vaultRoot: string, userStateDir: string, value: unknown): [string, string][] {
  if (!Array.isArray(value) || !value.length) throw Error('待恢复变更记录无效；已保留原文件');
  const seen = new Set<string>();
  const files: [string, string][] = value.map(item => {
    if (!item || typeof item !== 'object' || typeof item.text !== 'string'
      || Object.keys(item).some(key => !['target', 'noteId', 'text'].includes(key))) throw Error('待恢复文件记录无效');
    let file: string;
    if (item.target === 'body') {
      validateNotes([{ id: item.noteId, content: item.text } as NoteItem], vaultRoot);
      file = path.join(vaultRoot, 'notes', markdownFileName(item.noteId));
    } else if (item.target === 'index-cleanup') {
      if (Object.hasOwn(item, 'noteId')) throw Error('待恢复清理目标无效');
      parseNoteIndexCleanupFile(item.text, vaultRoot, userStateDir);
      file = path.join(userStateDir, NOTE_INDEX_CLEANUP_FILE);
    } else if (item.target === 'knowledge-lifecycle') {
      if (Object.hasOwn(item, 'noteId')) throw Error('知识点恢复目标无效');
      validateKnowledgeLifecycle(JSON.parse(item.text));
      file = path.join(userStateDir, USER_STATE_FILES.knowledgeLifecycle);
    } else {
      if (Object.hasOwn(item, 'noteId') || !['metadata', 'personal'].includes(item.target)) throw Error('待恢复文件目标无效');
      const data = JSON.parse(item.text);
      const entries = item.target === 'metadata' ? data?.notesMeta : data?.noteStates;
      if (data?.version !== 1 || !entries || typeof entries !== 'object' || Array.isArray(entries)) throw Error('待恢复目录或个人记录无效');
      file = item.target === 'metadata' ? path.join(vaultRoot, 'metadata.json') : path.join(userStateDir, USER_STATE_FILES.noteStates);
    }
    const key = process.platform === 'win32' ? file.toLowerCase() : file;
    if (seen.has(key)) throw Error('待恢复文件重复');
    seen.add(key); return [file, item.text];
  });
  // Validate the entire journal before any file is written. Metadata remains last.
  return files.sort(([a], [b]) => (a.endsWith('metadata.json') ? 2 : a.endsWith(USER_STATE_FILES.noteStates) ? 0 : 1)
    - (b.endsWith('metadata.json') ? 2 : b.endsWith(USER_STATE_FILES.noteStates) ? 0 : 1));
}

async function changedFiles(files: [string, string][]): Promise<[string, string][]> {
  const changed = new Set<string>();
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(8, files.length) }, async () => {
    while (cursor < files.length) {
      const [file, content] = files[cursor++];
      try { if (await fs.readFile(file, 'utf8') !== content) changed.add(file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; changed.add(file); }
    }
  }));
  return files.filter(([file]) => changed.has(file));
}

function validateNotes(notes: NoteItem[], vaultRoot: string): void {
  if (!Array.isArray(notes)) throw new Error('笔记快照格式无效');
  const dir = path.resolve(vaultRoot, 'notes');
  const names = new Set<string>();
  for (const note of notes) {
    if (typeof note?.id !== 'string' || !note.id || note.id.length > 300 || /[<>:"/\\|?*\x00-\x1f]/u.test(note.id)
      || typeof note.content !== 'string') throw new Error('笔记 ID 或正文无效，拒绝写入');
    const target = path.resolve(dir, markdownFileName(note.id));
    if (path.dirname(target) !== dir) throw new Error('笔记路径越界');
    const name = process.platform === 'win32' ? target.toLowerCase() : target;
    if (names.has(name)) throw new Error('笔记文件名重复');
    names.add(name);
  }
}

async function changedSnapshotFiles(vaultRoot: string, userStateDir: string, notes: NoteItem[]): Promise<[string, string][]> {
  validateNotes(notes, vaultRoot);
  const sharable = notes.map(splitSharableFields);
  const states: Record<string, UserNoteState> = {};
  for (const note of notes) {
    const state = splitUserStateFields(note);
    if (hasAnyUserState(state)) states[note.id] = state;
  }
  const files: [string, string][] = [
    [path.join(userStateDir, USER_STATE_FILES.noteStates), serializeUserStateFile(states)],
    ...[...markdownFileMap(sharable)].map(([file, content]): [string, string] => [path.join(vaultRoot, 'notes', file), content]),
    [path.join(vaultRoot, 'metadata.json'), serializeMetadata(sharable)],
  ];
  let previousIds: string[] = [];
  try {
    const previous = JSON.parse(await fs.readFile(path.join(vaultRoot, 'metadata.json'), 'utf8'));
    if (!previous?.notesMeta || typeof previous.notesMeta !== 'object' || Array.isArray(previous.notesMeta)) {
      throw new Error('原笔记目录无效，未覆盖或登记删除');
    }
    previousIds = Object.keys(previous.notesMeta);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const live = new Set(notes.map(note => note.id));
  const cleanup = await prepareNoteIndexCleanupDelta(vaultRoot, userStateDir, previousIds.filter(id => !live.has(id)));
  if (cleanup) files.splice(1, 0, cleanup); // Durable intent precedes the metadata deletion.
  // Compare actual bytes, not a stale in-memory hash. Bounded reads also notice
  // missing/external-edited files without opening the whole vault at once.
  return changedFiles(files);
}

async function applyFiles(vaultRoot: string, userStateDir: string, files: [string, string][], write: Writer): Promise<void> {
  await fs.mkdir(path.join(vaultRoot, 'notes'), { recursive: true });
  await fs.mkdir(userStateDir, { recursive: true });
  // Keep the existing commit order and recovery journal. Only skip files
  // whose saved bytes already match, including during an interrupted replay.
  for (const [file, content] of files) await write(file, content);
  // 不批量删除 .md：未引用文件保留为可恢复孤立原文，不删除用户手工文件。
}

async function recoverUnlocked(vaultRoot: string, userStateDir: string, write: Writer): Promise<void> {
  let text: string;
  try { text = await fs.readFile(path.join(userStateDir, JOURNAL), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  const pending = JSON.parse(text);
  const files = pending?.version === 1 && Array.isArray(pending.notes)
    ? await changedSnapshotFiles(vaultRoot, userStateDir, pending.notes)
    : pending?.version === 2 ? await changedFiles(decodeDelta(vaultRoot, userStateDir, pending.files))
      : (() => { throw new Error('待恢复快照无效；已保留原文件'); })();
  await applyFiles(vaultRoot, userStateDir, files, write);
  await fs.rm(path.join(userStateDir, JOURNAL), { force: true });
}

export function recoverVaultSnapshot(vaultRoot: string, userStateDir: string): Promise<void> {
  const root = path.resolve(vaultRoot);
  const states = path.resolve(userStateDir);
  return withRagSourceTransaction([root, states], () => recoverUnlocked(root, states, atomicWriteTextFile));
}

/** Caller already holds the complete saved-source transaction (e.g. migration). */
export function recoverVaultSnapshotInTransaction(vaultRoot: string, userStateDir: string): Promise<void> {
  return recoverUnlocked(path.resolve(vaultRoot), path.resolve(userStateDir), atomicWriteTextFile);
}

/** Caller holds withSavedVaultSnapshot's source transaction. Keep partial-note
 * saves on the same V2 recovery protocol as complete snapshots. */
export async function commitVaultFilesInTransaction(vaultRoot: string, userStateDir: string, files: [string, string][],
  write: Writer = atomicWriteTextFile, isCurrent?: () => boolean): Promise<void> {
  if (!files.length) return;
  if (isCurrent && !isCurrent()) throw new Error('rag_source_environment_changed');
  const root = path.resolve(vaultRoot), states = path.resolve(userStateDir);
  const encoded = encodeDelta(root, states, files);
  const validated = decodeDelta(root, states, encoded);
  const targets = new Set(files.map(([file]) => path.resolve(file)));
  if (validated.some(([file]) => !targets.has(file))) throw new Error('笔记变更文件路径无效');
  await fs.mkdir(states, { recursive: true });
  await write(path.join(states, JOURNAL), JSON.stringify({ version: 2, files: encoded }));
  await applyFiles(root, states, validated, write);
  await fs.rm(path.join(states, JOURNAL), { force: true });
}

/** Short saved-source transaction. The callback must not call public recovery/save APIs. */
export function withSavedVaultSnapshot<T>(vaultRoot: string, userStateDir: string, action: () => Promise<T>, isCurrent?: () => boolean): Promise<T> {
  const root = path.resolve(vaultRoot);
  const states = path.resolve(userStateDir);
  return withRagSourceTransaction([root, states], async () => {
    if (isCurrent && !isCurrent()) throw new Error('rag_source_environment_changed');
    await recoverUnlocked(root, states, atomicWriteTextFile);
    return action();
  });
}

/** 多文件可恢复事务：只写变化文件，失败不报成功；恢复兼容旧版完整快照。 */
export function saveVaultSnapshot(vaultRoot: string, userStateDir: string, notes: NoteItem[], write: Writer = atomicWriteTextFile, isCurrent?: () => boolean): Promise<void> {
  const root = path.resolve(vaultRoot);
  const states = path.resolve(userStateDir);
  validateNotes(notes, root);
  const snapshot = JSON.parse(JSON.stringify(notes)) as NoteItem[];
  return withRagSourceTransaction([root, states], async () => {
    // Reject an obsolete queued operation before creating a journal, not halfway through it.
    if (isCurrent && !isCurrent()) throw new Error('rag_source_environment_changed');
    await fs.mkdir(states, { recursive: true });
    await recoverUnlocked(root, states, write);
    const files = await changedSnapshotFiles(root, states, snapshot);
    if (isCurrent && !isCurrent()) throw new Error('rag_source_environment_changed');
    if (!files.length) return;
    // V2 contains only files that need changing, not every unchanged textbook.
    // Aggregate JSON files retain complete bytes so a partial replacement remains recoverable.
    await write(path.join(states, JOURNAL), JSON.stringify({ version: 2, files: encodeDelta(root, states, files) }));
    await applyFiles(root, states, files, write);
    await fs.rm(path.join(states, JOURNAL), { force: true });
  });
}
