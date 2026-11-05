import type { NoteItem } from '../../types';
import type { MasteryTimelineFile } from '../learningAbility/types';
import { summarizeTaskFulfillment } from './taskFulfillment.ts';
import type { LearningEpisode } from './types';

export type HabitConfidenceStatus = 'insufficient' | 'provisional' | 'trusted';

export interface HabitGroupBase {
  status: HabitConfidenceStatus;
  sampleCount: number;
  daysObserved: number;
  sourceIds: string[];
}

export interface LearningHabitProfile {
  updatedAt: string;
  windowDays: number;
  studyRhythm: HabitGroupBase & {
    activeDays: number;
    averageActiveDaysPerWeek: number;
    medianSessionMinutes: number;
    totalMinutes: number;
  };
  reviewPattern: HabitGroupBase & {
    medianAnswerTurns: number;
    medianAnswerChars: number;
    qualifiedReviewRate: number;
  };
  correctionPattern: HabitGroupBase & {
    submitCount: number;
    failureCount: number;
    helpUsageRate: number;
    correctionRecoveryRate: number;
  };
  executionPattern: HabitGroupBase & {
    onTimeRate: number;
    averageLateDays: number;
    overdueOpen: number;
  };
  planningPattern: HabitGroupBase & {
    medianNodeCount: number;
    scheduledNodeRate: number;
  };
}

export interface LearningHabitInput {
  episodes: LearningEpisode[];
  timeline: MasteryTimelineFile;
  notes: NoteItem[];
  now?: string;
  windowDays?: number;
}

const round1 = (value: number): number => Math.round(value * 10) / 10;
const percent = (part: number, total: number): number => total > 0 ? round1(Math.min(100, Math.max(0, (part / total) * 100))) : 0;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return round1(sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2);
}

