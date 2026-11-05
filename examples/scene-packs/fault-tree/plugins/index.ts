import type { S2PluginManifest, S2PluginInvocation, S2Json, S2PluginOutcome } from '../../../../src/types/sceneS2Plugin';
import { PLUGIN_ID, VERSION, dataTypes, isFaultTreeNode } from '../domain';
import { eventCapability, executeEvent } from './event';
import { gateCapability, executeGate } from './gate';
export const logicPlugin: S2PluginManifest = { protocolVersion: 1, id: PLUGIN_ID, version: VERSION, label: '事故树结构语义',
  meaning: '事件描述与 AND/OR 组合关系；不计算概率或认定真实事故', dependencies: [{ id: 'core', version: '1.0.0' }], dataTypes,
  capabilities: [eventCapability, gateCapability] };
export async function executeLocal(call: S2PluginInvocation, inputs: Record<string, S2Json[]>, signal: AbortSignal): Promise<S2PluginOutcome> {
  if (signal.aborted) return { status: 'cancelled', outputs: {}, error: { code: 'CANCELLED', message: '本次结构处理已取消' } };
  if (!isFaultTreeNode(call) || !['event', 'gate'].includes(call.capabilityId)) return { status: 'failed', outputs: {}, error: { code: 'UNSUPPORTED_CALL', message: '未实现的事故树能力或版本' } };
  return call.capabilityId === 'event' ? executeEvent(call, inputs) : executeGate(call, inputs);
}
