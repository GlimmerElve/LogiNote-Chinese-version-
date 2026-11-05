import { readProgressiveReview, onProgressiveChange } from './reviewClient';
import { remainingProgressiveDraft } from './reviewPolicy';
import type { ProgressiveReviewRecord } from './reviewTypes';
import type { NoteItem } from '../../types';
import { registerPendingFlush } from '../agent/dataFreshness';
import type { ProgressiveBeginReply, ProgressiveCheckpoint, ProgressiveCourse, ProgressiveLease,
  ProgressiveMainline, ProgressiveProgressPatch, ProgressiveProgressRequest, ProgressivePublication,
  ProgressiveReflectionHook, ProgressiveSourcePacket, ProgressiveNextRequest, ProgressiveLessonPage, ProgressiveRoute,
  ProgressiveStudyRequest, ProgressiveStudyReply, ProgressiveAnswerDraft, ProgressiveStudyMutation, ProgressiveSupplementScope, ProgressivePageStudy } from './types';
import { loadProgressiveCourse, beginProgressiveCourse, checkpointProgressiveCourse,
  publishProgressiveCourse, saveProgressiveProgress, interruptProgressiveCourse, nextProgressivePage,
  saveProgressiveStudy, routeProgressivePage } from './client';
import { assessProgressiveAnswers, localProgressiveJudgment, verifyProgressiveFeedback, callProgressiveAssessment, type ProgressiveAssessmentCall } from './assessment';
import { editRestatementSpans } from './restatement';
import { loadProgressiveMaterials, mergeProgressiveMaterials, progressiveGoalContext } from './materials';
import { streamProgressiveFirstPage, type ProgressiveStreamFactory } from './generation';
import { parseProgressiveResponse, ProgressiveStreamParser, stableMarkdownBlocks } from './stream';
import { PROGRESSIVE_MAX_RAW } from './validation';

export type ProgressiveRuntimePhase = 'loading' | 'idle' | 'generating' | 'saving' | 'ready' | 'interrupted' | 'error';
export interface ProgressiveRuntimeTimings {
  startedAt: string | null;
  preparationMs: number | null;
  firstTokenMs: number | null;
  firstReadableMs: number | null;
  pageCompleteMs: number | null;
  pageSavedMs: number | null;
}
export interface ProgressiveRuntimeSnapshot {
  phase: ProgressiveRuntimePhase;
  course: ProgressiveCourse | null;
  plan: ProgressiveMainline | null;
  page: { id: string; title: string; body: string; hook: ProgressiveReflectionHook | null } | null;
  blocks: string[];
  pendingText: string;
  error: string | null;
  saveError: string | null;
  isDirty: boolean;
  study?: ProgressivePageStudy | null;
  studyBusy?: boolean;
  studyBusyQuestions?: string[];
  studyError?: string | null;
  /** Private runtime measurements; never part of the teaching/share projection. */
  timings: ProgressiveRuntimeTimings;
}
export interface ProgressiveStorageAdapter {
  load(projectNoteId: string): Promise<ProgressiveCourse | null>;
  readReview?(projectNoteId:string,reviewId:string):Promise<ProgressiveReviewRecord>;
  begin(projectNoteId: string, sources?: ProgressiveSourcePacket[]): Promise<ProgressiveBeginReply>;
  next?(projectNoteId: string, request: ProgressiveNextRequest): Promise<ProgressiveBeginReply>;
  route?(lease: ProgressiveLease, route: ProgressiveRoute): Promise<ProgressiveBeginReply>;
  study?(projectNoteId: string, request: ProgressiveStudyRequest): Promise<ProgressiveStudyReply>;
  checkpoint(lease: ProgressiveLease, checkpoint: ProgressiveCheckpoint): Promise<ProgressiveCourse>;
  publish(lease: ProgressiveLease, publication: ProgressivePublication): Promise<ProgressiveCourse>;
  saveProgress(projectNoteId: string, progress: ProgressiveProgressRequest): Promise<ProgressiveCourse>;
  interrupt(lease: ProgressiveLease, error?: string): Promise<ProgressiveCourse>;
}
export interface ProgressiveRuntimeOptions {
  storage?: ProgressiveStorageAdapter;
  stream?: ProgressiveStreamFactory;
  loadMaterials?: (note: NoteItem, notes: NoteItem[], pageFocus?: string, signal?: AbortSignal) => Promise<ProgressiveSourcePacket[]>;
  checkpointIntervalMs?: number;
  registerFlush?: (flush: () => Promise<void>) => () => void;
  assessmentCall?: ProgressiveAssessmentCall;
}
export interface ProgressiveController {
  getSnapshot(): ProgressiveRuntimeSnapshot;
  subscribe(listener: () => void): () => void;
  start(): Promise<void>;
  retry(): Promise<void>;
  next(intent?: 'mainline' | 'expansion' | 'auto', scope?: ProgressiveSupplementScope): Promise<void>;
  readingPageId?(): string | null;
  recordRestatement?(text: string, pageId?: string | null): void;
  saveAnswerDraft?(questionId: string, draft: ProgressiveAnswerDraft): void;
  submitAnswers?(questionIds: string[]): Promise<void>;
  retryGrading?(): Promise<void>;
  markExplanationViewed?(questionId:string):Promise<void>;
  sendFeedback?(questionId: string, category: 'question' | 'answer' | 'grading', text: string): Promise<void>;
  retryFeedback?(feedbackId: string): Promise<void>;
  navigate(pageId: string): Promise<void>;
  updateContext?(input: { note: NoteItem; allNotes: NoteItem[] }): void;
  saveProgress(patch: ProgressiveProgressPatch): void;
  flush(): Promise<void>;
  stop(): Promise<void>;
  dispose(): void;
}

