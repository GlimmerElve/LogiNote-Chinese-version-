/** Public selectors and small receipts only. No source text, host paths, model secrets or publish authority. */
export interface ArgumentReferenceSourceRef { kind: 'knowledge-note' | 'uploaded-document'; entityId: string }
export interface ArgumentReferenceBuildSourceRequest { environmentId: string; ref: ArgumentReferenceSourceRef }
export interface ArgumentReferenceBuildRunRequest { environmentId: string; ticketId: string; consent: 'process-reference' }
export interface ArgumentReferenceBuildCancelRequest { environmentId: string; ticketId: string }
export type ArgumentReferenceBuildReason = 'invalid_request' | 'environment_changed' | 'scope_denied' | 'source_missing'
  | 'source_pending' | 'source_changed' | 'source_unavailable' | 'provenance_unavailable' | 'model_unavailable'
  | 'model_changed' | 'request_budget' | 'ticket_unavailable' | 'ticket_expired' | 'cancelled' | 'capacity'
  | 'qualification_rejected' | 'model_response_invalid' | 'model_failed' | 'review_incomplete' | 'publication_rejected';
export interface ArgumentReferenceBuildCounts { nodes: number; relations: number; groups: number; scopes: number }
export interface ArgumentReferenceBuildSourceIdentity extends ArgumentReferenceSourceRef { version: string; contentHash: string }
export interface ArgumentReferenceBuildSummary {
  sourceKind: ArgumentReferenceSourceRef['kind']; entityId: string; sourceVersion: string; contentHash: string;
  characters: number; sentences: number; chunks: number;
  providerLabel: string; modelName: string; isRemote: boolean; maximumModelRequests: 3;
  /** The actual independent-review payload is bounded only after the candidate exists. */
  reviewBudget: 'checked-after-extraction';
}
export type ArgumentReferenceBuildPrepareReply =
  | { status: 'prepared'; environmentId: string; ticketId: string; expiresAt: string; summary: ArgumentReferenceBuildSummary }
  | { status: 'available'; environmentId: string; source: ArgumentReferenceBuildSourceIdentity; sourceQualification: 'eligible'; counts: ArgumentReferenceBuildCounts }
  | { status: 'held'; reasonCode: ArgumentReferenceBuildReason };
export type ArgumentReferenceBuildRunReply =
  | { status: 'published'; counts: ArgumentReferenceBuildCounts }
  | { status: 'held'; reasonCode: ArgumentReferenceBuildReason; counts?: ArgumentReferenceBuildCounts };
export type ArgumentReferenceBuildStatusReply =
  | { status: 'available'; source: ArgumentReferenceBuildSourceIdentity; sourceQualification: 'eligible'; counts: ArgumentReferenceBuildCounts }
  | { status: 'missing'; source: ArgumentReferenceBuildSourceIdentity; sourceQualification: 'eligible' | 'review_only' | 'unassessed'; reasonCode: 'review_incomplete' }
  | { status: 'held'; reasonCode: ArgumentReferenceBuildReason };
export type ArgumentReferenceBuildCancelReply = { status: 'cancelled' } | { status: 'held'; reasonCode: ArgumentReferenceBuildReason };
