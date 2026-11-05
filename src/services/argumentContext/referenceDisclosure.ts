import type { FrozenArgumentQuestionFrames } from './questionBindingTypes';
import type { ArgumentContextNode, ArgumentContextRelation, ArgumentPrerequisiteGroup } from './types';
import { argumentContextHash } from './hash';

export const ARGUMENT_REFERENCE_DISCLOSURE_LIMIT = 32000;
export interface ArgumentReferenceDisclosureContext {
  version: 1; protocol: 'review-frozen-reference-context-v1';
  contractHash: string; rubricHash: string; originQuestionMessageId: string;
  taskType: NonNullable<FrozenArgumentQuestionFrames['taskType']>;
  assessment: FrozenArgumentQuestionFrames['assessment']; policy: 'all_target_frames';
  coverage: 'complete_required' | 'frame_subset';
  frames: {
    frameId: string; knowledgeTarget: string;
    source: { kind: 'knowledge-note'; entityId: string; version: string; contentHash: string;
      coordinateSpace: string; structureHash: string };
    items: { itemId: string; criterionId: string; quoteId: string; nodeIds: string[]; relationIds: string[] }[];
    nodes: { id: string; role: ArgumentContextNode['role']; quoteIds: string[] }[];
    relations: { id: string; sourceNodeId: string; targetNodeId: string; kind: ArgumentContextRelation['kind']; quoteIds: string[] }[];
    groups: Pick<ArgumentPrerequisiteGroup, 'id' | 'conclusionNodeId' | 'premiseNodeIds' | 'conditionNodeIds' | 'relationIds' | 'operator'>[];
  }[];
  quotes: { quoteId: string; sourceKey: string; start: number; end: number; text: string }[];
  limitations: { semanticTruth: 'not_certified'; writes: 'disabled' };
}
export type ArgumentReferenceDisclosureReply = { status: 'ready'; context: ArgumentReferenceDisclosureContext }
  | { status: 'held'; reasons: string[] };
const held = (reason: string): ArgumentReferenceDisclosureReply => ({ status: 'held', reasons: [reason] });
const sameIds = (left: string[], right: string[]) => left.length === right.length
  && new Set(left).size === left.length && new Set(right).size === right.length
  && left.every(id => right.includes(id));

/**
 * Projection ONLY, not authentication. The host must independently verify its
 * retained question contract before calling this function. No original sentence
 * containers, authority, paths, neighboring graph or new source selection escape.
 */
