import assert from 'node:assert/strict';
import type { NoteItem } from '../src/types';
import type { AgentRuntimeContext, AgentToolStep } from '../src/services/agent/types';
import { AGENT_ROLES, runAgentTurn, resolveAgentApproval } from '../src/services/agent/agentEngine';
import { bootstrapAgentRuntime } from '../src/services/agent/bootstrap';
import { expandAgentCapabilities } from '../src/services/agent/capabilities';
import { createAgentOperationStore, commitAgentWorkspaceChange, prepareOperationUndo } from '../src/services/agent/operationStore';
import { prepareNoteEdit, prepareNoteMove, applyWorkspaceNoteChange } from '../src/services/agent/workspaceOperations';
import { applyAgentSkill, getAgentSkill } from '../src/services/agent/skillRegistry';
import { executeTool, getTool, toolRequiresApproval } from '../src/services/agent/toolRegistry';
import { writeTextbookRegion } from '../src/services/textbook/noteContent';
import { applyAccentAppearance, customAccentTokens, normalizeAccent } from '../src/services/ui/accentAppearance';
import { documentBackgroundJobs } from '../src/services/documentBackgroundJobs';
import { createAgentApprovalBinding } from '../src/services/agent/approvalBinding';

const cache = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => cache.get(key) || null, setItem: (key: string, value: string) => cache.set(key, value), removeItem: (key: string) => cache.delete(key) } });
const note = (id: string, extra: Partial<NoteItem> = {}): NoteItem => ({ id, title: id, content: '原始解释', noteType: 'knowledge', tags: [], links: [], backlinks: [], dueDates: [], createdAt: '2026-10-16T00:00:00Z', updatedAt: '2026-10-16T00:00:00Z', ...extra });
bootstrapAgentRuntime(AGENT_ROLES.default);
let disk: unknown = null;
const store = createAgentOperationStore({ read: async () => structuredClone(disk), write: async file => { disk = structuredClone(file); } });
let notes = [note('source'), note('other')];
const commit = (change: Parameters<typeof commitAgentWorkspaceChange>[0], undoRecordId?: string) => commitAgentWorkspaceChange(change, {
  store, undoRecordId, readNotes: () => notes, saveAndApply: async change => { notes = applyWorkspaceNoteChange(notes, change); },
});
const edited = await commit(prepareNoteEdit(notes, { noteId: 'source', replacements: [{ oldText: '原始解释', newText: '新的解释' }] }));
assert.equal((await store.get(edited.operationId)).status, 'applied');
notes[1] = { ...notes[1], content: '另一个笔记的后续编辑' };
await commit(prepareOperationUndo(notes, await store.get(edited.operationId)), edited.operationId);
assert.equal(notes[0].content, '原始解释');
assert.equal(notes[1].content, '另一个笔记的后续编辑', '恢复不能回滚整库');
const changed = await commit(prepareNoteEdit(notes, { noteId: 'source', appendText: '追加' }));
notes[0] = { ...notes[0], content: '用户后续改写' };
assert.throws(() => prepareOperationUndo(notes, (disk as any).records.find((item: any) => item.id === changed.operationId)), /发生修改/u);
const deleted = await commit({ kind: 'remove', label: '移除 source', before: [notes[0]], after: [] });
assert.equal(notes.some(note => note.id === 'source'), false);
await commit(prepareOperationUndo(notes, await store.get(deleted.operationId)), deleted.operationId);
assert.equal(notes.find(note => note.id === 'source')?.content, '用户后续改写');
const interrupted = await store.prepare(prepareNoteEdit(notes, { noteId: 'source', appendText: '中断前已保存' }));
notes = applyWorkspaceNoteChange(notes, interrupted.change);
assert.equal(prepareOperationUndo(notes, interrupted).after[0].content, '用户后续改写', '已落盘但未标记 applied 的操作也可恢复');
let writeAttempted = false;
await assert.rejects(commitAgentWorkspaceChange(prepareNoteEdit(notes, { noteId: 'source', appendText: '不可丢备份' }), {
  store: createAgentOperationStore({ read: async () => null, write: async () => { throw new Error('备份落盘失败'); } }),
  readNotes: () => notes, saveAndApply: async () => { writeAttempted = true; },
}), /备份落盘失败/u);
assert.equal(writeAttempted, false);
const parent = note('parent', { noteType: 'project' });
const child = note('child', { noteType: 'project', parentId: parent.id });
assert.throws(() => prepareNoteMove([parent, child], [parent.id], child.id), /循环/u);
assert.throws(() => prepareNoteEdit([note('p', { noteType: 'project', content: '- [ ] 任务 @due(2026-10-20)' })], { noteId: 'p', appendText: '- [ ] 新任务' }), /计划任务/u);
const managed = writeTextbookRegion(note('book', { noteType: 'project', content: '我自己的笔记' }), '教材正文', {
  version: 1, textbookId: 'b', revisionId: 'r', regionId: 'region', projectNoteId: 'book', rootProjectId: 'book', title: '书', generatedAt: '2026-10-16', updatedAt: '2026-10-16', sources: [],
} as any);
assert.throws(() => prepareNoteEdit([managed], { noteId: managed.id, replacements: [{ oldText: '教材正文', newText: '擅改教材' }] }), /教材区域/u);
assert.equal(prepareNoteEdit([managed], { noteId: managed.id, replacements: [{ oldText: '我自己的笔记', newText: '修改自己的笔记' }] }).after[0].content.includes('教材正文'), true);
assert.throws(() => prepareNoteEdit([note('repeat', { content: '重复 重复' })], { noteId: 'repeat', replacements: [{ oldText: '重复', newText: '新' }] }), /多次/u);

