import assert from 'node:assert/strict';
import type { LlmCallRequest, LlmCallResponse } from '../src/types';
import type { S2CanvasDefinition } from '../src/types/sceneS2';
import { createS2Scene, interactS2Canvas, readS2Definition } from '../src/services/scene/sceneS2Canvas';
import { syntheticS2Business } from './fixtures/s2-business-model';

globalThis.fetch = async () => assert.fail('Offline evaluation-intent protocol test only; no model, credentials, notes, profile or network');
const scene = createS2Scene({ source: 'custom', sceneSkill: 'S2', subject: 'Synthetic optional evaluation intent', knowledgePoints: [],
  extraHints: '教学由Agent按表达决定；正式指标须结构比对，普通建议不评分，所有图与运行仍单独授权。' });
const base: S2CanvasDefinition = { ...scene.canvasWorkspace!, initial: { nodes: [
  { id: 'Current', type: 'text', position: { x: 0, y: 0 }, values: { content: '当前合成原文：技术执行成功不能直接证明业务条件合格。' } },
], edges: [] } };
const business = syntheticS2Business(base);
business.criteria = [
  { id: 'Local', label: '本地预定值', expectation: '按已声明固定规则核对当前字段', method: 'local', required: true,
    target: { nodeId: 'Current', fieldId: 'content' }, rule: { kind: 'text-includes', value: 'PrivateRuleNotInCurrent' } },
  { id: 'Semantic', label: '语义区别', expectation: '当前字段区分技术执行与业务合格', method: 'semantic', required: true,
    target: { nodeId: 'Current', fieldId: 'content' } },
  { id: 'Advice', label: '开放建议', expectation: '可增加例子，不据此判失败', method: 'advisory', required: false },
];
const definition = readS2Definition({ ...base, business }, { requireBusiness: true });
const noCriteria = readS2Definition({ ...definition, business: { ...definition.business!, criteria: [] } });
const { business: _business, ...legacy } = definition;
const original = JSON.stringify(definition);
const response = (raw: unknown): LlmCallResponse => ({ content: JSON.stringify(raw) } as LlmCallResponse);
const plain = () => ({ understanding: '合成语义摘要', plan: '仅回应，不改图不运行', reply: '这是确定性协议测试，只解释或按已声明标准核对，不证明实际模型语义能力。', commands: [] });
const formal = () => ({ ...plain(), assessment: { criterionIds: ['Local', 'Semantic', 'Advice'], judgments: [
  { criterionId: 'Local', verdict: 'met', reason: '故意错误的模型local结论，必须由host重算', evidence: [] },
  { criterionId: 'Semantic', verdict: 'met', reason: '当前原文明确区分技术与业务', evidence: [{ sourceId: 'field:Current:content', quote: '技术执行成功不能直接证明业务条件合格' }] },
  { criterionId: 'Advice', verdict: 'unmet', reason: '可以再给一个例子；只是建议，不判失败', evidence: [] },
] } });
const advisory = () => ({ ...plain(), assessment: { criterionIds: ['Advice'], judgments: [
  { criterionId: 'Advice', verdict: 'unmet', reason: '可增加生活化例子，不进行正式评分', evidence: [] },
] } });
function assertPrivateBoundary(request: LlmCallRequest) {
  for (const marker of ['PrivateRuleNotInCurrent', 'PrivateSyntheticAnswer', 'Synthetic solution; private protocol fixture only']) {
    assert.ok(!request.userInput.includes(marker), `Runtime ${marker} must remain private`);
  }
  const input = JSON.parse(request.userInput);
  if (input.businessSkill) {
    assert.equal(input.businessSkill.completion.reference, undefined);
    assert.equal(input.businessSkill.completion.targetNodeIds, undefined);
    assert.ok(input.businessSkill.criteria.every((item: object) => !Object.hasOwn(item, 'rule')));
  }
  return input;
}
async function call(options: { evaluation?: unknown; assistance?: unknown; replies: unknown[]; supplied?: S2CanvasDefinition; query?: string }) {
  const supplied = options.supplied ?? definition, stages: string[] = [], repairs: unknown[] = [], actionIntents: any[] = [];
  let actions = 0, calls = 0;
  const pending = interactS2Canvas({ ...scene, canvasWorkspace: supplied }, supplied.initial, options.query ?? '请按我的本轮表达决定只给建议还是按标准比对，不改图、不运行。', 'Current', [], {
    invoke: async request => {
      calls++; const input = assertPrivateBoundary(request); stages.push(input.stage);
      if (input.stage === 'turn-understand') {
        assert.match(request.systemPromptOverride!, /教学约束和本轮表达理解求助深度/);
        assert.match(request.systemPromptOverride!, /协作意图根据自然语言语义识别，不要求用户说出/);
        assert.match(request.systemPromptOverride!, /assistance明确本轮帮助深度/);
        return response({ understanding: '由语义Agent选择，不由程序关键词匹配', desiredOutcome: '只回应或比对明确指标',
        actions: ['reply'], constraints: ['不改图', '不运行'], questions: [],
        ...(Object.hasOwn(options, 'evaluation') ? { evaluation: options.evaluation } : {}),
        ...(Object.hasOwn(options, 'assistance') ? { assistance: options.assistance } : {}) });
      }
      assert.equal(input.stage, 'turn-act', 'No extra model stage, review or executor for these read-only responses');
      assert.match(request.systemPromptOverride!, /存在“先提示\/举例、不直接给完整方案、由用户补齐”等仍有效要求时/);
      assert.match(request.systemPromptOverride!, /用户明确要看答案、完整示范或协作时可按真实语义调整帮助深度，无需固定词句或口令/);
      assert.ok(!request.systemPromptOverride!.includes('tableview.table'), 'Generic tutoring guidance must not embed the validation case answer');
      assert.equal(input.intent.assistance, options.assistance, 'The parsed semantic help-depth choice reaches the action unchanged');
      if (options.assistance === 'scaffold') {
        assert.match(request.systemPromptOverride!, /本轮帮助深度：提示/);
        assert.ok(!request.systemPromptOverride!.includes('本轮帮助深度：示范'));
      } else if (options.assistance === 'demonstrate') {
        assert.match(request.systemPromptOverride!, /本轮帮助深度：示范/);
        assert.ok(!request.systemPromptOverride!.includes('本轮帮助深度：提示'));
      } else {
        assert.ok(!request.systemPromptOverride!.includes('本轮帮助深度：提示') && !request.systemPromptOverride!.includes('本轮帮助深度：示范'),
          'Omitted help-depth remains compatible and does not force a teaching stage');
      }
      actions++; actionIntents.push(structuredClone(input.intent));
      if (input.responseRepair) {
        repairs.push(structuredClone(input.responseRepair)); assert.equal(actions, 2, 'Exactly the existing one action repair allowance');
        assert.deepEqual(input.intent.actions, ['reply'], 'Evaluation repair does not broaden action permission');
        assert.deepEqual(input.responseRepair.previousOutput, options.replies[0], 'Repair sees actual failed output rather than an invented replacement');
      }
      return response(options.replies[Math.min(actions - 1, options.replies.length - 1)]);
    },
  });
  return { pending, count: () => ({ calls, actions, stages, repairs, actionIntents }) };
}
async function accepted(options: Parameters<typeof call>[0], expectedCalls: number) {
  const run = await call(options), result = await run.pending;
  assert.equal(run.count().calls, expectedCalls); assert.deepEqual(result.commands, []);
  assert.equal(result.executionRequest, undefined); assert.equal(result.pluginRequests?.length ?? 0, 0);
  assert.equal(JSON.stringify(definition), original, 'Intent selection, scoring and repairs never mutate original graph/definition');
  return { result, ...run.count() };
}
async function rejected(options: Parameters<typeof call>[0], expectedCalls: number) {
  const run = await call(options); await assert.rejects(run.pending);
  assert.equal(run.count().calls, expectedCalls); return run.count();
}

