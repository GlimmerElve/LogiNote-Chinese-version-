import assert from 'node:assert/strict';
import { createS2Scene, readS2Definition } from '../src/services/scene/sceneS2Canvas';
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { readS2ContextEvent } from '../src/services/scene/sceneS2ArtifactAccess';
import { harness } from './scene-s2-ui-harness';

const previous = globalThis.fetch; let network = 0;
globalThis.fetch = async () => { network++; throw new Error('Layout events forbid real IO'); };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
try {
  const scene = createS2Scene({ source: 'custom', subject: '合成布局与选区', sceneSkill: 'S2', knowledgePoints: [] });
  const parse = { pluginId: 'structured-data', pluginVersion: '1.0.0', capabilityId: 'parse-json' };
  const human = { pluginId: 'human-input', pluginVersion: '1.0.0', capabilityId: 'text' };
  const definition = readS2Definition({ ...scene.canvasWorkspace, plugins: [parse, human],
    blockTypes: [{ id: 'text', label: '文本', fields: [{ id: 'content', label: '内容', kind: 'multiline' }] }], initial: {
      nodes: ['a', 'b'].map((id, i) => ({ id, type: 'text', position: { x: i * 400, y: 0 }, values: { content: '{}' } })), edges: [],
      groups: [{ id: 'g', label: '合成组', nodeIds: ['a', 'b'], collapsed: false }],
      execution: { version: 1, nodes: [
        { id: 'parse', ...parse, position: { x: 0, y: 400 }, bindings: { text: { kind: 'literal', value: '{}' } } },
        { id: 'ask', ...human, position: { x: 400, y: 400 }, bindings: { prompt: { kind: 'literal', value: '继续自由操作' } } },
      ], links: [] },
    } });
  scene.canvasWorkspace = definition;
  let host!: S2PluginHost;
  const ui = harness({ legacyCatalogue: true, initialDraft: scene, onHost: value => { host = value; } });
  try {
    await ui.openConversationSession();
    const moveSelected = () => {
      const flow = ui.flow().props, changes = flow.nodes.filter((node: any) => node.selected).map((node: any) => ({ type: 'position', id: node.id, position: { x: node.position.x + 80, y: node.position.y }, dragging: false }));
      return () => flow.onNodesChange(changes);
    };
    const context = () => host.prepare(null, { goal: definition.goal, ...definition.instructions }, '只查看动作');
    const events = () => context().interactions.recentEvents;
    const last = () => events().at(-1)!;
    const count = () => context().interactions.totalEvents;
    const groupHandles = (collapsed: boolean) => {
      const group = ui.flow().props.nodeTypes.group({ data: { label: '合成组', count: 2, collapsed, toggle() {} } });
      return ui.elements(group).filter(e => e.type === 'handle');
    };
    for (const collapsed of [false, true]) {
      const handles = groupHandles(collapsed); assert.equal(handles.length, 2, 'Proxy anchors stay mounted before collapse rewires external edges');
      assert.deepEqual(handles.map(h => h.props.type), ['source', 'target']);
      assert.ok(handles.every(h => h.props.isConnectable === false && h.props['aria-hidden'] === 'true'
        && h.props.style.visibility === (collapsed ? 'visible' : 'hidden')));
    }
    const selection = (ids: string[]) => {
      ui.flow().props.onNodesChange(ui.flow().props.nodes.filter((n: any) => n.type !== 'group').map((n: any) => ({ type: 'select', id: n.id, selected: ids.includes(n.id) })));
      ui.render();
    };
    selection(['a', 'b']); assert.equal(last().kind, 'canvas-selection'); assert.deepEqual((last() as any).nodeIds, ['a', 'b']);
    const selectedCount = count(); selection(['b', 'a']); assert.equal(count(), selectedCount, 'Same set does not log another gesture');
    let getterReads = 0;
    const getterArray = Object.defineProperty(['a'], '0', { enumerable: true, get() { getterReads++; return 'a'; } });
    for (const ids of [['missing'], ['g'], ['a', 'a'], Array(1), Object.assign(['a'], { execute: true }), getterArray]) assert.throws(() => host.recordCanvasSelection(ids));
    assert.equal(getterReads, 0);
    ui.flow().props.onPaneClick(); ui.render(); assert.deepEqual((last() as any).nodeIds, []);
    ui.flow().props.onNodeClick({}, { id: 'a' }); ui.render();
    assert.deepEqual((last() as any).nodeIds, ['a']);

    const completed = await host.enqueueWorkflow(['parse']).completion;
    assert.equal(completed.status, 'succeeded');
    const artifact = host.history()[0].artifacts[0], calls = host.remainingCalls, revision = context().frame.revision;
    const waiting = host.enqueueWorkflow(['ask']);
    for (let i = 0; i < 100 && !host.waitingHumanInputs().length; i++) await tick();
    const wait = host.waitingHumanInputs()[0]; assert.ok(wait);
    const beforeDrag = count(), drag = ui.flow().props;
    drag.onNodeDragStart();
    for (let i = 1; i <= 30; i++) {
      drag.onNodesChange([{ type: 'position', id: 'a', position: { x: i * 2, y: i } }]); ui.render();
    }
    assert.equal(count(), beforeDrag, 'Intermediate drag positions are not journaled');
    drag.onNodeDragStop(); ui.render();
    assert.equal(count(), beforeDrag + 1); assert.equal(last().kind, 'canvas-operation');
    assert.equal((last() as any).action, 'move'); assert.equal((last() as any).effect, 'layout'); assert.deepEqual((last() as any).nodeIds, ['a']);
    assert.equal(context().frame.revision, revision); assert.equal(host.currentArtifact(artifact.id).id, artifact.id);
    assert.equal(host.waitingHumanInputs()[0].id, wait.id); assert.equal(host.remainingCalls, calls);
    const moveEvent = last(); assert.equal(readS2ContextEvent(context(), moveEvent.id).id, moveEvent.id);
    const unchanged = count(); ui.flow().props.onNodeDragStart(); ui.flow().props.onNodeDragStop(); ui.render();
    ui.flow().props.onNodesChange([{ type: 'dimensions', id: 'a', dimensions: { width: 330, height: 200 } }]); ui.render();
    assert.equal(count(), unchanged, 'No-motion and measured dimensions are not user operations');
    const beforeSelectionDrag = count();
    // Some XYFlow notifications precede the explicit start callback; multi-node drags use separate selection callbacks.
    ui.flow().props.onNodesChange([{ type: 'position', id: 'a', position: { x: 65, y: 30 }, dragging: true }]); ui.render();
    assert.equal(count(), beforeSelectionDrag);
    ui.flow().props.onSelectionDragStart();
    ui.flow().props.onNodesChange([{ type: 'position', id: 'a', position: { x: 66, y: 30 }, dragging: true },
      { type: 'position', id: 'b', position: { x: 406, y: 0 }, dragging: true }]); ui.render();
    ui.flow().props.onSelectionDragStop(); ui.render();
    assert.equal(count(), beforeSelectionDrag + 1); assert.deepEqual((last() as any).nodeIds, ['a', 'b']);
    // Keyboard/accessibility position notifications have no drag-start callback, but still produce normal validated history.
    ui.flow().props.onNodesChange([{ type: 'position', id: 'a', position: { x: 70, y: 30 }, dragging: false }]); ui.render();
    assert.equal((last() as any).action, 'move'); assert.equal((last() as any).via, 'canvas');
    const safePosition = ui.flow().props.nodes.find((n: any) => n.id === 'a').position;
    ui.flow().props.onNodesChange([{ type: 'position', id: 'a', position: { x: NaN, y: 0 } }]); ui.render();
    assert.deepEqual(ui.flow().props.nodes.find((n: any) => n.id === 'a').position, safePosition);
    // Finish the rejected empty gesture before other controls.
    ui.flow().props.onNodeDragStop(); ui.render();

    const oldFold = ui.flow().props.nodes.find((node: any) => node.id === 'g').data.toggle, oldUngroup = ui.button('解散组（保留节点） 合成组').props.onClick;
    oldFold(); ui.render(); assert.equal((last() as any).action, 'collapse');
    assert.equal(ui.flow().props.nodes.find((node: any) => node.id === 'g').data.collapsed, true);
    const afterFold = count(); oldFold(); oldUngroup(); ui.render();
    assert.equal(count(), afterFold); assert.ok(ui.text().includes('分组已变化'));
    ui.button('选择整组').props.onClick(); ui.render(); assert.deepEqual((last() as any).nodeIds, ['a', 'b']);
    ui.flow().props.nodes.find((n: any) => n.id === 'g').data.toggle(); ui.render(); assert.equal((last() as any).action, 'expand');
    const oldUndo = ui.captureKeyShortcut('undo');
    moveSelected()(); ui.render(); const moved = JSON.stringify(ui.flow().props.nodes);
    oldUndo(); ui.render(); assert.equal(JSON.stringify(ui.flow().props.nodes), moved, 'An old history callback cannot revert a later edit');
    const undo = ui.captureKeyShortcut('undo'); undo(); undo(); ui.render(); assert.equal((last() as any).action, 'undo');
    assert.equal((last() as any).effect, 'layout');
    ui.keyShortcut('redo'); ui.render(); assert.equal((last() as any).action, 'redo');
    assert.equal(host.waitingHumanInputs()[0].id, wait.id);
    ui.button('解散组（保留节点） 合成组').props.onClick(); ui.render(); assert.equal((last() as any).action, 'ungroup');
    assert.equal(ui.flow().props.nodes.filter((n: any) => n.type === 'group').length, 0);
    ui.button('把所选节点组成一组').props.onClick(); ui.render(); assert.equal((last() as any).action, 'group');
    assert.equal(context().frame.revision, revision); assert.equal(host.waitingHumanInputs()[0].id, wait.id);

    // Operation tickets are host-local, single-use and tied to actual changes, never arbitrary before/after JSON.
    assert.throws(() => host.recordCanvasOperation({}, 'move', 'canvas'));
    const ticket = host.beginCanvasOperation(); host.recordCanvasOperation(ticket, 'move', 'canvas');
    assert.throws(() => host.recordCanvasOperation(ticket, 'move', 'canvas'));
    const anotherHost = new S2PluginHost(scene.sceneId, definition); anotherHost.setDocument(definition.initial);
    const foreign = anotherHost.beginCanvasOperation(); assert.throws(() => host.recordCanvasOperation(foreign, 'undo', 'control')); anotherHost.close();
    const oldToken = host.beginCanvasOperation();
    selection(['a']); ui.button('复制所选（含内部连线）').props.onClick(); ui.render();
    const operation = events().reverse().find(e => e.kind === 'canvas-operation');
    assert.equal((operation as any).action, 'copy'); assert.equal((operation as any).effect, 'content');
    assert.throws(() => host.recordCanvasOperation(oldToken, 'move', 'canvas'), /布局操作/);
    assert.equal(host.waitingHumanInputs().length, 0, 'Content copies still invalidate the old semantic revision/wait');
    await waiting.completion;
    assert.throws(() => host.currentArtifact(artifact.id));
    const beforeDelete = ui.flow().props.nodes.length;
    assert.equal(ui.keyShortcut('delete').prevented, true); ui.render();
    assert.ok(ui.flow().props.nodes.length < beforeDelete, 'Canvas Delete removes the actual selection and its connections');
    ui.keyShortcut('undo'); ui.render(); assert.equal((last() as any).action, 'undo'); assert.equal((last() as any).effect, 'content');
    assert.equal(host.remainingCalls, calls); assert.equal(ui.modelCalls(), 1);
    const oldBatch = moveSelected(), oldHistory = ui.captureKeyShortcut('undo'), oldFlow = ui.flow().props;
    ui.dispose(); const ended = JSON.stringify(ui.flow().props.nodes);
    oldBatch(); oldHistory(); oldFlow.onNodesChange([{ type: 'position', id: 'a', position: { x: 999, y: 999 } }]);
    assert.throws(() => ui.documentSnapshot(), /null|结束/); assert.equal(JSON.stringify(ui.flow().props.nodes), ended); assert.equal(ui.modelCalls(), 1);
    assert.throws(() => host.beginCanvasOperation()); assert.throws(() => host.recordCanvasSelection(['a']));
    assert.equal(network, 0);
  } finally { ui.dispose(); }
  console.log('S2 layout events passed: production selection/drag/native-position/group/history/batch handlers, single completed drag fact, host-branded one-use source, stale group/history/end protection, validated positions, exact recall, layout-preserved artifacts and human waits, content invalidation, no implicit tools/model or real IO. Offline synthetic only; not browser E2E.');
} finally { globalThis.fetch = previous; }