const ctx = {
  getNotes: () => notes, getActiveNote: () => notes[0], ensureDataFresh: async () => {},
  getPlanDraftSession: () => null, getResourceDraftSession: () => null,
  applyWorkspaceNoteChange: commit,
} as unknown as AgentRuntimeContext;
const resourceRole = applyAgentSkill(AGENT_ROLES.default, getAgentSkill('resource-curation')!);
const discovery: AgentToolStep = { call: { id: 'discover', name: 'discover_agent_capabilities', arguments: { domains: ['notes'] } }, ok: true };
assert.equal(resourceRole.allowedTools.includes('update_note'), true, '通用笔记编辑不因资源Skill激活而丢失');
assert.equal(resourceRole.allowedTools.includes('move_notes'), false);
assert.equal(expandAgentCapabilities(resourceRole, [discovery]).allowedTools.includes('update_note'), true);
assert.equal(expandAgentCapabilities({ ...resourceRole, skillToolCeiling: ['discover_agent_capabilities'] }, [discovery]).allowedTools.includes('update_note'), false, '发现不能突破角色权限上限');
assert.equal(expandAgentCapabilities(resourceRole, [{ ...discovery, ok: false }]).allowedTools.includes('move_notes'), false);
assert.equal(toolRequiresApproval(getTool('update_note')!, {}, ctx), true);
let rounds = 0;
const before = notes[0].content;
const turn = await runAgentTurn({ role: AGENT_ROLES.default, userText: '先整理资源，再把这篇笔记加上说明', requestedSkillId: 'resource-curation', history: [], ctx,
  memoryPrefixLoader: async () => '', enableMultiAgent: false,
  callLlm: async request => {
    rounds++;
    if (rounds === 1) return { content: '', toolCalls: [discovery.call] };
    assert.equal(request.tools?.some(tool => tool.name === 'update_note'), true, '发现后下一轮可用真实工具定义');
    return { content: '', toolCalls: [{ id: 'edit', name: 'update_note', arguments: { noteId: notes[0].id, appendText: '经确认的补充说明' } }] };
  },
});
assert.equal(notes[0].content, before, '确认前不写入');
assert.equal(turn.pendingApproval?.items[0].call.name, 'update_note');
const approved = await resolveAgentApproval({ role: AGENT_ROLES.default, approval: turn.pendingApproval!, approved: true, history: turn.updatedHistory, ctx,
  callLlm: async () => ({ content: '补充已保存。' }),
});
assert.equal(approved.toolTrace.some(step => step.ok && step.call.name === 'update_note'), true, '确认恢复后仍保留本轮按需发现的工具');
assert.equal(notes[0].content.endsWith('经确认的补充说明'), true);
assert.equal((await executeTool('discover_agent_capabilities', { domains: ['missing'] }, ctx)).ok, false);
const listed = await executeTool('list_notes', { limit: 1 }, ctx);
assert.equal((listed.result as any).notes.length, 1);
assert.equal((listed.result as any).nextOffset, 1);
const longNote = note('long', { content: 'a'.repeat(31_000) });
const paged = await executeTool('read_notes', { noteIds: [longNote.id], offset: 30_000 }, { ...ctx, getNotes: () => [longNote] });
assert.equal((paged.result as any).notes[0].content.length, 1000);
assert.equal((paged.result as any).notes[0].truncated, false);
const selectedDeletion = await executeTool('delete_notes', { noteIds: [notes[0].id] }, { ...ctx, deleteNotes: async input => ({ deletedCount: input.noteIds.length, deletedTitles: input.noteIds }) });
assert.equal(selectedDeletion.ok, true);
assert.equal((await executeTool('delete_notes', { noteIds: [notes[0].id], noteTitles: [notes[0].title] }, ctx)).ok, false);
assert.throws(() => applyWorkspaceNoteChange([parent, { ...parent, id: 'plan', planMeta: {} as any }, { ...child, parentId: 'plan' }], {
  kind: 'remove', label: '不能破坏计划引用', before: [{ ...child, parentId: 'plan' }], after: [],
}), /计划结构/u);
let compactRound = 0;
const compactTurn = await runAgentTurn({ role: AGENT_ROLES.default, userText: '把这篇笔记补充说明', requestedSkillId: 'resource-curation', history: [], ctx, memoryPrefixLoader: async () => '', enableMultiAgent: false,
  callLlm: async () => compactRound++ === 0 ? { content: '', toolCalls: [discovery.call] }
    : { content: '', toolCalls: [{ id: 'compact-edit', name: 'update_note', arguments: { noteId: notes[0].id, appendText: '压缩后继续确认' } }] },
});
const compactHistory = compactTurn.updatedHistory.filter(message => message.toolName !== 'discover_agent_capabilities' && !message.toolCalls?.some(call => call.name === 'discover_agent_capabilities'));
const compactApproved = await resolveAgentApproval({ role: AGENT_ROLES.default, ctx, approval: compactTurn.pendingApproval!, approved: true, history: compactHistory, callLlm: async () => ({ content: '补充已保存。' }) });
assert.equal(compactApproved.toolTrace.some(step => step.ok && step.call.name === 'update_note'), true, '历史压缩不能丢失已确认的跨领域操作，角色上限仍从当前配置重建');
const background = documentBackgroundJobs.enqueue({ docId: 'doc-fixture', fileName: '合成资料', action: 'next' }, async (_progress, signal) => {
  await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
});
await Promise.resolve();
assert.equal(toolRequiresApproval(getTool('cancel_document_job')!, { jobId: background.id }, ctx), true);
await createAgentApprovalBinding({ id: 'cancel-fixture', name: 'cancel_document_job', arguments: { jobId: background.id } }, ctx);
assert.equal((await executeTool('cancel_document_job', { jobId: background.id }, ctx)).ok, true);
await Promise.resolve(); await Promise.resolve();
assert.equal(documentBackgroundJobs.getSnapshot().find(job => job.id === background.id)?.status, 'cancelled');
const unavailable = await executeTool('query_agent_jobs', {}, { ...ctx, getNotes: () => [parent], getActiveNote: () => parent });
assert.match(JSON.stringify(unavailable.result), /接口不可用/u);

