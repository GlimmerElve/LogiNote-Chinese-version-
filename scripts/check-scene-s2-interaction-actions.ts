import assert from 'node:assert/strict';
import type { SceneInteractionPackDefinition, ScenePackConfig } from '../src/types/sceneInteractionPack';
import type { S2InteractionAction, S2InteractionScope } from '../src/types/sceneS2Interaction';
import { readSceneInteractionPack } from '../src/services/scene/sceneInteractionPackProtocol';
import { installSceneInteractionCapabilities } from '../src/services/scene/sceneS2PluginRegistry';
import { compileS2PublicCanvas, projectS2PublicCanvas } from '../src/services/scene/sceneS2PublicAuthoring';
import { readS2Definition, readS2Document } from '../src/services/scene/sceneS2Canvas';
import { prepareS2InteractionActions, executeS2InteractionActions, S2InteractionActionError, type S2InteractionActionServices } from '../src/services/scene/sceneS2InteractionActions';
import { sceneInteractionPacks } from '../src/services/scene/sceneInteractionPacks';

const previousFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('Interaction action checks forbid network and real models');
const raw: SceneInteractionPackDefinition = {
  manifest: { protocolVersion: 1, id: 'interaction-actions-pack', version: '1.0.0', name: '通用交互动作回归', paradigm: 'S2', paradigmApiVersion: 1, requiredServices: ['execution'] },
  capabilities: [{ protocolVersion: 1, id: 'interaction-actions-tools', version: '1.0.0', label: '本地实现', meaning: 'PRIVATE_IMPLEMENTATION',
    dependencies: [{ id: 'core', version: '1.0.0' }], dataTypes: [], capabilities: [{ id: 'echo', kind: 'transform', meaning: '本地原文处理', effect: 'pure', permissions: [], confirmation: 'none', retry: 'manual-only', timeoutMs: 1000,
      inputs: [
        { id: 'text', label: '原文', meaning: '原样读取输入', type: { id: 'core.text', version: 1 }, required: true, multiple: false },
        { id: 'amount', label: '次数', meaning: '处理次数', type: { id: 'core.number', version: 1 }, required: false, multiple: false },
        { id: 'secret', label: '固定内部设置', meaning: 'PRIVATE_IMPLEMENTATION', type: { id: 'core.text', version: 1 }, required: false, multiple: false },
      ], outputs: [{ id: 'text', label: '输出', meaning: '完整文字', type: { id: 'core.text', version: 1 }, required: true, multiple: false }] }] }],
  authoring: { version: 1, components: [
    ...['note', 'material'].map(id => ({ id, label: id, purpose: '公开文字', implementation: { kind: 'content' as const,
      blockType: { id: 'text', label: '原生文字', fields: [{ id: 'content', label: '内容', kind: 'multiline' as const }, { id: 'secret', label: '固定字段', kind: 'text' as const }] } },
      inputs: [], outputs: ['content'], parameters: ['content'], defaults: { content: '', secret: 'PRIVATE_NATIVE_VALUE' } })),
    ...['workerA', 'workerB'].map(id => ({ id, label: id, purpose: '公开处理', implementation: { kind: 'capability' as const, pluginId: 'interaction-actions-tools', pluginVersion: '1.0.0', capabilityId: 'echo' },
      inputs: ['text'], outputs: ['text'], parameters: ['amount'], defaults: { amount: 1, secret: 'PRIVATE_FIXED_VALUE' } })),
  ], internal: { blockTypes: [], document: { nodes: [], edges: [], execution: { version: 1, nodes: [{ id: 'InternalWorker', pluginId: 'interaction-actions-tools', pluginVersion: '1.0.0', capabilityId: 'echo',
    position: { x: -600, y: 0 }, bindings: { text: { kind: 'literal', value: 'PRIVATE_INTERNAL_VALUE' }, secret: { kind: 'literal', value: 'PRIVATE_FIXED_VALUE' } } }], links: [] },
    groups: [{ id: 'InternalGroup', label: '内部组', nodeIds: ['InternalWorker'], collapsed: false }] } } },
  validate: () => [], createRuntime: () => assert.fail('Pure actions must not construct a package runtime'),
  executeLocal: async () => assert.fail('Pure actions must not execute a component'),
};
const pack = readSceneInteractionPack(raw); installSceneInteractionCapabilities(pack); sceneInteractionPacks.register(pack);
const edge = (sourceNode: string, targetNode: string) => ({ source: { nodeId: sourceNode, portId: 'content' }, target: { nodeId: targetNode, portId: 'text' } });
const compiled = compileS2PublicCanvas(pack, { version: 1, nodes: [
  { id: 'Note', componentId: 'note', label: '相同名字', position: { x: 10, y: 20 }, values: { content: '第一份完整原文 $& {{literal}}' } },
  { id: 'Material', componentId: 'material', label: '相同名字', position: { x: 10, y: 350 }, values: { content: '第二份\n完整原文' } },
  { id: 'WorkerA', componentId: 'workerA', label: '相同名字', position: { x: 360, y: 20 }, values: { amount: 2 } },
  { id: 'WorkerB', componentId: 'workerB', label: '相同名字', position: { x: 360, y: 350 }, values: { amount: 3 } },
], connections: [edge('Note', 'WorkerA'), edge('Material', 'WorkerB')] }, { goal: '保留完整设计，只按本轮修改局部',
  instructions: { understanding: '理解本轮要求', planning: '按目标协作', response: '报告实际结果' } });
