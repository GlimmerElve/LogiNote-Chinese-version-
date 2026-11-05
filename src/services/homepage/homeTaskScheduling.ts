import type { DueDateItem, NoteItem } from '../../types';
import { isLearningProject, isReferenceProject } from '../projectRole';
import { getLearningCompletionTarget, getProjectCompletionTarget, type LearningTaskBinding } from '../learningCompletion';
import { getScheduledProjectDeadline } from '../planProjectState';

export interface HomeTaskLaunch {
  /** Learning object, not the object whose task will be acknowledged. */
  noteId: string;
  mode: 'flow' | 'scene' | 'review' | 'none';
  actionDate: string;
  /** Exact completion owner. Never replace this with linkedProjectId. */
  binding: LearningTaskBinding;
}

export interface HomeScheduledTask {
  rootId: string;
  ownerNoteId: string;
  ownerTitle: string;
  taskId: string;
  text: string;
  priority: DueDateItem['priority'];
  structural: boolean;
  recurring: boolean;
  startDate: string;
  deadlineDate: string;
  /** True completion state for a leaf/one-off or today's valid occurrence. */
  completed: boolean;
  /** Future and expired recurring rules are not permanent unfinished tasks. */
  progressEligible: boolean;
  /** Real deadline for one-off work; next valid occurrence for recurring work. */
  pendingDate: string | null;
  /** When it can be acted on; an unfinished project rolls forward to today. */
  actionDate: string | null;
  launch: HomeTaskLaunch | null;
}

const DAY_MS = 86_400_000;
const MAX_DAY = Math.floor(Date.parse('9999-12-31T00:00:00.000Z') / DAY_MS);

export function homeCalendarDay(value: string | undefined): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value
    ? Math.floor(time / DAY_MS) : null;
}

