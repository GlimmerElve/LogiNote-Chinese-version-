import type { DueDateItem, NoteItem, PlanMilestone, PlanTaskKind } from '../types';
import { isLearningProject } from './projectRole';
import { getScheduledProjectChildren, getScheduledProjectDeadline, getScheduledProjectState } from './planProjectState';
import { getLearningCompletionTarget } from './learningCompletion';
import { buildHomeScheduledTasks, homeCalendarDay, homeLocalDate, nextHomeTaskOccurrence } from './homepage/homeTaskScheduling';
import { buildLearningCapacity, personalWeeklyBudget, cachedCapacitySettings } from './learningCapacity';

const DAY_MS = 86_400_000;

export const PLAN_OVERVIEW_ID = '__overview__';

export interface PlanWorkspaceTask extends DueDateItem {
  kind: PlanTaskKind;
  startDate: string;
  estimatedMinutes: number;
  projectId: string;
  projectTitle: string;
  rootId: string;
  rootTitle: string;
  leftPercent: number;
  widthPercent: number;
  weekIndex: number;
  occurrenceDate: string;
  occurrenceAvailable: boolean;
}

export interface PlanWorkspaceStructureNode {
  projectId: string;
  title: string;
  parentId?: string;
  rootId: string;
  rootTitle: string;
  depth: number;
  path: string[];
  startDate: string;
  endDate: string;
  progress: number;
  completed: boolean;
  hasChildren: boolean;
  leftPercent: number;
  widthPercent: number;
}

export interface PlanWorkspaceStructureLane {
  rootId: string;
  rootTitle: string;
  completed: boolean;
  nodes: PlanWorkspaceStructureNode[];
}

export interface PlanWorkspaceStructureDueItem {
  id: string;
  projectId: string;
  title: string;
  rootId: string;
  rootTitle: string;
  path: string[];
  startDate: string;
  dueDate: string;
  completed: boolean;
  completedAt?: string;
}

export interface PlanWorkspaceStructureOccurrence {
  occurrenceDate: string;
  item: PlanWorkspaceStructureDueItem;
}

export interface PlanWorkspacePhase {
  projectId: string;
  title: string;
  rootId: string;
  rootTitle: string;
  outcome: string;
  startDate: string;
  endDate: string;
  progress: number;
  completed: boolean;
  leftPercent: number;
  widthPercent: number;
}

export interface PlanWorkspaceMilestone extends PlanMilestone {
  rootId: string;
  rootTitle: string;
  leftPercent: number;
  implicit?: boolean;
}

export interface PlanWorkspaceWeek {
  index: number;
  startDate: string;
  endDate: string;
  label: string;
  rangeLabel: string;
}

export interface PlanWorkspacePlanSummary {
  id: string;
  title: string;
  shortTitle: string;
  status: 'draft' | 'active' | 'paused' | 'completed' | 'archived';
  taskCount: number;
  completedTaskCount: number;
  progress: number;
  targetDate?: string;
  currentWeekMinutes: number;
  weeklyBudgetMinutes: number;
  updatedAt: string;
}

export interface PlanWorkspaceModel {
  isOverview: boolean;
  plans: PlanWorkspacePlanSummary[];
  selectedPlan: PlanWorkspacePlanSummary | null;
  root: NoteItem | null;
  scopeRoots: NoteItem[];
  scopeRootIds: string[];
  projectNotes: NoteItem[];
  tasks: PlanWorkspaceTask[];
  structureLanes: PlanWorkspaceStructureLane[];
  structureDueItems: PlanWorkspaceStructureDueItem[];
  phases: PlanWorkspacePhase[];
  milestones: PlanWorkspaceMilestone[];
  weeks: PlanWorkspaceWeek[];
  timelineStartDate: string;
  timelineEndDate: string;
  totalDays: number;
  todayPercent: number | null;
  nextMilestone: PlanWorkspaceMilestone | null;
  currentPhase: PlanWorkspacePhase | null;
  currentPhases: PlanWorkspacePhase[];
}

function dayFromDate(value: string | undefined): number | null {
  return homeCalendarDay(value);
}

function dateFromDay(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

function localDayFromTimestamp(value: string | undefined): number | null {
  if (!value) return null;
  // Date-only legacy values already represent a calendar date, not a UTC instant.
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return dayFromDate(value);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS);
}

