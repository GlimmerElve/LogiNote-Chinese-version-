import React, { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Components } from 'react-markdown';
import type { ReadingIndex } from '../../services/textbook/readingDocument';
import type { ReadingDocumentSession } from '../../services/textbook/readingDocumentClient';
import type { TextbookManifest } from '../../services/textbook/types';
import { ReadingChunk } from './LongDocumentReader';
import { ReadingPresentationContext, useReaderPresentation, useReadingPresentation } from './ReadingPresentation';
import { ReadingWorkerBoundary, useReadingWorker } from './ReadingWorkerContext';

/** A closed answer owns no body, child session or formula DOM. */
export function ReadingAnswer({ title, children }: { title: string; children: ReactNode }) {
  const [opened, setOpened] = useState(false);
  return <details className="textbook-answer" onToggle={event => setOpened(event.currentTarget.open)}>
    <summary>{title}</summary>{opened && children}
  </details>;
}

interface EmbeddedReadingBodyProps {
  body: string;
  manifest?: TextbookManifest;
  components?: Components;
  active?: boolean;
  fragmentKind?: 'textbook' | 'note';
}
function nearestReadingViewport(element: HTMLElement): HTMLElement | null {
  const reader = element.closest<HTMLElement>('.textbook-reader');
  if (reader) return reader;
  let ancestor = element.parentElement;
  while (ancestor && ancestor !== document.documentElement) {
    const style = getComputedStyle(ancestor);
    if (/(auto|scroll|overlay)/u.test(`${style.overflowY} ${style.overflow}`)) return ancestor;
    ancestor = ancestor.parentElement;
  }
  return null;
}

export function EmbeddedReadingBody(props: EmbeddedReadingBodyProps) {
  return <ReadingWorkerBoundary><ReadingFragment {...props} /></ReadingWorkerBoundary>;
}

/** Raw annotation/lesson Markdown is prepared in the surface's existing Worker.
 * Its slots share the outer viewport, never create an inner scrollbar, and use
 * a separate slot attribute so outer selection/position capture stays correct. */
