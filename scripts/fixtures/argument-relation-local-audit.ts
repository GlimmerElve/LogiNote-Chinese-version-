import { isArgumentRelationLabel, type ArgumentRelationCase, type ArgumentRelationLabel } from '../../src/services/argumentRelation/contract.ts';

/** Only explicit findings become draft labels; unflagged edges are NOT presumed correct. */
const FINDING_LABELS: Record<string, ArgumentRelationLabel> = {
  naming_as_support: 'define',
  table_reference_as_evidence: 'insufficient_evidence',
  incorrect_opposition_endpoints: 'insufficient_evidence',
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid local audit object');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Missing local audit text');
  return value;
}

export function buildLocalArgumentAuditCases(rawReview: unknown, rawCandidates: unknown) {
  const review = record(rawReview);
  if (!Array.isArray(review.findings) || !Array.isArray(rawCandidates)) throw new Error('Invalid local audit arrays');
  const candidates = rawCandidates.map(record);
  const byId = new Map<string, Record<string, unknown>>();
  for (const item of candidates) {
    const id = text(item.edgeId);
    if (byId.has(id)) throw new Error('Duplicate local edge id');
    if (!['support', 'oppose'].includes(text(item.relation))
      || !['admitted', 'audit_only'].includes(text(item.admission))) throw new Error('Invalid historical edge');
    byId.set(id, item);
  }
  const seen = new Set<string>();
  const cases = review.findings.map((value, index): ArgumentRelationCase => {
    const finding = record(value);
    const edgeId = text(finding.edgeId);
    if (seen.has(edgeId)) throw new Error('Duplicate local finding');
    seen.add(edgeId);
    const candidate = byId.get(edgeId);
    if (!candidate) throw new Error('Local finding has no source candidate');
    const classification = text(finding.classification);
    const label = FINDING_LABELS[classification];
    if (!isArgumentRelationLabel(label)) throw new Error(`Unmapped local finding: ${classification}`);
    if (!Number.isInteger(candidate.document) || (candidate.document as number) < 1) throw new Error('Invalid local document ordinal');
    const source = text(candidate.source);
    const target = text(candidate.target);
    const context = text(candidate.chunk);
    const normalize = (value: string) => value.replace(/\s+/gu, '');
    if (!normalize(context).includes(normalize(source)) || !normalize(context).includes(normalize(target))) {
      throw new Error('Local endpoints are not grounded in the saved context');
    }
    return {
      id: `local-${String(index + 1).padStart(3, '0')}`,
      groupId: `local-document-${candidate.document}`,
      origin: 'local_review', annotationStatus: 'assistant_draft', phenomenon: classification,
      sentences: [{ id: 's1', text: source }, { id: 's2', text: target }, { id: 'context', text: context }],
      sourceSentenceIds: ['s1'], targetSentenceIds: ['s2'], expectedLabel: label,
      annotationReason: text(finding.reason),
    };
  });
  if (review.edgesRead !== candidates.length || review.admittedEdges !== candidates.filter((item) => item.admission === 'admitted').length) {
    throw new Error('Local review/candidate counts disagree');
  }
  return {
    cases,
    audit: {
      candidateEdges: candidates.length,
      admittedEdges: candidates.filter((item) => item.admission === 'admitted').length,
      flaggedEdges: cases.length,
      flaggedAdmittedEdges: [...seen].filter((id) => byId.get(id)!.admission === 'admitted').length,
      limitations: [
        'Prior assistant findings, not independent human acceptance; requires adjudication.',
        'Unflagged edges remain unjudged, not true positives. No overall precision inferred.',
        'Source/target/context are local excerpt IDs, not new production sentence offsets.',
      ],
    },
  };
}