/** Place each leaf project on its next actionable date without changing its deadline. */
export function buildStructureAgendaOccurrences(
  items: PlanWorkspaceStructureDueItem[],
  weekStart: string,
  weekEnd: string,
  today: string,
): PlanWorkspaceStructureOccurrence[] {
  const firstWeekDay = dayFromDate(weekStart);
  const lastWeekDay = dayFromDate(weekEnd);
  const todayDay = dayFromDate(today);
  if (firstWeekDay === null || lastWeekDay === null || todayDay === null || firstWeekDay > lastWeekDay) return [];

  const occurrences: PlanWorkspaceStructureOccurrence[] = [];
  const visitedProjects = new Set<string>();
  const addOccurrence = (item: PlanWorkspaceStructureDueItem, day: number) => {
    if (day >= firstWeekDay && day <= lastWeekDay) {
      occurrences.push({ occurrenceDate: dateFromDay(day), item });
    }
  };
  for (const item of items) {
    if (visitedProjects.has(item.projectId)) continue;
    visitedProjects.add(item.projectId);
    const dueDay = dayFromDate(item.dueDate);
    if (dueDay === null) continue;
    if (item.completed) {
      const completionDay = localDayFromTimestamp(item.completedAt) ?? dueDay;
      addOccurrence(item, completionDay);
      continue;
    }

    const startDay = dayFromDate(item.startDate) ?? dueDay;
    // Before starting, show it once on its start date. Once started, unfinished
    // work belongs only to today, including overdue work, and rolls as today changes.
    addOccurrence(item, Math.max(startDay, todayDay));
  }
  return occurrences.sort((a, b) => a.occurrenceDate.localeCompare(b.occurrenceDate)
    || a.item.dueDate.localeCompare(b.item.dueDate)
    || a.item.title.localeCompare(b.item.title));
}

/** A seven-day agenda expands rules, not copies of today's rule state. */
export function buildExecutionAgendaOccurrences<T extends DueDateItem>(
  tasks: T[], weekStart: string, weekEnd: string, today: string,
): Array<T & { occurrenceDate: string; completed: boolean }> {
  const first = dayFromDate(weekStart), last = dayFromDate(weekEnd), todayDay = dayFromDate(today);
  if (first === null || last === null || todayDay === null || last < first || last - first > 6) return [];
  const result: Array<T & { occurrenceDate: string; completed: boolean }> = [];
  const identities = new Map<string, number>();
  for (const task of tasks) {
    const key = `${task.noteId}\u0000${task.id}`;
    identities.set(key, (identities.get(key) || 0) + 1);
  }
  for (const task of tasks) {
    if (identities.get(`${task.noteId}\u0000${task.id}`) !== 1) continue;
    const due = dayFromDate(task.dueDate), start = dayFromDate(task.startDate || task.dueDate);
    if (due === null || start === null || start > due) continue;
    if (task.recurrence && task.recurrence.frequency !== 'none') {
      let date = nextHomeTaskOccurrence(task, weekStart);
      while (date && date <= weekEnd) {
        result.push({ ...task, occurrenceDate: date, occurrenceAvailable: true, completed: Boolean(task.completedOccurrenceDates?.includes(date)) });
        date = nextHomeTaskOccurrence(task, dateFromDay(dayFromDate(date)! + 1));
      }
    } else {
      // Keep the real deadline; only the actionable day rolls forward.
      const day = task.completed ? localDayFromTimestamp(task.completedAt) ?? due : Math.max(start, todayDay);
      if (day >= first && day <= last) result.push({ ...task, occurrenceDate: dateFromDay(day) });
    }
  }
  return result.sort((a, b) => a.occurrenceDate.localeCompare(b.occurrenceDate)
    || (a.order || 0) - (b.order || 0) || a.taskText.localeCompare(b.taskText));
}

