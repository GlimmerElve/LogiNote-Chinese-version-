import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { hasActiveDialog, isTextInput } from './useDialog';
import { StudyMinutesInput } from './StudyMinutesInput';
import { executionRepeats, updateExecutionDates } from '../services/planExecutionDates';
import {
  CalendarDays,
  ChevronDown,
  ChevronRight,
  Clock3,
  Flag,
  FolderTree,
  GripVertical,
  Layers3,
  LibraryBig,
  Minus,
  Maximize2,
  Plus,
  Repeat2,
  Search,
  Settings2,
  Trash2,
  Undo2,
  Redo2,
} from 'lucide-react';
import type { PlanConditionAssessment } from '../services/planConditionService';
import {
  getTimelineAutoScrollDistance, getTimelineBlockWidth, getTimelineDayZoomScrollLeft,
  getTimelineGestureDays, getTimelinePointerOutline, getTimelineVisibleBounds, packTimelineIntervals,
  PLAN_COMPOSER_ZOOM_STOPS, resizeTimelineWindow, type TimelinePackedRow,
} from '../services/planTimelineInteraction';
import type {
  PlanConditions,
  PlanExecutionKind,
  PlanMeta,
  PlanMilestone,
  PlanNode,
  PlanProjectCandidate,
  PlanPace,
  PlanStartingLevel,
  PlanTaskBlueprint,
  PlanTaskKind,
} from '../types';

const DAY_MS = 86_400_000;
const ROW_HEIGHT = 54;
const MIN_DAYS = 42;
const ROW_LABEL_WIDTH = 96;
const BLOCK_HEIGHT = 46;
const BLOCK_LANE_GAP = 4;
const BLOCK_ROW_PADDING = 9;
const WEEKDAYS = [
  { value: 1, label: '一' }, { value: 2, label: '二' }, { value: 3, label: '三' },
  { value: 4, label: '四' }, { value: 5, label: '五' }, { value: 6, label: '六' },
  { value: 0, label: '日' },
];

const packedRowHeight = (laneCount: number): number => (
  BLOCK_ROW_PADDING * 2 + laneCount * BLOCK_HEIGHT + Math.max(0, laneCount - 1) * BLOCK_LANE_GAP
);

const packedBlockTop = (lane: number): number => BLOCK_ROW_PADDING + lane * (BLOCK_HEIGHT + BLOCK_LANE_GAP);

