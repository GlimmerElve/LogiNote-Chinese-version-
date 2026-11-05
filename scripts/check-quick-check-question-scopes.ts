import assert from 'node:assert/strict';
import { evaluateQuickCheck, applyQuickCheckAssessment, type QuickCheckCall } from '../src/services/quickCheck';
import { createSunkCostCard, sunkCostNote, sunkCostAnswers, sunkCostEvaluationFixture } from './fixtures/quick-check-sunk-cost';

globalThis.fetch = async () => assert.fail('No network or real vault in scope tests');
const card = await createSunkCostCard();
const original = JSON.stringify(sunkCostNote);
let calls = 0;
const call: QuickCheckCall = async request => {
  calls++;
  assert.ok(!request.userInput.includes('privateAnswer') && !request.userInput.includes('optionId'), 'generation keys never leak to grading');
  assert.equal(JSON.parse(request.userInput).questionTasks.length, 3);
  return { content: JSON.stringify(sunkCostEvaluationFixture(request)) };
};
const assessment = await evaluateQuickCheck(card, sunkCostAnswers, { call });
assert.equal(calls, 1);
assert.equal(assessment.questionEvaluations?.length, 3);
const applied = applyQuickCheckAssessment([sunkCostNote], card, assessment);
assert.ok(applied.applied);
const [first, second, third] = applied.result.details;
assert.match(first.explanation, /600−500=100/u); assert.doesNotMatch(first.explanation, /选择B|本题选择/u);
assert.equal(second.correct, false); assert.match(second.referenceAnswer!, /^D\./u);
assert.equal(third.correct, true); assert.match(third.referenceAnswer!, /^B\./u);
assert.doesNotMatch(second.explanation, /未对齐/u);
const state = applied.notes[0].dsrState!.masteryShadow!;
assert.equal(state.layers.concept.criteria!.concept_accuracy.independentPasses, 1, 'two questions cannot create two independent passes');
assert.equal(state.layers.concept.criteria!.concept_application.state, 'needs_review');
assert.equal(state.layers.concept.criteria!.concept_boundary.state, 'needs_review');
assert.equal(applyQuickCheckAssessment(applied.notes, card, assessment).notes, applied.notes);
assert.equal(JSON.stringify(sunkCostNote), original);

// A missing/bad Q1 scope never suppresses a grounded Q2 answer and Q3 verdict.
for (const scenario of ['missing', 'foreign_evidence', 'wrong_scope'] as const) {
  const held = await evaluateQuickCheck(card, sunkCostAnswers, { call: async request => {
    const raw = sunkCostEvaluationFixture(request), first = raw.questionEvaluations[0];
    if (scenario === 'missing') raw.questionEvaluations.shift();
    else if (scenario === 'foreign_evidence') first.result.evidence[0].quote = raw.questionEvaluations[2].result.evidence[0].quote;
    else for (const baseline of first.result.baselines) baseline.scopeIds = ['Q3'];
    return { content: JSON.stringify(raw) };
  } });
  const result = applyQuickCheckAssessment([sunkCostNote], card, held);
  assert.equal(result.result.details[1].correct, false); assert.match(result.result.details[1].referenceAnswer!, /^D\./u);
  assert.equal(result.result.details[2].correct, true);
  assert.equal(result.notes[0].dsrState!.masteryShadow!.layers.concept.criteria!.concept_application.state, 'unassessed');
  assert.equal(held.questionEvaluations![0].evaluation.criteria.find(row => row.id === 'concept_application')!.state, 'unverifiable');
}
const wrongKeyCard = await createSunkCostCard(sunkCostNote, true);
const corrected = await evaluateQuickCheck(wrongKeyCard, sunkCostAnswers, { call });
const correctedResult = applyQuickCheckAssessment([sunkCostNote], wrongKeyCard, corrected).result;
assert.equal(correctedResult.details[1].correct, false, 'a wrong generation key cannot overturn independent reference-grounded grading');
assert.match(correctedResult.details[1].referenceAnswer!, /^D\./u);
const saved = JSON.parse(JSON.stringify(assessment));
assert.equal(applyQuickCheckAssessment([sunkCostNote], card, saved).result.details[1].referenceAnswer, second.referenceAnswer);
console.log('PASS one-call per-question grading; 800/500/600 regression; separate answers; scope/evidence isolation; corrected choice key; one pass per criterion; save/replay. No cloud/formal writes.');
