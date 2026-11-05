import { argumentContextHash, compareArgumentContextIds } from './hash';
import {
  type ArgumentContextAuthority, type ArgumentContextGap, type ArgumentContextGapCode,
  type ArgumentContextHierarchy, type ArgumentContextNode, type ArgumentContextPack,
  type ArgumentContextPointer, type ArgumentContextProjection, type ArgumentContextRelation,
  type ArgumentContextRequest, type ArgumentContextScope, type ArgumentPrerequisiteGroup,
} from './types';
import { normalizeArgumentContextBudget, validateArgumentContextProjection } from './validator';

/** Creating a pointer authenticates the supplied snapshot; it grants no additional access. */
export async function createArgumentContextPointer(projectionInput: ArgumentContextProjection,
  authorityInput: ArgumentContextAuthority, scopeInput: ArgumentContextScope, seedNodeIdsInput: string[]): Promise<ArgumentContextPointer> {
  const projection = structuredClone(projectionInput), authority = structuredClone(authorityInput);
  const scope = structuredClone(scopeInput), seedNodeIds = structuredClone(seedNodeIdsInput);
  const pointer: ArgumentContextPointer = { version: 1, scopeId: scope.scopeId,
    scopeHash: await argumentContextHash(scope), source: structuredClone(projection.source), structureHash: authority.structureHash, seedNodeIds };
  await validateArgumentContextProjection(projection, authority, { pointer, scope, task: 'general' });
  return structuredClone(pointer);
}

function selectHierarchy(projection: ArgumentContextProjection, nodes: ArgumentContextNode[],
  relations: ArgumentContextRelation[]): ArgumentContextHierarchy {
  const sentenceIds = new Set([...nodes, ...relations].flatMap((item) => item.evidence.map((span) => span.sentenceId)));
  const sentences = projection.hierarchy.sentences.filter((sentence) => sentenceIds.has(sentence.id));
  const blockIds = new Set(sentences.map((sentence) => sentence.blockId));
  const sections = new Map(projection.hierarchy.sections.map((section) => [section.id, section]));
  const sectionIds = new Set<string>();
  for (const block of projection.hierarchy.blocks) {
    if (!blockIds.has(block.id)) continue;
    let id = block.sectionId;
    while (id !== null && !sectionIds.has(id)) {
      sectionIds.add(id); id = sections.get(id)!.parentId;
    }
  }
  // A selected subset retains original adjacency only when both original neighbors are read.
  // It does not connect physically non-adjacent blocks, and never creates argument relations.
  return { sections: projection.hierarchy.sections.filter((section) => sectionIds.has(section.id)),
    blocks: projection.hierarchy.blocks.filter((block) => blockIds.has(block.id)).map((block) => ({ ...block,
      previousId: block.previousId !== null && blockIds.has(block.previousId) ? block.previousId : null,
      nextId: block.nextId !== null && blockIds.has(block.nextId) ? block.nextId : null })), sentences };
}

/** The character budget includes every returned quotation, including repeated payload quotations. */
function characterCost(projection: ArgumentContextProjection, nodes: ArgumentContextNode[], relations: ArgumentContextRelation[]): number {
  const hierarchy = selectHierarchy(projection, nodes, relations);
  return [...nodes, ...relations].reduce((total, item) => total + item.evidence.reduce((sum, span) => sum + span.quote.length, 0), 0)
    + hierarchy.sentences.reduce((sum, sentence) => sum + sentence.quote.length, 0)
    + hierarchy.sections.reduce((sum, section) => sum + section.path.length, 0);
}

type ReadTask = { kind: 'node' | 'relation' | 'group'; id: string; depth: number; priority: number; sequence: number };
const hardGapCodes = new Set<ArgumentContextGapCode>(['missing_prerequisite', 'missing_node', 'missing_relation', 'missing_group',
  'unadmitted_node', 'unadmitted_relation', 'unadmitted_group', 'node_budget', 'relation_budget', 'character_budget', 'depth_budget']);

