import assert from 'node:assert/strict';
import type { SceneInteractionPackDefinition } from '../src/types/sceneInteractionPack';
import type { S2BlockType } from '../src/types/sceneS2';
import type { S2PluginManifest, S2ValueSchema } from '../src/types/sceneS2Plugin';
import { readSceneInteractionPack } from '../src/services/scene/sceneInteractionPackProtocol';
import { sceneInteractionPacks } from '../src/services/scene/sceneInteractionPacks';
import { installSceneInteractionCapabilities } from '../src/services/scene/sceneS2PluginRegistry';
import { compileS2PublicCanvas, projectS2PublicCanvas, publicS2Catalog } from '../src/services/scene/sceneS2PublicAuthoring';
import { projectS2AgentComponents, S2_AGENT_COMPONENT_RULES } from '../src/services/scene/sceneS2AgentCatalog';
import { interactS2PublicScene, type S2InteractionOptions } from '../src/services/scene/sceneS2Interaction';
import { bindS2ArtifactContext } from '../src/services/scene/sceneS2ArtifactAccess';

// Deliberately independent of prompt-lab. The terminal must preserve a package's
// complete public constraints while postponing their model disclosure.
const previousFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('Progressive interaction checks prohibit network and real providers');
const native: S2BlockType = { id: 'controls', label: '原生字段', fields: [
  { id: 'content', label: '文字', kind: 'text', required: true, maxLength: 4 },
  { id: 'count', label: '次数', kind: 'number', min: 0, max: 2, integer: true },
  { id: 'enabled', label: '启用', kind: 'boolean', defaultValue: false },
  { id: 'items', label: '有界列表', kind: 'list', minItems: 1, maxItems: 2,
    item: { id: 'item', label: '子项', kind: 'number', min: 0, max: 2, integer: true } },
  { id: 'form', label: '闭合表单', kind: 'form', fields: [
    { id: 'name', label: '名称', kind: 'text', required: true, maxLength: 3 },
    { id: 'mode', label: '选项', kind: 'enum', options: ['a', 'b'] },
  ] },
  { id: 'rows', label: '记录', kind: 'table', minItems: 1, maxItems: 2, columns: [
    { id: 'name', label: '名称', type: 'string', required: true },
    { id: 'score', label: '分数', type: 'number', nullable: true },
  ] },
  { id: 'json', label: '结构化值', kind: 'json', defaultValue: null },
] };
const schemas: Record<string, S2ValueSchema> = {
  amount: { kind: 'number', integer: true, minimum: 0, maximum: 20 },
  mode: { kind: 'string', maxLength: 8, enum: ['alpha', 'beta'] },
  enabled: { kind: 'boolean' },
  raw: { kind: 'json', maxDepth: 3, maxEntries: 20, maxBytes: 100 },
  tags: { kind: 'array', maxItems: 2, item: { kind: 'string', maxLength: 4 } },
  record: { kind: 'object', fields: { name: { kind: 'string', maxLength: 4 }, active: { kind: 'boolean' } }, required: ['name'] },
};
const plugin: S2PluginManifest = { protocolVersion: 1, id: 'progressive-interaction-tools', version: '1.0.0', label: '参数与端口', meaning: '仅验证公开配置', dependencies: [{ id: 'core', version: '1.0.0' }],
  dataTypes: Object.entries(schemas).map(([id, schema]) => ({ id: `progressive-interaction-tools.${id}`, version: 1, meaning: `${id} 的精确单位与意义`, schema })),
  capabilities: [{ id: 'configure', kind: 'transform', meaning: '公开参数与数据入口', effect: 'pure', permissions: [], confirmation: 'none', retry: 'manual-only', timeoutMs: 1000,
    inputs: [
      { id: 'text', label: '原文', meaning: '接收完整原文', type: { id: 'core.text', version: 1 }, required: true, multiple: false },
      ...Object.keys(schemas).map(id => ({ id, label: id, meaning: `${id} 的用途`, type: { id: `progressive-interaction-tools.${id}`, version: 1 }, required: false, multiple: false })),
    ], outputs: [{ id: 'text', label: '文字输出', meaning: '输出完整文字', type: { id: 'core.text', version: 1 }, required: true, multiple: false }] }],
};
const giant: S2BlockType = { id: 'giant', label: '完整大接口', fields: Array.from({ length: 4 }, (_, index) => ({ id: `choice${index}`, label: `选项${index}`, kind: 'enum' as const,
  options: Array.from({ length: 32 }, (_, choice) => `${index}-${choice}-` + 'x'.repeat(115 - String(choice).length)) })) };
const text: S2BlockType = { id: 'text', label: '长原文', fields: [{ id: 'content', label: '完整内容', kind: 'multiline', maxLength: 6000 }] };
const packageInstructions = '业务说明原文：仅按本轮目标使用公开接口，保持全部原文。';
function actionGuide(context: any, expected: 'none' | 'parameters' | 'ports' | 'both', allowAdd = true) {
  if (expected === 'none') { assert.equal(context.actionGuide, undefined, 'No editing grammar is sent before an editable interface is read'); return; }
  assert.equal(typeof context.actionGuide, 'string');
  const parameters = expected === 'parameters' || expected === 'both', ports = expected === 'ports' || expected === 'both';
  assert.equal(context.actionGuide.includes('setValues{'), parameters, 'Parameter grammar appears only for successfully read editable parameters');
  assert.equal(context.actionGuide.includes('addNode{'), parameters && allowAdd, 'Configured creation uses read parameter rules only when the scope permits creating nodes');
  assert.equal(context.actionGuide.includes('connect{'), ports, 'New-wire grammar appears only when public port rules have been read');
  assert(!context.actionGuide.includes('disconnect{'), 'Removing an existing connection needs no new-port schema guide');
}
const raw: SceneInteractionPackDefinition = {
  manifest: { protocolVersion: 1, id: 'progressive-interaction-fixture', version: '1.0.0', name: '通用渐进披露', paradigm: 'S2', paradigmApiVersion: 1, requiredServices: ['execution'] }, capabilities: [plugin],
  interaction: { version: 1, events: [{ id: 'progressive-interaction-fixture.ready', purpose: '按需读取业务事件资料',
    dataSchema: { kind: 'object', fields: { summary: { kind: 'string', maxLength: 4000 } }, required: ['summary'] } }] },
  authoring: { version: 1, components: [
    ...[native, text, giant].map(blockType => ({ id: blockType.id, label: blockType.label, purpose: '按声明参数编辑本组件', implementation: { kind: 'content' as const, blockType },
      inputs: [], outputs: blockType.id === 'text' || blockType.id === 'controls' ? ['content'] : [], parameters: blockType.fields.map(field => field.id),
      ...(blockType.id === 'controls' ? { defaults: { content: '', count: 0, enabled: false, json: null } } : {}) })),
    { id: 'configure', label: '处理组件', purpose: '按精确类型连接文字并调整公开参数', implementation: { kind: 'capability', pluginId: plugin.id, pluginVersion: plugin.version, capabilityId: 'configure' },
      inputs: ['text'], outputs: ['text'], parameters: Object.keys(schemas), defaults: { amount: 0, enabled: false, raw: null } },
  ], internal: { blockTypes: [], document: { nodes: [], edges: [], execution: { version: 1, nodes: [
    { id: 'PrivateWorker', pluginId: plugin.id, pluginVersion: plugin.version, capabilityId: 'configure', position: { x: -400, y: 0 }, bindings: { text: { kind: 'literal', value: 'PRIVATE_IMPLEMENTATION' } } },
  ], links: [] } } } },
  describe: () => ({ purpose: '通用渐进披露用例', components: [], combinations: [], operations: [], builder: { assemble: '使用公开目录', repair: '根据公开规则修正' }, assistant: { instructions: packageInstructions, defaultAllowedOperations: [] } }),
  validate: () => [], createRuntime: () => assert.fail('Inspection cannot create a runtime'), executeLocal: async () => assert.fail('Inspection cannot execute a component'),
};

