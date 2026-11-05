// Fixed synthetic replies below intentionally test complete-catalogue compatibility, not progressive discovery.
import assert from 'node:assert/strict';
import { s2DesignFixtureResponse, s2TurnFixtureAdapter } from './fixtures/s2-design-model';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { S2Document, S2WorkflowCondition, S2WorkflowNode } from '../src/types/sceneS2';
import { applyS2Commands, createS2Scene, readS2Definition, exportS2Subgraph, importS2Subgraph, designS2Canvas, interactS2Canvas as rawInteractS2Canvas } from '../src/services/scene/sceneS2Canvas';
const interactS2Canvas = s2TurnFixtureAdapter(rawInteractS2Canvas);
import { S2PluginHost, type S2WorkflowRun } from '../src/services/scene/sceneS2PluginHost';
import { s2ComposableCapabilities } from '../src/services/scene/sceneS2PluginRegistry';
import { executeS2Structured } from '../src/services/scene/sceneS2Structured';
import { executeS2JsonCheck } from '../src/services/scene/sceneS2PluginHost';
import { S2ArtifactView } from '../src/components/scene/S2ArtifactView';

globalThis.fetch = async () => assert.fail('Merge tests must not call real models, notes or network');
const scene = createS2Scene({ source: 'custom', subject: 'Synthetic exclusive merge', knowledgePoints: [], sceneSkill: 'S2' });
// Pin this legacy fixture's original capabilities; the growing installation catalogue is not its authorization list.
const plugins = s2ComposableCapabilities().filter(({ pluginId, capabilityId }) => ['json-check', 'structured-data', 'structured-view', 'workflow-simulation', 'workflow-merge', 'human-input'].includes(pluginId) && !(pluginId === 'structured-view' && capabilityId === 'text')).map(({ pluginId, pluginVersion, capabilityId }) => ({ pluginId, pluginVersion, capabilityId }));
const literal = (value: any) => ({ kind: 'literal' as const, value });
const when = (match: boolean): S2WorkflowCondition => ({ nodeId: 'check', portId: 'assessment', pointer: '/status', equals: 'pass', match });
const parse = (id: string, text: string, match: boolean): S2WorkflowNode => ({ id, pluginId: 'structured-data', pluginVersion: '1.0.0', capabilityId: 'parse-json', position: { x: 0, y: 0 }, bindings: { text: literal(text) }, when: when(match) });
const merge = (capabilityId = 'merge-json'): S2WorkflowNode => ({ id: 'merge', pluginId: 'workflow-merge', pluginVersion: '1.0.0', capabilityId, position: { x: 500, y: 0 }, bindings: {} });
const link = (source: string, sourcePort: string, target: string, targetPort: string) => ({ source: { nodeId: source, portId: sourcePort }, target: { nodeId: target, portId: targetPort } });
const document: S2Document = { nodes: [], edges: [], execution: { version: 1, nodes: [
  { id: 'check', pluginId: 'json-check', pluginVersion: '1.0.0', capabilityId: 'validate', position: { x: 0, y: 0 }, bindings: { text: literal('{}') } },
  parse('left', '{"same":true}', true), parse('right', '{"same":true}', false), merge(),
  { id: 'view', pluginId: 'structured-view', pluginVersion: '1.0.0', capabilityId: 'json-tree', position: { x: 900, y: 0 }, bindings: {} },
], links: [link('left', 'value', 'merge', 'candidates'), link('right', 'value', 'merge', 'candidates'), link('merge', 'selected', 'view', 'value')] } };
const definition = readS2Definition({ ...scene.canvasWorkspace!, plugins, initial: document });
const instances: S2PluginHost[] = [];
function hostFor(doc: S2Document, name = 'scene-merge') { const host = new S2PluginHost(name, plugins); host.setDocument(doc); instances.push(host); return host; }
const state = (run: S2WorkflowRun, id: string) => run.nodes.find(node => node.nodeId === id)!;
const host = hostFor(document);
const first = await host.enqueueWorkflow(['view']).completion;
assert.equal(first.status, 'succeeded'); assert.equal(state(first, 'left').status, 'succeeded'); assert.equal(state(first, 'right').status, 'skipped'); assert.equal(state(first, 'merge').status, 'succeeded');
assert.equal(state(first, 'view').status, 'displayed'); assert.equal(host.remainingCalls, 61);
assert.deepEqual(state(first, 'merge').mergeEvidence?.skippedNodeIds, ['right']);
assert.equal(state(first, 'merge').mergeEvidence?.selectedArtifactId, state(first, 'left').artifactIds[0]);
assert.equal(state(first, 'merge').mergeEvidence?.selectedNodeId, 'left');
assert.deepEqual((host.currentArtifact(state(first, 'merge').artifactIds[0]).payload as any).value, { same: true });
assert.deepEqual(host.history().find(item => item.request.nodeId === 'merge')!.request.inputs.candidates, state(first, 'left').artifactIds);
const repeated = await host.enqueueWorkflow(['view']).completion;
assert.equal(state(repeated, 'merge').status, 'cached'); assert.equal(host.remainingCalls, 61);
assert.notEqual(state(repeated, 'merge').mergeEvidence?.selectedArtifactId, state(first, 'merge').mergeEvidence?.selectedArtifactId, 'Reuse is backed by this run\'s fresh upstream artifact, not stale selection metadata');

