import type { DueDateItem, NoteItem, PlanMeta } from '../../types';
import { isLearningProject, isReferenceProject } from '../projectRole';
import { leafStudyEffort, planRootFor } from '../learningCapacity';
import { getScheduledProjectDeadline, getScheduledProjectChildren } from '../planProjectState';
import { getLeafProjectNotesInScope, getProjectNotesInScope, getLearningProjectNotesInScope } from '../knowledgePointSelector';
import { findNotesByTitleOrAlias, resolveNoteByTitleOrAlias } from '../noteResolver';
import { extractPlanTaskId, formatPlanTaskLine } from '../planTaskAnchor';
import {
  appendProjectStudyTaskBatch,
  extractWikiTargets,
} from '../planAdjustmentService';
import type {
  AgentPlanDraftMode,
  AgentPlanDraftPurpose,
  AgentPlanDraftSession,
  AgentPlanDraftSummary,
  AgentPlanExecutionPatch,
  AgentPlanMetaPatch,
  AgentPlanMilestonePatch,
  AgentPortfolioPlanRootDraft,
  AgentPortfolioPlanRootPatchInput,
  AgentProjectStructurePatch,
  AgentProjectStudyTasksInput,
} from './types';

export interface PlanDraftMutationResult {
  notes: NoteItem[];
  changedProjectNotes: NoteItem[];
  createdProjectNotes: NoteItem[];
  deletedProjectIds: string[];
  changedKnowledgeNotes: NoteItem[];
  createdKnowledgeNotes: NoteItem[];
  summary: {
    rootProjectTitle: string;
    projectCount: number;
    taskCount: number;
    createdKnowledgeTitles: string[];
    linkedKnowledgeTitles: string[];
    structurePatchCount: number;
    planMetaPatchCount: number;
    milestonePatchCount: number;
    executionPatchCount: number;
    rootCount?: number;
    rootProjectTitles?: string[];
    rootSummaries?: Array<{
      rootProjectId: string;
      rootProjectTitle: string;
      structurePatchCount: number;
      planMetaPatchCount: number;
      milestonePatchCount: number;
      executionPatchCount: number;
    }>;
  };
}

function requireProject(
  notes: NoteItem[],
  scopeProjectTitle: string | undefined,
  selectedProjectId: string | undefined,
): NoteItem {
  const projects = notes.filter(isLearningProject);
  const project = scopeProjectTitle?.trim()
    ? resolveNoteByTitleOrAlias(scopeProjectTitle, projects)
    : projects.find((note) => note.id === selectedProjectId);
  if (!project) throw new Error(scopeProjectTitle ? `未找到项目笔记：${scopeProjectTitle}` : '请先选中一个项目板块');
  return project;
}

export function summarizePlanDraft(session: AgentPlanDraftSession): AgentPlanDraftSummary {
  if (session.scopeKind === 'portfolio') {
    const roots = Object.values(session.portfolioRoots || {});
    return {
      sessionId: session.id,
      mode: session.mode,
      scopeKind: 'portfolio',
      scopeProjectId: session.scopeProjectId,
      scopeProjectTitle: session.scopeProjectTitle,
      projectCount: 0,
      taskCount: 0,
      createKnowledgeNotes: [],
      structurePatchCount: roots.reduce((sum, root) => sum + root.structurePatches.length, 0),
      planMetaPatchCount: roots.filter((root) => root.planMetaPatch).length,
      milestonePatchCount: roots.reduce((sum, root) => sum + root.milestonePatches.length, 0),
      executionPatchCount: roots.reduce((sum, root) => sum + root.executionPatches.length, 0),
      rootCount: roots.length,
      rootProjectTitles: roots.map((root) => root.rootProjectTitle),
    };
  }
  return {
    sessionId: session.id,
    mode: session.mode,
    scopeProjectId: session.scopeProjectId,
    scopeProjectTitle: session.scopeProjectTitle,
    projectCount: session.projects.length,
    taskCount: session.projects.reduce((sum, project) => sum + project.tasks.length, 0),
    createKnowledgeNotes: session.createKnowledgeNotes,
    structurePatchCount: session.structurePatches.length,
    planMetaPatchCount: session.planMetaPatch ? 1 : 0,
    milestonePatchCount: session.milestonePatches?.length || 0,
    executionPatchCount: session.executionPatches?.length || 0,
    scopeKind: 'root',
  };
}

export function createPlanDraftSession(
  notes: NoteItem[],
  input: {
    scopeProjectTitle?: string;
    selectedProjectId?: string;
    mode: AgentPlanDraftMode;
    purpose?: AgentPlanDraftPurpose;
  },
  now = new Date().toISOString(),
  id = `plan-draft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
): AgentPlanDraftSession {
  const scope = requireProject(notes, input.scopeProjectTitle, input.selectedProjectId);
  const scopedProjects = getLearningProjectNotesInScope(scope.id, notes);
  if (scopedProjects.length === 0) throw new Error(`项目范围为空：${scope.title}`);
  return {
    id,
    scopeKind: 'root',
    mode: input.mode,
    purpose: input.purpose || (input.mode === 'full-task-generation' ? 'study-tasks' : 'structure'),
    scopeProjectId: scope.id,
    scopeProjectTitle: scope.title,
    baseProjectRevisions: Object.fromEntries(scopedProjects.map((project) => [project.id, project.updatedAt])),
    projects: [],
    createKnowledgeNotes: [],
    structurePatches: [],
    milestonePatches: [],
    executionPatches: [],
    createdAt: now,
    updatedAt: now,
  };
}

function requireTitle(value: unknown, label: string): string {
  const title = String(value || '').trim();
  if (!title) throw new Error(`${label}不能为空`);
  if (title.length > 120 || /\r|\n|\[\[|\]\]/.test(title)) throw new Error(`${label}无效：${title}`);
  return title;
}

function requireDate(value: unknown): string {
  const text = String(value || '');
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) throw new Error('日期必须使用 YYYY-MM-DD 格式');
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (date.toISOString().slice(0, 10) !== text) throw new Error(`无效日期：${text}`);
  return text;
}

function findRootProject(projectId: string, notes: NoteItem[]): NoteItem | undefined {
  let current = notes.find((note) => note.id === projectId && isLearningProject(note));
  const visited = new Set<string>();
  while (current?.parentId && !visited.has(current.id)) {
    visited.add(current.id);
    const parent = notes.find((note) => note.id === current!.parentId && note.noteType === 'project');
    if (!parent) break;
    current = parent;
  }
  return current;
}

/**
 * Returns real plan roots for portfolio coordination. A modern root is
 * identified by planMeta; legacy roots remain eligible when their subtree has
 * an actual scheduled project or execution item. Plain editable project notes
 * with no planning data stay out of the portfolio.
 */
export function getActivePortfolioPlanRoots(notes: NoteItem[]): NoteItem[] {
  const projects = notes.filter(isLearningProject);
  const projectIds = new Set(projects.map((note) => note.id));
  return projects
    .filter((note) => !note.parentId || !projectIds.has(note.parentId))
    .filter((root) => root.planMeta?.status !== 'archived')
    .filter((root) => {
      if (root.planMeta) return true;
      return getLearningProjectNotesInScope(root.id, notes).some((project) => project.dueDates.length > 0);
    })
    .sort((a, b) => {
      const priority = { high: 0, medium: 1, low: 2 } as const;
      const aPriority = priority[a.planMeta?.portfolioPriority || 'medium'];
      const bPriority = priority[b.planMeta?.portfolioPriority || 'medium'];
      return aPriority - bPriority || a.title.localeCompare(b.title, 'zh-CN');
    });
}

function createPortfolioRootDraft(root: NoteItem, notes: NoteItem[]): AgentPortfolioPlanRootDraft {
  const scopedProjects = getLearningProjectNotesInScope(root.id, notes);
  return {
    rootProjectId: root.id,
    rootProjectTitle: root.title,
    baseProjectRevisions: Object.fromEntries(scopedProjects.map((project) => [project.id, project.updatedAt])),
    structurePatches: [],
    milestonePatches: [],
    executionPatches: [],
  };
}

export function createPortfolioPlanDraftSession(
  notes: NoteItem[],
  now = new Date().toISOString(),
  id = `plan-portfolio-draft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  rootProjectIds?: string[],
): AgentPlanDraftSession {
  const activeRoots = getActivePortfolioPlanRoots(notes);
  const requestedIds = (rootProjectIds || []).map((value) => String(value || '').trim()).filter(Boolean);
  if (new Set(requestedIds).size !== requestedIds.length) throw new Error('综合计划范围包含重复的根项目 ID');
  const requestedSet = new Set(requestedIds);
  const roots = requestedIds.length ? activeRoots.filter((root) => requestedSet.has(root.id)) : activeRoots;
  const missingIds = requestedIds.filter((rootId) => !roots.some((root) => root.id === rootId));
  if (missingIds.length) throw new Error(`以下根计划不存在、未启用或已归档：${missingIds.join('、')}`);
  if (roots.length === 0) throw new Error('当前没有可统筹的有效计划根');
  const portfolioRoots = Object.fromEntries(roots.map((root) => [root.id, createPortfolioRootDraft(root, notes)]));
  return {
    id,
    scopeKind: 'portfolio',
    mode: 'revise-subtree',
    purpose: 'plan-layout',
    scopeProjectId: '__portfolio__',
    scopeProjectTitle: `综合总览（${roots.length} 个计划）`,
    baseProjectRevisions: Object.assign({}, ...Object.values(portfolioRoots).map((root) => root.baseProjectRevisions)),
    projects: [],
    createKnowledgeNotes: [],
    structurePatches: [],
    milestonePatches: [],
    executionPatches: [],
    portfolioRoots,
    createdAt: now,
    updatedAt: now,
  };
}

