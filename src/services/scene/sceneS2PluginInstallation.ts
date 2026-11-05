import type { S2Json, S2PluginCapability, S2PluginInvocation, S2PluginManifest, S2PluginNode, S2PluginPort } from '../../types/sceneS2Plugin';
import { S2PluginProtocolError, S2PluginRegistry } from './sceneS2PluginProtocol';
import { isS2ModelSessionCapability, S2_MODEL_SESSION_BRIDGE } from './sceneS2ModelBridge';

export type S2LocalAdapter = (call: S2PluginInvocation, inputs: Record<string, S2Json[]>, signal: AbortSignal) => Promise<unknown>;
// Runtime functions registered by trusted terminal code only. JSON descriptions cannot acquire this mark.
const registeredAdapters = new WeakSet<S2LocalAdapter>();
export function registerScenePackLocalAdapter(adapter: S2LocalAdapter): S2LocalAdapter { registeredAdapters.add(adapter); return adapter; }
export function isRegisteredScenePackLocalAdapter(adapter: S2LocalAdapter) { return registeredAdapters.has(adapter); }
/** Reviewed application code only. A saved scene or model response can never supply this package. */
export type S2CapabilityImplementation =
  | { kind: 'local'; execute: S2LocalAdapter }
  | { kind: 'editor'; control: 'text' | 'multiline' }
  | { kind: 'renderer'; view: 'text' | 'json-tree' | 'table' | 'simulation'; portId: string }
  | { kind: 'human'; control: 'text' | 'json' | 'confirm' }
  | { kind: 'resource'; bridge: 'selected-text-file' | 'selected-project-note' | 'selected-image-file' }
  | { kind: 'model'; bridge: 'model-test-session' };
export interface S2PluginPackage { manifest: S2PluginManifest; implementations: Record<string, S2CapabilityImplementation> }
export type S2ImplementationDescriptor = { kind: 'local' } | Exclude<S2CapabilityImplementation, { kind: 'local' }>;
type CapabilityRef = Pick<S2PluginNode, 'pluginId' | 'pluginVersion' | 'capabilityId'>;
const key = (ref: CapabilityRef) => JSON.stringify([ref.pluginId, ref.pluginVersion, ref.capabilityId]);
const reserved = new Set(['__proto__', 'constructor', 'prototype']);
function fail(field: string, message: string): never { throw new S2PluginProtocolError('INVALID_IMPLEMENTATION', field, message); }

