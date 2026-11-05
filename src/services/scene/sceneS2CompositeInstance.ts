import type { S2CanvasDefinition, S2InputBinding } from '../../types/sceneS2';
import { readS2Document } from './sceneS2Canvas';
import { readS2CompositeDesign } from './sceneS2CompositeLibrary';
import { s2CompositePath } from './sceneS2CompositeCanvas';
import { canonicalS2Json } from './sceneS2PluginProtocol';
import { s2CapabilityKey } from './sceneS2PluginRegistry';
import { s2NodeTitle } from './sceneS2Presentation';
import { snapshotS2CompositeData } from './sceneS2Composite';

const equal = (a: unknown, b: unknown) => canonicalS2Json(a as any) === canonicalS2Json(b as any);
const sorted = (values: unknown[]) => values.map(value => canonicalS2Json(value as any)).sort();
const endpointKey = (value: { nodeId: string; portId: string }) => JSON.stringify([value.nodeId, value.portId]);
const note = '只对照当前库中的来源版本，不证明历史来源真实性、业务等价或运行成功，也不证明可安全升级。材料和参数可能在添加时已选定，不推断为事后修改；不显示原文或值，不迁移资料权限、模型预算与确认。';

/** Read-only structural comparison. No inferred correspondence, source values, commands, grants or IO.
 * Mapping is untrusted design metadata; it is checked against both the source and the actual graph.
 * It is never used as an execution/upgrade certificate. Old instances remain editable without a map. */
