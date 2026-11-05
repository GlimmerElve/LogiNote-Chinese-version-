import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { math } from 'micromark-extension-math';
import { mathFromMarkdown } from 'mdast-util-math';
import type { Nodes } from 'mdast';

export interface MarkdownAutoLinkEntry { token: string; target: string }
export interface MarkdownAutoLinkResult {
  updatedContent: string;
  addedLinks: string[];
  generatedContentBlocks?: string[];
}
interface Range { start: number; end: number }
interface Patch extends Range { replacement: string }
interface GeneratedRange extends Range { block: string }

// Only descend through readable Markdown containers. Links, images, definitions,
// HTML, code, math and unknown extension nodes are deliberately not traversed.
const readableContainers = new Set(['root', 'paragraph', 'heading', 'blockquote', 'list', 'listItem',
  'table', 'tableRow', 'tableCell', 'emphasis', 'strong', 'delete', 'footnoteDefinition']);

function overlap(a: Range, b: Range): boolean { return a.start < b.end && b.start < a.end; }
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function applyPatches(content: string, patches: readonly Patch[]): string {
  let result = content;
  for (const patch of [...patches].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, patch.start) + patch.replacement + result.slice(patch.end);
  }
  return result;
}

function generatedRanges(content: string, blocks: readonly string[]): GeneratedRange[] {
  const result: GeneratedRange[] = [];
  for (const block of new Set(blocks)) {
    if (!block.trim()) continue;
    let start = content.indexOf(block);
    while (start >= 0) {
      result.push({ start, end: start + block.length, block });
      start = content.indexOf(block, start + block.length);
    }
  }
  return result;
}

