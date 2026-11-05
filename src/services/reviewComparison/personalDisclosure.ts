import type { CognitionFile, CognitionGraph, CognitionStance } from '../cognition/types.ts';
import { ALL_ARGUMENT_TYPES } from '../argumentDoc/types.ts';
import { parseReviewQuestionIntent } from '../reviewIntentValidation.ts';
import type { ReviewCognitionTarget } from '../reviewIntent.ts';
import { reviewSnapshotHash, resolveReviewPersonalSnapshot } from './packet.ts';
import { readReviewPerformanceGraph } from './performanceGraph.ts';
import type { ReviewComparisonPacket } from './types.ts';
import type { ReviewPerformanceGraph } from './semanticTypes.ts';

export const REVIEW_PERSONAL_DISCLOSURE_LIMITS = { nodes: 24, edges: 64, quotes: 96,
  sourceCharacters: 24000, inputCharacters: 24000 } as const;
export type ReviewPersonalDisclosureBudget = { [K in keyof typeof REVIEW_PERSONAL_DISCLOSURE_LIMITS]: number };
export type ReviewPersonalDisclosureReason = 'packet_changed' | 'personal_unavailable' | 'no_cognition_target'
  | 'stale_target' | 'target_missing' | 'personal_snapshot_changed' | 'incomplete_personal_context'
  | 'personal_growth_held' | 'invalid_personal_graph' | 'invalid_performance_graph' | 'missing_stored_endpoint'
  | 'disclosure_budget_exceeded' | 'invalid_disclosure_budget' | 'authority_changed';
export interface ReviewPersonalDisclosureDependencies {
  /** Trusted read-only current cognition authority; never a search or a reference/profile loader. */
  loadCognition(): Promise<CognitionFile>;
}
export interface ReviewPersonalDisclosureQuote { quoteId: string; sourceId: string; start: number; end: number; text: string }
export interface ReviewPersonalDisclosureInput {
  version: 1;
  protocol: 'review-personal-disclosure-v1';
  channel: 'personal';
  bindingId: string;
  legacy_relation_scope: 'structural_closure_only';
  target: { nodeId: string; purpose: ReviewCognitionTarget['purpose']; quoteId: string };
  sources: { sourceId: string; kind: 'answer' | 'personal_node' | 'personal_context'; length: number; bodyQuoteId: string }[];
  quotes: ReviewPersonalDisclosureQuote[];
  graph: { claims: { id: string; role: ReviewPerformanceGraph['claims'][number]['role']; quoteId: string }[];
    edges: { id: string; source: string; target: string; relation: 'support' | 'oppose'; quoteId: string }[] };
  personal: { contextQuoteId: string | null;
    nodes: { nodeId: string; sourceId: string; mainType: CognitionGraph['nodes'][number]['mainType'];
      stance: CognitionStance | 'unknown'; reviewNeeded: boolean; quoteId: string }[];
    edges: CognitionGraph['edges'];
    closure: { policy: 'incoming-ancestors-and-direct-target-conclusions-v1'; omittedNodeCount: number; omittedEdgeCount: number } };
  assistance: { hintLevel: ReviewComparisonPacket['answer']['hintLevel']; consultedMaterialCount: number };
  safeguards: { stage: 'pending_proposal_only'; writes: 'disabled'; storedRelationTruth: 'not_certified';
    necessaryConditionCompleteness: 'not_certified'; purposeCreatesRelation: false; newNodesOrRelations: 'not_generated' };
}
/** PRIVATE audit binding. Do not serialize it into model input or interpret its hash as authority. */
export interface ReviewPersonalDisclosureAuthority {
  version: 1; protocol: 'review-personal-disclosure-v1'; bindingId: string;
  packetId: string; snapshotHash: string; target: ReviewCognitionTarget; branchHash: string;
  personalSnapshotHash: string; performanceGraphHash: string; disclosedNodeIds: string[]; disclosedEdgeIds: string[];
  budget: ReviewPersonalDisclosureBudget; legacy_relation_scope: 'structural_closure_only';
}
export type ReviewPersonalDisclosureResult = { status: 'ready'; input: ReviewPersonalDisclosureInput; authority: ReviewPersonalDisclosureAuthority }
  | { status: 'held'; reasonCode: ReviewPersonalDisclosureReason };
