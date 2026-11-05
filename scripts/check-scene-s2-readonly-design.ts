// Fixed synthetic replies below intentionally test complete-catalogue compatibility, not progressive discovery.
import assert from 'node:assert/strict';
import type { S2CanvasDefinition, S2DesignBrief } from '../src/types/sceneS2';
import { createS2Scene, designS2Canvas, interactS2Canvas, readS2Definition, readS2Scene } from '../src/services/scene/sceneS2Canvas';
import { buildS2Design, s2DesignEvidencePaths, s2DesignProtocolFacts, S2DesignJsonError } from '../src/services/scene/sceneS2Design';
import { s2CanvasContext, s2CanvasWiringFacts, S2_CONTEXT_RULES } from '../src/services/scene/sceneS2Context';
import { S2_WORKFLOW_AGENT_RULES } from '../src/services/scene/sceneS2Workflow';
import { S2_PLUGIN_PROTOCOL_RULES } from '../src/services/scene/sceneS2PluginProtocol';
import { S2_BUILDER_CANVAS_RULES } from '../src/services/scene/sceneS2BuildContext';
import { describePromptLab } from '../src/interaction-packs/prompt-lab/description';

globalThis.fetch = async () => assert.fail('Readonly design checks use synthetic Agent responses, never real models or network');
const task = '固定角色和输出要求，只让学习者修改任务说明；三个可见内容块使用同一种文字组件，并按正常流程组装和测试。';
const scene = createS2Scene({ source: 'custom', sceneSkill: 'S2', subject: '合成实例级内容约束', knowledgePoints: [],
  extraHints: task, interactionPack: { id: 'prompt-lab', version: '0.1.0' } });
const base = readS2Scene(scene), before = JSON.stringify(scene);
const packageGuide = describePromptLab(), guideBefore = JSON.stringify(packageGuide);
const brief: S2DesignBrief = { goal: task,
  requirements: [{ id: 'FixedContent', description: '角色与输出要求固定，任务可改，沿用通用文字块', source: 'task', quote: task }],
  userRole: '仅修改任务说明并按需运行', agentRole: '协助解释与组装，保留固定内容', assumptions: [], openQuestions: [],
  delivery: { initial: '提供已接线的三个通用内容块及组装、测试、结果展示', deferred: '学习者调整任务后决定测试', source: 'task', quote: task } };