function numericSignal(episode: LearningEpisode, indicator: string): number {
  const value = episode.profileSignals?.find((signal) => signal.indicator === indicator)?.value;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function distinctDays(episodes: LearningEpisode[]): number {
  return new Set(episodes.map((episode) => episode.endedAt.slice(0, 10))).size;
}

function status(sampleCount: number, days: number, provisional: number, trusted: number, trustedDays = 2): HabitConfidenceStatus {
  if (sampleCount >= trusted && days >= trustedDays) return 'trusted';
  if (sampleCount >= provisional) return 'provisional';
  return 'insufficient';
}

function sources(ids: string[]): string[] {
  return [...new Set(ids)].slice(-20);
}

/** 从已持久化事件、周报和任务制品派生近期习惯；不创建新的行为日志。 */
export function aggregateLearningHabits(input: LearningHabitInput): LearningHabitProfile {
  const now = input.now || new Date().toISOString();
  const windowDays = input.windowDays || 28;
  const nowTime = Date.parse(now);
  const cutoff = Number.isFinite(nowTime) ? nowTime - windowDays * 86400000 : Number.NEGATIVE_INFINITY;
  const recent = input.episodes.filter((episode) => {
    const ended = Date.parse(episode.endedAt);
    return episode.status === 'completed' && Number.isFinite(ended) && ended >= cutoff && ended <= nowTime;
  });

  const sessions = recent.filter((episode) => ['flow', 'review', 'scene'].includes(episode.type) && (episode.durationSeconds || 0) > 0);
  const sessionMinutes = sessions.map((episode) => Math.max(1, Math.round((episode.durationSeconds || 0) / 60)));
  const activeDates = new Set<string>();
  let totalMinutes = 0;
  const timelineSources: string[] = [];
  for (const week of input.timeline.weeks || []) {
    const weekStart = Date.parse(`${week.weekStart}T00:00:00Z`);
    if (!Number.isFinite(weekStart)) continue;
    for (let day = 0; day < 7; day += 1) {
      const dayTime = weekStart + day * 86400000;
      if (dayTime < cutoff || dayTime > nowTime) continue;
      const minutes = week.study.dailyMinutes?.[day] || 0;
      const reviewActive = week.study.dailyReviewActive?.[day] || 0;
      totalMinutes += minutes;
      if (minutes >= 20 || reviewActive > 0) {
        activeDates.add(new Date(dayTime).toISOString().slice(0, 10));
        timelineSources.push(`week:${week.weekStart}`);
      }
    }
  }
  const sessionDays = distinctDays(sessions);
  const studyDays = Math.max(sessionDays, activeDates.size);
  const studySampleCount = Math.max(sessions.length, activeDates.size);

  const reviews = recent.filter((episode) => (
    episode.type === 'review' && (episode.profileSignals || []).some((signal) => signal.indicator === 'reviewAnswerCount')
  ));
  const reviewTurns = reviews.map((episode) => numericSignal(episode, 'reviewAnswerCount'));
  const reviewChars = reviews.map((episode) => numericSignal(episode, 'reviewAnswerChars'));
  const qualifiedReviews = reviews.filter((episode) => (
    numericSignal(episode, 'reviewAnswerCount') >= 5 || numericSignal(episode, 'reviewAnswerChars') >= 150
  )).length;

  const derivations = recent.filter((episode) => (
    episode.type === 'scene' && (episode.profileSignals || []).some((signal) => signal.indicator === 'derivationSubmitCount')
  ));
  const submitCount = derivations.reduce((sum, episode) => sum + numericSignal(episode, 'derivationSubmitCount'), 0);
  const helpCount = derivations.reduce((sum, episode) => sum + numericSignal(episode, 'sceneHelpCount'), 0);
  const failureCount = derivations.reduce((sum, episode) => sum + numericSignal(episode, 'derivationFailureCount'), 0);
  const correctionCount = derivations.reduce((sum, episode) => sum + numericSignal(episode, 'derivationCorrectionCount'), 0);
  const correctionDays = distinctDays(derivations);
  const correctionStatus: HabitConfidenceStatus = (
    correctionDays >= 2 && (derivations.length >= 3 || submitCount >= 10)
  ) ? 'trusted' : derivations.length >= 1 ? 'provisional' : 'insufficient';

  const fulfillment = summarizeTaskFulfillment(input.notes, now, windowDays);
  const completedTaskDates = new Set<string>();
  const taskSourceIds: string[] = [];
  for (const note of input.notes) {
    for (const task of note.dueDates || []) {
      const completedTime = task.completedAt ? Date.parse(task.completedAt) : Number.NaN;
      const isRecent = Number.isFinite(completedTime) && completedTime >= cutoff && completedTime <= nowTime;
      if ((task.completed && isRecent) || (!task.completed && task.dueDate < now.slice(0, 10))) {
        taskSourceIds.push(note.id);
      }
      if (task.completed && isRecent) completedTaskDates.add(task.completedAt!.slice(0, 10));
    }
  }

  const plans = recent.filter((episode) => (
    episode.type === 'plan' && (episode.profileSignals || []).some((signal) => signal.indicator === 'planNodeCount')
  ));
  const planNodeCounts = plans.map((episode) => numericSignal(episode, 'planNodeCount'));
  const totalPlanNodes = planNodeCounts.reduce((sum, value) => sum + value, 0);
  const scheduledPlanNodes = plans.reduce((sum, episode) => sum + numericSignal(episode, 'scheduledPlanNodeCount'), 0);

  return {
    updatedAt: now,
    windowDays,
    studyRhythm: {
      status: status(studySampleCount, studyDays, 2, 5, 3),
      sampleCount: studySampleCount,
      daysObserved: studyDays,
      sourceIds: sources([...sessions.map((episode) => episode.id), ...timelineSources]),
      activeDays: activeDates.size,
      averageActiveDaysPerWeek: round1(activeDates.size * 7 / windowDays),
      medianSessionMinutes: median(sessionMinutes),
      totalMinutes,
    },
    reviewPattern: {
      status: status(reviews.length, distinctDays(reviews), 1, 3, 2),
      sampleCount: reviews.length,
      daysObserved: distinctDays(reviews),
      sourceIds: sources(reviews.map((episode) => episode.id)),
      medianAnswerTurns: median(reviewTurns),
      medianAnswerChars: median(reviewChars),
      qualifiedReviewRate: percent(qualifiedReviews, reviews.length),
    },
    correctionPattern: {
      status: correctionStatus,
      sampleCount: derivations.length,
      daysObserved: correctionDays,
      sourceIds: sources(derivations.map((episode) => episode.id)),
      submitCount,
      failureCount,
      helpUsageRate: percent(helpCount, submitCount),
      correctionRecoveryRate: percent(correctionCount, failureCount),
    },
    executionPattern: {
      status: status(fulfillment.trackedCompleted, completedTaskDates.size, 3, 8, 3),
      sampleCount: fulfillment.trackedCompleted,
      daysObserved: completedTaskDates.size,
      sourceIds: sources(taskSourceIds),
      onTimeRate: percent(fulfillment.onTimeCompleted, fulfillment.trackedCompleted),
      averageLateDays: fulfillment.averageLateDays,
      overdueOpen: fulfillment.overdueOpen,
    },
    planningPattern: {
      status: status(plans.length, distinctDays(plans), 1, 3, 2),
      sampleCount: plans.length,
      daysObserved: distinctDays(plans),
      sourceIds: sources(plans.map((episode) => episode.id)),
      medianNodeCount: median(planNodeCounts),
      scheduledNodeRate: percent(scheduledPlanNodes, totalPlanNodes),
    },
  };
}

/** 只把达到可信门槛的行为模式写入 LLM 上下文；逾期数作为当前状态例外保留。 */
export function buildLearningHabitContext(profile: LearningHabitProfile): string {
  const rows: string[] = [];
  if (profile.studyRhythm.status === 'trusted') {
    rows.push(`学习节奏：近${profile.windowDays}天活跃 ${profile.studyRhythm.activeDays} 天${profile.studyRhythm.medianSessionMinutes > 0 ? `，单次学习时长中位数 ${profile.studyRhythm.medianSessionMinutes} 分钟` : ''}`);
  }
  if (profile.reviewPattern.status === 'trusted') {
    rows.push(`复习互动：每次回答中位数 ${profile.reviewPattern.medianAnswerTurns} 轮、${profile.reviewPattern.medianAnswerChars} 字，有效复习率 ${profile.reviewPattern.qualifiedReviewRate}%`);
  }
  if (profile.correctionPattern.status === 'trusted') {
    rows.push(`数理推导：求助使用率 ${profile.correctionPattern.helpUsageRate}%${profile.correctionPattern.failureCount > 0 ? `，错误修正成功率 ${profile.correctionPattern.correctionRecoveryRate}%` : '，当前窗口没有失败验证样本'}`);
  }
  if (profile.executionPattern.status === 'trusted') {
    rows.push(`任务履约：按时率 ${profile.executionPattern.onTimeRate}%${profile.executionPattern.averageLateDays > 0 ? `，延期任务平均晚 ${profile.executionPattern.averageLateDays} 天` : ''}`);
  }
  if (profile.planningPattern.status === 'trusted') {
    rows.push(`计划结构：典型计划 ${profile.planningPattern.medianNodeCount} 个节点，有日期节点占 ${profile.planningPattern.scheduledNodeRate}%`);
  }
  if (profile.executionPattern.overdueOpen > 0) {
    rows.push(`当前状态：逾期未完成任务 ${profile.executionPattern.overdueOpen} 项`);
  }
  return rows.length > 0 ? `【近期学习习惯（仅稳定样本）】\n${rows.map((row) => `- ${row}`).join('\n')}` : '';
}

export function learningHabitContextSourceIds(profile: LearningHabitProfile): string[] {
  const groups = [
    profile.studyRhythm,
    profile.reviewPattern,
    profile.correctionPattern,
    profile.executionPattern,
    profile.planningPattern,
  ];
  return sources(groups.flatMap((group) => (
    group.status === 'trusted' || ('overdueOpen' in group && group.overdueOpen > 0) ? group.sourceIds : []
  )));
}
