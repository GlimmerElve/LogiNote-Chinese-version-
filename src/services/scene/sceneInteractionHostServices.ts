import type { ScenePackConfig, ScenePackHostServices } from '../../types/sceneInteractionPack';
import type { S2PluginHost } from './sceneS2PluginHost';
import { readS2Definition, readS2Document } from './sceneS2Canvas';
import type { SceneInteractionPackRef, SceneInteractionRuntime } from '../../types/sceneInteractionPack';
import { sceneInteractionPacks } from './sceneInteractionPacks';
import { s2BuiltinPluginInstallation, s2BuiltinPluginRegistry } from './sceneS2PluginRegistry';
import { selectS2Execution } from './sceneS2Workflow';
import type { S2LocalAdapter } from './sceneS2PluginInstallation';
import { registerScenePackLocalAdapter } from './sceneS2PluginInstallation';
import { assertS2ReadOnlyContent } from './sceneS2ReadOnly';
import { readScenePackRun, readScenePackRuntime, ScenePackProtocolError, validateScenePackConfig, scenePackAllowsExecution } from './sceneInteractionPackProtocol';
import { createScenePackMaterialScope, executeScenePackLocal } from './sceneInteractionPackMaterials';
import { ScenePackMaterialError } from './sceneInteractionPackMaterialProtocol';
import { assertS2PublicEdit } from './sceneS2PublicAuthoring';
import { closeS2PackageInteractionEvents, emitS2PackageInteractionEvent } from './sceneS2InteractionEvents';

function validateHostConfig(config: ScenePackConfig) {
  const definition = readS2Definition(config.definition), document = readS2Document(config.document, definition);
  assertS2ReadOnlyContent(definition.initial, document, { requirePresence: true });
}

function snapshotRunTargets(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype || !raw.length || raw.length > 40) throw new Error('运行目标必须是明确的节点ID数组');
  const properties = Object.getOwnPropertyDescriptors(raw);
  if (Reflect.ownKeys(properties).length !== raw.length + 1) throw new Error('运行目标不能含额外字段');
  const values = Array.from({ length: raw.length }, (_, index) => {
    const property = properties[String(index)];
    if (!property?.enumerable || !Object.hasOwn(property, 'value') || typeof property.value !== 'string' || !property.value.trim()) throw new Error('运行目标必须是完整的节点ID');
    return property.value as string;
  });
  if (new Set(values).size !== values.length) throw new Error('运行目标不能重复');
  return values;
}

/** A local package may append directly connected read-only result renderers.
 * The click still authorizes exactly the original data/effect graph: no new
 * model, tool, transform, condition or upstream dependency may be added. */
function matchesUserTargets(config: ScenePackConfig, approved: string[], candidate?: string[]) {
  if (JSON.stringify(approved) === JSON.stringify(candidate)) return true;
  if (!candidate || approved.some(id => !candidate.includes(id))) return false;
  try {
    const original = new Set(selectS2Execution(config.document, config.definition.plugins, approved).graph.nodes.map(node => node.id));
    const expanded = selectS2Execution(config.document, config.definition.plugins, candidate).graph;
    return expanded.nodes.filter(node => !original.has(node.id)).every(node => {
      const capability = s2BuiltinPluginRegistry().capability(node);
      const inputs = expanded.links.filter(link => link.target.nodeId === node.id);
      return capability.kind === 'renderer' && capability.effect === 'pure' && !capability.permissions.length
        && !capability.outputs.length && !node.when && inputs.length > 0 && inputs.every(link => original.has(link.source.nodeId));
    });
  } catch { return false; }
}

