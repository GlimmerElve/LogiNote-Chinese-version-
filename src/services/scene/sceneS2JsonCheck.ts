import type { S2Json } from '../../types/sceneS2Plugin';
import type { S2LocalAdapter } from './sceneS2PluginInstallation';

/** Reviewed local adapter; grammar validity is an assessment, never a business-success claim. */
export const executeS2JsonCheck: S2LocalAdapter = async (call, inputs) => {
  if (call.pluginId !== 'json-check' || call.pluginVersion !== '1.0.0' || call.capabilityId !== 'validate') throw new Error('未安装执行适配器');
  let assessment: S2Json;
  try {
    const value = JSON.parse(inputs.text[0] as string);
    assessment = { status: 'pass', reason: '完整文本符合 JSON 语法；未检查业务语义、schema 或事实。', evidence: [`顶层类型：${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}`] };
  } catch (e) {
    assessment = { status: 'fail', reason: '完整文本不符合 JSON 语法；未自动修复或剥离代码围栏。', evidence: [(e as Error).message.slice(0, 500)] };
  }
  return { status: 'succeeded', outputs: { assessment: [{ protocolVersion: 1, id: `artifact-${crypto.randomUUID()}`, type: { id: 'core.assessment', version: 1 }, complete: true,
    source: { sceneId: call.sceneId, runId: call.runId, nodeId: call.nodeId, revision: call.revision, kind: 'plugin', invocationId: call.id }, payload: { kind: 'inline', value: assessment } }] } };
};
