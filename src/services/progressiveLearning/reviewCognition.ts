import type { FlowAnalysisV2Bundle } from '../flowAnalysis/productionV2';
import type { ProgressiveReviewRecord, ProgressiveReviewLease, ProgressiveReviewCommand } from './reviewTypes';
import { progressiveReviewCommand } from './reviewClient';
import { progressiveCognitionSourceKey } from './reviewCognitionSource';
export { progressiveCognitionObservations } from './reviewCognitionProjection';

/** Legacy worker wire retained for older callers. The native authority rejects
 * review-cognition; only review-cognition-confirm can now adopt a saved graph. */
export async function persistProgressiveCognition(record: ProgressiveReviewRecord, parts: FlowAnalysisV2Bundle[], title: string,
  assertCurrent: () => Promise<void>, lease?: ProgressiveReviewLease,
  command: <T = any>(input: ProgressiveReviewCommand) => Promise<T> = progressiveReviewCommand): Promise<void> {
  if (!lease) throw Error('缺少复盘写入许可，个人认知未写入');
  await assertCurrent();
  await command({ op: 'review-cognition', lease, cognitionSourceKey: progressiveCognitionSourceKey(record) });
  await assertCurrent();
}
