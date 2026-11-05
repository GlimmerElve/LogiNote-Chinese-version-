import type { ViewMode } from '../../../types';
import type { AgentKnowledgeNoteInput, AgentQuickCheckLaunchRequest, AgentReviewLaunchRequest, AgentSceneLaunchRequest } from '../types';
import { registerTool } from '../toolRegistry';
import {
  SCENE_CAPABILITY_IDS,
  SCENE_PROMPT_MODULE_IDS,
  normalizeSceneCapabilityId,
  normalizeScenePromptModuleId,
  normalizeUnifiedSceneRecipeId,
} from '../../scene/sceneCapabilityRegistry';
import { resolveSceneAssembly } from '../../scene/sceneAssembly';
import type { LearningTaskBinding } from '../../learningCompletion';
import { MASTERY_SHADOW_CRITERIA } from '../../masteryShadow/rubric';
import { openCognitionManager } from '../../cognition/managerWindow';

const NAVIGABLE_VIEWS = new Set<ViewMode>(['home', 'profile', 'graph', 'timeline', 'plan', 'settings', 'learn', 'documents', 'profile-evidence']);
const QUICK_CHECK_CRITERION_IDS = MASTERY_SHADOW_CRITERIA.map(criterion => criterion.id);

function readQuickCheckLaunchRequest(value: unknown): AgentQuickCheckLaunchRequest | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('quickCheckRequest 必须是对象');
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => !['noteId', 'criterionIds', 'regenerate'].includes(key))) {
    throw new Error('简测请求只允许知识点 ID、判据 ID 和重新出题开关，不接受题目、答案、分数或状态');
  }
  let noteId: string | undefined;
  if (Object.hasOwn(raw, 'noteId')) {
    if (typeof raw.noteId !== 'string' || !raw.noteId.trim() || raw.noteId.length > 256 || /[\u0000-\u001f]/u.test(raw.noteId)) {
      throw new Error('简测知识点 ID 必须是有效的非空字符串');
    }
    noteId = raw.noteId.trim();
  }
  let criterionIds: AgentQuickCheckLaunchRequest['criterionIds'];
  if (Object.hasOwn(raw, 'criterionIds')) {
    if (!Array.isArray(raw.criterionIds) || raw.criterionIds.length < 1 || raw.criterionIds.length > 3
      || raw.criterionIds.some(id => typeof id !== 'string' || !QUICK_CHECK_CRITERION_IDS.includes(id as typeof QUICK_CHECK_CRITERION_IDS[number]))
      || new Set(raw.criterionIds).size !== raw.criterionIds.length) {
      throw new Error('简测判据只允许 1 至 3 个不同的现有判据 ID');
    }
    criterionIds = [...raw.criterionIds] as NonNullable<AgentQuickCheckLaunchRequest['criterionIds']>;
  }
  if (Object.hasOwn(raw, 'regenerate') && typeof raw.regenerate !== 'boolean') throw new Error('重新出题开关必须为布尔值');
  return { ...(noteId ? { noteId } : {}), ...(criterionIds ? { criterionIds } : {}),
    ...(Object.hasOwn(raw, 'regenerate') ? { regenerate: raw.regenerate as boolean } : {}) };
}

function readKnowledgeNoteInput(args: Record<string, unknown>): AgentKnowledgeNoteInput {
  const title = String(args.title || '').trim();
  const content = String(args.content || '').trim();
  if (!title || title.length > 80) throw new Error('知识点标题必须为 1 至 80 个字符');
  if (!content || content.length > 12000) throw new Error('知识点正文必须为 1 至 12000 个字符');
  const rawTags = Array.isArray(args.tags) ? args.tags : [];
  const tags = [...new Set(rawTags.map((item) => String(item).trim()).filter(Boolean))];
  if (tags.length > 8 || tags.some((tag) => tag.length > 24)) throw new Error('知识点标签最多 8 个，每个不超过 24 个字符');
  return { title, content, tags };
}

function readOptionalText(value: unknown, label: string, maxLength: number): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length > maxLength) throw new Error(`${label}不能超过 ${maxLength} 个字符`);
  return text || undefined;
}

