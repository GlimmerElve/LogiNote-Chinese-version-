import type { NoteItem, LlmToolCall } from '../../types';
import { getLeafProjectNotesInScope, getProjectNotesInScope } from '../knowledgePointSelector';
import { isAgentExplanationOnlyRequest } from './replyPolicy';
import { agentActionIntentText } from './intentText';
import { extractProjectTasks } from './resourceDraftService';
import { verifyAgentObservedOutcome } from './actionOutcome';
import type { AgentObservedOutcome, AgentRuntimeContext, AgentTurnResult } from './types';

export type AgentSequenceSkill = 'plan-planning' | 'study-task-generation' | 'resource-curation';
export type AgentSequenceStepStatus = 'ready' | 'running' | 'waiting-input' | 'waiting-approval' | 'waiting-editor' | 'waiting-workbench' | 'paused' | 'complete' | 'cancelled';
export interface AgentSequenceExecution {
  sequenceId: string;
  stepIndex: number;
  skillId: AgentSequenceSkill;
  scopeProjectId?: string;
}
export interface AgentSkillSequence {
  version: 1;
  id: string;
  roleId: string;
  request: string;
  createdAt: string;
  scopeProjectId?: string;
  steps: Array<{ skillId: AgentSequenceSkill; status: AgentSequenceStepStatus; runId?: string; previewId?: string; draftId?: string }>;
  notice?: string;
  /** An interrupted operation needs an artifact/scope check before re-entry. */
  interruptedStep?: number;
}
const SESSION_KEY = 'loginote.agent-skill-sequence.v1';
const ORDER: AgentSequenceSkill[] = ['plan-planning', 'study-task-generation', 'resource-curation'];
export const AGENT_SEQUENCE_LABELS: Record<AgentSequenceSkill, string> = {
  'plan-planning': '制定或调整计划', 'study-task-generation': '生成末级任务', 'resource-curation': '统筹学习资源',
};
export function isAgentSequenceExecution(value: unknown): value is AgentSequenceExecution {
  const item = value as AgentSequenceExecution | undefined;
  return Boolean(item && typeof item.sequenceId === 'string' && item.sequenceId.length > 0 && item.sequenceId.length <= 120
    && Number.isInteger(item.stepIndex) && item.stepIndex >= 0 && item.stepIndex < 3 && ORDER.includes(item.skillId)
    && (item.scopeProjectId === undefined || (typeof item.scopeProjectId === 'string' && item.scopeProjectId.length > 0 && item.scopeProjectId.length <= 200)));
}
export function currentAgentSequenceStep(sequence: AgentSkillSequence) {
  const index = sequence.steps.findIndex((step) => step.status !== 'complete');
  return index < 0 ? undefined : { ...sequence.steps[index], index };
}

