import assert from 'node:assert/strict';
import type { NoteItem, LlmCallRequest } from '../src/types';
import { applyQuickCheckAssessment, evaluateQuickCheck, quickCheckMasteryKey,
  quickCheckSourceKey, quickCheckTargets, type QuickCheckAnswer, type QuickCheckSession } from '../src/services/quickCheck';
import { createMasteryShadowState, applyMasteryShadowObservations } from '../src/services/masteryShadow/stateMachine';
import { masteryBaselineFixture, masteryComparisonFixture } from './fixtures/mastery-baselines';
import { parseQuickCheckJson } from '../src/services/quickCheck/generationJson';
import { knowledgePracticeRecency, knowledgePracticeTime } from '../src/services/knowledgePracticeTime';
import { quickCheckDesignFixture, generateQuickCheckFixture as generateQuickCheck } from './fixtures/quick-check-design';
import { quickCheckEvaluationFixture } from './fixtures/quick-check-evaluation';
import { deserializeUserStateFile, serializeUserStateFile, splitUserStateFields } from '../src/services/userStateService';

globalThis.fetch = async () => assert.fail('Quick-check fixtures must never use the network or a real vault');
const at = '2026-10-18T06:00:00Z', now = () => new Date(at);
const note: NoteItem = { id: 'synthetic-quick-check', title: '观察效应', noteType: 'knowledge',
  content: '# 含义\n意识到受到观察可能改变行为，但不等于干预有效。\n\n# 边界与应用\n适用于受到观察的情境。应比较被观察与未被观察的条件，不能只凭成绩提高证明干预有效。',
  tags: [], links: [], backlinks: [], dueDates: [], createdAt: at, updatedAt: at };
const readers = { searchNotes: async () => [] };
const source = JSON.stringify(note);
const generationRequests: LlmCallRequest[] = [];
function generation(request: LlmCallRequest) {
  generationRequests.push(request);
  const input = JSON.parse(request.userInput);
  const questions = input.targets.map((target: { id: string }, index: number) => {
    const reference = input.references.find((ref: { criterionIds: string[] }) => ref.criterionIds.includes(target.id));
    return { id: `Q${index + 1}`, type: index === 0 ? 'application' : index === 1 ? 'choice' : 'true_false',
      prompt: (index === 0 ? '请解释老师在场时学生更认真这一现象。' : index === 1 ? '可以仅凭观察后成绩提高证明干预有效吗？' : '观察条件是否需要区分？')
        + (input.previousQuestions?.length ? '（合成的新任务，仅用于契约测试）' : ''),
      criterionIds: [target.id], referenceIds: [reference.id],
      ...(index ? { options: [{ id: 'A', text: '需要区分观察条件' }, { id: 'B', text: '无需区分观察条件' }] } : {}),
      privateAnswer: { ...(index ? { optionId: 'A' } : {}), explanation: '应区分观察和干预本身的影响。',
        referenceQuotes: [{ referenceId: reference.id, quote: reference.quote.slice(0, 160) }] } };
  });
  return quickCheckDesignFixture(request, { questions });
}
const generateCall = async (request: LlmCallRequest) => ({ content: JSON.stringify(generation(request)) });
const card = await generateQuickCheck({ note, readers, call: generateCall, now });
assert.equal(card.questions.length, 3);
assert.deepEqual(card.targets.map(target => target.id), ['concept_accuracy', 'concept_boundary', 'concept_application']);
assert.ok(generationRequests.every(request => request.workflow === 'knowledge-mastery-scoring'
  && request.thinkingMode === 'disabled' && request.skipMemoryInjection && request.skipProfileInjection && request.outputSchema));
assert.ok(!generationRequests[0].userInput.includes('conceptMastery') && !generationRequests[0].userInput.includes('userProfile'));
assert.ok(card.references.reduce((sum, ref) => sum + ref.quote.length, 0) <= 4200);
assert.equal(JSON.stringify(note), source);
const previousQuestions = card.questions.map(question => question.prompt);
await generateQuickCheck({ note, readers, call: generateCall, now, previousQuestions });
const variationInput = JSON.parse(generationRequests[1].userInput);
assert.deepEqual(variationInput.previousQuestions, previousQuestions);
assert.ok(typeof variationInput.variantId === 'string' && variationInput.variantId !== JSON.parse(generationRequests[0].userInput).variantId,
  'each generation has a fresh variation coordinate, even with unchanged mastery');
