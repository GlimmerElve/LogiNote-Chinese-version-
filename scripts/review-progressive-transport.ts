import assert from 'node:assert/strict';
import type { LlmCallRequest, LlmCallResponse } from '../src/types.ts';
import { JSON_OBJECT_OUTPUT } from '../src/workflows/structuredOutput.ts';
import { argumentContextHash } from '../src/services/argumentContext/hash.ts';
import { FROZEN_REFERENCE_EXTRACTION_PROMPT } from '../src/services/reviewComparison/frozenExtractionPrompt.ts';
import { FROZEN_REFERENCE_SHADOW_PROMPT } from '../src/services/reviewComparison/frozenReferenceModel.ts';
import { FROZEN_REFERENCE_SHADOW_INPUT_LIMIT, type FrozenReferenceShadowInput } from '../src/services/reviewComparison/frozenReferenceShadow.ts';
import { buildFrozenReferenceTypedInputV4, type FrozenReferenceTypedInputV4 } from '../src/services/reviewComparison/frozenReferenceTyped.ts';
import { readReviewModelJson } from '../src/services/reviewComparison/semanticClient.ts';
import { readReviewPerformanceGraph } from '../src/services/reviewComparison/performanceGraph.ts';
import type { ReviewSemanticModel } from '../src/services/reviewComparison/semanticTypes.ts';
import type { ReviewProgressiveFixture } from './review-progressive-fixture.ts';

export interface ReviewProgressiveInputStats {
  stage: 'extract' | 'reference';
  inputChars: number;
  inputBytes: number;
  systemChars: number;
  systemBytes: number;
  totalChars: number;
  totalBytes: number;
  answerChars: number;
  frames: number;
  items: number;
  quotes: number;
  claims: number;
  edges: number;
  wireEdges: number;
  statementItems: number;
  inferenceItems: number;
}
export type ReviewProgressiveExtractionInput = Parameters<ReviewSemanticModel['extract']>[0];
export type ReviewProgressiveWireInput = ReviewProgressiveExtractionInput | FrozenReferenceTypedInputV4;
const wireValue = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
const byteLength = (value: string) => new TextEncoder().encode(value).length;

/** Independent reconstruction; no packet/reference DTO supplied by a model is trusted. */
export function buildReviewProgressiveExtractionInput(fixture: ReviewProgressiveFixture): ReviewProgressiveExtractionInput {
  return { packetId: fixture.evaluationId, questionText: fixture.packet.questionText, answer: structuredClone(fixture.packet.answer),
    knowledgeTargets: [...fixture.packet.questionIntent.knowledgeTargets], assessment: structuredClone(fixture.packet.questionIntent.assessment) };
}
export function buildReviewProgressiveReferenceInput(fixture: ReviewProgressiveFixture, extractionResponse: LlmCallResponse): FrozenReferenceShadowInput {
  const graph = readReviewPerformanceGraph(readReviewModelJson(extractionResponse), fixture.packet);
  assert.ok(graph.claims.length, 'progressive_reference_requires_user_claims');
  return { version: 1, protocol: 'review-frozen-reference-shadow-v1', evaluationId: fixture.evaluationId,
    taskContext: { questionText: fixture.packet.questionText, usage: 'question_context_only' },
    answer: { text: fixture.packet.answer.text, hintLevel: fixture.packet.answer.hintLevel,
      consultedMaterialCount: fixture.packet.answer.consultedMaterialIds.length },
    graph: { claims: graph.claims.map(({ quote: _quote, ...claim }) => claim),
      edges: graph.edges.map(({ quote: _quote, ...edge }) => edge) }, reference: structuredClone(fixture.context) };
}

/**
 * Closed actual adapter request validation. Rejects extras even when undefined;
 * no profile/personal/gold/history/context slots, tools, fresh retrieval or wire
 * offsets can escape the independent reconstruction. This function never sends.
 */
