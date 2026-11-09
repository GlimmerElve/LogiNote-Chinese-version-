import assert from 'node:assert/strict';
import type { LlmCallRequest, LlmProvider, LlmSettings } from '../src/types';
import type { LlmIpcRequest, StreamChunkIpc } from '../src/electron/ipcTypes';
import { proxyLlmRequest, streamLlmRequest, probeLlmRequest } from '../src/electron/apiHandlers';
import { fitSceneContextBudget, SceneContextBudgetError } from '../src/services/scene/sceneContextBudget';

// Actual renderer services, IPC request objects and main-process HTTP builders.
// Only the settings/IPC IO and fetch boundary are synthetic. No real model,
// API key, browser cache, user-state file or external network is accessed.
const glm: LlmProvider = { id: 'synthetic-glm', name: 'Synthetic GLM 5.3', apiType: 'openai-compatible',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: '', selectedModel: 'glm-5.3', models: ['glm-5.3'], enabled: true, createdAt: 'synthetic' };
const deepseek: LlmProvider = { ...glm, id: 'synthetic-deepseek', name: 'Synthetic DeepSeek', baseUrl: 'https://api.deepseek.com/v1', selectedModel: 'deepseek-chat', models: ['deepseek-chat'] };
let persisted: LlmSettings = { providers: [glm], defaultProviderId: glm.id, workflowBinding: {} };
const memory = new Map([['loginote_llm_settings', JSON.stringify(persisted)]]);
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const originalFetch = globalThis.fetch, originalSetTimeout = globalThis.setTimeout;
const http: Array<{ url: string; body: any }> = [], ipc: Array<{ kind: 'request' | 'stream'; request: LlmIpcRequest }> = [];
const timers: number[] = [], rawEvents: Array<{ streamId: string; chunk: StreamChunkIpc }> = [];
const sceneBudgets: Array<{ supplier: string; capacity: number; sentTotal: number; reserveReduced: boolean }> = [];
const reasoningSecret = 'RAW_REASONING_MUST_NEVER_REACH_RENDERER_7284';
const listeners = { chunk: new Set<(value: any) => void>(), end: new Set<(value: any) => void>(), error: new Set<(value: any) => void>() };
let sequence = 0, injectUnexpectedActivity = false;
const streamControllers = new Map<string, AbortController>();
const observedBridgeCalls: Promise<void>[] = [];
const dispatch = (request: LlmIpcRequest) => assert.equal(persisted.providers.find(provider => provider.id === request.provider.id)?.enabled, true, 'only synthetic enabled providers reach dispatch');
const send = (name: keyof typeof listeners, value: unknown) => listeners[name].forEach(listener => listener(value));
const subscribe = (name: keyof typeof listeners, listener: (value: any) => void) => { listeners[name].add(listener); return () => { listeners[name].delete(listener); }; };

Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key),
} });
Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: {
  userState: { loadLlm: async () => structuredClone(persisted), saveLlm: async (value: LlmSettings) => { persisted = structuredClone(value); } },
  llm: {
    request: async (request: LlmIpcRequest) => { dispatch(request); ipc.push({ kind: 'request', request: structuredClone(request) }); return proxyLlmRequest(request); },
    stream: async (request: LlmIpcRequest) => {
      dispatch(request); ipc.push({ kind: 'stream', request: structuredClone(request) });
      const streamId = `synthetic-stream-${++sequence}`, controller = new AbortController(); streamControllers.set(streamId, controller);
      // The desktop returns a stream ID before delivering chunks to preload.
      // Match that ordering so renderer listeners are installed first.
      observedBridgeCalls.push(new Promise<void>(resolve => setImmediate(async () => {
        try {
          const emit = (chunk: StreamChunkIpc) => { rawEvents.push({ streamId, chunk }); send('chunk', { streamId, chunk }); };
          if (injectUnexpectedActivity) emit({ type: 'activity', text: '', activity: { phase: 'reasoning' } });
          const diagnostics = await streamLlmRequest(request, emit, controller.signal);
          if (diagnostics) emit({ type: 'diagnostics', text: '', diagnostics });
          send('end', { streamId });
        } catch (error) { send('error', { streamId, message: (error as Error).message, cancelled: controller.signal.aborted }); }
        finally { streamControllers.delete(streamId); resolve(); }
      })));
      return streamId;
    },
    cancel: async (streamId: string) => { streamControllers.get(streamId)?.abort(); return true; },
    onChunk: (listener: (value: any) => void) => subscribe('chunk', listener),
    onEnd: (listener: (value: any) => void) => subscribe('end', listener),
    onError: (listener: (value: any) => void) => subscribe('error', listener),
  },
} } });
globalThis.setTimeout = ((callback: any, milliseconds?: number, ...args: any[]) => {
  if (typeof milliseconds === 'number') timers.push(milliseconds);
  return originalSetTimeout(callback, milliseconds, ...args);
}) as typeof setTimeout;
globalThis.fetch = (async (url: any, init: any) => {
  assert.equal(init?.method, 'POST', 'unexpected IO is forbidden');
  const body = JSON.parse(init.body); http.push({ url: String(url), body });
  if (!body.stream) return new Response(JSON.stringify({ model: body.model,
    choices: [{ message: { content: 'Synthetic final answer', reasoning_content: reasoningSecret }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 20, completion_tokens: 40, completion_tokens_details: { reasoning_tokens: 12 } } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const events = [
    { model: body.model, choices: [{ delta: { reasoning_content: reasoningSecret + '_one' } }] },
    { model: body.model, choices: [{ delta: { reasoning_content: reasoningSecret + '_two' } }] },
    { model: body.model, choices: [{ delta: { content: '@@LESSON\n合成教学正文。' } }] },
    { model: body.model, choices: [{ delta: { reasoning_content: reasoningSecret + '_late' } }] },
    { model: body.model, choices: [{ delta: { content: '\n继续正文。' } }] },
    { model: body.model, choices: [{ delta: {}, finish_reason: 'stop' }], usage: { completion_tokens: 40, completion_tokens_details: { reasoning_tokens: 12 } } },
  ];
  return new Response(new ReadableStream({ start(controller) {
    const encoder = new TextEncoder();
    for (const event of events) controller.enqueue(encoder.encode('data: ' + JSON.stringify(event) + '\n\n'));
    controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close();
  } }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}) as typeof fetch;

try {
  const storage = await import('../src/services/llmStorage');
  const { callLLM } = await import('../src/services/llmService');
  const { callLLMStream } = await import('../src/services/llmStreamService');
  const { progressiveGenerationRequest, streamProgressiveFirstPage } = await import('../src/services/progressiveLearning/generation');
  await storage.ensureLlmSettingsLoaded();
  const select = async (provider: LlmProvider) => { await storage.saveLlmSettings({ providers: [provider], defaultProviderId: provider.id, workflowBinding: {} }); };
  const baseRequest: LlmCallRequest = { providerId: '', model: '', workflow: 'textbook-chapter', systemPromptOverride: 'Synthetic system prompt',
    userInput: 'Synthetic input', thinkingMode: 'disabled', maxTokensOverride: 6500, temperatureOverride: 0.3, skipMemoryInjection: true, skipProfileInjection: true };
  const drain = async (stream: ReadableStream<any>) => { const reader = stream.getReader(), chunks: any[] = []; try {
    while (true) { const next = await reader.read(); if (next.done) break; chunks.push(next.value); }
  } finally { reader.releaseLock(); } return chunks; };
  const noReasoningLeak = (value: unknown) => assert.ok(!JSON.stringify(value).includes(reasoningSecret));
  const lastBody = () => http.at(-1)!.body;

  const course = { title: '合成简谐运动', plan: null, pages: [], sourcePackets: [], budget: { maxMainlinePages: 3, estimatedMinutes: 20, totalPageLimit: 5 },
    generation: { pageId: 'main-1', kind: 'mainline', mainlineIndex: 0 } } as any;
  const request = progressiveGenerationRequest(course);
  assert.equal(request.thinkingMode, 'disabled');
  const progressive = await drain(await streamProgressiveFirstPage(course, new AbortController().signal));
  assert.equal(lastBody().thinking.type, 'enabled'); assert.equal(lastBody().reasoning_effort, 'low');
  assert.equal(lastBody().max_tokens, 13000); assert.equal(lastBody().temperature, 0.3);
  const progressiveIpc = ipc.at(-1)!.request;
  assert.deepEqual(progressiveIpc.streamTimeout, { firstResponseMs: 180000, idleMs: 90000, totalMs: 600000 });
  assert.equal(progressiveIpc.includeActivity, true);
  assert.equal(progressiveIpc.maxTokens, 13000); assert.equal(progressiveIpc.tokenBudgetMode, 'total', 'a renderer-adapted budget cannot be expanded again in main');
  assert.deepEqual(progressive.filter(chunk => chunk.type === 'activity').map(chunk => chunk.activity.phase), ['reasoning', 'responding']);
  assert.ok(progressive.filter(chunk => chunk.type === 'activity').every(chunk => chunk.text === ''));
  assert.ok(timers.includes(180000) && timers.includes(90000) && timers.includes(600000), 'actual main transport uses scoped deadlines');
  noReasoningLeak(progressive); noReasoningLeak(rawEvents);

  const sync = await callLLM(request);
  assert.equal(lastBody().thinking.type, 'enabled'); assert.equal(lastBody().reasoning_effort, 'low'); assert.equal(lastBody().max_tokens, 13000); noReasoningLeak(sync);
  assert.equal(ipc.at(-1)!.request.maxTokens, 13000); assert.equal(ipc.at(-1)!.request.tokenBudgetMode, 'total');
  await callLLM({ ...baseRequest, thinkingMode: 'enabled' });
  assert.equal(lastBody().thinking.type, 'enabled'); assert.equal(lastBody().reasoning_effort, undefined, 'explicit enabled preserves official default max');
  const explicitStream = await drain(await callLLMStream({ ...baseRequest, thinkingMode: 'enabled' }, { maxTokens: 6500, outputSchema: null }));
  assert.equal(lastBody().thinking.type, 'enabled'); assert.equal(lastBody().reasoning_effort, undefined);
  assert.ok(explicitStream.every(chunk => chunk.type !== 'activity'), 'ordinary caller retains original content/diagnostics chunks');
  assert.equal(ipc.at(-1)!.request.includeActivity, undefined); assert.equal(ipc.at(-1)!.request.streamTimeout, undefined);
  noReasoningLeak(explicitStream);

  injectUnexpectedActivity = true;
  const defensive = await drain(await callLLMStream(baseRequest, { outputSchema: null })); injectUnexpectedActivity = false;
  assert.ok(defensive.every(chunk => chunk.type !== 'activity'), 'renderer rejects unexpected activity for non-opted-in callers'); noReasoningLeak(defensive);
  await callLLM({ ...baseRequest, thinkingMode: undefined }); assert.equal(lastBody().thinking.type, 'enabled'); assert.equal(lastBody().reasoning_effort, 'low'); assert.equal(lastBody().max_tokens, 13000);

  const ordinaryWorkflowBudgets = [
    ['concept-generation', 6144], ['question-answer', 4096], ['agent-chat', 8192], ['plan-generation', 20480],
  ] as const;
  for (const [workflow, expected] of ordinaryWorkflowBudgets) {
    const ordinary = { ...baseRequest, workflow, maxTokensOverride: undefined, thinkingMode: undefined };
    await callLLM(ordinary);
    assert.equal(lastBody().thinking.type, 'enabled'); assert.equal(lastBody().reasoning_effort, 'low');
    assert.equal(lastBody().max_tokens, expected, workflow + ': required reasoning gets bounded headroom');
    assert.equal(ipc.at(-1)!.request.tokenBudgetMode, 'total');
    await drain(await callLLMStream(ordinary, { outputSchema: null }));
    assert.equal(lastBody().max_tokens, expected, workflow + ': ordinary stream is adapted once too');
    assert.equal(lastBody().reasoning_effort, 'low');
  }
  const frozen = { ...baseRequest, tokenBudgetMode: 'total' as const, maxTokensOverride: 8192, thinkingMode: undefined };
  const frozenBytes = JSON.stringify(frozen);
  await callLLM(frozen); assert.equal(lastBody().max_tokens, 8192, 'approved totals and plan compatibility ceilings stay exact');
  await drain(await callLLMStream(frozen, { maxTokens: 8192, outputSchema: null })); assert.equal(lastBody().max_tokens, 8192);
  assert.equal(JSON.stringify(frozen), frozenBytes, 'transport adaptation never mutates a frozen request');
  const glmProbe = await probeLlmRequest({ provider: glm, systemPrompt: 'ignored', userInput: 'ignored', temperature: 1, maxTokens: 64 });
  assert.equal(glmProbe.ok, true); assert.equal(lastBody().max_tokens, 2048); assert.equal(lastBody().thinking.type, 'enabled'); assert.equal(lastBody().reasoning_effort, 'low');
  assert.ok(timers.includes(60000));

  const sceneRequest: LlmCallRequest = { ...baseRequest, workflow: 'scene-general-turn', maxTokensOverride: 2000,
    systemPromptOverride: 'Keep the protected scene and latest input unchanged.',
    userInput: JSON.stringify({ scene: { goal: 'Compare input and output', constraints: ['Keep the condition fixed'] }, latestUserInput: 'PROTECTED_CURRENT_INPUT' }) };
  const sceneOriginal = JSON.stringify(sceneRequest);
  for (const capacity of [16384, 4096]) {
    const sceneProvider = { ...glm, contextWindowTokens: capacity }; await select(sceneProvider);
    const baseFit = fitSceneContextBudget(sceneRequest, { provider: sceneProvider, systemPrompt: sceneRequest.systemPromptOverride, maxOutputTokens: 2000 });
    const response = await callLLM(sceneRequest);
    const diagnostic = response.diagnostics!.sceneContextBudget!;
    const expected = capacity === 4096 ? 2000 : 4048;
    assert.equal(lastBody().max_tokens, expected); assert.equal(diagnostic.outputReserveTokens, expected, 'reported scene reserve must match the actual HTTP total');
    assert.equal(lastBody().messages.at(-1).content, baseFit.request.userInput, 'reasoning headroom never removes necessary scene content');
    assert.equal(JSON.stringify(sceneRequest), sceneOriginal); assert.equal(diagnostic.droppedHistoryMessages, 0); assert.deepEqual(diagnostic.omittedContextIds, []);
    if (capacity === 4096) { assert.equal(diagnostic.requestedOutputTokens, 4048); assert.equal(diagnostic.repairOutputCapped, true); }
    sceneBudgets.push({ supplier: 'GLM', capacity, sentTotal: expected, reserveReduced: Boolean(diagnostic.repairOutputCapped) });
  }
  const invalidBefore = http.length, invalidIpcBefore = ipc.length;
  await select({ ...glm, contextWindowTokens: 4095 });
  await assert.rejects(callLLM(sceneRequest), error => error instanceof SceneContextBudgetError && error.code === 'invalid-context-window');
  await select({ ...glm, contextWindowTokens: 4096 });
  await assert.rejects(callLLM({ ...sceneRequest, sceneOptionalJsonFields: ['contract'] }), error => error instanceof SceneContextBudgetError && error.code === 'invalid-context-parts');
  assert.equal(http.length, invalidBefore); assert.equal(ipc.length, invalidIpcBefore, 'invalid scene declarations fail before IPC/HTTP, without paid retries');

  await select(deepseek);
  await callLLM(baseRequest); assert.equal(lastBody().thinking.type, 'disabled'); assert.equal(lastBody().reasoning_effort, undefined); assert.equal(lastBody().max_tokens, 6500);
  const dsStream = await drain(await callLLMStream(baseRequest, { outputSchema: null })); assert.equal(lastBody().thinking.type, 'disabled'); assert.equal(lastBody().reasoning_effort, undefined); noReasoningLeak(dsStream);
  await callLLM({ ...baseRequest, thinkingMode: 'enabled' }); assert.equal(lastBody().thinking.type, 'enabled'); assert.equal(lastBody().reasoning_effort, undefined);
  await callLLM({ ...baseRequest, thinkingMode: undefined }); assert.equal(lastBody().thinking, undefined); assert.equal(lastBody().reasoning_effort, undefined); assert.equal(lastBody().max_tokens, 6500);
  const dsProbe = await probeLlmRequest({ provider: deepseek, systemPrompt: 'ignored', userInput: 'ignored', temperature: 1, maxTokens: 6500 });
  assert.equal(dsProbe.ok, true); assert.equal(lastBody().max_tokens, 64); assert.equal(lastBody().thinking, undefined); assert.equal(lastBody().reasoning_effort, undefined); assert.ok(timers.includes(20000));
  await select({ ...deepseek, contextWindowTokens: 4096 });
  const dsScene = await callLLM(sceneRequest);
  assert.equal(lastBody().max_tokens, 2000); assert.equal(dsScene.diagnostics?.sceneContextBudget?.outputReserveTokens, 2000);
  assert.equal(dsScene.diagnostics?.sceneContextBudget?.repairOutputCapped, undefined); assert.equal(lastBody().messages.at(-1).content, sceneRequest.userInput);
  assert.equal(lastBody().thinking.type, 'disabled'); assert.equal(lastBody().reasoning_effort, undefined);
  sceneBudgets.push({ supplier: 'DeepSeek', capacity: 4096, sentTotal: 2000, reserveReduced: false });

  for (const other of [
    { ...glm, id: 'synthetic-other-version', selectedModel: 'glm-5.2', models: ['glm-5.2'] },
    { ...glm, id: 'synthetic-gateway', baseUrl: 'https://gateway.synthetic.invalid/v1' },
  ]) {
    await select(other); await callLLM(baseRequest); assert.equal(lastBody().thinking, undefined); assert.equal(lastBody().reasoning_effort, undefined);
    await drain(await callLLMStream(baseRequest, { outputSchema: null })); assert.equal(lastBody().thinking, undefined); assert.equal(lastBody().reasoning_effort, undefined);
  }

  const direct: LlmIpcRequest = { provider: glm, systemPrompt: 'Synthetic', userInput: 'Synthetic', temperature: 0.3, maxTokens: 12000, thinkingMode: 'disabled' };
  const directSync = await proxyLlmRequest(direct); assert.equal(lastBody().thinking.type, 'enabled'); assert.equal(lastBody().reasoning_effort, 'low'); noReasoningLeak(directSync);
  assert.equal(lastBody().max_tokens, 20192, 'main-only RAG requests also receive headroom');
  const directChunks: StreamChunkIpc[] = [];
  await streamLlmRequest({ ...direct, includeActivity: true }, chunk => directChunks.push(chunk));
  assert.equal(lastBody().thinking.type, 'enabled'); assert.equal(lastBody().reasoning_effort, 'low');
  assert.equal(lastBody().max_tokens, 20192);
  assert.deepEqual(directChunks.filter(chunk => chunk.type === 'activity').map(chunk => chunk.activity?.phase), ['reasoning', 'responding']); noReasoningLeak(directChunks);
  const legacyChunks: StreamChunkIpc[] = []; await streamLlmRequest(direct, chunk => legacyChunks.push(chunk));
  assert.ok(legacyChunks.every(chunk => chunk.type !== 'activity')); noReasoningLeak(legacyChunks);
  await proxyLlmRequest({ ...direct, tokenBudgetMode: 'total' }); assert.equal(lastBody().max_tokens, 12000);
  await streamLlmRequest({ ...direct, tokenBudgetMode: 'total' }, () => {}); assert.equal(lastBody().max_tokens, 12000);
  await Promise.all(observedBridgeCalls);
  assert.equal(streamControllers.size, 0); assert.equal(listeners.chunk.size + listeners.end.size + listeners.error.size, 0, 'all renderer subscriptions released');
  console.log(JSON.stringify({ status: 'passed', rendererSyncAndStream: true, directMainDefense: true, mockedHttpRequests: http.length,
    activity: 'opt-in phase only; raw reasoning never forwarded; old callers unchanged', progressiveTimeout: progressiveIpc.streamTimeout,
    glmBudgets: { progressiveResponse: 6500, progressiveTotal: 13000, directRagTotal: 20192, frozenTotal: 8192, probeTotal: 2048, ordinaryWorkflows: Object.fromEntries(ordinaryWorkflowBudgets) },
    sceneBudgets,
    networkCalls: 0, realModelRequests: 0, realSettingsAccessed: false }));
} finally {
  globalThis.fetch = originalFetch; globalThis.setTimeout = originalSetTimeout;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window');
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage); else Reflect.deleteProperty(globalThis, 'localStorage');
}
