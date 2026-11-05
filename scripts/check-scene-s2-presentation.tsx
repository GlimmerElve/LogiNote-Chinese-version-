// Fixed synthetic replies below intentionally test complete-catalogue compatibility, not progressive discovery.
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReactFlowProvider } from '@xyflow/react';
import { createS2Scene, readS2Definition, readS2Document, exportS2Workspace, importS2Workspace, exportS2Subgraph, importS2Subgraph, designS2Canvas } from '../src/services/scene/sceneS2Canvas';
import { s2SemanticDocument } from '../src/services/scene/sceneS2Workflow';
import { s2NodeTitle, s2PortLabel, s2StatusLabel } from '../src/services/scene/sceneS2Presentation';
import { s2BuiltinPluginRegistry } from '../src/services/scene/sceneS2PluginRegistry';
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { S2WorkflowNodeView } from '../src/components/scene/S2WorkflowNodeView';
import { scenePackViewPolicy } from '../src/components/scene/ScenePackView';
import { browserTemplateDefinition, browserTemplateRequest } from './fixtures/s2-browser-definition';
import { s2DesignFixtureResponse } from './fixtures/s2-design-model';
import { harness } from './scene-s2-ui-harness';
import { useGenericS2CanvasUi } from './fixtures/s2-generic-canvas-ui';

