import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { resolveObjectURL } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildScenePack } from './build-scene-pack-example.mjs';
import { createSceneInteractionPackStore } from '../src/electron/sceneInteractionPackStore';
import { loadSceneInteractionPack } from '../src/services/scene/sceneInteractionPackLoader';
import { sceneInteractionPacks } from '../src/services/scene/sceneInteractionPacks';
import { createScenePackMaterialScope } from '../src/services/scene/sceneInteractionPackMaterials';
import { scenePackEditorServices } from '../src/services/scene/scenePackEditorServices';
import { closeSceneInteractionHost, enqueueSceneInteractionWorkflow, scenePackLocalAdapter } from '../src/services/scene/sceneInteractionHostServices';
import { applyS2Commands, exportS2Workspace, importS2WorkspaceWithPack } from '../src/services/scene/sceneS2Canvas';
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import type { S2WorkflowRun } from '../src/services/scene/sceneS2PluginHost';
import type { ScenePackConfig, ScenePackMaterialScope, ScenePackViewContext } from '../src/types/sceneInteractionPack';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(repository, 'examples/scene-packs/material-study');
const temporaryRoot = path.join(repository, 'output/scene-pack-material-example-checks');
await fs.mkdir(temporaryRoot, { recursive: true });
const realRoot = await fs.realpath(temporaryRoot), relativeRoot = path.relative(await fs.realpath(repository), realRoot);
assert(relativeRoot !== '..' && !relativeRoot.startsWith('..' + path.sep) && !path.isAbsolute(relativeRoot));
const temporary = await fs.mkdtemp(path.join(realRoot, 'material-example-'));
const oldFetch = globalThis.fetch, oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const hosts: S2PluginHost[] = [], scopes: ScenePackMaterialScope[] = [];
let cleanupView: (() => void) | undefined, network = 0;
globalThis.fetch = async () => { network++; throw new Error('Material acceptance forbids network/model calls'); };
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const cli = (directory: string) => spawnSync(process.execPath, [path.join(repository, 'scripts/run-tsx-safe.cjs'), '--no-scene-pack-bootstrap',
  path.join(repository, 'scripts/validate-scene-pack.ts'), '--dir', directory], { cwd: repository, encoding: 'utf8', windowsHide: true });
