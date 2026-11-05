import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import React from 'react';
import ts from 'typescript';
import type { NoteItem, UploadedDocument } from '../src/types';
import { projectAncestors, projectDisplayPath, projectDocumentBindings } from '../src/services/projectResourceScope';
import { directDocumentProjects, prepareDocumentProjectBindings } from '../src/services/documentProjectBindings';
import { applyWorkspaceNoteChange } from '../src/services/agent/workspaceOperations';
import { projectPlanningSnapshot, textbookHash } from '../src/services/textbook/fingerprint';
import { prepareTextbook, textbookApprovalSnapshot, queryTextbookState, type TextbookGenerationDependencies } from '../src/services/textbook/generation';
import type { AgentRuntimeContext } from '../src/services/agent/types';
import type { TextbookJob } from '../src/services/textbook/generationTypes';

globalThis.fetch = async () => { throw new Error('Live network forbidden'); };
const note = (id: string, parentId?: string): NoteItem => ({ id, title: id, noteType: 'project', parentId, content: '原正文',
  tags: [], links: [], backlinks: [], dueDates: [], createdAt: '2026-01-01', updatedAt: '2026-01-01' });
const resource = (documentId: string) => ({ documentId, title: documentId, url: `loginote-document://${documentId}`, kind: 'local' as const });
const doc: UploadedDocument = { id: 'doc-book', fileName: '概率论与数理统计.pdf', fileType: 'pdf', extension: '.pdf', indexable: true,
  size: 1, status: 'ready', chunkCount: 1, totalChars: 100, uploadAt: '2026-01-01' };
const root = { ...note('概率论'), resources: [resource('doc-book'), resource('doc-root')] };
const mid = { ...note('随机变量', root.id), resources: [resource('doc-book'), resource('doc-mid')] };
const leaf = { ...note('正态分布', mid.id), resources: [resource('doc-leaf')] };
const sibling = { ...note('数理统计', root.id), resources: [resource('doc-sibling')] };
const other = { ...note('其他计划'), resources: [resource('doc-other')] };
const notes = [root, mid, leaf, sibling, other];
const bindings = projectDocumentBindings(leaf, notes);
assert.deepEqual(bindings.map(item => item.documentId), ['doc-leaf', 'doc-book', 'doc-mid', 'doc-root']);
assert.equal(bindings.find(item => item.documentId === 'doc-book')?.projectNoteId, mid.id, 'nearest binding wins');
assert.equal(bindings[0].inherited, false);
assert.equal(bindings[1].inherited, true);
assert.equal(projectDisplayPath(leaf, notes), '概率论 / 随机变量 / 正态分布');
assert.throws(() => projectAncestors({ ...leaf, parentId: 'missing' }, notes), /失效/);
assert.throws(() => projectAncestors(leaf, notes.map(item => item.id === root.id ? { ...root, parentId: leaf.id } : item)), /循环/);
console.log('PASS ancestor-only scope, deduplication, provenance, broken/cyclic hierarchy');

const selected = ['doc-book'];
const baseline = await textbookHash(projectPlanningSnapshot(leaf, notes, selected));
const irrelevant = notes.map(item => item.id === root.id ? { ...root, content: '父级备注修改', resources: [...root.resources, resource('doc-new')] } : item);
assert.equal(await textbookHash(projectPlanningSnapshot(leaf, irrelevant, selected)), baseline);
const removed = notes.map(item => item.id === mid.id ? { ...mid, resources: [resource('doc-mid')] } : item);
assert.notEqual(await textbookHash(projectPlanningSnapshot(leaf, removed, selected)), baseline, 'moving a pinned binding to another ancestor needs reconfirmation');
assert.deepEqual(projectPlanningSnapshot(leaf, notes, []), projectPlanningSnapshot(leaf), 'legacy/non-inherited snapshots stay compatible');
console.log('PASS pinned inheritance snapshot and unrelated parent edits');

