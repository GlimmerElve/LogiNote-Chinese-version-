import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { harness } from './scene-s2-ui-harness';
import { experimentDefinition, experimentRequest } from './fixtures/s2-experiment';
import { createS2Scene } from '../src/services/scene/sceneS2Canvas';
import { s2ComposeControls, applyS2ComposeControls, s2ComposeStructure } from '../src/interaction-packs/prompt-lab/composeControls';
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { S2WorkflowNodeView } from '../src/components/scene/S2WorkflowNodeView';
import { S2ComposeEditor } from '../src/interaction-packs/prompt-lab/ComposeEditor';
import { s2BuiltinPluginRegistry } from '../src/services/scene/sceneS2PluginRegistry';
import { ReactFlowProvider } from '@xyflow/react';

const draft = createS2Scene(experimentRequest); draft.canvasWorkspace = structuredClone(experimentDefinition);
let uiHost: S2PluginHost | undefined;
const options: Parameters<typeof harness>[0] = { initialDraft: draft, initialRequest: experimentRequest, onHost: host => { uiHost = host; } };
const ui = harness(options);
const assemblyData = () => ui.flow().props.nodes.find((node: any) => node.id === 'assemble').data;
const inputsOnNode = (data: any) => renderToStaticMarkup(<ReactFlowProvider><S2WorkflowNodeView data={{ ...data, nodeControls: undefined }} {...{} as any} /></ReactFlowProvider>).match(/class="s2-input-port"/g)?.length ?? 0;
function visibleText(node: any): string { return node === null || node === undefined || typeof node === 'boolean' ? '' : Array.isArray(node)
  ? node.map(visibleText).join('') : typeof node === 'object' ? visibleText(node.children ?? node.props?.children ?? []) : String(node); }