function validateProjectTree(
  scopeProjectId: string,
  notes: NoteItem[],
  options: { validateDateRanges?: boolean } = {},
): void {
  const validateDateRanges = options.validateDateRanges !== false;
  const root = findRootProject(scopeProjectId, notes);
  if (!root) throw new Error('结构补丁导致项目根节点丢失');
  const projects = getLearningProjectNotesInScope(root.id, notes);
  if (projects.length > 60) throw new Error('一个项目计划最多包含 60 个节点');
  const byId = new Map(projects.map((project) => [project.id, project]));
  for (const project of projects) {
    let current = project;
    const visited = new Set<string>();
    while (current.parentId) {
      if (visited.has(current.id)) throw new Error('项目结构不能形成循环');
      visited.add(current.id);
      const parent = byId.get(current.parentId);
      if (!parent) break;
      current = parent;
    }
    if (!validateDateRanges) continue;
    const deadline = project.dueDates.find((item) => item.id === `due-${project.id}-0` || item.taskText.trim() === project.title.trim());
    if (!deadline) continue;
    if (deadline.startDate && deadline.startDate > deadline.dueDate) {
      throw new Error(`项目“${project.title}”的开始日期不能晚于结束日期`);
    }
    let ancestor = project.parentId ? byId.get(project.parentId) : undefined;
    const ancestorVisited = new Set<string>();
    while (ancestor && !ancestorVisited.has(ancestor.id)) {
      ancestorVisited.add(ancestor.id);
      const ancestorDeadline = ancestor.dueDates.find((item) => item.id === `due-${ancestor!.id}-0` || item.taskText.trim() === ancestor!.title.trim());
      if (ancestorDeadline) {
        if (ancestorDeadline.startDate && deadline.startDate && deadline.startDate < ancestorDeadline.startDate) {
          throw new Error(`子项目“${project.title}”的开始日期 ${deadline.startDate} 不能早于父项目“${ancestor.title}”的开始日期 ${ancestorDeadline.startDate}`);
        }
        if (deadline.dueDate > ancestorDeadline.dueDate) {
          throw new Error(`子项目“${project.title}”的结束日期 ${deadline.dueDate} 不能晚于父项目“${ancestor.title}”的结束日期 ${ancestorDeadline.dueDate}`);
        }
        break;
      }
      ancestor = ancestor.parentId ? byId.get(ancestor.parentId) : undefined;
    }
  }
}

function applyProjectStructurePatches(
  notes: NoteItem[],
  session: AgentPlanDraftSession,
  now: string,
  idFactory?: () => string,
  options: { validateDateRanges?: boolean } = {},
) {
  let working = notes;
  let sequence = 0;
  const nextId = idFactory || (() => `note-${session.id}-project-${++sequence}`);
  const changedProjectIds = new Set<string>();
  const createdProjectIds = new Set<string>();
  const deletedProjectIds = new Set<string>();
  const changedKnowledgeIds = new Set<string>();

  const projectInScope = (title: unknown, label: string): NoteItem => {
    const requested = requireTitle(title, label);
    // Root identity is already locked by stable ID. A same-named project in
    // another root must neither steal nor make this local reference ambiguous.
    // Duplicates inside the locked subtree remain deliberately unresolved.
    const scope = getProjectNotesInScope(session.scopeProjectId, working);
    const project = resolveNoteByTitleOrAlias(requested, scope);
    if (!project) throw new Error(`项目不属于锁定板块“${session.scopeProjectTitle}”或范围内标题不唯一：${requested}`);
    if (!isLearningProject(project)) throw new Error('资料型项目不是计划节点；本入口不支持将其隐式转换为学习项目');
    return project;
  };

  for (const patch of session.structurePatches) {
    if (patch.operation === 'update') {
      const project = projectInScope(patch.projectTitle, '项目标题');
      if (patch.title === undefined && patch.startDate === undefined && patch.dueDate === undefined
        && !patch.clearStartDate && !patch.clearDueDate && patch.priority === undefined) {
        throw new Error(`项目“${project.title}”的更新补丁没有有效字段`);
      }
      const newTitle = patch.title === undefined ? project.title : requireTitle(patch.title, '新项目标题');
      if (newTitle !== project.title && findNotesByTitleOrAlias(newTitle, working.filter((note) => note.id !== project.id)).length) throw new Error(`项目标题与现有笔记冲突：${newTitle}`);
      if (patch.startDate && patch.clearStartDate) throw new Error('不能同时设置并清除项目开始日期');
      if ((patch.startDate || patch.dueDate || patch.clearStartDate) && patch.clearDueDate) throw new Error('清除项目时间范围时不能同时设置日期');
      if (patch.clearDueDate && patch.priority) throw new Error('清除项目时间范围时不能同时调整优先级');
      const projectDeadlineId = `due-${project.id}-0`;
      let dueDates = project.dueDates.map((item) => ({ ...item, noteTitle: newTitle }));
      const projectDeadlineIndex = dueDates.findIndex((item) => item.id === projectDeadlineId || item.taskText.trim() === project.title.trim());
      if (patch.clearDueDate) {
        if (projectDeadlineIndex >= 0) dueDates.splice(projectDeadlineIndex, 1);
      } else if (patch.startDate || patch.dueDate || patch.clearStartDate) {
        const existingDeadline = projectDeadlineIndex >= 0 ? dueDates[projectDeadlineIndex] : undefined;
        if (!existingDeadline && !patch.dueDate) throw new Error(`项目“${project.title}”还没有结束日期`);
        const dueDate = patch.dueDate ? requireDate(patch.dueDate) : existingDeadline!.dueDate;
        const startDate = patch.clearStartDate ? undefined : patch.startDate ? requireDate(patch.startDate) : existingDeadline?.startDate;
        if (startDate && startDate > dueDate) throw new Error(`项目“${project.title}”的开始日期不能晚于结束日期`);
        const projectDeadline = {
          id: projectDeadlineId,
          noteId: project.id,
          noteTitle: newTitle,
          taskText: newTitle,
          startDate,
          dueDate,
          completed: projectDeadlineIndex >= 0 ? dueDates[projectDeadlineIndex].completed : false,
          priority: patch.priority || (projectDeadlineIndex >= 0 ? dueDates[projectDeadlineIndex].priority : 'medium' as const),
        };
        if (projectDeadlineIndex >= 0) dueDates[projectDeadlineIndex] = { ...dueDates[projectDeadlineIndex], ...projectDeadline };
        else dueDates.unshift(projectDeadline);
      } else if (patch.priority) {
        if (projectDeadlineIndex < 0) throw new Error(`项目“${project.title}”没有可调整优先级的项目日期`);
        dueDates[projectDeadlineIndex] = { ...dueDates[projectDeadlineIndex], priority: patch.priority };
      }
      if (projectDeadlineIndex >= 0 && !patch.clearDueDate) {
        const currentIndex = dueDates.findIndex((item) => item.id === projectDeadlineId);
        if (currentIndex >= 0) dueDates[currentIndex] = { ...dueDates[currentIndex], taskText: newTitle };
      }
      const updated = { ...project, title: newTitle, dueDates, updatedAt: now };
      working = working.map((note) => note.id === project.id ? updated : note);
      changedProjectIds.add(project.id);
    } else if (patch.operation === 'add_child') {
      const parent = projectInScope(patch.parentProjectTitle, '父项目标题');
      const title = requireTitle(patch.title, '新项目标题');
      if (findNotesByTitleOrAlias(title, working).length) throw new Error(`项目标题与现有笔记冲突：${title}`);
      const dueDate = patch.dueDate ? requireDate(patch.dueDate) : undefined;
      const startDate = patch.startDate ? requireDate(patch.startDate) : undefined;
      if (startDate && !dueDate) throw new Error('新项目设置开始日期时必须同时提供结束日期');
      if (startDate && dueDate && startDate > dueDate) throw new Error('新项目的开始日期不能晚于结束日期');
      if (patch.priority && !dueDate) throw new Error('新项目设置优先级时必须同时提供日期');
      const id = nextId();
      if (!id || working.some((note) => note.id === id)) throw new Error('生成了重复的项目笔记 ID');
      const created: NoteItem = {
        id,
        title,
        content: '',
        noteType: 'project',
        parentId: parent.id,
        tags: ['学习计划'],
        links: [],
        backlinks: [],
        dueDates: dueDate ? [{
          id: `due-${id}-0`, noteId: id, noteTitle: title, taskText: title,
          startDate, dueDate, completed: false, priority: patch.priority || 'medium',
        }] : [],
        createdAt: now,
        updatedAt: now,
      };
      working = [...working, created];
      createdProjectIds.add(id);
    } else if (patch.operation === 'move') {
      const project = projectInScope(patch.projectTitle, '项目标题');
      const newParent = projectInScope(patch.newParentProjectTitle, '新父项目标题');
      if (project.id === session.scopeProjectId) throw new Error('锁定板块根节点不能被移动');
      if (project.id === newParent.id) throw new Error('项目不能成为自己的父项目');
      if (project.parentId === newParent.id) throw new Error(`项目“${project.title}”已经位于“${newParent.title}”下`);
      const descendantIds = new Set(getProjectNotesInScope(project.id, working).map((note) => note.id));
      if (descendantIds.has(newParent.id)) throw new Error('项目不能移动到自己的后代节点下');
      working = working.map((note) => note.id === project.id ? { ...note, parentId: newParent.id, updatedAt: now } : note);
      changedProjectIds.add(project.id);
    } else if (patch.operation === 'delete_subtree') {
      const project = projectInScope(patch.projectTitle, '项目标题');
      if (project.id === session.scopeProjectId) throw new Error('锁定板块根节点不能被删除');
      const deleting = new Set(getProjectNotesInScope(project.id, working).map((note) => note.id));
      if (working.some(note => deleting.has(note.id) && isReferenceProject(note))) throw new Error('待删除的计划子树包含资料型项目，请先单独处理资料；未连带删除');
      deleting.forEach((id) => deletedProjectIds.add(id));
      working = working
        .filter((note) => note.noteType !== 'project' || !deleting.has(note.id))
        .map((note) => {
          if (note.noteType === 'knowledge' && note.parentId && deleting.has(note.parentId)) {
            changedKnowledgeIds.add(note.id);
            return { ...note, parentId: undefined, updatedAt: now };
          }
          return note;
        });
    } else {
      throw new Error(`不支持的结构补丁：${String((patch as AgentProjectStructurePatch).operation)}`);
    }
    // A parent and its descendants may be shifted together. Intermediate
    // patch states can temporarily violate date containment even though the
    // final transaction is valid, so only structural invariants are checked
    // per patch and date ranges are checked atomically after the full batch.
    validateProjectTree(session.scopeProjectId, working, { validateDateRanges: false });
  }

  validateProjectTree(session.scopeProjectId, working, options);

  return {
    notes: working,
    changedProjectIds,
    createdProjectIds,
    deletedProjectIds,
    changedKnowledgeIds,
  };
}

