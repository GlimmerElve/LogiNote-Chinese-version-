import assert from 'node:assert/strict';
import { inspectS2PromptControls, inspectS2PromptTemplate, type S2PromptRecovery, type S2PromptRecoveryTarget } from '../src/interaction-packs/prompt-lab/promptControls';
import { readS2Definition, createS2Scene, exportS2Workspace } from '../src/services/scene/sceneS2Canvas';
import type { S2Document } from '../src/types/sceneS2';
import type { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { browserFreeTemplateDefinition, browserFreeTemplateRequest, browserFreeTemplateText } from './fixtures/s2-browser-definition';
import { harness } from './scene-s2-ui-harness';
import { wrapS2CanvasComposite } from '../src/services/scene/sceneS2CompositeCanvas';
import { submitS2InlineContent } from './fixtures/s2-canvas-ui-actions';

const definition = readS2Definition(browserFreeTemplateDefinition), original = JSON.stringify(definition);
// Recovery editing belongs to node-local literal parameters. Field-backed
// templates expose their original content navigator instead of a second form.
function literalUiDefinition(source: typeof definition) {
  const copy = structuredClone(source), render = copy.initial.execution!.nodes.find(node => node.id === 'render')!;
  const binding = render.bindings.template;
  if (binding?.kind === 'field') render.bindings.template = { kind: 'literal', value: copy.initial.nodes.find(node => node.id === binding.nodeId)!.values[binding.fieldId] };
  return readS2Definition(copy);
}
const cases: Array<{ code: S2PromptRecovery['code']; edit: (d: S2Document) => void; target: S2PromptRecoveryTarget }> = [
  { code: 'name-missing', edit(d) { delete d.execution!.nodes[0].bindings.key; }, target: { kind: 'purpose', nodeId: 'bindRole' } },
  { code: 'name-dynamic', edit(d) { d.nodes[0].values.content = 'role'; d.execution!.nodes[0].bindings.key = { kind: 'field', nodeId: 'role', fieldId: 'content' }; }, target: { kind: 'input', nodeId: 'bindRole', portId: 'key' } },
  { code: 'name-invalid', edit(d) { d.execution!.nodes[0].bindings.key = { kind: 'literal', value: 'bad-name' }; }, target: { kind: 'advanced', nodeId: 'bindRole', portId: 'key' } },
  { code: 'name-duplicate', edit(d) { d.execution!.nodes[1].bindings.key = { kind: 'literal', value: 'role' }; }, target: { kind: 'advanced', nodeId: 'bindTask', portId: 'key' } },
  { code: 'materials-missing', edit(d) { d.execution!.links.pop(); }, target: { kind: 'input', nodeId: 'render', portId: 'variables' } },
  { code: 'materials-shape', edit(d) { d.execution!.nodes[0].bindings.variables = { kind: 'literal', value: { 名称: false } }; }, target: { kind: 'input', nodeId: 'bindRole', portId: 'variables' } },
  { code: 'materials-capacity', edit(d) { d.execution!.nodes[0].bindings.variables = { kind: 'literal', value: Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`m${i}`, ''])) }; }, target: { kind: 'input', nodeId: 'bindRole', portId: 'variables' } },
  { code: 'template-reference', edit(d) { d.nodes.find(n => n.id === 'template')!.values.content = '{{unknown}}'; }, target: { kind: 'content', nodeId: 'template', fieldId: 'content' } },
  { code: 'template-syntax', edit(d) { d.nodes.find(n => n.id === 'template')!.values.content = '{{ role.path }}'; }, target: { kind: 'content', nodeId: 'template', fieldId: 'content' } },
  { code: 'template-capacity', edit(d) { d.nodes.find(n => n.id === 'template')!.values.content = '{{role}}'.repeat(129); }, target: { kind: 'content', nodeId: 'template', fieldId: 'content' } },
  { code: 'template-reference', edit(d) { d.execution!.nodes.find(n => n.id === 'render')!.bindings.template = { kind: 'literal', value: '{{unknown}}' }; }, target: { kind: 'advanced', nodeId: 'render', portId: 'template' } },
  { code: 'template-source', edit(d) {
    d.execution!.nodes.push({ id: 'source', pluginId: 'text-template', pluginVersion: '1.0.0', capabilityId: 'render', position: { x: 0, y: 0 }, bindings: { template: { kind: 'literal', value: '动态排版' }, variables: { kind: 'literal', value: {} } } });
    delete d.execution!.nodes.find(n => n.id === 'render')!.bindings.template;
    d.execution!.links.push({ source: { nodeId: 'source', portId: 'text' }, target: { nodeId: 'render', portId: 'template' } });
  }, target: { kind: 'input', nodeId: 'render', portId: 'template' } },
  { code: 'name-dynamic', edit(d) {
    d.execution!.nodes.push({ id: 'source', pluginId: 'text-template', pluginVersion: '1.0.0', capabilityId: 'render', position: { x: 0, y: 0 }, bindings: { template: { kind: 'literal', value: 'role' }, variables: { kind: 'literal', value: {} } } });
    delete d.execution!.nodes[0].bindings.key;
    d.execution!.links.push({ source: { nodeId: 'source', portId: 'text' }, target: { nodeId: 'bindRole', portId: 'key' } });
  }, target: { kind: 'input', nodeId: 'bindRole', portId: 'key' } },
  { code: 'materials-dynamic', edit(d) {
    d.execution!.nodes.push({ id: 'source', pluginId: 'structured-data', pluginVersion: '1.0.0', capabilityId: 'select', position: { x: 0, y: 0 }, bindings: { value: { kind: 'literal', value: { role: '原文', task: '', constraints: '' } }, pointer: { kind: 'literal', value: '' } } });
    d.execution!.links = d.execution!.links.filter(link => link.target.nodeId !== 'render');
    d.execution!.links.push({ source: { nodeId: 'source', portId: 'value' }, target: { nodeId: 'render', portId: 'variables' } });
  }, target: { kind: 'input', nodeId: 'render', portId: 'variables' } },
];
const oldFetch = globalThis.fetch; let network = 0;
globalThis.fetch = async () => { network++; throw Error('Prompt recovery is local and read-only'); };
const select = (ui: ReturnType<typeof harness>, id: string) => { ui.labelControl('选择执行节点', 'select').props.onChange({ target: { value: id } }); ui.render(); };
const recoveryButtons = (ui: ReturnType<typeof harness>) => ui.inline('render').elements().filter(e => e.type === 'button' && /^(查看来源设置|查看原内容|查看内容用途)：/.test(ui.text(e)));
try {
  for (const test of cases) {
    const doc = structuredClone(definition.initial); test.edit(doc);
    const plugins = test.code === 'materials-dynamic' ? [...definition.plugins, { pluginId: 'structured-data', pluginVersion: '1.0.0', capabilityId: 'select' }] : definition.plugins;
    const candidate = readS2Definition({ ...structuredClone(definition), plugins, initial: doc }), before = JSON.stringify(candidate);
    const state = inspectS2PromptTemplate(candidate, candidate.initial, 'render'); assert.equal(state.kind, 'unavailable');
    assert.ok(state.kind === 'unavailable'); assert.equal(state.recovery.code, test.code); assert.deepEqual(state.recovery.targets[0], test.target);
    assert.ok(state.recovery.guidance.length); assert.equal(JSON.stringify(candidate), before);
    state.recovery.targets[0].nodeId = 'forged';
    const again = inspectS2PromptTemplate(candidate, candidate.initial, 'render'); assert.ok(again.kind === 'unavailable'); assert.deepEqual(again.recovery.targets[0], test.target);
    const uiCandidate = literalUiDefinition(candidate), uiState = inspectS2PromptTemplate(uiCandidate, uiCandidate.initial, 'render');
    assert.ok(uiState.kind === 'unavailable'); assert.equal(uiState.recovery.code, test.code);
    const uiTarget: S2PromptRecoveryTarget = test.target.kind === 'content'
      ? { kind: 'advanced', nodeId: 'render', portId: 'template' } : test.target;
    assert.deepEqual(uiState.recovery.targets[0], uiTarget, 'A literal-only recovery targets its own parameter instead of an unrelated content block');
    for (const deferStateUpdates of [false, true]) {
      const scene = createS2Scene(browserFreeTemplateRequest); scene.canvasWorkspace = uiCandidate;
      let host!: S2PluginHost; const ui = harness({ initialDraft: scene, deferStateUpdates, onHost(value) { host = value; } });
      try {
        ui.button('开始试验').props.onClick(); ui.render(); select(ui, 'render');
        assert.ok(ui.inline('render').text().includes('暂不能按名称编辑')); assert.ok(ui.inline('render').text().includes('这里只定位已有设置'));
        const button = recoveryButtons(ui)[0]; assert.ok(button); const stale = button.props.onClick;
        button.props.onClick(); ui.render();
        const selected = ui.flow().props.nodes.find((n: any) => n.selected); assert.equal(selected.id, uiTarget.nodeId);
        assert.ok(ui.text().includes('没有改值、断线、读取资料或运行'));
        assert.deepEqual(ui.drafts.at(-1)!.canvasWorkspace.initial, uiCandidate.initial);
        select(ui, 'render'); stale(); ui.render();
        assert.equal(ui.labelControl('选择执行节点', 'select').props.value, 'render', 'Old navigation cannot act after a newer render');
        const ended = recoveryButtons(ui)[0].props.onClick; ui.button('结束试验').props.onClick(); ui.render(); ended(); ui.render();
        assert.equal(host.workflowHistory().length, 0); assert.equal(host.history().length, 0); assert.equal(host.remainingCalls, 64); assert.equal(ui.modelCalls(), 0);
        assert.deepEqual(ui.drafts.at(-1)!.canvasWorkspace.initial, uiCandidate.initial);
      } finally { ui.dispose(); }
    }
    assert.equal(JSON.stringify(candidate), before);
  }
  // An actual run can resolve a dynamic name, but must never turn it into a static editor declaration.
  const dynamic = literalUiDefinition(definition); cases[1].edit(dynamic.initial);
  const scene = createS2Scene(browserFreeTemplateRequest); scene.canvasWorkspace = dynamic;
  let host!: S2PluginHost; const ui = harness({ initialDraft: scene, deferStateUpdates: true, onHost(value) { host = value; } });
  try {
    ui.button('开始试验').props.onClick(); ui.render(); select(ui, 'render');
    const first = recoveryButtons(ui)[0].props.onClick;
    ui.button('运行所选步骤').props.onClick();
    for (let i = 0; i < 40 && host.workflowHistory().at(-1)?.status !== 'succeeded'; i++) { await new Promise(resolve => setTimeout(resolve, 0)); ui.render(); }
    assert.equal(host.workflowHistory().at(-1)!.status, 'succeeded'); assert.equal(host.remainingCalls, 60);
    assert.ok(ui.inline('render').text().includes('仅运行一次不会把它变成固定名称'));
    const after = inspectS2PromptTemplate(dynamic, ui.drafts.at(-1)!.canvasWorkspace.initial, 'render'); assert.ok(after.kind === 'unavailable'); assert.equal(after.recovery.code, 'name-dynamic');
    first(); ui.render(); assert.equal(ui.labelControl('选择执行节点', 'select').props.value, 'render');
    recoveryButtons(ui)[0].props.onClick(); ui.render(); assert.equal(ui.labelControl('选择执行节点', 'select').props.value, 'bindRole');
    const dynamicBinding = ui.flow().props.nodes.find((n: any) => n.id === 'bindRole').data.node.bindings.key;
    assert.deepEqual(dynamicBinding, { kind: 'field', nodeId: 'role', fieldId: 'content' });
    assert.equal(host.workflowHistory().length, 1); assert.equal(host.remainingCalls, 60); assert.equal(ui.modelCalls(), 0);
  } finally { ui.dispose(); }
  // Unknown references still lead to the original content, which has the only
  // source editor. Correcting it never changes the field binding to a literal.
  const unknown = structuredClone(definition); cases[7].edit(unknown.initial);
  const sourceScene = createS2Scene(browserFreeTemplateRequest); sourceScene.canvasWorkspace = unknown;
  const sourceUI = harness({ initialDraft: sourceScene });
  try {
    sourceUI.button('开始试验').props.onClick(); sourceUI.render(); select(sourceUI, 'render'); sourceUI.inline('render').button('编辑原内容').props.onClick(); sourceUI.render();
    const sourceNode = sourceUI.flow().props.nodes.find((node: any) => node.id === 'template');
    assert.equal(sourceNode.selected, true); assert.equal(sourceNode.data.fields[0].editor.props.variant, 'inline', 'Recovery opens the original content inside its block');
    submitS2InlineContent(sourceUI, 'template', browserFreeTemplateText); select(sourceUI, 'render');
    assert.ok(sourceUI.inline('render').elements().some(e => e.props['aria-label'] === '提示词排版来源'));
    assert.ok(!sourceUI.inline('render').elements().some(e => e.type === 'form'));
    assert.deepEqual(sourceUI.flow().props.nodes.find((n: any) => n.id === 'render').data.node.bindings.template, { kind: 'field', nodeId: 'template', fieldId: 'content' });
    assert.ok(!JSON.stringify(exportS2Workspace(unknown, sourceUI.drafts.at(-1)!.canvasWorkspace.initial)).includes('recovery'));
  } finally { sourceUI.dispose(); }
  // Nested target navigation enters its actual innermost owner without exposing or editing the graph.
  const nested = literalUiDefinition(definition); cases[0].edit(nested.initial);
  const inner = wrapS2CanvasComposite(nested.initial, nested.plugins, ['bindRole'], '内层名称');
  const outer = wrapS2CanvasComposite(inner.document, nested.plugins, ['bindRole'], '外层材料');
  nested.initial = outer.document;
  const nestedScene = createS2Scene(browserFreeTemplateRequest); nestedScene.canvasWorkspace = nested;
  const nestedUI = harness({ initialDraft: nestedScene, deferStateUpdates: true });
  try {
    nestedUI.button('开始试验').props.onClick(); nestedUI.render(); select(nestedUI, 'render');
    const old = recoveryButtons(nestedUI)[0].props.onClick;
    old(); nestedUI.render(); assert.ok(nestedUI.flow().props.nodes.some((n: any) => n.id === 'bindRole' && n.selected));
    assert.ok(nestedUI.inline('bindRole').elements().some(e => e.type === 'form' && e.props['aria-label'] === '设置内容用途'));
    old(); nestedUI.render(); assert.deepEqual(nestedUI.drafts.at(-1)!.canvasWorkspace.initial, nested.initial);
  } finally { nestedUI.dispose(); }
  // Inert focus contract: same-node advanced location opens its ancestor once, disconnected targets do not focus.
  const advanced = structuredClone(definition); cases[10].edit(advanced.initial);
  const advancedScene = createS2Scene(browserFreeTemplateRequest); advancedScene.canvasWorkspace = advanced;
  const focusUI = harness({ initialDraft: advancedScene });
  try {
    focusUI.button('开始试验').props.onClick(); focusUI.render(); select(focusUI, 'render');
    let focuses = 0, scrolls = 0; const ancestor = { tagName: 'DETAILS', open: false, parentElement: null };
    const panel = { isConnected: true, parentElement: ancestor, focus() { focuses++; }, scrollIntoView() { scrolls++; } };
    focusUI.elements().find(e => e.props['aria-label'] === '生成完整提示词「提示词排版」的高级设置')!.props.ref(panel);
    recoveryButtons(focusUI)[0].props.onClick(); focusUI.render(); assert.equal(focuses, 1); assert.equal(scrolls, 1); assert.equal(ancestor.open, true);
    focusUI.render(); assert.equal(focuses, 1, 'Consumed navigation never steals focus on a later render');
    panel.isConnected = false; recoveryButtons(focusUI)[0].props.onClick(); focusUI.render(); assert.equal(focuses, 1);
    assert.deepEqual(focusUI.drafts.at(-1)!.canvasWorkspace.initial, advanced.initial);
  } finally { focusUI.dispose(); }
  for (const deferStateUpdates of [false, true]) {
    const draftScene = createS2Scene(browserFreeTemplateRequest); draftScene.canvasWorkspace = literalUiDefinition(definition);
    let host!: S2PluginHost; const draftUI = harness({ initialDraft: draftScene, deferStateUpdates, onHost(value) { host = value; } });
    try {
      draftUI.button('开始试验').props.onClick(); draftUI.render(); select(draftUI, 'render');
      draftUI.inline('render').labelControl('第1片段文字', 'textarea').props.onChange({ target: { value: '私有排版草稿\n' } }); draftUI.render();
      select(draftUI, 'bindRole'); draftUI.labelControl('引用字段 key', 'select').props.onChange({ target: { value: JSON.stringify(['role', 'content']) } }); draftUI.render();
      select(draftUI, 'render'); assert.ok(draftUI.inline('render').text().includes('暂不能按名称编辑')); const stale = recoveryButtons(draftUI)[0].props.onClick;
      draftUI.keyShortcut('undo'); draftUI.render();
      assert.equal(draftUI.inline('render').labelControl('第1片段文字', 'textarea').props.value, '私有排版草稿\n');
      assert.equal(draftUI.drafts.at(-1)!.canvasWorkspace.initial.nodes.find((n: any) => n.id === 'template').values.content, browserFreeTemplateText);
      draftUI.keyShortcut('redo'); draftUI.render(); stale(); draftUI.render();
      assert.equal(draftUI.labelControl('选择执行节点', 'select').props.value, 'render', 'Undo/redo cannot revive old navigation even when the source is identical again');
      assert.equal(host.workflowHistory().length, 0); assert.equal(host.remainingCalls, 64); assert.equal(draftUI.modelCalls(), 0);
    } finally { draftUI.dispose(); }
  }
  const staticState = inspectS2PromptControls(definition, definition.initial, 'bindRole'); assert.ok(staticState.kind === 'purpose'); assert.equal(staticState.recovery, undefined);
  assert.equal(JSON.stringify(definition), original); assert.equal(network, 0);
  console.log('S2 prompt recovery passed: pure field/literal cause classification, literal-only inline recovery and exact original-input/advanced/purpose targets, clone isolation and no guessing; ordinary/deferred navigation, old-render/end guards, dynamic binding after real local run, original-field repair through the sole block editor with binding preserved, no stored recovery authority or model/network. Synthetic offline only; native focus checked separately in browser.');
} finally { globalThis.fetch = oldFetch; }