const change = prepareDocumentProjectBindings(notes, doc, [root.id, other.id], [root.id, mid.id])!;
const changed = applyWorkspaceNoteChange(notes, change);
assert.deepEqual(directDocumentProjects(changed, doc.id), [root.id, other.id]);
assert.equal(changed.find(item => item.id === mid.id)?.content, mid.content);
assert.deepEqual(changed.find(item => item.id === mid.id)?.resources, [resource('doc-mid')]);
assert.equal(changed.find(item => item.id === other.id)?.resources?.at(-1)?.url, `loginote-document://${doc.id}`);
assert.equal(changed.find(item => item.id === other.id)?.resources?.at(-1)?.fileType, 'pdf');
assert.equal(prepareDocumentProjectBindings(changed, doc, [root.id, other.id], [root.id, other.id]), null);
assert.equal(prepareDocumentProjectBindings(changed, doc, [root.id, other.id], [root.id, mid.id]), null, 'retry after an optimistic save must not duplicate bindings');
assert.throws(() => prepareDocumentProjectBindings(changed, doc, [], [root.id, mid.id]), /已变化/);
assert.throws(() => prepareDocumentProjectBindings(notes, doc, ['missing'], [root.id, mid.id]), /失效/);
assert.throws(() => applyWorkspaceNoteChange(notes.map(item => item.id === mid.id ? { ...mid, content: '并发正文编辑' } : item), change), /变化|修改|过期/);
console.log('PASS add/remove bindings only, no body/file mutation, stable IDs and CAS');

// Real prepare/query/approval functions with a synthetic bridge and in-memory job store.
// Keep the fixture local after the application's legacy default migration.
const settings = { providers: [{ id: 'deepseek-default', name: 'offline', apiType: 'ollama', baseUrl: 'http://127.0.0.1:11434', selectedModel: 'mock', models: ['mock'], enabled: true }], defaultProviderId: 'deepseek-default', workflowBinding: {} };
Object.assign(globalThis, { localStorage: { getItem: (key: string) => key === 'loginote_llm_settings' ? JSON.stringify(settings) : null, setItem() {} },
  window: { electronAPI: { ragDocs: { list: async () => [doc] }, textbook: { list: async () => [] } } } });
let currentNotes = notes, storedJob: TextbookJob;
const ctx = { getNotes: () => currentNotes, getActiveNote: () => leaf, ensureDataFresh: async () => {} } as unknown as AgentRuntimeContext;
const deps = { documentHash: async () => 'a'.repeat(64), providerHash: async () => 'b'.repeat(64),
  command: async (input: any) => { if (input.op === 'create') storedJob = { id: 'fixture-job', spec: input.spec, schemaVersion: 1, stage: 'prepared', checkpoint: {}, attempt: 0, createdAt: '', updatedAt: '' } as TextbookJob;
    return { job: storedJob }; } } as unknown as TextbookGenerationDependencies;
const state = await queryTextbookState(ctx, leaf.id) as any;
assert.deepEqual(state.effectiveDocumentIds, bindings.map(item => item.documentId));
assert.deepEqual(state.attachedDocumentIds, ['doc-leaf']);
await prepareTextbook(ctx, { projectNoteId: leaf.id, readBoundUrls: false }, deps);
assert.deepEqual(storedJob!.spec.allowedDocIds, bindings.map(item => item.documentId));
assert.ok(storedJob!.spec.sourceTitles?.some(title => title.includes('继承自项目《随机变量》')));
assert.equal(storedJob!.spec.allowCloud, false);
assert.equal(storedJob!.spec.readBoundUrls, false);
const beforeApproval = await textbookApprovalSnapshot(ctx, storedJob!.id, deps) as any;
currentNotes = irrelevant;
assert.equal((await textbookApprovalSnapshot(ctx, storedJob!.id, deps) as any).planningHash, beforeApproval.planningHash);
currentNotes = removed;
assert.notEqual((await textbookApprovalSnapshot(ctx, storedJob!.id, deps) as any).planningHash, beforeApproval.planningHash);
currentNotes = notes;
await prepareTextbook(ctx, { projectNoteId: leaf.id, allowedDocIds: [], readBoundUrls: false }, deps).then(() => assert.fail('empty explicit scope has no material'), error => assert.match(error.message, /没有可用/));
console.log('PASS real textbook default inheritance, explicit scope, pinned approval, no network/model');

