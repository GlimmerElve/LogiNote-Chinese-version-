import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createSceneInteractionPackStore } from '../src/electron/sceneInteractionPackStore';
import { SCENE_PACK_SEED_RECEIPT, SCENE_PACK_SEED_EXCLUSIONS } from '../src/electron/sceneInteractionPackSeed';

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'loginote-seed-protection-'));
const seed = path.join(temporary, 'seed');
const alpha = { id: 'alpha-lab', version: '1.0.0' }, beta = { id: 'beta-lab', version: '1.0.0' };
const version = (root: string, ref = alpha) => path.join(root, ref.id, ref.version);
const receiptPath = (root: string) => path.join(root, SCENE_PACK_SEED_RECEIPT);
const exclusionPath = (root: string) => path.join(root, SCENE_PACK_SEED_EXCLUSIONS);
const present = (file: string) => fs.lstat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
async function remove(file: string) {
  const relative = path.relative(temporary, path.resolve(file));
  assert(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
  await fs.rm(file, { recursive: true });
}
async function writePack(root: string, ref = alpha, code = 'SEED-A') {
  const dir = version(root, ref); await fs.mkdir(dir, { recursive: true });
  const manifest = { protocolVersion: 1, ...ref, name: ref.id, paradigm: 'S2', paradigmApiVersion: 1, requiredServices: [] };
  for (const [file, content] of Object.entries({ 'manifest.json': JSON.stringify(manifest), 'main.js': `export const value=${JSON.stringify(code)};`,
    'agent.json': '{}', 'styles.css': '' })) await fs.writeFile(path.join(dir, file), content);
}
async function tree(root: string) {
  const files: Array<[string, string]> = [];
  async function walk(dir: string) {
    for (const file of await fs.readdir(dir, { withFileTypes: true })) {
      assert(!file.isSymbolicLink()); const target = path.join(dir, file.name);
      if (file.isDirectory()) await walk(target);
      else files.push([path.relative(root, target), createHash('sha256').update(await fs.readFile(target)).digest('hex')]);
    }
  }
  await walk(root); return files.sort(([a], [b]) => a.localeCompare(b));
}
const nativeRename = fs.rename, nativeRead = fs.readFile, previousFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('Seed protection never uses a network or model');
try {
  await writePack(seed); await writePack(seed, beta, 'SEED-B');
  for (const recovery of ['refresh', 'restart', 'corrupt']) {
    const root = path.join(temporary, `receipt-${recovery}`), store = createSceneInteractionPackStore(root, seed);
    try {
      fs.rename = async (from, to) => {
        if (String(to) === version(root)) throw new Error('SYNTHETIC_PARTIAL_SEED_BUSY');
        return nativeRename(from, to);
      };
      assert.deepEqual((await store.list()).packs.map(ref => ref.id), [beta.id]);
    } finally { fs.rename = nativeRename; }
    const validReceipt = await fs.readFile(receiptPath(root));
    assert(JSON.parse(validReceipt.toString()).packages['beta-lab@1.0.0']);
    await remove(version(root, beta));
    if (recovery === 'corrupt') await fs.writeFile(receiptPath(root), '{invalid');
    const before = await tree(root); let reads = 0;
    try {
      if (recovery !== 'corrupt') fs.readFile = (async (file: any, ...args: any[]) => {
        if (String(file) === receiptPath(root)) { reads++; throw Object.assign(new Error('SYNTHETIC_RECEIPT_READ_BUSY'), { code: 'EBUSY' }); }
        return (nativeRead as any)(file, ...args);
      }) as typeof fs.readFile;
      const result = await Promise.allSettled([store.list(), store.list(), store.load(alpha)]);
      assert(result.every(item => item.status === 'rejected' && /受管记录不可用/.test(String(item.reason))));
      if (recovery !== 'corrupt') assert.equal(reads, 1, 'Concurrent metadata failures remain single-flight');
    } finally { fs.readFile = nativeRead; }
    assert.deepEqual(await tree(root), before, 'Unreadable or corrupt receipt cannot write any installed data or completion marker');
    assert(!await present(version(root, beta)));
    if (recovery === 'corrupt') await fs.writeFile(receiptPath(root), validReceipt); // Explicit fixture repair, never product auto-repair.
    const recovered = recovery === 'refresh' ? store : createSceneInteractionPackStore(root, seed);
    const result = await recovered.list();
    assert.deepEqual(result.errors, []); assert.deepEqual(result.packs.map(ref => ref.id), [alpha.id]);
    assert(!await present(version(root, beta)), 'Receipt recovery does not resurrect the user-deleted package');
    assert(await present(path.join(root, '.initialized')));
  }
  console.log('PASS receipt protection: I/O/corrupt failure is not empty state, concurrent rejection, no mutation, same-store retry/restart recovery and user-deleted version remains absent');

  for (const recovery of ['refresh', 'restart', 'exclusion-read-failure']) {
    const root = path.join(temporary, `preinstalled-${recovery}`), store = createSceneInteractionPackStore(root, seed);
    await writePack(root, alpha, 'USER-CUSTOM-A');
    await fs.writeFile(path.join(version(root), 'personal.txt'), 'KEEP CUSTOM FILE');
    const custom = await tree(version(root));
    try {
      fs.rename = async (from, to) => {
        if (String(to) === version(root, beta)) throw new Error('SYNTHETIC_BETA_BUSY');
        return nativeRename(from, to);
      };
      const result = await store.list(); assert.deepEqual(result.packs.map(ref => ref.id), [alpha.id]);
      assert.equal(result.errors.length, 1);
    } finally { fs.rename = nativeRename; }
    assert.deepEqual(await tree(version(root)), custom);
    assert.deepEqual(JSON.parse(await fs.readFile(exclusionPath(root), 'utf8')), { version: 1, references: [alpha] });
    assert(!await present(receiptPath(root)), 'Exclusion never adopts an unmanaged package as seed-owned');
    assert(!await present(path.join(root, '.initialized')));
    await remove(version(root));
    if (recovery === 'exclusion-read-failure') {
      const before = await tree(root);
      try {
        fs.readFile = (async (file: any, ...args: any[]) => {
          if (String(file) === exclusionPath(root)) throw new Error('SYNTHETIC_EXCLUSION_READ_BUSY');
          return (nativeRead as any)(file, ...args);
        }) as typeof fs.readFile;
        await assert.rejects(store.list(), /排除记录不可用/);
      } finally { fs.readFile = nativeRead; }
      assert.deepEqual(await tree(root), before, 'Unknown exclusion state stops automatic seeding');
    }
    const recovered = recovery === 'refresh' ? store : createSceneInteractionPackStore(root, seed);
    assert.deepEqual((await recovered.list()).packs.map(ref => ref.id), [beta.id]);
    assert(!await present(version(root)));
    assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(receiptPath(root), 'utf8')).packages), ['beta-lab@1.0.0']);
    for (const refreshSeed of [false, true]) assert.deepEqual((await createSceneInteractionPackStore(root, seed, { refreshSeed }).list()).packs.map(ref => ref.id), [beta.id]);
  }
  console.log('PASS preinstalled protection: durable exact-version exclusions without ownership adoption, custom bytes retained, deletion survives refresh/restart/dev refresh, exclusion read failures stop writes');

  const writeRoot = path.join(temporary, 'exclusion-write-failure'), writeStore = createSceneInteractionPackStore(writeRoot, seed);
  await writePack(writeRoot, alpha, 'KEEP-A'); const original = await tree(writeRoot);
  try {
    fs.rename = async (from, to) => {
      if (String(to) === exclusionPath(writeRoot)) throw new Error('SYNTHETIC_EXCLUSION_COMMIT_FAILURE');
      return nativeRename(from, to);
    };
    await assert.rejects(writeStore.list(), /SYNTHETIC_EXCLUSION_COMMIT_FAILURE/);
  } finally { fs.rename = nativeRename; }
  assert.deepEqual(await tree(writeRoot), original, 'Failed exclusion persistence must precede all seed publication and clean only its own temporary file');
  assert.equal((await writeStore.list()).packs.length, 2);
  assert(!JSON.parse(await fs.readFile(receiptPath(writeRoot), 'utf8')).packages['alpha-lab@1.0.0']);

  const replaceRoot = path.join(temporary, 'explicit-receipt-failure'), replaceStore = createSceneInteractionPackStore(replaceRoot, seed);
  await replaceStore.list(); const beforeReplace = await tree(replaceRoot);
  try {
    fs.readFile = (async (file: any, ...args: any[]) => {
      if (String(file) === receiptPath(replaceRoot)) throw new Error('SYNTHETIC_REPLACE_RECEIPT_BUSY');
      return (nativeRead as any)(file, ...args);
    }) as typeof fs.readFile;
    await assert.rejects(replaceStore.replaceFromSeed(alpha), /受管记录不可用/);
  } finally { fs.readFile = nativeRead; }
  assert.deepEqual(await tree(replaceRoot), beforeReplace, 'Explicit replacement also rolls back without overwriting an unreadable receipt');
  await replaceStore.replaceFromSeed(alpha);
  console.log('PASS metadata transactions: exclusion write failure blocks first-copy completion, retry works, explicit replacement receipt failure rolls back and can retry');
} finally {
  fs.rename = nativeRename; fs.readFile = nativeRead; globalThis.fetch = previousFetch;
  assert.equal(path.dirname(temporary), path.resolve(os.tmpdir())); assert(path.basename(temporary).startsWith('loginote-seed-protection-'));
  await fs.rm(temporary, { recursive: true, force: true });
}
