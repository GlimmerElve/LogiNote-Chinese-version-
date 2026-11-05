import type { StyleSnapshotFile, StyleTrendFile, WordCloudFile, UserProfile } from '../../types';
import { readCurrentProfile } from './currentRead';
import type { MasteryTimelineFile } from '../learningAbility/types';
import { EXPRESSION_KINDS } from './styleScoring';
import { homeCalendarDay } from '../homepage/homeTaskScheduling';
import { normalizeMasteryTimeline } from '../learningAbility/timelineCompatibility';
import { projectFlowStatistics, readFlowStatisticsFile, type FlowStatisticsFile } from './flowStatistics';
import { isFlowRubric } from './evidenceGateCore';

export type ProfileReadResult<T> = { ok: true; value: T | null } | { ok: false; value: null };
export interface ProfileOverviewData {
  profile?: ProfileReadResult<UserProfile>;
  statistics?: ProfileReadResult<FlowStatisticsFile>;
  timeline: ProfileReadResult<MasteryTimelineFile>;
  snapshot: ProfileReadResult<StyleSnapshotFile>;
  trend: ProfileReadResult<StyleTrendFile>;
  cloud: ProfileReadResult<WordCloudFile>;
}

const record = (value: unknown): value is Record<string, any> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
const numeric = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const displayValid = (value: unknown) => record(value)
  && EXPRESSION_KINDS.every(kind => numeric(value[kind]) && value[kind] >= 0 && value[kind] <= 100);
const dateValid = (value: unknown) => typeof value === 'string' && homeCalendarDay(value) !== null;

/** Missing files are genuine empty states; IO/schema errors are not empty samples. */
export function validateProfileRead(kind: keyof ProfileOverviewData, value: unknown): boolean {
  if (value === null) return true;
  if (!record(value)) return false;
  switch (kind) {
    case 'snapshot': return typeof value.calculatedAt === 'string'
      && dateValid(value.calculatedAt.slice(0, 10)) && Number.isFinite(Date.parse(value.calculatedAt))
      && displayValid(value.display) && typeof value.conclusion === 'string';
    case 'trend': return Array.isArray(value.snapshots) && value.snapshots.every((item: unknown) => record(item)
      && dateValid(item.date) && displayValid(item.display) && typeof item.topStyle === 'string');
    case 'cloud': return Array.isArray(value.weeks) && value.weeks.every((week: unknown) => record(week)
      && dateValid(week.weekStart) && Array.isArray(week.words) && week.words.every((word: unknown) => record(word)
        && typeof word.word === 'string' && numeric(word.count) && word.count >= 0));
    case 'timeline': return value.version === 1 && Array.isArray(value.weeks)
      && value.weeks.every((week: unknown) => record(week) && dateValid(week.weekStart) && dateValid(week.weekEnd)
        && numeric(week.errorRate) && numeric(week.analysisCount) && record(week.reasoning) && record(week.study)
        && Array.isArray(week.study.dailyMinutes) && week.study.dailyMinutes.length === 7
        && week.study.dailyMinutes.every((minutes: unknown) => numeric(minutes) && minutes >= 0)
        && (week.study.dailyReviewActive === undefined || (Array.isArray(week.study.dailyReviewActive)
          && week.study.dailyReviewActive.length === 7 && week.study.dailyReviewActive.every((day: unknown) => day === 0 || day === 1))));
  }
}

export async function loadProfileOverviewRecord<T>(kind: keyof ProfileOverviewData, method: string): Promise<ProfileReadResult<T>> {
  const desktop = (typeof window === 'undefined' ? undefined : (window as unknown as { electronAPI?: { isElectron?: boolean;
    userState?: Record<string, (strict: boolean) => Promise<unknown>> } }).electronAPI);
  const api = desktop?.userState;
  try {
    // The web preview has no user-state files. A broken desktop bridge is an error.
    if (!api && !desktop?.isElectron) return { ok: true, value: null };
    const fn = api?.[method];
    if (!fn) throw new Error('画像读取服务不可用');
    let value = await fn(true);
    if (kind === 'timeline' && value !== null) value = normalizeMasteryTimeline(value);
    if (!validateProfileRead(kind, value)) throw new Error('画像文件格式无效');
    return { ok: true, value: value as T | null };
  } catch {
    return { ok: false, value: null };
  }
}

export async function loadProfileOverviewData(): Promise<ProfileOverviewData> {
  const [timeline, snapshot, trend, cloud, profile, statistics] = await Promise.all([
    loadProfileOverviewRecord<MasteryTimelineFile>('timeline', 'loadMasteryTimeline'),
    loadProfileOverviewRecord<StyleSnapshotFile>('snapshot', 'loadStyleSnapshot'),
    loadProfileOverviewRecord<StyleTrendFile>('trend', 'loadStyleTrend'),
    loadProfileOverviewRecord<WordCloudFile>('cloud', 'loadWordCloud'),
    readCurrentProfile().then(value => ({ ok: true as const, value })).catch(() => ({ ok: false as const, value: null })),
    loadFlowStatisticsRecord(),
  ]);
  if (statistics.ok && statistics.value) {
    const projected = projectFlowStatistics(statistics.value);
    if (timeline.ok) timeline.value = { ...(timeline.value || { version: 1, weeks: [] }), flowAnalysis: projected.timeline };
    if (trend.ok) trend.value = { snapshots: [...(trend.value?.snapshots || []), ...projected.trend.snapshots] };
    if (cloud.ok) {
      const weeks = new Map((cloud.value?.weeks || []).map(w => [w.weekStart, w]));
      projected.cloud.weeks.filter(w => w.words.length > 0).forEach(w => weeks.set(w.weekStart, w));
      cloud.value = { weeks: [...weeks.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart)) };
    }
  }
  const flowRubric = Object.values((profile.value as UserProfile | null)?.evidenceGate?.aggregates || {}).filter(a => isFlowRubric(a.rubricVersion))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.rubricVersion;
  if (flowRubric && timeline.ok && !timeline.value?.flowAnalysis) {
    timeline.value = { ...(timeline.value || { version: 1, weeks: [] }), flowAnalysis: { rubricVersion: flowRubric, weeks: [] } };
  }
  return { timeline, snapshot, trend, cloud, profile, statistics };
}

export async function loadFlowStatisticsRecord(): Promise<ProfileReadResult<FlowStatisticsFile>> {
  const desktop = typeof window === 'undefined' ? undefined : (window as unknown as { electronAPI?: {
    userState?: { loadFlowStatistics?: () => Promise<unknown> } } }).electronAPI;
  if (!desktop) return { ok: true, value: null };
  try {
    if (!desktop.userState?.loadFlowStatistics) throw new Error('复盘统计读取接口未更新');
    const raw = await desktop.userState.loadFlowStatistics();
    return { ok: true, value: raw === null ? null : readFlowStatisticsFile(raw) };
  } catch { return { ok: false, value: null }; }
}
