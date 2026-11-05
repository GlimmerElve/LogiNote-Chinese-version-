import type { S2Json, S2PluginCapability, S2PluginInvocation, S2PluginOutcome } from '../../../../src/types/sceneS2Plugin';
import { artifact, GATE_INPUT_PORTS, MAX_GATE_INPUTS, MAX_INPUTS_PER_PORT, isEventValue, isGateType } from '../domain';
export const gateCapability: S2PluginCapability = {
  id: 'gate', kind: 'transform', meaning: '组合2至32个不同下级事件，AND表示全部发生，OR表示至少一个发生；不判断现实事件是否发生',
  inputs: [
    { id: 'gateType', label: '门类型', meaning: 'AND 与门或 OR 包含式或门', type: { id: 'fault-tree-logic.gate-type', version: 1 }, required: true, multiple: false },
    ...GATE_INPUT_PORTS.map((id, index) => ({ id, label: `事件接入点${index + 1}`, meaning: '下级事件集合；两点合并后至少2个不同事件、合计最多32个。可集中连接同一点，禁止同一事件重复计入；AND对全部输入取且，OR对全部输入取或', type: { id: 'fault-tree-logic.event', version: 1 }, required: false, multiple: true })),
  ],
  outputs: [{ id: 'condition', label: '组合条件', meaning: '向一个上级事件提供的结构组合', type: { id: 'fault-tree-logic.condition', version: 1 }, required: true, multiple: false }],
  effect: 'pure', permissions: [], confirmation: 'none', retry: 'manual-only', timeoutMs: 1000,
};
export function executeGate(call: S2PluginInvocation, inputs: Record<string, S2Json[]>): S2PluginOutcome {
  const operator = inputs.gateType?.[0];
  const events: unknown[] = GATE_INPUT_PORTS.flatMap(id => inputs[id] ?? []);
  if (Object.keys(inputs).some(key => !['gateType', ...GATE_INPUT_PORTS].includes(key)) || inputs.gateType?.length !== 1
    || GATE_INPUT_PORTS.some(id => (inputs[id]?.length ?? 0) > MAX_INPUTS_PER_PORT)
    || !isGateType(operator) || events.length < 2 || events.length > MAX_GATE_INPUTS
    || !events.every(isEventValue) || events.some(event => event.eventType === 'top')
    || new Set(events.map(event => event.eventId)).size !== events.length)
    return { status: 'failed', outputs: {}, error: { code: 'INVALID_GATE', message: '逻辑门需要 AND/OR 类型及2至32个不同的完整非顶事件' } };
  return { status: 'succeeded', outputs: { condition: [artifact(call, 'fault-tree-logic.condition', { gateId: call.nodeId, operator, inputEventIds: events.map(event => event.eventId) })] } };
}
