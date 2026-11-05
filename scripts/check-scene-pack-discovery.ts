import assert from 'node:assert/strict';
import { listSceneInteractionPacks } from '../src/services/scene/sceneInteractionPackLoader';
import { sceneInteractionPacks } from '../src/services/scene/sceneInteractionPacks';
import type { SceneInteractionPackManifest } from '../src/types/sceneInteractionPack';

globalThis.fetch = async () => assert.fail('Package discovery must not make network/model calls');
const fallback = sceneInteractionPacks.catalog();
const prompt = fallback.find(pack => pack.id === 'prompt-lab')!;
assert(prompt, 'Builtin compatibility registration is available to unmanaged hosts');
const plainKeys = ['protocolVersion', 'id', 'version', 'name', 'paradigm', 'paradigmApiVersion', 'requiredServices'].sort();
function assertPlainManifests(packs: SceneInteractionPackManifest[]) {
  for (const manifest of packs) {
    assert.deepEqual(Object.keys(manifest).sort(), plainKeys);
    assert.deepEqual(JSON.parse(JSON.stringify(manifest)), manifest, 'Discovery exposes plain serializable manifests only');
    assert(Object.values(manifest).every(value => typeof value !== 'function'));
  }
}
const priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
let listCalls = 0, loadCalls = 0;
let state: { managed: boolean; packs: unknown[]; errors: string[] } = { managed: false, packs: [], errors: ['目录服务未启用'] };
const mockApi = {
  async list() { listCalls++; return structuredClone(state); },
  async load() { loadCalls++; assert.fail('Listing package choices must never read or activate package code'); },
};
try {
  Reflect.deleteProperty(globalThis, 'window');
  assert.deepEqual(await listSceneInteractionPacks(), { managed: false, packs: fallback, errors: [] });
  assert.equal(listCalls, 0);
  assertPlainManifests((await listSceneInteractionPacks()).packs);

  Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: { sceneInteractionPacks: mockApi } } });
  const unmanaged = await listSceneInteractionPacks();
  assert.equal(unmanaged.managed, false);
  assert.deepEqual(unmanaged.packs, fallback);
  assert.deepEqual(unmanaged.errors, ['目录服务未启用']);
  unmanaged.errors.push('caller mutation');
  assert.deepEqual((await listSceneInteractionPacks()).errors, ['目录服务未启用']);
  assert.equal(listCalls, 1, 'Default discovery reuses the cached directory response');

  const custom: SceneInteractionPackManifest = { protocolVersion: 1, id: 'discovery-only', version: '1.0.0', name: '仅清单，无执行入口',
    paradigm: 'S2', paradigmApiVersion: 1, requiredServices: ['execution'] };
  state = { managed: true, packs: [prompt, custom,
    { ...custom, id: '../invalid' }, { ...custom, version: 'latest' }, { ...custom, codeBase64: 'code must not be accepted' }], errors: ['一个损坏目录已跳过'] };
  const managed = await listSceneInteractionPacks({ refresh: true });
  assert.equal(listCalls, 2);
  assert.equal(managed.managed, true);
  assert.deepEqual(managed.packs, [prompt, custom], 'Invalid manifests must not hide valid choices');
  assert.equal(managed.errors.length, 4);
  assert.equal(managed.errors[0], '一个损坏目录已跳过');
  assertPlainManifests(managed.packs);
  assert.equal(sceneInteractionPacks.isAvailable(prompt), true);
  assert.equal(sceneInteractionPacks.isAvailable(custom), true);
  assert.throws(() => sceneInteractionPacks.resolve({ id: custom.id, version: custom.version }), /缺少交互包/,
    'Discovering a manifest does not register executable code');
  managed.packs[0].name = 'caller mutation';
  managed.packs[0].requiredServices.length = 0;
  managed.errors.push('caller mutation');
  const cached = await listSceneInteractionPacks();
  assert.deepEqual(cached.packs, [prompt, custom]);
  assert.equal(cached.errors.length, 4);
  assert.equal(listCalls, 2);

  const customV2 = { ...custom, version: '2.0.0' };
  state = { managed: true, packs: [customV2], errors: [] };
  assert.deepEqual((await listSceneInteractionPacks()).packs, [prompt, custom], 'Directory changes take effect on explicit refresh');
  assert.equal(listCalls, 2);
  const refreshed = await listSceneInteractionPacks({ refresh: true });
  assert.equal(listCalls, 3);
  assert.deepEqual(refreshed, { managed: true, packs: [customV2], errors: [] });
  assert.equal(sceneInteractionPacks.isAvailable(prompt), false);
  assert.equal(sceneInteractionPacks.isAvailable(custom), false);
  assert.equal(sceneInteractionPacks.isAvailable(customV2), true, 'Availability follows exact versions from the refreshed directory');
  assert.throws(() => sceneInteractionPacks.resolve({ id: prompt.id, version: prompt.version }), /缺少交互包/);
  assert.deepEqual(sceneInteractionPacks.catalog(), fallback, 'Availability refresh retains registrations and saved data');

  state = { managed: true, packs: [], errors: [] };
  await listSceneInteractionPacks({ refresh: true });
  assert.equal(sceneInteractionPacks.isAvailable(customV2), false);
  state = { managed: false, packs: [], errors: [] };
  assert.deepEqual(await listSceneInteractionPacks({ refresh: true }), { managed: false, packs: fallback, errors: [] });
  assert.doesNotThrow(() => sceneInteractionPacks.resolve({ id: prompt.id, version: prompt.version }),
    'Unmanaged fallback choices must be available even after an earlier managed discovery');

  state = { managed: true, packs: [], errors: [] };
  await listSceneInteractionPacks({ refresh: true });
  Reflect.deleteProperty(globalThis, 'window');
  assert.deepEqual(await listSceneInteractionPacks(), { managed: false, packs: fallback, errors: [] });
  assert.doesNotThrow(() => sceneInteractionPacks.resolve({ id: prompt.id, version: prompt.version }),
    'No-API fallback must restore executable availability for the fallback choices it lists');
  assert.equal(loadCalls, 0);
  console.log('Scene package discovery passed: plain manifest listing without code loading, managed/unmanaged/no-API fallbacks, invalid-entry isolation, immutable results, cached lists and explicit exact-version availability refresh. No network/model calls.');
} finally {
  if (priorWindow) Object.defineProperty(globalThis, 'window', priorWindow);
  else Reflect.deleteProperty(globalThis, 'window');
  sceneInteractionPacks.setAvailable(fallback);
}
