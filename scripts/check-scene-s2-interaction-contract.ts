import assert from 'node:assert/strict';
import type { S2Document } from '../src/types/sceneS2';
import { readSceneInteractionPack } from '../src/services/scene/sceneInteractionPackProtocol';
import {
  readS2InteractionActions, readS2InteractionConfig, readS2InteractionResponse, readS2InteractionScope, readS2PackInteraction,
  S2_BUILTIN_INTERACTION_EVENTS, S2_INTERACTION_LIMITS, snapshotS2InteractionData, validateS2InteractionEventData,
  validateS2InteractionReferences,
} from '../src/services/scene/sceneS2InteractionProtocol';

globalThis.fetch = async () => assert.fail('Interaction contracts never read networks, models or user resources');
const document: S2Document = { nodes: [{ id: 'Note', type: 'text', position: { x: 0, y: 0 }, values: { content: '原文' } }], edges: [],
  execution: { version: 1, nodes: [{ id: 'Test', pluginId: 'generic-tools', pluginVersion: '1.0.0', capabilityId: 'test', position: { x: 100, y: 0 }, bindings: {} }], links: [] } };
const trigger = () => ({ id: 'explain', on: { event: 's2.node.succeeded', nodeId: 'Test' }, task: '解释本次真实结果' });
const config = readS2InteractionConfig({ version: 1, triggers: [trigger()] }, document);
assert.deepEqual(config, { version: 1, triggers: [trigger()] });
assert.deepEqual(readS2InteractionScope(config.triggers[0].scope), { actions: ['reply'] });
assert.deepEqual(readS2InteractionScope({ nodeIds: [] }), { nodeIds: [], actions: ['reply'] });
assert.deepEqual(readS2InteractionScope({ actions: ['reply', 'edit', 'execute'], nodeIds: ['Note', 'Test'] }), { actions: ['reply', 'edit', 'execute'], nodeIds: ['Note', 'Test'] });
const references = { publicNodeIds: ['Note', 'Test'], executionNodeIds: ['Test'] };
validateS2InteractionReferences(config, references);
for (const invalid of [
  { version: 2, triggers: [] }, { version: 1, triggers: [trigger(), trigger()] },
  { version: 1, triggers: [{ ...trigger(), task: '' }] },
  { version: 1, triggers: [{ ...trigger(), on: { event: 's2.node.succeeded', nodeId: 'Note' } }] },
  { version: 1, triggers: [{ ...trigger(), on: { event: 's2.node.succeeded', nodeId: 'Missing' } }] },
  { version: 1, triggers: [{ ...trigger(), scope: { nodeIds: ['Missing'] } }] },
  { version: 1, triggers: [{ ...trigger(), script: 'execute()' }] },
  { version: 1, triggers: Array.from({ length: 17 }, (_, i) => ({ ...trigger(), id: `Trigger${i}` })) },
]) assert.throws(() => readS2InteractionConfig(invalid, document));
for (const invalid of [{ actions: [] }, { actions: ['reply', 'reply'] }, { actions: ['admin'] }, { nodeIds: ['Test', 'Test'] }, { permissions: ['model-call'] }])
  assert.throws(() => readS2InteractionScope(invalid));
assert.throws(() => validateS2InteractionReferences(config, { ...references, publicNodeIds: ['Note'] }));
assert.throws(() => validateS2InteractionReferences(readS2InteractionConfig({ version: 1, triggers: [{ ...trigger(), on: { event: 'other-package.ready', nodeId: 'Test' } }] }), references));
assert.throws(() => validateS2InteractionReferences(readS2InteractionConfig({ version: 1, triggers: [{ ...trigger(), scope: { nodeIds: ['Private'] } }] }), references));

const events = readS2PackInteraction({ version: 1, events: [{ id: 'contract-events.ready', purpose: '公开业务事件',
  dataSchema: { kind: 'object', fields: { amount: { kind: 'number', integer: true, minimum: 0, maximum: 9 } }, required: ['amount'] } }] }, 'contract-events');
assert.deepEqual(validateS2InteractionEventData(events.events[0], { amount: 0 }), { amount: 0 });
for (const data of [{ amount: 0.5 }, { amount: 10 }, {}, { amount: 1, authority: true }, { amount: '1' }])
  assert.throws(() => validateS2InteractionEventData(events.events[0], data), /INTERACTION_EVENT_DATA/);
