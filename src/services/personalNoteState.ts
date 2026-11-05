import type { NoteItem, UserNoteState } from '../types';
import { SHARABLE_NOTE_FIELDS, USER_STATE_FIELDS } from './userStateService';

export type PersonalNoteField = (typeof USER_STATE_FIELDS)[number];
export type StoredPersonalValue = { present: false } | { present: true; value: unknown };
export interface PersonalNotePatch {
  noteId: string; noteType: NoteItem['noteType'];
  changes: { field: PersonalNoteField; before: StoredPersonalValue; after: StoredPersonalValue }[];
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
export function samePersonalValue(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
export function storedPersonalValue(state: UserNoteState | NoteItem, field: PersonalNoteField): StoredPersonalValue {
  const value = state[field];
  return value === undefined ? { present: false } : { present: true, value: JSON.parse(JSON.stringify(value)) };
}
export function isPersonalOnlyNoteChange(before: NoteItem, after: NoteItem): boolean {
  return before.id === after.id && SHARABLE_NOTE_FIELDS.every(field => samePersonalValue(before[field], after[field]));
}
export function personalNotePatches(before: NoteItem[], after: NoteItem[]): PersonalNotePatch[] | null {
  if (before.length !== after.length) return null;
  const patches: PersonalNotePatch[] = [];
  for (let index = 0; index < after.length; index++) {
    const previous = before[index], next = after[index];
    if (!isPersonalOnlyNoteChange(previous, next)) return null;
    const changes = USER_STATE_FIELDS.filter(field => !samePersonalValue(previous[field], next[field]))
      .map(field => ({ field, before: storedPersonalValue(previous, field), after: storedPersonalValue(next, field) }));
    if (changes.length) patches.push({ noteId: next.id, noteType: next.noteType, changes });
  }
  return patches;
}
