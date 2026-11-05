import { flowReviewContentText } from '../textbook/reviewAdmission';
import type { ProgressiveCourse, ProgressiveRestatementSpan } from './types';
import type { ProgressiveReviewPart, ProgressiveReviewRecord, ProgressiveCompletion } from './reviewTypes';
export function progressiveReviewEligible(raw: string) { return Array.from(flowReviewContentText(raw).replace(/\s/gu, '')).length >= 10; }
/** Exact ranges cover the entire original. No text is dropped when a paragraph exceeds the limit. */
export function splitProgressiveReview(raw: string, limit = 2800): ProgressiveReviewPart[] {
    const result: ProgressiveReviewPart[] = [];
    let start = 0;
    while (start < raw.length) {
        let end = Math.min(start + limit, raw.length);
        if (end < raw.length) {
            const candidate = raw.lastIndexOf('\n\n', end);
            if (candidate > start + Math.floor(limit / 2))
                end = candidate + 2;
            if (/[\uD800-\uDBFF]/u.test(raw[end - 1]))
                end--;
        }
        result.push({ id: 'part-' + (result.length + 1), start, end });
        start = end;
    }
    return result;
}
export function remainingProgressiveDraft(progress: Pick<ProgressiveCourse['progress'], 'restatementDraft' | 'summaryDraft' | 'restatementSpans'>, analyzed: Pick<ProgressiveReviewRecord, 'rawText' | 'summaryText'>) {
    const cut = analyzed.rawText && progress.restatementDraft.startsWith(analyzed.rawText) ? analyzed.rawText.length : 0;
    const summaryCut = analyzed.summaryText && progress.summaryDraft.startsWith(analyzed.summaryText) ? analyzed.summaryText.length : 0;
    const spans: ProgressiveRestatementSpan[] = (progress.restatementSpans || []).filter(s => s.end > cut).map(s => ({ ...s, start: Math.max(cut, s.start) - cut, end: s.end - cut }));
    return { restatementDraft: progress.restatementDraft.slice(cut), summaryDraft: progress.summaryDraft.slice(summaryCut), restatementSpans: spans };
}
/** Only published mainline facts, never correctness, extensions or time spent. */
export function progressiveCompletion(course: Pick<ProgressiveCourse, 'plan' | 'pages' | 'studyPages' | 'lastSuccessfulReview'>, exitId: string, requestedAt: string, waiting = false): ProgressiveCompletion {
    let reason: ProgressiveCompletion['reason'] = 'eligible';
    const main = course.plan?.pages || [];
    if (!main.length || main.some(p => !course.pages?.some(s => s.id === p.id && s.kind === 'mainline')))
        reason = 'mainline_incomplete';
    else if (main.some(p => { const page = course.pages!.find(s => s.id === p.id)!; return (course.studyPages?.find(s => s.pageId === p.id)?.pending ?? page.questionCount ?? 0) > 0; }))
        reason = 'mainline_pending_answers';
    else if (!main.some(p => (course.pages!.find(s => s.id === p.id)?.questionCount || 0) > 0) && !course.lastSuccessfulReview)
        reason = 'review_required';
    return { exitId, requestedAt, reason, status: reason === 'eligible' ? 'ready' : waiting && reason === 'review_required' ? 'waiting_review' : 'blocked' };
}