const builtIn = S2_BUILTIN_INTERACTION_EVENTS[0];
assert.deepEqual(validateS2InteractionEventData(builtIn, { resultIds: ['actual-result-id'] }), { resultIds: ['actual-result-id'] });
assert.throws(() => validateS2InteractionEventData(builtIn, { resultIds: [], nodeId: 'ForgedSource' }));
for (const invalid of [
  { version: 1, events: [{ ...events.events[0], id: 'other-package.ready' }] },
  { version: 1, events: [{ ...events.events[0], id: 's2.node.succeeded' }] },
  { version: 1, events: [events.events[0], events.events[0]] },
  { version: 1, events: [{ ...events.events[0], dataSchema: { kind: 'anything' } }] },
  { version: 1, events: [{ ...events.events[0], run: 'javascript' }] },
]) assert.throws(() => readS2PackInteraction(invalid, 'contract-events'));
validateS2InteractionReferences(readS2InteractionConfig({ version: 1, triggers: [{ ...trigger(), on: { event: events.events[0].id, nodeId: 'Note' } }] }), { ...references, eventIds: events.events.map(event => event.id) });

const node = { id: 'New', componentId: 'note', position: { x: 0, y: 0 }, values: { content: '文字 $& {{literal}}', enabled: false, amount: 0, raw: null } };
const connection = { source: { nodeId: 'New', portId: 'content' }, target: { nodeId: 'Test', portId: 'prompt' } };
const response = { reply: '已知事实与本地执行意图', actions: [
  { type: 'addNode', node }, { type: 'setValues', nodeId: 'New', values: { content: '新的原文' } },
  { type: 'connect', connection }, { type: 'disconnect', connection },
  { type: 'run', targetNodeIds: ['Test'] }, { type: 'cancel', runId: 'actual-run-id' }, { type: 'removeNode', nodeId: 'New' },
] };
assert.deepEqual(readS2InteractionResponse(response), response);
assert.deepEqual(readS2InteractionActions([]), [], 'A local no-op action preparation remains valid');
assert.deepEqual(readS2InteractionActions(response.actions), response.actions);
assert.deepEqual(readS2InteractionResponse({ reply: '只解释' }), { reply: '只解释' });
assert.deepEqual(readS2InteractionResponse({ read: { nodeIds: ['Note'], componentIds: ['note'], resultIds: ['result:opaque-id'] } }), { read: { nodeIds: ['Note'], componentIds: ['note'], resultIds: ['result:opaque-id'] } });
assert.deepEqual(readS2InteractionResponse({ read: { packageInstructions: true } }), { read: { packageInstructions: true } });
assert.deepEqual(readS2InteractionResponse({ read: { componentIds: ['note'], packageInstructions: true } }), { read: { componentIds: ['note'], packageInstructions: true } });
assert.deepEqual(readS2InteractionResponse({ read: { nodeIds: [], packageInstructions: true } }), { read: { nodeIds: [], packageInstructions: true } });
const targeted = { interfaces: [{ componentId: 'note', parameters: ['content'], inputs: [], outputs: ['content'] },
  { componentId: 'test', parameters: ['temperature', 'maxOutputTokens'], inputs: ['prompt'] }], packageInstructions: true };
assert.deepEqual(readS2InteractionResponse({ read: targeted }), { read: targeted }, 'Partial interfaces preserve exact public field and port identities');
assert.deepEqual(readS2InteractionResponse({ read: { interfaces: [{ componentId: 'note', parameters: ['content'] }], componentIds: ['other'] } }),
  { read: { interfaces: [{ componentId: 'note', parameters: ['content'] }], componentIds: ['other'] } });
assert.deepEqual(readS2InteractionResponse({ read: { interfaces: [{ componentId: 'note' }] } }), { read: { interfaces: [{ componentId: 'note' }] } }, 'An overview reads only the public field/port index');
assert.deepEqual(readS2InteractionResponse({ read: { values: [{ nodeId: 'Note', parameterIds: ['content'] }] } }), { read: { values: [{ nodeId: 'Note', parameterIds: ['content'] }] } });
assert.deepEqual(readS2InteractionResponse({ read: { values: [{ nodeId: 'Note', parameterIds: ['content'] }], nodeIds: ['Test'], eventData: true } }),
  { read: { values: [{ nodeId: 'Note', parameterIds: ['content'] }], nodeIds: ['Test'], eventData: true } });
