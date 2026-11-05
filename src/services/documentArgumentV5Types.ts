import type { DocumentGraphSource } from './documentGraphTypes';

export const DOCUMENT_ARGUMENT_V5_VERSION = 'document-argument-v5.0-compact-1' as const;
export const DOCUMENT_ARGUMENT_V5_BRIDGE_PROTOCOL = 'v508-semantic-bridge-v1.1' as const;
export type DocumentArgumentRelationPolicy = 'legacy' | 'v5.0.8';
export const DOCUMENT_ARGUMENT_V5_LIMITS = { targetCharacters: 3500, minCharacters: 3000, maxCharacters: 3999, tailNodes: 6, handoffNodes: 16 } as const;
export type DocumentArgumentRole = 'claim' | 'premise' | 'background' | 'method';
export type DocumentArgumentRelationKind = 'context' | 'method_for' | 'relates';
/** Diagnostic recommendations only: never automatically rewrite graph edges. */
export type DocumentArgumentEdgeAudit = {
  edgeId: string; from: string; to: string; kind: 'support' | 'oppose' | DocumentArgumentRelationKind;
  timeStatus: 'historical' | 'current' | 'resolved';
  issueType: 'structural_violation' | 'type_mismatch' | 'semantic_suspect' | 'rule_boundary';
  reason: string;
  /** Local rule identity, so unchanged warnings do not grow on every commit. */
  localRule?: string;
} & ({action: 'keep' | 'delete' | 'pending_review'; fromKind?: never; toKind?: never}
  | {action: 'change_type'; fromKind: 'support' | 'oppose' | DocumentArgumentRelationKind;
    toKind: 'support' | 'oppose' | DocumentArgumentRelationKind});
