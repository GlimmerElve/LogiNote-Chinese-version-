import type { S2CompositeBlueprint, S2CompositeCapability, S2CompositeEndpoint, S2CompositeExpansion, S2CompositeValues } from '../../types/sceneS2Composite';
import type { S2Json, S2PluginPort, S2TypeRef } from '../../types/sceneS2Plugin';
import { canonicalS2Json, readS2Artifact } from './sceneS2PluginProtocol';
import { readS2PluginBindings, s2BuiltinPluginRegistry, s2CapabilityKey } from './sceneS2PluginRegistry';
import { readS2Workflow } from './sceneS2Workflow';

export const S2_COMPOSITE_MAX_BYTES = 128000;
// A fragment must fit the existing 64000-character canvas; the caller still validates the whole outer document atomically.
export const S2_COMPOSITE_MAX_EXPANDED_CHARS = 64000;
const registry = s2BuiltinPluginRegistry();
function fail(message: string): never { throw new Error(`S2 组合蓝图：${message}`); }

/** Validate inert dense JSON before cloning. Never invoke an untrusted getter, toJSON or executable descriptor. */
function snapshot<T>(raw: T, limits: { maxBytes?: number; maxEntries?: number } = {}): T {
  // Larger bounds are host-only for the already-larger full design envelope, never blueprint input fields.
  const maxBytes = limits.maxBytes ?? S2_COMPOSITE_MAX_BYTES, maxEntries = limits.maxEntries ?? 16000;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 786432 || !Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 48000) fail('宿主数据预算无效');
  const active = new Set<object>(); let entries = 0, bytes = 0;
  const spend = (text: string) => { bytes += new TextEncoder().encode(text).byteLength; if (bytes > maxBytes) fail(`完整数据超过${maxBytes}字节，不截断`); };
  const visit = (value: unknown, depth: number) => {
    if (++entries > maxEntries || depth > 24) fail('数据超过遍历或深度上限');
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'string') { if (value.length > 64000) fail('文本过大'); spend(value); return; }
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (!value || typeof value !== 'object') fail('仅接受完整 JSON 数据');
    if (active.has(value)) fail('不能含循环引用');
    active.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value), names = Reflect.ownKeys(descriptors);
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 2048 || names.length !== value.length + 1) fail('列表必须是有界稠密 JSON 数组');
      for (let i = 0; i < value.length; i++) {
        const d = descriptors[String(i)];
        if (!d || !Object.hasOwn(d, 'value') || !d.enumerable) fail('不能含访问器、空洞或隐藏字段');
        visit(d.value, depth + 1);
      }
    } else {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(value)) || names.length > 256) fail('需要普通有界 JSON 对象');
      for (const name of names) {
        if (typeof name !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(name)) fail('不能含符号或保留字段');
        spend(name);
        const d = descriptors[name];
        if (!Object.hasOwn(d, 'value') || !d.enumerable) fail('不能含访问器或隐藏字段');
        visit(d.value, depth + 1);
      }
    }
    active.delete(value);
  };
  visit(raw, 0);
  const text = JSON.stringify(raw);
  if (new TextEncoder().encode(text).byteLength > maxBytes) fail(`完整数据超过${maxBytes}字节，不截断`);
  return JSON.parse(text) as T;
}
export { snapshot as snapshotS2CompositeData };
function object(raw: unknown, keys: string[]): Record<string, any> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !keys.includes(key))) fail(`字段无效，仅允许 ${keys.join('、')}`);
  return raw as Record<string, any>;
}
function text(raw: unknown, max: number): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > max) fail('名称或说明为空或过长');
  return raw;
}
function id(raw: unknown): string {
  const result = text(raw, 64);
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(result) || ['constructor', 'prototype', '__proto__'].includes(result)) fail('标识无效');
  return result;
}
function array(raw: unknown, max = 16): any[] {
  if (!Array.isArray(raw) || raw.length > max) fail(`列表无效或超过${max}项`);
  return raw;
}
function unique(values: string[]) { if (new Set(values).size !== values.length) fail('公共标识或内部端点重复'); }
const endpointKey = (value: S2CompositeEndpoint) => JSON.stringify([value.nodeId, value.portId]);
function endpoint(raw: unknown): S2CompositeEndpoint {
  const value = object(raw, ['nodeId', 'portId']); return { nodeId: id(value.nodeId), portId: id(value.portId) };
}
function typeMatches(raw: unknown, port: S2PluginPort): S2TypeRef {
  const value = object(raw, ['id', 'version']);
  if (value.id !== port.type.id || value.version !== port.type.version) fail('公共端口类型或版本与真实内部端口不符');
  return { ...port.type };
}
function typedValue(port: S2PluginPort, value: unknown): asserts value is S2Json {
  readS2Artifact(registry, { protocolVersion: 1, id: 'CompositeValidation', type: port.type, complete: true,
    source: { sceneId: 'validation', runId: 'validation', nodeId: 'CompositeValidation', revision: 0, kind: 'host' }, payload: { kind: 'inline', value } });
}
/** Permission ceiling comes from the destination scene, never the blueprint's own plugin list. */
export function readS2CompositeBlueprint(raw: unknown, allowedPlugins: S2CompositeCapability[]): S2CompositeBlueprint {
  const value = object(snapshot(raw), ['format', 'protocolVersion', 'id', 'version', 'label', 'description', 'plugins', 'workflow', 'inputs', 'outputs', 'parameters']);
  if (value.format !== 's2-composite' || value.protocolVersion !== 1 || typeof value.version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value.version) || value.version.length > 32) fail('协议或精确发布版本无效');
  const plugins = readS2PluginBindings(value.plugins), allowed = new Set(readS2PluginBindings(snapshot(allowedPlugins)).map(s2CapabilityKey));
  if (plugins.some(plugin => !allowed.has(s2CapabilityKey(plugin)))) fail('需要本场景范围外的能力，不能通过蓝图扩权');
  const workflow = readS2Workflow(value.workflow, { nodes: [] }, plugins);
  if (!workflow.nodes.length) fail('内部执行图不能为空');
  const used = new Set(workflow.nodes.map(s2CapabilityKey));
  if (plugins.some(plugin => !used.has(s2CapabilityKey(plugin)))) fail('声明了内部未使用的能力');
  for (const node of workflow.nodes) {
    if (registry.capability(node).kind === 'editor') fail('编辑块应作为外部材料，不是内部执行器');
    if (['local-material', 'project-notes'].includes(node.pluginId) && Object.hasOwn(node.bindings, 'resource')) fail('蓝图不能携带本局资料句柄，请暴露资料输入并在本局重新选用');
  }
  const portAt = (target: S2CompositeEndpoint, direction: 'inputs' | 'outputs') => {
    const node = workflow.nodes.find(node => node.id === target.nodeId);
    const port = node && registry.capability(node)[direction].find(port => port.id === target.portId);
    if (!port) fail(`内部${direction === 'inputs' ? '输入' : '输出'}端点不存在：${target.nodeId}.${target.portId}`);
    return port;
  };
  const occupied = new Set<string>();
  const claimInput = (target: S2CompositeEndpoint) => {
    const key = endpointKey(target), node = workflow.nodes.find(node => node.id === target.nodeId);
    const port = portAt(target, 'inputs');
    if (occupied.has(key) || Object.hasOwn(node!.bindings, target.portId) || workflow.links.some(link => endpointKey(link.target) === key)) fail('公共输入或参数不能覆盖内部接线、固定值或其他公共映射');
    occupied.add(key); return port;
  };
  const inputs: S2CompositeBlueprint['inputs'] = array(value.inputs).map(raw => {
    const input = object(raw, ['id', 'label', 'type', 'required', 'multiple', 'targets']);
    const targets = array(input.targets, 40).map(endpoint); if (!targets.length) fail('公共输入必须映射真实端点');
    unique(targets.map(endpointKey)); const ports = targets.map(claimInput), first = ports[0];
    if (ports.some(port => port.type.id !== first.type.id || port.type.version !== first.type.version || port.multiple !== first.multiple)) fail('扇出输入的类型、版本和基数必须一致');
    if (input.required !== ports.some(port => port.required) || input.multiple !== first.multiple) fail('公共输入不能隐瞒必需性或基数');
    return { id: id(input.id), label: text(input.label, 80), type: typeMatches(input.type, first), required: input.required, multiple: input.multiple, targets };
  });
  const parameters: S2CompositeBlueprint['parameters'] = array(value.parameters).map(raw => {
    const parameter = object(raw, ['id', 'label', 'type', 'target', 'defaultValue']), target = endpoint(parameter.target), port = claimInput(target);
    if (port.multiple || ['local-material', 'project-notes'].includes(workflow.nodes.find(node => node.id === target.nodeId)!.pluginId) && target.portId === 'resource') fail('可调参数仅映射单值配置，资料必须走本局资料输入');
    if (Object.hasOwn(parameter, 'defaultValue')) typedValue(port, parameter.defaultValue);
    return { id: id(parameter.id), label: text(parameter.label, 80), type: typeMatches(parameter.type, port), target,
      ...(Object.hasOwn(parameter, 'defaultValue') ? { defaultValue: structuredClone(parameter.defaultValue) } : {}) };
  });
  unique([...inputs, ...parameters].map(item => item.id));
  const outputs: S2CompositeBlueprint['outputs'] = array(value.outputs).map(raw => {
    const output = object(raw, ['id', 'label', 'type', 'required', 'multiple', 'source']), source = endpoint(output.source), port = portAt(source, 'outputs');
    if (output.required !== port.required || output.multiple !== port.multiple) fail('公共输出不能隐瞒真实输出基数或必需性');
    return { id: id(output.id), label: text(output.label, 80), type: typeMatches(output.type, port), required: output.required, multiple: output.multiple, source };
  });
  unique(outputs.map(output => output.id)); unique(outputs.map(output => endpointKey(output.source)));
  for (const node of workflow.nodes) for (const port of registry.capability(node).inputs) {
    const target = { nodeId: node.id, portId: port.id };
    if (port.required && !Object.hasOwn(node.bindings, port.id) && !workflow.links.some(link => endpointKey(link.target) === endpointKey(target)) && !occupied.has(endpointKey(target))) fail(`必需输入未接线或暴露：${node.id}.${port.id}`);
  }
  return { format: 's2-composite', protocolVersion: 1, id: id(value.id), version: value.version, label: text(value.label, 80), description: text(value.description, 1000), plugins, workflow, inputs, outputs, parameters };
}

