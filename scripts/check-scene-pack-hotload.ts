import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { loadSceneInteractionPack, listSceneInteractionPacks, importSceneInteractionPack } from '../src/services/scene/sceneInteractionPackLoader';
import { sceneInteractionPacks } from '../src/services/scene/sceneInteractionPacks';
import { scenePackLocalAdapter } from '../src/services/scene/sceneInteractionHostServices';
const bundle = await build({ entryPoints: ['scripts/fixtures/s2-arithmetic-pack.ts'], bundle: true, format: 'esm', platform: 'browser', write: false });
const code = bundle.outputFiles[0].text;
const module = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
const original = module.activate({ ui: { react: {} } }).manifest;
const first = { id: original.id, version: original.version }, second = { ...first, version: '2.0.0' };
let installed = [original], failNext = false, loads = 0;
const listing = () => ({ managed: true, packs: structuredClone(installed), errors: [] as string[] });
let listCalls = 0, listOverride: (() => Promise<ReturnType<typeof listing>>) | undefined;
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const styles: Array<{ textContent?: string }> = [];
Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => ({ dataset: {} }), head: { appendChild: (style: any) => styles.push(style) } } });
Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: { sceneInteractionPacks: {
  list: () => { listCalls++; return listOverride ? listOverride() : Promise.resolve(listing()); },
  importPackage: async () => { installed = [original, { ...original, version: second.version }]; return { manifest: installed[1] }; },
  load: async (ref: typeof first) => {
    loads++; if (failNext) { failNext = false; throw Error('synthetic transient load failure'); }
    if (ref.version === '3.0.0') return { manifest: installed.find(pack => pack.version === ref.version),
      codeBase64: Buffer.from('globalThis.__invalidStyleExecuted=true;').toString('base64'), styles: '} body{color:red}' };
    const versioned = ref.version === first.version ? code : code.replace('version: "1.0.0"', 'version: "2.0.0"').replace('String(a + b)', 'String(a + b + 100)');
    return { manifest: installed.find(pack => pack.version === ref.version), codeBase64: Buffer.from(versioned).toString('base64'), styles: '.probe{color:green}' };
  },
} } } });
globalThis.fetch = async () => assert.fail('Hot install never calls network/model');
const failedDiscovery = deferred<ReturnType<typeof listing>>(); listOverride = () => failedDiscovery.promise;
const failures = Promise.allSettled([listSceneInteractionPacks(), listSceneInteractionPacks(), loadSceneInteractionPack(first)]);
assert.equal(listCalls, 1, 'Concurrent discovery and loading share one directory read');
failedDiscovery.reject(new Error('synthetic transient discovery failure'));
assert((await failures).every(item => item.status === 'rejected' && /transient discovery/.test(String(item.reason))));
assert.equal(loads, 0); assert.equal(styles.length, 0);
const recoveringDiscovery = deferred<ReturnType<typeof listing>>(); listOverride = () => recoveringDiscovery.promise;
const recovering = Promise.all([listSceneInteractionPacks(), listSceneInteractionPacks(), loadSceneInteractionPack(first), loadSceneInteractionPack(first)]);
assert.equal(listCalls, 2, 'Retry without reload/explicit refresh also stays single-flight');
recoveringDiscovery.resolve(listing()); await recovering;
assert.equal(loads, 1, 'Concurrent callers activate one exact package only once'); assert.equal(styles.length, 1);
// Explicit refresh may supersede a pending read. Its old failure must not clear
// the newer successful cache and cause a third redundant directory request.
const staleDiscovery = deferred<ReturnType<typeof listing>>(); listOverride = () => staleDiscovery.promise;
const staleRead = assert.rejects(listSceneInteractionPacks({ refresh: true }), /superseded discovery/);
const newerDiscovery = deferred<ReturnType<typeof listing>>(); listOverride = () => newerDiscovery.promise;
const freshRead = listSceneInteractionPacks({ refresh: true });
newerDiscovery.resolve(listing()); await freshRead;
const afterRefresh = listCalls;
staleDiscovery.reject(new Error('synthetic superseded discovery failure')); await staleRead;
listOverride = undefined; await listSceneInteractionPacks();
assert.equal(listCalls, afterRefresh, 'A late old failure cannot evict a newer successful listing');
console.log('PASS discovery recovery: shared failed requests, automatic retry, single activation and late-failure/new-refresh isolation');
await listSceneInteractionPacks({ refresh: true }); await loadSceneInteractionPack(first);
const old = sceneInteractionPacks.resolve(first), oldAdapter = scenePackLocalAdapter(first);
const call: any = { pluginId: 'arithmetic', pluginVersion: '1.0.0', capabilityId: 'sum' };
const inputs: any = { a: [2], b: [3] }, signal = new AbortController().signal;
const value = (result: any) => result.outputs.text[0].payload.value;
assert.equal(value(await oldAdapter(call, inputs, signal)), '5');
await importSceneInteractionPack();
failNext = true; await assert.rejects(loadSceneInteractionPack(second), /transient/);
await loadSceneInteractionPack(second);
assert.equal(sceneInteractionPacks.resolve(first), old, 'updating must not replace the exact old object');
assert.equal(value(await oldAdapter(call, inputs, signal)), '5');
assert.equal(value(await scenePackLocalAdapter(second)(call, inputs, signal)), '105', 'new scene binds new code even with shared compatible capability IDs');
assert.equal(styles.length, 2);
assert(styles[0].textContent?.includes(`data-scene-pack="${first.id}@${first.version}"`));
assert(styles[1].textContent?.includes(`data-scene-pack="${second.id}@${second.version}"`));
await loadSceneInteractionPack(first); assert.equal(loads, 3, 'old code remains pinned and new failed load can retry without restart');
const third = { ...first, version: '3.0.0' };
installed.push({ ...original, version: third.version }); await listSceneInteractionPacks({ refresh: true });
await assert.rejects(loadSceneInteractionPack(third), /Unexpected/);
assert.equal((globalThis as any).__invalidStyleExecuted, undefined, 'invalid stylesheet is rejected before entry code and capability publication');
assert.equal(sceneInteractionPacks.resolve(first), old); assert.equal(styles.length, 2);
console.log('PASS hot loading: new version visible immediately, old adapter/object unchanged, new adapter uses new code, compatible capability contracts stay stable, failed activation retry and release-scoped styles');
