import type { S2Artifact, S2Json, S2PluginInvocation, S2PluginManifest, S2PluginNode } from '../../types/sceneS2Plugin';
import { readS2Artifact } from './sceneS2PluginProtocol';
import { s2BuiltinPluginRegistry } from './sceneS2PluginRegistry';

const types = { 'merge-json': 'structured-data.value', 'merge-assessment': 'core.assessment', 'merge-simulation': 'workflow-simulation.result' } as const;
/** Host-reviewed scheduling exception, not a flag supplied by a model or scene. */
export function isS2ExclusiveMerge(ref: Pick<S2PluginNode, 'pluginId' | 'pluginVersion' | 'capabilityId'>) {
  return ref.pluginId === 'workflow-merge' && ref.pluginVersion === '1.0.0' && Object.hasOwn(types, ref.capabilityId);
}
export const S2_MERGE_PLUGIN: S2PluginManifest = {
  protocolVersion: 1, id: 'workflow-merge', version: '1.0.0', label: '互斥分支合流',
  meaning: '只转交唯一命中分支的完整产物，保留语义类型。不合并多路、不择优、不掩盖失败；仅由宿主执行图调度。',
  dependencies: [{ id: 'core', version: '1.0.0' }, { id: 'structured-data', version: '1.0.0' }, { id: 'workflow-simulation', version: '1.0.0' }], dataTypes: [],
  capabilities: Object.entries(types).map(([id, type]) => ({
    id, kind: 'transform', meaning: `互斥合流 ${type}：candidates 可接多路同类型分支。仅跳过未命中分支；失败/阻塞不当作跳过。零路命中则跳过，多路同时成功则冲突报错，只有一路时原样转交 selected。需要执行图确认，不接受单次调用。`,
    inputs: [{ id: 'candidates', label: '候选分支', meaning: '同语义类型的候选数据；不是任意混合类型，不能把模拟转为事实。', type: { id: type, version: 1 }, required: true, multiple: true }],
    outputs: [{ id: 'selected', label: '唯一命中结果', meaning: '唯一命中分支的完整值；保留原语义类型，合流不是验证。', type: { id: type, version: 1 }, required: true, multiple: false }],
    effect: 'pure', permissions: [], confirmation: 'none', retry: 'manual-only', timeoutMs: 1000,
  })),
};

/** Deterministic value forwarding only. The host records selected/skipped source IDs separately. */
export async function executeS2Merge(call: S2PluginInvocation, inputs: Record<string, S2Json[]>) {
  if (!isS2ExclusiveMerge(call)) throw new Error('未安装此合流执行器');
  try {
    if (inputs.candidates?.length !== 1) throw new Error('互斥合流必须恰好一路候选；不能自动选择或拼接');
    const artifact: S2Artifact = { protocolVersion: 1, id: `artifact-${crypto.randomUUID()}`, type: { id: types[call.capabilityId as keyof typeof types], version: 1 }, complete: true,
      source: { sceneId: call.sceneId, runId: call.runId, nodeId: call.nodeId, revision: call.revision, kind: 'plugin', invocationId: call.id },
      payload: { kind: 'inline', value: structuredClone(inputs.candidates[0]) } };
    readS2Artifact(s2BuiltinPluginRegistry(), artifact);
    return { status: 'succeeded', outputs: { selected: [artifact] } };
  } catch (error) {
    return { status: 'failed', outputs: {}, error: { code: 'MERGE_REJECTED', message: (error instanceof Error ? error.message : '合流失败').slice(0, 1000) } };
  }
}
