import assert from 'node:assert/strict';
import type { SceneSpec, SceneRunState } from '../src/types';
import { createRunState, appendMessage } from '../src/services/scene/sceneRuntime';
import { resolveSceneInputAvailability, sceneInputAvailabilityContext } from '../src/services/scene/sceneInputAvailability';
import { getPendingSceneInteraction, validateSceneTaskUpdate } from '../src/services/scene/scenePendingTask';
import { generateGeneralTurn, buildGeneralTurnSystemPrompt } from '../src/services/scene/sceneDirector';
import { understandingFixture } from './scene-semantic-fixture';

globalThis.fetch = async () => assert.fail('Input handoff checks must not access the network or user data');
const spec = {
  sceneId: 'synthetic-input-handoff', meta: {name: 'Synthetic handoff', subject: 'Synthetic only', sceneSkill: 'S1', goal: 'Discuss then choose inputs', knowledgePoints: []},
  capabilityRecipeId: 'agent-designed', capabilityIds: ['text', 'single-choice'],
  promptModuleIds: ['turn-agent-planning', 'structured-interaction', 'input-form', 'resource-grounding'],
  role: {id: 'tutor', name: 'Synthetic tutor', attributes: []}, userRole: '', situation: '', task: 'Synthetic task',
  resources: [], rules: [], metrics: [], events: [], evaluationDimensions: [], completion: {mode: 'signal', maxTurns: 12},
  behavior: {recipeId: 'agent-designed', kind: 'Synthetic', aiBehavior: 'Follow the user', userAction: 'Answer or discuss',
    evaluationRule: 'Local checking only', progressionRule: 'Agent chooses within the contract',
    interaction: {version: '1.0', allowedTypes: ['text', 'single-choice'], defaultType: 'single-choice', allowTextFallback: true}},
  inputForm: {id: 'context-form', title: 'Synthetic context', fields: [
    {id: 'context', label: 'Context', kind: 'textarea', purpose: 'context', required: true, maxLength: 1000},
  ]},
  runtimeContract: {allowedTools: ['knowledge-notes'], allowConversation: true, allowTextFallback: true},
} as SceneSpec;
const question = {id: 'original-question', type: 'single-choice' as const, required: true,
  options: [{id: 'a', label: 'A'}, {id: 'b', label: 'B'}]};
let run = appendMessage(createRunState(spec), {id: 'question-message', speakerType: 'role', speakerName: 'Tutor',
  content: 'Synthetic question', timestamp: '', interaction: question});
run = appendMessage(run, {id: 'user-help', speakerType: 'user', speakerName: 'User',
  content: '先解释本题，保留原题。', timestamp: '', inputKind: 'conversation'});
assert.equal(resolveSceneInputAvailability(spec, run).formAvailable, false);
assert.equal(sceneInputAvailabilityContext(spec, run).pendingInteractionId, question.id);
assert.ok(!('inputForm' in sceneInputAvailabilityContext(spec, run)), 'full form schema is not duplicated into every model phase');
assert.match(buildGeneralTurnSystemPrompt(spec), /不能为了调用工具自动取消/);

async function verifyAllPhases(current: SceneRunState, available: boolean) {
  const phases: string[] = [], latest = current.messages.findLast(message => message.speakerType === 'user')!;
  const result = await generateGeneralTurn(spec, current, {dependencies: {callLlm: async request => {
    if (request.workflow === 'scene-turn-plan') {
      const input = JSON.parse(request.userInput);
      phases.push(input.phase);
      assert.equal(input.inputAvailability.formAvailable, available, input.phase + ' sees the local input facts');
      assert.ok(!('inputForm' in input.inputAvailability));
      if (input.phase === 'understand') return {content: JSON.stringify({understanding: understandingFixture(latest.id, latest.content,
        {informationGaps: [{id: 'material', kind: 'reference-material', description: 'Synthetic material gap'}]}), action: 'respond'})};
      return {content: JSON.stringify({action: 'respond', stageId: 'interaction', responseGuidance: 'Preserve task and explain availability',
        preferredInteractionType: 'single-choice', toolRequests: []})};
    }
    assert.equal(request.workflow, 'scene-general-turn'); phases.push('respond');
    assert.ok(request.userInput.includes('"formAvailable":' + String(available)), 'response sees the same availability facts');
    return {content: JSON.stringify({content: 'Synthetic explanation, without a new task.'})};
  }, searchNotes: async () => assert.fail('No tool is needed by this synthetic plan')}});
  assert.deepEqual(phases, ['understand', 'plan', 'respond']);
  assert.equal(result.interaction, undefined); assert.equal(result.taskUpdate, undefined);
}
await verifyAllPhases(run, false);
assert.equal(getPendingSceneInteraction(run)?.interaction?.id, question.id, 'an explanation cannot implicitly release the answer slot');
const formOnly = appendMessage(run, {id: 'unrelated-form', speakerType: 'user', speakerName: 'User', content: 'Synthetic form data',
  timestamp: '', inputKind: 'response', formSubmission: {formId: 'context-form', values: {context: 'Synthetic only'}}});
assert.equal(resolveSceneInputAvailability(spec, formOnly).formAvailable, false, 'a form record is not an objective answer');
const answered = appendMessage(run, {id: 'answer', speakerType: 'user', speakerName: 'User', content: 'A', timestamp: '', inputKind: 'response',
  interactionResponse: {interactionId: question.id, type: 'single-choice', selectedId: 'a', submittedAt: ''}});
assert.equal(resolveSceneInputAvailability(spec, answered).formAvailable, true, 'a validated answer releases the form');
let canceled = appendMessage(run, {id: 'cancel-source', speakerType: 'user', speakerName: 'User',
  content: '取消当前题，切换到表单。', timestamp: '', inputKind: 'conversation'});
const update = validateSceneTaskUpdate({operation: 'cancel', interactionId: question.id,
  sourceUserMessageId: 'cancel-source', reason: 'Synthetic explicit handoff'}, canceled)!;
canceled = {...canceled, retiredInteractionIds: [update.interactionId]};
assert.equal(resolveSceneInputAvailability(spec, canceled).formAvailable, true);
await verifyAllPhases(canceled, true);
assert.equal(resolveSceneInputAvailability(spec, {...answered, status: 'success'}).formAvailable, false);
assert.equal(resolveSceneInputAvailability({...spec, runtimeContract: {allowTextFallback: false}} as SceneSpec, answered).formAvailable, false);
assert.doesNotThrow(() => resolveSceneInputAvailability({...spec, inputForm: {bad: true}} as unknown as SceneSpec, answered));
assert.equal(resolveSceneInputAvailability({...spec, inputForm: {bad: true}} as unknown as SceneSpec, answered).formAvailable, false);
console.log('Scene input handoff passed: shared local facts in understand/plan/respond, no implicit task retirement, answer/cancel release, source preservation and terminal/permission/schema locks. Synthetic decisions only.');