function exported() { ui.button('导出工作区 JSON 到下方').props.onClick(); ui.render(); return JSON.parse(ui.labelControl('工作区 JSON', 'textarea').props.value).definition.initial; }
try {
  const toolbar = ui.elements().find(element => element.props['aria-label'] === '画布工具')!;
  assert.deepEqual(ui.elements(toolbar).filter(element => element.type === 'button').map(element => ui.text(element)), ['添加', '更多']);
  const chat = ui.elements().find(element => element.type === 'aside' && element.props['aria-label'] === 'Agent 聊天')!;
  assert.ok(chat); assert.ok(!ui.text(chat).includes('能力、资料与授权')); assert.ok(!ui.text(chat).includes('选择与填写'));
  assert.ok(!ui.text(chat).includes('参数 maxOutputTokens')); assert.ok(!ui.text(chat).includes('工作区 JSON'));
  for (const removed of ['助手选项', '运行后自动分析', '解释所选内容', '给我提示', '分析本次结果']) {
    assert.ok(!ui.text(chat).includes(removed), `Removed assistant option is not retained as hidden DOM: ${removed}`);
  }
  assert.equal(ui.elements(chat).filter(element => element.type === 'input' && element.props.type === 'checkbox').length, 0);
  const panels = () => ui.elements().find(element => element.props['aria-label'] === '画布操作面板')!;
  assert.equal(panels().props.hidden, true, 'The default canvas has no mounted-visible management pane');
  const connection = () => ui.elements().find(element => element.props['aria-label'] === '连接说明')!;
  assert.equal(connection().props.hidden, true);
  ui.button('添加').props.onClick(); ui.render(); assert.equal(panels().props.hidden, false);
  assert.equal(panels().props['data-panel'], 'add');
  ui.elements().find(element => element.props['aria-label'] === '关闭画布操作面板')!.props.onClick(); ui.render();
  assert.equal(panels().props.hidden, true);
  ui.flow().props.onNodeClick({}, { id: 'role' }); ui.render();
  assert.equal(panels().props.hidden, true, 'Prompt selection does not open the redundant settings panel'); assert.equal(connection().props.hidden, true);
  assert.ok(!ui.elements().some(element => element.type === 'label' && element.children[0] === '选择块'), 'Prompt content settings are absent, not hidden duplicate editors');
  const roleNode = () => ui.flow().props.nodes.find((node: any) => node.id === 'role');
  const roleView = ui.flow().props.nodeTypes.block({ data: roleNode().data });
  assert.ok(visibleText(roleView).includes(roleNode().data.title));
  assert.ok(visibleText(roleView).includes(roleNode().data.fields[0].value), 'Idle content is readable inside the block');
  assert.equal(ui.elements(roleView).filter(element => element.type === 'textarea').length, 0, 'Editing starts on explicit double-click');
  assert.equal(ui.elements(roleView).filter(element => element.type === 'handle').length, 1, 'One material output, no redundant default relationship ports');
  const preview = ui.elements(roleView).find(element => element.props.className === 'nodrag nopan nowheel s2-content-preview')!;
  let stopped = false; preview.props.onDoubleClick({ target: null, stopPropagation() { stopped = true; }, preventDefault() {} }); ui.render();
  assert.equal(stopped, true);
  const field = roleNode().data.fields[0], editor = field.editor;
  assert.ok(editor); assert.equal(editor.props.variant, 'inline'); assert.equal(panels().props.hidden, true);
  editor.props.onSubmit({ version: 1, kind: 'field-submit', nodeId: 'role', fieldId: field.id, previousValue: field.value, value: '块内编辑的角色内容' });
  editor.props.onDone(); ui.render();
  assert.equal(roleNode().data.fields[0].value, '块内编辑的角色内容'); assert.equal(roleNode().data.fields[0].editor, undefined);
  assert.ok(!ui.text(ui.elements().find(element => element.type === 'aside' && element.props['aria-label'] === 'Agent 聊天')).includes('field-submit'), 'A local field submission never becomes an Agent chat message');
  const initialAssembly = ui.flow().props.nodes.find((node: any) => node.id === 'assemble').data.node.bindings;
  ui.labelControl('选择执行节点', 'select').props.onChange({ target: { value: 'assemble' } }); ui.render();
  const composeInline = ui.inline('assemble'), composeEditor = composeInline.elements().find(element => element.type === 'compose-editor')!;
  const disclosure = composeInline.elements().find(element => element.type === 'details')!;
  assert.ok(disclosure); assert.notEqual(disclosure.props.open, true, 'The compact structure labels are opt-in inside the node');
  const controls = s2ComposeStructure(composeEditor.props.definition, composeEditor.props.document, composeEditor.props.nodeId);
  const initialLinks = structuredClone(composeEditor.props.document.execution.links);
  composeEditor.props.onStructureChange({ prefixes: ['身份：', '任务：', '约束：'], separator: '\n' }, controls.base); ui.render();
  for (let index = 1; index <= 3; index++) assert.deepEqual(assemblyData().node.bindings[`part${index}`], initialAssembly[`part${index}`]);
  assert.deepEqual(exported().execution.links, initialLinks); assert.equal(assemblyData().viewPolicy.inputLabels.part1, '身份：');
  assert.equal(ui.modelCalls(), 0, 'Editing structure labels does not run the assistant or experiment');
  ui.keyShortcut('undo'); ui.render();
  assert.deepEqual(ui.flow().props.nodes.find((node: any) => node.id === 'assemble').data.node.bindings, initialAssembly);
  const graphBeforeSlots = JSON.stringify(exported()), baseInputs = inputsOnNode(assemblyData());
  assert.equal(baseInputs, 3, 'The declared three-part structure is fixed and visible');
  assert.equal(assemblyData().viewPolicy.addInput, undefined); assert.equal(assemblyData().viewPolicy.inputActions, undefined);
  assert.equal(JSON.stringify(exported()), graphBeforeSlots);
  const priorWireEditor = ui.inline('assemble').elements().find(element => element.type === 'compose-editor')!;
  const priorWireState = s2ComposeStructure(priorWireEditor.props.definition, priorWireEditor.props.document, 'assemble');
  ui.flow().props.onConnect({ source: 'testInput', sourceHandle: 'field:content', target: 'assemble', targetHandle: 'in:part4' }); ui.render();
  assert.deepEqual(assemblyData().node.bindings.part4, { kind: 'field', nodeId: 'testInput', fieldId: 'content' });
  assert.equal(inputsOnNode(assemblyData()), 4, 'A legacy/custom part4 binding remains visible without an ephemeral add-input action');
  const afterWire = JSON.stringify(exported());
  assert.throws(() => priorWireEditor.props.onStructureChange({ prefixes: ['', '', ''], separator: '' }, priorWireState.base), /过期|变化|视图/);
  ui.render(); assert.equal(JSON.stringify(exported()), afterWire, 'An old structure callback cannot replace newer wiring');
  const wiredDesign = exported();
  const wiredScene = createS2Scene(experimentRequest); wiredScene.canvasWorkspace = { ...structuredClone(experimentDefinition), initial: wiredDesign };
  const wired = harness({ initialDraft: wiredScene });
  try { assert.equal(inputsOnNode(wired.flow().props.nodes.find((node: any) => node.id === 'assemble').data), 4, 'A real connected input persists without ephemeral UI state'); }
  finally { wired.dispose(); }
  ui.keyShortcut('undo'); ui.render();
  assert.equal(assemblyData().node.bindings.part4, undefined);
  const oldSceneEditor = ui.inline('assemble').elements().find(element => element.type === 'compose-editor')!;
  const oldSceneState = s2ComposeStructure(oldSceneEditor.props.definition, oldSceneEditor.props.document, 'assemble');
  const other = createS2Scene({ ...experimentRequest, subject: '另一场景的本地端口' }); other.canvasWorkspace = structuredClone(experimentDefinition);
  other.canvasWorkspace.initial.execution!.nodes.find(item => item.id === 'assemble')!.bindings.prefixes = { kind: 'literal', value: ['角色：', '任务：', '输出：', '', '', '', '', '预设八：'] };
  options.initialDraft = other; options.initialRequest = { ...experimentRequest, subject: '切换到显式八入口结构' }; ui.render();
  assert.equal(inputsOnNode(assemblyData()), 8, 'Declared empty preset inputs cannot be collapsed away');
  assert.throws(() => oldSceneEditor.props.onStructureChange({ prefixes: ['', '', ''], separator: '' }, oldSceneState.base), /过期|变化|视图/);
  const endEditor = ui.inline('assemble').elements().find(element => element.type === 'compose-editor')!;
  const endState = s2ComposeStructure(endEditor.props.definition, endEditor.props.document, 'assemble');
  ui.button('开始试验').props.onClick(); ui.render();
  ui.button('结束试验').props.onClick(); ui.render();
  assert.throws(() => endEditor.props.onStructureChange({ prefixes: ['', '', ''], separator: '' }, endState.base), /过期|变化|视图/);
  assert.equal(inputsOnNode(assemblyData()), 8); assert.equal(uiHost!.history().length, 0); assert.equal(uiHost!.workflowHistory().length, 0);
  assert.equal(ui.modelCalls(), 0);
} finally { ui.dispose(); }

