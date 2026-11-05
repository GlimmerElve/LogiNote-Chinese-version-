import type { LlmWorkflowId, NoteItem, NoteSearchResult } from '../../types';
import { calculateRetrievability } from '../reviewScheduler';
import { masteryReadMode, readKnowledgeMastery } from '../masteryReadModel';
import { MASTERY_SHADOW_STATE_LABELS } from '../masteryShadow/types';
import { buildRagContext, searchNotes } from '../ragService';
import { buildProfileContext, isProfileTrusted } from '../profile/profileContext';
import { getUserProfile } from '../profile/profileStore';
import { loadNotesFromStorage } from '../storage';
import { loadLearningEpisodes } from './episodeStore';
import type { LearningEpisode, LearningEpisodeType } from './types';
import { evaluateEpisodeMemory } from './interactionMemoryPolicy.ts';
import {
  buildLearningHabitContext,
  learningHabitContextSourceIds,
  type LearningHabitProfile,
} from './learningHabitAggregator';
import { loadLearningHabitProfile } from './learningHabitService';
import {
  buildPlanPersonalizationPolicy,
  planPersonalizationSourceIds,
  renderPlanPersonalizationPolicy,
  type PlanPersonalizationPolicy,
} from './planPersonalization';

type MemorySectionKind = 'decision' | 'plan_state' | 'profile' | 'habits' | 'rag' | 'knowledge_state' | 'episodes';

interface MemoryRecipe {
  maxChars: number;
  decisionChars?: number;
  planStateChars?: number;
  profileChars: number;
  habitChars?: number;
  ragChars: number;
  knowledgeStateChars?: number;
  episodeChars: number;
  rag: boolean;
  episodeTypes: LearningEpisodeType[];
  trustedProfileOnly?: boolean;
  includeLearningState?: boolean;
  includeLearningHabits?: boolean;
  includeKnowledgeState?: boolean;
  includePlanDecision?: boolean;
  includePlanState?: boolean;
}

export interface MemoryContextSectionTrace {
  kind: MemorySectionKind;
  included: boolean;
  chars: number;
  reason: string;
  sourceIds: string[];
}

export interface MemoryContextTrace {
  workflow: string;
  maxChars: number;
  usedChars: number;
  budgetTrimmed: boolean;
  sections: MemoryContextSectionTrace[];
  omittedEpisodeIds: string[];
  personalization?: PlanPersonalizationPolicy;
  createdAt: string;
}

export interface MemoryContextAssembly {
  prefix: string;
  trace: MemoryContextTrace;
  ragSources: MemoryRagSource[];
}

export interface MemoryRagSource {
  index: number;
  noteId: string;
  title: string;
  snippet: string;
  score: number;
}

export function selectIncludedRagSources(
  results: NoteSearchResult[],
  assembledPrefix: string,
  limit = 3,
): MemoryRagSource[] {
  return results
    .slice(0, limit)
    .map((item, index) => ({ index: index + 1, ...item }))
    .filter((item) => assembledPrefix.includes(`${item.index}. 笔记「${item.title}」`));
}

export interface MemorySectionInput {
  kind: MemorySectionKind;
  text: string;
  maxChars: number;
  sourceIds: string[];
  reason: string;
}

