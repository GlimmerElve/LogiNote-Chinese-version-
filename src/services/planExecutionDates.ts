import type { PlanTaskBlueprint } from '../types';

export const executionRepeats = (task: Pick<PlanTaskBlueprint, 'recurrence'>): boolean => Boolean(task.recurrence && task.recurrence.frequency !== 'none');

/** Timeline moves and date-field edits move the real recurrence boundary too.
 * An explicit endDate (including clearing it) takes precedence over inference. */
export function updateExecutionDates(task: PlanTaskBlueprint, patch: Partial<PlanTaskBlueprint>): PlanTaskBlueprint {
  const next = { ...task, ...patch };
  if (!executionRepeats(next)) return next;
  const explicitEnd = patch.recurrence && Object.hasOwn(patch.recurrence, 'endDate');
  if ((patch.dueDate !== undefined && Boolean(task.recurrence?.endDate) && !explicitEnd) || !executionRepeats(task)) {
    next.recurrence = { ...next.recurrence!, endDate: next.dueDate || undefined };
  }
  return next;
}

