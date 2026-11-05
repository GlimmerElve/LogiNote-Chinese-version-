import { useCallback, useEffect, useRef, useState } from 'react';
import { EMPTY_CONTEXT_NAVIGATION, moveContextNavigation, openContextNote, type ContextNavigationState } from '../services/ui/contextNavigation';
import { hasActiveDialog } from './useDialog';
import { allowCognitionLeave } from '../services/ui/cognitionLeave';

const HISTORY_KEY = 'loginoteNoteVisit';
const immediately = (commit: () => void) => commit();

/** Keep app back/forward and browser back/forward on the same reference branch. */
export function useContextNavigation(beforeNavigate: (commit: () => void, cancel?: () => void) => void = immediately) {
  const [state, setState] = useState<ContextNavigationState>(EMPTY_CONTEXT_NAVIGATION);
  const stateRef = useRef(state);
  const sessionRef = useRef(crypto.randomUUID());
  const sourceFocusRef = useRef<HTMLElement | null>(null);
  const pageFocusRef = useRef(new Map<number, HTMLElement>());
  const before = useRef(beforeNavigate); before.current = beforeNavigate;
  const historyRollbackPending = useRef(false);
  const requestedNavigation = useRef(0);
  const historyTraversalPending = useRef(false);
  // Agent tool loops may retain a previous render's context; read the live branch.
  const getSnapshot = useCallback(() => stateRef.current, []);
  const historyData = useCallback((cursor: number) => ({
    ...window.history.state,
    [HISTORY_KEY]: { session: sessionRef.current, cursor },
  }), []);
  const commit = useCallback((next: ContextNavigationState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const open = useCallback((noteId: string, projectContextId: string | null = null, heading?: string) => {
    const visible = stateRef.current.pages[stateRef.current.cursor];
    if (visible?.noteId === noteId && visible.projectContextId === projectContextId && visible.heading === heading) return;
    if (!allowCognitionLeave()) return;
    const request = ++requestedNavigation.current;
    before.current(() => {
      if (request !== requestedNavigation.current) return;
      const previous = stateRef.current;
      const next = openContextNote(previous, { key: crypto.randomUUID(), noteId, projectContextId, ...(heading ? { heading } : {}) });
      if (next === previous) return;
      if (!allowCognitionLeave()) return;
      if (previous.cursor === -1) sourceFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (document.activeElement instanceof HTMLElement) pageFocusRef.current.set(previous.cursor, document.activeElement);
      window.history.replaceState(historyData(previous.cursor), '');
      window.history.pushState(historyData(next.cursor), '');
      commit(next);
    });
  }, [commit, historyData]);

  const move = useCallback((cursor: number) => {
    if (moveContextNavigation(stateRef.current, cursor) === stateRef.current) return;
    if (!allowCognitionLeave()) return;
    const request = ++requestedNavigation.current;
    before.current(() => {
      if (request !== requestedNavigation.current || historyTraversalPending.current) return;
      const previous = stateRef.current;
      const next = moveContextNavigation(previous, cursor);
      if (next === previous) return;
      if (!allowCognitionLeave()) return;
      if (document.activeElement instanceof HTMLElement) pageFocusRef.current.set(previous.cursor, document.activeElement);
      const marker = window.history.state?.[HISTORY_KEY];
      if (marker?.session === sessionRef.current && marker.cursor === previous.cursor) {
        historyTraversalPending.current = true;
        window.history.go(cursor - previous.cursor);
      } else {
        window.history.replaceState(historyData(cursor), '');
        commit(next);
      }
    });
  }, [commit, historyData]);

  const reset = useCallback(() => {
    if (!stateRef.current.pages.length) return;
    historyTraversalPending.current = false;
    sessionRef.current = crypto.randomUUID();
    const { [HISTORY_KEY]: ignored, ...rest } = window.history.state || {};
    void ignored;
    window.history.replaceState(rest, '');
    commit(EMPTY_CONTEXT_NAVIGATION);
    sourceFocusRef.current = null;
    pageFocusRef.current.clear();
  }, [commit]);

  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      historyTraversalPending.current = false;
      const marker = event.state?.[HISTORY_KEY];
      if (marker?.session !== sessionRef.current) return;
      const request = ++requestedNavigation.current;
      if (marker.cursor === stateRef.current.cursor) { historyRollbackPending.current = false; return; }
      if (marker.cursor !== stateRef.current.cursor && !allowCognitionLeave()) {
        window.history.go(stateRef.current.cursor - marker.cursor);
        return;
      }
      const rollback = () => {
        if (request !== requestedNavigation.current) return;
        const current = window.history.state?.[HISTORY_KEY];
        if (current?.session !== sessionRef.current || current.cursor === stateRef.current.cursor || historyRollbackPending.current) return;
        historyRollbackPending.current = true; window.history.go(stateRef.current.cursor - current.cursor);
      };
      before.current(() => {
        if (request !== requestedNavigation.current) return;
        const current = window.history.state?.[HISTORY_KEY];
        if (current?.session !== sessionRef.current || current.cursor !== marker.cursor) return;
        if (!allowCognitionLeave()) { rollback(); return; }
        commit(moveContextNavigation(stateRef.current, marker.cursor));
      }, rollback);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || hasActiveDialog()) return;
      const current = stateRef.current;
      if (event.key === 'Escape' && current.cursor >= 0 && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        event.preventDefault(); move(-1); return;
      }
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key === 'ArrowLeft' && current.cursor >= 0) {
        event.preventDefault(); move(current.cursor - 1);
      } else if (event.key === 'ArrowRight' && current.cursor < current.pages.length - 1) {
        event.preventDefault(); move(current.cursor + 1);
      }
    };
    window.addEventListener('popstate', onPopState);
    window.addEventListener('keydown', onKeyDown);
    return () => { requestedNavigation.current++; window.removeEventListener('popstate', onPopState); window.removeEventListener('keydown', onKeyDown); };
  }, [commit, move]);

  useEffect(() => {
    const pageOrigin = pageFocusRef.current.get(state.cursor);
    if (state.cursor >= 0 && pageOrigin?.isConnected && !pageOrigin.closest('[inert]')) pageOrigin.focus({ preventScroll: true });
    if (state.cursor === -1 && state.pages.length) {
      const origin = sourceFocusRef.current;
      const fallback = document.querySelector<HTMLElement>('[data-context-source]:not([inert]) [data-context-source-forward]');
      (origin?.isConnected && !origin.closest('[inert]') ? origin : fallback)?.focus({ preventScroll: true });
    }
  }, [state.cursor, state.pages.length]);

  return { ...state, active: state.cursor >= 0, open, move, reset, getSnapshot };
}
