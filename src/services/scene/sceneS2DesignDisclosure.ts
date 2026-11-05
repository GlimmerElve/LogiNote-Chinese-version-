import type { ScenePackDescription } from '../../types/sceneInteractionPack';
import type { S2CanvasDefinition } from '../../types/sceneS2';
import type { S2PluginManifest, S2PluginNode } from '../../types/sceneS2Plugin';
import { createS2BuilderCatalog, type S2BuilderCatalog, type S2BuilderCatalogSource } from './sceneS2BuilderCatalog';
import { projectS2BuilderGuide, type S2BuilderGuideStage } from './sceneS2BuildContext';

type Binding = Pick<S2PluginNode, 'pluginId' | 'pluginVersion' | 'capabilityId'>;
type Section = 'combinations' | 'assistant' | 'builder';
const SECTIONS: readonly Section[] = ['combinations', 'assistant', 'builder'];
const key = (ref: Binding) => `${ref.pluginId}@${ref.pluginVersion}/${ref.capabilityId}`;
function fail(detail: string): never { throw new Error(`S2 按需说明：${detail}`); }

/** A caller may offer one bounded correction for an unknown component identity.
 * Other malformed requests retain their existing errors and rejection behavior. */
export class S2DesignDisclosureReadError extends Error {
  readonly code = 'COMPONENT_NOT_FOUND' as const;
  constructor(readonly componentId: string) {
    super(`S2 按需说明：不存在组件说明 ${componentId}`);
    this.name = 'S2DesignDisclosureReadError';
  }
}

export const S2_DISCLOSURE_SELECT_PROMPT = `这是组件说明选择阶段。先按用户目标和需求理解，从discoveryIndex选择需要阅读的组件说明、包章节和精确能力接口；索引只有用途，不含配置方法，不能据此猜端口或生成场景。只返回{read:{componentIds?:[组件id],sections?:["combinations"|"assistant"|"builder"],capabilities?:[{pluginId,pluginVersion,capabilityId}]}}，不要生成配置或申请运行。有交互包时首次选择必须含sections:["builder"]；组件id和能力引用彼此独立，按用途分别选择。componentIds只能取discoveryIndex.components[].id；discoveryIndex.plugins[].id不能放入componentIds。可在同一对象附blueprintRead:[{id,version}]批量读取已有蓝图接口；蓝图必需能力由宿主一并提供。每批最多16个组件、16个能力、3个章节；已读说明持续提供，不重复读取。未选交互包且只需内容画布时可显式返回{read:{}}或{read:{capabilities:[]}}表示不用执行能力。读取只是查看声明，不执行插件或读取物料。`;

/** Each generation call is stateless: repeat the small follow-up contract, never the full manual. */
export const S2_DISCLOSURE_CONTINUE_PROMPT = `按需补读：若缺少说明，可先只返回{read:{componentIds?:[组件id],sections?:["builder"|"combinations"|"assistant"],capabilities?:[{pluginId,pluginVersion,capabilityId}]}}；不得混合场景配置、repair或执行字段。componentIds只能取discoveryIndex.components[].id；discoveryIndex.plugins[].id不能放入componentIds。只选择discoveryIndex中尚未出现在readState的条目；每批最多16组件、16能力、3章节。蓝图可用时同批附blueprintRead:[{id,version}]。contextReadsRemaining是还可补读的批数，modelCallsRemaining是本次回复后剩余的模型请求数；读完仍须再生成配置。读取只查看声明，不执行插件或读取物料。说明齐全时直接提交配置；未读接口不得猜测。`;
export const S2_DISCLOSURE_NO_MORE_READS_PROMPT = `本轮不能继续补读：读取批次或后续模型请求额度不足（含专项审查预留）。只提交基于已读接口的完整配置或当前允许的repair，不返回read或blueprintRead，也不猜测未读接口。jsonFormatRepair仅修复已有输出格式，不新增选读项。`;

export interface S2DesignDisclosureIndex {
  purpose?: string;
  components: Array<Pick<ScenePackDescription['components'][number], 'id' | 'name' | 'purpose'>>;
  sections: Array<{ id: Section; purpose: string }>;
  plugins: Array<{ id: string; version: string; label: string; capabilities: Array<{ id: string; kind: string; meaning: string }> }>;
}
export interface S2DesignDisclosureContext {
  discoveryIndex?: S2DesignDisclosureIndex;
  /** Declaration-read history only; never an execution or resource grant. */
  readState?: { componentIds: string[]; sections: Section[]; capabilities: Binding[] };
  pluginCatalog?: S2BuilderCatalog;
  interactionPack?: {
    purpose: string;
    components?: ScenePackDescription['components'];
    combinations?: string[];
    assistant?: { ownership: string; instructions: string };
    builder?: Partial<ScenePackDescription['builder']>;
  };
}
export interface S2DesignDisclosure {
  readonly index: S2DesignDisclosureIndex;
  read(request: unknown, extraCapabilities?: Binding[]): void;
  context(stage: S2BuilderGuideStage, compiledPrompt: string): S2DesignDisclosureContext;
  assertReady(): void;
  assertProvided(candidate: S2CanvasDefinition): void;
}

