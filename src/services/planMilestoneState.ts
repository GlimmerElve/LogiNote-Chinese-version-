import type { NoteItem, PlanMilestone } from '../types';
import { getScheduledProjectChildren, getScheduledProjectDeadline, getScheduledProjectState } from './planProjectState';
import { homeLocalDate } from './homepage/homeTaskScheduling';

export type PlanMilestoneVisualState = 'unready' | 'ready' | 'completed' | 'overdue';

export interface PlanMilestonePrerequisite {
  projectId: string;
  title: string;
  path: string[];
  dueDate: string;
  completed: boolean;
}

export interface PlanMilestoneGate {
  prerequisiteLeaves: PlanMilestonePrerequisite[];
  incompleteLeaves: PlanMilestonePrerequisite[];
  ready: boolean;
  overdue: boolean;
  visualState: PlanMilestoneVisualState;
}

function collectProjectScope(notes: NoteItem[], rootId: string): NoteItem[] {
  const children = new Map<string, NoteItem[]>();
  notes.forEach((note) => {
    if (note.noteType !== 'project' || !note.parentId) return;
    children.set(note.parentId, [...(children.get(note.parentId) || []), note]);
  });
  const result: NoteItem[] = [];
  const visited = new Set<string>([rootId]);
  const visit = (parentId: string) => {
    for (const child of children.get(parentId) || []) {
      if (visited.has(child.id)) continue;
      visited.add(child.id);
      result.push(child);
      visit(child.id);
    }
  };
  visit(rootId);
  return result;
}

function projectPath(project: NoteItem, byId: Map<string, NoteItem>, rootId: string): string[] {
  const path = [project.title];
  const visited = new Set([project.id]);
  let parentId = project.parentId;
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    path.unshift(parent.title);
    if (parent.id === rootId) break;
    parentId = parent.parentId;
  }
  return path;
}

/**
 * A milestone is manually accepted, but only after every scheduled leaf project
 * ending on or before the checkpoint has been completed. Ordinary project notes
 * without their own schedule never become prerequisites.
 */
export function getPlanMilestoneGate(
  notes: NoteItem[],
  rootId: string,
  milestone: PlanMilestone,
  today = homeLocalDate(),
): PlanMilestoneGate {
  const scope = collectProjectScope(notes, rootId);
  const projectNotes = notes.filter((note) => note.noteType === 'project');
  const byId = new Map(projectNotes.map((note) => [note.id, note]));
  const prerequisiteLeaves = scope.flatMap((project): PlanMilestonePrerequisite[] => {
    const deadline = getScheduledProjectDeadline(project);
    if (!deadline || deadline.dueDate > milestone.dueDate) return [];
    if (getScheduledProjectChildren(projectNotes, project.id).length > 0) return [];
    return [{
      projectId: project.id,
      title: project.title,
      path: projectPath(project, byId, rootId),
      dueDate: deadline.dueDate,
      completed: getScheduledProjectState(projectNotes, project.id).completed,
    }];
  }).sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.title.localeCompare(b.title));
  const incompleteLeaves = prerequisiteLeaves.filter((item) => !item.completed);
  const ready = incompleteLeaves.length === 0;
  const overdue = !milestone.completed && milestone.dueDate < today;
  const visualState: PlanMilestoneVisualState = milestone.completed
    ? 'completed'
    : overdue
      ? 'overdue'
      : ready
        ? 'ready'
        : 'unready';
  return { prerequisiteLeaves, incompleteLeaves, ready, overdue, visualState };
}

/**
 * Explicit milestones are user-owned acceptance records. They never complete
 * automatically; an unready milestone is protected even if this function is
 * called outside the details panel. Completed milestones can always be undone.
 */
export function togglePlanMilestoneCompletion(
  notes: NoteItem[],
  rootId: string,
  milestoneId: string,
  now = new Date().toISOString(),
): NoteItem[] {
  const root = notes.find((note) => note.id === rootId && note.noteType === 'project');
  const milestone = root?.planMeta?.milestones?.find((item) => item.id === milestoneId);
  if (!root?.planMeta || !milestone) return notes;
  const completed = Boolean(milestone.completed);
  if (!completed && !getPlanMilestoneGate(notes, rootId, milestone, now.slice(0, 10)).ready) return notes;
  const nextCompleted = !completed;
  return notes.map((note) => note.id !== rootId ? note : {
    ...note,
    planMeta: {
      ...note.planMeta!,
      milestones: note.planMeta!.milestones!.map((item) => item.id === milestoneId ? {
        ...item,
        completed: nextCompleted,
        completedAt: nextCompleted ? now : undefined,
      } : item),
      updatedAt: now,
    },
    updatedAt: now,
  });
}