try {
  const pack = readSceneInteractionPack(raw); installSceneInteractionCapabilities(pack); sceneInteractionPacks.register(pack);
  const config = compileS2PublicCanvas(pack, { version: 1, nodes: [
    { id: 'Native', componentId: 'controls', position: { x: 0, y: 0 } },
    { id: 'Source', componentId: 'text', position: { x: 0, y: 300 }, values: { content: '原文' } },
    { id: 'Target', componentId: 'configure', position: { x: 360, y: 0 } },
    { id: 'Giant', componentId: 'giant', position: { x: 0, y: 600 } },
  ], connections: [] }, { goal: '保持公开可编辑字段及全部限制' });
  const baseline = JSON.stringify({ definition: config.definition, document: config.document, authoring: pack.authoring });
  const expected = new Map(projectS2AgentComponents(publicS2Catalog(pack)!.components).map(component => [component.id, component]));
  const task = '按照公开限制填写字段并连接来源。';
  const history = [{ role: 'user' as const, content: '保留原文与零值。' }];
  const scope = { actions: ['reply', 'edit', 'execute'] as ('reply' | 'edit' | 'execute')[] };
  const options: Omit<S2InteractionOptions, 'call'> = { pack, ...config, task, scope, history, origin: 'user' };
  const contexts: any[] = [];
  let calls = 0;
  await interactS2PublicScene({ ...options, call: async (_system, input) => {
    calls++; const context = input.context as any; contexts.push(context);
    assert.equal(input.task, task); assert.deepEqual(input.scope, scope); assert.deepEqual(context.recentMessages, history);
    assert(!JSON.stringify(input).includes('PRIVATE_IMPLEMENTATION')); assert(!JSON.stringify(input).includes('PrivateWorker'));
    if (calls === 1) {
      actionGuide(context, 'none');
      assert.equal(context.components, undefined); assert.equal(context.componentRules, undefined); assert.equal(context.packageInstructions, undefined);
      assert.equal(context.packagePurpose, '通用渐进披露用例');
      assert.deepEqual(context.componentIndex.map((component: any) => component.id), ['controls', 'text', 'giant', 'configure']);
      for (const component of context.componentIndex) assert.deepEqual(Object.keys(component).sort(), ['id', 'label', 'purpose']);
      return { read: { componentIds: ['controls', 'configure'], packageInstructions: true } };
    }
    assert.deepEqual(context.components, ['controls', 'configure'].map(id => expected.get(id)), 'Selected details retain every public editable field and restriction');
    actionGuide(context, 'both');
    assert.equal(context.componentRules, S2_AGENT_COMPONENT_RULES); assert.equal(context.packageInstructions, packageInstructions);
    const nativeDetail = context.components[0], capabilityDetail = context.components[1];
    assert.deepEqual(nativeDetail.inputs, []); assert(nativeDetail.parameters.some((parameter: any) => parameter.id === 'content'));
    const parameter = (component: any, id: string) => component.parameters.find((entry: any) => entry.id === id);
    assert.equal(parameter(nativeDetail, 'content').default, ''); assert.equal(parameter(nativeDetail, 'count').default, 0);
    assert.equal(parameter(nativeDetail, 'enabled').default, false); assert.equal(parameter(nativeDetail, 'json').default, null);
    assert.deepEqual(parameter(nativeDetail, 'content').field, { kind: 'text', required: true, maxLength: 4, serializedMaxLength: 6000 });
    assert.equal(parameter(nativeDetail, 'content').allowBlank, true);
    assert.equal(parameter(nativeDetail, 'items').field.item.max, 2);
    assert.equal(parameter(nativeDetail, 'form').field.additionalProperties, false);
    assert.equal(parameter(nativeDetail, 'rows').field.columns[1].nullable, true);
    assert.equal(parameter(nativeDetail, 'rows').field.cellMaxBytes, 2000);
    assert.deepEqual(parameter(nativeDetail, 'json').field.structured, { maxDepth: 8, maxEntries: 2048, maxBytes: 24000 });
    for (const [id, schema] of Object.entries(schemas)) assert.deepEqual(parameter(capabilityDetail, id).schema, schema);
    assert.equal(parameter(capabilityDetail, 'amount').default, 0); assert.equal(parameter(capabilityDetail, 'enabled').default, false); assert.equal(parameter(capabilityDetail, 'raw').default, null);
    assert.equal(capabilityDetail.inputs[0].type, 'core.text@1'); assert.equal(capabilityDetail.inputs[0].required, true); assert.equal(capabilityDetail.inputs[0].multiple, false);
    return { actions: [{ type: 'setValues', nodeId: 'Native', values: { content: 'four', count: 0, enabled: false, json: null } },
      { type: 'setValues', nodeId: 'Target', values: { amount: 20, mode: 'beta', raw: null, tags: ['four'], record: { name: 'four', active: false } } }] };
  } });
  assert.equal(calls, 2);

  // Reply-only readers still receive the complete selected constraints, but no
  // editing grammar. Prose is never a replacement for the local scope guard.
  for (const read of [
    { interfaces: [{ componentId: 'configure', parameters: ['amount'] }] },
    { interfaces: [{ componentId: 'configure', inputs: ['text'], outputs: ['text'] }] },
    { componentIds: ['controls', 'configure'] },
  ]) {
    calls = 0;
    await interactS2PublicScene({ ...options, scope: { actions: ['reply'] }, call: async (system, input) => {
      calls++; const context = input.context as any; actionGuide(context, 'none');
      assert(!system.includes('actions?:'), 'Read-only analysis is not taught an actions output key');
      for (const name of ['addNode', 'removeNode', 'disconnect', 'run', 'cancel']) assert(!system.includes(`${name}{`));
      if (calls === 1) return { read };
      assert(context.components || context.interfaces, 'Read-only analysis still receives the requested complete interface data');
      return { reply: '只依据所读完整规则解释。' };
    } }); assert.equal(calls, 2);
  }

  // Neither indices, node/value/result bodies nor package prose disclose action
  // grammar, even when editing is allowed for a different possible request.
  const guideResultId = 'artifact-GuideOnlyResult';
  const guideResultContext = { outputIndex: [{ nodeId: 'Source', portId: 'content', type: { id: 'core.text', version: 1 }, artifactIds: [guideResultId], state: 'available' }],
    artifactCatalog: [{ id: guideResultId, type: { id: 'core.text', version: 1 }, source: { nodeId: 'Source' } }] } as unknown as NonNullable<S2InteractionOptions['pluginContext']>;
  bindS2ArtifactContext(guideResultContext, { output: () => [guideResultId], read: () => ({ protocolVersion: 1, id: guideResultId,
    type: { id: 'core.text', version: 1 }, source: { sceneId: 'fixture', runId: 'fixture', nodeId: 'Source', revision: 0, kind: 'host' }, complete: true,
    payload: { kind: 'inline', value: '只读结果正文' } }) });
  for (const read of [
    { interfaces: [{ componentId: 'configure' }] }, { nodeIds: ['Native'] },
    { values: [{ nodeId: 'Native', parameterIds: ['count'] }] }, { packageInstructions: true }, { resultIds: [guideResultId] },
  ]) {
    calls = 0;
    await interactS2PublicScene({ ...options, pluginContext: guideResultContext, call: async (system, input) => {
      calls++; actionGuide(input.context, 'none');
      if ('resultIds' in read) assert.equal(system.includes('resultIds:'), calls === 1, 'A result read disappears after its only real body has been provided');
      if ('packageInstructions' in read) assert.equal(system.includes('packageInstructions'), calls === 1, 'A supplied package guide is not offered for another read');
      if (calls === 1) return { read };
      return { reply: '此次只读取所需索引或正文，不涉及字段编辑接口。' };
    } }); assert.equal(calls, 2);
  }

  // Counts are enforced by the terminal even though the compact system prompt
  // no longer teaches its implementation quotas to the model on every turn.
  calls = 0;
  await interactS2PublicScene({ ...options, call: async (_system, input) => {
    calls++;
    if (calls === 1) return { read: { interfaces: [{ componentId: 'configure', parameters: ['amount'] }] } };
    if (calls === 2) return { actions: Array.from({ length: 13 }, () => ({ type: 'setValues', nodeId: 'Target', values: { amount: 0 } })) };
    assert.equal((input.context as any).repair.issue.code, 'INTERACTION_LIMIT');
    assert.match((input.context as any).repair.issue.reason, /12/, 'The concrete local limit is disclosed only when the response exceeds it');
    return { reply: '本地动作额度仍生效，未执行超额操作。' };
  } }); assert.equal(calls, 3);
  const nineTargets = Array.from({ length: 9 }, (_, index) => `Worker${index}`);
  const runQuotaConfig = compileS2PublicCanvas(pack, { version: 1, nodes: [
    { id: 'QuotaSource', componentId: 'text', position: { x: 0, y: 0 }, values: { content: '来源' } },
    ...nineTargets.map((id, index) => ({ id, componentId: 'configure', position: { x: 300, y: index * 120 } })),
  ], connections: nineTargets.map(id => ({ source: { nodeId: 'QuotaSource', portId: 'content' }, target: { nodeId: id, portId: 'text' } })) }, { goal: '验证目标限额仍由本地执行' });
  calls = 0;
  await interactS2PublicScene({ ...options, ...runQuotaConfig, call: async (_system, input) => {
    calls++; if (calls === 1) return { actions: [{ type: 'run', targetNodeIds: nineTargets }] };
    assert.equal((input.context as any).repair.issue.code, 'INTERACTION_LIMIT');
    assert.match((input.context as any).repair.issue.reason, /8/, 'A local limit error supplies actionable repair guidance without a permanent prompt rule');
    return { reply: '本地运行目标额度仍生效，未执行超额目标。' };
  } }); assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(interactS2PublicScene({ ...options, call: async (system) => {
    calls++;
    if (calls === 3) {
      assert(!system.includes('read?:'), 'Exhausted read quota removes the read output key');
      for (const method of ['interfaces:', 'values:', 'componentIds:', 'nodeIds:', 'resultIds:', 'packageInstructions', 'eventData'])
        assert(!system.includes(method), `Exhausted read quota removes ${method}`);
    }
    return { read: { interfaces: [{ componentId: calls === 1 ? 'controls' : calls === 2 ? 'text' : 'configure' }] } };
  } }), (error: any) => error.code === 'INTERACTION_READ_LIMIT');
  assert.equal(calls, 3, 'A third successful read batch cannot be requested');
  calls = 0;
  await assert.rejects(interactS2PublicScene({ ...options, call: async () => {
    calls++;
    if (calls === 1) return { read: { interfaces: [{ componentId: 'configure' }] } };
    if (calls === 2) return { read: { interfaces: [{ componentId: 'configure', parameters: ['amount'] }] } };
    return '{"reply":';
  } }));
  assert.equal(calls, 4, 'Two reads and one syntax repair never exceed four model requests');

  // Complete constraints are also enforced after disclosure, including values
  // whose source JSON type alone would otherwise look valid.
  const invalidValues = [
    { componentId: 'controls', nodeId: 'Native', values: { content: 'longer' } },
    { componentId: 'controls', nodeId: 'Native', values: { count: -1 } },
    { componentId: 'controls', nodeId: 'Native', values: { count: 0.5 } },
    { componentId: 'controls', nodeId: 'Native', values: { form: { name: 'abc', unknown: true } } },
    { componentId: 'controls', nodeId: 'Native', values: { rows: [{ name: '甲', score: '0' }] } },
    { componentId: 'configure', nodeId: 'Target', values: { amount: 21 } },
    { componentId: 'configure', nodeId: 'Target', values: { mode: 'gamma' } },
    { componentId: 'configure', nodeId: 'Target', values: { tags: ['longer'] } },
    { componentId: 'configure', nodeId: 'Target', values: { record: { name: 'four', extra: true } } },
  ];
  for (const invalid of invalidValues) {
    calls = 0;
    await interactS2PublicScene({ ...options, call: async (_system, input) => {
      calls++; const context = input.context as any;
      assert.equal(input.task, task); assert.deepEqual(input.scope, scope); assert.deepEqual(context.recentMessages, history);
      if (calls === 1) return { read: { componentIds: [invalid.componentId] } };
      if (calls === 2) return { actions: [{ type: 'setValues', nodeId: invalid.nodeId, values: invalid.values }] };
      assert(context.repair); assert.notEqual(context.repair.issue.code, 'INTERACTION_COMPONENT_UNREAD', 'An invalid disclosed value reaches the real public parameter validator');
      assert.deepEqual(context.components, [expected.get(invalid.componentId)]);
      return { reply: '按已读字段限制保留原图。' };
    } }); assert.equal(calls, 3);
  }

  // A repair must retain correct text generated for a node added earlier in
  // the same batch. Only that node's public writable parameters may be echoed.
  calls = 0;
  await interactS2PublicScene({ ...options, call: async (_system, input) => {
    calls++; const context = input.context as any;
    assert.equal(input.task, task); assert.deepEqual(input.scope, scope); assert.deepEqual(context.recentMessages, history);
    if (calls === 1) return { read: { componentIds: ['text', 'configure', 'controls'] } };
    if (calls === 2) return { actions: [
      { type: 'addNode', node: { id: 'Generated', componentId: 'text', position: { x: 700, y: 0 } } },
      { type: 'setValues', nodeId: 'Generated', values: { content: 'KEEP_VALID_GENERATED_TEXT', readOnly: true, privateKey: 'PRIVATE_REPAIR_VALUE' } },
      { type: 'setValues', nodeId: 'Target', values: { amount: 0, text: 'INPUT_PORT_IS_NOT_WRITABLE', privateKey: 'PRIVATE_REPAIR_VALUE' } },
      { type: 'setValues', nodeId: 'Native', values: { content: 'longer' } },
    ] };
    assert(context.repair);
    assert.deepEqual(context.repair.previous.actions[1].values, { content: 'KEEP_VALID_GENERATED_TEXT' }, 'Valid generated text for a newly added node survives a later repair');
    assert.deepEqual(context.repair.previous.actions[2].values, { amount: 0 }, 'Public input-only ports and unknown/private parameter keys cannot become writable in repair context');
    assert(!JSON.stringify(context.repair.previous).includes('PRIVATE_REPAIR_VALUE'));
    assert(!JSON.stringify(context.repair.previous).includes('INPUT_PORT_IS_NOT_WRITABLE'));
    assert(!Object.hasOwn(context.repair.previous.actions[1].values, 'readOnly'), 'Node metadata is not a writable text parameter');
    return { reply: '保留已生成的合法正文，只按公开字段修复。' };
  } }); assert.equal(calls, 3);

  calls = 0;
  await interactS2PublicScene({ ...options, call: async (_system, input) => {
    calls++; const context = input.context as any;
    assert.equal(input.task, task); assert.deepEqual(input.scope, scope); assert.deepEqual(context.recentMessages, history);
    if (calls === 1) return { read: { interfaces: [{ componentId: 'configure' }] } };
    if (calls === 2) return { read: { interfaces: [{ componentId: 'configure', parameters: ['amount'] }] } };
    if (calls === 3) return { actions: [{ type: 'setValues', nodeId: 'Target', values: { amount: 21 } }] };
    assert(context.repair); assert.deepEqual(context.interfaces[0].parameters, [expected.get('configure')!.parameters.find(parameter => parameter.id === 'amount')]);
    return { actions: [{ type: 'setValues', nodeId: 'Target', values: { amount: 20 } }] };
  } }); assert.equal(calls, 4, 'Two necessary reads and one safe repair share the four-call ceiling');

  // Reusing a removed ID changes the applicable parameter set. A later removal
  // must also retire that type before any subsequent invalid proposal is echoed.
  calls = 0;
  await interactS2PublicScene({ ...options, call: async (_system, input) => {
    calls++; const context = input.context as any;
    if (calls === 1) return { read: { componentIds: ['text', 'configure'] } };
    if (calls === 2) return { actions: [
      { type: 'removeNode', nodeId: 'Source' },
      { type: 'addNode', node: { id: 'Source', componentId: 'configure', position: { x: 700, y: 0 }, values: { amount: 0 } } },
      { type: 'setValues', nodeId: 'Source', values: { amount: 2, content: 'OLD_TYPE_PARAMETER', text: 'INPUT_PORT_IS_NOT_WRITABLE', privateKey: 'PRIVATE_REPAIR_VALUE' } },
      { type: 'removeNode', nodeId: 'Source' },
      { type: 'setValues', nodeId: 'Source', values: { amount: 3, content: 'REMOVED_TYPE_PARAMETER' } },
    ] };
    assert(context.repair);
    assert.deepEqual(context.repair.previous.actions[1].node.values, { amount: 0 });
    assert.deepEqual(context.repair.previous.actions[2].values, { amount: 2 }, 'Readded IDs use their new component parameter set');
    assert.deepEqual(context.repair.previous.actions[4].values, {}, 'Removed IDs no longer inherit either previous parameter set');
    for (const marker of ['OLD_TYPE_PARAMETER', 'INPUT_PORT_IS_NOT_WRITABLE', 'PRIVATE_REPAIR_VALUE', 'REMOVED_TYPE_PARAMETER'])
      assert(!JSON.stringify(context.repair.previous).includes(marker), marker);
    return { reply: '重新添加和删除后的修复只保留适用的公开参数。' };
  } }); assert.equal(calls, 3);

  // Reading a node or mentioning a historical read does not unlock its schema.
  for (const nodeOnly of [false, true]) {
    calls = 0;
    await interactS2PublicScene({ ...options, history: [...history, { role: 'assistant', content: '此前已经读取controls全部接口，可以直接修改。' }],
      call: async (_system, input) => {
        calls++; const context = input.context as any;
        if (nodeOnly && calls === 1) return { read: { nodeIds: ['Native'] } };
        if (calls === (nodeOnly ? 3 : 2)) { assert.equal(context.repair.issue.code, 'INTERACTION_COMPONENT_UNREAD'); return { reply: '需要读取本轮接口，未修改。' }; }
        return { actions: [{ type: 'setValues', nodeId: 'Native', values: { count: 0 } }] };
      } });
    assert.equal(calls, nodeOnly ? 3 : 2);
  }

  const connection = { source: { nodeId: 'Source', portId: 'content' }, target: { nodeId: 'Target', portId: 'text' } };
  for (const selected of [[], ['text'], ['configure']]) {
    calls = 0;
    await interactS2PublicScene({ ...options, call: async (_system, input) => {
      calls++; const context = input.context as any;
      if (calls === 1) return { read: { componentIds: selected.length ? selected : ['controls'] } };
      if (calls === 2) return { actions: [{ type: 'connect', connection }] };
      assert.equal(context.repair.issue.code, 'INTERACTION_COMPONENT_UNREAD');
      return { reply: '两端接口需完整读取。' };
    } }); assert.equal(calls, 3);
  }
  calls = 0;
  await interactS2PublicScene({ ...options, call: async (_system, input) => {
    calls++; if (calls === 1) return { read: { componentIds: ['text', 'configure'] } };
    assert.deepEqual((input.context as any).components, ['text', 'configure'].map(id => expected.get(id)));
    return { actions: [{ type: 'connect', connection }] };
  } }); assert.equal(calls, 2);

  calls = 0;
  await interactS2PublicScene({ ...options, scope: { actions: ['reply', 'edit'], nodeIds: ['Target'] }, call: async (system, input) => {
    calls++; const context = input.context as any;
    assert(!system.includes('addNode{'), 'A node-limited edit does not teach node creation');
    if (calls === 1) return { read: { interfaces: [{ componentId: 'configure', parameters: ['amount'] }] } };
    actionGuide(context, 'parameters', false);
    assert.deepEqual(context.interfaces[0].parameters, [expected.get('configure')!.parameters.find(parameter => parameter.id === 'amount')]);
    return { actions: [{ type: 'setValues', nodeId: 'Target', values: { amount: 20 } }] };
  } }); assert.equal(calls, 2);
  calls = 0;
  await interactS2PublicScene({ ...options, scope: { actions: ['reply', 'edit'], nodeIds: ['Native'] }, call: async (_system, input) => {
    calls++;
    if (calls === 1) return { read: { interfaces: [{ componentId: 'controls', outputs: ['content'] }] } };
    actionGuide(input.context, 'none');
    assert.deepEqual((input.context as any).interfaces[0].outputs, expected.get('controls')!.outputs, 'Unusable wiring syntax is omitted without removing the actual requested port rules');
    return { reply: '本轮没有可连接的公开入口，只解释已读输出。' };
  } }); assert.equal(calls, 2);

  // Removing an existing public wire uses its actual canvas endpoints. It
  // never needs parameter/port disclosure, but scope and existence still apply.
  const connectedCanvas = projectS2PublicCanvas(pack, config.definition, config.document);
  connectedCanvas.connections.push(connection);
  const connected = compileS2PublicCanvas(pack, connectedCanvas, { goal: config.definition.goal });
  calls = 0;
  await interactS2PublicScene({ ...options, ...connected, call: async (_system, input) => {
    calls++; assert.equal((input.context as any).components, undefined); actionGuide(input.context, 'none');
    return { actions: [{ type: 'disconnect', connection }] };
  } }); assert.equal(calls, 1);
  calls = 0;
  await interactS2PublicScene({ ...options, call: async (_system, input) => {
    if (++calls === 1) return { actions: [{ type: 'disconnect', connection }] };
    assert.equal((input.context as any).repair.issue.code, 'INTERACTION_TARGET');
    return { reply: '不存在的连线没有被修改。' };
  } }); assert.equal(calls, 2);
  calls = 0;
  await interactS2PublicScene({ ...options, ...connected, scope: { actions: ['reply', 'edit'], nodeIds: ['Source'] }, call: async (_system, input) => {
    if (++calls === 1) return { actions: [{ type: 'disconnect', connection }] };
    assert.equal((input.context as any).repair.issue.code, 'INTERACTION_SCOPE');
    return { reply: '超出本轮范围的连线没有被修改。' };
  } }); assert.equal(calls, 2);

  // Editing one field reads only that field's complete public contract. Other
  // categories remain unread rather than implying that the component has none.
  calls = 0;
  await interactS2PublicScene({ ...options, call: async (_system, input) => {
    calls++; const context = input.context as any;
    if (calls === 1) return { read: { interfaces: [{ componentId: 'configure', parameters: ['amount'] }] } };
    assert.equal(context.components, undefined, 'A single parameter never requires the full component');
    assert.deepEqual(context.interfaces, [{ componentId: 'configure', representation: 'selected-interface',
      parameters: [expected.get('configure')!.parameters.find(parameter => parameter.id === 'amount')] }]);
    assert.equal(context.interfaces[0].inputs, undefined); assert.equal(context.interfaces[0].outputs, undefined);
    assert.equal(context.componentRules, S2_AGENT_COMPONENT_RULES);
    actionGuide(context, 'parameters');
    return { actions: [{ type: 'setValues', nodeId: 'Target', values: { amount: 20 } }] };
  } }); assert.equal(calls, 2);

  for (const forbidden of [{ mode: 'beta' }, { text: 'input-is-not-a-parameter' }]) {
    calls = 0;
    await interactS2PublicScene({ ...options, call: async (_system, input) => {
      calls++; const context = input.context as any;
      if (calls === 1) return { read: { interfaces: [{ componentId: 'configure', parameters: ['amount'], inputs: ['text'] }] } };
      if (calls === 2) return { actions: [{ type: 'setValues', nodeId: 'Target', values: forbidden }] };
      assert(context.repair); assert.match(context.repair.issue.code, /UNREAD|PRIVATE/);
      return { reply: '只读取amount，不能改写其他参数或把数据入口当成参数。' };
    } }); assert.equal(calls, 3);
  }

  // Selected constraints remain authoritative: reading just amount still
  // carries its exact unit, default, integer and range requirements.
  calls = 0;
  await interactS2PublicScene({ ...options, call: async (_system, input) => {
    calls++; const context = input.context as any;
    if (calls === 1) return { read: { interfaces: [{ componentId: 'configure', parameters: ['amount'] }] } };
    if (calls === 2) {
      assert.deepEqual(context.interfaces[0].parameters[0], expected.get('configure')!.parameters.find(parameter => parameter.id === 'amount'));
      return { actions: [{ type: 'setValues', nodeId: 'Target', values: { amount: 21 } }] };
    }
    assert(context.repair); assert.doesNotMatch(context.repair.issue.code, /UNREAD/);
    return { reply: 'amount必须遵守已读范围，未应用超限值。' };
  } }); assert.equal(calls, 3);

  // A second read may add the next necessary field. Previously read complete
  // constraints and the original task remain present for the final action.
  calls = 0;
  await interactS2PublicScene({ ...options, call: async (system, input) => {
    calls++; const context = input.context as any;
    assert.equal(input.task, task); assert.deepEqual(input.scope, scope); assert.deepEqual(context.recentMessages, history);
    if (calls === 1) return { read: { interfaces: [{ componentId: 'configure', parameters: ['amount'] }] } };
    if (calls === 2) return { read: { interfaces: [{ componentId: 'configure', parameters: ['mode'] }] } };
    assert(!system.includes('read?:'), 'After two reads the final proposal has no further read output key');
    for (const selector of ['interfaces:', 'values:', 'componentIds:', 'nodeIds:', 'resultIds:', 'packageInstructions', 'eventData']) assert(!system.includes(selector));
    const selected = context.interfaces.find((item: any) => item.componentId === 'configure');
    assert.deepEqual(selected.parameters, expected.get('configure')!.parameters.filter(parameter => ['amount', 'mode'].includes(parameter.id)));
    return { actions: [{ type: 'setValues', nodeId: 'Target', values: { amount: 0, mode: 'beta' } }] };
  } }); assert.equal(calls, 3);

  calls = 0;
  await interactS2PublicScene({ ...options, scope: { actions: ['reply'], nodeIds: ['Native'] }, call: async (system, input) => {
    calls++; const context = input.context as any;
    if (calls === 1) {
      assert(!system.includes('nodeIds:'), 'The first value read selects only necessary parameters');
      return { read: { values: [{ nodeId: 'Native', parameterIds: ['count'] }] } };
    }
    if (calls === 2) {
      assert(system.includes('nodeIds:'), 'Whole-node reading is discoverable after a local value read leaves other actual values unread');
      assert.deepEqual(context.recalled.values.map((entry: any) => entry.value), [0]);
      return { read: { nodeIds: ['Native'] } };
    }
    assert.deepEqual(context.recalled.nodeDetails[0].values, projectS2PublicCanvas(pack, config.definition, config.document).nodes.find(node => node.id === 'Native')!.values);
    assert(!system.includes('read?:')); actionGuide(context, 'none');
    return { reply: '补读保留了实际原值，不解锁编辑。' };
  } }); assert.equal(calls, 3);

  // Values are independent evidence. Reading a small field does not read every
  // value in its block, and never unlocks editable interface permissions.
  calls = 0;
  await interactS2PublicScene({ ...options, call: async (_system, input) => {
    calls++; const context = input.context as any;
    if (calls === 1) return { read: { values: [{ nodeId: 'Native', parameterIds: ['count', 'enabled', 'json'] }] } };
    assert.deepEqual(context.recalled.values.map((item: any) => ({ nodeId: item.nodeId, parameterId: item.parameterId, value: item.value })), [
      { nodeId: 'Native', parameterId: 'count', value: 0 }, { nodeId: 'Native', parameterId: 'enabled', value: false }, { nodeId: 'Native', parameterId: 'json', value: null },
    ]);
    assert.equal(context.components, undefined); assert.equal(context.interfaces, undefined);
    actionGuide(context, 'none');
    return { reply: '当前值保留零、假与空值，不修改。' };
  } }); assert.equal(calls, 2);

  calls = 0;
  await interactS2PublicScene({ ...options, call: async (_system, input) => {
    calls++; const context = input.context as any;
    if (calls === 1) return { read: { values: [{ nodeId: 'Native', parameterIds: ['count'] }] } };
    if (calls === 2) return { actions: [{ type: 'setValues', nodeId: 'Native', values: { count: 1 } }] };
    assert.match(context.repair.issue.code, /UNREAD/); return { reply: '读取值不代替读取字段限制。' };
  } }); assert.equal(calls, 3);

  // A new large component can be discovered by member index, then only the
  // chosen parameter is read. The full >12000-char interface is unnecessary.
  const noGiantCanvas = { version: 1 as const, nodes: [{ id: 'Source', componentId: 'text', position: { x: 0, y: 0 } }], connections: [] };
  const noGiant = compileS2PublicCanvas(pack, noGiantCanvas, { goal: config.definition.goal });
  calls = 0;
  await interactS2PublicScene({ ...options, ...noGiant, call: async (system, input) => {
    calls++; const context = input.context as any;
    if (calls === 1) {
      assert(!system.includes('componentIds:'), 'The first interface request reads the required members instead of a whole component');
      return { read: { interfaces: [{ componentId: 'giant' }] } };
    }
    if (calls === 2) {
      assert(system.includes('componentIds:'), 'After member discovery a full component remains available when genuinely needed');
      assert.equal(context.components, undefined); assert.equal(context.interfaces, undefined);
      actionGuide(context, 'none');
      const index = context.interfaceIndex.find((item: any) => item.componentId === 'giant');
      assert.deepEqual(index.parameters.map((item: any) => item.id), giant.fields.map(field => field.id));
      assert(!JSON.stringify(input).includes(giant.fields[0].options![0]), 'Member discovery carries no enum/default/body details');
      return { read: { interfaces: [{ componentId: 'giant', parameters: ['choice0'] }] } };
    }
    const detail = context.interfaces.find((item: any) => item.componentId === 'giant');
    assert.deepEqual(detail.parameters, [expected.get('giant')!.parameters.find(parameter => parameter.id === 'choice0')]);
    actionGuide(context, 'parameters');
    assert(!JSON.stringify(input).includes(giant.fields[1].options![0]), 'Unread fields of the large component stay undisclosed');
    return { actions: [{ type: 'addNode', node: { id: 'NewGiant', componentId: 'giant', position: { x: 700, y: 0 }, values: { choice0: giant.fields[0].options![0] } } }] };
  } }); assert.equal(calls, 3);

  // A bare public type can be instantiated with its package defaults without
  // treating those implicit defaults as a request to edit unread parameters.
  calls = 0;
  await interactS2PublicScene({ ...options, call: async () => {
    calls++; return { actions: [{ type: 'addNode', node: { id: 'DefaultText', componentId: 'text', position: { x: 700, y: 0 } } }] };
  } }); assert.equal(calls, 1);

  // Wiring only requires the chosen source output and destination input; it
  // does not disclose or unlock the destination's other model parameters.
  calls = 0;
  await interactS2PublicScene({ ...options, call: async (_system, input) => {
    calls++; const context = input.context as any;
    if (calls === 1) return { read: { interfaces: [
      { componentId: 'text', outputs: ['content'] }, { componentId: 'configure', inputs: ['text'] },
    ] } };
    assert.equal(context.components, undefined);
    assert.deepEqual(context.interfaces, [
      { componentId: 'text', representation: 'selected-interface', outputs: expected.get('text')!.outputs.filter(port => port.id === 'content') },
      { componentId: 'configure', representation: 'selected-interface', inputs: expected.get('configure')!.inputs.filter(port => port.id === 'text') },
    ]);
    actionGuide(context, 'ports');
    return { actions: [{ type: 'connect', connection }] };
  } }); assert.equal(calls, 2);

  for (const interfaces of [
    [{ componentId: 'text', outputs: ['content'] }],
    [{ componentId: 'configure', inputs: ['text'] }],
    [{ componentId: 'text', outputs: ['content'] }, { componentId: 'configure', parameters: ['amount'] }],
  ]) {
    calls = 0;
    await interactS2PublicScene({ ...options, call: async (_system, input) => {
      calls++; if (calls === 1) return { read: { interfaces } };
      if (calls === 2) return { actions: [{ type: 'connect', connection }] };
      assert.match((input.context as any).repair.issue.code, /UNREAD/); return { reply: '连接需要两端对应端口的完整约束。' };
    } }); assert.equal(calls, 3);
  }

  calls = 0;
  await interactS2PublicScene({ ...options, call: async (_system, input) => {
    calls++; if (calls === 1) return { read: { interfaces: [{ componentId: 'configure', inputs: ['text'] }] } };
    if (calls === 2) return { actions: [{ type: 'setValues', nodeId: 'Target', values: { amount: 1 } }] };
    assert.match((input.context as any).repair.issue.code, /UNREAD/); return { reply: '读取数据入口不开放其他可调参数。' };
  } }); assert.equal(calls, 3);

  calls = 0;
  await interactS2PublicScene({ ...options, call: async (_system, input) => {
    calls++; if (calls === 1) return { read: { interfaces: [{ componentId: 'giant', parameters: ['choice0'] }] } };
    if (calls === 2) return { actions: [{ type: 'addNode', node: { id: 'NewGiant', componentId: 'giant', position: { x: 700, y: 0 },
      values: { choice0: giant.fields[0].options![0], choice1: giant.fields[1].options![0] } } }] };
    assert.match((input.context as any).repair.issue.code, /UNREAD/); return { reply: '不能把choice0的读取扩展为choice1权限。' };
  } }); assert.equal(calls, 3);

  // Custom business payloads are also data, not a mandatory first-call body.
  const customPayload = { summary: 'CUSTOM_EVENT_PRIVATE_UNTIL_READ_' + '甲'.repeat(1200) };
  calls = 0;
  await interactS2PublicScene({ ...options, origin: 'event', event: { type: 'progressive-interaction-fixture.ready', nodeId: 'Source', data: customPayload },
    call: async (system, input) => {
      calls++; const context = input.context as any;
      assert.equal(system.includes('eventData'), calls === 1, 'A real scoped custom payload is offered once, then retained as data');
      if (calls === 1) { assert(!JSON.stringify(input).includes(customPayload.summary)); return { read: { eventData: true } }; }
      actionGuide(context, 'none');
      assert.deepEqual(context.recalled.eventData, customPayload); return { reply: '仅根据已读取业务事件响应。' };
    } }); assert.equal(calls, 2);

  calls = 0;
  await interactS2PublicScene({ ...options, origin: 'event', scope: { actions: ['reply'], nodeIds: ['Target'] },
    event: { type: 'progressive-interaction-fixture.ready', nodeId: 'Source', data: customPayload }, call: async (system, input) => {
      calls++; assert(!JSON.stringify(input).includes(customPayload.summary));
      if (calls === 1) assert(!system.includes('eventData'), 'An out-of-scope event cannot advertise payload reading');
      if (calls === 1) return { read: { eventData: true } };
      assert.equal((input.context as any).repair.issue.code, 'INTERACTION_READ_SCOPE'); return { reply: '来源不在读取范围内，不能借事件扩展。' };
    } }); assert.equal(calls, 2);

  for (const componentId of ['PrivateWorker', 'notPublished']) {
    calls = 0;
    await interactS2PublicScene({ ...options, call: async (_system, input) => {
      calls++; if (calls === 1) return { read: { componentIds: [componentId] } };
      assert.equal((input.context as any).repair.issue.code, 'INTERACTION_READ_SCOPE'); return { reply: '只使用公开目录。' };
    } }); assert.equal(calls, 2);
  }

  for (const read of [
    { interfaces: [{ componentId: 'configure', parameters: ['text'] }] },
    { interfaces: [{ componentId: 'configure', outputs: ['notPublished'] }] },
    { interfaces: [{ componentId: 'PrivateWorker', parameters: ['text'] }] },
    { values: [{ nodeId: 'PrivateWorker', parameterIds: ['text'] }] },
    { values: [{ nodeId: 'Source', parameterIds: ['notPublished'] }] },
  ]) {
    calls = 0;
    await interactS2PublicScene({ ...options, call: async (_system, input) => {
      calls++; assert(!JSON.stringify(input).includes('PRIVATE_IMPLEMENTATION'));
      if (calls === 1) return { read };
      assert.match((input.context as any).repair.issue.code, /READ_SCOPE|FIELD_PRIVATE/);
      return { reply: '分层读取仍只能访问公开字段。' };
    } }); assert.equal(calls, 2);
  }

  // An oversized interface must remain whole-or-unavailable. A valid value
  // cannot bypass the unread gate after failed disclosure.
  assert(JSON.stringify(expected.get('giant')).length > 12000);
  calls = 0;
  await interactS2PublicScene({ ...options, call: async (_system, input) => {
    calls++; const context = input.context as any;
    if (calls === 1) return { read: { componentIds: ['giant'] } };
    if (calls === 2) {
      assert(!context.components?.some((component: any) => component.id === 'giant'));
      assert.equal(context.componentRules, undefined);
      assert(context.recalled.componentDetails.some((component: any) => component.id === 'giant' && component.unavailable && component.reason));
      assert(!JSON.stringify(input).includes(giant.fields[0].options![0]));
      return { actions: [{ type: 'setValues', nodeId: 'Giant', values: { choice0: giant.fields[0].options![0] } }] };
    }
    assert.equal(context.repair.issue.code, 'INTERACTION_COMPONENT_UNREAD'); return { reply: '完整接口未提供，未修改。' };
  } }); assert.equal(calls, 3);

  // Failure to read the entire interface must not obscure a subsequent exact
  // field read. The unavailability marker is explicitly scoped to the whole.
  calls = 0;
  await interactS2PublicScene({ ...options, call: async (_system, input) => {
    calls++; const context = input.context as any;
    if (calls === 1) return { read: { componentIds: ['giant'] } };
    const whole = context.recalled.componentDetails.find((item: any) => item.id === 'giant');
    assert.equal(whole.representation, 'complete-interface');
    assert.match(whole.reason, /局部参数或端口仍可/);
    if (calls === 2) return { read: { interfaces: [{ componentId: 'giant', parameters: ['choice0'] }] } };
    assert.deepEqual(context.interfaces.find((item: any) => item.componentId === 'giant').parameters,
      [expected.get('giant')!.parameters.find(parameter => parameter.id === 'choice0')]);
    return { actions: [{ type: 'setValues', nodeId: 'Giant', values: { choice0: giant.fields[0].options![0] } }] };
  } }); assert.equal(calls, 3);

  // The shared pool includes interfaces and node bodies. Two full 6000-char
  // nodes already exceed the pool; no partial body may escape as complete.
  const largeCanvas = { version: 1 as const, nodes: [
    { id: 'First', componentId: 'text', position: { x: 0, y: 0 }, values: { content: '甲'.repeat(6000) } },
    { id: 'Second', componentId: 'text', position: { x: 0, y: 300 }, values: { content: '乙'.repeat(6000) } },
  ], connections: [] };
  const large = compileS2PublicCanvas(pack, largeCanvas, { goal: config.definition.goal });
  const resultId = 'artifact-ProgressiveBudgetResult';
  const resultContext = { outputIndex: [{ nodeId: 'First', portId: 'content', type: { id: 'core.text', version: 1 }, artifactIds: [resultId], state: 'available' }],
    artifactCatalog: [{ id: resultId, type: { id: 'core.text', version: 1 }, source: { nodeId: 'First' } }] } as unknown as NonNullable<S2InteractionOptions['pluginContext']>;
  bindS2ArtifactContext(resultContext, { output: () => [resultId], read: () => ({ protocolVersion: 1, id: resultId,
    type: { id: 'core.text', version: 1 }, source: { sceneId: 'synthetic', runId: 'synthetic', nodeId: 'First', revision: 0, kind: 'host' }, complete: true,
    payload: { kind: 'inline', value: '丙'.repeat(6500) } }) });
  calls = 0;
  await interactS2PublicScene({ ...options, ...large, pluginContext: resultContext, call: async (_system, input) => {
    calls++; const context = input.context as any;
    if (calls === 1) {
      assert.equal(context.canvas.representation, 'public-index'); assert(context.canvas.nodes.every((node: any) => !Object.hasOwn(node, 'values')));
      assert.equal(context.resultDetails, undefined);
      for (const body of ['甲'.repeat(100), '乙'.repeat(100), '丙'.repeat(100)]) assert(!JSON.stringify(input).includes(body), 'Initial context contains indices, not source or result bodies');
      return { read: { componentIds: ['text'], nodeIds: ['First', 'Second'], resultIds: [resultId], packageInstructions: true } };
    }
    const successfulNodes = context.recalled.nodeDetails.filter((node: any) => !node.unavailable);
    assert.equal(successfulNodes.length, 1); assert(context.recalled.nodeDetails.some((node: any) => node.unavailable));
    for (const node of successfulNodes) assert.equal(node.values.content.length, 6000);
    assert(context.recalled.resultDetails.some((result: any) => result.resultId === resultId && result.unavailable), 'A complete result shares the same remaining pool');
    assert(!JSON.stringify(input).includes('丙'.repeat(100)), 'An over-budget full result cannot become a prefix');
    const detailCost = (context.componentRules?.length ?? 0) + (context.packageInstructions?.length ?? 0)
      + (context.components ?? []).reduce((sum: number, component: unknown) => sum + JSON.stringify(component).length, 0)
      + successfulNodes.reduce((sum: number, node: unknown) => sum + JSON.stringify(node).length, 0);
    assert(detailCost <= 12000, 'One shared complete-detail budget covers rule prose, guide, interfaces, node bodies and requested results');
    return { reply: '只依据本轮已完整提供的内容回应。' };
  } }); assert.equal(calls, 2);
  assert.equal(JSON.stringify({ definition: config.definition, document: config.document, authoring: pack.authoring }), baseline);
  console.log('S2 progressive interaction passed: body-free node/result/event indices, exact complete selected editable fields/ports/defaults/limits, explicit guide/value/event reads, two-level large-component discovery, per-field and per-port gates, bounded two reads plus repair, ordered new/replaced/removed repair identities, no body/history unlock and private scope rejection. No runtime, provider, network or user resources.');
} finally { globalThis.fetch = previousFetch; }
