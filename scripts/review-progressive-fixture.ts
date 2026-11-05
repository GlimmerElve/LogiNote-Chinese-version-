import assert from 'node:assert/strict';
import type { ReviewQuestionIntent } from '../src/services/reviewIntent.ts';
import { parseReviewQuestionIntent } from '../src/services/reviewIntentValidation.ts';
import { argumentContextHash } from '../src/services/argumentContext/hash.ts';
import { buildArgumentReferenceDisclosure, type ArgumentReferenceDisclosureContext } from '../src/services/argumentContext/referenceDisclosure.ts';
import type { ReviewComparisonAnswer, ReviewComparisonPacket } from '../src/services/reviewComparison/types.ts';
import type { FrozenReferenceShadowDependencies } from '../src/services/reviewComparison/frozenReferenceShadow.ts';
import { createReferenceDisclosureFixture } from './reference-disclosure-fixture.ts';
import type { ReviewProgressiveCase } from './review-progressive-dataset.ts';

export interface ReviewProgressiveFixture {
  answer: ReviewComparisonAnswer;
  dependencies: FrozenReferenceShadowDependencies;
  /** Authenticated by the synthetic in-memory source fixture, never a production receipt. */
  context: ArgumentReferenceDisclosureContext;
  /** Independently reconstructed extraction packet, NOT a scoring or personal-library packet. */
  packet: ReviewComparisonPacket;
  evaluationId: string;
  contextHash: string;
  selectorsHash: string;
  sourceFingerprint: string;
}

const fixtureUuid = (hash: string) => `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;

/**
 * PURE SYNTHETIC preparation. No provider, filesystem, real vault, search, personal
 * graph, profile, scoring or model call. Expectations/annotations are not copied
 * into any answer, context, packet or model-facing field.
 */
export async function prepareReviewProgressiveFixture(original: ReviewProgressiveCase): Promise<ReviewProgressiveFixture> {
  // Capture only input fields before any awaited hashing/building. Gold stays outside.
  const { id, question, answer: answerText, hintLevel } = original;
  const fixtureOptions = structuredClone(original.fixture);
  const consulted = structuredClone(original.consultedMaterialIds);
  assert.equal(original.origin, 'synthetic', 'progressive_fixture_must_be_synthetic');
  assert.match(id, /^[A-Za-z0-9_-]{1,60}$/u, 'invalid_progressive_case_id');
  assert.ok(typeof question === 'string' && question.trim() && question.length <= 4000, 'invalid_progressive_question');
  assert.ok(typeof answerText === 'string' && answerText.trim() && answerText.length <= 20000, 'invalid_progressive_answer');
  assert.ok([0, 1, 2, 3, 4].includes(hintLevel), 'invalid_progressive_hint');
  assert.ok(Array.isArray(consulted) && consulted.length <= 30
    && consulted.every(value => typeof value === 'string' && value.trim()), 'invalid_progressive_consulted_materials');
  const source = await createReferenceDisclosureFixture(fixtureOptions);
  const frozen = structuredClone(source.frozen);
  assert.equal((await source.service.verify(frozen)).status, 'current', 'synthetic_reference_not_current');
  const reply = await buildArgumentReferenceDisclosure(frozen);
  assert.equal(reply.status, 'ready', 'synthetic_disclosure_not_ready');
  if (reply.status !== 'ready') throw new Error('synthetic_disclosure_not_ready');
  const context = structuredClone(reply.context);
  const selectorsHash = await argumentContextHash({ questionMessageId: frozen.originQuestionMessageId,
    knowledgeTargets: frozen.knowledgeTargets, assessment: frozen.assessment, referenceRubric: frozen.referenceRubric });
  const intent: ReviewQuestionIntent = parseReviewQuestionIntent({ version: 1,
    questionMessageId: frozen.originQuestionMessageId, knowledgeTargets: [...frozen.knowledgeTargets],
    assessment: structuredClone(frozen.assessment), referenceRubric: structuredClone(frozen.referenceRubric),
    referenceStructure: { version: 1, status: 'fixed', originQuestionMessageId: frozen.originQuestionMessageId,
      freezeId: fixtureUuid(await argumentContextHash({ kind: 'offline-progressive-receipt', id, contractHash: frozen.contractHash })),
      contractHash: frozen.contractHash, selectorsHash, reasons: [] } });
  const answer: ReviewComparisonAnswer = { activityId: `progressive-${id}`, questionText: question,
    evidence: { messageId: `answer-${id}`, answer: answerText, hintLevel, consultedMaterialIds: [...consulted],
      targetKnowledgeNames: [...intent.knowledgeTargets], questionIntent: structuredClone(intent) } };
  const contextHash = await argumentContextHash(context);
  // Independent canonical binding matches the engine without taking its output ID on trust.
  const evaluationId = `frozen-reference:${await argumentContextHash({ activityId: answer.activityId,
    messageId: answer.evidence.messageId, questionText: answer.questionText, answer: answer.evidence.answer,
    hintLevel: answer.evidence.hintLevel, consulted, contextHash })}`;
  const thinIntent: ReviewQuestionIntent = { version: 1, questionMessageId: intent.questionMessageId,
    knowledgeTargets: [...intent.knowledgeTargets], assessment: structuredClone(intent.assessment) };
  const packet: ReviewComparisonPacket = { version: 1, packetId: evaluationId, snapshotHash: '',
    activityId: answer.activityId, messageId: answer.evidence.messageId, questionText: answer.questionText, questionIntent: thinIntent,
    answer: { text: answer.evidence.answer, hintLevel, consultedMaterialIds: [...consulted] },
    personal: { status: 'not_requested', truncated: false }, references: [],
    coverage: { referencePresence: 'available', semanticCoverage: 'not_assessed', missingTargetNames: [] },
    preparation: { mastery: 'pending_alignment', cognitionGrowth: 'held', masteryReasons: [],
      growthReasons: ['not_requested'], warnings: [] } };
  const intentHash = await argumentContextHash(intent);
  const dependencies: FrozenReferenceShadowDependencies = {
    async readReference(requested) {
      // Model/caller-selected replacement standards can never enter this baseline.
      const captured = structuredClone(requested);
      if (await argumentContextHash(captured) !== intentHash)
        return { status: 'held', reasons: ['synthetic_receipt_changed'] };
      if ((await source.service.verify(frozen)).status !== 'current')
        return { status: 'held', reasons: ['synthetic_reference_changed'] };
      return { status: 'ready', context: structuredClone(context) };
    },
  };
  const sourceFingerprint = await argumentContextHash({ notes: source.notes, frozen });
  return { answer, dependencies, context: structuredClone(context), packet, evaluationId, contextHash, selectorsHash, sourceFingerprint };
}
