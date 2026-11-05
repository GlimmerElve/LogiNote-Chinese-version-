import { readArgumentProjectionDraft, validateArgumentProjectionBuildInput } from './construction';
import { ARGUMENT_PROJECTION_BUILD_LIMITS as LIMITS, type ArgumentProjectionBuildInput,
  type ArgumentProjectionDraft } from './buildTypes';
import { compareArgumentContextIds } from './hash';

export const ARGUMENT_PROJECTION_SELECTION_PROTOCOL = 'argument-projection-selection-v2' as const;
/** Explicit new wire. Array positions name N/E/G slots; the host creates IDs.
 * Selected items express semantic intent; required endpoint closure is mechanical. */
export interface ArgumentProjectionSelection {
  version: 2; protocol: typeof ARGUMENT_PROJECTION_SELECTION_PROTOCOL; buildId: string;
  nodes: Omit<ArgumentProjectionDraft['nodes'][number], 'id'>[];
  relations: Omit<ArgumentProjectionDraft['relations'][number], 'id'>[];
  groups: Omit<ArgumentProjectionDraft['groups'][number], 'id'>[];
  scopes: { seedNodeId: string; task: ArgumentProjectionDraft['scopes'][number]['task'];
    selectedNodeIds: string[]; selectedRelationIds: string[]; selectedGroupIds: string[]; quoteIds: string[] }[];
}
const fail = (): never => { throw new Error('argument_projection_invalid_selection'); };
function data(value: unknown, depth = 0): void {
  if (depth > 64) fail();
  if (value === null || typeof value === 'boolean' || typeof value === 'string'
    || typeof value === 'number' && Number.isFinite(value)) return;
  if (!value || typeof value !== 'object') fail();
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 2048 || Reflect.ownKeys(value).length !== value.length + 1
      || Object.keys(value).some((key, index) => key !== String(index))) fail();
  } else if (![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value as object).some(key => typeof key !== 'string')) fail();
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!Object.hasOwn(descriptor, 'value') || (!Array.isArray(value) || key !== 'length') && !descriptor.enumerable) fail();
    if (key !== 'length' || !Array.isArray(value)) data(descriptor.value, depth + 1);
  }
}
function closed(value: unknown, fields: readonly string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const keys = Object.keys(value).sort(), expected = [...fields].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) fail();
}
function rows(value: unknown, maximum: number, fields: readonly string[]): void {
  if (!Array.isArray(value) || value.length > maximum) fail();
  (value as unknown[]).forEach(row => closed(row, fields));
}
function selected(value: unknown, available: ReadonlyMap<string, unknown>): asserts value is string[] {
  if (!Array.isArray(value) || new Set(value).size !== value.length
    || value.some(id => typeof id !== 'string' || !available.has(id))) fail();
}
/** JSON syntax is checked first; reject duplicate (also escaped-alias) field names
 * rather than silently keeping the last model value. */
function uniqueJsonKeys(raw: string): void {
  const stack: (Set<string> | null)[] = [];
  for (let index = 0; index < raw.length; index++) {
    const character = raw[index];
    if (character === '{') stack.push(new Set());
    else if (character === '[') stack.push(null);
    else if (character === '}' || character === ']') stack.pop();
    else if (character === '"') {
      const start = index++;
      while (index < raw.length) {
        if (raw[index] === '\\') index += 2;
        else if (raw[index] === '"') break;
        else index++;
      }
      let next = index + 1; while (next < raw.length && /\s/u.test(raw[next])) next++;
      if (raw[next] === ':') {
        const keys = stack.at(-1), key = JSON.parse(raw.slice(start, index + 1)) as string;
        if (!keys || keys.has(key)) return fail(); keys.add(key);
      }
    }
  }
}
/** No repair of legacy responses: only an explicit v2 response enters this adapter.
 * Never discovers new semantic edges/groups/conditions or pre-fills review votes. */
