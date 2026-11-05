import assert from 'node:assert/strict';
import type { NoteItem } from '../src/types';
import type { ReviewEpisodeCapture } from '../src/services/memory/types';
import { freezeReviewAssessment } from '../src/services/reviewAssessment';
import { buildReviewReferenceCatalog, freezeReviewReferenceRubric } from '../src/services/reviewReferenceRubric';
import { prepareReviewComparisonSession } from '../src/services/reviewComparison/session';
import { planReviewMastery, evaluateReviewMastery, applyReviewMasteryBatch } from '../src/services/masteryShadow/review';
import { parseMasteryShadowEvaluation } from '../src/services/masteryShadow/evaluator';

// Frozen question/source fixtures only. No LLM, current vault, profile or index access.
globalThis.fetch = async () => assert.fail('Scoped review tests must remain offline');
const at = '2026-10-18T06:00:00.000Z';
const passages = ['要比较实验效果，两组必须保持相同的介绍方式。', '第一次观察中，目标选项选择率为百分之二十。',
  '第二次观察中，目标选项选择率为百分之四十。'];
const note: NoteItem = { id: 'scoped-point', title: '实验效应', noteType: 'knowledge',
  content: passages.map((text, index) => `## 资料${index + 1}\n${text}`).join('\n\n'),
  tags: [], links: [], backlinks: [], dueDates: [], createdAt: at, updatedAt: at };
const before = JSON.stringify(note);
const catalog = await buildReviewReferenceCatalog([note], [note.title], [note.id]);
const questions = ['比较实验效果时，请说明介绍方式这个条件。', '请说出第一次观察的目标选择率。', '请说出第二次观察的目标选择率。'];
const answers = ['比较时我会让两组看到相同的介绍文字，避免介绍方式改变结果。', '第一次观察的目标选项选择率是百分之二十。',
  '第二次观察的目标选项选择率是百分之四十。'];
const tasks = ['condition', 'fact', 'fact'] as const;
const reviewCriteria = ['condition_scope', 'fact_scope', 'fact_scope'];
const episode: ReviewEpisodeCapture = { id: 'scoped-episode', startedAt: at, endedAt: at, masteryEligible: true,
  questionText: questions[0], knowledgeContext: '',
  messages: questions.flatMap((question, index) => [{ id: `q${index + 1}`, role: 'assistant' as const, content: question, timestamp: at },
    { id: `a${index + 1}`, role: 'user' as const, content: answers[index], timestamp: at }]),
  answerEvidence: answers.map((answer, index) => {
    const assessment = freezeReviewAssessment(tasks[index], [note.title]);
    const candidate = catalog.candidates.find(row => row.quote === passages[index]);
    assert.ok(candidate, 'Each frozen question receives the actual selected passage');
    const referenceRubric = freezeReviewReferenceRubric(`${reviewCriteria[index]}=${candidate.candidateId}`, assessment, catalog);
    assert.equal(referenceRubric.status, 'fixed');
    return { messageId: `a${index + 1}`, answer, hintLevel: 0, targetKnowledgeNames: [note.title],
      questionIntent: { version: 1 as const, questionMessageId: `q${index + 1}`, knowledgeTargets: [note.title], assessment, referenceRubric } };
  }) };
const deps = { readNotes: async () => structuredClone([note]), loadCognition: async () => assert.fail('No cognition target'),
  searchNotes: async () => [], searchDocuments: async () => [], previewDocument: async () => assert.fail('No documents') };
const session = await prepareReviewComparisonSession(episode, deps, { targetScopeNoteIds: [note.id] });
const plan = planReviewMastery([note], note.id, episode, session);
assert.equal(plan.items.length, 1, 'One knowledge point still uses one request');
const input = plan.items[0].input;
assert.deepEqual(input.task.verificationScopes?.map(row => row.id), ['a1', 'a2', 'a3']);
assert.deepEqual(input.task.verificationScopes?.map(row => row.prompt), questions);
assert.deepEqual(input.task.verificationScopes?.map(row => row.answer), answers);
assert.deepEqual(input.task.verificationScopes?.map(row => row.criterionIds), [['judgment_conditions'], ['judgment_accuracy'], ['judgment_accuracy']]);
const sourceFor = (index: number) => input.references.find(row => row.quote === passages[index])!;
assert.deepEqual(input.task.verificationScopes?.map(row => row.referenceIds), passages.map((_row, index) => [sourceFor(index).id]));
assert.deepEqual(sourceFor(0).criterionIds, ['judgment_conditions']);
assert.deepEqual(sourceFor(1).criterionIds, ['judgment_accuracy']);
assert.deepEqual(sourceFor(2).criterionIds, ['judgment_accuracy']);
const raw = { protocol: 'mastery-shadow-evaluator-v1', evaluationId: input.evaluationId, knowledgePointId: note.id,
  baselines: [
    { id: 'judgment_conditions', scopeIds: ['a1'], scope: questions[0], applicability: 'applicable', coverage: 'covered',
      rule: passages[0], referenceIds: [sourceFor(0).id], referenceQuotes: [{ referenceId: sourceFor(0).id, quote: passages[0] }], reason: '本题控制条件。' },
    { id: 'judgment_accuracy', scopeIds: ['a2'], scope: questions[1], applicability: 'applicable', coverage: 'covered',
      rule: passages[1], referenceIds: [sourceFor(1).id], referenceQuotes: [{ referenceId: sourceFor(1).id, quote: passages[1] }], reason: '本题第一次观察数据。' },
  ], evidence: [{ id: 'E1', quote: answers[0] }, { id: 'E2', quote: answers[1] }, { id: 'E3', quote: answers[2] }],
  criteria: [{ id: 'judgment_conditions', state: 'pass', evidenceIds: ['E1'], reason: '介绍方式在本题保持相同。' },
    { id: 'judgment_accuracy', state: 'pass', evidenceIds: ['E2'], reason: '第一次观察的数据相符。' }], summary: '两项按各自冻结问题核对。' };
