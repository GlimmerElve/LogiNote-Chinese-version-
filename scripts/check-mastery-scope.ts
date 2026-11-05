import assert from 'node:assert/strict';
import { buildMasteryShadowEvaluationRequest, parseMasteryShadowEvaluation, runMasteryShadowEvaluation,
  type MasteryShadowEvaluationInput } from '../src/services/masteryShadow/evaluator';
import { applyMasteryShadowObservations, createMasteryShadowState } from '../src/services/masteryShadow/stateMachine';

globalThis.fetch = async () => assert.fail('Contract tests must not send requests');
const answer = '我给实验组增加诱饵，同时更改默认选项，所以差异全是诱饵造成的。我同时说默认值相同，但前面又说改了默认值。';
const input: MasteryShadowEvaluationInput = { evaluationId: 'scope-transport', knowledgePointId: 'kp',
  knowledgePointTitle: '诱饵效应', occurredAt: '2026-10-18T12:00:00.000Z', source: 'quick_check',
  assistance: 'independent', strength: 'targeted', task: { referenceContract: 'criterion-scope-v3',
    prompt: '判断本次设计是否能把差异归因于新增诱饵，并检查原话是否自洽。', responseType: 'open',
    criterionIds: ['reasoning_sufficiency', 'reasoning_consistency'], requiredLayers: ['reasoning'] }, answer,
  references: [{ id: 'REF', tier: 3, sourceRole: 'primary', sourceLabel: '知识点笔记',
    quote: '两组只改变选项集合，默认选项必须保持相同。', criterionIds: ['reasoning_sufficiency'] }] };
const raw = { protocol: 'mastery-shadow-evaluator-v1', evaluationId: input.evaluationId, knowledgePointId: input.knowledgePointId,
  baselines: [
    { id: 'reasoning_sufficiency', scope: '本次设计能否排除默认选项混杂', scopeIds: ['task'], applicability: 'applicable',
      coverage: 'covered', rule: input.references[0].quote, referenceIds: ['REF'],
      referenceQuotes: [{ referenceId: 'REF', quote: input.references[0].quote }], reason: '有本题必要条件。' },
    { id: 'reasoning_consistency', scope: '原话对默认值是否一致', scopeIds: ['task'], applicability: 'applicable',
      coverage: 'not_required', rule: '同一条件不能同时改变与不改变', referenceIds: [], referenceQuotes: [], reason: '原话核对。' }],
  evidence: [{ id: 'E1', quote: answer.split('。')[0] + '。' }, { id: 'E2', quote: answer.split('。')[1] + '。' }],
  criteria: [
    { id: 'reasoning_sufficiency', state: 'fail', evidenceIds: ['E1'], reason: '同时改默认选项，不能仅归因于诱饵。',
      comparison: { requirement: '默认选项必须保持相同', scopeIds: ['task'], evidenceIds: ['E1'], referenceIds: ['REF'],
        finding: 'contradiction', scopeMatch: true } },
    { id: 'reasoning_consistency', state: 'fail', evidenceIds: ['E2'], reason: '默认值既说相同又说改动。',
      comparison: { requirement: '同一默认值的描述应一致', scopeIds: ['task'], evidenceIds: ['E2'], referenceIds: [],
        finding: 'contradiction', scopeMatch: true } }], summary: '明确违反控制条件并有原话冲突。' };
const parse = (value: unknown) => parseMasteryShadowEvaluation(value, input);
const parsed = parse(raw);
assert.deepEqual(parsed.criteria.map(row => row.state), ['fail', 'fail']);
assert.deepEqual(parse(parsed).criteria, parsed.criteria, 'Save-time reparse is idempotent, including reason/comparison');
assert.equal(parsed.criteria[1].comparison?.referenceIds.length, 0, 'Text-internal contradictions need no external citation');
const request = JSON.parse(buildMasteryShadowEvaluationRequest(input).userInput);
assert.deepEqual(request.task.verificationPolicy, { scope: 'task_and_actual_claim',
  omissions: 'only_if_task_or_claim_requires', absoluteWords: 'not_scope_evidence' });
assert.equal(request.task.verificationScopes.length, 1);
assert.equal(request.task.verificationScopes[0].answer, input.answer);

for (const mutate of [
  (value: any) => { delete value.criteria[0].comparison; },
  (value: any) => { value.criteria[0].comparison.scopeMatch = false; },
  (value: any) => { value.criteria[0].comparison.requirement = ''; },
  (value: any) => { value.criteria[0].comparison.referenceIds = ['invented-reference']; },
  (value: any) => { value.criteria[0].comparison.evidenceIds = ['invented-quote']; },
  (value: any) => { value.criteria[0].comparison.scopeIds = ['task', 'invented-question']; },
  (value: any) => { value.criteria[0].comparison.finding = 'absolute_word'; },
  (value: any) => { value.baselines[0].applicability = 'out_of_scope'; },
  (value: any) => { value.baselines[0].scope = ''; },
  (value: any) => { value.baselines[0].scopeIds = ['invented-question']; },
  (value: any) => { value.baselines[0].referenceQuotes[0].quote = '不存在的条件'; },
]) {
  const changed = structuredClone(raw); mutate(changed); const result = parse(changed);
  assert.equal(result.criteria[0].state, 'unverifiable');
  assert.equal(result.criteria[1].state, 'fail', 'Bad comparison affects only its criterion');
  assert.match(result.summary, /未计入掌握更新/);
  const state = applyMasteryShadowObservations(undefined, result.observations);
  const held = state.layers.reasoning.criteria!.reasoning_sufficiency;
  assert.equal(held.unresolvedFailures, 0);
  assert.equal(held.independentPasses, 0);
}
const insufficient = structuredClone(raw);
insufficient.baselines[0].coverage = 'insufficient';
insufficient.criteria[1].state = 'not_observed';
const previous = createMasteryShadowState(input.knowledgePointId);
assert.deepEqual(applyMasteryShadowObservations(previous, parse(insufficient).observations).layers, previous.layers);
const positive = structuredClone(raw);
positive.criteria[0].state = 'pass'; delete (positive.criteria[0] as any).comparison;
assert.equal(parse(positive).criteria[0].state, 'pass', 'No artificial error record is required for a pass');
const historical = { ...input, task: { ...input.task, referenceContract: 'criterion-baseline-v2' as const } };
const legacyResponse = structuredClone(raw);
legacyResponse.criteria.forEach(row => { delete (row as any).comparison; });
assert.equal(parseMasteryShadowEvaluation(legacyResponse, historical).criteria[0].state, 'fail', 'Historical v2 remains readable');
let calls = 0;
await runMasteryShadowEvaluation(input, async () => { calls++; return raw; });
assert.equal(calls, 1, 'No extra semantic retry/review call');
console.log('PASS v3 scope/condition/evidence gates, text-only criteria, per-item preservation, safe summary, legacy compatibility and single-call contract. No network or formal writes.');
