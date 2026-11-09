import { toHast } from 'mdast-util-to-hast';
import type { Root, RootContent, Element } from 'hast';
import type { Heading, Nodes as MarkdownNode } from 'mdast';
import { defaultUrlTransform } from 'react-markdown';
import { parseTextbookMarkdown, remarkTextbookReferences, textbookSectionsFromTree, textbookUrlTransform } from './markdown';
import { readTextbookBody } from './noteContent';
import type { TextbookManifest } from './types';
import { transformMarkdownWikiLinks } from '../markdownWikiLinks';
import { recoverGeneratedMathTree } from './generatedMath';
import { recoverGeneratedFormattingTree } from './generatedFormatting';
import { createReadingFragments, READING_PAGE_CHARACTERS, READING_PAGE_ELEMENTS } from './readingFragments';

export const LONG_READING_THRESHOLD = 24_000;
export interface ReadingInput {
  content: string; manifest?: TextbookManifest;
  citationIds?: readonly string[];
  /** Raw Markdown inside a reader (not a second managed textbook region). */
  contextManifest?: TextbookManifest; fragmentKind?: 'textbook' | 'note'; anchorPrefix?: string;
}
export interface ReadingPage { key: string; title: string; anchors: string[]; characters: number; estimatedHeight: number }
export interface ReadingIndex { pages: ReadingPage[]; sections: Array<{ title: string; anchor: string; page: number }>;
  headings?: Array<{ title: string; anchor: string; page: number }> }
export interface ReadingDocument { index: ReadingIndex; pages: Root[] }

function text(node: RootContent): string {
  return 'value' in node ? node.value : 'children' in node ? node.children.map(child => text(child as RootContent)).join('') : '';
}
/** Runs in a disposable local worker. Parse globally ONCE so reference-style
 * links, footnotes, fenced examples and source IDs keep their original meaning. */
