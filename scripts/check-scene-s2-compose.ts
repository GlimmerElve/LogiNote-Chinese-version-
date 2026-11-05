import assert from 'node:assert/strict';
import type { S2Artifact, S2PluginInvocation } from '../src/types/sceneS2Plugin';
import { composeS2Text, executeS2TextTemplate } from '../src/interaction-packs/prompt-lab/textTemplate';
import { createS2Scene, readS2Definition, applyS2Commands } from '../src/services/scene/sceneS2Canvas';
import { s2BuiltinPluginRegistry, s2BuiltinPluginInstallation, s2ComposableCapabilities } from '../src/services/scene/sceneS2PluginRegistry';
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';

globalThis.fetch = async () => assert.fail('Single-node composition regression forbids network and models');
assert.equal(composeS2Text(['角色原文', '任务原文'], ['角色：', '任务：']), '角色：角色原文\n任务：任务原文');
assert.equal(composeS2Text([undefined, '', undefined, ' {{unknown}} $& <script>原样</script> '], ['', '空槽：', '', '材料：'], '|'), '空槽：|材料： {{unknown}} $& <script>原样</script> ');
assert.equal(composeS2Text(['']), '');
assert.equal(composeS2Text(['甲', '乙'], [], ''), '甲乙');
assert.equal(composeS2Text(Array.from({ length: 8 }, (_, i) => String(i + 1)), [], ','), '1,2,3,4,5,6,7,8');
assert.equal(composeS2Text([undefined, '乙'], ['不会应用给乙', '第二槽：']), '第二槽：乙');
assert.equal(composeS2Text(['x'.repeat(5880)], ['前'.repeat(120)]).length, 6000);
assert.equal(composeS2Text(['x'.repeat(2940), 'y'.repeat(2940)], [], '隔'.repeat(120)).length, 6000);
for (const parts of [[], [undefined], Array(1), ['a', ...Array(8).fill('b')], [null], [false], [1], ['x'.repeat(6001)]])
  assert.throws(() => composeS2Text(parts as Array<string | undefined>));
for (const prefixes of [null, {}, '前缀', Array(1), Array(9).fill(''), [false], [1], ['x'.repeat(121)]])
  assert.throws(() => composeS2Text(['甲'], prefixes as any));
for (const separator of [null, false, 1, 'x'.repeat(121)]) assert.throws(() => composeS2Text(['甲'], [], separator as any));
assert.throws(() => composeS2Text(['x'.repeat(6000)], ['前']), /不截断/);
assert.throws(() => composeS2Text(['x'.repeat(3000), 'y'.repeat(3000)]), /不截断/);
let getterReads = 0;
const accessor = Object.defineProperty(['甲'], 0, { enumerable: true, get() { getterReads++; return '不能调用'; } });
assert.throws(() => composeS2Text(accessor)); assert.throws(() => composeS2Text(['甲'], accessor)); assert.equal(getterReads, 0);
const original = ['甲', '乙'], prefixes = ['一：', '二：'];
assert.equal(composeS2Text(original, prefixes), '一：甲\n二：乙'); assert.deepEqual(original, ['甲', '乙']); assert.deepEqual(prefixes, ['一：', '二：']);

const capability = { pluginId: 'text-template', pluginVersion: '1.0.0', capabilityId: 'compose' };
const registry = s2BuiltinPluginRegistry(), declared = registry.capability(capability);
assert.equal(declared.effect, 'pure'); assert.deepEqual(declared.permissions, []); assert.equal(declared.confirmation, 'none');
assert.deepEqual(declared.inputs.map(port => [port.id, port.type.id, port.required, port.multiple]), [
  ...Array.from({ length: 8 }, (_, i) => [`part${i + 1}`, 'core.text', false, false]), ['prefixes', 'structured-data.value', false, false], ['separator', 'core.text', false, false],
]);
assert.deepEqual(declared.outputs.map(port => [port.id, port.type.id]), [['text', 'core.text']]);
assert.equal(s2BuiltinPluginInstallation().descriptor(capability).kind, 'local');
assert.equal(registry.catalog().length, 11); assert.equal(s2ComposableCapabilities().length, 24);
const invocation: S2PluginInvocation = { protocolVersion: 1, id: 'SyntheticComposeCall', sceneId: 'SyntheticComposeScene', runId: 'SyntheticComposeRun', revision: 1,
  nodeId: 'compose', ...capability, idempotencyKey: 'SyntheticComposeKey', inputs: {} };