assert.deepEqual(readS2InteractionResponse({ read: { eventData: true } }), { read: { eventData: true } });
assert.deepEqual(readS2InteractionResponse({ read: { values: [], interfaces: [], eventData: true } }), { read: { values: [], interfaces: [], eventData: true } });
assert.deepEqual(readS2InteractionResponse({ read: { interfaces: Array.from({ length: 8 }, (_, index) => ({ componentId: `Component${index}`, outputs: ['text'] })) } }).read?.interfaces?.length, 8);
assert.equal(S2_INTERACTION_LIMITS.readInterfaceFields, 16);
assert.equal(S2_INTERACTION_LIMITS.readChars, 12000, 'Every complete disclosed body shares the terminal read budget');
assert.equal(S2_INTERACTION_LIMITS.readBatches, 2); assert.equal(S2_INTERACTION_LIMITS.modelCalls, 4); assert.equal(S2_INTERACTION_LIMITS.readTotalChars, 24000);
for (const invalid of [
  {}, { reply: '' }, { reply: 'x'.repeat(6001) }, { reply: 'text', authority: true },
  { read: {} }, { read: { nodeIds: [] } }, { read: { nodeIds: ['Note'] }, actions: [] },
  { read: { packageInstructions: false } }, { read: { packageInstructions: 'true' } }, { read: { packageInstructions: 1 } },
  { read: { packageInstructions: null } }, { read: { packageInstructions: true, guide: true } },
  { read: { nodeIds: ['Note'], packageInstructions: false } }, { read: { packageInstructions: true }, actions: [] },
  { read: { nodeIds: Array.from({ length: 5 }, (_, index) => `Node${index}`) } },
  { read: { componentIds: Array.from({ length: 9 }, (_, index) => `Component${index}`), packageInstructions: true } },
  { read: { resultIds: ['a', 'b', 'c', 'd'] } },
  { read: { interfaces: [] } },
  { read: { interfaces: [{ componentId: 'note', parameters: [], inputs: [], outputs: [] }] } },
  { read: { interfaces: [{ parameters: ['content'] }] } },
  { read: { interfaces: [{ componentId: 'note', fields: ['content'] }] } },
  { read: { interfaces: [{ componentId: 'note', parameters: ['content', 'content'] }] } },
  { read: { interfaces: [{ componentId: 'note', inputs: ['constructor'] }] } },
  { read: { interfaces: [{ componentId: 'note', outputs: ['invalid.port'] }] } },
  { read: { interfaces: [{ componentId: 'invalid.component', parameters: ['content'] }] } },
  { read: { interfaces: [{ componentId: 'note', parameters: 'content' }] } },
  { read: { interfaces: [{ componentId: 'note', outputs: Array.from({ length: 17 }, (_, index) => `Field${index}`) }] } },
  { read: { interfaces: [{ componentId: 'note', parameters: ['content'] }, { componentId: 'note', outputs: ['content'] }] } },
  { read: { interfaces: [{ componentId: 'note', parameters: ['content'] }], componentIds: ['note'] } },
  { read: { interfaces: Array.from({ length: 9 }, (_, index) => ({ componentId: `Component${index}`, parameters: ['content'] })) } },
  { read: { interfaces: [{ componentId: 'note', parameters: ['content'] }], componentIds: Array.from({ length: 8 }, (_, index) => `Component${index}`) } },
  { read: { interfaces: [{ componentId: 'note', parameters: ['content'] }] }, actions: [] },
  { read: { values: [] } }, { read: { values: [{ nodeId: 'Note' }] } }, { read: { values: [{ parameterIds: ['content'] }] } },
  { read: { values: [{ nodeId: 'Note', parameterIds: [] }] } }, { read: { values: [{ nodeId: 'Note', parameterIds: 'content' }] } },
  { read: { values: [{ nodeId: 'Note', parameterIds: ['content', 'content'] }] } },
  { read: { values: [{ nodeId: 'Note', parameterIds: ['constructor'] }] } },
  { read: { values: [{ nodeId: 'Note', parameterIds: ['content'], inputs: ['content'] }] } },
  { read: { values: [{ nodeId: 'Note', parameterIds: ['content'] }, { nodeId: 'Note', parameterIds: ['count'] }] } },
  { read: { values: [{ nodeId: 'Note', parameterIds: ['content'] }], nodeIds: ['Note'] } },
  { read: { values: Array.from({ length: 5 }, (_, index) => ({ nodeId: `Node${index}`, parameterIds: ['content'] })) } },
  { read: { values: [{ nodeId: 'Note', parameterIds: Array.from({ length: 17 }, (_, index) => `Field${index}`) }] } },
  { read: { values: [{ nodeId: 'Note', parameterIds: ['content'] }], nodeIds: Array.from({ length: 4 }, (_, index) => `Node${index}`) } },
  { read: { eventData: false } }, { read: { eventData: 'true' } }, { read: { eventData: 1 } }, { read: { eventData: null } },
  { read: { eventData: true, payload: true } }, { read: { eventData: true }, actions: [] },
  { actions: [{ type: 'setValues', nodeId: 'Note', values: {}, pluginId: 'private' }] },
  { actions: [{ type: 'run', targetNodeIds: [] }] }, { actions: [{ type: 'run', targetNodeIds: ['Test', 'Test'] }] },
  { actions: Array.from({ length: 13 }, () => ({ type: 'run', targetNodeIds: ['Test'] })) },
  { actions: [{ type: 'arbitraryDispatch', operation: 'private' }] },
  { actions: [{ type: 'addNode', node: { ...node, position: { x: 100001, y: 0 } } }] },
  { actions: [{ type: 'connect', connection: { ...connection, permission: true } }] },
]) assert.throws(() => readS2InteractionResponse(invalid));
const unchanged = JSON.stringify(response), parsed = readS2InteractionResponse(response);
assert.equal(JSON.stringify(response), unchanged);
(parsed.actions![0] as any).node.values.content = '仅修改副本';
assert.equal(node.values.content, '文字 $& {{literal}}');

