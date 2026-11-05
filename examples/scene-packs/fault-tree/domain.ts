import type { S2DataType, S2ValueSchema, S2Json, S2PluginInvocation, S2Artifact } from '../../../src/types/sceneS2Plugin';
export const PLUGIN_ID = 'fault-tree-logic', VERSION = '1.0.0', CONTENT_LIMIT = 2000;
// S2 v1 allows 32 sources per input port. Retain both stable port IDs so old
// saved two-input trees keep working; both ports form one unordered input set.
export const GATE_INPUT_PORTS = ['left', 'right'] as const;
export const MAX_INPUTS_PER_PORT = 32, MAX_GATE_INPUTS = 32;
export const EVENT_TYPES = ['top', 'intermediate', 'basic'] as const;
export const GATE_TYPES = ['AND', 'OR'] as const;
export type EventType = typeof EVENT_TYPES[number];
export type GateType = typeof GATE_TYPES[number];
export const EVENT_LABELS: Record<EventType, string> = { top: '顶事件', intermediate: '中间事件', basic: '基本事件' };
export const isEventType = (value: unknown): value is EventType => EVENT_TYPES.includes(value as EventType);
export const isGateType = (value: unknown): value is GateType => GATE_TYPES.includes(value as GateType);
export const isContent = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= CONTENT_LIMIT;
export const isNodeId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value);
export const isFaultTreeNode = (node: { pluginId: string; pluginVersion: string }) => node.pluginId === PLUGIN_ID && node.pluginVersion === VERSION;
const eventTypeSchema: S2ValueSchema = { kind: 'string', maxLength: 12, enum: [...EVENT_TYPES] };
const gateTypeSchema: S2ValueSchema = { kind: 'string', maxLength: 3, enum: [...GATE_TYPES] };
const idSchema: S2ValueSchema = { kind: 'string', maxLength: 64 };
export const conditionSchema: S2ValueSchema = { kind: 'object', required: ['gateId', 'operator', 'inputEventIds'], fields: {
  gateId: idSchema, operator: gateTypeSchema, inputEventIds: { kind: 'array', maxItems: MAX_GATE_INPUTS, item: idSchema },
} };
export interface ConditionValue { gateId: string; operator: GateType; inputEventIds: string[] }
export interface EventValue { eventId: string; eventType: EventType; content: string; definition?: ConditionValue }
export const dataTypes: S2DataType[] = [
  { id: 'fault-tree-logic.content', version: 1, meaning: '事件完整内容，最多2000字；编辑草稿允许为空', schema: { kind: 'string', maxLength: CONTENT_LIMIT } },
  { id: 'fault-tree-logic.event-type', version: 1, meaning: '顶事件、中间事件或基本事件的类型枚举', schema: eventTypeSchema },
  { id: 'fault-tree-logic.gate-type', version: 1, meaning: 'AND 与门或 OR 包含式或门的类型枚举', schema: gateTypeSchema },
  { id: 'fault-tree-logic.condition', version: 1, meaning: '门对2至32个不同事件的结构组合；AND为全部发生，OR为至少一个发生，不是已发生状态', schema: conditionSchema },
  { id: 'fault-tree-logic.event', version: 1, meaning: '事件身份、类型、内容及可选直接定义，不递归复制整棵树', schema: {
    kind: 'object', required: ['eventId', 'eventType', 'content'], fields: { eventId: idSchema, eventType: eventTypeSchema,
      content: { kind: 'string', maxLength: CONTENT_LIMIT }, definition: conditionSchema },
  } },
];
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export const isCondition = (value: unknown): value is ConditionValue => object(value) && Object.keys(value).length === 3
  && isNodeId(value.gateId) && isGateType(value.operator) && Array.isArray(value.inputEventIds)
  && value.inputEventIds.length >= 2 && value.inputEventIds.length <= MAX_GATE_INPUTS
  && value.inputEventIds.every(isNodeId) && new Set(value.inputEventIds).size === value.inputEventIds.length;
export const isEventValue = (value: unknown): value is EventValue => object(value)
  && Object.keys(value).every(key => ['eventId', 'eventType', 'content', 'definition'].includes(key))
  && isNodeId(value.eventId) && isEventType(value.eventType) && isContent(value.content)
  && (value.eventType === 'basic' ? value.definition === undefined : isCondition(value.definition));
export function artifact(call: S2PluginInvocation, type: string, value: S2Json): S2Artifact {
  return { protocolVersion: 1, id: `fta-${crypto.randomUUID()}`, type: { id: type, version: 1 }, complete: true,
    source: { sceneId: call.sceneId, runId: call.runId, nodeId: call.nodeId, revision: call.revision, kind: 'plugin', invocationId: call.id }, payload: { kind: 'inline', value } };
}
