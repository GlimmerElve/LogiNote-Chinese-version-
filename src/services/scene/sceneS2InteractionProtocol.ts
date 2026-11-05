import type { S2Document } from '../../types/sceneS2';
import type { S2Json, S2ValueSchema } from '../../types/sceneS2Plugin';
import type {
  S2InteractionAction, S2InteractionActionKind, S2InteractionConfig, S2InteractionEventDeclaration,
  S2InteractionInterfaceRead, S2InteractionRead, S2InteractionResponse, S2InteractionScope, S2PackInteraction,
} from '../../types/sceneS2Interaction';
import { readS2ValueSchema, validateS2ValueSchema } from './sceneS2PluginProtocol';

export const S2_INTERACTION_LIMITS = {
  triggers: 16, events: 16, actions: 12, targets: 8, readNodes: 4, readComponents: 8,
  readResults: 3, readInterfaceFields: 16, readChars: 12000, readBatches: 2, modelCalls: 4, readTotalChars: 24000,
  replyChars: 6000, taskChars: 4000, bytes: 262144,
} as const;
const eventDataSchema: S2ValueSchema = { kind: 'object', fields: {
  resultIds: { kind: 'array', maxItems: 128, item: { kind: 'string', maxLength: 160 } },
  error: { kind: 'string', maxLength: 1000 },
}, required: [] };
export const S2_BUILTIN_INTERACTION_EVENTS: readonly S2InteractionEventDeclaration[] = [
  { id: 's2.node.succeeded', purpose: '公开执行节点成功后，按本次真实输入与输出响应', dataSchema: eventDataSchema },
  { id: 's2.node.failed', purpose: '公开执行节点失败后，依据实际错误响应', dataSchema: eventDataSchema },
];

