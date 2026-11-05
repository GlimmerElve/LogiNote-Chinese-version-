import type { DocumentQueryIntent } from '../../types.ts';
import {
  classifyDocumentQueryIntent,
  fuseKnowledgeChannelRanks,
  retrievalWeights,
  type RetrievalChannelWeights,
} from './knowledgeRetrieval.ts';

export interface RetrievalGoldenCase {
  id: string;
  query: string;
  expectedIntent: DocumentQueryIntent;
  /** 0 不应写入；1=相关，2=高度相关，3=最佳直接证据。 */
  relevance: Record<string, 1 | 2 | 3>;
  /** 有稳定 source locator 的候选，用于监测引用定位覆盖。 */
  locatableChunkIds: string[];
  channels: {
    passage: string[];
    entity: string[];
    argument: string[];
  };
}

export interface RetrievalEvaluationMetrics {
  queryCount: number;
  recallAtK: number;
  mrrAtK: number;
  ndcgAtK: number;
  irrelevantRateAtK: number;
  locatorCoverageAtK: number;
}

export interface RetrievalEvaluationReport {
  k: number;
  intentAccuracy: number;
  baseline: RetrievalEvaluationMetrics;
  unified: RetrievalEvaluationMetrics;
  byIntent: Partial<Record<DocumentQueryIntent, {
    baseline: RetrievalEvaluationMetrics;
    unified: RetrievalEvaluationMetrics;
  }>>;
  rankings: Array<{
    id: string;
    intent: DocumentQueryIntent;
    baseline: string[];
    unified: string[];
  }>;
}

export type RetrievalWeightResolver = (intent: DocumentQueryIntent) => RetrievalChannelWeights;

function unique(ids: string[]): string[] {
  return [...new Set(ids.filter(Boolean))];
}

export function rankGoldenCase(
  item: RetrievalGoldenCase,
  resolveWeights: RetrievalWeightResolver = retrievalWeights,
): string[] {
  const actualIntent = classifyDocumentQueryIntent(item.query);
  const scores = fuseKnowledgeChannelRanks({
    passage: unique(item.channels.passage),
    entity: unique(item.channels.entity),
    argument: unique(item.channels.argument),
  }, resolveWeights(actualIntent));
  return [...scores.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([id]) => id);
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function evaluateRankings(
  items: RetrievalGoldenCase[],
  rankings: Map<string, string[]>,
  k: number,
): RetrievalEvaluationMetrics {
  const recalls: number[] = [];
  const reciprocalRanks: number[] = [];
  const ndcgs: number[] = [];
  const irrelevantRates: number[] = [];
  const locatorCoverages: number[] = [];

  for (const item of items) {
    const ranked = unique(rankings.get(item.id) || []).slice(0, k);
    const relevantIds = Object.keys(item.relevance);
    const relevantSet = new Set(relevantIds);
    const locatableSet = new Set(item.locatableChunkIds);
    const relevantHits = ranked.filter((id) => relevantSet.has(id));
    recalls.push(relevantIds.length ? relevantHits.length / relevantIds.length : 1);

    const firstRelevant = ranked.findIndex((id) => relevantSet.has(id));
    reciprocalRanks.push(firstRelevant >= 0 ? 1 / (firstRelevant + 1) : 0);

    const dcg = ranked.reduce((sum, id, index) => {
      const relevance = item.relevance[id] || 0;
      return sum + ((2 ** relevance) - 1) / Math.log2(index + 2);
    }, 0);
    const ideal = Object.values(item.relevance)
      .sort((left, right) => right - left)
      .slice(0, k)
      .reduce((sum, relevance, index) => sum + ((2 ** relevance) - 1) / Math.log2(index + 2), 0);
    ndcgs.push(ideal > 0 ? dcg / ideal : 1);

    irrelevantRates.push(ranked.length
      ? ranked.filter((id) => !relevantSet.has(id)).length / ranked.length
      : 0);
    locatorCoverages.push(ranked.length
      ? ranked.filter((id) => locatableSet.has(id)).length / ranked.length
      : 1);
  }

  return {
    queryCount: items.length,
    recallAtK: mean(recalls),
    mrrAtK: mean(reciprocalRanks),
    ndcgAtK: mean(ndcgs),
    irrelevantRateAtK: mean(irrelevantRates),
    locatorCoverageAtK: mean(locatorCoverages),
  };
}

export function evaluateRetrievalGoldenSet(
  items: RetrievalGoldenCase[],
  options?: { k?: number; resolveWeights?: RetrievalWeightResolver },
): RetrievalEvaluationReport {
  const k = Math.max(1, Math.floor(options?.k || 5));
  const resolveWeights = options?.resolveWeights || retrievalWeights;
  const baselineRankings = new Map<string, string[]>();
  const unifiedRankings = new Map<string, string[]>();
  const byIntent: RetrievalEvaluationReport['byIntent'] = {};

  for (const item of items) {
    baselineRankings.set(item.id, unique(item.channels.passage));
    unifiedRankings.set(item.id, rankGoldenCase(item, resolveWeights));
  }

  const intents = [...new Set(items.map((item) => item.expectedIntent))];
  for (const intent of intents) {
    const subset = items.filter((item) => item.expectedIntent === intent);
    byIntent[intent] = {
      baseline: evaluateRankings(subset, baselineRankings, k),
      unified: evaluateRankings(subset, unifiedRankings, k),
    };
  }

  return {
    k,
    intentAccuracy: items.length
      ? items.filter((item) => classifyDocumentQueryIntent(item.query) === item.expectedIntent).length / items.length
      : 1,
    baseline: evaluateRankings(items, baselineRankings, k),
    unified: evaluateRankings(items, unifiedRankings, k),
    byIntent,
    rankings: items.map((item) => ({
      id: item.id,
      intent: item.expectedIntent,
      baseline: baselineRankings.get(item.id)!.slice(0, k),
      unified: unifiedRankings.get(item.id)!.slice(0, k),
    })),
  };
}

export function weightProfileResolver(
  profile: Partial<Record<DocumentQueryIntent, RetrievalChannelWeights>>,
): RetrievalWeightResolver {
  return (intent) => profile[intent] || retrievalWeights(intent);
}
