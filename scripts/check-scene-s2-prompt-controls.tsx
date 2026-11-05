import assert from 'node:assert/strict';
import { inspectS2PromptControls, setS2PromptPurpose, applyS2PromptSections, compileS2PromptSections } from '../src/interaction-packs/prompt-lab/promptControls';
import { readS2Definition, readS2Document, createS2Scene, exportS2Workspace, importS2Workspace } from '../src/services/scene/sceneS2Canvas';
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { browserTemplateDefinition, browserTemplateRequest } from './fixtures/s2-browser-definition';
import type { S2Document, S2WorkflowNode } from '../src/types/sceneS2';
import { harness } from './scene-s2-ui-harness';

const bind = { pluginId: 'text-template', pluginVersion: '1.0.0', capabilityId: 'bind' }, render = { ...bind, capabilityId: 'render' };
const originalText = '不替换 {{later}}，保留 $&、换行\n以及 <script>文字</script>';
const make = (id: string, cap = bind): S2WorkflowNode => ({ id, ...cap, position: { x: 40, y: 40 }, bindings: {} });
const raw = structuredClone(browserTemplateDefinition); delete raw.business;
raw.plugins = [bind, render];
raw.initial.execution = { version: 1, nodes: [
  { ...make('one'), bindings: { value: { kind: 'literal', value: originalText } } },
  { ...make('two'), bindings: { value: { kind: 'literal', value: '' } } }, make('layout', render),
], links: [
  { source: { nodeId: 'one', portId: 'variables' }, target: { nodeId: 'two', portId: 'variables' } },
  { source: { nodeId: 'two', portId: 'variables' }, target: { nodeId: 'layout', portId: 'variables' } },
] };
const definition = readS2Definition(raw), original = JSON.stringify(definition);
let document = structuredClone(definition.initial);
const oldFetch = globalThis.fetch; let network = 0;
globalThis.fetch = async () => { network++; throw new Error('Prompt controls are local only'); };
const hosts: S2PluginHost[] = [], uis: ReturnType<typeof harness>[] = [];
try {
  const before = JSON.stringify(document), p1 = inspectS2PromptControls(definition, document, 'one');
  assert.equal(p1.kind, 'purpose'); assert(p1.kind === 'purpose' && p1.canSet);
  assert.equal(inspectS2PromptControls(definition, document, 'layout').kind, 'unavailable');
  for (const label of ['', ' ', '长'.repeat(81)]) assert.throws(() => setS2PromptPurpose(definition, document, 'one', label, p1.base));
  document = setS2PromptPurpose(definition, document, 'one', '角色设定', p1.base);
  assert.equal(JSON.stringify(definition.initial), before); assert.equal(document.execution!.nodes[0].bindings.key.kind, 'literal');
  assert.equal(document.execution!.nodes[0].bindings.value.kind, 'literal'); assert.deepEqual(document.execution!.nodes[0].bindings.value, definition.initial.execution!.nodes[0].bindings.value);
  assert.equal(document.execution!.nodes[0].presentation!.inputs!.value, '角色设定');
  assert.throws(() => setS2PromptPurpose(definition, document, 'one', '改用途', p1.base), /已变化/);
  assert.throws(() => setS2PromptPurpose(definition, document, 'one', '改用途', inspectS2PromptControls(definition, document, 'one').base), /已有名称/);
  document = setS2PromptPurpose(definition, document, 'two', '任务要求', inspectS2PromptControls(definition, document, 'two').base);
  let layout = inspectS2PromptControls(definition, document, 'layout'); assert.equal(layout.kind, 'layout'); if (layout.kind !== 'layout') throw new Error('Missing layout');
  assert.deepEqual(layout.available.map(item => item.label), ['角色设定', '任务要求']);
  const rows = [{ material: layout.available[0].key, heading: '角色' }, { material: layout.available[1].key, heading: '任务' }];
  const plain = JSON.stringify(document), applied = applyS2PromptSections(definition, document, 'layout', rows, layout.base);
  assert.equal(JSON.stringify(document), plain); assert.deepEqual(applied.execution!.nodes.slice(0, 2), document.execution!.nodes.slice(0, 2));
  assert.deepEqual(applied.nodes, document.nodes); assert.deepEqual(applied.execution!.links, document.execution!.links);
  const roundtrip = inspectS2PromptControls(definition, applied, 'layout'); assert(roundtrip.kind === 'layout'); assert.deepEqual(roundtrip.rows, rows);
  assert.deepEqual(importS2Workspace(exportS2Workspace(definition, applied)).initial, applied);
  for (const bad of [null, [{ material: 'unknown', heading: '' }], [{ ...rows[0], execute: true }], [{ ...rows[0], heading: '{{other}}' }], [{ ...rows[0], heading: '跨\n行' }], [{ ...rows[0], heading: false }], Array.from({ length: 33 }, () => rows[0])]) assert.throws(() => applyS2PromptSections(definition, document, 'layout', bad, layout.base));
  let getters = 0; const hostile = [{ material: rows[0].material }]; Object.defineProperty(hostile[0], 'heading', { enumerable: true, get() { getters++; return '不能执行'; } });
  assert.throws(() => applyS2PromptSections(definition, document, 'layout', hostile, layout.base)); assert.equal(getters, 0);
  assert.throws(() => compileS2PromptSections(Array.from({ length: 32 }, () => ({ material: 'a'.repeat(64), heading: '字'.repeat(120) })), [{ key: 'a'.repeat(64), label: '长名称' }]), /6000/);
  const changed = structuredClone(document); changed.nodes[0].values.content += '变更';
  assert.throws(() => applyS2PromptSections(definition, changed, 'layout', rows, layout.base), /已变化/);
  const config = structuredClone(definition); config.instructions.response += '新策略'; assert.throws(() => applyS2PromptSections(config, document, 'layout', rows, layout.base), /已变化/);

  // Preserve every custom form of template rather than normalizing whitespace or guessing an upstream dictionary.
  for (const text of ['前缀{{material1}}', '{{ material1 }}', '角色\r\n{{material1}}', '{{unknown}}', '纯文字', '\n{{material1}}', '{{material1}}\n']) {
    const custom = structuredClone(document); custom.execution!.nodes[2].bindings.template = { kind: 'literal', value: text };
    const old = JSON.stringify(custom); assert.equal(inspectS2PromptControls(definition, custom, 'layout').kind, 'unavailable'); assert.equal(JSON.stringify(custom), old);
  }
  const referenced = structuredClone(document); referenced.execution!.nodes[2].bindings.template = { kind: 'field', nodeId: referenced.nodes[0].id, fieldId: Object.keys(referenced.nodes[0].values)[0] };
  assert.equal(inspectS2PromptControls(definition, referenced, 'layout').kind, 'unavailable');
  const dynamic = structuredClone(document); dynamic.execution!.nodes[0].bindings.key = { kind: 'field', nodeId: dynamic.nodes[0].id, fieldId: Object.keys(dynamic.nodes[0].values)[0] };
  assert.equal(inspectS2PromptControls(definition, dynamic, 'layout').kind, 'unavailable');
  assert.throws(() => setS2PromptPurpose(definition, dynamic, 'one', '不能覆盖动态来源', inspectS2PromptControls(definition, dynamic, 'one').base));
  const repeated = structuredClone(document); repeated.execution!.nodes[1].bindings.key = structuredClone(repeated.execution!.nodes[0].bindings.key);
  assert.equal(inspectS2PromptControls(definition, repeated, 'layout').kind, 'unavailable');
  const host = new S2PluginHost('prompt-controls', definition.plugins); hosts.push(host); host.setDocument(applied);
  assert.equal(host.history().length, 0); const remaining = host.remainingCalls;
  const result = await host.enqueueWorkflow(['layout']).completion; assert.equal(result.status, 'succeeded'); assert.equal(host.remainingCalls, remaining - 3);
  const last = result.nodes.find(node => node.nodeId === 'layout')!, artifact = host.currentArtifact(last.artifactIds[0]);
  assert.equal(artifact?.payload.kind, 'inline'); if (artifact?.payload.kind === 'inline') assert.equal(artifact.payload.value, `角色\n${originalText}\n\n任务\n`);

  const scene = createS2Scene(browserTemplateRequest); scene.canvasWorkspace = definition;
  let live!: S2PluginHost;
  const ui = harness({ initialDraft: scene, initialRequest: browserTemplateRequest, deferStateUpdates: true, onHost(value) { live = value; } }); uis.push(ui);
  let selectedInline = 'one';
  const inline = () => ui.inline(selectedInline);
  const submit = (label: string) => { const form = inline().elements().find(element => element.type === 'form' && element.props['aria-label'] === label); assert(form, label); form.props.onSubmit({ preventDefault() {} }); ui.render(); };
  const select = (id: string) => { selectedInline = id; ui.flow().props.onNodeClick({}, { id }); ui.render(); };
  const exported = () => { ui.button('导出工作区 JSON 到下方').props.onClick(); ui.render(); return JSON.parse(ui.labelControl('工作区 JSON', 'textarea').props.value).definition.initial as S2Document; };
  ui.button('开始试验').props.onClick(); ui.render(); const initial = exported(); select('one');
  inline().labelControl('这份内容叫什么', 'input').props.onChange({ target: { value: '角色设定' } }); ui.render(); assert.deepEqual(exported(), initial);
  submit('设置内容用途'); assert(ui.text().includes('已设置内容用途')); assert.equal(live.history().length, 0); assert.equal(live.remainingCalls, 64);
  select('two'); inline().labelControl('这份内容叫什么', 'input').props.onChange({ target: { value: '任务要求' } }); ui.render(); submit('设置内容用途');
  select('layout'); const beforeDraft = exported();
  inline().button('添加提示词段落').props.onClick(); ui.render(); inline().button('添加提示词段落').props.onClick(); ui.render();
  const keys = inspectS2PromptControls(definition, beforeDraft, 'layout'); assert(keys.kind === 'layout');
  inline().labelControl('第2段使用的内容', 'select').props.onChange({ target: { value: keys.available[1].key } }); ui.render();
  inline().labelControl('第1段标题（可选）', 'input').props.onChange({ target: { value: '角色' } }); ui.render();
  inline().labelControl('第2段标题（可选）', 'input').props.onChange({ target: { value: '任务' } }); ui.render(); assert.deepEqual(exported(), beforeDraft);
  const form = () => inline().elements().find(element => element.type === 'form' && element.props['aria-label'] === '按内容名称安排提示词')!;
  const staleDraft = form().props.onSubmit; inline().button('上移第2段').props.onClick(); ui.render(); staleDraft({ preventDefault() {} }); ui.render(); assert.deepEqual(exported(), beforeDraft);
  inline().button('下移第1段').props.onClick(); ui.render(); submit('按内容名称安排提示词'); const final = exported(); assert.deepEqual(final.execution!.nodes[2].bindings, applied.execution!.nodes[2].bindings);
  assert.equal(live.history().length, 0); assert.equal(ui.modelCalls(), 0); assert.equal(live.remainingCalls, 64);
  const staleConfirm = form().props.onSubmit; ui.button('＋角色设定块').props.onClick(); ui.render(); ui.keyShortcut('undo'); ui.render(); staleConfirm({ preventDefault() {} }); ui.render(); assert.deepEqual(exported(), final);
  ui.button('结束试验').props.onClick(); ui.render(); staleConfirm({ preventDefault() {} }); ui.render(); assert.deepEqual(exported(), final); assert.equal(live.history().length, 0);
  assert.equal(JSON.stringify(definition), original); assert.equal(network, 0);
  console.log('S2 prompt controls passed: explicit Chinese purpose with unique host names, real-chain metadata-only section selection, exact reversible layout and conservative legacy/dynamic fallback, descriptor/size/stale/duplicate gates, unchanged text/fields/wiring and native single-pass actual Host execution, production deferred drafts/apply/reorder/undo/end guards and no implicit calls. Synthetic offline only; not all U3 controls, browser, IME or model-effect acceptance.');
} finally { uis.forEach(ui => ui.dispose()); hosts.forEach(host => host.close()); globalThis.fetch = oldFetch; }
