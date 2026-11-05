import assert from 'node:assert/strict';
import type { SceneInteractionPackDefinition } from '../src/types/sceneInteractionPack';
import type { S2PluginManifest } from '../src/types/sceneS2Plugin';
import { readSceneInteractionPack } from '../src/services/scene/sceneInteractionPackProtocol';
import { sceneInteractionPacks } from '../src/services/scene/sceneInteractionPacks';
import { installSceneInteractionCapabilities } from '../src/services/scene/sceneS2PluginRegistry';
import { compileS2PublicCanvas, type S2PublicCanvas } from '../src/services/scene/sceneS2PublicAuthoring';
import { interactS2PublicScene, type S2InteractionOptions } from '../src/services/scene/sceneS2Interaction';
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { bindS2ArtifactContext, readS2ContextOutputIds, createS2AssessmentArtifactScope, resolveS2AssessmentOutput } from '../src/services/scene/sceneS2ArtifactAccess';

globalThis.fetch = async () => assert.fail('Interaction inspection forbids network and actual models');
const secretMarkers = ['PRIVATE_BODY', 'PRIVATE_PARAM', 'PRIVATE_OUTPUT', 'InternalNode', 'private-interaction-tools', 'privateEcho'];
const plugin: S2PluginManifest = { protocolVersion: 1, id: 'private-interaction-tools', version: '1.0.0', label: 'PRIVATE_BODY', meaning: 'PRIVATE_BODY',
  dependencies: [{ id: 'core', version: '1.0.0' }], dataTypes: [], capabilities: [{ id: 'privateEcho', kind: 'transform', meaning: 'PRIVATE_BODY',
    inputs: ['text', 'secret', 'setting'].map(id => ({ id, label: id, meaning: id === 'secret' ? 'PRIVATE_PARAM' : '输入文字', type: { id: 'core.text', version: 1 }, required: id === 'text', multiple: false })),
    outputs: ['text', 'privateText', 'many'].map(id => ({ id, label: id, meaning: id === 'privateText' ? 'PRIVATE_OUTPUT' : '输出文字', type: { id: 'core.text', version: 1 }, required: true, multiple: id === 'many' })),
    effect: 'pure', permissions: [], confirmation: 'none', retry: 'manual-only', timeoutMs: 1000 }] };
const blockType = { id: 'text', label: '文字', fields: [
  { id: 'content', label: '内容', kind: 'multiline' as const }, { id: 'secret', label: '内部字段', kind: 'multiline' as const },
] };
const raw: SceneInteractionPackDefinition = { manifest: { protocolVersion: 1, id: 'interaction-agent-fixture', version: '1.0.0', name: '独立交互检查', paradigm: 'S2', paradigmApiVersion: 1, requiredServices: ['execution'] },
  capabilities: [plugin], authoring: { version: 1, components: [
    ...['note', 'future'].map(id => ({ id, label: id === 'note' ? '当前文字' : '未来组件', purpose: '填写一份原文', implementation: { kind: 'content' as const, blockType },
      inputs: [], outputs: ['content'], parameters: ['content'], defaults: { content: '', secret: 'PRIVATE_PARAM' } })),
    { id: 'echo', label: '回声处理', purpose: '处理所连原文', implementation: { kind: 'capability', pluginId: plugin.id, pluginVersion: plugin.version, capabilityId: 'privateEcho' },
      inputs: ['text'], outputs: ['text', 'many'], parameters: ['setting'], defaults: { setting: '原始参数', secret: 'PRIVATE_PARAM' } },
  ], internal: { blockTypes: [blockType], document: { nodes: [{ id: 'InternalNode', type: 'text', position: { x: -100, y: -100 }, values: { content: 'PRIVATE_BODY', secret: 'PRIVATE_PARAM' } }], edges: [] } } },
  describe: () => ({ purpose: 'PUBLIC_GUIDE', components: [], combinations: [], operations: [], builder: { assemble: '使用公开组件', repair: '根据公开错误修复' },
    assistant: { instructions: '保留原文，按本轮目标协作。', defaultAllowedOperations: [] } }),
  validate: () => [], createRuntime: () => assert.fail('The interaction model never starts a runtime'), executeLocal: async () => assert.fail('The interaction model never executes package code'),
};
const pack = readSceneInteractionPack(raw); installSceneInteractionCapabilities(pack); sceneInteractionPacks.register(pack);
const canvas: S2PublicCanvas = { version: 1, nodes: [
  { id: 'SourceA', componentId: 'note', label: '我的内容', position: { x: 0, y: 0 }, values: { content: '原文 $& {{literal}}' } },
  { id: 'Echo', componentId: 'echo', label: '处理', position: { x: 320, y: 0 } },
  { id: 'SourceB', componentId: 'note', label: '另一份内容', position: { x: 0, y: 240 }, values: { content: '另一份原文' } },
], connections: [{ source: { nodeId: 'SourceA', portId: 'content' }, target: { nodeId: 'Echo', portId: 'text' } }] };
const config = compileS2PublicCanvas(pack, canvas, { goal: '按需处理原文', instructions: { understanding: '理解当前表达', planning: '按需协作', response: '报告真实信息' } });
const scope = { actions: ['reply', 'edit', 'execute'] as ('reply' | 'edit' | 'execute')[] };
const editingPack = { ...pack, execution: 'none' as const };
let editingCalls = 0;
const editOnlyReply = await interactS2PublicScene({ pack: editingPack, ...config, task: '添加一个文字节点', origin: 'user', scope,
  call: async (system, input) => {
    editingCalls++; assert.deepEqual((input.scope as any).actions, ['reply', 'edit']);
    assert.equal((input.context as any).execution, 'none'); assert(!system.includes('run{targetNodeIds}'));
    return { actions: [{ type: 'addNode', node: { id: 'NewDraft', componentId: 'future', position: { x: 0, y: 400 } } }] };
  } });
