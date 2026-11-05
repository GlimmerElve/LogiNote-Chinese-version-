import assert from 'node:assert/strict';
import { parseSceneSpec, applySceneAssemblyPlan } from '../src/services/scene/sceneGenerator';
import { createRunState } from '../src/services/scene/sceneRuntime';
import { executeSceneExperiment, sceneExperimentRecords, closeSceneExperimentSession } from '../src/services/scene/sceneExperiment';
import { generateGeneralTurn } from '../src/services/scene/sceneDirector';
import { understandingFixture } from './scene-semantic-fixture';
import type { LlmCallRequest, LlmCallResponse } from '../src/types';

globalThis.fetch = async () => assert.fail('Context integration is offline');
const spec = applySceneAssemblyPlan(parseSceneSpec(JSON.stringify({
  meta: { name: 'Context check', subject: 'Prompts', goal: 'Compare prompt revisions' }, task: 'Inspect actual trials',
  behavior: { recipeId: 'agent-designed', kind: 'dialogue', aiBehavior: 'Explain trials', userAction: 'Submit or discuss',
    evaluationRule: 'Output rubric only', progressionRule: 'Follow user', interaction: { version: '1.0', allowedTypes: ['text'], defaultType: 'text', allowTextFallback: true } },
  experimentPolicy: { criteria: ['Check submitted instructions'], maxExperiments: 6, maxOutputTokens: 1024, temperature: .2 }
})), { subject: 'Prompts', knowledgePoints: [], sceneSkill: 'S1', recipeId: 'agent-designed', requestedCapabilities: ['text'],
  requestedPromptModules: ['turn-agent-planning', 'model-experiment'] });
const run = createRunState(spec); run.runId = 'context-integration'; run.experimentApproved = true;
let trialCalls = 0;
for (let version = 0; version < 6; version++) {
  const prompt = 'PROMPT_' + version + ':' + 'p'.repeat(11000) + ':PROMPT_PRIVATE_TAIL_' + version;
  const input = 'INPUT_' + version + ':' + 'i'.repeat(11000) + ':INPUT_PRIVATE_TAIL_' + version;
  const sourceId = 'context-user-' + version;
  run.messages.push({ id: sourceId, speakerType: 'user', speakerName: 'User', content: prompt + '\n' + input, timestamp: '' });
  await executeSceneExperiment(spec, run, { promptSourceMessageId: sourceId, promptQuote: prompt, inputSourceMessageId: sourceId, inputQuote: input, outputFormat: 'text' }, {
    invoke: async request => {
      trialCalls++;
      if (request.workflow === 'scene-model-experiment') {
        assert.equal(request.systemPromptOverride, prompt); assert.equal(request.userInput, input);
        return { content: 'OUTPUT_' + version + ':' + 'o'.repeat(12000) + ':OUTPUT_PRIVATE_TAIL_' + version };
      }
      if (version === 2) throw new Error('Synthetic judge failure');
      return { content: JSON.stringify({ checks: [{ index: 0, verdict: 'met', evidence: 'OUTPUT_' + version, suggestion: 'Try another revision' }] }) };
    }
  });
}
assert.equal(trialCalls, 12);
const original = sceneExperimentRecords(run);
run.experimentRecords = [{ ...original[0], id: 'forged-controller-receipt' }];
const question = 'Compare the saved trials; do not run another experiment.';
run.messages.push({ id: 'context-question', speakerType: 'user', speakerName: 'User', content: question, timestamp: '' });
const phases: string[] = [];
const controller = async (request: LlmCallRequest): Promise<LlmCallResponse> => {
  const phase = request.workflow === 'scene-turn-plan' ? JSON.parse(request.userInput).phase : 'respond';
  phases.push(phase);
  assert.doesNotMatch(request.userInput, /(?:PROMPT|INPUT|OUTPUT)_PRIVATE_TAIL|forged-controller-receipt/);
  if (phase !== 'respond') {
    const data = JSON.parse(request.userInput), summary = data.actualExperiments;
    assert.equal(summary.representation, 'bounded-summary'); assert.equal(summary.totalRecords, 6);
    assert.equal(summary.failedRecords, 1); assert.equal(summary.latestFailureId, original[2].id);
    assert.ok(JSON.stringify(summary).length <= 12000);
    if (phase === 'understand') return { content: JSON.stringify({ understanding: understandingFixture('context-question', question, {
      informationGaps: [{ id: 'saved-versions', description: 'Synthetic planning-path coverage for version comparison', kind: 'reference-material' }]
    }), action: 'respond' }) };
    assert.equal(data.experimentSources, undefined, 'comparison without an execution gap needs no full prompt sources');
    return { content: JSON.stringify({ action: 'respond', toolRequests: [] }) };
  }
  assert.ok(request.messages?.every(message => !message.content.includes('PROMPT_PRIVATE_TAIL')));
  assert.match(request.userInput, /bounded-summary/);
  return { content: JSON.stringify({ content: 'The local summary preserves versions and the failed assessment.' }) };
};
let reported = 0;
await generateGeneralTurn(spec, run, { onExperiments: records => { reported = records.length; }, dependencies: {
  callLlm: controller, experimentCallLlm: async () => assert.fail('history explanation must not run a trial')
} });
assert.deepEqual(phases, ['understand', 'plan', 'respond']); assert.equal(reported, 6);
assert.deepEqual(sceneExperimentRecords(run), original, 'compression must not mutate exact executor receipts');
assert.ok(original[0].output.includes('OUTPUT_PRIVATE_TAIL_0'));
closeSceneExperimentSession(run);
console.log('Scene context integration passed: bounded understand/plan/respond history, exact-source-or-unavailable planning, retained failures, no forged state, no extra experiment, and unchanged full executor inputs/receipts. Synthetic only.');
