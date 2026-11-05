import assert from 'node:assert/strict';
import type { LlmCallRequest } from '../src/types';
import type { ReviewComparisonPacket } from '../src/services/reviewComparison/types';
import { REVIEW_DUAL_ALIGNMENT_PROMPT, REVIEW_PERFORMANCE_GRAPH_PROMPT } from '../src/services/reviewComparison/semanticPrompts';
import { REVIEW_BOUND_ALIGNMENT_PROMPT } from '../src/services/reviewComparison/boundPrompts';
import { buildReviewBoundInput } from '../src/services/reviewComparison/boundProtocol';
import type { ReviewPerformanceGraph } from '../src/services/reviewComparison/semanticTypes';
import { buildReviewAnchoredChannel, reviewAnchoredChannels } from '../src/services/reviewComparison/anchoredProtocol';
import { REVIEW_REFERENCE_ANCHORS_PROMPT, REVIEW_PERSONAL_ANCHORS_PROMPT } from '../src/services/reviewComparison/anchoredPrompts';

/** Compare the actual JSON wire representation; optional undefined fields are not transmitted. */
export const reviewDualWireValue = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

export function validateReviewDualRequest(request: LlmCallRequest, stage: number, packet: ReviewComparisonPacket) {
  assert.ok(stage === 1 || stage === 2, 'Cloud contract changed');
  assert.ok(request.skipMemoryInjection && request.skipProfileInjection);
  assert.equal(request.workflow, 'review-scoring');
  assert.equal(request.systemPromptOverride, stage === 1 ? REVIEW_PERFORMANCE_GRAPH_PROMPT : REVIEW_DUAL_ALIGNMENT_PROMPT);
  assert.equal(request.maxTokensOverride, stage === 1 ? 4096 : 8192);
  const input = JSON.parse(request.userInput);
  assert.deepEqual(Object.keys(input).sort(), stage === 1
    ? ['answer', 'knowledgeTargets', 'packetId', 'questionText', ...(packet.questionIntent.assessment !== undefined ? ['assessment'] : [])].sort()
    : ['graph', 'packet']);
  if (stage === 1) assert.deepEqual(input, reviewDualWireValue({ packetId: packet.packetId,
    questionText: packet.questionText, answer: packet.answer, knowledgeTargets: packet.questionIntent.knowledgeTargets,
    ...(packet.questionIntent.assessment !== undefined ? { assessment: packet.questionIntent.assessment } : {}) }));
  else assert.deepEqual(input.packet, reviewDualWireValue(packet));
  return input;
}

/** Independent reconstruction prevents a model-facing slot from changing packet/graph coordinates. */
export async function validateReviewDualBoundRequest(
  request: LlmCallRequest, stage: number, packet: ReviewComparisonPacket, graph?: ReviewPerformanceGraph,
) {
  if (stage === 1) return validateReviewDualRequest(request, stage, packet);
  assert.equal(stage, 2); assert.ok(graph, 'Extraction graph missing');
  assert.ok(request.skipMemoryInjection && request.skipProfileInjection);
  assert.equal(request.workflow, 'review-scoring');
  assert.equal(request.systemPromptOverride, REVIEW_BOUND_ALIGNMENT_PROMPT);
  assert.equal(request.maxTokensOverride, 8192);
  const input = JSON.parse(request.userInput);
  assert.deepEqual(input, reviewDualWireValue(await buildReviewBoundInput(packet, graph)));
  return input;
}

/** Reconstruct the channels that can actually issue a request; rejected input channels issue none. */
export async function validateReviewDualAnchoredRequest(request: LlmCallRequest, stage: number, packet: ReviewComparisonPacket, graph?: ReviewPerformanceGraph) {
  if (stage === 1) { assert.equal(request.thinkingMode, 'disabled'); return validateReviewDualRequest(request, stage, packet); }
  assert.ok(stage === 2 || stage === 3); assert.ok(graph);
  const available = [];
  for (const channel of reviewAnchoredChannels(packet)) {
    try { available.push(await buildReviewAnchoredChannel(packet, graph, channel)); }
    catch (error) { if (!(error instanceof Error) || !['anchor_budget_exceeded', 'invalid_personal_graph'].includes(error.message)) throw error; }
  }
  const expected = available[stage - 2];
  assert.ok(expected, 'Unexpected extra review request');
  assert.equal(request.workflow, 'review-scoring'); assert.ok(request.skipMemoryInjection && request.skipProfileInjection);
  assert.equal(request.thinkingMode, 'disabled'); assert.equal(request.maxTokensOverride, 8192);
  assert.equal(request.systemPromptOverride, expected.channel === 'reference' ? REVIEW_REFERENCE_ANCHORS_PROMPT : REVIEW_PERSONAL_ANCHORS_PROMPT);
  const input = JSON.parse(request.userInput);
  assert.deepEqual(input, reviewDualWireValue(expected));
  return input;
}

/** Candidate replay cannot borrow a comparison made against a different packet or extracted graph. */
export function validateReviewDualReplayInput(request: LlmCallRequest, saved: LlmCallRequest) {
  assert.deepEqual(JSON.parse(request.userInput), JSON.parse(saved.userInput), 'replay_input_changed');
}
