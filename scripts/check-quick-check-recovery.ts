import assert from 'node:assert/strict';
import type { LlmCallRequest } from '../src/types';
import { applyQuickCheckAssessment, evaluateQuickCheck } from '../src/services/quickCheck';
import { quickCheckReferenceQuotes } from '../src/services/quickCheck/referenceQuotes';
import { createSunkCostCard, sunkCostAnswers, sunkCostEvaluationFixture, sunkCostNote } from './fixtures/quick-check-sunk-cost';
import { QuickCheckStore } from '../src/components/quickCheck/store';
import { commitQuickCheckWrite, type QuickCheckWriteProgress } from '../src/services/ui/quickCheckWrite';
import { quickCheckDesignFixture, generateQuickCheckFixture as generateQuickCheck } from './fixtures/quick-check-design';

globalThis.fetch = async () => assert.fail('No cloud or real vault in recovery tests');
const card = await createSunkCostCard(), original = JSON.stringify(sunkCostNote);
const reference = { id: 'R1', tier: 3 as const, sourceLabel: '合成资料', quote: '边界：\n- 已经投入且不可收回。\n- 不包括未来投入。' };
const restored = quickCheckReferenceQuotes([{ referenceId: ' R1 ', quote: '边界：已经投入且不可收回。不包括未来投入。' }], [reference], ['R1']);
assert.equal(restored[0].quote, reference.quote);
for (const quote of ['边界：已经投入且不可收回。包括未来投入。', '边界：已经投入且可收回。', '原文没有的结论'])
  assert.throws(() => quickCheckReferenceQuotes([{ referenceId: 'R1', quote }], [reference], ['R1']), /无法定位/u);
assert.throws(() => quickCheckReferenceQuotes([{ referenceId: 'unknown', quote: '已经投入' }], [reference], ['R1']), /编号/u);
assert.throws(() => quickCheckReferenceQuotes([], [reference], ['R1']), /1至3段/u);

function compact(request: LlmCallRequest): any {
  const raw = sunkCostEvaluationFixture(request);
  return { ...raw, protocol: 'quick-check-evaluation-v3', questionEvaluations: raw.questionEvaluations.map(row => ({
    questionId: row.questionId, answerKey: row.answerKey,
    criteria: row.result.criteria.map(criterion => {
      const baseline = row.result.baselines.find(item => item.id === criterion.id)!;
      return { id: criterion.id, state: criterion.state, reason: criterion.reason,
        evidenceQuotes: criterion.evidenceIds.map(id => row.result.evidence.find(item => item.id === id)!.quote.slice(0, 240)),
        baseline: { scope: baseline.scope, applicability: baseline.applicability, coverage: baseline.coverage,
          rule: baseline.rule, referenceQuotes: baseline.referenceQuotes },
        ...(criterion.comparison ? { comparison: { requirement: criterion.comparison.requirement,
          finding: criterion.comparison.finding, scopeMatch: criterion.comparison.scopeMatch } } : {}) };
    }) })) };
}

// Compact protocol -> real parser -> reducer -> display -> pure save -> replay.
let calls = 0;
const assessment = await evaluateQuickCheck(card, sunkCostAnswers, { call: async request => {
  calls++;
  assert.equal(JSON.parse(request.userInput).protocol, 'quick-check-evaluation-v3');
  assert.ok(!request.userInput.includes('privateAnswer'));
  return { content: JSON.stringify(compact(request)) };
} });
assert.equal(calls, 1, 'valid evaluation is one request');
const committed = applyQuickCheckAssessment([sunkCostNote], card, assessment);
assert.ok(committed.applied);
assert.equal(committed.result.details[1].correct, false);
assert.equal(committed.result.details[2].correct, true);
assert.match(committed.result.details[1].referenceAnswer!, /^D\./u);
assert.equal(committed.notes[0].dsrState!.masteryShadow!.layers.concept.criteria!.concept_application.state, 'needs_review');
assert.equal(committed.notes[0].dsrState!.masteryShadow!.layers.concept.criteria!.concept_accuracy.independentPasses, 1);
assert.ok(committed.notes[0].dsrState!.lastReviewedAt);
assert.equal(committed.notes[0].dsrState!.reviewCount, 1);
assert.equal(applyQuickCheckAssessment(committed.notes, card, JSON.parse(JSON.stringify(assessment))).notes, committed.notes);

