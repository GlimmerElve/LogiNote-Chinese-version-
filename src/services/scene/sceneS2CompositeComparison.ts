import type { S2CompositeBlueprint, S2CompositeCapability, S2CompositeEndpoint } from '../../types/sceneS2Composite';
import { readS2CompositeDesign, s2CompositeDesignSignature } from './sceneS2CompositeLibrary';
import { snapshotS2CompositeData } from './sceneS2Composite';
import { canonicalS2Json } from './sceneS2PluginProtocol';
import { readS2PluginBindings, s2BuiltinPluginRegistry, s2CapabilityKey } from './sceneS2PluginRegistry';
import { s2NodeTitle } from './sceneS2Presentation';

type PublicKind = 'input' | 'output' | 'parameter';
type Change = { kind: PublicKind; id: string; label: string; changes: string[]; breaking: boolean; review: boolean };
const equal = (a: unknown, b: unknown) => canonicalS2Json(a as any) === canonicalS2Json(b as any);
const owns = (value: object, key: string) => Object.hasOwn(value, key);
const registry = s2BuiltinPluginRegistry();
const kindNames: Record<PublicKind, string> = { input: '材料入口', output: '输出结果', parameter: '可调项' };
const direction = (a: string, b: string) => {
  const from = a.split('.').map(BigInt), to = b.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) if (from[i] !== to[i]) return from[i] < to[i] ? 'upgrade' as const : 'downgrade' as const;
  return 'same' as const;
};