const RECIPES: Partial<Record<LlmWorkflowId, MemoryRecipe>> = {
  'agent-chat': {
    maxChars: 4000, profileChars: 850, habitChars: 450, ragChars: 1200, knowledgeStateChars: 600, episodeChars: 900,
    rag: true, episodeTypes: ['review', 'flow', 'scene', 'qa', 'plan'], includeLearningState: true, includeLearningHabits: true, includeKnowledgeState: true,
  },
  'agent-resource-curation': {
    maxChars: 3200, profileChars: 650, habitChars: 350, ragChars: 1300, knowledgeStateChars: 600, episodeChars: 300,
    rag: true, episodeTypes: ['review', 'flow', 'scene', 'qa', 'plan'], trustedProfileOnly: true,
    includeLearningState: true, includeLearningHabits: true, includeKnowledgeState: true,
  },
  'agent-study-task-generation': {
    maxChars: 3800, decisionChars: 1000, profileChars: 0, habitChars: 0, ragChars: 1400, knowledgeStateChars: 900, episodeChars: 500,
    rag: true, episodeTypes: ['plan', 'review', 'flow', 'scene'], includeKnowledgeState: true, includePlanDecision: true,
  },
  'agent-personalized-qa': {
    maxChars: 2600, profileChars: 750, habitChars: 300, ragChars: 0, knowledgeStateChars: 0, episodeChars: 750,
    rag: false, episodeTypes: ['qa', 'review', 'flow', 'scene'], trustedProfileOnly: true, includeLearningHabits: true,
  },
  'agent-scene-setup': {
    maxChars: 2400, profileChars: 650, habitChars: 350, ragChars: 0, knowledgeStateChars: 700, episodeChars: 600,
    rag: false, episodeTypes: ['scene', 'review', 'flow'], trustedProfileOnly: true,
    includeLearningState: true, includeLearningHabits: true, includeKnowledgeState: true,
  },
  'plan-generation': {
    maxChars: 5600, decisionChars: 1500, planStateChars: 1100, profileChars: 0, ragChars: 1300, knowledgeStateChars: 850, episodeChars: 650,
    rag: true, episodeTypes: ['plan', 'review', 'flow', 'scene'], includeKnowledgeState: true, includePlanDecision: true, includePlanState: true,
  },
  'review-tutor': {
    maxChars: 4200, profileChars: 800, habitChars: 500, ragChars: 1900, episodeChars: 900,
    rag: true, episodeTypes: ['review', 'flow', 'scene'], includeLearningHabits: true,
  },
  'question-answer': {
    maxChars: 4200, profileChars: 900, ragChars: 2200, episodeChars: 1100,
    rag: true, episodeTypes: ['review', 'flow', 'scene'],
  },
  'scene-generate': {
    maxChars: 3600, profileChars: 800, habitChars: 450, ragChars: 1300, episodeChars: 1050,
    rag: true, episodeTypes: ['scene', 'review', 'flow'], trustedProfileOnly: true, includeLearningHabits: true,
  },
  'scene-adapt': {
    maxChars: 3600, profileChars: 800, habitChars: 450, ragChars: 1300, episodeChars: 1050,
    rag: true, episodeTypes: ['scene', 'review', 'flow'], trustedProfileOnly: true, includeLearningHabits: true,
  },
  'scene-compute-generate': {
    maxChars: 3600, profileChars: 800, habitChars: 450, ragChars: 1300, episodeChars: 1050,
    rag: true, episodeTypes: ['scene', 'review', 'flow'], trustedProfileOnly: true, includeLearningHabits: true,
  },
  'scene-compute-config': {
    maxChars: 2600, profileChars: 500, habitChars: 250, ragChars: 1200, episodeChars: 650,
    rag: true, episodeTypes: ['scene', 'review', 'flow'], trustedProfileOnly: true, includeLearningHabits: true,
  },
  'scene-compute-adapt': {
    maxChars: 3600, profileChars: 800, habitChars: 450, ragChars: 1300, episodeChars: 1050,
    rag: true, episodeTypes: ['scene', 'review', 'flow'], trustedProfileOnly: true, includeLearningHabits: true,
  },
  'scene-role-reply': {
    maxChars: 1000, profileChars: 1000, ragChars: 0, episodeChars: 0,
    rag: false, episodeTypes: [], trustedProfileOnly: true,
  },
  'scene-general-turn': {
    maxChars: 3000, profileChars: 900, ragChars: 1800, episodeChars: 0,
    rag: true, episodeTypes: [], trustedProfileOnly: true,
  },
};

export function hasMemoryContextRecipe(workflow: string): boolean {
  return Object.prototype.hasOwnProperty.call(RECIPES, workflow);
}

const QUERY_STOP_WORDS = new Set([
  '用户', '当前', '输入', '上下文', '知识点', '所属笔记', '对话历史', '请根据', '为什么', '如何', '什么', '这个', '一个',
]);