/** Inspect descriptors before reading values: registration must not execute getters or lose hidden data. */
function fields(raw: unknown, path: string, allowed?: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) fail(path, '注册项必须是显式普通数据对象');
  const result: Record<string, unknown> = Object.create(null);
  for (const name of Reflect.ownKeys(raw)) {
    if (typeof name !== 'string' || reserved.has(name) || allowed && !allowed.includes(name)) fail(path, '注册项含未知、符号或保留字段');
    const property = Object.getOwnPropertyDescriptor(raw, name)!;
    if (!property.enumerable || !('value' in property)) fail(`${path}.${name}`, '注册项不能含访问器或隐藏字段');
    result[name] = property.value;
  }
  return result;
}
function denseArray(raw: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype || raw.length > max) fail(path, '注册数组类型或数量无效');
  const properties = Object.getOwnPropertyDescriptors(raw);
  if (Reflect.ownKeys(raw).length !== raw.length + 1) fail(path, '数组必须连续且不能含额外字段');
  const result: unknown[] = [];
  for (let i = 0; i < raw.length; i++) {
    const property = properties[String(i)];
    if (!property || !property.enumerable || !('value' in property)) fail(`${path}.${i}`, '数组不能稀疏或含访问器');
    result.push(property.value);
  }
  return result;
}
function snapshot(raw: unknown, path: string, registration = true): S2Json {
  let entries = 0;
  const visit = (value: unknown, location: string, depth: number): S2Json => {
    if (++entries > 32768 && registration || depth > 20) fail(location, '数据超过有界快照限制');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value as null | string | boolean;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (Array.isArray(value)) return denseArray(value, location, 2048).map((item, i) => visit(item, `${location}.${i}`, depth + 1));
    return Object.fromEntries(Object.entries(fields(value, location)).map(([name, item]) => [name, visit(item, `${location}.${name}`, depth + 1)]));
  };
  return visit(raw, path, 0);
}
function implementation(raw: unknown, path: string): S2CapabilityImplementation {
  const value = fields(raw, path);
  const allowed: Record<string, string[]> = { local: ['kind', 'execute'], editor: ['kind', 'control'], renderer: ['kind', 'view', 'portId'], human: ['kind', 'control'], model: ['kind', 'bridge'], resource: ['kind', 'bridge'] };
  if (typeof value.kind !== 'string' || !Object.hasOwn(allowed, value.kind)) fail(path, '尚未安装此实现种类');
  if (Object.keys(value).length !== allowed[value.kind].length || Object.keys(value).some(name => !allowed[value.kind as string].includes(name))) fail(path, '实现必须提供且仅提供本类字段');
  if (value.kind === 'local') {
    if (typeof value.execute !== 'function') fail(path, '本地能力必须绑定明确的代码处理函数');
    return { kind: 'local', execute: value.execute as S2LocalAdapter };
  }
  const copy = snapshot(value, path) as Record<string, S2Json>;
  if (value.kind === 'editor' && (typeof copy.control !== 'string' || !['text', 'multiline'].includes(copy.control))
    || value.kind === 'renderer' && (typeof copy.view !== 'string' || !['text', 'json-tree', 'table', 'simulation'].includes(copy.view) || typeof copy.portId !== 'string' || !copy.portId)
    || value.kind === 'human' && (typeof copy.control !== 'string' || !['text', 'json', 'confirm'].includes(copy.control))
    || value.kind === 'model' && copy.bridge !== S2_MODEL_SESSION_BRIDGE.implementation
    || value.kind === 'resource' && !['selected-text-file', 'selected-project-note', 'selected-image-file'].includes(copy.bridge as string)) fail(path, '该控件、视图或宿主桥尚未安装');
  return copy as unknown as S2CapabilityImplementation;
}
type PortShape = readonly [id: string, type: string, required: boolean];
function ports(actual: S2PluginPort[], expected: readonly PortShape[]) {
  return actual.length === expected.length && expected.every(([id, type, required]) => actual.some(port =>
    port.id === id && port.type.id === type && port.type.version === 1 && port.required === required && port.multiple === false));
}
function compatible(ref: CapabilityRef, cap: S2PluginCapability, binding: S2CapabilityImplementation) {
  let valid = false;
  const pure = cap.effect === 'pure' && cap.permissions.length === 0;
  if (binding.kind === 'local') valid = pure && ['transform', 'validator'].includes(cap.kind);
  else if (binding.kind === 'editor') valid = ref.pluginId === 'core' && ref.pluginVersion === '1.0.0' && ref.capabilityId === binding.control
    && cap.kind === 'editor' && pure && ports(cap.inputs, []) && ports(cap.outputs, [['value', 'core.text', true]]);
  else if (binding.kind === 'renderer') {
    const type = { text: 'core.text', 'json-tree': 'structured-data.value', table: 'structured-data.table', simulation: 'workflow-simulation.result' }[binding.view];
    valid = cap.kind === 'renderer' && pure && ports(cap.inputs, [[binding.portId, type, true]]) && ports(cap.outputs, []);
  } else if (binding.kind === 'human') {
    const output: Record<typeof binding.control, PortShape> = { text: ['text', 'core.text', true], json: ['value', 'structured-data.value', true], confirm: ['decision', 'human-input.decision', true] };
    valid = ref.pluginId === 'human-input' && ref.pluginVersion === '1.0.0' && ref.capabilityId === binding.control
      && cap.kind === 'human' && cap.effect === 'read' && cap.permissions.length === 0 && cap.confirmation === 'per-call' && cap.retry === 'manual-only'
      && ports(cap.inputs, [['prompt', 'core.text', true], ['context', 'structured-data.value', false], ['simulation', 'workflow-simulation.result', false]])
      && ports(cap.outputs, [output[binding.control]]);
  } else if (binding.kind === 'resource') valid = ref.pluginId === (binding.bridge === 'selected-project-note' ? 'project-notes' : 'local-material')
    && ref.pluginVersion === '1.0.0' && ref.capabilityId === (binding.bridge === 'selected-image-file' ? 'read-image' : 'read-text')
    && cap.kind === 'action' && cap.effect === 'read' && cap.permissions.length === 1 && cap.permissions[0] === (binding.bridge === 'selected-project-note' ? 'notes-read' : 'file-read')
    && cap.confirmation === 'per-run' && cap.retry === 'manual-only'
    && ports(cap.inputs, [['resource', 'core.text', true]]) && ports(cap.outputs, binding.bridge === 'selected-image-file' ? [['image', 'core.image', true]] : [['text', 'core.text', true]]);
  else valid = isS2ModelSessionCapability(cap);
  if (!valid) fail(key(ref), '实现种类、精确版本、权限策略或输入输出端口与清单不兼容');
}

