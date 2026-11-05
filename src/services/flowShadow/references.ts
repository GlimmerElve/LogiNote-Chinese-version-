import type {
  ShadowGraph, ShadowInput, ShadowLayer, ShadowReferenceCandidate, ShadowReferencePacket,
  ShadowReferenceTarget, ShadowReferenceTier,
} from './types.ts';

/**
 * One strongest available source per semantic target. This makes source priority a
 * retrieval rule instead of a label, and keeps long generated textbooks out of the
 * assessment prompt except for their locally retrieved passages.
 */
export const DEFAULT_SHADOW_REFERENCE_LIMITS = Object.freeze({
  targetLimit: 12,
  itemLimit: 12,
  perTargetLimit: 1,
  characterLimit: 8000,
});

const compact = (value: string, max = 600): string => value.replace(/\s+/gu, ' ').trim().slice(0, max);

/** Deterministic retrieval targets. No semantic score, profile or source is read here. */
export function buildShadowReferenceTargets(graph: ShadowGraph, targetLimit: number = DEFAULT_SHADOW_REFERENCE_LIMITS.targetLimit): ShadowReferenceTarget[] {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const buckets: Record<ShadowLayer, ShadowReferenceTarget[]> = { concept: [], judgment: [], reasoning: [] };
  for (const node of graph.nodes) {
    if (node.role === 'background') buckets.concept.push({ id: `T-C-${node.id}`, layer: 'concept', nodeIds: [node.id], query: compact(node.text) });
    if (node.role === 'claim') buckets.judgment.push({ id: `T-J-${node.id}`, layer: 'judgment', nodeIds: [node.id], query: compact(node.text) });
  }
  for (const argument of graph.arguments) {
    const ids = [...new Set([argument.claim, ...argument.support, ...argument.oppose])];
    const query = compact(ids.map(id => nodes.get(id)?.text || '').filter(Boolean).join('；'));
    buckets.reasoning.push({ id: `T-R-${argument.id}`, layer: 'reasoning', nodeIds: ids, query });
  }
  // Round-robin prevents a long concept or claim list from starving another layer.
  const targets: ShadowReferenceTarget[] = [];
  for (let index = 0; targets.length < targetLimit; index++) {
    let added = false;
    for (const layer of ['concept', 'judgment', 'reasoning'] as const) {
      if (buckets[layer][index]) { targets.push(buckets[layer][index]); added = true; }
      if (targets.length >= targetLimit) break;
    }
    if (!added) break;
  }
  return targets;
}

function validCandidate(candidate: ShadowReferenceCandidate, targetIds: Set<string>): boolean {
  return Boolean(candidate && candidate.id?.trim() && targetIds.has(candidate.targetId)
    && [1, 2, 3, 4].includes(candidate.tier)
    && ['project_textbook', 'project_resource', 'online_resource', 'linked_knowledge', 'mentioned_knowledge', 'model_prior'].includes(candidate.sourceType)
    && candidate.sourceId?.trim() && candidate.sourceId.length <= 300 && candidate.title?.trim() && candidate.title.length <= 300
    && typeof candidate.locator === 'string' && candidate.locator.length <= 500
    && ['definition', 'boundary', 'claim', 'condition', 'premise', 'counterexample', 'method', 'other'].includes(candidate.relation)
    && ['available', 'unreadable', 'missing'].includes(candidate.availability) && typeof candidate.text === 'string' && candidate.text.length <= 2000
    && (candidate.similarity === null || (Number.isFinite(candidate.similarity) && candidate.similarity >= 0 && candidate.similarity <= 1)));
}

export function parseShadowReferenceCandidates(value: unknown, targets: readonly ShadowReferenceTarget[]): ShadowReferenceCandidate[] {
  if (!Array.isArray(value) || value.length > 120) throw new Error('影子参考候选必须是最多120项的JSON数组。');
  const targetIds = new Set(targets.map(target => target.id));
  const candidates = value.map(candidate => candidate as ShadowReferenceCandidate);
  if (candidates.some(candidate => !validCandidate(candidate, targetIds))) throw new Error('影子参考候选含无效字段、未知目标或超长正文。');
  if (new Set(candidates.map(candidate => candidate.id)).size !== candidates.length) throw new Error('影子参考候选ID重复。');
  return structuredClone(candidates);
}

const candidateOrder = (a: ShadowReferenceCandidate, b: ShadowReferenceCandidate) => a.tier - b.tier
  || (b.similarity ?? -1) - (a.similarity ?? -1) || a.id.localeCompare(b.id);

