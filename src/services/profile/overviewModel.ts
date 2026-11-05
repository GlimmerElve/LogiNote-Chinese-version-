import type { StyleSnapshotFile, StyleTrendFile, WordCloudFile, UserProfile, ExpressionStyleKind } from '../../types';
import { partitionFlowProfileEvidence, isFlowRubric } from './evidenceGateCore';
import { EXPRESSION_KINDS } from './styleScoring';
import { homeCalendarDay } from '../homepage/homeTaskScheduling';

export type ProfileStyleView = 'current' | 'd30' | 'd90';
const DAY_MS = 86_400_000;

export function profileWeekStart(today: string): string {
  const day = homeCalendarDay(today);
  if (day === null) throw new Error('画像日期无效');
  const offset = (new Date(day * DAY_MS).getUTCDay() + 6) % 7;
  return new Date((day - offset) * DAY_MS).toISOString().slice(0, 10);
}

/** Select only a record on/before the requested day, never substitute today's data. */
export function selectProfileStyle(snapshot: StyleSnapshotFile | null, trend: StyleTrendFile | null,
  view: ProfileStyleView, today: string, profile?: UserProfile) {
  const groups = profile ? Object.values(partitionFlowProfileEvidence(profile).evidenceGate?.aggregates || {})
      .filter(a => a.dimension === 'expression_style' && isFlowRubric(a.rubricVersion))
      : [];
  const version = groups.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.rubricVersion
    || [...(trend?.snapshots || [])].filter(s => isFlowRubric(s.rubricVersion)).sort((a, b) => b.date.localeCompare(a.date))[0]?.rubricVersion;
  if (view === 'current' && profile) {
    if (version) {
      const current = groups.filter(a => a.rubricVersion === version);
      // Never relabel the old nine-type snapshot as current new-rubric evidence.
      if (!EXPRESSION_KINDS.every(kind => current.some(a => a.indicator === kind && a.status === 'trusted'))) return null;
      return { display: Object.fromEntries(current.map(a => [a.indicator, a.mean])) as Record<ExpressionStyleKind, number>,
        conclusion: '同一新版量规的近期表达风格聚合；旧证据权重逐步降低。', date: current[0].updatedAt };
    }
  }
  if (view === 'current') return snapshot ? {
    display: snapshot.display, conclusion: snapshot.conclusion, date: snapshot.calculatedAt,
  } : null;
  const day = homeCalendarDay(today);
  if (day === null) return null;
  const target = day - (view === 'd30' ? 30 : 90);
  const entry = (trend?.snapshots || []).filter(item => {
    const date = homeCalendarDay(item.date);
    return date !== null && date <= target && (version ? item.rubricVersion === version : !isFlowRubric(item.rubricVersion));
  }).reduce<StyleTrendFile['snapshots'][number] | null>((latest, item) =>
    !latest || item.date > latest.date ? item : latest, null);
  return entry ? { display: entry.display, conclusion: entry.topStyle, date: entry.date } : null;
}

export function selectProfileWeekWords(cloud: WordCloudFile | null, today: string) {
  return (cloud?.weeks.find(week => week.weekStart === profileWeekStart(today))?.words || []).slice(0, 16);
}

export function profileErrorDelta(values: number[]): number {
  return (values.at(-1) ?? 0) - (values.at(-2) ?? values.at(-1) ?? 0);
}

export function profileRecordDate(value: string): string {
  if (homeCalendarDay(value) !== null) return value;
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    : '';
}