const fail = (code: ReviewPersonalDisclosureReason): never => { throw new Error(`personal_disclosure_${code}`); };
const HASH = /^[a-f0-9]{64}$/u;
const reason = (error: unknown): ReviewPersonalDisclosureReason => {
  const value = error instanceof Error ? error.message : '';
  return value.startsWith('personal_disclosure_') ? value.slice('personal_disclosure_'.length) as ReviewPersonalDisclosureReason : 'personal_unavailable';
};
function budgetOf(value?: Partial<ReviewPersonalDisclosureBudget>): ReviewPersonalDisclosureBudget {
  if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !Object.hasOwn(REVIEW_PERSONAL_DISCLOSURE_LIMITS, key)))) fail('invalid_disclosure_budget');
  const budget = { ...REVIEW_PERSONAL_DISCLOSURE_LIMITS, ...value };
  for (const key of Object.keys(REVIEW_PERSONAL_DISCLOSURE_LIMITS) as (keyof ReviewPersonalDisclosureBudget)[]) {
    if (!Number.isSafeInteger(budget[key]) || budget[key] < 1 || budget[key] > REVIEW_PERSONAL_DISCLOSURE_LIMITS[key]) fail('invalid_disclosure_budget');
  }
  return budget;
}
function validId(value: unknown): value is string { return typeof value === 'string' && !!value.trim() && value.length <= 200; }
function validatePersonalGraph(packet: ReviewComparisonPacket): CognitionGraph {
  const graph = packet.personal.graph;
  if (!graph || !Array.isArray(graph.nodes) || !graph.nodes.length || !Array.isArray(graph.edges)) return fail('invalid_personal_graph');
  if (packet.personal.stance !== undefined && !['endorsed', 'tentative'].includes(packet.personal.stance)) fail('invalid_personal_graph');
  if (graph.nodes.length > 24 || graph.edges.length > 64) fail('disclosure_budget_exceeded');
  const ids = new Set<string>(), edgeIds = new Set<string>();
  for (const node of graph.nodes) {
    if (!node || !validId(node.id) || ids.has(node.id) || typeof node.text !== 'string' || !node.text.trim()
      || !ALL_ARGUMENT_TYPES.includes(node.mainType) || node.stance !== undefined && !['endorsed', 'tentative'].includes(node.stance)) fail('invalid_personal_graph');
    ids.add(node.id);
  }
  for (const edge of graph.edges) {
    if (!edge || !validId(edge.id) || edgeIds.has(edge.id) || !validId(edge.source) || !validId(edge.target)
      || !['support', 'oppose'].includes(edge.relation)) fail('invalid_personal_graph');
    if (!ids.has(edge.source) || !ids.has(edge.target)) fail('missing_stored_endpoint');
    edgeIds.add(edge.id);
  }
  const reviewNeeded = packet.personal.reviewNeededNodeIds;
  if (reviewNeeded !== undefined && (!Array.isArray(reviewNeeded) || new Set(reviewNeeded).size !== reviewNeeded.length
    || reviewNeeded.some(id => !ids.has(id)))) fail('invalid_personal_graph');
  return graph;
}
function storedClosure(graph: CognitionGraph, targetId: string, budget: ReviewPersonalDisclosureBudget) {
  const incoming = new Map<string, string[]>();
  for (const edge of graph.edges) incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge.source]);
  const required = new Set([targetId, ...graph.edges.filter(edge => edge.source === targetId).map(edge => edge.target)]);
  const queue = [...required];
  for (let index = 0; index < queue.length; index++) for (const source of incoming.get(queue[index]) ?? []) {
    if (!required.has(source)) { required.add(source); queue.push(source); }
  }
  if (required.size > budget.nodes) fail('disclosure_budget_exceeded');
  const nodes = graph.nodes.filter(node => required.has(node.id));
  if (nodes.length !== required.size) fail('missing_stored_endpoint');
  const edges = graph.edges.filter(edge => required.has(edge.source) && required.has(edge.target));
  if (edges.length > budget.edges) fail('disclosure_budget_exceeded');
  return { nodes, edges, omittedNodeCount: graph.nodes.length - nodes.length, omittedEdgeCount: graph.edges.length - edges.length };
}
async function frozenPacket(packet: ReviewComparisonPacket): Promise<void> {
  const { packetId, snapshotHash, ...body } = packet;
  if (!HASH.test(snapshotHash) || await reviewSnapshotHash(body) !== snapshotHash || packetId !== `review-comparison:${snapshotHash}`) fail('packet_changed');
  const intent = parseReviewQuestionIntent(packet.questionIntent);
  if (JSON.stringify(intent) !== JSON.stringify(packet.questionIntent)) fail('packet_changed');
  if (!intent.cognitionTarget) fail('no_cognition_target');
  if (packet.personal.status === 'stale_target') fail('stale_target');
  if (packet.personal.status === 'target_missing') fail('target_missing');
  if (packet.personal.status !== 'ready') fail('personal_unavailable');
  if (packet.personal.truncated !== false) fail('incomplete_personal_context');
  if (packet.preparation.cognitionGrowth !== 'pending_alignment') fail('personal_growth_held');
  if (intent.cognitionTarget.purpose === 'connect_nodes') fail('personal_growth_held'); // One frozen coordinate cannot authorize a two-target proposal.
  if (!HASH.test(packet.personal.branchHash ?? '') || typeof packet.personal.context !== 'string') fail('invalid_personal_graph');
  if (!packet.personal.graph?.nodes.some(node => node.id === intent.cognitionTarget!.nodeId)) fail('target_missing');
}
async function currentPersonal(packet: ReviewComparisonPacket, dependencies: ReviewPersonalDisclosureDependencies): Promise<void> {
  if (!dependencies || typeof dependencies.loadCognition !== 'function') fail('personal_unavailable');
  const file = structuredClone(await dependencies.loadCognition());
  const target = packet.questionIntent.cognitionTarget!;
  if (!file || file.schemaVersion !== 1 || !Number.isSafeInteger(file.revision) || file.revision < 0 || !Array.isArray(file.records)) fail('personal_unavailable');
  const records = file.records.filter(record => record?.id === target.recordId);
  if (records.length !== 1) fail('target_missing');
  const revisions = records[0].revisions;
  if (!Array.isArray(revisions) || !revisions.length || revisions.filter(revision => revision?.id === target.revisionId).length !== 1) fail('stale_target');
  const latest = revisions.at(-1)!;
  if (latest.id !== target.revisionId) fail('stale_target');
  if (!Array.isArray(latest.branches) || latest.branches.filter(branch => branch?.id === target.branchId).length !== 1) fail('target_missing');
  const current = await resolveReviewPersonalSnapshot(file, packet.questionIntent);
  if (current.status !== 'ready' || current.branchHash !== packet.personal.branchHash
    || await reviewSnapshotHash(current) !== await reviewSnapshotHash(packet.personal)) fail('personal_snapshot_changed');
}