function compact(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 1))}…`;
}

function queryTerms(query: string): string[] {
  return [...new Set((query.toLocaleLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) || [])
    .filter((term) => !QUERY_STOP_WORDS.has(term))
    .slice(0, 40))];
}

function episodeText(episode: LearningEpisode): string {
  return [
    episode.title,
    episode.goal,
    ...(episode.knowledgePoints || []),
    ...(episode.unresolvedQuestions || []),
    ...(episode.evidenceSnippets || []).map((item) => item.text),
  ].filter(Boolean).join(' ').toLocaleLowerCase();
}

/** 纯函数：只选择与当前问题有文字交集的近期压缩事件，不用“最近发生”冒充“相关”。 */
export function selectRelevantEpisodes(
  episodes: LearningEpisode[],
  query: string,
  allowedTypes: LearningEpisodeType[],
  limit = 3,
): { selected: LearningEpisode[]; omittedIds: string[] } {
  const terms = queryTerms(query);
  const allowed = new Set(allowedTypes);
  const ranked = episodes
    .filter((episode) => allowed.has(episode.type) && evaluateEpisodeMemory(episode).eligibleForContext)
    .map((episode) => {
      const text = episodeText(episode);
      const score = terms.reduce((sum, term) => sum + (text.includes(term) ? Math.min(term.length, 8) : 0), 0);
      return { episode, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.episode.endedAt.localeCompare(a.episode.endedAt));
  return {
    selected: ranked.slice(0, limit).map((item) => item.episode),
    omittedIds: ranked.slice(limit).map((item) => item.episode.id),
  };
}

function renderEpisodes(episodes: LearningEpisode[]): string {
  if (episodes.length === 0) return '';
  const rows = episodes.map((episode) => {
    const evidence = (episode.evidenceSnippets || []).slice(0, 2).map((item) => item.text).join('；');
    const result = [episode.rating, episode.recommendation, evidence].filter(Boolean).join('；');
    return `- ${episode.endedAt.slice(0, 10)}｜${episode.title}${result ? `｜${result}` : ''}`;
  });
  return `【与当前任务相关的学习记忆】\n${rows.join('\n')}`;
}

function renderLearningState(): string {
  const ability = getUserProfile().learningAbility;
  const latestStudy = ability.studyWeekly.at(-1);
  const latestError = ability.errorWeekly.at(-1);
  const latestReasoning = ability.reasoningWeekly.at(-1);
  const domains = [...ability.domains]
    .sort((a, b) => a.masteryRate - b.masteryRate)
    .slice(0, 3)
    .map((item) => `${item.projectTitle} ${Math.round(item.masteryRate * 100)}%`);
  const parts = [
    ability.masteredCount > 0 ? `已掌握知识点 ${ability.masteredCount} 个` : '',
    ability.currentStreak > 0 ? `连续学习 ${ability.currentStreak} 天` : '',
    ability.newMasteredThisWeek > 0 || ability.newMasteredLastWeek > 0
      ? `本周新增掌握 ${ability.newMasteredThisWeek} 个，上周 ${ability.newMasteredLastWeek} 个`
      : '',
    latestStudy ? `最近一周学习 ${latestStudy.totalMinutes} 分钟、活跃 ${latestStudy.activeDays} 天` : '',
    latestError ? `最近一周平均错误 ${latestError.errorRate.toFixed(1)} 次/结论` : '',
    latestReasoning
      ? `最近推理表现：概念 ${latestReasoning.conceptScore.toFixed(0)}、判断 ${latestReasoning.judgmentScore.toFixed(0)}、逻辑 ${latestReasoning.logicScore.toFixed(0)}`
      : '',
    domains.length > 0 ? `领域掌握进度（较低项优先）：${domains.join('，')}` : '',
  ].filter(Boolean);
  return parts.length > 0 ? `【近期学习状态】\n${parts.join('；')}` : '';
}

/**
 * 计划记忆只提供当前计划组合的压缩背景。真正修改前仍必须通过
 * 单根调整通过 query_plan_workspace、综合统筹通过 query_plan_portfolio
 * 读取权威状态，避免用过期摘要覆盖实际数据。
 */
export function buildPlanStateContext(
  notes: NoteItem[],
  query: string,
  limit = 3,
): { text: string; sourceIds: string[] } {
  const terms = queryTerms(query);
  const roots = notes
    .filter((note) => note.noteType === 'project' && Boolean(note.planMeta))
    .map((root) => {
      const scopeIds = new Set<string>([root.id]);
      let changed = true;
      while (changed) {
        changed = false;
        notes.forEach((note) => {
          if (note.noteType !== 'project' || !note.parentId || !scopeIds.has(note.parentId) || scopeIds.has(note.id)) return;
          scopeIds.add(note.id);
          changed = true;
        });
      }
      const scope = notes.filter((note) => scopeIds.has(note.id));
      const titleText = [root.title, root.planMeta?.shortTitle, root.planMeta?.summary].filter(Boolean).join(' ').toLocaleLowerCase();
      const relevance = terms.reduce((sum, term) => sum + (titleText.includes(term) ? Math.min(term.length, 8) : 0), 0);
      const scheduled = scope.flatMap((note) => note.dueDates)
        .filter((item) => scope.some((note) => note.id === item.noteId && item.taskText.trim() === note.title.trim()));
      const execution = scope.flatMap((note) => note.dueDates)
        .filter((item) => !scheduled.some((deadline) => deadline.id === item.id));
      return { root, scope, relevance, scheduled, execution };
    })
    .sort((a, b) => b.relevance - a.relevance || (b.root.planMeta?.updatedAt || b.root.updatedAt).localeCompare(a.root.planMeta?.updatedAt || a.root.updatedAt))
    .slice(0, limit);
  if (roots.length === 0) return { text: '', sourceIds: [] };
  const rows = roots.map(({ root, scheduled, execution }) => {
    const meta = root.planMeta!;
    const open = scheduled.filter((item) => !item.completed).length;
    const recurring = execution.filter((item) => item.recurrence && item.recurrence.frequency !== 'none').length;
    const milestones = meta.milestones || [];
    const milestoneSummary = milestones.length
      ? `里程碑 ${milestones.filter((item) => item.completed).length}/${milestones.length}`
      : '无里程碑';
    return `- ${root.title}｜${meta.status}｜${meta.startDate || '未设开始'}→${meta.targetDate || '未设截止'}｜本计划每日 ${meta.dailyStudyMinutes ?? '待确认'} 分钟（个人共享周预算用 query_learning_capacity 查询，不能相加旧计划预算）｜未完成结构项目 ${open} 个｜周期事项 ${recurring} 个｜${milestoneSummary}`;
  });
  return {
    text: [
      '【当前计划组合摘要】',
      '仅用于判断现有负荷和可能的目标冲突；不是本次用户的硬约束。单根调整前调用 query_plan_workspace 核对；综合或多计划统筹时调用 query_plan_portfolio，并传入界面给出的精确 rootProjectIds。',
      ...rows,
    ].join('\n'),
    sourceIds: roots.map((item) => item.root.id),
  };
}

/** 只展开语义检索命中的知识点状态；不把整个知识库塞入上下文。 */
export function buildKnowledgeStateContext(
  notes: NoteItem[],
  relevantNoteIds: string[],
  limit = 3,
): { text: string; sourceIds: string[] } {
  const noteById = new Map(notes.map((note) => [note.id, note]));
  const relevantNotes = [...new Set(relevantNoteIds)]
    .map((id) => noteById.get(id))
    .filter((note): note is NoteItem => Boolean(note) && note.noteType === 'knowledge')
    .slice(0, limit);

  const rows = relevantNotes.map((note) => {
    const dsr = note.dsrState;
    if (masteryReadMode() === 'current') {
      const view = readKnowledgeMastery(note);
      const layers = (['concept', 'judgment', 'reasoning'] as const).map((layer, index) =>
        `${['概念', '判断', '推理'][index]}${MASTERY_SHADOW_STATE_LABELS[view.layers[layer]]}`).join('、');
      return `- ${note.title}｜${layers}｜${view.nextAction}${view.contentStatus !== 'ready' ? '｜资料待补全（不是不掌握）' : ''}`
        + `${view.historyScore == null ? '' : `｜历史评分${Math.round(view.historyScore)}%（不作当前掌握依据）`}`
        + `${view.retrievability == null ? '' : `｜记忆可提取率${Math.round(view.retrievability * 100)}%（与理解分开）`}`;
    }
    if (!dsr) return `- ${note.title}｜尚无掌握评估（需先诊断）`;

    const samples = dsr.conceptMasterySamples || 0;
    const mastery = typeof dsr.conceptMastery === 'number'
      ? `${Math.round(dsr.conceptMastery)}%（${samples >= 2 ? `${samples}次证据` : '暂定，证据不足'}）`
      : '未评定';
    const retrievability = Math.round(calculateRetrievability(dsr.stability, dsr.lastReviewedAt) * 100);
    const wrongStreak = dsr.consecutiveWrong > 0 ? `｜连续错误 ${dsr.consecutiveWrong} 次` : '';
    const lastReviewed = dsr.lastReviewedAt ? dsr.lastReviewedAt.slice(0, 10) : '未复习';
    return `- ${note.title}｜概念掌握 ${mastery}｜难度 ${dsr.difficulty.toFixed(1)}/10｜当前可提取率 ${retrievability}%｜稳定性 ${dsr.stability.toFixed(1)} 天｜复习 ${dsr.reviewCount} 次${wrongStreak}｜上次 ${lastReviewed}`;
  });

  return {
    text: rows.length > 0 ? `【与目标相关的知识点状态】\n${rows.join('\n')}` : '',
    sourceIds: relevantNotes.map((note) => note.id),
  };
}

/** 纯函数：按各段上限与总上限裁剪，并返回可以审计的预算轨迹。 */
export function composeMemoryContext(
  workflow: string,
  maxChars: number,
  sections: MemorySectionInput[],
  omittedEpisodeIds: string[] = [],
): MemoryContextAssembly {
  let remaining = maxChars;
  let budgetTrimmed = false;
  const texts: string[] = [];
  const traces: MemoryContextSectionTrace[] = [];

  for (const section of sections) {
    const separatorChars = texts.length > 0 ? 2 : 0;
    const sectionLimit = Math.min(section.maxChars, Math.max(0, remaining - separatorChars));
    const clipped = sectionLimit > 0 ? compact(section.text, sectionLimit) : '';
    if (section.text.trim().length > clipped.length) budgetTrimmed = true;
    if (clipped) {
      texts.push(clipped);
      remaining -= clipped.length + separatorChars;
    }
    traces.push({
      kind: section.kind,
      included: Boolean(clipped),
      chars: clipped.length,
      reason: clipped ? section.reason : section.text.trim() ? '上下文预算不足' : '没有可用内容',
      sourceIds: clipped ? section.sourceIds : [],
    });
  }

  const prefix = texts.join('\n\n');
  return {
    prefix,
    ragSources: [],
    trace: {
      workflow,
      maxChars,
      usedChars: prefix.length,
      budgetTrimmed,
      sections: traces,
      omittedEpisodeIds,
      createdAt: new Date().toISOString(),
    },
  };
}

// 这里仅供当前界面即时查看最近轨迹；Agent 历史审计由 agent/auditStore 以有上限的独立文件持久化。
const latestTraceByWorkflow = new Map<string, MemoryContextTrace>();

export function getLatestMemoryContextTrace(workflow: string): MemoryContextTrace | undefined {
  return latestTraceByWorkflow.get(workflow);
}

export function listLatestMemoryContextTraces(): MemoryContextTrace[] {
  return [...latestTraceByWorkflow.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function assembleMemoryContext(input: {
  workflow: LlmWorkflowId;
  query: string;
  skipProfile?: boolean;
  /** Already synchronized workspace snapshot; never reload the vault for an Agent turn. */
  notes?: NoteItem[];
}): Promise<MemoryContextAssembly> {
  const recipe = RECIPES[input.workflow];
  if (!recipe) return composeMemoryContext(input.workflow, 0, []);

  const sections: MemorySectionInput[] = [];
  const profile = getUserProfile();
  let notesForMemory: NoteItem[] | null = input.notes ?? null;
  if (!input.skipProfile && (recipe.includeLearningState || recipe.includeLearningHabits || recipe.includeKnowledgeState || recipe.includePlanDecision || recipe.includePlanState)) {
    try {
      notesForMemory ??= await loadNotesFromStorage();
    } catch (error) {
      console.warn('[memory-context] 任务履约状态读取失败，继续使用其他记忆:', (error as Error)?.message);
    }
  }
  const longTermProfile = !input.skipProfile
    && recipe.profileChars > 0
    && profile.analysisCount > 0
    && (!recipe.trustedProfileOnly || isProfileTrusted(profile))
    ? buildProfileContext(profile)
    : '';
  const learningState = !input.skipProfile && recipe.includeLearningState ? renderLearningState() : '';
  const profileText = [longTermProfile, learningState].filter(Boolean).join('\n\n');
  sections.push({
    kind: 'profile',
    text: profileText,
    maxChars: recipe.profileChars,
    sourceIds: [longTermProfile ? 'user-profile' : '', learningState ? 'learning-ability' : ''].filter(Boolean),
    reason: input.skipProfile ? '调用方关闭画像注入' : recipe.trustedProfileOnly ? '使用已采信的长期画像' : '使用门控后的长期画像',
  });

  let learningHabits: LearningHabitProfile | null = null;
  if (!input.skipProfile && (recipe.includeLearningHabits || recipe.includePlanDecision)) {
    try {
      learningHabits = await loadLearningHabitProfile(notesForMemory || undefined);
    } catch (error) {
      console.warn('[memory-context] 长期习惯聚合失败，继续使用其他记忆:', (error as Error)?.message);
    }
  }
  if (recipe.includeLearningHabits) {
    sections.push({
      kind: 'habits',
      text: learningHabits ? buildLearningHabitContext(learningHabits) : '',
      maxChars: recipe.habitChars || 0,
      sourceIds: learningHabits ? learningHabitContextSourceIds(learningHabits) : [],
      reason: input.skipProfile ? '调用方关闭画像注入' : '只注入达到稳定样本门槛的学习习惯',
    });
  }

  if (recipe.includePlanState) {
    const planState = buildPlanStateContext(notesForMemory || [], input.query);
    sections.push({
      kind: 'plan_state',
      text: planState.text,
      maxChars: recipe.planStateChars || 0,
      sourceIds: planState.sourceIds,
      reason: '压缩读取当前活跃计划负荷；修改前仍需工具核对',
    });
  }

  let ragResults: NoteSearchResult[] = [];
  if (recipe.rag && input.query.trim()) {
    try {
      ragResults = await searchNotes(input.query.slice(0, 4000), 3);
      if (notesForMemory) {
        const knowledgeIds = new Set(notesForMemory.filter((note) => note.noteType === 'knowledge').map((note) => note.id));
        ragResults = ragResults.filter((hit) => knowledgeIds.has(hit.noteId));
      }
    } catch (error) {
      console.warn('[memory-context] 笔记检索失败，继续使用其他记忆:', (error as Error)?.message);
    }
  }
  sections.push({
    kind: 'rag',
    text: buildRagContext(ragResults, 3),
    maxChars: recipe.ragChars,
    sourceIds: ragResults.map((item) => item.noteId),
    reason: '按当前任务语义检索用户笔记',
  });

  let relevantKnowledgeNotes: NoteItem[] = [];
  if (recipe.includeKnowledgeState) {
    let knowledgeState = { text: '', sourceIds: [] as string[] };
    if (ragResults.length > 0) {
      try {
        notesForMemory ??= await loadNotesFromStorage();
        knowledgeState = buildKnowledgeStateContext(
          notesForMemory,
          ragResults.map((item) => item.noteId),
        );
        const relevantIds = new Set(knowledgeState.sourceIds);
        relevantKnowledgeNotes = notesForMemory
          .filter((note) => relevantIds.has(note.id));
      } catch (error) {
        console.warn('[memory-context] 知识点掌握状态读取失败，继续使用其他记忆:', (error as Error)?.message);
      }
    }
    sections.push({
      kind: 'knowledge_state',
      text: knowledgeState.text,
      maxChars: recipe.knowledgeStateChars || 0,
      sourceIds: knowledgeState.sourceIds,
      reason: '只读取与计划目标语义相关的知识点掌握状态',
    });
  }

  let selectedEpisodes: LearningEpisode[] = [];
  let omittedEpisodeIds: string[] = [];
  if (recipe.episodeTypes.length > 0 && input.query.trim()) {
    try {
      const selected = selectRelevantEpisodes(await loadLearningEpisodes(), input.query, recipe.episodeTypes, 3);
      selectedEpisodes = selected.selected;
      omittedEpisodeIds = selected.omittedIds;
    } catch (error) {
      console.warn('[memory-context] 学习事件读取失败，继续使用其他记忆:', (error as Error)?.message);
    }
  }
  sections.push({
    kind: 'episodes',
    text: renderEpisodes(selectedEpisodes),
    maxChars: recipe.episodeChars,
    sourceIds: selectedEpisodes.map((episode) => episode.id),
    reason: '选择与当前任务有文字交集的最近学习事件',
  });

  let personalization: PlanPersonalizationPolicy | undefined;
  if (recipe.includePlanDecision && !input.skipProfile) {
    personalization = buildPlanPersonalizationPolicy({
      profile,
      habits: learningHabits,
      relevantKnowledgeNotes,
      query: input.query,
    });
    sections.unshift({
      kind: 'decision',
      text: renderPlanPersonalizationPolicy(personalization),
      maxChars: recipe.decisionChars || 0,
      sourceIds: planPersonalizationSourceIds(personalization),
      reason: '把可信画像、稳定习惯和相关知识状态转换为本次计划约束',
    });
  }

  const assembly = composeMemoryContext(input.workflow, recipe.maxChars, sections, omittedEpisodeIds);
  const ragTrace = assembly.trace.sections.find((section) => section.kind === 'rag');
  if (ragTrace?.included) {
    // Only expose sources whose numbered entry survived the final context budget.
    assembly.ragSources = selectIncludedRagSources(ragResults, assembly.prefix);
  }
  if (personalization) assembly.trace.personalization = personalization;
  latestTraceByWorkflow.set(input.workflow, assembly.trace);
  return assembly;
}
