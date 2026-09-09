import { NoteItem } from '../../types';
import { LearningAbility, MasteryTimelineFile, ErrorWeekPoint, ReasoningWeekPoint, StudyWeekPoint, DomainMastery } from './types';
import { MASTERY_LINE } from '../profile/scoring/threeLayer';

/**
 * 学习能力派生计算（纯函数，无 IO）。
 * 从 weeks[]（周报落盘）+ notes（当前知识点）现算六维，不落盘。
 * 口径对齐 P7 设计：
 * - 只统计 noteType === 'knowledge'，绝不把 project 计入；
 * - 周报推理分项存「命中次数 + 分析次数」，命中率在此处派生；
 * - 自律性「学习日」：某天 dailyMinutes ≥ 20 算达标一天；
 * - currentStreak 跨周计算，从最近记录日往前，连续达标天数，断则归零。
 */

const ACTIVE_MINUTES = 20;
const DOMAIN_MASTERED_RATE = 0.6;

/** ① 当前已掌握知识点总数（knowledge 类型，conceptMastery ≥ MASTERY_LINE） */
export function computeMasteredCount(notes: NoteItem[]): number {
  return notes.filter(
    (n) => n.noteType === 'knowledge' && (n.dsrState?.conceptMastery ?? 0) >= MASTERY_LINE,
  ).length;
}

/** 把 weeks[] 的每日分钟展开成「日期 → 分钟」映射（用于跨周连续天数计算） */
function expandDailyMinutes(timeline: MasteryTimelineFile): Map<string, number> {
  const map = new Map<string, number>();
  for (const w of timeline.weeks || []) {
    if (!w.study?.dailyMinutes || w.study.dailyMinutes.length !== 7) continue;
    // 周一日期
    const monday = new Date(w.weekStart + 'T00:00:00');
    if (isNaN(monday.getTime())) continue;
    for (let i = 0; i < 7; i++) {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      map.set(key, w.study.dailyMinutes[i] || 0);
    }
  }
  return map;
}

/** ③ currentStreak：从今天往前数连续达标天数（今天未达标则从昨天开始算） */
export function computeCurrentStreak(timeline: MasteryTimelineFile): number {
  const map = expandDailyMinutes(timeline);
  let streak = 0;
  const today = new Date();
  for (let i = 0; i < 365; i++) {
    const d = new Date(today.getTime() - i * 86400000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const minutes = map.get(key) || 0;
    if (minutes >= ACTIVE_MINUTES) {
      streak += 1;
    } else if (i === 0) {
      // 今天尚未达标，跳过（连续从昨天起算）
      continue;
    } else {
      break;
    }
  }
  return streak;
}

/** ④ 本周/上周新增掌握数 */
function computeNewMastered(timeline: MasteryTimelineFile): { thisWeek: number; lastWeek: number } {
  const weeks = timeline.weeks || [];
  const len = weeks.length;
  if (len === 0) return { thisWeek: 0, lastWeek: 0 };
  const cur = weeks[len - 1].newMastered || 0;
  const prev = len >= 2 ? weeks[len - 2].newMastered || 0 : 0;
  return { thisWeek: cur, lastWeek: prev };
}

/** ⑤ 纠错：10 周错误率趋势 */
function computeErrorWeekly(timeline: MasteryTimelineFile): ErrorWeekPoint[] {
  return (timeline.weeks || []).map((w) => ({
    weekStart: w.weekStart,
    errorRate: w.errorRate || 0,
  }));
}

/** ② 推理分项：10 周「结论粒度占比」趋势（达标结论数 / 结论总数；旧周缺字段按 0） */
function computeReasoningWeekly(timeline: MasteryTimelineFile): ReasoningWeekPoint[] {
  return (timeline.weeks || []).map((w) => {
    const r = (w.reasoning || {}) as Partial<{ totalClaims: number; withPremise: number; completeChain: number; identifiesAssumption: number; deductiveInductive: number; counterfactual: number; fallacyCount: number }>;
    const total = typeof r.totalClaims === 'number' && r.totalClaims > 0 ? r.totalClaims : 0;
    const rate = (n?: number) => (total > 0 && typeof n === 'number' ? n / total : 0);
    return {
      weekStart: w.weekStart,
      premisesRate: rate(r.withPremise),
      completeChainRate: rate(r.completeChain),
      assumptionRate: rate(r.identifiesAssumption),
      deductiveInductiveRate: rate(r.deductiveInductive),
      counterfactualRate: rate(r.counterfactual),
      fallacyCount: typeof r.fallacyCount === 'number' ? r.fallacyCount : 0,
    };
  });
}

/** ③ 自律性：10 周趋势 */
function computeStudyWeekly(timeline: MasteryTimelineFile): StudyWeekPoint[] {
  return (timeline.weeks || []).map((w) => ({
    weekStart: w.weekStart,
    activeDays: w.study?.activeDays || 0,
    totalMinutes: (w.study?.dailyMinutes || []).reduce((a, b) => a + b, 0),
  }));
}

/** 向上追溯某知识点的根项目 id（根项目 = noteType==='project' 且无 parentId） */
function getRootProjectId(noteId: string, notes: NoteItem[]): string | null {
  let current = notes.find((n) => n.id === noteId);
  while (current && current.parentId) {
    const parent = notes.find((n) => n.id === current!.parentId);
    if (!parent) break;
    current = parent;
  }
  return current && current.noteType === 'project' ? current.id : null;
}

/** ⑥ 领域：根项目掌握情况（含根项目名称） */
function computeDomains(notes: NoteItem[]): DomainMastery[] {
  const rootProjects = notes.filter((n) => n.noteType === 'project' && !n.parentId);
  const knowledgeNotes = notes.filter((n) => n.noteType === 'knowledge');
  const domains: DomainMastery[] = [];

  for (const root of rootProjects) {
    const domainKnowledge = knowledgeNotes.filter((n) => getRootProjectId(n.id, notes) === root.id);
    if (domainKnowledge.length === 0) continue;
    const mastered = domainKnowledge.filter((n) => (n.dsrState?.conceptMastery ?? 0) >= MASTERY_LINE).length;
    domains.push({
      projectTitle: root.title,
      masteryRate: domainKnowledge.length > 0 ? mastered / domainKnowledge.length : 0,
      masteredCount: mastered,
      totalCount: domainKnowledge.length,
    });
  }
  return domains;
}

/** 聚合学习能力六维 */
export function aggregateLearningAbility(
  notes: NoteItem[],
  timeline: MasteryTimelineFile,
): LearningAbility {
  const { thisWeek, lastWeek } = computeNewMastered(timeline);
  return {
    masteredCount: computeMasteredCount(notes),
    currentStreak: computeCurrentStreak(timeline),
    newMasteredThisWeek: thisWeek,
    newMasteredLastWeek: lastWeek,
    errorWeekly: computeErrorWeekly(timeline),
    reasoningWeekly: computeReasoningWeekly(timeline),
    studyWeekly: computeStudyWeekly(timeline),
    domains: computeDomains(notes),
  };
}

/** 供外部的掌握率阈值常量（领域「已掌握」判定） */
export { DOMAIN_MASTERED_RATE, ACTIVE_MINUTES };