import type { AgentRuntimeContext } from './types';
import { backgroundStepDone, backgroundWorkflowActive, normalizeBackgroundWorkflows, type BackgroundWorkflowJob,
  type BackgroundWorkflowProject, type BackgroundWorkflowStep, type BackgroundStepKind } from './backgroundWorkflowTypes';

export class BackgroundBoundaryError extends Error {}
export class BackgroundBlocker extends Error {}
export interface BackgroundWorkflowRequest { projectNoteIds: string[]; steps: BackgroundStepKind[]; localModelOnly?: boolean; title?: string; }
const message = (error: unknown) => error instanceof BackgroundBoundaryError || error instanceof BackgroundBlocker ? error.message.slice(0, 500)
  : '本步骤未完成；检查点和已保存成果保留，请检查模型、资料与保存状态后确认续办。';

/** A finite, approval-bound operation graph, not an unconstrained background Agent loop. */
export function createBackgroundWorkflowRuntime(ports: {
  scope(): Promise<string>;
  load(): Promise<{ scopeId: string; jobs: BackgroundWorkflowJob[] }>;
  save(scopeId: string, jobs: BackgroundWorkflowJob[]): Promise<void>;
  build(input: BackgroundWorkflowRequest, ctx: AgentRuntimeContext): Promise<BackgroundWorkflowJob>;
  assert(job: BackgroundWorkflowJob, ctx: AgentRuntimeContext, project?: BackgroundWorkflowProject, signal?: AbortSignal): Promise<void>;
  execute(job: BackgroundWorkflowJob, project: BackgroundWorkflowProject, step: BackgroundWorkflowStep,
    ctx: AgentRuntimeContext, signal: AbortSignal, checkpoint: () => Promise<void>): Promise<'completed' | 'skipped'>;
  canRun(): boolean;
}) {
  let scope: string | undefined, jobs: BackgroundWorkflowJob[] = [], snapshot: BackgroundWorkflowJob[] = [];
  let loading: Promise<void> | undefined, writes: Promise<void> = Promise.resolve(), lane: Promise<void> = Promise.resolve();
  let persistenceError: string | undefined;
  const prepared = new Map<string, BackgroundWorkflowJob>(), listeners = new Set<() => void>();
  const controllers = new Map<string, AbortController>(), runs = new Map<string, Promise<void>>();
  const notify = () => { snapshot = structuredClone(jobs); for (const listener of listeners) try { listener(); } catch { /* UI does not own execution. */ } };
  const checkpoint = async (job: BackgroundWorkflowJob) => {
    if (job.scopeId !== scope || !jobs.includes(job)) throw new BackgroundBoundaryError('资料库已切换，未写入旧组合任务');
    job.updatedAt = new Date().toISOString();
    const owner = scope!, data = normalizeBackgroundWorkflows(structuredClone(jobs)); notify();
    const operation = writes.catch(() => {}).then(() => ports.save(owner, data)); writes = operation;
    try { await operation; persistenceError = undefined; }
    catch { persistenceError = '组合任务检查点保存失败；已停止后续模型与写入。'; notify(); throw new BackgroundBoundaryError(persistenceError); }
  };
  async function ensureReady() {
    if (loading) { await loading; return ensureReady(); }
    loading = (async () => {
      const owner = await ports.scope(); if (owner === scope) return;
      for (const controller of controllers.values()) controller.abort();
      const loaded = await ports.load();
      if (loaded.scopeId !== owner || owner !== await ports.scope()) throw new BackgroundBoundaryError('资料库正在变化，请重新查询任务');
      jobs = normalizeBackgroundWorkflows(loaded.jobs).map(job => backgroundWorkflowActive(job)
        ? { ...job, status: 'paused', error: '上次运行中断，已保存成果保留；重新确认后续办，不自动重放模型请求。',
          projects: job.projects.map(project => ({ ...project, steps: project.steps.map(step => step.status === 'running' ? { ...step, status: 'pending' as const } : step) })) }
        : job);
      scope = owner; prepared.clear(); persistenceError = undefined; notify();
    })();
    try { await loading; } finally { loading = undefined; }
  }
  const guard = async (job: BackgroundWorkflowJob, ctx: AgentRuntimeContext, project?: BackgroundWorkflowProject, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (!ports.canRun()) throw new BackgroundBoundaryError('应用正在退出，已停止后续步骤');
    if (job.scopeId !== scope || job.scopeId !== await ports.scope()) throw new BackgroundBoundaryError('资料库已变化，旧流程不会跟随页面换目标');
    await ports.assert(job, ctx, project, signal); signal?.throwIfAborted();
    if (!ports.canRun()) throw new BackgroundBoundaryError('应用正在退出，已停止后续步骤');
  };
  async function prepare(input: BackgroundWorkflowRequest, ctx: AgentRuntimeContext) {
    await ensureReady();
    if (!ports.canRun()) throw new BackgroundBoundaryError('应用正在退出，不准备新流程');
    const candidate = normalizeBackgroundWorkflows([await ports.build(input, ctx)])[0];
    if (candidate.scopeId !== scope) throw new BackgroundBoundaryError('准备期间资料库已变化');
    if (prepared.size >= 20) prepared.delete(prepared.keys().next().value!);
    prepared.set(candidate.id, candidate);
    return structuredClone(candidate);
  }
  async function approval(id: string, ctx: AgentRuntimeContext) {
    await ensureReady(); const job = prepared.get(id) || jobs.find(item => item.id === id);
    if (!job) throw new BackgroundBoundaryError('组合任务不存在，请重新准备');
    await guard(job, ctx);
    return structuredClone(job);
  }
  function queue(job: BackgroundWorkflowJob, ctx: AgentRuntimeContext) {
    const controller = new AbortController(); controllers.set(job.id, controller);
    const run = lane.catch(() => {}).then(async () => {
      try {
        await guard(job, ctx, undefined, controller.signal);
        job.status = 'running'; job.error = undefined; await checkpoint(job);
        for (const project of job.projects) {
          if (project.steps.every(backgroundStepDone)) continue;
          try {
            for (const step of project.steps) {
              if (backgroundStepDone(step)) continue;
              await guard(job, ctx, project, controller.signal);
              step.status = 'running'; step.error = undefined; await checkpoint(job);
              const status = await ports.execute(job, project, step, ctx, controller.signal, () => checkpoint(job));
              // A late Stop during an already accepted disk save does not undo it.
              step.status = status; step.error = undefined; await checkpoint(job);
              controller.signal.throwIfAborted();
            }
          } catch (error) {
            if (controller.signal.aborted || error instanceof BackgroundBoundaryError) throw error;
            const step = project.steps.find(item => !backgroundStepDone(item));
            if (step) { step.status = 'blocked'; step.error = message(error); }
            await checkpoint(job);
            // One evidence gap does not discard other approved projects.
          }
        }
        job.status = job.projects.every(project => project.steps.every(backgroundStepDone)) ? 'completed' : 'blocked';
        if (job.status === 'blocked') job.error = '部分项目存在前置条件缺口；未扩大资料范围，已保存成果保留。';
      } catch (error) {
        job.status = 'paused'; job.error = controller.signal.aborted ? '已停止后续步骤，已保存任务、知识点、教材和草稿保留。' : message(error);
        for (const project of job.projects) for (const step of project.steps) if (step.status === 'running') step.status = 'pending';
      } finally {
        try { await checkpoint(job); } catch { job.status = 'paused'; job.error = persistenceError || '组合任务检查点未保存，未报告完成'; }
        if (controllers.get(job.id) === controller) controllers.delete(job.id);
        runs.delete(job.id); notify();
      }
    });
    lane = run; runs.set(job.id, run);
  }
  async function start(id: string, ctx: AgentRuntimeContext) {
    await ensureReady();
    const existing = jobs.find(job => job.id === id);
    if (existing && backgroundWorkflowActive(existing)) return structuredClone(existing);
    const job = prepared.get(id) || existing;
    if (!job || job.status === 'completed') throw new BackgroundBoundaryError('请选择已准备或未完成的真实组合任务');
    if (job.archivedAt) throw new BackgroundBlocker('该组合任务已归档，请先明确恢复原任务；未另建任务或重置预算');
    await guard(job, ctx);
    if (backgroundWorkflowActive(job)) return structuredClone(job);
    if (jobs.some(other => other.id !== job.id && backgroundWorkflowActive(other)
      && other.projects.some(project => job.projects.some(target => target.id === project.id)))) throw new BackgroundBlocker('所选项目已有组合任务运行，未重复启动');
    if (!existing && (jobs.length >= 50 || jobs.filter(item => !item.archivedAt).length >= 10)) throw new BackgroundBlocker('组合任务记录已满（至多10项未归档、50项历史），请先归档或处理现有任务；未删除检查点或草稿');
    if (!existing) jobs.push(job);
    job.status = 'queued'; job.error = undefined;
    try { await checkpoint(job); }
    catch (error) { job.status = 'paused'; job.error = message(error); notify(); throw error; }
    queue(job, ctx); prepared.delete(id); return structuredClone(job);
  }
  async function stop(id: string) {
    const job = jobs.find(item => item.id === id);
    if (!job || !backgroundWorkflowActive(job)) throw new BackgroundBlocker('该组合任务已停止或不存在');
    job.status = 'stopping'; controllers.get(id)?.abort(); await checkpoint(job);
  }
  async function archive(id: string, archived: boolean) {
    await ensureReady(); const job = jobs.find(item => item.id === id);
    if (!job || job.scopeId !== scope || scope !== await ports.scope()) throw new BackgroundBoundaryError('组合任务不存在或资料库已变化');
    if (backgroundWorkflowActive(job)) throw new BackgroundBlocker('请先停止正在执行的组合任务，再归档');
    if (archived) job.archivedAt = new Date().toISOString(); else delete job.archivedAt;
    await checkpoint(job); return structuredClone(job);
  }
  return { prepare, approval, start, stop, archive, ensureReady,
    getPlan: (id: string) => { const job = prepared.get(id) || jobs.find(item => item.id === id); return job ? structuredClone(job) : undefined; },
    getSnapshot: () => snapshot, getPersistenceError: () => persistenceError,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    flush: () => writes, async waitForIdle() { await Promise.all([...runs.values()]); await writes; },
    async stopAll() { for (const controller of controllers.values()) controller.abort(); await Promise.all([...runs.values()]); await writes; },
  };
}
