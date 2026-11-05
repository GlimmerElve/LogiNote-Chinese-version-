import type { NoteItem } from '../types';

/** Default names share the same case-insensitive title/alias namespace as wiki links. */
export function availableNoteTitle(requested: string, notes: readonly NoteItem[]): string {
  const base = requested.trim().slice(0, 120) || '未命名学习笔记';
  const occupied = new Set(notes.flatMap(note => [note.title, ...(note.aliases || [])])
    .map(title => title.trim().toLowerCase()));
  let candidate = base;
  for (let number = 2; occupied.has(candidate.toLowerCase()); number++) {
    const suffix = `（${number}）`;
    candidate = base.slice(0, 120 - suffix.length) + suffix;
  }
  return candidate;
}