assert.ok(!generationRequests[1].userInput.includes('privateAnswer') && !generationRequests[1].userInput.includes('optionId')
  && !generationRequests[1].userInput.includes('explanation') && !generationRequests[1].userInput.includes('score'),
  'variation history contains stems only, not prior private keys, explanations, answers or scores');
await assert.rejects(() => generateQuickCheck({ note, readers, call: generateCall, now, previousQuestions: Array(7).fill('旧题') }));
await assert.rejects(() => generateQuickCheck({ note, readers, call: generateCall, now, previousQuestions: ['x'.repeat(801)] }));
await assert.rejects(() => generateQuickCheck({ note, readers, call: generateCall, now, previousQuestions: [{} as never] }));
assert.equal(quickCheckSourceKey({ ...note, updatedAt: '2099-01-01' }), card.sourceKey, 'metadata saves are not source changes');
assert.notEqual(quickCheckSourceKey({ ...note, content: note.content + '新事实' }), card.sourceKey);

const answers: QuickCheckAnswer[] = [{ questionId: 'Q1', text: '老师在场的观察会让学生改变表现，这不能直接证明教学干预有效。' },
  { questionId: 'Q2', optionId: 'A' }, { questionId: 'Q3', optionId: 'A' }];
let evaluations = 0;
function evaluationRaw(request: LlmCallRequest, verdict: 'pass' | 'fail' = 'pass') {
  evaluations++;
  assert.equal(request.thinkingMode, 'disabled');
  const input = JSON.parse(request.userInput);
  assert.equal(input.task.referenceContract, 'criterion-scope-v3');
  assert.equal(input.task.verificationScopes.length, 3);
  assert.ok(!input.answer.includes('需要区分观察条件'), 'model must not receive options as a user explanation');
  assert.ok(!request.userInput.includes('privateAnswer') && !request.userInput.includes('optionId'), 'private key is not evidence authority');
  return { protocol: 'mastery-shadow-evaluator-v1', evaluationId: input.evaluationId, knowledgePointId: input.knowledgePointId,
    evidence: input.task.verificationScopes.map((scope: { id: string; answer: string }) => ({ id: `E-${scope.id}`, quote: scope.answer })),
    baselines: masteryBaselineFixture(input),
    criteria: input.criteria.map((criterion: { id: string }) => {
      const scope = input.task.verificationScopes.find((scope: { criterionIds: string[] }) => scope.criterionIds.includes(criterion.id));
      return { id: criterion.id, state: verdict, evidenceIds: [`E-${scope.id}`], referenceIds: scope.referenceIds,
        ...(verdict === 'fail' ? { comparison: masteryComparisonFixture(input, criterion.id, [`E-${scope.id}`]) } : {}),
        reason: 'Synthetic transport and state fixture, not a semantic correctness proof.' };
    }), summary: '本次识别结果与对应资料核验。' };
}
const evaluationCall = async (request: LlmCallRequest) => ({ content: JSON.stringify(quickCheckEvaluationFixture(request, evaluationRaw(request))) });
const assessment = await evaluateQuickCheck(card, answers, { call: evaluationCall, now });
assert.equal(evaluations, 1, 'all three questions share a single semantic evaluation');
assert.equal(assessment.input.strength, 'natural');
const applied = applyQuickCheckAssessment([note], card, assessment);
assert.ok(applied.applied);
const state = applied.notes[0].dsrState!.masteryShadow!;
assert.equal(state.layers.concept.state, 'provisional', 'one card, including lucky selections, cannot strongly confirm a layer');
for (const criterion of Object.values(state.layers.concept.criteria!)) assert.equal(criterion.independentPasses, 1);
assert.equal(state.layers.concept.criteria!.concept_accuracy.state, 'confirmed', 'one grounded independent open demonstration confirms its criterion');
assert.equal(state.layers.concept.criteria!.concept_boundary.state, 'provisional', 'choice-only success still needs confirmation');
assert.equal(state.layers.reasoning.state, 'unassessed', 'uncovered criteria and layers never change');
assert.equal(state.appliedObservationIds.length, 1, 'one observation per layer, not per question');
assert.equal(applied.notes[0].dsrState!.lastReviewedAt, new Date(at).toISOString());
assert.equal(applied.notes[0].dsrState!.lastPracticedAt, new Date(at).toISOString());
assert.equal(applied.notes[0].dsrState!.reviewCount, 1, 'three questions count as one review, not three');
assert.equal(knowledgePracticeRecency(applied.notes[0], Date.parse(at)), '今天复习过');
assert.equal(quickCheckSourceKey(applied.notes[0]), quickCheckSourceKey(note), 'activity writes never re-embed the knowledge body');
const restoredActivity = deserializeUserStateFile(serializeUserStateFile({ [note.id]: splitUserStateFields(applied.notes[0]) }));
assert.equal(restoredActivity[note.id].dsrState!.lastPracticedAt, new Date(at).toISOString());
assert.deepEqual(restoredActivity[note.id].dsrState!.practiceSessionIds, [assessment.attemptId]);
const replay = applyQuickCheckAssessment(applied.notes, card, assessment);
assert.equal(replay.applied, false);
assert.equal(replay.notes, applied.notes, 'repeated submit causes no save churn');
assert.equal(replay.notes[0].dsrState!.reviewCount, 1, 'save retry never increments review count twice');
assert.ok(replay.result.details.length === 3, 'replay still has answer feedback');
assert.equal(JSON.stringify(note), source, 'preparation and commit are immutable');
const memoryNote = { ...note, dsrState: { difficulty: 8, stability: 13, lastReviewedAt: '2026-08-29T00:00:00Z',
  reviewCount: 7, consecutiveCorrect: 2, consecutiveWrong: 0, conceptMastery: 29, conceptMasterySamples: 4 } };
