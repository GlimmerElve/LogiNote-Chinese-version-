import assert from 'node:assert/strict';
import type { SceneInteractionPackDefinition, ScenePackConfig } from '../src/types/sceneInteractionPack';
import type { S2InteractionTrigger } from '../src/types/sceneS2Interaction';
import { readSceneInteractionPack } from '../src/services/scene/sceneInteractionPackProtocol';
import { installSceneInteractionCapabilities } from '../src/services/scene/sceneS2PluginRegistry';
import { sceneInteractionPacks } from '../src/services/scene/sceneInteractionPacks';
import { compileS2PublicCanvas } from '../src/services/scene/sceneS2PublicAuthoring';
import { readS2Definition, exportS2Workspace, importS2WorkspaceWithPack } from '../src/services/scene/sceneS2Canvas';
import { s2InteractionDocumentSnapshot } from '../src/services/scene/sceneS2InteractionMetadata';
import { S2InteractionEventRouter, validateS2PublicInteraction, bindS2PackageInteractionEvents,
  closeS2PackageInteractionEvents, emitS2PackageInteractionEvent, type S2InteractionTask } from '../src/services/scene/sceneS2InteractionEvents';

const previousFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('Event routing checks prohibit network and real models');
let runtimeCalls = 0;
const local = { pluginId: 'interaction-events-tools', pluginVersion: '1.0.0', capabilityId: 'echo' };
const raw: SceneInteractionPackDefinition = {
  manifest: { protocolVersion: 1, id: 'interaction-events', version: '1.0.0', name: '独立通用事件包', paradigm: 'S2', paradigmApiVersion: 1, requiredServices: ['execution'] },
  capabilities: [{ protocolVersion: 1, id: local.pluginId, version: local.pluginVersion, label: '本地实现', meaning: '处理文字',
    dependencies: [{ id: 'core', version: '1.0.0' }], dataTypes: [], capabilities: [{ id: local.capabilityId, kind: 'transform', meaning: '原样处理输入',
      effect: 'pure', permissions: [], confirmation: 'none', retry: 'manual-only', timeoutMs: 1000,
      inputs: [{ id: 'text', label: '文字', meaning: '输入原文', type: { id: 'core.text', version: 1 }, required: true, multiple: false }],
      outputs: [{ id: 'text', label: '结果', meaning: '完整原文', type: { id: 'core.text', version: 1 }, required: true, multiple: false }] }] }],
  authoring: { version: 1, components: [
    { id: 'note', label: '公开文字', purpose: '填写原文', implementation: { kind: 'content', blockType: { id: 'text', label: '文字', fields: [{ id: 'content', label: '内容', kind: 'multiline' }] } },
      inputs: [], outputs: ['content'], parameters: ['content'], defaults: { content: '' } },
    { id: 'worker', label: '公开处理', purpose: '处理原文', implementation: { kind: 'capability', ...local }, inputs: ['text'], outputs: ['text'], parameters: [] },
  ], internal: { blockTypes: [], document: { nodes: [], edges: [], execution: { version: 1, nodes: [
    { id: 'PrivateWorker', ...local, position: { x: -300, y: 0 }, bindings: { text: { kind: 'literal', value: '包内固定内容' } } },
  ], links: [] } } } },
  interaction: { version: 1, events: [{ id: 'interaction-events.ready', purpose: '用户已完成一份文字的业务准备',
    dataSchema: { kind: 'object', fields: { message: { kind: 'string', maxLength: 40 } }, required: ['message'] } }] },
  validate: () => [], createRuntime: () => { runtimeCalls++; return assert.fail('Pure event routing cannot create runtimes'); },
  executeLocal: async () => { runtimeCalls++; return assert.fail('Pure event routing cannot execute components'); },
};
const pack = readSceneInteractionPack(raw); installSceneInteractionCapabilities(pack); sceneInteractionPacks.register(pack);
const base = compileS2PublicCanvas(pack, { version: 1, nodes: [
  { id: 'Note', componentId: 'note', position: { x: 0, y: 0 }, values: { content: '独立原文' } },
  { id: 'Worker', componentId: 'worker', position: { x: 320, y: 0 } },
], connections: [{ source: { nodeId: 'Note', portId: 'content' }, target: { nodeId: 'Worker', portId: 'text' } }] },
{ goal: '通用事件路由', instructions: { understanding: '理解任务', planning: '依范围处理', response: '引用已有记录' } });
const routers: S2InteractionEventRouter[] = [];
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function trigger(id: string, event = 's2.node.succeeded', nodeId = 'Worker', scope?: S2InteractionTrigger['scope']): S2InteractionTrigger {
  return { id, on: { event, nodeId }, task: '按已有资料响应', ...(scope === undefined ? {} : { scope }) };
}
function setup(triggers?: S2InteractionTrigger[], run?: (task: S2InteractionTask) => Promise<void>) {
  const definition = readS2Definition({ ...structuredClone(base.definition), ...(triggers === undefined ? {} : { interaction: { version: 1, triggers } }) });
  const config: ScenePackConfig = { definition, document: structuredClone(definition.initial) };
  validateS2PublicInteraction(pack, definition, config.document);
  let revision = 1, current = true, busy = false;
  const calls: S2InteractionTask[] = [], errors: unknown[] = [];
  const router = new S2InteractionEventRouter({ pack, readConfig: () => structuredClone(config), revision: () => revision,
    current: () => current, canRun: () => !busy,
    async run(task) { calls.push(structuredClone(task)); await run?.(task); }, onError(error) { errors.push(error); } });
  routers.push(router);
  return { router, config, calls, errors, busy(value: boolean) { busy = value; }, current(value: boolean) { current = value; }, revise() { revision++; } };
}

