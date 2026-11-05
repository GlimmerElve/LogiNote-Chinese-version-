import type { ReviewDualCase } from './review-dual-dataset';
import type { ReviewSemanticResult } from '../src/services/reviewComparison/semanticTypes';

/** Frozen small-pilot criteria, not deployment approval or a statistical accuracy claim. */
export const REVIEW_DUAL_PILOT_CRITERIA = {
  completedCases: 28, protocolValidCasesAtLeast: 26,
  correctDefinitionsAtLeast: 3, correctJudgmentsAtLeast: 3,
  actualContradictionsRequired: 3, validReasoningRequired: 2, invalidReasoningRejectedRequired: 1,
  growthCasesCorrectAtLeast: 5, newEvidenceGrowthRequired: true,
  unsafeNegativeOrConflictMaximum: 0, unconfirmedWritesMaximum: 0,
  repeatedBeliefMustNotGrow: true, noAutomaticProductionPromotion: true,
} as const;
const protocolCodes = new Set(['invalid_semantic_format', 'semantic_budget_exceeded', 'ungrounded_span', 'ambiguous_span',
  'wrong_semantic_packet', 'invalid_claim', 'duplicate_claim_span', 'invalid_edge', 'ungrounded_edge', 'duplicate_edge',
  'invalid_requirement', 'duplicate_requirement', 'incomplete_reference_audit', 'invalid_alignment_target',
  'invalid_personal_target', 'invalid_reference_target', 'duplicate_alignment', 'invalid_edge_check', 'invalid_personal_link',
  'invalid_model_json', 'ungrounded_quote', 'invalid_axes', 'ungrounded_axis', 'missing_relation_basis',
  'invalid_relation_basis', 'ungrounded_relation_basis', 'invalid_bound_format', 'wrong_bound_binding',
  'unknown_bound_slot', 'duplicate_bound_slot', 'semantic_binding_budget_exceeded', 'invalid_anchored_format', 'wrong_anchored_binding',
  'unknown_anchored_slot', 'duplicate_anchored_slot', 'anchor_budget_exceeded', 'invalid_anchor_interval',
  'unknown_quote_anchor', 'wrong_quote_source', 'quote_anchor_too_long', 'quote_anchor_outside_claim']);
export interface ReviewDualOutcome { id: string; result?: ReviewSemanticResult; error?: string; requests: number }

