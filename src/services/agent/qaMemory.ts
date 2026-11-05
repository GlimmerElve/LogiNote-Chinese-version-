import type { LearningEpisode } from '../memory/types';
import { extractQaEvidence } from '../memory/evidenceExtractor';
import type { QaEvidenceResult } from './tools/qaTools';

function compact(value: string, max: number): string {
  const text = value.replace(/\[[ND]\d+\]/g, '').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function readQaEvidenceResult(value: unknown): QaEvidenceResult | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Partial<QaEvidenceResult>;
  if (!Array.isArray(item.sources) || !['sufficient', 'partial', 'insufficient'].includes(item.coverage || '')) return undefined;
  return item as QaEvidenceResult;
}

/** Stores a compact learning event, never the tool snippets or full conversation transcript. */
export function buildQaLearningEpisode(input: {
  question: string;
  answer: string;
  evidence?: QaEvidenceResult;
  now?: string;
  id?: string;
}): LearningEpisode {
  const now = input.now || new Date().toISOString();
  const id = input.id || `agent-qa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const noteCount = input.evidence?.sources.filter((source) => source.type === 'note').length || 0;
  const documentCount = input.evidence?.sources.filter((source) => source.type === 'document').length || 0;
  const coverage = input.evidence?.coverage || 'insufficient';
  const coverageText = coverage === 'sufficient' ? '本地证据较充足' : coverage === 'partial' ? '本地证据部分覆盖' : '本地证据不足';
  // Model-proposed differences must not be recycled as observed cognitive deficits in later memory.
  const answerSummary = input.evidence?.personalCognition ? '' : compact(input.answer, 240);
  const evidence = extractQaEvidence({ episodeId: id, observedAt: now, question: compact(input.question, 500) });
  return {
    id,
    type: 'qa',
    status: 'completed',
    title: `答疑：${compact(input.question, 80)}`,
    startedAt: now,
    endedAt: now,
    goal: compact(input.question, 500),
    summary: `${coverageText}（笔记 ${noteCount}，资料 ${documentCount}）。${answerSummary ? `答复摘要：${answerSummary}` : ''}`,
    unresolvedQuestions: coverage === 'insufficient' ? [compact(input.question, 300)] : undefined,
    evidenceSnippets: evidence.evidenceSnippets,
    profileSignals: evidence.profileSignals,
    createdAt: now,
    updatedAt: now,
  };
}
