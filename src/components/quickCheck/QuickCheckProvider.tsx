import React, { createContext, useContext, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type MutableRefObject, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, ChevronRight, ClipboardCheck, Loader2, RefreshCw, X } from 'lucide-react';
import type { NoteItem } from '../../types';
import type { QuickCheckAnswer, QuickCheckAssessment, QuickCheckLaunchRequest, QuickCheckResult, QuickCheckSession } from '../../services/quickCheck';
import { useDialog } from '../useDialog';
import { QuickCheckStore, type QuickCheckController, type QuickCheckDraft, type QuickCheckStorage, type QuickCheckAdapters } from './store';
import './quickCheck.css';
import { MathLiveAnswer } from './MathLiveAnswer';
import { quickCheckQuestionReferences } from './references';
import { QuickCheckText } from './QuickCheckText';

const QuickCheckContext = createContext<QuickCheckController | null>(null);
export const useQuickCheck = () => useContext(QuickCheckContext);

export interface QuickCheckProviderProps {
  notes: NoteItem[];
  /** Read the latest saved note synchronously when an entry follows a commit. */
  getNotes?: () => NoteItem[];
  controllerRef?: MutableRefObject<QuickCheckController | null>;
  canOpen?: () => boolean;
  onCommit: (session: QuickCheckSession, assessment: QuickCheckAssessment) => Promise<QuickCheckResult>;
  /** Stable identity of this vault; absent means memory-only, never a shared key. */
  storageScope?: string;
  /** Test/demo seam: inject model boundaries, never a parallel presentation. */
  adapters?: Partial<QuickCheckAdapters>;
  children: ReactNode;
}