let modelCalls = 0;
episode.masteryAssessment = await evaluateReviewMastery(plan, async ({ userInput }) => {
  modelCalls++;
  const request = JSON.parse(userInput);
  assert.equal(request.task.verificationScopes.length, 3, 'Frozen scopes reach the single grouped request');
  return structuredClone(raw);
});
assert.equal(modelCalls, 1);
assert.ok(!episode.masteryAssessment.items[0].error);
assert.deepEqual(episode.masteryAssessment.items[0].evaluation?.criteria.map(row => row.state), ['pass', 'pass']);
const saved = applyReviewMasteryBatch([note], note.id, episode);
assert.equal(saved.evaluations.length, 1, 'Question-level bindings survive save-time provenance checks');

const crossCriterion = structuredClone(raw);
crossCriterion.baselines[0].referenceIds = [sourceFor(1).id];
crossCriterion.baselines[0].referenceQuotes = [{ referenceId: sourceFor(1).id, quote: passages[1] }];
const crossed = parseMasteryShadowEvaluation(crossCriterion, input);
assert.equal(crossed.criteria[0].state, 'unverifiable');
assert.equal(crossed.criteria[1].state, 'pass', 'Invalid one-question source never rejects a valid sibling');
const crossQuestion = structuredClone(raw);
crossQuestion.baselines[1].referenceIds = [sourceFor(2).id];
crossQuestion.baselines[1].referenceQuotes = [{ referenceId: sourceFor(2).id, quote: passages[2] }];
assert.equal(parseMasteryShadowEvaluation(crossQuestion, input).criteria[1].state, 'unverifiable',
  'Same criterion and same knowledge point still cannot borrow another frozen question source');
const crossAnswer = structuredClone(raw);
crossAnswer.criteria[1].evidenceIds = ['E3'];
assert.equal(parseMasteryShadowEvaluation(crossAnswer, input).criteria[1].state, 'unverifiable',
  'A real quote from another question is not evidence for this question');
const spoofed = structuredClone(episode);
spoofed.masteryAssessment!.items[0].input.task.verificationScopes![1].referenceIds = [sourceFor(2).id];
assert.equal(applyReviewMasteryBatch([note], note.id, spoofed).evaluations.length, 0,
  'Save cannot replace a frozen question reference with a different legitimate note passage');
const sharedEpisode = structuredClone(episode);
const sharedQuestion = '资料明确要求两组的介绍方式怎样设置？';
const sharedAnswer = '资料要求两组保持相同的介绍方式。';
const sharedAssessment = freezeReviewAssessment('fact', [note.title]);
const sharedCandidate = catalog.candidates.find(row => row.quote === passages[0])!;
sharedEpisode.messages.push({ id: 'q4', role: 'assistant', content: sharedQuestion, timestamp: at },
  { id: 'a4', role: 'user', content: sharedAnswer, timestamp: at });
sharedEpisode.answerEvidence!.push({ messageId: 'a4', answer: sharedAnswer, hintLevel: 0, targetKnowledgeNames: [note.title],
  questionIntent: { version: 1, questionMessageId: 'q4', knowledgeTargets: [note.title], assessment: sharedAssessment,
    referenceRubric: freezeReviewReferenceRubric(`fact_scope=${sharedCandidate.candidateId}`, sharedAssessment, catalog) } });
const sharedSession = await prepareReviewComparisonSession(sharedEpisode, deps, { targetScopeNoteIds: [note.id] });
const sharedPlan = planReviewMastery([note], note.id, sharedEpisode, sharedSession);
const sharedInput = sharedPlan.items[0].input;
assert.equal(sharedInput.references.length, 3, 'One source used by two tasks stays deduplicated');
assert.deepEqual(sharedInput.references.find(row => row.quote === passages[0])?.criterionIds,
  ['judgment_conditions', 'judgment_accuracy'], 'Merged references retain the union of actual task eligibility');
assert.deepEqual(sharedInput.task.verificationScopes?.at(-1)?.referenceIds, [sourceFor(0).id]);
assert.equal(JSON.stringify(note), before);
console.log('PASS frozen per-question scopes, separate criterion references, same-criterion multi-question isolation, one model call and save-time rebinding. No cloud or formal data writes.');
