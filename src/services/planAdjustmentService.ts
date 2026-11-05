import type { DueDateItem, NoteItem, PlanMeta, PlanNode, PlanTaskBlueprint } from '../types';
import { createPlanTaskId, formatPlanTaskLine } from './planTaskAnchor';
import { rememberGeneratedContent } from './ragSourcePolicy';
import type {
  AgentPlanTaskChange,
  AgentProjectPlanNode,
  AgentProjectStudyTaskBatchInput,
  AgentProjectStudyTasksInput,
} from './agent/types';
import { findNotesByTitleOrAlias, parseWikiLinkTarget, resolveNoteByTitleOrAlias, type WikiNames } from './noteResolver';
import { extractMarkdownWikiLinks } from './markdownWikiLinks';
import { getChildProjectNotes, getLeafProjectNotesInScope, isLeafProjectNote } from './knowledgePointSelector';
import { isReferenceProject } from './projectRole';
import { assertPlanStructureGranularity } from './planStructureGranularity';
import { homeLocalDate } from './homepage/homeTaskScheduling';

export interface PlanAdjustmentResult {
  notes: NoteItem[];
  changedNoteIds: string[];
  reasons: string[];
}

export interface PlanTaskMutationResult {
  notes: NoteItem[];
  changedNote: NoteItem;
  summary: {
    operation: AgentPlanTaskChange['operation'];
    noteId: string;
    noteTitle: string;
    taskText: string;
    dueDate: string;
    priority: 'high' | 'medium' | 'low';
  };
}

export interface ProjectPlanBuildResult {
  notes: NoteItem[];
  createdNotes: NoteItem[];
  tree: PlanNode[];
  summary: {
    rootNoteId: string;
    rootTitle: string;
    nodeCount: number;
    scheduledCount: number;
    milestoneCount: number;
    executionTaskCount: number;
  };
}

export interface ProjectStudyTasksResult {
  notes: NoteItem[];
  changedNote: NoteItem;
  summary: {
    projectNoteId: string;
    projectTitle: string;
    taskCount: number;
    linkedKnowledgeTitles: string[];
  };
}

export interface ProjectStudyTaskBatchResult {
  notes: NoteItem[];
  changedProjectNotes: NoteItem[];
  createdKnowledgeNotes: NoteItem[];
  summary: {
    rootProjectTitle: string;
    projectCount: number;
    taskCount: number;
    createdKnowledgeTitles: string[];
    linkedKnowledgeTitles: string[];
  };
}

function requireText(value: string, label: string): string {
  const result = value.trim();
  if (!result) throw new Error(`${label}不能为空`);
  if (/\r|\n|@due\s*\(/i.test(result)) throw new Error(`${label}包含不允许的换行或日期标签`);
  return result;
}

function requireDate(value: string | undefined): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  if (!match) throw new Error('日期必须使用 YYYY-MM-DD 格式');
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (date.toISOString().slice(0, 10) !== value) throw new Error(`无效日期：${value}`);
  return value;
}

export function extractWikiTargets(value: string, names?: WikiNames): string[] {
  return extractMarkdownWikiLinks(value).map(raw => parseWikiLinkTarget(raw, names)).filter(Boolean);
}

/**
 * 项目—知识点关系只由项目正文中的 [[wiki 链接]] 建立。
 * 本函数不创建知识点、不修改 parentId，也不维护隐藏关联表。
 */
