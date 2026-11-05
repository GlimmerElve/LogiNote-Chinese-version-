import type { Element, ElementContent } from 'hast';

export type TextbookQuoteKind = 'compare' | 'steps' | 'example' | 'interactive' | 'takeaway' | 'warning' | 'question' | 'note';
const kinds: Record<string, TextbookQuoteKind> = {
  '对比': 'compare', '步骤': 'steps', '例题': 'example', '交互探索': 'interactive',
  '要点': 'takeaway', '注意': 'warning', '思考': 'question', '注释': 'note',
};
declare module 'hast' {
  interface ElementData {
    readingContinuation?: boolean;
    readingQuoteKind?: TextbookQuoteKind;
    readingQuoteBrief?: string;
  }
}
/** Pure parser-side equivalent of the rich quote renderer, safe in a worker. */
export function textbookQuoteKind(node?: Element): TextbookQuoteKind | undefined {
  if (node?.data?.readingQuoteKind) return node.data.readingQuoteKind;
  const first = node?.children.find((child): child is Element => child.type === 'element');
  if (first?.tagName !== 'p') return undefined;
  const content = first.children.filter(child => child.type !== 'text' || child.value.trim());
  if (content.length !== 1 || content[0].type !== 'element' || content[0].tagName !== 'strong') return undefined;
  const label = (content[0].children as ElementContent[]).map(child => child.type === 'text' ? child.value : '').join('').trim();
  return kinds[label];
}
