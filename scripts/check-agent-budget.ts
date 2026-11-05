import assert from 'node:assert/strict';
import type { AgentRuntimeContext } from '../src/services/agent/types';
import { AGENT_ROLES, runAgentTurn, resolveAgentApproval, resumeAgentTurn } from '../src/services/agent/agentEngine';
import { bootstrapAgentRuntime } from '../src/services/agent/bootstrap';
import { registerTool } from '../src/services/agent/toolRegistry';
import { normalizeAgentToolCallLimit, resolveAgentExecutionPolicy, ABSOLUTE_MAX_AGENT_TOOL_CALLS } from '../src/services/agent/executionPolicy';
import { buildPersistentAgentCheckpoint } from '../src/services/agent/checkpointStore';
import { AgentRunFailure } from '../src/services/agent/runRecovery';
import { normalizeAppSettings } from '../src/services/storage';
import { serializeSettingsState, deserializeSettingsState } from '../src/services/userStateService';
import { applyCognitionMutation, emptyCognitionFile } from '../src/services/cognition/core';
import { runCognitionInquiry } from '../src/services/agent/cognitionInquiry';
import { registerDataTools } from '../src/services/agent/tools/dataTools';
import type { LlmCallRequest, LlmCallResponse } from '../src/types';

// Memory-only contexts and model transport. Never touch a vault, Electron or a paid model.
globalThis.fetch = async () => { throw Error('Live network forbidden'); };
const cache = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => cache.get(key) ?? null, setItem: (key: string, value: string) => cache.set(key, value), removeItem: (key: string) => cache.delete(key),
} });
bootstrapAgentRuntime(AGENT_ROLES.default);
let reads = 0, writes = 0, selected = 12;
registerTool({ name: 'query_learner_profile', description: 'synthetic read', permission: 'readonly', location: 'renderer',
  parameters: { type: 'object', properties: {} }, execute: () => ({ count: ++reads }) });
registerTool({ name: 'update_note', description: 'synthetic confirmed write', permission: 'write', location: 'renderer',
  parameters: { type: 'object', properties: {} }, execute: () => ({ saved: true, count: ++writes }) });
const ctx = { getNotes: () => [], getPlanDraftSession: () => null, getResourceDraftSession: () => null,
  ensureDataFresh: async () => {}, getAgentExecutionMode: () => 'standard', getAgentToolCallLimit: () => selected } as unknown as AgentRuntimeContext;
const base = { role: AGENT_ROLES.default, ctx, history: [], requestedSkillId: 'plan-planning', enableMultiAgent: false, memoryPrefixLoader: async () => '' };
let groups = 0;
const pass = (name: string) => { groups++; console.log(`PASS ${name}`); };
let seq = 0;
const read = () => ({ id: `budget-read-${++seq}`, name: 'query_learner_profile', arguments: {} });

for (const limit of [4, 6, 12, 24, 32, 48]) {
  const policy = resolveAgentExecutionPolicy('standard', 'personalized-textbook', limit);
  assert.equal(policy.maxToolCalls, limit);assert(policy.maxRounds >= limit);
}
assert.equal(resolveAgentExecutionPolicy('deep').maxToolCalls, 24);
for (const invalid of [0, 3, 49, -1, 4.5, NaN, Infinity, '48', null, {}]) assert.equal(normalizeAgentToolCallLimit(invalid), undefined);
pass('4～48严格整数校验，自定义不被复杂流程最低预算抬高，旧模式预设不变');

const stored = normalizeAppSettings({ agentExecutionMode: 'deep', agentToolCallLimit: 35 });
assert.equal(normalizeAppSettings(deserializeSettingsState(serializeSettingsState(stored))).agentToolCallLimit, 35);
assert.equal(normalizeAppSettings({ agentToolCallLimit: '48' }).agentToolCallLimit, undefined);
assert.equal(normalizeAppSettings({ agentToolCallLimit: 999 }).agentToolCallLimit, undefined);
assert.equal(normalizeAppSettings({ agentExecutionMode: 'deep' }).agentToolCallLimit, undefined);
pass('设置序列化往返保留上限；非法值和旧配置安全回退，不影响旧档位');