export function appendProjectStudyTasks(
  notes: NoteItem[],
  input: AgentProjectStudyTasksInput,
  now = new Date().toISOString(),
): ProjectStudyTasksResult {
  const projectTitle = requireText(input.projectTitle, '项目笔记标题');
  const project = resolveNoteByTitleOrAlias(projectTitle, notes.filter((note) => note.noteType === 'project'));
  if (!project) throw new Error(`未找到项目笔记：${projectTitle}`);
  if (!isLeafProjectNote(project.id, notes)) {
    const childTitles = getChildProjectNotes(project.id, notes).map((note) => note.title);
    throw new Error(`只有末级项目可以生成正文学习任务；“${project.title}”的学习任务由子项目表示：${childTitles.join('、')}`);
  }
  if (!Array.isArray(input.tasks) || input.tasks.length < 1 || input.tasks.length > 7) {
    throw new Error('一次必须提交 1 至 7 条学习任务');
  }

  const knowledgeNotes = notes.filter((note) => note.noteType === 'knowledge');
  const linkedKnowledge = new Map<string, string>();
  const seenLines = new Set(project.content.split('\n').map((line) => line.trim().toLocaleLowerCase()));
  const taskLines = input.tasks.map((rawTask, index) => {
    const task = requireText(String(rawTask || '').replace(/^[-*]\s*(?:\[[ xX]\])?\s*/, ''), `第 ${index + 1} 条任务`);
    if (task.length > 300) throw new Error(`第 ${index + 1} 条任务过长`);
    const targets = extractWikiTargets(task, notes);
    if (targets.length === 0) throw new Error(`第 ${index + 1} 条任务没有 [[知识点]] 链接`);
    for (const target of targets) {
      const knowledge = resolveNoteByTitleOrAlias(target, knowledgeNotes);
      if (!knowledge) throw new Error(`知识点笔记不存在：${target}`);
      linkedKnowledge.set(knowledge.id, knowledge.title);
    }
    const line = `- [ ] ${task}`;
    const normalizedLine = line.toLocaleLowerCase();
    if (seenLines.has(normalizedLine)) throw new Error(`项目中已存在相同任务：${task}`);
    seenLines.add(normalizedLine);
    return line;
  });

  const content = project.content.trim()
    ? `${taskLines.join('\n')}\n\n${project.content}`
    : taskLines.join('\n');
  const changedNote = { ...project, content, generatedContentBlocks: rememberGeneratedContent(project, taskLines.join('\n')), updatedAt: now };
  return {
    notes: notes.map((note) => note.id === project.id ? changedNote : note),
    changedNote,
    summary: {
      projectNoteId: project.id,
      projectTitle: project.title,
      taskCount: taskLines.length,
      linkedKnowledgeTitles: [...linkedKnowledge.values()],
    },
  };
}

/**
 * 在一个批次内先校验全部末级项目、任务和缺失知识点，再一次性返回新状态。
 * 调用方只在本函数成功后落盘，因此单批不会产生部分写入。
 */