/** Explicit compound requests only; suggestions, questions and negated actions grant no extra authority. */
export function createAgentSkillSequence(request: string, roleId: string, ctx: AgentRuntimeContext): AgentSkillSequence | null {
  if (request.length > 6000 || /^\[selection_action:/u.test(request) || isAgentExplanationOnlyRequest(request)
    || /^(?:请)?(?:解释|说明|介绍|为什么|如何|怎么|是否|有哪些)/u.test(request.trim())) return null;
  const text = agentActionIntentText(request);
  const matches: Record<AgentSequenceSkill, RegExp> = {
    'plan-planning': /(?:制定|生成|创建|新建|调整|修改).{0,12}(?:学习)?计划/u,
    'study-task-generation': /(?:生成|制定|创建|补充|完善).{0,12}(?:学习任务|任务清单|末级任务)/u,
    'resource-curation': /(?:推荐|统筹|查找|搜索|搜集|找|筛选).{0,12}(?:学习)?(?:资源|资料|教程|课程)/u,
  };
  const bundle = text.match(/(?:生成|制定|创建|做|完成|准备|安排).{0,12}(?:一套|完整|全套|包括|包含|带有|含)[^\n。！？]{0,120}/u)?.[0]
    || text.match(/(?:配套|带上|加上|附上|一并)[^\n。！？]{0,80}/u)?.[0] || '';
  const bundledNouns: Record<AgentSequenceSkill, RegExp> = { 'plan-planning': /学习计划|计划方案/u, 'study-task-generation': /学习任务|任务清单|末级任务/u, 'resource-curation': /学习资源|资源|教程/u };
  const skills = ORDER.filter((id) => matches[id].test(text) || bundledNouns[id].test(bundle));
  if (skills.length < 2 || !/(?:然后|再|并|以及|同时|接着|顺便|之后|最后|和|、|[；;\n])/u.test(text)) return null;
  const titles = [...text.matchAll(/[“「"]([^”」"\n]{1,100})[”」"]/gu)].map((match) => match[1]);
  // Multi-project compound instructions need a separate scope decision, not title guessing.
  if (new Set(titles).size > 1 || /综合总览|所有计划|多个根|多计划|分别为/u.test(text)) return null;
  let scopeProjectId: string | undefined;
  if (skills[0] !== 'plan-planning' || (titles.length > 0 && /调整|修改/u.test(text))) {
    const projects = ctx.getNotes().filter((note) => note.noteType === 'project');
    const exact = titles.length ? projects.filter((note) => note.title === titles[0]) : [];
    if (exact.length === 1) scopeProjectId = exact[0].id;
    else if (!titles.length && /当前|这个项目|该项目/u.test(text)) {
      const active = ctx.getActiveNote?.();
      if (active?.noteType === 'project') scopeProjectId = active.id;
    }
  }
  return { version: 1, id: `sequence-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, roleId, request,
    createdAt: new Date().toISOString(), scopeProjectId, steps: skills.map((skillId) => ({ skillId, status: 'ready' })) };
}

export function agentSequenceExecution(sequence: AgentSkillSequence): AgentSequenceExecution | undefined {
  const step = currentAgentSequenceStep(sequence);
  if (!step || step.status === 'complete' || step.status === 'cancelled') return;
  return { sequenceId: sequence.id, stepIndex: step.index, skillId: step.skillId, scopeProjectId: sequence.scopeProjectId };
}

export function updateAgentSequenceStep(sequence: AgentSkillSequence, status: AgentSequenceStepStatus, notice?: string): AgentSkillSequence {
  const step = currentAgentSequenceStep(sequence);
  if (!step) return sequence;
  return { ...sequence, notice, steps: sequence.steps.map((item, index) => index === step.index || (status === 'cancelled' && index > step.index) ? { ...item, status } : item) };
}

function scopeNote(sequence: AgentSkillSequence, notes: NoteItem[], title?: unknown): NoteItem | undefined {
  if (sequence.scopeProjectId) return notes.find((note) => note.id === sequence.scopeProjectId && note.noteType === 'project');
  const exact = notes.filter((note) => note.noteType === 'project' && note.title === title);
  return exact.length === 1 ? exact[0] : undefined;
}

export function missingAgentSequenceTargets(sequence: AgentSkillSequence, ctx: AgentRuntimeContext): string[] {
  if (!sequence.scopeProjectId) return [];
  const step = currentAgentSequenceStep(sequence);
  const notes = ctx.getNotes();
  const leaves = getLeafProjectNotesInScope(sequence.scopeProjectId, notes);
  if (step?.skillId === 'study-task-generation') return leaves.filter((note) => !extractProjectTasks(note.content, note.textbook).some((task) => /\[\[[^\]]+\]\]/u.test(task))).map((note) => note.title);
  if (step?.skillId !== 'resource-curation') return [];
  return leaves.flatMap((note) => {
    const tasks = extractProjectTasks(note.content, note.textbook);
    if (!tasks.length) return note.resources?.length ? [] : [`${note.title}（项目主题）`];
    return tasks.filter((task) => !note.resources?.some((resource) => resource.taskText === task))
      .map((task) => `${note.title}：${task}`);
  });
}

export function buildAgentSequenceStepRequest(sequence: AgentSkillSequence, ctx: AgentRuntimeContext): string {
  const step = currentAgentSequenceStep(sequence);
  if (!step) throw new Error('连续任务已结束');
  const note = scopeNote(sequence, ctx.getNotes());
  if (sequence.scopeProjectId && !note) throw new Error('连续任务的项目已删除，请重新指定范围');
  const remaining = missingAgentSequenceTargets(sequence, ctx);
  const request = step.skillId === 'study-task-generation' ? '生成学习任务清单，只处理该项目树的末级项目，建立真实或明确待创建的 [[知识点]] 关联。'
    : step.skillId === 'resource-curation' ? `统筹学习资源，沿用用户的自动推荐或人工筛选设置。${remaining.length ? `只继续未覆盖的目标：${remaining.slice(0, 12).map((target) => target.slice(0, 240)).join('；')}。这是目标预览，请读取真实笔记中的完整任务用于工具参数。${remaining.length > 12 ? '其余目标请分页读取。' : ''}` : '先读取现有资源，不重复收录。'}`
      : '继续制定或调整学习计划。';
  return `连续任务当前环节：${AGENT_SEQUENCE_LABELS[step.skillId]}。${note ? `精确项目范围：${JSON.stringify({ id: note.id, title: note.title })}。不得修改范围外项目。` : '先确定项目范围，不要默认使用当前打开的旧计划。'}\n${request}\n用户原始要求（保留其中的约束，仅执行当前环节）：\n${sequence.request}`;
}

export function recordAgentSequenceResult(sequence: AgentSkillSequence, result: AgentTurnResult, ctx: AgentRuntimeContext): AgentSkillSequence {
  const step = currentAgentSequenceStep(sequence);
  if (!step || step.status === 'cancelled') return sequence;
  if (result.activeSkill?.id !== step.skillId) return updateAgentSequenceStep(sequence, 'paused', '本次路由与当前环节不一致，后续环节未执行。');
  const checkpointExecution = result.pendingApproval?.continuation.checkpoint?.sequenceExecution;
  const tagged = { ...sequence,
    scopeProjectId: sequence.scopeProjectId || (checkpointExecution?.sequenceId === sequence.id ? checkpointExecution.scopeProjectId : undefined),
    steps: sequence.steps.map((item, index) => index === step.index ? { ...item, runId: result.auditRunId } : item) };
  if (result.pendingApproval) return updateAgentSequenceStep(tagged, 'waiting-approval', '当前环节等待确认，后续环节尚未执行。');
  if (result.truncated) return updateAgentSequenceStep(tagged, 'paused', '当前环节未完整完成，后续环节已暂停。');
  const success = result.toolTrace.filter((item) => item.ok);
  const imported = [...success].reverse().find((item) => (item.result as { draftImported?: boolean })?.draftImported);
  if (step.skillId === 'plan-planning' && imported) {
    const previewId = (imported.result as { editorDraftId?: string }).editorDraftId;
    if (!previewId) return updateAgentSequenceStep(tagged, 'paused', '草图已导入编辑器，当前导入路径还不能自动交接，请确认后手动选择下一步。');
    const waiting = updateAgentSequenceStep(tagged, 'waiting-editor', '请在计划编辑器确认；实际保存成功后才会继续。');
    waiting.steps[step.index].previewId = previewId;
    return waiting;
  }
  const workbench = success.find((item) => item.call.name === 'search_online_learning_resources' && (item.result as { status?: string })?.status === 'workbench-opened');
  if (step.skillId === 'resource-curation' && workbench) {
    const waiting = updateAgentSequenceStep(tagged, 'waiting-workbench', '请在资源工作台完成筛选与确认。');
    waiting.steps[step.index].draftId = ctx.getResourceDraftSession()?.id;
    return waiting;
  }
  const committed = [...success].reverse().find((item) => item.call.name === (step.skillId === 'resource-curation' ? 'commit_project_resource_draft' : 'commit_project_task_draft')
    && !(item.result as { requiresUserConfirmation?: boolean })?.requiresUserConfirmation);
  const written = step.skillId === 'resource-curation' && success.some((item) => item.call.name === 'search_online_learning_resources' && (item.result as { status?: string })?.status === 'written');
  if (committed || written) {
    const note = scopeNote(tagged, ctx.getNotes(), (committed?.result as { scopeProjectTitle?: string })?.scopeProjectTitle);
    if (!note) return updateAgentSequenceStep(tagged, 'paused', '无法核对唯一项目范围，未执行后续环节。');
    const committedTitle = (committed?.result as { scopeProjectTitle?: string })?.scopeProjectTitle;
    if (committedTitle && committedTitle !== note.title) return updateAgentSequenceStep(tagged, 'paused', '保存结果不属于连续任务的锁定项目，未执行后续环节。');
    const scoped = { ...tagged, scopeProjectId: note.id };
    if (step.skillId !== 'plan-planning' && missingAgentSequenceTargets(scoped, ctx).length) return updateAgentSequenceStep(scoped, 'paused', '已保存部分结果，但当前范围尚未全部覆盖；请继续当前环节。');
    return updateAgentSequenceStep(scoped, 'complete', '当前环节已保存，准备继续用户要求的下一环节。');
  }
  return updateAgentSequenceStep(tagged, 'waiting-input', '当前环节尚未完成，可补充信息或继续处理；后续环节未执行。');
}

/** Match exact preview/workbench identity; chat prose is never a completion signal. */
export function consumeAgentSequenceOutcome(sequence: AgentSkillSequence, outcome: AgentObservedOutcome, ctx: AgentRuntimeContext): AgentSkillSequence | null {
  const step = currentAgentSequenceStep(sequence);
  if (!step) return null;
  if (outcome.kind === 'plan-writeback-failed' && step.skillId === 'plan-planning' && step.status === 'waiting-editor' && outcome.editorDraftId === step.previewId) {
    return updateAgentSequenceStep(sequence, 'paused', '计划未能保存，后续任务已暂停；请先检查保存错误。');
  }
  if (outcome.kind === 'plan-writeback' && step.skillId === 'plan-planning' && step.status === 'waiting-editor'
    && outcome.editorDraftId === step.previewId && (!sequence.scopeProjectId || sequence.scopeProjectId === outcome.rootProjectId)
    && ctx.getNotes().some((note) => note.id === outcome.rootProjectId && note.noteType === 'project')) {
    return updateAgentSequenceStep({ ...sequence, scopeProjectId: outcome.rootProjectId }, 'complete', '计划已确认保存，继续下一环节。');
  }
  if (outcome.kind !== 'resource-writeback' || step.skillId !== 'resource-curation' || step.status !== 'waiting-workbench'
    || !step.draftId || outcome.draftSessionId !== step.draftId || !verifyAgentObservedOutcome(outcome, ctx) || !sequence.scopeProjectId) return null;
  const ids = new Set(getProjectNotesInScope(sequence.scopeProjectId, ctx.getNotes()).map((note) => note.id));
  if (outcome.projects.some((project) => !ids.has(project.noteId))) return null;
  return missingAgentSequenceTargets(sequence, ctx).length
    ? updateAgentSequenceStep(sequence, 'ready', '已收录本批资源，继续尚未覆盖的目标。')
    : updateAgentSequenceStep(sequence, 'complete', '资源已确认收录，连续任务已完成。');
}

/** Local hard scope lock survives approvals/retries; no tool whitelist expansion. */
export function constrainAgentSequenceCall(call: LlmToolCall, execution: AgentSequenceExecution | undefined, ctx: AgentRuntimeContext): LlmToolCall {
  if (execution && !isAgentSequenceExecution(execution)) throw new Error('连续任务执行引用无效');
  if (execution?.skillId === 'plan-planning' && (call.name === 'stage_project_study_task_batch'
    || (call.name === 'start_project_task_draft' && call.arguments.purpose === 'study-tasks'))) {
    throw new Error('本环节只制定计划，正文学习任务由后续已授权的任务环节处理');
  }
  if (execution && !execution.scopeProjectId && execution.skillId !== 'plan-planning'
    && ['start_project_task_draft', 'start_project_resource_draft'].includes(call.name)) {
    const title = call.arguments.scopeProjectTitle;
    const exact = ctx.getNotes().filter((note) => note.noteType === 'project' && note.title === title);
    if (exact.length !== 1) throw new Error('请先明确唯一的项目范围，连续任务不会默认使用当前打开的旧项目');
    // Pin the first explicit scope in this run's own state, including its checkpoint.
    execution.scopeProjectId = exact[0].id;
  }
  if (execution && !execution.scopeProjectId && execution.skillId !== 'plan-planning'
    && /^(?:stage_|commit_|discard_).*draft|^stage_project_|^stage_plan_|^search_online_learning_resources$/u.test(call.name)) {
    throw new Error('请先通过草案入口明确项目范围，不能沿用未核对的旧项目草案');
  }
  if (!execution?.scopeProjectId) return call;
  const scope = ctx.getNotes().find((note) => note.id === execution.scopeProjectId && note.noteType === 'project');
  if (!scope) throw new Error('连续任务的项目范围已失效');
  if (['start_project_task_draft', 'start_project_resource_draft'].includes(call.name)) {
    const title = call.arguments.scopeProjectTitle;
    if (title && title !== scope.title) throw new Error('连续任务不能切换到另一个项目范围');
    return { ...call, arguments: { ...call.arguments, scopeProjectTitle: scope.title } };
  }
  if (/^(?:stage_|commit_|discard_).*draft|^stage_project_|^stage_plan_|^search_online_learning_resources$/u.test(call.name)) {
    const draft = execution.skillId === 'resource-curation' ? ctx.getResourceDraftSession() : ctx.getPlanDraftSession();
    if (!draft || draft.scopeProjectId !== scope.id) throw new Error('业务草案不属于连续任务的锁定项目');
  }
  if (execution.skillId === 'resource-curation' && call.name === 'search_online_learning_resources') {
    const title = call.arguments.projectTitle;
    const task = String(call.arguments.taskText || '').replace(/\s+/gu, ' ').trim();
    const project = getLeafProjectNotesInScope(scope.id, ctx.getNotes()).find((note) => note.title === title);
    if (project?.resources?.some((item) => String(item.taskText || '').replace(/\s+/gu, ' ').trim() === task)) {
      throw new Error('该学习任务已有收录资源；连续任务只继续未覆盖目标，不重复搜索已完成目标');
    }
  }
  return call;
}

export function loadAgentSkillSequence(roleId: string): AgentSkillSequence | null {
  if (typeof sessionStorage === 'undefined') return null;
  try {
    const raw = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null') as AgentSkillSequence | null;
    if (!raw || raw.version !== 1 || raw.roleId !== roleId || typeof raw.id !== 'string' || typeof raw.request !== 'string' || raw.request.length > 6000
      || !Number.isFinite(Date.parse(raw.createdAt)) || Date.now() - Date.parse(raw.createdAt) > 24 * 60 * 60 * 1000
      || Date.parse(raw.createdAt) > Date.now() + 60_000
      || !Array.isArray(raw.steps) || raw.steps.length < 2 || raw.steps.length > 3
      || new Set(raw.steps.map((step) => step.skillId)).size !== raw.steps.length
      || raw.steps.some((step) => !ORDER.includes(step.skillId) || !['ready', 'running', 'waiting-input', 'waiting-approval', 'waiting-editor', 'waiting-workbench', 'paused', 'complete', 'cancelled'].includes(step.status))) return null;
    // Reload never silently restarts an interrupted task or grants approval.
    return { ...raw, steps: raw.steps.map((step) => ['running', 'ready'].includes(step.status) ? { ...step, status: 'paused' } : step), notice: '已恢复本窗口的连续任务；未完成环节不会因重新加载而自动重跑。' };
  } catch { return null; }
}
export function saveAgentSkillSequence(sequence: AgentSkillSequence | null): void {
  if (typeof sessionStorage === 'undefined') return;
  try { if (sequence) sessionStorage.setItem(SESSION_KEY, JSON.stringify(sequence)); else sessionStorage.removeItem(SESSION_KEY); }
  catch { /* A short-term queue must not block the existing workflow. */ }
}
