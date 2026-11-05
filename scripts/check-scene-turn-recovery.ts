import assert from 'node:assert/strict';
import type { LlmCallRequest, LlmCallResponse, SceneSpec } from '../src/types';
import { parseSceneSpec, applySceneAssemblyPlan } from '../src/services/scene/sceneGenerator';
import { createRunState } from '../src/services/scene/sceneRuntime';
import { prepareSceneTurnAgentContext } from '../src/services/scene/sceneTurnAgent';
import { generateGeneralTurn } from '../src/services/scene/sceneDirector';
import { isSceneOutputTruncated } from '../src/services/scene/sceneOutputSafety';
import { executeSceneExperiment, sceneExperimentRecords, closeSceneExperimentSession } from '../src/services/scene/sceneExperiment';
import { understandingFixture } from './scene-semantic-fixture';

globalThis.fetch = async () => assert.fail('Turn recovery tests must remain offline');
const spec = applySceneAssemblyPlan(parseSceneSpec(JSON.stringify({
  meta: { name: 'Recovery check', subject: 'Physics', goal: 'Answer the current question' }, task: 'Explain the actual user question',
  behavior: { recipeId: 'question-answer', kind: 'Q&A', aiBehavior: 'Answer directly', userAction: 'Ask a question',
    evaluationRule: 'No automatic grading', progressionRule: 'Follow the user',
    interaction: { version: '1.0', allowedTypes: ['text'], defaultType: 'text', allowTextFallback: true } },
})), { subject: 'Physics', knowledgePoints: [], recipeId: 'question-answer', requestedCapabilities: ['text'],
  requestedPromptModules: ['turn-agent-planning', 'resource-grounding'] });
function newRun(scene: SceneSpec = spec, content = 'Explain velocity; do not grade me.') {
  const run = createRunState(scene);
  run.messages.push({ id: 'recovery-user', speakerType: 'user', speakerName: 'User', content, timestamp: '' });
  return run;
}
const state = newRun();
const understanding = understandingFixture('recovery-user', state.messages[0].content);
const semantic = JSON.stringify({ understanding, action: 'respond' });
for (const finishReason of ['length', 'MAX_TOKENS', 'max_tokens', 'max_output_tokens', 'max_completion_tokens', 'TOKEN_LIMIT']) {
  assert.equal(isSceneOutputTruncated({ content: '{}', diagnostics: { finishReason } }), true);
}
for (const finishReason of [undefined, 'stop', 'end_turn', 'STOP']) {
  assert.equal(isSceneOutputTruncated({ content: '{}', diagnostics: { finishReason } }), false);
}
for (const first of [
  { content: 'not-json' },
  { content: semantic, diagnostics: { finishReason: 'length' } },
]) {
  const requests: LlmCallRequest[] = [];
  const result = await prepareSceneTurnAgentContext(spec, state, { callLlm: async request => {
    requests.push(request);
    const input = JSON.parse(request.userInput);
    assert.equal(input.phase, 'understand');
    assert.equal(input.latestUserInput.text, state.messages[0].content);
    assert.equal(input.allowedContextSources, undefined);
    assert.equal(input.contract, undefined, 'semantic repair must remain catalogue-free');
    if (requests.length === 1) return first;
    assert.ok(input.outputRepair);
    assert.equal(input.scene.goal, spec.meta.goal);
    return { content: semantic };
  }, searchNotes: async () => assert.fail('semantic repair cannot start tools') });
  assert.equal(requests.length, 2);
  assert.equal(result.plan.understanding.userGoal, understanding.userGoal);
  if (first.diagnostics) assert.equal(requests[1].maxTokensOverride, 8192);
}
let semanticAttempts = 0;
await assert.rejects(prepareSceneTurnAgentContext(spec, state, { callLlm: async () => {
  semanticAttempts++; return { content: semantic, diagnostics: { finishReason: 'max_tokens' } };
}, searchNotes: async () => assert.fail('twice-truncated understanding cannot execute tools') }),
error => error instanceof Error && 'code' in error && error.code === 'output-truncated');
assert.equal(semanticAttempts, 2);
let clarificationAttempts = 0;
const genuineClarification = await prepareSceneTurnAgentContext(spec, state, { callLlm: async () => {
  clarificationAttempts++;
  if (clarificationAttempts === 1) return { content: 'not-json' };
  return { content: JSON.stringify({ action: 'clarify', understanding: { ...understanding, needsClarification: true,
    clarificationQuestion: 'Which chapter do you mean?', informationGaps: [{ id: 'scope', kind: 'user-clarification', description: 'The intended chapter is not identified' }] } }) };
}, searchNotes: async () => assert.fail('a genuine clarification never runs tools') });
assert.equal(clarificationAttempts, 2); assert.equal(genuineClarification.plan.action, 'clarify');
let transportAttempts = 0;
await assert.rejects(prepareSceneTurnAgentContext(spec, state, { callLlm: async () => {
  transportAttempts++; throw new Error('HTTP 401: synthetic transport failure');
} }), /理解/);
assert.equal(transportAttempts, 1, 'transport errors are not output-format repairs');
const aborted = new AbortController(); let abortAttempts = 0;
await assert.rejects(prepareSceneTurnAgentContext(spec, state, { signal: aborted.signal, callLlm: async () => {
  abortAttempts++; aborted.abort(); return { content: semantic, diagnostics: { finishReason: 'length' } };
} }), { name: 'AbortError' });
assert.equal(abortAttempts, 1);

