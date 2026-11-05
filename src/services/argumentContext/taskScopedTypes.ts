import type { ArgumentContextPack, ArgumentContextRequest } from './types';

/** Only the six pre-answer assessment intents have a reviewed task-scoped reading policy. */
export const ARGUMENT_TASK_SCOPED_TASKS = ['definition', 'example', 'distinguish', 'fact', 'condition', 'reasoning'] as const;
export type ArgumentTaskScopedTask = typeof ARGUMENT_TASK_SCOPED_TASKS[number];
export const ARGUMENT_TASK_SCOPED_READ_POLICY = 'reviewed-task-closure-v2' as const;
export interface ArgumentTaskScopedRequest extends Omit<ArgumentContextRequest, 'task'> {
  task: ArgumentTaskScopedTask;
}
/**
 * Distinct from the v1 whole-neighborhood reader. Required IDs come from the stored
 * seed/task review, closed over its explicitly named groups and relation endpoints.
 * No incident edge, role label or physical neighbor invents a new requirement.
 */
export interface ArgumentTaskScopedPack extends Omit<ArgumentContextPack, 'version' | 'task'> {
  version: 2;
  readPolicy: typeof ARGUMENT_TASK_SCOPED_READ_POLICY;
  task: ArgumentTaskScopedTask;
}
