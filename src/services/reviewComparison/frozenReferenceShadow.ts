import type { ReviewQuestionIntent } from '../reviewIntent';
import { parseReviewQuestionIntent } from '../reviewIntentValidation';
import { argumentContextHash } from '../argumentContext/hash';
import { createArgumentReferenceDisclosureReader, type ArgumentReferenceDisclosureContext,
  type ArgumentReferenceDisclosureReply } from '../argumentContext/referenceDisclosure';
import { readReviewPerformanceGraph } from './performanceGraph';
import { assertFrozenInferenceAtomicity } from './frozenInferenceAtomicity';
import type { ReviewComparisonAnswer, ReviewComparisonPacket } from './types';
import type { ReviewPerformanceGraph, ReviewSemanticModel } from './semanticTypes';
import { buildFrozenReferenceReadableInput, readableReferenceId } from './frozenReferenceReadable';
import { buildFrozenReferenceTypedInput, readFrozenReferenceTypedOutput, buildFrozenReferenceTypedInputV4,
  readFrozenReferenceTypedOutputV4, FrozenReferenceTypedError } from './frozenReferenceTyped';

export interface FrozenReferenceShadowInput {
  version: 1; protocol: 'review-frozen-reference-shadow-v1'; evaluationId: string;
  answer: { text: string; hintLevel: number; consultedMaterialCount: number };
  /** Original bounded question, never an answer claim or a new scoring item. */
  taskContext: { questionText: string; usage: 'question_context_only' };
  // Answer text exists once; node/edge quotations are half-open offsets into it.
  graph: { claims: Omit<ReviewPerformanceGraph['claims'][number], 'quote'>[];
    edges: Omit<ReviewPerformanceGraph['edges'][number], 'quote'>[] };
  reference: ArgumentReferenceDisclosureContext;
}
type Axis = 'match' | 'different' | 'unknown' | 'not_applicable';
export interface FrozenReferenceItemObservation {
  frameId: string; itemId: string; verdict: 'supported' | 'contradicted' | 'partial' | 'unverifiable';
  claimIds: string[]; edgeIds: string[]; nodeIds: string[]; relationIds: string[];
  nodeMappings: { claimId: string; nodeId: string }[];
  axes: { object: Axis; metric: Axis; condition: Axis; time: Axis; certainty: Axis };
  direction: 'correct' | 'reverse' | 'undetermined' | 'not_required';
  premises: 'complete' | 'missing' | 'not_required';
}
export interface FrozenReferenceShadowResult {
  version: 1; protocol: 'review-frozen-reference-shadow-v1'; evaluationId: string;
  status: 'reviewed' | 'held'; reasons: string[];
  observations: FrozenReferenceItemObservation[];
  frames: { frameId: string; knowledgeTarget: string; status: 'covered' | 'partial' | 'contradicted' }[];
  evidence: 'independent' | 'assisted' | 'assisted_not_independent';
  /** Only this question's required items, never a mastery score or certification of facts. */
  scope: 'frozen_question_items'; semanticTruth: 'not_certified';
  scoreWrite: 'disabled'; cognitionWrite: 'disabled';
  modelRequests: { extract: number; reference: number; total: number; limit: 2 };
  /** Explicit opt-in structural policy; absent on every legacy/default result. */
  inferenceAtomicity?: 'separate_selected_endpoints-v1';
  /** Present only on the explicit proposition path; not an authority certificate. */
  propositionBinding?: { freezeId: string; contextHash: string; bundleHash: string };
  /** Safe field/selected-item coordinates only, never model text or IO secrets. */
  diagnostics?: { stage: 'reference'; itemId?: string; field: string; code: string }[];
}
export interface FrozenReferenceShadowDependencies {
  /** Must be backed by the host's retained receipt reader, not a DTO supplied by a model. */
  readReference(intent: ReviewQuestionIntent): Promise<ArgumentReferenceDisclosureReply>;
}
export interface FrozenReferenceShadowModel {
  protocol?: 'typed-v3' | 'typed-v4';
  extract: ReviewSemanticModel['extract'];
  review(input: FrozenReferenceShadowInput, signal?: AbortSignal): Promise<unknown>;
  /** Synchronous local projection/budget check, before counting a review invocation. */
  prepareReview?(input: FrozenReferenceShadowInput): unknown;
}
export const FROZEN_REFERENCE_SHADOW_INPUT_LIMIT = 60000;
export const FROZEN_SELECTED_ENDPOINT_POLICY = 'separate_selected_endpoints-v1' as const;
const object = (raw: unknown, keys: string[]): Record<string, unknown> => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).sort().join('|') !== [...keys].sort().join('|'))
    throw new Error('invalid_shadow_output');
  return raw as Record<string, unknown>;
};
function ids(raw: unknown, allowed: string[]): string[] {
  if (!Array.isArray(raw) || raw.length > allowed.length || Object.keys(raw).length !== raw.length
    || Object.keys(raw).some((key, index) => key !== String(index)) || new Set(raw).size !== raw.length
    || raw.some(id => typeof id !== 'string' || !allowed.includes(id))) throw new Error('invalid_shadow_evidence');
  return [...raw];
}
function readObservations(raw: unknown, input: FrozenReferenceShadowInput, typedDiagnostics = false): FrozenReferenceItemObservation[] {
  const root = object(raw, ['version', 'evaluationId', 'contractHash', 'items']);
  const required = input.reference.frames.flatMap(frame => frame.items.map(item => ({ frame, item })));
  if (root.version !== 1 || root.evaluationId !== input.evaluationId || root.contractHash !== input.reference.contractHash
    || !Array.isArray(root.items) || root.items.length !== required.length || Object.keys(root.items).length !== root.items.length
    || Object.keys(root.items).some((key, index) => key !== String(index)))
    throw new Error('incomplete_shadow_items');
  const seen = new Set<string>();
  return root.items.map(rawItem => {
    // Only an original selected item may appear in diagnostics, never arbitrary
    // model text. Preserve the same strict gate and whole-result fail-closed.
    const diagnosticItem = required.find(entry => entry.frame.frameId === (rawItem as any)?.frameId
      && entry.item.itemId === (rawItem as any)?.itemId);
    try {
    const item = object(rawItem, ['frameId', 'itemId', 'verdict', 'claimIds', 'edgeIds', 'nodeIds', 'relationIds', 'nodeMappings', 'axes', 'direction', 'premises']);
    const selected = required.find(entry => entry.frame.frameId === item.frameId && entry.item.itemId === item.itemId);
    const key = JSON.stringify([item.frameId, item.itemId]);
    if (!selected || seen.has(key) || !['supported', 'contradicted', 'partial', 'unverifiable'].includes(item.verdict as string)
      || !['correct', 'reverse', 'undetermined', 'not_required'].includes(item.direction as string)
      || !['complete', 'missing', 'not_required'].includes(item.premises as string)) throw new Error('invalid_shadow_item');
    seen.add(key);
    const claimIds = ids(item.claimIds, input.graph.claims.map(claim => claim.id));
    const edgeIds = ids(item.edgeIds, input.graph.edges.map(edge => edge.id));
    if (edgeIds.some(id => {
      const edge = input.graph.edges.find(edge => edge.id === id)!;
      return !claimIds.includes(edge.source) || !claimIds.includes(edge.target);
    })) throw new Error('invalid_shadow_evidence');
    const nodeIds = ids(item.nodeIds, selected.item.nodeIds), relationIds = ids(item.relationIds, selected.item.relationIds);
    if (!Array.isArray(item.nodeMappings) || item.nodeMappings.length > 48 || Object.keys(item.nodeMappings).length !== item.nodeMappings.length
      || Object.keys(item.nodeMappings).some((key, index) => key !== String(index))) throw new Error('invalid_shadow_evidence');
    const mappingKeys = new Set<string>();
    const nodeMappings = item.nodeMappings.map(raw => {
      const mapping = object(raw, ['claimId', 'nodeId']), key = JSON.stringify([mapping.claimId, mapping.nodeId]);
      if (typeof mapping.claimId !== 'string' || !claimIds.includes(mapping.claimId) || typeof mapping.nodeId !== 'string'
        || !nodeIds.includes(mapping.nodeId) || mappingKeys.has(key)) throw new Error('invalid_shadow_evidence');
      mappingKeys.add(key); return { claimId: mapping.claimId, nodeId: mapping.nodeId };
    });
    const inferenceEdges = selected.item.criterionId === 'inference_link'
      ? selected.frame.relations.filter(edge => selected.item.relationIds.includes(edge.id)
        && (edge.kind === 'support' || edge.kind === 'oppose')) : [];
    // A composite premise may map to several premise/condition nodes, but the
    // same user claim cannot impersonate BOTH ends of one reference inference.
    // Otherwise an all-to-all mapping makes a reversed user edge look forward.
    const ambiguousInferenceEndpoints = inferenceEdges.some(edge => nodeMappings.some(mapping => mapping.nodeId === edge.sourceNodeId
      && nodeMappings.some(other => other.claimId === mapping.claimId && other.nodeId === edge.targetNodeId)));
    const axes = object(item.axes, ['object', 'metric', 'condition', 'time', 'certainty']);
    if (Object.values(axes).some(value => !['match', 'different', 'unknown', 'not_applicable'].includes(value as string)))
      throw new Error('invalid_shadow_axes');
    // A model's verdict alone is insufficient. Scope/certainty mismatch is not automatically
    // contradiction. Unknown axes, omitted obligations and incomplete premises cannot pass.
    if (item.verdict === 'supported' || item.verdict === 'contradicted') {
      if (!claimIds.length || !nodeIds.length || axes.object !== 'match' || axes.condition !== 'match' || axes.certainty !== 'match'
        || Object.values(axes).some(value => !['match', 'not_applicable'].includes(value as string))) throw new Error('unsubstantiated_shadow_verdict');
      if (selected.item.criterionId === 'concept_boundary' || selected.item.criterionId === 'condition_scope') {
        if (axes.condition !== 'match') throw new Error('unsubstantiated_shadow_verdict');
      }
    }
    if (item.verdict === 'supported') {
      if (item.direction === 'reverse' || item.direction === 'undetermined' || item.premises === 'missing')
        throw new Error('incomplete_shadow_structure');
      if (nodeIds.length !== selected.item.nodeIds.length || relationIds.length !== selected.item.relationIds.length)
        throw new Error('incomplete_shadow_structure');
      if (selected.item.criterionId === 'inference_link'
        && (!edgeIds.length || !relationIds.length || item.direction !== 'correct' || item.premises !== 'complete'))
        throw new Error('incomplete_shadow_reasoning');
      if (selected.item.criterionId === 'inference_link') {
        if (!inferenceEdges.length || ambiguousInferenceEndpoints || nodeIds.some(nodeId => !nodeMappings.some(mapping => mapping.nodeId === nodeId))
          || inferenceEdges.some(referenceEdge => !edgeIds.some(edgeId => {
            const userEdge = input.graph.edges.find(edge => edge.id === edgeId)!;
            return userEdge.relation === referenceEdge.kind
              && nodeMappings.some(mapping => mapping.claimId === userEdge.source && mapping.nodeId === referenceEdge.sourceNodeId)
              && nodeMappings.some(mapping => mapping.claimId === userEdge.target && mapping.nodeId === referenceEdge.targetNodeId);
          }))) throw new Error('incomplete_shadow_reasoning');
      }
    }
    if (item.verdict === 'contradicted' && selected.item.criterionId === 'inference_link') {
      const declaredConclusions = [
        ...selected.frame.groups.map(group => group.conclusionNodeId),
        ...selected.frame.nodes.filter(node => node.role === 'conclusion').map(node => node.id),
      ].filter(id => selected.item.nodeIds.includes(id));
      // Explicit conclusion declarations take precedence: an intermediate edge
      // target must not turn a changed/unmatched premise into a refuted outcome.
      const conclusionIds = new Set(declaredConclusions.length ? declaredConclusions
        : inferenceEdges.map(edge => edge.targetNodeId).filter(id => selected.item.nodeIds.includes(id)));
      // Minimum auditable shape, NOT a semantic-truth test. A direct observed
      // opposite outcome can refute an inference without supplying a proof edge.
      // Reverse reasoning or missing premises merely fails to establish it.
      if (ambiguousInferenceEndpoints || item.direction === 'reverse' || item.direction === 'undetermined' || item.premises === 'missing'
        || !nodeMappings.some(mapping => conclusionIds.has(mapping.nodeId))) throw new Error('unsubstantiated_shadow_verdict');
    }
    return { frameId: selected.frame.frameId, itemId: selected.item.itemId,
      verdict: item.verdict as FrozenReferenceItemObservation['verdict'], claimIds, edgeIds, nodeIds, relationIds, nodeMappings,
      axes: axes as FrozenReferenceItemObservation['axes'], direction: item.direction as FrozenReferenceItemObservation['direction'],
      premises: item.premises as FrozenReferenceItemObservation['premises'] };
    } catch (error) {
      if (typedDiagnostics && diagnosticItem) throw new FrozenReferenceTypedError(error instanceof Error ? error.message : 'invalid_shadow_output',
        readableReferenceId(diagnosticItem.frame.frameId, 'item', diagnosticItem.item.itemId), 'structure');
      throw error;
    }
  });
}
async function bounded<T>(call: (signal: AbortSignal) => Promise<T>, timeout: number, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new Error('shadow_aborted');
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  let stop!: () => void;
  const halted = new Promise<never>((_, reject) => {
    stop = () => { controller.abort(); reject(new Error('shadow_aborted')); };
    signal?.addEventListener('abort', stop, { once: true });
    timer = setTimeout(() => { controller.abort(); reject(new Error('shadow_timeout')); }, timeout);
  });
  try { return await Promise.race([halted, Promise.resolve().then(() => {
    if (controller.signal.aborted) throw new Error('shadow_aborted');
    return call(controller.signal);
  })]); }
  finally { if (timer) clearTimeout(timer); signal?.removeEventListener('abort', stop); }
}

