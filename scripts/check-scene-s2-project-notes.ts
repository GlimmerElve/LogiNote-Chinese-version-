// Fixed synthetic replies below intentionally test complete-catalogue compatibility, not progressive discovery.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import type { NoteItem, SceneInitialRequest } from '../src/types';
import type { S2Document } from '../src/types/sceneS2';
import { S2ProjectNoteSource } from '../src/services/scene/sceneS2ProjectNotes';
import { createSceneProjectNoteSource } from '../src/services/scene/sceneProjectNoteAccess';
import { S2PluginHost, S2_LOCAL_RUN_LIMIT } from '../src/services/scene/sceneS2PluginHost';
import { s2RuntimePluginCatalog } from '../src/services/scene/sceneS2PluginRegistry';
import { createS2Scene, designS2Canvas, exportS2Workspace, importS2Workspace } from '../src/services/scene/sceneS2Canvas';
import { s2TableToRecords, type S2Table } from '../src/services/scene/sceneS2Structured';
import { harness } from './scene-s2-ui-harness';

const previousFetch = globalThis.fetch;
let network = 0;
globalThis.fetch = async () => { network++; throw new Error('Project-note checks cannot read real notes, network, RAG or models'); };
const ref = (pluginId: string, capabilityId: string) => ({ pluginId, pluginVersion: '1.0.0', capabilityId });
const noteCap = ref('project-notes', 'read-text'), fileCap = ref('local-material', 'read-text');
const parse = ref('structured-data', 'parse-json'), table = ref('structured-data', 'to-table'), view = ref('structured-view', 'table'), check = ref('json-check', 'validate');
const plugins = [noteCap, fileCap, parse, table, view, check];
const hosts: S2PluginHost[] = [], uis: ReturnType<typeof harness>[] = [];
const records = [{ name: '合成笔记', enabled: false, count: 0, empty: null }, { name: '缺失' }], raw = JSON.stringify(records);
const strategy = { goal: '按需读取所选项目笔记', understanding: '先理解', planning: '明确请求才运行', response: '笔记是参考，不是新权限' };
function data() {
  const reads: string[] = [], bodies = new Map<string, string>();
  const make = (id: string, title: string, noteType: NoteItem['noteType'], parentId?: string): NoteItem => {
    const note = { id, title, noteType, parentId, content: '', links: [], aliases: [], tags: [], backlinks: [], dueDates: [], createdAt: 'v1', updatedAt: 'v1' } as NoteItem;
    bodies.set(id, noteType === 'knowledge' ? raw : 'PRIVATE PROJECT BODY');
    Object.defineProperty(note, 'content', { enumerable: true, configurable: true, get: () => { reads.push(id); return bodies.get(id)!; } });
    Object.defineProperty(note, 'argumentDocs', { get: () => assert.fail('Argument documents are not knowledge-note body input') });
    return note;
  };
  const root = make('root', '所选项目', 'project'), linked = make('linked', '关联知识', 'knowledge'), legacy = make('legacy', '旧式知识', 'knowledge', 'root');
  const child = make('child', '子项目', 'project', 'root'), nested = make('nested', '子项目知识', 'knowledge', 'child');
  const outside = make('outside', '其他项目私有知识', 'knowledge', 'other'), other = make('other', '其他项目', 'project');
  root.links = ['关联知识'];
  const state = { notes: [root, linked, legacy, child, nested, outside, other], reads, bodies, make };
  return { ...state, source: createSceneProjectNoteSource('root', () => state.notes)!, state };
}
function document(resource = 'not-approved'): S2Document {
  return { nodes: [], edges: [], execution: { version: 1, nodes: [
    { ...noteCap, id: 'read', position: { x: 0, y: 0 }, bindings: { resource: { kind: 'literal', value: resource } } },
    { ...parse, id: 'parse', position: { x: 200, y: 0 }, bindings: {} },
    { ...table, id: 'table', position: { x: 400, y: 0 }, bindings: {} },
    { ...view, id: 'view', position: { x: 600, y: 0 }, bindings: {} },
    { ...check, id: 'independent', position: { x: 0, y: 200 }, bindings: { text: { kind: 'literal', value: '{}' } } },
  ], links: [
    { source: { nodeId: 'read', portId: 'text' }, target: { nodeId: 'parse', portId: 'text' } },
    { source: { nodeId: 'parse', portId: 'value' }, target: { nodeId: 'table', portId: 'value' } },
    { source: { nodeId: 'table', portId: 'table' }, target: { nodeId: 'view', portId: 'table' } },
  ] } };
}
function host(source?: S2ProjectNoteSource, allowed = plugins) {
  const result = new S2PluginHost('synthetic-project-notes', allowed); hosts.push(result);
  if (source) result.bindProjectNotes(source); return result;
}
async function settle(ui: ReturnType<typeof harness>, ready: () => boolean) {
  for (let i = 0; i < 400; i++) { ui.render(); if (ready()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Synthetic project-note UI did not settle');
}
try {
  const d = data(), h = host(d.source);
  assert.deepEqual(new Set(h.projectNoteChoices().map(item => item.noteId)), new Set(['linked', 'legacy', 'nested'])); assert.deepEqual(d.reads, []);
  const copy = h.projectNoteChoices(); copy[0].label = 'tampered'; assert.notEqual(h.projectNoteChoices()[0].label, 'tampered');
  d.state.notes.push(d.make('added-later', '新加知识', 'knowledge', 'root'));
  assert.ok(!h.projectNoteChoices().some(item => item.noteId === 'added-later'));
  for (const id of ['outside', 'root', 'added-later', '关联知识', '../notes/private']) assert.throws(() => h.approveProjectNote(id));
  assert.throws(() => h.bindProjectNotes(d.source)); assert.throws(() => host(undefined, []).bindProjectNotes(d.source));
  assert.throws(() => host().bindProjectNotes(JSON.parse('{"projectId":"root"}')));
  assert.throws(() => host().approveProjectNote('linked')); assert.deepEqual(d.reads, []);
  assert.equal(createSceneProjectNoteSource('missing', () => d.state.notes), undefined);
  h.setDocument(document());
  assert.equal((await h.enqueueWorkflow(['view']).completion).status, 'failed');
  assert.equal(h.history().length, 0); assert.equal(h.remainingCalls, S2_LOCAL_RUN_LIMIT); assert.deepEqual(d.reads, []);
  const grant = h.approveProjectNote('linked'); assert.throws(() => h.approveProjectNote('linked'));
  assert.deepEqual(d.reads, []); h.setDocument(document(grant.id));
  const first = await h.enqueueWorkflow(['view']).completion;
  assert.equal(first.status, 'succeeded'); assert.deepEqual(d.reads, ['linked']);
  assert.deepEqual(first.nodes.map(item => item.status), ['succeeded', 'succeeded', 'succeeded', 'displayed']);
  const read = h.history().find(item => item.request.nodeId === 'read')!;
  assert.deepEqual(read.resource, grant); assert.equal(read.artifacts[0].source.invocationId, read.receipt.invocationId);
  const output = h.currentArtifact(first.nodes.at(-1)!.artifactIds[0]);
  if (output.payload.kind !== 'inline') assert.fail('Full result needed');
  assert.deepEqual(s2TableToRecords(output.payload.value as unknown as S2Table), records);
  const prepared = h.prepare('read', strategy, '解释');
  assert.deepEqual(prepared.projectNotes, [{ ...grant, available: true }]);
  assert.equal('projectNoteChoices' in prepared, false); assert.ok(!JSON.stringify(prepared.projectNotes).includes(raw));
  assert.ok(!s2RuntimePluginCatalog([check]).selectionRules.includes('project-notes'));
  assert.ok(s2RuntimePluginCatalog([noteCap]).selectionRules.includes('project-notes'));
  await h.enqueueWorkflow(['view']).completion; assert.deepEqual(d.reads, ['linked', 'linked'], 'Read-only resources are never pure cached calls');

  // File and note grants do not borrow or erase each other's permission.
  const file = h.approveTextFile(new File(['separate file'], 'synthetic.txt'));
  h.revokeProjectNote(grant.id);
  const spent = h.remainingCalls; assert.equal((await h.enqueueWorkflow(['read']).completion).status, 'failed'); assert.equal(h.remainingCalls, spent);
  const fileDoc = document(file.id); fileDoc.execution!.nodes[0] = { ...fileDoc.execution!.nodes[0], ...fileCap };
  h.setDocument(fileDoc); assert.equal((await h.enqueueWorkflow(['read']).completion).status, 'succeeded');
  const newGrant = h.approveProjectNote('linked'); h.revokeTextFile(file.id); h.setDocument(document(newGrant.id));
  assert.equal((await h.enqueueWorkflow(['read']).completion).status, 'succeeded');
  const foreign = host(data().source); foreign.approveProjectNote('linked'); foreign.setDocument(document(newGrant.id));
  assert.equal((await foreign.enqueueWorkflow(['read']).completion).status, 'failed'); assert.equal(foreign.history().length, 0);

  for (const change of ['version', 'title', 'unlink', 'delete', 'move', 'project-delete'] as const) {
    const state = data(), target = host(state.source), selected = target.approveProjectNote(change === 'move' ? 'legacy' : 'linked'); target.setDocument(document(selected.id));
    const originalNotes = [...state.state.notes], rootLinks = [...state.state.notes[0].links];
    if (change === 'version') state.state.notes.find(item => item.id === 'linked')!.updatedAt = 'v2';
    if (change === 'title') state.state.notes.find(item => item.id === 'linked')!.title = '改名';
    if (change === 'unlink') state.state.notes[0].links = [];
    if (change === 'delete') state.state.notes = state.state.notes.filter(item => item.id !== 'linked');
    if (change === 'move') state.state.notes.find(item => item.id === 'legacy')!.parentId = 'other';
    if (change === 'project-delete') state.state.notes = state.state.notes.filter(item => item.id !== 'root');
    assert.equal(target.projectNoteSummary()[0].available, false);
    assert.equal((await target.enqueueWorkflow(['read']).completion).status, 'failed');
    assert.equal(target.history().length, 0); assert.equal(target.remainingCalls, S2_LOCAL_RUN_LIMIT); assert.deepEqual(state.reads, []);
    state.state.notes = originalNotes; state.state.notes[0].links = rootLinks;
    state.state.notes.find(item => item.id === 'linked')!.updatedAt = 'v1'; state.state.notes.find(item => item.id === 'linked')!.title = '关联知识';
    state.state.notes.find(item => item.id === 'legacy')!.parentId = 'root';
    assert.equal(target.projectNoteSummary()[0].available, false, 'Undo of an observed resource invalidation must not resurrect the old grant');
    assert.equal((await target.enqueueWorkflow(['read']).completion).status, 'failed');
    assert.equal(target.remainingCalls, S2_LOCAL_RUN_LIMIT); assert.deepEqual(state.reads, []);
  }
  for (const text of ['', '请对该知识点进行定义描述', 'x'.repeat(6001), '\0binary']) {
    const state = data(); state.bodies.set('linked', text);
    const target = host(state.source), selected = target.approveProjectNote('linked'); target.setDocument(document(selected.id));
    assert.deepEqual(state.reads, []); assert.equal((await target.enqueueWorkflow(['view']).completion).status, 'failed');
    assert.deepEqual(target.history()[0].artifacts, []); assert.equal(target.remainingCalls, S2_LOCAL_RUN_LIMIT - 1);
  }
  const limitedData = data(); limitedData.state.notes.push(limitedData.make('four', '第四份', 'knowledge', 'root'), limitedData.make('five', '第五份', 'knowledge', 'root'));
  const limited = host(createSceneProjectNoteSource('root', () => limitedData.state.notes)!);
  for (const id of ['linked', 'legacy', 'nested', 'four']) limited.approveProjectNote(id);
  assert.throws(() => limited.approveProjectNote('five'), /4/); assert.deepEqual(limitedData.reads, []);

  for (const ending of ['revoke', 'change-during-read', 'timeout'] as const) {
    let finish!: (value: { noteId: string; updatedAt: string; text: string }) => void, enter!: () => void, version = 'v1', calls = 0, readSignal!: AbortSignal;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const source = new S2ProjectNoteSource({ projectId: 'root', list: () => [{ noteId: 'linked', label: '延迟笔记', updatedAt: version }],
      read: async (_id, signal) => { calls++; readSignal = signal; enter(); return new Promise(resolve => { finish = resolve; }); } });
    const target = host(source), selected = target.approveProjectNote('linked'); target.setDocument(document(selected.id));
    const queued = target.enqueueWorkflow(['view', 'independent']); await entered;
    if (ending === 'revoke') target.revokeProjectNote(selected.id);
    if (ending === 'change-during-read') version = 'v2';
    if (ending === 'change-during-read') finish({ noteId: 'linked', updatedAt: 'v1', text: raw });
    const result = await queued.completion;
    assert.equal(result.nodes.find(item => item.nodeId === 'independent')!.status, 'succeeded');
    assert.equal(result.nodes.find(item => item.nodeId === 'parse')!.status, 'blocked');
    const failed = target.history().find(item => item.request.nodeId === 'read')!;
    assert.equal(failed.receipt.status, ending === 'revoke' ? 'cancelled' : ending === 'timeout' ? 'unknown' : 'failed');
    if (ending === 'timeout') assert.equal(failed.receipt.error?.code, 'TIMEOUT');
    if (ending !== 'change-during-read') assert.equal(readSignal.aborted, true);
    assert.equal(calls, 1); assert.deepEqual(failed.artifacts, []); assert.equal(target.remainingCalls, S2_LOCAL_RUN_LIMIT - 2);
    finish({ noteId: 'linked', updatedAt: 'v1', text: raw }); await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(target.history().length, 2); assert.deepEqual(target.history().find(item => item.request.nodeId === 'read')!.artifacts, []);
  }

  const uiData = data(), initialRequest: SceneInitialRequest = { source: 'custom', subject: '合成项目笔记', knowledgePoints: [], sceneSkill: 'S2', taskBinding: { noteId: 'root' } };
  const scene = createS2Scene(initialRequest), canvas = scene.canvasWorkspace!; canvas.plugins = plugins;
  canvas.initial = { ...document(), nodes: canvas.initial.nodes }; delete canvas.initial.execution!.nodes[0].bindings.resource;
  canvas.business = { version: 1, purpose: '合成笔记读取练习', knowledge: [], criteria: [],
    workflow: [{ id: 'ReadAndShow', goal: '按批准范围取材并展示', actor: 'tool', capabilities: [noteCap, parse, table, view], input: '将来由用户允许的笔记', output: '完整正文与记录表' }],
    completion: { mode: 'execution', reference: { ...document('user-approved-note'), nodes: canvas.initial.nodes }, targetNodeIds: ['view'],
      coverage: [{ requirementId: 'material', stepIds: ['ReadAndShow'], nodeIds: ['read', 'parse', 'table', 'view'] }] } };
  const stages: string[] = [], quote = scene.task.slice(0, 120);
  await designS2Canvas(scene, { disclosure: 'complete', invoke: async request => {
    const input = JSON.parse(request.userInput); stages.push(input.stage);
    if (input.stage === 'understand') { assert.equal(input.pluginCatalog, undefined); return { content: JSON.stringify({ goal: canvas.goal,
      requirements: [{ id: 'material', source: 'task', quote, description: '合成项目知识正文练习' }], userRole: '逐项允许', agentRole: '按需协作', assumptions: [], openQuestions: [],
      delivery: { initial: '可选笔记读取入口', deferred: '用户运行前选择并允许', source: 'task', quote } }) }; }
    assert.ok(input.pluginCatalog.plugins.some((plugin: { id: string }) => plugin.id === 'project-notes'));
    assert.ok(request.systemPromptOverride!.includes('未知文件/图片/笔记只留选择入口'));
    assert.ok(request.systemPromptOverride!.includes('不填路径、URL、字节或编造资源句柄'));
    assert.ok(input.pluginCatalog.plugins.find((plugin: any) => plugin.id === 'project-notes').capabilities.find((capability: any) => capability.id === 'read-text').permissions.includes('notes-read'));
    return { content: JSON.stringify(input.stage === 'assemble' ? canvas : { verdict: 'accept', coverage: [{ requirementId: 'material', status: 'covered', evidencePaths: ['/business/workflow/0'], reason: '合成协议检查，不是语义验收' }], factChecks: [], feedback: '未读取笔记' }) };
  } });
  assert.deepEqual(stages, ['understand', 'assemble']); assert.deepEqual(uiData.reads, []);
  let uiHost!: S2PluginHost;
  const ui = harness({ initialRequest, initialDraft: scene, projectNoteSource: uiData.source, onHost: value => { uiHost = value; } }); uis.push(ui);
  const previewChoice = ui.labelControl('选择并允许本局读取知识笔记', 'select'); assert.equal(previewChoice.props.disabled, true);
  ui.button('开始试验').props.onClick(); ui.render();
  previewChoice.props.onChange({ target: { value: 'linked' } }); ui.render(); assert.deepEqual(uiHost.projectNoteSummary(), []);
  const approve = ui.labelControl('选择并允许本局读取知识笔记', 'select').props.onChange;
  approve({ target: { value: 'outside' } }); ui.render(); assert.deepEqual(uiHost.projectNoteSummary(), []);
  approve({ target: { value: 'linked' } }); ui.render(); const uiGrant = uiHost.projectNoteSummary()[0]; assert.ok(uiGrant); assert.deepEqual(uiData.reads, []);
  ui.labelControl('选择执行节点', 'select').props.onChange({ target: { value: 'read' } }); ui.render();
  ui.labelControl('为读取步骤选择笔记', 'select').props.onChange({ target: { value: uiGrant.id } }); ui.render();
  assert.ok(ui.text().includes('关联知识')); assert.ok(!ui.text().includes(uiGrant.id)); assert.deepEqual(uiData.reads, []);
  ui.button('运行全部步骤').props.onClick(); await settle(ui, () => uiHost.workflowHistory().at(-1)?.status === 'succeeded');
  assert.deepEqual(uiData.reads, ['linked']);
  ui.button('保存场景').props.onClick(); await settle(ui, () => ui.saved.length === 1);
  const saved = ui.saved[0], savedText = JSON.stringify(saved);
  assert.ok(!savedText.includes(raw) && !savedText.includes('"projectNotes"') && !savedText.includes('"resourceScopes"'));
  const restored = host(uiData.source); restored.setDocument(importS2Workspace(exportS2Workspace(saved.canvasWorkspace, saved.canvasWorkspace.initial)).initial);
  assert.equal((await restored.enqueueWorkflow(['read']).completion).status, 'failed'); assert.equal(restored.remainingCalls, S2_LOCAL_RUN_LIMIT);
  uiData.state.notes.find(item => item.id === 'linked')!.updatedAt = 'v2'; ui.render(); assert.ok(ui.text().includes('已变化或移除'));
  assert.ok(ui.text().includes('不是最新正文')); assert.ok(ui.text().includes('（已失效）'));
  assert.ok(ui.text().includes('请撤回后重新选择'));
  const staleChoice = ui.labelControl('为读取步骤选择笔记', 'select');
  assert.ok(ui.elements().some(item => item.type === 'option' && item.props.value === uiGrant.id && item.props.disabled === true));
  staleChoice.props.onChange({ target: { value: uiGrant.id } }); ui.render(); assert.ok(ui.text().includes('资料选择已失效'));
  ui.elements().find(item => item.type === 'button' && item.props['aria-label'] === '撤回笔记 关联知识')!.props.onClick(); ui.render();
  approve({ target: { value: 'linked' } }); ui.render(); assert.equal(uiHost.projectNoteSummary()[0].updatedAt, 'v2');
  ui.button('结束试验').props.onClick(); ui.render(); approve({ target: { value: 'linked' } }); ui.render();
  assert.deepEqual(uiHost.projectNoteSummary(), []); assert.deepEqual(uiData.reads, ['linked']);

  // Static app handoff: the S2 child receives a scoped branded bridge, never allNotes or restored runtime authority.
  const app = ts.createSourceFile('App.tsx', readFileSync('src/App.tsx', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const handoffs: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => { if (ts.isCallExpression(node) && node.expression.getText(app) === 'React.createElement' && node.arguments[0]?.getText(app) === 'SceneS2CanvasTrial') handoffs.push(node); ts.forEachChild(node, visit); }; visit(app);
  assert.equal(handoffs.length, 1); assert.match(handoffs[0].arguments[1].getText(app), /projectNoteSource: s2ProjectNoteAccess\.source/);
  assert.doesNotMatch(handoffs[0].arguments[1].getText(app), /allNotes|notesRef/);
  assert.ok(app.text.includes('createSceneProjectNoteSource(sceneRequest.taskBinding?.noteId, () => notesRef.current)'));
  assert.equal(network, 0);
  console.log('S2 project notes passed: frozen linked/legacy/descendant ceiling and live revalidation, metadata-only preparation, explicit per-note grant, exact complete native data to parse/table/view, file/note permission isolation, forged/foreign/restored handles, changed/deleted/moved/empty/large sources, delayed revoke/change/timeout with independent progress, staged builder, actual UI select/bind/run/save/end and static App scoped handoff. Synthetic in-memory notes only; no real storage/RAG/profile/network/model access or browser/semantic claim.');
} finally { uis.forEach(ui => ui.dispose()); hosts.forEach(item => item.close()); globalThis.fetch = previousFetch; }
