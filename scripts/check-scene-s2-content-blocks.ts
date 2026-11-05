import assert from 'node:assert/strict';
import type { S2WorkflowNode } from '../src/types/sceneS2';
import { applyS2Commands, createS2Scene, exportS2Subgraph, exportS2Workspace, importS2Subgraph, importS2Workspace, readS2Definition, readS2Document } from '../src/services/scene/sceneS2Canvas';
import { s2ConnectionNodeLabel } from '../src/services/scene/sceneS2Connections';
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { S2ModelTestSession } from '../src/services/scene/sceneS2ModelTest';
import { s2SemanticDocument } from '../src/services/scene/sceneS2Workflow';

globalThis.fetch = async () => assert.fail('Content display-name regression forbids real IO');
const scene = createS2Scene({ source: 'custom', sceneSkill: 'S2', subject: '合成通用内容块', knowledgePoints: [] });
const cap = (pluginId: string, capabilityId: string) => ({ pluginId, pluginVersion: '1.0.0', capabilityId });
const bind = cap('text-template', 'bind'), render = cap('text-template', 'render'), model = cap('model-test', 'generate');
const literal = (value: string) => ({ kind: 'literal' as const, value });
const field = (nodeId: string) => ({ kind: 'field' as const, nodeId, fieldId: 'content' });
const node = (id: string, capability: ReturnType<typeof cap>, bindings: S2WorkflowNode['bindings']): S2WorkflowNode => ({ id, ...capability, bindings, position: { x: 0, y: 0 } });
const link = (source: string, portId: string, target: string, input: string) => ({ source: { nodeId: source, portId }, target: { nodeId: target, portId: input } });
const definition = readS2Definition({ ...scene.canvasWorkspace, plugins: [bind, render, model], initial: { nodes: [
  { id: 'first', type: 'text', label: '角色', position: { x: 0, y: 0 }, values: { content: '原文甲 {{literal}}' } },
  { id: 'second', type: 'text', label: '任务', position: { x: 0, y: 120 }, values: { content: '原文乙 $&' } },
], edges: [], execution: { version: 1, nodes: [
  node('bindA', bind, { key: literal('a'), value: field('first') }),
  node('bindB', bind, { key: literal('b'), value: field('second') }),
  node('compose', render, { template: literal('A={{a}}\nB={{b}}') }), node('test', model, {}),
], links: [link('bindA', 'variables', 'bindB', 'variables'), link('bindB', 'variables', 'compose', 'variables'), link('compose', 'text', 'test', 'prompt')] } } });
assert.equal(definition.blockTypes.length, 1, 'All text entrances use the same content type');
let document = definition.initial;
const original = JSON.stringify(document);
assert.equal(s2ConnectionNodeLabel(definition, document, 'first'), '角色（内容 1）');
assert.deepEqual(importS2Workspace(exportS2Workspace(definition, document)).initial, document);
const fragment = importS2Subgraph(exportS2Subgraph(definition, document, ['first']), definition, document);
assert.equal(fragment.document.nodes.find(node => node.id === fragment.nodeIds[0])!.label, '角色');
const copied = applyS2Commands(definition, document, [{ op: 'batch-nodes', action: { kind: 'copy', nodeIds: ['first'] } }]);
assert.equal(copied.nodes.at(-1)!.label, '角色'); assert.equal(copied.nodes.at(-1)!.values.content, document.nodes[0].values.content);
assert.equal(JSON.stringify(document), original);
const named = (label: unknown) => ({ ...document, nodes: document.nodes.map((node, index) => index === 0 ? { ...node, label } : node) });
for (const label of [null, false, 1, {}, 'x'.repeat(81)]) assert.throws(() => readS2Document(named(label), definition), /文本无效/);
assert.equal(readS2Document(named('字'.repeat(80)), definition).nodes[0].label!.length, 80);
assert.throws(() => applyS2Commands(definition, document, [{ op: 'update-node', id: 'first', label: '仅显示' }]), 'Existing values object remains required');
assert.throws(() => applyS2Commands(definition, document, [{ op: 'update-node', id: 'first', values: {}, label: 'x'.repeat(81) }]));
assert.throws(() => applyS2Commands(definition, document, [{ op: 'update-node', id: 'first', values: {}, role: '不能通过名称增加字段' }]));

