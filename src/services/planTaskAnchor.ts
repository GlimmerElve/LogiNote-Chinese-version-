const PLAN_TASK_ANCHOR = /<!--\s*ln-task:([A-Za-z0-9._:-]+)\s*-->/i;

export function createPlanTaskId(noteId: string, now = Date.now()): string {
  const safeNote = noteId.replace(/[^A-Za-z0-9._-]/g, '-').slice(-32) || 'note';
  return `plan-task-${safeNote}-${now}-${Math.random().toString(36).slice(2, 8)}`;
}

export function extractPlanTaskId(line: string): string | null {
  return PLAN_TASK_ANCHOR.exec(line)?.[1] || null;
}

export function stripPlanTaskAnchor(text: string): string {
  return text.replace(PLAN_TASK_ANCHOR, '').trim();
}

export function formatPlanTaskLine(taskText: string, dueDate: string, taskId: string): string {
  return `- [ ] ${taskText.trim()} @due(${dueDate}) <!-- ln-task:${taskId} -->`;
}