function readSceneLaunchRequest(value: unknown): AgentSceneLaunchRequest | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('sceneRequest 必须是对象');
  const raw = value as Record<string, unknown>;
  const subject = String(raw.subject || '').trim();
  if (!subject || subject.length > 120) throw new Error('场景主题必须为 1 至 120 个字符');
  const source = raw.source === 'auto' ? 'auto' : raw.source === 'build' ? 'build' : null;
  if (!source) throw new Error('Agent 场景来源只允许 build 或 auto');
  const sceneSkill = raw.sceneSkill === 'S4' ? 'S4' : raw.sceneSkill === 'S1' ? 'S1' : null;
  if (!sceneSkill) throw new Error('场景类型只允许 S1 或 S4');
  const rawKnowledgePoints = Array.isArray(raw.knowledgePoints) ? raw.knowledgePoints : [];
  const knowledgePoints = [...new Set(rawKnowledgePoints.map((item) => String(item).trim()).filter(Boolean))];
  if (knowledgePoints.length > 20 || knowledgePoints.some((item) => item.length > 80)) {
    throw new Error('关联知识点最多 20 个，每个不超过 80 个字符');
  }
  const recipeId = raw.recipeId === undefined
    ? (sceneSkill === 'S4' ? 'guided-derivation' as const : 'guided-practice' as const)
    : normalizeUnifiedSceneRecipeId(raw.recipeId);
  if (raw.recipeId !== undefined && !recipeId) throw new Error('未知的场景配方');
  const rawCapabilities = Array.isArray(raw.requestedCapabilities) ? raw.requestedCapabilities : [];
  if (rawCapabilities.length > 24) throw new Error('请求的场景能力最多 24 个');
  const requestedCapabilities = [...new Set(rawCapabilities.map((item) => normalizeSceneCapabilityId(item)))];
  if (requestedCapabilities.some((item) => !item)) throw new Error('请求中包含未知的场景能力');
  const rawPromptModules = Array.isArray(raw.requestedPromptModules) ? raw.requestedPromptModules : undefined;
  if (rawPromptModules && rawPromptModules.length > 12) throw new Error('请求的提示词模块最多 12 个');
  const requestedPromptModules = rawPromptModules === undefined
    ? undefined
    : [...new Set(rawPromptModules.map((item) => normalizeScenePromptModuleId(item)))];
  if (requestedPromptModules?.some((item) => !item)) throw new Error('请求中包含未知的提示词模块');
  const assembly = resolveSceneAssembly({
    sceneSkill,
    recipeId,
    requestedCapabilities: requestedCapabilities as NonNullable<AgentSceneLaunchRequest['requestedCapabilities']>,
    requestedPromptModules: requestedPromptModules as AgentSceneLaunchRequest['requestedPromptModules'],
  });
  if (!assembly.valid) {
    throw new Error(assembly.diagnostics.filter((item) => item.severity === 'error').map((item) => item.message).join('；'));
  }
  return {
    source,
    subject,
    knowledgePoints,
    sceneSkill,
    recipeId,
    requestedCapabilities: assembly.requestedCapabilities,
    requestedPromptModules: assembly.enabledPromptModules,
    customTitle: readOptionalText(raw.customTitle, '场景标题', 120),
    roleHints: readOptionalText(raw.roleHints, '角色要求', 600),
    extraHints: readOptionalText(raw.extraHints, '其它要求', 1200),
    taskBinding: readTaskBinding(raw.taskBinding),
  };
}

function readTaskBinding(value: unknown): LearningTaskBinding | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('taskBinding 必须是任务身份对象');
  const raw = value as Record<string, unknown>;
  for (const field of ['noteId', 'taskId', 'occurrenceDate']) {
    if (Object.prototype.hasOwnProperty.call(raw, field) && (typeof raw[field] !== 'string' || !(raw[field] as string).trim())) {
      throw new Error(`taskBinding.${field} 必须是非空字符串`);
    }
  }
  const noteId = readOptionalText(raw.noteId, '任务所在笔记 ID', 256);
  if (!noteId) throw new Error('taskBinding 缺少 noteId');
  const taskId = readOptionalText(raw.taskId, '执行事项 ID', 256);
  const occurrenceDate = readOptionalText(raw.occurrenceDate, '本次待办日期', 10);
  if (occurrenceDate && (!taskId || !/^\d{4}-\d{2}-\d{2}$/.test(occurrenceDate))) throw new Error('周期待办绑定须含 taskId 和 YYYY-MM-DD 日期');
  return { noteId, ...(taskId ? { taskId } : {}), ...(occurrenceDate ? { occurrenceDate } : {}) };
}

const TASK_BINDING_SCHEMA = {
  type: 'object', required: ['noteId'], additionalProperties: false,
  properties: {
    noteId: { type: 'string', description: '真实任务所在笔记 ID；结构项目为叶子项目 ID' },
    taskId: { type: 'string', description: '执行事项的真实 ID；结构项目不传' },
    occurrenceDate: { type: 'string', description: '周期待办本次日期 YYYY-MM-DD；仅完成这一期' },
  },
};

