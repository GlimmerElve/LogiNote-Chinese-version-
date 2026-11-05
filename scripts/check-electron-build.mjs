import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Script } from 'node:vm';
import { buildElectron, compileElectron, electronFiles, publishElectronFiles } from './build-electron.mjs';

const fixtureParent = path.resolve('scripts/.build-checks');
await fs.mkdir(fixtureParent, { recursive: true });
const fixture = await fs.mkdtemp(path.join(fixtureParent, 'electron-build-'));
const bundles = version => new Map(electronFiles.map(name => [name, Buffer.from(`${version}:${name}`)]));
const delay = async () => {};
let count = 0;
async function test(name, run) {
  const rootDir = path.join(fixture, String(++count));
  const outDir = path.join(rootDir, 'dist-electron');
  await fs.mkdir(outDir, { recursive: true });
  const old = bundles('old');
  for (const [file, data] of old) await fs.writeFile(path.join(outDir, file), data);
  await run({ rootDir, outDir, old, delay, attempts: 1, warn: () => {} });
  console.log(`PASS ${name}`);
}
async function expectFiles(outDir, expected) {
  for (const [name, contents] of expected) assert.deepEqual(await fs.readFile(path.join(outDir, name)), contents, name);
}
const fault = (code, message = 'injected') => Object.assign(new Error(message), { code });

// This helper maps only a synthetic fixture. It never opens real app artifacts,
// user data, or any other process; the parent owns and closes the helper.
const mappingHelper = String.raw`
import ctypes, sys
from ctypes import wintypes as w
k = ctypes.WinDLL('kernel32', use_last_error=True)
k.CreateFileW.argtypes = [w.LPCWSTR,w.DWORD,w.DWORD,w.LPVOID,w.DWORD,w.DWORD,w.HANDLE]
k.CreateFileW.restype = w.HANDLE
k.CreateFileMappingW.argtypes = [w.HANDLE,w.LPVOID,w.DWORD,w.DWORD,w.DWORD,w.LPCWSTR]
k.CreateFileMappingW.restype = w.HANDLE
k.MapViewOfFile.argtypes = [w.HANDLE,w.DWORD,w.DWORD,w.DWORD,ctypes.c_size_t]
k.MapViewOfFile.restype = ctypes.c_void_p
k.UnmapViewOfFile.argtypes = [ctypes.c_void_p]
k.CloseHandle.argtypes = [w.HANDLE]
h = k.CreateFileW(sys.argv[1],0x80000000,int(sys.argv[2]),None,3,0,None)
if h == ctypes.c_void_p(-1).value: raise ctypes.WinError(ctypes.get_last_error())
m = k.CreateFileMappingW(h,None,2,0,0,None)
if not m: raise ctypes.WinError(ctypes.get_last_error())
v = k.MapViewOfFile(m,4,0,0,0)
if not v: raise ctypes.WinError(ctypes.get_last_error())
expected = b'old:preload.cjs'
print('READY',flush=True)
sys.stdin.readline()
print('PRESERVED' if ctypes.string_at(v,len(expected)) == expected else 'CHANGED',flush=True)
k.UnmapViewOfFile(v)
k.CloseHandle(m)
k.CloseHandle(h)
`;
async function withMapping(file, sharing, run) {
  const child = spawn('python', ['-c', mappingHelper, file, String(sharing)], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  let stdout = '', stderr = '';
  let settleReady;
  const ready = new Promise((resolve, reject) => { settleReady = { resolve, reject }; });
  child.stdout.on('data', data => { stdout += data; if (stdout.includes('READY')) settleReady.resolve(); });
  child.stderr.on('data', data => { stderr += data; });
  const finished = new Promise((resolve, reject) => {
    child.once('error', error => { settleReady.reject(error); reject(error); });
    child.once('exit', code => { if (!stdout.includes('READY')) settleReady.reject(new Error(stderr)); resolve(code); });
  });
  // Register rejection immediately while waiting for readiness.
  void finished.catch(() => {});
  const timeout = setTimeout(() => settleReady.reject(new Error('Mapping helper readiness timeout')), 5000);
  try {
    await ready;
    await run();
    child.stdin.end('release\n');
    const code = await finished;
    assert.equal(code, 0, stderr);
    assert.match(stdout, /PRESERVED/);
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) { child.stdin.end(); child.kill(); await finished.catch(() => {}); }
  }
}

