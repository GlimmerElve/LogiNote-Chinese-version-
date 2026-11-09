/** Actual provider round trips and bounded main-only continuation storage.
 * Fetch is synthetic; no real model, user-state, notes, credentials or network. */
import assert from 'node:assert/strict';
import { proxyLlmRequest } from '../src/electron/apiHandlers';
import { retainLlmToolContinuation, resolveLlmToolContinuation, releaseLlmToolContinuations } from '../src/electron/llmToolContinuations';
import type { LlmIpcRequest } from '../src/electron/ipcTypes';
import type { LlmConversationMessage, LlmToolCall } from '../src/types';
import type { AgentRuntimeContext } from '../src/services/agent/types';

const secret = 'PRIVATE_TOOL_REASONING_MAIN_ONLY_38274';
const provider = { id: 'continuation-fixture', apiType: 'openai-compatible' as const, baseUrl: 'https://api.deepseek.com/v1', apiKey: '',
  selectedModel: 'deepseek-flash', models: ['deepseek-flash'] };
const call: LlmToolCall = { id: 'synthetic-call-1', name: 'read_synthetic_material', arguments: { id: 'synthetic-material' } };
const request: LlmIpcRequest = { provider, systemPrompt: 'Synthetic teaching agent.', userInput: 'Read the synthetic material.',
  temperature: 0.1, maxTokens: 2048, thinkingMode: 'disabled', thinkingPreference: 'high', tools: [{ name: call.name,
    description: 'Read synthetic fixture.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } }] };
const owner = { ownerId: 'fixture-owner' }, other = { ownerId: 'other-window' };
const originalFetch = globalThis.fetch, originalNow = Date.now;
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const memory = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key),
} });
let returnTool = true, fetches = 0, providerReasoning: string | undefined = secret;
const sent: any[] = [];
globalThis.fetch = (async (_url: any, init: any) => {
  assert.equal(init.method, 'POST'); const body = JSON.parse(init.body); sent.push(body); fetches++;
  assert.equal(body.thinking.type, 'enabled'); assert.equal(body.reasoning_effort, 'max');
  return new Response(JSON.stringify({ model: provider.selectedModel, choices: [{ finish_reason: returnTool ? 'tool_calls' : 'stop',
    message: returnTool ? { content: '', reasoning_content: providerReasoning, tool_calls: [{ id: call.id, type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : { content: 'Synthetic grounded answer.', reasoning_content: providerReasoning === secret ? secret + '_final' : providerReasoning } }],
    usage: { prompt_tokens: 14, completion_tokens: 25, completion_tokens_details: { reasoning_tokens: 15 } } }), { status: 200 });
}) as typeof fetch;
const noLeak = (value: unknown) => assert.ok(!JSON.stringify(value).includes(secret));
const checks: string[] = [];
try {
  const first = await proxyLlmRequest(request, undefined, owner);
  assert.equal(first.content, ''); assert.deepEqual(first.toolCalls, [call]);
  assert.equal(typeof first.toolContinuationId, 'string'); assert.ok(first.toolContinuationId!.length >= 16); noLeak(first);
  const assistant: LlmConversationMessage = { role: 'assistant', content: '', toolCalls: first.toolCalls,
    toolContinuationId: first.toolContinuationId };
  const transcript: LlmConversationMessage[] = [{ role: 'user', content: request.userInput }, assistant,
    { role: 'tool', content: 'Synthetic material content.', toolCallId: call.id, toolName: call.name }];
  noLeak(transcript);
  returnTool = false;
  const second = await proxyLlmRequest({ ...request, agentMessages: transcript }, undefined, owner);
  assert.equal(sent[1].messages.find((message: any) => message.role === 'assistant').reasoning_content, secret,
    'The provider receives exactly the previous tool reasoning from main memory');
  assert.equal(sent[1].messages.find((message: any) => message.role === 'assistant').tool_calls[0].id, call.id,
    'A complete current-turn tool declaration is not dropped by history normalization');
  assert.ok(sent[1].messages.some((message: any) => message.role === 'tool' && message.tool_call_id === call.id && message.content === transcript[2].content),
    'Its actual current-turn tool result stays paired with the declaration');
  assert.equal(second.content, 'Synthetic grounded answer.'); assert.equal(typeof second.toolContinuationId, 'string'); assert.ok(second.toolContinuationId!.length >= 16); noLeak(second); noLeak(transcript);
  checks.push('Two actual provider builders continue a reasoning tool round using an opaque renderer handle; no raw reasoning crosses the response boundary');
  const completedHistory: LlmConversationMessage[] = [...transcript, { role: 'assistant', content: second.content, toolContinuationId: second.toolContinuationId }];
  const nextQuestion = { role: 'user' as const, content: 'Continue with a new synthetic question.' };
  const acrossTurns = await proxyLlmRequest({ ...request, agentMessages: [...completedHistory, nextQuestion] }, undefined, owner);
  const previousAssistantMessages = sent.at(-1).messages.filter((message: any) => message.role === 'assistant');
  assert.deepEqual(previousAssistantMessages.map((message: any) => message.reasoning_content), [secret, secret + '_final'],
    'A tools-enabled new user turn must also carry the previous final answer reasoning');
  assert.ok(acrossTurns.toolContinuationId); noLeak(acrossTurns);
  checks.push('A third tools-enabled request across user turns preserves both tool-call and final-answer reasoning solely inside the provider request');

  const failBeforeFetch = async (next: LlmIpcRequest, scope: { ownerId: string } | undefined) => {
    const before = fetches; await assert.rejects(proxyLlmRequest(next, undefined, scope), /接续已失效/u); assert.equal(fetches, before);
  };
  const completedFallback = async (next: LlmIpcRequest, scope: { ownerId: string }) => {
    const before = fetches;
    const response = await proxyLlmRequest(next, undefined, scope);
    assert.equal(fetches, before + 1, 'A history fallback uses the same one model request, not a hidden retry');
    const messages = sent.at(-1).messages;
    assert.ok(messages.every((message: any) => !['tool', 'assistant'].includes(message.role)), 'Unavailable completed history becomes read-only context rather than a broken provider assistant/tool exchange');
    assert.equal(messages.at(-1).content, nextQuestion.content, 'The current user question is retained exactly');
    assert.ok(JSON.stringify(messages).includes('Synthetic material content.') && JSON.stringify(messages).includes(second.content), 'The actual old tool result and final answer remain available as history data');
    noLeak(messages); noLeak(response);
  };
  await failBeforeFetch({ ...request, agentMessages: transcript }, other);
  await completedFallback({ ...request, agentMessages: [...completedHistory, nextQuestion] }, other);
  await completedFallback({ ...request, provider: { ...provider, selectedModel: 'deepseek-v4-pro', models: ['deepseek-v4-pro'] }, agentMessages: [...completedHistory, nextQuestion] }, owner);
  await failBeforeFetch({ ...request, agentMessages: transcript }, undefined);
  await failBeforeFetch({ ...request, provider: { ...provider, selectedModel: 'deepseek-v4-pro', models: ['deepseek-v4-pro'] }, agentMessages: transcript }, owner);
  await failBeforeFetch({ ...request, provider: { ...provider, baseUrl: 'https://api.deepseek.com/changed' }, agentMessages: transcript }, owner);
  await failBeforeFetch({ ...request, provider: { ...provider, apiKey: 'synthetic-changed-key' }, agentMessages: transcript }, owner);
  await failBeforeFetch({ ...request, agentMessages: [{ ...assistant, toolContinuationId: 'forged-handle' }, transcript[2]] }, owner);
  await failBeforeFetch({ ...request, agentMessages: [{ ...assistant, toolCalls: [{ ...call, id: 'forged-call-id' }] }, { ...transcript[2], toolCallId: 'forged-call-id' }] }, owner);
  await failBeforeFetch({ ...request, agentMessages: [{ ...assistant, toolCalls: [{ ...call, name: 'forged-tool-name' }] }, transcript[2]] }, owner);
  checks.push('Different window, missing owner, changed provider/model/key, forged handle and mismatched tool identity fail locally before HTTP');

  const hostRewrittenCall = { ...call, arguments: { id: 'host-constrained-synthetic-material' } };
  const rewritten = await proxyLlmRequest({ ...request, agentMessages: [transcript[0], { ...assistant, toolCalls: [hostRewrittenCall] }, transcript[2]] }, undefined, owner);
  const continuedAssistant = sent.at(-1).messages.find((message: any) => message.role === 'assistant');
  assert.equal(continuedAssistant.reasoning_content, secret);
  assert.deepEqual(JSON.parse(continuedAssistant.tool_calls[0].function.arguments), hostRewrittenCall.arguments); noLeak(rewritten);
  checks.push('A legitimate host constraint may rewrite arguments for the same declared tool identity without losing the provider continuation');

  releaseLlmToolContinuations(owner.ownerId);
  await failBeforeFetch({ ...request, agentMessages: transcript }, owner);
  await completedFallback({ ...request, agentMessages: [...completedHistory, nextQuestion] }, owner);
  await completedFallback({ ...request, agentMessages: [...completedHistory.map(({ toolContinuationId: _privateId, ...message }) => message), nextQuestion] }, owner);
  const orphanEmptyCall = { ...call, id: 'orphan-empty-not-executed', name: 'never_executed_empty_tool' };
  const orphanProposalCall = { ...call, id: 'orphan-proposal-not-executed', name: 'never_executed_proposal_tool' };
  const orphanProposal = '尚未执行的候选检查，仅保留为历史对话文字。';
  await completedFallback({ ...request, agentMessages: [...completedHistory,
    { role: 'assistant', content: '', toolCalls: [orphanEmptyCall], toolContinuationId: first.toolContinuationId },
    { role: 'assistant', content: orphanProposal, toolCalls: [orphanProposalCall], toolContinuationId: first.toolContinuationId },
    { role: 'tool', content: 'UNRELATED_ORPHAN_RESULT_NOT_EXECUTED', toolCallId: 'different-orphan-result-id', toolName: orphanProposalCall.name },
    nextQuestion] }, owner);
  const normalizedHistoryData = JSON.stringify(sent.at(-1).messages);
  assert.ok(normalizedHistoryData.includes(orphanProposal), 'A proposal may survive as ordinary conversation text');
  for (const unexecuted of [orphanEmptyCall.id, orphanEmptyCall.name, orphanProposalCall.id, orphanProposalCall.name, 'UNRELATED_ORPHAN_RESULT_NOT_EXECUTED']) {
    assert.ok(!normalizedHistoryData.includes(unexecuted), 'Read-only history must not claim unmatched declarations or unrelated tool payloads were executed');
  }
  checks.push('Expired history is normalized before conversion: orphan declarations and unmatched results are omitted, while a nonempty proposal remains plain dialogue and complete current-turn pairs are preserved');
  checks.push('Window/provider changes, released handles and legacy completed history use a read-only fallback for a new user turn, while invalid current-turn continuations still fail locally');

  let now = originalNow(); Date.now = () => now;
  const fresh = retainLlmToolContinuation(request, owner, secret, [call]); assert.ok(fresh);
  const freshAssistant = { ...assistant, toolContinuationId: fresh };
  assert.equal(resolveLlmToolContinuation(request, owner, freshAssistant), secret);
  now += 15 * 60_000 + 1;
  assert.throws(() => resolveLlmToolContinuation(request, owner, freshAssistant), /接续已失效/u);
  Date.now = originalNow;
  checks.push('The 15 minute lifetime expires without using a real wait or retaining data on disk');

  assert.ok(retainLlmToolContinuation(request, owner, secret, []), 'A tools-enabled final answer also needs its reasoning on subsequent provider requests');
  assert.equal(retainLlmToolContinuation({ ...request, tools: [] }, owner, secret, [call]), undefined);
  assert.equal(retainLlmToolContinuation(request, undefined, secret, [call]), undefined);
  assert.ok(retainLlmToolContinuation(request, owner, '', [call]), 'An explicitly empty provider reasoning field is still a valid protocol continuation');
  assert.equal(retainLlmToolContinuation(request, owner, undefined, [call]), undefined, 'An absent reasoning field is not fabricated');
  const nativeRequest: LlmIpcRequest = { ...request, thinkingMode: undefined, thinkingPreference: 'default',
    provider: { ...provider, apiType: 'ollama', baseUrl: 'http://127.0.0.1:11434', selectedModel: 'qwen3', models: ['qwen3'] } };
  const nativeHandle = retainLlmToolContinuation(nativeRequest, owner, secret, [call]);
  assert.ok(nativeHandle, 'Native Ollama reasoning uses the same private bounded continuation store');
  assert.equal(resolveLlmToolContinuation(nativeRequest, owner, { role: 'assistant', content: '', toolCalls: [call], toolContinuationId: nativeHandle }), secret);
  assert.throws(() => retainLlmToolContinuation(request, owner, 'x'.repeat(1024 * 1024 + 1), [call]), /本地上限/u);
  assert.throws(() => retainLlmToolContinuation(request, owner, secret, Array.from({ length: 257 }, (_unused, index) => ({ ...call, id: String(index) }))), /本地上限/u);
  let oldest = '', newest = '';
  for (let index = 0; index < 129; index++) { newest = retainLlmToolContinuation(request, owner, secret, [call])!; if (!index) oldest = newest; }
  assert.throws(() => resolveLlmToolContinuation(request, owner, { ...assistant, toolContinuationId: oldest }), /接续已失效/u);
  assert.equal(resolveLlmToolContinuation(request, owner, { ...assistant, toolContinuationId: newest }), secret);
  checks.push('No tools declaration/no owner/absent reasoning stores nothing; explicit empty reasoning and per-item size, tool count and 128-entry bounds are handled correctly');

  const deepseekFetch = globalThis.fetch;
  let nativeTurn = 0;
  const nativeBodies: any[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    assert.equal(String(url), 'http://127.0.0.1:11434/api/chat');
    assert.equal(init.method, 'POST');
    const body = JSON.parse(init.body); nativeBodies.push(body); fetches++;
    assert.equal(body.model, 'qwen3');
    return new Response(JSON.stringify({ model: 'qwen3', done: true, done_reason: 'stop',
      message: nativeTurn++ === 0 ? { role: 'assistant', content: '', thinking: secret + '_ollama',
        tool_calls: [{ function: { name: call.name, arguments: call.arguments } }] }
        : { role: 'assistant', content: 'Native synthetic grounded answer.', thinking: secret + '_ollama_final' } }), { status: 200 });
  }) as typeof fetch;
  try {
    const nativeFirst = await proxyLlmRequest(nativeRequest, undefined, owner);
    assert.ok(nativeFirst.toolContinuationId && nativeFirst.toolCalls?.length === 1); noLeak(nativeFirst);
    assert.equal(nativeFirst.toolCalls[0].name, call.name); assert.deepEqual(nativeFirst.toolCalls[0].arguments, call.arguments);
    const nativeSecond = await proxyLlmRequest({ ...nativeRequest, agentMessages: [
      { role: 'user', content: nativeRequest.userInput },
      { role: 'assistant', content: '', toolCalls: nativeFirst.toolCalls, toolContinuationId: nativeFirst.toolContinuationId },
      { role: 'tool', content: 'Native synthetic material content.', toolCallId: nativeFirst.toolCalls[0].id, toolName: 'untrusted-client-tool-name' },
    ] }, undefined, owner);
    const nativeAssistant = nativeBodies[1].messages.find((message: any) => message.role === 'assistant');
    const nativeResult = nativeBodies[1].messages.find((message: any) => message.role === 'tool');
    assert.equal(nativeAssistant.thinking, secret + '_ollama');
    assert.equal(nativeAssistant.reasoning_content, undefined, 'Native Ollama uses thinking rather than an OpenAI-only field');
    assert.deepEqual(nativeAssistant.tool_calls[0].function.arguments, call.arguments, 'Native tool arguments stay objects');
    assert.equal(nativeResult.tool_name, call.name, 'The declared assistant tool determines the native result name');
    assert.equal(nativeResult.tool_call_id, undefined, 'OpenAI-only result identifiers are not sent to Ollama');
    assert.equal(nativeSecond.content, 'Native synthetic grounded answer.'); assert.ok(nativeSecond.toolContinuationId); noLeak(nativeSecond);
    checks.push('Native Ollama round trips retain private thinking, object tool arguments and authoritative tool_name without OpenAI-only result fields');
  } finally { globalThis.fetch = deepseekFetch; }

  providerReasoning = ''; returnTool = true;
  const emptyFirst = await proxyLlmRequest(request, undefined, owner); assert.ok(emptyFirst.toolContinuationId);
  returnTool = false;
  const emptySecond = await proxyLlmRequest({ ...request, agentMessages: [transcript[0], { role: 'assistant', content: '', toolCalls: [call], toolContinuationId: emptyFirst.toolContinuationId }, transcript[2]] }, undefined, owner);
  assert.equal(sent.at(-1).messages.find((message: any) => message.role === 'assistant').reasoning_content, '', 'An explicit empty field is passed back accurately, not omitted or replaced with invented reasoning');
  assert.ok(emptySecond.toolContinuationId); noLeak(emptySecond); providerReasoning = secret;

  const noToolResponse = await proxyLlmRequest({ ...request, tools: [] }, undefined, owner);
  assert.equal(noToolResponse.toolContinuationId, undefined); noLeak(noToolResponse);

  const { runAgentTurn, trimQaConversationHistory } = await import('../src/services/agent/agentEngine');
  const { clearToolRegistryForTests, registerTool } = await import('../src/services/agent/toolRegistry');
  clearToolRegistryForTests();
  registerTool({ name: call.name, description: 'Read synthetic fixture.', parameters: request.tools![0].parameters,
    location: 'renderer', permission: 'readonly', execute: () => ({ content: 'Synthetic material content.' }) });
  let agentCalls = 0, agentLoopCalls = 0;
  returnTool = true;
  const agentHttpStart = sent.length;
  const role = { id: 'check', name: 'check', systemPrompt: 'Synthetic role.', memoryWorkflow: 'agent-chat' as const, allowedTools: [call.name] };
  const ctx = { getNotes: () => [], ensureDataFresh: async () => {}, navigate: () => {}, openNoteByTitle: () => false,
    enterLearningMode: () => false, getPlanDraftSession: () => null, getResourceDraftSession: () => null } as unknown as AgentRuntimeContext;
  const actualAgentCall = async (input: import('../src/types').LlmCallRequest) => {
    agentCalls++;
    if (input.workflow === 'agent-chat') agentLoopCalls++;
    if (agentCalls === 2) assert.ok(input.agentMessages?.some(message => message.role === 'assistant' && message.toolContinuationId),
      'The actual Agent loop must forward the opaque handle, not reconstruct a bare tool message');
    const response = await proxyLlmRequest({ ...request, systemPrompt: input.systemPromptOverride || request.systemPrompt, userInput: input.userInput,
      tools: input.tools, agentMessages: input.agentMessages }, undefined, owner);
    returnTool = false; return response;
  };
  const result = await runAgentTurn({ role,
    userText: 'test', history: [], memoryPrefixLoader: async () => '', enableMultiAgent: false,
    ctx, callLlm: actualAgentCall,
  });
  assert.equal(agentCalls, 2); assert.equal(result.reply, 'Synthetic grounded answer.');
  assert.equal(sent[agentHttpStart + 1].messages.find((message: any) => message.role === 'assistant').reasoning_content, secret);
  assert.ok(result.updatedHistory.some(message => message.role === 'assistant' && message.toolContinuationId));
  assert.ok(result.updatedHistory.at(-1)?.toolContinuationId, 'The actual final assistant history entry also carries the opaque continuation');
  noLeak(result); noLeak([...memory.values()]);
  const qaHistory = trimQaConversationHistory(result.updatedHistory);
  assert.ok(qaHistory.filter(message => message.role === 'assistant').every(message => message.toolContinuationId), 'QA history trimming retains opaque assistant continuation handles');
  const qaRoles = trimQaConversationHistory([{ role: 'user', content: 'Synthetic user.', toolContinuationId: 'not-user-authority' },
    { role: 'assistant', content: 'Synthetic answer.', toolContinuationId: 'opaque-assistant' }]);
  assert.equal(qaRoles[0].toolContinuationId, undefined); assert.equal(qaRoles[1].toolContinuationId, 'opaque-assistant');
  const previousToolCount = result.toolTrace.length;
  const nextTurn = await runAgentTurn({ role, userText: 'test', history: result.updatedHistory, ctx,
    memoryPrefixLoader: async () => '', enableMultiAgent: false, callLlm: actualAgentCall });
  assert.equal(agentLoopCalls, 3, 'Only one tool-loop model round is needed for the following user question');
  assert.ok(agentCalls <= 4, 'The normal optional intent-router call must not become a hidden retry loop');
  assert.equal(previousToolCount, 1); assert.equal(nextTurn.toolTrace.length, 0);
  const nextTurnAssistant = sent.at(-1).messages.filter((message: any) => message.role === 'assistant');
  assert.deepEqual(nextTurnAssistant.map((message: any) => message.reasoning_content), [secret, secret + '_final']);
  noLeak(nextTurn); noLeak([...memory.values()]);
  for (const empty of [false, true]) {
    const localOutcome = await runAgentTurn({ role, userText: 'test', history: result.updatedHistory, ctx,
      memoryPrefixLoader: async () => '', enableMultiAgent: false,
      callLlm: async () => ({ content: empty ? '' : 'Synthetic incomplete response.', toolContinuationId: 'opaque-not-a-success',
        ...(empty ? {} : { diagnostics: { finishReason: 'length' } }) }),
    });
    assert.equal(localOutcome.updatedHistory.at(-1)?.toolContinuationId, undefined,
      'An empty/truncated model response cannot attach its handle to a different locally generated reply');
    assert.ok(localOutcome.updatedHistory.some(message => message.role === 'assistant' && message.toolCalls?.length && message.toolContinuationId),
      'Earlier successful tool exchanges keep their own handles');
    noLeak(localOutcome);
  }
  clearToolRegistryForTests();
  checks.push('The actual runAgentTurn loop carries tool and final handles across a following user turn, preserves them through QA trimming, and keeps history/audit persistence free of raw reasoning without rerunning the tool');
  console.log(JSON.stringify({ status: 'passed', checks, fixtureHttpRequests: fetches, realModelRequests: 0, actualNetworkCalls: 0,
    rawReasoningReturned: false, realSettingsOrNotesAccessed: false }));
} finally {
  Date.now = originalNow; globalThis.fetch = originalFetch;
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage); else Reflect.deleteProperty(globalThis, 'localStorage');
  releaseLlmToolContinuations(owner.ownerId); releaseLlmToolContinuations(other.ownerId);
}
