import type { AlignmentCase } from './cognition-alignment-dataset';
import type { AlignmentDecision } from '../src/services/cognition/alignment';

/** Fixed before the new-protocol run. Advisory pilot criteria, never deployment permission. */
export const ALIGNMENT_PILOT_CRITERIA = [
  'All 24 cases complete without transport or output-contract failures.',
  'No must-clarify case is accepted; no non-contradiction case is published as contradiction.',
  'Both annotated actual-contradiction cases are correctly accepted against their target claim.',
  'At least 10 of 12 comparable cases produce the annotated relation, or a grounded wording-only notice for an annotated certainty_change case; report those two outcomes separately.',
  'No cognition-source mutation, extra model retry, fabricated quote, or automatic production promotion.',
] as const;

export interface AlignmentOutcome {
  id: string;
  targetRetrieved: boolean;
  targetSelected: boolean;
  method: string;
  decision: AlignmentDecision;
  error?: string;
}
export function evaluateAlignment(cases: AlignmentCase[], outcomes: AlignmentOutcome[]) {
  if (new Set(outcomes.map((o) => o.id)).size !== outcomes.length || outcomes.some((o) => !cases.some((c) => c.id === o.id))) throw new Error('Invalid outcome IDs');
  const rows = cases.map((c) => {
    const o = outcomes.find((r) => r.id === c.id);
    const valid = !!o && !o.error;
    const protocolFailure = !!o && ['invalid_format', 'invalid_axes', 'invalid_source', 'ungrounded_quote', 'ungrounded_axis',
      'missing_relation_basis', 'invalid_relation_basis', 'ungrounded_relation_basis'].includes(o.decision.code);
    return { id: c.id, expected: c.expected, completed: valid, retrieved: !!o?.targetRetrieved,
      protocolFailure,
      limitedCertaintyNotice: valid && o!.decision.code === 'certainty_only' && !!o!.decision.certaintyNotice,
      accepted: valid && o!.decision.accepted,
      correct: valid && !protocolFailure && o!.targetRetrieved && (c.expected === 'clarify' ? !o!.decision.accepted
        : o!.targetSelected && o!.decision.accepted && o!.decision.alignment?.relation === c.expected),
      code: o?.error || o?.decision.code || 'not_run' };
  });
  const count = (fn: (r: typeof rows[number]) => boolean) => rows.filter(fn).length;
  return { total: cases.length, completed: count((r) => r.completed), notCompleted: count((r) => !r.completed),
    hybridRetrievalRuns: outcomes.filter((o) => o.method === 'local-hybrid-v1').length,
    targetRetrieved: count((r) => r.retrieved), correct: count((r) => r.correct),
    protocolFailures: count((r) => r.protocolFailure),
    limitedCertaintyNotices: count((r) => r.limitedCertaintyNotice),
    safeRejectionsOfClarifyCases: count((r) => r.expected === 'clarify' && r.completed && !r.accepted),
    mustClarify: count((r) => r.expected === 'clarify'), unsafeAcceptances: count((r) => r.expected === 'clarify' && r.accepted),
    shouldAccept: count((r) => r.expected !== 'clarify'),
    unnecessaryClarifications: count((r) => r.expected !== 'clarify' && r.completed && r.retrieved && !r.accepted && !r.limitedCertaintyNotice),
    wrongAcceptedRelationOrTarget: count((r) => r.expected !== 'clarify' && r.accepted && !r.correct),
    rejectionCodes: Object.fromEntries([...new Set(rows.filter((r) => !r.accepted).map((r) => r.code))].map((code) => [code, count((r) => !r.accepted && r.code === code)])),
    productionApproved: false, rows };
}
