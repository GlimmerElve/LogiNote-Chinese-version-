import type { DueDateItem, NoteItem, PlanMeta, PlanMilestone, PlanNode, PlanProjectCandidate, PlanTaskBlueprint } from '../types';
import { isLearningProject } from './projectRole';
import { mergePreparationResources, plannedPreparationDocuments } from './progressiveLearning/preparation';
import type {
  AgentPlanExecutionPatch,
  AgentPlanMetaPatch,
  AgentPlanMilestonePatch,
  AgentProjectStructurePatch,
} from './agent/types';
import {
  buildPlanDraftMutation,
  createPlanDraftSession,
  type PlanDraftMutationResult,
} from './agent/planDraftService';
import { assertPlanStructureGranularity } from './planStructureGranularity';
import { getScheduledProjectDeadline } from './planProjectState';
import { validStudyMinutes, prepareLearningCapacityPatch } from './learningCapacity';
import { executionRepeats } from './planExecutionDates';

export interface PublishedPlanEditorValue {
  rootId: string;
  tree: [PlanNode];
  planMeta: Partial<PlanMeta>;
  projectCatalog: PlanProjectCandidate[];
  /** Ephemeral editor origin; never copied into project-note data. */
  agentEditorDraftId?: string;
}

export type PublishedPlanStructureAddInput =
  | {
    mode: 'existing';
    rootId: string;
    projectId: string;
    startDate: string;
    dueDate: string;
    priority: 'high' | 'medium' | 'low';
  }
  | {
    mode: 'new';
    rootId: string;
    parentId: string;
    title: string;
    startDate: string;
    dueDate: string;
    priority: 'high' | 'medium' | 'low';
  };

interface FlatNode {
  node: PlanNode;
  parentKey?: string;
}

function projectDeadline(note: NoteItem): DueDateItem | undefined {
  return note.dueDates.find((item) => item.id === `due-${note.id}-0` || item.taskText.trim() === note.title.trim());
}

function flatten(nodes: PlanNode[], parentKey?: string): FlatNode[] {
  return nodes.flatMap((node) => [{ node, parentKey }, ...flatten(node.children || [], node.key)]);
}

/**
 * Adds one structural block to a published plan through the same draft adapter
 * used by the full editor. Existing notes keep their identity and hierarchy;
 * new blocks become project notes only after the mutation is committed.
 */