assert.equal(normalizeAccent('#aBcDeF'), '#ABCDEF');
assert.throws(() => normalizeAccent('url(https://example.invalid)'));
for (const dark of [false, true]) for (const color of ['#000000', '#FFFFFF', '#FFFF00', '#123456']) {
  const tokens = customAccentTokens(color, dark);
  assert.match(tokens['--ln-accent'], /^#[0-9a-f]{6}$/u);
  assert.ok(['#ffffff', '#000000'].includes(tokens['--ln-text-on-accent']));
  const lum = (hex: string) => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  const contrast = (a: string, b: string) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  assert.ok(contrast(tokens['--ln-accent'], dark ? '#171c18' : '#fffefa') >= 4.5);
  assert.ok(contrast(tokens['--ln-accent'], tokens['--ln-text-on-accent']) >= 4.5);
}
const css = new Map<string, string>(); const root = { dataset: {} as DOMStringMap, style: { setProperty: (key: string, value: string) => css.set(key, value), removeProperty: (key: string) => css.delete(key) } };
applyAccentAppearance('#AABBCC', false, root as any); assert.equal(root.dataset.accent, 'custom');
applyAccentAppearance('emerald', false, root as any); assert.equal(css.size, 0, '切回预设必须移除所有自定义覆盖');
console.log('Agent operations: recovery, protected content, cross-workflow approval, role ceiling, custom accents passed (offline synthetic fixtures).');
