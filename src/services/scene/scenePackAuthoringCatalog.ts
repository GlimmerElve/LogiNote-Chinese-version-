import type { ScenePackAuthoringCatalog, ScenePackPublicComponent } from '../../types/sceneInteractionPack';
import type { S2BlockType, S2Document } from '../../types/sceneS2';
import type { S2Json, S2PluginCapability, S2PluginManifest } from '../../types/sceneS2Plugin';
import { readS2Field } from './sceneS2Controls';

export class ScenePackAuthoringCatalogError extends Error {
  constructor(readonly code: string, readonly path: string, readonly detail: string) {
    super(`[${code}] ${path}: ${detail}`); this.name = 'ScenePackAuthoringCatalogError';
  }
}
export interface ScenePackAuthoringCatalogOptions { capabilities: readonly S2PluginManifest[]; sharedCapabilities?: readonly S2PluginManifest[] }
const reserved = new Set(['__proto__', 'prototype', 'constructor']);
const child = (path: string, key: string | number) => `${path}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;
function fail(code: string, path: string, message: string): never { throw new ScenePackAuthoringCatalogError(code, path, message); }
function fields(raw: unknown, path: string, allowed?: readonly string[], required: readonly string[] = []): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) fail('PACK_CONTRACT_OBJECT', path, '需要普通声明对象');
  const descriptors = Object.getOwnPropertyDescriptors(raw), result: Record<string, unknown> = Object.create(null);
  if (Reflect.ownKeys(descriptors).length > 256) fail('PACK_CONTRACT_LIMIT', path, '对象最多256个字段');
  for (const name of Reflect.ownKeys(descriptors)) {
    if (typeof name !== 'string' || reserved.has(name) || allowed && !allowed.includes(name)) fail('PACK_CONTRACT_FIELD', path, '含未知、符号或保留字段');
    const property = descriptors[name];
    if (!property.enumerable || !Object.hasOwn(property, 'value')) fail('PACK_CONTRACT_FIELD', child(path, name), '不允许访问器或隐藏字段');
    result[name] = property.value;
  }
  for (const name of required) if (!Object.hasOwn(result, name)) fail('PACK_CONTRACT_FIELD', child(path, name), '缺少必需字段');
  return result;
}
function array(raw: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype) fail('PACK_CONTRACT_DATA', path, '需要普通数组');
  if (raw.length > max) fail('PACK_CONTRACT_LIMIT', path, `最多${max}项`);
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  if (Reflect.ownKeys(descriptors).length !== raw.length + 1) fail('PACK_CONTRACT_FIELD', path, '数组不能含额外字段');
  return Array.from({ length: raw.length }, (_, index) => {
    const property = descriptors[String(index)];
    if (!property?.enumerable || !Object.hasOwn(property, 'value')) fail('PACK_CONTRACT_FIELD', child(path, index), '不允许空项或访问器');
    return property.value;
  });
}
function text(raw: unknown, path: string, max = 120): string {
  if (typeof raw !== 'string' || !raw.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(raw)) fail('PACK_CONTRACT_DATA', path, '需要有效非空文本');
  if (raw.length > max) fail('PACK_CONTRACT_LIMIT', path, `文本最多${max}字`);
  return raw;
}
function id(raw: unknown, path: string): string {
  const result = text(raw, path, 64);
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/u.test(result) || reserved.has(result)) fail('PACK_CONTRACT_REFERENCE', path, '需要合法标识符');
  return result;
}
function unique(values: readonly string[], path: string) { if (new Set(values).size !== values.length) fail('PACK_CONTRACT_DUPLICATE', path, '标识重复'); }
function ids(raw: unknown, path: string, max = 16): string[] { const result = array(raw, path, max).map((value, index) => id(value, child(path, index))); unique(result, path); return result; }

/** Snapshot before invoking any reused native descriptor reader. No getter, custom iterator,
 * cyclic value, executable value, or mutable package alias survives this boundary. */
function snapshot(raw: unknown): S2Json {
  const active = new Set<object>(); let entries = 0, bytes = 0;
  const spend = (value: string, path: string) => { bytes += new TextEncoder().encode(value).byteLength; if (bytes > 262144) fail('PACK_CONTRACT_LIMIT', path, '公开目录超过262144字节'); };
  const visit = (value: unknown, path: string, depth: number): S2Json => {
    if (++entries > 20000 || depth > 24) fail('PACK_CONTRACT_LIMIT', path, '公开目录超过元素或嵌套限制');
    if (value === null || typeof value === 'boolean') return value as null | boolean;
    if (typeof value === 'number') { if (!Number.isFinite(value)) fail('PACK_CONTRACT_DATA', path, '数值必须有限'); return value; }
    if (typeof value === 'string') { if (value.length > 64000) fail('PACK_CONTRACT_LIMIT', path, '单段文字超过64000字'); spend(value, path); return value; }
    if (!value || typeof value !== 'object') fail('PACK_CONTRACT_DATA', path, '只接受原生JSON声明');
    if (active.has(value)) fail('PACK_CONTRACT_DATA', path, '声明不能循环引用');
    active.add(value);
    const result: S2Json = Array.isArray(value) ? array(value, path, 2048).map((item, index) => visit(item, child(path, index), depth + 1))
      : Object.fromEntries(Object.entries(fields(value, path)).map(([name, item]) => { spend(name, path); return [name, visit(item, child(path, name), depth + 1)]; }));
    active.delete(value); return result;
  };
  const result = visit(raw, '/authoring', 0);
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 262144) fail('PACK_CONTRACT_LIMIT', '/authoring', '完整公开目录超过262144字节');
  return result;
}
function blockType(raw: unknown, path: string): S2BlockType {
  const value = fields(raw, path, ['id', 'label', 'fields', 'advanced'], ['id', 'label', 'fields']);
  if (value.advanced !== undefined && typeof value.advanced !== 'boolean') fail('PACK_CONTRACT_DATA', path + '/advanced', '需要布尔值');
  const descriptors = array(value.fields, path + '/fields', 8).map((field, index) => {
    try { return readS2Field(field); }
    catch (error) { fail('PACK_CONTRACT_DATA', `${path}/fields/${index}`, error instanceof Error ? error.message : '原生内容字段无效'); }
  });
  if (!descriptors.length) fail('PACK_CONTRACT_DATA', path + '/fields', '内容类型至少有一个字段');
  unique(descriptors.map(field => field.id), path + '/fields');
  return { id: id(value.id, path + '/id'), label: text(value.label, path + '/label', 80), fields: descriptors,
    ...(value.advanced !== undefined ? { advanced: value.advanced as boolean } : {}) };
}
function capability(value: Record<string, unknown>, path: string, options: ScenePackAuthoringCatalogOptions): { reference: Extract<ScenePackPublicComponent['implementation'], { kind: 'capability' }>; known?: S2PluginCapability } {
  const pluginId = text(value.pluginId, path + '/pluginId'), pluginVersion = text(value.pluginVersion, path + '/pluginVersion', 40), capabilityId = id(value.capabilityId, path + '/capabilityId');
  if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u.test(pluginId) || reserved.has(pluginId)) fail('PACK_CONTRACT_REFERENCE', path + '/pluginId', '插件标识无效');
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(pluginVersion)) fail('PACK_CONTRACT_REFERENCE', path + '/pluginVersion', '需要精确x.y.z版本');
  const owned = options.capabilities.filter(plugin => plugin.id === pluginId);
  const plugins = (owned.length ? owned : options.sharedCapabilities ?? []).filter(plugin => plugin.id === pluginId && plugin.version === pluginVersion);
  const candidates = plugins.map(plugin => plugin.capabilities.find(item => item.id === capabilityId));
  if ((owned.length || options.sharedCapabilities !== undefined) && (!candidates.length || candidates.some(item => !item || item.kind === 'editor')))
    fail('PACK_CONTRACT_REFERENCE', path, '实现不对应包内或共享范围的精确可组合能力');
  return { reference: { kind: 'capability', pluginId, pluginVersion, capabilityId }, known: candidates.find((item): item is S2PluginCapability => !!item) };
}

/** Pure machine interface. Empty components is intentionally closed. Full runtime
 * implementations and the trusted internal baseline are never inferred from this list. */
export function readScenePackAuthoringCatalog(raw: unknown, options: ScenePackAuthoringCatalogOptions): ScenePackAuthoringCatalog {
  const value = fields(snapshot(raw), '/authoring', ['version', 'components', 'internal'], ['version', 'components']);
  if (value.version !== 1) fail('PACK_CONTRACT_VERSION', '/authoring/version', '不支持的公开搭建接口版本');
  const groups = new Map<string, string>();
  const components = array(value.components, '/authoring/components', 64).map((rawComponent, index): ScenePackPublicComponent => {
    const path = `/authoring/components/${index}`, component = fields(rawComponent, path,
      ['id', 'label', 'purpose', 'group', 'implementation', 'inputs', 'outputs', 'parameters', 'defaults'], ['id', 'label', 'purpose', 'implementation', 'inputs', 'outputs', 'parameters']);
    const implementation = fields(component.implementation, path + '/implementation');
    let mapping: ScenePackPublicComponent['implementation'], inputIds: string[] | undefined, outputIds: string[] | undefined, parameterIds: string[] | undefined;
    if (implementation.kind === 'content') {
      fields(implementation, path + '/implementation', ['kind', 'blockType'], ['kind', 'blockType']);
      const nativeType = blockType(implementation.blockType, path + '/implementation/blockType');
      mapping = { kind: 'content', blockType: nativeType }; inputIds = []; outputIds = parameterIds = nativeType.fields.map(field => field.id);
    } else if (implementation.kind === 'capability') {
      fields(implementation, path + '/implementation', ['kind', 'pluginId', 'pluginVersion', 'capabilityId'], ['kind', 'pluginId', 'pluginVersion', 'capabilityId']);
      const resolved = capability(implementation, path + '/implementation', options); mapping = resolved.reference;
      inputIds = parameterIds = resolved.known?.inputs.map(port => port.id); outputIds = resolved.known?.outputs.map(port => port.id);
    } else fail('PACK_CONTRACT_DATA', path + '/implementation/kind', '实现只能是content或capability');
    const inputs = ids(component.inputs, path + '/inputs'), outputs = ids(component.outputs, path + '/outputs'), parameters = ids(component.parameters, path + '/parameters');
    for (const [name, selected, available] of [['inputs', inputs, inputIds], ['outputs', outputs, outputIds], ['parameters', parameters, parameterIds]] as const)
      selected.forEach((port, portIndex) => { if (available && !available.includes(port)) fail('PACK_CONTRACT_REFERENCE', `${path}/${name}/${portIndex}`, '公开项没有对应的真实端口或内容字段'); });
    let group: ScenePackPublicComponent['group'];
    if (component.group !== undefined) {
      const rawGroup = fields(component.group, path + '/group', ['id', 'label'], ['id', 'label']);
      group = { id: id(rawGroup.id, path + '/group/id'), label: text(rawGroup.label, path + '/group/label') };
      if (groups.has(group.id) && groups.get(group.id) !== group.label) fail('PACK_CONTRACT_REFERENCE', path + '/group', '同一分组的标签必须一致');
      groups.set(group.id, group.label);
    }
    let defaults: Record<string, S2Json> | undefined;
    if (component.defaults !== undefined) {
      const entries = fields(component.defaults, path + '/defaults');
      if (Object.keys(entries).length > 16) fail('PACK_CONTRACT_LIMIT', path + '/defaults', '最多16个默认输入');
      defaults = Object.fromEntries(Object.entries(entries).map(([name, entry]) => {
        id(name, child(path + '/defaults', name));
        if (parameterIds && !parameterIds.includes(name)) fail('PACK_CONTRACT_REFERENCE', child(path + '/defaults', name), '默认值没有对应的真实输入或字段');
        return [name, entry as S2Json];
      }));
      if (new TextEncoder().encode(JSON.stringify(defaults)).byteLength > 16384) fail('PACK_CONTRACT_LIMIT', path + '/defaults', '默认值超过16384字节');
    }
    return { id: id(component.id, path + '/id'), label: text(component.label, path + '/label'), purpose: text(component.purpose, path + '/purpose', 6000),
      implementation: mapping, inputs, outputs, parameters, ...(group ? { group } : {}), ...(defaults !== undefined ? { defaults } : {}) };
  });
  unique(components.map(component => component.id), '/authoring/components');
  const result: ScenePackAuthoringCatalog = { version: 1, components };
  if (value.internal !== undefined) {
    const internal = fields(value.internal, '/authoring/internal', ['blockTypes', 'document'], ['blockTypes', 'document']);
    const blockTypes = array(internal.blockTypes, '/authoring/internal/blockTypes', 8).map((raw, index) => blockType(raw, `/authoring/internal/blockTypes/${index}`));
    unique(blockTypes.map(type => type.id), '/authoring/internal/blockTypes');
    const document = fields(internal.document, '/authoring/internal/document', ['nodes', 'edges', 'execution', 'groups', 'composites', 'blueprints'], ['nodes', 'edges']);
    array(document.nodes, '/authoring/internal/document/nodes', 40); array(document.edges, '/authoring/internal/document/edges', 80);
    if (document.execution !== undefined) {
      const execution = fields(document.execution, '/authoring/internal/document/execution', ['version', 'nodes', 'links'], ['version', 'nodes', 'links']);
      if (execution.version !== 1) fail('PACK_CONTRACT_VERSION', '/authoring/internal/document/execution/version', '需要原生执行图版本1');
      array(execution.nodes, '/authoring/internal/document/execution/nodes', 40); array(execution.links, '/authoring/internal/document/execution/links', 80);
    }
    result.internal = { blockTypes, document: structuredClone(document) as unknown as S2Document };
  }
  return result;
}