function readReviewLaunchRequest(value: unknown): AgentReviewLaunchRequest | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('reviewRequest 必须是对象');
  const raw = value as Record<string, unknown>;
  const scope = raw.scope === 'project' ? 'project' : raw.scope === 'knowledge' ? 'knowledge' : null;
  const strategy = raw.strategy === 'smart' || raw.strategy === 'weak' || raw.strategy === 'random'
    ? raw.strategy
    : null;
  if (!scope || !strategy) throw new Error('复习选择请求缺少有效的范围或策略');
  return { scope, strategy, noteTitle: readOptionalText(raw.noteTitle, '复习对象标题', 120) };
}

export function registerUiTools(): void {
  registerTool({ name: 'open_cognition_manager', description: '打开独立的个人认知图谱管理窗口，展示用户当前认同、暂定理解、已有关系与历史；不修改或公开认知，也不评定掌握度。',
    parameters: { type: 'object', properties: {}, additionalProperties: false }, location: 'renderer', permission: 'navigation',
    execute: () => openCognitionManager() });
  registerTool({
    name: 'create_knowledge_note',
    description: '提交一篇知识点笔记草案供用户确认；只有用户确认后才创建并打开笔记。',
    parameters: {
      type: 'object', required: ['title', 'content'], additionalProperties: false,
      properties: {
        title: { type: 'string', description: '简短、明确且不超过 80 字的知识点名称' },
        content: { type: 'string', description: 'Markdown 正文，包含定义、要点、例子和来源说明' },
        tags: { type: 'array', maxItems: 8, items: { type: 'string' }, description: '可选主题标签' },
      },
    },
    location: 'renderer', permission: 'write',
    confirmation: (args) => {
      const input = readKnowledgeNoteInput(args);
      return {
        title: '创建知识点笔记',
        description: `创建“${input.title}”并在成功后打开；确认前不会写入。`,
        impacts: [
          '新增 1 篇独立知识点笔记。',
          '不会更新掌握度、复习记录或用户画像。',
        ],
      };
    },
    execute: (args, ctx) => ctx.createKnowledgeNote(readKnowledgeNoteInput(args)),
  });
  registerTool({
    name: 'navigate', description: '切换到指定的软件页面。',
    parameters: { type: 'object', required: ['view'], properties: { view: { type: 'string', enum: [...NAVIGABLE_VIEWS] } }, additionalProperties: false },
    location: 'renderer', permission: 'navigation',
    execute: (args, ctx) => {
      const view = String(args.view || '') as ViewMode;
      if (!NAVIGABLE_VIEWS.has(view)) throw new Error(`不允许导航到页面：${view}`);
      ctx.navigate(view);
      return { navigated: true, view };
    },
  });
  registerTool({
    name: 'open_note', description: '按标题或别名打开已有笔记；不会新建笔记。',
    parameters: { type: 'object', required: ['title'], properties: { title: { type: 'string' } }, additionalProperties: false },
    location: 'renderer', permission: 'navigation',
    execute: (args, ctx) => {
      const title = String(args.title || '').trim();
      if (!title) throw new Error('笔记标题不能为空');
      if (!ctx.openNoteByTitle(title)) throw new Error(`未找到笔记：${title}`);
      return { opened: true, title };
    },
  });
  registerTool({
    name: 'enter_learning_mode', description: '进入心流、复习、气泡复习、场景或定向简测。quick_check 只打开简测卡片并准备题目，不提交答案、不修改掌握度；用户明确要求简测才可调出，自主发现缺口时先建议并等同意。简测优先传真实知识点 noteId；否则按 noteTitle 或当前知识点解析。其它模式未提供 noteTitle 时使用当前笔记。计划 taskBinding 只提供手动完成入口，不自动完成项目。',
    parameters: {
      type: 'object', required: ['mode'], additionalProperties: false,
      properties: {
        mode: { type: 'string', enum: ['flow', 'review', 'bubble', 'scene', 'quick_check'] },
        noteTitle: { type: 'string' }, question: { type: 'string' },
        quickCheckRequest: {
          type: 'object', additionalProperties: false,
          properties: {
            noteId: { type: 'string', minLength: 1, maxLength: 256, description: '现有知识点的真实稳定 ID，不与 noteTitle 同传；错误 ID 不回退到当前笔记' },
            criterionIds: { type: 'array', minItems: 1, maxItems: 3, uniqueItems: true, items: { type: 'string', enum: QUICK_CHECK_CRITERION_IDS }, description: '可选的本次定向判据；省略时由卡片按当前掌握缺口选择' },
            regenerate: { type: 'boolean', description: '仅用户明确要求换题/刷新对应卡片时设true；整卡重新出题，未完成作答需用户在卡片确认，不代表已生成成功或更新掌握状态' },
          },
        },
        taskBinding: TASK_BINDING_SCHEMA,
        reviewRequest: {
          type: 'object', required: ['scope', 'strategy'], additionalProperties: false,
          properties: {
            scope: { type: 'string', enum: ['knowledge', 'project'] },
            strategy: { type: 'string', enum: ['smart', 'weak', 'random'] },
            noteTitle: { type: 'string' },
          },
        },
        sceneRequest: {
          type: 'object',
          required: ['source', 'subject', 'knowledgePoints', 'sceneSkill'],
          additionalProperties: false,
          properties: {
            source: { type: 'string', enum: ['build', 'auto'] },
            subject: { type: 'string' },
            knowledgePoints: { type: 'array', maxItems: 20, items: { type: 'string' } },
            customTitle: { type: 'string' }, roleHints: { type: 'string' }, extraHints: { type: 'string' },
            recipeId: { type: 'string', enum: ['guided-practice', 'batch-assessment', 'socratic-dialogue', 'case-analysis', 'decision-simulation', 'process-training', 'guided-derivation'] },
            requestedCapabilities: { type: 'array', maxItems: 24, items: { type: 'string', enum: [...SCENE_CAPABILITY_IDS] } },
            requestedPromptModules: { type: 'array', maxItems: 12, items: { type: 'string', enum: [...SCENE_PROMPT_MODULE_IDS] } },
            sceneSkill: { type: 'string', enum: ['S1', 'S4'] },
            taskBinding: TASK_BINDING_SCHEMA,
          },
        },
      },
    },
    location: 'renderer', permission: 'navigation',
    execute: (args, ctx) => {
      if (typeof args.mode !== 'string') throw new Error('学习模式必须是字符串');
      const mode = String(args.mode || '') as 'flow' | 'review' | 'bubble' | 'scene' | 'quick_check';
      if (!['flow', 'review', 'bubble', 'scene', 'quick_check'].includes(mode)) throw new Error(`未知学习模式：${mode}`);
      if (mode === 'quick_check') {
        if (Object.keys(args).some(key => !['mode', 'noteTitle', 'quickCheckRequest'].includes(key))) {
          throw new Error('简测不能混用复习、场景、任务或题目参数');
        }
        const quickCheckRequest = readQuickCheckLaunchRequest(args.quickCheckRequest);
        if (args.noteTitle !== undefined && (typeof args.noteTitle !== 'string' || !args.noteTitle.trim() || args.noteTitle.length > 120)) {
          throw new Error('简测知识点标题必须为 1 至 120 个字符');
        }
        if (quickCheckRequest?.noteId) {
          if (args.noteTitle !== undefined) throw new Error('简测知识点 ID 与标题不能同时指定');
          if (!ctx.getNotes().some(note => note.id === quickCheckRequest.noteId && note.noteType === 'knowledge')) {
            throw new Error('简测知识点 ID 不存在或不是知识点，不能回退到其它笔记');
          }
        }
        const opened = ctx.enterLearningMode({ mode,
          ...(args.noteTitle ? { noteTitle: (args.noteTitle as string).trim() } : {}),
          ...(quickCheckRequest ? { quickCheckRequest } : {}) });
        if (!opened) throw new Error('简测卡片未打开，请确认知识点和当前页面能否离开');
        return { entered: true, mode, status: 'opened', generationStatus: 'pending', masteryUpdated: false };
      }
      if (args.quickCheckRequest !== undefined) throw new Error('quickCheckRequest 只能用于 quick_check 模式');
      const sceneRequest = mode === 'scene' ? readSceneLaunchRequest(args.sceneRequest) : undefined;
      const taskBinding = readTaskBinding(args.taskBinding);
      const reviewRequest = mode === 'bubble' || mode === 'review'
        ? readReviewLaunchRequest(args.reviewRequest)
        : undefined;
      const ok = ctx.enterLearningMode({
        mode,
        noteTitle: args.noteTitle ? String(args.noteTitle) : undefined,
        question: args.question ? String(args.question) : undefined,
        ...(sceneRequest ? { sceneRequest } : {}),
        ...(reviewRequest ? { reviewRequest } : {}),
        ...(taskBinding ? { taskBinding } : {}),
      });
      if (!ok) throw new Error('进入学习模式失败，请确认笔记标题和当前数据');
      return { entered: true, mode, sceneRequest, reviewRequest };
    },
  });
}