const complete = await executeS2TextTemplate(invocation, { part1: ['{{notAPlaceholder}}'], part8: [''], prefixes: [['第一：']], separator: ['|'] });
assert.equal(complete.status, 'succeeded'); assert.deepEqual(Object.keys(complete.outputs), ['text']);
assert.equal(((complete.outputs as Record<string, S2Artifact[]>).text[0].payload as any).value, '第一：{{notAPlaceholder}}|');
for (const invalid of [{}, { part1: [null] }, { part1: ['a', 'b'] }, { part1: ['a'], part9: ['不能静默丢弃'] }, { part1: ['a'], prefixes: [null] },
  { part1: ['a'], separator: [false] }, { part1: ['x'.repeat(6000)], part2: ['y'] }]) {
  const result = await executeS2TextTemplate(invocation, invalid as any);
  assert.equal(result.status, 'failed'); assert.deepEqual(result.outputs, {}, 'Invalid or oversized composition never emits partial text');
}
const scene = createS2Scene({ source: 'custom', sceneSkill: 'S2', subject: '合成单节点组装', knowledgePoints: [] });
const display = { pluginId: 'structured-view', pluginVersion: '1.0.0', capabilityId: 'text' };
const literal = (value: any) => ({ kind: 'literal' as const, value });
const field = (nodeId: string) => ({ kind: 'field' as const, nodeId, fieldId: 'content' });
const definition = readS2Definition({ ...scene.canvasWorkspace, plugins: [capability, display], initial: { nodes: [
  { id: 'first', type: 'text', label: '任意名称', position: { x: 0, y: 0 }, values: { content: '原文甲 {{literal}}' } },
  { id: 'second', type: 'text', position: { x: 0, y: 120 }, values: { content: '原文乙 $&' } },
], edges: [], execution: { version: 1, nodes: [
  { id: 'compose', ...capability, position: { x: 300, y: 0 }, bindings: { part1: field('first'), part3: field('second'), prefixes: literal(['角色：', '', '任务：']), separator: literal('\n') } },
  { id: 'display', ...display, position: { x: 600, y: 0 }, bindings: {} },
], links: [{ source: { nodeId: 'compose', portId: 'text' }, target: { nodeId: 'display', portId: 'text' } }] } } });
const host = new S2PluginHost(scene.sceneId, definition); host.setDocument(definition.initial);
try {
  const first = await host.enqueueWorkflow(['display']).completion;
  assert.equal(first.status, 'succeeded'); assert.equal(host.history().length, 1, 'One actual transform, not four hidden bind/render invocations');
  const artifactId = first.nodes.find(node => node.nodeId === 'compose')!.artifactIds[0];
  assert.equal((host.currentArtifact(artifactId).payload as any).value, '角色：原文甲 {{literal}}\n任务：原文乙 $&');
  assert.equal(first.nodes.find(node => node.nodeId === 'display')!.status, 'displayed');
  const budget = host.remainingCalls, again = await host.enqueueWorkflow(['display']).completion;
  assert.equal(again.nodes.find(node => node.nodeId === 'compose')!.status, 'cached'); assert.equal(host.remainingCalls, budget);
  const rewired = applyS2Commands(definition, definition.initial, [{ op: 'update-execution-node', id: 'compose', bindings: {
    part1: field('second'), part3: field('first'), prefixes: literal(['角色：', '', '任务：']), separator: literal('\n'),
  } }]); host.setDocument(rewired);
  const swapped = await host.enqueueWorkflow(['display']).completion;
  assert.equal((host.currentArtifact(swapped.nodes.find(node => node.nodeId === 'compose')!.artifactIds[0]).payload as any).value, '角色：原文乙 $&\n任务：原文甲 {{literal}}');
  const missing = structuredClone(rewired); missing.execution!.nodes[0].bindings = {}; host.setDocument(missing);
  const failed = await host.enqueueWorkflow(['display']).completion;
  assert.equal(failed.status, 'failed'); assert.equal(failed.nodes.find(node => node.nodeId === 'compose')!.status, 'failed');
  assert.equal(failed.nodes.find(node => node.nodeId === 'compose')!.artifactIds.length, 0); assert.equal(failed.nodes.find(node => node.nodeId === 'display')!.status, 'blocked');
  console.log('S2 single-node compose passed: exact eight-slot local concatenation, optional bounded slot prefixes/separator, empty-vs-absent and native raw text, 6000-character atomic limit, fixed pure installed contract, one real host transform with typed text display, unchanged cache and explicit source rewiring, and missing-input failure blocks downstream. Synthetic local only; no models/network/material.');
} finally { host.close(); }
