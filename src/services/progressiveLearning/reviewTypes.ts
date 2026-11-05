import type { ProgressiveAttempt, ProgressiveCourse, ProgressiveLessonPage, ProgressiveRestatementSpan, ProgressivePageSummary, ProgressiveStudySummary } from './types';
import type { FlowAnalysisV2Bundle } from '../flowAnalysis/productionV2';
import type { MasteryShadowEvaluationInput, MasteryShadowEvaluationResult } from '../masteryShadow/evaluator';
export interface ProgressiveReviewSummary {
    id: string;
    version: number;
    submittedAt: string;
    updatedAt: string;
    activated?: boolean;
    status: 'saved' | 'pending' | 'running' | 'failed' | 'analyzed';
    textKey: string;
    pageIds: string[];
    parts: number;
    completedParts: number;
    auxiliary: 'pending' | 'waiting_knowledge' | 'running' | 'failed' | 'ready';
    error?: string;
    auxiliaryError?: string;
}
export interface ProgressiveReviewPart {
    id: string;
    start: number;
    end: number;
    resultHash?: string;
}
export interface ProgressiveReviewRecord extends ProgressiveReviewSummary {
    schemaVersion: 1;
    courseId: string;
    projectNoteId: string;
    rootProjectId: string;
    exitId: string;
    rawText: string;
    summaryText: string;
    spans: ProgressiveRestatementSpan[];
    pageRefs: ProgressivePageSummary[];
    studyRefs: ProgressiveStudySummary[];
    chunks: ProgressiveReviewPart[];
    editedText?: string;
    auxiliaryHash?: string;
    auxiliaryApplied?: boolean;
}
export interface ProgressiveCompletion {
    exitId: string;
    requestedAt: string;
    status: 'blocked' | 'waiting_review' | 'ready' | 'committed';
    reviewId?: string;
    activated?: boolean;
    reason: 'mainline_incomplete' | 'mainline_pending_answers' | 'review_required' | 'eligible';
}
export interface ProgressiveReviewLease {
    environmentId: string;
    courseId: string;
    projectNoteId: string;
    reviewId: string;
    token: string;
}
export interface ProgressiveReviewMaterial {
    page: ProgressiveLessonPage;
    hash: string;
    knowledgeIds: string[];
}
export interface ProgressiveReviewPacket {
    record: ProgressiveReviewRecord;
    part?: ProgressiveReviewPart;
    text: string;
    materials: ProgressiveReviewMaterial[];
    attempts: Array<{
        pageId: string;
        attempt: ProgressiveAttempt;
        disputed: boolean;
        explanationViewed: boolean;
    }>;
}
export interface ProgressiveMasteryReceipt {
    id: string;
    input: MasteryShadowEvaluationInput;
    result?: MasteryShadowEvaluationResult;
    error?: string;
}
export interface ProgressiveAuxiliaryResult {
    schemaVersion: 1;
    mastery: ProgressiveMasteryReceipt[];
    pendingKnowledge: boolean;
    profileApplied?: boolean;
}
export type ProgressiveReviewCommand = {
    op: 'review-work';
    projectNoteIds?: string[];
} | {
    op: 'review-exit';
    projectNoteId: string;
    environmentId: string;
    courseId: string;
    exitId: string;
    analyze: boolean;
    expectedProgressVersion: number;
} | {
    op: 'review-activate';
    projectNoteId: string;
    environmentId: string;
    courseId: string;
    exitId: string;
} | {
    op: 'review-read';
    projectNoteId: string;
    reviewId: string;
    partId?: string;
    auxiliary?: boolean;
} | {
    op: 'review-claim';
    projectNoteId: string;
    reviewId: string;
} | {
    op: 'review-packet';
    lease: ProgressiveReviewLease;
    partId?: string;
} | {
    op: 'review-result';
    lease: ProgressiveReviewLease;
    partId: string;
    result: FlowAnalysisV2Bundle;
} | {
    op: 'review-finish';
    lease: ProgressiveReviewLease;
} | {
    op: 'review-fail';
    lease: ProgressiveReviewLease;
    error: string;
    auxiliary?: boolean;
} | {
    op: 'review-auxiliary';
    lease: ProgressiveReviewLease;
    result: ProgressiveAuxiliaryResult;
} | {
    op: 'review-acknowledge';
    lease: ProgressiveReviewLease;
    auxiliaryHash: string;
} | {
    op: 'review-retry';
    projectNoteId: string;
    reviewId: string;
} | {
    op: 'review-edit';
    projectNoteId: string;
    reviewId: string;
    expectedVersion: number;
    text: string;
} | {
    op: 'review-completion';
    projectNoteId: string;
    environmentId: string;
    courseId: string;
    exitId: string;
} | {op:'review-completion-check';projectNoteId:string;environmentId:string;courseId:string;exitId:string};

export interface ProgressiveReviewWork {
    projectNoteId: string;
    reviewId?: string;
    completion?: boolean;
    environmentId: string;
    courseId: string;
}
export interface ProgressiveReviewReply {
    course: ProgressiveCourse;
    record?: ProgressiveReviewRecord;
    lease?: ProgressiveReviewLease;
    running?: boolean;
}
