import { NoteItem, UserProfile } from '../../types';
import { isLearningProject } from '../projectRole';
import { MasteryTimelineFile } from '../learningAbility/types';
import { analysisWeeks } from '../profile/flowStatistics';
import { MASTERY_LINE } from '../profile/scoring/threeLayer';
import { buildReviewSchedule } from '../reviewScheduler';
import { summarizeKnowledgeMastery } from '../masteryReadModel';
import {computeCurrentStreak} from '../learningAbility/aggregator';
import { partitionFlowProfileEvidence } from '../profile/evidenceGateCore';
import {
  buildHomeScheduledTasks, compareHomePendingTasks, homeCalendarDay, homeLocalDate, isHomeRootActionable,
  type HomeTaskLaunch,
} from './homeTaskScheduling';
export type { HomeTaskLaunch } from './homeTaskScheduling';

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
  actionDate: string;
  launch: HomeTaskLaunch;
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

export interface HomeFocusProject {
  /** 当前首页卡片所聚合的根项目。 */
  noteId: string;
  /** “下一步”任务实际所属或明确关联的项目笔记。 */
  nextNoteId: string | null;
  nextTaskId: string | null;
  nextLaunch: HomeTaskLaunch | null;
  /** Future steps are previews, not permission to start before their action day. */
  nextActionDate: string | null;
  title: string;
  nextTask: string | null;
  nearestDueDate: string | null;
  completedTasks: number;
  totalTasks: number;
  progress: number;
}

export interface HomeReviewEcho {
  noteId: string;
  title: string;
  reason: string;
  retrievability: number;
  conceptMastery?: number;
}

export interface HomeViewModel {
  // KPI
  streak: number;
  activeDaysThisMonth: number;
  avgDailyMinutes: number;
  todayMinutes: number;
  dailyGoalMinutes: number;
  masteredCount: number;
  knowledgeMastery: ReturnType<typeof summarizeKnowledgeMastery>;
  completedProjects: number;
  newMasteredThisWeek: number;
  // 能力画像
  layeredAbility: { concept: number | null; judgment: number | null; reasoning: number | null };
  abilityEvidenceStatus: 'empty' | 'collecting' | 'available';
  // 错误率折线（近 10 周）
  errorWeekly: number[];
  /** 有至少一次复盘分析的周数，用于趋势图的可用性说明。 */
  errorTrendWeeks: number;
  // 学习足迹日历
  calendar: HomeCalendarDay[];
  calYear: number;
  calMonth: number; // 1..12
  // 双极认知风格
  bipolar: HomeBipolarAxis[];
  // 待办
  todos: HomeTodo[];
  // 极简首页主任务：根项目整棵子树的真实任务完成度
  focusProject: HomeFocusProject | null;
  // DSR 实时调度出的待复习知识点
  reviewEchoes: HomeReviewEcho[];
}

const ACTIVE_MINUTES = 20;

/** The internal 50-point prior supports scoring; it is not an observation.
 * Expose only dimensions backed by admitted evidence, without changing stored
 * scores or making a missing dimension look like a zero score. */
export function homeAbilityDisplay(profile: UserProfile): Pick<HomeViewModel, 'layeredAbility' | 'abilityEvidenceStatus'> {
  const ability = profile.ability;
  const gates = Object.values(partitionFlowProfileEvidence(profile).evidenceGate?.aggregates || {})
    .filter(aggregate => aggregate.dimension === 'ability' && aggregate.samples.length > 0);
  const hasGateRecords = (profile.evidenceGate?.processedEpisodeIds?.length || 0) > 0 || gates.length > 0;
  const read = (indicator: 'conceptClarity' | 'judgmentReasonableness' | 'reasoningValidity'): number | null => {
    const value = ability[indicator];
    if (!Number.isFinite(value) || value < 0 || value > 100) return null;
    if (!hasGateRecords) return ability.evidenceCount >= 2 && ability.evidenceChars >= 300 ? value : null;
    const latest = gates.filter(aggregate => aggregate.indicator === indicator)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    return latest?.status === 'trusted' ? value : null;
  };
  const layeredAbility = { concept: read('conceptClarity'), judgment: read('judgmentReasonableness'), reasoning: read('reasoningValidity') };
  return { layeredAbility, abilityEvidenceStatus: Object.values(layeredAbility).some(value => value !== null) ? 'available'
    : gates.length > 0 || ability.evidenceCount > 0 ? 'collecting' : 'empty' };
}