function requirePlanRootForLayout(notes: NoteItem[], session: AgentPlanDraftSession): NoteItem {
  const root = findRootProject(session.scopeProjectId, notes);
  if (!root) throw new Error('找不到计划根项目');
  if (root.id !== session.scopeProjectId) {
    throw new Error(`计划条件、里程碑和执行事项必须锁定根计划“${root.title}”后修改`);
  }
  return root;
}

function defaultPlanMeta(root: NoteItem, now: string): PlanMeta {
  const deadline = root.dueDates.find((item) => item.taskText.trim() === root.title.trim());
  return {
    schemaVersion: 2,
    status: 'active',
    shortTitle: root.title,
    summary: `围绕“${root.title}”形成可验证的阶段成果。`,
    startDate: deadline?.startDate,
    targetDate: deadline?.dueDate,
    weeklyBudgetMinutes: 600,
    activeWeekdays: [1, 2, 3, 4, 5, 6],
    portfolioPriority: deadline?.priority || 'medium',
    autoAdjustPolicy: 'ask',
    milestones: [],
    updatedAt: now,
  };
}

function validateWeekdays(days: number[] | undefined): number[] | undefined {
  if (days === undefined) return undefined;
  const normalized = [...new Set(days.map(Number))].sort((a, b) => a - b);
  if (normalized.length < 1 || normalized.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
    throw new Error('学习日必须是 0 至 6 的非空整数数组');
  }
  return normalized;
}

function applyPlanMetaPatch(base: PlanMeta, patch: AgentPlanMetaPatch | undefined, now: string): PlanMeta {
  if (!patch) return base;
  if (patch.status !== undefined && !['draft', 'active', 'paused', 'completed', 'archived'].includes(patch.status)) throw new Error('计划状态无效');
  if (patch.portfolioPriority !== undefined && !['high', 'medium', 'low'].includes(patch.portfolioPriority)) throw new Error('计划优先级无效');
  if (patch.autoAdjustPolicy !== undefined && !['ask', 'automatic', 'off'].includes(patch.autoAdjustPolicy)) throw new Error('自动调整策略无效');
  const next = { ...base, ...patch, schemaVersion: 2 as const, updatedAt: now };
  if (patch.dailyStudyMinutes !== undefined && (!Number.isInteger(patch.dailyStudyMinutes) || patch.dailyStudyMinutes < 5 || patch.dailyStudyMinutes > 1440)) throw new Error('本计划每日投入须为 5–1440 分钟整数');
  if (patch.startDate !== undefined) next.startDate = requireDate(patch.startDate);
  if (patch.targetDate !== undefined) next.targetDate = requireDate(patch.targetDate);
  if (next.startDate && next.targetDate && next.startDate > next.targetDate) {
    throw new Error('根计划开始日期不能晚于目标日期');
  }
  if (patch.weeklyBudgetMinutes !== undefined) {
    const minutes = Number(patch.weeklyBudgetMinutes);
    if (!Number.isFinite(minutes) || minutes < 30 || minutes > 10080) throw new Error('每周时间预算必须在 30 至 10080 分钟之间');
    next.weeklyBudgetMinutes = Math.round(minutes);
  }
  if (patch.activeWeekdays !== undefined) next.activeWeekdays = validateWeekdays(patch.activeWeekdays);
  if (patch.shortTitle !== undefined) next.shortTitle = requireTitle(patch.shortTitle, '计划短标题');
  if (patch.summary !== undefined) {
    const summary = String(patch.summary).trim();
    if (!summary || summary.length > 500) throw new Error('计划摘要必须为 1 至 500 个字符');
    next.summary = summary;
  }
  if (patch.conditions !== undefined) next.conditions = { ...(base.conditions || {}), ...patch.conditions };
  return next;
}

function resolveProjectInScope(notes: NoteItem[], rootId: string, title: unknown, label: string): NoteItem {
  const requested = requireTitle(title, label);
  const scope = getLearningProjectNotesInScope(rootId, notes);
  const project = resolveNoteByTitleOrAlias(requested, scope);
  if (!project) throw new Error(`项目不属于锁定根计划：${requested}`);
  return project;
}

