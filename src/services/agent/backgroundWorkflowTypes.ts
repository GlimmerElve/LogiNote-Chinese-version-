export const BACKGROUND_STEPS = ['study-tasks', 'wiki-concepts', 'textbook'] as const;
export type BackgroundStepKind = typeof BACKGROUND_STEPS[number];
export type BackgroundStatus = 'prepared' | 'queued' | 'running' | 'stopping' | 'paused' | 'blocked' | 'completed';
export interface BackgroundWorkflowStep {
  kind: BackgroundStepKind; status: 'pending' | 'running' | 'completed' | 'skipped' | 'blocked'; attempts: number;
  childJobId?: string; draftTasks?: string[]; receipt?: string; error?: string;
}
export interface BackgroundWorkflowProject {
  id: string; title: string; baseline: string; documentIds: string[]; knowledgeHashes: Record<string, string>;
  steps: BackgroundWorkflowStep[];
}
export interface BackgroundWorkflowJob {
  version: 1; id: string; scopeId: string; title: string; createdAt: string; updatedAt: string;
  status: BackgroundStatus; modelFingerprint: string; modelLabels: string[]; allowCloud: boolean;
  modelSteps: BackgroundStepKind[];
  documentHashes: Record<string, string>; projects: BackgroundWorkflowProject[]; error?: string;
  archivedAt?: string;
}
export const backgroundWorkflowActive = (job: BackgroundWorkflowJob) => !job.archivedAt && ['queued', 'running', 'stopping'].includes(job.status);
export const backgroundStepDone = (step: BackgroundWorkflowStep) => ['completed', 'skipped'].includes(step.status);
const string = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const ids = (value: unknown, max: number): value is string[] => Array.isArray(value) && value.length <= max
  && value.every(item => string(item, 200) && !['__proto__', 'prototype', 'constructor'].includes(item)) && new Set(value).size === value.length;

/** Private checkpoints only; never persist credentials, provider objects or tool code. */
export function normalizeBackgroundWorkflows(value: unknown): BackgroundWorkflowJob[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50 || JSON.stringify(value).length > 1_500_000) throw new Error('组合任务检查点无效或超过容量');
  const seen = new Set<string>();
  return value.map((job: BackgroundWorkflowJob) => {
    if (!job || job.version !== 1 || !string(job.id, 200) || seen.has(job.id) || !string(job.scopeId, 200)
      || !string(job.title, 160) || !hash(job.modelFingerprint) || typeof job.allowCloud !== 'boolean'
      || !['prepared', 'queued', 'running', 'stopping', 'paused', 'blocked', 'completed'].includes(job.status)
      || !Number.isFinite(Date.parse(job.createdAt)) || !Number.isFinite(Date.parse(job.updatedAt))
      || job.archivedAt !== undefined && (!Number.isFinite(Date.parse(job.archivedAt)) || ['queued', 'running', 'stopping'].includes(job.status))
      || !Array.isArray(job.modelLabels) || job.modelLabels.length > 6 || job.modelLabels.some(label => !string(label, 400))
      || !Array.isArray(job.modelSteps) || job.modelSteps.length > 3 || new Set(job.modelSteps).size !== job.modelSteps.length || job.modelSteps.some(kind => !BACKGROUND_STEPS.includes(kind))
      || !job.documentHashes || typeof job.documentHashes !== 'object' || Array.isArray(job.documentHashes)
      || !ids(Object.keys(job.documentHashes), 240) || Object.values(job.documentHashes).some(value => !hash(value))
      || !Array.isArray(job.projects) || !job.projects.length || job.projects.length > 20
      || !ids(job.projects.map(project => project.id), 20)) throw new Error('组合任务授权范围无效');
    seen.add(job.id);
    const projects = job.projects.map(project => {
      if (!string(project.title, 120) || !hash(project.baseline) || !ids(project.documentIds, 12)
        || !project.knowledgeHashes || typeof project.knowledgeHashes !== 'object' || Array.isArray(project.knowledgeHashes)
        || !ids(Object.keys(project.knowledgeHashes), 30) || Object.values(project.knowledgeHashes).some(value => !hash(value))
        || project.documentIds.some(id => !Object.hasOwn(job.documentHashes, id))
        || !Array.isArray(project.steps) || !project.steps.length || project.steps.length > 3
        || new Set(project.steps.map(step => step.kind)).size !== project.steps.length) throw new Error('组合任务项目范围无效');
      let previous = -1;
      const steps = project.steps.map(step => {
        const order = BACKGROUND_STEPS.indexOf(step.kind);
        if (order < 0 || order <= previous || !['pending', 'running', 'completed', 'skipped', 'blocked'].includes(step.status)
          || !Number.isInteger(step.attempts) || step.attempts < 0 || step.attempts > 2
          || step.childJobId !== undefined && !string(step.childJobId, 200)
          || step.receipt !== undefined && !hash(step.receipt)
          || step.status === 'completed' && !hash(step.receipt)
          || step.draftTasks !== undefined && (!Array.isArray(step.draftTasks) || !step.draftTasks.length || step.draftTasks.length > 7
            || step.draftTasks.some(task => !string(task, 600)))) throw new Error('组合任务步骤无效');
        previous = order;
        return { kind: step.kind, status: step.status, attempts: step.attempts,
          ...(step.childJobId ? { childJobId: step.childJobId } : {}), ...(step.receipt ? { receipt: step.receipt } : {}),
          ...(step.draftTasks ? { draftTasks: [...step.draftTasks] } : {}),
          ...(typeof step.error === 'string' ? { error: step.error.slice(0, 500) } : {}) };
      });
      return { id: project.id, title: project.title, baseline: project.baseline, documentIds: [...project.documentIds], knowledgeHashes: { ...project.knowledgeHashes }, steps };
    });
    if (job.status === 'completed' && !projects.every(project => project.steps.every(backgroundStepDone))) throw new Error('未完成步骤不能标记组合任务已完成');
    return { version: 1, id: job.id, scopeId: job.scopeId, title: job.title, createdAt: job.createdAt, updatedAt: job.updatedAt,
      status: job.status, modelFingerprint: job.modelFingerprint, modelLabels: [...job.modelLabels], modelSteps: [...job.modelSteps], allowCloud: job.allowCloud,
      documentHashes: { ...job.documentHashes }, projects, ...(job.archivedAt ? { archivedAt: job.archivedAt } : {}), ...(typeof job.error === 'string' ? { error: job.error.slice(0, 500) } : {}) };
  });
}
