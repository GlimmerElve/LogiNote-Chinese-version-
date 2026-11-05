import { useEffect, useState } from 'react';
import { listTextbookJobs } from '../../services/textbook/jobClient';
import type { TextbookProgress } from '../../services/textbook/generationTypes';
import { cachedTextbookProgress, subscribeTextbookProgress } from '../../services/textbook/progress';

/** Restore public progress on reopen/restart. Completed snapshots remain queryable
 * history, but are not a live card pinned below every subsequent conversation. */
export function useTextbookProgress(projectNoteId: string | undefined, open: boolean) {
  const [progress, setProgress] = useState<TextbookProgress | null>(null);
  const [restoreError, setRestoreError] = useState('');
  useEffect(() => {
    setProgress(projectNoteId ? cachedTextbookProgress(projectNoteId) : null); setRestoreError('');
    if (!projectNoteId || !open) return;
    let disposed = false, reading = false, revision = 0;
    const off = subscribeTextbookProgress((value) => { if (value?.projectNoteId === projectNoteId) { revision++; setProgress(value); } });
    const restore = async () => {
      if (reading) return; reading = true; const before = revision;
      try {
        const jobs = await listTextbookJobs(projectNoteId);
        // Select first, then hide published progress during render. Filtering
        // published jobs here would resurrect an obsolete failed duplicate.
        const latest = jobs.find((job) => job.progress?.running) || jobs.find((job) => job.preferred) || jobs[0];
        if (!disposed && before === revision) { setProgress(latest?.progress || null); setRestoreError(''); }
      } catch (error) { if (!disposed) setRestoreError(error instanceof Error ? error.message : '暂时无法读取'); }
      finally { reading = false; }
    };
    void restore(); const timer = window.setInterval(() => void restore(), 3000);
    return () => { disposed = true; off(); window.clearInterval(timer); };
  }, [projectNoteId, open]);
  // Filter during render too: the previous project's state must never flash
  // between a focus change and effect cleanup, or offer a stale resume action.
  // Only durable publication ends this card's lifecycle. All chapters saved or
  // quality passed is not enough: a failed note save must retain its recovery UI.
  return { progress: progress && progress.projectNoteId === projectNoteId && progress.jobStage !== 'published' ? progress : null, restoreError };
}
