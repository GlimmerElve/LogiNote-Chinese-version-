import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import type { LlmIpcRequest } from '../src/electron/ipcTypes';
import type { LlmCallRequest, LlmProvider, LlmSettings, SceneRunState, SceneSpec } from '../src/types';
import { assertLlmRequestProviderEnabled } from '../src/electron/llmProviderAuthority';
import { selectLlmProvider } from '../src/services/llmProviderSelection';
import { createWebAcquisition, resolveWebProvider } from '../src/electron/webAcquisition';

// Synthetic settings, transports and main-process callbacks. Never load real
// saved configuration, credentials or call a model endpoint.
const remote: LlmProvider = { id: 'deepseek-default', name: 'Synthetic remote', apiType: 'openai-compatible',
  baseUrl: 'https://remote.synthetic.invalid/v1', apiKey: '', models: ['remote-model'], selectedModel: 'remote-model', enabled: true, createdAt: '' };
const local: LlmProvider = { ...remote, id: 'local-model', name: 'Synthetic local', apiType: 'ollama',
  baseUrl: 'http://127.0.0.1:11434', models: ['approved-model'], selectedModel: 'approved-model' };
const initial: LlmSettings = { providers: [remote, local], defaultProviderId: remote.id,
  workflowBinding: { 'review-tutor': local.id } };
let persisted = structuredClone(initial), hold = false, release!: () => void;
let gate = Promise.resolve();
const memory = new Map([['loginote_llm_settings', JSON.stringify(initial)]]);
const sent: { id?: string; baseUrl: string; model?: string }[] = [];
const dispatched = (request: LlmIpcRequest) => {
  assert.equal(persisted.providers.find(provider => provider.id === request.provider.id)?.enabled, true,
    'dispatch waits for the latest saved enablement');
  sent.push({ id: request.provider.id, baseUrl: request.provider.baseUrl, model: request.provider.selectedModel });
};
Object.assign(globalThis, {
  localStorage: { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key) },
  window: { electronAPI: { userState: { loadLlm: async () => structuredClone(persisted), saveLlm: async (value: LlmSettings) => {
    if (hold) await gate; persisted = structuredClone(value);
  } }, llm: {
    request: async (request: LlmIpcRequest) => { dispatched(request); return { content: 'Synthetic OK' }; },
    stream: async (request: LlmIpcRequest) => { dispatched(request); return 'synthetic-stream'; },
    probe: async (request: LlmIpcRequest) => { dispatched(request); return { ok: true, model: request.provider.selectedModel }; },
    cancel: async () => true, onChunk: () => () => {}, onEnd: () => () => {}, onError: () => () => {},
  } } },
});
globalThis.fetch = async () => { throw new Error('External network forbidden'); };
const storage = await import('../src/services/llmStorage');
const { callLLM, resolveProvider, probeLlmProvider } = await import('../src/services/llmService');
const { callLLMStream } = await import('../src/services/llmStreamService');
await storage.ensureLlmSettingsLoaded();
const request: LlmCallRequest = { providerId: '', workflow: 'review-tutor', model: '', userInput: 'Synthetic check', skipMemoryInjection: true };
await callLLM(request);
assert.equal(sent.at(-1)?.id, local.id);
const disabled = { ...initial, providers: [remote, { ...local, enabled: false }] };
await storage.saveLlmSettings(disabled);
const checkpoint = sent.length;
assert.equal(resolveProvider('review-tutor'), null);
await assert.rejects(callLLM(request), /不可用/);
await assert.rejects(callLLMStream(request), /不可用/);
assert.equal(await probeLlmProvider(local), false);
assert.equal(sent.length, checkpoint, 'a disabled explicit binding cannot invoke the enabled remote default');
await storage.saveLlmSettings({ ...initial, workflowBinding: { 'review-tutor': 'deleted-provider' } });
await assert.rejects(callLLM(request), /不可用/);
await storage.saveLlmSettings({ ...initial, providers: [{ ...remote, enabled: false }, local], workflowBinding: {} });
await assert.rejects(callLLM(request), /不可用/);
assert.equal(sent.length, checkpoint);
assert.equal(selectLlmProvider({ ...initial, defaultProviderId: '', workflowBinding: {} }, 'unbound')?.id, remote.id,
  'a genuinely absent route retains legacy first-enabled selection');
console.log('PASS 显式绑定停用/删除、默认供应商停用均拒绝普通/流式/探测调用，零静默切换');
const webSettings: LlmSettings = { ...disabled, providers: [{ ...remote, baseUrl: 'https://api.deepseek.com/v1', apiKey: 'synthetic-not-a-secret' },
  { ...local, enabled: false }], workflowBinding: { 'concept-generation': local.id } };
