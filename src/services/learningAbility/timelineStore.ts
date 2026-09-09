import { MasteryTimelineFile, LearningWeek } from './types';
import { ArgumentAnalysis } from '../../types';
import { loadMasteryTimelineState, saveMasteryTimelineState } from '../electronUserState';

/**
 * 周报存储（mastery-timeline.json，异步读写，无内存缓存）。
 * - 自然周（周一~周日），weeks[] 按周升序；
 * - 最多保留最近 10 周（滚动窗口），新周插入超限即 shift 删除最早一周；
 * - 所有「周数据」落盘于此：推理分项 / 自律性(时长) / 纠错(错误) / 新增掌握。
 *
 * 写入接口（供 orchestrator / App / FlowMode / ReviewChat 调用）：
 *   recordReasoning(命中锚点, 谬误数) —— 每次画像证据分析后
 *   recordErrors(错误总次数)          —— 与 recordReasoning 配合，累计本周错误率
 *   recordStudyDuration(分钟数)       —— 退出心流/复习时
 *   recordNewMastered(新增数)         —— 知识点掌握度从 <55 跨到 ≥55 时
 */

const MAX_WEEKS = 10;
const ACTIVE_MINUTES = 20; // 学习日达标分钟数

/** 计算某日期所在自然周的 周一/周日 的 YYYY-MM-DD */
function weekRangeOf(date: Date): { weekStart: string; weekEnd: string } {
  const d = new Date(date);
  const day = d.getDay(); // 0=周日, 1=周一 ...
  const offsetToMonday = day === 0 ? 6 : day - 1;
  const monday = new Date(d);
  monday.setDate(d.getDate() - offsetToMonday);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const fmt = (dt: Date) =>
    `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  return { weekStart: fmt(monday), weekEnd: fmt(sunday) };
}

/** 构造空的 LearningWeek */
function emptyWeek(weekStart: string, weekEnd: string): LearningWeek {
  return {
    weekStart,
    weekEnd,
    newMastered: 0,
    masteredCount: 0,
    reasoning: {
      totalClaims: 0,
      withPremise: 0,
      completeChain: 0,
      identifiesAssumption: 0,
      deductiveInductive: 0,
      counterfactual: 0,
      fallacyCount: 0,
      fallacyBreakdown: {},
    },
    study: {
      activeDays: 0,
      dailyMinutes: [0, 0, 0, 0, 0, 0, 0],
      dailyReviewActive: [0, 0, 0, 0, 0, 0, 0],
    },
    errorRate: 0,
  };
}

/**
 * 按 7 天数组现算 activeDays：
 * 当天「心流时长 ≥20 分钟」或「复习达标」任一满足即算一个活跃学习日。
 * 从根上保证 activeDays 恒在 0~7，避免事件自增导致的重复计数（如一周 >7 天）。
 */
function recountActiveDays(w: LearningWeek): void {
  const minutes = w.study.dailyMinutes || [];
  const review = w.study.dailyReviewActive || [];
  let days = 0;
  for (let i = 0; i < 7; i++) {
    if ((minutes[i] ?? 0) >= ACTIVE_MINUTES || review[i] === 1) days += 1;
  }
  w.study.activeDays = days;
}

/** 读取周报；文件不存在时返回空结构 */
export async function loadMasteryTimeline(): Promise<MasteryTimelineFile> {
  const file = await loadMasteryTimelineState();
  if (file && Array.isArray(file.weeks)) return file;
  return { version: 1, weeks: [] };
}

/** 保存周报（含 10 周滚动截断） */
export async function saveMasteryTimeline(file: MasteryTimelineFile): Promise<void> {
  let weeks = file.weeks || [];
  if (weeks.length > MAX_WEEKS) {
    weeks = weeks.slice(weeks.length - MAX_WEEKS);
  }
  await saveMasteryTimelineState({ version: 1, weeks });
}

/** 定位当前周，若进入新周则 push 新空周并截断（返回当前周） */
async function currentWeek(file: MasteryTimelineFile): Promise<LearningWeek> {
  const { weekStart, weekEnd } = weekRangeOf(new Date());
  let existing = file.weeks.find((w) => w.weekStart === weekStart);
  if (!existing) {
    existing = emptyWeek(weekStart, weekEnd);
    file.weeks.push(existing);
    // 超限滚动
    if (file.weeks.length > MAX_WEEKS) {
      file.weeks = file.weeks.slice(file.weeks.length - MAX_WEEKS);
    }
  }
  return existing;
}

/** 归一化 reasoning 为「结论粒度」新结构：旧周数据缺 totalClaims 时重置（方案丙：历史清零，不近似折算） */
function normalizeReasoning(w: LearningWeek): void {
  if (typeof (w.reasoning as any).totalClaims === 'number') {
    if (!w.reasoning.fallacyBreakdown) (w.reasoning as any).fallacyBreakdown = {};
    return;
  }
  w.reasoning = {
    totalClaims: 0,
    withPremise: 0,
    completeChain: 0,
    identifiesAssumption: 0,
    deductiveInductive: 0,
    counterfactual: 0,
    fallacyCount: 0,
    fallacyBreakdown: {},
  };
}

/** 保存当前周（每次写入后由调用方决定是否落盘） */
async function mutateCurrentWeek(mutator: (w: LearningWeek) => void): Promise<void> {
  const file = await loadMasteryTimeline();
  const week = await currentWeek(file);
  normalizeReasoning(week);
  mutator(week);
  // 重新计算 errorRate（推理谬误数 / 结论总数，0~1）
  week.errorRate = week.reasoning.totalClaims > 0
    ? week.reasoning.fallacyCount / week.reasoning.totalClaims
    : 0;
  await saveMasteryTimeline(file);
}

/** ② 推理分项 + 错误率：把本次分析的核心结论逐条累加入周报（结论粒度，正向布尔 + issues 派生谬误） */
export async function recordReasoning(argumentAnalyses: ArgumentAnalysis[]): Promise<void> {
  if (!argumentAnalyses || argumentAnalyses.length === 0) return;
  await mutateCurrentWeek((w) => {
    w.reasoning.totalClaims += argumentAnalyses.length;
    for (const a of argumentAnalyses) {
      if (a.hasPremise) w.reasoning.withPremise += 1;
      if (a.completeChain) w.reasoning.completeChain += 1;
      if (a.identifiesAssumption) w.reasoning.identifiesAssumption += 1;
      if (a.distinguishesDeductiveInductive) w.reasoning.deductiveInductive += 1;
      if (a.considersCounterfactual) w.reasoning.counterfactual += 1;
      // 谬误从 issues 派生：layer==='reasoning' 且带 fallacyKind
      for (const iss of a.issues || []) {
        if (iss.layer === 'reasoning' && iss.fallacyKind) {
          w.reasoning.fallacyCount += 1;
          w.reasoning.fallacyBreakdown[iss.fallacyKind] = (w.reasoning.fallacyBreakdown[iss.fallacyKind] || 0) + 1;
        }
      }
    }
  });
}

/** ③ 自律性：退出心流/复习时记录学习时长（分钟数），自动判定活跃天数 */
export async function recordStudyDuration(minutes: number): Promise<void> {
  if (minutes <= 0) return;
  await mutateCurrentWeek((w) => {
    const now = new Date();
    const dayIdx = now.getDay() === 0 ? 6 : now.getDay() - 1; // 0=周一 ... 6=周日
    if (w.study.dailyMinutes.length !== 7) {
      w.study.dailyMinutes = [0, 0, 0, 0, 0, 0, 0];
    }
    if (!w.study.dailyReviewActive || w.study.dailyReviewActive.length !== 7) {
      w.study.dailyReviewActive = [0, 0, 0, 0, 0, 0, 0];
    }
    w.study.dailyMinutes[dayIdx] = (w.study.dailyMinutes[dayIdx] || 0) + minutes;
    // 按天现算活跃天数，避免事件自增导致的重复计数
    recountActiveDays(w);
  });
}

/** ③ 自律性：复习模式达标（≥5轮 或 ≥150字）时调用，当日标记达标并累计活跃天数 */
export async function recordReviewActivity(): Promise<void> {
  await mutateCurrentWeek((w) => {
    const now = new Date();
    const dayIdx = now.getDay() === 0 ? 6 : now.getDay() - 1;
    if (!w.study.dailyReviewActive || w.study.dailyReviewActive.length !== 7) {
      w.study.dailyReviewActive = [0, 0, 0, 0, 0, 0, 0];
    }
    if (w.study.dailyReviewActive[dayIdx] === 0) {
      w.study.dailyReviewActive[dayIdx] = 1;
    }
    // 按天现算活跃天数，避免事件自增导致的重复计数
    recountActiveDays(w);
  });
}

/** ④ 趋势：知识点从 <55 跨到 ≥55 时调用，新增掌握数 +1 */
export async function recordNewMastered(delta: number): Promise<void> {
  if (delta <= 0) return;
  await mutateCurrentWeek((w) => {
    w.newMastered += delta;
  });
}

/** ⑥ 周结算：写当前周的 masteredCount 存量快照（周末/新周开始时调用） */
export async function settleCurrentWeek(masteredCount: number): Promise<void> {
  await mutateCurrentWeek((w) => {
    w.masteredCount = masteredCount;
  });
}