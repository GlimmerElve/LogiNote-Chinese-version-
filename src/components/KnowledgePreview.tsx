import React, { useState, useRef, useEffect, useCallback, useId, useMemo } from "react";
import { NoteItem } from "../types";
import { X, BookOpen, ExternalLink, Clock, GripVertical, ArrowLeft } from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from 'remark-math';
import { remarkGeneratedMath } from '../services/textbook/generatedMath';
import { remarkGeneratedFormatting } from '../services/textbook/generatedFormatting';
import { FormulaBlock } from './textbook/FormulaBlock';
import { useDialog } from './useDialog';
import { KnowledgeMasteryStatus } from './KnowledgeMasteryStatus';
import { parseWikiLink } from '../services/noteResolver';
import { scrollToNoteHeading } from '../services/ui/noteHeadingNavigation';
import { WIKI_LINK_PREFIX as WIKI_PREVIEW_PREFIX, remarkMarkdownWikiLinks } from '../services/markdownWikiLinks';

interface KnowledgePreviewProps {
  note: NoteItem;
  onClose: () => void;
  onEdit?: (note: NoteItem, heading?: string) => void;
  heading?: string;
  resolveWikiNote?: (rawTitle: string) => NoteItem | null | undefined;
  wikiLinkIssue?: (rawTitle: string) => string | undefined;
  darkMode: boolean;
}

type PreviewPosition = { x: number; y: number };
type PreviewSize = { width: number; height: number };
const PREVIEW_GUTTER = 16;
const previewTop = (height: number) => height < 480 ? PREVIEW_GUTTER : 72;
const readViewport = (): PreviewSize => typeof window === 'undefined'
  ? { width: 1024, height: 768 } : { width: window.innerWidth, height: window.innerHeight };

// Keep formula rendering consistent with the reader, without loading its data services.
const previewMarkdownComponents: Components = {
  pre: ({ children, node }) => {
    const code = node?.children.find((child) => child.type === 'element' && child.tagName === 'code');
    if (code?.type === 'element' && String(code.properties.className || '').split(/[ ,]+/u).includes('math-display')) {
      const latex = code.children.filter((child) => child.type === 'text').map((child) => child.value).join('');
      return <FormulaBlock latex={latex} displayMode />;
    }
    return <pre>{children}</pre>;
  },
  code: ({ className, children }) => className?.split(/\s+/u).includes('math-inline')
    ? <FormulaBlock latex={String(children)} /> : <code className={className}>{children}</code>,
};

export const remarkKnowledgePreviewWikiLinks = remarkMarkdownWikiLinks;

/** Keep the whole dialog (including its close/open buttons) inside the visible viewport. */
export function constrainKnowledgePreviewPosition(position: PreviewPosition, viewport: PreviewSize, card: PreviewSize): PreviewPosition {
  const baseLeft = Math.max(PREVIEW_GUTTER, viewport.width - PREVIEW_GUTTER - card.width);
  const baseTop = previewTop(viewport.height);
  const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(Math.max(minimum, maximum), value));
  return {
    x: clamp(position.x, PREVIEW_GUTTER - baseLeft, viewport.width - PREVIEW_GUTTER - card.width - baseLeft),
    y: clamp(position.y, PREVIEW_GUTTER - baseTop, viewport.height - PREVIEW_GUTTER - card.height - baseTop),
  };
}