const memoryCommit = applyQuickCheckAssessment([memoryNote], card, assessment).notes[0];
assert.equal(memoryCommit.dsrState!.reviewCount, 8);
assert.equal(memoryCommit.dsrState!.difficulty, 8); assert.equal(memoryCommit.dsrState!.stability, 13);
assert.equal(memoryCommit.dsrState!.conceptMastery, 29, 'activity tracking never revives numeric mastery scoring');
const uncertainAssessment = await evaluateQuickCheck(card, answers, { now, call: async request => {
  const raw = evaluationRaw(request);
  return { content: JSON.stringify(quickCheckEvaluationFixture(request, { ...raw, criteria: raw.criteria.map(row => ({ ...row, state: 'unverifiable' })) })) };
} });
const uncertainCommit = applyQuickCheckAssessment([note], card, uncertainAssessment);
assert.equal(uncertainCommit.applied, false); assert.equal(uncertainCommit.notes[0].dsrState!.masteryShadow, undefined);
assert.equal(uncertainCommit.notes[0].dsrState!.lastPracticedAt, new Date(at).toISOString());
assert.equal(uncertainCommit.notes[0].dsrState!.lastReviewedAt, null, 'unverifiable work is practice, not a verified memory refresh');
assert.equal(applyQuickCheckAssessment(uncertainCommit.notes, card, uncertainAssessment).notes, uncertainCommit.notes);

const metadataOnly = structuredClone(applied.notes[0]);
metadataOnly.dsrState!.masteryShadow!.updatedAt = '2099-01-01';
metadataOnly.dsrState!.masteryShadow!.layers.concept.criteria!.concept_accuracy.recentEvidenceIds.push('metadata-only');
assert.equal(quickCheckMasteryKey(metadataOnly), quickCheckMasteryKey(applied.notes[0]));
assert.notEqual(quickCheckMasteryKey(note), quickCheckMasteryKey(applied.notes[0]));
assert.deepEqual(quickCheckTargets(applied.notes[0]).map(target => target.layer), ['concept', 'concept', 'judgment'],
  'pending confirmations precede unassessed criteria');
assert.equal(applied.result.remaining[0], quickCheckTargets(applied.notes[0])[0].label,
  'result guidance uses the same priority as the next card, not fixed concept-first order');
assert.equal(quickCheckTargets(applied.notes[0], ['concept_boundary'])[0].id, 'concept_boundary', 'legal agent priority is retained');
assert.throws(() => quickCheckTargets(note, ['illegal' as never]));
assert.throws(() => quickCheckTargets(note, ['concept_accuracy', 'concept_accuracy']));

// A concurrent flow/review result must survive; accumulate on latest criteria rather than the card snapshot.
const concurrent = structuredClone(applied.notes[0]);
concurrent.dsrState!.masteryShadow!.layers.judgment.criteria!.judgment_accuracy = {
  state: 'confirmed', independentPasses: 2, unresolvedFailures: 0, recentEvidenceIds: ['other-flow'] };
