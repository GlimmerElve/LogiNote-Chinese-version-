import type { NoteItem } from '../types';
import { isLearningProject } from './projectRole';
import { homeCalendarDay, homeLocalDate } from './homepage/homeTaskScheduling';
import { getScheduledProjectDeadline, getScheduledProjectState } from './planProjectState';

export interface FlowProjectEntry {
  note: NoteItem;
  nearestDueDate: string | null;
  isToday: boolean;
  isTomorrow: boolean;
  isOverdue: boolean;
  isFuture: boolean;
  parentChain: { id: string; title: string }[];
  totalTasks: number;
  completedTasks: number;
  isFullyCompleted: boolean;
  inactiveStatus?: 'draft' | 'paused' | 'archived' | 'completed';
}

/** Learning leaves ignore organizational reference children and their prose. */
export function buildLearningProjectQueue(notes: NoteItem[], today = homeLocalDate()): FlowProjectEntry[] {
  const todayDay = homeCalendarDay(today);
  if (todayDay === null) return [];
  const counts = new Map<string, number>();
  for (const note of notes) counts.set(note.id, (counts.get(note.id) || 0) + 1);
  const uniqueNotes = notes.filter(note => counts.get(note.id) === 1);
  const byId = new Map(uniqueNotes.map(note => [note.id, note]));
  const projects = uniqueNotes.filter(isLearningProject);
  const parents = new Set(projects.flatMap(note => note.parentId ? [note.parentId] : []));
  const entries: FlowProjectEntry[] = [];
  for (const note of projects) {
    if (parents.has(note.id)) continue;
    const parentChain: FlowProjectEntry['parentChain'] = [];
    const visited = new Set([note.id]);
    let current: NoteItem = note;
    let cyclic = false;
    let root: NoteItem = note;
    while (current.parentId) {
      if (visited.has(current.parentId)) { cyclic = true; break; }
      visited.add(current.parentId);
      const parent = byId.get(current.parentId);
      if (!parent) break;
      parentChain.unshift({ id: parent.id, title: parent.title });
      if (parent.noteType === 'project') root = parent;
      current = parent;
    }
    if (cyclic) continue;
    const deadline = getScheduledProjectDeadline(note);
    const completed = Boolean(deadline && getScheduledProjectState(uniqueNotes, note.id).completed);
    const date = deadline && !completed ? deadline.dueDate : null;
    const dateDay = homeCalendarDay(date || undefined);
    const status = root.planMeta?.status;
    entries.push({ note, parentChain, nearestDueDate: date,
      isToday: date === today, isTomorrow: dateDay === todayDay + 1,
      isOverdue: dateDay !== null && dateDay < todayDay,
      isFuture: Boolean(deadline && (deadline.startDate || deadline.dueDate) > today),
      totalTasks: deadline ? 1 : 0, completedTasks: completed ? 1 : 0,
      isFullyCompleted: completed,
      inactiveStatus: status && status !== 'active' ? status : undefined,
    });
  }
  const group = (entry: FlowProjectEntry) => entry.inactiveStatus ? 4 : entry.isFullyCompleted ? 3
    : entry.nearestDueDate ? entry.isFuture ? 1 : 0 : 2;
  const created = (note: NoteItem) => Number.isFinite(Date.parse(note.createdAt)) ? Date.parse(note.createdAt) : 0;
  return entries.sort((a, b) => group(a) - group(b)
    || (a.nearestDueDate && b.nearestDueDate ? a.nearestDueDate.localeCompare(b.nearestDueDate) : 0)
    || created(b.note) - created(a.note) || a.note.id.localeCompare(b.note.id));
}
