import type { S2Artifact, S2Json, S2PluginInvocation, S2PluginManifest, S2ValueSchema } from '../../types/sceneS2Plugin';
import { readS2Artifact } from './sceneS2PluginProtocol';
import { s2BuiltinPluginRegistry } from './sceneS2PluginRegistry';

export interface S2SimulationStep { purpose: string; assumptions: string; input: S2Json; output: S2Json }
export interface S2SimulationResult { mode: 'simulation-only'; steps: S2SimulationStep[] }
const jsonSchema: S2ValueSchema = { kind: 'json', maxDepth: 6, maxEntries: 512, maxBytes: 6000 };
const resultSchema: S2ValueSchema = { kind: 'object', required: ['mode', 'steps'], fields: {
  mode: { kind: 'string', maxLength: 32, enum: ['simulation-only'] },
  steps: { kind: 'array', maxItems: 16, item: { kind: 'object', required: ['purpose', 'assumptions', 'input', 'output'], fields: {
    purpose: { kind: 'string', maxLength: 1000 }, assumptions: { kind: 'string', maxLength: 1000 }, input: jsonSchema, output: jsonSchema,
  } } },
} };
const port = (id: string, label: string, meaning: string, type: string, required = true) => ({ id, label, meaning, type: { id: type, version: 1 }, required, multiple: false });
/** Only declares reviewed local capabilities. Does not load a model, service or executable scene code. */
export const S2_SIMULATION_PLUGIN: S2PluginManifest = {
  protocolVersion: 1, id: 'workflow-simulation', version: '1.0.0', label: '工作流示例模拟',
  meaning: '用户或Agent设计并确认假设和示例输出，本地串接演练。不自动生成示例、不执行真实业务、不验证业务成功；与真实转换类型隔离。',
  dependencies: [{ id: 'core', version: '1.0.0' }, { id: 'structured-data', version: '1.0.0' }],
  dataTypes: [{ id: 'workflow-simulation.result', version: 1, meaning: '仅为假设和示例输出的模拟轨迹，不是事实、真实工具返回或业务成功凭据；最多16步，超限失败不截断。', schema: resultSchema }],
  capabilities: [{ id: 'step', kind: 'transform', meaning: '记录purpose、assumptions及预设sample；初始input可选，或接previous模拟轨迹，将上一步示例输出作为本步输入，二者不能同时提供。sample不随输入自动推导，修改输入后应重新审阅假设和示例。',
    inputs: [port('purpose', '步骤目的', '要模拟的业务步骤，非执行指令。', 'core.text'), port('assumptions', '模拟假设', '明确假设和未验证的限制。', 'core.text'),
      port('sample', '预设示例输出', '用户或Agent确认的示例JSON，不是服务返回。', 'structured-data.value'),
      port('input', '初始试验数据', '可选的完整JSON初始输入；不能和previous同时提供。', 'structured-data.value', false),
      port('previous', '上游模拟轨迹', '将上一步示例输出作为本步输入，保留完整有界轨迹。', 'workflow-simulation.result', false)],
    outputs: [port('result', '仅模拟结果', '完整假设轨迹；禁止冒充真实业务结果。', 'workflow-simulation.result')],
    effect: 'pure', permissions: [], confirmation: 'none', retry: 'manual-only', timeoutMs: 1000 },
  { id: 'inspect', kind: 'renderer', meaning: '只读展示模拟步骤、假设、试验输入和预设输出，始终标记不是真实执行。',
    inputs: [port('result', '仅模拟结果', '完整模拟轨迹。', 'workflow-simulation.result')], outputs: [],
    effect: 'pure', permissions: [], confirmation: 'none', retry: 'manual-only', timeoutMs: 1000 }],
};

/** Deterministic mock-data routing. The Agent proposes the sample through ordinary confirmed edits, not a hidden model call. */
export async function executeS2Simulation(call: S2PluginInvocation, inputs: Record<string, S2Json[]>) {
  if (call.pluginId !== 'workflow-simulation' || call.pluginVersion !== '1.0.0' || call.capabilityId !== 'step') throw new Error('未安装此模拟执行器');
  try {
    const purpose = inputs.purpose?.[0], assumptions = inputs.assumptions?.[0];
    if (typeof purpose !== 'string' || !purpose.trim() || purpose.length > 1000 || typeof assumptions !== 'string' || !assumptions.trim() || assumptions.length > 1000) throw new Error('请填写非空的步骤目的和模拟假设，各最多1000字');
    if (!inputs.sample || inputs.sample.length !== 1) throw new Error('必须明确提供预设示例输出；不会自动猜测或调用模型补全');
    if (inputs.input?.length && inputs.previous?.length) throw new Error('初始input与上游previous不能同时提供，请明确输入来源');
    const previous = inputs.previous?.[0] as unknown as S2SimulationResult | undefined;
    if (previous && (!previous.steps.length || previous.steps.length >= 16)) throw new Error('模拟轨迹需为1至15步；最多累计16步，请拆分试验，不会截断');
    const value: S2SimulationResult = { mode: 'simulation-only', steps: [...(previous?.steps ?? []), {
      purpose, assumptions, input: previous ? previous.steps.at(-1)!.output : inputs.input?.[0] ?? null, output: inputs.sample[0],
    }] };
    const artifact: S2Artifact = { protocolVersion: 1, id: `artifact-${crypto.randomUUID()}`, type: { id: 'workflow-simulation.result', version: 1 }, complete: true,
      source: { sceneId: call.sceneId, runId: call.runId, nodeId: call.nodeId, revision: call.revision, kind: 'plugin', invocationId: call.id }, payload: { kind: 'inline', value: value as unknown as S2Json } };
    readS2Artifact(s2BuiltinPluginRegistry(), artifact); // Full-result limits fail atomically, never publish a partial trace.
    return { status: 'succeeded', outputs: { result: [artifact] } };
  } catch (error) {
    return { status: 'failed', outputs: {}, error: { code: 'SIMULATION_REJECTED', message: (error instanceof Error ? error.message : '模拟配置无效').slice(0, 1000) } };
  }
}
