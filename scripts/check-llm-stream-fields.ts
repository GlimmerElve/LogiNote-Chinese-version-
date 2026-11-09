/** Actual stream services/provider builders; only IO is synthetic. No model,
 * credentials, real settings, notes or external network are accessed. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { proxyLlmRequest, streamLlmRequest } from '../src/electron/apiHandlers';
import { releaseLlmToolContinuations } from '../src/electron/llmToolContinuations';
import type { LlmCallRequest, LlmProvider, LlmSettings, LlmToolCall } from '../src/types';
import type { LlmIpcRequest, StreamChunkIpc } from '../src/electron/ipcTypes';

const glm: LlmProvider = { id: 'stream-glm-fixture', name: 'Synthetic GLM', apiType: 'openai-compatible',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: '', selectedModel: 'glm-5.3', models: ['glm-5.3'], enabled: true, createdAt: '' };
const deepseek: LlmProvider = { ...glm, id: 'stream-ds-fixture', name: 'Synthetic DeepSeek',
  baseUrl: 'https://api.deepseek.com/v1', selectedModel: 'deepseek-flash', models: ['deepseek-flash'] };
const ollama: LlmProvider = { ...glm, id: 'stream-ollama-fixture', apiType: 'ollama', baseUrl: 'http://127.0.0.1:11434', selectedModel: 'synthetic-local', models: ['synthetic-local'] };
const tools = [{ name: 'read_synthetic_material', description: 'Read only synthetic material.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'compare_synthetic_material', description: 'Compare synthetic items.', parameters: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] } }];
const toolCalls: LlmToolCall[] = [{ id: 'call-read', name: tools[0].name, arguments: { id: '心理账户🙂' } },
  { id: 'call-compare', name: tools[1].name, arguments: { count: 2 } }];
const secret = 'PRIVATE_STREAM_REASONING_MUST_STAY_MAIN_14820';
const owner = { ownerId: 'stream-fixture-owner' };
let settings: LlmSettings = { providers: [deepseek], defaultProviderId: deepseek.id, workflowBinding: {} };
const memory = new Map([['loginote_llm_settings', JSON.stringify(settings)]]);
const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), oldFetch = globalThis.fetch;
const listeners = { chunk: new Set<(value: any) => void>(), end: new Set<(value: any) => void>(), error: new Set<(value: any) => void>() };
const active = new Map<string, AbortController>(); const pending: Promise<void>[] = [];
const http: Array<{ body: any; headers: any; url: string }> = [], ipc: LlmIpcRequest[] = [], events: Array<{ streamId: string; chunk: StreamChunkIpc }> = [];
let sequence = 0, held: ReadableStreamDefaultController<Uint8Array> | undefined;
type Scenario = { kind: 'content' | 'tools' | 'invalid' | 'length' | 'hold' | 'unfinished' | 'filtered'; protocol?: 'ollama'; json?: unknown; raw?: string; reasoning?: string; content?: string; foreignChoice?: boolean };
let scenario: Scenario = { kind: 'content' };
const checks: string[] = [];
const send = (name: keyof typeof listeners, value: any) => { for (const listener of listeners[name]) listener(value); };
const subscribe = (name: keyof typeof listeners, listener: (value: any) => void) => { listeners[name].add(listener); return () => listeners[name].delete(listener); };
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key) } });
Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: {
  userState: { loadLlm: async () => structuredClone(settings), saveLlm: async (value: LlmSettings) => { settings = structuredClone(value); } },
  llm: {
    request: (request: LlmIpcRequest) => proxyLlmRequest(request, undefined, owner),
    stream: async (request: LlmIpcRequest) => {
      assert.equal(settings.providers.find(provider => provider.id === request.provider.id)?.enabled, true);
      ipc.push(structuredClone(request)); const id = `stream-fields-${++sequence}`, controller = new AbortController(); active.set(id, controller);
      pending.push(new Promise<void>(resolve => setImmediate(async () => {
        try {
          const diagnostics = await (streamLlmRequest as any)(request, (chunk: StreamChunkIpc) => { events.push({ streamId: id, chunk }); send('chunk', { streamId: id, chunk }); }, controller.signal, owner);
          if (diagnostics) { const chunk = { type: 'diagnostics' as const, text: '', diagnostics }; events.push({ streamId: id, chunk }); send('chunk', { streamId: id, chunk }); }
          send('end', { streamId: id });
        } catch (error) { send('error', { streamId: id, message: (error as Error).message, cancelled: controller.signal.aborted }); }
        finally { active.delete(id); resolve(); }
      })));
      return id;
    },
    cancel: async (id: string) => { active.get(id)?.abort(); return true; },
    onChunk: (listener: (value: any) => void) => subscribe('chunk', listener), onEnd: (listener: (value: any) => void) => subscribe('end', listener),
    onError: (listener: (value: any) => void) => subscribe('error', listener),
  },
} } });
const responseEvents = (current: Scenario): any[] => {
  if (current.protocol === 'ollama') return [{ model: 'synthetic-local', message: { content: current.content || 'Local preface.', ...(current.reasoning !== undefined ? { thinking: current.reasoning } : {}) } },
    ...(current.kind === 'tools' ? [{ message: { tool_calls: toolCalls.map(call => ({ id: call.id, function: { name: call.name, arguments: call.arguments } })) } }] : []),
    { done: true, done_reason: current.kind === 'tools' ? 'tool_calls' : 'stop' }];
  const output: any[] = [];
  if (current.foreignChoice) output.push({ choices: [{ index: 1, delta: { content: 'MUST_SKIP_OTHER_CHOICE',
    tool_calls: [{ index: 0, id: 'must-skip-call', type: 'function', function: { name: 'must_skip_other_choice', arguments: '{}' } }] }, finish_reason: 'length' }] });
  if (current.reasoning !== undefined) output.push({ choices: [{ delta: { reasoning_content: current.reasoning } }] });
  output.push({ model: 'synthetic-response', choices: [{ delta: { content: current.content || 'Readable preface 心理🙂。' } }] });
  if (['tools', 'invalid', 'length', 'unfinished', 'filtered'].includes(current.kind)) {
    output.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-read', type: 'function', function: { name: 'read_synthetic_', arguments: '{"id":' } }] } }] });
    output.push({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'call-compare', type: 'function', function: { name: tools[1].name, arguments: '{"count":' } }] } }] });
    output.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'material', arguments: '"心理账户🙂"}' } }, { index: 1, function: { arguments: current.kind === 'invalid' || current.kind === 'length' ? 'BROKEN' : '2}' } }] } }] });
  }
  if (current.kind === 'unfinished') return output;
  output.push({ choices: [{ delta: {}, finish_reason: current.kind === 'length' ? 'length' : current.kind === 'filtered' ? 'content_filter' : current.kind === 'content' || current.kind === 'hold' ? 'stop' : 'tool_calls' }],
    usage: { completion_tokens_details: { reasoning_tokens: 19 } } });
  return output;
};
globalThis.fetch = (async (url: any, init: any) => {
  assert.equal(init?.method, 'POST', 'No unplanned external IO is permitted');
  const body = JSON.parse(init.body), current = structuredClone(scenario); http.push({ body, headers: init.headers, url: String(url) });
  if (!body.stream) return new Response(JSON.stringify(current.json || { model: body.model,
    choices: [{ message: { content: current.content || 'Synthetic synchronous output.' }, finish_reason: 'stop' }] }), { status: 200 });
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    init.signal.addEventListener('abort', () => controller.error(new DOMException('Synthetic body cancelled', 'AbortError')), { once: true });
    const encoder = new TextEncoder();
    if (current.kind === 'hold') { held = controller; controller.enqueue(encoder.encode('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Saved prefix.' } }] }) + '\n\n')); return; }
    const raw = current.raw ?? (responseEvents(current).map(event => current.protocol === 'ollama' ? JSON.stringify(event) + '\n' : 'data: ' + JSON.stringify(event) + '\n\n').join('')
      + (current.protocol === 'ollama' || current.kind === 'unfinished' ? '' : 'data: [DONE]\n\n')
      + (current.foreignChoice ? 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'MUST_SKIP_AFTER_DONE' } }] }) + '\n\n' : ''));
    const bytes = encoder.encode(raw);
    // Split both event JSON and multibyte UTF-8 sequences at transport boundaries.
    for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.slice(offset, offset + 7));
    controller.close();
  } });
  return new Response(stream, { status: 200, headers: { 'Content-Type': current.protocol === 'ollama' ? 'application/x-ndjson' : 'text/event-stream' } });
}) as typeof fetch;

try {
  const storage = await import('../src/services/llmStorage');
  const { callLLMStream, collectStreamResponse } = await import('../src/services/llmStreamService');
  await storage.ensureLlmSettingsLoaded();
  const select = async (provider: LlmProvider, preference?: 'default' | 'off' | 'low' | 'medium' | 'high') => storage.saveLlmSettings({ providers: [provider], defaultProviderId: provider.id,
    workflowBinding: {}, ...(preference ? { workflowThinking: { 'scene-role-reply': preference } } : {}) });
  const base: LlmCallRequest = { providerId: '', model: '', workflow: 'scene-role-reply', systemPromptOverride: 'Synthetic system.', userInput: 'Current user input.',
    thinkingMode: 'disabled', skipMemoryInjection: true, skipProfileInjection: true };
  const run = async (request: LlmCallRequest = base, options: any = {}) => collectStreamResponse(await callLLMStream(request,
    { outputSchema: { type: 'object' }, maxTokens: 2048, temperature: 0.2, ...options })) as Promise<any>;
  const noLeak = (value: unknown) => assert.ok(!JSON.stringify(value).includes(secret), 'Raw provider reasoning must not cross the renderer boundary');
  const last = () => http.at(-1)!.body;

  await select(deepseek, 'default'); scenario = { kind: 'tools', foreignChoice: true };
  const history = [{ role: 'user' as const, content: 'Earlier question.' }, { role: 'assistant' as const, content: 'Earlier answer.' }];
  const first = await run({ ...base, messages: history, tools });
  assert.deepEqual(last().messages.map((message: any) => [message.role, message.content]), [
    ['system', last().messages[0].content], ['user', 'Earlier question.'], ['assistant', 'Earlier answer.'], ['user', base.userInput],
  ]);
  assert.deepEqual(last().tools.map((tool: any) => tool.function.name), tools.map(tool => tool.name)); assert.equal(last().tool_choice, 'auto');
  assert.deepEqual(last().response_format, { type: 'json_object' }); assert.equal(last().stream, true);
  assert.deepEqual(first.toolCalls, toolCalls); assert.equal(first.diagnostics?.finishReason, 'tool_calls');
  assert.equal(first.content, 'Readable preface 心理🙂。'); assert.ok(!first.content.includes('call-read'));
  const plainStreamBody = structuredClone(last()); delete plainStreamBody.stream;
  await proxyLlmRequest(ipc.at(-1)!, undefined, owner);
  assert.deepEqual(last(), plainStreamBody, 'Sync and stream must share the same request builder aside from the transport flag');
  checks.push('OpenAI stream forwards ordered history, tool definitions and JSON format, and assembles interleaved tool/name/argument fragments after UTF-8 packet splitting');

  scenario = { kind: 'content' };
  const transcript = [{ role: 'user' as const, content: 'Only authoritative transcript.' },
    { role: 'assistant' as const, content: '', toolCalls },
    ...toolCalls.map(call => ({ role: 'tool' as const, content: 'Completed result ' + call.id, toolCallId: call.id }))];
  await run({ ...base, userInput: 'DO_NOT_APPEND_USER_INPUT', messages: [{ role: 'user', content: 'DO_NOT_USE_PLAIN_HISTORY' }], agentMessages: transcript, tools });
  assert.ok(!JSON.stringify(last().messages).includes('DO_NOT_'));
  assert.equal(last().messages.filter((message: any) => message.role === 'tool').length, 2);
  assert.equal(last().messages[2].tool_calls[0].id, 'call-read');
  const agentStreamBody = structuredClone(last()); delete agentStreamBody.stream;
  await proxyLlmRequest(ipc.at(-1)!, undefined, owner);
  assert.deepEqual(last(), agentStreamBody, 'Complete tool-call/result history must be identical across sync and streaming HTTP builders');
  checks.push('Complete Agent transcript has precedence over plain history and separate userInput, preserving tool-call/result identities without duplicate inputs');

  await select(glm, 'high'); scenario = { kind: 'tools', reasoning: secret };
  const reasoningReply = await run({ ...base, tools }, { includeActivity: true });
  assert.equal(last().thinking.type, 'enabled'); assert.equal(last().reasoning_effort, 'max'); assert.equal(last().max_tokens, 10240);
  assert.equal(ipc.at(-1)?.tokenBudgetMode, 'total'); assert.ok(reasoningReply.toolContinuationId); noLeak(reasoningReply); noLeak(events);
  scenario = { kind: 'content', reasoning: secret + '_final' };
  const next = await run({ ...base, tools, agentMessages: [{ role: 'user', content: base.userInput },
    { role: 'assistant', content: reasoningReply.content, toolCalls: reasoningReply.toolCalls, toolContinuationId: reasoningReply.toolContinuationId },
    ...toolCalls.map(call => ({ role: 'tool' as const, content: 'Actual tool result.', toolCallId: call.id }))] });
  assert.equal(last().messages.find((message: any) => message.role === 'assistant').reasoning_content, secret);
  assert.ok(next.toolContinuationId); noLeak(next);
  const activity = events.filter(event => event.streamId === `stream-fields-${sequence - 1}` && event.chunk.type === 'activity');
  assert.deepEqual(activity.map(event => event.chunk.activity?.phase), ['reasoning', 'responding']);
  assert.ok(activity.every(event => event.chunk.text === ''));
  checks.push('GLM manual high, bounded output budget, diagnostics and private reasoning continuation survive actual streaming; only opaque identifiers reach the renderer');

  scenario = { kind: 'content' };
  await run({ ...base, thinkingPreference: 'default', tokenBudgetMode: 'total' });
  assert.equal(last().reasoning_effort, 'low'); assert.equal(last().max_tokens, 2048);
  const withoutTools = await run(base, { outputSchema: null }); assert.equal(last().response_format, undefined); assert.equal(last().tools, undefined);
  assert.equal(withoutTools.toolCalls, undefined);
  checks.push('Explicit default/fixed approval budgets bypass new UI overrides; ordinary text streams retain their content-only behavior and may opt out of JSON mode');

  for (const kind of ['invalid', 'length', 'unfinished', 'filtered'] as const) {
    scenario = { kind };
    const before = http.length; let result: any, failed = false;
    try { result = await run({ ...base, tools }); }
    catch (error) { failed = true; assert.ok(error instanceof Error && error.message.length > 0); }
    if (!failed) assert.ok(!result.toolCalls?.length, 'Unparseable/truncated arguments cannot become executable tool calls');
    assert.equal(http.length, before + 1, 'Malformed output must not silently spend another request');
  }
  checks.push('Malformed/truncated/unterminated/filtered tool streams never publish executable calls or silently spend another request');

  for (const raw of ['data: {"choices":[BROKEN}\n\ndata: [DONE]\n\n',
    'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'undeclared-call', type: 'function',
      function: { name: 'never_declared_operation', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }) + '\n\ndata: [DONE]\n\n']) {
    scenario = { kind: 'content', raw }; const before = http.length;
    await assert.rejects(run({ ...base, tools }), /工具|完整/u);
    assert.equal(http.length, before + 1);
    assert.ok(!events.some(event => event.streamId === `stream-fields-${sequence}` && event.chunk.type === 'response'),
      'Corrupt envelopes and undeclared tools must never publish a response metadata event');
  }
  checks.push('A declared-tool stream fails safely even when the corrupt JSON hides every tool delta; undeclared operation names are rejected before publication');

  await select(ollama); scenario = { kind: 'tools', protocol: 'ollama' };
  const local = await run({ ...base, messages: history, tools });
  assert.equal(last().messages.length, 4); assert.equal(last().messages[1].content, history[0].content);
  assert.deepEqual(local.toolCalls, toolCalls); assert.equal(local.content, 'Local preface.');
  assert.equal(last().format, 'json');
  const localStreamBody = structuredClone(last()); delete localStreamBody.stream;
  const localIpc = ipc.at(-1)!; scenario = { kind: 'content', protocol: 'ollama', json: { message: { content: 'Local sync.', tool_calls: toolCalls.map(call => ({ id: call.id, function: { name: call.name, arguments: call.arguments } })) }, done_reason: 'stop' } };
  await proxyLlmRequest(localIpc, undefined, owner); const localSyncBody = structuredClone(last()); delete localSyncBody.stream;
  assert.deepEqual(localSyncBody, localStreamBody, 'Native Ollama history/tools/JSON options must match across transports');
  scenario = { kind: 'tools', protocol: 'ollama', reasoning: secret };
  const localReasoning = await run({ ...base, tools }); assert.ok(localReasoning.toolContinuationId); noLeak(localReasoning);
  scenario = { kind: 'content', protocol: 'ollama', reasoning: secret + '_local_final' };
  const localFollow = await run({ ...base, tools, agentMessages: [{ role: 'user', content: base.userInput },
    { role: 'assistant', content: localReasoning.content, toolCalls: localReasoning.toolCalls, toolContinuationId: localReasoning.toolContinuationId },
    ...toolCalls.map(call => ({ role: 'tool' as const, content: 'Actual local tool result.', toolCallId: call.id, toolName: call.name }))] });
  const localAssistant = last().messages.find((message: any) => message.role === 'assistant');
  assert.equal(localAssistant.thinking, secret); assert.deepEqual(localAssistant.tool_calls[0].function.arguments, toolCalls[0].arguments);
  assert.equal(last().messages.find((message: any) => message.role === 'tool').tool_name, toolCalls[0].name);
  assert.ok(localFollow.toolContinuationId); noLeak(localFollow); noLeak(events);
  checks.push('Ollama NDJSON and sync share native history/tools/options, return object-form arguments and continue private native thinking without exposing it as prose');

  for (const apiType of ['anthropic', 'gemini'] as const) {
    const alternative = { ...glm, id: 'fallback-' + apiType, apiType, baseUrl: 'https://synthetic.invalid', selectedModel: 'synthetic-model', models: ['synthetic-model'] };
    await select(alternative);
    scenario = { kind: 'tools', json: apiType === 'anthropic'
      ? { content: [{ type: 'text', text: 'Fallback text.' }, { type: 'tool_use', id: toolCalls[0].id, name: tools[0].name, input: toolCalls[0].arguments }], stop_reason: 'tool_use' }
      : { candidates: [{ content: { parts: [{ text: 'Fallback text.' }, { functionCall: { id: toolCalls[0].id, name: tools[0].name, args: toolCalls[0].arguments } }] }, finishReason: 'STOP' }] } };
    const fallback = await run({ ...base, tools, messages: history });
    assert.equal(fallback.content, 'Fallback text.'); assert.deepEqual(fallback.toolCalls, [toolCalls[0]]);
    assert.equal(last().stream, undefined, 'Non-streaming provider fallback retains its protocol');
    const mixed = structuredClone(scenario.json) as any;
    if (apiType === 'anthropic') mixed.content.push({ type: 'tool_use', id: 'nameless-operation', input: {} });
    else mixed.candidates[0].content.parts.push({ functionCall: { id: 'nameless-operation', args: {} } });
    scenario = { kind: 'tools', json: mixed }; const beforeMixed = http.length;
    await assert.rejects(run({ ...base, tools, messages: history }), /工具|完整/u);
    assert.equal(http.length, beforeMixed + 1);
    assert.ok(!events.some(event => event.streamId === `stream-fields-${sequence}` && event.chunk.type === 'response'),
      'One valid prefix cannot conceal a malformed second tool in an atomic fallback');
    const unsafe = structuredClone(mixed) as any;
    if (apiType === 'anthropic') unsafe.content.pop();
    else unsafe.candidates[0].content.parts.pop();
    if (apiType === 'anthropic') unsafe.stop_reason = 'unexpected_terminal';
    else unsafe.candidates[0].finishReason = 'UNRECOGNIZED_TERMINAL';
    scenario = { kind: 'tools', json: unsafe };
    const blockedFallback = await run({ ...base, tools, messages: history });
    assert.equal(blockedFallback.content, 'Fallback text.'); assert.equal(blockedFallback.toolCalls, undefined);
    assert.ok(blockedFallback.diagnostics?.finishReason?.includes(apiType === 'anthropic' ? 'unexpected' : 'UNRECOGNIZED'));
  }
  checks.push('Anthropic tool_use and Gemini STOP fallbacks preserve complete tools; a nameless second tool rejects the entire packet; unknown termination reasons retain prose/diagnostics without tools');

  await select(deepseek, 'off'); scenario = { kind: 'hold' };
  const abort = new AbortController(); const stream = await callLLMStream(base, { signal: abort.signal, maxTokens: 2048 });
  const reader = stream.getReader(); assert.equal((await reader.read()).value?.text, 'Saved prefix.');
  abort.abort(); await assert.rejects(reader.read(), (error: any) => error.name === 'AbortError'); reader.releaseLock();
  await Promise.all(pending); assert.equal(active.size, 0); held = undefined;
  assert.equal(listeners.chunk.size + listeners.end.size + listeners.error.size, 0);
  checks.push('User cancellation retains delivered prose, aborts the actual synthetic transport immediately and cleans all subscriptions without publishing partial tool calls');

  releaseLlmToolContinuations(owner.ownerId);
  const root = await fs.mkdtemp(path.resolve('build/llm-stream-fields-'));
  const report = { passed: true, root, checks, httpFixtures: http.length, realModelRequests: 0, networkCalls: 0,
    realSettingsAccessed: false, rawReasoningReturned: false, listenersRemaining: 0 };
  await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const controller of active.values()) controller.abort();
  await Promise.all(pending); releaseLlmToolContinuations(owner.ownerId); globalThis.fetch = oldFetch;
  if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow); else Reflect.deleteProperty(globalThis, 'window');
  if (oldStorage) Object.defineProperty(globalThis, 'localStorage', oldStorage); else Reflect.deleteProperty(globalThis, 'localStorage');
}
