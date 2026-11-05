// Fixed synthetic replies below intentionally test complete-catalogue compatibility, not progressive discovery.
import assert from 'node:assert/strict';
import type { S2CanvasDefinition, S2DesignBrief } from '../src/types/sceneS2';
import { createS2Scene, designS2Canvas, exportS2Subgraph, exportS2Workspace, importS2Workspace, interactS2Canvas, readS2Definition, readS2Scene } from '../src/services/scene/sceneS2Canvas';
import { readS2Criteria, s2Criteria } from '../src/services/scene/sceneS2Business';
import { syntheticS2Business } from './fixtures/s2-business-model';
import { applyS2DesignRepair } from '../src/services/scene/sceneS2DesignRepair';
import { S2_BUILDER_CANVAS_RULES } from '../src/services/scene/sceneS2BuildContext';
import { S2_PLUGIN_PROTOCOL_RULES } from '../src/services/scene/sceneS2PluginProtocol';
import { S2_WORKFLOW_AGENT_RULES } from '../src/services/scene/sceneS2Workflow';
import { describePromptLab } from '../src/interaction-packs/prompt-lab/description';

globalThis.fetch = async () => assert.fail('Offline lightweight S2 checks never call models or personal sources');
const scene = createS2Scene({ source: 'custom', sceneSkill: 'S2', subject: '合成提示词实验', knowledgePoints: [],
  interactionPack: { id: 'prompt-lab', version: '0.1.0' },
  extraHints: '用户自行编辑和运行，可选择求助；提供完整的本地实验，不要求留白。' });
const base = readS2Scene(scene), original = JSON.stringify(scene);
const packageGuide = describePromptLab(), guideBefore = JSON.stringify(packageGuide);
const brief: S2DesignBrief = { goal: '由用户主导的实验', requirements: [{ id: 'Experiment', description: '普通画布操作不依赖助手', source: 'task', quote: '用户自行编辑和运行' }],
  userRole: '修改、连接、运行、观察', agentRole: '可选解释与分析', assumptions: [], openQuestions: [],
  delivery: { initial: '完整本地实验', deferred: '无', source: 'task', quote: '提供完整的本地实验，不要求留白' } };
const criteria: NonNullable<S2CanvasDefinition['criteria']> = [{ id: 'Clear', label: '表达要求', expectation: '包含合成提示词实验', method: 'local', required: true,
  target: { nodeId: 'goal', fieldId: 'content' }, rule: { kind: 'text-includes', value: '合成提示词实验' } }];
