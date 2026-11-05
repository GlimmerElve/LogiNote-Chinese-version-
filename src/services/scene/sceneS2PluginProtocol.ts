import type {
  S2Artifact, S2DataType, S2ExecutionLink, S2ExecutionReceipt, S2Json, S2PluginCapability,
  S2PluginGrant, S2PluginInvocation, S2PluginManifest, S2PluginNode, S2PluginObservation,
  S2PluginOutcome, S2TypeRef, S2ValueSchema, S2PublicationContext, S2PluginRequest, S2InteractionFrame,
} from '../../types/sceneS2Plugin';

/** Host-owned protocol rules. Compiled into BOTH builder and interaction context. */
export const S2_PLUGIN_PROTOCOL_RULES = `S2插件协议v1：
1. 插件清单由本地受信注册表提供：固定插件ID/精确版本、用途、能力、输入输出端口、语义数据类型/版本、权限、超时、确认与重试策略。模型不得发明插件、实现代码、授权或凭据。
2. 块是场景语义对象；编辑器/渲染器/转换器/验证器/动作是不同能力。普通关联连线可有环且不自动执行；执行连线只连接输出端口到输入端口。S2宿主支持显式when字段相等条件；条件依赖和数据依赖整体拒绝循环，不运行表达式或隐式分支。
3. 端口仅在语义类型ID、类型版本和结构契约一致时直连。相同JSON形状不代表相同含义；禁止字符串/数字、单位、版本等隐式转换。转换必须使用显式注册、获授权的适配能力。
4. 数据以不可变artifact传输：稳定ID、语义类型、来源场景/运行局/节点/修订号和完整性信息。载荷使用声明的有界JSON；图片/文件用专用语义类型的宿主资源描述，二进制通过受限资源API处理，不内嵌可执行内容。大JSON用本地artifactRef，不把路径或URL当句柄；摘要/预览不是执行输入。输入必须来自当前授权的完整数据，不足时请求补充，不猜测字段。
5. 搭建阶段先理解用户目标与交互方式，再选择能力和设计提示词；装配选择不是授权。交互阶段先理解最新表达和当前对象，按需读取数据/请求能力、观察本地结果，再决定解释、追问、检查、纠正建议或继续；不强制每次跑完整工作流。
6. 插件调用需本地核对当前scene/run/revision、已安装精确版本、能力授权、输入来源、剩余额度与确认记录。权限还须绑定已批准的笔记集合、模型、网络端点、文件等宿主资源句柄，访问时再次校验。插件的权限需求不是已获授权；保存的模板/模型/插件返回均不能扩大权限。
7. 本地顺序：校验与授权→预留额度并记录调用/幂等键→确认后执行→验证全部输出→持久化凭据与完整数据→发布Agent观察。未完整验证前不交给下游；副作用不随画布撤销而撤销。失败/取消/超时仍保留真实记录，不自动返还额度。
8. 调用状态与内容评价分离。成功只表示适配器完成且输出符合协议；验证器的通过/不通过/未知是带依据的输出数据，不能冒充数学证明或客观事实。插件响应不是本地执行凭据。
9. 拒绝越权、缺输入、错端口、过期结果、未知版本、截断或损坏数据，并返回结构化错误。不静默降级、不自动安装/升级/猜字段。失败只阻塞依赖它的下游，不把一插件失败升级成整个画布失败。
10. v1没有自动重试。用户重试副作用调用时复用幂等键并由执行器去重；不确定是否执行完成时记unknown，先核对，不自动再次付费。停止后迟到结果不更新当前画布。
11. 清单只是契约，不是代码沙箱；安装时仍须审查实现，网络/文件/模型/代码执行只能通过受限宿主能力。插件不得直接写画布、预算、权限或运行凭据；修改走本地原子操作与确认策略。
12. 可用能力以当前注册目录和所选交互包为准；底座不预设业务包、组件或固定流程。模型服务须独立预算与逐次确认，不缓存或自动重试，失败、取消或截断不伪装完整输出。仅受信合流允许越过skipped候选，多路命中拒绝，失败来源仍阻塞。模拟必须以独立类型标记simulation-only，不能冒充真实业务。执行图仅在用户确认目标后按类型化DAG处理依赖，普通关联线不执行，不因编辑自动运行。产物与凭据只存本局内存，不声称支持跨局恢复、RAG、数学或通用外部API。`;

