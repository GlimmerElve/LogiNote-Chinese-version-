import assert from 'node:assert/strict';
import { S2PluginHost, type S2ResourceReadDiagnostic } from '../src/services/scene/sceneS2PluginHost';
import { S2ProjectNoteSource, S2ProjectNoteResource } from '../src/services/scene/sceneS2ProjectNotes';
import { S2PluginProtocolError } from '../src/services/scene/sceneS2PluginProtocol';
import { s2RuntimeIssue } from '../src/services/scene/sceneS2RuntimeIssues';
import { createS2Scene } from '../src/services/scene/sceneS2Canvas';
import { s2ConnectionNodeLabel } from '../src/services/scene/sceneS2Connections';
import { browserResourceDefinition, browserResourceRequest, browserResourceText } from './fixtures/s2-browser-definition';
import { harness } from './scene-s2-ui-harness';
import type { S2Document } from '../src/types/sceneS2';

const definition = structuredClone(browserResourceDefinition), original = JSON.stringify(definition);
const ids = definition.initial.execution!.nodes.map(node => node.id);
definition.initial.composites = [{ id: 'outer', label: '资料组合', nodeIds: ids }, { id: 'inner', label: '读取与展示', nodeIds: ids, parentId: 'outer' }];
const hosts: S2PluginHost[] = [], uis: ReturnType<typeof harness>[] = [];
const oldFetch = globalThis.fetch, nativeRead = File.prototype.arrayBuffer;
let network = 0, fileReads = 0;
globalThis.fetch = async () => { network++; throw new Error('Resource recovery is synthetic and offline'); };
File.prototype.arrayBuffer = function () { fileReads++; return nativeRead.call(this); };
const diagnostic = (source: S2ResourceReadDiagnostic['source'], reason: S2ResourceReadDiagnostic['reason']): S2ResourceReadDiagnostic => ({ kind: 'resource-read', source, reason });
const file = () => new File([browserResourceText], '合成资料.json', { type: 'application/json' });
function sourceData() {
  const state = { version: 'v1', present: true, invalidScope: false, reads: 0, body: browserResourceText, readerError: null as unknown };
  const source = new S2ProjectNoteSource({ projectId: 'synthetic-project',
    list: () => { if (state.invalidScope) throw new Error('Synthetic unavailable metadata'); return state.present ? [{ noteId: 'note', label: '合成项目知识', updatedAt: state.version }] : []; },
    read: async noteId => { state.reads++; if (state.readerError) throw state.readerError; return { noteId, updatedAt: state.version, text: state.body }; },
  });
  return { source, state };
}
function hostFor(source?: S2ProjectNoteSource) {
  const host = new S2PluginHost('SyntheticResourceRecovery', definition); hosts.push(host); if (source) host.bindProjectNotes(source); return host;
}
function documentFor(nodeId: string, handle: string): S2Document {
  const document = structuredClone(definition.initial); document.execution!.nodes.find(node => node.id === nodeId)!.bindings.resource = { kind: 'literal', value: handle }; return document;
}
async function waitFor(test: () => boolean, render = () => {}) {
  for (let i = 0; i < 600; i++) { render(); if (test()) return; await new Promise(resolve => setImmediate(resolve)); } assert.fail('Synthetic resource recovery did not settle');
}
try {
  // No grants, a foreign/path/old-template handle and an explicitly revoked handle are distinct native cases.
  for (const [nodeId, kind] of [['fileRead', 'file'], ['noteRead', 'note']] as const) {
    const data = sourceData(), host = hostFor(data.source); host.setDocument(documentFor(nodeId, '../not-a-resource'));
    const blocked = await host.enqueueWorkflow([nodeId]).completion;
    assert.deepEqual(host.readWorkflowDiagnostic(blocked.id, nodeId), diagnostic(kind, 'not-approved'));
    assert.equal(host.remainingCalls, 64); assert.equal(host.history().length, 0); assert.equal(data.state.reads, 0);
    const info = kind === 'file' ? host.approveTextFile(file()) : host.approveProjectNote('note');
    assert.equal(host.readWorkflowDiagnostic(blocked.id, nodeId), null, 'Changing authorization retires old diagnostics');
    host.setDocument(documentFor(nodeId, info.id)); const success = await host.enqueueWorkflow([nodeId]).completion;
    assert.equal(success.status, 'succeeded'); const spent = host.remainingCalls, readCount = fileReads + data.state.reads;
    if (kind === 'file') host.revokeTextFile(info.id); else host.revokeProjectNote(info.id);
    const revoked = await host.enqueueWorkflow([nodeId]).completion;
    assert.deepEqual(host.readWorkflowDiagnostic(revoked.id, nodeId), diagnostic(kind, 'revoked'));
    const clone = host.readWorkflowDiagnostic(revoked.id, nodeId) as S2ResourceReadDiagnostic; clone.reason = 'not-approved';
    assert.deepEqual(host.readWorkflowDiagnostic(revoked.id, nodeId), diagnostic(kind, 'revoked'));
    assert.equal(host.remainingCalls, spent); assert.equal(fileReads + data.state.reads, readCount);
    const readArtifact = host.currentArtifact; host.currentArtifact = () => assert.fail('Diagnostic cannot resolve artifacts');
    const issue = s2RuntimeIssue(definition, documentFor(nodeId, info.id), nodeId, host.readWorkflowDiagnostic(revoked.id, nodeId))!;
    host.currentArtifact = readArtifact;
    assert.ok(!JSON.stringify(issue).includes(info.id)); assert.ok(!JSON.stringify(issue).includes(browserResourceText));
    assert.match(issue.title, /已撤回/);
    const second = kind === 'file' ? host.approveTextFile(file()) : host.approveProjectNote('note'); assert.notEqual(second.id, info.id);
    assert.equal(host.readWorkflowDiagnostic(revoked.id, nodeId), null);
    const oldBinding = await host.enqueueWorkflow([nodeId]).completion;
    assert.deepEqual(host.readWorkflowDiagnostic(oldBinding.id, nodeId), diagnostic(kind, 'revoked'));
    assert.equal(host.remainingCalls, spent, 'Providing the same name does not change the old binding');
    host.setDocument(documentFor(nodeId, second.id)); assert.equal((await host.enqueueWorkflow([nodeId]).completion).status, 'succeeded');
  }
  for (const [change, reason] of [['version', 'note-changed'], ['missing', 'note-missing'], ['scope', 'note-scope-unavailable']] as const) {
    const data = sourceData(), host = hostFor(data.source), info = host.approveProjectNote('note'); host.setDocument(documentFor('noteRead', info.id));
    if (change === 'version') data.state.version = 'v2'; else if (change === 'missing') data.state.present = false; else data.state.invalidScope = true;
    assert.equal(host.projectNoteSummary()[0].available, false);
    const blocked = await host.enqueueWorkflow(['noteRead']).completion; assert.deepEqual(host.readWorkflowDiagnostic(blocked.id, 'noteRead'), diagnostic('note', reason));
    assert.equal(host.remainingCalls, 64); assert.equal(data.state.reads, 0); assert.equal(host.history().length, 0);
    data.state.version = 'v1'; data.state.present = true; data.state.invalidScope = false;
    const restored = await host.enqueueWorkflow(['noteRead']).completion;
    assert.deepEqual(host.readWorkflowDiagnostic(restored.id, 'noteRead'), diagnostic('note', reason), 'Observed invalidation stays invalid after metadata undo');
    assert.equal(host.readWorkflowDiagnostic(blocked.id, 'noteRead'), null);
    host.revokeProjectNote(info.id); const renewed = host.approveProjectNote('note'); host.setDocument(documentFor('noteRead', renewed.id));
    assert.equal((await host.enqueueWorkflow(['noteView']).completion).status, 'succeeded'); assert.equal(data.state.reads, 1);
  }
  // Native branding is object-specific; a reader imitating NOTE_CHANGED is not a metadata failure.
  const brandData = sourceData(), resource = new S2ProjectNoteResource(brandData.source, 'note'); brandData.state.version = 'v2';
  let branded: unknown; try { resource.assertAvailable(); } catch (error) { branded = error; }
  assert.equal(resource.availabilityFailure(branded), 'note-changed'); assert.equal(resource.availabilityFailure(structuredClone(branded)), null);
  assert.equal(new S2ProjectNoteResource(brandData.source, 'note').availabilityFailure(branded), null);
  for (const error of [new S2PluginProtocolError('NOTE_CHANGED', 'resource', '笔记已更新、删除或不在原项目范围内'), new Error('Synthetic unknown reader error')]) {
    const data = sourceData(), host = hostFor(data.source), info = host.approveProjectNote('note'); data.state.readerError = error; host.setDocument(documentFor('noteRead', info.id));
    const failed = await host.enqueueWorkflow(['noteRead']).completion; assert.equal(host.readWorkflowDiagnostic(failed.id, 'noteRead'), null);
    assert.equal(host.remainingCalls, 63); assert.deepEqual(host.history()[0].artifacts, []);
  }
  // Changes/revocation while a real host read is pending do not publish late text or stop an unrelated file branch.
  for (const ending of ['revoke', 'change', 'cancel'] as const) {
    let entered = false, version = 'v1', finish!: (value: { noteId: string; updatedAt: string; text: string }) => void;
    const source = new S2ProjectNoteSource({ projectId: 'synthetic-project', list: () => [{ noteId: 'note', label: '延迟合成笔记', updatedAt: version }],
      read: async () => { entered = true; return new Promise(resolve => { finish = resolve; }); } });
    const host = hostFor(source), note = host.approveProjectNote('note'), text = host.approveTextFile(file()), document = documentFor('noteRead', note.id);
    document.execution!.nodes.find(node => node.id === 'fileRead')!.bindings.resource = { kind: 'literal', value: text.id }; host.setDocument(document);
    const run = host.enqueueWorkflow(['noteRead', 'fileRead']); await waitFor(() => entered);
    if (ending === 'revoke') host.revokeProjectNote(note.id); else if (ending === 'change') version = 'v2'; else host.cancelWorkflow(run.id);
    if (ending === 'change') finish({ noteId: 'note', updatedAt: 'v1', text: browserResourceText });
    const settled = await run.completion;
    assert.deepEqual(host.readWorkflowDiagnostic(run.id, 'noteRead'), ending === 'cancel' ? null : diagnostic('note', ending === 'revoke' ? 'revoked' : 'note-changed'));
    if (ending !== 'cancel') assert.equal(settled.nodes.find(node => node.nodeId === 'fileRead')!.status, 'succeeded');
    finish({ noteId: 'note', updatedAt: 'v1', text: browserResourceText }); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(host.history().find(entry => entry.request.nodeId === 'noteRead')!.artifacts, []);
  }
  // Explicit delayed native-byte seam, not a real file read or a fabricated resource failure.
  let fileEntered = false, releaseFile!: (bytes: ArrayBuffer) => void;
  File.prototype.arrayBuffer = function () { fileReads++; fileEntered = true; return new Promise(resolve => { releaseFile = resolve; }); };
  const fileHost = hostFor(), delayedFile = fileHost.approveTextFile(file()); fileHost.setDocument(documentFor('fileRead', delayedFile.id));
  const pendingFile = fileHost.enqueueWorkflow(['fileRead']); await waitFor(() => fileEntered); fileHost.revokeTextFile(delayedFile.id);
  await pendingFile.completion; assert.deepEqual(fileHost.readWorkflowDiagnostic(pendingFile.id, 'fileRead'), diagnostic('file', 'revoked'));
  assert.equal(fileHost.history()[0].receipt.status, 'cancelled'); assert.equal(fileHost.remainingCalls, 63);
  releaseFile(new Uint8Array(new TextEncoder().encode(browserResourceText)).buffer); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(fileHost.history()[0].artifacts, []);
  File.prototype.arrayBuffer = function () { fileReads++; return nativeRead.call(this); };
  for (const source of ['file', 'note'] as const) for (const reason of ['not-approved', 'revoked', 'note-changed', 'note-missing', 'note-scope-unavailable'] as const) {
    const nodeId = source === 'file' ? 'fileRead' : 'noteRead', raw = diagnostic(source, reason);
    const issue = s2RuntimeIssue(definition, definition.initial, nodeId, raw);
    assert.equal(!!issue, source === 'note' || ['not-approved', 'revoked'].includes(reason));
    if (issue) assert.deepEqual(issue.nodeIds, [nodeId]);
    assert.equal(s2RuntimeIssue(definition, definition.initial, nodeId, { ...raw, handle: 'forged' }), null);
    assert.equal(s2RuntimeIssue(definition, definition.initial, 'fileParse', raw), null);
  }
  const privateDocument = structuredClone(definition.initial); let materialReads = 0;
  Object.defineProperty(privateDocument.execution!.nodes[0].bindings, 'resource', { enumerable: true, get() { materialReads++; assert.fail('Formatter cannot inspect resource selections'); } });
  assert.ok(s2RuntimeIssue(definition, privateDocument, 'fileRead', diagnostic('file', 'revoked'))); assert.equal(materialReads, 0);
  // Real production handlers, both ordinary and deferred React hooks. Focus/layout are checked separately in browser.
  for (const deferred of [false, true]) {
    const data = sourceData(), scene = createS2Scene(browserResourceRequest); scene.canvasWorkspace = structuredClone(definition);
    let live!: S2PluginHost;
    const ui = harness({ initialRequest: browserResourceRequest, initialDraft: scene, projectNoteSource: data.source, deferStateUpdates: deferred, onHost: host => { live = host; } }); uis.push(ui);
    ui.button('开始试验').props.onClick(); ui.render();
    const document = (): S2Document => ui.elements().find(item => item.type === 'run-summary')!.props.document;
    const focus = (id: string) => { ui.labelControl('选择执行节点', 'select').props.onChange({ target: { value: id } }); ui.render(); };
    const settle = (test: () => boolean) => waitFor(test, ui.render);
    const panel = () => ui.elements().find(item => item.props['aria-label'] === '运行问题与恢复');
    const ledger = () => JSON.stringify([document(), live.history(), live.workflowHistory(), live.remainingCalls, data.state.reads, fileReads, ui.modelCalls(), ui.saved]);
    let noteFocus = 0, textFocus = 0;
    ui.elements().find(item => item.props['aria-label'] === '本局项目知识笔记')!.props.ref.current = { focus() { noteFocus++; }, scrollIntoView() {} };
    ui.elements().find(item => item.props['aria-label'] === '本局文本资料')!.props.ref.current = { focus() { textFocus++; }, scrollIntoView() {} };
    focus('noteRead'); ui.button('运行所选步骤').props.onClick(); ui.render(); assert.ok(panel()); assert.equal(live.workflowHistory().length, 0);
    const beforeMissing = ledger(), oldMissingView = ui.button('查看本局项目笔记设置（不读取）').props.onClick;
    oldMissingView(); ui.render(); assert.equal(noteFocus, 1); assert.equal(ledger(), beforeMissing); oldMissingView(); ui.render(); assert.equal(noteFocus, 1);
    ui.labelControl('选择并允许本局读取知识笔记', 'select').props.onChange({ target: { value: 'note' } }); ui.render();
    const note = live.projectNoteSummary()[0]; assert.equal(data.state.reads, 0);
    focus('noteRead'); ui.labelControl('为读取步骤选择笔记', 'select').props.onChange({ target: { value: note.id } }); ui.render();
    data.state.version = 'v2'; ui.render(); ui.button('运行所选步骤').props.onClick(); await settle(() => live.workflowHistory().at(-1)?.status === 'failed');
    const viewIssue = () => { ui.button(`查看运行问题 · ${s2ConnectionNodeLabel(definition, document(), 'noteRead')}`).props.onClick(); ui.render(); };
    viewIssue(); assert.match(ui.text(panel()), /版本已变化/); assert.equal(live.remainingCalls, 64); assert.equal(data.state.reads, 0);
    const staleView = ui.button('查看本局项目笔记设置（不读取）').props.onClick, beforeView = ledger(); staleView(); ui.render();
    assert.equal(noteFocus, 2); assert.equal(ledger(), beforeView); staleView(); ui.render(); assert.equal(noteFocus, 2);
    viewIssue(); const preEditView = ui.button('查看本局项目笔记设置（不读取）').props.onClick, beforeEdit = JSON.stringify(document());
    ui.button('＋练习笔记').props.onClick(); ui.render(); ui.keyShortcut('undo'); ui.render(); assert.equal(JSON.stringify(document()), beforeEdit);
    preEditView(); ui.render(); assert.equal(noteFocus, 2);
    ui.elements().find(item => item.type === 'button' && item.props['aria-label'] === '撤回笔记 合成项目知识')!.props.onClick(); ui.render();
    ui.labelControl('选择并允许本局读取知识笔记', 'select').props.onChange({ target: { value: 'note' } }); ui.render(); const renewed = live.projectNoteSummary()[0]; assert.notEqual(renewed.id, note.id);
    assert.equal(data.state.reads, 0); focus('noteRead'); ui.button('运行所选步骤').props.onClick(); await settle(() => live.workflowHistory().at(-1)?.status === 'failed');
    viewIssue(); assert.match(ui.text(panel()), /已撤回/); const oldGrantView = ui.button('查看本局项目笔记设置（不读取）').props.onClick;
    ui.labelControl('选择并允许本局读取文本资料', 'input').props.onChange({ target: { files: [new File(['{}'], '独立合成.txt')], value: 'fakepath' } }); ui.render();
    oldGrantView(); ui.render(); assert.equal(noteFocus, 2, 'A changed resource grant retires the exact old recovery entry without any document edit');
    ui.elements().find(item => item.type === 'button' && item.props['aria-label'] === '撤回资料 独立合成.txt')!.props.onClick(); ui.render();
    focus('noteRead'); ui.button('运行所选步骤').props.onClick(); await settle(() => live.workflowHistory().at(-1)?.status === 'failed'); viewIssue();
    const related = ui.button(`查看相关步骤 · ${s2ConnectionNodeLabel(definition, document(), 'noteRead')}`).props.onClick;
    related(); ui.render(); assert.ok(ui.text().includes('正在编辑：读取与展示')); assert.equal(data.state.reads, 0);
    viewIssue(); const oldAfterRenew = ui.button('查看本局项目笔记设置（不读取）').props.onClick;
    ui.labelControl('为读取步骤选择笔记', 'select').props.onChange({ target: { value: renewed.id } }); ui.render(); oldAfterRenew(); ui.render(); assert.equal(noteFocus, 2);
    focus('noteView'); ui.button('运行所选步骤').props.onClick(); await settle(() => live.workflowHistory().at(-1)?.status === 'succeeded'); assert.equal(data.state.reads, 1);
    const remaining = live.remainingCalls;
    focus('fileRead'); ui.button('运行所选步骤').props.onClick(); ui.render(); const fileView = ui.button('查看本局文本资料设置（不读取）').props.onClick;
    const beforeFileView = ledger(); fileView(); ui.render(); assert.equal(textFocus, 1); assert.equal(ledger(), beforeFileView);
    const target = { files: [file()], value: 'fakepath' }; ui.labelControl('选择并允许本局读取文本资料', 'input').props.onChange({ target }); ui.render(); assert.equal(target.value, '');
    const text = live.textResourceSummary()[0]; focus('fileRead'); ui.labelControl('为读取步骤选择资料', 'select').props.onChange({ target: { value: text.id } }); ui.render();
    ui.elements().find(item => item.type === 'button' && item.props['aria-label'] === '撤回资料 合成资料.json')!.props.onClick(); ui.render();
    ui.button('运行所选步骤').props.onClick(); await settle(() => live.workflowHistory().at(-1)?.status === 'failed');
    ui.button(`查看运行问题 · ${s2ConnectionNodeLabel(definition, document(), 'fileRead')}`).props.onClick(); ui.render(); assert.match(ui.text(panel()), /文本资料已撤回/);
    const endView = ui.button('查看本局文本资料设置（不读取）').props.onClick; ui.button('结束试验').props.onClick(); endView(); ui.render();
    assert.equal(textFocus, 1); assert.equal(live.remainingCalls, remaining); assert.equal(ui.modelCalls(), 0); assert.equal(ui.saved.length, 0); assert.equal(data.state.reads, 1);
  }
  assert.equal(network, 0); assert.equal(JSON.stringify(browserResourceDefinition), original);
  console.log('S2 resource recovery passed: native unapproved/revoked/changed/missing/scope evidence, sticky invalidation and exact object branding, original errors/debits and no late output, isolated file/note permissions, same-name renewal never rebinding, metadata-only diagnostics, production readonly focus requests, missing-input recovery, nested step navigation and separate manual allow/bind/run, stale/duplicate/edit-undo/authorization/end guards under ordinary/deferred hooks. Synthetic File/in-memory notes only; zero model/network/real resource IO. Browser focus checked separately.');
} finally { uis.forEach(ui => ui.dispose()); hosts.forEach(host => host.close()); globalThis.fetch = oldFetch; File.prototype.arrayBuffer = nativeRead; }
