import { isArgumentativeLabel, type ArgumentRelationInput, type ArgumentRelationPrediction } from './contract.ts';

export interface ArgumentDirectionCheck {
  direction: 'source_to_target' | 'target_to_source' | 'undetermined';
  basisSentenceIds: string[];
  conclusionSentenceIds: string[];
  premiseStatus: 'sufficient' | 'missing';
}

/** Structural consistency gate, NOT an independent semantic verifier. Never reverses an edge. */
export function checkArgumentDirection(input: ArgumentRelationInput, prediction: ArgumentRelationPrediction, raw: unknown) {
  if (input.id !== prediction.id) throw new Error('direction_case_mismatch');
  if (!isArgumentativeLabel(prediction.label)) return { prediction, status: 'not_applicable' as const };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('missing_direction_check');
  const value = raw as Record<string, unknown>;
  if (typeof value.direction !== 'string' || !['source_to_target', 'target_to_source', 'undetermined'].includes(value.direction)
    || typeof value.premiseStatus !== 'string' || !['sufficient', 'missing'].includes(value.premiseStatus)) throw new Error('invalid_direction_check');
  const known = new Set(input.sentences.map((sentence) => sentence.id));
  for (const ids of [value.basisSentenceIds, value.conclusionSentenceIds]) {
    if (!Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== 'string' || !known.has(id))
      || new Set(ids).size !== ids.length) throw new Error('invalid_direction_evidence');
  }
  const check = value as unknown as ArgumentDirectionCheck;
  const exact = (left: string[], right: string[]) => left.length === right.length && left.every((id) => right.includes(id));
  // Context can support a missing premise, but must not replace either endpoint in a pair.
  const forward = exact(check.basisSentenceIds, input.sourceSentenceIds) && exact(check.conclusionSentenceIds, input.targetSentenceIds);
  const reverse = exact(check.basisSentenceIds, input.targetSentenceIds) && exact(check.conclusionSentenceIds, input.sourceSentenceIds);
  if (!forward && !reverse) throw new Error('direction_endpoints_mismatch');
  const status = check.direction !== 'source_to_target' || !forward ? 'direction_rejected' as const
    : check.premiseStatus === 'missing' ? 'premise_rejected' as const : 'accepted' as const;
  return { status, prediction: status === 'accepted' ? prediction : {
    ...prediction, label: 'insufficient_evidence' as const,
    explanation: `[${status}] ${prediction.explanation}`,
  } };
}