const concurrentResult = applyQuickCheckAssessment([concurrent], card, assessment);
assert.equal(concurrentResult.notes[0].dsrState!.masteryShadow!.layers.judgment.criteria!.judgment_accuracy.state, 'confirmed');
assert.equal(concurrentResult.applied, false, 'same attempt remains idempotent after other-source updates');
const beforeFirstApply = structuredClone(note);
beforeFirstApply.dsrState = { difficulty: 5, stability: 2, reviewCount: 0, lastReviewedAt: null, consecutiveCorrect: 0, consecutiveWrong: 0,
  masteryShadow: createMasteryShadowState(note.id) };
beforeFirstApply.dsrState.masteryShadow!.layers.concept.criteria!.concept_accuracy = {
  state: 'provisional', independentPasses: 1, unresolvedFailures: 0, recentEvidenceIds: ['concurrent-first'] };
const merge = applyQuickCheckAssessment([beforeFirstApply], card, assessment);
assert.equal(merge.notes[0].dsrState!.masteryShadow!.layers.concept.criteria!.concept_accuracy.state, 'confirmed');

const assistedAnswers = answers.map((answer, index) => ({ ...answer, assisted: index === 1 }));
const assisted = await evaluateQuickCheck(card, assistedAnswers, { call: evaluationCall, now });
assert.equal(assisted.input.assistance, 'assisted');
const assistedState = applyQuickCheckAssessment([note], card, assisted).notes[0].dsrState!.masteryShadow!;
assert.equal(assistedState.layers.concept.criteria!.concept_accuracy.independentPasses, 0, 'consulting any reference makes the card assisted');
const assistedOutcome = applyQuickCheckAssessment([note], card, assisted);
assert.equal(assistedOutcome.notes[0].dsrState!.lastPracticedAt, new Date(at).toISOString());
assert.equal(assistedOutcome.notes[0].dsrState!.lastReviewedAt, null, 'aided practice cannot reset the independent memory clock');
assert.equal(assistedOutcome.notes[0].dsrState!.reviewCount, 0);
assert.match(assistedOutcome.result.headline, /辅助作答.*未增加独立/u);
assert.equal(knowledgePracticeRecency(assistedOutcome.notes[0], Date.parse(at)), '今天练习过');
assert.equal(applyQuickCheckAssessment(assistedOutcome.notes, card, assisted).notes, assistedOutcome.notes);
const olderSaved = structuredClone(note);
olderSaved.dsrState = { ...assistedOutcome.notes[0].dsrState!, lastPracticedAt: undefined, practiceSessionIds: undefined,
  lastReviewedAt: '2026-08-29T07:31:41.000Z' };
const olderBefore = JSON.stringify(olderSaved);
assert.equal(knowledgePracticeRecency(olderSaved, Date.parse(at)), '今天练习过', 'old quick-check observation times fix display without a data migration');
assert.equal(JSON.stringify(olderSaved), olderBefore);
assert.equal(knowledgePracticeTime({ ...note, dsrState: { ...olderSaved.dsrState!, lastReviewedAt: 'invalid', masteryShadow: undefined } }).kind, 'none');
const newerReview = { ...olderSaved, dsrState: { ...olderSaved.dsrState!, lastReviewedAt: '2026-10-20T00:00:00.000Z' } };
const lateCommit = applyQuickCheckAssessment([newerReview], card, assessment);
assert.equal(lateCommit.notes[0].dsrState!.lastReviewedAt, newerReview.dsrState.lastReviewedAt, 'late completion never rolls the review timestamp backward');

const allSkipped = await evaluateQuickCheck(card, [{ questionId: 'Q1', text: '不知道' }], {
  call: async () => assert.fail('empty/don’t-know card must not call a grading model'), now });
