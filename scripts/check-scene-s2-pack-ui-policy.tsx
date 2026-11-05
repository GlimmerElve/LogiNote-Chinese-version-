import assert from 'node:assert/strict';
import React from 'react';
import type { SceneInteractionPack, ScenePackCanvasPolicy } from '../src/types/sceneInteractionPack';
import type { S2CanvasDefinition } from '../src/types/sceneS2';
import type { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { createS2Scene, readS2Definition } from '../src/services/scene/sceneS2Canvas';
import { sceneInteractionPacks } from '../src/services/scene/sceneInteractionPacks';
import { S2PluginProtocolError } from '../src/services/scene/sceneS2PluginProtocol';
import { harness } from './scene-s2-ui-harness';

const previousFetch = globalThis.fetch; let networkCalls = 0, packageExecutions = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error('Package UI policy tests prohibit network and real model calls'); };
const ref = (pluginId: string, capabilityId: string) => ({ pluginId, pluginVersion: '1.0.0', capabilityId });
const parse = ref('structured-data', 'parse-json'), check = ref('json-check', 'validate'), show = ref('structured-view', 'text');
const foreign = ref('text-template', 'compose');
const key = (capability: ReturnType<typeof ref>) => `${capability.pluginId}@${capability.pluginVersion}/${capability.capabilityId}`;
const live: ReturnType<typeof harness>[] = [];
function install(name: string, canvas?: ScenePackCanvasPolicy, views?: SceneInteractionPack['views']) {
  const identity = { id: `ui-policy-${name}`, version: '1.0.0' };
  const pack: SceneInteractionPack = { manifest: { ...identity, protocolVersion: 1, paradigm: 'S2', paradigmApiVersion: 1,
    name: '独立开发者界面包', requiredServices: [] }, capabilities: [],
    describe: () => ({ purpose: '验证通用画布界面声明', components: [], combinations: [], operations: [],
      builder: { assemble: '按目标提供画布', repair: '保留原文修正' }, assistant: { instructions: '按需协作', defaultAllowedOperations: [] } }),
    validate: () => [], createRuntime() { packageExecutions++; throw new Error('UI metadata must not start a package runtime'); },
    executeLocal: async () => { packageExecutions++; throw new Error('UI metadata must not execute plugins'); },
    ...(canvas ? { canvas } : {}), ...(views ? { views } : {}),
  };
  sceneInteractionPacks.register(pack); return identity;
}
function create(name: string, canvas?: ScenePackCanvasPolicy) {
  let host: S2PluginHost | undefined;
  const identity = install(name, canvas);
  const request = { source: 'custom' as const, sceneSkill: 'S2' as const, subject: '合成通用界面策略', knowledgePoints: [], interactionPack: identity };
  const scene = createS2Scene(request);
  const definition = readS2Definition({ ...scene.canvasWorkspace,
    blockTypes: [{ id: 'choice', label: '选择内容', fields: [{ id: 'answer', label: '选择项', kind: 'enum', options: ['甲', '乙'], required: true }] },
      { id: 'text', label: '自由文字', fields: [{ id: 'content', label: '内容', kind: 'multiline' }] }],
    plugins: [parse], initial: { nodes: [
      { id: 'goal', type: 'choice', position: { x: 0, y: 0 }, values: { answer: '甲' } },
      { id: 'free', type: 'text', position: { x: 0, y: 200 }, values: { content: '保留自由文字' } },
      { id: 'fixed', type: 'choice', readOnly: true, position: { x: 0, y: 400 }, values: { answer: '甲' } },
    ], edges: [] },
  });
  scene.canvasWorkspace = definition;
  const original = JSON.stringify(scene);
  const ui = harness({ initialRequest: request, initialDraft: scene, onHost: value => { host = value; } }); live.push(ui);
  return { ui, scene, definition, original, host: () => host };
}
function field(ui: ReturnType<typeof harness>, id = 'goal', fieldId = 'answer') {
  const node = ui.flow().props.nodes.find((item: any) => item.id === id); assert(node, id);
  const result = node.data.fields.find((item: any) => item.id === fieldId); assert(result, fieldId); return result;
}
function select(ui: ReturnType<typeof harness>, id: string) { ui.flow().props.onNodeClick({}, { id }); ui.render(); }
function editor(ui: ReturnType<typeof harness>, id = 'goal', fieldId = 'answer') {
  const found = ui.elements(field(ui, id, fieldId).editor).find(item => item.type === 'field-editor'); assert(found, 'Generic inline field editor'); return found;
}
function document(ui: ReturnType<typeof harness>) {
  ui.button('导出工作区 JSON 到下方').props.onClick(); ui.render();
  return JSON.parse(ui.labelControl('工作区 JSON', 'textarea').props.value).definition as S2CanvasDefinition;
}
function panel(ui: ReturnType<typeof harness>) {
  const element = ui.elements().find(item => item.props['aria-label'] === '画布操作面板'); assert(element); return element;
}
function menuButton(ui: ReturnType<typeof harness>, capability: ReturnType<typeof ref>) {
  const button = ui.elements().find(item => item.type === 'button' && item.props['data-s2-capability'] === key(capability)); assert(button, key(capability)); return button;
}
function region(ui: ReturnType<typeof harness>, label: string) {
  const element = ui.elements().find(item => item.props.role === 'region' && item.props['aria-label'] === label); assert(element, label); return element;
}

