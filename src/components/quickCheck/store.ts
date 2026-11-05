import type { NoteItem } from '../../types';
import { masteryShadowCriterion } from '../../services/masteryShadow/rubric';
import {
  generateQuickCheck, evaluateQuickCheck, quickCheckSourceKey, quickCheckMasteryKey,
  type QuickCheckLaunchRequest, type QuickCheckSession, type QuickCheckAnswer,
  type QuickCheckAssessment, type QuickCheckResult, type QuickCheckHistoryItem,
} from '../../services/quickCheck';
import { appendQuickCheckHistory } from '../../services/quickCheck/history';
import { validQuickCheckDesign, validQuickCheckHistory } from '../../services/quickCheck/planning';

export type QuickCheckPhase = 'generating' | 'ready' | 'evaluating' | 'saving' | 'result' | 'error';
export interface QuickCheckDraft {
  request: QuickCheckLaunchRequest;
  session?: QuickCheckSession;
  answers: QuickCheckAnswer[];
  step: number;
  phase: QuickCheckPhase;
  assisted: boolean;
  formulaDraft?: string;
  cacheNotice?: string;
  /** Recent stems only; never include answer keys, options or assessments. */
  previousQuestions?: string[];
  /** Bounded scene/task summaries and verified gaps; never full answers/keys. */
  recentQuestions?: QuickCheckHistoryItem[];
  stale?: boolean;
  pendingRetake?: boolean;
  refreshConfirmation?: boolean;
  refreshCriterionIds?: QuickCheckLaunchRequest['criterionIds'];
  assessment?: QuickCheckAssessment;
  result?: QuickCheckResult;
  error?: string;
  errorStage?: 'generate' | 'evaluate' | 'save' | 'source';
}
export interface QuickCheckSnapshot { open: boolean; draft: QuickCheckDraft | null }
export interface QuickCheckController { open(request: QuickCheckLaunchRequest): boolean }
export interface QuickCheckRuntime {
  notes: NoteItem[];
  /** Save callbacks may open the card before React commits the new notes prop. */
  getNotes?: () => NoteItem[];
  canOpen?: () => boolean;
  onCommit: (session: QuickCheckSession, assessment: QuickCheckAssessment) => Promise<QuickCheckResult>;
}
export interface QuickCheckStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
export interface QuickCheckAdapters {
  generate: typeof generateQuickCheck;
  evaluate: typeof evaluateQuickCheck;
  sourceKey: typeof quickCheckSourceKey;
  masteryKey: typeof quickCheckMasteryKey;
}
const defaults: QuickCheckAdapters = {
  generate: generateQuickCheck, evaluate: evaluateQuickCheck,
  sourceKey: quickCheckSourceKey, masteryKey: quickCheckMasteryKey,
};
const isBusy = (draft: QuickCheckDraft | null) => draft?.phase === 'evaluating' || draft?.phase === 'saving';
export const hasQuickCheckAnswer = (draft: QuickCheckDraft) => Boolean(draft.formulaDraft?.trim())
  || draft.answers.some(answer => Boolean(answer.text?.trim() || answer.optionId || answer.skipped));
const cacheKey = (scope: string) => `loginote:quick-check:v1:${scope}`;
const message = (error: unknown) => error instanceof Error ? error.message : '简测暂时未完成，请重试。';
const previousQuestionStems = (draft: QuickCheckDraft) => [...new Set([
  ...(draft.previousQuestions || []), ...(draft.session?.questions.map(question => question.prompt) || []),
].reverse())].reverse().slice(-6);
const recentTasks = (draft: QuickCheckDraft) => appendQuickCheckHistory(draft.recentQuestions, draft.session, draft.assessment);
const object = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const string = (value: unknown): value is string => typeof value === 'string';
const criterionIds = (value: unknown) => Array.isArray(value) && value.length > 0 && value.length <= 3
  && value.every(id => string(id) && Boolean(masteryShadowCriterion(id))) && new Set(value).size === value.length;
