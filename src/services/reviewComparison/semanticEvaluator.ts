import type { ReviewComparisonDependencies, ReviewComparisonPacket, ReviewComparisonSession } from './types';
import type { ReviewPerformanceGraph, ReviewSemanticComparison, ReviewSemanticModel, ReviewSemanticResult } from './semanticTypes';
import { readReviewPerformanceGraph } from './performanceGraph';
import { readReviewSemanticComparison, validateReviewAlignments } from './semanticValidation';
import { buildCognitionGrowthProposals, buildReviewMasteryShadow } from './semanticOutputs';
import { verifyReviewComparisonFreshness } from './packet';
import { buildReviewAnchoredChannel, readReviewAnchoredComparison, reviewAnchoredChannels } from './anchoredProtocol';

const safeErrors = new Set(['invalid_semantic_format', 'semantic_budget_exceeded', 'ungrounded_span', 'ambiguous_span',
  'wrong_semantic_packet', 'invalid_claim', 'duplicate_claim_span', 'invalid_edge', 'ungrounded_edge',
  'duplicate_edge', 'invalid_requirement', 'duplicate_requirement', 'incomplete_reference_audit',
  'invalid_alignment_target', 'invalid_personal_target', 'invalid_reference_target', 'duplicate_alignment',
  'invalid_edge_check', 'invalid_personal_link', 'invalid_model_json', 'semantic_timeout', 'semantic_aborted',
  'invalid_bound_format', 'wrong_bound_binding', 'unknown_bound_slot', 'duplicate_bound_slot', 'semantic_binding_budget_exceeded',
  'invalid_anchored_format', 'wrong_anchored_binding', 'unknown_anchored_slot', 'duplicate_anchored_slot', 'anchor_budget_exceeded',
  'invalid_anchor_interval', 'unknown_quote_anchor', 'wrong_quote_source', 'quote_anchor_too_long', 'quote_anchor_outside_claim',
  'review_channel_unavailable', 'split_protocol_requires_engine', 'invalid_personal_graph', 'frozen_requirement_mismatch',
  'invalid_reference_rubric', 'invalid_rubric_check', 'incomplete_rubric_checks', 'rubric_reference_outside_window']);
const codeFor = (error: unknown) => error instanceof Error && error.message === '复习检验任务无效' ? 'invalid_assessment_contract'
  : error instanceof Error && safeErrors.has(error.message) ? error.message : 'semantic_model_unavailable';

function held(packet: ReviewComparisonPacket, reasons: string[], graph?: ReviewPerformanceGraph): ReviewSemanticResult {
  return { version: 1, protocol: 'review-dual-alignment-v1',
    evaluationId: `review-dual-v1:${packet.snapshotHash}`, packetId: packet.packetId, snapshotHash: packet.snapshotHash,
    assistance: { hintLevel: packet.answer.hintLevel, consultedMaterialCount: packet.answer.consultedMaterialIds.length },
    status: 'held', reasons: [...new Set(reasons)], ...(graph ? { graph } : {}), alignments: [],
    growth: { status: 'held', reasons: [...new Set(reasons)], proposals: [] },
    mastery: packet.questionIntent.knowledgeTargets.map((knowledgeTarget) => ({
      knowledgeTarget, status: 'held', reasons: [...new Set(reasons)], scoreWrite: 'disabled',
      ...(packet.questionIntent.referenceRubric ? { referenceCoverage: { scope: 'question_items' as const, status: 'held' as const,
        items: packet.questionIntent.referenceRubric.items.filter((item) => item.knowledgeTarget === knowledgeTarget).map((item) => ({
          itemId: item.itemId, criterionId: item.criterionId, status: 'unobserved' as const, reasons: [...new Set(reasons)],
        })), reasons: [...new Set(reasons)] } } : {}),
      layers: {
        concept: { status: 'unassessed', observations: [], reasons: [...new Set(reasons)] },
        judgment: { status: 'unassessed', observations: [], reasons: [...new Set(reasons)] },
        reasoning: { status: 'unassessed', observations: [], reasons: [...new Set(reasons)] },
      },
    })), writes: 'disabled' };
}

/** One bounded call, no format repair, fallback model or implicit retry. Ignore results after cancellation. */
async function boundedCall<T>(run: (signal: AbortSignal) => Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new Error('semantic_aborted');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    const stop = (code: string) => { controller.abort(); reject(new Error(code)); };
    onAbort = () => stop('semantic_aborted');
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => stop('semantic_timeout'), timeoutMs);
  });
  try { return await Promise.race([stopped, run(controller.signal)]); }
  finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

