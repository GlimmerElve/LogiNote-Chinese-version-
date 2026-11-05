import type { Root, PhrasingContent } from 'mdast';
import { layoutProjectKnowledgeSection } from './knowledgeSectionLayout';

type Scope = 'all' | 'knowledge-section';
/** Older generated labels sometimes end with a space inside the closing **.
 * Recover only that bounded, plain-text case after normal Markdown parsing.
 * Original source, offsets, course hashes and quote validation stay unchanged. */
export function recoverGeneratedFormattingTree(tree: Root, source: string, scope: Scope = 'all') {
  layoutProjectKnowledgeSection(tree, source);
  const walk = (parent: any) => {
    if (!parent.children || ['code', 'inlineCode', 'math', 'inlineMath', 'html', 'link', 'linkReference', 'strong', 'emphasis'].includes(parent.type)) return;
    parent.children = parent.children.flatMap((child: any) => {
      if (child.type !== 'text') { walk(child); return [child]; }
      const start = child.position?.start.offset, end = child.position?.end.offset;
      // Escaped stars/entities are intentional literal text. Never promote them.
      if (start === undefined || end === undefined || source.slice(start, end) !== child.value) return [child];
      const pattern = /\*\*(\S[^*\r\n]{0,198}?)[ \t]+\*\*/gu;
      let cursor = 0; const rows: PhrasingContent[] = [];
      for (const match of child.value.matchAll(pattern)) {
        const index = match.index!, before = child.value[index - 1], after = child.value[index + match[0].length];
        if (before === '*' || after === '*' || !match[1].trim()) continue;
        if (index > cursor) rows.push({ type: 'text', value: child.value.slice(cursor, index) });
        rows.push({ type: 'strong', children: [{ type: 'text', value: match[1].trimEnd() }] });
        // Move the trailing whitespace outside the emphasis, preserving spacing.
        rows.push({ type: 'text', value: /[ \t]+(?=\*\*$)/u.exec(match[0])![0] });
        cursor = index + match[0].length;
      }
      if (!cursor) return [child];
      if (cursor < child.value.length) rows.push({ type: 'text', value: child.value.slice(cursor) });
      return rows;
    });
  };
  let active = scope === 'all';
  for (const node of tree.children) {
    if (scope !== 'all' && node.type === 'heading' && node.depth <= 3) {
      active = node.depth === 3 && node.children.map(n => 'value' in n ? n.value : '').join('').trim() === '本项目需要掌握的知识点';
      continue;
    }
    if (active) walk(node);
  }
}
export function remarkGeneratedFormatting(options: { scope?: Scope } = {}) {
  return (tree: Root, file: { value?: unknown }) => recoverGeneratedFormattingTree(tree, String(file.value || ''), options.scope);
}