function validCachedDraft(value: unknown): value is QuickCheckDraft {
  if (!object(value) || !object(value.request) || !string(value.request.noteId)
    || value.pendingRetake != null && typeof value.pendingRetake !== 'boolean'
    || value.formulaDraft != null && (!string(value.formulaDraft) || value.formulaDraft.length > 4000)
    || value.cacheNotice != null && (!string(value.cacheNotice) || value.cacheNotice.length > 1000)
    || value.previousQuestions != null && (!Array.isArray(value.previousQuestions) || value.previousQuestions.length > 6
      || value.previousQuestions.some(question => !string(question) || !question.trim() || question.length > 800))
    || value.recentQuestions != null && !validQuickCheckHistory(value.recentQuestions)
    || value.request.source != null && !string(value.request.source)
    || value.request.criterionIds != null && !(Array.isArray(value.request.criterionIds)
      && (value.request.criterionIds.length === 0 || criterionIds(value.request.criterionIds)))
    || !object(value.session) || !Array.isArray(value.answers) || value.answers.length > 3 || typeof value.assisted !== 'boolean') return false;
  const session = value.session;
  if (session.version !== 1 || session.noteId !== value.request.noteId
    || !['id', 'noteTitle', 'sourceKey', 'masteryKey', 'createdAt', 'contractKey'].every(field => string(session[field]))
    || !Array.isArray(session.targets) || !session.targets.length || session.targets.length > 3
    || session.targets.some(target => !object(target) || !masteryShadowCriterion(target.id) || !string(target.label)
      || !['concept', 'judgment', 'reasoning'].includes(target.layer)
      || !['unassessed', 'provisional', 'confirmed', 'needs_review'].includes(target.state))
    || session.uncoveredCriterionIds != null && (!criterionIds(session.uncoveredCriterionIds)
      || session.uncoveredCriterionIds.some((id: string) => session.targets.some((target: { id: string }) => target.id === id)))
    || !Array.isArray(session.references) || !session.references.length || session.references.length > 30
    || session.references.some(ref => !object(ref) || !string(ref.id) || !string(ref.sourceLabel) || !string(ref.quote)
      || ![1, 2, 3, 4].includes(ref.tier))
    || !Array.isArray(session.questions) || session.questions.length !== 3) return false;
  for (const [index, q] of session.questions.entries()) {
    if (!object(q) || q.id !== `Q${index + 1}` || !string(q.prompt) || !q.prompt.trim() || q.prompt.length > 800
      || q.design != null && !validQuickCheckDesign(q.design)
      || !criterionIds(q.criterionIds) || q.criterionIds.some((id: string) => !session.targets.some((target: { id: string }) => target.id === id))
      || !Array.isArray(q.referenceIds) || !q.referenceIds.length || q.referenceIds.some(id => !string(id) || !session.references.some((ref: { id: string }) => ref.id === id))
      || !object(q.privateAnswer) || !string(q.privateAnswer.explanation) || !Array.isArray(q.privateAnswer.referenceQuotes)
      || !q.privateAnswer.referenceQuotes.length || q.privateAnswer.referenceQuotes.some((ref: unknown) => !object(ref) || !string(ref.referenceId) || !string(ref.quote))) return false;
    if (index === 0) { if (!['open', 'application', 'calculation', 'proof'].includes(q.type)) return false; }
    else if (!['choice', 'true_false'].includes(q.type) || !Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4
      || q.options.some((option: unknown) => !object(option) || !string(option.id) || !string(option.text))
      || new Set(q.options.map((option: { id: string }) => option.id)).size !== q.options.length
      || !q.options.some((option: { id: string }) => option.id === q.privateAnswer.optionId)) return false;
  }
  if (new Set(value.answers.map(answer => answer?.questionId)).size !== value.answers.length
    || value.answers.some(answer => !object(answer) || !session.questions.some((q: { id: string }) => q.id === answer.questionId)
      || answer.text != null && (!string(answer.text) || answer.text.length > 12000)
      || answer.assisted != null && typeof answer.assisted !== 'boolean'
      || answer.skipped != null && typeof answer.skipped !== 'boolean'
      || answer.optionId != null && (!string(answer.optionId) || !session.questions.find((q: { id: string }) => q.id === answer.questionId)?.options?.some((option: { id: string }) => option.id === answer.optionId)))) return false;
  if (value.assessment != null && (!object(value.assessment) || value.assessment.version !== 1
    || value.assessment.sessionId !== session.id || !string(value.assessment.attemptId)
    || !object(value.assessment.input) || !object(value.assessment.evaluation) || !Array.isArray(value.assessment.answers))) return false;
  if (value.assessment?.questionEvaluations != null && (!Array.isArray(value.assessment.questionEvaluations)
    || value.assessment.questionEvaluations.length > 3
    || new Set(value.assessment.questionEvaluations.map((row: any) => row?.questionId)).size !== value.assessment.questionEvaluations.length
    || value.assessment.questionEvaluations.some((row: any) => !object(row) || !session.questions.some((question: any) => question.id === row.questionId)
      || !object(row.evaluation) || row.evaluation.evaluationId !== `${value.assessment.attemptId}:${row.questionId}`))) return false;
  if (value.result != null && (!object(value.result) || !string(value.result.headline) || !string(value.result.nextAction)
    || typeof value.result.changed !== 'boolean' || !Array.isArray(value.result.remaining) || !value.result.remaining.every(string)
    || !Array.isArray(value.result.details) || value.result.details.some((detail: unknown) => !object(detail)
      || !['questionId', 'prompt', 'answer', 'explanation'].every(field => string(detail[field]))
      || detail.referenceAnswer != null && !string(detail.referenceAnswer)))) return false;
  return true;
}

