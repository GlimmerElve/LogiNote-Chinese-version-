import type { LlmProvider, LlmWorkflowId, NoteItem } from '../../types';
import { isLeafProjectNote } from '../knowledgePointSelector';
import { getWorkflowById } from '../../workflows/workflowRegistry';
import { resolveProvider } from '../llmService';
import { ensureLlmSettingsLoaded } from '../llmStorage';
import { agentTaskScope, loadAgentTaskState, saveAgentTaskState } from './taskStateClient';
import { createBackgroundWorkflowRuntime, BackgroundBlocker, BackgroundBoundaryError, type BackgroundWorkflowRequest } from './backgroundWorkflowRuntime';
import { BACKGROUND_STEPS, backgroundStepDone, type BackgroundStepKind, type BackgroundWorkflowJob, type BackgroundWorkflowProject, type BackgroundWorkflowStep } from './backgroundWorkflowTypes';
import type { AgentRuntimeContext } from './types';
import { projectPreparationState, projectStudyTasks } from './homeLearningState';
import { projectPlanningSnapshot, textbookHash } from '../textbook/fingerprint';
import { generateTextbook, prepareTextbook } from '../textbook/generation';
import { textbookDocumentHash, textbookJobCommand, listTextbookJobs, textbookJobListingAvailable } from '../textbook/jobClient';
import { defaultTextbookModelPolicy } from '../textbook/modelPolicy';
import { conceptBatchJobs, conceptBatchConfiguration, conceptBatchContext } from '../conceptBatchService';
import { conceptBatchActive } from '../conceptBatchTypes';
import { previewWikiConceptBatch } from '../conceptBatchScope';
import { isUnfilledWikiKnowledge } from '../wikiKnowledge';
import { runStudyTaskWorkflow, validateWorkflowStudyTasks } from './studyTaskWorkflow';
import { rendererExitPreparation } from '../ui/applicationExit';

const workflowIds: Record<BackgroundStepKind, LlmWorkflowId[]> = { 'study-tasks': ['study-task-generation'],
  'wiki-concepts': ['concept-generation'], textbook: ['textbook-blueprint', 'textbook-chapter', 'textbook-quality'] };
