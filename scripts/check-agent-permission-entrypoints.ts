import assert from 'node:assert/strict';
import type { NoteItem, UploadedDocument } from '../src/types';
import type { AgentRuntimeContext } from '../src/services/agent/types';
import { prepareNoteEdit, prepareNoteMove, applyWorkspaceNoteChange } from '../src/services/agent/workspaceOperations';
import { createAgentOperationStore, commitAgentWorkspaceChange, prepareOperationUndo } from '../src/services/agent/operationStore';
import { bootstrapAgentRuntime } from '../src/services/agent/bootstrap';
import { AGENT_ROLES, runAgentTurn, resolveAgentApproval } from '../src/services/agent/agentEngine';
import { applyAgentSkill, getAgentSkill } from '../src/services/agent/skillRegistry';
import { listToolsForRole, getTool, executeTool, toolRequiresApproval } from '../src/services/agent/toolRegistry';
import { COGNITION_ASSISTANT_ROLE } from '../src/services/agent/cognitionAssistantPolicy';
import { registerDocumentReadTools } from '../src/services/agent/tools/documentReadTools';
import { createTextbookRunStop, type TextbookStopRequest } from '../src/services/textbook/stop';
import { textbookTaskSummary } from '../src/services/agent/taskLifecycle';
import { isLeafProjectNote } from '../src/services/knowledgePointSelector';

