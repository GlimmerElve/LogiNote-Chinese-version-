import type { ReviewEpisodeCapture } from '../memory/types';
import type { ReviewComparisonAnswer, ReviewComparisonDependencies, ReviewComparisonPacket,
  ReviewComparisonSession, ReviewComparisonSummary } from './types';
import { buildReviewComparisonPacket, verifyReviewComparisonFreshness } from './packet.ts';

/** A repeated or forged message ID must never move an answer to another tutor question. */
export function reviewComparisonAnswers(episode: ReviewEpisodeCapture): ReviewComparisonAnswer[] {
  const seen = new Set<string>();
  const result: ReviewComparisonAnswer[] = [];
  let question: { id: string; text: string } | undefined;
  for (const message of episode.messages) {
    if (!message.id) { if (message.role === 'assistant') question = undefined; continue; }
    if (seen.has(message.id)) throw new Error('复习消息 ID 重复，不能建立可信比对');
    seen.add(message.id);
    if (message.role === 'assistant') { question = { id: message.id, text: message.content }; continue; }
    const matched = (episode.answerEvidence || []).filter((evidence) => evidence.messageId === message.id);
    if (matched.length > 1) throw new Error('复习回答证据重复');
    const evidence = matched[0];
    if (!evidence?.questionIntent) continue; // Legacy activities have no frozen intent; do not guess one.
    if (evidence.answer !== message.content || question?.id !== evidence.questionIntent.questionMessageId) {
      throw new Error('复习回答与问题意图不匹配');
    }
    result.push({ activityId: episode.id, questionText: question.text,
      evidence: { ...structuredClone(evidence), messageId: message.id, questionIntent: structuredClone(evidence.questionIntent) } });
  }
  return result;
}

export function summarizeReviewComparison(
  packets: ReviewComparisonPacket[], omittedAnswers: number, additionalReasons: string[] = [],
): ReviewComparisonSummary {
  const holdReasons = [...new Set([...additionalReasons, ...packets.flatMap((packet) => [
    ...packet.preparation.growthReasons, ...packet.preparation.masteryReasons, ...packet.preparation.warnings,
  ])])];
  const referencesAvailable = packets.filter((packet) => packet.coverage.referencePresence === 'available').length;
  return { version: 1, status: !packets.length ? 'unavailable' : omittedAnswers || holdReasons.length ? 'partial' : 'prepared',
    preparedAnswers: packets.length, omittedAnswers, referencesAvailable,
    cognitionTargetsResolved: packets.filter((packet) => packet.personal.status === 'ready').length,
    holdReasons, snapshots: packets.map(({ packetId, snapshotHash }) => ({ packetId, snapshotHash })) };
}

/** Bounded local preparation; caches last for this activity operation only, never across revisions. */
export async function prepareReviewComparisonSession(
  episode: ReviewEpisodeCapture,
  dependencies: ReviewComparisonDependencies,
  options: { targetScopeNoteIds: string[]; maxAnswers?: number },
): Promise<ReviewComparisonSession> {
  const answers = reviewComparisonAnswers(episode);
  const count = Math.max(1, Math.min(12, Math.floor(options.maxAnswers || 12)));
  const selected = answers.slice(-count);
  let notes: ReturnType<ReviewComparisonDependencies['readNotes']> | undefined;
  let cognition: ReturnType<ReviewComparisonDependencies['loadCognition']> | undefined;
  const documentReads = new Map<string, ReturnType<ReviewComparisonDependencies['previewDocument']>>();
  const cached: ReviewComparisonDependencies = {
    ...dependencies,
    readNotes: () => notes ||= dependencies.readNotes(),
    loadCognition: () => cognition ||= dependencies.loadCognition(),
    previewDocument: (docId, chunkId) => {
      const key = JSON.stringify([docId, chunkId]);
      if (!documentReads.has(key)) documentReads.set(key, dependencies.previewDocument(docId, chunkId));
      return documentReads.get(key)!;
    },
  };
  const packets: ReviewComparisonPacket[] = [];
  const failures: string[] = [];
  for (let index = 0; index < selected.length; index += 2) {
    const batch = await Promise.allSettled(selected.slice(index, index + 2).map((answer) => buildReviewComparisonPacket(answer, cached, options)));
    for (const result of batch) {
      if (result.status === 'fulfilled') packets.push(result.value);
      else failures.push('packet_preparation_failed');
    }
  }
  // A preparation failure preserves answers and becomes an explicit omission, not a score.
  const omitted = (episode.answerEvidence || []).length - packets.length;
  const summary = summarizeReviewComparison(packets, Math.max(0, omitted), failures);
  if (answers.length > count) summary.holdReasons.push('answer_budget_exceeded');
  if ((episode.answerEvidence || []).some((answer) => !answer.questionIntent)) summary.holdReasons.push('legacy_intent_unavailable');
  return { packets, summary };
}

export async function recheckReviewComparisonSession(
  session: ReviewComparisonSession, dependencies: ReviewComparisonDependencies,
): Promise<ReviewComparisonSummary> {
  const reasons: string[] = [];
  // Deliberately do not reuse preparation's cache: recheck current authority.
  for (const packet of session.packets) {
    const freshness = await verifyReviewComparisonFreshness(packet, dependencies);
    reasons.push(...freshness.reasons);
  }
  return summarizeReviewComparison(session.packets, session.summary.omittedAnswers,
    [...session.summary.holdReasons, ...reasons]);
}
