import {
  NoteItem,
  KnowledgePointCandidate,
  KnowledgePointMasteryResult,
  ConceptEvidence,
  JudgmentEvidence,
  ReasoningEvidence,
} from '../types';
import { callLLM } from './llmService';
import { matchKnownKnowledgePoints } from './knownKnowledgeMatcher';
import { resolveNoteByTitleOrAlias } from './noteResolver';
import {
  scoreConceptEvidence,
  scoreJudgmentEvidence,
  scoreReasoningEvidence,
  determineMasteryLevel,
  computeLayeredMastery,
} from './profile/scoring/threeLayer';

/** 阶段一返回的 raw 知识点结构（LLM 输出，仅返回 name） */
interface RawKnowledgePoint {
  name?: string;
}

/** 阶段二返回的 raw 证据结构（LLM 输出） */
interface RawMasteryEvidence {
  conceptEvidence?: ConceptEvidence;
  judgmentEvidence?: JudgmentEvidence;
  reasoningEvidence?: ReasoningEvidence;
  comment?: string;
}

/**
 * 阶段一：识别复盘文本中涉及的两类知识点（known/potential）。
 */
export async function discoverKnowledgePoints(
  restateText: string,
  allNotes: NoteItem[],
): Promise<KnowledgePointCandidate[]> {
  const knowledgeNotes = allNotes.filter((n) => n.noteType === 'knowledge');

  // 1) known：纯代码扫描复盘文本，命中标题或别名即识别
  const knownCandidates = matchKnownKnowledgePoints(restateText, knowledgeNotes);

  // 2) potential：交给 LLM 识别复盘文本中除 known 之外的知识点。
  //    不再把全部笔记标题发给 LLM，只给 known 排除名单，降低 LLM 读取与 token 消耗。
  const knownNames = knownCandidates.map((c) => c.name).join('、');
  const userInput =
    `已知知识点名单（known，请不要再重复识别）：${knownNames || '（无）'}\n\n` +
    `复盘文本：\n${restateText}`;

  const knownNameSet = new Set(knownCandidates.map((c) => c.name.toLowerCase()));
  const llmCandidates: KnowledgePointCandidate[] = [];
  try {
    const resp = await callLLM({
      providerId: '',
      model: '',
      workflow: 'knowledge-discovery',
      userInput,
    });

    const list: RawKnowledgePoint[] = resp.parsedJson?.knowledgePoints || [];
    for (let i = 0; i < list.length; i++) {
      const raw = list[i];
      const name = (raw.name || '').trim();
      if (!name) continue;

      // 与本地 known 去重（忽略 LLM 重复返回的 known）
      if (knownNameSet.has(name.toLowerCase())) continue;

      // 与已收集的 LLM 候选去重
      if (llmCandidates.some((c) => c.name.toLowerCase() === name.toLowerCase())) continue;

      // 本地反查：完全相等命中 title 或 alias 则回填规范标题，否则留空（后续自动新建笔记）
      const resolved = resolveNoteByTitleOrAlias(name, knowledgeNotes);

      llmCandidates.push({
        id: `kp-${Date.now()}-${i}`,
        name,
        category: 'potential',
        existingNoteTitle: resolved?.title,
      });
    }
  } catch {
    // LLM 识别失败时不阻塞已知知识点展示
  }

  return [...knownCandidates, ...llmCandidates];
}

/**
 * 阶段二：针对单个知识点提取三层证据锚点并折算为净得分。
 */
export async function scoreKnowledgePointMastery(
  candidate: KnowledgePointCandidate,
  restateText: string,
): Promise<KnowledgePointMasteryResult> {
  const userInput = `知识点名称：${candidate.name}\n\n复盘原文：\n${restateText}`;

  const resp = await callLLM({
    providerId: '',
    model: '',
    workflow: 'knowledge-mastery-scoring',
    userInput,
  });

  const ev: RawMasteryEvidence = resp.parsedJson || {};

  const conceptDelta = scoreConceptEvidence(ev.conceptEvidence);
  const judgmentDelta = scoreJudgmentEvidence(ev.judgmentEvidence);
  const reasoningDelta = scoreReasoningEvidence(ev.reasoningEvidence);

  const layered = computeLayeredMastery(conceptDelta, judgmentDelta, reasoningDelta, 50);
  return {
    name: candidate.name,
    level: layered.level,
    conceptDelta: conceptDelta ?? 0,
    judgmentDelta: judgmentDelta ?? 0,
    reasoningDelta: reasoningDelta ?? 0,
    conceptFinal: layered.conceptFinal,
    judgmentFinal: layered.judgmentFinal,
    reasoningFinal: layered.reasoningFinal,
    comment: (ev.comment || '').slice(0, 30),
    existingNoteTitle: candidate.existingNoteTitle,
  };
}

/**
 * 阶段二并行编排：按并发上限分组，单点失败不拖垮整体。
 */
export async function scoreKnowledgePointsInParallel(
  candidates: KnowledgePointCandidate[],
  restateText: string,
  concurrency: number = 5,
): Promise<KnowledgePointMasteryResult[]> {
  const results: KnowledgePointMasteryResult[] = [];
  const limit = Math.max(1, concurrency);

  for (let i = 0; i < candidates.length; i += limit) {
    const batch = candidates.slice(i, i + limit);
    const settled = await Promise.allSettled(
      batch.map((c) => scoreKnowledgePointMastery(c, restateText)),
    );
    for (const s of settled) {
      if (s.status === 'fulfilled') {
        results.push(s.value);
      }
      // rejected 的知识点静默跳过（不拖垮整体）
    }
  }

  return results;
}