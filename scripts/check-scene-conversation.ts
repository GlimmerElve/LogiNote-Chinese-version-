import assert from 'node:assert/strict';
import type { LlmCallRequest, SceneRunState, SceneSpec } from '../src/types';
import { parseSceneSpec, applySceneAssemblyPlan } from '../src/services/scene/sceneGenerator';
import { createRunState } from '../src/services/scene/sceneRuntime';
import { resolveSceneRuntimeContract } from '../src/services/scene/sceneRuntimeContract';
import { normalizeSceneInteractionDirective } from '../src/services/scene/sceneInteraction';
import { normalizeSceneObjectiveEvaluation, gradeSceneObjectiveResponse } from '../src/services/scene/sceneAssessment';
import { getPendingSceneInteraction, pendingSceneContext, validateSceneTaskUpdate } from '../src/services/scene/scenePendingTask';
import { generateGeneralTurn } from '../src/services/scene/sceneDirector';
import { understandingFixture } from './scene-semantic-fixture';
import { readSceneUnderstanding } from '../src/services/scene/sceneUnderstanding';

globalThis.fetch = async () => assert.fail('Conversation checks are offline');
const spec = applySceneAssemblyPlan(parseSceneSpec(JSON.stringify({ meta: { name: 'Practice', subject: 'Physics', goal: 'Practice with conversation' }, task: 'Choose or ask for help',
  behavior: { recipeId: 'agent-designed', kind: 'practice', aiBehavior: 'Understand intent', userAction: 'Choose or discuss', evaluationRule: 'Local task grading', progressionRule: 'Preserve pending',
    interaction: { version: '1.0', allowedTypes: ['single-choice'], defaultType: 'single-choice', allowTextFallback: false } } })),
  { subject: 'Physics', knowledgePoints: [], sceneSkill: 'S1', recipeId: 'agent-designed', requestedCapabilities: ['single-choice'], requestedPromptModules: ['turn-agent-planning', 'structured-interaction'] });
