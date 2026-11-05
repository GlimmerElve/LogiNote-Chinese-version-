import { ALIGNMENT_AXES, COMPARISON_RELATIONS } from '../cognition/alignment';
import { reviewSnapshotHash } from './packet';
import { readReviewPerformanceGraph } from './performanceGraph';
import { readReviewSemanticComparison } from './semanticValidation';
import type { ReviewComparisonPacket } from './types';
import type { ReviewClaimAlignment, ReviewPerformanceGraph, ReviewSemanticComparison } from './semanticTypes';

export type ReviewComparisonProtocol = 'legacy-v1' | 'bound-v2' | 'isolated-anchors-v3';
export const REVIEW_BOUND_LIMITS = { alignmentSlots: 256, edgeSlots: 128, linkSlots: 12, inputCharacters: 90000 } as const;
interface AlignmentSlot { pairId: string; claimId: string; corpus: 'personal' | 'reference'; targetId: string; knowledgeTarget?: string }
interface EdgeSlot { slotId: string; edgeId: string; sourceId: string; knowledgeTarget: string }
interface LinkSlot { slotId: string; claimId: string; targetNodeId: string }

/** Slots are legal routing candidates, NOT semantic matches or authority to modify either store. */
export async function buildReviewBoundInput(input: ReviewComparisonPacket, rawGraph: ReviewPerformanceGraph) {
  const packet = structuredClone(input);
  const graph = readReviewPerformanceGraph(structuredClone(rawGraph), packet);
  const target = packet.personal.status === 'ready'
    ? packet.personal.graph?.nodes.find((n) => n.id === packet.questionIntent.cognitionTarget?.nodeId) : undefined;
  const alignmentSlots: AlignmentSlot[] = [], edgeSlots: EdgeSlot[] = [], linkSlots: LinkSlot[] = [];
  for (const claim of graph.claims) {
    if (target) {
      alignmentSlots.push({ pairId: `P${alignmentSlots.length + 1}`, claimId: claim.id, corpus: 'personal', targetId: target.id });
      linkSlots.push({ slotId: `L${linkSlots.length + 1}`, claimId: claim.id, targetNodeId: target.id });
    }
    for (const source of packet.references) for (const knowledgeTarget of packet.questionIntent.knowledgeTargets) {
      alignmentSlots.push({ pairId: `P${alignmentSlots.length + 1}`, claimId: claim.id,
        corpus: 'reference', targetId: source.sourceId, knowledgeTarget });
    }
  }
  for (const edge of graph.edges) for (const source of packet.references) for (const knowledgeTarget of packet.questionIntent.knowledgeTargets) {
    edgeSlots.push({ slotId: `T${edgeSlots.length + 1}`, edgeId: edge.id, sourceId: source.sourceId, knowledgeTarget });
  }
  if (alignmentSlots.length > REVIEW_BOUND_LIMITS.alignmentSlots || edgeSlots.length > REVIEW_BOUND_LIMITS.edgeSlots
    || linkSlots.length > REVIEW_BOUND_LIMITS.linkSlots) throw new Error('semantic_binding_budget_exceeded');
  const routing = { alignmentSlots, edgeSlots, linkSlots };
  // Bind actual packet bodies/versions, not just a caller-supplied snapshot hash, and the validated graph.
  const bindingId = `review-bound-v2:${await reviewSnapshotHash({ protocol: 'bound-v2', packet, graph, routing })}`;
  const result = {
    version: 2 as const, bindingId, questionText: packet.questionText, answer: packet.answer,
    knowledgeTargets: packet.questionIntent.knowledgeTargets,
    personal: target ? { status: 'ready' as const, target: { nodeId: target.id, text: target.text,
      purpose: packet.questionIntent.cognitionTarget!.purpose }, context: packet.personal.context || '',
      neighbors: packet.personal.graph!.nodes.filter((n) => n.id !== target.id).map((n) => ({ nodeId: n.id, text: n.text })),
      truncated: packet.personal.truncated } : { status: packet.personal.status },
    references: packet.references.map((s) => ({ sourceId: s.sourceId, title: s.title, text: s.text, truncated: s.truncated })),
    graph, ...routing,
  };
  if (JSON.stringify(result).length > REVIEW_BOUND_LIMITS.inputCharacters) throw new Error('semantic_binding_budget_exceeded');
  return result;
}
export type ReviewBoundInput = Awaited<ReturnType<typeof buildReviewBoundInput>>;

const fail = (code = 'invalid_bound_format'): never => { throw new Error(code); };
function object(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const item = value as Record<string, unknown>;
  if (required.some((key) => !Object.hasOwn(item, key))
    || Object.keys(item).some((key) => !required.includes(key) && !optional.includes(key))) return fail();
  return item;
}
function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) return fail();
  return value;
}
function oneOf<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) return fail();
  return value as T;
}
function text(value: unknown, max: number, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) return fail();
  return value;
}
function confidence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) return fail();
  return value;
}
function axes(raw: unknown): ReviewClaimAlignment['axes'] {
  const value = object(raw, [...ALIGNMENT_AXES]);
  return Object.fromEntries(ALIGNMENT_AXES.map((name) => {
    const axis = object(value[name], ['status', 'personalQuote', 'documentQuote', 'reason']);
    // Explicit wire enum distinguishes DIMENSION identity from the actual outcome/value.
    // Never infer/repair "different" into "same" from a reason or opposite values.
    const status = name === 'metric'
      ? oneOf(axis.status, ['same_dimension', 'different_dimension', 'unknown', 'not_applicable'] as const)
      : oneOf(axis.status, ['same', 'different', 'unknown', 'not_applicable'] as const);
    return [name, { status: status === 'same_dimension' ? 'same' : status === 'different_dimension' ? 'different' : status,
      personalQuote: text(axis.personalQuote, 200, true), documentQuote: text(axis.documentQuote, 200, true), reason: text(axis.reason, 160) }];
  })) as ReviewClaimAlignment['axes'];
}

