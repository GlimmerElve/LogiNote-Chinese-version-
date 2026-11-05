import {communityReviewEligible} from './community/resourceImport';
import { NoteItem, KnowledgePointDsr, ReviewBubbleCard, ReviewRating } from '../types';
import { collectProjectKnowledgeNotes } from './knowledgePointSelector';
import { readKnowledgeMastery, masteryReadMode, type KnowledgeMasteryView } from './masteryReadModel';

export function calculateRetrievability(stability: number, lastReviewedAt: string | null, now = Date.now()): number {
  if (!lastReviewedAt) return 0.1;
  const last = new Date(lastReviewedAt).getTime();
  const tDays = Math.max(0, (now - last) / (1000 * 60 * 60 * 24));
  return Math.exp(-tDays / Math.max(stability, 0.1));
}

export function calculateForgetScore(r: number): number {
  return Math.max(0, Math.min(1, 1 - r));
}

export function ratingToNumber(rating: ReviewRating): number {
  switch (rating) {
    case 'again': return 1;
    case 'hard': return 2;
    case 'good': return 3;
    case 'easy': return 4;
  }
}

export function updateStability(currentS: number, G: number, R: number, avgScore?: number): number {
  if (avgScore !== undefined && avgScore < 40) {
    return Math.max(0.5, currentS * 0.9);
  }
  if (avgScore !== undefined && avgScore < 60) {
    return currentS;
  }
  const factor = 1 + 0.3 * (G - 3) * (1 - R) * Math.pow(currentS / 10, 0.5);
  return Math.max(0.5, currentS * factor);
}

export function updateDifficulty(currentD: number, G: number, reviewCount: number): number {
  if (reviewCount === 0) {
    return Math.min(10, Math.max(1, 5.0 + (4 - G) * 0.5));
  }
  const delta = 0.1 * (4 - G - (currentD - 5) / 5);
  return Math.min(10, Math.max(1, currentD + delta));
}

export interface KnowledgeReviewTarget extends ReviewBubbleCard {
  kind: 'knowledge';
  needsFirstReview: boolean;
  reason: string;
  riskScore: number;
  mastery?: KnowledgeMasteryView;
}

export interface ProjectReviewTarget {
  kind: 'project';
  noteId: string;
  noteTitle: string;
  knowledgeNoteIds: string[];
  dueKnowledgeCount: number;
  reason: string;
  riskScore: number;
}

export interface ReviewSchedule {
  knowledge: KnowledgeReviewTarget[];
  projects: ProjectReviewTarget[];
}

export type KnowledgeReviewStrategy = 'smart' | 'weak' | 'random';

interface KnowledgeReviewCandidateResult {
  target: KnowledgeReviewTarget;
  due: boolean;
}

function buildAllKnowledgeReviewTargets(notes: NoteItem[], now = Date.now()): KnowledgeReviewCandidateResult[] {
  const knowledgeNotes = notes.filter(n => n.noteType === 'knowledge' && communityReviewEligible(n));
  return knowledgeNotes.map((n): KnowledgeReviewCandidateResult => {
    const dsr = n.dsrState || { difficulty: 5, stability: 2, lastReviewedAt: null, reviewCount: 0, consecutiveCorrect: 0, consecutiveWrong: 0 };
    const needsFirstReview = !dsr.lastReviewedAt || !Number.isFinite(Date.parse(dsr.lastReviewedAt));
    const retrievability = calculateRetrievability(dsr.stability, dsr.lastReviewedAt, now);
    const forgetScore = calculateForgetScore(retrievability);
    if (masteryReadMode() === 'current') {
      const mastery = readKnowledgeMastery(n, { now });
      return { due: mastery.contentStatus === 'ready' && mastery.reviewCategory !== 'stable',
        target: { kind: 'knowledge', needsFirstReview, noteId: n.id, noteTitle: n.title, questionText: '', forgetScore,
          retrievability, difficulty: dsr.difficulty, stability: dsr.stability,
          mastery, reason: `${needsFirstReview ? '待首次复习 · ' : ''}${mastery.displayLabel} · ${mastery.nextAction}`,
          riskScore: mastery.reviewPriority / 100 } };
    }
    const trustedMastery = (dsr.conceptMasterySamples || 0) >= 2 ? dsr.conceptMastery : undefined;
    const due = needsFirstReview
      || dsr.consecutiveWrong >= 2
      || retrievability < 0.6
      || (trustedMastery !== undefined && trustedMastery < 55 && retrievability < 0.8);
    const reason = needsFirstReview
      ? '待首次复习'
      : dsr.consecutiveWrong >= 2
        ? `连续错误 ${dsr.consecutiveWrong} 次`
        : retrievability < 0.4
          ? `当前可提取率 ${Math.round(retrievability * 100)}%`
          : trustedMastery !== undefined && trustedMastery < 55
            ? `概念掌握度 ${Math.round(trustedMastery)}%`
            : `当前可提取率 ${Math.round(retrievability * 100)}%`;
    const masteryRisk = trustedMastery === undefined ? 0.5 : 1 - trustedMastery / 100;
    const riskScore = 0.6 * forgetScore + 0.25 * masteryRisk + 0.15 * Math.min(1, dsr.consecutiveWrong / 2);
    return {
      due,
      target: {
        kind: 'knowledge',
        needsFirstReview,
        noteId: n.id,
        noteTitle: n.title,
        questionText: '',
        forgetScore,
        retrievability,
        difficulty: dsr.difficulty,
        stability: dsr.stability,
        conceptMastery: n.dsrState?.conceptMastery,
        reason,
        riskScore,
      },
    };
  });
}

