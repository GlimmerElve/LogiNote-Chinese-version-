// Fixed synthetic replies below intentionally test complete-catalogue compatibility, not progressive discovery.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { createS2Scene, readS2Scene, readS2Definition, readS2Document, applyS2Commands, designS2Canvas, interactS2Canvas as rawInteractS2Canvas } from '../src/services/scene/sceneS2Canvas';
import { normalizeSceneSpec, toManifestEntry } from '../src/services/scene/sceneSkillStore';
import { adaptScene, generateScene } from '../src/services/scene/sceneGenerator';
import { SceneS2CanvasTrial } from '../src/components/scene/SceneS2CanvasTrial';
import type { LlmCallRequest, LlmCallResponse } from '../src/types';
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { S2_JSON_CHECK_BINDING } from '../src/services/scene/sceneS2PluginRegistry';
import { s2DesignFixtureResponse, s2TurnFixtureAdapter } from './fixtures/s2-design-model';
import { S2_BUILDER_CANVAS_RULES } from '../src/services/scene/sceneS2BuildContext';
const interactS2Canvas = s2TurnFixtureAdapter(rawInteractS2Canvas);

globalThis.fetch = async () => assert.fail('S2 regression must not call models, notes, engines or network');
const request = { source: 'custom', subject: 'Synthetic canvas', knowledgePoints: ['Title only'], extraHints: 'Compare two explanations', sceneSkill: 'S2' } as const;
const scene = createS2Scene({ ...request, knowledgePoints: [...request.knowledgePoints] });
await assert.rejects(() => generateScene({ sceneSkill: 'S2', manifest: { scenes: [] } } as any), /独立通用画布/);
await assert.rejects(() => adaptScene({ sourceSpec: scene, sceneSkill: 'S1' } as any), /不能通过/);
const definition = readS2Scene(scene), original = structuredClone(definition.initial), before = JSON.stringify(original);
assert.equal(scene.meta.sceneSkill, 'S2'); assert.equal(scene.compute, undefined); assert.equal(scene.help, undefined);
assert.equal(scene.injectProfile, false); assert.equal(scene.eventInjection, false); assert.equal(scene.behavior, undefined);
assert.deepEqual(readS2Scene(normalizeSceneSpec(scene)!), definition, 'Saved scene normalization preserves the S2 protocol');
assert.deepEqual(toManifestEntry(scene).architecture.interactionTypes, []);
assert.equal(toManifestEntry(scene).architecture.paradigmLabel, 'S2 通用画布 · 试验');
assert.throws(() => readS2Scene({ ...scene, runtimeContract: {} as any }), /不能继承/);
assert.throws(() => readS2Scene({ ...scene, meta: { ...scene.meta, sceneSkill: 'S4' } }), /不能读取/);
assert.throws(() => readS2Scene({ ...scene, canvasWorkspace: undefined }), /历史 S2/);
assert.throws(() => readS2Definition({ ...definition, version: 2 }), /版本/);
assert.throws(() => readS2Definition({ ...definition, allowedTools: ['model-experiment'] }), /未支持/);
assert.throws(() => readS2Definition({ ...definition, blockTypes: [{ id: 'text', label: 'Test', fields: [{ id: 'constructor', label: 'bad', kind: 'text' }] }] }), /标识符/);
assert.throws(() => readS2Definition({ ...definition, blockTypes: [{ id: 'html', label: 'HTML', fields: [{ id: 'code', label: 'code', kind: 'script' }] }] }), /未安装/);
const added = { id: 'compare', type: 'text', position: { x: 420, y: 50 }, values: { content: 'Other version' } };
const next = applyS2Commands(definition, original, [{ op: 'add-node', node: added },
  { op: 'add-edge', edge: { id: 'e1', source: 'goal', target: 'compare', label: 'compare' } },
  { op: 'add-edge', edge: { id: 'e2', source: 'compare', target: 'goal', label: 'reference' } }]);
assert.equal(next.nodes.length, 2); assert.equal(next.edges.length, 2, 'S2 reference cycles are allowed, unlike S4 proofs');
assert.equal(JSON.stringify(original), before, 'Operations never mutate their input');
assert.throws(() => applyS2Commands(definition, original, [{ op: 'update-node', id: 'goal', values: { content: 'should roll back' } },
  { op: 'add-edge', edge: { id: 'bad', source: 'goal', target: 'missing', label: 'invalid' } }]), /端点/);