compiled.document.edges = [{ id: 'Relation', source: 'Note', target: 'Material', label: '只有语义关系' }];
compiled.document.groups!.push({ id: 'PublicGroup', label: '保留分组', nodeIds: ['Note', 'Material'], collapsed: true });
compiled.document.composites = [{ id: 'PublicComposite', label: '保留组合', nodeIds: ['WorkerA', 'WorkerB'] }];
compiled.document.execution!.nodes.find(node => node.id === 'WorkerA')!.presentation = { label: '相同名字', description: '保留描述', inputs: { text: '保留输入显示名' }, outputs: { text: '保留输出显示名' } };
const definition = readS2Definition({ ...compiled.definition, initial: compiled.document,
  criteria: [{ id: 'Expected', label: '已有预期', expectation: '按约定保留', method: 'advisory', required: false }],
  interaction: { version: 1, triggers: [
    { id: 'RemovedSource', on: { event: 's2.node.succeeded', nodeId: 'WorkerA' }, task: '解释结果', scope: { actions: ['reply'] } },
    { id: 'KeptSource', on: { event: 's2.node.succeeded', nodeId: 'WorkerB' }, task: '解释相关节点', scope: { nodeIds: ['WorkerA'], actions: ['reply'] } },
  ] } });
const before: ScenePackConfig = { definition, document: readS2Document(definition.initial, definition) };
const full: S2InteractionScope = { actions: ['reply', 'edit', 'execute'] };
const inputSnapshot = JSON.stringify(before);
function setup(initial = before) {
  let live = structuredClone(initial), commits = 0, runs = 0, cancels = 0;
  const services: S2InteractionActionServices = { guard() {}, readConfig: () => structuredClone(live),
    applyConfig(next) { commits++; live = structuredClone(next); },
    run(targets) { runs++; assert.deepEqual(targets, ['WorkerA']); return { status: 'succeeded', id: 'RunOne' }; },
    cancel(runId) { cancels++; assert.equal(runId, 'RunOne'); },
  };
  return { services, current: () => live, counts: () => ({ commits, runs, cancels }) };
}
function rejected(actions: unknown, scope = full, config = before) {
  assert.throws(() => prepareS2InteractionActions(pack, config, actions, scope));
  assert.equal(JSON.stringify(before), inputSnapshot);
}

