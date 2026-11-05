import type { QuickCheckDesign, QuickCheckHistoryItem } from './types';

/** Exact stem/design matches are structural guards, not a semantic classifier.
 * The locally chosen operation and model's source-grounded design add variety
 * without treating shared domain terminology as evidence of duplication. */
export function quickCheckStemKey(prompt: string): string {
  return prompt.normalize('NFKC').toLocaleLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '');
}

export function repeatedQuickCheckSlots(
  generated: Array<{ id: string; prompt: string; design?: QuickCheckDesign }>, previous: string[], retained: Array<{ prompt: string; design?: QuickCheckDesign }>,
  history: QuickCheckHistoryItem[] = [],
): string[] {
  const seen = new Set([...previous, ...retained.map(question => question.prompt)].map(quickCheckStemKey));
  const designs = [...history, ...retained].flatMap(item => item.design ? [item.design] : []);
  const scenarios = new Set(designs.map(design => quickCheckStemKey(design.scenario)));
  const focuses = new Set(designs.map(design => quickCheckStemKey(design.focus)));
  return generated.flatMap(question => {
    const stem = quickCheckStemKey(question.prompt), duplicate = seen.has(stem)
      || !!question.design && (scenarios.has(quickCheckStemKey(question.design.scenario)) || focuses.has(quickCheckStemKey(question.design.focus)));
    seen.add(stem);
    if (question.design) { scenarios.add(quickCheckStemKey(question.design.scenario)); focuses.add(quickCheckStemKey(question.design.focus)); }
    return duplicate ? [question.id] : [];
  });
}