const emptyCommit = applyQuickCheckAssessment([note], card, allSkipped);
assert.equal(emptyCommit.applied, false);
assert.equal(emptyCommit.notes[0], note, 'no failure or observation is created for an empty card');
assert.equal(applyQuickCheckAssessment(applied.notes, card, allSkipped).notes, applied.notes, 'skipping cannot churn an existing mastery or practice record');
assert.equal(emptyCommit.result.headline, '本次三题均已跳过，掌握状态未改变。');
const stale = applyQuickCheckAssessment([{ ...note, content: '正文已被改写。' }], card, assessment);
assert.equal(stale.applied, false); assert.ok(stale.reason?.includes('正文已变化'));
assert.equal(applyQuickCheckAssessment([], card, assessment).applied, false, 'late responses never resurrect deleted notes');
const changedAnswer = structuredClone(assessment); changedAnswer.answers[0].text = '替换后的回答';
assert.equal(applyQuickCheckAssessment([note], card, changedAnswer).applied, false);
const changedCard = structuredClone(card); changedCard.questions[0].prompt = '换一道题';
await assert.rejects(() => evaluateQuickCheck(changedCard, answers, { call: evaluationCall, now }));
await assert.rejects(() => evaluateQuickCheck(card, [{ questionId: 'Q2', optionId: 'Z' }], { call: evaluationCall, now }));
await assert.rejects(() => generateQuickCheck({ note: { ...note, content: '请对该知识点进行定义描述' }, readers,
  call: async () => assert.fail('placeholder reference cannot produce a test'), now }));
await assert.rejects(() => generateQuickCheck({ note, readers, now, call: async request => {
  const raw = generation(request); raw.questions[0].privateAnswer.referenceQuotes[0].quote = '笔记中不存在的资料';
  return { content: JSON.stringify(raw) };
} }));
await assert.rejects(() => generateQuickCheck({ note, readers, now, call: async request => {
  const raw = generation(request); raw.questions[0].criterionIds = ['reasoning_consistency'];
  return { content: JSON.stringify(raw) };
} }));
await assert.rejects(() => generateQuickCheck({ note, readers, now, call: async request => {
  const raw = generation(request); raw.questions.pop(); return { content: JSON.stringify(raw) };
} }));
const noAuthority = await generateQuickCheck({ note, readers, now, call: async request => ({ content: JSON.stringify({
  ...generation(request), score: 100, observations: [{ strength: 'targeted' }], masteryShadow: { confirmed: true } }) }) });
assert.ok(!('score' in noAuthority) && !('observations' in noAuthority), 'generated authority fields are never passed through');

const unusualText = '引文包含 ,} 和 ,]、转义引号 "、反斜线 \\，都不能被改写。';
const badComma = `{ "text": ${JSON.stringify(unusualText)}, "values": [1,2,], }`;
assert.deepEqual(parseQuickCheckJson(badComma), { text: unusualText, values: [1, 2] });
for (const malformed of ['{"questions":[', '{unquoted:1}', '{"text":"未闭合}', '{"text":"a" "other":1}']) {
  assert.throws(() => parseQuickCheckJson(malformed), /格式不完整/u, 'do not invent a key, separator, quote, bracket, question or answer');
}
const partialCard = await generateQuickCheck({ note, readers, now, call: async request => {
  const raw = generation(request);
  for (const question of raw.questions) {
    question.criterionIds = [...raw.questions[0].criterionIds];
    question.referenceIds = [...raw.questions[0].referenceIds];
    question.privateAnswer.referenceQuotes = [...raw.questions[0].privateAnswer.referenceQuotes];
  }
  return { content: JSON.stringify(raw).replace(/\}$/u, ',}') };
} });
assert.deepEqual(partialCard.targets.map(target => target.id), ['concept_accuracy'], 'freeze actual coverage, never relabel questions to fake missing targets');
assert.deepEqual(partialCard.uncoveredCriterionIds, ['concept_boundary', 'concept_application']);
const partialAssessment = await evaluateQuickCheck(partialCard, answers, { now, call: evaluationCall });
const partialOutcome = applyQuickCheckAssessment([note], partialCard, partialAssessment);
assert.equal(partialOutcome.applied, true);
for (const id of partialCard.uncoveredCriterionIds!) {
  assert.equal(partialOutcome.notes[0].dsrState!.masteryShadow!.layers.concept.criteria![id].state, 'unassessed', 'uncovered targets are neither passed nor failed');
}
await assert.rejects(() => generateQuickCheck({ note, readers, now, requestedCriterionIds: ['concept_boundary'], call: async request => {
  const raw = generation(request), first = raw.questions.find(question => !question.criterionIds.includes('concept_boundary'))!;
  for (const question of raw.questions) {
    question.criterionIds = [...first.criterionIds]; question.referenceIds = [...first.referenceIds];
    question.privateAnswer.referenceQuotes = [...first.privateAnswer.referenceQuotes];
  }
  return { content: JSON.stringify(raw) };
} }), /明确指定/u, 'explicit targeted requests may not silently drop their required criterion');