/**
 * Read-only assembly after one answer extraction. Exact stored structural closure only:
 * legacy support/oppose edges contain no certified necessary-set/condition annotations.
 * This function does not evaluate semantics, search, generate proposals, invoke a model or write.
 * A caller MUST still verify current authority after later model work and before confirmation.
 */
export async function buildReviewPersonalDisclosure(packetValue: ReviewComparisonPacket, graphValue: ReviewPerformanceGraph,
  dependencies: ReviewPersonalDisclosureDependencies, requestedBudget?: Partial<ReviewPersonalDisclosureBudget>): Promise<ReviewPersonalDisclosureResult> {
  try {
    // Freeze both caller-owned inputs before the first asynchronous read/hash.
    const packet = structuredClone(packetValue), suppliedGraph = structuredClone(graphValue), budget = budgetOf(structuredClone(requestedBudget));
    await frozenPacket(packet);
    const personalGraph = validatePersonalGraph(packet), target = packet.questionIntent.cognitionTarget!;
    let graph: ReviewPerformanceGraph;
    try { graph = readReviewPerformanceGraph(suppliedGraph, packet); } catch { return { status: 'held', reasonCode: 'invalid_performance_graph' }; }
    if (!graph.claims.length) fail('invalid_performance_graph');
    await currentPersonal(packet, dependencies);
    const closure = storedClosure(personalGraph, target.nodeId, budget);
    const quotes: ReviewPersonalDisclosureQuote[] = [], sources: ReviewPersonalDisclosureInput['sources'] = [];
    const bodies = new Map<string, string>(), existing = new Map<string, string>();
    let sourceCharacters = 0;
    const quote = (sourceId: string, start: number, end: number): string => {
      const body = bodies.get(sourceId);
      if (body === undefined || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > body.length
        || /[\uD800-\uDBFF]/u.test(body[start - 1] ?? '') && /[\uDC00-\uDFFF]/u.test(body[start] ?? '')
        || /[\uD800-\uDBFF]/u.test(body[end - 1] ?? '') && /[\uDC00-\uDFFF]/u.test(body[end] ?? '')) fail('invalid_performance_graph');
      const key = JSON.stringify([sourceId, start, end]), prior = existing.get(key);
      if (prior) return prior;
      if (quotes.length >= budget.quotes) fail('disclosure_budget_exceeded');
      const quoteId = `Q${quotes.length + 1}`;
      quotes.push({ quoteId, sourceId, start, end, text: body.slice(start, end) }); existing.set(key, quoteId); return quoteId;
    };
    const source = (sourceId: string, kind: ReviewPersonalDisclosureInput['sources'][number]['kind'], body: string) => {
      if (!body.trim() || bodies.has(sourceId)) fail('invalid_personal_graph');
      sourceCharacters += body.length;
      if (sourceCharacters > budget.sourceCharacters) fail('disclosure_budget_exceeded');
      bodies.set(sourceId, body); const bodyQuoteId = quote(sourceId, 0, body.length);
      sources.push({ sourceId, kind, length: body.length, bodyQuoteId }); return bodyQuoteId;
    };
    source('U', 'answer', packet.answer.text);
    const contextQuoteId = packet.personal.context!.trim() ? source('B:context', 'personal_context', packet.personal.context!) : null;
    const nodes = closure.nodes.map((node): ReviewPersonalDisclosureInput['personal']['nodes'][number] => ({ nodeId: node.id, sourceId: `B:node:${node.id}`, mainType: node.mainType,
      stance: node.stance ?? packet.personal.stance ?? 'unknown', reviewNeeded: !!packet.personal.reviewNeededNodeIds?.includes(node.id),
      quoteId: source(`B:node:${node.id}`, 'personal_node', node.text) }));
    const visible: Omit<ReviewPersonalDisclosureInput, 'bindingId'> = { version: 1, protocol: 'review-personal-disclosure-v1', channel: 'personal',
      legacy_relation_scope: 'structural_closure_only', target: { nodeId: target.nodeId, purpose: target.purpose,
        quoteId: nodes.find(node => node.nodeId === target.nodeId)!.quoteId }, sources, quotes,
      graph: { claims: graph.claims.map(claim => ({ id: claim.id, role: claim.role, quoteId: quote('U', claim.start, claim.end) })),
        edges: graph.edges.map(edge => ({ id: edge.id, source: edge.source, target: edge.target, relation: edge.relation,
          quoteId: quote('U', edge.start, edge.end) })) },
      personal: { contextQuoteId, nodes, edges: structuredClone(closure.edges), closure: {
        policy: 'incoming-ancestors-and-direct-target-conclusions-v1', omittedNodeCount: closure.omittedNodeCount, omittedEdgeCount: closure.omittedEdgeCount } },
      assistance: { hintLevel: packet.answer.hintLevel, consultedMaterialCount: packet.answer.consultedMaterialIds.length },
      safeguards: { stage: 'pending_proposal_only', writes: 'disabled', storedRelationTruth: 'not_certified',
        necessaryConditionCompleteness: 'not_certified', purposeCreatesRelation: false, newNodesOrRelations: 'not_generated' } };
    const bindingId = `review-personal-disclosure-v1:${await reviewSnapshotHash({ visible, target, branchHash: packet.personal.branchHash })}`;
    const input = { ...visible, bindingId };
    if (JSON.stringify(input).length > budget.inputCharacters) fail('disclosure_budget_exceeded');
    // Catch observed target changes during local hashing/assembly too. No reference reads.
    await currentPersonal(packet, dependencies);
    return { status: 'ready', input, authority: { version: 1, protocol: 'review-personal-disclosure-v1', bindingId,
      packetId: packet.packetId, snapshotHash: packet.snapshotHash, target: structuredClone(target), branchHash: packet.personal.branchHash!,
      personalSnapshotHash: await reviewSnapshotHash(packet.personal), performanceGraphHash: await reviewSnapshotHash(graph),
      disclosedNodeIds: nodes.map(node => node.nodeId), disclosedEdgeIds: closure.edges.map(edge => edge.id), budget,
      legacy_relation_scope: 'structural_closure_only' } };
  } catch (error) { return { status: 'held', reasonCode: reason(error) }; }
}

/** Rebuild only the same frozen personal disclosure; never substitute a newer target or expand reads. */
export async function verifyReviewPersonalDisclosureFreshness(packet: ReviewComparisonPacket, graph: ReviewPerformanceGraph,
  authority: ReviewPersonalDisclosureAuthority, dependencies: ReviewPersonalDisclosureDependencies): Promise<{ fresh: boolean; reasons: ReviewPersonalDisclosureReason[] }> {
  try {
    const captured = structuredClone(authority);
    if (!captured || captured.version !== 1 || captured.protocol !== 'review-personal-disclosure-v1'
      || captured.legacy_relation_scope !== 'structural_closure_only') return { fresh: false, reasons: ['authority_changed'] };
    const rebuilt = await buildReviewPersonalDisclosure(packet, graph, dependencies, captured.budget);
    if (rebuilt.status === 'held') return { fresh: false, reasons: [rebuilt.reasonCode] };
    if (await reviewSnapshotHash(rebuilt.authority) !== await reviewSnapshotHash(captured)) return { fresh: false, reasons: ['authority_changed'] };
    return { fresh: true, reasons: [] };
  } catch { return { fresh: false, reasons: ['authority_changed'] }; }
}