function applyMilestonePatches(
  notes: NoteItem[],
  root: NoteItem,
  meta: PlanMeta,
  patches: AgentPlanMilestonePatch[],
): PlanMeta {
  let milestones = [...(meta.milestones || [])];
  for (const patch of patches) {
    const id = requireTitle(patch.milestoneId, '里程碑 ID');
    const index = milestones.findIndex((item) => item.id === id);
    if (patch.operation === 'add') {
      if (index >= 0) throw new Error(`里程碑 ID 已存在：${id}`);
      const title = requireTitle(patch.title, '里程碑标题');
      const dueDate = requireDate(patch.dueDate);
      const projectId = patch.projectTitle
        ? resolveProjectInScope(notes, root.id, patch.projectTitle, '里程碑所属项目').id
        : undefined;
      milestones.push({ id, title, dueDate, criteria: patch.criteria?.map((item) => requireTitle(item, '验收条件')), projectId, completed: false });
      continue;
    }
    if (index < 0) throw new Error(`未找到里程碑：${id}`);
    if (patch.operation === 'delete') {
      milestones.splice(index, 1);
      continue;
    }
    const current = milestones[index];
    milestones[index] = {
      ...current,
      title: patch.title === undefined ? current.title : requireTitle(patch.title, '里程碑标题'),
      dueDate: patch.dueDate === undefined ? current.dueDate : requireDate(patch.dueDate),
      criteria: patch.clearCriteria ? undefined : patch.criteria === undefined
        ? current.criteria
        : patch.criteria.map((item) => requireTitle(item, '验收条件')),
      projectId: patch.clearProject ? undefined : patch.projectTitle === undefined
        ? current.projectId
        : resolveProjectInScope(notes, root.id, patch.projectTitle, '里程碑所属项目').id,
    };
  }
  const ids = new Set<string>();
  for (const milestone of milestones) {
    if (ids.has(milestone.id)) throw new Error(`里程碑 ID 重复：${milestone.id}`);
    ids.add(milestone.id);
    if (meta.startDate && milestone.dueDate < meta.startDate) throw new Error(`里程碑“${milestone.title}”早于计划开始日期`);
    if (meta.targetDate && milestone.dueDate > meta.targetDate) throw new Error(`里程碑“${milestone.title}”晚于计划目标日期`);
  }
  return { ...meta, milestones };
}

function isProjectDeadline(note: NoteItem, task: DueDateItem): boolean {
  return task.id === `due-${note.id}-0` || task.taskText.trim() === note.title.trim();
}

function updateTaskLine(content: string, previous: DueDateItem | undefined, next: DueDateItem | undefined): string {
  const lines = content.split('\n');
  let index = previous ? lines.findIndex((line) => extractPlanTaskId(line) === previous.id) : -1;
  if (index < 0 && previous) {
    index = lines.findIndex((line) => line.includes(previous.taskText) && /@due\([^)]+\)/i.test(line));
  }
  if (!next) {
    if (index >= 0) lines.splice(index, 1);
    return lines.join('\n').replace(/^\s+|\s+$/g, '');
  }
  let line = formatPlanTaskLine(next.taskText, next.dueDate, next.id);
  if (next.completed) line = line.replace('- [ ]', '- [x]');
  if (index >= 0) lines[index] = line;
  else lines.push(line);
  return lines.join('\n').replace(/^\s+|\s+$/g, '');
}

function normalizeRecurrence(patch: AgentPlanExecutionPatch) {
  if (patch.clearRecurrence) return undefined;
  if (!patch.recurrence) return undefined;
  if (!['none', 'daily', 'weekdays', 'weekly', 'custom'].includes(patch.recurrence.frequency)) throw new Error('重复频率无效');
  if (patch.recurrence.missedPolicy && !['skip', 'rollover', 'keep'].includes(patch.recurrence.missedPolicy)) throw new Error('错过周期任务后的处理策略无效');
  const interval = patch.recurrence.interval === undefined ? 1 : Number(patch.recurrence.interval);
  if (!Number.isInteger(interval) || interval < 1 || interval > 365) throw new Error('重复间隔必须是 1 至 365 的整数');
  const weekdays = patch.recurrence.weekdays === undefined ? undefined : validateWeekdays(patch.recurrence.weekdays);
  const endDate = patch.recurrence.endDate ? requireDate(patch.recurrence.endDate) : undefined;
  return { ...patch.recurrence, interval, weekdays, endDate };
}

function applyExecutionPatches(
  notes: NoteItem[],
  root: NoteItem,
  meta: PlanMeta,
  patches: AgentPlanExecutionPatch[],
  now: string,
): { notes: NoteItem[]; changedProjectIds: Set<string> } {
  let working = notes;
  const changedProjectIds = new Set<string>();
  const scopeIds = new Set(getLearningProjectNotesInScope(root.id, working).map((note) => note.id));
  const allTaskIds = () => new Set(working.flatMap((note) => note.dueDates.map((item) => item.id)));

  for (const patch of patches) {
    const taskId = requireTitle(patch.taskId, '执行事项 ID');
    if (!/^[A-Za-z0-9._:-]+$/.test(taskId)) throw new Error(`执行事项 ID 含有不支持的字符：${taskId}`);
    let host = working.find((note) => scopeIds.has(note.id) && note.dueDates.some((item) => item.id === taskId));
    const existing = host?.dueDates.find((item) => item.id === taskId);
    if (patch.operation === 'add') {
      if (allTaskIds().has(taskId)) throw new Error(`执行事项 ID 已存在：${taskId}`);
      host = resolveProjectInScope(working, root.id, patch.noteTitle, '执行事项承载项目');
    } else if (!host || !existing) {
      throw new Error(`未找到执行事项：${taskId}`);
    }
    if (existing && isProjectDeadline(host!, existing)) throw new Error('项目时间范围必须使用结构补丁修改，不能作为执行事项处理');
    if (patch.operation === 'delete') {
      const updated = {
        ...host!,
        content: updateTaskLine(host!.content, existing, undefined),
        dueDates: host!.dueDates.filter((item) => item.id !== taskId),
        updatedAt: now,
      };
      working = working.map((note) => note.id === updated.id ? updated : note);
      changedProjectIds.add(updated.id);
      continue;
    }

    const taskText = patch.taskText === undefined ? existing?.taskText : requireTitle(patch.taskText, '执行事项名称');
    const dueDate = patch.dueDate === undefined ? existing?.dueDate : requireDate(patch.dueDate);
    if (!taskText || !dueDate) throw new Error('新增执行事项必须提供 taskText 和 dueDate');
    const startDate = patch.startDate === undefined ? existing?.startDate || dueDate : requireDate(patch.startDate);
    if (startDate > dueDate) throw new Error(`执行事项“${taskText}”的开始日期不能晚于结束日期`);
    const estimatedMinutes = patch.estimatedMinutes === undefined ? existing?.estimatedMinutes || 60 : Number(patch.estimatedMinutes);
    if (!Number.isFinite(estimatedMinutes) || estimatedMinutes < 1 || estimatedMinutes > 1440) throw new Error('执行事项预计时长必须在 1 至 1440 分钟之间');
    const milestoneId = patch.clearMilestone ? undefined : patch.milestoneId === undefined ? existing?.milestoneId : patch.milestoneId;
    if (milestoneId && !(meta.milestones || []).some((item) => item.id === milestoneId)) {
      throw new Error(`执行事项“${taskText}”引用了不存在的里程碑：${milestoneId}`);
    }
    const linkedProjectId = patch.clearLinkedProject ? undefined : patch.linkedProjectTitle === undefined
      ? existing?.linkedProjectId
      : resolveProjectInScope(working, root.id, patch.linkedProjectTitle, '执行事项关联项目').id;
    const linkedKnowledgeIds = patch.clearLinkedKnowledge ? undefined : patch.linkedKnowledgeTitles === undefined
      ? existing?.linkedKnowledgeIds
      : patch.linkedKnowledgeTitles.map((title) => {
        const knowledge = resolveNoteByTitleOrAlias(requireTitle(title, '关联知识点'), working.filter((note) => note.noteType === 'knowledge'));
        if (!knowledge) throw new Error(`未找到关联知识点：${title}`);
        return knowledge.id;
      });
    const recurrence = patch.clearRecurrence ? undefined : patch.recurrence ? normalizeRecurrence(patch) : existing?.recurrence;
    if (recurrence?.endDate && recurrence.endDate < dueDate) throw new Error(`执行事项“${taskText}”的重复结束日期不能早于首次日期`);
    const reminderMinutes = patch.reminderMinutes === undefined ? existing?.reminderMinutes : Number(patch.reminderMinutes);
    if (reminderMinutes !== undefined && (!Number.isFinite(reminderMinutes) || reminderMinutes < 0 || reminderMinutes > 10080)) {
      throw new Error('提醒提前量必须在 0 至 10080 分钟之间');
    }
    const nextTask: DueDateItem = {
      ...(existing || {} as DueDateItem),
      id: taskId,
      noteId: host!.id,
      noteTitle: host!.title,
      taskText,
      kind: patch.kind || existing?.kind || 'learn',
      executionKind: patch.executionKind || existing?.executionKind || 'todo',
      startDate,
      dueDate,
      estimatedMinutes: Math.round(estimatedMinutes),
      priority: patch.priority || existing?.priority || 'medium',
      recurrence,
      milestoneId,
      linkedProjectId,
      linkedKnowledgeIds,
      launchMode: patch.launchMode || existing?.launchMode || 'none',
      reminderMinutes: reminderMinutes === undefined ? undefined : Math.round(reminderMinutes),
      completed: existing?.completed || false,
      source: existing?.source || 'llm',
    };
    const dueDates = existing
      ? host!.dueDates.map((item) => item.id === taskId ? nextTask : item)
      : [...host!.dueDates, nextTask];
    const updated = { ...host!, content: updateTaskLine(host!.content, existing, nextTask), dueDates, updatedAt: now };
    working = working.map((note) => note.id === updated.id ? updated : note);
    changedProjectIds.add(updated.id);
  }
  return { notes: working, changedProjectIds };
}