// A question may use its matching primary example plus a provided definition.
// Retrieval labels are not permanent prohibitions on supplementary explanation.
const contextCard = await generateQuickCheck({ note, readers, now, call: async request => {
  const raw = generation(request), input = JSON.parse(request.userInput);
  const ids = ['concept_application', 'concept_accuracy', 'concept_boundary'];
  raw.questions.forEach((question, index) => {
    const main = input.references.find((ref: { criterionIds: string[] }) => ref.criterionIds.includes(ids[index]));
    const definition = input.references.find((ref: { criterionIds: string[] }) => ref.criterionIds.includes('concept_accuracy'));
    question.criterionIds = [ids[index]];
    const used = index === 0 ? [main, definition] : [main];
    question.referenceIds = used.map(ref => ref.id);
    question.privateAnswer.referenceQuotes = used.map(ref => ({ referenceId: ref.id, quote: ref.quote.slice(0, 160) }));
  });
  return { content: JSON.stringify(raw) };
} });
const meaningRef = contextCard.references.find(ref => ref.id === 'KP-NOTE-concept_accuracy')!;
assert.ok(meaningRef.criterionIds?.includes('concept_application'));
assert.ok(!meaningRef.criterionIds?.includes('concept_boundary'), 'eligibility expands only to explicitly bound question usage');
const contextAssessment = await evaluateQuickCheck(contextCard, answers, { now, call: async request => {
  const raw = evaluationRaw(request);
  const application = raw.criteria.find(row => row.id === 'concept_application')!;
  application.referenceIds = [meaningRef.id];
  return { content: JSON.stringify(quickCheckEvaluationFixture(request, raw)) };
} });
assert.equal(contextAssessment.evaluation.criteria.find(row => row.id === 'concept_application')?.state, 'pass',
  'the frozen supplementary reference binding survives evaluation parsing');
assert.ok(applyQuickCheckAssessment([note], contextCard, contextAssessment).applied, 'supplementary scopes survive save-time revalidation');
// Missing/incorrect quote coordinates are still rejected, not repaired by guessing.
for (const referenceIds of [['UNKNOWN-REFERENCE'], ['KP-NOTE-concept_boundary']]) {
  await assert.rejects(() => generateQuickCheck({ note, readers, now, call: async request => {
    const raw = generation(request); raw.questions[0].referenceIds = referenceIds;
    return { content: JSON.stringify(raw) };
  } }), /本次未提供|缺少可核对/u, 'unknown references and mismatching quote coordinates remain blocked');
}
// Real failure class: a definition can explain an application without adding a
// same-named retrieval hit solely to satisfy a local metadata check.
const crossTagged = await generateQuickCheck({ note, readers, now, call: async request => {
  const raw = generation(request), input = JSON.parse(request.userInput);
  const definition = input.references.find((ref: { id: string }) => ref.id === 'KP-NOTE-concept_accuracy');
  raw.questions[0].criterionIds = ['concept_application'];
  raw.questions[0].referenceIds = [definition.id];
  raw.questions[0].privateAnswer.referenceQuotes = [{ referenceId: definition.id, quote: definition.quote.slice(0, 160) }];
  return { content: JSON.stringify(raw) };
} });
assert.deepEqual(crossTagged.questions[0].referenceIds, ['KP-NOTE-concept_accuracy']);
assert.ok(crossTagged.references.find(ref => ref.id === 'KP-NOTE-concept_accuracy')!.criterionIds?.includes('concept_application'));
assert.equal(JSON.stringify(note), source, 'accepting a reference binding never confirms mastery or changes notes');

// Even with an answered open question on the same criterion, selecting a causal sentence is not a user explanation.
const reasoningCard = await generateQuickCheck({ note, readers, now,
  requestedCriterionIds: ['reasoning_relevance', 'reasoning_sufficiency', 'reasoning_consistency'],
  call: async request => {
    const raw = generation(request);
    const input = JSON.parse(request.userInput);
    raw.questions[1].criterionIds = [raw.questions[0].criterionIds[0]];
    raw.questions[1].referenceIds = raw.questions[0].referenceIds;
    raw.questions[1].privateAnswer.referenceQuotes = raw.questions[0].privateAnswer.referenceQuotes;
    raw.questions[2].criterionIds = input.targets.slice(1).map((target: { id: string }) => target.id);
    raw.questions[2].referenceIds = input.references.slice(1).map((ref: { id: string }) => ref.id);
    return { content: JSON.stringify(raw) };
  } });
