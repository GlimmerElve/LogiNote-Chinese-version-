import type { ReviewEpisodeCapture } from '../memory/types.ts';
import type { CognitionCandidate, CognitionObservation } from './types.ts';
import { parseReviewQuestionIntent } from '../reviewIntentValidation.ts';

/** Exclude non-expressions, not incorrect beliefs. Legacy candidate triage keeps its old minimum. */
export function isCognitionCandidateText(raw: string, minLength = 8): boolean {
  const text = raw.trim();
  const plain = text.replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
  if (plain.length < minLength || /^(好的?|嗯+|哦+|谢谢(?:老师|你)?|(?:我)?(?:明白|知道|了解|懂)了?|收到|我不知道|不知道|不会|ok|okay|thanks|thankyou|yes|no)+$/i.test(plain)) return false;
  if (/[?？]\s*$/.test(text) || /^(请问|为什么|能否|是否|怎么|如何|请(?:你)?(?:解释|告诉|介绍|举例|帮)|what\b|why\b|how\b|could you\b)/i.test(text)) return false;
  if (/^(?:资料|书上|原文|作者|老师|AI|模型)(?:中|里)?(?:说|写道|认为|指出|提到|的回答)/i.test(text)) return false;
  if (text.split('\n').every((line) => !line.trim() || /^\s*>/.test(line))) return false;
  if (/^(?:“[\s\S]*”|「[\s\S]*」|"[\s\S]*"|```[\s\S]*```)\s*[。.!！]?$/.test(text)) return false;
  return true;
}

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('认知候选格式无效');
  return value as Record<string, unknown>;
};
function string(value: unknown, max: number, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) throw new Error('认知候选文本为空或超出限制');
  return value;
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 30) throw new Error('认知候选辅助信息无效');
  return value.map((s) => string(s, 1000));
}
export function parseCognitionObservation(raw: unknown): CognitionObservation {
  const o = object(raw);
  if (o.activityKind !== 'review' || o.role !== 'user') throw new Error('只采集复习中用户的回答原文');
  const activityId = string(o.activityId, 80), messageId = string(o.messageId, 80);
  if (![activityId, messageId].every((id) => /^[A-Za-z0-9_-]+$/.test(id))) throw new Error('认知候选来源 ID 无效');
  const observedAt = string(o.observedAt, 100);
  if (!Number.isFinite(Date.parse(observedAt))) throw new Error('认知候选时间无效');
  if (o.hintLevel !== null && (![0, 1, 2, 3, 4].includes(o.hintLevel as number))) throw new Error('认知候选提示程度无效');
  const targets = strings(o.targetKnowledgeNames);
  const questionIntent = o.questionIntent === undefined ? undefined : parseReviewQuestionIntent(o.questionIntent);
  if (questionIntent && JSON.stringify([...questionIntent.knowledgeTargets].sort()) !== JSON.stringify([...targets].sort())) {
    throw new Error('认知候选的知识点与问题意图不一致');
  }
  return { activityKind: 'review', role: 'user', activityId, messageId, observedAt,
    answer: string(o.answer, 20000), question: string(o.question, 4000, true), noteTitle: string(o.noteTitle, 1000, true),
    ...(o.noteId === undefined ? {} : { noteId: string(o.noteId, 200) }), hintLevel: o.hintLevel as CognitionObservation['hintLevel'],
    consultedMaterialIds: strings(o.consultedMaterialIds), targetKnowledgeNames: targets,
    ...(questionIntent ? { questionIntent } : {}) };
}
export const cognitionCandidateId = (o: CognitionObservation) => `${o.activityId}/${o.messageId}`;
export const cognitionCandidateRecordId = (id: string) => `cognition:${id}`;
export function parseCognitionCandidates(raw: unknown): CognitionCandidate[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error('认知候选库损坏');
  const seen = new Set<string>();
  return raw.map((item) => {
    const c = object(item), id = string(c.id, 161);
    if (!/^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(id) || seen.has(id)) throw new Error('认知候选 ID 重复或无效');
    seen.add(id);
    if (c.status === 'dismissed') return { id, status: 'dismissed' };
    if (c.status === 'accepted') {
      return { id, status: 'accepted', recordId: string(c.recordId, 300) };
    }
    if (c.status !== 'pending') throw new Error('认知候选状态无效');
    const observation = parseCognitionObservation(c.observation);
    const capturedAt = string(c.capturedAt, 100);
    if (cognitionCandidateId(observation) !== id || !Number.isFinite(Date.parse(capturedAt))) throw new Error('认知候选来源损坏');
    return { id, status: 'pending', observation, capturedAt };
  });
}

/** Only matched user messages; never use AI scoring feedback, summary, or uploaded knowledgeContext. */
export function reviewCognitionObservations(episode: ReviewEpisodeCapture, note: { id?: string; title: string }): CognitionObservation[] {
  let question = episode.questionText;
  let questionMessageId = '';
  const result: CognitionObservation[] = [];
  for (const message of episode.messages) {
    if (message.role === 'assistant') { question = message.content; questionMessageId = message.id || ''; continue; }
    if (message.role !== 'user' || !message.id || !isCognitionCandidateText(message.content, 2)) continue;
    const evidence = episode.answerEvidence?.find((item) => item.messageId === message.id && item.answer === message.content);
    if (evidence?.questionIntent) {
      if (!questionMessageId || evidence.questionIntent.questionMessageId !== questionMessageId) {
        throw new Error('回答携带的认知坐标与实际导师问题不匹配');
      }
      const intended = [...evidence.questionIntent.knowledgeTargets].sort();
      const observed = [...evidence.targetKnowledgeNames].sort();
      if (JSON.stringify(intended) !== JSON.stringify(observed)) throw new Error('回答的知识点意图已变化');
    }
    result.push(parseCognitionObservation({ activityKind: 'review', activityId: episode.id, messageId: message.id, role: 'user',
      answer: message.content, question: question.slice(0, 4000), observedAt: message.timestamp,
      noteId: note.id, noteTitle: note.title, hintLevel: evidence?.hintLevel ?? null,
      consultedMaterialIds: evidence?.consultedMaterialIds || [], targetKnowledgeNames: evidence?.targetKnowledgeNames || [],
      ...(evidence?.questionIntent ? { questionIntent: evidence.questionIntent } : {}) }));
  }
  return result;
}
