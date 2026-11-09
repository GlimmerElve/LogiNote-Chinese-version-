import { parseTextbookMarkdown } from './textbook/markdown';

type Range = [number, number];
type Node = { type: string; depth?: number; value?: string; children?: Node[]; position?: { start: { offset?: number }; end: { offset?: number } } };
const protectedTypes = new Set(['code', 'inlineCode', 'math', 'inlineMath', 'link', 'linkReference', 'image', 'imageReference', 'definition', 'html']);

/** One observed notation drift only. Do not infer sources or edit mathematical
 * expressions, authored destinations, code samples or existing Wiki links. */
function protectedConceptRanges(content: string): Range[] {
  const protectedRanges: Range[] = [];
  const protect = (node: Node) => {
    if (protectedTypes.has(node.type)) {
      const start = node.position?.start.offset, end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) protectedRanges.push([start, end]);
      return;
    }
    node.children?.forEach(protect);
  };
  const tree = parseTextbookMarkdown(content) as Node;
  protect(tree);
  const nodes = tree.children || [];
  const label = (node: Node): string => node.value || (node.children || []).map(label).join('');
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    if (node.type !== 'heading' || ![2, 3].includes(node.depth || 0) || !/^(?:来源|参考资料|参考文献|References?)[：:]?$/iu.test(label(node).trim())) continue;
    const start = node.position?.start.offset;
    const next = nodes.slice(index + 1).find(item => item.type === 'heading' && (item.depth || 0) <= node.depth!);
    if (start !== undefined) protectedRanges.push([start, next?.position?.start.offset ?? content.length]);
  }
  for (const pattern of [
    /\[\[[^\]\r\n]*\]\]/gu,
    /\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]/gu,
    /(?:https?:\/\/|ftp:\/\/|mailto:)[^\s<>]+/giu,
  ]) for (const match of content.matchAll(pattern)) protectedRanges.push([match.index!, match.index! + match[0].length]);
  return protectedRanges;
}

export function normalizeConceptCitationMarkers(content: string): string {
  if (!content.includes('【来源')) return content;
  const protectedRanges = protectedConceptRanges(content);
  return content.replace(/【来源[ \t]*(\d+)[ \t]*】/gu, (marker, id: string, offset: number) => {
    const end = offset + marker.length;
    return protectedRanges.some(([start, stop]) => offset < stop && end > start) ? marker : `[${id}]`;
  });
}

/** Plain citation collection uses the same protected spans as normalization. */
export function extractConceptCitationIdsProtected(content: string): number[] {
  const ranges = protectedConceptRanges(content);
  return [...new Set([...content.matchAll(/\[(\d+)\]/gu)].filter(match => !ranges.some(([start, end]) => match.index! < end && match.index! + match[0].length > start)).map(match => Number(match[1])))];
}

/** Unwrap only a complete Markdown envelope. A language code fence is content,
 * never a wrapper. Strip source lists only when they form the final section. */
export function stripConceptModelSourceList(content: string): string {
  const blankLines = (value: string) => value.replace(/^(?:[ \t]*\r?\n)+/u, '').replace(/(?:\r?\n[ \t]*)+$/u, '');
  let text = content.trim() ? blankLines(content) : '';
  let tree = parseTextbookMarkdown(text) as Node;
  let nodes = tree.children || [];
  const wrapper = /^(`{3,}|~{3,})(?:markdown)?[ \t]*\r?\n([\s\S]*?)\r?\n\1[ \t]*$/iu.exec(text);
  // A matching first/last fence alone can enclose several independent blocks.
  // Only one complete parsed code node can be a model's Markdown envelope.
  if (wrapper && nodes.length === 1 && nodes[0].type === 'code'
    && nodes[0].position?.start.offset === 0 && nodes[0].position?.end.offset === text.length) {
    text = blankLines(wrapper[2]);
    tree = parseTextbookMarkdown(text) as Node;
    nodes = tree.children || [];
  }
  const label = (node: Node): string => node.value || (node.children || []).map(label).join('');
  for (let index = nodes.length - 1; index >= 0; index--) {
    const node = nodes[index];
    if (node.type !== 'heading' || !node.depth || node.depth > 3) continue;
    if (node.depth < 2 || !/^(?:来源|参考资料|参考文献|References?)[：:]?$/iu.test(label(node).trim())) return text;
    const tail = nodes.slice(index + 1);
    // Only bibliography-shaped tails may disappear. A later prose paragraph,
    // formula, code sample or heading is kept rather than mistaken for sources.
    const bibliography = tail.length > 0 && tail.every(item => item.type === 'list' || item.type === 'definition'
      || item.type === 'paragraph' && (item.children || []).every(child => child.type === 'link' || child.type === 'text' && !child.value?.trim()));
    const offset = node.position?.start.offset;
    return bibliography && offset !== undefined ? blankLines(text.slice(0, offset)) : text;
  }
  return text;
}
