import type { ReviewQuestionIntent } from '../reviewIntent.ts';
import { parseReviewQuestionIntent } from '../reviewIntentValidation.ts';
import { reviewSnapshotHash, resolveReviewPersonalSnapshot } from './packet.ts';
import { readReviewPerformanceGraph } from './performanceGraph.ts';
import { evaluateFrozenReviewReferenceShadow, type FrozenReferenceShadowDependencies,
  type FrozenReferenceShadowModel, type FrozenReferenceShadowResult } from './frozenReferenceShadow.ts';
import { buildReviewPersonalDisclosure, type ReviewPersonalDisclosureBudget,
  type ReviewPersonalDisclosureDependencies, type ReviewPersonalDisclosureResult } from './personalDisclosure.ts';
import type { ReviewComparisonAnswer, ReviewComparisonPacket } from './types.ts';
import type { ReviewPerformanceGraph } from './semanticTypes.ts';
import type { CognitionFile } from '../cognition/types.ts';

export interface ReviewProgressiveShadowDependencies extends FrozenReferenceShadowDependencies, ReviewPersonalDisclosureDependencies {}
export interface ReviewProgressiveShadowOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  readTimeoutMs?: number;
  /** May only lower personal disclosure's fixed hard limits. Never permits truncation. */
  personalBudget?: Partial<ReviewPersonalDisclosureBudget>;
}
export type ReviewProgressivePersonalResult = ReviewPersonalDisclosureResult
  | { status: 'held'; reasonCode: 'extraction_unavailable' | 'explicit_model_required' | 'shadow_aborted' | 'shadow_timeout' };
