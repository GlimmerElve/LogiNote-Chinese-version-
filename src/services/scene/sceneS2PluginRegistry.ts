import { sceneInteractionPacks } from './sceneInteractionPacks';
import type { S2PluginCapability, S2PluginManifest, S2PluginNode, S2PluginPort } from '../../types/sceneS2Plugin';
import { S2PluginInstallation, type S2PluginPackage } from './sceneS2PluginInstallation';
import { canonicalS2Json } from './sceneS2PluginProtocol';
import type { SceneInteractionPack, SceneInteractionPackRef } from '../../types/sceneInteractionPack';
import { executeS2Simulation, S2_SIMULATION_PLUGIN } from './sceneS2Simulation';
import { executeS2Merge, S2_MERGE_PLUGIN } from './sceneS2Merge';
import { S2_HUMAN_PLUGIN } from './sceneS2Human';
import { isS2ModelSessionCapability, isS2ModelSessionImplementation, S2_MODEL_SESSION_BRIDGE } from './sceneS2ModelBridge';
import { S2_CONTROL_KINDS } from './sceneS2Controls';
import { executeS2Structured } from './sceneS2Structured';
import { executeS2JsonCheck } from './sceneS2JsonCheck';
import { S2_TEXT_RESOURCE_PLUGIN } from './sceneS2TextResource';
import { S2_PROJECT_NOTES_PLUGIN } from './sceneS2ProjectNotes';
import { readSceneInteractionPack } from './sceneInteractionPackProtocol';
import { executeScenePackLocal } from './sceneInteractionPackMaterials';

