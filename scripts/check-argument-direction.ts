import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { checkArgumentDirection } from '../src/services/argumentRelation/direction.ts';
import { ARGUMENT_DIRECTION_CHALLENGE } from './fixtures/argument-direction-challenge.ts';
import { argumentRelationInput } from '../src/services/argumentRelation/contract.ts';
import { loadArgumentRelationDataset, relationFingerprint } from './argument-relation-dataset.ts';
import { buildLocalPositiveCases } from './fixtures/argument-relation-local-positive.ts';
import { buildRelationExperiment, runRelationComparison, type RelationModelCaller } from './argument-relation-comparison.ts';

const input = argumentRelationInput(ARGUMENT_DIRECTION_CHALLENGE[0]);
const prediction = { id: input.id, label: 'support' as const, evidenceSentenceIds: ['a', 'b'], explanation: 'unit test' };
const forward = { direction: 'source_to_target', basisSentenceIds: ['a'], conclusionSentenceIds: ['b'], premiseStatus: 'sufficient' };
assert.equal(checkArgumentDirection(input, prediction, forward).status, 'accepted');
assert.equal(checkArgumentDirection(input, { ...prediction, label: 'oppose' }, forward).status, 'accepted');
for (const check of [
  { ...forward, direction: 'target_to_source', basisSentenceIds: ['b'], conclusionSentenceIds: ['a'] },
  { ...forward, basisSentenceIds: ['b'], conclusionSentenceIds: ['a'] },
  { ...forward, direction: 'undetermined' },
]) {
  const result = checkArgumentDirection(input, prediction, check);
  assert.equal(result.status, 'direction_rejected');
  assert.equal(result.prediction.label, 'insufficient_evidence');
  assert.equal(result.prediction.id, input.id);
}
assert.equal(checkArgumentDirection(input, prediction, { ...forward, premiseStatus: 'missing' }).status, 'premise_rejected');
for (const check of [null, {}, { ...forward, direction: 'whatever' }, { ...forward, premiseStatus: 'unknown' },
  { ...forward, direction: ['source_to_target'] }, { ...forward, premiseStatus: ['sufficient'] },
  { ...forward, basisSentenceIds: ['foreign'] }, { ...forward, basisSentenceIds: ['a', 'a'] },
  { ...forward, conclusionSentenceIds: ['a'] }, { ...forward, basisSentenceIds: [] }]) {
  assert.throws(() => checkArgumentDirection(input, prediction, check));
}
assert.equal(checkArgumentDirection(input, { ...prediction, label: 'explain' }, null).status, 'not_applicable');
assert.throws(() => checkArgumentDirection(input, { ...prediction, id: 'different-case' }, forward), /case_mismatch/);
const multiple = { ...input, sentences: [...input.sentences, { id: 'c', text: '另一项必要前提。' }], sourceSentenceIds: ['a', 'c'] };
assert.throws(() => checkArgumentDirection(multiple, prediction, forward), /endpoints/);
assert.equal(checkArgumentDirection(multiple, prediction, { ...forward, basisSentenceIds: ['c', 'a'] }).status, 'accepted');
assert.equal(ARGUMENT_DIRECTION_CHALLENGE.length, 12);
for (let i = 0; i < 12; i += 2) {
  const [a, b] = ARGUMENT_DIRECTION_CHALLENGE.slice(i, i + 2);
  assert.equal(a.groupId, b.groupId);
  assert.deepEqual(a.sentences, b.sentences, '反向样本不能改变正文');
  assert.deepEqual(a.sourceSentenceIds, b.targetSentenceIds);
}
const dataset = await loadArgumentRelationDataset(undefined, true);
assert.equal(dataset.cases.length, 44);
const plan = buildRelationExperiment(dataset.cases, { directionV2: true });
assert.equal(plan.requests.length, 12);
assert.deepEqual([...new Set(plan.requests.map((item) => item.strategy))].sort(), ['typed-direction-v2', 'typed-pair-v1']);
const byId = new Map(dataset.cases.map((item) => [item.id, item]));
const wire = new Map(plan.pairs.map((pair) => [pair.input.id, byId.get(pair.caseId)!]));
const oracle: RelationModelCaller = async (request) => ({
  model: 'mock', finishReason: 'stop', content: JSON.stringify({ predictions: JSON.parse(request.userInput).inputs.map((value: { id: string }) => {
    const item = wire.get(value.id)!;
    return { id: value.id, label: item.expectedLabel, evidenceSentenceIds: [...item.sourceSentenceIds, ...item.targetSentenceIds],
      explanation: 'Mock only', directionCheck: { direction: 'source_to_target', basisSentenceIds: item.sourceSentenceIds,
        conclusionSentenceIds: item.targetSentenceIds, premiseStatus: 'sufficient' } };
  }) }),
});
const report = await runRelationComparison(dataset.cases, oracle, undefined, { directionV2: true });
assert.equal(report.comparisonComplete, true);
assert.equal(report.metrics['typed-direction-v2'].common.threeWayAccuracy, 1);
assert.equal(report.metrics['typed-direction-v2'].byCohort.new_direction.cases, 12);
assert.equal(report.directionChecks.length, 44);
assert.equal(report.metrics['typed-direction-v2'].rawCommon.threeWayAccuracy, 1);
const gateRun = await runRelationComparison(dataset.cases, async (request) => {
  const response = await oracle(request);
  if (request.strategy !== 'typed-direction-v2') return response;
  const value = JSON.parse(response.content);
  for (const item of value.predictions) if (['support', 'oppose'].includes(item.label)) item.directionCheck.premiseStatus = 'missing';
  return { ...response, content: JSON.stringify(value) };
}, undefined, { directionV2: true });
assert.equal(gateRun.metrics['typed-direction-v2'].rawCommon.edge.recall, 1);
assert.equal(gateRun.metrics['typed-direction-v2'].common.edge.recall, 0, '不能用全拒绝隐藏门禁误杀');
const malformed = await runRelationComparison(dataset.cases, async (request) => {
  const response = await oracle(request);
  if (request.strategy !== 'typed-direction-v2') return response;
  const value = JSON.parse(response.content);
  for (const item of value.predictions) delete item.directionCheck;
  return { ...response, content: JSON.stringify(value) };
}, undefined, { directionV2: true });
assert.equal(malformed.comparisonComplete, false, '格式失败不能当作有效拒绝');

const source = { document: 1, source: '发现障碍。', target: '建议清除障碍。', chunk: '发现障碍。建议清除障碍。' };
const selection = { endpointHash: relationFingerprint([source.source, source.target, source.chunk]), reason: '问题构成建议理由。' };
assert.equal(buildLocalPositiveCases([source], [selection])[0].expectedLabel, 'support');
assert.throws(() => buildLocalPositiveCases([{ ...source, source: '被改写。' }], [selection]), /changed/);
assert.throws(() => buildLocalPositiveCases([source], [selection, selection]), /Duplicate/);
const dry = JSON.parse(execFileSync(process.execPath, ['--experimental-strip-types', 'scripts/run-argument-relation-experiment.ts', '--direction-v2'], { encoding: 'utf8' }));
assert.equal(dry.requests, 12);
assert.equal(dry.cases, 44);
assert.equal(dry.directionV2, true);
console.log('Argument direction checks passed (new challenge and mock calls only).');
