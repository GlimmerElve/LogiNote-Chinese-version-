import { argumentContextHash, compareArgumentContextIds } from './hash';
import { normalizeArgumentContextBudget, validateArgumentContextProjection } from './validator';
import type {
  ArgumentContextAuthority, ArgumentContextGap, ArgumentContextGapCode, ArgumentContextHierarchy,
  ArgumentContextNode, ArgumentContextProjection, ArgumentContextRelation, ArgumentContextScope, ArgumentPrerequisiteGroup,
} from './types';
import { ARGUMENT_TASK_SCOPED_READ_POLICY, ARGUMENT_TASK_SCOPED_TASKS,
  type ArgumentTaskScopedPack, type ArgumentTaskScopedRequest } from './taskScopedTypes';

const fail = (code: string): never => { throw new Error(`argument_task_context_${code}`); };
const globalGapCodes = new Set<ArgumentContextGapCode>(['legacy_structure', 'hierarchy_incomplete',
  'source_review_only', 'source_quality_unknown', 'incomplete_extraction']);
const hardGapCodes = new Set<ArgumentContextGapCode>(['missing_prerequisite', 'missing_node', 'missing_relation', 'missing_group',
  'unadmitted_node', 'unadmitted_relation', 'unadmitted_group', 'node_budget', 'relation_budget', 'character_budget', 'depth_budget']);
const ids = (values: Set<string>) => [...values].sort(compareArgumentContextIds);

function selectedHierarchy(projection: ArgumentContextProjection, nodes: ArgumentContextNode[],
  relations: ArgumentContextRelation[]): ArgumentContextHierarchy {
  const sentenceIds = new Set([...nodes, ...relations].flatMap((item) => item.evidence.map((span) => span.sentenceId)));
  const sentences = projection.hierarchy.sentences.filter((sentence) => sentenceIds.has(sentence.id));
  const blockIds = new Set(sentences.map((sentence) => sentence.blockId));
  const sectionById = new Map(projection.hierarchy.sections.map((section) => [section.id, section]));
  const sectionIds = new Set<string>();
  for (const block of projection.hierarchy.blocks) {
    if (!blockIds.has(block.id)) continue;
    let sectionId = block.sectionId;
    while (sectionId !== null && !sectionIds.has(sectionId)) {
      sectionIds.add(sectionId); sectionId = sectionById.get(sectionId)!.parentId;
    }
  }
  return { sections: projection.hierarchy.sections.filter((section) => sectionIds.has(section.id)),
    blocks: projection.hierarchy.blocks.filter((block) => blockIds.has(block.id)).map((block) => ({ ...block,
      previousId: block.previousId !== null && blockIds.has(block.previousId) ? block.previousId : null,
      nextId: block.nextId !== null && blockIds.has(block.nextId) ? block.nextId : null })), sentences };
}
/** Counts all returned quotations, including repeated evidence and original sentence containers. */
function characterCost(projection: ArgumentContextProjection, nodes: ArgumentContextNode[], relations: ArgumentContextRelation[]): number {
  const hierarchy = selectedHierarchy(projection, nodes, relations);
  return [...nodes, ...relations].reduce((total, item) => total + item.evidence.reduce((sum, span) => sum + span.quote.length, 0), 0)
    + hierarchy.sentences.reduce((sum, sentence) => sum + sentence.quote.length, 0)
    + hierarchy.sections.reduce((sum, section) => sum + section.path.length, 0);
}

