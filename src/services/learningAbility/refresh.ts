import { NoteItem } from '../../types';
import { getUserProfile, saveUserProfile } from '../profile/profileStore';
import { loadMasteryTimeline, settleCurrentWeek } from './timelineStore';
import { aggregateLearningAbility } from './aggregator';

/**
 * 学习能力刷新 + 写入 user-state（预留输出接口）。
 * 调用时机：知识点评分写回后 / 学习时长记录后（由 App/FlowMode/ReviewChat 触发）。
 * 流程：读 weeks[]（周报）→ 结合 notes 现算六维 → 写 profile.learningAbility → saveUserProfile 落盘。
 * 学习能力不展示在结果面板，但实时写入 user-state。
 */
export async function refreshLearningAbility(notes: NoteItem[]): Promise<void> {
  const timeline = await loadMasteryTimeline();

  // 先结算本周存量 masteredCount（用当前掌握数覆盖，保证周末快照准确）
  const ability = aggregateLearningAbility(notes, timeline);
  await settleCurrentWeek(ability.masteredCount);

  // 重新读一次（settle 可能新建/更新了 week），用最新 timeline 派生
  const finalTimeline = await loadMasteryTimeline();
  const finalAbility = aggregateLearningAbility(notes, finalTimeline);

  // 写入画像
  const profile = getUserProfile();
  profile.learningAbility = finalAbility;
  saveUserProfile(profile);
}