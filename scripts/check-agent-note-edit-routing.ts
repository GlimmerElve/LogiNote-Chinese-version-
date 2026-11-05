import assert from 'node:assert/strict';
import type { NoteItem } from '../src/types';
import type { AgentRole, AgentRuntimeContext, AgentToolStep } from '../src/services/agent/types';
import { AGENT_ROLES, runAgentTurn, resolveAgentApproval } from '../src/services/agent/agentEngine';
import { bootstrapAgentRuntime } from '../src/services/agent/bootstrap';
import { applyAgentSkill, getAgentSkill, listAgentSkills } from '../src/services/agent/skillRegistry';
import { GENERAL_NOTE_TOOLS } from '../src/services/agent/noteToolNames';
import { listToolsForRole, getTool, toolRequiresApproval } from '../src/services/agent/toolRegistry';
import { COGNITION_ASSISTANT_ROLE } from '../src/services/agent/cognitionAssistantPolicy';
import { expandAgentCapabilities, agentToolAvailabilityError } from '../src/services/agent/capabilities';
import { agentActionRecoveryReason } from '../src/services/agent/actionOutcome';
import { commitAgentWorkspaceChange, createAgentOperationStore } from '../src/services/agent/operationStore';
import { applyWorkspaceNoteChange } from '../src/services/agent/workspaceOperations';

const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => storage.get(key) || null,
  setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) } });
bootstrapAgentRuntime(AGENT_ROLES.default);
let groups = 0;
const pass = (message: string) => { groups++; console.log(`PASS ${message}`); };
for (const skill of listAgentSkills()) {
  const role = applyAgentSkill(AGENT_ROLES.default, skill);
  for (const name of GENERAL_NOTE_TOOLS) assert.ok(listToolsForRole(role).some(tool => tool.name === name), `${skill.id} lost ${name}`);
}
const exclusive = applyAgentSkill(COGNITION_ASSISTANT_ROLE, getAgentSkill('cognition-management')!);
for (const name of GENERAL_NOTE_TOOLS) assert.ok(!listToolsForRole(exclusive).some(tool => tool.name === name));
const narrow: AgentRole = { ...AGENT_ROLES.default, id: 'read-only', allowedTools: ['read_notes', 'discover_agent_capabilities'],
  skillToolCeiling: ['read_notes', 'discover_agent_capabilities'] };
assert.ok(!applyAgentSkill(narrow, getAgentSkill('knowledge-capture')!).allowedTools.includes('update_note'));
const unadvertised = { ...AGENT_ROLES.default, allowedTools: ['read_notes'], skillToolCeiling: ['read_notes', 'update_note'] };
assert.ok(!applyAgentSkill(unadvertised, getAgentSkill('knowledge-capture')!).allowedTools.includes('update_note'));
assert.ok(!expandAgentCapabilities({ ...AGENT_ROLES.default, skillToolCeiling: ['discover_agent_capabilities'] }, []).allowedTools.includes('update_note'));
pass('所有通用Skill保留原有笔记基础工具；专用认知/只读/未开放角色不增加编辑权限');