export async function validateReviewProgressiveRequest(originalRequest: LlmCallRequest, stage: 1 | 2,
  originalFixture: ReviewProgressiveFixture, extractionResponse?: LlmCallResponse): Promise<{ input: ReviewProgressiveWireInput; stats: ReviewProgressiveInputStats }> {
  const request = structuredClone(originalRequest);
  assert.ok(stage === 1 || stage === 2, 'invalid_progressive_stage');
  assert.ok(request && typeof request === 'object' && !Array.isArray(request), 'invalid_progressive_request');
  assert.deepEqual(Object.keys(request).sort(), ['providerId', 'model', 'workflow', 'userInput', 'systemPromptOverride',
    'outputSchema', 'maxTokensOverride', 'thinkingMode', 'skipMemoryInjection', 'skipProfileInjection'].sort(), 'progressive_request_fields_changed');
  assert.equal(request.providerId, '', 'progressive_provider_override_forbidden');
  assert.equal(request.model, '', 'progressive_model_override_forbidden');
  assert.equal(request.workflow, 'review-scoring');
  assert.equal(request.skipMemoryInjection, true);
  assert.equal(request.skipProfileInjection, true);
  assert.equal(request.thinkingMode, 'disabled');
  assert.equal(request.maxTokensOverride, stage === 1 ? 4096 : 8192);
  assert.equal(request.systemPromptOverride, stage === 1 ? FROZEN_REFERENCE_EXTRACTION_PROMPT : FROZEN_REFERENCE_SHADOW_PROMPT);
  assert.deepEqual(request.outputSchema, JSON_OBJECT_OUTPUT);
  assert.ok(typeof request.userInput === 'string' && request.userInput.length > 0 && request.userInput.length <= FROZEN_REFERENCE_SHADOW_INPUT_LIMIT,
    'progressive_input_budget_exceeded');
  // Clone all read-only fixture fields before the first awaited hash. Functions
  // are not cloned or called; source rechecks remain the evaluator's own task.
  const fixture = { ...originalFixture, answer: structuredClone(originalFixture.answer), packet: structuredClone(originalFixture.packet),
    context: structuredClone(originalFixture.context) };
  const extraction = extractionResponse === undefined ? undefined : structuredClone(extractionResponse);
  const contextHash = await argumentContextHash(fixture.context);
  assert.equal(contextHash, fixture.contextHash, 'progressive_context_changed');
  const answer = fixture.answer, consulted = answer.evidence.consultedMaterialIds ?? [];
  const evaluationId = `frozen-reference:${await argumentContextHash({ activityId: answer.activityId, messageId: answer.evidence.messageId,
    questionText: answer.questionText, answer: answer.evidence.answer, hintLevel: answer.evidence.hintLevel, consulted, contextHash })}`;
  assert.equal(fixture.evaluationId, evaluationId, 'progressive_evaluation_binding_changed');
  assert.equal(fixture.packet.packetId, evaluationId, 'progressive_packet_changed');
  assert.equal(fixture.packet.questionText, answer.questionText, 'progressive_question_changed');
  assert.deepEqual(fixture.packet.answer, { text: answer.evidence.answer, hintLevel: answer.evidence.hintLevel, consultedMaterialIds: consulted }, 'progressive_answer_changed');
  assert.deepEqual(fixture.packet.questionIntent, { version: 1, questionMessageId: answer.evidence.questionIntent.questionMessageId,
    knowledgeTargets: answer.evidence.questionIntent.knowledgeTargets, assessment: answer.evidence.questionIntent.assessment }, 'progressive_task_changed');
  let expected: ReviewProgressiveWireInput, canonicalGraph: FrozenReferenceShadowInput['graph'] | undefined;
  if (stage === 1) {
    assert.equal(extraction, undefined, 'progressive_extract_response_unexpected');
    expected = buildReviewProgressiveExtractionInput(fixture);
  } else {
    assert.ok(extraction, 'progressive_extract_response_missing');
    const canonical = buildReviewProgressiveReferenceInput(fixture, extraction);
    canonicalGraph = canonical.graph;
    expected = buildFrozenReferenceTypedInputV4(canonical);
  }
  const input = JSON.parse(request.userInput);
  // Includes every nested wire field, per-source frozen identity, literal
  // quotation and namespace. Offsets remain host-owned canonical graph data.
  assert.deepEqual(input, wireValue(expected), 'progressive_wire_input_changed');
  const system = request.systemPromptOverride;
  const frameCount = stage === 2 ? fixture.context.frames.length : 0;
  const stats: ReviewProgressiveInputStats = { stage: stage === 1 ? 'extract' : 'reference',
    inputChars: request.userInput.length, inputBytes: byteLength(request.userInput), systemChars: system.length, systemBytes: byteLength(system),
    totalChars: request.userInput.length + system.length, totalBytes: byteLength(request.userInput) + byteLength(system),
    answerChars: fixture.packet.answer.text.length, frames: frameCount,
    items: stage === 2 ? fixture.context.frames.reduce((total, frame) => total + frame.items.length, 0) : 0,
    quotes: stage === 2 ? fixture.context.quotes.length : 0, claims: canonicalGraph?.claims.length ?? 0, edges: canonicalGraph?.edges.length ?? 0,
    wireEdges: stage === 2 ? (expected as FrozenReferenceTypedInputV4).user.edges.length : 0,
    statementItems: stage === 2 ? fixture.context.frames.reduce((total, frame) => total + frame.items.filter(item => item.criterionId !== 'inference_link').length, 0) : 0,
    inferenceItems: stage === 2 ? fixture.context.frames.reduce((total, frame) => total + frame.items.filter(item => item.criterionId === 'inference_link').length, 0) : 0 };
  assert.deepEqual(originalRequest, request, 'progressive_request_changed_during_validation');
  return { input: structuredClone(expected), stats };
}
