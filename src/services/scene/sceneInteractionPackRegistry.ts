import type { SceneInteractionPack, SceneInteractionPackRef } from '../../types/sceneInteractionPack';
import { readSceneInteractionPackRef } from './sceneInteractionPackManifest';
import { readSceneInteractionPack } from './sceneInteractionPackProtocol';
export { readSceneInteractionPackManifest, readSceneInteractionPackRef } from './sceneInteractionPackManifest';

/** Terminal-owned, exact-version registrations. Code installation is separate from scene selection. */
export class SceneInteractionPackRegistry {
  private readonly packs = new Map<string, SceneInteractionPack>();
  private available: Set<string> | undefined;
  private sharedCapabilities: ReadonlySet<string> | undefined;
  private key(ref: SceneInteractionPackRef) { return `${ref.id}@${ref.version}`; }
  /** Host bootstrap only. Package discovery/activation cannot change this set. */
  setSharedCapabilities(refs: ReadonlyArray<{ id: string; version: string }>) {
    const next = new Set(refs.map(ref => `${ref.id}@${ref.version}`));
    if (this.sharedCapabilities && (next.size !== this.sharedCapabilities.size || [...next].some(key => !this.sharedCapabilities!.has(key))))
      throw new Error('宿主公共组件归属初始化后不能更改');
    this.sharedCapabilities = next;
  }
  isSharedCapability(id: string, version: string) { return this.sharedCapabilities?.has(`${id}@${version}`) === true; }
  register(pack: SceneInteractionPack, replace = false) {
    const checked = readSceneInteractionPack(pack), manifest = checked.manifest, key = this.key(manifest);
    if (this.packs.has(key) && !replace) throw new Error(`交互包已注册：${key}`);
    // Copy ownership metadata; a caller cannot change the registered identity afterwards.
    this.packs.set(key, Object.freeze({ ...checked, manifest: Object.freeze(manifest) }));
  }
  resolve(raw: SceneInteractionPackRef) {
    const ref = readSceneInteractionPackRef(raw), pack = this.packs.get(this.key(ref));
    if (!pack || this.available && !this.available.has(this.key(ref))) throw new Error(`缺少交互包 ${this.key(ref)}，场景配置已保留，请安装对应版本`);
    return pack;
  }
  catalog() { return [...this.packs.values()].map(pack => structuredClone(pack.manifest)); }
  capabilityHelp(ref: { pluginId: string; pluginVersion: string; capabilityId: string }) {
    const owner = [...this.packs.values()].find(pack => this.isAvailable(pack.manifest) && pack.capabilities.some(plugin =>
      plugin.id === ref.pluginId && plugin.version === ref.pluginVersion && plugin.capabilities.some(cap => cap.id === ref.capabilityId)));
    const help = owner?.help?.[`${ref.pluginId}/${ref.capabilityId}`];
    return help ? structuredClone(help) : undefined;
  }
  setAvailable(refs: SceneInteractionPackRef[]) { this.available = new Set(refs.map(ref => this.key(readSceneInteractionPackRef({ id: ref.id, version: ref.version })))); }
  isAvailable(ref: SceneInteractionPackRef) { return !this.available || this.available.has(this.key(ref)); }
  isCapabilityAvailable(id: string, version: string) {
    if (this.isSharedCapability(id, version)) return true;
    const owners = [...this.packs.values()].filter(pack => pack.capabilities.some(cap => cap.id === id && cap.version === version));
    return owners.length === 0 || owners.some(pack => this.isAvailable(pack.manifest));
  }
  /** A selected package may use its own exact releases and capabilities shared by the terminal. */
  isCapabilityInScope(id: string, version: string, reference?: SceneInteractionPackRef | null) {
    if (reference === undefined) return this.isCapabilityAvailable(id, version);
    if (reference === null) return this.isSharedCapability(id, version) || this.isCapabilityAvailable(id, version)
      && ![...this.packs.values()].some(pack => pack.capabilities.some(cap => cap.id === id && cap.version === version));
    const selected = this.resolve(reference);
    const matches = (pack: SceneInteractionPack) => pack.capabilities.some(cap => cap.id === id && cap.version === version);
    return this.isSharedCapability(id, version) || this.isCapabilityAvailable(id, version) && (matches(selected) || ![...this.packs.values()].some(matches));
  }
}