/**
 * Builds a bounded, source-priority packet. Tier 4 is advisory model prior and is never admitted as evidence.
 * Unreadable higher-priority sources are logged; the next available tier becomes primary for that target.
 */
export function buildShadowReferencePacket(input: ShadowInput, graph: ShadowGraph, rawCandidates: readonly ShadowReferenceCandidate[],
  limits: { targetLimit: number; itemLimit: number; perTargetLimit: number; characterLimit?: number } = DEFAULT_SHADOW_REFERENCE_LIMITS): ShadowReferencePacket {
  void input; // Kept in the boundary so a future provider can bind project scope without changing this contract.
  const safeLimits = {
    targetLimit: Math.max(1, Math.min(24, Math.trunc(limits.targetLimit))),
    itemLimit: Math.max(1, Math.min(72, Math.trunc(limits.itemLimit))),
    perTargetLimit: Math.max(1, Math.min(8, Math.trunc(limits.perTargetLimit))),
    characterLimit: Math.max(1000, Math.min(16000, Math.trunc(limits.characterLimit ?? 8000))),
  };
  const targets = buildShadowReferenceTargets(graph, safeLimits.targetLimit);
  const targetIds = new Set(targets.map(target => target.id));
  const candidates = rawCandidates.filter(candidate => validCandidate(candidate, targetIds));
  const seen = new Set<string>();
  const unique = candidates.filter(candidate => {
    const key = `${candidate.targetId}\u0000${candidate.sourceId}\u0000${candidate.locator}\u0000${compact(candidate.text, 4000)}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  const gaps: ShadowReferencePacket['gaps'] = [];
  for (const candidate of unique) {
    if (candidate.tier === 4 || candidate.sourceType === 'model_prior') gaps.push({ targetId: candidate.targetId, tier: 4,
      sourceId: candidate.sourceId, reason: 'LLM既有知识只可生成待核对建议，不能作为评分证据。' });
    else if (candidate.availability !== 'available' || !candidate.text.trim()) gaps.push({ targetId: candidate.targetId,
      tier: candidate.tier, sourceId: candidate.sourceId,
      reason: candidate.availability === 'unreadable' ? '来源当前不可读取，已降级检索下一优先级。' : '来源缺失或没有可引用正文。' });
  }
  const queues = new Map<string, ShadowReferenceCandidate[]>();
  for (const target of targets) queues.set(target.id, unique.filter(candidate => candidate.targetId === target.id
    && candidate.tier <= 3 && candidate.sourceType !== 'model_prior'
    && candidate.availability === 'available' && Boolean(candidate.text.trim())).sort(candidateOrder));
  const selected = new Map<string, ShadowReferenceCandidate[]>();
  for (const target of targets) selected.set(target.id, []);
  let selectedCount = 0, selectedCharacters = 0;
  // Fair round-robin: every target can receive its strongest source before any target receives extras.
  for (let slot = 0; slot < safeLimits.perTargetLimit; slot++) {
    for (const target of targets) {
      if (selectedCount >= safeLimits.itemLimit) break;
      const candidate = queues.get(target.id)?.[slot];
      if (candidate && selectedCharacters + candidate.text.length <= safeLimits.characterLimit) {
        selected.get(target.id)!.push(candidate);
        selectedCount += 1;
        selectedCharacters += candidate.text.length;
      }
    }
  }
  const items = targets.flatMap(target => selected.get(target.id) || []);
  const selection = targets.map(target => {
    const targetItems = selected.get(target.id) || [];
    const primaryTier = targetItems.length ? Math.min(...targetItems.map(item => item.tier)) as 1 | 2 | 3 : null;
    return { targetId: target.id, primaryTier, itemIds: targetItems.map(item => item.id) };
  });
  return { version: 'shadow-reference-packet-v1', targets, items, selection, gaps, limits: safeLimits };
}

export function emptyShadowReferencePacket(input: ShadowInput, graph: ShadowGraph): ShadowReferencePacket {
  return buildShadowReferencePacket(input, graph, []);
}

export interface ShadowReferenceProvider {
  /** Implementations return candidates only. They must not write notes, mastery, profile or RAG state. */
  retrieve(input: Readonly<ShadowInput>, graph: Readonly<ShadowGraph>, targets: readonly ShadowReferenceTarget[], signal?: AbortSignal):
    Promise<readonly ShadowReferenceCandidate[]>;
}

export function sourcePriorityLabel(tier: ShadowReferenceTier): string {
  return ({ 1: '项目正文/教材', 2: '项目关联资源', 3: '关联知识点', 4: 'LLM待核对建议' } as const)[tier];
}
