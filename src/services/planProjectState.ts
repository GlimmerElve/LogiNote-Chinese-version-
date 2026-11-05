import type { DueDateItem, NoteItem } from '../types';
import { isLearningProject } from './projectRole';
import { extractPlanTaskId, stripPlanTaskAnchor } from './planTaskAnchor';

export interface ScheduledProjectState {
  completed: boolean;
  progress: number;
  hasScheduledWork: boolean;
}

function isCalendarDate(value: string | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

/** A project is scheduled only by its own valid deadline, never an inherited date. */
export function getScheduledProjectDeadline(note: NoteItem): DueDateItem | undefined {
  if (!isLearningProject(note)) return undefined;
  return note.dueDates.find((item) => item.taskText.trim() === note.title.trim()
    && isCalendarDate(item.dueDate)
    && (item.startDate === undefined || (isCalendarDate(item.startDate) && item.startDate <= item.dueDate)));
}

function projectIndex(notes: NoteItem[]) {
  const byId = new Map<string, NoteItem>();
  const children = new Map<string, NoteItem[]>();
  notes.forEach((note) => {
    if (!isLearningProject(note)) return;
    byId.set(note.id, note);
    if (note.parentId) children.set(note.parentId, [...(children.get(note.parentId) || []), note]);
  });
  return { byId, children };
}

type ProjectIndex = ReturnType<typeof projectIndex>;

function scheduledChildren(index: ProjectIndex, parentId: string): NoteItem[] {
  const result: NoteItem[] = [];
  const visited = new Set([parentId]);
  const visit = (id: string) => {
    for (const child of index.children.get(id) || []) {
      if (visited.has(child.id)) continue;
      visited.add(child.id);
      if (getScheduledProjectDeadline(child)) result.push(child);
      else visit(child.id);
    }
  };
  visit(parentId);
  return result;
}

/** Skip ordinary project containers, retaining their nearest scheduled descendants. */
export function getScheduledProjectChildren(notes: NoteItem[], parentId: string): NoteItem[] {
  return scheduledChildren(projectIndex(notes), parentId);
}

function scheduledState(index: ProjectIndex, projectId: string, ancestors = new Set<string>()): ScheduledProjectState {
  const project = index.byId.get(projectId);
  if (!project || ancestors.has(projectId)) return { completed: false, progress: 0, hasScheduledWork: false };
  const path = new Set(ancestors).add(projectId);
  const children = scheduledChildren(index, projectId)
    .map((child) => scheduledState(index, child.id, path))
    .filter((child) => child.hasScheduledWork);
  if (children.length) {
    return {
      completed: children.every((child) => child.completed),
      progress: Math.round(children.reduce((sum, child) => sum + child.progress, 0) / children.length),
      hasScheduledWork: true,
    };
  }
  const deadline = getScheduledProjectDeadline(project);
  return { completed: Boolean(deadline?.completed), progress: deadline?.completed ? 100 : 0, hasScheduledWork: Boolean(deadline) };
}

export function getScheduledProjectState(notes: NoteItem[], projectId: string): ScheduledProjectState {
  return scheduledState(projectIndex(notes), projectId);
}

/** Only synchronize a matching deadline line; never guess from a shared date or partial title. */
function syncDeadlineContent(note: NoteItem, deadline: DueDateItem, completed: boolean): string {
  return note.content.split('\n').map((line, lineIndex) => {
    const match = line.match(/(.*?)(?:@due\(([\d\-]+)\))/i);
    if (!match || match[2] !== deadline.dueDate) return line;
    const text = stripPlanTaskAnchor(match[1]).replace(/^[-*]\s*(\[[ xX]\])?\s*/, '').trim();
    const id = extractPlanTaskId(line) || `due-${note.id}-${lineIndex}`;
    if (id !== deadline.id || (text || note.title).trim() !== note.title.trim()) return line;
    const checkbox = /^([-*]\s*)\[[ xX]\]/;
    if (checkbox.test(line)) return line.replace(checkbox, `$1[${completed ? 'x' : ' '}]`);
    return completed ? `- [x] ${line.replace(/^[-*]\s*/, '')}` : line;
  }).join('\n');
}

function setDeadlineCompletion(note: NoteItem, completed: boolean, now: string): NoteItem {
  const deadline = getScheduledProjectDeadline(note);
  if (!deadline) return note;
  const completedAt = completed ? (deadline.completed ? deadline.completedAt || now : now) : undefined;
  const content = syncDeadlineContent(note, deadline, completed);
  if (deadline.completed === completed && deadline.completedAt === completedAt && content === note.content) return note;
  return {
    ...note,
    dueDates: note.dueDates.map((item) => item === deadline ? { ...item, completed, completedAt } : item),
    content,
    updatedAt: now,
  };
}

/** Toggle real scheduled work and recalculate ancestors without inventing deadline records. */
export function toggleScheduledProjectCompletion(notes: NoteItem[], projectId: string, now = new Date().toISOString()): NoteItem[] {
  const index = projectIndex(notes);
  const state = scheduledState(index, projectId);
  if (!state.hasScheduledWork) return notes;
  const affected = new Set<string>();
  const visit = (id: string) => {
    if (affected.has(id)) return;
    affected.add(id);
    (index.children.get(id) || []).forEach((child) => visit(child.id));
  };
  visit(projectId);
  let updated = notes.map((note) => affected.has(note.id) ? setDeadlineCompletion(note, !state.completed, now) : note);
  const ancestors = new Set<string>();
  let parentId = index.byId.get(projectId)?.parentId;
  while (parentId && !ancestors.has(parentId) && !affected.has(parentId)) {
    ancestors.add(parentId);
    const parentState = getScheduledProjectState(updated, parentId);
    if (parentState.hasScheduledWork) {
      updated = updated.map((note) => note.id === parentId ? setDeadlineCompletion(note, parentState.completed, now) : note);
    }
    parentId = index.byId.get(parentId)?.parentId;
  }
  const updatedIndex = projectIndex(updated);
  return updated.map((note) => {
    if ((!affected.has(note.id) && !ancestors.has(note.id)) || !note.planMeta
      || !['active', 'completed'].includes(note.planMeta.status)) return note;
    const nextState = scheduledState(updatedIndex, note.id);
    if (!nextState.hasScheduledWork) return note;
    const status = nextState.completed ? 'completed' : 'active';
    return note.planMeta.status === status ? note : { ...note, planMeta: { ...note.planMeta, status, updatedAt: now }, updatedAt: now };
  });
}