const host = new S2PluginHost(scene.sceneId, definition); host.setDocument(document);
let sends = 0;
const session = new S2ModelTestSession({ sceneId: scene.sceneId, runId: host.runId, resourceId: 'SyntheticDisplayNameModel', providerId: 'synthetic', providerLabel: '合成传输', model: 'synthetic',
  limits: { maxRequests: 2, maxReservedOutputTokens: 1024, maxOutputTokens: 512 }, invoke: async request => {
    sends++; assert.equal(request.systemPromptOverride, 'A=原文甲 {{literal}}\nB=原文乙 $&');
    return { content: '合成返回原文', diagnostics: { finishReason: 'stop' } };
  } });
host.approveModelTestSession(session);
const strategy = { goal: definition.goal, ...definition.instructions };
const revision = () => host.prepare(null, strategy, '只读检查').frame.revision;
const output = (id: string) => host.currentArtifact(host.workflowHistory().find(run => run.id === id)!.nodes.find(n => n.nodeId === 'compose')!.artifactIds[0]);
try {
  const first = await host.enqueueWorkflow(['compose']).completion;
  assert.equal(first.status, 'succeeded'); assert.equal((output(first.id).payload as any).value, 'A=原文甲 {{literal}}\nB=原文乙 $&');
  const currentRevision = revision(), artifact = output(first.id), calls = host.remainingCalls;
  document = applyS2Commands(definition, document, [{ op: 'update-node', id: 'first', label: '改成任务也仍是原文甲', values: {} }]);
  assert.deepEqual(s2SemanticDocument(document), s2SemanticDocument(definition.initial));
  host.setDocument(document); assert.equal(revision(), currentRevision); assert.deepEqual(host.currentArtifact(artifact.id), artifact);
  const cached = await host.enqueueWorkflow(['compose']).completion;
  assert.ok(cached.nodes.every(n => n.status === 'cached')); assert.equal(host.remainingCalls, calls);

  const pending = host.enqueueWorkflow(['test']);
  for (let i = 0; i < 100 && !host.waitingModelTests().length; i++) await new Promise(resolve => setTimeout(resolve, 0));
  const wait = host.waitingModelTests()[0]; assert.ok(wait); assert.equal(sends, 0);
  document = applyS2Commands(definition, document, [{ op: 'update-node', id: 'second', label: '', values: {} }]);
  assert.equal(s2ConnectionNodeLabel(definition, document, 'second'), '内容块（内容 2）');
  host.setDocument(document); assert.equal(revision(), currentRevision); assert.deepEqual(host.waitingModelTests()[0], wait);
  host.confirmModelTest(pending.id, wait.id, true);
  assert.equal((await pending.completion).status, 'succeeded'); assert.equal(sends, 1);
  const completed = host.workflowHistory().find(run => run.id === pending.id)!;
  document = applyS2Commands(definition, document, [{ op: 'update-node', id: 'first', label: '再改名', values: {} }]); host.setDocument(document);
  assert.equal(revision(), currentRevision); assert.deepEqual(host.workflowHistory().find(run => run.id === pending.id), completed);

  document = applyS2Commands(definition, document, [
    { op: 'update-execution-node', id: 'bindA', bindings: { key: literal('a'), value: field('second') } },
    { op: 'update-execution-node', id: 'bindB', bindings: { key: literal('b'), value: field('first') } },
  ]); host.setDocument(document);
  assert.ok(revision() > currentRevision, 'Changing actual wiring, unlike a name, changes execution input');
  const swapped = await host.enqueueWorkflow(['compose']).completion;
  assert.equal(swapped.status, 'succeeded'); assert.equal((output(swapped.id).payload as any).value, 'A=原文乙 $&\nB=原文甲 {{literal}}');
  assert.equal(sends, 1, 'Source rewiring and local composition do not dispatch a model');
  console.log('S2 content blocks passed: one generic text type, display-only bounded optional names, rename/reset/copy/save/subgraph roundtrip, unchanged completed results/request waits/revisions/pure cache, and actual assembly changes only with explicit source rewiring. Synthetic transport; no real model/network/material.');
} finally { host.close(); session.close(); }
