import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { ProgressiveSupplementScope } from '../../services/progressiveLearning/types';
import { writeSelectionClipboard } from '../../services/ui/selectionClipboard';

export interface ProgressiveMenuState {
  x: number; y: number; pageId: string; courseId: string; scope: ProgressiveSupplementScope; canMainline: boolean; canExpand: boolean;
}
/** Only the teaching surface can supply a supplement scope. Inputs and other columns retain their menus. */
export function captureProgressiveScope(event: React.MouseEvent<HTMLDivElement>, pageHash: string): ProgressiveSupplementScope | null {
  const target = event.target instanceof Element ? event.target : null;
  const article = event.currentTarget.querySelector<HTMLElement>('[data-lesson-content]');
  if (!article || !target || target.closest('button,a,input,textarea,select,[contenteditable="true"],[data-progressive-quiz]')) return null;
  if (!article.contains(target) && target !== event.currentTarget) return null;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.toString().trim()) return { text: '', pageHash };
  if (!article.contains(selection.anchorNode) || !article.contains(selection.focusNode)) return null;
  try {
    const range = selection.getRangeAt(0), before = document.createRange(), after = document.createRange();
    before.selectNodeContents(article); before.setEnd(range.startContainer, range.startOffset);
    after.selectNodeContents(article); after.setStart(range.endContainer, range.endOffset);
    return { text: selection.toString(), before: before.toString().slice(-500), after: after.toString().slice(0, 500), pageHash };
  } catch { return null; }
}
export function ProgressiveContextMenu({ menu, onClose, onAction, onFigure }: {
  menu: ProgressiveMenuState; onClose: () => void; onAction: (intent: 'mainline' | 'expansion', scope?: ProgressiveSupplementScope) => void; onFigure?: (scope: ProgressiveSupplementScope) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [copyError, setCopyError] = React.useState('');
  useEffect(() => {
    root.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) onClose(); };
    const close = () => onClose();
    // Layout/selection auto-scroll must not dismiss a menu before its first click.
    // User wheel/touch/scrollbar actions still dismiss it immediately.
    document.addEventListener('pointerdown', outside); window.addEventListener('wheel', close, { capture: true, passive: true });
    window.addEventListener('touchmove', close, { capture: true, passive: true }); window.addEventListener('resize', close);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('wheel', close, true); window.removeEventListener('touchmove', close, true); window.removeEventListener('resize', close); };
  }, [onClose]);
  return createPortal(<div ref={root} role="menu" aria-label="讲解页操作" className="progressive-context-menu"
    style={{ left: Math.max(8, Math.min(menu.x, window.innerWidth - 278)), top: Math.max(8, Math.min(menu.y, window.innerHeight - 270)) }}
    onMouseDown={event => event.preventDefault()} onContextMenu={event => event.preventDefault()} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      if (['PageUp', 'PageDown', 'Home', 'End', 'Tab'].includes(event.key)) onClose();
      if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
        event.preventDefault(); const buttons = [...root.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[(index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
      }
    }}>
    {menu.scope.text && <button type="button" role="menuitem" onClick={() => {
      void writeSelectionClipboard(menu.scope.text).then(onClose).catch(() => setCopyError('复制未成功，选区仍保留，可按 Ctrl+C。'));
    }}>复制</button>}
    {onFigure && <button type="button" role="menuitem" disabled={menu.scope.text.length > 1200} onClick={() => { onClose(); onFigure(menu.scope); }}>{menu.scope.text ? '为选中内容生成交互图' : '为本页生成交互图'}</button>}
    {menu.scope.text.length > 1200 && onFigure && <small>生成交互图请选取不超过 1200 字的内容。</small>}
    <button type="button" role="menuitem" disabled={!menu.canMainline} onClick={() => { onClose(); onAction('mainline'); }}>继续主线</button>
    <button type="button" role="menuitem" disabled={!menu.canExpand || menu.scope.text.length > 50_000} onClick={() => { onClose(); onAction('expansion', menu.scope); }}>
      {menu.scope.text ? '针对这部分内容补充讲解页' : '补充本页讲解'}
    </button>
    {menu.scope.text.length > 50_000 && <small>选区过长，请缩小范围；不会截断选区。</small>}
    {copyError && <p role="alert">{copyError}</p>}
  </div>, document.body);
}