const storage: ProgressiveStorageAdapter = {
  readReview:readProgressiveReview, load: loadProgressiveCourse, begin: beginProgressiveCourse, next: nextProgressivePage, checkpoint: checkpointProgressiveCourse,
  publish: publishProgressiveCourse, saveProgress: saveProgressiveProgress, interrupt: interruptProgressiveCourse,
  study: saveProgressiveStudy, route: routeProgressivePage,
};
const activePage = (course: ProgressiveCourse | null): ProgressiveLessonPage | null => course?.page || course?.firstPage || null;
const published = (course: ProgressiveCourse | null) => course?.generation.status === 'ready';
const message = (error: unknown) => (error instanceof Error ? error.message : '课程操作未完成，请重试。').slice(0, 1400);

function recoverPublication(course: ProgressiveCourse): Omit<ProgressivePublication, 'sequence'> | null {
  if (course.generation.routePending || !course.plan || !course.generation.bodyDraft || !course.generation.rawDraft) return null;
  try {
    const parsed = parseProgressiveResponse(course.generation.rawDraft,
      { plan: course.plan, maxMainlinePages: course.budget.maxMainlinePages });
    const body = course.generation.bodyDraft;
    if (!parsed.hook || !/(?:^|\n)@@END[ \t]*(?:\r?\n|$)/u.test(course.generation.rawDraft)
      || body.replace(/\s/gu, '').length < 80 || stableMarkdownBlocks(body, true).incompleteStructure) return null;
    const known = new Set(course.sourcePackets.map(source => source.id));
    for (const marker of body.matchAll(/\[(S\d+)\]/gu)) if (!known.has(marker[1])) return null;
    if (parsed.metadataError) return null;
    return { plan: course.plan, title: course.plan.pages[course.generation.mainlineIndex || 0].title
      + (course.generation.kind === 'expansion' ? ' · 补充讲解' : ''), body, hook: parsed.hook, ...(parsed.concepts ? { concepts: parsed.concepts } : {}),
      ...(parsed.questions?.length ? { questions: parsed.questions } : {}) };
  } catch { return null; }
}

/** Renderer orchestration only. Durable authority and scope checks stay in the desktop store. */
class ProgressiveRuntime implements ProgressiveController {
  private course: ProgressiveCourse | null = null;
  private archiveId:string|null=null;
  private detachReview:(()=>void)|null=null;
  private lease: ProgressiveLease | null = null;
  private plan: ProgressiveMainline | null = null;
  private body = '';
  private raw = '';
  private hook: ProgressiveReflectionHook | null = null;
  private generationVersion = 0;
  private savedGenerationVersion = 0;
  private progressVersion = 0;
  private savedProgressVersion = 0;
  private progressPatch: ProgressiveProgressPatch = {};
  private publication: Omit<ProgressivePublication, 'sequence'> | null = null;
  private interrupted = false;
  private interruptionError: string | undefined;
  private listeners = new Set<() => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private run: Promise<void> | null = null;
  private courseWaiter: { promise: Promise<void>; resolve: () => void } | null = null;
  private abort: AbortController | null = null;
  private reader: ReadableStreamDefaultReader<import('../llmStreamService').StreamChunk> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private poll: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private started = 0;
  private timings: ProgressiveRuntimeTimings = { startedAt: null, preparationMs: null, firstTokenMs: null,
    firstReadableMs: null, pageCompleteMs: null, pageSavedMs: null };
  private releaseFlush: (() => void) | null = null;
  private pendingAnswers = new Map<string, Record<string, ProgressiveAnswerDraft>>();
  private pendingStudySaves = new Set<Promise<unknown>>();
  private studyOperations = new Map<string, Promise<void>>();
  private studyErrors = new Map<string, string>();
  private studyControllers = new Set<AbortController>();
  private studyEpoch = 0;
  private submissionIntents = new Map<string, { key: string; id: string }>();
  private feedbackIntents = new Map<string, string>();
  private readonly assessmentCall: ProgressiveAssessmentCall;
  private readonly registerFlush: (flush: () => Promise<void>) => () => void;
  private readonly deps: Required<Omit<ProgressiveRuntimeOptions, 'registerFlush' | 'assessmentCall'>>;
  private snapshot: ProgressiveRuntimeSnapshot = {
    phase: 'loading', course: null, plan: null, page: null, blocks: [], pendingText: '',
    error: null, saveError: null, isDirty: false,
    timings: this.timings,
  };

  constructor(private readonly input: { note: NoteItem; allNotes: NoteItem[] }, options: ProgressiveRuntimeOptions) {
    this.deps = { storage: options.storage || storage, stream: options.stream || streamProgressiveFirstPage,
      loadMaterials: options.loadMaterials || loadProgressiveMaterials, checkpointIntervalMs: options.checkpointIntervalMs ?? 500 };
    this.registerFlush = options.registerFlush || registerPendingFlush;
    this.assessmentCall = options.assessmentCall || callProgressiveAssessment;
    this.detachReview=onProgressiveChange(id=>{if(id===this.input.note.id&&!this.disposed)void this.refreshReview().catch(error=>this.emit({saveError:message(error)}));});
  }

