import type { NoteItem } from '../../types';
import { personalNotePatches, type PersonalNotePatch } from '../personalNoteState';
import { persistedNoteSaveBaseline } from '../noteSaveBaseline';
import { USER_STATE_FIELDS } from '../userStateService';

export interface PersonalOnlySave { baseline: NoteItem[]; latest: NoteItem[] }
export function trackPersonalOnlySave(previous: NoteItem[], next: NoteItem[], pending: NoteItem[] | null,
  tracked: PersonalOnlySave | null): PersonalOnlySave | null {
  const baseline = pending === null ? previous : pending === previous && tracked?.latest === previous ? tracked.baseline : null;
  return baseline && personalNotePatches(baseline, next) !== null ? { baseline, latest: next } : null;
}
/** Acknowledging an older write rebases pending personal edits, never erases them. */
export function acknowledgePersonalSave(tracked: PersonalOnlySave | null, saved: NoteItem[]): PersonalOnlySave | null {
  if (!tracked || tracked.latest === saved) return null;
  return personalNotePatches(saved, tracked.latest) !== null ? { baseline: saved, latest: tracked.latest } : null;
}
export async function savePersonalStateOnly(notes: NoteItem[], tracked: PersonalOnlySave | null): Promise<boolean> {
  if (!tracked || tracked.latest !== notes || typeof window === 'undefined') return false;
  const api = (window as unknown as { electronAPI?: { vault?: {
    savePersonalState?: (patches: PersonalNotePatch[]) => Promise<void>;
  } } }).electronAPI?.vault;
  if (!api?.savePersonalState) return false;
  const patches = personalNotePatches(tracked.baseline, notes);
  if (!patches) return false;
  await api.savePersonalState(patches);
  persistedNoteSaveBaseline.acknowledgeFields(notes, USER_STATE_FIELDS);
  return true;
}
