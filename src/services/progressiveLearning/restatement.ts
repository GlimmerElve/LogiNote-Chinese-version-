import type { ProgressiveRestatementSpan } from './types';

/** Rebase only the edited range. Historical text retains its original page, including delayed speech. */
export function editRestatementSpans(before: string, after: string, spans: readonly ProgressiveRestatementSpan[], pageId: string): ProgressiveRestatementSpan[] {
  if (before === after) return [...spans];
  let start = 0, suffix = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  while (suffix < before.length - start && suffix < after.length - start
    && before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix++;
  const end = before.length - suffix, insertedEnd = after.length - suffix, shift = after.length - before.length;
  const next: ProgressiveRestatementSpan[] = [];
  for (const span of spans) {
    if (span.start < start) next.push({ ...span, end: Math.min(span.end, start) });
    if (span.end > end) next.push({ ...span, start: Math.max(span.start, end) + shift, end: span.end + shift });
  }
  if (insertedEnd > start) next.push({ pageId, start, end: insertedEnd });
  next.sort((a, b) => a.start - b.start);
  const merged: ProgressiveRestatementSpan[] = [];
  for (const span of next) {
    if (span.end <= span.start) continue;
    const last = merged.at(-1);
    if (last?.pageId === span.pageId && last.end === span.start) last.end = span.end;
    else merged.push({ ...span });
  }
  return merged;
}
export function pageRestatement(text: string, spans: readonly ProgressiveRestatementSpan[], pageId: string): string {
  return spans.filter(span => span.pageId === pageId).map(span => text.slice(span.start, span.end)).join('\n')
    .replace(/^\s*##\s*复盘\s*[·•].*$/gmu, '').trim();
}
