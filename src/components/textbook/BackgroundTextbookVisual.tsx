import React, { useEffect, useId, useRef, useState } from 'react';
import { renderMermaidInFrame, type MermaidFrameResult } from '../../services/ui/mermaidFrameRenderer';
import { textbookVisualRenderQueue } from '../../services/ui/textbookVisualQueue';
import type { TextbookVisualKind } from '../../services/ui/textbookVisualTypes';
import { createMermaidImage } from '../../services/ui/mermaidImage';
import { useTextbookVisualActivity } from './TextbookVisualGate';
import { useReadingPresentation } from './ReadingPresentation';

type State = { key: string; image: ReturnType<typeof createMermaidImage> };
const cache = new Map<string, MermaidFrameResult>();
let sequence = 0, cacheUnits = 0;
function cached(key: string) { const value = cache.get(key); if (value) { cache.delete(key); cache.set(key, value); } return value; }
function remember(key: string, value: MermaidFrameResult) {
  if (cache.has(key)) cacheUnits -= cache.get(key)!.svg.length;
  cache.delete(key); cache.set(key, value); cacheUnits += value.svg.length;
  while (cache.size > 16 || cacheUnits > 3_000_000) { const first = cache.keys().next().value!; cacheUnits -= cache.get(first)!.svg.length; cache.delete(first); }
}
function forget(key: string) { const value = cache.get(key); if (value) { cacheUnits -= value.svg.length; cache.delete(key); } }
export function BackgroundTextbookVisual({ kind, code, label, height = 340, onStatus }: {
  kind: Exclude<TextbookVisualKind, 'mermaid'>; code: string; label: string; height?: number;
  onStatus?: (status: 'loading' | 'ready' | 'error') => void;
}) {
  const host = useRef<HTMLDivElement>(null), ownedImage = useRef<State | undefined>(undefined);
  const id = useId().replace(/[^\w-]/gu, '');
  const enabled = useTextbookVisualActivity(), presentation = useReadingPresentation();
  const [width, setWidth] = useState(0), [dark, setDark] = useState(false), [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<State>(), [error, setError] = useState('');
  const key = `${kind}:${width}:${dark}:${code}`;
  const ready = state?.key === key;
  useEffect(() => {
    const element = host.current; if (!element) return;
    const observer = new ResizeObserver(entries => {
      const next = Math.floor(entries[0]?.contentRect.width || 0);
      setWidth(next >= 80 ? Math.max(260, Math.min(1000, next)) : 0);
    }); observer.observe(element); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const root = document.documentElement, refresh = () => setDark(root.classList.contains('dark') || root.dataset.theme === 'dark');
    const observer = new MutationObserver(refresh); observer.observe(root, { attributes: true, attributeFilter: ['class', 'data-theme'] }); refresh(); return () => observer.disconnect();
  }, []);
  useEffect(() => () => ownedImage.current?.image.dispose(), []);
  useEffect(() => { onStatus?.(error ? 'error' : ready ? 'ready' : 'loading'); }, [error, ready, onStatus]);
  useEffect(() => {
    if (!enabled || !width || ready) return;
    let cancelled = false, cancelJob = () => {}, cancelPublish = () => {};
    setError('');
    const publish = async (result: MermaidFrameResult) => {
      const image = createMermaidImage(result.svg, result.readingWidth);
      try {
        const decoder = new Image(); decoder.decoding = 'async'; decoder.src = image.url;
        await decoder.decode();
        if (cancelled) { image.dispose(); return; }
        const apply = () => {
          if (cancelled) { image.dispose(); return; }
          ownedImage.current?.image.dispose(); ownedImage.current = { key, image }; setState({ key, image });
        };
        cancelPublish = presentation ? presentation.enqueue(apply) : (() => { apply(); return () => {}; })();
        const previousCancel = cancelPublish; cancelPublish = () => { previousCancel(); if (ownedImage.current?.image !== image) image.dispose(); };
      } catch { image.dispose(); forget(key); if (!cancelled) setError('图像解码失败，可重试'); }
    };
    const begin = () => {
      if (cancelled) return;
      const hit = cached(key); if (hit) { void publish(hit); return; }
      const task = textbookVisualRenderQueue.enqueue(context => renderMermaidInFrame({ id: `visual-${id}-${++sequence}`, code, dark,
        visualKind: kind, width, signal: context.signal })); cancelJob = task.cancel;
      void task.result.then(value => { if (!cancelled) { remember(key, value); void publish(value); } }, reason => {
        if (!cancelled && reason?.name !== 'AbortError') setError(reason instanceof Error ? reason.message : '图形暂不可用');
      });
    };
    // Sliding/resizing updates stay local and responsive; render the latest value.
    const timer = setTimeout(() => { cancelJob = presentation ? presentation.enqueue(begin) : (() => { begin(); return cancelJob; })(); }, state ? 100 : 0);
    return () => { cancelled = true; clearTimeout(timer); cancelJob(); cancelPublish(); };
  }, [key, enabled, width, kind, code, dark, id, attempt, presentation, ready]);
  return <div ref={host} className="textbook-background-visual" style={{ height }} role="img" aria-label={label} aria-busy={!ready && !error} data-visual-kind={kind}>
    {state && <img src={state.image.url} width={state.image.width} height={state.image.height} alt="" aria-hidden="true" decoding="async" />}
    {!ready && !error && <p className="textbook-background-visual-status" role="status">{state ? '正在更新图形…' : '正在加载图形，可继续滚动…'}</p>}
    {error && <div className="textbook-background-visual-status" role="status"><span>图形暂未加载：{error}</span>
      <button type="button" onClick={() => { forget(key); setAttempt(value => value + 1); }}>重试</button></div>}
  </div>;
}
