import assert from 'node:assert/strict';
import type { ScenePackDescription } from '../src/types/sceneInteractionPack';
import type { S2CanvasDefinition } from '../src/types/sceneS2';
import type { S2PluginCapability, S2PluginManifest } from '../src/types/sceneS2Plugin';
import { createS2DesignDisclosure, S2DesignDisclosureReadError, S2_DISCLOSURE_SELECT_PROMPT, S2_DISCLOSURE_CONTINUE_PROMPT } from '../src/services/scene/sceneS2DesignDisclosure';

globalThis.fetch = async () => assert.fail('Disclosure checks never use real models, user notes or external services');
const capability = (id: string, version: number, kind: S2PluginCapability['kind'] = 'transform'): S2PluginCapability => ({
  id, kind, meaning: `处理第${version}版数值`, inputs: [{ id: 'value', label: '输入数据', meaning: '保留精确结构',
    type: { id: 'vendor.value', version }, required: true, multiple: false }],
  outputs: [{ id: 'result', label: 'result', meaning: 'result 完整数据', type: { id: 'vendor.value', version }, required: true, multiple: false }],
  effect: 'pure', permissions: [], confirmation: 'none', retry: 'manual-only', timeoutMs: 1000,
});
const plugin = (id: string, version: string, valueVersion: number): S2PluginManifest => ({
  protocolVersion: 1, id, version, label: `开发者组件 ${id}`, meaning: '开发者完整业务意义', dependencies: [], dataTypes: [],
  capabilities: [capability('work', valueVersion), capability('editor-only', valueVersion, 'editor')],
});
const first = plugin('custom-one', '1.0.0', 1), second = plugin('custom-two', '2.0.0', 2);
const provider: S2PluginManifest = { ...plugin('provider', '1.0.0', 1), dataTypes: [
  { id: 'vendor.value', version: 1, meaning: '一版：枚举记录', schema: { kind: 'string', maxLength: 12, enum: ['同意', '拒绝'] } },
  { id: 'vendor.value', version: 2, meaning: '二版：整数值', schema: { kind: 'number', integer: true, minimum: 1, maximum: 9 } },
] };
const catalog = { protocolVersion: 1, schemaDialect: 's2-bounded-value-v2', fieldEditors: ['text', 'number'], plugins: [first, second] };
const one = { pluginId: 'custom-one', pluginVersion: '1.0.0', capabilityId: 'work' };
const two = { pluginId: 'custom-two', pluginVersion: '2.0.0', capabilityId: 'work' };
const guide: ScenePackDescription = { purpose: '搭建一个开发者自定义实验',
  components: [
    { id: 'narrative', name: '说明部件', purpose: '用途A', configuration: 'COMPONENT_A_CONFIGURATION', example: { data: 'COMPONENT_A_EXAMPLE' } },
    { id: 'other-component', name: '另一部件', purpose: '用途B', configuration: 'COMPONENT_B_CONFIGURATION', example: { data: 'COMPONENT_B_EXAMPLE' } },
  ], combinations: ['SELECTED_COMBINATIONS_ONLY'], operations: [{ id: 'run', description: '按本地协议运行', parameters: 'RUNTIME_PARAMETERS_NOT_A_BUILDER_READ', errors: [] }],
  builder: { assemble: 'PACKAGE_ASSEMBLE_POLICY', repair: 'PACKAGE_REPAIR_POLICY' },
  assistant: { instructions: 'SELECTED_ASSISTANT_REFERENCE_ONLY', defaultAllowedOperations: [] },
};
const original = JSON.stringify({ catalog, provider, guide });
const disclosure = createS2DesignDisclosure({ catalog, allTypeProviders: [provider], guide });
const index = disclosure.index, indexText = JSON.stringify(index);
assert.deepEqual(index.components, guide.components.map(({ id, name, purpose }) => ({ id, name, purpose })));
assert.deepEqual(index.plugins.flatMap(plugin => plugin.capabilities.map(cap => `${plugin.id}@${plugin.version}/${cap.id}`)),
  ['custom-one@1.0.0/work', 'custom-two@2.0.0/work']);
