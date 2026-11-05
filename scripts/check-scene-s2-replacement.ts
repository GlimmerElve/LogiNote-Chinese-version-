import assert from 'node:assert/strict';
import type { SceneInitialRequest } from '../src/types';
import { createS2Scene, exportS2Workspace, readS2Definition } from '../src/services/scene/sceneS2Canvas';
import { harness } from './scene-s2-ui-harness';

const previousFetch = globalThis.fetch; let network = 0;
globalThis.fetch = async () => { network++; throw new Error('Replacement checks forbid real IO'); };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
try {
  const request: SceneInitialRequest = { source: 'custom', sceneSkill: 'S2', subject: '合成选区归属', knowledgePoints: [], interactionPack: null };
  const scene = createS2Scene(request), parse = { pluginId: 'structured-data', pluginVersion: '1.0.0', capabilityId: 'parse-json' };
  scene.canvasWorkspace = readS2Definition({ ...scene.canvasWorkspace, plugins: [parse], initial: {
    ...scene.canvasWorkspace!.initial,
    nodes: ['a', 'b'].map((id, index) => ({ id, type: scene.canvasWorkspace!.blockTypes[0].id,
      position: { x: index * 350, y: 0 }, values: { content: '合成原文' } })),
    execution: { version: 1, nodes: [{ id: 'parse', ...parse, position: { x: 700, y: 0 }, bindings: { text: { kind: 'literal', value: '{}' } } }], links: [] },
  } });
  const options: Parameters<typeof harness>[0] = { initialRequest: request, initialDraft: scene };
  const ui = harness(options);
  const select = (id: string) => { ui.labelControl(id === 'parse' ? '选择执行节点' : '选择块', 'select').props.onChange({ target: { value: id } }); ui.render(); };
  const selectedIds = () => Array.from(ui.flow().props.nodes).filter((node: any) => node.selected).map((node: any) => node.id);
  const assertNoHistory = () => {
    const before = JSON.stringify({ nodes: ui.flow().props.nodes, edges: ui.flow().props.edges });
    for (const action of ['undo', 'redo'] as const) {
      assert.equal(ui.keyShortcut(action).prevented, false, 'Replacement starts without earlier workspace history'); ui.render();
      assert.equal(JSON.stringify({ nodes: ui.flow().props.nodes, edges: ui.flow().props.edges }), before);
    }
  };
  const assertEmpty = (why: string) => {
    assert.deepEqual(selectedIds(), [], why);
    assert.equal(ui.labelControl('选择块', 'select').props.value, '', why);
    assert.equal(ui.labelControl('选择执行节点', 'select').props.value, '', why);
    assert.equal(ui.keyShortcut('delete').prevented, false, why);
    assert.equal(ui.button('复制所选（含内部连线）').props.disabled, true, why);
  };
  try {
    // The imported workspace deliberately reuses every ID; pruning nonexistent IDs is not enough.
    select('parse');
    const oldExecutionSelector = ui.labelControl('选择执行节点', 'select').props.onChange;
    const oldPane = ui.flow().props.onPaneClick;
    const next = structuredClone(scene.canvasWorkspace!); next.goal = '导入后的新目标';
    next.initial.execution!.nodes[0].bindings.text = { kind: 'literal', value: '{"imported":true}' };
    ui.labelControl('工作区 JSON', 'textarea').props.onChange({ target: { value: exportS2Workspace(next, next.initial) } }); ui.render();
    ui.button('导入并替换当前预览').props.onClick(); ui.render(); assertEmpty('Import must clear reused execution IDs and focus');
    assertNoHistory();
    select('a'); oldExecutionSelector({ target: { value: 'parse' } }); oldPane(); ui.render();
    assert.deepEqual(selectedIds(), ['a'], 'Old user callbacks still cannot select or clear the replacement canvas');
    assert.equal(ui.labelControl('内容', 'textarea').props.value, '合成原文');
    select('parse'); assert.deepEqual(ui.viewContext('parse').node.bindings.text, { kind: 'literal', value: '{"imported":true}' });

    ui.flow().props.onNodesChange(['a', 'b', 'parse'].map(id => ({ type: 'select', id, selected: true }))); ui.render();
    assert.equal(ui.elements().some(item => item.type === 'button' && ui.text(item) === 'AI 重新设计初稿（替换当前画布）'), false, 'Removed redesign is not an alternate replacement route');
    ui.button('导入并替换当前预览').props.onClick(); await tick(); ui.render(); assertEmpty('Explicit replacement clears multi-selection and focus');

    // Failed import must retain the existing user's selection and content.
    select('a');
    ui.labelControl('工作区 JSON', 'textarea').props.onChange({ target: { value: '{invalid' } }); ui.render();
    ui.button('导入并替换当前预览').props.onClick(); ui.render(); assert.deepEqual(selectedIds(), ['a']);
    ui.labelControl('内容', 'textarea').props.onChange({ target: { value: '设计期间的新内容，必须保留' } }); ui.render();
    ui.button('导入并替换当前预览').props.onClick(); await tick(); ui.render();
    assert.deepEqual(selectedIds(), ['a']); assert.equal(ui.labelControl('内容', 'textarea').props.value, '设计期间的新内容，必须保留');
    assert.ok(ui.elements().some(item => item.props.role === 'alert'));

    // Same component, new request: both a running scene and an ended scene can reuse node IDs.
    for (const endFirst of [false, true]) {
      select('parse'); ui.viewContext('parse').execution!.run(); ui.render();
      if (endFirst) { ui.button('返回').props.onClick(); ui.render(); }
      options.initialRequest = { ...request, subject: endFirst ? '结束后切换场景' : '运行中切换场景' };
      options.initialDraft = { ...structuredClone(scene), sceneId: endFirst ? 'scene-after-end' : 'scene-after-run' };
      ui.render(); assertEmpty('Request initialization must clear focus even while the previous phase was finished');
      assert.equal(ui.button('保存场景').props.disabled, false);
      assertNoHistory();
    }
    // Starting is not a user-selection action and must not create a synthetic selection fact.
    let selectedAtAsk: any;
    const controllerOptions: Parameters<typeof harness>[0] = { initialDraft: scene, controllers: {
      design: async () => { throw new Error('No design expected'); },
      interact: async (_scene, _document, _message, selectedId, _history, options) => {
        selectedAtAsk = { selectedId, selectedNodeIds: options?.selectedNodeIds && Array.from(options.selectedNodeIds) };
        return { understanding: '只观察', plan: '不修改', reply: '合成回应', commands: [] };
      },
    } };
    const contextUi = harness(controllerOptions);
    try {
      contextUi.labelControl('选择执行节点', 'select').props.onChange({ target: { value: 'parse' } }); contextUi.render();
      contextUi.labelControl('工作区 JSON', 'textarea').props.onChange({ target: { value: exportS2Workspace(next, next.initial) } }); contextUi.render();
      contextUi.button('导入并替换当前预览').props.onClick(); contextUi.render();
      contextUi.labelControl('向 Agent 提出要求', 'textarea').props.onChange({ target: { value: '只观察当前画布' } }); contextUi.render();
      contextUi.button('发送').props.onClick(); await tick(); contextUi.render();
      assert.deepEqual(selectedAtAsk, { selectedId: null, selectedNodeIds: [] }, 'Agent must not inherit another workspace\'s discussion focus');
    } finally { contextUi.dispose(); }
    assert.equal(ui.modelCalls(), 0); assert.equal(network, 0);
  } finally { ui.dispose(); }
  console.log('S2 replacement passed: reused content/execution IDs, explicit import/request-switch reset, lazy package execution and return/automatic cleanup, rejected import preservation, no retired redesign route, stale user callback guards and empty real interaction focus; synthetic only, zero real IO.');
} finally { globalThis.fetch = previousFetch; }
