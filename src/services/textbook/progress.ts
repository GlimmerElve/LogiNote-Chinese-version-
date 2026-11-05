import type { TextbookJob, TextbookPipelineStage, TextbookProgress, TextbookProgressState } from './generationTypes';
import { locateTextbookIssue } from './repair';
import { textbookCostLimits } from './cost';
import { safeTextbookWebError, safeTextbookProgressDiagnostic, safeTextbookTaskError } from './webErrors';
import { previewTextbookCodeRecovery } from './reviewCheckpoint';

/** Only the public projection is redacted; never mutate the persisted private checkpoint. */
export function sanitizeTextbookProgressDiagnostics<T extends TextbookProgressState & {
  error?: string; materialStatus?: TextbookProgress['materialStatus']; localMaterialWarnings?: string[];
}>(value: T): T {
  return { ...value, label: safeTextbookProgressDiagnostic(value.label),
    history: value.history.map((item) => ({ ...item, label: safeTextbookProgressDiagnostic(item.label) })),
    ...(value.error ? { error: safeTextbookProgressDiagnostic(value.error) } : {}),
    ...(value.materialStatus ? { materialStatus: value.materialStatus.map((item) => ({ ...item,
      ...(item.error ? { error: safeTextbookProgressDiagnostic(item.error) } : {}) })) } : {}),
    ...(value.localMaterialWarnings ? { localMaterialWarnings: value.localMaterialWarnings.map(safeTextbookProgressDiagnostic) } : {}) };
}

export const TEXTBOOK_STEPS: Array<{ stage: TextbookPipelineStage; title: string }> = [
  { stage: 'context', title: '画像与认知' }, { stage: 'materials', title: '物料搜集' },
  { stage: 'blueprint', title: '教学蓝图' }, { stage: 'chapters', title: '逐章生成' },
  { stage: 'validating', title: '质量校验' }, { stage: 'publishing', title: '写入笔记' },
];

export function initialTextbookProgress(job: TextbookJob): TextbookProgressState {
  const checkpoint = job.checkpoint;
  const currentStage: TextbookPipelineStage = TEXTBOOK_STEPS.some((step) => step.stage === job.stage) ? job.stage as TextbookPipelineStage
    : checkpoint.quality?.passed ? 'publishing' : checkpoint.quality?.passed === false ? (/^章节 /u.test(checkpoint.quality.issues[0] || '') ? 'chapters' : 'validating')
    : checkpoint.blueprint ? 'chapters' : checkpoint.sources ? 'blueprint' : checkpoint.context ? 'materials' : 'context';
  const state: TextbookProgressState = { currentStage, label: '等待确认后继续', startedAt: job.updatedAt, stageStartedAt: job.updatedAt,
    retry: 0, retryLimit: job.spec.modelPolicy?.maxTruncationRetries || 0, history: [],
    steps: TEXTBOOK_STEPS.map(({ stage }) => ({ stage, status: (
      stage === 'context' ? !!checkpoint.context : stage === 'materials' ? !!checkpoint.sources :
      stage === 'blueprint' ? !!checkpoint.blueprint : stage === 'chapters' ? !!checkpoint.blueprint && checkpoint.chapters?.length === checkpoint.blueprint.chapters.length :
      stage === 'validating' ? checkpoint.quality?.passed === true : job.stage === 'published'
    ) ? 'saved' : 'pending' })) };
  const active = state.steps.find((step) => step.stage === currentStage)!;
  if (job.stage === 'failed' || job.stage === 'cancelled') active.status = job.stage;
  return state;
}

