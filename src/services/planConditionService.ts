import type { PlanMeta, PlanNode, PlanTaskBlueprint } from '../types';
import { personalWeeklyBudget, cachedCapacitySettings, previewDraftCapacity } from './learningCapacity';

const DAY_MS = 86_400_000;

export type PlanConditionIssueCode =
  | 'hard-deadline-missing'
  | 'invalid-plan-window'
  | 'capacity-overload'
  | 'outside-plan-window'
  | 'rest-day-task'
  | 'rest-day-project'
  | 'session-too-long'
  | 'dependency-order'
  | 'review-density';

export interface PlanConditionIssue {
  code: PlanConditionIssueCode;
  severity: 'blocking' | 'warning';
  message: string;
  taskKeys?: string[];
  projectKeys?: string[];
}

export interface PlanConditionAssessment {
  taskCount: number;
  totalEstimatedMinutes: number;
  effectiveCapacityMinutes: number | null;
  utilizationPercent: number | null;
  issues: PlanConditionIssue[];
  blocking: boolean;
}

function parseDay(value: string | undefined): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value ? Math.floor(timestamp / DAY_MS) : null;
}

function flattenTasks(nodes: PlanNode[]): PlanTaskBlueprint[] {
  return nodes.flatMap((node) => [...(node.tasks || []), ...flattenTasks(node.children || [])]);
}

function flattenLeafProjects(nodes: PlanNode[]): PlanNode[] {
  return nodes.flatMap(node => node.children?.length ? flattenLeafProjects(node.children) : [node]);
}