/** Reader input is model data, never executable properties or partially accepted selections. */
function object(raw: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) fail('读取请求必须是普通对象');
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  for (const field of Reflect.ownKeys(descriptors)) {
    const descriptor = typeof field === 'string' && descriptors[field];
    if (!descriptor || !allowed.includes(field as string) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('读取请求含未知字段或访问器');
  }
  return raw as Record<string, unknown>;
}
function list(raw: unknown, max: number, field: string): unknown[] {
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype || raw.length > max
    || Reflect.ownKeys(raw).length !== raw.length + 1) fail(`${field}必须是最多${max}项的数组`);
  for (let index = 0; index < raw.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, index);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail(`${field}不能含空项或访问器`);
  }
  return raw;
}
function binding(raw: unknown): Binding {
  const value = object(raw, ['pluginId', 'pluginVersion', 'capabilityId']);
  if (Object.keys(value).length !== 3 || [value.pluginId, value.pluginVersion, value.capabilityId].some(item => typeof item !== 'string' || !item.trim())) fail('能力需要精确pluginId/pluginVersion/capabilityId');
  return { pluginId: value.pluginId as string, pluginVersion: value.pluginVersion as string, capabilityId: value.capabilityId as string };
}

/** One detached per-build snapshot. Reading declarations never expands installation scope or authority. */
export function createS2DesignDisclosure(options: {
  catalog: S2BuilderCatalogSource;
  allTypeProviders?: readonly Pick<S2PluginManifest, 'dataTypes'>[];
  guide?: ScenePackDescription;
}): S2DesignDisclosure {
  const catalog = structuredClone(options.catalog), providers = structuredClone(options.allTypeProviders ?? []), guide = options.guide && structuredClone(options.guide);
  const available = new Map<string, Binding>();
  for (const plugin of catalog.plugins) for (const capability of plugin.capabilities) if (capability.kind !== 'editor') {
    const ref = { pluginId: plugin.id, pluginVersion: plugin.version, capabilityId: capability.id };
    available.set(key(ref), ref);
  }
  const components = new Map(guide?.components.map(component => [component.id, component]) ?? []);
  const index: S2DesignDisclosureIndex = {
    ...(guide ? { purpose: guide.purpose } : {}),
    components: guide?.components.map(({ id, name, purpose }) => ({ id, name, purpose })) ?? [],
    sections: guide ? [{ id: 'builder', purpose: '包的搭建约定；生成场景前必须读取' },
      { id: 'combinations', purpose: '组件之间的用法与组合说明' }, { id: 'assistant', purpose: '未来场景内互动Agent的策略参考' }] : [],
    plugins: catalog.plugins.map(plugin => ({ id: plugin.id, version: plugin.version, label: plugin.label,
      capabilities: plugin.capabilities.filter(capability => capability.kind !== 'editor').map(({ id, kind, meaning }) => ({ id, kind, meaning })) })),
  };
  const selectedComponents = new Set<string>(), selectedSections = new Set<Section>(), selectedCapabilities = new Set<string>();
  let hasRead = false;
  const selectedCatalog = (selection: Set<string>) => createS2BuilderCatalog({ ...catalog,
    plugins: catalog.plugins.flatMap(plugin => {
      const capabilities = plugin.capabilities.filter(capability => selection.has(key({ pluginId: plugin.id, pluginVersion: plugin.version, capabilityId: capability.id })));
      return capabilities.length ? [{ ...plugin, capabilities }] : [];
    }),
  }, [...catalog.plugins, ...providers]);
  const assertReady = () => {
    if (!hasRead) fail('尚未选择读取说明；请先返回read');
    if (guide && !selectedSections.has('builder')) fail('生成场景前必须显式读取builder章节');
  };
  return {
    get index() { return structuredClone(index); },
    read(rawRequest, extraCapabilities = []) {
      const request = object(rawRequest, ['componentIds', 'sections', 'capabilities']);
      const requestedComponents = request.componentIds === undefined ? [] : list(request.componentIds, 16, 'componentIds');
      const requestedSections = request.sections === undefined ? [] : list(request.sections, 3, 'sections');
      const requestedCapabilities = request.capabilities === undefined ? [] : list(request.capabilities, 16, 'capabilities');
      const nextComponents = new Set(selectedComponents), nextSections = new Set(selectedSections), nextCapabilities = new Set(selectedCapabilities);
      let missingComponent: S2DesignDisclosureReadError | undefined;
      for (const id of requestedComponents) {
        if (typeof id !== 'string') fail(`不存在组件说明 ${String(id)}`);
        if (!components.has(id)) { missingComponent ??= new S2DesignDisclosureReadError(id); continue; }
        if (nextComponents.has(id)) fail(`组件说明 ${id} 已读取或重复`);
        nextComponents.add(id);
      }
      for (const section of requestedSections) {
        if (!guide || !SECTIONS.includes(section as Section)) fail(`不存在包章节 ${String(section)}`);
        if (nextSections.has(section as Section)) fail(`包章节 ${String(section)} 已读取或重复`);
        nextSections.add(section as Section);
      }
      for (const raw of requestedCapabilities) {
        const ref = binding(raw), id = key(ref);
        if (!available.has(id)) fail(`能力 ${id} 不在本次目录范围或不是执行能力`);
        if (nextCapabilities.has(id)) fail(`能力 ${id} 已读取或重复`);
        nextCapabilities.add(id);
      }
      for (const raw of list(extraCapabilities, 16, '蓝图必需能力')) {
        const ref = binding(raw), id = key(ref);
        if (!available.has(id)) fail(`蓝图必需能力 ${id} 不在本次目录范围`);
        nextCapabilities.add(id); // Blueprint requirements can repeat a capability already explicitly read.
      }
      if (nextCapabilities.size > 16) fail('本次搭建最多读取16种执行能力');
      // Unknown component names are correctable only after every other namespace
      // passes validation. They must never mask a foreign or malformed capability.
      if (missingComponent) { selectedCatalog(nextCapabilities); throw missingComponent; }
      const changed = nextComponents.size > selectedComponents.size || nextSections.size > selectedSections.size || nextCapabilities.size > selectedCapabilities.size;
      const pureContentSelection = !guide && !hasRead && Object.keys(request).every(field => field === 'capabilities') && requestedCapabilities.length === 0 && extraCapabilities.length === 0;
      if (!changed && !pureContentSelection) fail('读取必须选择尚未提供的说明，不能空读或重复读取');
      selectedCatalog(nextCapabilities); // Resolve complete exact types before any selection is committed.
      selectedComponents.clear(); nextComponents.forEach(id => selectedComponents.add(id));
      selectedSections.clear(); nextSections.forEach(section => selectedSections.add(section));
      selectedCapabilities.clear(); nextCapabilities.forEach(id => selectedCapabilities.add(id));
      hasRead = true;
    },
    context(stage, compiledPrompt) {
      const result: S2DesignDisclosureContext = stage === 'review' ? {} : { discoveryIndex: structuredClone(index) };
      if (!hasRead) return result;
      if (stage !== 'review') result.readState = { componentIds: [...selectedComponents], sections: [...selectedSections],
        capabilities: [...selectedCapabilities].map(id => ({ ...available.get(id)! })),
      };
      result.pluginCatalog = selectedCatalog(selectedCapabilities);
      if (guide) {
        const projected = projectS2BuilderGuide({ ...guide,
          components: guide.components.filter(component => selectedComponents.has(component.id)),
          combinations: selectedSections.has('combinations') ? guide.combinations : [],
          builder: selectedSections.has('builder') ? guide.builder : { assemble: '', repair: '' },
          assistant: selectedSections.has('assistant') ? guide.assistant : { instructions: '', defaultAllowedOperations: [] },
          operations: [],
        }, stage, compiledPrompt);
        result.interactionPack = { purpose: projected.purpose,
          ...(selectedComponents.size ? { components: projected.components } : {}),
          ...(selectedSections.has('combinations') ? { combinations: projected.combinations } : {}),
          ...(selectedSections.has('assistant') ? { assistant: projected.assistant } : {}),
          ...(selectedSections.has('builder') && projected.builder ? { builder: projected.builder } : {}),
        };
      }
      return result;
    },
    assertReady,
    assertProvided(candidate) {
      assertReady();
      const references: Binding[] = [...(candidate.plugins ?? []), ...(candidate.initial.execution?.nodes ?? []),
        ...(candidate.business?.completion.reference.execution?.nodes ?? []), ...(candidate.business?.workflow.flatMap(step => step.capabilities) ?? [])];
      for (const ref of references) {
        const id = key(ref);
        if (!available.has(id)) fail(`候选能力 ${id} 不在本次目录范围`);
        if (!selectedCapabilities.has(id)) fail(`候选能力 ${id} 的接口详情尚未提供；请显式读取后重新生成`);
      }
    },
  };
}
