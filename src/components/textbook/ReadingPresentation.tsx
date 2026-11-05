import { createContext, useContext, useEffect, useMemo, type RefObject } from 'react';
import { createReadingPresentation, type ReadingPresentation } from '../../services/ui/readingPresentation';
export const ReadingPresentationContext = createContext<ReadingPresentation | null>(null);
export const useReadingPresentation = () => useContext(ReadingPresentationContext);
export function useReaderPresentation(root: RefObject<HTMLElement>, active: boolean) {
  const presentation = useMemo(() => createReadingPresentation({ requestFrame: run => requestAnimationFrame(run),
    cancelFrame: id => cancelAnimationFrame(id), setTimer: (run, ms) => setTimeout(run, ms), clearTimer: id => clearTimeout(id) }), []);
  useEffect(() => {
    const element = root.current; if (!element || !active) return;
    const interact = () => presentation.interact();
    const events = ['wheel', 'touchmove', 'pointerdown', 'keydown', 'scroll'];
    events.forEach(name => element.addEventListener(name, interact, { passive: true }));
    return () => events.forEach(name => element.removeEventListener(name, interact));
  }, [root, active, presentation]);
  useEffect(() => { presentation.resume(); return () => presentation.dispose(); }, [presentation]);
  return presentation;
}
