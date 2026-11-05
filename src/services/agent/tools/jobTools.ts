import { registerTool } from '../toolRegistry';
import { listTextbookJobs, textbookJobListingAvailable } from '../../textbook/jobClient';
import { safeTextbookTaskError } from '../../textbook/webErrors';
import { documentBackgroundJobs } from '../../documentBackgroundJobs';
import { documentJobActive } from '../../documentBackgroundQueue';
import { documentTaskSummary, textbookTaskSummary, type AgentTaskSummary, type AgentTaskAction } from '../taskLifecycle';
import { registerDocumentJobRecoveryTools } from './jobRecoveryTools';
import { conceptBatchJobs, conceptBatchSummary } from '../../conceptBatchService';
import { conceptBatchActive } from '../../conceptBatchTypes';
import { backgroundWorkflows, backgroundWorkflowSummary } from '../backgroundWorkflowService';
import { backgroundWorkflowActive } from '../backgroundWorkflowTypes';

export function registerJobTools() {
  registerDocumentJobRecoveryTools();
  registerTool({ name: 'query_agent_jobs', description: '读取当前工作区、最近页面动作和跨功能任务摘要：教材后台任务、资料论证队列、当前计划与资源草稿。projectNoteId 限定教材项目，未提供则查询当前项目；allProjects=true 查询最多 50 个项目。仅查元数据，不读取私人草稿正文、不调用模型。返回每类真实支持的操作；页面离开不等于任务停止。',
    parameters: { type: 'object', additionalProperties: false, properties: { projectNoteId: { type: 'string' }, allProjects: { type: 'boolean' }, includeArchived: { type: 'boolean' } } },
    location: 'renderer', permission: 'readonly', execute: async (args, ctx) => {
      if (args.allProjects !== undefined && typeof args.allProjects !== 'boolean') throw new Error('allProjects 必须是布尔值');
      const projects = ctx.getNotes().filter(note => note.noteType === 'project');
      const current = ctx.getActiveNote?.();
      const selectedId = typeof args.projectNoteId === 'string' ? args.projectNoteId : current?.noteType === 'project' ? current.id : current?.parentId;
      if (args.projectNoteId !== undefined && !projects.some(note => note.id === args.projectNoteId)) throw new Error('目标项目不存在');
      const targets = args.allProjects === true ? projects : projects.filter(note => note.id === selectedId);
      if (targets.length > 50) throw new Error('项目过多，请指定项目范围后查询');
      const workspace=ctx.getWorkspaceSnapshot?.();
      const textbook: unknown[] = [], tasks:AgentTaskSummary[]=[], unavailable: string[] = [];
      if (targets.length && !textbookJobListingAvailable()) unavailable.push('教材任务列表接口不可用；请在更新后的桌面应用中查询，不能据空列表认定没有任务。');
      // Bound concurrency and keep per-project failure visible, never report an empty queue as success.
      for (let offset = 0; offset < targets.length; offset += 5) {
        const results = await Promise.allSettled(targets.slice(offset, offset + 5).map(note => listTextbookJobs(note.id)));
        results.forEach((result, index) => {
          if (result.status === 'rejected') { unavailable.push(`《${targets[offset + index].title}》教材任务暂时无法读取`); return; }
          for (const job of result.value) if (args.includeArchived === true || !job.archivedAt) {tasks.push(textbookTaskSummary(job));textbook.push({
            kind: 'textbook', id: job.jobId, projectNoteId: job.projectNoteId, title: job.title, stage: job.stage,
            running: job.progress?.running === true, archivedAt: job.archivedAt, completedUnits: job.completedChapters, totalUnits: job.totalChapters,
            ...(job.error ? { error: safeTextbookTaskError(job.error) } : {}),
            supportedTools: job.progress?.running === true ? ['query_textbook_job', 'stop_textbook_job'] : job.stage === 'published' ? ['open_project_textbook', 'read_project_textbook', 'edit_project_textbook', 'query_textbook_job', 'regenerate_textbook_chapters']
              : job.archivedAt ? ['query_textbook_job', 'archive_textbook_job'] : ['query_textbook_job', 'generate_project_textbook', 'regenerate_textbook_chapters', 'archive_textbook_job', 'clear_textbook_draft_cache'],
          });}
        });
      }
      const plan = ctx.getPlanDraftSession(), resource = ctx.getResourceDraftSession();
      for(const [kind,draft,query,commit,discard] of [
        ['plan',plan,'query_project_task_draft','commit_project_task_draft','discard_project_task_draft'],
        ['resource',resource,'query_project_resource_draft','commit_project_resource_draft','discard_project_resource_draft'],
      ] as const)if(draft)tasks.push({kind,id:draft.id,title:draft.scopeProjectTitle,status:'waiting-confirmation',nativeStatus:'draft',scope:{projectNoteId:draft.scopeProjectId},
        actions:[{tool:query,arguments:{},requiresConfirmation:false,mayCallModel:false},{tool:commit,arguments:{},requiresConfirmation:true,mayCallModel:false},{tool:discard,arguments:{},requiresConfirmation:true,mayCallModel:false}],
        continuation:'这是待核对草案，不是已写回结果；必须核对草案身份并确认，不因重新打开助手而自动提交。'});
      let documents:ReturnType<typeof documentTaskSummary>[]=[];
      try{
        await documentBackgroundJobs.ensureReady();const jobs=documentBackgroundJobs.getSnapshot();
        documents=jobs.filter(job=>args.includeArchived===true||!job.archivedAt).map(job=>documentTaskSummary(job,jobs));tasks.push(...documents);
        if(documentBackgroundJobs.getPersistenceError())unavailable.push('资料任务进度未能保存，请检查存储；不能保证本次进度跨重启恢复。');
      }catch{unavailable.push('资料任务恢复接口或文件不可用；不能据空列表认定没有任务，请检查存储或重启更新后的桌面应用。');}
      const concepts: ReturnType<typeof conceptBatchSummary>[] = [];
      try {
        await conceptBatchJobs.ensureReady();
        for (const job of conceptBatchJobs.getSnapshot()) {
          if (args.projectNoteId && job.projectNoteId !== args.projectNoteId) continue;
          const summary = conceptBatchSummary(job); concepts.push(summary);
          const actions: AgentTaskAction[] = [{ tool: 'query_wiki_concept_jobs', arguments: { jobId: job.id }, requiresConfirmation: false, mayCallModel: false }];
          if (conceptBatchActive(job)) actions.push({ tool: 'control_wiki_concept_job', arguments: { jobId: job.id, action: 'stop' }, requiresConfirmation: true, mayCallModel: false });
          else if (job.scopeId === conceptBatchJobs.getScopeId() && ['paused', 'partial', 'failed'].includes(job.status)) {
            actions.push({ tool: 'control_wiki_concept_job', arguments: { jobId: job.id, action: 'resume' }, requiresConfirmation: true, mayCallModel: true });
          }
          tasks.push({ kind: summary.kind, id: job.id, title: job.projectTitle, status: job.status === 'partial' ? 'failed' : job.status,
            nativeStatus: job.status, scope: summary.scope, completedUnits: summary.completedUnits, totalUnits: summary.totalUnits,
            actions, continuation: summary.continuation, ...(summary.error ? { error: summary.error } : {}) });
        }
        if (conceptBatchJobs.getPersistenceError()) unavailable.push(conceptBatchJobs.getPersistenceError()!);
      } catch { unavailable.push('概念批处理进度暂时无法读取；不能据空列表认定没有任务，请检查存储或重启更新后的桌面应用。'); }
      const workflows: ReturnType<typeof backgroundWorkflowSummary>[] = [];
      try {
        await backgroundWorkflows.ensureReady();
        for (const job of backgroundWorkflows.getSnapshot().filter(job => (!job.archivedAt || args.includeArchived === true) && (!args.projectNoteId || job.projects.some(project => project.id === args.projectNoteId)))) {
          const summary = backgroundWorkflowSummary(job); workflows.push(summary);
          tasks.push({ kind: 'workflow', id: job.id, title: job.title, status: job.archivedAt ? 'archived' : job.status === 'blocked' ? 'failed' : job.status === 'prepared' ? 'waiting-confirmation' : job.status,
            nativeStatus: job.status, scope: { storageScopeId: job.scopeId }, completedUnits: summary.completedUnits, totalUnits: summary.totalUnits,
            continuation: summary.continuation, ...(job.error ? { error: job.error } : {}), actions: [
              { tool: 'query_background_workflows', arguments: { jobId: job.id }, requiresConfirmation: false, mayCallModel: false },
              ...(job.archivedAt ? [{ tool: 'archive_background_workflow', arguments: { jobId: job.id, archived: false }, requiresConfirmation: true, mayCallModel: false }]
                : backgroundWorkflowActive(job) ? [{ tool: 'stop_background_workflow', arguments: { jobId: job.id }, requiresConfirmation: false, mayCallModel: false }]
                : job.status !== 'completed' ? [{ tool: 'start_background_workflow', arguments: { jobId: job.id }, requiresConfirmation: true, mayCallModel: true }] : []),
            ] });
        }
        if (backgroundWorkflows.getPersistenceError()) unavailable.push(backgroundWorkflows.getPersistenceError()!);
      } catch { unavailable.push('组合任务状态暂时不可读，不能据空列表认定没有任务'); }
      return { workspace, textbook, concepts, workflows, unavailable,tasks,
        documents:documents.map(job=>({...job,docId:job.scope.docId,supportedTools:job.actions.map(action=>action.tool)})),
        drafts: [
          ...(plan ? [{ kind: 'plan', id: plan.id, title: plan.scopeProjectTitle, supportedTools: ['query_project_task_draft', 'discard_project_task_draft', 'commit_project_task_draft'] }] : []),
          ...(resource ? [{ kind: 'resource', id: resource.id, title: resource.scopeProjectTitle, supportedTools: ['query_project_resource_draft', 'discard_project_resource_draft', 'commit_project_resource_draft'] }] : []),
          ...(ctx.hasPendingPlanEditorDraft?.() ? [{ kind: 'plan-editor', status: 'awaiting-user-review', supportedTools: ['navigate'], destination: 'plan' }] : []),
        ], limits: '教材与资料队列保留各自检查点和预算。复习、心流、场景当前是交互会话，可读取近期结果、进入既有入口；不能从此工具自动重评、改评分或重放会话。',
      };
    },
  });
  const target = (args: Record<string, unknown>) => {
    if (typeof args.jobId !== 'string') throw new Error('请使用真实后台任务 ID');
    const job = documentBackgroundJobs.getSnapshot().find(item => item.id === args.jobId);
    if (!job || !documentJobActive(job)) throw new Error('该资料任务已结束或不存在，请重新查询');
    return job;
  };
  registerTool({ name: 'cancel_document_job', description: '确认后取消一项真实资料论证后台任务的排队或后续请求，已保存批次和旧图保留。不是删除资料，也不是永久清理模型产物。正在返回的请求可能仍有消耗。',
    parameters: { type: 'object', required: ['jobId'], additionalProperties: false, properties: { jobId: { type: 'string' } } }, location: 'renderer', permission: 'write',
    approvalSnapshot: async args => {await documentBackgroundJobs.ensureReady();const job = target(args); return { id: job.id, docId: job.docId, scopeId:job.scopeId,action: job.action, status: job.status }; },
    confirmation: args => { const job = target(args); return { title: `停止资料任务《${job.fileName}》`, description: '取消排队或请求停止后续处理，已保存批次保留；不自动重试。' }; },
    execute: args => { const job = target(args); documentBackgroundJobs.cancel(job.id); return { jobId: job.id, status: documentBackgroundJobs.getSnapshot().find(item => item.id === job.id)?.status, savedBatchesRetained: true }; },
  });
}