try {
  await test('compile failure never changes output', async options => {
    await assert.rejects(buildElectron({ ...options, compile: async () => { throw new Error('syntax error'); } }), /syntax error/);
    await expectFiles(options.outDir, options.old);
  });
  await test('unchanged mapped candidates are never opened for write or renamed', async options => {
    const before = await fs.stat(path.join(options.outDir, 'preload.cjs'));
    const io = { ...fs, rename: async () => { throw new Error('Unexpected rename'); } };
    const result = await publishElectronFiles(options.old, { ...options, io });
    assert.equal(result.changed.length, 0);
    assert.equal(result.unchanged.length, electronFiles.length);
    assert.equal((await fs.stat(path.join(options.outDir, 'preload.cjs'))).mtimeMs, before.mtimeMs);
  });
  await test('complete publish uses fresh paths and installs main last', async options => {
    const installs = [];
    const io = { ...fs, rename: async (from, to) => {
      if (from.endsWith('.next')) installs.push(path.basename(to));
      // A live target is never truncated or replaced using rename(new, existing).
      await assert.rejects(fs.access(to), { code: 'ENOENT' });
      return fs.rename(from, to);
    } };
    const next = bundles('new');
    await publishElectronFiles(next, { ...options, io });
    assert.deepEqual(installs, electronFiles);
    await expectFiles(options.outDir, next);
  });
  await test('first build preserves unrelated files', async options => {
    for (const name of electronFiles) await fs.unlink(path.join(options.outDir, name));
    await fs.writeFile(path.join(options.outDir, 'keep.txt'), 'keep');
    const next = bundles('new');
    await publishElectronFiles(next, options);
    await expectFiles(options.outDir, next);
    assert.equal(await fs.readFile(path.join(options.outDir, 'keep.txt'), 'utf8'), 'keep');
  });
  await test('staging failure leaves all previous outputs intact', async options => {
    const io = { ...fs, open: async (file, flags) => {
      if (file.endsWith('rag-compute.cjs.next')) throw fault('ENOSPC');
      return fs.open(file, flags);
    } };
    await assert.rejects(publishElectronFiles(bundles('new'), { ...options, io }), /injected/);
    await expectFiles(options.outDir, options.old);
  });
  await test('temporary rename locks have bounded retries', async options => {
    let attempts = 0, sleeps = 0;
    const io = { ...fs, rename: async (from, to) => {
      if (from === path.join(options.outDir, 'preload.cjs') && ++attempts < 3) throw fault('EBUSY');
      return fs.rename(from, to);
    } };
    await publishElectronFiles(bundles('new'), { ...options, io, attempts: 3, delay: async () => { sleeps++; } });
    assert.equal(attempts, 3);
    assert.equal(sleeps, 2);
  });
  await test('permanent preload rename lock does not publish main', async options => {
    const io = { ...fs, rename: async (from, to) => {
      if (from === path.join(options.outDir, 'preload.cjs')) throw fault('EPERM');
      return fs.rename(from, to);
    } };
    await assert.rejects(publishElectronFiles(bundles('new'), { ...options, io }), /Previous Electron output restored/);
    await expectFiles(options.outDir, options.old);
  });
  await test('late install failure rolls all outputs back', async options => {
    const io = { ...fs, rename: async (from, to) => {
      if (from.endsWith('main.cjs.next')) throw fault('EPERM');
      return fs.rename(from, to);
    } };
    await assert.rejects(publishElectronFiles(bundles('new'), { ...options, io }), /Previous Electron output restored/);
    await expectFiles(options.outDir, options.old);
    // Clean rollback releases its lock and permits a subsequent build.
    await publishElectronFiles(bundles('new'), options);
  });
  await test('rollback obstruction retains recovery files and blocks another publish', async options => {
    const io = { ...fs, rename: async (from, to) => {
      if (from.endsWith('main.cjs.next') || from.endsWith('preload.cjs.previous')) throw fault('EPERM');
      return fs.rename(from, to);
    } };
    await assert.rejects(publishElectronFiles(bundles('new'), { ...options, io }), /Recovery files retained/);
    await assert.rejects(publishElectronFiles(bundles('newer'), options), /interrupted Electron build/);
    const workspace = path.join(options.rootDir, 'build', 'electron-builds');
    const transaction = (await fs.readdir(workspace)).find(name => name.startsWith('transaction-'));
    assert.deepEqual(await fs.readFile(path.join(workspace, transaction, 'preload.cjs.previous')), options.old.get('preload.cjs'));
  });
  await test('concurrent build lock does not change live outputs', async options => {
    const workspace = path.join(options.rootDir, 'build', 'electron-builds');
    await fs.mkdir(workspace, { recursive: true });
    const key = createHash('sha256').update(options.outDir).digest('hex').slice(0, 16);
    await fs.writeFile(path.join(workspace, `${key}.lock`), 'synthetic competing build');
    await assert.rejects(publishElectronFiles(bundles('new'), options), /concurrently/);
    await expectFiles(options.outDir, options.old);
  });
  await test('rollback never overwrites a file created by another writer', async options => {
    const target = path.join(options.outDir, 'main.cjs');
    const io = { ...fs, rename: async (from, to) => {
      if (from.endsWith('main.cjs.next')) {
        await fs.writeFile(target, 'external recovery');
        throw fault('EPERM');
      }
      return fs.rename(from, to);
    } };
    await assert.rejects(publishElectronFiles(bundles('new'), { ...options, io }), /Recovery files retained/);
    assert.equal(await fs.readFile(target, 'utf8'), 'external recovery');
  });
  await test('external output change is preserved, not overwritten', async options => {
    let reads = 0;
    const target = path.join(options.outDir, 'preload.cjs');
    const io = { ...fs, readFile: async file => {
      if (file === target && ++reads === 2) await fs.writeFile(target, 'external change');
      return fs.readFile(file);
    } };
    await assert.rejects(publishElectronFiles(bundles('new'), { ...options, io }), /Output changed/);
    assert.equal(await fs.readFile(target, 'utf8'), 'external change');
  });
  await test('incomplete output set is rejected before publishing', async options => {
    const incomplete = bundles('new'); incomplete.delete('preload.cjs');
    await assert.rejects(publishElectronFiles(incomplete, options), /All three/);
    await expectFiles(options.outDir, options.old);
  });
  if (process.platform === 'win32') {
    await test('real Windows mapped-file truncate error is avoided by rename', async options => {
      const target = path.join(options.outDir, 'preload.cjs');
      await withMapping(target, 7, async () => {
        await assert.rejects(fs.writeFile(target, 'truncate would fail'), error => ['EPERM', 'EACCES', 'EBUSY', 'UNKNOWN'].includes(error.code));
        await publishElectronFiles(bundles('new'), options);
        await expectFiles(options.outDir, bundles('new'));
      });
    });
    await test('real Windows no-delete lock permits unchanged skip and safe failure', async options => {
      const target = path.join(options.outDir, 'preload.cjs');
      await withMapping(target, 3, async () => {
        const next = bundles('new'); next.set('preload.cjs', options.old.get('preload.cjs'));
        const result = await publishElectronFiles(next, options);
        assert.ok(result.unchanged.includes('preload.cjs'));
        await expectFiles(options.outDir, next);
        await assert.rejects(publishElectronFiles(bundles('newer'), options), /Previous Electron output restored/);
        await expectFiles(options.outDir, next);
      });
    });
  }
  await test('real source bundles compile and publish in isolation', async options => {
    const files = await compileElectron(process.cwd());
    for (const [name, contents] of files) new Script(contents.toString(), { filename: name });
    await publishElectronFiles(files, options);
    await expectFiles(options.outDir, files);
    const again = await publishElectronFiles(files, options);
    assert.equal(again.unchanged.length, electronFiles.length);
  });
  console.log(`Electron build checks passed: ${count} groups. No real dist-electron files changed.`);
} finally {
  const relative = path.relative(fixtureParent, fixture);
  assert.ok(relative.startsWith('electron-build-') && !relative.includes(path.sep));
  // Only this test's freshly created fixture is removed, never repo output.
  await fs.rm(fixture, { recursive: true, force: true });
  try { await fs.rmdir(fixtureParent); } catch (error) { if (!['ENOTEMPTY', 'ENOENT'].includes(error.code)) throw error; }
}