export function QuickCheckProvider({ notes, getNotes, controllerRef, canOpen, onCommit, storageScope, adapters, children }: QuickCheckProviderProps) {
  const store = useMemo(() => {
    let storage: QuickCheckStorage | undefined;
    try { if (typeof window !== 'undefined') storage = window.localStorage; } catch { /* Browser privacy mode. */ }
    return new QuickCheckStore({ notes, getNotes, canOpen, onCommit }, storageScope, storage, adapters);
    // Runtime callbacks and note updates do not replace drafts or make requests.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageScope, adapters]);
  useEffect(() => { store.activate(); return () => store.dispose(); }, [store]);
  useEffect(() => { store.setRuntime({ notes, getNotes, canOpen, onCommit }); store.reconcileNotes(); }, [store, notes, getNotes, canOpen, onCommit]);
  useEffect(() => {
    if (controllerRef) controllerRef.current = store;
    return () => { if (controllerRef?.current === store) controllerRef.current = null; };
  }, [store, controllerRef]);
  return <QuickCheckContext.Provider value={store}>{children}<QuickCheckHost store={store} /></QuickCheckContext.Provider>;
}

export function QuickCheckButton({ noteId, criterionIds, source = 'knowledge', children = '简测', className = '', disabled = false }: {
  noteId: string;
  criterionIds?: QuickCheckLaunchRequest['criterionIds'];
  source?: string;
  children?: ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  const controller = useQuickCheck();
  if (!controller) return null;
  return <button type="button" className={`quick-check-entry ${className}`} disabled={disabled}
    aria-label={`定向简测${typeof children === 'string' && children !== '简测' ? `：${children}` : ''}`}
    onKeyDown={event => event.stopPropagation()}
    onClick={event => { event.stopPropagation(); controller.open({ noteId, criterionIds, source }); }}>
    <ClipboardCheck aria-hidden="true" />{children}
  </button>;
}

function QuickCheckHost({ store }: { store: QuickCheckStore }) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const ref = useRef<HTMLDivElement>(null);
  useDialog(snapshot.open, ref, store.close, 200);
  if (!snapshot.open || !snapshot.draft || typeof document === 'undefined') return null;
  return createPortal(<div className="quick-check-overlay" onPointerDown={event => {
    if (event.target === event.currentTarget) store.close();
  }}><div ref={ref} className="quick-check-dialog" role="dialog" aria-modal="true" aria-labelledby="quick-check-title" tabIndex={-1}>
    <QuickCheckCard draft={snapshot.draft} onClose={store.close} onAnswer={answer => store.answer(answer)}
      onFormulaDraftChange={latex => store.setFormulaDraft(latex)}
      onRefresh={() => store.refresh()} onConfirmRefresh={store.confirmRefresh} onCancelRefresh={store.cancelRefresh}
      onNext={skip => store.next(skip)} onAssist={() => store.assist()} onRetry={store.retry} onContinue={store.continue} />
  </div></div>, document.body);
}

/** Presentation is intentionally small: one question, then one conclusion.
 * Answer keys are never rendered until a completed assessment is saved. */
export function QuickCheckCard({ draft, onClose, onAnswer, onFormulaDraftChange, onNext, onAssist, onRetry, onContinue,
  onRefresh, onConfirmRefresh, onCancelRefresh }: {
  draft: QuickCheckDraft;
  onClose: () => void;
  onAnswer: (answer: QuickCheckAnswer) => void;
  onFormulaDraftChange: (latex: string) => void;
  onNext: (skip?: boolean) => void;
  onAssist: () => void;
  onRetry: () => void;
  onContinue: () => void;
  onRefresh?: () => void;
  onConfirmRefresh?: () => void;
  onCancelRefresh?: () => void;
}) {
  const inputId = useId();
  const questionHeading = useRef<HTMLHeadingElement>(null);
  const [showReference, setShowReference] = useState(false);
  const session = draft.session;
  const question = session?.questions[draft.step];
  const answer = draft.answers.find(item => item.questionId === question?.id);
  const busy = draft.phase === 'evaluating' || draft.phase === 'saving';
  const loading = draft.phase === 'generating' || busy;
  const result = draft.result;
  const canNext = Boolean(answer?.text?.trim() || answer?.optionId) && (answer?.text?.length || 0) <= 4000 && !draft.formulaDraft?.trim();
  useEffect(() => { setShowReference(false); }, [session?.id, draft.step]);
  useEffect(() => { if (!draft.refreshConfirmation && (draft.phase === 'ready' || draft.phase === 'result')) questionHeading.current?.focus({ preventScroll: true }); }, [session?.id, draft.step, draft.phase, draft.refreshConfirmation]);
  return <>
    <header className="quick-check-header">
      <span className="quick-check-mark"><ClipboardCheck aria-hidden="true" /></span>
      <div><small>QUICK CHECK</small><h2 id="quick-check-title">{result ? '简测完成' : '定向简测'}</h2></div>
      <div className="quick-check-header-actions">
        {onRefresh && <button type="button" className="quick-check-refresh" disabled={loading || draft.refreshConfirmation}
          onClick={onRefresh} title="按当前掌握情况重新生成整张卡片"><RefreshCw aria-hidden="true" />重新出题</button>}
        <button type="button" className="quick-check-close" aria-label="关闭简测，保留作答" disabled={busy} onClick={onClose}><X aria-hidden="true" /></button>
      </div>
    </header>
    <div className="quick-check-context"><strong>{session?.noteTitle || '正在准备知识点问题'}</strong>
      {session && !result && <span>{draft.step + 1}／3</span>}</div>
    {draft.stale && !result && <p className="quick-check-notice" role="status">掌握情况或参考资料已变化，已保留本次作答；下一张将按最新情况出题。</p>}
    {draft.cacheNotice && <p className="quick-check-notice" role="status">{draft.cacheNotice}</p>}
    {draft.refreshConfirmation ? <section className="quick-check-refresh-confirm" role="alert" aria-labelledby={`${inputId}-refresh`}>
      <h3 id={`${inputId}-refresh`}>重新生成这张卡片？</h3>
      <p>当前未完成的作答将被清除，三道题都会重新生成。已保存的掌握状态不会改变。</p>
      <div className="quick-check-actions"><button type="button" autoFocus onClick={onCancelRefresh}>保留作答</button>
        <button type="button" className="is-primary" onClick={onConfirmRefresh}>确认重新出题</button></div>
    </section> : loading ? <div className="quick-check-loading" role="status" aria-live="polite"><Loader2 aria-hidden="true" />
      <strong>{draft.phase === 'generating' ? '正在针对缺口准备三道题' : draft.phase === 'saving' ? '正在保存本次结果' : '正在核对本次作答'}</strong>
      <span>{draft.phase === 'generating' ? '题目会保留，无需一直停留在这里。' : '三道题统一评价，不重复提交。'}</span>
    </div> : draft.phase === 'error' ? <div className="quick-check-error" role="alert">
      <h3>暂时未完成</h3><p>{draft.error || '请稍后重试，作答已保留。'}</p>
      <div className="quick-check-actions"><button type="button" onClick={onClose}>稍后继续</button>
        <button type="button" className="is-primary" onClick={onRetry}>{draft.errorStage === 'source' ? '按新资料重新出题' : draft.assessment ? '重试保存' : '重试'}</button></div>
    </div> : result ? <section className="quick-check-result">
      <CheckCircle2 aria-hidden="true" /><h3 ref={questionHeading} tabIndex={-1}><QuickCheckText text={result.headline} /></h3>
      <p>{result.remaining.length ? `仍需确认：${result.remaining.slice(0, 2).join('、')}${result.remaining.length > 2 ? '等' : ''}` : result.changed ? '本次涉及的判据已完成核对。' : '掌握状态暂未变化。'}</p>
      <small><QuickCheckText text={result.nextAction} /></small>
      <div className="quick-check-actions"><button type="button" onClick={onContinue}>继续简测</button><button type="button" className="is-primary" onClick={onClose}>完成</button></div>
      <details className="quick-check-analysis"><summary>查看解析</summary>{result.details.map(detail => <article key={detail.questionId}>
        <strong><QuickCheckText text={detail.prompt} /></strong>{detail.correct != null && <small>{detail.correct ? '作答正确' : '需要修正'}</small>}<p>你的回答：<QuickCheckText text={detail.answer || '本题跳过，未按错误计入'} /></p>
        {detail.referenceAnswer && <p><strong>{detail.correct != null ? '正确答案' : '出题参考答案（尚未核验）'}：</strong><QuickCheckText text={detail.referenceAnswer} /></p>}
        <p><QuickCheckText text={detail.explanation} /></p>
      </article>)}</details>
    </section> : question ? <section className="quick-check-question">
      <div className="quick-check-progress" aria-label={`共三题，当前第${draft.step + 1}题`}>{[0, 1, 2].map(index => <i key={index} className={index <= draft.step ? 'is-active' : ''} />)}</div>
      <p className="quick-check-target">{session!.targets.filter(target => question.criterionIds.includes(target.id)).map(target => target.label).join(' · ')}</p>
      <h3 ref={questionHeading} tabIndex={-1}><QuickCheckText text={question.prompt} /></h3>
      {draft.step === 0 ? <>
        <MathLiveAnswer id={inputId} value={answer?.text || ''} placeholder="用自己的话作答，也可以列出计算或证明的关键步骤…" maxLength={4000}
          formulaDraft={draft.formulaDraft || ''} onFormulaDraftChange={onFormulaDraftChange}
          onChange={value => onAnswer({ questionId: question.id, text: value })} />
        <small className="quick-check-hint">进入下一题后，此回答将锁定，避免后面的选项影响作答。</small>
        {(answer?.text?.length || 0) > 4000 && <p className="quick-check-notice" role="alert">请将回答精简到 4000 字以内，再进入下一题。</p>}
      </> : <fieldset className="quick-check-options"><legend className="quick-check-sr-only">请选择一个答案</legend>
        {question.options?.map(option => <label key={option.id} className={answer?.optionId === option.id ? 'is-selected' : ''}>
          <input type="radio" name={`${inputId}-option`} value={option.id} checked={answer?.optionId === option.id}
            onChange={() => onAnswer({ questionId: question.id, optionId: option.id })} />
          <QuickCheckText text={option.text} />
        </label>)}
      </fieldset>}
      {draft.assisted && <p className="quick-check-assistance" role="status">已标记为辅助作答，不按独立表现确认掌握。</p>}
      <div className="quick-check-actions"><button type="button" disabled={Boolean(draft.formulaDraft?.trim())} onClick={() => onNext(true)}>暂时不会</button>
        <button type="button" className="is-primary" disabled={!canNext} onClick={() => onNext(false)}>{draft.step === 2 ? '提交简测' : '下一题'}<ChevronRight aria-hidden="true" /></button></div>
      <button type="button" className="quick-check-reference-toggle" aria-expanded={showReference} onClick={() => {
        if (!showReference) onAssist(); setShowReference(value => !value);
      }}>{showReference ? '收起参考' : '查看参考（辅助作答）'}</button>
      {showReference && <div className="quick-check-references">{quickCheckQuestionReferences(session!, question).map(reference => <article key={reference.id}>
        <strong>{reference.sourceLabel}</strong><p><QuickCheckText text={reference.quote} /></p>
      </article>)}</div>}
    </section> : null}
  </>;
}