/** Strict v2 wire projection; the existing provenance, scope, confidence and direction gates still run. */
export async function readReviewBoundComparison(
  raw: unknown, input: ReviewComparisonPacket, rawGraph: ReviewPerformanceGraph,
): Promise<ReviewSemanticComparison> {
  const packet = structuredClone(input), graph = readReviewPerformanceGraph(structuredClone(rawGraph), packet);
  const binding = await buildReviewBoundInput(packet, graph);
  const root = object(raw, ['version', 'bindingId', 'referenceAudit', 'alignments', 'edgeChecks', 'personalLinks']);
  if (root.version !== 2 || root.bindingId !== binding.bindingId) return fail('wrong_bound_binding');
  const audit = object(root.referenceAudit, ['status', 'sourceIds']);
  const seen = new Set<string>();
  function slot<T extends { pairId?: string; slotId?: string }>(id: unknown, slots: T[], key: 'pairId' | 'slotId'): T {
    const found = slots.find((s) => s[key] === id);
    if (!found) return fail('unknown_bound_slot');
    if (seen.has(id as string)) return fail('duplicate_bound_slot');
    seen.add(id as string); return found;
  }
  const alignments = list(root.alignments, 36).map((rawItem) => {
    const item = object(rawItem, ['pairId', 'sourceQuote', 'confidence', 'relation', 'sourcesCompatible', 'axes'], ['relationBasis']);
    const pair = slot(item.pairId, binding.alignmentSlots, 'pairId');
    const claim = graph.claims.find((c) => c.id === pair.claimId)!;
    const sourceQuote = text(item.sourceQuote, 600);
    if (typeof item.sourcesCompatible !== 'boolean') return fail();
    const basis = item.relationBasis === undefined ? undefined
      : object(item.relationBasis, ['kind', 'personalQuote', 'documentQuote', 'explanation']);
    return { claimId: pair.claimId, corpus: pair.corpus, targetId: pair.targetId,
      ...(pair.corpus === 'reference' ? { knowledgeTarget: pair.knowledgeTarget } : {}),
      personalQuote: pair.corpus === 'personal' ? sourceQuote : claim.quote,
      documentQuote: pair.corpus === 'personal' ? claim.quote : sourceQuote,
      confidence: confidence(item.confidence), relation: oneOf(item.relation, COMPARISON_RELATIONS),
      sourcesCompatible: item.sourcesCompatible, axes: axes(item.axes),
      ...(basis ? { relationBasis: { kind: oneOf(basis.kind, ['observed_counterexample', 'incompatible_facts', 'evidence_limit', 'unknown'] as const),
        personalQuote: text(basis.personalQuote, 300), documentQuote: text(basis.documentQuote, 300), explanation: text(basis.explanation, 200) } } : {}) };
  });
  const edgeChecks = list(root.edgeChecks, 16).map((rawItem) => {
    const item = object(rawItem, ['slotId', 'referenceQuote', 'relation', 'verdict', 'direction', 'basis', 'conclusion', 'premiseStatus', 'confidence']);
    const pair = slot(item.slotId, binding.edgeSlots, 'slotId');
    const edge = graph.edges.find((e) => e.id === pair.edgeId)!;
    const basis = oneOf(item.basis, ['source', 'target'] as const), conclusion = oneOf(item.conclusion, ['source', 'target'] as const);
    return { edgeId: pair.edgeId, sourceId: pair.sourceId, knowledgeTarget: pair.knowledgeTarget,
      referenceQuote: text(item.referenceQuote, 600), relation: oneOf(item.relation, ['support', 'oppose'] as const),
      verdict: oneOf(item.verdict, ['supported', 'contradicted', 'unverifiable'] as const),
      direction: oneOf(item.direction, ['source_to_target', 'target_to_source', 'undetermined'] as const),
      basisClaimId: edge[basis], conclusionClaimId: edge[conclusion],
      premiseStatus: oneOf(item.premiseStatus, ['sufficient', 'missing'] as const), confidence: confidence(item.confidence) };
  });
  const personalLinks = list(root.personalLinks, 12).map((rawItem) => {
    const item = object(rawItem, ['slotId', 'answerQuote', 'personalQuote', 'relation', 'direction', 'basis', 'conclusion', 'premiseStatus', 'confidence']);
    const pair = slot(item.slotId, binding.linkSlots, 'slotId');
    return { claimId: pair.claimId, targetNodeId: pair.targetNodeId, answerQuote: text(item.answerQuote, 600), personalQuote: text(item.personalQuote, 600),
      relation: oneOf(item.relation, ['support', 'oppose'] as const),
      direction: oneOf(item.direction, ['answer_to_personal', 'personal_to_answer', 'undetermined'] as const),
      basis: oneOf(item.basis, ['answer', 'personal'] as const), conclusion: oneOf(item.conclusion, ['answer', 'personal'] as const),
      premiseStatus: oneOf(item.premiseStatus, ['sufficient', 'missing'] as const), confidence: confidence(item.confidence) };
  });
  return readReviewSemanticComparison({ version: 1, packetId: packet.packetId,
    referenceAudit: { status: oneOf(audit.status, ['compatible', 'conflict', 'unknown'] as const),
      sourceIds: list(audit.sourceIds, 7).map((id) => text(id, 60)) }, alignments, edgeChecks, personalLinks }, packet, graph);
}