export class S2PluginProtocolError extends Error {
  constructor(public readonly code: string, public readonly field: string, message: string) { super(message); this.name = 'S2PluginProtocolError'; }
}
function fail(code: string, field: string, message: string): never { throw new S2PluginProtocolError(code, field, message); }
function record(raw: unknown, field: string): Record<string, unknown> {
  if (!raw || Object.prototype.toString.call(raw) !== '[object Object]') fail('INVALID_DATA', field, '需要JSON对象');
  return raw as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, names: string[], field: string) {
  for (const key of Object.keys(value)) if (!names.includes(key)) fail('UNKNOWN_FIELD', `${field}.${key}`, '不支持此协议字段，不能静默忽略');
}
function text(raw: unknown, field: string, max = 1000): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > max) fail('INVALID_DATA', field, '文本为空或超过协议上限');
  return raw;
}
function name(raw: unknown, field: string, namespace = false): string {
  const value = text(raw, field, 120);
  if (!(namespace ? /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/ : /^[A-Za-z][A-Za-z0-9_-]*$/).test(value)
    || ['constructor', 'prototype', '__proto__'].includes(value)) fail('INVALID_ID', field, '标识符格式无效');
  return value;
}
function version(raw: unknown, field: string): string {
  const value = text(raw, field, 40);
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) fail('VERSION_MISMATCH', field, '仅接受精确x.y.z版本，不自动匹配范围或升级');
  return value;
}
function integer(raw: unknown, field: string, min = 0, max = 1000000): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < min || raw > max) fail('INVALID_DATA', field, '整数超出协议范围');
  return raw;
}
function array(raw: unknown, field: string, max = 32): unknown[] {
  if (!Array.isArray(raw) || raw.length > max) fail('INVALID_DATA', field, '数组无效或超过协议上限');
  return raw;
}
function bool(raw: unknown, field: string): boolean { if (typeof raw !== 'boolean') fail('INVALID_DATA', field, '需要布尔值'); return raw; }
function unique(values: string[], field: string) { if (new Set(values).size !== values.length) fail('DUPLICATE_ID', field, '存在重复标识符'); }
function protocol(raw: unknown, field: string) { if (raw !== 1) fail('UNSUPPORTED_PROTOCOL', field, '不支持此插件协议版本，不自动降级'); }
export function canonicalS2Json(raw: S2Json): string {
  if (Array.isArray(raw)) return `[${raw.map(canonicalS2Json).join(',')}]`;
  if (raw && typeof raw === 'object') return `{${Object.keys(raw).sort().map(key => `${JSON.stringify(key)}:${canonicalS2Json(raw[key])}`).join(',')}}`;
  return JSON.stringify(raw);
}
function json(raw: unknown, field: string, depth = 0): asserts raw is S2Json {
  if (depth > 16) fail('DATA_LIMIT', field, '数据嵌套过深');
  if (raw === null || typeof raw === 'boolean' || typeof raw === 'string') return;
  if (typeof raw === 'number' && Number.isFinite(raw)) return;
  if (Array.isArray(raw)) { if (raw.length > 2048) fail('DATA_LIMIT', field, '数据数组过大'); raw.forEach((value, i) => json(value, `${field}.${i}`, depth + 1)); return; }
  const value = record(raw, field);
  if (Object.keys(value).length > 256) fail('DATA_LIMIT', field, '对象字段过多');
  for (const [key, item] of Object.entries(value)) { if (['__proto__', 'constructor', 'prototype'].includes(key)) fail('INVALID_ID', field, '不允许保留字段名'); json(item, `${field}.${key}`, depth + 1); }
}
function readType(raw: unknown, field: string): S2TypeRef {
  const value = record(raw, field); exact(value, ['id', 'version'], field);
  return { id: name(value.id, `${field}.id`, true), version: integer(value.version, `${field}.version`, 1, 1000) };
}
function readSchema(raw: unknown, field: string, depth = 0): S2ValueSchema {
  if (depth > 8) fail('DATA_LIMIT', field, '结构定义嵌套过深');
  const value = record(raw, field);
  if (value.kind === 'json') {
    exact(value, ['kind', 'maxDepth', 'maxEntries', 'maxBytes'], field);
    return { kind: 'json', maxDepth: integer(value.maxDepth, field, 1, 8), maxEntries: integer(value.maxEntries, field, 1, 2048), maxBytes: integer(value.maxBytes, field, 1, 32768) };
  }
  if (value.kind === 'string') {
    exact(value, ['kind', 'maxLength', 'enum'], field); const maxLength = integer(value.maxLength, field, 1, 65536);
    const choices = value.enum === undefined ? undefined : array(value.enum, `${field}.enum`).map(item => text(item, field, maxLength));
    if (choices) { if (!choices.length) fail('INVALID_SCHEMA', field, '枚举不能为空'); unique(choices, field); }
    return { kind: 'string', maxLength, ...(choices ? { enum: choices } : {}) };
  }
  if (value.kind === 'boolean') { exact(value, ['kind'], field); return { kind: 'boolean' }; }
  if (value.kind === 'number') {
    exact(value, ['kind', 'integer', 'minimum', 'maximum'], field);
    if (![value.minimum, value.maximum].every(n => typeof n === 'number' && Number.isFinite(n)) || (value.minimum as number) > (value.maximum as number)) fail('INVALID_SCHEMA', field, '数值边界无效');
    return { kind: 'number', integer: bool(value.integer, field), minimum: value.minimum as number, maximum: value.maximum as number };
  }
  if (value.kind === 'array') { exact(value, ['kind', 'maxItems', 'item'], field); return { kind: 'array', maxItems: integer(value.maxItems, field, 0, 2048), item: readSchema(value.item, `${field}.item`, depth + 1) }; }
  if (value.kind === 'object') {
    exact(value, ['kind', 'fields', 'required'], field);
    const fields = record(value.fields, `${field}.fields`);
    if (Object.keys(fields).length > 32) fail('DATA_LIMIT', field, '结构字段超过32项');
    const output = Object.fromEntries(Object.entries(fields).map(([key, item]) => [name(key, `${field}.fields`), readSchema(item, `${field}.${key}`, depth + 1)]));
    const required = array(value.required, `${field}.required`).map(item => name(item, field)); unique(required, field);
    if (required.some(key => !Object.hasOwn(output, key))) fail('INVALID_SCHEMA', field, '必填字段不存在');
    return { kind: 'object', fields: output, required };
  }
  return fail('INVALID_SCHEMA', field, '不支持此数据结构；不隐式接受任意JSON');
}
function validateValue(schema: S2ValueSchema, raw: unknown, field: string): asserts raw is S2Json {
  if (schema.kind === 'json') {
    json(raw, field);
    let entries = 0;
    const visit = (value: S2Json, depth: number) => {
      if (++entries > schema.maxEntries || depth > schema.maxDepth) fail('DATA_LIMIT', field, '结构化数据超过深度或元素数量限制');
      if (value && typeof value === 'object') Object.values(value).forEach(item => visit(item, depth + 1));
    };
    visit(raw, 0);
    if (new TextEncoder().encode(canonicalS2Json(raw)).byteLength > schema.maxBytes) fail('DATA_LIMIT', field, '结构化数据超过完整载荷限制，不截断后继续执行');
  }
  else if (schema.kind === 'string') { if (typeof raw !== 'string' || raw.length > schema.maxLength || schema.enum && !schema.enum.includes(raw)) fail('TYPE_MISMATCH', field, '字符串类型、长度或枚举不匹配'); }
  else if (schema.kind === 'boolean') { if (typeof raw !== 'boolean') fail('TYPE_MISMATCH', field, '不是布尔值'); }
  else if (schema.kind === 'number') {
    if (typeof raw !== 'number' || !Number.isFinite(raw) || (schema.integer && !Number.isSafeInteger(raw)) || raw < schema.minimum || raw > schema.maximum) fail('TYPE_MISMATCH', field, '数值类型或范围不匹配');
  } else if (schema.kind === 'array') { array(raw, field, schema.maxItems).forEach((value, i) => validateValue(schema.item, value, `${field}.${i}`)); }
  else {
    const value = record(raw, field); exact(value, Object.keys(schema.fields), field);
    if (schema.required.some(key => !Object.hasOwn(value, key))) fail('MISSING_INPUT', field, '缺少必填字段');
    for (const [key, item] of Object.entries(value)) validateValue(schema.fields[key], item, `${field}.${key}`);
  }
}
/** Same native JSON bounds as structured-data.value; usable by local editors without a registry dependency. */
export function assertS2StructuredValue(raw: unknown): asserts raw is S2Json {
  validateValue({ kind: 'json', maxDepth: 8, maxEntries: 2048, maxBytes: 24000 }, raw, 'structured-value');
}
/** Reuse the closed schema dialect without registering synthetic plugin types. */
export function readS2ValueSchema(raw: unknown): S2ValueSchema {
  registrationJson(raw, 'schema');
  return readSchema(raw, 'schema');
}
/** Pure event/field validation; registration data guards prevent invoking accessors. */
export function validateS2ValueSchema(schema: S2ValueSchema, raw: unknown): asserts raw is S2Json {
  registrationJson(raw, 'value');
  validateValue(readS2ValueSchema(schema), raw, 'value');
}
const PERMISSIONS = ['notes-read', 'profile-read', 'network', 'model-call', 'file-read', 'file-write', 'code-execution'];
const typeKey = (type: S2TypeRef) => `${type.id}@${type.version}`;
const pluginKey = (id: string, version: string) => `${id}@${version}`;
/** Registration accepts inert JSON data, not class instances, hooks or executable descriptors.
 * Keep this stricter boundary local to registration; runtime artifact/invocation rules are separate. */