assert.equal(resolveWebProvider(webSettings, 'concept-generation'), null);
const web = createWebAcquisition({ settings: async () => webSettings,
  fetch: async () => assert.fail('disabled web supplier must not use the enabled official default') });
assert.equal(await web.search('synthetic query', 'concept-generation'), null);
console.log('PASS 联网检索API也遵守供应商停用，不会转用默认供应商产生请求');

await storage.saveLlmSettings({ ...initial, providers: [remote, { ...local, selectedModel: 'changed-model', baseUrl: 'http://127.0.0.1:22434' }] });
await callLLM({ ...request, model: 'approved-model' }, { providerSnapshot: local });
assert.equal(sent.at(-1)?.model, 'approved-model'); assert.equal(sent.at(-1)?.baseUrl, local.baseUrl);
await storage.saveLlmSettings(disabled);
const pinnedCheckpoint = sent.length;
await assert.rejects(callLLM(request, { providerSnapshot: local }), /已停用/);
await storage.saveLlmSettings({ ...initial, providers: [remote] });
await assert.rejects(callLLM(request, { providerSnapshot: local }), /已不存在/);
assert.equal(sent.length, pinnedCheckpoint);
console.log('PASS 已批准快照仍固定模型与地址，但供应商后续停用/删除立即阻止下一请求');

hold = true; gate = new Promise<void>(resolve => { release = resolve; });
const writingEnabled = storage.saveLlmSettings(initial);
const pending = callLLM(request);
await new Promise(resolve => setImmediate(resolve));
const writingDisabled = storage.saveLlmSettings(disabled);
hold = false; release();
await Promise.all([writingEnabled, writingDisabled]);
await assert.rejects(pending, /已停用/);
assert.equal(sent.length, pinnedCheckpoint);
await storage.saveLlmSettings(initial);
const stream = await callLLMStream(request); await stream.cancel();
assert.equal(sent.at(-1)?.id, local.id);
console.log('PASS 请求等待配置写入并在等待后复核停用，阻止保存队列中的过时启用快照');

const { executeSceneExperiment } = await import('../src/services/scene/sceneExperiment');
await storage.saveLlmSettings({ ...initial, workflowBinding: { ...initial.workflowBinding, 'scene-model-experiment': local.id } });
const bridge = (window as any).electronAPI.llm;
const normalRequest = bridge.request;
bridge.request = async (input: LlmIpcRequest) => {
  const result = await normalRequest(input);
  await storage.saveLlmSettings(disabled);
  return result;
};
const sceneCheckpoint = sent.length;
const spec = { sceneId: 'synthetic-disabled-scene', meta: { sceneSkill: 'S1' }, promptModuleIds: ['model-experiment'],
  experimentPolicy: { criteria: ['Response contains OK'], maxExperiments: 6, maxOutputTokens: 256, temperature: 0 } } as SceneSpec;
const sceneRun = { sceneId: spec.sceneId, runId: 'disable-after-target', experimentApproved: true, status: 'running',
  messages: [{ id: 'prompt', speakerType: 'user', content: 'Say OK', speakerName: 'User', timestamp: '' }] } as SceneRunState;
const sceneResult = await executeSceneExperiment(spec, sceneRun, { promptSourceMessageId: 'prompt', promptQuote: 'Say OK', outputFormat: 'text' });
assert.equal(sceneResult.status, 'failed'); assert.equal(sceneResult.output, 'Synthetic OK');
assert.equal(sent.length - sceneCheckpoint, 1, 'disabling after the target reply blocks the captured-model evaluation request');
bridge.request = normalRequest;
console.log('PASS 真实场景实验第一阶段后停用供应商，保留已得输出且后续评估零请求');

