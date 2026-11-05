import type { Root, Paragraph, Heading, Text } from 'mdast';

const text = (node: any): string => typeof node.value === 'string' ? node.value : (node.children || []).map(text).join('');
const mark = (node: Paragraph | Heading, className: string) => { node.data = { ...node.data, hProperties: { ...node.data?.hProperties, className: [className] } }; };
/** One import-time presentation pass for the generated project index. Native
 * Markdown headings keep editing, wiki targets and sharing interoperable. */
export function layoutProjectKnowledgeSection(tree: Root, source: string): void {
  let active = false, entry = false;
  tree.children = tree.children.flatMap(node => {
    if (node.type === 'heading' && node.depth <= 3) {
      active = node.depth === 3 && text(node).trim() === '本项目需要掌握的知识点'; entry = false;
      return [node];
    }
    if (!active) return [node];
    if (node.type === 'heading') {
      entry = node.depth === 4 && /^\[\[[^\]\r\n]+\]\]$/u.test(text(node).trim());
      if (entry) mark(node, 'project-knowledge-title');
      return [node];
    }
    if (node.type !== 'paragraph') return [node];
    const first = node.children[0];
    const match = first?.type === 'text' ? /^(\[\[[^\]\r\n]+\]\])[：:][ \t]*/u.exec(first.value) : null;
    const offset = first?.position?.start.offset;
    // Only literal generated entries qualify; escaped brackets and code are opaque.
    if (match && offset !== undefined && source.slice(offset, offset + match[0].length) === match[0]) {
      const original = first as Text;
      const after = (length: number) => ({ ...original.position!.start, offset: offset + length, column: original.position!.start.column + length });
      const titleNode: Text = { ...original, value: match[1], position: { start: original.position!.start, end: after(match[1].length) } };
      const heading: Heading = { type: 'heading', depth: 4, children: [titleNode], position: titleNode.position };
      const rest = (first as Text).value.slice(match[0].length);
      const paragraph: Paragraph = { ...node, children: [...(rest ? [{ ...original, value: rest, position: { start: after(match[0].length), end: original.position!.end } }] : []), ...node.children.slice(1)] };
      mark(heading, 'project-knowledge-title'); mark(paragraph, 'project-knowledge-description'); entry = true;
      return paragraph.children.length ? [heading, paragraph] : [heading];
    }
    if (entry) mark(node, 'project-knowledge-description');
    return [node];
  });
}
