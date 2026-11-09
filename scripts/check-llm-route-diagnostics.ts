/** Real route/request functions, synthetic settings and local IPC; zero network. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { selectLlmProvider, assertLlmProviderEnabled, describeLlmProviderUnavailable } from '../src/services/llmProviderSelection';
import { requireLlmModel } from '../src/services/llmModelSelection';
import { manualThinkingTimeoutMs, resolveLlmThinkingPolicy, workflowThinkingPreference } from '../src/services/llmThinkingPolicy';
import { resolveLlmOutputBudget } from '../src/services/llmOutputBudget';
import { getWorkflowById } from '../src/workflows/workflowRegistry';
import { progressiveGenerationRequest } from '../src/services/progressiveLearning/generation';
import { sanitizeUnicodeDeep } from '../src/services/unicode';
import type { LlmProvider, LlmSettings } from '../src/types';

globalThis.fetch = async () => assert.fail('Route diagnostics must not call a model or network');
const glm: LlmProvider = { id: 'synthetic-glm', name: '智谱', apiType: 'openai-compatible', baseUrl: 'https://glm.synthetic.invalid',
  apiKey: 'synthetic-glm-secret', models: ['glm-5.3'], selectedModel: 'glm-5.3', enabled: true, createdAt: '' };
const deepseek: LlmProvider = { ...glm, id: 'deepseek-default', name: 'DeepSeek', baseUrl: 'https://deepseek.synthetic.invalid/v1?private=query',
  apiKey: 'synthetic-deepseek-secret', models: ['synthetic-deepseek'], selectedModel: 'synthetic-deepseek', enabled: false };
const initial: LlmSettings = { providers: [deepseek, glm], defaultProviderId: deepseek.id, workflowBinding: {} };
let current = initial;
const sent: Array<{ kind: string; id: string; model: string }> = [];
const mockApi = { request: async (input: any) => { sent.push({ kind: 'sync', id: input.provider.id, model: input.provider.selectedModel }); return { content: '合成响应' }; },
  stream: async (input: any) => { sent.push({ kind: 'stream', id: input.provider.id, model: input.provider.selectedModel }); return 'synthetic-stream'; },
  cancel: async () => {}, onChunk: () => () => {}, onEnd: () => () => {}, onError: () => () => {} };
const bindings = { readLlmSettingsForUse: () => current, ensureLlmSettingsLoaded: async () => {}, flushLlmSettingsWrites: async () => {},
  selectLlmProvider, assertLlmProviderEnabled, describeLlmProviderUnavailable, requireLlmModel, resolveLlmThinkingPolicy, workflowThinkingPreference, manualThinkingTimeoutMs, resolveLlmOutputBudget, getWorkflowById, sanitizeUnicodeDeep,
  window: { electronAPI: { llm: mockApi } }, buildCallContext: () => '',
  assembleMemoryContext: async () => assert.fail('Progressive requests skip memory injection'),
  fitSceneContextBudget: (request: any) => ({ request }) };
async function compile(file: string, entry: string) {
  const source = await fs.readFile(file, 'utf8'), ast = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true);
  const selected = ast.statements.filter(node => ts.isFunctionDeclaration(node) && ['resolveProvider', entry].includes(node.name?.text || ''));
  assert.equal(selected.length, 2, 'Execute the actual provider resolver and request function');
  const code = selected.map(node => node.getText(ast)).join('\n').replace(/^export\s+/gmu, '') + `\nreturn ${entry};`;
  return new Function(...Object.keys(bindings), ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(bindings));
}
const callSync = await compile('src/services/llmService.ts', 'callLLM');
const callStream = await compile('src/services/llmStreamService.ts', 'callLLMStream');
const course: any = { title: '合成GLM路由教材', sourcePackets: [], pages: [], plan: null,
  generation: { pageId: 'main-1', bodyDraft: '' }, budget: { maxMainlinePages: 4, estimatedMinutes: 20 } };
const cases: Array<{ id: string; settings: LlmSettings; expected: string | null; copy?: string[] }> = [
  { id: 'disabled-default', settings: initial, expected: null, copy: ['教材·章节生成', 'DeepSeek', '已停用', '工作流绑定 → 教材生成', '不可用'] },
  { id: 'explicit-glm', settings: { ...initial, workflowBinding: { 'textbook-chapter': glm.id } }, expected: glm.id },
  { id: 'glm-default', settings: { ...initial, defaultProviderId: glm.id }, expected: glm.id },
  { id: 'disabled-binding', settings: { ...initial, defaultProviderId: glm.id, workflowBinding: { 'textbook-chapter': deepseek.id } }, expected: null,
    copy: ['教材·章节生成', '工作流绑定', 'DeepSeek', '已停用', '工作流绑定 → 教材生成', '不可用'] },
  { id: 'deleted-binding', settings: { ...initial, defaultProviderId: glm.id, workflowBinding: { 'textbook-chapter': 'removed-provider-secret' } }, expected: null,
    copy: ['工作流绑定', '已删除', '教材生成', '不可用'] },
  { id: 'deleted-default', settings: { ...initial, defaultProviderId: 'removed-provider-secret' }, expected: null,
    copy: ['已删除', '工作流绑定 → 教材生成', '不可用'] },
  { id: 'empty-settings', settings: { providers: [], defaultProviderId: '', workflowBinding: {} }, expected: null,
    copy: ['尚未配置', 'AI 配置', '不可用'] },
  { id: 'all-disabled-without-route', settings: { providers: [deepseek, { ...glm, enabled: false }], defaultProviderId: '', workflowBinding: {} }, expected: null,
    copy: ['尚无可用的已启用供应商', 'AI 配置', '不可用'] },
  { id: 'legacy-no-route', settings: { ...initial, defaultProviderId: '' }, expected: glm.id },
];
const observations: any[] = [];
for (const test of cases) {
  current = structuredClone(test.settings);
  assert.equal(selectLlmProvider(current, 'textbook-chapter')?.id || null, test.expected, 'Selection policy remains authoritative');
  const calls: any[] = [];
  for (const resumed of [false, true]) {
    const request = progressiveGenerationRequest(resumed ? { ...course, generation: { ...course.generation, status: 'failed', bodyDraft: '# 原草稿\n\n原课程内容保持不变。' } } : course);
    assert.equal(request.workflow, 'textbook-chapter'); assert.equal(request.model, ''); assert.equal(request.providerId, '');
    for (const [kind, call] of [['sync', callSync], ['stream', callStream]] as const) {
      const before = sent.length;
      if (test.expected) {
        const result = await call(request, { outputSchema: null });
        if (kind === 'stream') await result.cancel();
        assert.equal(sent.at(-1)?.id, test.expected); assert.equal(sent.at(-1)?.model, 'glm-5.3');
        calls.push({ kind, resumed, selected: test.expected });
      } else {
        let message = '';
        await assert.rejects(call(request), (error: any) => { message = error.message; return test.copy!.every(fragment => message.includes(fragment)); });
        assert.ok(!message.includes('AI 配置 → 默认供应商'), 'repair instructions must point to a visible per-workflow control');
        assert.equal(sent.length, before, 'Invalid routes fail before IPC and never fall back');
        for (const forbidden of [glm.apiKey, deepseek.apiKey, glm.baseUrl, deepseek.baseUrl, 'removed-provider-secret']) assert.ok(!message.includes(forbidden!));
        calls.push({ kind, resumed, message, transportCalls: 0 });
      }
    }
  }
  observations.push({ id: test.id, calls });
}
// Display-name mistakes must not leak credentials, configured addresses, their
// appended query strings or a deleted provider's ID through error feedback.
const pastedName = { ...deepseek, name: `DeepSeek ${deepseek.apiKey} ${deepseek.baseUrl}&extra=private-fragment` };
const safe = describeLlmProviderUnavailable({ ...initial, providers: [pastedName, glm] }, 'textbook-chapter', '教材·章节生成');
for (const forbidden of [deepseek.apiKey, deepseek.baseUrl, 'private=query', 'extra=private-fragment', 'https://']) assert.ok(!safe.includes(forbidden!));
assert.match(safe, /DeepSeek/u); assert.match(safe, /已停用/u);
assert.equal(course.generation.bodyDraft, '', 'Routing does not mutate the course or require rebuilding it');
const report = { status: 'passed', modelRequests: 0, networkRequests: 0, realSettingsModified: false,
  routeCases: cases.length, actualRequestVariants: ['fresh progressive', 'resumed progressive'], transports: ['sync', 'stream'],
  observations, redactionPassed: true, localSuccessfulTransportCalls: sent.length,
  scope: 'Actual request/resolver functions with synthetic settings and IPC; does not establish GLM endpoint compatibility.' };
const root = await fs.mkdtemp(path.resolve('build/llm-route-diagnostics-'));
await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ status: report.status, root, routeCases: cases.length, actualRequestVariants: 2, transports: 2, realModelRequests: 0, redactionPassed: true }));
