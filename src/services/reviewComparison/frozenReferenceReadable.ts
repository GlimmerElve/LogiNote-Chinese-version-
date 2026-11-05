import { REVIEW_ASSESSMENT_CRITERIA, type ReviewCriterionId } from '../reviewAssessment';
import type { FrozenReferenceShadowInput, FrozenReferenceItemObservation } from './frozenReferenceShadow';

export const FROZEN_REFERENCE_READABLE_INPUT_LIMIT = 60000;
export const readableUserId = (id: string) => `user/${encodeURIComponent(id)}`;
export function readableReferenceId(frame: string, kind?: 'item' | 'node' | 'relation' | 'group', id?: string) {
  return `reference/${encodeURIComponent(frame)}${kind ? `/${kind}/${encodeURIComponent(id!)}` : ''}`;
}
const fail = (code = 'invalid_readable_context'): never => { throw new Error(code); };
function closed(raw: unknown, keys: string[], code = 'invalid_readable_output'): Record<string, any> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || Object.keys(raw).sort().join('|') !== [...keys].sort().join('|')) return fail(code);
  return raw as Record<string, any>;
}
function dense(raw: unknown, maximum: number, code = 'invalid_readable_evidence'): any[] {
  if (!Array.isArray(raw) || raw.length > maximum || Object.keys(raw).length !== raw.length
    || Object.keys(raw).some((key, index) => key !== String(index))) return fail(code);
  return raw;
}
function unique<T>(values: T[], key: (value: T) => unknown) {
  if (new Set(values.map(key)).size !== values.length) fail();
  return values;
}
function span(text: string, start: number, end: number) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > text.length) return fail();
  const quote = text.slice(start, end);
  if (!quote.trim() || /[\uDC00-\uDFFF]/u.test(text[start]) || /[\uD800-\uDBFF]/u.test(text[end - 1])) return fail();
  return quote;
}

/** Model view only. Original source coordinates/contract stay with the host. */
export interface FrozenReferenceReadableInput {
  version: 2; protocol: 'review-frozen-reference-readable-v2'; evaluationId: string; contractHash: string;
  taskContext: { questionText: string; usage: 'question_context_only'; taskType: string };
  user: { answerText: string;
    claims: { id: string; role: string; text: string }[];
    edges: { id: string; source: string; target: string; relation: 'support' | 'oppose'; text: string }[] };
  frames: { frameId: string; knowledgeTarget: string; source: FrozenReferenceShadowInput['reference']['frames'][number]['source'];
    items: { itemId: string; criterionId: string; criterionDescription: string; referenceText: string;
      requiredNodeIds: string[]; requiredRelationIds: string[] }[];
    nodes: { id: string; role: string; evidence: { quoteId: string; text: string }[] }[];
    relations: { id: string; source: string; target: string; kind: string; evidence: { quoteId: string; text: string }[] }[];
    groups: { id: string; conclusionNodeId: string; premiseNodeIds: string[]; conditionNodeIds: string[];
      relationIds: string[]; operator: 'all' | 'any' }[] }[];
}

/**
 * Deterministic read projection, NOT a new retrieval or authority grant. Never
 * infers a user claim, relation, condition or score from a question/reference.
 * Keeping small literal excerpts beside IDs is deliberate: deduplication must
 * not require a language model to calculate UTF-16 slices or join three tables.
 */