assert.equal(editingCalls, 1); assert.equal(editOnlyReply.actions![0].type, 'addNode');
assert.deepEqual(scope.actions, ['reply', 'edit', 'execute'], 'Package policy must not mutate caller scope');
let forbiddenCalls = 0;
await interactS2PublicScene({ pack: editingPack, ...config, task: '删除另一份内容', origin: 'user', scope,
  call: async (_system, input) => {
    if (++forbiddenCalls === 1) return { actions: [{ type: 'removeNode', nodeId: 'SourceB' }, { type: 'run', targetNodeIds: ['Echo'] }] };
    assert.equal((input.context as any).repair.issue.code, 'PACK_EXECUTION_DISABLED');
    return { reply: '已按编辑要求处理。', actions: [{ type: 'removeNode', nodeId: 'SourceB' }] };
  } });
assert.equal(forbiddenCalls, 2); assert(config.document.nodes.some(node => node.id === 'SourceB'), 'Preflight never partially applies edits before rejecting appended execution');
let syntaxCalls = 0;
const disconnectedReply = await interactS2PublicScene({ pack: editingPack, ...config, task: '只断开这条连线', origin: 'user', scope,
  call: async (system, input) => {
    syntaxCalls++;
    if (syntaxCalls === 1) return { actions: [{ type: 'removeConnection', source: { nodeId: 'SourceA', portId: 'content' }, target: { nodeId: 'Echo', portId: 'text' } }] };
    if (syntaxCalls === 2) {
      assert((input.context as any).repair.syntax.includes('系统提示'));
      assert((input.context as any).repair.syntax.includes('context.actionGuide'));
      assert(system.includes('disconnect{connection:'), 'Action repair points to the currently usable system grammar without repeating every action');
      assert(!(input.context as any).repair.syntax.includes('disconnect{'));
      assert.equal((input.context as any).components, undefined, 'Grammar repair cannot disclose or unlock unread component fields');
      return { read: { componentIds: ['note', 'echo'] } };
    }
    return { actions: [{ type: 'disconnect', connection: { source: { nodeId: 'SourceA', portId: 'content' }, target: { nodeId: 'Echo', portId: 'text' } } }] };
  } });
assert.equal(syntaxCalls, 3); assert.equal(disconnectedReply.actions![0].type, 'disconnect');
let directDisconnectCalls = 0;
await interactS2PublicScene({ pack: editingPack, ...config, task: '只断开当前连线', origin: 'user', scope,
  call: async () => { directDisconnectCalls++; return { actions: [{ type: 'disconnect', connection: {
    source: { nodeId: 'SourceA', portId: 'content' }, target: { nodeId: 'Echo', portId: 'text' },
  } }] }; } });
assert.equal(directDisconnectCalls, 1, 'Removing a known public connection needs no field read or execution');
let boundedRepairCalls = 0;
await interactS2PublicScene({ pack: editingPack, ...config, task: '修改文字', origin: 'user', scope,
  call: async (_system, input) => {
    boundedRepairCalls++;
    if (boundedRepairCalls <= 2) return { read: { interfaces: [{ componentId: 'note', parameters: ['content'] }] } };
    if (boundedRepairCalls === 3) return { actions: [{ type: 'setParameter', nodeId: 'SourceA', parameterId: 'content', value: '新内容' }] };
    assert((input.context as any).repair.syntax.includes('context.actionGuide'));
    assert((input.context as any).actionGuide.includes('setValues{'), 'The already-read editable grammar remains available during syntax repair');
    assert(!(input.context as any).repair.syntax.includes('setValues{'));
    return { actions: [{ type: 'setValues', nodeId: 'SourceA', values: { content: '新内容' } }] };
  } });
assert.equal(boundedRepairCalls, 4, 'A duplicate-read reminder and one action-format repair share the original four-call ceiling');
await assert.rejects(() => interactS2PublicScene({ pack: editingPack, ...config, task: '断开不存在的连接', origin: 'user', scope,
  call: async () => ({ actions: [{ type: 'disconnect', connection: { source: { nodeId: 'SourceB', portId: 'content' }, target: { nodeId: 'Echo', portId: 'text' } } }] }) }), /不存在/);
