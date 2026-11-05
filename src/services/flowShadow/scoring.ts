import { SHADOW_CRITERIA } from './rubric.ts';
import { arithmeticVerificationDecision } from './literalArithmetic';
import type {
  ShadowAssessment, ShadowCriterion, ShadowEvidence, ShadowGraph, ShadowInput,
  ShadowLayer, ShadowLayerScore, ShadowScoring, ShadowWarning,
} from './types.ts';

const LAYERS: ShadowLayer[] = ['concept', 'judgment', 'reasoning'];
const round = (value: number) => Math.round(value * 10) / 10;
const nonempty = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim());

/** Exact saved user text and bound nodes, never model confidence or external truth. */
export function verifiedShadowUserEvidence(input: ShadowInput, graph: ShadowGraph, assessment: ShadowAssessment): {
  evidence: Map<string, ShadowEvidence>; warnings: ShadowWarning[];
} {
  const warnings: ShadowWarning[] = [];
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const duplicateNodes = new Set(graph.nodes.filter((node, index, all) => all.findIndex(other => other.id === node.id) !== index).map(node => node.id));
  const counts = new Map<string, number>();
  for (const item of assessment.evidence) counts.set(item.id, (counts.get(item.id) || 0) + 1);
  const evidence = new Map<string, ShadowEvidence>();
  for (const item of assessment.evidence) {
    let code = '';
    if (!nonempty(item.id) || counts.get(item.id) !== 1) code = 'duplicate_evidence';
    else if (!nonempty(item.quote) || !input.rawText.includes(item.quote)) code = 'evidence_quote_unbound';
    else if (!Array.isArray(item.nodeIds) || !item.nodeIds.length || new Set(item.nodeIds).size !== item.nodeIds.length
      || item.nodeIds.some(id => !nodes.has(id) || duplicateNodes.has(id))) code = 'evidence_node_unbound';
    else if (item.attribution !== 'user') code = 'evidence_not_independent_user';
    if (code) warnings.push({ code, target: item.id, message: '此证据未通过原文、节点或用户归属绑定，不用于能力与行为观察。' });
    else evidence.set(item.id, item);
  }
  return { evidence, warnings };
}

/** The signature prevents averaging results with different applicable criteria. */
export function shadowLayerCriterionSignature(assessment: ShadowAssessment, layer: ShadowLayer): string {
  return SHADOW_CRITERIA.filter(definition => definition.layer === layer
    && assessment.criteria.some(item => item.id === definition.id && item.state !== 'not_applicable'))
    .map(definition => definition.id).join('+');
}

