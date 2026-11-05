import type { ReviewAnswerClaim, ReviewAnswerEdge } from './semanticTypes';

type FrozenInferenceGraph = {
  readonly claims: readonly Pick<ReviewAnswerClaim, 'id' | 'start' | 'end'>[];
  readonly edges: readonly Pick<ReviewAnswerEdge, 'source' | 'target'>[];
};

/**
 * Explicit opt-in check for an already source-grounded frozen user graph.
 * Different IDs do not make a whole argument and its nested conclusion two
 * independent inference endpoints. Only endpoints of the SAME real edge must
 * have disjoint UTF-16 half-open spans. Other overlaps, compound premises and
 * reuse across successive edges remain allowed.
 *
 * This never parses connectives, splits a claim, repairs direction, or certifies
 * argument validity. A failure is structural uncertainty: the caller must hold
 * the comparison, not mark the user's answer wrong or assign a zero score.
 * The shared graph reader and legacy protocols do not call this assertion.
 */
export function assertFrozenInferenceAtomicity(graph: FrozenInferenceGraph): void {
  const claims = new Map(graph.claims.map(claim => [claim.id, claim]));
  for (const edge of graph.edges) {
    const source = claims.get(edge.source), target = claims.get(edge.target);
    // The grounding reader normally establishes this precondition. Do not
    // silently skip an invalid edge if this pure check is called independently.
    if (!source || !target) throw new Error('invalid_frozen_inference_endpoint');
    if (!(source.end <= target.start || target.end <= source.start)) {
      throw new Error('non_atomic_inference_endpoint');
    }
  }
}
