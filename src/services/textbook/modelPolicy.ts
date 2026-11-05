/** Only textbook structured calls use this policy; other workflows retain their settings. */
import type { TeachingBlueprint } from './generationTypes';

export type TextbookModelStage = 'selection' | 'blueprint' | 'chapter' | 'quality';
export const TEXTBOOK_COMPLEX_REASONING = ['derivation', 'algorithm', 'causal_comparison'] as const;
export type TextbookReasoningKind = 'standard' | typeof TEXTBOOK_COMPLEX_REASONING[number];
export interface TextbookModelBudget {
  maxTokens: number;
  retryMaxTokens: number;
  thinkingMode: 'enabled' | 'disabled';
}
export interface TextbookModelPolicy {
  version: 1 | 2 | 3 | 4;
  maxTruncationRetries: 1;
  stages: Record<TextbookModelStage, TextbookModelBudget>;
  costControl?: TextbookCostLimits;
  complexChapterThinking?: { maxChapters: 2 };
}
export interface TextbookCostLimits { maxTotalTokens: number; maxRequests: number; maxRepairRounds: number; maxReviewRechecks: number }
export const TEXTBOOK_COST_LIMITS: TextbookCostLimits = { maxTotalTokens: 600000, maxRequests: 30, maxRepairRounds: 2, maxReviewRechecks: 2 };
const stages: TextbookModelStage[] = ['selection', 'blueprint', 'chapter', 'quality'];
const policy: TextbookModelPolicy = {
  version: 2, maxTruncationRetries: 1,
  stages: {
    selection: { maxTokens: 4000, retryMaxTokens: 8000, thinkingMode: 'disabled' },
    blueprint: { maxTokens: 8000, retryMaxTokens: 16000, thinkingMode: 'disabled' },
    chapter: { maxTokens: 12000, retryMaxTokens: 24000, thinkingMode: 'disabled' },
    quality: { maxTokens: 8000, retryMaxTokens: 16000, thinkingMode: 'disabled' },
  },
};
export function defaultTextbookModelPolicy(version: 1 | 2 | 3 | 4 = 4): TextbookModelPolicy {
  const result = structuredClone(policy);
  if (version >= 3) { result.version = version; result.costControl = { ...TEXTBOOK_COST_LIMITS }; }
  if (version === 4) {
    result.stages.blueprint.thinkingMode = 'enabled';
    result.complexChapterThinking = { maxChapters: 2 };
  }
  if (version === 1) {
    result.version = 1;
    result.stages.blueprint.thinkingMode = 'enabled';
    result.stages.chapter.thinkingMode = 'enabled';
  }
  return result;
}
export function validateTextbookModelPolicy(value: unknown): asserts value is TextbookModelPolicy {
  const candidate = value as TextbookModelPolicy;
  if (!candidate || ![1, 2, 3, 4].includes(candidate.version) || candidate.maxTruncationRetries !== 1 || !candidate.stages
    || stages.some((stage) => {
      const budget = candidate.stages[stage];
      return !budget || !['enabled', 'disabled'].includes(budget.thinkingMode) || !Number.isSafeInteger(budget.maxTokens)
        || !Number.isSafeInteger(budget.retryMaxTokens) || budget.maxTokens < 256
        || budget.retryMaxTokens <= budget.maxTokens || budget.retryMaxTokens > policy.stages[stage].retryMaxTokens;
    })) throw new Error('教材输出预算或截断重试策略无效，请重新准备并确认');
  if (candidate.version >= 3 && (!candidate.costControl || Object.keys(candidate.costControl).length !== 4
    || (Object.keys(TEXTBOOK_COST_LIMITS) as Array<keyof TextbookCostLimits>).some((key) => candidate.costControl![key] !== TEXTBOOK_COST_LIMITS[key]))) {
    throw new Error('教材累计预算策略无效，请重新准备并确认');
  }
  if (candidate.version === 4 && (!candidate.complexChapterThinking || Object.keys(candidate.complexChapterThinking).length !== 1
    || candidate.complexChapterThinking.maxChapters !== 2)) throw new Error('教材复杂章节思考策略无效，请重新准备并确认');
}
/** Only a validated blueprint may nominate chapters. The first two explicit
 * complex labels qualify; missing/unknown labels never enable reasoning. */
export function textbookRequestBudget(policy: TextbookModelPolicy, stage: TextbookModelStage,
  blueprint?: TeachingBlueprint, chapterId?: string): TextbookModelBudget {
  const budget = { ...policy.stages[stage] };
  if (policy.version === 4 && stage === 'chapter' && chapterId && blueprint) {
    const selected = blueprint.chapters.filter(chapter => TEXTBOOK_COMPLEX_REASONING.includes(chapter.reasoning as typeof TEXTBOOK_COMPLEX_REASONING[number]))
      .slice(0, policy.complexChapterThinking!.maxChapters);
    if (selected.some(chapter => chapter.id === chapterId)) budget.thinkingMode = 'enabled';
  }
  return budget;
}
export function textbookResponseTruncated(finishReason?: string): boolean {
  return ['length', 'max_tokens'].includes((finishReason || '').toLowerCase());
}
export function textbookModelPolicySummary(value: TextbookModelPolicy): string {
  validateTextbookModelPolicy(value);
  const thought = (stage: TextbookModelStage) => value.stages[stage].thinkingMode === 'enabled' ? '启用' : '关闭';
  const cost = value.costControl || TEXTBOOK_COST_LIMITS;
  const selective = value.version === 4 ? `；章节默认关闭，仅多步推导、算法分析或多机制因果比较按蓝图顺序最多 ${value.complexChapterThinking!.maxChapters} 章启用，缺省关闭，不增加输出额度和重试次数` : '';
  return `输出预算（初始/截断重试上限）：选材 ${value.stages.selection.maxTokens}/${value.stages.selection.retryMaxTokens}、蓝图 ${value.stages.blueprint.maxTokens}/${value.stages.blueprint.retryMaxTokens}、每章 ${value.stages.chapter.maxTokens}/${value.stages.chapter.retryMaxTokens}、质检 ${value.stages.quality.maxTokens}/${value.stages.quality.retryMaxTokens} tokens；同一完整输入仅在明确截断时重试一次，继续执行不重置次数。支持的思考模式：选材${thought('selection')}、蓝图${thought('blueprint')}、章节${thought('chapter')}、质检${thought('quality')}${selective}；其它模型保持其原有行为。累计控制：${cost.maxTotalTokens} tokens（含输入与输出；缺失用量按估算保留），最多 ${cost.maxRequests} 次请求、${cost.maxRepairRounds} 轮内容修订、${cost.maxReviewRechecks} 次报告重检；达到上限保留草稿并停止，不自动追加预算。旧任务升级前用量只能部分恢复，不代表账单。`;
}