const makeNote = (id: string, extra: Partial<NoteItem> = {}): NoteItem => ({ id, title: id, noteType: 'knowledge', tags: [], links: [], backlinks: [], dueDates: [],
  content: '无关笔记', createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z', ...extra });
const original = '# AI时代的教育范式\n\n```markdown\n## 需要替换的旧版内容\n旧说明\n```';
const replacement = '# AI时代的教育范式\n\n## 更新后的内容\n以认识和检验为核心，而不是只积累答案。';
let notes: NoteItem[] = [], focused = 'a', saves = 0, disk: unknown = null;
const store = createAgentOperationStore({ read: async () => structuredClone(disk), write: async value => { disk = structuredClone(value); } });
function reset() { notes = [makeNote('a', { title: 'AI时代的教育范式', content: original, parentId: 'root-a' }), makeNote('b'),
  makeNote('root-a', { noteType: 'project' }), makeNote('root-b', { noteType: 'project' })]; focused = 'a'; saves = 0; disk = null; }
const ctx = {
  getNotes: () => notes, getActiveNote: () => notes.find(note => note.id === focused), ensureDataFresh: async () => {},
  getPlanDraftSession: () => null, getResourceDraftSession: () => null,
  applyWorkspaceNoteChange: (change: Parameters<typeof commitAgentWorkspaceChange>[0]) => commitAgentWorkspaceChange(change, { store,
    readNotes: () => notes, saveAndApply: async change => { saves++; notes = applyWorkspaceNoteChange(notes, change); } }),
} as unknown as AgentRuntimeContext;
assert.equal(toolRequiresApproval(getTool('update_note')!, {}, ctx), true);
async function requestEdit(skill: string) {
  let round = 0;
  return runAgentTurn({ role: AGENT_ROLES.default, requestedSkillId: skill, userText: '帮我替换，把刚才讨论的新内容写进这篇笔记',
    history: [], ctx, memoryPrefixLoader: async () => '', enableMultiAgent: false,
    callLlm: async request => {
      assert.ok(request.tools?.some(tool => tool.name === 'read_notes'));
      assert.ok(request.tools?.some(tool => tool.name === 'update_note'));
      if (round++ === 0) return { content: '', toolCalls: [{ id: 'read-target', name: 'read_notes', arguments: { noteIds: ['a'] } }] };
      const read = request.agentMessages?.find(message => message.role === 'tool' && message.toolName === 'read_notes');
      assert.ok(read); assert.equal(JSON.parse(read!.content).result.notes[0].content, original);
      focused = 'b'; // Navigation must not change the stable edit target.
      return { content: '请确认替换内容', toolCalls: [{ id: 'replace-note', name: 'update_note', arguments: { noteId: 'a', replacements: [{ oldText: original, newText: replacement }] } }] };
    } });
}
for (const skill of ['knowledge-capture', 'resource-curation', 'plan-planning']) {
  reset(); const cancelled = await requestEdit(skill);
  assert.equal(cancelled.activeSkill?.id, skill); assert.equal(cancelled.pendingApproval?.items[0].call.name, 'update_note');
  assert.equal(saves, 0); assert.equal(notes[0].content, original);
  await resolveAgentApproval({ role: AGENT_ROLES.default, ctx, approval: cancelled.pendingApproval!, approved: false,
    history: cancelled.updatedHistory, callLlm: async () => ({ content: '取消修改' }) });
  assert.equal(saves, 0);
  focused = 'a'; const turn = await requestEdit(skill);
  const approved = await resolveAgentApproval({ role: AGENT_ROLES.default, ctx, approval: turn.pendingApproval!, approved: true,
    history: turn.updatedHistory, callLlm: async () => ({ content: '已按确认内容替换并保存原笔记。' }) });
  assert.ok(approved.toolTrace.some(step => step.call.name === 'update_note' && step.ok));
  assert.equal(saves, 1); assert.equal(notes.find(note => note.id === 'a')!.content, replacement);
  assert.equal(notes.find(note => note.id === 'b')!.content, '无关笔记');
  assert.doesNotMatch(approved.reply, /尚未完成|未执行|未写入|没有最终写入|没有.*通道/);
}
pass('截图场景：知识点/资源/计划Skill内真实读取→替换确认；取消零写入，确认只保存原笔记一次，导航不串写，回执不误报失败');

reset(); const stale = await requestEdit('knowledge-capture');
notes[0] = { ...notes[0], content: original + '\n用户的新修改' };
await assert.rejects(resolveAgentApproval({ role: AGENT_ROLES.default, ctx, approval: stale.pendingApproval!, approved: true,
  history: stale.updatedHistory, callLlm: async () => ({ content: '未保存，请重新核对' }) }), /已发生变化/);
assert.equal(saves, 0); assert.ok(notes[0].content.endsWith('用户的新修改'));
pass('确认后人工编辑使旧确认失效，不覆盖最新正文');

reset(); let discoveryRound = 0;
const recovered = await runAgentTurn({ role: AGENT_ROLES.default, requestedSkillId: 'knowledge-capture', userText: '把已有笔记移到另一个项目', ctx, history: [],
  memoryPrefixLoader: async () => '', enableMultiAgent: false, callLlm: async request => {
    const count = discoveryRound++;
    if (count === 1) {
      const denied = request.agentMessages!.filter(message => message.role === 'tool').at(-1)!;
      assert.match(denied.content, /尚未加载/); assert.match(denied.content, /discover_agent_capabilities/); assert.match(denied.content, /notes/);
      return { content: '', toolCalls: [{ id: 'load-notes', name: 'discover_agent_capabilities', arguments: { domains: ['notes'] } }] };
    }
    if (count === 2) assert.ok(request.tools?.some(tool => tool.name === 'move_notes'));
    return { content: '', toolCalls: [{ id: `move-${count}`, name: 'move_notes', arguments: { noteIds: ['a'], parentProjectId: 'root-b' } }] };
  } });
assert.equal(discoveryRound, 3); assert.equal(recovered.pendingApproval!.items[0].call.name, 'move_notes'); assert.equal(saves, 0);
const recoveredSaved = await resolveAgentApproval({ role: AGENT_ROLES.default, ctx, approval: recovered.pendingApproval!, approved: true,
  history: recovered.updatedHistory, callLlm: async () => ({ content: '移动已完成' }) });
assert.equal(saves, 1); assert.equal(notes.find(note => note.id === 'a')!.parentId, 'root-b');
assert.ok(recoveredSaved.toolTrace.some(step => step.ok && step.call.name === 'move_notes'));
pass('其它未加载工具明确返回能力发现路径，发现后取得定义并确认执行，未绕过审批');

reset(); let denialRounds = 0;
const denied = await runAgentTurn({ role: narrow, requestedSkillId: 'knowledge-capture', userText: '替换笔记内容', ctx, history: [],
  memoryPrefixLoader: async () => '', enableMultiAgent: false, callLlm: async () => {
    denialRounds++; return { content: '', toolCalls: [
      { id: `denied-${denialRounds}`, name: 'update_note', arguments: { noteId: 'a', appendText: '越权内容' } },
      { id: `unknown-${denialRounds}`, name: 'nonexistent_edit', arguments: {} },
    ] };
  } });
assert.equal(denialRounds, 2); assert.equal(saves, 0); assert.equal(denied.pendingApproval, undefined);
assert.match(denied.reply, /停止重复尝试/);
assert.match(agentToolAvailabilityError(narrow, 'update_note'), /权限上限/);
assert.match(agentToolAvailabilityError(AGENT_ROLES.default, 'nonexistent_edit'), /未注册/);
const calls = denied.updatedHistory.flatMap(message => message.toolCalls || []);
const replies = denied.updatedHistory.filter(message => message.role === 'tool');
for (const call of calls) assert.ok(replies.some(message => message.toolCallId === call.id), 'Stop must not leave incomplete batched tool exchanges');
pass('真实角色上限/虚构工具不会被恢复机制解锁；两次重复拒绝即停止，批量工具历史完整且零写入');

const editStep: AgentToolStep = { call: { id: 'saved', name: 'update_note', arguments: { noteId: 'a' } }, ok: true, result: { saved: true } };
for (const skill of ['knowledge-capture', 'resource-curation', 'personalized-textbook', 'plan-planning']) {
  assert.equal(agentActionRecoveryReason('已修改并保存笔记', skill, [editStep]), undefined);
  assert.match(agentActionRecoveryReason('已替换正文', skill, [{ ...editStep, result: { saved: false } }])!, /没有最终写入/);
}
pass('跨Skill真实saved回执生效；saved=false或只有工具调用不冒称替换成功');
console.log(`Agent note edit routing: ${groups} groups passed; mocked planner, real registry/approval/operation store, memory-only IO.`);