function readableRanges(content: string, protectedRanges: Range[]): Range[] {
  // MDX control markers are standalone blocks in our editor, but CommonMark HTML
  // can swallow a following paragraph without a blank line. Mask just the markers
  // for parsing, preserving newlines AND UTF-16 offsets; never serialize this AST.
  for (const hit of content.matchAll(/<\/?(?:TextbookBoundary|LearningReviewBlock|ArgumentBlock)\b(?:[^"'<>]|"[^"]*"|'[^']*')*(?:>|$)/gu)) {
    protectedRanges.push({ start: hit.index!, end: hit.index! + hit[0].length });
  }
  const frontmatter = content.match(/^\uFEFF?---[ \t]*\r?\n/u);
  if (frontmatter) {
    const close = /^(?:---|\.\.\.)[ \t]*(?:\r?$)/gmu;
    close.lastIndex = frontmatter[0].length;
    const hit = close.exec(content);
    protectedRanges.push({ start: 0, end: hit ? hit.index + hit[0].length : content.length });
  }
  let parsingContent = content;
  for (const range of [...protectedRanges].sort((a, b) => b.start - a.start)) {
    parsingContent = parsingContent.slice(0, range.start) + parsingContent.slice(range.start, range.end)
      .replace(/[^\r\n]/g, ' ') + parsingContent.slice(range.end);
  }
  const tree = fromMarkdown(parsingContent, {
    extensions: [gfm(), math()], mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
  });
  const ranges: Range[] = [];
  const visit = (node: Nodes): void => {
    if (node.type === 'text') {
      const start = node.position?.start.offset, end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) ranges.push({ start, end });
    } else if (readableContainers.has(node.type) && 'children' in node) {
      for (const child of node.children) visit(child);
    }
  };
  visit(tree);
  return ranges;
}

/**
 * Insert wiki links only in readable text, using original source offsets rather
 * than a Markdown round trip. Untouched bytes (including fence/LaTeX payloads)
 * stay exact. Longest alternatives match once against the ORIGINAL source, so
 * shorter aliases cannot relink newly inserted links or nest inside longer ones.
 */
export function autoLinkMarkdown(content: string, entries: readonly MarkdownAutoLinkEntry[],
  generatedContentBlocks?: readonly string[]): MarkdownAutoLinkResult {
  // Provenance must follow the SAME source patches, not a separate scan of a
  // fragment: a fragment can be prose here but code/HTML in the full document.
  const generated = generatedRanges(content, generatedContentBlocks || []);
  const finish = (patches: readonly Patch[], addedLinks: string[]): MarkdownAutoLinkResult => {
    const result: MarkdownAutoLinkResult = { updatedContent: applyPatches(content, patches), addedLinks };
    if (generatedContentBlocks !== undefined) {
      // Keep original markers for protected occurrences and undo. Only add
      // variants from exact original spans; never guess ownership of old edits.
      const blocks = new Set(generatedContentBlocks);
      for (const range of generated) {
        const ownedPatches = patches.filter((patch) => patch.start >= range.start && patch.end <= range.end)
          .map((patch) => ({ ...patch, start: patch.start - range.start, end: patch.end - range.start }));
        if (ownedPatches.length) blocks.add(applyPatches(range.block, ownedPatches));
      }
      result.generatedContentBlocks = [...blocks];
    }
    return result;
  };
  const byToken = new Map<string, MarkdownAutoLinkEntry>();
  for (const entry of entries) {
    const token = entry.token.trim(), target = entry.target.trim();
    if (!token || !target || /[\[\]|\r\n]/u.test(token + target) || byToken.has(token)) continue;
    byToken.set(token, { token, target });
  }
  if (!content || !byToken.size) return finish([], []);
  const protectedRanges: Range[] = [];
  const ranges = readableRanges(content, protectedRanges);
  const isReadable = (offset: number) => ranges.some((range) => offset >= range.start && offset < range.end)
    && !protectedRanges.some((range) => offset >= range.start && offset < range.end);

  // Wikilinks are not CommonMark nodes and may span emphasis/text nodes. Protect
  // the complete original link, including aliases/anchors. An unfinished opener
  // is left alone through the end of its line, not "repaired" by this operation.
  const wikiOpeners = /\[\[/gu;
  let opener: RegExpExecArray | null;
  while ((opener = wikiOpeners.exec(content))) {
    if (!isReadable(opener.index)) continue;
    const closing = content.indexOf(']]', opener.index + 2);
    const lineEnd = content.indexOf('\n', opener.index + 2);
    const end = closing >= 0 ? closing + 2 : lineEnd >= 0 ? lineEnd : content.length;
    protectedRanges.push({ start: opener.index, end });
    wikiOpeners.lastIndex = end;
  }
  for (const pattern of [
    // Textbook source IDs, numeric citations, entity encodings and literal URLs
    // must not become links even when a knowledge title equals a label/ID.
    /\[[LN]?\d+(?:\s*[-,，、–;；]\s*[LN]?\d+)*\]/gu,
    /&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);/giu,
    /\b(?:[a-z][a-z0-9+.-]*):[^\s<>"']+/giu,
    // Also preserve conventional LaTeX delimiters in imported notes.
    /\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]/gu,
  ]) {
    for (const hit of content.matchAll(pattern)) protectedRanges.push({ start: hit.index!, end: hit.index! + hit[0].length });
  }
  const pattern = new RegExp([...byToken.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|'), 'gu');
  const patches: Patch[] = [], added = new Set<string>();
  for (const range of ranges) {
    const text = content.slice(range.start, range.end);
    for (const hit of text.matchAll(pattern)) {
      const patch = { start: range.start + hit.index!, end: range.start + hit.index! + hit[0].length,
        replacement: `[[${hit[0]}]]` };
      if (protectedRanges.some((protectedRange) => overlap(patch, protectedRange))) continue;
      // A partial marker must not expand across its boundary into user text.
      if (generated.some((block) => overlap(patch, block)
        && (patch.start < block.start || patch.end > block.end))) continue;
      // In a literal [term], adding [[term]] would produce [[[term]]] and make
      // the wiki parser treat the surrounding bracket as part of the target.
      if (content[patch.start - 1] === '[') continue;
      // An odd preceding backslash would escape the inserted opening bracket.
      // Leave such text alone instead of changing its Markdown meaning.
      let slashes = 0;
      for (let index = patch.start - 1; index >= 0 && content[index] === '\\'; index--) slashes++;
      if (slashes % 2) continue;
      patches.push(patch);
      added.add(byToken.get(hit[0])!.target);
    }
  }
  return finish(patches, [...added]);
}