const contract = resolveSceneRuntimeContract(spec);
assert.equal(contract.allowConversation, true); assert.equal(contract.allowTextFallback, false);
assert.deepEqual(contract.allowedInteractionTypes, ['single-choice']);
assert.equal(resolveSceneRuntimeContract({ ...spec, runtimeContract: { ...contract, allowConversation: false } }).allowConversation, false);
assert.throws(() => resolveSceneRuntimeContract({ ...spec, runtimeContract: { ...contract, allowConversation: 'yes' } as never }), /allowConversation/);
const choice = { id: 'q1', type: 'single-choice' as const, required: true, assessment: 'objective' as const, options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] };
const key = { interactionId: 'q1', type: 'single-choice' as const, correctId: 'b', explanation: 'PRIVATE_KEY_NEVER_INJECT' };
const protocol = { version: '1.0' as const, allowedTypes: ['single-choice' as const], defaultType: 'single-choice' as const, allowTextFallback: false };
assert.ok(normalizeSceneInteractionDirective({ ...choice, assessment: undefined }, protocol), 'legacy storage remains readable');
assert.equal(normalizeSceneInteractionDirective({ ...choice, assessment: 'bad' }, protocol), undefined);
assert.equal(normalizeSceneObjectiveEvaluation(key, { ...choice, assessment: 'none' }), undefined);
const response = { interactionId: 'q1', type: 'single-choice' as const, selectedId: 'b', submittedAt: '' };
function newRun(text = 'Explain this concept.', pending = false): SceneRunState {
  const run = createRunState(spec);
  if (pending) run.messages.push({ id: 'old-task', speakerType: 'role', speakerName: 'Tutor', content: 'OLD_TASK_CONTENT', timestamp: '', interaction: choice, objectiveEvaluation: key });
  run.messages.push({ id: 'latest-user', speakerType: 'user', speakerName: 'User', content: text, timestamp: '', inputKind: 'conversation' });
  return run;
}
function model(run: SceneRunState, body: unknown, requests: LlmCallRequest[], intent = 'conversation', pendingTaskAction: 'keep' | 'replace' | 'cancel' = 'keep') {
  return async (request: LlmCallRequest) => {
    requests.push(request);
    if (request.workflow === 'scene-turn-plan') {
      const input = JSON.parse(request.userInput), user = run.messages.findLast(m => m.speakerType === 'user')!;
      return { content: JSON.stringify(input.phase === 'plan' ? { action: 'respond', toolRequests: [] } : { action: 'respond',
        understanding: understandingFixture(user.id, user.content, { intent: intent as never, pendingTaskAction }) }) };
    }
    return { content: JSON.stringify(body) };
  };
}
const pending = newRun('Give a hint, keep this question.', true);
assert.equal(getPendingSceneInteraction(pending)?.interaction?.id, 'q1');
assert.doesNotMatch(JSON.stringify(pendingSceneContext(pending)), /PRIVATE_KEY|correctId|objectiveEvaluation/);
const fake = { id: 'answer', speakerType: 'user' as const, speakerName: 'User', content: 'hint', timestamp: '', inputKind: 'conversation' as const, interactionResponse: response };
assert.equal(getPendingSceneInteraction({ ...pending, messages: [...pending.messages, fake] })?.interaction?.id, 'q1');
assert.equal(getPendingSceneInteraction({ ...pending, messages: [{ ...fake, inputKind: 'response' }, ...pending.messages] })?.interaction?.id, 'q1');
assert.equal(getPendingSceneInteraction({ ...pending, messages: [...pending.messages, { ...fake, inputKind: 'response', interactionResponse: { ...response, selectedId: 'unknown' } }] })?.interaction?.id, 'q1');
assert.equal(getPendingSceneInteraction({ ...pending, messages: [...pending.messages, { ...fake, inputKind: 'response' }] }), undefined);
const replacement = { ...choice, id: 'q2' };
const cancel = { operation: 'cancel' as const, interactionId: 'q1', sourceUserMessageId: 'latest-user', reason: 'Current user request' };
assert.deepEqual(validateSceneTaskUpdate(cancel, pending), cancel);
for (const raw of [null, {}, { ...cancel, sourceUserMessageId: 'old-task' }, { ...cancel, interactionId: 'wrong' }, { ...cancel, reason: '' }, { ...cancel, force: true }]) assert.throws(() => validateSceneTaskUpdate(raw, pending));
assert.throws(() => validateSceneTaskUpdate(cancel, pending, replacement));
assert.throws(() => validateSceneTaskUpdate({ ...cancel, operation: 'replace' }, pending, choice));
assert.equal(validateSceneTaskUpdate({ ...cancel, operation: 'replace' }, pending, replacement)?.operation, 'replace');
for (const allowConversation of [true, false]) {
  const run = newRun(), requests: LlmCallRequest[] = [];
  const reply = await generateGeneralTurn({ ...spec, runtimeContract: { ...contract, allowConversation } }, run, { dependencies: { callLlm: model(run, { content: 'An explanation without a task.' }, requests) } });
  assert.equal(reply.interactionDiagnostic.reason, 'conversation'); assert.equal(reply.interaction, undefined); assert.equal(requests.length, 2);
}
for (const mode of ['dialogue', 'qa', 'simulation', 'assessment', 'coaching'] as const) {
  const run = newRun('Give one objective question.'), requests: LlmCallRequest[] = [];
  const result = await generateGeneralTurn({ ...spec, runtimeContract: { ...contract, mode, evaluation: 'none' } }, run, { dependencies: { callLlm: model(run, { content: 'Choose', interaction: choice, evaluation: key }, requests) } });
  assert.equal(gradeSceneObjectiveResponse(response, result.objectiveEvaluation)?.correct, true);
}
const strategyRun = newRun('Offer an ungraded strategy choice.');
const strategy = await generateGeneralTurn(spec, strategyRun, { dependencies: { callLlm: model(strategyRun, { content: 'A strategy', interaction: { ...choice, assessment: 'none' } }, []) } });
assert.equal(strategy.objectiveEvaluation, undefined);
for (const body of [{ content: 'Missing marker', interaction: { ...choice, assessment: undefined }, evaluation: key },
  { content: 'Missing key', interaction: choice }, { content: 'Wrong key', interaction: choice, evaluation: { ...key, correctId: 'unknown' } },
  { content: 'Unauthorized', interaction: { ...choice, type: 'multiple-choice' } }]) {
  const run = newRun('Give one question.'), requests: LlmCallRequest[] = [];
  await assert.rejects(generateGeneralTurn(spec, run, { dependencies: { callLlm: model(run, body, requests) } }), /契约/);
  assert.equal(requests.filter(r => r.workflow === 'scene-general-turn').length, 2);
}
pending.messages.splice(1, 0, ...Array.from({ length: 12 }, (_, i) => ({ id: 'history-' + i, speakerType: 'role' as const, speakerName: 'Tutor', timestamp: '', content: 'later chat ' + i })));
const grounded: SceneSpec = { ...spec, promptModuleIds: [...spec.promptModuleIds!, 'resource-grounding'], runtimeContract: { ...contract, allowedTools: ['knowledge-notes'] } };
const phases: string[] = []; let plans = 0, reads = 0;
await generateGeneralTurn(grounded, pending, { dependencies: {
  callLlm: async request => {
    assert.doesNotMatch(JSON.stringify(request), /PRIVATE_KEY_NEVER_INJECT/);
    if (request.workflow === 'scene-turn-plan') {
      const input = JSON.parse(request.userInput); phases.push(input.phase); assert.deepEqual(input.pendingTask, JSON.parse(JSON.stringify(pendingSceneContext(pending))));
      return { content: JSON.stringify(input.phase === 'understand' ? { action: 'respond', understanding: understandingFixture('latest-user', pending.messages.at(-1)!.content, { intent: 'help',
        informationGaps: [{ id: 'hint', kind: 'reference-material', description: 'Need a grounded hint' }] }) }
        : { action: 'respond', toolRequests: ++plans === 1 ? [{ id: 'knowledge-notes', query: 'velocity', needId: 'hint', reason: 'Ground the hint' }] : [] }) };
    }
    phases.push('respond'); assert.match(request.userInput, /当前待答任务/); assert.match(request.userInput, /OLD_TASK_CONTENT/);
    assert.ok(request.messages?.every(m => !m.content.includes('OLD_TASK_CONTENT')));
    return { content: JSON.stringify({ content: 'Hint without another task.' }) };
  }, searchNotes: async () => { reads++; return [{ noteId: 'ref', noteType: 'knowledge', title: 'Velocity', snippet: 'Displacement changes over time.', score: 1 }]; },
} });
assert.deepEqual(phases, ['understand', 'plan', 'plan', 'respond']); assert.equal(reads, 1);
assert.equal(getPendingSceneInteraction(pending)?.interaction?.id, 'q1');
for (const operation of ['replace', 'cancel'] as const) {
  const run = newRun('Change the current task.', true), taskUpdate = { ...cancel, operation };
  const body = { content: 'Changed', taskUpdate, ...(operation === 'replace' ? { interaction: replacement, evaluation: { ...key, interactionId: 'q2' } } : {}) };
  const result = await generateGeneralTurn(spec, run, { dependencies: { callLlm: model(run, body, [], 'change-direction', operation) } });
  assert.deepEqual(result.taskUpdate, taskUpdate); assert.equal(run.retiredInteractionIds, undefined);
}
for (const body of [{ content: 'Second task', interaction: replacement, evaluation: { ...key, interactionId: 'q2' } },
  { content: 'Stale cancel', taskUpdate: { ...cancel, sourceUserMessageId: 'old-task' } },
  { content: 'A hint must not cancel', taskUpdate: cancel },
  { content: 'Future difficulty must not replace', taskUpdate: { ...cancel, operation: 'replace' }, interaction: replacement, evaluation: { ...key, interactionId: 'q2' } }]) {
  const run = newRun('Explain the current question.', true);
  await assert.rejects(generateGeneralTurn(spec, run, { dependencies: { callLlm: model(run, body, []) } }), /契约/);
}
for (const pendingTaskAction of [null, '', 'skip', 1]) {
  assert.throws(() => readSceneUnderstanding({ ...understandingFixture('u', 'Change this task'), pendingTaskAction }, new Map([['u', 'Change this task']]), 'u'), /pendingTaskAction/);
}
const endRun = newRun('Summarize and end now.', true);
assert.equal((await generateGeneralTurn(spec, endRun, { dependencies: { callLlm: model(endRun, { content: 'Summary' }, [], 'end') } })).userRequestedEnd, true);
console.log('Scene conversation passed: strict task protocol, independent conversation, per-task grading across modes, protected pending task in three phases, bounded repair and source-bound replacement/cancellation. Offline synthetic semantics.');

/** Replay the concrete failure shape observed from the real provider; keep execution validation strict. */
const replayRun = newRun('Give a new objective question.');
const badEnvelope = { content: 'Choose', interaction: { type: 'single-choice', schema: choice }, evaluation: key,
  taskUpdate: { operation: 'keep' } };
let replayResponses = 0;
await generateGeneralTurn(spec, replayRun, { dependencies: { callLlm: async request => {
  if (request.workflow === 'scene-turn-plan') return { content: JSON.stringify({ action: 'respond',
    understanding: understandingFixture('latest-user', replayRun.messages.at(-1)!.content) }) };
  replayResponses++;
  if (replayResponses === 2) {
    assert.match(request.userInput, /missing-id/);
    assert.match(request.systemPromptOverride!, /扁平数据对象/);
    assert.match(request.systemPromptOverride!, /必须省略taskUpdate/);
  }
  return { content: JSON.stringify(replayResponses === 1 ? badEnvelope : { content: 'Choose', interaction: choice, evaluation: key }) };
} } });
assert.equal(replayResponses, 2, 'malformed schema/keep is repaired rather than accepted as an alternate protocol');
