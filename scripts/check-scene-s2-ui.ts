// Fixed synthetic replies below intentionally test complete-catalogue compatibility, not progressive discovery.
import assert from 'node:assert/strict';
import * as canvas from '../src/services/scene/sceneS2Canvas';
import type { S2AgentReply, S2CanvasDefinition } from '../src/types/sceneS2';
import * as pluginHost from '../src/services/scene/sceneS2PluginHost';
import * as pluginRegistry from '../src/services/scene/sceneS2PluginRegistry';
import * as workflow from '../src/services/scene/sceneS2Workflow';
import * as layout from '../src/services/scene/sceneS2Layout';
import * as memoryModule from '../src/services/scene/sceneS2Memory';
import { adoptUserNodes } from '@xyflow/system';

// Execute the real production component/handlers with deterministic hooks and synthetic IO.
// This tests lifecycle/state transitions, not DOM layout or browser pointer behavior.
type Element = { type: unknown; props: Record<string, any>; children: any[] };
type Slot = { value?: any; deps?: unknown[]; cleanup?: () => void };
const request = { source: 'custom', subject: 'Synthetic S2', knowledgePoints: [], sceneSkill: 'S2' } as const;
import { harness } from './scene-s2-ui-harness';
import './check-scene-s2-optional-assistant';
const tick = async () => { await new Promise(resolve => setImmediate(resolve)); };
const memoryUi = harness(); memoryUi.button('开始试验').props.onClick(); memoryUi.render();
function sendMemoryQuery(query: string) {
  memoryUi.labelControl('向 Agent 提出要求', 'textarea').props.onChange({ target: { value: query } }); memoryUi.render();
  memoryUi.button('发送').props.onClick(); memoryUi.render();
}
const memoryAnswer: S2AgentReply = { understanding: '保留约定', plan: '只解释', reply: '记住本轮有效约定', commands: [] };
sendMemoryQuery('不要自动运行'); assert.equal(memoryUi.origin(), 'user');
memoryUi.resolveMemory(memoryAnswer, { set: [{ id: 'pause', kind: 'constraint', text: '不要自动运行', quote: '不要自动运行', nodeIds: [] }], retire: [] }); await tick(); memoryUi.render();
assert.equal(memoryUi.memory()!.snapshot()[0].text, '不要自动运行');
sendMemoryQuery('保留这个问题'); memoryUi.button('＋内容块').props.onClick(); memoryUi.render();
const staleMemoryReply = '基于旧画布的回应不得显示或传入下一轮';
memoryUi.resolveMemory({ ...memoryAnswer, reply: staleMemoryReply, commands: [{ op: 'add-node', node: { id: 'stale-memory-proposal', type: 'text', position: { x: 400, y: 0 }, values: { content: '不得提交' } } }] },
  { set: [{ id: 'issue', kind: 'question', text: '保留这个问题', quote: '保留这个问题', nodeIds: [] }], retire: [] }); await tick(); memoryUi.render();
assert.deepEqual(memoryUi.memory()!.snapshot().map(item => item.id), ['pause'], 'Stale response cannot commit new memory');
assert.ok(!memoryUi.text().includes(staleMemoryReply), 'Stale response cannot be shown as a current Agent answer');
assert.ok(!memoryUi.elements().some(item => item.type === 'button' && memoryUi.text(item) === '确认应用修改'), 'Stale response cannot offer edit confirmation');
assert.ok(!memoryUi.flow().props.nodes.some((node: any) => node.id === 'stale-memory-proposal'), 'Stale response cannot apply edits');
sendMemoryQuery('先暂停一下'); const priorMemory = memoryUi.memory()!;
assert.ok(!memoryUi.history()?.some(item => item.content === staleMemoryReply), 'Stale response cannot enter the next Agent history');
memoryUi.button('停止助手请求').props.onClick(); memoryUi.render();
assert.ok(memoryUi.text().includes('助手请求已停止，迟到回应不会应用'));
memoryUi.resolveMemory({ ...memoryAnswer }, { set: [{ id: 'stop', kind: 'constraint', text: '先暂停一下', quote: '先暂停一下', nodeIds: [] }], retire: [] }); await tick(); memoryUi.render();
assert.deepEqual(priorMemory.snapshot().map(item => item.id), ['pause']);
memoryUi.button('保存场景').props.onClick(); await tick(); memoryUi.render();
assert.equal(memoryUi.saved[0].memory, undefined); assert.ok(!JSON.stringify(memoryUi.saved[0].canvasWorkspace).includes('不要自动运行'));
memoryUi.button('结束试验').props.onClick(); memoryUi.render(); assert.deepEqual(priorMemory.snapshot(), []);
assert.ok(memoryUi.text().includes('试验已结束，可保存画布模板或返回。'), 'Ending replaces an older save notice with the terminal state'); memoryUi.dispose();
// Selection is explicit read-only discussion context, not a multi-node tool-input grant.
const selectionDraft = canvas.createS2Scene({ ...request, knowledgePoints: [] });
selectionDraft.canvasWorkspace!.initial.nodes.push({ id: 'other', type: 'text', position: { x: 400, y: 0 }, values: { content: '第二个讨论对象' } });
const selectionInputs: any[] = [], selectionContexts: any[] = [];
const selectionUi = harness({ initialDraft: selectionDraft, controllers: {
  design: (scene, options) => canvas.designS2Canvas(scene, { ...options, disclosure: 'complete' }),
  interact: (scene, document, query, selectedId, history, options) => {
    selectionContexts.push(options?.pluginContext);
    return canvas.interactS2Canvas(scene, document, query, selectedId, history, { ...options, invoke: async request => {
      const input = JSON.parse(request.userInput); selectionInputs.push(input);
      return { content: JSON.stringify(input.stage === 'turn-understand'
        ? { understanding: '解释本轮真实选区', desiredOutcome: '只讨论，不改图或运行', actions: ['reply'], constraints: [], questions: [] }
        : { understanding: '真实选区', plan: '只解释', reply: '选区只用于讨论', commands: [] }) };
    } });
  },
} });
selectionUi.button('开始试验').props.onClick(); selectionUi.render();
async function discussSelection() {
  selectionUi.labelControl('向 Agent 提出要求', 'textarea').props.onChange({ target: { value: '检查所选块，只解释' } }); selectionUi.render();
  selectionUi.button('发送').props.onClick(); await tick(); selectionUi.render();
}
selectionUi.flow().props.onNodesChange(['goal', 'other'].map(id => ({ type: 'select', id, selected: true }))); selectionUi.render();
await discussSelection();
assert.equal(selectionInputs.length, 2);
for (const input of selectionInputs) { assert.deepEqual(input.selectedNodeIds, ['goal', 'other']); assert.equal(input.selectedId, null); }
assert.deepEqual(selectionContexts.at(-1).frame.focusNodeIds, []);
assert.deepEqual(selectionContexts.at(-1).bindings, [], 'Rectangle selection does not snapshot all selected blocks as tool inputs');
assert.deepEqual(selectionContexts.at(-1).approvedCapabilities, [], 'Selection does not expand plugin permissions');
selectionUi.labelControl('选择块', 'select').props.onChange({ target: { value: 'goal' } }); selectionUi.render();
selectionUi.flow().props.onNodesChange([{ type: 'select', id: 'other', selected: true }]); selectionUi.render();
await discussSelection();
assert.deepEqual(selectionInputs.at(-1).selectedNodeIds, ['goal', 'other']); assert.equal(selectionInputs.at(-1).selectedId, 'goal');
assert.deepEqual(selectionContexts.at(-1).bindings.map((item: any) => item.nodeId), ['goal'], 'Only the explicit single focus offers input snapshots');
selectionUi.flow().props.onNodesChange([{ type: 'select', id: 'goal', selected: false }]); selectionUi.render();
selectionUi.flow().props.onNodeClick({ ctrlKey: true }, { id: 'goal' }); selectionUi.render();
assert.equal(selectionUi.labelControl('选择块', 'select').props.value, '', 'Deselecting the focused node clears the editor focus');
await discussSelection();
assert.deepEqual(selectionInputs.at(-1).selectedNodeIds, ['other']); assert.equal(selectionInputs.at(-1).selectedId, null);
selectionUi.button('＋内容块').props.onClick(); selectionUi.render();
const undoFocusId = selectionUi.flow().props.nodes.find((node: any) => !['goal', 'other'].includes(node.id)).id;
selectionUi.labelControl('选择块', 'select').props.onChange({ target: { value: undoFocusId } }); selectionUi.render();
selectionUi.keyShortcut('undo'); selectionUi.render();
assert.equal(selectionUi.labelControl('选择块', 'select').props.value, '', 'Undo removing a focused node clears its stale focus');
await discussSelection();
assert.deepEqual(selectionInputs.at(-1).selectedNodeIds, []); assert.equal(selectionInputs.at(-1).selectedId, null);
selectionUi.dispose();
let invalidSelectionCalls = 0;
for (const selectedNodeIds of [['missing'], ['goal', 'goal']]) await assert.rejects(() => canvas.interactS2Canvas(selectionDraft,
  selectionDraft.canvasWorkspace!.initial, '解释选区', null, [], { selectedNodeIds, invoke: async () => { invalidSelectionCalls++; throw new Error('Unexpected call'); } }), /选区|重复/);
