import { parseTextbookMarkdown } from '../textbook/markdown';
import { toHast } from 'mdast-util-to-hast';
import type { Nodes } from 'hast';
import { transformMarkdownWikiLinks } from '../markdownWikiLinks';

export interface NoteHeadingRequest { heading: string; key: string }

const decoded = (text: string) => { try { return decodeURIComponent(text); } catch { return text; } };
export const normalizeNoteHeading = (text: string): string => decoded(text).normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
const slug = (text: string) => normalizeNoteHeading(text).replace(/[\p{P}\p{S}]/gu, '').replace(/\s+/gu, '-');
export function noteHeadingMatches(title: string, heading: string): boolean {
  return normalizeNoteHeading(title) === normalizeNoteHeading(heading) || slug(title) === normalizeNoteHeading(heading);
}

/** Only rendered headings are considered; a missing heading must not match arbitrary body text. */
export function scrollToNoteHeading(root: HTMLElement, heading: string): boolean {
  const target = [...root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')]
    .find(element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden'
      && noteHeadingMatches(element.textContent || '', heading));
  if (!target) return false;
  target.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'auto' });
  return true;
}

/** Use the reader's Markdown grammar; comments/math/code and unused footnotes
 * cannot masquerade as visible sections. Called only for explicit source jumps. */
export function noteHeadingSourceOffset(content: string, heading: string): number | undefined {
  const markdown = parseTextbookMarkdown(content);
  transformMarkdownWikiLinks(markdown, content);
  const tree = toHast(markdown, { allowDangerousHtml: false });
  const text = (node: Nodes): string => node.type === 'text' ? node.value : 'children' in node ? node.children.map(text).join('') : '';
  let offset: number | undefined;
  const visit = (node: Nodes) => {
    if (offset !== undefined) return;
    if (node.type === 'element' && /^h[1-6]$/u.test(node.tagName) && node.position?.start.offset !== undefined
      && noteHeadingMatches(text(node), heading)) { offset = node.position.start.offset; return; }
    if ('children' in node) node.children.forEach(visit);
  };
  if (tree) visit(tree);
  return offset;
}
