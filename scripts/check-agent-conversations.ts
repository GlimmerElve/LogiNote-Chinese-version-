import assert from 'node:assert/strict';
import { createConversationScheduler, normalizeConversationLayout, roleForConversation, type AgentConversationLayout } from '../src/services/agent/conversations';
import { createConversationContexts } from '../src/services/agent/conversationSessionContext';
import { loadAgentConversations, saveAgentConversations, saveAgentSession, loadAgentSession, clearAgentSession } from '../src/services/agent/sessionStore';
import { clearPendingAgentCheckpoint, loadPendingAgentCheckpoint, markAgentCheckpointResolving, savePendingAgentCheckpoint } from '../src/services/agent/checkpointStore';
import { AGENT_ROLES, resolveAgentApproval, runAgentTurn } from '../src/services/agent/agentEngine';
import { registerTool, clearToolRegistryForTests } from '../src/services/agent/toolRegistry';
import { agentWorkspaceContextKey, buildAgentWorkspaceContext, historyForAgentWorkspace } from '../src/services/agent/workspaceContext';
import type { AgentPlanDraftSession, AgentRuntimeContext } from '../src/services/agent/types';
import type { NoteItem, LlmCallRequest, LlmConversationMessage } from '../src/types';

// No vault, provider or network; every model answer below is a local stub.
globalThis.fetch = async () => { throw new Error('Live network forbidden'); };
const memory = new Map<string, string>();
Object.assign(globalThis, { localStorage: { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key) }, window: {} });
let checks = 0;
const pass = (label: string) => { checks++; console.log(`PASS ${label}`); };
const a = { id: 'A', title: '教材项目', content: '', noteType: 'project' } as NoteItem;
const b = { id: 'B', title: '认知讨论', content: '', noteType: 'knowledge' } as NoteItem;
let notes = [a, b], focus = a, plan: AgentPlanDraftSession | null = null;
const launches: Parameters<AgentRuntimeContext['enterLearningMode']>[0][] = [];
const base = { getNotes: () => notes, getActiveNote: () => focus,
  getPlanDraftSession: () => plan, getResourceDraftSession: () => null, ensureDataFresh: async () => {},
  getWorkspaceSnapshot: () => ({ revision: 1, view: 'editor', focusedNoteId: focus.id }),
  openNoteByTitle: (title: string) => { focus = notes.find(note => note.title === title)!; return !!focus; },
  navigate: () => {}, hasPendingPlanEditorDraft: () => false,
  enterLearningMode: input => { launches.push(input); return true; },
  startPlanDraftSession: () => { plan = { id: 'draft-A', scopeProjectTitle: a.title } as AgentPlanDraftSession; return {} as never; },
  discardPlanDraftSession: () => { plan = null; return { discarded: true }; }, commitPlanDraftSession: async () => ({}) as never,
} as unknown as AgentRuntimeContext;
const registry = createConversationContexts('default', () => base);
const wa = { revision: 1, view: 'editor' as const, focusedNoteId: a.id }, wb = { revision: 1, view: 'editor' as const, focusedNoteId: b.id };
const ca = registry.get('default', wa), cb = registry.get('chat-B', wb);
focus = b; assert.equal(ca.getActiveNote!()!.id, 'A'); assert.equal(cb.getActiveNote!()!.id, 'B');
assert.match(buildAgentWorkspaceContext(ca), /对话标签绑定/); assert.doesNotMatch(buildAgentWorkspaceContext(cb), /教材项目/);
cb.openNoteByTitle(a.title); assert.equal(cb.getActiveNote!()!.id, 'A'); assert.equal(ca.getActiveNote!()!.id, 'A');
registry.bind('chat-B', wb); assert.equal(cb.getActiveNote!()!.id, 'B');
focus = b; ca.enterLearningMode({ mode: 'flow' }); assert.equal(launches.at(-1)?.noteTitle, a.title);
focus = a; cb.enterLearningMode({ mode: 'quick_check' }); assert.equal(launches.at(-1)?.quickCheckRequest?.noteId, b.id);
registry.bind('default', wa); registry.bind('chat-B', wb);
notes = [b]; assert.equal(ca.getActiveNote!(), null, 'deleted focus cannot fall back to another tab'); notes = [a, b];
pass('会话工作对象固定、独立导航、对象删除不换目标');
ca.startPlanDraftSession({ mode: 'full-task-generation', purpose: 'study-tasks' });
assert.equal(cb.getPlanDraftSession(), null); assert.throws(() => cb.discardPlanDraftSession(), /另一个对话标签/);
assert.throws(() => cb.startPlanDraftSession({ mode: 'full-task-generation', purpose: 'study-tasks' }), /另一个对话标签/);
const restored = createConversationContexts('default', () => base, async () => {}, registry.owners());
assert.equal(restored.get('default', wa).getPlanDraftSession()?.id, 'draft-A'); assert.equal(restored.get('chat-B', wb).getPlanDraftSession(), null);
ca.discardPlanDraftSession(); cb.startPlanDraftSession({ mode: 'full-task-generation', purpose: 'study-tasks' });
assert.equal(ca.getPlanDraftSession(), null); cb.discardPlanDraftSession();
pass('共享编辑器明确占用、草稿归属恢复、拒绝跨标签提交或清空');
let wrongScope = false;
const scoped = createConversationContexts('default', () => base, async () => { if (wrongScope) throw new Error('scope changed'); });
wrongScope = true; await assert.rejects(scoped.get('default', wa).ensureDataFresh(), /scope changed/);
pass('资料库变化阻断旧标签继续执行');

