import { ALIGNMENT_AXES, COMPARISON_RELATIONS } from '../cognition/alignment';
import { ALL_ARGUMENT_TYPES } from '../argumentDoc/types';
import type { CognitionGraph, CognitionStance } from '../cognition/types';
import { reviewSnapshotHash } from './packet';
import { readReviewPerformanceGraph } from './performanceGraph';
import { readReviewSemanticComparison } from './semanticValidation';
import { buildReviewQuoteAnchors, readReviewQuoteAnchor, type ReviewQuoteAnchor, type ReviewQuoteSource } from './quoteAnchors';
import type { ReviewComparisonPacket } from './types';
import type { ReviewClaimAlignment, ReviewPerformanceGraph, ReviewSemanticComparison } from './semanticTypes';
import { parseReviewAssessment, type ReviewAssessmentContract } from '../reviewAssessment';
import { bindReviewReferenceItems, parseReviewReferenceRubric } from '../reviewReferenceRubric';
import type { ReviewCriterionId } from '../reviewAssessment';

export type ReviewComparisonChannel = 'reference' | 'personal';
export const REVIEW_CHANNEL_LIMITS = { alignmentSlots: 256, edgeSlots: 128, inputCharacters: 90000,
  personalNodes: 24, personalEdges: 64 } as const;

/** Historical structure, not an answer graph or proof that the stored beliefs/edges are true. */
export interface ReviewPersonalGraphContext {
  version: 1;
  targetNodeId: string;
  truncated: boolean;
  nodes: { nodeId: string; sourceId: string; mainType: CognitionGraph['nodes'][number]['mainType'];
    stance: CognitionStance | 'unknown'; reviewNeeded: boolean }[];
  edges: CognitionGraph['edges'];
}
type ReviewAnchoredChannelDetails = {
  personalTarget?: { nodeId: string; purpose: NonNullable<ReviewComparisonPacket['questionIntent']['cognitionTarget']>['purpose'] };
  personalGraph?: ReviewPersonalGraphContext;
  knowledgeTargets?: string[];
  references?: { sourceId: string; title: string; truncated: boolean }[];
  assessment?: ReviewAssessmentContract;
  referenceRubric?: { version: 1; scope: 'question_items'; items: {
    itemId: string; criterionId: ReviewCriterionId; knowledgeTarget: string; sourceId: string; quoteId: string;
  }[] };
};

function personalGraphContext(packet: ReviewComparisonPacket): ReviewPersonalGraphContext {
  const graph = packet.personal.graph!;
  const targetNodeId = packet.questionIntent.cognitionTarget!.nodeId;
  const fail = (): never => { throw new Error('invalid_personal_graph'); };
  if (!Array.isArray(graph.nodes) || !graph.nodes.length || !Array.isArray(graph.edges)) return fail();
  if (graph.nodes.length > REVIEW_CHANNEL_LIMITS.personalNodes || graph.edges.length > REVIEW_CHANNEL_LIMITS.personalEdges) {
    throw new Error('anchor_budget_exceeded');
  }
  const reviewNeeded = packet.personal.reviewNeededNodeIds;
  if (reviewNeeded !== undefined && (!Array.isArray(reviewNeeded) || new Set(reviewNeeded).size !== reviewNeeded.length)) return fail();
  const validId = (id: unknown): id is string => typeof id === 'string' && !!id.trim() && id.length <= 200;
  const nodeIds = new Set<string>();
  const nodes = graph.nodes.map((node) => {
    if (!node || typeof node !== 'object') return fail();
    const stance: CognitionStance | 'unknown' = node.stance ?? packet.personal.stance ?? 'unknown';
    if (!validId(node.id) || nodeIds.has(node.id) || typeof node.text !== 'string' || !node.text.trim()
      || !ALL_ARGUMENT_TYPES.includes(node.mainType) || !['endorsed', 'tentative', 'unknown'].includes(stance)) return fail();
    nodeIds.add(node.id);
    return { nodeId: node.id, sourceId: `B:node:${node.id}`, mainType: node.mainType, stance,
      reviewNeeded: !!reviewNeeded?.includes(node.id) };
  });
  if (!nodeIds.has(targetNodeId) || reviewNeeded?.some((id) => !nodeIds.has(id))) return fail();
  const edgeIds = new Set<string>();
  const edges = graph.edges.map((edge) => {
    if (!edge || typeof edge !== 'object' || !validId(edge.id) || edgeIds.has(edge.id) || !nodeIds.has(edge.source) || !nodeIds.has(edge.target)
      || !['support', 'oppose'].includes(edge.relation)) return fail();
    edgeIds.add(edge.id);
    return { id: edge.id, source: edge.source, target: edge.target, relation: edge.relation };
  });
  // Do not reverse, repair or silently drop stored edges; text lives only in the bound B: sources.
  return { version: 1, targetNodeId, truncated: packet.personal.truncated, nodes, edges };
}
export function reviewAnchoredChannels(packet: ReviewComparisonPacket): ReviewComparisonChannel[] {
  const channels: ReviewComparisonChannel[] = [];
  if (packet.preparation.mastery === 'pending_alignment' && packet.references.length) channels.push('reference');
  if (packet.preparation.cognitionGrowth === 'pending_alignment' && packet.personal.status === 'ready'
    && packet.personal.graph?.nodes.some((n) => n.id === packet.questionIntent.cognitionTarget?.nodeId)) channels.push('personal');
  return channels;
}

