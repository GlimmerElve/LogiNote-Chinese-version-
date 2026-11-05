import type { QuickCheckSession } from '../../services/quickCheck';

/** Display only this question's frozen references; keep evaluation IDs untouched. */
export function quickCheckQuestionReferences(session: QuickCheckSession, question: QuickCheckSession['questions'][number]) {
  const ids = new Set(question.referenceIds);
  const seen = new Set<string>();
  return session.references.filter(reference => {
    if (!ids.has(reference.id)) return false;
    const key = JSON.stringify([reference.sourceId || reference.sourceLabel,
      reference.quote.normalize('NFKC').replace(/\s+/gu, ' ').trim()]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
