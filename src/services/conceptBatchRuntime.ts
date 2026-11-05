import type { ConceptDraft, ConceptSource, NoteItem } from '../types';
import type { WorkspaceNoteChange } from './agent/workspaceOperations';
import { conceptBatchActive, conceptNoteBaseline, normalizeConceptBatchJobs, normalizeConceptDraft, type ConceptBatchJob, type ConceptBatchItem } from './conceptBatchTypes';
import { findWikiKnowledge, previewWikiConceptBatch, wikiTitleKey, type ConceptBatchRequest } from './conceptBatchScope';
import { initializeWikiKnowledge, isUnfilledWikiKnowledge } from './wikiKnowledge';
import { prepareConceptNoteWrite } from './ui/conceptNoteWrite';

export interface ConceptBatchContext {
  notes: () => NoteItem[];
  flush: () => Promise<void>;
  apply: (change: WorkspaceNoteChange, scopeId: string) => Promise<unknown>;
  assertBoundary?: () => Promise<void>;
}
export interface ConceptBatchConfiguration {
  fingerprint: string; label: string; local: boolean;
  generate: (note: NoteItem, source: ConceptSource, options: { signal: AbortSignal; onStage: (stage: 'retrieving' | 'generating') => void; beforeModel: () => Promise<void>;
    evidenceScope?: import('./conceptFillService').ConceptEvidenceScope }) => Promise<ConceptDraft>;
}
class BatchBoundaryError extends Error {}
class BatchConflict extends Error {}
class BatchItemError extends Error {}
const done = (item: ConceptBatchItem) => ['completed', 'skipped'].includes(item.status);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const safeError = (error: unknown) => error instanceof BatchBoundaryError || error instanceof BatchConflict || error instanceof BatchItemError ? error.message
  : '检索、生成或保存未完成；已保留检查点，请检查来源、模型与存储后重试。';

