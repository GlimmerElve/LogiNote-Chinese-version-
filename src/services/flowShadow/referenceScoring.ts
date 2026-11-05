import { verifiedShadowUserEvidence } from './scoring.ts';
import { arithmeticVerificationDecision } from './literalArithmetic';
import type {
  ShadowAssessment, ShadowGraph, ShadowInput, ShadowLayer, ShadowReferencePacket,
  ShadowReferenceScoring, ShadowWarning,
} from './types.ts';

const LAYERS: ShadowLayer[] = ['concept', 'judgment', 'reasoning'];
const round = (value: number) => Math.round(value * 10) / 10;

/** Source-grounded scores are separate from internal expression/reasoning scores. */
export function scoreShadowReferenceAssessment(input: ShadowInput, graph: ShadowGraph, packet: ShadowReferencePacket,
  assessment: ShadowAssessment): ShadowReferenceScoring {
  const warnings: ShadowWarning[] = [];
  const userEvidence = verifiedShadowUserEvidence(input, graph, assessment).evidence;
  const targets = new Map(packet.targets.map(target => [target.id, target]));
  const items = new Map(packet.items.map(item => [item.id, item]));
  const selections = new Map(packet.selection.map(selection => [selection.targetId, selection]));
  const counts = new Map<string, number>();
  for (const comparison of assessment.referenceComparisons) counts.set(comparison.targetId, (counts.get(comparison.targetId) || 0) + 1);
  const accepted = new Map<string, number>();
  const arithmetic = arithmeticVerificationDecision(input, graph, assessment);
  const pendingTargets = new Set<string>();

  for (const comparison of assessment.referenceComparisons) {
    const target = targets.get(comparison.targetId);
    let message = '';
    const scored = ['aligned', 'partially_aligned', 'misaligned'].includes(comparison.state);
    const references = comparison.referenceIds.map(id => items.get(id));
    const selection = selections.get(comparison.targetId);
    const pending = target?.nodeIds.some(id => arithmetic.pendingNodes.has(id));
    const wrongCurrent = target?.nodeIds.some(id => arithmetic.currentMismatchNodes.has(id));
    const excluded = target?.nodeIds[0] && arithmetic.excludedMismatchNodes.has(target.nodeIds[0]);
    if (pending || wrongCurrent && (comparison.state === 'aligned' || comparison.level !== null && comparison.level >= 3)
      || excluded && scored) {
      message = '资料对照涉及未核清或已排除的错误算式，不能按一致内容计分；暂缓该目标，不自动改等级。';
      pendingTargets.add(comparison.targetId);
    } else if (!target || counts.get(comparison.targetId) !== 1) message = '对照目标不存在或同一目标被重复评价。';
    else if (comparison.layer !== target.layer) message = '对照层级与检索目标不一致。';
    else if (!comparison.reason.trim()) message = '资料对照缺少简短理由。';
    else if (comparison.state === 'conflicted' || comparison.state === 'insufficient_reference' || comparison.state === 'not_applicable') {
      if (comparison.level !== null) message = '冲突、不足或不适用必须保留空分。';
    } else if (!scored || !Number.isInteger(comparison.level) || comparison.level! < 0 || comparison.level! > 4) {
      message = '可评分资料对照需要0～4整数等级。';
    } else if (!comparison.userEvidenceIds.length || comparison.userEvidenceIds.some(id => !userEvidence.has(id))) {
      message = '资料对照缺少有效的用户原话证据。';
    } else if (!comparison.referenceIds.length || references.some(item => !item || item.availability !== 'available' || item.tier > 3)) {
      message = '资料对照引用了不可用来源或LLM既有知识。';
    } else if (references.some(item => item!.targetId !== comparison.targetId)) {
      message = '资料证据属于其他评价目标。';
    } else if (!selection?.primaryTier || !references.some(item => item!.tier === selection.primaryTier)) {
      message = '评分必须至少引用当前目标可用的最高优先级资料。';
    }
    if (message) warnings.push({ code: 'reference_comparison_withheld', target: comparison.id, message });
    else if (scored) accepted.set(comparison.targetId, comparison.level!);
  }

  const layers = LAYERS.map(layer => {
    const evaluable = packet.targets.filter(target => target.layer === layer && selections.get(target.id)?.primaryTier);
    const values = evaluable.flatMap(target => accepted.has(target.id) ? [accepted.get(target.id)!] : []);
    const coverage = evaluable.length ? values.length / evaluable.length : null;
    const reasons: string[] = [];
    if (!evaluable.length) reasons.push('本层没有可读取的一级至三级参照资料，不使用LLM既有知识补分。');
    if (evaluable.length && coverage !== 1) reasons.push('并非所有可评价目标都完成了有据对照。');
    if (input.assistance !== 'none') reasons.push('本次存在辅助或辅助程度未知，不写入知识掌握趋势。');
    const eligibleForMastery = evaluable.length > 0 && coverage === 1 && input.assistance === 'none';
    const pendingLayer = evaluable.some(target => pendingTargets.has(target.id));
    if (pendingLayer) reasons.push('本层包含待核验的计算对照，不展示为已确认分数。');
    return { layer, score: !pendingLayer && values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length * 25) : null,
      evaluableTargets: evaluable.length, scoredTargets: values.length, coverage,
      eligibleForMastery, status: eligibleForMastery ? 'provisional' as const : 'insufficient' as const, reasons,
      ...(pendingLayer ? { verificationPending: true } : {}) };
  });
  return { layers, warnings };
}
