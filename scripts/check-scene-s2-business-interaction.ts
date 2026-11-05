import assert from 'node:assert/strict';
import type { LlmCallRequest, LlmCallResponse } from '../src/types';
import type { S2CanvasDefinition, S2Document } from '../src/types/sceneS2';
import { createS2Scene, exportS2Workspace, importS2Workspace, interactS2Canvas, readS2Definition } from '../src/services/scene/sceneS2Canvas';
import { syntheticS2Business } from './fixtures/s2-business-model';

globalThis.fetch = async () => assert.fail('Offline business interaction fixture only; no real model, notes, profile or network');
const scene = createS2Scene({ source: 'custom', sceneSkill: 'S2', subject: 'Synthetic criteria collaboration', knowledgePoints: [], extraHints: '先解释或按指标核对，不自动修改与执行' });
const base: S2CanvasDefinition = { ...scene.canvasWorkspace!, initial: { nodes: [
  { id: 'prompt', type: 'text', position: { x: 0, y: 0 }, values: { content: '请只返回JSON，包含summary字段。' } },
  { id: 'result', type: 'text', position: { x: 200, y: 0 }, values: { content: '{"mode":"draft"}' } },
], edges: [] } };
const synthetic = syntheticS2Business(base);
synthetic.knowledge = [1, 2].map(index => ({ id: `Skill${index}`, title: `Synthetic business concept ${index}`, content: `KnowledgeBodyMarker${index}：区分格式与业务目标。` }));
synthetic.criteria = [
  { id: 'JsonInstruction', label: '格式约定', expectation: '当前提示词明确JSON格式要求', method: 'local', required: true,
    target: { nodeId: 'prompt', fieldId: 'content' }, rule: { kind: 'text-includes', value: '只返回JSON' } },
  { id: 'ResultValue', label: '本地精确值', expectation: '当前结果符合事先声明的固定值', method: 'local', required: true,
    target: { nodeId: 'result', fieldId: 'content' }, rule: { kind: 'json-pointer-equals', pointer: '/mode', value: 'HiddenLocalAnswerValue' } },
  { id: 'Clarity', label: '语义明确性', expectation: '格式及字段要求明确', method: 'semantic', required: true },
  { id: 'Style', label: '开放建议', expectation: '可以增加示例，不据此判断失败', method: 'advisory', required: false },
];
const definition = readS2Definition({ ...base, business: synthetic }, { requireBusiness: true });
const actualScene = { ...scene, canvasWorkspace: definition };
const initialSnapshot = JSON.stringify(definition);
const response = (value: unknown): LlmCallResponse => ({ content: JSON.stringify(value) } as LlmCallResponse);
const intent = (extra: Record<string, unknown> = {}) => ({ understanding: '根据真实表达解释或核对', desiredOutcome: '仅回应，不自动改图执行', actions: ['reply'], constraints: ['不运行'], questions: [], ...extra });
const reply = (extra: Record<string, unknown> = {}) => ({ understanding: '已理解本轮要求', plan: '只解释或核对所选指标', reply: '合成回应，不是实际模型质量证据。', commands: [], ...extra });
const judgment = (criterionId: string, verdict: 'met' | 'unmet' | 'uncertain', evidence: unknown[] = [], reason = '合成评价原文比对，不声称实际执行') => ({ criterionId, verdict, reason, evidence });
const evidence = { sourceId: 'field:prompt:content', quote: '只返回JSON，包含summary字段' };
type Invoke = (request: LlmCallRequest) => Promise<LlmCallResponse>;
function assertNoPrivateLeak(request: LlmCallRequest) {
  const input = JSON.parse(request.userInput);
  for (const marker of ['PrivateSyntheticAnswer', 'Synthetic solution; private protocol fixture only', 'HiddenLocalAnswerValue']) {
    assert.ok(!request.userInput.includes(marker), `Runtime ${input.stage} cannot disclose ${marker}`);
  }
  assert.equal(input.businessSkill.completion.reference, undefined);
  assert.equal(input.businessSkill.completion.targetNodeIds, undefined);
  assert.equal(input.businessSkill.completion.executed, false);
  assert.equal(input.businessSkill.completion.businessSuccess, 'not-assessed');
  assert.ok(input.businessSkill.criteria.every((criterion: object) => !Object.hasOwn(criterion, 'rule')));
  return input;
}