const longText = '背景说明。'.repeat(1000) + '\n最新纠正：不要继续简单题，请提高复杂度，但不要评分。';
const longRun = newRun(spec, longText); let longReads = 0, longPlans = 0;
await prepareSceneTurnAgentContext(spec, longRun, { callLlm: async request => {
  const input = JSON.parse(request.userInput);
  if (input.phase === 'understand') {
    assert.equal(input.latestUserInput.text, longText, 'understanding retains the tail correction');
    return { content: JSON.stringify({ action: 'respond', understanding: understandingFixture('recovery-user', longText, {
      informationGaps: [{ id: 'material', kind: 'reference-material', description: 'Need the selected definition' }],
    }) }) };
  }
  longPlans++;
  assert.equal(input.latestUserInput, longText, 'planning must not cut the user correction at 1800 characters');
  return { content: JSON.stringify({ action: 'respond', toolRequests: longPlans === 1
    ? [{ id: 'knowledge-notes', query: 'velocity', needId: 'material', reason: 'Read the requested definition' }] : [] }) };
}, searchNotes: async () => { longReads++; return []; } });
assert.equal(longReads, 1);

const withGap = { ...understanding, informationGaps: [{ id: 'material', kind: 'reference-material' as const, description: 'Need a definition' }] };
let reads = 0, plans = 0, replies = 0;
const responseRequests: LlmCallRequest[] = [];
const recovered = await generateGeneralTurn(spec, state, { dependencies: { callLlm: async request => {
  if (request.workflow === 'scene-turn-plan') {
    const input = JSON.parse(request.userInput);
    if (input.phase === 'understand') return { content: JSON.stringify({ understanding: withGap, action: 'respond' }) };
    plans++;
    return { content: JSON.stringify({ action: 'respond', toolRequests: plans === 1
      ? [{ id: 'knowledge-notes', query: 'velocity', needId: 'material', reason: 'Read the definition' }] : [] }) };
  }
  responseRequests.push(request); replies++;
  if (replies === 1) return { content: JSON.stringify({ content: 'Uncommitted partial response', workingMemory: { focus: 'stale-memory' } }), diagnostics: { finishReason: 'length' } };
  assert.match(request.userInput, /重新生成完整/);
  return { content: JSON.stringify({ content: 'Complete response', workingMemory: { focus: 'recovered-memory' } }) };
}, searchNotes: async () => { reads++; return [{ noteId: 'physics-note', noteType: 'knowledge', title: 'Velocity', snippet: 'Velocity is displacement per time.', score: 1 }]; } } });
assert.equal(reads, 1, 'response repair does not execute retrieval again');
assert.equal(replies, 2); assert.equal(responseRequests[1].maxTokensOverride, 16384);
assert.equal(recovered.content, 'Complete response');
assert.equal(recovered.workingMemory?.focus, 'recovered-memory');
assert.equal(state.workingMemory, undefined, 'service-level repair never commits an unfinished turn');
let truncatedReplies = 0;
await assert.rejects(generateGeneralTurn(spec, state, { dependencies: { callLlm: async request => {
  if (request.workflow === 'scene-turn-plan') return { content: semantic };
  truncatedReplies++; return { content: '{"content":"Valid JSON but truncated generation"}', diagnostics: { finishReason: 'length' } };
} } }), /截断/);
assert.equal(truncatedReplies, 2);
let responseTransportAttempts = 0;
await assert.rejects(generateGeneralTurn(spec, state, { dependencies: { callLlm: async request => {
  if (request.workflow === 'scene-turn-plan') return { content: semantic };
  responseTransportAttempts++; throw new Error('HTTP 400: synthetic transport failure');
} } }), /HTTP 400/);
assert.equal(responseTransportAttempts, 1);