/** Pure source-bound reading. A complete reviewed task scope is a stored semantic decision, not an automatic proof. */
export async function readTaskScopedArgumentContextPack(projectionInput: ArgumentContextProjection,
  authorityInput: ArgumentContextAuthority, requestInput: ArgumentTaskScopedRequest): Promise<ArgumentTaskScopedPack> {
  const projection = structuredClone(projectionInput), authority = structuredClone(authorityInput), request = structuredClone(requestInput);
  if (!(ARGUMENT_TASK_SCOPED_TASKS as readonly string[]).includes(request.task)) fail('unsupported_task');
  const budget = normalizeArgumentContextBudget(request.budget);
  await validateArgumentContextProjection(projection, authority, request);
  const nodes = new Map(projection.nodes.map((node) => [node.id, node]));
  const relations = new Map(projection.relations.map((relation) => [relation.id, relation]));
  const groups = new Map(projection.prerequisiteGroups.map((group) => [group.id, group]));
  const requiredNodes = new Set(request.pointer.seedNodeIds), requiredRelations = new Set<string>(), requiredGroups = new Set<string>();
  const gaps = new Map<string, ArgumentContextGap>();
  const addGap = (code: ArgumentContextGapCode, targetId?: string) => {
    gaps.set(`${code}\u0000${targetId ?? ''}`, targetId === undefined ? { code } : { code, targetId });
  };
  let allScopesReviewed = true;
  for (const seed of request.pointer.seedNodeIds) {
    const selected = projection.build.scopes.find((scope) => scope.seedNodeId === seed && scope.task === request.task);
    if (!selected || selected.status !== 'reviewed_for_scope') { allScopesReviewed = false; addGap('scope_not_reviewed', seed); }
    if (selected) {
      selected.requiredNodeIds.forEach((id) => requiredNodes.add(id));
      selected.requiredRelationIds.forEach((id) => requiredRelations.add(id));
      selected.requiredGroupIds.forEach((id) => requiredGroups.add(id));
    }
  }
  // No recursive incident traversal. A group must be explicitly named in this task's
  // reviewed set; its operator, all members and original relations remain indivisible obligations.
  for (const id of requiredGroups) {
    const group = groups.get(id);
    if (!group) continue;
    [group.conclusionNodeId, ...group.premiseNodeIds, ...group.conditionNodeIds].forEach((member) => requiredNodes.add(member));
    group.relationIds.forEach((relation) => requiredRelations.add(relation));
  }
  for (const id of requiredRelations) {
    const relation = relations.get(id);
    if (relation) { requiredNodes.add(relation.sourceNodeId); requiredNodes.add(relation.targetNodeId); }
  }
  const selectedIds = new Set([...requiredNodes, ...requiredRelations, ...requiredGroups]);
  // A target is local only if the full authority can locate it in a stored graph or
  // named obligation. Unlocated targets and source-wide extraction gaps remain conservative.
  const locatedIds = new Set([...nodes.keys(), ...relations.keys(), ...groups.keys(),
    ...projection.prerequisiteGroups.flatMap((group) => [group.conclusionNodeId, ...group.premiseNodeIds,
      ...group.conditionNodeIds, ...group.relationIds]),
    ...projection.build.scopes.flatMap((scope) => [scope.seedNodeId, ...scope.requiredNodeIds,
      ...scope.requiredRelationIds, ...scope.requiredGroupIds])]);
  for (const gap of projection.build.gaps) {
    // This legacy gap has no task discriminator. The exact current stored seed/task
    // status above is authoritative; a different task's partial review cannot poison this one.
    if (gap.code === 'scope_not_reviewed' && gap.targetId !== undefined && locatedIds.has(gap.targetId)) continue;
    if (globalGapCodes.has(gap.code) || gap.targetId === undefined || selectedIds.has(gap.targetId)
      || !locatedIds.has(gap.targetId)) addGap(gap.code, gap.targetId);
  }
  if (projection.build.origin === 'legacy-adapter') addGap('legacy_structure');
  if (projection.quality.status === 'review_only') addGap('source_review_only');
  else if (request.scope.corpus === 'reference' && projection.quality.status !== 'eligible'
    || request.scope.corpus === 'personal' && projection.quality.status !== 'eligible' && projection.quality.status !== 'not_applicable') addGap('source_quality_unknown');

  // Distances use only declared edges as a reading budget, not as reverse logical inference.
  const adjacency = new Map<string, string[]>();
  for (const id of requiredRelations) {
    const relation = relations.get(id);
    if (!relation || relation.admission !== 'admitted' || nodes.get(relation.sourceNodeId)?.admission !== 'admitted'
      || nodes.get(relation.targetNodeId)?.admission !== 'admitted') continue;
    for (const [from, to] of [[relation.sourceNodeId, relation.targetNodeId], [relation.targetNodeId, relation.sourceNodeId]]) {
      const neighboring = adjacency.get(from) ?? []; neighboring.push(to); adjacency.set(from, neighboring);
    }
  }
  const distances = new Map(request.pointer.seedNodeIds.map((id) => [id, 0]));
  const queue = [...request.pointer.seedNodeIds];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    for (const neighbor of adjacency.get(current) ?? []) if (!distances.has(neighbor)) {
      distances.set(neighbor, distances.get(current)! + 1); queue.push(neighbor);
    }
  }
  // Explicit disconnected scope evidence is a direct read at depth one, not a fabricated support path.
  const depth = (id: string) => distances.get(id) ?? 1;
  const readNodes = new Map<string, ArgumentContextNode>(), readRelations = new Map<string, ArgumentContextRelation>();
  const readGroups = new Map<string, ArgumentPrerequisiteGroup>();
  const seeds = new Set(request.pointer.seedNodeIds);
  const nodeOrder = ids(requiredNodes).sort((a, b) => Number(!seeds.has(a)) - Number(!seeds.has(b))
    || depth(a) - depth(b) || compareArgumentContextIds(a, b));
  for (const id of nodeOrder) {
    const node = nodes.get(id);
    if (!node) { addGap('missing_node', id); continue; }
    if (node.admission !== 'admitted') { addGap('unadmitted_node', id); continue; }
    if (depth(id) > budget.maxDepth) { addGap('depth_budget', id); continue; }
    if (readNodes.size + 1 > budget.maxNodes) { addGap('node_budget', id); continue; }
    if (characterCost(projection, [...readNodes.values(), node], [...readRelations.values()]) > budget.maxCharacters) {
      addGap('character_budget', id); continue;
    }
    readNodes.set(id, node);
    if (node.semanticStatus !== 'reviewed') addGap('structure_unreviewed', id);
  }
  for (const id of ids(requiredRelations)) {
    const relation = relations.get(id);
    if (!relation) { addGap('missing_relation', id); continue; }
    if (relation.admission !== 'admitted') { addGap('unadmitted_relation', id); continue; }
    if (!readNodes.has(relation.sourceNodeId) || !readNodes.has(relation.targetNodeId)) continue;
    if (readRelations.size + 1 > budget.maxRelations) { addGap('relation_budget', id); continue; }
    if (characterCost(projection, [...readNodes.values()], [...readRelations.values(), relation]) > budget.maxCharacters) {
      addGap('character_budget', id); continue;
    }
    readRelations.set(id, relation);
    if (relation.semanticStatus !== 'reviewed') addGap('structure_unreviewed', id);
  }
  for (const id of ids(requiredGroups)) {
    const group = groups.get(id);
    if (!group) { addGap('missing_group', id); continue; }
    if (group.admission !== 'admitted') { addGap('unadmitted_group', id); continue; }
    if (group.operator === 'unknown' || group.operator === 'any' && group.premiseNodeIds.length > 0 && group.conditionNodeIds.length > 0) {
      // A flat operator cannot express (P1 OR P2) AND C; do not invent a nested interpretation.
      addGap('unknown_prerequisite_operator', id); continue;
    }
    const members = [...group.premiseNodeIds, ...group.conditionNodeIds];
    const complete = [group.conclusionNodeId, ...members].every((member) => readNodes.has(member))
      && group.relationIds.every((relation) => readRelations.has(relation))
      && members.every((member) => group.relationIds.some((relationId) => {
        const relation = relations.get(relationId);
        return relation?.sourceNodeId === member && relation.targetNodeId === group.conclusionNodeId
          && relation.kind === (group.conditionNodeIds.includes(member) ? 'requires_condition' : 'support');
      }));
    if (!complete) { addGap('missing_prerequisite', id); continue; }
    readGroups.set(id, group);
    if (group.semanticStatus !== 'reviewed') addGap('structure_unreviewed', id);
  }
  const outputNodes = [...readNodes.values()].sort((a, b) => compareArgumentContextIds(a.id, b.id));
  const outputRelations = [...readRelations.values()].sort((a, b) => compareArgumentContextIds(a.id, b.id));
  const outputGroups = [...readGroups.values()].sort((a, b) => compareArgumentContextIds(a.id, b.id));
  const omittedNodes = ids(requiredNodes).filter((id) => !readNodes.has(id));
  const omittedRelations = ids(requiredRelations).filter((id) => !readRelations.has(id));
  const omittedGroups = ids(requiredGroups).filter((id) => !readGroups.has(id));
  const outputGaps = [...gaps.values()].sort((a, b) => compareArgumentContextIds(a.code, b.code) || compareArgumentContextIds(a.targetId ?? '', b.targetId ?? ''));
  const status = omittedNodes.length + omittedRelations.length + omittedGroups.length || outputGaps.some((gap) => hardGapCodes.has(gap.code))
    ? 'partial' : !allScopesReviewed || outputGaps.length ? 'unknown' : 'complete_for_scope';
  const payload: Omit<ArgumentTaskScopedPack, 'packHash'> = { version: 2, readPolicy: ARGUMENT_TASK_SCOPED_READ_POLICY,
    source: projection.source, scopeId: request.scope.scopeId, scopeHash: request.pointer.scopeHash,
    structureHash: authority.structureHash, task: request.task, budget, seedNodeIds: request.pointer.seedNodeIds,
    hierarchy: selectedHierarchy(projection, outputNodes, outputRelations), nodes: outputNodes, relations: outputRelations,
    prerequisiteGroups: outputGroups, quality: projection.quality,
    completeness: { status, requiredNodeIds: ids(requiredNodes), requiredRelationIds: ids(requiredRelations), requiredGroupIds: ids(requiredGroups),
      readNodeIds: outputNodes.map((node) => node.id), readRelationIds: outputRelations.map((relation) => relation.id),
      readGroupIds: outputGroups.map((group) => group.id), omittedNodeIds: omittedNodes, omittedRelationIds: omittedRelations,
      omittedGroupIds: omittedGroups, gaps: outputGaps },
    limitations: { semanticTruth: 'not_certified', questionCoverage: 'not_assessed', writes: 'disabled' } };
  return structuredClone({ ...payload, packHash: await argumentContextHash(payload) });
}