/** Nine bounded criteria; graph size, role warnings and issue counts never add/subtract points. */
export function scoreShadowAssessment(input: ShadowInput, graph: ShadowGraph, assessment: ShadowAssessment): ShadowScoring {
  const checked = verifiedShadowUserEvidence(input, graph, assessment);
  const arithmetic = arithmeticVerificationDecision(input, graph, assessment);
  const warnings = [...checked.warnings, ...arithmetic.warnings];
  const knownIds = new Set<string>(SHADOW_CRITERIA.map(item => item.id));
  const unknownCriterion = assessment.criteria.some(item => !knownIds.has(item.id));
  const duplicateIds = new Set(assessment.criteria.filter((item, index, all) => all.findIndex(other => other.id === item.id) !== index).map(item => item.id));
  for (const criterion of assessment.criteria) {
    if (!knownIds.has(criterion.id)) warnings.push({ code: 'unknown_criterion', target: criterion.id, message: '未知判据未参与计分。' });
  }
  const layers: ShadowLayerScore[] = LAYERS.map(layer => {
    const definitions = SHADOW_CRITERIA.filter(item => item.layer === layer);
    const verificationPending = definitions.some(definition => arithmetic.pendingCriteria.has(definition.id));
    const reasons: string[] = [];
    const values: number[] = [];
    const evidenceIds = new Set<string>();
    const opportunities = new Set<string>();
    let applicable = 0;
    let invalid = unknownCriterion;
    if (unknownCriterion) reasons.push('包含未知判据，本次结果暂不进入影子画像。');
    const withhold = (id: string, code: string, message: string) => {
      invalid = true;
      reasons.push(message);
      warnings.push({ code, target: id, message });
    };
    for (const definition of definitions) {
      if (arithmetic.pendingCriteria.has(definition.id)) {
        applicable++;
        withhold(definition.id, 'criterion_verification_pending', '该判据涉及尚未核清用途/影响的计算不一致；暂不可评，不记零分、不更新画像。');
        continue;
      }
      const criterion: ShadowCriterion | undefined = assessment.criteria.find(item => item.id === definition.id);
      if (!criterion || duplicateIds.has(definition.id)) {
        applicable++;
        withhold(definition.id, criterion ? 'duplicate_criterion' : 'missing_criterion', '判据缺失或重复，本层暂不进入影子画像。');
        continue;
      }
      if (!['observed', 'not_demonstrated', 'not_applicable', 'uncertain'].includes(criterion.state)) {
        applicable++;
        withhold(criterion.id, 'invalid_criterion_state', '判据状态不合法。');
        continue;
      }
      if (!nonempty(criterion.reason)) {
        if (criterion.state !== 'not_applicable') applicable++;
        withhold(criterion.id, 'missing_criterion_reason', '判据缺少判断说明。');
        continue;
      }
      if (criterion.state !== 'not_applicable') applicable++;
      if (criterion.state === 'not_applicable' || criterion.state === 'uncertain') {
        if (criterion.level !== null) withhold(criterion.id, 'unscored_criterion_has_level', '未知或不适用项必须保留空分。');
        if (criterion.state === 'uncertain') reasons.push('存在无法确定的判据，未将未知计为零分。');
        continue;
      }
      if (!Number.isInteger(criterion.level) || criterion.level! < 0 || criterion.level! > 4) {
        withhold(criterion.id, 'invalid_criterion_level', '有效判据需要 0–4 的整数等级。');
        continue;
      }
      if (!Array.isArray(criterion.opportunityKeys) || !criterion.opportunityKeys.length
        || criterion.opportunityKeys.some(key => !nonempty(key))) {
        withhold(criterion.id, 'missing_semantic_opportunity', '判据缺少可定位的语义机会。');
        continue;
      }
      if (!Array.isArray(criterion.evidenceIds) || !criterion.evidenceIds.length
        || criterion.evidenceIds.some(id => !checked.evidence.has(id))) {
        withhold(criterion.id, 'criterion_evidence_unbound', '判据缺少有效的用户原文证据。');
        continue;
      }
      if (criterion.state === 'not_demonstrated' && (!input.task.requiredLayers.includes(layer)
        || !nonempty(input.task.goal) || criterion.level !== 0)) {
        withhold(criterion.id, 'unrequired_missing_performance', '未展示只能用于有明确任务要求的层，并按零级记录。');
        continue;
      }
      values.push(criterion.level!);
      criterion.evidenceIds.forEach(id => evidenceIds.add(id));
      criterion.opportunityKeys.forEach(key => opportunities.add(key));
    }
    const coverage = applicable ? values.length / applicable : null;
    if (values.length < 2) reasons.push('本层可评判据不足两项，仅保留本次局部结果。');
    if (coverage !== 1) reasons.push('适用判据尚未完整覆盖。');
    if (input.assistance !== 'none') reasons.push('存在辅助或辅助程度未知，不作为独立能力样本。');
    if (!opportunities.size) reasons.push('没有可定位的语义机会。');
    const eligibleForProfile = !invalid && values.length >= 2 && coverage === 1
      && opportunities.size > 0 && input.assistance === 'none';
    return { layer, score: !verificationPending && values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length * 25) : null,
      applicable, scored: values.length, coverage, evidenceCount: evidenceIds.size, opportunityCount: opportunities.size,
      eligibleForProfile, status: eligibleForProfile ? 'provisional' : 'insufficient', reasons: [...new Set(reasons)],
      ...(verificationPending ? { verificationPending: true } : {}) };
  });
  return { layers, warnings };
}
