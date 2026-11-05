import type { UserProfile } from '../../types';
import type { LearningEpisode } from '../memory/types';

/** Explicitly requested, bounded evidence projection; never serialize raw gate state. */
export function profileInquiryDetails(profile: UserProfile, episodes: LearningEpisode[]): string[] {
  return Object.values(profile.evidenceGate?.aggregates || {}).filter((a) => a.status === 'trusted').slice(0, 12).map((aggregate) => JSON.stringify({
    dimension: aggregate.dimension, indicator: aggregate.indicator, mean: aggregate.mean, confidence: aggregate.confidence,
    updatedAt: aggregate.updatedAt, evidenceCount: aggregate.samples.length,
    interpretation: '系统按学习活动形成的评估，不是用户自述或人格定论。仅展示最近三条依据。',
    evidence: aggregate.samples.slice(-3).map((sample) => {
      const episode = episodes.find((e) => e.id === sample.episodeId && e.type !== 'qa');
      return { observedAt: sample.observedAt, value: sample.value, criteria: sample.matchedCriteria?.slice(0, 8),
        activity: episode?.title.slice(0, 120), activityId: episode?.id,
        snippets: episode?.evidenceSnippets?.filter((s) => s.id && sample.evidenceSnippetIds?.includes(s.id)).slice(0, 3)
          .map((s) => ({ source: s.source, type: s.type, text: s.text.slice(0, 500) })),
        evidenceAvailable: Boolean(episode),
      };
    }),
  }));
}
