import { useEffect, useRef } from 'react';
import type { NoteSaveState } from '../services/ui/saveFeedback';

/** Read pending edits synchronously: React's pending render may not have committed yet. */
export function useNoteSaveLeaveProtection(state: NoteSaveState, pending: { current: unknown | null }) {
  const latestState = useRef(state); latestState.current = state;
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (pending.current === null && latestState.current === 'saved') return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [pending]);
}