assert.equal(index.purpose, guide.purpose);
assert.deepEqual(index.sections.map(section => section.id), ['builder', 'combinations', 'assistant']);
for (const marker of ['COMPONENT_A_CONFIGURATION', 'COMPONENT_A_EXAMPLE', 'COMPONENT_B_CONFIGURATION',
  'PACKAGE_ASSEMBLE_POLICY', 'PACKAGE_REPAIR_POLICY', 'SELECTED_COMBINATIONS_ONLY', 'SELECTED_ASSISTANT_REFERENCE_ONLY',
  'RUNTIME_PARAMETERS_NOT_A_BUILDER_READ', 'vendor.value', 'maxLength', 'inputs', 'outputs'])
  assert(!indexText.includes(marker), `Discovery index leaked unread details: ${marker}`);
assert.deepEqual(disclosure.context('assemble', S2_DISCLOSURE_SELECT_PROMPT), { discoveryIndex: disclosure.index });
assert.deepEqual(disclosure.context('review', ''), {}, 'A review with no selected details exposes neither discovery options nor unread bodies');
assert.throws(() => disclosure.assertReady(), /尚未选择读取/);
const snapshot = JSON.stringify(disclosure.context('assemble', ''));
assert.throws(() => disclosure.read({ componentIds: ['narrative', 'human-input'], sections: ['builder'], capabilities: [one] }), (error: unknown) => {
  assert.ok(error instanceof S2DesignDisclosureReadError); assert.ok(error instanceof Error);
  assert.equal(error.name, 'S2DesignDisclosureReadError'); assert.equal(error.code, 'COMPONENT_NOT_FOUND'); assert.equal(error.componentId, 'human-input');
  assert.equal(error.message, 'S2 按需说明：不存在组件说明 human-input'); return true;
});
assert.equal(JSON.stringify(disclosure.context('assemble', '')), snapshot, 'An unknown component commits none of the same batch components/sections/capabilities');
assert.throws(() => disclosure.assertReady(), /尚未选择读取/);
for (const bad of [
  { componentIds: [false] },
  { componentIds: ['narrative', 'narrative'] },
  { componentIds: ['human-input'], initial: {} },
  { componentIds: ['narrative'], sections: ['builder'], capabilities: [{ ...one, pluginId: 'foreign' }] },
]) {
  assert.throws(() => disclosure.read(bad), (error: unknown) => {
    assert.ok(error instanceof Error); assert.equal(error instanceof S2DesignDisclosureReadError, false, 'Malformed, mixed, duplicate and foreign-capability requests do not become component corrections'); return true;
  });
  assert.equal(JSON.stringify(disclosure.context('assemble', '')), snapshot);
}
for (const [request, extra] of [
  [{ componentIds: ['narrative', 'human-input'], sections: ['builder'], capabilities: [{ ...one, pluginId: 'foreign' }] }, []],
  [{ componentIds: ['human-input'], capabilities: [one, one] }, []],
  [{ componentIds: ['human-input'], sections: ['builder', 'builder'] }, []],
  [{ componentIds: ['human-input'], capabilities: [{ ...one, permission: 'model-call' }] }, []],
  [{ componentIds: ['human-input'], capabilities: [one] }, [{ ...one, pluginId: 'foreign' }]],
] as const) {
  assert.throws(() => disclosure.read(request, [...extra]), (error: unknown) => {
    assert.ok(error instanceof Error); assert.equal(error instanceof S2DesignDisclosureReadError, false,
      'An unknown component cannot mask malformed/duplicate/foreign selections in the same read batch'); return true;
  });
  assert.equal(JSON.stringify(disclosure.context('assemble', '')), snapshot, 'A rejected mixed batch leaves every namespace unread');
  assert.throws(() => disclosure.assertReady(), /尚未选择读取/);
}
for (const bad of [
  {}, { sections: [] }, { componentIds: [] }, { capabilities: [] },
  { unknown: [] }, { componentIds: ['narrative'], initial: {} }, { sections: ['builder'], repair: {} },
  { componentIds: ['work'] }, // A capability name is never a component identity.
  { componentIds: ['narrative', 'narrative'] }, { componentIds: Array(17).fill('narrative') },
  { sections: ['unknown'] }, { sections: ['builder', 'builder'] },
  { capabilities: [{ ...one, pluginVersion: 'latest' }] },
  { capabilities: [{ ...one, pluginId: provider.id }] },
  { capabilities: [{ ...one, capabilityId: 'editor-only' }] },
  { capabilities: [{ ...one, permission: 'model-call' }] },
  { capabilities: [one, one] }, { capabilities: Array(17).fill(one) },
  { componentIds: ['narrative'], capabilities: [two, { ...one, capabilityId: 'unknown' }] },
]) {
  assert.throws(() => disclosure.read(bad));
  assert.equal(JSON.stringify(disclosure.context('assemble', '')), snapshot, 'A failed read must commit no partial selection');
}
let getterRuns = 0; const hostile = Object.defineProperty({}, 'sections', { enumerable: true, get() { getterRuns++; return ['builder']; } });
assert.throws(() => disclosure.read(hostile)); assert.equal(getterRuns, 0);
const sparse = new Array(1); assert.throws(() => disclosure.read({ capabilities: sparse }));

