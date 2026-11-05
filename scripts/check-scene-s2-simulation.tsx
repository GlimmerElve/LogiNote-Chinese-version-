// Fixed synthetic replies below intentionally test complete-catalogue compatibility, not progressive discovery.
import assert from 'node:assert/strict';
import { s2DesignFixtureResponse, s2TurnFixtureAdapter } from './fixtures/s2-design-model';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { S2Document, S2WorkflowNode } from '../src/types/sceneS2';
import type { S2Artifact, S2ExecutionLink, S2Json } from '../src/types/sceneS2Plugin';
import { createS2Scene, readS2Definition, applyS2Commands, designS2Canvas, interactS2Canvas as rawInteractS2Canvas, exportS2Workspace, importS2Workspace } from '../src/services/scene/sceneS2Canvas';
const interactS2Canvas = s2TurnFixtureAdapter(rawInteractS2Canvas);
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { s2ComposableCapabilities, s2BuiltinPluginRegistry } from '../src/services/scene/sceneS2PluginRegistry';
import { readS2Artifact } from '../src/services/scene/sceneS2PluginProtocol';
import { S2ArtifactView } from '../src/components/scene/S2ArtifactView';
import type { S2SimulationResult } from '../src/services/scene/sceneS2Simulation';

globalThis.fetch = async () => assert.fail('Simulation tests must not access services, notes or real models');
const scene = createS2Scene({ source: 'custom', subject: 'Synthetic workflow design', knowledgePoints: [], sceneSkill: 'S2' });
// Pin this legacy fixture's original capabilities; the growing installation catalogue is not its authorization list.
const plugins = s2ComposableCapabilities().filter(({ pluginId, capabilityId }) => ['json-check', 'structured-data', 'structured-view', 'workflow-simulation', 'workflow-merge', 'human-input'].includes(pluginId) && !(pluginId === 'structured-view' && capabilityId === 'text')).map(({ pluginId, pluginVersion, capabilityId }) => ({ pluginId, pluginVersion, capabilityId }));
const literal = (value: S2Json) => ({ kind: 'literal' as const, value });
const step = (id: string, output: S2Json): S2WorkflowNode => ({ id, pluginId: 'workflow-simulation', pluginVersion: '1.0.0', capabilityId: 'step', position: { x: 300, y: 100 },
  bindings: { purpose: literal(id === 'draft' ? '拟写通知' : '模拟发送通知'), assumptions: literal('仅合成数据，假设服务返回以下结果；未真正调用服务'), sample: literal(output) } });