export function prepareReadingDocument(input: ReadingInput): ReadingDocument {
  const body = input.manifest ? readTextbookBody(input.content, input.manifest) : input.content;
  if (body === null) throw new Error('教材边界损坏，请回到笔记编辑器恢复边界');
  const manifest = input.manifest || input.contextManifest;
  const textbook = Boolean(manifest || input.fragmentKind === 'textbook');
  const mdast = parseTextbookMarkdown(body);
  recoverGeneratedFormattingTree(mdast, body, textbook ? 'all' : 'knowledge-section');
  if (!textbook) transformMarkdownWikiLinks(mdast, body);
  const sections = textbookSectionsFromTree(mdast, manifest);
  const chapterAnchors = new Map(sections.map(section => [section.start, section.anchor]));
  const headingNodes: Heading[] = [];
  const collectHeadings = (node: MarkdownNode) => {
    if (node.type === 'heading') headingNodes.push(node);
    if ('children' in node) node.children.forEach(collectHeadings);
  };
  const headingText = (node: MarkdownNode): string => 'value' in node && typeof node.value === 'string' ? node.value
    : 'children' in node ? node.children.map(headingText).join('') : '';
  collectHeadings(mdast);
  const headings = headingNodes.map((node, index) => {
    const anchor = chapterAnchors.get(node.position?.start.offset || 0) || `note-heading-${node.position?.start.offset ?? index}`;
    node.data = { ...node.data, hProperties: { ...node.data?.hProperties, id: anchor, 'data-textbook-anchor': anchor } };
    return { title: headingText(node), anchor };
  });
  if (textbook) remarkTextbookReferences({ manifest, sections })(mdast);
  recoverGeneratedMathTree(mdast, textbook ? 'all' : 'knowledge-section', { source: body, citationIds: input.citationIds || manifest?.sources?.map(source => source.sourceId) });
  const tree = toHast(mdast, { allowDangerousHtml: false, footnoteLabel: '注释', footnoteBackLabel: '返回正文引用' }) as Root;
  const ids = new Set<string>();
  const collectIds = (node: RootContent) => {
    if (node.type !== 'element') return;
    if (typeof node.properties.id === 'string') ids.add(node.properties.id);
    node.children.forEach(child => collectIds(child as RootContent));
  };
  tree.children.forEach(collectIds);
  const ownedAnchor = (url: string): string | undefined => {
    if (!url.startsWith('#')) return;
    const target = url.slice(1);
    if (ids.has(target)) return target;
    try { const decoded = decodeURIComponent(target); if (ids.has(decoded)) return decoded; } catch { /* Not an owned anchor. */ }
  };
  const clean = (node: RootContent): void => {
    if (node.type !== 'element') return;
    for (const key of ['href', 'src']) if (node.properties[key] !== undefined) {
      const url = String(node.properties[key]), anchor = key === 'href' ? ownedAnchor(url) : undefined;
      // Only IDs emitted by this parsed document gain local navigation. This
      // admits Unicode footnotes without relaxing source/external/image rules.
      node.properties[key] = anchor ? '#' + encodeURIComponent(anchor)
        : textbook ? textbookUrlTransform(url) : defaultUrlTransform(url);
    }
    node.children.forEach(child => clean(child as RootContent));
  };
  tree.children.forEach(clean);
  // Fragment-local anchors/footnotes must never collide with their parent book.
  // Rewrite only links that target IDs actually owned by this fragment.
  const prefix = input.anchorPrefix?.replace(/[^a-zA-Z0-9_.:-]/gu, '').slice(0, 60);
  if (prefix) {
    const rewrite = (node: RootContent) => {
      if (node.type !== 'element') return;
      if (typeof node.properties.id === 'string') node.properties.id = prefix + node.properties.id;
      if (typeof node.properties.href === 'string' && node.properties.href.startsWith('#')) {
        const anchor = ownedAnchor(node.properties.href);
        if (anchor) node.properties.href = '#' + encodeURIComponent(prefix + anchor);
      }
      if (typeof node.properties['data-textbook-anchor'] === 'string' && ids.has(node.properties['data-textbook-anchor']))
        node.properties['data-textbook-anchor'] = prefix + node.properties['data-textbook-anchor'];
      for (const key of ['ariaDescribedBy', 'ariaLabelledBy', 'headers']) {
        const value = node.properties[key];
        if (Array.isArray(value)) node.properties[key] = value.map(id => typeof id === 'string' && ids.has(id) ? prefix + id : id);
        else if (typeof value === 'string') node.properties[key] = value.split(' ').map(id => ids.has(id) ? prefix + id : id).join(' ');
      }
      node.children.forEach(child => rewrite(child as RootContent));
    };
    tree.children.forEach(rewrite);
    for (const section of sections) section.anchor = prefix + section.anchor;
    for (const heading of headings) heading.anchor = prefix + heading.anchor;
  }
  const fragments = createReadingFragments();
  const pages: Root[] = [], metadata: ReadingPage[] = [];
  let nodes: RootContent[] = [], characters = 0, elements = 0, title = '正文', anchors: string[] = [], sequence = 0;
  const flush = () => {
    if (!nodes.some(node => node.type !== 'text' || node.value.trim())) return;
    pages.push({ type: 'root', children: nodes });
    metadata.push({ key: `reading-block-${sequence++}`, title, anchors, characters,
      estimatedHeight: Math.max(160, Math.ceil(characters / 36) * 30 + elements * 3) });
    nodes = []; characters = 0; elements = 0; anchors = [];
  };
  const anchorIds = (node: RootContent): string[] => node.type === 'element'
    ? [...(typeof node.properties.id === 'string' ? [node.properties.id] : []), ...node.children.flatMap(child => anchorIds(child as RootContent))] : [];
  const append = (node: RootContent) => {
    const { characters: size, elements: count } = fragments.cost(node);
    const heading = node.type === 'element' && ['h1', 'h2'].includes(node.tagName);
    if (nodes.length && (characters + size > READING_PAGE_CHARACTERS || elements + count > READING_PAGE_ELEMENTS || heading && characters > 1_500)) flush();
    if (heading) title = text(node).slice(0, 120);
    nodes.push(node); characters += size; elements += count; anchors.push(...anchorIds(node));
  };
  for (const node of tree.children) for (const part of fragments.split(node)) append(part);
  flush();
  if (!pages.length) { pages.push({ type: 'root', children: [] }); metadata.push({ key: 'reading-block-0', title: '正文', anchors: [], characters: 0, estimatedHeight: 160 }); }
  const headingPage = (heading: { title: string; anchor: string }) => ({ ...heading,
    page: metadata.findIndex(page => page.anchors.includes(heading.anchor)) });
  return { pages, index: { pages: metadata, sections: sections.map(({ title, anchor }) => headingPage({ title, anchor })).filter(section => section.page >= 0),
    headings: headings.map(headingPage).filter(heading => heading.page >= 0).sort((left, right) => left.page - right.page
      || metadata[left.page].anchors.indexOf(left.anchor) - metadata[right.page].anchors.indexOf(right.anchor)) } };
}
