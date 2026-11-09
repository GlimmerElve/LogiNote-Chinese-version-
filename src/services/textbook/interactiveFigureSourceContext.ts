import { findInteractiveFigureEntries } from './interactiveFigureMarker';

export interface FigureSelectionContext { before: string; after: string; wholePage?: boolean }

function sourceWindow(body: string, start: number, end: number, subsection: boolean): string | undefined {
  // Preserve offsets while hiding example headings inside fenced code/comments.
  const blank = (value: string) => value.replace(/[^\r\n]/gu, ' ');
  const excluded: Array<{ start: number; end: number }> = [];
  const structural = body.replace(/<!--[\s\S]*?(?:-->|$)/gu, (value, offset: number) => {
    excluded.push({ start: offset, end: offset + value.length }); return blank(value);
  }).replace(/^ {0,3}(?:>\s*)?(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}(?:>\s*)?\1\s*$/gmu, (value, _fence, offset: number) => {
    excluded.push({ start: offset, end: offset + value.length }); return blank(value);
  }).replace(/^ {0,3}(?:>\s*)?(`{3,}|~{3,})[^\n]*(?:\n[\s\S]*)?$/gmu, (value, _fence, offset: number) => {
    excluded.push({ start: offset, end: offset + value.length }); return blank(value);
  });
  const headings = [...structural.matchAll(subsection ? /^ {0,3}#{1,3}\s+.+$/gmu : /^ {0,3}#\s+.+$/gmu)];
  const previous = headings.filter(heading => heading.index! < start).at(-1);
  const next = headings.find(heading => heading.index! >= end);
  let from = Math.max(previous?.index ?? 0, start - (subsection ? 2500 : 8000));
  let to = Math.min(next?.index ?? body.length, end + (subsection ? 2500 : 8000), from + 16000);
  for (const block of excluded) {
    if (from > block.start && from < block.end) from = block.end <= start ? block.end : block.start;
    if (to > block.start && to < block.end) to = block.start >= end ? block.start : block.end;
  }
  if (from > start || to < end || to - from > 16000) return;
  return body.slice(from, to);
}

/** Generation-only source lookup: never parse or scan on scroll/render.
 * Exact, unique passage matches can replace noisy rendered KaTeX context.
 * Ambiguous or markup-spanning selections keep their originally captured scope. */
export function entryFigureLesson(body: string, brief: string, fallback: string, selection?: FigureSelectionContext): string {
  if (selection?.wholePage) return body.slice(0, 16000);
  if (selection) {
    const index = body.indexOf(brief);
    if (brief.trim() && index >= 0 && body.indexOf(brief, index + 1) < 0) return sourceWindow(body, index, index + brief.length, true) || fallback;
    return fallback;
  }
  const entries = findInteractiveFigureEntries(body).filter(entry => entry.brief === brief);
  if (entries.length === 1) return sourceWindow(body, entries[0].start, entries[0].end, false) || fallback;
  return fallback;
}
