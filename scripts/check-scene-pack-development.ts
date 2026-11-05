import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildScenePack, assertScenePackProtocolReaderInputs } from './build-scene-pack-example.mjs';
import { createScenePackImporter } from '../src/electron/sceneInteractionPackImport';
import { createSceneInteractionPackStore } from '../src/electron/sceneInteractionPackStore';
import { loadSceneInteractionPack, listSceneInteractionPacks } from '../src/services/scene/sceneInteractionPackLoader';
import { sceneInteractionPacks } from '../src/services/scene/sceneInteractionPacks';
import { enqueueSceneInteractionWorkflow, scenePackLocalAdapter, closeSceneInteractionHost } from '../src/services/scene/sceneInteractionHostServices';
import { importS2WorkspaceWithPack, exportS2Workspace } from '../src/services/scene/sceneS2Canvas';
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import type { SceneInteractionPackRef } from '../src/types/sceneInteractionPack';

const repository = process.cwd(), parent = path.join(repository, 'output/scene-pack-development-checks');
await fs.mkdir(parent, { recursive: true });
const realParent = await fs.realpath(parent), realRepo = await fs.realpath(repository);
assert.equal(path.dirname(realParent), path.join(realRepo, 'output'));
const root = await fs.mkdtemp(path.join(realParent, 'pipeline-'));
const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document'), oldFetch = globalThis.fetch;
const hosts: S2PluginHost[] = [], styles: any[] = [];
globalThis.fetch = async () => assert.fail('Development pipeline must not use network/model/user resources');
function cli(script: string, args: string[]) {
  const result = spawnSync(process.execPath, ['scripts/run-tsx-safe.cjs', '--no-scene-pack-bootstrap', script, ...args], { cwd: repository, windowsHide: true, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout); return result.stdout;
}
try {
  assert.deepEqual(sceneInteractionPacks.catalog(), []);
  assert.doesNotThrow(() => assertScenePackProtocolReaderInputs(['apps/community-api/src/scenePackageManifest.ts', 'apps/community-api/src/scenePackageMaterial.ts']));
  for (const input of ['apps/community-api/src/server.ts', 'apps/community-api/src/scenePackageStore.ts', 'src/electron/sceneInteractionPackStore.ts', 'node_modules/evil/index.js', 'apps/community-api/src/scenePackageMaterial.ts/../other.ts'])
    assert.throws(() => assertScenePackProtocolReaderInputs([input]), /不是纯依赖/, input);

  const source = path.join(repository, 'examples/scene-packs/number-scale');
  const first = await buildScenePack({ sourceDir: source, outputRoot: path.join(root, 'dist') });
  const secondSource = path.join(root, 'source-v2'); await fs.cp(source, secondSource, { recursive: true });
  const metadataFile = path.join(secondSource, 'scene-pack.json');
  const metadata = JSON.parse(await fs.readFile(metadataFile, 'utf8')); metadata.manifest.version = '1.1.0';
  await fs.writeFile(metadataFile, JSON.stringify(metadata));
  const second = await buildScenePack({ sourceDir: secondSource, outputRoot: path.join(root, 'dist') });
  const versions = [first, second];
  const store = createSceneInteractionPackStore(path.join(root, 'installed')), importer = createScenePackImporter(path.join(root, 'installed'));
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: { sceneInteractionPacks: store } } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => ({ dataset: {}, textContent: '' }), head: { appendChild: (style: unknown) => styles.push(style) } } });
  const workspace = await fs.readFile(path.join(source, 'sample.s2-workspace.json'), 'utf8');
  const progressFile = path.join(root, 'saved-workspace.json');
  const progressBytes = workspace;
  await fs.writeFile(progressFile, progressBytes);
  const zipBytes: Buffer[] = [];
  let firstPack: unknown, installedFirstCode: unknown;
  for (const built of versions) {
    const before = await fs.readFile(path.join(built.destination, 'main.js'));
    cli('scripts/validate-scene-pack.ts', ['--dir', built.destination]);
    const zip = path.join(root, `${built.manifest.version}.zip`);
    cli('scripts/package-scene-interaction-pack.ts', [built.destination, zip]);
    const bytes = await fs.readFile(zip); zipBytes.push(bytes);
    const result = await importer.install(bytes); assert.equal(result.alreadyInstalled, false);
    const listing = await listSceneInteractionPacks({ refresh: true }); assert(listing.packs.some(pack => pack.version === built.manifest.version));
    const reference: SceneInteractionPackRef = { id: built.manifest.id, version: built.manifest.version };
    await loadSceneInteractionPack(reference);
    if (!firstPack) { firstPack = sceneInteractionPacks.resolve(reference); installedFirstCode = (await store.load(reference)).codeBase64; }
    const original = importS2WorkspaceWithPack(workspace);
    assert.deepEqual(await fs.readFile(path.join(built.destination, 'main.js')), before, 'Validate/package never rewrite compiled input');
    const config = { definition: original.definition, document: structuredClone(original.definition.initial) };
    const host = new S2PluginHost(`pipeline-${reference.version.replaceAll('.', '-')}`, config.definition, scenePackLocalAdapter(reference)); hosts.push(host); host.setDocument(config.document);
    const record = await enqueueSceneInteractionWorkflow(host, config, reference, ['show']).completion; assert.equal(record.status, 'succeeded', JSON.stringify(record));
    assert.deepEqual(host.currentArtifact(record.nodes.find(node => node.nodeId === 'show')!.artifactIds[0]).payload, { kind: 'inline', value: '结果：10' });
    assert.equal(await fs.readFile(progressFile, 'utf8'), progressBytes, 'Installing/loading a new version leaves existing saved workspaces untouched');
  }
  const oldReference = { id: first.manifest.id, version: first.manifest.version };
  await loadSceneInteractionPack(oldReference); assert.equal(sceneInteractionPacks.resolve(oldReference), firstPack);
  assert.equal((await store.load(oldReference)).codeBase64, installedFirstCode, 'New import does not replace the old on-disk release');
  assert.equal((await importer.install(zipBytes[0])).alreadyInstalled, true);
  assert.equal(styles.length, 2, 'Exact releases get independent, one-time styles');
  assert.equal((await store.list()).packs.length, 2);
  const restored = importS2WorkspaceWithPack(await fs.readFile(progressFile, 'utf8')); assert.deepEqual(restored.interactionPack, oldReference);
  const run = await enqueueSceneInteractionWorkflow(hosts[0], { definition: restored.definition, document: restored.definition.initial }, oldReference, ['show']).completion;
  assert.equal(run.status, 'succeeded', 'Old release still executes after the new release is installed');
  console.log('PASS development pipeline: audited shared pure readers / forbidden dependency rejection → source build (two releases) → actual CLI validate → actual CLI ZIP packaging → production immutable import/store → refresh/load without restart → real local graph execution → unchanged old workspace/exact release and repeated import. Isolated files only, no network/model/user data.');
} finally {
  hosts.forEach(host => closeSceneInteractionHost(host)); globalThis.fetch = oldFetch;
  if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow); else Reflect.deleteProperty(globalThis, 'window');
  if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else Reflect.deleteProperty(globalThis, 'document');
  const realRoot = await fs.realpath(root); assert.equal(path.dirname(realRoot), realParent); assert(path.basename(realRoot).startsWith('pipeline-'));
  await fs.rm(realRoot, { recursive: true, force: true });
}
