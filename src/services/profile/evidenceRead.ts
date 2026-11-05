import type { NoteItem } from '../../types';
import type { MasteryTimelineFile } from '../learningAbility/types';
import { normalizeLearningEpisodeFile, type LearningEpisode } from '../memory/types';
import { aggregateLearningHabits, type LearningHabitProfile } from '../memory/learningHabitAggregator';
import { buildProfileEvidenceDetails, type ProfileEvidenceDetail } from './evidenceModel';
import { readCurrentProfile } from './currentRead';
import { loadProfileOverviewRecord, type ProfileReadResult } from './overviewRead';

export interface ProfileEvidenceData {
  evidence: ProfileReadResult<ProfileEvidenceDetail[]>;
  habits: ProfileReadResult<LearningHabitProfile>;
}

/** Strict, read-only event access; malformed/denied data must not become an empty history. */
export async function loadEvidenceEpisodes(): Promise<LearningEpisode[]> {
  const desktop = typeof window === 'undefined' ? undefined : (window as unknown as {
    electronAPI?: { isElectron?: boolean; userState?: { loadLearningEpisodes?: (strict: boolean) => Promise<unknown> } };
  }).electronAPI;
  let value: unknown = null;
  if (desktop?.userState || desktop?.isElectron) {
    if (!desktop.userState?.loadLearningEpisodes) throw new Error('学习事件读取服务不可用');
    value = await desktop.userState.loadLearningEpisodes(true);
  } else if (typeof localStorage !== 'undefined') {
    const raw = localStorage.getItem('loginote-learning-episodes-v1');
    if (raw !== null) {
      value = JSON.parse(raw);
      if (value === null) throw new Error('学习事件文件格式无效');
    }
  }
  return normalizeLearningEpisodeFile(value, true).episodes;
}

/** Independent outcomes preserve useful evidence when the habit timeline cannot be read. */
export async function loadProfileEvidenceData(notes: NoteItem[]): Promise<ProfileEvidenceData> {
  const [episodeResult, timeline, profile] = await Promise.allSettled([
    loadEvidenceEpisodes(),
    loadProfileOverviewRecord<MasteryTimelineFile>('timeline', 'loadMasteryTimeline'),
    readCurrentProfile(),
  ]);
  const failed = { ok: false, value: null } as const;
  let evidence: ProfileEvidenceData['evidence'] = failed;
  let habits: ProfileEvidenceData['habits'] = failed;
  if (episodeResult.status === 'fulfilled') {
    try { if (profile.status === 'fulfilled') evidence = { ok: true, value: buildProfileEvidenceDetails(profile.value, episodeResult.value) }; } catch { /* safe UI error */ }
    if (timeline.status === 'fulfilled' && timeline.value.ok) {
      try { habits = { ok: true, value: aggregateLearningHabits({ notes, episodes: episodeResult.value,
        timeline: timeline.value.value || { version: 1, weeks: [] } }) }; } catch { /* safe UI error */ }
    }
  }
  return { evidence, habits };
}
