/** Real service/API builders with synthetic settings, IPC and provider responses.
 * No real model, credentials, browser cache, user notes or network are used. */
import assert from 'node:assert/strict';
import type { LlmCallRequest, LlmProvider, LlmSettings } from '../src/types';
import type { LlmIpcRequest, StreamChunkIpc } from '../src/electron/ipcTypes';
import { proxyLlmRequest, streamLlmRequest } from '../src/electron/apiHandlers';

const glm: LlmProvider = { id: 'thinking-glm', name: 'Synthetic GLM', apiType: 'openai-compatible',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: '', selectedModel: 'glm-5.3', models: ['glm-5.3'], enabled: true, createdAt: 'synthetic' };
const ds: LlmProvider = { ...glm, id: 'thinking-deepseek', name: 'Synthetic DeepSeek', baseUrl: 'https://api.deepseek.com/v1', selectedModel: 'deepseek-flash', models: ['deepseek-flash'] };
let persisted: LlmSettings = { providers: [glm], defaultProviderId: glm.id, workflowBinding: {} };
const memory = new Map([['loginote_llm_settings', JSON.stringify(persisted)]]);
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const originalFetch = globalThis.fetch;
const http: Array<{ url: string; body: any }> = [];
const ipc: LlmIpcRequest[] = [];
const rawEvents: StreamChunkIpc[] = [];
const secret = 'PRIVATE_PROVIDER_REASONING_DO_NOT_FORWARD_95372';
const listeners = { chunk: new Set<(value: any) => void>(), end: new Set<(value: any) => void>(), error: new Set<(value: any) => void>() };
const inFlight = new Map<string, AbortController>();
const tasks: Promise<void>[] = [];
let sequence = 0;
const send = (kind: keyof typeof listeners, value: unknown) => listeners[kind].forEach(listener => listener(value));
const subscribe = (kind: keyof typeof listeners, fn: (value: any) => void) => { listeners[kind].add(fn); return () => { listeners[kind].delete(fn); }; };
const dispatch = (req: LlmIpcRequest) => {
  assert.ok(persisted.providers.some(provider => provider.id === req.provider.id && provider.enabled));
  ipc.push(structuredClone(req));
};
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key),
} });
Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: {
  userState: { loadLlm: async () => structuredClone(persisted), saveLlm: async (value: LlmSettings) => { persisted = structuredClone(value); } },
  llm: {
    request: async (req: LlmIpcRequest) => { dispatch(req); return proxyLlmRequest(req); },
    stream: async (req: LlmIpcRequest) => {
      dispatch(req); const streamId = 'thinking-stream-' + (++sequence), controller = new AbortController(); inFlight.set(streamId, controller);
      tasks.push(new Promise<void>(resolve => setImmediate(async () => {
        try {
          const emit = (chunk: StreamChunkIpc) => { rawEvents.push(chunk); send('chunk', { streamId, chunk }); };
          const diagnostics = await streamLlmRequest(req, emit, controller.signal);
          if (diagnostics) emit({ type: 'diagnostics', text: '', diagnostics });
          send('end', { streamId });
        } catch (error) { send('error', { streamId, message: (error as Error).message, cancelled: controller.signal.aborted }); }
        finally { inFlight.delete(streamId); resolve(); }
      })));
      return streamId;
    },
    cancel: async (id: string) => { inFlight.get(id)?.abort(); return true; },
    onChunk: (fn: (value: any) => void) => subscribe('chunk', fn), onEnd: (fn: (value: any) => void) => subscribe('end', fn), onError: (fn: (value: any) => void) => subscribe('error', fn),
  },
} } });
globalThis.fetch = (async (url: any, init: any) => {
  assert.equal(init?.method, 'POST', 'Only synthetic provider POSTs are permitted');
  const body = JSON.parse(init.body); http.push({ url: String(url), body });
  if (body.generationConfig) return new Response(JSON.stringify({ modelVersion: 'synthetic-gemini',
    candidates: [{ content: { parts: [{ text: 'Synthetic final response.' }] }, finishReason: 'STOP' }] }), { status: 200 });
  if (init.headers?.['anthropic-version']) return new Response(JSON.stringify({ model: body.model,
    content: [{ type: 'thinking', thinking: secret }, { type: 'text', text: 'Synthetic final response.' }], stop_reason: 'end_turn' }), { status: 200 });
  if (body.options && !body.stream) return new Response(JSON.stringify({ model: body.model,
    message: { thinking: secret, content: 'Synthetic final response.' }, done: true }), { status: 200 });
  if (body.options) return new Response(new ReadableStream({ start(controller) {
    const encoder = new TextEncoder();
    controller.enqueue(encoder.encode(JSON.stringify({ message: { thinking: secret } }) + '\n'));
    controller.enqueue(encoder.encode(JSON.stringify({ message: { content: 'Synthetic final response.' }, done: true }) + '\n')); controller.close();
  } }), { status: 200 });
  if (!body.stream) return new Response(JSON.stringify({ model: body.model,
    choices: [{ message: { content: 'Synthetic final response.', reasoning_content: secret }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 11, completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 12 } } }), { status: 200 });
  const events = [
    { choices: [{ delta: { reasoning_content: secret + '_one' } }] },
    { choices: [{ delta: { reasoning_content: secret + '_two' } }] },
    { choices: [{ delta: { content: 'Synthetic final response.' } }] },
    { choices: [{ delta: { reasoning_content: secret + '_late' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ];
  return new Response(new ReadableStream({ start(controller) {
    const encoder = new TextEncoder(); for (const event of events) controller.enqueue(encoder.encode('data: ' + JSON.stringify(event) + '\n\n'));
    controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close();
  } }), { status: 200 });
}) as typeof fetch;

try {
  const storage = await import('../src/services/llmStorage');
  const { callLLM } = await import('../src/services/llmService');
  const { callLLMStream } = await import('../src/services/llmStreamService');
  await storage.ensureLlmSettingsLoaded();
  const request: LlmCallRequest = { providerId: '', model: '', workflow: 'concept-generation', systemPromptOverride: 'Synthetic teaching task.',
    userInput: 'Synthetic content.', maxTokensOverride: 2048, temperatureOverride: 0.1, thinkingMode: 'disabled', skipMemoryInjection: true, skipProfileInjection: true };
  const select = async (provider: LlmProvider, preference: string, workflow = 'concept-generation') => {
    await storage.saveLlmSettings({ providers: [provider], defaultProviderId: provider.id, workflowBinding: {},
      ...(preference === 'default' ? {} : { workflowThinking: { [workflow]: preference } }) } as LlmSettings);
  };
  const lastBody = () => http.at(-1)!.body;
  const noLeak = (value: unknown) => assert.ok(!JSON.stringify(value).includes(secret), 'Provider reasoning must never become renderer content');
  const drain = async (stream: ReadableStream<any>) => { const reader = stream.getReader(), chunks: any[] = []; try {
    for (;;) { const next = await reader.read(); if (next.done) return chunks; chunks.push(next.value); }
  } finally { reader.releaseLock(); } };
  const budgets: Record<string, number> = {};
  const glmEffort: Record<string, string> = { default: 'low', off: 'low', low: 'low', medium: 'high', high: 'max' };
  const glmTimeout: Record<string, number | undefined> = { default: undefined, off: 300000, low: 300000, medium: 480000, high: 600000 };
  for (const preference of ['default', 'off', 'low', 'medium', 'high']) {
    await select(glm, preference);
    const sync = await callLLM(request); noLeak(sync);
    const syncBody = structuredClone(lastBody());
    assert.equal(syncBody.thinking?.type, 'enabled', 'GLM-5.3 cannot disable thinking');
    assert.equal(syncBody.reasoning_effort, glmEffort[preference], 'The three GLM levels map to low/high/max; off falls back to low');
    assert.ok(syncBody.max_tokens >= 2048 && syncBody.max_tokens <= 32768);
    budgets[preference] = syncBody.max_tokens;
    assert.equal(ipc.at(-1)?.timeoutMs, glmTimeout[preference], 'Only supported manual thinking choices extend the synchronous deadline');
    assert.equal(syncBody.timeoutMs, undefined, 'Local timeouts are not sent as invented provider parameters');
    const chunks = await drain(await callLLMStream(request, { maxTokens: 2048, outputSchema: null, includeActivity: true }));
    assert.equal(lastBody().thinking?.type, syncBody.thinking.type); assert.equal(lastBody().reasoning_effort, syncBody.reasoning_effort);
    assert.equal(lastBody().max_tokens, syncBody.max_tokens, 'Sync/stream use one budget policy');
    assert.deepEqual(ipc.at(-1)?.streamTimeout, glmTimeout[preference] ? { firstResponseMs: 180000, idleMs: 90000, totalMs: glmTimeout[preference] } : undefined);
    assert.equal(lastBody().streamTimeout, undefined);
    assert.deepEqual(chunks.filter(chunk => chunk.type === 'activity').map(chunk => chunk.activity?.phase), ['reasoning', 'responding']);
    assert.ok(chunks.filter(chunk => chunk.type === 'activity').every(chunk => chunk.text === '')); noLeak(chunks); noLeak(rawEvents);
    assert.equal(ipc.at(-1)?.tokenBudgetMode, 'total', 'Main must not adapt a renderer total a second time');
  }
  assert.equal(budgets.off, budgets.low, 'Unsupported off maps to the minimum supported GLM mode');
  assert.ok(budgets.low <= budgets.medium && budgets.medium <= budgets.high, 'Higher reasoning levels cannot get a smaller allowance');
  await select(glm, 'high');
  const explicitDeadline = { firstResponseMs: 180000, idleMs: 90000, totalMs: 200000 };
  await drain(await callLLMStream(request, { maxTokens: 2048, outputSchema: null, streamTimeout: explicitDeadline }));
  assert.deepEqual(ipc.at(-1)?.streamTimeout, explicitDeadline, 'An explicit approved streaming deadline wins over the manual preference default');
  await callLLM({ ...request, maxTokensOverride: 8192, tokenBudgetMode: 'total' });
  assert.equal(lastBody().max_tokens, 8192, 'A fixed total remains exact even with a high manual preference');
  await select(glm, 'off'); await callLLM({ ...request, thinkingMode: 'enabled' });
  assert.equal(lastBody().reasoning_effort, 'low', 'A manual setting supersedes an ordinary caller decision');
  await select(glm, 'default'); await callLLM({ ...request, thinkingMode: 'enabled' });
  assert.equal(lastBody().reasoning_effort, undefined, 'Default restores the caller/system reasoning decision');
  await select(glm, 'high'); await callLLM({ ...request, thinkingMode: 'disabled', thinkingPreference: 'default' });
  assert.equal(lastBody().reasoning_effort, 'low', 'An explicit default locks a captured system policy instead of inheriting later UI edits');
  await callLLM({ ...request, thinkingMode: 'enabled', thinkingPreference: 'default', maxTokensOverride: 8192, tokenBudgetMode: 'total' }, { providerSnapshot: glm });
  assert.equal(lastBody().reasoning_effort, undefined); assert.equal(lastBody().max_tokens, 8192, 'Frozen provider requests retain both their system policy and their approved total');
  await drain(await callLLMStream({ ...request, thinkingPreference: 'default' }, { maxTokens: 2048, outputSchema: null }));
  assert.equal(lastBody().reasoning_effort, 'low', 'Streaming honors an explicit captured default too');
  await select(glm, 'high', 'question-answer'); await callLLM(request);
  assert.equal(lastBody().reasoning_effort, 'low', 'A different workflow preference cannot affect this request');

  await select(ds, 'default'); await callLLM(request);
  assert.equal(lastBody().thinking?.type, 'disabled'); assert.equal(lastBody().reasoning_effort, undefined); assert.equal(lastBody().max_tokens, 2048);
  assert.equal(ipc.at(-1)?.timeoutMs, undefined);
  await callLLM({ ...request, thinkingMode: 'enabled' });
  assert.equal(lastBody().thinking?.type, 'enabled'); assert.equal(lastBody().reasoning_effort, undefined); assert.equal(lastBody().max_tokens, 2048, 'Default DeepSeek stays byte-for-byte compatible in output settings');
  await select(ds, 'off'); await callLLM({ ...request, thinkingMode: 'enabled' });
  assert.equal(lastBody().thinking?.type, 'disabled'); assert.equal(lastBody().reasoning_effort, undefined); assert.equal(lastBody().max_tokens, 2048);
  assert.equal(ipc.at(-1)?.timeoutMs, undefined, 'A genuine off setting preserves the old synchronous deadline');
  for (const [preference, effort] of [['low', 'low'], ['medium', 'high'], ['high', 'max']] as const) {
    await select(ds, preference); await callLLM(request);
    assert.equal(lastBody().thinking?.type, 'enabled'); assert.equal(lastBody().reasoning_effort, effort);
    assert.ok(lastBody().max_tokens > 2048, 'Manual DeepSeek reasoning gets bounded room without changing its default behavior');
    const expectedBudget = lastBody().max_tokens;
    await drain(await callLLMStream(request, { maxTokens: 2048, outputSchema: null }));
    assert.equal(lastBody().reasoning_effort, effort); assert.equal(lastBody().max_tokens, expectedBudget);
  }
  const oldDs = { ...ds, id: 'old-ds-alias', selectedModel: 'deepseek-chat', models: ['deepseek-chat'] };
  await select(oldDs, 'medium'); await callLLM(request);
  assert.equal(lastBody().thinking?.type, 'enabled'); assert.equal(lastBody().reasoning_effort, undefined, 'Older DeepSeek aliases fall back to their documented switch rather than inventing effort levels');
  await select(oldDs, 'off'); await callLLM({ ...request, thinkingMode: 'enabled' });
  assert.equal(lastBody().thinking?.type, 'disabled');

  const glm52 = { ...glm, id: 'thinking-glm52', selectedModel: 'glm-5.2', models: ['glm-5.2'] };
  for (const [preference, effort] of [['low', 'high'], ['medium', 'high'], ['high', 'max']] as const) {
    await select(glm52, preference); await callLLM(request);
    assert.equal(lastBody().thinking?.type, 'enabled'); assert.equal(lastBody().reasoning_effort, effort, 'Missing GLM-5.2 levels map to an available neighboring effort');
  }
  await select(glm52, 'off'); await callLLM({ ...request, thinkingMode: 'enabled' });
  assert.equal(lastBody().thinking?.type, 'disabled'); assert.equal(lastBody().reasoning_effort, undefined);
  const legacyGlm = { ...glm, id: 'thinking-glm47', selectedModel: 'glm-4.7', models: ['glm-4.7'] };
  await select(legacyGlm, 'high'); await callLLM(request);
  assert.equal(lastBody().thinking?.type, 'enabled'); assert.equal(lastBody().reasoning_effort, undefined, 'An on/off-only model does not get invented effort values');
  await select(legacyGlm, 'off'); await callLLM({ ...request, thinkingMode: 'enabled' });
  assert.equal(lastBody().thinking?.type, 'disabled');

  const unknown = { ...glm, id: 'unknown-gateway', baseUrl: 'https://gateway.synthetic.invalid/v1' };
  await select(unknown, 'high'); await callLLM(request);
  assert.equal(lastBody().thinking, undefined); assert.equal(lastBody().reasoning_effort, undefined); assert.equal(lastBody().max_tokens, 2048, 'Unsupported gateways receive no invented reasoning parameters');
  for (const provider of [
    { ...glm, id: 'thinking-anthropic', apiType: 'anthropic' as const, baseUrl: 'https://api.anthropic.com/v1', selectedModel: 'claude-sonnet-4-6', models: ['claude-sonnet-4-6'] },
    { ...glm, id: 'thinking-gemini', apiType: 'gemini' as const, baseUrl: 'https://generativelanguage.googleapis.com/v1beta', selectedModel: 'gemini-2.5-flash', models: ['gemini-2.5-flash'] },
    { ...glm, id: 'thinking-ollama', apiType: 'ollama' as const, baseUrl: 'http://127.0.0.1:11434', selectedModel: 'qwen3', models: ['qwen3'] },
  ]) {
    await select(provider, 'default'); const baseline = await callLLM(request); noLeak(baseline);
    const baselineBody = structuredClone(lastBody());
    await select(provider, 'high'); const manual = await callLLM(request); noLeak(manual);
    assert.deepEqual(lastBody(), baselineBody, 'An unimplemented protocol does not silently claim to apply a manual tier');
    assert.equal(lastBody().thinking, undefined); assert.equal(lastBody().reasoning_effort, undefined); assert.equal(lastBody().think, undefined);
    assert.equal(lastBody().generationConfig?.thinkingConfig, undefined); assert.equal(lastBody().output_config, undefined);
    const chunks = await drain(await callLLMStream(request, { maxTokens: 2048, outputSchema: null })); noLeak(chunks);
    assert.equal(chunks.filter(chunk => chunk.type === 'content').map(chunk => chunk.text).join(''), 'Synthetic final response.');
  }
  await select(glm, 'default');
  await proxyLlmRequest({ provider: glm, systemPrompt: 'Synthetic direct host request.', userInput: 'Synthetic.', temperature: 0,
    maxTokens: 2048, thinkingMode: 'disabled', thinkingPreference: 'high' });
  assert.equal(lastBody().thinking?.type, 'enabled'); assert.equal(lastBody().reasoning_effort, 'max'); assert.ok(lastBody().max_tokens > 2048);
  await proxyLlmRequest({ provider: glm, systemPrompt: 'Synthetic fixed host request.', userInput: 'Synthetic.', temperature: 0,
    maxTokens: 8192, thinkingMode: 'enabled', thinkingPreference: 'default', tokenBudgetMode: 'total' });
  assert.equal(lastBody().max_tokens, 8192); assert.equal(lastBody().reasoning_effort, undefined);
  await proxyLlmRequest({ provider: ds, systemPrompt: 'Synthetic stale host effort.', userInput: 'Synthetic.', temperature: 0,
    maxTokens: 2048, thinkingMode: 'enabled', reasoningEffort: 'max', thinkingPreference: 'off', tokenBudgetMode: 'total' });
  assert.equal(lastBody().thinking?.type, 'disabled'); assert.equal(lastBody().reasoning_effort, undefined, 'An explicit supported off setting clears a stale effort rather than sending contradictory provider fields');
  await proxyLlmRequest({ provider: legacyGlm, systemPrompt: 'Synthetic legacy switch.', userInput: 'Synthetic.', temperature: 0,
    maxTokens: 2048, thinkingMode: 'disabled', reasoningEffort: 'max', thinkingPreference: 'high', tokenBudgetMode: 'total' });
  assert.equal(lastBody().thinking?.type, 'enabled'); assert.equal(lastBody().reasoning_effort, undefined, 'A switch-only mapping clears effort from a previous model');
  await Promise.all(tasks);
  assert.equal(inFlight.size, 0); assert.equal(listeners.chunk.size + listeners.end.size + listeners.error.size, 0, 'All stream listeners released');
  console.log(JSON.stringify({ status: 'passed', providerRequests: http.length, budgets, actualRendererAndMain: true,
    noReasoningLeak: true, noDoubleBudget: true, fixedTotalRetained: true, networkCalls: 0, realModelRequests: 0, realSettingsAccessed: false }));
} finally {
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window');
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage); else Reflect.deleteProperty(globalThis, 'localStorage');
}
