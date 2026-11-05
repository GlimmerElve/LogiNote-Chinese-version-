import type { ArgDoc, ArgEdge, ArgNode, FlowArgumentStructure } from '../argumentDoc/types';
import { RELATION_LABELS } from '../argumentDoc/types';
import type { ReviewQuestionIntent } from '../reviewIntent';
import type { CognitionRelationOrigin, CognitionRevisionBatch, CognitionRevisionRequest, CognitionRevisionSession } from './revisionTypes';

/** Private knowledge-understanding facet of the profile, never factual QA evidence. */
export type CognitionOperation = 'initial' | 'supplement' | 'revise' | 'qualify' | 'add_conditions' | 'remove_conditions' | 'replace_conditions' | 'certainty' | 'contextual' | 'alternative';
/** Private cognition only: never expand argument-editor/scoring relation semantics. */
export type CognitionRelation = ArgEdge['relation'] | 'limits' | 'exception';
export const COGNITION_RELATION_LABELS: Record<CognitionRelation, string> = { ...RELATION_LABELS, limits: '限制适用范围', exception: '例外' };
export const COGNITION_RELATION_MEANINGS: Record<CognitionRelation, string> = {
  support: '起点为终点提供支持，不代表系统已核实为真。', oppose: '起点与终点在相同条件下冲突或提供反对理由，不等于仅缩小适用范围。',
  limits: '起点限定终点的适用条件或范围，不否定其在范围内成立。', exception: '起点记录终点不成立的特定情境，不自动推翻一般主张。',
  context: '起点为终点提供背景，不是支持证明或适用条件。', method_for: '起点是产生终点的方法，不是正确性证明。', relates: '仅明确相关，不推断支持、反对或因果。',
};
export type CognitionConditionChange = { kind: 'add'; after: string } | { kind: 'remove'; before: string } | { kind: 'replace'; before: string; after: string };
/** Proposed interpretation, not a claim that model semantics were verified. */
export interface CognitionEditMeaning {
  interpretation: string;
  /** Exact fragments retained in both original and resulting proposition. */
  preserved: string[];
  conditions?: { before: string[]; changes: CognitionConditionChange[] };
}
export type CognitionStance = 'endorsed' | 'tentative';
export type CognitionAuthorship = 'own_expression' | 'adopted_with_assistance';
export interface CognitionObservation {
  activityKind: 'review';
  activityId: string;
  messageId: string;
  role: 'user';
  answer: string;
  question: string;
  observedAt: string;
  noteId?: string;
  noteTitle: string;
  hintLevel: 0 | 1 | 2 | 3 | 4 | null;
  consultedMaterialIds: string[];
  targetKnowledgeNames: string[];
  /** Trusted question-time coordinate. It guides a later proposal, never writes a relation by itself. */
  questionIntent?: ReviewQuestionIntent;
}
export type CognitionCandidate = {
  id: string;
  status: 'pending';
  capturedAt: string;
  observation: CognitionObservation;
} | { id: string; status: 'accepted'; recordId: string }
  | { id: string; status: 'dismissed' };
export type CognitionSource = { kind: 'argument_editor'; docId: string; noteId?: string }
  | { kind: 'manual_revision'; docId: string }
  | { kind: 'review_answer'; docId: string; candidateId: string; observation: CognitionObservation; automatic?: boolean }
  | { kind: 'restatement'; docId: string; noteId: string; recordId: string; sessionId: string; observedAt: string; updatedAt: string; automatic: true;
      /** Original user words remain distinct from the reused analysis structure. */
      originalText?: string; graph?: { argumentDocId: string; updatedAt: string } };
