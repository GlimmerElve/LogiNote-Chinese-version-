import assert from 'node:assert/strict';
import type { LlmCallRequest, LlmCallResponse, LlmProvider, SceneRunState, SceneSpec } from '../src/types';
import { resolveLlmOutputBudget } from '../src/services/llmOutputBudget';
import { runPlanGeneration, type PlanGenerationRetryState } from '../src/services/planGenerationRunner';
import { safeLlmHttpError } from '../src/services/llmHttpFailure';
import { runSceneSetupStage, type SceneSetupRetryState } from '../src/services/scene/sceneSetupStage';
import { S2ModelTestSession } from '../src/services/scene/sceneS2ModelTest';
import { executeSceneExperiment, sceneExperimentRecords, closeSceneExperimentSession } from '../src/services/scene/sceneExperiment';
import { createFrozenReferenceShadowModel } from '../src/services/reviewComparison/frozenReferenceModel';
import { createFrozenAtomicReferenceShadowModel } from '../src/services/reviewComparison/frozenAtomicReference';
import { createFrozenPropositionReferenceModel } from '../src/services/reviewComparison/frozenPropositionReference';

globalThis.fetch = async () => assert.fail('Fixed token-budget checks never call network or a model');
const provider: Pick<LlmProvider, 'apiType' | 'baseUrl'> = { apiType: 'openai-compatible', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' };
const sent = (request: LlmCallRequest) => resolveLlmOutputBudget(provider, 'glm-5.3', request.maxTokensOverride!, request.tokenBudgetMode);
const completePlan = (): LlmCallResponse => ({ content: JSON.stringify({ isComplete: true, rootTitle: '合成目标', planTree: [{ key: 'core', title: '核心能力', children: [] }] }), diagnostics: { finishReason: 'stop' } });
const plan: LlmCallRequest = { providerId: '', model: '', workflow: 'plan-generation', userInput: '合成目标' };
const observations: string[] = [];

const planRequests: LlmCallRequest[] = [], planCaps: number[] = [];
await runPlanGeneration({ request: plan, invoke: async request => {
  planRequests.push(request); planCaps.push(sent(request));
  if (planRequests.length === 1) throw safeLlmHttpError(400, 'max_tokens invalid');
  return completePlan();
} });
assert.deepEqual(planCaps, [20480, 8192]);
assert.equal(planRequests[0].tokenBudgetMode, 'response'); assert.equal(planRequests[1].tokenBudgetMode, 'total');
for (const resume of [{ maxTokens: 16384, compact: true }, { maxTokens: 8192, compact: false, ceiling: 8192 }]) {
  await runPlanGeneration({ request: plan, resume, invoke: async request => { assert.equal(request.tokenBudgetMode, 'total'); assert.equal(sent(request), resume.maxTokens); return completePlan(); } });
}
observations.push('GLM fresh plan gains headroom; compatibility 8192 and restored 8192/16384 caps remain exact');
let newPlanState: PlanGenerationRetryState | undefined, newPlanCap = 0;
await assert.rejects(runPlanGeneration({ request: plan, onState: state => { newPlanState = state; }, invoke: async request => {
  newPlanCap = sent(request); throw Error('Synthetic interruption');
} }), /Synthetic interruption/);
assert.equal(newPlanState?.tokenBudgetMode, 'response');
await runPlanGeneration({ request: plan, resume: structuredClone(newPlanState!), invoke: async request => {
  assert.equal(request.tokenBudgetMode, 'response'); assert.equal(sent(request), newPlanCap); return completePlan();
} });
observations.push('New GLM plan cursor round-trips its response policy without shrinking the sent allowance');

const setup: LlmCallRequest = { providerId: '', model: '', workflow: 'agent-scene-setup', maxTokensOverride: 4096, userInput: '{}' };
const setupRequests: LlmCallRequest[] = [];
await runSceneSetupStage({ stage: 'understand', request: setup, maxOutputChars: 1000, validate: raw => raw, invoke: async request => {
  setupRequests.push(request); return setupRequests.length === 1 ? { content: '{}', diagnostics: { finishReason: 'length' } } : { content: '{}' };
} });
assert.equal(setupRequests[0].tokenBudgetMode, 'response'); assert.equal(sent(setupRequests[0]), 8192);
assert.equal(setupRequests[1].tokenBudgetMode, 'response'); assert.equal(sent(setupRequests[1]), 16384);
await runSceneSetupStage({ stage: 'understand', request: setup, maxOutputChars: 1000, validate: raw => raw,
  resume: { version: 1, attempt: 1, calls: 0, maxTokens: 4096 }, invoke: async request => { assert.equal(request.tokenBudgetMode, 'total'); assert.equal(sent(request), 4096); return { content: '{}' }; } });
observations.push('Scene setup restored and repair-fallback requests preserve their exact stored cap');
let newSceneState: SceneSetupRetryState | undefined, newSceneCap = 0;
await assert.rejects(runSceneSetupStage({ stage: 'understand', request: setup, maxOutputChars: 1000, validate: raw => raw,
  onRetryState: state => { newSceneState = state; }, invoke: async request => { newSceneCap = sent(request); throw Error('Synthetic interruption'); } }), /未成功/);
assert.equal(newSceneState?.tokenBudgetMode, 'response');
await runSceneSetupStage({ stage: 'understand', request: setup, maxOutputChars: 1000, validate: raw => raw,
  resume: structuredClone(newSceneState!), invoke: async request => { assert.equal(request.tokenBudgetMode, 'response'); assert.equal(sent(request), newSceneCap); return { content: '{}' }; } });
await runSceneSetupStage({ stage: 'understand', request: setup, maxOutputChars: 1000, validate: raw => raw,
  resume: { version: 1, attempt: 2, calls: 1, maxTokens: 8192, repairBaseOutputTokens: 4096 }, invoke: async request => {
    assert.equal(request.tokenBudgetMode, 'total'); assert.equal(sent(request), 8192); return { content: '{}' };
  } });
observations.push('New GLM scene cursor round-trips its response policy; unmarked legacy repair remains exact');

let sessionCalls = 0;
const session = new S2ModelTestSession({ sceneId: 'BudgetScene', runId: 'BudgetRun', resourceId: 'BudgetResource', providerId: 'glm', providerLabel: '合成GLM', model: 'glm-5.3',
  limits: { maxRequests: 1, maxOutputTokens: 512, maxReservedOutputTokens: 512 }, invoke: async request => {
    sessionCalls++; assert.equal(request.tokenBudgetMode, 'total'); assert.equal(request.thinkingPreference, 'default'); assert.equal(sent(request), 512); return { content: '合成输出', diagnostics: { finishReason: 'stop' } };
  } });
const before = session.preview('合成提示', '合成输入'); assert.equal(before.maxOutputTokens, 512);
const outcome = await session.execute({ protocolVersion: 1, id: 'BudgetInvocation', sceneId: 'BudgetScene', runId: 'BudgetRun', revision: 1, nodeId: 'generate',
  pluginId: 'model-test', pluginVersion: '1.0.0', capabilityId: 'generate', idempotencyKey: 'BudgetKey', inputs: { prompt: ['Prompt'], input: ['Input'] } },
{ prompt: ['合成提示'], input: ['合成输入'] }, new AbortController().signal);
assert.equal(outcome.status, 'succeeded'); assert.equal(sessionCalls, 1);
assert.equal(session.summary().reservedOutputTokens, 512); assert.equal(session.summary().records[0].parameters.maxOutputTokens, 512);
session.close(); observations.push('Paid S2 preview, sent GLM allowance and persistent reservation remain 512');

const spec = { sceneId: 'BudgetExperiment', meta: { sceneSkill: 'S1' }, promptModuleIds: ['model-experiment'], runtimeContract: { allowedTools: ['model-experiment'] }, experimentPolicy: { criteria: ['原文保留'], maxExperiments: 1, maxOutputTokens: 1024, temperature: .2 } } as unknown as SceneSpec;
const run = { sceneId: spec.sceneId, runId: 'BudgetExperimentRun', sceneName: '合成实验', experimentApproved: true, metrics: [], messages: [{ id: 'UserPrompt', speakerType: 'user', speakerName: '合成用户', content: '合成提示', timestamp: '2026-11-09' }], turnCount: 0, events: [], status: 'running', startedAt: '2026-11-09' } as SceneRunState;
const experimentalCaps: number[] = [];
try {
  const result = await executeSceneExperiment(spec, run, { promptSourceMessageId: 'UserPrompt', promptQuote: '合成提示', outputFormat: 'text' }, { invoke: async request => {
    assert.equal(request.tokenBudgetMode, 'total'); assert.equal(request.thinkingPreference, 'default'); experimentalCaps.push(sent(request));
    return request.workflow === 'scene-model-experiment' ? { content: '合成输出', diagnostics: { finishReason: 'stop' } }
      : { content: JSON.stringify({ checks: [{ index: 0, verdict: 'met', evidence: '合成输出', suggestion: '' }] }) };
  } });
  assert.equal(result.status, 'complete'); assert.deepEqual(experimentalCaps, [1024, 2048]);
  assert.equal(sceneExperimentRecords(run)[0].maxOutputTokens, 1024);
} finally { closeSceneExperimentSession(run); }
observations.push('Paid scene target/judge caps and recorded allowance remain 1024/2048');

const frozen = async (request: LlmCallRequest) => { assert.equal(request.tokenBudgetMode, 'total'); assert.equal(request.thinkingPreference, 'default'); assert.equal(sent(request), request.maxTokensOverride); return { content: '{}' }; };
await createFrozenReferenceShadowModel(frozen).extract({} as any);
await createFrozenAtomicReferenceShadowModel(frozen).extract({} as any);
await createFrozenPropositionReferenceModel(frozen).extract({} as any);
observations.push('Frozen reference experiment extraction requests remain exact across the three adapters');
console.log(JSON.stringify({ status: 'passed', checks: observations, realModelRequests: 0, networkRequests: 0, realSettingsAccessed: false }));
