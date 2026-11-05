import assert from 'node:assert/strict';
import type { SceneInteractionPackDefinition } from '../src/types/sceneInteractionPack';
import type { S2BlockType } from '../src/types/sceneS2';
import type { S2Json, S2PluginManifest, S2ValueSchema } from '../src/types/sceneS2Plugin';
import { readSceneInteractionPack } from '../src/services/scene/sceneInteractionPackProtocol';
import { installSceneInteractionCapabilities } from '../src/services/scene/sceneS2PluginRegistry';
import { compileS2PublicCanvas, publicS2Catalog } from '../src/services/scene/sceneS2PublicAuthoring';

const controls: S2BlockType = { id: 'controls', label: '原生取值规则', fields: [
  { id: 'text', label: '短文本', kind: 'text', required: true, maxLength: 4 },
  { id: 'multiline', label: '多行原文', kind: 'multiline' },
  { id: 'code', label: '代码原文', kind: 'code', maxLength: 10, language: 'python' },
  { id: 'choice', label: '选择', kind: 'enum', options: ['alpha', 'beta'], required: true },
  { id: 'count', label: '次数', kind: 'number', min: 0, max: 2, integer: true },
  { id: 'flag', label: '开关', kind: 'boolean', defaultValue: false },
  { id: 'items', label: '有限列表', kind: 'list', minItems: 1, maxItems: 2,
    item: { id: 'item', label: '列表项', kind: 'number', min: 0, max: 2, integer: true } },
  { id: 'form', label: '组合值', kind: 'form', fields: [
    { id: 'name', label: '必填名称', kind: 'text', required: true, maxLength: 3 },
    { id: 'choice', label: '可选选择', kind: 'enum', options: ['a', 'b'] },
  ] },
] };
const data: S2BlockType = { id: 'data', label: '结构化规则', fields: [
  { id: 'rows', label: '记录', kind: 'table', minItems: 1, maxItems: 2, columns: [
    { id: 'name', label: '名称', type: 'string', required: true },
    { id: 'score', label: '成绩', type: 'number', nullable: true },
    { id: 'enabled', label: '启用', type: 'boolean' },
  ], view: { kind: 'bar', xKey: 'name', yKey: 'score' } },
  { id: 'json', label: '完整 JSON', kind: 'json', defaultValue: null },
  { id: 'unbounded', label: '有限数值', kind: 'number' },
] };
const schemas: Record<string, S2ValueSchema> = {
  amount: { kind: 'number', integer: true, minimum: 0, maximum: 20 },
  mode: { kind: 'string', maxLength: 8, enum: ['alpha', 'beta'] },
  enabled: { kind: 'boolean' },
  raw: { kind: 'json', maxDepth: 3, maxEntries: 20, maxBytes: 100 },
  tags: { kind: 'array', maxItems: 2, item: { kind: 'string', maxLength: 4 } },
  record: { kind: 'object', fields: { name: { kind: 'string', maxLength: 4 }, active: { kind: 'boolean' } }, required: ['name'] },
  same: { kind: 'string', maxLength: 5 },
};
const plugin: S2PluginManifest = { protocolVersion: 1, id: 'public-value-rules', version: '1.0.0',
  label: '参数完整规则测试', meaning: '只声明和验证取值，不执行', dependencies: [],
  dataTypes: Object.entries(schemas).map(([id, schema]) => ({ id: `public-value-rules.${id}`, version: 1,
    meaning: id === 'amount' ? '金额单位为分，不是元' : id === 'same' ? '相同用途' : `${id} 的独立语义`, schema })),
  capabilities: [{ id: 'configure', kind: 'transform', meaning: '验证公开参数',
    inputs: Object.keys(schemas).map(id => ({ id, label: id, meaning: id === 'amount' ? '本次报价的金额' : id === 'same' ? '相同用途' : `${id} 的参数用途`,
      type: { id: `public-value-rules.${id}`, version: 1 }, required: false, multiple: false })), outputs: [],
    effect: 'pure', permissions: [], confirmation: 'none', retry: 'manual-only', timeoutMs: 1000 }],
};
const definition: SceneInteractionPackDefinition = {
  manifest: { protocolVersion: 1, id: 'public-value-rules-pack', version: '1.0.0', name: '完整公开参数',
    paradigm: 'S2', paradigmApiVersion: 1, requiredServices: ['execution'] }, capabilities: [plugin],
  authoring: { version: 1, components: [
    ...[controls, data].map(blockType => ({ id: blockType.id, label: blockType.label, purpose: '填写声明的原生值',
      implementation: { kind: 'content' as const, blockType }, inputs: [], outputs: [], parameters: blockType.fields.map(field => field.id),
      ...(blockType.id === 'controls' ? { defaults: { text: '', count: 0, flag: false } } : {}) })),
    { id: 'configure', label: '能力参数', purpose: '填写公开的参数值',
      implementation: { kind: 'capability', pluginId: plugin.id, pluginVersion: plugin.version, capabilityId: 'configure' },
      inputs: [], outputs: [], parameters: Object.keys(schemas), defaults: { amount: 0, enabled: false, raw: null } },
  ] },
  validate: () => [], executeLocal: async () => assert.fail('Parameter inspection must not execute package code'),
  createRuntime: () => assert.fail('Parameter inspection must not start a runtime'),
};
const previousFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('Parameter inspection must not make network requests');
try {
  const pack = readSceneInteractionPack(definition);
  installSceneInteractionCapabilities(pack);
  const catalog = publicS2Catalog(pack)!;
  const parameter = (component: string, id: string) => catalog.components.find(item => item.id === component)!.parameters.find(item => item.id === id)!;
  const values = (componentId: string, values: Record<string, S2Json>) => compileS2PublicCanvas(pack, { version: 1,
    nodes: [{ id: 'Example', componentId, position: { x: 0, y: 0 }, values }], connections: [] }, { goal: '公开值验证' });
  const accepts = (component: string, id: string, value: S2Json) => assert.doesNotThrow(() => values(component, { [id]: value }));
  const rejects = (component: string, id: string, value: S2Json) => assert.throws(() => values(component, { [id]: value }));

  assert.deepEqual(parameter('controls', 'text').field, { kind: 'text', required: true, maxLength: 4, serializedMaxLength: 6000 });
  assert.deepEqual(parameter('controls', 'items').field, { kind: 'list', required: false, minItems: 1, maxItems: 2,
    item: { kind: 'number', required: false, integer: true, min: 0, max: 2 }, serializedMaxLength: 6000 });
  assert.deepEqual(parameter('controls', 'form').field, { kind: 'form', required: false, additionalProperties: false, fields: [
    { id: 'name', label: '必填名称', kind: 'text', required: true, maxLength: 3 },
    { id: 'choice', label: '可选选择', kind: 'enum', required: false, options: ['a', 'b'] },
  ], serializedMaxLength: 6000 });
  assert.deepEqual(parameter('data', 'rows').field, { kind: 'table', required: false, minItems: 1, maxItems: 2,
    additionalProperties: false, columns: [
      { id: 'name', label: '名称', type: 'string', required: true, nullable: false },
      { id: 'score', label: '成绩', type: 'number', required: false, nullable: true },
      { id: 'enabled', label: '启用', type: 'boolean', required: false, nullable: false },
    ], structured: { maxDepth: 8, maxEntries: 2048, maxBytes: 24000 }, cellMaxBytes: 2000, serializedMaxLength: 6000 });
  assert.deepEqual(parameter('data', 'json').field, { kind: 'json', required: false,
    structured: { maxDepth: 8, maxEntries: 2048, maxBytes: 24000 }, serializedMaxLength: 6000 });
  assert.deepEqual(parameter('data', 'unbounded').field, { kind: 'number', required: false, integer: false, serializedMaxLength: 6000 });
  for (const component of catalog.components.filter(item => item.id !== 'configure')) for (const param of component.parameters) {
    assert.equal(param.allowBlank, true);
    for (const key of ['id', 'label', 'defaultValue', 'view', 'language']) assert.ok(!Object.hasOwn(param.field!, key), key);
    accepts(component.id, param.id, '');
  }
  assert.equal(parameter('controls', 'text').default, '');
  assert.equal(parameter('controls', 'count').default, 0);
  assert.equal(parameter('controls', 'flag').default, false);
  assert.equal(parameter('data', 'json').default, null);
  accepts('controls', 'text', 'four'); rejects('controls', 'text', 'longer'); rejects('controls', 'text', ' ');
  accepts('controls', 'code', 'print(1)'); rejects('controls', 'code', 'a'.repeat(11));
  accepts('controls', 'choice', 'alpha'); rejects('controls', 'choice', 'gamma');
  accepts('controls', 'count', 0); rejects('controls', 'count', 3); rejects('controls', 'count', 0.5);
  accepts('controls', 'flag', false); rejects('controls', 'flag', 0);
  accepts('controls', 'items', [0, 2]); rejects('controls', 'items', []); rejects('controls', 'items', [0, 1, 2]); rejects('controls', 'items', [3]);
  accepts('controls', 'form', { name: 'abc' }); rejects('controls', 'form', {}); rejects('controls', 'form', { name: ' ' });
  rejects('controls', 'form', { name: 'abc', other: 0 }); rejects('controls', 'form', { name: 'abc', choice: 'c' });
  accepts('data', 'rows', [{ name: '甲', score: null }, { name: '乙', score: 0, enabled: false }]);
  rejects('data', 'rows', []); rejects('data', 'rows', [{ score: 0 }]); rejects('data', 'rows', [{ name: null }]);
  rejects('data', 'rows', [{ name: '甲', score: '0' }]); rejects('data', 'rows', [{ name: '甲', other: 0 }]);
  rejects('data', 'rows', [{ name: '字'.repeat(667) }]);
  accepts('data', 'unbounded', 1e100);
  accepts('data', 'json', null); accepts('data', 'json', Array.from({ length: 2047 }, () => 0));
  rejects('data', 'json', Array.from({ length: 2048 }, () => 0)); rejects('data', 'json', 'x'.repeat(5999));
  let deep: S2Json = 0; for (let i = 0; i < 9; i++) deep = [deep]; rejects('data', 'json', deep);

  for (const [id, schema] of Object.entries(schemas)) {
    assert.deepEqual(parameter('configure', id).schema, schema);
    assert.equal(parameter('configure', id).meaning, id === 'amount' ? '本次报价的金额' : id === 'same' ? '相同用途' : `${id} 的参数用途`);
    assert.equal(parameter('configure', id).field, undefined);
  }
  assert.equal(parameter('configure', 'amount').typeMeaning, '金额单位为分，不是元');
  assert.equal(parameter('configure', 'same').typeMeaning, undefined, 'Exact duplicate meanings need not be repeated');
  assert.equal(parameter('configure', 'amount').default, 0);
  assert.equal(parameter('configure', 'enabled').default, false);
  assert.equal(parameter('configure', 'raw').default, null);
  accepts('configure', 'amount', 0); rejects('configure', 'amount', 21); rejects('configure', 'amount', 0.5);
  accepts('configure', 'mode', 'beta'); rejects('configure', 'mode', 'gamma');
  accepts('configure', 'raw', null); rejects('configure', 'raw', 'x'.repeat(101));
  accepts('configure', 'tags', ['abcd']); rejects('configure', 'tags', ['abcde']); rejects('configure', 'tags', ['a', 'b', 'c']);
  accepts('configure', 'record', { name: 'four', active: false }); rejects('configure', 'record', {}); rejects('configure', 'record', { name: 'four', extra: true });
  parameter('controls', 'items').field!.item!.max = 200;
  (parameter('configure', 'mode').schema as Extract<S2ValueSchema, { kind: 'string' }>).enum!.push('mutated');
  const fresh = publicS2Catalog(pack)!;
  assert.equal(fresh.components[0].parameters.find(item => item.id === 'items')!.field!.item!.max, 2);
  assert.deepEqual(fresh.components[2].parameters.find(item => item.id === 'mode')!.schema, schemas.mode);
  console.log('S2 public parameter rules passed: exact native limits, nested required values, closed forms/tables, missing/null/zero/false, finite unbounded numbers, complete capability schemas and independent semantic meanings. No runtime or network calls.');
} finally { globalThis.fetch = previousFetch; }