const scheduler = createConversationScheduler(2), controllers = Array.from({ length: 4 }, () => new AbortController());
const releaseA = await scheduler.acquire(controllers[0].signal), releaseB = await scheduler.acquire(controllers[1].signal);
let thirdStarted = false;
const third = scheduler.acquire(controllers[2].signal).then(release => { thirdStarted = true; return release; });
const fourth = scheduler.acquire(controllers[3].signal); controllers[3].abort(); await assert.rejects(fourth);
assert.equal(scheduler.running(), 2); assert.equal(scheduler.waiting(), 1); assert.equal(thirdStarted, false);
releaseA(); const releaseC = await third; assert.equal(scheduler.running(), 2); releaseA(); assert.equal(scheduler.running(), 2);
releaseB(); releaseC(); assert.equal(scheduler.running(), 0);
pass('两条执行槽并行、后续排队、独立取消、重复释放安全');

const layout: AgentConversationLayout = { version: 1, activeId: 'chat-B', tabs: [{ id: 'default', title: '教材修订', workspace: wa }, { id: 'chat-B', title: '认知校订', workspace: wb }] };
assert.deepEqual(normalizeConversationLayout({ ...layout, draftOwners: { plan: 'chat-B', resource: undefined } })?.draftOwners, { plan: 'chat-B' });
await Promise.all([
  saveAgentConversations(layout),
  saveAgentSession({ roleId: 'default', workspaceContextKey: 'A', history: [{ role: 'user', content: '教材私有上下文' }] }),
  saveAgentSession({ roleId: 'chat-B', workspaceContextKey: 'B', history: [{ role: 'user', content: '认知私有上下文' }] }),
]);
assert.deepEqual(await loadAgentConversations(), layout);
assert.equal((await loadAgentSession('default'))?.messages[0].content, '教材私有上下文');
assert.equal((await loadAgentSession('chat-B'))?.messages[0].content, '认知私有上下文');
await clearAgentSession('default'); assert.ok(await loadAgentSession('chat-B')); assert.ok(await loadAgentConversations());
assert.throws(() => normalizeConversationLayout({ ...layout, tabs: [...layout.tabs, layout.tabs[0]] }), /标签记录损坏/);
assert.throws(() => normalizeConversationLayout({ ...layout, tabs: [null] }), /标签记录损坏/);
pass('并发保存合并历史和标签布局、清空仅影响本标签');

const oldHistory: LlmConversationMessage[] = [
  { role: 'user', content: '生成旧项目教材' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'old-state', name: 'project_state', arguments: { projectNoteId: a.id } }] },
  { role: 'tool', content: '{"projectNoteId":"A","jobId":"OLD_JOB_A","chapters":["旧第一章","旧第二章","旧第三章"]}', toolCallId: 'old-state', toolName: 'project_state' },
  { role: 'assistant', content: '旧项目已有三章教材，任务 OLD_JOB_A 完成。' },
];
registry.bind('default', wa); const oldKey = agentWorkspaceContextKey(ca);
registry.bind('default', { ...wb, revision: 2 }); const newKey = agentWorkspaceContextKey(ca);
assert.notEqual(newKey, oldKey);
assert.equal(historyForAgentWorkspace(oldHistory, oldKey, oldKey), oldHistory);
assert.deepEqual(historyForAgentWorkspace(oldHistory, oldKey, newKey), []);
await saveAgentSession({ roleId: 'scope-boundary', workspaceContextKey: newKey, previousHistory: oldHistory,
  history: [{ role: 'user', content: '生成这个项目的教材' }, { role: 'assistant', content: '正在核对新项目的当前状态' }] });
const scopedHistory = await loadAgentSession('scope-boundary');
assert.equal(scopedHistory?.contextVersion, 1); assert.equal(scopedHistory?.messages.length, 2);
assert(!JSON.stringify(scopedHistory?.messages).includes('OLD_JOB_A'));
assert(JSON.stringify(scopedHistory?.previousMessages).includes('OLD_JOB_A'));
await saveAgentSession({ roleId: 'display-only', workspaceContextKey: newKey, history: [], previousHistory: oldHistory });
assert.deepEqual((await loadAgentSession('display-only'))?.messages, []);
assert((await loadAgentSession('display-only'))?.previousMessages?.length);
const full = Array.from({ length: 100 }, (_, index) => ({ role: 'user' as const, content: `current-${index}` }));
await saveAgentSession({ roleId: 'bounded', workspaceContextKey: newKey, history: full, previousHistory: oldHistory });
assert.equal((await loadAgentSession('bounded'))?.messages.length, 100);
assert.equal((await loadAgentSession('bounded'))?.previousMessages, undefined);
const rawFile = JSON.parse(memory.get('loginote_agent_sessions_v1')!);
rawFile.sessions.legacy = { version: 1, roleId: 'legacy', savedAt: new Date().toISOString(), workspaceContextKey: newKey,
  activeSkillId: 'project-textbook', messages: oldHistory };