const candidate = { ...base, criteria };
const response = (value: unknown) => ({ content: JSON.stringify(value) });
const stages: string[] = [];
const built = await designS2Canvas(scene, { disclosure: 'complete', invoke: async request => {
  const input = JSON.parse(request.userInput); stages.push(input.stage);
  if (input.stage === 'understand') return response(brief);
  assert.equal(input.stage, 'assemble', 'No default independent model reviewer');
  assert.ok(request.systemPromptOverride!.includes(S2_BUILDER_CANVAS_RULES), 'Assembly receives the common declarative canvas contract');
  assert.ok(request.systemPromptOverride!.includes(packageGuide.builder.assemble), 'The current package-owned business policy is compiled intact');
  assert.ok(!request.systemPromptOverride!.includes(S2_PLUGIN_PROTOCOL_RULES));
  assert.ok(!request.systemPromptOverride!.includes(S2_WORKFLOW_AGENT_RULES), 'Assembly does not compile the interaction dispatch/queue manual');
  assert.equal(input.interactionPack.builder?.assemble, undefined, 'The already-compiled assembly policy is not repeated in JSON');
  assert.deepEqual(input.interactionPack.components, packageGuide.components);
  assert.deepEqual(input.interactionPack.combinations, packageGuide.combinations);
  assert.deepEqual(input.interactionPack.operations, packageGuide.operations.map(({ id, description }) => ({ id, description })));
  assert.equal(input.sources.task, scene.task, 'The original request stays complete after removing protocol repetitions');
  assert.deepEqual(input.current.initial, base.initial);
  assert.ok(!request.systemPromptOverride!.includes('新搭建还必须提供根字段business'));
  return response(candidate);
} });
assert.deepEqual(stages, ['understand', 'assemble']); assert.equal(built.business, undefined);
assert.equal(JSON.stringify(packageGuide), guideBefore, 'Stage projection does not mutate the public package guide');
assert.equal(JSON.stringify(describePromptLab()), guideBefore, 'The public describe contract retains the complete guide');
const reviewedStages: string[] = [];
await designS2Canvas(scene, { disclosure: 'complete', review: true, invoke: async request => {
  const input = JSON.parse(request.userInput); reviewedStages.push(input.stage);
  if (input.stage === 'understand') return response(brief);
  if (input.stage === 'assemble') return response(candidate);
  assert.equal(input.candidate.business, undefined, 'Independent acceptance does not require a legacy proof package');
  return response({ verdict: 'accept', coverage: [{ requirementId: 'Experiment', status: 'covered', evidencePaths: ['/instructions/response'], reason: 'Synthetic source-backed public strategy' }], factChecks: [], feedback: 'Synthetic review only' });
} });
assert.deepEqual(reviewedStages, ['understand', 'assemble', 'review']);
assert.deepEqual(s2Criteria(built), criteria); assert.equal(JSON.stringify(scene), original);
assert.deepEqual(importS2Workspace(exportS2Workspace(built, built.initial)), built);
assert.equal(JSON.parse(exportS2Subgraph(built, built.initial, ['goal'])).definition.criteria, undefined, 'Scene expectations are not fragment requirements');
const blank = structuredClone(candidate); blank.initial.nodes[0].values.content = '';
assert.ok(readS2Definition(blank), 'A real editable empty input does not require a private completion witness');
assert.throws(() => readS2Definition({ ...candidate, criteria: [{ ...criteria[0], target: { nodeId: 'missing', fieldId: 'content' } }] }, { strictTargets: true }), /真实内容字段/);
const deleted = { ...candidate, initial: { nodes: [], edges: [] } };
assert.deepEqual(importS2Workspace(exportS2Workspace(deleted, deleted.initial)).criteria, criteria, 'Later deletion preserves expectations as uncertain instead of locking save');
assert.deepEqual(readS2Criteria(criteria, candidate), criteria);
const legacyBusiness = syntheticS2Business(base, brief); legacyBusiness.criteria = structuredClone(criteria);
const legacy = readS2Definition({ ...base, business: legacyBusiness });
assert.deepEqual(s2Criteria(legacy), criteria);
await designS2Canvas({ ...scene, canvasWorkspace: legacy }, { disclosure: 'complete', invoke: async request => {
  const input = JSON.parse(request.userInput); if (input.stage === 'understand') return response(brief);
  assert.equal(input.current.business, undefined, 'A legacy private answer graph is not repeated in a new default design');
  assert.deepEqual(input.current.criteria, criteria); return response(candidate);
} });
assert.deepEqual(readS2Definition({ ...legacy, criteria }).business, legacyBusiness, 'Matching root and legacy declarations are both preserved');
assert.throws(() => readS2Definition({ ...legacy, criteria: [{ ...criteria[0], expectation: '另一套期望' }] }), /冲突/);
assert.deepEqual(applyS2DesignRepair(base, { repair: { operations: [{ op: 'add', path: '/criteria', value: criteria }] } }).criteria, criteria);
let repairs = 0;
await designS2Canvas(scene, { disclosure: 'complete', invoke: async request => {
  const input = JSON.parse(request.userInput); if (input.stage === 'understand') return response(brief);
  repairs++; if (repairs === 1) return response({ ...candidate, plugins: [{ pluginId: 'nonexistent', pluginVersion: '1.0.0', capabilityId: 'unknown' }] });
  assert.equal(input.feedback.kind, 'protocol'); assert.equal(input.repairContext.businessDesignIssues, undefined);
  assert.deepEqual(input.previousCandidate.initial, candidate.initial); return response(candidate);
} });
assert.equal(repairs, 2, 'One directed repair, with no model review');
let sharedRepairs = 0;
await assert.rejects(() => designS2Canvas(scene, { disclosure: 'complete', invoke: async request => {
  sharedRepairs++; const input = JSON.parse(request.userInput);
  if (input.stage === 'understand') return response(sharedRepairs === 1 ? {} : brief);
  return response({ ...candidate, version: 99 });
} }), /未通过本地校验/);
assert.equal(sharedRepairs, 3, 'Understanding repair and assembly repair share a single default allowance');

