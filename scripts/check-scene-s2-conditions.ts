// Fixed synthetic replies below intentionally test complete-catalogue compatibility, not progressive discovery.
import assert from 'node:assert/strict';
import { s2DesignFixtureResponse, s2TurnFixtureAdapter } from './fixtures/s2-design-model';
import type { S2Document, S2WorkflowCondition, S2WorkflowNode } from '../src/types/sceneS2';
import { applyS2Commands, createS2Scene, readS2Definition, exportS2Subgraph, importS2Subgraph, interactS2Canvas as rawInteractS2Canvas, designS2Canvas } from '../src/services/scene/sceneS2Canvas';
const interactS2Canvas = s2TurnFixtureAdapter(rawInteractS2Canvas);
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { s2ComposableCapabilities } from '../src/services/scene/sceneS2PluginRegistry';
import { selectS2Execution } from '../src/services/scene/sceneS2Workflow';

globalThis.fetch = async () => assert.fail('Condition tests must not access real models or services');
const scene = createS2Scene({ source: 'custom', subject: 'Synthetic conditions', knowledgePoints: [], sceneSkill: 'S2' });
// Pin this legacy fixture's original capabilities; the growing installation catalogue is not its authorization list.
const plugins = s2ComposableCapabilities().filter(({ pluginId, capabilityId }) => ['json-check', 'structured-data', 'structured-view', 'workflow-simulation', 'workflow-merge', 'human-input'].includes(pluginId) && !(pluginId === 'structured-view' && capabilityId === 'text')).map(({ pluginId, pluginVersion, capabilityId }) => ({ pluginId, pluginVersion, capabilityId }));
const condition = (match: boolean): S2WorkflowCondition => ({ nodeId: 'check', portId: 'assessment', pointer: '/status', equals: 'pass', match });
const check = (id: string, text: string): S2WorkflowNode => ({ id, pluginId: 'json-check', pluginVersion: '1.0.0', capabilityId: 'validate', position: { x: 0, y: 0 }, bindings: { text: { kind: 'literal', value: text } } });
const document: S2Document = { nodes: [], edges: [], execution: { version: 1, nodes: [
  { ...check('yes', '{}'), when: condition(true) }, { ...check('no', '{}'), when: condition(false) }, check('check', '{}'), check('independent', '{}'),
], links: [] } };
const definition = readS2Definition({ ...scene.canvasWorkspace!, plugins, initial: document });
const host = new S2PluginHost(scene.sceneId, plugins); host.setDocument(document);
const first = await host.enqueueWorkflow().completion;
const status = (run: typeof first, id: string) => run.nodes.find(node => node.nodeId === id)!.status;
assert.equal(first.status, 'succeeded'); assert.equal(status(first, 'yes'), 'succeeded'); assert.equal(status(first, 'no'), 'skipped');
assert.equal(host.remainingCalls, 61, 'Only source, matched branch and independent branch cost a call');
assert.equal(host.history().some(item => item.request.nodeId === 'no'), false, 'Skipped branch has NO invocation or fake receipt');
const evidence = first.nodes.find(node => node.nodeId === 'yes')!.conditionEvidence!;
assert.equal(evidence.matched, true); assert.equal(evidence.simulation, false); assert.equal(host.currentArtifact(evidence.artifactId).type.id, 'core.assessment');
const second = await host.enqueueWorkflow().completion;
assert.equal(status(second, 'yes'), 'cached'); assert.equal(status(second, 'no'), 'skipped'); assert.equal(host.remainingCalls, 61);
const onlyOther = await host.enqueueWorkflow(['no']).completion;
assert.deepEqual(new Set(onlyOther.nodes.map(node => node.nodeId)), new Set(['check', 'no'])); assert.equal(onlyOther.status, 'succeeded');
assert.equal(status(onlyOther, 'no'), 'skipped', 'Selecting a target never overrides its condition');
const switched = applyS2Commands(definition, document, [{ op: 'update-execution-node', id: 'check', bindings: { text: { kind: 'literal', value: '{bad}' } } }]);
host.setDocument(switched); const next = await host.enqueueWorkflow().completion;
assert.equal(status(next, 'yes'), 'skipped'); assert.equal(status(next, 'no'), 'succeeded'); assert.equal(status(next, 'independent'), 'cached');
assert.equal(host.history()[0].receipt.publication, 'stale');