export class S2InteractionProtocolError extends Error {
  constructor(readonly code: string, readonly path: string, readonly reason: string) {
    super(`S2 交互协议 [${code}] ${path}：${reason}`); this.name = 'S2InteractionProtocolError';
  }
}
function fail(code: string, path: string, reason: string): never { throw new S2InteractionProtocolError(code, path, reason); }
const child = (path: string, key: string | number) => `${path === '/' ? '' : path}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;
const reserved = new Set(['__proto__', 'constructor', 'prototype']);

/** This inert contract module must not import the canvas/registry through the
 * composite reader: packages are parsed before their capabilities are installed. */
export function snapshotS2InteractionData<T>(raw: T, maxBytes: number = S2_INTERACTION_LIMITS.bytes): T {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > S2_INTERACTION_LIMITS.bytes) fail('INTERACTION_LIMIT', '/', '数据预算无效');
  const active = new Set<object>(); let entries = 0, bytes = 0;
  const spend = (value: string) => { bytes += new TextEncoder().encode(value).byteLength; if (bytes > maxBytes) fail('INTERACTION_LIMIT', '/', '完整数据超过字节限制'); };
  const visit = (value: unknown, path: string, depth: number): any => {
    if (++entries > 16000 || depth > 20) fail('INTERACTION_LIMIT', path, '数据嵌套或元素数量超限');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') { spend(value); return value; }
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (!value || typeof value !== 'object' || active.has(value)) fail('INTERACTION_DATA', path, '仅接受完整原生JSON数据');
    active.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value), names = Reflect.ownKeys(descriptors); let result: any;
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 2048 || names.length !== value.length + 1) fail('INTERACTION_DATA', path, '需要有界稠密数组');
      result = Array.from({ length: value.length }, (_, index) => {
        const descriptor = descriptors[String(index)];
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail('INTERACTION_DATA', child(path, index), '不能含访问器、空项或隐藏字段');
        return visit(descriptor.value, child(path, index), depth + 1);
      });
    } else {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(value)) || names.length > 256) fail('INTERACTION_DATA', path, '需要普通有界对象');
      result = Object.fromEntries(names.map(name => {
        if (typeof name !== 'string' || reserved.has(name)) fail('INTERACTION_DATA', path, '不能含符号或保留字段');
        const descriptor = descriptors[name];
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('INTERACTION_DATA', child(path, name), '不能含访问器或隐藏字段');
        spend(name); return [name, visit(descriptor.value, child(path, name), depth + 1)];
      }));
    }
    active.delete(value); return result;
  };
  const result = visit(raw, '/', 0);
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > maxBytes) fail('INTERACTION_LIMIT', '/', '完整数据超过字节限制');
  return result as T;
}
function object(raw: unknown, path: string, allowed: readonly string[], required: readonly string[] = []): Record<string, any> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('INTERACTION_FIELD', path, '需要完整对象');
  const value = raw as Record<string, any>;
  if (Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) fail('INTERACTION_FIELD', path, '包含未知字段或缺少必需字段');
  return value;
}
function list(raw: unknown, path: string, max: number, min = 0): any[] {
  if (!Array.isArray(raw) || raw.length > max || raw.length < min) fail('INTERACTION_LIMIT', path, `需要${min}至${max}项的数组`);
  return raw;
}
function text(raw: unknown, path: string, max: number, empty = false): string {
  if (typeof raw !== 'string' || raw.length > max || !empty && !raw.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(raw as string)) fail('INTERACTION_DATA', path, '文本为空、含控制字符或超过长度限制');
  return raw as string;
}
function id(raw: unknown, path: string): string {
  const value = text(raw, path, 64);
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(value) || reserved.has(value)) fail('INTERACTION_ID', path, '需要合法公开标识');
  return value;
}
function eventId(raw: unknown, path: string): string {
  const value = text(raw, path, 160);
  if (!/^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)+$/.test(value)) fail('INTERACTION_ID', path, '事件需要命名空间标识');
  return value;
}
function strings(raw: unknown, path: string, max: number, opaque = false, min = 0): string[] {
  const values = list(raw, path, max, min).map((item, index) => opaque ? text(item, child(path, index), 160) : id(item, child(path, index)));
  if (new Set(values).size !== values.length) fail('INTERACTION_DUPLICATE', path, '标识不能重复');
  return values;
}
function scope(raw: unknown, path = '/scope'): S2InteractionScope {
  if (raw === undefined) return { actions: ['reply'] };
  const value = object(raw, path, ['nodeIds', 'actions']);
  const actions = value.actions === undefined ? ['reply'] : list(value.actions, path + '/actions', 3, 1);
  if (actions.some(action => !['reply', 'edit', 'execute'].includes(action)) || new Set(actions).size !== actions.length) fail('INTERACTION_SCOPE', path + '/actions', '动作范围需要不重复的reply/edit/execute');
  return { actions: [...actions] as S2InteractionActionKind[], ...(value.nodeIds === undefined ? {} : { nodeIds: strings(value.nodeIds, path + '/nodeIds', 80) }) };
}
export function readS2InteractionScope(raw?: unknown): S2InteractionScope {
  return scope(raw === undefined ? undefined : snapshotS2InteractionData(raw));
}
export function readS2InteractionConfig(raw: unknown, document?: Pick<S2Document, 'nodes' | 'execution'>): S2InteractionConfig {
  const value = object(snapshotS2InteractionData(raw), '/interaction', ['version', 'triggers'], ['version', 'triggers']);
  if (value.version !== 1) fail('INTERACTION_VERSION', '/interaction/version', '仅支持交互协议版本1');
  const all = document && new Set([...document.nodes, ...(document.execution?.nodes ?? [])].map(node => node.id));
  const execution = document && new Set(document.execution?.nodes.map(node => node.id) ?? []);
  const triggers = list(value.triggers, '/interaction/triggers', S2_INTERACTION_LIMITS.triggers).map((raw, index) => {
    const path = `/interaction/triggers/${index}`, trigger = object(raw, path, ['id', 'on', 'task', 'scope'], ['id', 'on', 'task']);
    const on = object(trigger.on, path + '/on', ['event', 'nodeId'], ['event', 'nodeId']);
    const event = eventId(on.event, path + '/on/event'), nodeId = id(on.nodeId, path + '/on/nodeId');
    const normalizedScope = trigger.scope === undefined ? undefined : scope(trigger.scope, path + '/scope');
    if (all && (!all.has(nodeId) || normalizedScope?.nodeIds?.some(id => !all.has(id)))) fail('INTERACTION_REFERENCE', path, '触发来源或范围节点不存在');
    if (execution && S2_BUILTIN_INTERACTION_EVENTS.some(item => item.id === event) && !execution.has(nodeId)) fail('INTERACTION_REFERENCE', path + '/on/nodeId', '节点执行事件需要执行组件');
    return { id: id(trigger.id, path + '/id'), on: { event, nodeId }, task: text(trigger.task, path + '/task', S2_INTERACTION_LIMITS.taskChars),
      ...(normalizedScope ? { scope: normalizedScope } : {}) };
  });
  if (new Set(triggers.map(trigger => trigger.id)).size !== triggers.length) fail('INTERACTION_DUPLICATE', '/interaction/triggers', '触发规则ID重复');
  return { version: 1, triggers };
}

/** Called only after the terminal has resolved a package and its public nodes. */
export function validateS2InteractionReferences(config: S2InteractionConfig, references: {
  publicNodeIds: Iterable<string>; executionNodeIds: Iterable<string>; eventIds?: Iterable<string>;
}): void {
  const publicIds = new Set(references.publicNodeIds), executionIds = new Set(references.executionNodeIds);
  const eventIds = new Set([...S2_BUILTIN_INTERACTION_EVENTS.map(item => item.id), ...(references.eventIds ?? [])]);
  for (const [index, trigger] of readS2InteractionConfig(config).triggers.entries()) {
    const path = `/interaction/triggers/${index}`;
    if (!eventIds.has(trigger.on.event)) fail('INTERACTION_REFERENCE', path + '/on/event', '事件未由底座或当前包声明');
    if (!publicIds.has(trigger.on.nodeId)) fail('INTERACTION_SCOPE', path + '/on/nodeId', '触发来源必须是公开节点');
    const currentScope = readS2InteractionScope(trigger.scope);
    if (currentScope.nodeIds?.some(id => !publicIds.has(id))) fail('INTERACTION_SCOPE', path + '/scope/nodeIds', '范围包含非公开节点');
    if (S2_BUILTIN_INTERACTION_EVENTS.some(item => item.id === trigger.on.event) && !executionIds.has(trigger.on.nodeId)) fail('INTERACTION_REFERENCE', path + '/on/nodeId', '节点执行事件需要执行组件');
  }
}

export function readS2PackInteraction(raw: unknown, packId: string): S2PackInteraction {
  const value = object(snapshotS2InteractionData(raw, 65536), '/interaction', ['version', 'events'], ['version', 'events']);
  if (value.version !== 1) fail('INTERACTION_VERSION', '/interaction/version', '仅支持交互协议版本1');
  const events = list(value.events, '/interaction/events', S2_INTERACTION_LIMITS.events).map((raw, index) => {
    const path = `/interaction/events/${index}`, event = object(raw, path, ['id', 'purpose', 'dataSchema'], ['id', 'purpose', 'dataSchema']);
    const name = eventId(event.id, path + '/id');
    if (!name.startsWith(`${packId}.`) || name.startsWith('s2.')) fail('INTERACTION_SCOPE', path + '/id', '自定义事件只能使用当前包命名空间');
    let dataSchema: S2ValueSchema;
    try { dataSchema = readS2ValueSchema(event.dataSchema); }
    catch { return fail('INTERACTION_SCHEMA', path + '/dataSchema', '需要受支持的有界数据结构'); }
    return { id: name, purpose: text(event.purpose, path + '/purpose', 600), dataSchema };
  });
  if (new Set(events.map(event => event.id)).size !== events.length) fail('INTERACTION_DUPLICATE', '/interaction/events', '事件ID重复');
  return { version: 1, events };
}
export function validateS2InteractionEventData(declaration: S2InteractionEventDeclaration, raw: unknown): S2Json {
  const data = snapshotS2InteractionData(raw, 32768);
  try { validateS2ValueSchema(declaration.dataSchema, data); }
  catch { fail('INTERACTION_EVENT_DATA', '/event/data', '事件数据不符合声明的结构或限制'); }
  return data as S2Json;
}

function endpoint(raw: unknown, path: string) {
  const value = object(raw, path, ['nodeId', 'portId'], ['nodeId', 'portId']);
  return { nodeId: id(value.nodeId, path + '/nodeId'), portId: id(value.portId, path + '/portId') };
}
function connection(raw: unknown, path: string) {
  const value = object(raw, path, ['source', 'target'], ['source', 'target']);
  return { source: endpoint(value.source, path + '/source'), target: endpoint(value.target, path + '/target') };
}
function values(raw: unknown, path: string): Record<string, S2Json> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length > 16) fail('INTERACTION_FIELD', path, '需要最多16项的公开参数对象');
  Object.keys(raw).forEach(key => id(key, child(path, key)));
  return raw as Record<string, S2Json>;
}
function action(raw: unknown, index: number): S2InteractionAction {
  const path = `/actions/${index}`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('INTERACTION_FIELD', path, '需要动作对象');
  const type = (raw as Record<string, unknown>).type;
  if (type === 'addNode') {
    const value = object(raw, path, ['type', 'node'], ['type', 'node']);
    const node = object(value.node, path + '/node', ['id', 'componentId', 'position', 'label', 'readOnly', 'values'], ['id', 'componentId', 'position']);
    const position = object(node.position, path + '/node/position', ['x', 'y'], ['x', 'y']);
    if (![position.x, position.y].every(value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 100000)) fail('INTERACTION_DATA', path + '/node/position', '位置需要有界有限坐标');
    if (node.readOnly !== undefined && typeof node.readOnly !== 'boolean') fail('INTERACTION_DATA', path + '/node/readOnly', '只读状态需要布尔值');
    return { type, node: { id: id(node.id, path + '/node/id'), componentId: id(node.componentId, path + '/node/componentId'),
      position: { x: position.x, y: position.y }, ...(node.label === undefined ? {} : { label: text(node.label, path + '/node/label', 80, true) }),
      ...(node.readOnly === undefined ? {} : { readOnly: node.readOnly }), ...(node.values === undefined ? {} : { values: values(node.values, path + '/node/values') }) } };
  }
  if (type === 'setValues' || type === 'removeNode') {
    const value = object(raw, path, type === 'setValues' ? ['type', 'nodeId', 'values'] : ['type', 'nodeId'], type === 'setValues' ? ['type', 'nodeId', 'values'] : ['type', 'nodeId']);
    const nodeId = id(value.nodeId, path + '/nodeId');
    return type === 'setValues' ? { type, nodeId, values: values(value.values, path + '/values') } : { type, nodeId };
  }
  if (type === 'connect' || type === 'disconnect') {
    const value = object(raw, path, ['type', 'connection'], ['type', 'connection']);
    return { type, connection: connection(value.connection, path + '/connection') };
  }
  if (type === 'run') {
    const value = object(raw, path, ['type', 'targetNodeIds'], ['type', 'targetNodeIds']);
    return { type, targetNodeIds: strings(value.targetNodeIds, path + '/targetNodeIds', S2_INTERACTION_LIMITS.targets, false, 1) };
  }
  if (type === 'cancel') {
    const value = object(raw, path, ['type', 'runId'], ['type', 'runId']);
    return { type, runId: text(value.runId, path + '/runId', 160) };
  }
  return fail('INTERACTION_ACTION', path + '/type', '动作未在统一公开接口中定义');
}
export function readS2InteractionResponse(raw: unknown): S2InteractionResponse {
  const value = object(snapshotS2InteractionData(raw), '/', ['reply', 'actions', 'read']);
  const response: S2InteractionResponse = {};
  if (value.reply !== undefined) response.reply = text(value.reply, '/reply', S2_INTERACTION_LIMITS.replyChars, true);
  if (value.actions !== undefined) response.actions = list(value.actions, '/actions', S2_INTERACTION_LIMITS.actions).map(action);
  if (value.read !== undefined) {
    const read = object(value.read, '/read', ['nodeIds', 'values', 'componentIds', 'interfaces', 'resultIds', 'packageInstructions', 'eventData']);
    const request: S2InteractionRead = {};
    if (read.nodeIds !== undefined) request.nodeIds = strings(read.nodeIds, '/read/nodeIds', S2_INTERACTION_LIMITS.readNodes);
    if (read.values !== undefined) request.values = list(read.values, '/read/values', S2_INTERACTION_LIMITS.readNodes).map((raw, index) => {
      const path = `/read/values/${index}`, selection = object(raw, path, ['nodeId', 'parameterIds'], ['nodeId', 'parameterIds']);
      return { nodeId: id(selection.nodeId, path + '/nodeId'), parameterIds: strings(selection.parameterIds, path + '/parameterIds', S2_INTERACTION_LIMITS.readInterfaceFields, false, 1) };
    });
    const nodeIds = [...(request.nodeIds ?? []), ...(request.values ?? []).map(selection => selection.nodeId)];
    if (nodeIds.length > S2_INTERACTION_LIMITS.readNodes) fail('INTERACTION_LIMIT', '/read/values', '完整及局部实例值合计最多读取4个节点');
    if (new Set(nodeIds).size !== nodeIds.length) fail('INTERACTION_DUPLICATE', '/read/values', '节点不能重复或同时完整与局部读取');
    if (read.componentIds !== undefined) request.componentIds = strings(read.componentIds, '/read/componentIds', S2_INTERACTION_LIMITS.readComponents);
    if (read.interfaces !== undefined) request.interfaces = list(read.interfaces, '/read/interfaces', S2_INTERACTION_LIMITS.readComponents).map((raw, index) => {
      const path = `/read/interfaces/${index}`;
      const selection = object(raw, path, ['componentId', 'parameters', 'inputs', 'outputs'], ['componentId']);
      const result: S2InteractionInterfaceRead = { componentId: id(selection.componentId, path + '/componentId') };
      for (const kind of ['parameters', 'inputs', 'outputs'] as const)
        if (selection[kind] !== undefined) result[kind] = strings(selection[kind], path + '/' + kind, S2_INTERACTION_LIMITS.readInterfaceFields);
      if ((['parameters', 'inputs', 'outputs'] as const).some(kind => Object.hasOwn(selection, kind))
        && !(['parameters', 'inputs', 'outputs'] as const).some(kind => result[kind]?.length))
        fail('INTERACTION_READ', path, '显式局部接口读取须选择至少一个公开参数或端口');
      return result;
    });
    const componentIds = [...(request.componentIds ?? []), ...(request.interfaces ?? []).map(selection => selection.componentId)];
    if (componentIds.length > S2_INTERACTION_LIMITS.readComponents) fail('INTERACTION_LIMIT', '/read/interfaces', '完整及局部接口合计最多读取8个组件');
    if (new Set(componentIds).size !== componentIds.length) fail('INTERACTION_DUPLICATE', '/read/interfaces', '组件不能重复或同时完整与局部读取');
    if (read.resultIds !== undefined) request.resultIds = strings(read.resultIds, '/read/resultIds', S2_INTERACTION_LIMITS.readResults, true);
    if (read.packageInstructions !== undefined) {
      if (read.packageInstructions !== true) fail('INTERACTION_READ', '/read/packageInstructions', '包说明补读仅接受true');
      request.packageInstructions = true;
    }
    if (read.eventData !== undefined) {
      if (read.eventData !== true) fail('INTERACTION_READ', '/read/eventData', '事件数据补读仅接受true');
      request.eventData = true;
    }
    if (!Object.values(request).some(value => value === true || Array.isArray(value) && value.length > 0)) fail('INTERACTION_READ', '/read', '补读请求不能为空');
    if (Object.hasOwn(value, 'actions')) fail('INTERACTION_READ', '/', '补读与执行动作不能在同次响应混合');
    response.read = request;
  }
  if (!response.reply?.trim() && !response.actions?.length && !response.read) fail('INTERACTION_RESPONSE', '/', '需要回复、动作或补读请求');
  return response;
}
/** A local preparation call may be a no-op; this does not make an empty model
 * response valid. Both paths use the exact same action vocabulary and limits. */
export function readS2InteractionActions(raw: unknown): S2InteractionAction[] {
  return list(snapshotS2InteractionData(raw), '/actions', S2_INTERACTION_LIMITS.actions).map(action);
}
