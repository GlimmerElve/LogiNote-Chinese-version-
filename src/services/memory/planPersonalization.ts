import type { NoteItem, UserProfile } from '../../types.ts';
import { isProfileIndicatorTrusted } from '../profile/profileTrust.ts';
import type { LearningHabitProfile } from './learningHabitAggregator.ts';
import { masteryReadMode, readKnowledgeMastery } from '../masteryReadModel';

export type PlanDecisionBasis = 'trusted_profile' | 'trusted_habit' | 'knowledge_state' | 'current_state';
export type PlanDecisionCategory = 'learning_path' | 'task_granularity' | 'practice' | 'review' | 'schedule';

export interface PlanPersonalizationDecision {
  id: string;
  category: PlanDecisionCategory;
  basis: PlanDecisionBasis;
  instruction: string;
  reason: string;
  sourceIds: string[];
}

export interface DeferredPersonalizationSignal {
  label: string;
  reason: string;
  sourceIds: string[];
}

export interface PlanPersonalizationPolicy {
  decisions: PlanPersonalizationDecision[];
  deferred: DeferredPersonalizationSignal[];
}

export interface PlanPersonalizationInput {
  profile: UserProfile;
  habits: LearningHabitProfile | null;
  relevantKnowledgeNotes: NoteItem[];
  query: string;
}

const unique = (values: string[]): string[] => [...new Set(values.filter(Boolean))];

function profileSources(profile: UserProfile, dimension: 'ability' | 'cognitive_style', indicator: string): string[] {
  const aggregate = profile.evidenceGate?.aggregates[`${dimension}:${indicator}`];
  const ids = unique(aggregate?.samples.map((sample) => sample.episodeId) || []);
  return ids.length > 0 ? ids : ['user-profile'];
}

function queryIncludes(query: string, value: string): boolean {
  const normalizedQuery = query.replace(/\s+/g, '').toLocaleLowerCase();
  const normalizedValue = value.replace(/\s+/g, '').toLocaleLowerCase();
  return normalizedValue.length >= 2 && normalizedQuery.includes(normalizedValue);
}

/**
 * 将可信证据翻译成计划约束。这里只做保守的确定性映射，不推断人格，也不让历史数据覆盖本次明确输入。
 */
