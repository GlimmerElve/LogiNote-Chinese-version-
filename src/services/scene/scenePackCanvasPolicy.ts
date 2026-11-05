import type { ScenePackCanvasPolicy } from '../../types/sceneInteractionPack';
import type { S2Json, S2PluginManifest } from '../../types/sceneS2Plugin';

/** Independent of package registries so installation can validate metadata before publishing it. */
export class ScenePackCanvasPolicyError extends Error {
  constructor(readonly code: string, readonly path: string, readonly detail: string) {
    super(`[${code}] ${path}: ${detail}`); this.name = 'ScenePackCanvasPolicyError';
  }
}
export interface ScenePackCanvasPolicyOptions {
  capabilities: readonly S2PluginManifest[];
  /** Supplying this scope makes every reference strict, including references outside owned manifests. */
  sharedCapabilities?: readonly S2PluginManifest[];
}
function fail(code: string, path: string, message: string): never { throw new ScenePackCanvasPolicyError(code, path, message); }
function fields(raw: unknown, path: string, allowed: readonly string[] | undefined, required: readonly string[] = []): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) fail('PACK_CONTRACT_OBJECT', path, '需要普通声明对象');
  const descriptors = Object.getOwnPropertyDescriptors(raw), result: Record<string, unknown> = Object.create(null);
  for (const name of Reflect.ownKeys(descriptors)) {
    if (typeof name !== 'string' || allowed && !allowed.includes(name)) fail('PACK_CONTRACT_FIELD', path, '含未知或符号字段');
    const property = descriptors[name];
    if (!property.enumerable || !Object.hasOwn(property, 'value')) fail('PACK_CONTRACT_FIELD', `${path}/${name}`, '不允许访问器或隐藏字段');
    result[name] = property.value;
  }
  for (const name of required) if (!Object.hasOwn(result, name)) fail('PACK_CONTRACT_FIELD', `${path}/${name}`, '缺少必需字段');
  return result;
}
function array(raw: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype) fail('PACK_CONTRACT_DATA', path, '需要普通数组');
  if (raw.length > max) fail('PACK_CONTRACT_LIMIT', path, `最多${max}项`);
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  if (Reflect.ownKeys(descriptors).length !== raw.length + 1) fail('PACK_CONTRACT_FIELD', path, '数组含额外字段');
  return Array.from({ length: raw.length }, (_, index) => {
    const property = descriptors[String(index)];
    if (!property?.enumerable || !Object.hasOwn(property, 'value')) fail('PACK_CONTRACT_FIELD', `${path}/${index}`, '数组不允许空项或访问器');
    return property.value;
  });
}
function text(raw: unknown, path: string, max = 120): string {
  if (typeof raw !== 'string' || !raw.trim() || /[\u0000-\u001f]/u.test(raw)) fail('PACK_CONTRACT_DATA', path, '需要有效非空文本');
  if (raw.length > max) fail('PACK_CONTRACT_LIMIT', path, `文本超过${max}字`);
  return raw;
}
function selection<T extends string>(raw: unknown, path: string, allowed: readonly T[]): T {
  if (typeof raw !== 'string' || !allowed.includes(raw as T)) fail('PACK_CONTRACT_DATA', path, `仅允许${allowed.join('/')}`);
  return raw as T;
}
function groupId(raw: unknown, path: string): string {
  const id = text(raw, path);
  if (/\s/u.test(id) || ['constructor', 'prototype', '__proto__'].includes(id)) fail('PACK_CONTRACT_DATA', path, '组标识不能含空白或使用保留名称');
  return id;
}