function ReadingFragment({ body, manifest, components, active = true, fragmentKind = 'textbook' }: EmbeddedReadingBodyProps) {
  const worker = useReadingWorker();
  const host = useRef<HTMLDivElement>(null), viewport = useRef<HTMLElement | null>(null);
  const id = useId().replace(/[^\w-]/gu, '');
  const anchorPrefix = `reading-fragment-${id}`;
  const manifestKey = useMemo(() => JSON.stringify(manifest) || '', [manifest]);
  const [viewportReady, setViewportReady] = useState(false), [windowRoot, setWindowRoot] = useState(false);
  const [enabled, setEnabled] = useState(active), [attempt, setAttempt] = useState(0);
  const [documentState, setDocumentState] = useState<{
    body: string; manifestKey: string; kind: string; owner: typeof worker; session: ReadingDocumentSession; index: ReadingIndex;
  }>();
  const [error, setError] = useState('');
  const [navigation, setNavigation] = useState<{ page: number; anchor: string }>();
  const [focusedPage, setFocusedPage] = useState<number>();
  const [selectedPages, setSelectedPages] = useState<number[]>([]);
  const inheritedPresentation = useReadingPresentation();
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    viewport.current = nearestReadingViewport(element);
    setWindowRoot(!viewport.current); setViewportReady(true);
  }, []);
  const localPresentation = useReaderPresentation(viewport, active && !inheritedPresentation);
  const presentation = inheritedPresentation || localPresentation;
  useEffect(() => {
    if (!active || !viewportReady || !windowRoot || inheritedPresentation) return;
    const interact = () => localPresentation.interact();
    const events = ['wheel', 'touchmove', 'pointerdown', 'keydown', 'scroll'];
    events.forEach(name => window.addEventListener(name, interact, { passive: true }));
    return () => events.forEach(name => window.removeEventListener(name, interact));
  }, [active, viewportReady, windowRoot, inheritedPresentation, localPresentation]);
  useEffect(() => { if (active) setEnabled(true); }, [active]);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let closed = false;
    let session: ReadingDocumentSession;
    setDocumentState(undefined); setError(''); setNavigation(undefined);
    try { session = worker.getFragment({ content: body, contextManifest: manifest, anchorPrefix, fragmentKind }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '无法启动片段后台解析'); return; }
    const unsubscribe = session.subscribeClosed(reason => {
      if (cancelled || reason.name === 'AbortError') return;
      closed = true;
      setError(reason.message || '共享后台阅读已停止，请重新读取正文');
    });
    void session.ready.then(index => {
      if (!cancelled && !closed) setDocumentState({ body, manifestKey, kind: fragmentKind, owner: worker, session, index });
    }, reason => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : '片段暂未准备完成');
    });
    return () => { cancelled = true; unsubscribe(); session.dispose(); };
  }, [body, manifestKey, anchorPrefix, fragmentKind, worker, enabled, attempt]);
  const current = documentState?.body === body && documentState.manifestKey === manifestKey
    && documentState.kind === fragmentKind && documentState.owner === worker ? documentState : undefined;
  const pageForNode = (node: Node | null): number | undefined => {
    if (!node || !host.current?.contains(node)) return;
    const element = node instanceof Element ? node : node.parentElement;
    let slot = element?.closest<HTMLElement>('[data-nested-reading-chunk]');
    while (slot && slot.closest('[data-reading-fragment]') !== host.current)
      slot = slot.parentElement?.closest<HTMLElement>('[data-nested-reading-chunk]');
    return slot ? Number(slot.dataset.nestedReadingChunk) : undefined;
  };
  useEffect(() => {
    if (!active || !current) { setFocusedPage(undefined); setSelectedPages(previous => previous.length ? [] : previous); return; }
    const sync = () => {
      setFocusedPage(pageForNode(document.activeElement));
      const selection = window.getSelection();
      const pages = selection && !selection.isCollapsed
        ? [pageForNode(selection.anchorNode), pageForNode(selection.focusNode)].filter((value): value is number => value !== undefined) : [];
      setSelectedPages(previous => previous.join(',') === pages.join(',') ? previous : pages);
    };
    const frame = requestAnimationFrame(sync);
    document.addEventListener('selectionchange', sync);
    return () => { cancelAnimationFrame(frame); document.removeEventListener('selectionchange', sync); };
  }, [active, current?.session]);
  useEffect(() => {
    if (!active || !current || !navigation || !host.current) return;
    const element = host.current;
    let stopped = false;
    const restore = () => {
      if (stopped) return;
      const target = [...element.querySelectorAll<HTMLElement>('[id]')].find(node => node.id === navigation.anchor);
      if (!target) return;
      const root = viewport.current;
      if (root) root.scrollTop += target.getBoundingClientRect().top - root.getBoundingClientRect().top;
      else target.scrollIntoView({ block: 'start' });
      stop();
    };
    const stop = () => { stopped = true; observer.disconnect(); clearTimeout(timer); };
    const observer = new MutationObserver(restore);
    observer.observe(element, { childList: true, subtree: true });
    const timer = setTimeout(stop, 2000);
    restore();
    return stop;
  }, [active, current, navigation]);
  return <ReadingPresentationContext.Provider value={presentation}><div ref={host} className="textbook-reading-fragment"
    data-reading-fragment={anchorPrefix} aria-busy={!current && !error}
    onFocusCapture={event => setFocusedPage(pageForNode(event.target))}
    onBlurCapture={event => setFocusedPage(pageForNode(event.relatedTarget as Node | null))} onClick={event => {
      const link = (event.target as Element).closest<HTMLAnchorElement>('a[href^="#"]');
      if (!current || !link) return;
      let anchor: string;
      try { anchor = decodeURIComponent(link.hash.slice(1)); } catch { return; }
      const page = current.index.pages.findIndex(item => item.anchors.includes(anchor));
      if (page < 0) return;
      event.preventDefault(); event.stopPropagation(); setNavigation({ page, anchor });
    }}>
    {error ? <div className="textbook-format-error" role="status"><p>正文片段暂未加载：{error}</p>
      {worker.canRetryFragment() ? <button type="button" onClick={() => setAttempt(value => value + 1)}>重试读取</button>
        : <p>共享后台阅读已停止，请使用上方“重试读取”重新准备正文，或重新打开当前阅读页面。</p>}
      <ReadingAnswer title="查看保留的原文"><pre>{body}</pre></ReadingAnswer>
    </div> : !current || !viewportReady ? <div className="textbook-fragment-loading" role="status">正在准备正文，可继续滚动…</div>
      : current.index.pages.map((metadata, number) => <ReadingChunk key={`${current.session.id}:${metadata.key}`}
        metadata={metadata} number={number} root={viewport} session={current.session} active={active}
        pinned={navigation?.page === number || focusedPage === number || selectedPages.includes(number)} components={components} nested windowRoot={windowRoot} />)}
  </div></ReadingPresentationContext.Provider>;
}