for (const limit of [4, 32, ABSOLUTE_MAX_AGENT_TOOL_CALLS]) {
  selected = limit;reads = 0;
  const result = await runAgentTurn({ ...base, userText: '只读取学习概况', callLlm: async () => ({ content: '', toolCalls: [read()] }) });
  assert.equal(reads, limit, JSON.stringify(result.toolTrace));assert.equal(result.runtimeMetrics?.toolCalls, limit);assert.equal(result.truncated, true);
}
pass('实际Agent执行器可达32/48次，不再被旧8/12轮截停，低预算4次也准确停止');

selected = 4;reads = 0;
let release!: () => void;const gate = new Promise<void>(resolve => { release = resolve; });
const pending = runAgentTurn({ ...base, ctx: { ...ctx, ensureDataFresh: () => gate }, userText: '只读取学习概况',
  callLlm: async () => ({ content: '', toolCalls: [read()] }) });
selected = 48;release();await pending;assert.equal(reads, 4);
pass('请求首次await前冻结预算，准备期间更改全局设置不会扩大当前任务');

selected = 6;reads = 0;writes = 0;let rounds = 0;
const first = await runAgentTurn({ ...base, userText: '读取后更新笔记', callLlm: async () => ++rounds === 1
  ? { content: '', toolCalls: [read(), read(), read()] }
  : { content: '', toolCalls: [{ id: 'budget-write', name: 'update_note', arguments: { noteId: 'fixture' } }] } });
assert(first.pendingApproval);assert.equal(writes, 0);assert.equal(first.pendingApproval.continuation.toolCallLimit, 6);
const durable = buildPersistentAgentCheckpoint({ roleId: base.role.id, approval: first.pendingApproval, history: first.updatedHistory });
assert.equal(durable.approval.continuation.toolCallLimit, 6);
selected = 48;
const approved = await resolveAgentApproval({ role: base.role, ctx, approval: durable.approval, history: durable.history, approved: true,
  callLlm: async () => ({ content: '', toolCalls: [read()] }) });
assert.equal(writes, 1);assert.equal(reads, 5);assert.equal(approved.runtimeMetrics?.toolCalls, 6);assert.equal(approved.truncated, true);
const damaged = structuredClone(first.pendingApproval);damaged.continuation.toolCallLimit = 99;
assert.throws(() => buildPersistentAgentCheckpoint({ roleId: base.role.id, approval: damaged, history: first.updatedHistory }), /checkpoint/);
pass('审批及持久化恢复沿用原6次上限，已有读取/写入累计不重置，设置变更不扩大授权');

selected = 4;reads = 0;let failedRound = 0;let failure: AgentRunFailure | undefined;
try { await runAgentTurn({ ...base, userText: '只读取学习概况', callLlm: async () => {
  if (++failedRound === 2) throw Error('synthetic transport failure');return { content: '', toolCalls: [read()] };
} }); } catch (error) { assert(error instanceof AgentRunFailure);failure = error; }
assert(failure);assert.equal(failure.recovery.toolCallLimit, 4);selected = 48;
const resumed = await resumeAgentTurn({ role: base.role, ctx, recovery: failure.recovery,
  callLlm: async () => ({ content: '', toolCalls: [read()] }) });
assert.equal(reads, 4);assert.equal(resumed.runtimeMetrics?.toolCalls, 4);
pass('网络失败同请求重试保留原预算及已用次数，不重跑旧步骤或继承新滑条值');

selected = 48;reads = 0;
const batch = await runAgentTurn({ ...base, userText: '只读取学习概况', callLlm: async () => ({ content: '', toolCalls: Array.from({ length: 60 }, read) }) });
assert.equal(reads, 48);assert.equal(batch.runtimeMetrics?.toolCalls, 48);assert(batch.truncated);
pass('模型单响应超量调用仍受48次绝对上限限制');