const base: Omit<S2InteractionOptions, 'call'> = { pack, definition: config.definition, document: config.document, task: '解释当前画布', origin: 'user', scope,
  history: [{ role: 'user', content: '请保留原文。' }, { role: 'assistant', content: '会依据当前画布协作。' }] };
const publicOnly = (value: unknown) => { const text = JSON.stringify(value); for (const marker of secretMarkers) assert(!text.includes(marker), marker);
  for (const key of ['pluginCatalog', 'blockTypes', 'implementation', 'pluginId', 'capabilityId', 'remainingCalls', 'requestId', 'causeId', 'revision']) assert(!text.includes(`"${key}"`), key); };
const before = JSON.stringify({ definition: config.definition, document: config.document, authoring: pack.authoring });
let normalChars = 0;
let calls = 0;
const reply = await interactS2PublicScene({ ...base, call: async (system, input, maxTokens) => {
  calls++; publicOnly(input); assert.equal(maxTokens, 4096);
  assert.deepEqual(Object.keys(input).sort(), ['context', 'origin', 'scope', 'task']);
  const context = input.context as any;
  assert.equal(context.actionGuide, undefined);
  assert(!system.includes('setValues{nodeId'), 'Editing action grammar is disclosed with editable interfaces, not in the first system prompt');
  assert(!/\bconnect\{connection/.test(system), 'New-wire grammar is not resident in the first system prompt');
  assert.equal(context.components, undefined);
  assert.equal(context.componentRules, undefined);
  assert.equal(context.packageInstructions, undefined);
  assert.equal(context.packagePurpose, 'PUBLIC_GUIDE');
  assert.deepEqual(context.componentIndex.map((component: any) => component.id), ['note', 'future', 'echo']);
  for (const component of context.componentIndex) assert.deepEqual(Object.keys(component).sort(), ['id', 'label', 'purpose']);
  assert.equal(context.canvas.representation, 'public-index');
  assert(context.canvas.nodes.every((node: any) => !Object.hasOwn(node, 'values')));
  assert(!JSON.stringify(input).includes('原文 $& {{literal}}'));
  assert(!JSON.stringify(input).includes('另一份原文'));
  normalChars = system.length + JSON.stringify(input).length;
  return JSON.stringify({ reply: '这是两份文字与一项公开处理。' });
} });
assert.equal(calls, 1); assert.equal(reply.reply, '这是两份文字与一项公开处理。');
assert.equal(JSON.stringify({ definition: config.definition, document: config.document, authoring: pack.authoring }), before);

// The terminal advertises only methods useful within the real scope and
// current public data. The same protocol validators continue to enforce it.
for (const mode of ['reply', 'edit', 'execute', 'single-content', 'empty-scope'] as const) {
  const scoped = mode === 'reply' ? { actions: ['reply'] as ('reply' | 'edit' | 'execute')[] }
    : mode === 'edit' ? { actions: ['reply', 'edit'] as ('reply' | 'edit' | 'execute')[] }
      : mode === 'execute' ? { actions: ['reply', 'execute'] as ('reply' | 'edit' | 'execute')[] }
        : { actions: ['reply', 'edit', 'execute'] as ('reply' | 'edit' | 'execute')[], nodeIds: mode === 'empty-scope' ? [] : ['SourceA'] };
  await interactS2PublicScene({ ...base, scope: scoped, call: async (system, input) => {
    assert(!system.includes('resultIds:'), 'No result-read syntax without a real scoped result index');
    assert(!system.includes('eventData'), 'No event-payload syntax in a user message');
    assert(!system.includes('cancel{'), 'No cancellation syntax without a current scoped execution');
    assert(!system.includes('componentIds:'), 'Whole-component reads are not taught before member discovery');
    assert(!system.includes('nodeIds:'), 'First value reads select the necessary parameters');
    if (mode === 'reply' || mode === 'empty-scope') {
      assert(!system.includes('actions?:'), 'No actions output key without a useful allowed action');
      for (const name of ['addNode', 'removeNode', 'disconnect', 'run', 'cancel']) assert(!system.includes(`${name}{`), `${mode}: ${name}`);
    }
    if (mode === 'edit') { assert(system.includes('actions?:')); assert(!system.includes('run{')); }
    if (mode === 'execute') {
      assert(system.includes('run{'));
      for (const name of ['addNode', 'removeNode', 'disconnect']) assert(!system.includes(`${name}{`), `${mode}: ${name}`);
    }
    if (mode === 'single-content') {
      assert(!system.includes('addNode{'), 'A node-limited task cannot create a new node');
      assert(system.includes('removeNode{'), 'An existing in-scope public node can still be removed');
      assert(!system.includes('disconnect{'), 'A wire with an out-of-scope endpoint is not advertised');
      assert(!system.includes('run{'), 'A content-only scope has no current executable target');
    }
    if (mode === 'empty-scope') assert(!system.includes('values:'), 'No value-read syntax when no public instances are in scope');
    assert.deepEqual(input.scope, scoped); return { reply: '只按本轮范围响应。' };
  } });
}
for (const mode of ['reply-edit', 'edit-run'] as const) {
  let scopedCalls = 0;
  await interactS2PublicScene({ ...base, scope: { actions: mode === 'reply-edit' ? ['reply'] : ['reply', 'edit'] },
    call: async (_system, input) => {
      if (++scopedCalls === 1) return { actions: mode === 'reply-edit'
        ? [{ type: 'removeNode', nodeId: 'SourceA' }] : [{ type: 'run', targetNodeIds: ['Echo'] }] };
      assert.equal((input.context as any).repair.issue.code, 'INTERACTION_SCOPE', 'Omitted syntax does not replace the local permission guard');
      return { reply: '本地拒绝越过本轮权限。' };
    } });
  assert.equal(scopedCalls, 2);
}

// A new turn must observe the live document, not its saved baseline, stale labels
// or an assistant's earlier description. Body disclosure must preserve that fact.
const manual = structuredClone(config.document);
manual.nodes.find(node => node.id === 'SourceA')!.values.content = '手动更新后的正文';
manual.execution!.links = [];
delete manual.execution!.nodes.find(node => node.id === 'Echo')!.bindings.text;
let observationCalls = 0;
await interactS2PublicScene({ ...base, document: manual,
  history: [{ role: 'assistant', content: 'SourceA 仍是原文，已经连接处理节点。' }],
  task: '解释当前结构，只检查不修改', call: async (_system, input) => {
    observationCalls++; publicOnly(input); const context = input.context as any;
    assert.equal(context.goal, config.definition.goal);
    assert.deepEqual(context.canvas.connections, []);
    assert.equal(context.canvas.nodes.find((node: any) => node.id === 'SourceA').label, '我的内容');
    assert.equal(context.executions, undefined); assert.equal(context.results, undefined);
    if (observationCalls === 1) {
      assert(!JSON.stringify(input).includes('手动更新后的正文'));
      return { read: { values: [{ nodeId: 'SourceA', parameterIds: ['content'] }] } };
    }
    assert.deepEqual(context.recalled.values, [{ nodeId: 'SourceA', parameterId: 'content', value: '手动更新后的正文' }]);
    return { reply: '当前是手动更新后的正文，尚无到处理节点的连线；没有提供运行或保存记录。', actions: [] };
  } });
assert.equal(observationCalls, 2);
assert.equal(manual.nodes.find(node => node.id === 'SourceA')!.values.content, '手动更新后的正文');
assert.equal(config.document.nodes.find(node => node.id === 'SourceA')!.values.content, '原文 $& {{literal}}');

// The same single call supports event tasks; causal/revision IDs stay local.
calls = 0;
await interactS2PublicScene({ ...base, origin: 'event', task: '解释本次处理结果', scope: { actions: ['reply'], nodeIds: ['Echo'] },
  event: { type: 's2.node.succeeded', nodeId: 'Echo', data: { resultIds: ['PRIVATE_OUTPUT'] }, id: 'LOCAL_EVENT', causeId: 'LOCAL_CAUSE', revision: 99 } as any,
  call: async (_system, input) => { calls++; publicOnly(input); const context = input.context as any;
    assert.equal(input.origin, 'event'); assert.deepEqual(Object.keys(context.event).sort(), ['data', 'nodeId', 'type']);
    assert.deepEqual(context.event.data.resultIds, []); assert.equal(context.canvas.nodes.length, 1); return { reply: '尚未提供完整结果。' }; } });
assert.equal(calls, 1);

// A trigger source may differ from its action scope; it gains no extra data access.
let feedbackCalls = 0;
await interactS2PublicScene({ ...base, origin: 'event', task: '更新指定反馈块', scope: { actions: ['reply', 'edit'], nodeIds: ['SourceB'] },
  event: { type: 's2.node.succeeded', nodeId: 'Echo', data: { resultIds: [] } }, call: async (_system, input) => {
    publicOnly(input); const context = input.context as any;
    assert.equal(context.event.nodeId, 'Echo'); assert.equal(context.canvas.nodes[0].id, 'SourceB'); assert(context.eventInputs.unavailable);
    if (++feedbackCalls === 1) return { read: { interfaces: [{ componentId: 'note', parameters: ['content'] }] } };
    assert.equal(context.interfaces[0].componentId, 'note'); assert.equal(context.components, undefined);
    return { actions: [{ type: 'setValues', nodeId: 'SourceB', values: { content: '反馈' } }] };
  } });
assert.equal(feedbackCalls, 2);

// A newly requested component is disclosed once, then usable by public ID.
calls = 0;
const added = await interactS2PublicScene({ ...base, task: '添加未来组件', call: async (_system, input) => {
  calls++; publicOnly(input); const context = input.context as any;
  if (calls === 1) return { read: { componentIds: ['future'] } };
  assert(context.components.some((component: any) => component.id === 'future'));
  return { actions: [{ type: 'addNode', node: { id: 'FutureNode', componentId: 'future', position: { x: 640, y: 0 }, values: { content: '新增原文' } } }] };
} });
assert.equal(calls, 2); assert.equal(added.actions![0].type, 'addNode');
assert.equal(config.document.nodes.some(node => node.id === 'FutureNode'), false, 'The model engine returns a validated proposal without committing it');

const contentOnly = compileS2PublicCanvas(pack, { version: 1, nodes: [canvas.nodes[0]], connections: [] }, { goal: config.definition.goal });
let newExecutionCalls = 0;
const addedExecution = await interactS2PublicScene({ ...base, ...contentOnly, task: '添加处理器，接入来源并执行。', call: async (system) => {
  if (++newExecutionCalls === 1) {
    assert(!system.includes('run{'), 'A content-only current canvas has no execution target before a needed public executable type is read');
    return { read: { componentIds: ['note', 'echo'] } };
  }
  assert(system.includes('run{'), 'A disclosed public executable type can be added and invoked in one validated batch');
  return { actions: [
    { type: 'addNode', node: { id: 'NewEcho', componentId: 'echo', position: { x: 320, y: 0 } } },
    { type: 'connect', connection: { source: { nodeId: 'SourceA', portId: 'content' }, target: { nodeId: 'NewEcho', portId: 'text' } } },
    { type: 'run', targetNodeIds: ['NewEcho'] },
  ] };
} });
assert.equal(newExecutionCalls, 2); assert.deepEqual(addedExecution.actions!.map(action => action.type), ['addNode', 'connect', 'run']);

const largeCanvas = structuredClone(canvas);
largeCanvas.nodes[0].values!.content = '甲'.repeat(6000); largeCanvas.nodes[2].values!.content = '乙'.repeat(6000);
const large = compileS2PublicCanvas(pack, largeCanvas, { goal: config.definition.goal });
calls = 0;
await interactS2PublicScene({ ...base, ...large, call: async (_system, input) => {
  calls++; publicOnly(input); const context = input.context as any;
  if (calls === 1) { assert.equal(context.canvas.representation, 'public-index'); assert(!JSON.stringify(input).includes('甲'.repeat(6000))); return { read: { nodeIds: ['SourceA'] } }; }
  assert.equal(context.recalled.nodeDetails[0].values.content, '甲'.repeat(6000)); return { reply: '已依据完整原文解释。' };
} });
assert.equal(calls, 2);

for (const invalid of ['syntax', 'native-command', 'wrong-value', 'scope', 'private-read'] as const) {
  calls = 0;
  await interactS2PublicScene({ ...base, ...(invalid === 'scope' || invalid === 'private-read' ? { scope: { actions: ['reply', 'edit'] as ('reply' | 'edit')[], nodeIds: ['SourceA'] } } : {}),
    call: async (_system, input) => {
      calls++; publicOnly(input);
      const needsDetails = invalid === 'wrong-value' || invalid === 'scope';
      if (needsDetails && calls === 1) return { read: { componentIds: ['note'] } };
      if (calls === (needsDetails ? 3 : 2)) { assert((input.context as any).repair); return { reply: '已按公开范围回应，未修改画布。' }; }
      if (invalid === 'syntax') return '{"reply":';
      if (invalid === 'native-command') return { commands: [{ pluginId: 'PRIVATE_BODY' }] };
      if (invalid === 'wrong-value') return { actions: [{ type: 'setValues', nodeId: 'SourceA', values: { content: 3 } }] };
      if (invalid === 'scope') return { actions: [{ type: 'setValues', nodeId: 'SourceB', values: { content: '不可越界' } }] };
      return { read: { nodeIds: ['InternalNode'] } };
    } });
  assert.equal(calls, invalid === 'wrong-value' || invalid === 'scope' ? 3 : 2, invalid);
}
calls = 0;
await assert.rejects(() => interactS2PublicScene({ ...base, call: async () => { calls++; return { read: { nodeIds: ['SourceA'] } }; } }),
  (error: any) => error.code === 'INTERACTION_READ_NO_PROGRESS');
assert.equal(calls, 3, 'One repeated read gets the existing bounded response repair; repeating again stops without extending the four-call ceiling');
calls = 0;
await interactS2PublicScene({ ...base, call: async (_system, input) => {
  calls++; publicOnly(input);
  if (calls === 1) return { read: { nodeIds: ['SourceA'], componentIds: ['note'] } };
  if (calls === 2) return { actions: [{ type: 'setValues', nodeId: 'SourceA', values: { content: 3 } }] };
  assert((input.context as any).repair); assert((input.context as any).recalled);
  return { reply: '补读后已按原文回应。' };
} });
assert.equal(calls, 3, 'One read plus one structural repair preserve the original task and remain bounded');
calls = 0;
await assert.rejects(() => interactS2PublicScene({ ...base, call: async () => { calls++; throw new Error('provider unavailable'); } }), /provider unavailable/);
assert.equal(calls, 1, 'Transport failures do not trigger paid model repairs');
const abort = new AbortController();
await assert.rejects(() => interactS2PublicScene({ ...base, signal: abort.signal, call: async () => { abort.abort(); return { reply: 'late' }; } }), /停止|abort/i);

// A real host provides output provenance; private outputs and a forged JSON
// port mapping cannot promote an inaccessible body into a public result.
let executionNumber = 0;
let shouldFail = false;
const host = new S2PluginHost('public-interaction-results', config.definition, async call => { executionNumber++;
  if (shouldFail) return { status: 'failed', error: { code: 'PRIVATE_BODY', message: 'PRIVATE_OUTPUT' }, outputs: {} };
  return { status: 'succeeded', outputs: Object.fromEntries(['text', 'privateText', 'many'].map(portId => [portId, Array.from({ length: portId === 'many' ? 2 : 1 }, () => ({
  protocolVersion: 1, id: `artifact-${crypto.randomUUID()}`, type: { id: 'core.text', version: 1 }, complete: true,
  source: { sceneId: call.sceneId, runId: call.runId, nodeId: call.nodeId, revision: call.revision, kind: 'plugin', invocationId: call.id },
  payload: { kind: 'inline', value: portId === 'privateText' ? 'PRIVATE_OUTPUT' : `完整的公开结果${executionNumber}` },
}))])) }; });
try {
  host.setDocument(config.document);
  const job = host.enqueueWorkflow(['Echo']); assert.equal((await job.completion).status, 'succeeded');
  const hostContext = host.prepare('Echo', { goal: config.definition.goal, ...config.definition.instructions }, '解释结果');
  const actualText = hostContext.outputIndex.find(output => output.nodeId === 'Echo' && output.portId === 'text')!.artifactIds[0];
  const secretText = hostContext.outputIndex.find(output => output.nodeId === 'Echo' && output.portId === 'privateText')!.artifactIds[0];
  const manyIds = hostContext.outputIndex.find(output => output.nodeId === 'Echo' && output.portId === 'many')!.artifactIds;
  assert.equal(manyIds.length, 2); assert.deepEqual(readS2ContextOutputIds(hostContext, 'Echo', 'many'), manyIds);
  assert.equal(resolveS2AssessmentOutput(createS2AssessmentArtifactScope(hostContext, manyIds), 'Echo', 'many'), undefined, 'The existing single-output assessment contract stays unchanged');
  calls = 0;
  await interactS2PublicScene({ ...base, pluginContext: hostContext, call: async (_system, input) => {
    calls++; publicOnly(input); const context = input.context as any;
    assert(context.results.some((result: any) => result.resultId === actualText));
    for (const id of manyIds) assert(context.results.some((result: any) => result.resultId === id));
    assert(!JSON.stringify(input).includes(secretText));
    if (calls === 1) {
      assert.equal(context.resultDetails, undefined); assert(!JSON.stringify(input).includes('完整的公开结果1'));
      return { read: { resultIds: [actualText] } };
    }
    assert.equal(context.recalled.resultDetails[0].text, '完整的公开结果1');
    assert.deepEqual(context.recalled.resultDetails.map((body: any) => body.resultId), [actualText]);
    return { reply: '依据真实公开结果解释。' };
  } });
  assert.equal(calls, 2);

  // Completion can be delivered after another run at the same revision. Use
  // the original invocation, inputs and output, never the newest output index.
  const firstInvocation = hostContext.artifactCatalog.find(item => item.id === actualText)!.source.invocationId!;
  const secondJob = host.enqueueWorkflow(['Echo'], undefined, { force: true }); assert.equal((await secondJob.completion).status, 'succeeded');
  const delayedContext = host.prepare('Echo', { goal: config.definition.goal, ...config.definition.instructions }, '解释旧事件');
  for (const localIdentity of [false, true]) {
    let delayedCalls = 0;
    await interactS2PublicScene({ ...base, origin: 'event', scope: { actions: ['reply'], nodeIds: ['Echo'] },
    pluginContext: delayedContext, event: { type: 's2.node.succeeded', nodeId: 'Echo', data: { resultIds: [actualText, secretText] } },
    ...(localIdentity ? { eventInvocationId: firstInvocation } : {}), call: async (_system, input) => {
      publicOnly(input); const context = input.context as any;
      assert.deepEqual(context.event.data.resultIds, [actualText]);
      if (++delayedCalls === 1) {
        assert.equal(context.resultDetails, undefined); assert(!JSON.stringify(input).includes('完整的公开结果1'));
        assert(!JSON.stringify(input).includes('原文 $& {{literal}}'));
        const originalInput = context.results.find((item: any) => item.direction === 'input' && item.portId === 'text').resultId;
        return { read: { resultIds: [actualText, originalInput] } };
      }
      assert.equal(context.recalled.resultDetails.find((body: any) => body.resultId === actualText).text, '完整的公开结果1');
      assert.equal(context.recalled.resultDetails.find((body: any) => body.resultId !== actualText).text, '原文 $& {{literal}}');
      assert(!JSON.stringify(input).includes('完整的公开结果2')); assert(!JSON.stringify(input).includes(firstInvocation));
      return { reply: '依据该次实际输入和结果解释。' };
    } });
    assert.equal(delayedCalls, 2);
  }
  await interactS2PublicScene({ ...base, origin: 'event', scope: { actions: ['reply'], nodeIds: ['Echo'] }, pluginContext: delayedContext,
    event: { type: 's2.node.failed', nodeId: 'Echo', data: { resultIds: [] } }, call: async (system, input) => {
      const context = input.context as any; assert(context.eventInputs.unavailable); assert.equal(context.results, undefined);
      assert(!system.includes('resultIds:'), 'An event without real trial records cannot teach result reads');
      return { reply: '缺少该次实际输入，不能推测失败原因。' };
    } });

  // Cancellation addresses are useful only where the same scope may execute.
  const executionContext = { ...delayedContext, executionRuns: [
    { id: 'VisibleRun', revision: delayedContext.frame.revision, publication: 'current', status: 'running', targets: ['Echo'] },
    { id: 'HiddenRun', revision: delayedContext.frame.revision, publication: 'current', status: 'running', targets: ['InternalNode'] },
    { id: 'MixedRun', revision: delayedContext.frame.revision, publication: 'current', status: 'waiting', targets: ['Echo', 'SourceA'] },
    { id: 'StaleRun', revision: delayedContext.frame.revision, publication: 'stale', status: 'running', targets: ['Echo'] },
  ] } as unknown as NonNullable<S2InteractionOptions['pluginContext']>;
  for (const execute of [false, true]) await interactS2PublicScene({ ...base, scope: { actions: execute ? ['reply', 'execute'] : ['reply'], nodeIds: ['Echo'] },
    pluginContext: executionContext, call: async (system, input) => {
      publicOnly(input); const context = input.context as any;
      assert.deepEqual(context.executions, execute ? [{ runId: 'VisibleRun', status: 'running', targetNodeIds: ['Echo'] }] : undefined);
      assert.equal(system.includes('cancel{'), execute, 'Cancellation syntax follows the actual scoped active-run index');
      assert.equal(system.includes('run{'), execute, 'Execution syntax requires execution scope and a public executable target');
      return { reply: '按公开执行状态回应。' };
    } });

  // A failed invocation has no output artifact, but its exact public inputs
  // and public parameters remain available via local invocation identity.
  shouldFail = true;
  const failedJob = host.enqueueWorkflow(['Echo'], undefined, { force: true }), failedRun = await failedJob.completion;
  assert.equal(failedRun.status, 'failed'); const failedInvocation = failedRun.nodes.find(node => node.nodeId === 'Echo')!.invocationId!;
  const failedContext = host.prepare('Echo', { goal: config.definition.goal, ...config.definition.instructions }, '解释失败事件');
  let failureCalls = 0;
  await interactS2PublicScene({ ...base, origin: 'event', scope: { actions: ['reply'], nodeIds: ['Echo'] }, pluginContext: failedContext,
    eventInvocationId: failedInvocation, event: { type: 's2.node.failed', nodeId: 'Echo', data: { resultIds: [], error: 'PRIVATE_BODY' } },
    call: async (system, input) => {
      publicOnly(input); const context = input.context as any;
      assert.equal(context.eventExecution.status, 'failed'); assert(context.eventExecution.error.unavailable);
      assert.equal(context.resultDetails, undefined); assert(context.results.every((item: any) => item.direction === 'input'));
      if (++failureCalls === 1) {
        assert(system.includes('resultIds:'), 'A failed execution with only real public input records still offers the needed result selector');
        assert(!JSON.stringify(input).includes('原文 $& {{literal}}')); assert(!JSON.stringify(input).includes('原始参数'));
        return { read: { resultIds: context.results.filter((item: any) => ['text', 'setting'].includes(item.portId)).map((item: any) => item.resultId) } };
      }
      assert.equal(context.recalled.resultDetails.find((body: any) => body.portId === 'text').text, '原文 $& {{literal}}');
      assert.equal(context.recalled.resultDetails.find((body: any) => body.portId === 'setting').text, '原始参数');
      return { reply: '保留真实输入；没有公开的具体诊断，不能断定原因。' };
    } });
  assert.equal(failureCalls, 2);
  hostContext.outputIndex.find(output => output.portId === 'text')!.artifactIds = [secretText];
  await interactS2PublicScene({ ...base, pluginContext: hostContext, call: async (_system, input) => {
    publicOnly(input); assert(!((input.context as any).results ?? []).some((result: any) => result.portId === 'text')); return { reply: '没有被伪造端口指向的可用结果。' };
  } });
} finally { host.close(); }

// A large output remains unavailable as a whole, never a misleading prefix.
const resultId = 'artifact-LargePublicResult';
const fakeContext = { outputIndex: [{ nodeId: 'Echo', portId: 'text', type: { id: 'core.text', version: 1 }, artifactIds: [resultId], state: 'available' }],
  artifactCatalog: [{ id: resultId, type: { id: 'core.text', version: 1 }, source: { nodeId: 'Echo' } }] } as unknown as NonNullable<S2InteractionOptions['pluginContext']>;
bindS2ArtifactContext(fakeContext, { output: () => [resultId], read: () => ({ protocolVersion: 1, id: resultId,
  type: { id: 'core.text', version: 1 }, source: { sceneId: 's', runId: 'r', nodeId: 'Echo', revision: 0, kind: 'host' }, complete: true,
  payload: { kind: 'inline', value: 'Z'.repeat(13000) } }) });
calls = 0;
await interactS2PublicScene({ ...base, pluginContext: fakeContext, call: async (_system, input) => {
  calls++; const context = input.context as any;
  if (calls === 1) { assert.equal(context.resultDetails, undefined); return { read: { resultIds: [resultId] } }; }
  assert.equal(context.recalled.resultDetails[0].unavailable, true); assert(!JSON.stringify(input).includes('Z'.repeat(100))); return { reply: '完整结果超出本轮读取额度。' };
} });
assert.equal(calls, 2);

// Source-level measurement: the same public five-block arrangement used by the
// previous inspection, now one call with no native runtime catalogue/manual.
const prompt = sceneInteractionPacks.resolve({ id: 'prompt-lab', version: '0.1.0' });
const promptCanvas: S2PublicCanvas = { version: 1, nodes: [
  { id: 'Prompt', componentId: 'content', position: { x: 0, y: 0 }, values: { content: '把资料归纳成三个要点。' } },
  { id: 'Compose', componentId: 'compose', position: { x: 320, y: 0 } },
  { id: 'Test', componentId: 'model-test', position: { x: 640, y: 0 } },
  { id: 'Result', componentId: 'result', position: { x: 960, y: 0 } },
  { id: 'Material', componentId: 'material-text', position: { x: 320, y: 260 }, values: { content: '' } },
], connections: [
  { source: { nodeId: 'Prompt', portId: 'content' }, target: { nodeId: 'Compose', portId: 'part1' } },
  { source: { nodeId: 'Compose', portId: 'text' }, target: { nodeId: 'Test', portId: 'prompt' } },
  { source: { nodeId: 'Material', portId: 'content' }, target: { nodeId: 'Test', portId: 'input' } },
  { source: { nodeId: 'Test', portId: 'text' }, target: { nodeId: 'Result', portId: 'text' } },
] };
const promptConfig = compileS2PublicCanvas(prompt, promptCanvas, { goal: '理解提示词测试场景' });
let promptChars = 0, promptCalls = 0, promptSystemChars = 0, promptInputChars = 0;
await interactS2PublicScene({ pack: prompt, ...promptConfig, task: '解释当前画布', origin: 'user', scope,
  history: base.history, call: async (system, input) => { promptCalls++; promptSystemChars += system.length; promptInputChars += JSON.stringify(input).length;
    promptChars += system.length + JSON.stringify(input).length;
    assert(!JSON.stringify(input).includes('"pluginCatalog"')); assert(!JSON.stringify(input).includes('"pluginId"')); return { reply: '这是一条提示词测试链路。' }; } });
assert.equal(promptCalls, 1);
assert(promptSystemChars <= 700, `Same five-block first system prompt must stay within its explicit test budget: ${promptSystemChars} chars; keep field constraints in selective disclosure rather than adding resident manuals`);
assert(promptChars < 3000, `Same five-block first call: system=${promptSystemChars}, input=${promptInputChars}, total=${promptChars}`);
console.log(JSON.stringify({ passed: true, checks: 'body-free index-only one-call user/event, exact on-demand fields before public editing, bounded reads and repair, immutable state, real multiple-output provenance, selectively recalled delayed event identity and failed event input/parameters, scoped cancellation index, no private graph/diagnostic, no truncated bodies, cancel/transport guards',
  measurement: { units: 'JavaScript UTF-16 characters, not tokens; model-engine call boundary', genericNormalChars: normalChars,
    promptFiveBlockCalls: promptCalls, promptFiveBlockSystemChars: promptSystemChars, promptFiveBlockInputChars: promptInputChars, promptFiveBlockChars: promptChars,
    previousSameFiveBlockFixture: { systemChars: 840, inputChars: 6058, totalChars: 6898 },
    note: 'The normal explanation uses the same five nodes, four connections, task, scope and two brief history messages as the prior 840/6058 measurement; this is an offline input-size comparison, not real-model quality or a claim about every request.' },
  actualModelCalls: 0, networkCalls: 0, sourceCommits: 0 }, null, 2));