// Invalid JSON gets exactly one repair; same immutable card and answers, no key leakage.
calls = 0;
const repaired = await evaluateQuickCheck(card, sunkCostAnswers, { call: async request => {
  calls++;
  const input = JSON.parse(request.userInput);
  if (calls === 1) return { content: '{"protocol":"quick-check-evaluation-v3",' };
  assert.ok(input.recovery.problem.includes('格式不完整'));
  assert.ok(input.answer.includes(sunkCostAnswers[0].text!));
  assert.ok(!request.userInput.includes('privateAnswer'));
  return { content: JSON.stringify(compact(request)) };
} });
assert.equal(calls, 2);
assert.equal(repaired.attemptId, assessment.attemptId, 'format repair never changes observation identity');
assert.equal(applyQuickCheckAssessment(committed.notes, card, repaired).notes, committed.notes);
calls = 0;
await assert.rejects(() => evaluateQuickCheck(card, sunkCostAnswers, { call: async () => { calls++; return { content: '{broken' }; } }), /格式不完整/u);
assert.equal(calls, 2, 'no recursive repair loop');

// A missing scope field is repaired for Q1 only; verified Q2/Q3 stay frozen.
calls = 0;
const scoped = await evaluateQuickCheck(card, sunkCostAnswers, { call: async request => {
  calls++;
  if (calls === 1) {
    const raw = sunkCostEvaluationFixture(request);
    for (const baseline of raw.questionEvaluations[0].result.baselines) baseline.scope = '';
    return { content: JSON.stringify(raw) };
  }
  assert.deepEqual(JSON.parse(request.userInput).questionTasks.map((task: any) => task.questionId), ['Q1']);
  return { content: JSON.stringify(compact(request)) };
} });
assert.equal(calls, 2);
assert.equal(scoped.questionEvaluations![0].evaluation.criteria.find(item => item.id === 'concept_application')!.state, 'fail');
assert.equal(applyQuickCheckAssessment([sunkCostNote], card, scoped).result.details[2].correct, true);

// Repairing one criterion cannot erase a grounded open demonstration alongside
// it, even if the recovery omits that already valid criterion.
calls = 0;
const mixedCriterion = await evaluateQuickCheck(card, sunkCostAnswers, { call: async request => {
  calls++;
  const raw = compact(request), first = raw.questionEvaluations.find((row: any) => row.questionId === 'Q1');
  if (calls === 1) first.criteria.find((criterion: any) => criterion.id === 'concept_application').baseline.scope = '';
  else first.criteria = first.criteria.filter((criterion: any) => criterion.id === 'concept_application');
  return { content: JSON.stringify(raw) };
} });
assert.equal(calls, 2);
const mixedCommit = applyQuickCheckAssessment([sunkCostNote], card, mixedCriterion);
assert.equal(mixedCommit.notes[0].dsrState!.masteryShadow!.layers.concept.criteria!.concept_accuracy.state, 'confirmed');
assert.equal(mixedCommit.notes[0].dsrState!.masteryShadow!.layers.concept.criteria!.concept_application.state, 'needs_review');

// Even a failed repair must preserve other independently verified questions.
calls = 0;
const partial = await evaluateQuickCheck(card, sunkCostAnswers, { call: async request => {
  calls++;
  if (calls > 1) return { content: '{broken repair' };
  const raw = sunkCostEvaluationFixture(request); raw.questionEvaluations.shift();
  return { content: JSON.stringify(raw) };
} });
assert.equal(calls, 2);
const partialCommit = applyQuickCheckAssessment([sunkCostNote], card, partial);
assert.equal(partialCommit.result.details[0].correct, undefined);
assert.equal(partialCommit.result.details[1].correct, false);
assert.equal(partialCommit.result.details[2].correct, true);
assert.equal(partialCommit.notes[0].dsrState!.masteryShadow!.layers.concept.criteria!.concept_application.state, 'unassessed');

// A generation key is not an independent answer; missing verification must not
// display it as "correct", update that criterion, or be bypassed by model metadata.
calls = 0;
const keyless = await evaluateQuickCheck(card, sunkCostAnswers, { call: async request => {
  calls++;
  const raw: any = sunkCostEvaluationFixture(request);
  const second = raw.questionEvaluations.find((row: any) => row.questionId === 'Q2');
  if (second) { delete second.answerKey; second.answerKeyPolicy = 'legacy'; }
  return { content: JSON.stringify(raw) };
} });
assert.equal(calls, 2);
const keylessCommit = applyQuickCheckAssessment([sunkCostNote], card, keyless);
assert.equal(keylessCommit.result.details[1].correct, undefined);
assert.equal(keylessCommit.result.details[1].referenceAnswer, undefined);
assert.equal(keylessCommit.notes[0].dsrState!.masteryShadow!.layers.concept.criteria!.concept_boundary.state, 'unassessed');
assert.equal(keylessCommit.result.details[2].correct, true);

// Honest semantic insufficiency is retained, not retried until it says "pass".
calls = 0;
const insufficient = await evaluateQuickCheck(card, sunkCostAnswers, { call: async request => {
  calls++;
  const raw = compact(request);
  for (const row of raw.questionEvaluations) for (const criterion of row.criteria) {
    criterion.state = 'unverifiable'; criterion.baseline.coverage = 'insufficient';
    criterion.baseline.applicability = 'uncertain'; delete criterion.comparison;
  }
  return { content: JSON.stringify(raw) };
} });
assert.equal(calls, 1);
assert.equal(applyQuickCheckAssessment([sunkCostNote], card, insufficient).applied, false);