disclosure.read({ componentIds: ['narrative'], capabilities: [one] });
assert.throws(() => disclosure.assertReady(), /必须显式读取builder/);
let context = disclosure.context('assemble', '');
assert.deepEqual(context.readState, { componentIds: ['narrative'], sections: [], capabilities: [one] },
  'Each independent compose request receives the exact declaration-read history');
assert.equal(context.interactionPack?.builder, undefined, 'Unread builder instructions never enter the compose context');
assert.equal(context.interactionPack?.assistant, undefined);
assert.equal(context.interactionPack?.combinations, undefined);
assert.deepEqual(context.interactionPack?.components, [guide.components[0]]);
assert(!JSON.stringify(context).includes('COMPONENT_B_CONFIGURATION'));
assert.deepEqual(context.pluginCatalog?.types, [{ ref: 'vendor.value@1', meaning: provider.dataTypes[0].meaning, shape: ['string', 12, ['同意', '拒绝']] }]);
assert(!context.pluginCatalog?.plugins.some(plugin => plugin.id === provider.id), 'Type providers do not expand executable scope');
const afterOne = JSON.stringify(context);
assert.throws(() => disclosure.read({ componentIds: ['other-component', 'custom-two'], sections: ['builder'], capabilities: [two] }), (error: unknown) => {
  assert.ok(error instanceof S2DesignDisclosureReadError); assert.equal(error.componentId, 'custom-two'); return true;
});
assert.equal(JSON.stringify(disclosure.context('assemble', '')), afterOne, 'A plugin id is never aliased to a component and a failed follow-up retains exactly the preceding read state');
assert.throws(() => disclosure.read({ componentIds: ['narrative'] }), /已读取或重复/);
assert.throws(() => disclosure.read({ capabilities: [one] }), /已读取或重复/);
assert.equal(JSON.stringify(disclosure.context('assemble', '')), afterOne);
disclosure.read({ sections: ['builder', 'assistant', 'combinations'], componentIds: ['other-component'] }, [one, two, one]);
disclosure.assertReady();
context = disclosure.context('assemble', guide.builder.assemble);
assert.deepEqual(context.readState, { componentIds: ['narrative', 'other-component'], sections: ['builder', 'assistant', 'combinations'], capabilities: [one, two] });
assert.equal(context.interactionPack?.builder, undefined, 'Read policy compiled into system is not duplicated');
assert.deepEqual(context.interactionPack?.components, guide.components, 'Selected component docs accumulate and are sent on every generation request');
assert.deepEqual(context.interactionPack?.combinations, guide.combinations);
assert.equal(context.interactionPack?.assistant?.instructions, guide.assistant.instructions);
assert.match(context.interactionPack!.assistant!.ownership, /不是搭建Agent/);
assert.deepEqual(context.pluginCatalog?.types.map(type => type.ref), ['vendor.value@1', 'vendor.value@2']);
assert.deepEqual(disclosure.context('repair', guide.builder.repair).interactionPack?.builder, { assemble: guide.builder.assemble });
assert.deepEqual(disclosure.context('assemble', 'OVERRIDE').interactionPack?.builder, { assemble: guide.builder.assemble });
const reviewedContext = disclosure.context('review', '');
assert.equal(reviewedContext.discoveryIndex, undefined, 'Read-only review cannot request more interfaces and does not repeat the discovery index');
assert.equal(reviewedContext.readState, undefined, 'Read-only review needs selected details, not a new-read ledger');
assert.deepEqual(reviewedContext.pluginCatalog, context.pluginCatalog, 'Review retains the complete already-provided interfaces');
assert.deepEqual(reviewedContext.interactionPack?.components, guide.components);
assert.equal(reviewedContext.interactionPack?.assistant?.instructions, guide.assistant.instructions);
assert.throws(() => disclosure.read({ sections: ['builder'] }), /已读取或重复/);
assert.throws(() => disclosure.read({}, [one]), /尚未提供的说明/);