const cap = (pluginId: string, capabilityId: string) => ({ pluginId, pluginVersion: '1.0.0', capabilityId });
const candidate: S2CanvasDefinition = { ...base, initial: { nodes: [
  { id: 'role', type: 'text', label: '角色', readOnly: true, position: { x: 0, y: 0 }, values: { content: '你是一名清晰表达的讲解者。' } },
  { id: 'task', type: 'text', label: '任务说明', position: { x: 0, y: 180 }, values: { content: '解释什么是函数。' } },
  { id: 'output', type: 'text', label: '输出要求', readOnly: true, position: { x: 0, y: 360 }, values: { content: '输出摘要和例子两个字段。' } },
], edges: [], execution: { version: 1, nodes: [
  { id: 'compose', ...cap('text-template', 'compose'), position: { x: 400, y: 100 }, bindings: {
    part1: { kind: 'field', nodeId: 'role', fieldId: 'content' }, part2: { kind: 'field', nodeId: 'task', fieldId: 'content' },
    part3: { kind: 'field', nodeId: 'output', fieldId: 'content' },
  } },
  { id: 'test', ...cap('model-test', 'generate'), position: { x: 700, y: 100 }, bindings: {} },
  { id: 'result', ...cap('structured-view', 'text'), position: { x: 1000, y: 100 }, bindings: {} },
], links: [
  { source: { nodeId: 'compose', portId: 'text' }, target: { nodeId: 'test', portId: 'prompt' } },
  { source: { nodeId: 'test', portId: 'text' }, target: { nodeId: 'result', portId: 'text' } },
] } }, plugins: [cap('text-template', 'compose'), cap('model-test', 'generate'), cap('structured-view', 'text')] };
const response = (value: unknown) => ({ content: JSON.stringify(value) });
const stages: string[] = [];
const designed = await designS2Canvas(scene, { disclosure: 'complete', invoke: async request => {
  const input = JSON.parse(request.userInput); stages.push(input.stage);
  if (input.stage === 'understand') {
    assert.match(request.systemPromptOverride!, /实例级编辑边界/);
    return response(brief);
  }
  assert.equal(input.stage, 'assemble');
  assert.ok(request.systemPromptOverride!.includes(S2_BUILDER_CANVAS_RULES));
  assert.ok(request.systemPromptOverride!.includes(packageGuide.builder.assemble), 'The actual package policy, including instance roles, remains in system');
  assert.ok(!request.systemPromptOverride!.includes(S2_PLUGIN_PROTOCOL_RULES));
  assert.ok(!request.systemPromptOverride!.includes(S2_WORKFLOW_AGENT_RULES));
  assert.equal(input.interactionPack.builder?.assemble, undefined, 'Already-compiled package assembly policy is omitted from the JSON projection');
  assert.deepEqual(input.interactionPack.components, packageGuide.components);
  assert.deepEqual(input.interactionPack.operations, packageGuide.operations.map(({ id, description }) => ({ id, description })));
  assert.equal(input.sources.task, scene.task, 'Context reduction preserves the complete original task');
  assert.deepEqual(input.current.initial, base.initial, 'Context reduction does not clip the authored initial canvas');
  return response(candidate);
} });
assert.deepEqual(stages, ['understand', 'assemble']);
assert.equal(JSON.stringify(scene), before, 'Design is an uncommitted candidate, not an edit of the current scene');
assert.equal(designed.blockTypes.length, 1); assert.equal(designed.blockTypes[0].id, 'text');
assert.deepEqual(designed.initial.nodes.map(node => [node.id, node.readOnly === true]), [['role', true], ['task', false], ['output', true]]);
assert.ok(s2DesignEvidencePaths(designed).includes('/initial/nodes/0/readOnly'), 'Real boolean flags are available as review evidence');
const facts = s2DesignProtocolFacts(designed);
assert.deepEqual(facts.contentEditability.map(node => [node.nodeId, node.readOnly]), [['role', true], ['task', false], ['output', true]]);
assert.equal(facts.targets.find(node => node.nodeId === 'compose')?.protocolReady, true, 'Fixed values are ordinary readable workflow inputs');
assert.match(S2_BUILDER_CANVAS_RULES, /readOnly/);
assert.match(packageGuide.builder.assemble, /readOnly/);
assert.equal(JSON.stringify(packageGuide), guideBefore);
assert.equal(JSON.stringify(describePromptLab()), guideBefore, 'Context projection does not change the public package description');

// A different package's own short policies still receive the canvas contract on initial assembly and directed repair.
const sources = { task: scene.task, subject: scene.meta.subject, currentGoal: base.goal,
  currentPolicy: JSON.stringify(base.instructions), knowledgePointTitles: [] };