assert.equal(JSON.stringify(original), before, 'Failed batches leave the original canvas unchanged');
assert.throws(() => applyS2Commands(definition, original, [{ op: 'execute-plugin', id: 'compute' }]), /未授权/);
assert.throws(() => applyS2Commands(definition, original, [{ op: 'update-node', id: 'goal', values: { formula_correct: 'true' } }]), /未支持/);
assert.throws(() => applyS2Commands(definition, original, [{ op: 'add-node', node: { ...added, type: 'formula' } }]), /未装配/);
assert.throws(() => applyS2Commands(definition, original, [{ op: 'add-node', node: { ...added, id: 'goal' } }]), /重复/);
assert.throws(() => readS2Document({ nodes: [{ ...added, position: { x: Infinity, y: 0 } }], edges: [] }, definition), /位置/);
assert.throws(() => readS2Document({ nodes: [added], edges: [{ id: 'self', source: 'compare', target: 'compare', label: 'bad' }] }, definition), /端点/);
assert.equal(applyS2Commands(definition, next, [{ op: 'remove-node', id: 'compare' }]).edges.length, 0);
assert.throws(() => applyS2Commands(definition, original, Array.from({ length: 13 }, () => ({ op: 'remove-node', id: 'goal' }))), /12/);

let calls = 0;
const reply = (content: unknown): LlmCallResponse => ({ content: JSON.stringify(content) } as LlmCallResponse);
const invoke = async (input: LlmCallRequest) => {
  calls++;
  assert.equal(input.workflow, 'agent-scene-setup'); assert.equal(input.skipMemoryInjection, true); assert.equal(input.skipProfileInjection, true);
  const stage = JSON.parse(input.userInput).stage;
  if (stage === 'assemble') {
    assert.ok(input.systemPromptOverride?.includes(S2_BUILDER_CANVAS_RULES), 'Complete compatibility still uses the declarative builder schema, not runtime instructions');
    assert.ok(!input.systemPromptOverride?.includes('S2插件协议v1'));
    assert.equal(JSON.parse(input.userInput).pluginCatalog.representation, 's2-builder-catalog-v1');
  } else assert.ok(!input.systemPromptOverride?.includes('S2插件协议v1'), 'Understanding and read-only review are not tool dispatch stages');
  assert.ok(!input.userInput.includes('referenceScope'));
  return s2DesignFixtureResponse(input, definition);
};
const built = await designS2Canvas(scene, { disclosure: 'complete', invoke });
const { designBrief, business, ...builtDefinition } = built;
assert.ok(business, 'Fresh builder has a synthetic business contract; not a real semantic sufficiency claim');
assert.deepEqual(builtDefinition, definition); assert.ok(designBrief);
const output = { understanding: 'You want a separate comparison', plan: 'Add one block', reply: 'Review the proposed addition', commands: [{ op: 'add-node', node: added }] };
const result = await interactS2Canvas(scene, original, 'Keep original; add a comparison', 'goal', [], { invoke: async input => {
  calls++;
  const data = JSON.parse(input.userInput);
  assert.equal(data.pluginCatalog.protocolVersion, 1);
  assert.equal(data.pluginCatalog.plugins[0].id, 'core');
  assert.equal(data.pluginCatalog.artifactTransportAvailable, true);
  assert.ok(input.systemPromptOverride?.includes('调用状态与内容评价分离'));
  assert.equal(data.selectedId, 'goal'); assert.equal(data.current.nodes[0].values.content, original.nodes[0].values.content);
  assert.ok(input.systemPromptOverride?.includes('先理解用户表达'));
  return reply(output);
} });
assert.deepEqual(result, output); assert.equal(JSON.stringify(original), before, 'Agent responses are proposals, not implicit writes');
const selectedDefinition = { ...definition, plugins: [{ ...S2_JSON_CHECK_BINDING }] };
assert.deepEqual(readS2Definition(selectedDefinition), selectedDefinition);
assert.deepEqual(readS2Scene(normalizeSceneSpec({ ...scene, canvasWorkspace: selectedDefinition })!), selectedDefinition);
assert.throws(() => readS2Definition({ ...definition, plugins: [{ ...S2_JSON_CHECK_BINDING, permissions: ['network'] }] }), /未安装/);
assert.throws(() => readS2Definition({ ...definition, plugins: [{ ...S2_JSON_CHECK_BINDING, pluginVersion: '2.0.0' }] }), /未安装/);
assert.throws(() => readS2Definition({ ...definition, plugins: [S2_JSON_CHECK_BINDING, S2_JSON_CHECK_BINDING] }), /重复/);
const runtime = new S2PluginHost(scene.sceneId, selectedDefinition.plugins); runtime.setDocument(original);
const context = runtime.prepare('goal', { goal: definition.goal, ...definition.instructions }, 'Check selected content');
const toolRequest = { ...S2_JSON_CHECK_BINDING, nodeId: 'goal', inputs: { text: [context.bindings[0].artifactId] }, reason: 'User requested a syntax check' };
const toolReply = { understanding: 'Check selected field', plan: 'Confirm before execution', reply: 'Please confirm', commands: [], pluginRequests: [toolRequest] };
const selectedScene = { ...scene, canvasWorkspace: selectedDefinition };
const parsedTool = await interactS2Canvas(selectedScene, original, 'Check JSON', 'goal', [], { pluginContext: context, invoke: async input => {
  assert.deepEqual(JSON.parse(input.userInput).pluginContext.approvedCapabilities, selectedDefinition.plugins);
  return reply(toolReply);
} });
assert.deepEqual(parsedTool, toolReply); assert.equal(runtime.history().length, 0, 'A parsed tool intention does not execute');
await assert.rejects(() => interactS2Canvas(scene, original, 'Bad call', 'goal', [], { invoke: async () => reply(toolReply) }), /宿主上下文/);
await assert.rejects(() => interactS2Canvas(scene, original, 'Bad call', 'goal', [], { pluginContext: { ...context, approvedCapabilities: [] }, invoke: async () => reply(toolReply) }), /未批准/);
await assert.rejects(() => interactS2Canvas(selectedScene, original, 'Bad data', 'goal', [], { pluginContext: context, invoke: async () => reply({ ...toolReply, pluginRequests: [{ ...toolRequest, inputs: { text: ['invented'] } }] }) }), /不可用/);
await assert.rejects(() => interactS2Canvas(selectedScene, original, 'Fake receipt', 'goal', [], { pluginContext: context, invoke: async () => reply({ ...toolReply, receipt: { status: 'succeeded' } }) }), /未支持/);
await runtime.execute(toolRequest, context.frame, 'key-synthetic');
const observedContext = runtime.prepare('goal', { goal: definition.goal, ...definition.instructions }, 'Explain');
await interactS2Canvas(selectedScene, original, 'Explain check', 'goal', [], { pluginContext: observedContext, invoke: async input => {
  const observation = JSON.parse(input.userInput).pluginContext.frame.observations[0];
  assert.equal(observation.executionStatus, 'succeeded'); assert.ok(observation.artifacts[0].preview.includes('fail'));
  return reply({ understanding: 'Check completed', plan: 'Explain invalid JSON', reply: 'Only the syntax was checked.', commands: [], pluginRequests: [] });
} });
runtime.close();
await assert.rejects(() => interactS2Canvas(scene, original, 'bad', null, [], { invoke: async () => reply({ ...output, commands: [{ op: 'run-code', code: 'x' }] }) }), /未授权/);
await assert.rejects(() => designS2Canvas(scene, { disclosure: 'complete', invoke: async () => ({ ...reply(definition), diagnostics: { finishReason: 'length' } } as LlmCallResponse) }), /截断/);
const abort = new AbortController(); abort.abort();
await assert.rejects(() => designS2Canvas(scene, { disclosure: 'complete', signal: abort.signal, invoke }), /停止|取消/);
assert.equal(JSON.stringify(original), before);

