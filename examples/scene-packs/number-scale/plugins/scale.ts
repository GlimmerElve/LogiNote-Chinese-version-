import type { S2Json, S2PluginInvocation, S2PluginManifest, S2PluginOutcome, S2PluginPort } from '../../../../src/types/sceneS2Plugin';

export const SCALE_PLUGIN_ID = 'example-number-scale';
export const SCALE_PLUGIN_VERSION = '1.0.0';
const port = (id: string, type: string, required = true): S2PluginPort => ({
  id, label: id, meaning: id, type: { id: type, version: 1 }, required, multiple: false,
});
// One source for the operation's allowed input values; runtime.validate reuses these same predicates.
export const amountAllowed = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1_000_000;
export const factorAllowed = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 100;
export const labelAllowed = (value: unknown): value is string => typeof value === 'string' && value.length <= 80;
export const isScaleNode = (node: { pluginId: string; pluginVersion: string; capabilityId: string }) =>
  node.pluginId === SCALE_PLUGIN_ID && node.pluginVersion === SCALE_PLUGIN_VERSION && node.capabilityId === 'scale';

export const scalePlugin: S2PluginManifest = {
  protocolVersion: 1, id: SCALE_PLUGIN_ID, version: SCALE_PLUGIN_VERSION, label: '本地数值缩放', meaning: '数值乘法与文字展示，不调用外部服务',
  dependencies: [{ id: 'core', version: '1.0.0' }], dataTypes: [], capabilities: [{ id: 'scale', kind: 'transform',
    meaning: '非负数乘以正倍数，同时输出数值和文本', inputs: [port('amount', 'core.number'), port('factor', 'core.number'), port('label', 'core.text', false)],
    outputs: [port('product', 'core.number'), port('text', 'core.text')], effect: 'pure', permissions: [], confirmation: 'none', retry: 'manual-only', timeoutMs: 1000 }],
};

/** Resolved values in, full source-bound artifacts out. No host/React is passed in and this operation performs no IO. */
export async function executeLocal(call: S2PluginInvocation, inputs: Record<string, S2Json[]>, signal: AbortSignal): Promise<S2PluginOutcome> {
  if (signal.aborted) return { status: 'cancelled', outputs: {}, error: { code: 'CANCELLED', message: '本次运行已取消' } };
  const amount = inputs.amount?.[0], factor = inputs.factor?.[0], label = inputs.label?.[0] ?? '';
  if (!isScaleNode(call) || inputs.amount?.length !== 1 || inputs.factor?.length !== 1 || (inputs.label?.length ?? 0) > 1
    || !amountAllowed(amount) || !factorAllowed(factor) || !labelAllowed(label))
    return { status: 'failed', outputs: {}, error: { code: 'INVALID_INPUT', message: '数值、倍数或名称不符合本包业务范围' } };
  const product = amount * factor;
  const artifact = (type: string, value: S2Json) => ({ protocolVersion: 1 as const, id: `scale-${crypto.randomUUID()}`,
    type: { id: type, version: 1 }, complete: true as const,
    source: { sceneId: call.sceneId, runId: call.runId, nodeId: call.nodeId, revision: call.revision,
      kind: 'plugin' as const, invocationId: call.id }, payload: { kind: 'inline' as const, value } });
  return { status: 'succeeded', outputs: { product: [artifact('core.number', product)],
    text: [artifact('core.text', label ? `${label}：${product}` : String(product))] } };
}
