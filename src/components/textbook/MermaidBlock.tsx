import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { validateMermaid } from '../../services/textbook/contentSchema';
import { CodeBlock, TextbookFormatFallback } from './CodeBlock';
import { mermaidFailureMessage } from '../../services/ui/lazyAssetError';
import { textbookVisualRenderQueue as renderQueue } from '../../services/ui/textbookVisualQueue';
import { renderMermaidInFrame } from '../../services/ui/mermaidFrameRenderer';
import { normalizeMermaidLineBreaks } from '../../services/ui/mermaidPresentation';
import { createMermaidImage } from '../../services/ui/mermaidImage';
export { TEXTBOOK_MERMAID_CONFIG, textbookMermaidTheme, alignMermaidMindmapLabels, boundedMermaidReadingWidth, normalizeMermaidLineBreaks, sanitizeMermaidSvg } from '../../services/ui/mermaidPresentation';
import { useTextbookVisualActivity } from './TextbookVisualGate';
import { useReadingPresentation } from './ReadingPresentation';

// Mermaid has shared configuration; serializing render avoids cross-instance initialization races.
type CachedMermaid = { svg: string; readingWidth: number };
const mermaidCache = new Map<string, CachedMermaid>();
const activeMermaidKeys = new Map<string, number>();
const MERMAID_CACHE_LIMIT = 24;
let mermaidRenderSequence = 0;

