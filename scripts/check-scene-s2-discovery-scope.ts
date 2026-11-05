import assert from 'node:assert/strict';
import type { SceneInteractionPack, ScenePackDescription } from '../src/types/sceneInteractionPack';
import type { S2PluginManifest, S2PluginNode } from '../src/types/sceneS2Plugin';
import { s2BuilderDiscoveryCatalog, type S2BuilderCatalogSource } from '../src/services/scene/sceneS2BuilderCatalog';
import { createS2DesignDisclosure } from '../src/services/scene/sceneS2DesignDisclosure';
import { readSceneInteractionPack, readScenePackDescription, describeSceneInteractionPack, ScenePackProtocolError } from '../src/services/scene/sceneInteractionPackProtocol';
import { sceneInteractionPacks } from '../src/services/scene/sceneInteractionPacks';
import { s2BuiltinPluginRegistry, s2InstalledPluginCatalog } from '../src/services/scene/sceneS2PluginRegistry';
import { browserTemplateDefinition } from './fixtures/s2-browser-definition';

const previousFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('Discovery scope checks forbid models/network/user resources');
type Ref = Pick<S2PluginNode, 'pluginId' | 'pluginVersion' | 'capabilityId'>;
const key = (ref: Ref) => `${ref.pluginId}@${ref.pluginVersion}/${ref.capabilityId}`;
const refs = (catalog: S2BuilderCatalogSource) => catalog.plugins.flatMap(plugin => plugin.capabilities.filter(cap => cap.kind !== 'editor')
  .map(cap => key({ pluginId: plugin.id, pluginVersion: plugin.version, capabilityId: cap.id }))).sort();
