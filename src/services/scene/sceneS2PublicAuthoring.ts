import type { SceneInteractionPack, ScenePackConfig, ScenePackPublicComponent } from '../../types/sceneInteractionPack';
import type { S2Block, S2BlockType, S2CanvasDefinition, S2Document, S2Field, S2TableColumn, S2WorkflowNode } from '../../types/sceneS2';
import type { S2ExecutionLink, S2Json, S2PluginPort, S2TypeRef, S2ValueSchema } from '../../types/sceneS2Plugin';
import { readS2Definition, readS2Document } from './sceneS2Canvas';
import { readS2Artifact } from './sceneS2PluginProtocol';
import { s2BuiltinPluginRegistry, s2CapabilityKey } from './sceneS2PluginRegistry';
import { s2DefaultFieldText, validateS2FieldText } from './sceneS2Controls';
import { assertS2ReadOnlyContent } from './sceneS2ReadOnly';

export interface S2PublicCanvas {
  version: 1;
  nodes: Array<{ id: string; componentId: string; position: { x: number; y: number }; label?: string; readOnly?: boolean; values?: Record<string, S2Json> }>;
  connections: Array<{ source: { nodeId: string; portId: string }; target: { nodeId: string; portId: string } }>;
}
/** Native value validation rules only; no controls, charts, syntax highlighting or code.
 * Unlike the capability schema, a native number has no implicit min/max and tables
 * distinguish missing cells from null. Only the root has a serializedMaxLength.
 */
