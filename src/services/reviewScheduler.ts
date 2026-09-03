import { NoteItem, KnowledgePointDsr, ReviewBubbleCard, ReviewRating } from '../types';

export function calculateRetrievability(stability: number, lastReviewedAt: string | null): number {
  if (!lastReviewedAt) return 0.1;
  const now = Date.now();
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

export function buildReviewQueue(notes: NoteItem[]): ReviewBubbleCard[] {
  const knowledgeNotes = notes.filter(n => n.noteType === 'knowledge');
  const cards: ReviewBubbleCard[] = knowledgeNotes.map(n => {
    const dsr = n.dsrState || { difficulty: 5, stability: 2, lastReviewedAt: null, reviewCount: 0, consecutiveCorrect: 0, consecutiveWrong: 0 };
    const R = calculateRetrievability(dsr.stability, dsr.lastReviewedAt);
    return {
      noteId: n.id,
      noteTitle: n.title,
      questionText: '',
      forgetScore: calculateForgetScore(R),
      retrievability: R,
      difficulty: dsr.difficulty,
      stability: dsr.stability,
      conceptMastery: n.dsrState?.conceptMastery,
    };
  });
  return cards.sort((a, b) => b.forgetScore - a.forgetScore).slice(0, 12);
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
  // 由调用方（ReviewBubbleWall）通过 callLLM 实现
  return cards;
}