function registrationArray(raw: unknown, field: string, max: number): unknown[] {
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype) fail('INVALID_DATA', field, '注册数组必须是普通稠密JSON数组');
  const descriptors = Object.getOwnPropertyDescriptors(raw as object), length = descriptors.length.value as number;
  if (length > max) fail('DATA_LIMIT', field, '注册数组超过协议上限');
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== length + 1 || keys.some(key => typeof key !== 'string' || key !== 'length' && !/^(0|[1-9]\d*)$/.test(key)))
    fail('INVALID_DATA', field, '注册数组不能含空洞、符号或额外属性');
  const result: unknown[] = [];
  for (let i = 0; i < length; i++) {
    const descriptor = descriptors[String(i)];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail('INVALID_DATA', `${field}.${i}`, '注册数据不能含访问器、隐藏字段或空洞');
    result.push(descriptor.value);
  }
  return result;
}
function registrationJson(raw: unknown, field: string): asserts raw is S2Json {
  const active = new Set<object>(); let entries = 0;
  const visit = (value: unknown, path: string, depth: number) => {
    if (++entries > 8192 || depth > 16) fail('DATA_LIMIT', path, '插件清单超过遍历或嵌套上限');
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'string') { if (value.length > 65536) fail('DATA_LIMIT', path, '插件清单文本过大'); return; }
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (typeof value !== 'object') fail('INVALID_DATA', path, '插件清单只接受JSON数据，不能含函数或未定义值');
    if (active.has(value)) fail('INVALID_DATA', path, '插件清单不能含循环引用');
    active.add(value);
    if (Array.isArray(value)) registrationArray(value, path, 2048).forEach((item, i) => visit(item, `${path}.${i}`, depth + 1));
    else {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) fail('INVALID_DATA', path, '插件清单只能使用普通JSON对象');
      const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
      if (keys.length > 256) fail('DATA_LIMIT', path, '插件清单对象字段过多');
      for (const key of keys) {
        if (typeof key !== 'string') fail('INVALID_DATA', path, '插件清单不能含符号字段');
        if (['__proto__', 'constructor', 'prototype'].includes(key)) fail('INVALID_ID', path, '不允许保留字段名');
        const descriptor = descriptors[key];
        if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail('INVALID_DATA', path, '插件清单不能含访问器或隐藏字段');
        visit(descriptor.value, `${path}.${key}`, depth + 1);
      }
    }
    active.delete(value);
  };
  visit(raw, field, 0);
}
export function readS2PluginManifest(raw: unknown): S2PluginManifest {
  registrationJson(raw, 'manifest');
  if (canonicalS2Json(raw).length > 65536) fail('DATA_LIMIT', 'manifest', '插件清单过大');
  const value = record(raw, 'manifest'); exact(value, ['protocolVersion', 'id', 'version', 'label', 'meaning', 'dependencies', 'dataTypes', 'capabilities'], 'manifest'); protocol(value.protocolVersion, 'manifest.protocolVersion');
  const id = name(value.id, 'manifest.id', true), release = version(value.version, 'manifest.version');
  const dependencies = array(value.dependencies, 'dependencies').map(raw => {
    const item = record(raw, 'dependency'); exact(item, ['id', 'version'], 'dependency');
    return { id: name(item.id, 'dependency.id', true), version: version(item.version, 'dependency.version') };
  });
  unique(dependencies.map(item => item.id), 'dependencies');
  if (dependencies.some(item => item.id === id)) fail('DEPENDENCY_CYCLE', 'dependencies', '插件不能依赖自身');
  const dataTypes = array(value.dataTypes, 'dataTypes', 16).map(raw => {
    const item = record(raw, 'dataType'); exact(item, ['id', 'version', 'meaning', 'schema'], 'dataType');
    const ref = readType({ id: item.id, version: item.version }, 'dataType');
    if (!ref.id.startsWith(`${id}.`)) fail('INVALID_SCHEMA', 'dataType.id', '只能声明插件自己命名空间内的数据类型');
    return { ...ref, meaning: text(item.meaning, 'dataType.meaning'), schema: readSchema(item.schema, 'dataType.schema') };
  });
  unique(dataTypes.map(typeKey), 'dataTypes');
  const ports = (raw: unknown, field: string) => array(raw, field, 16).map(raw => {
    const port = record(raw, field); exact(port, ['id', 'label', 'meaning', 'type', 'required', 'multiple'], field);
    return { id: name(port.id, field), label: text(port.label, field, 80), meaning: text(port.meaning, field), type: readType(port.type, field), required: bool(port.required, field), multiple: bool(port.multiple, field) };
  });
  const capabilities = array(value.capabilities, 'capabilities', 16).map(raw => {
    const item = record(raw, 'capability'); exact(item, ['id', 'kind', 'meaning', 'inputs', 'outputs', 'effect', 'permissions', 'confirmation', 'retry', 'timeoutMs'], 'capability');
    if (typeof item.kind !== 'string' || !['editor', 'renderer', 'transform', 'validator', 'action', 'human'].includes(item.kind)) fail('INVALID_MANIFEST', 'capability.kind', '能力类型不支持');
    if (typeof item.effect !== 'string' || !['pure', 'read', 'external'].includes(item.effect)) fail('INVALID_MANIFEST', 'capability.effect', '执行效果类型不支持');
    if (typeof item.confirmation !== 'string' || !['none', 'per-run', 'per-call'].includes(item.confirmation)) fail('INVALID_MANIFEST', 'capability.confirmation', '确认策略不支持');
    if (typeof item.retry !== 'string' || !['manual-only', 'same-idempotency-key'].includes(item.retry)) fail('INVALID_MANIFEST', 'capability.retry', '重试策略不支持');
    const permissions = array(item.permissions, 'permissions', PERMISSIONS.length).map(raw => {
      if (typeof raw !== 'string' || !PERMISSIONS.includes(raw)) fail('INVALID_MANIFEST', 'permissions', '未知权限'); return raw as S2PluginCapability['permissions'][number];
    }); unique(permissions, 'permissions');
    if (item.effect === 'pure' && permissions.length) fail('INVALID_MANIFEST', 'capability.effect', '纯计算能力不能请求外部权限');
    if (permissions.some(p => ['network', 'model-call', 'file-write', 'code-execution'].includes(p)) && item.effect !== 'external') fail('INVALID_MANIFEST', 'capability.effect', '外部执行权限必须标记为external');
    if (item.effect === 'external' && item.confirmation === 'none') fail('INVALID_MANIFEST', 'capability.confirmation', '外部副作用必须显式确认');
    if (['editor', 'renderer'].includes(item.kind) && item.effect !== 'pure') fail('INVALID_MANIFEST', 'capability.effect', '展示/编辑能力不能直接执行外部工具');
    if (item.kind === 'human' && (item.effect !== 'read' || permissions.length || item.confirmation !== 'per-call')) fail('INVALID_MANIFEST', 'capability', '人工节点必须只读、逐次由用户提交，不得声明外部权限');
    const inputs = ports(item.inputs, 'inputs'), outputs = ports(item.outputs, 'outputs'); unique(inputs.map(p => p.id), 'inputs'); unique(outputs.map(p => p.id), 'outputs');
    return { id: name(item.id, 'capability.id'), kind: item.kind, meaning: text(item.meaning, 'capability.meaning'), inputs, outputs,
      effect: item.effect, permissions, confirmation: item.confirmation, retry: item.retry, timeoutMs: integer(item.timeoutMs, 'timeoutMs', 100, 120000) } as S2PluginCapability;
  });
  if (!capabilities.length) fail('INVALID_MANIFEST', 'capabilities', '至少提供一个能力'); unique(capabilities.map(c => c.id), 'capabilities');
  return { protocolVersion: 1, id, version: release, label: text(value.label, 'label', 80), meaning: text(value.meaning, 'meaning'), dependencies, dataTypes, capabilities };
}

