import type { DueDateItem, NoteItem } from '../types';
import { isReferenceProject } from './projectRole';
import {
  getScheduledProjectChildren,
  getScheduledProjectDeadline,
  getScheduledProjectState,
  toggleScheduledProjectCompletion,
} from './planProjectState';
import { extractPlanTaskId, stripPlanTaskAnchor } from './planTaskAnchor';

/** Explicit identity of the work being studied; never inferred from a session title. */
export interface LearningTaskBinding {
  noteId: string;
  taskId?: string;
  occurrenceDate?: string;
}

export interface LearningCompletionTarget {
  kind: 'project' | 'execution';
  binding: LearningTaskBinding;
  title: string;
  path: string[];
  completed: boolean;
}

const DAY_MS = 86_400_000;

function calendarDay(value: string | undefined): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) return null;
  return Math.floor(timestamp / DAY_MS);
}

function localDate(now = new Date().toISOString()): string {
  // A legacy date-only value already denotes a local calendar day.
  if (calendarDay(now) !== null) return now;
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) throw new Error('完成时间无效，请重试。');
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function notePath(notes: NoteItem[], note: NoteItem): string[] {
  const byId = new Map(notes.map((item) => [item.id, item]));
  const path: string[] = [];
  const visited = new Set<string>();
  let current: NoteItem | undefined = note;
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    path.unshift(current.title);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path;
}

export function getProjectCompletionTarget(notes: NoteItem[], noteId: string): LearningCompletionTarget | null {
  const project = notes.find((note) => note.id === noteId && note.noteType === 'project');
  if (!project || !getScheduledProjectDeadline(project)
    || getScheduledProjectChildren(notes, project.id).length > 0) return null;
  return {
    kind: 'project',
    binding: { noteId: project.id },
    title: project.title,
    path: notePath(notes, project),
    completed: getScheduledProjectState(notes, project.id).completed,
  };
}

function isRecurring(task: DueDateItem): boolean {
  return Boolean(task.recurrence && task.recurrence.frequency !== 'none');
}

/** Mirrors the published agenda's recurrence calendar, without skipping completed dates. */
function isOccurrence(task: DueDateItem, date: string): boolean {
  const day = calendarDay(date);
  const base = calendarDay(task.startDate || task.dueDate);
  const rule = task.recurrence;
  if (day === null || base === null || !rule || !isRecurring(task) || day < base) return false;
  if (!['daily', 'weekdays', 'weekly', 'custom'].includes(rule.frequency)) return false;
  const end = calendarDay(rule.endDate);
  if (rule.endDate !== undefined && (end === null || day > end)) return false;
  const interval = rule.interval ?? 1;
  if (!Number.isInteger(interval) || interval < 1) return false;
  if (rule.weekdays?.some((value) => !Number.isInteger(value) || value < 0 || value > 6)) return false;
  if (rule.frequency === 'daily') return (day - base) % interval === 0;
  const weekday = new Date(day * DAY_MS).getUTCDay();
  const intervalWeek = Math.floor((day - base) / 7) % interval === 0;
  if (rule.frequency === 'weekdays') return weekday >= 1 && weekday <= 5 && intervalWeek;
  const baseWeekday = new Date(base * DAY_MS).getUTCDay();
  return (rule.weekdays?.length ? rule.weekdays : [baseWeekday]).includes(weekday) && intervalWeek;
}

function executionTask(note: NoteItem, taskId: string): DueDateItem | undefined {
  if (isReferenceProject(note)) return undefined;
  const matches = note.dueDates.filter((task) => task.id === taskId);
  const task = matches.length === 1 ? matches[0] : undefined;
  if (!task || calendarDay(task.dueDate) === null) return undefined;
  // A project deadline is structural work, not an execution checkbox even if its ID is supplied.
  if (note.noteType === 'project' && task.taskText.trim() === note.title.trim()) return undefined;
  if (task.startDate !== undefined
    && (calendarDay(task.startDate) === null || task.startDate > task.dueDate)) return undefined;
  return task;
}