const empty: S2CanvasDefinition = { version: 1, goal: '合成空画布', instructions: { understanding: '理解', planning: '协作', response: '解释' },
  blockTypes: [{ id: 'text', label: '文字', fields: [{ id: 'content', label: '内容', kind: 'text' }] }], initial: { nodes: [], edges: [] } };
const node = (ref: typeof one) => ({ id: 'test', ...ref, position: { x: 0, y: 0 }, bindings: {} });
disclosure.assertProvided({ ...empty, plugins: [one, two] });
const partial = createS2DesignDisclosure({ catalog, allTypeProviders: [provider], guide });
partial.read({ sections: ['builder'], capabilities: [one] });
for (const unprovided of [
  { ...empty, plugins: [two] },
  { ...empty, initial: { ...empty.initial, execution: { version: 1, nodes: [node(two)], links: [] } } },
  { ...empty, business: { workflow: [], completion: { reference: { ...empty.initial, execution: { version: 1, nodes: [node(two)], links: [] } } } } },
  { ...empty, business: { workflow: [{ capabilities: [two] }], completion: { reference: empty.initial } } },
]) assert.throws(() => partial.assertProvided(unprovided as S2CanvasDefinition), /接口详情尚未提供/);
assert.throws(() => partial.assertProvided({ ...empty, plugins: [{ ...one, pluginId: provider.id }] }), /不在本次目录范围/);
partial.assertProvided({ ...empty, plugins: [one] });

const pure = createS2DesignDisclosure({ catalog, allTypeProviders: [provider] });
assert.equal(pure.index.purpose, undefined); assert.deepEqual(pure.index.components, []);
pure.read({}); pure.assertReady(); pure.assertProvided(empty);
assert.throws(() => pure.read({}), /不能空读或重复读取/);
assert.throws(() => pure.assertProvided({ ...empty, plugins: [one] }), /接口详情尚未提供/);
const pureExplicit = createS2DesignDisclosure({ catalog, allTypeProviders: [provider] });
pureExplicit.read({ capabilities: [] }); pureExplicit.assertReady();
const blueprintOnly = createS2DesignDisclosure({ catalog, allTypeProviders: [provider] });
blueprintOnly.read({}, [one]); blueprintOnly.assertReady(); blueprintOnly.assertProvided({ ...empty, plugins: [one] });
assert.throws(() => createS2DesignDisclosure({ catalog, allTypeProviders: [provider] }).read({}, [{ ...one, pluginId: 'foreign' }]), /不在本次目录范围/);
const missingType = createS2DesignDisclosure({ catalog });
assert.throws(() => missingType.read({ capabilities: [one] }), /找不到端口类型/);
assert.throws(() => missingType.assertReady(), /尚未选择读取/);

index.components[0].purpose = 'return mutation';
context.interactionPack!.components![0].configuration = 'return mutation';
context.discoveryIndex!.plugins[0].capabilities.length = 0;
context.readState!.componentIds.length = 0;
context.readState!.sections.length = 0;
context.readState!.capabilities[0].pluginId = 'mutated-return';
assert.equal(disclosure.index.components[0].purpose, guide.components[0].purpose);
assert.deepEqual(disclosure.context('repair', '').readState, { componentIds: ['narrative', 'other-component'], sections: ['builder', 'assistant', 'combinations'], capabilities: [one, two] },
  'Editing a returned read ledger must not change subsequent selections or capability identities');
assert.deepEqual(disclosure.context('review', '').interactionPack?.components, guide.components);
assert.equal(JSON.stringify({ catalog, provider, guide }), original, 'Reads, errors, projections and returned-object edits never mutate source data');
assert.match(S2_DISCLOSURE_SELECT_PROMPT, /组件id和能力引用彼此独立/);
assert.match(S2_DISCLOSURE_SELECT_PROMPT, /sections:\["builder"\]/);
assert.match(S2_DISCLOSURE_SELECT_PROMPT, /blueprintRead/);
for (const prompt of [S2_DISCLOSURE_SELECT_PROMPT, S2_DISCLOSURE_CONTINUE_PROMPT]) {
  assert.ok(prompt.includes('componentIds只能取discoveryIndex.components[].id'));
  assert.ok(prompt.includes('discoveryIndex.plugins[].id不能放入componentIds'));
}
console.log('S2 progressive disclosure passed: indices without unread bodies/ports, explicit exact scoped reads, bounded atomic accumulation, required builder section, persistent selected details, third-party native shapes, pure-content choice, blueprint-required interfaces, and all candidate namespaces checked. Offline only.');