let getters = 0;
for (const hostile of [
  Object.defineProperty({}, 'reply', { enumerable: true, get() { getters++; return 'unsafe'; } }),
  { actions: new Array(1) }, { actions: Object.assign([], { extra: true }) },
  Object.assign(Object.create({ inherited: true }), { reply: 'text' }),
  { reply: undefined }, { actions: [{ type: 'setValues', nodeId: 'Note', values: { amount: Infinity } }] },
  { read: { interfaces: new Array(1) } },
  { read: { values: new Array(1) } },
  { read: { interfaces: [Object.defineProperty({ componentId: 'note' }, 'parameters', { enumerable: true, get() { getters++; return ['content']; } })] } },
  { read: { values: [Object.defineProperty({ nodeId: 'Note' }, 'parameterIds', { enumerable: true, get() { getters++; return ['content']; } })] } },
]) assert.throws(() => readS2InteractionResponse(hostile));
const cyclic: any = {}; cyclic.value = cyclic;
assert.throws(() => snapshotS2InteractionData(cyclic));
assert.throws(() => snapshotS2InteractionData({ toJSON() { getters++; return {}; } }));
assert.equal(getters, 0);
assert.throws(() => snapshotS2InteractionData({ text: '字'.repeat(100) }, 100));

let executions = 0;
const base = { manifest: { protocolVersion: 1, id: 'contract-events', version: '1.0.0', name: '通用事件契约', paradigm: 'S2', paradigmApiVersion: 1, requiredServices: ['execution'] },
  capabilities: [], authoring: { version: 1, components: [] }, validate: () => [],
  createRuntime: () => { executions++; return assert.fail('Contract loading never creates runtimes'); },
  executeLocal: async () => { executions++; return assert.fail('Contract loading never executes components'); } };
const legacy = readSceneInteractionPack(base);
assert.equal(legacy.interaction, undefined, 'Packages without interaction keep the existing shape');
const checked = readSceneInteractionPack({ ...base, interaction: events });
assert.deepEqual(checked.interaction, events);
assert.deepEqual(checked.authoring?.components, [], 'Declared events require the public interface, not a nonempty public directory');
const { authoring: _authoring, ...legacyBase } = base;
const legacyDescription = { purpose: '旧版说明', components: [], combinations: [], operations: [], builder: { assemble: '按旧接口搭建', repair: '按旧接口修复' }, assistant: { instructions: '按当前目标协作', defaultAllowedOperations: [] } };
assert.equal(readSceneInteractionPack({ ...legacyBase, describe: () => legacyDescription }).interaction, undefined);
assert.deepEqual(readSceneInteractionPack({ ...legacyBase, describe: () => legacyDescription, interaction: { version: 1, events: [] } }).interaction, { version: 1, events: [] });
assert.throws(() => readSceneInteractionPack({ ...legacyBase, describe: () => legacyDescription, interaction: events }), /PACK_INTERACTION_AUTHORING/);
assert.throws(() => readSceneInteractionPack({ ...base, interaction: { ...events, run: 'injected' } }));
assert.throws(() => readSceneInteractionPack({ ...base, interaction: { version: 1, events: [{ ...events.events[0], id: 'other.ready' }] } }));
assert.equal(executions, 0);
console.log('S2 interaction contract passed: strict scoped scene triggers, namespaced bounded package events, all seven public actions, reply/read exclusivity, field/port overview and targeted selectors, exact instance-value selections, combined component/node limits, true-only guide/event reads, two-batch/four-call shared disclosure budgets, inert data guards, declared event payloads, references and unchanged optional legacy package loading. No model/network/user data.');