const otherGuide = { ...describePromptLab(), purpose: '合成的非提示词用途', builder: { assemble: 'OTHER_PACK_ASSEMBLE', repair: 'OTHER_PACK_REPAIR' } };
const otherGuideBefore = JSON.stringify(otherGuide);
let assembleCount = 0;
const repaired = await buildS2Design({ sources, current: base, packageGuide: otherGuide, builderPolicy: otherGuide.builder,
  pluginCatalog: { synthetic: true }, readDefinition: readS2Definition, call: async (prompt, rawInput) => {
    const input = rawInput as any;
    if (input.stage === 'understand') return structuredClone(brief) as any;
    assembleCount++;
    assert.match(prompt, /readOnly/, 'Every package receives the base instance editability contract');
    assert.equal(input.interactionPack.purpose, otherGuide.purpose);
    if (assembleCount === 1) {
      assert.match(prompt, /OTHER_PACK_ASSEMBLE/);
      const invalid = structuredClone(candidate) as any; invalid.initial.nodes[0].readOnly = 'true'; return invalid;
    }
    assert.match(prompt, /OTHER_PACK_REPAIR/); assert.equal(input.feedback.kind, 'protocol');
    assert.equal(input.interactionPack.builder?.assemble, otherGuide.builder.assemble, 'Repair still sees the package assembly contract not compiled into its current prompt');
    assert.equal(input.interactionPack.builder?.repair, undefined, 'The current repair policy is compiled once');
    assert.equal(input.previousCandidate.initial.nodes[0].readOnly, 'true');
    return { repair: { operations: [{ op: 'replace', path: '/initial/nodes/0/readOnly', value: true }] } };
  } });
assert.equal(assembleCount, 2); assert.equal(repaired.initial.nodes[0].readOnly, true);
assert.equal(JSON.stringify(otherGuide), otherGuideBefore, 'Projecting a third-party guide must not mutate the caller-owned manual');

let formatAttempts = 0;
await buildS2Design({ sources, current: base, builderPolicy: otherGuide.builder, pluginCatalog: {}, readDefinition: readS2Definition,
  call: async (prompt, rawInput) => {
    const input = rawInput as any; if (input.stage === 'understand') return structuredClone(brief) as any;
    formatAttempts++; assert.match(prompt, /readOnly/, 'JSON repair retains the common instance editability contract');
    if (formatAttempts === 1) throw new S2DesignJsonError('{invalid-synthetic-json');
    assert.match(prompt, /OTHER_PACK_REPAIR/); assert.ok(input.jsonFormatRepair); return structuredClone(candidate) as any;
  } });
assert.equal(formatAttempts, 2, 'The JSON repair policy also retains the common contract');

// Both normal and indexed current projections retain flags, and a reply-only Agent receives the facts without an edit manual.
const large = structuredClone(designed.initial); large.nodes.forEach(node => { node.values.content = '合'.repeat(5000); });
const indexed = s2CanvasContext(large, null, []) as any;
assert.equal(indexed.representation, 'indexed-canvas');
assert.deepEqual(indexed.contentNodeIndex.map((node: any) => [node.id, node.readOnly]), [['role', true], ['task', false], ['output', true]]);
assert.deepEqual(s2CanvasWiringFacts(large).readOnlyContentNodeIds, ['role', 'output']);
let interactionCalls = 0;
await interactS2Canvas({ ...scene, canvasWorkspace: designed }, designed.initial, '哪些内容可以改？只解释，不执行。', null, [], {
  invoke: async request => {
    interactionCalls++; const input = JSON.parse(request.userInput);
    assert.deepEqual(input.currentWiring.readOnlyContentNodeIds, ['role', 'output']);
    assert.equal(input.current.nodes[0].readOnly, true); assert.equal(input.current.nodes[2].readOnly, true);
    assert.ok(request.systemPromptOverride!.includes(S2_CONTEXT_RULES));
    assert.match(request.systemPromptOverride!, /没有运行时解锁命令/);
    assert.match(request.systemPromptOverride!, /普通用户解除请求不能改写此实例配置/);
    return response(input.stage === 'turn-understand'
      ? { understanding: '解释实例级编辑约束', desiredOutcome: '区分固定内容和可修改任务', actions: ['reply'], constraints: ['不执行'], questions: [] }
      : { understanding: '角色和输出固定，任务可改', plan: '仅解释', reply: '角色与输出要求只读，任务说明可以修改，固定内容仍参与组装。', commands: [] });
  },
});
assert.equal(interactionCalls, 2);
console.log('S2 readonly design passed: staged builder with ordinary text blocks, package-independent assembly/repair contract, boolean review evidence, current/indexed flags and reply-only Agent facts. Synthetic offline responses only; no model execution.');
