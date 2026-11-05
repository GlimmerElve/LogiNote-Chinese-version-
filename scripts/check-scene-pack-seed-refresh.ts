import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createSceneInteractionPackStore } from '../src/electron/sceneInteractionPackStore';
import { SCENE_PACK_SEED_RECEIPT, createScenePackSeedManager } from '../src/electron/sceneInteractionPackSeed';

const output = path.resolve('output'); await fs.mkdir(output, { recursive: true });
const temporary = await fs.mkdtemp(path.join(output, 'scene-pack-seed-check-'));
const seed = path.join(temporary, 'seed'), installed = path.join(temporary, 'installed');
const alpha = { id: 'alpha-lab', version: '1.0.0' }, alphaTwo = { id: 'alpha-lab', version: '2.0.0' }, beta = { id: 'beta-lab', version: '1.0.0' };
const links: string[] = [];
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const version = (root: string, ref = alpha) => path.join(root, ref.id, ref.version);
function owned(file: string) {
  const relative = path.relative(temporary, path.resolve(file));
  assert.ok(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative), 'Fixture mutation stays inside its verified temporary workspace');
}
async function remove(file: string) { owned(file); await fs.rm(file, { recursive: true, force: true }); }
async function present(file: string) { return fs.lstat(file).then(() => true, () => false); }
async function writePack(root: string, ref = alpha, build = 'A', extra?: string, material?: string) {
  const directory = version(root, ref); owned(directory); await remove(directory); await fs.mkdir(directory, { recursive: true });
  const common = { id: ref.id, version: ref.version, name: ref.id, paradigm: 'S2', paradigmApiVersion: 1, requiredServices: [] };
  const body = material === undefined ? undefined : Buffer.from(material);
  const manifest = body ? { ...common, protocolVersion: 2, materials: [{ id: 'data', label: '示例资料', path: 'materials/data.json', mediaType: 'application/json', bytes: body.length, sha256: digest(body) }] }
    : { ...common, protocolVersion: 1 };
  await Promise.all(Object.entries({ 'manifest.json': JSON.stringify(manifest), 'main.js': `export const build = ${JSON.stringify(build)};\n`,
    'styles.css': `/* ${build} */`, 'agent.json': JSON.stringify({ build }), 'package.json': '{"type":"module"}' }).map(([name, bytes]) => fs.writeFile(path.join(directory, name), bytes)));
  if (extra) { await fs.mkdir(path.join(directory, 'extras')); await fs.writeFile(path.join(directory, 'extras', extra), build); }
  if (body) { await fs.mkdir(path.join(directory, 'materials')); await fs.writeFile(path.join(directory, 'materials/data.json'), body); }
  return directory;
}
const code = async (root: string, ref = alpha) => fs.readFile(path.join(version(root, ref), 'main.js'), 'utf8');
const receipt = async (root: string) => JSON.parse(await fs.readFile(path.join(root, SCENE_PACK_SEED_RECEIPT), 'utf8'));
async function tree(directory: string) {
  const result: Array<{ path: string; bytes: number; sha256: string }> = [];
  async function walk(folder: string) {
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name); assert.equal(entry.isSymbolicLink(), false);
      if (entry.isDirectory()) await walk(file); else { const bytes = await fs.readFile(file); result.push({ path: path.relative(directory, file).split(path.sep).join('/'), bytes: bytes.length, sha256: digest(bytes) }); }
    }
  }
  await walk(directory); return result.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
const beforeFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('Seed maintenance never activates code, calls a model or uses network');
try {
  await writePack(seed, alpha, 'A', 'old.txt'); await writePack(seed, alphaTwo, 'OTHER-VERSION'); await writePack(seed, beta, 'BETA');
  const retryRoot = path.join(temporary, 'retry-initialization'); await fs.mkdir(retryRoot);
  const retryManager = createScenePackSeedManager(retryRoot, seed), nativeLstat = fs.lstat;
  let entered!: () => void, release!: () => void, injected = 0;
  const entering = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  try {
    fs.lstat = (async (file: any, ...args: any[]) => {
      if (String(file) === path.join(retryRoot, '.initialized')) {
        injected++; entered(); await gate;
        throw Object.assign(new Error('SYNTHETIC_INITIALIZATION_BUSY'), { code: 'EBUSY' });
      }
      return (nativeLstat as any)(file, ...args);
    }) as typeof fs.lstat;
    const initial = retryManager.initialize();
    assert.strictEqual(retryManager.initialize(), initial, 'Concurrent callers share one pending initialization');
    await entering;
    const failed = Promise.allSettled([initial, retryManager.initialize()]);
    release();
    const failures = await failed;
    assert(failures.every(item => item.status === 'rejected' && /SYNTHETIC_INITIALIZATION_BUSY/.test(String(item.reason))));
    assert.equal(injected, 1, 'Concurrent callers must not duplicate filesystem initialization');
  } finally { release(); fs.lstat = nativeLstat; }
  const recovering = retryManager.initialize();
  assert.strictEqual(retryManager.initialize(), recovering, 'Recovery also remains single-flight');
  assert.equal(await recovering, true);
  assert.strictEqual(retryManager.initialize(), recovering, 'Successful initialization stays cached');
  assert.deepEqual(await tree(version(retryRoot)), await tree(version(seed)));
  assert.equal((await fs.readdir(retryRoot)).some(name => name.startsWith('.seed-stage-') || name.startsWith('.seed-backup-')), false);

  const storeRetryRoot = path.join(temporary, 'retry-store'); await fs.mkdir(storeRetryRoot);
  const retryStore = createSceneInteractionPackStore(storeRetryRoot, seed);
  let storeFailures = 0;
  try {
    fs.lstat = (async (file: any, ...args: any[]) => {
      if (String(file) === path.join(storeRetryRoot, '.initialized')) {
        storeFailures++; throw Object.assign(new Error('SYNTHETIC_STORE_BUSY'), { code: 'EBUSY' });
      }
      return (nativeLstat as any)(file, ...args);
    }) as typeof fs.lstat;
    const failures = await Promise.allSettled([retryStore.list(), retryStore.load(alpha)]);
    assert(failures.every(item => item.status === 'rejected' && /SYNTHETIC_STORE_BUSY/.test(String(item.reason))));
    assert.equal(storeFailures, 1, 'List and load share the same failing initialization');
  } finally { fs.lstat = nativeLstat; }
  const [recoveredList, recoveredLoad] = await Promise.all([retryStore.list(), retryStore.load(alpha)]);
  assert.equal(recoveredList.packs.length, 3);
  assert(Buffer.from(recoveredLoad.codeBase64, 'base64').toString().includes('"A"'));
  const partialRoot = path.join(temporary, 'retry-marker'), partialStore = createSceneInteractionPackStore(partialRoot, seed);
  const nativeWriteFile = fs.writeFile;
  try {
    fs.writeFile = (async (file: any, ...args: any[]) => {
      if (String(file) === path.join(partialRoot, '.initialized')) throw Object.assign(new Error('SYNTHETIC_MARKER_BUSY'), { code: 'EBUSY' });
      return (nativeWriteFile as any)(file, ...args);
    }) as typeof fs.writeFile;
    await assert.rejects(partialStore.list(), /SYNTHETIC_MARKER_BUSY/);
  } finally { fs.writeFile = nativeWriteFile; }
  const publishedBeforeRetry = await tree(partialRoot), savedStat = await fs.stat(path.join(version(partialRoot), 'main.js'));
  assert.equal((await partialStore.list()).packs.length, 3);
  assert.deepEqual((await tree(partialRoot)).filter(file => file.path !== '.initialized'), publishedBeforeRetry,
    'Retry after partial initialization cannot replace already published packages or receipts');
  assert.equal((await fs.stat(path.join(version(partialRoot), 'main.js'))).mtimeMs, savedStat.mtimeMs);
  console.log('PASS initialization recovery: one shared failing attempt, concurrent retry, cached success, same-store list/load recovery, partial publication preservation and no leftover stages');
  for (const recovery of ['refresh', 'restart', 'deleted-before-completion']) {
    const root = path.join(temporary, `partial-package-${recovery}`), store = createSceneInteractionPackStore(root, seed);
    const target = version(root), nativeRename = fs.rename;
    let entered!: () => void, release!: () => void, attempts = 0;
    const entering = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    try {
      fs.rename = async (from, to) => {
        if (String(to) === target) {
          attempts++; entered(); await gate;
          throw Object.assign(new Error('SYNTHETIC_PARTIAL_PACKAGE_BUSY'), { code: 'EBUSY' });
        }
        return nativeRename(from, to);
      };
      const pending = Promise.all([store.list(), store.list(), store.load(alphaTwo)]);
      await entering; release();
      const [firstList, secondList, healthy] = await pending;
      assert.equal(attempts, 1, 'Concurrent reads share the same partial initialization attempt');
      assert.equal(firstList.packs.length, 2); assert.equal(secondList.packs.length, 2);
      assert.equal(firstList.errors.length, 1); assert(firstList.errors[0].includes('SYNTHETIC_PARTIAL_PACKAGE_BUSY'));
      assert(Buffer.from(healthy.codeBase64, 'base64').toString().includes('OTHER-VERSION'));
      assert.equal(await present(path.join(root, '.initialized')), false, 'A failed first copy never publishes global completion');
      const retried = await Promise.all([store.list(), store.list()]);
      assert.equal(attempts, 2, 'A new read may retry, but concurrent retries still run only once');
      assert(retried.every(result => result.packs.length === 2 && result.errors.length === 1), 'Current failure is visible without duplicate accumulated diagnostics');
    } finally { release(); fs.rename = nativeRename; }
    const healthyTree = await tree(version(root, alphaTwo)), healthyMtime = (await fs.stat(path.join(version(root, alphaTwo), 'main.js'))).mtimeMs;
    if (recovery === 'deleted-before-completion') {
      assert((await receipt(root)).packages['beta-lab@1.0.0'], 'A successful version already has a durable receipt');
      await remove(version(root, beta));
    }
    const recoveredStore = recovery === 'refresh' ? store : createSceneInteractionPackStore(root, seed);
    const recovered = await recoveredStore.list();
    assert.equal(recovered.packs.length, recovery === 'deleted-before-completion' ? 2 : 3);
    assert.deepEqual(recovered.errors, [], 'Successful retry clears stale partial-failure warnings');
    assert.equal(await present(path.join(root, '.initialized')), true);
    assert.deepEqual(await tree(version(root, alphaTwo)), healthyTree);
    assert.equal((await fs.stat(path.join(version(root, alphaTwo), 'main.js'))).mtimeMs, healthyMtime);
    assert(Buffer.from((await recoveredStore.load(alpha)).codeBase64, 'base64').toString().includes('"A"'));
    assert.equal((await fs.readdir(root)).some(name => name.startsWith('.seed-stage-') || name.startsWith('.seed-backup-')), false);
    // A user can remove a successfully installed exact version before or after
    // full initialization. Neither packaged nor development restart revives it.
    await remove(version(root, alpha));
    for (const refreshSeed of [false, true]) {
      const restarted = await createSceneInteractionPackStore(root, seed, { refreshSeed }).list();
      assert(!restarted.packs.some(ref => ref.id === alpha.id && ref.version === alpha.version));
      if (recovery === 'deleted-before-completion') assert(!restarted.packs.some(ref => ref.id === beta.id));
    }
  }
  console.log('PASS partial seed publication: shared failed/retry attempts, usable healthy versions, no premature marker, refresh/restart recovery, clear warnings, unchanged healthy files and deleted-version non-resurrection before/after completion');
  const first = createSceneInteractionPackStore(installed, seed); assert.equal((await first.list()).packs.length, 3);
  assert.equal((await receipt(installed)).version, 1);
  assert.deepEqual((await receipt(installed)).packages['alpha-lab@1.0.0'].files, await tree(version(installed)));
  assert.ok((await receipt(installed)).packages['alpha-lab@1.0.0'].files.some((file: any) => file.path === 'extras/old.txt'), 'Receipts cover the complete version file-set, not only four fixed assets');
  const otherCode = await code(installed, alphaTwo), betaCode = await code(installed, beta);
  await writePack(seed, alpha, 'B', 'new.txt');
  assert.equal((await createSceneInteractionPackStore(installed, seed).list()).packs.length, 3);
  assert.ok((await code(installed)).includes('"A"'), 'Default/packaged startup retains installed exact versions');
  const refreshed = createSceneInteractionPackStore(installed, seed, { refreshSeed: true }); assert.deepEqual((await refreshed.list()).errors, []);
  assert.ok((await code(installed)).includes('"B"')); assert.equal(await present(path.join(version(installed), 'extras/old.txt')), false);
  assert.equal(await present(path.join(version(installed), 'extras/new.txt')), true);
  assert.equal(await code(installed, alphaTwo), otherCode); assert.equal(await code(installed, beta), betaCode);
  assert.deepEqual((await receipt(installed)).packages['alpha-lab@1.0.0'].files, await tree(version(installed)));

  await fs.appendFile(path.join(version(installed), 'main.js'), '// USER MODIFICATION\n');
  await fs.writeFile(path.join(version(installed), 'my-notes.txt'), 'CUSTOM FILE');
  const custom = await tree(version(installed)); await writePack(seed, alpha, 'C', 'latest.txt');
  await fs.writeFile(path.join(version(installed, alphaTwo), 'extra-local.txt'), 'USER EXTRA ONLY'); await writePack(seed, alphaTwo, 'OTHER-UPDATED');
  await remove(path.join(installed, beta.id)); await writePack(seed, beta, 'BETA-UPDATED');
  const guarded = await createSceneInteractionPackStore(installed, seed, { refreshSeed: true }).list();
  assert.equal(guarded.packs.some(ref => ref.id === beta.id), false, 'Removed packages do not reappear on development restart');
  assert.deepEqual(await tree(version(installed)), custom, 'Modified code and additional local files block automatic overwrite');
  assert.equal(await code(installed, alphaTwo), otherCode, 'An extra file alone marks the exact version as locally modified');
  assert.equal(await fs.readFile(path.join(version(installed, alphaTwo), 'extra-local.txt'), 'utf8'), 'USER EXTRA ONLY');

  const legacy = path.join(temporary, 'legacy'); await writePack(legacy, alpha, 'LEGACY', 'personal.txt');
  await writePack(legacy, { id: 'unrelated-lab', version: '3.0.0' }, 'UNRELATED', 'retain.txt');
  await fs.writeFile(path.join(legacy, '.initialized'), 'scene-interaction-packs-v1\n');
  const legacyBefore = await tree(version(legacy)), unrelated = await tree(version(legacy, { id: 'unrelated-lab', version: '3.0.0' }));
  await createSceneInteractionPackStore(legacy, seed, { refreshSeed: true }).list();
  assert.deepEqual(await tree(version(legacy)), legacyBefore); assert.equal(await present(path.join(legacy, SCENE_PACK_SEED_RECEIPT)), false, 'Existing receiptless installs are never auto-adopted or overwritten');
  const vault = path.join(temporary, 'vault'); await fs.mkdir(vault); await fs.writeFile(path.join(vault, 'note.md'), 'KEEP VAULT');
  const explicit = await createSceneInteractionPackStore(legacy, seed).replaceFromSeed(alpha);
  assert.deepEqual(explicit.reference, alpha); assert.equal(explicit.replaced, true); assert.equal(explicit.restartRequired, true);
  assert.deepEqual(await tree(version(legacy)), await tree(version(seed))); assert.equal(await present(path.join(version(legacy), 'extras/personal.txt')), false);
  assert.deepEqual(await tree(version(legacy, { id: 'unrelated-lab', version: '3.0.0' })), unrelated);
  assert.equal(await fs.readFile(path.join(vault, 'note.md'), 'utf8'), 'KEEP VAULT');
  assert.deepEqual(Object.keys((await receipt(legacy)).packages), ['alpha-lab@1.0.0']);
  assert.equal(await present(version(legacy, alphaTwo)), false); assert.equal(await present(version(legacy, beta)), false, 'Explicit replacement never runs global seeding');

  const priorFiles = await tree(version(legacy)), priorReceipt = await fs.readFile(path.join(legacy, SCENE_PACK_SEED_RECEIPT), 'utf8');
  await fs.writeFile(path.join(version(seed), 'agent.json'), '{broken');
  await assert.rejects(createSceneInteractionPackStore(legacy, seed).replaceFromSeed(alpha));
  assert.deepEqual(await tree(version(legacy)), priorFiles); assert.equal(await fs.readFile(path.join(legacy, SCENE_PACK_SEED_RECEIPT), 'utf8'), priorReceipt);
  await writePack(seed, alpha, 'D');
  const nativeRename = fs.rename;
  try {
    fs.rename = async (from, to) => { if (String(to) === path.join(legacy, SCENE_PACK_SEED_RECEIPT)) throw new Error('SYNTHETIC_RECEIPT_FAILURE'); return nativeRename(from, to); };
    await assert.rejects(createSceneInteractionPackStore(legacy, seed).replaceFromSeed(alpha), /SYNTHETIC_RECEIPT_FAILURE/);
  } finally { fs.rename = nativeRename; }
  assert.deepEqual(await tree(version(legacy)), priorFiles, 'Receipt publication failure rolls the package back atomically');
  assert.equal(await fs.readFile(path.join(legacy, SCENE_PACK_SEED_RECEIPT), 'utf8'), priorReceipt);
  assert.ok(!(await fs.readdir(legacy)).some(name => name.startsWith('.seed-stage-') || name.startsWith('.seed-backup-')));

  const materialSeed = path.join(temporary, 'material-seed'), materialRoot = path.join(temporary, 'material-root');
  await writePack(materialSeed, alpha, 'M1', undefined, '{"value":1}');
  await createSceneInteractionPackStore(materialRoot, materialSeed).list();
  assert.ok((await receipt(materialRoot)).packages['alpha-lab@1.0.0'].files.some((file: any) => file.path === 'materials/data.json'));
  await writePack(materialSeed, alpha, 'M2', undefined, '{"value":2}');
  const materialStore = createSceneInteractionPackStore(materialRoot, materialSeed, { refreshSeed: true }); assert.deepEqual((await materialStore.list()).errors, []);
  assert.equal(Buffer.from((await materialStore.readMaterial(alpha, 'data')).dataBase64, 'base64').toString(), '{"value":2}');
  const materialBefore = await tree(version(materialRoot)); await fs.writeFile(path.join(version(materialSeed), 'materials/data.json'), '{"value":9}');
  assert.ok((await createSceneInteractionPackStore(materialRoot, materialSeed, { refreshSeed: true }).list()).errors.length > 0);
  assert.deepEqual(await tree(version(materialRoot)), materialBefore, 'Invalid v2 material hashes cannot replace the previous validated package');

  const external = path.join(temporary, 'outside'); await writePack(external, alpha, 'EXTERNAL');
  const externalBefore = await tree(version(external));
  const linkedRoot = path.join(temporary, 'linked-root'); await fs.mkdir(path.join(linkedRoot, alpha.id), { recursive: true });
  const linkedTarget = version(linkedRoot); await fs.symlink(version(external), linkedTarget, process.platform === 'win32' ? 'junction' : 'dir'); links.push(linkedTarget);
  await assert.rejects(createSceneInteractionPackStore(linkedRoot, seed).replaceFromSeed(alpha), /符号链接|联接/);
  assert.deepEqual(await tree(version(external)), externalBefore);
  const linkedSeed = path.join(temporary, 'linked-seed'); await fs.mkdir(path.join(linkedSeed, alpha.id), { recursive: true });
  const sourceLink = version(linkedSeed); await fs.symlink(version(external), sourceLink, process.platform === 'win32' ? 'junction' : 'dir'); links.push(sourceLink);
  await assert.rejects(createSceneInteractionPackStore(legacy, linkedSeed).replaceFromSeed(alpha), /符号链接|联接/);
  assert.deepEqual(await tree(version(legacy)), priorFiles); assert.deepEqual(await tree(version(external)), externalBefore);
  assert.throws(() => createSceneInteractionPackStore(legacy, seed).replaceFromSeed({ id: '../outside', version: '1.0.0' }));

  const cliRoot = path.join(temporary, 'cli-root');
  const cli = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/replace-scene-pack-from-build.ts', '--root', cliRoot, '--seed', seed, '--id', alpha.id, '--version', alpha.version], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).reference.id, alpha.id);
  assert.deepEqual(await tree(version(cliRoot)), await tree(version(seed))); assert.equal(await present(version(cliRoot, beta)), false);
  const invalidCli = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/replace-scene-pack-from-build.ts', '--root', 'relative-root', '--seed', seed, '--id', alpha.id, '--version', alpha.version], { encoding: 'utf8' });
  assert.notEqual(invalidCli.status, 0);
  console.log('Scene package seed refresh passed: complete fingerprint receipts, initial copy, dev-only clean updates, stale file removal, changed/extra/receiptless preservation, deleted-package non-resurrection, exact explicit replacement and CLI, unrelated versions/packages/vault untouched, rollback, v2 material integrity, and source/target junction rejection. Isolated temporary files only; no plugin execution or network.');
} finally {
  globalThis.fetch = beforeFetch;
  for (const link of links) if (await present(link)) { owned(link); await fs.unlink(link); }
  const relative = path.relative(output, temporary); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(temporary).startsWith('scene-pack-seed-check-'));
  await fs.rm(temporary, { recursive: true, force: true });
}
