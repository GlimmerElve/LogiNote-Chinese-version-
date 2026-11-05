import { argumentContextHash } from '../argumentContext/hash';
import type { ArgumentReferencePropositionDisclosureReply } from '../argumentContext/referencePropositionReceipt';
import type { ReviewQuestionIntent } from '../reviewIntent';
import { parseReviewQuestionIntent } from '../reviewIntentValidation';
import type { ReviewComparisonAnswer } from './types';
import type { ReviewPerformanceGraph } from './semanticTypes';
import { evaluateFrozenReviewReferenceShadow, FROZEN_SELECTED_ENDPOINT_POLICY,
  type FrozenReferenceShadowModel, type FrozenReferenceShadowResult, type FrozenReferenceShadowInput } from './frozenReferenceShadow';
import { buildFrozenPropositionReferenceInput, readFrozenPropositionReferenceOutput } from './frozenPropositionReference';
import type { ReviewedReferencePropositionBundle } from './sourcePropositionAnchors';

export interface FrozenPropositionShadowDependencies {
  /** Only the authenticated host's retained pre-question reader, never model/user proofs. */
  readReferencePropositions(intent: ReviewQuestionIntent): Promise<ArgumentReferencePropositionDisclosureReply>;
}
export interface FrozenPropositionShadowModel {
  extract: FrozenReferenceShadowModel['extract'];
  review(input: FrozenReferenceShadowInput, bundle: ReviewedReferencePropositionBundle, signal?: AbortSignal): Promise<unknown>;
}
export interface FrozenPropositionShadowOptions { signal?: AbortSignal; timeoutMs?: number; readTimeoutMs?: number }

async function boundedRead<T>(read: () => Promise<T>, timeout: number, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new Error('shadow_aborted');
  let timer: ReturnType<typeof setTimeout> | undefined, stop!: () => void;
  const halted = new Promise<never>((_, reject) => {
    stop = () => reject(new Error('shadow_aborted'));
    signal?.addEventListener('abort', stop, { once: true });
    timer = setTimeout(() => reject(new Error('shadow_timeout')), timeout);
  });
  try {
    const result = await Promise.race([halted, Promise.resolve().then(() => {
      if (signal?.aborted) throw new Error('shadow_aborted');
      return read();
    })]);
    if (signal?.aborted) throw new Error('shadow_aborted');
    return result;
  } finally { if (timer) clearTimeout(timer); signal?.removeEventListener('abort', stop); }
}

/**
 * Explicit v5 read-only entry. Host anchors MUST already exist at question time.
 * No lazy candidate creation, source search, fallback, score or growth writes.
 * The canonical host checks remain unchanged; v5 is a distinct wire adapter.
 */