const definition = structuredClone(experimentDefinition), document = structuredClone(definition.initial);
const assemble = document.execution!.nodes.find(node => node.capabilityId === 'compose')!;
const state = s2ComposeControls(definition, document, assemble.id);
assert.equal(state.rows.length, 3); assert.equal(state.choices.length, 4); assert.equal(state.simple, true);
const reordered = [state.rows[2], state.rows[0], state.rows[1]].map((row, index) => ({ ...row, prefix: `第${index + 1}段：` }));
const changed = applyS2ComposeControls(definition, document, assemble.id, reordered, '\n---\n', state.base);
assert.deepEqual(changed.nodes, document.nodes, 'Only assembly configuration changes, never original user text or names');
const changedNode = changed.execution!.nodes.find(node => node.id === assemble.id)!;
assert.deepEqual(changedNode.bindings.part1, assemble.bindings.part3);
assert.deepEqual(changedNode.bindings.part2, assemble.bindings.part1);
assert.deepEqual(changedNode.bindings.part3, assemble.bindings.part2);
const host = new S2PluginHost(draft.sceneId, definition); host.setDocument(changed);
const run = await host.enqueueWorkflow([assemble.id]).completion; assert.equal(run.status, 'succeeded');
assert.equal(host.history().length, 1, 'A real compose plugin is one local execution, not a hidden bind/render graph');
const output = host.history()[0].artifacts[0].payload;
assert.equal(output.kind, 'inline');
const sourceText = (row: typeof state.rows[number]) => state.choices.find(choice => choice.id === row.source)!.text;
assert.equal((output as { value: string }).value, reordered.map(row => row.prefix + sourceText(row)).join('\n---\n'));
assert.throws(() => applyS2ComposeControls(definition, changed, assemble.id, state.rows, '\n', state.base), /已变化/);
assert.throws(() => applyS2ComposeControls(definition, document, assemble.id, [{ source: 'missing', prefix: '' }], '', state.base), /不存在/);
assert.throws(() => applyS2ComposeControls(definition, document, assemble.id, [{ ...state.rows[0], prefix: '前'.repeat(121) }], '', state.base), /无效/);

// Existing upstream data wires move with a paragraph, without coercing their
// actual text or replacing them with a field/preview.
const linked = structuredClone(document), parent = linked.execution!.nodes.find(node => node.id === assemble.id)!;
delete parent.bindings.part2;
linked.execution!.nodes.push({ id: 'upstream-compose', pluginId: 'text-template', pluginVersion: '1.0.0', capabilityId: 'compose', position: { x: 0, y: 600 },
  bindings: { part1: { kind: 'literal', value: '$& {{literal}} 不解释' } } });
