import assert from 'node:assert/strict';
import {
  applyMasteryShadowObservations,
  buildMasteryShadowEvaluationRequest,
  MasteryShadowEvaluationInput,
  parseMasteryShadowEvaluation,
  projectMasteryShadow,
  runMasteryShadowEvaluation,
} from '../src/services/masteryShadow/index.ts';

const input: MasteryShadowEvaluationInput = {
  evaluationId: 'eval-1',
  knowledgePointId: 'kp-confirmation-bias',
  knowledgePointTitle: '确认偏误',
  occurredAt: '2026-10-18T08:00:00.000Z',
  source: 'quick_check',
  assistance: 'independent',
  strength: 'targeted',
  task: {
    prompt: '为什么只寻找支持自己观点的资料会造成判断偏差？请说明概念并解释推理。',
    responseType: 'open',
    requiredLayers: ['concept', 'reasoning'],
    criterionIds: ['concept_accuracy', 'reasoning_relevance', 'reasoning_sufficiency'],
  },
  answer:
    '确认偏误会让人更愿意寻找支持原观点的信息，并忽略反例。因为样本被这种选择过程筛过，所以看到的证据不能代表完整情况，结论会被高估。',
  references: [
    {
      id: 'REF1',
      tier: 1,
      sourceLabel: '项目教材',
      quote: '确认偏误会使个体优先搜集支持既有信念的信息，并忽视或低估反面证据。',
      layers: ['concept', 'reasoning'],
    },
  ],
};

const request = buildMasteryShadowEvaluationRequest(input);
assert.match(request.systemPrompt, /不推断未测试层/);
assert.match(request.systemPrompt, /不查外部知识|禁止凭模型记忆/);
assert.doesNotMatch(request.systemPrompt, /总分.{0,8}\d+/);
assert.deepEqual(JSON.parse(request.userInput).task.requiredLayers, ['concept', 'reasoning']);

const raw = {
  protocol: 'mastery-shadow-evaluator-v1',
  evaluationId: input.evaluationId,
  knowledgePointId: input.knowledgePointId,
  evidence: [
    { id: 'E1', quote: '确认偏误会让人更愿意寻找支持原观点的信息，并忽略反例。' },
    {
      id: 'E2',
      quote: '因为样本被这种选择过程筛过，所以看到的证据不能代表完整情况，结论会被高估。',
    },
  ],
  criteria: [
    {
      id: 'concept_accuracy',
      state: 'pass',
      evidenceIds: ['E1'],
      referenceIds: ['REF1'],
      reason: '准确说明了选择支持信息并忽视反例。',
    },
    {
      id: 'reasoning_relevance',
      state: 'pass',
      evidenceIds: ['E2'],
      referenceIds: [],
      reason: '选择性样本直接解释了结论偏高。',
    },
    {
      id: 'reasoning_sufficiency',
      state: 'pass',
      evidenceIds: ['E2'],
      referenceIds: ['REF1'],
      reason: '给出了信息筛选到判断偏差的完整中间关系。',
    },
  ],
  summary: '概念与因果解释均有资料及原话证据。',
};

const result = parseMasteryShadowEvaluation(raw, input);
assert.deepEqual(result.diagnostics, []);
assert.equal(result.observations.length, 2);
assert.equal(result.observations.find((item) => item.id.endsWith(':concept'))?.results[0].verdict, 'pass');
assert.equal(result.observations.find((item) => item.id.endsWith(':reasoning'))?.results[0].verdict, 'pass');
assert.equal(result.observations.some((item) => item.results[0].layer === 'judgment'), false);

const state = applyMasteryShadowObservations(undefined, result.observations);
assert.equal(state.layers.concept.state, 'provisional', '定向单项通过不能代替概念边界和应用');
assert.equal(state.layers.concept.criteria!.concept_accuracy.state, 'confirmed');
assert.equal(state.layers.reasoning.state, 'provisional', '遗漏推理一致性不能确认整层');
assert.equal(state.layers.reasoning.criteria!.reasoning_sufficiency.state, 'confirmed');
assert.equal(state.layers.judgment.state, 'unassessed', '题目未测试判断层，不能补零或反推');
const view = projectMasteryShadow({
  knowledgePointId: input.knowledgePointId,
  state,
  contentStatus: 'ready',
  requiredLevel: 3,
});
assert.equal(view.confirmedLevel, 0, '未全覆盖的任何层都不能抬高连续层级');
assert.equal(view.targetMet, false);