export interface RestatementObservation {
  noteId: string; noteTitle: string; recordId: string; sessionId: string; observedAt: string; updatedAt: string; text: string;
  /** Only an existing graph bound to this saved review; never a new extraction. */
  graph?: { argumentDocId: string; updatedAt: string; structure: CognitionGraph };
}
export interface CognitionGraph {
  title: string;
  /** Current semantic role is authoritative. Unclassified expressions and legacy nodes remain unclassified. */
  nodes: (Pick<ArgNode, 'id' | 'text' | 'role'> & { mainType?: ArgNode['mainType']; stance?: CognitionStance; conditions?: string[] })[];
  edges: (Omit<ArgEdge, 'relation'> & { relation: CognitionRelation; revisionOrigin?: CognitionRelationOrigin })[];
  /** Immutable original extraction, not necessarily the edited current graph. */
  flowStructure?: FlowArgumentStructure;
}
export interface CognitionBranch {
  id: string;
  kind: 'primary' | 'contextual' | 'alternative';
  context: string;
  stance: CognitionStance;
  graph: CognitionGraph;
  /** Changed premises do not automatically invalidate downstream conclusions. */
  reviewNeededNodeIds?: string[];
}
export interface CognitionUpdateTarget {
  recordId: string;
  revisionId: string;
  branchId: string;
  nodeId: string;
  operation: Exclude<CognitionOperation, 'initial'>;
  reason: string;
}
export interface CognitionRevision {
  id: string;
  number: number;
  at: string;
  operation: CognitionOperation;
  reason: string;
  authorship: CognitionAuthorship;
  meaning?: CognitionEditMeaning;
  source: CognitionSource;
  change?: CognitionUpdateTarget & { resultBranchId: string; resultNodeId: string };
  /** Full immutable projection; supplementary/contextual branches remain current. */
  branches: CognitionBranch[];
  factSupport: 'not_assessed';
  mastery: 'not_assessed';
}
export interface CognitionRecord {
  id: string;
  docId: string;
  revisions: CognitionRevision[];
  /** Cleared restatement: retain history, exclude it from current recall. */
  withdrawn?: boolean;
}
export interface CognitionFile {
  schemaVersion: 1;
  /** Optimistic concurrency token shared across editor windows. */
  revision: number;
  /** Undo head changes only for beliefs/relations, not session notes. */
  beliefHead?: string;
  revisionSessions?: CognitionRevisionSession[];
  revisionBatches?: CognitionRevisionBatch[];
  records: CognitionRecord[];
  /** User-created cross-activity links. Stable node coordinates, never title matching. */
  links?: CognitionLink[];
  linkHistory?: Array<{ id: string; at: string; reason: string; meaning?: CognitionEditMeaning; before?: CognitionLink; after?: CognitionLink }>;
  /** Optional for compatibility with phase-one files. Candidates are not current beliefs. */
  candidates?: CognitionCandidate[];
  /** Opaque receipts prevent forgotten automatic sources from reappearing on sync. */
  suppressedSourceIds?: string[];
  /** Opaque sync receipts include empty sources so late retries cannot revive cleared text. */
  restatementSync?: Array<{ id: string; updatedAt: string }>;
}
export interface CognitionNodeReference { recordId: string; branchId: string; nodeId: string; revisionId: string }
export type CognitionEdgeReference = { recordId: string; branchId: string; revisionId: string; edgeId: string } | { linkId: string };
export interface CognitionLink { id: string; source: Omit<CognitionNodeReference, 'revisionId'>; target: Omit<CognitionNodeReference, 'revisionId'>; relation: CognitionRelation; reason?: string; revisionOrigin?: CognitionRelationOrigin }
export type CognitionGraphEdit = (
  | { action: 'add_node'; title: string; text: string; mainType?: ArgNode['mainType']; role?: ArgNode['role']; stance: CognitionStance; reason: string; parent?: Omit<CognitionNodeReference, 'nodeId'> }
  | { action: 'update_node'; target: CognitionNodeReference; text: string; mainType?: ArgNode['mainType']; role?: ArgNode['role']; stance: CognitionStance; operation: 'revise' | 'qualify' | 'add_conditions' | 'remove_conditions' | 'replace_conditions' | 'certainty'; reason: string }
  | { action: 'delete_node'; target: CognitionNodeReference; reason: string }
  | { action: 'add_relation' | 'update_relation'; edge?: CognitionEdgeReference; source: CognitionNodeReference; target: CognitionNodeReference; relation: CognitionRelation; reason: string }
  | { action: 'delete_relation'; edge: CognitionEdgeReference; reason: string }) & { meaning?: CognitionEditMeaning };
export type CognitionMutation = ({
  kind: 'edit_graph'; expectedRevision: number; confirmed: true; edit: CognitionGraphEdit; authorship?: CognitionAuthorship;
} | {
  /** Same-snapshot concrete confirmations, committed under one existing store lock. */
  kind: 'edit_graph_batch'; expectedRevision: number; confirmed: true; edits: CognitionGraphEdit[]; authorship?: CognitionAuthorship;
} | {
  kind: 'confirm';
  expectedRevision: number;
  confirmed: true;
  operation: CognitionOperation;
  reason: string;
  stance: CognitionStance;
  authorship: CognitionAuthorship;
  doc: Pick<ArgDoc, 'doc_id'> & Omit<CognitionGraph, 'nodes'> & { nodes: Array<CognitionGraph['nodes'][number] & Partial<ArgNode>> };
  noteId?: string;
} | {
  kind: 'forget';
  expectedRevision: number;
  confirmed: true;
  recordId: string;
} | {
  kind: 'capture_review';
  /** Explicit session opt-in; this operation never modifies confirmed records. */
  enabled: true;
  observations: CognitionObservation[];
} | {
  kind: 'record_review';
  storageScopeId?: string;
  enabled: true;
  observations: CognitionObservation[];
} | {
  kind: 'record_restatements';
  storageScopeId?: string;
  observations: RestatementObservation[];
} | {
  kind: 'accept_candidate';
  expectedRevision: number;
  confirmed: true;
  candidateId: string;
  text: string;
  mainType?: ArgNode['mainType'];
  role?: ArgNode['role'];
  stance: CognitionStance;
  authorship: CognitionAuthorship;
  target?: CognitionUpdateTarget;
} | {
  kind: 'update_cognition';
  meaning?: CognitionEditMeaning;
  expectedRevision: number;
  confirmed: true;
  target: CognitionUpdateTarget;
  text: string;
  mainType?: ArgNode['mainType'];
  role?: ArgNode['role'];
  stance: CognitionStance;
  authorship: CognitionAuthorship;
} | {
  kind: 'dismiss_candidate';
  expectedRevision: number;
  confirmed: true;
  candidateId: string;
} | CognitionRevisionRequest) & { storageScopeId?: string };

export const COGNITION_OPERATION_LABELS: Record<CognitionOperation, string> = {
  initial: '首次确认', supplement: '补充（保留原有主张）', revise: '修订替代',
  qualify: '调整适用条件', certainty: '调整确定程度',
  add_conditions: '新增条件（保留原条件）', remove_conditions: '移除指定条件', replace_conditions: '替换指定条件',
  contextual: '不同情境并存', alternative: '保留未决分歧',
};
