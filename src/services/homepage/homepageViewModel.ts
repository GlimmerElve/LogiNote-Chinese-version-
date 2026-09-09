import { NoteItem, UserProfile } from '../../types';
import { MasteryTimelineFile } from '../learningAbility/types';
import { MASTERY_LINE } from '../profile/scoring/threeLayer';

/**
 * 主页视图数据聚合层（纯函数，无 IO）。
 * 把 (notes, profile, timeline) 现算为 HomeViewModel，供 HomeView 直接渲染。
 * 所有「趋势 / 学习能力」字段已在 profile.learningAbility 由 refreshLearningAbility 现算好；
 * 本层只做「日历每日明细」「完成项目」「待办」等 notes / timeline 的现算与剪裁。
 */

/** 待办优先级（对齐 notes.dueDates.priority） */
export type HomeTodoPriority = 'high' | 'medium' | 'low';

export interface HomeTodo {
  noteId: string;
  taskId: string;
  noteTitle: string;
  date: string; // YYYY-MM-DD
  text: string;
  priority: HomeTodoPriority;
}

export interface HomeCalendarDay {
  day: number;        // 1..31
  minutes: number;    // 当日学习分钟（心流），0 表示无
  active: boolean;    // 当日是否达标（≥20 分钟 或 复习达标）
  isToday: boolean;
  isFuture: boolean;
}

export interface HomeBipolarAxis {
  left: string;
  right: string;
  value: number; // -100 ~ +100
}

export interface HomeExpressionItem {
  label: string;
  value: number;  // 归一化到 0-100（偏好类 *100，准确率类原值）
}

export interface HomeViewModel {
  // KPI
  streak: number;
  activeDaysThisMonth: number;
  avgDailyMinutes: number;
  todayMinutes: number;
  dailyGoalMinutes: number;
  masteredCount: number;
  completedProjects: number;
  newMasteredThisWeek: number;
  // 能力画像
  layeredAbility: { concept: number; judgment: number; reasoning: number };
  reasoningRates: {
    premises: number;
    completeChain: number;
    assumption: number;
    deductiveInductive: number;
    counterfactual: number;
  };
  // 错误率折线（近 10 周）
  errorWeekly: number[];
  /** 有至少一次复盘分析的周数，用于趋势图的可用性说明。 */
  errorTrendWeeks: number;
  /** 当前周已收集的有效样本数（即 totalClaims，结论总数）。 */
  currentWeekTotalClaims: number;
  // 学习足迹日历
  calendar: HomeCalendarDay[];
  calYear: number;
  calMonth: number; // 1..12
  // 双极认知风格
  bipolar: HomeBipolarAxis[];
  // 表达风格
  expression: HomeExpressionItem[];
  // 待办
  todos: HomeTodo[];
}

const ACTIVE_MINUTES = 20;

