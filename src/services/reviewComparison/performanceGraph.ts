import type { ReviewComparisonPacket } from './types';
import { REVIEW_CLAIM_ROLES, type ReviewPerformanceGraph, type ReviewQuoteSpan } from './semanticTypes';
import { parseReviewAssessment } from '../reviewAssessment';

/** Preset authority was frozen before answering. This span is question context, not semantic evidence. */
export function frozenReviewRequirements(packet: ReviewComparisonPacket): ReviewPerformanceGraph['requirements'] | undefined {
  if (packet.questionIntent.assessment === undefined) return undefined; // Explicit legacy compatibility.
  const assessment = parseReviewAssessment(packet.questionIntent.assessment, packet.questionIntent.knowledgeTargets);
  if (assessment.status !== 'fixed') return [];
  let end = Math.min(600, packet.questionText.length);
  // Do not split a UTF-16 surrogate pair at the audit-context budget boundary.
  if (end < packet.questionText.length && /[\uD800-\uDBFF]/u.test(packet.questionText[end - 1])) end--;
  if (!packet.questionText.slice(0, end).trim()) throw new Error('invalid_requirement');
  return assessment.requirements.map((requirement) => ({ ...requirement, origin: 'frozen_task',
    quote: packet.questionText.slice(0, end), start: 0, end }));
}

export function semanticObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_semantic_format');
  return value as Record<string, unknown>;
}
export function semanticArray(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error('semantic_budget_exceeded');
  return value;
}
export function groundedSpan(value: Record<string, unknown>, text: string, max = 600): ReviewQuoteSpan {
  if (typeof value.quote !== 'string' || !value.quote.trim() || value.quote.length > max) throw new Error('ungrounded_span');
  // Positions are source-derived, not model testimony. Even unsolicited model offsets must not
  // reject a unique exact quote. Never normalize text or guess which repeated occurrence was meant.
  const first = text.indexOf(value.quote);
  if (first < 0) throw new Error('ungrounded_span');
  if (text.indexOf(value.quote, first + 1) < 0) return { quote: value.quote, start: first, end: first + value.quote.length };
  if (value.start === undefined && value.end === undefined) throw new Error('ambiguous_span');
  if (!Number.isSafeInteger(value.start) || !Number.isSafeInteger(value.end)
    || (value.start as number) < 0 || (value.end as number) > text.length
    || (value.end as number) - (value.start as number) !== value.quote.length
    || text.slice(value.start as number, value.end as number) !== value.quote) throw new Error('ungrounded_span');
  return { quote: value.quote, start: value.start as number, end: value.end as number };
}

/** Project only exact USER spans. Tutor, references and model paraphrases cannot become user claims. */
export function readReviewPerformanceGraph(raw: unknown, packet: ReviewComparisonPacket): ReviewPerformanceGraph {
  const root = semanticObject(raw);
  if (root.version !== 1 || root.packetId !== packet.packetId) throw new Error('wrong_semantic_packet');
  const ids = new Set<string>();
  const spans = new Set<string>();
  const claims = semanticArray(root.claims, 12).map((item) => {
    const value = semanticObject(item);
    if (typeof value.id !== 'string' || !/^A(?:[1-9]|1[0-2])$/u.test(value.id) || ids.has(value.id)
      || !REVIEW_CLAIM_ROLES.includes(value.role as never)) throw new Error('invalid_claim');
    const span = groundedSpan(value, packet.answer.text);
    const key = `${span.start}:${span.end}`;
    if (spans.has(key)) throw new Error('duplicate_claim_span');
    ids.add(value.id); spans.add(key);
    return { id: value.id, role: value.role as typeof REVIEW_CLAIM_ROLES[number], ...span };
  });
  const edgeIds = new Set<string>(), pairs = new Set<string>();
  const edges = semanticArray(root.edges, 16).map((item) => {
    const value = semanticObject(item);
    if (typeof value.id !== 'string' || !/^E(?:[1-9]|1[0-6])$/u.test(value.id) || edgeIds.has(value.id)
      || typeof value.source !== 'string' || typeof value.target !== 'string'
      || !ids.has(value.source) || !ids.has(value.target) || value.source === value.target
      || !['support', 'oppose'].includes(value.relation as string)) throw new Error('invalid_edge');
    const span = groundedSpan(value, packet.answer.text, 1600);
    const source = claims.find((claim) => claim.id === value.source)!;
    const target = claims.find((claim) => claim.id === value.target)!;
    // Positional containment, not merely finding the same words somewhere else in the answer.
    if ([source, target].some((claim) => claim.start < span.start || claim.end > span.end)) throw new Error('ungrounded_edge');
    const key = `${value.source}:${value.target}`;
    if (pairs.has(key)) throw new Error('duplicate_edge');
    pairs.add(key); edgeIds.add(value.id);
    return { id: value.id, source: value.source, target: value.target, relation: value.relation as 'support' | 'oppose', ...span };
  });
  const frozen = frozenReviewRequirements(packet);
  const rawRequirements = semanticArray(root.requirements, 60);
  // New extraction returns []; re-reading program-normalized requirements is idempotent.
  // Never accept model-invented scoring requirements as authority.
  if (frozen !== undefined && rawRequirements.length && (rawRequirements.length !== frozen.length
    || rawRequirements.some((item, index) => {
      const value = semanticObject(item), expected = frozen[index];
      return Object.keys(value).sort().join('|') !== Object.keys(expected).sort().join('|')
        || Object.entries(expected).some(([key, field]) => JSON.stringify(value[key]) !== JSON.stringify(field));
    }))) throw new Error('frozen_requirement_mismatch');
  const requirementsSeen = new Set<string>();
  const requirements = frozen ?? rawRequirements.map((item) => {
    const value = semanticObject(item);
    if (typeof value.knowledgeTarget !== 'string' || !packet.questionIntent.knowledgeTargets.includes(value.knowledgeTarget)
      || !['concept', 'judgment', 'reasoning'].includes(value.layer as string)) throw new Error('invalid_requirement');
    const key = `${value.knowledgeTarget}:${value.layer}`;
    if (requirementsSeen.has(key)) throw new Error('duplicate_requirement');
    requirementsSeen.add(key);
    return { knowledgeTarget: value.knowledgeTarget, layer: value.layer as 'concept' | 'judgment' | 'reasoning',
      ...groundedSpan(value, packet.questionText) };
  });
  return { version: 1, packetId: packet.packetId, claims, edges, requirements };
}
