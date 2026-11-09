import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { LlmProvider, LlmSettings } from '../src/types';
import { selectLlmProvider } from '../src/services/llmProviderSelection';
import { createSettingsHydration } from '../src/services/ui/settingsHydration';
import { createSettingsPersistence } from '../src/services/ui/settingsPersistence';

// Production storage/normalization/persistence code, isolated renderer caches
// and user-state IPC. Never reads real settings or calls a model/network.
const compiled = ts.transpileModule(readFileSync('src/services/llmStorage.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const same = (actual: unknown, expected: unknown, message?: string) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);
const glm: LlmProvider = { id: 'user-glm', name: 'Synthetic GLM 5.3', apiType: 'openai-compatible', baseUrl: 'https://synthetic.invalid/v4',
  apiKey: '', models: ['glm-5.3'], selectedModel: 'glm-5.3', enabled: true, createdAt: 'synthetic' };
const deepseek: LlmProvider = { ...glm, id: 'deepseek-default', name: 'Synthetic disabled DeepSeek', enabled: false };
const gemini: LlmProvider = { ...glm, id: 'gemini-default', name: 'Synthetic disabled Gemini', apiType: 'gemini', enabled: false };

function harness(initial: unknown, initialDisk: unknown = initial) {
  const memory = new Map<string, string>();
  if (initial !== null) memory.set('loginote_llm_settings', typeof initial === 'string' ? initial : JSON.stringify(initial));
  let disk = structuredClone(initialDisk), reads = 0, writes = 0;
  let held: Promise<void> | undefined, release: (() => void) | undefined, failSave = false;
  const module = { exports: {} as any };
  runInNewContext(compiled, { module, exports: module.exports, structuredClone, Promise, Date, Error,
    require(id: string) {
      if (id === './ui/settingsHydration') return { createSettingsHydration };
      if (id === './ui/settingsPersistence') return { createSettingsPersistence };
      if (id === './electronUserState') return { saveLlmState: async (value: LlmSettings) => {
        writes++; if (held) await held;
        if (failSave) throw new Error('synthetic write failure');
        disk = structuredClone(value);
      } };
      throw new Error(`Unexpected dependency: ${id}`);
    },
    localStorage: { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value) },
    window: { electronAPI: { userState: { loadLlm: async () => { reads++; return structuredClone(disk); } } } },
  });
  return { api: module.exports, memory, get disk() { return disk; }, get reads() { return reads; }, get writes() { return writes; },
    hold() { held = new Promise<void>(resolve => { release = resolve; }); },
    release() { release?.(); held = undefined; }, setFailSave(value: boolean) { failSave = value; } };
}

const cases: Array<{ name: string; settings: LlmSettings; textbook: string | null; plan?: string | null }> = [
  { name: 'GLM only, unbound workflows inherit GLM', settings: { providers: [glm], defaultProviderId: glm.id, workflowBinding: {} }, textbook: glm.id, plan: glm.id },
  { name: 'GLM with disabled DeepSeek cannot gain hidden plan binding', settings: { providers: [deepseek, glm], defaultProviderId: glm.id, workflowBinding: {} }, textbook: glm.id, plan: glm.id },
  { name: 'disabled explicit default stays unavailable', settings: { providers: [deepseek, glm], defaultProviderId: deepseek.id, workflowBinding: {} }, textbook: null },
  { name: 'disabled legacy Gemini is never replaced or enabled', settings: { providers: [gemini, glm], defaultProviderId: gemini.id, workflowBinding: { 'textbook-chapter': gemini.id } }, textbook: null },
  { name: 'deliberately empty provider set remains empty', settings: { providers: [], defaultProviderId: '', workflowBinding: {} }, textbook: null },
  { name: 'deleted default never falls through to GLM', settings: { providers: [glm], defaultProviderId: 'deleted-provider', workflowBinding: {} }, textbook: null },
  { name: 'deleted workflow target never falls through to default', settings: { providers: [glm], defaultProviderId: glm.id, workflowBinding: { 'textbook-chapter': 'deleted-provider' } }, textbook: null },
  { name: 'deleted DeepSeek binding cannot revive a provider', settings: { providers: [glm], defaultProviderId: glm.id, workflowBinding: { 'textbook-chapter': 'deepseek-default' } }, textbook: null },
  { name: 'disabled workflow target never falls through to default', settings: { providers: [deepseek, glm], defaultProviderId: glm.id, workflowBinding: { 'textbook-chapter': deepseek.id } }, textbook: null },
  { name: 'empty default preserves legacy first-enabled selection', settings: { providers: [deepseek, glm], defaultProviderId: '', workflowBinding: {} }, textbook: glm.id },
  { name: 'mixed explicit bindings remain exact', settings: { providers: [deepseek, glm], defaultProviderId: '', workflowBinding: { 'textbook-chapter': glm.id, 'plan-generation': deepseek.id, 'flow-analysis': '' } }, textbook: glm.id, plan: null },
  { name: 'manual thinking preferences round-trip without changing provider routes', settings: { providers: [deepseek, glm], defaultProviderId: glm.id, workflowBinding: {},
    workflowThinking: { 'textbook-blueprint': 'high', 'textbook-chapter': 'off', 'concept-generation': 'low', 'flow-analysis': 'medium', 'agent-chat': 'default' } }, textbook: glm.id, plan: glm.id },
];
for (const item of cases) {
  const before = JSON.stringify(item.settings), h = harness(item.settings);
  same(h.api.loadLlmSettings(), item.settings, item.name + ': synchronous form load');
  same(await h.api.ensureLlmSettingsLoaded(), item.settings, item.name + ': authoritative hydration');
  const read = h.api.readLlmSettingsForUse(); same(read, item.settings);
  assert.equal(selectLlmProvider(read, 'textbook-chapter')?.id ?? null, item.textbook, item.name);
  if (item.plan !== undefined) assert.equal(selectLlmProvider(read, 'plan-generation')?.id ?? null, item.plan, item.name);
  same(h.disk, item.settings); assert.equal(h.writes, 0, 'hydration never persists a vendor migration');
  same(JSON.parse(h.memory.get('loginote_llm_settings')!), item.settings);
  assert.equal(JSON.stringify(item.settings), before, 'input fixture was not mutated');
}

const input = cases[0].settings, h = harness(input); await h.api.ensureLlmSettingsLoaded(); h.hold();
const writing = h.api.saveLlmSettings(structuredClone(input));
same(h.api.loadLlmSettings(), input); same(h.api.readLlmSettingsForUse(), input);
assert.equal(selectLlmProvider(h.api.readLlmSettingsForUse(), 'textbook-chapter')?.id, glm.id, 'pending save uses exact draft route');
h.release(); await writing; await h.api.flushLlmSettingsWrites();
same(h.api.loadLlmSettings(), input); same(h.api.readLlmSettingsForUse(), input);
assert.equal(selectLlmProvider(h.api.readLlmSettingsForUse(), 'textbook-chapter')?.id, glm.id, 'acknowledged save cannot change the route');
const restart = harness(null, h.disk); same(await restart.api.ensureLlmSettingsLoaded(), input);
same(restart.api.loadLlmSettings(), input); assert.equal(restart.writes, 0);

const thinkingInput = cases.at(-1)!.settings, thinking = harness(thinkingInput);
await thinking.api.ensureLlmSettingsLoaded();
await thinking.api.saveLlmSettings(thinkingInput); await thinking.api.flushLlmSettingsWrites();
same(thinking.disk, thinkingInput, 'explicit thinking preferences survive the real serialized save queue');
const thinkingRestart = harness(null, thinking.disk);
same(await thinkingRestart.api.ensureLlmSettingsLoaded(), thinkingInput, 'complete settings restart keeps every chosen preference');
assert.equal(thinkingRestart.writes, 0, 'restoring preferences never writes or migrates old settings');
const beforeBadThinking = JSON.stringify(thinking.disk), writesBeforeBadThinking = thinking.writes;
await assert.rejects(thinking.api.saveLlmSettings({ ...thinkingInput, workflowThinking: { 'agent-chat': 'unsupported-level' } }), /思考设置格式错误/u);
assert.equal(JSON.stringify(thinking.disk), beforeBadThinking); assert.equal(thinking.writes, writesBeforeBadThinking);
same(thinking.api.readLlmSettingsForUse(), thinkingInput, 'an invalid mode cannot replace the last acknowledged settings');

const failed = harness(input); await failed.api.ensureLlmSettingsLoaded(); failed.setFailSave(true);
await assert.rejects(failed.api.saveLlmSettings(input), /保存失败/u);
same(failed.api.loadLlmSettings(), input); same(failed.api.readLlmSettingsForUse(), input);
failed.setFailSave(false); await failed.api.retryLlmSettingsSave(); same(failed.api.readLlmSettingsForUse(), input);

const omitted = { providers: [glm] }, missingOptional = harness(omitted);
same(missingOptional.api.loadLlmSettings(), { providers: [glm], defaultProviderId: '', workflowBinding: {} });
same(await missingOptional.api.ensureLlmSettingsLoaded(), { providers: [glm], defaultProviderId: '', workflowBinding: {} });
const fresh = harness(null); const defaults = await fresh.api.ensureLlmSettingsLoaded();
same(defaults, { providers: [], defaultProviderId: '', workflowBinding: {} }, 'first launch starts without any preset vendor or bindings');
assert.equal(fresh.writes, 0, 'merely opening first-run settings must remain read-only');
for (const invalid of ['', '{broken', { providers: [{}] }, ...[null, [], 'off', { 'agent-chat': 1 }, { 'agent-chat': 'unsupported-level' }]
  .map(workflowThinking => ({ ...input, workflowThinking }))]) {
  const invalidCache = harness(invalid, null), before = invalidCache.memory.get('loginote_llm_settings');
  same(invalidCache.api.loadLlmSettings(), { providers: [], defaultProviderId: '', workflowBinding: {} }, 'corruption cannot invent a new enabled supplier');
  await assert.rejects(invalidCache.api.ensureLlmSettingsLoaded(), /无法读取模型配置/u);
  assert.throws(() => invalidCache.api.readLlmSettingsForUse(), /读取失败/u);
  assert.equal(invalidCache.memory.get('loginote_llm_settings'), before); assert.equal(invalidCache.writes, 0);
}
console.log(JSON.stringify({ status: 'passed', routeCases: cases.length, checks: ['only absent config defaults', 'GLM before/during/after save and restart', 'disabled and deleted routes', 'legacy Gemini preserved', 'empty providers', 'failed save draft', 'corruption blocks requests'], networkCalls: 0, modelRequests: 0, realSettingsAccessed: false }));