// Generation fixes only its own return, does not require the user to re-answer.
calls = 0;
const generated = await generateQuickCheck({ note: sunkCostNote, readers: { searchNotes: async () => [] }, call: async request => {
  calls++;
  if (calls === 1) {
    const questions = structuredClone(card.questions); questions[0].privateAnswer.referenceQuotes[0].quote = '不存在的引文';
    return { content: JSON.stringify(quickCheckDesignFixture(request, { questions })) };
  }
  assert.match(JSON.parse(request.userInput).recovery.problem, /第1题.*无法定位/u);
  return { content: JSON.stringify(quickCheckDesignFixture(request, { questions: card.questions })) };
} });
assert.equal(calls, 2); assert.equal(generated.questions.length, 3);
calls = 0;
await assert.rejects(() => generateQuickCheck({ note: sunkCostNote, readers: { searchNotes: async () => [] }, call: async () => {
  calls++; return { content: JSON.stringify({ unavailable: '没有标准' }) };
} }), /缺少可靠/u);
assert.equal(calls, 1);

// A structurally corrupt known question cannot erase valid siblings.
calls = 0;
const malformedQuestion = await evaluateQuickCheck(card, sunkCostAnswers, { call: async request => {
  calls++;
  if (calls > 1) return { content: '{failed repair' };
  const raw = compact(request); raw.questionEvaluations[0].criteria = 'not-an-array';
  return { content: JSON.stringify(raw) };
} });
assert.equal(calls, 2);
const malformedCommit = applyQuickCheckAssessment([sunkCostNote], card, malformedQuestion);
assert.equal(malformedCommit.result.details[2].correct, true);
assert.equal(malformedCommit.notes[0].dsrState!.masteryShadow!.layers.concept.criteria!.concept_application.state, 'unassessed');

// Actual store + evaluator + save acknowledgement: evaluate once (plus its one
// format repair), retain assessment on disk failure, retry save without grading.
let localNotes = [sunkCostNote], evaluationCalls = 0, saveAttempts = 0;
const cache = new Map<string, string>(), progress: QuickCheckWriteProgress = {};
const runtime = { notes: localNotes, getNotes: () => localNotes,
  onCommit: async (session: typeof card, evaluated: typeof assessment) => commitQuickCheckWrite(progress, {
    persist: async capture => {
      const outcome = applyQuickCheckAssessment(localNotes, session, evaluated);
      localNotes = outcome.notes; capture(outcome.result); saveAttempts++;
      if (saveAttempts === 1) throw new Error('isolated persistence failure');
    }, flush: async () => {},
  }) };
const storage = { getItem: (key: string) => cache.get(key) || null, setItem: (key: string, value: string) => { cache.set(key, value); } };
const store = new QuickCheckStore(runtime, 'isolated-recovery', storage, {
  generate: async () => card,
  evaluate: (session, answers) => evaluateQuickCheck(session, answers, { call: async request => {
    evaluationCalls++;
    return { content: evaluationCalls === 1 ? '{broken first response' : JSON.stringify(compact(request)) };
  } }),
});
async function until(phase: string) {
  for (let attempt = 0; attempt < 100 && store.getSnapshot().draft?.phase !== phase; attempt++)
    await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(store.getSnapshot().draft?.phase, phase, store.getSnapshot().draft?.error);
}
assert.ok(store.open({ noteId: sunkCostNote.id })); await until('ready');
for (const answer of sunkCostAnswers) { store.answer(answer); store.next(); }
await until('error');
assert.equal(store.getSnapshot().draft!.errorStage, 'save');
assert.deepEqual(store.getSnapshot().draft!.answers, sunkCostAnswers.map(answer => ({ ...answer, assisted: false })));
assert.ok(store.getSnapshot().draft!.assessment);
assert.equal(evaluationCalls, 2);
store.retry(); store.retry(); await until('result');
assert.equal(evaluationCalls, 2, 'save retry never re-requests an evaluation');
assert.equal(saveAttempts, 2);
assert.equal(localNotes[0].dsrState!.reviewCount, 1);
assert.equal(store.getSnapshot().draft!.result!.details[2].correct, true);
assert.equal(localNotes[0].dsrState!.masteryShadow!.layers.concept.criteria!.concept_accuracy.independentPasses, 1);
store.dispose();

assert.equal(JSON.stringify(sunkCostNote), original);
console.log('PASS compact evaluation, bounded generation/JSON/scope recovery, reference normalization, independent keys, partial success, semantic holds, results, mastery/activity update and idempotent replay. Synthetic only; no cloud or real storage.');
