import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { buildSync } from 'esbuild';
import { zipSync, strToU8 } from 'fflate';
import { createH5pStore } from '../src/electron/h5pStore';
import type { registerH5pHost } from '../src/electron/h5pHost';
const require = createRequire(import.meta.url);
function production<T>(file: string, overrides: Record<string, unknown>): T {
  const code = buildSync({ entryPoints: [file], bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false }).outputFiles[0].text;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)((name: string) => name in overrides ? overrides[name] : require(name), module, module.exports);
  return module.exports as T;
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function within<T>(operation: Promise<T>, timeout = 1500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('synthetic test deadline exceeded')), timeout); })]); }
  finally { clearTimeout(timer); }
}
const fixture = (title: string) => Buffer.from(zipSync({
  'h5p.json': strToU8(JSON.stringify({ title, mainLibrary: 'H5P.Probe', preloadedDependencies: [{ machineName: 'H5P.Probe', majorVersion: 1, minorVersion: 0 }] })),
  'content/content.json': strToU8('{}'),
  'H5P.Probe-1.0/library.json': strToU8(JSON.stringify({ machineName: 'H5P.Probe', majorVersion: 1, minorVersion: 0, patchVersion: 0, preloadedJs: [{ path: 'main.js' }] })),
  'H5P.Probe-1.0/main.js': strToU8('window.synthetic=true;'),
}));
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'loginote-h5p-isolation-'));
let host: ReturnType<typeof registerH5pHost> | undefined, releaseWrite = () => {};
try {
  const seed = createH5pStore(root), a = await seed.importBytes(fixture('A')), b = await seed.importBytes(fixture('B'));
  await seed.saveProgress(a.id, { state: { count: 9 } }); await seed.saveProgress(b.id, { state: { count: 1 } });
  let blockNextB = false, rejectB = false, entered = () => {};
  const faultFs = new Proxy(fs, { get(target, key: keyof typeof fs) {
    if (key === 'rename') return async (from: string, to: string) => {
      if (to.endsWith(`${b.id}.json`)) {
        if (blockNextB) { blockNextB = false; entered(); await new Promise<void>(resolve => { releaseWrite = resolve; }); }
        if (rejectB) throw Object.assign(Error('synthetic B-only write failure'), { code: 'EACCES' });
      }
      return target.rename(from, to);
    };
    return target[key];
  } });
  const store = production<{ createH5pStore: typeof createH5pStore }>('src/electron/h5pStore.ts', { 'node:fs/promises': faultFs, 'fs/promises': faultFs }).createH5pStore(root);
  const gate = () => { blockNextB = true; return new Promise<void>(resolve => { entered = resolve; }); };
  let started = gate(); const first = store.saveProgress(b.id, { state: { count: 2 } }); await started;
  const second = store.saveProgress(b.id, { state: { count: 3 } });
  await within(store.saveProgress(a.id, { state: { count: 10 } })); await within(store.flush(a.id));
  const backup = await within(store.restartProgress(a.id)); assert.ok(backup.backup);
  await within(store.saveProgress(a.id, { state: { count: 11 } }));
  assert.deepEqual((await store.progress(b.id))?.state, { count: 1 });
  releaseWrite(); await first; await second;
  assert.deepEqual((await store.progress(b.id))?.state, { count: 3 }, 'same-scene writes keep their order');
  rejectB = true; await assert.rejects(store.saveProgress(b.id, { state: { count: 99 } }));
  await store.flush(a.id); await assert.rejects(store.flush());
  store.acknowledgeSaveFailure(a.id); await assert.rejects(store.flush(), /synthetic B-only/);
  store.acknowledgeSaveFailure(b.id); await store.flush(); rejectB = false;
  assert.deepEqual((await store.progress(b.id))?.state, { count: 3 });
  console.log('PASS per-scene save/reset lanes, own flush, same-scene order and failure acknowledgment isolation; whole-app flush still reports other scenes');

  const windows: NativeWindow[] = [], prompts: Array<{ window: NativeWindow; answer: (response: number) => void }> = [];
  class NativeWindow extends EventEmitter {
    dead = false; url = ''; checkpoint: () => Promise<unknown> = async () => {};
    webContents = Object.assign(new EventEmitter(), { isDestroyed: () => this.dead, setWebRTCIPHandlingPolicy() {}, setWindowOpenHandler() {}, executeJavaScript: async () => this.checkpoint() });
    constructor() { super(); windows.push(this); }
    isDestroyed() { return this.dead; }
    setMenu() {}
    async loadURL(url: string) { this.url = url; }
    close() { this.emit('close', { preventDefault() {} }); }
    destroy() { if (!this.dead) { this.dead = true; this.emit('closed'); } }
  }
  const handlers = new Map<string, (...args: any[]) => any>();
  const hostModule = production<{ registerH5pHost: typeof registerH5pHost }>('src/electron/h5pHost.ts', { 'node:fs/promises': faultFs, 'fs/promises': faultFs, electron: {
    BrowserWindow: NativeWindow,
    dialog: { showMessageBox: (window: NativeWindow) => new Promise(resolve => { prompts.push({ window, answer: response => resolve({ response }) }); }) },
    session: { fromPartition: () => ({ setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, webRequest: { onBeforeRequest() {} }, on() {}, clearStorageData: async () => {} }) },
  } });
  host = hostModule.registerH5pHost({ handle: ((name: string, run: any) => handlers.set(name, run)) as any }, {
    root: () => root, current: () => root, allowed: () => true, parent: () => null, visible: false, assets: path.resolve('node_modules/h5p-standalone/dist'),
  });
  const open = async (id: string) => { await handlers.get('h5p:open')!({}, id); return windows.at(-1)!; };
  const client = async (window: NativeWindow) => {
    const code = await (await fetch(window.url + 'bootstrap.js')).text();
    const generation = JSON.parse(/const pageGeneration=("[a-f0-9]+");/u.exec(code)![1]);
    return (count: number) => fetch(window.url + 'checkpoint', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: new URL(window.url).origin, 'X-H5P-Page': generation }, body: JSON.stringify({ state: { count } }) });
  };
  let wa = await open(a.id); const wb = await open(b.id), saveB = await client(wb);
  let saveA = await client(wa);
  started = gate(); const postingB = saveB(4); await started;
  wa.checkpoint = async () => { assert.equal((await saveA(20)).status, 200); };
  const closedA = new Promise<void>(resolve => wa.once('closed', resolve)); wa.close(); await within(closedA);
  assert.equal(prompts.length, 0); assert.deepEqual((await seed.progress(a.id))?.state, { count: 20 });
  wa = await open(a.id); saveA = await client(wa);
  wa.checkpoint = async () => { assert.equal((await saveA(21)).status, 200); };
  const closedAgain = new Promise<void>(resolve => wa.once('closed', resolve)); wa.close(); await within(closedAgain);
  assert.equal(prompts.length, 0, 'B being stuck cannot block A save/reopen/close');
  wb.close(); wb.close();
  const promptDeadline = Date.now() + 5000;
  while (!prompts.length && Date.now() < promptDeadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(prompts.length, 1, 'the entire own checkpoint, including flush, has a four-second timeout');
  assert.equal(prompts[0].window, wb); wb.close(); await tick(); assert.equal(prompts.length, 1, 'pending native decision is part of the same close operation');
  prompts[0].answer(0); await tick(); await tick(); assert.equal(wb.dead, false);
  releaseWrite(); assert.equal((await postingB).status, 200);
  const closedB = new Promise<void>(resolve => wb.once('closed', resolve)); wb.close(); await within(closedB);
  assert.equal(prompts.length, 1); assert.deepEqual((await seed.progress(b.id))?.state, { count: 4 });
  assert.deepEqual((await seed.progress(a.id))?.state, { count: 21 });
  console.log('PASS production dual-loopback host: B stalled while A saves/reopens/closes; B own timeout covers flush, one dialog, cancel then retry succeeds');

  wa = await open(a.id); wa.checkpoint = async () => { throw Error('synthetic renderer checkpoint failure'); };
  wa.close(); wa.close(); await tick(); await tick();
  assert.equal(prompts.length, 2); wa.close(); await tick(); assert.equal(prompts.length, 2);
  prompts[1].answer(0); await tick(); await tick(); assert.equal(wa.dead, false);
  wa.close(); await tick(); await tick(); assert.equal(prompts.length, 3, 'a completed cancellation releases the lane for a new explicit close');
  const shuttingDown = host.shutdown(); await tick(); assert.equal(prompts.length, 3, 'app shutdown joins the in-flight decision without another popup');
  prompts[2].answer(1); await within(shuttingDown); assert.equal(wa.dead, true);
  assert.deepEqual((await seed.progress(a.id))?.state, { count: 21 }); assert.deepEqual((await seed.progress(b.id))?.state, { count: 4 });
  console.log('PASS duplicate failing close events share one confirmation; cancel allows retry, shutdown joins it, discard retains both saved checkpoints');
} finally {
  releaseWrite(); host?.forceClose();
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('loginote-h5p-isolation-'));
  await fs.rm(root, { recursive: true, force: true });
}
