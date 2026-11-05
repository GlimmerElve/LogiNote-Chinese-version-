import assert from 'node:assert/strict';
import type { LlmCallRequest, SceneInteractionDirective, SceneRunState } from '../src/types';
import { parseSceneSpec, applySceneAssemblyPlan } from '../src/services/scene/sceneGenerator';
import { createRunState } from '../src/services/scene/sceneRuntime';
import { generateGeneralTurn } from '../src/services/scene/sceneDirector';
import { normalizeSceneInteractionResponse, formatSceneInteractionResponseContent } from '../src/services/scene/sceneInteraction';
import { gradeSceneObjectiveResponse } from '../src/services/scene/sceneAssessment';
import { sceneAnswerFeedbackView } from '../src/services/scene/sceneTeaching';
import { understandingFixture } from './scene-semantic-fixture';
import type { SceneTurnAttemptDiagnostic } from '../src/services/scene/sceneTurnDiagnostics';

globalThis.fetch = async () => assert.fail('Ordering runtime checks are offline');
const spec = applySceneAssemblyPlan(parseSceneSpec(JSON.stringify({ meta: { name: 'Ordering', subject: 'Process', goal: 'Practice task ordering' }, task: 'Arrange one process task.',
  behavior: { recipeId: 'agent-designed', kind: 'practice', aiBehavior: 'Understand then respond', userAction: 'Order or discuss', evaluationRule: 'Local task grading', progressionRule: 'Agent organized',
    interaction: { version: '1.0', allowedTypes: ['ordering'], defaultType: 'ordering', allowTextFallback: false } },
  runtimeContract: { mode: 'coaching', initiator: 'either', allowedTools: [], allowedInteractionTypes: ['ordering'], evaluation: 'each-answer',
    answerFeedback: { correctness: 'immediate', explanation: 'immediate' }, completion: 'user-controlled', allowConversation: true,
    scope: { noteIds: [], documentIds: [], cognitionRecordIds: [] }, maxToolCallsPerTurn: 0, maxPlanningSteps: 1, maxUserTasksPerTurn: 1 },
})), { subject: 'Process', knowledgePoints: [], sceneSkill: 'S1', recipeId: 'agent-designed', requestedCapabilities: ['ordering'], requestedPromptModules: ['turn-agent-planning', 'structured-interaction'] });
const items = [{ id: 'prepare', content: '准备' }, { id: 'execute', content: '执行' }, { id: 'finish', content: '收尾' }];
const interaction: SceneInteractionDirective = { id: 'ordering-objective', type: 'ordering', assessment: 'objective', required: true, items };
const evaluation = { interactionId: interaction.id, type: 'ordering', correctOrderIds: ['prepare', 'execute', 'finish'], explanation: '先准备，再执行，最后收尾。' };
function run(): SceneRunState {
  const state = createRunState(spec);
  state.messages.push({ id: 'ordering-user', speakerType: 'user', speakerName: 'User', content: '请给一道流程排序题。', timestamp: '', inputKind: 'conversation' });
  return state;
}
const call = (reply: unknown, count?: { response: number }) => async (request: LlmCallRequest) => {
  if (request.workflow === 'scene-turn-plan') {
    const data = JSON.parse(request.userInput);
    assert.equal(data.phase, 'understand');
    return { content: JSON.stringify({ action: 'respond', understanding: understandingFixture(data.latestUserInput.sourceId, data.latestUserInput.text, { intent: 'question' }) }) };
  }
  if (count) count.response++;
  return { content: JSON.stringify(reply) };
};
const output = await generateGeneralTurn(spec, run(), { dependencies: { callLlm: call({ content: '请将流程排列正确。', interaction, evaluation }) } });
assert.equal(output.interaction?.type, 'ordering'); assert.equal(output.objectiveEvaluation?.type, 'ordering');
if (output.interaction?.type !== 'ordering' || output.objectiveEvaluation?.type !== 'ordering') throw new Error('ordering objective fixture');
assert.deepEqual(output.objectiveEvaluation.correctOrderIds, evaluation.correctOrderIds, 'private target is unchanged by preparation');
assert.notDeepEqual(output.interaction.items.map(item => item.id), evaluation.correctOrderIds, 'unique target is never already solved');
assert.equal(output.interactionPreparation?.orders[0].field, 'items');
for (const [orderedIds, expected] of [[evaluation.correctOrderIds, true], [['finish', 'execute', 'prepare'], false]] as const) {
  const response = normalizeSceneInteractionResponse({ interactionId: interaction.id, type: 'ordering', orderedIds }, output.interaction)!;
  const local = gradeSceneObjectiveResponse(response, output.objectiveEvaluation);
  assert.equal(local?.correct, expected);
  const answered = run();
  answered.messages.push({ id: 'ordering-task', speakerType: 'role', speakerName: 'Tutor', content: output.content, timestamp: '',
    interaction: output.interaction, interactionPreparation: output.interactionPreparation, objectiveEvaluation: output.objectiveEvaluation },
    { id: 'ordering-answer', speakerType: 'user', speakerName: 'User', content: formatSceneInteractionResponseContent(response, output.interaction), timestamp: '',
      inputKind: 'response', interactionResponse: response, objectiveAssessment: local });
  const feedback = sceneAnswerFeedbackView(spec, answered, 'ordering-answer');
  assert.equal(feedback?.correct, expected, 'SceneTeaching uses actual ordering local grade');
  assert.equal(feedback?.explanation, evaluation.explanation);
}
const legacy = await generateGeneralTurn(spec, run(), { dependencies: { callLlm: call({ content: '自由排序。', interaction: { ...interaction, id: 'legacy-order', assessment: undefined } }) } });
assert.equal(legacy.interaction?.type, 'ordering'); assert.equal(legacy.objectiveEvaluation, undefined, 'legacy unmarked ordering remains readable without fabricated key');
for (const bad of [undefined, { ...evaluation, correctOrderIds: ['prepare', 'prepare', 'finish'] }]) {
  const attempts: SceneTurnAttemptDiagnostic[] = [], count = { response: 0 };
  await assert.rejects(generateGeneralTurn(spec, run(), { dependencies: { callLlm: call({ content: '排序。', interaction, evaluation: bad }, count), onDiagnostic: value => attempts.push(value) } }), /invalid-ordering-key/);
  assert.equal(count.response, 2, 'only one bounded format repair');
  const responseAttempts = attempts.filter(value => value.phase === 'respond');
  assert.deepEqual(responseAttempts.map(value => value.outcome), ['repairing', 'rejected']);
  assert.ok(responseAttempts.every(value => value.issues.some(issue => issue.code === 'invalid-ordering-key' && issue.path === 'evaluation')));
}
console.log('Scene ordering runtime checks passed: new objective private target, one-time preparation, local correct/wrong teaching feedback, legacy compatibility and two-attempt invalid-ordering-key rejection. Offline only.');
