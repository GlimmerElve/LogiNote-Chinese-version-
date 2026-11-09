import type { KnowledgeMasteryView } from './masteryReadModel';

/** Short entry-page copy only; the authoritative status and stored evidence stay unchanged. */
export function compactReviewMasteryLabel(view: Pick<KnowledgeMasteryView, 'mode' | 'displayLabel'>): string {
  if (view.mode !== 'current') return view.displayLabel;
  if (view.displayLabel === '待复核（历史估计）') return '待复核';
  if (view.displayLabel === '待评估（仅历史评分）') return '待评估';
  if (/^历史估计至(?:概念|判断|推理)层（待确认）$/u.test(view.displayLabel)) return '待确认';
  return view.displayLabel;
}