/** One store for all entry points. Drafts are scoped to the active vault, never
 * expire by time, and are only replaced after completion or substantive change. */
export class QuickCheckStore implements QuickCheckController {
  private runtime: QuickCheckRuntime;
  private drafts = new Map<string, QuickCheckDraft>();
  private snapshot: QuickCheckSnapshot = { open: false, draft: null };
  private listeners = new Set<() => void>();
  private operation = 0;
  private generations = new Map<string, symbol>();
  private disposed = false;
  private adapters: QuickCheckAdapters;
  constructor(runtime: QuickCheckRuntime, private storageScope?: string,
    private storage?: QuickCheckStorage, adapters: Partial<QuickCheckAdapters> = {}) {
    this.runtime = runtime;
    this.adapters = { ...defaults, ...adapters };
    this.restore();
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  setRuntime(runtime: QuickCheckRuntime) { this.runtime = runtime; }
  activate() {
    const interrupted = this.disposed && this.snapshot.draft
      && ['generating', 'evaluating', 'saving'].includes(this.snapshot.draft.phase);
    this.disposed = false;
    if (interrupted) this.emit({ ...this.snapshot.draft!, phase: 'error',
      error: '简测已暂停，题目和作答已保留。请重试继续。', errorStage: this.snapshot.draft?.pendingRetake ? 'generate' : this.snapshot.draft?.assessment ? 'save' : this.snapshot.draft?.session ? 'evaluate' : 'generate' });
  }
  /** Commit-phase cleanup, including StrictMode effect replay. Pending model
   * continuations can no longer persist drafts or start a commit after cleanup. */
  dispose() { this.disposed = true; this.operation++; this.generations.clear(); }
  private emit(draft: QuickCheckDraft | null, open = this.snapshot.open, publish = true) {
    if (this.disposed) return;
    if (draft) {
      this.drafts.delete(draft.request.noteId);
      this.drafts.set(draft.request.noteId, draft);
      while (this.drafts.size > 8) {
        const disposable = [...this.drafts.values()].find(item => item.request.noteId !== draft.request.noteId
          && (publish || item.request.noteId !== this.snapshot.draft?.request.noteId) && !this.generations.has(item.request.noteId)
          && (item.result || !hasQuickCheckAnswer(item)));
        if (!disposable) break;
        this.drafts.delete(disposable.request.noteId);
      }
    }
    if (publish) this.snapshot = { open, draft };
    const cacheNotice = this.persist();
    if (cacheNotice && draft) {
      draft = { ...draft, cacheNotice };
      if (publish) this.snapshot = { open, draft };
      this.drafts.set(draft.request.noteId, draft);
    }
    this.listeners.forEach(listener => listener());
  }
  private persist(): string | undefined {
    if (!this.storageScope || !this.storage) return;
    // Bound sensitive cached text; keep the active draft and the newest sessions.
    let entries = [...this.drafts.values()].filter(draft => draft.session);
    let data = JSON.stringify({ version: 1, entries });
    while (data.length > 1_000_000 && entries.length > 1) {
      const index = entries.findIndex(draft => draft.result || !hasQuickCheckAnswer(draft));
      if (index < 0) break;
      entries = entries.filter((_, entryIndex) => index !== entryIndex);
      data = JSON.stringify({ version: 1, entries });
    }
    const warning = '草稿缓存空间不足，本次作答暂保留在当前窗口。请先完成已有简测，关闭应用前不要留下未保存的作答。';
    // Never overwrite a persisted unfinished answer merely to fit a newer card.
    if (data.length > 1_000_000) return warning;
    try {
      this.storage.setItem(cacheKey(this.storageScope), data);
      if (this.snapshot.draft?.session && !entries.some(entry => entry.request.noteId === this.snapshot.draft!.request.noteId)) return warning;
    } catch { return warning; }
  }
  private restore() {
    if (!this.storageScope || !this.storage) return;
    try {
      const raw = this.storage.getItem(cacheKey(this.storageScope));
      if (!raw || raw.length > 1_000_000) return;
      const saved = JSON.parse(raw);
      if (saved.version !== 1 || !Array.isArray(saved.entries)) return;
      for (const value of saved.entries.slice(-8)) {
        if (!validCachedDraft(value)) continue;
        // A process restart never invents a successful save. Preserve the exact
        // assessment so retry does not produce a new observation identity.
        const phase = value.pendingRetake ? 'error' : value.result ? 'result' : value.assessment ? 'error' : 'ready';
        const firstMissing = value.session!.questions.findIndex(question => !value.answers.some(answer => answer.questionId === question.id
          && (answer.skipped || answer.text?.trim() || answer.optionId)));
        const cachedStep = Math.floor(Math.max(0, Math.min(2, Number(value.step) || 0)));
        this.drafts.set(value.request.noteId, { ...value, phase, refreshConfirmation: false, refreshCriterionIds: undefined,
          step: value.formulaDraft?.trim() || value.answers.some(answer => (answer.text?.length || 0) > 4000) ? 0
            : firstMissing !== -1 && firstMissing < cachedStep ? firstMissing : cachedStep,
          errorStage: value.pendingRetake ? 'generate' : value.errorStage,
          error: value.pendingRetake ? '出题已暂停，跳过题已保留，请重试继续。' : value.assessment && !value.result ? '上次评价尚未确认保存，可重试保存。' : undefined });
      }
    } catch { /* A corrupt cache cannot prevent opening the application. */ }
  }
  private note(id: string) { return (this.runtime.getNotes?.() ?? this.runtime.notes).find(note => note.id === id && note.noteType === 'knowledge'); }
  private changed(draft: QuickCheckDraft, note: NoteItem) {
    return Boolean(draft.session && (draft.session.sourceKey !== this.adapters.sourceKey(note)
      || draft.session.masteryKey !== this.adapters.masteryKey(note)));
  }
  open = (request: QuickCheckLaunchRequest): boolean => {
    if (this.disposed || this.runtime.canOpen?.() === false || isBusy(this.snapshot.draft)) return false;
    const note = this.note(request.noteId);
    if (!note) return false;
    const regenerate = request.regenerate === true;
    request = { noteId: request.noteId, source: request.source, criterionIds: request.criterionIds };
    if (!this.drafts.has(note.id) && [...this.drafts.values()].filter(draft => !draft.result
      && (hasQuickCheckAnswer(draft) || this.generations.has(draft.request.noteId))).length >= 8) {
      const retained = (draft: QuickCheckDraft) => !draft.result && (hasQuickCheckAnswer(draft) || this.generations.has(draft.request.noteId));
      const existing = this.snapshot.draft && retained(this.snapshot.draft)
        ? this.snapshot.draft : [...this.drafts.values()].find(retained)!;
      this.emit({ ...existing, cacheNotice: '已保留 8 张未完成的简测。请先完成其中一张，或等待正在出题的卡片完成；已有作答不会被替换。' }, true);
      return false;
    }
    const generating = this.drafts.get(note.id);
    if (generating?.phase === 'generating' && this.generations.has(note.id)) {
      this.emit(generating, true); return true;
    }
    // Evaluation/save belongs to the active card. Generation has its own
    // per-note identity and continues when another card is displayed.
    if (this.snapshot.draft?.request.noteId !== note.id) this.operation++;
    let draft = this.drafts.get(note.id);
    if (draft?.phase === 'error' && !regenerate) {
      this.emit(draft, true); return true;
    }
    let previousQuestions = draft?.previousQuestions;
    let recentQuestions = draft?.recentQuestions;
    if (draft?.session && !draft.result && !draft.pendingRetake && !regenerate && this.changed(draft, note)) {
      if (hasQuickCheckAnswer(draft)) draft = { ...draft, stale: true };
      else { previousQuestions = previousQuestionStems(draft); recentQuestions = recentTasks(draft); draft = undefined; }
    }
    if (draft?.session) {
      this.emit(draft, true);
      if (regenerate) this.refresh(request.criterionIds);
      else if (draft.phase === 'generating') void this.generate();
    }
    else {
      this.emit(draft?.phase === 'generating' ? draft
        : { request, answers: [], step: 0, phase: 'generating', assisted: false, previousQuestions, recentQuestions }, true);
      void this.generate();
    }
    return true;
  };
  close = () => { if (!isBusy(this.snapshot.draft)) this.emit(this.snapshot.draft, false); };
  reconcileNotes() {
    const draft = this.snapshot.draft;
    if (!draft?.session || draft.result || draft.pendingRetake || draft.phase === 'generating' || isBusy(draft)) return;
    const note = this.note(draft.request.noteId);
    if (!note || !this.changed(draft, note)) return;
    if (hasQuickCheckAnswer(draft)) { if (!draft.stale) this.emit({ ...draft, stale: true }); }
    else if (this.snapshot.open) { this.emit({ request: draft.request, answers: [], step: 0, phase: 'generating', assisted: false,
      previousQuestions: previousQuestionStems(draft), recentQuestions: recentTasks(draft) }); void this.generate(); }
    // Keep the old card while hidden. The next explicit open validates its keys
    // and carries forward its short task history, without a background model request.
  }
  private async generate() {
    const draft = this.snapshot.draft;
    if (!draft || isBusy(draft) || this.generations.has(draft.request.noteId)) return;
    const note = this.note(draft.request.noteId);
    if (!note) { this.emit({ ...draft, phase: 'error', error: '该知识点已不存在。' }); return; }
    const operation = Symbol(note.id);
    this.generations.set(note.id, operation);
    const current = () => !this.disposed && this.generations.get(note.id) === operation;
    const finish = (next: QuickCheckDraft) => this.emit(next, this.snapshot.open, this.snapshot.draft?.request.noteId === note.id);
    try {
      const session = await this.adapters.generate({ note, requestedCriterionIds: draft.request.criterionIds, source: draft.request.source,
        previousQuestions: draft.previousQuestions,
        recentQuestions: draft.recentQuestions,
        ...(draft.pendingRetake && draft.session ? { reuseSkipped: { session: draft.session, answers: draft.answers } } : {}) });
      if (!current()) return;
      // Notes can change while the model is generating. Do not present an old
      // card as fresh, and do not start repeated background generation loops.
      const latest = this.note(note.id);
      if (!latest || session.sourceKey !== this.adapters.sourceKey(latest) || session.masteryKey !== this.adapters.masteryKey(latest)) {
        finish({ ...draft, phase: 'error', errorStage: 'generate', error: '资料或掌握情况已变化，请按最新情况重新出题。' }); return;
      }
      const assisted = Boolean(draft.pendingRetake && draft.assisted && draft.session?.questions.some(question =>
        draft.answers.some(answer => answer.questionId === question.id && answer.skipped)
          && session.questions.some(next => JSON.stringify(next) === JSON.stringify(question))));
      finish({ ...draft, session, answers: [], step: 0, phase: 'ready', error: undefined, errorStage: undefined, stale: false,
        pendingRetake: false, refreshConfirmation: false, formulaDraft: undefined, assessment: undefined, result: undefined, assisted });
    } catch (error) {
      if (current()) finish({ ...draft, phase: 'error', errorStage: 'generate', error: message(error) });
    } finally {
      if (this.generations.get(note.id) === operation) this.generations.delete(note.id);
    }
  }
  answer(answer: QuickCheckAnswer) {
    const draft = this.snapshot.draft;
    if (!draft?.session || draft.phase !== 'ready' || draft.refreshConfirmation) return;
    const question = draft.session.questions[draft.step];
    if (!question || answer.questionId !== question.id) return;
    // Opening choice questions permanently locks the earlier open response.
    const updated = { ...answer, assisted: draft.assisted || answer.assisted || false };
    this.emit({ ...draft, answers: [...draft.answers.filter(item => item.questionId !== question.id), updated] });
  }
  setFormulaDraft(latex: string) {
    const draft = this.snapshot.draft;
    if (!draft?.session || draft.phase !== 'ready' || draft.refreshConfirmation || draft.step !== 0 || typeof latex !== 'string' || latex.length > 4000) return;
    this.emit({ ...draft, formulaDraft: latex });
  }
  assist() {
    const draft = this.snapshot.draft;
    if (!draft || draft.phase !== 'ready' || draft.refreshConfirmation) return;
    this.emit({ ...draft, assisted: true, answers: draft.answers.map(answer => ({ ...answer, assisted: true })) });
  }
  next(skip = false) {
    const draft = this.snapshot.draft;
    if (!draft?.session || draft.phase !== 'ready' || draft.refreshConfirmation) return;
    if (draft.formulaDraft?.trim()) return;
    const question = draft.session.questions[draft.step];
    const answer = draft.answers.find(item => item.questionId === question.id);
    if ((answer?.text?.length || 0) > 4000) return;
    if (!skip && !answer?.text?.trim() && !answer?.optionId) return;
    const answers = skip ? [...draft.answers.filter(item => item.questionId !== question.id),
      { questionId: question.id, skipped: true, assisted: draft.assisted }] : draft.answers;
    const next = { ...draft, answers, step: Math.min(2, draft.step + 1) };
    this.emit(next);
    if (draft.step === 2) void this.submit();
  }
  private async submit() {
    const draft = this.snapshot.draft;
    if (!draft?.session || isBusy(draft) || draft.result) return;
    if (!draft.session.questions.every(question => draft.answers.some(answer => answer.questionId === question.id
      && (answer.skipped || answer.text?.trim() || answer.optionId)))) return;
    const operation = ++this.operation;
    let stage: QuickCheckDraft['errorStage'] = 'evaluate';
    try {
      const latest = this.note(draft.request.noteId);
      if (!latest || draft.session.sourceKey !== this.adapters.sourceKey(latest)) {
        this.emit({ ...draft, phase: 'error', errorStage: 'source', error: '参考资料已变化，原作答仍保留。请重新出题后作答，本次不会更新掌握状态。' }); return;
      }
      let assessment = draft.assessment;
      if (!assessment) {
        this.emit({ ...draft, phase: 'evaluating', error: undefined });
        assessment = await this.adapters.evaluate(draft.session, draft.answers, { note: latest });
        if (this.disposed || operation !== this.operation) return;
      }
      const saving = { ...draft, assessment, phase: 'saving' as const, error: undefined };
      this.emit(saving);
      stage = 'save';
      const beforeSave = this.note(draft.request.noteId);
      if (!beforeSave || draft.session.sourceKey !== this.adapters.sourceKey(beforeSave)) {
        this.emit({ ...saving, phase: 'error', errorStage: 'source', error: '参考资料已变化，原作答仍保留。请重新出题后作答，本次不会更新掌握状态。' }); return;
      }
      const result = await this.runtime.onCommit(draft.session, assessment);
      if (!this.disposed && operation === this.operation) this.emit({ ...saving, result, phase: 'result' });
    } catch (error) {
      if (!this.disposed && operation === this.operation) this.emit({ ...this.snapshot.draft!, phase: 'error', errorStage: stage, error: message(error) });
    }
  }
  retry = () => {
    const draft = this.snapshot.draft;
    if (!draft || draft.phase !== 'error') return;
    if (draft.errorStage === 'source') {
      this.emit({ request: draft.request, answers: [], step: 0, phase: 'generating', assisted: false,
        previousQuestions: previousQuestionStems(draft), recentQuestions: recentTasks(draft) }); void this.generate();
    } else if (!draft.pendingRetake && draft.errorStage !== 'generate' && draft.session && draft.answers.length === 3) void this.submit();
    else { this.emit({ ...draft, phase: 'generating', error: undefined }); void this.generate(); }
  };
  continue = () => {
    const draft = this.snapshot.draft;
    if (!draft?.result || isBusy(draft) || this.runtime.canOpen?.() === false || !this.note(draft.request.noteId)) return;
    const request = { noteId: draft.request.noteId, source: draft.request.source };
    // Keep the old card until replacement succeeds, including across retry/restart.
    this.emit({ ...draft, request, phase: 'generating', result: undefined, assessment: undefined, pendingRetake: true,
      error: undefined, refreshConfirmation: false, previousQuestions: previousQuestionStems(draft), recentQuestions: recentTasks(draft) });
    void this.generate();
  };
  /** Explicit whole-card refresh, including Agent launches. Never grades answers. */
  refresh = (criterionIds?: QuickCheckLaunchRequest['criterionIds']) => {
    const draft = this.snapshot.draft;
    if (!draft || isBusy(draft) || draft.phase === 'generating' || this.runtime.canOpen?.() === false) return;
    const request = { ...draft.request, ...(criterionIds ? { criterionIds } : {}) };
    if (!draft.result && (hasQuickCheckAnswer(draft) || draft.assessment)) {
      this.emit({ ...draft, refreshConfirmation: true, refreshCriterionIds: criterionIds }); return;
    }
    this.replaceCard(request);
  };
  cancelRefresh = () => {
    const draft = this.snapshot.draft;
    if (draft?.refreshConfirmation) this.emit({ ...draft, refreshConfirmation: false, refreshCriterionIds: undefined });
  };
  confirmRefresh = () => {
    const draft = this.snapshot.draft;
    if (draft?.refreshConfirmation && !isBusy(draft) && this.runtime.canOpen?.() !== false)
      this.replaceCard({ ...draft.request, ...(draft.refreshCriterionIds ? { criterionIds: draft.refreshCriterionIds } : {}) });
  };
  private replaceCard(request: QuickCheckLaunchRequest) {
    const draft = this.snapshot.draft;
    if (!draft || !this.note(request.noteId)) return;
    this.emit({ request, answers: [], step: 0, phase: 'generating', assisted: false,
      previousQuestions: previousQuestionStems(draft), recentQuestions: recentTasks(draft) }, true);
    void this.generate();
  }
}
