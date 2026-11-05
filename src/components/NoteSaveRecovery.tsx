import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import type { NoteSaveState } from '../services/ui/saveFeedback';

/** Keep a failed write visible across workspace navigation and during its retry. */
export function NoteSaveRecovery({ state, onRetry, pendingDeletionCount = 0, restoredDeletionCount = 0, onDismissDeletionNotice,
  error, onRecoverDrafts, recovering = false, notice, onDismissNotice }: {
  state: NoteSaveState; onRetry: () => void; pendingDeletionCount?: number; restoredDeletionCount?: number; onDismissDeletionNotice?: () => void;
  error?: string; onRecoverDrafts?: () => void; recovering?: boolean; notice?: string; onDismissNotice?: () => void;
}) {
  const [failed, setFailed] = useState(state === 'error');
  const retryButton = useRef<HTMLButtonElement>(null);
  const retryOrigin = useRef<Element | null>(null);
  useEffect(() => {
    if (state === 'error') setFailed(true);
    else if (state === 'saved') setFailed(false);
  }, [state]);
  useEffect(() => {
    const button = retryButton.current;
    if (state === 'saved') retryOrigin.current = null;
    if (state !== 'error' || !button?.isConnected || retryOrigin.current !== button) return;
    if (document.activeElement === document.body || document.activeElement === button) button.focus({ preventScroll: true });
  }, [state]);
  if (state === 'saved' && notice) return <div className="note-save-recovery" role="status">
    <span>{notice}</span>{onDismissNotice && <button type="button" onClick={onDismissNotice}>知道了</button>}
  </div>;
  if (state === 'saved') return restoredDeletionCount > 0 ? <div className="note-save-recovery" role="alert" aria-atomic="true">
    <AlertTriangle aria-hidden="true" /><span>上次删除未完成，已恢复 {restoredDeletionCount} 篇笔记。</span>
    {onDismissDeletionNotice && <button type="button" onClick={onDismissDeletionNotice}>知道了</button>}
  </div> : null;
  if (!failed && state !== 'error' && pendingDeletionCount === 0 && restoredDeletionCount === 0) return null;
  const busy = recovering || state !== 'error';
  return <div className="note-save-recovery" role={busy ? 'status' : 'alert'} aria-atomic="true">
    {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <AlertTriangle aria-hidden="true" />}
    <span>{recovering ? '正在保留草稿并重新载入磁盘版本…' : busy ? pendingDeletionCount > 0 ? `正在后台保存删除（${pendingDeletionCount} 篇）…`
      : restoredDeletionCount > 0 ? '正在保存已恢复的笔记…' : '正在重试保存，请暂勿关闭窗口。'
      : restoredDeletionCount > 0 ? `删除未能保存，已在界面恢复 ${restoredDeletionCount} 篇笔记。请重试保存后再关闭。`
        : '笔记保存失败，最新内容仍在当前窗口中。请重试后再关闭。'}
      {error && <small className="note-save-error-detail">{error}</small>}
      {onRecoverDrafts && <small className="note-save-error-detail">重新载入会保留磁盘版本，并将待保存内容另存为草稿笔记。</small>}
    </span>
    <button ref={retryButton} type="button" onClick={() => {
      retryOrigin.current = document.activeElement;
      onRetry();
    }} disabled={busy}>{busy ? '正在保存' : '重试保存'}</button>
    {onRecoverDrafts && <button type="button" onClick={onRecoverDrafts} disabled={busy}>保留草稿并重新载入</button>}
  </div>;
}
