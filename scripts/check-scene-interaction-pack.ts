import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildPromptLabPack } from './build-scene-interaction-pack.mjs';
import { promptLabPack } from '../src/interaction-packs/prompt-lab';
import { SceneInteractionPackRegistry, readSceneInteractionPackManifest, readSceneInteractionPackRef } from '../src/services/scene/sceneInteractionPackRegistry';
import { createSceneInteractionPackStore } from '../src/electron/sceneInteractionPackStore';
import { createScenePackHostServices } from '../src/services/scene/sceneInteractionHostServices';
import { readScenePackViewPolicy } from '../src/services/scene/sceneInteractionPackProtocol';
import { scenePackEditorServices } from '../src/services/scene/scenePackEditorServices';
import { loadSceneInteractionPack } from '../src/services/scene/sceneInteractionPackLoader';
import { sceneInteractionPacks } from '../src/services/scene/sceneInteractionPacks';
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { S2ModelTestSession } from '../src/services/scene/sceneS2ModelTest';
import { s2BuiltinPluginInstallation } from '../src/services/scene/sceneS2PluginRegistry';
import { createS2Scene, readS2Definition, readS2Document, readS2Scene } from '../src/services/scene/sceneS2Canvas';
import { experimentDefinition } from './fixtures/s2-experiment';
import type { SceneInteractionPack, ScenePackConfig } from '../src/types/sceneInteractionPack';

