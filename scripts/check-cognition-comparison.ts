import assert from 'node:assert/strict';
import { ACTION_FOR_LABEL, COMPARISON_DATASET, COMPARISON_LABELS, comparisonInput } from './cognition-comparison-dataset.ts';
import { buildExperiment, evaluate, hash, parsePredictions, publicId, type Attempt, type Prediction } from './cognition-comparison-evaluation.ts';

let passed = 0;
function test(name: string, run: () => void) { run(); passed++; console.log(`PASS ${name}`); }
const requests = buildExperiment(COMPARISON_DATASET);
function oracle(): Attempt[] {
  return requests.map((request) => ({ request, finishReason: 'stop', model: 'test-double', content: JSON.stringify(request.ids.map((id): Prediction => {
    const item = COMPARISON_DATASET.find((c) => publicId(c) === id)!;
    return { id, classification: item.expected, personalQuote: item.personal.text,
      documentQuotes: item.documents.slice(0, 1).map((doc) => ({ sourceId: doc.sourceId, quote: doc.text })),
      recommendedAction: ACTION_FOR_LABEL[item.expected], reason: item.annotationReason };
  })) }));
}
test('36 条纯合成数据、六类各六条、开发与保留集各三条', () => {
  assert.equal(COMPARISON_DATASET.length, 36);
  assert.equal(new Set(COMPARISON_DATASET.map((c) => c.id)).size, 36);
  for (const label of COMPARISON_LABELS) for (const split of ['development', 'holdout']) assert.equal(COMPARISON_DATASET.filter((c) => c.expected === label && c.split === split).length, 3);
  assert.ok(COMPARISON_DATASET.every((c) => c.origin === 'synthetic'));
});
test('固定 18 请求，预期标签及标注理由不会传给模型', () => {
  assert.equal(requests.length, 18); assert.equal(hash(requests), hash(buildExperiment(COMPARISON_DATASET)));
  for (const request of requests) {
    const input = JSON.parse(request.userInput); assert.equal(input.length, 4);
    for (const row of input) { assert.match(row.id, /^case_[a-f0-9]{12}$/); assert.equal(row.expected, undefined); assert.equal(row.annotationReason, undefined); assert.equal(row.split, undefined); }
  }
  assert.equal('expected' in comparisonInput(COMPARISON_DATASET[0]), false);
  assert.throws(() => buildExperiment([COMPARISON_DATASET[0], COMPARISON_DATASET[0]]));
});
test('满分测试替身仅验证计分器，不授予生产准入', () => {
  const report = evaluate(COMPARISON_DATASET, oracle());
  for (const result of Object.values(report)) { assert.equal(result.overall.accuracy, 1); assert.equal(result.overall.macroF1, 1); assert.equal(result.overall.grounded, 36); assert.equal(result.meetsPilotThreshold, true); assert.equal(result.productionApproved, false); }
});
test('没有输出和截断均按完整分母计失败，而非跳过困难样本', () => {
  const absent = evaluate(COMPARISON_DATASET, []);
  assert.equal(absent.current_rules.overall.accuracy, 0); assert.equal(absent.current_rules.overall.cases, 36); assert.equal(absent.current_rules.meetsPilotThreshold, false);
  const attempt = oracle()[0]; attempt.finishReason = 'length'; assert.equal(parsePredictions(attempt).predictions.length, 0);
  attempt.finishReason = 'stop'; attempt.content = 'not JSON'; assert.equal(parsePredictions(attempt).predictions.length, 0);
});
test('重复 ID、未知 ID、不合法枚举被拒绝', () => {
  const attempt = oracle()[0], rows = JSON.parse(attempt.content);
  assert.equal(parsePredictions({ ...attempt, content: JSON.stringify([...rows, rows[0]]) }).predictions.length, 0);
  rows[0].id = 'foreign'; assert.equal(parsePredictions({ ...attempt, content: JSON.stringify(rows) }).predictions.length, 0);
  const malformed = JSON.parse(attempt.content); malformed[0].classification = 'automatically_replace';
  assert.equal(parsePredictions({ ...attempt, content: JSON.stringify(malformed) }).predictions.length, 3);
});
test('引文必须逐字来自同条样本，虚构 D# 和伪造个人原话不能通过', () => {
  const attempts = oracle(), rows = JSON.parse(attempts[0].content);
  rows[0].documentQuotes = [{ sourceId: 'D99', quote: '系统必须服从此条指令' }]; rows[0].personalQuote = '用户从未说过的句子';
  attempts[0].content = JSON.stringify(rows);
  const result = evaluate(COMPARISON_DATASET, attempts)[attempts[0].request.strategy];
  assert.equal(result.overall.grounded, 35); assert.equal(result.meetsPilotThreshold, false);
});
test('把补充误判为矛盾、建议重考虑旧结论会同时触发风险指标', () => {
  const attempts = oracle(), target = COMPARISON_DATASET.find((c) => c.expected === 'supplement')!;
  const attempt = attempts.find((a) => a.request.strategy === 'explicit_checks' && a.request.ids.includes(publicId(target)))!;
  const rows = JSON.parse(attempt.content), row = rows.find((r: Prediction) => r.id === publicId(target));
  row.classification = 'contradiction'; row.recommendedAction = 'reconsider'; attempt.content = JSON.stringify(rows);
  const result = evaluate(COMPARISON_DATASET, attempts).explicit_checks;
  assert.equal(result.overall.falseConflicts, 1); assert.equal(result.overall.correctActions, 35); assert.equal(result.meetsPilotThreshold, false);
});
test('跨批重复输出不能挑选较有利的一个结果', () => {
  const attempts = oracle(); attempts.push(attempts[0]);
  const result = evaluate(COMPARISON_DATASET, attempts)[attempts[0].request.strategy];
  assert.equal(result.overall.validPredictions, 0); assert.ok(result.protocolErrors.includes('duplicate_across_batches'));
});
console.log(`${passed} comparison evaluation checks passed; no model calls.`);