linked.execution!.links.push({ source: { nodeId: 'upstream-compose', portId: 'text' }, target: { nodeId: assemble.id, portId: 'part2' } });
const linkedState = s2ComposeControls(definition, linked, assemble.id), linkedRows = [linkedState.rows[1], linkedState.rows[0], linkedState.rows[2]];
const linkedNext = applyS2ComposeControls(definition, linked, assemble.id, linkedRows, '\n', linkedState.base);
assert.ok(linkedNext.execution!.links.some(link => link.source.nodeId === 'upstream-compose' && link.target.nodeId === assemble.id && link.target.portId === 'part1'));
assert.equal(linkedNext.execution!.nodes.find(node => node.id === 'upstream-compose')!.bindings.part1.kind, 'literal');
const editor = renderToStaticMarkup(<S2ComposeEditor definition={definition} document={document} nodeId={assemble.id} onStructureChange={() => assert.fail('Rendering is not applying')} />);
assert.ok(editor.includes('入口1标题') && editor.includes('入口间的分隔文字'));
assert.ok(!editor.includes('<select') && !editor.includes('<button') && !editor.includes('应用组装设置'));
assert.ok(!editor.includes('variables') && !editor.includes('key → value'));
const result = host.history()[0].artifacts[0], cap = s2BuiltinPluginRegistry().capability(assemble);
const short = renderToStaticMarkup(<ReactFlowProvider><S2WorkflowNodeView data={{ title: '返回内容', node: assemble, capability: cap, status: 'succeeded', artifacts: [result], onReadResult: () => {} }} {...{} as any} /></ReactFlowProvider>);
assert.ok(!short.includes('技术详情') && !short.includes('全屏阅读结果') && !short.includes('展开阅读结果'));
assert.ok(short.includes('第1段：'));
const long = structuredClone(result); if (long.payload.kind === 'inline') long.payload.value = '完整原文'.repeat(1000);
const longHtml = renderToStaticMarkup(<ReactFlowProvider><S2WorkflowNodeView data={{ title: '完整返回', node: assemble, capability: cap, status: 'succeeded', artifacts: [long], onReadResult: () => {} }} {...{} as any} /></ReactFlowProvider>);
assert.ok(longHtml.includes('全屏阅读结果')); assert.ok(longHtml.includes('完整原文'.repeat(1000)));
const modelCapability = s2BuiltinPluginRegistry().capability({ pluginId: 'model-test', pluginVersion: '1.0.0', capabilityId: 'generate' });
const partialModel = { title: '即使用户改名也不能隐藏模型确认', description: '冗长说明不应常驻节点',
  node: { pluginId: 'model-test', pluginVersion: '1.0.0', capabilityId: 'generate' }, capability: modelCapability,
  status: 'idle', inputSources: { prompt: '来自不应重复显示的来源说明' }, artifacts: [] };
const partialHtml = renderToStaticMarkup(<ReactFlowProvider><S2WorkflowNodeView data={partialModel} {...{} as any} /></ReactFlowProvider>);
assert.ok(partialHtml.includes('调用模型需确认')); assert.ok(!partialHtml.includes('冗长说明不应常驻节点'));
const visibleModel = visibleText(S2WorkflowNodeView({ data: partialModel } as any));
assert.ok(!visibleModel.includes('未运行') && !visibleModel.includes('可选') && !visibleModel.includes('必需') && !visibleModel.includes('来源说明'));
const imageCapability = s2BuiltinPluginRegistry().capability({ pluginId: 'local-material', pluginVersion: '1.0.0', capabilityId: 'read-image' });
const imageArtifact = { ...structuredClone(result), type: { id: 'core.image', version: 1 }, payload: { kind: 'inline' as const, value: { resourceId: 'SyntheticImageHandle' } } };
const imageData = { title: '图片', node: { pluginId: 'local-material', pluginVersion: '1.0.0', capabilityId: 'read-image' }, capability: imageCapability, status: 'succeeded', artifacts: [imageArtifact] };
const imageHtml = renderToStaticMarkup(<ReactFlowProvider><S2WorkflowNodeView data={imageData} {...{} as any} /></ReactFlowProvider>);
assert.ok(!imageHtml.includes('查看处理结果') && !imageHtml.includes('图片材料（原图发送前可预览）'));
host.close();
  console.log('S2 experiment UI passed: compact toolbar and keyboard history, chat-only right pane, block-local content editing, fixed declared ports including unconnected presets/legacy part4, structure-label edits without wiring changes and stale/wire/scene/end protection, hidden guidance/diagnostics/idle labels/image handles, direct literal results and old programmatic row-edit/local-runtime compatibility. Synthetic hooks/SSR/local host only.');
