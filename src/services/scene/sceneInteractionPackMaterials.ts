import type { SceneInteractionPack, SceneInteractionPackManifest, SceneInteractionPackRef, ScenePackMaterialScope } from '../../types/sceneInteractionPack';
import type { S2Json, S2PluginInvocation } from '../../types/sceneS2Plugin';
import { findScenePackMaterial, ScenePackMaterialError, verifyScenePackMaterialBytes } from './sceneInteractionPackMaterialProtocol';

type Reader = (id: string) => Promise<{ dataBase64: string }>;
type Provider = { manifest: SceneInteractionPackManifest; reader: Reader; available: boolean; scopes: Set<{ dispose(): void }> };
const providers = new Map<string, Provider>();
let availableKeys: Set<string> | undefined;
const key = (ref: SceneInteractionPackRef) => `${ref.id}@${ref.version}`;
const pointer = (id: string) => '/materials/' + id.replace(/~/g, '~0').replace(/\//g, '~1');
function fail(code: string, id: string, message: string): never { throw new ScenePackMaterialError(code, pointer(id), message); }

async function bytes(provider: Provider, id: string) {
  const descriptor = findScenePackMaterial(provider.manifest, id);
  const payload = await provider.reader(id);
  const property = payload && typeof payload === 'object' ? Object.getOwnPropertyDescriptor(payload, 'dataBase64') : undefined;
  const encoded = property && 'value' in property ? property.value : undefined;
  if (typeof encoded !== 'string' || encoded.length !== Math.ceil(descriptor.bytes / 3) * 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
    fail('PACK_MATERIAL_TRANSPORT', id, '物料传输不是完整的有界 Base64 数据');
  const binary = atob(encoded), data = Uint8Array.from(binary, char => char.charCodeAt(0));
  await verifyScenePackMaterialBytes(descriptor, data);
  return { id: descriptor.id, mediaType: descriptor.mediaType, data };
}

/** Validate every declared file before code activation; commit only after the package is accepted. */
export async function prepareScenePackMaterials(manifest: SceneInteractionPackManifest, reader: Reader): Promise<() => void> {
  if (manifest.protocolVersion === 1) return () => {};
  const provider: Provider = { manifest: structuredClone(manifest), reader, available: true, scopes: new Set() };
  for (const descriptor of manifest.materials) await bytes(provider, descriptor.id);
  return () => {
    if (availableKeys && !availableKeys.has(key(manifest))) fail('PACK_MATERIAL_UNAVAILABLE', '', '物料校验期间所属包已撤回');
    const previous = providers.get(key(manifest));
    if (previous) for (const scope of [...previous.scopes]) scope.dispose();
    providers.set(key(manifest), provider);
  };
}

/** Directory availability revokes live scopes, including display leases and pending reads. */
export function setScenePackMaterialAvailability(references: SceneInteractionPackRef[]) {
  const available = new Set(references.map(key));
  availableKeys = available;
  for (const [identity, provider] of providers) {
    provider.available = available.has(identity);
    if (!provider.available) for (const scope of [...provider.scopes]) scope.dispose();
  }
}

/** Host-only factory. A package receives an ID-only scope and cannot choose another owner. */
export function createScenePackMaterialScope(reference?: SceneInteractionPackRef | null): ScenePackMaterialScope | undefined {
  const provider = reference ? providers.get(key(reference)) : undefined;
  if (!provider) return undefined;
  if (!provider.available) fail('PACK_MATERIAL_UNAVAILABLE', '', '物料所属包当前不可用');
  let active = true;
  const urls = new Set<string>();
  const lifetime = new AbortController();
  const check = (id = '', signal?: AbortSignal) => {
    if (!active || !provider.available) fail('PACK_MATERIAL_CLOSED', id, '物料读取作用域已释放');
    if (signal?.aborted) fail('PACK_MATERIAL_CANCELLED', id, '物料读取已取消');
  };
  const interruptible = <T>(pending: Promise<T>, id: string, signal?: AbortSignal): Promise<T> => new Promise((resolve, reject) => {
    const signals = signal ? [lifetime.signal, signal] : [lifetime.signal];
    const cleanup = () => signals.forEach(item => item.removeEventListener('abort', interrupted));
    const interrupted = () => { cleanup(); try { check(id, signal); } catch (error) { reject(error); } };
    signals.forEach(item => item.addEventListener('abort', interrupted, { once: true }));
    pending.then(value => { cleanup(); try { check(id, signal); resolve(value); } catch (error) { reject(error); } }, error => { cleanup(); reject(error); });
    if (signals.some(item => item.aborted)) interrupted();
  });
  const scope: ScenePackMaterialScope = {
    list() { check(); return provider.manifest.protocolVersion === 2 ? structuredClone(provider.manifest.materials) : []; },
    async read(id, signal) {
      check(id, signal);
      // Check membership before crossing IPC; unknown IDs never become file paths.
      findScenePackMaterial(provider.manifest, id);
      const result = await interruptible(bytes(provider, id), id, signal);
      check(id, signal);
      return result;
    },
    async openUrl(id, signal) {
      const result = await scope.read(id, signal);
      check(id, signal);
      if (typeof URL.createObjectURL !== 'function') fail('PACK_MATERIAL_URL_UNAVAILABLE', id, '当前宿主不能创建物料展示引用');
      const buffer = new ArrayBuffer(result.data.byteLength);
      new Uint8Array(buffer).set(result.data);
      const url = URL.createObjectURL(new Blob([buffer], { type: result.mediaType }));
      urls.add(url);
      return { url, release() { if (urls.delete(url)) URL.revokeObjectURL(url); } };
    },
    dispose() {
      if (!active) return;
      active = false;
      lifetime.abort();
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear(); provider.scopes.delete(scope);
    },
  };
  provider.scopes.add(scope);
  return Object.freeze(scope);
}

/** A local component gets a fresh invocation scope, retired on success, failure and cancellation. */
export async function executeScenePackLocal(pack: SceneInteractionPack, call: S2PluginInvocation,
  inputs: Record<string, S2Json[]>, signal: AbortSignal) {
  if (pack.manifest.protocolVersion === 1) return pack.executeLocal(call, inputs, signal);
  const materials = pack.manifest.protocolVersion === 2 ? createScenePackMaterialScope(pack.manifest) : undefined;
  if (pack.manifest.protocolVersion === 2 && !materials) fail('PACK_MATERIAL_UNAVAILABLE', '', '交互包尚未接入物料服务');
  const close = () => materials?.dispose();
  signal.addEventListener('abort', close, { once: true });
  try {
    if (signal.aborted) { close(); fail('PACK_MATERIAL_CANCELLED', '', '节点调用已取消'); }
    return await pack.executeLocal(call, inputs, signal, materials ? { materials } : undefined);
  } finally { signal.removeEventListener('abort', close); close(); }
}
