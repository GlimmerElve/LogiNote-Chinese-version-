// Independent package acceptance uses the production default progressive builder, with synthetic replies only.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { arithmeticConfig } from './fixtures/s2-arithmetic-pack';
import { ScenePackView } from '../src/components/scene/ScenePackView';
import { createSceneInteractionPackStore } from '../src/electron/sceneInteractionPackStore';
import { sceneInteractionPacks } from '../src/services/scene/sceneInteractionPacks';
import { scenePackEditorServices } from '../src/services/scene/scenePackEditorServices';
import { createScenePackHostServices, enqueueSceneInteractionWorkflow, scenePackLocalAdapter } from '../src/services/scene/sceneInteractionHostServices';
import { s2BuiltinPluginRegistry, s2ComposableCapabilities, s2InstalledPluginCatalog } from '../src/services/scene/sceneS2PluginRegistry';
import { loadSceneInteractionPack } from '../src/services/scene/sceneInteractionPackLoader';
import { createS2Scene, designS2Canvas, readS2Definition, readS2Document } from '../src/services/scene/sceneS2Canvas';
import type { LlmCallResponse } from '../src/types';
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import type { SceneInteractionPack, ScenePackConfig, ScenePackViewContext } from '../src/types/sceneInteractionPack';
import type { S2PluginInvocation, S2PluginOutcome } from '../src/types/sceneS2Plugin';