/** Render only the inert third-party fixture function that the generic VM harness keeps opaque.
 * Production Trial and ScenePackView already produced its checked context and native slot. */
function fixtureResourceControls(ui: ReturnType<typeof harness>, nodeId: string) {
  const node = ui.flow().props.nodes.find((item: any) => item.id === nodeId); assert(node);
  const walk = (value: any): any[] => {
    if (Array.isArray(value)) return value.flatMap(walk);
    if (!value || typeof value !== 'object') return [];
    if (typeof value.type === 'function') return walk(value.type(value.props));
    return [value, ...walk(value.children || value.props?.children || [])];
  };
  return walk(node.data.nodeControls);
}
function createResourceView(name: string, resourceInputInView?: boolean, inline = true) {
  let host: S2PluginHost | undefined;
  const resource = ref('local-material', 'read-image'), nodeId = 'legacy-image';
  const identity = install(name, undefined, { 'local-material/read-image': {
    ...(inline ? { inline: (context: any) => resourceInputInView === true ? context.resourceInput : React.createElement('small', { 'data-legacy-resource-view': true }, '旧包自己的说明') } : {}),
    policy: () => resourceInputInView === undefined ? {} : { resourceInputInView },
  } });
  const request = { source: 'custom' as const, sceneSkill: 'S2' as const, subject: '第三方资源控件兼容', knowledgePoints: [], interactionPack: identity };
  const scene = createS2Scene(request);
  scene.canvasWorkspace = readS2Definition({ ...scene.canvasWorkspace, blockTypes: [{ id: 'text', label: '内容', fields: [{ id: 'content', label: '内容', kind: 'multiline' }] }],
    plugins: [resource], initial: { nodes: [{ id: 'pinned', type: 'text', readOnly: true, position: { x: 0, y: 200 }, values: { content: '固定原文不可被slot反写' } }], edges: [],
    execution: { version: 1, nodes: [{ ...resource, id: nodeId, position: { x: 0, y: 0 }, bindings: {} }], links: [] } } });
  const ui = harness({ initialRequest: request, initialDraft: scene, onHost: value => { host = value; } }); live.push(ui);
  return { ui, nodeId, host: () => host };
}

