import assert from 'node:assert/strict';
import type { S2Document, S2WorkflowNode } from '../src/types/sceneS2';
import { applyS2Commands, createS2Scene, readS2Definition, readS2Document, exportS2Workspace, importS2Workspace, exportS2Subgraph, importS2Subgraph } from '../src/services/scene/sceneS2Canvas';
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { s2ComposableCapabilities } from '../src/services/scene/sceneS2PluginRegistry';
import { s2AllNodes } from '../src/services/scene/sceneS2Layout';
import { selectS2Execution } from '../src/services/scene/sceneS2Workflow';

globalThis.fetch = async () => assert.fail('Advanced S2 checks must not access notes/models/network');
const scene = createS2Scene({ source: 'custom', subject: 'Synthetic cache/group test', knowledgePoints: [], sceneSkill: 'S2' });
// Pin this legacy fixture's original capabilities; the growing installation catalogue is not its authorization list.
const plugins = s2ComposableCapabilities().filter(({ pluginId, capabilityId }) => ['json-check', 'structured-data', 'structured-view', 'workflow-simulation', 'workflow-merge', 'human-input'].includes(pluginId) && !(pluginId === 'structured-view' && capabilityId === 'text')).map(({ pluginId, pluginVersion, capabilityId }) => ({ pluginId, pluginVersion, capabilityId }));
const node = (id: string, capabilityId: string, bindings: S2WorkflowNode['bindings'] = {}, pluginId = 'structured-data'): S2WorkflowNode => ({ id, pluginId, pluginVersion: '1.0.0', capabilityId, bindings, position: { x: 300, y: 100 } });
const raw = { items: [{ name: 'A', score: 1 }, { name: 'B' }], other: [{ name: 'C' }] };
const initial: S2Document = { nodes: [{ id: 'source', type: 'text', position: { x: 0, y: 0 }, values: { content: JSON.stringify(raw) } },
  { id: 'spare', type: 'text', position: { x: 0, y: 300 }, values: { content: 'unrelated' } }], edges: [], execution: { version: 1, nodes: [
    node('parse', 'parse-json', { text: { kind: 'field', nodeId: 'source', fieldId: 'content' } }),
    node('select', 'select', { pointer: { kind: 'literal', value: '/items' } }), node('table', 'to-table'), node('view', 'table', {}, 'structured-view'),
  ], links: [{ source: { nodeId: 'parse', portId: 'value' }, target: { nodeId: 'select', portId: 'value' } },
    { source: { nodeId: 'select', portId: 'value' }, target: { nodeId: 'table', portId: 'value' } }, { source: { nodeId: 'table', portId: 'table' }, target: { nodeId: 'view', portId: 'table' } }] } };
const definition = readS2Definition({ ...scene.canvasWorkspace!, plugins, initial });
const strategy = { goal: definition.goal, ...definition.instructions };
const host = new S2PluginHost(scene.sceneId, plugins); host.setDocument(initial);
const first = await host.enqueueWorkflow(['view']).completion;
assert.equal(first.status, 'succeeded'); assert.equal(host.remainingCalls, 61); assert.equal(host.history().length, 3);
const second = await host.enqueueWorkflow(['view']).completion;
assert.deepEqual(second.nodes.map(node => node.status), ['cached', 'cached', 'cached', 'displayed']);
assert.equal(host.remainingCalls, 61); assert.equal(host.history().length, 3, 'Reuse does not invent a new execution receipt');
const context = host.prepare('view', strategy, 'Explain');
assert.equal(context.cacheReuses.length, 3); assert.equal(context.cacheReuses[0].kind, 'cache-reuse');
assert.ok(context.cacheReuses.every(reuse => host.history().some(entry => entry.receipt.invocationId === reuse.sourceInvocationId)));
assert.ok(context.cacheReuses.flatMap(reuse => reuse.artifacts).every(artifact => context.frame.availableArtifactIds.includes(artifact.id)));
assert.equal(host.currentArtifact(second.nodes[0].artifactIds[0]).source.kind, 'host');
assert.notEqual(second.nodes[0].artifactIds[0], first.nodes[0].artifactIds[0]);

const unrelated = structuredClone(initial); unrelated.nodes[1].values.content = 'edited but not consumed'; host.setDocument(unrelated);
const afterUnrelated = await host.enqueueWorkflow(['view']).completion;
assert.equal(afterUnrelated.nodes[0].status, 'cached'); assert.equal(host.remainingCalls, 61);
assert.equal(host.history()[0].receipt.publication, 'stale', 'Old receipt is not relabeled current; derived artifact has fresh provenance');
assert.equal(host.currentArtifact(afterUnrelated.nodes[0].artifactIds[0]).source.revision, afterUnrelated.revision);