export function homeAbilitySummary(vm: Pick<HomeViewModel, 'layeredAbility' | 'abilityEvidenceStatus'>): string {
  const values = vm.layeredAbility;
  if (Object.values(values).every(value => value === null)) return vm.abilityEvidenceStatus === 'collecting'
    ? '能力证据积累中，暂不显示分数' : '暂无能力分析记录';
  const score = (value: number | null) => value === null ? '—' : String(Math.round(value));
  return `概念 ${score(values.concept)} · 判断 ${score(values.judgment)} · 推理 ${score(values.reasoning)}`;
}

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

/** 已完成的根项目数 */
function countCompletedProjects(notes: NoteItem[], today: string): number {
  const scheduled = buildHomeScheduledTasks(notes, today);
  const rootIds = new Set(scheduled.map(row => row.rootId));
  return [...rootIds].filter(rootId => {
    const rows = scheduled.filter(row => row.rootId === rootId);
    const counted = rows.filter(row => row.progressEligible);
    return counted.length > 0 && counted.every(row => row.completed) && rows.every(row => !row.pendingDate);
  }).length;
}

/**
 * 首页只展示一个根项目。进度来自末级结构工作与今天的有效周期当次，
 * 不把阅读时长、打开次数或笔记字数近似成“阅读进度”。
 */
export function buildHomeFocusProject(notes: NoteItem[], today = homeLocalDate()): HomeFocusProject | null {
  if (homeCalendarDay(today) === null) return null;
  const scheduled = buildHomeScheduledTasks(notes, today);
  const projectIds = new Set(notes.filter(isLearningProject).map(note => note.id));
  const roots = notes.filter(note => isLearningProject(note) && (!note.parentId || !projectIds.has(note.parentId)))
    .filter(note => isHomeRootActionable(note) || note.planMeta?.status === 'completed')
    .filter(note => scheduled.some(row => row.rootId === note.id) || Boolean(note.planMeta));
  const projects = roots.map((root) => {
    const tasks = scheduled.filter(row => row.rootId === root.id);
    const pending = tasks
      .filter(row => row.launch && isHomeRootActionable(root))
      .sort(compareHomePendingTasks);
    const next = pending[0];
    const nextLaunch = next?.launch || null;
    const counted = tasks.filter(row => row.progressEligible);
    const completedTasks = counted.filter(row => row.completed).length;
    const totalTasks = counted.length;
    return {
      noteId: root.id,
      nextNoteId: nextLaunch?.noteId || null,
      nextTaskId: next?.taskId || null,
      nextLaunch,
      nextActionDate: next?.actionDate || null,
      title: root.title,
      nextTask: next?.text || null,
      nearestDueDate: next?.pendingDate || null,
      completedTasks,
      totalTasks,
      progress: totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0,
      isComplete: totalTasks > 0 && completedTasks === totalTasks && tasks.every(row => !row.pendingDate),
      actionable: isHomeRootActionable(root),
      updatedAt: root.updatedAt,
    };
  });

  projects.sort((a, b) => {
    if (a.actionable !== b.actionable) return a.actionable ? -1 : 1;
    if (a.isComplete !== b.isComplete) return a.isComplete ? 1 : -1;
    if (a.nextActionDate && b.nextActionDate && a.nextActionDate !== b.nextActionDate) return a.nextActionDate.localeCompare(b.nextActionDate);
    if (a.nearestDueDate && b.nearestDueDate) return a.nearestDueDate.localeCompare(b.nearestDueDate);
    if (a.nearestDueDate) return -1;
    if (b.nearestDueDate) return 1;
    return b.updatedAt.localeCompare(a.updatedAt);
  });

  const selected = projects[0];
  if (!selected) return null;
  return {
    noteId: selected.noteId,
    nextNoteId: selected.nextNoteId,
    nextTaskId: selected.nextTaskId,
    nextLaunch: selected.nextLaunch,
    nextActionDate: selected.nextActionDate,
    title: selected.title,
    nextTask: selected.nextTask,
    nearestDueDate: selected.nearestDueDate,
    completedTasks: selected.completedTasks,
    totalTasks: selected.totalTasks,
    progress: selected.progress,
  };
}

/** Shared pending identities, ordered by actionable day then real deadline, capped at six. */
export function collectTodos(notes: NoteItem[], today = homeLocalDate()): HomeTodo[] {
  const byId = new Map(notes.map(note => [note.id, note]));
  return buildHomeScheduledTasks(notes, today)
    .filter(row => row.launch && row.pendingDate && row.actionDate && isHomeRootActionable(byId.get(row.rootId)))
    .sort(compareHomePendingTasks)
    .slice(0, 6)
    .map(row => ({
      noteId: row.ownerNoteId, taskId: row.taskId, noteTitle: row.ownerTitle,
      date: row.pendingDate!, actionDate: row.actionDate!, text: row.text,
      priority: row.priority, launch: row.launch!,
    }));
}

