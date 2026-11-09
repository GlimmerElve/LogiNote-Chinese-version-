import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import type { NoteItem, UploadedDocument } from '../src/types';
import type { AgentRuntimeContext, AgentToolStep } from '../src/services/agent/types';
import { createDocumentBindingPort, documentBindingApproval, prepareAgentDocumentBindings,
  queryLocalDocumentBindings, readDocumentBindingCommand, type DocumentBindingCatalog } from '../src/services/agent/documentBindings';
import { directDocumentProjects } from '../src/services/documentProjectBindings';
import { projectDocumentBindings } from '../src/services/projectResourceScope';
import { applyWorkspaceNoteChange, type WorkspaceNoteChange } from '../src/services/agent/workspaceOperations';
import { commitAgentWorkspaceChange, createAgentOperationStore, prepareOperationUndo } from '../src/services/agent/operationStore';
import { AGENT_ROLES, resolveAgentApproval, runAgentTurn } from '../src/services/agent/agentEngine';
import { bootstrapAgentRuntime } from '../src/services/agent/bootstrap';
import { applyAgentSkill, getAgentSkill } from '../src/services/agent/skillRegistry';
import { expandAgentCapabilities } from '../src/services/agent/capabilities';
import { executeTool, getTool, toolRequiresApproval } from '../src/services/agent/toolRegistry';
import { agentActionRecoveryReason } from '../src/services/agent/actionOutcome';
import { createAgentApprovalBinding, validateAgentApprovalBinding } from '../src/services/agent/approvalBinding';

const note = (id: string, extra: Partial<NoteItem> = {}): NoteItem => ({ id, title: id, content: '', noteType: 'project',
  tags: [], links: [], backlinks: [], dueDates: [], resources: [], createdAt: '2026-10-19', updatedAt: '2026-10-19', ...extra });
const root = note('root', { title: '人类心理3000年', resources: [{ title: '保留在线链接', url: 'https://synthetic.invalid/retained' }] });
const children = Array.from({ length: 18 }, (_, index) => note(`child-${index}`, { parentId: root.id }));
const other = note('other-root', { title: root.title }); // Real projects may share titles across roots.
const knowledge = note('knowledge', { noteType: 'knowledge' });
const doc = (id: string, fileName: string, extra: Partial<UploadedDocument> = {}): UploadedDocument => ({ id, fileName,
  fileType: 'pdf', extension: '.pdf', indexable: true, size: 1234, status: 'pending', parseStatus: 'pending',
  chunkCount: 0, totalChars: 0, uploadAt: '2026-10-19T01:00:00Z', ...extra });
const book = doc('book', '人类心理3000年.pdf'), image = doc('image', '扫描图片.png', { fileType: 'image', extension: '.png', indexable: false });
const initial: DocumentBindingCatalog = { scopeId: 'synthetic-scope', notes: [root, ...children, other, knowledge],
  documents: [book, image, doc('old', '旧资料.pdf', { uploadAt: '2026-10-18T01:00:00Z' })] };
const bind = { action: 'bind' as const, documentIds: [book.id], projectNoteIds: [root.id] };
let groups = 0;
const pass = (label: string) => { groups++; console.log(`PASS ${label}`); };

const listed = queryLocalDocumentBindings(initial, { limit: 1 });
assert.equal(listed.total, 3); assert.equal(listed.nextOffset, 1);
assert.equal(queryLocalDocumentBindings(initial, { fileNameContains: '人类心理', limit: 50 }).documents[0].id, book.id);
assert.equal(queryLocalDocumentBindings(initial, { documentIds: [image.id] }).documents[0].indexable, false);
assert.equal(JSON.stringify(listed).includes('content'), false);
assert.equal(JSON.stringify(listed).includes('sourceUrl'), false);
assert.throws(() => queryLocalDocumentBindings(initial, { limit: 0 }), /分页/);
assert.throws(() => queryLocalDocumentBindings(initial, { projectNoteId: knowledge.id }), /项目不存在/);
pass('metadata lookup/pagination works before vectorization and omits document/note bodies');

