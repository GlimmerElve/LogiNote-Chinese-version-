import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { createReadingDocumentSession, type ReadingDocumentSession } from '../../services/textbook/readingDocumentClient';
import type { ReadingInput } from '../../services/textbook/readingDocument';

interface ReadingWorker {
  getSession(): ReadingDocumentSession;
  getFragment(input: ReadingInput): ReadingDocumentSession;
  canRetryFragment(): boolean;
}
const ReadingWorkerContext = createContext<ReadingWorker | null>(null);

/** A surface owns at most one transport. Long readers lend their existing one;
 * short/progressive/editor surfaces create one only when a fragment is opened. */
export function ReadingWorkerProvider({ session, children }: { session?: ReadingDocumentSession; children: ReactNode }) {
  const inherited = useContext(ReadingWorkerContext);
  const owned = useRef<ReadingDocumentSession | undefined>(undefined);
  const getSession = useCallback(() => {
    if (session) {
      if (session.isDisposed) throw new Error('共享阅读会话已关闭，请重新打开当前阅读页面');
      return session;
    }
    if (inherited) return inherited.getSession();
    if (!owned.current || owned.current.isDisposed) {
      owned.current = createReadingDocumentSession({ content: '' });
      // Fragment callers observe their own errors. The empty transport's ready
      // promise must not become an unrelated unhandled rejection on shutdown.
      void owned.current.ready.catch(() => {});
    }
    return owned.current;
  }, [session, inherited]);
  const value = useMemo<ReadingWorker>(() => ({ getSession, getFragment: input => getSession().fragment(input),
    canRetryFragment: () => session ? !session.isDisposed : inherited ? inherited.canRetryFragment() : true }), [getSession, session, inherited]);
  useEffect(() => () => { owned.current?.dispose(); owned.current = undefined; }, []);
  return <ReadingWorkerContext.Provider value={value}>{children}</ReadingWorkerContext.Provider>;
}

/** Standalone fence previews retain a safe fallback; a normal reading surface
 * already supplies its shared provider, so nested annotations never own Workers. */
export function ReadingWorkerBoundary({ children }: { children: ReactNode }) {
  const inherited = useContext(ReadingWorkerContext);
  return inherited ? <>{children}</> : <ReadingWorkerProvider>{children}</ReadingWorkerProvider>;
}

export function useReadingWorker(): ReadingWorker {
  const value = useContext(ReadingWorkerContext);
  if (!value) throw new Error('阅读片段缺少共享后台解析上下文');
  return value;
}
