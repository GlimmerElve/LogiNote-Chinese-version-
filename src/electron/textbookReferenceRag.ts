import path from 'node:path';
import type { NoteItem } from '../types.ts';
import { createTextbookReferenceIndex } from './rag/textbookReferenceIndex.ts';

const roots = new Map<string, ReturnType<typeof createTextbookReferenceIndex>>();
let active: ReturnType<typeof createTextbookReferenceIndex> | undefined;
const store = () => {
  if (!active) throw new Error('教材索引目录尚未初始化');
  return active;
};

export function setTextbookReferenceDataRoot(root: string): void {
  if (!root || !path.isAbsolute(root)) throw new Error('教材索引目录未初始化');
  const resolved = path.resolve(root);
  if (!roots.has(resolved)) roots.set(resolved, createTextbookReferenceIndex(resolved));
  active = roots.get(resolved);
}

export const syncTextbookReferenceNotes = (notes: readonly NoteItem[]) => store().syncNotes(notes);
export const syncTextbookReferenceNote = (note: NoteItem, force = false) => store().syncNote(note, force);
export const deleteTextbookReferenceNote = (noteId: string) => store().removeNote(noteId);
export const getTextbookReferenceStatus = (noteId: string) => store().status(noteId);
export const searchTextbookReferences = (query: string, limit = 3, allowedNoteIds?: readonly string[]) =>
  store().search(query, limit, allowedNoteIds);