export function buildFrozenReferenceReadableInput(original: FrozenReferenceShadowInput): FrozenReferenceReadableInput {
  const input = structuredClone(original), reference = input.reference;
  if (input.version !== 1 || input.protocol !== 'review-frozen-reference-shadow-v1'
    || input.taskContext?.usage !== 'question_context_only' || typeof input.taskContext.questionText !== 'string'
    || !input.taskContext.questionText.trim() || input.taskContext.questionText.length > 4000
    || typeof input.answer.text !== 'string' || input.answer.text.length > 20000
    || reference.protocol !== 'review-frozen-reference-context-v1' || reference.coverage !== 'complete_required') fail();
  const claims = unique(dense(input.graph.claims, 12), claim => claim.id);
  const edges = unique(dense(input.graph.edges, 16), edge => edge.id);
  const claimMap = new Map(claims.map(claim => [claim.id, claim]));
  const quotes = unique(dense(reference.quotes, 256), quote => quote.quoteId);
  const quoteMap = new Map(quotes.map(quote => [quote.quoteId, quote]));
  const getQuote = (id: string) => {
    const quote = quoteMap.get(id);
    if (!quote || typeof quote.text !== 'string' || !quote.text.trim()
      || !Number.isSafeInteger(quote.start) || !Number.isSafeInteger(quote.end)
      || quote.start < 0 || quote.end - quote.start !== quote.text.length) return fail();
    return { quoteId: id, text: quote.text };
  };
  const evidence = (ids: string[]) => {
    if (!ids.length) return fail();
    return unique(dense(ids, 256), id => id).map(getQuote);
  };
  const frames = unique(dense(reference.frames, 20), frame => frame.frameId).map(frame => {
    const nodeIds = new Set(unique(dense(frame.nodes, 64), node => node.id).map(node => node.id));
    const relationIds = new Set(unique(dense(frame.relations, 128), edge => edge.id).map(edge => edge.id));
    const node = (id: string) => nodeIds.has(id) ? readableReferenceId(frame.frameId, 'node', id) : fail();
    const relation = (id: string) => relationIds.has(id) ? readableReferenceId(frame.frameId, 'relation', id) : fail();
    return { frameId: readableReferenceId(frame.frameId), knowledgeTarget: frame.knowledgeTarget, source: structuredClone(frame.source),
      items: unique(dense(frame.items, 60), item => item.itemId).map(item => {
        if (!Object.hasOwn(REVIEW_ASSESSMENT_CRITERIA, item.criterionId)) return fail();
        return { itemId: readableReferenceId(frame.frameId, 'item', item.itemId), criterionId: item.criterionId,
          criterionDescription: REVIEW_ASSESSMENT_CRITERIA[item.criterionId as ReviewCriterionId], referenceText: getQuote(item.quoteId).text,
          requiredNodeIds: item.nodeIds.map(node), requiredRelationIds: item.relationIds.map(relation) };
      }),
      nodes: frame.nodes.map(value => ({ id: node(value.id), role: value.role, evidence: evidence(value.quoteIds) })),
      relations: frame.relations.map(edge => ({ id: relation(edge.id), source: node(edge.sourceNodeId), target: node(edge.targetNodeId),
        kind: edge.kind, evidence: evidence(edge.quoteIds) })),
      groups: unique(dense(frame.groups, 64), group => group.id).map(group => {
        if (!['all', 'any'].includes(group.operator)) return fail();
        return { id: readableReferenceId(frame.frameId, 'group', group.id), conclusionNodeId: node(group.conclusionNodeId),
          premiseNodeIds: group.premiseNodeIds.map(node), conditionNodeIds: group.conditionNodeIds.map(node),
          relationIds: group.relationIds.map(relation), operator: group.operator as 'all' | 'any' };
      }) };
  });
  const result: FrozenReferenceReadableInput = { version: 2, protocol: 'review-frozen-reference-readable-v2',
    evaluationId: input.evaluationId, contractHash: reference.contractHash,
    taskContext: { questionText: input.taskContext.questionText, usage: 'question_context_only', taskType: reference.taskType },
    user: { answerText: input.answer.text,
      claims: claims.map(claim => ({ id: readableUserId(claim.id), role: claim.role, text: span(input.answer.text, claim.start, claim.end) })),
      edges: edges.map(edge => {
        const source = claimMap.get(edge.source), target = claimMap.get(edge.target);
        if (!source || !target || source.id === target.id || !['support', 'oppose'].includes(edge.relation)
          || [source, target].some(claim => claim.start < edge.start || claim.end > edge.end)) return fail();
        return { id: readableUserId(edge.id), source: readableUserId(edge.source), target: readableUserId(edge.target),
          relation: edge.relation, text: span(input.answer.text, edge.start, edge.end) };
      }) }, frames };
  if (JSON.stringify(result).length > FROZEN_REFERENCE_READABLE_INPUT_LIMIT) fail('readable_context_budget_exceeded');
  return result;
}