function readCachedMermaid(key: string): CachedMermaid | undefined {
  const cached = mermaidCache.get(key);
  if (!cached) return undefined;
  mermaidCache.delete(key);
  mermaidCache.set(key, cached);
  return cached;
}
function writeCachedMermaid(key: string, value: CachedMermaid): void {
  mermaidCache.delete(key);
  mermaidCache.set(key, value);
  while (mermaidCache.size > MERMAID_CACHE_LIMIT) mermaidCache.delete(mermaidCache.keys().next().value!);
}
function releaseMermaidKey(key: string): void {
  const count = (activeMermaidKeys.get(key) || 1) - 1;
  if (count > 0) activeMermaidKeys.set(key, count); else activeMermaidKeys.delete(key);
}
export function MermaidBlock({ code }: { code: string }) {
  const enabled = useTextbookVisualActivity();
  const presentation = useReadingPresentation();
  const isTimeline = /^\s*(?:%%[^\n]*\n\s*)*timeline\s*(?:\n|$)/u.test(code);
  const id = `textbook-mermaid-${useId().replace(/[^\w-]/gu, '')}`;
  const [result, setResult] = useState<{ svg?: string; readingWidth?: number; error?: string }>({});
  const completed = useRef<{ key: string; value: CachedMermaid } | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  const [image, setImage] = useState<ReturnType<typeof createMermaidImage>>();
  const [nativeSize, setNativeSize] = useState(false);
  const [appearance, setAppearance] = useState(() => {
    if (typeof document === 'undefined') return 'light:default';
    const root = document.documentElement;
    const dark = root.classList.contains('dark') || root.dataset.theme === 'dark';
    return `${dark ? 'dark' : 'light'}:${root.dataset.accent || getComputedStyle(root).getPropertyValue('--ln-accent').trim() || 'default'}`;
  });
  const dark = appearance.startsWith('dark:');
  const prepared = useMemo(() => {
    try { return { safe: normalizeMermaidLineBreaks(validateMermaid(code)), error: undefined }; }
    catch (error) { return { safe: undefined, error: error instanceof Error ? error.message : String(error) }; }
  }, [code]);
  const cacheKey = `${appearance}\u0000${prepared.safe || ''}`;
  useEffect(() => {
    const root = document.documentElement;
    const refresh = () => {
      const isDark = root.classList.contains('dark') || root.dataset.theme === 'dark';
      setAppearance(`${isDark ? 'dark' : 'light'}:${root.dataset.accent || getComputedStyle(root).getPropertyValue('--ln-accent').trim() || 'default'}`);
    };
    const observer = new MutationObserver(refresh);
    observer.observe(root, { attributes: true, attributeFilter: ['class', 'data-theme', 'data-accent', 'style'] });
    refresh();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!result.svg) { setImage(undefined); return; }
    try {
      const value = createMermaidImage(result.svg, result.readingWidth || 960);
      setImage(value); return () => value.dispose();
    } catch (error) { setResult({ error: error instanceof Error ? error.message : '图示图像无法打开' }); }
  }, [result.svg, result.readingWidth]);
  useEffect(() => {
    if (!prepared.safe) return;
    activeMermaidKeys.set(cacheKey, (activeMermaidKeys.get(cacheKey) || 0) + 1);
    return () => releaseMermaidKey(cacheKey);
  }, [cacheKey, prepared.safe]);
  useEffect(() => {
    if (!enabled) return;
    if (!prepared.safe) { setResult({ error: prepared.error }); return; }
    if (completed.current?.key === cacheKey) { setResult(completed.current.value); return; }
    let cancelled = false, cancelPublish = () => {};
    const cached = activeMermaidKeys.get(cacheKey) === 1 ? readCachedMermaid(cacheKey) : undefined;
    if (cached) {
      completed.current = { key: cacheKey, value: cached };
      setResult(cached);
      return;
    }
    setResult({});
    const task = renderQueue.enqueue(async context => {
      context.throwIfCancelled();
      // Mermaid also appends measurement SVGs directly to document.body.
      // A separate document keeps those layouts independent of the textbook's
      // formula-rich DOM; only the completed image enters this page.
      // Keep each render identifiable; cached images may outlive this instance.
      const renderId = `${id}-render-${++mermaidRenderSequence}`;
      const rendered = await renderMermaidInFrame({ id: renderId, code, dark, signal: context.signal });
      context.throwIfCancelled();
      // Validation, text measurement and label alignment belong to the isolated
      // renderer. Never insert its stylesheet or SVG DOM into this document.
      return { svg: rendered.svg, readingWidth: rendered.readingWidth };
    });
    void task.result.then(value => {
      if (cancelled) return;
      writeCachedMermaid(cacheKey, value); completed.current = { key: cacheKey, value };
      const publish = () => { if (!cancelled) setResult(value); };
      if (presentation) cancelPublish = presentation.enqueue(publish); else publish();
    }, error => { if (!cancelled) setResult({ error: mermaidFailureMessage(error) }); });
    return () => { cancelled = true; task.cancel(); cancelPublish(); };
  }, [cacheKey, prepared, code, id, dark, enabled, attempt, presentation]);
  if (result.error) return <div className="textbook-diagram-failure"><TextbookFormatFallback language="mermaid" code={code} message={`图示无法渲染：${result.error}`} />
    <button type="button" onClick={() => setAttempt(value => value + 1)} disabled={!enabled}>重试加载图示</button></div>;
  return <figure className="textbook-diagram">
    <figcaption className="textbook-diagram-toolbar"><span>{isTimeline ? '时间轴 / 阶段演进' : '结构图 / 思维导图'}</span><button type="button" disabled={!result.svg} aria-pressed={nativeSize} aria-controls={`${id}-reading`} onClick={() => setNativeSize((value) => !value)}>{nativeSize ? '适应页面' : '原尺寸阅读'}</button></figcaption>
    {result.svg ? <div id={`${id}-reading`} className={`textbook-diagram-svg${nativeSize ? ' is-native-size' : ''}`} tabIndex={0} role="img"
      aria-label={`教学${isTimeline ? '时间轴' : '结构图'}${nativeSize ? '，原尺寸显示，可使用方向键横向滚动' : '，适应页面显示'}；文字关系可从下方源码读取`}
      style={{ '--textbook-diagram-reading-width': `${result.readingWidth || 960}px` } as React.CSSProperties}>
      {image?.svg === result.svg && <img src={image.url} width={image.width} height={image.height} alt="" aria-hidden="true" decoding="async"
        onError={() => { mermaidCache.delete(cacheKey); completed.current = undefined; setResult({ error: '图示图像解码失败，可重试加载。' }); }} />}
    </div> : <p role="status">正在加载图示…</p>}
    {nativeSize && result.svg && <p className="textbook-diagram-reading-hint" role="status">原尺寸显示：可横向滚动查看，或聚焦图示后使用方向键。</p>}
    <details><summary>查看图示文字与源码</summary><CodeBlock language="mermaid" code={code} /></details>
  </figure>;
}