export function appendProjectStudyTaskBatch(
  notes: NoteItem[],
  input: AgentProjectStudyTaskBatchInput,
  now = new Date().toISOString(),
  idFactory?: () => string,
): ProjectStudyTaskBatchResult {
  const rootTitle = requireText(input.rootProjectTitle, '根项目标题');
  const projectNotes = notes.filter((note) => note.noteType === 'project');
  const root = resolveNoteByTitleOrAlias(rootTitle, projectNotes);
  if (!root) throw new Error(`未找到根项目：${rootTitle}`);
  if (!Array.isArray(input.projects) || input.projects.length < 1 || input.projects.length > 5) {
    throw new Error('一个批次必须包含 1 至 5 个末级项目');
  }
  if (!Array.isArray(input.createKnowledgeNotes) || input.createKnowledgeNotes.length > 30) {
    throw new Error('待创建知识点必须是数组，且一次不超过 30 个');
  }

  const allowedLeafIds = new Set(getLeafProjectNotesInScope(root.id, notes).map((note) => note.id));
  const seenProjectIds = new Set<string>();
  for (const item of input.projects) {
    const title = requireText(String(item?.projectTitle || ''), '末级项目标题');
    const project = resolveNoteByTitleOrAlias(title, projectNotes);
    if (!project || !allowedLeafIds.has(project.id)) throw new Error(`项目不属于“${root.title}”下的末级项目：${title}`);
    if (seenProjectIds.has(project.id)) throw new Error(`批次中存在重复项目：${project.title}`);
    seenProjectIds.add(project.id);
  }

  const knowledgeNotes = notes.filter((note) => note.noteType === 'knowledge');
  const declaredMissing = new Map<string, string>();
  for (const rawTitle of input.createKnowledgeNotes) {
    const title = requireText(String(rawTitle || ''), '待创建知识点标题');
    if (title.length > 120 || /\[\[|\]\]/.test(title)) throw new Error(`无效的知识点标题：${title}`);
    const key = title.toLocaleLowerCase();
    if (declaredMissing.has(key)) throw new Error(`重复声明待创建知识点：${title}`);
    const matches = findNotesByTitleOrAlias(title, notes);
    if (matches.length > 1) throw new Error(`知识点名称与多篇现有笔记冲突：${title}`);
    const existing = matches[0];
    if (existing) {
      if (existing.noteType === 'knowledge') throw new Error(`知识点已经存在，无需创建：${title}`);
      throw new Error(`知识点标题与现有项目冲突：${title}`);
    }
    declaredMissing.set(key, title);
  }

  const referencedMissing = new Set<string>();
  for (const item of input.projects) {
    if (!Array.isArray(item.tasks)) throw new Error(`项目“${item.projectTitle}”的 tasks 必须是数组`);
    for (const rawTask of item.tasks) {
      for (const target of extractWikiTargets(String(rawTask || ''), name => findNotesByTitleOrAlias(name, notes).length > 0 || declaredMissing.has(name.toLocaleLowerCase()))) {
        if (resolveNoteByTitleOrAlias(target, knowledgeNotes)) continue;
        const key = target.toLocaleLowerCase();
        if (!declaredMissing.has(key)) throw new Error(`知识点笔记不存在且未声明创建：${target}`);
        referencedMissing.add(key);
      }
    }
  }
  for (const [key, title] of declaredMissing) {
    if (!referencedMissing.has(key)) throw new Error(`待创建知识点未被任何任务引用：${title}`);
  }

  let sequence = 0;
  const nextId = idFactory || (() => `note-${Date.now()}-knowledge-${++sequence}-${Math.random().toString(36).slice(2, 8)}`);
  const createdKnowledgeNotes = [...declaredMissing.values()].map((title): NoteItem => {
    const id = nextId();
    if (!id || notes.some((note) => note.id === id)) throw new Error('生成了重复的知识点笔记 ID');
    return {
      id,
      title,
      content: '请对该知识点进行定义描述',
      noteType: 'knowledge',
      tags: ['学习计划'],
      links: [],
      backlinks: [],
      dueDates: [],
      createdAt: now,
      updatedAt: now,
    };
  });
  if (new Set(createdKnowledgeNotes.map((note) => note.id)).size !== createdKnowledgeNotes.length) {
    throw new Error('生成了重复的知识点笔记 ID');
  }

  let workingNotes = [...createdKnowledgeNotes, ...notes];
  const changedProjectNotes: NoteItem[] = [];
  const linkedKnowledgeTitles = new Set<string>();
  let taskCount = 0;
  for (const item of input.projects) {
    const mutation = appendProjectStudyTasks(workingNotes, item, now);
    workingNotes = mutation.notes;
    changedProjectNotes.push(mutation.changedNote);
    mutation.summary.linkedKnowledgeTitles.forEach((title) => linkedKnowledgeTitles.add(title));
    taskCount += mutation.summary.taskCount;
  }

  return {
    notes: workingNotes,
    changedProjectNotes,
    createdKnowledgeNotes,
    summary: {
      rootProjectTitle: root.title,
      projectCount: changedProjectNotes.length,
      taskCount,
      createdKnowledgeTitles: createdKnowledgeNotes.map((note) => note.title),
      linkedKnowledgeTitles: [...linkedKnowledgeTitles],
    },
  };
}

