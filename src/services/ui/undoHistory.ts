export interface UndoHistory<T> { past: T[]; present: T; future: T[] }
export const createUndoHistory = <T>(value: T): UndoHistory<T> => ({ past: [], present: structuredClone(value), future: [] });
export function recordUndoHistory<T>(history: UndoHistory<T>, value: T, coalesce = false): UndoHistory<T> {
  if (JSON.stringify(history.present) === JSON.stringify(value)) return history;
  return { past: coalesce && history.past.length ? history.past : [...history.past, history.present].slice(-100),
    present: structuredClone(value), future: [] };
}
export function moveUndoHistory<T>(history: UndoHistory<T>, direction: 'undo' | 'redo'): UndoHistory<T> {
  if (direction === 'undo') {
    if (!history.past.length) return history;
    return { past: history.past.slice(0, -1), present: history.past.at(-1)!, future: [history.present, ...history.future] };
  }
  if (!history.future.length) return history;
  return { past: [...history.past, history.present], present: history.future[0], future: history.future.slice(1) };
}