function buildKnowledgeReviewTargets(notes: NoteItem[], now = Date.now()): KnowledgeReviewTarget[] {
  return buildAllKnowledgeReviewTargets(notes, now)
    .filter((item) => item.due)
    .map((item) => item.target);
}

function eligibleKnowledgeReviewCandidates(notes: NoteItem[], now: number): KnowledgeReviewTarget[] {
  return buildAllKnowledgeReviewTargets(notes, now).map(item => item.target)
    .filter(item => !item.mastery || item.mastery.contentStatus === 'ready');
}

const WEAK_REVIEW_CATEGORIES = new Set(['verify', 'confirm', 'strengthen']);

function isWeakReviewCandidate(target: KnowledgeReviewTarget): boolean {
  // No observation is not evidence of weakness. Imported estimates retain their
  // explicit verify/confirm categories; stable and memory-only refreshes stay out.
  return target.mastery ? WEAK_REVIEW_CATEGORIES.has(target.mastery.reviewCategory)
    : (target.conceptMastery ?? 50) < 60;
}

/** Statistics use the same eligible pool and weak predicate as the actual selector.
 * A random candidate need not be due today; it does need an available reference body. */
export function summarizeKnowledgeReviewPool(notes: NoteItem[], now = Date.now()): {
  eligibleCount: number; weakCount: number; randomCount: number;
} {
  const candidates = eligibleKnowledgeReviewCandidates(notes, now);
  return { eligibleCount: candidates.length, weakCount: candidates.filter(isWeakReviewCandidate).length,
    randomCount: candidates.length };
}

/** The no-history scheduling prior is not evidence that a new note was forgotten. */
export function summarizeKnowledgeReviewMemory(notes: NoteItem[], now = Date.now()): {
  firstReviewCount: number; reviewedCount: number; imminentCount: number; imminentPercent: number | null;
} {
  const candidates = eligibleKnowledgeReviewCandidates(notes, now);
  const reviewed = candidates.filter(target => !target.needsFirstReview);
  const imminentCount = reviewed.filter(target => target.retrievability < 0.6).length;
  return { firstReviewCount: candidates.length - reviewed.length, reviewedCount: reviewed.length,
    imminentCount, imminentPercent: reviewed.length ? Math.round(imminentCount / reviewed.length * 100) : null };
}

/**
 * 复习选择页的三种知识点候选策略。
 * - smart：对全部可用正文知识点按分层状态与遗忘风险排序；
 * - weak：只保留待复核、待确认或需补强的知识点，再按同一优先级排序；
 * - random：对全库可用正文知识点无权重洗牌，不限定今日到期或当前项目。
 */
export function buildKnowledgeReviewCandidates(
  notes: NoteItem[],
  strategy: KnowledgeReviewStrategy,
  now = Date.now(),
  random: () => number = Math.random,
): KnowledgeReviewTarget[] {
  const candidates = eligibleKnowledgeReviewCandidates(notes, now);
  if (strategy === 'smart') {
    return candidates.sort((a, b) => b.riskScore - a.riskScore || a.noteTitle.localeCompare(b.noteTitle));
  }
  if (strategy === 'weak') {
    return candidates.filter(isWeakReviewCandidate).sort((a, b) => {
      if (a.mastery && b.mastery) return b.mastery.reviewPriority - a.mastery.reviewPriority || a.noteTitle.localeCompare(b.noteTitle);
      const masteryA = a.conceptMastery ?? 50;
      const masteryB = b.conceptMastery ?? 50;
      return masteryA - masteryB || b.riskScore - a.riskScore || a.noteTitle.localeCompare(b.noteTitle);
    });
  }
  for (let index = candidates.length - 1; index > 0; index -= 1) {
    const targetIndex = Math.floor(random() * (index + 1));
    [candidates[index], candidates[targetIndex]] = [candidates[targetIndex], candidates[index]];
  }
  return candidates;
}

