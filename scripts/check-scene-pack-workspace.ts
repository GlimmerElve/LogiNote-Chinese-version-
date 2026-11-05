import assert from 'node:assert/strict';
import { createS2Scene, exportS2Workspace, importS2Workspace, importS2WorkspaceWithPack, readS2Definition,
  readS2WorkspaceReference, S2_WORKSPACE_MAX_CHARS } from '../src/services/scene/sceneS2Canvas';
import { installSceneInteractionCapabilities } from '../src/services/scene/sceneS2PluginRegistry';
import { sceneInteractionPacks } from '../src/services/scene/sceneInteractionPacks';
import { scenePackEditorServices } from '../src/services/scene/scenePackEditorServices';
import type { SceneInteractionPackRef } from '../src/types/sceneInteractionPack';
import { activate, arithmeticConfig } from './fixtures/s2-arithmetic-pack';

globalThis.fetch = async () => assert.fail('Workspace acceptance must not make network/model calls');
const definition = readS2Definition(createS2Scene({ source: 'custom', sceneSkill: 'S2', subject: '可分享画布', knowledgePoints: [] }).canvasWorkspace);
// This fixture is also bound to the prompt package below. Supply its logical
// identity explicitly rather than guessing between the two public text types.
definition.initial.nodes[0].componentId = 'content';
const reference = { id: 'prompt-lab', version: '0.1.0' };
const legacy = exportS2Workspace(definition, definition.initial);
assert.deepEqual(JSON.parse(legacy), { format: 's2-workspace', version: 1, definition });
assert.equal(exportS2Workspace(definition, definition.initial, undefined), legacy);
assert.equal(readS2WorkspaceReference(legacy), undefined);
assert.deepEqual(importS2WorkspaceWithPack(legacy), { definition });
assert.deepEqual(importS2Workspace(legacy), definition, 'Definition-only API remains backwards compatible');

for (const interactionPack of [null, reference]) {
  const exported = exportS2Workspace(definition, definition.initial, interactionPack);
  assert.deepEqual(JSON.parse(exported), { format: 's2-workspace', version: 2, definition, interactionPack });
  assert.deepEqual(readS2WorkspaceReference(exported), interactionPack);
  assert.deepEqual(importS2WorkspaceWithPack(exported), { definition, interactionPack });
  assert.deepEqual(importS2Workspace(exported), definition);
  const restored = importS2WorkspaceWithPack(exported);
  assert.equal(exportS2Workspace(restored.definition, restored.definition.initial, restored.interactionPack), exported);
}
const mutable = readS2WorkspaceReference(exportS2Workspace(definition, definition.initial, reference))!;
mutable.version = '9.9.9';
assert.equal(reference.version, '0.1.0', 'Metadata inspection returns owned data, not a live registration');

const envelope = (interactionPack: unknown) => JSON.stringify({ format: 's2-workspace', version: 2, definition, interactionPack });
for (const invalid of [false, 0, '', [], true, {}, { id: 'prompt-lab' }, { version: '0.1.0' },
  { id: '../prompt-lab', version: '0.1.0' }, { id: 'prompt-lab', version: 'latest' }, { id: 'prompt-lab', version: '01.1.0' },
  { id: 'prompt-lab', version: '0.1.0', code: 'execute()' }, { id: 'prompt-lab', version: '0.1.0', permissions: ['model'] }]) {
  assert.throws(() => exportS2Workspace(definition, definition.initial, invalid as SceneInteractionPackRef), /交互包/);
  assert.throws(() => readS2WorkspaceReference(envelope(invalid)), /交互包/);
  assert.throws(() => importS2WorkspaceWithPack(envelope(invalid)), /交互包/);
}
for (const invalid of [
  { format: 's2-workspace', version: 2, definition },
  { format: 's2-workspace', version: 1, definition, interactionPack: null },
  { format: 's2-workspace', version: 3, definition },
  { format: 's2-workspace', version: '2', definition, interactionPack: null },
  { format: 's1-workspace', version: 2, definition, interactionPack: null },
  { format: 's2-workspace', version: 2, definition, interactionPack: null, grant: { remainingCalls: 999 } },
  { format: 's2-workspace', version: 2, definition, interactionPack: null, code: 'execute()' },
  { format: 's2-workspace', version: 2, interactionPack: null },
]) {
  assert.throws(() => readS2WorkspaceReference(JSON.stringify(invalid)));
  assert.throws(() => importS2WorkspaceWithPack(JSON.stringify(invalid)));
}
for (const read of [readS2WorkspaceReference, importS2WorkspaceWithPack, importS2Workspace]) {
  assert.throws(() => read(' '.repeat(S2_WORKSPACE_MAX_CHARS + 1)), /文件过大/);
  assert.throws(() => read('{broken json'));
}
const tooManyNodes = { ...definition, initial: { nodes: Array.from({ length: 41 }, (_, index) => ({
  id: `node${index}`, type: 'text', position: { x: 0, y: 0 }, values: { content: 'x' } })), edges: [] } };
const tooManyText = { ...definition, initial: { nodes: Array.from({ length: 11 }, (_, index) => ({
  id: `node${index}`, type: 'text', position: { x: 0, y: 0 }, values: { content: 'x'.repeat(6000) } })), edges: [] } };
for (const invalid of [tooManyNodes, tooManyText, { ...definition, instructions: { ...definition.instructions, grant: true } }]) {
  const text = JSON.stringify({ format: 's2-workspace', version: 2, definition: invalid, interactionPack: reference });
  assert.deepEqual(readS2WorkspaceReference(text), reference, 'Metadata preflight deliberately does not validate or execute the graph');
  assert.throws(() => importS2WorkspaceWithPack(text), undefined, 'Import retains existing graph bounds and authority rejection');
  assert.throws(() => exportS2Workspace(invalid, invalid.initial, reference));
}

// A recipient must be able to discover an unknown package reference before its capability graph can parse.
const arithmeticReference = { id: 'arithmetic-lab', version: '1.0.0' };
const received = JSON.stringify({ format: 's2-workspace', version: 2, definition: arithmeticConfig.definition, interactionPack: arithmeticReference });
assert.deepEqual(readS2WorkspaceReference(received), arithmeticReference);
assert.throws(() => importS2WorkspaceWithPack(received), undefined, 'An unknown custom capability cannot parse before exact package loading');
assert.throws(() => sceneInteractionPacks.resolve(arithmeticReference), /缺少交互包/);
const pack = activate({ editor: scenePackEditorServices, ui: { react: {} } });
installSceneInteractionCapabilities(pack);
sceneInteractionPacks.register(pack);
const loaded = importS2WorkspaceWithPack(received);
assert.deepEqual(loaded.interactionPack, arithmeticReference);
assert.equal(loaded.definition.initial.execution!.nodes[0].pluginId, 'arithmetic');
assert.deepEqual(importS2WorkspaceWithPack(exportS2Workspace(loaded.definition, loaded.definition.initial, loaded.interactionPack)), loaded);
assert.equal(sceneInteractionPacks.resolve(arithmeticReference).manifest.requiredServices.includes('model'), false);

console.log('Scene package workspace passed: exact version 2 references, explicit unbound null, unchanged legacy version 1 API, bounded metadata preflight before unknown custom-capability loading, graph limits and authority rejection, and full non-prompt package roundtrip. No network or model calls.');
