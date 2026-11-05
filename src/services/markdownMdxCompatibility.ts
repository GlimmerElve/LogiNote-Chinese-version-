import { fromMarkdown } from 'mdast-util-from-markdown';
import { toMarkdown } from 'mdast-util-to-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { math } from 'micromark-extension-math';
import { mathFromMarkdown } from 'mdast-util-math';
import type { Nodes } from 'mdast';

interface Range { start: number; end: number }
export interface MarkdownCompatibilityPatch extends Range {
  replacement: string;
  kind: 'literal_less_than' | 'autolink' | 'generic_type';
}
export interface MarkdownCompatibilityResult {
  markdown: string;
  patches: MarkdownCompatibilityPatch[];
}
const readable = new Set(['root', 'paragraph', 'heading', 'blockquote', 'list', 'listItem',
  'table', 'tableRow', 'tableCell', 'emphasis', 'strong', 'delete', 'footnoteDefinition']);
const controls = new Set(['TextbookBoundary', 'LearningReviewBlock', 'ArgumentBlock']);

/** Bridge ordinary Markdown to MDX without serializing the document or guessing
 * mathematical meaning. Unknown HTML/JSX is NOT sanitized into publishable text.
 * The editor's real importer is the second, independent compatibility gate. */
export function prepareMarkdownForMdx(source: string): MarkdownCompatibilityResult {
  if (!source.includes('<')) return { markdown: source, patches: [] };
  const parse = (value: string) => fromMarkdown(value, { extensions: [gfm(), math()], mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()] });
  // CommonMark HTML can swallow prose immediately following an application
  // marker. Mask only live marker spans (never code/math examples), keeping all
  // UTF-16 offsets and line endings for the later source patches.
  const markers: Range[] = [];
  const collectMarkers = (node: Nodes) => {
    if (node.type === 'html' && node.position?.start.offset !== undefined) {
      for (const hit of source.slice(node.position.start.offset, node.position.end.offset).matchAll(/<(?:TextbookBoundary|LearningReviewBlock|ArgumentBlock)\b(?:[^"'<>]|"[^"\r\n]*"|'[^'\r\n]*')*\/>/gu)) {
        const start = node.position.start.offset + hit.index!;
        markers.push({ start, end: start + hit[0].length });
      }
    } else if (readable.has(node.type) && 'children' in node) node.children.forEach(child => collectMarkers(child as Nodes));
  };
  const initialTree = parse(source);
  collectMarkers(initialTree);
  let parsingSource = source;
  for (const range of [...markers].sort((a, b) => b.start - a.start)) parsingSource = parsingSource.slice(0, range.start)
    + parsingSource.slice(range.start, range.end).replace(/[^\r\n]/gu, ' ') + parsingSource.slice(range.end);
  const tree = markers.length ? parse(parsingSource) : initialTree;
  const patches: MarkdownCompatibilityPatch[] = [];
  const protectedRanges: Range[] = [...markers];
  if (/^\uFEFF?---[ \t]*\r?\n/u.test(source)) {
    const close = /^(?:---|\.\.\.)[ \t]*\r?$/gmu;
    close.lastIndex = source.indexOf('\n') + 1;
    const ending = close.exec(source);
    protectedRanges.push({ start: 0, end: ending ? ending.index + ending[0].length : source.length });
  }
  const readableRanges: Range[] = [];
  const collectText = (node: Nodes) => {
    if (node.type === 'text' && node.position?.start.offset !== undefined && node.position.end.offset !== undefined)
      readableRanges.push({ start: node.position.start.offset, end: node.position.end.offset });
    else if (readable.has(node.type) && 'children' in node) node.children.forEach(child => collectText(child as Nodes));
  };
  collectText(tree);
  // Wiki links and conventional imported LaTeX delimiters are opaque. Do not
  // "fix" their payloads, even if the real editor later needs source fallback.
  for (const pattern of [/\[\[[^\n]*?(?:\]\]|$)/gmu, /\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]/gu]) {
    for (const hit of source.matchAll(pattern)) if (readableRanges.some(range => hit.index! >= range.start && hit.index! < range.end))
      protectedRanges.push({ start: hit.index!, end: hit.index! + hit[0].length });
  }
  const isProtected = (offset: number) => protectedRanges.some(range => offset >= range.start && offset < range.end);
  const visit = (node: Nodes) => {
    const start = node.position?.start.offset, end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;
    const raw = source.slice(start, end);
    if (node.type === 'text') {
      for (const hit of raw.matchAll(/</gu)) {
        const offset = start + hit.index!;
        if (isProtected(offset) || parsingSource[offset] !== '<') continue;
        // An incomplete authored tag is ambiguous. Keep it for source recovery,
        // rather than disguising broken HTML/JSX as an automatic prose repair.
        if (/^<\s*\/?[A-Za-z_$!?]/u.test(source.slice(offset))) continue;
        let slashes = 0;
        for (let cursor = offset - 1; cursor >= 0 && source[cursor] === '\\'; cursor--) slashes++;
        if (slashes % 2 === 0) patches.push({ start: offset, end: offset + 1, replacement: '\\<', kind: 'literal_less_than' });
      }
    } else if (node.type === 'link' && /^<[^<>\r\n]+>$/u.test(raw) && !isProtected(start)) {
      // A real CommonMark autolink, not an authored link destination. MDAST's
      // serializer handles label escaping and keeps the decoded URL identical.
      patches.push({ start, end, replacement: toMarkdown(node, { resourceLink: true }).trimEnd(), kind: 'autolink' });
    } else if (node.type === 'html' && !isProtected(start)) {
      const generic = /^<([A-Z][A-Za-z0-9_]*)>$/u.exec(raw);
      // Only unambiguous programming notation immediately after an identifier.
      // Standalone/attributed/unknown JSX and all application controls stay exact.
      if (generic && !controls.has(generic[1]) && /\b(?:Array|List|Set|Map|Promise|Record|ReadonlyArray|Optional|Iterable|Iterator|Collection|Vector|Queue|Stack|Dictionary)$/u.test(source.slice(0, start))) {
        patches.push({ start, end: start + 1, replacement: '\\<', kind: 'generic_type' });
      }
    } else if (readable.has(node.type) && 'children' in node) node.children.forEach(child => visit(child as Nodes));
  };
  visit(tree);
  let markdown = source;
  for (const patch of [...patches].sort((a, b) => b.start - a.start)) {
    markdown = markdown.slice(0, patch.start) + patch.replacement + markdown.slice(patch.end);
  }
  return { markdown, patches };
}

/** No private source snippets in diagnostics. Keep the original importer cause's
 * coordinates; unsupported nodes report the position supplied by the adapter. */
export function mdxCompatibilityLocation(error: unknown): { line?: number; column?: number } {
  const item = error as { line?: number; column?: number; place?: { line?: number; column?: number; start?: { line?: number; column?: number } }; cause?: unknown; message?: string } | null;
  if (!item || typeof item !== 'object') return {};
  const place = item.place?.start || item.place || item;
  if (Number.isInteger(place.line) && place.line! > 0) return { line: place.line, column: place.column };
  if (item.cause) { const found = mdxCompatibilityLocation(item.cause); if (found.line) return found; }
  const match = /\((\d+):(\d+)(?:-|\))/u.exec(item.message || '');
  return match ? { line: Number(match[1]), column: Number(match[2]) } : {};
}
