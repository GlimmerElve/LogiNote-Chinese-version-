import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Copy } from 'lucide-react';
import { writeSelectionClipboard } from '../services/ui/selectionClipboard';
import './SelectionActionHub.css';
import {
  normalizeSelectedText,
  resolveSelectionActions,
  type SelectionActionId,
  type SelectionContext,
  type SelectionSurface,
} from '../services/selectionActions';

const SURFACES = new Set<SelectionSurface>(['scene', 'flow', 'review', 'note', 'document', 'argument']);

interface ActiveSelection {
  context: SelectionContext;
  copyText: string;
  x: number;
  y: number;
  selectionTop: number;
  selectionBottom: number;
  placement: 'above' | 'below';
}

function elementForNode(node: Node | null): Element | null {
  return node instanceof Element ? node : node?.parentElement || null;
}

function readSelection(): ActiveSelection | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const anchorRoot = elementForNode(selection.anchorNode)?.closest<HTMLElement>('[data-selection-surface]');
  const focusRoot = elementForNode(selection.focusNode)?.closest<HTMLElement>('[data-selection-surface]');
  if (!anchorRoot || anchorRoot !== focusRoot) return null;
  const surface = anchorRoot.dataset.selectionSurface as SelectionSurface;
  if (!SURFACES.has(surface)) return null;
  const text = normalizeSelectedText(selection.toString());
  if (!text) return null;
  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height) return null;
  const placement = rect.top >= 52 ? 'above' : 'below';
  return {
    copyText: selection.toString(),
    selectionTop: rect.top,
    selectionBottom: rect.bottom,
    context: {
      text,
      surface,
      sourceId: anchorRoot.dataset.selectionSourceId,
      contextId: anchorRoot.dataset.selectionContextId,
      sourceTitle: anchorRoot.dataset.selectionSourceTitle,
      noteId: anchorRoot.dataset.selectionNoteId,
    },
    x: Math.max(16, Math.min(window.innerWidth - 16, rect.left + rect.width / 2)),
    y: placement === 'above' ? rect.top - 8 : rect.bottom + 8,
    placement,
  };
}

export const SelectionActionHub: React.FC<{
  onAction: (action: SelectionActionId, context: SelectionContext) => void;
}> = ({ onAction }) => {
  const [active, setActive] = useState<ActiveSelection | null>(null);
  const [copying, setCopying] = useState(false);
  const [copyError, setCopyError] = useState('');
  const [notice, setNotice] = useState('');
  const toolbarRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<ActiveSelection | null>(null);
  const copyLock = useRef(false);
  const mounted = useRef(false);

  const updateSelection = (next: ActiveSelection | null) => {
    activeRef.current = next;
    setActive(next);
    setCopyError('');
    setNotice('');
  };

  const finish = () => {
    updateSelection(null);
    window.getSelection()?.removeAllRanges();
  };

  const handleCopy = async () => {
    const selected = activeRef.current;
    if (!selected || copyLock.current) return;
    copyLock.current = true;
    setCopying(true);
    setCopyError('');
    try {
      await writeSelectionClipboard(selected.copyText);
      if (!mounted.current || activeRef.current !== selected) return;
      finish();
      setNotice('已复制选中文字');
    } catch {
      if (!mounted.current || activeRef.current !== selected) return;
      setCopyError('复制未成功，选中文字已保留。请重试，或按 Ctrl+C 手动复制。');
    } finally {
      copyLock.current = false;
      if (mounted.current) setCopying(false);
    }
  };

  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    if (!active || !toolbar) return;
    const { width, height } = toolbar.getBoundingClientRect();
    const above = active.selectionTop >= height + 8;
    toolbar.dataset.placement = above ? 'above' : 'below';
    toolbar.style.left = `${Math.max(width / 2 + 8, Math.min(window.innerWidth - width / 2 - 8, active.x))}px`;
    toolbar.style.top = `${above ? active.selectionTop - 8 : Math.max(8, Math.min(active.selectionBottom + 8, window.innerHeight - height - 8))}px`;
  }, [active, copying, copyError]);

  useEffect(() => {
    mounted.current = true;
    const showFromSelection = (event: MouseEvent) => {
      if (event.button !== 0 || event.defaultPrevented) return;
      if (!toolbarRef.current?.contains(event.target as Node)) updateSelection(readSelection());
    };
    const handleContextMenu = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      const next = readSelection();
      const target = event.target instanceof Element ? event.target : null;
      const targetRoot = target?.closest('[data-selection-surface]');
      const selectionRoot = next
        ? elementForNode(window.getSelection()?.anchorNode || null)?.closest('[data-selection-surface]')
        : null;
      if (!next || !targetRoot || targetRoot !== selectionRoot) return;
      event.preventDefault();
      updateSelection(next);
    };
    const closeOnOutside = (event: PointerEvent) => {
      if (!toolbarRef.current?.contains(event.target as Node)) updateSelection(null);
    };
    const closeOnKey = (event: KeyboardEvent) => { if (event.key === 'Escape') updateSelection(null); };
    const showOnKeyboardSelection = (event: KeyboardEvent) => {
      if (event.shiftKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)
        && !toolbarRef.current?.contains(event.target as Node)) updateSelection(readSelection());
    };
    const closeOnSelectionCollapse = () => { if (activeRef.current && window.getSelection()?.isCollapsed) updateSelection(null); };
    const close = () => updateSelection(null);

    document.addEventListener('mouseup', showFromSelection);
    document.addEventListener('contextmenu', handleContextMenu);
    document.addEventListener('pointerdown', closeOnOutside);
    document.addEventListener('selectionchange', closeOnSelectionCollapse);
    window.addEventListener('keydown', closeOnKey);
    document.addEventListener('keyup', showOnKeyboardSelection);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('loginote:knowledge-menu-open', close);
    return () => {
      mounted.current = false;
      document.removeEventListener('mouseup', showFromSelection);
      document.removeEventListener('contextmenu', handleContextMenu);
      document.removeEventListener('pointerdown', closeOnOutside);
      document.removeEventListener('selectionchange', closeOnSelectionCollapse);
      window.removeEventListener('keydown', closeOnKey);
      document.removeEventListener('keyup', showOnKeyboardSelection);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('loginote:knowledge-menu-open', close);
    };
  }, []);

  if (!active) return notice ? <div className="selection-copy-notice" role="status">{notice}<button type="button" aria-label="关闭复制提示" onClick={() => setNotice('')}>×</button></div> : null;
  const actions = resolveSelectionActions(active.context.text);

  return (
    <div
      ref={toolbarRef}
      className="selection-action-hub"
      data-placement={active.placement}
      style={{ left: active.x, top: active.y }}
      onMouseDown={(event) => event.preventDefault()}
    >
      <div className="selection-action-buttons" role="toolbar" aria-label="选中文字操作" aria-busy={copying}>
      <button type="button" disabled={copying} onClick={() => void handleCopy()}>
        <Copy aria-hidden="true" />{copying ? '正在复制' : copyError ? '重试复制' : '复制'}
      </button>
      {actions.map((action) => (
        <button key={action.id} type="button" disabled={copying} onClick={() => { if (copyLock.current) return; onAction(action.id, active.context); finish(); }}>
          {action.label}
        </button>
      ))}
      </div>
      {copyError && <p className="selection-copy-error" role="alert">{copyError}</p>}
    </div>
  );
};