export function inspectS2CompositeInstance(documentRaw: unknown, definition: S2CanvasDefinition, compositeId: string) {
  const document = readS2Document(snapshotS2CompositeData(documentRaw, { maxBytes: 786432, maxEntries: 48000 }), definition);
  const unavailable = (reason: string) => ({ status: 'unavailable' as const, applied: false as const, migrationSupported: false as const, reason, note });
  const instance = document.composites?.find(item => item.id === compositeId);
  if (!instance?.blueprint) return unavailable('当前组合没有蓝图来源，不能猜测原版对应关系。');
  const provenance = instance.blueprint, mapping = provenance.mapping;
  if (!mapping) return unavailable('旧实例缺少可靠的步骤映射；保留原实例，可另外添加新版副本，不支持自动迁移。');
  const raw = document.blueprints?.find(item => item.blueprint.id === provenance.id && item.blueprint.version === provenance.version);
  if (!raw) return unavailable('库中已没有该来源版本；现有实例仍可使用，但无法对照原版。');
  const design = readS2CompositeDesign(raw), source = design.blueprint;
  const sameKeys = (expected: string[], entries: Array<{ localId: string }>) => equal([...expected].sort(), entries.map(entry => entry.localId).sort());
  if (!sameKeys(source.workflow.nodes.map(node => node.id), mapping.nodes)
    || !sameKeys(design.composites.map(item => item.id), mapping.composites)
    || mapping.composites.find(item => item.localId === design.rootId)?.id !== compositeId) return unavailable('来源映射与库中版本不一致；不按节点名称、数组顺序或版本标记猜测。');
  const nodes = new Map(mapping.nodes.map(entry => [entry.localId, entry.id]));
  const shells = new Map(mapping.composites.map(entry => [entry.localId, entry.id]));
  const mapped = (endpoint: { nodeId: string; portId: string }) => ({ ...endpoint, nodeId: nodes.get(endpoint.nodeId)! });
  const actualNodes = document.execution!.nodes, members = new Set(instance.nodeIds);
  const publicTargets = new Set([...source.inputs.flatMap(input => input.targets), ...source.parameters.map(parameter => parameter.target)].map(endpointKey));
  const nodeChanges: Array<{ id: string; label: string; changes: string[] }> = [];
  for (const before of source.workflow.nodes) {
    const id = nodes.get(before.id)!, after = actualNodes.find(node => node.id === id), changes: string[] = [];
    if (!after) changes.push('原版步骤已删除');
    else if (!members.has(id)) changes.push('原版步骤已移出此组合');
    else {
      if (s2CapabilityKey(before) !== s2CapabilityKey(after)) changes.push('处理能力或版本改变');
      const fixed = (bindings: Record<string, S2InputBinding>) => Object.fromEntries(Object.entries(bindings).filter(([portId]) => !publicTargets.has(endpointKey({ nodeId: before.id, portId }))));
      if (!equal(fixed(before.bindings), fixed(after.bindings))) changes.push('内部固定内容或绑定改变');
      if (!equal(before.when ? mapped(before.when) : null, after.when ?? null)) changes.push('条件改变');
      if (!equal(before.presentation ?? null, after.presentation ?? null)) changes.push('名称、说明或交互表单改变');
    }
    if (changes.length) nodeChanges.push({ id, label: s2NodeTitle(after ?? before), changes });
  }
  const mappedIds = new Set(nodes.values());
  for (const after of actualNodes.filter(node => members.has(node.id) && !mappedIds.has(node.id))) nodeChanges.push({ id: after.id, label: s2NodeTitle(after), changes: ['组合内新增步骤'] });
  const links = document.execution!.links;
  const expectedLinks = source.workflow.links.map(link => ({ source: mapped(link.source), target: mapped(link.target) }));
  const actualLinks = links.filter(link => members.has(link.source.nodeId) && members.has(link.target.nodeId));
  const internalLinksChanged = !equal(sorted(expectedLinks), sorted(actualLinks));
  const materials = source.inputs.map(input => ({ id: input.id, label: input.label, targets: input.targets.map(target => {
    const endpoint = mapped(target), node = actualNodes.find(node => node.id === endpoint.nodeId);
    if (!node || !members.has(node.id)) return '对应步骤不在组合内';
    const binding = node.bindings[target.portId], incoming = links.filter(link => endpointKey(link.target) === endpointKey(endpoint));
    return incoming.some(link => members.has(link.source.nodeId)) ? '已改用组合内步骤供给'
      : incoming.length ? '已连接外部步骤'
        : binding?.kind === 'field' ? '已选择内容块'
          : binding ? ['local-material', 'project-notes'].includes(node.pluginId) && target.portId === 'resource' ? '已选择本局资料，授权须另行核对' : '已填写内容'
            : '尚未设置';
  }) }));
  const parameters = source.parameters.map(parameter => {
    const endpoint = mapped(parameter.target), node = actualNodes.find(node => node.id === endpoint.nodeId);
    const expected = Object.hasOwn(parameter, 'defaultValue') ? { kind: 'literal', value: parameter.defaultValue } : null;
    const binding = node?.bindings[endpoint.portId] ?? null;
    const incoming = links.some(link => endpointKey(link.target) === endpointKey(endpoint));
    const state = !node || !members.has(node.id) ? '对应步骤不在组合内' : incoming ? '改用步骤输出' : equal(expected, binding) ? '与原版默认设置一致' : binding?.kind === 'field' ? '改用内容块' : binding ? '与原版默认设置不同' : '当前未设置';
    return { id: parameter.id, label: parameter.label, state, differsFromSource: !node || !members.has(node.id) || incoming || !equal(expected, binding) };
  });
  const hierarchyChanges: string[] = [];
  for (const before of design.composites) {
    const label = before.id === design.rootId ? source.label : before.label;
    const after = document.composites!.find(item => item.id === shells.get(before.id));
    if (!after) { hierarchyChanges.push(`「${label}」已拆开或移除`); continue; }
    const inTree = s2CompositePath(document, after.id).some(item => item.id === instance.id);
    if (!inTree) { hierarchyChanges.push(`「${label}」已移出组合`); continue; }
    if (!equal(before.nodeIds.map(id => nodes.get(id)).sort(), [...after.nodeIds].sort())) hierarchyChanges.push(`「${label}」成员改变`);
    if (before.id !== design.rootId && after.parentId !== shells.get(before.parentId!)) hierarchyChanges.push(`「${label}」层级改变`);
    if (after.label !== label) hierarchyChanges.push(`「${label}」名称改变`);
  }
  const mappedShells = new Set(shells.values());
  for (const after of document.composites!.filter(item => !mappedShells.has(item.id) && s2CompositePath(document, item.id).some(parent => parent.id === instance.id))) hierarchyChanges.push(`新增组合「${after.label}」`);
  // Whole-instance translation is normal placement, not an internal layout change. Compare relative positions.
  const anchor = source.workflow.nodes.find(node => members.has(nodes.get(node.id)!) && actualNodes.some(actual => actual.id === nodes.get(node.id)));
  const actualAnchor = actualNodes.find(node => node.id === (anchor && nodes.get(anchor.id)));
  const relativeLayoutChanged = !!anchor && !!actualAnchor && source.workflow.nodes.some(before => {
    const after = actualNodes.find(node => node.id === nodes.get(before.id));
    return after && members.has(after.id) && !equal({ x: before.position.x - anchor.position.x, y: before.position.y - anchor.position.y }, { x: after.position.x - actualAnchor.position.x, y: after.position.y - actualAnchor.position.y });
  });
  const boundaryLinks = links.filter(link => members.has(link.source.nodeId) !== members.has(link.target.nodeId));
  const fieldReferences = actualNodes.filter(node => members.has(node.id)).flatMap(node => Object.values(node.bindings).filter(binding => binding.kind === 'field' && !members.has(binding.nodeId)));
  const guardReferences = actualNodes.filter(node => node.when && members.has(node.id) !== members.has(node.when.nodeId));
  return { status: 'compared' as const, scope: 'current-library-version-instance-comparison' as const, applied: false as const, migrationSupported: false as const,
    source: { id: source.id, version: source.version, label: source.label }, instance: { id: instance.id, label: instance.label },
    nodeChanges, internalLinksChanged, hierarchyChanges, relativeLayoutChanged, materials, parameters,
    externalConnectionCount: boundaryLinks.length + fieldReferences.length + guardReferences.length,
    structuralDifferences: !!nodeChanges.length || internalLinksChanged || !!hierarchyChanges.length,
    note };
}
export type S2CompositeInstanceInspection = ReturnType<typeof inspectS2CompositeInstance>;