export function textbookProgressSnapshot(job: TextbookJob, running: boolean): TextbookProgress {
  const recovered = !running && !job.archivedAt ? previewTextbookCodeRecovery(job) : undefined;
  if (recovered) job = recovered;
  const state = sanitizeTextbookProgressDiagnostics(structuredClone(job.checkpoint.progress || initialTextbookProgress(job)));
  if (recovered) {
    state.currentStage = 'validating'; state.label = '旧额外字段错误已修复，保留全部章节，确认后继续质量校验';
    delete state.chapterId; delete state.chapterTitle; delete state.chapterIndex;
    state.steps.forEach((step) => { step.status = ['context', 'materials', 'blueprint', 'chapters'].includes(step.stage) ? 'saved' : 'pending'; });
  }
  const saved = new Set(job.checkpoint.chapters?.map((chapter) => chapter.id));
  const findings = job.checkpoint.repair?.findings || (job.checkpoint.quality?.passed === false
    ? job.checkpoint.quality.findings || job.checkpoint.quality.issues.map((issue) => locateTextbookIssue(issue, job.checkpoint.blueprint)) : []);
  const targets = new Set([...(!job.checkpoint.repair?.applied ? findings.filter((finding) => finding.stage === 'chapters').map((finding) => finding.chapterId) : []),
    ...Object.keys(job.checkpoint.sectionRepairs || {}), ...(job.checkpoint.chapterRegeneration?.pendingIds || [])]);
  if (!job.checkpoint.repair?.applied) for (const finding of findings) {
    const step = state.steps.find((item) => item.stage === finding.stage); if (step) step.status = 'failed';
  }
  const chapters = (job.checkpoint.blueprint?.chapters || []).map((chapter) => ({ id: chapter.id, title: chapter.title,
    status: (targets.has(chapter.id) ? 'needs_repair' : saved.has(chapter.id) ? 'saved' : running && state.chapterId === chapter.id ? 'running' : 'pending') as TextbookProgress['chapters'][number]['status'] }));
  const modelStage = ({ materials: 'selection', blueprint: 'blueprint', chapters: 'chapter', validating: 'quality' } as Record<string, string>)[state.currentStage];
  const diagnostic = [...(job.checkpoint.modelAttempts || [])].reverse().find((item) => item.stage === modelStage && item.chapterId === state.chapterId);
  const modelDiagnostics = diagnostic ? (({ inputHash: _privateHash, ...safe }) => safe)(diagnostic) : undefined;
  const pendingFindings = [...(job.checkpoint.repair?.applied ? [] : findings), ...Object.entries(job.checkpoint.sectionRepairs || {}).flatMap(([chapterId, sections]) =>
    sections.map((section) => ({ stage: 'chapters' as const, chapterId, section })))];
  const repairTargets = [...new Map(pendingFindings.map(({ stage, chapterId, section }) =>
    [`${stage}:${chapterId || ''}:${section || ''}`, { stage, chapterId, section }])).values()];
  const cost = job.checkpoint.cost, limits = textbookCostLimits(job);
  const resumeAfterCodeFix = !!recovered && (!cost || ((!cost.stopped || cost.stopped === 'repairs')
    && cost.requests < limits.maxRequests && cost.promptTokens + cost.completionTokens + cost.reservedTokens < limits.maxTotalTokens
    && cost.reviewRechecks < limits.maxReviewRechecks));
  return { ...state, jobId: job.id, projectNoteId: job.spec.projectNoteId, projectTitle: job.spec.projectTitle,
    jobStage: job.stage, running, attempt: job.attempt, updatedAt: job.updatedAt,
    completed: chapters.filter((chapter) => chapter.status === 'saved').length, total: chapters.length, chapters,
    error: recovered ? '已验证旧报错不再复现；继续时仅恢复校验，不重置修订次数或用量。' : job.error ? safeTextbookTaskError(job.error) : undefined,
    resumeAfterCodeFix,
    archived: !!job.archivedAt,
    repairTargets, modelDiagnostics, modelPolicyVersion: job.spec.modelPolicy?.version,
    complexChapterThinkingLimit: job.spec.modelPolicy?.version === 4 ? job.spec.modelPolicy.complexChapterThinking?.maxChapters : undefined,
    materialStatus: job.checkpoint.webReads?.map((item) => ({ id: item.id, title: item.title, status: item.status, error: item.error ? safeTextbookWebError(item.error) : undefined })),
    localMaterialWarnings: job.checkpoint.localMaterialWarnings?.slice(0, 12).map(safeTextbookProgressDiagnostic),
    supplementStatus: job.checkpoint.webSupplement ? { sources: job.checkpoint.webSupplement.count,
      searches: job.checkpoint.webSupplement.queries?.length || 0, warnings: job.checkpoint.webSupplement.warnings?.length || 0 } : undefined,
    cost: job.checkpoint.cost ? { ...job.checkpoint.cost, limits: textbookCostLimits(job) } : undefined,
    qualityReview: job.checkpoint.quality?.status ? { status: job.checkpoint.quality.status,
      blockerCount: job.checkpoint.quality.findings?.length || 0, warningCount: job.checkpoint.quality.warnings?.length || 0,
      ignoredAdviceCount: job.checkpoint.quality.reviewDiagnostics?.filter(item => item.disposition === 'ignored_advice').length || 0,
      reportIssues: job.checkpoint.quality.status === 'needs_recheck' ? job.checkpoint.quality.reviewDiagnostics
        ?.filter(item => item.disposition === 'needs_recheck' && Number.isSafeInteger(item.findingIndex) && item.findingIndex >= 1 && item.findingIndex <= 20
          && /^(?:finding|target\.(?:quote|ref)|basis\[[0-5]\]\.(?:quote|ref))$/u.test(item.field))
        .slice(0, 8).map(({ findingIndex, field, chapterId, section }) => ({ findingIndex, field,
          ...(chapterId && chapters.some(chapter => chapter.id === chapterId) ? { chapterId,
            ...(['explanation', 'boundaries', 'workedExample', 'practice', 'answer', 'selfCheck', 'summary'].includes(section || '') ? { section } : {}) } : {}) })) : undefined } : undefined,
    thinkingModes: job.spec.modelPolicy ? { blueprint: job.spec.modelPolicy.stages.blueprint.thinkingMode, chapter: job.spec.modelPolicy.stages.chapter.thinkingMode } : undefined,
    requiresReprepare: job.stage === 'failed' && diagnostic?.exhausted === true };
}

const latest = new Map<string, TextbookProgress>();
const listeners = new Set<(value: TextbookProgress | null) => void>();
export function publishTextbookProgress(value: TextbookProgress): void {
  latest.set(value.projectNoteId, structuredClone(value));
  if (latest.size > 32) latest.delete(latest.keys().next().value!);
  for (const listener of listeners) listener(value);
}
export function cachedTextbookProgress(projectNoteId: string): TextbookProgress | null { return latest.get(projectNoteId) || null; }
export function subscribeTextbookProgress(listener: (value: TextbookProgress | null) => void): () => void {
  listeners.add(listener);
  // Late subscribers receive the last snapshot; completion/failure does not erase it.
  for (const value of latest.values()) listener(value);
  return () => { listeners.delete(listener); };
}
