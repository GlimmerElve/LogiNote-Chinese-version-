import assert from 'node:assert/strict';
import type { SceneInteractionPackManifestV2, ScenePackMaterialDescriptor, ScenePackMaterialMediaType } from '../src/types/sceneInteractionPack';
import { readSceneInteractionPackManifest } from '../src/services/scene/sceneInteractionPackManifest';
import { findScenePackMaterial, readScenePackMaterialDescriptors, ScenePackMaterialError, verifyScenePackMaterialBytes } from '../src/services/scene/sceneInteractionPackMaterialProtocol';
import { promptLabManifest } from '../src/interaction-packs/prompt-lab/manifest';

globalThis.fetch = async () => assert.fail('Material protocol acceptance forbids network and model IO');
const encode = (value: string) => new TextEncoder().encode(value);
const hash = async (data: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(data).buffer)),
  value => value.toString(16).padStart(2, '0')).join('');
async function descriptor(data: Uint8Array, mediaType: ScenePackMaterialMediaType = 'text/plain', id = 'guide'): Promise<ScenePackMaterialDescriptor> {
  return { id, label: '包内说明', path: `materials/${id}.txt`, mediaType, bytes: data.byteLength, sha256: await hash(data) };
}
function failure(code: string, path: string) {
  return (error: unknown) => { assert(error instanceof ScenePackMaterialError, String(error)); assert.equal(error.code, code);
    assert(error.path.startsWith(path), `${error.path} must start with ${path}`); assert(error.message.includes(error.code)); return true; };
}
const data = encode('包内的固定原文 {{raw}} $&\n第二行。'), item = await descriptor(data);
const base: SceneInteractionPackManifestV2 = { ...promptLabManifest, protocolVersion: 2, materials: [item] };
assert.deepEqual(readSceneInteractionPackManifest(promptLabManifest), promptLabManifest, 'Existing prompt-lab v1 keeps its seven fields unchanged');
assert.deepEqual(Object.keys(readSceneInteractionPackManifest(promptLabManifest)).sort(),
  ['protocolVersion', 'id', 'version', 'name', 'paradigm', 'paradigmApiVersion', 'requiredServices'].sort());
assert.throws(() => readSceneInteractionPackManifest({ ...promptLabManifest, materials: [item] }), /清单字段不完整/);
const { materials: _materials, ...missing } = base;
assert.throws(() => readSceneInteractionPackManifest(missing), /清单字段不完整/);
assert.throws(() => readSceneInteractionPackManifest({ ...base, optionalMaterials: [] }), /清单字段不完整/);
assert.throws(() => readSceneInteractionPackManifest({ ...base, paradigmApiVersion: 2 }), /协议或S2接口版本不支持/);
const parsed = readSceneInteractionPackManifest(base);
assert.equal(parsed.protocolVersion, 2);
if (parsed.protocolVersion !== 2) assert.fail('Expected material manifest');
assert.deepEqual(parsed.materials, [item]);
const owned = findScenePackMaterial(parsed, 'guide'); owned.label = '不能污染清单';
assert.equal(parsed.materials[0].label, '包内说明');
assert.throws(() => findScenePackMaterial(promptLabManifest, 'guide'), failure('PACK_MATERIAL_NOT_FOUND', '/materials/guide'));
assert.throws(() => findScenePackMaterial(parsed, 'absent'), failure('PACK_MATERIAL_NOT_FOUND', '/materials/absent'));
assert.throws(() => findScenePackMaterial(parsed, '../guide'), failure('PACK_MATERIAL_ID', '/materials/id'));
const copy = readScenePackMaterialDescriptors([item]); copy[0].path = 'materials/changed.txt'; assert.equal(item.path, 'materials/guide.txt');

for (const path of ['../guide.txt', '/materials/guide.txt', 'C:/materials/guide.txt', 'materials\\guide.txt', 'materials/a/../guide.txt',
  'materials/./guide.txt', 'materials//guide.txt', 'materials/guide.txt/', 'materials/%2e%2e/guide.txt', 'materials/guide.txt?download',
  'materials/guide.txt#fragment', 'materials/中文.txt', 'materials/.hidden', 'materials/a b.txt', 'materials/', 'materials/\u0000.txt',
  'materials/file.', 'materials/NUL.txt', 'materials/COM1/data.json'])
  assert.throws(() => readScenePackMaterialDescriptors([{ ...item, path }]), failure('PACK_MATERIAL_PATH', '/materials/0/path'));