export interface ReviewProgressiveShadowResult {
  version: 1;
  protocol: 'review-progressive-shadow-v1';
  referenceShadow: FrozenReferenceShadowResult;
  personalDisclosure: ReviewProgressivePersonalResult;
  /** Same answer extraction, with ONLY packetId adapted and then independently revalidated. */
  normalizedGraph?: ReviewPerformanceGraph;
  writes: 'disabled';
  scoreWrite: 'disabled';
  cognitionWrite: 'disabled';
  growthProposals: 'not_generated';
  personalModelRequests: 0;
  /** Actual invocations across both routes; fallback extraction is not hidden in reference counts. */
  modelRequests: { sharedExtract: number; reference: number; total: number; limit: 2 };
}
const HASH = /^[a-f0-9]{64}$/u;
function unavailableReference(reason: string, packet?: ReviewComparisonPacket): FrozenReferenceShadowResult {
  const consulted = packet?.answer?.consultedMaterialIds;
  const hint = packet?.answer?.hintLevel ?? 0;
  return { version: 1, protocol: 'review-frozen-reference-shadow-v1', evaluationId: 'unavailable', status: 'held',
    reasons: [reason], observations: [], frames: [], evidence: Array.isArray(consulted) && consulted.length || hint >= 3
      ? 'assisted_not_independent' : hint ? 'assisted' : 'independent',
    scope: 'frozen_question_items', semanticTruth: 'not_certified', scoreWrite: 'disabled', cognitionWrite: 'disabled',
    modelRequests: { extract: 0, reference: 0, total: 0, limit: 2 } };
}
function result(referenceShadow: FrozenReferenceShadowResult, personalDisclosure: ReviewProgressivePersonalResult,
  normalizedGraph?: ReviewPerformanceGraph, fallbackExtracts = 0): ReviewProgressiveShadowResult {
  const sharedExtract = referenceShadow.modelRequests.extract + fallbackExtracts;
  const reference = referenceShadow.modelRequests.reference;
  return { version: 1, protocol: 'review-progressive-shadow-v1', referenceShadow, personalDisclosure,
    ...(normalizedGraph ? { normalizedGraph } : {}), writes: 'disabled', scoreWrite: 'disabled', cognitionWrite: 'disabled',
    growthProposals: 'not_generated', personalModelRequests: 0, modelRequests: { sharedExtract, reference, total: sharedExtract + reference, limit: 2 } };
}
const timeoutOf = (value: number | undefined, fallback: number, max: number) => Number.isFinite(value)
  ? Math.max(1, Math.min(max, Math.floor(value!))) : fallback;
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
  })]); } finally { if (timer) clearTimeout(timer); signal?.removeEventListener('abort', stop); }
}
/** Pre-model authority check for personal-only extraction; no context expansion or model-generated probe claims. */
async function checkFrozenPersonal(packet: ReviewComparisonPacket, dependencies: ReviewPersonalDisclosureDependencies):
  Promise<Extract<ReviewProgressivePersonalResult, { status: 'held' }> | null> {
  const hold = (reasonCode: Extract<ReviewProgressivePersonalResult, { status: 'held' }>['reasonCode']) => ({ status: 'held' as const, reasonCode });
  if (JSON.stringify(parseReviewQuestionIntent(packet.questionIntent)) !== JSON.stringify(packet.questionIntent)) return hold('packet_changed');
  const target = packet.questionIntent.cognitionTarget;
  if (!target) return hold('no_cognition_target');
  if (packet.personal.status === 'stale_target') return hold('stale_target');
  if (packet.personal.status === 'target_missing') return hold('target_missing');
  if (packet.personal.status !== 'ready') return hold('personal_unavailable');
  if (packet.personal.truncated !== false) return hold('incomplete_personal_context');
  if (packet.preparation.cognitionGrowth !== 'pending_alignment' || target.purpose === 'connect_nodes') return hold('personal_growth_held');
  if (!HASH.test(packet.personal.branchHash ?? '') || !packet.personal.graph?.nodes.some(node => node.id === target.nodeId)) return hold('target_missing');
  try {
    const file: CognitionFile = structuredClone(await dependencies.loadCognition());
    if (!file || file.schemaVersion !== 1 || !Number.isSafeInteger(file.revision) || file.revision < 0 || !Array.isArray(file.records)) return hold('personal_unavailable');
    const records = file.records.filter(record => record?.id === target.recordId);
    if (records.length !== 1) return hold('target_missing');
    const revisions = records[0].revisions;
    if (!Array.isArray(revisions) || !revisions.length || revisions.filter(revision => revision?.id === target.revisionId).length !== 1
      || revisions.at(-1)!.id !== target.revisionId) return hold('stale_target');
    const latest = revisions.at(-1)!;
    if (!Array.isArray(latest.branches) || latest.branches.filter(branch => branch?.id === target.branchId).length !== 1) return hold('target_missing');
    const current = await resolveReviewPersonalSnapshot(file, packet.questionIntent);
    if (current.status !== 'ready' || current.branchHash !== packet.personal.branchHash
      || await reviewSnapshotHash(current) !== await reviewSnapshotHash(packet.personal)) return hold('personal_snapshot_changed');
    return null;
  } catch (error) { return hold(error instanceof Error && error.message === 'shadow_aborted' ? 'shadow_aborted' : 'personal_unavailable'); }
}
function referenceAnswer(packet: ReviewComparisonPacket): ReviewComparisonAnswer {
  // Do not send even personal coordinate IDs/purpose to the reference reader or model.
  // Only the original fixed question selectors are retained; packet.references is never read.
  const value = packet.questionIntent;
  const original = parseReviewQuestionIntent({ version: value.version, questionMessageId: value.questionMessageId,
    knowledgeTargets: value.knowledgeTargets,
    ...(value.assessment ? { assessment: value.assessment } : {}),
    ...(value.referenceRubric ? { referenceRubric: value.referenceRubric } : {}),
    ...(value.referenceStructure ? { referenceStructure: value.referenceStructure } : {}) });
  const intent: ReviewQuestionIntent = { version: 1, questionMessageId: original.questionMessageId,
    knowledgeTargets: [...original.knowledgeTargets],
    ...(original.assessment ? { assessment: structuredClone(original.assessment) } : {}),
    ...(original.referenceRubric ? { referenceRubric: structuredClone(original.referenceRubric) } : {}),
    ...(original.referenceStructure ? { referenceStructure: structuredClone(original.referenceStructure) } : {}) };
  return { activityId: packet.activityId, questionText: packet.questionText, evidence: { messageId: packet.messageId,
    answer: packet.answer.text, hintLevel: packet.answer.hintLevel, consultedMaterialIds: [...packet.answer.consultedMaterialIds],
    targetKnowledgeNames: [...intent.knowledgeTargets], questionIntent: intent } };
}

