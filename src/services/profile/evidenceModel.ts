import type { ProfileEvidenceAggregate, ProfileEvidenceSample, UserProfile } from '../../types';
import type { EvidenceSnippet, LearningEpisode, LearningEpisodeType } from '../memory/types';
import { partitionFlowProfileEvidence, isFlowRubric } from './evidenceGateCore';

export interface ProfileEvidenceSampleDetail extends ProfileEvidenceSample {
  episodeType?: LearningEpisodeType;
  episodeTitle?: string;
  noteId?: string;
  evidenceSnippets: EvidenceSnippet[];
}
export interface ProfileEvidenceDetail extends Omit<ProfileEvidenceAggregate, 'samples'> {
  samples: ProfileEvidenceSampleDetail[];
}

/** Associate stored aggregate samples with compressed evidence without modifying either source. */
export function buildProfileEvidenceDetails(profile: UserProfile, episodes: LearningEpisode[]): ProfileEvidenceDetail[] {
  const episodeById = new Map(episodes.map(episode => [episode.id, episode]));
  const aggregates = Object.values(profile.evidenceGate?.aggregates || {});
  const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value);
  const stringList = (value: unknown) => value === undefined || (Array.isArray(value) && value.every(item => typeof item === 'string'));
  if (!aggregates.every(aggregate => aggregate && ['ability', 'cognitive_style', 'expression_style'].includes(aggregate.dimension)
    && typeof aggregate.indicator === 'string' && ['holding', 'trusted'].includes(aggregate.status)
    && finite(aggregate.mean) && finite(aggregate.confidence) && aggregate.confidence >= 0 && aggregate.confidence <= 1
    && typeof aggregate.updatedAt === 'string' && Array.isArray(aggregate.samples) && aggregate.samples.every(sample => sample
      && typeof sample.episodeId === 'string' && typeof sample.observedAt === 'string'
      && finite(sample.value) && finite(sample.weight) && stringList(sample.evidenceSnippetIds) && stringList(sample.matchedCriteria)
      && (sample.rubricVersion === undefined || typeof sample.rubricVersion === 'string')))) {
    throw new Error('画像证据格式无效');
  }
  return Object.values(partitionFlowProfileEvidence(profile).evidenceGate?.aggregates || {}).map(aggregate => ({
    ...aggregate,
    samples: [...aggregate.samples].sort((a, b) => b.observedAt.localeCompare(a.observedAt)).map(sample => {
      const episode = episodeById.get(sample.episodeId);
      const wanted = new Set(sample.evidenceSnippetIds || []);
      return { ...sample, episodeType: episode?.type, episodeTitle: episode?.title, noteId: episode?.noteId,
        evidenceSnippets: (episode?.evidenceSnippets || []).filter(snippet => snippet.id && wanted.has(snippet.id)) };
    }),
  })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Latest recorded activity is visible even before a long-term preference is trusted. */
export function latestFlowProfileObservation(profile: UserProfile) {
  const groups = Object.values(partitionFlowProfileEvidence(profile).evidenceGate?.aggregates || {})
    .filter(a => isFlowRubric(a.rubricVersion));
  const latest = groups.flatMap(a => a.samples).sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];
  if (!latest) return null;
  const rows = groups.flatMap(a => {
    const sample = a.samples.find(s => s.episodeId === latest.episodeId);
    return sample ? [{ dimension: a.dimension, indicator: a.indicator, value: sample.value, status: a.status }] : [];
  });
  return { episodeId: latest.episodeId, observedAt: latest.observedAt, rows,
    holding: rows.filter(r => r.status === 'holding').length };
}
