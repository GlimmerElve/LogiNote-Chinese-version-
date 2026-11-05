import type { NoteItem } from '../../types';
import type { TextbookReadingUpdate } from '../textbook/readingState';
import { persistedNoteSaveBaseline } from '../noteSaveBaseline';

export interface ReadingOnlySave { baseline: NoteItem[]; latest: NoteItem[] }

/** A narrow lane is valid only while no content/other personal edits are pending. */
export function trackReadingOnlySave(previous: NoteItem[], next: NoteItem[], pending: NoteItem[] | null,
  tracked: ReadingOnlySave | null): ReadingOnlySave | null {
  if (pending === null) return { baseline: previous, latest: next };
  return pending === previous && tracked?.latest === previous ? { baseline: tracked.baseline, latest: next } : null;
}

export async function saveReadingPositionOnly(notes: NoteItem[], tracked: ReadingOnlySave | null): Promise<boolean> {
  if (!tracked || tracked.latest !== notes) return false;
  const api = (window as unknown as { electronAPI?: { vault?: {
    saveReadingPositions?: (updates: TextbookReadingUpdate[]) => Promise<void>;
  } } }).electronAPI?.vault;
  // Browser/older preload retains the authoritative full-snapshot save path.
  if (!api?.saveReadingPositions) return false;
  const baseline = new Map(tracked.baseline.map(note => [note.id, note]));
  const updates: TextbookReadingUpdate[] = [];
  for (const note of notes) {
    if (note.textbookReadingState && note.textbookReadingState !== baseline.get(note.id)?.textbookReadingState)
      updates.push({ noteId: note.id, state: note.textbookReadingState });
  }
  await api.saveReadingPositions(updates);
  persistedNoteSaveBaseline.acknowledgeFields(notes, ['textbookReadingState']);
  return true;
}
