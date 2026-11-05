import type { MasteryShadowReferenceItem } from './evaluator';
import { masteryShadowCriterion, type MasteryShadowCriterionId } from './rubric';

export const MASTERY_REFERENCE_LIMITS = Object.freeze({ characters: 6000, serializedCharacters: 10000, items: 12, itemCharacters: 1400 });

/** Whole original passages only. Round-robin protects different criteria/layers;
 * budget omissions are not evidence of absence or a failed answer. */
export function packMasteryReferences(groups: Array<{ criterionId: MasteryShadowCriterionId; references: MasteryShadowReferenceItem[] }>,
  limits: { characters: number; serializedCharacters: number; items: number; itemCharacters: number } = MASTERY_REFERENCE_LIMITS) {
  const ordered = groups.slice().sort((a, b) => {
    const index = (id: MasteryShadowCriterionId) => groups.filter(group => masteryShadowCriterion(group.criterionId)!.layer === masteryShadowCriterion(id)!.layer)
      .findIndex(group => group.criterionId === id);
    return index(a.criterionId) - index(b.criterionId);
  });
  const fits = (rows: MasteryShadowReferenceItem[]) => rows.length <= limits.items
    && rows.reduce((sum, row) => sum + row.quote.length, 0) <= limits.characters
    && JSON.stringify(rows).length <= limits.serializedCharacters;
  let references: MasteryShadowReferenceItem[] = [];
  const depth = Math.max(0, ...groups.map(group => group.references.length));
  for (let slot = 0; slot < depth; slot++) for (const group of ordered) {
    const candidate = group.references[slot];
    if (!candidate?.quote.trim() || candidate.quote.length > limits.itemCharacters) continue;
    const next = structuredClone(references);
    const same = next.find(row => row.sourceId === candidate.sourceId && row.tier === candidate.tier && row.quote === candidate.quote);
    if (same) {
      same.criterionIds = [...new Set([...(same.criterionIds || []), group.criterionId])];
      same.layers = [...new Set([...(same.layers || []), masteryShadowCriterion(group.criterionId)!.layer])];
      if (candidate.sourceRole === 'primary') same.sourceRole = 'primary';
    } else {
      if (next.some(row => row.id === candidate.id)) continue;
      next.push({ ...structuredClone(candidate), criterionIds: [group.criterionId], layers: [masteryShadowCriterion(group.criterionId)!.layer] });
    }
    if (fits(next)) references = next;
  }
  return { references, omittedCriterionIds: groups.filter(group => !references.some(row => row.criterionIds?.includes(group.criterionId))).map(group => group.criterionId),
    characters: references.reduce((sum, row) => sum + row.quote.length, 0), limits };
}
