import React, { useEffect, useMemo, useState } from 'react';
import { StudyMinutesInput } from './StudyMinutesInput';
import {
  BookOpen,
  CalendarDays,
  CheckSquare,
  Clock3,
  Flag,
  GripVertical,
  Minus,
  Plus,
  RefreshCcw,
  Settings2,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react';
import type {
  PlanConditionAssessment,
} from '../services/planConditionService';
import type {
  PlanConditions,
  PlanMeta,
  PlanMilestone,
  PlanNode,
  PlanPace,
  PlanStartingLevel,
  PlanTaskBlueprint,
  PlanTaskKind,
} from '../types';

const DAY_MS = 86_400_000;
const MIN_TIMELINE_DAYS = 42;
const TRACKS: Array<{ kind: Exclude<PlanTaskKind, 'assessment'>; label: string; hint: string; icon: React.ElementType }> = [
  { kind: 'learn', label: '学习', hint: '理解概念 · 建立模型', icon: BookOpen },
  { kind: 'practice', label: '练习', hint: '应用知识 · 获得反馈', icon: CheckSquare },
  { kind: 'review', label: '复习', hint: '间隔回忆 · 巩固记忆', icon: RefreshCcw },
];
const WEEKDAYS = [
  { value: 1, label: '一' }, { value: 2, label: '二' }, { value: 3, label: '三' },
  { value: 4, label: '四' }, { value: 5, label: '五' }, { value: 6, label: '六' },
  { value: 0, label: '日' },
];
const STARTING_LEVEL_LABEL: Record<PlanStartingLevel, string> = {
  new: '从零开始', basic: '了解基础', intermediate: '已有实践', advanced: '进阶提升',
};
const PACE_LABEL: Record<PlanPace, string> = {
  relaxed: '舒缓', balanced: '均衡', intensive: '密集',
};

export interface PlanTimelineSettings {
  startDate: string;
  targetDate: string;
  weeklyBudgetMinutes: number;
  activeWeekdays: number[];
  startingLevel: PlanStartingLevel;
  pace: PlanPace;
  preferredSessionMinutes: number;
  preferredTimeOfDay: NonNullable<PlanConditions['preferredTimeOfDay']>;
  deadlineMode: NonNullable<PlanConditions['deadlineMode']>;
  reviewCadence: NonNullable<PlanConditions['reviewCadence']>;
  autoAdjustPolicy: NonNullable<PlanMeta['autoAdjustPolicy']>;
  portfolioPriority: 'high' | 'medium' | 'low';
  goalEvidence: string;
  constraintNotes: string;
}

interface TimelineTaskRef {
  phaseKey: string;
  phaseTitle: string;
  task: PlanTaskBlueprint;
}

interface TimelineProjectRef {
  node: PlanNode;
  parentKey?: string;
  depth: number;
}

type Selection =
  | { type: 'plan' }
  | { type: 'project'; key: string }
  | { type: 'task'; key: string }
  | { type: 'milestone'; id: string };

interface PlanTimelineComposerProps {
  nodes: PlanNode[];
  milestones: PlanMilestone[];
  settings: PlanTimelineSettings;
  assessment: PlanConditionAssessment;
  onNodesChange: (nodes: PlanNode[]) => void;
  onMilestonesChange: (milestones: PlanMilestone[]) => void;
  onSettingsChange: <K extends keyof PlanTimelineSettings>(key: K, value: PlanTimelineSettings[K]) => void;
}

function parseDate(value: string | undefined): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function addDays(value: string, days: number): string {
  return formatDate((parseDate(value) || Date.now()) + days * DAY_MS);
}

function dayDistance(from: string, to: string): number {
  return Math.round(((parseDate(to) || 0) - (parseDate(from) || 0)) / DAY_MS);
}

function flattenTasks(nodes: PlanNode[]): TimelineTaskRef[] {
  return nodes.flatMap((node) => [
    ...(node.tasks || []).map((task) => ({ phaseKey: node.key, phaseTitle: node.title, task })),
    ...flattenTasks(node.children || []),
  ]);
}

function flattenProjects(nodes: PlanNode[], parentKey?: string, depth = 0): TimelineProjectRef[] {
  return nodes.flatMap((node) => [
    { node, parentKey, depth },
    ...flattenProjects(node.children || [], node.key, depth + 1),
  ]);
}

function updateProject(nodes: PlanNode[], projectKey: string, patch: Partial<PlanNode>): PlanNode[] {
  return nodes.map((node) => node.key === projectKey
    ? { ...node, ...patch }
    : { ...node, children: updateProject(node.children || [], projectKey, patch) });
}

function replaceProject(nodes: PlanNode[], projectKey: string, replacement: PlanNode): PlanNode[] {
  return nodes.map((node) => node.key === projectKey
    ? replacement
    : { ...node, children: replaceProject(node.children || [], projectKey, replacement) });
}

function addTaskToProject(nodes: PlanNode[], projectKey: string, task: PlanTaskBlueprint): PlanNode[] {
  return nodes.map((node) => node.key === projectKey
    ? { ...node, tasks: [...(node.tasks || []), task] }
    : { ...node, children: addTaskToProject(node.children || [], projectKey, task) });
}

function detachProject(nodes: PlanNode[], projectKey: string): { nodes: PlanNode[]; detached?: PlanNode } {
  let detached: PlanNode | undefined;
  const next = nodes.flatMap((node) => {
    if (node.key === projectKey) {
      detached = node;
      return [];
    }
    const nested = detachProject(node.children || [], projectKey);
    if (nested.detached) detached = nested.detached;
    return [{ ...node, children: nested.nodes }];
  });
  return { nodes: next, detached };
}

function moveProject(nodes: PlanNode[], projectKey: string, parentKey: string | undefined, fallbackStart: string): PlanNode[] {
  const detached = detachProject(nodes, projectKey);
  if (!detached.detached) return nodes;
  if (!parentKey) return [...detached.nodes, detached.detached];
  const parentRef = flattenProjects(detached.nodes).find((project) => project.node.key === parentKey);
  if (!parentRef || parentRef.depth !== 0) return nodes;
  const parent = parentRef.node;
  const parentWindow = projectWindow(parent, fallbackStart);
  const child = clampProjectTree(detached.detached, parentWindow.startDate, parentWindow.dueDate);
  return updateProject(detached.nodes, parentKey, {
    children: [
      ...(parent.children || []),
      child,
    ],
  });
}

function projectDescendantKeys(node: PlanNode): string[] {
  return (node.children || []).flatMap((child) => [child.key, ...projectDescendantKeys(child)]);
}

function projectTreeDepth(node: PlanNode): number {
  return node.children.length ? 1 + Math.max(...node.children.map(projectTreeDepth)) : 0;
}

function shiftProjectTree(node: PlanNode, deltaDays: number, fallbackStart: string): PlanNode {
  const window = projectWindow(node, fallbackStart);
  return {
    ...node,
    startDate: addDays(window.startDate, deltaDays),
    dueDate: addDays(window.dueDate, deltaDays),
    tasks: (node.tasks || []).map((task) => ({
      ...task,
      startDate: addDays(task.startDate || task.dueDate, deltaDays),
      dueDate: addDays(task.dueDate, deltaDays),
    })),
    children: (node.children || []).map((child) => shiftProjectTree(child, deltaDays, fallbackStart)),
  };
}

function clampProjectTree(node: PlanNode, parentStartDate: string, parentDueDate: string): PlanNode {
  const current = projectWindow(node, parentStartDate);
  const parentStart = parseDate(parentStartDate) || 0;
  const parentDue = parseDate(parentDueDate) || parentStart;
  const spanDays = Math.max(1, dayDistance(current.startDate, current.dueDate) + 1);
  const latestStart = Math.max(parentStart, parentDue - (spanDays - 1) * DAY_MS);
  const startMs = Math.max(parentStart, Math.min(parseDate(current.startDate) || parentStart, latestStart));
  const dueMs = Math.min(parentDue, startMs + (spanDays - 1) * DAY_MS);
  const startDate = formatDate(startMs);
  const dueDate = formatDate(dueMs);
  const tasks = (node.tasks || []).map((task) => {
    const taskSpan = Math.max(1, dayDistance(task.startDate || task.dueDate, task.dueDate) + 1);
    const latestTaskStart = Math.max(startMs, dueMs - (taskSpan - 1) * DAY_MS);
    const taskStartMs = Math.max(startMs, Math.min(parseDate(task.startDate || task.dueDate) || startMs, latestTaskStart));
    return {
      ...task,
      startDate: formatDate(taskStartMs),
      dueDate: formatDate(Math.min(dueMs, taskStartMs + (taskSpan - 1) * DAY_MS)),
    };
  });
  return {
    ...node,
    startDate,
    dueDate,
    tasks,
    children: (node.children || []).map((child) => clampProjectTree(child, startDate, dueDate)),
  };
}

function mapTasks(nodes: PlanNode[], taskKey: string, updater: (task: PlanTaskBlueprint) => PlanTaskBlueprint): PlanNode[] {
  return nodes.map((node) => ({
    ...node,
    tasks: (node.tasks || []).map((task) => task.key === taskKey ? updater(task) : task),
    children: mapTasks(node.children || [], taskKey, updater),
  }));
}

function deleteTask(nodes: PlanNode[], taskKey: string): PlanNode[] {
  return nodes.map((node) => ({
    ...node,
    tasks: (node.tasks || []).filter((task) => task.key !== taskKey),
    children: deleteTask(node.children || [], taskKey),
  })).filter((node) => node.key !== 'timeline-manual-phase' || (node.tasks || []).length > 0 || node.children.length > 0);
}

function moveTaskToProject(nodes: PlanNode[], taskKey: string, projectKey: string): PlanNode[] {
  const task = flattenTasks(nodes).find((item) => item.task.key === taskKey)?.task;
  if (!task) return nodes;
  return addTaskToProject(deleteTask(nodes, taskKey), projectKey, task);
}

function timelineKind(kind: PlanTaskKind): Exclude<PlanTaskKind, 'assessment'> {
  return kind === 'assessment' ? 'practice' : kind;
}

function projectWindow(node: PlanNode, fallbackStart: string): { startDate: string; dueDate: string } {
  const nested = flattenTasks([node]).map(({ task }) => [task.startDate || task.dueDate, task.dueDate]).flat();
  const dated = nested.filter((value): value is string => Boolean(parseDate(value))).sort();
  const startDate = node.startDate || dated[0] || fallbackStart;
  const dueDate = node.dueDate || dated.at(-1) || addDays(startDate, 13);
  return { startDate, dueDate };
}

function moduleTitle(template: string, lane: Exclude<PlanTaskKind, 'assessment'>): string {
  if (template === 'concept') return lane === 'learn' ? '新的学习模块' : lane === 'practice' ? '概念应用练习' : '概念间隔复习';
  if (template === 'practice') return lane === 'learn' ? '例题拆解学习' : lane === 'practice' ? '新的练习模块' : '错题回顾';
  if (template === 'review') return lane === 'learn' ? '复习材料整理' : lane === 'practice' ? '检索练习' : '新的复习模块';
  return '自定义任务';
}

export const PlanTimelineComposer: React.FC<PlanTimelineComposerProps> = ({
  nodes,
  milestones,
  settings,
  assessment,
  onNodesChange,
  onMilestonesChange,
  onSettingsChange,
}) => {
  const [selection, setSelection] = useState<Selection>({ type: 'plan' });
  const [pixelsPerDay, setPixelsPerDay] = useState(22);
  const [pendingTemplate, setPendingTemplate] = useState<string | null>(null);
  const [pointerDragging, setPointerDragging] = useState<string | null>(null);
  const tasks = useMemo(() => flattenTasks(nodes), [nodes]);
  const projects = useMemo(() => flattenProjects(nodes), [nodes]);
  const maxProjectDepth = projects.reduce((maximum, project) => Math.max(maximum, project.depth), 0);
  const projectLaneHeight = Math.max(86, (maxProjectDepth + 1) * 40 + 14);

  const range = useMemo(() => {
    const startMs = parseDate(settings.startDate) || Date.now();
    const datedEnds = [
      parseDate(settings.targetDate),
      ...tasks.map(({ task }) => parseDate(task.dueDate)),
      ...projects.map(({ node }) => parseDate(projectWindow(node, settings.startDate).dueDate)),
      ...milestones.map((milestone) => parseDate(milestone.dueDate)),
    ].filter((value): value is number => value !== null);
    const latest = datedEnds.length ? Math.max(...datedEnds) : startMs;
    const endMs = Math.max(startMs + (MIN_TIMELINE_DAYS - 1) * DAY_MS, latest + 7 * DAY_MS);
    const totalDays = Math.max(MIN_TIMELINE_DAYS, Math.round((endMs - startMs) / DAY_MS) + 1);
    return { startMs, endMs, totalDays, width: totalDays * pixelsPerDay };
  }, [settings.startDate, settings.targetDate, tasks, projects, milestones, pixelsPerDay]);

  const weeks = useMemo(() => {
    const count = Math.ceil(range.totalDays / 7);
    return Array.from({ length: count }, (_, index) => ({
      index,
      date: formatDate(range.startMs + index * 7 * DAY_MS),
      width: Math.min(7, range.totalDays - index * 7) * pixelsPerDay,
    }));
  }, [range, pixelsPerDay]);

  const selectedTask = selection.type === 'task' ? tasks.find(({ task }) => task.key === selection.key) : undefined;
  const selectedProject = selection.type === 'project' ? projects.find(({ node }) => node.key === selection.key) : undefined;
  const selectedProjectParent = selectedProject?.parentKey
    ? projects.find((project) => project.node.key === selectedProject.parentKey)?.node
    : undefined;
  const selectedMilestone = selection.type === 'milestone' ? milestones.find((milestone) => milestone.id === selection.id) : undefined;

  const dateFromPointer = (event: React.DragEvent<HTMLElement> | React.MouseEvent<HTMLElement>): string => {
    const rect = event.currentTarget.getBoundingClientRect();
    const offset = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
    const days = Math.max(0, Math.min(range.totalDays - 1, Math.floor(offset / pixelsPerDay)));
    return formatDate(range.startMs + days * DAY_MS);
  };

  const dateFromClientX = (element: HTMLElement, clientX: number): string => {
    const rect = element.getBoundingClientRect();
    const offset = Math.max(0, Math.min(rect.width, clientX - rect.left));
    const days = Math.max(0, Math.min(range.totalDays - 1, Math.floor(offset / pixelsPerDay)));
    return formatDate(range.startMs + days * DAY_MS);
  };

  const parentProjectAtPointer = (lane: HTMLElement, clientX: number, clientY: number, excludedKeys = new Set<string>()): string | undefined => {
    const laneRect = lane.getBoundingClientRect();
    // The overall plan is the real root note but is not rendered as a block.
    // Therefore this lane has exactly two spatial levels: secondary and tertiary projects.
    const intendedDepth = Math.max(0, Math.min(1, Math.floor((clientY - laneRect.top - 6) / 40)));
    if (intendedDepth === 0) return undefined;
    const date = dateFromClientX(lane, clientX);
    const candidates = projects.filter((project) => project.depth === intendedDepth - 1 && !excludedKeys.has(project.node.key));
    const containing = candidates.find((project) => {
        const window = projectWindow(project.node, settings.startDate);
        return window.startDate <= date && window.dueDate >= date;
      });
    if (containing) return containing.node.key;

    // A slightly inaccurate lower-row drop still means "make this a child".
    // Bind it to the nearest upper block; addTimelineProject will clamp its dates.
    const targetMs = parseDate(date) || range.startMs;
    return [...candidates].sort((a, b) => {
      const distanceTo = (project: TimelineProjectRef) => {
        const window = projectWindow(project.node, settings.startDate);
        const start = parseDate(window.startDate) || targetMs;
        const due = parseDate(window.dueDate) || start;
        return targetMs < start ? start - targetMs : targetMs > due ? targetMs - due : 0;
      };
      return distanceTo(a) - distanceTo(b);
    })[0]?.node.key;
  };

  const updateTask = (key: string, patch: Partial<PlanTaskBlueprint>) => {
    onNodesChange(mapTasks(nodes, key, (task) => ({ ...task, ...patch })));
  };

  const reassignTaskToProject = (taskKey: string, projectKey: string) => {
    const moved = moveTaskToProject(nodes, taskKey, projectKey);
    const target = flattenProjects(moved).find((project) => project.node.key === projectKey)?.node;
    if (!target) return;
    const window = projectWindow(target, settings.startDate);
    onNodesChange(replaceProject(moved, projectKey, clampProjectTree(target, window.startDate, window.dueDate)));
  };

  const addTimelineTask = (template: string, lane: Exclude<PlanTaskKind, 'assessment'>, startDate: string) => {
    const durationDays = lane === 'learn' ? 5 : lane === 'practice' ? 3 : 2;
    const task: PlanTaskBlueprint = {
      key: `timeline-task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      text: moduleTitle(template, lane),
      kind: lane,
      startDate,
      dueDate: addDays(startDate, durationDays - 1),
      estimatedMinutes: settings.preferredSessionMinutes,
      priority: 'medium',
      source: 'manual',
    };
    const selectedProjectKey = selection.type === 'project' ? selection.key : undefined;
    const targetProject = selectedProjectKey
      ? projects.find((project) => project.node.key === selectedProjectKey)
      : [...projects]
          .filter((project) => {
            const window = projectWindow(project.node, settings.startDate);
            return window.startDate <= startDate && window.dueDate >= startDate;
          })
          .sort((a, b) => b.depth - a.depth)[0];
    if (targetProject) {
      const targetWindow = projectWindow(targetProject.node, settings.startDate);
      const projectStart = parseDate(targetWindow.startDate) || 0;
      const projectDue = parseDate(targetWindow.dueDate) || projectStart;
      const taskSpan = Math.max(1, dayDistance(task.startDate || task.dueDate, task.dueDate) + 1);
      const latestStart = Math.max(projectStart, projectDue - (taskSpan - 1) * DAY_MS);
      const taskStart = Math.max(projectStart, Math.min(parseDate(task.startDate || task.dueDate) || projectStart, latestStart));
      const boundedTask = { ...task, startDate: formatDate(taskStart), dueDate: formatDate(Math.min(projectDue, taskStart + (taskSpan - 1) * DAY_MS)) };
      onNodesChange(addTaskToProject(nodes, targetProject.node.key, boundedTask));
    } else {
      onNodesChange([...nodes, {
        key: 'timeline-manual-phase',
        title: '自定义编排',
        startDate: settings.startDate,
        dueDate: settings.targetDate || task.dueDate,
        priority: settings.portfolioPriority,
        outcome: settings.goalEvidence || undefined,
        tasks: [task],
        children: [],
      }]);
    }
    setSelection({ type: 'task', key: task.key });
  };

  const addTimelineProject = (startDate: string, spatialParentKey?: string | null) => {
    const parentKey = spatialParentKey === null
      ? undefined
      : spatialParentKey || (selection.type === 'project' ? selection.key : undefined);
    const parentRef = parentKey ? projects.find((item) => item.node.key === parentKey) : undefined;
    const parent = parentRef?.depth === 0 ? parentRef.node : undefined;
    const effectiveParentKey = parent ? parentKey : undefined;
    const parentWindow = parent ? projectWindow(parent, settings.startDate) : undefined;
    const clampedStart = parentWindow
      ? formatDate(Math.max(parseDate(parentWindow.startDate) || 0, Math.min(parseDate(startDate) || 0, parseDate(parentWindow.dueDate) || 0)))
      : startDate;
    const project: PlanNode = {
      key: `timeline-project-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      title: '新的项目阶段',
      startDate: clampedStart,
      dueDate: parentWindow && addDays(clampedStart, 13) > parentWindow.dueDate ? parentWindow.dueDate : addDays(clampedStart, 13),
      priority: settings.portfolioPriority,
      outcome: undefined,
      tasks: [],
      children: [],
    };
    onNodesChange(effectiveParentKey
      ? updateProject(nodes, effectiveParentKey, {
          children: [...(projects.find((item) => item.node.key === effectiveParentKey)?.node.children || []), project],
        })
      : [...nodes, project]);
    setSelection({ type: 'project', key: project.key });
    setPendingTemplate(null);
  };

  const moveTimelineTask = (key: string, lane: Exclude<PlanTaskKind, 'assessment'>, startDate: string) => {
    const currentRef = tasks.find(({ task }) => task.key === key);
    if (!currentRef) return;
    const current = currentRef.task;
    const span = Math.max(1, dayDistance(current.startDate || current.dueDate, current.dueDate) + 1);
    const owner = projects.find((project) => project.node.key === currentRef.phaseKey)?.node;
    const ownerWindow = owner ? projectWindow(owner, settings.startDate) : undefined;
    let taskStart = parseDate(startDate) || range.startMs;
    if (ownerWindow) {
      const ownerStart = parseDate(ownerWindow.startDate) || taskStart;
      const ownerDue = parseDate(ownerWindow.dueDate) || ownerStart;
      const latestStart = Math.max(ownerStart, ownerDue - (span - 1) * DAY_MS);
      taskStart = Math.max(ownerStart, Math.min(taskStart, latestStart));
    }
    const nextStartDate = formatDate(taskStart);
    const nextDueDate = ownerWindow && addDays(nextStartDate, span - 1) > ownerWindow.dueDate ? ownerWindow.dueDate : addDays(nextStartDate, span - 1);
    updateTask(key, { kind: lane, startDate: nextStartDate, dueDate: nextDueDate });
    setSelection({ type: 'task', key });
  };

  const resizeTimelineTask = (key: string, requestedDueDate: string, estimatedMinutes?: number) => {
    const currentRef = tasks.find(({ task }) => task.key === key);
    if (!currentRef) return;
    const taskStart = currentRef.task.startDate || currentRef.task.dueDate;
    let dueMs = Math.max(parseDate(taskStart) || 0, parseDate(requestedDueDate) || 0);
    const owner = projects.find((project) => project.node.key === currentRef.phaseKey)?.node;
    if (owner) dueMs = Math.min(dueMs, parseDate(projectWindow(owner, settings.startDate).dueDate) || dueMs);
    updateTask(key, {
      dueDate: formatDate(dueMs),
      ...(estimatedMinutes !== undefined ? { estimatedMinutes } : {}),
    });
  };

  const handleLaneDrop = (event: React.DragEvent<HTMLDivElement>, lane: Exclude<PlanTaskKind, 'assessment'>) => {
    event.preventDefault();
    const date = dateFromPointer(event);
    const taskKey = event.dataTransfer.getData('application/x-plan-task');
    const template = event.dataTransfer.getData('application/x-plan-template');
    if (taskKey) moveTimelineTask(taskKey, lane, date);
    else if (template && template !== 'milestone') addTimelineTask(template, lane, date);
    setPendingTemplate(null);
  };

  const handleMilestoneDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const template = event.dataTransfer.getData('application/x-plan-template');
    if (template !== 'milestone') return;
    const dueDate = dateFromPointer(event);
    const milestone: PlanMilestone = {
      id: `milestone-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      title: '新的里程碑',
      dueDate,
      criteria: [],
      completed: false,
    };
    onMilestonesChange([...milestones, milestone]);
    setSelection({ type: 'milestone', id: milestone.id });
    setPendingTemplate(null);
  };

  const handleProjectDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (event.dataTransfer.getData('application/x-plan-template') !== 'project') return;
    addTimelineProject(dateFromPointer(event), parentProjectAtPointer(event.currentTarget, event.clientX, event.clientY) || null);
  };

  const addPendingMilestone = (dueDate: string) => {
    const milestone: PlanMilestone = {
      id: `milestone-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      title: '新的里程碑',
      dueDate,
      criteria: [],
      completed: false,
    };
    onMilestonesChange([...milestones, milestone]);
    setSelection({ type: 'milestone', id: milestone.id });
    setPendingTemplate(null);
  };

  const removeSelection = () => {
    if (selection.type === 'task') onNodesChange(deleteTask(nodes, selection.key));
    else if (selection.type === 'project') onNodesChange(detachProject(nodes, selection.key).nodes);
    else if (selection.type === 'milestone') onMilestonesChange(milestones.filter((item) => item.id !== selection.id));
    else return;
    setSelection({ type: 'plan' });
  };

  useEffect(() => {
    const handleDeleteKey = (event: KeyboardEvent) => {
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return;
      if (selection.type === 'plan') return;
      event.preventDefault();
      removeSelection();
    };
    window.addEventListener('keydown', handleDeleteKey);
    return () => window.removeEventListener('keydown', handleDeleteKey);
  }, [selection, nodes, milestones]);

  const beginTemplatePointerDrag = (event: React.PointerEvent<HTMLElement>, template: string) => {
    if (event.button !== 0) return;
    const startX = event.clientX;
    const startY = event.clientY;
    let moved = false;
    const onMove = (moveEvent: PointerEvent) => {
      if (!moved && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) > 5) {
        moved = true;
        setPointerDragging(template);
      }
    };
    const onUp = (upEvent: PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setPointerDragging(null);
      if (!moved) {
        setPendingTemplate((current) => current === template ? null : template);
        return;
      }
      const target = document.elementFromPoint(upEvent.clientX, upEvent.clientY) as HTMLElement | null;
      const projectLane = target?.closest<HTMLElement>('[data-plan-project-lane]');
      const milestoneLane = target?.closest<HTMLElement>('[data-plan-milestone-lane]');
      const taskLane = target?.closest<HTMLElement>('[data-plan-lane]');
      if (template === 'project' && projectLane) addTimelineProject(dateFromClientX(projectLane, upEvent.clientX), parentProjectAtPointer(projectLane, upEvent.clientX, upEvent.clientY) || null);
      else if (template === 'milestone' && milestoneLane) addPendingMilestone(dateFromClientX(milestoneLane, upEvent.clientX));
      else if (template !== 'project' && template !== 'milestone' && taskLane) {
        addTimelineTask(template, taskLane.dataset.planLane as Exclude<PlanTaskKind, 'assessment'>, dateFromClientX(taskLane, upEvent.clientX));
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const beginTaskPointerDrag = (event: React.PointerEvent<HTMLElement>, taskKey: string) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('.plan-track-resize')) return;
    const startX = event.clientX;
    const startY = event.clientY;
    let moved = false;
    const onMove = (moveEvent: PointerEvent) => {
      if (!moved && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) > 5) {
        moved = true;
        setPointerDragging(taskKey);
      }
    };
    const onUp = (upEvent: PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setPointerDragging(null);
      if (!moved) return;
      const target = document.elementFromPoint(upEvent.clientX, upEvent.clientY) as HTMLElement | null;
      const taskLane = target?.closest<HTMLElement>('[data-plan-lane]');
      if (taskLane) moveTimelineTask(taskKey, taskLane.dataset.planLane as Exclude<PlanTaskKind, 'assessment'>, dateFromClientX(taskLane, upEvent.clientX));
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const moveProjectWindow = (projectKey: string, requestedStartDate: string) => {
    const projectRef = projects.find((item) => item.node.key === projectKey);
    if (!projectRef) return;
    const current = projectWindow(projectRef.node, settings.startDate);
    const span = Math.max(1, dayDistance(current.startDate, current.dueDate) + 1);
    let nextStartMs = parseDate(requestedStartDate) || parseDate(current.startDate) || range.startMs;
    const parent = projectRef.parentKey ? projects.find((item) => item.node.key === projectRef.parentKey)?.node : undefined;
    if (parent) {
      const parentRange = projectWindow(parent, settings.startDate);
      const parentStart = parseDate(parentRange.startDate) || nextStartMs;
      const parentDue = parseDate(parentRange.dueDate) || parentStart;
      const latestStart = Math.max(parentStart, parentDue - (span - 1) * DAY_MS);
      nextStartMs = Math.max(parentStart, Math.min(nextStartMs, latestStart));
    }
    const delta = Math.round((nextStartMs - (parseDate(current.startDate) || nextStartMs)) / DAY_MS);
    let shifted = shiftProjectTree(projectRef.node, delta, settings.startDate);
    if (parent) {
      const parentRange = projectWindow(parent, settings.startDate);
      shifted = clampProjectTree(shifted, parentRange.startDate, parentRange.dueDate);
    }
    onNodesChange(replaceProject(nodes, projectKey, shifted));
    const boundProjectIds = new Set([projectKey, ...projectDescendantKeys(projectRef.node)]);
    onMilestonesChange(milestones.map((milestone) => milestone.projectId && boundProjectIds.has(milestone.projectId)
      ? { ...milestone, dueDate: addDays(milestone.dueDate, delta) }
      : milestone));
  };

  const resizeProjectWindow = (projectKey: string, requestedDueDate: string) => {
    const projectRef = projects.find((item) => item.node.key === projectKey);
    if (!projectRef) return;
    const current = projectWindow(projectRef.node, settings.startDate);
    const startMs = parseDate(current.startDate) || range.startMs;
    let dueMs = Math.max(startMs, parseDate(requestedDueDate) || startMs);
    const parent = projectRef.parentKey ? projects.find((item) => item.node.key === projectRef.parentKey)?.node : undefined;
    if (parent) dueMs = Math.min(dueMs, parseDate(projectWindow(parent, settings.startDate).dueDate) || dueMs);
    const dueDate = formatDate(dueMs);
    const resized = clampProjectTree({ ...projectRef.node, startDate: current.startDate, dueDate }, current.startDate, dueDate);
    onNodesChange(replaceProject(nodes, projectKey, resized));
    const boundProjectIds = new Set([projectKey, ...projectDescendantKeys(projectRef.node)]);
    onMilestonesChange(milestones.map((milestone) => {
      if (!milestone.projectId || !boundProjectIds.has(milestone.projectId)) return milestone;
      return { ...milestone, dueDate: milestone.dueDate > dueDate ? dueDate : milestone.dueDate < current.startDate ? current.startDate : milestone.dueDate };
    }));
  };

  const beginProjectPointerDrag = (event: React.PointerEvent<HTMLElement>, projectKey: string) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('.plan-project-resize')) return;
    const startX = event.clientX;
    const startY = event.clientY;
    let moved = false;
    const onMove = (moveEvent: PointerEvent) => {
      if (!moved && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) > 5) {
        moved = true;
        setPointerDragging(projectKey);
      }
    };
    const onUp = (upEvent: PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setPointerDragging(null);
      if (!moved) return;
      const lane = document.querySelector<HTMLElement>('[data-plan-project-lane]');
      const projectRef = projects.find((item) => item.node.key === projectKey);
      const project = projectRef?.node;
      if (!lane || !project || !projectRef) return;
      const startDate = dateFromClientX(lane, upEvent.clientX);
      const excluded = new Set([projectKey, ...projectDescendantKeys(project)]);
      const nextParentKey = parentProjectAtPointer(lane, upEvent.clientX, upEvent.clientY, excluded);
      if (nextParentKey === projectRef.parentKey) {
        moveProjectWindow(projectKey, startDate);
      } else {
        let working = moveProject(nodes, projectKey, nextParentKey, settings.startDate);
        const movedRef = flattenProjects(working).find((item) => item.node.key === projectKey);
        if (!movedRef) return;
        const current = projectWindow(movedRef.node, settings.startDate);
        const requestedDelta = dayDistance(current.startDate, startDate);
        let shifted = shiftProjectTree(movedRef.node, requestedDelta, settings.startDate);
        const parent = nextParentKey ? flattenProjects(working).find((item) => item.node.key === nextParentKey)?.node : undefined;
        if (parent) {
          const parentRange = projectWindow(parent, settings.startDate);
          shifted = clampProjectTree(shifted, parentRange.startDate, parentRange.dueDate);
        }
        working = replaceProject(working, projectKey, shifted);
        onNodesChange(working);
      }
      setSelection({ type: 'project', key: projectKey });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const beginMilestonePointerDrag = (event: React.PointerEvent<HTMLElement>, milestoneId: string) => {
    if (event.button !== 0) return;
    const startX = event.clientX;
    let moved = false;
    const onMove = (moveEvent: PointerEvent) => {
      if (!moved && Math.abs(moveEvent.clientX - startX) > 4) {
        moved = true;
        setPointerDragging(milestoneId);
      }
    };
    const onUp = (upEvent: PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setPointerDragging(null);
      if (!moved) return;
      const lane = document.querySelector<HTMLElement>('[data-plan-milestone-lane]');
      if (!lane) return;
      const dueDate = dateFromClientX(lane, upEvent.clientX);
      onMilestonesChange(milestones.map((item) => item.id === milestoneId ? { ...item, dueDate } : item));
      setSelection({ type: 'milestone', id: milestoneId });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const startResize = (event: React.PointerEvent<HTMLButtonElement>, task: PlanTaskBlueprint) => {
    event.preventDefault();
    event.stopPropagation();
    const initialX = event.clientX;
    const initialDue = parseDate(task.dueDate) || range.startMs;
    const taskStart = parseDate(task.startDate || task.dueDate) || range.startMs;
    const initialMinutes = task.estimatedMinutes;
    const initialSpan = Math.max(1, Math.round((initialDue - taskStart) / DAY_MS) + 1);
    const onMove = (moveEvent: PointerEvent) => {
      const deltaDays = Math.round((moveEvent.clientX - initialX) / pixelsPerDay);
      const nextDue = Math.max(taskStart, initialDue + deltaDays * DAY_MS);
      const nextSpan = Math.max(1, Math.round((nextDue - taskStart) / DAY_MS) + 1);
      resizeTimelineTask(task.key, formatDate(nextDue), Math.min(1440, Math.max(5, Math.round((initialMinutes * nextSpan / initialSpan) / 5) * 5)));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const startProjectResize = (event: React.PointerEvent<HTMLButtonElement>, project: PlanNode) => {
    event.preventDefault();
    event.stopPropagation();
    const initialX = event.clientX;
    const current = projectWindow(project, settings.startDate);
    const startMs = parseDate(current.startDate) || range.startMs;
    const dueMs = parseDate(current.dueDate) || startMs;
    const onMove = (moveEvent: PointerEvent) => {
      const deltaDays = Math.round((moveEvent.clientX - initialX) / pixelsPerDay);
      resizeProjectWindow(project.key, formatDate(Math.max(startMs, dueMs + deltaDays * DAY_MS)));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const toggleWeekday = (weekday: number) => {
    const current = settings.activeWeekdays;
    const next = current.includes(weekday)
      ? (current.length === 1 ? current : current.filter((item) => item !== weekday))
      : [...current, weekday].sort((a, b) => (a === 0 ? 7 : a) - (b === 0 ? 7 : b));
    onSettingsChange('activeWeekdays', next);
  };

  return (
    <section className={`plan-timeline-composer${pointerDragging ? ' is-pointer-dragging' : ''}`} aria-label="轨道式计划草稿">
      <header className="plan-timeline-toolbar">
        <div>
          <strong>计划草稿时间线</strong>
          <span>拖入模块形成草稿，右键编辑，拖动右缘调整跨度</span>
        </div>
        <div className="plan-timeline-toolbar-actions">
          <button type="button" title="缩小时间线" onClick={() => setPixelsPerDay((value) => Math.max(12, value - 4))}><Minus /></button>
          <span>{pixelsPerDay <= 14 ? '月视图' : pixelsPerDay <= 22 ? '周视图' : '日视图'}</span>
          <button type="button" title="放大时间线" onClick={() => setPixelsPerDay((value) => Math.min(42, value + 4))}><Plus /></button>
          <button type="button" className="is-settings" onClick={() => setSelection({ type: 'plan' })}><Settings2 />计划条件</button>
        </div>
      </header>

      <div className="plan-timeline-layout">
        <aside className="plan-module-palette" aria-label="可插入模块">
          <div className="plan-module-palette-title"><Plus /><span><strong>插入模块</strong><small>拖入右侧轨道</small></span></div>
          {[
            { id: 'project', label: '项目阶段', hint: '生成二、三级项目', Icon: CalendarDays },
            { id: 'concept', label: '学习单元', hint: '课程、章节、概念', Icon: BookOpen },
            { id: 'practice', label: '练习单元', hint: '题目、实作、输出', Icon: CheckSquare },
            { id: 'review', label: '复习单元', hint: '回忆、测验、巩固', Icon: RefreshCcw },
          ].map(({ id, label, hint, Icon }) => (
            <button
              key={id}
              type="button"
              className={`plan-module-card is-${id}`}
              aria-pressed={pendingTemplate === id}
              onPointerDown={(event) => beginTemplatePointerDrag(event, id)}
              onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') setPendingTemplate((current) => current === id ? null : id); }}
            >
              <span><Icon /></span><div><strong>{label}</strong><small>{hint}</small></div><GripVertical />
            </button>
          ))}
          <p><GripVertical /> 拖拽模块，或先点模块再点轨道；已有模块可跨轨移动</p>
        </aside>

        <div className="plan-track-stage">
          <div className="plan-track-labels" aria-hidden="true">
            <div className="is-ruler">时间</div>
            <div className="is-project" style={{ height: projectLaneHeight }}><CalendarDays /><span><strong>计划</strong><small>上层覆盖下层</small></span></div>
            <div className="is-milestone"><Flag /><span><strong>里程碑</strong><small>验收节点</small></span></div>
            {TRACKS.map(({ kind, label, hint, icon: Icon }) => <div key={kind}><Icon /><span><strong>{label}</strong><small>{hint}</small></span></div>)}
          </div>
          <div className="plan-track-scroll">
            <div className="plan-track-canvas" style={{ width: range.width }}>
              <div className="plan-track-ruler">
                {weeks.map((week) => <div key={week.index} style={{ width: week.width }}><strong>第 {week.index + 1} 周</strong><small>{week.date.slice(5).replace('-', '.')}</small></div>)}
              </div>
              <div
                className={`plan-project-lane${pendingTemplate === 'project' ? ' is-drop-armed' : ''}`}
                data-plan-project-lane
                style={{ '--timeline-day-width': `${pixelsPerDay}px`, height: projectLaneHeight } as React.CSSProperties}
                onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }}
                onDrop={handleProjectDrop}
                onClick={(event) => { if (pendingTemplate === 'project') addTimelineProject(dateFromPointer(event), parentProjectAtPointer(event.currentTarget, event.clientX, event.clientY) || null); }}
              >
                {projects.filter(({ node }) => node.children.length > 0).map(({ node, depth }) => {
                  const window = projectWindow(node, settings.startDate);
                  const left = Math.max(0, dayDistance(formatDate(range.startMs), window.startDate) * pixelsPerDay);
                  const duration = Math.max(1, dayDistance(window.startDate, window.dueDate) + 1);
                  return <div key={`coverage-${node.key}`} className="plan-project-coverage" style={{ left, width: Math.max(100, duration * pixelsPerDay), top: 5 + depth * 40, height: (projectTreeDepth(node) + 1) * 40 }} />;
                })}
                {projects.map(({ node, depth }) => {
                  const window = projectWindow(node, settings.startDate);
                  const left = Math.max(0, dayDistance(formatDate(range.startMs), window.startDate) * pixelsPerDay);
                  const duration = Math.max(1, dayDistance(window.startDate, window.dueDate) + 1);
                  const width = Math.max(100, duration * pixelsPerDay);
                  return <article
                    key={node.key}
                    className={`plan-project-block${selection.type === 'project' && selection.key === node.key ? ' is-selected' : ''}`}
                    style={{ left, width, top: 8 + depth * 40 }}
                    tabIndex={0}
                    onPointerDown={(event) => beginProjectPointerDrag(event, node.key)}
                    onClick={(event) => { event.stopPropagation(); setSelection({ type: 'project', key: node.key }); }}
                    onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); setSelection({ type: 'project', key: node.key }); }}
                  ><CalendarDays /><div><strong>{node.title}</strong><small>{depth > 0 ? `三级项目 · ${window.startDate.slice(5)}—${window.dueDate.slice(5)}` : `二级项目 · ${window.startDate.slice(5)}—${window.dueDate.slice(5)}`}</small></div><button type="button" className="plan-project-resize" aria-label={`调整${node.title}的结束时间`} onPointerDown={(event) => startProjectResize(event, node)} /></article>;
                })}
                {projects.length === 0 && <span className="plan-track-empty-hint">上层放二级项目 · 在其时间范围的下层放三级项目</span>}
              </div>
              <div
                className="plan-milestone-lane"
                data-plan-milestone-lane
                tabIndex={0}
                aria-label="里程碑时间轨，右键建立节点"
                style={{ '--timeline-day-width': `${pixelsPerDay}px` } as React.CSSProperties}
                onMouseDown={(event) => { if (event.button === 2) { event.preventDefault(); addPendingMilestone(dateFromPointer(event)); } }}
                onClick={(event) => { if (event.shiftKey) addPendingMilestone(dateFromPointer(event)); }}
                onDoubleClick={(event) => addPendingMilestone(dateFromPointer(event))}
                onContextMenu={(event) => event.preventDefault()}
                onKeyDown={(event) => { if (event.key === 'Enter') addPendingMilestone(formatDate(range.startMs + Math.floor(range.totalDays / 2) * DAY_MS)); }}
              >
                {milestones.map((milestone) => {
                  const left = Math.max(0, dayDistance(formatDate(range.startMs), milestone.dueDate) * pixelsPerDay);
                  return <button key={milestone.id} type="button" className={`plan-milestone-marker${selection.type === 'milestone' && selection.id === milestone.id ? ' is-selected' : ''}`} style={{ left }} onPointerDown={(event) => beginMilestonePointerDrag(event, milestone.id)} onKeyDown={(event) => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); const offset = event.key === 'ArrowLeft' ? -1 : 1; onMilestonesChange(milestones.map((item) => item.id === milestone.id ? { ...item, dueDate: addDays(item.dueDate, offset) } : item)); } }} onClick={(event) => { event.stopPropagation(); setSelection({ type: 'milestone', id: milestone.id }); }} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); setSelection({ type: 'milestone', id: milestone.id }); }}><Flag /><span>{milestone.title}</span><small>{milestone.dueDate.slice(5)}</small></button>;
                })}
                {milestones.length === 0 && <span className="plan-track-empty-hint">右键建立里程碑时间节点 · Shift 单击可替代</span>}
              </div>
              {TRACKS.map(({ kind }) => {
                const laneTasks = tasks.filter(({ task }) => timelineKind(task.kind) === kind);
                return (
                  <div
                    key={kind}
                    className={`plan-task-lane is-${kind}${pendingTemplate && pendingTemplate !== 'milestone' && pendingTemplate !== 'project' ? ' is-drop-armed' : ''}`}
                    data-plan-lane={kind}
                    style={{ '--timeline-day-width': `${pixelsPerDay}px` } as React.CSSProperties}
                    onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }}
                    onDrop={(event) => handleLaneDrop(event, kind)}
                    onClick={(event) => { if (pendingTemplate && pendingTemplate !== 'milestone' && pendingTemplate !== 'project') addTimelineTask(pendingTemplate, kind, dateFromPointer(event)); }}
                  >
                    {laneTasks.map(({ phaseTitle, task }, laneIndex) => {
                      const start = task.startDate || task.dueDate;
                      const left = Math.max(0, dayDistance(formatDate(range.startMs), start) * pixelsPerDay);
                      const duration = Math.max(1, dayDistance(start, task.dueDate) + 1);
                      const width = Math.max(76, duration * pixelsPerDay);
                      return (
                        <article
                          key={task.key}
                          className={`plan-track-block is-${task.kind}${selection.type === 'task' && selection.key === task.key ? ' is-selected' : ''}`}
                          style={{ left, width, top: 9 + (laneIndex % 2) * 38 }}
                          title="拖动调整日期；右键编辑具体信息"
                          tabIndex={0}
                          onPointerDown={(event) => beginTaskPointerDrag(event, task.key)}
                          onClick={(event) => { event.stopPropagation(); setSelection({ type: 'task', key: task.key }); }}
                          onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); setSelection({ type: 'task', key: task.key }); }}
                        >
                          <span className="plan-track-block-grip"><GripVertical /></span>
                          <div><strong>{task.text}</strong><small>{phaseTitle} · {start.slice(5)}—{task.dueDate.slice(5)}</small></div>
                          <button type="button" className="plan-track-resize" aria-label={`调整${task.text}的结束时间`} onPointerDown={(event) => startResize(event, task)} />
                        </article>
                      );
                    })}
                    {laneTasks.length === 0 && <span className="plan-track-empty-hint">拖入模块开始编排</span>}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <aside className="plan-timeline-inspector">
          {selectedProject && (
            <>
              <header><span className="is-project"><CalendarDays /></span><div><strong>项目结构属性</strong><small>正式写入后生成真实项目笔记</small></div></header>
              <label><span>项目名称</span><input value={selectedProject.node.title} onChange={(event) => onNodesChange(updateProject(nodes, selectedProject.node.key, { title: event.target.value }))} /></label>
              <div className="plan-inspector-grid">
                <label><span>开始日期</span><input type="date" min={selectedProjectParent ? projectWindow(selectedProjectParent, settings.startDate).startDate : settings.startDate} max={selectedProjectParent ? projectWindow(selectedProjectParent, settings.startDate).dueDate : undefined} value={projectWindow(selectedProject.node, settings.startDate).startDate} onChange={(event) => moveProjectWindow(selectedProject.node.key, event.target.value)} /></label>
                <label><span>结束日期</span><input type="date" min={selectedProject.node.startDate || settings.startDate} max={selectedProjectParent ? projectWindow(selectedProjectParent, settings.startDate).dueDate : undefined} value={projectWindow(selectedProject.node, settings.startDate).dueDate} onChange={(event) => resizeProjectWindow(selectedProject.node.key, event.target.value)} /></label>
              </div>
              <label><span>上级项目（精确修正）</span><select value={selectedProject.parentKey || ''} onChange={(event) => onNodesChange(moveProject(nodes, selectedProject.node.key, event.target.value || undefined, settings.startDate))}><option value="">根计划（二级项目）</option>{projects.filter((project) => project.depth === 0 && project.node.key !== selectedProject.node.key && !projectDescendantKeys(selectedProject.node).includes(project.node.key)).map((project) => <option key={project.node.key} value={project.node.key}>{project.node.title}</option>)}</select></label>
              <label><span>阶段成果</span><textarea value={selectedProject.node.outcome || ''} onChange={(event) => onNodesChange(updateProject(nodes, selectedProject.node.key, { outcome: event.target.value || undefined }))} placeholder="这个项目结束时应形成什么可验证结果" /></label>
              <div className="plan-project-structure-note"><CalendarDays /><span><strong>{selectedProject.depth > 0 ? '将创建三级项目笔记' : '将创建二级项目笔记'}</strong><small>{selectedProject.node.children.length} 个子项目 · {(selectedProject.node.tasks || []).length} 个直属任务</small></span></div>
              <button type="button" className="plan-inspector-delete" onClick={removeSelection}><Trash2 />删除项目及其子项目</button>
            </>
          )}

          {selectedTask && (
            <>
              <header><span className={`is-${selectedTask.task.kind}`}><SlidersHorizontal /></span><div><strong>任务属性</strong><small>右键打开 · 即时写回草稿</small></div></header>
              <label><span>任务名称</span><input value={selectedTask.task.text} onChange={(event) => updateTask(selectedTask.task.key, { text: event.target.value })} /></label>
              <div className="plan-inspector-grid">
                <label><span>所在轨道</span><select value={timelineKind(selectedTask.task.kind)} onChange={(event) => updateTask(selectedTask.task.key, { kind: event.target.value as Exclude<PlanTaskKind, 'assessment'> })}><option value="learn">学习</option><option value="practice">练习</option><option value="review">复习</option></select></label>
                <label><span>优先级</span><select value={selectedTask.task.priority || 'medium'} onChange={(event) => updateTask(selectedTask.task.key, { priority: event.target.value as 'high' | 'medium' | 'low' })}><option value="high">高</option><option value="medium">中</option><option value="low">低</option></select></label>
                <label><span>开始日期</span><input type="date" value={selectedTask.task.startDate || selectedTask.task.dueDate} onChange={(event) => moveTimelineTask(selectedTask.task.key, timelineKind(selectedTask.task.kind), event.target.value)} /></label>
                <label><span>结束日期</span><input type="date" min={selectedTask.task.startDate || undefined} value={selectedTask.task.dueDate} onChange={(event) => resizeTimelineTask(selectedTask.task.key, event.target.value)} /></label>
              </div>
              <label><span>所属项目笔记</span><select value={selectedTask.phaseKey} onChange={(event) => reassignTaskToProject(selectedTask.task.key, event.target.value)}>{projects.map((project) => <option key={project.node.key} value={project.node.key}>{'　'.repeat(Math.min(project.depth, 2))}{project.node.title}</option>)}</select></label>
              <label><span>预计投入（分钟）</span><StudyMinutesInput key={selectedTask.task.key} value={selectedTask.task.estimatedMinutes} onValueChange={value => updateTask(selectedTask.task.key, { estimatedMinutes: value! })} /></label>
              <div className="plan-inspector-shared"><Clock3 /><span><strong>计划约束仍会生效</strong><small>每周 {settings.weeklyBudgetMinutes} 分钟 · {settings.activeWeekdays.length} 个学习日</small></span><button type="button" onClick={() => setSelection({ type: 'plan' })}>调整</button></div>
              <button type="button" className="plan-inspector-delete" onClick={() => { onNodesChange(deleteTask(nodes, selectedTask.task.key)); setSelection({ type: 'plan' }); }}><Trash2 />删除任务</button>
            </>
          )}

          {selectedMilestone && (
            <>
              <header><span className="is-milestone"><Flag /></span><div><strong>里程碑属性</strong><small>用于阶段验收，不占任务容量</small></div></header>
              <label><span>里程碑名称</span><input value={selectedMilestone.title} onChange={(event) => onMilestonesChange(milestones.map((item) => item.id === selectedMilestone.id ? { ...item, title: event.target.value } : item))} /></label>
              <label><span>时间节点</span><input type="date" value={selectedMilestone.dueDate} onChange={(event) => onMilestonesChange(milestones.map((item) => item.id === selectedMilestone.id ? { ...item, dueDate: event.target.value } : item))} /></label>
              <label><span>验收标准</span><textarea value={(selectedMilestone.criteria || []).join('\n')} onChange={(event) => onMilestonesChange(milestones.map((item) => item.id === selectedMilestone.id ? { ...item, criteria: event.target.value.split('\n').map((line) => line.trim()).filter(Boolean) } : item))} placeholder="每行一条可验证标准" /></label>
              <label><span>归属项目</span><select value={selectedMilestone.projectId || ''} onChange={(event) => onMilestonesChange(milestones.map((item) => item.id === selectedMilestone.id ? { ...item, projectId: event.target.value || undefined } : item))}><option value="">整个计划</option>{projects.map((project) => <option key={project.node.key} value={project.node.key}>{'　'.repeat(Math.min(project.depth, 2))}{project.node.title}</option>)}</select></label>
              <button type="button" className="plan-inspector-delete" onClick={() => { onMilestonesChange(milestones.filter((item) => item.id !== selectedMilestone.id)); setSelection({ type: 'plan' }); }}><Trash2 />删除里程碑</button>
            </>
          )}

          {selection.type === 'plan' && (
            <>
              <header><span className="is-plan"><Settings2 /></span><div><strong>计划条件</strong><small>不是必填表单，而是整条时间线的约束</small></div></header>
              <div className="plan-inspector-grid">
                <label><span>开始日期</span><input type="date" value={settings.startDate} onChange={(event) => onSettingsChange('startDate', event.target.value)} /></label>
                <label><span>目标日期</span><input type="date" min={settings.startDate} value={settings.targetDate} onChange={(event) => onSettingsChange('targetDate', event.target.value)} /></label>
                <label><span>每周预算</span><input type="number" min={60} step={30} value={settings.weeklyBudgetMinutes} onChange={(event) => onSettingsChange('weeklyBudgetMinutes', Math.max(60, Number(event.target.value) || 60))} /></label>
                <label><span>单次时长</span><select value={settings.preferredSessionMinutes} onChange={(event) => onSettingsChange('preferredSessionMinutes', Number(event.target.value))}>{[25, 30, 45, 60, 90, 120].map((minutes) => <option key={minutes} value={minutes}>{minutes} 分钟</option>)}</select></label>
              </div>
              <div className="plan-inspector-weekdays"><span>学习日</span><div>{WEEKDAYS.map((day) => <button type="button" key={day.value} className={settings.activeWeekdays.includes(day.value) ? 'is-active' : ''} aria-pressed={settings.activeWeekdays.includes(day.value)} onClick={() => toggleWeekday(day.value)}>{day.label}</button>)}</div></div>
              <div className="plan-inspector-grid">
                <label><span>当前基础</span><select value={settings.startingLevel} onChange={(event) => onSettingsChange('startingLevel', event.target.value as PlanStartingLevel)}>{Object.entries(STARTING_LEVEL_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                <label><span>计划节奏</span><select value={settings.pace} onChange={(event) => onSettingsChange('pace', event.target.value as PlanPace)}>{Object.entries(PACE_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                <label><span>截止性质</span><select value={settings.deadlineMode} onChange={(event) => onSettingsChange('deadlineMode', event.target.value as NonNullable<PlanConditions['deadlineMode']>)}><option value="flexible">弹性截止</option><option value="hard">硬截止</option></select></label>
                <label><span>复习密度</span><select value={settings.reviewCadence} onChange={(event) => onSettingsChange('reviewCadence', event.target.value as NonNullable<PlanConditions['reviewCadence']>)}><option value="light">轻量</option><option value="standard">标准</option><option value="intensive">密集</option></select></label>
                <label><span>偏好时段</span><select value={settings.preferredTimeOfDay} onChange={(event) => onSettingsChange('preferredTimeOfDay', event.target.value as NonNullable<PlanConditions['preferredTimeOfDay']>)}><option value="flexible">灵活</option><option value="morning">上午</option><option value="afternoon">下午</option><option value="evening">晚间</option></select></label>
                <label><span>自动调整</span><select value={settings.autoAdjustPolicy} onChange={(event) => onSettingsChange('autoAdjustPolicy', event.target.value as NonNullable<PlanMeta['autoAdjustPolicy']>)}><option value="ask">调整前询问</option><option value="automatic">自动再平衡</option><option value="off">关闭</option></select></label>
              </div>
              <label><span>完成证据</span><textarea value={settings.goalEvidence} onChange={(event) => onSettingsChange('goalEvidence', event.target.value)} placeholder="例如：完成可运行作品并通过一次限时测验" /></label>
              <label><span>其他约束</span><textarea value={settings.constraintNotes} onChange={(event) => onSettingsChange('constraintNotes', event.target.value)} placeholder="例如：周三晚不安排任务" /></label>
            </>
          )}
        </aside>
      </div>

      <footer className={`plan-timeline-status${assessment.blocking ? ' is-blocking' : ''}`}>
        <div><CalendarDays /><span><strong>{assessment.blocking ? '草稿存在排期冲突' : (tasks.length || projects.length) ? '草稿可以继续调整' : '等待插入第一个模块'}</strong><small>正式写入：1 个根计划 · {projects.filter((project) => project.depth === 0).length} 个二级项目 · {projects.filter((project) => project.depth > 0).length} 个三级项目 · {assessment.totalEstimatedMinutes} 分钟任务{assessment.effectiveCapacityMinutes !== null ? ` / ${assessment.effectiveCapacityMinutes} 分钟有效容量` : ''}</small></span></div>
        {assessment.issues.length > 0 && <ul>{assessment.issues.slice(0, 2).map((issue) => <li key={issue.code}>{issue.message}</li>)}</ul>}
      </footer>
    </section>
  );
};
