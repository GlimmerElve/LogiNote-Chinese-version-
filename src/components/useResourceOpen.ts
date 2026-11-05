import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ResourceItem } from '../types';
import { openLearningResource } from '../services/ui/openLearningResource';

export interface ResourceOpenFeedback {
  kind: 'opening' | 'error' | 'opened';
  resource: ResourceItem;
}

export function useResourceOpen(scope: string, open = openLearningResource) {
  const [feedback, setFeedback] = useState<ResourceOpenFeedback | null>(null);
  const [pending, setPending] = useState(false);
  const mounted = useRef(false);
  const generation = useRef(0);
  const lock = useRef(false);
  const currentScope = useRef(scope);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  useLayoutEffect(() => {
    currentScope.current = scope;
    generation.current++;
    setFeedback(null);
  }, [scope]);

  const start = async (resource: ResourceItem, onOpened?: () => void) => {
    if (lock.current) return false;
    lock.current = true;
    setPending(true);
    const version = generation.current;
    const owner = scope;
    const isCurrent = () => mounted.current && version === generation.current && owner === currentScope.current;
    setFeedback({ kind: 'opening', resource });
    try {
      await open(resource);
      if (!isCurrent()) return false;
      onOpened?.();
      setFeedback({ kind: 'opened', resource });
      return true;
    } catch {
      if (isCurrent()) setFeedback({ kind: 'error', resource });
      return false;
    } finally {
      lock.current = false;
      if (mounted.current) setPending(false);
    }
  };
  return { feedback, pending, isBusy: () => lock.current, start };
}