/** 先完整校验并构造项目树，调用方随后一次性落盘，避免部分节点创建成功。 */
export function buildProjectPlanNotes(
  notes: NoteItem[],
  root: AgentProjectPlanNode,
  now = new Date().toISOString(),
  idFactory?: () => string,
  planMeta?: Partial<PlanMeta>,
): ProjectPlanBuildResult {
  assertPlanStructureGranularity(root);
  let sequence = 0;
  const nextId = idFactory || (() => `note-${Date.now()}-${++sequence}-${Math.random().toString(36).slice(2, 8)}`);
  const existingTitles = new Set(notes.map((note) => note.title.trim().toLocaleLowerCase()));
  const planTitles = new Set<string>();
  const projectIds = new Map<string, string>();
  const taskIds = new Map<string, string>();
  let nodeCount = 0;
  const configuredPlanStart = planMeta?.startDate ? requireDate(planMeta.startDate) : undefined;
  const configuredPlanTarget = planMeta?.targetDate ? requireDate(planMeta.targetDate) : undefined;
  if (planMeta?.dailyStudyMinutes !== undefined && (!Number.isInteger(planMeta.dailyStudyMinutes) || planMeta.dailyStudyMinutes < 5 || planMeta.dailyStudyMinutes > 1440)) throw new Error('计划每日投入须为 5–1440 分钟整数');
  if (configuredPlanStart && configuredPlanTarget && configuredPlanStart > configuredPlanTarget) {
    throw new Error('计划开始日期不能晚于目标日期');
  }

  const normalizeTask = (
    task: PlanTaskBlueprint,
    nodeKey: string,
    index: number,
    range: { startDate?: string; dueDate?: string },
  ): PlanTaskBlueprint => {
    const key = requireText(String(task.key || `task-${nodeKey}-${index + 1}`), '执行事项 key');
    if (taskIds.has(key)) throw new Error(`执行事项 key 重复：${key}`);
    const text = requireText(String(task.text || ''), '执行事项名称');
    const dueDate = requireDate(task.dueDate);
    const startDate = task.startDate ? requireDate(task.startDate) : dueDate;
    if (startDate > dueDate) throw new Error(`执行事项“${text}”的开始日期不能晚于结束日期`);
    if (range.startDate && startDate < range.startDate) throw new Error(`执行事项“${text}”早于所属项目或计划开始日期`);
    if (range.dueDate && dueDate > range.dueDate) throw new Error(`执行事项“${text}”晚于所属项目或计划结束日期`);
    const estimatedMinutes = Number(task.estimatedMinutes);
    if (!Number.isFinite(estimatedMinutes) || estimatedMinutes < 1 || estimatedMinutes > 1440) {
      throw new Error(`执行事项“${text}”的预计时长无效`);
    }
    if (task.recurrence?.weekdays?.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
      throw new Error(`执行事项“${text}”的重复星期无效`);
    }
    const id = createPlanTaskId(projectIds.get(nodeKey)!, Date.now() + taskIds.size);
    taskIds.set(key, id);
    return { ...task, key, text, startDate, dueDate, estimatedMinutes, source: task.source || 'llm' };
  };

  const visit = (
    input: AgentProjectPlanNode,
    parentRange?: { startDate?: string; dueDate?: string },
  ): PlanNode => {
    nodeCount += 1;
    if (nodeCount > 60) throw new Error('项目计划一次最多创建 60 个节点');
    const title = requireText(String(input?.title || ''), '计划节点标题');
    if (input.estimatedMinutes !== undefined && (!Number.isInteger(input.estimatedMinutes) || input.estimatedMinutes < 5 || input.estimatedMinutes > 1440)) throw new Error('叶子项目时长须为 5–1440 分钟整数');
    if (title.length > 120) throw new Error(`计划节点标题过长：${title.slice(0, 20)}…`);
    const normalizedTitle = title.toLocaleLowerCase();
    if (existingTitles.has(normalizedTitle) || planTitles.has(normalizedTitle)) throw new Error(`项目标题与现有或草案笔记冲突：${title}`);
    planTitles.add(normalizedTitle);
    const priority = input.priority || 'medium';
    if (!['high', 'medium', 'low'].includes(priority)) throw new Error(`不支持的优先级：${String(priority)}`);
    const dueDate = input.dueDate ? requireDate(input.dueDate) : undefined;
    const startDate = input.startDate ? requireDate(input.startDate) : undefined;
    if (startDate && dueDate && startDate > dueDate) throw new Error(`项目“${title}”的开始日期不能晚于结束日期`);
    if (configuredPlanStart && startDate && startDate < configuredPlanStart) {
      throw new Error(`项目“${title}”早于计划开始日期 ${configuredPlanStart}`);
    }
    if (configuredPlanStart && dueDate && dueDate < configuredPlanStart) {
      throw new Error(`项目“${title}”结束日期早于计划开始日期 ${configuredPlanStart}`);
    }
    if (configuredPlanTarget && dueDate && dueDate > configuredPlanTarget) {
      throw new Error(`项目“${title}”晚于计划目标日期 ${configuredPlanTarget}`);
    }
    if (parentRange?.startDate && startDate && startDate < parentRange.startDate) {
      throw new Error(`子项目“${title}”的开始日期不能早于父项目`);
    }
    if (parentRange?.dueDate && dueDate && dueDate > parentRange.dueDate) {
      throw new Error(`子项目“${title}”的结束日期不能晚于父项目`);
    }
    const children = input.children === undefined ? [] : input.children;
    if (!Array.isArray(children)) throw new Error(`计划节点“${title}”的 children 必须是数组`);
    const key = requireText(String(input.key || `project-${nodeCount}`), '项目 key');
    if (projectIds.has(key)) throw new Error(`项目 key 重复：${key}`);
    const id = nextId();
    if (!id || notes.some((note) => note.id === id) || [...projectIds.values()].includes(id)) {
      throw new Error('生成了重复的计划节点 ID');
    }
    projectIds.set(key, id);
    const milestone = input.milestone ? {
      id: requireText(input.milestone.id, '里程碑 id'),
      title: requireText(input.milestone.title, '里程碑标题'),
      dueDate: requireDate(input.milestone.dueDate),
      description: input.milestone.description?.trim() || undefined,
    } : undefined;
    if (milestone && startDate && milestone.dueDate < startDate) throw new Error(`里程碑“${milestone.title}”早于所属项目开始日期`);
    if (milestone && dueDate && milestone.dueDate > dueDate) throw new Error(`里程碑“${milestone.title}”晚于所属项目结束日期`);
    if (milestone && configuredPlanStart && milestone.dueDate < configuredPlanStart) throw new Error(`里程碑“${milestone.title}”早于计划开始日期`);
    if (milestone && configuredPlanTarget && milestone.dueDate > configuredPlanTarget) throw new Error(`里程碑“${milestone.title}”晚于计划目标日期`);
    return {
      key,
      title,
      startDate,
      dueDate,
      priority,
      outcome: input.outcome?.trim() || undefined,
      estimatedMinutes: input.estimatedMinutes,
      milestone,
      tasks: [],
      children: children.map((child) => visit(child, {
        startDate: startDate || parentRange?.startDate,
        dueDate: dueDate || parentRange?.dueDate,
      })),
    };
  };

  const tree = [visit(root)];
  const inputByKey = new Map<string, AgentProjectPlanNode>();
  const collectInputs = (input: AgentProjectPlanNode, normalized: PlanNode) => {
    inputByKey.set(normalized.key, input);
    (input.children || []).forEach((child, index) => collectInputs(child, normalized.children[index]));
  };
  collectInputs(root, tree[0]);
  const hydrateTasks = (
    node: PlanNode,
    parentRange: { startDate?: string; dueDate?: string } = { startDate: configuredPlanStart, dueDate: configuredPlanTarget },
  ): PlanNode => {
    const range = {
      startDate: node.startDate || parentRange.startDate,
      dueDate: node.dueDate || parentRange.dueDate,
    };
    return {
      ...node,
      tasks: (inputByKey.get(node.key)?.tasks || []).map((task, index) => normalizeTask(task, node.key, index, range)),
      children: node.children.map((child) => hydrateTasks(child, range)),
    };
  };
  const hydratedTree = tree.map((node) => hydrateTasks(node));
  const allNodes: PlanNode[] = [];
  const collectNodes = (nodes: PlanNode[]) => nodes.forEach((node) => { allNodes.push(node); collectNodes(node.children); });
  collectNodes(hydratedTree);

  const allTasks = allNodes.flatMap((node) => node.tasks || []);
  for (const task of allTasks) {
    for (const dependency of task.dependencyKeys || []) {
      if (!taskIds.has(dependency)) throw new Error(`执行事项“${task.text}”引用了不存在的前置任务：${dependency}`);
      if (dependency === task.key) throw new Error(`执行事项“${task.text}”不能依赖自己`);
    }
    if (task.linkedProjectKey && !projectIds.has(task.linkedProjectKey)) {
      throw new Error(`执行事项“${task.text}”引用了不存在的项目：${task.linkedProjectKey}`);
    }
  }
  const dependencyMap = new Map(allTasks.map((task) => [task.key, task.dependencyKeys || []]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const assertAcyclic = (key: string) => {
    if (visiting.has(key)) throw new Error('执行事项的前置依赖不能形成循环');
    if (visited.has(key)) return;
    visiting.add(key);
    (dependencyMap.get(key) || []).forEach(assertAcyclic);
    visiting.delete(key);
    visited.add(key);
  };
  [...dependencyMap.keys()].forEach(assertAcyclic);

  const derivedMilestones = allNodes.flatMap((node) => node.milestone ? [{
    id: node.milestone.id,
    title: node.milestone.title,
    dueDate: node.milestone.dueDate,
    criteria: node.milestone.description ? [node.milestone.description] : undefined,
    projectId: projectIds.get(node.key),
    completed: false,
  }] : []);
  const configuredMilestones = (planMeta?.milestones || []).map((milestone) => ({
    ...milestone,
    id: requireText(milestone.id, '里程碑 id'),
    title: requireText(milestone.title, '里程碑标题'),
    dueDate: requireDate(milestone.dueDate),
    projectId: milestone.projectId && projectIds.has(milestone.projectId) ? projectIds.get(milestone.projectId) : milestone.projectId,
    completed: false,
    completedAt: undefined,
  }));
  configuredMilestones.forEach((milestone) => {
    if (configuredPlanStart && milestone.dueDate < configuredPlanStart) throw new Error(`里程碑“${milestone.title}”早于计划开始日期`);
    if (configuredPlanTarget && milestone.dueDate > configuredPlanTarget) throw new Error(`里程碑“${milestone.title}”晚于计划目标日期`);
  });
  const milestoneIds = new Set<string>();
  [...configuredMilestones, ...derivedMilestones].forEach((milestone) => {
    if (milestoneIds.has(milestone.id)) throw new Error(`里程碑 id 重复：${milestone.id}`);
    milestoneIds.add(milestone.id);
  });
  allTasks.forEach((task) => {
    if (task.milestoneId && !milestoneIds.has(task.milestoneId)) {
      throw new Error(`执行事项“${task.text}”引用了不存在的里程碑：${task.milestoneId}`);
    }
  });

  const rootNode = hydratedTree[0];
  const rootId = projectIds.get(rootNode.key)!;
  const directPhases = rootNode.children.flatMap((node) => node.startDate && node.dueDate ? [{
    projectId: projectIds.get(node.key)!, startDate: node.startDate, endDate: node.dueDate,
    outcome: node.outcome,
  }] : []);
  const rootPlanMeta: PlanMeta = {
    schemaVersion: 2,
    status: planMeta?.status || 'active',
    shortTitle: planMeta?.shortTitle || rootNode.title,
    summary: planMeta?.summary || rootNode.outcome || `围绕“${rootNode.title}”形成可验证的阶段成果。`,
    startDate: configuredPlanStart || rootNode.startDate || homeLocalDate(new Date(now)),
    targetDate: configuredPlanTarget || rootNode.dueDate,
    weeklyBudgetMinutes: planMeta?.weeklyBudgetMinutes,
    dailyStudyMinutes: planMeta?.dailyStudyMinutes,
    activeWeekdays: planMeta?.activeWeekdays?.length ? planMeta.activeWeekdays : [1, 2, 3, 4, 5, 6],
    portfolioPriority: planMeta?.portfolioPriority || rootNode.priority || 'medium',
    autoAdjustPolicy: planMeta?.autoAdjustPolicy || 'ask',
    conditions: planMeta?.conditions,
    research: planMeta?.research ? structuredClone(planMeta.research) : undefined,
    phaseWindows: planMeta?.phaseWindows?.length ? planMeta.phaseWindows.map((phase) => ({
      ...phase,
      projectId: projectIds.get(phase.projectId) || phase.projectId,
    })) : directPhases,
    milestones: [...configuredMilestones, ...derivedMilestones],
    updatedAt: now,
  };

  const createdNotes: NoteItem[] = [];
  const buildNotes = (nodes: PlanNode[], parentId?: string) => nodes.forEach((node) => {
    const id = projectIds.get(node.key)!;
    const dueDates: DueDateItem[] = [];
    if (node.dueDate) dueDates.push({
      id: `due-${id}-0`, noteId: id, noteTitle: node.title, taskText: node.title,
      startDate: node.startDate, dueDate: node.dueDate, completed: false,
      estimatedMinutes: node.estimatedMinutes,
      priority: node.priority || 'medium', source: 'llm',
    });
    const taskLines = (node.tasks || []).map((task, order) => {
      const taskId = taskIds.get(task.key)!;
      dueDates.push({
        id: taskId, noteId: id, noteTitle: node.title, taskText: task.text,
        kind: task.kind, startDate: task.startDate, dueDate: task.dueDate,
        estimatedMinutes: task.estimatedMinutes,
        capacityKind: task.capacityKind,
        dependencyTaskIds: (task.dependencyKeys || []).map((key) => taskIds.get(key)!),
        milestoneId: task.milestoneId, executionKind: task.executionKind, recurrence: task.recurrence,
        linkedProjectId: task.linkedProjectKey ? projectIds.get(task.linkedProjectKey) : undefined,
        linkedKnowledgeIds: task.linkedKnowledgeIds, launchMode: task.launchMode,
        reminderMinutes: task.reminderMinutes, order, completed: false,
        priority: task.priority || 'medium', source: task.source || 'llm',
      });
      return formatPlanTaskLine(task.text, task.dueDate, taskId);
    });
    createdNotes.push({
      id, title: node.title, content: taskLines.join('\n'), noteType: 'project', parentId,
      tags: ['学习计划'], links: [], backlinks: [], dueDates,
      planMeta: id === rootId ? rootPlanMeta : undefined,
      planOutcome: node.outcome,
      createdAt: now, updatedAt: now,
    });
    buildNotes(node.children, id);
  });
  buildNotes(hydratedTree);

  return {
    notes: [...createdNotes, ...notes],
    createdNotes,
    tree: hydratedTree,
    summary: {
      rootNoteId: rootId,
      rootTitle: rootNode.title,
      nodeCount,
      scheduledCount: allNodes.filter((node) => Boolean(node.dueDate)).length,
      milestoneCount: rootPlanMeta.milestones?.length || 0,
      executionTaskCount: allTasks.length,
    },
  };
}

function replaceTaskDateInContent(note: NoteItem, taskId: string, taskText: string, dueDate: string): string {
  const lines = note.content.split('\n');
  const indexMatch = taskId.match(/-(\d+)$/);
  const candidate = indexMatch ? Number(indexMatch[1]) : -1;
  const matchesTask = (line: string) => line.toLocaleLowerCase().includes(taskText.toLocaleLowerCase()) && /@due\([^)]+\)/i.test(line);
  const lineIndex = candidate >= 0 && candidate < lines.length && matchesTask(lines[candidate])
    ? candidate
    : lines.findIndex(matchesTask);
  if (lineIndex >= 0) lines[lineIndex] = lines[lineIndex].replace(/@due\([^)]+\)/i, `@due(${dueDate})`);
  return lines.join('\n');
}