let plainCalls = 0;
const plain = await interactS2Canvas(actualScene, definition.initial, '举一个形象例子，暂时不检查也不运行', 'prompt', [], {
  invoke: async request => {
    plainCalls++; const input = assertNoPrivateLeak(request);
    assert.deepEqual(input.businessSkill.knowledge, []);
    assert.ok(!request.userInput.includes('KnowledgeBodyMarker'));
    if (input.stage === 'turn-understand') return response(intent());
    assert.equal(input.stage, 'turn-act'); assert.equal(input.responseRepair, undefined);
    return response(reply());
  },
});
assert.equal(plainCalls, 2); assert.deepEqual(plain.commands, []); assert.equal(plain.assessment, undefined);
assert.equal(plain.pluginRequests, undefined); assert.equal(plain.executionRequest, undefined);
assert.ok(!plain.reply.includes('指标比对'), 'Ordinary conversation is not forced into evaluation or a teaching stage');

let skillCalls = 0;
await interactS2Canvas(actualScene, definition.initial, '解释第二个业务概念，不改图', 'prompt', [], { invoke: async request => {
  skillCalls++; const input = assertNoPrivateLeak(request);
  assert.ok(!request.userInput.includes('KnowledgeBodyMarker1'));
  if (input.stage === 'turn-understand') {
    assert.equal(input.businessSkill.knowledgeIndex.length, 2); assert.deepEqual(input.businessSkill.knowledge, []);
    assert.ok(!request.userInput.includes('KnowledgeBodyMarker2')); return response(intent({ skillIds: ['Skill2'] }));
  }
  assert.equal(input.stage, 'turn-act'); assert.deepEqual(input.businessSkill.knowledge.map((item: { id: string }) => item.id), ['Skill2']);
  assert.ok(request.userInput.includes('KnowledgeBodyMarker2')); return response(reply());
} });
assert.equal(skillCalls, 2, 'On-demand skill reading reuses understand/action without extra model stages or tools');
let invalidSkillCalls = 0;
await assert.rejects(() => interactS2Canvas(actualScene, definition.initial, '解释一个不存在的概念', null, [], { invoke: async request => {
  invalidSkillCalls++; assert.equal(JSON.parse(request.userInput).stage, 'turn-understand'); return response(intent({ skillIds: ['UnknownSkill'] }));
} }), /不存在/);
assert.equal(invalidSkillCalls, 1, 'Unknown skills do not become a fabricated tool read or permission grant');

async function assess(raw: unknown, document: S2Document = definition.initial, suppliedDefinition = definition) {
  const stages: string[] = [];
  const invoke: Invoke = async request => {
    const input = JSON.parse(request.userInput); stages.push(input.stage);
    if (input.businessSkill) assertNoPrivateLeak(request);
    if (input.stage === 'turn-understand') return response(intent());
    assert.equal(input.stage, 'turn-act'); assert.equal(input.responseRepair, undefined);
    return response(reply({ assessment: raw }));
  };
  const result = await interactS2Canvas({ ...scene, canvasWorkspace: suppliedDefinition }, document, '只按选中的标准核对，并可给建议，不运行', 'prompt', [], { invoke });
  assert.deepEqual(stages, ['turn-understand', 'turn-act']); return result;
}
const local = await assess({ criterionIds: ['JsonInstruction', 'ResultValue'], judgments: [judgment('JsonInstruction', 'unmet'), judgment('ResultValue', 'met')] });
assert.deepEqual(local.assessment!.checks.map(check => check.verdict), ['met', 'unmet'], 'Local criteria use actual current fields, not the model assertions');
assert.equal(local.assessment!.overall, 'unmet'); assert.equal(local.assessment!.scope, 'selected-criteria-only');
assert.deepEqual(local.assessment!.omittedCriterionIds, ['Clarity', 'Style']);
assert.match(local.reply, /本地核对/); assert.match(local.reply, /不代表整场景完成/);
assert.deepEqual(local.commands, []); assert.equal(local.executionRequest, undefined);
const semantic = await assess({ criterionIds: ['Clarity', 'Style'], judgments: [judgment('Clarity', 'met', [evidence]), judgment('Style', 'unmet', [], '建议加个例子，不作为失败')] });
assert.equal(semantic.assessment!.overall, 'met'); assert.equal(semantic.assessment!.checks.length, 1);
assert.equal(semantic.assessment!.checks[0].method, 'semantic'); assert.deepEqual(semantic.assessment!.checks[0].evidence, [evidence]);
assert.equal(semantic.assessment!.advice.length, 1); assert.match(semantic.reply, /语义判断/); assert.match(semantic.reply, /建议/);
const advisory = await assess({ criterionIds: ['Style'], judgments: [judgment('Style', 'unmet')] });
assert.equal(advisory.assessment!.overall, 'advisory'); assert.deepEqual(advisory.assessment!.checks, []);

