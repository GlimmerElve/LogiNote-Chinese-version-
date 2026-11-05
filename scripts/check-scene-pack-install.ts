import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { zipSync, strToU8 } from 'fflate';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createScenePackImporter, inspectScenePackImport } from '../src/electron/sceneInteractionPackImport';
import { createSceneInteractionPackStore } from '../src/electron/sceneInteractionPackStore';
import type { registerSceneInteractionPackIpc } from '../src/electron/sceneInteractionPackIpc';
const require = createRequire(import.meta.url);
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'loginote-scene-install-'));
const manifest = (version = '1.0.0') => ({ protocolVersion: 1, id: 'update-probe', version, name: '合成更新包', paradigm: 'S2', paradigmApiVersion: 1, requiredServices: [] });
const files = (version = '1.0.0', code = 'export const value=1;') => ({ 'manifest.json': strToU8(JSON.stringify(manifest(version))),
  'main.js': strToU8(code), 'styles.css': strToU8('.probe{color:green}'), 'agent.json': strToU8('{}') });
const pack = (version?: string, code?: string) => Buffer.from(zipSync(files(version, code)));
try {
  const root = path.join(temp, 'installed'), store = createSceneInteractionPackStore(root), installer = createScenePackImporter(root);
  assert.equal((await store.list()).managed, false);
  const first = pack(); await installer.install(first);
  assert.equal((await store.list()).managed, true, 'an initially missing directory becomes live without restart');
  assert.equal((await store.list()).packs.length, 1);
  const oldFile = path.join(root, 'update-probe/1.0.0/main.js'), old = await fs.readFile(oldFile);
  const progress = path.join(temp, 'existing-scene.json'), progressBytes = '{"interactionPack":{"id":"update-probe","version":"1.0.0"},"answer":"keep"}';
  await fs.writeFile(progress, progressBytes);
  const stat = await fs.stat(oldFile);
  assert.equal((await installer.install(first)).alreadyInstalled, true);
  assert.equal((await fs.stat(oldFile)).mtimeMs, stat.mtimeMs);
  await assert.rejects(installer.install(pack('1.0.0', 'changed')), /同版本/);
  const [v2, v3] = await Promise.all([installer.install(pack('2.0.0')), installer.install(pack('3.0.0'))]);
  assert.equal(v2.manifest.version, '2.0.0'); assert.equal(v3.manifest.version, '3.0.0');
  assert.equal((await store.list()).packs.length, 3);
  assert.deepEqual(await fs.readFile(oldFile), old); assert.equal(await fs.readFile(progress, 'utf8'), progressBytes);
  assert.equal(installer.busy(), false);
  await assert.rejects(installer.install(pack('4.0.0'), () => false), /状态已变化/);
  let currentCalls = 0;
  await assert.rejects(installer.install(pack('4.0.0'), () => ++currentCalls < 2), /状态已变化/);
  await assert.rejects(fs.access(path.join(root, 'update-probe/4.0.0')), { code: 'ENOENT' });
  for (const bad of [
    { ...files(), '../escape': strToU8('bad') },
    { ...files(), 'MAIN.JS': strToU8('bad') },
    Object.fromEntries(Object.entries(files()).flatMap(([name, value]) => [[name, value], [`other/${name}`, value]])),
    { ...files(), '.hidden': strToU8('bad') },
  ]) await assert.rejects(inspectScenePackImport(Buffer.from(zipSync(bad))));
  const missing: any = files(); delete missing['main.js']; await assert.rejects(inspectScenePackImport(Buffer.from(zipSync(missing))), /manifest.json/);
  assert.equal((await inspectScenePackImport(Buffer.from(zipSync({ ...files(), 'materials/manifest.json': strToU8('{}') })))).manifest.version, '1.0.0');
  const nested = Object.fromEntries(Object.entries(files('5.0.0')).map(([name, bytes]) => [`download/${name}`, bytes]));
  assert.equal((await inspectScenePackImport(Buffer.from(zipSync(nested)))).manifest.version, '5.0.0');
  const damaged = Buffer.from(zipSync(files(), { level: 0 }));
  damaged[damaged.indexOf(Buffer.from('export const value=1;'))] ^= 1;
  await assert.rejects(inspectScenePackImport(damaged), /校验/);
  assert.equal((await fs.readdir(root)).some(name => name.startsWith('.import-stage-')), false);
  const distributable = path.join(temp, 'publisher.zip');
  execFileSync(process.execPath, ['scripts/run-tsx-safe.cjs', '--no-scene-pack-bootstrap', 'scripts/package-scene-interaction-pack.ts', path.join(root, 'update-probe/1.0.0'), distributable]);
  assert.equal((await inspectScenePackImport(await fs.readFile(distributable))).manifest.version, '1.0.0');
  console.log('PASS immutable ZIP installation: missing-directory discovery, side-by-side updates, idempotent imports, duplicate conflict, concurrent imports, old scene bytes retained, CRC/path/required-file rejection and stage cleanup');

  const selected = path.join(temp, 'selected.zip'); await fs.writeFile(selected, pack('6.0.0'));
  const handlers = new Map<string, Function>(); let picks = 0, response = 0, epoch = 'old', changeEpoch = false;
  const code = buildSync({ entryPoints: ['src/electron/sceneInteractionPackIpc.ts'], bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false }).outputFiles[0].text;
  const module = { exports: {} as { registerSceneInteractionPackIpc: typeof registerSceneInteractionPackIpc } };
  const dialogs: any = {
    showOpenDialog: async () => { picks++; return { canceled: false, filePaths: [selected] }; },
    showMessageBox: async () => { if (changeEpoch) epoch = 'changed'; return { response }; },
  };
  new Function('require', 'module', 'exports', code)(require, module, module.exports);
  const ipc = module.exports.registerSceneInteractionPackIpc({ handle: ((name: string, fn: Function) => handlers.set(name, fn)) as any }, {
    root, current: () => epoch, allowed: event => event.sender.id === 1, dialogs,
  });
  const invoke = (id = 1) => handlers.get('scene-interaction-packs:import')!({ sender: { id } });
  const nativeLstat = fs.lstat;
  try {
    fs.lstat = (async (file: any, ...args: any[]) => {
      if (String(file) === path.join(root, '.initialized')) throw Object.assign(new Error('SYNTHETIC_IPC_INITIALIZATION_BUSY'), { code: 'EBUSY' });
      return (nativeLstat as any)(file, ...args);
    }) as typeof fs.lstat;
    await assert.rejects(handlers.get('scene-interaction-packs:list')!({ sender: { id: 1 } }), /SYNTHETIC_IPC_INITIALIZATION_BUSY/);
  } finally { fs.lstat = nativeLstat; }
  assert.equal((await handlers.get('scene-interaction-packs:list')!({ sender: { id: 1 } })).packs.length, 3,
    'The same production IPC store can refresh after a transient initialization failure');
  await assert.rejects(invoke(2), /不允许/); assert.equal(picks, 0);
  assert.equal((await invoke()).canceled, true); assert.equal((await store.list()).packs.length, 3);
  response = 1; changeEpoch = true; await assert.rejects(invoke(), /状态已变化/);
  changeEpoch = false; const job = invoke(); assert.equal(ipc.busy(), true);
  await assert.rejects(invoke(), /等待/); assert.equal((await job).manifest.version, '6.0.0');
  assert.equal(ipc.busy(), false); assert.equal((await store.list()).packs.length, 4);
  console.log('PASS production install IPC: transient initialization recovery/refresh then install, trusted caller only, native cancellation, epoch revalidation, duplicate-operation lock, busy/exit protection and immediate discovery');
} finally {
  assert.equal(path.dirname(temp), path.resolve(os.tmpdir())); assert.ok(path.basename(temp).startsWith('loginote-scene-install-'));
  await fs.rm(temp, { recursive: true, force: true });
}
