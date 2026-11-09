import assert from 'node:assert/strict';
import type { NoteItem, ResourceItem, UploadedDocument } from '../src/types';
import { createDocumentBindingPort, documentBindingApproval, prepareAgentDocumentBindings, queryLocalDocumentBindings,
  type DocumentBindingCatalog, type DocumentBindingCommand } from '../src/services/agent/documentBindings';
import { directDocumentProjects } from '../src/services/documentProjectBindings';
import { projectDocumentBindings } from '../src/services/projectResourceScope';
import { applyWorkspaceNoteChange, type WorkspaceNoteChange } from '../src/services/agent/workspaceOperations';
import { commitAgentWorkspaceChange, createAgentOperationStore, prepareOperationUndo } from '../src/services/agent/operationStore';

// Actual binding preparation, persistence ports and undo records; memory-only IO.
// No real vault, filesystem copy, index job or network operation is involved.
globalThis.fetch = async () => { throw new Error('Shared-document checks must not contact the network'); };
const timestamp = '2026-11-08T01:00:00.000Z';
const shared: UploadedDocument = { id: 'shared-rag-book', fileName: '基于大模型的RAG应用开发与优化.pdf',
  fileType: 'pdf', extension: '.pdf', indexable: true, size: 12345, status: 'pending', parseStatus: 'pending',
  chunkCount: 0, totalChars: 0, uploadAt: timestamp };
const local = (documentId: string): ResourceItem => ({ title: documentId, documentId,
  url: `loginote-document://${documentId}`, kind: 'local', fileType: 'pdf' });
const project = (id: string, extra: Partial<NoteItem> = {}): NoteItem => ({ id, title: id, noteType: 'project',
  content: `项目 ${id} 的原正文\n- [ ] 原有学习任务`, tags: [], links: [], backlinks: [], dueDates: [], resources: [],
  createdAt: timestamp, updatedAt: timestamp, ...extra });
const rootA = project('root-a', { title: 'LLM 原理与前沿', resources: [local(shared.id),
  { title: 'A 原有在线链接', url: 'https://synthetic.invalid/a-retained', kind: 'online' }] });
const rootB = project('root-b', { title: 'RAG 应用工程', resources: [local('other-book')] });
const childB = project('child-b', { parentId: rootB.id });
const rootC = project('root-c', { title: '检索系统实践' });
const childC = project('child-c', { parentId: rootC.id, resources: [{ title: 'C 原有案例', url: 'https://synthetic.invalid/c-retained' }] });
const siblingC = project('sibling-c', { parentId: rootC.id });
const unrelated = project('unrelated-root', { resources: [local('unrelated-document')] });
const initial: DocumentBindingCatalog = { scopeId: 'memory-only-shared-documents', documents: [shared],
  notes: [rootA, rootB, childB, rootC, childC, siblingC, unrelated] };
const command: DocumentBindingCommand = { action: 'bind', documentIds: [shared.id], projectNoteIds: [rootB.id, childC.id] };
const sorted = (ids: string[]) => [...ids].sort();
const normalizedDocuments = (documents: Array<{ documentId: string; directProjectNoteIds: string[] }>) => documents
  .map(document => ({ ...document, directProjectNoteIds: sorted(document.directProjectNoteIds) }))
  .sort((a, b) => a.documentId.localeCompare(b.documentId));
const expectedAll = sorted([rootA.id, rootB.id, childC.id]);

const prepared = prepareAgentDocumentBindings(initial, command)!;
assert.deepEqual(sorted(prepared.after.map(note => note.id)), sorted(command.projectNoteIds));
const projected = applyWorkspaceNoteChange(initial.notes, prepared);
assert.deepEqual(sorted(directDocumentProjects(projected, shared.id)), expectedAll);
assert.deepEqual(projected.find(note => note.id === rootA.id), rootA, 'preexisting A binding and its unrelated link stay byte-for-byte unchanged');
assert.deepEqual(projected.find(note => note.id === rootB.id)!.resources![0], rootB.resources![0]);
assert.deepEqual(projected.find(note => note.id === childC.id)!.resources![0], childC.resources![0]);
for (const before of initial.notes) assert.equal(projected.find(note => note.id === before.id)!.content, before.content);
assert.ok(projectDocumentBindings(projected.find(note => note.id === childB.id)!, projected).some(binding => binding.documentId === shared.id && binding.inherited));
assert.equal(projectDocumentBindings(projected.find(note => note.id === siblingC.id)!, projected).some(binding => binding.documentId === shared.id), false);
assert.equal(projectDocumentBindings(projected.find(note => note.id === rootC.id)!, projected).some(binding => binding.documentId === shared.id), false);
console.log('PASS one existing document appends to two projects across roots, preserving A, original bodies/resources and ancestor-only inheritance');