export function homeLocalDate(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function dateFromDay(day: number): string | null {
  if (!Number.isInteger(day) || day > MAX_DAY) return null;
  const value = new Date(day * DAY_MS);
  if (!Number.isFinite(value.getTime())) return null;
  const date = value.toISOString().slice(0, 10);
  return homeCalendarDay(date) === day ? date : null;
}

/** Same base-day/interval-week calendar as learningCompletion; no missed-day replay. */
export function nextHomeTaskOccurrence(task: DueDateItem, onOrAfter: string): string | null {
  const day = homeCalendarDay(onOrAfter);
  const base = homeCalendarDay(task.startDate || task.dueDate);
  const rule = task.recurrence;
  if (day === null || base === null || !rule || !['daily', 'weekdays', 'weekly', 'custom'].includes(rule.frequency)) return null;
  const interval = rule.interval ?? 1;
  if (!Number.isInteger(interval) || interval < 1
    || (rule.weekdays !== undefined && (!Array.isArray(rule.weekdays)
      || rule.weekdays.some(value => !Number.isInteger(value) || value < 0 || value > 6)))) return null;
  const end = rule.endDate === undefined ? MAX_DAY : homeCalendarDay(rule.endDate);
  if (end === null || end < base) return null;
  const earliest = Math.max(day, base);
  if (earliest > end) return null;
  let occurrence: number;
  if (rule.frequency === 'daily') {
    occurrence = base + Math.ceil((earliest - base) / interval) * interval;
  } else {
    const baseWeekday = new Date(base * DAY_MS).getUTCDay();
    const weekdays = rule.frequency === 'weekdays' ? [1, 2, 3, 4, 5]
      : rule.weekdays?.length ? rule.weekdays : [baseWeekday];
    const offsets = [...new Set(weekdays.map(weekday => (weekday - baseWeekday + 7) % 7))].sort((a, b) => a - b);
    const relativeWeek = Math.floor((earliest - base) / 7);
    let activeWeek = Math.ceil(relativeWeek / interval) * interval;
    let weekStart = base + activeWeek * 7;
    const offset = offsets.find(value => weekStart + value >= earliest);
    if (offset === undefined) {
      activeWeek += interval;
      weekStart = base + activeWeek * 7;
      occurrence = weekStart + offsets[0];
    } else occurrence = weekStart + offset;
  }
  return occurrence <= end ? dateFromDay(occurrence) : null;
}

function nextPendingOccurrence(task: DueDateItem, today: string): string | null {
  const completed = new Set(task.completedOccurrenceDates || []);
  let next = nextHomeTaskOccurrence(task, today);
  // At most one step per completed date. This never scans a huge calendar range.
  while (next && completed.has(next)) {
    const after = dateFromDay(homeCalendarDay(next)! + 1);
    next = after ? nextHomeTaskOccurrence(task, after) : null;
  }
  return next;
}

function rootProjectId(note: NoteItem, byId: Map<string, NoteItem>): string | null {
  const visited = new Set<string>();
  let current: NoteItem | undefined = note;
  let root: NoteItem | undefined;
  while (current) {
    if (visited.has(current.id)) return null;
    visited.add(current.id);
    if (current.noteType === 'project') root = current;
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return root?.id || null;
}

function executionMode(task: DueDateItem): HomeTaskLaunch['mode'] {
  if (task.launchMode !== undefined) return ['flow', 'scene', 'review', 'none'].includes(task.launchMode) ? task.launchMode : 'none';
  return task.executionKind === 'flow' ? 'flow' : task.executionKind === 'practice' ? 'scene'
    : task.executionKind === 'review' ? 'review' : 'none';
}

/** Shared source for home progress, next step and todos; every row has one identity. */
export function buildHomeScheduledTasks(notes: NoteItem[], today = homeLocalDate()): HomeScheduledTask[] {
  if (homeCalendarDay(today) === null) return [];
  const counts = new Map<string, number>();
  for (const note of notes) counts.set(note.id, (counts.get(note.id) || 0) + 1);
  const uniqueNotes = notes.filter(note => counts.get(note.id) === 1);
  const byId = new Map(uniqueNotes.map(note => [note.id, note]));
  const rows: HomeScheduledTask[] = [];
  for (const note of uniqueNotes) {
    if (isReferenceProject(note)) continue;
    const rootId = rootProjectId(note, byId);
    if (!rootId) continue;
    const rootActionable = isHomeRootActionable(byId.get(rootId));
    const deadline = getScheduledProjectDeadline(note);
    const structuralTarget = note.id !== rootId ? getProjectCompletionTarget(uniqueNotes, note.id) : null;
    if (deadline && structuralTarget) {
      const completed = structuralTarget.completed;
      const startDate = deadline.startDate || deadline.dueDate;
      const actionDate = startDate > today ? startDate : today;
      rows.push({
        rootId, ownerNoteId: note.id, ownerTitle: note.title, taskId: deadline.id,
        text: note.title, priority: deadline.priority, structural: true, recurring: false,
        startDate, deadlineDate: deadline.dueDate, completed, progressEligible: true,
        pendingDate: completed ? null : deadline.dueDate,
        actionDate: completed ? null : actionDate,
        launch: completed || !rootActionable ? null : { noteId: note.id, mode: 'flow', actionDate, binding: { noteId: note.id } },
      });
    }
    for (const task of note.dueDates || []) {
      // Even malformed/duplicate title-matching deadline lines are never execution work.
      if (note.noteType === 'project' && task.taskText.trim() === note.title.trim()) continue;
      const recurring = Boolean(task.recurrence && task.recurrence.frequency !== 'none');
      const occurrenceDate = recurring ? nextPendingOccurrence(task, today) : null;
      const currentOccurrence = recurring && nextHomeTaskOccurrence(task, today) === today;
      const binding: LearningTaskBinding = recurring
        ? { noteId: note.id, taskId: task.id, occurrenceDate: occurrenceDate || (currentOccurrence ? today : undefined) }
        : { noteId: note.id, taskId: task.id };
      // Completed today's final occurrence still contributes to progress, but has no next launch.
      if (recurring && !occurrenceDate && !currentOccurrence) continue;
      const target = getLearningCompletionTarget(uniqueNotes, binding);
      if (!target || target.kind !== 'execution') continue;
      const linked = task.linkedProjectId ? byId.get(task.linkedProjectId) : undefined;
      if (isReferenceProject(linked)) continue;
      const learningNoteId = linked?.noteType === 'project' && rootProjectId(linked, byId) === rootId ? linked.id : note.id;
      const completed = recurring ? Boolean(currentOccurrence && task.completedOccurrenceDates?.includes(today)) : target.completed;
      const pendingDate = recurring ? occurrenceDate : completed ? null : task.dueDate;
      const startDate = task.startDate || task.dueDate;
      const actionDate = pendingDate ? recurring ? pendingDate : startDate > today ? startDate : today : null;
      rows.push({
        rootId, ownerNoteId: note.id, ownerTitle: note.title, taskId: task.id,
        text: task.taskText || note.title, priority: task.priority, structural: false, recurring,
        startDate, deadlineDate: task.dueDate, completed, progressEligible: !recurring || currentOccurrence,
        pendingDate,
        actionDate,
        launch: pendingDate && actionDate && rootActionable ? { noteId: learningNoteId, mode: executionMode(task), actionDate, binding: target.binding } : null,
      });
    }
  }
  return rows;
}

export function isHomeRootActionable(root: NoteItem | undefined): boolean {
  return isLearningProject(root) && (root.planMeta?.status === undefined || root.planMeta.status === 'active');
}

export function compareHomePendingTasks(a: HomeScheduledTask, b: HomeScheduledTask): number {
  return (a.actionDate || '').localeCompare(b.actionDate || '')
    || (a.pendingDate || '').localeCompare(b.pendingDate || '')
    || a.ownerNoteId.localeCompare(b.ownerNoteId)
    || a.taskId.localeCompare(b.taskId);
}