const network = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Live network forbidden'); };
const cache = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => cache.get(key) ?? null, setItem: (key: string, value: string) => cache.set(key, value), removeItem: (key: string) => cache.delete(key),
} });
const note = (id: string, patch: Partial<NoteItem> = {}): NoteItem => ({ id, title: id, content: '原文', noteType: 'knowledge', tags: [], links: [], backlinks: [], dueDates: [], createdAt: '2026-10-23', updatedAt: '2026-10-23', ...patch });
let checks = 0;
const pass = (label: string) => { checks++; console.log(`PASS ${label}`); };
try {
  const root = note('root', { noteType: 'project', planMeta: { dailyStudyMinutes: 60 } as NoteItem['planMeta'] });
  const leaf = note('leaf', { noteType: 'project', parentId: root.id });
  const ref = note('ref', { noteType: 'project', projectRole: 'reference', parentId: leaf.id });
  const folder = note('folder', { noteType: 'project', projectRole: 'reference', parentId: root.id });
  const source = [root, leaf, ref, folder, note('child', { parentId: ref.id })];
  const moved = applyWorkspaceNoteChange(source, prepareNoteMove(source, [ref.id], folder.id));
  assert.equal(moved.find(item => item.id === ref.id)!.parentId, folder.id);
  assert.equal(moved.find(item => item.id === 'child')!.parentId, ref.id);
  assert.equal(isLeafProjectNote(leaf.id, source), true);
  assert.equal(isLeafProjectNote(leaf.id, moved), true);
  assert.equal(moved.find(item => item.id === root.id), root);
  assert.throws(() => prepareNoteMove(source, [leaf.id], folder.id), /计划项目/);
  assert.throws(() => prepareNoteMove(source, [folder.id], folder.id), /自身/);
  assert.throws(() => prepareNoteMove(source, [leaf.id], ref.id), /计划项目|循环/);
  pass('纯资料型项目在计划内移动保留学习叶子、排期和下级；学习项目仍受计划结构限制');

  const move = prepareNoteMove(source, [ref.id], folder.id);
  assert.throws(() => applyWorkspaceNoteChange([...source, note('late-learning', { noteType: 'project', parentId: ref.id })], move), /含学习项目/);
  assert.throws(() => prepareNoteMove([...source, note('bad-ref', { noteType: 'project', projectRole: 'reference', parentId: ref.id, planMeta: {} as NoteItem['planMeta'] })], [ref.id], folder.id), /资料型项目/);
  assert.throws(() => applyWorkspaceNoteChange(source.map(item => item.id === folder.id ? { ...item, content: '新编辑' } : item), move), /父项目/);
  pass('确认后新增学习后代、损坏资料型节点或父项目变化均拒绝移动');

  let notes = [note('first', { aliases: ['Old'] }), note('second')];
  let disk: unknown;
  const store = createAgentOperationStore({ read: async () => disk ?? null, write: async value => { disk = structuredClone(value); } });
  const commit = (change: Parameters<typeof commitAgentWorkspaceChange>[0], undoRecordId?: string) => commitAgentWorkspaceChange(change, {
    store, undoRecordId, readNotes: () => notes, saveAndApply: async value => { notes = applyWorkspaceNoteChange(notes, value); },
  });
  bootstrapAgentRuntime(AGENT_ROLES.default);
  const ctx = { getNotes: () => notes, ensureDataFresh: async () => {}, getPlanDraftSession: () => null, getResourceDraftSession: () => null,
    applyWorkspaceNoteChange: commit } as unknown as AgentRuntimeContext;
  const turn = await runAgentTurn({ role: AGENT_ROLES.default, userText: '帮我给 first 添加别名 New，保留 Old', history: [], ctx,
    requestedSkillId: 'resource-curation', enableMultiAgent: false, memoryPrefixLoader: async () => '', callLlm: async () => {
      return { content: '', toolCalls: [{ id: 'alias', name: 'update_note', arguments: { noteId: 'first', aliases: ['Old', 'New'] } }] };
    } });
  assert.deepEqual(notes[0].aliases, ['Old']);
  assert.ok(turn.pendingApproval);
  assert.ok(turn.pendingApproval.items[0].impacts?.some(item => item.includes('旧 Wiki')));
  await resolveAgentApproval({ role: AGENT_ROLES.default, approval: turn.pendingApproval, approved: true, history: turn.updatedHistory, ctx,
    callLlm: async () => ({ content: '已保存别名。', toolCalls: [] }) });
  assert.deepEqual(notes[0].aliases, ['Old', 'New']);
  const records = await store.list();
  const record = await store.get(records[0].id);
  await commit(prepareOperationUndo(notes, record), record.id);
  assert.deepEqual(notes[0].aliases, ['Old']);
  assert.ok(toolRequiresApproval(getTool('update_note')!, { noteId: 'first', aliases: [] }, ctx));
  pass('真实 Agent 别名修改先出确认卡，成功后可按对象恢复，不继承自动写入许可');

  const rename = prepareNoteEdit(notes, { noteId: 'first', title: 'renamed', aliases: [' New ', 'new'] });
  assert.deepEqual(rename.after[0].aliases, ['new', 'first']);
  assert.deepEqual(prepareNoteEdit(notes, { noteId: 'first', aliases: [] }).after[0].aliases, []);
  assert.throws(() => prepareNoteEdit(notes, { noteId: 'first', aliases: ['SECOND'] }), /冲突/);
  assert.throws(() => prepareNoteEdit(notes, { noteId: 'first', aliases: ['bad|name'] }), /别名/);
  assert.throws(() => prepareNoteEdit(notes, { noteId: 'first', aliases: [null] as unknown as string[] }), /别名/);
  const aliases = prepareNoteEdit(notes, { noteId: 'first', aliases: ['new'] });
  assert.throws(() => applyWorkspaceNoteChange([...notes, note('late', { aliases: ['NEW'] })], aliases), /占用/);
  const duplicateTitles = [note('a', { title: '相同项目', noteType: 'project' }), note('b', { title: '相同项目', noteType: 'project' })];
  assert.equal(applyWorkspaceNoteChange(duplicateTitles, prepareNoteEdit(duplicateTitles, { noteId: 'b', appendText: '说明' }))[1].content, '原文\n\n说明');
  assert.deepEqual(applyWorkspaceNoteChange(duplicateTitles, prepareNoteEdit(duplicateTitles, { noteId: 'b', aliases: ['唯一别名'] }))[1].aliases, ['唯一别名']);
  pass('别名增删、大小写去重、改名保留旧标题和冲突校验有效，旧重名项目仍可按 ID 编辑');

  const version = 'a'.repeat(64);
  let scopeId = 'scope-a', generation = '1', deleted = false, switchDuringRead = false, catalogReads = 0, pageReads = 0;
  const document = { id: 'doc-a', fileName: 'synthetic.md', uploadAt: '2026-10-23', size: 40 } as UploadedDocument;
  const readCtx = { ...ctx, documentBindings: { read: async () => ({ scopeId, notes: [], documents: deleted ? [] : [document] }), apply: async () => { throw Error('read-only'); } } } as AgentRuntimeContext;
  registerDocumentReadTools({ context: async () => generation,
    catalog: async input => { catalogReads++; assert.deepEqual(input.allowedDocIds, ['doc-a']); assert.equal(input.limit, 40);
      if (input.version && input.version !== version) throw Error('SOURCE_CHANGED');
      return { document: { docId: document.id, fileName: document.fileName, fileType: 'md', version, parseStatus: 'ready', indexStatus: 'ready' }, sections: [{ id: 'section:b1', title: '合成章节', level: 1, sectionPath: '合成章节', textStart: 0, textEnd: 100, locator: { kind: 'markdown', heading: '合成章节' } }], assets: [], assetsTruncated: false, nextOffset: 40 } as any;
    }, page: async input => { pageReads++; assert.deepEqual(input.allowedDocIds, ['doc-a']); assert.equal(input.omitImageData, true);
      assert.equal(input.target.kind, 'section'); if (input.version !== version) throw Error('SOURCE_CHANGED');
      if (switchDuringRead) scopeId = 'scope-b';
      return { docId: document.id, fileName: document.fileName, version, targetStart: 0, targetEnd: 100, excerpts: [], nextCursor: 80, truncated: true };
    },
  });
  const first = await executeTool('read_local_document', { documentId: 'doc-a', mode: 'catalog' }, readCtx);
  assert.equal(first.ok, true);
  const scopeToken = (first.result as { scopeToken: string }).scopeToken;
  const content = { documentId: 'doc-a', mode: 'content', version, scopeToken, sectionId: 'section:b1' };
  const read = await executeTool('read_local_document', content, readCtx);
  assert.equal(read.ok, true); assert.equal((read.result as any).completeDocument, false); assert.equal((read.result as any).nextCursor, 80);
  assert.equal((await executeTool('read_local_document', { ...content, cursor: 80 }, readCtx)).ok, true);
  assert.equal((await executeTool('read_local_document', { documentId: 'doc-a', mode: 'catalog', version, scopeToken, offset: 40 }, readCtx)).ok, true);
  pass('资料按稳定 ID 读取目录及章节，保留版本、范围和续读坐标，不把分页当作已读全书');

  const beforeCalls = [catalogReads, pageReads];
  for (const args of [{ ...content, documentId: '../fake' }, { ...content, version: undefined }, { ...content, scopeToken: undefined },
    { ...content, offset: 0 }, { ...content, maxChars: 1 }, { ...content, cursor: -1 }, { documentId: 'doc-a', mode: 'catalog', cursor: 0 }]) {
    assert.equal((await executeTool('read_local_document', args, readCtx)).ok, false);
  }
  assert.deepEqual([catalogReads, pageReads], beforeCalls);
  assert.equal((await executeTool('read_local_document', { ...content, version: 'b'.repeat(64) }, readCtx)).ok, false);
  generation = '2'; assert.equal((await executeTool('read_local_document', content, readCtx)).ok, false); generation = '1';
  deleted = true; assert.equal((await executeTool('read_local_document', content, readCtx)).ok, false); deleted = false;
  switchDuringRead = true; assert.equal((await executeTool('read_local_document', content, readCtx)).ok, false);
  pass('旧版本、切库、资料消失及非法/混用坐标拒绝；不静默改目标、不解析或建索引');

  const events = new Set<(request: TextbookStopRequest) => void>();
  const subscribe = (listener: (request: TextbookStopRequest) => void) => { events.add(listener); return () => { events.delete(listener); }; };
  const send = (jobId: string, token: string) => events.forEach(listener => listener({ jobId, token }));
  const external = new AbortController();
  const a = createTextbookRunStop('a', external.signal, subscribe), b = createTextbookRunStop('b', undefined, subscribe);
  send('a', 'lease-a'); a.claim('lease-a'); b.claim('lease-b');
  assert.equal(a.signal.aborted, true); assert.equal(external.signal.aborted, false); assert.equal(b.signal.aborted, false);
  const next = createTextbookRunStop('a', undefined, subscribe); next.claim('new-lease'); send('a', 'lease-a');
  assert.equal(next.signal.aborted, false); send('a', 'new-lease'); assert.equal(next.signal.aborted, true);
  a.dispose(); b.dispose(); next.dispose(); assert.equal(events.size, 0);
  const aborted = new AbortController(); aborted.abort();
  const already = createTextbookRunStop('other', aborted.signal, subscribe); assert.ok(already.signal.aborted); already.dispose();
  pass('教材停止事件绑定原租约，支持早到事件；不影响其它任务、下一次执行或父级停止信号');

  const summary = textbookTaskSummary({ jobId: 'a', projectNoteId: 'p', stage: 'chapters', title: '合成教材', updatedAt: '', completedChapters: 1, totalChapters: 5, progress: { running: true } as any });
  assert.deepEqual(summary.actions.map(item => item.tool), ['query_textbook_job', 'stop_textbook_job']);
  assert.equal(summary.actions[1].requiresConfirmation, false);
  assert.equal(getTool('stop_textbook_job')!.permission, 'navigation');
  const textbookRole = applyAgentSkill(AGENT_ROLES.default, getAgentSkill('personalized-textbook')!);
  assert.ok(listToolsForRole(textbookRole).some(tool => tool.name === 'stop_textbook_job'));
  assert.ok(!getAgentSkill('personalized-textbook')!.systemPrompt.includes('该功能仅限未发布草稿'));
  assert.ok(listToolsForRole(applyAgentSkill(AGENT_ROLES.default, getAgentSkill('resource-curation')!)).some(tool => tool.name === 'read_local_document'));
  assert.deepEqual(listToolsForRole(COGNITION_ASSISTANT_ROLE).map(tool => tool.name).sort(), ['query_cognition', 'prepare_cognition_change', 'commit_cognition_change'].sort());
  pass('新入口真实注册且角色可用，认知助手仍仅三项工具；教材重生成规则不再冲突');
  console.log(`Agent permission entrypoints: ${checks} groups passed; synthetic ports only, no live model/network/vault`);
} finally { globalThis.fetch = network; }