/** Immutable registry snapshot; a failed replacement never mutates an active registry. */
export class S2PluginRegistry {
  private readonly plugins = new Map<string, S2PluginManifest>();
  private readonly types = new Map<string, S2DataType>();
  private readonly typeOwners = new Map<string, string>();
  constructor(manifests: unknown[]) {
    for (const raw of registrationArray(manifests, 'plugins', 32)) {
      const plugin = readS2PluginManifest(raw), key = pluginKey(plugin.id, plugin.version);
      if (this.plugins.has(key)) fail('DUPLICATE_ID', 'plugin', '插件版本重复');
      this.plugins.set(key, structuredClone(plugin));
      for (const type of plugin.dataTypes) {
        const owner = this.typeOwners.get(type.id);
        if (owner !== undefined && owner !== plugin.id) fail('TYPE_OWNER_CONFLICT', type.id, '语义类型ID只能属于一个插件，类型升版不能转移所有权');
        this.typeOwners.set(type.id, plugin.id);
        const existing = this.types.get(typeKey(type));
        if (existing && (existing.meaning !== type.meaning || canonicalS2Json(existing.schema as unknown as S2Json) !== canonicalS2Json(type.schema as unknown as S2Json))) fail('TYPE_CONFLICT', typeKey(type), '相同类型版本的语义或结构发生变化，必须升版');
        this.types.set(typeKey(type), structuredClone(type));
      }
    }
    const visiting = new Set<string>(), visited = new Set<string>();
    const visit = (key: string) => {
      if (visiting.has(key)) fail('DEPENDENCY_CYCLE', key, '插件依赖循环'); if (visited.has(key)) return;
      visiting.add(key);
      const plugin = this.plugins.get(key)!;
      for (const dependency of plugin.dependencies) { this.plugin(dependency.id, dependency.version); visit(pluginKey(dependency.id, dependency.version)); }
      for (const capability of plugin.capabilities) for (const port of [...capability.inputs, ...capability.outputs]) {
        this.dataType(port.type);
        const owners = [plugin, ...plugin.dependencies.map(dep => this.plugin(dep.id, dep.version))];
        if (!owners.some(owner => owner.dataTypes.some(type => typeKey(type) === typeKey(port.type)))) fail('DEPENDENCY_MISSING', port.id, '端口类型必须由自身或显式固定版本的直接依赖提供');
      }
      visiting.delete(key); visited.add(key);
    };
    for (const key of this.plugins.keys()) visit(key);
  }
  plugin(id: string, release: string): S2PluginManifest {
    const plugin = this.plugins.get(pluginKey(id, release));
    if (!plugin) fail('PLUGIN_MISSING', pluginKey(id, release), '未安装此精确插件版本；不自动升级或安装');
    return structuredClone(plugin);
  }
  capability(node: Pick<S2PluginNode, 'pluginId' | 'pluginVersion' | 'capabilityId'>): S2PluginCapability {
    const capability = this.plugin(node.pluginId, node.pluginVersion).capabilities.find(c => c.id === node.capabilityId);
    if (!capability) fail('CAPABILITY_MISSING', node.capabilityId, '插件没有此能力'); return capability;
  }
  dataType(ref: S2TypeRef): S2DataType {
    const type = this.types.get(typeKey(ref)); if (!type) fail('TYPE_MISSING', typeKey(ref), '语义数据类型未注册'); return structuredClone(type);
  }
  compatible(source: S2TypeRef, target: S2TypeRef): boolean { this.dataType(source); this.dataType(target); return typeKey(source) === typeKey(target); }
  catalog() { return [...this.plugins.values()].map(plugin => structuredClone(plugin)); }
}

