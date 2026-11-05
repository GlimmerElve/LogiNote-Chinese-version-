import type { NoteItem } from '../../types';
import { getLearningCompletionTarget, type LearningTaskBinding } from '../learningCompletion';
import type { HomeFocusProject } from './homepageViewModel';
import { buildHomeScheduledTasks, homeLocalDate } from './homeTaskScheduling';

export type HomeContinueAction = { kind: 'plan'; rootId: string } | {
  kind: 'flow' | 'scene' | 'review';
  noteId: string;
  text: string;
  binding: LearningTaskBinding;
};

/** Resolve against current notes at click time, not a stale rendered recommendation. */
export function resolveHomeContinueAction(
  notes: NoteItem[], project: HomeFocusProject, today = homeLocalDate(),
): HomeContinueAction {
  const plan: HomeContinueAction = { kind: 'plan', rootId: project.noteId };
  const selected = project.nextLaunch;
  if (!selected) return plan;
  const row = buildHomeScheduledTasks(notes, today).find((item) => item.rootId === project.noteId
    && item.pendingDate === project.nearestDueDate
    && item.launch?.noteId === selected.noteId && item.launch.mode === selected.mode
    && item.launch.binding.noteId === selected.binding.noteId
    && item.launch.binding.taskId === selected.binding.taskId
    && item.launch.binding.occurrenceDate === selected.binding.occurrenceDate);
  if (!row?.launch || row.launch.actionDate > today || row.launch.mode === 'none') return plan;
  const target = getLearningCompletionTarget(notes, row.launch.binding);
  if (!target || target.completed || !notes.some((note) => note.id === row.launch!.noteId)) return plan;
  return { kind: row.launch.mode, noteId: row.launch.noteId, text: row.text, binding: target.binding };
}