// A valid capability grant + user confirmation is NOT permission to bypass a node's execution guard.
const prepared = host.prepare('yes', { goal: definition.goal, ...definition.instructions }, 'Try a direct call');
const text = prepared.bindings.find(binding => binding.fieldId === 'text')!.artifactId;
const request = { nodeId: 'yes', pluginId: 'json-check', pluginVersion: '1.0.0', capabilityId: 'validate', inputs: { text: [text] }, reason: 'synthetic bypass attempt' };
const before = host.remainingCalls;
await assert.rejects(() => host.execute(request, prepared.frame, 'bypass'), /带条件节点/); assert.equal(host.remainingCalls, before);
const response = (value: unknown) => ({ content: JSON.stringify(value) } as any);
await assert.rejects(() => interactS2Canvas({ ...scene, canvasWorkspace: definition }, switched, 'bypass', 'yes', [], { pluginContext: prepared, invoke: async () => response({ understanding: 'bypass', plan: 'single call', reply: 'no', commands: [], pluginRequests: [request] }) }), /不能用单次/);

// Draft validation: guard removal is explicit, source loss is never silently converted to unconditional execution.
assert.throws(() => applyS2Commands(definition, document, [{ op: 'remove-execution-node', id: 'check' }]), /条件来源不存在/);
assert.throws(() => applyS2Commands(definition, document, [{ op: 'set-execution-condition', id: 'yes' }]), /明确提供/);
assert.throws(() => applyS2Commands(definition, document, [{ op: 'set-execution-condition', id: 'yes', when: undefined }]), /明确提供/);
for (const when of [
  { ...condition(true), match: 'true' }, { ...condition(true), pointer: 'status' }, { ...condition(true), nodeId: 'missing' },
  { ...condition(true), portId: 'missing' }, { ...condition(true), mystery: true }, { ...condition(true), equals: 'x'.repeat(6001) },
]) assert.throws(() => applyS2Commands(definition, document, [{ op: 'set-execution-condition', id: 'yes', when }]));
const cycle = structuredClone(document); cycle.execution!.nodes.find(node => node.id === 'check')!.when = { ...condition(true), nodeId: 'yes' };
assert.throws(() => readS2Definition({ ...definition, initial: cycle }), /循环/);
const self = structuredClone(document); self.execution!.nodes.find(node => node.id === 'yes')!.when!.nodeId = 'yes';
assert.throws(() => readS2Definition({ ...definition, initial: self }), /循环/);
const cleared = applyS2Commands(definition, document, [{ op: 'set-execution-condition', id: 'yes', when: null }]);
assert.equal(cleared.execution!.nodes.find(node => node.id === 'yes')!.when, undefined);
const copied = applyS2Commands(definition, document, [{ op: 'batch-nodes', action: { kind: 'copy', nodeIds: ['check', 'yes'] } }]);
const original = new Set(document.execution!.nodes.map(node => node.id)), clones = copied.execution!.nodes.filter(node => !original.has(node.id));
assert.equal(clones.find(node => node.when)?.when?.nodeId, clones.find(node => !node.when)?.id);
const fragment = exportS2Subgraph(definition, document, ['yes']);
assert.deepEqual(new Set(JSON.parse(fragment).definition.initial.execution.nodes.map((node: S2WorkflowNode) => node.id)), new Set(['check', 'yes']));
const pasted = importS2Subgraph(fragment, definition, document);
assert.ok(pasted.document.execution!.nodes.filter(node => pasted.nodeIds.includes(node.id)).find(node => node.when)!.when!.nodeId !== 'check');

