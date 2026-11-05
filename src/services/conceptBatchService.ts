import type { AgentRuntimeContext } from './agent/types';
import { agentTaskScope, loadAgentTaskState, saveAgentTaskState } from './agent/taskStateClient';
import { createConceptBatchRuntime, type ConceptBatchContext } from './conceptBatchRuntime';
import { generateConcept } from './conceptFillService';
import { ensureLlmSettingsLoaded } from './llmStorage';
import { resolveProvider } from './llmService';
import { getWorkflowById } from '../workflows/workflowRegistry';
import { rendererExitPreparation } from './ui/applicationExit';
import type { ConceptBatchJob } from './conceptBatchTypes';

export async function conceptBatchConfiguration() {
  await ensureLlmSettingsLoaded();
  const provider = structuredClone(resolveProvider('concept-generation'));
  const workflow = structuredClone(getWorkflowById('concept-generation'));
  if (!provider?.selectedModel || !workflow) throw new Error('请先在模型设置中配置概念补全模型');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([provider, workflow])));
  const fingerprint = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  let local = false, endpoint = '端点未识别';
  try {
    const url = new URL(provider.baseUrl); endpoint = url.origin;
    // Match the existing local-only policy; a loopback OpenAI proxy alone does
    // not establish that inference stays on this machine.
    local = provider.apiType === 'ollama' && ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
  } catch { /* Treat unknown endpoints as remote. */ }
  return { fingerprint, local, label: `${local ? '本机' : '远程'}模型 · ${provider.name.slice(0, 50)} · ${provider.selectedModel.slice(0, 100)} · ${endpoint.slice(0, 120)}`,
    generate: (note: Parameters<typeof generateConcept>[0], source: Parameters<typeof generateConcept>[1], options: NonNullable<Parameters<typeof generateConcept>[2]>) =>
      generateConcept(note, source, { ...options, providerSnapshot: provider, workflowSnapshot: workflow }) };
}
export const conceptBatchJobs = createConceptBatchRuntime({
  scope: agentTaskScope,
  load: async () => { const loaded = await loadAgentTaskState(); return { scopeId: loaded.scopeId, jobs: loaded.state.concepts || [] }; },
  save: (scopeId, jobs) => saveAgentTaskState(scopeId, { kind: 'concepts', jobs }),
  configuration: conceptBatchConfiguration,
  canRun: () => !rendererExitPreparation.isStopping(),
});
export function conceptBatchContext(ctx: AgentRuntimeContext): ConceptBatchContext {
  if (!ctx.applyConceptBatchChange) throw new Error('当前窗口未接入概念批处理保存接口，请更新并重启桌面应用');
  return { notes: ctx.getNotes, flush: ctx.ensureDataFresh,
    apply: (change, scopeId) => {
      if (rendererExitPreparation.isStopping()) throw new Error('应用正在退出，不再开始概念写入');
      return ctx.applyConceptBatchChange!(change, scopeId);
    } };
}
export function conceptBatchSummary(job: ConceptBatchJob) {
  return { kind: 'wiki-concepts', id: job.id, title: job.projectTitle, status: job.status,
    scope: { projectNoteId: job.projectNoteId, storageScopeId: job.scopeId },
    completedUnits: job.items.filter(item => item.status === 'completed').length, totalUnits: job.items.length,
    ...(job.error ? { error: job.error } : {}),
    items: job.items.map(item => ({ title: item.wikiTitle, noteId: item.noteId, status: item.status,
      initialized: item.initialized, attempts: item.attempts, hasSavedDraft: !!item.draft, ...(item.error ? { error: item.error } : {}) })),
    continuation: '仅续办原范围未完成项；保存失败复用已持久化草稿。切换页面或关闭助手不取消任务，重启后需确认续办。',
  };
}
