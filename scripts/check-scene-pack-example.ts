import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildScenePack } from './build-scene-pack-example.mjs';
import { createSceneInteractionPackStore } from '../src/electron/sceneInteractionPackStore';
import { loadSceneInteractionPack } from '../src/services/scene/sceneInteractionPackLoader';
import { sceneInteractionPacks } from '../src/services/scene/sceneInteractionPacks';
import { s2BuiltinPluginRegistry } from '../src/services/scene/sceneS2PluginRegistry';
import { applyS2Commands, createS2Scene, exportS2Workspace, importS2WorkspaceWithPack, readS2Scene } from '../src/services/scene/sceneS2Canvas';
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { createScenePackHostServices, closeSceneInteractionHost, enqueueSceneInteractionWorkflow, scenePackLocalAdapter } from '../src/services/scene/sceneInteractionHostServices';
import type { ScenePackConfig, ScenePackViewContext } from '../src/types/sceneInteractionPack';
import type { S2WorkflowRun } from '../src/services/scene/sceneS2PluginHost';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(repository, 'examples/scene-packs/number-scale');
// esbuild also reads package metadata along an entry's ancestors. Keep transient
// sources inside this workspace rather than traversing the restricted user profile.
const temporaryRoot = path.join(repository, 'output/scene-pack-example-checks');
await fs.mkdir(temporaryRoot, { recursive: true });
const realRepository = await fs.realpath(repository), realTemporaryRoot = await fs.realpath(temporaryRoot);
const relativeTemporaryRoot = path.relative(realRepository, realTemporaryRoot);
assert(relativeTemporaryRoot !== '..' && !relativeTemporaryRoot.startsWith('..' + path.sep) && !path.isAbsolute(relativeTemporaryRoot));
const temporary = await fs.mkdtemp(path.join(realTemporaryRoot, 'loginote-pack-example-'));
const oldFetch = globalThis.fetch, oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const hosts: S2PluginHost[] = [];
let network = 0;
globalThis.fetch = async () => { network++; throw new Error('Developer example acceptance forbids network/model calls'); };
try {
  assert.deepEqual(sceneInteractionPacks.catalog(), [], 'Run with --no-scene-pack-bootstrap: the terminal must start without a business pack');
  assert(!s2BuiltinPluginRegistry().catalog().some(plugin => ['text-template', 'model-test'].includes(plugin.id)));
  const built = await buildScenePack({ sourceDir: source, outputRoot: path.join(temporary, 'distribution') });
  assert.equal(built.manifest.id, 'number-scale');
  assert.equal(built.modules, 5, 'Only the package entry, metadata, plugin, runtime and view enter the bundle; public type imports are erased');
  const metadata = JSON.parse(await fs.readFile(path.join(source, 'scene-pack.json'), 'utf8'));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(built.destination, 'manifest.json'), 'utf8')), metadata.manifest);
  assert.equal(Object.hasOwn(metadata, 'description'), false, 'The machine-only example does not require Agent manuals');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(built.destination, 'agent.json'), 'utf8')), built.description);
  assert.deepEqual(built.description.components.map(component => component.id), ['caption', 'scale', 'result']);
  assert.equal(await fs.readFile(path.join(built.destination, 'styles.css'), 'utf8'), await fs.readFile(path.join(source, 'styles.css'), 'utf8'));

  // Metadata extraction never imports entry code. This deliberately un-runnable entry must still build without executing its probe.
  const probeSource = path.join(temporary, 'metadata-probe'); await fs.mkdir(probeSource);
  const probeMetadata = { manifest: structuredClone(metadata.manifest), description: { purpose: '旧说明兼容验收', components: [], combinations: [],
    operations: [{ id: 'run', description: '运行', parameters: '', errors: [] }], builder: { assemble: '按目标搭建', repair: '保留内容修正' },
    assistant: { instructions: '按需说明结果', defaultAllowedOperations: [] } } };
  await fs.writeFile(path.join(probeSource, 'scene-pack.json'), JSON.stringify(probeMetadata));
  await fs.writeFile(path.join(probeSource, 'styles.css'), '');
  const probe = '__scene_pack_build_probe_' + crypto.randomUUID();
  await fs.writeFile(path.join(probeSource, 'entry.ts'), `globalThis[${JSON.stringify(probe)}] = true; throw new Error('BUILD_MUST_NOT_EXECUTE_ENTRY'); export function activate() { throw new Error('not a runtime fixture'); }`);
  const probeBuild = await buildScenePack({ sourceDir: probeSource, outputRoot: path.join(temporary, 'metadata-probe-output') });
  assert.equal(JSON.parse(await fs.readFile(path.join(probeBuild.destination, 'agent.json'), 'utf8')).operations[0].parameters, '',
    'Build tools reuse the production protocol reader, including its allowed empty parameter description');
  assert.equal(Reflect.has(globalThis, probe), false, 'Build-time metadata extraction must not evaluate arbitrary package code');
  const invalidMetadata = structuredClone(probeMetadata); (invalidMetadata.description as any).extra = true;
  await fs.writeFile(path.join(probeSource, 'scene-pack.json'), JSON.stringify(invalidMetadata));
  await assert.rejects(buildScenePack({ sourceDir: probeSource, outputRoot: path.join(temporary, 'invalid-metadata-output') }), /PACK_CONTRACT_FIELD/);
  await fs.writeFile(path.join(probeSource, 'scene-pack.json'), JSON.stringify(probeMetadata));
  const helper = path.join(repository, 'src/services/scene/sceneOutputSafety.ts').replaceAll('\\', '/');
  await fs.writeFile(path.join(probeSource, 'entry.ts'), `import { isSceneOutputTruncated } from ${JSON.stringify(helper)}; export function activate() { return isSceneOutputTruncated({ content: 'local' }); }`);
  await assert.rejects(buildScenePack({ sourceDir: probeSource, outputRoot: path.join(temporary, 'forbidden-output') }), /宿主实现或包外依赖/);

  // Exercise the actual Electron directory-store implementation in an isolated user-data directory, then the production loader.
  const store = createSceneInteractionPackStore(path.join(temporary, 'installed'), path.dirname(path.dirname(built.destination)));
  const listed = await store.list(); assert.equal(listed.managed, true); assert.deepEqual(listed.errors, []);
  assert.deepEqual(listed.packs.map(pack => pack.id), ['number-scale']);
  const reference = { id: built.manifest.id, version: built.manifest.version };
  const payload = await store.load(reference); assert(payload.codeBase64);
  const styles: Array<{ dataset: Record<string, string>; textContent: string }> = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: { sceneInteractionPacks: store } } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement: (tag: string) => { assert.equal(tag, 'style'); return { dataset: {}, textContent: '' }; },
    head: { appendChild: (style: typeof styles[number]) => { styles.push(style); } },
  } });
  await loadSceneInteractionPack(reference);
  const pack = sceneInteractionPacks.resolve(reference);
  assert.deepEqual(pack.describe(), built.description); assert.deepEqual(pack.authoring, metadata.authoring); assert.equal(styles.length, 1);
  assert.equal(styles[0].dataset.sceneInteractionPack, 'number-scale@1.0.0');
  assert.match(styles[0].textContent, /number-scale-note/);
  await loadSceneInteractionPack(reference); assert.equal(styles.length, 1, 'Repeated loading does not activate/inject twice');

  const workspace = await fs.readFile(path.join(source, 'sample.s2-workspace.json'), 'utf8');
  const imported = importS2WorkspaceWithPack(workspace); assert.deepEqual(imported.interactionPack, reference);
  const definition = imported.definition;
  let config: ScenePackConfig = { definition, document: structuredClone(definition.initial) };
  assert.deepEqual(pack.validate(config), []);
  const host = new S2PluginHost('developer-example', definition, scenePackLocalAdapter(reference)); hosts.push(host);
  host.setDocument(config.document);
  const enqueue = () => enqueueSceneInteractionWorkflow(host, config, reference, ['show']);
  const shownText = (target: S2PluginHost, run: S2WorkflowRun) => target.currentArtifact(run.nodes.find(node => node.nodeId === 'show')!.artifactIds[0]).payload;
  const first = await enqueue().completion; assert.equal(first.status, 'succeeded');
  assert.deepEqual(shownText(host, first), { kind: 'inline', value: '结果：10' });
  const product = first.nodes.find(node => node.nodeId === 'scale')!.artifactIds.map(id => host.currentArtifact(id)).find(artifact => artifact.type.id === 'core.number');
  assert.deepEqual(product!.payload, { kind: 'inline', value: 10 });

  // Structural edit succeeds, but the package's explicitly invoked business check must reject factor=0 BEFORE enqueue.
  config.document = applyS2Commands(definition, config.document, [{ op: 'update-execution-node', id: 'scale', bindings: { factor: { kind: 'literal', value: 0 } } }]);
  host.setDocument(config.document);
  assert(pack.validate(config).some(issue => issue.path.endsWith('/factor')));
  const workflowCount = host.workflowHistory().length, invocationCount = host.history().length;
  assert.throws(enqueue, /PACK_CONFIG_INVALID/);
  assert.equal(host.workflowHistory().length, workflowCount); assert.equal(host.history().length, invocationCount);
  config.document = applyS2Commands(definition, config.document, [
    { op: 'update-execution-node', id: 'scale', bindings: { amount: { kind: 'literal', value: 5 }, factor: { kind: 'literal', value: 3 } } },
    { op: 'update-node', id: 'caption', values: { content: '新名称' } },
  ]);
  host.setDocument(config.document);
  const latest = await enqueue().completion; assert.equal(latest.status, 'succeeded');
  assert.deepEqual(shownText(host, latest), { kind: 'inline', value: '新名称：15' }, 'Existing runtime reads host latest config, not its initial snapshot');

  const savedFile = path.join(temporary, 'saved-scene.json');
  await fs.writeFile(savedFile, exportS2Workspace(definition, config.document, reference));
  const restored = importS2WorkspaceWithPack(await fs.readFile(savedFile, 'utf8')); assert.deepEqual(restored.interactionPack, reference);
  const scene = createS2Scene({ source: 'custom', sceneSkill: 'S2', subject: '重开数值缩放示例', knowledgePoints: [], interactionPack: reference });
  scene.canvasWorkspace = restored.definition; assert.deepEqual(readS2Scene(scene).initial, config.document);
  const restoredHost = new S2PluginHost('developer-example-restored', restored.definition, scenePackLocalAdapter(reference)); hosts.push(restoredHost);
  const restoredConfig = { definition: restored.definition, document: restored.definition.initial };
  restoredHost.setDocument(restoredConfig.document);
  const restoredRun = await enqueueSceneInteractionWorkflow(restoredHost, restoredConfig, reference, ['show']).completion;
  assert.equal(restoredRun.status, 'succeeded'); assert.deepEqual(shownText(restoredHost, restoredRun), { kind: 'inline', value: '新名称：15' });

  // The bundle uses the injected React instance. This is static SSR verification, not a visible client window.
  const Settings = pack.views?.['example-number-scale/scale']?.settings as React.ComponentType<ScenePackViewContext>;
  assert.match(renderToStaticMarkup(React.createElement(Settings, { node: restored.definition.initial.execution!.nodes[0] } as ScenePackViewContext)), /本地数值缩放/);
  const cancellable = new S2PluginHost('developer-example-cancel', restored.definition, scenePackLocalAdapter(reference)); hosts.push(cancellable);
  cancellable.setDocument(restoredConfig.document);
  let cancellationConfig = structuredClone(restoredConfig);
  const runtime = pack.createRuntime(cancellationConfig, createScenePackHostServices(cancellable, () => cancellationConfig));
  cancellationConfig.document = applyS2Commands(cancellationConfig.definition, cancellationConfig.document,
    [{ op: 'update-execution-node', id: 'scale', bindings: { factor: { kind: 'literal', value: 0 } } }]);
  cancellable.setDocument(cancellationConfig.document);
  assert.throws(() => runtime.run(['show']), /INVALID_CONFIG/, 'Package runtime also validates latest config when used outside the terminal enqueue wrapper');
  cancellationConfig = structuredClone(restoredConfig); cancellable.setDocument(cancellationConfig.document);
  assert.throws(() => runtime.dispatch('cancel', { runId: 'not-owned' }), /RUN_NOT_OWNED/);
  const pending = runtime.run(['show']); runtime.dispatch('cancel', { runId: pending.id });
  assert.equal((await pending.completion as S2WorkflowRun).status, 'cancelled');
  runtime.dispose(); runtime.dispose(); assert.throws(() => runtime.run(['show']), /PACK_CLOSED/);
  assert.throws(() => runtime.dispatch('readState'), /PACK_CLOSED/);
  assert.equal(network, 0); assert(!sceneInteractionPacks.catalog().some(item => item.id === 'prompt-lab'));
  console.log('Independent developer example passed: package-only single-file build, inert same-source manifest/Agent metadata with no entry evaluation, host-import rejection, isolated Electron directory store → production loader, injected React SSR, actual numeric/text graph, explicit business validation of latest config before enqueue, save/restore, owned cancellation and idempotent disposal. No prompt implementation, visible UI, network or model calls.');
} finally {
  hosts.forEach(host => closeSceneInteractionHost(host)); globalThis.fetch = oldFetch;
  if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow); else Reflect.deleteProperty(globalThis, 'window');
  if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else Reflect.deleteProperty(globalThis, 'document');
  const realTemporary = await fs.realpath(temporary);
  assert.equal(path.dirname(realTemporary), realTemporaryRoot); assert(path.basename(realTemporary).startsWith('loginote-pack-example-'));
  await fs.rm(temporary, { recursive: true, force: true });
}
