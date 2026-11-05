import { useCallback, useEffect, useRef, useState } from 'react';
import { createReviewExitNavigationLock, reviewExitNavigationNotice, type ReviewExitNavigationState, type ReviewExitSaveState } from '../services/ui/reviewExitNavigation';

/** Keep the review mounted from the first save await through an explicit retry. */
export function useReviewExitGuard() {
  const lockRef = useRef<ReturnType<typeof createReviewExitNavigationLock> | null>(null);
  if (!lockRef.current) lockRef.current = createReviewExitNavigationLock();
  const [state, setState] = useState<ReviewExitNavigationState>(null);
  const [notice, setNotice] = useState('');
  const getSnapshot = useCallback(() => lockRef.current!.getSnapshot(), []);
  const updateStatus = useCallback((phase: ReviewExitSaveState, sessionId: string) => {
    if (!lockRef.current!.update(phase, sessionId)) return false;
    setState(lockRef.current!.getSnapshot());
    setNotice('');
    return true;
  }, []);
  const notifyBlocked = useCallback(() => setNotice(reviewExitNavigationNotice(lockRef.current!.getSnapshot())), []);
  const allowNavigation = useCallback(() => {
    if (!lockRef.current!.getSnapshot()) return true;
    notifyBlocked(); return false;
  }, [notifyBlocked]);

  useEffect(() => {
    if (!state) return;
    const token = crypto.randomUUID();
    const marker = 'loginoteReviewSaveLock';
    window.history.pushState({ ...window.history.state, [marker]: token }, '');
    const onPop = () => {
      if (getSnapshot() && window.history.state?.[marker] !== token) {
        window.history.forward(); notifyBlocked();
      }
    };
    const onUnload = (event: BeforeUnloadEvent) => {
      if (!getSnapshot()) return;
      event.preventDefault(); event.returnValue = '';
    };
    const onKey = (event: KeyboardEvent) => {
      if (!getSnapshot()) return;
      if ((event.altKey && ['ArrowLeft', 'ArrowRight'].includes(event.key))
        || ((event.ctrlKey || event.metaKey) && ['k', 'j'].includes(event.key.toLowerCase()))) {
        event.preventDefault(); event.stopImmediatePropagation(); notifyBlocked();
      }
    };
    const onLink = (event: MouseEvent) => {
      if (!getSnapshot()) return;
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
      const href = link?.getAttribute('href');
      if (!link || href?.startsWith('#')) return;
      event.preventDefault(); event.stopImmediatePropagation(); notifyBlocked();
    };
    window.addEventListener('popstate', onPop);
    window.addEventListener('beforeunload', onUnload);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('click', onLink, true);
    document.addEventListener('auxclick', onLink, true);
    return () => {
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('beforeunload', onUnload);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('click', onLink, true);
      document.removeEventListener('auxclick', onLink, true);
      if (window.history.state?.[marker] === token) {
        const { [marker]: ignored, ...rest } = window.history.state;
        void ignored; window.history.replaceState(rest, '');
      }
    };
    // A failed save and its retry share one history sentinel.
  }, [Boolean(state), getSnapshot, notifyBlocked]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 4500);
    return () => clearTimeout(timer);
  }, [notice]);
  return { locked: Boolean(state), updateStatus, getSnapshot, allowNavigation, notice };
}
