import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import type { DocumentQueryIntent } from '../src/types.ts';
import {
  DEFAULT_RETRIEVAL_WEIGHT_PROFILE,
  type RetrievalChannelWeights,
} from '../src/electron/rag/knowledgeRetrieval.ts';
import {
  evaluateRetrievalGoldenSet,
  weightProfileResolver,
} from '../src/electron/rag/retrievalEvaluation.ts';
import { RAG_RETRIEVAL_GOLDEN_SET } from './fixtures/rag-retrieval-golden.ts';

const INTENTS: DocumentQueryIntent[] = [
  'definition', 'fact', 'entity_relation', 'reason', 'support',
  'opposition', 'comparison', 'application', 'general',
];

const balanced = Object.fromEntries(INTENTS.map((intent) => [
  intent,
  { passage: 1 / 3, entity: 1 / 3, argument: 1 / 3 },
])) as Record<DocumentQueryIntent, RetrievalChannelWeights>;

const passageHeavy = Object.fromEntries(INTENTS.map((intent) => [
  intent,
  { passage: 0.65, entity: 0.175, argument: 0.175 },
])) as Record<DocumentQueryIntent, RetrievalChannelWeights>;

const graphHeavy: Record<DocumentQueryIntent, RetrievalChannelWeights> = {
  ...DEFAULT_RETRIEVAL_WEIGHT_PROFILE,
  definition: { passage: 0.25, entity: 0.65, argument: 0.10 },
  entity_relation: { passage: 0.15, entity: 0.75, argument: 0.10 },
  reason: { passage: 0.20, entity: 0.10, argument: 0.70 },
  support: { passage: 0.15, entity: 0.10, argument: 0.75 },
  opposition: { passage: 0.15, entity: 0.10, argument: 0.75 },
  comparison: { passage: 0.20, entity: 0.50, argument: 0.30 },
};

const defaultReport = evaluateRetrievalGoldenSet(RAG_RETRIEVAL_GOLDEN_SET, { k: 5 });
const profiles = [
  { name: 'production-default', report: defaultReport },
  { name: 'balanced', report: evaluateRetrievalGoldenSet(RAG_RETRIEVAL_GOLDEN_SET, { k: 5, resolveWeights: weightProfileResolver(balanced) }) },
  { name: 'passage-heavy', report: evaluateRetrievalGoldenSet(RAG_RETRIEVAL_GOLDEN_SET, { k: 5, resolveWeights: weightProfileResolver(passageHeavy) }) },
  { name: 'graph-heavy', report: evaluateRetrievalGoldenSet(RAG_RETRIEVAL_GOLDEN_SET, { k: 5, resolveWeights: weightProfileResolver(graphHeavy) }) },
];

assert.equal(RAG_RETRIEVAL_GOLDEN_SET.length, 27, '初始黄金集必须保持在计划要求的 20–50 条范围内');
for (const intent of INTENTS) {
  assert.equal(
    RAG_RETRIEVAL_GOLDEN_SET.filter((item) => item.expectedIntent === intent).length,
    3,
    `${intent} 应有 3 条人工查询`,
  );
}
assert.equal(defaultReport.intentAccuracy, 1, '确定性意图分类必须完整命中黄金标签');
assert.ok(defaultReport.unified.recallAtK >= defaultReport.baseline.recallAtK, '统一检索 Recall@5 不得低于 passage 基线');
assert.ok(defaultReport.unified.mrrAtK >= defaultReport.baseline.mrrAtK + 0.08, '统一检索 MRR@5 应有可测提升');
assert.ok(defaultReport.unified.ndcgAtK >= defaultReport.baseline.ndcgAtK + 0.08, '统一检索 nDCG@5 应有可测提升');
assert.ok(defaultReport.unified.irrelevantRateAtK <= defaultReport.baseline.irrelevantRateAtK, '统一检索无关片段率不得升高');
assert.equal(defaultReport.unified.locatorCoverageAtK, 1, '进入前五的候选必须都有 source locator');

for (const intent of INTENTS) {
  const metrics = defaultReport.byIntent[intent];
  assert.ok(metrics, `${intent} 缺少分类报告`);
  assert.ok(metrics!.unified.recallAtK >= metrics!.baseline.recallAtK, `${intent} Recall@5 不得回退`);
}

const iterations = 200;
const startedAt = performance.now();
for (let index = 0; index < iterations; index += 1) {
  evaluateRetrievalGoldenSet(RAG_RETRIEVAL_GOLDEN_SET, { k: 5 });
}
const elapsedMs = performance.now() - startedAt;
const fusionMsPerQuery = elapsedMs / (iterations * RAG_RETRIEVAL_GOLDEN_SET.length);
assert.ok(fusionMsPerQuery < 2, `纯融合平均耗时异常：${fusionMsPerQuery.toFixed(3)}ms/query`);

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

console.log(`RAG retrieval golden set: ${RAG_RETRIEVAL_GOLDEN_SET.length} queries, intent accuracy ${percent(defaultReport.intentAccuracy)}`);
console.log('profile\tRecall@5\tMRR@5\tnDCG@5\tirrelevant@5\tlocator@5');
for (const profile of profiles) {
  const metrics = profile.report.unified;
  console.log([
    profile.name,
    percent(metrics.recallAtK),
    metrics.mrrAtK.toFixed(3),
    metrics.ndcgAtK.toFixed(3),
    percent(metrics.irrelevantRateAtK),
    percent(metrics.locatorCoverageAtK),
  ].join('\t'));
}
console.log([
  'passage-baseline',
  percent(defaultReport.baseline.recallAtK),
  defaultReport.baseline.mrrAtK.toFixed(3),
  defaultReport.baseline.ndcgAtK.toFixed(3),
  percent(defaultReport.baseline.irrelevantRateAtK),
  percent(defaultReport.baseline.locatorCoverageAtK),
].join('\t'));
console.log(`fusion-only average latency: ${fusionMsPerQuery.toFixed(4)}ms/query`);
console.log('RAG retrieval evaluation passed');
