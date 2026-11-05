import assert from 'node:assert/strict';
import { S2PluginHost, type S2ResourceReadDiagnostic } from '../src/services/scene/sceneS2PluginHost';
import { S2TextResource, readS2TextSelectionFailure } from '../src/services/scene/sceneS2TextResource';
import { S2ProjectNoteSource, S2ProjectNoteResource } from '../src/services/scene/sceneS2ProjectNotes';
import { S2PluginProtocolError } from '../src/services/scene/sceneS2PluginProtocol';
import { s2RuntimeIssue, s2TextFileSelectionIssue } from '../src/services/scene/sceneS2RuntimeIssues';
import { createS2Scene } from '../src/services/scene/sceneS2Canvas';
import { s2ConnectionNodeLabel } from '../src/services/scene/sceneS2Connections';
import type { S2PluginInvocation } from '../src/types/sceneS2Plugin';
import type { S2Document } from '../src/types/sceneS2';
import { browserResourceDefinition, browserResourceRequest, browserResourceText } from './fixtures/s2-browser-definition';
import { harness } from './scene-s2-ui-harness';

const definition = structuredClone(browserResourceDefinition), original = JSON.stringify(browserResourceDefinition);
const ids = definition.initial.execution!.nodes.map(node => node.id);
definition.initial.composites = [{ id: 'outer', label: '合成资料组合', nodeIds: ids }, { id: 'inner', label: '完整资料处理', nodeIds: ids, parentId: 'outer' }];
const hosts: S2PluginHost[] = [], uis: ReturnType<typeof harness>[] = [];
const oldFetch = globalThis.fetch, nativeRead = File.prototype.arrayBuffer;
let fileReads = 0, network = 0;
File.prototype.arrayBuffer = function () { fileReads++; return nativeRead.call(this); };
globalThis.fetch = async () => { network++; throw new Error('Content recovery uses synthetic data only'); };
const diagnostic = (source: 'file' | 'note', reason: S2ResourceReadDiagnostic['reason']): S2ResourceReadDiagnostic => ({ kind: 'resource-read', source, reason });
const textFile = (value = browserResourceText) => new File([value], '合成正文.txt');
function data() {
  const state = { body: browserResourceText, version: 'v1', reads: 0, useOverride: false, override: null as unknown };
  const source = new S2ProjectNoteSource({ projectId: 'synthetic-project', list: () => [{ noteId: 'note', label: '合成笔记', updatedAt: state.version }],
    read: async noteId => { state.reads++; return state.useOverride ? state.override as { noteId: string; updatedAt: string; text: string } : { noteId, updatedAt: state.version, text: state.body }; } });
  return { source, state };
}
function hostFor(source?: S2ProjectNoteSource) { const host = new S2PluginHost('SyntheticContentRecovery', definition); hosts.push(host); if (source) host.bindProjectNotes(source); return host; }
function documentFor(nodeId: string, id: string) { const document = structuredClone(definition.initial); document.execution!.nodes.find(node => node.id === nodeId)!.bindings.resource = { kind: 'literal', value: id }; return document; }
const call: S2PluginInvocation = { protocolVersion: 1, id: 'SyntheticCall', sceneId: 'SyntheticScene', runId: 'SyntheticRun', revision: 1, nodeId: 'SyntheticNode', pluginId: 'local-material', pluginVersion: '1.0.0', capabilityId: 'read-text', idempotencyKey: 'SyntheticKey', inputs: { resource: ['SyntheticInput'] } };
async function capture(operation: () => Promise<unknown>) { let error: unknown; try { await operation(); } catch (caught) { error = caught; } assert.ok(error); return error; }
async function waitFor(test: () => boolean, render = () => {}) { for (let i = 0; i < 600; i++) { render(); if (test()) return; await new Promise(resolve => setImmediate(resolve)); } assert.fail('Content recovery did not settle'); }
try {
  for (const [file, reason, message] of [
    [new File([new Uint8Array([0xc3, 0x28])], '合成编码.txt'), 'file-encoding', '资料不是有效的 UTF-8 文本，请转换编码后重新选择。'],
    [textFile('x'.repeat(6001)), 'file-text-limit', '资料超过6000字符或含非文本内容；未截断或发布结果。'],
    [textFile('x'.repeat(6000) + '\0'), 'file-text-limit', '资料超过6000字符或含非文本内容；未截断或发布结果。'],
    [textFile('合成\0正文'), 'file-non-text', '资料超过6000字符或含非文本内容；未截断或发布结果。'],
    [textFile('😀'.repeat(3001)), 'file-text-limit', '资料超过6000字符或含非文本内容；未截断或发布结果。'],
  ] as const) {
    const host = hostFor(), info = host.approveTextFile(file); host.setDocument(documentFor('fileRead', info.id));
    const failed = await host.enqueueWorkflow(['fileView']).completion;
    assert.deepEqual(host.readWorkflowDiagnostic(failed.id, 'fileRead'), diagnostic('file', reason)); assert.equal(host.remainingCalls, 63);
    assert.equal(host.history().length, 1); assert.deepEqual(host.history()[0].artifacts, []); assert.equal(host.history()[0].receipt.error!.message, message);
    assert.equal(host.history()[0].receipt.error!.code, 'ADAPTER_FAILURE'); assert.equal(failed.nodes.find(node => node.nodeId === 'fileParse')!.status, 'blocked');
    const issue = s2RuntimeIssue(definition, documentFor('fileRead', info.id), 'fileRead', diagnostic('file', reason))!;
    assert.equal(issue.resourceSource, 'file'); assert.ok(!JSON.stringify(issue).includes(info.id)); assert.match(issue.detail, /扣次保留/);
  }
  // Empty/whitespace native files and exact original Unicode/BOM/placeholder text remain legal complete text.
  for (const text of ['', '  \n\t', 'x'.repeat(6000), '😀'.repeat(3000), '\uFEFF  原文\r\n{{literal}} $&  ']) {
    const host = hostFor(), info = host.approveTextFile(textFile(text)); host.setDocument(documentFor('fileRead', info.id));
    const result = await host.enqueueWorkflow(['fileRead']).completion; assert.equal(result.status, 'succeeded');
    const output = host.currentArtifact(result.nodes[0].artifactIds[0]); assert.equal(output.payload.kind, 'inline');
    if (output.payload.kind === 'inline') assert.equal(output.payload.value, text);
    assert.equal(host.readWorkflowDiagnostic(result.id, 'fileRead'), null);
  }
  for (const [body, reason] of [['', 'note-empty'], [' \r\n\t', 'note-empty'], [' '.repeat(6001), 'note-empty'], ['合'.repeat(6001), 'note-text-limit'], ['x'.repeat(6000) + '\0', 'note-text-limit'], ['合成\0正文', 'note-non-text']] as const) {
    const source = data(); source.state.body = body; const host = hostFor(source.source), info = host.approveProjectNote('note'); host.setDocument(documentFor('noteRead', info.id));
    const result = await host.enqueueWorkflow(['noteView']).completion;
    assert.deepEqual(host.readWorkflowDiagnostic(result.id, 'noteRead'), diagnostic('note', reason)); assert.equal(source.state.reads, 1); assert.equal(host.remainingCalls, 63);
    assert.equal(host.history()[0].receipt.error!.message, '笔记正文为空、过大或含非文本内容；未截断，请整理笔记后重新选择。');
    assert.deepEqual(host.history()[0].artifacts, []); assert.equal(host.projectNoteSummary()[0].available, true, 'Invalid body is not metadata revocation');
  }
  for (const reply of [null, { noteId: 'other', updatedAt: 'v1', text: '原文' }, { noteId: 'note', updatedAt: 'v0', text: '原文' }, { noteId: 'note', updatedAt: 'v1', text: 0 }]) {
    const source = data(); source.state.useOverride = true; source.state.override = reply;
    const host = hostFor(source.source), info = host.approveProjectNote('note'); host.setDocument(documentFor('noteRead', info.id));
    const result = await host.enqueueWorkflow(['noteRead']).completion; assert.deepEqual(host.readWorkflowDiagnostic(result.id, 'noteRead'), diagnostic('note', 'note-response-mismatch'));
    assert.equal(host.history()[0].receipt.error!.message, '笔记读取身份或版本不匹配，未发布结果。');
  }
  for (const source of ['file', 'note'] as const) {
    const noteData = data(); noteData.state.body = '  '; const resource = source === 'file' ? new S2TextResource(textFile('\0')) : new S2ProjectNoteResource(noteData.source, 'note');
    const error = await capture(() => resource.read(call, new AbortController().signal));
    assert.ok(resource.contentFailure(error, call)); assert.equal(resource.contentFailure(structuredClone(error), call), null);
    assert.equal(resource.contentFailure(new Error((error as Error).message), call), null); assert.equal(resource.contentFailure(error, { ...call, id: 'DifferentInvocation' }), null);
    const other = source === 'file' ? new S2TextResource(textFile('\0')) : new S2ProjectNoteResource(noteData.source, 'note'); assert.equal(other.contentFailure(error, call), null);
  }
  const signalData = data(); signalData.state.body = '  '; const choice = signalData.source.choices()[0], signal = new AbortController().signal;
  const sourceError = await capture(() => signalData.source.readCurrent(choice, signal));
  assert.equal(signalData.source.contentFailure(sourceError, choice, signal), 'note-empty');
  assert.equal(signalData.source.contentFailure(sourceError, choice, new AbortController().signal), null);
  assert.equal(signalData.source.contentFailure(sourceError, { ...choice, updatedAt: 'other' }, signal), null);
  assert.equal(data().source.contentFailure(sourceError, choice, signal), null);
  // Replaying a formerly native error from a later reader call is still not current evidence.
  let replayError: unknown, replay = false;
  const replaySource = new S2ProjectNoteSource({ projectId: 'synthetic-project', list: () => [{ noteId: 'note', label: '合成重放测试', updatedAt: 'v1' }],
    read: async noteId => { if (replay) throw replayError; return { noteId, updatedAt: 'v1', text: ' ' }; } });
  const replayResource = new S2ProjectNoteResource(replaySource, 'note'); replayError = await capture(() => replayResource.read(call, new AbortController().signal)); replay = true;
  const newCall = { ...call, id: 'SyntheticLaterCall' }; const replayed = await capture(() => replayResource.read(newCall, new AbortController().signal));
  assert.equal(replayed, replayError); assert.equal(replayResource.contentFailure(replayed, newCall), null);
  // Failed selection checks never read bytes or alter an existing grant/binding/ledger.
  for (const [file, reason, code] of [[new File(['x'.repeat(24001)], '合成大文件.txt'), 'file-byte-limit', 'RESOURCE_TOO_LARGE'], [new File(['x'], '合成.pdf'), 'unsupported-file-name', 'INVALID_RESOURCE'], [{} as File, 'invalid-file', 'INVALID_RESOURCE']] as const) {
    const host = hostFor(), prior = host.approveTextFile(textFile()), before = JSON.stringify([host.textResourceSummary(), host.history(), host.remainingCalls]), reads = fileReads;
    let error: unknown; try { host.approveTextFile(file); } catch (caught) { error = caught; }
    assert.ok(error instanceof S2PluginProtocolError); assert.equal(error.code, code); assert.equal(readS2TextSelectionFailure(error), reason);
    const expected = { kind: 'file-selection', reason }; assert.deepEqual(host.readTextFileSelectionDiagnostic(error), expected);
    assert.equal(host.readTextFileSelectionDiagnostic(structuredClone(error)), null); assert.equal(host.readTextFileSelectionDiagnostic(new Error(error.message)), null);
    assert.equal(hostFor().readTextFileSelectionDiagnostic(error), null); assert.equal(fileReads, reads); assert.equal(JSON.stringify([host.textResourceSummary(), host.history(), host.remainingCalls]), before);
    assert.ok(s2TextFileSelectionIssue(expected)); assert.equal(s2TextFileSelectionIssue({ ...expected, filename: 'private' }), null);
    host.revokeTextFile(prior.id); assert.equal(host.readTextFileSelectionDiagnostic(error), null);
  }
  const boundary = hostFor(); assert.ok(boundary.approveTextFile(textFile('x'.repeat(24000))));
  // A forged reader/native-byte exception cannot claim a decoder or note-content failure.
  const fakeNote = new S2ProjectNoteSource({ projectId: 'synthetic-project', list: () => [{ noteId: 'note', label: '合成笔记', updatedAt: 'v1' }], read: async () => { throw new S2PluginProtocolError('INVALID_NOTE_TEXT', 'resource', '笔记正文为空、过大或含非文本内容；未截断，请整理笔记后重新选择。'); } });
  const fakeHost = hostFor(fakeNote), fakeInfo = fakeHost.approveProjectNote('note'); fakeHost.setDocument(documentFor('noteRead', fakeInfo.id));
  const fakeRun = await fakeHost.enqueueWorkflow(['noteRead']).completion; assert.equal(fakeHost.readWorkflowDiagnostic(fakeRun.id, 'noteRead'), null);
  File.prototype.arrayBuffer = async function () { fileReads++; throw new Error('资料不是有效的 UTF-8 文本，请转换编码后重新选择。'); };
  const fakeFileHost = hostFor(), fakeFile = fakeFileHost.approveTextFile(textFile()); fakeFileHost.setDocument(documentFor('fileRead', fakeFile.id));
  const fakeFileRun = await fakeFileHost.enqueueWorkflow(['fileRead']).completion; assert.equal(fakeFileHost.readWorkflowDiagnostic(fakeFileRun.id, 'fileRead'), null);
  File.prototype.arrayBuffer = function () { fileReads++; return nativeRead.call(this); };
  // Late invalid text never replaces cancellation/revocation/revision facts.
  for (const ending of ['cancel', 'revoke', 'revision'] as const) {
    let entered = false, finish!: (result: { noteId: string; updatedAt: string; text: string }) => void;
    const source = new S2ProjectNoteSource({ projectId: 'synthetic-project', list: () => [{ noteId: 'note', label: '延迟合成', updatedAt: 'v1' }], read: async () => { entered = true; return new Promise(resolve => { finish = resolve; }); } });
    const host = hostFor(source), info = host.approveProjectNote('note'), document = documentFor('noteRead', info.id); host.setDocument(document);
    const run = host.enqueueWorkflow(['noteRead']); await waitFor(() => entered);
    if (ending === 'cancel') host.cancelWorkflow(run.id); else if (ending === 'revoke') host.revokeProjectNote(info.id); else { const changed = structuredClone(document); changed.execution!.nodes[0].position.x++; changed.execution!.nodes[0].presentation!.label = 'Changed'; host.setDocument(changed); }
    await run.completion; finish({ noteId: 'note', updatedAt: 'v1', text: '   ' }); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(host.readWorkflowDiagnostic(run.id, 'noteRead'), ending === 'revoke' ? diagnostic('note', 'revoked') : null); assert.deepEqual(host.history()[0].artifacts, []);
  }
  const allReasons = ['file-encoding', 'file-text-limit', 'file-non-text', 'note-empty', 'note-text-limit', 'note-non-text', 'note-response-mismatch'] as const;
  for (const source of ['file', 'note'] as const) for (const reason of allReasons) {
    const nodeId = source === 'file' ? 'fileRead' : 'noteRead', raw = diagnostic(source, reason);
    assert.equal(!!s2RuntimeIssue(definition, definition.initial, nodeId, raw), reason.startsWith(`${source}-`));
    assert.equal(s2RuntimeIssue(definition, definition.initial, nodeId, { ...raw, text: 'private body' }), null);
  }
  const privateDocument = structuredClone(definition.initial); let materialReads = 0;
  Object.defineProperty(privateDocument.execution!.nodes[0].bindings, 'resource', { get() { materialReads++; assert.fail('No diagnostic body/handle inspection'); }, enumerable: true });
  assert.ok(s2RuntimeIssue(definition, privateDocument, 'fileRead', diagnostic('file', 'file-encoding'))); assert.equal(materialReads, 0);

  for (const deferred of [false, true]) {
    const source = data(), scene = createS2Scene(browserResourceRequest); scene.canvasWorkspace = structuredClone(definition); let live!: S2PluginHost;
    const ui = harness({ initialDraft: scene, initialRequest: browserResourceRequest, projectNoteSource: source.source, deferStateUpdates: deferred, onHost: host => { live = host; } }); uis.push(ui);
    ui.button('开始试验').props.onClick(); ui.render();
    const document = (): S2Document => ui.elements().find(item => item.type === 'run-summary')!.props.document;
    const focus = (id: string) => { ui.labelControl('选择执行节点', 'select').props.onChange({ target: { value: id } }); ui.render(); };
    const panel = () => ui.elements().find(item => item.props['aria-label'] === '运行问题与恢复');
    const settle = (test: () => boolean) => waitFor(test, ui.render);
    const pickFile = (file: File) => { const target = { files: [file], value: 'fakepath' }; ui.labelControl('选择并允许本局读取文本资料', 'input').props.onChange({ target }); ui.render(); assert.equal(target.value, ''); };
    const ledger = () => JSON.stringify([document(), live.textResourceSummary(), live.projectNoteSummary(), live.history(), live.workflowHistory(), live.remainingCalls, fileReads, source.state.reads, ui.modelCalls(), ui.saved]);
    let fileFocus = 0, noteFocus = 0;
    ui.elements().find(item => item.props['aria-label'] === '本局文本资料')!.props.ref.current = { focus() { fileFocus++; }, scrollIntoView() {} };
    ui.elements().find(item => item.props['aria-label'] === '本局项目知识笔记')!.props.ref.current = { focus() { noteFocus++; }, scrollIntoView() {} };
    const reads = fileReads; pickFile(textFile('x'.repeat(24001))); assert.match(ui.text(panel()), /24000字节/); assert.equal(live.remainingCalls, 64); assert.equal(fileReads, reads); assert.equal(live.textResourceSummary().length, 0);
    const oldSelectionView = ui.button('查看本局文本资料设置（不读取）').props.onClick, beforeView = ledger(); oldSelectionView(); ui.render(); assert.equal(fileFocus, 1); assert.equal(ledger(), beforeView);
    oldSelectionView(); ui.render(); assert.equal(fileFocus, 1);
    pickFile(textFile('x'.repeat(24001))); const oldAfterNewPick = ui.button('查看本局文本资料设置（不读取）').props.onClick;
    pickFile(new File(['x'], '合成.pdf')); oldAfterNewPick(); ui.render(); assert.equal(fileFocus, 1, 'A newer rejected selection retires the old navigation without a grant change');
    pickFile(new File([new Uint8Array([0xc3, 0x28])], '合成正文.txt')); const bad = live.textResourceSummary()[0]; assert.ok(!panel());
    focus('fileRead'); ui.labelControl('为读取步骤选择资料', 'select').props.onChange({ target: { value: bad.id } }); ui.render(); focus('fileView');
    ui.button('运行所选步骤').props.onClick(); await settle(() => live.workflowHistory().at(-1)?.status === 'failed');
    ui.button(`查看运行问题 · ${s2ConnectionNodeLabel(definition, document(), 'fileRead')}`).props.onClick(); ui.render(); assert.match(ui.text(panel()), /UTF-8/);
    const oldBodyView = ui.button('查看本局文本资料设置（不读取）').props.onClick, beforeBodyView = ledger(); oldBodyView(); ui.render(); assert.equal(fileFocus, 2); assert.equal(ledger(), beforeBodyView);
    ui.elements().find(item => item.type === 'button' && item.props['aria-label'] === '撤回资料 合成正文.txt')!.props.onClick(); ui.render(); pickFile(textFile()); const good = live.textResourceSummary()[0];
    oldBodyView(); ui.render(); assert.equal(fileFocus, 2); ui.button('运行所选步骤').props.onClick(); await settle(() => live.workflowHistory().at(-1)?.status === 'failed'); assert.equal(live.remainingCalls, 63);
    focus('fileRead'); ui.labelControl('为读取步骤选择资料', 'select').props.onChange({ target: { value: good.id } }); ui.render(); focus('fileView');
    ui.button('运行所选步骤').props.onClick(); await settle(() => live.workflowHistory().at(-1)?.status === 'succeeded'); assert.equal(live.remainingCalls, 60);
    source.state.body = ' \n '; ui.labelControl('选择并允许本局读取知识笔记', 'select').props.onChange({ target: { value: 'note' } }); ui.render(); const note = live.projectNoteSummary()[0];
    focus('noteRead'); ui.labelControl('为读取步骤选择笔记', 'select').props.onChange({ target: { value: note.id } }); ui.render(); ui.button('运行所选步骤').props.onClick(); await settle(() => live.workflowHistory().at(-1)?.status === 'failed');
    ui.button(`查看运行问题 · ${s2ConnectionNodeLabel(definition, document(), 'noteRead')}`).props.onClick(); ui.render(); assert.match(ui.text(panel()), /为空或只有空白/);
    const oldNoteView = ui.button('查看本局项目笔记设置（不读取）').props.onClick, beforeNote = ledger(); oldNoteView(); ui.render(); assert.equal(noteFocus, 1); assert.equal(ledger(), beforeNote);
    source.state.body = browserResourceText; source.state.version = 'v2'; ui.render();
    ui.elements().find(item => item.type === 'button' && item.props['aria-label'] === '撤回笔记 合成笔记')!.props.onClick(); ui.render();
    ui.labelControl('选择并允许本局读取知识笔记', 'select').props.onChange({ target: { value: 'note' } }); ui.render(); const renewed = live.projectNoteSummary()[0];
    oldNoteView(); ui.render(); assert.equal(noteFocus, 1); focus('noteRead'); ui.labelControl('为读取步骤选择笔记', 'select').props.onChange({ target: { value: renewed.id } }); ui.render(); focus('noteView');
    ui.button('运行所选步骤').props.onClick(); await settle(() => live.workflowHistory().at(-1)?.status === 'succeeded'); assert.equal(live.remainingCalls, 56); assert.equal(source.state.reads, 2);
    pickFile(textFile('x'.repeat(24001))); const endView = ui.button('查看本局文本资料设置（不读取）').props.onClick;
    const beforeEdit = JSON.stringify(document()); ui.button('＋练习笔记').props.onClick(); ui.render(); ui.keyShortcut('undo'); ui.render(); assert.equal(JSON.stringify(document()), beforeEdit);
    endView(); ui.render(); assert.equal(fileFocus, 2); ui.button('结束试验').props.onClick(); endView(); oldNoteView(); ui.render();
    assert.equal(fileFocus, 2); assert.equal(noteFocus, 1); assert.equal(ui.modelCalls(), 0); assert.equal(ui.saved.length, 0);
  }
  assert.equal(network, 0); assert.equal(JSON.stringify(browserResourceDefinition), original);
  console.log('S2 resource content recovery passed: exact native UTF-8/length/NUL/blank/reply facts, original errors and first-cause ordering, empty File vs blank note distinction, UTF-16/byte boundaries and raw text fidelity, resource/invocation/signal-bound error evidence, fake/clone/foreign/late rejection, zero-read selection failure and current one-use production recovery under ordinary/deferred hooks, separate manual allow/bind/run, original debit and downstream/cache/permission gates. Synthetic files/in-memory notes only; no real resource, network, model or semantic acceptance. Browser focus checked separately.');
} finally { uis.forEach(ui => ui.dispose()); hosts.forEach(host => host.close()); globalThis.fetch = oldFetch; File.prototype.arrayBuffer = nativeRead; }