const missingReference = parseMasteryShadowEvaluation(
  {
    ...raw,
    criteria: raw.criteria.map((criterion) =>
      criterion.id === 'concept_accuracy' ? { ...criterion, referenceIds: [] } : criterion,
    ),
  },
  input,
);
assert.equal(
  missingReference.criteria.find((criterion) => criterion.id === 'concept_accuracy')?.state,
  'unverifiable',
  '需要资料的判据不能凭模型理解判通过',
);
assert.match(missingReference.diagnostics.join('\n'), /no valid reference/);

// Same-layer retrieval cannot authorize another criterion, even if the model borrows its ID.
const scopedInput: MasteryShadowEvaluationInput = { ...input,
  task: { ...input.task, requiredLayers: ['judgment'], criterionIds: ['judgment_accuracy', 'judgment_attribution'] },
  references: [{ id: 'ATTRIBUTION', tier: 3, sourceLabel: '归属说明',
    quote: '教材观点、观察事实和自己的推论需要区分。', layers: ['judgment'], criterionIds: ['judgment_attribution'] }] };
const scopedRequest = JSON.parse(buildMasteryShadowEvaluationRequest(scopedInput).userInput);
assert.deepEqual(scopedRequest.criteria.map((criterion: { allowedReferenceIds: string[] }) => criterion.allowedReferenceIds),
  [[], ['ATTRIBUTION']]);
const scopedResult = parseMasteryShadowEvaluation({ ...raw, criteria: [
  { id: 'judgment_accuracy', state: 'pass', evidenceIds: ['E1'], referenceIds: ['ATTRIBUTION'], reason: '同层资料就能证明正确。' },
  { id: 'judgment_attribution', state: 'pass', evidenceIds: ['E1'], referenceIds: ['ATTRIBUTION'], reason: '用户明确归属。' },
] }, scopedInput);
assert.equal(scopedResult.criteria[0].state, 'unverifiable');
assert.deepEqual(scopedResult.criteria[0].referenceIds, []);
assert.equal(scopedResult.criteria[1].state, 'pass', 'Single bad citation never cancels other valid criteria');
assert.match(scopedResult.diagnostics.join('\n'), /rejected reference/);
assert.match(request.systemPrompt, /同主题、同层或标题相关不等于支持/);
assert.match(request.systemPrompt, /coverage不可省略且必须在根对象/);

const invalidQuote = parseMasteryShadowEvaluation(
  {
    ...raw,
    evidence: [{ id: 'E1', quote: '用户没有说过的句子' }],
  },
  input,
);
assert.equal(
  invalidQuote.criteria.find((criterion) => criterion.id === 'concept_accuracy')?.state,
  'unverifiable',
);
assert.match(invalidQuote.diagnostics.join('\n'), /invalid user quote/);

let calls = 0;
const runResult = await runMasteryShadowEvaluation(input, async ({ systemPrompt, userInput }) => {
  calls += 1;
  assert.equal(systemPrompt, request.systemPrompt);
  assert.equal(userInput, request.userInput);
  return `\`\`\`json\n${JSON.stringify(raw)}\n\`\`\``;
});
assert.equal(calls, 1);
assert.equal(runResult.observations.length, 2);

console.log(
  JSON.stringify(
    {
      ok: true,
      evaluator: {
        requestedLayers: input.task.requiredLayers,
        requestedCriteria: input.task.criterionIds,
        observations: result.observations.map((item) => ({
          layer: item.results[0].layer,
          verdict: item.results[0].verdict,
          coverage: item.coverage,
          referenceBasis: item.referenceBasis,
        })),
        untestedJudgmentState: state.layers.judgment.state,
        contiguousConfirmedLevel: view.confirmedLevel,
      },
      safeguards: {
        exactUserQuoteRequired: true,
        validReferenceIdRequired: true,
        noNumericMasteryScore: true,
        noUntestedLayerInference: true,
        noProductionWrite: true,
      },
    },
    null,
    2,
  ),
);