globalThis.fetch = async () => assert.fail('Interaction package acceptance forbids real IO/model calls');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'loginote-scene-pack-'));
let host: S2PluginHost | undefined;
try {
  const registry = new SceneInteractionPackRegistry();
  const reference = { id: 'prompt-lab', version: '0.1.0' };
  const canvas = createS2Scene({ source: 'custom', sceneSkill: 'S2', subject: '通用画布引用校验', knowledgePoints: [] });
  for (const interactionPack of [undefined, null, reference])
    assert.doesNotThrow(() => readS2Scene({ ...canvas, interactionPack }), 'S2 accepts legacy, explicitly unbound and exact package references');
  for (const interactionPack of [false, 0, ''])
    assert.throws(() => readS2Scene({ ...canvas, interactionPack } as unknown as typeof canvas), /场景交互包引用无效/,
      'Falsy persisted values must not bypass exact package reference validation');
  registry.register(promptLabPack);
  assert.throws(() => registry.register(promptLabPack), /已注册/);
  assert.throws(() => readSceneInteractionPackRef({ id: '../escape', version: '0.1.0' }));
  assert.throws(() => readSceneInteractionPackManifest({ ...promptLabPack.manifest, paradigmApiVersion: 2 }));
  registry.setAvailable([]);
  assert.throws(() => registry.resolve(reference), /缺少交互包/);
  registry.setAvailable([promptLabPack.manifest]);
  const guide = registry.resolve(reference).describe();
  assert.deepEqual(guide.components.map(x => x.id), ['content', 'compose', 'model-test', 'result', 'material']);
  guide.components.length = 0;
  assert.equal(promptLabPack.describe().components.length, 5, 'Agent descriptions are detached snapshots');

  const seed = path.join(temp, 'seed');
  const output = path.join(seed, 'prompt-lab/0.1.0');
  const build = await buildPromptLabPack(output);
  assert(build.bytes < 150000, 'The package must not drag the application/model services into its bundle');
  const store = createSceneInteractionPackStore(path.join(temp, 'terminal'), seed);
  assert.equal((await store.list()).packs.length, 1);
  const payload = await store.load({ id: 'prompt-lab', version: '0.1.0' });
  const module = await import('data:text/javascript;base64,' + payload.codeBase64);
  const loaded: SceneInteractionPack = module.activate({ editor: scenePackEditorServices, ui: { react: React } });
  assert.deepEqual(loaded.manifest, payload.manifest);
  assert.equal(loaded.views?.['text-template/compose']?.settings, undefined, 'Prompt controls no longer create a separate settings panel');
  assert.equal(typeof loaded.views?.['text-template/compose']?.inline, 'function');
  assert.deepEqual(loaded.canvas, { contentEditing: 'double-click', openSettingsOnSelect: false, contentSettings: 'hide', addMenu: {
    contentLabel: '内容块', groups: loaded.canvas!.addMenu!.groups, otherCapabilities: 'hide' } });
  assert.deepEqual(loaded.canvas!.addMenu!.groups.map(group => group.id), ['assembly', 'model', 'results', 'materials']);
  assert.deepEqual(loaded.canvas!.addMenu!.groups.flatMap(group => group.capabilities.map(capability => `${capability.pluginId}@${capability.pluginVersion}/${capability.capabilityId}`)), [
    'text-template@1.0.0/compose', 'model-test@1.0.0/generate', 'structured-view@1.0.0/text',
    'local-material@1.0.0/read-text', 'local-material@1.0.0/read-image',
  ], 'The default menu has five logical block families, without legacy or unrelated capabilities');
  const composeDefaults = loaded.canvas!.addMenu!.groups[0].capabilities[0].defaults;
  assert.deepEqual(composeDefaults, { prefixes: ['角色：', '任务：', '输出要求：'], separator: '\n' });
  const definition = readS2Definition(structuredClone(experimentDefinition));
  let config: ScenePackConfig = { definition, document: definition.initial };
  assert.deepEqual(loaded.validate(config), []);
  const broken = structuredClone(config); broken.document.execution!.links[0].source.nodeId = 'absent';
  assert(loaded.validate(broken).length > 0);
  const Editor = loaded.views!['text-template/compose'].inline as React.ComponentType<any>;
  const inlineMarkup = renderToStaticMarkup(React.createElement(Editor, { definition, document: definition.initial,
    node: definition.initial.execution!.nodes.find(node => node.id === 'assemble'), active: true,
    guard() {}, focusSettings() { assert.fail('Inline editing must not open an external panel'); },
    onDocumentChange() {}, onInputChange() {}, onError(message: string) { assert.fail(message); } }));
  assert.match(inlineMarkup, /组装结构/);
  assert.match(inlineMarkup, /提示词结构/);
  assert.match(inlineMarkup, /<details[^>]*s2-prompt-node-editor/u);
  assert.equal((inlineMarkup.match(/data-s2-compose-port=/g) ?? []).length, 3);
  assert(!/<select|<form|应用组装设置|载入当前组装设置/u.test(inlineMarkup), 'Structure editing has no duplicate material/source form');
  assert(!inlineMarkup.includes(definition.initial.nodes.find(node => node.id === 'role')!.values.content), 'Source text stays in its original content block');
  assert.ok(!inlineMarkup.includes('<details open'), 'Optional structure controls are collapsed by default');
  const defaultDocument = structuredClone(definition.initial), defaultAssembler = defaultDocument.execution!.nodes.find(node => node.id === 'assemble')!;
  defaultAssembler.bindings = Object.fromEntries(Object.entries(composeDefaults!).map(([port, value]) => [port, { kind: 'literal', value: structuredClone(value) }]));
  const defaultContext: any = { definition, document: defaultDocument, node: defaultAssembler, active: true,
    guard() {}, onDocumentChange() { assert.fail('Rendering must not change the document'); }, onInputChange() { assert.fail('Rendering must not change an input'); },
    onError(message: string) { assert.fail(message); } };
  const composeCapability = loaded.capabilities.find(plugin => plugin.id === 'text-template')!.capabilities.find(capability => capability.id === 'compose')!;
  const defaultPolicy = readScenePackViewPolicy(loaded.views!['text-template/compose'].policy!(defaultContext), composeCapability);
  assert.deepEqual(defaultPolicy.visibleNodeInputs, ['part1', 'part2', 'part3'], 'A new assembler exposes three preset entrances before any content is connected');
  assert.deepEqual(defaultPolicy.inputLabels, { part1: '角色：', part2: '任务：', part3: '输出要求：' });
  const defaultMarkup = renderToStaticMarkup(React.createElement(Editor, defaultContext));
  assert.equal((defaultMarkup.match(/data-s2-compose-port=/g) ?? []).length, 3);
  assert.match(defaultMarkup, /未连接/);
  const ModelView = loaded.views!['model-test/generate'].inline as (context: any) => React.ReactElement<any>;
  const testNode = definition.initial.execution!.nodes.find(node => node.id === 'testModel')!;
  let viewRunTargets: string[][] = [], guarded = 0;
  const modelContext = { ...defaultContext, document: definition.initial, node: testNode, model: { maxOutputTokens: 512, supportsThinking: true },
    guard() { guarded++; }, execution: { enabled: true, run(targets?: string[]) { viewRunTargets.push(targets ?? []); } } };
  const modelTree = ModelView(modelContext), modelMarkup = renderToStaticMarkup(modelTree);
  assert.match(modelMarkup, /aria-label="提示词测试"/);
  assert.match(modelMarkup, /aria-label="模型运行参数"/);
  assert.match(modelMarkup, /aria-label="输出长度上限"/);
  assert.match(modelMarkup, /aria-label="随机性（Temperature）"/);
  assert.match(modelMarkup, /aria-label="思考模式"/);
  const testButton = React.Children.toArray(modelTree.props.children).find(child => React.isValidElement(child) && child.type === 'button') as React.ReactElement<any>;
  assert.equal(testButton.props.children, '测试'); assert.equal(testButton.props.disabled, false);
  assert.deepEqual(viewRunTargets, [], 'Rendering parameters and the test button never starts execution');
  testButton.props.onClick();
  assert.equal(guarded, 1); assert.deepEqual(viewRunTargets, [['testModel']], 'The button requests its model; package runtime owns connected result publication for both UI and Agent');
  const disabledModel = ModelView({ ...modelContext, execution: { ...modelContext.execution, enabled: false } });
  const disabledButton = React.Children.toArray(disabledModel.props.children).find(child => React.isValidElement(child) && child.type === 'button') as React.ReactElement<any>;
  assert.equal(disabledButton.props.disabled, true);
  let staleError = '';
  const staleModel = ModelView({ ...modelContext, guard() { throw new Error('stale-view'); }, onError(message: string) { staleError = message; } });
  const staleButton = React.Children.toArray(staleModel.props.children).find(child => React.isValidElement(child) && child.type === 'button') as React.ReactElement<any>;
  staleButton.props.onClick(); assert.equal(staleError, 'stale-view'); assert.equal(viewRunTargets.length, 1);
  const resourceInput = React.createElement('button', { type: 'button', 'data-host-resource': 'synthetic-native-slot' }, '本局原生资源选择');
  for (const key of ['local-material/read-text', 'local-material/read-image']) {
    const MaterialView = loaded.views![key].inline as (context: any) => React.ReactElement<any>;
    const materialTree = MaterialView({ ...defaultContext, resourceInput });
    assert.equal(materialTree.props.children, resourceInput, 'The package forwards the exact host resource control');
    assert.equal(renderToStaticMarkup(materialTree), renderToStaticMarkup(resourceInput));
    assert.equal(renderToStaticMarkup(MaterialView(defaultContext)), '', 'Without a host slot the package invents no file picker');
  }
  for (const key of ['text-template/bind', 'text-template/render']) {
    assert.equal(loaded.views![key].settings, undefined);
    assert.equal(typeof loaded.views![key].inline, 'function');
  }
  const styles: Array<{ textContent: string }> = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: { sceneInteractionPacks: store } } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement: () => ({ dataset: {}, textContent: '' }), head: { appendChild: (style: { textContent: string }) => styles.push(style) },
  } });
  await loadSceneInteractionPack(reference); await loadSceneInteractionPack(reference);
  assert.equal(styles.length, 1, 'Production loader activates/styles an exact package only once');
  assert.match(styles[0].textContent, /s2-compose-editor/);
  assert.equal(typeof sceneInteractionPacks.resolve(reference).views?.['model-test/generate'].inline, 'function');

  host = new S2PluginHost('pack-acceptance', definition, (call, inputs, signal) => call.pluginId === 'text-template'
    ? loaded.executeLocal(call, inputs, signal) : s2BuiltinPluginInstallation().execute(call, inputs, signal));
  host.setDocument(config.document);
  let sends = 0;
  const session = new S2ModelTestSession({ sceneId: 'pack-acceptance', runId: host.runId, resourceId: 'synthetic-pack-model',
    providerId: 'synthetic', providerLabel: '合成测试', model: 'synthetic',
    limits: { maxRequests: 3, maxReservedOutputTokens: 1536, maxOutputTokens: 512 },
    invoke: async request => { sends++; assert.equal(request.userInput, config.document.nodes.find(x => x.id === 'testInput')!.values.content);
      assert.match(request.systemPromptOverride!, /角色：/); return { content: '插件原始返回', diagnostics: { finishReason: 'stop' } }; } });
  host.approveModelTestSession(session);
  const currentHost = host;
  const runtime = loaded.createRuntime(config, createScenePackHostServices(host, () => config, next => {
    config = next; currentHost.setDocument(next.document);
  }));
  const requestedTargets = ['testModel'];
  const job = runtime.run(requestedTargets);
  assert.deepEqual(requestedTargets, ['testModel'], 'Adding result targets must not mutate caller data');
  for (let i = 0; i < 100 && !host.waitingModelTests().length; i++) await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(sends, 0, 'Package orchestration cannot bypass host confirmation');
  const wait = host.waitingModelTests()[0]; assert(wait);
  assert.throws(() => runtime.dispatch('cancel', { runId: 'another-host-run' }), /RUN_NOT_OWNED/);
  host.confirmModelTest(job.id, wait.id, true);
  const result: any = await job.completion;
  assert.equal(result.status, 'succeeded'); assert.equal(sends, 1);
  const shown = result.nodes.find((x: any) => x.nodeId === 'showResult');
  assert.equal(host.currentArtifact(shown.artifactIds[0]).payload.kind, 'inline');
  assert.equal((host.currentArtifact(shown.artifactIds[0]).payload as any).value, '插件原始返回');
  const state: any = runtime.dispatch('readState'); state.document.nodes[0].values.content = '不能污染原文';
  assert.notEqual(config.document.nodes[0].values.content, '不能污染原文');
  assert.throws(() => runtime.updateConfig(broken), /INVALID_CONFIG/);
  const next = structuredClone(config); next.document.nodes[0].values.content = '另一轮原文';
  next.document = readS2Document(next.document, next.definition); runtime.updateConfig(next);
  const cancelled = runtime.run(['showResult']);
  for (let i = 0; i < 100 && !host.waitingModelTests().length; i++) await new Promise(resolve => setTimeout(resolve, 0));
  runtime.dispatch('cancel', { runId: cancelled.id });
  assert.equal((await cancelled.completion as any).status, 'cancelled'); assert.equal(sends, 1);
  runtime.dispose(); runtime.dispose();
  assert.throws(() => runtime.run(), /PACK_CLOSED/);
  session.close(); host = undefined;

  await assert.rejects(store.load({ id: '../escape', version: '0.1.0' }));
  await assert.rejects(store.load({ id: 'prompt-lab', version: '9.0.0' }));
  // Verified target is inside this test's own temporary terminal directory.
  const installed = path.join(temp, 'terminal/prompt-lab');
  assert.equal(path.dirname(installed), path.join(temp, 'terminal'));
  await fs.rm(installed, { recursive: true });
  assert.equal((await createSceneInteractionPackStore(path.join(temp, 'terminal'), seed).list()).packs.length, 0, 'Restart must not reinstall a removed package');
  console.log(`Scene interaction package passed: standalone ${build.modules}-module/${build.bytes}-byte ESM, five-block guide/menu, three preset entrances and structure-only editor, explicit guarded test button/parameters, host resource slot forwarding, real host text→model-confirmation→raw-result chain, immutable reads, invalid config, owned cancellation, disposal, exact versions, directory seed and removal. Synthetic transport only; no real model/network or installed Electron UI claim.`);
} finally {
  host?.close();
  Reflect.deleteProperty(globalThis, 'window'); Reflect.deleteProperty(globalThis, 'document');
  assert.equal(path.dirname(temp), os.tmpdir()); assert(path.basename(temp).startsWith('loginote-scene-pack-'));
  await fs.rm(temp, { recursive: true, force: true });
}
