import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { hasActiveDialog, subscribeDialogLayers } from '../useDialog';

/** Native WebContentsView is separate from the reader renderer. */
export function InteractiveFigurePane({ html, active, onRetry }: { html: string; active: boolean; onRetry?: () => void }) {
  const element = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  const [started, setStarted] = useState(active);
  const [displayAttempt, setDisplayAttempt] = useState(0);
  const activeRef = useRef(active); activeRef.current = active;
  const resizeRef = useRef<() => void>(() => {});
  const dialogOpen = useSyncExternalStore(subscribeDialogLayers, hasActiveDialog, () => false);
  useEffect(() => { if (active) setStarted(true); }, [active]);
  useEffect(() => {
    if (!started) return;
    const api = window.electronAPI?.interactiveFigure, target = element.current;
    if (!api || !target) { setError('当前环境不支持交互图'); return; }
    let cancelled = false, opened = false, opening = false, frame = 0;
    setError('');
    const bounds = () => {
      const rect = target.getBoundingClientRect(), x = Math.max(0, Math.round(rect.left)), y = Math.max(0, Math.round(rect.top));
      return { x, y, width: Math.min(Math.round(rect.right), window.innerWidth) - x, height: Math.min(Math.round(rect.bottom), window.innerHeight) - y, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight };
    };
    const valid = (value: ReturnType<typeof bounds>) => value.width > 0 && value.height > 0;
    const resize = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => {
      const value = bounds();
      if (!valid(value) || !activeRef.current) return;
      if (opened) { void api.bounds(value).catch(() => {}); return; }
      if (opening) return;
      opening = true;
      void api.open({ html, bounds: value }).then(() => {
        if (!cancelled) { opened = true; setError(''); void api.visible(activeRef.current && !hasActiveDialog()).catch(() => {}); resize(); }
      }).catch(reason => { if (!cancelled) setError(reason instanceof Error ? reason.message : '交互图暂不可用'); }).finally(() => { opening = false; });
    }); };
    resizeRef.current = resize;
    const observer = new ResizeObserver(resize); observer.observe(target); window.addEventListener('resize', resize);
    const unsubscribe = api.onFailure(reason => { if (!cancelled) setError(reason); });
    resize();
    return () => { cancelled = true; cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener('resize', resize);
      resizeRef.current = () => {}; unsubscribe(); void api.close().catch(() => {}); };
  }, [html, started, displayAttempt]);
  useEffect(() => { void window.electronAPI?.interactiveFigure?.visible(active && !dialogOpen).catch(() => {}); if (active) resizeRef.current(); }, [active, html, dialogOpen, started]);
  return <div className="interactive-figure-pane" ref={element}>{error && <div className="focus-flow-figure-status" role="alert"><p>{error}</p>
    <button type="button" onClick={() => setDisplayAttempt(value => value + 1)}>重新打开交互图</button>{onRetry && <button type="button" onClick={onRetry}>重新生成交互图</button>}</div>}</div>;
}
