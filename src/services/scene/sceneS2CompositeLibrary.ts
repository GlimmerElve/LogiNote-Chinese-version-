import type { S2CanvasDefinition, S2Document } from '../../types/sceneS2';
import type { S2CompositeDesign, S2CompositeValues } from '../../types/sceneS2Composite';
import { expandS2Composite, readS2CompositeBlueprint, snapshotS2CompositeData } from './sceneS2Composite';
import { readS2CanvasComposites, s2CanvasCompositeBlueprint, s2CompositePath, placeS2NewStepsInComposite } from './sceneS2CompositeCanvas';
import { canonicalS2Json } from './sceneS2PluginProtocol';
import { s2ComposableCapabilities, s2CapabilityKey, readS2PluginBindings } from './sceneS2PluginRegistry';

// Installed schemas validate inert storage; only the destination's selected capabilities permit expansion.
const installed = () => s2ComposableCapabilities().map(({ pluginId, pluginVersion, capabilityId }) => ({ pluginId, pluginVersion, capabilityId }));
export const S2_BLUEPRINT_AGENT_RULES = 'current.blueprintIndex是已保存版本索引，不含固定正文/完整图，不是授权。按语义可建议{op:"instantiate-blueprint",id:系列id,version:精确版本,parentId?:父组合id,values?:{inputs?:{公共id:原生值},parameters?:{公共id:原生值},position?:{x,y}}}。宿主展开真实图/层级，确认应用后才添加，不运行；须已装配所需能力。接口详情省略时不猜参数，可建议添加待编辑副本。未填材料须重选，不携带旧资源授权；不能用组合ID执行。实例独立，不自动升级。';
const exact = (value: any, keys: string[]) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error('蓝图设计字段无效');
};
export function readS2CompositeDesign(raw: unknown): S2CompositeDesign {
  const value = snapshotS2CompositeData(raw) as S2CompositeDesign;
  exact(value, ['format', 'protocolVersion', 'blueprint', 'rootId', 'composites']);
  if (value.format !== 's2-composite-design' || value.protocolVersion !== 1 || typeof value.rootId !== 'string') throw new Error('只支持S2完整组合蓝图设计，不自动转换其他工作流格式');
  const declared = readS2PluginBindings(value.blueprint?.plugins), known = new Set(installed().map(s2CapabilityKey));
  if (declared.some(plugin => !known.has(s2CapabilityKey(plugin)))) throw new Error('蓝图包含未安装的能力或版本');
  const blueprint = readS2CompositeBlueprint(value.blueprint, declared);
  const document = { nodes: [], edges: [], execution: blueprint.workflow };
  const composites = readS2CanvasComposites(value.composites, document, blueprint.plugins);
  const root = composites.find(item => item.id === value.rootId), candidate = { ...document, composites };
  if (!root || root.parentId || root.nodeIds.length !== blueprint.workflow.nodes.length || composites.some(item => item.blueprint || s2CompositePath(candidate, item.id)[0].id !== root.id)) throw new Error('蓝图必须保留完整单根层级，不携带旧实例来源');
  return { format: 's2-composite-design', protocolVersion: 1, blueprint, rootId: root.id, composites };
}
/** No external blocks, field bindings, resource handles, receipts, grants or previous library are copied. */
export function createS2CompositeDesign(document: S2Document, plugins: S2CanvasDefinition['plugins'], compositeId: string,
  publication: { id: string; version: string; label: string; description: string }): S2CompositeDesign {
  const root = document.composites?.find(item => item.id === compositeId);
  if (!root) throw new Error('请选择存在的组合');
  const metadata = snapshotS2CompositeData(publication); exact(metadata, ['id', 'version', 'label', 'description']);
  const blueprint = { ...s2CanvasCompositeBlueprint(document, root, plugins), ...metadata };
  const composites = (document.composites ?? []).filter(item => s2CompositePath(document, item.id).some(parent => parent.id === compositeId))
    .map(({ blueprint: _source, parentId, ...item }) => ({ ...structuredClone(item), ...(item.id !== root.id && parentId ? { parentId } : {}) }));
  return readS2CompositeDesign({ format: 's2-composite-design', protocolVersion: 1, blueprint, rootId: root.id, composites });
}
export function s2CompositeDesignSignature(raw: unknown): string {
  return canonicalS2Json(readS2CompositeDesign(raw) as any);
}
export function readS2CompositeLibrary(raw: unknown): S2CompositeDesign[] {
  const value = snapshotS2CompositeData(raw);
  if (!Array.isArray(value) || value.length > 8) throw new Error('本画布蓝图库最多保存8个版本');
  const entries = value.map(readS2CompositeDesign), ids = new Set<string>();
  for (const entry of entries) {
    const key = JSON.stringify([entry.blueprint.id, entry.blueprint.version]);
    if (ids.has(key)) throw new Error('蓝图库存在重复的系列和版本'); ids.add(key);
  }
  return entries;
}
/** Exact same publication is idempotent. A changed body/hierarchy under the same release fails atomically. */
export function addS2CompositeDesign(document: S2Document, raw: unknown): S2Document {
  const design = readS2CompositeDesign(raw), entries = readS2CompositeLibrary(document.blueprints ?? []);
  const existing = entries.find(item => item.blueprint.id === design.blueprint.id && item.blueprint.version === design.blueprint.version);
  if (existing && s2CompositeDesignSignature(existing) !== s2CompositeDesignSignature(design)) throw new Error('同一蓝图版本已有不同内容，请保存为新版本或新系列；未覆盖原版本');
  return { ...structuredClone(document), blueprints: existing ? entries : readS2CompositeLibrary([...entries, design]) };
}
export function importS2CompositeDesign(text: string): S2CompositeDesign {
  if (typeof text !== 'string' || text.length > 128000) throw new Error('蓝图设计过大，不读取部分内容');
  return readS2CompositeDesign(JSON.parse(text));
}
export function exportS2CompositeDesign(raw: unknown): string { return JSON.stringify(readS2CompositeDesign(raw)); }
export function removeS2CompositeDesign(document: S2Document, id: string, version: string): S2Document {
  if (!document.blueprints?.some(item => item.blueprint.id === id && item.blueprint.version === version)) throw new Error('该蓝图版本已不存在');
  return { ...structuredClone(document), blueprints: document.blueprints.filter(item => item.blueprint.id !== id || item.blueprint.version !== version) };
}
/** Pure candidate. The caller MUST validate the complete resulting scene before one commit. */
export function instantiateS2CompositeDesign(document: S2Document, plugins: S2CanvasDefinition['plugins'], id: string, version: string,
  values: S2CompositeValues = {}, parentId?: string, instanceKey?: string): { document: S2Document; id: string; nodeIds: string[] } {
  const design = readS2CompositeLibrary(document.blueprints ?? []).find(item => item.blueprint.id === id && item.blueprint.version === version);
  if (!design) throw new Error('蓝图库中不存在指定的精确系列和版本');
  if (parentId !== undefined) s2CompositePath(document, parentId);
  const expanded = expandS2Composite(design.blueprint, plugins ?? [], values, instanceKey), mapping = new Map(expanded.sourceMap.map(item => [item.localNodeId, item.nodeId]));
  const shells = new Map(design.composites.map((item, index) => [item.id, item.id === design.rootId ? expanded.instanceId : `${expanded.instanceId}-c${index}`]));
  let next = structuredClone(document);
  next.execution = { version: 1, nodes: [...(next.execution?.nodes ?? []), ...expanded.workflow.nodes], links: [...(next.execution?.links ?? []), ...expanded.workflow.links] };
  // Attach only new real steps before adding their child hierarchy.
  if (parentId !== undefined) next = placeS2NewStepsInComposite(document, next, parentId);
  next.composites = [...(next.composites ?? []), ...design.composites.map(item => ({ id: shells.get(item.id)!, label: item.id === design.rootId ? design.blueprint.label : item.label,
    nodeIds: item.nodeIds.map(id => mapping.get(id)!), ...(item.parentId ? { parentId: shells.get(item.parentId)! } : parentId ? { parentId } : {}),
    ...(item.id === design.rootId ? { blueprint: { id: design.blueprint.id, version: design.blueprint.version,
      mapping: { nodes: expanded.sourceMap.map(({ localNodeId, nodeId }) => ({ localId: localNodeId, id: nodeId })),
        composites: [...shells].map(([localId, id]) => ({ localId, id })) } } } : {}) }))];
  return { document: next, id: expanded.instanceId, nodeIds: expanded.workflow.nodes.map(node => node.id) };
}
/** Discovery only. Never sends fixed text/defaults, full graphs or authority into routine Agent context. */
export function s2CompositeLibraryIndex(document: S2Document) {
  const entries = document.blueprints ?? [], detailed = entries.map(({ blueprint, composites }) => ({ id: blueprint.id, version: blueprint.version, label: blueprint.label, description: blueprint.description,
    requiredCapabilities: blueprint.plugins, nodeCount: blueprint.workflow.nodes.length, compositeCount: composites.length,
    inputs: blueprint.inputs.map(({ targets: _, ...port }) => port), outputs: blueprint.outputs.map(({ source: _, ...port }) => port),
    parameters: blueprint.parameters.map(({ target: _, defaultValue, ...port }) => ({ ...port, hasDefault: Object.hasOwn(blueprint.parameters.find(item => item.id === port.id)!, 'defaultValue') })) }));
  if (JSON.stringify(detailed).length <= 6000) return detailed;
  return entries.map(({ blueprint, composites }) => ({ id: blueprint.id, version: blueprint.version, label: blueprint.label,
    descriptionPreview: blueprint.description.slice(0, 120), descriptionOmitted: blueprint.description.length > 120, interfaceDetailsOmitted: true,
    requiredCapabilityCount: blueprint.plugins.length, nodeCount: blueprint.workflow.nodes.length, compositeCount: composites.length }));
}
