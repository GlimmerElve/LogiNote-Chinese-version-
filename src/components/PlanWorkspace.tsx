import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useDialog } from './useDialog';
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  BookOpen,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  ClipboardCheck,
  Clock3,
  List,
  Loader2,
  FolderTree,
  Flag,
  Milestone,
  Minus,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Repeat2,
  SlidersHorizontal,
  Maximize2,
  Target,
  X,
} from 'lucide-react';
import type { NoteItem, PlanExecutionKind, PlanMeta, PlanNode, PlanRecurrenceFrequency, PlanTaskKind } from '../types';
import {
  buildPlanWorkspaceModel,
  buildExecutionAgendaOccurrences,
  buildStructureAgendaOccurrences,
  PLAN_OVERVIEW_ID,
  type PlanWorkspaceMilestone,
  type PlanWorkspacePhase,
  type PlanWorkspaceStructureLane,
  type PlanWorkspaceTask,
} from '../services/planViewModel';
import { groupTimelineMilestones, layoutStructureNodes, layoutTimelineMilestones } from '../services/planTimelineLayout';
import {
  getTimelineBoardWidth, getTimelineDateScrollLeft, getTimelineVisibleColumns, getTimelineZoomScrollLeft,
  PLAN_TIMELINE_BASE_WEEK_WIDTH, PLAN_TIMELINE_MIN_ZOOM, PLAN_TIMELINE_MAX_ZOOM, PLAN_TIMELINE_ZOOM_STEP, PLAN_TIMELINE_ZOOM_STOPS,
  type TimelineVisibleColumn,
} from '../services/planTimelineViewport';
import { getPlanMilestoneGate } from '../services/planMilestoneState';
import { getLearningCompletionTarget } from '../services/learningCompletion';
import {
  buildPublishedPlanEditorValue,
  type PublishedPlanStructureAddInput,
} from '../services/publishedPlanEditor';
import './PlanWorkspace.css';
import { buildLearningCapacity, cachedCapacitySettings } from '../services/learningCapacity';
import { newPlanStructureDates } from '../services/newPlanStructureDates';

export interface PlanTaskCreateInput {
  scopeRootId: string;
  noteId: string;
  taskText: string;
  dueDate: string;
  kind: PlanTaskKind;
  estimatedMinutes: number;
  executionKind?: PlanExecutionKind;
  recurrenceFrequency?: PlanRecurrenceFrequency;
  recurrenceWeekdays?: number[];
}

export type PlanAdjustmentScope =
  | { kind: 'root'; id: string; title: string; meta?: PlanMeta }
  | { kind: 'portfolio'; rootIds: string[] };

interface PlanWorkspaceProps {
  capacitySettings?: Partial<import('../types').VaultSettings>;
  onOpenLearningSettings?: () => void;
  notes: NoteItem[];
  initialPlanId?: string | null;
  onToggleTaskCompleted: (noteId: string, taskId: string, occurrenceDate?: string, completed?: boolean) => void | Promise<void>;
  onToggleProjectCompleted: (projectId: string, completed?: boolean) => void | Promise<void>;
  onToggleMilestoneCompleted: (rootId: string, milestoneId: string, completed?: boolean) => void | Promise<void>;
  onSelectNoteByTitle: (noteId: string, title?: string) => void;
  onAddTask: (input: PlanTaskCreateInput) => void | boolean | Promise<void | boolean>;
  onAddStructureItem: (input: PublishedPlanStructureAddInput) => void | boolean | Promise<void | boolean>;
  onOpenPlanBuilder: () => void;
  onOpenPlanEditor?: (rootId: string) => void;
  onRequestPlanAdjustment?: (scope: PlanAdjustmentScope) => void;
}

type PlanView = 'timeline' | 'week' | 'list';
type PlanAddMode = 'existing' | 'new' | 'execution' | null;

interface StructureParentOption {
  id: string;
  title: string;
  path: string;
  startDate?: string;
  dueDate?: string;
}

function addCalendarDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function flattenStructureParents(root: PlanNode): StructureParentOption[] {
  const result: StructureParentOption[] = [];
  const visit = (node: PlanNode, path: string[]) => {
    const nextPath = [...path, node.title];
    result.push({ id: node.key, title: node.title, path: nextPath.join(' > '), startDate: node.startDate, dueDate: node.dueDate });
    (node.children || []).forEach((child) => visit(child, nextPath));
  };
  visit(root, []);
  return result;
}

const TIMELINE_ZOOM_KEY = 'loginote_plan_timeline_zoom_v1';
function readTimelineZoom(): number | null {
  try {
    const value = localStorage.getItem(TIMELINE_ZOOM_KEY);
    if (value === 'fit') return null;
    const zoom = Number(value);
    if (value && Number.isFinite(zoom)) return Math.max(PLAN_TIMELINE_MIN_ZOOM, Math.min(PLAN_TIMELINE_MAX_ZOOM, zoom));
  } catch { /* View preferences are optional when storage is unavailable. */ }
  return 200;
}

const TASK_KIND_LABEL: Record<PlanTaskKind, string> = {
  learn: '学习',
  practice: '练习',
  review: '复习',
  assessment: '测验',
};

const STARTING_LEVEL_LABEL = { new: '从零开始', basic: '了解基础', intermediate: '已有实践', advanced: '进阶提升' } as const;
const PACE_LABEL = { relaxed: '舒缓节奏', balanced: '均衡节奏', intensive: '密集节奏' } as const;
const TIME_LABEL = { morning: '上午优先', afternoon: '下午优先', evening: '晚间优先', flexible: '时段灵活' } as const;
const WEEKDAYS = [
  { value: 1, label: '一' }, { value: 2, label: '二' }, { value: 3, label: '三' },
  { value: 4, label: '四' }, { value: 5, label: '五' }, { value: 6, label: '六' },
  { value: 0, label: '日' },
];

function formatDateLabel(value: string | undefined): string {
  if (!value) return '尚未设定';
  const [, month, day] = value.split('-');
  return `${Number(month)} 月 ${Number(day)} 日`;
}

function weekdayLabel(value: string): string {
  const labels = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  return labels[new Date(`${value}T00:00:00Z`).getUTCDay()];
}

function dateRangeContains(value: string, start: string, end: string): boolean {
  return value >= start && value <= end;
}

function executionRecurrenceLabel(task: PlanWorkspaceTask): string {
  const rule = task.recurrence;
  if (!rule || rule.frequency === 'none') return '单次';
  const interval = rule.interval || 1;
  if (rule.frequency === 'daily') return interval === 1 ? '每日' : `每 ${interval} 天`;
  if (rule.frequency === 'weekdays') return interval === 1 ? '工作日' : `每 ${interval} 周的工作日`;
  const days = rule.weekdays?.length ? rule.weekdays : [new Date(`${task.startDate}T00:00:00Z`).getUTCDay()];
  return `${interval === 1 ? '每周' : `每 ${interval} 周`} · ${days.map(day => ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][day]).join('、')}`;
}

function layoutTasks(tasks: PlanWorkspaceTask[]): { task: PlanWorkspaceTask; row: number }[] {
  const rowEnds: number[] = [];
  return tasks.map((task) => {
    const start = task.leftPercent;
    const end = task.leftPercent + task.widthPercent;
    let row = rowEnds.findIndex((rowEnd) => start >= rowEnd + 0.6);
    if (row === -1) row = rowEnds.length;
    rowEnds[row] = end;
    return { task, row };
  });
}

const TaskCheck: React.FC<{
  task: PlanWorkspaceTask;
  onToggle: () => void;
  disabled?: boolean;
}> = ({ task, onToggle, disabled }) => (
  <button
    type="button"
    className={`plan-task-check${task.completed ? ' is-complete' : ''}`}
    onClick={onToggle}
    disabled={disabled}
    aria-label={!task.occurrenceAvailable ? `周期已结束：“${task.taskText}”` : `${task.completed ? `将“${task.taskText}”标记为未完成` : `完成“${task.taskText}”`}${task.recurrence && task.recurrence.frequency !== 'none' ? `（${task.occurrenceDate}）` : ''}`}
    title={!task.occurrenceAvailable ? '本周期已结束，可切换到对应周查看完成记录。' : task.recurrence && task.recurrence.frequency !== 'none' ? `本次日期：${task.occurrenceDate}` : undefined}
  >
    {!task.occurrenceAvailable ? <Repeat2 /> : task.completed ? <Check /> : <Circle />}
  </button>
);

function localDate(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function useToday(): string {
  const [today, setToday] = useState(localDate);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const refresh = () => {
      setToday(localDate());
      clearTimeout(timer);
      const now = new Date();
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      timer = setTimeout(refresh, midnight.getTime() - now.getTime() + 100);
    };
    refresh();
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);
  return today;
}

const TimelineGrid: React.FC<{ columns: TimelineVisibleColumn[]; columnCount: number }> = ({ columns, columnCount }) => (
  <div className="plan-week-grid" aria-hidden="true">{columns.map(({ index, span }) => <i key={index}
    style={{ position: 'absolute', insetBlock: 0, left: `${index / columnCount * 100}%`, width: `${span / columnCount * 100}%` }} />)}</div>
);

