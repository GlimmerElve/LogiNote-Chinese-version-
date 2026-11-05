import type { QuickCheckResult } from '../quickCheck';

export interface QuickCheckWriteProgress {
  result?: QuickCheckResult;
  completed?: boolean;
  pending?: Promise<QuickCheckResult>;
}

/** Keep a retry on the same attempt. Revalidate/apply idempotently, then acknowledge
 * the real note writer before showing success. A failed save is not a new test. */
export function commitQuickCheckWrite(progress: QuickCheckWriteProgress, dependencies: {
  persist: (capture: (result: QuickCheckResult) => void) => Promise<void>;
  flush: () => Promise<void>;
}): Promise<QuickCheckResult> {
  if (progress.pending) return progress.pending;
  if (progress.completed && progress.result) return Promise.resolve(progress.result);
  const operation = (async () => {
    await dependencies.persist(result => {
      // Retain this attempt's original delta, but a retry may run after another
      // learning activity. Its current gaps must reflect the latest state.
      progress.result = progress.result
        ? { ...result, headline: progress.result.headline, changed: progress.result.changed }
        : result;
    });
    await dependencies.flush();
    if (!progress.result) throw new Error('简测结果尚未保存，请重试');
    progress.completed = true;
    return progress.result;
  })();
  progress.pending = operation.finally(() => { progress.pending = undefined; });
  return progress.pending;
}