async function configuration(kinds: BackgroundStepKind[], localOnly = false) {
  await ensureLlmSettingsLoaded();
  const profiles = [...new Set(kinds.flatMap(kind => workflowIds[kind]))].map(id => {
    const provider = structuredClone(resolveProvider(id)), workflow = structuredClone(getWorkflowById(id));
    if (!provider || !workflow || !(provider.selectedModel || provider.models[0])) throw new BackgroundBlocker(`请先配置 ${id} 工作流的模型`);
    const url = new URL(provider.baseUrl);
    const local = provider.apiType === 'ollama' && ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
    if (localOnly && !local) throw new BackgroundBlocker(`工作流 ${id} 使用远程模型，本次仅本机许可不能执行`);
    return { id, provider, workflow, local, label: `${workflow.name} · ${local ? '本机' : '远程'} ${provider.name} / ${provider.selectedModel || provider.models[0]} / ${url.origin}` };
  });
  return { fingerprint: await textbookHash({ profiles, policy: defaultTextbookModelPolicy(), resourcePolicy: 'bound-local-and-linked-knowledge-v1' }),
    labels: profiles.map(profile => profile.label), remote: profiles.some(profile => !profile.local), profiles };
}
const findProject = (ctx: AgentRuntimeContext, id: string) => {
  const project = ctx.getNotes().find(note => note.id === id && note.noteType === 'project');
  if (!project || !isLeafProjectNote(id, ctx.getNotes())) throw new BackgroundBoundaryError('原目标项目不存在或不再是学习叶子项目，未跟随当前页面换目标');
  return project;
};
const baseline = (project: NoteItem, notes: NoteItem[], documents: string[]) => textbookHash(projectPlanningSnapshot(project, notes, documents));
const knowledgeHash = (note: NoteItem) => textbookHash({ title: note.title, content: note.content, aliases: note.aliases || [], references: note.referenceSources || [] });
async function captureLinkedKnowledge(target: BackgroundWorkflowProject, ctx: AgentRuntimeContext) {
  const state = projectPreparationState(findProject(ctx, target.id), ctx.getNotes());
  if (state.wikiError) throw new BackgroundBlocker(state.wikiError);
  for (const item of state.wiki) if (item.noteId && item.action === 'skip-filled' && !Object.hasOwn(target.knowledgeHashes, item.noteId)) {
    const note = ctx.getNotes().find(note => note.id === item.noteId && note.noteType === 'knowledge')!;
    target.knowledgeHashes[item.noteId] = await knowledgeHash(note);
  }
}
async function assertWorkflow(job: BackgroundWorkflowJob, ctx: AgentRuntimeContext, selected?: BackgroundWorkflowProject, signal?: AbortSignal) {
  signal?.throwIfAborted();
  await ctx.ensureDataFresh(); signal?.throwIfAborted();
  if (job.scopeId !== await agentTaskScope()) throw new BackgroundBoundaryError('资料库已变化，旧流程授权失效');
  const config = await configuration(job.modelSteps, !job.allowCloud);
  if (config.fingerprint !== job.modelFingerprint) throw new BackgroundBoundaryError('模型、端点或工作流配置已变化，需要重新准备并确认');
  for (const project of selected ? [selected] : job.projects.filter(item => job.status === 'prepared' || !item.steps.every(backgroundStepDone))) {
    const current = findProject(ctx, project.id);
    const hash = await baseline(current, ctx.getNotes(), project.documentIds);
    const taskStep = project.steps.find(step => step.kind === 'study-tasks');
    const textbook = project.steps.find(step => step.kind === 'textbook');
    // Recover an acknowledged/uncertain own write, never accept unrelated edits.
    if (hash !== project.baseline && hash !== taskStep?.receipt
      && !(textbook?.childJobId && current.textbook?.generationJobId === textbook.childJobId)) throw new BackgroundBoundaryError(`《${project.title}》的正文、层级或资料绑定已变化，请重新准备`);
    for (const id of project.documentIds) {
      if (await textbookDocumentHash({ allowedDocIds: project.documentIds }, id) !== job.documentHashes[id]) throw new BackgroundBoundaryError('已批准的本地资料版本变化，请重新准备');
    }
    for (const [id, hash] of Object.entries(project.knowledgeHashes)) {
      const note = ctx.getNotes().find(note => note.id === id && note.noteType === 'knowledge');
      if (!note || await knowledgeHash(note) !== hash) throw new BackgroundBoundaryError('已批准关联知识点正文已变化，请重新准备；未覆盖用户编辑');
    }
  }
  signal?.throwIfAborted();
}
async function build(input: BackgroundWorkflowRequest, ctx: AgentRuntimeContext): Promise<BackgroundWorkflowJob> {
  if (!Array.isArray(input.projectNoteIds) || !input.projectNoteIds.length || input.projectNoteIds.length > 20
    || input.projectNoteIds.some(id => typeof id !== 'string') || new Set(input.projectNoteIds).size !== input.projectNoteIds.length
    || !Array.isArray(input.steps) || !input.steps.length || input.steps.length > 3 || new Set(input.steps).size !== input.steps.length || input.steps.some(kind => !BACKGROUND_STEPS.includes(kind))
    || input.localModelOnly !== undefined && typeof input.localModelOnly !== 'boolean'
    || input.title !== undefined && (typeof input.title !== 'string' || input.title.length > 160)) throw new BackgroundBlocker('请选择至多二十个真实叶子项目及受支持的工作流步骤');
  if (!ctx.applyWorkspaceNoteChange || !ctx.publishTextbook && input.steps.includes('textbook')) throw new BackgroundBlocker('当前窗口缺少保存接口，请重启更新后的桌面应用');
  await ctx.ensureDataFresh(); await conceptBatchJobs.ensureReady();
  const owner = await agentTaskScope(), documentHashes: Record<string, string> = {};
  const requested = new Set(input.steps);
  if (requested.has('textbook')) { requested.add('study-tasks'); requested.add('wiki-concepts'); }
  const projects: BackgroundWorkflowProject[] = [];
  for (const id of input.projectNoteIds) {
    const project = findProject(ctx, id), state = projectPreparationState(project, ctx.getNotes());
    if (state.wikiError) throw new BackgroundBlocker(state.wikiError);
    if (conceptBatchJobs.getSnapshot().some(job => job.projectNoteId === id && conceptBatchActive(job))) throw new BackgroundBlocker(`《${project.title}》已有概念任务运行，请先查询原任务`);
    if (requested.has('textbook')) {
      if (!textbookJobListingAvailable()) throw new BackgroundBlocker('教材任务读取接口不可用，不能据空列表重复创建任务');
      if ((await listTextbookJobs(id)).some(job => job.progress?.running)) throw new BackgroundBlocker(`《${project.title}》已有教材任务运行，请先等待原任务`);
    }
    const documentIds = state.documentBindings.map(item => item.documentId);
    if (documentIds.length > 12) throw new BackgroundBlocker(`《${project.title}》继承资料超过十二份，请先缩小绑定范围`);
    for (const docId of documentIds) documentHashes[docId] = await textbookDocumentHash({ allowedDocIds: documentIds }, docId);
    const steps = BACKGROUND_STEPS.filter(kind => requested.has(kind)).map(kind => ({ kind, attempts: 0,
      status: (kind === 'study-tasks' && state.studyTaskCount > 0 || kind === 'textbook' && state.textbookReady
        || kind === 'wiki-concepts' && state.wiki.length > 0 && state.wiki.every(item => ['skip-filled', 'skip-duplicate'].includes(item.action))) ? 'skipped' as const : 'pending' as const }));
    const target = { id, title: project.title, baseline: await baseline(project, ctx.getNotes(), documentIds), documentIds, knowledgeHashes: {}, steps };
    await captureLinkedKnowledge(target, ctx); projects.push(target);
  }
  const modelSteps = [...new Set(projects.flatMap(project => project.steps.filter(step => !backgroundStepDone(step)).map(step => step.kind)))];
  const config = await configuration(modelSteps, input.localModelOnly === true), now = new Date().toISOString();
  if (owner !== await agentTaskScope()) throw new BackgroundBoundaryError('准备过程中资料库已变化');
  const job: BackgroundWorkflowJob = { version: 1, id: `workflow-${crypto.randomUUID()}`, scopeId: owner, title: input.title?.trim().slice(0, 160) || '学习准备组合任务',
    createdAt: now, updatedAt: now, status: 'prepared', modelFingerprint: config.fingerprint, modelLabels: config.labels,
    modelSteps, allowCloud: config.remote, documentHashes, projects };
  await assertWorkflow(job, ctx); return job;
}
async function execute(job: BackgroundWorkflowJob, target: BackgroundWorkflowProject, step: BackgroundWorkflowStep,
  ctx: AgentRuntimeContext, signal: AbortSignal, checkpoint: () => Promise<void>): Promise<'completed' | 'skipped'> {
  await ctx.ensureDataFresh(); await assertWorkflow(job, ctx, target, signal);
  let project = findProject(ctx, target.id);
  const guard = () => assertWorkflow(job, ctx, target, signal);
  if (step.kind === 'study-tasks') {
    if (projectStudyTasks(project).length) {
      if (step.draftTasks && step.receipt === await baseline(project, ctx.getNotes(), target.documentIds)) {
        target.baseline = step.receipt; step.draftTasks = undefined; await captureLinkedKnowledge(target, ctx); return 'completed';
      }
      return 'skipped';
    }
    if (!step.draftTasks) {
      if (step.attempts >= 2) throw new BackgroundBlocker('该项目学习任务已达到两次生成上限，未自动新建任务绕过预算');
      step.attempts++; await checkpoint();
      const config = await configuration(job.modelSteps, !job.allowCloud), profile = config.profiles.find(item => item.id === 'study-task-generation')!;
      step.draftTasks = await runStudyTaskWorkflow(project, ctx.getNotes(), profile, signal, guard); await checkpoint();
    }
    const tasks = validateWorkflowStudyTasks({ tasks: step.draftTasks });
    await ctx.ensureDataFresh(); await guard(); project = findProject(ctx, target.id);
    if (projectStudyTasks(project).length) throw new BackgroundBoundaryError('生成期间学习任务发生变化，草稿保留，未重复追加');
    const list = tasks.map(task => `- [ ] ${task}`).join('\n');
    const after = { ...project, content: `${list}\n\n${project.content}`, generatedContentBlocks: [...(project.generatedContentBlocks || []), list], updatedAt: new Date().toISOString() };
    step.receipt = await baseline(after, ctx.getNotes().map(note => note.id === after.id ? after : note), target.documentIds);
    await checkpoint(); await guard(); signal.throwIfAborted();
    await ctx.applyWorkspaceNoteChange!({ kind: 'edit', label: `后台生成《${project.title}》学习任务`, before: [project], after: [after] });
    await ctx.ensureDataFresh();
    if (await baseline(findProject(ctx, target.id), ctx.getNotes(), target.documentIds) !== step.receipt) throw new BackgroundBoundaryError('学习任务保存结果未能核对，未执行后续步骤');
    target.baseline = step.receipt; step.draftTasks = undefined; await captureLinkedKnowledge(target, ctx); return 'completed';
  }
  if (step.kind === 'wiki-concepts') {
    let preview;
    try { preview = previewWikiConceptBatch(ctx.getNotes(), { projectNoteId: project.id, source: 'rag', allowCloud: job.allowCloud }); }
    catch { throw new BackgroundBlocker('项目任务尚无可处理的 Wiki 关联或存在歧义，请先补齐任务关联'); }
    if (preview.candidates.some(item => item.action === 'skip-project')) throw new BackgroundBlocker('Wiki 指向项目而非知识点，未把项目正文当成概念来源');
    if (!preview.eligible) return 'skipped';
    const evidenceNotes = preview.candidates.flatMap(item => {
      const note = ctx.getNotes().find(note => note.id === item.noteId && note.noteType === 'knowledge');
      return note && !isUnfilledWikiKnowledge(note) ? [note.id] : [];
    });
    if (!target.documentIds.length && !evidenceNotes.length) throw new BackgroundBlocker('没有绑定的本地资料或已补全关联知识点可供概念补全；未搜索全库、联网或启动资源统筹');
    const childContext = { ...conceptBatchContext(ctx), assertBoundary: guard };
    if (!step.childJobId) {
      await conceptBatchJobs.start({ projectNoteId: target.id, source: 'rag', allowCloud: job.allowCloud,
        evidenceScope: { allowedDocIds: target.documentIds, allowedNoteIds: evidenceNotes } }, childContext,
      { signal, onPrepared: async id => { step.childJobId = id; await checkpoint(); } });
    } else {
      const child = conceptBatchJobs.getSnapshot().find(item => item.id === step.childJobId);
      if (!child) throw new BackgroundBlocker('原概念任务检查点不可读，未重新生成或重复创建');
      if (!conceptBatchActive(child) && child.status !== 'completed') {
        const config = await conceptBatchConfiguration();
        await conceptBatchJobs.resume(child.id, childContext, { fingerprint: config.fingerprint, allowCloud: job.allowCloud }, signal);
      }
    }
    const child = await conceptBatchJobs.waitForJob(step.childJobId!);
    if (signal.aborted) throw new DOMException('已停止', 'AbortError');
    if (child?.status !== 'completed') throw new BackgroundBlocker('知识点尚未全部补全保存，未把占位笔记交给教材生成；请查看逐篇状态');
    await ctx.ensureDataFresh(); await guard();
    const audit = previewWikiConceptBatch(ctx.getNotes(), { projectNoteId: target.id, source: 'rag', allowCloud: job.allowCloud });
    if (audit.eligible || audit.candidates.some(item => item.action === 'skip-project')) throw new BackgroundBlocker('概念保存后的前置审核未通过，未启动教材');
    await captureLinkedKnowledge(target, ctx);
    step.receipt = await textbookHash(audit.candidates.map(item => ({ title: item.title, noteId: item.noteId }))); return 'completed';
  }
  if (project.textbook) {
    if (step.childJobId && project.textbook.generationJobId === step.childJobId) { step.receipt = await textbookHash(project.textbook); return 'completed'; }
    return 'skipped';
  }
  const wiki = previewWikiConceptBatch(ctx.getNotes(), { projectNoteId: target.id, source: 'rag', allowCloud: job.allowCloud });
  if (wiki.eligible || wiki.candidates.some(item => item.action === 'skip-project')) throw new BackgroundBlocker('关联知识点尚未补全，教材前置审核未通过');
  if (!step.childJobId) {
    const prepared = await prepareTextbook(ctx, { projectNoteId: target.id, allowedDocIds: target.documentIds, allowCloud: job.allowCloud, readBoundUrls: false }) as { jobId?: string; status: string };
    if (!prepared.jobId || prepared.status === 'textbook_job_running' || prepared.status === 'textbook_job_archived') throw new BackgroundBlocker('原教材任务正在运行或已归档，请先处理原任务，未重复生成');
    step.childJobId = prepared.jobId; await checkpoint();
  }
  // Preparation occurs after knowledge saves, so its source hashes are current.
  await guard();
  const stored = (await textbookJobCommand({ op: 'get', jobId: step.childJobId })).job;
  if (stored.spec.projectNoteId !== target.id || stored.spec.readBoundUrls || stored.spec.allowCloud !== job.allowCloud
    || JSON.stringify([...stored.spec.allowedDocIds].sort()) !== JSON.stringify([...target.documentIds].sort())) throw new BackgroundBoundaryError('子教材任务不在批准的项目或本地资料范围内');
  const outcome = await generateTextbook(ctx, step.childJobId, signal) as { status?: string; saved?: boolean };
  if (outcome.status !== 'published' || outcome.saved !== true) throw new BackgroundBlocker('教材尚未发布保存，未把后台启动当成完成');
  const saved = findProject(ctx, target.id);
  if (saved.textbook?.generationJobId !== step.childJobId) throw new BackgroundBoundaryError('教材写入结果不能核对');
  step.receipt = await textbookHash(saved.textbook); return 'completed';
}
export const backgroundWorkflows = createBackgroundWorkflowRuntime({ scope: agentTaskScope,
  load: async () => { const loaded = await loadAgentTaskState(); return { scopeId: loaded.scopeId, jobs: loaded.state.workflows || [] }; },
  save: (scopeId, jobs) => saveAgentTaskState(scopeId, { kind: 'workflows', jobs }), build, assert: assertWorkflow, execute,
  canRun: () => !rendererExitPreparation.isStopping() });

export function backgroundWorkflowSummary(job: BackgroundWorkflowJob) {
  const steps = job.projects.flatMap(project => project.steps), saved = steps.filter(backgroundStepDone).length;
  return { id: job.id, title: job.title, status: job.archivedAt ? 'archived' : job.status, archivedAt: job.archivedAt, completedUnits: saved, totalUnits: steps.length, error: job.error,
    projects: job.projects.map(project => ({ id: project.id, title: project.title, documentIds: project.documentIds,
      steps: project.steps.map(step => ({ kind: step.kind, status: step.status, childJobId: step.childJobId, hasSavedDraft: !!step.draftTasks, error: step.error })) })),
    saved: job.status === 'completed', background: true,
    continuation: '仅续办原项目与步骤；切页或关闭助手不取消。中断后重新确认续办，不自动重放模型；没有绑定资料时不扩展检索范围。' };
}
