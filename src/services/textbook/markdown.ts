import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { math } from 'micromark-extension-math';
import { mathFromMarkdown } from 'mdast-util-math';
import type { Root, RootContent, PhrasingContent } from 'mdast';
import type { TextbookManifest } from './types';

/** Same math/GFM grammar as the reader; fenced examples do not become chapters or citations. */
export function parseTextbookMarkdown(body: string): Root {
  return fromMarkdown(body, { extensions: [gfm(), math()], mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()] });
}
export interface TextbookSection { title: string; anchor: string; start: number; chapterId?: string }
function hash(text: string): string {
  let value = 2166136261;
  for (const char of text) { value ^= char.codePointAt(0)!; value = Math.imul(value, 16777619); }
  return (value >>> 0).toString(36);
}
function nodeText(node: { value?: string; children?: unknown[] }): string {
  return node.value || (node.children || []).map((child) => nodeText(child as typeof node)).join('');
}
function normalizedTitle(value: string): string { return value.replace(/^\s*\d+[.、．)]\s*/u, '').trim(); }
export function textbookSections(body: string, manifest?: Pick<TextbookManifest, 'chapters' | 'revisionId'>): TextbookSection[] {
  return textbookSectionsFromTree(parseTextbookMarkdown(body), manifest);
}
export function textbookSectionsFromTree(tree: Root, manifest?: Pick<TextbookManifest, 'chapters' | 'revisionId'>): TextbookSection[] {
  const occurrences = new Map<string, number>();
  const revision = hash(manifest?.revisionId || 'unpublished');
  const usedChapters = new Set<string>();
  return tree.children.filter((node) => node.type === 'heading' && node.depth === 2).map((node) => {
    const title = nodeText(node as never), normalized = normalizedTitle(title);
    const chapter = manifest?.chapters?.find((item) => !usedChapters.has(item.id) && normalizedTitle(item.title) === normalized);
    if (chapter) usedChapters.add(chapter.id);
    const occurrence = (occurrences.get(title) || 0) + 1; occurrences.set(title, occurrence);
    const identity = chapter ? `chapter-${hash(chapter.id)}` : `section-${hash(title)}-${occurrence}`;
    return { title, start: node.position?.start.offset || 0, anchor: `textbook-${revision}-${identity}`, chapterId: chapter?.id };
  });
}
/** Only renderer-created source: links are active; authored URLs remain inert. */
export function textbookUrlTransform(url: string): string {
  return /^(?:source:[a-zA-Z0-9_-]{1,80}|#[a-zA-Z0-9_.:-]{1,160})$/u.test(url) ? url : '';
}
export function remarkTextbookReferences(options: { manifest?: { sources?: Array<{ sourceId: string }> }; sections?: TextbookSection[] } = {}) {
  const allowed = new Set((options.manifest?.sources || []).map((item) => item.sourceId));
  const byStart = new Map((options.sections || []).map((section) => [section.start, section.anchor]));
  return (tree: Root) => {
    // Legacy books keep their exact stored Markdown/checkpoint identity. Only
    // fold a final, authorized bibliography during reading, never arbitrary
    // prose, code, nested lists or a same-named section in the middle of a lesson.
    let index = -1;
    for (let position = tree.children.length - 1; position >= 0; position--) {
      const node = tree.children[position];
      if (node.type === 'heading' && node.depth === 2 && /^(?:资料来源|参考资料)$/u.test(nodeText(node).trim())) { index = position; break; }
    }
    if (index >= 0) {
      const tail = tree.children.slice(index + 1);
      const lists = tail.filter(node => node.type === 'list');
      const items = lists.flatMap(node => node.children);
      if (items.length && tail.every(node => node.type === 'list' || node.type === 'footnoteDefinition')
        && items.every(item => item.children.length === 1 && item.children[0].type === 'paragraph'
          && allowed.has(/^\[([LN]\d+)\]\s/u.exec(nodeText(item))?.[1] || ''))) {
        const heading = tree.children[index];
        const anchor = byStart.get(heading.position?.start.offset || 0);
        tree.children.splice(index, tail.length + 1, {
          type: 'blockquote', data: { hName: 'details', hProperties: { className: ['textbook-references', 'textbook-references-legacy'] } },
          children: [{ type: 'paragraph', data: { hName: 'summary', hProperties: anchor ? { id: anchor, 'data-textbook-anchor': anchor } : {} },
            children: [{ type: 'text', value: `参考资料（共 ${items.length} 条）` }] }, ...lists],
        }, ...tail.filter(node => node.type === 'footnoteDefinition'));
      }
    }
    const walk = (parent: { type: string; children?: unknown[] }) => {
      if (!parent.children || ['code', 'inlineCode', 'math', 'inlineMath', 'link', 'linkReference', 'html'].includes(parent.type)) return;
      const next: unknown[] = [];
      for (const raw of parent.children) {
        const node = raw as RootContent;
        if (node.type === 'heading' && node.depth === 2) {
          const anchor = byStart.get(node.position?.start.offset || 0);
          if (anchor) node.data = { ...node.data, hProperties: { ...node.data?.hProperties, id: anchor, 'data-textbook-anchor': anchor } };
        }
        if (node.type === 'text') {
          let cursor = 0;
          for (const hit of node.value.matchAll(/\[([LN]\d+)\]/gu)) {
            if (!allowed.has(hit[1])) continue;
            const index = hit.index!;
            if (cursor < index) next.push({ type: 'text', value: node.value.slice(cursor, index) });
            next.push({ type: 'link', url: `source:${hit[1]}`, children: [{ type: 'text', value: hit[1] }] } satisfies PhrasingContent);
            cursor = index + hit[0].length;
          }
          if (cursor) { if (cursor < node.value.length) next.push({ type: 'text', value: node.value.slice(cursor) }); }
          else next.push(node);
        } else { walk(node as never); next.push(node); }
      }
      parent.children = next;
    };
    walk(tree);
  };
}
