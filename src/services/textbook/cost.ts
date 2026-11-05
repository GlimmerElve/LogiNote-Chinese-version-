import type { TextbookJob } from './generationTypes';
import { TEXTBOOK_COST_LIMITS } from './modelPolicy';

export function textbookCost(job: TextbookJob) {
  if (!job.checkpoint.cost) {
    const attempts = job.checkpoint.modelAttempts || [];
    job.checkpoint.cost = { promptTokens: attempts.reduce((sum, item) => sum + (item.promptTokens || 0), 0),
      completionTokens: attempts.reduce((sum, item) => sum + (item.completionTokens || 0), 0), reservedTokens: 0,
      requests: attempts.length, repairRounds: 0, reviewRechecks: 0, legacyUsageIncomplete: attempts.length > 0 };
  }
  const cost = job.checkpoint.cost;
  if ([cost.promptTokens, cost.completionTokens, cost.reservedTokens, cost.requests, cost.repairRounds, cost.reviewRechecks]
    .some((value) => !Number.isSafeInteger(value) || value < 0) || typeof cost.legacyUsageIncomplete !== 'boolean') {
    throw new Error('教材用量检查点无效；已保留草稿，不追加模型请求');
  }
  return job.checkpoint.cost;
}
export function textbookCostLimits(job: TextbookJob) { return job.spec.modelPolicy?.costControl || TEXTBOOK_COST_LIMITS; }
export class TextbookBudgetError extends Error {
  constructor(kind: NonNullable<ReturnType<typeof textbookCost>['stopped']>) {
    const name = { tokens: '累计 token', requests: '模型请求次数', repairs: '内容修订轮数', reviews: '报告重检次数' }[kind];
    super(`教材${name}达到上限，已停止追加请求；已有物料、蓝图和章节保留。继续点击重试不会重置预算，请先检查草稿与失败位置，再明确调整生成方案。`);
    this.name = 'TextbookBudgetError';
  }
}
export function consumeTextbookRound(job: TextbookJob, kind: 'repairs' | 'reviews'): void {
  const cost = textbookCost(job); const limits = textbookCostLimits(job);
  const key = kind === 'repairs' ? 'repairRounds' : 'reviewRechecks';
  const max = kind === 'repairs' ? limits.maxRepairRounds : limits.maxReviewRechecks;
  if (cost[key] >= max) { cost.stopped = kind; throw new TextbookBudgetError(kind); }
  cost[key]++; delete cost.stopped;
}
/** A conservative character estimate is not a provider tokenizer or a billing guarantee.
 * Persist the reservation BEFORE a request. Unknown usage/crashes retain it. */
export function reserveTextbookRequest(job: TextbookJob, prompt: string, userInput: string, maxTokens: number, imageTokenReserve = 0): number {
  if (!Number.isSafeInteger(imageTokenReserve) || imageTokenReserve < 0) throw new Error('图片输入预算无效');
  const cost = textbookCost(job); const limits = textbookCostLimits(job);
  const reserved = Math.ceil((prompt.length + userInput.length) * 1.2) + maxTokens + imageTokenReserve;
  if (cost.requests >= limits.maxRequests) { cost.stopped = 'requests'; throw new TextbookBudgetError('requests'); }
  if (cost.promptTokens + cost.completionTokens + cost.reservedTokens + reserved > limits.maxTotalTokens) {
    cost.stopped = 'tokens'; throw new TextbookBudgetError('tokens');
  }
  cost.requests++; cost.reservedTokens += reserved; delete cost.stopped;
  return reserved;
}
export function settleTextbookRequest(job: TextbookJob, reserved: number, usage?: { promptTokens?: number; completionTokens?: number }): void {
  if (!Number.isSafeInteger(usage?.promptTokens) || usage!.promptTokens! < 0
    || !Number.isSafeInteger(usage?.completionTokens) || usage!.completionTokens! < 0) return;
  const cost = textbookCost(job);
  cost.reservedTokens = Math.max(0, cost.reservedTokens - reserved);
  cost.promptTokens += usage!.promptTokens!; cost.completionTokens += usage!.completionTokens!;
}