const rootChange = prepareAgentDocumentBindings(initial, bind)!;
assert.deepEqual(rootChange.after.map(note => note.id), [root.id]);
const bound = { ...initial, notes: applyWorkspaceNoteChange(initial.notes, rootChange) };
assert.ok(children.every(child => projectDocumentBindings(child, bound.notes).some(row => row.documentId === book.id && row.inherited)));
assert.ok(children.every(child => bound.notes.find(note => note.id === child.id)!.resources!.length === 0));
assert.equal(bound.notes[0].dueDates.length, 0); assert.equal(bound.notes[0].content, '');
assert.deepEqual(bound.notes[0].resources![0], root.resources![0]);
assert.equal(bound.notes.find(note => note.id === other.id)!.resources!.length, 0);
assert.equal(queryLocalDocumentBindings(bound, { projectNoteId: children[0].id }).documents[0].boundAtProjectId, root.id);
assert.equal(prepareAgentDocumentBindings(bound, bind), null);
pass('empty root with 18 children: one direct binding, inherited access, no tasks/copies/sibling writes');

const batch = readDocumentBindingCommand({ action: 'bind', documentIds: [book.id, image.id], projectNoteIds: [root.id, other.id] });
const batchBound = { ...initial, notes: applyWorkspaceNoteChange(initial.notes, prepareAgentDocumentBindings(initial, batch)!) };
assert.deepEqual(directDocumentProjects(batchBound.notes, image.id), [root.id, other.id]);
const unbindChild = { ...bind, action: 'unbind' as const, projectNoteIds: [children[0].id] };
assert.equal(prepareAgentDocumentBindings(bound, unbindChild), null);
const unbindOther = { ...bind, action: 'unbind' as const, projectNoteIds: [other.id] };
const oneRemoved = applyWorkspaceNoteChange(batchBound.notes, prepareAgentDocumentBindings(batchBound, unbindOther)!);
assert.deepEqual(directDocumentProjects(oneRemoved, book.id), [root.id]);
assert.deepEqual(directDocumentProjects(oneRemoved, image.id), [root.id, other.id]);
pass('batch bind is additive; unbind removes only explicit associations and never ancestor bindings');

for (const invalid of [
  { ...bind, documentIds: [] }, { ...bind, documentIds: [book.id, book.id] }, { ...bind, projectNoteIds: [42] },
  { ...bind, documentIds: [' book'] }, { ...bind, action: 'replace' }, { ...bind, allowCloud: true },
  { action: 'bind', documentIds: Array.from({ length: 8 }, (_, i) => `d${i}`), projectNoteIds: Array.from({ length: 8 }, (_, i) => `p${i}`) },
]) assert.throws(() => readDocumentBindingCommand(invalid));
assert.throws(() => prepareAgentDocumentBindings(initial, { ...bind, documentIds: ['missing'] }), /不存在/);
assert.throws(() => prepareAgentDocumentBindings(initial, { ...bind, projectNoteIds: [knowledge.id] }), /不存在/);
assert.throws(() => prepareAgentDocumentBindings({ ...initial, notes: initial.notes.map(note => note.id === root.id ? { ...note, parentId: children[0].id } : note) }, bind), /循环/);
pass('strict IDs, bounded batches, missing objects and cyclic hierarchy fail closed');

