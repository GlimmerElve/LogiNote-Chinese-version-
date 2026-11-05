/** Explicit audit mask for diagnostic rollouts. No local semantic judgments are invented. */
import type {ReviewedReferentIndex} from './entityReferentBindings.ts';
export interface ReferentAudit {
  documentId: string; snapshotId: string; reviewedBy: string;
  decisions: Array<{id: string; mention: string; targetNodeIds: string[]; mode: 'block' | 'node_only' | 'entity_and_node'; reason: string}>;
}
export function applyReferentAudit(index: ReviewedReferentIndex, audit: ReferentAudit) {
  if (index.documentId !== audit.documentId || index.snapshotId !== audit.snapshotId) throw new Error('audit_snapshot_mismatch');
  if (!audit.reviewedBy?.trim()) throw new Error('audit_author_required');
  const byId = new Map(audit.decisions.map(d => [d.id, d]));
  if (byId.size !== audit.decisions.length) throw new Error('duplicate_audit_decision');
  for (const d of audit.decisions) {
    const b = index.bindings.find(b => b.id === d.id);
    if (!b || b.mention.quote !== d.mention || JSON.stringify([...new Set(b.targets.map(t => t.nodeId))].sort()) !== JSON.stringify([...new Set(d.targetNodeIds)].sort())) {
      throw new Error('audit_binding_changed');
    }
    if (!['block', 'node_only', 'entity_and_node'].includes(d.mode) || !d.reason?.trim()) throw new Error('audit_decision_invalid');
  }
  return {...index, bindings: index.bindings.map(b => {
    const d = byId.get(b.id), mode = d?.mode ?? 'block';
    return {...b, usableForRetrieval: b.usableForRetrieval && mode !== 'block',
      entityIds: b.usableForRetrieval && mode === 'entity_and_node' ? [...b.entityIds] : [],
      modelProposedEntityIds: [...b.entityIds], auditMode: mode, auditReason: d?.reason ?? 'No explicit audit decision; withheld.'};
  }), audit: {reviewedBy: audit.reviewedBy, defaultAction: 'block', semanticCertified: false}, productionAdmission: false};
}
