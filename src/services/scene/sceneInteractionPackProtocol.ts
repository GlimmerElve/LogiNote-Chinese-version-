import type { SceneInteractionPack, SceneInteractionRuntime, ScenePackConfig, ScenePackDescription, ScenePackIssue, ScenePackRun, ScenePackViewPolicy } from '../../types/sceneInteractionPack';
import type { S2Json, S2PluginCapability, S2PluginManifest } from '../../types/sceneS2Plugin';
import { readS2PluginManifest, S2PluginProtocolError } from './sceneS2PluginProtocol';
import { readSceneInteractionPackManifest } from './sceneInteractionPackManifest';
import { readScenePackCanvasPolicy, ScenePackCanvasPolicyError } from './scenePackCanvasPolicy';
import { readScenePackAuthoringCatalog, ScenePackAuthoringCatalogError } from './scenePackAuthoringCatalog';
import { readS2PackInteraction, S2InteractionProtocolError } from './sceneS2InteractionProtocol';
export { readScenePackCanvasPolicy } from './scenePackCanvasPolicy';
export { readScenePackAuthoringCatalog } from './scenePackAuthoringCatalog';
export const scenePackAllowsExecution = (pack?: Pick<SceneInteractionPack, 'execution'> | null) => pack?.execution !== 'none';