// Invoke the actual registered Electron callbacks with an injected authority
// reader. A stale renderer cannot dispatch even with an enabled snapshot.
const source = ts.createSourceFile('main.ts', readFileSync('src/electron/main.ts', 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
const callbacks = new Map<string, ts.Node>();
const visit = (node: ts.Node) => {
  if (ts.isCallExpression(node) && node.expression.getText(source) === 'ipcMain.handle'
    && ts.isStringLiteral(node.arguments[0]) && /^llm:(?:request|stream-start|probe|models)$/u.test(node.arguments[0].text)) {
    callbacks.set(node.arguments[0].text, node.arguments[1]);
  }
  ts.forEachChild(node, visit);
}; visit(source);
assert.equal(callbacks.size, 4);
let authority = structuredClone(disabled), network = 0;
const active = new Map();
const env = { assertLlmRequestProviderEnabled, readLlmProviderAuthoritySettings: async () => authority,
  proxyLlmRequest: async () => { network++; return { content: 'OK' }; },
  streamLlmRequest: async () => { network++; }, probeLlmRequest: async () => { network++; return { ok: true }; },
  discoverLlmModels: async () => { network++; return { ok: true, models: ['synthetic'] }; },
  llmRequestKey: () => 'synthetic-key', activeLlmRequests: active,
  llmContinuationOwners: new Set(), releaseLlmToolContinuations: () => {} };
const ipcRequest: LlmIpcRequest = { provider: { ...local }, systemPrompt: '', userInput: '', temperature: 0, maxTokens: 1 };
const sender = { id: 1, once() {}, removeListener() {}, isDestroyed: () => false, send() {} };
for (const [channel, node] of callbacks) {
  const code = ts.transpileModule(`return (${node.getText(source)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const callback = new Function(...Object.keys(env), code)(...Object.values(env));
  authority = structuredClone(disabled);
  await assert.rejects(callback({ sender }, ipcRequest), /已停用/, channel);
  assert.equal(network, 0); assert.equal(active.size, 0);
  authority = { ...initial, providers: [remote] };
  await assert.rejects(callback({ sender }, ipcRequest), /已不存在/, channel);
}
authority = structuredClone(initial);
await assertLlmRequestProviderEnabled(ipcRequest, async () => authority);
await assertLlmRequestProviderEnabled({ ...ipcRequest, provider: { ...ipcRequest.provider, id: undefined } }, async () => assert.fail('legacy protocol adapter does not have a saved identity'));
for (const node of callbacks.values()) {
  const code = ts.transpileModule(`return (${node.getText(source)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const callback = new Function(...Object.keys(env), code)(...Object.values(env));
  await callback({ sender }, ipcRequest);
}
await new Promise(resolve => setImmediate(resolve));
assert.equal(network, 4, 'enabled saved suppliers remain usable through every desktop endpoint');
assert.equal(active.size, 0);
console.log('PASS 真实主进程四个IPC入口均按权威设置拒绝停用/删除的过时窗口请求，零网络');

// Closing a renderer while the authority read is suspended must stop before
// registering ownership or creating an HTTP dispatch. The actual callbacks
// are used so moving the destroyed guard above/below the await is observable.
for (const channel of ['llm:request', 'llm:stream-start']) {
  let authorityReadStarted!: () => void, releaseAuthorityRead!: () => void;
  const readStarted = new Promise<void>(resolve => { authorityReadStarted = resolve; });
  const authorityReadGate = new Promise<void>(resolve => { releaseAuthorityRead = resolve; });
  const owners = new Set<number>(), raceActive = new Map();
  let dispatches = 0, releasedOwners = 0, destroyed = false, sentChunks = 0;
  const raceSender = Object.assign(new EventEmitter(), {
    id: channel === 'llm:request' ? 101 : 102,
    isDestroyed: () => destroyed,
    send: () => { sentChunks++; },
  });
  const raceEnv = { ...env,
    readLlmProviderAuthoritySettings: async () => {
      authorityReadStarted();
      await authorityReadGate;
      return structuredClone(initial);
    },
    proxyLlmRequest: async () => { dispatches++; return { content: 'Unexpected dispatch' }; },
    streamLlmRequest: async () => { dispatches++; },
    activeLlmRequests: raceActive,
    llmContinuationOwners: owners,
    releaseLlmToolContinuations: () => { releasedOwners++; },
  };
  const node = callbacks.get(channel)!;
  const code = ts.transpileModule(`return (${node.getText(source)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const callback = new Function(...Object.keys(raceEnv), code)(...Object.values(raceEnv));
  const pendingRequest = callback({ sender: raceSender }, ipcRequest);
  await readStarted;
  assert.equal(dispatches, 0, `${channel}: authority must be checked before dispatch`);
  assert.equal(owners.size, 0, `${channel}: authority read must not retain an owner`);
  destroyed = true;
  raceSender.emit('destroyed');
  releaseAuthorityRead();
  await assert.rejects(pendingRequest, /请求窗口已关闭/, channel);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(dispatches, 0, `${channel}: closed renderer must not invoke either transport`);
  assert.equal(raceActive.size, 0, `${channel}: no active request may survive the authority race`);
  assert.equal(owners.size, 0, `${channel}: closed renderer must not retain continuation ownership`);
  assert.equal(raceSender.listenerCount('destroyed'), 0, `${channel}: no late destroyed listener may be installed`);
  assert.equal(releasedOwners, 0, `${channel}: no continuation owner was acquired`);
  assert.equal(sentChunks, 0, `${channel}: closed renderer must not receive stream events`);
}
console.log('PASS 同步/流式入口在异步权威检查期间关闭窗口，零传输、零活动请求、零遗留接续owner');