const link = (from: string, out: string, to: string, input: string): S2ExecutionLink => ({ source: { nodeId: from, portId: out }, target: { nodeId: to, portId: input } });
const document: S2Document = { nodes: [], edges: [], execution: { version: 1, nodes: [
  { ...step('draft', { message: '合成通知' }), bindings: { ...step('draft', null).bindings, input: literal({ topic: '测试' }), sample: literal({ message: '合成通知' }) } },
  step('send', { delivered: true, mockReceipt: 'not-a-real-send' }),
  { id: 'view', pluginId: 'workflow-simulation', pluginVersion: '1.0.0', capabilityId: 'inspect', position: { x: 600, y: 100 }, bindings: {} },
], links: [link('draft', 'result', 'send', 'previous'), link('send', 'result', 'view', 'result')] } };
const definition = readS2Definition({ ...scene.canvasWorkspace!, plugins, initial: document });
assert.deepEqual(importS2Workspace(exportS2Workspace(definition, document)), definition);
const host = new S2PluginHost(scene.sceneId, plugins); host.setDocument(document);
const run = await host.enqueueWorkflow(['view']).completion;
assert.equal(run.status, 'succeeded'); assert.equal(host.remainingCalls, 62);
assert.deepEqual(run.nodes.map(node => node.status), ['succeeded', 'succeeded', 'displayed']);
const artifact = host.currentArtifact(run.nodes[1].artifactIds[0]);
assert.equal(artifact.type.id, 'workflow-simulation.result');
const value = (artifact.payload as { kind: 'inline'; value: unknown }).value as S2SimulationResult;
assert.equal(value.mode, 'simulation-only'); assert.equal(value.steps.length, 2);
assert.deepEqual(value.steps[1].input, value.steps[0].output);
assert.deepEqual(value.steps[0].input, { topic: '测试' });
assert.equal((value.steps[1].output as any).delivered, true, 'A sample claiming delivered is still explicitly only a simulation, not a real receipt');
const markup = renderToStaticMarkup(<S2ArtifactView artifact={artifact} presentation="raw" />);
assert.ok(markup.includes('仅模拟 · 非真实业务执行')); assert.ok(markup.includes('预设示例输出')); assert.ok(markup.includes('模拟发送通知'));
const context = host.prepare('send', { goal: definition.goal, ...definition.instructions }, '解释结果');
assert.ok(context.frame.observations.some(item => item.artifacts.some(a => a.meaning.includes('不是真实') || a.meaning.includes('不是事实'))));
const repeat = await host.enqueueWorkflow(['view']).completion;
assert.deepEqual(repeat.nodes.map(node => node.status), ['cached', 'cached', 'displayed']); assert.equal(host.remainingCalls, 62);
assert.ok(host.prepare(null, { goal: definition.goal, ...definition.instructions }, '复用').cacheReuses.every(reuse => reuse.artifacts.every(a => a.type.id === 'workflow-simulation.result')));

const changed = applyS2Commands(definition, document, [{ op: 'update-execution-node', id: 'draft', bindings: { input: literal({ topic: 'different' }) } }]);
host.setDocument(changed); const changedRun = await host.enqueueWorkflow(['view']).completion;
assert.deepEqual(changedRun.nodes.map(node => node.status), ['succeeded', 'succeeded', 'displayed']);
const changedValue = (host.currentArtifact(changedRun.nodes[1].artifactIds[0]).payload as any).value as S2SimulationResult;
assert.deepEqual(changedValue.steps[0].output, value.steps[0].output, 'Mock outputs are not automatically recomputed; this is not an LLM simulator');
assert.deepEqual(changedValue.steps[0].input, { topic: 'different' });
assert.equal(host.history()[0].receipt.publication, 'stale');

// A simulation result cannot be laundered into a real JSON value, checker input or fact.
for (const target of [
  { id: 'real', pluginId: 'structured-data', capabilityId: 'to-table', port: 'value' },
  { id: 'real', pluginId: 'json-check', capabilityId: 'validate', port: 'text' },
]) {
  const invalid = structuredClone(document);
  invalid.execution!.nodes.push({ ...target, pluginVersion: '1.0.0', position: { x: 0, y: 0 }, bindings: {} } as S2WorkflowNode);
  delete (invalid.execution!.nodes.at(-1) as any).port;
  invalid.execution!.links.push(link('send', 'result', 'real', target.port));
  assert.throws(() => readS2Definition({ ...definition, initial: invalid }), /类型/);
}
assert.throws(() => readS2Definition({ ...definition, plugins: plugins.filter(cap => cap.pluginId !== 'workflow-simulation') }), /未装配/);
assert.throws(() => readS2Artifact(s2BuiltinPluginRegistry(), { ...artifact, payload: { kind: 'inline', value: { ...value, mode: 'real-execution' } } }), /枚举|结构|范围/);
const missing = structuredClone(document); delete missing.execution!.nodes[0].bindings.sample;
const missingHost = new S2PluginHost('scene-missing', plugins); missingHost.setDocument(missing);
assert.throws(() => missingHost.enqueueWorkflow(['view']), /必填/); assert.equal(missingHost.remainingCalls, 64);