export type S2PublicFieldRules = Pick<S2Field, 'kind' | 'required' | 'maxLength' | 'min' | 'max' | 'integer' | 'options' | 'minItems' | 'maxItems'> & {
  serializedMaxLength?: number;
  item?: S2PublicFieldRules;
  fields?: Array<S2PublicFieldRules & { id: string; label: string }>;
  columns?: S2TableColumn[];
  additionalProperties?: false;
  structured?: { maxDepth: number; maxEntries: number; maxBytes: number };
  cellMaxBytes?: number;
};
export interface S2PublicParameter {
  id: string; label: string; type: S2TypeRef; schema: S2ValueSchema; required: boolean;
  meaning?: string;
  typeMeaning?: string;
  /** Complete native rules take precedence over the legacy capability-shaped schema. */
  field?: S2PublicFieldRules;
  /** Native content controls may be unfinished while the canvas is being authored. */
  allowBlank?: boolean;
  default?: S2Json;
}
export interface S2PublicComponentDescription {
  id: string; label: string; purpose: string; group?: { id: string; label: string };
  inputs: S2PluginPort[]; outputs: S2PluginPort[]; parameters: S2PublicParameter[];
}
export interface S2PublicComponentCatalog { version: 1; components: S2PublicComponentDescription[] }
export class S2PublicAuthoringError extends Error {
  constructor(readonly code: string, readonly path: string, readonly reason: string) {
    super(`S2 公开搭建接口 [${code}] ${path}：${reason}`); this.name = 'S2PublicAuthoringError';
  }
}
function fail(code: string, path: string, message: string): never { throw new S2PublicAuthoringError(code, path, message); }
function same(a: unknown, b: unknown): boolean { return stable(a) === stable(b); }
function stable(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value);
}
/** Copy complete bounded data without invoking accessors, iterators or toJSON. */
function data<T>(raw: T): T {
  const active = new Set<object>(); let entries = 0, bytes = 0;
  const spend = (value: string) => { bytes += new TextEncoder().encode(value).byteLength; if (bytes > 786432) fail('PUBLIC_LIMIT', '/', '完整配置过大'); };
  const visit = (value: unknown, depth: number): any => {
    if (++entries > 48000 || depth > 24) fail('PUBLIC_LIMIT', '/', '配置深度或元素数量超限');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') { spend(value); return value; }
    if (!value || typeof value !== 'object' || active.has(value)) fail('PUBLIC_DATA', '/', '只接受完整原生 JSON 数据');
    active.add(value);
    const properties = Object.getOwnPropertyDescriptors(value), names = Reflect.ownKeys(properties); let result: any;
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 2048 || names.length !== value.length + 1) fail('PUBLIC_DATA', '/', '只接受稠密有界数组');
      result = Array.from({ length: value.length }, (_, index) => {
        const property = properties[String(index)];
        if (!property?.enumerable || !Object.hasOwn(property, 'value')) fail('PUBLIC_DATA', '/', '不接受访问器、空项或隐藏字段');
        return visit(property.value, depth + 1);
      });
    } else {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(value)) || names.length > 256) fail('PUBLIC_DATA', '/', '需要普通配置对象');
      result = Object.fromEntries(names.map(name => {
        if (typeof name !== 'string' || ['constructor', 'prototype', '__proto__'].includes(name)) fail('PUBLIC_DATA', '/', '不接受符号或保留字段');
        spend(name); const property = properties[name];
        if (!property.enumerable || !Object.hasOwn(property, 'value')) fail('PUBLIC_DATA', '/', '不接受访问器或隐藏字段');
        return [name, visit(property.value, depth + 1)];
      }));
    }
    active.delete(value); return result;
  };
  return visit(raw, 0);
}
function object(raw: unknown, allowed: string[], path: string): Record<string, any> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !allowed.includes(key))) fail('PUBLIC_FIELD', path, `仅允许 ${allowed.join('、')}`);
  return raw as Record<string, any>;
}
function id(raw: unknown, path: string): string {
  if (typeof raw !== 'string' || raw.length > 64 || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(raw) || ['constructor', 'prototype', '__proto__'].includes(raw)) fail('PUBLIC_ID', path, '需要合法公开标识');
  return raw;
}
function list(raw: unknown, max: number, path: string): any[] {
  if (!Array.isArray(raw) || raw.length > max) fail('PUBLIC_LIMIT', path, `需要最多 ${max} 项的列表`);
  return raw;
}
function text(raw: unknown, max: number, path: string, empty = false): string {
  if (typeof raw !== 'string' || raw.length > max || !empty && !raw.trim()) fail('PUBLIC_TEXT', path, '文本为空或超过长度上限');
  return raw;
}
function fieldSchema(field: S2Field): S2ValueSchema {
  if (['text', 'multiline', 'code', 'enum'].includes(field.kind)) return { kind: 'string', maxLength: field.maxLength ?? 6000, ...(field.options ? { enum: [...field.options] } : {}) };
  if (field.kind === 'number') return { kind: 'number', integer: field.integer === true, minimum: field.min ?? -Number.MAX_SAFE_INTEGER, maximum: field.max ?? Number.MAX_SAFE_INTEGER };
  if (field.kind === 'boolean') return { kind: 'boolean' };
  if (field.kind === 'list') return { kind: 'array', maxItems: field.maxItems ?? 32, item: fieldSchema(field.item!) };
  if (field.kind === 'form') return { kind: 'object', fields: Object.fromEntries(field.fields!.map(child => [child.id, fieldSchema(child)])), required: field.fields!.filter(child => child.required).map(child => child.id) };
  return { kind: 'json', maxDepth: 8, maxEntries: 2048, maxBytes: 24000 };
}
function publicFieldRules(field: S2Field): S2PublicFieldRules {
  const rules: S2PublicFieldRules = { kind: field.kind, required: field.required === true };
  if (['text', 'multiline', 'code'].includes(field.kind)) rules.maxLength = field.maxLength ?? 6000;
  if (field.kind === 'enum') rules.options = [...field.options!];
  if (field.kind === 'number') {
    rules.integer = field.integer === true;
    if (field.min !== undefined) rules.min = field.min;
    if (field.max !== undefined) rules.max = field.max;
  }
  if (field.kind === 'list' || field.kind === 'table') {
    rules.minItems = field.minItems ?? 0; rules.maxItems = field.maxItems ?? 32;
  }
  if (field.kind === 'list') rules.item = publicFieldRules(field.item!);
  if (field.kind === 'form') {
    rules.additionalProperties = false;
    rules.fields = field.fields!.map(child => ({ id: child.id, label: child.label, ...publicFieldRules(child) }));
  }
  if (field.kind === 'json' || field.kind === 'table') rules.structured = { maxDepth: 8, maxEntries: 2048, maxBytes: 24000 };
  if (field.kind === 'table') {
    rules.additionalProperties = false; rules.cellMaxBytes = 2000;
    rules.columns = field.columns!.map(column => ({ id: column.id, label: column.label, type: column.type,
      required: column.required === true, nullable: column.nullable === true }));
  }
  return rules;
}
function encodeField(field: S2Field, value: S2Json): string {
  const encoded = value === '' ? '' : ['text', 'multiline', 'enum', 'code'].includes(field.kind)
    ? typeof value === 'string' ? value : fail('PUBLIC_PARAMETER_TYPE', `/values/${field.id}`, '此内容字段需要文字') : JSON.stringify(value);
  return validateS2FieldText(field, encoded);
}
/** Safe public diagnosis based only on the declared value kind. Never expose a
 * nested validator's implementation error, private defaults, stack or data. */