/** The package never receives the full execution host, credentials or filesystem APIs. */
export function createScenePackHostServices(host: S2PluginHost, readConfig: () => ScenePackConfig,
  applyConfig?: (config: ScenePackConfig) => void, options: { interactionPack?: SceneInteractionPackRef } = {}): ScenePackHostServices {
  let active = true;
  const optionsForPack = options.interactionPack;
  const needsMaterials = !!options.interactionPack && sceneInteractionPacks.resolve(options.interactionPack).manifest.protocolVersion === 2;
  const materials = needsMaterials ? createScenePackMaterialScope(options.interactionPack) : undefined;
  const eventIds = options.interactionPack ? sceneInteractionPacks.resolve(options.interactionPack).interaction?.events.map(event => event.id) ?? [] : [];
  if (needsMaterials && !materials)
    throw new ScenePackMaterialError('PACK_MATERIAL_UNAVAILABLE', '/materials', '当前包没有可用物料服务');
  const requireActive = () => { if (!active) throw new Error('场景宿主已关闭'); };
  return Object.freeze({
    readConfig() { requireActive(); return structuredClone(readConfig()); },
    validateConfig(config: ScenePackConfig) {
      requireActive(); validateHostConfig(config);
      if (options.interactionPack) assertS2PublicEdit(sceneInteractionPacks.resolve(options.interactionPack), readConfig(), config);
    },
    applyConfig(config: ScenePackConfig) {
      requireActive();
      if (!applyConfig) throw new Error('当前入口不允许修改场景配置');
      const definition = readS2Definition(config.definition), document = readS2Document(config.document, definition);
      assertS2ReadOnlyContent(definition.initial, document, { requirePresence: true });
      const current = readConfig();
      if (options.interactionPack) assertS2PublicEdit(sceneInteractionPacks.resolve(options.interactionPack), current, { definition, document });
      assertS2ReadOnlyContent(current.definition.initial, definition.initial, { requirePresence: true });
      assertS2ReadOnlyContent(current.definition.initial, document, { requirePresence: true });
      assertS2ReadOnlyContent(current.document, document);
      applyConfig({ definition, document });
    },
    run(targets, notify, options) {
      requireActive();
      if (optionsForPack && !scenePackAllowsExecution(sceneInteractionPacks.resolve(optionsForPack))) throw new ScenePackProtocolError('PACK_EXECUTION_DISABLED', '/execution', '当前插件包仅编辑，不提供执行流程');
      const snapshot = snapshotRunTargets(targets);
      // Only the terminal may supply the one-shot action. Project package options
      // to public fields, even for JavaScript packages which bypass TypeScript.
      const action = userActions.get(host);
      const direct = action && action.ready && !action.consumed && matchesUserTargets(readConfig(), action.targets, snapshot);
      if (direct) action.consumed = true;
      return host.enqueueWorkflow(snapshot, notify, { force: options?.force === true,
        ...(direct ? { modelConfirmation: 'user-action' as const } : {}) });
    },
    cancel(id) { requireActive(); host.cancelWorkflow(id); },
    readResults() { requireActive(); return host.workflowHistory(); },
    ...(eventIds.length ? { emitEvent(nodeId: string, event: string, data: import('../../types/sceneS2Plugin').S2Json) {
      requireActive();
      if (!eventIds.includes(event)) throw new Error('当前包没有声明该交互事件');
      emitS2PackageInteractionEvent(host, nodeId, event, data);
    } } : {}),
    ...(materials ? { materials } : {}),
    close() { if (!active) return; active = false; try { materials?.dispose(); } finally { host.close(); } },
  });
}

type BoundRuntime = { reference: string; config: ScenePackConfig; runtime: SceneInteractionRuntime; services: ScenePackHostServices };
const runtimes = new WeakMap<S2PluginHost, BoundRuntime>();
const userActions = new WeakMap<S2PluginHost, { targets: string[]; consumed: boolean; ready: boolean }>();

/** Retire package-owned work/listeners together with the canvas host. */
export function closeSceneInteractionHost(host: S2PluginHost | null | undefined) {
  if (!host) return;
  const bound = runtimes.get(host);
  runtimes.delete(host);
  closeS2PackageInteractionEvents(host);
  try { bound?.runtime.dispose(); } finally { try { bound?.services.close(); } finally { host.close(); } }
}