assert.doesNotThrow(() => readScenePackMaterialDescriptors([{ ...item, path: 'materials/figures/figure-01_v2.png' }]));
for (const id of ['', 'Upper', '1first', '-first', 'a'.repeat(65), 'with space', 'a/b'])
  assert.throws(() => readScenePackMaterialDescriptors([{ ...item, id }]), failure('PACK_MATERIAL_ID', '/materials/0/id'));
for (const label of ['', ' ', 'x'.repeat(81), '含\n换行'])
  assert.throws(() => readScenePackMaterialDescriptors([{ ...item, label }]), failure('PACK_MATERIAL_DESCRIPTOR', '/materials/0/label'));
for (const mediaType of ['text/html', 'image/svg+xml', 'application/pdf', 'TEXT/PLAIN', 'text/plain;charset=utf-8'])
  assert.throws(() => readScenePackMaterialDescriptors([{ ...item, mediaType }]), failure('PACK_MATERIAL_TYPE', '/materials/0/mediaType'));
for (const bytes of [-1, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1048577])
  assert.throws(() => readScenePackMaterialDescriptors([{ ...item, bytes }]), failure('PACK_MATERIAL_BYTES', '/materials/0/bytes'));
for (const sha256 of ['', '0'.repeat(63), '0'.repeat(65), 'g'.repeat(64), '0x' + '0'.repeat(64), ' '.repeat(64)])
  assert.throws(() => readScenePackMaterialDescriptors([{ ...item, sha256 }]), failure('PACK_MATERIAL_HASH', '/materials/0/sha256'));
assert.doesNotThrow(() => readScenePackMaterialDescriptors([{ ...item, sha256: item.sha256.toUpperCase() }]), 'Hex case does not change digest identity');
assert.throws(() => readScenePackMaterialDescriptors([item, { ...item, path: 'materials/another.txt' }]), failure('PACK_MATERIAL_DUPLICATE', '/materials/1/id'));
assert.throws(() => readScenePackMaterialDescriptors([item, { ...item, id: 'another' }]), failure('PACK_MATERIAL_DUPLICATE', '/materials/1/path'));
assert.throws(() => readScenePackMaterialDescriptors([item, { ...item, id: 'another', path: item.path.toUpperCase().replace('MATERIALS/', 'materials/') }]),
  failure('PACK_MATERIAL_DUPLICATE', '/materials/1/path'), 'Path aliases must not depend on the terminal filesystem case rules');
for (const value of [[], Array.from({ length: 17 }, () => item), null, {}])
  assert.throws(() => readScenePackMaterialDescriptors(value), failure('PACK_MATERIAL_LIMIT', '/materials'));
const full = Array.from({ length: 8 }, (_, index) => ({ ...item, id: `item-${index}`, path: `materials/item-${index}.txt`, bytes: 1048576 }));
assert.equal(readScenePackMaterialDescriptors(full).reduce((sum, value) => sum + value.bytes, 0), 8388608);
assert.throws(() => readScenePackMaterialDescriptors([...full, { ...item, id: 'overflow', path: 'materials/overflow.txt', bytes: 1 }]), failure('PACK_MATERIAL_LIMIT', '/materials'));
const oversized = Array.from({ length: 16 }, (_, index) => ({ ...item, id: `item-${index}`, path: `materials/item-${index}-${'a'.repeat(600)}.txt`, bytes: 1 }));
assert.throws(() => readSceneInteractionPackManifest({ ...base, materials: oversized }), /清单超过8192字节/);
let getterReads = 0;
const getter = { enumerable: true, get() { getterReads++; throw Error('No getter execution'); } };
assert.throws(() => readScenePackMaterialDescriptors([Object.defineProperty({ ...item }, 'path', getter)]), failure('PACK_MATERIAL_DESCRIPTOR', '/materials/0'));
assert.throws(() => readScenePackMaterialDescriptors(Object.defineProperty([item], '0', getter)), failure('PACK_MATERIAL_DESCRIPTOR', '/materials/0'));
assert.throws(() => readScenePackMaterialDescriptors(Array(1)), failure('PACK_MATERIAL_DESCRIPTOR', '/materials'));
assert.throws(() => readScenePackMaterialDescriptors(Object.assign([item], { extra: true })), failure('PACK_MATERIAL_DESCRIPTOR', '/materials'));
assert.throws(() => readScenePackMaterialDescriptors([{ ...item, permission: 'file-read' }]), failure('PACK_MATERIAL_DESCRIPTOR', '/materials/0'));
assert.equal(getterReads, 0);

