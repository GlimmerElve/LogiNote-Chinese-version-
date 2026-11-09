/** Actual figure entry + saved approvals. Model and desktop IO are synthetic. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import { InteractiveFigureStore } from '../src/electron/interactiveFigureStore';
import { interactiveFigureKey, prepareInteractiveFigure, type FigureAuthorization } from '../src/services/textbook/interactiveFigure';
import { resolveInteractiveFigureBudget } from '../src/services/textbook/interactiveFigureBudget';
import { captureTextbookThinkingSnapshot } from '../src/services/textbook/thinkingSnapshot';
import { hashTextbookProviders } from '../src/services/textbook/providerIdentity';
import { defaultTextbookModelPolicy } from '../src/services/textbook/modelPolicy';
import { saveLlmSettings } from '../src/services/llmStorage';
import { INTERACTIVE_TEACHING_MODE_FIXTURES } from './fixtures/interactive-teaching-modes';
import type { LlmProvider, LlmSettings, LlmThinkingPreference, LlmCallRequest } from '../src/types';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
const originalFetch = globalThis.fetch;
Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
globalThis.fetch = async () => assert.fail('This regression must never use network or a real model');
await fs.mkdir('build', { recursive: true });
const root = await fs.mkdtemp(path.resolve('build/thinking-figure-budgets-'));
const store = new InteractiveFigureStore(root);
const glm: LlmProvider = { id: 'synthetic-figure-glm', name: 'Synthetic GLM', apiType: 'openai-compatible',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: '', models: ['glm-5.3'], selectedModel: 'glm-5.3', enabled: true, createdAt: 'synthetic' };
const deepseek: LlmProvider = { ...glm, id: 'synthetic-figure-deepseek', name: 'Synthetic DeepSeek',
  baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-flash'], selectedModel: 'deepseek-flash' };
let settings: LlmSettings = { providers: [glm], defaultProviderId: glm.id, workflowBinding: {} };
const memory = new Map([['loginote_llm_settings', JSON.stringify(settings)]]);
const policy = defaultTextbookModelPolicy();
const providers = { 'textbook-blueprint': glm, 'textbook-chapter': glm, 'textbook-quality': glm };
const approvals = new Map<string, { allowCloud: boolean; providerHash: string; modelPolicy: typeof policy;
  thinkingSnapshot?: ReturnType<typeof captureTextbookThinkingSnapshot> }>();
let preflights = 0, generated = 0;
const requests: Array<{ project: string; pref: LlmThinkingPreference; tokens: number; kind: string }> = [];
const api = {
  read: (key: string) => store.read(key),
  write: (key: string, artifact: Parameters<InteractiveFigureStore['write']>[1]) => store.write(key, artifact),
  preflight: async (html: string) => { preflights++; assert.ok(html.length > 0); },
  open: async () => ({ processId: 1 }), bounds: async () => {}, visible: async () => {}, close: async () => {}, onFailure: () => () => {},
};
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key),
} });
Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: {
  userState: { loadLlm: async () => structuredClone(settings), saveLlm: async (value: LlmSettings) => { settings = structuredClone(value); } },
  textbook: { figureApproval: async (input: any) => {
    assert.match(input.bodyDigest, /^[a-f0-9]{64}$/u);
    const approval = approvals.get(input.jobId); assert.ok(approval, 'Only this synthetic job can be approved'); return structuredClone(approval);
  } },
} } });
const brief = '改变 x，观察平方函数 y=x² 的函数值';
const body = '# 合成函数教材\n\n已知平方函数 y=x²。' + brief + '。';
const design = { kind: 'quantitative', anchor: brief, goal: '观察平方函数输入和输出', action: '改变 x', observation: '观察 y',
  model: 'y=x²', prediction: '当 x=2 时输出多少？', caveat: '合成教学材料', transfer: '比较相反数的函数值' };
const plot = { title: '平方函数', variable: 'x', xLabel: 'x', yLabel: 'y', xDomain: [-3, 3], yDomain: [-1, 10],
  curves: [{ id: 'f', label: 'y=x²', expression: 'x^2' }] };
const htmlFixture = INTERACTIVE_TEACHING_MODE_FIXTURES.find(item => item.mode === 'step')!;
const htmlBody = htmlFixture.lesson + '\n\n' + htmlFixture.brief;

async function entry(project: string, provider: LlmProvider, pref: LlmThinkingPreference, tokens: number,
  kind: 'configuration' | 'html', authorization?: FigureAuthorization) {
  const text = kind === 'html' ? htmlBody : body, goal = kind === 'html' ? htmlFixture.brief : brief;
  const key = await interactiveFigureKey(project, text, goal);
  const scope = authorization || { projectId: project, legacy: false, ...(kind === 'html' ? { teachingPolicy: 1 as const } : {}) };
  const result = await prepareInteractiveFigure(key, text, goal, false, { api, provider, thinkingPreference: pref,
    generate: async (request: LlmCallRequest, options) => {
      generated++; assert.equal(request.maxTokensOverride, tokens); assert.equal(request.thinkingPreference, pref);
      assert.equal(request.tokenBudgetMode, 'total', 'Approved/resolved figure totals must not be expanded again');
      if (scope.legacy) assert.equal(options?.providerSnapshot?.id, glm.id);
      requests.push({ project, pref, tokens, kind });
      return { content: JSON.stringify(kind === 'html' ? { design: htmlFixture.design, html: htmlFixture.html } : { design, plot }), diagnostics: { finishReason: 'stop' } };
    } }, scope);
  assert.equal((await store.read(key))?.status, 'ready');
  if (kind === 'configuration') assert.ok(result.includes('data-local-function="true"'));
  else assert.equal(result, htmlFixture.html);
  const before = generated;
  await prepareInteractiveFigure(key, text, goal, false, { api, generate: async () => assert.fail('Ready attachments must reopen without another generation') }, scope);
  assert.equal(generated, before);
}

try {
  for (const [pref, configuration, html] of [
    ['low', 8192, 12288], ['medium', 12288, 18432], ['high', 16384, 24576],
  ] as const) {
    assert.deepEqual(resolveInteractiveFigureBudget(glm, pref), { configuration, html });
    await entry('glm-' + pref + '-config', glm, pref, configuration, 'configuration');
    await entry('glm-' + pref + '-html', glm, pref, html, 'html');
  }
  for (const [pref, cap] of [['default', 4096], ['off', 4096], ['high', 16384]] as const) {
    assert.deepEqual(resolveInteractiveFigureBudget(deepseek, pref), { configuration: cap, html: cap });
    await entry('deepseek-' + pref + '-config', deepseek, pref, cap, 'configuration');
    await entry('deepseek-' + pref + '-html', deepseek, pref, cap, 'html');
  }
  const oldHash = await hashTextbookProviders(providers, policy);
  approvals.set('old-job', { allowCloud: true, providerHash: oldHash, modelPolicy: policy });
  await saveLlmSettings({ ...settings, workflowThinking: { 'textbook-chapter': 'high' } });
  await entry('legacy-no-snapshot', glm, 'default', 4096, 'configuration', { projectId: 'legacy-no-snapshot', legacy: true, jobId: 'old-job' });
  assert.equal(await hashTextbookProviders(providers, policy), oldHash);

  const captured = captureTextbookThinkingSnapshot({ ...settings, workflowThinking: { 'textbook-chapter': 'high' } }, policy, () => glm)!;
  assert.ok(captured.figureBudget, 'A manual chapter approval must contain figure limits');
  assert.deepEqual(captured.figureBudget, { configuration: 16384, html: 24576 }, 'The approval must capture the exact figure limits that will execute');
  const manualHash = await hashTextbookProviders(providers, policy, captured);
  approvals.set('high-approved-job', { allowCloud: true, providerHash: manualHash, modelPolicy: policy, thinkingSnapshot: captured });
  await saveLlmSettings({ ...settings, workflowThinking: { 'textbook-chapter': 'low' } });
  await entry('approved-config', glm, 'high', captured.figureBudget.configuration, 'configuration',
    { projectId: 'approved-config', legacy: true, jobId: 'high-approved-job' });
  await entry('approved-html', glm, 'high', captured.figureBudget.html, 'html',
    { projectId: 'approved-html', legacy: true, jobId: 'high-approved-job', teachingPolicy: 1 });
  assert.equal(settings.workflowThinking?.['textbook-chapter'], 'low', 'Execution must not rewrite the current UI selection');
  assert.equal(await hashTextbookProviders(providers, policy, captured), manualHash, 'UI changes cannot alter an approved task snapshot');
  const report = { passed: true, root, checks: ['GLM low/medium/high configuration and HTML caps execute at the resolved total',
    'DeepSeek default/off remain 4096; high expands to 16384 only when selected',
    'Old legacy tasks without figureBudget keep automatic 4096 and their original hash',
    'New approved high figure limits execute unchanged after the UI switches to low',
    'Ready attachments reopen with no additional model request'], requests, generated, preflights,
    realModelRequests: 0, networkCalls: 0, realSettingsAccessed: false };
  await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  globalThis.fetch = originalFetch;
  for (const [key, descriptor] of [['window', originalWindow], ['localStorage', originalStorage], ['crypto', originalCrypto]] as const) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
}
