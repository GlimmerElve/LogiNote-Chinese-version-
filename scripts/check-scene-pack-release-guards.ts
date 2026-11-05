import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { zipSync, unzipSync } from 'fflate';
import React from 'react';
import { buildScenePack, publishScenePackBuild } from './build-scene-pack-example.mjs';
import { buildPromptLabPack } from './build-scene-interaction-pack.mjs';
import { createScenePackImporter } from '../src/electron/sceneInteractionPackImport';
import { scenePackStyles } from '../src/services/scene/sceneInteractionPackStyles';
import { readSceneInteractionPack } from '../src/services/scene/sceneInteractionPackProtocol';
import { installSceneInteractionCapabilities } from '../src/services/scene/sceneS2PluginRegistry';
import { sceneInteractionPacks } from '../src/services/scene/sceneInteractionPacks';
import { importS2WorkspaceWithPack } from '../src/services/scene/sceneS2Canvas';
import { compileS2PublicCanvas } from '../src/services/scene/sceneS2PublicAuthoring';
import { scenePackEditorServices } from '../src/services/scene/scenePackEditorServices';
import type { ScenePackConfig } from '../src/types/sceneInteractionPack';

const repository = process.cwd(), source = path.join(repository, 'examples/scene-packs/number-scale');
const parent = path.join(repository, 'output/scene-pack-release-guards');
await fs.mkdir(parent, { recursive: true });
const realParent = await fs.realpath(parent), realRepository = await fs.realpath(repository);
assert.equal(path.dirname(realParent), path.join(realRepository, 'output'));
const root = await fs.mkdtemp(path.join(realParent, 'release-'));
const oldFetch = globalThis.fetch; globalThis.fetch = async () => assert.fail('Release guard checks are offline');
function command(script: string, args: string[]) {
  return spawnSync(process.execPath, ['scripts/run-tsx-safe.cjs', '--no-scene-pack-bootstrap', script, ...args], {
    cwd: repository, encoding: 'utf8', timeout: 30000, windowsHide: true,
  });
}
function ok(result: ReturnType<typeof command>) { assert.equal(result.status, 0, result.stderr || result.error?.message || result.stdout); }
async function files(directory: string) {
  const result: Record<string, Uint8Array> = {};
  async function walk(folder: string, prefix = '') {
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      if (entry.isDirectory()) await walk(path.join(folder, entry.name), prefix + entry.name + '/');
      else result[prefix + entry.name] = await fs.readFile(path.join(folder, entry.name));
    }
  }
  await walk(directory); return result;
}
async function activate(directory: string) {
  const module = await import('data:text/javascript;base64,' + (await fs.readFile(path.join(directory, 'main.js'))).toString('base64'));
  const pack = readSceneInteractionPack(module.activate({ editor: scenePackEditorServices, ui: { react: React } }));
  installSceneInteractionCapabilities(pack); sceneInteractionPacks.register(pack); return pack;
}
try {
  const built = await buildScenePack({ sourceDir: source, outputRoot: path.join(root, 'dist') });
  await activate(built.destination);
  const baseline = importS2WorkspaceWithPack(await fs.readFile(path.join(source, 'sample.s2-workspace.json'), 'utf8'));
  const config: ScenePackConfig = { definition: baseline.definition, document: structuredClone(baseline.definition.initial) };
  const sceneFile = path.join(root, 'config.json');
  const sceneCli = async (candidate: ScenePackConfig, directory = built.destination) => {
    await fs.writeFile(sceneFile, JSON.stringify(candidate));
    return command('scripts/validate-scene-pack.ts', ['--dir', directory, '--scene', sceneFile]);
  };
  const original = JSON.stringify(config); ok(await sceneCli(config)); assert.equal(JSON.stringify(config), original);
  const extra = structuredClone(config);
  extra.definition.blockTypes.push({ id: 'not-public', label: '未公开', fields: [{ id: 'body', label: '正文', kind: 'text' }] });
  extra.document.nodes.push({ id: 'forbidden', type: 'not-public', position: { x: 0, y: 0 }, values: { body: 'not public' } });
  extra.definition.initial = structuredClone(extra.document);
  const rejectedExtra = await sceneCli(extra); assert.notEqual(rejectedExtra.status, 0); assert.match(rejectedExtra.stderr, /PUBLIC_DEFINITION_PRIVATE/);
  const foreign = structuredClone(config); foreign.definition.plugins!.push({ pluginId: 'json-check', pluginVersion: '1.0.0', capabilityId: 'validate' });
  const rejectedForeign = await sceneCli(foreign); assert.notEqual(rejectedForeign.status, 0); assert.match(rejectedForeign.stderr, /PUBLIC_DEFINITION_PRIVATE/);
  const readonly = structuredClone(config); readonly.definition.initial.nodes[0].readOnly = true; readonly.document.nodes[0].values.content = 'changed';
  const rejectedReadonly = await sceneCli(readonly); assert.notEqual(rejectedReadonly.status, 0); assert.match(rejectedReadonly.stderr, /只读/);

  // Package-owned internal content cannot be redefined by changing BOTH copies
  // in a caller's config. The trusted baseline is in the installed package.
  const internalSource = path.join(root, 'internal-source'); await fs.cp(source, internalSource, { recursive: true });
  const metadataFile = path.join(internalSource, 'scene-pack.json');
  const metadata = JSON.parse(await fs.readFile(metadataFile, 'utf8')); metadata.manifest.id = 'number-scale-internal';
  metadata.authoring.internal = { blockTypes: [metadata.authoring.components[0].implementation.blockType], document: {
    nodes: [{ id: 'privateBase', type: 'note', position: { x: -100, y: -100 }, values: { content: 'PACKAGE_INTERNAL' } }], edges: [],
  } };
  await fs.writeFile(metadataFile, JSON.stringify(metadata));
  const internalBuilt = await buildScenePack({ sourceDir: internalSource, outputRoot: path.join(root, 'dist') });
  const internalPack = await activate(internalBuilt.destination);
  const internal = compileS2PublicCanvas(internalPack, { version: 1, nodes: [{ id: 'scale', componentId: 'scale', position: { x: 0, y: 0 }, values: { amount: 4, factor: 2 } }], connections: [] }, { goal: '内部基线检查' });
  ok(await sceneCli(internal, internalBuilt.destination));
  for (const kind of ['change', 'delete'] as const) {
    const forged = structuredClone(internal);
    if (kind === 'change') forged.document.nodes.find(node => node.id === 'privateBase')!.values.content = 'FORGED_INTERNAL';
    else forged.document.nodes = forged.document.nodes.filter(node => node.id !== 'privateBase');
    forged.definition.initial = structuredClone(forged.document);
    const result = await sceneCli(forged, internalBuilt.destination); assert.notEqual(result.status, 0); assert.match(result.stderr, /PUBLIC_INTERNAL_IMMUTABLE/);
  }

  const oldFiles = await files(built.destination), installer = createScenePackImporter(path.join(root, 'installed'));
  const oldZip = Buffer.from(zipSync(oldFiles)); await installer.install(oldZip);
  const installedMain = path.join(root, 'installed/number-scale/1.0.0/main.js'), originalInstalled = await fs.readFile(installedMain);
  const badDirectory = path.join(root, 'invalid/number-scale/1.0.0'); await fs.cp(built.destination, badDirectory, { recursive: true });
  for (const [index, css] of ['@import url("https://example.invalid/no.css");', '.broken {'].entries()) {
    assert.throws(() => scenePackStyles({ id: 'number-scale', version: '1.0.0' }, css));
    await fs.writeFile(path.join(badDirectory, 'styles.css'), css);
    await fs.writeFile(path.join(badDirectory, 'main.js'), 'throw new Error("ENTRY_MUST_NOT_RUN"); export function activate() {}');
    const invalid = command('scripts/validate-scene-pack.ts', ['--dir', badDirectory]);
    assert.notEqual(invalid.status, 0); assert.match(invalid.stderr, /PACK_STYLES_INVALID/); assert.doesNotMatch(invalid.stderr, /ENTRY_MUST_NOT_RUN/);
    const output = path.join(root, `invalid-${index}.zip`), packaged = command('scripts/package-scene-interaction-pack.ts', [badDirectory, output]);
    assert.notEqual(packaged.status, 0); await assert.rejects(fs.stat(output), { code: 'ENOENT' });
    const invalidFiles = await files(badDirectory);
    await assert.rejects(installer.install(Buffer.from(zipSync(invalidFiles))));
    await assert.rejects(createScenePackImporter(path.join(root, `bad-install-${index}`)).install(Buffer.from(zipSync(invalidFiles))));
    await assert.rejects(fs.stat(path.join(root, `bad-install-${index}`)), { code: 'ENOENT' });
    assert.deepEqual(await fs.readFile(installedMain), originalInstalled);
  }
  assert.equal((await installer.install(oldZip)).alreadyInstalled, true);
  const changedFiles = { ...oldFiles, 'styles.css': Buffer.from('.new-style { color: green }') };
  await assert.rejects(installer.install(Buffer.from(zipSync(changedFiles))), /同版本/);
  const newerManifest = { ...built.manifest, version: '1.1.0' };
  await installer.install(Buffer.from(zipSync({ ...oldFiles, 'manifest.json': Buffer.from(JSON.stringify(newerManifest)) })));
  assert.deepEqual(await fs.readFile(installedMain), originalInstalled);

  // Run the actual CLI and a separate builder process. A paused read must not
  // turn a directory-generation switch into an installable mixed ZIP.
  const raceSource = path.join(root, 'race-source'); await fs.cp(source, raceSource, { recursive: true });
  await fs.appendFile(path.join(raceSource, 'entry.ts'), '\nexport const packagingRevision = "NEW_BUILD";\n');
  await fs.writeFile(path.join(raceSource, 'styles.css'), '.new-build { color: purple }');
  const expectedNew = await buildScenePack({ sourceDir: raceSource, outputRoot: path.join(root, 'expected-new') });
  const expectedNewFiles = await files(expectedNew.destination);
  assert.notDeepEqual(expectedNewFiles['main.js'], oldFiles['main.js']);
  assert.notDeepEqual(expectedNewFiles['styles.css'], oldFiles['styles.css']);
  // Both complete generations are valid; rejection must be for interleaving,
  // not a malformed source or a pre-existing installed-version conflict.
  await createScenePackImporter(path.join(root, 'new-valid')).install(Buffer.from(zipSync(expectedNewFiles)));

  // Official output names appear only after a complete, synced staging write.
  // Exercise the real CLI, including errors after a successful file creation.
  const zipOutputRoot = path.join(root, 'zip-output'); await fs.mkdir(zipOutputRoot);
  const stagingNames = async (directory: string) => (await fs.readdir(directory)).filter(name => name.startsWith('.scene-pack-zip-'));
  for (const fault of ['write', 'sync', 'close', 'link', 'unsupported', 'cleanup', 'crash-before', 'crash-after'] as const) {
    const directory = path.join(zipOutputRoot, fault); await fs.mkdir(directory);
    const output = path.join(directory, 'published.zip'), fixture = path.join(directory, 'fault.json');
    await fs.writeFile(fixture, JSON.stringify({ source: built.destination, output, fault }));
    const result = command('scripts/fixtures/scene-pack-zip-write-failure.ts', [fixture]);
    assert.match(result.stdout, new RegExp(`ZIP_FAULT:${fault}`), result.stderr);
    const alreadyPublished = ['cleanup', 'crash-after'].includes(fault);
    if (fault === 'cleanup') { ok(result); assert.match(result.stderr, /ZIP 临时文件未能清理/); }
    else if (fault.startsWith('crash-')) assert.equal(result.status, 86, result.stderr);
    else { assert.notEqual(result.status, 0); assert.match(result.stderr, fault === 'unsupported' ? /PACK_ZIP_PUBLISH_UNSUPPORTED/ : /injected ZIP/); }
    if (alreadyPublished) assert.deepEqual(unzipSync(await fs.readFile(output)), unzipSync(oldZip));
    else await assert.rejects(fs.lstat(output), { code: 'ENOENT' });
    const leavesOwnStage = ['cleanup', 'crash-before', 'crash-after'].includes(fault);
    const abandoned = await stagingNames(directory); assert.equal(abandoned.length, leavesOwnStage ? 1 : 0);
    const retry = command('scripts/package-scene-interaction-pack.ts', [built.destination, output]);
    if (alreadyPublished) { assert.notEqual(retry.status, 0); assert.match(retry.stderr, /EEXIST/); }
    else ok(retry);
    assert.deepEqual(unzipSync(await fs.readFile(output)), unzipSync(oldZip));
    assert.deepEqual(await stagingNames(directory), abandoned, 'Retries touch only their own staging file, not abandoned work');
    const verify = createScenePackImporter(path.join(directory, 'installed'));
    assert.equal((await verify.install(await fs.readFile(output))).alreadyInstalled, false);
    assert.equal((await verify.install(await fs.readFile(output))).alreadyInstalled, true);
    assert.deepEqual(await fs.readFile(installedMain), originalInstalled);
  }
  // Preserve a pre-existing file even when this invocation's own write fails.
  const protectedDirectory = path.join(zipOutputRoot, 'protected'); await fs.mkdir(protectedDirectory);
  const protectedOutput = path.join(protectedDirectory, 'existing.zip'), protectedFixture = path.join(protectedDirectory, 'fault.json');
  await fs.writeFile(protectedOutput, 'existing user file, including old partial outputs');
  const protectedBefore = await fs.readFile(protectedOutput);
  await fs.writeFile(protectedFixture, JSON.stringify({ source: built.destination, output: protectedOutput, fault: 'write' }));
  assert.notEqual(command('scripts/fixtures/scene-pack-zip-write-failure.ts', [protectedFixture]).status, 0);
  assert.deepEqual(await fs.readFile(protectedOutput), protectedBefore); assert.deepEqual(await stagingNames(protectedDirectory), []);
  assert.notEqual(command('scripts/package-scene-interaction-pack.ts', [expectedNew.destination, protectedOutput]).status, 0);
  assert.deepEqual(await fs.readFile(protectedOutput), protectedBefore); assert.deepEqual(await stagingNames(protectedDirectory), []);

  // Two real CLI processes race different valid builds to the same ZIP name.
  const concurrentDirectory = path.join(zipOutputRoot, 'concurrent'); await fs.mkdir(concurrentDirectory);
  const concurrentOutput = path.join(concurrentDirectory, 'winner.zip');
  const packageAsync = async (directory: string) => {
    try {
      return { succeeded: true, ...(await promisify(execFile)(process.execPath,
        ['scripts/run-tsx-safe.cjs', '--no-scene-pack-bootstrap', 'scripts/package-scene-interaction-pack.ts', directory, concurrentOutput],
        { cwd: repository, encoding: 'utf8', timeout: 30000, windowsHide: true })) };
    } catch (error) { return { succeeded: false, stderr: String((error as { stderr?: string }).stderr || error) }; }
  };
  const contenders = await Promise.all([packageAsync(built.destination), packageAsync(expectedNew.destination)]);
  assert.equal(contenders.filter(result => result.succeeded).length, 1, JSON.stringify(contenders));
  assert.match(contenders.find(result => !result.succeeded)!.stderr, /EEXIST/);
  const winnerBytes = await fs.readFile(concurrentOutput), winnerFiles = unzipSync(winnerBytes);
  const winnerExpected = Buffer.from(winnerFiles['main.js']).equals(Buffer.from(oldFiles['main.js'])) ? oldZip : Buffer.from(zipSync(expectedNewFiles));
  assert.deepEqual(winnerFiles, unzipSync(winnerExpected)); assert.deepEqual(await stagingNames(concurrentDirectory), []);
  await createScenePackImporter(path.join(concurrentDirectory, 'installed')).install(winnerBytes);
  console.log('PASS atomic ZIP output: real CLI partial-write/sync/close/link failures leave no official ZIP and retry; unsupported filesystems fail closed; cleanup warnings and process-exit recovery preserve full output; exclusive cross-process winner; existing and abandoned files untouched.');

  const raceModes = ['replace', 'last-read', 'roundtrip', 'rollback', 'unrelated'] as const;
  const cases = [...raceModes.map(mode => ({ mode, emulateRenameableHandle: false })),
    ...(['replace', 'last-read', 'roundtrip'] as const).map(mode => ({ mode, emulateRenameableHandle: true }))];
  for (const { mode, emulateRenameableHandle } of cases) {
    const label = `${mode}${emulateRenameableHandle ? '-renameable-handle' : ''}`;
    const outputRoot = path.join(root, `race-${label}`);
    const initial = await buildScenePack({ sourceDir: source, outputRoot });
    const output = path.join(root, `race-${label}.zip`), fixture = path.join(root, `race-${label}.json`);
    await fs.writeFile(fixture, JSON.stringify({ destination: initial.destination, source: raceSource, originalSource: source, outputRoot, output, mode, emulateRenameableHandle }));
    const result = command('scripts/fixtures/scene-pack-packaging-race.ts', [fixture]);
    assert.match(result.stdout, new RegExp(`RACE_SCHEDULED:${mode}`), result.stderr);
    if (['rollback', 'unrelated'].includes(mode) || result.stdout.includes('RACE_BLOCKED_BY_OPEN_HANDLE')) {
      ok(result); assert.deepEqual(unzipSync(await fs.readFile(output)), unzipSync(oldZip));
    } else {
      assert.notEqual(result.status, 0); assert.match(result.stderr, /PACK_BUILD_CHANGED/);
      await assert.rejects(fs.stat(output), { code: 'ENOENT' });
      // Failure releases all handles, and a stable retry emits exactly one
      // complete generation. Installed old bytes remain immutable throughout.
      ok(command('scripts/package-scene-interaction-pack.ts', [initial.destination, output]));
      const retryBytes = await fs.readFile(output), retryFiles = unzipSync(retryBytes);
      assert.deepEqual(retryFiles, unzipSync(Buffer.from(zipSync(mode === 'roundtrip' ? oldFiles : expectedNewFiles))));
      await createScenePackImporter(path.join(root, `race-install-${label}`)).install(retryBytes);
      if (mode !== 'roundtrip') await assert.rejects(installer.install(retryBytes), /同版本/);
      else assert.equal((await installer.install(retryBytes)).alreadyInstalled, true);
    }
    assert.deepEqual(await fs.readFile(installedMain), originalInstalled);
    const beforeExisting = await fs.readFile(output);
    assert.notEqual(command('scripts/package-scene-interaction-pack.ts', [initial.destination, output]).status, 0);
    assert.deepEqual(await fs.readFile(output), beforeExisting, 'An existing ZIP is never overwritten');
    await buildScenePack({ sourceDir: source, outputRoot });
    assert(!(await fs.readdir(path.dirname(initial.destination))).some(name => name.startsWith('.build-')));
  }
  console.log('PASS packaging snapshots: real CLI / cross-process rebuild after main and final CSS reads; native open-handle protection and simulated rename-permitting handles; ABA change rejection without ZIP output; stable complete retry; rollback and unrelated builds allowed; handles released, immutable old install and existing ZIP preserved.');

  const promptDestination = path.join(root, 'prompt-build/prompt-lab/0.1.0');
  await buildPromptLabPack(promptDestination);
  const firstPrompt = await files(promptDestination);
  await Promise.all([buildPromptLabPack(promptDestination), buildPromptLabPack(promptDestination)]);
  assert.deepEqual(await files(promptDestination), firstPrompt);
  const promptZip = path.join(root, 'prompt-built.zip');
  ok(command('scripts/package-scene-interaction-pack.ts', [promptDestination, promptZip]));
  const promptInstaller = createScenePackImporter(path.join(root, 'prompt-installed'));
  await promptInstaller.install(await fs.readFile(promptZip));
  assert.equal((await promptInstaller.install(await fs.readFile(promptZip))).alreadyInstalled, true);

  // Real v2 same-version development iteration: the withdrawn material must
  // disappear from the output AND the actual release CLI's archive.
  const materialSource = path.join(root, 'material-source'); await fs.cp(path.join(repository, 'examples/scene-packs/material-study'), materialSource, { recursive: true });
  const firstMaterial = await buildScenePack({ sourceDir: materialSource, outputRoot: path.join(root, 'dist') });
  const materialMetadataFile = path.join(materialSource, 'scene-pack.json'), materialMetadata = JSON.parse(await fs.readFile(materialMetadataFile, 'utf8'));
  const guide = materialMetadata.manifest.materials.find((item: { id: string }) => item.id === 'guide'); assert(guide);
  materialMetadata.manifest.materials = materialMetadata.manifest.materials.filter((item: { id: string }) => item.id !== 'guide');
  await fs.writeFile(materialMetadataFile, JSON.stringify(materialMetadata)); await fs.unlink(path.join(materialSource, guide.path));
  const rebuilt = await buildScenePack({ sourceDir: materialSource, outputRoot: path.join(root, 'dist') });
  assert.equal(rebuilt.destination, firstMaterial.destination); await assert.rejects(fs.stat(path.join(rebuilt.destination, guide.path)), { code: 'ENOENT' });
  const release = path.join(root, 'material-clean.zip'); ok(command('scripts/package-scene-interaction-pack.ts', [rebuilt.destination, release]));
  const releaseFiles = unzipSync(await fs.readFile(release)); assert.equal(releaseFiles[guide.path], undefined);
  assert(releaseFiles['materials/scores.json']); assert(releaseFiles['materials/legend.png']);

  const previous = await files(rebuilt.destination), sameBytes = async () => assert.deepEqual(await files(rebuilt.destination), previous);
  const outputFiles = Object.entries(previous), publish = (io: typeof fs) => publishScenePackBuild({ destination: rebuilt.destination, source: materialSource, manifest: rebuilt.manifest, files: outputFiles, io });
  await assert.rejects(publish({ ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]).endsWith('styles.css')) throw Object.assign(new Error('synthetic write failure'), { code: 'EIO' });
    return fs.open(...args);
  } } as typeof fs), /synthetic write failure/); await sameBytes();
  await assert.rejects(publish({ ...fs, rename: async (from: Parameters<typeof fs.rename>[0], to: Parameters<typeof fs.rename>[1]) => {
    if (path.basename(String(from)) === 'next') throw Object.assign(new Error('synthetic publish failure'), { code: 'EIO' });
    return fs.rename(from, to);
  } } as typeof fs), /synthetic publish failure/); await sameBytes();
  assert(!(await fs.readdir(path.dirname(rebuilt.destination))).some(name => name.startsWith('.build-')), 'Handled failures leave no mixed or staged release');
  let retainedBackup = '';
  await assert.rejects(publish({ ...fs, rename: async (from: Parameters<typeof fs.rename>[0], to: Parameters<typeof fs.rename>[1]) => {
    if (path.basename(String(to)) === 'previous') retainedBackup = String(to);
    if (['next', 'previous'].includes(path.basename(String(from)))) throw Object.assign(new Error('synthetic publish/restore failure'), { code: 'EIO' });
    return fs.rename(from, to);
  } } as typeof fs), /完整旧产物保留于/);
  assert(retainedBackup); assert.deepEqual(await files(retainedBackup), previous, 'A failed restore must never delete the last good release');
  await assert.rejects(fs.stat(rebuilt.destination), { code: 'ENOENT' });
  await fs.rename(retainedBackup, rebuilt.destination); await sameBytes();
  const retainedTransaction = path.dirname(retainedBackup);
  assert.equal(path.dirname(retainedTransaction), await fs.realpath(path.dirname(rebuilt.destination)));
  assert(path.basename(retainedTransaction).startsWith('.build-')); await fs.rm(retainedTransaction, { recursive: true, force: true });
  await Promise.all([publish(fs), publish(fs)]); await sameBytes();
  const unknown = path.join(rebuilt.destination, 'manual-notes.txt'); await fs.writeFile(unknown, 'manual data');
  await assert.rejects(buildScenePack({ sourceDir: materialSource, outputRoot: path.join(root, 'dist') }), /未知文件/);
  assert.equal(await fs.readFile(unknown, 'utf8'), 'manual data'); await fs.unlink(unknown); await sameBytes();
  const aliasRoot = path.join(root, 'aliased-output'); await fs.symlink(path.join(root, 'dist'), aliasRoot, 'junction');
  await assert.rejects(buildScenePack({ sourceDir: materialSource, outputRoot: aliasRoot }), /不能包含链接/); await sameBytes();
  await fs.unlink(aliasRoot);
  await publish(fs); await sameBytes();
  console.log('PASS release guards: CLI public/internal/readonly boundary parity; shared production CSS rejection before activation, ZIP output and installation; withdrawn v2 material absent from clean rebuilt ZIP; failed writes/publication rollback, concurrent publication, unknown-file preservation and retry; immutable installed versions remain unchanged. Isolated offline fixtures only.');
} finally {
  globalThis.fetch = oldFetch;
  const realRoot = await fs.realpath(root); assert.equal(path.dirname(realRoot), realParent); assert(path.basename(realRoot).startsWith('release-'));
  await fs.rm(realRoot, { recursive: true, force: true });
}