/** Agent 和界面共用的计划任务变更规则；只做纯数据变换，落盘由调用方负责。 */
export function applyPlanTaskChange(
  notes: NoteItem[],
  change: AgentPlanTaskChange,
  now = new Date().toISOString(),
): PlanTaskMutationResult {
  const noteTitle = requireText(change.noteTitle, '笔记标题');
  const taskText = requireText(change.taskText, '任务名称');
  const note = resolveNoteByTitleOrAlias(noteTitle, notes);
  if (!note) throw new Error(`未找到笔记：${noteTitle}`);
  if (isReferenceProject(note)) throw new Error('资料型项目不接受计划任务属性；本入口不支持隐式转换为学习项目');

  const normalizedTask = taskText.toLocaleLowerCase();
  const matches = (note.dueDates || []).filter((item) => item.taskText.trim().toLocaleLowerCase() === normalizedTask);
  if (change.operation !== 'add' && matches.length === 0) throw new Error(`笔记“${note.title}”中未找到任务：${taskText}`);
  if (matches.length > 1) throw new Error(`笔记“${note.title}”中存在多个同名任务，请先在笔记中区分名称`);
  if (change.operation === 'add' && matches.length > 0) throw new Error(`任务已存在：${taskText}`);

  let content = note.content;
  let dueDates = [...(note.dueDates || [])];
  if (change.operation === 'add') {
    const dueDate = requireDate(change.dueDate);
    const lines = content ? content.split('\n') : [];
    const taskId = createPlanTaskId(note.id);
    lines.push(formatPlanTaskLine(taskText, dueDate, taskId));
    content = lines.join('\n');
    dueDates.push({
      id: taskId,
      noteId: note.id,
      noteTitle: note.title,
      taskText,
      dueDate,
      completed: false,
      priority: change.priority || 'medium',
      kind: 'learn',
      startDate: dueDate,
      estimatedMinutes: 60,
      source: 'manual',
    });
  } else if (change.operation === 'reschedule') {
    const dueDate = requireDate(change.dueDate);
    const target = matches[0];
    content = replaceTaskDateInContent(note, target.id, target.taskText, dueDate);
    dueDates = dueDates.map((item) => item.id === target.id ? {
      ...item,
      dueDate,
      originalDueDate: item.originalDueDate || item.dueDate,
      autoAdjustedAt: now,
      autoAdjustmentReason: '用户通过 Agent 确认调整日期',
    } : item);
  } else {
    if (!change.priority) throw new Error('调整优先级时必须提供 priority');
    const target = matches[0];
    dueDates = dueDates.map((item) => item.id === target.id ? { ...item, priority: change.priority! } : item);
  }

  const changedNote = { ...note, content, dueDates, updatedAt: now };
  const finalTask = dueDates.find((item) => item.taskText.trim().toLocaleLowerCase() === normalizedTask)!;
  return {
    notes: notes.map((item) => item.id === note.id ? changedNote : item),
    changedNote,
    summary: {
      operation: change.operation,
      noteId: note.id,
      noteTitle: note.title,
      taskText: finalTask.taskText,
      dueDate: finalTask.dueDate,
      priority: finalTask.priority,
    },
  };
}

