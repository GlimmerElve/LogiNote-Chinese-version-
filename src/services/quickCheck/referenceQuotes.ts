import { restoredReferenceQuote, type MasteryShadowReferenceItem } from '../masteryShadow/evaluator';

/** All quick-check stages use the same source locator as mastery evaluation.
 * Restore formatting only; never rewrite facts, punctuation, numbers or negation. */
export function quickCheckReferenceQuotes(raw: unknown, references: MasteryShadowReferenceItem[], allowedIds: string[]) {
  if (!Array.isArray(raw) || !raw.length || raw.length > 3)
    throw new Error('缺少可核对的资料摘录：需提供1至3段原文。');
  return raw.map(value => {
    const row = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    const referenceId = typeof row.referenceId === 'string' ? row.referenceId.trim() : '';
    if (!allowedIds.includes(referenceId)) throw new Error('缺少可核对的引用：摘录编号不属于本题。');
    const reference = references.find(item => item.id === referenceId);
    if (!reference) throw new Error('缺少可核对的引用：使用了本次未提供的编号。');
    const quote = typeof row.quote === 'string' ? row.quote.trim() : '';
    if (!quote || [...quote].length > 240) throw new Error('资料摘录为空或超过240字，请缩短摘录。');
    const restored = restoredReferenceQuote(reference.quote, quote);
    if (!restored) throw new Error('资料摘录无法定位到原文；请复制连续原文，不改写或拼接。');
    return { referenceId, quote: restored };
  });
}
