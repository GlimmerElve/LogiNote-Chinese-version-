import assert from 'node:assert/strict';
import type { S2PluginManifest } from '../src/types/sceneS2Plugin';
import { readS2PluginManifest, S2PluginProtocolError, S2PluginRegistry } from '../src/services/scene/sceneS2PluginProtocol';

globalThis.fetch = async () => assert.fail('Registration checks must remain synthetic and offline');
const plugin = (id = 'example', typeId = `${id}.value`, release = '1.0.0', typeVersion = 1): S2PluginManifest => ({
  protocolVersion: 1, id, version: release, label: '示例组件', meaning: 'Synthetic registration only', dependencies: [],
  dataTypes: [{ id: typeId, version: typeVersion, meaning: 'Exact synthetic value', schema: { kind: 'string', maxLength: 40 } }],
  capabilities: [{ id: 'emit', kind: 'transform', meaning: 'Return synthetic value', inputs: [],
    outputs: [{ id: 'value', label: '内容', meaning: 'Full value', type: { id: typeId, version: typeVersion }, required: true, multiple: false }],
    effect: 'pure', permissions: [], confirmation: 'none', retry: 'manual-only', timeoutMs: 1000 }],
});
let checks = 0;
function rejects(code: string, operation: () => unknown) {
  assert.throws(operation, error => error instanceof S2PluginProtocolError && error.code === code);
  checks++;
}

// Both names satisfy namespace syntax, but a type ID must have exactly one plugin owner.
rejects('TYPE_OWNER_CONFLICT', () => new S2PluginRegistry([plugin('example', 'example.child.value'), plugin('example.child', 'example.child.value')]));
rejects('TYPE_OWNER_CONFLICT', () => new S2PluginRegistry([plugin('example.child', 'example.child.value'), plugin('example', 'example.child.value')]));
rejects('TYPE_OWNER_CONFLICT', () => new S2PluginRegistry([plugin('example', 'example.child.value'), plugin('example.child', 'example.child.value', '1.0.0', 2)]));
const versions = new S2PluginRegistry([plugin(), plugin('example', 'example.value', '1.1.0'), plugin('example', 'example.value', '2.0.0', 2)]);
assert.equal(versions.catalog().length, 3, 'One owner may retain the same contract across exact releases or introduce a new type version');
for (const field of ['kind', 'effect', 'confirmation', 'retry'] as const) {
  const coerced: any = plugin(); coerced.capabilities[0][field] = [coerced.capabilities[0][field]];
  rejects('INVALID_MANIFEST', () => readS2PluginManifest(coerced));
}
const coercedPermission: any = plugin();
coercedPermission.capabilities[0] = { ...coercedPermission.capabilities[0], kind: 'action', effect: 'external', confirmation: 'per-call', permissions: [['model-call']] };
rejects('INVALID_MANIFEST', () => readS2PluginManifest(coercedPermission));
const changed = plugin('example', 'example.value', '1.1.0');
changed.dataTypes[0].schema = { kind: 'string', maxLength: 41 };
rejects('TYPE_CONFLICT', () => new S2PluginRegistry([plugin(), changed]));
const consumer = plugin('consumer');
consumer.capabilities[0].outputs[0].type = { id: 'example.value', version: 2 };
consumer.dependencies = [{ id: 'example', version: '1.0.0' }];
rejects('DEPENDENCY_MISSING', () => new S2PluginRegistry([plugin(), plugin('example', 'example.value', '2.0.0', 2), consumer]));
const middle = plugin('middle'); middle.dependencies = [{ id: 'example', version: '1.0.0' }];
consumer.capabilities[0].outputs[0].type.version = 1;
consumer.dependencies = [{ id: 'middle', version: '1.0.0' }];
rejects('DEPENDENCY_MISSING', () => new S2PluginRegistry([plugin(), middle, consumer]));
consumer.dependencies = [{ id: 'example', version: '1.0.0' }];
assert.equal(new S2PluginRegistry([plugin(), consumer]).catalog().length, 2, 'Exact direct dependency owns the consumed type');

