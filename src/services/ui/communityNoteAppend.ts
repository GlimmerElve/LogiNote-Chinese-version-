import type { NoteItem } from '../../types';

/** Existing identities include locally pending deletions. An import refresh may
 * append new saved notes, but must never replace an editor draft or its before. */
export function prepareCommunityNoteAppend(current: NoteItem[], saved: readonly NoteItem[], baseline: readonly NoteItem[]) {
  const known = new Set([...current, ...baseline].map(note => note.id));
  const added: NoteItem[] = [];
  for (const note of saved) {
    if (known.has(note.id)) continue;
    known.add(note.id); added.push(note);
  }
  return { added, notes: added.length ? [...current, ...added] : current };
}