/** 当月日历：本月每天的学习分钟与达标状态 */
function buildCalendar(
  daily: Map<string, { minutes: number; activated: boolean }>,
  today: string,
): { days: HomeCalendarDay[]; year: number; month: number } {
  const now = new Date(`${today}T00:00:00`);
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
  const activeDays = days.filter((d) => !d.isFuture && d.active).length;
  const totalMinutes = days.filter(d=>!d.isFuture).reduce((s, d) => s + d.minutes, 0);
  const avgDaily = activeDays > 0 ? Math.round(totalMinutes / activeDays) : 0;
  return { activeDays, avgDaily };
}

/** 聚合主页 viewModel */
export function projectLearningStatistics(timeline: MasteryTimelineFile, today: string) {
  if (homeCalendarDay(today) === null) throw new Error('学习统计日期无效');
  const {activeDays,avgDaily}=computeMonthStats(buildCalendar(expandDaily(timeline),today).days);
  return {streak:computeCurrentStreak(timeline,new Date(today+'T12:00:00')),activeDaysThisMonth:activeDays,avgDailyMinutes:avgDaily};
}

export function buildHomeViewModel(
  notes: NoteItem[],
  profile: UserProfile,
  timeline: MasteryTimelineFile,
  today?: string,
): HomeViewModel {
  const now = new Date();
  const calendarToday = today ?? homeLocalDate(now);
  if (homeCalendarDay(calendarToday) === null) throw new Error('首页日历日期无效');
  const la = profile.learningAbility;

  // 日历
  const daily = expandDaily(timeline);
  const cal = buildCalendar(daily, calendarToday);
  const { activeDays, avgDaily } = computeMonthStats(cal.days);

  // 错误率趋势只纳入真正有过分析的周（analysisCount > 0）。
  const analyzedWeeks = analysisWeeks(timeline).filter(w => w.analysisCount > 0 && w.errorRate !== null);
  const errorWeekly = analyzedWeeks.map(w => w.errorRate!);

  const abilityDisplay = homeAbilityDisplay(profile);

  // 双极认知风格（-100~+100）
  const cs = profile.cognitiveStyle;
  const bipolar: HomeBipolarAxis[] = [
    { left: '具象', right: '抽象', value: cs.abstractVsConcrete },
    { left: '零散', right: '系统', value: cs.systematicVsScattered },
    { left: '收敛', right: '发散', value: cs.divergentVsConvergent },
    { left: '武断', right: '谨慎', value: cs.cautiousVsDogmatic },
    { left: '表面', right: '深度', value: cs.deepVsSurface },
  ];

  // Preserve live DSR timing in normal usage; explicit day fixtures remain deterministic.
  const reviewNow = today === undefined ? now.getTime() : new Date(`${calendarToday}T12:00:00`).getTime();
  const reviewEchoes = buildReviewSchedule(notes, reviewNow).knowledge.map((target) => ({
    noteId: target.noteId,
    title: target.noteTitle,
    reason: target.reason,
    retrievability: target.retrievability,
    conceptMastery: target.conceptMastery,
  }));
  const knowledgeMastery = summarizeKnowledgeMastery(notes, { now: reviewNow });

  return {
    streak: projectLearningStatistics(timeline,calendarToday).streak,
    activeDaysThisMonth: activeDays,
    avgDailyMinutes: avgDaily,
    todayMinutes: cal.days.find((d) => d.isToday)?.minutes || 0,
    // 首页先使用明确且可解释的默认目标；后续可升级为用户可配置项。
    dailyGoalMinutes: 45,
    masteredCount: knowledgeMastery.confirmedCount,
    knowledgeMastery,
    completedProjects: countCompletedProjects(notes, calendarToday),
    newMasteredThisWeek: la.newMasteredThisWeek || 0,
    ...abilityDisplay,
    errorWeekly,
    errorTrendWeeks: analyzedWeeks.length,
    calendar: cal.days,
    calYear: cal.year,
    calMonth: cal.month,
    bipolar,
    todos: collectTodos(notes, calendarToday),
    focusProject: buildHomeFocusProject(notes, calendarToday),
    reviewEchoes,
  };
}

// 复用阈值的导出，供展示层统一「已掌握」口径
export { MASTERY_LINE };
