import fs from 'node:fs/promises';
import path from 'node:path';
import type { NoteItem, UserNoteState } from '../types';
import type { VaultNotesDelta } from '../services/vaultNoteDelta';
import { splitSharableFields, splitUserStateFields, mergeNote, USER_STATE_FILES } from '../services/userStateService';
import { markdownFileName, type NoteMeta, type VaultMetadataFile } from '../services/vaultFsService';
import { atomicWriteTextFile } from './atomicWrite';
import { withSavedVaultSnapshot, commitVaultFilesInTransaction } from './vaultSnapshot';
import { prepareNoteIndexCleanupDelta } from './noteIndexCleanupJournal';
import { nextKnowledgeLifecycle } from '../services/knowledgeLifecycle';
import { knowledgeLifecyclePath, readKnowledgeLifecycle } from './knowledgeLifecycle';

const key = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
const canonical = (input: unknown): unknown => Array.isArray(input) ? input.map(canonical)
  : input && typeof input === 'object' ? Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, value]) => [name, canonical(value)])) : input;
const equal = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const define = (object: object, id: string, value: unknown) => Object.defineProperty(object, id,
  { value, configurable: true, writable: true, enumerable: true });

function validateNote(note: unknown): asserts note is NoteItem {
  const value = note as NoteItem;
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.id !== 'string' || !value.id
    || value.id.length > 300 || /[<>:"/\\|?*\u0000-\u001f]/u.test(value.id) || value.id === '.' || value.id === '..'
    || typeof value.content !== 'string' || typeof value.title !== 'string'
    || !['project', 'knowledge'].includes(value.noteType) || !Array.isArray(value.tags)
    || !Array.isArray(value.links) || !Array.isArray(value.backlinks) || !Array.isArray(value.dueDates)
    || typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') throw new Error('笔记增量字段无效，未覆盖本地文件');
}

/** Freeze only the bounded changed-note payload, never an entire vault. */
export function validateVaultNotesDelta(input: unknown): VaultNotesDelta {
  const value = input as VaultNotesDelta;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(name => !['upserts', 'removed', 'derivedLinks', 'knowledgeMerges'].includes(name))
    || !Array.isArray(value.upserts) || !Array.isArray(value.removed)
    || value.derivedLinks !== undefined && !Array.isArray(value.derivedLinks)
    || value.upserts.length + value.removed.length + (value.derivedLinks?.length || 0) > 20000) throw new Error('笔记增量请求无效');
  const names = new Set<string>();
  const claim = (id: string) => { const name = key(markdownFileName(id)); if (names.has(name)) throw new Error('笔记增量ID重复'); names.add(name); };
  for (const entry of value.upserts) {
    if (!entry || typeof entry !== 'object' || Object.keys(entry).some(name => name !== 'note' && name !== 'before')) throw new Error('笔记增量项目无效');
    validateNote(entry.note); claim(entry.note.id);
    if (entry.before !== null) { validateNote(entry.before); if (entry.before.id !== entry.note.id) throw new Error('笔记基线ID不匹配'); }
  }
  for (const entry of value.removed) {
    if (!entry || typeof entry !== 'object' || Object.keys(entry).some(name => name !== 'id' && name !== 'before')) throw new Error('笔记移除项目无效');
    validateNote(entry.before); if (entry.id !== entry.before.id) throw new Error('笔记移除ID不匹配'); claim(entry.id);
  }
  for (const entry of value.derivedLinks || []) {
    if (!entry || typeof entry !== 'object' || Object.keys(entry).some(name => !['id', 'links', 'expectedUpdatedAt', 'expectedTitle'].includes(name))
      || typeof entry.id !== 'string' || !entry.id || entry.id.length > 300 || /[<>:"/\\|?*\u0000-\u001f]/u.test(entry.id)
      || !Array.isArray(entry.links) || entry.links.length > 100000 || entry.links.some(link => typeof link !== 'string' || link.length > 50000)
      || typeof entry.expectedUpdatedAt !== 'string' || typeof entry.expectedTitle !== 'string') throw new Error('派生链接变更无效');
    claim(entry.id);
  }
  if (value.knowledgeMerges !== undefined && (!Array.isArray(value.knowledgeMerges) || value.knowledgeMerges.length > 30
    || new Set(value.knowledgeMerges.map(row => row?.sourceId)).size !== value.knowledgeMerges.length)) throw Error('知识点迁移范围无效');
  for (const row of value.knowledgeMerges || []) {
    if (!row || Object.keys(row).some(name => !['sourceId', 'targetId'].includes(name)) || typeof row.targetId !== 'string' || !row.targetId
      || row.targetId === row.sourceId || !value.removed.some(entry => entry.id === row.sourceId && entry.before.noteType === 'knowledge')
      || !value.upserts.some(entry => entry.note.id === row.targetId && entry.note.noteType === 'knowledge')) throw Error('知识点迁移必须属于本次明确删除和保存的对象');
  }
  return structuredClone(value);
}

function mergeFields(current: Record<string, unknown>, before: Record<string, unknown>, after: Record<string, unknown>, id: string): Record<string, unknown> {
  const next = { ...current };
  for (const field of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (field === 'content' || field === 'id' || equal(before[field], after[field])) continue;
    if (!['links', 'backlinks'].includes(field) && !equal(current[field], before[field]) && !equal(current[field], after[field])) {
      throw new Error(`笔记“${id}”的${field}已在其他位置修改，请重新载入后再保存`);
    }
    if (after[field] === undefined) delete next[field]; else define(next, field, after[field]);
  }
  return next;
}

/** Derived link bookkeeping uses the saved directory only. A peer's backlinks
 * must not require sending or opening that peer's unchanged Markdown body. */
function refreshDirectoryBacklinks(metadata: VaultMetadataFile): void {
  const titles = new Map<string, string>(), aliases = new Map<string, string>();
  const rows = Object.values(metadata.notesMeta);
  for (const note of rows) {
    const title = note.title?.trim().toLowerCase();
    if (title && !titles.has(title)) titles.set(title, note.title);
    for (const alias of note.aliases || []) {
      const normalized = alias.trim().toLowerCase(); if (!aliases.has(normalized)) aliases.set(normalized, note.title);
    }
  }
  const incoming = new Map<string, Set<string>>();
  for (const note of rows) {
    const links = (note.links || []).map(target => titles.get(target.trim().toLowerCase()) ?? aliases.get(target.trim().toLowerCase()) ?? target);
    if (!equal(links, note.links)) note.links = links;
    for (const link of links) {
      if (!incoming.has(link)) incoming.set(link, new Set());
      incoming.get(link)!.add(note.title);
    }
  }
  for (const note of rows) {
    const backlinks = [...(incoming.get(note.title) || [])];
    if (!equal(backlinks, note.backlinks)) note.backlinks = backlinks;
  }
}

interface DeltaSaveOptions {
  isCurrent?: () => boolean;
  write?: (file: string, text: string) => Promise<unknown>;
  read?: typeof fs.readFile;
  /** Only touched saved notes are observed, in the same serialized source turn. */
  observe?: (next: NoteItem[], previous: NoteItem[]) => void;
  /** Host-only admission guard, evaluated inside the same saved-source transaction. */
  guardMetadata?: (metadata: VaultMetadataFile) => void | Promise<void>;
}

/** Ordinary editing reads only the changed IDs' Markdown, plus the shared small
 * directory/private-state files. Unmentioned notes and community imports remain
 * present; there is no whole-vault body traversal, clone or snapshot replacement. */
export async function saveVaultNotesDelta(vaultRoot: string, userStateDir: string, input: unknown, options: DeltaSaveOptions = {}): Promise<void> {
  const delta = validateVaultNotesDelta(input);
  if (!delta.upserts.length && !delta.removed.length && !delta.derivedLinks?.length) return;
  const root = path.resolve(vaultRoot), states = path.resolve(userStateDir), read = options.read ?? fs.readFile;
  const assertCurrent = () => { if (options.isCurrent && !options.isCurrent()) throw new Error('rag_source_environment_changed'); };
  await withSavedVaultSnapshot(root, states, async () => {
    assertCurrent();
    const metadataPath = path.join(root, 'metadata.json'), privatePath = path.join(states, USER_STATE_FILES.noteStates);
    let metadataText: string | undefined;
    try { metadataText = await read(metadataPath, 'utf8') as string; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // A genuinely empty native vault can create its first note incrementally.
      // A missing directory beside existing originals is recovery, not emptiness.
      let names: string[] = [];
      try { names = await fs.readdir(path.join(root, 'notes')); }
      catch (directoryError) { if ((directoryError as NodeJS.ErrnoException).code !== 'ENOENT') throw directoryError; }
      if (names.some(name => name.endsWith('.md'))) throw new Error('笔记目录缺失但原文仍存在，未初始化或覆盖笔记库');
    }
    const metadata = metadataText === undefined ? { version: 1, notesMeta: {} } : JSON.parse(metadataText) as VaultMetadataFile;
    if (metadata?.version !== 1 || !metadata.notesMeta || typeof metadata.notesMeta !== 'object' || Array.isArray(metadata.notesMeta))
      throw new Error('笔记目录无效，未覆盖本地文件');
    await options.guardMetadata?.(metadata);
    let privateText: string | undefined;
    try { privateText = await read(privatePath, 'utf8') as string; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const personal = privateText === undefined ? { version: 1, noteStates: {} as Record<string, UserNoteState> } : JSON.parse(privateText);
    if (personal?.version !== 1 || !personal.noteStates || typeof personal.noteStates !== 'object' || Array.isArray(personal.noteStates))
      throw new Error('个人记录无效，未覆盖本地文件');
    const names = new Map(Object.keys(metadata.notesMeta).map(id => [key(markdownFileName(id)), id]));
    const files: [string, string][] = [], previous: NoteItem[] = [], next: NoteItem[] = [], removed: string[] = [];
    const readBody = async (id: string): Promise<string | undefined> => {
      try { return await read(path.join(root, 'notes', markdownFileName(id)), 'utf8') as string; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return undefined; }
    };
    const current = (id: string, content: string): NoteItem => {
      const meta = Object.hasOwn(metadata.notesMeta, id) ? metadata.notesMeta[id] : undefined;
      const state = Object.hasOwn(personal.noteStates, id) ? personal.noteStates[id] : undefined;
      if (!meta || typeof meta !== 'object' || Array.isArray(meta) || state !== undefined && (!state || typeof state !== 'object' || Array.isArray(state)))
        throw new Error('笔记目录或个人记录无效，未覆盖本地文件');
      return mergeNote({ ...meta, id, content } as NoteItem, state);
    };
    for (const entry of delta.upserts) {
      const id = entry.note.id, existingId = names.get(key(markdownFileName(id)));
      if (existingId !== undefined && existingId !== id) throw new Error('笔记文件名与现有笔记冲突');
      const body = await readBody(id);
      if (entry.before === null) {
        if (existingId !== undefined) {
          // A recovered transaction may already have completed this create.
          const saved = body === undefined ? undefined : current(id, body);
          const actual = saved && splitSharableFields(saved), expected = splitSharableFields(entry.note);
          if (actual) for (const field of ['links', 'backlinks'] as const) { delete actual[field]; delete expected[field]; }
          // A separately saved reading/private update does not make an already
          // committed creation fail. Never replace that newer private state.
          if (!saved || !equal(actual, expected)) throw new Error(`笔记“${id}”已存在，请重新载入`);
          previous.push(saved); next.push(saved); continue;
        }
        if (body !== undefined && body !== entry.note.content) throw new Error(`笔记“${id}”存在未登记原文，未覆盖该文件`);
        const share = splitSharableFields(entry.note), meta = { ...share } as Partial<NoteItem>; delete meta.content;
        define(metadata.notesMeta, id, meta);
        const state = splitUserStateFields(entry.note); if (Object.keys(state).length) define(personal.noteStates, id, state);
        if (body !== entry.note.content) files.push([path.join(root, 'notes', markdownFileName(id)), entry.note.content]);
        next.push(entry.note); continue;
      }
      if (existingId === undefined || body === undefined) throw new Error(`笔记“${id}”已移除或正文缺失，请重新载入`);
      if (body !== entry.before.content && body !== entry.note.content) throw new Error(`笔记“${id}”正文已在其他位置修改，未覆盖原文`);
      const saved = current(id, body); previous.push(saved);
      const shared = mergeFields(splitSharableFields(saved) as unknown as Record<string, unknown>,
        splitSharableFields(entry.before) as unknown as Record<string, unknown>, splitSharableFields(entry.note) as unknown as Record<string, unknown>, id);
      const state = mergeFields(splitUserStateFields(saved) as Record<string, unknown>, splitUserStateFields(entry.before) as Record<string, unknown>,
        splitUserStateFields(entry.note) as Record<string, unknown>, id) as UserNoteState;
      const content = entry.before.content === entry.note.content ? body : entry.note.content;
      const savedMeta = { ...shared, id } as Partial<NoteItem>; delete savedMeta.content;
      define(metadata.notesMeta, id, savedMeta as NoteMeta);
      if (Object.keys(state).length) define(personal.noteStates, id, state); else delete personal.noteStates[id];
      if (content !== body) files.push([path.join(root, 'notes', markdownFileName(id)), content]);
      next.push(mergeNote({ ...savedMeta, id, content } as NoteItem, state));
    }
    for (const entry of delta.removed) {
      if (!Object.hasOwn(metadata.notesMeta, entry.id)) continue; // Recovered removal retry.
      const body = await readBody(entry.id);
      if (body === undefined || body !== entry.before.content) throw new Error(`笔记“${entry.id}”正文已变化，未移除该笔记`);
      const saved = current(entry.id, body), actual = splitSharableFields(saved) as unknown as Record<string, unknown>;
      const expected = splitSharableFields(entry.before) as unknown as Record<string, unknown>;
      // Links/backlinks are derived from the vault. They do not authorize a body
      // overwrite and may legitimately differ after a concurrent unrelated save.
      for (const field of ['links', 'backlinks']) { delete actual[field]; delete expected[field]; }
      if (!equal(actual, expected) || !equal(saved.communityImport, entry.before.communityImport))
        throw new Error(`笔记“${entry.id}”已变化或尚未同步社区导入，未移除该笔记`);
      previous.push(saved); removed.push(entry.id);
      delete metadata.notesMeta[entry.id]; delete personal.noteStates[entry.id];
    }
    for (const update of delta.derivedLinks || []) {
      const peer = Object.hasOwn(metadata.notesMeta, update.id) ? metadata.notesMeta[update.id] : undefined;
      if (!peer || peer.title !== update.expectedTitle || peer.updatedAt !== update.expectedUpdatedAt)
        throw new Error(`笔记“${update.id}”的派生链接基线已变化，请重新载入后保存`);
      peer.links = update.links;
    }
    refreshDirectoryBacklinks(metadata);
    const nextPrivate = JSON.stringify(personal, null, 2), nextMetadata = JSON.stringify(metadata, null, 2);
    if (delta.removed.some(entry => entry.before.noteType === 'knowledge') || delta.upserts.some(entry => !entry.before && entry.note.noteType === 'knowledge')) {
      const lifecycle = await readKnowledgeLifecycle(states), updated = nextKnowledgeLifecycle(lifecycle, delta);
      if (!equal(lifecycle, updated)) files.push([knowledgeLifecyclePath(states), JSON.stringify(updated)]);
    }
    if (nextPrivate !== privateText && (privateText !== undefined || Object.keys(personal.noteStates).length)) files.unshift([privatePath, nextPrivate]);
    const cleanup = await prepareNoteIndexCleanupDelta(root, states, removed); if (cleanup) files.unshift(cleanup);
    if (nextMetadata !== metadataText) files.push([metadataPath, nextMetadata]);
    assertCurrent();
    if (!files.length) return;
    options.observe?.(next, previous);
    await commitVaultFilesInTransaction(root, states, files, options.write ?? atomicWriteTextFile, options.isCurrent);
  }, options.isCurrent);
}

function checkedIds(ids: readonly string[]): void {
  if (!Array.isArray(ids) || ids.length > 100000 || ids.some(id => typeof id !== 'string' || !id || id.length > 300 || /[<>:"/\\|?*\u0000-\u001f]/u.test(id)))
    throw new Error('笔记读取范围无效');
}

/** ID-scoped background reads share the same recovery/source lock as saves. */
export async function readSavedVaultNotesByIds(vaultRoot: string, userStateDir: string, ids: readonly string[],
  options: Pick<DeltaSaveOptions, 'read' | 'isCurrent'> = {}): Promise<NoteItem[]> {
  checkedIds(ids); const selected = [...new Set(ids)]; if (!selected.length) return [];
  const root = path.resolve(vaultRoot), states = path.resolve(userStateDir), read = options.read ?? fs.readFile;
  return withSavedVaultSnapshot(root, states, async () => {
    const metadata = JSON.parse(await read(path.join(root, 'metadata.json'), 'utf8') as string);
    if (metadata?.version !== 1 || !metadata.notesMeta || typeof metadata.notesMeta !== 'object' || Array.isArray(metadata.notesMeta)) throw new Error('笔记目录无效');
    let personal: { version: number; noteStates: Record<string, UserNoteState> } = { version: 1, noteStates: {} };
    try { personal = JSON.parse(await read(path.join(states, USER_STATE_FILES.noteStates), 'utf8') as string); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (personal.version !== 1 || !personal.noteStates || typeof personal.noteStates !== 'object' || Array.isArray(personal.noteStates)) throw new Error('个人记录无效');
    const notes: NoteItem[] = [];
    for (const id of selected) {
      if (!Object.hasOwn(metadata.notesMeta, id)) continue;
      const content = await read(path.join(root, 'notes', markdownFileName(id)), 'utf8') as string;
      notes.push(mergeNote({ ...metadata.notesMeta[id], id, content }, Object.hasOwn(personal.noteStates, id) ? personal.noteStates[id] : undefined));
    }
    if (options.isCurrent && !options.isCurrent()) throw new Error('rag_source_environment_changed');
    return notes;
  }, options.isCurrent);
}

/** Deletion maintenance needs only IDs, never the bodies of live notes. */
export async function readSavedVaultNoteIds(vaultRoot: string, userStateDir: string, isCurrent?: () => boolean): Promise<string[]> {
  return withSavedVaultSnapshot(vaultRoot, userStateDir, async () => {
    const metadata = JSON.parse(await fs.readFile(path.join(vaultRoot, 'metadata.json'), 'utf8'));
    if (metadata?.version !== 1 || !metadata.notesMeta || typeof metadata.notesMeta !== 'object' || Array.isArray(metadata.notesMeta)) throw new Error('笔记目录无效');
    const ids = Object.keys(metadata.notesMeta); checkedIds(ids);
    if (isCurrent && !isCurrent()) throw new Error('rag_source_environment_changed');
    return ids;
  }, isCurrent);
}
