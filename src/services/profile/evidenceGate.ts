import type { ProfileSignal } from '../memory/types';
import type { ExpressionStyleKind } from '../../types';
import { getUserProfile, saveUserProfile, waitProfilePersistence, retryFailedProfilePersistence, ensureProfileHydrated } from './profileStore';
import { setExpressionStyleDisplay } from './profileStore';
import { applyProfileEvidenceGate, isFlowRubric, type GateDecision } from './evidenceGateCore';
import { selectProfileStyle } from './overviewModel';

let gateQueue: Promise<unknown> = Promise.resolve();

/** 串行处理画像证据；事件 id 已处理时安全跳过。 */
export function ingestProfileSignals(input: {
  episodeId: string;
  signals: ProfileSignal[];
  sampleChars: number;
  /** Runtime source boundary; never stored with the evidence. */
  isCurrent?: () => boolean | Promise<boolean>;
}): Promise<GateDecision[]> {
  const task = gateQueue.then(async () => {
    await ensureProfileHydrated();
    if (input.isCurrent && !await input.isCurrent()) throw new Error('画像证据所属资料库已变化，未写入其他资料库');
    const result = applyProfileEvidenceGate(getUserProfile(), input);
    if (!result.duplicate) {
      saveUserProfile(result.profile);
      await waitProfilePersistence();
    } else {
      // The processed ID may only be in the optimistic cache after a failed save.
      // Do not apply the signal twice, but do require its latest snapshot to be durable.
      await retryFailedProfilePersistence();
    }
    const profile = getUserProfile();
    const styles: Partial<Record<ExpressionStyleKind, number>> = {};
    for (const aggregate of Object.values(profile.evidenceGate?.aggregates || {})) {
      if (aggregate.dimension === 'expression_style' && aggregate.status === 'trusted'
        && ['academic', 'critical', 'practical', 'divergent', 'objective'].includes(aggregate.indicator)) {
        styles[aggregate.indicator as ExpressionStyleKind] = aggregate.mean;
      }
    }
    const hasFlowStyles = Object.values(profile.evidenceGate?.aggregates || {}).some(a =>
      a.dimension === 'expression_style' && isFlowRubric(a.rubricVersion));
    if (hasFlowStyles) {
      const current = selectProfileStyle(null, null, 'current', new Date().toISOString().slice(0, 10), profile);
      setExpressionStyleDisplay(current?.display || {});
    } else if (Object.keys(styles).length) setExpressionStyleDisplay(styles);
    return result.decisions;
  });
  gateQueue = task.catch((error) => {
    console.warn('[profile-gate] evidence ingestion failed:', error);
  });
  return task;
}
