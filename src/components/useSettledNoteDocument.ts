import { startTransition, useEffect, useRef, useState } from 'react';
/** Keep selection/header updates immediate. Do not start an abandoned document's
 * parser or rich editor while the user is still choosing another project. */
export function useSettledNoteDocument(noteId: string | undefined, active: boolean) {
  const current = useRef({ noteId, active }); current.current = { noteId, active };
  const [readyId, setReadyId] = useState<string>();
  useEffect(() => {
    if (!noteId || !active) return;
    const timer = setTimeout(() => startTransition(() => setReadyId(previous =>
      current.current.noteId === noteId && current.current.active ? noteId : previous)), 180);
    return () => clearTimeout(timer);
  }, [noteId, active]);
  return Boolean(noteId && readyId === noteId);
}
