import assert from 'node:assert/strict';
import React from 'react';
import type { SceneInitialRequest } from '../src/types';
import type { SceneInteractionPack, SceneInteractionPackDefinition, ScenePackConfig, ScenePackPublicComponent, ScenePackViewContext } from '../src/types/sceneInteractionPack';
import type { S2CanvasDefinition, S2Document } from '../src/types/sceneS2';
import type { S2PluginManifest } from '../src/types/sceneS2Plugin';
import { applyS2Commands, createS2Scene, exportS2Workspace, importS2WorkspaceWithPack } from '../src/services/scene/sceneS2Canvas';
import { readSceneInteractionPack } from '../src/services/scene/sceneInteractionPackProtocol';
import { installSceneInteractionCapabilities } from '../src/services/scene/sceneS2PluginRegistry';
import { sceneInteractionPacks } from '../src/services/scene/sceneInteractionPacks';
import { publicS2Catalog, projectS2PublicCanvas } from '../src/services/scene/sceneS2PublicAuthoring';
import { createScenePackHostServices } from '../src/services/scene/sceneInteractionHostServices';
import { s2ParameterSource } from '../src/services/scene/sceneS2ControlDrafts';
import type { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { harness } from './scene-s2-ui-harness';

const originalFetch = globalThis.fetch; let network = 0, executions = 0;
globalThis.fetch = async () => { network++; assert.fail('Public interface UI checks prohibit real network/model/user material access'); };
const live: ReturnType<typeof harness>[] = [];
const capability = { pluginId: 'public-ui-runtime', pluginVersion: '1.0.0', capabilityId: 'format' };
const plugin: S2PluginManifest = { protocolVersion: 1, id: capability.pluginId, version: capability.pluginVersion, label: '包内格式实现', meaning: '包内实际处理函数',
  dependencies: [{ id: 'core', version: '1.0.0' }], dataTypes: [], capabilities: [{ id: capability.capabilityId, kind: 'transform', meaning: '组合前缀与原文', effect: 'pure', permissions: [], confirmation: 'none', retry: 'manual-only', timeoutMs: 1000,
    inputs: ['text', 'prefix', 'secret'].map(id => ({ id, label: id === 'text' ? '原文' : id === 'prefix' ? '前缀' : '私有参数', meaning: '完整文字', type: { id: 'core.text', version: 1 }, required: id === 'text', multiple: false })),
    outputs: [{ id: 'text', label: '输出', meaning: '完整输出', type: { id: 'core.text', version: 1 }, required: true, multiple: false }] }],
};
const native: ScenePackPublicComponent = { id: 'text', label: '公开文字', purpose: '直接编辑原文', implementation: { kind: 'content', blockType: { id: 'text', label: '文字', fields: [{ id: 'content', label: '内容', kind: 'multiline' }] } }, inputs: [], outputs: ['content'], parameters: ['content'], defaults: { content: '' } };
const formatter: ScenePackPublicComponent = { id: 'formatter', label: '公开格式块', purpose: '为输入原文添加可调前缀', implementation: { kind: 'capability', ...capability }, inputs: ['text'], outputs: ['text'], parameters: ['prefix'], defaults: { prefix: '结果：', secret: 'SEALED_DEFAULT' } };
const internal: NonNullable<SceneInteractionPack['authoring']>['internal'] = { blockTypes: [native.implementation.kind === 'content' ? native.implementation.blockType : assert.fail()], document: {
  nodes: [{ id: 'InternalText', type: 'text', position: { x: 0, y: 600 }, values: { content: '固定内部材料' } }], edges: [],
  execution: { version: 1, nodes: [{ id: 'InternalFormatter', ...capability, position: { x: 400, y: 600 }, bindings: { text: { kind: 'field', nodeId: 'InternalText', fieldId: 'content' }, prefix: { kind: 'literal', value: '内部：' }, secret: { kind: 'literal', value: 'INTERNAL_SECRET' } } }], links: [] },
} };

function FormattingView(props: ScenePackViewContext) {
  const prefix = props.node.bindings.prefix;
  return <section><input aria-label="公开前缀" value={prefix?.kind === 'literal' ? String(prefix.value) : ''} disabled={!props.active || props.editable === false}
    onChange={event => props.onInputChange('prefix', { kind: 'literal', value: event.target.value }, s2ParameterSource(props.document, props.node.id, 'prefix').key)} />
    <button type="button" disabled={!props.execution?.enabled} onClick={() => props.execution?.run([props.node.id])}>运行此块</button>
    <button type="button" hidden onClick={() => props.onInputChange('secret', { kind: 'literal', value: 'ATTACK' }, s2ParameterSource(props.document, props.node.id, 'secret').key)}>恶意私参回调</button>
  </section>;
}
function install(name: string, components: ScenePackPublicComponent[]) {
  const source: SceneInteractionPackDefinition = { manifest: { protocolVersion: 1, id: `public-ui-${name}`, version: '1.0.0', name: '独立公开接口包', paradigm: 'S2', paradigmApiVersion: 1, requiredServices: ['execution'] },
    capabilities: [plugin], authoring: { version: 1, components, internal },
    canvas: { contentEditing: 'double-click', contentSettings: 'hide', openSettingsOnSelect: false, executionUi: 'inline' },
    views: { [`${capability.pluginId}/${capability.capabilityId}`]: { inline: FormattingView } }, validate: () => [],
    createRuntime(config, host) {
      host.validateConfig(config);
      return { updateConfig: next => host.applyConfig(next), run: (targets, notify, options) => host.run(targets, notify, options),
        dispatch(operation, input) { if (operation === 'readState') return host.readConfig(); if (operation === 'run') return host.run(input?.targets); throw new Error('UNKNOWN_OPERATION'); }, dispose: () => host.close() };
    },
    async executeLocal(call, inputs) {
      executions++;
      const content = String(inputs.prefix?.[0] ?? '') + String(inputs.text?.[0] ?? '');
      return { status: 'succeeded', outputs: { text: [{ protocolVersion: 1, id: `public-ui-output-${crypto.randomUUID()}`, type: { id: 'core.text', version: 1 }, complete: true,
        source: { sceneId: call.sceneId, runId: call.runId, nodeId: call.nodeId, revision: call.revision, kind: 'plugin', invocationId: call.id }, payload: { kind: 'inline', value: content } }] } };
    },
  };
  const pack = readSceneInteractionPack(source); installSceneInteractionCapabilities(pack); sceneInteractionPacks.register(pack);
  const ref = { id: pack.manifest.id, version: pack.manifest.version };
  return { pack: sceneInteractionPacks.resolve(ref), ref };
}
function create(pack: SceneInteractionPack) {
  const request: SceneInitialRequest = { source: 'custom', sceneSkill: 'S2', subject: '手动公开画布', knowledgePoints: [], interactionPack: { id: pack.manifest.id, version: pack.manifest.version } };
  let host: S2PluginHost | undefined;
  const ui = harness({ initialRequest: request, onHost: value => { host = value; }, loadInteractionPack: async ref => { sceneInteractionPacks.resolve(ref); } });
  live.push(ui); return { ui, request, host: () => host };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function settle(ui: ReturnType<typeof harness>, done: () => boolean) { for (let i = 0; i < 100; i++) { ui.render(); if (done()) return; await tick(); } assert.fail('Public UI action did not settle'); }
function exported(ui: ReturnType<typeof harness>) { ui.button('导出工作区 JSON 到下方').props.onClick(); ui.render(); return JSON.parse(ui.labelControl('工作区 JSON', 'textarea').props.value); }
function config(ui: ReturnType<typeof harness>): ScenePackConfig { const definition = exported(ui).definition as S2CanvasDefinition; return { definition, document: definition.initial }; }
const node = (ui: ReturnType<typeof harness>, id: string) => { const result = ui.flow().props.nodes.find((item: any) => item.id === id); assert(result, id); return result; };
function controls(ui: ReturnType<typeof harness>, id: string): any[] {
  const walk = (value: any): any[] => Array.isArray(value) ? value.flatMap(walk) : !value || typeof value !== 'object' ? []
    : typeof value.type === 'function' ? walk(value.type(value.props)) : [value, ...walk(value.children ?? value.props?.children ?? [])];
  return walk(node(ui, id).data.nodeControls);
}
function control(ui: ReturnType<typeof harness>, id: string, label: string) { const result = controls(ui, id).find(item => item.props?.['aria-label'] === label); assert(result, label); return result; }
function inlineButton(ui: ReturnType<typeof harness>, id: string, label: string) { const result = controls(ui, id).find(item => item.type === 'button' && item.props?.children === label); assert(result, label); return result; }
function select(ui: ReturnType<typeof harness>, id: string) { ui.flow().props.onNodeClick({}, { id }); ui.render(); }
function add(ui: ReturnType<typeof harness>, componentId: string) {
  const before = new Set(ui.flow().props.nodes.map((item: any) => item.id));
  const button = ui.elements().find(item => item.props['data-s2-component'] === componentId); assert(button, componentId); assert.equal(button.props.disabled, false);
  button.props.onClick(); ui.render(); const added = ui.flow().props.nodes.find((item: any) => !before.has(item.id)); assert(added, 'Actual public component addition'); return added.id as string;
}
function importText(ui: ReturnType<typeof harness>, text: string) { ui.labelControl('工作区 JSON', 'textarea').props.onChange({ target: { value: text } }); ui.render(); ui.button('导入并替换当前预览').props.onClick(); ui.render(); }
function innerSnapshot(document: S2Document) { return { text: document.nodes.find(item => item.id === 'InternalText'), formatter: document.execution?.nodes.find(item => item.id === 'InternalFormatter') }; }

try {
  const closed = install('closed', []), closedUi = create(closed.pack);
  await settle(closedUi.ui, () => closedUi.ui.flow().props.nodes.length === 2);
  assert.equal(closedUi.ui.elements().filter(item => item.props['data-s2-component']).length, 0);
  assert.equal(closedUi.ui.elements().filter(item => item.props['data-s2-capability']).length, 0, 'Empty public directory does not expose the native capability menu');
  assert(closedUi.ui.text().includes('此包未公开可搭建组件'));
  for (const id of ['InternalText', 'InternalFormatter']) { assert.equal(node(closedUi.ui, id).draggable, false); assert.equal(node(closedUi.ui, id).connectable, false); }
  assert.equal(node(closedUi.ui, 'InternalText').data.fields[0].startEdit, undefined);
  assert.equal(control(closedUi.ui, 'InternalFormatter', '公开前缀').props.disabled, true);
  const closedBefore = config(closedUi.ui);
  select(closedUi.ui, 'InternalText'); assert.equal(closedUi.ui.keyShortcut('delete').prevented, false); closedUi.ui.render(); assert.deepEqual(config(closedUi.ui), closedBefore);
  closedUi.ui.button('开始试验').props.onClick(); closedUi.ui.render(); assert(closedUi.host());
  inlineButton(closedUi.ui, 'InternalFormatter', '运行此块').props.onClick();
  await settle(closedUi.ui, () => closedUi.host()!.workflowHistory().at(-1)?.status === 'succeeded');
  assert.equal(closedUi.host()!.history().at(-1)!.artifacts[0].payload.kind, 'inline');
  assert.equal((closedUi.host()!.history().at(-1)!.artifacts[0].payload as any).value, '内部：固定内部材料');
  assert.equal(closedUi.ui.modelCalls(), 0, 'A package with no public components remains usable without a building Agent');

  const open = install('two', [native, formatter]), h = create(open.pack), ui = h.ui;
  await settle(ui, () => ui.flow().props.nodes.length === 2);
  assert.deepEqual(ui.elements().filter(item => item.props['data-s2-component']).map(item => item.props['data-s2-component']), publicS2Catalog(open.pack)!.components.map(item => item.id));
  const textId = add(ui, 'text'), formatterId = add(ui, 'formatter');
  for (const id of ['InternalText', 'InternalFormatter']) { assert.equal(node(ui, id).draggable, false); assert.equal(node(ui, id).connectable, false); }
  assert.equal(node(ui, textId).draggable, true); assert.equal(node(ui, formatterId).connectable, true);
  select(ui, textId); node(ui, textId).data.fields[0].startEdit(); ui.render();
  const field = node(ui, textId).data.fields[0]; assert(field.editor);
  field.editor.props.onSubmit({ version: 1, kind: 'field-submit', nodeId: textId, fieldId: 'content', previousValue: field.value, value: '手动原文 $& {{literal}}' }); ui.render();
  select(ui, formatterId); control(ui, formatterId, '公开前缀').props.onChange({ target: { value: '新的前缀：' } }); ui.render();
  ui.flow().props.onConnect({ source: textId, sourceHandle: 'field:content', target: formatterId, targetHandle: 'in:text' }); ui.render();
  const connected = config(ui); assert.deepEqual(projectS2PublicCanvas(open.pack, connected.definition, connected.document).connections, [{ source: { nodeId: textId, portId: 'content' }, target: { nodeId: formatterId, portId: 'text' } }]);
  assert.deepEqual(innerSnapshot(connected.document), innerSnapshot(internal!.document), 'Internal instances do not become editable by sharing public type/capability identities');
  select(ui, textId); assert.equal(ui.keyShortcut('delete').prevented, true); ui.render(); assert(!config(ui).document.nodes.some(item => item.id === textId));
  assert.equal(ui.keyShortcut('undo').prevented, true); ui.render(); assert.deepEqual(config(ui), connected);
  const workspace = exported(ui); importText(ui, JSON.stringify(workspace)); await settle(ui, () => !ui.button('导出工作区 JSON 到下方').props.disabled);
  assert.deepEqual(config(ui), connected); assert.deepEqual(exported(ui).interactionPack, open.ref); assert.equal(ui.modelCalls(), 0);

  // Actual controls and import callback reject attacks atomically, including the
  // private instance of the same public capability and private literal defaults.
  select(ui, 'InternalFormatter');
  assert.throws(() => control(ui, 'InternalFormatter', '公开前缀').props.onChange({ target: { value: 'private-edit' } }), /包内|内部|未公开|PRIVATE|PUBLIC/);
  assert.deepEqual(config(ui), connected);
  select(ui, formatterId);
  assert.throws(() => inlineButton(ui, formatterId, '恶意私参回调').props.onClick(), /包内|未公开|PRIVATE|PUBLIC|固定/);
  assert.deepEqual(config(ui), connected);
  ui.flow().props.onNodesChange([{ type: 'position', id: 'InternalFormatter', position: { x: 10, y: 10 } }]); ui.render(); assert.deepEqual(config(ui), connected);
  ui.flow().props.onConnect({ source: 'InternalText', sourceHandle: 'field:content', target: formatterId, targetHandle: 'in:text' }); ui.render(); assert.deepEqual(config(ui), connected);

  const privateCommand = [{ op: 'update-node', id: 'InternalText', values: { content: 'ATTACK' } }];
  assert.throws(() => applyS2Commands(connected.definition, connected.document, privateCommand, connected.definition.initial, open.ref), /包内|内部|未公开|PRIVATE|PUBLIC/);
  for (const kind of ['internal-text', 'private-parameter', 'fake-marker'] as const) {
    const bad = structuredClone(workspace);
    if (kind === 'internal-text') bad.definition.initial.nodes.find((item: any) => item.id === 'InternalText').values.content = 'ATTACK';
    else if (kind === 'private-parameter') bad.definition.initial.execution.nodes.find((item: any) => item.id === formatterId).bindings.secret.value = 'ATTACK';
    else bad.definition.initial.execution.nodes.find((item: any) => item.id === 'InternalFormatter').publicComponentId = 'formatter';
    assert.throws(() => importS2WorkspaceWithPack(JSON.stringify(bad)), /包内|内部|未公开|PRIVATE|PUBLIC|未知|字段|未支持配置/);
    importText(ui, JSON.stringify(bad)); await settle(ui, () => !ui.button('导出工作区 JSON 到下方').props.disabled); assert.deepEqual(config(ui), connected);
  }

  ui.button('开始试验').props.onClick(); ui.render(); const host = h.host()!; assert(host);
  const frozenBefore = config(ui), badDocument = structuredClone(frozenBefore.document);
  badDocument.nodes.find(item => item.id === 'InternalText')!.values.content = 'ATTACK';
  assert.throws(() => host.setDocument(badDocument), /包内|内部|未公开|PRIVATE|PUBLIC/); assert.deepEqual(config(ui), frozenBefore);
  let serviceWrites = 0;
  const services = createScenePackHostServices(host, () => frozenBefore, () => { serviceWrites++; }, { interactionPack: open.ref });
  assert.throws(() => services.applyConfig({ ...frozenBefore, document: badDocument }), /包内|内部|未公开|PRIVATE|PUBLIC/); assert.equal(serviceWrites, 0);
  const badParameters = structuredClone(frozenBefore.document); badParameters.execution!.nodes.find(item => item.id === formatterId)!.bindings.secret = { kind: 'literal', value: 'ATTACK' };
  assert.throws(() => services.applyConfig({ ...frozenBefore, document: badParameters }), /包内|未公开|PRIVATE|PUBLIC|固定/); assert.equal(serviceWrites, 0);
  inlineButton(ui, formatterId, '运行此块').props.onClick(); await settle(ui, () => host.workflowHistory().at(-1)?.status === 'succeeded');
  assert.equal((host.history().at(-1)!.artifacts[0].payload as any).value, '新的前缀：手动原文 $& {{literal}}');
  assert.equal(ui.modelCalls(), 0); assert.equal(network, 0); assert.equal(executions, 2);
  services.close();
  console.log('S2 public interface UI passed: independent zero/two-component packages, shared catalogue menu, private same-type instances read-only yet runnable, actual add/content/parameter/wire/delete/keyboard-undo/export/import controls, and Agent-command/import/Host.setDocument/HostServices private-instance/parameter/marker attacks rejected atomically. No builder Agent, model, network or user material access.');
} finally { live.forEach(ui => ui.dispose()); globalThis.fetch = originalFetch; }
