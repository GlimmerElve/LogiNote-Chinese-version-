import type { S2Json, S2PluginCapability, S2PluginInvocation, S2PluginOutcome } from '../../../../src/types/sceneS2Plugin';
import { artifact, isContent, isEventType, isCondition } from '../domain';
export const eventCapability: S2PluginCapability = {
  id: 'event', kind: 'transform', meaning: '关联事件描述与其直接逻辑条件，不推断真实发生状态',
  inputs: [
    { id: 'eventType', label: '事件类型', meaning: '顶/中间/基本事件', type: { id: 'fault-tree-logic.event-type', version: 1 }, required: true, multiple: false },
    { id: 'content', label: '内容', meaning: '事件完整内容，最多2000字', type: { id: 'fault-tree-logic.content', version: 1 }, required: true, multiple: false },
    { id: 'condition', label: '下级逻辑门', meaning: '定义本事件的门条件；基本事件不接此端口', type: { id: 'fault-tree-logic.condition', version: 1 }, required: false, multiple: false },
  ],
  outputs: [{ id: 'event', label: '事件', meaning: '供上级逻辑门引用的事件描述', type: { id: 'fault-tree-logic.event', version: 1 }, required: true, multiple: false }],
  effect: 'pure', permissions: [], confirmation: 'none', retry: 'manual-only', timeoutMs: 1000,
};
export function executeEvent(call: S2PluginInvocation, inputs: Record<string, S2Json[]>): S2PluginOutcome {
  const eventType = inputs.eventType?.[0], content = inputs.content?.[0], definition = inputs.condition?.[0];
  if (Object.keys(inputs).some(key => !['eventType', 'content', 'condition'].includes(key)) || inputs.eventType?.length !== 1 || inputs.content?.length !== 1
    || (inputs.condition?.length ?? 0) > 1 || !isEventType(eventType) || !isContent(content) || definition !== undefined && !isCondition(definition)
    || eventType === 'basic' && definition !== undefined || eventType !== 'basic' && definition === undefined)
    return { status: 'failed', outputs: {}, error: { code: 'INVALID_EVENT', message: '需要合法事件类型、非空内容及符合事件类型的逻辑门连接' } };
  return { status: 'succeeded', outputs: { event: [artifact(call, 'fault-tree-logic.event', { eventId: call.nodeId, eventType, content, ...(definition !== undefined ? { definition: structuredClone(definition) } : {}) })] } };
}