/** Pure bounded reading of stored decisions. No model, similarity lookup, storage access or writes. */
export async function readArgumentContextPack(projectionInput: ArgumentContextProjection,
  authorityInput: ArgumentContextAuthority, requestInput: ArgumentContextRequest): Promise<ArgumentContextPack> {
  // Clone all authorities/capabilities before the first await, including the supplied limits.
  const projection = structuredClone(projectionInput), authority = structuredClone(authorityInput), request = structuredClone(requestInput);
  const budget = normalizeArgumentContextBudget(request.budget);
  await validateArgumentContextProjection(projection, authority, request);
  const nodes = new Map(projection.nodes.map((node) => [node.id, node]));
  const relations = new Map(projection.relations.map((relation) => [relation.id, relation]));
  const groups = new Map(projection.prerequisiteGroups.map((group) => [group.id, group]));
  const readNodes = new Map<string, ArgumentContextNode>(), readRelations = new Map<string, ArgumentContextRelation>();
  const readGroups = new Map<string, ArgumentPrerequisiteGroup>();
  const requiredNodes = new Set(request.pointer.seedNodeIds), requiredRelations = new Set<string>(), requiredGroups = new Set<string>();
  const omittedNodes = new Set<string>(), omittedRelations = new Set<string>(), omittedGroups = new Set<string>();
  const gaps = new Map<string, ArgumentContextGap>();
  const addGap = (code: ArgumentContextGapCode, targetId?: string) => {
    gaps.set(`${code}\u0000${targetId ?? ''}`, targetId === undefined ? { code } : { code, targetId });
  };
  projection.build.gaps.forEach((gap) => addGap(gap.code, gap.targetId));
  const storedGapKeys = new Set(gaps.keys());
  if (projection.build.origin === 'legacy-adapter') addGap('legacy_structure');
  if (projection.quality.status === 'review_only') addGap('source_review_only');
  else if (request.scope.corpus === 'reference' && projection.quality.status !== 'eligible'
    || request.scope.corpus === 'personal' && projection.quality.status !== 'eligible' && projection.quality.status !== 'not_applicable') addGap('source_quality_unknown');
  let allScopesReviewed = true;
  for (const seed of request.pointer.seedNodeIds) {
    const scope = projection.build.scopes.find((item) => item.seedNodeId === seed && item.task === request.task);
    if (!scope || scope.status !== 'reviewed_for_scope') { allScopesReviewed = false; addGap('scope_not_reviewed', seed); }
    if (scope) {
      scope.requiredNodeIds.forEach((id) => requiredNodes.add(id));
      scope.requiredRelationIds.forEach((id) => requiredRelations.add(id));
      scope.requiredGroupIds.forEach((id) => requiredGroups.add(id));
    }
  }
  // Scope declarations describe what is required, not permission to flatten a long chain
  // into depth zero. Measure real stored, admitted connectivity from the requested seeds.
  // Reading may traverse an incoming edge; this never reverses the returned relation.
  const adjacency = new Map<string, string[]>();
  for (const relation of projection.relations) {
    if (relation.admission !== 'admitted' || nodes.get(relation.sourceNodeId)!.admission !== 'admitted'
      || nodes.get(relation.targetNodeId)!.admission !== 'admitted') continue;
    const left = adjacency.get(relation.sourceNodeId) ?? [], right = adjacency.get(relation.targetNodeId) ?? [];
    left.push(relation.targetNodeId); right.push(relation.sourceNodeId);
    adjacency.set(relation.sourceNodeId, left); adjacency.set(relation.targetNodeId, right);
  }
  const seedDistances = new Map(request.pointer.seedNodeIds.map((id) => [id, 0]));
  const distanceQueue = [...request.pointer.seedNodeIds];
  for (let index = 0; index < distanceQueue.length; index += 1) {
    const id = distanceQueue[index];
    for (const neighbor of adjacency.get(id) ?? []) {
      if (seedDistances.has(neighbor)) continue;
      seedDistances.set(neighbor, seedDistances.get(id)! + 1); distanceQueue.push(neighbor);
    }
  }
  // An explicitly declared, disconnected evidence item is a direct scope read at depth
  // one. It is not a fabricated path or an implicit support edge to the seed.
  const nodeDepth = (id: string, proposedDepth: number) => seedDistances.get(id) ?? (requiredNodes.has(id) ? 1 : proposedDepth);
  const queue: ReadTask[] = [];
  const shortestQueued = new Map<string, number>(), expandedAt = new Map<string, number>();
  let sequence = 0;
  const enqueue = (kind: ReadTask['kind'], id: string, depth: number, priority: number) => {
    if (kind === 'node') depth = nodeDepth(id, depth);
    const key = `${kind}\u0000${id}`, previous = shortestQueued.get(key);
    if (previous !== undefined && previous <= depth) return;
    shortestQueued.set(key, depth); queue.push({ kind, id, depth, priority, sequence: sequence++ });
  };
  request.pointer.seedNodeIds.forEach((id) => enqueue('node', id, 0, -3));
  requiredGroups.forEach((id) => enqueue('group', id, 0, -2));
  requiredRelations.forEach((id) => enqueue('relation', id, 0, -1));
  requiredNodes.forEach((id) => enqueue('node', id, 0, 0));

  const candidateRows = (nodeIds: string[], relationIds: string[]) => ({
    nodes: [...readNodes.values(), ...nodeIds.filter((id) => !readNodes.has(id)).map((id) => nodes.get(id)!)],
    relations: [...readRelations.values(), ...relationIds.filter((id) => !readRelations.has(id)).map((id) => relations.get(id)!)],
  });
  const commit = (nodeIds: string[], relationIds: string[], depth: number, targetId: string): boolean => {
    if (nodeIds.some((id) => nodeDepth(id, depth) > budget.maxDepth)) { addGap('depth_budget', targetId); return false; }
    const rows = candidateRows(nodeIds, relationIds);
    if (rows.nodes.length > budget.maxNodes) { addGap('node_budget', targetId); return false; }
    if (rows.relations.length > budget.maxRelations) { addGap('relation_budget', targetId); return false; }
    if (characterCost(projection, rows.nodes, rows.relations) > budget.maxCharacters) { addGap('character_budget', targetId); return false; }
    for (const id of nodeIds) {
      const node = nodes.get(id)!; readNodes.set(id, node); omittedNodes.delete(id);
      if (node.semanticStatus !== 'reviewed') addGap('structure_unreviewed', id);
      enqueue('node', id, depth, requiredNodes.has(id) ? 0 : 3);
    }
    for (const id of relationIds) {
      const relation = relations.get(id)!; readRelations.set(id, relation); omittedRelations.delete(id);
      if (relation.semanticStatus !== 'reviewed') addGap('structure_unreviewed', id);
    }
    return true;
  };
  const nodeUsable = (id: string) => {
    const node = nodes.get(id);
    if (!node) { addGap('missing_node', id); omittedNodes.add(id); return false; }
    if (node.admission !== 'admitted') { addGap('unadmitted_node', id); omittedNodes.add(id); return false; }
    return true;
  };
  const relationUsable = (id: string) => {
    const relation = relations.get(id);
    if (!relation) { addGap('missing_relation', id); omittedRelations.add(id); return false; }
    if (relation.admission !== 'admitted') { addGap('unadmitted_relation', id); omittedRelations.add(id); return false; }
    return true;
  };
  const relationPriority = (relation: ArgumentContextRelation) => requiredRelations.has(relation.id) ? -1
    : relation.kind === 'requires_condition' ? 1 : relation.kind === 'exception_of' ? 2
      : relation.kind === 'support' || relation.kind === 'oppose' ? 4 : 5;
  while (queue.length) {
    queue.sort((a, b) => a.priority - b.priority || a.depth - b.depth || a.sequence - b.sequence || compareArgumentContextIds(a.id, b.id));
    const task = queue.shift()!, key = `${task.kind}\u0000${task.id}`;
    if (shortestQueued.get(key) !== task.depth) continue;
    if (task.kind === 'group') {
      const group = groups.get(task.id);
      requiredGroups.add(task.id);
      if (!group) { addGap('missing_group', task.id); omittedGroups.add(task.id); continue; }
      const memberIds = [...new Set([group.conclusionNodeId, ...group.conditionNodeIds, ...group.premiseNodeIds])];
      memberIds.forEach((id) => requiredNodes.add(id)); group.relationIds.forEach((id) => requiredRelations.add(id));
      let available = memberIds.map(nodeUsable).every(Boolean) && group.relationIds.map(relationUsable).every(Boolean);
      if (group.admission !== 'admitted') { addGap('unadmitted_group', group.id); available = false; }
      if (group.operator === 'unknown') { addGap('unknown_prerequisite_operator', group.id); available = false; }
      for (const member of [...group.premiseNodeIds, ...group.conditionNodeIds]) {
        if (!group.relationIds.some((id) => relations.get(id)?.sourceNodeId === member && relations.get(id)?.targetNodeId === group.conclusionNodeId)) {
          addGap('missing_prerequisite', member); available = false;
        }
      }
      if (available && commit(memberIds, group.relationIds, task.depth, group.id)) {
        readGroups.set(group.id, group); omittedGroups.delete(group.id);
        if (group.semanticStatus !== 'reviewed') addGap('structure_unreviewed', group.id);
      } else {
        omittedGroups.add(group.id); addGap('missing_prerequisite', group.id);
        memberIds.filter((id) => !readNodes.has(id)).forEach((id) => { omittedNodes.add(id); enqueue('node', id, task.depth, 0); });
        group.relationIds.filter((id) => !readRelations.has(id)).forEach((id) => { omittedRelations.add(id); enqueue('relation', id, task.depth, -1); });
      }
    } else if (task.kind === 'relation') {
      if (!relationUsable(task.id)) continue;
      const relation = relations.get(task.id)!;
      const endpoints = [relation.sourceNodeId, relation.targetNodeId];
      if (!endpoints.map(nodeUsable).every(Boolean) || !commit(endpoints, [relation.id], task.depth, relation.id)) {
        omittedRelations.add(relation.id);
        endpoints.filter((id) => !readNodes.has(id)).forEach((id) => omittedNodes.add(id));
      }
    } else {
      if (!nodeUsable(task.id)) continue;
      if (!readNodes.has(task.id) && !commit([task.id], [], task.depth, task.id)) { omittedNodes.add(task.id); continue; }
      if ((expandedAt.get(task.id) ?? Infinity) <= task.depth) continue;
      expandedAt.set(task.id, task.depth);
      const nodeGroups = projection.prerequisiteGroups.filter((group) => group.conclusionNodeId === task.id).sort((a, b) => compareArgumentContextIds(a.id, b.id));
      nodeGroups.forEach((group) => enqueue('group', group.id, task.depth + 1, -2));
      const incident = projection.relations.filter((relation) => relation.sourceNodeId === task.id || relation.targetNodeId === task.id)
        .sort((a, b) => relationPriority(a) - relationPriority(b) || compareArgumentContextIds(a.id, b.id));
      for (const relation of incident) {
        // Traversal may read either endpoint, but the returned edge retains its original direction.
        if (relation.kind === 'requires_condition' && relation.targetNodeId === task.id) {
          requiredNodes.add(relation.sourceNodeId); requiredRelations.add(relation.id);
        }
        const bothRead = readNodes.has(relation.sourceNodeId) && readNodes.has(relation.targetNodeId);
        enqueue('relation', relation.id, bothRead ? task.depth : task.depth + 1, relationPriority(relation));
      }
    }
  }
  // A group may become fully readable after another shortest path or an individual member was read.
  for (const id of requiredGroups) {
    const group = groups.get(id);
    if (!group || group.admission !== 'admitted' || group.operator === 'unknown') continue;
    const members = [group.conclusionNodeId, ...group.premiseNodeIds, ...group.conditionNodeIds];
    if (members.every((member) => readNodes.has(member)) && group.relationIds.every((relation) => readRelations.has(relation))
      && [...group.premiseNodeIds, ...group.conditionNodeIds].every((member) => group.relationIds.some((relation) => relations.get(relation)?.sourceNodeId === member))) {
      readGroups.set(id, group); omittedGroups.delete(id);
      if (group.semanticStatus !== 'reviewed') addGap('structure_unreviewed', id);
    }
  }
  requiredNodes.forEach((id) => { if (!readNodes.has(id)) omittedNodes.add(id); });
  requiredRelations.forEach((id) => { if (!readRelations.has(id)) omittedRelations.add(id); });
  requiredGroups.forEach((id) => { if (!readGroups.has(id)) omittedGroups.add(id); });
  // Remove provisional budget gaps only if their exact target was subsequently read successfully.
  for (const [key, gap] of gaps) {
    if (storedGapKeys.has(key)) continue;
    if (['node_budget', 'relation_budget', 'character_budget', 'depth_budget'].includes(gap.code) && gap.targetId !== undefined
      && (readNodes.has(gap.targetId) || readRelations.has(gap.targetId) || readGroups.has(gap.targetId))) gaps.delete(key);
    if (gap.code === 'missing_prerequisite' && gap.targetId !== undefined && readGroups.has(gap.targetId)) gaps.delete(key);
  }
  const outputNodes = [...readNodes.values()].sort((a, b) => compareArgumentContextIds(a.id, b.id));
  const outputRelations = [...readRelations.values()].sort((a, b) => compareArgumentContextIds(a.id, b.id));
  const outputGroups = [...readGroups.values()].sort((a, b) => compareArgumentContextIds(a.id, b.id));
  const outputGaps = [...gaps.values()].sort((a, b) => compareArgumentContextIds(a.code, b.code) || compareArgumentContextIds(a.targetId ?? '', b.targetId ?? ''));
  const omitted = omittedNodes.size + omittedRelations.size + omittedGroups.size;
  const status = outputGaps.some((gap) => hardGapCodes.has(gap.code)) || omitted ? 'partial'
    : !allScopesReviewed || outputGaps.length ? 'unknown' : 'complete_for_scope';
  const sortIds = (values: Set<string>) => [...values].sort(compareArgumentContextIds);
  const payload: Omit<ArgumentContextPack, 'packHash'> = { version: 1, source: projection.source,
    scopeId: request.scope.scopeId, scopeHash: request.pointer.scopeHash, structureHash: authority.structureHash, task: request.task, budget,
    seedNodeIds: request.pointer.seedNodeIds, hierarchy: selectHierarchy(projection, outputNodes, outputRelations),
    nodes: outputNodes, relations: outputRelations, prerequisiteGroups: outputGroups, quality: projection.quality,
    completeness: { status, requiredNodeIds: sortIds(requiredNodes), requiredRelationIds: sortIds(requiredRelations),
      requiredGroupIds: sortIds(requiredGroups), readNodeIds: outputNodes.map((node) => node.id),
      readRelationIds: outputRelations.map((relation) => relation.id), readGroupIds: outputGroups.map((group) => group.id),
      omittedNodeIds: sortIds(omittedNodes), omittedRelationIds: sortIds(omittedRelations), omittedGroupIds: sortIds(omittedGroups), gaps: outputGaps },
    limitations: { semanticTruth: 'not_certified', questionCoverage: 'not_assessed', writes: 'disabled' } };
  return structuredClone({ ...payload, packHash: await argumentContextHash(payload) });
}
