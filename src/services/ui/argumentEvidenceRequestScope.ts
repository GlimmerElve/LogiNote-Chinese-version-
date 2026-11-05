import type { ArgDoc } from '../argumentDoc/types';

export type ArgumentEvidenceRequestKind = 'search' | 'preview';

export interface ArgumentEvidenceRequestTicket {
  kind: ArgumentEvidenceRequestKind;
  scope: string;
  sequence: number;
}

/** Owns async evidence UI replies so results can never cross document/node revisions. */
export class ArgumentEvidenceRequestScope {
  private scope = '';
  private sequence: Record<ArgumentEvidenceRequestKind, number> = { search: 0, preview: 0 };

  setScope(scope: string): void {
    if (scope === this.scope) return;
    this.scope = scope;
    this.sequence.search += 1;
    this.sequence.preview += 1;
  }

  begin(kind: ArgumentEvidenceRequestKind): ArgumentEvidenceRequestTicket {
    const sequence = ++this.sequence[kind];
    return { kind, scope: this.scope, sequence };
  }

  owns(ticket: ArgumentEvidenceRequestTicket): boolean {
    return ticket.scope === this.scope && ticket.sequence === this.sequence[ticket.kind];
  }

  invalidate(): void {
    this.scope = '';
    this.sequence.search += 1;
    this.sequence.preview += 1;
  }
}

export function argumentEvidenceScopeKey(doc: ArgDoc, nodeId: string): string {
  const node = doc.nodes.find((item) => item.id === nodeId);
  return JSON.stringify([doc.doc_id, nodeId, node?.mainType || '', node?.text || '', node?.status || '']);
}

export function isCurrentArgumentEvidenceCandidate(
  candidateScope: string,
  currentScope: string,
  candidateId: string,
  visibleCandidateIds: readonly string[],
): boolean {
  return Boolean(candidateScope && candidateScope === currentScope && visibleCandidateIds.includes(candidateId));
}
