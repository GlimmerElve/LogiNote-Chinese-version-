import type { ProgressiveReviewCommand, ProgressiveReviewRecord, ProgressiveReviewReply, ProgressiveReviewPacket, ProgressiveReviewLease, ProgressiveReviewWork, ProgressiveAuxiliaryResult } from './reviewTypes';
import type { ProgressiveLearningApi } from './types';
import type { FlowAnalysisV2Bundle } from '../flowAnalysis/productionV2';
function api(): ProgressiveLearningApi { const value = typeof window === 'undefined' ? null : (window as any).electronAPI?.progressiveLearning; if (!value?.command)
    throw Error('渐进复盘存储接口不可用'); return value; }
export const progressiveReviewCommand = async <T = ProgressiveReviewReply>(command: ProgressiveReviewCommand): Promise<T> => await api().command(command as any) as T;
export const onProgressiveChange = (callback: (projectNoteId: string, reason?: 'review' | 'knowledge') => void) => typeof window === 'undefined' ? () => { } : ((window as any).electronAPI?.progressiveLearning?.onChange?.(callback) || (() => { }));
export const readProgressiveReview = (projectNoteId: string, reviewId: string) => progressiveReviewCommand<ProgressiveReviewRecord>({ op: 'review-read', projectNoteId, reviewId });
export const readProgressiveReviewPart = (projectNoteId: string, reviewId: string, partId: string) => progressiveReviewCommand<FlowAnalysisV2Bundle | null>({ op: 'review-read', projectNoteId, reviewId, partId });
export const readProgressiveAuxiliary = (projectNoteId: string, reviewId: string) => progressiveReviewCommand<ProgressiveAuxiliaryResult | null>({ op: 'review-read', projectNoteId, reviewId, auxiliary: true });
export const progressiveReviewWork = () => progressiveReviewCommand<ProgressiveReviewWork[]>({ op: 'review-work' });
export const readProgressiveReviewPacket = (lease: ProgressiveReviewLease, partId?: string) => progressiveReviewCommand<ProgressiveReviewPacket>({ op: 'review-packet', lease, ...(partId ? { partId } : {}) });