/** Read-only stage C. Extract once, independently review the two channels, and re-read authority. */
export async function evaluateReviewComparisonPacket(
  input: ReviewComparisonPacket, dependencies: ReviewComparisonDependencies, model: ReviewSemanticModel,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ReviewSemanticResult> {
  const packet = structuredClone(input);
  let graph: ReviewPerformanceGraph | undefined;
  const split = model.protocol === 'isolated-anchors-v3';
  const requests = { extract: 0, reference: 0, personal: 0, total: 0, limit: 3 as const };
  const finishHeld = (reasons: string[]) => {
    const result = held(packet, reasons, graph);
    return split ? { ...result, protocol: 'review-isolated-anchors-v3' as const,
      evaluationId: `review-anchors-v3:${packet.snapshotHash}`, modelRequests: { ...requests } } : result;
  };
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, Math.min(60000, options.timeoutMs!)) : 45000;
  try {
    if (options.signal?.aborted) return finishHeld(['semantic_aborted']);
    const before = await verifyReviewComparisonFreshness(packet, dependencies);
    if (!before.fresh) return finishHeld(before.reasons);
    if (packet.questionIntent.referenceRubric && !split) return finishHeld(['rubric_requires_anchored_protocol']);
    if (packet.preparation.cognitionGrowth === 'held' && packet.preparation.mastery === 'held') {
      return finishHeld([...packet.preparation.growthReasons, ...packet.preparation.masteryReasons]);
    }
    const extracted = await boundedCall((signal) => {
      requests.extract++; requests.total++;
      return model.extract(structuredClone({
      packetId: packet.packetId, questionText: packet.questionText, answer: packet.answer,
      knowledgeTargets: packet.questionIntent.knowledgeTargets,
      ...(packet.questionIntent.assessment !== undefined ? { assessment: packet.questionIntent.assessment } : {}),
      }), signal);
    }, timeoutMs, options.signal);
    graph = readReviewPerformanceGraph(extracted, packet);
    if (!graph.claims.length) return finishHeld(['answer_claim_unobserved']);
    const between = await verifyReviewComparisonFreshness(packet, dependencies);
    if (!between.fresh) return finishHeld(between.reasons);
    if (split) {
      if (!model.reviewReference || !model.reviewPersonal) return finishHeld(['split_protocol_requires_engine']);
      const channels: NonNullable<ReviewSemanticResult['channels']> = {
        reference: { status: 'held', reasons: [...packet.preparation.masteryReasons] },
        personal: { status: packet.questionIntent.cognitionTarget ? 'held' : 'not_requested', reasons: [...packet.preparation.growthReasons] },
      };
      const comparison: ReviewSemanticComparison = { version: 1, packetId: packet.packetId,
        referenceAudit: { status: 'unknown', sourceIds: packet.references.map((s) => s.sourceId) }, alignments: [], edgeChecks: [], personalLinks: [] };
      for (const channel of reviewAnchoredChannels(packet)) {
        const fresh = await verifyReviewComparisonFreshness(packet, dependencies);
        if (!fresh.fresh) return finishHeld(fresh.reasons);
        try {
          const visible = await buildReviewAnchoredChannel(packet, graph, channel);
          const raw = await boundedCall((signal) => {
            if (requests.total >= 3 || requests[channel]) throw new Error('semantic_budget_exceeded');
            requests[channel]++; requests.total++;
            return channel === 'reference' ? model.reviewReference!(structuredClone(visible), signal) : model.reviewPersonal!(structuredClone(visible), signal);
          }, timeoutMs, options.signal);
          const part = await readReviewAnchoredComparison(raw, packet, graph, channel);
          comparison.alignments.push(...part.alignments); comparison.edgeChecks.push(...part.edgeChecks); comparison.personalLinks.push(...part.personalLinks);
          if (channel === 'reference') { comparison.referenceAudit = part.referenceAudit; comparison.rubricChecks = part.rubricChecks; }
          channels[channel] = { status: 'reviewed', reasons: [] };
        } catch (error) {
          const code = codeFor(error);
          // Service failure/cancellation stops new calls. A rejected channel format is not retried,
          // while the other independently scoped channel may still be reviewed once.
          if (['semantic_timeout', 'semantic_aborted', 'semantic_model_unavailable'].includes(code)) return finishHeld([code]);
          channels[channel] = { status: 'held', reasons: [code] };
        }
      }
      const fresh = await verifyReviewComparisonFreshness(packet, dependencies);
      if (!fresh.fresh) return finishHeld(fresh.reasons);
      if (options.signal?.aborted) return finishHeld(['semantic_aborted']);
      const observations = validateReviewAlignments(comparison, packet, graph);
      const growth = await buildCognitionGrowthProposals(packet, graph, comparison, observations);
      const mastery = buildReviewMasteryShadow(packet, graph, comparison, observations);
      if (channels.personal.status === 'held') growth.reasons = [...new Set([...growth.reasons, ...channels.personal.reasons])];
      if (channels.reference.status === 'held') for (const m of mastery) {
        m.reasons = [...new Set([...m.reasons, ...channels.reference.reasons])];
        if (m.referenceCoverage) m.referenceCoverage.reasons = [...new Set([...m.referenceCoverage.reasons, ...channels.reference.reasons])];
        for (const layer of Object.values(m.layers)) if (layer.status !== 'not_required') layer.reasons = [...new Set([...layer.reasons, ...channels.reference.reasons])];
      }
      if (options.signal?.aborted) return finishHeld(['semantic_aborted']);
      const finalFresh = await verifyReviewComparisonFreshness(packet, dependencies);
      if (!finalFresh.fresh) return finishHeld(finalFresh.reasons);
      if (options.signal?.aborted) return finishHeld(['semantic_aborted']);
      const useful = growth.status !== 'held' || mastery.some((m) => m.status === 'evidence_ready');
      return { version: 1, protocol: 'review-isolated-anchors-v3', evaluationId: `review-anchors-v3:${packet.snapshotHash}`,
        packetId: packet.packetId, snapshotHash: packet.snapshotHash, status: useful ? 'reviewed' : 'held',
        assistance: { hintLevel: packet.answer.hintLevel, consultedMaterialCount: packet.answer.consultedMaterialIds.length },
        reasons: [...new Set([...growth.reasons, ...mastery.flatMap((m) => m.reasons)])], graph, alignments: observations,
        growth, mastery, writes: 'disabled', channels, modelRequests: { ...requests } };
    }
    const reviewed = await boundedCall((signal) => model.compare({ packet: structuredClone(packet), graph: structuredClone(graph!) }, signal), timeoutMs, options.signal);
    const comparison = readReviewSemanticComparison(reviewed, packet, graph);
    const observations = validateReviewAlignments(comparison, packet, graph);
    const after = await verifyReviewComparisonFreshness(packet, dependencies);
    if (!after.fresh) return held(packet, after.reasons, graph);
    if (options.signal?.aborted) return held(packet, ['semantic_aborted'], graph);
    const growth = await buildCognitionGrowthProposals(packet, graph, comparison, observations);
    if (options.signal?.aborted) return held(packet, ['semantic_aborted'], graph);
    const mastery = buildReviewMasteryShadow(packet, graph, comparison, observations);
    const useful = growth.status !== 'held' || mastery.some((m) => m.status === 'evidence_ready');
    return { version: 1, protocol: 'review-dual-alignment-v1', evaluationId: `review-dual-v1:${packet.snapshotHash}`,
      packetId: packet.packetId, snapshotHash: packet.snapshotHash, status: useful ? 'reviewed' : 'held',
      assistance: { hintLevel: packet.answer.hintLevel, consultedMaterialCount: packet.answer.consultedMaterialIds.length },
      reasons: [...new Set([...growth.reasons, ...mastery.flatMap((m) => m.reasons)])],
      graph, alignments: observations, growth, mastery, writes: 'disabled' };
  } catch (error) { return finishHeld([codeFor(error)]); }
}

