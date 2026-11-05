import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { ARGUMENT_RELATION_GOLDEN_SET } from './fixtures/argument-relation-golden.ts';
import { buildRelationExperiment, runRelationComparison, type RelationModelCaller } from './argument-relation-comparison.ts';
import { loadArgumentRelationDataset, relationFingerprint } from './argument-relation-dataset.ts';

const cases = ARGUMENT_RELATION_GOLDEN_SET;
const plan = buildRelationExperiment(cases);
assert.equal(plan.requests.length, 8);
assert.deepEqual(plan, buildRelationExperiment(cases), '稳定批次与脱敏编号');
for (let i = 0; i < plan.requests.length; i += 2) {
  assert.equal(plan.requests[i].userInput, plan.requests[i + 1].userInput, '策略间输入逐字一致');
  const payload = JSON.parse(plan.requests[i].userInput);
  assert.ok(payload.inputs.every((item: Record<string, unknown>) => !('expectedLabel' in item) && !('origin' in item)));
  assert.ok(payload.inputs.every((item: { id: string }) => /^p-[0-9a-f]{20}$/u.test(item.id)));
}
assert.notEqual(plan.requests[0].strategy, plan.requests[2].strategy, '交替先后顺序');
const caseById = new Map(cases.map((item) => [item.id, item]));
const wireToCase = new Map(plan.pairs.map((pair) => [pair.input.id, caseById.get(pair.caseId)!]));
const oracleCaller: RelationModelCaller = async (request) => ({
  model: 'fake-model-for-self-test', finishReason: 'stop', usage: { prompt_tokens: 10, completion_tokens: 20 },
  content: JSON.stringify({ predictions: JSON.parse(request.userInput).inputs.map((input: { id: string }) => {
    const item = wireToCase.get(input.id)!;
    const label = request.strategy === 'legacy-pair-proxy' && !['support', 'oppose'].includes(item.expectedLabel) ? 'none' : item.expectedLabel;
    return { id: input.id, label, evidenceSentenceIds: ['s1', 's2'], explanation: 'Mock only, not model evidence' };
  }) }),
});
const report = await runRelationComparison(cases, oracleCaller);
assert.equal(report.comparisonComplete, true);
assert.equal(report.metrics['legacy-pair-proxy'].common.threeWayAccuracy, 1);
assert.equal(report.metrics['typed-pair-v1'].common.threeWayAccuracy, 1);
assert.equal(report.metrics['legacy-pair-proxy'].eightClass, undefined, '不能比较不兼容八类准确率');
assert.equal(report.metrics['typed-pair-v1'].eightClass?.accuracy, 1);
assert.equal(report.apiUsage.promptTokens, 80);
assert.equal(report.apiUsage.completionTokens, 160);
assert.equal(report.apiUsage.usageComplete, true);
assert.deepEqual(report.predictions['typed-pair-v1'].map((item) => item.id).sort(), cases.map((item) => item.id).sort());

const invalidCallers: RelationModelCaller[] = [
  async () => { throw new Error('secret-token-must-not-leak'); },
  async (request) => ({ ...await oracleCaller(request), content: '{not json}' }),
  async (request) => ({ ...await oracleCaller(request), content: '{"predictions":[]}' }),
  async (request) => ({ ...await oracleCaller(request), finishReason: 'length' }),
];
for (const caller of invalidCallers) {
  const failed = await runRelationComparison(cases, caller);
  assert.equal(failed.comparisonComplete, false);
  assert.equal(failed.metrics['typed-pair-v1'].common.coverage, 0);
  assert.equal(failed.metrics['typed-pair-v1'].common.threeWayAccuracy, 0, '失败不算正确拒答');
  assert.ok(!JSON.stringify(failed).includes('secret-token-must-not-leak'));
  assert.equal(failed.attempts.length, 8, '没有隐式重试');
}
const changedModel = await runRelationComparison(cases, async (request) => ({ ...await oracleCaller(request), model: request.strategy }));
assert.equal(changedModel.comparisonComplete, false, '服务端模型版本漂移不能标为完整同模型对照');
const missingModel = await runRelationComparison(cases, async (request) => ({ ...await oracleCaller(request), model: '' }));
assert.equal(missingModel.comparisonComplete, false);
const partiallyMissingModel = await runRelationComparison(cases, async (request) => ({ ...await oracleCaller(request),
  model: request.batch === 0 ? '' : 'fake-model-for-self-test' }));
assert.equal(partiallyMissingModel.comparisonComplete, false, '部分响应缺少模型标识也不能通过同模型校验');
const dataset = await loadArgumentRelationDataset();
const edited = structuredClone(dataset.cases);
edited[0].annotationReason += ' revised';
assert.notEqual(relationFingerprint(edited), relationFingerprint(dataset.cases));
const cli = 'scripts/run-argument-relation-experiment.ts';
const dry = JSON.parse(execFileSync(process.execPath, ['--experimental-strip-types', cli], { encoding: 'utf8' }));
assert.equal(dry.requests, 8);
assert.equal(dry.localCases, 0);
assert.equal(dry.productionModified, false);
for (const args of [['--execute'], ['--allow-cloud'], ['--unknown']]) {
  assert.notEqual(spawnSync(process.execPath, ['--experimental-strip-types', cli, ...args]).status, 0);
}
console.log('Argument relation comparison checks passed (mock calls only).');
