import assert from 'node:assert/strict';
import { evaluateQuickCheck, applyQuickCheckAssessment, type QuickCheckAnswer } from '../src/services/quickCheck';
import { sunkCostNote } from './fixtures/quick-check-sunk-cost';
import { masteryBaselineFixture, masteryComparisonFixture } from './fixtures/mastery-baselines';
import { deserializeUserStateFile, serializeUserStateFile, splitUserStateFields, mergeNote } from '../src/services/userStateService';
import { quickCheckDesignFixture, generateQuickCheckFixture as generateQuickCheck } from './fixtures/quick-check-design';

globalThis.fetch = async () => assert.fail('No network or real vault');
const card = await generateQuickCheck({ note: sunkCostNote, readers: { searchNotes: async () => [] }, call: async request => {
  const input = JSON.parse(request.userInput);
  return { content: JSON.stringify(quickCheckDesignFixture(request, { questions: ['Q1', 'Q2', 'Q3'].map((id, index) => ({
    id, type: index ? 'choice' : 'application', prompt: index ? `合成识别题${index}` : '解释含义和边界，并应用到题设决策。',
    criterionIds: index ? [input.targets[index - 1].id] : input.targets.map((target: any) => target.id),
    referenceIds: input.references.map((ref: any) => ref.id),
    ...(index ? { options: [{ id: 'A', text: '符合' }, { id: 'B', text: '不符合' }] } : {}),
    privateAnswer: { ...(index ? { optionId: 'A' } : {}), explanation: 'Synthetic transport fixture only.',
      referenceQuotes: input.references.map((ref: any) => ({ referenceId: ref.id, quote: ref.quote.slice(0, 160) })) },
  })) })) };
} });
const answers: QuickCheckAnswer[] = [{ questionId: 'Q1', text: '已发生且无法收回的投入是沉没成本，不能据此决定未来投入。题设继续的未来净收益为100万元。' },
  { questionId: 'Q2', optionId: 'A' }, { questionId: 'Q3', optionId: 'A' }];
async function assess(actual = answers, scenario = 'pass') {
  return evaluateQuickCheck(card, actual, { call: async request => {
    const input = JSON.parse(request.userInput);
    return { content: JSON.stringify({ protocol: 'quick-check-evaluation-v2', sessionId: card.id,
      questionEvaluations: input.questionTasks.map((task: any) => {
        const scope = task.task.verificationScopes[0];
        const scoped = { ...task, references: input.references.filter((ref: any) => scope.referenceIds.includes(ref.id)) };
        return { questionId: task.questionId, result: { protocol: 'mastery-shadow-evaluator-v1',
          evaluationId: task.evaluationId, knowledgePointId: input.knowledgePointId,
          baselines: masteryBaselineFixture(scoped), evidence: [{ id: 'E1', quote: scenario === 'foreign' && task.questionId === 'Q1' ? 'not user evidence' : task.answer }],
          criteria: task.criteria.map((criterion: any) => {
            const state = scenario === 'partial' && task.questionId === 'Q1' && criterion.id === 'concept_application' ? 'partial'
              : scenario === 'conflict' && task.questionId === 'Q2' ? 'fail' : 'pass';
            return { id: criterion.id, state, evidenceIds: ['E1'], referenceIds: scope.referenceIds,
              ...(state === 'pass' ? {} : { comparison: masteryComparisonFixture(scoped, criterion.id, ['E1']) }), reason: 'Synthetic semantic verdict, not a model quality proof.' };
          }), summary: 'fixture' },
          ...(task.questionId === 'Q1' ? {} : { answerKey: { optionId: scenario === 'conflict' && task.questionId === 'Q2' ? 'B' : 'A',
            explanation: 'Synthetic answer key', referenceQuotes: [{ referenceId: scoped.references[0].id, quote: scoped.references[0].quote.slice(0, 160) }] } }) };
      }) }) };
  } });
}
const assessment = await assess();
const applied = applyQuickCheckAssessment([sunkCostNote], card, assessment);
assert.equal(applied.notes[0].dsrState!.masteryShadow!.layers.concept.state, 'confirmed', 'all three open demonstrations confirm layer once');
for (const row of Object.values(applied.notes[0].dsrState!.masteryShadow!.layers.concept.criteria!)) assert.equal(row.independentPasses, 1);
assert.equal(applied.notes[0].dsrState!.masteryShadow!.layers.judgment.state, 'unassessed');
assert.deepEqual(applyQuickCheckAssessment(applied.notes, card, JSON.parse(JSON.stringify(assessment))).notes, applied.notes, 'save/replay remains idempotent');
const stored = deserializeUserStateFile(serializeUserStateFile({ [sunkCostNote.id]: splitUserStateFields(applied.notes[0]) }));
const restored = mergeNote(sunkCostNote, stored[sunkCostNote.id]);
assert.equal(restored.dsrState!.masteryShadow!.layers.concept.state, 'confirmed', 'single-demonstration confirmation survives the real user-state codec');
assert.equal(applyQuickCheckAssessment([restored], card, JSON.parse(JSON.stringify(assessment))).applied, false);
const recognized = applyQuickCheckAssessment([sunkCostNote], card, await assess(answers.map(answer => answer.questionId === 'Q1' ? { questionId: 'Q1', skipped: true } : answer)));
assert.equal(recognized.notes[0].dsrState!.masteryShadow!.layers.concept.criteria!.concept_accuracy.state, 'provisional');
assert.equal(recognized.notes[0].dsrState!.masteryShadow!.layers.concept.criteria!.concept_application.state, 'unassessed');
const assisted = applyQuickCheckAssessment([sunkCostNote], card, await assess(answers.map(answer => ({ ...answer, assisted: true }))));
assert.ok(Object.values(assisted.notes[0].dsrState!.masteryShadow!.layers.concept.criteria!).every(row => row.state !== 'confirmed' && row.independentPasses === 0));
const partial = applyQuickCheckAssessment([sunkCostNote], card, await assess(answers, 'partial'));
assert.equal(partial.notes[0].dsrState!.masteryShadow!.layers.concept.criteria!.concept_application.state, 'unassessed', 'partial cannot confirm');
const foreign = applyQuickCheckAssessment([sunkCostNote], card, await assess(answers, 'foreign'));
assert.equal(foreign.notes[0].dsrState!.masteryShadow!.layers.concept.criteria!.concept_accuracy.state, 'provisional', 'invalid open proof cannot elevate valid choice');
const conflict = applyQuickCheckAssessment([sunkCostNote], card, await assess(answers, 'conflict'));
assert.equal(conflict.notes[0].dsrState!.masteryShadow!.layers.concept.criteria!.concept_accuracy.state, 'needs_review', 'a contrary same-card result blocks confirmation');
console.log('PASS one sufficient open demonstration per criterion; complete coverage required; choice-only pending; assisted/partial/unbound proof held; contrary evidence and idempotent replay. Synthetic only.');