selected = 32;writes = 0;
const multiApproval = await runAgentTurn({ ...base, userText: '更新指定笔记', callLlm: async () => ({ content: '',
  toolCalls: Array.from({ length: 25 }, (_, i) => ({ id: `many-writes-${i}`, name: 'update_note', arguments: { noteId: `fixture-${i}` } })) }) });
assert.equal(writes, 0);assert.equal(multiApproval.pendingApproval?.items.length, 25);
assert.equal(buildPersistentAgentCheckpoint({ roleId: base.role.id, approval: multiApproval.pendingApproval!, history: multiApproval.updatedHistory }).approval.items.length, 25);
const lateConfirmation = structuredClone(multiApproval.pendingApproval!);lateConfirmation.continuation.roundsUsed = 25;
assert.equal(buildPersistentAgentCheckpoint({ roleId: base.role.id, approval: lateConfirmation, history: multiApproval.updatedHistory }).approval.continuation.roundsUsed, 25);
delete lateConfirmation.continuation.toolCallLimit;
assert.throws(() => buildPersistentAgentCheckpoint({ roleId: base.role.id, approval: lateConfirmation, history: multiApproval.updatedHistory }), /checkpoint/);
pass('较高预算的25项确认卡可持久化，仍未在确认前执行任何写入');