const whitespace = structuredClone(unrelated); whitespace.nodes[0].values.content = `  ${whitespace.nodes[0].values.content}`; host.setDocument(whitespace);
const incremental = await host.enqueueWorkflow(['view']).completion;
assert.deepEqual(incremental.nodes.map(node => node.status), ['succeeded', 'cached', 'cached', 'displayed']); assert.equal(host.remainingCalls, 60);
const pointer = applyS2Commands(definition, whitespace, [{ op: 'update-execution-node', id: 'select', bindings: { pointer: { kind: 'literal', value: '/other' } } }]); host.setDocument(pointer);
const parameterChange = await host.enqueueWorkflow(['view']).completion;
assert.deepEqual(parameterChange.nodes.map(node => node.status), ['cached', 'succeeded', 'succeeded', 'displayed']); assert.equal(host.remainingCalls, 58);
const forced = await host.enqueueWorkflow(['view'], undefined, { force: true }).completion;
assert.deepEqual(forced.nodes.map(node => node.status), ['succeeded', 'succeeded', 'succeeded', 'displayed']); assert.equal(host.remainingCalls, 55);
const beforeClear = host.history().length; host.clearCache(); assert.equal(host.history().length, beforeClear); assert.equal(host.remainingCalls, 55);
assert.equal((await host.enqueueWorkflow(['view']).completion).nodes[0].status, 'succeeded'); assert.equal(host.remainingCalls, 52);
const invalid = structuredClone(pointer); invalid.nodes[0].values.content = '{bad'; host.setDocument(invalid);
assert.equal((await host.enqueueWorkflow(['view']).completion).nodes[0].status, 'failed');
assert.equal((await host.enqueueWorkflow(['view']).completion).nodes[0].status, 'failed'); assert.equal(host.remainingCalls, 50, 'Failures are never cached');

const quota = new S2PluginHost('scene-quota', plugins); quota.setDocument(initial); await quota.enqueueWorkflow(['parse']).completion;
const input = quota.prepare('parse', strategy, 'Synthetic repeated direct calls').bindings[0].artifactId;
for (let i = 0; i < 63; i++) await quota.execute({ nodeId: 'source', pluginId: 'structured-data', pluginVersion: '1.0.0', capabilityId: 'parse-json', inputs: { text: [input] }, reason: 'Synthetic quota test' },
  { ...quota.prepare('parse', strategy, 'Direct').frame, availableArtifactIds: [input] }, `quota-${i}`);
assert.equal(quota.remainingCalls, 0);
assert.equal((await quota.enqueueWorkflow(['parse']).completion).nodes[0].status, 'cached', 'Verified pure reuse works with zero execution budget');
assert.equal((await quota.enqueueWorkflow(['parse'], undefined, { force: true }).completion).status, 'failed');
const fresh = new S2PluginHost('scene-fresh', plugins); fresh.setDocument(initial);
assert.equal((await fresh.enqueueWorkflow(['parse']).completion).nodes[0].status, 'succeeded', 'A new run never imports executable cache authority');

