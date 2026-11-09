import assert from 'node:assert/strict';
import { AGENT_ROLES, runAgentTurn, resolveAgentApproval } from '../src/services/agent/agentEngine';
import { bootstrapAgentRuntime } from '../src/services/agent/bootstrap';
import { getAgentSkill, selectAgentSkill } from '../src/services/agent/skillRegistry';
import { inferContextualAgentSkill } from '../src/services/agent/intentRouter';
import { createDocumentBindingPort } from '../src/services/agent/documentBindings';
import { applyWorkspaceNoteChange } from '../src/services/agent/workspaceOperations';
import type { AgentRuntimeContext } from '../src/services/agent/types';
import type { NoteItem, UploadedDocument } from '../src/types';

globalThis.fetch = async () => { throw Error('No network in shared document routing regression'); };
const local = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => local.get(key) || null,
  setItem: (key: string, value: string) => local.set(key, value), removeItem: (key: string) => local.delete(key) } });
bootstrapAgentRuntime(AGENT_ROLES.default);
const previous = [{ role: 'user' as const, content: '帮我制定一份新的 RAG 学习计划' }, { role: 'assistant' as const, content: '计划已保存，可继续安排资料。' }];
for (const text of ['这份资料也绑定到另一个已存在计划', '多个项目共用同一本书', '这份资料也用到另外两个项目', '是否绑定相关资料']) {
  assert.equal(selectAgentSkill(text, 'plan-planning')?.id, 'resource-curation');
  assert.equal(inferContextualAgentSkill(text, previous, 'plan-planning'), 'resource-curation');
}
assert.equal(selectAgentSkill('帮我制定一个机器学习计划')?.id, 'plan-planning');
assert.equal(selectAgentSkill('打开我的资料笔记'), undefined);
assert.ok(getAgentSkill('plan-planning')!.allowedTools.includes('query_local_documents'), 'plan dialogue can inspect real binding status');
assert.ok(!getAgentSkill('plan-planning')!.allowedTools.includes('update_document_project_bindings'), 'binding is not evidence of plan publication');

const note = (id: string): NoteItem => ({ id, title: `项目${id}`, content: '', noteType: 'project', tags: [], links: [], backlinks: [], dueDates: [],
  parentId: null, createdAt: '2026-11-08', updatedAt: '2026-11-08', resources: [] });
const book = { id: 'book', fileName: '基于大模型的RAG应用开发与优化.pdf', fileType: 'pdf', extension: '.pdf', size: 50,
  indexable: true, status: 'ready', uploadAt: '2026-11-08', chunkCount: 1, totalChars: 50 } as UploadedDocument;
let notes = [note('A'), note('B'), note('C')];
notes[0].resources = [{ title: book.fileName, url: 'loginote-document://book', documentId: book.id, kind: 'local' }];
let saves = 0;
const port = createDocumentBindingPort({ assertReady() {}, scope: async () => 'scope', notes: () => notes, list: async () => [book],
  commit: async change => { notes = applyWorkspaceNoteChange(notes, change); saves++; return { operationId: 'bind-shared', saved: true, changedNoteIds: change.after.map(item => item.id) }; }, flush: async () => {} });
const ctx = { getNotes: () => notes, getActiveNote: () => notes[0], getPlanDraftSession: () => null, getResourceDraftSession: () => null,
  hasPendingPlanEditorDraft: () => false, ensureDataFresh: async () => {}, documentBindings: port } as unknown as AgentRuntimeContext;
const userText = '这份资料也绑定到另外两个已存在项目B和C，保留项目A的绑定';
let turns = 0;
const result = await runAgentTurn({ role: AGENT_ROLES.default, preferredSkillId: 'plan-planning', history: previous, userText, ctx,
  memoryPrefixLoader: async () => '', enableMultiAgent: false, callLlm: async request => {
    if (request.workflow === 'agent-intent-routing') return { content: '', parsedJson: { skillId: 'general', confidence: 0.99, standaloneRequest: userText, referenceResolution: 'resolved' } };
    assert.ok(request.tools?.some(tool => tool.name === 'update_document_project_bindings'));
    assert.ok(request.systemPromptOverride?.includes('同一 documentId 可以同时绑定多个项目'));
    if (++turns === 1) return { content: '', toolCalls: [{ id: 'lookup', name: 'query_local_documents', arguments: { documentIds: [book.id] } }] };
    if (turns === 2) return { content: '', toolCalls: [{ id: 'targets', name: 'list_notes', arguments: { noteType: 'project' } }] };
    return { content: '', toolCalls: [{ id: 'share', name: 'update_document_project_bindings', arguments: { action: 'bind', documentIds: [book.id], projectNoteIds: ['B', 'C'] } }] };
  } });
assert.equal(saves, 0); assert.equal(result.pendingApproval?.items[0].call.name, 'update_document_project_bindings');
assert.match(result.pendingApproval!.items[0].description, /1 份资料 × 2 个目标项目/);
const saved = await resolveAgentApproval({ role: AGENT_ROLES.default, approval: result.pendingApproval!, approved: true, history: result.updatedHistory,
  ctx, callLlm: async () => ({ content: '同一份资料已追加绑定到B、C，A原绑定保留。' }) });
const receipt = saved.toolTrace.find(step => step.ok && step.call.name === 'update_document_project_bindings')!.result as any;
assert.equal(receipt.saved, true); assert.deepEqual(receipt.documents[0].directProjectNoteIds, ['A', 'B', 'C']); assert.equal(saves, 1);
console.log('PASS prior plan conversation → existing shared-document intent → metadata/project lookup → one reviewable confirmation → additive save receipt');
console.log('PASS binding status is inspectable during planning; shared references do not create plans, copy files, or imply exclusive ownership');
