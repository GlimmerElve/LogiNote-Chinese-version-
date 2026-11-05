import React from 'react';
import type { SceneInteractionPackRef, SceneInteractionPackManifest } from '../../types/sceneInteractionPack';
import { scenePackEditorServices } from './scenePackEditorServices';
import { sceneInteractionPacks } from './sceneInteractionPacks';
import { SceneInteractionPackRegistry, readSceneInteractionPackManifest } from './sceneInteractionPackRegistry';
import { installSceneInteractionCapabilities } from './sceneS2PluginRegistry';
import { sceneInteractionPackAssets } from './sceneInteractionPackAssets';
import { readSceneInteractionPack, ScenePackProtocolError } from './sceneInteractionPackProtocol';
import { prepareScenePackMaterials, setScenePackMaterialAvailability } from './sceneInteractionPackMaterials';
import { ScenePackMaterialError } from './sceneInteractionPackMaterialProtocol';
import { scenePackStyles } from './sceneInteractionPackStyles';

interface PackApi {
  importPackage?(): Promise<{ canceled?: boolean; manifest?: SceneInteractionPackManifest; alreadyInstalled?: boolean }>;
  list(): Promise<{ managed: boolean; packs: SceneInteractionPackManifest[]; errors: string[] }>;
  load(ref: SceneInteractionPackRef): Promise<{ manifest: unknown; codeBase64: string; styles: string }>;
  readMaterial?(ref: SceneInteractionPackRef, id: string): Promise<{ dataBase64: string }>;
}
let discovery: Promise<Awaited<ReturnType<PackApi['list']>> | undefined>;
let assetApi: PackApi | undefined;
const loads = new Map<string, Promise<void>>();
/** Native-selected trusted ZIP only; never accepts paths or code from an Agent. */
export async function importSceneInteractionPack() {
  const store = api();
  if (!store?.importPackage) throw new Error('S2 ZIP 导入需要支持交互包安装的桌面版');
  const result = await store.importPackage();
  if (!result.canceled) discovery = undefined;
  return result;
}
function api() {
  if (typeof window === 'undefined') return undefined;
  const installed = (window as unknown as { electronAPI?: { sceneInteractionPacks?: PackApi } }).electronAPI?.sceneInteractionPacks;
  if (installed) return installed;
  if (assetApi) return assetApi;
  // Explicitly registered embedded/test hosts need no asset transport.
  if (sceneInteractionPacks.catalog().length) return undefined;
  assetApi = sceneInteractionPackAssets();
  return assetApi;
}
/** Discover plain manifests only. Listing choices never activates package code. */
export async function listSceneInteractionPacks(options: { refresh?: boolean } = {}) {
  const store = api();
  const fallback = (errors: string[] = []) => {
    const packs = sceneInteractionPacks.catalog();
    sceneInteractionPacks.setAvailable(packs);
    setScenePackMaterialAvailability(packs);
    return { managed: false, packs, errors: [...errors] };
  };
  if (!store) return fallback();
  if (!discovery || options.refresh) {
    const pending = store.list();
    discovery = pending;
    // Do not cache failed discovery. An older rejected refresh must never evict
    // a newer in-flight request or its successfully published directory listing.
    void pending.catch(() => { if (discovery === pending) discovery = undefined; });
  }
  const request = discovery, state = await request;
  if (request !== discovery) return listSceneInteractionPacks();
  if (!state.managed) return fallback(state.errors);
  const packs: SceneInteractionPackManifest[] = [], errors = [...state.errors];
  for (const raw of state.packs) {
    try { packs.push(readSceneInteractionPackManifest(raw)); }
    catch (error) { errors.push(error instanceof Error ? error.message : '交互包清单无效'); }
  }
  sceneInteractionPacks.setAvailable(packs);
  setScenePackMaterialAvailability(packs);
  return { managed: true, packs, errors };
}
export async function loadSceneInteractionPack(ref: SceneInteractionPackRef) {
  const store = api();
  if (!store) { sceneInteractionPacks.resolve(ref); return; }
  const state = await listSceneInteractionPacks();
  if (!state.managed) { sceneInteractionPacks.resolve(ref); return; }
  if (!sceneInteractionPacks.isAvailable(ref)) throw new Error(`缺少交互包 ${ref.id}@${ref.version}，请导入相同版本并刷新后重试；场景配置不会被删除`);
  const key = `${ref.id}@${ref.version}`;
  let pending = loads.get(key);
  if (!pending) {
    pending = (async () => {
      const payload = await store.load(ref), manifest = readSceneInteractionPackManifest(payload.manifest);
      if (manifest.id !== ref.id || manifest.version !== ref.version) throw new Error('加载的交互包身份与场景不一致');
      const css = payload.styles ? scenePackStyles(ref, payload.styles) : '';
      if (manifest.protocolVersion === 2 && typeof store.readMaterial !== 'function')
        throw new ScenePackMaterialError('PACK_MATERIAL_SERVICE_MISSING', '/materials', '当前宿主缺少包内物料读取接口');
      const commitMaterials = await prepareScenePackMaterials(manifest, id => store.readMaterial!({ id: ref.id, version: ref.version }, id));
      // Bundled ESM has no relative imports. No eval/Function or Node access is exposed.
      const module = await import(/* @vite-ignore */ `data:text/javascript;base64,${payload.codeBase64}`);
      if (typeof module.activate !== 'function') throw new Error('交互包缺少activate入口');
      const pack = readSceneInteractionPack(module.activate({ editor: scenePackEditorServices, ui: { react: React } }));
      const actual = readSceneInteractionPackManifest(pack.manifest);
      const identity = (value: typeof manifest) => JSON.stringify([value.id, value.version, value.protocolVersion, value.paradigm,
        value.paradigmApiVersion, value.name, [...value.requiredServices].sort(), value.protocolVersion === 2 ? value.materials : null]);
      if (identity(actual) !== identity(manifest)) throw new Error('交互包入口与清单不一致');
      // Check the complete entry contract before publishing any new capability.
      new SceneInteractionPackRegistry().register(pack);
      if (!sceneInteractionPacks.isAvailable(ref)) throw new ScenePackProtocolError('PACK_UNAVAILABLE', '/manifest', '交互包在加载期间已撤回');
      installSceneInteractionCapabilities(pack);
      sceneInteractionPacks.register(pack, true);
      commitMaterials();
      if (css) {
        const style = document.createElement('style'); style.dataset.sceneInteractionPack = key;
        style.textContent = css;
        document.head.appendChild(style);
      }
    })();
    loads.set(key, pending);
    void pending.catch(() => { if (loads.get(key) === pending) loads.delete(key); });
  }
  await pending;
}
