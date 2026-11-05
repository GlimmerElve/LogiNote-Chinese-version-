import type { CognitionBranch, CognitionFile, CognitionGraphEdit, CognitionLink, CognitionNodeReference } from './types';

export type CognitionRevisionMode = 'automatic' | 'collaborative';
export interface CognitionRelationOrigin {
  sessionId: string; batchId: string;
  kind: 'agent_inference' | 'source_expression' | 'user_instruction';
  acceptance: 'session_authorized' | 'user_confirmed';
}
export interface CognitionRevisionEvidence {
  kind: CognitionRelationOrigin['kind'];
  /** Current exact coordinates, with literal excerpts rather than topic names. */
  excerpts: Array<{ target: CognitionNodeReference; text: string }>;
  explanation: string;
}
export interface CognitionRevisionEntry { edit: CognitionGraphEdit; evidence: CognitionRevisionEvidence }
export interface CognitionRevisionSession {
  id: string; ownerId: string; mode: CognitionRevisionMode; status: 'active' | 'stopped';
  goal: string; recordIds: string[]; maxChanges: number; changeCount: number;
  createdAt: string; updatedAt: string;
  /** Editing context, never ingested as a user's belief. */
  focus: CognitionNodeReference[]; notes: string[]; lastUserRequest: string;
}
export interface CognitionRevisionRecordState { recordId: string; branches: CognitionBranch[]; withdrawn?: boolean }
export interface CognitionRevisionBatch {
  id: string; sessionId: string; at: string; summary: string; userRequest: string;
  acceptance: CognitionRelationOrigin['acceptance']; entries: CognitionRevisionEntry[];
  beforeHead: string; afterHead: string;
  beforeRecords: CognitionRevisionRecordState[]; afterRecords: CognitionRevisionRecordState[];
  beforeLinks: CognitionLink[]; afterLinks: CognitionLink[];
  undoneAt?: string;
}
export type CognitionRevisionMutation = {
  kind: 'begin_revision_session'; session: Pick<CognitionRevisionSession, 'id' | 'ownerId' | 'mode' | 'goal' | 'recordIds' | 'maxChanges'>;
} | {
  kind: 'update_revision_session'; sessionId: string; ownerId: string;
  focus?: CognitionNodeReference[]; note?: string; userRequest?: string; stop?: boolean;
} | {
  kind: 'apply_revision_batch'; sessionId: string; ownerId: string; batchId: string; summary: string; userRequest: string;
  acceptance: CognitionRelationOrigin['acceptance']; entries: CognitionRevisionEntry[];
} | { kind: 'undo_revision_batch'; batchId: string; ownerId: string };
export type CognitionRevisionRequest = CognitionRevisionMutation & { expectedRevision: number; confirmed: true; storageScopeId?: string };

export function readRelationOrigin(raw: unknown): CognitionRelationOrigin | undefined {
  if (raw === undefined) return undefined;
  const o = raw as CognitionRelationOrigin;
  if (!o || typeof o !== 'object' || typeof o.sessionId !== 'string' || !o.sessionId || o.sessionId.length > 200
    || typeof o.batchId !== 'string' || !o.batchId || o.batchId.length > 200
    || !['agent_inference', 'source_expression', 'user_instruction'].includes(o.kind)
    || !['session_authorized', 'user_confirmed'].includes(o.acceptance)) throw new Error('校订关系来源无效');
  return { sessionId: o.sessionId, batchId: o.batchId, kind: o.kind, acceptance: o.acceptance };
}
export const cognitionBeliefHead = (file: CognitionFile) => file.beliefHead || `legacy:${file.revision}`;