export interface DocumentArgumentNode {
  id: string;
  role: DocumentArgumentRole;
  batch: number;
  source: DocumentGraphSource[];
  /** Full model-returned block when optional exact source anchoring failed. */
  fallbackText?: string;
}
export interface DocumentArgument {
  id: string; claim: string; support: string[]; oppose: string[];
  status: 'argued' | 'stated_only' | 'incomplete';
}
export interface DocumentArgumentRelation {
  id: string; kind: DocumentArgumentRelationKind; from: string; to: string; reason: string;
  /** Local contract stamp; never requested from the model. Missing means legacy rules. */
  policy?: 'v5.0.8';
}
export type DocumentArgumentRoleRevision = {
  id: string; action: 'revise'; nodeId: string; from: DocumentArgumentRole; to: DocumentArgumentRole;
  batch: number; reason: string;
  nodeEvidence: { quote: string; reason: string };
  usageEvidence: { nodeId: string; quote: string; reason: string };
} | { id: string; action: 'revoke'; revisionId: string; batch: number; reason: string };
export interface DocumentArgumentGraph {
  nodes: DocumentArgumentNode[];
  arguments: DocumentArgument[];
  relations: DocumentArgumentRelation[];
  unresolved: Array<{ batch: number; nodeId?: string; reason: string }>;
  /** Append-only history. Stored node.role remains the original extraction role. */
  roleRevisions?: DocumentArgumentRoleRevision[];
  edgeAudits?: DocumentArgumentEdgeAudit[];
  /** Quarantined model proposals, NOT admitted graph edges or retrieval evidence. */
  pendingEdges?: Array<{id:string;batch:number;kind:'support'|'oppose'|DocumentArgumentRelationKind;from:string;to:string;reason:string;policy?:'v5.0.8'}>;
}
export interface DocumentArgumentWindow {
  id: string; section: string; text: string;
  /** Transient local-only offsets with original PDF line-wrap evidence. */
  wrapHyphens?:number[];
  /** windowStart is present only in transient grouped reading windows. */
  parts: Array<DocumentGraphSource & {windowStart?:number}>;
}
export interface DocumentArgumentObject {
  id: string; kind: 'table' | 'references' | 'metadata';
  title: string; text: string; source: DocumentGraphSource[];
}
export interface DocumentArgumentPlan {
  windows: DocumentArgumentWindow[];
  objects: DocumentArgumentObject[];
  limitations: string[];
}
export interface DocumentArgumentBuild {
  version: typeof DOCUMENT_ARGUMENT_V5_VERSION;
  promptHash: string;
  windowPlanFingerprint: string;
  completedWindowIds: string[];
  totalWindows: number;
  batchCount: number;
  bridgeStatus: 'pending' | 'review_required' | 'complete';
  /** Missing on graphs completed before local ordinal/claim/context semantic bridging. */
  bridgeProtocol?: typeof DOCUMENT_ARGUMENT_V5_BRIDGE_PROTOCOL | 'v508-role-bridge-v5' | 'ordinal-context-v1' | 'ordinal-claim-context-v2' | 'ordinal-role-refinement-v3' | 'recoverable-role-bridge-v4';
  /** Terminal semantic reviews are tied to exact node sets, never inferred from an empty candidate page. */
  bridgeReviews?: Array<{nodeIds:string[];proposalIds?:string[];decision:'independent'|'unresolved';round:number;basis:string}>;
  batches: Array<{ batch: number; promptHash?:string; characters: number; inheritedCharacters: number; requests: number;
    coverage: Array<{ window: string; covered: number; total: number }> }>;
}
export interface DocumentArgumentV5Commit extends DocumentArgumentGraph {
  docId: string; sourceFingerprint: string; previousRevision: string | null;
  build: DocumentArgumentBuild;
  tableBindings: Array<{ tableId: string; nodeId: string }>;
}
export interface DocumentArgumentV5Snapshot extends DocumentArgumentPlan {
  docId: string; sourceFingerprint: string; previousRevision: string | null;
  windowPlanFingerprint: string; promptHash: string; environmentId?: string;
  /** Exact replay sources; new graphs use StructuredDocument block IDs, not passage-vector chunks. */
  chunks: Array<{ id: string; sectionPath: string; content: string }>;
  quoteHints?:Array<{chunkId:string;offset:number}>;
  current?: DocumentArgumentV5Commit;
  publicationPending?: boolean;
}
export interface SavedDocumentArgumentV5 extends DocumentArgumentV5Commit {
  schemaVersion: 2; revision: string;
  /** Missing on legacy passage-bound graphs, which remain readable with their original index. */
  sourceBasis?: 'structured-document-v1';
  embeddingModel: 'paraphrase-multilingual-MiniLM-L12-v2';
  nodes: Array<DocumentArgumentNode & { text: string; embedding: number[] }>;
  objects: DocumentArgumentObject[];
  semanticCertified: false;
}
export interface CompactInheritedGraph {
  next_node_id: string;
  nodes: Array<{ id: string; role: DocumentArgumentRole; text: string }>;
  edges: Array<{ kind: 'support' | 'oppose' | DocumentArgumentRelationKind; from: string; to: string }>;
}

/** Last model response for local diagnosis; never part of the published graph. */
export interface DocumentArgumentV5ResponseRecord {
  docId:string;sourceFingerprint:string;windowPlanFingerprint:string;promptHash:string;
  previousRevision:string|null;stage:'extract'|'bridge';raw:string;error?:string;
  /** Exact body sent in that extraction; allows audit after batching rules change. */
  requestText?:string;
}

/** Read-only UI projection; no embeddings, credentials or filesystem paths. */
export interface DocumentArgumentGraphView {
  docId:string; published:boolean;
  revision?:string;
  progress?:{batchCount:number;completedWindows:number;totalWindows:number};
  nodes:Array<{id:string;role:DocumentArgumentRole;originalRole?:DocumentArgumentRole;text:string;batch:number}>;
  edges:Array<{id:string;kind:'support'|'oppose'|DocumentArgumentRelationKind;from:string[];to:string;reason:string}>;
  unresolved:Array<{batch:number;nodeId?:string;reason:string}>;
}
