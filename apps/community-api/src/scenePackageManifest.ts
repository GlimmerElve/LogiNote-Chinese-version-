import type { SceneInteractionPackManifest, SceneInteractionPackRef } from './scenePackageTypes.js';
import { readScenePackMaterialDescriptors } from './scenePackageMaterial.js';

const idPattern = /^[a-z][a-z0-9-]{0,63}$/;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export function readSceneInteractionPackManifest(raw: unknown): SceneInteractionPackManifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('交互包清单必须是对象');
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  const version = descriptors.protocolVersion?.value;
  const allowed = ['protocolVersion', 'id', 'version', 'name', 'paradigm', 'paradigmApiVersion', 'requiredServices', ...(version === 2 ? ['materials'] : [])];
  if (Reflect.ownKeys(raw).length !== allowed.length || allowed.some(key => !descriptors[key]?.enumerable || !('value' in descriptors[key])))
    throw new Error('交互包清单字段不完整或包含访问器、隐藏字段');
  const value = raw as SceneInteractionPackManifest;
  if (![1, 2].includes(value.protocolVersion) || value.paradigm !== 'S2' || value.paradigmApiVersion !== 1) throw new Error('交互包协议或S2接口版本不支持');
  if (typeof value.id !== 'string' || !idPattern.test(value.id) || typeof value.version !== 'string' || !versionPattern.test(value.version)) throw new Error('交互包ID或版本无效');
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 80) throw new Error('交互包名称无效');
  if (!Array.isArray(value.requiredServices) || value.requiredServices.length > 3 || new Set(value.requiredServices).size !== value.requiredServices.length
    || value.requiredServices.some(service => !['execution', 'model', 'resources'].includes(service))) throw new Error('交互包要求了不支持的宿主服务');
  const result = value.protocolVersion === 2 ? { ...value, materials: readScenePackMaterialDescriptors(value.materials) } : value;
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 8192) throw new Error('交互包清单超过8192字节');
  return structuredClone(result);
}
export function readSceneInteractionPackRef(raw: unknown): SceneInteractionPackRef {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('场景交互包引用无效');
  const keys = Reflect.ownKeys(raw), descriptors = Object.getOwnPropertyDescriptors(raw);
  if (keys.length !== 2 || !['id', 'version'].every(key => descriptors[key]?.enumerable && 'value' in descriptors[key])) throw new Error('场景交互包引用只允许ID和版本');
  const { id, version } = raw as SceneInteractionPackRef;
  if (typeof id !== 'string' || !idPattern.test(id) || typeof version !== 'string' || !versionPattern.test(version)) throw new Error('场景交互包ID或版本无效');
  return { id, version };
}
