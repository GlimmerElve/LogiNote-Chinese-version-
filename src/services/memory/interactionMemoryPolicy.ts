import type { LearningEpisode, ProfileSignal } from './types';

export type InteractionMemoryRetention = 'discard' | 'artifact' | 'session' | 'episode';
export type ProfileEvidenceEligibility = 'never' | 'explicit-only' | 'scored-or-repeated';

export type LearningInteractionKind =
  | 'navigation'
  | 'search-or-filter'
  | 'appearance-or-playback'
  | 'resource-view'
  | 'note-edit'
  | 'task-update'
  | 'plan-structure-edit'
  | 'argument-structure-edit'
  | 'derivation-attempt'
  | 'explicit-preference'
  | 'qa-completion'
  | 'plan-completion'
  | 'flow-completion'
  | 'review-completion'
  | 'scene-completion';

export interface InteractionMemoryRule {
  retention: InteractionMemoryRetention;
  profileEvidence: ProfileEvidenceEligibility;
  reason: string;
}

/**
 * 用户交互只允许落到四个层级之一，避免把点击流当成长期画像。
 * - discard：不记录；artifact：只保留最终业务对象；session：仅在本次活动聚合；episode：保存压缩结果。
 */
export const INTERACTION_MEMORY_RULES: Readonly<Record<LearningInteractionKind, InteractionMemoryRule>> = {
  navigation: { retention: 'discard', profileEvidence: 'never', reason: '页面切换不能证明学习特征' },
  'search-or-filter': { retention: 'discard', profileEvidence: 'never', reason: '单次检索通常只是界面操作' },
  'appearance-or-playback': { retention: 'session', profileEvidence: 'never', reason: '音量、暂停等只服务当前活动' },
  'resource-view': { retention: 'session', profileEvidence: 'never', reason: '打开资源不等于理解或偏好' },
  'note-edit': { retention: 'artifact', profileEvidence: 'scored-or-repeated', reason: '保留最终笔记，不记录逐键编辑轨迹' },
  'task-update': { retention: 'artifact', profileEvidence: 'scored-or-repeated', reason: '完成状态留在任务中，习惯只能由多次记录派生' },
  'plan-structure-edit': { retention: 'session', profileEvidence: 'scored-or-repeated', reason: '拖拽与删除过程不长期保存，只保留提交后的计划' },
  'argument-structure-edit': { retention: 'artifact', profileEvidence: 'scored-or-repeated', reason: '保留最终论证图，编辑轨迹不作为画像证据' },
  'derivation-attempt': { retention: 'session', profileEvidence: 'scored-or-repeated', reason: '尝试过程汇总进数理场景结果，不逐步写长期记忆' },
  'explicit-preference': { retention: 'session', profileEvidence: 'explicit-only', reason: '明确自述可随当前活动成为画像候选，不能由点击猜测' },
  'qa-completion': { retention: 'episode', profileEvidence: 'scored-or-repeated', reason: '保存问题与压缩答案，不保存完整请求过程' },
  'plan-completion': { retention: 'episode', profileEvidence: 'scored-or-repeated', reason: '保存已提交计划的目标与结构摘要' },
  'flow-completion': { retention: 'episode', profileEvidence: 'scored-or-repeated', reason: '保存学习结果与分析证据，不保存原始复述全文' },
  'review-completion': { retention: 'episode', profileEvidence: 'scored-or-repeated', reason: '保存评分、知识变化与压缩证据' },
  'scene-completion': { retention: 'episode', profileEvidence: 'scored-or-repeated', reason: '保存结局、指标和代表性表现' },
};

export function getInteractionMemoryRule(kind: LearningInteractionKind): InteractionMemoryRule {
  return INTERACTION_MEMORY_RULES[kind];
}

function hasText(value: string | undefined, minChars = 1): boolean {
  return (value?.trim().length || 0) >= minChars;
}

function hasItems(value: unknown[] | undefined): boolean {
  return Boolean(value?.length);
}

export interface EpisodeMemoryAdmission {
  persist: boolean;
  eligibleForContext: boolean;
  reason: string;
}

