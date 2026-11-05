import type { NoteItem } from '../../types';

export interface TaskFulfillmentSummary {
  trackedCompleted: number;
  onTimeCompleted: number;
  lateCompleted: number;
  averageLateDays: number;
  overdueOpen: number;
}

function validDay(value: string | undefined): string | null {
  const day = value?.slice(0, 10) || '';
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

/**
 * 从任务制品现态聚合履约情况。旧任务没有 completedAt 时不猜测完成日期，
 * 避免把一次勾选或迁移数据误当成长期习惯。
 */
export function summarizeTaskFulfillment(
  notes: NoteItem[],
  now = new Date().toISOString(),
  recentDays = 28,
): TaskFulfillmentSummary {
  const nowTime = Date.parse(now);
  const cutoff = Number.isFinite(nowTime) ? nowTime - recentDays * 86400000 : Number.NEGATIVE_INFINITY;
  const today = validDay(now) || new Date().toISOString().slice(0, 10);
  const summary: TaskFulfillmentSummary = {
    trackedCompleted: 0,
    onTimeCompleted: 0,
    lateCompleted: 0,
    averageLateDays: 0,
    overdueOpen: 0,
  };
  let totalLateDays = 0;

  for (const note of notes) {
    for (const task of note.dueDates || []) {
      const dueDay = validDay(task.dueDate);
      if (!task.completed) {
        if (dueDay && dueDay < today) summary.overdueOpen += 1;
        continue;
      }
      const completedDay = validDay(task.completedAt);
      const completedTime = task.completedAt ? Date.parse(task.completedAt) : Number.NaN;
      if (!dueDay || !completedDay || !Number.isFinite(completedTime) || completedTime < cutoff) continue;
      summary.trackedCompleted += 1;
      if (completedDay <= dueDay) summary.onTimeCompleted += 1;
      else {
        summary.lateCompleted += 1;
        totalLateDays += Math.max(0, Math.round((Date.parse(`${completedDay}T00:00:00Z`) - Date.parse(`${dueDay}T00:00:00Z`)) / 86400000));
      }
    }
  }
  summary.averageLateDays = summary.lateCompleted > 0
    ? Math.round((totalLateDays / summary.lateCompleted) * 10) / 10
    : 0;
  return summary;
}

export function renderTaskFulfillmentSummary(summary: TaskFulfillmentSummary): string {
  const parts: string[] = [];
  if (summary.trackedCompleted >= 3) {
    const rate = Math.round((summary.onTimeCompleted / summary.trackedCompleted) * 100);
    parts.push(`近28天有时间证据的任务完成 ${summary.trackedCompleted} 项，按时率 ${rate}%`);
  }
  if (summary.overdueOpen > 0) parts.push(`当前逾期未完成 ${summary.overdueOpen} 项`);
  return parts.join('；');
}