export async function evaluateFrozenPropositionReviewReferenceShadow(
  original: ReviewComparisonAnswer, dependencies: FrozenPropositionShadowDependencies, model: FrozenPropositionShadowModel,
  options: FrozenPropositionShadowOptions = {},
): Promise<{ result: FrozenReferenceShadowResult; graph?: ReviewPerformanceGraph }> {
  // Capture methods, caller values and budgets before the first awaited read.
  const answer = structuredClone(original), signal = options.signal;
  const readTimeout = Number.isFinite(options.readTimeoutMs) ? Math.max(1, Math.min(30000, Math.floor(options.readTimeoutMs!))) : 10000;
  const modelTimeout = options.timeoutMs;
  const read = typeof dependencies?.readReferencePropositions === 'function' ? dependencies.readReferencePropositions.bind(dependencies) : undefined;
  const extract = typeof model?.extract === 'function' ? model.extract.bind(model) : undefined;
  const review = typeof model?.review === 'function' ? model.review.bind(model) : undefined;
  const consulted = answer.evidence.consultedMaterialIds ?? [];
  const hold = (reason: string): { result: FrozenReferenceShadowResult } => ({ result: {
    version: 1, protocol: 'review-frozen-reference-shadow-v1', evaluationId: 'unavailable', status: 'held', reasons: [reason],
    observations: [], frames: [], evidence: consulted.length || answer.evidence.hintLevel >= 3 ? 'assisted_not_independent'
      : answer.evidence.hintLevel ? 'assisted' : 'independent', scope: 'frozen_question_items', semanticTruth: 'not_certified',
    scoreWrite: 'disabled', cognitionWrite: 'disabled', inferenceAtomicity: FROZEN_SELECTED_ENDPOINT_POLICY,
    modelRequests: { extract: 0, reference: 0, total: 0, limit: 2 },
  } });
  try {
    if (!extract || !review || !read) return hold('explicit_model_required');
    const parsed = parseReviewQuestionIntent(answer.evidence.questionIntent);
    // Personal coordinates/profile/graphs are never passed to this reference reader.
    const intent: ReviewQuestionIntent = { version: 1, questionMessageId: parsed.questionMessageId,
      knowledgeTargets: [...parsed.knowledgeTargets], assessment: structuredClone(parsed.assessment),
      referenceRubric: structuredClone(parsed.referenceRubric), referenceStructure: structuredClone(parsed.referenceStructure) };
    const receipt = intent.referenceStructure;
    if (!receipt?.freezeId || receipt.status !== 'fixed' || intent.assessment?.status !== 'fixed' || intent.referenceRubric?.status !== 'fixed'
      || !answer.activityId || !answer.evidence.messageId || !answer.questionText.trim() || answer.questionText.length > 4000
      || !answer.evidence.answer.trim() || answer.evidence.answer.length > 20000 || ![0, 1, 2, 3, 4].includes(answer.evidence.hintLevel)
      || !Array.isArray(consulted) || consulted.length > 30 || consulted.some(id => typeof id !== 'string' || !id.trim())
      || JSON.stringify(answer.evidence.targetKnowledgeNames) !== JSON.stringify(intent.knowledgeTargets)) return hold('frozen_task_unavailable');
    if (receipt.selectorsHash !== await argumentContextHash({ questionMessageId: receipt.originQuestionMessageId,
      knowledgeTargets: intent.knowledgeTargets, assessment: intent.assessment, referenceRubric: intent.referenceRubric })) return hold('frozen_reference_changed');
    const raw = await boundedRead<ArgumentReferencePropositionDisclosureReply>(() => read(structuredClone(intent)), readTimeout, signal);
    if (raw.status !== 'ready') return hold('propositions_unavailable');
    const saved = structuredClone(raw), { context, bundle, binding } = saved;
    if (Object.keys(saved).sort().join('|') !== 'binding|bundle|context|status'
      || Object.keys(binding).sort().join('|') !== 'bundleHash|contextHash|contractHash|freezeId'
      || JSON.stringify(context).length > 32000 || JSON.stringify(bundle).length > 64000
      || binding.freezeId !== receipt.freezeId || binding.contractHash !== receipt.contractHash
      || context.contractHash !== receipt.contractHash || context.originQuestionMessageId !== receipt.originQuestionMessageId
      || context.coverage !== 'complete_required' || binding.contextHash !== await argumentContextHash(context)
      || bundle.contextHash !== binding.contextHash || bundle.contractHash !== binding.contractHash || bundle.bundleHash !== binding.bundleHash
      || context.rubricHash !== await argumentContextHash(intent.referenceRubric)
      || await argumentContextHash(context.assessment) !== await argumentContextHash(intent.assessment)
      || JSON.stringify(context.frames.map(frame => frame.knowledgeTarget)) !== JSON.stringify(intent.knowledgeTargets)) return hold('frozen_reference_changed');
    const { bundleHash, ...bundleBody } = bundle;
    if (await argumentContextHash(bundleBody) !== bundleHash) return hold('frozen_reference_changed');
    // Independent authenticated reads, not self-hashes, are the authority. Hashes
    // only bind the SAME retained view across extraction and semantic review.
    const savedHash = await argumentContextHash(saved);
    const adapter: FrozenReferenceShadowModel = {
      extract,
      prepareReview: input => { buildFrozenPropositionReferenceInput(input, bundle); },
      review: async (input, abortSignal) => readFrozenPropositionReferenceOutput(
        await review(structuredClone(input), structuredClone(bundle), abortSignal), input, bundle),
    };
    return await evaluateFrozenReviewReferenceShadow({ ...answer, evidence: { ...answer.evidence, questionIntent: intent } }, {
      readReference: async originalIntent => {
        const reply = await read(structuredClone(originalIntent));
        if (reply.status !== 'ready') throw new Error('frozen_reference_unavailable');
        if (await argumentContextHash(reply) !== savedHash) throw new Error('frozen_reference_changed');
        return { status: 'ready', context: structuredClone(reply.context) };
      },
    }, adapter, { signal, timeoutMs: modelTimeout, readTimeoutMs: readTimeout,
      inferenceAtomicity: FROZEN_SELECTED_ENDPOINT_POLICY,
      propositionBinding: { freezeId: binding.freezeId, contextHash: binding.contextHash, bundleHash: binding.bundleHash } });
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    return hold(['shadow_aborted', 'shadow_timeout', 'frozen_reference_changed'].includes(code) ? code : 'propositions_unavailable');
  }
}
