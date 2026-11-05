import type { NoteItem } from '../../types';
import { loadMasteryTimeline } from '../learningAbility/timelineStore';
import { loadNotesFromStorage } from '../storage';
import { loadLearningEpisodes } from './episodeStore';
import { aggregateLearningHabits, type LearningHabitProfile } from './learningHabitAggregator';

/** 统一读取三个既有数据源；习惯画像本身保持可重算，不再新增一份状态文件。 */
export async function loadLearningHabitProfile(notes?: NoteItem[]): Promise<LearningHabitProfile> {
  const [episodes, timeline, resolvedNotes] = await Promise.all([
    loadLearningEpisodes(),
    loadMasteryTimeline(),
    notes ? Promise.resolve(notes) : loadNotesFromStorage(),
  ]);
  return aggregateLearningHabits({ episodes, timeline, notes: resolvedNotes });
}