let accessorReads = 0;
const getter = plugin();
Object.defineProperty(getter, 'label', { enumerable: true, get() { accessorReads++; return 'Hidden code'; } });
rejects('INVALID_DATA', () => readS2PluginManifest(getter));
assert.equal(accessorReads, 0, 'Reject descriptors without executing getters');
let toJsonCalls = 0;
const serializer = { ...plugin(), toJSON() { toJsonCalls++; return plugin(); } };
rejects('INVALID_DATA', () => readS2PluginManifest(serializer));
assert.equal(toJsonCalls, 0, 'Manifest serialization hooks must never execute');

const symbol = plugin(); Object.defineProperty(symbol, Symbol('hidden'), { value: 'hidden', enumerable: false });
rejects('INVALID_DATA', () => readS2PluginManifest(symbol));
const nonEnumerable = plugin(); Object.defineProperty(nonEnumerable, 'hidden', { value: 'hidden', enumerable: false });
rejects('INVALID_DATA', () => readS2PluginManifest(nonEnumerable));
const customPrototype = Object.assign(Object.create({ hidden: true }), plugin());
rejects('INVALID_DATA', () => readS2PluginManifest(customPrototype));
class ManifestClass { constructor() { Object.assign(this, plugin()); } }
rejects('INVALID_DATA', () => readS2PluginManifest(new ManifestClass()));
assert.deepEqual(readS2PluginManifest(Object.assign(Object.create(null), plugin())), plugin(), 'Null-prototype JSON records are accepted and normalized');

const sparse = plugin(); sparse.dependencies = new Array(1);
rejects('INVALID_DATA', () => readS2PluginManifest(sparse));
const extraArray = plugin(); Object.defineProperty(extraArray.dependencies, 'hidden', { value: 'hidden', enumerable: false });
rejects('INVALID_DATA', () => readS2PluginManifest(extraArray));
const arrayGetter = plugin(); arrayGetter.dependencies.length = 1;
Object.defineProperty(arrayGetter.dependencies, '0', { enumerable: true, get() { accessorReads++; return { id: 'core', version: '1.0.0' }; } });
rejects('INVALID_DATA', () => readS2PluginManifest(arrayGetter));
assert.equal(accessorReads, 0);
const alteredArray = plugin(); Object.setPrototypeOf(alteredArray.dependencies, { custom: true });
rejects('INVALID_DATA', () => readS2PluginManifest(alteredArray));
const cycle: any = plugin(); cycle.cycle = cycle;
rejects('INVALID_DATA', () => readS2PluginManifest(cycle));
let deep: unknown = null;
for (let i = 0; i < 18; i++) deep = { value: deep };
rejects('DATA_LIMIT', () => readS2PluginManifest({ ...plugin(), deep }));
rejects('DATA_LIMIT', () => readS2PluginManifest({ ...plugin(), tooMany: Array.from({ length: 5 }, () => Array.from({ length: 2048 }, () => 0)) }));
rejects('INVALID_DATA', () => readS2PluginManifest({ ...plugin(), invalidNumber: Infinity }));
rejects('INVALID_DATA', () => readS2PluginManifest({ ...plugin(), absent: undefined }));

const registryArray: unknown[] = [plugin()];
Object.defineProperty(registryArray, '0', { enumerable: true, get() { accessorReads++; return plugin(); } });
rejects('INVALID_DATA', () => new S2PluginRegistry(registryArray));
assert.equal(accessorReads, 0, 'Registry container cannot execute a getter before manifest validation');
rejects('INVALID_DATA', () => new S2PluginRegistry(new Array(1)));
const iteratorArray = [plugin()]; let iteratorCalls = 0;
Object.defineProperty(iteratorArray, Symbol.iterator, { value: function* () { iteratorCalls++; yield plugin(); } });
rejects('INVALID_DATA', () => new S2PluginRegistry(iteratorArray));
assert.equal(iteratorCalls, 0, 'Custom iteration cannot bypass the container contract');
const registered = plugin(), stable = new S2PluginRegistry([registered]);
registered.label = 'Changed input'; registered.dataTypes[0].meaning = 'Changed meaning';
assert.equal(stable.plugin('example', '1.0.0').label, '示例组件');
assert.equal(stable.dataType({ id: 'example.value', version: 1 }).meaning, 'Exact synthetic value');
assert.equal(versions.catalog().length, 3, 'A failed registration never mutates an existing registry');

console.log(`S2 registration integrity passed: ${checks} rejection cases; exact-release type ownership, inert JSON data, bounded dense containers and immutable snapshots. Synthetic/offline only.`);