const criteria = await accepted({ evaluation: 'criteria', replies: [formal()] }, 2);
assert.equal(criteria.result.assessment?.overall, 'unmet');
assert.equal(criteria.result.assessment?.checks.find(item => item.method === 'local')?.verdict, 'unmet', 'Formal intent still cannot override host-computed local rule');
assert.equal(criteria.result.assessment?.advice.length, 1);
assert.equal(criteria.actionIntents[0].evaluation, 'criteria');
const missing = await accepted({ evaluation: 'criteria', replies: [plain(), formal()] }, 3);
assert.deepEqual(missing.stages, ['turn-understand', 'turn-act', 'turn-act']); assert.equal(missing.repairs.length, 1);
assert.match((missing.repairs[0] as { error: string }).error, /assessment|评价|指标/i);
assert.equal(missing.result.assessment?.scope, 'selected-criteria-only');
assert.deepEqual(missing.actionIntents[0], missing.actionIntents[1], 'Retry freezes semantic evaluation decision and action boundary');
const repeatedMissing = await rejected({ evaluation: 'criteria', replies: [plain()] }, 3);
assert.equal(repeatedMissing.repairs.length, 1, 'Repeated missing assessment cannot trigger a new retry loop');
const formalNotEvaded = await accepted({ evaluation: 'criteria', replies: [advisory(), formal()] }, 3);
assert.equal(formalNotEvaded.result.assessment?.checks.length, 2, 'When formal criteria exist, advisory-only output cannot pretend to be the requested formal comparison');
await rejected({ evaluation: 'criteria', replies: [advisory()] }, 3);