/** Trusted builtin registration, not a model-editable "installed plugins" list. */
export const S2_CORE_PLUGIN: S2PluginManifest = {
  protocolVersion: 1, id: 'core', version: '1.0.0', label: 'S2 基础组件',
  meaning: '应用已安装的文本与多行编辑组件；不提供外部工具执行器。', dependencies: [],
  dataTypes: [
    { id: 'core.text', version: 1, meaning: '完整的原始文本；不是已验证事实、公式证明或工具凭据。', schema: { kind: 'string', maxLength: 6000 } },
    { id: 'core.number', version: 1, meaning: '无单位的有限数值；带单位量必须声明专门类型和显式转换。', schema: { kind: 'number', integer: false, minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER } },
    { id: 'core.image', version: 1, meaning: '用户本局明确选择的完整静态图片资源句柄；不是文本、路径、URL或图片解读，也不是访问授权。', schema: { kind: 'object', required: ['resourceId'], fields: { resourceId: { kind: 'string', maxLength: 120 } } } },
    { id: 'core.assessment', version: 1, meaning: '内容检查结果，需说明依据；不等同于插件执行是否成功。', schema: { kind: 'object', required: ['status', 'reason', 'evidence'], fields: {
      status: { kind: 'string', maxLength: 16, enum: ['pass', 'fail', 'unknown'] }, reason: { kind: 'string', maxLength: 6000 },
      evidence: { kind: 'array', maxItems: 32, item: { kind: 'string', maxLength: 1000 } },
    } } },
  ],
  capabilities: ['text', 'multiline'].map(id => ({ id, kind: 'editor', meaning: id === 'text' ? '已安装的单行文本字段；用户填写或确认修改。' : '已安装的多行文本字段；保留用户原文和换行。',
    inputs: [], outputs: [{ id: 'value', label: '字段值', meaning: '用户当前完整字段内容', type: { id: 'core.text', version: 1 }, required: true, multiple: false }],
    effect: 'pure', permissions: [], confirmation: 'none', retry: 'manual-only', timeoutMs: 1000,
  })),
};
// Builtin releases remain immutable. Trusted package releases may be added at startup.
export const S2_JSON_CHECK_PLUGIN: S2PluginManifest = {
  protocolVersion: 1, id: 'json-check', version: '1.0.0', label: 'JSON 格式检查',
  meaning: '本地检查完整文本是否符合 JSON 语法，不验证业务含义、事实或用户自定义 schema。',
  dependencies: [{ id: 'core', version: '1.0.0' }], dataTypes: [],
  capabilities: [{ id: 'validate', kind: 'validator', meaning: '只检查 JSON 语法；不自动修复、不执行代码。',
    inputs: [{ id: 'text', label: '完整文本', meaning: '原样提交的文本，不剥离代码围栏或猜测缺失内容。', type: { id: 'core.text', version: 1 }, required: true, multiple: false }],
    outputs: [{ id: 'assessment', label: '格式评价', meaning: 'JSON 语法检查结果，不代表内容正确。', type: { id: 'core.assessment', version: 1 }, required: true, multiple: false }],
    effect: 'pure', permissions: [], confirmation: 'none', retry: 'manual-only', timeoutMs: 1000 }],
};
const port = (id: string, type: string, required = true): S2PluginPort => ({ id, label: id, meaning: `${id} 完整数据`, type: { id: type, version: 1 }, required, multiple: false });
const local = (id: string, meaning: string, inputs: S2PluginPort[], outputs: S2PluginPort[], kind: S2PluginCapability['kind'] = 'transform'): S2PluginCapability => ({
  id, meaning, inputs, outputs, kind, effect: 'pure', permissions: [], confirmation: 'none', retry: 'manual-only', timeoutMs: 1000,
});
export const S2_STRUCTURED_PLUGIN: S2PluginManifest = {
  protocolVersion: 1, id: 'structured-data', version: '1.0.0', label: '结构化数据转换',
  meaning: '显式解析、JSON Pointer 提取、序列化、记录数组转表格及反向转换；无代码执行或隐式类型转换。',
  dependencies: [{ id: 'core', version: '1.0.0' }],
  dataTypes: [
    { id: 'structured-data.value', version: 1, meaning: '完整有界 JSON 值；不是任意文本、事实、证明或可执行代码；拒绝保留键及非有限数。', schema: { kind: 'json', maxDepth: 8, maxEntries: 2048, maxBytes: 24000 } },
    { id: 'structured-data.table', version: 1, meaning: '无损记录表：列名及单元格 presence/value；缺失与 null 区分，单元格仅标量。', schema: { kind: 'object', required: ['columns', 'rows'], fields: {
      columns: { kind: 'array', maxItems: 24, item: { kind: 'string', maxLength: 120 } },
      rows: { kind: 'array', maxItems: 100, item: { kind: 'array', maxItems: 24, item: { kind: 'object', required: ['present', 'value'], fields: {
        present: { kind: 'boolean' }, value: { kind: 'json', maxDepth: 1, maxEntries: 1, maxBytes: 2000 },
      } } } },
    } } },
  ], capabilities: [
    local('parse-json', '完整文本显式解析为有界 JSON；不剥离围栏、不修补、不允许保留键或非有限数。', [port('text', 'core.text')], [port('value', 'structured-data.value')]),
    local('select', '按 JSON Pointer 提取：空路径表示整体；/items/0；~0为~，~1为/；不运行表达式或猜路径。', [port('value', 'structured-data.value'), port('pointer', 'core.text')], [port('value', 'structured-data.value')]),
    local('stringify', 'JSON 显式转换为紧凑、稳定键序的文本；输出超限会失败，不截断。', [port('value', 'structured-data.value')], [port('text', 'core.text')]),
    local('to-table', '仅将标量字段组成的记录数组无损转表格；不自动展开嵌套结构，缺失与null区分。', [port('value', 'structured-data.value')], [port('table', 'structured-data.table')]),
    local('table-to-json', '将规范记录表还原为 JSON 对象数组；保留列名、值类型、缺失与null区别。', [port('table', 'structured-data.table')], [port('value', 'structured-data.value')]),
  ],
};
export const S2_STRUCTURED_VIEW_PLUGIN: S2PluginManifest = {
  protocolVersion: 1, id: 'structured-view', version: '1.0.0', label: '结构化数据展示', meaning: '受控只读 JSON 树和表格视图；不执行 HTML/JS，不产生新事实。',
  dependencies: [{ id: 'structured-data', version: '1.0.0' }, { id: 'core', version: '1.0.0' }], dataTypes: [], capabilities: [
    local('text', '只读原样展示完整文本；不执行 HTML、不改写内容、不评审或请求模型。', [{ ...port('text', 'core.text'), label: '要展示的文本' }], [], 'renderer'),
    local('json-tree', '以可展开的 JSON 树展示完整产物；界面省略明确标记，不影响下游原始数据。', [port('value', 'structured-data.value')], [], 'renderer'),
    local('table', '只读表格及本地选列柱状/折线预览；表格显示前20行，图表和下游使用完整数据。', [port('table', 'structured-data.table')], [], 'renderer'),
  ],
};
// Reviewed code bindings live beside their declarations. Adding a manifest capability without
// a compatible implementation fails the whole installation before it can be advertised.
const builtinPackages: S2PluginPackage[] = [
  { manifest: S2_CORE_PLUGIN, implementations: { text: { kind: 'editor', control: 'text' }, multiline: { kind: 'editor', control: 'multiline' } } },
  { manifest: S2_JSON_CHECK_PLUGIN, implementations: { validate: { kind: 'local', execute: executeS2JsonCheck } } },
  { manifest: S2_STRUCTURED_PLUGIN, implementations: {
    'parse-json': { kind: 'local', execute: executeS2Structured }, select: { kind: 'local', execute: executeS2Structured },
    stringify: { kind: 'local', execute: executeS2Structured }, 'to-table': { kind: 'local', execute: executeS2Structured },
    'table-to-json': { kind: 'local', execute: executeS2Structured },
  } },
  { manifest: S2_STRUCTURED_VIEW_PLUGIN, implementations: {
    text: { kind: 'renderer', view: 'text', portId: 'text' },
    'json-tree': { kind: 'renderer', view: 'json-tree', portId: 'value' }, table: { kind: 'renderer', view: 'table', portId: 'table' },
  } },
  { manifest: S2_SIMULATION_PLUGIN, implementations: {
    step: { kind: 'local', execute: executeS2Simulation }, inspect: { kind: 'renderer', view: 'simulation', portId: 'result' },
  } },
  { manifest: S2_MERGE_PLUGIN, implementations: {
    'merge-json': { kind: 'local', execute: executeS2Merge }, 'merge-assessment': { kind: 'local', execute: executeS2Merge }, 'merge-simulation': { kind: 'local', execute: executeS2Merge },
  } },
  { manifest: S2_HUMAN_PLUGIN, implementations: {
    text: { kind: 'human', control: 'text' }, json: { kind: 'human', control: 'json' }, confirm: { kind: 'human', control: 'confirm' },
  } },
  { manifest: { ...S2_TEXT_RESOURCE_PLUGIN, capabilities: [...S2_TEXT_RESOURCE_PLUGIN.capabilities, {
    id: 'read-image', kind: 'action', effect: 'read', permissions: ['file-read'], confirmation: 'per-run', retry: 'manual-only', timeoutMs: 5000,
    meaning: '用户在本局选择一张PNG、JPEG或WebP静态图片后，输出原图的受限资源句柄；不读取路径、联网、OCR或把图片编码成普通文本。单张最多1MiB，本局最多6张且合计4MiB。',
    inputs: [{ ...port('resource', 'core.text'), label: '你选择的图片', meaning: '本局用户选择的图片资源标识，搭建时不编造路径、URL或句柄。' }],
    outputs: [{ ...port('image', 'core.image'), label: '原始图片', meaning: '本局完整原图的资源句柄；真实图片仅由本地宿主按权限提供给确认页和支持图片的固定模型。' }],
  }] }, implementations: { 'read-text': { kind: 'resource', bridge: 'selected-text-file' }, 'read-image': { kind: 'resource', bridge: 'selected-image-file' } } },
  { manifest: S2_PROJECT_NOTES_PLUGIN, implementations: { 'read-text': { kind: 'resource', bridge: 'selected-project-note' } } },
];
let installation = new S2PluginInstallation(builtinPackages);
sceneInteractionPacks.setSharedCapabilities(builtinPackages.map(item => item.manifest));
const extraPackages = new Map<string, S2PluginPackage>();
// Existing modules keep a stable read-only facade. Startup installations only add
// exact releases; an already registered release can never change its contract.
const registry = new Proxy(installation.registry, {
  get(target, key) {
    const value = Reflect.get(installation.registry, key);
    return typeof value === 'function' ? value.bind(installation.registry) : Reflect.get(target, key);
  },
});
/** Additive hot registration only: existing exact contracts/handlers are never replaced. */
export function installSceneInteractionCapabilities(raw: SceneInteractionPack) {
  // Validate descriptions and optional metadata before publishing any executable capability.
  const pack = readSceneInteractionPack(raw, { sharedCapabilities: installation.registry.catalog() });
  const candidate = new Map(extraPackages);
  for (const manifest of pack.capabilities) {
    const key = manifest.id + '@' + manifest.version;
    const implementations: S2PluginPackage['implementations'] = {};
    for (const action of manifest.capabilities) {
      if (['transform', 'validator'].includes(action.kind) && action.effect === 'pure' && !action.permissions.length)
        implementations[action.id] = { kind: 'local', execute: (call, inputs, signal) => executeScenePackLocal(pack, call, inputs, signal) };
      else if (pack.manifest.requiredServices.includes('model') && isS2ModelSessionCapability(action))
        implementations[action.id] = { kind: 'model', bridge: S2_MODEL_SESSION_BRIDGE.implementation };
      else throw new Error('新增能力须使用本地纯处理接口，或声明model宿主服务并严格符合model-session@1接口；不能自行获得外部调用或资源权限');
    }
    const previous = installation.registry.catalog().find(item => item.id === manifest.id && item.version === manifest.version);
    if (previous) {
      if (canonicalS2Json(previous as any) !== canonicalS2Json(manifest as any)) throw new Error('已安装能力的精确版本不能更改契约：' + key);
      continue;
    }
    candidate.set(key, { manifest, implementations });
  }
  const next = new S2PluginInstallation([...builtinPackages, ...candidate.values()]);
  extraPackages.clear(); for (const [key, value] of candidate) extraPackages.set(key, value);
  installation = next;
}

