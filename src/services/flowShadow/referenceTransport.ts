import type { ShadowReferenceComparison, ShadowReferencePacket, ShadowReferenceTarget, ShadowWarning } from './types';

export const SHARED_REFERENCE_TRANSPORT = 'shared-sources-v1' as const;
export type SharedReferenceTransport = typeof SHARED_REFERENCE_TRANSPORT;

/** Group identical retrieval INPUTS, not judgments or grades. No approximate semantic merging. */
export function groupReferenceRetrievalTargets(targets: readonly ShadowReferenceTarget[]) {
  const groups = new Map<string, { query: string; targetIds: string[] }>();
  for (const target of targets) {
    const group = groups.get(target.query) || { query: target.query, targetIds: [] };
    group.targetIds.push(target.id);
    groups.set(target.query, group);
  }
  return [...groups.values()];
}

/** Transport-only source pooling. Full original packet/IDs remain authoritative for scoring and history. */
export function projectShadowReferencePacket(original: ShadowReferencePacket) {
  type Source = Pick<ShadowReferencePacket['items'][number], 'tier' | 'sourceType' | 'sourceId' | 'title' | 'locator' | 'availability' | 'text'> & { id: string };
  const items: Source[] = [];
  const aliases = new Map<string, string[]>();
  const itemToAlias = new Map<string, string>();
  const bySource = new Map<string, string>();
  const reserved = new Set(original.items.map(item => item.id));
  let sequence = 0;
  for (const item of original.items) {
    // Same words in another document/location/tier are not the same evidence.
    // Exact text only: never normalize away a condition, punctuation or quotation boundary.
    const key = JSON.stringify([item.tier, item.sourceType, item.sourceId, item.title, item.locator, item.availability, item.text]);
    let alias = bySource.get(key);
    if (!alias) {
      do { alias = `D${++sequence}`; } while (reserved.has(alias));
      bySource.set(key, alias);
      const { tier, sourceType, sourceId, title, locator, availability, text } = item;
      items.push({ id: alias, tier, sourceType, sourceId, title, locator, availability, text });
      aliases.set(alias, []);
    }
    aliases.get(alias)!.push(item.id);
    itemToAlias.set(item.id, alias);
  }
  const byId = new Map(original.items.map(item => [item.id, item]));
  const packet = {
    version: SHARED_REFERENCE_TRANSPORT,
    // Retrieval queries duplicate graph text and are not instructions for the evaluator.
    // Keep every evaluation target, layer and exact node binding; no score denominator changes.
    targets: original.targets.map(({ id, layer, nodeIds }) => ({ id, layer, nodeIds: [...nodeIds] })),
    items,
    selection: original.selection.map(selection => ({
      targetId: selection.targetId, primaryTier: selection.primaryTier,
      itemIds: [...new Set(selection.itemIds.map(id => itemToAlias.get(id) || id))],
      uses: selection.itemIds.flatMap(id => {
        const item = byId.get(id), itemId = itemToAlias.get(id);
        return item && itemId ? [{ itemId, relation: item.relation, similarity: item.similarity }] : [];
      }),
    })),
    gaps: original.gaps.map(gap => ({ ...gap })),
    limits: { ...original.limits },
  };
  return { packet, aliases, itemToAlias };
}

/** Only current explicitly opted-in requests decode pooled IDs. Historical unknown IDs stay unknown. */
export function restoreShadowReferenceIds(targetId: string, referenceIds: string[], original: ShadowReferencePacket): string[] {
  const projected = projectShadowReferencePacket(original);
  const originalById = new Map(original.items.map(item => [item.id, item]));
  const selected = new Set(original.selection.find(selection => selection.targetId === targetId)?.itemIds || []);
  return [...new Set(referenceIds.flatMap(id => {
    if (originalById.has(id)) return [id]; // Existing model responses remain valid without rewriting them.
    const scoped = (projected.aliases.get(id) || []).filter(candidateId => selected.has(candidateId)
      && originalById.get(candidateId)?.targetId === targetId);
    return scoped.length ? scoped : [id]; // Never grant another target's source or guess an unknown ID.
  }))];
}

export function restoreShadowReferenceComparisons(comparisons: ShadowReferenceComparison[], original: ShadowReferencePacket): ShadowReferenceComparison[] {
  return comparisons.map(comparison => ({ ...comparison,
    referenceIds: restoreShadowReferenceIds(comparison.targetId, comparison.referenceIds, original) }));
}

/** Validate declaration membership, not source relevance. Do not borrow or replace another target's source. */
export function reviewShadowReferenceBindings(comparisons: readonly ShadowReferenceComparison[], original: ShadowReferencePacket): ShadowWarning[] {
  const projected = projectShadowReferencePacket(original);
  const selections = new Map(original.selection.map(selection => [selection.targetId, selection.itemIds]));
  return comparisons.flatMap(comparison => {
    const selected = selections.get(comparison.targetId) || [];
    const allowed = new Set([...selected, ...selected.flatMap(id => {
      const alias = projected.itemToAlias.get(id); return alias ? [alias] : [];
    })]);
    return comparison.referenceIds.some(id => !allowed.has(id)) ? [{ code: 'reference_selection_mismatch', target: comparison.id,
      message: '引用ID不在当前目标的selection中；保留原始声明供核对，不自动替换资料或认可该项对照。' }] : [];
  });
}
