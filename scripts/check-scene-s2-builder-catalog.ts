import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createS2BuilderCatalog } from '../src/services/scene/sceneS2BuilderCatalog';
import { s2BuiltinPluginRegistry, s2InstalledPluginCatalog } from '../src/services/scene/sceneS2PluginRegistry';
import type { S2DataType, S2PluginCapability, S2PluginManifest, S2ValueSchema } from '../src/types/sceneS2Plugin';

globalThis.fetch = async () => assert.fail('Builder catalogue checks must not read private data or call models/network');
// Start from the real generic base catalog, independent of any installed business package.
const source = s2InstalledPluginCatalog(null);
const before = JSON.stringify(source), projected = createS2BuilderCatalog(source, s2BuiltinPluginRegistry().catalog());
const refs = (plugins: Array<{ id: string; version: string; capabilities: Array<{ id: string; kind: string }> }>) =>
  plugins.flatMap(plugin => plugin.capabilities.filter(cap => cap.kind !== 'editor').map(cap => `${plugin.id}@${plugin.version}/${cap.id}`)).sort();
assert.deepEqual(refs(projected.plugins), refs(source.plugins), 'Every scoped executable capability stays discoverable');
assert.deepEqual(projected.fieldEditors, source.fieldEditors);
assert.equal(projected.representation, 's2-builder-catalog-v1');
assert.equal(JSON.stringify(source), before);
assert.match(projected.legend, /不是运行manifest或授权/);
assert.match(projected.legend, /literal.value直接填/);
assert.match(projected.legend, /本地完整契约校验/);
const originalSize = before.length, projectedSize = JSON.stringify(projected).length;
assert(projectedSize <= originalSize * .65, `Actual scoped catalogue must shrink by at least 35%: ${projectedSize}/${originalSize}`);

for (const field of ['timeoutMs', 'retry', 'confirmation', 'dependencies', 'maxDepth', 'maxEntries', 'maxBytes'])
  assert(!JSON.stringify(projected).includes(`"${field}":`), `Runtime-only field ${field} must not be an authoring property`);
for (const plugin of source.plugins) {
  const target = projected.plugins.find(item => item.id === plugin.id && item.version === plugin.version)!;
  assert.equal(target.meaning, plugin.meaning); assert.equal(target.label, plugin.label);
  for (const cap of plugin.capabilities.filter(cap => cap.kind !== 'editor')) {
    const actual = target.capabilities.find(item => item.id === cap.id)!;
    assert.equal(actual.meaning, cap.meaning); assert.equal(actual.effect, cap.effect);
    assert.deepEqual(actual.permissions ?? [], cap.permissions);
    for (const direction of ['inputs', 'outputs'] as const) cap[direction].forEach((port, index) => {
      const tuple = actual[direction][index];
      assert.deepEqual(tuple.slice(0, 4), [port.id, `${port.type.id}@${port.type.version}`, port.required, port.multiple]);
      assert.equal(tuple[4] ?? port.id, port.label);
      assert.equal(tuple[5] ?? `${port.id} 完整数据`, port.meaning);
      assert(projected.types.some(type => type.ref === tuple[1]), 'Every referenced exact semantic type has a native shape');
    });
  }
}

const schema: S2ValueSchema = { kind: 'object', fields: {
  state: { kind: 'string', maxLength: 40, enum: ['通过', '待核对', '拒绝'] },
  record: { kind: 'array', maxItems: 6, item: { kind: 'object', fields: {
    score: { kind: 'number', integer: false, minimum: -2.5, maximum: 9.75 },
    count: { kind: 'number', integer: true, minimum: 0, maximum: 8 }, approved: { kind: 'boolean' },
    note: { kind: 'string', maxLength: 123 }, data: { kind: 'json', maxDepth: 4, maxEntries: 55, maxBytes: 4096 },
  }, required: ['score', 'approved'] } },
}, required: ['state', 'record'] };
const types: S2DataType[] = [
  { id: 'vendor.record', version: 1, meaning: '版本一：开发者完整说明，不可缩写或改成业务推断。', schema },
  { id: 'vendor.record', version: 2, meaning: '版本二：同名但不同结构', schema: { kind: 'string', maxLength: 5, enum: ['a', 'b'] } },
];
const capability = (id: string, typeVersion: number, kind: S2PluginCapability['kind'] = 'transform'): S2PluginCapability => ({
  id, kind, meaning: '开发者自定义能力：原意和全部值形状须保留。',
  inputs: [{ id: 'payload', type: { id: 'vendor.record', version: typeVersion }, required: true, multiple: false,
    label: '原始记录（不是任意JSON）', meaning: '此处自定义含义不能按默认端口名或常见玩法删除。' }],
  outputs: [{ id: 'result', type: { id: 'vendor.record', version: typeVersion }, required: false, multiple: true,
    label: 'result', meaning: 'result 完整数据' }],
  effect: 'read', permissions: ['notes-read'], confirmation: 'per-call', retry: 'manual-only', timeoutMs: 1234,
});
const provider: S2PluginManifest = { protocolVersion: 1, id: 'vendor-types', version: '1.0.0', label: '类型供应者', meaning: '只提供精确类型，不开放能力',
  dependencies: [], dataTypes: types, capabilities: [capability('foreign', 1)] };