let liveNotes = structuredClone(initial.notes), durableNotes = structuredClone(initial.notes), writes = 0, flushes = 0;
let operationFile: unknown = null;
const store = createAgentOperationStore({ read: async () => structuredClone(operationFile), write: async file => { operationFile = structuredClone(file); } });
const commit = async (change: WorkspaceNoteChange, undoRecordId?: string, preflight?: () => Promise<void>) =>
  commitAgentWorkspaceChange(change, { store, undoRecordId, readNotes: () => liveNotes,
    saveAndApply: async next => { await preflight?.(); liveNotes = applyWorkspaceNoteChange(liveNotes, next); durableNotes = structuredClone(liveNotes); writes++; } });
const service = createDocumentBindingPort({ assertReady() {}, scope: async () => initial.scopeId,
  list: async () => structuredClone(initial.documents), notes: () => liveNotes,
  commit: async (change, scopeId, preflight) => { assert.equal(scopeId, initial.scopeId); return commit(change, undefined, preflight); },
  flush: async scopeId => { assert.equal(scopeId, initial.scopeId); durableNotes = structuredClone(liveNotes); flushes++; } });

const before = await service.read();
const listed = queryLocalDocumentBindings(before, { documentIds: [shared.id] });
assert.deepEqual(listed.bindingPolicy, { multipleProjects: true, bindMode: 'append', sharedDocumentId: true });
assert.equal(listed.documents[0].directProjectCount, 1);
assert.equal(listed.documents[0].directProjects[0].id, rootA.id);
const receipt = await service.apply(command, documentBindingApproval(before, command));
assert.equal(receipt.saved, true); assert.equal(receipt.unchanged, false); assert.ok(receipt.operationId);
assert.deepEqual(sorted(receipt.changedNoteIds), sorted(command.projectNoteIds));
assert.equal(receipt.bindings.length, 2); assert.ok(receipt.bindings.every(binding => binding.directlyBound));
assert.deepEqual(normalizedDocuments(receipt.documents), [{ documentId: shared.id, directProjectNoteIds: expectedAll }]);
assert.deepEqual(sorted(directDocumentProjects(durableNotes, shared.id)), expectedAll);
const readback = queryLocalDocumentBindings(await service.read(), { documentIds: [shared.id] });
assert.equal(readback.documents[0].directProjectCount, 3);
assert.deepEqual(sorted(readback.documents[0].directProjects.map(note => note.id)), expectedAll);
assert.deepEqual((await service.read()).documents, initial.documents, 'document identity, pending index state and descriptor are not changed or duplicated');
console.log('PASS public binding policy and saved receipt expose all three associations, including the untouched original A; durable readback matches');

const repeated = await service.apply(command, documentBindingApproval(await service.read(), command));
assert.equal(repeated.saved, true); assert.equal(repeated.unchanged, true); assert.equal(writes, 1); assert.equal(flushes, 1);
assert.deepEqual(repeated.documents, receipt.documents);
assert.equal(prepareAgentDocumentBindings(await service.read(), command), null);
for (const id of expectedAll) assert.equal(liveNotes.find(note => note.id === id)!.resources!.filter(resource => resource.documentId === shared.id).length, 1);
console.log('PASS repeated bind is idempotent, flushes acknowledgement, and creates neither repeated links nor another source file/index');

const removeB: DocumentBindingCommand = { ...command, action: 'unbind', projectNoteIds: [rootB.id] };
const removed = await service.apply(removeB, documentBindingApproval(await service.read(), removeB));
assert.equal(removed.saved, true); assert.ok(removed.operationId);
assert.deepEqual(sorted(directDocumentProjects(durableNotes, shared.id)), sorted([rootA.id, childC.id]));
assert.deepEqual(normalizedDocuments(removed.documents), [{ documentId: shared.id, directProjectNoteIds: sorted([rootA.id, childC.id]) }]);
assert.deepEqual(liveNotes.find(note => note.id === rootB.id)!.resources, rootB.resources);
assert.deepEqual(liveNotes.find(note => note.id === rootA.id), rootA);
assert.equal((await service.read()).documents.length, 1);
console.log('PASS unbinding B preserves A and C, B unrelated resources, and the single shared document');

const undoUnbind = prepareOperationUndo(liveNotes, await store.get(removed.operationId!));
await commit(undoUnbind, removed.operationId);
assert.deepEqual(sorted(directDocumentProjects(durableNotes, shared.id)), expectedAll);
const undoAppend = prepareOperationUndo(liveNotes, await store.get(receipt.operationId!));
await commit(undoAppend, receipt.operationId);
assert.deepEqual(directDocumentProjects(durableNotes, shared.id), [rootA.id]);
assert.deepEqual(durableNotes, initial.notes, 'undo of the appended associations restores original notes and retains the original A binding');
assert.equal((await store.get(receipt.operationId!)).status, 'undone');
assert.equal((await store.get(removed.operationId!)).status, 'undone');
assert.deepEqual((await service.read()).documents, initial.documents);
console.log('PASS actual recoverable-operation undo restores only the selected association delta and retains the prior A binding and original document identity');
