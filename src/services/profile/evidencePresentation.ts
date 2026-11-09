import type { ProfileEvidenceDetail } from './evidenceModel';

/** One visible indicator; each scoring cohort keeps its own score and evidence. */
export interface ProfileEvidenceIndicator {
  key: string;
  dimension: ProfileEvidenceDetail['dimension'];
  indicator: string;
  cohorts: ProfileEvidenceDetail[];
  recordCount: number;
  hasTrustedCohort: boolean;
}

/** Presentation only: never combine incompatible scoring rubrics or mutate stored evidence. */
export function groupProfileEvidenceIndicators(details: ProfileEvidenceDetail[]): ProfileEvidenceIndicator[] {
  const indicators = new Map<string, ProfileEvidenceIndicator>();
  for (const detail of details) {
    const key = `${detail.dimension}:${detail.indicator}`;
    let indicator = indicators.get(key);
    if (!indicator) {
      indicator = { key, dimension: detail.dimension, indicator: detail.indicator,
        cohorts: [], recordCount: 0, hasTrustedCohort: false };
      indicators.set(key, indicator);
    }
    indicator.cohorts.push(detail);
    indicator.hasTrustedCohort ||= detail.status === 'trusted';
  }
  return [...indicators.values()].map(indicator => ({
    ...indicator,
    // Array#sort is stable, so equal timestamps retain the input cohort order.
    cohorts: [...indicator.cohorts].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    recordCount: new Set(indicator.cohorts.flatMap(cohort => cohort.samples.map(sample => sample.episodeId))).size,
  }));
}

/** Human-readable labels must not expose internal rubric identifiers or hashes. */
export function profileEvidenceCohortLabel(cohort: ProfileEvidenceDetail): string {
  const version = cohort.rubricVersion;
  if (!version) return '历史评分';
  const flowVersion = /^flow-evidence-rubric-v(\d+)-/u.exec(version)?.[1];
  if (flowVersion) return `心流评分 v${flowVersion}`;
  if (version === 'review-criteria-v2') return '复习评分 v2';
  return '其他评分口径';
}