const first: S2PluginManifest = { protocolVersion: 1, id: 'custom-one', version: '1.0.0', label: '开发者自定义包', meaning: '不含提示词预设的自定义业务',
  dependencies: [{ id: provider.id, version: provider.version }], dataTypes: [], capabilities: [capability('same', 1), capability('editorOnly', 1, 'editor')] };
const second: S2PluginManifest = { ...structuredClone(first), id: 'custom-two', version: '2.0.0', capabilities: [capability('same', 2)] };
const custom = { protocolVersion: 1, schemaDialect: 's2-bounded-value-v2', fieldEditors: ['text'], plugins: [first, second] };
const customSnapshot = JSON.stringify(custom), providersSnapshot = JSON.stringify(provider);
const result = createS2BuilderCatalog(custom, [provider]);
assert.deepEqual(refs(result.plugins), ['custom-one@1.0.0/same', 'custom-two@2.0.0/same']);
assert(!result.plugins.some(plugin => plugin.id === provider.id), 'External type resolution never opens external executable scope');
assert.deepEqual(result.plugins[0].capabilities[0].inputs[0], ['payload', 'vendor.record@1', true, false,
  '原始记录（不是任意JSON）', '此处自定义含义不能按默认端口名或常见玩法删除。']);
assert.deepEqual(result.plugins[0].capabilities[0].outputs[0], ['result', 'vendor.record@1', false, true]);
assert.deepEqual(result.types, [
  { ref: 'vendor.record@1', meaning: types[0].meaning, shape: ['object', {
    state: ['string', 40, ['通过', '待核对', '拒绝']],
    record: ['array', ['object', { score: ['number', -2.5, 9.75], count: ['integer', 0, 8], approved: 'boolean', note: ['string', 123], data: 'JSON' }, ['score', 'approved']], 6],
  }, ['state', 'record']] },
  { ref: 'vendor.record@2', meaning: types[1].meaning, shape: ['string', 5, ['a', 'b']] },
]);
assert.equal(JSON.stringify(custom), customSnapshot); assert.equal(JSON.stringify(provider), providersSnapshot);
result.fieldEditors.push('projection-only'); result.plugins[0].capabilities[0].inputs[0][4] = 'modified';
(result.types[0].shape as ['object', Record<string, unknown>, string[]])[2].push('only-projection');
assert.equal(JSON.stringify(custom), customSnapshot); assert.equal(JSON.stringify(provider), providersSnapshot);
assert.throws(() => createS2BuilderCatalog(custom), /vendor.record@1.*完整声明/);
const conflicting = structuredClone(provider); conflicting.dataTypes[0].meaning = '同版本声明冲突';
assert.throws(() => createS2BuilderCatalog(custom, [provider, conflicting]), /完整声明冲突/);
assert.deepEqual(createS2BuilderCatalog({ ...custom, plugins: [] }).types, []);
const moduleSource = readFileSync('src/services/scene/sceneS2BuilderCatalog.ts', 'utf8');
assert(!/^import(?! type)/mu.test(moduleSource), 'Catalogue projection must be pure, without runtime package/host imports');
assert(!/prompt-lab|text-template|model-test/u.test(moduleSource), 'No business-special catalogue filtering');
console.log(`S2 builder catalogue passed: all ${refs(source.plugins).length} scoped capabilities retained, exact type versions and native value shapes, unchanged third-party meanings/enums and inputs, runtime-only fields omitted, no provider-scope expansion (${originalSize} -> ${projectedSize} chars, ${(100 * (1 - projectedSize / originalSize)).toFixed(1)}% smaller). Offline only.`);