const ref = (pluginId: string, capabilityId: string, pluginVersion = '1.0.0'): Ref => ({ pluginId, pluginVersion, capabilityId });
function freeze(value: unknown) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } }
let runtimes = 0, executions = 0;
try {
  const prompt = sceneInteractionPacks.resolve({ id: 'prompt-lab', version: '0.1.0' });
  const guide = describeSceneInteractionPack(prompt), source = s2InstalledPluginCatalog({ id: prompt.manifest.id, version: prompt.manifest.version });
  const registryBefore = JSON.stringify(s2BuiltinPluginRegistry().catalog()), sourceBefore = JSON.stringify(source), guideBefore = JSON.stringify(guide);
  const scoped = s2BuilderDiscoveryCatalog(source, guide);
  assert.deepEqual(guide.components.map(component => component.id), ['content', 'compose', 'model-test', 'result', 'material']);
  assert.deepEqual(guide.components[0].capabilities, []);
  assert.deepEqual(refs(scoped), ['local-material@1.0.0/read-image', 'local-material@1.0.0/read-text', 'model-test@1.0.0/generate', 'structured-view@1.0.0/text', 'text-template@1.0.0/compose']);
  assert.ok(refs(source).includes('human-input@1.0.0/confirm') && refs(source).includes('text-template@1.0.0/bind'));
  assert.ok(!refs(scoped).some(id => id.startsWith('human-input@') || /\/(bind|render)$/.test(id)), 'Fresh prompt discovery omits unrelated human/legacy interfaces without uninstalling them');
  const disclosure = createS2DesignDisclosure({ catalog: scoped, allTypeProviders: s2BuiltinPluginRegistry().catalog(), guide });
  assert.deepEqual(disclosure.index.plugins.flatMap(plugin => plugin.capabilities.map(cap => `${plugin.id}@${plugin.version}/${cap.id}`)).sort(), refs(scoped));
  assert.deepEqual(disclosure.index.components.map(component => component.id), guide.components.map(component => component.id));

  // Exact references retained from a saved graph and a blueprint interface join
  // the recommendations only when already present in the selected source scope.
  const graphRefs: Ref[] = browserTemplateDefinition.initial.execution!.nodes.map(({ pluginId, pluginVersion, capabilityId }) => ({ pluginId, pluginVersion, capabilityId }));
  const blueprintRefs = [ref('human-input', 'confirm')];
  const retained = [...graphRefs, ...blueprintRefs, ...graphRefs];
  const retainedBefore = JSON.stringify(retained), compatible = s2BuilderDiscoveryCatalog(source, guide, retained);
  assert.deepEqual(refs(compatible), [...new Set([...refs(scoped), ...retained.map(key)])].sort());
  assert.ok(refs(compatible).includes('text-template@1.0.0/render') && refs(compatible).includes('human-input@1.0.0/confirm'));
  assert.deepEqual(refs(s2BuilderDiscoveryCatalog(source, guide, [...retained, ref('uninstalled-private', 'work'), ref('text-template', 'bind', '9.9.9')])), refs(compatible),
    'Retained references cannot introduce an uninstalled or foreign-version capability into discovery');
  for (const plugin of compatible.plugins) for (const cap of plugin.capabilities) assert.deepEqual(cap,
    source.plugins.find(item => item.id === plugin.id && item.version === plugin.version)!.capabilities.find(item => item.id === cap.id));

  const generic = s2InstalledPluginCatalog(null), genericBefore = JSON.stringify(generic);
  const oldGuide = structuredClone(guide); oldGuide.components.forEach(component => { delete component.capabilities; });
  const partialGuide = structuredClone(guide); delete partialGuide.components[0].capabilities;
  assert.equal(s2BuilderDiscoveryCatalog(generic), generic, 'No selected package keeps the generic catalog');
  assert.equal(s2BuilderDiscoveryCatalog(source, oldGuide), source, 'An old package with no metadata keeps its full catalog');
  assert.equal(s2BuilderDiscoveryCatalog(source, partialGuide), source, 'Partial metadata never silently narrows undeclared components');
  assert.equal(s2BuilderDiscoveryCatalog(source, { ...guide, components: [] }), source);
  const nativeGuide = readScenePackDescription({ ...guide, components: [guide.components[0]] });
  const nativeOnly = s2BuilderDiscoveryCatalog(source, nativeGuide);
  assert.deepEqual(nativeOnly.plugins, []); assert.deepEqual(nativeOnly.fieldEditors, source.fieldEditors, '[] means ordinary canvas content, preserving field editors');

  // Public declaration/registration contracts stay independent of prompt-lab.
  const manifest = (id: string, version = '1.0.0'): S2PluginManifest => ({ protocolVersion: 1, id, version, label: id, meaning: '开发者自定义处理',
    dependencies: [{ id: 'core', version: '1.0.0' }], dataTypes: [], capabilities: [{ id: 'work', kind: 'transform', meaning: '原样处理文本', effect: 'pure', permissions: [], confirmation: 'none', retry: 'manual-only', timeoutMs: 1000,
      inputs: [{ id: 'input', label: '输入', meaning: '原文', type: { id: 'core.text', version: 1 }, required: true, multiple: false }],
      outputs: [{ id: 'text', label: '输出', meaning: '完整原文', type: { id: 'core.text', version: 1 }, required: true, multiple: false }] }] });
  const owned = manifest('discovery-owned'), shared = manifest('discovery-shared', '2.0.0');
  const ownedRef = ref(owned.id, 'work'), sharedRef = ref(shared.id, 'work', shared.version);
  const customGuide: ScenePackDescription = { purpose: '开发者自定义场景', components: [
    { id: 'author-defined-component', name: '开发者组件', purpose: '自定义用途', configuration: '精确端口', example: {}, capabilities: [ownedRef, sharedRef] },
    { id: 'native-content', name: '原生内容', purpose: '只填写正文', configuration: 'text/content', example: {}, capabilities: [] },
  ], combinations: [], operations: [], builder: { assemble: '按用户需求搭建', repair: '保留原文和真实接口' }, assistant: { instructions: '按需解释', defaultAllowedOperations: [] } };
  const makePack = (description: ScenePackDescription): SceneInteractionPack => ({
    manifest: { protocolVersion: 1, id: 'discovery-test-pack', version: '1.0.0', name: '独立目录合同包', paradigm: 'S2', paradigmApiVersion: 1, requiredServices: [] },
    capabilities: [owned], describe: () => description, validate: () => [],
    createRuntime: () => { runtimes++; throw new Error('Declaration validation must never create a runtime'); },
    executeLocal: async () => { executions++; throw new Error('Declaration validation must never execute a capability'); },
  });
  const customBefore = JSON.stringify({ customGuide, owned, shared });
  const checked = readSceneInteractionPack(makePack(customGuide), { sharedCapabilities: [shared] });
  assert.deepEqual(checked.describe().components[0].capabilities, [ownedRef, sharedRef]);
  const detached = checked.describe(); detached.components[0].capabilities![0].pluginVersion = '9.9.9';
  assert.equal(checked.describe().components[0].capabilities![0].pluginVersion, '1.0.0');
  const sixteen = { ...structuredClone(owned), capabilities: Array.from({ length: 16 }, (_, index) => ({ ...structuredClone(owned.capabilities[0]), id: `work${index + 1}` })) };
  const fullGuide = structuredClone(customGuide); fullGuide.components[0].capabilities = sixteen.capabilities.map(cap => ref(sixteen.id, cap.id));
  assert.equal(readSceneInteractionPack({ ...makePack(fullGuide), capabilities: [sixteen] }, { sharedCapabilities: [] }).describe().components[0].capabilities!.length, 16,
    'The optional contract accepts sixteen distinct developer-owned interfaces, independent of prompt presets');
  for (const invalid of [ref('missing-plugin', 'work'), ref(owned.id, 'missing'), ref(owned.id, 'work', '2.0.0'), ref(shared.id, 'work', '1.0.0'), ref('foreign-private', 'work'), ref('core', 'text')]) {
    const bad = structuredClone(customGuide); bad.components[0].capabilities = [invalid];
    assert.throws(() => readSceneInteractionPack(makePack(bad), { sharedCapabilities: [shared, ...s2BuiltinPluginRegistry().catalog(), manifest(owned.id, '2.0.0')] }), (error: unknown) => {
      assert.ok(error instanceof ScenePackProtocolError); assert.equal(error.code, 'PACK_CONTRACT_REFERENCE'); assert.match(error.path, /components\/0\/capabilities\/0/); return true;
    });
  }
  for (const capabilities of [[ownedRef, ownedRef], Array(17).fill(ownedRef), [{ ...ownedRef, pluginVersion: 'latest' }], [{ ...ownedRef, pluginVersion: '^1.0.0' }],
    [{ ...ownedRef, pluginVersion: '1.0.0-beta' }], [{ ...ownedRef, permission: 'model-call' }], [{ pluginId: owned.id, capabilityId: 'work' }], new Array(1)]) {
    const bad = structuredClone(customGuide); (bad.components[0] as any).capabilities = capabilities;
    assert.throws(() => readScenePackDescription(bad));
  }
  let getters = 0; const hostile = structuredClone(customGuide);
  Object.defineProperty(hostile.components[0], 'capabilities', { enumerable: true, get() { getters++; return [ownedRef]; } });
  assert.throws(() => readScenePackDescription(hostile)); assert.equal(getters, 0);
  for (const invalid of [ref('missing-plugin', 'work'), ref('foreign-private', 'work'), ref('text-template', 'compose', '9.9.9')]) {
    const bad = structuredClone(guide); bad.components[1].capabilities = [invalid];
    assert.throws(() => s2BuilderDiscoveryCatalog(source, bad), /未安装或不在本包范围/);
  }
  const frozenSource = structuredClone(source), frozenGuide = structuredClone(guide), frozenRetained = structuredClone(retained);
  freeze(frozenSource); freeze(frozenGuide); freeze(frozenRetained);
  assert.deepEqual(refs(s2BuilderDiscoveryCatalog(frozenSource, frozenGuide, frozenRetained)), refs(compatible));
  assert.equal(JSON.stringify(source), sourceBefore); assert.equal(JSON.stringify(guide), guideBefore); assert.equal(JSON.stringify(retained), retainedBefore);
  assert.equal(JSON.stringify(generic), genericBefore); assert.equal(JSON.stringify(s2BuiltinPluginRegistry().catalog()), registryBefore);
  assert.equal(JSON.stringify({ customGuide, owned, shared }), customBefore);
  assert.equal(runtimes, 0); assert.equal(executions, 0);
  console.log('S2 discovery scope passed: five prompt components/five exact capabilities, old/partial/no-package compatibility, native content only, retained graph/blueprint interfaces without installation expansion, strict own/shared exact refs and bounded metadata, detached descriptions and immutable inputs. Declaration reads only; no runtime, grants, models or network.');
} finally { globalThis.fetch = previousFetch; }
