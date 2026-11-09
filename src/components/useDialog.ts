import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';

const layers: { token: symbol; element: HTMLElement; order: number }[] = [];
let layerOrder = 0;
const layerListeners = new Set<() => void>();
export const subscribeDialogLayers = (listener: () => void) => { layerListeners.add(listener); return () => layerListeners.delete(listener); };
const notifyLayers = () => layerListeners.forEach(listener => listener());
const topLayer = () => layers.filter((layer) => layer.element.isConnected && !layer.element.closest('[inert]'))
  .sort((a, b) => a.order - b.order).at(-1);
export const hasActiveDialog = () => Boolean(topLayer());
/** Embedded editors may handle their own keys only inside the topmost dialog. */
export const isActiveDialogOwner = (element: HTMLElement | null) => Boolean(element && topLayer()?.element.contains(element));
export const isTextInput = (target: EventTarget | null) => target instanceof HTMLElement
  && Boolean(target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]'));
const focusable = (element: HTMLElement) => Array.from(element.querySelectorAll<HTMLElement>(
  'button:not(:disabled), a[href], summary, input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
)).filter((item) => item.tabIndex >= 0 && !item.closest('[inert]') && item.getClientRects().length > 0 && getComputedStyle(item).visibility !== 'hidden');

/** One keyboard owner per dialog layer; background shortcuts must check hasActiveDialog. */
export function useDialog<T extends HTMLElement>(open: boolean, ref: RefObject<T | null>, onClose?: () => void, priority = 50) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const originRef = useRef<HTMLElement | null>(null);
  const restoringRef = useRef(false);
  const restoreFocus = useCallback(() => {
    restoringRef.current = true;
    const origin = originRef.current;
    if (origin?.isConnected && !origin.closest('[inert]')) origin.focus({ preventScroll: true });
  }, []);
  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const element = ref.current;
    const token = Symbol('dialog');
    restoringRef.current = false;
    originRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    layers.push({ token, element, order: priority * 1_000_000 + ++layerOrder });
    notifyLayers();
    (focusable(element)[0] || element).focus({ preventScroll: true });
    const handleKey = (event: KeyboardEvent) => {
      if (topLayer()?.token !== token) return;
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation(); closeRef.current?.();
      } else if (event.key === 'Tab') {
        const items = focusable(element);
        const index = items.indexOf(document.activeElement as HTMLElement);
        if (!items.length) { event.preventDefault(); element.focus(); }
        else if (event.shiftKey && index <= 0) { event.preventDefault(); items.at(-1)!.focus(); }
        else if (!event.shiftKey && (index === -1 || index === items.length - 1)) { event.preventDefault(); items[0].focus(); }
      }
    };
    const handleFocus = (event: FocusEvent) => {
      if (!restoringRef.current && topLayer()?.token === token && !element.contains(event.target as Node)) (focusable(element)[0] || element).focus({ preventScroll: true });
    };
    document.addEventListener('keydown', handleKey, true);
    document.addEventListener('focusin', handleFocus);
    return () => {
      layers.splice(layers.findIndex((layer) => layer.token === token), 1);
      notifyLayers();
      document.removeEventListener('keydown', handleKey, true);
      document.removeEventListener('focusin', handleFocus);
      restoreFocus();
    };
  }, [open, priority, ref, restoreFocus]);
  return { restoreFocus };
}
