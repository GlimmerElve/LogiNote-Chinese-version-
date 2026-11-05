import type { TextbookJob } from './generationTypes';
import { textbookCost } from './cost';

/** A provider's image rejection changes the transport, not the approved retry
 * allowance. Rebind only an exact input fingerprint, retaining the stricter row
 * if both transport variants were recorded by an older app. */
export function rebindTextbookModelAttempt(job: TextbookJob, fromHash: string, toHash: string) {
  const attempts = job.checkpoint.modelAttempts || [];
  const source = attempts.find(item => item.inputHash === fromHash);
  const target = attempts.find(item => item.inputHash === toHash);
  if (fromHash === toHash || !source) return target;
  if (target && (target.stage !== source.stage || target.chapterId !== source.chapterId)) {
    throw new Error('教材请求检查点阶段不一致；原草稿保留，不追加模型请求');
  }
  // Old jobs derive their ledger from these rows. Snapshot it BEFORE merging,
  // otherwise deleting an alias would also erase historical requests/usage.
  textbookCost(job);
  const strongest = target && (Number(target.exhausted) > Number(source.exhausted)
    || target.exhausted === source.exhausted && target.truncations >= source.truncations) ? target : source;
  const merged = { ...strongest, inputHash: toHash, truncations: Math.max(source.truncations, target?.truncations || 0),
    exhausted: source.exhausted || target?.exhausted || false };
  job.checkpoint.modelAttempts = [...attempts.filter(item => item.inputHash !== fromHash && item.inputHash !== toHash), merged].slice(-64);
  return merged;
}
