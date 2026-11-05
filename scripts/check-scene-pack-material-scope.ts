import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { SceneInteractionPackManifest, ScenePackMaterialScope } from '../src/types/sceneInteractionPack';
import type { S2PluginInvocation } from '../src/types/sceneS2Plugin';
import { createScenePackMaterialScope, executeScenePackLocal, prepareScenePackMaterials, setScenePackMaterialAvailability } from '../src/services/scene/sceneInteractionPackMaterials';
import { activate } from './fixtures/s2-arithmetic-pack';

globalThis.fetch = async () => assert.fail('Material scopes must not use external IO');
function fixture(version: string, value: number) {
  const data = Buffer.from(JSON.stringify({ value }));
  const manifest: SceneInteractionPackManifest = { protocolVersion: 2, id: 'scoped-fixture', version, name: '独立物料作用域', paradigm: 'S2', paradigmApiVersion: 1,
    requiredServices: ['execution'], materials: [{ id: 'data', label: '数值', path: 'materials/data.json', mediaType: 'application/json', bytes: data.length,
      sha256: createHash('sha256').update(data).digest('hex') }] };
  return { manifest, data, ref: { id: manifest.id, version: manifest.version } };
}
const a = fixture('1.0.0', 3), b = fixture('2.0.0', 9);
let reads = 0, gate: Promise<void> | undefined, unlock: (() => void) | undefined;
const commitA = await prepareScenePackMaterials(a.manifest, async () => { reads++; await gate; return { dataBase64: a.data.toString('base64') }; });
commitA();
(await prepareScenePackMaterials(b.manifest, async () => ({ dataBase64: b.data.toString('base64') })))();
const scopeA = createScenePackMaterialScope(a.ref)!, scopeB = createScenePackMaterialScope(b.ref)!;
const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL;
const created: string[] = [], revoked: string[] = [];
URL.createObjectURL = blob => { assert(blob instanceof Blob); assert.equal(blob.type, 'application/json'); const url = `blob:material-scope-${created.length}`; created.push(url); return url; };
URL.revokeObjectURL = url => { revoked.push(url); };
try {
  const readA = await scopeA.read('data');
  assert.equal(JSON.parse(new TextDecoder().decode(readA.data)).value, 3);
  assert.equal(JSON.parse(new TextDecoder().decode((await scopeB.read('data')).data)).value, 9, 'Identical IDs resolve to exact owner versions');
  readA.data.fill(0);
  assert.deepEqual((await scopeA.read('data')).data, new Uint8Array(a.data), 'Readers receive independent complete bytes');
  const labels = scopeA.list(); labels[0].label = 'caller mutation'; assert.notEqual(scopeA.list()[0].label, labels[0].label);
  const beforeUnknown = reads;
  await assert.rejects(scopeA.read('../other-package/data'), /PACK_MATERIAL/);
  await assert.rejects(scopeA.read('other-package'), /PACK_MATERIAL/);
  assert.equal(reads, beforeUnknown, 'Unknown material IDs are rejected before transport');

  const lease = await scopeA.openUrl('data'); lease.release(); lease.release();
  assert.equal(revoked.filter(url => url === lease.url).length, 1, 'Lease release is idempotent');
  const auto = await scopeA.openUrl('data'); scopeA.dispose(); scopeA.dispose();
  assert.equal(revoked.filter(url => url === auto.url).length, 1, 'Scope disposal releases every live URL once');
  await assert.rejects(scopeA.read('data'), /PACK_MATERIAL_CLOSED/);

  const pendingScope = createScenePackMaterialScope(a.ref)!;
  gate = new Promise<void>(resolve => { unlock = resolve; });
  const createdBefore = created.length, pending = pendingScope.openUrl('data');
  pendingScope.dispose();
  await assert.rejects(pending, /PACK_MATERIAL_CLOSED/);
  unlock!(); gate = undefined;
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(created.length, createdBefore, 'Late completion after scope disposal never creates a display URL');

  const abortedScope = createScenePackMaterialScope(a.ref)!, controller = new AbortController();
  gate = new Promise<void>(resolve => { unlock = resolve; });
  const aborted = abortedScope.read('data', controller.signal); controller.abort();
  await assert.rejects(aborted, /PACK_MATERIAL_CANCELLED/);
  unlock!(); gate = undefined; abortedScope.dispose();

  const invocation: S2PluginInvocation = { protocolVersion: 1, id: 'call', sceneId: 'scene', runId: 'run', nodeId: 'node', revision: 0,
    pluginId: 'arithmetic', pluginVersion: '1.0.0', capabilityId: 'sum', idempotencyKey: 'call', inputs: {} };
  let owned: ScenePackMaterialScope | undefined;
  const pack = { ...activate({ editor: {} as never, ui: { react: {} } }), manifest: a.manifest,
    executeLocal: async (_call: S2PluginInvocation, _inputs: unknown, _signal: AbortSignal, context?: { materials?: ScenePackMaterialScope }) => {
      owned = context?.materials; assert(owned); await owned.read('data');
      return { status: 'failed' as const, outputs: {}, error: { code: 'EXPECTED', message: '无结果测试' } };
    } };
  await executeScenePackLocal(pack, invocation, {}, new AbortController().signal);
  await assert.rejects(owned!.read('data'), /PACK_MATERIAL_CLOSED/, 'A completed component cannot retain its host scope');
  const failing = { ...pack, executeLocal: async (...args: Parameters<typeof pack.executeLocal>) => {
    owned = args[3]?.materials; throw new Error('COMPONENT_FAILED');
  } };
  await assert.rejects(executeScenePackLocal(failing, invocation, {}, new AbortController().signal), /COMPONENT_FAILED/);
  await assert.rejects(owned!.read('data'), /PACK_MATERIAL_CLOSED/, 'Component failures also release scope authority');

  const live = createScenePackMaterialScope(a.ref)!, unavailableLease = await live.openUrl('data');
  setScenePackMaterialAvailability([b.ref]);
  assert(revoked.includes(unavailableLease.url));
  await assert.rejects(live.read('data'), /PACK_MATERIAL_CLOSED/);
  assert.throws(() => createScenePackMaterialScope(a.ref), /PACK_MATERIAL_UNAVAILABLE/);
  assert.equal(JSON.parse(new TextDecoder().decode((await scopeB.read('data')).data)).value, 9, 'Revoking one release leaves another owner live');

  const withdrawn = fixture('3.0.0', 11);
  setScenePackMaterialAvailability([b.ref, withdrawn.ref]);
  gate = new Promise<void>(resolve => { unlock = resolve; });
  const preparing = prepareScenePackMaterials(withdrawn.manifest, async () => { await gate; return { dataBase64: withdrawn.data.toString('base64') }; });
  setScenePackMaterialAvailability([b.ref]); unlock!(); gate = undefined;
  const withdrawnCommit = await preparing;
  assert.throws(withdrawnCommit, /PACK_MATERIAL_UNAVAILABLE/, 'An asynchronous preflight cannot republish a withdrawn owner');
  assert.equal(createScenePackMaterialScope(withdrawn.ref), undefined);

  const broken = { ...a.manifest, id: 'bad-scoped-fixture' };
  await assert.rejects(prepareScenePackMaterials(broken, async () => ({ dataBase64: b.data.toString('base64') })), /PACK_MATERIAL/);
  assert.equal(createScenePackMaterialScope({ id: broken.id, version: broken.version }), undefined, 'Invalid preflight never publishes a provider');
  console.log('Package material scopes passed: exact-owner ID-only reads, complete detached bytes, unknown-ID pre-transport denial, hash preflight, URL ownership/idempotent cleanup, prompt cancellation and late-result denial, invocation success/failure cleanup and package availability revocation. No UI, model or external IO.');
} finally {
  unlock?.(); scopeA.dispose(); scopeB.dispose(); setScenePackMaterialAvailability([]);
  URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke;
}