function parameterValueReason(rule: S2Field | S2ValueSchema, value: S2Json): string {
  const kind = rule.kind;
  if (kind === 'number' && typeof value !== 'number') return '需要数字';
  if (rule.kind === 'number' && typeof value === 'number') {
    if (rule.integer && !Number.isSafeInteger(value)) return '需要安全整数';
    const min = 'minimum' in rule ? rule.minimum : rule.min;
    const max = 'maximum' in rule ? rule.maximum : rule.max;
    if (min !== undefined && value < min || max !== undefined && value > max) return '数值不符合公开范围';
  }
  if (kind === 'boolean' && typeof value !== 'boolean') return '需要布尔值';
  if (['text', 'multiline', 'code', 'enum', 'string'].includes(kind) && typeof value !== 'string') return '需要字符串';
  if (['list', 'table', 'array'].includes(kind) && !Array.isArray(value)) return '需要数组';
  if (['form', 'object'].includes(kind) && (!value || typeof value !== 'object' || Array.isArray(value))) return '需要对象';
  return '参数值不符合公开取值规则';
}
function decodeField(field: S2Field, value: string): S2Json {
  if (value === '' || ['text', 'multiline', 'enum', 'code'].includes(field.kind)) return value;
  return JSON.parse(value) as S2Json;
}
function contentDefault(component: ScenePackPublicComponent, field: S2Field): string {
  return Object.hasOwn(component.defaults ?? {}, field.id) ? encodeField(field, component.defaults![field.id]) : s2DefaultFieldText(field);
}
function componentCapability(component: ScenePackPublicComponent) {
  if (component.implementation.kind !== 'capability') fail('PUBLIC_COMPONENT_KIND', component.id, '内容块没有执行能力');
  return s2BuiltinPluginRegistry().capability(component.implementation);
}
function isInternal(pack: SceneInteractionPack, nodeId: string): boolean {
  const document = pack.authoring?.internal?.document;
  return !!document && [...document.nodes, ...(document.execution?.nodes ?? [])].some(node => node.id === nodeId);
}
function matchesImplementation(component: ScenePackPublicComponent, node: S2Block | S2WorkflowNode) {
  const implementation = component.implementation;
  return implementation.kind === 'content' ? 'type' in node && node.type === implementation.blockType.id
    : 'pluginId' in node && s2CapabilityKey(node) === s2CapabilityKey(implementation);
}
function checkNode(component: ScenePackPublicComponent, node: S2Block | S2WorkflowNode) {
  if (component.implementation.kind === 'content') {
    if (!('values' in node)) fail('PUBLIC_COMPONENT_KIND', node.id, '组件种类不一致');
    for (const field of component.implementation.blockType.fields) {
      if (!component.parameters.includes(field.id) && node.values[field.id] !== contentDefault(component, field)) fail('PUBLIC_PARAMETER_PRIVATE', `${node.id}/${field.id}`, '未公开的内容字段不能修改');
    }
  } else {
    if (!('bindings' in node)) fail('PUBLIC_COMPONENT_KIND', node.id, '组件种类不一致');
    if (node.when) fail('PUBLIC_CONDITION_PRIVATE', node.id, '公开目录未提供条件编辑接口');
    for (const [port, binding] of Object.entries(node.bindings)) {
      if (binding.kind === 'literal') {
        if (!component.parameters.includes(port) && (!Object.hasOwn(component.defaults ?? {}, port) || !same(binding.value, component.defaults![port]))) fail('PUBLIC_PARAMETER_PRIVATE', `${node.id}/${port}`, '未公开的参数只能保留包内固定值');
      } else if (!component.inputs.includes(port)) fail('PUBLIC_PORT_PRIVATE', `${node.id}/${port}`, '此输入端口未公开');
    }
    for (const [port, value] of Object.entries(component.defaults ?? {})) if (!component.parameters.includes(port) && !component.inputs.includes(port)
      && (!node.bindings[port] || node.bindings[port].kind !== 'literal' || !same((node.bindings[port] as { value: S2Json }).value, value))) fail('PUBLIC_PARAMETER_PRIVATE', `${node.id}/${port}`, '不能删除或替换包内固定参数');
    if (node.presentation) {
      for (const port of Object.keys(node.presentation.inputs ?? {})) if (!component.inputs.includes(port) && !component.parameters.includes(port)) fail('PUBLIC_PORT_PRIVATE', `${node.id}/presentation/inputs/${port}`, '未公开的输入不能新增配置界面');
      for (const port of Object.keys(node.presentation.outputs ?? {})) if (!component.outputs.includes(port)) fail('PUBLIC_PORT_PRIVATE', `${node.id}/presentation/outputs/${port}`, '未公开的输出不能新增配置界面');
      for (const port of Object.keys(node.presentation.inputForms ?? {})) if (!component.parameters.includes(port)) fail('PUBLIC_PARAMETER_PRIVATE', `${node.id}/presentation/inputForms/${port}`, '未公开的参数不能新增编辑界面');
      if (node.presentation.responseForm) fail('PUBLIC_PARAMETER_PRIVATE', `${node.id}/presentation/responseForm`, '目录未公开人工回答配置');
    }
  }
}
/** Local implementation lookup only. Internal ownership always takes precedence over matching types. */
export function findS2PublicComponent(pack: SceneInteractionPack, node: S2Block | S2WorkflowNode, document?: S2Document): ScenePackPublicComponent | undefined {
  if (!pack.authoring || isInternal(pack, node.id)) return undefined;
  const candidates = pack.authoring.components.filter(component => node.componentId === undefined || component.id === node.componentId)
    .filter(component => matchesImplementation(component, node)).filter(component => {
    try {
      checkNode(component, node);
      if (document) {
        if ((document.execution?.links ?? []).some(link => link.source.nodeId === node.id && !component.outputs.includes(link.source.portId)
          || link.target.nodeId === node.id && !component.inputs.includes(link.target.portId))) return false;
        if ((document.execution?.nodes ?? []).some(target => Object.values(target.bindings).some(binding => binding.kind === 'field' && binding.nodeId === node.id && !component.outputs.includes(binding.fieldId)))) return false;
      }
      return true;
    } catch { return false; }
  });
  // An explicit identity is a checked declaration, never a label-based override
  // or permission marker. In particular, an invalid one cannot fall back.
  if (node.componentId !== undefined || candidates.length < 2) return candidates[0];
  const label = 'type' in node ? node.label : node.presentation?.label;
  const named = candidates.filter(component => component.label === label);
  if (named.length === 1) return named[0];
  return fail('PUBLIC_COMPONENT_AMBIGUOUS', `/nodes/${node.id}/componentId`, '历史节点对应多个公开组件，需要明确组件身份；原数据未修改');
}
/** One shared, implementation-free catalogue for menu and progressive Agent discovery. */
export function publicS2Catalog(pack: SceneInteractionPack): S2PublicComponentCatalog | undefined {
  if (!pack.authoring) return undefined;
  return { version: 1, components: pack.authoring.components.map(component => {
    const common = { id: component.id, label: component.label, purpose: component.purpose, ...(component.group ? { group: structuredClone(component.group) } : {}) };
    if (component.implementation.kind === 'content') {
      const fields = component.implementation.blockType.fields;
      return { ...common, inputs: [], outputs: component.outputs.map(portId => {
        const field = fields.find(field => field.id === portId)!;
        return { id: field.id, label: field.label, meaning: `${field.label}原文`, type: { id: 'core.text', version: 1 }, required: false, multiple: false };
      }), parameters: component.parameters.map(portId => {
        const field = fields.find(field => field.id === portId)!;
        return { id: field.id, label: field.label, type: { id: ['text', 'multiline', 'enum', 'code'].includes(field.kind) ? 'core.text' : field.kind === 'number' ? 'core.number' : 'structured-data.value', version: 1 },
          schema: fieldSchema(field), field: { ...publicFieldRules(field), serializedMaxLength: 6000 }, required: field.required === true, allowBlank: true,
          ...(Object.hasOwn(component.defaults ?? {}, field.id) ? { default: structuredClone(component.defaults![field.id]) } : field.defaultValue !== undefined ? { default: structuredClone(field.defaultValue) } : {}) };
      }) };
    }
    const capability = componentCapability(component), registry = s2BuiltinPluginRegistry();
    return { ...common, inputs: capability.inputs.filter(port => component.inputs.includes(port.id)).map(port => structuredClone(port)),
      outputs: capability.outputs.filter(port => component.outputs.includes(port.id)).map(port => structuredClone(port)),
      parameters: component.parameters.map(id => {
        const port = capability.inputs.find(port => port.id === id)!;
        const dataType = registry.dataType(port.type);
        return { id, label: port.label, meaning: port.meaning, ...(dataType.meaning !== port.meaning ? { typeMeaning: dataType.meaning } : {}),
          type: structuredClone(port.type), schema: structuredClone(dataType.schema), required: port.required,
          ...(Object.hasOwn(component.defaults ?? {}, id) ? { default: structuredClone(component.defaults![id]) } : {}) };
      }) };
  }) };
}
function authoringTypes(pack: SceneInteractionPack): S2BlockType[] {
  const types = [...(pack.authoring?.internal?.blockTypes ?? []), ...(pack.authoring?.components.flatMap(component => component.implementation.kind === 'content' ? [component.implementation.blockType] : []) ?? [])];
  const unique = new Map<string, S2BlockType>();
  for (const type of types) {
    const previous = unique.get(type.id);
    if (previous && !same(typeConstraint(previous), typeConstraint(type))) fail('PUBLIC_TYPE_CONFLICT', type.id, '相同内容类型的约束不一致');
    if (!previous) unique.set(type.id, structuredClone(type));
  }
  // The unchanged native S2 grammar requires a content type even for an empty/closed canvas.
  return unique.size ? [...unique.values()] : [{ id: 'text', label: '说明', fields: [{ id: 'content', label: '内容', kind: 'multiline' }] }];
}
function authoringPlugins(pack: SceneInteractionPack): NonNullable<S2CanvasDefinition['plugins']> {
  const refs = [
    ...pack.capabilities.flatMap(plugin => plugin.capabilities.filter(capability => capability.kind !== 'editor').map(capability => ({ pluginId: plugin.id, pluginVersion: plugin.version, capabilityId: capability.id }))),
    ...(pack.authoring?.components.flatMap(component => component.implementation.kind === 'capability' ? [{ pluginId: component.implementation.pluginId, pluginVersion: component.implementation.pluginVersion, capabilityId: component.implementation.capabilityId }] : []) ?? []),
    ...(pack.authoring?.internal?.document.execution?.nodes ?? []).map(({ pluginId, pluginVersion, capabilityId }) => ({ pluginId, pluginVersion, capabilityId })),
  ];
  return [...new Map(refs.map(ref => [s2CapabilityKey(ref), ref])).values()];
}
function fieldConstraint(field: S2Field): unknown {
  const { label: _label, defaultValue: _default, ...rest } = field;
  return { ...rest, required: field.required === true,
    ...(['text', 'multiline', 'code'].includes(field.kind) ? { maxLength: field.maxLength ?? 6000 } : {}),
    ...(field.kind === 'number' ? { integer: field.integer === true } : {}),
    ...(field.kind === 'list' || field.kind === 'table' ? { minItems: field.minItems ?? 0, maxItems: field.maxItems ?? 32 } : {}),
    ...(field.item ? { item: fieldConstraint(field.item) } : {}),
    ...(field.fields ? { fields: field.fields.map(fieldConstraint) } : {}),
    ...(field.columns ? { columns: field.columns.map(({ label: _label, ...column }) => column) } : {}) };
}
function typeConstraint(type: S2BlockType) { return { id: type.id, fields: type.fields.map(fieldConstraint) }; }
function nativeConfig(pack: SceneInteractionPack, definition: S2CanvasDefinition, document: S2Document): ScenePackConfig {
  const checked = readS2Definition(data(definition)), current = readS2Document(data(document), checked);
  const types = new Map(authoringTypes(pack).map(type => [type.id, type]));
  for (const type of checked.blockTypes) if (!types.has(type.id) || !same(typeConstraint(type), typeConstraint(types.get(type.id)!))) fail('PUBLIC_DEFINITION_PRIVATE', `/blockTypes/${type.id}`, '场景不能增加类型或重定义包内字段约束');
  const allowed = new Set(authoringPlugins(pack).map(s2CapabilityKey));
  if (checked.plugins?.some(ref => !allowed.has(s2CapabilityKey(ref)))) fail('PUBLIC_DEFINITION_PRIVATE', '/plugins', '场景不能增加目录以外的运行实现');
  checkNativeDocument(pack, checked.initial); checkNativeDocument(pack, current);
  return { definition: checked, document: current };
}
function linkKey(link: S2ExecutionLink) { return stable(link); }
function checkNativeDocument(pack: SceneInteractionPack, document: S2Document): void {
  const internal = pack.authoring!.internal?.document ?? { nodes: [], edges: [] };
  const internalNodes = [...internal.nodes, ...(internal.execution?.nodes ?? [])], owned = new Set(internalNodes.map(node => node.id));
  const internalIdentities = new Set([...owned, ...(internal.groups ?? []).map(group => group.id), ...(internal.composites ?? []).map(composite => composite.id)]);
  const all = [...document.nodes, ...(document.execution?.nodes ?? [])];
  for (const original of internalNodes) if (!same(original, all.find(node => node.id === original.id))) fail('PUBLIC_INTERNAL_IMMUTABLE', `/nodes/${original.id}`, '包内实例不能删除、移动、替换或修改');
  const components = new Map<string, ScenePackPublicComponent>();
  for (const node of all) if (!owned.has(node.id)) {
    if (internalIdentities.has(node.id)) fail('PUBLIC_INTERNAL_IMMUTABLE', `/nodes/${node.id}`, '公开实例不能遮蔽包内分组或组合标识');
    const component = findS2PublicComponent(pack, node, document);
    if (!component) fail('PUBLIC_COMPONENT_PRIVATE', `/nodes/${node.id}`, '节点未对应公开组件，或修改了未公开参数/条件');
    checkNode(component, node); components.set(node.id, component);
  }
  const internalEdges = document.edges.filter(edge => owned.has(edge.source) || owned.has(edge.target));
  if (!same(internalEdges, internal.edges)) fail('PUBLIC_INTERNAL_IMMUTABLE', '/edges', '包内关联连接不能改变');
  const internalLinks = (document.execution?.links ?? []).filter(link => owned.has(link.source.nodeId) || owned.has(link.target.nodeId));
  if (!same(internalLinks, internal.execution?.links ?? [])) fail('PUBLIC_INTERNAL_IMMUTABLE', '/execution/links', '包内数据连接不能改变或接入未公开端口');
  const sourcePort = (nodeId: string, portId: string) => {
    const source = components.get(nodeId);
    if (!source || !source.outputs.includes(portId)) fail('PUBLIC_PORT_PRIVATE', `/nodes/${nodeId}/outputs/${portId}`, '此来源端口未公开');
  };
  const targetPort = (nodeId: string, portId: string) => {
    const target = components.get(nodeId);
    if (!target || !target.inputs.includes(portId)) fail('PUBLIC_PORT_PRIVATE', `/nodes/${nodeId}/inputs/${portId}`, '此目标端口未公开');
  };
  for (const node of document.execution?.nodes ?? []) if (!owned.has(node.id)) for (const [portId, binding] of Object.entries(node.bindings)) if (binding.kind === 'field') {
    targetPort(node.id, portId); sourcePort(binding.nodeId, binding.fieldId);
  }
  for (const link of document.execution?.links ?? []) if (!owned.has(link.source.nodeId) && !owned.has(link.target.nodeId)) {
    sourcePort(link.source.nodeId, link.source.portId); targetPort(link.target.nodeId, link.target.portId);
  }
  for (const group of document.groups ?? []) {
    const original = internal.groups?.find(item => item.id === group.id);
    if (original ? !same(original, group) : internalIdentities.has(group.id) || group.nodeIds.some(id => owned.has(id))) fail('PUBLIC_INTERNAL_IMMUTABLE', `/groups/${group.id}`, '分组不能改变内部实例的归属或展示');
  }
  for (const original of internal.groups ?? []) if (!same(original, document.groups?.find(group => group.id === original.id))) fail('PUBLIC_INTERNAL_IMMUTABLE', `/groups/${original.id}`, '不能移除包内分组');
  for (const composite of document.composites ?? []) {
    const original = internal.composites?.find(item => item.id === composite.id);
    if (original ? !same(original, composite) : internalIdentities.has(composite.id) || composite.blueprint || composite.nodeIds.some(id => owned.has(id))) fail('PUBLIC_INTERNAL_IMMUTABLE', `/composites/${composite.id}`, '公开组合不能展开内部图或改变内部实例');
  }
  for (const original of internal.composites ?? []) if (!same(original, document.composites?.find(composite => composite.id === original.id))) fail('PUBLIC_INTERNAL_IMMUTABLE', `/composites/${original.id}`, '不能移除包内组合');
  if (!same(document.blueprints ?? [], internal.blueprints ?? [])) fail('PUBLIC_BLUEPRINT_PRIVATE', '/blueprints', '本版公开接口不接受内部蓝图展开或替换');
}
/** Validate the complete resulting native graph, never an individual UI intention or untrusted marker. */
export function assertS2PublicEdit(pack: SceneInteractionPack, before: ScenePackConfig, after: ScenePackConfig,
  readOnlyBaseline: Pick<S2Document, 'nodes'> = before.definition.initial): void {
  if (!pack.authoring) return; // Explicit legacy adapter: only omission has this meaning.
  if (!same(before.definition.business, after.definition.business) || !same(before.definition.criteria, after.definition.criteria))
    fail('PUBLIC_DEFINITION_PRIVATE', '/business', '本版公开搭建接口不修改业务执行参照图或评价定义；已有记录须保留原样');
  const checked = nativeConfig(pack, after.definition, after.document);
  assertS2ReadOnlyContent(readOnlyBaseline, checked.document, { requirePresence: true });
  assertS2ReadOnlyContent(before.document, checked.document);
}
/** Native saved-scene compatibility projection. Hidden instances and implementation identities never enter it. */
export function projectS2PublicCanvas(pack: SceneInteractionPack, definition: S2CanvasDefinition, document: S2Document): S2PublicCanvas {
  if (!pack.authoring) fail('PUBLIC_LEGACY', '/', '此包使用旧版搭建接口');
  const checked = nativeConfig(pack, definition, document), all = [...checked.document.nodes, ...(checked.document.execution?.nodes ?? [])];
  const nodes: S2PublicCanvas['nodes'] = all.filter(node => !isInternal(pack, node.id)).map(node => {
    const component = findS2PublicComponent(pack, node, checked.document)!;
    const values: Record<string, S2Json> = {};
    if ('values' in node && component.implementation.kind === 'content') for (const field of component.implementation.blockType.fields) if (component.parameters.includes(field.id)) values[field.id] = decodeField(field, node.values[field.id]);
    if ('bindings' in node) for (const [port, binding] of Object.entries(node.bindings)) if (binding.kind === 'literal' && component.parameters.includes(port)) values[port] = structuredClone(binding.value);
    const label = 'values' in node ? node.label : node.presentation?.label;
    return { id: node.id, componentId: component.id, position: structuredClone(node.position), ...(label !== undefined ? { label } : {}),
      ...('values' in node && node.readOnly !== undefined ? { readOnly: node.readOnly } : {}), values };
  });
  const visible = new Set(nodes.map(node => node.id));
  const connections = (checked.document.execution?.links ?? []).filter(link => visible.has(link.source.nodeId) && visible.has(link.target.nodeId)).map(link => structuredClone(link));
  for (const node of checked.document.execution?.nodes ?? []) if (visible.has(node.id)) for (const [port, binding] of Object.entries(node.bindings)) if (binding.kind === 'field') connections.push({ source: { nodeId: binding.nodeId, portId: binding.fieldId }, target: { nodeId: node.id, portId: port } });
  return { version: 1, nodes, connections };
}
/** Local compiler used identically by user controls and building Agents. No runtime or model invocation. */
export function compileS2PublicCanvas(pack: SceneInteractionPack, raw: unknown,
  options: { goal: string; instructions?: S2CanvasDefinition['instructions'] }): ScenePackConfig {
  if (!pack.authoring) fail('PUBLIC_LEGACY', '/', '此包使用旧版搭建接口');
  const value = object(data(raw), ['version', 'nodes', 'connections'], '/');
  if (value.version !== 1) fail('PUBLIC_VERSION', '/version', '仅支持公开画布版本 1');
  const document: S2Document = structuredClone(pack.authoring.internal?.document ?? { nodes: [], edges: [] });
  const occupied = new Set([...document.nodes, ...(document.execution?.nodes ?? []), ...(document.groups ?? []), ...(document.composites ?? [])].map(item => item.id));
  const publicNodes = new Map<string, { node: S2Block | S2WorkflowNode; component: ScenePackPublicComponent }>();
  for (const [index, item] of list(value.nodes, 80, '/nodes').entries()) {
    const path = `/nodes/${index}`, node = object(item, ['id', 'componentId', 'position', 'label', 'readOnly', 'values'], path);
    const nodeId = id(node.id, path + '/id'), componentId = id(node.componentId, path + '/componentId');
    if (occupied.has(nodeId)) fail('PUBLIC_INSTANCE_COLLISION', path + '/id', '不能使用内部实例或重复的标识');
    occupied.add(nodeId);
    const component = pack.authoring.components.find(component => component.id === componentId);
    if (!component) fail('PUBLIC_COMPONENT_PRIVATE', path + '/componentId', '组件没有公开，不能通过内部实现标识添加');
    const position = object(node.position, ['x', 'y'], path + '/position');
    if (![position.x, position.y].every(item => typeof item === 'number' && Number.isFinite(item) && Math.abs(item) <= 100000)) fail('PUBLIC_POSITION', path + '/position', '位置必须是有界坐标');
    const nodeValues = node.values === undefined ? undefined : object(node.values, component.parameters, path + '/values');
    const label = node.label === undefined ? component.label : text(node.label, 80, path + '/label', true);
    if (node.readOnly !== undefined && typeof node.readOnly !== 'boolean') fail('PUBLIC_DATA', path + '/readOnly', '需要布尔值');
    const implementation = component.implementation;
    if (implementation.kind === 'content') {
      const values = Object.fromEntries(implementation.blockType.fields.map(field => {
        if (nodeValues && Object.hasOwn(nodeValues, field.id)) {
          try { return [field.id, encodeField(field, nodeValues[field.id])]; }
          catch { return fail('PUBLIC_PARAMETER_VALUE', `${path}/values/${field.id}`, parameterValueReason(field, nodeValues[field.id])); }
        }
        return [field.id, component.parameters.includes(field.id) && nodeValues !== undefined ? '' : contentDefault(component, field)];
      }));
      const native: S2Block = { id: nodeId, type: implementation.blockType.id, componentId: component.id, label, position: { x: position.x, y: position.y }, values,
        ...(node.readOnly !== undefined ? { readOnly: node.readOnly } : {}) };
      document.nodes.push(native); publicNodes.set(nodeId, { node: native, component });
    } else {
      if (node.readOnly !== undefined) fail('PUBLIC_FIELD', path + '/readOnly', '只有内容实例支持内容只读配置');
      const defaults = Object.fromEntries(Object.entries(component.defaults ?? {}).filter(([port]) => !component.parameters.includes(port) || nodeValues === undefined));
      const literalValues = { ...defaults, ...(nodeValues ?? {}) }, capability = componentCapability(component), registry = s2BuiltinPluginRegistry();
      for (const [portId, data] of Object.entries(literalValues)) {
        const port = capability.inputs.find(port => port.id === portId)!;
        try {
          readS2Artifact(registry, { protocolVersion: 1, id: 'PublicValidation', type: port.type, complete: true,
            source: { sceneId: 'public-authoring', runId: 'validation', nodeId, revision: 0, kind: 'host' }, payload: { kind: 'inline', value: data } });
        } catch (error) {
          if (!nodeValues || !Object.hasOwn(nodeValues, portId)) throw error;
          fail('PUBLIC_PARAMETER_TYPE', `${path}/values/${portId}`, parameterValueReason(registry.dataType(port.type).schema, data));
        }
      }
      const native: S2WorkflowNode = { id: nodeId, componentId: component.id, pluginId: implementation.pluginId, pluginVersion: implementation.pluginVersion, capabilityId: implementation.capabilityId,
        position: { x: position.x, y: position.y }, bindings: Object.fromEntries(Object.entries(literalValues).map(([port, value]) => [port, { kind: 'literal' as const, value: structuredClone(value) }])), presentation: { label } };
      document.execution ??= { version: 1, nodes: [], links: [] }; document.execution.nodes.push(native); publicNodes.set(nodeId, { node: native, component });
    }
  }
  const connections = new Set<string>(), incoming = new Map<string, number>(), children = new Map<string, string[]>();
  for (const [index, item] of list(value.connections, 80, '/connections').entries()) {
    const path = `/connections/${index}`, link = object(item, ['source', 'target'], path);
    const source = object(link.source, ['nodeId', 'portId'], path + '/source'), target = object(link.target, ['nodeId', 'portId'], path + '/target');
    const sourceId = id(source.nodeId, path + '/source/nodeId'), sourcePort = id(source.portId, path + '/source/portId');
    const targetId = id(target.nodeId, path + '/target/nodeId'), targetPort = id(target.portId, path + '/target/portId');
    const from = publicNodes.get(sourceId), to = publicNodes.get(targetId);
    if (!from || !to || !from.component.outputs.includes(sourcePort) || !to.component.inputs.includes(targetPort) || !('bindings' in to.node)) fail('PUBLIC_PORT_PRIVATE', path, '只能连接公开实例的公开输入和输出');
    const native: S2ExecutionLink = { source: { nodeId: sourceId, portId: sourcePort }, target: { nodeId: targetId, portId: targetPort } };
    const key = linkKey(native); if (connections.has(key)) fail('PUBLIC_CONNECTION_DUPLICATE', path, '连线不能重复'); connections.add(key);
    const targetDescriptor = componentCapability(to.component).inputs.find(port => port.id === targetPort)!;
    const sourceDescriptor = 'values' in from.node ? undefined : componentCapability(from.component).outputs.find(port => port.id === sourcePort)!;
    const sourceType = sourceDescriptor?.type ?? { id: 'core.text', version: 1 };
    if (!s2BuiltinPluginRegistry().compatible(sourceType, targetDescriptor.type)
      || sourceDescriptor && (sourceDescriptor.multiple && !targetDescriptor.multiple || targetDescriptor.required && !sourceDescriptor.required))
      fail('PUBLIC_CONNECTION_TYPE', path, '连接两端的公开类型、版本、必填和多值约定必须匹配');
    if (Object.hasOwn(to.node.bindings, targetPort)) {
      // A connectable input may have a developer fallback, without exposing its
      // literal editor. An explicit wire replaces only that fixed fallback.
      const binding = to.node.bindings[targetPort];
      if (!to.component.parameters.includes(targetPort) && binding.kind === 'literal' && Object.hasOwn(to.component.defaults ?? {}, targetPort)
        && same(binding.value, to.component.defaults![targetPort])) delete to.node.bindings[targetPort];
      else if (!targetDescriptor.multiple || 'values' in from.node) fail('PUBLIC_INPUT_CONFLICT', path, '连接不能覆盖已填写的参数；多个内容字段须先通过公开组装组件合成');
    }
    const inputKey = JSON.stringify([targetId, targetPort]);
    const count = (incoming.get(inputKey) ?? (Object.hasOwn(to.node.bindings, targetPort) ? 1 : 0)) + 1;
    if (!targetDescriptor.multiple && count > 1 || count > 32)
      fail('PUBLIC_CONNECTION_CARDINALITY', path, '单路输入只能有一个来源，多路输入最多32个来源');
    incoming.set(inputKey, count);
    // Only the public candidate is inspected here. Package-owned dependencies
    // remain the native validator's responsibility and are never diagnosed back.
    const pending = [targetId], visited = new Set<string>();
    while (pending.length) {
      const next = pending.pop()!;
      if (next === sourceId) fail('PUBLIC_CONNECTION_CYCLE', path, '执行依赖不能形成环');
      if (visited.has(next)) continue;
      visited.add(next); pending.push(...(children.get(next) ?? []));
    }
    children.set(sourceId, [...(children.get(sourceId) ?? []), targetId]);
    if ('values' in from.node) to.node.bindings[targetPort] = { kind: 'field', nodeId: sourceId, fieldId: sourcePort };
    else document.execution!.links.push(native);
  }
  const definition = readS2Definition({ version: 1, goal: text(options.goal, 2000, '/goal'),
    instructions: options.instructions ?? { understanding: '理解当前任务', planning: '按公开组件搭建与连接', response: '依据实际输入和结果交互' },
    blockTypes: authoringTypes(pack), plugins: authoringPlugins(pack), initial: document });
  return nativeConfig(pack, definition, definition.initial);
}
