import type { NoteItem } from '../../types';
import type { TextbookReadingState } from './types';

export interface TextbookReadingPosition { blockAnchor?: string; scrollTop?: number }
export interface TextbookReadingUpdate { noteId: string; state: TextbookReadingState }
export type TextbookReadingGetter = (noteId: string, revisionId: string) => TextbookReadingState | undefined;

/** Reading is not a content publication. Older visible props cannot erase a
 * position accepted by the authoritative draft while the reader was scrolling. */
export function retainLatestTextbookReadingPosition(current: NoteItem | undefined, incoming: NoteItem): NoteItem {
  const state = current?.textbookReadingState;
  if (!state || current?.textbook?.revisionId !== incoming.textbook?.revisionId
    || state.revisionId !== incoming.textbook?.revisionId || state === incoming.textbookReadingState) return incoming;
  const next = incoming.textbookReadingState;
  return !next || next.revisionId !== state.revisionId || Date.parse(state.lastReadAt) > Date.parse(next.lastReadAt)
    ? { ...incoming, textbookReadingState: state } : incoming;
}
export function isValidTextbookReadingState(value: unknown): value is TextbookReadingState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as TextbookReadingState;
  return Object.keys(value).every(key => ['revisionId', 'lastReadAt', 'blockAnchor', 'scrollTop'].includes(key))
    && typeof state.revisionId === 'string' && state.revisionId.length > 0 && state.revisionId.length <= 300
    && typeof state.lastReadAt === 'string' && state.lastReadAt.length <= 64 && Number.isFinite(Date.parse(state.lastReadAt))
    && (state.blockAnchor === undefined || typeof state.blockAnchor === 'string' && state.blockAnchor.length <= 240)
    && (state.scrollTop === undefined || Number.isFinite(state.scrollTop) && state.scrollTop >= 0 && state.scrollTop <= 100_000_000);
}

/** Narrow personal-state patch. A retained Flow snapshot never replaces newer note content. */
export function patchTextbookReadingPosition(notes: NoteItem[], noteId: string, revisionId: string,
  position: TextbookReadingPosition, at = new Date().toISOString()): NoteItem[] {
  const target = notes.find((note) => note.id === noteId && note.noteType === 'project' && note.textbook?.revisionId === revisionId);
  if (!target || (position.blockAnchor !== undefined && (typeof position.blockAnchor !== 'string' || position.blockAnchor.length > 240))
    || (position.scrollTop !== undefined && (!Number.isFinite(position.scrollTop) || position.scrollTop < 0 || position.scrollTop > 100_000_000))) return notes;
  const prior = target.textbookReadingState;
  if (prior?.revisionId === revisionId && prior.blockAnchor === position.blockAnchor && prior.scrollTop === position.scrollTop) return notes;
  return notes.map((note) => note === target ? { ...note, textbookReadingState: { revisionId, ...position, lastReadAt: at } } : note);
}