globalThis.fetch = async () => assert.fail('Generic package acceptance forbids real IO/model calls');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'loginote-generic-pack-'));
let host: S2PluginHost | undefined;
try {
  const bundled = await build({ entryPoints: ['scripts/fixtures/s2-arithmetic-pack.ts'], bundle: true,
    format: 'esm', platform: 'browser', write: false, metafile: true });
  assert.deepEqual(Object.keys(bundled.metafile!.inputs), ['scripts/fixtures/s2-arithmetic-pack.ts'], 'The second package depends on no prompt/host implementation');
  const module = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].contents).toString('base64'));
  const pack: SceneInteractionPack = module.activate({ editor: scenePackEditorServices, ui: { react: React } });
  const reference = { id: pack.manifest.id, version: pack.manifest.version };
  assert.deepEqual(pack.manifest.requiredServices, ['execution']);
  const directory = path.join(temporary, reference.id, reference.version);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(pack.manifest));
  await fs.writeFile(path.join(directory, 'main.js'), bundled.outputFiles[0].contents);
  await fs.writeFile(path.join(directory, 'agent.json'), JSON.stringify(pack.describe()));
  await fs.writeFile(path.join(directory, 'styles.css'), '');
  const store = createSceneInteractionPackStore(temporary);
  assert.deepEqual((await store.list()).packs.map(item => item.id), ['arithmetic-lab']);
  const payload = await store.load(reference);
  assert(payload.codeBase64.length > 0);
  const capturedRegistry = s2BuiltinPluginRegistry();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: { sceneInteractionPacks: store } } });
  await loadSceneInteractionPack(reference);
  const loaded = sceneInteractionPacks.resolve(reference); // prompt-lab is deliberately absent from the directory.
  assert.equal(capturedRegistry.capability({ pluginId: 'arithmetic', pluginVersion: '1.0.0', capabilityId: 'sum' }).kind, 'transform');
  assert(s2ComposableCapabilities().some(cap => cap.pluginId === 'arithmetic'));
  assert(!s2ComposableCapabilities().some(cap => cap.pluginId === 'text-template'));
  assert.throws(() => sceneInteractionPacks.resolve({ id: 'prompt-lab', version: '0.1.0' }), /缺少交互包/);
  const definition = readS2Definition(arithmeticConfig.definition);
  const config: ScenePackConfig = { definition, document: readS2Document(arithmeticConfig.document, definition) };
  assert.deepEqual(loaded.validate(config), []);
  const promptReference = { id: 'prompt-lab', version: '0.1.0' };
  sceneInteractionPacks.setAvailable([reference, promptReference]);
  assert(s2ComposableCapabilities().some(cap => cap.pluginId === 'arithmetic') && s2ComposableCapabilities().some(cap => cap.pluginId === 'text-template'),
    'An unbound canvas retains its installed capability catalogue');
  assert(s2ComposableCapabilities(reference).some(cap => cap.pluginId === 'arithmetic'));
  assert(!s2ComposableCapabilities(reference).some(cap => ['text-template', 'model-test'].includes(cap.pluginId)),
    'Arithmetic package selection excludes prompt-owned capabilities even when both packages are available');
  assert(s2ComposableCapabilities(promptReference).some(cap => cap.pluginId === 'text-template'));
  assert(!s2ComposableCapabilities(promptReference).some(cap => cap.pluginId === 'arithmetic'));
  assert(s2InstalledPluginCatalog(reference).plugins.some(plugin => plugin.id === 'structured-view'), 'Terminal-shared capabilities remain in scope');
  assert(!s2InstalledPluginCatalog(reference).plugins.some(plugin => plugin.id === 'text-template'));
  const invocation: S2PluginInvocation = { protocolVersion: 1, id: 'scope-call', sceneId: 'scope-scene', runId: 'scope-run', nodeId: 'scope-node',
    revision: 0, pluginId: 'arithmetic', pluginVersion: '1.0.0', capabilityId: 'sum', idempotencyKey: 'scope-call', inputs: {} };
  await assert.rejects(scenePackLocalAdapter(promptReference)(invocation, { a: [2], b: [3] }, new AbortController().signal), /PACK_CAPABILITY_OUT_OF_SCOPE/,
    'A selected prompt package cannot execute the other package through the global fallback');
  const shared = await scenePackLocalAdapter(reference)({ ...invocation, pluginId: 'json-check', capabilityId: 'validate' },
    { text: ['{}'] }, new AbortController().signal) as S2PluginOutcome;
  assert.equal(shared.status, 'succeeded', 'Shared builtin local handling remains available to a selected package');
  const foreignDefinition = readS2Definition({ ...definition,
    plugins: [...definition.plugins!, { pluginId: 'text-template', pluginVersion: '1.0.0', capabilityId: 'compose' }],
    initial: { ...definition.initial, execution: { ...definition.initial.execution!, nodes: [...definition.initial.execution!.nodes,
      { id: 'foreign', pluginId: 'text-template', pluginVersion: '1.0.0', capabilityId: 'compose', position: { x: 0, y: 300 },
        bindings: { part1: { kind: 'literal', value: 'must not be published' } } }] } } });
  host = new S2PluginHost('cross-pack-denial', foreignDefinition, scenePackLocalAdapter(reference));
  host.setDocument(foreignDefinition.initial);
  const denied = await host.enqueueWorkflow(['foreign']).completion;
  assert.equal(denied.status, 'failed');
  const foreign = denied.nodes.find(node => node.nodeId === 'foreign')!;
  assert.match(foreign.error!, /PACK_CAPABILITY_OUT_OF_SCOPE/);
  assert.deepEqual(foreign.artifactIds, [], 'Cross-package denial must publish no output');
  host.close(); host = undefined;
  const scene = createS2Scene({ source: 'build', sceneSkill: 'S2', subject: '计算两数之和', knowledgePoints: [], interactionPack: reference });
  assert.deepEqual(scene.interactionPack, reference);
  const guide = loaded.describe(), guideSnapshot = JSON.stringify(guide);
  const capabilityKeys = (plugins: any[]) => plugins.flatMap(plugin => plugin.capabilities.map((capability: any) => `${plugin.id}@${plugin.version}/${capability.id}`)).sort();
  const scopedKeys = capabilityKeys(s2InstalledPluginCatalog(reference).plugins);
  const stages: string[] = [];
  const disclosurePhases: string[] = [];
  await designS2Canvas(scene, { invoke: async request => {
    const input = JSON.parse(request.userInput); stages.push(input.stage);
    if (input.stage === 'understand') return { content: JSON.stringify({ goal: '计算两数之和',
      requirements: [{ id: 'sum', source: 'subject', quote: '计算两数之和', description: '计算两数之和' }],
      userRole: '提供数值', agentRole: '搭建计算图', assumptions: [], openQuestions: [],
      delivery: { initial: '完整计算图', deferred: '没有延期交付内容', source: 'subject', quote: '计算两数之和' } }) } as LlmCallResponse;
    assert.equal(input.stage, 'assemble');
    disclosurePhases.push(input.disclosurePhase);
    assert.deepEqual(capabilityKeys(input.discoveryIndex.plugins), scopedKeys, 'Discovery keeps every shared and selected-package capability visible');
    assert(!input.discoveryIndex.plugins.some((plugin: { id: string }) => ['text-template', 'model-test'].includes(plugin.id)),
      'A separate package never discovers prompt-owned capabilities through an available foreign package');
    if (input.disclosurePhase === 'select') {
      assert.equal(input.pluginCatalog, undefined, 'Discovery does not pre-send full interfaces');
      assert.equal(input.interactionPack, undefined, 'Discovery does not pre-send the package manual');
      assert.equal(input.discoveryIndex.purpose, guide.purpose);
      assert.deepEqual(input.discoveryIndex.components, guide.components.map(({ id, name, purpose }) => ({ id, name, purpose })));
      assert(input.discoveryIndex.plugins.every((plugin: any) => plugin.capabilities.every((capability: any) => capability.inputs === undefined && capability.outputs === undefined)));
      assert(!request.systemPromptOverride!.includes(guide.builder.assemble), 'The package assembly instructions are read explicitly after discovery');
      return { content: JSON.stringify({ read: { componentIds: guide.components.map(component => component.id),
        sections: ['builder', 'combinations', 'assistant'], capabilities: definition.plugins } }) } as LlmCallResponse;
    }
    assert.equal(input.disclosurePhase, 'compose');
    assert(input.pluginCatalog.plugins.some((plugin: { id: string }) => plugin.id === 'arithmetic'));
    assert(!input.pluginCatalog.plugins.some((plugin: { id: string }) => ['text-template', 'model-test'].includes(plugin.id)),
      'Builder receives the selected package scope even when other packages are available');
    assert.deepEqual(capabilityKeys(input.pluginCatalog.plugins), definition.plugins!.map(ref => `${ref.pluginId}@${ref.pluginVersion}/${ref.capabilityId}`).sort(), 'Composition receives the explicitly selected interfaces only');
    assert.equal(input.interactionPack.purpose, guide.purpose);
    assert.deepEqual(input.interactionPack.components, guide.components);
    assert.deepEqual(input.interactionPack.combinations, guide.combinations);
    assert.equal(input.interactionPack.assistant.instructions, guide.assistant.instructions);
    assert.equal(input.interactionPack.operations, undefined, 'Runtime operation descriptions are not implicitly read during construction');
    assert.match(request.systemPromptOverride!, /只使用加法及文本展示/);
    assert(!request.systemPromptOverride!.includes('普通原文组装用单个text-template/compose'));
    return { content: JSON.stringify(definition) } as LlmCallResponse;
  } });
  assert.deepEqual(stages, ['understand', 'assemble', 'assemble'], 'Default progressive construction includes the explicit discovery request');
  assert.deepEqual(disclosurePhases, ['select', 'compose']);
  assert.equal(JSON.stringify(loaded.describe()), guideSnapshot, 'Progressive disclosure does not rewrite the public package manual');
  sceneInteractionPacks.setAvailable([reference]);
  host = new S2PluginHost('generic-pack-acceptance', definition, scenePackLocalAdapter(reference));
  host.setDocument(config.document);
  const job = enqueueSceneInteractionWorkflow(host, config, reference, ['show']);
  const result = await job.completion;
  assert.equal(result.status, 'succeeded');
  const shown = result.nodes.find(node => node.nodeId === 'show')!;
  assert.deepEqual(host.currentArtifact(shown.artifactIds[0]).payload, { kind: 'inline', value: '5' });
  assert.deepEqual(host.waitingModelTests(), []);
  const viewState = new Map<string, unknown>();
  const context: ScenePackViewContext = { ...config, node: config.document.execution!.nodes[0], active: true,
    state: { get: <T,>(key: string) => viewState.get(key) as T | undefined,
      initialize<T>(key: string, create: () => T) { if (!viewState.has(key)) viewState.set(key, create()); return viewState.get(key) as T; },
      set(key, value) { viewState.set(key, value); }, delete(key) { viewState.delete(key); } },
    guard() { assert.ok(host, 'The view is scoped to this live synthetic scene'); }, readCurrent: () => config,
    registerPanel() {}, navigate() {}, focusSettings() {}, nodeLabel: id => id, inputLabel: (_nodeId, portId) => portId, onNotice() {},
    onDocumentChange() {}, onInputChange() {}, onError(message: string) { assert.fail(message); } };
  assert.match(renderToStaticMarkup(React.createElement(ScenePackView, { reference, slot: 'settings', context })), /求和设置：sum/);
  const runtime = loaded.createRuntime(config, createScenePackHostServices(host, () => config));
  assert.equal(runtime.dispatch('explainFormula'), 'a + b', 'Business operations are package-defined, without a terminal switch');
  runtime.dispose(); host = undefined;
  // Plain S2 remains executable without selecting any business package.
  host = new S2PluginHost('plain-s2-acceptance', definition, scenePackLocalAdapter());
  host.setDocument(config.document);
  assert.equal((await enqueueSceneInteractionWorkflow(host, config, undefined, ['show']).completion).status, 'succeeded');
  console.log('Generic S2 package passed: standalone arithmetic bundle, directory loading, default progressive discovery→explicit read→composition with selected interfaces, unchanged public manual and complete scope index, cross-package execution denial, shared builtin fallback, custom view/operation, actual 2+3→text execution with prompt-lab unavailable, and plain S2 execution. No real model grant/call or prompt package implementation used.');
} finally {
  host?.close();
  Reflect.deleteProperty(globalThis, 'window');
  assert.equal(path.dirname(temporary), os.tmpdir()); assert(path.basename(temporary).startsWith('loginote-generic-pack-'));
  await fs.rm(temporary, { recursive: true, force: true });
}