function applyPlanLayoutPatches(
  notes: NoteItem[],
  session: AgentPlanDraftSession,
  now: string,
): { notes: NoteItem[]; changedProjectIds: Set<string> } {
  const scopeRoot = notes.find((note) => note.id === session.scopeProjectId && note.noteType === 'project');
  const shouldRefreshPhaseWindows = session.structurePatches.length > 0 && Boolean(scopeRoot?.planMeta);
  if (!shouldRefreshPhaseWindows && !session.planMetaPatch && (session.milestonePatches?.length || 0) === 0 && (session.executionPatches?.length || 0) === 0) {
    return { notes, changedProjectIds: new Set() };
  }
  const root = requirePlanRootForLayout(notes, session);
  let meta = applyPlanMetaPatch(root.planMeta || defaultPlanMeta(root, now), session.planMetaPatch, now);
  meta = applyMilestonePatches(notes, root, meta, session.milestonePatches || []);
  const execution = applyExecutionPatches(notes, root, meta, session.executionPatches || [], now);
  const scopeAfter = getLearningProjectNotesInScope(root.id, execution.notes);
  const scopeIds = new Set(scopeAfter.map((note) => note.id));
  const milestoneIds = new Set((meta.milestones || []).map((item) => item.id));
  for (const milestone of meta.milestones || []) {
    if (milestone.projectId && !scopeIds.has(milestone.projectId)) throw new Error(`里程碑“${milestone.title}”关联的项目已不在计划中`);
  }
  for (const note of scopeAfter) {
    for (const task of note.dueDates) {
      if (task.milestoneId && !milestoneIds.has(task.milestoneId)) throw new Error(`执行事项“${task.taskText}”引用的里程碑已不存在`);
      if (task.linkedProjectId && !scopeIds.has(task.linkedProjectId)) throw new Error(`执行事项“${task.taskText}”关联的项目已不在计划中`);
    }
  }
  const previousWindows = new Map((meta.phaseWindows || []).map((item) => [item.projectId, item]));
  meta = {
    ...meta,
    phaseWindows: scopeAfter.filter((note) => note.parentId === root.id).flatMap((note, order) => {
      const deadline = note.dueDates.find((item) => isProjectDeadline(note, item));
      if (!deadline?.startDate) return [];
      return [{ projectId: note.id, startDate: deadline.startDate, endDate: deadline.dueDate, outcome: previousWindows.get(note.id)?.outcome, order }];
    }),
    updatedAt: now,
  };
  const nextNotes = execution.notes.map((note) => {
    let next = note.id === root.id ? { ...note, planMeta: meta, updatedAt: now } : note;
    const deadline = getScheduledProjectDeadline(note);
    if (session.planMetaPatch?.dailyStudyMinutes !== undefined && deadline?.completed && deadline.estimatedMinutes === undefined
      && planRootFor(note, execution.notes)?.id === root.id && getScheduledProjectChildren(execution.notes, note.id).length === 0) {
      next = { ...next, dueDates: note.dueDates.map(d => d === deadline ? { ...d, estimatedMinutes: leafStudyEffort(note, root).minutes } : d), updatedAt: now };
      execution.changedProjectIds.add(note.id);
    }
    return next;
  });
  execution.changedProjectIds.add(root.id);
  return { notes: nextNotes, changedProjectIds: execution.changedProjectIds };
}

function assertSinglePlanDraftFresh(notes: NoteItem[], session: AgentPlanDraftSession): void {
  const scope = notes.find((note) => note.id === session.scopeProjectId && note.noteType === 'project');
  if (!scope) throw new Error(`草案范围项目已不存在：${session.scopeProjectTitle}`);
  const current = getLearningProjectNotesInScope(scope.id, notes);
  const currentIds = new Set(current.map((project) => project.id));
  const baseIds = Object.keys(session.baseProjectRevisions);
  if (current.length !== baseIds.length || baseIds.some((id) => !currentIds.has(id))) {
    throw new Error('草案创建后项目结构已变化，请放弃草案并重新生成');
  }
  const changed = current.find((project) => session.baseProjectRevisions[project.id] !== project.updatedAt);
  if (changed) throw new Error(`草案创建后项目“${changed.title}”已被修改，请放弃草案并重新生成`);
}

function portfolioRootAsSession(
  portfolio: AgentPlanDraftSession,
  rootDraft: AgentPortfolioPlanRootDraft,
): AgentPlanDraftSession {
  return {
    ...portfolio,
    scopeKind: 'root',
    scopeProjectId: rootDraft.rootProjectId,
    scopeProjectTitle: rootDraft.rootProjectTitle,
    baseProjectRevisions: rootDraft.baseProjectRevisions,
    projects: [],
    createKnowledgeNotes: [],
    structurePatches: rootDraft.structurePatches,
    planMetaPatch: rootDraft.planMetaPatch,
    milestonePatches: rootDraft.milestonePatches,
    executionPatches: rootDraft.executionPatches,
    portfolioRoots: undefined,
  };
}

export function assertPlanDraftFresh(notes: NoteItem[], session: AgentPlanDraftSession): void {
  if (session.scopeKind !== 'portfolio') {
    assertSinglePlanDraftFresh(notes, session);
    return;
  }
  const roots = Object.values(session.portfolioRoots || {});
  if (roots.length === 0) throw new Error('综合计划草案中没有已锁定的计划根');
  if (session.structurePatches.length || session.projects.length || session.createKnowledgeNotes.length) {
    throw new Error('综合调整禁止修改项目结构或跨根移动项目');
  }
  // Validate every root before projecting any mutation. One stale root aborts
  // the entire portfolio transaction.
  for (const rootDraft of roots) {
    const currentRoot = notes.find((note) => note.id === rootDraft.rootProjectId && note.noteType === 'project');
    if (currentRoot?.planMeta?.status === 'archived') {
      throw new Error(`计划“${rootDraft.rootProjectTitle}”已归档，请放弃综合草案并重新生成`);
    }
    assertSinglePlanDraftFresh(notes, portfolioRootAsSession(session, rootDraft));
  }
}

