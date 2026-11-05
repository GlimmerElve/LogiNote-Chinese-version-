import { useEffect, useRef, useState, type RefObject } from 'react';
import { registerEditorInputLeave } from '../services/ui/editorInputLeave';

/** Pending readers use synchronous event refs. Only a blocked leave updates UI;
 * no autosave, forced blur, selection rewrite or keyboard/history interception. */
export function useEditorInputLeave(pending: () => string | null, element: RefObject<HTMLElement>, enabled = true) {
  const latest = useRef(pending); latest.current = pending;
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (!enabled) return;
    return registerEditorInputLeave({ pending: () => latest.current(), element: () => element.current, notify: setNotice });
  }, [element, enabled]);
  return { notice, clearNotice: () => setNotice('') };
}