try {
  const beforeInvalidPolicies = sceneInteractionPacks.catalog();
  for (const invalidPolicy of [{ contentSettings: 'hide' }, { contentSettings: 'hide', contentEditing: 'panel' }] as const) {
    assert.throws(() => create('unreachable-editor', invalidPolicy), /隐藏内容设置区时必须显式选择inline或double-click/,
      'A package cannot remove every editing entry before the canvas is shown');
  }
  assert.deepEqual(sceneInteractionPacks.catalog(), beforeInvalidPolicies, 'Rejected editor combinations publish no partial package');
  // A package with no new declaration keeps the legacy general controls and selected-capability picker.
  const legacy = create('legacy');
  select(legacy.ui, 'goal'); assert.equal(panel(legacy.ui).props.hidden, false);
  assert(legacy.ui.elements().some(item => item.type === 'field-editor' && item.props.nodeId === 'goal'));
  assert.equal(typeof field(legacy.ui, 'free', 'content').edit, 'function');
  assert.equal(field(legacy.ui, 'goal').editor, undefined);
  assert.equal(legacy.ui.elements().filter(item => item.props['data-s2-capability']).length, 0);
  assert(legacy.ui.labelControl('添加的执行能力', 'select'));
  assert.equal(JSON.stringify(legacy.scene), legacy.original);

  const panelOnly = create('panel', { contentEditing: 'panel', openSettingsOnSelect: true, contentSettings: 'show' });
  select(panelOnly.ui, 'goal');
  assert.equal(field(panelOnly.ui, 'goal').startEdit, undefined); assert.equal(field(panelOnly.ui, 'free', 'content').edit, undefined);
  const selectedEditor = panelOnly.ui.elements().find(item => item.type === 'field-editor' && item.props.nodeId === 'goal'); assert(selectedEditor);
  selectedEditor.props.onSubmit({ version: 1, kind: 'field-submit', nodeId: 'goal', fieldId: 'answer', previousValue: '甲', value: '乙' }); panelOnly.ui.render();
  assert.equal(document(panelOnly.ui).initial.nodes.find(node => node.id === 'goal')!.values.answer, '乙');
  assert.equal(panelOnly.ui.modelCalls(), 0);

  const inline = create('inline', { contentEditing: 'inline', openSettingsOnSelect: false, contentSettings: 'hide' });
  select(inline.ui, 'goal'); assert.equal(panel(inline.ui).props.hidden, true);
  assert.equal(inline.ui.elements().filter(item => item.type === 'field-editor' && item.props.nodeId === 'goal').length, 0, 'Hidden duplicate content panel is absent');
  assert.equal(editor(inline.ui).props.field.kind, 'enum', 'Inline editing uses the declared native field, not an unvalidated text replacement');
  assert.equal(field(inline.ui, 'fixed').editor, undefined, 'A fixed instance cannot acquire an inline editor');

  const policy: ScenePackCanvasPolicy = { contentEditing: 'double-click', openSettingsOnSelect: false, contentSettings: 'hide',
    addMenu: { contentLabel: '本包内容', groups: [
      { id: 'processing', label: '本包处理', capabilities: [parse, check] },
      { id: 'display', label: '本包展示', capabilities: [show] },
      { id: 'foreign', label: '其他包组件不能借此开放', capabilities: [foreign] },
    ], otherCapabilities: 'hide' } };
  const policySnapshot = JSON.stringify(policy), doubleClick = create('double-click', policy), ui = doubleClick.ui;
  select(ui, 'goal'); assert.equal(panel(ui).props.hidden, true); assert.equal(field(ui).editor, undefined);
  field(ui).startEdit(); ui.render(); assert.equal(panel(ui).props.hidden, true);
  const firstEditor = editor(ui); assert.equal(firstEditor.props.field.kind, 'enum'); assert.equal(firstEditor.props.disabled, false);
  assert.throws(() => firstEditor.props.onSubmit({ version: 1, kind: 'field-submit', nodeId: 'goal', fieldId: 'answer', previousValue: '甲', value: '丙' }));
  assert.equal(document(ui).initial.nodes.find(node => node.id === 'goal')!.values.answer, '甲');
  firstEditor.props.onSubmit({ version: 1, kind: 'field-submit', nodeId: 'goal', fieldId: 'answer', previousValue: '甲', value: '乙' }); ui.render();
  assert.equal(document(ui).initial.nodes.find(node => node.id === 'goal')!.values.answer, '乙');
  assert.throws(() => firstEditor.props.onSubmit({ version: 1, kind: 'field-submit', nodeId: 'goal', fieldId: 'answer', previousValue: '甲', value: '乙' }), /变化/);
  ui.keyShortcut('undo'); ui.render(); assert.equal(document(ui).initial.nodes.find(node => node.id === 'goal')!.values.answer, '甲');
  field(ui, 'fixed').startEdit(); ui.render(); assert.equal(field(ui, 'fixed').editor, undefined);
  assert.equal(document(ui).initial.nodes.find(node => node.id === 'fixed')!.values.answer, '甲');

  ui.button('添加').props.onClick(); ui.render();
  assert(ui.elements().some(item => item.props['aria-label'] === '添加组件'));
  assert.match(ui.text(region(ui, '本包处理')), /读取结构化内容/);
  assert.match(ui.text(region(ui, '本包展示')), /展示返回原文/);
  assert(!ui.elements().some(item => item.props['aria-label'] === '其他包组件不能借此开放'), 'Menu metadata cannot expose a capability owned by a different selected package');
  assert.equal(ui.elements().filter(item => item.props['data-s2-capability']).length, 3);
  assert(ui.text().includes('本包内容')); assert(ui.button('＋选择内容')); assert(ui.button('＋自由文字'));
  const add = menuButton(ui, show), staleAdd = add.props.onClick;
  assert.equal(add.props.disabled, false); assert.equal(doubleClick.host(), undefined);
  const before = document(ui).initial.execution?.nodes.length ?? 0;
  add.props.onClick(); ui.render();
  let configured = document(ui);
  assert.equal(configured.initial.execution!.nodes.length, before + 1);
  assert(configured.plugins!.some(cap => key(cap) === key(show)), 'Explicit preview addition extends configuration scope after validation');
  assert.equal(doubleClick.host(), undefined, 'Preview composition does not create or grant a running host');
  staleAdd(); ui.render(); assert.equal(document(ui).initial.execution!.nodes.length, before + 1, 'Stale add callbacks cannot duplicate a node');
  ui.keyShortcut('undo'); ui.render(); assert.equal(document(ui).initial.execution?.nodes.length ?? 0, before);
  ui.keyShortcut('redo'); ui.render(); assert.equal(document(ui).initial.execution!.nodes.length, before + 1);
  const staleUnselected = menuButton(ui, check).props.onClick;
  assert.equal(doubleClick.host(), undefined);
  select(ui, 'goal'); field(ui).startEdit(); ui.render();
  editor(ui).props.onSubmit({ version: 1, kind: 'field-submit', nodeId: 'goal', fieldId: 'answer', previousValue: '甲', value: '乙' }); ui.render();
  assert.equal(ui.modelCalls(), 0, 'Editing inside a block is not a chat/Agent invocation');
  ui.labelControl('向 Agent 提出要求', 'textarea').props.onChange({ target: { value: '只解释已提交选择，不运行' } }); ui.render();
  ui.button('发送').props.onClick(); ui.render();
  const host = doubleClick.host()!; assert(host);
  const grant = JSON.stringify(host.prepare(null, { goal: '合成检查', understanding: '理解', planning: '计划', response: '回应' }, '').approvedCapabilities);
  assert.equal(menuButton(ui, check).props.disabled, true, 'A running session cannot add capabilities absent from its selected scope');
  configured = document(ui); staleUnselected(); ui.render(); assert.deepEqual(document(ui), configured);
  assert.equal(JSON.stringify(host.prepare(null, { goal: '合成检查', understanding: '理解', planning: '计划', response: '回应' }, '').approvedCapabilities), grant);
  assert.equal(ui.history()!.length, 0, 'Checked submission does not insert a field-submit JSON message into chat');
  assert(ui.pluginContext()!.interactions.fieldStates.some((state: any) => state.nodeId === 'goal' && state.fieldId === 'answer' && state.state === 'submitted'));
  ui.resolve({ understanding: '解释选择', plan: '只读', reply: '你已选择乙。', commands: [] });
  await new Promise(resolve => setImmediate(resolve)); ui.render();
  assert(!ui.elements().some(item => item.type === 'button' && /^(开启|关闭)助手$/.test(ui.text(item))), 'The assistant has no global enabled/disabled mode');
  ui.labelControl('向 Agent 提出要求', 'textarea').props.onChange({ target: { value: '可以停止这一次回应' } }); ui.render();
  ui.button('发送').props.onClick(); ui.render();
  ui.button('停止助手请求').props.onClick(); ui.render();
  ui.resolve({ understanding: '过期', plan: '只读', reply: 'CANCELLED_LATE_REPLY', commands: [] });
  await new Promise(resolve => setImmediate(resolve)); ui.render();
  assert(!ui.text().includes('CANCELLED_LATE_REPLY'));
  ui.labelControl('向 Agent 提出要求', 'textarea').props.onChange({ target: { value: '继续正常对话' } }); ui.render();
  assert.equal(ui.button('发送').props.disabled, false, 'Stopping one request does not disable later conversation');
  ui.button('发送').props.onClick(); ui.render();
  ui.resolve({ understanding: '继续', plan: '只读', reply: '助手仍然可用。', commands: [] });
  await new Promise(resolve => setImmediate(resolve)); ui.render(); assert(ui.text().includes('助手仍然可用。'));
  const endedEditor = editor(ui).props.onSubmit;
  ui.button('返回').props.onClick(); ui.render();
  assert.throws(() => endedEditor({ version: 1, kind: 'field-submit', nodeId: 'goal', fieldId: 'answer', previousValue: '乙', value: '甲' }), /过期/);
  assert.equal(document(ui).initial.nodes.find(node => node.id === 'goal')!.values.answer, '乙');
  assert.equal(host.history().length, 0); assert.equal(host.workflowHistory().length, 0);
  assert.equal(JSON.stringify(policy), policySnapshot); assert.equal(JSON.stringify(doubleClick.scene), doubleClick.original);

  const showOthers = create('default-others', { addMenu: { groups: [{ id: 'one', label: '明确分组', capabilities: [show] }] } });
  assert(menuButton(showOthers.ui, ref('structured-data', 'select')), 'Unlisted abilities stay visible unless otherCapabilities explicitly hides them');
  assert(region(showOthers.ui, '其他组件'));
  for (const [name, resourceInputInView] of [['old-resource-inline', undefined], ['host-resource-inline', false], ['claimed-resource-inline', true]] as const) {
    const fixture = createResourceView(name, resourceInputInView);
    const controls = fixtureResourceControls(fixture.ui, fixture.nodeId);
    assert.equal(controls.filter(element => element.type === 'image-materials').length, 1,
      'Old undefined/false inline policies retain one host picker; explicit slot ownership prevents a duplicate');
    assert.equal(controls.filter(element => element.props?.['data-legacy-resource-view']).length, resourceInputInView === true ? 0 : 1);
    assert.equal(fixture.ui.modelCalls(), 0);
  }
  const noInline = createResourceView('resource-policy-only', true, false);
  assert.equal(fixtureResourceControls(noInline.ui, noInline.nodeId).filter(element => element.type === 'image-materials').length, 1,
    'A presentation flag without an actual inline view cannot hide the only native picker');
  const resourceBoundary = createResourceView('resource-private-boundary', true);
  assert.equal(resourceBoundary.host(), undefined);
  const resourceElement = fixtureResourceControls(resourceBoundary.ui, resourceBoundary.nodeId).find(element => element.type === 'image-materials'); assert(resourceElement);
  const resourceHost = resourceElement.props.host; assert(resourceHost && Object.isFrozen(resourceHost));
  assert.deepEqual(resourceHost.imageResourceSummary(), []); assert.equal(resourceBoundary.host(), undefined, 'Rendering/listing resources never creates a session');
  await assert.rejects(async () => resourceHost.approveImageFile(new File([new Uint8Array([0])], 'invalid.png', { type: 'image/png' })));
  resourceBoundary.ui.render(); assert(resourceBoundary.host(), 'An actual file choice acquires the session, even if file validation rejects it');
  assert.notEqual(resourceHost, resourceBoundary.host(), 'A React slot never exposes its execution Host through props');
  assert.deepEqual(Object.keys(resourceHost).sort(), ['approveImageFile', 'imageResourcePreview', 'imageResourceSummary', 'revokeImageFile']);
  for (const name of ['confirmModelTest', 'approveModelTestSession', 'execute', 'enqueueWorkflow', 'currentArtifact', 'prepare'])
    assert.equal(name in resourceHost, false, `${name} cannot escape through resource UI props`);
  resourceBoundary.ui.render();
  const nextResourceElement = fixtureResourceControls(resourceBoundary.ui, resourceBoundary.nodeId).find(element => element.type === 'image-materials')!;
  assert.equal(nextResourceElement.props.host, resourceHost, 'The resource facade remains stable across ordinary renders');
  try { resourceElement.props.document.nodes[0].values.content = '不能通过slot绕过只读写入'; } catch { /* Frozen detached snapshots may reject the write outright. */ }
  resourceBoundary.ui.render();
  assert.equal(field(resourceBoundary.ui, 'pinned', 'content').value, '固定原文不可被slot反写', 'Resource props expose no live document alias');
  resourceBoundary.ui.button('返回').props.onClick(); resourceBoundary.ui.render();
  assert.deepEqual(resourceHost.imageResourceSummary(), []);
  const endedRun = (error: any) => error?.code === 'RUN_ENDED';
  assert.throws(() => resourceHost.imageResourcePreview('retired-image'), endedRun);
  await assert.rejects(async () => resourceHost.approveImageFile(new File([new Uint8Array([0])], 'synthetic.png', { type: 'image/png' })), endedRun);
  assert.equal(resourceBoundary.host()!.history().length, 0); assert.equal(resourceBoundary.host()!.workflowHistory().length, 0);
  assert.equal(resourceBoundary.ui.modelCalls(), 0);
  assert.equal(packageExecutions, 0); assert.equal(networkCalls, 0);
  console.log('S2 package canvas UI policy passed: legacy editors and third-party resource-inline compatibility, explicit single native-slot ownership, no duplicate hidden settings, local submit evidence without synthetic chat, exact scoped grouped menu, preview-only composition, undo/stale/readOnly/end guards and unchanged runtime grants. Real production handlers with deterministic hooks; not browser layout or live-model acceptance.');
} finally { live.forEach(ui => ui.dispose()); globalThis.fetch = previousFetch; }
