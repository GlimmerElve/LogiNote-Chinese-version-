import assert from 'node:assert/strict';
import type { SceneInitialRequest, SceneSpec } from '../src/types';
import type { S2CanvasDefinition, S2Document } from '../src/types/sceneS2';
import { createS2Scene, importS2WorkspaceWithPack, readS2Definition, readS2Scene } from '../src/services/scene/sceneS2Canvas';
import { harness } from './scene-s2-ui-harness';
import { useGenericS2CanvasUi } from './fixtures/s2-generic-canvas-ui';

// Generic base compatibility: legacy inline/optional settings UI without package canvas policy.
// Exercise production CanvasTrial handlers and its real Block renderer. No DOM layout or real models are claimed.
const restoreCanvasUi = useGenericS2CanvasUi();
const pack = { id: 'prompt-lab', version: '0.1.0' };
const request: SceneInitialRequest = { source: 'custom', sceneSkill: 'S2', subject: '合成只读场景 UI', knowledgePoints: [], interactionPack: pack };
const originalScene = createS2Scene(request), base = readS2Scene(originalScene);
const definition = readS2Definition({ ...base, initial: { nodes: [
  { id: 'role', type: 'text', label: '角色', readOnly: true, position: { x: 10, y: 10 }, values: { content: '你是一名解释者。' } },
  { id: 'task', type: 'text', label: '任务说明', position: { x: 10, y: 200 }, values: { content: '解释函数。' } },
  { id: 'constraints', type: 'text', label: '输出要求', readOnly: true, position: { x: 10, y: 400 }, values: { content: '保留摘要和例子两个字段。' } },
], edges: [] } });
const scene = { ...originalScene, canvasWorkspace: definition };
const originalKey = JSON.stringify(scene), uis: ReturnType<typeof harness>[] = [];
const oldFetch = globalThis.fetch; let networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error('Readonly UI checks have no transport'); };
type UI = ReturnType<typeof harness>;
function create(options: Parameters<typeof harness>[0] = {}) {
  const ui = harness({ initialRequest: request, initialDraft: structuredClone(scene), ...options }); uis.push(ui); return ui;
}
function select(ui: UI, id: string) { ui.flow().props.onNodeClick({}, { id }); ui.render(); }
function card(ui: UI, id: string) {
  const node = ui.flow().props.nodes.find((node: any) => node.id === id && node.type === 'block'); assert.ok(node, id);
  return ui.flow().props.nodeTypes.block(node);
}
function cardField(ui: UI, id: string) {
  const field = ui.elements(card(ui, id)).find(item => item.type === 'textarea'); assert.ok(field, `${id} inline text`); return field;
}
function field(ui: UI, label: string) {
  const group = ui.elements().find(item => item.props['aria-label'] === `${label}「内容」的原内容`); assert.ok(group, label);
  const input = ui.elements(group).find(item => item.type === 'textarea'); assert.ok(input, `${label} selected content`); return input;
}
function error(ui: UI) { return ui.elements().filter(item => item.props.className === 's2-error').map(item => ui.text(item)).join('\n'); }
function exported(ui: UI) {
  ui.button('导出工作区 JSON 到下方').props.onClick(); ui.render();
  const text = ui.labelControl('工作区 JSON', 'textarea').props.value;
  return { text, envelope: JSON.parse(text), ...importS2WorkspaceWithPack(text) };
}
function document(ui: UI): S2Document { return exported(ui).definition.initial; }
function edit(ui: UI, id: string, value: string) { cardField(ui, id).props.onChange({ target: { value } }); ui.render(); }
function history(ui: UI) {
  const before = document(ui);
  const probe = (action: 'undo' | 'redo') => {
    const result = ui.keyShortcut(action); ui.render();
    if (result.prevented) {
      assert.equal(result.stopped, true);
      const reverse = ui.keyShortcut(action === 'undo' ? 'redo' : 'undo'); ui.render();
      assert.equal(reverse.prevented, true, 'An available history shortcut can be reversed');
    }
    assert.deepEqual(document(ui), before, 'History availability probes restore the exact original graph');
    return !result.prevented;
  };
  // Exercise the actual keyboard handler; no removed toolbar buttons are emulated.
  return [probe('undo'), probe('redo')];
}
function capability(ui: UI, pluginId: string, capabilityId: string) {
  const label = ui.elements().find(item => item.type === 'label' && item.props.key === `${pluginId}@1.0.0/${capabilityId}`); assert.ok(label);
  const input = ui.elements(label).find(item => item.type === 'input' && item.props.type === 'checkbox'); assert.ok(input); return input;
}
async function tick(ui: UI) { await new Promise(resolve => setImmediate(resolve)); ui.render(); }
async function importText(ui: UI, text: string) {
  ui.labelControl('工作区 JSON', 'textarea').props.onChange({ target: { value: text } }); ui.render();
  ui.button('导入并替换当前预览').props.onClick(); await tick(ui);
}
function foreignEnvelope(current: S2CanvasDefinition) {
  return JSON.stringify({ format: 's2-workspace', version: 2, interactionPack: pack, definition: current });
}