function buildSinglePlanDraftMutation(
  notes: NoteItem[],
  session: AgentPlanDraftSession,
  now = new Date().toISOString(),
  idFactory?: () => string,
): PlanDraftMutationResult {
  assertSinglePlanDraftFresh(notes, session);
  if (session.projects.length === 0 && session.structurePatches.length === 0 && !session.planMetaPatch
    && (session.milestonePatches?.length || 0) === 0 && (session.executionPatches?.length || 0) === 0) {
    throw new Error('草案中还没有任何修改');
  }

  const declaredMissing = new Map(session.createKnowledgeNotes.map((title) => [title.toLocaleLowerCase(), title]));
  const structure = applyProjectStructurePatches(notes, session, now, idFactory);
  const layout = applyPlanLayoutPatches(structure.notes, session, now);
  let workingNotes = layout.notes;
  const changedIds = new Set([...structure.changedProjectIds, ...layout.changedProjectIds]);
  const createdKnowledgeNotes: NoteItem[] = [];
  const linkedKnowledgeTitles = new Set<string>();
  let taskCount = 0;

  for (let offset = 0; offset < session.projects.length; offset += 5) {
    const projects = session.projects.slice(offset, offset + 5);
    const existingKnowledge = workingNotes.filter((note) => note.noteType === 'knowledge');
    const batchMissing = new Map<string, string>();
    for (const project of projects) {
      for (const task of project.tasks) {
        for (const target of extractWikiTargets(task, name => findNotesByTitleOrAlias(name, workingNotes).length > 0 || declaredMissing.has(name.toLocaleLowerCase()))) {
          if (resolveNoteByTitleOrAlias(target, existingKnowledge)) continue;
          const declared = declaredMissing.get(target.toLocaleLowerCase());
          if (declared) batchMissing.set(declared.toLocaleLowerCase(), declared);
        }
      }
    }
    const scopeProject = workingNotes.find((note) => note.id === session.scopeProjectId && note.noteType === 'project');
    if (!scopeProject) throw new Error('结构补丁导致锁定板块根节点丢失');
    const mutation = appendProjectStudyTaskBatch(workingNotes, {
      rootProjectTitle: scopeProject.title,
      projects,
      createKnowledgeNotes: [...batchMissing.values()],
    }, now, idFactory);
    workingNotes = mutation.notes;
    mutation.changedProjectNotes.forEach((note) => changedIds.add(note.id));
    createdKnowledgeNotes.push(...mutation.createdKnowledgeNotes);
    mutation.summary.linkedKnowledgeTitles.forEach((title) => linkedKnowledgeTitles.add(title));
    mutation.summary.createdKnowledgeTitles.forEach((title) => declaredMissing.delete(title.toLocaleLowerCase()));
    taskCount += mutation.summary.taskCount;
  }
  if (declaredMissing.size > 0) {
    throw new Error(`待创建知识点未被草案引用：${[...declaredMissing.values()].join('、')}`);
  }

  return {
    notes: workingNotes,
    changedProjectNotes: workingNotes.filter((note) => changedIds.has(note.id)),
    createdProjectNotes: workingNotes.filter((note) => structure.createdProjectIds.has(note.id)),
    deletedProjectIds: [...structure.deletedProjectIds],
    changedKnowledgeNotes: workingNotes.filter((note) => structure.changedKnowledgeIds.has(note.id)),
    createdKnowledgeNotes,
    summary: {
      rootProjectTitle: workingNotes.find((note) => note.id === session.scopeProjectId)?.title || session.scopeProjectTitle,
      projectCount: new Set([
        ...changedIds,
        ...structure.createdProjectIds,
        ...structure.deletedProjectIds,
      ]).size,
      taskCount,
      createdKnowledgeTitles: createdKnowledgeNotes.map((note) => note.title),
      linkedKnowledgeTitles: [...linkedKnowledgeTitles],
      structurePatchCount: session.structurePatches.length,
      planMetaPatchCount: session.planMetaPatch ? 1 : 0,
      milestonePatchCount: session.milestonePatches?.length || 0,
      executionPatchCount: session.executionPatches?.length || 0,
    },
  };
}

function buildPortfolioPlanDraftMutation(
  notes: NoteItem[],
  session: AgentPlanDraftSession,
  now: string,
  idFactory?: () => string,
): PlanDraftMutationResult {
  assertPlanDraftFresh(notes, session);
  const roots = Object.values(session.portfolioRoots || {});
  const changedRoots = roots.filter((root) => root.structurePatches.length > 0 || root.planMetaPatch
    || root.milestonePatches.length > 0
    || root.executionPatches.length > 0);
  if (changedRoots.length === 0) throw new Error('综合计划草案中还没有任何修改');

  let workingNotes = notes;
  const changedProjectIds = new Set<string>();
  const rootSummaries: NonNullable<PlanDraftMutationResult['summary']['rootSummaries']> = [];
  let milestonePatchCount = 0;
  let executionPatchCount = 0;
  let planMetaPatchCount = 0;
  let structurePatchCount = 0;

  // Each projection is pure. Persistence happens only after this function has
  // successfully returned the one final notes array, so a later failure cannot
  // leave an earlier root partially committed.
  for (const rootDraft of changedRoots) {
    const rootSession = portfolioRootAsSession(session, rootDraft);
    const mutation = buildSinglePlanDraftMutation(workingNotes, rootSession, now, idFactory);
    workingNotes = mutation.notes;
    mutation.changedProjectNotes.forEach((note) => changedProjectIds.add(note.id));
    const rootMetaCount = rootDraft.planMetaPatch ? 1 : 0;
    structurePatchCount += rootDraft.structurePatches.length;
    planMetaPatchCount += rootMetaCount;
    milestonePatchCount += rootDraft.milestonePatches.length;
    executionPatchCount += rootDraft.executionPatches.length;
    rootSummaries.push({
      rootProjectId: rootDraft.rootProjectId,
      rootProjectTitle: workingNotes.find((note) => note.id === rootDraft.rootProjectId)?.title || rootDraft.rootProjectTitle,
      structurePatchCount: rootDraft.structurePatches.length,
      planMetaPatchCount: rootMetaCount,
      milestonePatchCount: rootDraft.milestonePatches.length,
      executionPatchCount: rootDraft.executionPatches.length,
    });
  }

  return {
    notes: workingNotes,
    changedProjectNotes: workingNotes.filter((note) => changedProjectIds.has(note.id)),
    createdProjectNotes: [],
    deletedProjectIds: [],
    changedKnowledgeNotes: [],
    createdKnowledgeNotes: [],
    summary: {
      rootProjectTitle: '综合总览',
      projectCount: changedProjectIds.size,
      taskCount: 0,
      createdKnowledgeTitles: [],
      linkedKnowledgeTitles: [],
      structurePatchCount,
      planMetaPatchCount,
      milestonePatchCount,
      executionPatchCount,
      rootCount: rootSummaries.length,
      rootProjectTitles: rootSummaries.map((root) => root.rootProjectTitle),
      rootSummaries,
    },
  };
}

export function buildPlanDraftMutation(
  notes: NoteItem[],
  session: AgentPlanDraftSession,
  now = new Date().toISOString(),
  idFactory?: () => string,
): PlanDraftMutationResult {
  return session.scopeKind === 'portfolio'
    ? buildPortfolioPlanDraftMutation(notes, session, now, idFactory)
    : buildSinglePlanDraftMutation(notes, session, now, idFactory);
}

export function stagePlanDraftBatch(
  notes: NoteItem[],
  session: AgentPlanDraftSession,
  input: { projects: AgentProjectStudyTasksInput[]; createKnowledgeNotes: string[] },
  now = new Date().toISOString(),
): AgentPlanDraftSession {
  if (session.scopeKind === 'portfolio') throw new Error('综合计划草案不能修改末级项目正文任务');
  assertPlanDraftFresh(notes, session);
  if (!Array.isArray(input.projects) || input.projects.length < 1 || input.projects.length > 5) {
    throw new Error('一个草案批次必须包含 1 至 5 个末级项目');
  }
  if (!Array.isArray(input.createKnowledgeNotes)) throw new Error('createKnowledgeNotes 必须是数组');

  const projectedNotes = applyProjectStructurePatches(notes, session, now).notes;
  applyPlanLayoutPatches(projectedNotes, session, now);
  const projectNotes = projectedNotes.filter((note) => note.noteType === 'project');
  const allowedLeafIds = new Set(getLeafProjectNotesInScope(session.scopeProjectId, projectedNotes).map((note) => note.id));
  const nextProjects = [...session.projects];
  for (const inputProject of input.projects) {
    const project = resolveNoteByTitleOrAlias(String(inputProject.projectTitle || ''), projectNotes);
    if (!project || !allowedLeafIds.has(project.id)) {
      throw new Error(`项目不属于锁定板块“${session.scopeProjectTitle}”的末级项目：${inputProject.projectTitle}`);
    }
    const canonical = { projectTitle: project.title, tasks: inputProject.tasks.map((task) => String(task || '').trim()) };
    const existingIndex = nextProjects.findIndex((item) => (
      resolveNoteByTitleOrAlias(item.projectTitle, projectNotes)?.id === project.id
    ));
    if (existingIndex >= 0) nextProjects[existingIndex] = canonical;
    else nextProjects.push(canonical);
  }

  const declaredWikiNames = new Set([...session.createKnowledgeNotes, ...input.createKnowledgeNotes].map(title => String(title).trim().toLocaleLowerCase()));
  const referencedTargets = new Set(nextProjects.flatMap((project) => project.tasks)
    .flatMap(task => extractWikiTargets(task, name => findNotesByTitleOrAlias(name, notes).length > 0 || declaredWikiNames.has(name.toLocaleLowerCase())))
    .map((title) => title.toLocaleLowerCase()));
  const knownKnowledge = notes.filter((note) => note.noteType === 'knowledge');
  const missing = new Map<string, string>();
  [...session.createKnowledgeNotes, ...input.createKnowledgeNotes].forEach((rawTitle) => {
    const title = String(rawTitle || '').trim();
    if (!title || findNotesByTitleOrAlias(title, knownKnowledge).length) return;
    if (referencedTargets.has(title.toLocaleLowerCase())) missing.set(title.toLocaleLowerCase(), title);
  });

  const candidate = {
    ...session,
    projects: nextProjects,
    createKnowledgeNotes: [...missing.values()],
    updatedAt: now,
  };
  buildPlanDraftMutation(notes, candidate, now);
  return candidate;
}