try {
  assert.deepEqual(sceneInteractionPacks.catalog(), [], 'Use --no-scene-pack-bootstrap; this example starts with an empty business registry');
  const built = await buildScenePack({ sourceDir: source, outputRoot: path.join(temporary, 'distribution') });
  assert.equal(built.manifest.protocolVersion, 2); assert.equal(built.modules, 5);
  const metadata = JSON.parse(await fs.readFile(path.join(source, 'scene-pack.json'), 'utf8'));
  for (const item of metadata.manifest.materials) assert.deepEqual(await fs.readFile(path.join(built.destination, item.path)), await fs.readFile(path.join(source, item.path)));
  const originalHashes = await Promise.all(['manifest.json', 'main.js', 'agent.json', 'styles.css', ...metadata.manifest.materials.map((item: { path: string }) => item.path)]
    .map(async name => [name, hash(await fs.readFile(path.join(built.destination, name)))] as const));
  const validated = cli(built.destination); assert.equal(validated.status, 0, validated.stderr || validated.stdout);
  for (const [name, expected] of originalHashes) assert.equal(hash(await fs.readFile(path.join(built.destination, name))), expected, 'CLI must not rewrite input files');

  // Same material ID in another real package has different bytes; one additional ID belongs only to that package.
  const otherSource = path.join(temporary, 'other-source'); await fs.cp(source, otherSource, { recursive: true });
  const otherMetadata = structuredClone(metadata); otherMetadata.manifest.id = 'material-study-other';
  const otherData = Buffer.from(JSON.stringify({ title: '另一包测验', unit: '分', target: 80, scores: [{ label: '第一次', value: 10 }, { label: '第二次', value: 20 }, { label: '第三次', value: 30 }] }));
  await fs.writeFile(path.join(otherSource, 'materials/scores.json'), otherData);
  Object.assign(otherMetadata.manifest.materials.find((item: { id: string }) => item.id === 'scores'), { bytes: otherData.length, sha256: hash(otherData) });
  const privateData = Buffer.from('only the other package owns this material');
  await fs.writeFile(path.join(otherSource, 'materials/other.txt'), privateData);
  otherMetadata.manifest.materials.push({ id: 'other-note', label: '另一包独有说明', path: 'materials/other.txt', mediaType: 'text/plain', bytes: privateData.length, sha256: hash(privateData) });
  await fs.writeFile(path.join(otherSource, 'scene-pack.json'), JSON.stringify(otherMetadata));
  const other = await buildScenePack({ sourceDir: otherSource, outputRoot: path.join(temporary, 'distribution') });
  const validGuide = await fs.readFile(path.join(otherSource, 'materials/guide.txt'));
  const tamperedGuide = Buffer.from(validGuide); tamperedGuide[0] ^= 1;
  await fs.writeFile(path.join(otherSource, 'materials/guide.txt'), tamperedGuide);
  await assert.rejects(buildScenePack({ sourceDir: otherSource, outputRoot: path.join(temporary, 'bad-build') }), /PACK_MATERIAL_HASH/);
  await assert.rejects(fs.stat(path.join(temporary, 'bad-build')), /ENOENT/, 'Invalid material must be rejected before creating any output');
  await fs.writeFile(path.join(otherSource, 'materials/guide.txt'), validGuide);
  await fs.writeFile(path.join(other.destination, 'materials/guide.txt'), tamperedGuide);
  const rejected = cli(other.destination); assert.notEqual(rejected.status, 0); assert.match(rejected.stderr, /PACK_MATERIAL_HASH/);
  await fs.writeFile(path.join(other.destination, 'materials/guide.txt'), validGuide);

  // A declared material symlink/junction may not reach another id/version, even inside the overall installation tree.
  const ownedMaterials = path.join(other.destination, 'owned-materials');
  await fs.rename(path.join(other.destination, 'materials'), ownedMaterials);
  await fs.symlink(path.join(built.destination, 'materials'), path.join(other.destination, 'materials'), 'junction');
  const escaped = cli(other.destination); assert.notEqual(escaped.status, 0); assert.match(escaped.stderr, /PACK_FILE_SCOPE/);
  await fs.unlink(path.join(other.destination, 'materials'));
  await fs.rename(ownedMaterials, path.join(other.destination, 'materials'));

  const store = createSceneInteractionPackStore(path.join(temporary, 'installed'), path.dirname(path.dirname(built.destination)));
  assert.deepEqual((await store.list()).errors, []);
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: { sceneInteractionPacks: store } } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => ({ dataset: {}, textContent: '' }), head: { appendChild() {} } } });
  const reference = { id: 'material-study', version: '1.0.0' }, otherReference = { id: 'material-study-other', version: '1.0.0' };
  await loadSceneInteractionPack(reference); await loadSceneInteractionPack(otherReference);
  const scope = createScenePackMaterialScope(reference)!, otherScope = createScenePackMaterialScope(otherReference)!; scopes.push(scope, otherScope);
  assert.deepEqual(scope.list().map(item => item.id), ['scores', 'guide', 'legend']);
  assert.match(new TextDecoder().decode((await scope.read('scores')).data), /三次学习测验/);
  assert.match(new TextDecoder().decode((await otherScope.read('scores')).data), /另一包测验/);
  await assert.rejects(scope.read('other-note'), /PACK_MATERIAL_NOT_FOUND/);
  assert.match(new TextDecoder().decode((await otherScope.read('other-note')).data), /only the other package/);
  await assert.rejects(scope.read('../material-study-other/materials/other.txt'), /PACK_MATERIAL_ID/);
  const cancelled = new AbortController(); cancelled.abort(); await assert.rejects(scope.read('scores', cancelled.signal), /PACK_MATERIAL_CANCELLED/);
  const lease = await scope.openUrl('legend'); const blob = resolveObjectURL(lease.url)!;
  assert.equal(blob.type, 'image/png'); assert.equal(blob.size, 176); lease.release(); lease.release(); assert.equal(resolveObjectURL(lease.url), undefined);

  const imported = importS2WorkspaceWithPack(await fs.readFile(path.join(source, 'sample.s2-workspace.json'), 'utf8'));
  let config: ScenePackConfig = { definition: imported.definition, document: structuredClone(imported.definition.initial) };
  const run = async (id: string, current: ScenePackConfig, ref = reference) => {
    const host = new S2PluginHost(id, current.definition, scenePackLocalAdapter(ref)); hosts.push(host); host.setDocument(current.document);
    const result = await enqueueSceneInteractionWorkflow(host, current, ref, ['show']).completion;
    assert.equal(result.status, 'succeeded'); return { host, result };
  };
  const text = (host: S2PluginHost, result: S2WorkflowRun) => host.currentArtifact(result.nodes.find(node => node.nodeId === 'show')!.artifactIds[0]).payload;
  const first = await run('material-example', config);
  assert.match((text(first.host, first.result) as { value: string }).value, /平均 75 分/);
  const second = await run('material-example-other', config, otherReference);
  assert.match((text(second.host, second.result) as { value: string }).value, /平均 20 分/);
  config.document = applyS2Commands(config.definition, config.document, [{ op: 'update-execution-node', id: 'study', bindings: { factor: { kind: 'literal', value: 1.2 } } }]);
  const serialized = exportS2Workspace(config.definition, config.document, reference);
  assert(!serialized.includes('blob:') && !serialized.includes('materials/') && !serialized.includes(repository));
  const restored = importS2WorkspaceWithPack(serialized);
  const reopened = await run('material-example-restored', { definition: restored.definition, document: restored.definition.initial }, restored.interactionPack!);
  assert.match((text(reopened.host, reopened.result) as { value: string }).value, /平均 90 分/);

  // Controlled effect lifecycle + actual host React element/SSR output: no visible browser or second React runtime.
  const slots: unknown[] = []; let cursor = 0; const effects: Array<() => (() => void) | void> = [];
  let finish!: () => void; const loaded = new Promise<void>(resolve => { finish = resolve; });
  const hookHarness = { ...React,
    useState(initial: unknown) { const index = cursor++; if (!(index in slots)) slots[index] = initial;
      return [slots[index], (next: unknown) => { slots[index] = next; if (index === 0 && next || index === 1 && next) finish(); }]; },
    useEffect(effect: () => (() => void) | void) { effects.push(effect); },
  };
  const module = await import('data:text/javascript;base64,' + (await fs.readFile(path.join(built.destination, 'main.js'))).toString('base64'));
  const viewPack = module.activate({ editor: scenePackEditorServices, ui: { react: hookHarness } });
  const View = viewPack.views['example-material-study/summarize'].settings as (props: ScenePackViewContext) => React.ReactElement;
  const viewProps = { materials: scope, materialScopeKey: 'example-view-scope', node: config.document.execution!.nodes[0] } as ScenePackViewContext;
  assert.match(renderToStaticMarkup(View(viewProps)), /正在读取/);
  cleanupView = effects.shift()!() || undefined; await loaded;
  assert.equal(slots[1], '', String(slots[1])); cursor = 0;
  const html = renderToStaticMarkup(View(viewProps)); assert.match(html, /三次学习测验/); assert.match(html, /<svg/); assert.match(html, /src="blob:/); assert.match(html, /这组分数仅用于演示/);
  const imageUrl = (slots[0] as { image: string }).image; assert(resolveObjectURL(imageUrl));
  cleanupView?.(); cleanupView = undefined; assert.equal(resolveObjectURL(imageUrl), undefined, 'View cleanup releases its own image URL lease');
  assert.equal(network, 0); assert(!sceneInteractionPacks.catalog().some(pack => pack.id === 'prompt-lab'));
  console.log('Material example passed: v2 package-only build and unchanged-input CLI verification, byte/hash checks and exact-version path scope, actual isolated Electron store → production loader → S2 execution, two-package ID isolation, save/restore without paths or URLs, JSON/text/image reads, host-React static view and URL lease cleanup. No visible UI, network or model calls.');
} finally {
  cleanupView?.(); scopes.forEach(scope => scope.dispose()); hosts.forEach(host => closeSceneInteractionHost(host)); globalThis.fetch = oldFetch;
  if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow); else Reflect.deleteProperty(globalThis, 'window');
  if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else Reflect.deleteProperty(globalThis, 'document');
  const realTemporary = await fs.realpath(temporary); assert.equal(path.dirname(realTemporary), realRoot); assert(path.basename(realTemporary).startsWith('material-example-'));
  await fs.rm(temporary, { recursive: true, force: true });
}