const deleted: S2Document = { nodes: [], edges: [] };
const deletedResult = await assess({ criterionIds: ['JsonInstruction'] }, deleted);
assert.equal(deletedResult.assessment!.overall, 'uncertain'); assert.match(deletedResult.reply, /待确认/);
const persistedText = exportS2Workspace(definition, deleted), restored = importS2Workspace(persistedText);
assert.deepEqual(restored.initial, deleted); assert.equal(restored.business!.criteria[0].target!.nodeId, 'prompt');
assert.equal(restored.business!.completion.reference.nodes[0].id, 'PrivateSyntheticAnswer', 'Saving keeps design guidance without forcing the private reference into the user canvas');
const afterSave = await assess({ criterionIds: ['JsonInstruction'] }, restored.initial, restored);
assert.equal(afterSave.assessment!.overall, 'uncertain', 'Saved missing targets are not invented or permanently marked complete');

async function checkBoundedRepair(badAssessment: unknown, suppliedDefinition = definition, origin: 'user' | 'host-event' = 'user') {
  const stages: string[] = []; let actionCalls = 0;
  const result = await interactS2Canvas({ ...scene, canvasWorkspace: suppliedDefinition }, suppliedDefinition.initial, '先核对，如果没有标准就给建议', null, [], {
    origin,
    invoke: async request => {
      const input = JSON.parse(request.userInput); stages.push(input.stage);
      if (input.stage === 'turn-understand') return response(intent());
      actionCalls++;
      if (actionCalls === 1) return response(reply({ assessment: badAssessment }));
      assert.ok(input.responseRepair); assert.ok(input.responseRepair.error);
      assert.deepEqual(input.intent.actions, ['reply'], 'Repair cannot expand frozen user intention');
      assert.deepEqual(input.responseRepair.previousOutput.assessment, badAssessment);
      return response(reply({ reply: '现有信息不足，仅提供建议；未评价为完成。' }));
    },
  });
  assert.deepEqual(stages, ['turn-understand', 'turn-act', 'turn-act']); assert.equal(result.assessment, undefined);
  assert.deepEqual(result.commands, []); assert.equal(result.executionRequest, undefined); return result;
}
await checkBoundedRepair({ criterionIds: ['UnknownCriterion'] });
await checkBoundedRepair({ criterionIds: ['Clarity'], judgments: [judgment('Clarity', 'met', [{ ...evidence, quote: '拼接…原文不存在' }])] });
await checkBoundedRepair({ criterionIds: ['Clarity'], judgments: [judgment('Clarity', 'met', [{ sourceId: 'query', quote: '先核对' }])] }, definition, 'host-event');
const { business: _business, ...legacy } = definition;
await checkBoundedRepair({ criterionIds: ['JsonInstruction'] }, legacy);
let repeatedBadCalls = 0;
await assert.rejects(() => interactS2Canvas(actualScene, definition.initial, '核对格式', 'prompt', [], { invoke: async request => {
  repeatedBadCalls++; if (JSON.parse(request.userInput).stage === 'turn-understand') return response(intent());
  return response(reply({ assessment: { criterionIds: ['UnknownCriterion'] } }));
} }), /未知指标/);
assert.equal(repeatedBadCalls, 3, 'Invalid assessment shares exactly one existing response repair, without an unbounded scoring retry');
assert.equal(JSON.stringify(definition), initialSnapshot, 'Conversations, assessments, saving and repairs never mutate the original scene');
console.log('S2 business interaction passed: real production understand/action hooks with deterministic stubs, on-demand skill context and private-answer exclusion, optional current-field assessment, genuine semantic quotes, advisory separation, missing-target save/reload, bounded existing response repair and no graph/tool/completion mutation. Offline synthetic evidence only; not model accuracy or browser E2E.');