export function assessPlanConditions(nodes: PlanNode[], meta: Partial<PlanMeta>, personalBudget = personalWeeklyBudget(cachedCapacitySettings())): PlanConditionAssessment {
  const tasks = flattenTasks(nodes);
  const conditions = meta.conditions;
  const startDay = parseDay(meta.startDate);
  const targetDay = parseDay(meta.targetDate);
  const weeklyBudget = personalBudget;
  const activeWeekdays = meta.activeWeekdays?.length ? meta.activeWeekdays : [1, 2, 3, 4, 5, 6];
  const issues: PlanConditionIssue[] = [];

  let effectiveCapacityMinutes: number | null = null;
  if (weeklyBudget !== null && startDay !== null && targetDay !== null && targetDay >= startDay) {
    const weeks = Math.max(1, Math.ceil((targetDay - startDay + 1) / 7));
    effectiveCapacityMinutes = weeks * weeklyBudget;
  }

  const totalEstimatedMinutes = previewDraftCapacity([{ key: '__condition_root__', title: '排期容量校验', children: nodes }], meta, [],
    { ...(personalBudget === null ? {} : { learningWeeklyBudgetMinutes: personalBudget }) }).reduce((sum, week) => sum + week.scheduledMinutes, 0);
  if (conditions?.deadlineMode === 'hard' && targetDay === null) {
    issues.push({ code: 'hard-deadline-missing', severity: 'blocking', message: '硬截止计划必须设置目标日期。' });
  }
  if (startDay !== null && targetDay !== null && targetDay < startDay) {
    issues.push({ code: 'invalid-plan-window', severity: 'blocking', message: '目标日期不能早于开始日期。' });
  }
  if (conditions?.deadlineMode === 'hard' && effectiveCapacityMinutes !== null && totalEstimatedMinutes > effectiveCapacityMinutes) {
    issues.push({
      code: 'capacity-overload',
      severity: 'blocking',
      message: `任务预计 ${totalEstimatedMinutes} 分钟，超过截止日前可用容量 ${effectiveCapacityMinutes} 分钟。`,
    });
  }

  // Match capacity accounting: a leaf occupies its planned start day once,
  // not every calendar day covered by its time window. Undated notes and
  // structural parents are not learning sessions.
  const restDayProjects = flattenLeafProjects(nodes).flatMap(node => {
    if (!node.dueDate) return [];
    const date = node.startDate || node.dueDate;
    const day = parseDay(date);
    if (day === null) return [];
    const weekday = new Date(day * DAY_MS).getUTCDay();
    return activeWeekdays.includes(weekday) ? [] : [{ key: node.key, title: node.title, date, weekday }];
  });
  if (restDayProjects.length) issues.push({
    code: 'rest-day-project', severity: 'warning', projectKeys: restDayProjects.map(node => node.key),
    message: `${restDayProjects.length} 个叶子项目排在未启用的学习日：${restDayProjects.slice(0, 3).map(node => `“${node.title}”（${node.date}，周${'日一二三四五六'[node.weekday]}）`).join('、')}${restDayProjects.length > 3 ? '等' : ''}。请调整日期或启用相应学习日；不会自动改期。`,
  });

  const outsideWindow: string[] = [];
  const restDayTasks: string[] = [];
  const longTasks: string[] = [];
  const preferredSession = Math.max(5, conditions?.preferredSessionMinutes || 60);
  for (const task of tasks) {
    const taskStart = parseDay(task.startDate || task.dueDate);
    const taskDue = parseDay(task.dueDate);
    if ((startDay !== null && taskStart !== null && taskStart < startDay) || (targetDay !== null && taskDue !== null && taskDue > targetDay)) {
      outsideWindow.push(task.key);
    }
    if (taskDue !== null) {
      const weekday = new Date(taskDue * DAY_MS).getUTCDay();
      if (!activeWeekdays.includes(weekday)) restDayTasks.push(task.key);
    }
    if (task.estimatedMinutes > preferredSession * 2) longTasks.push(task.key);
  }
  if (outsideWindow.length) issues.push({
    code: 'outside-plan-window',
    severity: conditions?.deadlineMode === 'hard' ? 'blocking' : 'warning',
    message: `${outsideWindow.length} 项任务超出计划起止日期。`,
    taskKeys: outsideWindow,
  });
  if (restDayTasks.length) issues.push({
    code: 'rest-day-task', severity: 'warning',
    message: `${restDayTasks.length} 项任务安排在未启用的学习日。`, taskKeys: restDayTasks,
  });
  if (longTasks.length) issues.push({
    code: 'session-too-long', severity: 'warning',
    message: `${longTasks.length} 项任务超过偏好单次时长的两倍，建议拆分。`, taskKeys: longTasks,
  });

  const byKey = new Map(tasks.map((task) => [task.key, task]));
  const invertedDependencies = tasks.filter((task) => (task.dependencyKeys || []).some((dependencyKey) => {
    const dependency = byKey.get(dependencyKey);
    return dependency && dependency.dueDate > task.dueDate;
  })).map((task) => task.key);
  if (invertedDependencies.length) issues.push({
    code: 'dependency-order', severity: 'blocking',
    message: `${invertedDependencies.length} 项任务早于其前置任务到期。`, taskKeys: invertedDependencies,
  });

  const reviewCount = tasks.filter((task) => task.kind === 'review').length;
  const activeTaskCount = tasks.filter((task) => task.kind !== 'review').length;
  const expectedReviews = conditions?.reviewCadence === 'intensive'
    ? Math.ceil(activeTaskCount / 2)
    : conditions?.reviewCadence === 'standard'
      ? Math.ceil(activeTaskCount / 4)
      : 0;
  if (reviewCount < expectedReviews) issues.push({
    code: 'review-density', severity: 'warning',
    message: `当前只有 ${reviewCount} 项复习，低于所选复习密度建议的 ${expectedReviews} 项。`,
  });

  const utilizationPercent = effectiveCapacityMinutes && effectiveCapacityMinutes > 0
    ? Math.round((totalEstimatedMinutes / effectiveCapacityMinutes) * 100)
    : null;
  return {
    taskCount: tasks.length,
    totalEstimatedMinutes,
    effectiveCapacityMinutes,
    utilizationPercent,
    issues,
    blocking: issues.some((issue) => issue.severity === 'blocking'),
  };
}
