import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReactFlowProvider } from '@xyflow/react';
import { createS2Scene, readS2Definition, readS2Scene } from '../src/services/scene/sceneS2Canvas';
import { S2ModelTestSession } from '../src/services/scene/sceneS2ModelTest';
import type { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import type { S2Document } from '../src/types/sceneS2';
import { S2ComposeEditor } from '../src/interaction-packs/prompt-lab/ComposeEditor';
import { s2ComposeStructure } from '../src/interaction-packs/prompt-lab/composeControls';
import { S2WorkflowNodeView } from '../src/components/scene/S2WorkflowNodeView';
import { experimentMaterialDefinition, experimentMaterialRequest } from './fixtures/s2-experiment';
import { addS2PackCapability, addS2PublicComponent, submitS2InlineContent } from './fixtures/s2-canvas-ui-actions';
import { harness } from './scene-s2-ui-harness';

// Production parent/view/file-picker handlers and actual Host, with a synthetic
// model transport only. Layout, native file dialog and pointer behavior require browser checks.
const priorFetch = globalThis.fetch; let network = 0;
globalThis.fetch = async () => { network++; throw new Error('Five-block check forbids real models/network'); };
const pack = { id: 'prompt-lab', version: '0.1.0' };
const request = { ...experimentMaterialRequest, interactionPack: pack };
const { criteria: _criteria, ...base } = structuredClone(experimentMaterialDefinition);
const definition = readS2Definition({ ...base, plugins: [], initial: { nodes: [], edges: [], execution: { version: 1, nodes: [], links: [] } } });
const scene = createS2Scene(request); scene.canvasWorkspace = definition;
let host!: S2PluginHost, hosts = 0, calls = 0, preparations = 0, sessionCreations = 0;
let resolveModel!: (value: import('../src/types').LlmCallResponse) => void;
const ui = harness({ initialRequest: request, initialDraft: scene, onHost(value) { host = value; hosts++; },
  modelProvider: async signal => {
    preparations++; await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(signal?.aborted, false);
    return { providerLabel: '合成五块服务', model: 'synthetic-five-blocks', resourceId: 'SyntheticFiveBlockProvider', supportsImages: false,
      createSession(sceneId, runId, limits) {
        sessionCreations++; return new S2ModelTestSession({ sceneId, runId, resourceId: 'SyntheticFiveBlockProvider', providerId: 'synthetic',
          providerLabel: '合成五块服务', model: 'synthetic-five-blocks', limits,
          invoke: async request => { calls++; assert.equal(request.systemPromptOverride, '身份：合成角色原文\n---\n任务：合成任务原文\n---\n输出要求：合成输出要求');
            assert.equal(request.userInput, '待测资料完整原文 $& {{literal}}'); return new Promise(resolve => { resolveModel = resolve; }); } });
      } };
  } });
const uis = [ui];
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function settle(done: () => boolean) { for (let i = 0; i < 300; i++) { ui.render(); if (done()) return; await tick(); } assert.fail('Synthetic five-block run did not settle'); }
const document = (): S2Document => ui.resourceSourceDocument();
const node = (id: string) => { const value = ui.flow().props.nodes.find((item: any) => item.id === id); assert.ok(value, id); return value; };
const panel = () => ui.elements().find(element => element.props['aria-label'] === '画布操作面板')!;
const runButton = (id: string) => ui.inline(id).button('测试');
function add(ref: string) {
  const before = new Set(ui.flow().props.nodes.map((item: any) => item.id)); addS2PackCapability(ui, ref);
  return ui.flow().props.nodes.find((item: any) => !before.has(item.id)).id as string;
}
function wire(source: string, sourceHandle: string, target: string, targetHandle: string) {
  ui.flow().props.onConnect({ source, sourceHandle, target, targetHandle }); ui.render();
}
function markup(id: string, data: Record<string, any> = node(id).data) {
  return renderToStaticMarkup(<ReactFlowProvider><S2WorkflowNodeView {...({ data: { ...data, nodeControls: undefined } } as any)} /></ReactFlowProvider>);
}
function deeplyFrozen(value: unknown, seen = new WeakSet<object>()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value); assert.equal(Object.isFrozen(value), true, 'Every resource document descendant is frozen'); Object.values(value).forEach(item => deeplyFrozen(item, seen));
}
const revision = (value: S2PluginHost) => value.prepare(null, undefined, '').frame.revision;
try {
  ui.button('添加').props.onClick(); ui.render();
  const menu = ui.elements().find(element => element.props['aria-label'] === '添加组件')!;
  assert.deepEqual(ui.elements(menu).filter(element => element.type === 'section' && element.props.role === 'region').map(element => element.props['aria-label']),
    ['内容块', '提示词组装块', '提示词测试块', '结果展示块', '待测资料块']);
  const menuRefs = ui.elements(menu).filter(element => element.props['data-s2-component']).map(element => element.props['data-s2-component']);
  assert.deepEqual(menuRefs, ['content', 'compose', 'model-test', 'result', 'material-text', 'material-file', 'material-image']);
  assert.ok(ui.text(menu).includes('内容块')); assert.ok(!ui.text(menu).includes('其他组件'));
  const assembly = add('text-template@1.0.0/compose');
  assert.deepEqual(node(assembly).data.node.bindings.prefixes, { kind: 'literal', value: ['角色：', '任务：', '输出要求：'] });
  assert.deepEqual(node(assembly).data.viewPolicy.visibleNodeInputs, ['part1', 'part2', 'part3']);
  assert.equal(node(assembly).data.viewPolicy.addInput, undefined); assert.equal(node(assembly).data.viewPolicy.inputActions, undefined);
  assert.equal((markup(assembly).match(/class="s2-input-port"/g) ?? []).length, 3, 'All three preset ports are present before any connection');
  const contentIds: string[] = [];
  for (const value of ['合成角色原文', '合成任务原文', '合成输出要求']) {
    const before = new Set(ui.flow().props.nodes.map((item: any) => item.id)); addS2PublicComponent(ui, 'content');
    const id = ui.flow().props.nodes.find((item: any) => !before.has(item.id)).id; contentIds.push(id); submitS2InlineContent(ui, id, value);
  }
  const model = add('model-test@1.0.0/generate'), result = add('structured-view@1.0.0/text');
  const material = add('local-material@1.0.0/read-text'), image = add('local-material@1.0.0/read-image');
  for (const [index, id] of contentIds.entries()) wire(id, 'field:content', assembly, `in:part${index + 1}`);
  wire(assembly, 'out:text', model, 'in:prompt'); wire(material, 'out:text', model, 'in:input'); wire(model, 'out:text', result, 'in:text');
  for (const [index, id] of contentIds.entries()) assert.deepEqual(node(assembly).data.node.bindings[`part${index + 1}`], { kind: 'field', nodeId: id, fieldId: 'content' });
  const beforeStructure = structuredClone(document()), controls = ui.inline(assembly).elements().find(element => element.type === 'compose-editor')!;
  const structure = s2ComposeStructure(controls.props.definition, controls.props.document, assembly);
  const actualEditor = renderToStaticMarkup(<S2ComposeEditor definition={controls.props.definition} document={controls.props.document} nodeId={assembly}
    onStructureChange={controls.props.onStructureChange} />);
  assert.ok(!actualEditor.includes('<select') && !actualEditor.includes('<button') && !actualEditor.includes('<form'));
  for (const forbidden of ['使用哪份内容', '上移', '下移', '添加一段', '应用组装设置', '合成角色原文']) assert.ok(!actualEditor.includes(forbidden));
  const staleStructure = controls.props.onStructureChange;
  controls.props.onStructureChange({ prefixes: ['身份：', '任务：', '输出要求：'], separator: '\n---\n' }, structure.base); ui.render();
  assert.deepEqual(document().execution!.links, beforeStructure.execution!.links);
  for (let index = 1; index <= 3; index++) assert.deepEqual(node(assembly).data.node.bindings[`part${index}`], beforeStructure.execution!.nodes.find(item => item.id === assembly)!.bindings[`part${index}`]);
  assert.equal(node(assembly).data.viewPolicy.inputLabels.part1, '身份：');
  assert.throws(() => staleStructure({ prefixes: ['', '', ''], separator: '' }, structure.base), /过期|变化|视图/);
  ui.flow().props.onNodeClick({}, { id: model }); ui.render(); assert.equal(panel().props.hidden, true);
  assert.ok(!ui.inline(model).elements().some(element => element.type === 'details'), 'Model parameters and Test stay directly inside their block');
  assert.ok(ui.inline(model).elements().some(element => element.type === 'model-parameters'));
  assert.equal(runButton(model).props.disabled, false, 'The package Test action is available without a host start button');
  const previewPicker = ui.inline(material).elements().find(element => element.type === 'input' && element.props.type === 'file')!;
  assert.ok(previewPicker); assert.equal(previewPicker.props.disabled, false);
  assert.equal(ui.elements().some(element => element.props['aria-label'] === '文本资料选择'), false, 'The file picker is in node controls, not a duplicate side panel');
  assert.equal(hosts, 0); assert.equal(ui.modelCalls(), 0);

  previewPicker.props.onChange({ target: { files: [new File(['初始化选择'], 'session.txt', { type: 'text/plain' })], value: 'first-choice' } }); ui.render();
  ui.inline(material).button('移除资料').props.onClick(); ui.render();
  assert.equal(hosts, 1); assert.equal(ui.modelCalls(), 0); assert.equal(host.textResourceSummary().length, 0);
  const textFacade = ui.resourceElement(material).props.host, imageFacade = ui.resourceElement(image).props.host;
  assert.notEqual(textFacade, host); assert.notEqual(imageFacade, host); assert.notEqual(textFacade, imageFacade);
  assert.deepEqual(Object.keys(textFacade).sort(), ['approveTextFile', 'revokeTextFile', 'textResourceSummary']);
  assert.deepEqual(Object.keys(imageFacade).sort(), ['approveImageFile', 'imageResourcePreview', 'imageResourceSummary', 'revokeImageFile']);
  for (const facade of [textFacade, imageFacade]) {
    assert.equal(Object.isFrozen(facade), true); assert.equal(Object.getPrototypeOf(facade), Object.prototype);
    for (const forbidden of ['enqueueWorkflow', 'approveModelTestSession', 'confirmModelTest', 'answerHumanInput', 'readCurrentStructuredOutput', 'currentArtifact', 'history', 'prepare'])
      assert.equal(facade[forbidden], undefined, `Renderable resource props must not expose ${forbidden}`);
  }
  ui.render(); assert.equal(ui.resourceElement(material).props.host, textFacade); assert.equal(ui.resourceElement(image).props.host, imageFacade);
  const resourceDocument: S2Document = ui.resourceElement(material).props.document;
  assert.notEqual(resourceDocument, document()); assert.notEqual(resourceDocument.nodes, document().nodes);
  assert.notEqual(resourceDocument.execution!.links, document().execution!.links); deeplyFrozen(resourceDocument);
  assert.equal(ui.resourceElement(image).props.document, resourceDocument, 'Image/text slots share the stable detached snapshot of the same immutable document');
  const graphBeforeAttack = JSON.stringify(document()), revisionBeforeAttack = revision(host);
  assert.throws(() => { resourceDocument.nodes[0].values.content = 'FORGED_RESOURCE_SLOT_TEXT'; }, TypeError);
  assert.throws(() => { resourceDocument.execution!.links.length = 0; }, TypeError);
  assert.throws(() => { resourceDocument.execution!.links[0].target.nodeId = 'FORGED_RESOURCE_SLOT_TARGET'; }, TypeError);
  ui.render(); assert.equal(JSON.stringify(document()), graphBeforeAttack); assert.equal(revision(host), revisionBeforeAttack);
  assert.equal(ui.resourceElement(material).props.document, resourceDocument, 'A pure rerender retains snapshot identity');
  assert.equal(host.history().length, 0); assert.equal(host.workflowHistory().length, 0);
  const originalContent = node(contentIds[0]).data.fields[0].value;
  submitS2InlineContent(ui, contentIds[0], '明确编辑后的临时原文');
  const changedResourceDocument: S2Document = ui.resourceElement(material).props.document;
  assert.notEqual(changedResourceDocument, resourceDocument); deeplyFrozen(changedResourceDocument);
  assert.equal(changedResourceDocument.nodes.find(item => item.id === contentIds[0])!.values.content, '明确编辑后的临时原文');
  assert.equal(resourceDocument.nodes.find(item => item.id === contentIds[0])!.values.content, originalContent, 'An actual edit cannot mutate an earlier slot snapshot');
  submitS2InlineContent(ui, contentIds[0], originalContent);
  assert.notEqual(ui.resourceElement(material).props.document, resourceDocument, 'Returning to equal bytes still has a new immutable document identity');
  assert.equal(ui.resourceElement(material).props.host, textFacade);
  const file = new File(['待测资料完整原文 $& {{literal}}'], '五块合成资料.md', { type: 'text/markdown' });
  previewPicker.props.onChange({ target: { files: [file], value: 'old-preview-choice' } }); ui.render(); assert.equal(host.textResourceSummary().length, 0);
  const picker = ui.inline(material).elements().find(element => element.type === 'input' && element.props['aria-label'] === '选择本地文本资料')!;
  assert.equal(picker.props.disabled, false); const oldPicker = picker.props.onChange;
  picker.props.onChange({ target: { files: [file], value: 'synthetic-file-choice' } }); ui.render();
  assert.equal(host.textResourceSummary().length, 1); assert.equal(host.history().length, 0, 'Choosing/binding a file does not read it');
  assert.equal(ui.resourceElement(material).props.host, textFacade, 'Resource grants/refreshes retain the same least-authority facade');
  const resourceId = host.textResourceSummary()[0].id; assert.deepEqual(node(material).data.node.bindings.resource, { kind: 'literal', value: resourceId });
  oldPicker({ target: { files: [file], value: 'duplicate-old-choice' } }); ui.render(); assert.equal(host.textResourceSummary().length, 1, 'Retired picker cannot grant another resource');
  const resourceSelect = ui.inline(material).elements().find(element => element.type === 'select' && element.props['aria-label'] === '选用已提供的文本资料')!;
  resourceSelect.props.onChange({ target: { value: 'foreign-resource-id' } }); ui.render(); assert.deepEqual(node(material).data.node.bindings.resource, { kind: 'literal', value: resourceId });
  assert.ok(ui.inline(image).elements().some(element => element.type === 'image-materials' && element.props.compact && element.props.autoBind));
  assert.equal(host.modelTestSummary(), null); assert.equal(preparations, 0); assert.equal(sessionCreations, 0);
  for (const removed of ['运行与发送前核对', '等待核对', '确认发送本次模型请求', '本局模型调用预算', '本局运行记录'])
    assert.ok(!ui.text().includes(removed), `Prompt inline mode omits the retired ${removed} panel`);
  ui.render(); const test = runButton(model); assert.equal(test.props.disabled, false); const oldTest = test.props.onClick;
  test.props.onClick(); oldTest(); await settle(() => calls === 1);
  assert.deepEqual(host.workflowHistory().at(-1)!.targets, [model, result], 'The node Test action includes its connected text result block');
  assert.equal(preparations, 1); assert.equal(sessionCreations, 1); assert.deepEqual(host.waitingModelTests(), []);
  assert.equal(host.modelTestSummary()!.usedRequests, 1, 'One explicit current Test click prepares and sends through the actual session');
  assert.equal(runButton(model).props.disabled, true); oldTest(); ui.render(); assert.equal(host.workflowHistory().length, 1);
  assert.ok(host.history().some(item => item.request.nodeId === material));
  resolveModel({ content: '合成模型完整原始返回', diagnostics: { finishReason: 'stop' } }); await settle(() => host.workflowHistory().at(-1)?.status === 'succeeded');
  assert.equal(calls, 1); assert.equal(node(result).data.status, 'displayed'); assert.equal(node(result).data.artifacts[0].payload.value, '合成模型完整原始返回');
  assert.ok(markup(result).includes('合成模型完整原始返回'));
  for (const id of [assembly, model, material]) assert.equal(node(id).data.viewPolicy.showResult, false);
  assert.ok(!markup(model).includes('合成模型完整原始返回')); assert.ok(!markup(assembly).includes('合成角色原文')); assert.ok(!markup(material).includes('待测资料完整原文'));
  assert.ok(markup(assembly, { ...node(assembly).data, viewPolicy: undefined }).includes('合成角色原文'), 'Packages without this opt-in retain ordinary result display');
  oldTest(); ui.render(); assert.equal(host.workflowHistory().length, 1); assert.equal(ui.modelCalls(), 0);
  const endedPicker = ui.inline(material).elements().find(element => element.props['aria-label'] === '选择本地文本资料')!.props.onChange;
  const endedTest = runButton(model).props.onClick;
  assert(!ui.elements().some(element => element.type === 'button' && ui.text(element) === '结束试验'));
  ui.button('返回').props.onClick(); ui.render(); endedTest(); endedPicker({ target: { files: [file], value: 'ended-choice' } }); ui.render();
  assert.equal(calls, 1); assert.equal(host.workflowHistory().length, 1); assert.equal(runButton(model).props.disabled, true);

  const readonlyDefinition = structuredClone(experimentMaterialDefinition); readonlyDefinition.initial.nodes.find(item => item.id === 'role')!.readOnly = true;
  // Current authoring keeps content/material identities distinct even when they share the same native text type.
  readonlyDefinition.initial.nodes.forEach(node => { node.componentId = 'content'; });
  const readonlyScene = createS2Scene(request); readonlyScene.canvasWorkspace = readonlyDefinition;
  let fixedHost!: S2PluginHost;
  const fixed = harness({ initialRequest: request, initialDraft: readonlyScene, onHost(value) { fixedHost = value; } }); uis.push(fixed);
  const fixedNode = () => fixed.flow().props.nodes.find((item: any) => item.id === 'role');
  const fixedValue = fixedNode().data.fields[0].value; fixedNode().data.fields[0].startEdit(); fixed.render();
  assert.equal(fixedNode().data.fields[0].editor, undefined); assert.equal(fixedNode().data.fields[0].value, fixedValue); assert.match(fixed.text(), /只读/);
  const fixedPicker = fixed.inline('material').elements().find(element => element.type === 'input' && element.props.type === 'file')!;
  fixedPicker.props.onChange({ target: { files: [new File(['初始化选择'], 'readonly.txt', { type: 'text/plain' })], value: 'first-choice' } }); fixed.render();
  fixed.inline('material').button('移除资料').props.onClick(); fixed.render();
  const fixedDocument: S2Document = fixed.resourceSourceDocument();
  const fixedSnapshot: S2Document = fixed.resourceElement('material').props.document;
  assert.notEqual(fixedSnapshot, fixedDocument); deeplyFrozen(fixedSnapshot);
  assert.equal(fixedSnapshot.nodes.find(item => item.id === 'role')!.readOnly, true);
  const fixedRevision = revision(fixedHost), fixedBytes = JSON.stringify(fixedDocument);
  assert.throws(() => { fixedSnapshot.nodes.find(item => item.id === 'role')!.values.content = 'FORGED_FIXED_SOURCE'; }, TypeError);
  assert.throws(() => { fixedSnapshot.execution!.links.splice(0); }, TypeError);
  fixed.render(); assert.equal(JSON.stringify(fixed.resourceSourceDocument()), fixedBytes);
  assert.equal(fixedNode().data.fields[0].value, fixedValue); assert.equal(revision(fixedHost), fixedRevision);
  assert.throws(() => readS2Scene({ ...scene, interactionPack: null, canvasWorkspace: controls.props.definition }), /范围之外/,
    'Selecting the generic base cannot grant package-owned composition capabilities');
  assert.equal(network, 0);
  console.log('S2 five-block UI passed: five logical add groups with file/image variants, fixed unconnected structure ports and exact canvas mappings, title-only structure edits without rewiring, one explicit Test click prepares a synthetic provider/session and sends through actual Host to the connected renderer with no wait/confirmation panels or duplicate sends, real node-local File grants with no implicit reads, source/result-only presentation, readonly and stale preview/file/test/end guards. Offline handlers/SSR only.');
} finally { uis.forEach(item => item.dispose()); globalThis.fetch = priorFetch; }