export function getLearningCompletionTarget(
  notes: NoteItem[],
  binding?: LearningTaskBinding,
): LearningCompletionTarget | null {
  if (!binding?.noteId) return null;
  if (binding.taskId === undefined) {
    // A date-only occurrence cannot silently become a structural-project completion.
    return binding.occurrenceDate === undefined ? getProjectCompletionTarget(notes, binding.noteId) : null;
  }
  const note = notes.find((item) => item.id === binding.noteId);
  const task = note && executionTask(note, binding.taskId);
  if (!note || !task) return null;
  const recurring = isRecurring(task);
  const occurrenceDate = recurring ? binding.occurrenceDate ?? localDate() : undefined;
  if (recurring && (!occurrenceDate || !isOccurrence(task, occurrenceDate))) return null;
  // A stale recurring binding must not complete a subsequently converted one-off rule.
  if (!recurring && binding.occurrenceDate !== undefined && binding.occurrenceDate !== task.dueDate) return null;
  return {
    kind: 'execution',
    binding: recurring
      ? { noteId: note.id, taskId: task.id, occurrenceDate }
      : { noteId: note.id, taskId: task.id },
    title: task.taskText,
    path: notePath(notes, note),
    completed: recurring ? Boolean(task.completedOccurrenceDates?.includes(occurrenceDate!)) : task.completed,
  };
}

/** Synchronize an exact anchor/legacy line only, never a partial title or shared deadline. */
function setTaskCheckbox(note: NoteItem, task: DueDateItem, completed: boolean): string {
  let matched = false;
  return note.content.split('\n').map((line, index) => {
    if (matched) return line;
    const due = line.match(/(.*?)@due\(([\d-]+)\)/i);
    if (!due || due[2] !== task.dueDate) return line;
    const anchoredId = extractPlanTaskId(line);
    if ((anchoredId || `due-${note.id}-${index}`) !== task.id) return line;
    const text = stripPlanTaskAnchor(due[1]).replace(/^\s*[-*]\s*(?:\[[ xX]\])?\s*/, '').trim();
    if (text !== task.taskText.trim()) return line;
    matched = true;
    const checkbox = /^(\s*[-*]\s*)\[[ xX]\]/;
    if (checkbox.test(line)) return line.replace(checkbox, `$1[${completed ? 'x' : ' '}]`);
    if (!completed) return line;
    const indent = line.match(/^\s*/)?.[0] || '';
    return `${indent}- [x] ${line.trimStart().replace(/^[-*]\s*/, '')}`;
  }).join('\n');
}

/** Explicit and idempotent; undo re-resolves the current tree rather than restoring a stale snapshot. */
export function setLearningCompletion(
  notes: NoteItem[],
  target: LearningCompletionTarget,
  completed: boolean,
  now = new Date().toISOString(),
): NoteItem[] {
  const today = localDate(now);
  const current = getLearningCompletionTarget(notes, target.binding);
  if (!current || current.kind !== target.kind) {
    throw new Error('该任务已被移除、调整或不再是末级项目，请刷新后重试。');
  }
  if (current.kind === 'project') {
    return current.completed === completed
      ? notes
      : toggleScheduledProjectCompletion(notes, current.binding.noteId, now);
  }
  const note = notes.find((item) => item.id === current.binding.noteId)!;
  const task = executionTask(note, current.binding.taskId!)!;
  const recurring = isRecurring(task);
  const occurrenceDate = current.binding.occurrenceDate;
  if (recurring && (!occurrenceDate || occurrenceDate > today)) {
    throw new Error('尚未到本次待办日期，不能提前标记完成。');
  }
  if (current.completed === completed) return notes;
  let updatedTask: DueDateItem;
  if (recurring) {
    const dates = new Set(task.completedOccurrenceDates || []);
    if (completed) dates.add(occurrenceDate!);
    else dates.delete(occurrenceDate!);
    // The rule itself and its body checkbox stay unchanged: only this occurrence is acknowledged.
    updatedTask = { ...task, completedOccurrenceDates: [...dates].sort() };
  } else {
    updatedTask = { ...task, completed, completedAt: completed ? now : undefined };
  }
  const updated: NoteItem = {
    ...note,
    dueDates: note.dueDates.map((item) => item === task ? updatedTask : item),
    content: recurring ? note.content : setTaskCheckbox(note, task, completed),
    updatedAt: now,
  };
  return notes.map((item) => item === note ? updated : item);
}