const originalData = data.slice();
assert.equal(await verifyScenePackMaterialBytes(item, data), undefined); assert.deepEqual(data, originalData, 'Verification never rewrites source bytes');
await verifyScenePackMaterialBytes({ ...item, sha256: item.sha256.toUpperCase() }, data);
const wrapped = new Uint8Array(data.byteLength + 2); wrapped.set(data, 1);
await verifyScenePackMaterialBytes(item, wrapped.subarray(1, wrapped.byteLength - 1));
await assert.rejects(verifyScenePackMaterialBytes(item, data.subarray(1)), failure('PACK_MATERIAL_BYTES', '/materials/guide/bytes'));
await assert.rejects(verifyScenePackMaterialBytes(item, [] as any), failure('PACK_MATERIAL_BYTES', '/materials/guide/data'));
const changed = data.slice(); changed[0] ^= 1;
await assert.rejects(verifyScenePackMaterialBytes(item, changed), failure('PACK_MATERIAL_HASH', '/materials/guide/sha256'));
for (const invalid of [[0xc3, 0x28], [0xe2, 0x82], [0xc0, 0xaf], [0xff]]) {
  const bytes = Uint8Array.from(invalid);
  await assert.rejects(verifyScenePackMaterialBytes(await descriptor(bytes), bytes), failure('PACK_MATERIAL_UTF8', '/materials/guide/data'));
}
for (const text of ['{"value":"完整原文"}', '[0,false,null]', 'null', '42', '\uFEFF{"bom":true}']) {
  const bytes = encode(text); await verifyScenePackMaterialBytes(await descriptor(bytes, 'application/json'), bytes);
}
const brokenJson = encode('{"missing":}');
await assert.rejects(verifyScenePackMaterialBytes(await descriptor(brokenJson, 'application/json'), brokenJson), failure('PACK_MATERIAL_JSON', '/materials/guide/data'));
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]);
const webp = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
for (const [mediaType, bytes] of [['image/png', png], ['image/jpeg', jpeg], ['image/webp', webp]] as const) {
  await verifyScenePackMaterialBytes(await descriptor(bytes, mediaType), bytes);
  const forged = bytes.slice(); forged[0] = 0;
  await assert.rejects(verifyScenePackMaterialBytes(await descriptor(forged, mediaType), forged), failure('PACK_MATERIAL_TYPE', '/materials/guide/mediaType'));
}
await assert.rejects(verifyScenePackMaterialBytes(await descriptor(png, 'image/jpeg'), png), failure('PACK_MATERIAL_TYPE', '/materials/guide/mediaType'));
await assert.rejects(verifyScenePackMaterialBytes(await descriptor(encode('not an image'), 'image/png'), encode('not an image')), failure('PACK_MATERIAL_TYPE', '/materials/guide/mediaType'));
const maximumText = new Uint8Array(1048576).fill(0x61);
await verifyScenePackMaterialBytes(await descriptor(maximumText), maximumText);
console.log('Scene pack material protocol passed: unchanged seven-field v1 prompt manifest, strict eight-field v2 S2 manifest, safe ASCII paths, duplicate/accessor/count/byte/aggregate/manifest budgets, detached lookup, exact SHA-256 and lengths, fatal UTF-8/JSON checks, PNG/JPEG/WebP signature matching, subarray safety and unchanged caller bytes. No network, model, URL or UI operations.');