const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const cognition = applyCognitionMutation(emptyCognitionFile(), { kind: 'confirm', confirmed: true, expectedRevision: 0,
  operation: 'initial', authorship: 'own_expression', stance: 'endorsed', reason: '',
  doc: { doc_id: 'budget-fixture', title: '合成认知', nodes: Array.from({ length: 45 }, (_, i) => ({
    id: `n${i}`, mainType: '事实陈述', text: `合成认知记录${i}。`,
  })), edges: [] },
}, { id: 'v1', at: '2026-10-04T00:00:00Z' });
let expandDuringRead = false, inquiryModelCalls = 0;
Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new EventTarget(), { electronAPI: {
  userState: { loadCognition: async () => structuredClone(cognition), loadLearningEpisodes: async () => ({ version: 2, episodes: [] }) },
  agent: { queryProfile: async () => { if (expandDuringRead) selected = 48; return { text: '合成画像', details: [] }; },
    queryMastery: async () => ({ rows: [] }) },
} }) });
registerDataTools();
const answerInquiry = (request: LlmCallRequest): LlmCallResponse => {
  const body = JSON.parse(request.userInput), source = body.pages[0].sources[0];
  return { content: '', parsedJson: { action: 'answer', paragraphs: [{ text: '已读记录摘述。', evidence: [{ id: source.id, quote: source.text }] }] } };
};
const inquiryBase = { ...base, requestedSkillId: 'personalized-qa', userText: '我的用户画像和掌握情况是什么' };
try {
  selected = 4;
  const complete = await runAgentTurn({ ...inquiryBase, callLlm: async request => {
    assert.equal(JSON.parse(request.userInput).canReadMore, false); return answerInquiry(request);
  } });
  assert.equal(complete.runtimeMetrics?.toolCalls, 4); assert.equal(complete.truncated, false);
  assert.deepEqual(complete.toolTrace.map(step => step.call.name), ['query_learner_profile', 'query_mastery', 'read_cognition_page', 'synthesize_cognition_answer']);
  pass('认知旁路辅助查询、读页、合成共用4次预算，恰好完成不误报截停');

  inquiryModelCalls = 0;
  const blockedPage = await runAgentTurn({ ...inquiryBase, callLlm: async request => {
    inquiryModelCalls++; return { content: '', parsedJson: { action: 'read', page: JSON.parse(request.userInput).nextPage } };
  } });
  assert.equal(inquiryModelCalls, 1); assert.equal(blockedPage.runtimeMetrics?.toolCalls, 4); assert(blockedPage.truncated);
  assert.equal(blockedPage.toolTrace.filter(step => step.call.name === 'read_cognition_page').length, 1);
  assert.match(blockedPage.reply, /预算/); assert.match(blockedPage.reply, /原始记录节选/);
  const cursor = blockedPage.updatedHistory.at(-1)?.cognitionInquiry;
  assert.equal(cursor?.nextPage, 1, 'blocked page must remain available to the next request');
  const continued = await runAgentTurn({ ...inquiryBase, history: blockedPage.updatedHistory, userText: '继续', callLlm: async request => {
    assert.equal(JSON.parse(request.userInput).pages[0].page, 1); return answerInquiry(request);
  } });
  assert.equal(continued.runtimeMetrics?.toolCalls, 4); assert.equal(continued.truncated, false);
  pass('模型忽略剩余额度仍无法越界翻页，部分内容保留且新请求从未读页继续');

  inquiryModelCalls = 0;
  const noRepair = await runAgentTurn({ ...inquiryBase, callLlm: async () => { inquiryModelCalls++; return { content: 'invalid JSON' }; } });
  assert.equal(inquiryModelCalls, 1); assert.equal(noRepair.runtimeMetrics?.toolCalls, 4); assert(noRepair.truncated);
  assert.doesNotMatch(noRepair.reply, /一次修正后/);
  selected = 5; inquiryModelCalls = 0;
  const repaired = await runAgentTurn({ ...inquiryBase, callLlm: async request => ++inquiryModelCalls === 1 ? { content: 'invalid JSON' } : answerInquiry(request) });
  assert.equal(inquiryModelCalls, 2); assert.equal(repaired.runtimeMetrics?.toolCalls, 5); assert.equal(repaired.truncated, false);
  pass('格式失败也消耗预算：4次时不偷偷修正，5次时允许一次修正并完成');

  selected = 4;
  const paged = await runAgentTurn({ ...inquiryBase, userText: '我相信哪些事实', callLlm: async request => {
    const body = JSON.parse(request.userInput);
    return body.canReadMore && body.nextPage !== null ? { content: '', parsedJson: { action: 'read', page: body.nextPage } } : answerInquiry(request);
  } });
  assert.equal(paged.runtimeMetrics?.toolCalls, 4); assert.equal(paged.truncated, false);
  assert.equal(paged.toolTrace.filter(step => step.call.name === 'read_cognition_page').length, 3);
  expandDuringRead = true;
  const frozen = await runAgentTurn({ ...inquiryBase, callLlm: async request => {
    assert.equal(JSON.parse(request.userInput).canReadMore, false); return answerInquiry(request);
  } });
  assert.equal(selected, 48); assert.equal(frozen.runtimeMetrics?.toolCalls, 4); expandDuringRead = false;
  pass('多页查询预留回答额度，认知辅助读取期间修改设置不扩大当前请求');

  for (const [toolCalls, rounds] of [[0, 2], [1, 2], [6, 1], [6, 0]]) {
    let steps = 0, calls = 0;
    const bounded = await runCognitionInquiry({ question: '我相信哪些事实', allowedTools: new Set(['retrieve_qa_evidence']), ctx,
      budget: { toolCalls, rounds }, onStep: () => { steps++; }, callLlm: async () => { calls++; return { content: 'invalid JSON' }; } });
    assert(bounded.budgetExhausted); assert(steps <= toolCalls); assert(calls <= rounds);
    assert.equal(calls, toolCalls <= 1 || rounds === 0 ? 0 : 1);
  }
  pass('专用查询剩余0/1步或仅1轮时正确停机，不启动预算外模型请求');

  for (const limit of [4, 5, 6, 12, 48]) {
    selected = limit;
    const within = await runAgentTurn({ ...inquiryBase, callLlm: async request => {
      const body = JSON.parse(request.userInput);
      return body.canReadMore && body.nextPage !== null ? { content: '', parsedJson: { action: 'read', page: body.nextPage } } : answerInquiry(request);
    } });
    assert.equal(within.runtimeMetrics?.toolCalls, Math.min(7, limit)); assert.equal(within.truncated, false);
  }
  pass('认知路径4/5/6/12/48预算逐档验证，高预算保留原四页上限与回答能力');
} finally {
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window');
}
console.log(`Agent budget: ${groups} groups passed; real engine/registry/checkpoint, synthetic model and memory-only IO.`);