export function buildPlanPersonalizationPolicy(input: PlanPersonalizationInput): PlanPersonalizationPolicy {
  const decisions: PlanPersonalizationDecision[] = [];
  const deferred: DeferredPersonalizationSignal[] = [];
  const { profile, habits } = input;
  const add = (decision: PlanPersonalizationDecision) => decisions.push(decision);

  const abilityRules = [
    {
      indicator: 'conceptClarity', value: profile.ability.conceptClarity,
      lowInstruction: '把基础概念任务组织为“定义—正反例—自我解释—应用”，先验证理解再推进。',
      lowReason: '可信画像显示概念清晰度仍需支架。',
      highInstruction: '压缩纯定义复述，把更多时间用于概念迁移、辨析和真实应用。',
      highReason: '可信画像显示概念基础较稳，可提高迁移任务占比。',
    },
    {
      indicator: 'judgmentReasonableness', value: profile.ability.judgmentReasonableness,
      lowInstruction: '在关键阶段加入适用条件、边界、事实与观点辨析以及反例检查。',
      lowReason: '可信画像显示判断合理性仍需专项练习。',
      highInstruction: '减少机械判断题，增加条件变化、权衡和情境决策任务。',
      highReason: '可信画像显示基础判断较稳，可提升情境复杂度。',
    },
    {
      indicator: 'reasoningValidity', value: profile.ability.reasoningValidity,
      lowInstruction: '把复杂任务拆成显式的“前提—步骤—结论—验证”，每阶段保留一次完整推导。',
      lowReason: '可信画像显示推理有效性仍需结构化训练。',
      highInstruction: '安排综合推导、方案论证或开放问题，避免只做单步练习。',
      highReason: '可信画像显示基础推理较稳，可增加综合任务。',
    },
  ] as const;

  for (const rule of abilityRules) {
    if (!isProfileIndicatorTrusted(profile, 'ability', rule.indicator)) continue;
    if (rule.value < 45) {
      add({
        id: `ability-${rule.indicator}-support`, category: 'practice', basis: 'trusted_profile',
        instruction: rule.lowInstruction, reason: rule.lowReason,
        sourceIds: profileSources(profile, 'ability', rule.indicator),
      });
    } else if (rule.value >= 70) {
      add({
        id: `ability-${rule.indicator}-challenge`, category: 'practice', basis: 'trusted_profile',
        instruction: rule.highInstruction, reason: rule.highReason,
        sourceIds: profileSources(profile, 'ability', rule.indicator),
      });
    }
  }

  const cognitive = profile.cognitiveStyle;
  if (isProfileIndicatorTrusted(profile, 'cognitive_style', 'abstractVsConcrete')) {
    if (cognitive.abstractVsConcrete >= 30) {
      add({
        id: 'style-framework-first', category: 'learning_path', basis: 'trusted_profile',
        instruction: '先呈现知识框架和概念关系，再为每个阶段安排具体案例或产出。',
        reason: '可信画像显示更偏好从抽象框架进入。',
        sourceIds: profileSources(profile, 'cognitive_style', 'abstractVsConcrete'),
      });
    } else if (cognitive.abstractVsConcrete <= -30) {
      add({
        id: 'style-example-first', category: 'learning_path', basis: 'trusted_profile',
        instruction: '先用案例、操作或问题建立直觉，再总结概念框架。',
        reason: '可信画像显示更偏好从具体经验进入。',
        sourceIds: profileSources(profile, 'cognitive_style', 'abstractVsConcrete'),
      });
    }
  }
  if (isProfileIndicatorTrusted(profile, 'cognitive_style', 'systematicVsScattered')) {
    if (cognitive.systematicVsScattered <= -25) {
      add({
        id: 'style-explicit-dependencies', category: 'task_granularity', basis: 'trusted_profile',
        instruction: '保持层级简洁，明确标出前置依赖；叶子任务一次只包含一个可验证动作。',
        reason: '可信画像显示信息组织更容易零散，需要外部结构支架。',
        sourceIds: profileSources(profile, 'cognitive_style', 'systematicVsScattered'),
      });
    } else if (cognitive.systematicVsScattered >= 35) {
      add({
        id: 'style-system-map', category: 'learning_path', basis: 'trusted_profile',
        instruction: '保留清晰的总路线、阶段依赖和阶段产出，允许从整体框架向下展开。',
        reason: '可信画像显示能够较好地使用系统化框架。',
        sourceIds: profileSources(profile, 'cognitive_style', 'systematicVsScattered'),
      });
    }
  }

  if (habits) {
    if (habits.studyRhythm.status === 'trusted' && habits.studyRhythm.medianSessionMinutes > 0) {
      add({
        id: 'habit-session-size', category: 'task_granularity', basis: 'trusted_habit',
        instruction: `叶子任务尽量设计为约 ${habits.studyRhythm.medianSessionMinutes} 分钟可完成的单次学习单元；本次用户明确填写的每日时间优先。`,
        reason: `近 ${habits.windowDays} 天稳定样本中的单次学习时长中位数为 ${habits.studyRhythm.medianSessionMinutes} 分钟。`,
        sourceIds: habits.studyRhythm.sourceIds,
      });
    }
    if (habits.executionPattern.status === 'trusted' && habits.executionPattern.onTimeRate < 70) {
      add({
        id: 'habit-schedule-buffer', category: 'schedule', basis: 'trusted_habit',
        instruction: '减少并行任务，在阶段截止日前预留复盘和顺延缓冲，不按理论最大负荷排满。',
        reason: `近 ${habits.windowDays} 天有充分样本的任务按时率为 ${habits.executionPattern.onTimeRate}%。`,
        sourceIds: habits.executionPattern.sourceIds,
      });
    }
    if (habits.executionPattern.overdueOpen > 0) {
      add({
        id: 'state-overdue-load', category: 'schedule', basis: 'current_state',
        instruction: '首阶段先处理或重新确认现有逾期任务，避免新计划日期与旧任务直接叠加。',
        reason: `当前仍有 ${habits.executionPattern.overdueOpen} 项逾期未完成任务。`,
        sourceIds: habits.executionPattern.sourceIds,
      });
    }
    if (habits.reviewPattern.status === 'trusted' && habits.reviewPattern.qualifiedReviewRate < 60) {
      add({
        id: 'habit-active-review', category: 'review', basis: 'trusted_habit',
        instruction: '每个阶段安排短时主动回忆、解释或小测，不把“阅读完成”作为掌握证据。',
        reason: `稳定样本中的有效复习率为 ${habits.reviewPattern.qualifiedReviewRate}%。`,
        sourceIds: habits.reviewPattern.sourceIds,
      });
    }

    const provisional = [
      ['学习节奏', habits.studyRhythm],
      ['复习互动', habits.reviewPattern],
      ['纠错方式', habits.correctionPattern],
      ['任务履约', habits.executionPattern],
      ['计划结构', habits.planningPattern],
    ] as const;
    for (const [label, group] of provisional) {
      if (group.status !== 'provisional') continue;
      deferred.push({ label, reason: '样本尚未达到稳定门槛，不直接改变计划。', sourceIds: group.sourceIds });
    }
  }

  for (const note of input.relevantKnowledgeNotes.slice(0, 3)) {
    if (masteryReadMode() === 'current') {
      const view = readKnowledgeMastery(note);
      const { reviewCategory: category } = view;
      if (category === 'content_incomplete') add({ id: `knowledge-content-${note.id}`, category: 'learning_path', basis: 'knowledge_state',
        instruction: `先补齐“${note.title}”的可读参考资料；资料缺失不能判为理解不足。`, reason: view.nextAction, sourceIds: [note.id] });
      else if (category === 'verify' || category === 'strengthen') add({ id: `knowledge-foundation-${note.id}`, category: 'learning_path', basis: 'knowledge_state',
        instruction: `对“${note.title}”安排对应层次的核验与补强，不抹去其他层已经确认的掌握。`, reason: `${view.displayLabel}；${view.nextAction}`, sourceIds: [note.id] });
      else if (category === 'stable') add({ id: `knowledge-transfer-${note.id}`, category: 'practice', basis: 'knowledge_state',
        instruction: `“${note.title}”已有分层确认，可用迁移、综合应用或产出任务进一步检验。`, reason: view.summary, sourceIds: [note.id] });
      else if (category === 'memory_refresh') add({ id: `knowledge-memory-${note.id}`, category: 'review', basis: 'knowledge_state',
        instruction: `为“${note.title}”安排记忆刷新，不把需要回忆等同于理解退步。`, reason: view.nextAction, sourceIds: [note.id] });
      else add({ id: `knowledge-diagnose-${note.id}`, category: 'learning_path', basis: 'knowledge_state',
        instruction: `对“${note.title}”做简短检验，${category === 'confirm' ? '确认已有通过表现' : '补充尚未评估层次的证据'}，不凭旧分数预判掌握。`,
        reason: `${view.displayLabel}；${view.nextAction}`, sourceIds: [note.id] });
      continue;
    }
    const dsr = note.dsrState;
    if (!dsr || typeof dsr.conceptMastery !== 'number' || (dsr.conceptMasterySamples || 0) < 2) {
      add({
        id: `knowledge-diagnose-${note.id}`, category: 'learning_path', basis: 'knowledge_state',
        instruction: `在“${note.title}”相关任务开始前安排简短诊断，不把已有笔记等同于已经掌握。`,
        reason: '该知识点尚无足够掌握证据。', sourceIds: [note.id],
      });
      continue;
    }
    if (dsr.conceptMastery < 55) {
      add({
        id: `knowledge-foundation-${note.id}`, category: 'learning_path', basis: 'knowledge_state',
        instruction: `把“${note.title}”列为前置补强项，先完成理解与应用验证，再进入依赖它的任务。`,
        reason: `该知识点当前概念掌握度为 ${Math.round(dsr.conceptMastery)}%。`, sourceIds: [note.id],
      });
    } else if (dsr.conceptMastery >= 75) {
      add({
        id: `knowledge-transfer-${note.id}`, category: 'practice', basis: 'knowledge_state',
        instruction: `对“${note.title}”减少重复讲解，改用迁移、综合应用或产出任务验证。`,
        reason: `该知识点有 ${dsr.conceptMasterySamples} 次有效样本，概念掌握度为 ${Math.round(dsr.conceptMastery)}%。`, sourceIds: [note.id],
      });
    }
  }

  const relevantWeakDomain = profile.learningAbility.domains.find((domain) => (
    domain.totalCount > 0 && domain.masteryRate < 0.55 && queryIncludes(input.query, domain.projectTitle)
  ));
  if (relevantWeakDomain) {
    add({
      id: 'state-domain-foundation', category: 'learning_path', basis: 'current_state',
      instruction: masteryReadMode() === 'current'
        ? `“${relevantWeakDomain.projectTitle}”领域先区分未评估与待复核，再安排检验或补强；缺少确认不等于不掌握。`
        : `“${relevantWeakDomain.projectTitle}”领域先补齐未掌握的前置知识点，再安排综合项目。`,
      reason: `当前关联知识点${masteryReadMode() === 'current' ? '已确认' : '掌握'} ${relevantWeakDomain.masteredCount}/${relevantWeakDomain.totalCount}。`,
      sourceIds: ['learning-ability'],
    });
  }

  return { decisions: decisions.slice(0, 8), deferred };
}

export function renderPlanPersonalizationPolicy(policy: PlanPersonalizationPolicy): string {
  if (policy.decisions.length === 0) return '';
  const rows = policy.decisions.map((decision) => `- ${decision.instruction}（依据：${decision.reason}）`);
  return [
    '【本次个性化计划决策】',
    '以下是证据门控后的计划约束；用户本次明确填写的目标、结果和可用时间优先，二者冲突时忽略历史推断。',
    ...rows,
  ].join('\n');
}

export function planPersonalizationSourceIds(policy: PlanPersonalizationPolicy): string[] {
  return unique(policy.decisions.flatMap((decision) => decision.sourceIds));
}
