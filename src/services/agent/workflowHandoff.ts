import type { ReviewAnalysis, SceneRunState, SceneSpec } from '../../types';
import type { AgentTurnResult, AgentWorkflowAction, AgentWorkflowHandoff } from './types';

const SESSION_KEY = 'loginote-agent-workflow-handoff-v1';
const MAX_KNOWLEDGE_POINTS = 12;
const MAX_ACTIONS = 3;

function cleanText(value: unknown, maxLength = 160): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function uniqueTitles(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((item) => cleanText(item, 80)).filter(Boolean))].slice(0, MAX_KNOWLEDGE_POINTS);
}

function action(
  id: string,
  targetSkillId: AgentWorkflowAction['targetSkillId'],
  label: string,
  description: string,
  prompt: string,
): AgentWorkflowAction {
  return { id, targetSkillId, label, description, prompt };
}

function makeHandoff(input: Omit<AgentWorkflowHandoff, 'version' | 'id' | 'createdAt'>): AgentWorkflowHandoff {
  const now = new Date().toISOString();
  return {
    version: 1,
    id: `handoff-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ...input,
    knowledgePointTitles: uniqueTitles(input.knowledgePointTitles),
    outcome: cleanText(input.outcome, 240),
    actions: input.actions.slice(0, MAX_ACTIONS),
    createdAt: now,
  };
}

function objectResult(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function buildPersistedPlanHandoff(input: {
  scopeProjectTitle: string;
  scopeProjectId?: string;
  knowledgePointTitles?: string[];
  taskCount?: number;
  sourceSkillId?: string;
}): AgentWorkflowHandoff | null {
  const title = cleanText(input.scopeProjectTitle, 100);
  if (!title) return null;
  const projectId = cleanText(input.scopeProjectId, 100) || undefined;
  const knowledge = uniqueTitles(input.knowledgePointTitles);
  const taskCount = Number.isFinite(input.taskCount) ? Math.max(0, Number(input.taskCount)) : 0;
  const sourceSkillId = input.sourceSkillId || 'plan-planning';
  const actions: AgentWorkflowAction[] = [];

  actions.push({ ...action('start-flow', 'plan-planning', '开始心流学习',
    '直接进入该计划的叶子项目；讲解、题目和知识点逐页生成。', ''), destination: 'learning' });
  actions.push(action(
    'setup-scene',
    'scene-setup',
    '进入场景训练',
    '根据当前项目和真实关联知识点搭设应用练习场景。',
    `请为项目“${title}”搭建一个应用练习场景。`,
  ));
  actions.push(action(
    'curate-resources',
    'resource-curation',
    '统筹学习资源',
    '按根项目目标补充资源，子项目继承使用；已有后台准备结果保留。',
    `请为项目“${title}”统筹免费学习资源。`,
  ));

  return makeHandoff({
    sourceStage: 'plan',
    sourceSkillId,
    sourceArtifactId: projectId,
    scopeProjectId: projectId,
    scopeProjectTitle: title,
    knowledgePointTitles: knowledge,
    outcome: taskCount > 0 ? `已完成“${title}”的计划处理，共写入 ${taskCount} 条学习任务。` : `已完成“${title}”的计划处理。`,
    actions,
  });
}

/** 只有已经成功落盘的计划操作才产生后续建议；草案和待审批状态不会触发移交。 */
export function buildPlanHandoff(result: AgentTurnResult): AgentWorkflowHandoff | null {
  if (result.pendingApproval) return null;
  const completed = [...result.toolTrace].reverse().find((step) => step.ok && [
    'commit_project_task_draft',
    'create_project_plan',
    'append_project_study_tasks',
    'append_project_study_task_batch',
  ].includes(step.call.name));
  if (!completed) return null;

  const data = objectResult(completed.result);
  // 计划编辑器中的“草稿已导入”不是持久化完成态。真正落盘发生在
  // 用户点击计划页面的确认按钮之后，不能在这里提前触发下游 Skill。
  if (data.draftImported === true || data.requiresUserConfirmation === true) return null;
  return buildPersistedPlanHandoff({
    scopeProjectTitle: cleanText(data.scopeProjectTitle || data.rootProjectTitle || data.projectTitle || data.rootTitle, 100),
    scopeProjectId: cleanText(data.rootNoteId || data.projectNoteId, 100) || undefined,
    knowledgePointTitles: uniqueTitles(data.linkedKnowledgeTitles || data.createdKnowledgeTitles),
    taskCount: Number(data.taskCount || 0),
    sourceSkillId: result.activeSkill?.id,
  });
}

export function buildSceneHandoff(input: {
  spec: SceneSpec;
  run: SceneRunState;
  scopeProjectId?: string;
}): AgentWorkflowHandoff {
  const { spec, run } = input;
  const knowledge = uniqueTitles(spec.meta.knowledgePoints);
  const reviewTitle = spec.meta.subject || knowledge[0] || spec.meta.name;
  const knowledgeHint = knowledge.length ? `，优先检查本次涉及的知识点：${knowledge.slice(0, 5).join('、')}` : '';
  return makeHandoff({
    sourceStage: 'scene',
    sourceSkillId: 'scene-setup',
    sourceArtifactId: run.runId,
    scopeProjectId: input.scopeProjectId,
    scopeProjectTitle: cleanText(spec.meta.subject, 100) || undefined,
    knowledgePointTitles: knowledge,
    outcome: `场景“${cleanText(spec.meta.name, 100)}”${(run.completionOutcome ? run.completionOutcome === 'completed' : run.status === 'success') ? '已成功完成' : '已经结束'}${run.endReason ? `：${cleanText(run.endReason, 100)}` : '。'}`,
    actions: [action(
      'review-scene-knowledge',
      'socratic-review',
      '复习本次知识',
      '进入专用复习页面，通过主动回忆检验场景中使用过的知识。',
      `请带我复习“${cleanText(reviewTitle, 100)}”${knowledgeHint}。`,
    )],
  });
}

export function buildReviewHandoff(input: {
  noteId: string;
  noteTitle: string;
  episodeId?: string;
  knowledgePointTitles: string[];
  analysis: ReviewAnalysis | null;
  feedback?: import('../masteryShadow/reviewFeedback').ReviewSessionFeedback;
}): AgentWorkflowHandoff | null {
  if (!input.analysis && input.feedback?.status !== 'available') return null;
  const weakPoints = uniqueTitles(input.analysis?.missingKnowledge || []);
  const knowledge = uniqueTitles(input.knowledgePointTitles);
  const focus = weakPoints.length ? `，重点训练：${weakPoints.slice(0, 5).join('、')}` : '';
  return makeHandoff({
    sourceStage: 'review',
    sourceSkillId: 'socratic-review',
    sourceArtifactId: input.episodeId,
    scopeProjectId: input.noteId || undefined,
    scopeProjectTitle: cleanText(input.noteTitle, 100) || undefined,
    knowledgePointTitles: knowledge,
    outcome: input.feedback?.status === 'available'
      ? `已结束“${cleanText(input.noteTitle, 100)}”复习；本次反馈：${cleanText(input.feedback.feedback, 250)}（本次反馈不等于长期掌握更新）。`
      : `已完成“${cleanText(input.noteTitle, 100)}”复习，评级为 ${cleanText(input.analysis!.overallRating, 30)}${weakPoints.length ? `；待巩固：${weakPoints.slice(0, 3).join('、')}` : '。'}`,
    actions: [
      action(
        'reinforce-with-scene',
        'scene-setup',
        '用场景巩固',
        '把复习暴露出的薄弱点放入新的应用场景。',
        `请为“${cleanText(input.noteTitle, 100)}”搭建一个巩固场景${focus}。`,
      ),
      action(
        'adjust-plan-after-review',
        'plan-planning',
        '调整后续计划',
        '根据本次复习结果提出局部计划调整，写入前仍需确认。',
        `请根据“${cleanText(input.noteTitle, 100)}”的本次复习结果调整后续学习计划${focus}，只修改相关板块。`,
      ),
    ],
  });
}

export function normalizeWorkflowHandoff(value: unknown): AgentWorkflowHandoff | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Partial<AgentWorkflowHandoff>;
  if (raw.version !== 1 || !raw.id || !['plan', 'scene', 'review'].includes(raw.sourceStage || '')) return null;
  const actions = Array.isArray(raw.actions) ? raw.actions.filter((item): item is AgentWorkflowAction => Boolean(
    item && typeof item.id === 'string' && typeof item.label === 'string' && typeof item.prompt === 'string',
  )).slice(0, MAX_ACTIONS) : [];
  if (!actions.length) return null;
  return {
    version: 1,
    id: cleanText(raw.id, 120),
    sourceStage: raw.sourceStage!,
    sourceSkillId: cleanText(raw.sourceSkillId, 80) || undefined,
    sourceArtifactId: cleanText(raw.sourceArtifactId, 120) || undefined,
    scopeProjectId: cleanText(raw.scopeProjectId, 120) || undefined,
    scopeProjectTitle: cleanText(raw.scopeProjectTitle, 100) || undefined,
    knowledgePointTitles: uniqueTitles(raw.knowledgePointTitles),
    outcome: cleanText(raw.outcome, 240),
    actions: actions.map((item) => ({
      id: cleanText(item.id, 80),
      targetSkillId: item.targetSkillId,
      ...(item.destination === 'learning' ? { destination: 'learning' as const } : {}),
      label: cleanText(item.label, 40),
      description: cleanText(item.description, 160),
      prompt: cleanText(item.prompt, 500),
    })),
    createdAt: cleanText(raw.createdAt, 40) || new Date().toISOString(),
  };
}

/** sessionStorage 只用于当前应用会话，避免把流程状态误当作长期画像或情景记忆。 */
export function loadWorkflowHandoff(): AgentWorkflowHandoff | null {
  if (typeof sessionStorage === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? normalizeWorkflowHandoff(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function saveWorkflowHandoff(handoff: AgentWorkflowHandoff | null): void {
  if (typeof sessionStorage === 'undefined') return;
  if (!handoff) sessionStorage.removeItem(SESSION_KEY);
  else sessionStorage.setItem(SESSION_KEY, JSON.stringify(handoff));
}
