/** Synthetic model outputs for transport/state tests, never a semantic coverage classifier. */
interface MasteryBaselineFixtureInput {
  criteria: ReadonlyArray<{ id: string; referenceRequired: boolean; layer?: string }>;
  references: Array<{ id: string; quote: string; layers?: string[]; criterionIds?: string[] }>;
  task?: { verificationScopes?: ReadonlyArray<{ id: string; criterionIds: string[]; referenceIds: string[] }> };
}

export function masteryBaselineFixture(input: MasteryBaselineFixtureInput) {
  return input.criteria.map(criterion => {
    const questionScope = input.task?.verificationScopes?.find(row => row.criterionIds.includes(criterion.id));
    const reference = input.references.find(row => (!row.layers || !criterion.layer || row.layers.includes(criterion.layer))
      && (!row.criterionIds || row.criterionIds.includes(criterion.id))
      && (!questionScope || questionScope.referenceIds.includes(row.id)));
    return { id: criterion.id, scope: `Synthetic fixture scope for ${criterion.id}; not a semantic verdict.`,
      scopeIds: [questionScope?.id || 'task'], applicability: 'applicable',
      coverage: !criterion.referenceRequired ? 'not_required' : reference ? 'covered' : 'insufficient',
      rule: reference ? 'Synthetic fixture rule; not a semantic verdict.' : '', referenceIds: reference ? [reference.id] : [],
      referenceQuotes: reference ? [{ referenceId: reference.id, quote: reference.quote.slice(0, 180) }] : [],
      reason: 'Synthetic fixture reference coverage for contract and state assertions only.' };
  });
}

/** Explicit mock comparison fields; their contents must never serve as real semantic evidence. */
export function masteryComparisonFixture(input: MasteryBaselineFixtureInput, criterionId: string, evidenceIds: string[]) {
  const criterion = input.criteria.find(row => row.id === criterionId);
  const baseline = masteryBaselineFixture(input).find(row => row.id === criterionId);
  return { requirement: `Synthetic fixture requirement for ${criterionId}; not a semantic verdict.`,
    evidenceIds, referenceIds: criterion?.referenceRequired ? baseline?.referenceIds || [] : [], scopeIds: baseline?.scopeIds || ['task'],
    finding: 'contradiction' as const, scopeMatch: true };
}