/**
 * EXPLICIT, read-only shadow entry. One shared extraction is used to PREPARE
 * (not semantically review) the personal channel. Reference unavailability before
 * extraction permits one personal-only extraction after current target checks;
 * an attempted extraction NEVER retries. No search, default
 * provider, automatic UI invocation, official score or cognition-growth proposal.
 * A ready personal context certifies only freshness/structural disclosure, not
 * relevance, support, completeness of conditions or truth of any personal claim.
 */
export async function evaluateReviewProgressiveShadow(packetValue: ReviewComparisonPacket,
  dependencies: ReviewProgressiveShadowDependencies, model: FrozenReferenceShadowModel,
  options: ReviewProgressiveShadowOptions = {}): Promise<ReviewProgressiveShadowResult> {
  let packet: ReviewComparisonPacket;
  let capturedOptions: ReviewProgressiveShadowOptions;
  let answer: ReviewComparisonAnswer;
  let referenceDependencies: FrozenReferenceShadowDependencies;
  let personalDependencies: ReviewPersonalDisclosureDependencies;
  let capturedModel: FrozenReferenceShadowModel;
  try {
    // Capture caller-owned state and functions before the first await. Methods
    // cannot be swapped midway through hashing/model work by mutating containers.
    packet = structuredClone(packetValue);
    capturedOptions = { signal: options.signal, timeoutMs: options.timeoutMs, readTimeoutMs: options.readTimeoutMs,
      personalBudget: structuredClone(options.personalBudget) };
    if (!model || typeof model.extract !== 'function' || typeof model.review !== 'function')
      return result(unavailableReference('explicit_model_required', packet), { status: 'held', reasonCode: 'explicit_model_required' });
    capturedModel = { protocol: model.protocol, extract: model.extract.bind(model), review: model.review.bind(model) };
    referenceDependencies = { readReference: typeof dependencies?.readReference === 'function'
      ? dependencies.readReference.bind(dependencies) : async () => { throw new Error('frozen_reference_unavailable'); } };
    const personalLoader: () => Promise<CognitionFile> = typeof dependencies?.loadCognition === 'function'
      ? dependencies.loadCognition.bind(dependencies) : async () => { throw new Error('personal_unavailable'); };
    personalDependencies = { loadCognition: async () => {
      const file = await bounded(() => personalLoader(), timeoutOf(capturedOptions.readTimeoutMs, 10000, 30000), capturedOptions.signal);
      if (capturedOptions.signal?.aborted) throw new Error('shadow_aborted');
      return structuredClone(file);
    } };
    const { packetId, snapshotHash, ...body } = packet;
    if (packet.version !== 1 || !HASH.test(snapshotHash) || packetId !== `review-comparison:${snapshotHash}`
      || await reviewSnapshotHash(body) !== snapshotHash) throw new Error('packet_changed');
    answer = referenceAnswer(packet);
    if (!packet.activityId || !packet.messageId || !packet.questionText.trim() || packet.questionText.length > 4000
      || !packet.answer.text.trim() || packet.answer.text.length > 20000 || ![0, 1, 2, 3, 4].includes(packet.answer.hintLevel)
      || packet.answer.consultedMaterialIds.length > 30 || packet.answer.consultedMaterialIds.some(id => typeof id !== 'string' || !id.trim())) throw new Error('packet_changed');
  } catch {
    return result(unavailableReference('packet_changed'), { status: 'held', reasonCode: 'packet_changed' });
  }
  const reference = await evaluateFrozenReviewReferenceShadow(answer, referenceDependencies, capturedModel,
    { signal: capturedOptions.signal, timeoutMs: capturedOptions.timeoutMs, readTimeoutMs: capturedOptions.readTimeoutMs });
  let fallbackExtracts = 0;
  let extractedGraph = reference.graph;
  let extractionPacketId = reference.result.evaluationId;
  if (capturedOptions.signal?.aborted) return result(reference.result, { status: 'held', reasonCode: 'shadow_aborted' });
  if (!extractedGraph && reference.result.modelRequests.extract === 0) {
    let held: Extract<ReviewProgressivePersonalResult, { status: 'held' }> | null;
    try { held = await checkFrozenPersonal(packet, personalDependencies); }
    catch { held = { status: 'held', reasonCode: 'personal_unavailable' }; }
    if (held) return result(reference.result, held);
    if (capturedOptions.signal?.aborted) return result(reference.result, { status: 'held', reasonCode: 'shadow_aborted' });
    try {
      // Binding and payload contain ONLY original shared answer-extraction fields.
      // Neither reference receipts/material nor personal IDs/old text/purpose enter.
      const shared = { questionText: packet.questionText, answer: structuredClone(packet.answer),
        knowledgeTargets: [...answer.evidence.questionIntent.knowledgeTargets],
        ...(answer.evidence.questionIntent.assessment ? { assessment: structuredClone(answer.evidence.questionIntent.assessment) } : {}) };
      extractionPacketId = `progressive-extract:${await reviewSnapshotHash(shared)}`;
      if (capturedOptions.signal?.aborted) throw new Error('shadow_aborted');
      fallbackExtracts++;
      const extracted = await bounded(signal => capturedModel.extract({ ...structuredClone(shared), packetId: extractionPacketId }, signal),
        timeoutOf(capturedOptions.timeoutMs, 45000, 60000), capturedOptions.signal);
      extractedGraph = readReviewPerformanceGraph(extracted, { ...packet, packetId: extractionPacketId });
    } catch (error) {
      const code = error instanceof Error && ['shadow_aborted', 'shadow_timeout'].includes(error.message)
        ? error.message as 'shadow_aborted' | 'shadow_timeout' : 'extraction_unavailable';
      return result(reference.result, { status: 'held', reasonCode: code }, undefined, fallbackExtracts);
    }
  }
  if (!extractedGraph) return result(reference.result, { status: 'held', reasonCode: 'extraction_unavailable' }, undefined, fallbackExtracts);
  let normalizedGraph: ReviewPerformanceGraph;
  try {
    if (extractedGraph.packetId !== extractionPacketId) throw new Error('extraction_binding_changed');
    const adapted = structuredClone(extractedGraph);
    adapted.packetId = packet.packetId; // No answer, claim, edge, quote, question or requirement changes.
    normalizedGraph = readReviewPerformanceGraph(adapted, packet);
  } catch {
    return result(reference.result, { status: 'held', reasonCode: 'invalid_performance_graph' }, undefined, fallbackExtracts);
  }
  if (capturedOptions.signal?.aborted)
    return result(reference.result, { status: 'held', reasonCode: 'shadow_aborted' }, normalizedGraph, fallbackExtracts);
  // Reference review failure/staleness is NOT personal evidence or permission;
  // personal readiness depends solely on its original snapshot/current authority.
  const personal = await buildReviewPersonalDisclosure(packet, normalizedGraph, personalDependencies, capturedOptions.personalBudget);
  if (capturedOptions.signal?.aborted)
    return result(reference.result, { status: 'held', reasonCode: 'shadow_aborted' }, normalizedGraph, fallbackExtracts);
  return result(reference.result, personal, normalizedGraph, fallbackExtracts);
}