assert.equal(invalidSelectionCalls, 0, 'Invalid/forged selection is rejected before model invocation');
const largeSelection = structuredClone(selectionDraft.canvasWorkspace!.initial);
largeSelection.nodes.push(...['third', 'fourth'].map(id => ({ id, type: 'text', position: { x: 0, y: 0 }, values: { content: '大'.repeat(5500) } })));
largeSelection.nodes.forEach(node => { node.values.content = '大'.repeat(5500); });
let largeSelectionCalls = 0;
await canvas.interactS2Canvas(selectionDraft, largeSelection, '讨论所选四个块，不改图', 'goal', [], { selectedNodeIds: largeSelection.nodes.map(node => node.id), invoke: async request => {
  const input = JSON.parse(request.userInput); largeSelectionCalls++;
  assert.equal(input.selectedNodeIds.length, 4); assert.equal(input.current.representation, 'indexed-canvas');
  assert.ok(JSON.stringify(input.current.details).length <= 7000, 'Multi-selection keeps the existing detail budget');
  assert.ok(input.current.omittedDetailCount > 0, 'Selection cannot bypass indexed large-canvas omissions');
  return { content: JSON.stringify(input.stage === 'turn-understand'
    ? { understanding: '按索引讨论', desiredOutcome: '只解释', actions: ['reply'], constraints: [], questions: [] }
    : { understanding: '选区并非完整详情', plan: '只解释', reply: '按需读取，不自动运行', commands: [] }) };
} });
assert.equal(largeSelectionCalls, 2);
const designUi = harness();
const designDraft = structuredClone(designUi.drafts.at(-1).canvasWorkspace) as S2CanvasDefinition;
designDraft.designBrief = { goal: 'Synthetic design goal', requirements: [{ id: 'r1', description: 'Collaborative editing', source: 'task', quote: 'Synthetic S2' }],
  userRole: 'Confirm or edit', agentRole: 'Explain and collaborate', assumptions: ['No real execution'], openQuestions: ['Which input?'] };