export function stagePlanStructurePatches(
  notes: NoteItem[],
  session: AgentPlanDraftSession,
  patches: AgentProjectStructurePatch[],
  now = new Date().toISOString(),
): AgentPlanDraftSession {
  if (session.scopeKind === 'portfolio') throw new Error('综合调整禁止修改项目结构或跨根移动项目');
  assertPlanDraftFresh(notes, session);
  if (!Array.isArray(patches) || patches.length < 1 || patches.length > 20) {
    throw new Error('一次必须暂存 1 至 20 个结构补丁');
  }
  // Structure staging is allowed to hold a temporary parent/child date
  // mismatch across Agent turns. Every individual date remains syntactically
  // valid; the complete range relationship is enforced on final commit.
  const beforePatchNotes = applyProjectStructurePatches(
    notes, session, now, undefined, { validateDateRanges: false },
  ).notes;
  const projectDraftIds = session.projects.map((project) => ({
    project,
    id: resolveNoteByTitleOrAlias(
      project.projectTitle,
      beforePatchNotes.filter((note) => note.noteType === 'project'),
    )?.id,
  }));
  const preliminary = {
    ...session,
    structurePatches: [...session.structurePatches, ...patches],
    updatedAt: now,
  };
  const projectedNotes = applyProjectStructurePatches(
    notes, preliminary, now, undefined, { validateDateRanges: false },
  ).notes;
  const projectedProjects = projectedNotes.filter((note) => note.noteType === 'project');
  const projects = projectDraftIds.flatMap(({ project, id }) => {
    const projected = id ? projectedProjects.find((note) => note.id === id) : undefined;
    return projected ? [{ ...project, projectTitle: projected.title }] : [];
  });
  const declaredWikiNames = new Set(session.createKnowledgeNotes.map(title => title.toLocaleLowerCase()));
  const referencedTargets = new Set(projects.flatMap((project) => project.tasks)
    .flatMap(task => extractWikiTargets(task, name => findNotesByTitleOrAlias(name, projectedNotes).length > 0 || declaredWikiNames.has(name.toLocaleLowerCase())))
    .map((title) => title.toLocaleLowerCase()));
  const knownKnowledge = notes.filter((note) => note.noteType === 'knowledge');
  const createKnowledgeNotes = session.createKnowledgeNotes.filter((title) => (
    referencedTargets.has(title.toLocaleLowerCase())
    && !findNotesByTitleOrAlias(title, knownKnowledge).length
  ));
  const candidate = { ...preliminary, projects, createKnowledgeNotes };
  return candidate;
}

export function stagePlanMetaPatch(
  notes: NoteItem[],
  session: AgentPlanDraftSession,
  patch: AgentPlanMetaPatch,
  now = new Date().toISOString(),
): AgentPlanDraftSession {
  if (session.scopeKind === 'portfolio') throw new Error('综合草案必须通过稳定 rootProjectId 指定计划设置补丁');
  assertPlanDraftFresh(notes, session);
  if (!patch || Object.keys(patch).length === 0) throw new Error('计划设置补丁不能为空');
  const mergedPatch = {
    ...(session.planMetaPatch || {}),
    ...patch,
    conditions: patch.conditions === undefined
      ? session.planMetaPatch?.conditions
      : { ...(session.planMetaPatch?.conditions || {}), ...patch.conditions },
  };
  const candidate = {
    ...session,
    planMetaPatch: Object.fromEntries(Object.entries(mergedPatch).filter(([, value]) => value !== undefined)) as AgentPlanMetaPatch,
    updatedAt: now,
  };
  buildPlanDraftMutation(notes, candidate, now);
  return candidate;
}

export function stagePlanMilestonePatches(
  notes: NoteItem[],
  session: AgentPlanDraftSession,
  patches: AgentPlanMilestonePatch[],
  now = new Date().toISOString(),
): AgentPlanDraftSession {
  if (session.scopeKind === 'portfolio') throw new Error('综合草案必须通过稳定 rootProjectId 指定里程碑补丁');
  assertPlanDraftFresh(notes, session);
  if (!Array.isArray(patches) || patches.length < 1 || patches.length > 20) throw new Error('一次必须暂存 1 至 20 个里程碑补丁');
  const candidate = { ...session, milestonePatches: [...(session.milestonePatches || []), ...patches], updatedAt: now };
  buildPlanDraftMutation(notes, candidate, now);
  return candidate;
}

export function stagePlanExecutionPatches(
  notes: NoteItem[],
  session: AgentPlanDraftSession,
  patches: AgentPlanExecutionPatch[],
  now = new Date().toISOString(),
): AgentPlanDraftSession {
  if (session.scopeKind === 'portfolio') throw new Error('综合草案必须通过稳定 rootProjectId 指定执行事项补丁');
  assertPlanDraftFresh(notes, session);
  if (!Array.isArray(patches) || patches.length < 1 || patches.length > 20) throw new Error('一次必须暂存 1 至 20 个执行事项补丁');
  const candidate = { ...session, executionPatches: [...(session.executionPatches || []), ...patches], updatedAt: now };
  buildPlanDraftMutation(notes, candidate, now);
  return candidate;
}

/**
 * Portfolio rescheduling may outgrow an existing phase. Repair only the
 * affected nodes' scheduled ancestors, by the smallest enclosing range. This
 * is a pure projection and the generated patches remain in the visible draft;
 * it never ripples dates into siblings or writes to the vault.
 */