const StructureTimelineLane: React.FC<{
  lane: PlanWorkspaceStructureLane;
  milestones: PlanWorkspaceMilestone[];
  columns: TimelineVisibleColumn[];
  columnCount: number;
  today: string;
  todayPercent: number | null;
  expandedProjects: Set<string>;
  onExpand: (id: string) => void;
  onOpen: (noteId: string, title?: string) => void;
  onComplete: (id: string) => void;
  completionBusy: boolean;
  onMilestone: (items: PlanWorkspaceMilestone[]) => void;
}> = ({ lane, milestones, columns, columnCount, today, todayPercent, expandedProjects, onExpand, onOpen, onComplete, completionBusy, onMilestone }) => {
  const trackRef = useRef<HTMLDivElement>(null);
  const [metrics, setMetrics] = useState({ width: 0, labels: {} as Record<string, number> });
  const groups = useMemo(() => groupTimelineMilestones(milestones), [milestones]);
  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    let mounted = true;
    const measure = () => {
      if (!mounted) return;
      const labels: Record<string, number> = {};
      track.querySelectorAll<HTMLElement>('[data-milestone-label]').forEach((label) => {
        labels[label.dataset.milestoneLabel!] = label.scrollWidth;
      });
      setMetrics({ width: track.clientWidth, labels });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(track);
    measure();
    void document.fonts.ready.then(measure);
    return () => { mounted = false; observer.disconnect(); };
  }, [groups]);
  const milestoneLayout = layoutTimelineMilestones(groups, metrics.width, metrics.labels);
  const nodeById = new Map(lane.nodes.map((node) => [node.projectId, node]));
  const visibleNodes = lane.nodes.filter((candidate) => {
    let node = candidate;
    while (node.depth > 0) {
      if (!node.parentId || !expandedProjects.has(node.parentId)) return false;
      const parent = nodeById.get(node.parentId);
      if (!parent) return false;
      node = parent;
    }
    return true;
  });
  const structureLayout = layoutStructureNodes(visibleNodes);
  return <div className="plan-structure-lane" style={{ minHeight: milestoneLayout.height + structureLayout.rowCount * 48 + 12 }}>
    <div className="plan-lane-label" title={lane.rootTitle}><FolderTree /><strong>{lane.rootTitle}</strong><span>{lane.nodes.length} 个结构项目</span></div>
    <div className="plan-lane-track" ref={trackRef}>
      <TimelineGrid columns={columns} columnCount={columnCount} />
      {todayPercent !== null && <i className="plan-today-line" style={{ left: `${todayPercent}%` }} title="今天" />}
      {milestoneLayout.markers.map(({ group, x, row, showLabel }) => {
        const completed = group.milestones.every((item) => item.completed);
        const overdue = !completed && group.date < today;
        const stateClass = completed ? ' is-complete' : overdue ? ' is-overdue' : '';
        return <React.Fragment key={group.date}>
        <i className={`plan-milestone-guide${stateClass}`} style={{ left: `${group.leftPercent}%`, top: 8 + row * 32 }} aria-hidden="true" />
        <button type="button" className={`plan-workspace-milestone-marker${stateClass}${showLabel ? ' has-label' : ''}`}
          style={{ left: x, top: 6 + row * 32 }}
          title={group.milestones.map((item) => `${item.title} · ${item.dueDate}`).join('\n')}
          aria-label={`查看里程碑：${group.milestones.map((item) => item.title).join('、')}，${group.date}`}
          onClick={() => onMilestone(group.milestones)}>
          <span className="plan-workspace-milestone-icon"><Flag />{group.milestones.length > 1 && <b>{group.milestones.length}</b>}</span>
          <span data-milestone-label={group.date} className="plan-workspace-milestone-label" aria-hidden="true">{group.milestones.length > 1 ? `${group.milestones.length} 个里程碑` : group.milestones[0].title}</span>
        </button>
      </React.Fragment>;
      })}
      {structureLayout.positioned.map(({ node, row }) => <div
        className={`plan-structure-bar depth-${Math.min(4, node.depth)}${node.completed ? ' is-complete' : ''}`}
        key={node.projectId}
        style={{ left: `${node.leftPercent}%`, width: `max(1px, calc(${node.widthPercent}% - 3px))`, top: milestoneLayout.height + row * 48 }}
        title={`${lane.rootTitle} / ${node.path.slice(1).join(' / ')}\n${node.startDate} — ${node.endDate}`}>
        <button type="button" className="plan-structure-main"
          aria-label={node.hasChildren ? `${expandedProjects.has(node.projectId) ? '收起' : '展开'}${node.title}` : `打开${node.title}`}
          aria-expanded={node.hasChildren ? expandedProjects.has(node.projectId) : undefined}
          onClick={() => node.hasChildren ? onExpand(node.projectId) : onOpen(node.projectId, node.title)} onDoubleClick={() => onOpen(node.projectId, node.title)}>
          {node.hasChildren && (expandedProjects.has(node.projectId) ? <ChevronDown /> : <ChevronRight />)}
          <span><strong>{node.title}</strong><small>{node.progress}% · {node.startDate.slice(5)} – {node.endDate.slice(5)}</small></span>
        </button>
        <button type="button" className="plan-structure-check" disabled={completionBusy} onClick={() => onComplete(node.projectId)} aria-label={node.completed ? `将${node.title}标记为未完成` : `完成${node.title}`}>{node.completed ? <Check /> : <Circle />}</button>
      </div>)}
    </div>
  </div>;
};

