import type { ReviewDualOutcome } from './review-dual-evaluation';

/** Separate, versioned audit of known synthetic directions. NOT a general semantic verifier,
 * production gate or a retroactive change to the frozen 28-case expectations. Labels stay off wire. */
export const REVIEW_GROWTH_DIRECTION_EXPECTATIONS = [
  { id: 'G02', direction: 'answer_to_personal', claimContains: '三次实测', purpose: '新观察支持旧观点' },
  { id: 'G06', direction: 'personal_to_answer', claimContains: '本次设备甲报警', purpose: '旧前提推出新结论，不能由报警倒推阈值' },
  { id: 'B06', direction: 'none', claimContains: '', purpose: '纯重述不生长也不形成新证据边' },
] as const;

export function auditReviewGrowthDirections(outcomes: ReviewDualOutcome[]) {
  const entries = REVIEW_GROWTH_DIRECTION_EXPECTATIONS.map((expected) => {
    const outcome = outcomes.find((o) => o.id === expected.id), growth = outcome?.result?.growth;
    if (!growth || outcome?.error) return { ...expected, status: 'unassessed' as const, wrongDirectionCount: 0 };
    if (expected.direction === 'none') return { ...expected,
      status: growth.status === 'no_change' && !growth.proposals.length ? 'passed' as const : 'failed' as const,
      wrongDirectionCount: growth.proposals.filter((p) => p.link).length };
    const candidates = growth.proposals.filter((p) => p.operation === 'supplement' && p.claim.quote.includes(expected.claimContains));
    const wrongDirectionCount = candidates.filter((p) => p.link && p.link.direction !== expected.direction).length;
    const basis = expected.direction === 'answer_to_personal' ? 'answer' : 'personal';
    const conclusion = expected.direction === 'answer_to_personal' ? 'personal' : 'answer';
    const valid = candidates.some((p) => p.link?.direction === expected.direction && p.link.basis === basis
      && p.link.conclusion === conclusion && p.link.premiseStatus === 'sufficient');
    return { ...expected, status: valid && !wrongDirectionCount ? 'passed' as const : 'failed' as const, wrongDirectionCount };
  });
  return { version: 1, annotationStatus: 'assistant_draft' as const, entries,
    passed: entries.filter((e) => e.status === 'passed').length,
    unassessed: entries.filter((e) => e.status === 'unassessed').length,
    wrongDirectionCount: entries.reduce((sum, e) => sum + e.wrongDirectionCount, 0),
    ready: entries.every((e) => e.status === 'passed'), productionApproved: false as const };
}
