import type { ArgumentReferenceBuildCounts, ArgumentReferenceBuildReason, ArgumentReferenceBuildSourceIdentity,
  ArgumentReferenceBuildSourceRequest, ArgumentReferenceBuildSummary } from './referenceBuildTypes.ts';

/** Selectors and small host-issued receipts only. Never source text, paths, configuration or proof. */
export type ArgumentReferenceRagBuildSourceRequest = ArgumentReferenceBuildSourceRequest;
export interface ArgumentReferenceRagBuildRunRequest {
  environmentId: string; ticketId: string; consent: 'process-reference-with-propositions';
}
export interface ArgumentReferenceRagBuildCancelRequest { environmentId: string; ticketId: string }
export type ArgumentReferenceRagBuildReason = ArgumentReferenceBuildReason
  | 'proposition_review_held' | 'proposition_storage_unavailable';
export interface ArgumentReferenceRagBuildSummary extends Omit<ArgumentReferenceBuildSummary, 'maximumModelRequests'> {
  stage: 'structure-and-propositions' | 'propositions'; maximumModelRequests: 5 | 2;
}
export type ArgumentReferenceRagBuildPrepareReply =
  | { status: 'prepared'; environmentId: string; ticketId: string; expiresAt: string; summary: ArgumentReferenceRagBuildSummary }
  | { status: 'available'; environmentId: string; source: ArgumentReferenceBuildSourceIdentity;
      sourceQualification: 'eligible'; counts: ArgumentReferenceBuildCounts; propositionCount: number }
  | { status: 'held'; reasonCode: ArgumentReferenceRagBuildReason };
export type ArgumentReferenceRagBuildStatusReply =
  | { status: 'available'; source: ArgumentReferenceBuildSourceIdentity; sourceQualification: 'eligible';
      counts: ArgumentReferenceBuildCounts; propositionCount: number }
  | { status: 'missing'; source: ArgumentReferenceBuildSourceIdentity;
      sourceQualification: 'eligible' | 'review_only' | 'unassessed';
      reasonCode: 'review_incomplete' | 'propositions_missing'; counts?: ArgumentReferenceBuildCounts }
  | { status: 'held'; reasonCode: ArgumentReferenceRagBuildReason };
export type ArgumentReferenceRagBuildRunReply =
  | { status: 'published'; counts: ArgumentReferenceBuildCounts; propositionCount: number }
  | { status: 'held'; reasonCode: ArgumentReferenceRagBuildReason;
      structureStatus?: 'published'; counts?: ArgumentReferenceBuildCounts };
export type ArgumentReferenceRagBuildCancelReply =
  | { status: 'cancelled' } | { status: 'held'; reasonCode: ArgumentReferenceRagBuildReason };
export interface ArgumentReferenceRagBuildApi {
  getEnvironment(): Promise<{ status: 'available'; environmentId: string } | { status: 'held'; reasonCode: string }>;
  prepare(request: ArgumentReferenceRagBuildSourceRequest): Promise<ArgumentReferenceRagBuildPrepareReply>;
  status(request: ArgumentReferenceRagBuildSourceRequest): Promise<ArgumentReferenceRagBuildStatusReply>;
  run(request: ArgumentReferenceRagBuildRunRequest): Promise<ArgumentReferenceRagBuildRunReply>;
  cancel(request: ArgumentReferenceRagBuildCancelRequest): Promise<ArgumentReferenceRagBuildCancelReply>;
}