export const PlanWorkspace: React.FC<PlanWorkspaceProps> = ({
  capacitySettings = cachedCapacitySettings(), onOpenLearningSettings,
  notes,
  initialPlanId,
  onToggleTaskCompleted,
  onToggleProjectCompleted,
  onToggleMilestoneCompleted,
  onSelectNoteByTitle,
  onAddTask,
  onAddStructureItem,
  onOpenPlanBuilder,
  onOpenPlanEditor,
  onRequestPlanAdjustment,
}) => {
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(initialPlanId || null);
  const [view, setView] = useState<PlanView>('timeline');
  const [selectedWeekIndex, setSelectedWeekIndex] = useState(0);
  const [addOpen, setAddOpen] = useState(false);
  const [addMode, setAddMode] = useState<PlanAddMode>(null);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [addSaving, setAddSaving] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const addSavingRef = useRef(false);
  const addDialogRef = useRef<HTMLFormElement>(null);
  const adjustDialogRef = useRef<HTMLElement>(null);
  const [taskText, setTaskText] = useState('');
  const [taskDate, setTaskDate] = useState(localDate);
  const [taskKind, setTaskKind] = useState<PlanTaskKind>('learn');
  const [taskMinutes, setTaskMinutes] = useState(60);
  const [taskExecutionKind, setTaskExecutionKind] = useState<PlanExecutionKind>('todo');
  const [taskRecurrence, setTaskRecurrence] = useState<PlanRecurrenceFrequency>('none');
  const [taskRecurrenceWeekdays, setTaskRecurrenceWeekdays] = useState<number[]>([new Date().getDay()]);
  const [taskScopeRootId, setTaskScopeRootId] = useState('');
  const [taskProjectId, setTaskProjectId] = useState('');
  const [structureProjectId, setStructureProjectId] = useState('');
  const [structureParentId, setStructureParentId] = useState('');
  const [structureTitle, setStructureTitle] = useState('');
  const [structureStartDate, setStructureStartDate] = useState(localDate);
  const [structureDueDate, setStructureDueDate] = useState(() => addCalendarDays(localDate(), 13));
  const [structurePriority, setStructurePriority] = useState<'high' | 'medium' | 'low'>('medium');
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const [milestoneDetails, setMilestoneDetails] = useState<PlanWorkspaceMilestone[]>([]);
  const [overviewPhaseRootId, setOverviewPhaseRootId] = useState<string | null>(null);
  const overviewPhaseTabs = useRef(new Map<string, HTMLButtonElement>());
  const [completionState, setCompletionState] = useState<{ busy: boolean; label: string; error: boolean } | null>(null);
  const completionLock = useRef(false);
  const completionRetry = useRef<(() => void | Promise<void>) | null>(null);
  const completionOrigin = useRef<Element | null>(null);
  const completionRetryButton = useRef<HTMLButtonElement>(null);
  const completionMounted = useRef(true);
  useEffect(() => { completionMounted.current = true; return () => { completionMounted.current = false; }; }, []);
  useEffect(() => {
    if (completionState?.error && completionOrigin.current
      && (document.activeElement === document.body || document.activeElement === completionOrigin.current)) {
      completionRetryButton.current?.focus({ preventScroll: true });
    }
  }, [completionState?.error]);
  const saveCompletion = async (label: string, action: () => void | Promise<void>): Promise<void> => {
    if (completionLock.current) return;
    completionLock.current = true;
    completionOrigin.current = document.activeElement;
    completionRetry.current = action;
    setCompletionState({ busy: true, label, error: false });
    try {
      await action();
      if (completionMounted.current) { completionRetry.current = null; setCompletionState(null); }
    } catch {
      if (completionMounted.current) setCompletionState({ busy: false, label, error: true });
    } finally { completionLock.current = false; }
  };
  const completionBusy = Boolean(completionState?.busy);
  const completeProject = (id: string, completed: boolean, title: string) => saveCompletion(title, () => onToggleProjectCompleted(id, completed));
  const completeTask = (task: PlanWorkspaceTask) => saveCompletion(task.taskText,
    () => onToggleTaskCompleted(task.noteId, task.id, task.occurrenceDate, !task.completed));
  const milestoneDialogRef = useRef<HTMLDialogElement>(null);
  const [timelineZoom, setTimelineZoom] = useState<number | null>(readTimelineZoom);
  const [timelineMetrics, setTimelineMetrics] = useState({ viewportWidth: 0, labelWidth: 122 });
  const timelineScrollRef = useRef<HTMLDivElement>(null);
  const timelineScrollLeftRef = useRef(0);
  const [timelineScrollLeft, setTimelineScrollLeft] = useState(0);
  const previousTimelineRef = useRef<{ width: number; viewport: number; label: number; key: string } | null>(null);
  const today = useToday();
  const phaseStatus = (phase: PlanWorkspacePhase) => phase.completed ? '已完成'
    : phase.startDate > today ? '即将开始' : phase.endDate < today ? '待补完' : '进行中';
  const taskCompletionDisabled = (task: PlanWorkspaceTask) => completionBusy || Boolean(task.recurrence && task.recurrence.frequency !== 'none'
    && (!task.occurrenceAvailable || task.occurrenceDate > today || !getLearningCompletionTarget(notes, { noteId: task.noteId, taskId: task.id, occurrenceDate: task.occurrenceDate })));
  const completionFeedback = completionState && <div className="plan-completion-feedback" role={completionState.error ? 'alert' : 'status'} aria-atomic="true">
    {completionState.error ? <AlertTriangle aria-hidden="true" /> : <Loader2 className="plan-saving-spinner" aria-hidden="true" />}
    <span>{completionState.label} · {completionState.error ? '状态未保存，请重试。' : '正在保存状态…'}</span>
    {completionState.error && <button ref={completionRetryButton} type="button" aria-label="重试保存任务状态" onClick={() => {
      if (completionRetry.current) void saveCompletion(completionState.label, completionRetry.current);
    }}>重试保存</button>}
  </div>;
  const closeAddDrawer = () => {
    if (!addSavingRef.current) setAddOpen(false);
  };
  useDialog(addOpen, addDialogRef, addSaving ? undefined : closeAddDrawer, 50);
  useDialog(adjustOpen, adjustDialogRef, () => setAdjustOpen(false), 50);
  useEffect(() => { setAddError(null); }, [addOpen, addMode]);

  const model = useMemo(
    () => buildPlanWorkspaceModel(notes, selectedPlanId, today, capacitySettings),
    [notes, selectedPlanId, today, capacitySettings],
  );
  useEffect(() => {
    if (initialPlanId) setSelectedPlanId(initialPlanId);
  }, [initialPlanId]);
  const overviewPhaseIndex = Math.max(0, model.currentPhases.findIndex(phase => phase.rootId === overviewPhaseRootId));
  const activeOverviewPhase = model.currentPhases[overviewPhaseIndex] || null;
  useEffect(() => {
    if (model.isOverview && !model.currentPhases.some(phase => phase.rootId === overviewPhaseRootId)) {
      setOverviewPhaseRootId(model.currentPhases[0]?.rootId || null);
    }
  }, [model.isOverview, model.currentPhases, overviewPhaseRootId]);
  const selectOverviewPhase = (index: number, focus = false) => {
    const count = model.currentPhases.length;
    if (!count) return;
    const phase = model.currentPhases[((index % count) + count) % count];
    setOverviewPhaseRootId(phase.rootId);
    const tab = overviewPhaseTabs.current.get(phase.rootId);
    if (focus) tab?.focus({ preventScroll: true });
    // Scroll only the label strip. scrollIntoView can also scroll the hidden
    // main-panel ancestor, making the timeline toolbar disappear.
    const strip = tab?.parentElement;
    if (tab && strip) {
      const labelBounds = tab.getBoundingClientRect(), stripBounds = strip.getBoundingClientRect();
      if (labelBounds.left < stripBounds.left) strip.scrollLeft += labelBounds.left - stripBounds.left;
      else if (labelBounds.right > stripBounds.right) strip.scrollLeft += labelBounds.right - stripBounds.right;
    }
  };
  const scopeKey = model.scopeRootIds.join('|');
  const taskProjectOptions = useMemo(() => {
    if (!taskScopeRootId) return [];
    const byId = new Map(model.projectNotes.map((project) => [project.id, project]));
    return model.projectNotes.filter((project) => {
      let current: NoteItem | undefined = project;
      const visited = new Set<string>();
      while (current && !visited.has(current.id)) {
        if (current.id === taskScopeRootId) return true;
        visited.add(current.id);
        current = current.parentId ? byId.get(current.parentId) : undefined;
      }
      return false;
    });
  }, [model.projectNotes, taskScopeRootId]);
  const structureEditor = useMemo(
    () => taskScopeRootId ? buildPublishedPlanEditorValue(notes, taskScopeRootId) : null,
    [notes, taskScopeRootId],
  );
  const structureParentOptions = useMemo(
    () => structureEditor?.tree[0] ? flattenStructureParents(structureEditor.tree[0]) : [],
    [structureEditor],
  );
  const scheduledStructureIds = useMemo(
    () => new Set(structureParentOptions.map((project) => project.id)),
    [structureParentOptions],
  );
  const existingStructureOptions = useMemo(() => (
    (structureEditor?.projectCatalog || []).filter((project) => (
      !scheduledStructureIds.has(project.key)
      && (project.parentKey === structureEditor?.rootId || scheduledStructureIds.has(project.parentKey || ''))
    ))
  ), [scheduledStructureIds, structureEditor]);
  const newStructureParent = structureParentOptions.find((project) => project.id === structureParentId);
  const existingDateProject = existingStructureOptions.find((project) => project.key === structureProjectId);
  const existingDateParent = structureParentOptions.find((project) => project.id === (existingDateProject?.parentKey || structureEditor?.rootId));
  const selectedWeek = model.weeks[selectedWeekIndex] || model.weeks[0];
  const scheduleWidth = getTimelineBoardWidth(timelineMetrics.viewportWidth, timelineMetrics.labelWidth, model.weeks.length, timelineZoom);
  const timelineKey = `${model.selectedPlan?.id}:${model.timelineStartDate}:${model.timelineEndDate}`;
  const effectiveZoom = Math.round((scheduleWidth - timelineMetrics.labelWidth) / Math.max(1, model.weeks.length) / PLAN_TIMELINE_BASE_WEEK_WIDTH * 100);
  const showTimelineDays = (scheduleWidth - timelineMetrics.labelWidth) / model.totalDays >= 32;
  const timelineColumnCount = showTimelineDays ? model.totalDays : model.weeks.length;
  const timelineColumns = useMemo(() => getTimelineVisibleColumns({
    columnCount: timelineColumnCount, boardWidth: scheduleWidth, viewportWidth: timelineMetrics.viewportWidth,
    labelWidth: timelineMetrics.labelWidth, scrollLeft: timelineScrollLeft, minLabelWidth: showTimelineDays ? 32 : 72,
  }), [timelineColumnCount, scheduleWidth, timelineMetrics, timelineScrollLeft, showTimelineDays]);

  useEffect(() => {
    try { localStorage.setItem(TIMELINE_ZOOM_KEY, timelineZoom === null ? 'fit' : String(timelineZoom)); } catch { /* Optional preference. */ }
  }, [timelineZoom]);

  useLayoutEffect(() => {
    const scroll = timelineScrollRef.current;
    if (view !== 'timeline' || !scroll) return;
    const spacer = scroll.querySelector<HTMLElement>('.plan-lane-spacer');
    const measure = () => {
      const viewportWidth = scroll.clientWidth;
      const labelWidth = spacer?.getBoundingClientRect().width || 122;
      setTimelineMetrics((current) => current.viewportWidth === viewportWidth && current.labelWidth === labelWidth
        ? current : { viewportWidth, labelWidth });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(scroll);
    if (spacer) observer.observe(spacer);
    measure();
    return () => observer.disconnect();
  }, [view, Boolean(model.selectedPlan)]);

  useLayoutEffect(() => {
    const scroll = timelineScrollRef.current;
    if (view !== 'timeline' || !scroll || !timelineMetrics.viewportWidth) return;
    const previous = previousTimelineRef.current;
    const nextScroll = previous?.key === timelineKey
      ? getTimelineZoomScrollLeft({
        scrollLeft: timelineScrollLeftRef.current,
        viewportWidth: previous.viewport,
        labelWidth: previous.label,
        previousBoardWidth: previous.width,
        nextBoardWidth: scheduleWidth,
      }) + (previous.viewport - timelineMetrics.viewportWidth) / 2
      : getTimelineDateScrollLeft({
        datePercent: model.todayPercent ?? 0, boardWidth: scheduleWidth,
        viewportWidth: timelineMetrics.viewportWidth, labelWidth: timelineMetrics.labelWidth,
      });
    scroll.scrollLeft = Math.max(0, Math.min(scheduleWidth - timelineMetrics.viewportWidth, nextScroll));
    timelineScrollLeftRef.current = scroll.scrollLeft;
    setTimelineScrollLeft(scroll.scrollLeft);
    previousTimelineRef.current = { width: scheduleWidth, viewport: timelineMetrics.viewportWidth, label: timelineMetrics.labelWidth, key: timelineKey };
  }, [scheduleWidth, timelineMetrics, timelineKey, view, model.todayPercent]);

  const changeTimelineZoom = (direction: -1 | 1) => {
    const current = timelineZoom ?? effectiveZoom;
    const next = direction > 0 ? PLAN_TIMELINE_ZOOM_STOPS.find((stop) => stop > current)
      : [...PLAN_TIMELINE_ZOOM_STOPS].reverse().find((stop) => stop < current);
    setTimelineZoom(next ?? (direction < 0 ? null : PLAN_TIMELINE_MAX_ZOOM));
  };
  const focusTimelineToday = () => {
    if (model.todayPercent === null) return;
    timelineScrollRef.current?.scrollTo({ left: getTimelineDateScrollLeft({
      datePercent: model.todayPercent, boardWidth: scheduleWidth,
      viewportWidth: timelineMetrics.viewportWidth, labelWidth: timelineMetrics.labelWidth,
    }), behavior: 'auto' });
  };

  useEffect(() => {
    if (model.selectedPlan && model.selectedPlan.id !== selectedPlanId) setSelectedPlanId(model.selectedPlan.id);
  }, [model.selectedPlan, selectedPlanId]);

  useEffect(() => {
    if (!model.weeks.length) return;
    const current = model.weeks.findIndex((week) => dateRangeContains(today, week.startDate, week.endDate));
    setSelectedWeekIndex(current >= 0 ? current : 0);
  }, [model.selectedPlan?.id, model.timelineStartDate, model.weeks.length, today]);

  useEffect(() => {
    const dialog = milestoneDialogRef.current;
    if (milestoneDetails.length && dialog && !dialog.open) dialog.showModal();
  }, [milestoneDetails.length]);

  useEffect(() => {
    setTaskScopeRootId(model.isOverview ? model.scopeRootIds[0] || '' : model.root?.id || '');
    setTaskProjectId('');
    setStructureProjectId('');
    setStructureParentId('');
  }, [model.selectedPlan?.id, model.isOverview, model.root?.id, scopeKey]);

  useEffect(() => {
    if (taskProjectId && taskProjectOptions.some((project) => project.id === taskProjectId)) return;
    setTaskProjectId(taskProjectOptions.find((project) => project.id === taskScopeRootId)?.id || taskProjectOptions[0]?.id || '');
  }, [taskProjectOptions, taskProjectId, taskScopeRootId]);

  useEffect(() => {
    if (!structureParentOptions.length) return;
    if (!structureParentOptions.some((project) => project.id === structureParentId)) {
      setStructureParentId(structureParentOptions[0].id);
    }
  }, [structureParentId, structureParentOptions]);

  useEffect(() => {
    if (!existingStructureOptions.length) {
      setStructureProjectId('');
      return;
    }
    if (!existingStructureOptions.some((project) => project.key === structureProjectId)) {
      setStructureProjectId(existingStructureOptions[0].key);
    }
  }, [existingStructureOptions, structureProjectId]);

  // Recompute defaults only when the actual scheduling context changes.
  // A normal note save creates new option arrays but must not erase typed dates.
  useEffect(() => {
    if (!addOpen || addMode !== 'existing' || !structureProjectId) return;
    const project = existingDateProject;
    if (!project) return;
    const parent = existingDateParent;
    const startDate = project.startDate || parent?.startDate || today;
    const dueDate = project.dueDate || (parent?.dueDate && addCalendarDays(startDate, 13) > parent.dueDate
      ? parent.dueDate : addCalendarDays(startDate, 13));
    setStructureStartDate(startDate);
    setStructureDueDate(dueDate < startDate ? startDate : dueDate);
    setStructurePriority(project.priority || 'medium');
  }, [addOpen, addMode, structureProjectId, existingDateProject?.startDate, existingDateProject?.dueDate,
    existingDateProject?.priority, existingDateParent?.startDate, existingDateParent?.dueDate, today]);

  useEffect(() => {
    if (!addOpen || addMode !== 'new' || !newStructureParent) return;
    const { startDate, dueDate } = newPlanStructureDates(today, newStructureParent);
    setStructureStartDate(startDate);
    setStructureDueDate(dueDate);
  }, [addOpen, addMode, structureParentId, newStructureParent?.startDate, newStructureParent?.dueDate, today]);

  if (!model.selectedPlan || !model.scopeRoots.length) {
    return (
      <section className="plan-workspace plan-workspace-empty">
        <div className="plan-empty-mark" aria-hidden="true"><CalendarDays /></div>
        <span>LEARNING PLAN</span>
        <h1>从一个清晰的目标开始</h1>
        <p>当前还没有可展示的根项目。创建计划后，阶段、练习、复习与里程碑会汇聚到同一条时间线上。</p>
        <button type="button" className="plan-primary-action" onClick={onOpenPlanBuilder}><Plus />制定新计划</button>
      </section>
    );
  }

  const completedText = `已完成 ${model.selectedPlan.completedTaskCount} / ${model.selectedPlan.taskCount} 项任务`;
  const currentWeekTasks = selectedWeek
    ? buildExecutionAgendaOccurrences(model.tasks, selectedWeek.startDate, selectedWeek.endDate, today)
    : [];
  const currentWeekStructureItems = selectedWeek
    ? buildStructureAgendaOccurrences(model.structureDueItems, selectedWeek.startDate, selectedWeek.endDate, today)
    : [];
  const currentWeekAgenda = [
    ...currentWeekStructureItems.map(({ item, occurrenceDate }) => ({ type: 'structure' as const, dueDate: occurrenceDate, item })),
    ...currentWeekTasks.map((item) => ({ type: 'execution' as const, dueDate: item.occurrenceDate, item })),
  ].sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const remainingDays = model.selectedPlan.targetDate
    ? Math.max(0, Math.ceil((new Date(`${model.selectedPlan.targetDate}T00:00:00Z`).getTime() - Date.now()) / 86_400_000))
    : null;
  const executionLayout = layoutTasks(model.tasks);
  const capacity = buildLearningCapacity(notes, selectedWeek?.startDate, capacitySettings, today);
  const selectedWeekMinutes = capacity.byRoot.filter(r => model.scopeRootIds.includes(r.rootId)).reduce((s, r) => s + r.scheduledMinutes, 0);
  const weeklyLoad = capacity.percent ?? 0;
  const planConditions = model.root?.planMeta?.conditions;
  const activeWeekdays = model.isOverview
    ? Array.from(new Set(model.scopeRoots.flatMap((scopeRoot) => scopeRoot.planMeta?.activeWeekdays?.length
      ? scopeRoot.planMeta.activeWeekdays : [1, 2, 3, 4, 5, 6])))
    : model.root?.planMeta?.activeWeekdays?.length ? model.root.planMeta.activeWeekdays : [1, 2, 3, 4, 5, 6];
  // Explicit milestones are deliberate checkpoints; inferred project deadlines are a legacy fallback.
  const displayMilestones = model.scopeRootIds.flatMap((rootId) => {
    const rootMilestones = model.milestones.filter((milestone) => milestone.rootId === rootId);
    const explicitMilestones = rootMilestones.filter((milestone) => !milestone.implicit);
    return explicitMilestones.length ? explicitMilestones : rootMilestones;
  }).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const nextMilestone = displayMilestones.find((item) => !item.completed && item.dueDate >= today)
    || displayMilestones.find((item) => !item.completed);
  const pendingMilestones = displayMilestones.filter(item => !item.completed);
  const summaryMilestones = (pendingMilestones.length ? pendingMilestones : displayMilestones).slice(0, 6);
  const resolvedMilestoneDetails = milestoneDetails.map((detail) => (
    displayMilestones.find((milestone) => milestone.rootId === detail.rootId && milestone.id === detail.id) || detail
  ));
  const workspaceTitle = model.isOverview ? '综合计划总览' : model.selectedPlan.shortTitle;
  const workspaceSummary = model.isOverview
    ? `统筹 ${model.scopeRoots.length} 个根项目，在同一时间轴上检查并行进度、里程碑与本周负荷。`
    : model.root?.planMeta?.summary || '沿着阶段成果推进学习，在练习、复习与真实输出中建立稳定能力。';
  const loadBudgetLabel = model.isOverview ? '各计划预算合计' : '计划负荷';
  const selectedExistingProject = existingStructureOptions.find((project) => project.key === structureProjectId);
  const structureConstraintParent = addMode === 'existing'
    ? structureParentOptions.find((project) => project.id === (selectedExistingProject?.parentKey || structureEditor?.rootId))
    : structureParentOptions.find((project) => project.id === structureParentId);
  const structureDateError = !structureStartDate || !structureDueDate
    ? addMode === 'new' && structureConstraintParent?.dueDate && structureConstraintParent.dueDate < today
      ? `父项目已于 ${structureConstraintParent.dueDate} 结束，请先调整父项目日期、选择其他父项目，或手动填写要补录的历史起止日期。`
      : '请设置完整的起止日期'
    : structureDueDate < structureStartDate
      ? '结束日期不能早于开始日期'
      : structureConstraintParent?.startDate && structureStartDate < structureConstraintParent.startDate
        ? `开始日期不能早于父项目（${structureConstraintParent.startDate}）`
        : structureConstraintParent?.dueDate && structureDueDate > structureConstraintParent.dueDate
          ? `结束日期不能晚于父项目（${structureConstraintParent.dueDate}）`
          : '';

  const submitTask = async (event: React.FormEvent) => {
    event.preventDefault();
    if (addSavingRef.current) return;
    if (!taskText.trim() || !taskDate || !taskScopeRootId
      || !taskProjectOptions.some((project) => project.id === taskProjectId)) return;
    addSavingRef.current = true;
    setAddSaving(true);
    setAddError(null);
    try {
      const saved = await onAddTask({
        scopeRootId: taskScopeRootId,
        noteId: taskProjectId,
        taskText: taskText.trim(),
        dueDate: taskDate,
        kind: taskKind,
        estimatedMinutes: Math.min(1440, Math.max(5, taskMinutes)),
        executionKind: taskExecutionKind,
        recurrenceFrequency: taskRecurrence,
        recurrenceWeekdays: taskRecurrence === 'weekly' || taskRecurrence === 'custom' ? taskRecurrenceWeekdays : undefined,
      });
      if (saved === false) throw new Error('执行事项未保存成功，请重试。');
      setTaskText('');
      setAddOpen(false);
    } catch (error) {
      setAddError(error instanceof Error ? error.message : '保存失败，请重试。');
    } finally {
      addSavingRef.current = false;
      setAddSaving(false);
    }
  };

  const submitStructureItem = async (event: React.FormEvent) => {
    event.preventDefault();
    if (addSavingRef.current) return;
    if (structureDateError || !taskScopeRootId) return;
    const input: PublishedPlanStructureAddInput | null = addMode === 'existing' && structureProjectId
      ? {
        mode: 'existing', rootId: taskScopeRootId, projectId: structureProjectId,
        startDate: structureStartDate, dueDate: structureDueDate, priority: structurePriority,
      }
      : addMode === 'new' && structureParentId && structureTitle.trim()
        ? {
          mode: 'new', rootId: taskScopeRootId, parentId: structureParentId, title: structureTitle.trim(),
          startDate: structureStartDate, dueDate: structureDueDate, priority: structurePriority,
        }
        : null;
    if (!input) return;
    addSavingRef.current = true;
    setAddSaving(true);
    setAddError(null);
    try {
      const saved = await onAddStructureItem(input);
      if (saved === false) throw new Error('结构项目未保存成功，请重试。');
      setStructureTitle('');
      setAddMode(null);
      setAddOpen(false);
    } catch (error) {
      setAddError(error instanceof Error ? error.message : '保存失败，请重试。');
    } finally {
      addSavingRef.current = false;
      setAddSaving(false);
    }
  };

  const renderTimeline = () => {
    const activeStructureLanes = model.structureLanes.filter((lane) => !lane.completed
      || pendingMilestones.some(milestone => milestone.rootId === lane.rootId));
    return <div className="plan-timeline-scroll" ref={timelineScrollRef} tabIndex={0} role="region" aria-label="计划时间线，可横向滚动查看日期"
      onScroll={(event) => {
        const scrollLeft = event.currentTarget.scrollLeft;
        timelineScrollLeftRef.current = scrollLeft;
        const columns = getTimelineVisibleColumns({
          columnCount: timelineColumnCount, boardWidth: scheduleWidth, viewportWidth: timelineMetrics.viewportWidth,
          labelWidth: timelineMetrics.labelWidth, scrollLeft, minLabelWidth: showTimelineDays ? 32 : 72,
        });
        if (columns[0]?.index !== timelineColumns[0]?.index || columns.at(-1)?.index !== timelineColumns.at(-1)?.index) {
          setTimelineScrollLeft(scrollLeft);
        }
      }}>
      <div className={`plan-timeline-board plan-dual-workspace-board${showTimelineDays ? ' is-day-scale' : ''}`} style={{ width: scheduleWidth || '100%', minWidth: '100%', '--plan-timeline-viewport-width': `${timelineMetrics.viewportWidth}px` } as React.CSSProperties}>
        <div className="plan-timeline-weeks" style={{ gridTemplateColumns: 'var(--plan-lane-label-width) minmax(0, 1fr)' }}>
          <div className="plan-lane-spacer" />
          {timelineColumns.map(({ index, span }) => {
            const date = showTimelineDays ? addCalendarDays(model.timelineStartDate, index) : model.weeks[index].startDate;
            const week = model.weeks[showTimelineDays ? Math.floor(index / 7) : index];
            const lastWeek = model.weeks[index + span - 1];
            return <button type="button" key={index} title={date}
              style={{ position: 'absolute', top: 0, bottom: 0, left: timelineMetrics.labelWidth + index / timelineColumnCount * (scheduleWidth - timelineMetrics.labelWidth), width: span / timelineColumnCount * (scheduleWidth - timelineMetrics.labelWidth) }}
              className={(showTimelineDays ? date === today : selectedWeekIndex >= index && selectedWeekIndex < index + span) ? 'is-active' : ''}
              onClick={() => setSelectedWeekIndex(week.index)}>
              <strong>{showTimelineDays ? date.slice(5).replace('-', '/') : span > 1 ? `第 ${index + 1}–${index + span} 周` : week.label}</strong>
              <span>{showTimelineDays ? weekdayLabel(date) : span > 1 ? `${week.startDate.slice(5)} – ${lastWeek.endDate.slice(5)}` : week.rangeLabel}</span>
            </button>;
          })}
        </div>

        <div className="plan-dual-section-title"><FolderTree /><span><strong>结构轨道</strong><small>不同根项目独立成轨 · 点击展开下级 · 双击打开笔记</small></span></div>
        {activeStructureLanes.length ? activeStructureLanes.map((lane) => <StructureTimelineLane
          key={lane.rootId} lane={lane} columns={timelineColumns} columnCount={timelineColumnCount} today={today} todayPercent={model.todayPercent}
          milestones={displayMilestones.filter((milestone) => milestone.rootId === lane.rootId)}
          expandedProjects={expandedProjects}
          onExpand={(id) => setExpandedProjects((current) => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
          })}
          onOpen={onSelectNoteByTitle} completionBusy={completionBusy}
          onComplete={(id) => { const node = lane.nodes.find(item => item.projectId === id); if (node) void completeProject(id, !node.completed, node.title); }} onMilestone={setMilestoneDetails}
        />) : <div className="plan-structure-empty">{model.structureLanes.length ? <Check /> : <CalendarDays />}<span>{model.structureLanes.length ? '所有已排期结构项目均已完成，轨道已移入历史。' : '暂无已排期结构项目；普通笔记不会显示为计划任务。'}</span></div>}

        <div className="plan-dual-section-title is-execution"><Repeat2 /><span><strong>执行轨道</strong><small>周期事项与独立待办 · 自动错行避免重叠</small></span></div>
        <div className="plan-timeline-lane plan-execution-lane" style={{ minHeight: Math.max(82, 24 + (Math.max(0, ...executionLayout.map((item) => item.row)) + 1) * 40) }}>
          <div className="plan-lane-label"><Repeat2 /><strong>执行事项</strong><span>{model.tasks.length} 条规则</span></div>
          <div className="plan-lane-track">
            <TimelineGrid columns={timelineColumns} columnCount={timelineColumnCount} />
            {executionLayout.map(({ task, row }) => {
              const recurring = Boolean(task.recurrence && task.recurrence.frequency !== 'none');
              const end = recurring ? task.recurrence?.endDate || '持续' : task.dueDate;
              return <button type="button" key={`${task.noteId}-${task.id}`} className={`plan-task-bar is-${task.kind}${task.completed && !recurring ? ' is-complete' : ''}`} style={{ left: `${task.leftPercent}%`, width: `${task.widthPercent}%`, top: `${10 + row * 40}px` }} onClick={() => onSelectNoteByTitle(task.noteId, task.noteTitle)} title={`${model.isOverview ? `${task.rootTitle} / ` : ''}${task.taskText} · ${executionRecurrenceLabel(task)} · ${task.startDate} 至 ${end}${recurring && task.occurrenceAvailable ? ` · ${task.occurrenceDate}${task.completed ? ' 已完成' : ' 待完成'}` : ''}`}><span>{task.taskText}</span><small>{model.isOverview ? `${task.rootTitle} · ` : ''}{executionRecurrenceLabel(task)} · {task.estimatedMinutes} 分钟</small></button>;
            })}
          </div>
        </div>
      </div>
    </div>;
  };

  const renderWeek = () => {
    if (!selectedWeek) return null;
    const days = Array.from({ length: 7 }, (_, index) => {
      const day = new Date(`${selectedWeek.startDate}T00:00:00Z`);
      day.setUTCDate(day.getUTCDate() + index);
      return day.toISOString().slice(0, 10);
    });
    return (
      <div className="plan-week-board">
        {days.map((day) => {
          const tasks = currentWeekTasks.filter((task) => task.occurrenceDate === day);
          const projects = currentWeekStructureItems.filter((entry) => entry.occurrenceDate === day);
          const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
          const isRestDay = !activeWeekdays.includes(weekday);
          return <section key={day} className={isRestDay ? 'is-rest-day' : ''}>
            <header><span>{weekdayLabel(day)}</span><strong>{day.slice(5).replace('-', '.')}</strong>{isRestDay && <small>休息日</small>}</header>
            <div>
              {projects.map(({ item }) => <button key={`${item.rootId}-${item.id}`} type="button" className={`is-structure${item.completed ? ' is-complete' : ''}`} title={item.path.join(' > ')} onClick={() => onSelectNoteByTitle(item.projectId, item.title)}><small>{model.isOverview ? `${item.rootTitle} · ` : ''}项目 · {item.completed ? '已完成' : '待完成'}</small><strong>{item.title}</strong><span>{item.startDate.slice(5)} — {item.dueDate.slice(5)}</span></button>)}
              {tasks.map((task) => <button key={`${task.noteId}-${task.id}-${task.occurrenceDate}`} type="button" className={`is-${task.kind}${task.completed ? ' is-complete' : ''}`} onClick={() => onSelectNoteByTitle(task.noteId, task.noteTitle)}><small>{model.isOverview ? `${task.rootTitle} · ` : ''}{TASK_KIND_LABEL[task.kind]}{task.completed ? ' · 已完成' : ''}</small><strong>{task.taskText}</strong><span>{task.estimatedMinutes} 分钟</span></button>)}
            </div>
          </section>;
        })}
      </div>
    );
  };

  const renderList = () => (
    <div className="plan-list-view">
      {model.structureDueItems.map((project) => <article key={`${project.rootId}-${project.id}`} className={`is-structure${project.completed ? ' is-complete' : ''}`}>
        <button type="button" className={`plan-task-check${project.completed ? ' is-complete' : ''}`} disabled={completionBusy} onClick={() => completeProject(project.projectId, !project.completed, project.title)} aria-label={project.completed ? `将${project.title}标记为未完成` : `完成${project.title}`}>{project.completed ? <Check /> : <Circle />}</button>
        <div><strong>{project.title}</strong><button type="button" title={project.path.join(' > ')} onClick={() => onSelectNoteByTitle(project.projectId, project.title)}>{model.isOverview ? project.rootTitle : project.path.slice(0, -1).join(' > ')}{model.isOverview && project.path.slice(1, -1).length ? ` · ${project.path.slice(1, -1).join(' > ')}` : ''}</button></div>
        <span className="plan-kind-pill">项目</span><time>{project.startDate}</time><time>{project.dueDate}</time>
      </article>)}
      {model.tasks.map((task) => (
        <article key={`${task.noteId}-${task.id}`} className={task.completed ? 'is-complete' : ''}>
          <TaskCheck task={task} disabled={taskCompletionDisabled(task)} onToggle={() => completeTask(task)} />
          <div><strong>{task.taskText}</strong><button type="button" onClick={() => onSelectNoteByTitle(task.noteId, task.noteTitle)}>{model.isOverview ? task.rootTitle : task.projectTitle}{model.isOverview && task.projectTitle !== task.rootTitle ? ` · ${task.projectTitle}` : ''}</button></div>
          <span className={`plan-kind-pill is-${task.kind}`}>{TASK_KIND_LABEL[task.kind]}</span>
          <span>{task.estimatedMinutes} 分钟</span>
          <time title={task.recurrence && task.recurrence.frequency !== 'none' ? task.occurrenceAvailable ? '本次日期' : '周期结束日期' : '截止日期'}>{task.recurrence && task.recurrence.frequency !== 'none' ? task.occurrenceDate : task.dueDate}</time>
        </article>
      ))}
    </div>
  );

  return (
    <section className="plan-workspace">
      {!milestoneDetails.length && completionFeedback}
      <header className="plan-workspace-header">
        <div className="plan-title-block">
          <label>
            <span>LEARNING PLAN</span>
            <select value={model.selectedPlan.id} onChange={(event) => setSelectedPlanId(event.target.value)} aria-label="切换学习计划">
              <option value={PLAN_OVERVIEW_ID}>综合总览</option>
              {model.plans.map((plan) => <option value={plan.id} key={plan.id}>{plan.shortTitle}</option>)}
            </select>
          </label>
          <h1>{workspaceTitle}</h1>
          <p>{workspaceSummary}</p>
          <div className="plan-condition-chips" aria-label={model.isOverview ? '综合计划状态' : '当前计划条件'}>
            {model.isOverview ? <>
              <span>{model.scopeRoots.length} 个根项目</span>
              <span>{model.structureDueItems.length} 个结构任务</span>
              <span>{model.tasks.length} 条执行事项</span>
              <span>个人共享周预算 {capacity.budgetMinutes ?? '待确认'} 分钟</span>
            </> : <>
              {planConditions?.startingLevel && <span>{STARTING_LEVEL_LABEL[planConditions.startingLevel]}</span>}
              {planConditions?.pace && <span>{PACE_LABEL[planConditions.pace]}</span>}
              {planConditions?.preferredSessionMinutes && <span>单次 {planConditions.preferredSessionMinutes} 分钟</span>}
              {planConditions?.preferredTimeOfDay && <span>{TIME_LABEL[planConditions.preferredTimeOfDay]}</span>}
              <span>本计划每日 {model.root?.planMeta?.dailyStudyMinutes ?? '待确认'} 分钟 · 个人周预算 {capacity.budgetMinutes ?? '待确认'} 分钟</span>
              <span>{activeWeekdays.length} 个学习日</span>
            </>}
          </div>
        </div>
        <button type="button" className="plan-create-button" onClick={onOpenPlanBuilder}><Plus />制定新计划</button>
      </header>

      <div className="plan-workspace-grid">
        <div className="plan-overview-cards">
          <article className="plan-progress-card">
            <div className="plan-progress-ring" style={{ '--plan-progress': `${model.selectedPlan.progress * 3.6}deg` } as React.CSSProperties}><strong>{model.selectedPlan.progress}%</strong></div>
            <div><span>总体进度</span><strong>{completedText}</strong><i><b style={{ width: `${model.selectedPlan.progress}%` }} /></i></div>
          </article>
          <article><Milestone /><div><span>下一个里程碑</span><strong>{nextMilestone
            ? <button type="button" className="plan-milestone-open" aria-label={`查看下一个里程碑：${nextMilestone.title}`} onClick={() => setMilestoneDetails([nextMilestone])}>{nextMilestone.title}</button>
            : '等待设定里程碑'}</strong><small>{nextMilestone ? `${model.isOverview ? `${nextMilestone.rootTitle} · ` : ''}预计 ${formatDateLabel(nextMilestone.dueDate)}` : '可在调整计划中补充验收节点'}</small></div><ArrowRight /></article>
          <article><Target /><div><span>预计完成日期</span><strong>{formatDateLabel(model.selectedPlan.targetDate)}</strong><small>{remainingDays === null ? '尚未设置目标日' : `剩余 ${remainingDays} 天 · 按当前计划推进`}</small></div></article>
        </div>
        <main className="plan-main-panel">
          <div className="plan-view-toolbar">
            <nav aria-label="计划视图">
              <button type="button" className={view === 'timeline' ? 'is-active' : ''} onClick={() => setView('timeline')}><BarChart3 />时间线</button>
              <button type="button" className={view === 'week' ? 'is-active' : ''} onClick={() => setView('week')}><CalendarDays />周视图</button>
              <button type="button" className={view === 'list' ? 'is-active' : ''} onClick={() => setView('list')}><List />列表</button>
            </nav>
            {view === 'timeline' && <div className="plan-timeline-zoom" role="group" aria-label="时间线宽度">
              <button type="button" aria-label="缩小时间线" title="缩小日期间距" disabled={timelineZoom === null || scheduleWidth <= timelineMetrics.viewportWidth} onClick={() => changeTimelineZoom(-1)}><Minus /></button>
              <input type="range" min={PLAN_TIMELINE_MIN_ZOOM} max={PLAN_TIMELINE_MAX_ZOOM} step={PLAN_TIMELINE_ZOOM_STEP}
                value={timelineZoom ?? Math.max(PLAN_TIMELINE_MIN_ZOOM, Math.min(PLAN_TIMELINE_MAX_ZOOM, effectiveZoom))}
                aria-label="时间线缩放" aria-valuetext={timelineZoom === null ? '适应窗口' : `${timelineZoom}%`}
                onChange={(event) => setTimelineZoom(Number(event.target.value))} />
              <button type="button" aria-label="放大时间线" title="放大日期间距，展开短任务" disabled={timelineZoom === PLAN_TIMELINE_MAX_ZOOM} onClick={() => changeTimelineZoom(1)}><Plus /></button>
              <output>{timelineZoom === null ? '全览' : `${timelineZoom}%`}</output>
              <button type="button" className={timelineZoom === null ? 'is-fit' : ''} aria-pressed={timelineZoom === null} onClick={() => setTimelineZoom(null)} title="缩放至完整计划宽度"><Maximize2 />适应窗口</button>
              <button type="button" disabled={model.todayPercent === null} onClick={focusTimelineToday} title="定位到今天">今天</button>
            </div>}
            <div className="plan-view-actions">
              <button type="button" onClick={() => setAdjustOpen(true)}><SlidersHorizontal />调整计划</button>
              <button type="button" className="is-primary" onClick={() => { setAddMode(null); setAddOpen(true); }}><Plus />添加任务</button>
            </div>
          </div>
          {view === 'timeline' ? renderTimeline() : view === 'week' ? renderWeek() : renderList()}

          <div className="plan-bottom-summary">
            <section>
              <header className="plan-milestone-summary-header"><span><i />里程碑详情{pendingMilestones.length ? ` · 待验收 ${pendingMilestones.length}` : displayMilestones.length ? ' · 全部完成' : ''}</span>
                {displayMilestones.length > 0 && <button type="button" className="plan-milestone-show-all" onClick={() => setMilestoneDetails(displayMilestones)}>查看全部（{displayMilestones.length}）</button>}
              </header>
              <div className="plan-milestone-sequence">
                {summaryMilestones.map((milestone, index) => <React.Fragment key={`${milestone.rootId}-${milestone.id}`}>
                  {index > 0 && <i />}
                  <button type="button" onClick={() => setMilestoneDetails([milestone])} className={milestone.completed ? 'is-complete' : milestone.dueDate < today ? 'is-overdue' : milestone.rootId === nextMilestone?.rootId && milestone.id === nextMilestone?.id ? 'is-next' : ''}><span>{milestone.completed ? <Check /> : <Milestone />}</span><strong>{milestone.title}</strong><small>{model.isOverview ? `${milestone.rootTitle} · ` : ''}{milestone.dueDate.slice(5).replace('-', '.')}</small></button>
                </React.Fragment>)}
              </div>
            </section>
            {model.isOverview ? <section className="plan-current-phase is-overview">
              <header className="plan-phase-carousel-header">
                <span>多计划并行</span>
                {model.currentPhases.length > 1 && <nav aria-label="切换根项目当前阶段">
                  <button type="button" aria-label="上一个根项目" onClick={() => selectOverviewPhase(overviewPhaseIndex - 1)}><ChevronLeft aria-hidden="true" /></button>
                  <output aria-live="polite">{overviewPhaseIndex + 1} / {model.currentPhases.length}</output>
                  <button type="button" aria-label="下一个根项目" onClick={() => selectOverviewPhase(overviewPhaseIndex + 1)}><ChevronRight aria-hidden="true" /></button>
                </nav>}
              </header>
              {model.currentPhases.length > 0 && <div className="plan-phase-tabs" role="tablist" aria-label="根项目">
                {model.currentPhases.map((phase, index) => <button
                  key={phase.rootId}
                  id={`plan-phase-tab-${index}`}
                  ref={element => {
                    if (element) overviewPhaseTabs.current.set(phase.rootId, element);
                    else overviewPhaseTabs.current.delete(phase.rootId);
                  }}
                  type="button"
                  role="tab"
                  tabIndex={activeOverviewPhase?.rootId === phase.rootId ? 0 : -1}
                  aria-selected={activeOverviewPhase?.rootId === phase.rootId}
                  aria-controls="plan-overview-current-phase"
                  className={activeOverviewPhase?.rootId === phase.rootId ? 'is-active' : ''}
                  title={phase.rootTitle}
                  onClick={() => selectOverviewPhase(index)}
                  onKeyDown={event => {
                    if (event.altKey || event.ctrlKey || event.metaKey) return;
                    const next = event.key === 'ArrowRight' ? index + 1 : event.key === 'ArrowLeft' ? index - 1
                      : event.key === 'Home' ? 0 : event.key === 'End' ? model.currentPhases.length - 1 : null;
                    if (next !== null) { event.preventDefault(); selectOverviewPhase(next, true); }
                  }}
                >{phase.rootTitle}</button>)}
              </div>}
              {activeOverviewPhase ? <div
                key={`${activeOverviewPhase.rootId}-${activeOverviewPhase.projectId}`}
                id="plan-overview-current-phase"
                className="plan-phase-carousel-panel"
                role="tabpanel"
                aria-labelledby={`plan-phase-tab-${overviewPhaseIndex}`}
              >
                <strong><i />{activeOverviewPhase.title}</strong>
                <span><b>{activeOverviewPhase.rootTitle}</b>{activeOverviewPhase.startDate.slice(5)} – {activeOverviewPhase.endDate.slice(5)} · {phaseStatus(activeOverviewPhase)}</span>
                <div><i role="progressbar" aria-label={`${activeOverviewPhase.rootTitle}当前阶段进度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={activeOverviewPhase.progress}><b style={{ width: `${activeOverviewPhase.progress}%` }} /></i><em>{activeOverviewPhase.progress}%</em></div>
                <p>{activeOverviewPhase.outcome}</p>
              </div> : <p className="plan-phase-empty">当前没有进行中的阶段。</p>}
            </section> : <section className="plan-current-phase">
                <header>当前阶段</header>
                <strong><i />{model.currentPhase?.title || '等待阶段安排'}</strong>
                <span>{model.currentPhase ? `${model.currentPhase.startDate.slice(5)} – ${model.currentPhase.endDate.slice(5)} · ${phaseStatus(model.currentPhase)}` : '—'}</span>
                <div><i role="progressbar" aria-label="当前阶段进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={model.currentPhase?.progress || 0}><b style={{ width: `${model.currentPhase?.progress || 0}%` }} /></i><em>{model.currentPhase?.progress || 0}%</em></div>
                <p>{model.currentPhase?.outcome}</p>
              </section>}
          </div>
        </main>

        <aside className="plan-week-agenda">
          <header>
            <div><h2>本周安排 <span>（{selectedWeek?.label || '—'}）</span></h2><p>{selectedWeek ? `${formatDateLabel(selectedWeek.startDate)} – ${formatDateLabel(selectedWeek.endDate)}` : '尚无周安排'}</p></div>
            <nav><button type="button" aria-label="上一周" disabled={selectedWeekIndex <= 0} onClick={() => setSelectedWeekIndex((value) => Math.max(0, value - 1))}><ChevronLeft /></button><button type="button" aria-label="下一周" disabled={selectedWeekIndex >= model.weeks.length - 1} onClick={() => setSelectedWeekIndex((value) => Math.min(model.weeks.length - 1, value + 1))}><ChevronRight /></button></nav>
          </header>
          <div className="plan-week-load"><span>当前范围 {selectedWeekMinutes} 分钟 · 个人总负荷</span><strong>{capacity.scheduledMinutes} / {capacity.budgetMinutes ?? '待确认'} 分钟{capacity.percent === null ? '' : ` · ${capacity.percent}%`}</strong><i><b className={weeklyLoad > 100 ? 'is-overload' : ''} style={{ width: `${Math.min(100, weeklyLoad)}%` }} /></i></div>
          <div className="plan-budget-entry">
            <button type="button" onClick={onOpenLearningSettings} aria-label={`调整个人周预算，当前为 ${capacity.budgetMinutes ?? '待确认'} 分钟`}>
              <span className="plan-budget-entry-icon"><SlidersHorizontal aria-hidden="true" /></span>
              <span className="plan-budget-entry-copy">
                <strong>个人周预算</strong>
                <small>{capacity.budgetMinutes == null ? '尚未确认' : `${capacity.budgetMinutes} 分钟`} · 所有计划共享</small>
              </span>
              <span className="plan-budget-entry-action">调整 <ChevronRight aria-hidden="true" /></span>
            </button>
          </div>
          <div className="plan-agenda-list">
            {currentWeekAgenda.length ? currentWeekAgenda.map((entry, index) => {
              const showDate = index === 0 || currentWeekAgenda[index - 1].dueDate !== entry.dueDate;
              const completed = entry.item.completed;
              const recurring = entry.type === 'execution' && entry.item.recurrence && entry.item.recurrence.frequency !== 'none';
              const overdue = !completed && !recurring && entry.item.dueDate < today;
              if (entry.type === 'structure') {
                const project = entry.item;
                return <React.Fragment key={`${project.rootId}-${project.id}-${entry.dueDate}`}>
                  {showDate && <h3>{formatDateLabel(entry.dueDate)} <span>{weekdayLabel(entry.dueDate)}</span></h3>}
                  <article className={`is-structure${completed ? ' is-complete' : ''}${overdue ? ' is-overdue' : ''}`}>
                    <button type="button" className={`plan-task-check${completed ? ' is-complete' : ''}`} disabled={completionBusy} onClick={() => completeProject(project.projectId, !completed, project.title)} aria-label={completed ? `将${project.title}标记为未完成` : `完成${project.title}`}>{completed ? <Check /> : <Circle />}</button>
                    <button type="button" onClick={() => onSelectNoteByTitle(project.projectId, project.title)}>{model.isOverview && <small className="plan-agenda-root">{project.rootTitle}</small>}{(model.isOverview ? project.path.slice(1, -1) : project.path.slice(0, -1)).length > 0 && <small className="plan-agenda-path" title={project.path.join(' > ')}>{(model.isOverview ? project.path.slice(1, -1) : project.path.slice(0, -1)).join(' > ')}</small>}<strong>{project.title}</strong><small>{project.startDate.slice(5)} — {project.dueDate.slice(5)} · {completed ? '已完成' : entry.dueDate > today ? '即将开始' : overdue ? '待补完' : '进行中'}</small></button>
                    {overdue ? <span>已逾期</span> : <FolderTree />}
                  </article>
                </React.Fragment>;
              }
              const task = entry.item;
              return <React.Fragment key={`${task.noteId}-${task.id}-${task.occurrenceDate}`}>
                {showDate && <h3>{formatDateLabel(entry.dueDate)} <span>{weekdayLabel(entry.dueDate)}</span></h3>}
                <article className={`${completed ? 'is-complete' : ''}${overdue ? ' is-overdue' : ''}`}>
                  <TaskCheck task={task} disabled={taskCompletionDisabled(task)} onToggle={() => completeTask(task)} />
                  <button type="button" onClick={() => onSelectNoteByTitle(task.noteId, task.noteTitle)}>{model.isOverview && <small className="plan-agenda-root">{task.rootTitle}</small>}{(!model.isOverview || task.projectTitle !== task.rootTitle) && <small className="plan-agenda-path">{task.projectTitle}</small>}<strong>{task.taskText}</strong><small>{task.estimatedMinutes} 分钟 · {TASK_KIND_LABEL[task.kind]}{recurring && !completed && entry.dueDate < today ? ' · 未记录' : ''}</small></button>
                  {overdue ? <span>已逾期</span> : <MoreHorizontal />}
                </article>
              </React.Fragment>;
            }) : <div className="plan-agenda-empty"><Clock3 /><strong>本周还没有安排</strong><span>可以添加任务，或切换到其他周查看。</span></div>}
          </div>
          <footer><Target /><div><strong>本周目标</strong><span>{model.isOverview ? `协调 ${model.currentPhases.length || model.scopeRoots.length} 个并行计划的当前任务` : model.currentPhase?.outcome || '完成本周安排并记录学习结果'}</span></div></footer>
        </aside>
      </div>

      {milestoneDetails.length > 0 && <dialog ref={milestoneDialogRef} className="plan-task-drawer plan-milestone-dialog" aria-label="里程碑详情" onCancel={() => setMilestoneDetails([])} onClose={() => setMilestoneDetails([])} onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) setMilestoneDetails([]);
      }}>
          <header><div><span>MILESTONE</span><h2>里程碑详情</h2></div><button type="button" autoFocus aria-label="关闭里程碑详情" onClick={() => setMilestoneDetails([])}><X /></button></header>
          {completionFeedback}
          {resolvedMilestoneDetails.map((milestone) => {
            const gate = getPlanMilestoneGate(notes, milestone.rootId, milestone, today);
            const statusLabel = milestone.completed ? '已完成' : gate.overdue ? '已逾期' : gate.ready ? '待验收' : '未就绪';
            return <article className={`plan-milestone-detail is-${gate.visualState}`} key={`${milestone.rootId}-${milestone.id}`}>
              <small>{model.isOverview ? `${milestone.rootTitle} · ` : ''}{milestone.dueDate} · {statusLabel}</small><h3>{milestone.title}</h3>
              {milestone.criteria?.length ? <ul>{milestone.criteria.map((criterion, index) => <li key={index}>{criterion}</li>)}</ul> : <p>尚未设置验收标准。</p>}
              {!milestone.completed && gate.incompleteLeaves.length > 0 && <section className="plan-milestone-blockers">
                <strong>尚待完成</strong>
                <ul>{gate.incompleteLeaves.map((item) => <li key={item.projectId}><span title={item.path.join(' > ')}>{item.path.join(' > ')}</span><time>{item.dueDate}</time></li>)}</ul>
              </section>}
              {!milestone.implicit && <div className="plan-milestone-actions">
                <button type="button" className={milestone.completed ? 'is-secondary' : 'is-primary'} disabled={completionBusy || (!milestone.completed && !gate.ready)}
                  onClick={() => saveCompletion(milestone.title, () => onToggleMilestoneCompleted(milestone.rootId, milestone.id, !milestone.completed))}>
                  {completionBusy ? '正在保存…' : milestone.completed ? '标记为未完成' : gate.ready ? '确认完成' : '尚未就绪'}
                </button>
              </div>}
            </article>;
          })}
      </dialog>}

      {addOpen && <div className="plan-drawer-backdrop" onMouseDown={closeAddDrawer}>
        <form ref={addDialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="plan-add-title" aria-busy={addSaving} className="plan-task-drawer plan-add-drawer" onSubmit={addMode === 'execution' ? submitTask : submitStructureItem} onMouseDown={(event) => event.stopPropagation()}>
          <header><div><span>ADD TO PLAN</span><h2 id="plan-add-title">添加计划任务</h2><p>选择要加入当前计划的内容类型。</p></div><button type="button" aria-label="关闭" disabled={addSaving} onClick={closeAddDrawer}><X /></button></header>
          <fieldset className="plan-add-fields" disabled={addSaving}>
          <div className="plan-add-mode-grid" role="radiogroup" aria-label="任务类型">
            <button type="button" role="radio" aria-checked={addMode === 'existing'} className={addMode === 'existing' ? 'is-active' : ''} onClick={() => setAddMode('existing')}><FolderTree /><span><strong>已有项目排期</strong><small>保留原笔记与层级</small></span></button>
            <button type="button" role="radio" aria-checked={addMode === 'new'} className={addMode === 'new' ? 'is-active' : ''} onClick={() => setAddMode('new')}><Plus /><span><strong>新建结构项目</strong><small>创建项目笔记</small></span></button>
            <button type="button" role="radio" aria-checked={addMode === 'execution'} className={addMode === 'execution' ? 'is-active' : ''} onClick={() => setAddMode('execution')}><Repeat2 /><span><strong>执行事项</strong><small>不创建项目笔记</small></span></button>
          </div>

          {model.isOverview && addMode && <label><span>所属根项目</span><select value={taskScopeRootId} onChange={(event) => {
            setTaskScopeRootId(event.target.value);
            setTaskProjectId('');
            setStructureProjectId('');
            setStructureParentId('');
          }}>{model.scopeRoots.map((scopeRoot) => <option key={scopeRoot.id} value={scopeRoot.id}>{scopeRoot.planMeta?.shortTitle || scopeRoot.title}</option>)}</select></label>}

          {!addMode && <section className="plan-add-mode-hint"><Plus /><strong>选择一种添加方式</strong><span>结构项目会进入上方时间轨道；执行事项进入周期任务轨道。</span></section>}

          {addMode === 'existing' && <>
            {existingStructureOptions.length ? <>
              <label><span>选择已有项目</span><select autoFocus value={structureProjectId} onChange={(event) => setStructureProjectId(event.target.value)}>{existingStructureOptions.map((project) => <option key={project.key} value={project.key}>{project.path}</option>)}</select></label>
              <p className="plan-add-context">父级：{structureConstraintParent?.path || '当前根项目'}。加入轨道只补充时限，不复制或移动原笔记。</p>
              <div className="plan-form-grid"><label><span>开始日期</span><input type="date" value={structureStartDate} onChange={(event) => setStructureStartDate(event.target.value)} /></label><label><span>结束日期</span><input type="date" value={structureDueDate} onChange={(event) => setStructureDueDate(event.target.value)} /></label></div>
              <label><span>优先级</span><select value={structurePriority} onChange={(event) => setStructurePriority(event.target.value as 'high' | 'medium' | 'low')}><option value="high">高</option><option value="medium">中</option><option value="low">低</option></select></label>
              {structureDateError && <p className="plan-add-error"><AlertTriangle />{structureDateError}</p>}
            </> : <section className="plan-add-empty"><Check /><strong>暂无可直接排期的项目</strong><span>未排期子项目的父级需要先进入结构轨道；也可以切换到“新建结构项目”。</span></section>}
          </>}

          {addMode === 'new' && <>
            <label><span>父项目</span><select value={structureParentId} onChange={(event) => setStructureParentId(event.target.value)}>{structureParentOptions.map((project) => <option key={project.id} value={project.id}>{project.path}</option>)}</select></label>
            <label><span>项目名称</span><input autoFocus value={structureTitle} onChange={(event) => setStructureTitle(event.target.value)} placeholder="例如：掌握贝叶斯参数估计" /></label>
            <div className="plan-form-grid"><label><span>开始日期</span><input type="date" value={structureStartDate} onChange={(event) => setStructureStartDate(event.target.value)} /></label><label><span>结束日期</span><input type="date" value={structureDueDate} onChange={(event) => setStructureDueDate(event.target.value)} /></label></div>
            <label><span>优先级</span><select value={structurePriority} onChange={(event) => setStructurePriority(event.target.value as 'high' | 'medium' | 'low')}><option value="high">高</option><option value="medium">中</option><option value="low">低</option></select></label>
            <p className="plan-add-context">提交后将在所选父级下创建项目笔记，并加入结构轨道。</p>
            {structureDateError && <p className="plan-add-error"><AlertTriangle />{structureDateError}</p>}
          </>}

          {addMode === 'execution' && <>
            <label><span>任务名称</span><input autoFocus value={taskText} onChange={(event) => setTaskText(event.target.value)} placeholder="例如：完成导数综合练习" /></label>
            <div className="plan-form-grid"><label><span>任务类型</span><select value={taskKind} onChange={(event) => setTaskKind(event.target.value as PlanTaskKind)}>{Object.entries(TASK_KIND_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label><span>{taskRecurrence === 'none' ? '截止日期' : '首次日期'}</span><input type="date" value={taskDate} onChange={(event) => setTaskDate(event.target.value)} /></label></div>
            <div className="plan-form-grid"><label><span>执行入口</span><select value={taskExecutionKind} onChange={(event) => setTaskExecutionKind(event.target.value as PlanExecutionKind)}><option value="todo">普通待办</option><option value="flow">心流学习</option><option value="practice">场景练习</option><option value="review">复习模式</option></select></label><label><span>重复规则</span><select value={taskRecurrence} onChange={(event) => setTaskRecurrence(event.target.value as PlanRecurrenceFrequency)}><option value="none">不重复</option><option value="daily">每天</option><option value="weekdays">工作日</option><option value="weekly">每周</option><option value="custom">自定义</option></select></label></div>
            {(taskRecurrence === 'weekly' || taskRecurrence === 'custom') && <div className="plan-recurrence-weekdays" role="group" aria-label="重复星期">
              <span>重复星期</span><div>{WEEKDAYS.map((day) => {
                const selected = taskRecurrenceWeekdays.includes(day.value);
                return <button type="button" key={day.value} aria-label={`每周${day.label}`} aria-pressed={selected} onClick={() => {
                  setTaskRecurrenceWeekdays((current) => selected
                    ? current.length === 1 ? current : current.filter((value) => value !== day.value)
                    : [...current, day.value]);
                }}>{day.label}</button>;
              })}</div><small>至少保留一个重复日</small>
            </div>}
            <label><span>所属项目</span><select value={taskProjectId} onChange={(event) => setTaskProjectId(event.target.value)} disabled={!taskProjectOptions.length}>{taskProjectOptions.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}</select></label>
            <label><span>预计时长</span><div className="plan-duration-options" role="group" aria-label="预计时长">{[5, 10, 15, 30, 60, 90, 120].map((minutes) => <button type="button" key={minutes} aria-label={`${minutes} 分钟`} aria-pressed={taskMinutes === minutes} className={taskMinutes === minutes ? 'is-active' : ''} onClick={() => setTaskMinutes(minutes)}>{minutes} 分钟</button>)}</div></label>
          </>}

          </fieldset>
          {addError && <p className="plan-add-error" role="alert"><AlertTriangle />{addError}</p>}
          <footer><button type="button" disabled={addSaving} onClick={() => addMode ? setAddMode(null) : closeAddDrawer()}>{addMode ? '返回' : '取消'}</button>{addMode && <button type="submit" className="is-primary" disabled={addSaving || (addMode === 'execution'
            ? !taskText.trim() || !taskDate || !taskProjectId || !taskScopeRootId
            : addMode === 'existing'
              ? !structureProjectId || Boolean(structureDateError)
              : !structureTitle.trim() || !structureParentId || Boolean(structureDateError))}>{addSaving ? <Loader2 className="plan-saving-spinner" /> : <Plus />}{addSaving ? '正在保存…' : '加入计划'}</button>}</footer>
        </form>
      </div>}

      {adjustOpen && <div className="plan-drawer-backdrop" onMouseDown={() => setAdjustOpen(false)}>
        <section ref={adjustDialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="plan-adjust-title" className="plan-task-drawer plan-adjust-drawer" onMouseDown={(event) => event.stopPropagation()}>
          <header><div><span>PLAN IMPACT</span><h2 id="plan-adjust-title">{model.isOverview ? '综合统筹计划' : '调整计划'}</h2></div><button type="button" aria-label="关闭" onClick={() => setAdjustOpen(false)}><X /></button></header>
          <div className={`plan-load-summary${weeklyLoad > 100 ? ' is-warning' : ''}`}>{weeklyLoad > 100 ? <AlertTriangle /> : <BarChart3 />}<div><strong>{capacity.percent === null ? '请先确认个人共享周预算' : weeklyLoad > 100 ? '全部计划已超过个人周预算' : '个人周负荷可控'}</strong><span>当前范围 {selectedWeekMinutes} 分钟 · 全部计划 {capacity.scheduledMinutes} / {capacity.budgetMinutes ?? '待确认'} 分钟{capacity.percent === null ? '' : ` · ${capacity.percent}%`}</span></div></div>
          <div className="plan-adjust-constraints">
            <strong>{model.isOverview ? '本次统筹的根项目' : '调整时必须保留的条件'}</strong>
            {model.isOverview ? <div>{model.scopeRoots.map((scopeRoot) => <span key={scopeRoot.id}>{scopeRoot.planMeta?.shortTitle || scopeRoot.title} · 每日 {scopeRoot.planMeta?.dailyStudyMinutes ?? '待确认'} 分钟</span>)}</div> : <>
              <div>
                <span>{activeWeekdays.length} 个学习日</span>
                <span>个人共享周预算 {capacity.budgetMinutes ?? '待确认'} 分钟</span>
                {planConditions?.preferredSessionMinutes && <span>单次约 {planConditions.preferredSessionMinutes} 分钟</span>}
                {planConditions?.deadlineMode && <span>{planConditions.deadlineMode === 'hard' ? '硬截止' : '弹性截止'}</span>}
                {planConditions?.reviewCadence && <span>{planConditions.reviewCadence === 'intensive' ? '密集复习' : planConditions.reviewCadence === 'light' ? '轻量复习' : '标准复习'}</span>}
              </div>
              {planConditions?.constraintNotes && <p>{planConditions.constraintNotes}</p>}
            </>}
          </div>
          <div className="plan-adjust-options">{model.isOverview ? <>
            <article><strong>检查跨计划冲突</strong><span>同时检查里程碑、截止日与并行任务的拥挤时段。</span></article>
            <article><strong>按优先级重排</strong><span>在保留每个根项目结构的前提下，统一调整后续日期。</span></article>
            <article><strong>平衡本周安排</strong><span>将执行事项在多个计划间协调，避免同日过度集中。</span></article>
          </> : <><article><strong>保持目标日期</strong><span>压缩或移动可调整任务，不改变最终里程碑。</span></article><article><strong>顺延后续任务</strong><span>只移动受依赖影响的任务，并保留原始日期记录。</span></article><article><strong>重新分配周负荷</strong><span>在可用学习日之间平衡练习和复习。</span></article></>}
          </div>
          <p>{model.isOverview ? 'Agent 将同时读取这些根项目，生成按项目分组的统筹草稿，确认后再统一写入。' : '完整的影响模拟将在计划草稿阶段执行；当前可以交给 Agent 基于真实任务提出结构化调整建议。'}</p>
          <footer><button type="button" onClick={() => setAdjustOpen(false)}>稍后处理</button>{!model.isOverview && model.root && <button type="button" className="is-secondary" onClick={() => {
            setAdjustOpen(false);
            onOpenPlanEditor?.(model.root!.id);
          }}><SlidersHorizontal />手动编辑</button>}<button type="button" className="is-primary" onClick={() => {
            setAdjustOpen(false);
            if (model.isOverview) onRequestPlanAdjustment?.({ kind: 'portfolio', rootIds: model.scopeRootIds });
            else if (model.root) onRequestPlanAdjustment?.({ kind: 'root', id: model.root.id, title: model.root.title, meta: model.root.planMeta });
          }}><SlidersHorizontal />交给 Agent 调整</button></footer>
        </section>
      </div>}
    </section>
  );
};
