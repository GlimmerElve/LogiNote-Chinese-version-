import { useEffect, useRef, useState } from 'react';
import { cognitionLeaveRegistry } from '../services/ui/cognitionLeave';

/** Unsaved UI input remains in the mounted editor. No storage or automatic save. */
export function useCognitionLeaveProtection(busy: boolean, writeLock?: { current: boolean }, onBlocked?: () => void) {
  const root = useRef<HTMLDivElement>(null);
  const [dirty, setDirtyState] = useState(false);
  const [showNotice, setShowNotice] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const reveal = useRef(onBlocked);
  reveal.current = onBlocked;
  const state = useRef({ dirty, busy, writeLock });
  state.current = { dirty, busy, writeLock };
  function setDirty(value: boolean) {
    state.current.dirty = value; // Protect the same input-event frame, before React renders.
    setDirtyState(value);
    if (!value) setShowNotice(false);
  }
  useEffect(() => {
    const blocked = () => state.current.dirty || state.current.busy || !!state.current.writeLock?.current;
    const unregister = cognitionLeaveRegistry.register({ blocked, element: () => root.current, notify: () => {
      setShowNotice(true);
      reveal.current?.();
      setFocusRequest(request => request + 1);
    } });
    const onUnload = (event: BeforeUnloadEvent) => {
      if (!blocked()) return;
      event.preventDefault(); event.returnValue = '';
    };
    window.addEventListener('beforeunload', onUnload);
    return () => { unregister(); window.removeEventListener('beforeunload', onUnload); };
  }, []);
  useEffect(() => {
    if (!focusRequest) return;
    const element = root.current;
    if (!element || element.closest('[inert]')) return;
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (parent.tagName === 'DETAILS') (parent as HTMLDetailsElement).open = true;
    }
    // A selector list follows DOM order, so it can choose Reload before the draft.
    const target = element.querySelector<HTMLElement>('textarea:not(:disabled)')
      || element.querySelector<HTMLElement>('button:not(:disabled)') || element;
    // Optional draft fields can live inside a closed disclosure in the editor.
    for (let parent = target.parentElement; parent && parent !== element; parent = parent.parentElement) {
      if (parent.tagName === 'DETAILS') (parent as HTMLDetailsElement).open = true;
    }
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  }, [focusRequest]);
  const notice = !showNotice ? '' : busy || writeLock?.current
    ? '正在保存理解，请等结果返回后再离开。'
    : dirty ? '当前理解有未保存的修改，请先保存或取消编辑，再离开。' : '';
  return { root, dirty, setDirty, notice };
}
