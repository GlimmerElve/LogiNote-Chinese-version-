import type { LlmCallResponse, LlmProvider, LlmWorkflowTemplate, NoteItem } from '../../types';
import { isLeafProjectNote } from '../knowledgePointSelector';
import { callLLM } from '../llmService';
import { projectAncestors } from '../projectResourceScope';
import { projectPlanningContent } from '../textbook/noteContent';
import { extractWikiTargets } from '../planAdjustmentService';

export function validateWorkflowStudyTasks(value: unknown): string[] {
  const tasks = (value as { tasks?: unknown })?.tasks;
  if (!Array.isArray(tasks) || !tasks.length || tasks.length > 7 || tasks.some(task => typeof task !== 'string'
    || !task.trim() || task.length > 600 || /[\r\n]|@due\(|<|>|```|!\[|\]\(|^\s*[-*+]\s*\[/u.test(task)
    || !extractWikiTargets(task).length || extractWikiTargets(task).length > 3)) throw new Error('学习任务须为至多七条单行动作，每条关联一至三个 Wiki 知识点，不含日期或控制代码');
  return [...new Set((tasks as string[]).map(task => task.trim()))];
}
/** Reuse the installed button workflow, not Agent chat pretending to be it. */
export async function runStudyTaskWorkflow(project: NoteItem, notes: NoteItem[], configuration: { provider: LlmProvider; workflow: LlmWorkflowTemplate },
  signal: AbortSignal, beforeModel: () => Promise<void>, model = callLLM): Promise<string[]> {
  if (!isLeafProjectNote(project.id, notes)) throw new Error('学习任务仅面向学习叶子项目，资料型项目不参与');
  signal.throwIfAborted(); await beforeModel(); signal.throwIfAborted();
  const response: LlmCallResponse = await model({ providerId: '', model: '', workflow: 'study-task-generation',
    userInput: `【笔记信息】\n笔记标题：${project.title}\n所属层级：${project.parentId ? '子项目' : '根项目'}\n祖先链：${projectAncestors(project, notes).slice(1).reverse().map(note => note.title).join(' → ')}\n笔记正文：\n${projectPlanningContent(project.content, project.textbook).slice(0, 2000)}`,
    systemPromptOverride: configuration.workflow.systemPrompt, temperatureOverride: configuration.workflow.defaultParams.temperature,
    maxTokensOverride: configuration.workflow.defaultParams.maxTokens, skipMemoryInjection: true, skipProfileInjection: true,
  }, { signal, providerSnapshot: configuration.provider });
  signal.throwIfAborted();
  if (response.diagnostics?.finishReason === 'length') throw new Error('学习任务响应截断，未自动补 JSON 或写入；草稿检查点保留');
  let parsed: unknown = response.parsedJson;
  if (!parsed) { try { parsed = JSON.parse(response.content.trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '')); }
    catch { throw new Error('学习任务响应不是完整 JSON，未写入'); } }
  return validateWorkflowStudyTasks(parsed);
}