/**
 * Deliberate SHADOW evaluation. No default model, UI-triggered request, retry,
 * source re-selection, score writer, cognition mutation or growth proposal.
 * The extraction is reused by a separately isolated personal consumer later.
 */
export async function evaluateFrozenReviewReferenceShadow(
  original: ReviewComparisonAnswer, dependencies: FrozenReferenceShadowDependencies, model: FrozenReferenceShadowModel,
  options: { signal?: AbortSignal; timeoutMs?: number; readTimeoutMs?: number;
    inferenceAtomicity?: typeof FROZEN_SELECTED_ENDPOINT_POLICY;
    propositionBinding?: FrozenReferenceShadowResult['propositionBinding'] } = {},
): Promise<{ result: FrozenReferenceShadowResult; graph?: ReviewPerformanceGraph }> {
  const answer = structuredClone(original), requests: FrozenReferenceShadowResult['modelRequests'] = { extract: 0, reference: 0, total: 0, limit: 2 };
  const protocol = model?.protocol, typed = protocol === 'typed-v3' || protocol === 'typed-v4';
  // Capture this new policy before any source/model await. Default v3/v4 IDs,
  // requests and decoding remain unchanged; unsupported policies fail closed.
  const inferenceAtomicity = options.inferenceAtomicity;
  const propositionBinding = options.propositionBinding ? structuredClone(options.propositionBinding) : undefined;
  const extract = typeof model?.extract === 'function' ? model.extract.bind(model) : undefined;
  const review = typeof model?.review === 'function' ? model.review.bind(model) : undefined;
  const prepareReview = typeof model?.prepareReview === 'function' ? model.prepareReview.bind(model) : undefined;
  const consulted = answer.evidence.consultedMaterialIds ?? [];
  const evidence = consulted.length || answer.evidence.hintLevel >= 3 ? 'assisted_not_independent'
    : answer.evidence.hintLevel ? 'assisted' : 'independent';
  let evaluationId = 'unavailable', graph: ReviewPerformanceGraph | undefined;
  const result = (status: FrozenReferenceShadowResult['status'], reasons: string[], observations: FrozenReferenceItemObservation[] = [],
    frames: FrozenReferenceShadowResult['frames'] = []): { result: FrozenReferenceShadowResult; graph?: ReviewPerformanceGraph } => ({
    result: { version: 1, protocol: 'review-frozen-reference-shadow-v1', evaluationId, status, reasons, observations, frames,
      evidence, scope: 'frozen_question_items', semanticTruth: 'not_certified', scoreWrite: 'disabled', cognitionWrite: 'disabled', modelRequests: { ...requests },
      ...(inferenceAtomicity === FROZEN_SELECTED_ENDPOINT_POLICY ? { inferenceAtomicity } : {}),
      ...(propositionBinding ? { propositionBinding: structuredClone(propositionBinding) } : {}) },
    ...(graph ? { graph } : {}),
  });
  try {
    if (inferenceAtomicity !== undefined && inferenceAtomicity !== FROZEN_SELECTED_ENDPOINT_POLICY)
      return result('held', ['invalid_inference_atomicity_policy']);
    if (propositionBinding && (Object.keys(propositionBinding).sort().join('|') !== 'bundleHash|contextHash|freezeId'
      || !/^[a-f0-9-]{36}$/u.test(propositionBinding.freezeId)
      || !/^[a-f0-9]{64}$/u.test(propositionBinding.contextHash) || !/^[a-f0-9]{64}$/u.test(propositionBinding.bundleHash)))
      return result('held', ['invalid_proposition_binding']);
    if (!extract || !review || protocol !== undefined && !typed) return result('held', ['explicit_model_required']);
    const intent = parseReviewQuestionIntent(answer.evidence.questionIntent);
    if (!answer.activityId || !answer.evidence.messageId || !answer.questionText.trim() || answer.questionText.length > 4000
      || !answer.evidence.answer.trim() || answer.evidence.answer.length > 20000 || ![0, 1, 2, 3, 4].includes(answer.evidence.hintLevel)
      || !Array.isArray(consulted) || consulted.length > 30 || consulted.some(id => typeof id !== 'string' || !id.trim())
      || JSON.stringify(answer.evidence.targetKnowledgeNames) !== JSON.stringify(intent.knowledgeTargets)
      || intent.assessment?.status !== 'fixed' || intent.referenceRubric?.status !== 'fixed' || intent.referenceStructure?.status !== 'fixed')
      return result('held', ['frozen_task_unavailable']);
    const read = async () => {
      if (options.signal?.aborted) throw new Error('shadow_aborted');
      if (intent.referenceStructure!.selectorsHash !== await argumentContextHash({ questionMessageId: intent.referenceStructure!.originQuestionMessageId,
        knowledgeTargets: intent.knowledgeTargets, assessment: intent.assessment, referenceRubric: intent.referenceRubric }))
        throw new Error('frozen_reference_changed');
      const readTimeout = Number.isFinite(options.readTimeoutMs) ? Math.max(1, Math.min(30000, Math.floor(options.readTimeoutMs!))) : 10000;
      const reply = await bounded(() => dependencies.readReference(structuredClone(intent)), readTimeout, options.signal);
      if (options.signal?.aborted) throw new Error('shadow_aborted');
      if (reply.status !== 'ready') throw new Error('frozen_reference_unavailable');
      const context = reply.context;
      if (context.protocol !== 'review-frozen-reference-context-v1' || context.coverage !== 'complete_required'
        || context.contractHash !== intent.referenceStructure!.contractHash || context.originQuestionMessageId !== intent.referenceStructure!.originQuestionMessageId
        || context.rubricHash !== await argumentContextHash(intent.referenceRubric) || await argumentContextHash(context.assessment) !== await argumentContextHash(intent.assessment)
        || JSON.stringify(context.frames.map(frame => frame.knowledgeTarget)) !== JSON.stringify(intent.knowledgeTargets)) throw new Error('frozen_reference_changed');
      if (options.signal?.aborted) throw new Error('shadow_aborted');
      return structuredClone(context);
    };
    const context = await read(), contextHash = await argumentContextHash(context);
    if (propositionBinding && (propositionBinding.contextHash !== contextHash
      || propositionBinding.freezeId !== intent.referenceStructure!.freezeId)) return result('held', ['frozen_reference_changed']);
    // This binding deliberately excludes the personal graph, user profile and newly
    // retrieved passages; none can alter this task's reference-channel model input.
    evaluationId = `frozen-reference:${await argumentContextHash({ activityId: answer.activityId, messageId: answer.evidence.messageId,
      questionText: answer.questionText, answer: answer.evidence.answer, hintLevel: answer.evidence.hintLevel, consulted,
      contextHash, ...(inferenceAtomicity ? { inferenceAtomicity } : {}), ...(propositionBinding ? { propositionBinding } : {}) })}`;
    const thinIntent: ReviewQuestionIntent = { version: 1, questionMessageId: intent.questionMessageId,
      knowledgeTargets: [...intent.knowledgeTargets], assessment: structuredClone(intent.assessment) };
    const packet: ReviewComparisonPacket = { version: 1, packetId: evaluationId, snapshotHash: '', activityId: answer.activityId,
      messageId: answer.evidence.messageId, questionText: answer.questionText, questionIntent: thinIntent,
      answer: { text: answer.evidence.answer, hintLevel: answer.evidence.hintLevel, consultedMaterialIds: [...consulted] },
      personal: { status: 'not_requested', truncated: false }, references: [],
      coverage: { referencePresence: 'available', semanticCoverage: 'not_assessed', missingTargetNames: [] },
      preparation: { mastery: 'pending_alignment', cognitionGrowth: 'held', masteryReasons: [], growthReasons: ['not_requested'], warnings: [] } };
    const timeout = Number.isFinite(options.timeoutMs) ? Math.max(1, Math.min(60000, Math.floor(options.timeoutMs!))) : 45000;
    requests.extract++; requests.total++;
    const extracted = await bounded(signal => extract({ packetId: evaluationId, questionText: packet.questionText,
      answer: packet.answer, knowledgeTargets: thinIntent.knowledgeTargets, assessment: thinIntent.assessment }, signal), timeout, options.signal);
    graph = readReviewPerformanceGraph(extracted, packet);
    if (!graph.claims.length) return result('held', ['no_user_claims']);
    if (await argumentContextHash(await read()) !== contextHash) return result('held', ['frozen_reference_changed']);
    if (options.signal?.aborted) return result('held', ['shadow_aborted']);
    const reader = createArgumentReferenceDisclosureReader(context), disclosure = reader.readFrames(reader.index().frames.map(frame => frame.frameId));
    if (disclosure.status !== 'ready' || disclosure.context.coverage !== 'complete_required') return result('held', ['required_structure_incomplete']);
    const input: FrozenReferenceShadowInput = { version: 1, protocol: 'review-frozen-reference-shadow-v1', evaluationId,
      answer: { text: packet.answer.text, hintLevel: packet.answer.hintLevel, consultedMaterialCount: consulted.length },
      taskContext: { questionText: packet.questionText, usage: 'question_context_only' },
      graph: { claims: graph.claims.map(({ quote: _quote, ...claim }) => claim), edges: graph.edges.map(({ quote: _quote, ...edge }) => edge) },
      reference: disclosure.context };
    if (JSON.stringify(input).length > FROZEN_REFERENCE_SHADOW_INPUT_LIMIT) return result('held', ['shadow_context_budget_exceeded']);
    // Validate the model-facing read projection BEFORE consuming the second
    // request. Extra readable excerpts must never silently clip requirements or
    // count a local budget rejection as a cloud invocation.
    if (protocol === 'typed-v4') buildFrozenReferenceTypedInputV4(input);
    else if (protocol === 'typed-v3') buildFrozenReferenceTypedInput(input);
    else buildFrozenReferenceReadableInput(input);
    if (prepareReview) {
      const prepared = prepareReview(structuredClone(input));
      // An async hook is not a completed preflight. Do not wait for or invoke
      // a review after it; suppress late rejection without granting it authority.
      if (prepared && typeof (prepared as { then?: unknown }).then === 'function') {
        void Promise.resolve(prepared).catch(() => undefined);
        return result('held', ['invalid_review_preflight']);
      }
      if (prepared !== undefined) return result('held', ['invalid_review_preflight']);
    }
    requests.reference++; requests.total++;
    const reviewed = await bounded(signal => review(structuredClone(input), signal), timeout, options.signal);
    const decoded = protocol === 'typed-v4' ? readFrozenReferenceTypedOutputV4(reviewed, input)
      : protocol === 'typed-v3' ? readFrozenReferenceTypedOutput(reviewed, input) : reviewed;
    const observations = readObservations(decoded, input, typed);
    if (inferenceAtomicity === FROZEN_SELECTED_ENDPOINT_POLICY) {
      // Only actual edges selected by already-validated inference observations:
      // unrelated/statement-only graph edges cannot create a new obligation.
      for (const item of observations) {
        const selected = context.frames.find(frame => frame.frameId === item.frameId)?.items.find(value => value.itemId === item.itemId);
        if (selected?.criterionId !== 'inference_link') continue;
        const selectedIds = new Set(item.edgeIds);
        try { assertFrozenInferenceAtomicity({ claims: graph.claims, edges: graph.edges.filter(edge => selectedIds.has(edge.id)) }); }
        catch (error) {
          throw new FrozenReferenceTypedError(error instanceof Error ? error.message : 'invalid_frozen_inference_endpoint',
            readableReferenceId(item.frameId, 'item', item.itemId), 'inference_endpoints');
        }
      }
    }
    if (await argumentContextHash(await read()) !== contextHash) return result('held', ['frozen_reference_changed']);
    if (options.signal?.aborted) return result('held', ['shadow_aborted']);
    const frames = context.frames.map(frame => {
      const items = observations.filter(item => item.frameId === frame.frameId);
      const status = items.some(item => item.verdict === 'contradicted') ? 'contradicted'
        : items.every(item => item.verdict === 'supported') ? 'covered' : 'partial';
      return { frameId: frame.frameId, knowledgeTarget: frame.knowledgeTarget, status } as FrozenReferenceShadowResult['frames'][number];
    });
    return result('reviewed', [], observations, frames);
  } catch (error) {
    const known = ['shadow_aborted', 'shadow_timeout', 'frozen_reference_unavailable', 'frozen_reference_changed',
      'invalid_shadow_output', 'incomplete_shadow_items', 'invalid_shadow_evidence', 'invalid_shadow_item', 'invalid_shadow_axes',
      'unsubstantiated_shadow_verdict', 'incomplete_shadow_structure', 'incomplete_shadow_reasoning'];
    known.push('invalid_readable_context', 'invalid_readable_output', 'invalid_readable_evidence', 'readable_context_budget_exceeded');
    known.push('invalid_typed_output', 'invalid_typed_scope', 'invalid_typed_evidence', 'typed_context_budget_exceeded',
      'invalid_reference_node_anchor', 'invalid_exact_evidence', 'invalid_opposition_witness', 'reference_role_mismatch');
    known.push('non_atomic_inference_endpoint', 'invalid_frozen_inference_endpoint');
    known.push('invalid_proposition_output', 'invalid_proposition_evidence', 'invalid_proposition_bundle',
      'invalid_proposition_context', 'proposition_required_nodes_missing', 'proposition_context_budget_exceeded');
    const message = error instanceof Error ? error.message : '';
    const reply = result('held', [known.includes(message) ? message : 'shadow_evaluation_unavailable']);
    if (error instanceof FrozenReferenceTypedError) reply.result.diagnostics = [{ stage: 'reference',
      ...(error.itemId ? { itemId: error.itemId } : {}), field: error.field, code: known.includes(message) ? message : 'invalid_typed_output' }];
    return reply;
  }
}