// Execute the real binding section handlers; services cannot reach a real vault/model.
const componentPath = resolve('src/components/DocumentProjectBindingSection.tsx'), require = createRequire(componentPath);
const code = ts.transpileModule(readFileSync(componentPath, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
type Element = { type: any; props: any };
const all = (value: any): Element[] => Array.isArray(value) ? value.flatMap(all) : value?.props ? [value, ...all(value.props.children)] : [];
const text = (value: any): string => Array.isArray(value) ? value.map(text).join('') : value?.props ? text(value.props.children) : typeof value === 'string' || typeof value === 'number' ? String(value) : '';
let slots: any[] = [], cursor = 0, effects: (() => any)[] = [], dirty = false, saves = 0, release!: () => void;
const hooks = { ...React, useId: () => 'test-binding',
  useState: (initial: any) => { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
    return [slots[index], (value: any) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; dirty = true; }]; },
  useRef: (initial: any) => slots[cursor++] ||= { current: initial },
  useEffect: (effect: () => any) => { const index = cursor++; if (!(index in slots)) { slots[index] = true; effects.push(effect); } } };
const module = { exports: {} as any };
runInNewContext(code, { module, exports: module.exports, require: (name: string) => {
  if (name === 'react') return hooks;
  if (name === 'react/jsx-runtime' || name === 'lucide-react') return require(name);
  if (name === '../services/documentProjectBindings') return { directDocumentProjects };
  if (name === '../services/projectResourceScope') return { projectAncestors, projectDisplayPath };
  throw new Error(`Unexpected import ${name}`);
}, Set, Map, JSON, Promise, Error });
const props = { document: doc, notes, disabled: false, getScope: async () => 'scope-fixture',
  onBusyChange: (value: boolean) => { props.disabled = value; }, onSave: async (_doc: UploadedDocument, ids: string[], expected: string[], scope: string) => {
    saves++; assert.equal(scope, 'scope-fixture'); assert.deepEqual(Array.from(expected), [root.id, mid.id]); assert.ok(ids.includes(other.id));
    await new Promise<void>(done => { release = done; });
  } };
let tree: Element;
function render() { cursor = 0; effects = []; tree = module.exports.DocumentProjectBindingSection(props); effects.forEach(effect => effect()); return tree; }
render(); await Promise.resolve(); render();
assert.match(text(tree!), /概率论 \/ 随机变量 \/ 正态分布/);
assert.match(text(tree!), /继承自「随机变量」/);
const otherRow = all(tree!).find(node => node.type === 'label' && text(node).includes('其他计划'))!;
all(otherRow).find(node => node.type === 'input')!.props.onChange({ target: { checked: true } }); render();
const saveButton = all(tree!).find(node => node.type === 'button')!;
assert.equal(saveButton.props.disabled, false);
saveButton.props.onClick(); saveButton.props.onClick(); await Promise.resolve(); render();
assert.equal(saves, 1, 'double submission is synchronously guarded');
assert.equal(all(tree!).find(node => node.type === 'fieldset')!.props.disabled, true);
release(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); render();
assert.match(text(tree!), /项目绑定已保存/);
assert.equal(all(tree!).find(node => node.type === 'button')!.props.disabled, true);
let prevented = false;
all(tree!).find(node => node.type === 'input' && node.props.id === 'test-binding-search')!.props.onKeyDown({ key: 'Enter', preventDefault() { prevented = true; } });
assert.ok(prevented, 'search Enter must not submit the surrounding category form');
props.onSave = async () => { throw new Error('合成保存失败'); };
const otherAfterSave = all(tree!).find(node => node.type === 'label' && text(node).includes('其他计划'))!;
all(otherAfterSave).find(node => node.type === 'input')!.props.onChange({ target: { checked: false } }); render();
all(tree!).find(node => node.type === 'button')!.props.onClick();
await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); render();
assert.match(text(tree!), /合成保存失败/);
assert.equal(all(tree!).find(node => node.type === 'button')!.props.disabled, false, 'a failed save remains retryable');
props.onSave = async (_doc, ids, expected, scope) => {
  assert.equal(scope, 'scope-fixture'); assert.ok(!ids.includes(other.id));
  assert.ok(expected.includes(other.id), 'failed writes do not advance the confirmation baseline');
};
render();
all(tree!).find(node => node.type === 'button')!.props.onClick();
await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); render();
assert.match(text(tree!), /项目绑定已保存/);
assert.ok(!all(tree!).some(node => node.props.role === 'alert'));
console.log('PASS real UI selection, inherited status, save/failure/retry feedback, double click, category isolation');
console.log('Project document bindings checks passed (5 groups).');