/** Pure graph preflight, NOT authorization or execution. Semantic canvas links do not enter here. */
export function preflightS2ExecutionGraph(registry: S2PluginRegistry, nodes: S2PluginNode[], links: S2ExecutionLink[],
  provided: Array<{ nodeId: string; portId: string; count: number }> = []): { order: string[]; executed: false } {
  array(nodes, 'nodes', 40); array(links, 'links', 80); array(provided, 'provided', 128);
  for (const raw of nodes) {
    const node = record(raw, 'node'); exact(node, ['id', 'pluginId', 'pluginVersion', 'capabilityId'], 'node');
    name(node.id, 'node.id'); name(node.pluginId, 'node.pluginId', true); version(node.pluginVersion, 'node.pluginVersion'); name(node.capabilityId, 'node.capabilityId');
  }
  for (const raw of links) {
    const link = record(raw, 'link'); exact(link, ['source', 'target'], 'link');
    for (const key of ['source', 'target']) { const endpoint = record(link[key], key); exact(endpoint, ['nodeId', 'portId'], key); name(endpoint.nodeId, key); name(endpoint.portId, key); }
  }
  for (const raw of provided) { const value = record(raw, 'provided'); exact(value, ['nodeId', 'portId', 'count'], 'provided'); name(value.nodeId, 'nodeId'); name(value.portId, 'portId'); }
  unique(nodes.map(node => name(node.id, 'node.id')), 'nodes');
  const byId = new Map(nodes.map(node => [node.id, registry.capability(node)]));
  const incoming = new Map<string, number>(), children = new Map<string, string[]>(), degree = new Map(nodes.map(node => [node.id, 0]));
  const input = (nodeId: string, portId: string) => {
    const port = byId.get(nodeId)?.inputs.find(port => port.id === portId);
    if (!port) fail('PORT_MISSING', `${nodeId}.${portId}`, '输入端口不存在'); return port;
  };
  for (const item of provided) { const key = JSON.stringify([item.nodeId, item.portId]); input(item.nodeId, item.portId); if (incoming.has(key)) fail('DUPLICATE_ID', key, '输入声明重复'); incoming.set(key, integer(item.count, key, 1, 32)); }
  const seen = new Set<string>();
  for (const link of links) {
    const key = JSON.stringify([link.source.nodeId, link.source.portId, link.target.nodeId, link.target.portId]); if (seen.has(key)) fail('DUPLICATE_LINK', key, '执行连线重复'); seen.add(key);
    if (link.source.nodeId === link.target.nodeId) fail('EXECUTION_CYCLE', 'link', '执行节点不能自连');
    const output = byId.get(link.source.nodeId)?.outputs.find(port => port.id === link.source.portId), target = input(link.target.nodeId, link.target.portId);
    if (!output) fail('PORT_MISSING', 'source', '输出端口不存在');
    if (!registry.compatible(output.type, target.type) || output.multiple && !target.multiple) fail('TYPE_MISMATCH', 'link', '端口语义类型/版本或多值约定不匹配，需要显式适配器');
    if (target.required && !output.required) fail('MISSING_INPUT', 'link', '可缺省输出不能保证必填输入，需显式补值/分支适配器');
    const targetKey = JSON.stringify([link.target.nodeId, link.target.portId]); incoming.set(targetKey, (incoming.get(targetKey) ?? 0) + 1);
    children.set(link.source.nodeId, [...(children.get(link.source.nodeId) ?? []), link.target.nodeId]); degree.set(link.target.nodeId, degree.get(link.target.nodeId)! + 1);
  }
  for (const node of nodes) for (const port of byId.get(node.id)!.inputs) {
    const count = incoming.get(JSON.stringify([node.id, port.id])) ?? 0;
    if (port.required && !count) fail('MISSING_INPUT', `${node.id}.${port.id}`, '必填输入未连接或提供');
    if (!port.multiple && count > 1) fail('PORT_CARDINALITY', `${node.id}.${port.id}`, '单值输入不能接收多路数据');
    if (count > 32) fail('PORT_CARDINALITY', `${node.id}.${port.id}`, '输入来源超过v1的32项上限');
  }
  const queue = nodes.filter(node => degree.get(node.id) === 0).map(node => node.id), order: string[] = [];
  while (queue.length) { const node = queue.shift()!; order.push(node); for (const child of children.get(node) ?? []) { degree.set(child, degree.get(child)! - 1); if (!degree.get(child)) queue.push(child); } }
  if (order.length !== nodes.length) fail('EXECUTION_CYCLE', 'graph', 'v1执行图不支持循环；普通关联图不受此限制');
  return { order, executed: false };
}

