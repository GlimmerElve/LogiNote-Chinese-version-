import type { NoteItem } from '../types';
import type { VaultNotesDelta } from './vaultNoteDelta';

export interface KnowledgeDisposition { id: string; title: string; aliases: string[]; targetId?: string; at: string }
export interface KnowledgeLifecycle { version: 1; entries: KnowledgeDisposition[] }
export const EMPTY_KNOWLEDGE_LIFECYCLE: KnowledgeLifecycle = { version: 1, entries: [] };
export const knowledgeName = (name: string) => name.normalize('NFKC').trim().toLocaleLowerCase();
let current: KnowledgeLifecycle = EMPTY_KNOWLEDGE_LIFECYCLE;
const catalogues = new WeakMap<KnowledgeLifecycle, { ids: Map<string, KnowledgeDisposition>; names: Map<string, KnowledgeDisposition[]> }>();
function catalogue(file: KnowledgeLifecycle) {
  let index = catalogues.get(file); if (index) return index;
  index = { ids: new Map(), names: new Map() };
  for (const row of file.entries) { index.ids.set(row.id, row);
    for (const name of new Set([row.title, ...row.aliases].map(knowledgeName))) { const matches = index.names.get(name) || []; matches.push(row); index.names.set(name, matches); } }
  catalogues.set(file, index); return index;
}
export function validateKnowledgeLifecycle(value: unknown): KnowledgeLifecycle {
  if (value == null) return { version: 1, entries: [] };
  const file = value as KnowledgeLifecycle;
  if (file.version !== 1 || !Array.isArray(file.entries) || file.entries.length > 20000 || file.entries.some(row => !row
    || typeof row.id !== 'string' || !row.id || typeof row.title !== 'string' || !Array.isArray(row.aliases)
    || row.aliases.some(name => typeof name !== 'string') || typeof row.at !== 'string'
    || row.targetId !== undefined && (typeof row.targetId !== 'string' || !row.targetId || row.targetId === row.id))
    || new Set(file.entries.map(row => row.id)).size !== file.entries.length) throw Error('知识点整理记录无效，已停止自动创建');
  return file;
}
export function setKnowledgeLifecycle(value: unknown) { current = validateKnowledgeLifecycle(value); }
export function getKnowledgeLifecycle() { return current; }
export function knowledgeDisposition(file: KnowledgeLifecycle, id?: string, title?: string): KnowledgeDisposition | undefined {
  const index = catalogue(file), exact = id && index.ids.get(id);
  if (exact) return exact;
  if (!title) return;
  const matches = index.names.get(knowledgeName(title)) || [];
  if (matches.length === 1) return matches[0];
  if (matches.length && matches.every(row => row.targetId && row.targetId === matches[0].targetId)) return matches[0];
}
export function knowledgeDestination(file: KnowledgeLifecycle, id: string): string | undefined {
  const seen = new Set<string>(); let next = id;
  while (!seen.has(next)) {
    seen.add(next); const row = catalogue(file).ids.get(next);
    if (!row) return next;
    if (!row.targetId) return;
    next = row.targetId;
  }
}
/** Private identity migration, not a claim that the old and new names are synonyms. */
export function migratedKnowledge<T extends Pick<NoteItem, 'id' | 'title' | 'aliases'>>(name: string, notes: readonly T[]): T | undefined {
  const disposition = knowledgeDisposition(current, undefined, name);
  const id = disposition && knowledgeDestination(current, disposition.id);
  return id ? notes.find(note => note.id === id) : undefined;
}
export function nextKnowledgeLifecycle(file: KnowledgeLifecycle, delta: VaultNotesDelta, at = new Date().toISOString()): KnowledgeLifecycle {
  const entries = new Map(file.entries.map(row => [row.id, row]));
  for (const { note, before } of delta.upserts) if (note.noteType === 'knowledge' && !before) entries.delete(note.id);
  const merges = new Map((delta.knowledgeMerges || []).map(row => [row.sourceId, row.targetId]));
  for (const { id, before } of delta.removed) if (before.noteType === 'knowledge') entries.set(id,
    { id, title: before.title, aliases: before.aliases || [], ...(merges.has(id) ? { targetId: merges.get(id)! } : {}), at: entries.get(id)?.at || at });
  return validateKnowledgeLifecycle({ version: 1, entries: [...entries.values()] });
}
