import assert from 'node:assert/strict';
import type { SceneInitialRequest, SceneSpec } from '../src/types';
import type { S2Document, S2WorkflowNode } from '../src/types/sceneS2';
import { createS2Scene, readS2Definition, readS2Scene } from '../src/services/scene/sceneS2Canvas';
import { reusableS2Document, unselectedS2Resources } from '../src/services/scene/sceneS2SceneSave';
import { createS2CompositeDesign } from '../src/services/scene/sceneS2CompositeLibrary';
import { S2ProjectNoteSource } from '../src/services/scene/sceneS2ProjectNotes';
import type { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { SYNTHETIC_EXPERIMENT_PNG } from './fixtures/s2-experiment';
import { harness } from './scene-s2-ui-harness';

const previousFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('Scene save checks forbid network/model calls');
const request: SceneInitialRequest = { source: 'custom', sceneSkill: 'S2', subject: '可复用资料场景', knowledgePoints: [], interactionPack: null, taskBinding: { noteId: 'project' } };
const scene = createS2Scene(request);
const step = (id: string, pluginId: string, capabilityId: string, bindings: S2WorkflowNode['bindings'] = {}): S2WorkflowNode =>
  ({ id, pluginId, pluginVersion: '1.0.0', capabilityId, position: { x: id.length * 100, y: 150 }, bindings });
const graph: S2Document = { nodes: [{ id: 'content', type: 'text', label: '保留内容', readOnly: true, position: { x: 30, y: 50 }, values: { content: 'textfile-这是正文，不是资料句柄' } }],
  edges: [], execution: { version: 1, nodes: [step('file', 'local-material', 'read-text'), step('picture', 'local-material', 'read-image'), step('note', 'project-notes', 'read-text'),
    step('parse', 'structured-data', 'parse-json', { text: { kind: 'literal', value: 'imagefile-这是业务参数' } }), step('result', 'structured-view', 'text')],
    links: [{ source: { nodeId: 'file', portId: 'text' }, target: { nodeId: 'result', portId: 'text' } }] },
  groups: [{ id: 'group', label: '资料区域', nodeIds: ['file', 'picture'], collapsed: false }],
  composites: [{ id: 'composite', label: '参数组合', nodeIds: ['parse'] }] };
let definition = readS2Definition({ ...scene.canvasWorkspace, blockTypes: [{ id: 'text', label: '内容', fields: [{ id: 'content', label: '内容', kind: 'multiline' }] }],
  plugins: graph.execution!.nodes.map(({ pluginId, pluginVersion, capabilityId }) => ({ pluginId, pluginVersion, capabilityId })), initial: graph });
definition = readS2Definition({ ...definition, initial: { ...graph, blueprints: [createS2CompositeDesign(graph, definition.plugins, 'composite', { id: 'parseDesign', version: '1.0.0', label: '业务参数蓝图', description: '保留参数' })] } });
scene.canvasWorkspace = definition;
let noteReads = 0;
const projectNoteSource = new S2ProjectNoteSource({ projectId: 'project', list: () => [{ noteId: 'knowledge', label: '项目知识笔记', updatedAt: 'v1' }],
  read: async () => { noteReads++; return { noteId: 'knowledge', updatedAt: 'v1', text: '不能因保存或打开读取正文' }; } });
let host!: S2PluginHost;
const ui = harness({ initialRequest: request, initialDraft: scene, projectNoteSource, onHost(value) { host = value; } });
const live = [ui];
const tick = () => new Promise(resolve => setImmediate(resolve));
async function settle(test: () => boolean, view: typeof ui) { for (let i = 0; i < 100 && !test(); i++) { await tick(); view.render(); } assert(test()); }
const chooseText = (view: typeof ui, content: string) => {
  view.inline('file').elements().find(item => item.type === 'input' && item.props.type === 'file')!.props.onChange({ target: { files: [new File([content], '资料.md', { type: 'text/plain' })], value: 'selected' } }); view.render();
};
try {
  // Listing scoped note metadata is available before there is a session; no body read is needed.
  assert.equal(host, undefined);
  const notes = ui.inline('note').labelControl('选择并允许本局读取知识笔记', 'select');
  assert(ui.elements(notes).some(item => item.type === 'option' && item.props.value === 'knowledge'));
  notes.props.onChange({ target: { value: 'knowledge' } }); ui.render(); assert(host);
  const noteId = host.projectNoteSummary()[0].id;
  chooseText(ui, '原局文件全文'); const fileId = host.textResourceSummary()[0].id;
  const imageControl = ui.resourceElement('picture');
  const image = await imageControl.props.host.approveImageFile(new File([Buffer.from(SYNTHETIC_EXPERIMENT_PNG, 'base64')], '原图.png', { type: 'image/png' }));
  imageControl.props.onBind(image.id); imageControl.props.onChange(); ui.render();
  const original = structuredClone(ui.resourceSourceDocument()), originalBytes = JSON.stringify(original), budget = host.remainingCalls;
  assert.equal(original.execution!.nodes.find(node => node.id === 'note')!.bindings.resource.kind, 'literal');
  ui.button('保存场景').props.onClick(); ui.button('保存场景').props.onClick();
  await settle(() => ui.saved.length === 1 && ui.text().includes('已保存场景'), ui);
  const saved: SceneSpec = structuredClone(ui.saved[0]), portable = saved.canvasWorkspace!.initial;
  assert.deepEqual(portable, reusableS2Document(original));
  for (const id of ['file', 'picture', 'note']) assert.equal(portable.execution!.nodes.find(node => node.id === id)!.bindings.resource, undefined);
  for (const id of [fileId, image.id, noteId, host.runId]) assert(!JSON.stringify(saved).includes(id));
  assert.equal(JSON.stringify(ui.resourceSourceDocument()), originalBytes, 'Saving must not alter live bindings/history or revoke resources');
  assert.equal(host.textResourceSummary()[0].id, fileId); assert.equal(host.imageResourceSummary()[0].id, image.id); assert.equal(host.projectNoteSummary()[0].id, noteId);
  assert.equal(host.remainingCalls, budget); assert.equal(host.history().length, 0); assert.equal(noteReads, 0); assert.equal(ui.modelCalls(), 0);
  assert.notEqual(saved.sceneId, scene.sceneId); assert.equal(saved.sourceSceneId, scene.sceneId);
  assert.deepEqual(saved.interactionPack, scene.interactionPack);
  assert.deepEqual(portable.nodes, original.nodes); assert.deepEqual(portable.groups, original.groups); assert.deepEqual(portable.composites, original.composites); assert.deepEqual(portable.blueprints, original.blueprints);
  assert.deepEqual(portable.execution!.links, original.execution!.links); assert.deepEqual(portable.execution!.nodes.find(node => node.id === 'parse'), original.execution!.nodes.find(node => node.id === 'parse'));
  const bytes = JSON.stringify(saved); let reopenedHost: S2PluginHost | undefined;
  const opened = harness({ initialRequest: { ...request, source: 'existing', sceneId: saved.sceneId }, loadScene: async () => structuredClone(saved), projectNoteSource, onHost(value) { reopenedHost = value; } }); live.push(opened);
  await settle(() => opened.text().includes('画布配置已载入'), opened);
  assert.deepEqual(opened.resourceSourceDocument(), portable); assert.equal(reopenedHost, undefined); assert(opened.text().includes('3 个资料入口需要重新选择本局资料'));
  assert.equal(opened.modelCalls(), 0); assert.equal(noteReads, 0); assert.equal(JSON.stringify(saved), bytes);
  assert(opened.inline('file').text().includes('重新选择')); chooseText(opened, '新局重新选择的全文');
  assert(reopenedHost); assert.notEqual(reopenedHost.runId, host.runId); assert.notEqual(reopenedHost.textResourceSummary()[0].id, fileId);
  const run = reopenedHost.enqueueWorkflow(['result']); await run.completion;
  assert.equal(reopenedHost.workflowHistory().at(-1)!.status, 'succeeded');
  const result = reopenedHost.workflowHistory().at(-1)!.nodes.find(node => node.nodeId === 'result')!;
  const payload = reopenedHost.currentArtifact(result.artifactIds[0]).payload;
  assert.equal(payload.kind, 'inline'); if (payload.kind === 'inline') assert.equal(payload.value, '新局重新选择的全文');
  // Old saved files are normalized only in the new in-memory scene, never silently overwritten on disk.
  const legacy = { ...saved, canvasWorkspace: { ...saved.canvasWorkspace!, initial: original } };
  const legacyBytes = JSON.stringify(legacy);
  const old = harness({ initialRequest: { ...request, source: 'existing', sceneId: legacy.sceneId }, loadScene: async () => legacy, projectNoteSource }); live.push(old);
  await settle(() => old.text().includes('画布配置已载入'), old); assert.deepEqual(old.resourceSourceDocument(), portable); assert.equal(JSON.stringify(legacy), legacyBytes);
  const imageLiteral = readS2Definition({ ...definition, plugins: [{ pluginId: 'model-test', pluginVersion: '1.0.0', capabilityId: 'generate' }], initial: { nodes: [], edges: [], execution: { version: 1,
    nodes: [step('model', 'model-test', 'generate', { image: { kind: 'literal', value: { resourceId: 'imagefile-old' } }, prompt: { kind: 'literal', value: '保留提示词' } })], links: [] } } });
  const clean = reusableS2Document(imageLiteral.initial); assert.equal(clean.execution!.nodes[0].bindings.image, undefined); assert.deepEqual(clean.execution!.nodes[0].bindings.prompt, { kind: 'literal', value: '保留提示词' });
  const wired = structuredClone(portable); wired.execution!.nodes.find(node => node.id === 'file')!.bindings.resource = { kind: 'field', nodeId: 'content', fieldId: 'content' };
  assert.deepEqual(reusableS2Document(wired), wired); assert.equal(unselectedS2Resources(wired).length, 2);
  const failure = harness({ initialRequest: request, initialDraft: scene, failSave: true }); live.push(failure);
  failure.button('保存场景').props.onClick(); await settle(() => failure.text().includes('synthetic save failure'), failure); assert.equal(failure.saved.length, 0); assert(!failure.text().includes('已保存场景'));
  assert.equal(noteReads, 0);
  console.log('S2 scene save passed: renamed production action, duplicate/failure guards, detached cleanup of text/image/note and typed image literals, intact live grants/business fields/layout/links/groups/composites/blueprints/package ref, fresh and legacy reload with reselect guidance, zero implicit reads/model calls and actual file-to-result reuse after reselection. Synthetic storage/UI handlers only.');
} finally { live.forEach(view => view.dispose()); globalThis.fetch = previousFetch; }