// Equal data on a DIFFERENT active branch can reuse a value, but must retain this run's actual source selection.
const changed = applyS2Commands(definition, document, [{ op: 'update-execution-node', id: 'check', bindings: { text: literal('{bad}') } }]);
host.setDocument(changed); const switched = await host.enqueueWorkflow(['view']).completion;
assert.equal(state(switched, 'left').status, 'skipped'); assert.equal(state(switched, 'right').status, 'succeeded'); assert.equal(state(switched, 'merge').status, 'cached');
assert.equal(state(switched, 'merge').mergeEvidence?.selectedArtifactId, state(switched, 'right').artifactIds[0]); assert.deepEqual(state(switched, 'merge').mergeEvidence?.skippedNodeIds, ['left']);
assert.equal(state(switched, 'merge').mergeEvidence?.selectedNodeId, 'right');
assert.equal(host.workflowHistory()[0].publication, 'stale');
const overlap = applyS2Commands(definition, document, [{ op: 'set-execution-condition', id: 'right', when: when(true) }]);
host.setDocument(overlap); const beforeConflict = host.history().filter(item => item.request.nodeId === 'merge').length;
const conflict = await host.enqueueWorkflow(['view']).completion;
assert.equal(state(conflict, 'merge').status, 'failed'); assert.equal(state(conflict, 'view').status, 'blocked');
assert.equal(state(conflict, 'merge').mergeEvidence?.candidateArtifactIds.length, 2, 'Equal candidate VALUES are still two candidate SOURCES');
assert.equal(host.history().filter(item => item.request.nodeId === 'merge').length, beforeConflict, 'Ambiguity is rejected BEFORE dispatch and cache reuse');
assert.ok(state(conflict, 'merge').error?.includes('冲突'));
const none = applyS2Commands(definition, document, [{ op: 'set-execution-condition', id: 'left', when: when(false) }]);
const noneHost = hostFor(none); const emptyRun = await noneHost.enqueueWorkflow(['view']).completion;
assert.equal(emptyRun.status, 'succeeded'); assert.equal(state(emptyRun, 'merge').status, 'skipped'); assert.equal(state(emptyRun, 'view').status, 'skipped'); assert.equal(noneHost.remainingCalls, 63);
assert.equal(noneHost.history().some(item => item.request.nodeId === 'merge'), false);

// Failure is NOT absence. Even with one valid candidate, do not select around a failed/unknown branch.
const broken = structuredClone(overlap); broken.execution!.nodes.find(node => node.id === 'left')!.bindings.text = literal('{bad}');
const failureHost = hostFor(broken); const failed = await failureHost.enqueueWorkflow(['view']).completion;
assert.equal(state(failed, 'right').status, 'succeeded'); assert.equal(state(failed, 'merge').status, 'blocked'); assert.deepEqual(state(failed, 'merge').mergeEvidence?.blockedNodeIds, ['left']);
assert.equal(failureHost.history().some(item => item.request.nodeId === 'merge'), false);
const unknownHost = new S2PluginHost('scene-unknown', plugins, async (call, inputs, signal) => call.nodeId === 'left'
  ? { status: 'unknown', outputs: {}, error: { code: 'SYNTHETIC_UNKNOWN', message: 'unknown branch' } }
  : call.pluginId === 'json-check' ? executeS2JsonCheck(call, inputs, signal) : executeS2Structured(call, inputs));
instances.push(unknownHost); unknownHost.setDocument(overlap); const unknown = await unknownHost.enqueueWorkflow(['view']).completion;
assert.equal(state(unknown, 'merge').status, 'blocked');
const mixed = structuredClone(document); mixed.execution!.links[0].source = { nodeId: 'check', portId: 'assessment' };
assert.throws(() => readS2Definition({ ...definition, initial: mixed }), /类型/);

// Literal binding + linked candidates are jointly counted, never silently overridden by the literal.
const constant = structuredClone(document); constant.execution!.nodes.find(node => node.id === 'merge')!.bindings.candidates = literal({ constant: true });
const constantHost = hostFor(constant); const both = await constantHost.enqueueWorkflow(['view']).completion;
assert.equal(state(both, 'merge').status, 'failed'); assert.equal(state(both, 'merge').mergeEvidence?.candidateArtifactIds.length, 2);
const directContext = host.prepare('merge', { goal: definition.goal, ...definition.instructions }, 'bypass');
const direct = { nodeId: 'merge', pluginId: 'workflow-merge', pluginVersion: '1.0.0', capabilityId: 'merge-json', inputs: { candidates: [state(conflict, 'left').artifactIds[0]] }, reason: 'attempt to omit a live branch' };
const budget = host.remainingCalls;
await assert.rejects(() => host.execute(direct, directContext.frame, 'bypass'), /执行图调度/); assert.equal(host.remainingCalls, budget);
// Even a content node cannot be used as a proxy for bypassing graph-only merge validation.
await assert.rejects(() => host.execute({ ...direct, nodeId: 'content-proxy' }, directContext.frame, 'proxy'), /目标|可用对象|范围/);
const response = (value: unknown) => ({ content: JSON.stringify(value) } as any);
await assert.rejects(() => interactS2Canvas({ ...scene, canvasWorkspace: definition }, overlap, 'omit a branch', 'merge', [], { pluginContext: directContext, invoke: async () => response({ understanding: 'single', plan: 'single call', reply: 'no', commands: [], pluginRequests: [direct] }) }), /不能用单次/);