/**
 * Decode exact model selections back into the original host coordinate space.
 * Only redundant lists are derived. No verdict/axis/relationship is repaired,
 * upgraded or guessed. The old full semantic/structure gate still runs next.
 */
export function readFrozenReferenceReadableOutput(raw: unknown, input: FrozenReferenceShadowInput) {
  const root = closed(raw, ['version', 'evaluationId', 'contractHash', 'items']);
  if (root.version !== 2 || root.evaluationId !== input.evaluationId || root.contractHash !== input.reference.contractHash)
    fail('invalid_readable_output');
  const expected = input.reference.frames.flatMap(frame => frame.items.map(item => ({ frame, item,
    key: readableReferenceId(frame.frameId, 'item', item.itemId) })));
  const rawItems = dense(root.items, expected.length);
  if (rawItems.length !== expected.length) fail('invalid_readable_output');
  const seen = new Set<string>();
  const observations: FrozenReferenceItemObservation[] = rawItems.map(value => {
    const row = closed(value, ['itemId', 'verdict', 'matches', 'edgeIds', 'relationIds', 'axes', 'direction', 'premises']);
    const selected = expected.find(entry => entry.key === row.itemId);
    if (!selected || seen.has(row.itemId)) return fail('invalid_readable_output');
    seen.add(row.itemId);
    if (!['supported', 'contradicted', 'partial', 'unverifiable'].includes(row.verdict)
      || !['correct', 'reverse', 'undetermined', 'not_required'].includes(row.direction)
      || !['complete', 'missing', 'not_required'].includes(row.premises)) fail('invalid_shadow_item');
    const axes = closed(row.axes, ['object', 'metric', 'condition', 'time', 'certainty']);
    if (Object.values(axes).some(value => !['match', 'different', 'unknown', 'not_applicable'].includes(value))) fail('invalid_shadow_axes');
    const pairs = dense(row.matches, 48), pairKeys = new Set<string>();
    const mappings = pairs.map(value => {
      const pair = closed(value, ['claimId', 'nodeId']);
      const claim = input.graph.claims.find(claim => readableUserId(claim.id) === pair.claimId);
      const nodeId = selected.item.nodeIds.find(id => readableReferenceId(selected.frame.frameId, 'node', id) === pair.nodeId);
      const key = JSON.stringify([pair.claimId, pair.nodeId]);
      if (!claim || !nodeId || pairKeys.has(key)) return fail('invalid_readable_evidence');
      pairKeys.add(key); return { claimId: claim.id, nodeId };
    });
    const selectedEdges = dense(row.edgeIds, input.graph.edges.length).map(value => {
      const edge = input.graph.edges.find(edge => readableUserId(edge.id) === value);
      if (!edge) return fail('invalid_readable_evidence');
      return edge;
    });
    const edgeIds = selectedEdges.map(edge => edge.id);
    if (new Set(edgeIds).size !== edgeIds.length) fail('invalid_readable_evidence');
    if (selected.item.criterionId !== 'inference_link' && selectedEdges.length) fail('invalid_readable_evidence');
    const relationIds = dense(row.relationIds, selected.item.relationIds.length).map(value => {
      const id = selected.item.relationIds.find(id => readableReferenceId(selected.frame.frameId, 'relation', id) === value);
      if (!id) return fail('invalid_readable_evidence');
      return id;
    });
    if (new Set(relationIds).size !== relationIds.length) fail('invalid_readable_evidence');
    // Selecting a known edge already selects its two known endpoint claims.
    // This is explicit protocol semantics, not repairing missing model evidence.
    const claimIds = [...new Set([...mappings.map(pair => pair.claimId), ...selectedEdges.flatMap(edge => [edge.source, edge.target])])];
    return { frameId: selected.frame.frameId, itemId: selected.item.itemId, verdict: row.verdict,
      claimIds, edgeIds, nodeIds: [...new Set(mappings.map(pair => pair.nodeId))], relationIds, nodeMappings: mappings,
      axes: structuredClone(axes) as FrozenReferenceItemObservation['axes'], direction: row.direction, premises: row.premises };
  });
  return { version: 1, evaluationId: input.evaluationId, contractHash: input.reference.contractHash, items: observations };
}
