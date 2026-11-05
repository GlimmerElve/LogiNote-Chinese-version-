import type { S2Json, S2PluginManifest, S2PluginOutcome, S2PluginPort } from '../../../../src/types/sceneS2Plugin';
import type { SceneInteractionPack } from '../../../../src/types/sceneInteractionPack';

export const isStudyNode = (node: { pluginId: string; pluginVersion: string; capabilityId: string }) =>
  node.pluginId === 'example-material-study' && node.pluginVersion === '1.0.0' && node.capabilityId === 'summarize';
export const factorAllowed = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 2;
const port = (id: string, type: string): S2PluginPort => ({ id, label: id, meaning: id, type: { id: type, version: 1 }, required: true, multiple: false });
export const studyPlugin: S2PluginManifest = {
  protocolVersion: 1, id: 'example-material-study', version: '1.0.0', label: '学习物料汇总', meaning: '读取本包不可变示例数据并计算均分',
  dependencies: [{ id: 'core', version: '1.0.0' }], dataTypes: [], capabilities: [{ id: 'summarize', kind: 'transform',
    meaning: '读取本包 scores JSON 和说明文本，按正倍数输出平均分及说明', inputs: [port('factor', 'core.number')],
    outputs: [port('mean', 'core.number'), port('report', 'core.text')], effect: 'pure', permissions: [], confirmation: 'none', retry: 'manual-only', timeoutMs: 2000 }],
};

export interface StudyData { title: string; unit: string; target: number; scores: Array<{ label: string; value: number }> }
/** The material protocol checks bytes/media integrity; this package checks its own JSON business shape. */
export function readStudyData(bytes: Uint8Array): StudyData {
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as StudyData;
  if (!value || typeof value.title !== 'string' || typeof value.unit !== 'string' || !Number.isFinite(value.target)
    || !Array.isArray(value.scores) || !value.scores.length || value.scores.length > 12
    || value.scores.some(row => !row || typeof row.label !== 'string' || !Number.isFinite(row.value) || row.value < 0 || row.value > 100))
    throw new Error('STUDY_DATA_INVALID: 学习数据需要 1 至 12 项 0 至 100 分成绩');
  return value;
}

export const executeLocal: SceneInteractionPack['executeLocal'] = async (call, inputs, signal, context): Promise<S2PluginOutcome> => {
  if (signal.aborted) return { status: 'cancelled', outputs: {}, error: { code: 'CANCELLED', message: '本次运行已取消' } };
  if (!isStudyNode(call) || inputs.factor?.length !== 1 || !factorAllowed(inputs.factor[0]))
    return { status: 'failed', outputs: {}, error: { code: 'INVALID_INPUT', message: '倍数须大于 0 且不超过 2' } };
  if (!context?.materials) return { status: 'failed', outputs: {}, error: { code: 'MATERIALS_UNAVAILABLE', message: '当前宿主未提供本包物料作用域' } };
  try {
    // IDs only: the scope resolves exact package/version; no source path or URL enters bindings or outputs.
    const [scores, guide] = await Promise.all([context.materials.read('scores', signal), context.materials.read('guide', signal)]);
    const data = readStudyData(scores.data), factor = inputs.factor[0];
    const mean = Math.round(data.scores.reduce((sum, row) => sum + row.value, 0) / data.scores.length * factor * 100) / 100;
    const note = new TextDecoder('utf-8', { fatal: true }).decode(guide.data).trim();
    if (signal.aborted) return { status: 'cancelled', outputs: {}, error: { code: 'CANCELLED', message: '本次运行已取消' } };
    const artifact = (type: string, value: S2Json) => ({ protocolVersion: 1 as const, id: `study-${crypto.randomUUID()}`,
      type: { id: type, version: 1 }, complete: true as const,
      source: { sceneId: call.sceneId, runId: call.runId, nodeId: call.nodeId, revision: call.revision, kind: 'plugin' as const, invocationId: call.id },
      payload: { kind: 'inline' as const, value } });
    return { status: 'succeeded', outputs: { mean: [artifact('core.number', mean)],
      report: [artifact('core.text', `${data.title}：${data.scores.length} 次，平均 ${mean} ${data.unit}（参考 ${data.target} ${data.unit}）。\n${note}`)] } };
  } catch (error) {
    return { status: signal.aborted ? 'cancelled' : 'failed', outputs: {}, error: { code: signal.aborted ? 'CANCELLED' : 'MATERIAL_READ_FAILED',
      message: error instanceof Error ? error.message : '无法读取本包物料' } };
  }
};
