import type { SceneInteractionPackManifest, SceneInteractionPackRef, ScenePackMaterialDescriptor } from '../../types/sceneInteractionPack';
import { readSceneInteractionPackManifest, readSceneInteractionPackRef } from './sceneInteractionPackRegistry';
import { findScenePackMaterial, verifyScenePackMaterialBytes } from './sceneInteractionPackMaterialProtocol';

/** Optional separately built package assets for web previews. Electron always uses its installed directory. */
export function sceneInteractionPackAssets() {
  if (typeof document === 'undefined' || !document.baseURI || typeof fetch !== 'function') return undefined;
  const root = new URL('scene-interaction-packs/', document.baseURI);
  if (!['http:', 'https:'].includes(root.protocol)) return undefined;
  const read = async (file: string, max: number) => {
    const url = new URL(file, root);
    if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname) || url.search || url.hash)
      throw new Error('PACK_MATERIAL_SCOPE: 交互包资源必须位于当前同源目录');
    const response = await fetch(url, { credentials: 'same-origin', redirect: 'error' });
    if (!response.ok) throw new Error(`交互包资源读取失败（${response.status}）`);
    if (response.redirected || response.url && new URL(response.url).href !== url.href)
      throw new Error('PACK_MATERIAL_SCOPE: 交互包资源不能重定向');
    if (Number(response.headers?.get('Content-Length')) > max) throw new Error('交互包资源超过大小限制');
    const reader = response.body?.getReader();
    if (!reader) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > max) throw new Error('交互包资源超过大小限制');
      return bytes;
    }
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.byteLength;
        if (length > max) throw new Error('交互包资源超过大小限制');
        chunks.push(next.value);
      }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
  };
  const json = async (file: string, max = 8192) => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await read(file, max)));
  const base64 = (bytes: Uint8Array) => {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    return btoa(binary);
  };
  const manifest = async (ref: SceneInteractionPackRef) => {
    const value = readSceneInteractionPackManifest(await json(`${ref.id}/${ref.version}/manifest.json`));
    if (value.id !== ref.id || value.version !== ref.version) throw new Error('交互包清单与精确版本引用不一致');
    return value;
  };
  const materialBytes = async (ref: SceneInteractionPackRef, descriptor: ScenePackMaterialDescriptor) => {
    const bytes = await read(`${ref.id}/${ref.version}/${descriptor.path}`, descriptor.bytes);
    await verifyScenePackMaterialBytes(descriptor, bytes); return bytes;
  };
  return {
    async list(): Promise<{ managed: boolean; packs: SceneInteractionPackManifest[]; errors: string[] }> {
      try {
        const raw = await json('index.json', 64 * 8192 + 1024);
        if (!Array.isArray(raw) || raw.length > 64) throw new Error('交互包索引无效');
        const packs = raw.map(readSceneInteractionPackManifest);
        if (new Set(packs.map(pack => `${pack.id}@${pack.version}`)).size !== packs.length) throw new Error('交互包索引重复');
        return { managed: true, packs, errors: [] };
      } catch (error) { return { managed: true, packs: [], errors: [error instanceof Error ? error.message : '交互包资源不可用'] }; }
    },
    async load(raw: SceneInteractionPackRef) {
      const ref = readSceneInteractionPackRef(raw), prefix = `${ref.id}/${ref.version}/`;
      const value = await manifest(ref);
      const [bytes, styles] = await Promise.all([read(prefix + 'main.js', 524288), read(prefix + 'styles.css', 131072)]);
      if (value.protocolVersion === 2) for (const material of value.materials) await materialBytes(ref, material);
      return { manifest: value, codeBase64: base64(bytes), styles: new TextDecoder().decode(styles) };
    },
    async readMaterial(raw: SceneInteractionPackRef, id: string) {
      const ref = readSceneInteractionPackRef(raw), value = await manifest(ref);
      return { dataBase64: base64(await materialBytes(ref, findScenePackMaterial(value, id))) };
    },
  };
}