// A skipped producer propagates skipping; failure/missing pointer is blocked, not guessed false.
const pipeline: S2Document = { nodes: [], edges: [], execution: { version: 1, nodes: [check('check', '{}'),
  { id: 'parse', pluginId: 'structured-data', pluginVersion: '1.0.0', capabilityId: 'parse-json', position: { x: 0, y: 0 }, bindings: { text: { kind: 'literal', value: '{}' } }, when: condition(false) },
  { id: 'render', pluginId: 'structured-view', pluginVersion: '1.0.0', capabilityId: 'json-tree', position: { x: 0, y: 0 }, bindings: {} },
], links: [{ source: { nodeId: 'parse', portId: 'value' }, target: { nodeId: 'render', portId: 'value' } }] } };
const pipelineHost = new S2PluginHost('scene-pipeline', plugins); pipelineHost.setDocument(pipeline);
const piped = await pipelineHost.enqueueWorkflow(['render']).completion;
assert.equal(status(piped, 'parse'), 'skipped'); assert.equal(status(piped, 'render'), 'skipped'); assert.equal(piped.status, 'succeeded'); assert.equal(pipelineHost.remainingCalls, 63);
const missingPath = structuredClone(document); missingPath.execution!.nodes[0].when!.pointer = '/missing';
const pathHost = new S2PluginHost('scene-path', plugins); pathHost.setDocument(missingPath); const badPath = await pathHost.enqueueWorkflow().completion;
assert.equal(status(badPath, 'yes'), 'blocked'); assert.equal(status(badPath, 'independent'), 'succeeded'); assert.equal(badPath.status, 'failed');
assert.ok(badPath.nodes.find(node => node.nodeId === 'yes')!.error?.includes('路径不存在'));
const failedSource = structuredClone(pipeline); failedSource.execution!.nodes.find(node => node.id === 'parse')!.when = undefined;
failedSource.execution!.nodes.find(node => node.id === 'parse')!.bindings.text = { kind: 'literal', value: '{bad}' };
failedSource.execution!.nodes[0].when = { nodeId: 'parse', portId: 'value', pointer: '', equals: {}, match: false };
const failureHost = new S2PluginHost('scene-failure', plugins); failureHost.setDocument(failedSource);
const failure = await failureHost.enqueueWorkflow().completion; assert.equal(status(failure, 'check'), 'blocked'); assert.equal(status(failure, 'parse'), 'failed');

// Simulation guards preserve their provenance. They do not certify that a real service succeeded.
const simulated: S2Document = { nodes: [], edges: [], execution: { version: 1, nodes: [
  { id: 'mock', pluginId: 'workflow-simulation', pluginVersion: '1.0.0', capabilityId: 'step', position: { x: 0, y: 0 }, bindings: {
    purpose: { kind: 'literal', value: '模拟发送' }, assumptions: { kind: 'literal', value: '仅样例，不发送' }, sample: { kind: 'literal', value: { delivered: false } },
  } }, { ...check('manual', '{}'), when: { nodeId: 'mock', portId: 'result', pointer: '/steps/0/output/delivered', equals: false, match: true } },
], links: [] } };
const simHost = new S2PluginHost('scene-sim', plugins); simHost.setDocument(simulated); const simRun = await simHost.enqueueWorkflow().completion;
assert.equal(status(simRun, 'manual'), 'succeeded'); assert.equal(simRun.nodes.find(node => node.nodeId === 'manual')!.conditionEvidence?.simulation, true);
await designS2Canvas(scene, { disclosure: 'complete', invoke: async request => { if (JSON.parse(request.userInput).stage === 'assemble') assert.ok(request.systemPromptOverride?.includes('条件依赖')); return s2DesignFixtureResponse(request, definition); } });
const proposal = await interactS2Canvas({ ...scene, canvasWorkspace: definition }, document, '失败才运行此节点', 'yes', [], { pluginContext: host.prepare(null, { goal: definition.goal, ...definition.instructions }, ''), invoke: async request => {
  assert.ok(request.systemPromptOverride?.includes('缺字段')); return response({ understanding: '设置失败分支', plan: '仅修改条件', reply: '请确认', commands: [{ op: 'set-execution-condition', id: 'yes', when: { ...condition(true), equals: 'fail' } }] });
} });
assert.equal(proposal.commands.length, 1); assert.equal(document.execution!.nodes[0].when!.equals, 'pass');
for (const instance of [host, pipelineHost, pathHost, failureHost, simHost]) instance.close();
console.log('S2 conditions passed: matched-only execution, no-call skips, precise/unknown guards, control ancestor selection, combined cycle checks, direct-call bypass rejection, cache/stale safety, preserved copy/export guards and explicitly simulated evidence. Synthetic data only, no real model/services.');