function completePortfolioAncestorDateRanges(
  notes: NoteItem[],
  portfolio: AgentPlanDraftSession,
  rootDraft: AgentPortfolioPlanRootDraft,
  now: string,
): AgentPortfolioPlanRootDraft {
  const datePatches = rootDraft.structurePatches.filter((patch) => patch.startDate !== undefined
    || patch.dueDate !== undefined || patch.clearStartDate || patch.clearDueDate);
  if (datePatches.length === 0 && rootDraft.planMetaPatch?.startDate === undefined
    && rootDraft.planMetaPatch?.targetDate === undefined) return rootDraft;
  const rootSession = portfolioRootAsSession(portfolio, rootDraft);
  let projected = applyProjectStructurePatches(notes, rootSession, now, undefined, { validateDateRanges: false }).notes;
  const scope = getLearningProjectNotesInScope(rootDraft.rootProjectId, projected);
  const byId = new Map(scope.map((note) => [note.id, note]));
  const ancestorIds = new Set<string>();
  for (const patch of datePatches) {
    const project = resolveProjectInScope(projected, rootDraft.rootProjectId, patch.projectTitle, '项目标题');
    let parentId = project.parentId;
    const visited = new Set<string>();
    while (parentId && byId.has(parentId) && !visited.has(parentId)) {
      visited.add(parentId);
      ancestorIds.add(parentId);
      parentId = byId.get(parentId)?.parentId;
    }
  }
  const depth = (id: string) => {
    let level = 0;
    let current = byId.get(id);
    const visited = new Set<string>();
    while (current?.parentId && byId.has(current.parentId) && !visited.has(current.id)) {
      visited.add(current.id);
      level += 1;
      current = byId.get(current.parentId);
    }
    return level;
  };
  const automaticPatches: AgentProjectStructurePatch[] = [];
  for (const ancestorId of [...ancestorIds].sort((a, b) => depth(b) - depth(a))) {
    const ancestor = projected.find((note) => note.id === ancestorId)!;
    const deadline = getScheduledProjectDeadline(ancestor);
    // An undated ancestor imposes no date boundary; do not invent a new
    // scheduled project merely because a descendant is scheduled.
    if (!deadline) continue;
    const descendantDates = getLearningProjectNotesInScope(ancestor.id, projected)
      .filter((note) => note.id !== ancestor.id)
      .flatMap((note) => {
        const date = getScheduledProjectDeadline(note);
        return date ? [date] : [];
      });
    const dueDate = descendantDates.reduce((latest, date) => date.dueDate > latest ? date.dueDate : latest, deadline.dueDate);
    const startDate = deadline.startDate === undefined ? undefined : descendantDates.reduce((earliest, date) => {
      const start = date.startDate || date.dueDate;
      return start < earliest ? start : earliest;
    }, deadline.startDate);
    if (dueDate === deadline.dueDate && startDate === deadline.startDate) continue;
    const patch: AgentProjectStructurePatch = {
      operation: 'update', projectTitle: ancestor.title,
      ...(dueDate !== deadline.dueDate ? { dueDate } : {}),
      ...(startDate !== deadline.startDate ? { startDate } : {}),
    };
    automaticPatches.push(patch);
    projected = applyProjectStructurePatches(projected, { ...rootSession, structurePatches: [patch] }, now, undefined,
      { validateDateRanges: false }).notes;
  }

  const originalRoot = notes.find((note) => note.id === rootDraft.rootProjectId)!;
  const projectedRoot = projected.find((note) => note.id === rootDraft.rootProjectId)!;
  const dates = getLearningProjectNotesInScope(rootDraft.rootProjectId, projected).flatMap((note) => {
    const date = getScheduledProjectDeadline(note);
    return date ? [date] : [];
  });
  let planMetaPatch = rootDraft.planMetaPatch;
  if (dates.length > 0) {
    const latest = dates.reduce((max, date) => date.dueDate > max ? date.dueDate : max, dates[0].dueDate);
    const earliest = dates.reduce((min, date) => (date.startDate || date.dueDate) < min ? date.startDate || date.dueDate : min,
      dates[0].startDate || dates[0].dueDate);
    const originalTarget = originalRoot.planMeta?.targetDate || getScheduledProjectDeadline(originalRoot)?.dueDate;
    const explicitTarget = planMetaPatch?.targetDate === undefined ? undefined : requireDate(planMetaPatch.targetDate);
    const hardDeadline = originalRoot.planMeta?.conditions?.deadlineMode === 'hard'
      || planMetaPatch?.conditions?.deadlineMode === 'hard';
    if (hardDeadline && ((!originalTarget || latest > originalTarget) && (!explicitTarget || explicitTarget < latest)
      || (explicitTarget !== undefined && explicitTarget < latest))) {
      throw new Error(`计划“${rootDraft.rootProjectTitle}”的改期需要覆盖至 ${latest}；硬截止不能自动延长，请明确提供不早于该日的根计划 targetDate`);
    }
    const target = explicitTarget || projectedRoot.planMeta?.targetDate;
    const start = planMetaPatch?.startDate || projectedRoot.planMeta?.startDate;
    // The editor also uses planMeta as the root's fallback window. Expand
    // existing flexible boundaries, but never create an unrelated root window.
    if (target && latest > target && !hardDeadline) planMetaPatch = { ...planMetaPatch, targetDate: latest };
    if (start && earliest < start) planMetaPatch = { ...planMetaPatch, startDate: earliest };
  }
  return { ...rootDraft, structurePatches: [...rootDraft.structurePatches, ...automaticPatches], planMetaPatch };
}

export function stagePortfolioPlanPatches(
  notes: NoteItem[],
  session: AgentPlanDraftSession,
  input: { roots: AgentPortfolioPlanRootPatchInput[] },
  now = new Date().toISOString(),
): AgentPlanDraftSession {
  if (session.scopeKind !== 'portfolio') throw new Error('当前草案不是综合计划草案');
  assertPlanDraftFresh(notes, session);
  if (!Array.isArray(input.roots) || input.roots.length < 1 || input.roots.length > 20) {
    throw new Error('一次必须为 1 至 20 个已锁定计划根提供补丁');
  }
  const duplicate = input.roots.find((root, index) => input.roots
    .findIndex((candidate) => candidate.rootProjectId === root.rootProjectId) !== index);
  if (duplicate) throw new Error(`一次暂存中重复出现计划根：${duplicate.rootProjectId}`);

  const portfolioRoots = { ...(session.portfolioRoots || {}) };
  for (const inputRoot of input.roots) {
    const rootProjectId = String(inputRoot.rootProjectId || '').trim();
    const current = portfolioRoots[rootProjectId];
    if (!current) throw new Error(`计划根未被综合草案锁定：${rootProjectId}`);
    const incomingStructurePatches = inputRoot.structurePatches || [];
    for (const patch of incomingStructurePatches) {
      if (patch.operation !== 'update') throw new Error('综合调整只允许更新根内项目的日期或优先级，不能新增、移动或删除项目');
      if (!patch.projectTitle?.trim()) throw new Error('综合结构时间补丁必须提供 projectTitle');
      if (patch.title || patch.parentProjectTitle || patch.newParentProjectTitle) throw new Error('综合调整不能重命名项目或改变父子关系');
      if (patch.startDate === undefined && patch.dueDate === undefined && !patch.clearStartDate && !patch.clearDueDate && patch.priority === undefined) {
        throw new Error(`项目“${patch.projectTitle}”的结构时间补丁为空`);
      }
    }
    const structurePatches = [...current.structurePatches, ...incomingStructurePatches];
    const incomingPlanMetaPatch = inputRoot.planMetaPatch
      ? Object.fromEntries(Object.entries(inputRoot.planMetaPatch).filter(([, value]) => value !== undefined)) as AgentPlanMetaPatch
      : undefined;
    const mergedPlanMetaPatch = incomingPlanMetaPatch && Object.keys(incomingPlanMetaPatch).length > 0
      ? {
        ...(current.planMetaPatch || {}),
        ...incomingPlanMetaPatch,
        conditions: incomingPlanMetaPatch.conditions === undefined
          ? current.planMetaPatch?.conditions
          : { ...(current.planMetaPatch?.conditions || {}), ...incomingPlanMetaPatch.conditions },
      }
      : current.planMetaPatch;
    const planMetaPatch = mergedPlanMetaPatch
      ? Object.fromEntries(Object.entries(mergedPlanMetaPatch).filter(([, value]) => value !== undefined)) as AgentPlanMetaPatch
      : undefined;
    const milestonePatches = [...current.milestonePatches, ...(inputRoot.milestonePatches || [])];
    const executionPatches = [...current.executionPatches, ...(inputRoot.executionPatches || [])];
    if (structurePatches.length === current.structurePatches.length
      && (!incomingPlanMetaPatch || Object.keys(incomingPlanMetaPatch).length === 0) && milestonePatches.length === current.milestonePatches.length
      && executionPatches.length === current.executionPatches.length) {
      throw new Error(`计划“${current.rootProjectTitle}”的组合补丁为空`);
    }
    portfolioRoots[rootProjectId] = completePortfolioAncestorDateRanges(notes, session,
      { ...current, structurePatches, planMetaPatch, milestonePatches, executionPatches }, now);
  }

  const roots = Object.values(portfolioRoots);
  const candidate: AgentPlanDraftSession = {
    ...session,
    portfolioRoots,
    // Keep the existing AgentPanel useful without teaching it a second draft
    // shape. These flattened arrays are presentation-only; mutation routing is
    // always performed through the root-id keyed states above.
    milestonePatches: roots.flatMap((root) => root.milestonePatches),
    executionPatches: roots.flatMap((root) => root.executionPatches),
    updatedAt: now,
  };
  buildPlanDraftMutation(notes, candidate, now);
  return candidate;
}