export async function readArgumentProjectionSelection(raw: unknown, original: ArgumentProjectionBuildInput): Promise<ArgumentProjectionDraft> {
  data(original); const input = structuredClone(original);
  if (typeof raw === 'string') {
    if (raw.length > LIMITS.requestCharacters) throw new Error('argument_projection_response_budget');
    const serialized = raw;
    try { raw = JSON.parse(serialized); } catch { fail(); }
    uniqueJsonKeys(serialized);
  }
  data(raw); const wire = structuredClone(raw) as ArgumentProjectionSelection;
  closed(wire, ['version', 'protocol', 'buildId', 'nodes', 'relations', 'groups', 'scopes']);
  if (wire.version !== 2 || wire.protocol !== ARGUMENT_PROJECTION_SELECTION_PROTOCOL || wire.buildId !== input.buildId) fail();
  if (JSON.stringify(wire).length > LIMITS.requestCharacters) throw new Error('argument_projection_response_budget');
  rows(wire.nodes, LIMITS.nodes, ['role', 'quoteIds']);
  rows(wire.relations, LIMITS.relations, ['sourceNodeId', 'targetNodeId', 'kind', 'quoteIds']);
  rows(wire.groups, LIMITS.groups, ['conclusionNodeId', 'premiseNodeIds', 'conditionNodeIds', 'relationIds', 'operator', 'quoteIds']);
  rows(wire.scopes, LIMITS.scopes, ['seedNodeId', 'task', 'selectedNodeIds', 'selectedRelationIds', 'selectedGroupIds', 'quoteIds']);
  const nodes = wire.nodes.map((row, i) => ({ id: `N${i + 1}`, ...row }));
  const relations = wire.relations.map((row, i) => ({ id: `E${i + 1}`, ...row }));
  const groups = wire.groups.map((row, i) => ({ id: `G${i + 1}`, ...row }));
  const nodeMap = new Map(nodes.map(row => [row.id, row])), edgeMap = new Map(relations.map(row => [row.id, row]));
  const groupMap = new Map(groups.map(row => [row.id, row]));
  // Check references before closure; do not turn orphan references into empty sets.
  for (const edge of relations) if (!nodeMap.has(edge.sourceNodeId) || !nodeMap.has(edge.targetNodeId)) fail();
  for (const group of groups) {
    if (!nodeMap.has(group.conclusionNodeId)) fail();
    selected(group.premiseNodeIds, nodeMap); selected(group.conditionNodeIds, nodeMap); selected(group.relationIds, edgeMap);
  }
  const scopes = wire.scopes.map((scope, i) => {
    if (!nodeMap.has(scope.seedNodeId)) fail();
    selected(scope.selectedNodeIds, nodeMap); selected(scope.selectedRelationIds, edgeMap); selected(scope.selectedGroupIds, groupMap);
    const requiredNodes = new Set([scope.seedNodeId, ...scope.selectedNodeIds]);
    const requiredEdges = new Set(scope.selectedRelationIds);
    for (const id of scope.selectedGroupIds) {
      const group = groupMap.get(id)!;
      [group.conclusionNodeId, ...group.premiseNodeIds, ...group.conditionNodeIds].forEach(id => requiredNodes.add(id));
      group.relationIds.forEach(id => requiredEdges.add(id));
    }
    for (const id of requiredEdges) {
      const edge = edgeMap.get(id)!;
      requiredNodes.add(edge.sourceNodeId); requiredNodes.add(edge.targetNodeId);
    }
    return { id: `S${i + 1}`, seedNodeId: scope.seedNodeId, task: scope.task, quoteIds: scope.quoteIds,
      requiredNodeIds: [...requiredNodes].sort(compareArgumentContextIds),
      requiredRelationIds: [...requiredEdges].sort(compareArgumentContextIds),
      requiredGroupIds: [...scope.selectedGroupIds].sort(compareArgumentContextIds) };
  });
  await validateArgumentProjectionBuildInput(input);
  // Canonical v1 remains the unchanged closed proof/review/store contract.
  return readArgumentProjectionDraft({ version: 1, buildId: input.buildId, nodes, relations, groups, scopes }, input);
}
