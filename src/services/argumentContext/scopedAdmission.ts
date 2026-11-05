import type { ArgumentContextProjection } from './types';

/** A deterministic use-set, not an admission vote or source authority. The full graph,
 * rejected rows and gaps remain stored. Unknown/unlocated source gaps are never isolated. */
export function reviewedTaskScopeNodeIds(projection: ArgumentContextProjection, usableNodes?: ReadonlySet<string>): string[] {
  const nodes = new Map(projection.nodes.map(row => [row.id, row]));
  const edges = new Map(projection.relations.map(row => [row.id, row]));
  const groups = new Map(projection.prerequisiteGroups.map(row => [row.id, row]));
  const located = new Set([...nodes.keys(), ...edges.keys(), ...groups.keys()]);
  const global = new Set(['legacy_structure', 'hierarchy_incomplete', 'source_review_only',
    'source_quality_unknown', 'incomplete_extraction']);
  if (projection.build.origin !== 'validated-projection' || projection.quality.status !== 'eligible'
    || projection.build.gaps.some(gap => global.has(gap.code) || !gap.targetId || !located.has(gap.targetId))) return [];
  const admitted = (row: { admission: string; semanticStatus: string } | undefined) =>
    row?.admission === 'admitted' && row.semanticStatus === 'reviewed';
  const use = new Set<string>();
  for (const scope of projection.build.scopes) {
    if (scope.status !== 'reviewed_for_scope'
      || !['definition', 'condition', 'reasoning', 'fact', 'example', 'distinguish'].includes(scope.task)) continue;
    const selected = new Set([...scope.requiredNodeIds, ...scope.requiredRelationIds, ...scope.requiredGroupIds]);
    if (!scope.requiredNodeIds.includes(scope.seedNodeId)
      || projection.build.gaps.some(gap => gap.code !== 'scope_not_reviewed' && selected.has(gap.targetId!))
      || scope.requiredNodeIds.some(id => !admitted(nodes.get(id)) || usableNodes && !usableNodes.has(id))
      || scope.requiredRelationIds.some(id => {
        const edge = edges.get(id);
        return !admitted(edge) || !scope.requiredNodeIds.includes(edge!.sourceNodeId)
          || !scope.requiredNodeIds.includes(edge!.targetNodeId);
      }) || scope.requiredGroupIds.some(id => {
        const group = groups.get(id);
        if (!admitted(group) || group!.operator === 'unknown'
          || group!.operator === 'any' && group!.premiseNodeIds.length && group!.conditionNodeIds.length) return true;
        return ![group!.conclusionNodeId, ...group!.premiseNodeIds, ...group!.conditionNodeIds].every(member => scope.requiredNodeIds.includes(member))
          || !group!.relationIds.every(edge => scope.requiredRelationIds.includes(edge))
          || [...group!.premiseNodeIds, ...group!.conditionNodeIds].some(member => !group!.relationIds.some(id => {
            const edge = edges.get(id);
            return edge?.sourceNodeId === member && edge.targetNodeId === group!.conclusionNodeId
              && edge.kind === (group!.conditionNodeIds.includes(member) ? 'requires_condition' : 'support');
          }));
      })) continue;
    scope.requiredNodeIds.forEach(id => use.add(id));
  }
  return [...use].sort();
}