designUi.button('AI 重新设计初稿（替换当前画布）').props.onClick(); designUi.render();
designUi.designProgress('understand'); designUi.render(); assert.ok(designUi.text().includes('理解目标与互动分工'));
designUi.designProgress('review'); designUi.render(); assert.ok(designUi.text().includes('审查目标覆盖与交互闭环'));
designUi.designProgress('assemble', 2); designUi.render(); assert.ok(designUi.text().includes('重新装配后'));
designUi.resolveDesign(designDraft); await tick(); designUi.render();
assert.ok(designUi.text().includes('设计理解与互动分工')); assert.ok(designUi.text().includes('Which input?'));
designUi.button('保存场景').props.onClick(); await tick(); designUi.render();
assert.deepEqual(designUi.saved.at(-1).canvasWorkspace.designBrief, designDraft.designBrief);
designUi.button('AI 重新设计初稿（替换当前画布）').props.onClick(); designUi.render();
designUi.button('停止请求').props.onClick(); designUi.render(); assert.equal(designUi.designSignal()?.aborted, true);
designUi.designProgress('review', 2); designUi.render(); assert.ok(!designUi.text().includes('审查目标覆盖与交互闭环'));
designUi.resolveDesign({ ...designDraft, goal: 'Must not replace stopped design' }); await tick(); designUi.render();
assert.ok(!designUi.text().includes('Must not replace stopped design')); designUi.dispose();
const staleDesign = harness(); staleDesign.button('AI 重新设计初稿（替换当前画布）').props.onClick(); staleDesign.render();
staleDesign.button('＋内容块').props.onClick(); staleDesign.render(); staleDesign.resolveDesign(designDraft); await tick(); staleDesign.render();
assert.equal(staleDesign.flow().props.nodes.length, 2); assert.ok(staleDesign.text().includes('设计期间内容已变化')); staleDesign.dispose();
async function settle(ui: ReturnType<typeof harness>, done: () => boolean) {
  for (let i = 0; i < 400; i++) { ui.render(); if (done()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Synthetic UI did not settle after bounded async crypto/queue work');
}
// Layout-only edits keep semantic replies/receipts, but never rebase an Agent's edit commands.
function sendLayoutQuery(ui: ReturnType<typeof harness>, query: string) {
  ui.labelControl('向 Agent 提出要求', 'textarea').props.onChange({ target: { value: query } }); ui.render();
  ui.button('发送').props.onClick(); ui.render();
}
function moveLayoutNode(ui: ReturnType<typeof harness>, id: string, x: number) {
  ui.flow().props.onNodeDragStart();
  ui.flow().props.onNodesChange([{ type: 'position', id, position: { x, y: 80 } }]); ui.render();
  ui.flow().props.onNodeDragStop(); ui.render();
}
// Replay real controlled-node adoption: missing measured clears handleBounds even when DOM sizes stay equal.
const measuredDraft = canvas.createS2Scene({ ...request, knowledgePoints: [] });
measuredDraft.canvasWorkspace!.initial.nodes.push({ id: 'measured-other', type: 'text', position: { x: 400, y: 0 }, values: { content: '第二个测量对象' } });
const measuredUi = harness({ initialDraft: measuredDraft });
const measuredLookup = new Map<string, any>(), measuredParents = new Map<string, any>();
adoptUserNodes(measuredUi.flow().props.nodes, measuredLookup, measuredParents);
const preservedHandles = { source: [], target: [] };
measuredLookup.get('goal').internals.handleBounds = preservedHandles;
const beforeDimensions = JSON.stringify(measuredUi.drafts.at(-1).canvasWorkspace.initial);
measuredUi.flow().props.onNodesChange([
  { type: 'dimensions', id: 'goal', dimensions: { width: 160, height: 196 } },
  { type: 'dimensions', id: 'measured-other', dimensions: { width: 180, height: 140 } },
]); measuredUi.render();
assert.deepEqual(JSON.parse(JSON.stringify(measuredUi.flow().props.nodes.find((node: any) => node.id === 'goal').measured)), { width: 160, height: 196 });
assert.equal(JSON.stringify(measuredUi.drafts.at(-1).canvasWorkspace.initial), beforeDimensions, 'Measurements do not write to preview documents or host semantic inputs');
const assertMeasuredAdoption = () => {
  const adopted = adoptUserNodes(measuredUi.flow().props.nodes, measuredLookup, measuredParents);
  assert.equal(adopted.nodesInitialized, true);
  assert.equal(measuredLookup.get('goal').internals.handleBounds, preservedHandles, 'Fresh controlled objects retain the existing measured handles');
  assert.equal(measuredLookup.get('goal').measured.width, 160);
};
assertMeasuredAdoption();
measuredUi.flow().props.onNodesChange([
  { type: 'dimensions', id: 'goal', dimensions: { width: 0, height: 20 } },
  { type: 'dimensions', id: 'goal', dimensions: { width: NaN, height: 20 } },
  { type: 'dimensions', id: 'goal', dimensions: { width: 20, height: Infinity } },
  { type: 'dimensions', id: 'goal', dimensions: { width: -1, height: 20 } },
  { type: 'dimensions', id: 'goal' },
  { type: 'dimensions', id: 'not-a-node', dimensions: { width: 300, height: 300 } },
]); measuredUi.render(); assertMeasuredAdoption();
measuredUi.labelControl('向 Agent 提出要求', 'textarea').props.onChange({ target: { value: '只解释，不改变画布' } }); measuredUi.render(); assertMeasuredAdoption();
measuredUi.button('开始试验').props.onClick(); measuredUi.render(); assertMeasuredAdoption();
measuredUi.button('发送').props.onClick(); measuredUi.render(); assertMeasuredAdoption();
measuredUi.resolve({ understanding: '只解释', plan: '不改图', reply: '尺寸缓存不会参与业务判断。', commands: [] }); await tick(); measuredUi.render(); assertMeasuredAdoption();
moveLayoutNode(measuredUi, 'goal', 200); assertMeasuredAdoption();
measuredUi.labelControl('选择块', 'select').props.onChange({ target: { value: 'goal' } }); measuredUi.render(); assertMeasuredAdoption();
measuredUi.labelControl('内容', 'textarea').props.onChange({ target: { value: '更长的内容，等待实际 ResizeObserver 更新尺寸。' } }); measuredUi.render(); assertMeasuredAdoption();
measuredUi.flow().props.onNodesChange([{ type: 'dimensions', id: 'goal', dimensions: { width: 260, height: 360 } }]); measuredUi.render();
assert.deepEqual(JSON.parse(JSON.stringify(measuredUi.flow().props.nodes.find((node: any) => node.id === 'goal').measured)), { width: 260, height: 360 }, 'A later real observer measurement replaces cached sizes instead of fixing node dimensions');
measuredUi.labelControl('选择块', 'select').props.onChange({ target: { value: 'measured-other' } }); measuredUi.render();
measuredUi.button('删除所选块及连线').props.onClick(); measuredUi.render();
measuredUi.keyShortcut('undo'); measuredUi.render();
assert.equal(measuredUi.flow().props.nodes.find((node: any) => node.id === 'measured-other').measured, undefined, 'Removed IDs lose their cached dimensions before a later undo/recreation');
measuredUi.button('保存场景').props.onClick(); await tick(); measuredUi.render();
assert.ok(measuredUi.saved[0].canvasWorkspace.initial.nodes.every((node: any) => node.measured === undefined && node.width === undefined && node.height === undefined));
measuredUi.button('导出工作区 JSON 到下方').props.onClick(); measuredUi.render();
assert.ok(JSON.parse(measuredUi.labelControl('工作区 JSON', 'textarea').props.value).definition.initial.nodes.every((node: any) => node.measured === undefined));
measuredUi.dispose();
// Full document replacement may reuse IDs but must never reuse their previous DOM measurements.
const replacementUi = harness();
replacementUi.flow().props.onNodesChange([{ type: 'dimensions', id: 'goal', dimensions: { width: 160, height: 196 } }]); replacementUi.render();
replacementUi.button('AI 重新设计初稿（替换当前画布）').props.onClick(); replacementUi.render();
replacementUi.resolveDesign(structuredClone(replacementUi.drafts.at(-1).canvasWorkspace)); await tick(); replacementUi.render();
assert.equal(replacementUi.flow().props.nodes.find((node: any) => node.id === 'goal').measured, undefined, 'Redesign clears measurements even for reused IDs');
replacementUi.flow().props.onNodesChange([{ type: 'dimensions', id: 'goal', dimensions: { width: 240, height: 180 } }]); replacementUi.render();
const replacementWorkspace = canvas.exportS2Workspace(replacementUi.drafts.at(-1).canvasWorkspace, replacementUi.drafts.at(-1).canvasWorkspace.initial);
replacementUi.labelControl('工作区 JSON', 'textarea').props.onChange({ target: { value: replacementWorkspace } }); replacementUi.render();
replacementUi.button('导入并替换当前预览').props.onClick(); replacementUi.render();
// Import resolves the selected package before committing the atomic replacement.
await tick(); replacementUi.render();
assert.equal(replacementUi.flow().props.nodes.find((node: any) => node.id === 'goal').measured, undefined, 'Import clears measurements even for reused IDs');
replacementUi.dispose();
const layoutDraft = canvas.createS2Scene({ ...request, knowledgePoints: [] });
layoutDraft.canvasWorkspace!.initial.groups = [{ id: 'layout-group', label: '布局组', nodeIds: ['goal'], collapsed: false }];
const layoutUi = harness({ initialDraft: layoutDraft }); layoutUi.button('开始试验').props.onClick(); layoutUi.render();
const layoutAnswer: S2AgentReply = { understanding: '只解释', plan: '不改图', reply: '布局调整不妨碍这段解释。', commands: [] };
sendLayoutQuery(layoutUi, '只解释并保留讨论对象');
moveLayoutNode(layoutUi, 'goal', 350); layoutUi.button('折叠组 布局组').props.onClick(); layoutUi.render();
layoutUi.resolveMemory(layoutAnswer, { set: [{ id: 'layout-focus', kind: 'focus', text: '保留讨论对象', quote: '保留讨论对象', nodeIds: ['goal'] }] });
await tick(); layoutUi.render();
assert.ok(layoutUi.text().includes(layoutAnswer.reply), 'Moving and folding during a plain reply preserve the actual reply');
assert.deepEqual(layoutUi.memory()!.snapshot().map(item => item.id), ['layout-focus']);
assert.equal(layoutUi.memory()!.context(layoutDraft.canvasWorkspace!.initial).version, 1, 'Only accepted replies commit staged memory');
assert.equal(layoutUi.flow().props.nodes.find((node: any) => node.id === 'goal').position.x, 350);
assert.equal(layoutUi.flow().props.nodes.find((node: any) => node.id === 'goal').hidden, true);
layoutUi.button('展开组 布局组').props.onClick(); layoutUi.render();
const layoutEdits: S2AgentReply = { ...layoutAnswer, reply: '可以移动，但这批修改只适用于请求时布局。', commands: [
  { op: 'batch-nodes', action: { kind: 'move', nodeIds: ['goal'], delta: { x: 10, y: 0 } } },
] };
sendLayoutQuery(layoutUi, '提出一个移动方案'); moveLayoutNode(layoutUi, 'goal', 450);
layoutUi.resolveMemory(layoutEdits, {}); await tick(); layoutUi.render();
assert.ok(layoutUi.text().includes(layoutEdits.reply), 'A layout-stale edit still retains its explanation');
assert.ok(!layoutUi.elements().some(item => item.type === 'button' && layoutUi.text(item) === '确认应用修改'));
assert.ok(layoutUi.text().includes('布局已变化，已保留解释，但修改建议已过期'));
assert.equal(layoutUi.memory()!.context(layoutDraft.canvasWorkspace!.initial).version, 2);
sendLayoutQuery(layoutUi, '按当前布局给出新移动方案'); layoutUi.resolveMemory(layoutEdits, {}); await tick(); layoutUi.render();
const oldEditConfirmation = layoutUi.button('确认应用修改');
moveLayoutNode(layoutUi, 'goal', 550);
assert.ok(!layoutUi.elements().some(item => item.type === 'button' && layoutUi.text(item) === '确认应用修改'), 'An already displayed edit proposal is removed when its complete snapshot expires');
oldEditConfirmation.props.onClick(); layoutUi.render();
assert.equal(layoutUi.flow().props.nodes.find((node: any) => node.id === 'goal').position.x, 550, 'A captured stale edit handler cannot overwrite or rebase onto new positions');
assert.ok(layoutUi.text().includes('画布已变化，建议已过期'));
sendLayoutQuery(layoutUi, '这一轮内容变化后不得提交');
layoutUi.labelControl('选择块', 'select').props.onChange({ target: { value: 'goal' } }); layoutUi.render();
layoutUi.labelControl('内容', 'textarea').props.onChange({ target: { value: '新的实际内容' } }); layoutUi.render();
layoutUi.resolveMemory({ ...layoutAnswer, reply: '过期语义回应不能显示。' }, { set: [{ id: 'stale-layout', kind: 'constraint', text: '不得提交', quote: '不得提交', nodeIds: [] }] });
await tick(); layoutUi.render();
assert.ok(!layoutUi.text().includes('过期语义回应不能显示。'));
assert.deepEqual(layoutUi.memory()!.snapshot().map(item => item.id), ['layout-focus']);
assert.equal(layoutUi.memory()!.context(layoutDraft.canvasWorkspace!.initial).version, 3, 'Content-stale reply does not advance the accepted-memory version');
layoutUi.dispose();

// Real plugin completion remains current while the user arranges the same inputs.
const pluginLayoutDraft = canvas.createS2Scene({ ...request, knowledgePoints: [] });
pluginLayoutDraft.canvasWorkspace!.plugins = [pluginRegistry.S2_JSON_CHECK_BINDING];
pluginLayoutDraft.canvasWorkspace!.initial.nodes[0].values.content = '{}';
pluginLayoutDraft.canvasWorkspace!.initial.groups = [{ id: 'plugin-layout', label: '检查组', nodeIds: ['goal'], collapsed: false }];
const pluginLayoutUi = harness({ initialDraft: pluginLayoutDraft });
pluginLayoutUi.labelControl('选择块', 'select').props.onChange({ target: { value: 'goal' } }); pluginLayoutUi.render();
pluginLayoutUi.button('开始试验').props.onClick(); pluginLayoutUi.render();
sendLayoutQuery(pluginLayoutUi, '请检查当前内容');
const layoutPluginFrame = pluginLayoutUi.pluginContext();
const layoutPluginRequest = { ...pluginRegistry.S2_JSON_CHECK_BINDING, nodeId: 'goal', inputs: { text: [layoutPluginFrame.bindings[0].artifactId] }, reason: '检查当前输入' };
pluginLayoutUi.resolveMemory({ ...layoutAnswer, pluginRequests: [layoutPluginRequest] }, {}); await tick(); pluginLayoutUi.render();
moveLayoutNode(pluginLayoutUi, 'goal', 500); pluginLayoutUi.button('折叠组 检查组').props.onClick(); pluginLayoutUi.render();
pluginLayoutUi.button('确认执行插件并交给 Agent').props.onClick(); await settle(pluginLayoutUi, () => pluginLayoutUi.modelCalls() === 2);
assert.equal(pluginLayoutUi.origin(), 'host-event');
const pluginEvent = pluginLayoutUi.pluginContext().frame.event;
assert.equal(pluginEvent.kind, 'plugin-completed');
assert.equal(pluginEvent.invocationId, pluginLayoutUi.pluginContext().frame.observations[0].invocationId);
moveLayoutNode(pluginLayoutUi, 'goal', 600); pluginLayoutUi.button('展开组 检查组').props.onClick(); pluginLayoutUi.render();
pluginLayoutUi.resolve({ ...layoutAnswer, reply: '真实 JSON 检查结果在调整布局后仍有效。' }); await tick(); pluginLayoutUi.render();
assert.ok(pluginLayoutUi.text().includes('真实 JSON 检查结果在调整布局后仍有效。'));
assert.ok(pluginLayoutUi.text().includes('本局插件记录（1）'));
assert.equal(pluginLayoutUi.memory(), undefined, 'Read-only experiment analysis does not receive writable conversation memory');
assert.equal(pluginLayoutUi.modelCalls(), 2, 'Layout does not dispatch an additional Agent turn');
assert.equal(pluginLayoutUi.flow().props.nodes.find((node: any) => node.id === 'goal').position.x, 600);
pluginLayoutUi.dispose();

// An execution grant is for exact semantic targets, not their positions, and is consumed once.
const executionLayoutDraft = canvas.createS2Scene({ ...request, knowledgePoints: [] });
executionLayoutDraft.canvasWorkspace!.plugins = [
  { pluginId: 'structured-data', pluginVersion: '1.0.0', capabilityId: 'parse-json' },
  { pluginId: 'structured-data', pluginVersion: '1.0.0', capabilityId: 'to-table' },
  { pluginId: 'structured-view', pluginVersion: '1.0.0', capabilityId: 'table' },
];
executionLayoutDraft.canvasWorkspace!.initial.nodes[0].values.content = '[{"name":"A","score":2},{"name":"B"}]';
executionLayoutDraft.canvasWorkspace!.initial.execution = { version: 1, nodes: [
  { id: 'layout-parse', pluginId: 'structured-data', pluginVersion: '1.0.0', capabilityId: 'parse-json', position: { x: 0, y: 0 }, bindings: { text: { kind: 'field', nodeId: 'goal', fieldId: 'content' } } },
  { id: 'layout-table', pluginId: 'structured-data', pluginVersion: '1.0.0', capabilityId: 'to-table', position: { x: 350, y: 0 }, bindings: {} },
  { id: 'layout-view', pluginId: 'structured-view', pluginVersion: '1.0.0', capabilityId: 'table', position: { x: 700, y: 0 }, bindings: {} },
], links: [
  { source: { nodeId: 'layout-parse', portId: 'value' }, target: { nodeId: 'layout-table', portId: 'value' } },
  { source: { nodeId: 'layout-table', portId: 'table' }, target: { nodeId: 'layout-view', portId: 'table' } },
] };
executionLayoutDraft.canvasWorkspace!.initial.groups = [{ id: 'execution-layout', label: '执行组', nodeIds: ['layout-parse', 'layout-table', 'layout-view'], collapsed: false }];
let executionLayoutHost!: pluginHost.S2PluginHost;
const executionLayoutUi = harness({ initialDraft: executionLayoutDraft, onHost: host => { executionLayoutHost = host; } });
executionLayoutUi.button('开始试验').props.onClick(); executionLayoutUi.render();
sendLayoutQuery(executionLayoutUi, '仅执行表格展示目标');
const executionLayoutAnswer: S2AgentReply = { ...layoutAnswer, executionRequest: { targetNodeIds: ['layout-view'], reason: '只运行所请求目标及其必要上游' } };
executionLayoutUi.resolveMemory(executionLayoutAnswer, {}); await tick(); executionLayoutUi.render();
moveLayoutNode(executionLayoutUi, 'layout-view', 900); executionLayoutUi.button('折叠组 执行组').props.onClick(); executionLayoutUi.render();
const layoutExecutionConfirmation = executionLayoutUi.button('确认运行并请 Agent 解读');
layoutExecutionConfirmation.props.onClick(); layoutExecutionConfirmation.props.onClick();
await settle(executionLayoutUi, () => executionLayoutUi.modelCalls() === 2);
assert.equal(executionLayoutHost.workflowHistory().length, 1, 'Repeated captured confirmation handler consumes the same Agent request only once');
assert.deepEqual(executionLayoutHost.workflowHistory()[0].targets, ['layout-view'], 'Layout changes never broaden the confirmed target list');
assert.equal(executionLayoutUi.origin(), 'host-event');
assert.equal(executionLayoutUi.pluginContext().frame.event.workflowRunId, executionLayoutHost.workflowHistory()[0].id);
moveLayoutNode(executionLayoutUi, 'layout-table', 650); executionLayoutUi.button('展开组 执行组').props.onClick(); executionLayoutUi.render();
executionLayoutUi.resolve({ ...layoutAnswer, reply: '真实执行产物可以继续解释，移动不要求重跑。' }); await tick(); executionLayoutUi.render();
assert.ok(executionLayoutUi.text().includes('真实执行产物可以继续解释，移动不要求重跑。'));
assert.equal(executionLayoutUi.memory(), undefined);
assert.equal(executionLayoutUi.flow().props.nodes.find((node: any) => node.id === 'layout-view').data.status, 'displayed');
assert.equal(executionLayoutHost.workflowHistory().length, 1); assert.equal(executionLayoutUi.modelCalls(), 2, 'One confirmed execution produces one host-event, not an autonomous loop');
sendLayoutQuery(executionLayoutUi, '明确重新请求同一目标'); executionLayoutUi.resolveMemory(executionLayoutAnswer, {}); await tick(); executionLayoutUi.render();
executionLayoutUi.button('确认运行并请 Agent 解读').props.onClick();
await settle(executionLayoutUi, () => executionLayoutUi.modelCalls() === 4);
assert.equal(executionLayoutHost.workflowHistory().length, 2, 'A new explicit request may independently repeat the same target');
executionLayoutUi.labelControl('选择块', 'select').props.onChange({ target: { value: 'goal' } }); executionLayoutUi.render();
executionLayoutUi.labelControl('内容', 'textarea').props.onChange({ target: { value: '[{"changed":true}]' } }); executionLayoutUi.render();
executionLayoutUi.resolve({ ...layoutAnswer, reply: '针对已固定的旧轮次解释，不代表当前配置。' }); await tick(); executionLayoutUi.render();
assert.ok(executionLayoutUi.text().includes('针对已固定的旧轮次解释，不代表当前配置。'));
assert.ok(executionLayoutUi.text().includes('历史结果，不代表当前配置达标'));
assert.equal(executionLayoutUi.memory(), undefined, 'Historical analysis cannot commit current memory');
sendLayoutQuery(executionLayoutUi, '再次提出相同目标'); executionLayoutUi.resolveMemory(executionLayoutAnswer, {}); await tick(); executionLayoutUi.render();
const staleExecutionConfirmation = executionLayoutUi.button('确认运行并请 Agent 解读');
executionLayoutUi.labelControl('选择块', 'select').props.onChange({ target: { value: 'goal' } }); executionLayoutUi.render();
executionLayoutUi.labelControl('内容', 'textarea').props.onChange({ target: { value: '[]' } }); executionLayoutUi.render();
assert.ok(!executionLayoutUi.elements().some(item => item.type === 'button' && executionLayoutUi.text(item) === '确认运行并请 Agent 解读'));
staleExecutionConfirmation.props.onClick(); executionLayoutUi.render();
assert.ok(executionLayoutUi.text().includes('画布已变化，执行建议已过期'));
assert.equal(executionLayoutHost.workflowHistory().length, 2, 'Semantic changes invalidate even a previously captured execution confirmation');
executionLayoutUi.dispose();

// Use the real synchronous queue limit, not a mocked enqueue failure. A failed
// confirmation stays consumed, but its button must not remain falsely usable.
let fullQueueHost!: pluginHost.S2PluginHost;
const fullQueueUi = harness({ initialDraft: structuredClone(executionLayoutDraft), onHost: host => { fullQueueHost = host; } });
fullQueueUi.button('开始试验').props.onClick(); fullQueueUi.render();
sendLayoutQuery(fullQueueUi, '申请运行当前展示目标，入队失败也不能自动重试');
fullQueueUi.resolveMemory({ ...layoutAnswer, executionRequest: { targetNodeIds: ['layout-view'], reason: '仅当前目标，等待独立确认' } }, {});
await tick(); fullQueueUi.render();
const fullQueueConfirmation = fullQueueUi.button('确认运行并请 Agent 解读');
// These eight explicit local test requests occupy the actual host queue before
// its microtask scheduler can finish any; no model or automatic UI run is used.
const occupiedQueue = Array.from({ length: 8 }, () => fullQueueHost.enqueueWorkflow(['layout-view']));
assert.equal(fullQueueHost.workflowHistory().filter(run => ['queued', 'running', 'waiting'].includes(run.status)).length, 8);
fullQueueConfirmation.props.onClick(); fullQueueConfirmation.props.onClick(); fullQueueUi.render();
assert.ok(fullQueueUi.text().includes('执行队列已满'));
assert.ok(fullQueueUi.text().includes('本次执行申请已消费且未入队'));
assert.ok(fullQueueUi.text().includes('请解决错误后向 Agent 重新申请；不会自动重试'));
assert.ok(!fullQueueUi.elements().some(item => item.type === 'button' && fullQueueUi.text(item) === '确认运行并请 Agent 解读'));
assert.equal(fullQueueHost.workflowHistory().length, 8, 'Failed enqueue and repeated captured handlers create no ninth job');
assert.equal(fullQueueUi.modelCalls(), 1, 'Synchronous queue failure never asks the model to retry');
await Promise.all(occupiedQueue.map(job => job.completion)); await tick(); fullQueueUi.render();
fullQueueConfirmation.props.onClick(); fullQueueUi.render();
assert.equal(fullQueueHost.workflowHistory().length, 8, 'Freeing queue slots never revives the consumed confirmation');
assert.equal(fullQueueUi.modelCalls(), 1);
sendLayoutQuery(fullQueueUi, '队列已空，我明确重新申请运行同一目标');
fullQueueUi.resolveMemory({ ...layoutAnswer, executionRequest: { targetNodeIds: ['layout-view'], reason: '新的明确申请，单独确认' } }, {});
await tick(); fullQueueUi.render();
fullQueueUi.button('确认运行并请 Agent 解读').props.onClick();
await settle(fullQueueUi, () => fullQueueUi.modelCalls() === 3);
assert.equal(fullQueueHost.workflowHistory().length, 9, 'A genuinely new request can be independently confirmed after capacity returns');
assert.equal(fullQueueUi.origin(), 'host-event');
fullQueueUi.resolve({ ...layoutAnswer, reply: '新申请已确认，实际本地结果保留。' }); await tick(); fullQueueUi.render();
assert.ok(fullQueueUi.text().includes('新申请已确认，实际本地结果保留。'));
fullQueueUi.dispose();
const result = { understanding: 'Add an alternative', plan: 'Keep existing content', reply: 'Here is a proposed block',
  commands: [{ op: 'add-node', node: { id: 'proposed', type: 'text', position: { x: 400, y: 0 }, values: { content: 'alternative' } } }] } as S2AgentReply;
const ui = harness();
assert.equal(ui.flow().props.nodes.length, 1);
assert.equal(ui.flow().props.minZoom, 0.1, 'Wide subgraphs can fit narrow canvas viewports without the default 50% zoom floor');
ui.button('＋内容块').props.onClick(); ui.render(); assert.equal(ui.flow().props.nodes.length, 2);
ui.keyShortcut('undo'); ui.render(); assert.equal(ui.flow().props.nodes.length, 1);
ui.keyShortcut('redo'); ui.render(); assert.equal(ui.flow().props.nodes.length, 2);
const target = ui.flow().props.nodes[1].id;
ui.flow().props.onConnect({ source: 'goal', target }); ui.render();
ui.flow().props.onConnect({ source: target, target: 'goal' }); ui.render(); assert.equal(ui.flow().props.edges.length, 2);
ui.button('开始试验').props.onClick(); ui.render(); assert.equal(ui.statuses.at(-1), 'running');
ui.labelControl('向 Agent 提出要求', 'textarea').props.onChange({ target: { value: 'Add an alternative' } }); ui.render();
ui.button('发送').props.onClick(); ui.render(); ui.resolve(result); await tick(); ui.render();
assert.equal(ui.flow().props.nodes.length, 2, 'Returned commands do not apply automatically');
ui.button('确认应用修改').props.onClick(); ui.render(); assert.equal(ui.flow().props.nodes.length, 3);
ui.labelControl('向 Agent 提出要求', 'textarea').props.onChange({ target: { value: 'Another alternative' } }); ui.render();
ui.button('发送').props.onClick(); ui.render();
ui.button('＋内容块').props.onClick(); ui.render(); const count = ui.flow().props.nodes.length;
ui.resolve(result); await tick(); ui.render(); assert.equal(ui.flow().props.nodes.length, count);
assert.ok(ui.text().includes('修改建议已丢弃'));
ui.labelControl('向 Agent 提出要求', 'textarea').props.onChange({ target: { value: 'Late request' } }); ui.render();
ui.button('发送').props.onClick(); ui.render(); ui.button('结束试验').props.onClick(); ui.render();
assert.equal(ui.signal()?.aborted, true); ui.resolve(result); await tick(); ui.render();
assert.equal(ui.flow().props.nodes.length, count); assert.equal(ui.statuses.at(-1), 'finished');
assert.ok(ui.text().includes('试验已结束，可保存画布模板或返回。'), 'A late response cannot overwrite the terminal status');
ui.dispose();
const failure = harness({ failSave: true }); await failure.button('保存场景').props.onClick(); await tick(); failure.render();
assert.ok(failure.text().includes('synthetic save failure')); assert.ok(!failure.text().includes('已保存场景')); failure.dispose();
const save = harness(); save.button('保存场景').props.onClick(); await tick(); save.render();
assert.equal(save.saved.length, 1); assert.ok(save.saved[0].sceneId !== save.drafts[0].sceneId);
assert.equal(save.saved[0].compute, undefined); assert.equal(save.saved[0].messages, undefined); save.dispose();
const wrong = canvas.createS2Scene({ ...request, knowledgePoints: [] }); wrong.meta.sceneSkill = 'S4';
const isolated = harness({ initialDraft: wrong }); await tick(); isolated.render();
assert.ok(isolated.text().includes('不能读取或修改 S1/S4')); isolated.dispose();
// Real builtin adapter/host, synthetic Agent only. The template selection becomes a fresh run grant at Start.
const plugins = harness();
// Select the named capability, not whichever unrelated checkbox appears first in the sidebar.
const jsonCapability = plugins.elements().find(item => item.type === 'label' && plugins.text(item) === '检查 JSON 格式（检查）'); assert.ok(jsonCapability);
const toggle = plugins.elements(jsonCapability).find(item => item.type === 'input' && item.props.type === 'checkbox'); assert.ok(toggle);
toggle.props.onChange({ target: { checked: true } }); plugins.render();
plugins.labelControl('选择块', 'select').props.onChange({ target: { value: 'goal' } }); plugins.render();
plugins.labelControl('内容', 'textarea').props.onChange({ target: { value: '{bad}' } }); plugins.render();
plugins.button('开始试验').props.onClick(); plugins.render();
const localCheck = plugins.button('检查 JSON 格式');
localCheck.props.onClick(); localCheck.props.onClick(); await tick(); plugins.render();
assert.equal(plugins.modelCalls(), 0, 'Local checking publishes results without an Agent request');
plugins.labelControl('向 Agent 提出要求', 'textarea').props.onChange({ target: { value: '解释一下刚才的检查结果，不要重新运行。' } }); plugins.render();
plugins.button('发送').props.onClick(); plugins.render();
assert.equal(plugins.modelCalls(), 1, 'Only the explicit analysis starts the optional Agent');
assert.equal(plugins.pluginContext().frame.observations[0].executionStatus, 'succeeded');
assert.equal(plugins.flow().props.nodes[1].data.artifacts[0].payload.value.status, 'fail');
assert.equal(plugins.flow().props.nodes.length, 2, 'Complete typed result is displayed as a readonly runtime node');
plugins.resolve({ understanding: 'Invalid JSON', plan: 'Explain only', reply: 'The check ran, but JSON syntax failed.', commands: [] }); await tick(); plugins.render();
assert.equal(plugins.modelCalls(), 1); assert.ok(plugins.text().includes('JSON syntax failed'));
plugins.labelControl('向 Agent 提出要求', 'textarea').props.onChange({ target: { value: 'Please check again' } }); plugins.render();
plugins.button('发送').props.onClick(); plugins.render();
const pluginContext = plugins.pluginContext();
const proposedRequest = { ...pluginRegistry.S2_JSON_CHECK_BINDING, nodeId: 'goal', inputs: { text: [pluginContext.bindings[0].artifactId] }, reason: 'User requested a fresh syntax check' };
plugins.resolve({ understanding: 'Check', plan: 'Ask for confirmation', reply: 'Please confirm the check.', commands: [], pluginRequests: [proposedRequest] }); await tick(); plugins.render();
assert.ok(plugins.text().includes('本局插件记录（1）'), 'Agent request does not execute automatically');
plugins.button('确认执行插件并交给 Agent').props.onClick(); await tick(); plugins.render();
assert.ok(plugins.text().includes('本局插件记录（2）'));
plugins.labelControl('内容', 'textarea').props.onChange({ target: { value: '{}' } }); plugins.render();
assert.equal(plugins.flow().props.nodes.length, 1, 'Editing invalidates result display without deleting receipts');
plugins.resolve(result); await tick(); plugins.render(); assert.equal(plugins.flow().props.nodes.length, 1);
assert.ok(plugins.text().includes('只读分析不能修改画布'));
plugins.button('保存场景').props.onClick(); await tick(); plugins.render();
assert.equal(plugins.saved[0].canvasWorkspace.plugins[0].pluginId, 'json-check');
assert.equal(plugins.saved[0].canvasWorkspace.initial.nodes.length, 1, 'Readonly result nodes are not template content');
assert.equal(plugins.saved[0].grant, undefined); assert.equal(plugins.saved[0].pluginResults, undefined);
plugins.button('结束试验').props.onClick(); plugins.render(); assert.ok(plugins.text().includes('过期／结束'));
const reopened = harness({ initialDraft: plugins.saved[0] });
assert.equal(reopened.modelCalls(), 0);
const reopenedJsonCapability = reopened.elements().find(item => item.type === 'label' && reopened.text(item) === '检查 JSON 格式（检查）'); assert.ok(reopenedJsonCapability);
assert.equal(reopened.elements(reopenedJsonCapability).find(item => item.type === 'input' && item.props.type === 'checkbox')?.props.checked, true);
reopened.button('开始试验').props.onClick(); reopened.render();
assert.ok(reopened.text().includes('剩余 64 次')); assert.ok(!reopened.text().includes('本局插件记录（'));
reopened.dispose();
plugins.dispose();
// Exercise actual library/parameter/port/queue handlers, with the real local conversion host.
const canvasDraft = canvas.createS2Scene({ ...request, knowledgePoints: [] });
canvasDraft.canvasWorkspace!.plugins = pluginRegistry.s2ComposableCapabilities().filter(({ pluginId, capabilityId }) => ['json-check', 'structured-data', 'structured-view', 'workflow-simulation', 'workflow-merge', 'human-input'].includes(pluginId)
  && !(pluginId === 'structured-view' && capabilityId === 'text')).map(({ pluginId, pluginVersion, capabilityId }) => ({ pluginId, pluginVersion, capabilityId }));
canvasDraft.canvasWorkspace!.initial.nodes[0].values.content = '[{"name":"A","score":2},{"name":"B"}]';
const graphUi = harness({ initialDraft: canvasDraft });
function addCapability(capabilityId: string, pluginId = 'structured-data') {
  graphUi.labelControl('添加的执行能力', 'select').props.onChange({ target: { value: `${pluginId}@1.0.0/${capabilityId}` } }); graphUi.render();
  graphUi.button('添加执行节点').props.onClick(); graphUi.render();
  return graphUi.flow().props.nodes.find((node: any) => node.type === 'execution' && node.selected).id as string;
}
const parseId = addCapability('parse-json');
graphUi.labelControl('引用字段 text', 'select').props.onChange({ target: { value: '["goal","content"]' } }); graphUi.render();
const tableId = addCapability('to-table'), viewId = addCapability('table', 'structured-view');
graphUi.flow().props.onConnect({ source: parseId, sourceHandle: 'out:value', target: tableId, targetHandle: 'in:value' }); graphUi.render();
graphUi.labelControl('数据线来源', 'select').props.onChange({ target: { value: tableId } }); graphUi.render();
graphUi.labelControl('来源输出端口', 'select').props.onChange({ target: { value: 'table' } }); graphUi.render();
graphUi.labelControl('所选节点输入端口', 'select').props.onChange({ target: { value: 'table' } }); graphUi.render();
graphUi.button('连接数据端口').props.onClick(); graphUi.render();
assert.equal(graphUi.flow().props.edges.filter((edge: any) => edge.className === 's2-data-edge').length, 2);
graphUi.button('复制所选执行节点（不复制连线）').props.onClick(); graphUi.render(); assert.equal(graphUi.flow().props.nodes.length, 5);
graphUi.keyShortcut('undo'); graphUi.render(); assert.equal(graphUi.flow().props.nodes.length, 4);
graphUi.labelControl('选择执行节点', 'select').props.onChange({ target: { value: viewId } }); graphUi.render();
graphUi.button('开始试验').props.onClick(); graphUi.render();
graphUi.button('运行所选步骤').props.onClick(); graphUi.button('运行所选步骤').props.onClick();
await settle(graphUi, () => graphUi.flow().props.nodes.find((node: any) => node.id === viewId).data.status === 'displayed');
assert.equal(graphUi.modelCalls(), 0, 'Manual graph runs do not force an AI lecture/workflow');
assert.ok(graphUi.text().includes('执行队列与历史（2）'));
const displayed = graphUi.flow().props.nodes.find((node: any) => node.id === viewId);
assert.equal(displayed.data.status, 'displayed'); assert.equal(displayed.data.artifacts[0].type.id, 'structured-data.table');
graphUi.labelControl('向 Agent 提出要求', 'textarea').props.onChange({ target: { value: 'Please show only this table again' } }); graphUi.render();
graphUi.button('发送').props.onClick(); graphUi.render();
assert.equal(graphUi.pluginContext().executionRuns.length, 2);
graphUi.resolve({ understanding: 'Only the selected branch', plan: 'Request execution', reply: 'Please confirm', commands: [], pluginRequests: [], executionRequest: { targetNodeIds: [viewId], reason: 'Requested table view' } }); await tick(); graphUi.render();
assert.ok(graphUi.text().includes('执行队列与历史（2）'), 'Agent intention does not queue itself');
graphUi.button('确认运行并请 Agent 解读').props.onClick(); await settle(graphUi, () => graphUi.modelCalls() === 2);
assert.equal(graphUi.modelCalls(), 2, 'Confirmed Agent execution gets one observation response, no autonomous loop');
assert.equal(graphUi.origin(), 'host-event');
assert.equal(graphUi.pluginContext().frame.event.kind, 'workflow-completed');
assert.equal(graphUi.pluginContext().frame.event.workflowRunId, graphUi.pluginContext().executionRuns.at(-1).id,
  'Production workflow handler supplies an exact host completion identity, not a generic user message');
graphUi.resolve({ understanding: 'Table is ready', plan: 'No more execution', reply: 'The complete rows are available.', commands: [], pluginRequests: [] }); await tick(); graphUi.render();
assert.ok(graphUi.text().includes('执行队列与历史（3）'));
graphUi.button('导出工作区 JSON 到下方').props.onClick(); graphUi.render();
const exported = graphUi.labelControl('工作区 JSON', 'textarea').props.value;
assert.equal(JSON.parse(exported).definition.initial.execution.nodes.length, 3);
assert.equal(JSON.parse(exported).definition.initial.execution.links.length, 2);
assert.equal(JSON.parse(exported).grant, undefined);
graphUi.flow().props.onNodesChange([parseId, tableId, viewId].map(id => ({ type: 'select', id, selected: true }))); graphUi.render();
assert.ok(graphUi.text().includes('已选 3 个节点'));
graphUi.button('把所选节点组成一组').props.onClick(); graphUi.render();
assert.equal(graphUi.flow().props.nodes.filter((node: any) => node.type === 'group').length, 1);
graphUi.button('折叠组 处理分组').props.onClick(); graphUi.render();
assert.equal(graphUi.flow().props.nodes.filter((node: any) => node.hidden).length, 3);
assert.equal(graphUi.flow().props.edges.length, 1, 'Internal wires collapse visually; the external field edge targets the group proxy');
assert.equal(graphUi.flow().props.nodes.find((node: any) => node.id === viewId).data.status, 'displayed', 'Folding leaves results current');
const parseX = graphUi.flow().props.nodes.find((node: any) => node.id === parseId).position.x;
graphUi.button('整体右移').props.onClick(); graphUi.render();
assert.equal(graphUi.flow().props.nodes.find((node: any) => node.id === parseId).position.x, parseX + 50);
graphUi.button('批量复制所选（含内部连线）').props.onClick(); graphUi.render();
assert.equal(graphUi.flow().props.nodes.filter((node: any) => node.type === 'execution').length, 6);
assert.equal(graphUi.flow().props.nodes.filter((node: any) => node.type === 'group').length, 2);
graphUi.keyShortcut('undo'); graphUi.render();
assert.equal(graphUi.flow().props.nodes.filter((node: any) => node.type === 'execution').length, 3);
graphUi.button('选择整组').props.onClick(); graphUi.render();
graphUi.button('导出所选子图到下方').props.onClick(); graphUi.render();
assert.equal(JSON.parse(graphUi.labelControl('子图 JSON', 'textarea').props.value).definition.initial.nodes.length, 1, 'Referenced content is explicitly included');
graphUi.button('粘贴子图（保留当前画布）').props.onClick(); graphUi.render();
assert.equal(graphUi.flow().props.nodes.filter((node: any) => node.type === 'execution').length, 6);
assert.ok(graphUi.text().includes('未扩大本局能力范围'));
graphUi.keyShortcut('undo'); graphUi.render();
graphUi.labelControl('选择执行节点', 'select').props.onChange({ target: { value: viewId } }); graphUi.render();
const forceLabel = graphUi.elements().find(item => item.type === 'label' && graphUi.text(item).includes('重新计算，不使用已有结果')); assert.ok(forceLabel);
const forceInput = graphUi.elements(forceLabel).find(item => item.type === 'input'); assert.ok(forceInput);
forceInput.props.onChange({ target: { checked: true } }); graphUi.render();
graphUi.button('运行所选步骤').props.onClick();
await settle(graphUi, () => graphUi.flow().props.nodes.find((node: any) => node.id === viewId).data.status === 'displayed');
assert.equal(graphUi.flow().props.nodes.find((node: any) => node.id === parseId).data.status, 'succeeded');
assert.ok(graphUi.text().includes('剩余 60 次。')); assert.ok(graphUi.text().includes('不使用已有结果'));
graphUi.labelControl('选择块', 'select').props.onChange({ target: { value: 'goal' } }); graphUi.render();
graphUi.labelControl('内容', 'textarea').props.onChange({ target: { value: '[]' } }); graphUi.render();
assert.equal(graphUi.flow().props.nodes.find((node: any) => node.id === viewId).data.status, 'stale');
assert.equal(graphUi.flow().props.nodes.find((node: any) => node.id === viewId).data.artifacts.length, 0);
graphUi.labelControl('选择执行节点', 'select').props.onChange({ target: { value: viewId } }); graphUi.render();
const conditionEditor = () => graphUi.elements().find(item => item.type === 'condition-editor')!;
graphUi.button('展开组 处理分组').props.onClick(); graphUi.render();
conditionEditor().props.onApply({ nodeId: parseId, portId: 'value', pointer: '', equals: [], match: false }); graphUi.render();
assert.equal(graphUi.flow().props.edges.filter((edge: any) => edge.className === 's2-condition-edge').length, 1);
graphUi.button('运行所选步骤').props.onClick();
await settle(graphUi, () => graphUi.flow().props.nodes.find((node: any) => node.id === viewId).data.status === 'skipped');
assert.ok(graphUi.text().includes('未命中条件，已跳过'));
assert.throws(() => conditionEditor().props.onApply({ nodeId: viewId, portId: 'table', pointer: '', equals: [], match: true }), /条件来源|端口|循环/);
conditionEditor().props.onApply(null); graphUi.render(); assert.equal(graphUi.flow().props.edges.some((edge: any) => edge.className === 's2-condition-edge'), false);
graphUi.dispose();
// Actual human-wait handlers: manual pause/resume does not call a model, and semantic edits invalidate waits.
const humanDraft = canvas.createS2Scene({ ...request, knowledgePoints: [] });
humanDraft.canvasWorkspace!.plugins = [
  { pluginId: 'human-input', pluginVersion: '1.0.0', capabilityId: 'text' }, pluginRegistry.S2_JSON_CHECK_BINDING,
];
humanDraft.canvasWorkspace!.initial.execution = { version: 1, nodes: [
  { id: 'human', pluginId: 'human-input', pluginVersion: '1.0.0', capabilityId: 'text', position: { x: 0, y: 0 }, bindings: { prompt: { kind: 'literal', value: '填写JSON文本' } } },
  { id: 'check', ...pluginRegistry.S2_JSON_CHECK_BINDING, position: { x: 350, y: 0 }, bindings: {} },
], links: [{ source: { nodeId: 'human', portId: 'text' }, target: { nodeId: 'check', portId: 'text' } }] };
const humanUi = harness({ initialDraft: humanDraft }); humanUi.button('开始试验').props.onClick(); humanUi.render();
humanUi.labelControl('选择执行节点', 'select').props.onChange({ target: { value: 'check' } }); humanUi.render();
humanUi.button('运行所选步骤').props.onClick();
await settle(humanUi, () => humanUi.elements().some(item => item.type === 'human-input'));
let humanForm = humanUi.elements().find(item => item.type === 'human-input')!;
assert.equal(humanForm.props.wait.prompt, '填写JSON文本'); assert.equal(humanUi.modelCalls(), 0);
assert.equal(humanUi.labelControl('向 Agent 提出要求', 'textarea').props.disabled, false, 'Waiting does not lock free conversation');
humanForm.props.onSubmit('{}');
await settle(humanUi, () => humanUi.flow().props.nodes.find((node: any) => node.id === 'check').data.status === 'succeeded');
assert.equal(humanUi.modelCalls(), 0); assert.ok(humanUi.text().includes('用户实际提交')); assert.ok(humanUi.text().includes('剩余 63 次。'));
humanUi.button('运行所选步骤').props.onClick(); await settle(humanUi, () => humanUi.elements().some(item => item.type === 'human-input'));
humanForm = humanUi.elements().find(item => item.type === 'human-input')!;
humanUi.labelControl('选择块', 'select').props.onChange({ target: { value: 'goal' } }); humanUi.render();
humanUi.labelControl('内容', 'textarea').props.onChange({ target: { value: 'changed while waiting' } }); humanUi.render();
assert.ok(!humanUi.elements().some(item => item.type === 'human-input')); assert.throws(() => humanForm.props.onSubmit('{}'), /失效/);
humanUi.button('保存场景').props.onClick(); await tick(); humanUi.render();
assert.ok(!JSON.stringify(humanUi.saved[0]).includes('humanEvidence')); assert.ok(!JSON.stringify(humanUi.saved[0]).includes('contextArtifactIds')); humanUi.dispose();
const importedUi = harness(); importedUi.labelControl('工作区 JSON', 'textarea').props.onChange({ target: { value: exported } }); importedUi.render();
importedUi.button('导入并替换当前预览').props.onClick(); importedUi.render();
await tick(); importedUi.render();
assert.equal(importedUi.flow().props.nodes.length, 4); assert.equal(importedUi.modelCalls(), 0);
assert.ok(importedUi.text().includes('尚未授予执行或模型权限'));
importedUi.button('开始试验').props.onClick(); importedUi.render();
assert.ok(!importedUi.text().includes('尚未授予执行或模型权限')); assert.ok(importedUi.text().includes('试验已开始；编辑不会自动运行'));
importedUi.dispose();
const simulationUi = harness({ initialDraft: canvasDraft });
assert.ok(simulationUi.text().includes('示例模拟：只串接'));
simulationUi.labelControl('添加的执行能力', 'select').props.onChange({ target: { value: 'workflow-simulation@1.0.0/step' } }); simulationUi.render();
simulationUi.button('添加执行节点').props.onClick(); simulationUi.render();
const simId = simulationUi.flow().props.nodes.find((node: any) => node.selected).id;
simulationUi.labelControl('参数 purpose', 'textarea').props.onChange({ target: { value: '模拟发送' } }); simulationUi.render();
simulationUi.labelControl('参数 assumptions', 'textarea').props.onChange({ target: { value: '仅试验，不会发送' } }); simulationUi.render();
const sampleEditor = () => simulationUi.elements().find(item => item.type === 'json-parameter' && item.props.portId === 'sample')!;
sampleEditor().props.onCommit({ delivered: false }); simulationUi.render();
assert.deepEqual(sampleEditor().props.value, { delivered: false });
assert.throws(() => sampleEditor().props.onCommit(JSON.parse('{"__proto__":true}')), /保留/);
simulationUi.render(); assert.deepEqual(sampleEditor().props.value, { delivered: false }, 'Invalid JSON values do not alter committed graph bindings');
simulationUi.button('开始试验').props.onClick(); simulationUi.render();
simulationUi.button('运行所选步骤').props.onClick();
await settle(simulationUi, () => simulationUi.flow().props.nodes.find((node: any) => node.id === simId).data.status === 'succeeded');
assert.equal(simulationUi.modelCalls(), 0);
const simArtifact = simulationUi.flow().props.nodes.find((node: any) => node.id === simId).data.artifacts[0];
assert.equal(simArtifact.type.id, 'workflow-simulation.result'); assert.equal(simArtifact.payload.value.mode, 'simulation-only');
simulationUi.button('结束试验').props.onClick(); simulationUi.render(); assert.equal(sampleEditor().props.disabled, true); simulationUi.dispose();
// Exercise real library/connect/queue handlers with two exclusive branches and one shared downstream.
const mergeDraft = canvas.createS2Scene({ ...request, knowledgePoints: [] });
mergeDraft.canvasWorkspace!.plugins = pluginRegistry.s2ComposableCapabilities().filter(({ pluginId, capabilityId }) => ['json-check', 'structured-data', 'structured-view', 'workflow-simulation', 'workflow-merge', 'human-input'].includes(pluginId)
  && !(pluginId === 'structured-view' && capabilityId === 'text')).map(({ pluginId, pluginVersion, capabilityId }) => ({ pluginId, pluginVersion, capabilityId }));
mergeDraft.canvasWorkspace!.initial.nodes[0].values.content = '{}';
const branchCondition = (match: boolean) => ({ nodeId: 'check', portId: 'assessment', pointer: '/status', equals: 'pass', match });
mergeDraft.canvasWorkspace!.initial.execution = { version: 1, nodes: [
  { id: 'check', pluginId: 'json-check', pluginVersion: '1.0.0', capabilityId: 'validate', position: { x: 0, y: 0 }, bindings: { text: { kind: 'field', nodeId: 'goal', fieldId: 'content' } } },
  { id: 'left', pluginId: 'structured-data', pluginVersion: '1.0.0', capabilityId: 'parse-json', position: { x: 300, y: 0 }, when: branchCondition(true), bindings: { text: { kind: 'field', nodeId: 'goal', fieldId: 'content' } } },
  { id: 'right', pluginId: 'structured-data', pluginVersion: '1.0.0', capabilityId: 'parse-json', position: { x: 300, y: 500 }, when: branchCondition(false), bindings: { text: { kind: 'literal', value: '[]' } } },
], links: [] };
const mergeUi = harness({ initialDraft: mergeDraft });
mergeUi.labelControl('添加的执行能力', 'select').props.onChange({ target: { value: 'workflow-merge@1.0.0/merge-json' } }); mergeUi.render();
mergeUi.button('添加执行节点').props.onClick(); mergeUi.render();
const mergeId = mergeUi.flow().props.nodes.find((node: any) => node.selected).id;
for (const id of ['left', 'right']) { mergeUi.flow().props.onConnect({ source: id, sourceHandle: 'out:value', target: mergeId, targetHandle: 'in:candidates' }); mergeUi.render(); }
mergeUi.labelControl('添加的执行能力', 'select').props.onChange({ target: { value: 'structured-view@1.0.0/json-tree' } }); mergeUi.render();
mergeUi.button('添加执行节点').props.onClick(); mergeUi.render();
const sharedView = mergeUi.flow().props.nodes.find((node: any) => node.selected).id;
mergeUi.flow().props.onConnect({ source: mergeId, sourceHandle: 'out:selected', target: sharedView, targetHandle: 'in:value' }); mergeUi.render();
mergeUi.button('开始试验').props.onClick(); mergeUi.render(); mergeUi.button('运行所选步骤').props.onClick();
await settle(mergeUi, () => mergeUi.flow().props.nodes.find((node: any) => node.id === sharedView).data.status === 'displayed');
assert.equal(mergeUi.flow().props.nodes.find((node: any) => node.id === mergeId).data.mergeEvidence.selectedNodeId, 'left');
assert.equal(mergeUi.modelCalls(), 0); assert.ok(mergeUi.text().includes('互斥合流：1 路候选'));
mergeUi.labelControl('选择执行节点', 'select').props.onChange({ target: { value: 'right' } }); mergeUi.render();
mergeUi.elements().find(item => item.type === 'condition-editor')!.props.onApply(branchCondition(true)); mergeUi.render();
mergeUi.labelControl('选择执行节点', 'select').props.onChange({ target: { value: sharedView } }); mergeUi.render(); mergeUi.button('运行所选步骤').props.onClick();
await settle(mergeUi, () => mergeUi.flow().props.nodes.find((node: any) => node.id === sharedView).data.status === 'blocked');
assert.ok(mergeUi.text().includes('互斥合流冲突')); assert.equal(mergeUi.flow().props.nodes.find((node: any) => node.id === sharedView).data.artifacts.length, 0);
mergeUi.labelControl('选择执行节点', 'select').props.onChange({ target: { value: 'right' } }); mergeUi.render();
mergeUi.elements().find(item => item.type === 'condition-editor')!.props.onApply(branchCondition(false)); mergeUi.render();
mergeUi.labelControl('选择块', 'select').props.onChange({ target: { value: 'goal' } }); mergeUi.render();
mergeUi.labelControl('内容', 'textarea').props.onChange({ target: { value: '{bad}' } }); mergeUi.render();
mergeUi.labelControl('选择执行节点', 'select').props.onChange({ target: { value: sharedView } }); mergeUi.render(); mergeUi.button('运行所选步骤').props.onClick();
await settle(mergeUi, () => mergeUi.flow().props.nodes.find((node: any) => node.id === sharedView).data.status === 'displayed');
assert.equal(mergeUi.flow().props.nodes.find((node: any) => node.id === mergeId).data.mergeEvidence.selectedNodeId, 'right');
assert.deepEqual(mergeUi.flow().props.nodes.find((node: any) => node.id === sharedView).data.artifacts[0].payload.value, []);
assert.equal(mergeUi.modelCalls(), 0); mergeUi.dispose();
console.log('S2 production handlers passed: preview/start, edit/history/cycles, semantic-vs-layout reply/memory/host-result freshness, full-snapshot edit isolation, exact-target once-only execution confirmation and explicit new requests, stale/abort protection, actual JSON adapter-to-Agent observation, readonly result nodes, transient receipt isolation, template reapproval and S4 rejection. Synthetic hooks/model/IO; not browser E2E.');