try {
  const environment = setup();
  const actions: S2InteractionAction[] = [
    { type: 'setValues', nodeId: 'Note', values: { content: '修改后的完整原文' } },
    { type: 'setValues', nodeId: 'WorkerA', values: { amount: 4 } },
    { type: 'run', targetNodeIds: ['WorkerA'] },
  ];
  const plan = prepareS2InteractionActions(pack, before, actions, full);
  assert.equal(plan.actionCount, 3); assert(plan.hasEdits && plan.hasExecution);
  assert.deepEqual(environment.counts(), { commits: 0, runs: 0, cancels: 0 }, 'Preflight never applies edits or starts work');
  environment.services.run = targets => {
    assert.deepEqual(targets, ['WorkerA']);
    assert.equal(environment.current().document.nodes.find(node => node.id === 'Note')!.values.content, '修改后的完整原文');
    assert.deepEqual(environment.current().document.execution!.nodes.find(node => node.id === 'WorkerA')!.bindings.amount, { kind: 'literal', value: 4 });
    return { status: 'succeeded' };
  };
  const report = await executeS2InteractionActions(plan, environment.services);
  assert.equal(report.status, 'completed'); assert.deepEqual(report.steps.map(step => step.indexes), [[0, 1], [2]]);
  assert.equal(environment.counts().commits, 1, 'Continuous edits commit once before execution');
  const after = environment.current();
  for (const key of ['edges', 'groups', 'composites', 'blueprints'] as const) assert.deepEqual(after.document[key], before.document[key], key);
  assert.deepEqual(after.document.execution!.nodes.find(node => node.id === 'WorkerA')!.presentation, before.document.execution!.nodes.find(node => node.id === 'WorkerA')!.presentation);
  assert.deepEqual(after.document.execution!.nodes.find(node => node.id === 'InternalWorker'), before.document.execution!.nodes.find(node => node.id === 'InternalWorker'));
  for (const key of ['goal', 'instructions', 'criteria', 'business', 'designBrief', 'interaction'] as const) assert.deepEqual(after.definition[key], before.definition[key], key);
  assert.deepEqual(projectS2PublicCanvas(pack, after.definition, after.document).nodes.map(node => node.componentId), ['note', 'material', 'workerA', 'workerB']);
  await assert.rejects(() => executeS2InteractionActions(plan, environment.services), /本地公开动作预检/, 'A local prepared token cannot dispatch twice');
  await assert.rejects(() => executeS2InteractionActions({ actionCount: 1, hasEdits: true, hasExecution: false }, environment.services), /本地公开动作预检/);

  rejected([{ type: 'setValues', nodeId: 'Note', values: { content: '不该应用' } }, { type: 'setValues', nodeId: 'WorkerA', values: { amount: 'invalid' } }]);
  rejected([{ type: 'setValues', nodeId: 'WorkerA', values: { secret: '扩大参数范围' } }]);
  rejected([{ type: 'setValues', nodeId: 'InternalWorker', values: {} }]);
  rejected([{ type: 'removeNode', nodeId: 'InternalWorker' }]);
  rejected([{ type: 'run', targetNodeIds: ['InternalWorker'] }]);
  rejected([{ type: 'run', targetNodeIds: ['Note'] }]);
  rejected([{ type: 'setValues', nodeId: 'Note', values: { content: '不允许' } }], { actions: ['reply'] });
  rejected([{ type: 'setValues', nodeId: 'Material', values: { content: '越界' } }], { actions: ['edit'], nodeIds: ['Note'] });
  rejected([{ type: 'run', targetNodeIds: ['WorkerA'] }], { actions: ['execute'], nodeIds: [] });
  rejected([{ type: 'cancel', runId: 'RunOne' }], { actions: ['reply'] });
  rejected([{ type: 'setValues', nodeId: 'Note', values: {}, grants: [] }]);
  rejected([{ type: 'addNode', node: { id: 'New', componentId: 'note', position: { x: 1, y: 1 } } }], { actions: ['edit'], nodeIds: ['Note'] });
  rejected(Object.defineProperty({}, 'length', { get() { assert.fail('Do not invoke untrusted accessors'); } }));

  const fixed = structuredClone(before); fixed.document.nodes.find(node => node.id === 'Note')!.readOnly = true;
  fixed.definition.initial = structuredClone(fixed.document);
  rejected([{ type: 'setValues', nodeId: 'Note', values: { content: '篡改' } }], full, fixed);
  rejected([{ type: 'removeNode', nodeId: 'Note' }], full, fixed);

  const adding = setup();
  const addReport = await executeS2InteractionActions(prepareS2InteractionActions(pack, before, [
    { type: 'addNode', node: { id: 'NewMaterial', componentId: 'material', label: '任意名称', position: { x: 750, y: 40 }, values: { content: '新原文' } } },
  ], full), adding.services);
  assert.equal(addReport.status, 'completed');
  assert.equal(projectS2PublicCanvas(pack, adding.current().definition, adding.current().document).nodes.find(node => node.id === 'NewMaterial')!.componentId, 'material');

  const deleting = setup();
  const deletion = await executeS2InteractionActions(prepareS2InteractionActions(pack, before, [{ type: 'removeNode', nodeId: 'WorkerA' }], full), deleting.services);
  assert.equal(deletion.status, 'completed');
  assert.deepEqual(deleting.current().document.composites![0].nodeIds, ['WorkerB']);
  assert.deepEqual(deleting.current().definition.interaction!.triggers.map(trigger => trigger.id), ['KeptSource']);
  assert.deepEqual(deleting.current().definition.interaction!.triggers[0].scope!.nodeIds, [], 'Pruned empty scope never widens to all nodes');

  const failedRun = setup();
  failedRun.services.run = () => ({ status: 'failed', error: 'PRIVATE_PROVIDER_ERROR' });
  const failed = await executeS2InteractionActions(prepareS2InteractionActions(pack, before, [
    { type: 'setValues', nodeId: 'Note', values: { content: '已提交的修改' } },
    { type: 'run', targetNodeIds: ['WorkerA'] }, { type: 'setValues', nodeId: 'Material', values: { content: '不应继续' } },
  ], full), failedRun.services);
  assert.equal(failed.status, 'failed'); assert.equal(failed.failedAt, 1);
  assert.equal(failedRun.current().document.nodes.find(node => node.id === 'Note')!.values.content, '已提交的修改');
  assert.equal(failedRun.current().document.nodes.find(node => node.id === 'Material')!.values.content, before.document.nodes.find(node => node.id === 'Material')!.values.content);
  assert(!failed.error!.reason.includes('PRIVATE_PROVIDER_ERROR'));

  const aborted = setup();
  aborted.services.guard = () => { throw new DOMException('stopped', 'AbortError'); };
  const cancelled = await executeS2InteractionActions(prepareS2InteractionActions(pack, before, actions, full), aborted.services);
  assert.equal(cancelled.status, 'cancelled'); assert.deepEqual(aborted.counts(), { commits: 0, runs: 0, cancels: 0 });
  const cancel = setup();
  assert.equal((await executeS2InteractionActions(prepareS2InteractionActions(pack, before, [{ type: 'cancel', runId: 'RunOne' }], full), cancel.services)).status, 'completed');
  assert.equal(cancel.counts().cancels, 1);
  assert.equal(JSON.stringify(before), inputSnapshot, 'Every preflight and execution leaves the source configuration untouched');
  console.log('S2 interaction actions passed: shared public component identities, strict scoped/type/private/readonly validation, atomic edit segments before real local callback dispatch, preserved graph metadata and trigger pruning, one-shot plans, actual failure/cancellation reports and no automatic retry. Synthetic local services only; no model/network/user-data calls.');
} finally { globalThis.fetch = previousFetch; }