const reasoning = await evaluateQuickCheck(reasoningCard, answers, { now, call: async request => {
  const raw = evaluationRaw(request);
  for (const criterion of raw.criteria) criterion.evidenceIds = ['E-Q2'];
  return { content: JSON.stringify(quickCheckEvaluationFixture(request, raw)) };
} });
assert.ok(reasoning.evaluation.criteria.every(criterion => criterion.state === 'not_observed' || criterion.state === 'unverifiable'),
  'reasoning success requires a corresponding open-answer evidence, not merely any answered open question');
assert.equal(applyQuickCheckAssessment([note], reasoningCard, reasoning).applied, false);

// Two questions may test the same criterion without producing two passes; skipped scopes do not churn replay.
const mixedCard = await generateQuickCheck({ note, readers, now,
  requestedCriterionIds: ['concept_accuracy', 'judgment_accuracy', 'reasoning_consistency'], call: generateCall });
const mixedAnswers: QuickCheckAnswer[] = [{ questionId: 'Q1', text: answers[0].text }, { questionId: 'Q2', skipped: true }, { questionId: 'Q3', skipped: true }];
const mixedAssessment = await evaluateQuickCheck(mixedCard, mixedAnswers, { now, call: async request => {
  const input = JSON.parse(request.userInput);
  return { content: JSON.stringify(quickCheckEvaluationFixture(request, { protocol: 'mastery-shadow-evaluator-v1', evaluationId: input.evaluationId,
    knowledgePointId: input.knowledgePointId, baselines: masteryBaselineFixture(input), evidence: [{ id: 'E1', quote: answers[0].text }],
    criteria: [{ id: 'concept_accuracy', state: 'pass', evidenceIds: ['E1'], referenceIds: input.references.map((ref: { id: string }) => ref.id), reason: 'fixture' }] })) };
} });
const mixed = applyQuickCheckAssessment([note], mixedCard, mixedAssessment);
assert.equal(mixed.applied, true);
assert.equal(applyQuickCheckAssessment(mixed.notes, mixedCard, mixedAssessment).notes, mixed.notes);

// Two correct answers and one incorrect boundary choice: keep the error headline,
// but next-card guidance follows the user-selected confirmation-first priority.
const boundaryAnswers = answers.map(answer => answer.questionId === 'Q2' ? { ...answer, optionId: 'B' } : answer);
const boundaryAssessment = await evaluateQuickCheck(card, boundaryAnswers, { now, call: async request => {
  const raw = evaluationRaw(request), input = JSON.parse(request.userInput);
  const boundary = raw.criteria.find(row => row.id === 'concept_boundary')!;
  boundary.state = 'fail';
  boundary.comparison = masteryComparisonFixture(input, 'concept_boundary', ['E-Q2']);
  return { content: JSON.stringify(quickCheckEvaluationFixture(request, raw)) };
} });
const boundaryOutcome = applyQuickCheckAssessment([note], card, boundaryAssessment);
assert.equal(boundaryOutcome.notes[0].dsrState!.masteryShadow!.layers.concept.criteria!.concept_boundary.state, 'needs_review');
assert.match(boundaryOutcome.result.headline, /概念边界/);
assert.equal(boundaryOutcome.result.remaining[0], '概念应用');
assert.equal(boundaryOutcome.result.nextAction, '下次可定向检验「概念应用」');
assert.equal(boundaryOutcome.result.remaining[0], quickCheckTargets(boundaryOutcome.notes[0])[0].label);
assert.deepEqual(boundaryOutcome.result.remaining.slice(0, 4), ['概念应用', '概念边界', '判断正确性', '条件与程度'],
  'pending confirmations precede needs-review, which precedes unassessed');
assert.equal(applyQuickCheckAssessment(boundaryOutcome.notes, card, boundaryAssessment).result.nextAction,
  boundaryOutcome.result.nextAction, 'idempotent retry keeps the latest priority');
console.log('Quick-check: generation/ref binding, three-question one-call, natural evidence, skips, assistance, source invalidation, concurrent merge, replay and choice-only safeguards passed (synthetic only).');
