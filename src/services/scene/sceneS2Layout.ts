import type { S2BatchAction, S2Document, S2Group } from '../../types/sceneS2';
import { pruneS2CanvasComposites, s2CompositePath } from './sceneS2CompositeCanvas';

const safeId = (raw: unknown): raw is string => typeof raw === 'string' && raw.length <= 64 && /^[A-Za-z][A-Za-z0-9_-]*$/.test(raw) && !['constructor', '__proto__', 'prototype'].includes(raw);
export function s2AllNodes(document: S2Document) { return [...document.nodes, ...(document.execution?.nodes ?? [])]; }
export function readS2Groups(raw: unknown, document: S2Document): S2Group[] {
  if (!Array.isArray(raw) || raw.length > 16) throw new Error('S2 最多16个分组');
  const groupIds = new Set<string>(), assigned = new Set<string>(), nodes = new Set(s2AllNodes(document).map(node => node.id));
  return raw.map(value => {
    if (!value || typeof value !== 'object' || Object.keys(value).some(key => !['id', 'label', 'nodeIds', 'collapsed'].includes(key))
      || !safeId(value.id) || nodes.has(value.id) || groupIds.has(value.id) || typeof value.label !== 'string' || !value.label.trim() || value.label.length > 80
      || typeof value.collapsed !== 'boolean' || !Array.isArray(value.nodeIds) || !value.nodeIds.length || value.nodeIds.length > 80) throw new Error('S2 分组格式、标识或大小无效');
    groupIds.add(value.id);
    for (const id of value.nodeIds) { if (!safeId(id) || !nodes.has(id) || assigned.has(id)) throw new Error('分组成员不存在、重复或已属于其他组；本版不支持嵌套组'); assigned.add(id); }
    return { id: value.id, label: value.label, nodeIds: [...value.nodeIds], collapsed: value.collapsed };
  });
}
export function pruneS2Groups(document: S2Document) {
  if (document.groups) { const ids = new Set(s2AllNodes(document).map(node => node.id)); document.groups = document.groups.map(group => ({ ...group, nodeIds: group.nodeIds.filter(id => ids.has(id)) })).filter(group => group.nodeIds.length); }
}
/** Pure, uncommitted batch. Caller validates the ENTIRE resulting document before a single commit. */
export function mutateS2Batch(document: S2Document, raw: unknown): S2Document {
  const action = raw as S2BatchAction;
  if (!action || typeof action !== 'object' || Object.keys(action).some(key => !['kind', 'nodeIds', 'delta', 'compositeId'].includes(key))
    || !['copy', 'delete', 'move'].includes(action.kind) || !Array.isArray(action.nodeIds) || !action.nodeIds.length || action.nodeIds.length > 80
    || new Set(action.nodeIds).size !== action.nodeIds.length) throw new Error('批量操作格式无效');
  const next = structuredClone(document), all = s2AllNodes(next), selected = new Set(action.nodeIds);
  if (action.nodeIds.some(id => !safeId(id) || !all.some(node => node.id === id))) throw new Error('批量操作包含不存在的节点');
  const scope = action.compositeId === undefined ? [] : safeId(action.compositeId) ? s2CompositePath(document, action.compositeId) : (() => { throw new Error('批量组合范围无效'); })();
  if (scope.length && action.nodeIds.some(id => !scope.at(-1)!.nodeIds.includes(id) && !document.nodes.some(node => node.id === id))) throw new Error('批量选区超出当前组合');
  if (action.delta !== undefined && (action.kind === 'delete' || !action.delta || typeof action.delta !== 'object' || Object.keys(action.delta).some(key => !['x', 'y'].includes(key))
    || ![action.delta.x, action.delta.y].every(value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 100000))) throw new Error('批量位移参数无效');
  if (action.kind === 'move') {
    if (!action.delta) throw new Error('批量移动需要位移量');
    all.filter(node => selected.has(node.id)).forEach(node => { node.position = { x: node.position.x + action.delta!.x, y: node.position.y + action.delta!.y }; });
  } else if (action.kind === 'delete') {
    next.nodes = next.nodes.filter(node => !selected.has(node.id)); next.edges = next.edges.filter(edge => !selected.has(edge.source) && !selected.has(edge.target));
    if (next.execution) {
      next.execution.nodes = next.execution.nodes.filter(node => !selected.has(node.id)); next.execution.links = next.execution.links.filter(link => !selected.has(link.source.nodeId) && !selected.has(link.target.nodeId));
      next.execution.nodes.forEach(node => { node.bindings = Object.fromEntries(Object.entries(node.bindings).filter(([, binding]) => binding.kind !== 'field' || !selected.has(binding.nodeId))); });
    }
    pruneS2Groups(next);
    pruneS2CanvasComposites(next);
  } else {
    const mapping = new Map(action.nodeIds.map(id => [id, `node-${crypto.randomUUID()}`]));
    const position = (value: { x: number; y: number }) => ({ x: value.x + (action.delta?.x ?? 60), y: value.y + (action.delta?.y ?? 60) });
    next.nodes.push(...document.nodes.filter(node => selected.has(node.id)).map(node => ({ ...structuredClone(node), id: mapping.get(node.id)!, position: position(node.position) })));
    next.edges.push(...document.edges.filter(edge => selected.has(edge.source) && selected.has(edge.target)).map(edge => ({ ...edge, id: `edge-${crypto.randomUUID()}`, source: mapping.get(edge.source)!, target: mapping.get(edge.target)! })));
    if (next.execution) {
      next.execution.nodes.push(...(document.execution?.nodes ?? []).filter(node => selected.has(node.id)).map(node => ({ ...structuredClone(node), id: mapping.get(node.id)!, position: position(node.position),
        ...(node.when ? { when: { ...structuredClone(node.when), nodeId: mapping.get(node.when.nodeId) ?? node.when.nodeId } } : {}),
        bindings: Object.fromEntries(Object.entries(node.bindings).map(([key, binding]) => [key, binding.kind === 'field' && mapping.has(binding.nodeId) ? { ...binding, nodeId: mapping.get(binding.nodeId)! } : structuredClone(binding)])) })));
      next.execution.links.push(...(document.execution?.links ?? []).filter(link => selected.has(link.source.nodeId) && selected.has(link.target.nodeId)).map(link => ({ source: { ...link.source, nodeId: mapping.get(link.source.nodeId)! }, target: { ...link.target, nodeId: mapping.get(link.target.nodeId)! } })));
    }
    const copiedGroups = document.groups?.filter(group => group.nodeIds.every(id => selected.has(id))).map(group => ({ ...group, id: `group-${crypto.randomUUID()}`, label: `${group.label.slice(0, 76)} 副本`, nodeIds: group.nodeIds.map(id => mapping.get(id)!) }));
    if (copiedGroups?.length) next.groups = [...(next.groups ?? []), ...copiedGroups];
    const complete = document.composites?.filter(composite => !scope.some(item => item.id === composite.id) && composite.nodeIds.every(id => selected.has(id))) ?? [];
    const shells = new Map(complete.map(composite => [composite.id, `composite-${crypto.randomUUID()}`]));
    // Never leave copied provenance pointing at the original's live nodes/shells, even for deleted/moved members.
    const sourceNodes = new Map(mapping), sourceShells = new Map(shells);
    for (const composite of complete) {
      for (const entry of composite.blueprint?.mapping?.nodes ?? []) if (!sourceNodes.has(entry.id)) sourceNodes.set(entry.id, `node-${crypto.randomUUID()}`);
      for (const entry of composite.blueprint?.mapping?.composites ?? []) if (!sourceShells.has(entry.id)) sourceShells.set(entry.id, `composite-${crypto.randomUUID()}`);
    }
    // A full subtree becomes an independent sibling; partial copies stay inside their original owners.
    if (next.composites) next.composites = next.composites.map(composite => shells.has(composite.id) ? composite : { ...composite,
      nodeIds: [...composite.nodeIds, ...composite.nodeIds.filter(id => selected.has(id)).map(id => mapping.get(id)!)] });
    const copiedComposites = complete.map(composite => ({ id: shells.get(composite.id)!, label: `${composite.label.slice(0, 76)} 副本`, nodeIds: composite.nodeIds.map(id => mapping.get(id)!),
      ...(composite.parentId ? { parentId: shells.get(composite.parentId) ?? composite.parentId } : {}), ...(composite.blueprint ? { blueprint: { ...composite.blueprint,
        ...(composite.blueprint.mapping ? { mapping: {
          nodes: composite.blueprint.mapping.nodes.map(entry => ({ localId: entry.localId, id: sourceNodes.get(entry.id)! })),
          composites: composite.blueprint.mapping.composites.map(entry => ({ localId: entry.localId, id: sourceShells.get(entry.id)! })),
        } } : {}) } } : {}) }));
    if (copiedComposites?.length) next.composites = [...(next.composites ?? []), ...copiedComposites];
  }
  return next;
}
export function s2GroupBounds(group: S2Group, document: S2Document) {
  const nodes = s2AllNodes(document).filter(node => group.nodeIds.includes(node.id));
  const x = Math.min(...nodes.map(node => node.position.x)) - 25, y = Math.min(...nodes.map(node => node.position.y)) - 55;
  return { x, y, width: group.collapsed ? 320 : Math.max(...nodes.map(node => node.position.x + 330)) - x + 25, height: group.collapsed ? 100 : Math.max(...nodes.map(node => node.position.y + 340)) - y + 25 };
}
