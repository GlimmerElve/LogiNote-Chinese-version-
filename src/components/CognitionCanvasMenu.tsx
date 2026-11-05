import React, { useLayoutEffect, useRef } from 'react';

export interface CognitionCanvasAction {
  label: string;
  icon?: React.ReactNode;
  disabled?: boolean;
  danger?: boolean;
  run: () => void;
}

/** A transient canvas menu; actions always enter the existing reviewed write flows. */
export function CognitionCanvasMenu({ x, y, label, actions, origin, onClose }: {
  x: number; y: number; label: string; actions: CognitionCanvasAction[];
  origin: HTMLElement | SVGElement | null; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose); close.current = onClose;
  useLayoutEffect(() => {
    const menu = ref.current!;
    const bounds = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8))}px`;
    (menu.querySelector<HTMLButtonElement>('button:not(:disabled)') || menu).focus({ preventScroll: true });
    const dismiss = (event: Event) => { if (!menu.contains(event.target as Node)) close.current(); };
    const resize = () => close.current();
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('focusin', dismiss);
    window.addEventListener('resize', resize);
    // Touch browsers may scroll a focused trigger into view after opening.
    // Dismiss on user scrolling gestures, not those delayed browser scroll events.
    window.addEventListener('wheel', dismiss, { capture: true, passive: true });
    window.addEventListener('touchmove', dismiss, { capture: true, passive: true });
    return () => {
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('focusin', dismiss);
      window.removeEventListener('resize', resize);
      window.removeEventListener('wheel', dismiss, true);
      window.removeEventListener('touchmove', dismiss, true);
    };
  }, [x, y]);
  function dismiss() { close.current(); if (origin?.isConnected) origin.focus({ preventScroll: true }); }
  return <div ref={ref} className="cm-canvas-menu" role="menu" tabIndex={-1} aria-label={label} style={{ left: x, top: y }}
    onContextMenu={event => event.preventDefault()} onKeyDown={event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); dismiss(); }
      if (event.key === 'Tab') { event.preventDefault(); dismiss(); }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    }}>
    <span className="cm-canvas-menu-title">{label}</span>
    {actions.map(action => <button key={action.label} type="button" role="menuitem" disabled={action.disabled}
      className={action.danger ? 'cm-danger' : undefined} onClick={() => { dismiss(); action.run(); }}>
      {action.icon}{action.label}
    </button>)}
  </div>;
}
