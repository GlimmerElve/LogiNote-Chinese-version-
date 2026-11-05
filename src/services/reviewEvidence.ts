import type {
  ConceptEvidence,
  JudgmentEvidence,
  KnowledgePointMasteryResult,
  ReasoningEvidence,
  ReviewAnalysis,
  ReviewRating,
} from '../types';
import type { ReviewAnswerEvidence } from './memory/types';

const MIN_ANSWER_COUNT = 2;
const MIN_ANSWER_CHARS = 40;

function clampScore(value: unknown): number {
  const score = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : 0;
}

function strings(value: unknown, max = 20): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean).slice(0, max)
    : [];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function sanitizeMasteryEvidence(value: unknown): ReviewAnalysis['masteryEvidence'] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = record(value);
  const conceptRaw = record(raw.conceptEvidence);
  const judgmentRaw = record(raw.judgmentEvidence);
  const reasoningRaw = record(raw.reasoningEvidence);
  const conceptEvidence: ConceptEvidence = {
    redefinesInOwnWords: conceptRaw.redefinesInOwnWords === true,
    distinguishesSimilarConcepts: conceptRaw.distinguishesSimilarConcepts === true,
    givesCounterExamples: conceptRaw.givesCounterExamples === true,
    vagueTerms: strings(conceptRaw.vagueTerms),
    conceptErrors: strings(conceptRaw.conceptErrors),
  };
  const judgmentEvidence: JudgmentEvidence = {
    considersConditions: judgmentRaw.considersConditions === true,
    distinguishesFactOpinion: judgmentRaw.distinguishesFactOpinion === true,
    usesQualifiers: judgmentRaw.usesQualifiers === true,
    absolutistCount: Math.max(0, Math.min(20, Math.floor(Number(judgmentRaw.absolutistCount) || 0))),
    judgmentErrors: strings(judgmentRaw.judgmentErrors),
  };
  const reasoningEvidence: ReasoningEvidence = {
    providesPremises: reasoningRaw.providesPremises === true,
    completeChain: reasoningRaw.completeChain === true,
    identifiesAssumptions: reasoningRaw.identifiesAssumptions === true,
    distinguishesDeductiveInductive: reasoningRaw.distinguishesDeductiveInductive === true,
    considersCounterfactuals: reasoningRaw.considersCounterfactuals === true,
    fallacyTypes: strings(reasoningRaw.fallacyTypes),
  };
  return { conceptEvidence, judgmentEvidence, reasoningEvidence };
}

export interface ReviewEvidenceSummary {
  answerCount: number;
  answerChars: number;
  independentAnswerCount: number;
  maxHintLevel: number;
  masteryEligible: boolean;
}

export function summarizeReviewEvidence(evidence: ReviewAnswerEvidence[]): ReviewEvidenceSummary {
  const answerCount = evidence.length;
  const answerChars = evidence.reduce((sum, item) => sum + item.answer.trim().length, 0);
  const independentAnswerCount = evidence.filter((item) => item.hintLevel === 0).length;
  const maxHintLevel = evidence.reduce((max, item) => Math.max(max, item.hintLevel), 0);
  return {
    answerCount,
    answerChars,
    independentAnswerCount,
    maxHintLevel,
    masteryEligible: answerCount >= MIN_ANSWER_COUNT
      && answerChars >= MIN_ANSWER_CHARS
      && independentAnswerCount >= 1,
  };
}

export function reviewEvidenceRequirement(summary: ReviewEvidenceSummary): string {
  if (summary.answerCount < MIN_ANSWER_COUNT) return `至少完成 ${MIN_ANSWER_COUNT} 轮实质作答`;
  if (summary.answerChars < MIN_ANSWER_CHARS) return `有效作答共至少 ${MIN_ANSWER_CHARS} 字`;
  if (summary.independentAnswerCount < 1) return '至少完成 1 轮无提示作答';
  return '';
}

function ratingFromAverage(average: number): ReviewRating {
  if (average < 40) return 'again';
  if (average < 60) return 'hard';
  if (average < 80) return 'good';
  return 'easy';
}

function boundedText(value: unknown, max = 300): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/** Runtime trust boundary for model-generated scoring JSON. */
export function normalizeReviewAnalysis(value: unknown): ReviewAnalysis {
  if (!value || typeof value !== 'object') throw new Error('评分结果不是对象');
  const raw = value as Partial<ReviewAnalysis>;
  const accuracyScore = clampScore(raw.accuracyScore);
  const completenessScore = clampScore(raw.completenessScore);
  const logicScore = clampScore(raw.logicScore);
  const relevanceScore = clampScore(raw.relevanceScore);
  // 准确性优先；完整性与推理其次；关联迁移不能掩盖事实性错误。
  const average = accuracyScore * 0.35
    + completenessScore * 0.25
    + logicScore * 0.25
    + relevanceScore * 0.15;
  const evidenceRaw = record(raw.scoreEvidence);
  const confidenceValue = Number(raw.confidence);
  return {
    accuracyScore,
    completenessScore,
    logicScore,
    relevanceScore,
    overallRating: ratingFromAverage(average),
    feedback: typeof raw.feedback === 'string' ? raw.feedback.trim().slice(0, 500) : '',
    suggestion: typeof raw.suggestion === 'string' ? raw.suggestion.trim().slice(0, 500) : '',
    missingKnowledge: strings(raw.missingKnowledge),
    scoreEvidence: {
      accuracy: boundedText(evidenceRaw.accuracy),
      completeness: boundedText(evidenceRaw.completeness),
      logic: boundedText(evidenceRaw.logic),
      relevance: boundedText(evidenceRaw.relevance),
    },
    confidence: Number.isFinite(confidenceValue) ? Math.max(0, Math.min(1, confidenceValue)) : undefined,
    masteryEvidence: sanitizeMasteryEvidence(raw.masteryEvidence),
  };
}

function scalePositive(value: number, factor: number): number {
  return value > 0 ? value * factor : value;
}

/** Strong hints may preserve negative evidence, but never create positive mastery evidence by themselves. */
export function calibrateProjectMasteryByHints(
  results: KnowledgePointMasteryResult[],
  evidence: ReviewAnswerEvidence[],
): KnowledgePointMasteryResult[] {
  return results.flatMap((result) => {
    const related = evidence.filter((item) => item.targetKnowledgeNames.includes(result.name));
    if (related.length === 0) return [];
    const factor = related.reduce((sum, item) => (
      sum + (item.hintLevel === 0 ? 1 : item.hintLevel <= 2 ? 0.5 : 0)
    ), 0) / related.length;
    const conceptDelta = scalePositive(result.conceptDelta, factor);
    const judgmentDelta = scalePositive(result.judgmentDelta, factor);
    const reasoningDelta = scalePositive(result.reasoningDelta, factor);
    const hasEvidence = conceptDelta !== 0 || judgmentDelta !== 0 || reasoningDelta !== 0;
    return [{
      ...result,
      conceptDelta,
      judgmentDelta,
      reasoningDelta,
      level: hasEvidence ? result.level : 'none',
      comment: factor === 1
        ? result.comment
        : factor > 0
          ? `部分依赖提示；${result.comment || '需要无提示巩固'}`
          : '仅在强提示后完成，不计正向掌握证据',
    }];
  });
}
