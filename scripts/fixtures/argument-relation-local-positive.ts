import type { ArgumentRelationCase } from '../../src/services/argumentRelation/contract.ts';
import { relationFingerprint } from '../argument-relation-hash.ts';

// Selection reviewed against full saved context, NOT inferred from historical admission or model confidence.
// Private source text stays in ignored local files; hashes anchor reviewed endpoints against accidental corpus drift.
export interface LocalPositiveSelection { endpointHash: string; reason: string }
export function buildLocalPositiveCases(raw: unknown, selections: LocalPositiveSelection[]): ArgumentRelationCase[] {
  if (!Array.isArray(raw)) throw new Error('Invalid local candidates');
  const selected = new Set<string>();
  return selections.map((selection, index) => {
    if (selected.has(selection.endpointHash)) throw new Error('Duplicate positive selection');
    selected.add(selection.endpointHash);
    const matches = raw.filter((item) => item && relationFingerprint([item.source, item.target, item.chunk]) === selection.endpointHash);
    if (matches.length !== 1) throw new Error('Reviewed positive source changed or missing');
    const item = matches[0];
    if (![item.source, item.target, item.chunk].every((value) => typeof value === 'string' && value.trim())
      || !Number.isInteger(item.document) || item.document < 1) throw new Error('Invalid positive source');
    const compact = (value: string) => value.replace(/\s+/gu, '');
    if (![item.source, item.target].every((value) => compact(item.chunk).includes(compact(value)))) throw new Error('Positive endpoints not grounded');
    return { id: `local-positive-${index + 1}`, groupId: `local-document-${item.document}`,
      origin: 'local_review', annotationStatus: 'assistant_draft', phenomenon: 'reviewed_problem_or_benefit_to_recommendation',
      sentences: [{ id: 's1', text: item.source }, { id: 's2', text: item.target }, { id: 'context', text: item.chunk }],
      sourceSentenceIds: ['s1'], targetSentenceIds: ['s2'], expectedLabel: 'support', annotationReason: selection.reason };
  });
}
