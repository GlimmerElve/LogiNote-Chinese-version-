import assert from 'node:assert/strict';
import { useLegacyS2Authoring } from './fixtures/s2-generic-canvas-ui';
import { createS2Scene, exportS2Workspace, importS2WorkspaceWithPack, readS2Definition } from '../src/services/scene/sceneS2Canvas';
import { sceneInteractionPacks } from '../src/services/scene/sceneInteractionPacks';
import { installSceneInteractionCapabilities } from '../src/services/scene/sceneS2PluginRegistry';
import { scenePackEditorServices } from '../src/services/scene/scenePackEditorServices';
import type { SceneInitialRequest, SceneSpec } from '../src/types';
import type { SceneInteractionPackRef } from '../src/types/sceneInteractionPack';
import { experimentDefinition } from './fixtures/s2-experiment';
import { activate, arithmeticConfig } from './fixtures/s2-arithmetic-pack';
import { harness } from './scene-s2-ui-harness';

// Actual workspace buttons and callbacks, isolated preview state and synthetic metadata only.
const originalFetch = globalThis.fetch; let network = 0, hosts = 0;
// These saved native-protocol fixtures explicitly exercise the legacy adapter.
useLegacyS2Authoring();
globalThis.fetch = async () => { network++; throw new Error('Workspace UI check forbids network and model IO'); };
const activeUis: ReturnType<typeof harness>[] = [];
const promptRef = { id: 'prompt-lab', version: '0.1.0' };
const arithmeticRef = { id: 'arithmetic-lab', version: '1.0.0' };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const deferred = () => { let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const request = (subject: string, interactionPack: SceneInteractionPackRef | null = promptRef): SceneInitialRequest => ({
  source: 'custom', subject, knowledgePoints: [], sceneSkill: 'S2', interactionPack });
function scene(subject: string, interactionPack: SceneInteractionPackRef | null = promptRef): SceneSpec {
  const result = createS2Scene(request(subject, interactionPack));
  result.canvasWorkspace = structuredClone(experimentDefinition);
  return result;
}
const baseDefinition = readS2Definition(createS2Scene(request('基础画布', null)).canvasWorkspace);
function make(options: Parameters<typeof harness>[0] = {}) {
  const ui = harness({ initialRequest: request('原提示词预览'), initialDraft: scene('原提示词预览'),
    loadInteractionPack: async ref => { sceneInteractionPacks.resolve(ref); },
    onHost: () => { hosts++; }, ...options });
  activeUis.push(ui); return ui;
}
async function settle(ui: ReturnType<typeof harness>, done: () => boolean) {
  for (let i = 0; i < 100; i++) { ui.render(); if (done()) return; await tick(); }
  assert.fail('Synthetic workspace import did not settle');
}
function exported(ui: ReturnType<typeof harness>) {
  const button = ui.button('导出工作区 JSON 到下方'); assert.equal(Boolean(button.props.disabled), false);
  button.props.onClick(); ui.render(); return JSON.parse(ui.labelControl('工作区 JSON', 'textarea').props.value);
}
function startImport(ui: ReturnType<typeof harness>, text: string) {
  ui.labelControl('工作区 JSON', 'textarea').props.onChange({ target: { value: text } }); ui.render();
  const button = ui.button('导入并替换当前预览'); assert.equal(Boolean(button.props.disabled), false);
  button.props.onClick(); ui.render();
}
const current = (ui: ReturnType<typeof harness>) => structuredClone(ui.drafts.at(-1));
const importReady = (ui: ReturnType<typeof harness>) => !ui.button('导出工作区 JSON 到下方').props.disabled;
function choose(ui: ReturnType<typeof harness>, id: string) {
  ui.flow().props.onNodeClick({}, { id }); ui.render();
  ui.flow().props.nodes.find((node: any) => node.id === id).data.fields[0].startEdit(); ui.render();
}
function editContent(ui: ReturnType<typeof harness>, value: string) {
  const node = ui.flow().props.nodes.find((item: any) => item.selected), field = node.data.fields[0];
  assert.ok(field.editor); assert.equal(field.editor.props.variant, 'inline');
  field.editor.props.onSubmit({ version: 1, kind: 'field-submit', nodeId: node.id, fieldId: field.id, previousValue: field.value, value });
  field.editor.props.onDone(); ui.render();
}

try {
  // Exact references roundtrip through the formal UI without runtime/session creation.
  const pack = make({ initialRequest: request('基础预览', null), initialDraft: createS2Scene(request('基础预览', null)) });
  assert.equal(exported(pack).interactionPack, null);
  startImport(pack, exportS2Workspace(experimentDefinition, experimentDefinition.initial, promptRef));
  await settle(pack, () => importReady(pack));
  assert.deepEqual(current(pack).interactionPack, promptRef);
  const packed = exported(pack); assert.equal(packed.version, 2); assert.deepEqual(packed.interactionPack, promptRef);
  assert.deepEqual(packed.definition, readS2Definition(experimentDefinition));
  assert.equal(current(pack).sceneId, pack.drafts[0].sceneId, 'import replaces a preview without changing the scene identity');
  startImport(pack, exportS2Workspace(baseDefinition, baseDefinition.initial, null)); await settle(pack, () => importReady(pack));
  assert.equal(current(pack).interactionPack, null); assert.deepEqual(exported(pack).definition, baseDefinition);

  const legacy = make();
  startImport(legacy, exportS2Workspace(baseDefinition, baseDefinition.initial)); await settle(legacy, () => importReady(legacy));
  assert.deepEqual(current(legacy).interactionPack, promptRef, 'version 1 keeps the selected package reference');
  assert.deepEqual(exported(legacy).interactionPack, promptRef);

  // Invalid envelopes, graph errors and missing exact versions must commit nothing.
  for (const bad of ['{broken', JSON.stringify({ format: 's2-workspace', version: 2, definition: baseDefinition }),
    JSON.stringify({ format: 's2-workspace', version: 2, definition: baseDefinition, interactionPack: { ...promptRef, version: 'latest' } }),
    JSON.stringify({ format: 's2-workspace', version: 2, interactionPack: promptRef, definition: { ...baseDefinition, initial: { nodes: 'bad', edges: [] } } })]) {
    const ui = make(); const before = current(ui); startImport(ui, bad); await settle(ui, () => importReady(ui));
    assert.deepEqual(current(ui), before, 'malformed imported data cannot alter the scene, package or document');
    assert.deepEqual(exported(ui).interactionPack, promptRef);
  }
  const missingLoads: SceneInteractionPackRef[] = [];
  const missing = make({ loadInteractionPack: async ref => { missingLoads.push(structuredClone(ref)); throw new Error(`缺少交互包 ${ref.id}@${ref.version}`); } });
  const beforeMissing = current(missing);
  startImport(missing, exportS2Workspace(baseDefinition, baseDefinition.initial, { id: 'missing-pack', version: '9.1.0' }));
  await settle(missing, () => importReady(missing));
  assert.deepEqual(missingLoads, [{ id: 'missing-pack', version: '9.1.0' }]);
  assert.ok(missing.elements().some(item => item.props.role === 'alert' && missing.text(item)), 'failed loading is shown to the user');
  assert.deepEqual(current(missing), beforeMissing);

  // A package capability unknown to this recipient must load before full graph parsing.
  const arithmeticText = JSON.stringify({ format: 's2-workspace', version: 2, interactionPack: arithmeticRef, definition: arithmeticConfig.definition });
  assert.throws(() => importS2WorkspaceWithPack(arithmeticText), undefined, 'fixture starts with an unknown arithmetic capability');
  const loading = deferred(), loads: SceneInteractionPackRef[] = [];
  const arithmetic = make({ loadInteractionPack: async ref => {
    loads.push(structuredClone(ref)); await loading.promise;
    const addition = activate({ editor: scenePackEditorServices, ui: { react: {} } });
    installSceneInteractionCapabilities(addition); sceneInteractionPacks.register(addition);
  } });
  const beforeArithmetic = current(arithmetic); startImport(arithmetic, arithmeticText);
  assert.deepEqual(loads, [arithmeticRef]); assert.deepEqual(current(arithmetic), beforeArithmetic);
  loading.resolve(); await settle(arithmetic, () => importReady(arithmetic));
  assert.deepEqual(current(arithmetic).interactionPack, arithmeticRef);
  assert.equal(exported(arithmetic).definition.initial.execution.nodes[0].pluginId, 'arithmetic');
  assert.ok(!arithmetic.text().includes('工作区包含所选交互包范围之外'));

  const wrongScope = make(), beforeScope = current(wrongScope);
  startImport(wrongScope, exportS2Workspace(experimentDefinition, experimentDefinition.initial, arithmeticRef));
  await settle(wrongScope, () => importReady(wrongScope));
  assert.ok(wrongScope.text().includes('工作区包含所选交互包范围之外'));
  assert.deepEqual(current(wrongScope), beforeScope, 'a mismatched declared package cannot replace the old scene');

  // Editing while code is pending must retain the edit and the previous package.
  const editedLoad = deferred(), edited = make({ loadInteractionPack: () => editedLoad.promise });
  choose(edited, 'role'); startImport(edited, exportS2Workspace(baseDefinition, baseDefinition.initial, arithmeticRef));
  editContent(edited, '用户在等待时修改的内容'); editedLoad.resolve(); await settle(edited, () => importReady(edited));
  assert.deepEqual(current(edited).interactionPack, promptRef);
  assert.ok(edited.text().includes('导入期间画布或文件已变化'));
  assert.equal(exported(edited).definition.initial.nodes.find((node: any) => node.id === 'role').values.content, '用户在等待时修改的内容');

  // Returning to the same JSON by undo is still a newer history revision.
  const historyLoad = deferred(), history = make({ loadInteractionPack: () => historyLoad.promise }); choose(history, 'role');
  const beforeHistory = current(history); startImport(history, exportS2Workspace(baseDefinition, baseDefinition.initial, arithmeticRef));
  editContent(history, '临时内容'); history.keyShortcut('undo'); history.render();
  assert.deepEqual(current(history).canvasWorkspace.initial, beforeHistory.canvasWorkspace.initial);
  historyLoad.resolve(); await settle(history, () => importReady(history));
  assert.ok(history.text().includes('导入期间画布或文件已变化'));
  assert.deepEqual(current(history).interactionPack, promptRef); assert.deepEqual(exported(history).definition.initial, beforeHistory.canvasWorkspace.initial);

  const textLoad = deferred(), changedText = make({ loadInteractionPack: () => textLoad.promise }); const beforeText = current(changedText);
  startImport(changedText, exportS2Workspace(baseDefinition, baseDefinition.initial, arithmeticRef));
  changedText.labelControl('工作区 JSON', 'textarea').props.onChange({ target: { value: '{用户正在编辑另一份文件' } }); changedText.render();
  textLoad.resolve(); await settle(changedText, () => importReady(changedText)); assert.deepEqual(current(changedText), beforeText);

  const switchedLoad = deferred();
  const switchedOptions: Parameters<typeof harness>[0] = { initialRequest: request('切换前'), initialDraft: scene('切换前'),
    loadInteractionPack: () => switchedLoad.promise, onHost: () => { hosts++; } };
  const switched = harness(switchedOptions); activeUis.push(switched);
  startImport(switched, exportS2Workspace(baseDefinition, baseDefinition.initial, arithmeticRef));
  switchedOptions.initialRequest = request('切换后的场景', null);
  switchedOptions.initialDraft = createS2Scene(switchedOptions.initialRequest); switched.render();
  const afterSwitch = current(switched); switchedLoad.resolve(); await tick(); switched.render();
  assert.deepEqual(current(switched), afterSwitch, 'a prior scene import cannot replace the newly opened scene');
  assert.equal(exported(switched).interactionPack, null);

  const goneLoad = deferred(), gone = make({ loadInteractionPack: () => goneLoad.promise });
  startImport(gone, exportS2Workspace(baseDefinition, baseDefinition.initial, arithmeticRef)); gone.dispose();
  const writes = gone.stateWrites(); goneLoad.resolve(); await tick();
  assert.equal(gone.stateWrites(), writes, 'pending completion after unmount cannot write component state');
  assert.equal(hosts, 0, 'workspace import/export never creates an execution host or grants a session');
  assert.ok(activeUis.every(ui => ui.modelCalls() === 0)); assert.equal(network, 0);
  console.log('Scene package workspace UI passed: exact version 2/null roundtrips, legacy package preservation, unknown capability load before parse, atomic malformed/missing failure, edit/history/text/unmount stale rejection and no host/model/network calls.');
} finally { activeUis.forEach(ui => ui.dispose()); globalThis.fetch = originalFetch; }