/** Physical isolation: neither the reference payload nor its fingerprint contains personal data. */
export async function buildReviewAnchoredChannel(packetInput: ReviewComparisonPacket, graphInput: ReviewPerformanceGraph, channel: ReviewComparisonChannel) {
  const packet = structuredClone(packetInput), graph = readReviewPerformanceGraph(structuredClone(graphInput), packet);
  if (!reviewAnchoredChannels(packet).includes(channel)) throw new Error('review_channel_unavailable');
  const sources: ReviewQuoteSource[] = [{ id: 'U', kind: 'answer', text: packet.answer.text, truncated: false }];
  const node = channel === 'personal' ? packet.personal.graph!.nodes.find((n) => n.id === packet.questionIntent.cognitionTarget!.nodeId)! : undefined;
  const personalGraph = node ? personalGraphContext(packet) : undefined;
  if (node) {
    sources.push({ id: `B:node:${node.id}`, kind: 'personal_node', text: node.text, truncated: packet.personal.truncated });
    if (packet.personal.context) sources.push({ id: 'B:context', kind: 'personal_context', text: packet.personal.context, truncated: packet.personal.truncated });
    for (const neighbor of packet.personal.graph!.nodes.filter((n) => n.id !== node.id)) {
      sources.push({ id: `B:node:${neighbor.id}`, kind: 'personal_context', text: neighbor.text, truncated: packet.personal.truncated });
    }
  } else for (const source of packet.references) sources.push({ id: source.sourceId, kind: 'reference', text: source.text, truncated: source.truncated });
  const intervals = graph.claims.map((c) => ({ sourceId: 'U', start: c.start, end: c.end }));
  const rubric = node || !packet.questionIntent.referenceRubric ? undefined : parseReviewReferenceRubric(
    packet.questionIntent.referenceRubric, packet.questionIntent.assessment!, packet.questionIntent.knowledgeTargets);
  const referenceItems = rubric ? bindReviewReferenceItems(packet) : [];
  for (const item of referenceItems) intervals.push({ sourceId: item.sourceId, start: item.localStart, end: item.localEnd });
  // Exact matches in other originals are citation coordinates, not semantic matches. Preserve
  // every occurrence (including conclusions prefixed by 因此/所以); never synthesize a quote.
  for (const source of sources.filter((s) => s.id !== 'U')) for (const claim of graph.claims) {
    for (let start = source.text.indexOf(claim.quote); start >= 0; start = source.text.indexOf(claim.quote, start + 1)) {
      intervals.push({ sourceId: source.id, start, end: start + claim.quote.length });
    }
  }
  const anchors = buildReviewQuoteAnchors(sources, intervals);
  const claims = graph.claims.map((c) => ({ id: c.id, role: c.role,
    quoteId: anchors.find((a) => a.sourceId === 'U' && a.start === c.start && a.end === c.end)!.id }));
  const pairs: Array<{ pairId: string; claimId: string; targetId: string; knowledgeTarget?: string;
    leftSourceIds: string[]; rightSourceIds: string[]; targetQuoteSourceId: string }> = [];
  for (const claim of graph.claims) {
    if (node) pairs.push({ pairId: `P${pairs.length + 1}`, claimId: claim.id, targetId: node.id,
      leftSourceIds: sources.filter((s) => s.id !== 'U').map((s) => s.id), rightSourceIds: ['U'], targetQuoteSourceId: `B:node:${node.id}` });
    else for (const source of packet.references) for (const knowledgeTarget of packet.questionIntent.knowledgeTargets) {
      pairs.push({ pairId: `P${pairs.length + 1}`, claimId: claim.id, targetId: source.sourceId, knowledgeTarget,
        leftSourceIds: ['U'], rightSourceIds: [source.sourceId], targetQuoteSourceId: source.sourceId });
    }
  }
  const edgeSlots = node ? [] : graph.edges.flatMap((e) => packet.references.flatMap((s) => packet.questionIntent.knowledgeTargets.map((knowledgeTarget) =>
    ({ slotId: '', edgeId: e.id, sourceId: s.sourceId, knowledgeTarget })))).map((e, index) => ({ ...e, slotId: `T${index + 1}` }));
  const linkSlots = node ? graph.claims.map((c, index) => ({ slotId: `L${index + 1}`, claimId: c.id, targetNodeId: node.id })) : [];
  if (pairs.length > REVIEW_CHANNEL_LIMITS.alignmentSlots || edgeSlots.length > REVIEW_CHANNEL_LIMITS.edgeSlots) throw new Error('anchor_budget_exceeded');
  const channelDetails: ReviewAnchoredChannelDetails = node
    ? { personalTarget: { nodeId: node.id, purpose: packet.questionIntent.cognitionTarget!.purpose }, personalGraph }
    : { knowledgeTargets: packet.questionIntent.knowledgeTargets,
      ...(packet.questionIntent.assessment !== undefined ? {
        assessment: parseReviewAssessment(packet.questionIntent.assessment, packet.questionIntent.knowledgeTargets),
      } : {}),
      ...(rubric ? { referenceRubric: { version: 1 as const, scope: 'question_items' as const, items: referenceItems.map((item) => ({
        itemId: item.itemId, criterionId: item.criterionId, knowledgeTarget: item.knowledgeTarget, sourceId: item.sourceId,
        quoteId: anchors.find((a) => a.sourceId === item.sourceId && a.start === item.localStart && a.end === item.localEnd)!.id,
      })) } } : {}),
      references: packet.references.map((s) => ({ sourceId: s.sourceId, title: s.title, truncated: s.truncated })) };
  const visible = {
    version: 3 as const, channel, sources, anchors, graph: { claims,
      edges: graph.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, relation: e.relation, quote: e.quote })) }, pairs, edgeSlots, linkSlots,
    ...channelDetails,
  };
  // Bind channel-local source versions privately without exposing the other channel or question text.
  const authority = node ? { target: packet.questionIntent.cognitionTarget, branchHash: packet.personal.branchHash }
    : packet.references.map((s) => ({ sourceId: s.sourceId, entityId: s.entityId, contentHash: s.contentHash, version: s.version }));
  const bindingId = `review-anchors-v3:${await reviewSnapshotHash({ visible, authority,
    ...(rubric ? { referenceRubricAuthority: rubric } : {}) })}`;
  const result = { ...visible, bindingId };
  if (JSON.stringify(result).length > REVIEW_CHANNEL_LIMITS.inputCharacters) throw new Error('anchor_budget_exceeded');
  return result;
}
export type ReviewAnchoredInput = Awaited<ReturnType<typeof buildReviewAnchoredChannel>>;

