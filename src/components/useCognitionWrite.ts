import { useEffect, useRef, useState } from 'react';
import { savePersonalCognition } from '../services/cognition/store';
import type { CognitionFile, CognitionMutation } from '../services/cognition/types';

/** UI-only guard. The store still owns revision checks and the actual transaction. */
export function useCognitionWrite(onSaved: (file: CognitionFile) => void, options: {
  lock?: { current: boolean }; onBusyChange?: (busy: boolean) => void;
} = {}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ownLock = useRef(false);
  const lock = options.lock || ownLock;
  const lifetime = useRef({ active: true, generation: 0 });
  const pendingFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    lifetime.current.active = true;
    return () => { lifetime.current.active = false; lifetime.current.generation++; };
  }, []);
  useEffect(() => {
    if (busy || !pendingFocus.current || typeof document === 'undefined') return;
    const target = pendingFocus.current;
    pendingFocus.current = null;
    if (target.isConnected && !target.matches(':disabled') && lifetime.current.active
      && (document.activeElement === document.body || document.activeElement === document.documentElement)) target.focus({ preventScroll: true });
  }, [busy]);
  async function write(input: CognitionMutation) {
    if (lock.current || !lifetime.current.active) return;
    lock.current = true;
    const generation = lifetime.current.generation;
    const active = () => lifetime.current.active && lifetime.current.generation === generation;
    const origin = typeof document === 'undefined' ? null : document.activeElement;
    pendingFocus.current = origin && origin instanceof HTMLElement ? origin : null;
    setBusy(true); setError(''); options.onBusyChange?.(true);
    try {
      const next = await savePersonalCognition(input);
      if (active()) onSaved(next);
    } catch (e) {
      if (active()) setError(e instanceof Error ? e.message : String(e));
    } finally {
      lock.current = false;
      if (active()) setBusy(false);
      // A store subscription can remove the accepted candidate before this reply.
      // Release its owner's busy indicator as well, without delivering a late result.
      options.onBusyChange?.(false);
    }
  }
  return { busy, error, write, writeLock: lock, clearError: () => setError('') };
}