export interface PlanTimelineSettings {
  startDate: string;
  targetDate: string;
  weeklyBudgetMinutes: number;
  dailyStudyMinutes?: number;
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

interface ProjectRef {
  node: PlanNode;
  parentKey?: string;
  depth: number;
}

type Selection =
  | { type: 'plan' }
  | { type: 'project'; key: string }
  | { type: 'execution'; key: string }
  | { type: 'milestone'; id: string };

interface TimelinePreview {
  key: string;
  mode: 'move' | 'resize-start' | 'resize-end';
  kind: 'project' | 'execution' | 'milestone';
  rowIndex: number;
  title: string;
  startDate: string;
  dueDate: string;
  nodes?: PlanNode[];
  tasks?: PlanTaskBlueprint[];
  milestones?: PlanMilestone[];
  /** Sub-day travel belongs to the pointer outline, never the solid date-snapped block. */
  pixelRemainder: number;
  affectedKeys: string[];
}

interface PlanDualTrackComposerProps {
  isActive?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  nodes: PlanNode[];
  rootProjectKey?: string;
  existingProjects?: PlanProjectCandidate[];
  executionTasks: PlanTaskBlueprint[];
  milestones: PlanMilestone[];
  settings: PlanTimelineSettings;
  assessment: PlanConditionAssessment;
  onNodesChange: (nodes: PlanNode[]) => void;
  onExecutionTasksChange: (tasks: PlanTaskBlueprint[]) => void;
  onMilestonesChange: (milestones: PlanMilestone[]) => void;
  onSettingsChange: <K extends keyof PlanTimelineSettings>(key: K, value: PlanTimelineSettings[K]) => void;
}

const parseDate = (value?: string): number | null => {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const result = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(result) ? result : null;
};

const formatDate = (timestamp: number): string => new Date(timestamp).toISOString().slice(0, 10);
const addDays = (value: string, days: number): string => formatDate((parseDate(value) || Date.now()) + days * DAY_MS);
const dayDistance = (start: string, end: string): number => Math.round(((parseDate(end) || 0) - (parseDate(start) || 0)) / DAY_MS);

function flattenProjects(nodes: PlanNode[], parentKey?: string, depth = 0): ProjectRef[] {
  return nodes.flatMap((node) => [
    { node, parentKey, depth },
    ...flattenProjects(node.children || [], node.key, depth + 1),
  ]);
}

function projectWindow(node: PlanNode, fallback: string): { startDate: string; dueDate: string } {
  return {
    startDate: node.startDate || fallback,
    dueDate: node.dueDate || addDays(node.startDate || fallback, 13),
  };
}

function updateProject(nodes: PlanNode[], key: string, updater: (node: PlanNode) => PlanNode): PlanNode[] {
  return nodes.map((node) => node.key === key
    ? updater(node)
    : { ...node, children: updateProject(node.children || [], key, updater) });
}

function detachProject(nodes: PlanNode[], key: string): { nodes: PlanNode[]; detached?: PlanNode } {
  let detached: PlanNode | undefined;
  const next = nodes.flatMap((node) => {
    if (node.key === key) {
      detached = node;
      return [];
    }
    const nested = detachProject(node.children || [], key);
    if (nested.detached) detached = nested.detached;
    return [{ ...node, children: nested.nodes }];
  });
  return { nodes: next, detached };
}

function descendantKeys(node: PlanNode): string[] {
  return (node.children || []).flatMap((child) => [child.key, ...descendantKeys(child)]);
}

function shiftTree(node: PlanNode, days: number, fallback: string): PlanNode {
  const range = projectWindow(node, fallback);
  return {
    ...node,
    startDate: addDays(range.startDate, days),
    dueDate: addDays(range.dueDate, days),
    children: (node.children || []).map((child) => shiftTree(child, days, fallback)),
  };
}

function clampTree(node: PlanNode, parentStartDate: string, parentDueDate: string): PlanNode {
  const range = projectWindow(node, parentStartDate);
  const parentStart = parseDate(parentStartDate) || 0;
  const parentDue = Math.max(parentStart, parseDate(parentDueDate) || parentStart);
  const duration = Math.max(1, dayDistance(range.startDate, range.dueDate) + 1);
  const latestStart = Math.max(parentStart, parentDue - (duration - 1) * DAY_MS);
  const start = Math.max(parentStart, Math.min(parseDate(range.startDate) || parentStart, latestStart));
  const due = Math.min(parentDue, start + (duration - 1) * DAY_MS);
  const startDate = formatDate(start);
  const dueDate = formatDate(due);
  return {
    ...node,
    startDate,
    dueDate,
    children: (node.children || []).map((child) => clampTree(child, startDate, dueDate)),
  };
}

function insertProject(nodes: PlanNode[], project: PlanNode, parentKey?: string): PlanNode[] {
  if (!parentKey) return [...nodes, project];
  return updateProject(nodes, parentKey, (parent) => ({
    ...parent,
    children: [...(parent.children || []), project],
  }));
}

function executionKindToTaskKind(kind: PlanExecutionKind): PlanTaskKind {
  if (kind === 'practice') return 'practice';
  if (kind === 'review') return 'review';
  return 'learn';
}

export const PlanDualTrackComposer: React.FC<PlanDualTrackComposerProps> = ({
  isActive = true, onUndo, onRedo, canUndo = false, canRedo = false,
  nodes,
  rootProjectKey,
  existingProjects = [],
  executionTasks,
  milestones,
  settings,
  assessment,
  onNodesChange,
  onExecutionTasksChange,
  onMilestonesChange,
  onSettingsChange,
}) => {
  const [selection, setSelection] = useState<Selection>({ type: 'plan' });
  const composerRef = useRef<HTMLElement>(null);
  const [pending, setPending] = useState<'project' | 'execution' | null>(null);
  const [pixelsPerDay, setPixelsPerDay] = useState(20);
  const [visibleStructureRows, setVisibleStructureRows] = useState(2);
  const [executionRows, setExecutionRows] = useState(2);
  const [pointerDragging, setPointerDragging] = useState<string | null>(null);
  const [interactionPreview, setInteractionPreview] = useState<TimelinePreview | null>(null);
  const [existingPickerOpen, setExistingPickerOpen] = useState(false);
  const [existingSearch, setExistingSearch] = useState('');
  const [timelineViewportWidth, setTimelineViewportWidth] = useState(0);
  const timelineScrollRef = useRef<HTMLDivElement>(null);
  const inspectorRef = useRef<HTMLElement>(null);
  const gestureCleanupRef = useRef<(() => void) | null>(null);
  const suppressClickUntilRef = useRef(0);
  const previousZoomRef = useRef<number | null>(null);

  const sourceProjects = useMemo(() => flattenProjects(nodes), [nodes]);
  const displayedNodes = interactionPreview?.nodes || nodes;
  const displayedExecutions = interactionPreview?.tasks || executionTasks;
  const displayedMilestones = interactionPreview?.milestones || milestones;

  const projects = useMemo(() => flattenProjects(displayedNodes), [displayedNodes]);
  useEffect(() => {
    if ((selection.type === 'project' && !sourceProjects.some(({ node }) => node.key === selection.key))
      || (selection.type === 'execution' && !executionTasks.some((task) => task.key === selection.key))
      || (selection.type === 'milestone' && !milestones.some((milestone) => milestone.id === selection.id))) {
      setSelection({ type: 'plan' });
    }
  }, [selection, sourceProjects, executionTasks, milestones]);
  const zoomStops = useMemo(() => {
    const dayTitles = [
      ...sourceProjects.filter(({ node }) => node.startDate === node.dueDate).map(({ node }) => node.title),
      ...executionTasks.filter((task) => (task.startDate || task.dueDate) === task.dueDate).map((task) => task.text),
    ];
    // The largest day column reserves room for two readable lines, even for long Chinese titles.
    const readableWidth = Math.max(480, ...dayTitles.map((title) => Math.ceil(title.length * 13 / 2 + 64)));
    return readableWidth > 480 ? [...PLAN_COMPOSER_ZOOM_STOPS, readableWidth] : PLAN_COMPOSER_ZOOM_STOPS;
  }, [sourceProjects, executionTasks]);
  const maximumDepth = sourceProjects.reduce((max, project) => Math.max(max, project.depth), 0);
  const hiddenProjectCount = sourceProjects.filter((project) => project.depth >= visibleStructureRows).length;
  const scheduledProjectIds = useMemo(() => new Set(projects.map((project) => project.node.key)), [projects]);
  const unscheduledProjects = useMemo(() => existingProjects.filter((project) => !scheduledProjectIds.has(project.key)), [existingProjects, scheduledProjectIds]);
  const visibleUnscheduledProjects = useMemo(() => {
    const query = existingSearch.trim().toLocaleLowerCase();
    return unscheduledProjects.filter((project) => !query || project.title.toLocaleLowerCase().includes(query) || project.path.toLocaleLowerCase().includes(query));
  }, [existingSearch, unscheduledProjects]);

  useEffect(() => {
    // 二、三、四级项目默认可见；五级及以后默认折叠，但不限制实际深度。
    setVisibleStructureRows((current) => Math.max(current, Math.min(3, maximumDepth + 1)));
  }, [maximumDepth]);

  useEffect(() => {
    // 周期任务默认预留两条并行轨道；生成结果指定了更深行时自动展开，避免任务被隐藏。
    const requiredRows = executionTasks.reduce((maximum, task) => Math.max(maximum, (task.displayRow || 0) + 1), 2);
    setExecutionRows((current) => Math.max(current, requiredRows));
  }, [executionTasks]);

  useEffect(() => {
    const element = timelineScrollRef.current;
    if (!element) return undefined;
    const measure = () => setTimelineViewportWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const range = useMemo(() => {
    const startMs = parseDate(settings.startDate) || Date.now();
    const allEnds = [
      parseDate(settings.targetDate),
      ...sourceProjects.map(({ node }) => parseDate(projectWindow(node, settings.startDate).dueDate)),
      ...executionTasks.map((task) => parseDate(task.dueDate)),
      ...milestones.map((milestone) => parseDate(milestone.dueDate)),
    ].filter((value): value is number => value !== null);
    const latest = allEnds.length ? Math.max(...allEnds) : startMs;
    const minimumVisibleDays = timelineViewportWidth > ROW_LABEL_WIDTH
      ? Math.ceil((timelineViewportWidth - ROW_LABEL_WIDTH) / pixelsPerDay)
      : MIN_DAYS;
    const endMs = Math.max(startMs + (MIN_DAYS - 1) * DAY_MS, latest + 7 * DAY_MS);
    const totalDays = Math.max(MIN_DAYS, minimumVisibleDays, Math.round((endMs - startMs) / DAY_MS) + 1);
    return { startMs, totalDays, width: ROW_LABEL_WIDTH + totalDays * pixelsPerDay };
  }, [settings.startDate, settings.targetDate, sourceProjects, executionTasks, milestones, pixelsPerDay, timelineViewportWidth]);

  useLayoutEffect(() => {
    const scroll = timelineScrollRef.current;
    const previous = previousZoomRef.current;
    if (scroll && previous && previous !== pixelsPerDay) {
      scroll.scrollLeft = getTimelineDayZoomScrollLeft(
        scroll.scrollLeft, scroll.clientWidth, ROW_LABEL_WIDTH, previous, pixelsPerDay, range.width,
      );
    }
    previousZoomRef.current = pixelsPerDay;
  }, [range.width, pixelsPerDay]);

  useEffect(() => () => gestureCleanupRef.current?.(), []);
  useLayoutEffect(() => {
    if (inspectorRef.current) inspectorRef.current.scrollTop = 0;
  }, [selection.type, selection.type === 'plan' ? '' : selection.type === 'milestone' ? selection.id : selection.key]);

  const changeZoom = (direction: -1 | 1) => {
    const next = direction > 0 ? zoomStops.find((stop) => stop > pixelsPerDay)
      : [...zoomStops].reverse().find((stop) => stop < pixelsPerDay);
    if (next !== undefined) setPixelsPerDay(next);
  };
  const fitTimeline = () => {
    const plannedDays = Math.max(MIN_DAYS, ...[
      settings.targetDate,
      ...sourceProjects.map(({ node }) => projectWindow(node, settings.startDate).dueDate),
      ...executionTasks.map((task) => task.dueDate), ...milestones.map((item) => item.dueDate),
    ].filter(Boolean).map((date) => dayDistance(settings.startDate, date) + 8));
    const fitted = Math.max(zoomStops[0], (timelineViewportWidth - ROW_LABEL_WIDTH) / plannedDays);
    setPixelsPerDay([...zoomStops].reverse().find((stop) => stop <= fitted) || zoomStops[0]);
  };

  const weeks = useMemo(() => Array.from({ length: Math.ceil(range.totalDays / 7) }, (_, index) => ({
    index,
    date: formatDate(range.startMs + index * 7 * DAY_MS),
    width: Math.min(7, range.totalDays - index * 7) * pixelsPerDay,
  })), [range, pixelsPerDay]);
  const days = useMemo(() => Array.from({ length: range.totalDays }, (_, index) => {
    const timestamp = range.startMs + index * DAY_MS;
    const date = formatDate(timestamp);
    return { date, weekday: ['日', '一', '二', '三', '四', '五', '六'][new Date(timestamp).getUTCDay()] };
  }), [range]);
  const showDayScale = pixelsPerDay >= 24;

  const selectedProject = selection.type === 'project' ? projects.find((project) => project.node.key === selection.key) : undefined;
  const selectedExecution = selection.type === 'execution' ? displayedExecutions.find((task) => task.key === selection.key) : undefined;
  const selectedMilestone = selection.type === 'milestone' ? displayedMilestones.find((milestone) => milestone.id === selection.id) : undefined;

  const dateFromClientX = (element: HTMLElement, clientX: number): string => {
    const rect = element.getBoundingClientRect();
    const offset = Math.max(0, Math.min(rect.width - ROW_LABEL_WIDTH, clientX - rect.left - ROW_LABEL_WIDTH));
    const day = Math.max(0, Math.min(range.totalDays - 1, Math.floor(offset / pixelsPerDay)));
    return formatDate(range.startMs + day * DAY_MS);
  };

  const parentAt = (depth: number, date: string, excluded = new Set<string>(), preferredKey?: string): ProjectRef | undefined => {
    if (depth <= 0) return undefined;
    const candidates = projects.filter((project) => project.depth === depth - 1 && !excluded.has(project.node.key));
    const containing = candidates.filter((project) => {
      const window = projectWindow(project.node, settings.startDate);
      return window.startDate <= date && window.dueDate >= date;
    });
    const preferred = containing.find((project) => project.node.key === preferredKey);
    if (preferred) return preferred;
    if (containing.length > 0) return containing[0];
    const target = parseDate(date) || range.startMs;
    return [...candidates].sort((a, b) => {
      const distance = (project: ProjectRef) => {
        const window = projectWindow(project.node, settings.startDate);
        const start = parseDate(window.startDate) || target;
        const end = parseDate(window.dueDate) || start;
        return target < start ? start - target : target > end ? target - end : 0;
      };
      return distance(a) - distance(b);
    })[0];
  };

  const addProject = (depth: number, date: string) => {
    const preferredParentKey = selection.type === 'project' ? selection.key : undefined;
    const parent = parentAt(depth, date, new Set<string>(), preferredParentKey);
    if (depth > 0 && !parent) return;
    const parentRange = parent ? projectWindow(parent.node, settings.startDate) : undefined;
    const startDate = parentRange
      ? formatDate(Math.max(parseDate(parentRange.startDate) || 0, Math.min(parseDate(date) || 0, parseDate(parentRange.dueDate) || 0)))
      : date;
    const dueDate = parentRange && addDays(startDate, 13) > parentRange.dueDate ? parentRange.dueDate : addDays(startDate, 13);
    const project: PlanNode = {
      key: `project-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      title: `新的${depth + 2}级项目`,
      startDate,
      dueDate,
      priority: settings.portfolioPriority,
      outcome: '',
      tasks: [],
      children: [],
    };
    onNodesChange(insertProject(nodes, project, parent?.node.key));
    setVisibleStructureRows((current) => Math.max(current, depth + 1));
    setSelection({ type: 'project', key: project.key });
    setPending(null);
  };

  const existingProjectParent = (project: PlanProjectCandidate): ProjectRef | undefined => (
    project.parentKey === rootProjectKey ? undefined : projects.find((item) => item.node.key === project.parentKey)
  );

  const canScheduleExistingProject = (project: PlanProjectCandidate): boolean => (
    Boolean(rootProjectKey) && (project.parentKey === rootProjectKey || scheduledProjectIds.has(project.parentKey))
  );

  const scheduleExistingProject = (project: PlanProjectCandidate, requestedDate?: string) => {
    if (!canScheduleExistingProject(project)) return;
    const parent = existingProjectParent(project);
    const parentRange = parent ? projectWindow(parent.node, settings.startDate) : undefined;
    const desiredStart = requestedDate || project.startDate || parentRange?.startDate || settings.startDate;
    const startDate = parentRange
      ? formatDate(Math.max(parseDate(parentRange.startDate) || 0, Math.min(parseDate(desiredStart) || 0, parseDate(parentRange.dueDate) || 0)))
      : desiredStart;
    const originalDuration = project.startDate && project.dueDate ? Math.max(1, dayDistance(project.startDate, project.dueDate) + 1) : 14;
    const candidateDueDate = requestedDate ? addDays(startDate, originalDuration - 1) : project.dueDate || addDays(startDate, originalDuration - 1);
    const desiredDueDate = candidateDueDate < startDate ? startDate : candidateDueDate;
    const dueDate = parentRange && desiredDueDate > parentRange.dueDate ? parentRange.dueDate : desiredDueDate;
    const node: PlanNode = {
      key: project.key,
      title: project.title,
      startDate,
      dueDate,
      priority: project.priority,
      children: [],
    };
    onNodesChange(insertProject(nodes, node, parent?.node.key));
    setVisibleStructureRows((current) => Math.max(current, project.depth + 1));
    setSelection({ type: 'project', key: project.key });
  };

  const projectMoveResult = (key: string, depth: number, date: string) => {
    const current = projects.find((project) => project.node.key === key);
    if (!current) return;
    const blocked = new Set([key, ...descendantKeys(current.node)]);
    const parent = parentAt(depth, date, blocked, current.parentKey);
    if (depth > 0 && !parent) return;
    const currentRange = projectWindow(current.node, settings.startDate);
    const desiredDate = depth === 0 && date < settings.startDate ? settings.startDate : date;
    const shifted = shiftTree(current.node, dayDistance(currentRange.startDate, desiredDate), settings.startDate);
    const bounded = parent
      ? clampTree(shifted, projectWindow(parent.node, settings.startDate).startDate, projectWindow(parent.node, settings.startDate).dueDate)
      : settings.targetDate ? clampTree(shifted, settings.startDate, settings.targetDate) : shifted;
    const detached = detachProject(nodes, key);
    return { nodes: insertProject(detached.nodes, bounded, parent?.node.key), node: bounded, parent };
  };

  const moveProject = (key: string, depth: number, date: string) => {
    const result = projectMoveResult(key, depth, date);
    if (!result) return;
    onNodesChange(result.nodes);
    setVisibleStructureRows((value) => Math.max(value, depth + 1));
    setSelection({ type: 'project', key });
  };

  const resizeProject = (key: string, date: string, edge: 'start' | 'end' = 'end') => {
    if (parseDate(date) === null) return;
    const ref = projects.find((project) => project.node.key === key);
    if (!ref) return;
    const rangeValue = projectWindow(ref.node, settings.startDate);
    const parent = ref.parentKey ? projects.find((project) => project.node.key === ref.parentKey) : undefined;
    const parentRange = parent ? projectWindow(parent.node, settings.startDate) : { startDate: settings.startDate, dueDate: settings.targetDate };
    const nextRange = resizeTimelineWindow(rangeValue.startDate, rangeValue.dueDate,
      dayDistance(edge === 'start' ? rangeValue.startDate : rangeValue.dueDate, date), edge,
      parentRange.startDate, parentRange.dueDate || undefined);
    onNodesChange(updateProject(nodes, key, (node) => ({
      ...node,
      startDate: nextRange.startDate,
      dueDate: nextRange.dueDate,
      children: (node.children || []).map((child) => clampTree(child, nextRange.startDate, nextRange.dueDate)),
    })));
  };

  const addExecution = (row: number, startDate: string) => {
    const task: PlanTaskBlueprint = {
      key: `execution-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      text: '新的周期待办',
      kind: 'practice',
      executionKind: 'todo',
      startDate,
      dueDate: settings.targetDate || addDays(startDate, 27),
      estimatedMinutes: settings.preferredSessionMinutes,
      priority: 'medium',
      recurrence: { frequency: 'daily', interval: 1, missedPolicy: 'rollover', endDate: settings.targetDate || addDays(startDate, 27) },
      launchMode: 'none',
      displayRow: row,
      source: 'manual',
    };
    onExecutionTasksChange([...executionTasks, task]);
    setExecutionRows((current) => Math.max(current, row + 1));
    setSelection({ type: 'execution', key: task.key });
    setPending(null);
  };

  const updateExecution = (key: string, patch: Partial<PlanTaskBlueprint>) => {
    onExecutionTasksChange(executionTasks.map((task) => task.key === key ? updateExecutionDates(task, patch) : task));
  };

  const moveExecution = (key: string, row: number, startDate: string) => {
    const task = executionTasks.find((item) => item.key === key);
    if (!task) return;
    const duration = Math.max(1, dayDistance(task.startDate || task.dueDate, task.dueDate) + 1);
    updateExecution(key, { startDate, dueDate: addDays(startDate, duration - 1), displayRow: row });
    setExecutionRows((current) => Math.max(current, row + 1));
    setSelection({ type: 'execution', key });
  };

  const addMilestone = (date: string) => {
    const milestone: PlanMilestone = {
      id: `milestone-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      title: '新的里程碑',
      dueDate: date,
      criteria: [],
      completed: false,
    };
    onMilestonesChange([...milestones, milestone]);
    setSelection({ type: 'milestone', id: milestone.id });
  };

  const moveMilestone = (id: string, dueDate: string) => {
    onMilestonesChange(milestones.map((milestone) => milestone.id === id ? { ...milestone, dueDate } : milestone));
    setSelection({ type: 'milestone', id });
  };

  const focusComposer = () => {
    const composer = composerRef.current;
    if (isActive && composer && !composer.closest('[inert]') && !hasActiveDialog()) {
      composer.focus({ preventScroll: true });
    }
  };

  const removeSelection = () => {
    if (selection.type === 'project') onNodesChange(detachProject(nodes, selection.key).nodes);
    if (selection.type === 'execution') onExecutionTasksChange(executionTasks.filter((task) => task.key !== selection.key));
    if (selection.type === 'milestone') onMilestonesChange(milestones.filter((milestone) => milestone.id !== selection.id));
    setSelection({ type: 'plan' });
    // A removed block cannot retain focus. Keep subsequent Undo inside this editor.
    focusComposer();
  };

  const rowAtPointer = (selector: string, clientY: number): HTMLElement | undefined => {
    const rows = [...(timelineScrollRef.current?.querySelectorAll<HTMLElement>(selector) || [])];
    return rows.find((row) => {
      const rect = row.getBoundingClientRect();
      return clientY >= rect.top && clientY <= rect.bottom;
    }) || rows.sort((a, b) => {
      const distance = (row: HTMLElement) => {
        const rect = row.getBoundingClientRect();
        return clientY < rect.top ? rect.top - clientY : clientY > rect.bottom ? clientY - rect.bottom : 0;
      };
      return distance(a) - distance(b);
    })[0];
  };

  const beginPointerGesture = (
    event: React.PointerEvent<HTMLElement>, key: string,
    kind: TimelinePreview['kind'], edge?: 'start' | 'end',
  ) => {
    if (event.button !== 0 || pending) return;
    if (!edge && (event.target as HTMLElement).closest('.dual-resize-handle')) return;
    const scroll = timelineScrollRef.current;
    if (!scroll) return;
    const builder = scroll.closest<HTMLElement>('.plan-builder');
    const project = kind === 'project' ? projects.find((item) => item.node.key === key) : undefined;
    const task = kind === 'execution' ? executionTasks.find((item) => item.key === key) : undefined;
    const milestone = kind === 'milestone' ? milestones.find((item) => item.id === key) : undefined;
    if (!project && !task && !milestone) return;
    event.stopPropagation();
    event.preventDefault();
    // Preventing pointer defaults also suppresses native button focus. Selection
    // must explicitly own keyboard focus instead of leaving it on an old input/body.
    event.currentTarget.focus({ preventScroll: true });
    gestureCleanupRef.current?.();
    setSelection(kind === 'milestone' ? { type: 'milestone', id: key } : { type: kind, key });
    const startX = event.clientX;
    const startY = event.clientY;
    const startScroll = scroll.scrollLeft;
    const pointerId = event.pointerId;
    const original = project ? projectWindow(project.node, settings.startDate)
      : task ? { startDate: task.startDate || task.dueDate, dueDate: task.dueDate }
        : { startDate: milestone!.dueDate, dueDate: milestone!.dueDate };
    const parent = project?.parentKey ? projects.find((item) => item.node.key === project.parentKey) : undefined;
    const parentRange = parent ? projectWindow(parent.node, settings.startDate)
      : { startDate: settings.startDate, dueDate: settings.targetDate };
    const originalRow = project?.depth || task?.displayRow || 0;
    const mode = edge ? edge === 'start' ? 'resize-start' : 'resize-end' : 'move';
    let moved = false;
    let closed = false;
    let clientX = startX;
    let clientY = startY;
    let frameId = 0;
    let latest: TimelinePreview | null = null;
    let previousSignature = '';
    let previousPointerPosition = '';
    let lastFrameTime = 0;

    const previewAtPointer = (): TimelinePreview | null => {
      const rawDelta = getTimelineGestureDays(startX, clientX, pixelsPerDay, startScroll, scroll.scrollLeft);
      const delta = Math.round(rawDelta);
      const base: TimelinePreview = {
        key, kind, mode, rowIndex: originalRow,
        title: project?.node.title || task?.text || milestone!.title,
        ...original, pixelRemainder: 0, affectedKeys: [key],
      };
      if (edge) {
        const next = resizeTimelineWindow(original.startDate, original.dueDate, delta, edge,
          parentRange.startDate, parentRange.dueDate || undefined);
        const minimumDelta = edge === 'start' ? dayDistance(original.startDate, parentRange.startDate)
          : -dayDistance(original.startDate, original.dueDate);
        const maximumDelta = edge === 'start' ? dayDistance(original.startDate, original.dueDate)
          : parentRange.dueDate ? dayDistance(original.dueDate, parentRange.dueDate) : Infinity;
        const visualDelta = Math.max(minimumDelta, Math.min(maximumDelta, rawDelta));
        base.startDate = next.startDate;
        base.dueDate = next.dueDate;
        base.pixelRemainder = (visualDelta - next.appliedDays) * pixelsPerDay;
        if (project) base.nodes = updateProject(nodes, key, (node) => ({
          ...node, startDate: next.startDate, dueDate: next.dueDate,
          children: node.children.map((child) => clampTree(child, next.startDate, next.dueDate)),
        }));
        if (task) base.tasks = executionTasks.map((item) => item.key === key ? updateExecutionDates(item, { startDate: next.startDate, dueDate: next.dueDate }) : item);
        return base;
      }
      if (project) {
        const row = rowAtPointer('.dual-structure-row', clientY);
        const depth = Number(row?.dataset.depth || 0);
        const result = projectMoveResult(key, depth, addDays(original.startDate, delta));
        if (!result) return null;
        const dates = projectWindow(result.node, settings.startDate);
        const bounds = result.parent ? projectWindow(result.parent.node, settings.startDate)
          : { startDate: settings.startDate, dueDate: settings.targetDate };
        const duration = dayDistance(dates.startDate, dates.dueDate);
        const visualDelta = Math.max(dayDistance(original.startDate, bounds.startDate), Math.min(
          bounds.dueDate ? dayDistance(original.startDate, bounds.dueDate) - duration : Infinity, rawDelta,
        ));
        return { ...base, ...dates, rowIndex: depth, nodes: result.nodes,
          pixelRemainder: (visualDelta - dayDistance(original.startDate, dates.startDate)) * pixelsPerDay,
          affectedKeys: [key, ...descendantKeys(project.node)] };
      }
      const minimumDelta = dayDistance(original.startDate, settings.startDate);
      const duration = dayDistance(original.startDate, original.dueDate);
      const maximumDelta = settings.targetDate ? dayDistance(original.startDate, settings.targetDate) - duration : Infinity;
      const boundedDelta = Math.max(minimumDelta, Math.min(maximumDelta, rawDelta));
      const snappedDelta = Math.round(boundedDelta);
      const startDate = addDays(original.startDate, snappedDelta);
      const dueDate = addDays(original.dueDate, snappedDelta);
      base.pixelRemainder = (boundedDelta - snappedDelta) * pixelsPerDay;
      if (task) {
        const row = rowAtPointer('.dual-execution-row', clientY);
        const rowIndex = Number(row?.dataset.row || 0);
        return { ...base, startDate, dueDate, rowIndex, tasks: executionTasks.map((item) => item.key === key
          ? updateExecutionDates(item, { startDate, dueDate, displayRow: rowIndex }) : item) };
      }
      return { ...base, startDate, dueDate, milestones: milestones.map((item) => item.id === key ? { ...item, dueDate } : item) };
    };

    const updatePreview = () => {
      const pointerPosition = `${clientX}:${clientY}:${scroll.scrollLeft}:${scroll.scrollTop}`;
      if (pointerPosition === previousPointerPosition) return;
      previousPointerPosition = pointerPosition;
      latest = previewAtPointer();
      const signature = latest ? `${latest.rowIndex}:${latest.startDate}:${latest.dueDate}:${latest.pixelRemainder.toFixed(2)}` : 'invalid';
      if (signature !== previousSignature) {
        previousSignature = signature;
        setInteractionPreview(latest);
      }
    };
    const tick = (frameTime: number) => {
      if (closed || !moved) return;
      const elapsedMs = lastFrameTime ? frameTime - lastFrameTime : 1000 / 60;
      lastFrameTime = frameTime;
      const rect = scroll.getBoundingClientRect();
      const edgeZone = 42;
      const leftEdge = rect.left + ROW_LABEL_WIDTH;
      const velocity = clientX < leftEdge + edgeZone ? -Math.min(18, (leftEdge + edgeZone - clientX) / 3)
        : clientX > rect.right - edgeZone ? Math.min(18, (clientX - rect.right + edgeZone) / 3) : 0;
      if (velocity) scroll.scrollLeft += getTimelineAutoScrollDistance(velocity, elapsedMs);
      // The builder can itself scroll in short windows. Re-read its clipping
      // bounds each frame so a partially hidden track still has reachable edges.
      const clips = [{ top: 0, right: window.innerWidth, bottom: window.innerHeight, left: 0 }];
      if (builder) clips.push(builder.getBoundingClientRect());
      const visible = getTimelineVisibleBounds(rect, clips);
      if (!edge && kind !== 'milestone' && visible && clientX >= visible.left && clientX <= visible.right) {
        const verticalEdgeZone = Math.min(32, (visible.bottom - visible.top) / 2);
        if (clientY < visible.top + verticalEdgeZone) scroll.scrollTop -= getTimelineAutoScrollDistance(8, elapsedMs);
        else if (clientY > visible.bottom - verticalEdgeZone) scroll.scrollTop += getTimelineAutoScrollDistance(8, elapsedMs);
      }
      updatePreview();
      frameId = requestAnimationFrame(tick);
    };
    const onMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      clientX = moveEvent.clientX;
      clientY = moveEvent.clientY;
      if (!moved && Math.hypot(clientX - startX, clientY - startY) > 3) {
        moved = true;
        // Delay capture until dragging starts so a normal click still targets the block.
        // The scroll container stays mounted when the preview changes rows.
        scroll.setPointerCapture(pointerId);
        setPointerDragging(key);
        frameId = requestAnimationFrame(tick);
      }
    };
    const cleanup = () => {
      closed = true;
      cancelAnimationFrame(frameId);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('blur', cancel);
      if (scroll.hasPointerCapture(pointerId)) scroll.releasePointerCapture(pointerId);
      gestureCleanupRef.current = null;
    };
    const finish = (commit: boolean) => {
      if (closed) return;
      if (moved && commit) updatePreview();
      cleanup();
      if (moved) suppressClickUntilRef.current = Date.now() + 350;
      if (commit && moved && latest) {
        if (latest.nodes) onNodesChange(latest.nodes);
        if (latest.tasks) onExecutionTasksChange(latest.tasks);
        if (latest.milestones) onMilestonesChange(latest.milestones);
      }
      setPointerDragging(null);
      setInteractionPreview(null);
      // Moving between rows can unmount the original focused block.
      if (commit && moved) focusComposer();
    };
    const onUp = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== pointerId) return;
      clientX = upEvent.clientX;
      clientY = upEvent.clientY;
      finish(true);
    };
    const cancel = () => finish(false);
    const onCancel = (cancelEvent: PointerEvent) => { if (cancelEvent.pointerId === pointerId) cancel(); };
    const onKeyDown = (keyEvent: KeyboardEvent) => { if (keyEvent.key === 'Escape') { keyEvent.preventDefault(); cancel(); } };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('blur', cancel);
    gestureCleanupRef.current = cleanup;
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (pointerDragging || !isActive || event.defaultPrevented || hasActiveDialog()
        || !composerRef.current?.contains(event.target as Node) || composerRef.current.closest('[inert]')) return;
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      if (event.isComposing || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (isTextInput(target) || target?.isContentEditable || selection.type === 'plan') return;
      event.preventDefault();
      removeSelection();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selection, nodes, executionTasks, milestones, pointerDragging, isActive]);

  const onStructureDrop = (event: React.DragEvent<HTMLDivElement>, depth: number) => {
    event.preventDefault();
    const date = dateFromClientX(event.currentTarget, event.clientX);
    const key = event.dataTransfer.getData('application/x-plan-project');
    const existingKey = event.dataTransfer.getData('application/x-plan-existing-project');
    const template = event.dataTransfer.getData('application/x-plan-template');
    if (key) moveProject(key, depth, date);
    else if (existingKey) {
      const project = unscheduledProjects.find((item) => item.key === existingKey);
      if (project && project.depth === depth) scheduleExistingProject(project, date);
    }
    else if (template === 'project') addProject(depth, date);
  };

  const onExecutionDrop = (event: React.DragEvent<HTMLDivElement>, row: number) => {
    event.preventDefault();
    const date = dateFromClientX(event.currentTarget, event.clientX);
    const key = event.dataTransfer.getData('application/x-plan-execution');
    const template = event.dataTransfer.getData('application/x-plan-template');
    if (key) moveExecution(key, row, date);
    else if (template === 'execution') addExecution(row, date);
  };

  const renderGrid = () => <div className="dual-track-grid" style={{ backgroundSize: `${pixelsPerDay}px 100%, ${pixelsPerDay * 7}px 100%` }} />;
  const left = (date: string) => ROW_LABEL_WIDTH + Math.max(0, dayDistance(formatDate(range.startMs), date) * pixelsPerDay);
  const width = (start: string, end: string) => getTimelineBlockWidth(dayDistance(start, end) + 1, pixelsPerDay);
  const blockPreviewStyle = (startDate: string, dueDate: string): React.CSSProperties => {
    const blockWidth = width(startDate, dueDate);
    return {
      left: left(startDate), width: blockWidth,
      '--dual-handle-width': `${Math.max(2, Math.min(12, blockWidth / 4))}px`,
    } as React.CSSProperties;
  };
  const renderPointerOutline = (key: string, startDate: string, dueDate: string, top: number) => (
    interactionPreview?.key === key && <div className="dual-pointer-outline" aria-hidden="true" style={{
      top, ...getTimelinePointerOutline(left(startDate), width(startDate, dueDate), interactionPreview.pixelRemainder, interactionPreview.mode),
    }} />
  );
  const renderResizeHandle = (kind: 'project' | 'execution', key: string, title: string, startDate: string, dueDate: string, edge: 'start' | 'end') => (
    <span role="button" tabIndex={0} className={`dual-resize-handle is-${edge}`}
      aria-label={`调整${title}的${edge === 'start' ? '开始' : '结束'}日期`}
      title={`拖动调整${edge === 'start' ? '开始' : '结束'}日期；方向键调整一天`}
      onPointerDown={(event) => beginPointerGesture(event, key, kind, edge)}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault(); event.stopPropagation();
        const dayDelta = event.key === 'ArrowLeft' ? -1 : 1;
        if (kind === 'project') resizeProject(key, addDays(edge === 'start' ? startDate : dueDate, dayDelta), edge);
        else {
          const dates = resizeTimelineWindow(startDate, dueDate, dayDelta, edge, settings.startDate, settings.targetDate || undefined);
          updateExecution(key, { startDate: dates.startDate, dueDate: dates.dueDate });
        }
      }} />
  );
  const projectRows = useMemo(() => {
    // Only committed draft dates determine lanes. Live previews must not move row hit targets.
    const rows = new Map<number, TimelinePackedRow>();
    for (let depth = 0; depth < visibleStructureRows; depth += 1) {
      rows.set(depth, packTimelineIntervals(sourceProjects
        .filter((project) => project.depth === depth)
        .map((project) => {
          const dates = projectWindow(project.node, settings.startDate);
          return { key: project.node.key, start: dayDistance(settings.startDate, dates.startDate), end: dayDistance(settings.startDate, dates.dueDate) + 1 };
        })));
    }
    return rows;
  }, [sourceProjects, settings.startDate, visibleStructureRows]);
  const executionRowLayouts = useMemo(() => {
    const rows = new Map<number, TimelinePackedRow>();
    for (let row = 0; row < executionRows; row += 1) {
      rows.set(row, packTimelineIntervals(executionTasks
        .filter((task) => (task.displayRow || 0) === row)
        .map((task) => {
          const startDate = task.startDate || task.dueDate;
          return { key: task.key, start: dayDistance(settings.startDate, startDate), end: dayDistance(settings.startDate, task.dueDate) + 1 };
        })));
    }
    return rows;
  }, [executionTasks, executionRows, settings.startDate]);

  return (
    <section ref={composerRef} tabIndex={-1} className={`dual-plan-composer${pointerDragging ? ' is-pointer-dragging' : ''}${interactionPreview?.mode.startsWith('resize') ? ' is-pointer-resizing' : ''}${pixelsPerDay >= 96 ? ' is-readable-days' : ''}`}
      onPointerDownCapture={() => { suppressClickUntilRef.current = 0; }}
      onClickCapture={(event) => {
        if (Date.now() < suppressClickUntilRef.current) {
          suppressClickUntilRef.current = 0;
          event.preventDefault(); event.stopPropagation();
        }
      }}>
      <aside className="dual-plan-palette">
        <div className="dual-plan-kicker">PLAN MODULES</div>
        <h3>插入模块</h3>
        <p>拖入轨道，或先选择模块再点击目标位置。</p>
        <button
          type="button"
          className={`dual-palette-card is-structure${pending === 'project' ? ' is-active' : ''}`}
          draggable
          onDragStart={(event) => event.dataTransfer.setData('application/x-plan-template', 'project')}
          onClick={() => setPending((value) => value === 'project' ? null : 'project')}
        ><FolderTree /><span><strong>结构项目</strong><small>创建项目笔记与层级</small></span><GripVertical /></button>
        <button
          type="button"
          className={`dual-palette-card is-execution${pending === 'execution' ? ' is-active' : ''}`}
          draggable
          onDragStart={(event) => event.dataTransfer.setData('application/x-plan-template', 'execution')}
          onClick={() => setPending((value) => value === 'execution' ? null : 'execution')}
        ><Repeat2 /><span><strong>周期待办</strong><small>不创建项目笔记</small></span><GripVertical /></button>

        {rootProjectKey && <div className="dual-existing-projects">
          <button
            type="button"
            className={`dual-existing-toggle${existingPickerOpen ? ' is-active' : ''}`}
            aria-expanded={existingPickerOpen}
            onClick={() => setExistingPickerOpen((open) => !open)}
          ><LibraryBig /><span><strong>已有项目</strong><small>{unscheduledProjects.length} 个未排期对象</small></span><ChevronDown /></button>
          {existingPickerOpen && <div className="dual-existing-panel">
            <label><Search /><input value={existingSearch} onChange={(event) => setExistingSearch(event.target.value)} placeholder="搜索项目或路径" aria-label="搜索未排期项目" /></label>
            <div className="dual-existing-list">
              {visibleUnscheduledProjects.map((project) => {
                const enabled = canScheduleExistingProject(project);
                return <button
                  type="button"
                  key={project.key}
                  disabled={!enabled}
                  draggable={enabled}
                  onDragStart={(event) => event.dataTransfer.setData('application/x-plan-existing-project', project.key)}
                  onClick={() => scheduleExistingProject(project)}
                  title={enabled ? `${project.path}\n点击加入，或拖到第 ${project.depth + 1} 行` : `${project.path}\n请先将其父项目加入轨道`}
                ><FolderTree /><span><strong>{project.title}</strong><small>{project.path}</small></span>{enabled ? <Plus /> : <ChevronRight />}</button>;
              })}
              {visibleUnscheduledProjects.length === 0 && <p>{unscheduledProjects.length === 0 ? '当前没有未排期项目' : '没有匹配的项目'}</p>}
            </div>
            <small className="dual-existing-hint">点击直接加入；也可拖到其真实层级所在行。子项目需先排期父项目。</small>
          </div>}
        </div>}

        <div className="dual-palette-guide">
          <span><i className="is-structure" />结构层</span>
          <p>上层时间覆盖下层，自动建立父子关系。</p>
          <span><i className="is-execution" />执行层</span>
          <p>独立周期事项，完成一次后按规则生成下一次。</p>
        </div>
      </aside>

      <div className="dual-plan-center">
        <header className="dual-plan-toolbar">
          <div><Layers3 /><span><strong>时间线编排</strong><small>{projects.length} 个项目 · {executionTasks.length} 个执行规则</small></span></div>
          <div className="dual-zoom" role="group" aria-label="时间线缩放">
            <button type="button" aria-label="撤销轨道操作" title="撤销（Ctrl + Z）" disabled={!canUndo || Boolean(pointerDragging)} onClick={onUndo}><Undo2 /></button>
            <button type="button" aria-label="重做轨道操作" title="重做（Ctrl + Shift + Z）" disabled={!canRedo || Boolean(pointerDragging)} onClick={onRedo}><Redo2 /></button>
            <button type="button" aria-label="缩小时间线" disabled={pixelsPerDay <= zoomStops[0] || Boolean(pointerDragging)} onClick={() => changeZoom(-1)}><Minus /></button>
            <input type="range" min={0} max={zoomStops.length - 1} step={1}
              value={Math.max(0, zoomStops.findIndex((stop) => stop === pixelsPerDay))}
              aria-label="编排时间线缩放" aria-valuetext={`${showDayScale ? '日刻度' : '周刻度'}，每天 ${pixelsPerDay} 像素`}
              disabled={Boolean(pointerDragging)} onChange={(event) => setPixelsPerDay(zoomStops[Number(event.target.value)])} />
            <button type="button" aria-label="放大时间线" disabled={pixelsPerDay >= zoomStops.at(-1)! || Boolean(pointerDragging)} onClick={() => changeZoom(1)}><Plus /></button>
            <output>{showDayScale ? '日' : '周'} · {pixelsPerDay}px</output>
            <button type="button" title="适应窗口" aria-label="编排时间线适应窗口" disabled={Boolean(pointerDragging)} onClick={fitTimeline}><Maximize2 /></button>
          </div>
        </header>

        <div className="dual-plan-scroll" ref={timelineScrollRef} onClick={(event) => {
          if (!pending && event.target === event.currentTarget) setSelection({ type: 'plan' });
        }}>
          <div className="dual-plan-board" style={{ width: range.width }} onClick={(event) => {
            if (!pending && !(event.target as HTMLElement).closest('button, input, select, [role="button"]')) setSelection({ type: 'plan' });
          }}>
            <div className={`dual-plan-weeks${showDayScale ? ' is-days' : ''}`}>
              {showDayScale
                ? days.map((day) => <div key={day.date} style={{ width: pixelsPerDay }} title={day.date}><strong>{pixelsPerDay >= 48 ? day.date.slice(5).replace('-', '/') : day.date.slice(8)}</strong><span>周{day.weekday}</span></div>)
                : weeks.map((week) => <div key={week.index} style={{ width: week.width }}><strong>第 {week.index + 1} 周</strong><span>{week.date.slice(5).replace('-', '.')}</span></div>)}
            </div>

            <div className="dual-row-group is-structure">
              <div className="dual-group-caption"><FolderTree /><span><strong>项目</strong><small>上级覆盖下级</small></span><div className="dual-group-actions"><button type="button" disabled={visibleStructureRows <= 2} title={projects.some((project) => project.depth === visibleStructureRows - 1) ? '折叠末级' : '删除空的末级行'} onClick={() => setVisibleStructureRows((value) => Math.max(2, value - 1))}><Minus /></button><button type="button" title="增加下一级" onClick={() => setVisibleStructureRows((value) => value + 1)}><Plus /></button></div></div>
              {Array.from({ length: visibleStructureRows }, (_, depth) => (
                <div
                key={`structure-${depth}`}
                className={`dual-structure-row depth-${depth}${interactionPreview?.kind === 'project' && interactionPreview.rowIndex === depth ? ' is-drop-target' : ''}`}
                data-depth={depth}
                style={{ height: packedRowHeight(projectRows.get(depth)?.laneCount || 1) }}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => onStructureDrop(event, depth)}
                onClick={(event) => {
                  if ((event.target as HTMLElement).closest('button, [role="button"]')) return;
                  if (pending === 'project') addProject(depth, dateFromClientX(event.currentTarget, event.clientX));
                  else if (!pending) setSelection({ type: 'plan' });
                }}
                 onContextMenu={(event) => {
                   if ((event.target as HTMLElement).closest('button, [role="button"]')) return;
                   event.preventDefault();
                   addMilestone(dateFromClientX(event.currentTarget, event.clientX));
                }}
              >
                {renderGrid()}
                {projects.filter((project) => project.depth === depth).map((project) => {
                  const dates = projectWindow(project.node, settings.startDate);
                  const top = packedBlockTop(projectRows.get(depth)?.laneByKey.get(project.node.key) || 0);
                  return <React.Fragment key={project.node.key}><button
                    type="button"
                    className={`dual-project-block depth-${depth}${width(dates.startDate, dates.dueDate) < 48 ? ' is-compact' : ''}${selection.type === 'project' && selection.key === project.node.key ? ' is-selected' : ''}${interactionPreview?.key === project.node.key ? ' is-manipulating' : ''}`}
                    data-project-key={project.node.key} data-start-date={dates.startDate} data-due-date={dates.dueDate}
                    style={{
                      top, ...blockPreviewStyle(dates.startDate, dates.dueDate),
                    }}
                     onPointerDown={(event) => beginPointerGesture(event, project.node.key, 'project')}
                     onContextMenu={(event) => {
                       event.preventDefault(); event.stopPropagation();
                       event.currentTarget.focus({ preventScroll: true });
                       setSelection({ type: 'project', key: project.node.key });
                     }}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (pending === 'project') {
                        const row = event.currentTarget.closest('.dual-structure-row') as HTMLElement;
                        addProject(depth, dateFromClientX(row, event.clientX));
                        return;
                      }
                      setSelection({ type: 'project', key: project.node.key });
                    }}
                    title={`${project.node.title}\n${dates.startDate} — ${dates.dueDate}`}
                  >
                    <span><strong>{project.node.title}</strong><small>{dates.startDate.slice(5)} — {dates.dueDate.slice(5)}</small></span>
                    {renderResizeHandle('project', project.node.key, project.node.title, dates.startDate, dates.dueDate, 'start')}
                    {renderResizeHandle('project', project.node.key, project.node.title, dates.startDate, dates.dueDate, 'end')}
                  </button>{renderPointerOutline(project.node.key, dates.startDate, dates.dueDate, top)}</React.Fragment>;
                })}
                </div>
              ))}
              {displayedMilestones.map((milestone) => <div
                key={milestone.id}
                className={`dual-milestone-line${left(milestone.dueDate) === ROW_LABEL_WIDTH ? ' is-at-start' : ''}${selection.type === 'milestone' && selection.id === milestone.id ? ' is-selected' : ''}`}
                style={{ left: left(milestone.dueDate) }}
              ><i /><button
                type="button"
                className="dual-milestone-flag"
                aria-label={`${milestone.title}，${milestone.dueDate}。拖动旗子调整日期`}
                onPointerDown={(event) => beginPointerGesture(event, milestone.id, 'milestone')}
                onClick={(event) => { event.stopPropagation(); setSelection({ type: 'milestone', id: milestone.id }); }}
                onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); event.currentTarget.focus({ preventScroll: true }); setSelection({ type: 'milestone', id: milestone.id }); }}
                title={`${milestone.title} · ${milestone.dueDate} · 拖动旗子调整日期`}
              ><Flag /></button><span>{milestone.title}<small>{milestone.dueDate.slice(5)}</small></span></div>)}
              {interactionPreview?.kind === 'milestone' && <div className="dual-milestone-pointer" aria-hidden="true"
                style={{ left: left(interactionPreview.dueDate) + interactionPreview.pixelRemainder }} />}
            </div>
            {hiddenProjectCount > 0 && <button type="button" className="dual-hidden-rows" onClick={() => setVisibleStructureRows(maximumDepth + 1)}><ChevronDown />还有 {hiddenProjectCount} 个五级及更深项目，展开查看</button>}

            <div className="dual-row-group is-execution">
              <div className="dual-group-caption"><Repeat2 /><span><strong>周期任务</strong><small>独立执行</small></span><div className="dual-group-actions"><button type="button" disabled={executionRows <= 1 || executionTasks.some((task) => (task.displayRow || 0) === executionRows - 1)} title="删除空的末行" onClick={() => setExecutionRows((value) => Math.max(1, value - 1))}><Minus /></button><button type="button" title="增加并行任务行" onClick={() => setExecutionRows((value) => value + 1)}><Plus /></button></div></div>
              {Array.from({ length: executionRows }, (_, row) => (
                <div
                key={`execution-${row}`}
                className={`dual-execution-row${interactionPreview?.kind === 'execution' && interactionPreview.rowIndex === row ? ' is-drop-target' : ''}`}
                data-row={row}
                style={{ height: packedRowHeight(executionRowLayouts.get(row)?.laneCount || 1) }}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => onExecutionDrop(event, row)}
                onClick={(event) => {
                  if ((event.target as HTMLElement).closest('button, [role="button"]')) return;
                  if (pending === 'execution') addExecution(row, dateFromClientX(event.currentTarget, event.clientX));
                  else if (!pending) setSelection({ type: 'plan' });
                }}
              >
                {renderGrid()}
                {displayedExecutions.filter((task) => (task.displayRow || 0) === row).map((task) => {
                  const startDate = task.startDate || task.dueDate;
                  const top = packedBlockTop(executionRowLayouts.get(row)?.laneByKey.get(task.key) || 0);
                  return <React.Fragment key={task.key}><button
                    type="button"
                    className={`dual-execution-block${width(startDate, task.dueDate) < 48 ? ' is-compact' : ''}${selection.type === 'execution' && selection.key === task.key ? ' is-selected' : ''}${interactionPreview?.key === task.key ? ' is-manipulating' : ''}`}
                    data-execution-key={task.key} data-start-date={startDate} data-due-date={task.dueDate}
                    style={{
                      top, ...blockPreviewStyle(startDate, task.dueDate),
                    }}
                    onPointerDown={(event) => beginPointerGesture(event, task.key, 'execution')}
                    title={`${task.text}\n${startDate} — ${task.dueDate}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (pending === 'execution') {
                        const track = event.currentTarget.closest('.dual-execution-row') as HTMLElement;
                        addExecution(row, dateFromClientX(track, event.clientX));
                        return;
                      }
                      setSelection({ type: 'execution', key: task.key });
                    }}
                  ><Repeat2 /><span><strong>{task.text}</strong><small>{task.recurrence?.frequency === 'daily' ? '每日' : task.recurrence?.frequency === 'weekdays' ? '工作日' : task.recurrence?.frequency === 'weekly' ? '每周' : task.recurrence?.frequency === 'custom' ? '自定义星期' : '不重复'} · {task.estimatedMinutes} 分钟</small></span>
                    {renderResizeHandle('execution', task.key, task.text, startDate, task.dueDate, 'start')}
                    {renderResizeHandle('execution', task.key, task.text, startDate, task.dueDate, 'end')}
                  </button>{renderPointerOutline(task.key, startDate, task.dueDate, top)}</React.Fragment>;
                })}
                </div>
              ))}
            </div>
          </div>
        </div>
        {interactionPreview && <div className="dual-gesture-feedback" role="status">
          <strong>{interactionPreview.mode === 'move' ? '移动' : '调整时限'}</strong>
          <span>{interactionPreview.startDate}{interactionPreview.kind !== 'milestone' && ` — ${interactionPreview.dueDate}`}</span>
          <small>Esc 取消</small>
        </div>}
      </div>

      <aside className="dual-plan-inspector" ref={inspectorRef}>
        <div className="dual-inspector-title"><div><Settings2 /><span><small>PROPERTIES</small><strong>{selection.type === 'plan' ? '计划属性' : selection.type === 'project' ? '结构项目' : selection.type === 'execution' ? '执行任务' : '里程碑'}</strong></span></div>{selection.type !== 'plan' && <button type="button" className="dual-delete-selection" onClick={removeSelection} title={selection.type === 'project' ? '从计划移除；保存后仅清除项目时限，不删除笔记' : '删除选中项'}><Trash2 /><span>{selection.type === 'project' ? '移出计划' : '删除'}</span></button>}</div>

        {selection.type === 'plan' && <div className="dual-fields">
          <label>开始日期<input type="date" value={settings.startDate} onChange={(event) => onSettingsChange('startDate', event.target.value)} /></label>
          <label>目标日期<input type="date" value={settings.targetDate} onChange={(event) => onSettingsChange('targetDate', event.target.value)} /></label>
          <label>个人共享周预算<input readOnly value={settings.weeklyBudgetMinutes || '请到设置中确认'} /><span>分钟 · 所有计划共用</span></label>
          <label>本计划每日投入<StudyMinutesInput value={settings.dailyStudyMinutes || 120} onValueChange={value => onSettingsChange('dailyStudyMinutes', value!)} /><span>分钟 · 叶子项目默认继承</span></label>
          <label>单次时长<StudyMinutesInput value={settings.preferredSessionMinutes} onValueChange={value => onSettingsChange('preferredSessionMinutes', value!)} /><span>分钟</span></label>
          <div className={`dual-assessment ${assessment.blocking ? 'is-blocking' : assessment.issues.length ? 'is-warning' : ''}`}><CalendarDays /><span><strong>{assessment.blocking ? '条件存在冲突' : assessment.issues.length ? '排期有提醒' : '排期条件可执行'}</strong><small>{assessment.issues[0]?.message || '发布前仍可继续拖拽微调。'}</small></span></div>
        </div>}

        {selectedProject && <div className="dual-fields">
          {!selectedProject.node.children.length && <label>叶子项目预计时长<StudyMinutesInput key={selectedProject.node.key} allowEmpty value={selectedProject.node.estimatedMinutes} placeholder={`继承 ${settings.dailyStudyMinutes || 120} 分钟`}
            onValueChange={value => onNodesChange(updateProject(nodes, selectedProject.node.key, node => ({ ...node, estimatedMinutes: value })))} /><span>留空继承每日投入，不按日期跨度乘算</span></label>}
          <label>项目名称<input value={selectedProject.node.title} onChange={(event) => onNodesChange(updateProject(nodes, selectedProject.node.key, (node) => ({ ...node, title: event.target.value })))} /></label>
          <label>父项目<select value={selectedProject.parentKey || ''} onChange={(event) => {
            const nextParentKey = event.target.value || undefined;
            const nextParent = nextParentKey ? projects.find((project) => project.node.key === nextParentKey) : undefined;
            const detached = detachProject(nodes, selectedProject.node.key);
            const bounded = nextParent ? clampTree(selectedProject.node, projectWindow(nextParent.node, settings.startDate).startDate, projectWindow(nextParent.node, settings.startDate).dueDate) : selectedProject.node;
            onNodesChange(insertProject(detached.nodes, bounded, nextParentKey));
          }}><option value="">根计划（作为二级项目）</option>{projects.filter((project) => project.node.key !== selectedProject.node.key && !descendantKeys(selectedProject.node).includes(project.node.key)).map((project) => <option key={project.node.key} value={project.node.key}>{'　'.repeat(project.depth)}{project.node.title}</option>)}</select></label>
          <div className="dual-date-pair"><label>开始<input type="date" value={projectWindow(selectedProject.node, settings.startDate).startDate} onChange={(event) => resizeProject(selectedProject.node.key, event.target.value, 'start')} /></label><label>结束<input type="date" value={projectWindow(selectedProject.node, settings.startDate).dueDate} onChange={(event) => resizeProject(selectedProject.node.key, event.target.value)} /></label></div>
          <label>验收产出<textarea rows={3} value={selectedProject.node.outcome || ''} onChange={(event) => onNodesChange(updateProject(nodes, selectedProject.node.key, (node) => ({ ...node, outcome: event.target.value })))} placeholder="完成时应得到什么可观察结果" /></label>
          <label>优先级<select value={selectedProject.node.priority || 'medium'} onChange={(event) => onNodesChange(updateProject(nodes, selectedProject.node.key, (node) => ({ ...node, priority: event.target.value as 'high' | 'medium' | 'low' })))}><option value="high">高</option><option value="medium">中</option><option value="low">低</option></select></label>
          <div className="dual-rule-note"><FolderTree /><p>当前为 {selectedProject.depth + 2} 级项目。层级不设上限；五级及以后只在界面默认折叠。</p></div>
        </div>}

        {selectedExecution && <div className="dual-fields">
          <label>任务名称<input value={selectedExecution.text} onChange={(event) => updateExecution(selectedExecution.key, { text: event.target.value })} /></label>
          <label>任务类型<select value={selectedExecution.executionKind || 'todo'} onChange={(event) => {
            const executionKind = event.target.value as PlanExecutionKind;
            updateExecution(selectedExecution.key, { executionKind, kind: executionKindToTaskKind(executionKind), launchMode: executionKind === 'flow' ? 'flow' : executionKind === 'review' ? 'review' : executionKind === 'practice' ? 'scene' : 'none' });
          }}><option value="todo">普通待办</option><option value="flow">心流学习</option><option value="practice">场景练习</option><option value="review">复习任务</option></select></label>
          <div className="dual-date-pair"><label>生效<input type="date" value={selectedExecution.startDate || selectedExecution.dueDate} onChange={(event) => updateExecution(selectedExecution.key, { startDate: event.target.value })} /></label><label>结束<input type="date"
            value={executionRepeats(selectedExecution) ? selectedExecution.recurrence?.endDate || '' : selectedExecution.dueDate}
            onChange={(event) => updateExecution(selectedExecution.key, executionRepeats(selectedExecution)
              ? { dueDate: event.target.value || selectedExecution.startDate || selectedExecution.dueDate,
                recurrence: { ...selectedExecution.recurrence!, endDate: event.target.value || undefined } }
              : { dueDate: event.target.value })} /></label></div>
          {executionRepeats(selectedExecution) && <small>结束日期当天仍会执行；留空则持续重复。</small>}
          <label>重复规则<select value={selectedExecution.recurrence?.frequency || 'none'} onChange={(event) => {
            const frequency = event.target.value as NonNullable<PlanTaskBlueprint['recurrence']>['frequency'];
            const weekdays = selectedExecution.recurrence?.weekdays?.length
              ? selectedExecution.recurrence.weekdays
              : [new Date(`${selectedExecution.startDate || selectedExecution.dueDate}T00:00:00Z`).getUTCDay()];
            updateExecution(selectedExecution.key, { recurrence: {
              ...(selectedExecution.recurrence || {}), frequency,
              ...(frequency === 'weekly' || frequency === 'custom' ? { weekdays } : {}),
            } });
          }}><option value="none">不重复</option><option value="daily">每天</option><option value="weekdays">工作日</option><option value="weekly">每周</option><option value="custom">自定义星期</option></select></label>
          {(selectedExecution.recurrence?.frequency === 'weekly' || selectedExecution.recurrence?.frequency === 'custom') && <div className="plan-recurrence-weekdays" role="group" aria-label="重复星期">
            <span>重复星期</span><div>{WEEKDAYS.map((day) => {
              const selectedDays = selectedExecution.recurrence?.weekdays?.length
                ? selectedExecution.recurrence.weekdays
                : [new Date(`${selectedExecution.startDate || selectedExecution.dueDate}T00:00:00Z`).getUTCDay()];
              const selected = selectedDays.includes(day.value);
              return <button type="button" key={day.value} aria-label={`每周${day.label}`} aria-pressed={selected} onClick={() => {
                if (selected && selectedDays.length === 1) return;
                updateExecution(selectedExecution.key, { recurrence: {
                  ...selectedExecution.recurrence!,
                  weekdays: selected ? selectedDays.filter((value) => value !== day.value) : [...selectedDays, day.value],
                } });
              }}>{day.label}</button>;
            })}</div><small>至少保留一个重复日</small>
          </div>}
          <label>单次预算<StudyMinutesInput key={selectedExecution.key} value={selectedExecution.estimatedMinutes} onValueChange={value => updateExecution(selectedExecution.key, { estimatedMinutes: value! })} /><span>分钟</span></label>
          <label>关联项目<select value={selectedExecution.linkedProjectKey || ''} onChange={(event) => updateExecution(selectedExecution.key, { linkedProjectKey: event.target.value || undefined })}><option value="">不关联</option>{projects.map((project) => <option key={project.node.key} value={project.node.key}>{'　'.repeat(project.depth)}{project.node.title}</option>)}</select></label>
          <label>容量计时<select value={selectedExecution.capacityKind || 'additional'} onChange={event => updateExecution(selectedExecution.key, { capacityKind: event.target.value as 'additional' | 'included' })}><option value="additional">额外独立投入</option><option value="included">已包含在关联叶子项目内</option></select><span>关联不等于包含；只有同计划的真实叶子项目可承接包含关系</span></label>
          <label>错过后<select value={selectedExecution.recurrence?.missedPolicy || 'rollover'} onChange={(event) => updateExecution(selectedExecution.key, { recurrence: { ...(selectedExecution.recurrence || { frequency: 'daily' }), missedPolicy: event.target.value as 'skip' | 'rollover' | 'keep' } })}><option value="rollover">顺延到下一天</option><option value="skip">跳过本次</option><option value="keep">保留逾期待办</option></select></label>
          <div className="dual-rule-note"><Repeat2 /><p>执行任务不会创建项目笔记；完成只记录本次 occurrence，周期仍继续。</p></div>
        </div>}

        {selectedMilestone && <div className="dual-fields">
          <label>里程碑名称<input value={selectedMilestone.title} onChange={(event) => onMilestonesChange(milestones.map((item) => item.id === selectedMilestone.id ? { ...item, title: event.target.value } : item))} /></label>
          <label>时间节点<input type="date" value={selectedMilestone.dueDate} onChange={(event) => onMilestonesChange(milestones.map((item) => item.id === selectedMilestone.id ? { ...item, dueDate: event.target.value } : item))} /></label>
          <label>验收条件<textarea rows={4} value={(selectedMilestone.criteria || []).join('\n')} onChange={(event) => onMilestonesChange(milestones.map((item) => item.id === selectedMilestone.id ? { ...item, criteria: event.target.value.split('\n').filter(Boolean) } : item))} /></label>
          <div className="dual-rule-note"><Flag /><p>里程碑是时间点而不是任务块，可在轨道空白处右键快速创建。</p></div>
        </div>}
      </aside>
    </section>
  );
};