const fail = (code = 'invalid_anchored_format'): never => { throw new Error(code); };
function object(value: unknown, fields: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const item = value as Record<string, unknown>;
  if (fields.some((key) => !Object.hasOwn(item, key)) || Object.keys(item).some((key) => !fields.includes(key) && !optional.includes(key))) return fail();
  return item;
}
function list(value: unknown, max: number): unknown[] { if (!Array.isArray(value) || value.length > max) return fail(); return value; }
function choice<T extends string>(value: unknown, choices: readonly T[]): T { if (!choices.includes(value as T)) return fail(); return value as T; }
function description(value: unknown, max: number): string { if (typeof value !== 'string' || !value.trim() || value.length > max) return fail(); return value; }
function confidence(value: unknown): number { if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) return fail(); return value; }

/** No free quote text or offsets accepted. Resolve all quotations from bound, source-local IDs. */
export async function readReviewAnchoredComparison(raw: unknown, packetInput: ReviewComparisonPacket, graphInput: ReviewPerformanceGraph, channel: ReviewComparisonChannel): Promise<ReviewSemanticComparison> {
  const packet = structuredClone(packetInput), graph = readReviewPerformanceGraph(structuredClone(graphInput), packet);
  const input = await buildReviewAnchoredChannel(packet, graph, channel);
  const root = object(raw, ['version', 'channel', 'bindingId', 'alignments', ...(channel === 'reference' ? ['referenceAudit', 'edgeChecks',
    ...(input.referenceRubric ? ['criterionChecks'] : [])] : ['personalLinks'])]);
  if (root.version !== 3 || root.channel !== channel || root.bindingId !== input.bindingId) return fail('wrong_anchored_binding');
  const seen = new Set<string>();
  const slot = <T extends { pairId?: string; slotId?: string }>(id: unknown, values: T[], key: 'pairId' | 'slotId'): T => {
    const value = values.find((v) => v[key] === id);
    if (!value) return fail('unknown_anchored_slot');
    if (seen.has(id as string)) return fail('duplicate_anchored_slot');
    seen.add(id as string); return value;
  };
  const quote = (id: unknown, sourceIds: string[], max: number, within?: ReviewQuoteAnchor) => readReviewQuoteAnchor(id, input.anchors, sourceIds, max, within);
  const alignments = list(root.alignments, 36).map((value) => {
    const item = object(value, ['pairId', 'targetQuoteId', 'relation', 'confidence', 'sourcesCompatible', 'axes'], ['relationBasis']);
    const pair = slot(item.pairId, input.pairs, 'pairId');
    const claim = graph.claims.find((c) => c.id === pair.claimId)!;
    const main = quote(input.graph.claims.find((c) => c.id === claim.id)!.quoteId, ['U'], 600);
    const target = quote(item.targetQuoteId, [pair.targetQuoteSourceId], 600);
    if (typeof item.sourcesCompatible !== 'boolean') return fail();
    const axisValues = object(item.axes, [...ALIGNMENT_AXES]);
    const axes = Object.fromEntries(ALIGNMENT_AXES.map((name) => {
      const axis = object(axisValues[name], ['status', 'leftQuoteId', 'rightQuoteId', 'reason']);
      const status = name === 'metric' ? choice(axis.status, ['same_dimension', 'different_dimension', 'unknown', 'not_applicable'] as const)
        : choice(axis.status, ['same', 'different', 'unknown', 'not_applicable'] as const);
      const absent = status === 'unknown' || status === 'not_applicable';
      if (absent && (axis.leftQuoteId !== null || axis.rightQuoteId !== null)) return fail();
      return [name, { status: status === 'same_dimension' ? 'same' : status === 'different_dimension' ? 'different' : status,
        personalQuote: absent ? '' : quote(axis.leftQuoteId, pair.leftSourceIds, 200).text,
        documentQuote: absent ? '' : quote(axis.rightQuoteId, pair.rightSourceIds, 200).text, reason: description(axis.reason, 160) }];
    })) as ReviewClaimAlignment['axes'];
    const basis = item.relationBasis === undefined ? undefined : object(item.relationBasis, ['kind', 'leftQuoteId', 'rightQuoteId', 'explanation']);
    const leftMain = channel === 'personal' ? target : main, rightMain = channel === 'personal' ? main : target;
    return { claimId: claim.id, corpus: channel, targetId: pair.targetId,
      ...(channel === 'reference' ? { knowledgeTarget: pair.knowledgeTarget } : {}), relation: choice(item.relation, COMPARISON_RELATIONS),
      personalQuote: leftMain.text, documentQuote: rightMain.text, confidence: confidence(item.confidence), sourcesCompatible: item.sourcesCompatible, axes,
      ...(basis ? { relationBasis: { kind: choice(basis.kind, ['observed_counterexample', 'incompatible_facts', 'evidence_limit', 'unknown'] as const),
        personalQuote: quote(basis.leftQuoteId, [leftMain.sourceId], 300, leftMain).text,
        documentQuote: quote(basis.rightQuoteId, [rightMain.sourceId], 300, rightMain).text, explanation: description(basis.explanation, 200) } } : {}) };
  });
  const edgeChecks = channel !== 'reference' ? [] : list(root.edgeChecks, 16).map((value) => {
    const item = object(value, ['slotId', 'referenceQuoteId', 'relation', 'verdict', 'direction', 'basis', 'conclusion', 'premiseStatus', 'confidence']);
    const pair = slot(item.slotId, input.edgeSlots, 'slotId'), edge = graph.edges.find((e) => e.id === pair.edgeId)!;
    return { edgeId: edge.id, sourceId: pair.sourceId, knowledgeTarget: pair.knowledgeTarget,
      referenceQuote: quote(item.referenceQuoteId, [pair.sourceId], 600).text, relation: choice(item.relation, ['support', 'oppose'] as const),
      verdict: choice(item.verdict, ['supported', 'contradicted', 'unverifiable'] as const),
      direction: choice(item.direction, ['source_to_target', 'target_to_source', 'undetermined'] as const),
      basisClaimId: edge[choice(item.basis, ['source', 'target'] as const)], conclusionClaimId: edge[choice(item.conclusion, ['source', 'target'] as const)],
      premiseStatus: choice(item.premiseStatus, ['sufficient', 'missing'] as const), confidence: confidence(item.confidence) };
  });
  const personalLinks = channel !== 'personal' ? [] : list(root.personalLinks, 12).map((value) => {
    const item = object(value, ['slotId', 'answerQuoteId', 'personalQuoteId', 'relation', 'direction', 'basis', 'conclusion', 'premiseStatus', 'confidence']);
    const pair = slot(item.slotId, input.linkSlots, 'slotId');
    const main = quote(input.graph.claims.find((c) => c.id === pair.claimId)!.quoteId, ['U'], 600);
    return { claimId: pair.claimId, targetNodeId: pair.targetNodeId, answerQuote: quote(item.answerQuoteId, ['U'], 600, main).text,
      personalQuote: quote(item.personalQuoteId, [`B:node:${pair.targetNodeId}`], 600).text,
      relation: choice(item.relation, ['support', 'oppose'] as const), direction: choice(item.direction, ['answer_to_personal', 'personal_to_answer', 'undetermined'] as const),
      basis: choice(item.basis, ['answer', 'personal'] as const), conclusion: choice(item.conclusion, ['answer', 'personal'] as const),
      premiseStatus: choice(item.premiseStatus, ['sufficient', 'missing'] as const), confidence: confidence(item.confidence) };
  });
  const rubricChecks = !input.referenceRubric ? undefined : list(root.criterionChecks, 12).map((value) => {
    const check = object(value, ['itemId', 'verdict', 'pairIds', 'edgeSlotIds', 'confidence']);
    const item = input.referenceRubric!.items.find((item) => item.itemId === check.itemId);
    if (!item) return fail('invalid_rubric_check');
    const within = input.anchors.find((a) => a.id === item.quoteId)!;
    const claimIds = list(check.pairIds, 12).map((id) => {
      // These are references to returned records, not another occurrence of those records.
      const pair = input.pairs.find((pair) => pair.pairId === id);
      const alignment = list(root.alignments, 36).find((raw) => (raw as Record<string, unknown>)?.pairId === id) as Record<string, unknown> | undefined;
      if (!pair || pair.targetId !== item.sourceId || pair.knowledgeTarget !== item.knowledgeTarget || !alignment) return fail('invalid_rubric_check');
      quote(alignment.targetQuoteId, [item.sourceId], 320, within);
      return pair.claimId;
    });
    const edgeIds = list(check.edgeSlotIds, 16).map((id) => {
      const edge = input.edgeSlots.find((edge) => edge.slotId === id);
      const verified = list(root.edgeChecks, 16).find((raw) => (raw as Record<string, unknown>)?.slotId === id) as Record<string, unknown> | undefined;
      if (!edge || edge.sourceId !== item.sourceId || edge.knowledgeTarget !== item.knowledgeTarget || !verified) return fail('invalid_rubric_check');
      quote(verified.referenceQuoteId, [item.sourceId], 320, within);
      return edge.edgeId;
    });
    return { itemId: item.itemId, verdict: choice(check.verdict, ['covered', 'contradicted', 'unobserved'] as const),
      claimIds, edgeIds, confidence: confidence(check.confidence) };
  });
  const audit = channel === 'reference' ? object(root.referenceAudit, ['status', 'sourceIds']) : undefined;
  return readReviewSemanticComparison({ version: 1, packetId: packet.packetId,
    referenceAudit: audit ? { status: choice(audit.status, ['compatible', 'conflict', 'unknown'] as const), sourceIds: list(audit.sourceIds, 7) }
      : { status: 'unknown', sourceIds: packet.references.map((s) => s.sourceId) }, alignments, edgeChecks, personalLinks,
    ...(rubricChecks ? { rubricChecks } : {}) }, packet, graph, channel === 'personal');
}
