/** CodeMirror uses LF document coordinates. Keep the author's untouched line
 * separators when applying its changes, instead of serializing the whole note
 * back with normalized line endings after the first keypress. */
export interface SourceChange { from: number; to: number; insert: string }

export function sourceCoordinateMap(source: string) {
  const extraAt: number[] = [];
  let removed = 0;
  for (const match of source.matchAll(/\r\n/gu)) {
    extraAt.push(match.index! - removed);
    removed++;
  }
  return (position: number) => {
    let low = 0, high = extraAt.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (extraAt[middle] < position) low = middle + 1;
      else high = middle;
    }
    return position + low;
  };
}

export function applyLongNoteSourceChanges(source: string, changes: readonly SourceChange[], preferredSeparator?: string): string {
  if (!changes.length) return source;
  const rawPosition = sourceCoordinateMap(source);
  const separator = preferredSeparator || source.match(/\r\n|\r|\n/u)?.[0] || '\n';
  let cursor = 0, next = '';
  for (const change of changes) {
    const from = rawPosition(change.from), to = rawPosition(change.to);
    if (from < cursor || to < from || to > source.length) throw new Error('长文编辑坐标无效，原文已保留');
    next += source.slice(cursor, from) + change.insert.replace(/\r\n|\r|\n/gu, separator);
    cursor = to;
  }
  return next + source.slice(cursor);
}

interface SourcePatch { from: number; to: number; insert: string }
function changedRange(before: string, after: string): SourcePatch {
  let from = 0;
  while (from < before.length && from < after.length && before[from] === after[from]) from++;
  let beforeEnd = before.length, afterEnd = after.length;
  while (beforeEnd > from && afterEnd > from && before[beforeEnd - 1] === after[afterEnd - 1]) { beforeEnd--; afterEnd--; }
  return { from, to: beforeEnd, insert: after.slice(from, afterEnd) };
}

/** Rebase a queued external replacement after IME commits. Disjoint updates can
 * coexist; overlapping updates require an explicit local choice. */
export function rebaseLongNoteSource(base: string, current: string, incoming: string): string | null {
  if (current === base || current === incoming) return incoming;
  if (incoming === base) return current;
  const typed = changedRange(base, current), external = changedRange(base, incoming);
  if (typed.from === typed.to && external.from === external.to && typed.from === external.from) return null;
  if (external.to <= typed.from) return current.slice(0, external.from) + external.insert + current.slice(external.to);
  if (typed.to <= external.from) {
    const offset = typed.insert.length - (typed.to - typed.from);
    return current.slice(0, external.from + offset) + external.insert + current.slice(external.to + offset);
  }
  return null;
}
