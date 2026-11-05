import type { S2CanvasDefinition, S2Document } from '../../types/sceneS2';
import type { S2CanvasComposite, S2CompositeBlueprint } from '../../types/sceneS2Composite';
import { readS2CompositeBlueprint } from './sceneS2Composite';
import { s2BuiltinPluginRegistry, s2CapabilityKey } from './sceneS2PluginRegistry';
import { s2NodeTitle, s2PortLabel } from './sceneS2Presentation';
import { sceneInteractionPacks } from './sceneInteractionPacks';

const registry = s2BuiltinPluginRegistry();
const safeId = (value: unknown): value is string => typeof value === 'string' && value.length <= 64 && /^[A-Za-z][A-Za-z0-9_-]*$/.test(value) && !['constructor', 'prototype', '__proto__'].includes(value);
const endpointKey = (value: { nodeId: string; portId: string }) => JSON.stringify([value.nodeId, value.portId]);
function dataObject(raw: unknown, keys: string[]) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) throw new Error('组合配置必须是普通数据对象');
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !keys.includes(key) || !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value'))) throw new Error('组合配置含未知字段、访问器或权限声明');
  return raw as Record<string, unknown>;
}
function dense(raw: unknown, max: number): unknown[] {
  if (!Array.isArray(raw) || raw.length > max || Object.getPrototypeOf(raw) !== Array.prototype || Reflect.ownKeys(raw).length !== raw.length + 1) throw new Error('组合列表无效或超过上限');
  for (let i = 0; i < raw.length; i++) { const d = Object.getOwnPropertyDescriptor(raw, i); if (!d || !d.enumerable || !Object.hasOwn(d, 'value')) throw new Error('组合列表不能含空洞或访问器'); }
  return raw;
}
/** Derive a portable E1 snapshot. The canvas keeps its original nodes, bindings, receipts and permission boundaries. */
export function s2CanvasCompositeBlueprint(document: S2Document, composite: S2CanvasComposite, plugins: S2CanvasDefinition['plugins']): S2CompositeBlueprint {
  const selected = new Set(composite.nodeIds), graph = document.execution!;
  const nodes = structuredClone(graph.nodes.filter(node => selected.has(node.id)));
  if (nodes.some(node => node.when && !selected.has(node.when.nodeId))) throw new Error('组合中的条件来源在外部，请一并选择条件来源，或先拆开组合再修改。');
  const links = graph.links.filter(link => selected.has(link.source.nodeId) && selected.has(link.target.nodeId));
  const inputs: S2CompositeBlueprint['inputs'] = [], parameters: S2CompositeBlueprint['parameters'] = [], outputs: S2CompositeBlueprint['outputs'] = [];
  nodes.forEach((node, index) => {
    const capability = registry.capability(node);
    const hiddenLiteralInputs = sceneInteractionPacks.capabilityHelp(node)?.hideLiteralInputs ?? [];
    const label = (port: typeof capability.inputs[number], direction: 'inputs' | 'outputs') => `${s2NodeTitle(node)} · ${s2PortLabel(node, port, direction)}`.slice(0, 80);
    capability.inputs.forEach((port, portIndex) => {
      const target = { nodeId: node.id, portId: port.id }, incoming = graph.links.filter(link => endpointKey(link.target) === endpointKey(target));
      const external = incoming.some(link => !selected.has(link.source.nodeId)), internal = incoming.some(link => selected.has(link.source.nodeId));
      const binding = node.bindings[port.id], resource = ['local-material', 'project-notes'].includes(node.pluginId) && port.id === 'resource';
      if (external && internal) throw new Error('同一输入同时连接组合内外材料，请一并封装相关来源或将该步骤留在外部。');
      if (external || binding?.kind === 'field' || resource || !binding && !internal) {
        if (internal) throw new Error('该输入同时使用固定材料与内部连线，请先整理来源。');
        inputs.push({ id: `input${index}_${portIndex}`, label: label(port, 'inputs'), type: { ...port.type }, required: port.required, multiple: port.multiple, targets: [target] });
        delete node.bindings[port.id];
      } else if (binding?.kind === 'literal' && !port.multiple && !hiddenLiteralInputs.includes(port.id)) {
        parameters.push({ id: `parameter${index}_${portIndex}`, label: label(port, 'inputs'), type: { ...port.type }, target, defaultValue: structuredClone(binding.value) });
        delete node.bindings[port.id];
      }
    });
    capability.outputs.forEach((port, portIndex) => {
      const source = { nodeId: node.id, portId: port.id };
      const usedInside = links.some(link => endpointKey(link.source) === endpointKey(source)) || nodes.some(item => item.when?.nodeId === node.id && item.when.portId === port.id);
      const usedOutside = graph.links.some(link => endpointKey(link.source) === endpointKey(source) && !selected.has(link.target.nodeId))
        || graph.nodes.some(item => !selected.has(item.id) && item.when?.nodeId === node.id && item.when.portId === port.id);
      if (!usedInside || usedOutside) outputs.push({ id: `output${index}_${portIndex}`, label: label(port, 'outputs'), type: { ...port.type }, required: port.required, multiple: port.multiple, source });
    });
  });
  const used = new Set(nodes.map(s2CapabilityKey));
  return readS2CompositeBlueprint({ format: 's2-composite', protocolVersion: 1, id: composite.id, version: '1.0.0', label: composite.label,
    description: '当前组合的只读接口快照；不代表已发布蓝图、调用授权或执行成功。', plugins: (plugins ?? []).filter(plugin => used.has(s2CapabilityKey(plugin))),
    workflow: { version: 1, nodes, links }, inputs, outputs, parameters }, plugins ?? []);
}
export function readS2CanvasComposites(raw: unknown, document: S2Document, plugins: S2CanvasDefinition['plugins']): S2CanvasComposite[] {
  const ids = new Set([...document.nodes, ...(document.execution?.nodes ?? []), ...(document.groups ?? [])].map(node => node.id));
  const composites = dense(raw, 16).map(raw => {
    const value = dataObject(raw, ['id', 'label', 'nodeIds', 'parentId', 'blueprint']);
    if (!safeId(value.id) || ids.has(value.id) || typeof value.label !== 'string' || !value.label.trim() || value.label.length > 80) throw new Error('组合名称或标识无效');
    if (Object.hasOwn(value, 'parentId') && !safeId(value.parentId)) throw new Error('组合父级标识无效');
    ids.add(value.id); const members = dense(value.nodeIds, 40);
    if (!members.length || members.some(id => !safeId(id) || !document.execution?.nodes.some(node => node.id === id))) throw new Error('组合成员必须是存在的真实处理步骤，不能使用组合标识冒充。');
    if (new Set(members).size !== members.length || document.groups?.some(group => group.nodeIds.some(id => members.includes(id)))) throw new Error('组合不能与普通分组重叠，请先解散相关分组（保留节点）。');
    let blueprint: S2CanvasComposite['blueprint'];
    if (value.blueprint !== undefined) {
      const source = dataObject(value.blueprint, ['id', 'version', 'mapping']);
      if (!safeId(source.id) || typeof source.version !== 'string' || source.version.length > 32 || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(source.version)) throw new Error('蓝图来源格式无效；来源不是执行或一致性证明');
      blueprint = { id: source.id, version: source.version };
      if (Object.hasOwn(source, 'mapping')) {
        const mapping = dataObject(source.mapping, ['nodes', 'composites']);
        const pairs = (raw: unknown, max: number) => {
          const entries = dense(raw, max).map(raw => {
            const entry = dataObject(raw, ['localId', 'id']);
            if (!safeId(entry.localId) || !safeId(entry.id)) throw new Error('蓝图来源映射标识无效');
            return { localId: entry.localId, id: entry.id };
          });
          if (!entries.length || new Set(entries.map(entry => entry.localId)).size !== entries.length || new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error('蓝图来源映射不能为空或重复');
          return entries;
        };
        // Do not require mapped IDs to remain in the current graph: deleted/moved members are meaningful differences.
        blueprint.mapping = { nodes: pairs(mapping.nodes, 40), composites: pairs(mapping.composites, 16) };
      }
    }
    return { id: value.id, label: value.label, nodeIds: Array.from(members) as string[], ...(value.parentId ? { parentId: value.parentId as string } : {}), ...(blueprint ? { blueprint } : {}) };
  });
  const candidate = { ...document, composites };
  for (const composite of composites) {
    const path = s2CompositePath(candidate, composite.id);
    if (path.length > 4) throw new Error('组合最多嵌套4层，请简化层级。');
    const parent = path.at(-2);
    if (parent && composite.nodeIds.some(id => !parent.nodeIds.includes(id))) throw new Error('父组合必须包含子组合的全部真实步骤。');
    for (const other of composites) if (other !== composite && composite.nodeIds.some(id => other.nodeIds.includes(id))
      && !path.some(item => item.id === other.id) && !s2CompositePath(candidate, other.id).some(item => item.id === composite.id)) throw new Error('同级或无关组合不能共用处理步骤。');
    s2CanvasCompositeBlueprint(candidate, composite, plugins);
  }
  return composites;
}
/** Root to leaf, bounded and fail closed even before document validation. */
export function s2CompositePath(document: S2Document, id: string): S2CanvasComposite[] {
  const path: S2CanvasComposite[] = [], seen = new Set<string>(); let target: string | undefined = id;
  while (target !== undefined) {
    if (seen.has(target) || path.length >= 16) throw new Error('组合层级不能循环');
    seen.add(target); const composite = document.composites?.find(item => item.id === target);
    if (!composite) throw new Error('组合父级不存在');
    path.unshift(composite); target = composite.parentId;
  }
  return path;
}
/** Keep only complete wrappers; a child copied without its parent becomes a root wrapper. */
export function s2CompositeSubset(document: S2Document, selected: Set<string>): S2CanvasComposite[] {
  const complete = (document.composites ?? []).filter(composite => composite.nodeIds.every(id => selected.has(id))), ids = new Set(complete.map(item => item.id));
  return complete.map(({ parentId, ...composite }) => ({ ...structuredClone(composite), ...(parentId && ids.has(parentId) ? { parentId } : {}) }));
}
/** Pure candidates. Caller commits only after readS2Document validates the whole outer canvas. */
export function wrapS2CanvasComposite(document: S2Document, plugins: S2CanvasDefinition['plugins'], nodeIds: string[], label: string, parentId?: string): { document: S2Document; id: string } {
  const selected = new Set(nodeIds), parent = parentId ? document.composites?.find(item => item.id === parentId) : undefined;
  if (parentId && !parent || parent && nodeIds.some(id => !parent.nodeIds.includes(id))) throw new Error('只能封装当前层级的步骤。');
  const children = (document.composites ?? []).filter(item => item.parentId === parentId);
  if (children.some(item => item.nodeIds.some(id => selected.has(id)) && !item.nodeIds.every(id => selected.has(id)))) throw new Error('请完整选择当前层级的子组合，或进入其内部再封装。');
  const composite = { id: `composite-${crypto.randomUUID()}`, label, nodeIds: Array.from(nodeIds), ...(parentId ? { parentId } : {}) }, next = structuredClone(document);
  next.composites = readS2CanvasComposites([...(next.composites ?? []).map(item => children.some(child => child.id === item.id && child.nodeIds.every(id => selected.has(id))) ? { ...item, parentId: composite.id } : item), composite], next, plugins);
  return { document: next, id: composite.id };
}
/** Dissolve only this shell; its children move one level up, with all real data untouched. */
export function unwrapS2CanvasComposite(document: S2Document, id: string): S2Document {
  const next = structuredClone(document), composite = next.composites?.find(item => item.id === id);
  if (!composite) throw new Error('组合已不存在');
  next.composites = next.composites!.filter(item => item.id !== id).map(({ parentId, ...item }) => ({ ...item,
    ...(parentId === id ? composite.parentId ? { parentId: composite.parentId } : {} : parentId ? { parentId } : {}) }));
  return next;
}
/** Reparent design metadata only. Host still executes the same flat real graph. */
export function moveS2CanvasComposite(document: S2Document, id: string, parentId?: string): S2Document {
  const path = s2CompositePath(document, id), composite = path.at(-1)!, next = structuredClone(document);
  const targetPath = parentId ? s2CompositePath(document, parentId) : [];
  if (targetPath.some(item => item.id === id)) throw new Error('不能把组合移到自身或其内部');
  const targets = new Set(targetPath.map(item => item.id)), old = new Set(path.slice(0, -1).map(item => item.id));
  next.composites = next.composites!.map(({ parentId: priorParent, ...item }) => ({ ...item,
    nodeIds: old.has(item.id) && !targets.has(item.id) ? item.nodeIds.filter(nodeId => !composite.nodeIds.includes(nodeId))
      : targets.has(item.id) ? [...new Set([...item.nodeIds, ...composite.nodeIds])] : item.nodeIds,
    ...(item.id === id ? parentId ? { parentId } : {} : priorParent ? { parentId: priorParent } : {}) }));
  pruneS2CanvasComposites(next); return next;
}
/** Attach newly created real steps to a displayed container and every ancestor, atomically with creation. */
export function placeS2NewStepsInComposite(before: S2Document, after: S2Document, parentId: string): S2Document {
  const next = structuredClone(after), existing = new Set(before.execution?.nodes.map(node => node.id));
  const added = next.execution?.nodes.filter(node => !existing.has(node.id)).map(node => node.id) ?? [];
  const containers = new Set(s2CompositePath(next, parentId).map(item => item.id));
  next.composites = next.composites!.map(item => containers.has(item.id) ? { ...item, nodeIds: [...item.nodeIds, ...added] } : item);
  return next;
}
export function pruneS2CanvasComposites(document: S2Document) {
  if (document.composites) {
    const ids = new Set(document.execution?.nodes.map(node => node.id));
    document.composites = document.composites.map(composite => ({ ...composite, nodeIds: composite.nodeIds.filter(id => ids.has(id)) })).filter(composite => composite.nodeIds.length);
  }
}
export function s2CompositePosition(document: S2Document, composite: S2CanvasComposite) {
  const nodes = document.execution!.nodes.filter(node => composite.nodeIds.includes(node.id));
  return { x: Math.min(...nodes.map(node => node.position.x)), y: Math.min(...nodes.map(node => node.position.y)) };
}
