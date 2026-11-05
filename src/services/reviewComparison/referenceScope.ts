import { bindReviewReferenceItems } from '../reviewReferenceRubric';
import type { ReviewComparisonPacket, ReviewReferenceSnapshot } from './types';

/** A complete frozen question item is not the whole note. Only that closed item scope may
 * bypass the historical whole-note preview hold; ordinary/forced retrieval excerpts may not. */
export function incompleteReviewReferenceContext(packet: ReviewComparisonPacket, source: ReviewReferenceSnapshot): boolean {
  if (!source.truncated) return false;
  if (source.kind !== 'target-note' || packet.questionIntent.referenceRubric?.status !== 'fixed') return true;
  try { return !bindReviewReferenceItems(packet).some(item => item.sourceId === source.sourceId); }
  catch { return true; }
}