export function evaluateReviewDual(cases: ReviewDualCase[], outcomes: ReviewDualOutcome[], mode: 'cloud' | 'local' | 'replay' | 'replay-candidate',
  options: { requestLimitPerCase?: 2 | 3 } = {}) {
  const requestLimit = options.requestLimitPerCase ?? 2;
  if (requestLimit !== 2 && requestLimit !== 3) throw new Error('Invalid request limit');
  if (new Set(cases.map((c) => c.id)).size !== cases.length || new Set(outcomes.map((o) => o.id)).size !== outcomes.length
    || outcomes.some((o) => !cases.some((c) => c.id === o.id) || !Number.isSafeInteger(o.requests) || o.requests < 0 || o.requests > requestLimit)) {
    throw new Error('Invalid evaluation IDs or request count');
  }
  const rows = cases.map((c) => {
    const o = outcomes.find((outcome) => outcome.id === c.id), r = o?.result;
    const completed = !!r && !o?.error && !r.reasons.some((code) => ['semantic_model_unavailable', 'semantic_timeout', 'semantic_aborted'].includes(code));
    const reasonCodes = [...new Set([...(r?.reasons || []), ...(r?.alignments || []).filter((a) => !a.accepted).map((a) => a.code)])];
    const protocolValid = completed && !reasonCodes.some((code) => protocolCodes.has(code));
    const m = r?.mastery.find((item) => item.knowledgeTarget === c.topic);
    const negative = !!m && Object.values(m.layers).some((layer) => layer.observations.some((e) => e.verdict === 'contradicted'));
    const factualConflict = !!r?.growth.proposals.some((p) => p.operation === 'review_conflict');
    const unconfirmedWrite = !!r && (r.writes !== 'disabled' || r.mastery.some((item) => item.scoreWrite !== 'disabled')
      || r.growth.proposals.some((p) => p.status !== 'pending_confirmation' || p.preserveOriginal !== true));
    const claimsCovered = !!r?.graph && c.expected.requiredClaims.every((text) => r.graph!.claims.some((claim) => claim.quote.includes(text)));
    const masteryCorrect = completed && !!m && Object.entries(c.expected.mastery).every(([layer, expected]) => m.layers[layer as keyof typeof m.layers].status === expected);
    const growthCorrect = c.expected.growth === undefined ? undefined : completed && (c.expected.growth === 'held' || c.expected.growth === 'no_change'
      ? r!.growth.status === c.expected.growth : r!.growth.status === 'proposed'
        && r!.growth.proposals.some((p) => p.operation === c.expected.growth));
    let edgeCorrect: boolean | undefined;
    if (c.expected.edge) {
      const e = c.expected.edge;
      const observed = !!r?.graph && !!m?.layers.reasoning.observations.some((observation) => {
        const edge = r.graph!.edges.find((item) => item.id === observation.edgeId);
        return observation.verdict === 'supported' && edge?.relation === 'support'
          && !!r.graph!.claims.find((claim) => claim.id === edge.source)?.quote.includes(e.premise)
          && !!r.graph!.claims.find((claim) => claim.id === edge.target)?.quote.includes(e.conclusion);
      });
      edgeCorrect = completed && (e.supported ? observed : !observed && m?.layers.reasoning.status === 'unassessed');
    }
    const unsafe = unconfirmedWrite || (c.expected.noNegative && negative) || (c.expected.noConflict && factualConflict);
    return { id: c.id, family: c.family, completed, protocolValid, claimsCovered, masteryCorrect, growthCorrect, edgeCorrect,
      unsafe, unconfirmedWrite, negative, factualConflict, masteryHeld: m?.status === 'held', growthHeld: r?.growth.status === 'held',
      correct: protocolValid && masteryCorrect && (growthCorrect ?? true) && (edgeCorrect ?? true) && !unsafe
        && (c.expected.requiredClaims.length ? claimsCovered : true),
      requests: o?.requests || 0, codes: o?.error ? [o.error] : reasonCodes };
  });
  const count = (predicate: (row: typeof rows[number]) => boolean) => rows.filter(predicate).length;
  const good = (id: string) => rows.find((r) => r.id === id)?.correct === true;
  const gates = {
    allCasesCompleted: count((r) => r.completed) === REVIEW_DUAL_PILOT_CRITERIA.completedCases,
    outputContracts: count((r) => r.protocolValid) >= REVIEW_DUAL_PILOT_CRITERIA.protocolValidCasesAtLeast,
    definitions: count((r) => r.family === 'definition' && r.correct) >= REVIEW_DUAL_PILOT_CRITERIA.correctDefinitionsAtLeast,
    judgments: count((r) => r.family === 'judgment' && r.correct) >= REVIEW_DUAL_PILOT_CRITERIA.correctJudgmentsAtLeast,
    actualContradictions: count((r) => r.family === 'contradiction' && r.correct) === REVIEW_DUAL_PILOT_CRITERIA.actualContradictionsRequired,
    validReasoning: ['R01', 'R02'].every(good), invalidReasoning: good('R03'),
    growth: count((r) => r.family === 'growth' && r.correct) >= REVIEW_DUAL_PILOT_CRITERIA.growthCasesCorrectAtLeast,
    newEvidenceGrowth: good('G02'), repeatedBeliefNoGrowth: good('B06'),
    noUnsafeOutputs: count((r) => r.unsafe) === 0, noWrites: count((r) => r.unconfirmedWrite) === 0,
  };
  return { mode, total: cases.length, completed: count((r) => r.completed), correct: count((r) => r.correct),
    protocolFailures: count((r) => r.completed && !r.protocolValid), unsafeOutputs: count((r) => r.unsafe),
    masteryHeld: count((r) => !!r.masteryHeld), growthHeld: count((r) => !!r.growthHeld),
    requests: outcomes.reduce((sum, outcome) => sum + outcome.requests, 0),
    familyCounts: Object.fromEntries([...new Set(cases.map((c) => c.family))].map((family) => [family, {
      total: count((r) => r.family === family), correct: count((r) => r.family === family && r.correct),
    }])), gates, pilotPassed: (mode === 'cloud' || mode === 'replay') && Object.values(gates).every(Boolean), productionApproved: false,
    annotationStatus: 'assistant_draft', rows };
}