/** 实时派生两类复习目标，不把复习提醒写成普通 dueDates。 */
export function buildReviewSchedule(notes: NoteItem[], now = Date.now()): ReviewSchedule {
  const knowledge = buildKnowledgeReviewTargets(notes, now)
    .sort((a, b) => b.riskScore - a.riskScore || a.noteTitle.localeCompare(b.noteTitle));
  const dueById = new Map(knowledge.map((target) => [target.noteId, target]));
  // ponytail: 本地笔记库规模下直接复用关联解析；规模显著增大时再建立 project→knowledge 反向索引。
  const projects = notes
    .filter((note) => note.noteType === 'project')
    .flatMap((project): ProjectReviewTarget[] => {
      const related = collectProjectKnowledgeNotes(project.id, notes);
      const dueRelated = related.map((note) => dueById.get(note.id)).filter((item): item is KnowledgeReviewTarget => Boolean(item));
      if (dueRelated.length === 0) return [];
      return [{
        kind: 'project',
        noteId: project.id,
        noteTitle: project.title,
        knowledgeNoteIds: related.map((note) => note.id),
        dueKnowledgeCount: dueRelated.length,
        reason: `${dueRelated.length}/${related.length} 个关联知识点建议复习`,
        riskScore: Math.max(...dueRelated.map((item) => item.riskScore)),
      }];
    })
    .sort((a, b) => b.riskScore - a.riskScore || b.dueKnowledgeCount - a.dueKnowledgeCount);
  return { knowledge, projects };
}

/** 气泡模式只抽取当前到期的全局知识点。 */
export function buildReviewQueue(notes: NoteItem[], now = Date.now()): ReviewBubbleCard[] {
  return buildReviewSchedule(notes, now).knowledge.slice(0, 12);
}

/** 项目复习触及某知识点后刷新其复习状态；难度和稳定性仍由有明确评级的单知识点复习更新。 */
export function applyProjectReviewOutcome(
  dsr: KnowledgePointDsr,
  reviewedAt: string,
  successful: boolean,
): KnowledgePointDsr {
  return {
    ...dsr,
    lastReviewedAt: reviewedAt,
    reviewCount: dsr.reviewCount + 1,
    consecutiveCorrect: successful ? dsr.consecutiveCorrect + 1 : 0,
    consecutiveWrong: successful ? 0 : dsr.consecutiveWrong + 1,
  };
}

/**
 * 计算复习抽取权重：遗忘分为主、概念掌握度为辅。
 * 遗忘分越高（越久没复习）、概念掌握度越低，权重越大（越容易被抽中）。
 */
export function computeReviewWeight(forgetScore: number, conceptMastery?: number): number {
  const mastery = conceptMastery === undefined ? 50 : Math.max(0, Math.min(100, conceptMastery));
  const masteryWeight = 1 - mastery / 100;
  return 0.2 + 0.5 * forgetScore + 0.3 * masteryWeight;
}

/**
 * 轮盘赌加权随机：按 weights 比例随机返回 items 中的一个元素。
 * items 与 weights 长度必须一致且非空；权重全为 0 时均匀回退。
 */
export function weightedPick<T>(items: T[], weights: number[]): T {
  if (items.length === 0) throw new Error('weightedPick: empty items');
  const total = weights.reduce((s, w) => s + Math.max(0, w), 0);
  if (total <= 0) {
    return items[Math.floor(Math.random() * items.length)];
  }
  let r = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    r -= Math.max(0, weights[i]);
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

export function computeLastReferencedAt(targetTitle: string, allNotes: NoteItem[]): string | null {
  let latest: string | null = null;
  const escaped = targetTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`\\[\\[${escaped}\\]\\]`, 'i');
  for (const note of allNotes) {
    if (regex.test(note.content)) {
      if (!latest || note.updatedAt > latest) {
        latest = note.updatedAt;
      }
    }
  }
  return latest;
}

export function coldStartMigration(note: NoteItem, allNotes: NoteItem[]): KnowledgePointDsr {
  if (note.dsrState) return note.dsrState;
  const ageDays = Math.max(0, (Date.now() - new Date(note.createdAt).getTime()) / (1000 * 60 * 60 * 24));
  const refCount = note.links.length + note.backlinks.length;
  let difficulty = 5.0;
  let stability = 2.0;
  if (ageDays > 30 && refCount < 2) {
    difficulty = Math.min(7, 5.0 + ageDays / 60);
    stability = Math.max(0.5, 2.0 - ageDays / 120);
  } else if (refCount >= 3) {
    difficulty = Math.max(3.5, 5.0 - refCount * 0.3);
    stability = Math.min(5, 2.0 + refCount * 0.3);
  }
  return {
    difficulty,
    stability,
    lastReviewedAt: null,
    reviewCount: 0,
    consecutiveCorrect: 0,
    consecutiveWrong: 0,
  };
}

export async function generateBubbleQuestions(
  cards: ReviewBubbleCard[],
  _allNotes: NoteItem[]
): Promise<ReviewBubbleCard[]> {
  if (cards.length === 0) return cards;
  // 批量生成：一次 API 调用传入所有标题
  // 由调用方通过 callLLM 实现
  return cards;
}
