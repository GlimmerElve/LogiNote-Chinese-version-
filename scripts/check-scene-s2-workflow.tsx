// Fixed synthetic replies below intentionally test complete-catalogue compatibility, not progressive discovery.
import assert from 'node:assert/strict';
import { s2DesignFixtureResponse, s2TurnFixtureAdapter } from './fixtures/s2-design-model';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { S2CanvasDefinition, S2Document, S2WorkflowNode } from '../src/types/sceneS2';
import type { S2Artifact, S2ExecutionLink, S2Json } from '../src/types/sceneS2Plugin';
import { applyS2Commands, createS2Scene, exportS2Workspace, importS2Workspace, readS2Definition, readS2Document, interactS2Canvas as rawInteractS2Canvas, designS2Canvas } from '../src/services/scene/sceneS2Canvas';
const interactS2Canvas = s2TurnFixtureAdapter(rawInteractS2Canvas);
import { S2PluginHost, executeS2JsonCheck, type S2LocalAdapter } from '../src/services/scene/sceneS2PluginHost';
import { s2CapabilityKey, s2ComposableCapabilities, s2BuiltinPluginRegistry, readS2PluginBindings } from '../src/services/scene/sceneS2PluginRegistry';
import { executeS2Structured, selectS2Pointer, recordsToS2Table, s2TableToRecords } from '../src/services/scene/sceneS2Structured';
import { readS2Artifact, canonicalS2Json } from '../src/services/scene/sceneS2PluginProtocol';
import { readS2Workflow, selectS2Execution } from '../src/services/scene/sceneS2Workflow';
import { S2ArtifactView } from '../src/components/scene/S2ArtifactView';

globalThis.fetch = async () => assert.fail('S2 workflow tests must not access notes, network or models');
const scene = createS2Scene({ source: 'custom', subject: 'Synthetic data exploration', knowledgePoints: [], sceneSkill: 'S2' });
// Pin this legacy fixture's original capabilities; the growing installation catalogue is not its authorization list.
const plugins = s2ComposableCapabilities().filter(({ pluginId, capabilityId }) => ['json-check', 'structured-data', 'structured-view', 'workflow-simulation', 'workflow-merge', 'human-input'].includes(pluginId)
  && !(pluginId === 'structured-view' && capabilityId === 'text')).map(({ pluginId, pluginVersion, capabilityId }) => ({ pluginId, pluginVersion, capabilityId }));
