import type { NoteItem } from '../../types';

interface RemovedNote { note: NoteItem; index: number }
export interface OptimisticNoteDeletionState {
  pending: Map<string, RemovedNote>;
  /** Keep acknowledged IDs too: a late editor callback must not recreate them. */
  hidden: Set<string>;
}
export const createOptimisticNoteDeletionState = (): OptimisticNoteDeletionState => ({ pending: new Map(), hidden: new Set() });

export function stageOptimisticNoteDeletion(state: OptimisticNoteDeletionState, notes: NoteItem[], ids: string[]): NoteItem[] {
  const removed = new Set(ids);
  const next: NoteItem[] = [];
  notes.forEach((note, index) => {
    if (!removed.has(note.id)) { next.push(note); return; }
    // Notes are immutable workspace values. Retain the value without copying
    // every textbook/body on the interactive deletion path.
    state.pending.set(note.id, { note, index }); state.hidden.add(note.id);
  });
  return next.length === notes.length ? notes : next;
}

export function acknowledgeOptimisticNoteDeletion(state: OptimisticNoteDeletionState,
  checkpoint: Map<string, RemovedNote>, saved: NoteItem[], current: NoteItem[]): string[] {
  const savedIds = new Set(saved.map(note => note.id)), live = new Set(current.map(note => note.id));
  const deleted: string[] = [];
  for (const [id, value] of checkpoint) if (state.pending.get(id) === value) {
    state.pending.delete(id);
    if (!savedIds.has(id)) deleted.push(id);
    if (savedIds.has(id) || live.has(id)) state.hidden.delete(id);
  }
  return deleted;
}

/** Restore pending removals ONLY, not an old whole-vault snapshot. New notes,
 * edits and explicitly restored/reused IDs always retain their latest values. */
export function rollbackOptimisticNoteDeletions(state: OptimisticNoteDeletionState, current: NoteItem[]) {
  const live = new Set(current.map(note => note.id));
  const missing = [...state.pending.values()].filter(value => !live.has(value.note.id)).sort((a, b) => a.index - b.index);
  const next: NoteItem[] = []; let cursor = 0;
  for (const value of missing) {
    while (cursor < current.length && next.length < value.index) next.push(current[cursor++]);
    next.push(value.note);
  }
  for (; cursor < current.length; cursor++) next.push(current[cursor]);
  for (const id of state.pending.keys()) state.hidden.delete(id);
  state.pending.clear();
  return { notes: missing.length ? next : current, restoredCount: missing.length };
}

export function rejectLateDeletedNoteUpdate(state: OptimisticNoteDeletionState, notes: NoteItem[], id: string): boolean {
  return state.hidden.has(id) && !notes.some(note => note.id === id);
}
