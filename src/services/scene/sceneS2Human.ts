import type { S2Json, S2PluginManifest, S2PluginNode, S2PluginPort } from '../../types/sceneS2Plugin';
import type { S2Field } from '../../types/sceneS2';

const port = (id: string, type: string, required = true): S2PluginPort => ({ id, label: id === 'prompt' ? '向用户提出的要求' : id,
  meaning: `${id} 完整数据`, type: { id: type, version: 1 }, required, multiple: false });
/** Reviewed host-owned user interaction, never a tool adapter or a model-fillable answer. */
export const S2_HUMAN_PLUGIN: S2PluginManifest = {
  protocolVersion: 1, id: 'human-input', version: '1.0.0', label: '人工输入与确认',
  meaning: '在选中执行图内等待用户原始文本、JSON或明确确认；输入是用户数据，不是事实验证或新增授权。',
  dependencies: [{ id: 'core', version: '1.0.0' }, { id: 'structured-data', version: '1.0.0' }, { id: 'workflow-simulation', version: '1.0.0' }],
  dataTypes: [{ id: 'human-input.decision', version: 1, meaning: '用户对此次等待内容的明确选择，不是工具权限或业务执行结果。',
    schema: { kind: 'object', required: ['approved'], fields: { approved: { kind: 'boolean' } } } }],
  capabilities: [
    { id: 'text', type: 'core.text', output: 'text', meaning: '等待用户填写非空原始文本，最多6000字；不替用户回答或自动缓存答案。' },
    { id: 'json', type: 'structured-data.value', output: 'value', meaning: '等待用户提交完整有界JSON；格式不合法时保留等待和草稿，不自动修复。' },
    { id: 'confirm', type: 'human-input.decision', output: 'decision', meaning: '等待用户明确同意或拒绝；输出approved布尔值，由显式条件控制后续分支，不扩大插件权限。' },
  ].map(item => ({ id: item.id, kind: 'human', meaning: item.meaning,
    inputs: [port('prompt', 'core.text'), port('context', 'structured-data.value', false), port('simulation', 'workflow-simulation.result', false)],
    outputs: [port(item.output, item.type)], effect: 'read', permissions: [], confirmation: 'per-call', retry: 'manual-only', timeoutMs: 1000 })),
};
export const isS2Human = (node: Omit<S2PluginNode, 'id'>) => node.pluginId === 'human-input' && node.pluginVersion === '1.0.0' && ['text', 'json', 'confirm'].includes(node.capabilityId);
export interface S2HumanWait {
  id: string; nodeId: string; capabilityId: 'text' | 'json' | 'confirm'; prompt: string; contextArtifactIds: string[];
  /** Captured UI schema for this wait, never a new permission or a replacement for the output type. */
  responseForm?: S2Field;
}
export function s2HumanValue(capabilityId: string, raw: unknown): S2Json {
  if (capabilityId === 'confirm') {
    if (typeof raw !== 'boolean') throw new Error('必须由用户明确选择同意或拒绝'); return { approved: raw };
  }
  if (capabilityId === 'text' && (typeof raw !== 'string' || !raw.trim())) throw new Error('请填写非空文本，原始格式会完整保留');
  return raw as S2Json; // Exact output type, size and reserved-key checks are performed by readS2Artifact in the host.
}