const plainAdvice = await accepted({ evaluation: 'advice', replies: [plain()] }, 2); assert.equal(plainAdvice.result.assessment, undefined);
const structuredAdvice = await accepted({ evaluation: 'advice', replies: [advisory()] }, 2);
assert.equal(structuredAdvice.result.assessment?.overall, 'advisory'); assert.deepEqual(structuredAdvice.result.assessment?.checks, []);
const repairedAdvice = await accepted({ evaluation: 'advice', replies: [formal(), advisory()] }, 3);
assert.equal(repairedAdvice.result.assessment?.overall, 'advisory'); assert.equal(repairedAdvice.repairs.length, 1);
assert.deepEqual(repairedAdvice.actionIntents[0], repairedAdvice.actionIntents[1], 'Pausing formal evaluation remains frozen through response repair');
await rejected({ evaluation: 'advice', replies: [formal()] }, 3);

// Neither the program nor this protocol turns keywords in user text into a fixed evaluation workflow.
const legacyPlain = await accepted({ query: '现在正式评价并评分', replies: [plain()] }, 2);
assert.equal(legacyPlain.result.assessment, undefined, 'Omitted flag keeps old plain-response compatibility even with scoring words in query');
const selectedByAgent = await accepted({ query: '举一个例子', evaluation: 'criteria', replies: [plain(), formal()] }, 3);
assert.ok(selectedByAgent.result.assessment, 'The semantic Agent flag, not program keyword scanning, activates the structure requirement');
const legacyFormal = await accepted({ replies: [formal()] }, 2); assert.ok(legacyFormal.result.assessment, 'Old optional assessment remains valid without new intent flag');
const scaffoldFormal = await accepted({ assistance: 'scaffold', evaluation: 'criteria', replies: [formal()] }, 2);
assert.equal(scaffoldFormal.result.assessment?.checks.length, 2, 'Hint depth must not block explicitly requested metric comparison or its evidence');

