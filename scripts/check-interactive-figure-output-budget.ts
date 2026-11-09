/** Actual figure entry/storage; only model and IPC IO are synthetic. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import { InteractiveFigureStore } from '../src/electron/interactiveFigureStore';
import { interactiveFigureKey, prepareInteractiveFigure } from '../src/services/textbook/interactiveFigure';
import { hashTextbookProviders } from '../src/services/textbook/providerIdentity';
import { defaultTextbookModelPolicy } from '../src/services/textbook/modelPolicy';
import { saveLlmSettings } from '../src/services/llmStorage';
import { callLLM } from '../src/services/llmService';
import { INTERACTIVE_TEACHING_MODE_FIXTURES } from './fixtures/interactive-teaching-modes';
import type { LlmProvider, LlmSettings, LlmCallRequest } from '../src/types';

Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
globalThis.fetch = async () => assert.fail('Figure budget regression must not use network or a model');
await fs.mkdir('build', { recursive: true });
const root = await fs.mkdtemp(path.resolve('build/interactive-figure-output-budget-'));
const store = new InteractiveFigureStore(root);
let preflights = 0, calls = 0;
const api = {
  read: (key: string) => store.read(key),
  write: (key: string, artifact: Parameters<InteractiveFigureStore['write']>[1]) => store.write(key, artifact),
  preflight: async (html: string) => { preflights++; assert.ok(!html.includes('MODEL_INCOMPLETE_SCRIPT')); },
  open: async () => ({ processId: 1 }), bounds: async () => {}, visible: async () => {}, close: async () => {}, onFailure: () => () => {},
};
const provider: LlmProvider = { id: 'synthetic-glm-budget', name: 'Synthetic GLM', apiType: 'openai-compatible',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: '', models: ['glm-5.3'], selectedModel: 'glm-5.3', enabled: true, createdAt: '' };
let settings: LlmSettings = { providers: [provider], defaultProviderId: provider.id, workflowBinding: {} };
const modelPolicy = defaultTextbookModelPolicy();
const providerHash = await hashTextbookProviders({ 'textbook-blueprint': provider, 'textbook-chapter': provider, 'textbook-quality': provider }, modelPolicy);
const memory = new Map([['loginote_llm_settings', JSON.stringify(settings)]]);
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key),
} });
Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: {
  userState: { loadLlm: async () => structuredClone(settings), saveLlm: async (value: LlmSettings) => { settings = structuredClone(value); } },
  textbook: { figureApproval: async (input: any) => { assert.equal(input.jobId, 'synthetic-old-job'); assert.match(input.bodyDigest, /^[a-f0-9]{64}$/u); return { allowCloud: true, providerHash, modelPolicy: structuredClone(modelPolicy) }; } },
} } });
const brief = '改变 x，观察平方函数 y=x² 的函数值';
const body = `# 合成教材\n\n已知平方函数 y=x²。${brief}。教材正文不可修改。`;
const design = { kind: 'quantitative', anchor: brief, goal: '观察平方函数的输入和输出', action: '改变 x', observation: '观察 y', model: 'y=x²', prediction: '当 x=2 时输出多少？', caveat: '合成教学材料', transfer: '比较相反数的函数值' };
const plot = { title: '平方函数', variable: 'x', xLabel: 'x', yLabel: 'y', xDomain: [-3, 3], yDomain: [-1, 10], curves: [{ id: 'f', label: 'y=x²', expression: 'x^2' }] };
const response = () => ({ content: JSON.stringify({ design, plot }), diagnostics: { finishReason: 'stop' } });
const assertRequest = (request: LlmCallRequest, tokens: number) => {
  calls++; assert.equal(request.maxTokensOverride, tokens); assert.equal(request.thinkingMode, 'disabled');
  assert.equal(request.tokenBudgetMode, 'total', 'figure budgets already include reasoning and must not expand twice');
  assert.ok(request.skipMemoryInjection && request.skipProfileInjection); assert.ok(!request.systemPromptOverride?.includes('12288'), 'budget must not inflate prompts');
};
const checks: string[] = [];
try {
  const key = await interactiveFigureKey('new-function', body, brief);
  const local = await prepareInteractiveFigure(key, body, brief, false, { api, provider, generate: async request => { assertRequest(request, 8192); return response(); } });
  assert.ok(local.includes('data-local-function="true"'));
  const saved = await store.read(key); assert.equal(saved?.status, 'ready');
  const callsBeforeReopen = calls;
  assert.equal(await prepareInteractiveFigure(key, body, brief, false, { api, generate: async () => assert.fail('Ready reopen must not generate') }), local);
  assert.equal(calls, callsBeforeReopen);
  checks.push('new local configuration uses 8192; ready attachment reopens without generation');

  const fixture = INTERACTIVE_TEACHING_MODE_FIXTURES.find(item => item.mode === 'step')!;
  const htmlBody = `${fixture.lesson}\n\n${fixture.brief}`;
  const htmlKey = await interactiveFigureKey('new-html', htmlBody, fixture.brief);
  const html = await prepareInteractiveFigure(htmlKey, htmlBody, fixture.brief, false, { api, provider, generate: async request => {
    assertRequest(request, 12288); return { content: JSON.stringify({ design: fixture.design, html: fixture.html }) };
  } }, { projectId: 'new-html', legacy: false, teachingPolicy: 1 });
  assert.equal(html, fixture.html); assert.equal((await store.read(htmlKey))?.status, 'ready');
  checks.push('new model-authored HTML uses 12288 and passes existing structure/preflight checks');

  const oldKey = await interactiveFigureKey('legacy-function', body, brief);
  const legacyScope = { projectId: 'legacy-function', legacy: true, jobId: 'synthetic-old-job' };
  const old = await prepareInteractiveFigure(oldKey, body, brief, false, { api, generate: async (request, options) => {
    assertRequest(request, 4096); assert.equal(options?.providerSnapshot?.id, provider.id); return response();
  } }, legacyScope);
  const oldArtifact = await store.read(oldKey); assert.equal(oldArtifact?.status, 'ready');
  const frozenHash = providerHash;
  await assert.rejects(prepareInteractiveFigure(oldKey, body, brief, true, { api, generate: async request => {
    assertRequest(request, 8192); return { content: '{"design":', diagnostics: { finishReason: 'length' } };
  } }, legacyScope), /截断.*8192/u);
  const failedOld = await store.read(oldKey); assert.equal(failedOld?.status, 'failed');
  assert.ok(failedOld?.status === 'failed' && failedOld.previousHtml === old);
  assert.ok(failedOld?.status === 'failed' && failedOld.error.includes('8192') && failedOld.error.includes('截断'));
  assert.equal(frozenHash, await hashTextbookProviders({ 'textbook-blueprint': provider, 'textbook-chapter': provider, 'textbook-quality': provider }, modelPolicy));
  checks.push('legacy automatic generation keeps 4096 and pinned approval; explicit retry gets new cap and preserves previous ready figure on failure');

  const blockedCalls = calls;
  await assert.rejects(prepareInteractiveFigure(oldKey, body, brief, false, { api, generate: async () => assert.fail('Failed open must not automatically retry') }, legacyScope), /截断.*8192/u);
  assert.equal(calls, blockedCalls);
  const retried = await prepareInteractiveFigure(oldKey, body, brief, true, { api, generate: async request => { assertRequest(request, 8192); return response(); } }, legacyScope);
  assert.ok(retried.includes('data-local-function="true"')); assert.equal((await store.read(oldKey))?.status, 'ready');
  checks.push('failed reopen preserves specific error and performs no automatic call; manual retry restores the same attachment');

  const truncatedKey = await interactiveFigureKey('truncated-html', htmlBody, fixture.brief);
  const preflightBefore = preflights, callsBefore = calls;
  await assert.rejects(prepareInteractiveFigure(truncatedKey, htmlBody, fixture.brief, false, { api, provider, generate: async request => {
    assertRequest(request, 12288); return { content: JSON.stringify({ design: fixture.design, html: fixture.html + '<script>MODEL_INCOMPLETE_SCRIPT' }), diagnostics: { finishReason: 'max_tokens' } };
  } }, { projectId: 'truncated-html', legacy: false, teachingPolicy: 1 }), /截断.*12288/u);
  assert.equal(calls, callsBefore + 1); assert.equal(preflights, preflightBefore, 'truncated scripts must not reach preflight/execution');
  const failedHtml = await store.read(truncatedKey); assert.equal(failedHtml?.status, 'failed');
  assert.ok(failedHtml?.status === 'failed' && failedHtml.error.includes('截断') && failedHtml.error.includes('12288'));
  assert.ok(failedHtml?.status === 'failed' && !failedHtml.draftHtml?.includes('MODEL_INCOMPLETE_SCRIPT'));
  checks.push('length/max_tokens reject incomplete HTML before execution, preserve safe diagnosis and never auto-retry');

  const jsonKey = await interactiveFigureKey('incomplete-json', body, brief);
  await assert.rejects(prepareInteractiveFigure(jsonKey, body, brief, false, { api, provider, generate: async request => {
    assertRequest(request, 8192); return { content: '{"design":', diagnostics: { finishReason: 'stop' } };
  } }), /JSON格式不完整/u);
  const failedJson = await store.read(jsonKey); assert.ok(failedJson?.status === 'failed' && failedJson.error.includes('JSON格式不完整'));
  assert.equal(body, `# 合成教材\n\n已知平方函数 y=x²。${brief}。教材正文不可修改。`);
  checks.push('malformed JSON remains rejected with a persisted specific safe error; source textbook and approval fingerprints unchanged');
  const pendingKey = await interactiveFigureKey('old-pending', body, brief);
  await store.write(pendingKey, { status: 'pending' });
  const pendingCalls = calls;
  await assert.rejects(prepareInteractiveFigure(pendingKey, body, brief, false, { api, generate: async () => assert.fail('Pending open must not restart') }), /上次交互图任务未完成/u);
  assert.equal(calls, pendingCalls);
  await prepareInteractiveFigure(pendingKey, body, brief, true, { api, provider, generate: async request => { assertRequest(request, 8192); return response(); } });
  checks.push('old pending task stays inert until explicit retry; retry alone enables the GLM-specific cap');
  for (const alternative of [
    { ...provider, id: 'synthetic-deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', selectedModel: 'deepseek-chat', models: ['deepseek-chat'] },
    { ...provider, id: 'synthetic-gateway', baseUrl: 'https://gateway.synthetic.invalid/v1' },
    { ...provider, id: 'synthetic-other-glm', selectedModel: 'glm-5.2', models: ['glm-5.2'] },
  ]) {
    await saveLlmSettings({ providers: [alternative], defaultProviderId: alternative.id, workflowBinding: {} });
    const alternativeKey = await interactiveFigureKey(alternative.id, body, brief);
    await prepareInteractiveFigure(alternativeKey, body, brief, false, { api, provider: alternative, generate: async request => { assertRequest(request, 4096); return response(); } });
    const alternativeHtmlKey = await interactiveFigureKey(alternative.id, htmlBody, fixture.brief);
    await prepareInteractiveFigure(alternativeHtmlKey, htmlBody, fixture.brief, false, { api, provider: alternative, generate: async request => {
      assertRequest(request, 4096); return { content: JSON.stringify({ design: fixture.design, html: fixture.html }) };
    } }, { projectId: alternative.id, legacy: false, teachingPolicy: 1 });
  }
  checks.push('DeepSeek, unknown GLM version and third-party gateway retain 4096 for both configuration and HTML through actual provider routing');
  await saveLlmSettings({ providers: [provider], defaultProviderId: provider.id, workflowBinding: {} });
  let actualIpcCalls = 0, expectedIpcTokens = 8192;
  (window.electronAPI as any).llm = { request: async (request: any) => {
    actualIpcCalls++; assert.equal(request.provider.id, provider.id); assert.equal(request.maxTokens, expectedIpcTokens);
    assert.equal(request.thinkingMode, 'enabled'); assert.equal(request.reasoningEffort, 'low');
    return expectedIpcTokens === 8192 ? response() : { content: JSON.stringify({ design: fixture.design, html: fixture.html }) };
  } };
  const actualFunctionKey = await interactiveFigureKey('actual-provider-function', body, brief);
  await prepareInteractiveFigure(actualFunctionKey, body, brief, false, { api, generate: callLLM });
  assert.equal((await store.read(actualFunctionKey))?.status, 'ready');
  expectedIpcTokens = 12288;
  const actualHtmlKey = await interactiveFigureKey('actual-provider-html', htmlBody, fixture.brief);
  await prepareInteractiveFigure(actualHtmlKey, htmlBody, fixture.brief, false, { api, generate: callLLM }, { projectId: 'actual-provider-html', legacy: false, teachingPolicy: 1 });
  assert.equal((await store.read(actualHtmlKey))?.status, 'ready'); assert.equal(actualIpcCalls, 2);
  checks.push('production callLLM and actual saved-provider routing send 8192/12288 once to IPC with GLM enabled+low; synthetic boundary only');
  const report = { passed: true, root, checks, modelCalls: calls, preflights, actualNetworkCalls: 0, realModelRequests: 0, realSettingsAccessed: false };
  await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window');
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage); else Reflect.deleteProperty(globalThis, 'localStorage');
}
