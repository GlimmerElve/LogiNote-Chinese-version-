import type { NoteItem } from '../types';
import type { VaultNotesDelta } from './vaultNoteDelta';

const derivedFields = new Set(['links', 'backlinks']);
const sameValue = (a: unknown, b: unknown) => a === b || typeof a === 'object' && typeof b === 'object'
  && a !== null && b !== null && JSON.stringify(a) === JSON.stringify(b);

/** Metadata publications can replace a note object solely to refresh graph
 * edges. Compare source fields without serializing unchanged document bodies. */
export function samePersistedNoteSource(before: NoteItem, after: NoteItem): boolean {
  if (before === after) return true;
  const a = before as unknown as Record<string, unknown>, b = after as unknown as Record<string, unknown>;
  for (const field of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!derivedFields.has(field) && !sameValue(a[field], b[field])) return false;
  }
  return true;
}

/** Holds immutable acknowledged note identities, never a deep copy of the
 * vault. Only a successful persistence call is allowed to advance this map. */
export function createNoteSaveBaseline() {
  let saved: Map<string, NoteItem> | undefined;
  const map = (notes: readonly NoteItem[]) => {
    const result = new Map<string, NoteItem>();
    for (const note of notes) {
      if (!note || typeof note.id !== 'string' || result.has(note.id)) throw new Error('笔记身份无效或重复，未保存');
      result.set(note.id, note);
    }
    return result;
  };
  return {
    reset() { saved = undefined; },
    snapshot(): readonly NoteItem[] | undefined { return saved ? [...saved.values()] : undefined; },
    acknowledge(notes: readonly NoteItem[]) { saved = map(notes); },
    /** A read-only import notification can confirm new disk identities without
     * replacing any existing before value or reviving a locally pending delete. */
    acknowledgeNew(notes: readonly NoteItem[]) {
      if (!saved) throw new Error('笔记保存基线尚未就绪，未合入导入笔记');
      for (const [id, note] of map(notes)) if (!saved.has(id)) saved.set(id, note);
    },
    acknowledgeDelta(delta: VaultNotesDelta) {
      if (!saved) throw new Error('笔记保存基线已变化，请重新载入');
      for (const { note, before } of delta.upserts) {
        const current = saved.get(note.id);
        if (!before || !current) { saved.set(note.id, note); continue; }
        const next = { ...current } as unknown as Record<string, unknown>;
        const a = before as unknown as Record<string, unknown>, b = note as unknown as Record<string, unknown>;
        for (const field of new Set([...Object.keys(a), ...Object.keys(b)])) {
          if (sameValue(a[field], b[field])) continue;
          if (b[field] === undefined) delete next[field]; else next[field] = b[field];
        }
        saved.set(note.id, next as unknown as NoteItem);
      }
      for (const { id } of delta.removed) saved.delete(id);
      for (const item of delta.derivedLinks || []) {
        const current = saved.get(item.id);
        if (current) saved.set(item.id, { ...current, links: item.links });
      }
    },
    acknowledgeFields(notes: readonly NoteItem[], fields: readonly (keyof NoteItem)[]) {
      if (!saved) return;
      for (const note of notes) {
        const previous = saved.get(note.id);
        if (!previous || fields.every(field => previous[field] === note[field])) continue;
        const next = { ...previous };
        for (const field of fields) {
          if (note[field] === undefined) delete (next as any)[field];
          else (next as any)[field] = note[field];
        }
        saved.set(note.id, next);
      }
    },
    delta(notes: readonly NoteItem[]): VaultNotesDelta | null {
      if (!saved) return null;
      const next = map(notes);
      const upserts: VaultNotesDelta['upserts'] = [];
      const removed: VaultNotesDelta['removed'] = [];
      const derivedLinks: NonNullable<VaultNotesDelta['derivedLinks']> = [];
      for (const note of next.values()) {
        const before = saved.get(note.id);
        if (!before || !samePersistedNoteSource(before, note)) upserts.push({ note, before: before || null });
        else if (!sameValue(before.links, note.links)) derivedLinks.push({ id: note.id, links: note.links,
          expectedUpdatedAt: before.updatedAt, expectedTitle: before.title });
      }
      for (const before of saved.values()) if (!next.has(before.id)) removed.push({ id: before.id, before });
      return { upserts, removed, ...(derivedLinks.length ? { derivedLinks } : {}) };
    },
  };
}

export const persistedNoteSaveBaseline = createNoteSaveBaseline();
