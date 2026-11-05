import assert from 'node:assert/strict';
import { REVIEW_DUAL_DATASET } from './review-dual-dataset';
import { prepareReviewDualFixture } from './review-dual-fixture';
import { evaluateReviewDual, type ReviewDualOutcome } from './review-dual-evaluation';
import { evaluateReviewComparisonPacket } from '../src/services/reviewComparison/semanticEvaluator';
import { createReviewSemanticModel } from '../src/services/reviewComparison/semanticClient';
import { validateReviewDualRequest, validateReviewDualReplayInput, reviewDualWireValue } from './review-dual-transport';

const beforeFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('No network in evaluation checks');
try {
  assert.equal(REVIEW_DUAL_DATASET.length, 28); assert.equal(new Set(REVIEW_DUAL_DATASET.map((c) => c.id)).size, 28);
  assert.ok(REVIEW_DUAL_DATASET.every((c) => c.origin === 'synthetic' && c.annotationStatus === 'assistant_draft'));
  const familyCount = (family: string) => REVIEW_DUAL_DATASET.filter((c) => c.family === family).length;
  assert.deepEqual(['definition', 'judgment', 'contradiction', 'reasoning', 'growth', 'boundary'].map(familyCount), [4, 4, 3, 3, 6, 8]);
  const held: ReviewDualOutcome[] = [];
  for (const c of REVIEW_DUAL_DATASET) {
    const fixture = await prepareReviewDualFixture(c);
    const again = await prepareReviewDualFixture(c);
    assert.equal(fixture.packet.packetId, again.packet.packetId);
    assert.equal(fixture.packet.answer.text, c.answer);
    assert.equal(fixture.packet.questionIntent.questionMessageId, 'question1');
    assert.equal(fixture.packet.references.length, c.references.length);
    assert.deepEqual(fixture.packet.references.map((s) => s.text), c.references);
    assert.equal(fixture.packet.personal.status, c.personal ? 'ready' : 'not_requested');
    const result = await evaluateReviewComparisonPacket(fixture.packet, fixture.dependencies,
      createReviewSemanticModel(async (request) => {
        const input = JSON.parse(request.userInput);
        assert.equal(JSON.stringify(input).includes('"expected"'), false);
        assert.equal(JSON.stringify(input).includes('"rationale"'), false);
        assert.deepEqual(Object.keys(input).sort(), ['answer', 'knowledgeTargets', 'packetId', 'questionText']);
        return { content: JSON.stringify({ version: 1, packetId: fixture.packet.packetId, claims: [], edges: [], requirements: [] }) };
      }));
    assert.equal(result.writes, 'disabled');
    held.push({ id: c.id, result, requests: 1 });

    // Reach BOTH stages for every fixture, including personal graphs and document optional fields.
    // The old assert against the pre-serialization object only tested the extraction-only path.
    let stages = 0;
    const both = await evaluateReviewComparisonPacket(fixture.packet, fixture.dependencies, createReviewSemanticModel(async (request) => {
      const input = validateReviewDualRequest(request, ++stages, fixture.packet);
      validateReviewDualReplayInput(request, structuredClone(request));
      const tampered = structuredClone(request);
      tampered.userInput = JSON.stringify(stages === 1 ? { ...input, questionText: '篡改问题' }
        : { ...input, packet: { ...input.packet, questionText: '篡改问题' } });
      assert.throws(() => validateReviewDualRequest(tampered, stages, fixture.packet));
      assert.throws(() => validateReviewDualReplayInput(request, tampered), /replay_input_changed/);
      return { content: JSON.stringify(stages === 1 ? { version: 1, packetId: fixture.packet.packetId,
        claims: [{ id: 'A1', role: 'fact', quote: fixture.packet.answer.text }], edges: [], requirements: [] }
        : { version: 1, packetId: fixture.packet.packetId, referenceAudit: {
          status: 'compatible', sourceIds: fixture.packet.references.map((s) => s.sourceId) }, alignments: [], edgeChecks: [], personalLinks: [] }) };
    }));
    assert.equal(stages, 2);
    assert.equal(both.reasons.includes('semantic_model_unavailable'), false);
    assert.equal(both.writes, 'disabled');
    if (c.id === 'G01') assert.throws(() => assert.deepEqual(reviewDualWireValue(fixture.packet), fixture.packet));
  }
  const rejectAll = evaluateReviewDual(REVIEW_DUAL_DATASET, held, 'cloud');
  assert.equal(rejectAll.completed, 28); assert.equal(rejectAll.protocolFailures, 0);
  assert.equal(rejectAll.pilotPassed, false); assert.equal(rejectAll.gates.definitions, false);
  assert.equal(rejectAll.gates.judgments, false); assert.equal(rejectAll.gates.actualContradictions, false);
  assert.equal(rejectAll.gates.newEvidenceGrowth, false); assert.equal(rejectAll.productionApproved, false);
  const missing = evaluateReviewDual(REVIEW_DUAL_DATASET, [], 'cloud');
  assert.equal(missing.completed, 0); assert.equal(missing.correct, 0); assert.equal(missing.pilotPassed, false);
  assert.throws(() => evaluateReviewDual(REVIEW_DUAL_DATASET, [held[0], held[0]], 'cloud'), /Invalid/);
  assert.throws(() => evaluateReviewDual(REVIEW_DUAL_DATASET, [{ ...held[0], id: 'unknown' }], 'cloud'), /Invalid/);
  assert.throws(() => evaluateReviewDual(REVIEW_DUAL_DATASET, [{ ...held[0], requests: 3 }], 'cloud'), /Invalid/);
  const wrong = structuredClone(held);
  wrong[0].result!.mastery[0].layers.concept = { status: 'contradicted', reasons: [], observations: [
    { kind: 'claim_alignment', claimIds: ['A1'], sourceIds: ['R1'], verdict: 'contradicted' },
  ] };
  assert.equal(evaluateReviewDual(REVIEW_DUAL_DATASET, wrong, 'cloud').unsafeOutputs, 1);
  const timeout = structuredClone(held); timeout[0].result!.reasons = ['semantic_timeout'];
  assert.equal(evaluateReviewDual(REVIEW_DUAL_DATASET, timeout, 'cloud').completed, 27);
  const local = evaluateReviewDual(REVIEW_DUAL_DATASET, held, 'local');
  assert.equal(local.pilotPassed, false); assert.equal(local.productionApproved, false);
  assert.equal(evaluateReviewDual(REVIEW_DUAL_DATASET, held, 'replay-candidate').pilotPassed, false);
  console.log('28 synthetic fixtures: stable packets, all references re-read, labels hidden from model input.');
  console.log('28 two-stage adapter checks passed: JSON optional fields preserved semantically; altered input rejected; replay input frozen.');
  console.log('Evaluation checks passed: no reject-all win, missing/duplicate/timeout/unsafe outputs counted, no production promotion.');
} finally { globalThis.fetch = beforeFetch; }
