import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { sceneInteractionPacks } from '../src/services/scene/sceneInteractionPacks';
import { listSceneInteractionPacks, loadSceneInteractionPack } from '../src/services/scene/sceneInteractionPackLoader';
import { s2BuiltinPluginRegistry } from '../src/services/scene/sceneS2PluginRegistry';
import { sceneInteractionPackAssets } from '../src/services/scene/sceneInteractionPackAssets';

assert.deepEqual(sceneInteractionPacks.catalog(), [], 'No business package is registered by terminal startup');
assert(!s2BuiltinPluginRegistry().catalog().some(plugin => ['text-template', 'model-test'].includes(plugin.id)));
const bundle = await build({ entryPoints: ['scripts/fixtures/s2-arithmetic-pack.ts'], bundle: true, format: 'esm', platform: 'browser', write: false });
const code = bundle.outputFiles[0].text;
const primary = { protocolVersion: 1, id: 'arithmetic-lab', version: '1.0.0', name: '独立计算包', paradigm: 'S2', paradigmApiVersion: 1, requiredServices: ['execution'] };
// Use actual metadata from the independent entry, rather than guessing the declaration's display name.
const mod = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
Object.assign(primary, mod.activate({ ui: { react: {} } }).manifest);
const secondary = { ...primary, id: 'arithmetic-extra' };
const root = 'https://synthetic.invalid/app/scene-interaction-packs/';
const routes = new Map<string, string>([['index.json', JSON.stringify([primary, secondary])]]);
for (const manifest of [primary, secondary]) {
  const prefix = `${manifest.id}/${manifest.version}/`;
  routes.set(prefix + 'manifest.json', JSON.stringify(manifest));
  routes.set(prefix + 'main.js', code.replaceAll('arithmetic-lab', manifest.id));
  routes.set(prefix + 'styles.css', '.independent-package { color: inherit; }');
}
const fetched: string[] = [], styles: unknown[] = [];
const previousFetch = globalThis.fetch;
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
try {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    baseURI: 'https://synthetic.invalid/app/index.html', createElement: () => ({ dataset: {} }), head: { appendChild: (style: unknown) => styles.push(style) },
  } });
  globalThis.fetch = async (input, options) => {
    const url = String(input); assert(url.startsWith(root)); assert.equal(options?.redirect, 'error');
    const file = url.slice(root.length); fetched.push(file);
    return new Response(routes.get(file) ?? '', { status: routes.has(file) ? 200 : 404 });
  };
  const listing = await listSceneInteractionPacks();
  assert.deepEqual(listing.packs.map(pack => pack.id), [primary.id, secondary.id]);
  assert.deepEqual(fetched, ['index.json'], 'Listing does not execute or read package code');
  assert.deepEqual(sceneInteractionPacks.catalog(), []);
  const firstRef = { id: primary.id, version: primary.version }, secondRef = { id: secondary.id, version: secondary.version };
  await loadSceneInteractionPack(firstRef);
  await loadSceneInteractionPack(secondRef);
  assert.deepEqual(sceneInteractionPacks.catalog().map(pack => pack.id), [primary.id, secondary.id], 'Loading one package does not disable the asset provider for the next');
  assert.equal(styles.length, 2);
  const count = fetched.length; await loadSceneInteractionPack(firstRef); assert.equal(fetched.length, count, 'Exact code is activated once');
  await assert.rejects(() => loadSceneInteractionPack({ id: 'prompt-lab', version: '0.1.0' }), /缺少交互包/);
  assert.equal(fetched.length, count, 'No hidden default package or missing package code is fetched');
  const api = sceneInteractionPackAssets()!;
  await assert.rejects(() => api.load({ id: '../escape', version: '1.0.0' }), /ID|版本/);
  routes.set('index.json', JSON.stringify([{ ...primary, code: 'not metadata' }]));
  assert.equal((await api.list()).packs.length, 0);
  console.log('Independent package assets passed: empty terminal, metadata-only discovery, two separate ESM packages loaded through one stable provider, single activation/styles, no default-source fallback, missing/path/invalid-index denial. Mock same-origin assets only.');
} finally {
  globalThis.fetch = previousFetch;
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window');
  if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else Reflect.deleteProperty(globalThis, 'document');
}