/** Native literal values only. This never interprets JSON as a field binding or grants authority. */
function literalDefaults(raw: unknown, path: string): Record<string, S2Json> {
  const values = fields(raw, path, undefined), names = Object.keys(values);
  if (names.length > 16) fail('PACK_CONTRACT_LIMIT', path, '预设最多16个输入');
  for (const name of names) if (!/^[A-Za-z][A-Za-z0-9_-]*$/u.test(name) || ['constructor', 'prototype', '__proto__'].includes(name))
    fail('PACK_CONTRACT_REFERENCE', path, '预设需要合法输入端口标识');
  const active = new Set<object>(); let entries = 0, bytes = 0;
  const child = (location: string, name: string | number) => `${location}/${String(name).replace(/~/g, '~0').replace(/\//g, '~1')}`;
  const spend = (value: string, location: string) => {
    if (value.length > 16384) fail('PACK_CONTRACT_LIMIT', location, '预设超过16384字节');
    bytes += new TextEncoder().encode(value).byteLength;
    if (bytes > 16384) fail('PACK_CONTRACT_LIMIT', location, '预设超过16384字节');
  };
  const visit = (value: unknown, location: string, depth: number): S2Json => {
    if (++entries > 2048 || depth > 8) fail('PACK_CONTRACT_LIMIT', location, '预设超过深度或元素数量限制');
    if (value === null || typeof value === 'boolean') return value as null | boolean;
    if (typeof value === 'number') { if (!Number.isFinite(value)) fail('PACK_CONTRACT_DATA', location, '预设数值必须有限'); return value; }
    if (typeof value === 'string') { spend(value, location); return value; }
    if (!value || typeof value !== 'object') fail('PACK_CONTRACT_DATA', location, '预设只接受原生JSON值');
    if (active.has(value)) fail('PACK_CONTRACT_DATA', location, '预设不能循环引用');
    active.add(value);
    let result: S2Json;
    if (Array.isArray(value)) result = array(value, location, 2048).map((item, index) => visit(item, child(location, index), depth + 1));
    else {
      const properties = fields(value, location, undefined), keys = Object.keys(properties);
      if (keys.length > 256) fail('PACK_CONTRACT_LIMIT', location, '预设对象超过256项');
      result = Object.fromEntries(keys.map(name => {
        if (['constructor', 'prototype', '__proto__'].includes(name)) fail('PACK_CONTRACT_FIELD', child(location, name), '预设不允许保留字段');
        spend(name, location); return [name, visit(properties[name], child(location, name), depth + 1)];
      }));
    }
    active.delete(value); return result;
  };
  const result = visit(values, path, 0) as Record<string, S2Json>;
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 16384) fail('PACK_CONTRACT_LIMIT', path, '完整预设超过16384字节');
  return result;
}

/** Detached, bounded metadata only. Capability references classify menu entries; they never install,
 * authorize, execute, or remove capabilities from the scene's real runtime scope. */