function exactReplayShape(actual: unknown, expected: unknown): boolean {
  if (!expected || typeof expected !== 'object') return Object.is(actual, expected);
  if (!actual || typeof actual !== 'object' || Array.isArray(actual) !== Array.isArray(expected)) return false;
  if (Array.isArray(expected) && (!Array.isArray(actual) || actual.length !== expected.length)) return false;
  const left = actual as Record<string, unknown>, right = expected as Record<string, unknown>;
  const leftKeys = Object.keys(left).sort(compareArgumentContextIds), rightKeys = Object.keys(right).sort(compareArgumentContextIds);
  return leftKeys.length === rightKeys.length && rightKeys.every((key, index) => leftKeys[index] === key && exactReplayShape(left[key], right[key]));
}

/** Independent full-projection replay, including closed shape. A recomputed pack hash grants no authority. */
export async function validateTaskScopedArgumentContextPack(packInput: ArgumentTaskScopedPack,
  authorityInput: ArgumentContextAuthority, scopeInput: ArgumentContextScope, projectionInput: ArgumentContextProjection): Promise<void> {
  const pack = structuredClone(packInput), authority = structuredClone(authorityInput), scope = structuredClone(scopeInput), projection = structuredClone(projectionInput);
  if (!pack || pack.version !== 2 || pack.readPolicy !== ARGUMENT_TASK_SCOPED_READ_POLICY) fail('invalid_read_policy');
  const expected = await readTaskScopedArgumentContextPack(projection, authority, { pointer: {
    version: 1, scopeId: pack.scopeId, scopeHash: pack.scopeHash, source: pack.source,
    structureHash: pack.structureHash, seedNodeIds: pack.seedNodeIds }, scope, task: pack.task, budget: pack.budget });
  if (!exactReplayShape(pack, expected) || await argumentContextHash(pack) !== await argumentContextHash(expected)) fail('pack_projection_mismatch');
}