/** Explicit opt-in caller only; no automatic production or cloud invocation in packet preparation. */
export async function evaluateReviewComparisonSession(
  session: ReviewComparisonSession, dependencies: ReviewComparisonDependencies, model: ReviewSemanticModel,
  options: { signal?: AbortSignal; timeoutMs?: number; maxAnswers?: number } = {},
): Promise<ReviewSemanticResult[]> {
  const packets = structuredClone(session.packets);
  const count = Number.isFinite(options.maxAnswers) ? Math.max(0, Math.min(12, Math.floor(options.maxAnswers!))) : 3;
  const ids = packets.map((p) => `${p.activityId}:${p.messageId}`);
  const selected = count ? packets.slice(-count) : [];
  const results: ReviewSemanticResult[] = [];
  const skipped = (packet: ReviewComparisonPacket, reason: string): ReviewSemanticResult => {
    const result = held(packet, [reason]);
    return model.protocol === 'isolated-anchors-v3' ? { ...result, protocol: 'review-isolated-anchors-v3',
      evaluationId: `review-anchors-v3:${packet.snapshotHash}`,
      modelRequests: { extract: 0, reference: 0, personal: 0, total: 0, limit: 3 } } : result;
  };
  for (let index = 0; index < packets.length; index++) {
    const packet = packets[index];
    if (!count || !selected.includes(packet)) { results.push(skipped(packet, 'semantic_answer_budget_exceeded')); continue; }
    if (ids.indexOf(ids[index]) !== ids.lastIndexOf(ids[index])) { results.push(skipped(packet, 'duplicate_semantic_answer')); continue; }
    results.push(await evaluateReviewComparisonPacket(packet, dependencies, model, options));
  }
  return results;
}
