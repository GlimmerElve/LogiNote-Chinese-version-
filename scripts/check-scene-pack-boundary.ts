import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';
import postcss from 'postcss';
import { build, type Plugin } from 'vite';
import type { ScenePackActivationServices } from '../src/types/sceneInteractionPack';
import type { S2PluginHost as Host } from '../src/services/scene/sceneS2PluginHost';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const portable = (value: string) => value.replaceAll('\\', '/').replace(/[?#].*$/, '');
const promptRoot = portable(path.join(root, 'src/interaction-packs/prompt-lab')) + '/';
const isPromptSource = (value: string) => portable(value).toLowerCase().startsWith(promptRoot.toLowerCase());
const privateSelectors = ['.s2-prompt-part', '.s2-compose-editor', '.s2-model-parameters'];

// Use parsed selectors rather than line filtering: shared rules must never disappear with a package rule.
const hostStyles = postcss.parse(await fs.readFile(path.join(root, 'src/components/scene/sceneS2Canvas.css'), 'utf8'));
hostStyles.walkRules(rule => {
  assert(!privateSelectors.some(selector => rule.selector.includes(selector)), `包专属样式仍在 S2 底座：${rule.selector}`);
});
const packageStyles = await fs.readFile(path.join(root, 'src/interaction-packs/prompt-lab/styles.css'), 'utf8');
const packageRules: string[] = [];
postcss.parse(packageStyles).walkRules(rule => { packageRules.push(rule.selector); });
for (const selector of privateSelectors) assert(packageRules.some(value => value.includes(selector)), `包缺少自身样式：${selector}`);
const buildScript = await fs.readFile(path.join(root, 'scripts/build-scene-interaction-pack.mjs'), 'utf8');
assert(!buildScript.includes('sceneS2Canvas.css'), '交互包构建仍从底座提取样式');

let moduleCount = 0, chunkCount = 0;
if (!process.argv.includes('--runtime-only')) {
  // Inspect the actual production graph, including lazy chunks, not a list of guessed import names.
  // A separate JS/CSS package emitted as an asset is allowed; source modules in renderer chunks are not.
  const audit: Plugin = {
    name: 'scene-pack-renderer-boundary',
    generateBundle(_options, bundle) {
      const ids = [...this.getModuleIds()]; moduleCount = ids.length;
      const forbidden = ids.filter(isPromptSource);
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue;
        chunkCount++;
        for (const id of Object.keys(output.modules)) if (isPromptSource(id) && !forbidden.includes(id)) forbidden.push(id);
      }
      const chains = forbidden.map(id => {
        const info = this.getModuleInfo(id), parents = [...(info?.importers ?? []), ...(info?.dynamicImporters ?? [])];
        return `${path.relative(root, id)} <- ${parents.map(parent => path.relative(root, parent)).join(', ') || '(entry)'}`;
      });
      assert.equal(forbidden.length, 0, `生产 renderer 仍依赖提示词包源码：\n${chains.join('\n')}`);
      assert(ids.some(id => portable(id).endsWith('/src/App.tsx')), '审计未包含正式 App 入口');
      assert(ids.some(id => portable(id).endsWith('/src/components/scene/SceneS2CanvasTrial.tsx')), '审计未包含正式 S2 画布');
    },
  };
  await build({ root, configFile: path.join(root, 'vite.config.ts'), logLevel: 'error', plugins: [audit],
    build: { write: false, emptyOutDir: false, minify: false, sourcemap: false } });
}

// Simulate absent prompt source without renaming or deleting shared workspace files.
// Any attempted source resolution fails before the file can be loaded or executed.
const blocked: string[] = [];
const guard = registerHooks({
  resolve(specifier, context, next) {
    const result = next(specifier, context);
    if (result.url.startsWith('file:') && isPromptSource(fileURLToPath(result.url))) {
      blocked.push(result.url); throw new Error(`PROMPT_SOURCE_UNAVAILABLE: ${result.url}`);
    }
    return result;
  },
});
const oldFetch = globalThis.fetch;
let network = 0;
globalThis.fetch = async () => { network++; throw new Error('Boundary acceptance forbids network/model calls'); };
const hosts: Host[] = [];
try {
  const [canvas, hostModule, registry, packs, services, arithmetic] = await Promise.all([
    import('../src/services/scene/sceneS2Canvas'), import('../src/services/scene/sceneS2PluginHost'),
    import('../src/services/scene/sceneS2PluginRegistry'), import('../src/services/scene/sceneInteractionPacks'),
    import('../src/services/scene/sceneInteractionHostServices'), import('./fixtures/s2-arithmetic-pack'),
  ]);
  assert(!registry.s2InstalledPluginCatalog().plugins.some(plugin => ['text-template', 'model-test'].includes(plugin.id)),
    '没有提示词包时，底座仍预装其执行能力');
  const scene = canvas.createS2Scene({ source: 'custom', sceneSkill: 'S2', subject: '无提示词源码的基础画布', knowledgePoints: [], interactionPack: null });
  const parse = { pluginId: 'structured-data', pluginVersion: '1.0.0', capabilityId: 'parse-json' };
  const view = { pluginId: 'structured-view', pluginVersion: '1.0.0', capabilityId: 'json-tree' };
  const definition = canvas.readS2Definition({ ...scene.canvasWorkspace, plugins: [parse, view], initial: {
    nodes: [{ id: 'content', type: 'text', position: { x: 0, y: 0 }, values: { content: '{}' } }], edges: [],
    execution: { version: 1, nodes: [
      { id: 'parse', ...parse, position: { x: 350, y: 0 }, bindings: { text: { kind: 'field', nodeId: 'content', fieldId: 'content' } } },
      { id: 'show', ...view, position: { x: 700, y: 0 }, bindings: {} },
    ], links: [{ source: { nodeId: 'parse', portId: 'value' }, target: { nodeId: 'show', portId: 'value' } }] },
  } });
  const document = canvas.applyS2Commands(definition, definition.initial, [{ op: 'update-node', id: 'content', values: { content: '{"basic":true}' } }]);
  const basic = new hostModule.S2PluginHost('boundary-basic', definition, services.scenePackLocalAdapter(null)); hosts.push(basic);
  basic.setDocument(document);
  const basicRun = await services.enqueueSceneInteractionWorkflow(basic, { definition, document }, null, ['show']).completion;
  assert.equal(basicRun.status, 'succeeded');
  assert.deepEqual(basic.currentArtifact(basicRun.nodes.find(node => node.nodeId === 'parse')!.artifactIds[0]).payload, { kind: 'inline', value: { basic: true } });

  const activation = { editor: {}, ui: { react: { createElement() { throw new Error('Runtime check does not render package views'); } } } } as unknown as ScenePackActivationServices;
  const pack = { ...arithmetic.activate(activation), help: { 'arithmetic/sum': {
    when: '按输入数字计算', example: '2 + 3', difference: '只计算，不判断业务目标', title: '通用元数据求和', description: '由计算包提供的说明',
    inputLabels: { a: '固定的第一个数', b: '第二个数' }, outputLabels: { text: '求和原文' }, hideLiteralInputs: ['a'],
  } } };
  registry.installSceneInteractionCapabilities(pack); packs.sceneInteractionPacks.register(pack);
  const reference = { id: pack.manifest.id, version: pack.manifest.version };
  const arithmeticDefinition = canvas.readS2Definition(arithmetic.arithmeticConfig.definition);
  const arithmeticDocument = canvas.readS2Document(arithmetic.arithmeticConfig.document, arithmeticDefinition);
  assert(!registry.s2ComposableCapabilities(null).some(capability => capability.pluginId === 'arithmetic'), 'An explicit base canvas cannot inherit a previously loaded package');
  const baseScene = canvas.createS2Scene({ source: 'custom', subject: '独立基础画布', sceneSkill: 'S2', knowledgePoints: [], interactionPack: null });
  assert.doesNotThrow(() => canvas.readS2Scene(baseScene));
  assert.throws(() => canvas.readS2Scene({ ...baseScene, canvasWorkspace: arithmeticDefinition }), /范围之外/);
  assert.doesNotThrow(() => canvas.readS2Scene({ ...baseScene, interactionPack: reference, canvasWorkspace: arithmeticDefinition }));
  const presentation = await import('../src/services/scene/sceneS2Presentation');
  const composites = await import('../src/services/scene/sceneS2CompositeCanvas');
  const sumRef = { pluginId: 'arithmetic', pluginVersion: '1.0.0', capabilityId: 'sum' };
  const sumCapability = registry.s2BuiltinPluginRegistry().capability(sumRef);
  assert.equal(presentation.s2NodeTitle(sumRef), '通用元数据求和');
  assert.equal(presentation.s2NodeTitle({ pluginId: 'arithmetic', capabilityId: 'sum' }), '通用元数据求和');
  assert.equal(presentation.s2NodeDescription(sumRef), '由计算包提供的说明');
  assert.equal(presentation.s2PortLabel(sumRef, sumCapability.inputs[0], 'inputs'), '固定的第一个数');
  assert.equal(presentation.s2PortLabel({ ...sumRef, presentation: { label: '场景命名', inputs: { a: '场景指定入口' } } }, sumCapability.inputs[0], 'inputs'), '场景指定入口');
  const wrapped = composites.wrapS2CanvasComposite(arithmeticDocument, arithmeticDefinition.plugins, ['sum'], '通用计算组合');
  const blueprint = composites.s2CanvasCompositeBlueprint(wrapped.document, wrapped.document.composites![0], arithmeticDefinition.plugins);
  assert(!blueprint.parameters.some(parameter => parameter.target.portId === 'a'), 'Generic package metadata keeps fixed literal inputs out of public parameters');
  assert(blueprint.parameters.some(parameter => parameter.target.portId === 'b'));
  assert.deepEqual(blueprint.workflow.nodes[0].bindings.a, { kind: 'literal', value: 2 });
  const sum = new hostModule.S2PluginHost('boundary-arithmetic', arithmeticDefinition, services.scenePackLocalAdapter(reference)); hosts.push(sum);
  sum.setDocument(arithmeticDocument);
  const arithmeticRun = await services.enqueueSceneInteractionWorkflow(sum, { definition: arithmeticDefinition, document: arithmeticDocument }, reference, ['show']).completion;
  assert.equal(arithmeticRun.status, 'succeeded');
  assert.deepEqual(sum.currentArtifact(arithmeticRun.nodes.find(node => node.nodeId === 'show')!.artifactIds[0]).payload, { kind: 'inline', value: '5' });
  const alternate = { ...pack, manifest: { ...pack.manifest, id: 'arithmetic-alternate' },
    capabilities: pack.capabilities.map(plugin => ({ ...plugin, version: '2.0.0' })),
    help: { 'arithmetic/sum': { ...pack.help['arithmetic/sum'], title: '另一个精确版本' } } };
  registry.installSceneInteractionCapabilities(alternate); packs.sceneInteractionPacks.register(alternate);
  assert.equal(presentation.s2NodeTitle({ pluginId: 'arithmetic', capabilityId: 'sum' }), '处理步骤', 'Versionless display references do not guess between loaded releases');
  assert.equal(presentation.s2NodeTitle(sumRef), '通用元数据求和');
  assert.equal(presentation.s2NodeTitle({ ...sumRef, pluginVersion: '2.0.0' }), '另一个精确版本');
  assert.equal(blocked.length, 0); assert.equal(network, 0);
  const graph = process.argv.includes('--runtime-only') ? 'production graph skipped for focused runtime check'
    : `production graph ${moduleCount} modules/${chunkCount} chunks excludes prompt source`;
  console.log(`Scene pack boundary passed: ${graph}; package-owned CSS/build inputs; prompt-source resolution disabled while base JSON canvas and independent arithmetic 2+3→5 run through actual Host; package-provided titles/ports/composite literal policy with exact-version metadata and conservative legacy lookup. No source files renamed/deleted, no network/model calls.`);
} finally { hosts.forEach(host => host.close()); globalThis.fetch = oldFetch; guard.deregister(); }
