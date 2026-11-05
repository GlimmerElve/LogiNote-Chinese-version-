import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
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
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'loginote-h5p-recovery-'));
try {
  const bytes = Buffer.from(zipSync({
    'h5p.json': strToU8(JSON.stringify({ title: 'Recovery fixture', mainLibrary: 'H5P.Probe', preloadedDependencies: [{ machineName: 'H5P.Probe', majorVersion: 1, minorVersion: 0 }] })),
    'content/content.json': strToU8('{}'),
    'H5P.Probe-1.0/library.json': strToU8(JSON.stringify({ machineName: 'H5P.Probe', majorVersion: 1, minorVersion: 0, patchVersion: 0, preloadedJs: [{ path: 'main.js' }] })),
    'H5P.Probe-1.0/main.js': strToU8('window.synthetic=true;'),
  }));
  const damaged = path.join(root, 'damaged'); await fs.mkdir(damaged);
  const store = createH5pStore(damaged), descriptor = await store.importBytes(bytes);
  await store.saveProgress(descriptor.id, { state: { count: 1 } });
  const progressFile = path.join(damaged, 'user-state', 'h5p', `${descriptor.id}.json`);
  const broken = Buffer.from('{truncated'); await fs.writeFile(progressFile, broken);
  const listed = await store.list();
  assert.equal(listed.packages.length, 1); assert.match(listed.packages[0].progressError!, /进度读取失败/);
  assert.equal((await store.load(descriptor.id)).descriptor.missing.length, 0);
  await assert.rejects(store.progress(descriptor.id));
  await assert.rejects(store.restartProgress(descriptor.id, () => false), /未重置进度/);
  assert.deepEqual(await fs.readFile(progressFile), broken);
  console.log('PASS bad progress keeps the valid package visible; rejected recovery leaves original bytes unchanged');

  const handlers = new Map<string, (...args: any[]) => any>();
  let response = 0, epoch = 'initial', mutateEpoch = false, prompts = 0;
  const hostModule = production<{ registerH5pHost: typeof registerH5pHost }>('src/electron/h5pHost.ts', { electron: { dialog: {
    showMessageBox: async () => { prompts++; if (mutateEpoch) epoch = 'changed'; return { response }; },
  } } });
  hostModule.registerH5pHost({ handle: ((name: string, handler: any) => handlers.set(name, handler)) as any }, {
    root: () => damaged, current: () => epoch, parent: () => null, allowed: event => event.sender.id === 1,
    assets: path.resolve('node_modules/h5p-standalone/dist'),
  });
  const event = { sender: { id: 1 } };
  await assert.rejects(handlers.get('h5p:restart')!({ sender: { id: 2 } }, descriptor.id), /当前窗口/); assert.equal(prompts, 0);
  assert.equal((await handlers.get('h5p:restart')!(event, descriptor.id)).canceled, true);
  assert.deepEqual(await fs.readFile(progressFile), broken);
  response = 1; mutateEpoch = true;
  await assert.rejects(handlers.get('h5p:restart')!(event, descriptor.id), /未重置进度/);
  assert.deepEqual(await fs.readFile(progressFile), broken);
  mutateEpoch = false;
  const recovered = await handlers.get('h5p:restart')!(event, descriptor.id);
  assert.ok(recovered.backup);
  assert.deepEqual(await fs.readFile(path.join(damaged, 'user-state', 'h5p', 'backups', recovered.backup)), broken);
  assert.equal(await store.progress(descriptor.id), null);
  assert.equal((await store.list()).packages[0].progressError, undefined);
  assert.deepEqual(await fs.readFile(path.join(damaged, 'h5p', 'packages', `${descriptor.id}.h5p`)), bytes);
  await store.saveProgress(descriptor.id, { state: { count: 2 } });
  assert.deepEqual((await store.progress(descriptor.id))?.state, { count: 2 });
  console.log('PASS actual recovery IPC: trusted caller, native cancel/confirm, stale epoch rejection, byte-exact backup and writable fresh progress');

  const linked = path.join(root, 'linked'); await fs.mkdir(linked);
  let denyCleanup = true;
  const faultFs = new Proxy(fs, { get(target, key: keyof typeof fs) {
    if (key === 'unlink') return async (file: string) => {
      if (denyCleanup && file.startsWith(linked + path.sep) && file.endsWith('.tmp')) throw Object.assign(Error('synthetic lock'), { code: 'EACCES' });
      return target.unlink(file);
    };
    return target[key];
  } });
  const faultStore = production<{ createH5pStore: typeof createH5pStore }>('src/electron/h5pStore.ts', { 'node:fs/promises': faultFs, 'fs/promises': faultFs }).createH5pStore(linked);
  await assert.rejects(faultStore.importBytes(bytes), /清理失败/);
  assert.equal(faultStore.busy(), false);
  const target = path.join(linked, 'h5p', 'packages', `${descriptor.id}.h5p`);
  assert.equal((await fs.stat(target)).nlink, 2);
  denyCleanup = false;
  const restarted = createH5pStore(linked);
  assert.equal((await restarted.load(descriptor.id)).descriptor.id, descriptor.id);
  assert.equal((await fs.stat(target)).nlink, 1);
  assert.equal((await restarted.list()).packages.length, 1);
  await restarted.importBytes(bytes);
  assert.equal((await fs.readdir(path.dirname(target))).length, 1);
  console.log('PASS post-publication cleanup failure is truthful; a fresh store recovers its own orphan link and reimport works');
  const alias = path.join(root, 'user-owned-alias.h5p'); await fs.link(target, alias);
  await assert.rejects(restarted.load(descriptor.id), /未知硬链接/);
  assert.deepEqual(await fs.readFile(alias), bytes);
  console.log('PASS unknown hard links are still rejected and never automatically removed');
} finally {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('loginote-h5p-recovery-'));
  await fs.rm(root, { recursive: true, force: true });
}