const node = (id: string, capabilityId: string, bindings: S2WorkflowNode['bindings'] = {}, pluginId = 'structured-data'): S2WorkflowNode => ({ id, capabilityId, pluginId, pluginVersion: '1.0.0', bindings, position: { x: 100, y: 100 } });
const link = (source: string, output: string, target: string, input: string): S2ExecutionLink => ({ source: { nodeId: source, portId: output }, target: { nodeId: target, portId: input } });
const records = [{ name: '甲', score: 3 }, { name: '乙', score: null }, { name: '丙' }];
const raw = { items: records, 'x/y': { '~key': true } };
const initial: S2Document = { nodes: [{ id: 'source', type: 'text', position: { x: 0, y: 0 }, values: { content: JSON.stringify(raw) } }], edges: [], execution: { version: 1, nodes: [
  node('parse', 'parse-json', { text: { kind: 'field', nodeId: 'source', fieldId: 'content' } }),
  node('select', 'select', { pointer: { kind: 'literal', value: '/items' } }),
  node('table', 'to-table'), node('view', 'table', {}, 'structured-view'),
], links: [link('parse', 'value', 'select', 'value'), link('select', 'value', 'table', 'value'), link('table', 'table', 'view', 'table')] } };
const definition: S2CanvasDefinition = readS2Definition({ ...scene.canvasWorkspace!, plugins, initial });
assert.equal(plugins.length, 16); assert.equal(new Set(plugins.map(s2CapabilityKey)).size, 16);
assert.deepEqual(importS2Workspace(exportS2Workspace(definition, initial)), definition);
assert.throws(() => importS2Workspace(JSON.stringify({ format: 's2-workspace', version: 1, definition, grant: { remainingCalls: 1000 } })), /未支持/);
assert.throws(() => readS2PluginBindings([plugins[0], plugins[0]]), /重复/);
assert.throws(() => readS2Definition({ ...definition, plugins: [] }), /未装配/);
const partial = applyS2Commands(definition, initial, [{ op: 'add-execution-node', node: node('unbound', 'parse-json') }]);
assert.equal(partial.execution?.nodes.length, 5, 'Incomplete graph editing is allowed');
assert.throws(() => selectS2Execution(partial, plugins, ['unbound']), /必填/);
assert.throws(() => applyS2Commands(definition, initial, [{ op: 'connect-ports', link: link('parse', 'value', 'select', 'pointer') }]), /类型/);
assert.throws(() => applyS2Commands(definition, initial, [{ op: 'connect-ports', link: link('parse', 'value', 'table', 'value') }]), /单值/);
assert.throws(() => readS2Workflow({ version: 1, nodes: [node('a', 'parse-json'), node('b', 'stringify')], links: [link('a', 'value', 'b', 'value'), link('b', 'text', 'a', 'text')] }, initial, plugins), /循环/);
assert.throws(() => applyS2Commands(definition, initial, [{ op: 'add-execution-node', node: node('source', 'parse-json') }]), /重名/);
const deleted = applyS2Commands(definition, initial, [{ op: 'remove-node', id: 'source' }]);
assert.deepEqual(deleted.execution?.nodes[0].bindings, {}, 'Deleted field sources become explicitly unbound, never stale references');
const disconnected = applyS2Commands(definition, initial, [{ op: 'remove-execution-node', id: 'select' }]);
assert.equal(disconnected.execution?.links.length, 1);
const before = JSON.stringify(initial);
assert.throws(() => applyS2Commands(definition, initial, [{ op: 'update-node', id: 'source', values: { content: 'should rollback' } }, { op: 'connect-ports', link: link('missing', 'value', 'select', 'value') }]));
assert.equal(JSON.stringify(initial), before);

const host = new S2PluginHost(scene.sceneId, plugins); host.setDocument(initial);
const first = await host.enqueueWorkflow(['view']).completion;
assert.equal(first.status, 'succeeded'); assert.deepEqual(first.nodes.map(item => item.status), ['succeeded', 'succeeded', 'succeeded', 'displayed']);
assert.equal(host.remainingCalls, 61, 'Renderer display never masquerades as a tool invocation or consumes a call');
const tableArtifact = host.currentArtifact(first.nodes[3].artifactIds[0]);
assert.equal(tableArtifact.type.id, 'structured-data.table');
assert.deepEqual(s2TableToRecords((tableArtifact.payload as any).value), records, 'Types, null and missing values survive a round trip');
const markup = renderToStaticMarkup(<S2ArtifactView artifact={tableArtifact} />);
assert.ok(markup.includes('<table')); assert.ok(markup.includes('缺失')); assert.ok(markup.includes('甲'));
const parsed = host.currentArtifact(first.nodes[0].artifactIds[0]);
assert.ok(renderToStaticMarkup(<S2ArtifactView artifact={parsed} />).includes('<details open=""'));
const moved = structuredClone(initial); moved.nodes[0].position.x += 100; moved.execution!.nodes[0].position.y += 100;
host.setDocument(moved);
assert.equal(host.history()[0].receipt.publication, 'current', 'Moving nodes does not invalidate unchanged data or trigger execution');
const subset = await host.enqueueWorkflow(['parse']).completion;
assert.deepEqual(subset.nodes.map(item => item.nodeId), ['parse']); assert.equal(subset.nodes[0].status, 'cached'); assert.equal(host.remainingCalls, 61);
const context = host.prepare('parse', { goal: definition.goal, ...definition.instructions }, 'Explain');
assert.ok(context.artifactCatalog.some(artifact => artifact.type.id === 'structured-data.value'));
assert.equal(context.executionRuns.length, 2);
const roundtripDoc = structuredClone(initial);
roundtripDoc.execution!.nodes.push(node('reverse', 'table-to-json'), node('text', 'stringify'), node('jsonView', 'json-tree', {}, 'structured-view'), node('check', 'validate', {}, 'json-check'));
roundtripDoc.execution!.links.push(link('table', 'table', 'reverse', 'table'), link('reverse', 'value', 'text', 'value'), link('reverse', 'value', 'jsonView', 'value'), link('text', 'text', 'check', 'text'));
const roundtripHost = new S2PluginHost('scene-roundtrip', plugins); roundtripHost.setDocument(roundtripDoc);
const roundtripRun = await roundtripHost.enqueueWorkflow(['jsonView', 'check']).completion;
assert.equal(roundtripRun.status, 'succeeded'); assert.equal(roundtripRun.nodes.some(node => node.nodeId === 'view'), false, 'Unrequested display branch is not mandatory');
const outputAt = (id: string) => roundtripHost.currentArtifact(roundtripRun.nodes.find(node => node.nodeId === id)!.artifactIds[0]).payload as { kind: 'inline'; value: S2Json };
assert.deepEqual(outputAt('reverse').value, records);
assert.deepEqual(JSON.parse(outputAt('text').value as string), records);
assert.equal((outputAt('check').value as any).status, 'pass'); assert.equal(roundtripRun.nodes.find(node => node.nodeId === 'jsonView')?.status, 'displayed');
assert.equal(roundtripHost.remainingCalls, 58, 'All five transforms plus a checker execute once; display does not');
const tooLong: S2Document = { ...initial, execution: { version: 1, nodes: [node('oversize', 'stringify', { value: { kind: 'literal', value: '长'.repeat(6001) } })], links: [] } };
const boundedHost = new S2PluginHost('scene-bounds', plugins); boundedHost.setDocument(tooLong);
const bounded = await boundedHost.enqueueWorkflow(['oversize']).completion;
assert.equal(bounded.status, 'failed'); assert.equal(boundedHost.history()[0].receipt.error?.code, 'TRANSFORM_REJECTED'); assert.equal(boundedHost.history()[0].artifacts.length, 0);
assert.equal(boundedHost.remainingCalls, 63, 'Oversize conversion fails without a truncated downstream artifact');

