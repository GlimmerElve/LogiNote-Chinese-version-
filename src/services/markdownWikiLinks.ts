import { decodeString } from 'micromark-util-decode-string';
import { parseWikiLink } from './noteResolver';
import { parseTextbookMarkdown } from './textbook/markdown';

export const WIKI_LINK_PREFIX = '#loginote-wiki=';
type MarkdownNode = { type: string; value?: string; url?: string; children?: MarkdownNode[];
  position?: { start: { offset?: number }; end: { offset?: number } } };
const protectedNodes = new Set(['code', 'inlineCode', 'math', 'inlineMath', 'link', 'linkReference', 'html']);
const wikiMatches = () => /\[\[([^\]\r\n]+)\]\]/gu;

/** CommonMark already unescapes text nodes. Keep a small origin map so escaped
 * brackets and entity-produced brackets cannot accidentally become navigation. */
function originalCandidates(raw: string): { value: string; literal: boolean }[] {
  const encoded = /\\([!-/:-@[-`{-~])|&(#(?:\d{1,7}|x[\da-f]{1,6})|[\da-z]{1,31});/giu;
  const origins: number[] = [];
  let decoded = '', cursor = 0;
  const literal = (end: number) => {
    for (; cursor < end; cursor++) { decoded += raw[cursor]; origins.push(cursor); }
  };
  for (const token of raw.matchAll(encoded)) {
    literal(token.index!);
    const value = decodeString(token[0]);
    decoded += value;
    for (let index = 0; index < value.length; index++) origins.push(-1);
    cursor = token.index! + token[0].length;
  }
  literal(raw.length);
  const pair = (offset: number, character: string) => origins[offset] >= 0 && origins[offset + 1] === origins[offset] + 1
    && raw.slice(origins[offset], origins[offset] + 2) === character;
  return [...decoded.matchAll(wikiMatches())].map(match => ({ value: match[0],
    literal: pair(match.index!, '[[') && pair(match.index! + match[0].length - 2, ']]') }));
}

/** Only real Markdown text destinations become inert, renderer-owned fragments. */
export function transformMarkdownWikiLinks(tree: unknown, source: string): void {
  const visit = (parent: MarkdownNode) => {
    if (!parent.children || protectedNodes.has(parent.type)) return;
    parent.children = parent.children.flatMap(child => {
      if (child.type !== 'text' || !child.value?.includes('[[')) { visit(child); return [child]; }
      const start = child.position?.start.offset, end = child.position?.end.offset;
      // Without source provenance, retaining literal text is safer than inventing links.
      if (start === undefined || end === undefined) return [child];
      const candidates = originalCandidates(source.slice(start, end));
      const result: MarkdownNode[] = [];
      let cursor = 0, candidate = 0;
      for (const match of child.value.matchAll(wikiMatches())) {
        while (candidate < candidates.length && candidates[candidate].value !== match[0]) candidate++;
        const permitted = candidates[candidate++];
        if (!permitted?.literal) continue;
        const raw = match[1].trim(), parsed = parseWikiLink(raw);
        if (!parsed.noteTitle && !parsed.heading) continue;
        if (match.index! > cursor) result.push({ type: 'text', value: child.value.slice(cursor, match.index!) });
        result.push({ type: 'link', url: `${WIKI_LINK_PREFIX}${encodeURIComponent(raw)}`,
          children: [{ type: 'text', value: parsed.label || raw }] });
        cursor = match.index! + match[0].length;
      }
      if (!result.length) return [child];
      if (cursor < child.value.length) result.push({ type: 'text', value: child.value.slice(cursor) });
      return result;
    });
  };
  visit(tree as MarkdownNode);
}

export function remarkMarkdownWikiLinks() {
  return (tree: unknown, file: { value?: unknown }) => transformMarkdownWikiLinks(tree, String(file?.value || ''));
}

/** Derive associations from exactly the destinations the reader makes active,
 * including source provenance for escapes/entities and Markdown code contexts. */
export function extractMarkdownWikiLinks(source: string): string[] {
  if (!source.includes('[[')) return [];
  const tree = parseTextbookMarkdown(source);
  transformMarkdownWikiLinks(tree, source);
  const links: string[] = [];
  const visit = (node: MarkdownNode) => {
    if (node.type === 'link' && node.url?.startsWith(WIKI_LINK_PREFIX)) links.push(decodeURIComponent(node.url.slice(WIKI_LINK_PREFIX.length)));
    else for (const child of node.children || []) visit(child);
  };
  visit(tree as MarkdownNode);
  return links;
}
