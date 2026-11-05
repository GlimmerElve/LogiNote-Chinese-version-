import assert from 'node:assert/strict';
import type { NoteItem } from '../src/types';
import type { ReviewEpisodeCapture } from '../src/services/memory/types';
import { freezeReviewAssessment } from '../src/services/reviewAssessment';
import { prepareReviewComparisonSession } from '../src/services/reviewComparison/session';
import { planReviewMastery, evaluateReviewMastery } from '../src/services/masteryShadow/review';
import type { MasteryShadowCriterionState } from '../src/services/masteryShadow/evaluator';
import type { MasteryShadowObservation } from '../src/services/masteryShadow/types';
import { prepareReviewExitOutcome, reviewSchedulingVerdicts } from '../src/services/ui/reviewExitWrite';
import { calculateRetrievability, updateDifficulty, updateStability } from '../src/services/reviewScheduler';

globalThis.fetch = async () => assert.fail('Scope scheduling checks must not access a network or real vault');
const previousMode = process.env.VITE_MASTERY_READ_MODE;
process.env.VITE_MASTERY_READ_MODE = 'current';
const at = '2026-10-18T01:00:00Z';
const title = '观察效应';
const note: NoteItem = { id: 'scope-scheduling-note', title, noteType: 'knowledge',
  content: '观察效应是人意识到受到观察后行为可能改变；这种改变不等于干预本身有效。',
  tags: [], links: [], backlinks: [], dueDates: [], createdAt: at, updatedAt: at,
  dsrState: { difficulty: 5, stability: 4, lastReviewedAt: '2026-10-17T01:00:00Z', reviewCount: 2,
    consecutiveCorrect: 1, consecutiveWrong: 0 } };
const source = [note];
const initial = JSON.stringify(source);
function capture(id: string): ReviewEpisodeCapture {
  const questions = ['请说明观察效应的核心含义与限定。', '再说明为什么它不等于干预有效。'];
  const answers = ['当人意识到自己正受到观察，表现可能发生变化；不能单凭这种变化确认干预本身有效。',
    '观察带来的行为变化与干预效果需要区分，所以观察后变好本身不能证明某项干预有效。'];
  return { id, startedAt: at, endedAt: at, masteryEligible: true, questionText: questions[0], knowledgeContext: '',
    messages: questions.flatMap((content, index) => [{ id: `q${index}`, role: 'assistant' as const, content, timestamp: at },
      { id: `a${index}`, role: 'user' as const, content: answers[index], timestamp: at }]),
    answerEvidence: answers.map((answer, index) => ({ messageId: `a${index}`, answer, hintLevel: 0, targetKnowledgeNames: [title],
      questionIntent: { version: 1, questionMessageId: `q${index}`, knowledgeTargets: [title],
        assessment: freezeReviewAssessment('definition', [title]) } })) };
}
const readers = { readNotes: async () => structuredClone(source), searchNotes: async () => [], searchDocuments: async () => [],
  loadCognition: async () => assert.fail('Cognition must not be used as a grading reference'),
  previewDocument: async () => { throw new Error('No external documents in this fixture'); } };
async function run(id: string, states: [MasteryShadowCriterionState, MasteryShadowCriterionState]) {
  const episode = capture(id);
  const session = await prepareReviewComparisonSession(episode, readers, { targetScopeNoteIds: [note.id] });
  const plan = planReviewMastery(source, note.id, episode, session);
  assert.equal(plan.items.length, 1);
  // Keep this scheduling regression on the supported historical input contract, independent of new semantic fields.
  plan.items[0].input.task.referenceContract = 'criterion-baseline-v2';
  episode.masteryAssessment = await evaluateReviewMastery(plan, async ({ userInput }) => {
    const input = JSON.parse(userInput);
    const reference = input.references[0];
    return { protocol: 'mastery-shadow-evaluator-v1', evaluationId: input.evaluationId, knowledgePointId: input.knowledgePointId,
      evidence: [{ id: 'E1', quote: episode.answerEvidence![0].answer }],
      baselines: input.criteria.map((criterion: { id: string }) => ({ id: criterion.id, coverage: 'covered',
        rule: 'Fixture standard supplied by the saved knowledge note.', referenceIds: [reference.id],
        referenceQuotes: [{ referenceId: reference.id, quote: reference.quote }], reason: 'Fixture-only baseline, no semantic claim.' })),
      criteria: input.criteria.map((criterion: { id: string }, index: number) => ({ id: criterion.id, state: states[index],
        evidenceIds: ['E1'], reason: 'Synthetic scheduling state, not a model judgement.' })), summary: '隔离调度测试。' };
  });
  assert.equal(episode.masteryAssessment.items[0].error, undefined);
  const outcome = prepareReviewExitOutcome(source, { noteId: note.id, noteTitle: title, analysis: null, episode });
  assert.equal(outcome.masteryEvaluations?.length, 1, 'The real writer must accept and reparse the fixture');
  const replay = prepareReviewExitOutcome(outcome.notes, { noteId: note.id, noteTitle: title, analysis: null, episode });
  assert.deepEqual(replay.notes, outcome.notes, 'A repeated save must not update the scheduler or mastery a second time');
  return outcome;
}