export const KnowledgePreview: React.FC<KnowledgePreviewProps> = ({
  note,
  onClose,
  onEdit,
  resolveWikiNote,
  wikiLinkIssue,
  heading,
  darkMode: _darkMode
}) => {
  const [noteTrail, setNoteTrail] = useState<{ note: NoteItem; heading?: string }[]>([{ note, heading }]);
  const activeEntry = noteTrail.length === 1 && noteTrail[0].note.id === note.id ? { note, heading } : noteTrail.at(-1) || { note, heading };
  const activeNote = activeEntry.note;
  const activeHeading = activeEntry.heading;
  const [headingNotice, setHeadingNotice] = useState('');
  const bodyRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [viewport, setViewport] = useState(readViewport);
  const viewportRef = useRef(viewport);
  const posRef = useRef(pos);
  const dragging = useRef<{ pointerId: number; x: number; y: number; posX: number; posY: number } | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const { restoreFocus } = useDialog(true, cardRef, onClose, 65);

  const updatePosition = useCallback((next: PreviewPosition) => {
    const size = cardRef.current?.getBoundingClientRect();
    if (!size) return;
    const constrained = constrainKnowledgePreviewPosition(next, viewportRef.current, size);
    if (constrained.x === posRef.current.x && constrained.y === posRef.current.y) return;
    posRef.current = constrained;
    setPos(constrained);
  }, []);

  // Reset position when note changes
  useEffect(() => {
    dragging.current = null;
    posRef.current = { x: 0, y: 0 };
    setPos({ x: 0, y: 0 });
    setNoteTrail([{ note, heading }]);
  }, [note.id, heading]);

  useEffect(() => {
    setHeadingNotice('');
    if (!activeHeading || !bodyRef.current) return;
    if (!scrollToNoteHeading(bodyRef.current, activeHeading)) setHeadingNotice(`未找到章节「${activeHeading}」，可继续查看这篇笔记。`);
  }, [activeNote.id, activeHeading]);

  const openWikiInPreview = useCallback((rawTitle: string) => {
    const destination = parseWikiLink(rawTitle, title => Boolean(resolveWikiNote?.(title)));
    const target = destination.noteTitle ? resolveWikiNote?.(destination.noteTitle) || null : destination.heading ? activeNote : null;
    const issue = wikiLinkIssue?.(rawTitle);
    if (issue || !target) { setHeadingNotice(issue || '关联笔记不存在，请从目录检查引用名称。'); return; }
    if (target.id === activeNote.id && destination.heading === activeHeading) {
      if (destination.heading && bodyRef.current) scrollToNoteHeading(bodyRef.current, destination.heading);
      return;
    }
    setNoteTrail((current) => [...current, { note: target, heading: destination.heading }]);
  }, [activeNote, activeHeading, resolveWikiNote, wikiLinkIssue]);

  const markdownComponents = useMemo<Components>(() => ({
    ...previewMarkdownComponents,
    a: ({ href, children, ...attributes }) => {
      if (href?.startsWith(WIKI_PREVIEW_PREFIX)) {
        const rawTitle = decodeURIComponent(href.slice(WIKI_PREVIEW_PREFIX.length));
        const destination = parseWikiLink(rawTitle, title => Boolean(resolveWikiNote?.(title)));
        const target = destination.noteTitle ? resolveWikiNote?.(destination.noteTitle) || null : destination.heading ? activeNote : null;
        const issue = wikiLinkIssue?.(rawTitle);
        if (issue) return <button type="button" className="wiki-link-node knowledge-preview-wiki-link" title={issue}
          onClick={() => openWikiInPreview(rawTitle)}>{children}</button>;
        return target ? <button type="button" className="wiki-link-node knowledge-preview-wiki-link"
          title={`在预览窗中查看：${target.title}`} onClick={() => openWikiInPreview(rawTitle)}>{children}</button>
          : <span className="knowledge-preview-wiki-missing" title="关联笔记不存在">{children}</span>;
      }
      if (!href) return <span>{children}</span>;
      if (href.startsWith('#')) return <a href={href} {...attributes}>{children}</a>;
      let externalUrl: URL;
      try { externalUrl = new URL(href); } catch { return <span>{children}</span>; }
      if (!['http:', 'https:'].includes(externalUrl.protocol)) return <span>{children}</span>;
      return <a href={externalUrl.href} target="_blank" rel="noopener noreferrer" {...attributes}
        onClick={(event) => {
          event.preventDefault();
          const opener = (window as unknown as { electronAPI?: { openExternal?: (url: string) => Promise<void> } }).electronAPI?.openExternal;
          if (opener) void opener(externalUrl.href);
          else window.open(externalUrl.href, '_blank', 'noopener,noreferrer');
        }}>{children}<ExternalLink className="knowledge-preview-external-icon" aria-hidden="true" /></a>;
    },
  }), [openWikiInPreview, resolveWikiNote, wikiLinkIssue, activeNote]);

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('button') && !target.closest('[data-preview-drag-handle]')) return;
    dragging.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, posX: posRef.current.x, posY: posRef.current.y };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  }, []);

  const handleMoveKey = useCallback((event: React.KeyboardEvent<HTMLButtonElement>) => {
    const direction: Record<string, PreviewPosition> = {
      ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 },
      ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 },
    };
    if (!direction[event.key]) return;
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? 24 : 8;
    updatePosition({ x: posRef.current.x + direction[event.key].x * step, y: posRef.current.y + direction[event.key].y * step });
  }, [updatePosition]);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const drag = dragging.current;
      if (!drag || e.pointerId !== drag.pointerId) return;
      updatePosition({ x: drag.posX + e.clientX - drag.x, y: drag.posY + e.clientY - drag.y });
    };
    const onUp = (event: PointerEvent) => { if (event.pointerId === dragging.current?.pointerId) dragging.current = null; };
    const onBlur = () => { dragging.current = null; };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
    window.addEventListener('blur', onBlur);
    return () => {
      dragging.current = null;
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [updatePosition]);

  useEffect(() => {
    const onResize = () => {
      const next = readViewport();
      viewportRef.current = next;
      setViewport(next);
      dragging.current = null;
      updatePosition(posRef.current);
    };
    window.addEventListener('resize', onResize);
    const observer = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => updatePosition(posRef.current)) : null;
    if (cardRef.current) observer?.observe(cardRef.current);
    return () => { window.removeEventListener('resize', onResize); observer?.disconnect(); };
  }, [updatePosition]);

  return (
    <>
    <div className="fixed inset-0 z-50 bg-black/10" aria-hidden="true" onMouseDown={onClose} />
    <div
      ref={cardRef}
      role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
      className="fixed z-50 flex flex-col overflow-hidden rounded-2xl backdrop-blur-xl shadow-2xl border"
      style={{ top: previewTop(viewport.height) + pos.y, right: PREVIEW_GUTTER - pos.x,
        width: 'min(384px, calc(100vw - 32px))', maxHeight: Math.max(0, viewport.height - previewTop(viewport.height) - PREVIEW_GUTTER),
        background: 'var(--ln-bg-elevated)', color: 'var(--ln-text-primary)', borderColor: 'var(--ln-border)', boxShadow: 'var(--ln-shadow-float)' }}
    >
      {/* Header (draggable area) */}
      <div
        className="p-3 flex items-start justify-between gap-1 flex-shrink-0 rounded-t-2xl cursor-grab active:cursor-grabbing select-none"
        style={{ touchAction: 'none', background: 'var(--ln-accent-soft)', borderBottom: '1px solid var(--ln-border-subtle)' }}
        onPointerDown={handlePointerDown}
        onLostPointerCapture={() => { dragging.current = null; }}
      >
        <div className="flex items-start gap-2.5 min-w-0 flex-1">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style={{ color: 'var(--ln-accent)', background: 'var(--ln-bg-surface)' }}>
            <BookOpen className="w-4 h-4" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h3 id={titleId} className="text-sm font-bold leading-snug break-words" style={{ fontFamily: 'var(--ln-font-display)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }} title={activeNote.title || '未命名笔记'}>
              {activeNote.title || "未命名笔记"}
            </h3>
            <p className="text-[11px] mt-0.5" style={{ color: 'var(--ln-text-secondary)' }}>
              知识点 · 只读预览
            </p>
          </div>
        </div>
        {noteTrail.length > 1 && <button type="button"
          onClick={() => setNoteTrail((current) => current.slice(0, -1))}
          className="rounded-lg flex-shrink-0 flex items-center justify-center focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
          style={{ minWidth: 44, minHeight: 44, color: 'var(--ln-accent)', outlineColor: 'var(--ln-accent)' }}
          aria-label="返回上一篇预览" title="返回上一篇预览">
          <ArrowLeft className="w-4 h-4" aria-hidden="true" />
        </button>}
        <button type="button" data-preview-drag-handle onKeyDown={handleMoveKey}
          className="rounded-lg flex-shrink-0 flex items-center justify-center focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
          style={{ minWidth: 44, minHeight: 44, color: 'var(--ln-text-secondary)', outlineColor: 'var(--ln-accent)' }}
          aria-label="移动预览窗口，方向键调整位置" title="拖动窗口；也可聚焦后使用方向键">
          <GripVertical className="w-4 h-4" aria-hidden="true" />
        </button>
        <button type="button"
          onClick={onClose}
          className="rounded-lg hover:bg-black/5 transition flex-shrink-0 flex items-center justify-center focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
          style={{ minWidth: 44, minHeight: 44, color: 'var(--ln-text-secondary)', outlineColor: 'var(--ln-accent)' }}
          aria-label="关闭预览"
          title="关闭预览"
        >
          <X className="w-4 h-4" aria-hidden="true" />
        </button>
      </div>

      {/* Tags */}
      {activeNote.tags.length > 0 && (
        <div className="px-4 py-2 flex flex-wrap gap-1.5 border-b overflow-y-auto flex-shrink-0" style={{ maxHeight: 64, borderColor: 'var(--ln-border-subtle)' }}>
          {activeNote.tags.map((tag) => (
            <span
              key={tag}
              className="px-2 py-0.5 rounded-full font-medium text-[11px] border break-words max-w-full"
              style={{ background: 'var(--ln-accent-soft)', color: 'var(--ln-accent)', borderColor: 'var(--ln-border-subtle)' }}
            >
              #{tag}
            </span>
          ))}
        </div>
      )}

      {/* Content */}
      {headingNotice && <p role="status" className="px-4 py-2 text-xs">{headingNotice}<button type="button" className="ml-2 underline" onClick={() => setHeadingNotice('')}>关闭提示</button></p>}
      <div ref={bodyRef} role="region" aria-label="知识点正文" tabIndex={0}
        className="knowledge-preview-body flex-1 overflow-y-auto p-4 min-h-0">
        <KnowledgeMasteryStatus note={activeNote} />
        <div className="p-3 rounded-xl border break-words" style={{ background: 'var(--ln-bg-surface)', borderColor: 'var(--ln-border-subtle)' }}>
          <div
            className="knowledge-preview-prose max-w-none text-sm leading-relaxed overflow-x-auto"
            style={{ color: 'var(--ln-text-primary)' }}
            data-selection-surface="note"
            data-selection-source-id={activeNote.id}
            data-selection-context-id={activeNote.id}
            data-selection-source-title={activeNote.title}
            data-selection-note-id={activeNote.id}
          >
            <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath, [remarkGeneratedFormatting, { scope: activeNote.noteType === 'knowledge' ? 'all' : 'knowledge-section' }], [remarkGeneratedMath, { scope: activeNote.noteType === 'knowledge' ? 'all' : 'knowledge-section' }], remarkKnowledgePreviewWikiLinks]} components={markdownComponents}>
              {activeNote.content || "暂无内容"}
            </ReactMarkdown>
          </div>
        </div>
      </div>

      {/* Meta Info */}
      <div className="px-4 py-2 border-t flex items-center justify-between text-[11px] flex-shrink-0" style={{ color: 'var(--ln-text-secondary)', borderColor: 'var(--ln-border-subtle)' }}>
        <span className="flex items-center gap-1">
          <Clock className="w-3 h-3" aria-hidden="true" />
          {new Date(activeNote.updatedAt).toLocaleDateString("zh-CN", {
            year: "numeric",
            month: "short",
            day: "numeric"
          })}
        </span>
        <span>
          {activeNote.links.length > 0 ? `${activeNote.links.length} 个关联` : "无关联"}
        </span>
      </div>

      {/* Actions */}
      <div className="p-3 border-t flex gap-2 flex-shrink-0" style={{ borderColor: 'var(--ln-border-subtle)', background: 'var(--ln-bg-surface)' }}>
        <button type="button"
          onClick={onClose}
          className="flex-1 px-3 py-2 rounded-lg text-xs font-medium hover:brightness-95 transition flex items-center justify-center gap-1.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
          style={{ minHeight: 44, background: 'var(--ln-bg-subtle)', color: 'var(--ln-text-secondary)', outlineColor: 'var(--ln-accent)' }}
        >
          <X className="w-3.5 h-3.5" aria-hidden="true" />
          关闭
        </button>
        {onEdit && <button type="button"
          onClick={() => { restoreFocus(); onEdit(activeNote, activeHeading); }}
          className="flex-1 px-3 py-2 rounded-lg text-xs font-semibold hover:brightness-95 transition flex items-center justify-center gap-1.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
          style={{ minHeight: 44, background: 'var(--ln-accent)', color: 'var(--ln-bg-surface)', outlineColor: 'var(--ln-accent)' }}
        >
          <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
          打开编辑
        </button>}
      </div>
    </div>
    </>
  );
};