// Every supported semantic type is preserved; simulation is never a JSON/fact adapter.
for (const [capabilityId, expectedType, value] of [
  ['merge-json', 'structured-data.value', null], ['merge-json', 'structured-data.value', false],
  ['merge-assessment', 'core.assessment', { status: 'fail', reason: 'synthetic negative content', evidence: [] }],
  ['merge-simulation', 'workflow-simulation.result', { mode: 'simulation-only', steps: [{ purpose: 'mock', assumptions: 'not real', input: null, output: { delivered: true } }] }],
] as const) {
  const doc: S2Document = { nodes: [], edges: [], execution: { version: 1, nodes: [{ ...merge(capabilityId), bindings: { candidates: literal(value) } }], links: [] } };
  const typedHost = hostFor(doc); const run = await typedHost.enqueueWorkflow().completion;
  assert.equal(run.status, 'succeeded'); const artifact = typedHost.currentArtifact(state(run, 'merge').artifactIds[0]);
  assert.equal(artifact.type.id, expectedType); assert.deepEqual((artifact.payload as any).value, value);
  if (capabilityId === 'merge-simulation') { assert.equal(state(run, 'merge').mergeEvidence?.simulation, true); assert.ok(renderToStaticMarkup(<S2ArtifactView artifact={artifact} />).includes('非真实业务执行')); }
}

const fragment = exportS2Subgraph(definition, document, ['merge']);
assert.equal(JSON.parse(fragment).ports.inputs[0].multiple, true);
const pasted = importS2Subgraph(fragment, definition, document), pastedId = pasted.nodeIds[0];
const pasteHost = hostFor(pasted.document); assert.throws(() => pasteHost.enqueueWorkflow([pastedId]), /必填/);
assert.equal(pasteHost.remainingCalls, 64, 'Unbound portable merge inputs do not borrow old results or authority');
const unauthorized = new S2PluginHost('scene-unapproved', plugins.filter(cap => cap.pluginId !== 'workflow-merge')); instances.push(unauthorized); unauthorized.setDocument(document);
assert.throws(() => unauthorized.enqueueWorkflow(['view']), /未装配/);
const queuedHost = hostFor(document); const queued = queuedHost.enqueueWorkflow(['view']); queuedHost.cancelWorkflow(queued.id);
assert.equal((await queued.completion).status, 'cancelled'); assert.equal(queuedHost.remainingCalls, 64);
const zeroHost = hostFor(document); await zeroHost.enqueueWorkflow(['view']).completion;
while (zeroHost.remainingCalls > 0) await zeroHost.enqueueWorkflow(['check'], undefined, { force: true }).completion;
const zero = await zeroHost.enqueueWorkflow(['view']).completion;
assert.equal(zero.status, 'succeeded'); assert.equal(state(zero, 'merge').status, 'cached'); assert.equal(zeroHost.remainingCalls, 0);
await designS2Canvas(scene, { disclosure: 'complete', invoke: async request => { if (JSON.parse(request.userInput).stage === 'assemble') { assert.ok(request.systemPromptOverride?.includes('合流仅0路跳过、1路传递、多路冲突')); assert.ok(request.systemPromptOverride?.includes('失败来源仍阻塞')); assert.ok(request.userInput.includes('workflow-merge')); } return s2DesignFixtureResponse(request, definition); } });
const proposal = await interactS2Canvas({ ...scene, canvasWorkspace: definition }, document, '只讨论合流，不运行', null, [], { pluginContext: queuedHost.prepare(null, { goal: definition.goal, ...definition.instructions }, ''), invoke: async request => {
  assert.ok(request.systemPromptOverride?.includes('恰好一路')); return response({ understanding: '仅解释', plan: '不运行', reply: '多路同时命中会报冲突', commands: [] });
} });
assert.equal(proposal.executionRequest, undefined);
for (const instance of instances) instance.close();
console.log('S2 merge passed: explicit typed exclusive joins, fresh source evidence across cache/branch switches, zero/one/multiple candidates, fail-closed upstream failures/unknowns, no literal override or direct-call bypass, preserved simulation/null/false, portable multi-input boundaries, cancellation and zero-budget cache reuse. Synthetic only; no real models/services.');