const experimentSpec = applySceneAssemblyPlan(parseSceneSpec(JSON.stringify({
  meta: { name: 'Experiment recovery', subject: 'Prompts', goal: 'Run the submitted prompt' }, task: 'Run and explain actual trials',
  behavior: { recipeId: 'agent-designed', kind: 'dialogue', aiBehavior: 'Explain actual trials', userAction: 'Submit a prompt',
    evaluationRule: 'Output rubric only', progressionRule: 'Follow the user',
    interaction: { version: '1.0', allowedTypes: ['text'], defaultType: 'text', allowTextFallback: true } },
  experimentPolicy: { criteria: ['Return only RECOVERY_OK'], maxExperiments: 2, maxOutputTokens: 256, temperature: .2 },
})), { subject: 'Prompts', knowledgePoints: [], sceneSkill: 'S1', recipeId: 'agent-designed', requestedCapabilities: ['text'],
  requestedPromptModules: ['turn-agent-planning', 'model-experiment'] });
const prompt = 'Return exactly RECOVERY_OK and nothing else.';
const experimentRun = newRun(experimentSpec, prompt); experimentRun.runId = 'recovery-experiment'; experimentRun.experimentApproved = true;
const experimentArgs = { promptSourceMessageId: 'recovery-user', promptQuote: prompt, outputFormat: 'text' as const };
let targetCalls = 0, judgeCalls = 0, experimentPlans = 0, experimentReplies = 0;
const experimentInvoke = async (request: LlmCallRequest): Promise<LlmCallResponse> => {
  if (request.workflow === 'scene-model-experiment') { targetCalls++; return { content: 'RECOVERY_OK' }; }
  judgeCalls++; return { content: JSON.stringify({ checks: [{ index: 0, verdict: 'met', evidence: 'RECOVERY_OK', suggestion: '' }] }) };
};
await generateGeneralTurn(experimentSpec, experimentRun, { dependencies: { experimentCallLlm: experimentInvoke, callLlm: async request => {
  if (request.workflow === 'scene-turn-plan') {
    const input = JSON.parse(request.userInput);
    if (input.phase === 'understand') return { content: JSON.stringify({ action: 'respond', understanding: understandingFixture('recovery-user', prompt, {
      informationGaps: [{ id: 'execute', kind: 'execution-result', description: 'Need the actual requested test output' }],
    }) }) };
    experimentPlans++;
    return { content: JSON.stringify({ action: 'respond', toolRequests: experimentPlans === 1
      ? [{ id: 'model-experiment', query: 'Run the submitted prompt', needId: 'execute', reason: 'Obtain the actual output', experiment: experimentArgs }] : [] }) };
  }
  experimentReplies++;
  return { content: '{"content":"Actual executor output has been retained."}', diagnostics: { finishReason: experimentReplies === 1 ? 'length' : 'stop' } };
} } });
assert.equal(targetCalls, 1); assert.equal(judgeCalls, 1); assert.equal(experimentReplies, 2);
assert.equal(sceneExperimentRecords(experimentRun).length, 1, 'response repair does not rerun a paid experiment');
assert.equal(sceneExperimentRecords(experimentRun)[0].status, 'complete');
closeSceneExperimentSession(experimentRun);
const judgeRun = newRun(experimentSpec, prompt); judgeRun.runId = 'recovery-truncated-judge'; judgeRun.experimentApproved = true;
let judgeRunCalls = 0;
const failedJudge = await executeSceneExperiment(experimentSpec, judgeRun, experimentArgs, { invoke: async request => {
  judgeRunCalls++;
  return request.workflow === 'scene-model-experiment' ? { content: 'RECOVERY_OK' }
    : { content: JSON.stringify({ checks: [{ index: 0, verdict: 'met', evidence: 'RECOVERY_OK', suggestion: '' }] }), diagnostics: { finishReason: 'MAX_TOKENS' } };
} });
assert.equal(failedJudge.status, 'failed'); assert.equal(judgeRunCalls, 2, 'a truncated judge is recorded, never automatically charged for another attempt');
assert.equal(failedJudge.output, 'RECOVERY_OK');
closeSceneExperimentSession(judgeRun);

