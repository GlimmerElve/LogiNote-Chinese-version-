import type { MasteryTimelineFile } from './types';

/** A missing legacy denominator is unknown, not proof of zero analyses/errors.
 * Pure read compatibility: preserve the original week and all study/score fields. */
export function normalizeMasteryTimeline(value: unknown): MasteryTimelineFile {
  const file = value as MasteryTimelineFile;
  if (!file || file.version !== 1 || !Array.isArray(file.weeks)) throw new Error('学习周报文件格式错误');
  const date = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(v)
    && Number.isFinite(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
  return { ...file, weeks: file.weeks.map(week => {
    if (!week || !date(week.weekStart) || !date(week.weekEnd) || !Number.isFinite(week.errorRate)
      || !week.reasoning || !week.study || !Array.isArray(week.study.dailyMinutes)
      || week.study.dailyMinutes.length !== 7 || week.study.dailyMinutes.some(n => !Number.isFinite(n) || n < 0)
      || (week.analysisCount !== undefined && (!Number.isFinite(week.analysisCount) || week.analysisCount < 0))
      || (week.study.dailyReviewActive !== undefined && (!Array.isArray(week.study.dailyReviewActive)
        || week.study.dailyReviewActive.length !== 7 || week.study.dailyReviewActive.some(n => n !== 0 && n !== 1)))) {
      throw new Error('学习周报文件格式错误');
    }
    return week.analysisCount === undefined ? { ...week, analysisCount: 0, analysisCountUnknown: true as const } : { ...week };
  }) };
}