export function readScenePackCanvasPolicy(raw: unknown, options: ScenePackCanvasPolicyOptions = { capabilities: [] }): ScenePackCanvasPolicy {
  const value = fields(raw, '/canvas', ['contentEditing', 'openSettingsOnSelect', 'contentSettings', 'executionUi', 'addMenu']);
  const result: ScenePackCanvasPolicy = {};
  if (value.contentEditing !== undefined) result.contentEditing = selection(value.contentEditing, '/canvas/contentEditing', ['panel', 'inline', 'double-click']);
  if (value.openSettingsOnSelect !== undefined) {
    if (typeof value.openSettingsOnSelect !== 'boolean') fail('PACK_CONTRACT_DATA', '/canvas/openSettingsOnSelect', '需要布尔值');
    result.openSettingsOnSelect = value.openSettingsOnSelect;
  }
  if (value.contentSettings !== undefined) result.contentSettings = selection(value.contentSettings, '/canvas/contentSettings', ['show', 'hide']);
  // Metadata compatibility only. Neither legacy value enables a host execution UI.
  if (value.executionUi !== undefined) result.executionUi = selection(value.executionUi, '/canvas/executionUi', ['panel', 'inline']);
  if (result.contentSettings === 'hide' && !['inline', 'double-click'].includes(result.contentEditing ?? ''))
    fail('PACK_CONTRACT_DATA', '/canvas/contentEditing', '隐藏内容设置区时必须显式选择inline或double-click，保留可用的内容编辑入口');
  if (value.addMenu !== undefined) {
    const menu = fields(value.addMenu, '/canvas/addMenu', ['contentLabel', 'groups', 'otherCapabilities'], ['groups']);
    const groupIds = new Set<string>(), references = new Set<string>(); let count = 0;
    const groups = array(menu.groups, '/canvas/addMenu/groups', 8).map((rawGroup, index) => {
      const path = `/canvas/addMenu/groups/${index}`, group = fields(rawGroup, path, ['id', 'label', 'capabilities'], ['id', 'label', 'capabilities']);
      const id = groupId(group.id, path + '/id');
      if (groupIds.has(id)) fail('PACK_CONTRACT_DUPLICATE', path + '/id', '组标识重复');
      groupIds.add(id);
      const capabilities = array(group.capabilities, path + '/capabilities', 64).map((rawRef, refIndex) => {
        const location = `${path}/capabilities/${refIndex}`, ref = fields(rawRef, location, ['pluginId', 'pluginVersion', 'capabilityId', 'defaults'], ['pluginId', 'pluginVersion', 'capabilityId']);
        const pluginId = text(ref.pluginId, location + '/pluginId'), pluginVersion = text(ref.pluginVersion, location + '/pluginVersion', 40), capabilityId = text(ref.capabilityId, location + '/capabilityId');
        if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u.test(pluginId) || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(pluginVersion)
          || !/^[A-Za-z][A-Za-z0-9_-]*$/u.test(capabilityId)
          || ['constructor', 'prototype', '__proto__'].some(reserved => reserved === pluginId || reserved === capabilityId))
          fail('PACK_CONTRACT_REFERENCE', location, '需要合法插件标识、精确版本及能力标识');
        const key = `${pluginId}@${pluginVersion}/${capabilityId}`;
        if (references.has(key)) fail('PACK_CONTRACT_DUPLICATE', location, '能力只能归入一个菜单组');
        references.add(key); if (++count > 64) fail('PACK_CONTRACT_LIMIT', '/canvas/addMenu/groups', '全部菜单组最多64项能力引用');
        const owned = options.capabilities.filter(plugin => plugin.id === pluginId);
        const candidates = (owned.length ? owned : (options.sharedCapabilities ?? []).filter(plugin => plugin.id === pluginId))
          .filter(plugin => plugin.version === pluginVersion);
        const matches = candidates.map(plugin => plugin.capabilities.find(capability => capability.id === capabilityId));
        if ((owned.length || options.sharedCapabilities !== undefined) && (!matches.length || matches.some(capability => !capability || capability.kind === 'editor')))
          fail('PACK_CONTRACT_REFERENCE', location, '菜单引用不对应范围内精确可组合能力');
        const defaults = Object.hasOwn(ref, 'defaults') ? literalDefaults(ref.defaults, location + '/defaults') : undefined;
        for (const name of Object.keys(defaults ?? {})) if (matches.length && matches.some(capability => !capability?.inputs.some(input => input.id === name)))
          fail('PACK_CONTRACT_REFERENCE', `${location}/defaults/${name}`, '预设不对应能力的真实输入端口');
        return { pluginId, pluginVersion, capabilityId, ...(defaults !== undefined ? { defaults } : {}) };
      });
      return { id, label: text(group.label, path + '/label'), capabilities };
    });
    result.addMenu = { groups,
      ...(menu.contentLabel !== undefined ? { contentLabel: text(menu.contentLabel, '/canvas/addMenu/contentLabel') } : {}),
      ...(menu.otherCapabilities !== undefined ? { otherCapabilities: selection(menu.otherCapabilities, '/canvas/addMenu/otherCapabilities', ['show', 'hide']) } : {}),
    };
  }
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 32768) fail('PACK_CONTRACT_LIMIT', '/canvas', '声明超过32768字节');
  return result;
}