function currentWeekStart(): string {
  const now = new Date();
  const mondayOffset = now.getDay() === 0 ? -6 : 1 - now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() + mondayOffset);
  return `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
}

/** 把 weeks[].study 的每日分钟/复习达标展开成「YYYY-MM-DD → 分钟 / 达标」 */
function expandDaily(
  timeline: MasteryTimelineFile,
): Map<string, { minutes: number; activated: boolean }> {
  const map = new Map<string, { minutes: number; activated: boolean }>();
  for (const w of timeline.weeks || []) {
    const minutes = (w.study && w.study.dailyMinutes) || [];
    const review = (w.study && w.study.dailyReviewActive) || [];
    if (minutes.length !== 7) continue;
    const monday = new Date(w.weekStart + 'T00:00:00');
    if (isNaN(monday.getTime())) continue;
    for (let i = 0; i < 7; i++) {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const m = minutes[i] || 0;
      const activated = m >= ACTIVE_MINUTES || review[i] === 1;
      map.set(key, { minutes: m, activated });
    }
  }
  return map;
}

/** 根项目整树是否全部完成 */
function isProjectFullyCompleted(root: NoteItem, notes: NoteItem[]): boolean {
  const stack = [root];
  const dueDates: { completed: boolean }[] = [];
  while (stack.length) {
    const cur = stack.pop()!;
    dueDates.push(...(cur.dueDates || []));
    const children = notes.filter((n) => n.parentId === cur.id);
    stack.push(...children);
  }
  if (dueDates.length === 0) return false;
  return dueDates.every((d) => d.completed);
}

/** 已完成的根项目数 */
function countCompletedProjects(notes: NoteItem[]): number {
  const roots = notes.filter((n) => n.noteType === 'project' && !n.parentId);
  return roots.filter((r) => isProjectFullyCompleted(r, notes)).length;
}

/** 未完成待办（按 dueDate 升序，截取前 6 条；逾期判断由展示层用 date 与当天比较） */
function collectTodos(notes: NoteItem[]): HomeTodo[] {
  const items: HomeTodo[] = [];
  for (const n of notes) {
    for (const d of n.dueDates || []) {
      if (d.completed) continue;
      items.push({
        noteId: n.id,
        taskId: d.id,
        noteTitle: n.title,
        date: d.dueDate,
        text: d.taskText || n.title,
        priority: d.priority,
      });
    }
  }
  items.sort((a, b) => a.date.localeCompare(b.date));
  return items.slice(0, 6);
}

/** 当月日历：本月每天的学习分钟与达标状态 */
function buildCalendar(
  daily: Map<string, { minutes: number; activated: boolean }>,
): { days: HomeCalendarDay[]; year: number; month: number } {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-11
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayD = now.getDate();
  const days: HomeCalendarDay[] = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const key = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const rec = daily.get(key) || { minutes: 0, activated: false };
    days.push({
      day: d,
      minutes: rec.minutes,
      active: rec.activated,
      isToday: d === todayD,
      isFuture: d > todayD,
    });
  }
  return { days, year, month: month + 1 };
}

/** 当月活跃天数 + 日均分钟 */
function computeMonthStats(
  days: HomeCalendarDay[],
): { activeDays: number; avgDaily: number } {
  const activeDays = days.filter((d) => d.active).length;
  const totalMinutes = days.reduce((s, d) => s + d.minutes, 0);
  const avgDaily = activeDays > 0 ? Math.round(totalMinutes / activeDays) : 0;
  return { activeDays, avgDaily };
}

/** 聚合主页 viewModel */
export function buildHomeViewModel(
  notes: NoteItem[],
  profile: UserProfile,
  timeline: MasteryTimelineFile,
): HomeViewModel {
  const la = profile.learningAbility;

  // 日历
  const daily = expandDaily(timeline);
  const cal = buildCalendar(daily);
  const { activeDays, avgDaily } = computeMonthStats(cal.days);

  // 推理子项占比（取本周；本周无结论则全 0）
  const rw = la.reasoningWeekly || [];
  const thisWeekReasoning = rw.find((p) => p.weekStart === currentWeekStart()) || null;

  // 错误率趋势只纳入真正有过结论分析的周，避免把仅有学习时长的周误画成 0 错误率。
  const analyzedWeeks = (timeline.weeks || []).filter((w) => (w.reasoning?.totalClaims || 0) > 0);
  const errorWeekly = analyzedWeeks.map((w) => w.errorRate || 0);
  const currentWeekTotalClaims = (timeline.weeks || [])
    .find((w) => w.weekStart === currentWeekStart())
    ?.reasoning?.totalClaims || 0;

  // 三层能力
  const ability = profile.ability;

  // 双极认知风格（-100~+100）
  const cs = profile.cognitiveStyle;
  const bipolar: HomeBipolarAxis[] = [
    { left: '具象', right: '抽象', value: cs.abstractVsConcrete },
    { left: '零散', right: '系统', value: cs.systematicVsScattered },
    { left: '收敛', right: '发散', value: cs.divergentVsConvergent },
    { left: '武断', right: '谨慎', value: cs.cautiousVsDogmatic },
    { left: '表面', right: '深度', value: cs.deepVsSurface },
  ];

  // 表达风格（偏好类 0-1 → 0-100；准确率类原值 0-100）
  const es = profile.expressionStyle;
  const pct = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 100);
  const expression: HomeExpressionItem[] = [
    { label: '偏好举例', value: pct(es.prefersExample) },
    { label: '偏好类比', value: pct(es.prefersAnalogy) },
    { label: '偏好定义', value: pct(es.prefersDefinition) },
    { label: '偏好推导', value: pct(es.prefersDerivation) },
    { label: '结论先行', value: pct(es.conclusionFirst) },
    { label: '术语准确', value: es.terminologyAccuracy },
    { label: '自我修正', value: es.selfCorrection },
  ];

  return {
    streak: la.currentStreak || 0,
    activeDaysThisMonth: activeDays,
    avgDailyMinutes: avgDaily,
    todayMinutes: cal.days.find((d) => d.isToday)?.minutes || 0,
    // 首页先使用明确且可解释的默认目标；后续可升级为用户可配置项。
    dailyGoalMinutes: 45,
    masteredCount: la.masteredCount || 0,
    completedProjects: countCompletedProjects(notes),
    newMasteredThisWeek: la.newMasteredThisWeek || 0,
    layeredAbility: {
      concept: ability.conceptClarity,
      judgment: ability.judgmentReasonableness,
      reasoning: ability.reasoningValidity,
    },
    reasoningRates: {
      premises: thisWeekReasoning ? Math.round(thisWeekReasoning.premisesRate * 100) : 0,
      completeChain: thisWeekReasoning ? Math.round(thisWeekReasoning.completeChainRate * 100) : 0,
      assumption: thisWeekReasoning ? Math.round(thisWeekReasoning.assumptionRate * 100) : 0,
      deductiveInductive: thisWeekReasoning ? Math.round(thisWeekReasoning.deductiveInductiveRate * 100) : 0,
      counterfactual: thisWeekReasoning ? Math.round(thisWeekReasoning.counterfactualRate * 100) : 0,
    },
    errorWeekly,
    errorTrendWeeks: analyzedWeeks.length,
    currentWeekTotalClaims,
    calendar: cal.days,
    calYear: cal.year,
    calMonth: cal.month,
    bipolar,
    expression,
    todos: collectTodos(notes),
  };
}

// 复用阈值的导出，供展示层统一「已掌握」口径
export { MASTERY_LINE };