// Run the real App commit callback in isolation: only disk/UI/index ports are memory doubles.
const appFile = 'src/App.tsx', appSource = readFileSync(appFile, 'utf8');
const ast = ts.createSourceFile(appFile, appSource, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
let callback: ts.Expression | undefined;
const visit = (node: ts.Node) => {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'commitAgentNoteChange') callback = node.initializer;
  ts.forEachChild(node, visit);
};
visit(ast); assert.ok(callback);
function harness() {
  let scope = initial.scopeId, documents = structuredClone(initial.documents), ready = true, planDraft = false;
  let failSave = false, saves = 0, flushes = 0, beforeStoreWrite: (() => void) | undefined;
  let operationFile: unknown = null, disk = structuredClone(initial.notes);
  const notesRef = { current: structuredClone(initial.notes) }, pendingNotesRef: { current: NoteItem[] | null } = { current: null };
  const store = createAgentOperationStore({ read: async () => structuredClone(operationFile), write: async value => {
    const hook = beforeStoreWrite; beforeStoreWrite = undefined; hook?.(); operationFile = structuredClone(value);
  } });
  let lane: Promise<unknown> = Promise.resolve();
  const save = async (notes: NoteItem[]) => { saves++; if (failSave) throw new Error('synthetic disk failure'); disk = structuredClone(notes); };
  const env = {
    enqueueLearningWrite: (_ref: unknown, work: () => Promise<unknown>) => { const next = lane.catch(() => {}).then(work); lane = next; return next; },
    learningWriteQueueRef: {}, agentTaskScope: async () => scope,
    assertNoPendingAgentPlanEditorDraft: () => { if (planDraft) throw new Error('计划编辑器草案尚未确认'); },
    commitAgentWorkspaceChange: (change: WorkspaceNoteChange, deps: any) => commitAgentWorkspaceChange(change, { ...deps, store }),
    notesRef, pendingNotesRef, applyWorkspaceNoteChange, personalNotePatches: () => null, recalculateBacklinks: (notes: NoteItem[]) => notes,
    personalOnlySaveRef: { current: null }, trackPersonalOnlySave: () => null, saveTimerRef: { current: null }, clearTimeout,
    setNotes: () => {}, noteSaveRevisionRef: { current: 0 }, setNoteSaveState: () => {},
    acknowledgedSaveState: (_current: number, _revision: number, saved: boolean) => saved ? 'saved' : 'error',
    savePersonalStateOnly: async () => false, saveAllNotesToStorage: save,
    acknowledgePersonalSave: () => null, deleteNoteIndex: async () => {}, indexNote: async () => {},
    finishDeletedNoteIndexCleanup: async () => {},
    setActiveNoteIdState: () => {}, setActiveProjectContextId: () => {},
  };
  const code = ts.transpileModule(`const actual = ${callback!.getText(ast)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const commit = new Function(...Object.keys(env), `${code}\nreturn actual;`)(...Object.values(env));
  const service = createDocumentBindingPort({
    assertReady: () => { if (!ready) throw new Error('资料库未就绪'); }, scope: async () => scope,
    list: async () => structuredClone(documents), notes: () => notesRef.current,
    commit: (change, scopeId, preflight) => commit(change, undefined, scopeId, preflight),
    flush: async scopeId => { if (scope !== scopeId) throw new Error('scope changed'); flushes++; if (pendingNotesRef.current) { await save(pendingNotesRef.current); pendingNotesRef.current = null; } },
  });
  const ctx = { documentBindings: service, getNotes: () => notesRef.current, getActiveNote: () => notesRef.current[0],
    ensureDataFresh: async () => {}, getPlanDraftSession: () => null, getResourceDraftSession: () => null } as unknown as AgentRuntimeContext;
  return { service, ctx, store, notesRef, get disk() { return disk; }, get saves() { return saves; }, get flushes() { return flushes; },
    set scope(value: string) { scope = value; }, set ready(value: boolean) { ready = value; }, set planDraft(value: boolean) { planDraft = value; },
    set failSave(value: boolean) { failSave = value; }, set beforeStoreWrite(value: () => void) { beforeStoreWrite = value; },
    set documents(value: UploadedDocument[]) { documents = value; } };
}
const cache = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => cache.get(key) || null,
  setItem: (key: string, value: string) => cache.set(key, value), removeItem: (key: string) => cache.delete(key) } });
bootstrapAgentRuntime(AGENT_ROLES.default);
assert.ok(AGENT_ROLES.default.allowedTools.includes('query_local_documents'));
assert.ok(AGENT_ROLES.default.allowedTools.includes('update_document_project_bindings'));
const resourceRole = applyAgentSkill(AGENT_ROLES.default, getAgentSkill('resource-curation')!);
assert.ok(resourceRole.allowedTools.includes('update_document_project_bindings'));
const discovered: AgentToolStep = { call: { id: 'discovery', name: 'discover_agent_capabilities', arguments: { domains: ['resources'] } }, ok: true };
const limited = { ...AGENT_ROLES.default, allowedTools: ['discover_agent_capabilities'], skillToolCeiling: ['discover_agent_capabilities'] };
assert.equal(expandAgentCapabilities(limited, [discovered]).allowedTools.includes('update_document_project_bindings'), false);
assert.equal(toolRequiresApproval(getTool('update_document_project_bindings')!, bind, harness().ctx), true);
assert.equal((await executeTool('query_local_documents', {}, { ...harness().ctx, documentBindings: undefined })).ok, false);
pass('real bootstrap/default/resource capability discovery and approval ceiling');

const originalFetch = globalThis.fetch;
let network = 0;
globalThis.fetch = async () => { network++; throw new Error('Network forbidden'); };
try {
  const h = harness();
  let rounds = 0;
  const turn = await runAgentTurn({ role: AGENT_ROLES.default, requestedSkillId: 'resource-curation',
    userText: '把刚上传的人类心理3000年资料关联到根项目', history: [], ctx: h.ctx, memoryPrefixLoader: async () => '', enableMultiAgent: false,
    callLlm: async request => {
      assert.ok(request.tools?.some(tool => tool.name === 'update_document_project_bindings'));
      rounds++;
      if (rounds === 1) return { content: '', toolCalls: [{ id: 'list-docs', name: 'query_local_documents', arguments: { fileNameContains: '人类心理' } }] };
      if (rounds === 2) return { content: '', toolCalls: [{ id: 'list-projects', name: 'list_notes', arguments: { noteType: 'project', titleContains: root.title } }] };
      return { content: '', toolCalls: [{ id: 'bind', name: 'update_document_project_bindings', arguments: bind }] };
    } });
  assert.equal(h.saves, 0); assert.equal(h.notesRef.current[0].resources!.length, 1);
  assert.equal(turn.pendingApproval?.items[0].call.name, 'update_document_project_bindings');
  assert.match(turn.pendingApproval!.items[0].impacts!.join('\n'), /人类心理3000年.pdf/);
  assert.match(turn.pendingApproval!.items[0].impacts!.join('\n'), /后代/);
  await resolveAgentApproval({ role: AGENT_ROLES.default, approval: turn.pendingApproval!, approved: false, history: turn.updatedHistory,
    ctx: h.ctx, callLlm: async () => ({ content: '已取消。' }) });
  assert.equal(h.saves, 0);
  // Page focus can change while waiting; the explicit approved root ID remains the target.
  h.ctx.getActiveNote = () => h.notesRef.current.find(note => note.id === children[0].id)!;
  const approved = await resolveAgentApproval({ role: AGENT_ROLES.default, approval: turn.pendingApproval!, approved: true,
    history: turn.updatedHistory, ctx: h.ctx, callLlm: async () => ({ content: '资料关联已保存。' }) });
  const write = approved.toolTrace.find(step => step.ok && step.call.name === 'update_document_project_bindings')!;
  assert.ok(write, JSON.stringify(approved.toolTrace));
  assert.equal((write.result as any).saved, true); assert.equal(h.saves, 1);
  assert.deepEqual(directDocumentProjects(h.disk, book.id), [root.id]);
  assert.equal(agentActionRecoveryReason('资料关联已保存。', 'resource-curation', [write]), undefined);
  const operation = await h.store.get((write.result as any).operationId);
  const undone = applyWorkspaceNoteChange(h.notesRef.current, prepareOperationUndo(h.notesRef.current, operation));
  assert.deepEqual(directDocumentProjects(undone, book.id), []);
  assert.ok(children.every(child => projectDocumentBindings(child, h.disk).some(row => row.documentId === book.id && row.inherited)));
  pass('real Agent query → confirmation/cancel → App save → inherited access → recoverable operation');

  for (const mutate of [
    (h: ReturnType<typeof harness>) => { h.scope = 'changed-after-card'; },
    (h: ReturnType<typeof harness>) => { h.documents = []; },
    (h: ReturnType<typeof harness>) => { h.notesRef.current = h.notesRef.current.map(note => note.id === root.id ? { ...note, resources: [{ title: book.fileName, url: `loginote-document://${book.id}`, documentId: book.id, kind: 'local' }] } : note); },
  ]) {
    const h = harness(), call = { id: 'pending-binding', name: 'update_document_project_bindings', arguments: bind };
    const binding = await createAgentApprovalBinding(call, h.ctx);
    mutate(h);
    await assert.rejects(validateAgentApprovalBinding({ call, binding, title: 'Synthetic approval', description: 'Synthetic' }, h.ctx));
    assert.equal(h.saves, 0);
  }
  assert.ok(agentActionRecoveryReason('资料关联已保存。', 'resource-curation', [{ ok: true,
    call: { id: 'not-saved', name: 'update_document_project_bindings', arguments: bind }, result: { saved: false } }]));
  pass('pending confirmation binds live scope/document/association state; saved=false cannot prove success');

  for (const mutate of [
    (h: ReturnType<typeof harness>) => { h.scope = 'different-scope'; },
    (h: ReturnType<typeof harness>) => { h.documents = []; },
    (h: ReturnType<typeof harness>) => { h.documents = [{ ...book, fileName: 'changed.pdf' }]; },
    (h: ReturnType<typeof harness>) => { h.notesRef.current = h.notesRef.current.map(note => note.id === root.id ? { ...note, title: 'changed title' } : note); },
  ]) {
    const h = harness(), expected = documentBindingApproval(await h.service.read(), bind);
    mutate(h); await assert.rejects(h.service.apply(bind, expected)); assert.equal(h.saves, 0);
  }
  pass('scope/document deletion/identity change/target changes reject stale approved data');

  for (const mutate of [
    (h: ReturnType<typeof harness>) => { h.scope = 'changed-during-recovery-write'; },
    (h: ReturnType<typeof harness>) => { h.documents = []; },
    (h: ReturnType<typeof harness>) => { h.planDraft = true; },
    (h: ReturnType<typeof harness>) => { h.notesRef.current = h.notesRef.current.map(note => note.id === root.id ? { ...note, content: 'new user edit' } : note); },
  ]) {
    const h = harness(), expected = documentBindingApproval(await h.service.read(), bind);
    h.beforeStoreWrite = () => mutate(h);
    await assert.rejects(h.service.apply(bind, expected)); assert.equal(h.saves, 0);
  }
  pass('actual App commit revalidates scope/documents/drafts/edits after recovery-record I/O');

  const failed = harness(); failed.failSave = true;
  await assert.rejects(failed.service.apply(bind, documentBindingApproval(await failed.service.read(), bind)), /disk failure/);
  assert.deepEqual(directDocumentProjects(failed.disk, book.id), []);
  failed.failSave = false;
  const retried = await failed.service.apply(bind, documentBindingApproval(await failed.service.read(), bind));
  assert.equal(retried.saved, true); assert.equal(retried.unchanged, true); assert.equal(failed.flushes, 1);
  assert.deepEqual(directDocumentProjects(failed.disk, book.id), [root.id]);
  const noop = await failed.service.apply(bind, documentBindingApproval(await failed.service.read(), bind));
  assert.equal(noop.unchanged, true); assert.equal(failed.saves, 2, 'a repeated successful bind does not write duplicate references');
  const inherited = await failed.service.apply(unbindChild, documentBindingApproval(await failed.service.read(), unbindChild));
  assert.equal(inherited.bindings[0].directlyBound, false);
  assert.deepEqual(inherited.bindings[0].inheritedFromProjectIds, [root.id]);
  pass('failed disk writes are not success; identical retry flushes pending state; inherited unbind is explicit');
  assert.equal(network, 0);
} finally { globalThis.fetch = originalFetch; }
console.log(`Agent document bindings: ${groups} groups passed; synthetic memory-only IO, no network/model/private-vault access.`);