try {
  const absent = setup();
  absent.router.publish('s2.node.succeeded', 'Worker', { resultIds: ['ResultOne'] });
  absent.router.publish('s2.node.failed', 'Worker', { error: '本地失败' });
  absent.router.publish('interaction-events.ready', 'Note', { message: '资料就绪' }); await tick();
  assert.deepEqual(absent.calls, [], 'No interaction configuration means no Agent callback');

  const builtin = setup([trigger('Success'), trigger('Failure', 's2.node.failed')]);
  const cause = builtin.router.newCause();
  builtin.router.publish('s2.node.succeeded', 'Worker', { resultIds: ['ResultOne'] }, cause, 'CompleteOne', 'InvocationOne');
  builtin.router.publish('s2.node.failed', 'Worker', { error: '本地失败' }, cause, 'FailedOne'); await tick();
  assert.deepEqual(builtin.calls.map(call => call.event.type), ['s2.node.succeeded', 's2.node.failed']);
  assert.deepEqual(builtin.calls[0].scope, { actions: ['reply'] });
  assert.deepEqual(builtin.calls[0].event, { id: 'CompleteOne', type: 's2.node.succeeded', nodeId: 'Worker', data: { resultIds: ['ResultOne'] },
    causeId: cause.id, chain: ['Success'], revision: 1, invocationId: 'InvocationOne' });
  assert.throws(() => builtin.router.publish('s2.node.succeeded', 'Note', {}), /执行节点/);
  assert.throws(() => builtin.router.publish('s2.node.failed', 'PrivateWorker', {}), /公开节点/);
  assert.throws(() => builtin.router.publish('s2.node.succeeded', 'Missing', {}), /公开节点/);
  assert.throws(() => builtin.router.publish('s2.node.failed', 'Worker', { privateState: true }), /不符合/);
  assert.throws(() => builtin.router.publish('unknown.ready', 'Worker', {}), /声明/);

  const custom = setup([trigger('Ready', 'interaction-events.ready', 'Note', { nodeIds: [], actions: ['reply'] })]);
  const payload = { message: '自定义消息' };
  custom.router.publish('interaction-events.ready', 'Note', payload); payload.message = '调用方之后修改'; await tick();
  assert.equal(custom.calls.length, 1); assert.deepEqual(custom.calls[0].event.data, { message: '自定义消息' });
  assert.deepEqual(custom.calls[0].scope, { actions: ['reply'], nodeIds: [] }, 'An explicit empty node scope stays empty');
  for (const invalid of [{}, { message: 1 }, { message: '字'.repeat(41) }, { message: '原文', permission: true }])
    assert.throws(() => custom.router.publish('interaction-events.ready', 'Note', invalid), /不符合/);
  assert.throws(() => custom.router.publish('interaction-events.ready', 'PrivateWorker', { message: '无权限' }), /公开节点/);
  let getters = 0;
  const hostile = Object.defineProperty({}, 'message', { enumerable: true, get() { getters++; return '不能读取'; } });
  assert.throws(() => custom.router.publish('interaction-events.ready', 'Note', hostile)); assert.equal(getters, 0);

  for (const invalid of [trigger('PrivateSource', 'interaction-events.ready', 'PrivateWorker'),
    trigger('UnknownEvent', 'unknown.ready'), trigger('PrivateScope', 's2.node.succeeded', 'Worker', { nodeIds: ['PrivateWorker'] }),
    trigger('ContentBuiltin', 's2.node.succeeded', 'Note')]) {
    assert.throws(() => validateS2PublicInteraction(pack, { ...base.definition, interaction: { version: 1, triggers: [invalid] } }));
  }
  const distinctScope = setup([trigger('Feedback', 's2.node.succeeded', 'Worker', { actions: ['edit'], nodeIds: ['Note'] })]);
  distinctScope.router.publish('s2.node.succeeded', 'Worker', {}); await tick();
  assert.deepEqual(distinctScope.calls[0].scope, { actions: ['edit'], nodeIds: ['Note'] }, 'Source and permitted edit range may differ');

  const portable = setup([trigger('Source', 's2.node.succeeded', 'Worker', { actions: ['reply'], nodeIds: ['Note'] }),
    trigger('Ready', 'interaction-events.ready', 'Note', { nodeIds: [], actions: ['reply'] })]);
  const reference = { id: pack.manifest.id, version: pack.manifest.version };
  const workspace = exportS2Workspace(portable.config.definition, portable.config.document, reference);
  const restored = importS2WorkspaceWithPack(workspace);
  assert.deepEqual(restored.interactionPack, reference);
  assert.deepEqual(restored.definition.interaction, portable.config.definition.interaction, 'Workspace preserves configured triggers and explicit scopes');
  for (const invalid of [trigger('UnknownEvent', 'uninstalled.ready'), trigger('PrivateSource', 's2.node.succeeded', 'PrivateWorker')]) {
    const definition = { ...structuredClone(portable.config.definition), interaction: { version: 1 as const, triggers: [invalid] } };
    assert.throws(() => exportS2Workspace(definition, portable.config.document, reference));
    const tampered = JSON.parse(workspace); tampered.definition.interaction = definition.interaction;
    assert.throws(() => importS2WorkspaceWithPack(JSON.stringify(tampered)), 'Import rejects unknown events or a private trigger source');
  }
  const originalRules = structuredClone(portable.config.definition.interaction);
  const removedSource = structuredClone(portable.config.document);
  removedSource.execution!.nodes = removedSource.execution!.nodes.filter(node => node.id !== 'Worker'); removedSource.execution!.links = [];
  const withoutSource = s2InteractionDocumentSnapshot(portable.config.definition, removedSource);
  assert.deepEqual(withoutSource.interaction!.triggers.map(item => item.id), ['Ready'], 'A portable snapshot retires deleted source triggers');
  const removedTarget = structuredClone(portable.config.document); removedTarget.nodes = [];
  delete removedTarget.execution!.nodes.find(node => node.id === 'Worker')!.bindings.text;
  const withoutTarget = s2InteractionDocumentSnapshot(portable.config.definition, removedTarget);
  assert.deepEqual(withoutTarget.interaction!.triggers.map(item => item.id), ['Source']);
  assert.deepEqual(withoutTarget.interaction!.triggers[0].scope!.nodeIds, [], 'Deleting the sole permitted target cannot widen the scope');
  assert.deepEqual(portable.config.definition.interaction, originalRules, 'Portable pruning does not mutate the live editor rules');
  assert.deepEqual(s2InteractionDocumentSnapshot(portable.config.definition, portable.config.document).interaction, originalRules, 'Restoring the original graph restores its live rules');
  assert.deepEqual(importS2WorkspaceWithPack(exportS2Workspace(withoutSource, removedSource, reference)).definition.interaction, withoutSource.interaction);
  assert.deepEqual(importS2WorkspaceWithPack(exportS2Workspace(withoutTarget, removedTarget, reference)).definition.interaction, withoutTarget.interaction);

  const dedup = setup([trigger('Once')]); const first = dedup.router.newCause();
  dedup.router.publish('s2.node.succeeded', 'Worker', {}, first, 'SameCompletion');
  dedup.router.publish('s2.node.succeeded', 'Worker', {}, first, 'SameCompletion');
  dedup.router.publish('s2.node.succeeded', 'Worker', {}, first, 'DuplicateNotification'); await tick();
  assert.equal(dedup.calls.length, 1, 'One trigger fires once for one causal chain');
  const next = dedup.router.newCause(); assert.notEqual(next.id, first.id);
  dedup.router.publish('s2.node.succeeded', 'Worker', {}, next, 'NextUserCompletion'); await tick(); assert.equal(dedup.calls.length, 2);
  dedup.router.publish('s2.node.succeeded', 'Worker', {}, { id: 'DifferentCause', chain: ['Once'] }, 'RecursiveCompletion'); await tick();
  assert.equal(dedup.calls.length, 2, 'A trigger already in the causal chain cannot recursively call itself');

  const bound = setup([trigger('Bound')]); const owner = bound.router.newCause();
  const unbind = bound.router.bindCause(['Worker'], owner); const newer = bound.router.newCause();
  bound.router.publish('s2.node.succeeded', 'Worker', {}); await tick(); assert.equal(bound.calls[0].event.causeId, owner.id);
  const conflicting = bound.router.bindCause(['Worker'], newer);
  assert.throws(() => bound.router.publish('s2.node.succeeded', 'Worker', {}), /同时属于多个/);
  conflicting(); unbind();
  bound.router.publish('s2.node.succeeded', 'Worker', {}); await tick(); assert.equal(bound.calls[1].event.causeId, newer.id);

  const queued = setup([trigger('Queued')]); queued.busy(true);
  queued.router.publish('s2.node.succeeded', 'Worker', {}); await tick(); assert.equal(queued.calls.length, 0, 'Busy waits without adding a model call');
  queued.busy(false); await queued.router.flush(); assert.equal(queued.calls.length, 1);
  queued.busy(true); queued.router.newCause(); queued.router.publish('s2.node.succeeded', 'Worker', {}); queued.revise();
  queued.busy(false); await queued.router.flush(); assert.equal(queued.calls.length, 1, 'A queued old revision is discarded');
  queued.busy(true); queued.router.newCause(); queued.router.publish('s2.node.succeeded', 'Worker', {});
  queued.router.close(); queued.busy(false); await queued.router.flush();
  queued.router.publish('s2.node.succeeded', 'Worker', {}); assert.equal(queued.calls.length, 1, 'Closing retires queued and late events');
  const inactive = setup([trigger('Inactive')]); inactive.current(false);
  inactive.router.publish('s2.node.succeeded', 'Worker', {}); await inactive.router.flush(); assert.equal(inactive.calls.length, 0);

  const cancelled = setup([trigger('Cancelled')]); cancelled.busy(true);
  const cancelledCause = cancelled.router.newCause();
  cancelled.router.publish('s2.node.succeeded', 'Worker', {}, cancelledCause, 'QueuedBeforeCancel'); await tick();
  assert.equal(cancelled.calls.length, 0);
  cancelled.router.cancelCause(cancelledCause.id); cancelled.busy(false); await cancelled.router.flush();
  assert.equal(cancelled.calls.length, 0, 'Cancelling a cause drops its queued automatic jobs');
  cancelled.router.publish('s2.node.succeeded', 'Worker', {}, cancelledCause, 'LateAfterCancel');
  cancelled.router.publish('s2.node.succeeded', 'Worker', {}); await tick();
  assert.equal(cancelled.calls.length, 0, 'Late explicit and current cancelled causes cannot trigger a new model callback');
  const freshCause = cancelled.router.newCause();
  cancelled.router.publish('s2.node.succeeded', 'Worker', {}, freshCause, 'FreshUserCause'); await tick();
  assert.equal(cancelled.calls.length, 1); assert.equal(cancelled.calls[0].event.causeId, freshCause.id);

  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const serial = setup([trigger('One'), trigger('Two')], async task => { if (task.trigger.id === 'One') await gate; });
  serial.router.publish('s2.node.succeeded', 'Worker', {}); await tick(); assert.equal(serial.calls.length, 1, 'Automatic jobs are serial');
  release(); await tick(); assert.deepEqual(serial.calls.map(call => call.trigger.id), ['One', 'Two']);
  const recover = setup([trigger('Error'), trigger('AfterError')], async task => { if (task.trigger.id === 'Error') throw new Error('synthetic event task failure'); });
  recover.router.publish('s2.node.succeeded', 'Worker', {}); await tick();
  assert.equal(recover.errors.length, 1); assert.deepEqual(recover.calls.map(call => call.trigger.id), ['Error', 'AfterError']);

  const host = {}, otherHost = {}, packageEvents: unknown[] = [];
  bindS2PackageInteractionEvents(host, (nodeId, event, data) => packageEvents.push({ nodeId, event, data }));
  emitS2PackageInteractionEvent(host, 'Note', 'interaction-events.ready', { message: '业务事件' });
  assert.deepEqual(packageEvents, [{ nodeId: 'Note', event: 'interaction-events.ready', data: { message: '业务事件' } }]);
  assert.throws(() => emitS2PackageInteractionEvent(otherHost, 'Note', 'interaction-events.ready', { message: '未绑定' }), /接收器/);
  closeS2PackageInteractionEvents(host);
  assert.throws(() => emitS2PackageInteractionEvent(host, 'Note', 'interaction-events.ready', { message: '会话结束' }), /接收器/);
  assert.equal(runtimeCalls, 0);
  console.log('S2 interaction events passed: independent public sources, declared custom schemas, builtin success/failure, zero unconfigured calls, causal dedup/cycle prevention/new user causes, bound-source ownership, serial busy queue, cancelled queued/late cause rejection with fresh-cause recovery, stale revision/current/close rejection, workspace roundtrip/pruning, empty scope and package sink lifetime. No runtime/model/network/user data.');
} finally { routers.forEach(router => router.close()); globalThis.fetch = previousFetch; }