const app = readFileSync('src/App.tsx', 'utf8');
assert.ok(app.includes("sceneRequest?.sceneSkill === 'S2' &&"));
assert.ok(app.includes("sceneRequest.sceneSkill !== 'S2' &&"));
const host = readFileSync('src/components/scene/SceneS2CanvasTrial.tsx', 'utf8');
assert.ok(!/from ['"].*(?:derivation|sceneS4|sceneExperiment|computeClient)/.test(host));
assert.ok(host.includes('proposal.inputKey !== JSON.stringify(documentRef.current)'));
assert.ok(host.includes('controller.signal.aborted'));
assert.ok(host.includes('sceneId: `scene-s2-${crypto.randomUUID()}`'), 'Saving creates a new template, never overwrites S4/old S2');
assert.ok(host.includes('if (sequence !== saveSequence.current) return;'));
assert.ok(host.includes('确认应用修改'));
const markup = renderToStaticMarkup(createElement(SceneS2CanvasTrial, {
  initialRequest: { ...request, knowledgePoints: [...request.knowledgePoints] }, onExit: () => {},
}));
assert.ok(markup.includes('S2 实验画布')); assert.ok(markup.includes('自行填写、接线、运行；需要时再请 Agent 帮助。'));
console.log(`S2 canvas passed: independent versioned entry, template roundtrip, declarative types, cyclic references, atomic commands, authority/data bounds, synthetic design/interaction (${calls} calls), truncation/abort and explicit proposal confirmation. No real IO/model calls; not browser E2E.`);
