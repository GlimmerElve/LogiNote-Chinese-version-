/** Shadow orchestration only: proposals are never production graph admissions. */
import type { AuditInput } from './relationAuditShadow';
import type { parseUseProbe } from './authorUseProbe';
import type { parseLimitProbe } from './limitAspectProbe';

type UseResult = ReturnType<typeof parseUseProbe>;
type LimitResult = ReturnType<typeof parseLimitProbe>;
export const RELATION_AUDIT_PIPELINE_VERSION = 'author-use-limit-shadow-v1';

/** Route by the model's answer, never by reference labels, node wording or case IDs. */
export function selectLimitAuditInput(input: AuditInput, proposal: UseResult): AuditInput {
  const selected = new Set(proposal.rows.filter(r => r.restrict !== 'NO').map(r => r.id));
  const candidates = input.candidates.filter(c => selected.has(c.id));
  const nodeIds = new Set(candidates.flatMap(c => [...c.premises, c.target]));
  const nodes = input.nodes.filter(n => nodeIds.has(n.id));
  const passageIds = new Set(nodes.flatMap(n => n.sourcePassageIds));
  // Exact endpoint sources, no rewritten summaries or source renumbering.
  return structuredClone({ ...input, candidates, nodes, passages: input.passages.filter(p => passageIds.has(p.id)) });
}

export function combineUseLimitShadow(input: AuditInput, proposal: UseResult, audit?: LimitResult) {
  const rows = input.candidates.map(candidate => {
    const initial = proposal.rows.find(r => r.id === candidate.id);
    const routed = !!initial && initial.restrict !== 'NO';
    const checked = routed ? audit?.rows.find(r => r.id === candidate.id) : undefined;
    const conflicts = routed ? audit?.consistency.find(r => r.id === candidate.id)?.conflicts || [] : [];
    const proposedUses = initial ? [
      ...(initial.establish === 'YES' ? ['supports'] : []),
      ...(initial.rebut === 'YES' ? ['rebuts'] : []),
      ...(initial.restrict === 'YES' ? ['limits'] : []),
    ] : [];
    let disposition: 'REVIEW' | 'MODEL_PROPOSAL' | 'NO_RELATION_DECLARED' | 'LIMIT_CONFIRMED_SHADOW' = 'REVIEW';
    let reason = 'missing-or-invalid-proposal';
    if (initial) {
      const uncertain = [initial.establish, initial.rebut, initial.restrict].includes('UNCERTAIN');
      if (uncertain) reason = 'uncertain-proposal-not-promoted';
      else if (proposedUses.length > 1) reason = 'multiple-argumentative-uses-need-review';
      else if (routed) {
        if (!checked) reason = 'missing-or-invalid-limit-audit';
        else if (conflicts.length) reason = 'limit-audit-internal-conflict';
        else if (checked.limitsTarget !== 'YES') reason = 'limit-stages-disagree-or-uncertain';
        else { disposition = 'LIMIT_CONFIRMED_SHADOW'; reason = 'two-model-stages-agree-not-independent-human-proof'; }
      } else if (proposedUses.length) { disposition = 'MODEL_PROPOSAL'; reason = 'support-or-rebuttal-not-independently-audited'; }
      else { disposition = 'NO_RELATION_DECLARED'; reason = 'model-declares-no-argumentative-use-not-objective-truth'; }
    }
    return { id: candidate.id, candidate: structuredClone(candidate), initial: initial ? structuredClone(initial) : null,
      proposedUses, auxiliaryExplain: initial?.explain ?? null, routed,
      limitAudit: checked ? structuredClone(checked) : null, conflicts, disposition, reason,
      formalGraphAdmission: false as const };
  });
  return { version: RELATION_AUDIT_PIPELINE_VERSION, rows, proposalIssues: structuredClone(proposal.issues),
    auditIssues: structuredClone(audit?.issues || []), productionWrites: false as const, formalGraphAdmission: false as const };
}
