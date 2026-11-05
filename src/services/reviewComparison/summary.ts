import type { ReviewComparisonSummary } from './types';

/** Long-term audit projection: arbitrary raw packet bodies/error strings must be dropped. */
export function readReviewComparisonSummary(raw: unknown): ReviewComparisonSummary | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const count = (item: unknown): item is number => Number.isSafeInteger(item) && (item as number) >= 0 && (item as number) <= 1000;
  if (value.version !== 1 || !['prepared', 'partial', 'unavailable'].includes(value.status as string)
    || !count(value.preparedAnswers) || !count(value.omittedAnswers)
    || !count(value.referencesAvailable) || !count(value.cognitionTargetsResolved)
    || !Array.isArray(value.snapshots) || value.snapshots.length > 12 || !Array.isArray(value.holdReasons)) return undefined;
  const snapshots: ReviewComparisonSummary['snapshots'] = [];
  const seen = new Set<string>();
  for (const item of value.snapshots) {
    if (!item || typeof item !== 'object') return undefined;
    const { packetId, snapshotHash } = item as Record<string, unknown>;
    if (typeof snapshotHash !== 'string' || !/^[a-f0-9]{64}$/u.test(snapshotHash)
      || packetId !== `review-comparison:${snapshotHash}` || seen.has(snapshotHash)) return undefined;
    seen.add(snapshotHash);
    snapshots.push({ packetId: packetId as string, snapshotHash });
  }
  if (value.preparedAnswers !== snapshots.length || value.referencesAvailable > value.preparedAnswers
    || value.cognitionTargetsResolved > value.preparedAnswers) return undefined;
  return { version: 1, status: value.status as ReviewComparisonSummary['status'],
    preparedAnswers: value.preparedAnswers, omittedAnswers: value.omittedAnswers,
    referencesAvailable: value.referencesAvailable, cognitionTargetsResolved: value.cognitionTargetsResolved,
    holdReasons: [...new Set(value.holdReasons.filter((item): item is string => typeof item === 'string'
      && /^[a-z][a-z0-9_]{0,80}$/u.test(item)))].slice(0, 40), snapshots };
}
