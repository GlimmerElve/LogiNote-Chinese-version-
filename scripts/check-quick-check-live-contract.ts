import assert from 'node:assert/strict';
import { evaluateQuickCheck, applyQuickCheckAssessment, type QuickCheckAssessment } from '../src/services/quickCheck';
import { parseQuickCheckQuestionEvaluations } from '../src/services/quickCheck/evaluation';
import { createSunkCostCard, sunkCostNote, sunkCostAnswers, sunkCostEvaluationFixture } from './fixtures/quick-check-sunk-cost';

globalThis.fetch = async () => assert.fail('No network or real vault in live-contract tests');
const original = JSON.stringify(sunkCostNote), card = await createSunkCostCard();
const receipt = await evaluateQuickCheck(card, sunkCostAnswers, { call: async request => ({ content: JSON.stringify(sunkCostEvaluationFixture(request)) }) });
// The flat receipt is a historical transport, not an acceptable new live answer.
const legacy = structuredClone(receipt.evaluation);
assert.throws(() => parseQuickCheckQuestionEvaluations(legacy, receipt.input, card, receipt.answers), /旧协议/u);
assert.throws(() => parseQuickCheckQuestionEvaluations({ ...legacy, replay: true, answerKeyPolicy: 'legacy' }, receipt.input, card, receipt.answers), /旧协议/u);
let calls = 0;
await assert.rejects(() => evaluateQuickCheck(card, sunkCostAnswers, { call: async request => {
  calls++;
  if (calls === 2) {
    const input = JSON.parse(request.userInput);
    assert.match(input.recovery.problem, /旧协议/u);
    assert.ok(!request.userInput.includes('privateAnswer'), 'repair never supplies the generation key');
  }
  return { content: JSON.stringify({ ...legacy, replay: true, answerKeyPolicy: 'legacy' }) };
} }), /旧协议/u);
assert.equal(calls, 2, 'at most one repair; no legacy fallback or silent update');
assert.equal(sunkCostNote.dsrState, undefined);

// A model can repair its outer transport once and then supply real per-question
// keys. Such an evaluation is live/independent, not downgraded to historical mode.
calls = 0;
const repaired = await evaluateQuickCheck(card, sunkCostAnswers, { call: async request => {
  calls++;
  return { content: JSON.stringify(calls === 1 ? legacy : sunkCostEvaluationFixture(request)) };
} });
assert.equal(calls, 2);
assert.ok(repaired.questionEvaluations!.every(row => row.answerKeyPolicy === 'independent'));
assert.equal(repaired.questionEvaluations!.find(row => row.questionId === 'Q2')!.answerKey!.optionId, 'D');
const liveCommit = applyQuickCheckAssessment([sunkCostNote], card, repaired);
assert.equal(liveCommit.result.details[1].correct, false);
assert.equal(liveCommit.result.details[2].correct, true);

// Missing independent keys cannot be repaired by model-supplied legacy flags.
calls = 0;
const missing = await evaluateQuickCheck(card, sunkCostAnswers, { call: async request => {
  calls++;
  const raw: any = sunkCostEvaluationFixture(request);
  for (const row of raw.questionEvaluations) if (row.questionId === 'Q2') {
    row.answerKeyPolicy = 'legacy'; delete row.answerKey;
  }
  return { content: JSON.stringify(raw) };
} });
assert.equal(calls, 2);
const missingCommit = applyQuickCheckAssessment([sunkCostNote], card, missing);
assert.equal(missingCommit.result.details[1].correct, undefined);
assert.equal(missingCommit.result.details[1].referenceAnswer, undefined);
assert.equal(missingCommit.notes[0].dsrState!.masteryShadow!.layers.concept.criteria!.concept_boundary.state, 'unassessed');

// Historical replay is an explicit local mode, never inferred from a network
// response. Both old flat and locally tagged per-question receipts remain usable.
const oldRows = parseQuickCheckQuestionEvaluations(legacy, receipt.input, card, receipt.answers, true);
assert.ok(oldRows.every(row => row.answerKeyPolicy === 'legacy'));
assert.equal(oldRows.find(row => row.questionId === 'Q2')!.answerKey, undefined);
for (const historical of [
  { ...receipt, questionEvaluations: undefined, evaluation: legacy },
  { ...receipt, questionEvaluations: oldRows },
] satisfies QuickCheckAssessment[]) {
  const committed = applyQuickCheckAssessment([sunkCostNote], card, JSON.parse(JSON.stringify(historical)));
  assert.ok(committed.applied, 'old local receipts can replay, without making new network evaluations permissive');
  assert.match(committed.result.details[1].referenceAnswer!, /^D\./u);
  assert.equal(applyQuickCheckAssessment(committed.notes, card, historical).notes, committed.notes);
}
const skipped = await evaluateQuickCheck(card, [], { call: async () => assert.fail('skip all uses no model or legacy placeholder') });
assert.deepEqual(skipped.questionEvaluations, []);
assert.equal(applyQuickCheckAssessment([sunkCostNote], card, skipped).applied, false);
assert.equal(JSON.stringify(sunkCostNote), original);
console.log('PASS strict live protocol, bounded protocol repair, independent closed-answer keys, forged legacy flags rejected, historical replay compatibility, skip handling and idempotent save. Synthetic only.');