/** The registry has no mutation API; this is never constructed from model-provided manifests. */
export function s2BuiltinPluginRegistry() { return registry; }
/** Host-only code binding. Never serialize functions into an Agent catalogue or saved scene. */
export function s2BuiltinPluginInstallation() { return installation; }
/** Exact installed host-bridge identity, independent of package/business IDs. Unknown releases stay false. */
export function isInstalledS2ModelSession(ref: Pick<S2PluginNode, 'pluginId' | 'pluginVersion' | 'capabilityId'>): boolean {
  try { return isS2ModelSessionImplementation(installation.descriptor(ref)); } catch { return false; }
}
export const S2_JSON_CHECK_BINDING = { pluginId: 'json-check', pluginVersion: '1.0.0', capabilityId: 'validate' } as const;
export function s2ComposableCapabilities(reference?: SceneInteractionPackRef | null): Array<Omit<S2PluginNode, 'id'> & { label: string; kind: S2PluginCapability['kind'] }> {
  return registry.catalog().filter(plugin => sceneInteractionPacks.isCapabilityInScope(plugin.id, plugin.version, reference)).flatMap(plugin => plugin.capabilities.filter(cap => cap.kind !== 'editor').map(cap => ({
    pluginId: plugin.id, pluginVersion: plugin.version, capabilityId: cap.id, label: `${plugin.label} · ${cap.id}`, kind: cap.kind,
  })));
}
export const s2CapabilityKey = (value: Omit<S2PluginNode, 'id'>) => `${value.pluginId}@${value.pluginVersion}/${value.capabilityId}`;
export function readS2PluginBindings(raw: unknown) {
  if (!Array.isArray(raw) || raw.length > 16) throw new Error('S2 最多装配16种本地能力');
  const seen = new Set<string>();
  return raw.map((value, index) => {
    if (!value || typeof value !== 'object' || Object.keys(value).length !== 3) throw new Error(`S2 插件未安装或不是本版允许的本地能力：plugins[${index}]需要精确的pluginId/pluginVersion/capabilityId`);
    if (!s2ComposableCapabilities().some(cap => ['pluginId', 'pluginVersion', 'capabilityId'].every(key => value[key as keyof typeof value] === cap[key as keyof typeof cap]))) {
      let editor = false;
      try { editor = registry.capability(value as Omit<S2PluginNode, 'id'>).kind === 'editor'; } catch { /* Unknown capability stays rejected. */ }
      throw new Error(`S2 插件未安装或不是本版允许的本地能力：plugins[${index}]${editor ? '引用editor字段控件；它只能用于blockTypes.fields.kind，不能作为plugins/execution.nodes或业务tool步骤。请对照完整目录重新选择真实可执行能力，并同步修复initial和私有reference' : '不是已安装的精确可组合能力，请对照完整目录核对ID和版本'}`);
    }
    const binding = value as Omit<S2PluginNode, 'id'>, key = s2CapabilityKey(binding);
    if (seen.has(key)) throw new Error('S2 插件装配重复'); seen.add(key);
    return { pluginId: binding.pluginId, pluginVersion: binding.pluginVersion, capabilityId: binding.capabilityId };
  });
}
const TEXT_RESOURCE_SELECTION_RULES = 'local-material/read-text的resource在运行后由用户选择本局文件，搭建时留空绑定并说明选择入口，不能填路径、URL或编造资源句柄。';
const IMAGE_RESOURCE_SELECTION_RULES = 'local-material/read-image的resource由用户在本局选择PNG/JPEG/WebP后提供；image输出只连core.image端口，如已装配模型会话桥的可选image。搭建时resource留空，不能填路径、URL、base64、历史句柄或用文字模拟图片。';
const PROJECT_NOTE_SELECTION_RULES = 'project-notes/read-text在运行时由用户逐项允许项目知识笔记，resource由宿主提供，不能从标题或任意笔记ID伪造。';
export function s2InstalledPluginCatalog(reference?: SceneInteractionPackRef | null) {
  return { protocolVersion: 1, schemaDialect: 's2-bounded-value-v2',
    // Keep owned types/dependencies, but do not advertise UI editors in the executable selection list.
    plugins: registry.catalog().filter(plugin => sceneInteractionPacks.isCapabilityInScope(plugin.id, plugin.version, reference)).map(plugin => ({ ...plugin, capabilities: plugin.capabilities.filter(cap => cap.kind !== 'editor') })),
    fieldEditors: [...S2_CONTROL_KINDS],
    selectionRules: 'plugins及execution.nodes只选kind非editor的精确能力。fieldEditors仅用于blockTypes.fields.kind，不是执行节点，传输类型core.text@1；结构化内容须显式parse-json。字段通过bindings:{端口:{kind:"field",nodeId:内容块id,fieldId:字段id}}直接读取，无需文本执行节点或数据线。bindings只支持field/literal；上游插件输出不属于内容字段，必须通过execution.links的source/target端点传递，不能用field指执行节点或发明kind:"link"。单值端口接入连线后不再保留同端口binding。literal.value是原始JSON，不加{kind:"json",value:...}包装。initial和私有reference都遵循这些规则。' + TEXT_RESOURCE_SELECTION_RULES + IMAGE_RESOURCE_SELECTION_RULES + PROJECT_NOTE_SELECTION_RULES,
    toolExecutionAvailable: true, artifactTransportAvailable: true,
    note: '本地检查、显式结构化转换、JSON树/表格展示、显式示例模拟、互斥合流、人工输入/确认等待及支持when分支的类型化DAG。交互包可按通用接口声明纯本地处理和受控模型会话桥。模型调用由用户在当前终端执行入口明确启动，本地程序绑定模型、输入、参数与运行限制；不会因装配/编辑自动调用，不缓存、重试或隐藏调用评审。人工输入只由用户提交，不是插件授权；等待与恢复只在当前会话/修订有效，不缓存用户答案。模拟不是真实业务执行。装配不是授权；执行需确认。仅加载已安装的可信本地交互包；不从模型JSON加载代码，不支持自动付费或跨局恢复。' };
}
/** Runtime needs callable interfaces within its approved scope, not the entire installation's tool inventory. */
export function s2RuntimePluginCatalog(approved: S2CanvasCapabilities) {
  const { fieldEditors: _editors, ...catalog } = s2InstalledPluginCatalog(), selected = new Set(approved.map(s2CapabilityKey));
  const capabilities = catalog.plugins.flatMap(plugin => plugin.capabilities.filter(cap => plugin.id === 'core' || selected.has(s2CapabilityKey({ pluginId: plugin.id, pluginVersion: plugin.version, capabilityId: cap.id }))));
  // Content fields still transport text in content-only scenes; keeping that type does not advertise an executable editor.
  const types = new Set(['core.text', ...capabilities.flatMap(cap => [...cap.inputs, ...cap.outputs].map(port => port.type.id))]);
  return { ...catalog, selectionRules: (selected.has('local-material@1.0.0/read-text') ? catalog.selectionRules
    : catalog.selectionRules.replace(TEXT_RESOURCE_SELECTION_RULES, '')).replace(selected.has('project-notes@1.0.0/read-text') ? '' : PROJECT_NOTE_SELECTION_RULES, '')
      .replace(selected.has('local-material@1.0.0/read-image') ? '' : IMAGE_RESOURCE_SELECTION_RULES, '').replace('fieldEditors', '已装配控件'), plugins: catalog.plugins.flatMap(plugin => {
    const caps = plugin.capabilities.filter(cap => plugin.id === 'core' || selected.has(s2CapabilityKey({ pluginId: plugin.id, pluginVersion: plugin.version, capabilityId: cap.id })));
    const dataTypes = plugin.dataTypes.filter(type => types.has(type.id));
    return caps.length || dataTypes.length ? [{ ...plugin, capabilities: caps, dataTypes }] : [];
  }) };
}

/** Reply-only turns need complete capability/port meanings, not a tool assembly manual.
 * Keep the actual approved scope and IO types; no inference of authority or schema validity. */
export function s2DiscussionPluginCatalog(approved: S2CanvasCapabilities) {
  const catalog = s2RuntimePluginCatalog(approved);
  return { protocolVersion: catalog.protocolVersion, toolExecutionAvailable: catalog.toolExecutionAvailable,
    artifactTransportAvailable: catalog.artifactTransportAvailable, representation: 'discussion-capability-index',
    note: '仅用于解释：完整保留已允许能力及其端口说明，但未提供装配规则或数据类型schema。不能据此改图、执行或推断任意输入符合schema；实际验证仍由宿主负责。',
    plugins: catalog.plugins.map(plugin => ({ id: plugin.id, version: plugin.version, label: plugin.label, meaning: plugin.meaning,
      capabilities: plugin.capabilities.map(cap => ({ id: cap.id, kind: cap.kind, meaning: cap.meaning, effect: cap.effect,
        permissions: cap.permissions, confirmation: cap.confirmation, inputs: cap.inputs, outputs: cap.outputs })) })) };
}
type S2CanvasCapabilities = Array<{ pluginId: string; pluginVersion: string; capabilityId: string }>;
