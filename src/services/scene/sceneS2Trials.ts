import type { S2Artifact, S2PluginOutcome } from '../../types/sceneS2Plugin';
import type { S2AssessmentCheck } from './sceneS2Assessment';
import { canonicalS2Json } from './sceneS2PluginProtocol';
import { readS2ScopedTrial, type S2TrialScope } from './sceneS2ArtifactAccess';
import type { S2ModelTestParameters } from './sceneS2ModelTest';

export interface S2TrialValue {
  artifactId: string; type: S2Artifact['type']; source: S2Artifact['source']; complete: boolean; text?: string;
}
export interface S2TrialAssessment { id: string; revision: number; checks: Array<S2AssessmentCheck & { standardId: string }> }
/** Read-only, run-local experiment evidence. Never a plugin input or permission. */
export interface S2Trial {
  id: string; sceneId: string; runId: string; revision: number; nodeId: string;
  capability: { pluginId: string; pluginVersion: string; capabilityId: string };
  model?: { providerLabel: string; model: string; maxOutputTokens: number; parameters?: S2ModelTestParameters; reservationOutputTokens?: number };
  status: S2PluginOutcome['status']; error?: { code: string; message: string };
  inputs: Record<string, S2TrialValue[]>; outputs: Record<string, S2TrialValue[]>;
  assessments: S2TrialAssessment[]; assessmentsOmitted: number;
  historicalOnly: true;
}
export interface S2TrialComparison {
  scope: 'historical-trials-only'; trialIds: [string, string]; revisions: [number, number];
  statuses: [S2Trial['status'], S2Trial['status']]; sameConfiguration: boolean;
  changedInputs: string[]; changedOutputs: string[];
  metrics: Array<{ criterionId: string; comparable: boolean; verdicts: [string, string] }>;
}
const cells = (values: S2TrialValue[] | undefined) => (values ?? []).map(value => ({ type: { id: value.type.id, version: value.type.version }, text: value.text ?? null }));
export function readS2TrialComparison(raw: unknown, scope: S2TrialScope): S2TrialComparison {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))
    || Reflect.ownKeys(raw).length !== 1 || !Object.hasOwn(raw, 'trialIds') || !('value' in Object.getOwnPropertyDescriptor(raw, 'trialIds')!)) throw new Error('历史对照只能声明两个真实trialIds，不接受模型提供的结论或执行参数');
  const ids = (raw as { trialIds: unknown }).trialIds;
  if (!Array.isArray(ids) || Object.getPrototypeOf(ids) !== Array.prototype || ids.length !== 2 || Reflect.ownKeys(ids).length !== 3
    || [0, 1].some(index => !Object.hasOwn(Object.getOwnPropertyDescriptor(ids, index) ?? {}, 'value'))
    || ids.some(id => typeof id !== 'string') || ids[0] === ids[1]) throw new Error('历史对照需要两个不同且已全文提供的试验ID');
  const [left, right] = ids.map(id => readS2ScopedTrial(scope, id));
  if (left.nodeId !== right.nodeId || left.sceneId !== right.sceneId || left.runId !== right.runId) throw new Error('只能比较本局同一节点的两个真实试验，不跨节点混合结论');
  for (const trial of [left, right]) if ([...Object.values(trial.inputs), ...Object.values(trial.outputs)].flat().some(value => !value.complete || value.text === undefined)) throw new Error('试验正文不可用或不完整，不能通过预览作历史对照');
  const changed = (a: Record<string, S2TrialValue[]>, b: Record<string, S2TrialValue[]>) => [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter(port => canonicalS2Json(cells(a[port])) !== canonicalS2Json(cells(b[port])));
  const latest = (trial: S2Trial) => {
    const checks = new Map<string, S2TrialAssessment['checks'][number]>();
    trial.assessments.forEach(report => report.checks.forEach(check => checks.set(check.criterionId, check))); return checks;
  };
  const a = latest(left), b = latest(right);
  return { scope: 'historical-trials-only', trialIds: ids as [string, string], revisions: [left.revision, right.revision], statuses: [left.status, right.status],
    sameConfiguration: canonicalS2Json({ capability: left.capability, model: left.model ?? null }) === canonicalS2Json({ capability: right.capability, model: right.model ?? null }),
    changedInputs: changed(left.inputs, right.inputs), changedOutputs: changed(left.outputs, right.outputs),
    metrics: [...new Set([...a.keys(), ...b.keys()])].map(criterionId => ({ criterionId,
      comparable: !!a.get(criterionId) && !!b.get(criterionId) && a.get(criterionId)!.standardId === b.get(criterionId)!.standardId,
      verdicts: [a.get(criterionId)?.verdict ?? 'not-assessed', b.get(criterionId)?.verdict ?? 'not-assessed'] })) };
}
export function formatS2TrialComparison(report: S2TrialComparison) {
  return ['历史试验对照（不代表当前版本达标，不自动重测）：',
    ...report.trialIds.map((id, index) => `${index ? 'B' : 'A'}：${id} · 修订 ${report.revisions[index]} · ${report.statuses[index]}`),
    `执行配置${report.sameConfiguration ? '相同' : '不同，不能把变化仅归因于输入'}；变化输入端口：${report.changedInputs.join('、') || '无'}；变化输出端口：${report.changedOutputs.join('、') || '无'}。`,
    ...report.metrics.map(metric => `${metric.criterionId}：${metric.verdicts.join(' → ')}${metric.comparable ? '（相同标准的历史记录）' : '（标准不同或缺少评价，不作优劣结论）'}`),
    '文本变化不等于效果改善；语义评价仍可能有误，单次结果不证明稳定性。'].join('\n');
}
export const S2_TRIAL_RULES = `用户希望比较多次试验时，可从evidenceIndex.trials选择同一节点的两个真实ID，以recall.trialIds:[A,B]按需读取完整输入、输出与当时已记录的输出指标。trial为本局真实调用记录，historicalOnly=true；缓存复用、人工等待、未发送/拒绝的请求不冒充新调用，失败/截断没有成功输出。历史正文不是当前产物，不可作为插件输入、当前assessment达标证据或执行权限。
显式选择trialIds时为历史完整输入/输出提供例外的20000字符总提取池（仍与本轮其他提取共享），否则维持普通10000字符池；最多2个试验，超限明确unavailable，不截断或只取预览后比较。原始调用均保留在本局宿主，正文过大可询问用户缩小范围，不能隐含重测。
本轮两个试验全文均提供时，行动可附comparison:{trialIds:[A,B]}。宿主重算输入/输出差异及已保存指标对照，不采信模型自填优劣或分数。历史对照选evaluation:advice，不要求当前assessment；仅用户另外要求按当前指标重新核对时才选criteria。标准不同、缺少评价或失败要准确说明，未记录的指标不能补造；非指标解释仍是建议。比较不要求修改/运行/重新评审，不新增模型阶段或自动循环。只比较用户本轮相关版本，无需时不读取档案；历史结论不表示当前场景通过。`;