/** Stable machine-readable failure plus a JSON-pointer-like contract path. No business decisions. */
export class ScenePackProtocolError extends Error {
  constructor(readonly code: string, readonly path: string, message: string) {
    super(`[${code}] ${path}: ${message}`); this.name = 'ScenePackProtocolError';
  }
}
const reserved = new Set(['__proto__', 'prototype', 'constructor']);
const child = (path: string, key: string | number) => `${path === '/' ? '' : path}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;
function fail(code: string, path: string, message: string): never { throw new ScenePackProtocolError(code, path, message); }
function fields(raw: unknown, path: string, required: readonly string[] = [], allowed?: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) fail('PACK_CONTRACT_OBJECT', path, '需要显式普通对象');
  const descriptors = Object.getOwnPropertyDescriptors(raw), result: Record<string, unknown> = Object.create(null);
  if (Reflect.ownKeys(descriptors).length > 256) fail('PACK_CONTRACT_LIMIT', path, '对象字段超过256项');
  for (const name of Reflect.ownKeys(descriptors)) {
    if (typeof name !== 'string' || reserved.has(name) || allowed && !allowed.includes(name)) fail('PACK_CONTRACT_FIELD', path, '含未知、符号或保留字段');
    const property = descriptors[name];
    if (!property.enumerable || !Object.hasOwn(property, 'value')) fail('PACK_CONTRACT_FIELD', child(path, name), '不能含访问器或隐藏字段');
    result[name] = property.value;
  }
  for (const name of required) if (!Object.hasOwn(result, name)) fail('PACK_CONTRACT_FIELD', child(path, name), '缺少必需字段');
  return result;
}
function array(raw: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype) fail('PACK_CONTRACT_DATA', path, '需要普通数组');
  if (raw.length > max) fail('PACK_CONTRACT_LIMIT', path, `列表超过${max}项`);
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  if (Reflect.ownKeys(descriptors).length !== raw.length + 1) fail('PACK_CONTRACT_FIELD', path, '数组不能含额外字段');
  return Array.from({ length: raw.length }, (_, index) => {
    const item = descriptors[String(index)];
    if (!item || !item.enumerable || !Object.hasOwn(item, 'value')) fail('PACK_CONTRACT_FIELD', child(path, index), '数组不能稀疏或含访问器');
    return item.value;
  });
}
function text(raw: unknown, path: string, max = 6000, empty = false): string {
  if (typeof raw !== 'string' || !empty && !raw.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(raw as string)) fail('PACK_CONTRACT_DATA', path, '需要有效文本');
  if ((raw as string).length > max) fail('PACK_CONTRACT_LIMIT', path, `文本超过${max}字`);
  return raw as string;
}
function identifier(raw: unknown, path: string): string {
  const value = text(raw, path, 120);
  if (reserved.has(value) || /\s/u.test(value)) fail('PACK_CONTRACT_DATA', path, '标识不能含空白或使用保留名称');
  return value;
}
function unique(values: string[], path: string) {
  const seen = new Set<string>();
  values.forEach((value, index) => { if (seen.has(value)) fail('PACK_CONTRACT_DUPLICATE', child(path, index), '标识或值重复'); seen.add(value); });
}
function strings(raw: unknown, path: string, maxItems = 64, maxChars = 6000): string[] {
  return array(raw, path, maxItems).map((value, index) => text(value, child(path, index), maxChars));
}
/** Same descriptor/dense-JSON constraints as S2 snapshots, kept free of registry imports. */
function snapshot(raw: unknown, path: string, maxBytes = 262144): S2Json {
  const active = new Set<object>(); let entries = 0, bytes = 0;
  const spend = (value: string, location: string) => { bytes += new TextEncoder().encode(value).byteLength;
    if (bytes > maxBytes) fail('PACK_CONTRACT_LIMIT', location, `完整数据超过${maxBytes}字节`); };
  const visit = (value: unknown, location: string, depth: number): S2Json => {
    if (++entries > 16000 || depth > 24) fail('PACK_CONTRACT_LIMIT', location, '数据超过遍历或深度上限');
    if (value === null || typeof value === 'boolean') return value as null | boolean;
    if (typeof value === 'number') { if (!Number.isFinite(value)) fail('PACK_CONTRACT_DATA', location, '数值必须有限'); return value; }
    if (typeof value === 'string') { if (value.length > 64000) fail('PACK_CONTRACT_LIMIT', location, '文本超过64000字'); spend(value, location); return value; }
    if (!value || typeof value !== 'object') fail('PACK_CONTRACT_DATA', location, '只接受完整JSON数据');
    if (active.has(value)) fail('PACK_CONTRACT_DATA', location, '不能循环引用');
    active.add(value);
    const result = Array.isArray(value) ? array(value, location, 2048).map((item, i) => visit(item, child(location, i), depth + 1))
      : Object.fromEntries(Object.entries(fields(value, location)).map(([name, item]) => { spend(name, location); return [name, visit(item, child(location, name), depth + 1)]; }));
    active.delete(value); return result;
  };
  const result = visit(raw, path, 0);
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > maxBytes) fail('PACK_CONTRACT_LIMIT', path, `完整数据超过${maxBytes}字节`);
  return result;
}
function method(value: Record<string, unknown>, name: string, path: string): (...args: any[]) => any {
  if (typeof value[name] !== 'function') fail('PACK_CONTRACT_FUNCTION', child(path, name), '需要可调用函数');
  return value[name] as (...args: any[]) => any;
}

/** Plain bounded Agent manual. Examples are data, never generated execution authority. */
export function readScenePackDescription(raw: unknown): ScenePackDescription {
  const value = fields(snapshot(raw, '/describe'), '/describe', ['purpose', 'components', 'combinations', 'operations', 'builder', 'assistant'],
    ['purpose', 'components', 'combinations', 'operations', 'builder', 'assistant']);
  const components = array(value.components, '/describe/components', 64).map((raw, index) => {
    const path = `/describe/components/${index}`, item = fields(raw, path, ['id', 'name', 'purpose', 'configuration', 'example'], ['id', 'name', 'purpose', 'configuration', 'example', 'capabilities']);
    const refs = item.capabilities === undefined ? undefined : array(item.capabilities, path + '/capabilities', 16).map((rawRef, refIndex) => {
      const refPath = `${path}/capabilities/${refIndex}`, ref = fields(rawRef, refPath, ['pluginId', 'pluginVersion', 'capabilityId'], ['pluginId', 'pluginVersion', 'capabilityId']);
      const pluginId = identifier(ref.pluginId, refPath + '/pluginId'), pluginVersion = text(ref.pluginVersion, refPath + '/pluginVersion', 40), capabilityId = identifier(ref.capabilityId, refPath + '/capabilityId');
      capabilityKey(`${pluginId}/${capabilityId}`, refPath);
      if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(pluginVersion)) fail('PACK_CONTRACT_REFERENCE', refPath + '/pluginVersion', '能力需要精确版本');
      return { pluginId, pluginVersion, capabilityId };
    });
    if (refs) unique(refs.map(ref => `${ref.pluginId}@${ref.pluginVersion}/${ref.capabilityId}`), path + '/capabilities');
    return { id: identifier(item.id, path + '/id'), name: text(item.name, path + '/name', 120), purpose: text(item.purpose, path + '/purpose'),
      configuration: text(item.configuration, path + '/configuration', 16000), example: item.example as S2Json, ...(refs !== undefined ? { capabilities: refs } : {}) };
  });
  unique(components.map(item => item.id), '/describe/components');
  const combinations = strings(value.combinations, '/describe/combinations'); unique(combinations, '/describe/combinations');
  const operations = array(value.operations, '/describe/operations', 64).map((raw, index) => {
    const path = `/describe/operations/${index}`, item = fields(raw, path, ['id', 'description', 'parameters', 'errors'], ['id', 'description', 'parameters', 'errors']);
    const errors = strings(item.errors, path + '/errors', 64, 120); unique(errors, path + '/errors');
    return { id: identifier(item.id, path + '/id'), description: text(item.description, path + '/description'), parameters: text(item.parameters, path + '/parameters', 16000, true), errors };
  });
  unique(operations.map(item => item.id), '/describe/operations');
  const builder = fields(value.builder, '/describe/builder', ['assemble', 'repair'], ['assemble', 'repair']);
  const assistant = fields(value.assistant, '/describe/assistant', ['instructions', 'defaultAllowedOperations'], ['instructions', 'defaultAllowedOperations']);
  const allowed = strings(assistant.defaultAllowedOperations, '/describe/assistant/defaultAllowedOperations', 64, 120);
  unique(allowed, '/describe/assistant/defaultAllowedOperations');
  allowed.forEach((id, index) => { if (!operations.some(operation => operation.id === id)) fail('PACK_CONTRACT_REFERENCE', `/describe/assistant/defaultAllowedOperations/${index}`, '默认操作未在operations中声明'); });
  return { purpose: text(value.purpose, '/describe/purpose', 16000), components, combinations, operations,
    builder: { assemble: text(builder.assemble, '/describe/builder/assemble', 64000), repair: text(builder.repair, '/describe/builder/repair', 64000) },
    assistant: { instructions: text(assistant.instructions, '/describe/assistant/instructions', 64000), defaultAllowedOperations: allowed } };
}
export function describeSceneInteractionPack(pack: Pick<SceneInteractionPack, 'describe'>): ScenePackDescription {
  let raw: unknown;
  try { raw = pack.describe(); }
  catch (error) { if (error instanceof ScenePackProtocolError) throw error; fail('PACK_CONTRACT_DESCRIPTION', '/describe', error instanceof Error ? error.message : '说明函数未正常返回'); }
  return readScenePackDescription(raw);
}

type PackOptions = { sharedCapabilities?: S2PluginManifest[] };
function capabilityKey(raw: string, path: string): string {
  const parts = raw.split('/');
  if (parts.length !== 2 || parts.some(part => part.length > 120 || reserved.has(part))
    || !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(parts[0]) || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(parts[1]))
    fail('PACK_CONTRACT_REFERENCE', path, '能力键必须为pluginId/capabilityId');
  return raw;
}
function referencedCapabilities(key: string, path: string, capabilities: S2PluginManifest[], options: PackOptions): S2PluginCapability[] {
  capabilityKey(key, path);
  const [pluginId, capabilityId] = key.split('/'), owned = capabilities.filter(manifest => manifest.id === pluginId);
  const candidates = owned.length ? owned : (options.sharedCapabilities ?? []).filter(manifest => manifest.id === pluginId);
  const matches = candidates.map(manifest => manifest.capabilities.find(item => item.id === capabilityId));
  if (candidates.length && matches.some(item => !item) || options.sharedCapabilities && !candidates.length)
    fail('PACK_CONTRACT_REFERENCE', path, '能力键没有对应的真实声明');
  return matches.filter((item): item is S2PluginCapability => !!item);
}
function views(raw: unknown, capabilities: S2PluginManifest[], options: PackOptions): NonNullable<SceneInteractionPack['views']> {
  const entries = fields(raw, '/views'), result: NonNullable<SceneInteractionPack['views']> = {};
  for (const [key, rawEntry] of Object.entries(entries)) {
    const path = child('/views', key); referencedCapabilities(key, path, capabilities, options);
    const entry = fields(rawEntry, path, [], ['settings', 'inline', 'node', 'onDoubleClick', 'policy']);
    result[key] = Object.fromEntries(Object.keys(entry).map(name => [name, method(entry, name, path).bind(rawEntry)]));
  }
  return result;
}
function help(raw: unknown, capabilities: S2PluginManifest[], options: PackOptions): NonNullable<SceneInteractionPack['help']> {
  const entries = fields(snapshot(raw, '/help'), '/help'), result: NonNullable<SceneInteractionPack['help']> = {};
  for (const [key, rawEntry] of Object.entries(entries)) {
    const path = child('/help', key), caps = referencedCapabilities(key, path, capabilities, options);
    const entry = fields(rawEntry, path, ['when', 'example', 'difference'], ['when', 'example', 'difference', 'category', 'hideLiteralInputs', 'title', 'description', 'inputLabels', 'outputLabels']);
    const item = { when: text(entry.when, path + '/when'), example: text(entry.example, path + '/example'), difference: text(entry.difference, path + '/difference') } as NonNullable<SceneInteractionPack['help']>[string];
    for (const name of ['category', 'title', 'description'] as const) if (entry[name] !== undefined) item[name] = text(entry[name], path + '/' + name, name === 'description' ? 6000 : 120);
    if (entry.hideLiteralInputs !== undefined) {
      item.hideLiteralInputs = strings(entry.hideLiteralInputs, path + '/hideLiteralInputs', 16, 120); unique(item.hideLiteralInputs, path + '/hideLiteralInputs');
      item.hideLiteralInputs.forEach((id, index) => { if (caps.some(cap => !cap.inputs.some(port => port.id === id))) fail('PACK_CONTRACT_REFERENCE', `${path}/hideLiteralInputs/${index}`, '隐藏项不是该能力的输入端口'); });
    }
    for (const [name, direction] of [['inputLabels', 'inputs'], ['outputLabels', 'outputs']] as const) if (entry[name] !== undefined) {
      const labels = fields(entry[name], path + '/' + name);
      item[name] = Object.fromEntries(Object.entries(labels).map(([id, value]) => {
        if (caps.some(cap => !cap[direction].some(port => port.id === id))) fail('PACK_CONTRACT_REFERENCE', `${path}/${name}/${id}`, '标签没有对应的真实端口');
        return [id, text(value, `${path}/${name}/${id}`, 120)];
      }));
    }
    result[key] = item;
  }
  return result;
}

/** Validate completely before installation; invokes describe only, never probes runtime or execution. */
export function readSceneInteractionPack(raw: unknown, options: PackOptions = {}): SceneInteractionPack {
  const value = fields(raw, '/', ['manifest', 'capabilities', 'validate', 'createRuntime', 'executeLocal']);
  let manifest: SceneInteractionPack['manifest'];
  try { manifest = readSceneInteractionPackManifest(snapshot(value.manifest, '/manifest', 8192)); }
  catch (error) { if (error instanceof ScenePackProtocolError) throw error; fail('PACK_CONTRACT_MANIFEST', '/manifest', error instanceof Error ? error.message : '清单无效'); }
  const capabilities = array(value.capabilities, '/capabilities', 32).map((raw, index) => {
    try { return readS2PluginManifest(raw); }
    catch (error) { fail('PACK_CONTRACT_CAPABILITY', `/capabilities/${index}${error instanceof S2PluginProtocolError ? '/' + error.field.replace(/\./g, '/') : ''}`, error instanceof Error ? error.message : '能力声明无效'); }
  });
  unique(capabilities.map(item => `${item.id}@${item.version}`), '/capabilities');
  let authoring: SceneInteractionPack['authoring'];
  if (value.authoring !== undefined) {
    try { authoring = readScenePackAuthoringCatalog(value.authoring, { capabilities, sharedCapabilities: options.sharedCapabilities }); }
    catch (error) {
      if (error instanceof ScenePackAuthoringCatalogError) fail(error.code, error.path, error.detail);
      throw error;
    }
  }
  // Explicit authoring is a complete machine contract, including the valid empty
  // directory. Agent prose is optional; legacy entries keep their original contract.
  const generatedDescription: ScenePackDescription | undefined = authoring && {
    purpose: manifest.name,
    components: authoring.components.map(component => ({ id: component.id, name: component.label, purpose: component.purpose,
      configuration: `可调参数：${component.parameters.join('、') || '无'}；输入：${component.inputs.join('、') || '无'}；输出：${component.outputs.join('、') || '无'}。`,
      example: { componentId: component.id, parameters: {} },
      capabilities: component.implementation.kind === 'capability' ? [{ pluginId: component.implementation.pluginId,
        pluginVersion: component.implementation.pluginVersion, capabilityId: component.implementation.capabilityId }] : [] })),
    combinations: [], operations: [],
    builder: { assemble: '按目标选择公开组件，用公开参数和端口搭建；内部实现由本地程序处理。', repair: '保留原内容，在公开接口范围内修复配置或连线。' },
    assistant: { instructions: value.execution === 'none' ? '本包仅编辑建模，添加、删除、改值和接线直接生效，无需运行或测试；不要求用户声明“不运行”。' : '按需理解当前任务与实际结果；普通编辑只改图，执行由包的业务入口或明确执行请求决定；不修改包内未公开组件。', defaultAllowedOperations: [] },
  };
  const checked: SceneInteractionPack = { manifest, capabilities,
    describe: value.describe === undefined && generatedDescription ? () => structuredClone(generatedDescription) : method(value, 'describe', '/').bind(raw), validate: method(value, 'validate', '/').bind(raw),
    createRuntime: method(value, 'createRuntime', '/').bind(raw), executeLocal: method(value, 'executeLocal', '/').bind(raw) };
  if (value.execution !== undefined) {
    if (value.execution !== 'none' && value.execution !== 'on-demand') fail('PACK_EXECUTION_MODE', '/execution', '执行模式须为none或on-demand');
    checked.execution = value.execution;
  }
  if (authoring !== undefined) checked.authoring = authoring;
  if (value.interaction !== undefined) {
    try { checked.interaction = readS2PackInteraction(value.interaction, manifest.id); }
    catch (error) {
      if (error instanceof S2InteractionProtocolError) fail(error.code, error.path, error.reason);
      throw error;
    }
    if (checked.interaction.events.length && authoring === undefined)
      fail('PACK_INTERACTION_AUTHORING', '/interaction/events', '声明交互事件需要公开组件目录');
  }
  if (value.views !== undefined) checked.views = views(value.views, capabilities, options);
  if (value.help !== undefined) checked.help = help(value.help, capabilities, options);
  if (value.canvas !== undefined) {
    try { checked.canvas = readScenePackCanvasPolicy(value.canvas, { capabilities, sharedCapabilities: options.sharedCapabilities }); }
    catch (error) {
      if (error instanceof ScenePackCanvasPolicyError) fail(error.code, error.path, error.detail);
      throw error;
    }
  }
  const description = describeSceneInteractionPack(checked);
  for (const [index, component] of description.components.entries()) for (const [refIndex, ref] of (component.capabilities ?? []).entries()) {
    const path = `/describe/components/${index}/capabilities/${refIndex}`;
    const owned = capabilities.filter(plugin => plugin.id === ref.pluginId);
    const candidates = (owned.length ? owned : options.sharedCapabilities ?? []).filter(plugin => plugin.id === ref.pluginId && plugin.version === ref.pluginVersion);
    if ((owned.length || options.sharedCapabilities !== undefined) && !candidates.some(plugin => plugin.capabilities.some(cap => cap.id === ref.capabilityId && cap.kind !== 'editor')))
      fail('PACK_CONTRACT_REFERENCE', path, '组件引用不对应范围内精确执行能力');
  }
  checked.describe = () => structuredClone(description);
  return checked;
}

/** Validate a runtime only at an actual createRuntime call boundary; do not execute its methods. */
export function readScenePackRuntime(raw: unknown): SceneInteractionRuntime {
  const value = fields(raw, '/runtime', ['updateConfig', 'dispatch', 'run', 'dispose']);
  return { updateConfig: method(value, 'updateConfig', '/runtime').bind(raw), dispatch: method(value, 'dispatch', '/runtime').bind(raw),
    run: method(value, 'run', '/runtime').bind(raw), dispose: method(value, 'dispose', '/runtime').bind(raw) };
}
/** Validate the actual policy result at render/use time without invoking any action callback. */
export function readScenePackViewPolicy(raw: unknown, capability: S2PluginCapability): ScenePackViewPolicy {
  const value = fields(raw, '/viewPolicy', [], ['genericSettings', 'showStatus', 'inputAnchors', 'outputAnchors', 'visibleNodeInputs', 'inputLabels', 'showResult', 'resourceInputInView', 'interactionInputInView', 'hiddenSettingsInputs', 'inputActions', 'addInput', 'annotation']);
  const result: ScenePackViewPolicy = {};
  for (const name of ['genericSettings', 'showStatus', 'interactionInputInView'] as const) if (value[name] !== undefined) {
    if (typeof value[name] !== 'boolean') fail('PACK_CONTRACT_DATA', `/viewPolicy/${name}`, '需要明确布尔值');
    result[name] = value[name];
  }
  for (const [name, direction] of [['inputAnchors', 'inputs'], ['outputAnchors', 'outputs']] as const) if (value[name] !== undefined) {
    const entries = fields(value[name], `/viewPolicy/${name}`);
    if (Object.keys(entries).length > 16) fail('PACK_CONTRACT_LIMIT', `/viewPolicy/${name}`, '连接点配置超过16项');
    result[name] = Object.fromEntries(Object.entries(entries).map(([id, rawAnchor]) => {
      const path = child(`/viewPolicy/${name}`, id);
      if (!capability[direction].some(port => port.id === id)) fail('PACK_CONTRACT_REFERENCE', path, '连接点没有对应的真实端口');
      const anchor = fields(rawAnchor, path, ['side'], ['side', 'offset']);
      if (!['top', 'right', 'bottom', 'left'].includes(anchor.side as string)) fail('PACK_CONTRACT_DATA', `${path}/side`, '连接点方向须为top/right/bottom/left');
      if (anchor.offset !== undefined && (typeof anchor.offset !== 'number' || !Number.isFinite(anchor.offset) || anchor.offset < 0 || anchor.offset > 1))
        fail('PACK_CONTRACT_DATA', `${path}/offset`, '连接点偏移须为0至1的有限数');
      return [id, { side: anchor.side as 'top' | 'right' | 'bottom' | 'left', ...(anchor.offset !== undefined ? { offset: anchor.offset as number } : {}) }];
    }));
  }
  if (value.showResult !== undefined) {
    if (typeof value.showResult !== 'boolean') fail('PACK_CONTRACT_DATA', '/viewPolicy/showResult', '需要明确布尔值');
    result.showResult = value.showResult;
  }
  if (value.resourceInputInView !== undefined) {
    if (typeof value.resourceInputInView !== 'boolean') fail('PACK_CONTRACT_DATA', '/viewPolicy/resourceInputInView', '需要明确布尔值');
    result.resourceInputInView = value.resourceInputInView;
  }
  const input = (id: string, path: string) => { if (!capability.inputs.some(port => port.id === id)) fail('PACK_CONTRACT_REFERENCE', path, '没有对应的真实输入端口'); };
  for (const name of ['visibleNodeInputs', 'hiddenSettingsInputs'] as const) if (value[name] !== undefined) {
    const ids = strings(value[name], '/viewPolicy/' + name, 16, 120); unique(ids, '/viewPolicy/' + name);
    ids.forEach((id, index) => input(id, `/viewPolicy/${name}/${index}`)); result[name] = ids;
  }
  if (value.inputLabels !== undefined) {
    const labels = fields(value.inputLabels, '/viewPolicy/inputLabels');
    if (Object.keys(labels).length > 16) fail('PACK_CONTRACT_LIMIT', '/viewPolicy/inputLabels', '端口标签超过16项');
    result.inputLabels = Object.fromEntries(Object.entries(labels).map(([id, label]) => {
      input(id, `/viewPolicy/inputLabels/${id}`); return [id, text(label, `/viewPolicy/inputLabels/${id}`, 120)];
    }));
  }
  if (value.annotation !== undefined) result.annotation = text(value.annotation, '/viewPolicy/annotation', 6000, true);
  if (value.inputActions !== undefined) {
    const actions = fields(value.inputActions, '/viewPolicy/inputActions');
    if (Object.keys(actions).length > 16) fail('PACK_CONTRACT_LIMIT', '/viewPolicy/inputActions', '端口动作超过16项');
    result.inputActions = Object.fromEntries(Object.entries(actions).map(([id, rawAction]) => {
      const path = child('/viewPolicy/inputActions', id); input(id, path);
      const action = fields(rawAction, path, ['label', 'run'], ['label', 'run']);
      return [id, { label: text(action.label, path + '/label', 120), run: method(action, 'run', path).bind(rawAction) }];
    }));
  }
  if (value.addInput !== undefined) {
    const action = fields(value.addInput, '/viewPolicy/addInput', ['label', 'disabled', 'run'], ['label', 'disabled', 'run']);
    if (typeof action.disabled !== 'boolean') fail('PACK_CONTRACT_DATA', '/viewPolicy/addInput/disabled', '需要明确布尔值');
    result.addInput = { label: text(action.label, '/viewPolicy/addInput/label', 120), disabled: action.disabled,
      run: method(action, 'run', '/viewPolicy/addInput').bind(value.addInput) };
  }
  return result;
}
export function readScenePackIssues(raw: unknown): ScenePackIssue[] {
  return array(snapshot(raw, '/validate', 65536), '/validate', 64).map((raw, index) => {
    const path = `/validate/${index}`, item = fields(raw, path, ['path', 'message'], ['path', 'message']);
    const issuePath = text(item.path, path + '/path', 1000, true);
    if (issuePath && !issuePath.startsWith('/')) fail('PACK_CONTRACT_DATA', path + '/path', '问题路径必须为空或从根路径开始');
    return { path: issuePath, message: text(item.message, path + '/message') };
  });
}
/** Business issues are returned to the caller, not converted into automatic execution or repairs. */
export function validateScenePackConfig(pack: Pick<SceneInteractionPack, 'validate'>, config: ScenePackConfig): ScenePackIssue[] {
  return readScenePackIssues(pack.validate(config));
}
function hasThen(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' && typeof raw !== 'function') return false;
  let current: object | null = raw as object;
  for (let depth = 0; current && depth < 8; depth++, current = Object.getPrototypeOf(current)) {
    const descriptor = Object.getOwnPropertyDescriptor(current, 'then');
    if (descriptor) return Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'function';
  }
  return false;
}
/** Preserve the original completion and extra host handle properties; never await or assimilate here. */
export function readScenePackRun<T = ScenePackRun>(raw: T): T & ScenePackRun {
  const value = fields(raw, '/run', ['id', 'completion']); identifier(value.id, '/run/id');
  if (!hasThen(value.completion)) fail('PACK_CONTRACT_RUN', '/run/completion', '需要Promise或兼容的完成句柄');
  return raw as T & ScenePackRun;
}