/** One package runtime per existing host, with the existing scheduler as its execution service. */
export function enqueueSceneInteractionWorkflow(host: S2PluginHost, config: ScenePackConfig,
  reference: SceneInteractionPackRef | null | undefined, targets?: string[], notify?: () => void, options?: { force?: boolean }): ReturnType<S2PluginHost['enqueueWorkflow']> {
  // An unbound canvas is a plain S2 canvas. Choosing a default business package belongs to the UI compatibility layer.
  if (!reference) return host.enqueueWorkflow(targets, notify, { force: options?.force === true });
  const ref = reference, pack = sceneInteractionPacks.resolve(ref), key = `${ref.id}@${ref.version}`;
  if (!scenePackAllowsExecution(pack)) throw new ScenePackProtocolError('PACK_EXECUTION_DISABLED', '/execution', '当前插件包仅编辑，画布修改直接生效');
  let bound = runtimes.get(host);
  if (bound && bound.reference !== key) throw new Error('运行中不能更换交互包，请结束本局后重新打开');
  // Business checks run against a detached current snapshot at execution, not while saving editable drafts.
  const snapshot = structuredClone(config);
  assertS2PublicEdit(pack, snapshot, snapshot);
  if (bound) bound.services.validateConfig(snapshot); else validateHostConfig(snapshot);
  const issues = validateScenePackConfig(pack, structuredClone(snapshot));
  if (issues.length) throw new ScenePackProtocolError('PACK_CONFIG_INVALID', issues[0].path, issues[0].message);
  if (!bound) {
    const services = createScenePackHostServices(host, () => bound!.config, undefined, { interactionPack: ref });
    bound = { reference: key, config: snapshot, runtime: null as unknown as SceneInteractionRuntime, services };
    try { bound.runtime = readScenePackRuntime(pack.createRuntime(structuredClone(snapshot), services)); }
    catch (error) {
      // A failed constructor must not retain live host services or publish work after rejection.
      services.close();
      throw error;
    }
    runtimes.set(host, bound);
  }
  bound.config = snapshot;
  const action = userActions.get(host);
  if (action) action.ready = true;
  try { return readScenePackRun(bound.runtime.run(targets, notify, options)) as ReturnType<S2PluginHost['enqueueWorkflow']>; }
  catch (error) {
    if (error instanceof ScenePackProtocolError) closeSceneInteractionHost(host);
    throw error;
  }
}

/** Terminal-only entry for an explicit click on a current canvas control.
 * The selected package still validates and runs its runtime. Its first matching
 * synchronous scheduling call consumes this action; no flag enters package data. */
export function enqueueSceneInteractionUserWorkflow(host: S2PluginHost, config: ScenePackConfig,
  reference: SceneInteractionPackRef | null | undefined, targets: string[], notify?: () => void): ReturnType<S2PluginHost['enqueueWorkflow']> {
  const snapshot = snapshotRunTargets(targets)!;
  if (!reference) return host.enqueueWorkflow(snapshot, notify, { force: true, modelConfirmation: 'user-action' });
  if (userActions.has(host)) throw new Error('当前运行操作尚未结束');
  const action = { targets: [...snapshot], consumed: false, ready: false };
  userActions.set(host, action);
  try { return enqueueSceneInteractionWorkflow(host, config, reference, snapshot, notify, { force: true }); }
  finally { userActions.delete(host); }
}

/** Exact local capabilities belong to the selected package. Resource/model authority stays in the host. */
export function scenePackLocalAdapter(reference?: SceneInteractionPackRef | null): S2LocalAdapter {
  const selected = reference ? sceneInteractionPacks.resolve(reference) : undefined;
  return registerScenePackLocalAdapter(async (call, inputs, signal) => {
    if (reference !== undefined && !sceneInteractionPacks.isCapabilityInScope(call.pluginId, call.pluginVersion, reference))
      throw new Error(`PACK_CAPABILITY_OUT_OF_SCOPE: 当前交互包不能调用其他包的能力 ${call.pluginId}@${call.pluginVersion}/${call.capabilityId}`);
    if (!sceneInteractionPacks.isSharedCapability(call.pluginId, call.pluginVersion) && selected?.capabilities.some(cap => cap.id === call.pluginId && cap.version === call.pluginVersion
      && cap.capabilities.some(action => action.id === call.capabilityId && ['transform', 'validator'].includes(action.kind))))
      return executeScenePackLocal(selected, call, inputs, signal);
    return s2BuiltinPluginInstallation().execute(call, inputs, signal);
  });
}