memory.set('loginote_agent_sessions_v1', JSON.stringify(rawFile));
const legacy = await loadAgentSession('legacy');
assert.deepEqual(legacy?.messages, []); assert.equal(legacy?.activeSkillId, undefined);
assert(JSON.stringify(legacy?.previousMessages).includes('OLD_JOB_A'));
await clearAgentSession('scope-boundary'); assert.equal(await loadAgentSession('scope-boundary'), null);
assert((await loadAgentSession('display-only'))?.previousMessages?.length);
registry.bind('default', wa);
pass('切换对象丢弃操作上下文但保留展示；同对象连续、存储限额和旧会话安全迁移');

clearToolRegistryForTests(); let saved = 0;
registerTool({ name: 'conversation_test_write', description: 'synthetic write', parameters: { type: 'object', properties: {} }, location: 'renderer', permission: 'write',
  execute: () => { saved++; return { saved: true }; } });
const template = { ...AGENT_ROLES.default, allowedTools: ['conversation_test_write'], skillToolCeiling: ['conversation_test_write'] };
const ra = roleForConversation(template, 'default'), rb = roleForConversation(template, 'chat-B');
const pending = (role: typeof ra, ctx: AgentRuntimeContext) => runAgentTurn({ role, ctx, userText: 'write', history: [], memoryPrefixLoader: async () => '',
  callLlm: async request => request.workflow === 'agent-intent-routing' ? { content: '{"skillId":"general","confidence":1,"standaloneRequest":"write","referenceResolution":"none"}' }
    : { content: '', toolCalls: [{ id: `write-${role.id}`, name: 'conversation_test_write', arguments: {} }] } });
const [pa, pb] = await Promise.all([pending(ra, ca), pending(rb, cb)]);
assert.ok(pa.pendingApproval); assert.ok(pb.pendingApproval); assert.equal(saved, 0);
await Promise.all([savePendingAgentCheckpoint({ roleId: ra.id, approval: pa.pendingApproval!, history: pa.updatedHistory }),
  savePendingAgentCheckpoint({ roleId: rb.id, approval: pb.pendingApproval!, history: pb.updatedHistory })]);
assert.equal((await loadPendingAgentCheckpoint(ra.id)).status, 'restored'); assert.equal((await loadPendingAgentCheckpoint(rb.id)).status, 'restored');
await markAgentCheckpointResolving(pa.pendingApproval!.id); assert.equal((await loadPendingAgentCheckpoint(ra.id)).status, 'interrupted');
assert.equal((await loadPendingAgentCheckpoint(rb.id)).status, 'restored');
await clearPendingAgentCheckpoint(ra.id); assert.equal((await loadPendingAgentCheckpoint(rb.id)).status, 'restored');
await assert.rejects(resolveAgentApproval({ role: rb, ctx: cb, approval: pa.pendingApproval!, approved: true, history: pa.updatedHistory, callLlm: async () => ({ content: 'not reached' }) }), /变化|失效/);
assert.equal(saved, 0);
await resolveAgentApproval({ role: rb, ctx: cb, approval: pb.pendingApproval!, approved: true, history: pb.updatedHistory, callLlm: async () => ({ content: 'saved' }) });
assert.equal(saved, 1);
pass('同一通用能力模板的两个会话各自审批、恢复、确认，不能交换确认卡');

const requests: LlmCallRequest[] = [];
const run = (role: typeof ra, ctx: AgentRuntimeContext, secret: string) => runAgentTurn({ role: { ...role, allowedTools: [] }, ctx,
  userText: '你好', history: [{ role: 'user', content: secret }], memoryPrefixLoader: async () => '',
  callLlm: async request => { requests.push(request); return { content: '你好' }; } });
const [answerA, answerB] = await Promise.all([run(ra, ca, '只属于教材标签的细节'), run(rb, cb, '只属于认知标签的细节')]);
assert.ok(answerA.updatedHistory.some(message => message.content.includes('教材标签')));
assert.ok(!answerA.updatedHistory.some(message => message.content.includes('认知标签')));
assert.ok(!answerB.updatedHistory.some(message => message.content.includes('教材标签')));
for (const request of requests) assert.ok(!(JSON.stringify(request).includes('只属于教材标签') && JSON.stringify(request).includes('只属于认知标签')));
pass('真实Agent循环的并行请求不拼接另一标签的短时记忆');
console.log(`Agent conversation checks passed (${checks} groups, stub models only).`);