const strategy = { goal: definition.goal, ...definition.instructions };
const isolatedDoc = structuredClone(initial);
isolatedDoc.execution!.nodes.push(node('independent', 'validate', { text: { kind: 'literal', value: '{}' } }, 'json-check'));
isolatedDoc.nodes[0].values.content = '{bad}';
const branches = new S2PluginHost('scene-branches', plugins); branches.setDocument(isolatedDoc);
const failed = await branches.enqueueWorkflow().completion;
assert.equal(failed.status, 'failed'); assert.equal(failed.nodes.find(item => item.nodeId === 'parse')?.status, 'failed');
assert.equal(failed.nodes.find(item => item.nodeId === 'view')?.status, 'blocked');
assert.equal(failed.nodes.find(item => item.nodeId === 'independent')?.status, 'succeeded', 'An independent branch survives another branch failure');
assert.equal(branches.remainingCalls, 62);

let release!: () => void, entered!: () => void;
const started = new Promise<void>(resolve => { entered = resolve; });
const delayed: S2LocalAdapter = async (call, inputs, signal) => { entered(); await new Promise<void>(resolve => { release = resolve; }); return call.pluginId === 'structured-data' ? executeS2Structured(call, inputs) : executeS2JsonCheck(call, inputs, signal); };
const queueHost = new S2PluginHost('scene-queue', plugins, delayed); queueHost.setDocument(initial);
const running = queueHost.enqueueWorkflow(['parse']); await started;
const queued = queueHost.enqueueWorkflow(['parse']); assert.equal(queueHost.workflowHistory()[1].status, 'queued');
queueHost.cancelWorkflow(queued.id); queueHost.cancelWorkflow(running.id);
const [cancelledRun, cancelledQueued] = await Promise.all([running.completion, queued.completion]);
assert.equal(cancelledRun.status, 'cancelled'); assert.equal(cancelledQueued.status, 'cancelled'); assert.equal(queueHost.remainingCalls, 63); release();
const oldInput = new S2PluginHost('scene-stale', plugins); oldInput.setDocument(initial);
const pending = oldInput.enqueueWorkflow(['view']);
const changed = structuredClone(initial); changed.nodes[0].values.content = '{}'; oldInput.setDocument(changed);
assert.equal((await pending.completion).status, 'cancelled'); assert.equal(oldInput.remainingCalls, 64, 'A stale queued job never runs against replacement data');

