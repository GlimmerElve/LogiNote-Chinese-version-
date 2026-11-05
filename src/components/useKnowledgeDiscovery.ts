import { useCallback, useEffect, useRef, useState } from 'react';
import type { KnowledgePointCandidate } from '../types';
import type { KnowledgeDiscoveryResult } from '../services/knowledgeScoringService';

/** Read-only recognition; retries and late responses belong to one learning session. */
export function useKnowledgeDiscovery(discover: (text: string) => Promise<KnowledgeDiscoveryResult>, isCurrentSession: (id: string) => boolean) {
  const [state, setState] = useState<{ candidates: KnowledgePointCandidate[]; loading: boolean; error: string }>({ candidates: [], loading: false, error: '' });
  const callbacks = useRef({ discover, isCurrentSession });
  callbacks.current = { discover, isCurrentSession };
  const request = useRef<{ text: string; sessionId: string } | null>(null);
  const version = useRef(0), busy = useRef(false), mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; version.current++; busy.current = false; request.current = null; };
  }, []);
  const run = useCallback(async () => {
    const input = request.current;
    if (!mounted.current || busy.current || !input || !callbacks.current.isCurrentSession(input.sessionId)) return;
    busy.current = true;
    const revision = ++version.current;
    const current = () => mounted.current && version.current === revision && callbacks.current.isCurrentSession(input.sessionId);
    setState((value) => ({ ...value, loading: true }));
    try {
      const result = await callbacks.current.discover(input.text);
      if (current()) setState({ candidates: result.candidates, loading: false, error: result.error || '' });
    } catch {
      if (current()) setState((value) => ({ ...value, loading: false, error: '知识点识别失败。学习内容已保存，可以重新识别。' }));
    } finally { if (version.current === revision) busy.current = false; }
  }, []);
  const start = useCallback((text: string, sessionId: string) => {
    if (!mounted.current || !callbacks.current.isCurrentSession(sessionId)) return;
    if (busy.current && request.current?.sessionId === sessionId) return;
    version.current++; busy.current = false; request.current = { text, sessionId };
    setState({ candidates: [], loading: true, error: '' });
    return run();
  }, [run]);
  const cancel = useCallback(() => {
    version.current++; busy.current = false; request.current = null;
    setState({ candidates: [], loading: false, error: '' });
  }, []);
  return { ...state, start, retry: run, cancel };
}
