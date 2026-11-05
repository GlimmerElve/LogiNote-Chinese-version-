import type { LlmToolCall } from '../../types';

/** A UI resume action is an exact tool intent, not a request to let the planner invent a new job. */
export function textbookResumeCall(jobId: string): LlmToolCall {
  if (!/^[a-zA-Z0-9_-]{1,80}$/u.test(jobId)) throw new Error('教材任务编号无效');
  return { id: `textbook-resume-${crypto.randomUUID()}`, name: 'generate_project_textbook', arguments: { jobId } };
}
