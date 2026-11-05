import type { S2Json, S2PluginInvocation, S2PluginManifest, S2PluginOutcome } from '../../../../src/types/sceneS2Plugin';

export const PLUGIN_ID = 'text-echo-demo-logic';
export const MAX_TEXT_LENGTH = 2000;
export const textAllowed = (value: unknown): value is string => typeof value === 'string' && value.length <= MAX_TEXT_LENGTH;
export const isEcho = (node: { pluginId: string; pluginVersion: string; capabilityId: string }) =>
  node.pluginId === PLUGIN_ID && node.pluginVersion === '1.0.0' && node.capabilityId === 'echo';

export const echoPlugin: S2PluginManifest = {
  protocolVersion: 1, id: PLUGIN_ID, version: '1.0.0', label: '文字回显', meaning: '纯本地原文传递，无模型或文件依赖',
  dependencies: [{ id: 'core', version: '1.0.0' }],
  dataTypes: [{ id: 'text-echo-demo-logic.text', version: 1, meaning: '最多2000字符的完整用户文字，允许空字符串', schema: { kind: 'string', maxLength: MAX_TEXT_LENGTH } }],
  capabilities: [{
    id: 'echo', kind: 'transform', meaning: '原样返回输入文字，保留空格、换行及标点，不添加前后缀',
    inputs: [{ id: 'text', label: '文字', meaning: '待回显的完整文字', type: { id: 'text-echo-demo-logic.text', version: 1 }, required: true, multiple: false }],
    outputs: [{ id: 'text', label: '原文', meaning: '未经改写的完整输入文字', type: { id: 'core.text', version: 1 }, required: true, multiple: false }],
    effect: 'pure', permissions: [], confirmation: 'none', retry: 'manual-only', timeoutMs: 1000,
  }],
};

export async function executeLocal(call: S2PluginInvocation, inputs: Record<string, S2Json[]>, signal: AbortSignal): Promise<S2PluginOutcome> {
  if (signal.aborted) return { status: 'cancelled', outputs: {}, error: { code: 'CANCELLED', message: '本次回显已取消' } };
  const text = inputs.text?.[0];
  if (!isEcho(call) || Object.keys(inputs).some(id => id !== 'text') || inputs.text?.length !== 1 || !textAllowed(text))
    return { status: 'failed', outputs: {}, error: { code: 'INVALID_TEXT', message: '需要一份不超过2000字符的文字' } };
  return { status: 'succeeded', outputs: { text: [{
    protocolVersion: 1, id: `echo-${crypto.randomUUID()}`, type: { id: 'core.text', version: 1 }, complete: true,
    source: { sceneId: call.sceneId, runId: call.runId, nodeId: call.nodeId, revision: call.revision, kind: 'plugin', invocationId: call.id },
    payload: { kind: 'inline', value: text },
  }] } };
}