// These deterministic stubs check prompt compilation/selection, not whether a real
// model correctly infers or follows help depth. Identical queries deliberately
// carry different semantic flags: the host must not classify using keywords.
for (const assistance of ['scaffold', 'demonstrate'] as const) {
  const selectedDepth = await accepted({ query: '我现在需要一点帮助。', assistance, evaluation: 'advice', replies: [plain()] }, 2);
  assert.equal(selectedDepth.actionIntents[0].assistance, assistance); assert.equal(selectedDepth.repairs.length, 0);
}
for (const { query, assistance } of [
  { query: '先给我一个定位方向，别直接解完。', assistance: 'scaffold' },
  { query: '让我直接看一个完整示范，但别动我的画布。', assistance: 'demonstrate' },
]) {
  const naturalRequest = await accepted({ query, assistance, evaluation: 'advice', replies: [plain()] }, 2);
  assert.equal(naturalRequest.repairs.length, 0, 'Natural requests need no fixed collaboration password or forced workflow stage');
}
const compatibleDepth = await accepted({ query: '完整示范只提示举例等字样不应成为程序开关。', replies: [plain()] }, 2);
assert.equal(compatibleDepth.actionIntents[0].assistance, undefined, 'Missing optional help-depth never invokes local keyword classification');

for (const supplied of [noCriteria, legacy]) {
  const noStandard = await accepted({ supplied, evaluation: 'criteria', replies: [plain()] }, 2);
  assert.equal(noStandard.result.assessment, undefined, 'No declared criteria means explain the lack of standards, not manufacture formal assessment');
  const noStandardRepair = await accepted({ supplied, evaluation: 'criteria', replies: [formal(), plain()] }, 3);
  assert.equal(noStandardRepair.result.assessment, undefined, 'Undeclared assessments still use only the existing response repair');
}
for (const evaluation of ['formal', 'score', '', null, true, ['criteria'], { mode: 'criteria' }]) {
  const invalid = await rejected({ evaluation, replies: [plain()] }, 1);
  assert.equal(invalid.actions, 0, 'Illegal enum must stop before action/model tools');
}
for (const assistance of ['hint', 'answer', '', null, true, ['scaffold'], { mode: 'demonstrate' }]) {
  const invalid = await rejected({ assistance, replies: [plain()] }, 1);
  assert.equal(invalid.actions, 0, 'Illegal help-depth enum stops immediately after understanding, without a new repair/review stage');
}
for (const unauthorized of [
  { ...formal(), commands: [{ op: 'update-node', id: 'Current', values: { content: 'Unauthorized replacement' } }] },
  { ...formal(), executionRequest: { targetNodeIds: ['InventedTarget'], reason: 'Formal intent is not tool authority' } },
  { ...formal(), pluginRequests: [{ nodeId: 'InventedTarget', pluginId: 'external', pluginVersion: '1.0.0', capabilityId: 'experiment', inputs: {}, reason: 'Formal intent is not plugin authority' }] },
]) {
  const bounded = await accepted({ assistance: 'demonstrate', evaluation: 'criteria', replies: [unauthorized, formal()] }, 3);
  assert.equal(bounded.repairs.length, 1); assert.deepEqual(bounded.actionIntents[1].actions, ['reply']);
  assert.equal(bounded.actionIntents[1].assistance, 'demonstrate', 'Demonstration depth is preserved through repair, never promoted to edit/execute authority');
  assert.equal(bounded.result.assessment?.checks.length, 2);
}
console.log('S2 optional semantic evaluation/help-depth intent passed: criteria requires actual structured declared assessment through the existing one action repair; repeated absence rejects; advice accepts plain/advisory-only and repairs formal scores; optional scaffold/demonstrate is passed unchanged and compiles only the selected guidance, including identical queries with different semantic flags; omitted flags remain compatible; absent standards never force or invent assessment; Agent choice not program keyword classification; invalid enums stop before action; evaluation/help depth never grant edits/execution/plugins or leak private rules/reference. Offline deterministic protocol tests only, no real-model semantics or browser/full-chain acceptance.');