/** Atomic registration boundary, not an installer, a sandbox or runtime authorization. */
export class S2PluginInstallation {
  readonly registry: S2PluginRegistry;
  #implementations: Map<string, S2CapabilityImplementation>;
  constructor(packages: readonly S2PluginPackage[]) {
    const parsed = denseArray(packages, 'packages', 32).map((raw, index) => {
      const path = `packages.${index}`, value = fields(raw, path, ['manifest', 'implementations']);
      if (!Object.hasOwn(value, 'manifest') || !Object.hasOwn(value, 'implementations')) fail(path, '注册包缺少清单或实现映射');
      const bindings = fields(value.implementations, `${path}.implementations`);
      return { manifest: snapshot(value.manifest, `${path}.manifest`), implementations: new Map(Object.entries(bindings).map(([id, raw]) => [id, implementation(raw, `${path}.implementations.${id}`)])) };
    });
    const registry = new S2PluginRegistry(parsed.map(item => item.manifest));
    const implementations = new Map<string, S2CapabilityImplementation>();
    for (const item of parsed) {
      const raw = item.manifest as unknown as S2PluginManifest, manifest = registry.plugin(raw.id, raw.version);
      if (item.implementations.size !== manifest.capabilities.length || [...item.implementations.keys()].some(id => !manifest.capabilities.some(cap => cap.id === id))) fail(`${manifest.id}.implementations`, '每项清单能力都必须有且仅有一个实现，不允许未知绑定');
      for (const cap of manifest.capabilities) {
        const binding = item.implementations.get(cap.id);
        if (!binding) fail(`${manifest.id}.${cap.id}`, '能力没有代码实现');
        const ref = { pluginId: manifest.id, pluginVersion: manifest.version, capabilityId: cap.id };
        compatible(ref, cap, binding); implementations.set(key(ref), binding);
      }
    }
    // Publish neither registry nor handlers until every package and every binding passed.
    this.registry = registry; this.#implementations = implementations; Object.freeze(this);
  }
  #binding(ref: CapabilityRef): S2CapabilityImplementation {
    if (!ref || typeof ref !== 'object') fail('capability', '需要精确能力标识');
    const identity = Object.fromEntries(['pluginId', 'pluginVersion', 'capabilityId'].map(name => {
      const descriptor = Object.getOwnPropertyDescriptor(ref, name);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor) || typeof descriptor.value !== 'string') fail(name, '能力标识不能缺失、继承或由访问器提供');
      return [name, descriptor.value];
    })) as CapabilityRef;
    const binding = this.#implementations.get(key(identity));
    if (!binding) fail(key(identity), '此精确能力未安装可用实现');
    return binding;
  }
  descriptor(ref: CapabilityRef): S2ImplementationDescriptor {
    const binding = this.#binding(ref);
    return binding.kind === 'local' ? { kind: 'local' } : structuredClone(binding);
  }
  /** Dispatch after host validation/reservation. Returned data still require host outcome validation. */
  async execute(call: S2PluginInvocation, inputs: Record<string, S2Json[]>, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) throw new S2PluginProtocolError('CANCELLED', 'signal', '调用已取消，未执行本地处理器');
    const callCopy = snapshot(call, 'invocation', false) as unknown as S2PluginInvocation;
    const binding = this.#binding(callCopy);
    if (binding.kind !== 'local') fail(key(callCopy), '此能力必须由专属控件、视图或受控宿主桥处理，不能当作本地函数执行');
    // The host has already bounded each complete artifact. Several valid multi-input artifacts
    // may together exceed a manifest traversal budget; do not impose a second aggregate quota.
    const inputCopy = snapshot(inputs, 'inputs', false) as Record<string, S2Json[]>;
    return binding.execute(callCopy, inputCopy, signal);
  }
}