export function readS2Artifact(registry: S2PluginRegistry, raw: unknown): S2Artifact {
  json(raw, 'artifact');
  const value = record(raw, 'artifact'); exact(value, ['protocolVersion', 'id', 'type', 'source', 'complete', 'payload'], 'artifact'); protocol(value.protocolVersion, 'artifact.protocolVersion');
  const ref = readType(value.type, 'artifact.type'), type = registry.dataType(ref), source = record(value.source, 'source');
  exact(source, ['sceneId', 'runId', 'nodeId', 'revision', 'kind', 'invocationId'], 'source');
  name(value.id, 'artifact.id'); for (const key of ['sceneId', 'runId', 'nodeId']) name(source[key], `source.${key}`);
  integer(source.revision, 'source.revision');
  if (!['user', 'host', 'plugin'].includes(String(source.kind))) fail('INVALID_DATA', 'source.kind', '来源类型无效');
  if (source.invocationId !== undefined) name(source.invocationId, 'source.invocationId');
  if (source.kind === 'plugin' && !source.invocationId) fail('INVALID_DATA', 'source.invocationId', '插件产物必须绑定调用');
  if (value.complete !== true) fail('INCOMPLETE_DATA', 'artifact.complete', '截断或摘要数据不能作为完整产物');
  const payload = record(value.payload, 'payload');
  if (payload.kind === 'inline') {
    exact(payload, ['kind', 'value'], 'payload'); validateValue(type.schema, payload.value, 'payload.value');
    if (new TextEncoder().encode(canonicalS2Json(payload.value as S2Json)).byteLength > 65536) fail('DATA_LIMIT', 'payload', '内联数据超过64KiB，请使用宿主数据句柄');
  } else if (payload.kind === 'reference') {
    exact(payload, ['kind', 'artifactRef', 'bytes', 'sha256'], 'payload'); name(payload.artifactRef, 'payload.artifactRef');
    integer(payload.bytes, 'payload.bytes', 1, 16 * 1024 * 1024);
    if (typeof payload.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(payload.sha256)) fail('INVALID_DATA', 'payload.sha256', '缺少合法完整性摘要');
  } else fail('INVALID_DATA', 'payload.kind', '数据载荷类型不支持');
  return structuredClone(value) as unknown as S2Artifact;
}
export async function resolveS2Artifact(registry: S2PluginRegistry, raw: S2Artifact,
  resolve?: (artifactRef: string) => Promise<unknown>): Promise<S2Json> {
  const artifact = readS2Artifact(registry, raw);
  if (artifact.payload.kind === 'inline') return structuredClone(artifact.payload.value);
  if (!resolve) fail('ARTIFACT_UNAVAILABLE', artifact.id, '缺少宿主数据解析器，不能拿预览代替完整内容');
  const value = await resolve(artifact.payload.artifactRef); json(value, 'resolved.value');
  validateValue(registry.dataType(artifact.type).schema, value, 'resolved.value');
  const bytes = new TextEncoder().encode(canonicalS2Json(value));
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(byte => byte.toString(16).padStart(2, '0')).join('');
  if (hash !== artifact.payload.sha256 || bytes.byteLength !== artifact.payload.bytes) fail('INTEGRITY_MISMATCH', artifact.id, '完整数据与句柄摘要/长度不一致');
  return structuredClone(value);
}

