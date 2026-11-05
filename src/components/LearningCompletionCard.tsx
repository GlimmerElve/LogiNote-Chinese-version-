import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle, Check, CheckCircle2, Loader2, Undo2, X } from 'lucide-react';
import type { LearningCompletionTarget } from '../services/learningCompletion';
import './LearningCompletionCard.css';

export interface LearningCompletionCardProps {
  target: LearningCompletionTarget | null;
  onSetCompleted: (target: LearningCompletionTarget, completed: boolean) => Promise<void>;
  variant?: 'inline' | 'compact' | 'result';
  context?: 'note' | 'flow' | 'scene';
  onDismiss?: () => void;
}

/** Confirmation is always a deliberate user action, independent of analysis scores. */
export const LearningCompletionCard: React.FC<LearningCompletionCardProps> = ({ target, ...props }) => {
  if (!target) return null;
  const key = [target.kind, target.binding.noteId, target.binding.taskId, target.binding.occurrenceDate].join(':');
  return <CompletionControl key={key} target={target} {...props} />;
};

const CompletionControl: React.FC<Omit<LearningCompletionCardProps, 'target'> & { target: LearningCompletionTarget }> = ({
  target,
  onSetCompleted,
  variant = 'inline',
  context = 'note',
  onDismiss,
}) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryAction, setRetryAction] = useState<boolean | null>(null);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  useEffect(() => {
    if (error) errorRef.current?.focus({ preventScroll: true });
  }, [error]);

  const setCompleted = async (completed: boolean) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setRetryAction(completed);
    try {
      await onSetCompleted(target, completed);
      if (mountedRef.current) setRetryAction(null);
    } catch (cause) {
      if (mountedRef.current) {
        const detail = cause instanceof Error ? cause.message.trim() : '';
        setError(detail || '完成状态未能保存，请重试。');
      }
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };

  const isProject = target.kind === 'project';
  const actionLabel = isProject ? '标记项目完成' : '完成本次待办';
  const displayPath = isProject && target.path[target.path.length - 1] === target.title
    ? target.path.slice(0, -1)
    : target.path;
  const sectionLabel = context === 'scene' ? '场景收尾' : context === 'flow' ? '学习收尾' : '项目状态';
  const detail = !isProject
    ? target.binding.occurrenceDate ? '只完成本次待办，下次周期仍会按计划提醒。' : '完成状态会同步到本周安排。'
    : context === 'scene'
      ? '场景已结束，项目是否完成由你确认。'
      : context === 'flow'
        ? '本次学习已结束，可以确认这个项目是否已完成。'
        : '完成状态会同步到计划与学习队列。';

  return (
    <section
      className={`learning-completion-card is-${variant} ${target.completed ? 'is-completed' : ''}`}
      aria-label={`${isProject ? '项目' : '本次待办'}完成确认`}
      aria-busy={busy}
    >
      {variant !== 'compact' && (
        <>
          <div className="learning-completion-symbol" aria-hidden="true">
            {target.completed ? <CheckCircle2 /> : <Check />}
          </div>
          <div className="learning-completion-copy">
            <span className="learning-completion-eyebrow">{sectionLabel}</span>
            {displayPath.length > 0 && <p className="learning-completion-path" title={displayPath.join(' › ')}>{displayPath.join(' › ')}</p>}
            <h3>{target.title}</h3>
            <p className="learning-completion-description">{target.completed && isProject ? '已同步到计划与学习队列，可以撤销完成。' : detail}</p>
          </div>
        </>
      )}
      <div className="learning-completion-actions">
        {target.completed && (
          <span className="learning-completion-status" role="status" aria-live="polite">
            <CheckCircle2 aria-hidden="true" />已完成
          </span>
        )}
        <button
          type="button"
          className={`learning-completion-action ${target.completed ? 'is-undo' : 'is-primary'}`}
          disabled={busy}
          onClick={() => { void setCompleted(!target.completed); }}
          title={`${target.completed ? '撤销完成' : actionLabel} · ${target.title}`}
        >
          {busy ? <Loader2 className="learning-completion-spinner" aria-hidden="true" /> : target.completed ? <Undo2 aria-hidden="true" /> : <Check aria-hidden="true" />}
          {busy ? '正在保存…' : target.completed ? '撤销完成' : actionLabel}
        </button>
        {onDismiss && (
          <button type="button" className="learning-completion-dismiss" onClick={onDismiss} disabled={busy} aria-label="稍后再确认" title="稍后再确认">
            <X aria-hidden="true" />
          </button>
        )}
      </div>
      {error && (
        <div className="learning-completion-error" role="alert" tabIndex={-1} ref={errorRef}>
          <AlertCircle aria-hidden="true" />
          <span>{error}</span>
          <button type="button" disabled={busy || retryAction === null} onClick={() => { if (retryAction !== null) void setCompleted(retryAction); }}>重试</button>
        </div>
      )}
    </section>
  );
};
