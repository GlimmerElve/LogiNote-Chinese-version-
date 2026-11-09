import { flowMasteryTextKey } from '../masteryShadow/sourceKey';
import type { ProgressiveReviewRecord } from './reviewTypes';

export const PROGRESSIVE_COGNITION_VERSION = 1 as const;
/** Local writeback coordinate, not a semantic certificate. Metadata/lease retries do not change it. */
export function progressiveCognitionSourceKey(record: ProgressiveReviewRecord): string {
  return `progressive-cognition-v${PROGRESSIVE_COGNITION_VERSION}:${flowMasteryTextKey(JSON.stringify([
    record.courseId, record.id, record.rawText, record.editedText ?? null,
    record.chunks.map(part => [part.id, part.start, part.end, part.resultHash]),
    Object.entries(record.graphDrafts || {}).sort(([a], [b]) => a.localeCompare(b)),
  ]))}`;
}