/** Pre-execution validation only. Caller MUST recheck current grant after awaits and reserve budget atomically. */
const checkedInvocations = new WeakMap<object, { snapshot: string; registry: S2PluginRegistry }>();
const checkedOutcomes = new WeakMap<object, { invocation: string; snapshot: string }>();
const fingerprint = (value: unknown) => { json(value, 'contract'); return canonicalS2Json(value); };
function invocationChecked(invocation: S2PluginInvocation, registry?: S2PluginRegistry) {
  const checked = checkedInvocations.get(invocation);
  if (!checked || checked.snapshot !== fingerprint(invocation) || registry && checked.registry !== registry) fail('PROTOCOL_BYPASS', 'invocation', '调用必须先通过本地校验，校验后不能改写或切换注册表');
}
function outcomeChecked(invocation: S2PluginInvocation, outcome: S2PluginOutcome) {
  invocationChecked(invocation);
  const checked = checkedOutcomes.get(outcome);
  if (!checked || checked.invocation !== fingerprint(invocation) || checked.snapshot !== fingerprint(outcome)) fail('PROTOCOL_BYPASS', 'outcome', '输出必须先通过本地校验，不能由插件/模型冒充已验证结果');
}
export async function validateS2Invocation(registry: S2PluginRegistry, raw: unknown, grant: S2PluginGrant, artifacts: S2Artifact[],
  resolve?: (artifactRef: string) => Promise<unknown>): Promise<{ invocation: S2PluginInvocation; capability: S2PluginCapability; inputs: Record<string, S2Json[]> }> {
  const call = record(raw, 'invocation'); exact(call, ['protocolVersion', 'id', 'sceneId', 'runId', 'nodeId', 'revision', 'pluginId', 'pluginVersion', 'capabilityId', 'idempotencyKey', 'inputs'], 'invocation');
  protocol(call.protocolVersion, 'invocation.protocolVersion');
  for (const key of ['id', 'sceneId', 'runId', 'nodeId', 'capabilityId', 'idempotencyKey']) name(call[key], `invocation.${key}`);
  name(call.pluginId, 'invocation.pluginId', true); version(call.pluginVersion, 'invocation.pluginVersion'); integer(call.revision, 'invocation.revision');
  if (call.sceneId !== grant.sceneId || call.runId !== grant.runId) fail('SCOPE_DENIED', 'invocation', '不能跨场景或运行局调用');
  if (call.revision !== grant.revision) fail('STALE_REVISION', 'invocation.revision', '画布已变化，调用必须重新确认');
  const invocation = structuredClone(raw) as S2PluginInvocation, capability = registry.capability(invocation);
  if (['editor', 'renderer', 'human'].includes(capability.kind)) fail('NOT_CALLABLE', 'capability', '展示/编辑/人工组件不通过工具执行接口调用');
  if (!grant.capabilities.some(c => c.pluginId === invocation.pluginId && c.pluginVersion === invocation.pluginVersion && c.capabilityId === invocation.capabilityId)
    || capability.permissions.some(p => !grant.permissions.includes(p))) fail('PERMISSION_DENIED', 'capability', '能力或所需权限未授权');
  if (capability.permissions.some(permission => !grant.resourceScopes.some(scope => scope.permission === permission && scope.resourceIds.length))) fail('SCOPE_DENIED', 'resourceScopes', '权限未绑定具体宿主资源范围');
  if (!Number.isSafeInteger(grant.remainingCalls) || grant.remainingCalls <= 0) fail('BUDGET_EXHAUSTED', 'grant.remainingCalls', '调用预算已用尽');
  if (capability.confirmation === 'per-call' && !grant.confirmedInvocationIds.includes(invocation.id)) fail('CONFIRMATION_REQUIRED', 'invocation.id', '本次调用需要用户确认');
  // A capability appearing in a host-created run grant is its per-run approval; manifest presence is not.
  const inputIds = record(call.inputs, 'inputs'); exact(inputIds, capability.inputs.map(p => p.id), 'inputs');
  unique(artifacts.map(a => a.id), 'artifacts');
  const byId = new Map(artifacts.map(a => [a.id, a])), inputs: Record<string, S2Json[]> = {};
  for (const port of capability.inputs) {
    const ids = inputIds[port.id] === undefined ? [] : array(inputIds[port.id], `inputs.${port.id}`, 32).map(value => name(value, 'artifactId'));
    unique(ids, `inputs.${port.id}`);
    if (port.required && !ids.length) fail('MISSING_INPUT', port.id, '缺少必填输入');
    if (!port.multiple && ids.length > 1) fail('PORT_CARDINALITY', port.id, '单值端口收到多个数据');
    inputs[port.id] = [];
    for (const id of ids) {
      const raw = byId.get(id); if (!raw || !grant.readableArtifactIds.includes(id)) fail('SCOPE_DENIED', id, '数据不存在或不在授权范围');
      const artifact = readS2Artifact(registry, raw);
      if (artifact.source.sceneId !== grant.sceneId || artifact.source.runId !== grant.runId) fail('SCOPE_DENIED', id, '数据属于其他场景或运行局');
      if (artifact.source.revision > grant.revision) fail('STALE_REVISION', id, '输入数据来自当前画布之后的修订号');
      if (!registry.compatible(artifact.type, port.type)) fail('TYPE_MISMATCH', port.id, '输入语义类型或版本不匹配');
      inputs[port.id].push(await resolveS2Artifact(registry, artifact, resolve));
    }
  }
  if (grant.sceneId !== invocation.sceneId || grant.runId !== invocation.runId || grant.revision !== invocation.revision) fail('STALE_REVISION', 'grant', '读取数据期间场景或修订号已变化');
  if (!grant.capabilities.some(c => c.pluginId === invocation.pluginId && c.pluginVersion === invocation.pluginVersion && c.capabilityId === invocation.capabilityId)
    || capability.permissions.some(p => !grant.permissions.includes(p) || !grant.resourceScopes.some(scope => scope.permission === p && scope.resourceIds.length))
    || Object.values(invocation.inputs).flat().some(id => !grant.readableArtifactIds.includes(id))) fail('PERMISSION_DENIED', 'grant', '读取数据期间授权已变化');
  if (!Number.isSafeInteger(grant.remainingCalls) || grant.remainingCalls <= 0) fail('BUDGET_EXHAUSTED', 'grant', '读取数据期间调用预算已用尽或失效');
  if (capability.confirmation === 'per-call' && !grant.confirmedInvocationIds.includes(invocation.id)) fail('CONFIRMATION_REQUIRED', 'grant', '读取数据期间本次确认已撤回');
  checkedInvocations.set(invocation, { snapshot: fingerprint(invocation), registry });
  return { invocation, capability, inputs };
}

/** Adapter output validation. No persistence, budget mutation, execution, or permission expansion. */
export async function validateS2Outcome(registry: S2PluginRegistry, invocation: S2PluginInvocation, raw: unknown,
  existingIds: string[] = [], resolve?: (artifactRef: string) => Promise<unknown>): Promise<S2PluginOutcome> {
  invocationChecked(invocation, registry);
  const value = record(raw, 'outcome');
  if (typeof value.status !== 'string' || !['succeeded', 'failed', 'cancelled', 'unknown'].includes(value.status)) fail('INVALID_OUTCOME', 'status', '执行状态必须是合法字符串，不能把pending或部分结果当成最终输出');
  const outputs = record(value.outputs, 'outputs');
  if (value.status !== 'succeeded') {
    exact(value, ['status', 'outputs', 'error'], 'outcome'); exact(outputs, [], 'outputs');
    const error = record(value.error, 'error'); exact(error, ['code', 'message'], 'error');
    const result = { status: value.status, error: { code: name(error.code, 'error.code'), message: text(error.message, 'error.message', 1000) }, outputs: {} } as S2PluginOutcome;
    checkedOutcomes.set(result, { invocation: fingerprint(invocation), snapshot: fingerprint(result) }); return result;
  }
  exact(value, ['status', 'outputs'], 'outcome');
  const capability = registry.capability(invocation); exact(outputs, capability.outputs.map(p => p.id), 'outputs');
  const result: Record<string, S2Artifact[]> = {}, allIds = [...existingIds];
  for (const port of capability.outputs) {
    const items = outputs[port.id] === undefined ? [] : array(outputs[port.id], port.id, 32);
    if (port.required && !items.length) fail('MISSING_OUTPUT', port.id, '缺少必填输出');
    if (!port.multiple && items.length > 1) fail('PORT_CARDINALITY', port.id, '单值输出不能有多个数据');
    result[port.id] = [];
    for (const raw of items) {
      const artifact = readS2Artifact(registry, raw), source = artifact.source;
      if (source.kind !== 'plugin' || source.invocationId !== invocation.id || source.nodeId !== invocation.nodeId || source.sceneId !== invocation.sceneId || source.runId !== invocation.runId || source.revision !== invocation.revision) fail('SOURCE_MISMATCH', artifact.id, '输出来源不匹配当前调用');
      if (!registry.compatible(artifact.type, port.type)) fail('TYPE_MISMATCH', port.id, '输出语义类型或版本不匹配');
      await resolveS2Artifact(registry, artifact, resolve); allIds.push(artifact.id); result[port.id].push(artifact);
    }
  }
  unique(allIds, 'outputs');
  invocationChecked(invocation, registry);
  const outcome: S2PluginOutcome = { status: 'succeeded', outputs: result };
  checkedOutcomes.set(outcome, { invocation: fingerprint(invocation), snapshot: fingerprint(outcome) }); return outcome;
}