const oversizedRun = newRun(spec, 'x'.repeat(1000000) + '\nDo not remove this final correction.');
const budgetTrialSpec = { ...experimentSpec, experimentPolicy: { ...experimentSpec.experimentPolicy!, maxExperiments: 1 } };
const longPrompt = 'p'.repeat(9000);
const budgetTrialRun = newRun(budgetTrialSpec, longPrompt); budgetTrialRun.runId = 'trial-local-budget'; budgetTrialRun.experimentApproved = true;
let budgetTrialCalls = 0;
await assert.rejects(executeSceneExperiment(budgetTrialSpec, budgetTrialRun, { ...experimentArgs, promptQuote: longPrompt }, {
  contextWindowTokens: 8192, invoke: async () => { budgetTrialCalls++; assert.fail('local budget rejection cannot dispatch'); },
}), error => error instanceof Error && error.name === 'SceneContextBudgetError');
assert.equal(budgetTrialCalls, 0); assert.equal(sceneExperimentRecords(budgetTrialRun).length, 0, 'preflight does not consume a paid trial slot');
budgetTrialRun.messages.push({ id: 'budget-short', speakerType: 'user', speakerName: 'User', content: prompt, timestamp: '' });
const afterLocalFailure = await executeSceneExperiment(budgetTrialSpec, budgetTrialRun, { ...experimentArgs, promptSourceMessageId: 'budget-short' }, {
  contextWindowTokens: 8192, invoke: async request => { budgetTrialCalls++; return experimentInvoke(request); },
});
assert.equal(afterLocalFailure.status, 'complete'); assert.equal(budgetTrialCalls, 2);
closeSceneExperimentSession(budgetTrialRun);
let oversizedModelCalls = 0, oversizedToolCalls = 0;
await assert.rejects(prepareSceneTurnAgentContext(spec, oversizedRun, { callLlm: async () => {
  oversizedModelCalls++; assert.fail('oversized protected user input must stop before the model');
}, searchNotes: async () => { oversizedToolCalls++; return []; } }),
error => error instanceof Error && error.name === 'SceneContextBudgetError');
assert.equal(oversizedModelCalls, 0); assert.equal(oversizedToolCalls, 0);
console.log('Scene turn recovery passed: bounded semantic/response repair, complete JSON truncation, intact latest corrections, no transport retry, no repeated retrieval or paid experiment, preserved output and typed budget stop. Synthetic offline tests only.');
