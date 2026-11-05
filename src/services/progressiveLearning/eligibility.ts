import type { NoteItem } from '../../types';
import { readTextbookBody } from '../textbook/noteContent';

/** A stale/empty manifest is not a complete textbook; the original note stays untouched. */
export function hasCompleteLegacyTextbook(note: NoteItem): boolean {
  return Boolean(note.textbook && readTextbookBody(note.content, note.textbook)?.trim());
}