/** Only the host calls this AFTER validation; plugins/agents cannot provide their own receipts. */
function publication(invocation: S2PluginInvocation, current: S2PublicationContext): 'current' | 'stale' {
  return current.active && current.sceneId === invocation.sceneId && current.runId === invocation.runId && current.revision === invocation.revision ? 'current' : 'stale';
}
export function createS2Receipt(invocation: S2PluginInvocation, outcome: S2PluginOutcome, current: S2PublicationContext): S2ExecutionReceipt {
  outcomeChecked(invocation, outcome);
  return { protocolVersion: 1, id: `receipt-${crypto.randomUUID()}`, invocationId: invocation.id, sceneId: invocation.sceneId, runId: invocation.runId,
    revision: invocation.revision, status: outcome.status, publication: publication(invocation, current),
    outputArtifactIds: outcome.status === 'succeeded' ? Object.fromEntries(Object.entries(outcome.outputs).map(([port, items]) => [port, items.map(a => a.id)])) : {},
    ...(outcome.status === 'succeeded' ? {} : { error: structuredClone(outcome.error) }) };
}
/** Summaries for Agent observation only; never round-trip previews back into execution inputs. */
export function describeS2PluginOutcome(registry: S2PluginRegistry, invocation: S2PluginInvocation, outcome: S2PluginOutcome, current: S2PublicationContext): S2PluginObservation {
  invocationChecked(invocation, registry);
  outcomeChecked(invocation, outcome);
  const state = publication(invocation, current);
  return { invocationId: invocation.id, pluginId: invocation.pluginId, capabilityId: invocation.capabilityId, executionStatus: outcome.status,
    publication: state, artifacts: outcome.status === 'succeeded' && state === 'current' ? Object.values(outcome.outputs).flat().map(artifact => {
      const content = artifact.payload.kind === 'inline' ? canonicalS2Json(artifact.payload.value) : `[完整内容位于宿主数据句柄 ${artifact.payload.artifactRef}]`;
      return { id: artifact.id, type: artifact.type, meaning: registry.dataType(artifact.type).meaning, artifactComplete: true as const,
        preview: content.slice(0, 1200), previewOmitted: artifact.payload.kind === 'reference' || content.length > 1200 };
    }) : [], ...(outcome.status === 'succeeded' ? {} : { error: structuredClone(outcome.error) }) };
}

/** Agent intention gate. Does not authorize, spend budget, or create/execute an invocation. */
export function readS2PluginRequest(registry: S2PluginRegistry, frame: S2InteractionFrame, raw: unknown): { request: S2PluginRequest; authorization: 'requires-host-validation' } {
  protocol(frame.protocolVersion, 'frame.protocolVersion');
  const value = record(raw, 'request'); exact(value, ['nodeId', 'pluginId', 'pluginVersion', 'capabilityId', 'inputs', 'reason'], 'request');
  const nodeId = name(value.nodeId, 'request.nodeId');
  if (!frame.availableNodeIds.includes(nodeId)) fail('SCOPE_DENIED', nodeId, '请求目标不在当前画布可用对象中');
  const node = { pluginId: name(value.pluginId, 'request.pluginId', true), pluginVersion: version(value.pluginVersion, 'request.pluginVersion'), capabilityId: name(value.capabilityId, 'request.capabilityId') };
  const capability = registry.capability(node);
  if (['editor', 'renderer', 'human'].includes(capability.kind)) fail('NOT_CALLABLE', 'request.capabilityId', '编辑/展示/人工组件不是工具执行请求');
  const rawInputs = record(value.inputs, 'request.inputs'); exact(rawInputs, capability.inputs.map(port => port.id), 'request.inputs');
  const inputs: Record<string, string[]> = {};
  for (const port of capability.inputs) {
    const ids = rawInputs[port.id] === undefined ? [] : array(rawInputs[port.id], port.id, 32).map(item => name(item, 'artifactId'));
    unique(ids, port.id);
    if (port.required && !ids.length) fail('MISSING_INPUT', port.id, '请先获取真实输入数据，不得编造');
    if (!port.multiple && ids.length > 1) fail('PORT_CARDINALITY', port.id, '单值输入不能传多项');
    if (ids.some(id => !frame.availableArtifactIds.includes(id))) fail('SCOPE_DENIED', port.id, '请求引用了观察上下文中不可用的数据');
    inputs[port.id] = ids;
  }
  return { request: { nodeId, ...node, inputs, reason: text(value.reason, 'request.reason', 1000) }, authorization: 'requires-host-validation' };
}

/** Guard for each future host-resource API call. No IO here; adapters must not bypass this with raw APIs. */
export function assertS2ResourceAccess(registry: S2PluginRegistry, invocation: S2PluginInvocation, grant: S2PluginGrant,
  permission: S2PluginCapability['permissions'][number], resourceId: string): void {
  invocationChecked(invocation, registry);
  name(resourceId, 'resourceId');
  const capability = registry.capability(invocation);
  if (grant.sceneId !== invocation.sceneId || grant.runId !== invocation.runId || grant.revision !== invocation.revision) fail('STALE_REVISION', 'resource', '资源访问对应的运行上下文已变化');
  if (!capability.permissions.includes(permission) || !grant.permissions.includes(permission)
    || !grant.capabilities.some(c => c.pluginId === invocation.pluginId && c.pluginVersion === invocation.pluginVersion && c.capabilityId === invocation.capabilityId)) fail('PERMISSION_DENIED', permission, '插件没有声明或获准访问此类资源');
  if (!grant.resourceScopes.some(scope => scope.permission === permission && scope.resourceIds.includes(resourceId))) fail('SCOPE_DENIED', resourceId, '资源句柄不在本次授权范围内');
  if (capability.confirmation === 'per-call' && !grant.confirmedInvocationIds.includes(invocation.id)) fail('CONFIRMATION_REQUIRED', invocation.id, '本次调用确认已撤回');
}
