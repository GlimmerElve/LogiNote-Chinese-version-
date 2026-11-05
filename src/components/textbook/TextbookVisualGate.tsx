import React, { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useReadingPresentation } from './ReadingPresentation';

const TextbookVisualActivity = createContext(true);
export const useTextbookVisualActivity = () => useContext(TextbookVisualActivity);

type IdleWindow = Window & typeof globalThis & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

type ActivationJob = { cancelled: boolean; activate: () => void };
const activationQueue: ActivationJob[] = [];
let activationPending = false;

function drainActivationQueue(): void {
  if (activationPending) return;
  while (activationQueue[0]?.cancelled) activationQueue.shift();
  const next = activationQueue.shift();
  if (!next) return;
  activationPending = true;
  const browser = window as IdleWindow;
  const run = () => {
    if (!next.cancelled) next.activate();
    // Give the newly mounted visual one frame before mounting another expensive runtime.
    window.setTimeout(() => {
      activationPending = false;
      drainActivationQueue();
    }, 64);
  };
  if (browser.requestIdleCallback) browser.requestIdleCallback(run, { timeout: 420 });
  else window.setTimeout(run, 16);
}

function enqueueActivation(activate: () => void): () => void {
  const job: ActivationJob = { cancelled: false, activate };
  activationQueue.push(job);
  drainActivationQueue();
  return () => { job.cancelled = true; };
}

function scrollContainer(element: HTMLElement): Element | null {
  let parent = element.parentElement;
  while (parent && parent !== document.documentElement) {
    const style = getComputedStyle(parent);
    if (/(auto|scroll|overlay)/u.test(`${style.overflowY} ${style.overflow}`)) return parent;
    parent = parent.parentElement;
  }
  return null;
}

export interface TextbookVisualGateProps {
  children: ReactNode;
  label: string;
  minHeight?: number;
  active?: boolean;
}

/**
 * Keeps prose synchronous while warming expensive diagrams before they enter the viewport.
 * Visuals mount one at a time during idle time, so opening a long textbook does not block input.
 */
export function TextbookVisualGate({ children, label, minHeight = 288, active: enabled = true }: TextbookVisualGateProps) {
  const host = useRef<HTMLDivElement>(null);
  const [nearViewport, setNearViewport] = useState(() => typeof window === 'undefined' || typeof IntersectionObserver === 'undefined');
  const [active, setActive] = useState(false);
  const presentation = useReadingPresentation();

  useEffect(() => {
    if (!enabled) { setNearViewport(false); return; }
    const element = host.current;
    if (!element || active) return;
    if (typeof IntersectionObserver === 'undefined') { setNearViewport(true); return; }
    const observer = new IntersectionObserver((entries) => {
      // Leaving the warm-up area cancels work that has not started yet.
      setNearViewport(entries.some((entry) => entry.isIntersecting));
    }, { root: scrollContainer(element), rootMargin: '400px 0px', threshold: 0.01 });
    observer.observe(element);
    return () => observer.disconnect();
  }, [active, enabled]);

  useEffect(() => {
    if (!enabled || !nearViewport || active) return;
    return presentation ? presentation.enqueue(() => setActive(true)) : enqueueActivation(() => setActive(true));
  }, [active, nearViewport, enabled, presentation]);

  return <div ref={host} className={`textbook-visual-gate${active ? ' is-active' : ''}`} style={{ '--textbook-visual-min-height': `${minHeight}px` } as React.CSSProperties}>
    {active ? <TextbookVisualActivity.Provider value={enabled}>{children}</TextbookVisualActivity.Provider> : <div className={`textbook-visual-placeholder${nearViewport ? ' is-preparing' : ''}`} role="status" aria-live="polite" aria-label={nearViewport ? `正在准备${label}` : `滚动到附近时加载${label}`}>
      <span aria-hidden="true" />
      <small>{nearViewport ? `正在准备${label}…` : `滚动到附近时加载${label}`}</small>
    </div>}
  </div>;
}