export function addPublishedPlanStructureItem(
  notes: NoteItem[],
  input: PublishedPlanStructureAddInput,
  now = new Date().toISOString(),
): PlanDraftMutationResult {
  const editor = buildPublishedPlanEditorValue(notes, input.rootId);
  if (!editor) throw new Error('找不到要添加任务的根项目');
  if (!input.startDate || !input.dueDate || input.dueDate < input.startDate) {
    throw new Error('项目的结束日期不能早于开始日期');
  }

  const tree = structuredClone(editor.tree);
  const root = tree[0];
  const scheduled = flatten(tree);
  const scheduledById = new Map(scheduled.map(({ node }) => [node.key, node]));
  const parentById = new Map(scheduled.map(({ node, parentKey }) => [node.key, parentKey]));

  const appendToParent = (parentId: string, node: PlanNode) => {
    const parent = scheduledById.get(parentId);
    if (!parent) throw new Error('请先把父项目加入结构轨道');
    const parentStart = parent.startDate;
    const parentEnd = parent.dueDate;
    if ((parentStart && input.startDate < parentStart) || (parentEnd && input.dueDate > parentEnd)) {
      throw new Error(`子项目时限必须位于父项目“${parent.title}”的时间范围内`);
    }
    parent.children = [...(parent.children || []), node];
  };

  if (input.mode === 'existing') {
    if (scheduledById.has(input.projectId)) throw new Error('该项目已经在结构轨道中');
    const candidate = editor.projectCatalog.find((project) => project.key === input.projectId);
    if (!candidate) throw new Error('找不到要排期的已有项目');
    const parentId = candidate.parentKey || root.key;
    if (parentId !== root.key && !scheduledById.has(parentId)) {
      throw new Error('请先把该项目的父项目加入结构轨道');
    }
    appendToParent(parentId, {
      key: candidate.key,
      title: candidate.title,
      startDate: input.startDate,
      dueDate: input.dueDate,
      priority: input.priority,
      children: [],
    });
  } else {
    const title = input.title.trim();
    if (!title) throw new Error('请输入项目名称');
    const scopeTitles = new Set([root.title.trim(), ...editor.projectCatalog.map((project) => project.title.trim())]);
    if (scopeTitles.has(title)) throw new Error(`项目“${title}”已经存在，请改用“已有项目排期”`);
    appendToParent(input.parentId, {
      key: `quick-project-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      title,
      startDate: input.startDate,
      dueDate: input.dueDate,
      priority: input.priority,
      children: [],
    });
  }

  // Keep the root relationship stable. This also protects against a malformed
  // caller trying to append a node outside the selected published plan.
  if (parentById.get(root.key)) throw new Error('根项目结构异常，无法添加任务');
  return replacePublishedPlanFromEditor(notes, input.rootId, tree, editor.planMeta, now);
}

function editableTask(task: DueDateItem, projectIds: Set<string>): boolean {
  return !projectIds.has(task.noteId) || task.id !== `due-${task.noteId}-0` && task.taskText.trim() !== task.noteTitle.trim();
}

function taskBlueprint(task: DueDateItem): PlanTaskBlueprint {
  return {
    key: task.id,
    text: task.taskText,
    kind: task.kind || 'learn',
    startDate: executionRepeats(task) ? task.startDate || task.dueDate : task.startDate,
    dueDate: executionRepeats(task) ? task.recurrence?.endDate || task.dueDate : task.dueDate,
    estimatedMinutes: task.estimatedMinutes || 60,
    capacityKind: task.capacityKind,
    priority: task.priority,
    dependencyKeys: task.dependencyTaskIds,
    milestoneId: task.milestoneId,
    source: task.source,
    executionKind: task.executionKind,
    recurrence: task.recurrence,
    linkedProjectKey: task.linkedProjectId,
    linkedKnowledgeIds: task.linkedKnowledgeIds,
    launchMode: task.launchMode,
    reminderMinutes: task.reminderMinutes,
    displayRow: task.order || 0,
  };
}

export function buildPublishedPlanEditorValue(notes: NoteItem[], rootId: string): PublishedPlanEditorValue | null {
  const root = notes.find((note) => note.id === rootId && isLearningProject(note));
  if (!root) return null;
  const projects = notes.filter(isLearningProject);
  const childrenByParent = new Map<string, NoteItem[]>();
  projects.forEach((project) => {
    if (!project.parentId) return;
    childrenByParent.set(project.parentId, [...(childrenByParent.get(project.parentId) || []), project]);
  });
  const scopeIds = new Set<string>();
  const collectIds = (id: string) => {
    if (scopeIds.has(id)) return;
    scopeIds.add(id);
    (childrenByParent.get(id) || []).forEach((child) => collectIds(child.id));
  };
  collectIds(root.id);
  const phaseByProject = new Map((root.planMeta?.phaseWindows || []).map((phase) => [phase.projectId, phase]));
  const toNode = (project: NoteItem): PlanNode | null => {
    const deadline = projectDeadline(project);
    const phase = phaseByProject.get(project.id);
    const children = (childrenByParent.get(project.id) || [])
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(toNode)
      .filter((node): node is PlanNode => Boolean(node));
    // Project notes without a time range are ordinary editable objects, not
    // plan blocks. Keep an undated ancestor only when it is needed to retain
    // the hierarchy of scheduled descendants. The selected root is always the
    // editor container even when the root itself has no deadline.
    if (project.id !== root.id && !deadline?.dueDate && !phase?.endDate && children.length === 0) return null;
    return {
      key: project.id,
      title: project.title,
      startDate: deadline?.startDate || phase?.startDate,
      dueDate: deadline?.dueDate || phase?.endDate,
      priority: deadline?.priority || 'medium',
      estimatedMinutes: deadline?.estimatedMinutes,
      outcome: project.planOutcome ?? phase?.outcome,
      children,
    };
  };
  const executionTasks = notes
    .filter((note) => scopeIds.has(note.id))
    .flatMap((note) => note.dueDates.filter((task) => editableTask(task, scopeIds)).map(taskBlueprint));
  const rootNode = toNode(root)!;
  rootNode.startDate ||= root.planMeta?.startDate;
  rootNode.dueDate ||= root.planMeta?.targetDate;
  rootNode.tasks = executionTasks;
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const pathFor = (project: NoteItem): string => {
    const titles = [project.title];
    let parent = project.parentId ? projectById.get(project.parentId) : undefined;
    const visited = new Set([project.id]);
    while (parent && scopeIds.has(parent.id) && !visited.has(parent.id)) {
      visited.add(parent.id);
      titles.unshift(parent.title);
      if (parent.id === root.id) break;
      parent = parent.parentId ? projectById.get(parent.parentId) : undefined;
    }
    return titles.join(' > ');
  };
  const depthFor = (project: NoteItem): number => {
    let depth = 0;
    let parent = project.parentId ? projectById.get(project.parentId) : undefined;
    const visited = new Set([project.id]);
    while (parent && parent.id !== root.id && !visited.has(parent.id)) {
      visited.add(parent.id);
      depth += 1;
      parent = parent.parentId ? projectById.get(parent.parentId) : undefined;
    }
    return depth;
  };
  const projectCatalog: PlanProjectCandidate[] = projects
    .filter((project) => scopeIds.has(project.id) && project.id !== root.id)
    .map((project) => {
      const deadline = projectDeadline(project);
      return {
        key: project.id,
        title: project.title,
        parentKey: project.parentId || root.id,
        path: pathFor(project),
        depth: depthFor(project),
        startDate: deadline?.startDate,
        dueDate: deadline?.dueDate,
        priority: deadline?.priority || 'medium' as const,
        childCount: (childrenByParent.get(project.id) || []).length,
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'));
  return {
    rootId,
    tree: [rootNode],
    projectCatalog,
    planMeta: root.planMeta ? structuredClone(root.planMeta) : {
      schemaVersion: 2,
      status: 'active',
      shortTitle: root.title,
      startDate: rootNode.startDate,
      targetDate: rootNode.dueDate,
      weeklyBudgetMinutes: 600,
      activeWeekdays: [1, 2, 3, 4, 5, 6],
      milestones: [],
    },
  };
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function buildStructurePatches(
  initial: PlanNode,
  final: PlanNode,
  projectCatalog: PlanProjectCandidate[],
): { patches: AgentProjectStructurePatch[]; removedFromPlanIds: Set<string> } {
  const before = flatten([initial]);
  const after = flatten([final]);
  const beforeById = new Map(before.map((item) => [item.node.key, item]));
  const availableById = new Map(projectCatalog.map((project) => [project.key, project]));
  const afterIds = new Set(after.map(({ node }) => node.key));
  const removedFromPlanIds = new Set(before
    .filter(({ node }) => node.key !== initial.key && !afterIds.has(node.key))
    .map(({ node }) => node.key));
  const patches: AgentProjectStructurePatch[] = [];

  // Existing nodes move before renames. Moves targeting a newly-created parent are staged after additions.
  const delayedMoves: AgentProjectStructurePatch[] = [];
  after.forEach(({ node, parentKey }) => {
    const previous = beforeById.get(node.key);
    if (!previous || node.key === initial.key || previous.parentKey === parentKey) return;
    const newParent = parentKey ? after.find((item) => item.node.key === parentKey)?.node : undefined;
    if (!newParent) return;
    const patch = { operation: 'move' as const, projectTitle: previous.node.title, newParentProjectTitle: newParent.title };
    if (beforeById.has(newParent.key)) patches.push(patch); else delayedMoves.push(patch);
  });

  after.forEach(({ node, parentKey }) => {
    if (beforeById.has(node.key)) return;
    const parent = parentKey ? after.find((item) => item.node.key === parentKey)?.node : undefined;
    if (!parent) throw new Error(`新增项目“${node.title}”缺少父项目`);
    const existing = availableById.get(node.key);
    if (existing) {
      if (existing.parentKey !== parent.key) throw new Error(`已有项目“${existing.title}”必须保留原有父子关系`);
      if (!node.dueDate) throw new Error(`已有项目“${existing.title}”加入轨道时必须设置结束日期`);
      patches.push({
        operation: 'update',
        projectTitle: existing.title,
        title: node.title !== existing.title ? node.title : undefined,
        startDate: node.startDate,
        dueDate: node.dueDate,
        priority: node.priority || existing.priority,
      });
      return;
    }
    patches.push({
      operation: 'add_child',
      parentProjectTitle: parent.title,
      title: node.title,
      startDate: node.startDate,
      dueDate: node.dueDate,
      priority: node.dueDate ? node.priority : undefined,
    });
  });
  patches.push(...delayedMoves);

  after.forEach(({ node }) => {
    const previous = beforeById.get(node.key)?.node;
    if (!previous) return;
    const patch: AgentProjectStructurePatch = { operation: 'update', projectTitle: previous.title };
    if (node.title !== previous.title) patch.title = node.title;
    if (node.dueDate !== previous.dueDate) {
      if (node.dueDate) patch.dueDate = node.dueDate;
      else patch.clearDueDate = true;
    }
    if (!patch.clearDueDate && node.startDate !== previous.startDate) {
      if (node.startDate) patch.startDate = node.startDate;
      else patch.clearStartDate = true;
    }
    if (!patch.clearDueDate && node.dueDate && node.priority !== previous.priority) patch.priority = node.priority;
    if (Object.keys(patch).length > 2) patches.push(patch);
  });

  // Removing a structure block from the published-plan editor is deliberately
  // non-destructive. The project note, content, hierarchy and other tasks stay
  // intact; only its project deadline is removed so it leaves the plan track.
  before.filter(({ node }) => removedFromPlanIds.has(node.key) && Boolean(node.dueDate)).forEach(({ node }) => {
    patches.push({ operation: 'update', projectTitle: node.title, clearDueDate: true });
  });
  return { patches, removedFromPlanIds };
}

function milestonePatches(
  before: PlanMilestone[],
  after: PlanMilestone[],
  finalNodes: Map<string, PlanNode>,
): AgentPlanMilestonePatch[] {
  const beforeById = new Map(before.map((item) => [item.id, item]));
  const afterById = new Map(after.map((item) => [item.id, item]));
  const patches: AgentPlanMilestonePatch[] = [];
  before.forEach((item) => {
    if (!afterById.has(item.id)) patches.push({ operation: 'delete', milestoneId: item.id });
  });
  after.forEach((item) => {
    const previous = beforeById.get(item.id);
    const projectTitle = item.projectId ? finalNodes.get(item.projectId)?.title : undefined;
    if (!previous) {
      patches.push({ operation: 'add', milestoneId: item.id, title: item.title, dueDate: item.dueDate, criteria: item.criteria, projectTitle });
      return;
    }
    const patch: AgentPlanMilestonePatch = { operation: 'update', milestoneId: item.id };
    if (item.title !== previous.title) patch.title = item.title;
    if (item.dueDate !== previous.dueDate) patch.dueDate = item.dueDate;
    if (!same(item.criteria, previous.criteria)) item.criteria?.length ? patch.criteria = item.criteria : patch.clearCriteria = true;
    if (projectTitle !== (previous.projectId ? finalNodes.get(previous.projectId)?.title : undefined)) {
      if (projectTitle) patch.projectTitle = projectTitle; else patch.clearProject = true;
    }
    if (Object.keys(patch).length > 2) patches.push(patch);
  });
  return patches;
}

function executionPatches(
  before: PlanTaskBlueprint[],
  after: PlanTaskBlueprint[],
  finalNodes: Map<string, PlanNode>,
  rootTitle: string,
): AgentPlanExecutionPatch[] {
  const beforeById = new Map(before.map((item) => [item.key, item]));
  const afterById = new Map(after.map((item) => [item.key, item]));
  const patches: AgentPlanExecutionPatch[] = [];
  before.forEach((item) => {
    if (!afterById.has(item.key)) patches.push({ operation: 'delete', taskId: item.key });
  });
  after.forEach((item) => {
    const previous = beforeById.get(item.key);
    const linkedProjectTitle = item.linkedProjectKey ? finalNodes.get(item.linkedProjectKey)?.title : undefined;
    const common: AgentPlanExecutionPatch = {
      operation: previous ? 'update' : 'add',
      taskId: item.key,
      noteTitle: previous ? undefined : rootTitle,
      taskText: item.text,
      kind: item.kind,
      executionKind: item.executionKind,
      startDate: item.startDate || item.dueDate,
      dueDate: item.dueDate,
      estimatedMinutes: item.estimatedMinutes,
      priority: item.priority,
      recurrence: item.recurrence,
      milestoneId: item.milestoneId,
      linkedProjectTitle,
      launchMode: item.launchMode,
      reminderMinutes: item.reminderMinutes,
      clearRecurrence: previous ? !item.recurrence : undefined,
      clearMilestone: previous ? !item.milestoneId : undefined,
      clearLinkedProject: previous ? !linkedProjectTitle : undefined,
    };
    if (!previous || !same({ ...previous, dependencyKeys: undefined, linkedKnowledgeIds: undefined, source: undefined, displayRow: undefined }, { ...item, dependencyKeys: undefined, linkedKnowledgeIds: undefined, source: undefined, displayRow: undefined })) patches.push(common);
  });
  return patches;
}

export function replacePublishedPlanFromEditor(
  notes: NoteItem[],
  rootId: string,
  tree: PlanNode[],
  planMeta: Partial<PlanMeta>,
  now = new Date().toISOString(),
): PlanDraftMutationResult {
  const initial = buildPublishedPlanEditorValue(notes, rootId);
  const finalRoot = tree[0];
  if (!initial || !finalRoot || finalRoot.key !== rootId) throw new Error('编辑草稿与已发布计划不匹配');
  assertPlanStructureGranularity(finalRoot);
  const initialRoot = initial.tree[0];
  const structure = buildStructurePatches(initialRoot, finalRoot, initial.projectCatalog);
  const finalFlat = flatten([finalRoot]);
  // References may continue to point at an existing project after that project
  // has been removed from the timeline. Retain the initial lookup entry so a
  // time-range removal never clears milestone/task associations as a side effect.
  const finalNodes = new Map([
    ...flatten([initialRoot]).map(({ node }) => [node.key, node] as const),
    ...initial.projectCatalog.map((project) => [project.key, {
      key: project.key,
      title: project.title,
      priority: project.priority,
      children: [],
    } satisfies PlanNode] as const),
    ...finalFlat.map(({ node }) => [node.key, node] as const),
  ]);
  const initialTasks = initialRoot.tasks || [];
  const finalTasks = finalRoot.tasks || [];
  const beforeMeta = initial.planMeta;
  const nextMeta = planMeta;
  const metaPatch: AgentPlanMetaPatch = {
    status: nextMeta.status || beforeMeta.status,
    shortTitle: nextMeta.shortTitle || finalRoot.title,
    summary: nextMeta.summary || beforeMeta.summary || `围绕“${finalRoot.title}”形成可验证的阶段成果。`,
    startDate: nextMeta.startDate || finalRoot.startDate,
    targetDate: nextMeta.targetDate || finalRoot.dueDate,
    weeklyBudgetMinutes: nextMeta.weeklyBudgetMinutes,
    dailyStudyMinutes: nextMeta.dailyStudyMinutes,
    activeWeekdays: nextMeta.activeWeekdays,
    portfolioPriority: nextMeta.portfolioPriority,
    autoAdjustPolicy: nextMeta.autoAdjustPolicy,
    conditions: nextMeta.conditions,
  };
  const milestones = milestonePatches(beforeMeta.milestones || [], nextMeta.milestones || [], finalNodes);
  const executions = executionPatches(initialTasks, finalTasks, finalNodes, finalRoot.title);
  let session = createPlanDraftSession(notes, { selectedProjectId: rootId, mode: 'revise-subtree', purpose: 'plan-layout' }, now);
  session = {
    ...session,
    structurePatches: structure.patches,
    planMetaPatch: metaPatch,
    milestonePatches: milestones,
    executionPatches: executions,
    updatedAt: now,
  };
  const built = buildPlanDraftMutation(notes, session, now);
  // Layout mutation may share untouched leaf objects with the original notes.
  // Never mutate those during effort-only edits before the durable writer accepts.
  const mutation = { ...built, notes: structuredClone(built.notes), changedProjectNotes: structuredClone(built.changedProjectNotes) };
  const initialNodes = new Map(flatten([initialRoot]).map(({ node }) => [node.key, node]));
  for (const { node } of finalFlat) {
    const beforeNode = initialNodes.get(node.key);
    if (beforeNode?.estimatedMinutes === node.estimatedMinutes) continue;
    const project = mutation.notes.find(n => n.id === node.key) || mutation.notes.find(n => n.noteType === 'project' && n.title === node.title && !notes.some(old => old.id === n.id));
    const deadline = project && getScheduledProjectDeadline(project);
    if (!deadline || node.children.length || deadline.completed) continue;
    if (node.estimatedMinutes !== undefined && !validStudyMinutes(node.estimatedMinutes)) throw new Error('叶子项目时长无效');
    deadline.estimatedMinutes = node.estimatedMinutes;
    project!.updatedAt = now;
    if (!mutation.changedProjectNotes.some(n => n.id === project!.id)) mutation.changedProjectNotes.push(project!);
  }
  for (const task of finalTasks) {
    if (initialTasks.find(t => t.key === task.key)?.capacityKind === task.capacityKind) continue;
    for (const project of mutation.notes) {
      const item = project.dueDates.find(d => d.id === task.key);
      if (item) {
        if (task.capacityKind !== undefined) prepareLearningCapacityPatch(mutation.notes, { executionEfforts: [{ noteId: project.id, taskId: item.id, capacityKind: task.capacityKind }] }, now);
        item.capacityKind = task.capacityKind; project.updatedAt = now;
        if (!mutation.changedProjectNotes.some(n => n.id === project.id)) mutation.changedProjectNotes.push(project);
      }
    }
  }
  const changedIds = new Set(mutation.changedProjectNotes.map(n => n.id));
  for (const { node } of finalFlat) {
    if (node.outcome === initialNodes.get(node.key)?.outcome) continue;
    const project = mutation.notes.find(note => note.id === node.key)
      || mutation.notes.find(note => note.noteType === 'project' && note.title === node.title && !notes.some(old => old.id === note.id));
    if (!project) continue;
    project.planOutcome = node.outcome || '';
    project.updatedAt = now; changedIds.add(project.id);
    const window = mutation.notes.find(note => note.id === rootId)?.planMeta?.phaseWindows?.find(phase => phase.projectId === project.id);
    if (window) { window.outcome = node.outcome; changedIds.add(rootId); }
  }
  // Draft regeneration may replace/remove its web provenance; retain it on save/reopen.
  let root = mutation.notes.find(note => note.id === rootId);
  if (root?.planMeta) {
    const merged = mergePreparationResources(root, plannedPreparationDocuments(nextMeta.preparationDocuments));
    if (merged !== root || root.planMeta.resourcePreparationVersion !== 1 || !same(beforeMeta.research, nextMeta.research)) {
      root = { ...merged, planMeta: { ...merged.planMeta!, resourcePreparationVersion: 1 }, updatedAt: now };
      mutation.notes = mutation.notes.map(note => note.id === rootId ? root! : note); changedIds.add(rootId);
    }
  }
  if (root?.planMeta && !same(beforeMeta.research, nextMeta.research)) {
    root.planMeta.research = nextMeta.research ? structuredClone(nextMeta.research) : undefined;
    root.updatedAt = now; changedIds.add(rootId);
  }
  mutation.changedProjectNotes = mutation.notes.filter(n => changedIds.has(n.id));
  return mutation;
}