/** Independent of page/assistant lifetimes. Ports own actual note persistence. */
export function createConceptBatchRuntime(ports: {
  scope: () => Promise<string>;
  load: () => Promise<{ scopeId: string; jobs: ConceptBatchJob[] }>;
  save: (scopeId: string, jobs: ConceptBatchJob[]) => Promise<void>;
  configuration: () => Promise<ConceptBatchConfiguration>;
  canRun?: () => boolean;
}) {
  let scopeId: string | undefined, jobs: ConceptBatchJob[] = [], snapshot: ConceptBatchJob[] = [];
  let loading: Promise<string> | undefined, writes: Promise<void> = Promise.resolve(), lane: Promise<void> = Promise.resolve();
  let persistenceError: string | undefined;
  const listeners = new Set<() => void>();
  const controllers = new Map<string, AbortController>(), runs = new Map<string, Promise<void>>();
  const contexts = new Map<string, ConceptBatchContext>();
  const notify = () => { snapshot = structuredClone(jobs); for (const listener of listeners) try { listener(); } catch { /* A closed UI does not own the job. */ } };
  const checkpoint = async (job?: ConceptBatchJob) => {
    if (!scopeId || job && (job.scopeId !== scopeId || !jobs.includes(job))) throw new BatchBoundaryError('资料库已变化，旧任务不会写入新库');
    const owner = scopeId, saved = normalizeConceptBatchJobs(structuredClone(jobs));
    notify();
    const operation = writes.catch(() => {}).then(() => ports.save(owner, saved));
    writes = operation;
    try { await operation; persistenceError = undefined; }
    catch { persistenceError = '概念任务检查点保存失败；已停止后续模型请求，请检查存储。'; notify(); throw new BatchBoundaryError(persistenceError); }
  };
  async function ensureReady(): Promise<string> {
    if (loading) { await loading; return ensureReady(); }
    loading = (async () => {
      const owner = await ports.scope();
      if (scopeId === owner) return owner;
      for (const controller of controllers.values()) controller.abort();
      const loaded = await ports.load();
      if (loaded.scopeId !== owner || owner !== await ports.scope()) throw new BatchBoundaryError('资料库发生变化，请重新查询概念任务');
      jobs = normalizeConceptBatchJobs(loaded.jobs).map(job => conceptBatchActive(job) || job.scopeId !== owner
        ? { ...job, status: 'paused', error: job.scopeId !== owner ? '资料库绑定不同，不能直接续办旧任务。' : '上次执行已中断；确认后续办，不会自动调用模型。',
          items: job.items.map(item => ['retrieving', 'generating', 'saving'].includes(item.status) ? { ...item, status: 'pending' as const } : item) }
        : job);
      scopeId = owner; persistenceError = undefined; notify(); return owner;
    })();
    try { return await loading; } finally { loading = undefined; }
  }
  const guard = async (job: ConceptBatchJob, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (ports.canRun?.() === false) throw new BatchBoundaryError('应用正在退出，概念任务停止后续处理并保留检查点。');
    if (job.scopeId !== scopeId || job.scopeId !== await ports.scope()) throw new BatchBoundaryError('资料库已变化，旧任务不会写入新库');
    try { await contexts.get(job.id)?.assertBoundary?.(); }
    catch { throw new BatchBoundaryError('上级组合任务的项目、资料或授权已变化，概念任务停止后续处理。'); }
    const configuration = await ports.configuration();
    if (configuration.fingerprint !== job.modelFingerprint) throw new BatchBoundaryError('模型或工作流配置已变化，请重新检查授权，未切换到新模型执行');
    if (ports.canRun?.() === false) throw new BatchBoundaryError('应用正在退出，概念任务停止后续处理并保留检查点。');
    signal?.throwIfAborted(); return configuration;
  };
  async function preview(request: ConceptBatchRequest, ctx: ConceptBatchContext) {
    const owner = await ensureReady(); await ctx.flush();
    const preview = previewWikiConceptBatch(ctx.notes(), request);
    const configuration = await ports.configuration();
    if (owner !== await ports.scope()) throw new BatchBoundaryError('资料库已变化，请重新预览');
    const targets = new Set(preview.candidates.filter(item => ['create-and-fill', 'fill'].includes(item.action)).map(item => wikiTitleKey(item.title)));
    return { ...preview, scopeId: owner, modelFingerprint: configuration.fingerprint, modelLabel: configuration.label,
      remoteModel: !configuration.local,
      activeJobs: jobs.filter(job => job.scopeId === owner && job.projectNoteId === request.projectNoteId && conceptBatchActive(job)).map(job => job.id),
      unfinishedJobs: jobs.filter(job => job.scopeId === owner && job.projectNoteId === request.projectNoteId
        && !['completed', 'archived'].includes(job.status) && job.items.some(item => !done(item) && targets.has(wikiTitleKey(item.wikiTitle)))).map(job => job.id) };
  }
  async function processItem(job: ConceptBatchJob, item: ConceptBatchItem, ctx: ConceptBatchContext, signal: AbortSignal) {
    const configuration = await guard(job, signal);
    await ctx.flush(); await guard(job, signal);
    const project = ctx.notes().find(note => note.id === job.projectNoteId && note.noteType === 'project');
    if (!project) throw new BatchBoundaryError('原项目已删除，任务已暂停；没有跟随当前页面换目标');
    let note = ctx.notes().find(note => note.id === item.noteId);
    const resolved = findWikiKnowledge(item.wikiTitle, ctx.notes());
    if (resolved && resolved.id !== item.noteId) throw new BatchConflict('同名或别名笔记已出现，未重复创建或改写其它笔记。');
    if (!note) {
      if (!item.created || item.initialized) throw new BatchConflict('原知识笔记已删除，未自动重建。');
      const initialized = initializeWikiKnowledge(item.wikiTitle, item.noteId);
      await ctx.apply({ kind: 'create', label: `初始化 Wiki 知识点《${item.wikiTitle}》`, before: [], after: [initialized] }, job.scopeId);
      await guard(job, signal);
      note = ctx.notes().find(candidate => candidate.id === item.noteId);
      if (!note) throw new BatchBoundaryError('初始化保存未能核对，已暂停任务。');
    }
    if (!item.initialized) { item.initialized = true; await checkpoint(job); }
    // A crash/save failure can occur after the note write but before metadata.
    // Reconcile the saved draft instead of paying for it or writing it again.
    if (item.draft && note.title === item.draft.title && note.content === item.draft.content
      && same(note.referenceSources || [], item.draft.references || [])) {
      item.status = 'completed'; item.draft = undefined; item.error = undefined; await checkpoint(job); return;
    }
    if (!isUnfilledWikiKnowledge(note) || !item.baseline || !same(conceptNoteBaseline(note), item.baseline)) {
      throw new BatchConflict('知识笔记已被编辑、改名或补全，未覆盖新内容；请先核对冲突。');
    }
    if (!item.draft) {
      if (item.attempts >= 3) throw new BatchItemError('该知识点已达到三次生成上限；保留其它成果，请先检查失败原因。');
      item.attempts++; item.status = 'retrieving'; item.error = undefined;
      await checkpoint(job); await guard(job, signal);
      const draft = await configuration.generate(structuredClone(note), job.source, { signal, ...(job.evidenceScope ? { evidenceScope: job.evidenceScope } : {}), beforeModel: async () => { await guard(job, signal); }, onStage: stage => {
        item.status = stage; notify();
      } });
      await guard(job, signal);
      item.draft = normalizeConceptDraft(draft, item.noteId, job.source);
      if (item.draft.title !== note.title) throw new BatchConflict('草稿标题与批准目标不同，未写入。');
      item.status = 'saving'; await checkpoint(job);
    }
    // Draft persistence is a barrier before write; retrying a failed save uses it.
    await ctx.flush(); await guard(job, signal);
    if (!ctx.notes().some(candidate => candidate.id === job.projectNoteId && candidate.noteType === 'project')) {
      throw new BatchBoundaryError('原项目已删除，草稿已保留，未继续自动写入。');
    }
    const latest = ctx.notes().find(candidate => candidate.id === item.noteId);
    if (item.draft.title !== item.baseline.title) throw new BatchConflict('草稿标题与批准目标不同，未写入。');
    if (!latest || !same(conceptNoteBaseline(latest), item.baseline)) throw new BatchConflict('生成期间笔记发生编辑，草稿保留，未覆盖正文。');
    const expected = { ...latest, content: item.baseline.content, referenceSources: item.baseline.references };
    const updated = prepareConceptNoteWrite(latest, expected, item.draft.content, item.draft.references);
    await ctx.apply({ kind: 'edit', label: `补全 Wiki 知识点《${latest.title}》`, before: [latest], after: [updated] }, job.scopeId);
    const saved = ctx.notes().find(candidate => candidate.id === item.noteId);
    if (!saved || saved.content !== item.draft.content || !same(saved.referenceSources || [], item.draft.references || [])) {
      throw new BatchBoundaryError('概念保存结果无法核对，已暂停任务。');
    }
    item.status = 'completed'; item.error = undefined; item.draft = undefined;
    await checkpoint(job);
  }
  function queue(job: ConceptBatchJob, ctx: ConceptBatchContext, externalSignal?: AbortSignal) {
    const controller = new AbortController(); controllers.set(job.id, controller);
    contexts.set(job.id, ctx);
    const cancel = () => controller.abort();
    externalSignal?.addEventListener('abort', cancel, { once: true });
    if (externalSignal?.aborted) controller.abort();
    const run = lane.catch(() => {}).then(async () => {
      try {
        await guard(job, controller.signal);
        job.status = 'running'; job.error = undefined; await checkpoint(job);
        for (const item of job.items) {
          if (done(item)) continue;
          controller.signal.throwIfAborted();
          try { await processItem(job, item, ctx, controller.signal); }
          catch (error) {
            if (controller.signal.aborted || error instanceof BatchBoundaryError) throw error;
            item.status = error instanceof BatchConflict ? 'conflict' : 'failed'; item.error = safeError(error);
            await checkpoint(job);
          }
        }
        job.status = job.items.every(done) ? 'completed' : 'partial';
      } catch (error) {
        job.status = 'paused'; job.error = controller.signal.aborted ? '已停止后续处理，初始化笔记、草稿和已完成内容保留。' : safeError(error);
        for (const item of job.items) if (['retrieving', 'generating', 'saving'].includes(item.status)) item.status = 'pending';
      } finally {
        job.updatedAt = new Date().toISOString();
        try { await checkpoint(job); } catch { /* Persistence error is visible; never run another model here. */ }
        if (controllers.get(job.id) === controller) controllers.delete(job.id);
        runs.delete(job.id); notify();
        contexts.delete(job.id); externalSignal?.removeEventListener('abort', cancel);
      }
    });
    lane = run; runs.set(job.id, run);
  }
  async function start(request: ConceptBatchRequest, ctx: ConceptBatchContext, options?: { signal?: AbortSignal; onPrepared?: (jobId: string) => Promise<void> }) {
    if (ports.canRun?.() === false) throw new BatchBoundaryError('应用正在退出，不再启动概念任务。');
    const state = await preview(request, ctx);
    options?.signal?.throwIfAborted();
    if (state.remoteModel && !request.allowCloud) throw new BatchBoundaryError('概念补全使用远程模型；需先明确同意发送本批证据和术语，再请求确认。');
    if (!state.eligible) throw new BatchBoundaryError('关联知识点已有正文或没有可补全条目，未覆盖任何笔记。');
    if (state.unfinishedJobs.length) throw new BatchBoundaryError('这些知识点已有未完成任务，请查询并确认续办原任务，不重新创建。');
    if (state.activeJobs.length || jobs.some(job => job.scopeId === state.scopeId && job.projectNoteId === state.projectNoteId && conceptBatchActive(job))) {
      throw new BatchBoundaryError('该项目已有概念批处理任务，请查询原任务，不重复启动。');
    }
    if (jobs.length >= 20) {
      const removable = jobs.findIndex(job => job.status === 'completed' && job.items.every(item => !item.draft));
      if (removable < 0) throw new BatchBoundaryError('任务记录已满，请先处理未完成任务；没有删除草稿。');
      jobs.splice(removable, 1);
    }
    const now = new Date().toISOString();
    if (ports.canRun?.() === false) throw new BatchBoundaryError('应用正在退出，不再启动概念任务。');
    const job: ConceptBatchJob = { version: 1, id: `concept-${crypto.randomUUID()}`, scopeId: state.scopeId,
      projectNoteId: state.projectNoteId, projectTitle: state.projectTitle, source: request.source, allowCloud: request.allowCloud,
      modelFingerprint: state.modelFingerprint, modelLabel: state.modelLabel, createdAt: now, updatedAt: now, status: 'queued',
      ...(request.evidenceScope ? { evidenceScope: structuredClone(request.evidenceScope) } : {}),
      items: state.candidates.filter(candidate => ['create-and-fill', 'fill'].includes(candidate.action)).map(candidate => {
        const noteId = candidate.noteId || `note-${crypto.randomUUID()}`;
        return { wikiTitle: candidate.title, noteId, created: !candidate.noteId, initialized: !!candidate.noteId, status: 'pending', attempts: 0,
          baseline: candidate.baseline || conceptNoteBaseline(initializeWikiKnowledge(candidate.title, noteId, now)) };
      }) };
    jobs.push(job);
    try { await checkpoint(job); }
    catch (error) { job.status = 'paused'; job.error = safeError(error); notify(); throw error; }
    // Work begins independently only after the durable approval-bound job exists.
    try { await options?.onPrepared?.(job.id); }
    catch (error) { job.status = 'paused'; job.error = '上级组合任务检查点未保存，未开始概念生成。'; await checkpoint(job); throw error; }
    queue(job, ctx, options?.signal); return structuredClone(job);
  }
  async function resume(jobId: string, ctx: ConceptBatchContext, approvedConfiguration?: { fingerprint: string; allowCloud: boolean }, signal?: AbortSignal) {
    await ensureReady(); const job = jobs.find(candidate => candidate.id === jobId);
    if (!job || conceptBatchActive(job) || ['completed', 'archived'].includes(job.status)) throw new BatchBoundaryError('请选择真实、未完成且未归档的概念任务');
    if (job.scopeId !== scopeId || job.scopeId !== await ports.scope()) throw new BatchBoundaryError('原资料库绑定已改变，不能续办到新库');
    const configuration = await ports.configuration();
    if (configuration.fingerprint !== (approvedConfiguration?.fingerprint || job.modelFingerprint)) throw new BatchBoundaryError('模型或工作流配置已变化，请重新确认续办配置');
    const allowCloud = approvedConfiguration?.allowCloud ?? job.allowCloud;
    if (!configuration.local && !allowCloud) throw new BatchBoundaryError('本次续办尚未授权远程模型发送，未开始执行');
    await ctx.flush();
    if (job.scopeId !== await ports.scope() || configuration.fingerprint !== (await ports.configuration()).fingerprint) throw new BatchBoundaryError('确认后的资料库或模型配置已变化，请重新确认');
    if (ports.canRun?.() === false) throw new BatchBoundaryError('应用正在退出，不再续办概念任务。');
    if (conceptBatchActive(job) || controllers.has(job.id)) throw new BatchBoundaryError('该概念任务已经在执行，未重复续办。');
    if (jobs.some(other => other.id !== job.id && other.scopeId === job.scopeId && other.projectNoteId === job.projectNoteId && conceptBatchActive(other))) {
      throw new BatchBoundaryError('该项目已有其它概念任务运行，请等待后再续办。');
    }
    job.modelFingerprint = configuration.fingerprint; job.modelLabel = configuration.label; job.allowCloud = allowCloud;
    job.status = 'queued'; job.error = undefined;
    try { await checkpoint(job); }
    catch (error) { job.status = 'paused'; job.error = safeError(error); notify(); throw error; }
    queue(job, ctx, signal); return structuredClone(job);
  }
  async function stop(jobId: string) {
    const job = jobs.find(candidate => candidate.id === jobId);
    if (!job || !conceptBatchActive(job)) throw new BatchBoundaryError('概念任务已停止或不存在');
    job.status = 'stopping'; controllers.get(jobId)?.abort(); await checkpoint(job);
  }
  return { ensureReady, preview, start, resume, stop,
    getSnapshot: () => snapshot, getScopeId: () => scopeId, getPersistenceError: () => persistenceError,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    flush: () => writes,
    async waitForIdle() { await Promise.all([...runs.values()]); await writes; },
    async waitForJob(jobId: string) { await runs.get(jobId); await writes; return structuredClone(jobs.find(job => job.id === jobId)); },
    async stopAll() { for (const controller of controllers.values()) controller.abort(); await Promise.all([...runs.values()]); await writes; },
  };
}