function dateToDay(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const time = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(time) ? null : Math.floor(time / 86400000);
}

function dayToDate(day: number): string {
  return new Date(day * 86400000).toISOString().slice(0, 10);
}

function addDays(value: string, days: number): string {
  const start = dateToDay(value);
  return start === null ? value : dayToDate(start + days);
}

function findRootProjectId(noteId: string, notes: NoteItem[]): string | null {
  const noteById = new Map(notes.map((note) => [note.id, note]));
  let current = noteById.get(noteId);
  const visited = new Set<string>();
  while (current?.parentId && !visited.has(current.id)) {
    visited.add(current.id);
    const parent = noteById.get(current.parentId);
    if (!parent) break;
    current = parent;
  }
  return current?.noteType === 'project' ? current.id : null;
}

/**
 * 对一次项目笔记更新做保守的本地重排：延期只顺延同一项目的未完成任务。
 * 复习排期由 reviewScheduler 派生，不写入普通 dueDates。
 * ponytail: 暂不自动压缩提前完成的日程，避免制造过载。
 */
export function adjustPlanAfterNoteUpdate(
  notes: NoteItem[],
  previous: NoteItem | undefined,
  updated: NoteItem,
  now = new Date().toISOString(),
): PlanAdjustmentResult {
  const today = homeLocalDate(new Date(now));
  let result = notes;
  const changed = new Set<string>();
  const reasons: string[] = [];

  if (previous && updated.noteType === 'project') {
    const previousTasks = new Map(previous.dueDates.map((item) => [item.id, item]));
    const newlyCompleted = updated.dueDates.find((item) => (
      item.completed
      && !previousTasks.get(item.id)?.completed
      && !item.completionAdjustmentAppliedAt
    ));
    const completedDueDay = newlyCompleted ? dateToDay(newlyCompleted.dueDate) : null;
    const completionDay = dateToDay(newlyCompleted?.completedAt ? homeLocalDate(new Date(newlyCompleted.completedAt)) : today);
    const delayDays = completedDueDay === null || completionDay === null ? 0 : Math.min(14, Math.max(0, completionDay - completedDueDay));
    const rootId = delayDays > 0 ? findRootProjectId(updated.id, result) : null;

    if (rootId) {
      const reason = `任务延期完成，后续任务顺延 ${delayDays} 天`;
      result = result.map((note) => {
        if (findRootProjectId(note.id, result) !== rootId) return note;
        let touched = false;
        const dueDates = note.dueDates.map((item) => {
          if (note.id === updated.id && item.id === newlyCompleted?.id) {
            touched = true;
            return { ...item, completionAdjustmentAppliedAt: now };
          }
          if (note.id === rootId || item.completed) return item;
          touched = true;
          return {
            ...item,
            originalDueDate: item.originalDueDate || item.dueDate,
            dueDate: addDays(item.dueDate, delayDays),
            autoAdjustedAt: now,
            autoAdjustmentReason: reason,
          };
        });
        if (!touched) return note;
        changed.add(note.id);
        return { ...note, dueDates, updatedAt: now };
      });
      reasons.push(reason);
    }
  }

  return { notes: result, changedNoteIds: [...changed], reasons };
}