export function exportS2CompositeBlueprint(raw: unknown, allowedPlugins: S2CompositeCapability[]): string {
  return JSON.stringify(readS2CompositeBlueprint(raw, allowedPlugins));
}
export function importS2CompositeBlueprint(text: string, allowedPlugins: S2CompositeCapability[]): S2CompositeBlueprint {
  if (typeof text !== 'string' || text.length > S2_COMPOSITE_MAX_BYTES) fail('蓝图文件过大');
  return readS2CompositeBlueprint(JSON.parse(text), allowedPlugins);
}

/** No registration, mutation, authorization or execution. Existing Host validates the expanded real nodes. */
export function expandS2Composite(raw: unknown, allowedPlugins: S2CompositeCapability[], rawValues: S2CompositeValues = {}, instanceKey?: string): S2CompositeExpansion {
  if (instanceKey !== undefined && (typeof instanceKey !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(instanceKey))) fail('实例标识无效');
  const blueprint = readS2CompositeBlueprint(raw, allowedPlugins);
  const values = object(snapshot(rawValues), ['inputs', 'parameters', 'position']);
  const inputValues = object(Object.hasOwn(values, 'inputs') ? values.inputs : {}, blueprint.inputs.map(port => port.id));
  const parameters = object(Object.hasOwn(values, 'parameters') ? values.parameters : {}, blueprint.parameters.map(port => port.id));
  const position = object(Object.hasOwn(values, 'position') ? values.position : { x: 0, y: 0 }, ['x', 'y']);
  if (![position.x, position.y].every(value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 100000)) fail('实例位置无效');
  const workflow = structuredClone(blueprint.workflow), mapping = new Map(workflow.nodes.map((node, index) => [node.id, instanceKey ? `node-${instanceKey}-n${index}` : `node-${crypto.randomUUID()}`]));
  const mapped = (endpoint: S2CompositeEndpoint) => ({ ...endpoint, nodeId: mapping.get(endpoint.nodeId)! });
  const bind = (target: S2CompositeEndpoint, value: unknown) => {
    const node = workflow.nodes.find(node => node.id === target.nodeId)!, port = registry.capability(node).inputs.find(port => port.id === target.portId)!;
    typedValue(port, value); node.bindings[port.id] = { kind: 'literal', value: structuredClone(value) };
  };
  for (const input of blueprint.inputs) if (Object.hasOwn(inputValues, input.id)) for (const target of input.targets) bind(target, inputValues[input.id]);
  for (const parameter of blueprint.parameters) {
    if (Object.hasOwn(parameters, parameter.id)) bind(parameter.target, parameters[parameter.id]);
    else if (Object.hasOwn(parameter, 'defaultValue')) bind(parameter.target, parameter.defaultValue);
  }
  for (const node of workflow.nodes) {
    node.id = mapping.get(node.id)!; node.position = { x: node.position.x + position.x, y: node.position.y + position.y };
    if (node.when) node.when.nodeId = mapping.get(node.when.nodeId)!;
  }
  workflow.links = workflow.links.map(link => ({ source: mapped(link.source), target: mapped(link.target) }));
  const checked = readS2Workflow(workflow, { nodes: [] }, allowedPlugins);
  if (JSON.stringify(checked).length > S2_COMPOSITE_MAX_EXPANDED_CHARS) fail('展开后的执行图超过64000字，未生成部分实例');
  return { instanceId: `composite-${instanceKey ?? crypto.randomUUID()}`, blueprint: { id: blueprint.id, version: blueprint.version, label: blueprint.label }, workflow: checked,
    sourceMap: [...mapping].map(([localNodeId, nodeId]) => ({ localNodeId, nodeId })),
    inputs: blueprint.inputs.map(input => ({ ...input, targets: input.targets.map(mapped) })),
    outputs: blueprint.outputs.map(output => ({ ...output, source: mapped(output.source) })),
    parameters: blueprint.parameters.map(parameter => ({ ...parameter, target: mapped(parameter.target) })) };
}

/** Exact compatibility signature for future library/version checks; not an authorization or acceptance certificate. */
export function s2CompositeSignature(raw: unknown, allowedPlugins: S2CompositeCapability[]): string {
  return canonicalS2Json(readS2CompositeBlueprint(raw, allowedPlugins) as unknown as S2Json);
}