const previous = globalThis.fetch; let network = 0;
// Generic base legacy inline/settings contract. Actual prompt policy is checked by experiment-ui.
const restoreCanvasUi = useGenericS2CanvasUi();
globalThis.fetch = async () => { network++; throw new Error('No network in display-layer tests'); };
try {
  const definition = readS2Definition(structuredClone(browserTemplateDefinition));
  assert.equal(definition.blockTypes.find(t => t.id === 'role')!.label, '角色设定块');
  assert.equal(definition.blockTypes.find(t => t.id === 'template')!.advanced, true);
  const badAdvanced = structuredClone(definition); (badAdvanced.blockTypes[0] as any).advanced = 'yes';
  assert.throws(() => readS2Definition(badAdvanced), /布尔/);
  assert.deepEqual(importS2Workspace(exportS2Workspace(definition, definition.initial)), definition);
  const pasted = importS2Subgraph(exportS2Subgraph(definition, definition.initial, ['role', 'bindRole']), definition, definition.initial);
  assert.ok(pasted.document.execution!.nodes.some(n => n.id !== 'bindRole' && n.presentation?.label === '汇集角色设定'));
  const changed = structuredClone(definition.initial);
  changed.execution!.nodes[0].presentation!.label = '另一个显示名称';
  assert.deepEqual(s2SemanticDocument(changed), s2SemanticDocument(definition.initial), 'Display names are not execution semantics');
  const cap = s2BuiltinPluginRegistry().capability(definition.initial.execution!.nodes[0]);
  const composeRef = { pluginId: 'text-template', pluginVersion: '1.0.0', capabilityId: 'compose' };
  assert.equal(s2NodeTitle(composeRef), '组装提示词', 'Loaded package supplies its own ordinary title');
  assert.equal(s2NodeTitle({ pluginId: composeRef.pluginId, capabilityId: composeRef.capabilityId }), '组装提示词', 'A legacy versionless display reference resolves its unique loaded release');
  const composePort = s2BuiltinPluginRegistry().capability(composeRef).inputs.find(port => port.id === 'part1')!;
  assert.equal(s2PortLabel(composeRef, composePort, 'inputs'), '内容 1');
  assert.equal(s2PortLabel({}, composePort, 'inputs'), '输入材料', 'A port name alone cannot borrow a prompt package business label');
  assert.equal(s2NodeTitle({ ...composeRef, pluginVersion: '9.9.9' }), '处理步骤', 'Unknown exact releases cannot borrow another version metadata');
  for (const presentation of [
    { label: '错误', permissions: ['network'] }, { label: '错误', inputs: { invented: '不存在' } },
    { label: '错误', outputs: { value: '不能编造输出' } }, { label: '' }, { label: '长'.repeat(81) },
    { label: '错误', inputs: { value: { html: '<input>' } } },
  ]) {
    const bad = structuredClone(definition.initial); (bad.execution!.nodes[0] as any).presentation = presentation;
    assert.throws(() => readS2Document(bad, definition), /显示/);
  }
  let getterReads = 0;
  const unsafe = { label: '拒绝访问器' }; Object.defineProperty(unsafe, 'description', { enumerable: true, get() { getterReads++; return '不能运行'; } });
  const getterDoc = structuredClone(definition.initial); getterDoc.execution!.nodes[0].presentation = unsafe;
  assert.throws(() => readS2Document(getterDoc, definition), /显示/); assert.equal(getterReads, 0);
  assert.equal(s2NodeTitle(definition.initial.execution!.nodes[0]), '汇集角色设定');
  assert.equal(s2PortLabel(definition.initial.execution!.nodes[0], cap.inputs.find(p => p.id === 'value')!, 'inputs'), '角色设定');
  assert.equal(s2StatusLabel('cached'), '复用已有结果');
  assert.equal(s2StatusLabel('pending'), '等待前置步骤');
  const scene = createS2Scene({ ...browserTemplateRequest, interactionPack: { id: 'prompt-lab', version: '0.1.0' } }); scene.canvasWorkspace = definition;
  let host!: S2PluginHost;
  const ui = harness({ initialDraft: scene, onHost(value) { host = value; } });
  try {
    const node = () => ui.flow().props.nodes.find((n: any) => n.id === 'role');
    const block = ui.flow().props.nodeTypes.block({ data: node().data });
    const input = ui.elements(block).find(e => e.type === 'textarea')!;
    assert.equal(input.props['aria-label'], '角色设定块 / 填写角色设定');
    let stopped = false; input.props.onKeyDown({ stopPropagation() { stopped = true; } }); assert.equal(stopped, true);
    input.props.onChange({ target: { value: '你是严谨的老师。\n保留换行和 {{literal}}' } }); ui.render();
    assert.equal(node().data.fields[0].value, '你是严谨的老师。\n保留换行和 {{literal}}');
    assert.equal(ui.modelCalls(), 0);
    ui.button('开始试验').props.onClick(); ui.render();
    ui.labelControl('选择执行节点', 'select').props.onChange({ target: { value: 'render' } }); ui.render();
    const advanced = ui.elements().find(e => e.type === 'details' && ui.text(e.children[0]) === '高级接线与参数');
    assert.ok(advanced); assert.ok(!advanced.props.open, 'Technical editing is opt-in, not removed');
    const source = ui.labelControl('为汇集好的材料选择材料', 'select');
    const staleChange = source.props.onChange;
    source.props.onChange({ target: { value: JSON.stringify(['output', 'bindConstraints', 'variables']) } }); ui.render();
    assert.ok(ui.flow().props.edges.some((edge: any) => edge.source === 'bindConstraints' && edge.target === 'render' && edge.label === undefined && edge.ariaLabel.includes('交给')),
      'Ordinary canvas keeps accessible connection meaning without permanent technical edge labels');
    const diagnostics = ui.elements().find(element => element.type === 'label' && ui.text(element) === '开发诊断（显示技术信息）'); assert.ok(diagnostics);
    ui.elements(diagnostics).find(element => element.type === 'input')!.props.onChange({ target: { checked: true } }); ui.render();
    assert.ok(ui.flow().props.edges.some((edge: any) => edge.source === 'bindConstraints' && edge.target === 'render' && edge.label === '交给汇集好的材料' && edge.ariaLabel.includes('交给')));
    staleChange({ target: { value: '' } }); ui.render();
    assert.ok(ui.flow().props.edges.some((edge: any) => edge.source === 'bindConstraints' && edge.target === 'render'), 'Old UI callback cannot undo a new mapping');
    assert.equal(host.history().length, 0); assert.equal(host.workflowHistory().length, 0, 'Editing and mapping never run tools');
    ui.labelControl('选择执行节点', 'select').props.onChange({ target: { value: 'bindRole' } }); ui.render();
    const beforeCycle = JSON.stringify(ui.flow().props.edges);
    ui.labelControl('为前面汇集的材料选择材料', 'select').props.onChange({ target: { value: JSON.stringify(['output', 'bindConstraints', 'variables']) } }); ui.render();
    assert.equal(JSON.stringify(ui.flow().props.edges), beforeCycle, 'Friendly routing still rejects cycles atomically');
    ui.labelControl('选择执行节点', 'select').props.onChange({ target: { value: 'render' } }); ui.render();
    ui.button('运行所选步骤').props.onClick();
    for (let i = 0; i < 12; i++) { await new Promise(resolve => setTimeout(resolve, 0)); ui.render(); }
    const run = host.workflowHistory().at(-1)!; assert.equal(run.status, 'succeeded');
    const artifact = host.currentArtifact(run.nodes.find(n => n.nodeId === 'render')!.artifactIds[0]);
    assert.equal(artifact.payload.kind, 'inline');
    if (artifact.payload.kind === 'inline') assert.ok(String(artifact.payload.value).includes('你是严谨的老师。\n保留换行和 {{literal}}'));
    assert.equal(ui.modelCalls(), 0); assert.equal(host.remainingCalls, 60);
    const staleInput = node().data.fields[0].edit;
    ui.button('结束试验').props.onClick(); ui.render();
    assert.equal(node().data.disabled, true); staleInput('不应写入'); ui.render();
    assert.equal(node().data.fields[0].value, '你是严谨的老师。\n保留换行和 {{literal}}');
  } finally { ui.dispose(); }
  const malicious = { ...definition.initial.execution!.nodes[0], presentation: { label: '<script>literal</script>', description: '显示不是指令', inputs: { value: '角色设定' } } };
  const policyFor = (node: any) => scenePackViewPolicy({ id: 'prompt-lab', version: '0.1.0' }, {
    definition, document: definition.initial, node, active: true, state: { get: () => undefined, set: () => assert.fail('SSR does not edit view state') },
  } as any);
  const markup = renderToStaticMarkup(<ReactFlowProvider><S2WorkflowNodeView {...({ data: { title: s2NodeTitle(malicious), node: malicious,
    description: '显示不是指令', viewPolicy: policyFor(malicious), capability: cap, status: 'idle', artifacts: [], inputSources: { value: '使用角色设定块' } } } as any)} /></ReactFlowProvider>);
  assert.ok(!markup.includes('<script>')); assert.ok(markup.includes('&lt;script&gt;')); assert.ok(!markup.includes('技术详情'), 'Developer details are absent from ordinary nodes');
  const diagnosticMarkup = renderToStaticMarkup(<ReactFlowProvider><S2WorkflowNodeView {...({ data: { title: s2NodeTitle(malicious), node: malicious,
    developerDiagnostics: true, viewPolicy: policyFor(malicious), capability: cap, status: 'idle', artifacts: [] } } as any)} /></ReactFlowProvider>);
  assert.ok(diagnosticMarkup.includes('技术详情')); assert.ok(!diagnosticMarkup.includes('<details open'));
  assert.ok(!markup.includes('<details open')); assert.ok(!markup.includes('in:key'), 'Unused fixed parameters do not create ordinary-canvas input interfaces');
  assert.ok(diagnosticMarkup.includes('in:key'), 'Developer diagnostics retains access to the real fixed-parameter input');
  const model = { id: 'model', pluginId: 'model-test', pluginVersion: '1.0.0', capabilityId: 'generate', position: { x: 0, y: 0 }, bindings: {}, presentation: { label: '任意显示名称' } };
  const modelMarkup = renderToStaticMarkup(<ReactFlowProvider><S2WorkflowNodeView {...({ data: { title: s2NodeTitle(model), node: model,
    viewPolicy: policyFor(model), capability: s2BuiltinPluginRegistry().capability(model), status: 'idle', artifacts: [] } } as any)} /></ReactFlowProvider>);
  assert.ok(modelMarkup.includes('调用模型需确认'), 'Trusted external-call consent signal cannot be renamed away');
  const built = await designS2Canvas(scene, { disclosure: 'complete', invoke: async request => {
    if (JSON.parse(request.userInput).stage === 'assemble') {
      assert.ok(request.systemPromptOverride?.includes('面向用户使用中文显示名'));
      assert.ok(request.systemPromptOverride?.includes('纯文字入口共用一种text类型、content字段'));
    }
    return s2DesignFixtureResponse(request, definition);
  } });
  assert.equal(built.initial.execution!.nodes[0].presentation!.label, '汇集角色设定');
  assert.equal(network, 0);
  console.log('S2 generic-base presentation compatibility passed (optional canvas policy omitted): bounded display aliases over real endpoints, no execution authority/semantic changes, template/subgraph roundtrips, native inline edit and friendly material routing through actual production handlers, stale/end guards, exact local template execution, escaped accessible node SSR and builder instructions. Offline synthetic only; no actual model/browser acceptance.');
} finally { restoreCanvasUi(); globalThis.fetch = previous; }