function mondayOf(day: number): number {
  const weekday = new Date(day * DAY_MS).getUTCDay();
  return day - ((weekday + 6) % 7);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatMonthDay(value: string): string {
  const parts = value.split('-');
  return `${Number(parts[1])}.${Number(parts[2])}`;
}

function inferTaskKind(item: DueDateItem): PlanTaskKind {
  if (item.kind) return item.kind;
  const text = item.taskText.toLocaleLowerCase();
  if (/(?:复习|回顾|回忆|记忆)/u.test(text)) return 'review';
  if (/(?:测试|测验|考试|验收|模拟考)/u.test(text)) return 'assessment';
  if (/(?:练习|题|作业|实战|实践|项目输出)/u.test(text)) return 'practice';
  return 'learn';
}

function isProjectDeadline(note: NoteItem, item: DueDateItem): boolean {
  return note.noteType === 'project' && item.taskText.trim() === note.title.trim();
}

function collectProjectScope(rootId: string, notes: NoteItem[]): NoteItem[] {
  const byParent = new Map<string, NoteItem[]>();
  for (const note of notes) {
    if (!isLearningProject(note) || !note.parentId) continue;
    const siblings = byParent.get(note.parentId) || [];
    siblings.push(note);
    byParent.set(note.parentId, siblings);
  }
  const root = notes.find((note) => note.id === rootId && isLearningProject(note));
  if (!root) return [];
  const result: NoteItem[] = [];
  const queue = [root];
  const visited = new Set<string>();
  while (queue.length) {
    const current = queue.shift()!;
    if (visited.has(current.id)) continue;
    visited.add(current.id);
    result.push(current);
    queue.push(...(byParent.get(current.id) || []));
  }
  return result;
}

function rootProjects(notes: NoteItem[]): NoteItem[] {
  const projectIds = new Set(notes.filter(isLearningProject).map((note) => note.id));
  return notes
    .filter((note) => isLearningProject(note) && (!note.parentId || !projectIds.has(note.parentId)))
    .filter((root) => {
      if (root.planMeta?.status === 'archived') return false;
      if (root.planMeta) return true;
      return collectProjectScope(root.id, notes).some((project) => project.dueDates.some((item) => (
        dayFromDate(item.startDate) !== null || dayFromDate(item.dueDate) !== null
      )));
    })
    .sort((a, b) => {
      const statusWeight = (note: NoteItem) => note.planMeta?.status === 'active' ? 2 : note.planMeta ? 1 : 0;
      return statusWeight(b) - statusWeight(a) || b.updatedAt.localeCompare(a.updatedAt);
    });
}

function dateExtent(values: Array<string | undefined>, fallback: string): { start: string; end: string } {
  const days = values.map(dayFromDate).filter((value): value is number => value !== null);
  if (!days.length) return { start: fallback, end: dateFromDay((dayFromDate(fallback) || 0) + 41) };
  return { start: dateFromDay(Math.min(...days)), end: dateFromDay(Math.max(...days)) };
}

function planSummary(root: NoteItem, notes: NoteItem[], today: string, capacity: ReturnType<typeof buildLearningCapacity>): PlanWorkspacePlanSummary {
  const scope = collectProjectScope(root.id, notes);
  const tasks = scope.flatMap((note) => note.dueDates.filter((item) => {
    if (isProjectDeadline(note, item)) return false;
    const recurring = item.recurrence && item.recurrence.frequency !== 'none';
    const date = recurring ? nextHomeTaskOccurrence(item, item.startDate || item.dueDate) : undefined;
    if (recurring && !date) return false;
    return Boolean(getLearningCompletionTarget(scope, { noteId: note.id, taskId: item.id,
      ...(recurring ? { occurrenceDate: date || undefined } : {}) }));
  }).map(item => ({ ...item, noteId: note.id, noteTitle: note.title })));
  // The home and plan summaries count the same scheduled leaves and valid daily work.
  const progressItems = buildHomeScheduledTasks(scope, today).filter(item => item.progressEligible);
  const completed = progressItems.filter(item => item.completed).length;
  const totalItems = progressItems.length;
  const todayDay = dayFromDate(today) || 0;
  const currentWeekStart = mondayOf(todayDay);
  const currentWeekEnd = currentWeekStart + 6;
  const currentWeekMinutes = capacity.byRoot.find(r => r.rootId === root.id)?.scheduledMinutes || 0;
  const targetExtent = dateExtent([
    root.planMeta?.targetDate,
    ...scope.flatMap((note) => note.dueDates.map((item) => item.dueDate)),
  ], today);
  return {
    id: root.id,
    title: root.title,
    shortTitle: root.planMeta?.shortTitle || root.title,
    status: root.planMeta?.status || (totalItems > 0 && completed === totalItems ? 'completed' : 'active'),
    taskCount: totalItems,
    completedTaskCount: completed,
    progress: totalItems ? Math.round((completed / totalItems) * 100) : 0,
    targetDate: root.planMeta?.targetDate || targetExtent.end,
    currentWeekMinutes,
    weeklyBudgetMinutes: capacity.budgetMinutes || 0,
    updatedAt: root.updatedAt,
  };
}

function offsetPercent(date: string, timelineStartDay: number, totalDays: number): number {
  const day = dayFromDate(date) ?? timelineStartDay;
  return clamp(((day - timelineStartDay) / totalDays) * 100, 0, 100);
}

function spanPercent(startDate: string, endDate: string, timelineStartDay: number, totalDays: number): number {
  const start = dayFromDate(startDate) ?? timelineStartDay;
  const end = dayFromDate(endDate) ?? start;
  return clamp(((Math.max(start, end) - start + 1) / totalDays) * 100, 0, 100);
}

export function buildPlanWorkspaceModel(
  notes: NoteItem[],
  selectedPlanId?: string | null,
  today = homeLocalDate(),
  settings: Partial<import('../types').VaultSettings> = cachedCapacitySettings(),
): PlanWorkspaceModel {
  const roots = rootProjects(notes);
  const day = dayFromDate(today) || 0;
  const capacity = buildLearningCapacity(notes, dateFromDay(mondayOf(day)), settings, today);
  const summaries = roots.map((root) => planSummary(root, notes, today, capacity));
  const isOverview = selectedPlanId === PLAN_OVERVIEW_ID && roots.length > 0;
  const selectedRootSummary = isOverview ? null : summaries.find((plan) => plan.id === selectedPlanId)
    || summaries.find((plan) => plan.status === 'active')
    || summaries[0]
    || null;
  const selectedRoot = selectedRootSummary
    ? roots.find((candidate) => candidate.id === selectedRootSummary.id) || null
    : null;
  const scopeRoots = isOverview ? roots : selectedRoot ? [selectedRoot] : [];
  const overviewTaskCount = summaries.reduce((sum, plan) => sum + plan.taskCount, 0);
  const overviewCompletedTaskCount = summaries.reduce((sum, plan) => sum + plan.completedTaskCount, 0);
  const overviewTargetDate = summaries.map((plan) => plan.targetDate).filter((value): value is string => Boolean(value)).sort().at(-1);
  const overviewStatus: PlanWorkspacePlanSummary['status'] = summaries.length > 0 && summaries.every((plan) => plan.status === 'completed')
    ? 'completed'
    : summaries.some((plan) => plan.status === 'active')
      ? 'active'
      : summaries.some((plan) => plan.status === 'paused')
        ? 'paused'
        : 'draft';
  const overviewSummary: PlanWorkspacePlanSummary | null = roots.length ? {
    id: PLAN_OVERVIEW_ID,
    title: '综合总览',
    shortTitle: '综合总览',
    status: overviewStatus,
    taskCount: overviewTaskCount,
    completedTaskCount: overviewCompletedTaskCount,
    progress: overviewTaskCount ? Math.round((overviewCompletedTaskCount / overviewTaskCount) * 100) : 0,
    targetDate: overviewTargetDate,
    currentWeekMinutes: summaries.reduce((sum, plan) => sum + plan.currentWeekMinutes, 0),
    weeklyBudgetMinutes: capacity.budgetMinutes || 0,
    updatedAt: summaries.map((plan) => plan.updatedAt).sort().at(-1) || today,
  } : null;
  const selectedSummary = isOverview ? overviewSummary : selectedRootSummary;
  const root = isOverview ? null : selectedRoot;
  if (!selectedSummary || scopeRoots.length === 0) {
    return {
      isOverview: false,
      plans: summaries,
      selectedPlan: null,
      root: null,
      scopeRoots: [],
      scopeRootIds: [],
      projectNotes: [],
      tasks: [],
      structureLanes: [],
      structureDueItems: [],
      phases: [],
      milestones: [],
      weeks: [],
      timelineStartDate: today,
      timelineEndDate: today,
      totalDays: 1,
      todayPercent: null,
      nextMilestone: null,
      currentPhase: null,
      currentPhases: [],
    };
  }

  const scopes = scopeRoots.map((scopeRoot) => {
    const scopeNotes = collectProjectScope(scopeRoot.id, notes);
    const configuredMilestones = scopeRoot.planMeta?.milestones || [];
    const implicitMilestones: Array<PlanMilestone & { implicit: true }> = scopeNotes.flatMap((project) => {
      const deadline = getScheduledProjectDeadline(project);
      return deadline ? [{
        id: `implicit-${deadline.id}`,
        title: project.title,
        dueDate: deadline.dueDate,
        projectId: project.id,
        completed: getScheduledProjectState(scopeNotes, project.id).completed,
        completedAt: deadline.completedAt,
        implicit: true as const,
      }] : [];
    });
    const milestoneKeys = new Set(configuredMilestones.map((item) => `${item.projectId || ''}|${item.dueDate}|${item.title}`));
    const milestoneSeed = [
      ...configuredMilestones,
      ...implicitMilestones.filter((item) => !milestoneKeys.has(`${item.projectId || ''}|${item.dueDate}|${item.title}`)),
    ];
    const actionableSeed = scopeNotes.flatMap((project) => (
      project.dueDates
        .filter((item) => !isProjectDeadline(project, item))
        .map((item) => ({ item, project }))
    ));
    return { root: scopeRoot, projectNotes: scopeNotes, milestoneSeed, actionableSeed };
  });
  const projectNotes = scopes.flatMap((scope) => scope.projectNotes);
  const dateValues = [
    ...scopes.flatMap((scope) => [
      scope.root.planMeta?.startDate,
      scope.root.planMeta?.targetDate,
      ...scope.projectNotes.flatMap((project) => project.dueDates.flatMap((item) => [item.startDate, item.dueDate, item.recurrence?.endDate])),
      ...scope.milestoneSeed.map((item) => item.dueDate),
    ]),
  ];
  const extent = dateExtent(dateValues, today);
  const extentStartDay = dayFromDate(extent.start) || dayFromDate(today) || 0;
  const extentEndDay = dayFromDate(extent.end) || extentStartDay + 41;
  const timelineStartDay = mondayOf(extentStartDay);
  const requestedDays = Math.max(42, extentEndDay - timelineStartDay + 1);
  // Keep the complete plan range. Calendar rendering is windowed separately;
  // limiting the model here made later weeks and even today unreachable.
  const weekCount = Math.max(6, Math.ceil(requestedDays / 7));
  const totalDays = weekCount * 7;
  const timelineEndDay = timelineStartDay + totalDays - 1;
  const weeks: PlanWorkspaceWeek[] = Array.from({ length: weekCount }, (_, index) => {
    const startDate = dateFromDay(timelineStartDay + index * 7);
    const endDate = dateFromDay(timelineStartDay + index * 7 + 6);
    return { index, startDate, endDate, label: `第 ${index + 1} 周`, rangeLabel: `${formatMonthDay(startDate)} – ${formatMonthDay(endDate)}` };
  });
  const tasks: PlanWorkspaceTask[] = scopes.flatMap((scope) => scope.actionableSeed.flatMap(({ item, project }): PlanWorkspaceTask[] => {
    const startDate = item.startDate || item.dueDate;
    const startDay = dayFromDate(startDate) || timelineStartDay;
    const recurring = item.recurrence && item.recurrence.frequency !== 'none';
    const nextOccurrence = recurring ? nextHomeTaskOccurrence(item, today) : null;
    const validationDate = recurring ? nextOccurrence || nextHomeTaskOccurrence(item, startDate) : undefined;
    if (recurring && !validationDate) return [];
    const target = getLearningCompletionTarget(scope.projectNotes, { noteId: project.id, taskId: item.id,
      ...(recurring ? { occurrenceDate: validationDate || undefined } : {}) });
    if (!target || target.kind !== 'execution') return [];
    const occurrenceDate = recurring ? nextOccurrence || item.recurrence?.endDate || item.dueDate : item.dueDate;
    return [{
      ...item,
      noteId: project.id,
      noteTitle: project.title,
      completed: recurring ? Boolean(nextOccurrence && item.completedOccurrenceDates?.includes(nextOccurrence)) : item.completed,
      kind: inferTaskKind(item),
      startDate,
      occurrenceDate,
      occurrenceAvailable: !recurring || Boolean(nextOccurrence),
      estimatedMinutes: item.estimatedMinutes || 60,
      projectId: project.id,
      projectTitle: project.title,
      rootId: scope.root.id,
      rootTitle: scope.root.title,
      leftPercent: offsetPercent(startDate, timelineStartDay, totalDays),
      widthPercent: spanPercent(startDate, recurring ? item.recurrence?.endDate || dateFromDay(timelineEndDay) : item.dueDate, timelineStartDay, totalDays),
      weekIndex: clamp(Math.floor((startDay - timelineStartDay) / 7), 0, weekCount - 1),
    }];
  })).sort((a, b) => a.startDate.localeCompare(b.startDate) || (a.order || 0) - (b.order || 0));

  const structureLanes: PlanWorkspaceStructureLane[] = scopes.map(({ root: laneRoot, projectNotes: scope }) => {
    const childrenByParent = new Map<string, NoteItem[]>();
    scope.forEach((project) => {
      if (!project.parentId) return;
      childrenByParent.set(project.parentId, [...(childrenByParent.get(project.parentId) || []), project]);
    });
    const nodes: PlanWorkspaceStructureNode[] = [];
    const visited = new Set<string>([laneRoot.id]);
    const walk = (parent: NoteItem, depth: number, path: string[], visibleParentId: string) => {
      for (const project of childrenByParent.get(parent.id) || []) {
        if (visited.has(project.id)) continue;
        visited.add(project.id);
        const deadline = getScheduledProjectDeadline(project);
        const childPath = [...path, project.title];
        if (!deadline) {
          // Ordinary project notes remain in the real path, but do not create a
          // scheduled bar or require expansion before scheduled descendants appear.
          walk(project, depth, childPath, visibleParentId);
          continue;
        }
        const startDate = deadline.startDate || deadline.dueDate;
        const endDate = deadline.dueDate;
        const state = getScheduledProjectState(scope, project.id);
        nodes.push({
          projectId: project.id,
          title: project.title,
          parentId: visibleParentId,
          rootId: laneRoot.id,
          rootTitle: laneRoot.title,
          depth,
          path: childPath,
          startDate,
          endDate,
          progress: state.progress,
          completed: state.completed,
          hasChildren: getScheduledProjectChildren(scope, project.id).length > 0,
          leftPercent: offsetPercent(startDate, timelineStartDay, totalDays),
          widthPercent: spanPercent(startDate, endDate, timelineStartDay, totalDays),
        });
        walk(project, depth + 1, childPath, project.id);
      }
    };
    walk(laneRoot, 0, [laneRoot.title], laneRoot.id);
    return {
      rootId: laneRoot.id,
      rootTitle: laneRoot.title,
      completed: getScheduledProjectState(scope, laneRoot.id).completed,
      nodes,
    };
  }).filter((lane) => lane.nodes.length > 0);
  const projectsById = new Map(notes.filter(isLearningProject).map((note) => [note.id, note]));
  const structureDueItems: PlanWorkspaceStructureDueItem[] = structureLanes.flatMap((lane) => lane.nodes
    .filter((node) => !node.hasChildren)
    .map((node) => {
      const project = projectsById.get(node.projectId);
      const deadline = project ? getScheduledProjectDeadline(project) : undefined;
      return {
        id: `structure-due-${node.projectId}`,
        projectId: node.projectId,
        title: node.title,
        rootId: lane.rootId,
        rootTitle: lane.rootTitle,
        path: node.path,
        startDate: node.startDate,
        dueDate: node.endDate,
        completed: node.completed,
        completedAt: deadline?.completedAt,
      };
    }))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  const phases: PlanWorkspacePhase[] = scopes.flatMap((scope) => {
    const scopeWork = buildHomeScheduledTasks(scope.projectNotes, today).filter(item => item.progressEligible);
    const configuredWindows = new Map((scope.root.planMeta?.phaseWindows || []).map((item) => [item.projectId, item]));
    const directChildren = scope.projectNotes.filter((project) => project.parentId === scope.root.id);
    const visitedPhaseProjects = new Set<string>();
    const collectPhaseProjects = (project: NoteItem): NoteItem[] => {
      if (visitedPhaseProjects.has(project.id)) return [];
      visitedPhaseProjects.add(project.id);
      const scopeIds = new Set(collectProjectScope(project.id, scope.projectNotes).map((note) => note.id));
      const hasDatedTasks = tasks.some((task) => task.rootId === scope.root.id && scopeIds.has(task.projectId)
        && (dayFromDate(task.startDate) !== null || dayFromDate(task.dueDate) !== null));
      if (getScheduledProjectDeadline(project) || hasDatedTasks) return [project];
      return scope.projectNotes.filter((child) => child.parentId === project.id).flatMap(collectPhaseProjects);
    };
    const phaseProjects = (directChildren.length ? directChildren : [scope.root]).flatMap(collectPhaseProjects);
    return phaseProjects.map((phaseProject) => {
      const scopeIds = new Set(collectProjectScope(phaseProject.id, scope.projectNotes).map((note) => note.id));
      const phaseTasks = tasks.filter((task) => task.rootId === scope.root.id && scopeIds.has(task.projectId));
      const deadline = getScheduledProjectDeadline(phaseProject);
      const phaseDates = [
        ...(deadline ? [deadline.startDate || deadline.dueDate, deadline.dueDate] : []),
        ...phaseTasks.flatMap((task) => [task.startDate, task.dueDate]),
      ].filter((date) => dayFromDate(date) !== null);
      const configured = configuredWindows.get(phaseProject.id);
      const validConfigured = configured && dayFromDate(configured.startDate) !== null
        && dayFromDate(configured.endDate) !== null && configured.startDate <= configured.endDate;
      const phaseExtent = dateExtent(phaseDates, today);
      const startDate = validConfigured ? configured.startDate : phaseExtent.start;
      const endDate = validConfigured ? configured.endDate : phaseExtent.end;
      const phaseWork = scopeWork.filter(item => scopeIds.has(item.ownerNoteId));
      const completed = phaseWork.filter(item => item.completed).length;
      return {
        projectId: phaseProject.id,
        title: phaseProject.title,
        rootId: scope.root.id,
        rootTitle: scope.root.title,
        outcome: configured?.outcome || `完成“${phaseProject.title}”阶段的学习与验证`,
        startDate,
        endDate,
        progress: phaseWork.length ? Math.round((completed / phaseWork.length) * 100) : 0,
        completed: phaseWork.length > 0 && completed === phaseWork.length,
        leftPercent: offsetPercent(startDate, timelineStartDay, totalDays),
        widthPercent: spanPercent(startDate, endDate, timelineStartDay, totalDays),
      };
    });
  }).sort((a, b) => a.startDate.localeCompare(b.startDate) || a.rootTitle.localeCompare(b.rootTitle));
  const milestones: PlanWorkspaceMilestone[] = scopes.flatMap((scope) => scope.milestoneSeed.map((item) => ({
    ...item,
    rootId: scope.root.id,
    rootTitle: scope.root.title,
    leftPercent: offsetPercent(item.dueDate, timelineStartDay, totalDays),
    implicit: 'implicit' in item ? Boolean(item.implicit) : undefined,
  })))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const todayDay = dayFromDate(today);
  const todayPercent = todayDay !== null && todayDay >= timelineStartDay && todayDay <= timelineEndDay
    ? ((todayDay - timelineStartDay) / totalDays) * 100
    : null;
  const nextMilestone = milestones.find((item) => !item.completed) || null;
  const currentPhases = scopes.map((scope) => {
    const rootPhases = phases.filter((phase) => phase.rootId === scope.root.id);
    const unfinished = rootPhases.filter(phase => !phase.completed);
    return unfinished.find((phase) => phase.startDate <= today)
      || unfinished[0]
      || rootPhases[rootPhases.length - 1]
      || null;
  }).filter((phase): phase is PlanWorkspacePhase => Boolean(phase));
  const currentPhase = currentPhases[0] || null;

  return {
    isOverview,
    plans: summaries,
    selectedPlan: selectedSummary,
    root,
    scopeRoots,
    scopeRootIds: scopeRoots.map((scopeRoot) => scopeRoot.id),
    projectNotes,
    tasks,
    structureLanes,
    structureDueItems,
    phases,
    milestones,
    weeks,
    timelineStartDate: dateFromDay(timelineStartDay),
    timelineEndDate: dateFromDay(timelineEndDay),
    totalDays,
    todayPercent,
    nextMilestone,
    currentPhase,
    currentPhases,
  };
}
