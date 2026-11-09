import type { ProgressiveReviewSummary } from './reviewTypes';

/** A title coordinate only; never evidence, a score or a newly created knowledge object. */
export const progressiveReviewConceptKey = (title: string): string => title.normalize('NFKC').trim().toLocaleLowerCase();
export const progressiveReviewWaitingSelection = (review: ProgressiveReviewSummary): boolean =>
    review.parts > 0 && review.analysisSelection?.status === 'pending';