async function rejection(input: S2Document, message: RegExp) {
  const candidate = new S2PluginHost('scene-reject', plugins); candidate.setDocument(input);
  const result = await candidate.enqueueWorkflow().completion;
  assert.equal(result.status, 'failed'); assert.ok(candidate.history().some(item => message.test(item.receipt.error?.message ?? '')));
  assert.ok(candidate.history().filter(item => item.receipt.status === 'failed').every(item => item.artifacts.length === 0));
  candidate.close(); return result;
}
const empty = structuredClone(document); empty.execution!.nodes[0].bindings.assumptions = literal(' ');
assert.equal((await rejection(empty, /非空/)).nodes.find(node => node.nodeId === 'send')?.status, 'blocked');
const conflict = structuredClone(document); conflict.execution!.nodes[1].bindings.input = literal({ anotherSource: true });
await rejection(conflict, /不能同时/);
const oversize = structuredClone(document); oversize.execution!.nodes[0].bindings.sample = literal('x'.repeat(6001));
await rejection(oversize, /大小|范围|超/);
const prior = { mode: 'simulation-only', steps: Array.from({ length: 16 }, () => ({ purpose: 'prior', assumptions: '假设', input: null, output: null })) };
const tooMany: S2Document = { nodes: [], edges: [], execution: { version: 1, nodes: [{ ...step('overflow', null), bindings: { ...step('overflow', null).bindings, previous: literal(prior) } }], links: [] } };
await rejection(tooMany, /16步/);
const hugePrior = { ...prior, steps: prior.steps.slice(0, 15).map(s => ({ ...s, input: 'a'.repeat(3000), output: 'b'.repeat(3000) })) };
// The original complete previous artifact itself already exceeds the transport cap; fail before any call.
const huge = structuredClone(tooMany); huge.execution!.nodes[0].bindings.previous = literal(hugePrior);
assert.throws(() => readS2Definition({ ...definition, initial: huge }), /64KiB/);
const malicious: S2Artifact = { ...artifact, payload: { kind: 'inline', value: { mode: 'simulation-only', steps: [{ purpose: '<script>x</script>', assumptions: '仅假设', input: null, output: '<img onerror=x>' }] } } };
const safe = renderToStaticMarkup(<S2ArtifactView artifact={malicious} />); assert.ok(!safe.includes('<script>')); assert.ok(safe.includes('&lt;script&gt;'));

const response = (value: unknown) => ({ content: JSON.stringify(value) } as any);
await designS2Canvas(scene, { disclosure: 'complete', invoke: async request => {
  if (JSON.parse(request.userInput).stage === 'assemble') { assert.ok(request.systemPromptOverride?.includes('模拟结果保持独立类型，不能当作真实业务结果')); assert.ok(request.userInput.includes('workflow-simulation')); }
  return s2DesignFixtureResponse(request, definition);
} });
const updatedScene = { ...scene, canvasWorkspace: definition };
const proposed = await interactS2Canvas(updatedScene, document, '请模拟失败后人工处理，不要真的发送', 'send', [], { pluginContext: context, invoke: async request => {
  assert.ok(request.systemPromptOverride?.includes('不得编造这些调度已经发生'));
  return response({ understanding: '模拟失败结果，不实际发送', plan: '仅调整预设示例，等待确认', reply: '建议修改模拟假设', commands: [
    { op: 'update-execution-node', id: 'send', bindings: { sample: literal({ delivered: false, needsHuman: true }) } },
  ] });
} });
assert.equal(proposed.commands.length, 1); assert.deepEqual((document.execution!.nodes[1].bindings.sample as any).value, { delivered: true, mockReceipt: 'not-a-real-send' }, 'Agent proposal is not auto-applied');
host.close(); missingHost.close();
console.log('S2 simulation passed: confirmed mock-data steps and trace, independent semantic types, no real side effects/model calls, cache provenance, input changes, fail-closed limits, missing/conflicting inputs, escaped UI and synthetic builder/interaction proposals. Not a live-model semantic evaluation.');