/** Static version comparison only. Never reads/mutates an instance or produces an upgrade command/permission. */
export function compareS2CompositeDesigns(fromRaw: unknown, toRaw: unknown, allowedRaw: S2CompositeCapability[] = []) {
  const from = readS2CompositeDesign(fromRaw), to = readS2CompositeDesign(toRaw);
  if (from.blueprint.id !== to.blueprint.id) throw new Error('只能比较同一蓝图系列的精确版本，不按名称猜测对应关系');
  if (from.blueprint.version === to.blueprint.version && s2CompositeDesignSignature(from) !== s2CompositeDesignSignature(to)) throw new Error('同版本内容冲突，不能作为合法版本差异或迁移来源');
  const a = from.blueprint, b = to.blueprint;
  const allowed = new Set(readS2PluginBindings(snapshotS2CompositeData(allowedRaw)).map(s2CapabilityKey));
  const changes: Change[] = [], carryCandidates: Array<{ kind: 'input' | 'parameter'; id: string; label: string }> = [];
  const addedRequired: Array<{ kind: 'input' | 'parameter'; id: string; label: string }> = [];
  const resourceInputs: Array<{ id: string; label: string }> = [];
  const lists = (blueprint: S2CompositeBlueprint, kind: PublicKind): any[] => kind === 'input' ? blueprint.inputs : kind === 'output' ? blueprint.outputs : blueprint.parameters;
  const mapping = (blueprint: S2CompositeBlueprint, port: any, kind: PublicKind) => {
    const endpoints: S2CompositeEndpoint[] = kind === 'input' ? port.targets : [kind === 'output' ? port.source : port.target];
    return endpoints.map(endpoint => {
      const node = blueprint.workflow.nodes.find(node => node.id === endpoint.nodeId)!;
      return { nodeId: node.id, capability: s2CapabilityKey(node), portId: endpoint.portId };
    }).sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
  };
  const required = (blueprint: S2CompositeBlueprint, port: any, kind: PublicKind): boolean => kind === 'parameter'
    ? registry.capability(blueprint.workflow.nodes.find(node => node.id === port.target.nodeId)!).inputs.find(input => input.id === port.target.portId)!.required && !owns(port, 'defaultValue')
    : port.required;
  const isResource = (blueprint: S2CompositeBlueprint, port: S2CompositeBlueprint['inputs'][number]) => port.targets.some(target => {
    const node = blueprint.workflow.nodes.find(node => node.id === target.nodeId)!;
    return ['local-material', 'project-notes'].includes(node.pluginId) && target.portId === 'resource';
  });
  for (const kind of ['input', 'output', 'parameter'] as const) {
    const old = lists(a, kind), next = lists(b, kind);
    for (const id of new Set([...old, ...next].map(port => port.id))) {
      const before = old.find(port => port.id === id), after = next.find(port => port.id === id), effect: string[] = [];
      let breaking = false, review = false;
      if (!before) {
        effect.push('新增'); breaking = kind !== 'output' && required(b, after, kind);
        if (breaking) addedRequired.push({ kind: kind as 'input' | 'parameter', id, label: after.label });
      } else if (!after) { effect.push('移除'); breaking = true; }
      else {
        if (!equal(before.type, after.type)) { effect.push('数据类型或版本改变'); breaking = true; }
        if (kind !== 'parameter' && before.multiple !== after.multiple) { effect.push('单项／多项接收方式改变'); breaking = true; }
        if (required(a, before, kind) !== required(b, after, kind)) {
          effect.push('必填或输出保证改变');
          const weaker = kind === 'output' ? before.required && !after.required : !required(a, before, kind) && required(b, after, kind);
          if (weaker) { breaking = true; if (kind !== 'output') addedRequired.push({ kind, id, label: after.label }); }
        }
        if (!equal(mapping(a, before, kind), mapping(b, after, kind))) { effect.push('内部对应步骤改变，不能仅凭入口名称沿用'); review = true; }
        if (before.label !== after.label) { effect.push('显示名称改变，需核对用途'); review = true; }
        if (kind === 'parameter' && (owns(before, 'defaultValue') !== owns(after, 'defaultValue') || owns(before, 'defaultValue') && !equal(before.defaultValue, after.defaultValue))) {
          effect.push('默认值改变，需确认沿用旧值还是使用新值'); review = true;
        }
        if (kind !== 'output' && !breaking && !review && !(kind === 'input' && isResource(b, after))) carryCandidates.push({ kind, id, label: after.label });
      }
      if (after && kind === 'input' && isResource(b, after)) resourceInputs.push({ id, label: after.label });
      if (effect.length) changes.push({ kind, id, label: after?.label ?? before.label, changes: effect, breaking, review });
    }
  }
  const nodeChanges: Array<{ id: string; label: string; changes: string[] }> = [];
  for (const id of new Set([...a.workflow.nodes, ...b.workflow.nodes].map(node => node.id))) {
    const before = a.workflow.nodes.find(node => node.id === id), after = b.workflow.nodes.find(node => node.id === id), effect: string[] = [];
    if (!before) effect.push('新增步骤'); else if (!after) effect.push('移除步骤'); else {
      if (s2CapabilityKey(before) !== s2CapabilityKey(after)) effect.push('处理能力或版本改变');
      if (!equal(before.bindings, after.bindings)) effect.push('固定内容改变');
      if (!equal(before.when ?? null, after.when ?? null)) effect.push('条件改变');
      if (!equal(before.presentation ?? null, after.presentation ?? null)) effect.push('名称、说明或交互表单改变');
      if (!equal(before.position, after.position)) effect.push('布局改变');
    }
    if (effect.length) nodeChanges.push({ id, label: s2NodeTitle((after ?? before)!), changes: effect });
  }
  const sorted = (items: unknown[]) => items.map(value => canonicalS2Json(value as any)).sort();
  const linksChanged = !equal(sorted(a.workflow.links), sorted(b.workflow.links));
  const hierarchyChanged = !equal(sorted(from.composites.map(item => ({ ...item, nodeIds: [...item.nodeIds].sort() }))), sorted(to.composites.map(item => ({ ...item, nodeIds: [...item.nodeIds].sort() }))));
  const addedCapabilities = b.plugins.filter(cap => !a.plugins.some(old => s2CapabilityKey(old) === s2CapabilityKey(cap))).map(cap => ({ ...cap, label: s2NodeTitle(cap) }));
  const removedCapabilities = a.plugins.filter(cap => !b.plugins.some(next => s2CapabilityKey(next) === s2CapabilityKey(cap))).map(cap => ({ ...cap, label: s2NodeTitle(cap) }));
  const missingCapabilities = b.plugins.filter(cap => !allowed.has(s2CapabilityKey(cap))).map(cap => ({ ...cap, label: s2NodeTitle(cap) }));
  return {
    scope: 'saved-version-static-comparison' as const, applied: false as const, instanceMigrationSupported: false as const,
    from: { id: a.id, version: a.version, label: a.label }, to: { id: b.id, version: b.version, label: b.label }, direction: direction(a.version, b.version),
    interfaceCompatibility: changes.some(change => change.breaking) ? 'breaking' as const : 'structure-compatible' as const,
    sceneCapabilitiesReady: !missingCapabilities.length, missingCapabilities, addedCapabilities, removedCapabilities,
    changes: changes.map(change => ({ ...change, kindLabel: kindNames[change.kind] })), nodeChanges, linksChanged, hierarchyChanged,
    nameChanged: a.label !== b.label, descriptionChanged: a.description !== b.description,
    carryCandidates, addedRequired, resourceInputs,
    note: '仅比较库中两份版本，不检查现有实例是否已编辑，不提取或迁移实例的实际材料/参数。结构兼容不证明业务等价、运行成功或目标达成。候选沿用项须在实际升级前逐项复核；资料权限和模型预算/确认不迁移。',
  };
}
export type S2CompositeComparison = ReturnType<typeof compareS2CompositeDesigns>;
