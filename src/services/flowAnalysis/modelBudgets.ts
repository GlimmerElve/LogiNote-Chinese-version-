/** Output ceilings, not target consumption. Assessment must leave room for final JSON after reasoning. */
export const FLOW_REVIEW_MODEL_BUDGETS = Object.freeze({
  extractionMaxTokens: 12000,
  assessmentMaxTokens: 32000,
});

export function flowReviewMaxTokens(stage: 'extract' | 'assess'): number {
  return stage === 'extract' ? FLOW_REVIEW_MODEL_BUDGETS.extractionMaxTokens : FLOW_REVIEW_MODEL_BUDGETS.assessmentMaxTokens;
}