const grouped = applyS2Commands(definition, initial, [{ op: 'set-group', group: { id: 'group-a', label: 'Transform', nodeIds: ['source', 'parse', 'select'], collapsed: false } }]);
assert.equal(grouped.groups?.length, 1);
const collapse = applyS2Commands(definition, grouped, [{ op: 'set-group', group: { ...grouped.groups![0], collapsed: true } }]);
assert.deepEqual(collapse.execution, grouped.execution);
assert.deepEqual(importS2Workspace(exportS2Workspace(definition, collapse)).initial.groups, collapse.groups);
assert.throws(() => applyS2Commands(definition, grouped, [{ op: 'set-group', group: { id: 'group-b', label: 'Overlap', nodeIds: ['parse'], collapsed: false } }]), /重复|其他组/);
assert.throws(() => applyS2Commands(definition, initial, [{ op: 'set-group', group: { id: 'parse', label: 'ID collision', nodeIds: ['source'], collapsed: false } }]), /无效/);
assert.throws(() => applyS2Commands(definition, initial, [{ op: 'set-group', group: { id: 'empty', label: 'Empty', nodeIds: [], collapsed: false } }]), /无效/);
const moved = applyS2Commands(definition, grouped, [{ op: 'batch-nodes', action: { kind: 'move', nodeIds: ['source', 'parse'], delta: { x: 50, y: 25 } } }]);
assert.equal(moved.nodes[0].position.x, 50); assert.equal(moved.execution!.nodes[0].position.x, 350);
const beforeRevision = fresh.workflowHistory()[0].revision; fresh.setDocument(moved); assert.equal(fresh.workflowHistory()[0].publication, 'current');
assert.equal((await fresh.enqueueWorkflow(['parse']).completion).revision, beforeRevision, 'Layout/group edits do not invalidate data');
const copied = applyS2Commands(definition, grouped, [{ op: 'batch-nodes', action: { kind: 'copy', nodeIds: ['source', 'parse', 'select'] } }]);
const originalIds = new Set(s2AllNodes(grouped).map(node => node.id)), cloned = s2AllNodes(copied).filter(node => !originalIds.has(node.id));
assert.equal(cloned.length, 3); assert.equal(copied.groups?.length, 2);
const clonedParse = copied.execution!.nodes.find(node => !originalIds.has(node.id) && node.capabilityId === 'parse-json')!;
const clonedSource = copied.nodes.find(node => !originalIds.has(node.id))!;
assert.equal((clonedParse.bindings.text as any).nodeId, clonedSource.id);
assert.equal(copied.execution!.links.length, grouped.execution!.links.length + 1, 'Only selected internal execution links are copied');
const onlyExecution = applyS2Commands(definition, grouped, [{ op: 'batch-nodes', action: { kind: 'copy', nodeIds: ['parse', 'select'] } }]);
assert.equal((onlyExecution.execution!.nodes.find(node => !originalIds.has(node.id) && node.capabilityId === 'parse-json')!.bindings.text as any).nodeId, 'source', 'Unselected field references remain explicit');
const removed = applyS2Commands(definition, copied, [{ op: 'batch-nodes', action: { kind: 'delete', nodeIds: ['source', 'parse', 'select'] } }]);
assert.equal(removed.groups!.length, 1); assert.equal(removed.execution!.links.length, 2);
assert.throws(() => applyS2Commands(definition, initial, [{ op: 'batch-nodes', action: { kind: 'copy', nodeIds: ['missing'] } }]), /不存在/);
assert.throws(() => applyS2Commands(definition, initial, [{ op: 'batch-nodes', action: { kind: 'move', nodeIds: ['source'], delta: { x: Infinity, y: 0 } } }]), /无效/);
const undoSnapshot = JSON.stringify(initial);
assert.throws(() => applyS2Commands(definition, initial, [{ op: 'batch-nodes', action: { kind: 'copy', nodeIds: ['source'] } }, { op: 'set-group', group: { id: 'invalid', label: 'Bad', nodeIds: ['missing'], collapsed: false } }]));
assert.equal(JSON.stringify(initial), undoSnapshot, 'Invalid mixed batch is atomic');

const packaged = exportS2Subgraph(definition, grouped, ['select', 'table', 'view']), envelope = JSON.parse(packaged);
assert.equal(envelope.ports.inputs.length, 1); assert.equal(envelope.ports.inputs[0].nodeId, 'select'); assert.equal(envelope.ports.inputs[0].type.id, 'structured-data.value');
const pasted = importS2Subgraph(packaged, definition, initial);
assert.equal(pasted.nodeIds.length, 3); assert.ok(pasted.nodeIds.every(id => !originalIds.has(id)));
const pastedView = pasted.document.execution!.nodes.find(node => pasted.nodeIds.includes(node.id) && node.pluginId === 'structured-view')!;
assert.throws(() => selectS2Execution(pasted.document, plugins, [pastedView.id]), /必填/);
const pastedSelect = pasted.document.execution!.nodes.find(node => pasted.nodeIds.includes(node.id) && node.capabilityId === 'select')!;
const connected = applyS2Commands(definition, pasted.document, [{ op: 'connect-ports', link: { source: { nodeId: 'parse', portId: 'value' }, target: { nodeId: pastedSelect.id, portId: 'value' } } }]);
assert.equal(selectS2Execution(connected, plugins, [pastedView.id]).graph.nodes.length, 4);
const fieldPackage = exportS2Subgraph(definition, grouped, ['parse']);
assert.equal(JSON.parse(fieldPackage).definition.initial.nodes.length, 1, 'Referenced content travels with the fragment');
assert.equal(importS2Subgraph(fieldPackage, definition, initial).nodeIds.length, 2);
envelope.ports.inputs[0].type.id = 'core.text'; assert.throws(() => importS2Subgraph(JSON.stringify(envelope), definition, initial), /端口清单/);
const limited = readS2Definition({ ...definition, plugins: [], initial: { nodes: initial.nodes, edges: [] } });
assert.throws(() => importS2Subgraph(packaged, limited, limited.initial), /扩大授权/);
assert.throws(() => importS2Subgraph(JSON.stringify({ ...JSON.parse(packaged), receipts: [{ status: 'succeeded' }] }), definition, initial), /未支持/);
assert.equal(definition.goal, scene.canvasWorkspace!.goal, 'Pasting never replaces the current scene strategy');
host.close(); fresh.close(); quota.close();
console.log('S2 advanced passed: verified pure per-node cache and zero-budget reuse, separate reuse provenance, content/parameter invalidation, force/clear/failure rules, atomic multi-node copy/delete/move and ID/edge remapping, non-executing groups/collapse, scoped portable subgraphs with typed boundaries and no imported authority. Synthetic data; no real notes/model calls.');