try {
  // DOM-facing readonly state and hard callback rejection apply in preview and a running session, with deferred React updates too.
  for (const running of [false, true]) for (const deferred of [false, true]) {
    const ui = create({ deferStateUpdates: deferred });
    if (running) { ui.button('开始试验').props.onClick(); ui.render(); }
    assert.equal(definition.blockTypes.length, 1, 'Role, task and output use the same generic block type');
    assert.deepEqual(history(ui), [true, true]);
    for (const [id, label] of [['role', '角色'], ['constraints', '输出要求']]) {
      const view = card(ui, id), inline = cardField(ui, id);
      assert.match(ui.text(view), /只读 · 场景固定内容/); assert.equal(inline.props.readOnly, true);
      assert.notEqual(inline.props.disabled, true, 'Readonly text stays available for reading and selection');
      select(ui, id); assert.equal(field(ui, label).props.readOnly, true);
      assert.equal(ui.button('删除所选块及连线').props.disabled, true);
      for (const forged of [inline.props.onChange, field(ui, label).props.onChange]) {
        forged({ target: { value: 'FORGED_FIXED_TEXT' } }); ui.render();
        assert.match(error(ui), /只读/); assert.deepEqual(document(ui), definition.initial);
        assert.deepEqual(history(ui), [true, true], 'Rejected fixed-content edits must not enter undo history');
      }
      ui.button('删除所选块及连线').props.onClick(); ui.render();
      assert.match(error(ui), /只读/); assert.deepEqual(document(ui), definition.initial); assert.deepEqual(history(ui), [true, true]);
    }
    // One atomic batch cannot remove the editable task before discovering a fixed original in the same selection.
    ui.flow().props.onPaneClick(); ui.render();
    ui.flow().props.onNodesChange([{ type: 'select', id: 'task', selected: true }, { type: 'select', id: 'role', selected: true }]); ui.render();
    ui.button('批量删除所选').props.onClick(); ui.render();
    assert.match(error(ui), /只读/); assert.deepEqual(document(ui), definition.initial); assert.deepEqual(history(ui), [true, true]);
    select(ui, 'task'); assert.equal(field(ui, '任务说明').props.readOnly, false);
    field(ui, '任务说明').props.onChange({ target: { value: '改为解释闭包。' } }); ui.render();
    assert.equal(document(ui).nodes.find(node => node.id === 'task')!.values.content, '改为解释闭包。');
    assert.deepEqual(history(ui), [false, true]);
    ui.keyShortcut('undo'); ui.render(); assert.deepEqual(document(ui), definition.initial); assert.deepEqual(history(ui), [true, false]);
    ui.keyShortcut('redo'); ui.render(); assert.equal(document(ui).nodes.find(node => node.id === 'task')!.values.content, '改为解释闭包。');
    assert.equal(ui.modelCalls(), 0); assert.equal(ui.saved.length, 0);
  }

  // Readonly copies keep the same constraint, while copy undo/removal remains possible and originals remain pinned.
  const copying = create({ deferStateUpdates: true }); select(copying, 'role');
  copying.button('批量复制所选（含内部连线）').props.onClick(); copying.render();
  const copied = document(copying), added = copied.nodes.find(node => !definition.initial.nodes.some(original => original.id === node.id)); assert.ok(added);
  assert.equal(added.readOnly, true); assert.deepEqual(added.values, definition.initial.nodes[0].values);
  select(copying, added.id); assert.equal(cardField(copying, added.id).props.readOnly, true);
  edit(copying, added.id, 'FORGED_COPY_TEXT'); assert.match(error(copying), /只读/); assert.deepEqual(document(copying), copied);
  copying.keyShortcut('undo'); copying.render(); assert.deepEqual(document(copying), definition.initial); assert.deepEqual(history(copying), [true, false]);
  copying.keyShortcut('redo'); copying.render(); assert.deepEqual(document(copying), copied);
  select(copying, added.id); assert.equal(copying.button('删除所选块及连线').props.disabled, false, 'Derived readonly copies may be removed');
  copying.button('删除所选块及连线').props.onClick(); copying.render(); assert.deepEqual(document(copying), definition.initial);
  copying.keyShortcut('undo'); copying.render(); assert.deepEqual(document(copying), copied);
  copying.keyShortcut('redo'); copying.render(); assert.deepEqual(document(copying), definition.initial);

  // Capability changes validate the current graph without turning a derived copy into an undeletable original.
  const toggling = create({ deferStateUpdates: true }); select(toggling, 'role');
  toggling.button('批量复制所选（含内部连线）').props.onClick(); toggling.render();
  const toggledCopy = document(toggling).nodes.find(node => !definition.initial.nodes.some(original => original.id === node.id)); assert.ok(toggledCopy);
  capability(toggling, 'structured-data', 'parse-json').props.onChange({ target: { checked: true } }); toggling.render();
  assert.equal(capability(toggling, 'structured-data', 'parse-json').props.checked, true);
  toggling.keyShortcut('undo'); toggling.render(); assert.deepEqual(document(toggling), definition.initial);
  assert.deepEqual(history(toggling), [true, false]);
  edit(toggling, 'task', '复制和能力切换后仍可编辑。');
  const toggledWorkspace = exported(toggling);
  assert.equal(toggledWorkspace.definition.initial.nodes.some(node => node.id === toggledCopy.id), false);
  assert.equal(toggledWorkspace.definition.initial.nodes.find(node => node.id === 'task')!.values.content, '复制和能力切换后仍可编辑。');
  toggling.button('开始试验').props.onClick(); toggling.render();
  assert.equal(toggling.statuses.at(-1), 'running', 'No ghost fixed copy may prevent a fresh host session');
  assert.equal(error(toggling), ''); assert.equal(document(toggling).nodes.some(node => node.id === toggledCopy.id), false);

  // Deleting the last consumer must still permit removing its capability from the current, now-empty execution graph.
  const parse = { pluginId: 'structured-data', pluginVersion: '1.0.0', capabilityId: 'parse-json' };
  const parseDefinition = readS2Definition({ ...definition, plugins: [parse], initial: { ...definition.initial,
    execution: { version: 1, nodes: [{ id: 'parse', ...parse, position: { x: 500, y: 200 },
      bindings: { text: { kind: 'field', nodeId: 'task', fieldId: 'content' } } }], links: [] } } });
  const removingCapability = create({ initialDraft: { ...structuredClone(scene), canvasWorkspace: parseDefinition } }); select(removingCapability, 'parse');
  removingCapability.button('删除执行节点及其连线').props.onClick(); removingCapability.render();
  assert.equal(document(removingCapability).execution!.nodes.length, 0);
  capability(removingCapability, 'structured-data', 'parse-json').props.onChange({ target: { checked: false } }); removingCapability.render();
  assert.equal(capability(removingCapability, 'structured-data', 'parse-json').props.checked, false);
  assert.deepEqual(exported(removingCapability).definition.plugins, []);
  assert.equal(error(removingCapability), ''); assert.deepEqual(document(removingCapability).nodes, definition.initial.nodes);

  // v2 export and actual template-save/reopen retain both exact package reference and instance flags.
  const saving = create(); edit(saving, 'task', '保存后仍可修改的任务。');
  const snapshot = exported(saving); assert.equal(snapshot.envelope.version, 2); assert.deepEqual(snapshot.interactionPack, pack);
  assert.deepEqual(snapshot.definition.initial.nodes.map(node => [node.id, node.readOnly === true]), [['role', true], ['task', false], ['constraints', true]]);
  saving.button('保存场景').props.onClick();
  for (let i = 0; i < 20 && !saving.saved.length; i++) await tick(saving);
  assert.equal(saving.saved.length, 1); assert.deepEqual(saving.saved[0].interactionPack, pack);
  assert.deepEqual(saving.saved[0].canvasWorkspace.initial, snapshot.definition.initial);
  const reopened = create({ initialDraft: saving.saved[0], initialRequest: { ...request, source: 'existing', sceneId: saving.saved[0].sceneId } });
  assert.deepEqual(document(reopened), snapshot.definition.initial); select(reopened, 'role'); assert.equal(field(reopened, '角色').props.readOnly, true);
  edit(reopened, 'role', 'FORGED_REOPEN_TEXT'); assert.match(error(reopened), /只读/); assert.deepEqual(document(reopened), snapshot.definition.initial);
  edit(reopened, 'task', '重开后可修改。'); assert.equal(document(reopened).nodes.find(node => node.id === 'task')!.values.content, '重开后可修改。');
  const imported = create(); await importText(imported, snapshot.text); assert.deepEqual(document(imported), snapshot.definition.initial);

  // Whole-workspace import and an Agent-produced replacement cannot weaken a fixed original or reset history on rejection.
  const replacing = create({ deferStateUpdates: true }); edit(replacing, 'task', '需要保留的当前任务。');
  const unchanged = document(replacing), unchangedHistory = history(replacing);
  for (const mutation of ['change', 'unlock', 'delete'] as const) {
    const invalid = structuredClone(snapshot.definition);
    if (mutation === 'change') invalid.initial.nodes[0].values.content = 'FORGED_IMPORTED_TEXT';
    if (mutation === 'unlock') invalid.initial.nodes[0].readOnly = false;
    if (mutation === 'delete') invalid.initial.nodes = invalid.initial.nodes.filter(node => node.id !== 'role');
    await importText(replacing, foreignEnvelope(invalid));
    // Native service errors cross the harness VM realm; production has one Error realm and preserves the readonly detail.
    assert.match(error(replacing), /只读|工作区导入失败，原画布已保留/); assert.deepEqual(document(replacing), unchanged); assert.deepEqual(history(replacing), unchangedHistory);
    replacing.button('AI 重新设计初稿（替换当前画布）').props.onClick(); replacing.render();
    replacing.resolveDesign(invalid); await tick(replacing);
    assert.match(error(replacing), /只读/); assert.deepEqual(document(replacing), unchanged); assert.deepEqual(history(replacing), unchangedHistory);
  }
  replacing.keyShortcut('undo'); replacing.render(); assert.deepEqual(document(replacing), definition.initial);
  assert.deepEqual(history(replacing), [true, false], 'Invalid replacements cannot hide or clear the valid task edit');
  replacing.keyShortcut('redo'); replacing.render(); assert.deepEqual(document(replacing), unchanged);

  // A successful authored import adopts its new fixed originals; a later import cannot remove them using the old no-lock baseline.
  const noLockScene = createS2Scene({ ...request, interactionPack: null });
  const adopting = create({ initialDraft: noLockScene });
  const oldNoLockWorkspace = exported(adopting).text;
  await importText(adopting, snapshot.text); assert.deepEqual(document(adopting), snapshot.definition.initial);
  edit(adopting, 'task', '导入锁定场景后的有效编辑。');
  const adoptedDocument = document(adopting), adoptedHistory = history(adopting);
  await importText(adopting, oldNoLockWorkspace);
  assert.match(error(adopting), /只读|工作区导入失败，原画布已保留/);
  assert.deepEqual(document(adopting), adoptedDocument); assert.deepEqual(history(adopting), adoptedHistory);
  adopting.keyShortcut('undo'); adopting.render(); assert.deepEqual(document(adopting), snapshot.definition.initial);
  assert.deepEqual(history(adopting), [true, false]);
  adopting.keyShortcut('redo'); adopting.render(); assert.deepEqual(document(adopting), adoptedDocument);

  // A genuinely different scene establishes its own fixed originals, even if its block IDs match the previous scene.
  const mutableOptions: Parameters<typeof harness>[0] = { initialRequest: { ...request }, initialDraft: structuredClone(scene) };
  const switching = harness(mutableOptions); uis.push(switching);
  const newScene: SceneSpec = { ...structuredClone(scene), sceneId: 'synthetic-new-readonly-scene', canvasWorkspace: structuredClone(definition) };
  newScene.canvasWorkspace!.initial.nodes[0].values.content = '另一个场景自己的固定角色。';
  mutableOptions.initialDraft = newScene; mutableOptions.initialRequest = { ...request, subject: '另一个合成场景' };
  switching.render(); await tick(switching);
  assert.equal(document(switching).nodes[0].values.content, '另一个场景自己的固定角色。'); assert.deepEqual(history(switching), [true, true]);
  edit(switching, 'role', 'FORGED_SECOND_SCENE_TEXT'); assert.match(error(switching), /只读/);
  assert.equal(document(switching).nodes[0].values.content, '另一个场景自己的固定角色。');

  // Old scenes that omit the property retain the existing editable behavior.
  const legacyScene = structuredClone(scene); legacyScene.sceneId = 'synthetic-legacy-readonly-omitted';
  legacyScene.canvasWorkspace!.initial.nodes.forEach(node => { delete node.readOnly; });
  const legacy = create({ initialDraft: legacyScene }); select(legacy, 'role');
  assert.equal(field(legacy, '角色').props.readOnly, false); assert.equal(uiHasReadonlyLabel(legacy, 'role'), false);
  edit(legacy, 'role', '旧场景仍然允许修改。'); assert.equal(document(legacy).nodes[0].values.content, '旧场景仍然允许修改。');
  assert.equal(networkCalls, 0); assert.equal(JSON.stringify(scene), originalKey); assert.ok(uis.every(ui => ui.modelCalls() === 0));
  console.log('S2 generic-base readonly UI compatibility passed (optional canvas policy omitted): real card/selected-field flags and forged-callback guards in preview/run, deferred updates, atomic delete rejection, editable task undo/redo, readonly copy/removal history, capability-toggle copy undo without ghost anchors, deleted-consumer capability removal, v2 export/import/save/reopen, adopted import locks and rejected replacements retaining history, fresh-scene baseline and legacy editability. Production handlers with offline synthetic fixtures only.');
} finally { uis.forEach(ui => ui.dispose()); restoreCanvasUi(); globalThis.fetch = oldFetch; }

function uiHasReadonlyLabel(ui: UI, id: string) { return ui.text(card(ui, id)).includes('只读 · 场景固定内容'); }