/** 只让有目标或可验证结果的完整活动进入语义记忆；待分析/失败项仅用于恢复和诊断。 */
export function evaluateEpisodeMemory(episode: LearningEpisode): EpisodeMemoryAdmission {
  if (episode.profileWriteback?.status === 'pending') {
    return { persist: true, eligibleForContext: false, reason: '画像写入待确认，保留恢复回执但不作为已完成记忆' };
  }
  if (episode.status === 'pending_analysis') {
    return { persist: true, eligibleForContext: false, reason: '保留待分析状态，便于完成后原位更新' };
  }
  if (episode.status === 'failed') {
    return { persist: true, eligibleForContext: false, reason: '保留失败摘要用于诊断，但不注入模型上下文' };
  }

  let meaningful = false;
  switch (episode.type) {
    case 'qa':
      meaningful = hasText(episode.goal, 4) && hasText(episode.summary, 10);
      break;
    case 'plan':
      meaningful = hasText(episode.goal, 2)
        && (hasText(episode.summary, 8) || hasItems(episode.evidenceSnippets));
      break;
    case 'flow':
      meaningful = (episode.durationSeconds || 0) >= 60
        || hasText(episode.summary, 20)
        || hasItems(episode.knowledgePoints)
        || hasItems(episode.unresolvedQuestions)
        || hasItems(episode.evidenceSnippets);
      break;
    case 'review':
      meaningful = typeof episode.score === 'number'
        || hasText(episode.rating)
        || hasItems(episode.evidenceSnippets)
        || hasItems(episode.learningChanges);
      break;
    case 'scene':
      meaningful = typeof episode.score === 'number'
        || hasText(episode.rating)
        || hasItems(episode.evidenceSnippets);
      break;
  }
  if (!meaningful && episode.type === 'review' && hasText(episode.draftAnswer?.content)) {
    return { persist: true, eligibleForContext: false, reason: '未发送的复习草稿仅作为恢复记录保留，不形成语义记忆' };
  }
  return meaningful
    ? { persist: true, eligibleForContext: true, reason: '活动具有目标或可验证结果' }
    : { persist: false, eligibleForContext: false, reason: '活动缺少足够结果，不形成长期记忆' };
}

export interface ProfileSignalAdmission {
  action: 'accept' | 'reject' | 'route';
  reason: string;
}

/**
 * 画像候选的前置准入：
 * 1. 掌握度与学习习惯进入各自聚合器；2. 画像只接受明确自述或可回溯评分；3. 文本评分需要最小样本。
 */
export function evaluateProfileSignal(signal: ProfileSignal, sampleChars: number): ProfileSignalAdmission {
  if (signal.dimension === 'knowledge_mastery') {
    return { action: 'route', reason: '知识掌握由 DSR 学习状态处理' };
  }
  if (signal.dimension === 'learning_habit') {
    return { action: 'route', reason: '学习习惯由周报或多次行为聚合，单次行为不写长期画像' };
  }

  const hasEvidence = Boolean(signal.evidenceSnippetIds?.length);
  const hasCriteria = Boolean(signal.matchedCriteria?.length);
  if (signal.evidenceType === 'explicit') {
    if (signal.dimension === 'ability') {
      return { action: 'reject', reason: '能力画像必须来自任务表现，自我评价只能作为辅助说明' };
    }
    return signal.confidence >= 0.8 && hasEvidence && hasCriteria
      ? { action: 'accept', reason: '用户明确陈述且保留了可回溯证据' }
      : { action: 'reject', reason: '明确偏好缺少高置信度陈述或可回溯证据' };
  }
  if (signal.evidenceType !== 'scored') {
    return { action: 'reject', reason: '单次观察行为不能直接成为能力或风格画像' };
  }
  if (!hasEvidence || !hasCriteria || !signal.rubricVersion) {
    return { action: 'reject', reason: '评分证据缺少片段引用、命中判据或量规版本' };
  }

  // 数理场景由计算结果评分，不依赖自然语言样本长度。
  if (signal.rubricVersion.startsWith('scene-s4-')) {
    return { action: 'accept', reason: '计算引擎结果提供可验证评分证据' };
  }
  const minimumChars = signal.dimension === 'cognitive_style' ? 120 : 80;
  return sampleChars >= minimumChars
    ? { action: 'accept', reason: `样本达到 ${minimumChars} 字且评分可回溯` }
    : { action: 'reject', reason: `有效样本不足 ${minimumChars} 字` };
}
