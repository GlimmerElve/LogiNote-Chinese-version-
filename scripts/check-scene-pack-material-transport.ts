import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createSceneInteractionPackStore } from '../src/electron/sceneInteractionPackStore';
import { registerSceneInteractionPackIpc } from '../src/electron/sceneInteractionPackIpc';
import { sceneInteractionPackAssets } from '../src/services/scene/sceneInteractionPackAssets';
import { scenePackAssetsPlugin } from './vite-scene-pack-assets.mjs';
import type { SceneInteractionPackManifest, SceneInteractionPackRef, ScenePackMaterialDescriptor } from '../src/types/sceneInteractionPack';

// Every disk fixture is inside a disposable workspace output directory. HTTP is
// intercepted in memory; no real browser, renderer activation or network is used.
const output = path.resolve('output');
await fs.mkdir(output, { recursive: true });
const temporary = await fs.mkdtemp(path.join(output, 'scene-pack-material-transport-'));
const storeRoot = path.join(temporary, 'store');
const oldFetch = globalThis.fetch, oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const text = Buffer.from('package one'), otherText = Buffer.from('package two');
const json = Buffer.from('{"series":[2,3,5]}');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
function material(id: string, file: string, mediaType: ScenePackMaterialDescriptor['mediaType'], data: Uint8Array): ScenePackMaterialDescriptor {
  return { id, label: id, path: file, mediaType, bytes: data.byteLength, sha256: createHash('sha256').update(data).digest('hex') };
}
function manifest(id: string, version: string, materials?: ScenePackMaterialDescriptor[]): SceneInteractionPackManifest {
  const common = { id, version, name: id, paradigm: 'S2' as const, paradigmApiVersion: 1 as const, requiredServices: [] };
  return materials === undefined ? { ...common, protocolVersion: 1 } : { ...common, protocolVersion: 2, materials };
}
const reference = (value: SceneInteractionPackManifest): SceneInteractionPackRef => ({ id: value.id, version: value.version });
async function writePack(root: string, value: SceneInteractionPackManifest, data = new Map<string, Uint8Array>()) {
  const folder = path.join(root, value.id, value.version);
  await fs.mkdir(folder, { recursive: true });
  await Promise.all(Object.entries({ 'manifest.json': JSON.stringify(value), 'main.js': 'export function activate(){ throw new Error("TRANSPORT_MUST_NOT_ACTIVATE"); }',
    'styles.css': '', 'agent.json': '{}' }).map(([file, bytes]) => fs.writeFile(path.join(folder, file), bytes)));
  for (const [file, bytes] of data) { const target = path.join(folder, file); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes); }
  return folder;
}
function bytes(result: { dataBase64: string }) { return Buffer.from(result.dataBase64, 'base64'); }
try {
  globalThis.fetch = async () => assert.fail('Material transport forbids real network/model calls');
  const descriptors = [material('guide', 'materials/guides/intro.txt', 'text/plain', text),
    material('series', 'materials/data/series.json', 'application/json', json), material('chart', 'materials/images/chart.png', 'image/png', png)];
  const first = manifest('transport-lab', '1.0.0', descriptors), second = manifest('transport-lab', '2.0.0', [material('guide', 'materials/guides/intro.txt', 'text/plain', otherText)]);
  const legacy = manifest('transport-legacy', '1.0.0');
  const firstFolder = await writePack(storeRoot, first, new Map([[descriptors[0].path, text], [descriptors[1].path, json], [descriptors[2].path, png]]));
  const secondFolder = await writePack(storeRoot, second, new Map([[descriptors[0].path, otherText]]));
  await writePack(storeRoot, legacy);
  const store = createSceneInteractionPackStore(storeRoot);
  assert.equal((await store.list()).packs.length, 3);
  assert.deepEqual(bytes(await store.readMaterial(reference(first), 'guide')), text);
  assert.deepEqual(bytes(await store.readMaterial(reference(second), 'guide')), otherText, 'Material IDs are scoped to exact versions');
  assert.deepEqual(bytes(await store.readMaterial(reference(first), 'chart')), png);
  const loaded = await store.load(reference(first));
  assert.deepEqual(Object.keys(loaded).sort(), ['codeBase64', 'manifest', 'styles'], 'Activation payload does not preload material bytes into IPC');
  assert.equal((await store.load(reference(legacy))).manifest.protocolVersion, 1, 'Existing four-file v1 packages still load');
  await assert.rejects(store.readMaterial(reference(legacy), 'guide'), /PACK_MATERIAL/);
  await assert.rejects(store.readMaterial(reference(first), '../materials/guides/intro.txt'), /PACK_MATERIAL/);
  await assert.rejects(store.readMaterial(reference(first), 'undeclared'), /PACK_MATERIAL/);
  await assert.rejects(store.readMaterial({ id: '../outside', version: '1.0.0' }, 'guide'), /ID|版本/);

  const wrongHash = manifest('transport-wrong-hash', '1.0.0', [material('guide', 'materials/intro.txt', 'text/plain', text)]);
  await writePack(storeRoot, wrongHash, new Map([['materials/intro.txt', otherText]]));
  await assert.rejects(store.load(reference(wrongHash)), /PACK_MATERIAL.*HASH|PACK_MATERIAL.*DIGEST/);
  await assert.rejects(store.readMaterial(reference(wrongHash), 'guide'), /PACK_MATERIAL.*HASH|PACK_MATERIAL.*DIGEST/);
  const oversized = manifest('transport-oversize', '1.0.0', [descriptors[0]]);
  await writePack(storeRoot, oversized, new Map([[descriptors[0].path, Buffer.alloc(1048577)]]));
  await assert.rejects(store.load(reference(oversized)), /PACK_MATERIAL_LIMIT/);
  const missing = manifest('transport-missing', '1.0.0', [descriptors[0]]);
  await writePack(storeRoot, missing);
  await assert.rejects(store.load(reference(missing)), /ENOENT/);
  const badMime = manifest('transport-bad-mime', '1.0.0', [material('chart', 'materials/chart.png', 'image/png', text)]);
  await writePack(storeRoot, badMime, new Map([['materials/chart.png', text]]));
  await assert.rejects(store.load(reference(badMime)), /PACK_MATERIAL/);
  const escaped = manifest('transport-bad-path', '1.0.0', [{ ...descriptors[0], path: 'materials/../outside.txt' }]);
  await writePack(storeRoot, escaped);
  await assert.rejects(store.load(reference(escaped)), /PACK_MATERIAL/);

  // Directory junctions work on Windows without enabling file-symlink privileges.
  // Both targets are disposable fixtures, never user files.
  const foreign = manifest('transport-foreign', '1.0.0', [descriptors[0]]);
  const foreignFolder = await writePack(storeRoot, foreign, new Map([[descriptors[0].path, text]]));
  for (const [id, version, target, content] of [['transport-cross-pack', '1.0.0', path.join(foreignFolder, 'materials'), text],
    [first.id, '3.0.0', path.join(secondFolder, 'materials'), otherText]] as const) {
    const linked = manifest(id, version, [material('guide', 'materials/link/guides/intro.txt', 'text/plain', content)]);
    const folder = await writePack(storeRoot, linked);
    await fs.mkdir(path.join(folder, 'materials'), { recursive: true });
    await fs.symlink(target, path.join(folder, 'materials/link'), 'junction');
    await assert.rejects(store.readMaterial(reference(linked), 'guide'), /PACK_MATERIAL_SCOPE/);
    await assert.rejects(store.load(reference(linked)), /PACK_MATERIAL_SCOPE/, 'Matching bytes cannot authorize cross-package or cross-version links');
  }

  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  registerSceneInteractionPackIpc({ handle: (channel, listener) => { handlers.set(channel, listener as (...args: unknown[]) => unknown); } }, { root: storeRoot });
  assert(handlers.has('scene-interaction-packs:read-material'));
  assert.deepEqual(bytes(await handlers.get('scene-interaction-packs:read-material')!({}, reference(first), 'series') as { dataBase64: string }), json);
  await assert.rejects(Promise.resolve().then(() => handlers.get('scene-interaction-packs:read-material')!({}, reference(first), 'materials/data/series.json')), /PACK_MATERIAL/);

  const webRoot = 'https://synthetic.invalid/app/scene-interaction-packs/';
  const routes = new Map<string, Uint8Array>(), fetched: string[] = [];
  routes.set('index.json', Buffer.from(JSON.stringify([first, second, legacy])));
  for (const value of [first, second, legacy]) {
    const prefix = `${value.id}/${value.version}/`;
    routes.set(prefix + 'manifest.json', Buffer.from(JSON.stringify(value))); routes.set(prefix + 'main.js', Buffer.from('export const activate = () => {};'));
    routes.set(prefix + 'styles.css', Buffer.from(''));
  }
  const firstPrefix = `${first.id}/${first.version}/`, secondPrefix = `${second.id}/${second.version}/`;
  for (const [file, data] of [[descriptors[0].path, text], [descriptors[1].path, json], [descriptors[2].path, png]] as const) routes.set(firstPrefix + file, data);
  routes.set(secondPrefix + descriptors[0].path, otherText);
  let spoofResponse = false;
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { baseURI: 'https://synthetic.invalid/app/index.html' } });
  globalThis.fetch = async (input, options) => {
    const url = String(input); assert(url.startsWith(webRoot)); assert.equal(options?.redirect, 'error'); assert.equal(options?.credentials, 'same-origin');
    const file = url.slice(webRoot.length); fetched.push(file);
    const response = new Response(routes.get(file) ?? '', { status: routes.has(file) ? 200 : 404 });
    if (spoofResponse && file === firstPrefix + descriptors[0].path) Object.defineProperty(response, 'url', { value: 'https://outside.invalid/foreign.txt' });
    return response;
  };
  const web = sceneInteractionPackAssets()!;
  assert.equal((await web.list()).packs.length, 3); assert.deepEqual(fetched, ['index.json'], 'Listing only reads metadata');
  assert.deepEqual(bytes(await web.readMaterial(reference(first), 'guide')), text);
  assert.deepEqual(bytes(await web.readMaterial(reference(second), 'guide')), otherText);
  assert.deepEqual(Object.keys(await web.load(reference(first))).sort(), ['codeBase64', 'manifest', 'styles']);
  assert.equal((await web.load(reference(legacy))).manifest.protocolVersion, 1);
  const beforeUndeclared = fetched.length;
  await assert.rejects(web.readMaterial(reference(first), 'materials/guides/intro.txt'), /PACK_MATERIAL/);
  assert.deepEqual(fetched.slice(beforeUndeclared), [firstPrefix + 'manifest.json'], 'Unknown IDs cannot become fetch paths');
  routes.delete(firstPrefix + descriptors[1].path);
  await assert.rejects(web.load(reference(first)), /404/);
  routes.set(firstPrefix + descriptors[1].path, json); routes.set(firstPrefix + descriptors[0].path, otherText);
  await assert.rejects(web.load(reference(first)), /PACK_MATERIAL.*HASH|PACK_MATERIAL.*DIGEST/);
  routes.set(firstPrefix + descriptors[0].path, Buffer.alloc(text.length + 1));
  await assert.rejects(web.load(reference(first)), /大小限制/, 'A streamed response cannot exceed its declared complete size');
  routes.set(firstPrefix + descriptors[0].path, text); spoofResponse = true;
  await assert.rejects(web.readMaterial(reference(first), 'guide'), /PACK_MATERIAL_SCOPE/);
  spoofResponse = false;
  routes.set(firstPrefix + 'manifest.json', Buffer.from(JSON.stringify(escaped)));
  await assert.rejects(web.load(reference(first)), /PACK_MATERIAL/);
  routes.set(firstPrefix + 'manifest.json', Buffer.from(JSON.stringify(first)));

  const viteRoot = path.join(temporary, 'vite-workspace'), viteSource = path.join(viteRoot, 'output/scene-interaction-packs');
  const viteFolder = await writePack(viteSource, first, new Map([[descriptors[0].path, text], [descriptors[1].path, json], [descriptors[2].path, png]]));
  await writePack(viteSource, legacy); await fs.writeFile(path.join(viteFolder, 'materials/unlisted.txt'), 'private unlisted data');
  const plugin = scenePackAssetsPlugin(viteRoot), emitted = new Map<string, Uint8Array>();
  await plugin.generateBundle.call({ emitFile(value: { fileName: string; source: Uint8Array }) { emitted.set(value.fileName, value.source); } });
  assert.deepEqual(Buffer.from(emitted.get('scene-interaction-packs/' + firstPrefix + descriptors[2].path)!), png);
  assert(![...emitted.keys()].some(file => file.includes('unlisted')));
  assert(emitted.has('scene-interaction-packs/transport-legacy/1.0.0/main.js'));
  let middleware: (request: unknown, response: unknown, next: () => void) => Promise<void>;
  plugin.configureServer({ middlewares: { use(handler: typeof middleware) { middleware = handler; } } });
  const request = async (file: string, method = 'GET') => {
    const result = { statusCode: 200, headers: new Map<string, unknown>(), body: undefined as unknown,
      setHeader(name: string, value: unknown) { this.headers.set(name, value); }, end(value?: unknown) { this.body = value; } };
    await middleware({ url: '/scene-interaction-packs/' + file, method }, result, () => assert.fail('Package route must be handled'));
    return result;
  };
  const image = await request(firstPrefix + descriptors[2].path);
  assert.equal(image.statusCode, 200); assert.equal(image.headers.get('Content-Type'), 'image/png'); assert.deepEqual(image.body, png);
  assert.equal((await request(firstPrefix + 'materials/unlisted.txt')).statusCode, 404);
  assert.equal((await request(firstPrefix + descriptors[0].path, 'POST')).statusCode, 405);
  await fs.writeFile(path.join(viteFolder, descriptors[0].path), otherText);
  await assert.rejects(plugin.generateBundle.call({ emitFile() { assert.fail('Invalid inventory cannot emit partial packages'); } }), /PACK_MATERIAL.*HASH|PACK_MATERIAL.*DIGEST/);
  await fs.writeFile(path.join(viteFolder, descriptors[0].path), text);
  const linkedManifest = { ...first, protocolVersion: 2 as const, materials: [material('guide', 'materials/link/guides/intro.txt', 'text/plain', otherText)] };
  await fs.writeFile(path.join(viteFolder, 'manifest.json'), JSON.stringify(linkedManifest));
  await fs.symlink(path.join(secondFolder, 'materials'), path.join(viteFolder, 'materials/link'), 'junction');
  await assert.rejects(plugin.generateBundle.call({ emitFile() { assert.fail('Cross-version materials cannot be emitted'); } }), /PACK_MATERIAL_SCOPE/);

  console.log('Scene package material transport passed: exact-version directory/IPC/Web material IDs, complete size/digest/MIME checks before activation, missing and undeclared data rejection, path and cross-package/version junction isolation, unchanged v1 loading, bounded same-origin nonredirecting Web reads, and Vite declared-only assets with atomic hash/scope rejection. Workspace output fixtures and mocked HTTP only; no activation/model/user-data IO.');
} finally {
  globalThis.fetch = oldFetch;
  if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else Reflect.deleteProperty(globalThis, 'document');
  const target = path.resolve(temporary);
  assert.equal(path.dirname(target), output); assert(path.basename(target).startsWith('scene-pack-material-transport-'));
  await fs.rm(target, { recursive: true, force: true });
}