assert.equal(selectS2Pointer(raw, '/x~1y/~0key'), true);
assert.throws(() => selectS2Pointer(raw, '/missing'), /不存在/);
assert.throws(() => selectS2Pointer([1, 2], '/01'), /不存在/);
assert.throws(() => selectS2Pointer(raw, '/x~2y'), /Pointer/);
assert.deepEqual(s2TableToRecords(recordsToS2Table(records)), records);
assert.throws(() => recordsToS2Table([{ x: { y: 1 } }]), /嵌套/);
assert.throws(() => recordsToS2Table([1, 2]), /记录数组/);
const malformedTable = structuredClone((tableArtifact.payload as any).value); malformedTable.rows[0] = [];
assert.throws(() => s2TableToRecords(malformedTable), /契约/);
const registry = s2BuiltinPluginRegistry();
for (const value of [Infinity, JSON.parse('{"__proto__":1}'), { x: Array.from({ length: 2048 }, () => 1) }]) {
  assert.throws(() => readS2Artifact(registry, { ...parsed, payload: { kind: 'inline', value } }));
}
const longTree = { ...parsed, payload: { kind: 'inline' as const, value: Array.from({ length: 300 }, (_, i) => i) } };
const treeMarkup = renderToStaticMarkup(<S2ArtifactView artifact={longTree} />); assert.ok(treeMarkup.includes('200项'));
assert.equal((longTree.payload.value).length, 300, 'Preview limits do not truncate executor data');
const malicious = { ...parsed, payload: { kind: 'inline' as const, value: { note: '<script>alert(1)</script>' } } };
const safe = renderToStaticMarkup(<S2ArtifactView artifact={malicious} />); assert.ok(!safe.includes('<script>')); assert.ok(safe.includes('&lt;script&gt;'));

const scriptedScene = { ...scene, canvasWorkspace: definition }, callContext = host.prepare('view', strategy, 'Show only the table');
const response = (raw: unknown) => ({ content: JSON.stringify(raw) } as any);
const executionReply = { understanding: 'Only show this table', plan: 'Request its dependencies only', reply: 'Confirm the selected branch', commands: [], pluginRequests: [], executionRequest: { targetNodeIds: ['view'], reason: 'Requested table display' } };
assert.deepEqual(await interactS2Canvas(scriptedScene, initial, 'Show only the table', 'view', [], { pluginContext: callContext, invoke: async request => {
  assert.ok(request.systemPromptOverride?.includes('不强制运行整图')); return response(executionReply);
} }), executionReply);
assert.equal((await interactS2Canvas(scriptedScene, initial, '先解释，不运行任何插件', null, [], { pluginContext: callContext, invoke: async () => response({ understanding: 'Explain only', plan: 'No execution', reply: 'Explanation', commands: [], pluginRequests: [] }) })).executionRequest, undefined);
await assert.rejects(() => interactS2Canvas(scriptedScene, initial, 'Bad execution', 'view', [], { pluginContext: callContext, invoke: async () => response({ ...executionReply, executionRequest: { targetNodeIds: ['missing'], reason: 'fake' } }) }), /不存在/);
await assert.rejects(() => interactS2Canvas(scriptedScene, initial, 'Expand permission', 'view', [], { pluginContext: { ...callContext, approvedCapabilities: [] }, invoke: async () => response(executionReply) }), /未装配/);
const built = await designS2Canvas(scene, { disclosure: 'complete', invoke: async request => { if (JSON.parse(request.userInput).stage === 'assemble') { assert.ok(request.systemPromptOverride?.includes('只用目录精确版本与真实端口')); assert.ok(request.systemPromptOverride?.includes('数据与条件依赖合并后须无环')); } return s2DesignFixtureResponse(request, definition); } });
assert.deepEqual(built.initial.execution, definition.initial.execution);
host.close(); branches.close(); queueHost.close(); oldInput.close(); roundtripHost.close(); boundedHost.close();
console.log('S2 structured workflow passed: native bounded JSON, explicit parse/select/text/table conversions, lossless missing/null, typed DAG editing and target-only scheduling, independent failure branches, queue/cancel/stale/layout safety, template import/export without authority, actual escaped tree/table SSR and synthetic goal-led builder/interaction requests. No live model, notes, paid tools or S4 engine access.');