const discussion = { understanding: '仅解释结果', desiredOutcome: '理解实验', actions: ['reply'], constraints: [], questions: [] };
const answer = { understanding: '结果分析', plan: '只读', reply: '这是本次实验的反馈。', commands: [], pluginRequests: [] };
const runtimeScene = { ...scene, canvasWorkspace: built };
const assessed = await interactS2Canvas(runtimeScene, built.initial, '核对当前指标', null, [], { invoke: async request => {
  const input = JSON.parse(request.userInput);
  assert.deepEqual(input.criteria.map((item: any) => item.id), ['Clear']); assert.equal(input.businessSkill, undefined);
  assert.equal(input.criteria[0].rule, undefined, 'Private local answer rules are not model context');
  return response(input.stage === 'turn-understand' ? { ...discussion, evaluation: 'criteria' }
    : { ...answer, assessment: { criterionIds: ['Clear'] } });
} });
assert.equal(assessed.assessment?.checks[0].verdict, 'met', 'Root criteria use the existing locally recomputed evaluator');
for (const injection of [
  { commands: [{ op: 'update-node', id: 'goal', values: { content: 'UNAUTHORIZED' } }] },
  { pluginRequests: [{ nodeId: 'fake' }] },
  { executionRequest: { targetNodeIds: ['fake'], reason: 'UNAUTHORIZED' } },
]) {
  let actionCalls = 0;
  await assert.rejects(() => interactS2Canvas(runtimeScene, built.initial, '本地宿主完成通知', null, [], { origin: 'host-event', invoke: async request => {
    const input = JSON.parse(request.userInput);
    assert.ok(!request.systemPromptOverride!.includes('S2自由组合规则'));
    assert.ok(!request.systemPromptOverride!.includes('S2插件协议v1'), 'Readonly service never compiles dispatch instructions');
    if (input.stage === 'turn-understand') return response({ ...discussion, actions: ['reply', 'edit', 'execute'] });
    actionCalls++; assert.deepEqual(input.intent.actions, ['reply'], 'Host origin overrides untrusted semantic actions');
    return response({ ...answer, ...injection });
  } }), /只读/);
  assert.equal(actionCalls, 2, 'One response-format repair does not broaden read-only authority');
  assert.equal(JSON.stringify(scene), original); assert.deepEqual(built.initial, candidate.initial);
}
const plain = await interactS2Canvas(runtimeScene, built.initial, '本地宿主完成通知', null, [], { origin: 'host-event', invoke: async request =>
  response(JSON.parse(request.userInput).stage === 'turn-understand' ? { ...discussion, actions: ['reply', 'edit', 'execute'] } : answer) });
assert.deepEqual(plain.commands, []); assert.equal(plain.executionRequest, undefined);
console.log('S2 lightweight design passed: two-stage default, optional root criteria with legacy conflict checks, editable blanks/full experiments without witnesses, one shared repair, save/fragment compatibility, existing local assessment and hard readonly host-result boundary. Offline synthetic protocol checks only.');
