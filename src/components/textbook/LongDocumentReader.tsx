import React, { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { jsx, jsxs } from 'react/jsx-runtime';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import type { Root } from 'hast';
import type { Components } from 'react-markdown';
import type { TextbookManifest, TextbookReadingState } from '../../services/textbook/types';
import type { TextbookReadingGetter } from '../../services/textbook/readingState';
import type { ReadingIndex, ReadingPage } from '../../services/textbook/readingDocument';
import type { createReadingDocumentSession } from '../../services/textbook/readingDocumentClient';
import { recentReadingSessions } from '../../services/textbook/recentReadingSessions';
import { captureReadingViewport, parseReadingViewport, readingViewportAnchor, readingViewportTop, type ReadingViewport } from '../../services/textbook/readingViewport';
import { registerPendingCapture } from '../../services/agent/dataFreshness';
import { noteHeadingMatches, type NoteHeadingRequest } from '../../services/ui/noteHeadingNavigation';
import { readTextbookBody, textbookRegionMarkers } from '../../services/textbook/noteContent';
import { ReadingPresentationContext, useReaderPresentation, useReadingPresentation } from './ReadingPresentation';
import { ReadingWorkerProvider } from './ReadingWorkerContext';
import './textbookReader.css';

type Session = ReturnType<typeof createReadingDocumentSession>;
export interface LongDocumentReaderProps {
  content: string; noteId: string; title: string; manifest?: TextbookManifest; active?: boolean; interactive?: boolean; className?: string;
  components?: Components; selectionSurface?: 'flow' | 'note';
  readingPosition?: Partial<TextbookReadingState>; getReadingPosition?: TextbookReadingGetter;
  onReadingPosition?: (position: { blockAnchor?: string; scrollTop: number }) => void;
  headingRequest?: NoteHeadingRequest; onHeadingResolved?: (found: boolean) => void;
}
const PreparedReadingChunk = React.memo(function PreparedReadingChunk({ tree, components }: { tree: Root; components?: Components }) {
  return toJsxRuntime(tree, { Fragment, jsx, jsxs, passKeys: true, passNode: true, ignoreInvalidStyle: true, components });
});

/** A stable scroll slot. Far-away DOM is released, its measured height retained.
 * Native scroll anchoring keeps the viewport steady as nearby slots warm up. */
export const ReadingChunk = React.memo(function ReadingChunk({ metadata, number, root, session, active, pinned, components, nested = false, windowRoot = false }: {
  metadata: ReadingPage; number: number; root: React.RefObject<HTMLElement | null>; session: Session; active: boolean; pinned: boolean; components?: Components;
  nested?: boolean; windowRoot?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null);
  const height = useRef(metadata.estimatedHeight);
  const [near, setNear] = useState(false), [tree, setTree] = useState<Root>(), [error, setError] = useState(''), [attempt, setAttempt] = useState(0);
  // Losing keyboard ownership (Agent/palette) pauses work, not the view.
  // Keep the last viewport painted; genuinely hidden tabs already hide the host.
  const visible = near || pinned;
  const needed = active && visible;
  const [retained, setRetained] = useState(() => session.retains(number));
  const prepared = tree || (visible ? session.cachedPage(number) : undefined);
  const presentation = useReadingPresentation();
  useEffect(() => {
    const sync = () => setRetained(session.retains(number)); sync();
    return session.subscribeRetained(number, sync);
  }, [session, number]);
  useEffect(() => {
    const element = host.current;
    if (!active || !element || !root.current && !windowRoot) return;
    if (typeof IntersectionObserver === 'undefined') return;
    let stopped = false;
    const observer = new IntersectionObserver(entries => {
      if (stopped) return;
      const visible = entries.some(entry => entry.isIntersecting);
      setNear(visible);
    }, { root: root.current, rootMargin: '400px 0px', threshold: 0 });
    observer.observe(element); return () => { stopped = true; observer.disconnect(); };
  }, [active, root, session, windowRoot]);
  useEffect(() => {
    if (!needed) { if (!visible && !retained) setTree(undefined); return; }
    if (prepared) { if (!tree) setTree(prepared); return; }
    let cancelled = false; let cancelPresentation = () => {}; setError('');
    void session.page(number).then(value => {
      if (cancelled) return;
      const publish = () => { if (!cancelled) React.startTransition(() => setTree(value)); };
      if (presentation && !session.wasPresented(number)) cancelPresentation = presentation.enqueue(publish); else publish();
    })
      .catch(reason => { if (!cancelled && reason?.name !== 'AbortError') setError(reason instanceof Error ? reason.message : '正文读取失败'); });
    return () => { cancelled = true; cancelPresentation(); };
  }, [needed, visible, number, session, attempt, presentation, retained, prepared, tree]);
  useLayoutEffect(() => {
    const element = content.current; if (!element || !prepared || !needed) return;
    session.markPresented(number, prepared);
    // Observe the browser's completed layout. Synchronously reading the full
    // formula subtree here forced style/layout into React's commit, delaying
    // input exactly when several newly visible chunks arrived together.
    let stopped = false;
    const observer = new ResizeObserver(entries => {
      if (stopped) return;
      const entry = entries[0]; if (!entry) return;
      const next = entry.borderBoxSize?.[0]?.blockSize || entry.contentRect.height;
      if (next > 0) height.current = next;
    }); observer.observe(element);
    return () => { stopped = true; observer.disconnect(); };
  }, [prepared, needed, session, number]);
  const mounted = (visible || retained) && prepared;
  return <div ref={host} data-reading-chunk={nested ? undefined : number} data-nested-reading-chunk={nested ? number : undefined} className="textbook-reading-slot"
    style={visible && mounted ? undefined : { height: `${height.current}px` }} aria-busy={needed && !prepared}>
    {mounted ? <div ref={content} className="textbook-reading-chunk" style={visible ? undefined : { contentVisibility: 'hidden' }}><PreparedReadingChunk tree={prepared} components={components} /></div>
      : visible && <div className="textbook-chunk-status" role="status">{error || '正在准备附近正文…'}{error && (session.isDisposed
        ? <span>请使用上方“重试读取”重新启动后台阅读。</span>
        : <button type="button" onClick={() => setAttempt(value => value + 1)}>重试</button>)}</div>}
  </div>;
});

export function LongDocumentReader({ content, noteId, title, manifest, active = true, interactive = active, className = '', components,
  selectionSurface = 'note', readingPosition, getReadingPosition, onReadingPosition, headingRequest, onHeadingResolved }: LongDocumentReaderProps) {
  // Personal learning records outside the managed region must not restart a
  // visible textbook worker. Retain the same strict boundary check in the worker.
  const materialContent = useMemo(() => {
    if (!manifest) return content;
    const body = readTextbookBody(content, manifest);
    if (body === null) return content;
    const [start, end] = textbookRegionMarkers(manifest.regionId);
    return `${start}\n${body}\n${end}`;
  }, [content, manifest]);
  // A state update may clone this JSON metadata without changing its meaning.
  const manifestKey = useMemo(() => JSON.stringify(manifest), [manifest]);
  const root = useRef<HTMLDivElement>(null), article = useRef<HTMLElement>(null);
  const activeRef = useRef(active); activeRef.current = active;
  const presentation = useReaderPresentation(root, active);
  const initialUserTop = useRef<number | undefined>(undefined);
  const [enabled, setEnabled] = useState(active), [attempt, setAttempt] = useState(0);
  const [document, setDocument] = useState<{ index: ReadingIndex; session: Session }>();
  const [error, setError] = useState('');
  const [focusedBlock, setFocusedBlock] = useState<number>();
  const [selectedBlocks, setSelectedBlocks] = useState<number[]>([]);
  const [navigation, setNavigation] = useState<ReadingViewport & { anchor?: string; legacyTop?: number }>();
  const appliedNavigation = useRef<typeof navigation>(undefined);
  const appliedHeading = useRef<string | undefined>(undefined);
  const headingCallback = useRef(onHeadingResolved); headingCallback.current = onHeadingResolved;
  const callbacks = useRef({ onReadingPosition, getReadingPosition }); callbacks.current = { onReadingPosition, getReadingPosition };
  const saved = useRef(readingPosition); saved.current = callbacks.current.getReadingPosition?.(noteId, manifest?.revisionId || '') || readingPosition;
  const location = useRef<ReadingViewport | undefined>(undefined);
  const lease = useRef<ReturnType<typeof recentReadingSessions.acquire> | undefined>(undefined);
  const pending = useRef<{ value: { blockAnchor: string; scrollTop: number }; callback: typeof onReadingPosition } | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const stopRestore = useRef(() => {}), restoring = useRef(false);
  const blockForNode = (node: Node | null): number | undefined => {
    if (!node || !root.current?.contains(node)) return;
    const element = node instanceof Element ? node : node.parentElement;
    const slot = element?.closest<HTMLElement>('[data-reading-chunk]');
    return slot ? Number(slot.dataset.readingChunk) : undefined;
  };
  useEffect(() => {
    if (!interactive) {
      setFocusedBlock(undefined); setSelectedBlocks(previous => previous.length ? [] : previous); return;
    }
    // One selection listener per reader, not one per paragraph/formula. Pins
    // follow the CURRENT selection/focus; visited source links cannot pin an
    // ever-growing number of off-screen chunks in memory.
    const sync = () => {
      setFocusedBlock(blockForNode(window.document.activeElement));
      const selection = window.getSelection(), values = selection && !selection.isCollapsed
        ? [blockForNode(selection.anchorNode), blockForNode(selection.focusNode)].filter((value): value is number => value !== undefined) : [];
      setSelectedBlocks(previous => previous.join(',') === values.join(',') ? previous : values);
    };
    // getSelection may force layout of the entire workspace. Do not run it
    // synchronously in the activation commit (or for a reader just abandoned).
    const firstSelection = requestAnimationFrame(sync);
    window.document.addEventListener('selectionchange', sync);
    return () => { cancelAnimationFrame(firstSelection); window.document.removeEventListener('selectionchange', sync); };
  }, [interactive]);
  const flush = () => {
    if (timer.current !== undefined) clearTimeout(timer.current); timer.current = undefined;
    const value = pending.current; pending.current = undefined; value?.callback?.(value.value);
  };
  const remember = (block: number, offset: number, element?: number) => {
    location.current = { block, offset, ...(element === undefined ? {} : { element }) };
    lease.current?.remember(location.current);
    pending.current = { value: { blockAnchor: readingViewportAnchor(location.current), scrollTop: Math.max(0, offset) }, callback: callbacks.current.onReadingPosition };
    if (timer.current === undefined) { flush(); timer.current = setTimeout(flush, 180); }
  };
  useEffect(() => {
    // A newly prepared paragraph need not emit a scroll event. Capture the
    // actual visible paragraph at the navigation boundary, not a loading slot.
    const captureLatest = () => {
      const host = root.current;
      if (activeRef.current && !restoring.current && host?.isConnected && host.clientWidth > 0 && host.clientHeight > 0) capture();
      flush();
    };
    const unregister = registerPendingCapture(captureLatest); window.addEventListener('beforeunload', captureLatest, true);
    return () => { unregister(); window.removeEventListener('beforeunload', captureLatest, true); flush(); };
  }, [noteId, manifest?.revisionId]);
  useEffect(() => { if (active) setEnabled(true); }, [active]);
  // Parsing happens once per changed source/retry, not on scroll, flow clock,
  // or a temporary Agent-panel visibility change. Idle workers do no polling.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false; initialUserTop.current = undefined; setError(''); setDocument(undefined);
    let current: ReturnType<typeof recentReadingSessions.acquire>;
    try { current = recentReadingSessions.acquire(JSON.stringify([noteId, manifest?.revisionId || 'plain']), { content: materialContent, manifest }, attempt > 0); }
    catch { setError('无法启动本地后台解析，请重试；未回退到整篇同步解析。'); return; }
    const session = current.session; lease.current = current;
    void session.ready.then(index => {
      if (cancelled) return;
      const position = saved.current, stored = parseReadingViewport(position?.blockAnchor, position?.scrollTop);
      const prior = location.current || current.getPosition() || stored;
      const anchorBlock = position?.blockAnchor ? index.pages.findIndex(item => item.anchors.includes(position.blockAnchor!)) : -1;
      const block = Math.max(0, Math.min(index.pages.length - 1, prior?.block ?? (anchorBlock >= 0 ? anchorBlock : 0)));
      setNavigation({ block, offset: prior?.offset || 0, ...(prior?.element === undefined ? {} : { element: prior.element }),
        ...(!prior && anchorBlock >= 0 ? { anchor: position?.blockAnchor } : {}),
        ...(!prior && anchorBlock < 0 && position?.scrollTop ? { legacyTop: position.scrollTop } : {}),
        ...(initialUserTop.current !== undefined ? { legacyTop: initialUserTop.current } : {}) });
      setDocument({ index, session });
    }).catch(reason => { if (!cancelled) setError(reason instanceof Error ? reason.message : '长文解析失败'); });
    return () => { cancelled = true; if (lease.current === current) lease.current = undefined; current.release(); };
  }, [noteId, materialContent, manifestKey, enabled, attempt]);

  useLayoutEffect(() => {
    if (!active || !document || !navigation || !root.current || !article.current) return;
    const position: ReadingViewport & { anchor?: string; legacyTop?: number } = appliedNavigation.current !== navigation || !location.current ? navigation
      : location.current;
    appliedNavigation.current = navigation;
    const host = root.current, body = article.current, target = body.children[position.block] as HTMLElement | undefined;
    if (!target) return;
    let stopped = false; restoring.current = true;
    const restore = () => {
      if (stopped) return;
      const anchor = position.anchor ? [...target.querySelectorAll<HTMLElement>('[id]')].find(element => element.id === position.anchor) : undefined;
      const top = anchor ? anchor.getBoundingClientRect().top - host.getBoundingClientRect().top + host.scrollTop
        : readingViewportTop(host, target, position);
      host.scrollTop = position.legacyTop ?? top;
    };
    restore(); const frame = requestAnimationFrame(restore);
    const observer = new ResizeObserver(restore); observer.observe(body);
    const stop = () => { stopped = true; restoring.current = false; cancelAnimationFrame(frame); observer.disconnect(); clearTimeout(expire); };
    const expire = setTimeout(stop, 2000); stopRestore.current = stop;
    return stop;
  }, [active, document, navigation]);
  const capture = () => {
    const host = root.current, body = article.current; if (!host || !body || !body.children.length) return;
    const position = captureReadingViewport(host, body);
    if (position) remember(position.block, position.offset, position.element);
  };
  const jump = (block: number, anchor?: string) => {
    if (!active || !document) return; stopRestore.current(); flush();
    remember(block, 0); setNavigation({ block, offset: 0, anchor });
  };
  useEffect(() => {
    if (!active || !document || !headingRequest || appliedHeading.current === headingRequest.key) return;
    appliedHeading.current = headingRequest.key;
    const section = (document.index.headings || document.index.sections).find(section => noteHeadingMatches(section.title, headingRequest.heading));
    if (section) jump(section.page, section.anchor);
    headingCallback.current?.(Boolean(section));
  }, [active, document, headingRequest?.key, headingRequest?.heading]);
  const sections = document?.index.sections || [];
  useEffect(() => document?.session.subscribeClosed(reason => {
    if (reason.name !== 'AbortError') setError('后台阅读已中断；已显示的正文保留，请重试读取。');
  }), [document?.session]);
  return <ReadingWorkerProvider session={document?.session}><ReadingPresentationContext.Provider value={presentation}><div ref={root} className={`textbook-reader textbook-long-reader ${className}`}
    onFocusCapture={event => setFocusedBlock(blockForNode(event.target))} onBlurCapture={event => setFocusedBlock(blockForNode(event.relatedTarget as Node | null))}
    onWheel={() => stopRestore.current()} onTouchStart={() => stopRestore.current()} onPointerDown={() => stopRestore.current()} onKeyDown={() => stopRestore.current()}
    onScroll={() => { if (active && !document) initialUserTop.current = root.current?.scrollTop; if (active && !restoring.current) capture(); }} onClick={event => {
      const link = (event.target as Element).closest<HTMLAnchorElement>('a[href^="#"]'); if (!link || !document) return;
      const anchor = decodeURIComponent(link.hash.slice(1)), block = document.index.pages.findIndex(item => item.anchors.includes(anchor));
      if (block >= 0) { event.preventDefault(); jump(block, anchor); }
    }}>
    <header className="textbook-reader-header"><span>{manifest ? '项目教材' : title}</span><p>{manifest ? '连续阅读教材，个人复述保留在学习记录中。' : '连续阅读笔记正文。'}</p></header>
    {error && <div className="textbook-format-error" role="alert">{error} <button type="button" onClick={() => setAttempt(value => value + 1)}>重试读取</button></div>}
    {!document ? <div className="textbook-initial-loading" data-reading-initial-placeholder
      style={{ height: `${Math.max(1600, Math.ceil(materialContent.length / 36) * 30)}px` }}>
      <p role="status">{error ? '正文尚未加载，可重试或继续滚动。' : '正在加载正文，可继续上下滚动…'}</p>
    </div> : <>
      {!!document.index.sections.length && <details className="textbook-toc"><summary>章节目录（{document.index.sections.length}）</summary>
        <ol>{sections.map(section => <li key={section.anchor}><button type="button" onClick={() => jump(section.page, section.anchor)}>{section.title}</button></li>)}</ol>
      </details>}
      <article ref={article} className="textbook-prose textbook-long-prose" aria-label={manifest ? '项目教材' : '笔记正文'}
        data-selection-surface={selectionSurface} data-selection-source-id={noteId} data-selection-context-id={noteId} data-selection-source-title={title} data-selection-note-id={noteId}>
        {document.index.pages.map((metadata, number) => <ReadingChunk key={`${document.session.id}:${metadata.key}`} metadata={metadata} number={number} root={root}
          session={document.session} active={active} pinned={focusedBlock === number || selectedBlocks.includes(number)} components={components} />)}
      </article>
    </>}
  </div></ReadingPresentationContext.Provider></ReadingWorkerProvider>;
}
