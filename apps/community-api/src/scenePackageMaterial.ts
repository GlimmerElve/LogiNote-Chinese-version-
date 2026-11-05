import type { SceneInteractionPackManifest, ScenePackMaterialDescriptor, ScenePackMaterialMediaType } from './scenePackageTypes.js';

export class ScenePackMaterialError extends Error {
  constructor(readonly code: string, readonly path: string, message: string) {
    super(`[${code}] ${path}: ${message}`); this.name = 'ScenePackMaterialError';
  }
}
const MAX_ITEM_BYTES = 1048576, MAX_TOTAL_BYTES = 8388608;
const mediaTypes = new Set<ScenePackMaterialMediaType>(['text/plain', 'application/json', 'image/png', 'image/jpeg', 'image/webp']);
const idPattern = /^[a-z][a-z0-9-]{0,63}$/;
const escape = (value: string) => value.replace(/~/g, '~0').replace(/\//g, '~1');
function fail(code: string, path: string, message: string): never { throw new ScenePackMaterialError(code, path, message); }
function materialId(raw: unknown, path: string): string {
  if (typeof raw !== 'string' || !idPattern.test(raw)) fail('PACK_MATERIAL_ID', path, '物料ID必须为小写字母开头、至多64位字母数字或连字符');
  return raw;
}
function fields(raw: unknown, path: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) fail('PACK_MATERIAL_DESCRIPTOR', path, '物料描述必须为普通对象');
  const expected = ['id', 'label', 'path', 'mediaType', 'bytes', 'sha256'], descriptors = Object.getOwnPropertyDescriptors(raw);
  if (Reflect.ownKeys(descriptors).length !== expected.length || expected.some(key => !descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key], 'value')))
    fail('PACK_MATERIAL_DESCRIPTOR', path, '物料描述必须且只能包含id、label、path、mediaType、bytes、sha256显式字段');
  return Object.fromEntries(expected.map(key => [key, descriptors[key].value]));
}
function readDescriptor(raw: unknown, path: string): ScenePackMaterialDescriptor {
  const value = fields(raw, path), id = materialId(value.id, path + '/id');
  if (typeof value.label !== 'string' || !value.label.trim() || value.label.length > 80 || /[\u0000-\u001f\u007f]/u.test(value.label))
    fail('PACK_MATERIAL_DESCRIPTOR', path + '/label', '物料名称必须为1至80字的有效文本');
  if (typeof value.path !== 'string' || value.path.length > 8192 || !value.path.startsWith('materials/'))
    fail('PACK_MATERIAL_PATH', path + '/path', '物料路径必须位于materials/下');
  const segments = value.path.split('/');
  if (segments.length < 2 || segments.slice(1).some(segment => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment) || segment.endsWith('.')
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)))
    fail('PACK_MATERIAL_PATH', path + '/path', '物料路径只允许ASCII安全相对路径段，不允许空段、点段、反斜杠、编码、查询或片段');
  if (typeof value.mediaType !== 'string' || !mediaTypes.has(value.mediaType as ScenePackMaterialMediaType))
    fail('PACK_MATERIAL_TYPE', path + '/mediaType', '物料仅支持纯文本、JSON、PNG、JPEG或WebP');
  if (typeof value.bytes !== 'number' || !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > MAX_ITEM_BYTES)
    fail('PACK_MATERIAL_BYTES', path + '/bytes', '每项物料须为1至1048576字节');
  if (typeof value.sha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(value.sha256))
    fail('PACK_MATERIAL_HASH', path + '/sha256', 'SHA-256必须为64位十六进制字符串');
  return { id, label: value.label, path: value.path, mediaType: value.mediaType as ScenePackMaterialMediaType, bytes: value.bytes, sha256: value.sha256 };
}
/** v2 descriptor list only. v1 manifests omit this field entirely. No code or bytes are read here. */
export function readScenePackMaterialDescriptors(raw: unknown): ScenePackMaterialDescriptor[] {
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype || raw.length < 1 || raw.length > 16)
    fail('PACK_MATERIAL_LIMIT', '/materials', '物料列表必须包含1至16项');
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  if (Reflect.ownKeys(descriptors).length !== raw.length + 1) fail('PACK_MATERIAL_DESCRIPTOR', '/materials', '物料数组必须稠密且不能含额外字段');
  let total = 0; const ids = new Set<string>(), paths = new Set<string>();
  return Array.from({ length: raw.length }, (_, index) => {
    const path = '/materials/' + index, entry = descriptors[String(index)];
    if (!entry?.enumerable || !Object.hasOwn(entry, 'value')) fail('PACK_MATERIAL_DESCRIPTOR', path, '物料数组不能含空洞、访问器或隐藏字段');
    const item = readDescriptor(entry.value, path);
    if (ids.has(item.id)) fail('PACK_MATERIAL_DUPLICATE', path + '/id', '物料ID重复');
    if (paths.has(item.path.toLowerCase())) fail('PACK_MATERIAL_DUPLICATE', path + '/path', '物料路径重复（不区分大小写）');
    ids.add(item.id); paths.add(item.path.toLowerCase()); total += item.bytes;
    if (total > MAX_TOTAL_BYTES) fail('PACK_MATERIAL_LIMIT', '/materials', '物料总大小不能超过8388608字节');
    return item;
  });
}
export function findScenePackMaterial(manifest: SceneInteractionPackManifest, rawId: string): ScenePackMaterialDescriptor {
  const id = materialId(rawId, '/materials/id');
  const item = manifest.protocolVersion === 2 ? readScenePackMaterialDescriptors(manifest.materials).find(item => item.id === id) : undefined;
  if (!item) fail('PACK_MATERIAL_NOT_FOUND', '/materials/' + escape(id), '交互包未声明该物料');
  return item;
}
function starts(data: Uint8Array, magic: number[], offset = 0): boolean {
  return data.byteLength >= offset + magic.length && magic.every((value, index) => data[offset + index] === value);
}
/** Verify a private byte snapshot without decoding into executable markup or changing caller data. */
export async function verifyScenePackMaterialBytes(rawDescriptor: ScenePackMaterialDescriptor, rawData: Uint8Array): Promise<void> {
  const descriptor = readDescriptor(rawDescriptor, '/materials/descriptor'), path = '/materials/' + escape(descriptor.id);
  if (!(rawData instanceof Uint8Array)) fail('PACK_MATERIAL_BYTES', path + '/data', '物料内容必须为Uint8Array');
  const data = new Uint8Array(rawData);
  if (data.byteLength !== descriptor.bytes) fail('PACK_MATERIAL_BYTES', path + '/bytes', '物料实际字节数与清单不一致');
  if (!globalThis.crypto?.subtle) fail('PACK_MATERIAL_CRYPTO', path + '/sha256', '当前宿主没有可用的SHA-256校验接口');
  let digest: ArrayBuffer;
  try { digest = await crypto.subtle.digest('SHA-256', data.buffer); }
  catch { fail('PACK_MATERIAL_CRYPTO', path + '/sha256', '宿主无法完成SHA-256校验，物料不可用'); }
  const hash = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
  if (hash !== descriptor.sha256.toLowerCase()) fail('PACK_MATERIAL_HASH', path + '/sha256', '物料SHA-256与清单不一致');
  if (descriptor.mediaType === 'text/plain' || descriptor.mediaType === 'application/json') {
    let decoded: string;
    try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(data); }
    catch { fail('PACK_MATERIAL_UTF8', path + '/data', '物料不是完整有效的UTF-8文本'); }
    if (descriptor.mediaType === 'application/json') {
      try { JSON.parse(decoded); } catch { fail('PACK_MATERIAL_JSON', path + '/data', 'JSON物料语法无效'); }
    }
    return;
  }
  const valid = descriptor.mediaType === 'image/png' ? starts(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    : descriptor.mediaType === 'image/jpeg' ? starts(data, [0xff, 0xd8, 0xff])
      : starts(data, [0x52, 0x49, 0x46, 0x46]) && starts(data, [0x57, 0x45, 0x42, 0x50], 8);
  if (!valid) fail('PACK_MATERIAL_TYPE', path + '/mediaType', '图片签名与声明的媒体类型不一致');
}
