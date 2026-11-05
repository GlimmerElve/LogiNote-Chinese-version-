import React, { useLayoutEffect, useRef } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, X } from 'lucide-react';
import type { ContextNavigationState, ContextNotePage } from '../services/ui/contextNavigation';
import type { NoteItem } from '../types';
import './ContextNotePages.css';

interface Props {
  navigation: ContextNavigationState;
  sourceLabel: string;
  getNote: (id: string) => NoteItem | null;
  onMove: (cursor: number) => void;
  renderNote: (note: NoteItem, page: ContextNotePage, isActive: boolean) => React.ReactNode;
}

export function ContextSourceForward({ navigation, onMove }: Pick<Props, 'navigation' | 'onMove'>) {
  if (navigation.cursor !== -1 || !navigation.pages.length) return null;
  return <nav className="context-note-navigation context-source-history" aria-label="继续查看引用笔记">
    <button type="button" data-context-source-forward onClick={() => onMove(0)} title="前进（Alt + →）"><ArrowRight aria-hidden="true" />继续查看引用笔记</button>
  </nav>;
}

export function ContextNotePages({ navigation, sourceLabel, getNote, onMove, renderNote }: Props) {
  const backRef = useRef<HTMLButtonElement>(null);
  const { cursor, pages } = navigation;
  const activeNote = cursor >= 0 ? getNote(pages[cursor].noteId) : null;
  const previousLabel = cursor > 0 ? getNote(pages[cursor - 1].noteId)?.title || '上一篇笔记' : sourceLabel;
  useLayoutEffect(() => { if (cursor >= 0) backRef.current?.focus({ preventScroll: true }); }, [cursor, pages[cursor]?.key]);

  return <section className="context-note-pages" style={{ visibility: cursor < 0 ? 'hidden' : 'visible' }}
    inert={cursor < 0} aria-hidden={cursor < 0} aria-label="引用笔记查看">
    <nav className="context-note-navigation" aria-label="返回来源与笔记历史">
      <button ref={backRef} type="button" onClick={() => onMove(cursor - 1)} className="context-note-back" title="返回上一页（Alt + ←）">
        <ArrowLeft aria-hidden="true" /><span>返回 {previousLabel}</span>
      </button>
      <button type="button" className="context-note-forward" onClick={() => onMove(cursor + 1)} disabled={cursor >= pages.length - 1}
        aria-label="前进到下一篇笔记" title="前进（Alt + →）"><ArrowRight aria-hidden="true" /></button>
      <span className="context-note-divider" aria-hidden="true" />
      <div className="context-note-location"><BookOpen aria-hidden="true" /><span>{activeNote?.title || '引用笔记'}</span></div>
      {cursor > 0 && <button type="button" className="context-note-source" onClick={() => onMove(-1)} title={`直接返回 ${sourceLabel}`}>返回来源</button>}
      <button type="button" className="context-note-close" onClick={() => onMove(-1)} aria-label={`关闭引用笔记，返回${sourceLabel}`} title={`关闭并返回${sourceLabel}（Esc）`}><X aria-hidden="true" /></button>
    </nav>
    <div className="context-note-content">
      {pages.map((page, index) => {
        const note = getNote(page.noteId);
        // Visibility keeps editor/scroll geometry intact; inert removes hidden pages from all input/focus.
        return <div key={page.key} className="context-note-page" data-context-note-id={page.noteId}
          style={{ visibility: cursor === index ? 'visible' : 'hidden' }} inert={cursor !== index} aria-hidden={cursor !== index}>
          {note ? renderNote(note, page, cursor === index) : <div className="context-note-unavailable" role="status">
            <BookOpen aria-hidden="true" /><h2>这篇引用笔记已不存在</h2><p>你可以返回来源页面继续，不会丢失当前进度。</p>
            <button type="button" onClick={() => onMove(cursor - 1)}>返回 {previousLabel}</button>
          </div>}
        </div>;
      })}
    </div>
  </section>;
}