try {
  const mixed = await run('scope-mixed', ['pass', 'unverifiable']);
  const mixedDsr = mixed.notes[0].dsrState!;
  assert.equal(mixed.masteryEvaluations![0].observations[0].results[0].verdict, 'partial',
    'The layer summary remains incomplete; scheduling must not mistake that summary for an actual partial answer');
  assert.equal(mixedDsr.reviewCount, 3);
  assert.equal(mixedDsr.consecutiveCorrect, 2);
  assert.equal(mixedDsr.consecutiveWrong, 0);
  assert.equal(mixedDsr.difficulty, updateDifficulty(note.dsrState!.difficulty, 4, note.dsrState!.reviewCount));
  assert.ok(Math.abs(mixedDsr.stability - updateStability(note.dsrState!.stability, 4,
    calculateRetrievability(note.dsrState!.stability, note.dsrState!.lastReviewedAt))) < 0.00001,
    'Grade-4 stability may differ only by the milliseconds elapsed during this check');

  const uncertain = await run('scope-uncertain', ['unverifiable', 'not_observed']);
  const uncertainDsr = uncertain.notes[0].dsrState!;
  for (const key of ['difficulty', 'stability', 'lastReviewedAt', 'reviewCount', 'consecutiveCorrect', 'consecutiveWrong'] as const) {
    assert.equal(uncertainDsr[key], note.dsrState![key], `No decisive criterion: preserve scheduler ${key}`);
  }
  assert.equal(uncertainDsr.reviewSessionIds, undefined);
  assert.ok(!uncertain.learningChanges.some(change => ['difficulty', 'stability'].includes(change.field)));

  const failed = await run('scope-failed', ['fail', 'unverifiable']);
  assert.equal(failed.notes[0].dsrState!.reviewCount, 3);
  assert.equal(failed.notes[0].dsrState!.consecutiveWrong, 1);
  assert.equal(failed.notes[0].dsrState!.difficulty, updateDifficulty(note.dsrState!.difficulty, 1, note.dsrState!.reviewCount));
  const partial = await run('scope-real-partial', ['partial', 'unverifiable']);
  assert.equal(partial.notes[0].dsrState!.difficulty, updateDifficulty(note.dsrState!.difficulty, 2, note.dsrState!.reviewCount),
    'A real partial criterion remains a partial recall rather than being silently promoted to pass');

  const historical: MasteryShadowObservation = { id: 'old', knowledgePointId: note.id, occurredAt: at,
    source: 'socratic_review', coverage: 'assessed', assistance: 'independent', referenceBasis: 'grounded', strength: 'natural',
    results: [{ layer: 'concept', verdict: 'partial', criterionIds: ['concept_accuracy'], userEvidenceIds: ['E1'], referenceIds: ['R1'] }] };
  assert.deepEqual(reviewSchedulingVerdicts(historical), ['partial'], 'Historical layer-only receipts remain compatible');
  assert.deepEqual(reviewSchedulingVerdicts({ ...historical, results: [{ ...historical.results[0], criterionResults: [] }] }), [],
    'An explicit empty criterion list must not fall back to a potentially fabricated partial layer summary');
  assert.deepEqual(reviewSchedulingVerdicts({ ...historical, results: [{ ...historical.results[0], criterionResults: [
    { id: 'concept_accuracy', verdict: 'fail', userEvidenceIds: [], referenceIds: ['R1'], referenceBasis: 'grounded' },
    { id: 'concept_boundary', verdict: 'fail', userEvidenceIds: ['E1'], referenceIds: [], referenceBasis: 'unavailable' },
  ] }] }), [], 'Ungrounded or evidence-free decisions must never affect scheduling');
  assert.equal(JSON.stringify(source), initial, 'The isolated checks must not mutate their source notes');
  console.log('PASS: grounded criterion scheduling; unknown/missing scope never becomes partial recall; real fail/partial, legacy receipts and idempotence preserved. No network or user data.');
} finally {
  if (previousMode === undefined) delete process.env.VITE_MASTERY_READ_MODE;
  else process.env.VITE_MASTERY_READ_MODE = previousMode;
}