  private attachFlusher() {
    if (!this.releaseFlush && !this.disposed) this.releaseFlush = this.registerFlush(() => this.flush());
  }

  private detachFlusher() {
    this.releaseFlush?.(); this.releaseFlush = null;
  }

  getSnapshot = (): ProgressiveRuntimeSnapshot => this.snapshot;
  updateContext = (input: { note: NoteItem; allNotes: NoteItem[] }): void => {
    if (input.note.id !== this.input.note.id) return;
    this.input.note = input.note; this.input.allNotes = input.allNotes;
  };
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private emit(patch: Partial<Pick<ProgressiveRuntimeSnapshot, 'phase' | 'error' | 'saveError'>> = {}) {
    const ready = Boolean(activePage(this.course));
    const body = ready ? activePage(this.course)!.body : this.body;
    const markdown = stableMarkdownBlocks(body, ready);
    const plan = activePage(this.course) ? this.course!.plan : this.plan;
    const pageId = activePage(this.course)?.id || this.course?.generation.pageId || 'main-1';
    const study = this.course?.study;
    this.snapshot = {
      ...this.snapshot, ...patch, course: this.course, plan,
      page: this.course || body ? { id: activePage(this.course)?.id || this.course?.generation.pageId || 'main-1',
        title: activePage(this.course)?.title || plan?.pages[this.course?.generation.mainlineIndex || 0]?.title || this.input.note.title,
        body, hook: activePage(this.course)?.hook || this.hook } : null,
      blocks: markdown.blocks, pendingText: markdown.pendingText,
      isDirty: this.generationVersion > this.savedGenerationVersion || this.progressVersion > this.savedProgressVersion || Boolean(this.publication)
        || this.pendingAnswers.size > 0 || this.pendingStudySaves.size > 0,
      study: study ? { ...study, drafts: { ...study.drafts, ...this.pendingAnswers.get(pageId) } } : null,
      studyBusy: [...this.studyOperations.keys()].some(key => key.startsWith(`${pageId}:`)), studyError: this.studyErrors.get(pageId) || null,
      studyBusyQuestions: this.busyQuestionIds(pageId),
      timings: { ...this.timings },
    };
    for (const listener of [...this.listeners]) listener();
    if (this.disposed && !this.snapshot.isDirty) this.detachFlusher();
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => {}).then(work);
    this.queue = next;
    return next;
  }

  private async reconcileReview(course:ProgressiveCourse){
    const id=course.lastSuccessfulReview?.reviewId||null;
    if(id&&id!==this.archiveId&&this.course&&this.deps.storage.readReview){
      const record=await this.deps.storage.readReview(course.projectNoteId,id);
      const remaining=remainingProgressiveDraft(this.course.progress,record);
      this.progressPatch={...this.progressPatch,...remaining};this.progressVersion++;
      this.archiveId=id;this.receive(course);this.schedule();
    }else{this.archiveId=id;this.receive(course);}
  }
  private refreshReview(){return this.enqueue(async()=>{
    const saved=await this.deps.storage.load(this.input.note.id);
    if(!saved||!this.course||saved.id!==this.course.id||saved.environmentId!==this.course.environmentId)return;
    await this.reconcileReview(saved);this.emit();
  });}
  markExplanationViewed=async(questionId:string)=>{
    const page=activePage(this.course),attempt=this.course?.study?.attempts.filter(a=>a.questionId===questionId).at(-1);
    if(page&&attempt?.judgment)await this.mutateStudy(page.id,{kind:'view-explanation',attemptId:attempt.id});
  };
  private receive(course: ProgressiveCourse) {
    this.course = course;
    // Unsaved UI fields are independent of teaching checkpoint acknowledgements.
    if (this.progressVersion > this.savedProgressVersion) {
      this.course = { ...course, progress: { ...course.progress, ...this.progressPatch } };
    }
  }

  private hydrate(course: ProgressiveCourse) {
    const pending = this.progressVersion > this.savedProgressVersion;
    if (pending && this.course && (course.id !== this.course.id || course.environmentId !== this.course.environmentId)) {
      throw new Error('课程环境已变化，未覆盖尚未保存的草稿，请重试保存。');
    }
    this.course = course;
    if (pending) this.course = { ...course, progress: { ...course.progress, ...this.progressPatch } };
    this.archiveId=course.lastSuccessfulReview?.reviewId||null;
    this.plan = course.plan;
    this.body = activePage(course)?.body || course.generation.bodyDraft;
    this.raw = course.generation.rawDraft;
    this.hook = activePage(course)?.hook || null;
    this.generationVersion = this.savedGenerationVersion = 0;
    if (!pending) {
      this.progressVersion = this.savedProgressVersion = 0;
      this.progressPatch = {};
    }
    this.courseWaiter?.resolve();
  }

  private schedule() {
    if (this.timer || this.disposed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush().catch(error => this.emit({ saveError: message(error) }));
    }, this.deps.checkpointIntervalMs);
  }

  saveProgress = (patch: ProgressiveProgressPatch): void => {
    if (!Object.keys(patch).length) return;
    if (patch.restatementDraft !== undefined && patch.restatementDraft !== this.course?.progress.restatementDraft && this.course) {
      patch = { ...patch, restatementSpans: editRestatementSpans(this.course.progress.restatementDraft, patch.restatementDraft,
        this.course.progress.restatementSpans || [], this.readingPageId() || this.course.generation.pageId) };
    }
    this.attachFlusher();
    const changed = Object.keys(patch).some(key => (patch as Record<string, unknown>)[key]
      !== (this.course?.progress as unknown as Record<string, unknown> | undefined)?.[key]);
    if (!changed) return;
    this.progressPatch = { ...this.progressPatch, ...patch };
    this.progressVersion++;
    if (this.course) this.course = { ...this.course, progress: { ...this.course.progress, ...patch } };
    this.emit(); this.schedule();
  };
  readingPageId = (): string | null => activePage(this.course)?.id
    || (!this.body.trim() ? this.course?.generation.fromPageId : null) || this.course?.generation.pageId || null;
  recordRestatement = (text: string, pageId?: string | null): void => {
    if (!this.course || text === this.course.progress.restatementDraft) { this.saveProgress({ restatementDraft: text }); return; }
    const spans = editRestatementSpans(this.course.progress.restatementDraft, text, this.course.progress.restatementSpans || [], pageId || this.readingPageId()!);
    // Supply the explicit capture page without rebasing it again in saveProgress.
    const old = this.course.progress.restatementDraft;
    this.course = { ...this.course, progress: { ...this.course.progress, restatementDraft: text } };
    this.saveProgress({ restatementDraft: text, restatementSpans: spans });
    if (old === text) this.emit();
  };
  saveAnswerDraft = (questionId: string, draft: ProgressiveAnswerDraft): void => {
    const page = activePage(this.course);
    if (!page?.questions?.some(question => question.id === questionId)) return;
    this.attachFlusher();
    this.pendingAnswers.set(page.id, { ...this.pendingAnswers.get(page.id), [questionId]: { ...draft } });
    this.emit(); this.schedule();
  };
  private mutateStudy(pageId: string, mutation: ProgressiveStudyMutation): Promise<ProgressiveStudyReply> {
    return this.enqueue(async () => {
      if (!this.course || !this.deps.storage.study) throw Error('本页作答存储不可用');
      try {
        const reply = await this.deps.storage.study(this.course.projectNoteId, { environmentId: this.course.environmentId,
          courseId: this.course.id, pageId, expectedVersion: this.course.studyPages?.find(page => page.pageId === pageId)?.version || 0, mutation });
        this.receive(reply.course); this.emit(); return reply;
      } catch (error) {
        // An IPC reply can be lost after commit. Refresh this course only, preserving local pending fields.
        try {
          const saved = await this.deps.storage.load(this.course.projectNoteId);
          if (saved?.id === this.course.id && saved.environmentId === this.course.environmentId) { this.receive(saved); this.emit(); }
        } catch { /* Original pending writes remain retryable. */ }
        throw error;
      }
    });
  }
  private async persistStudyDrafts() {
    for (const [pageId, drafts] of [...this.pendingAnswers]) {
      await this.mutateStudy(pageId, { kind: 'draft', drafts });
      if (this.pendingAnswers.get(pageId) === drafts) this.pendingAnswers.delete(pageId);
      this.emit();
    }
  }
  private acceptedSave<T>(promise: Promise<T>): Promise<T> {
    this.attachFlusher(); this.pendingStudySaves.add(promise); this.emit();
    void promise.finally(() => { this.pendingStudySaves.delete(promise); this.emit(); }).catch(() => {});
    return promise;
  }
  private studyOperation(key: string, work: (epoch: number) => Promise<void>): Promise<void> {
    const existing = this.studyOperations.get(key); if (existing) return existing;
    const pageId = key.split(':')[0], epoch = this.studyEpoch;
    this.studyErrors.delete(pageId);
    const run = Promise.resolve().then(() => work(epoch)).catch(error => {
      if (epoch === this.studyEpoch) this.studyErrors.set(pageId, message(error));
    }).finally(() => { this.studyOperations.delete(key); this.emit(); });
    this.studyOperations.set(key, run); this.emit(); return run;
  }
  private busyQuestionIds(pageId: string): string[] {
    return [...new Set([...this.studyOperations.keys()].filter(key => key.startsWith(`${pageId}:`))
      .flatMap(key => key.split(':')[2]?.split(',') || []))];
  }
  private async gradeAttempts(page: ProgressiveLessonPage, study: ProgressivePageStudy, ids: string[], epoch: number) {
    if (epoch !== this.studyEpoch || this.disposed) return;
    const attempts = study.attempts.filter(attempt => ids.includes(attempt.id) && !attempt.judgment);
    if (!attempts.length) return;
    const local = attempts.flatMap(attempt => { const judgment = localProgressiveJudgment(attempt); return judgment ? [{ attemptId: attempt.id, judgment }] : []; });
    if (local.length) await this.mutateStudy(page.id, { kind: 'grade', results: local });
    const semantic = attempts.filter(attempt => !local.some(result => result.attemptId === attempt.id));
    if (!semantic.length || epoch !== this.studyEpoch) return;
    const controller = new AbortController(); this.studyControllers.add(controller);
    try {
      const results = await assessProgressiveAnswers(page, semantic, controller.signal, this.assessmentCall);
      if (epoch !== this.studyEpoch || controller.signal.aborted) return;
      await this.mutateStudy(page.id, { kind: 'grade', results });
    } finally { this.studyControllers.delete(controller); }
  }
  submitAnswers = (questionIds: string[]): Promise<void> => {
    const page = activePage(this.course); if (!page) return Promise.resolve();
    const key = JSON.stringify(questionIds.map(id => [id, this.snapshot.study?.drafts[id]]));
    const intentSlot = `${page.id}:${[...questionIds].sort().join(',')}`;
    const prior = this.submissionIntents.get(intentSlot);
    const submissionId = prior?.key === key ? prior.id : `submit-${crypto.randomUUID()}`;
    this.submissionIntents.set(intentSlot, { key, id: submissionId });
    return this.studyOperation(`${page.id}:submit:${[...questionIds].sort().join(',')}`, async epoch => {
      const saved = await this.acceptedSave((async () => {
        await this.persistStudyDrafts();
        return this.mutateStudy(page.id, { kind: 'submit', submissionId, questionIds });
      })());
      if (this.submissionIntents.get(intentSlot)?.id === submissionId) this.submissionIntents.delete(intentSlot);
      await this.gradeAttempts(page, saved.study, saved.study.attempts.filter(attempt => attempt.submissionId === submissionId).map(attempt => attempt.id), epoch);
    });
  };
  retryGrading = (): Promise<void> => {
    const page = activePage(this.course), study = this.course?.study;
    if (!page || !study) return Promise.resolve();
    const pending = (page.questions || []).filter(question => !this.busyQuestionIds(page.id).includes(question.id)).flatMap(question => {
      const latest = study.attempts.filter(attempt => attempt.questionId === question.id).at(-1);
      return latest && !latest.judgment ? [latest] : [];
    });
    if (!pending.length) return Promise.resolve();
    return this.studyOperation(`${page.id}:grade:${pending.map(attempt => attempt.questionId).join(',')}`,
      epoch => this.gradeAttempts(page, study, pending.map(attempt => attempt.id), epoch));
  };
  private async verifyFeedback(page: ProgressiveLessonPage, study: ProgressivePageStudy, feedbackId: string, epoch: number) {
    const feedback = study.feedback.find(item => item.id === feedbackId);
    if (!feedback || feedback.status !== 'pending' || epoch !== this.studyEpoch || this.disposed) return;
    const controller = new AbortController(); this.studyControllers.add(controller);
    try {
      const result = await verifyProgressiveFeedback(page, feedback, study.attempts.find(attempt => attempt.id === feedback.attemptId), controller.signal, this.assessmentCall);
      if (epoch !== this.studyEpoch || controller.signal.aborted) return;
      await this.mutateStudy(page.id, { kind: 'verify-feedback', feedbackId, ...result });
    } finally { this.studyControllers.delete(controller); }
  }
  sendFeedback = (questionId: string, category: 'question' | 'answer' | 'grading', text: string): Promise<void> => {
    const page = activePage(this.course); if (!page) return Promise.resolve();
    const key = JSON.stringify([page.id, questionId, category, text]);
    const feedbackId = this.feedbackIntents.get(key) || `feedback-${crypto.randomUUID()}`;
    this.feedbackIntents.set(key, feedbackId);
    return this.studyOperation(`${page.id}:feedback:${questionId}`, async epoch => {
      const attemptId = this.course?.study?.attempts.filter(attempt => attempt.questionId === questionId).at(-1)?.id;
      const saved = await this.acceptedSave(this.mutateStudy(page.id, { kind: 'feedback', feedback: { id: feedbackId, questionId, category, text, ...(attemptId ? { attemptId } : {}) } }));
      this.feedbackIntents.delete(key);
      await this.verifyFeedback(page, saved.study, feedbackId, epoch);
    });
  };
  retryFeedback = (feedbackId: string): Promise<void> => {
    const page = activePage(this.course), study = this.course?.study;
    const questionId = study?.feedback.find(item => item.id === feedbackId)?.questionId;
    return page && study && questionId ? this.studyOperation(`${page.id}:feedback:${questionId}`, epoch => this.verifyFeedback(page, study, feedbackId, epoch)) : Promise.resolve();
  };

  private persistCheckpoint(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.lease || !this.course || published(this.course) || this.generationVersion <= this.savedGenerationVersion) return;
      const version = this.generationVersion;
      const checkpoint: ProgressiveCheckpoint = { sequence: this.course.generation.sequence + 1,
        rawDraft: this.raw, bodyDraft: this.body, ...(this.plan ? { plan: this.plan } : {}) };
      const result = await this.deps.storage.checkpoint(this.lease, checkpoint);
      this.receive(result); this.savedGenerationVersion = version; this.emit({ saveError: null });
    });
  }

  private persistProgress(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.course || this.progressVersion <= this.savedProgressVersion) return;
      for(let retry=0;retry<2;retry++){
        const version=this.progressVersion,patch={...this.progressPatch};
        try{
          const result=await this.deps.storage.saveProgress(this.course.projectNoteId,{environmentId:this.course.environmentId,courseId:this.course.id,expectedProgressVersion:this.course.progress.version,patch});
          this.savedProgressVersion=version;if(this.progressVersion===version)this.progressPatch={};
          if((result.lastSuccessfulReview?.reviewId||null)!==this.archiveId)await this.reconcileReview(result);else this.receive(result);
          this.emit({saveError:null});return;
        }catch(error){
          if(retry||!this.deps.storage.readReview)throw error;
          const fresh=await this.deps.storage.load(this.input.note.id);
          if(!fresh||fresh.id!==this.course.id||fresh.environmentId!==this.course.environmentId||(fresh.lastSuccessfulReview?.reviewId||null)===this.archiveId)throw error;
          await this.reconcileReview(fresh);
        }
      }
    });
  }

  private persistPublication(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.publication || !this.lease || !this.course) return;
      const publication = this.publication;
      const result = await this.deps.storage.publish(this.lease, {
        ...publication, sequence: this.course.generation.sequence + 1,
      });
      this.receive(result);
      this.publication = null; this.lease = null;
      this.savedGenerationVersion = this.generationVersion;
      this.interrupted = false;
      this.timings.pageSavedMs = this.started ? performance.now() - this.started : null;
      this.emit({ phase: 'ready', error: null, saveError: null });
    });
  }

  private persistInterruption(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.interrupted || !this.lease || !this.course || this.publication) return;
      const result = await this.deps.storage.interrupt(this.lease, this.interruptionError);
      this.receive(result); this.lease = null; this.interrupted = false;
      this.emit({ saveError: null });
    });
  }

  flush = async (): Promise<void> => {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    // A configuration/load error without a created course cannot trap the user on exit.
    if (!this.course && !this.generationVersion && !this.progressVersion) return;
    try {
      if (!this.course && this.progressVersion > this.savedProgressVersion) {
        await this.courseWaiter?.promise;
        if (!this.course) throw new Error('课程尚未载入，草稿已保留，请重新尝试保存。');
      }
      await this.persistCheckpoint();
      await this.persistProgress();
      await this.persistStudyDrafts();
      await this.persistPublication();
      await this.persistInterruption();
      await Promise.all([...this.pendingStudySaves]);
      await this.persistStudyDrafts();
      if (this.generationVersion > this.savedGenerationVersion || this.progressVersion > this.savedProgressVersion) {
        await this.persistCheckpoint();
        await this.persistProgress();
      }
      this.emit({ saveError: null });
    } catch (error) { this.emit({ saveError: message(error) }); throw error; }
  };

  next = (intent: 'mainline' | 'expansion' | 'auto' = 'auto', scope?: ProgressiveSupplementScope): Promise<void> => {
    if (!this.deps.storage.next || !published(this.course) || this.run) return this.run || Promise.resolve();
    return this.runGeneration(false, intent === 'auto' && !this.deps.storage.route ? 'mainline' : intent, scope);
  };
  navigate = async (pageId: string): Promise<void> => {
    if (!this.course || !published(this.course) || this.run || pageId === this.course.progress.currentPageId) return;
    await this.flush();
    this.saveProgress({ currentPageId: pageId, scrollTop: 0 });
    await this.flush();
    this.hydrate(this.course!); this.emit({ phase: 'ready' });
  };

  start = (): Promise<void> => this.runGeneration(false);
  retry = async (): Promise<void> => {
    // Navigation can be cancelled after stop() persisted the draft but before
    // an abort-insensitive provider has returned. Never reuse that aborted run.
    const previous = this.run;
    if (previous && this.abort?.signal.aborted) {
      this.emit({ phase: 'loading', error: null });
      await previous;
    }
    // Publication IO retries must not pay for the same complete page again.
    if (this.publication || this.snapshot.saveError) {
      await this.flush();
      if (published(this.course)) return;
    }
    return this.runGeneration(true);
  };

  private runGeneration(resume: boolean, intent?: 'mainline' | 'expansion' | 'auto', scope?: ProgressiveSupplementScope): Promise<void> {
    if (this.run) {
      const previous = this.run;
      return this.abort?.signal.aborted ? previous.then(() => this.runGeneration(resume, intent, scope)) : previous;
    }
    if (this.disposed) return Promise.resolve();
    this.attachFlusher();
    if (this.poll) { clearTimeout(this.poll); this.poll = null; }
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.started = performance.now();
    this.timings = { startedAt: new Date().toISOString(), preparationMs: null, firstTokenMs: null,
      firstReadableMs: null, pageCompleteMs: null, pageSavedMs: null };
    if (!this.course) {
      let resolve!: () => void;
      const promise = new Promise<void>(done => { resolve = done; });
      this.courseWaiter = { promise, resolve };
    }
    const run = this.execute(resume, signal, intent, scope).catch(async error => {
      this.courseWaiter?.resolve();
      const aborted = signal.aborted || (error instanceof DOMException && error.name === 'AbortError');
      this.interrupted = Boolean(this.lease);
      this.interruptionError = aborted ? undefined : message(error);
      this.emit({ phase: aborted ? 'interrupted' : 'error', error: aborted ? null : message(error) });
      try { await this.flush(); } catch { /* The dirty snapshot and valid lease remain retryable. */ }
    }).finally(() => {
      if (this.run === run) {
        this.courseWaiter?.resolve(); this.courseWaiter = null;
        try { this.reader?.releaseLock(); } catch { /* A cancelled provider may already have released it. */ }
        this.run = null; this.reader = null;
      }
    });
    this.run = run;
    return run;
  }

  private async execute(resume: boolean, signal: AbortSignal, intent?: 'mainline' | 'expansion' | 'auto', scope?: ProgressiveSupplementScope): Promise<void> {
    this.emit({ phase: 'loading', error: null });
    if (this.course && this.snapshot.isDirty) await this.flush();
    const loaded = await this.deps.storage.load(this.input.note.id);
    signal.throwIfAborted();
    if (loaded) {
      this.hydrate(loaded);
      if (!intent && published(loaded)) { this.emit({ phase: 'ready', error: null, saveError: null }); return; }
      if (!intent && !resume && !recoverPublication(loaded)
        && (loaded.generation.bodyDraft || ['interrupted', 'failed'].includes(loaded.generation.status))) {
        this.emit({ phase: 'interrupted', error: loaded.generation.error || null }); return;
      }
    }
    const currentTarget=loaded?.plan?.pages[activePage(loaded)?.mainlineIndex||0];
    const target = intent === 'mainline'||intent==='auto' ? loaded?.plan?.pages.find(page => !loaded.pages?.some(saved => saved.id === page.id))||currentTarget : currentTarget;
    const focus = target ? [target.title,...target.objectives,...(intent==='expansion'&&scope?[scope.text.slice(0,400)]:[])].join('\n').slice(0, 1400) : undefined;
    let sources = loaded && !intent ? loaded.sourcePackets : await this.deps.loadMaterials(this.input.note, this.input.allNotes, focus,signal);
    if(intent==='auto'&&currentTarget&&target!==currentTarget){
      signal.throwIfAborted();
      const secondary=await this.deps.loadMaterials(this.input.note,this.input.allNotes,[currentTarget.title,...currentTarget.objectives].join('\n').slice(0,1400),signal);
      sources=mergeProgressiveMaterials(sources,secondary);
    }
    signal.throwIfAborted();
    // Material loading yields while scroll/restatement autosaves keep running.
    // Private progress has its own version. Flush it for recovery, then reserve
    // generation in the same queue using the teaching revision. Actual content
    // changes during material loading must still invalidate this preparation.
    if (intent) await this.flush();
    const previous = activePage(loaded);
    const reply = await this.enqueue(async () => {
      signal.throwIfAborted();
      const current = this.course;
      if (intent && loaded && (!current || current.id !== loaded.id || current.environmentId !== loaded.environmentId)) {
        throw new Error('课程环境已变化，请重新进入后继续。');
      }
      if (intent && loaded && current && (current.generation.requestId !== loaded.generation.requestId
        || JSON.stringify(current.plan) !== JSON.stringify(loaded.plan)
        || JSON.stringify(current.pages?.map(page => [page.id, page.contentHash])) !== JSON.stringify(loaded.pages?.map(page => [page.id, page.contentHash])))) {
        throw new Error('教材内容已变化，请重新读取后继续。');
      }
      const result = intent && loaded && current
        ? await this.deps.storage.next!(this.input.note.id, { environmentId: current.environmentId, courseId: current.id,
          expectedRevision: current.revision, requestId: `request-${crypto.randomUUID()}`, intent,
          fromPageId: loaded.progress.currentPageId || loaded.generation.pageId, sourcePackets: sources, ...(scope ? { scope } : {}) })
        : await this.deps.storage.begin(this.input.note.id, sources);
      // Publish the reservation before a queued autosave can write against it.
      this.hydrate(result.course); this.lease = result.lease || null;
      return result;
    });
    if (signal.aborted) { this.interrupted = Boolean(this.lease); await this.flush(); return; }
    if (published(reply.course)) { this.emit({ phase: 'ready', saveError: null }); return; }
    if (!this.lease) {
      if (reply.running) { this.emit({ phase: 'generating', error: null }); this.watchExisting(); return; }
      throw new Error('课程任务尚未取得执行许可，请重新进入。');
    }
    const recovered = recoverPublication(reply.course);
    if (recovered) {
      this.publication = recovered;
      this.emit({ phase: 'saving', error: null });
      await this.flush();
      return;
    }
    this.emit({ phase: 'generating', error: null, saveError: null });
    this.timings.preparationMs = performance.now() - this.started;
    const parser = new ProgressiveStreamParser({ plan: this.plan, body: this.body,
      maxMainlinePages: reply.course.budget.maxMainlinePages });
    const stream = await this.deps.stream(reply.course, signal, {
      ...progressiveGoalContext(this.input.note, this.input.allNotes),
      previousTeaching: reply.course.generation.previousTeaching || (previous ? { title: previous.title, excerpt: previous.body.slice(-2500) } : undefined),
    });
    signal.throwIfAborted();
    this.reader = stream.getReader();
    let finishReason: string | undefined;
    while (true) {
      const next = await this.reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      if (next.value.type === 'diagnostics') { finishReason = next.value.diagnostics?.finishReason; continue; }
      if (next.value.type !== 'content' || !next.value.text) continue;
      if (this.timings.firstTokenMs === null) this.timings.firstTokenMs = performance.now() - this.started;
      if (parser.raw.length + next.value.text.length > PROGRESSIVE_MAX_RAW) {
        throw new Error('本页响应超过保存上限，已保留此前可读内容。');
      }
      this.raw = parser.raw + next.value.text;
      this.generationVersion++;
      const previousPlan = this.plan;
      const parsed = parser.append(next.value.text);
      if (parsed.route && this.course?.generation.routePending) {
        if (!this.deps.storage.route || !this.lease) throw Error('下一页编排存储不可用');
        const reply = await this.enqueue(async () => {
          const lease = this.lease!;
          try { return await this.deps.storage.route!(lease, parsed.route!); }
          catch (error) {
            // Rebinding retains the lease token. A lost ACK must not leave the renderer on the provisional page ID.
            const saved = await this.deps.storage.load(lease.projectNoteId).catch(() => null);
            if (saved?.environmentId === lease.environmentId && saved.id === lease.courseId
              && saved.generation.requestId === lease.requestId && !saved.generation.routePending
              && saved.generation.route?.kind === parsed.route!.kind) {
              return { course: saved, running: saved.generation.status !== 'ready',
                ...(saved.generation.status !== 'ready' ? { lease: { ...lease, pageId: saved.generation.pageId } } : {}) };
            }
            throw error;
          }
        });
        this.receive(reply.course); this.lease = reply.lease || null;
        signal.throwIfAborted();
        if (parsed.route.kind === 'finish') {
          this.hydrate(reply.course); this.emit({ phase: 'ready', error: null });
          void this.reader.cancel().catch(() => {}); return;
        }
      }
      this.plan = parsed.plan; this.body = parsed.body; this.hook = parsed.hook;
      const prose = this.body.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/gu, '')
        .replace(/^\s*#{1,6}\s.*$/gmu, '').replace(/[\s`#$*>_]/gu, '');
      if (this.timings.firstReadableMs === null && prose.length >= 24) this.timings.firstReadableMs = performance.now() - this.started;
      this.emit();
      // Persist the mainline as soon as it is complete, before relying on later output.
      if (!previousPlan && this.plan) await this.persistCheckpoint();
      else this.schedule();
    }
    const finished = parser.finish({ finishReason });
    this.raw = parser.raw;
    this.timings.pageCompleteMs = performance.now() - this.started;
    this.plan = finished.plan; this.body = finished.body; this.hook = finished.hook;
    const knownSources = new Set(reply.course.sourcePackets.map(source => source.id));
    for (const marker of this.body.matchAll(/\[(S\d+)\]/gu)) {
      if (!knownSources.has(marker[1])) throw new Error('正文包含未提供的资料引用，已保留草稿。');
    }
    this.generationVersion++;
    this.publication = { plan: finished.plan!, title: this.course!.generation.kind === 'expansion' ? `${finished.plan!.pages[this.course!.generation.mainlineIndex || 0].title} · 补充讲解` : finished.plan!.pages[this.course!.generation.mainlineIndex || 0].title,
      body: finished.body, hook: finished.hook!, ...(finished.concepts ? { concepts: finished.concepts } : {}),
      ...(finished.questions?.length ? { questions: finished.questions } : {}) };
    this.emit({ phase: 'saving' });
    await this.flush();
  }

  private watchExisting() {
    this.poll = setTimeout(async () => {
      this.poll = null;
      if (this.disposed) return;
      try {
        const course = await this.deps.storage.load(this.input.note.id);
        if (!course) throw new Error('正在执行的课程已不可读取，请重新进入。');
        if (this.course && course.environmentId !== this.course.environmentId) throw new Error('资料库已变化，请重新进入课程。');
        this.hydrate(course);
        if (published(course)) this.emit({ phase: 'ready', error: null });
        else if (course.generation.status !== 'generating') this.emit({ phase: 'interrupted', error: course.generation.error || null });
        else { this.emit({ phase: 'generating' }); this.watchExisting(); }
      } catch (error) { this.emit({ phase: 'error', error: message(error) }); }
    }, 1000);
  }

  stop = async (): Promise<void> => {
    this.studyEpoch++;
    for (const controller of this.studyControllers) controller.abort();
    if (this.poll) { clearTimeout(this.poll); this.poll = null; }
    this.abort?.abort();
    void this.reader?.cancel().catch(() => {});
    this.interrupted = Boolean(this.lease && !this.publication);
    await this.flush();
    if (!published(this.course) && this.course) this.emit({ phase: 'interrupted' });
  };

  dispose = (): void => {
    this.studyEpoch++;
    for (const controller of this.studyControllers) controller.abort();
    this.disposed = true;
    this.detachReview?.();this.detachReview=null;
    if (this.timer) clearTimeout(this.timer);
    if (this.poll) clearTimeout(this.poll);
    this.abort?.abort();
    void this.reader?.cancel().catch(() => {});
    this.listeners.clear();
    // Keep this persistence participant registered when a save is still dirty.
    if (!this.snapshot.isDirty) this.detachFlusher();
    else void this.flush().then(() => this.detachFlusher(), () => {});
  };
}

/** Each attachment loads the desktop authority anew; no cross-vault project-ID cache. */
export function createProgressiveController(input: { note: NoteItem; allNotes: NoteItem[] }, options: ProgressiveRuntimeOptions = {}): ProgressiveController {
  return new ProgressiveRuntime(input, options);
}
export const getProgressiveController = createProgressiveController;