export async function buildArgumentReferenceDisclosure(value: FrozenArgumentQuestionFrames): Promise<ArgumentReferenceDisclosureReply> {
  const contract = structuredClone(value);
  if (contract.status !== 'fixed' || contract.reasons.length || contract.assessment.status !== 'fixed'
    || !contract.taskType || contract.referenceRubric.status !== 'fixed') return held('reference_unavailable');
  const { contractHash, ...body } = contract;
  if (await argumentContextHash(body) !== contractHash || await argumentContextHash(contract.referenceRubric) !== contract.rubricHash
    || contract.frames.length !== contract.knowledgeTargets.length) return held('contract_invalid');
  const quotes: ArgumentReferenceDisclosureContext['quotes'] = [], quoteMap = new Map<string, string>();
  const frames: ArgumentReferenceDisclosureContext['frames'] = [];
  for (const [index, frame] of contract.frames.entries()) {
    const pack = frame.pack, completeness = pack.completeness;
    if (frame.knowledgeTarget !== contract.knowledgeTargets[index] || frame.frameId !== `target-${index + 1}`
      || frame.source.kind !== 'knowledge-note' || frame.source.entityId !== frame.noteId
      || pack.completeness.status !== 'complete_for_scope' || pack.quality.status !== 'eligible'
      || pack.task !== contract.taskType || pack.structureHash !== frame.structureHash
      || completeness.gaps.length || completeness.omittedNodeIds.length || completeness.omittedRelationIds.length || completeness.omittedGroupIds.length
      || !sameIds(pack.nodes.map(node => node.id), completeness.requiredNodeIds)
      || !sameIds(pack.relations.map(edge => edge.id), completeness.requiredRelationIds)
      || !sameIds(pack.prerequisiteGroups.map(group => group.id), completeness.requiredGroupIds)) return held('required_structure_incomplete');
    const nodes = new Set(pack.nodes.map(node => node.id)), relations = new Set(pack.relations.map(edge => edge.id));
    const selectedNodes = new Set(frame.items.flatMap(item => item.nodeIds)), selectedRelations = new Set(frame.items.flatMap(item => item.relationIds));
    const rubricItems = contract.referenceRubric.items.filter(item => item.knowledgeTarget === frame.knowledgeTarget);
    if (!sameIds(frame.items.map(item => item.itemId), rubricItems.map(item => item.itemId))
      || [...nodes].some(id => !selectedNodes.has(id)) || [...relations].some(id => !selectedRelations.has(id))) return held('required_structure_incomplete');
    const sourceKey = await argumentContextHash({ source: frame.source, structureHash: frame.structureHash });
    function addQuote(start: number, end: number, text: string): string {
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end - start !== text.length || !text.trim())
        throw new Error('invalid_disclosure_quote');
      // Equal wording at a different occurrence or in another source is NOT the same evidence.
      const key = JSON.stringify([sourceKey, start, end, text]);
      let quoteId = quoteMap.get(key);
      if (!quoteId) { quoteId = `Q${quotes.length + 1}`; quoteMap.set(key, quoteId); quotes.push({ quoteId, sourceKey, start, end, text }); }
      return quoteId;
    }
    try {
      const items = frame.items.map(item => {
        const original = rubricItems.find(entry => entry.itemId === item.itemId)!;
        if (item.criterionId !== original.criterionId || item.start !== original.start || item.end !== original.end || item.quote !== original.quote
          || item.nodeIds.some(id => !nodes.has(id)) || item.relationIds.some(id => !relations.has(id))) throw new Error('invalid_disclosure_item');
        return { itemId: item.itemId, criterionId: item.criterionId, quoteId: addQuote(item.start, item.end, item.quote),
          nodeIds: [...item.nodeIds], relationIds: [...item.relationIds] };
      });
      const outputNodes = pack.nodes.map(node => {
        if (node.admission !== 'admitted' || node.semanticStatus !== 'reviewed' || !node.evidence.length) throw new Error('invalid_disclosure_node');
        return { id: node.id, role: node.role, quoteIds: node.evidence.map(span => addQuote(span.start, span.end, span.quote)) };
      });
      const outputRelations = pack.relations.map(edge => {
        if (edge.admission !== 'admitted' || edge.semanticStatus !== 'reviewed' || !edge.evidence.length
          || !nodes.has(edge.sourceNodeId) || !nodes.has(edge.targetNodeId)) throw new Error('invalid_disclosure_relation');
        return { id: edge.id, sourceNodeId: edge.sourceNodeId, targetNodeId: edge.targetNodeId, kind: edge.kind,
          quoteIds: edge.evidence.map(span => addQuote(span.start, span.end, span.quote)) };
      });
      const groups = pack.prerequisiteGroups.map(group => {
        if (group.admission !== 'admitted' || group.semanticStatus !== 'reviewed' || group.operator === 'unknown'
          || !nodes.has(group.conclusionNodeId) || [...group.premiseNodeIds, ...group.conditionNodeIds].some(id => !nodes.has(id))
          || group.relationIds.some(id => !relations.has(id))) throw new Error('invalid_disclosure_group');
        return { id: group.id, conclusionNodeId: group.conclusionNodeId, premiseNodeIds: [...group.premiseNodeIds],
          conditionNodeIds: [...group.conditionNodeIds], relationIds: [...group.relationIds], operator: group.operator };
      });
      frames.push({ frameId: frame.frameId, knowledgeTarget: frame.knowledgeTarget,
        source: { kind: 'knowledge-note', entityId: frame.source.entityId, version: frame.source.version,
          contentHash: frame.source.contentHash, coordinateSpace: frame.source.coordinateSpace, structureHash: frame.structureHash },
        items, nodes: outputNodes, relations: outputRelations, groups });
    } catch { return held('required_structure_incomplete'); }
  }
  const context: ArgumentReferenceDisclosureContext = { version: 1, protocol: 'review-frozen-reference-context-v1',
    contractHash, rubricHash: contract.rubricHash, originQuestionMessageId: contract.originQuestionMessageId,
    taskType: contract.taskType, assessment: structuredClone(contract.assessment), policy: 'all_target_frames', coverage: 'complete_required',
    frames, quotes, limitations: { semanticTruth: 'not_certified', writes: 'disabled' } };
  // No clipping: a shorter but incomplete standard must not look like a passing task.
  return JSON.stringify(context).length <= ARGUMENT_REFERENCE_DISCLOSURE_LIMIT ? { status: 'ready', context } : held('context_budget_exceeded');
}

/**
 * Bounded local disclosure of an already authenticated bundle. An index is a
 * routing aid, not grading evidence. Reads never add standards or enlarge scope.
 * Consumer still re-verifies the host receipt before and after model evaluation.
 */
export function createArgumentReferenceDisclosureReader(value: ArgumentReferenceDisclosureContext) {
  const context = structuredClone(value); let reads = 0;
  function index() {
    return { contractHash: context.contractHash, taskType: context.taskType, policy: context.policy,
      frames: context.frames.map(frame => ({ frameId: frame.frameId, knowledgeTarget: frame.knowledgeTarget,
        itemIds: frame.items.map(item => item.itemId), nodeCount: frame.nodes.length, relationCount: frame.relations.length })) };
  }
  function readFrames(frameIds: unknown): ArgumentReferenceDisclosureReply {
    if (!Array.isArray(frameIds) || !frameIds.length || frameIds.length > context.frames.length
      || Object.keys(frameIds).length !== frameIds.length || Object.keys(frameIds).some((key, index) => key !== String(index))
      || new Set(frameIds).size !== frameIds.length || frameIds.some(id => typeof id !== 'string' || !context.frames.some(frame => frame.frameId === id)))
      return held('disclosure_out_of_scope');
    if (reads >= 2) return held('disclosure_read_budget_exceeded');
    reads++;
    const frames = context.frames.filter(frame => frameIds.includes(frame.frameId));
    const requiredQuotes = new Set(frames.flatMap(frame => [
      ...frame.items.map(item => item.quoteId), ...frame.nodes.flatMap(node => node.quoteIds), ...frame.relations.flatMap(edge => edge.quoteIds),
    ]));
    return { status: 'ready', context: { ...structuredClone(context), coverage: frames.length === context.frames.length ? context.coverage : 'frame_subset', frames: structuredClone(frames),
      quotes: context.quotes.filter(quote => requiredQuotes.has(quote.quoteId)).map(quote => ({ ...quote })) } };
  }
  return { index, readFrames };
}
