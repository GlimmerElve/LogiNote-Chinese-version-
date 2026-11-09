import { COGNITIVE_EVIDENCE_CONTRACT, FLOW_SHADOW_PROTOCOL, LITERAL_ARITHMETIC_CONTRACT, type ShadowBehavior, type ShadowInput, type ShadowGraph, type ShadowAssessment, type ShadowReferencePacket, type ShadowWarning } from './types.ts';
import { SHADOW_BEHAVIORS, SHADOW_CRITERIA } from './rubric.ts';
import { auditShadowCognitiveEvidence } from './cognitiveEvidence';
import { restoreShadowReferenceComparisons, reviewShadowReferenceBindings, type SharedReferenceTransport } from './referenceTransport';
import { reviewShadowBehaviorCoverage } from './assessmentCoverage';
import { restoreFlatBehaviorRows, type FlatBehaviorTransport } from './behaviorTransport';
import { checkLiteralArithmetic, parseCalculationReviews } from './literalArithmetic';

export interface ShadowAssessmentParseOptions {
  requireCognitiveAudit?: boolean; referenceTransport?: SharedReferenceTransport; reviewBehaviorCoverage?: boolean;
  behaviorTransport?: FlatBehaviorTransport; arithmeticVerification?: boolean;
}

const fail = (message: string): never => { throw new Error(`影子协议：${message}`); };
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : fail('需要 JSON 对象');
const text = (value: unknown, label: string, max = 20000, empty = false): string => typeof value === 'string'
  && value.length <= max && (empty || value.trim().length > 0) ? value : fail(`${label}为空或超长`);
const list = (value: unknown, label: string, max = 200): unknown[] => Array.isArray(value) && value.length <= max ? value : fail(`${label}数组无效`);
const strings = (value: unknown, label: string, max = 200): string[] => {
  const values = list(value, label, max).map(item => text(item, label, 200));
  if (new Set(values).size !== values.length) fail(`${label}重复`);
  return values;
};
function choice<const T extends string>(value: unknown, choices: readonly T[], label: string): T {
  return choices.includes(value as T) ? value as T : fail(`${label}值无效`);
}
function uniqueIds(items: Array<{ id: string }>, label: string) {
  if (new Set(items.map(item => item.id)).size !== items.length) fail(`${label}编号重复`);
}
function parse(raw: unknown) {
  if (typeof raw !== 'string') return object(raw);
  if (raw.length > 1000000) fail('响应超过本地安全上限');
  return object(JSON.parse(raw.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '')));
}
/** Experiment cache tag only; not an authenticity proof or semantic certificate. */
export function shadowFingerprint(value: unknown): string {
  const source = JSON.stringify(value);
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < source.length; i++) h = BigInt.asUintN(64, (h ^ BigInt(source.charCodeAt(i))) * 0x100000001b3n);
  return `shadow-${source.length}-${h.toString(16).padStart(16, '0')}`;
}
export function normalizeShadowInput(value: unknown): ShadowInput {
  const root = object(value), task = object(root.task);
  const rawText = text(root.rawText, '口语原文');
  if ([...rawText].length > 3999) fail('本试验仅支持单次3999字以内；长文本未发送、未截断，请另行设计分批');
  if (!Number.isSafeInteger(root.assessmentRevision) || Number(root.assessmentRevision) < 1) fail('评估修订号无效');
  const observedAt = text(root.observedAt, '观察时间', 80);
  if (!Number.isFinite(Date.parse(observedAt)) || !/T.*(?:Z|[+-]\d{2}:\d{2})$/u.test(observedAt)) fail('观察时间须带时区');
  const requiredLayers = strings(task.requiredLayers, '必需层', 3).map(layer => choice(layer, ['concept', 'judgment', 'reasoning'], '必需层'));
  const goal = text(task.goal, '任务目标', 2000, true);
  if (requiredLayers.length && !goal.trim()) fail('指定必需层时必须提供真实任务目标');
  return {
    attemptId: text(root.attemptId, '尝试编号', 200), assessmentRevision: Number(root.assessmentRevision), observedAt: new Date(observedAt).toISOString(),
    rawText, assistance: choice(root.assistance, ['none', 'weak', 'strong', 'unknown'], '辅助程度'),
    task: { id: text(task.id, '任务编号', 200), goal,
      family: choice(task.family, ['free_review', 'explanation', 'evaluation', 'derivation'], '任务类别'), requiredLayers,
      promptedBehaviors: strings(task.promptedBehaviors, '任务指定行为', 10).map(code => choice(code, SHADOW_BEHAVIORS.map(item => item.code), '行为')) },
  };
}
export function parseShadowGraph(value: unknown, input: ShadowInput): { graph: ShadowGraph; warnings: ShadowWarning[] } {
  const root = object(value), warnings: ShadowWarning[] = [];
  const nodes = list(root.nodes, 'nodes').map(raw => {
    const item = object(raw);
    return { id: text(item.id, '节点ID', 200), role: choice(item.role, ['claim', 'premise', 'background', 'method'], '角色'),
      text: text(item.text, '节点正文'), rawQuote: text(item.rawQuote, '原话', 20000, true) };
  });
  if (!nodes.length) fail('图中没有节点');
  uniqueIds(nodes, '节点');
  const nodeById = new Map(nodes.map(node => [node.id, node]));
  const arguments_ = list(root.arguments, 'arguments', 100).map(raw => {
    const item = object(raw), claim = text(item.claim, '主张ID', 200);
    const support = strings(item.support, 'support'), oppose = strings(item.oppose, 'oppose');
    if (![claim, ...support, ...oppose].every(id => nodeById.has(id))) fail('论证端点不存在');
    if (support.includes(claim) || oppose.includes(claim) || support.some(id => oppose.includes(id))) fail('论证自指或同一前提同时支持反对');
    return { id: text(item.id, '论证ID', 200), claim, support, oppose,
      status: choice(item.status, ['argued', 'stated_only', 'incomplete'], '论证状态') };
  });
  uniqueIds(arguments_, '论证');
  const rawRelations = list(root.relations, 'relations');
  const pendingPlacements: ShadowGraph['unresolved'] = [];
  // Repair only an explicit, already-directed support/oppose edge with an unambiguous
  // existing argument. Never infer attack, create an argument, change a role/direction,
  // or choose a winner between conflicting declarations. Caller objects stay untouched.
  const relations = rawRelations.flatMap(raw => {
    const item = object(raw);
    if (item.kind === 'support' || item.kind === 'oppose') {
      const kind = item.kind, opposite = kind === 'support' ? 'oppose' : 'support';
      const from = typeof item.from === 'string' ? item.from : '';
      const to = typeof item.to === 'string' ? item.to : '';
      const targets = arguments_.filter(a => a.claim === to);
      const target = targets.length === 1 ? targets[0] : undefined;
      const conflict = target?.[opposite].includes(from) || rawRelations.some(other =>
        other && typeof other === 'object' && !Array.isArray(other)
        && (other as Record<string, unknown>).kind === opposite
        && (other as Record<string, unknown>).from === from && (other as Record<string, unknown>).to === to);
      const problem = !from.trim() || !to.trim() || from.length > 200 || to.length > 200 ? '端点字段无效'
        : !nodeById.has(from) || !nodeById.has(to) ? '端点不存在'
        : from === to ? '关系自指'
        : nodeById.get(to)?.role !== 'claim' ? '目标不是claim'
        : !['claim', 'premise'].includes(nodeById.get(from)!.role) ? '依据角色不适用'
        : !target ? '缺少唯一对应argument'
        : conflict ? '与相反关系冲突' : undefined;
      if (problem) {
        const reason = `字段错位关系待核对：${kind} ${from}→${to}；${problem}。未纳入有效边，不自动改向、改角色或补建论证。`;
        pendingPlacements.push({ ...(nodeById.has(to) ? { nodeId: to } : {}), reason: reason.slice(0, 1000) });
        warnings.push({ code: 'graph_relation_placement_unresolved', target: typeof item.id === 'string' ? item.id : 'graph',
          message: `${reason} 原始项：${JSON.stringify(raw)}` });
      } else {
        const duplicate = target![kind].includes(from);
        if (!duplicate) target![kind].push(from);
        warnings.push({ code: 'graph_relation_placement_repaired', target: typeof item.id === 'string' ? item.id : target!.id,
          message: `仅修复字段位置：${kind} ${from}→${to} 移入${target!.id}.${kind}${duplicate ? '（去重）' : ''}；方向、角色和状态未改，不代表语义已核实。原始项：${JSON.stringify(raw)}` });
      }
      return [];
    }
    const from = text(item.from, '关系起点', 200), to = text(item.to, '关系终点', 200);
    if (!nodeById.has(from) || !nodeById.has(to) || from === to) fail('关系端点不存在或自指');
    return [{ id: text(item.id, '关系ID', 200), kind: choice(item.kind, ['context', 'method_for', 'relates'], '关系种类'),
      from, to, reason: text(item.reason, '关系理由', 600) }];
  });
  uniqueIds(relations, '关系');
  const relationKeys = relations.map(r => `${r.kind}:${r.from}:${r.to}`);
  if (new Set(relationKeys).size !== relationKeys.length) fail('同类关系重复');
  for (const node of nodes) if (!node.rawQuote.trim() || !input.rawText.includes(node.rawQuote)) {
    warnings.push({ code: 'graph_quote_unlocated', target: node.id, message: '原话未逐字匹配；节点保留，不视为用户错误或已核实引用。' });
  }
  for (const argument of arguments_) {
    if (nodeById.get(argument.claim)?.role !== 'claim'
      || [...argument.support, ...argument.oppose].some(id => !['claim', 'premise'].includes(nodeById.get(id)!.role))) {
      warnings.push({ code: 'graph_role_mismatch', target: argument.id, message: '论证角色待语义核对；不能据此扣用户分。' });
    }
    if (argument.status === 'argued' && !argument.support.length) warnings.push({ code: 'graph_status_mismatch', target: argument.id, message: '声称有支持但依据为空。' });
    if (argument.status === 'stated_only' && argument.support.length) warnings.push({ code: 'graph_status_mismatch', target: argument.id, message: '标为无支持但支持数组非空；保留模型状态，待语义核对。' });
  }
  for (const relation of relations) {
    const from = nodeById.get(relation.from)!.role, to = nodeById.get(relation.to)!.role;
    if ((relation.kind === 'context' && !['background', 'premise'].includes(from))
      || (relation.kind === 'method_for' && (!['method', 'background'].includes(from) || !['claim', 'premise'].includes(to)))) {
      warnings.push({ code: 'graph_role_mismatch', target: relation.id, message: '辅助关系与角色组合待核对；不是用户认知错误。' });
    }
    if (relation.kind === 'relates' && arguments_.some(a => [...a.support, ...a.oppose].some(id =>
      (id === relation.from && a.claim === relation.to) || (id === relation.to && a.claim === relation.from)))) {
      warnings.push({ code: 'graph_relates_argument_overlap', target: relation.id, message: '同对节点已有论证边；需核对relates是否有独立非论证含义。保留边，不自动改向或扣用户分。' });
    }
  }
  const adjacency = new Map<string, string[]>();
  for (const a of arguments_) for (const id of a.support) adjacency.set(id, [...(adjacency.get(id) || []), a.claim]);
  const done = new Set<string>(), active = new Set<string>();
  const cycle = (id: string): boolean => {
    if (active.has(id)) return true;
    if (done.has(id)) return false;
    active.add(id);
    const result = (adjacency.get(id) || []).some(cycle);
    active.delete(id); done.add(id); return result;
  };
  if (nodes.some(node => cycle(node.id))) warnings.push({ code: 'graph_support_cycle', target: 'graph', message: '支持拓扑存在环；需回读原文确认，不直接判用户循环论证。' });
  const unresolved = list(root.unresolved, 'unresolved', 100).map(raw => {
    const item = object(raw);
    if (item.nodeId !== undefined && !nodeById.has(String(item.nodeId))) fail('待核对节点不存在');
    return { ...(item.nodeId === undefined ? {} : { nodeId: String(item.nodeId) }), reason: text(item.reason, '待核对说明', 1000) };
  });
  // Keep the existing saved-graph limit; every quarantined item is still fully
  // retained in warnings even if there is no room for another display entry.
  for (const pending of pendingPlacements) {
    if (unresolved.length >= 100) break;
    if (!unresolved.some(item => item.nodeId === pending.nodeId && item.reason === pending.reason)) unresolved.push(pending);
  }
  return { graph: { nodes, arguments: arguments_, relations, unresolved }, warnings };
}
export function parseShadowExtraction(raw: unknown, input: ShadowInput) {
  const root = parse(raw);
  if (root.protocol !== FLOW_SHADOW_PROTOCOL || root.inputKey !== shadowFingerprint(input)) fail('初抽响应与本次输入不一致');
  return parseShadowGraph(root.graph, input);
}
export function parseShadowAssessment(raw: unknown, input: ShadowInput, graph: ShadowGraph, references: ShadowReferencePacket,
  options: ShadowAssessmentParseOptions = {}): { assessment: ShadowAssessment; warnings: ShadowWarning[] } {
  const root = parse(raw);
  if (root.protocol !== FLOW_SHADOW_PROTOCOL || root.inputKey !== shadowFingerprint(input) || root.graphKey !== shadowFingerprint(graph)
    || root.referenceKey !== shadowFingerprint(references)) fail('评估响应与输入/图/参考资料版本不一致');
  const body = object(root.assessment), warnings: ShadowWarning[] = [];
  const evidence = list(body.evidence, 'evidence', 100).map(rawEvidence => {
    const item = object(rawEvidence);
    return { id: text(item.id, '证据ID', 200), quote: text(item.quote, '证据原话', 5000), nodeIds: strings(item.nodeIds, '证据节点'),
      attribution: choice(item.attribution, ['user', 'quoted', 'assisted', 'uncertain'], '证据归属') };
  });
  uniqueIds(evidence, '证据');
  const criteria = list(body.criteria, 'criteria', 9).map(rawCriterion => {
    const item = object(rawCriterion);
    const level = item.level;
    if (level !== null && (!Number.isInteger(level) || Number(level) < 0 || Number(level) > 4)) fail('指标等级必须为0～4或null');
    const criterion = { id: choice(item.id, SHADOW_CRITERIA.map(c => c.id), '指标'),
      state: choice(item.state, ['observed', 'not_demonstrated', 'not_applicable', 'uncertain'], '指标状态'),
      level: level === null ? null : Number(level), evidenceIds: strings(item.evidenceIds, '指标证据', 20),
      opportunityKeys: [] as string[], reason: text(item.reason, '指标依据', 1000) };
    try {
      criterion.opportunityKeys = strings(item.opportunityKeys, '语义机会', 30);
    } catch {
      // This field locates the semantic opportunity behind ONE criterion. Do
      // not fabricate it from a label/node count, or keep an unsupported level.
      // Other valid evidence and the saved graph remain independently usable.
      criterion.state = 'uncertain';
      criterion.level = null;
      warnings.push({ code: 'criterion_opportunity_invalid', target: criterion.id,
        message: '语义机会字段缺失或无效，该指标已暂记不确定，不计分、不更新画像；其他有效结果保留。' });
    }
    return criterion;
  });
  uniqueIds(criteria, '指标');
  for (const definition of SHADOW_CRITERIA) if (!criteria.some(c => c.id === definition.id)) {
    criteria.push({ id: definition.id, state: 'uncertain', level: null, evidenceIds: [], opportunityKeys: [], reason: '模型未返回该项；不默认为零分。' });
    warnings.push({ code: 'criterion_missing', target: definition.id, message: '缺失指标已标不确定，不能静默缩小评分分母。' });
  }
  const referenceComparisons = list(body.referenceComparisons, 'referenceComparisons', 100).map(rawComparison => {
    const item = object(rawComparison), level = item.level;
    if (level !== null && (!Number.isInteger(level) || Number(level) < 0 || Number(level) > 4)) fail('资料对照等级必须为0～4或null');
    return { id: text(item.id, '资料对照ID', 200), targetId: text(item.targetId, '资料目标ID', 200),
      layer: choice(item.layer, ['concept', 'judgment', 'reasoning'], '资料对照层'),
      state: choice(item.state, ['aligned', 'partially_aligned', 'misaligned', 'conflicted', 'insufficient_reference', 'not_applicable'], '资料对照状态'),
      level: level === null ? null : Number(level), userEvidenceIds: strings(item.userEvidenceIds, '资料对照用户证据', 30),
      referenceIds: strings(item.referenceIds, '资料对照参考证据', 30), reason: text(item.reason, '资料对照理由', 1000) };
  });
  uniqueIds(referenceComparisons, '资料对照');
  const rawBehaviors = [...list(options.behaviorTransport ? body.behaviors ?? [] : body.behaviors, 'behaviors', 10)];
  if (options.behaviorTransport && body.cognitiveObservations !== undefined) {
    if (Array.isArray(body.cognitiveObservations) && body.cognitiveObservations.length <= 10) {
      for (const row of body.cognitiveObservations) {
        if (row && typeof row === 'object' && SHADOW_BEHAVIORS.some(b => b.dimension === 'strategy' && b.code === row.code)) rawBehaviors.push(row);
        else warnings.push({ code: 'cognitive_transport_invalid', target: 'cognitiveObservations', message: '认知数组中有未知或非认知code，仅忽略该项，不影响其他观察和图。' });
      }
    }
    else warnings.push({ code: 'cognitive_transport_invalid', target: 'cognitiveObservations', message: '认知观察数组无效，仅保留未知，不阻断图。' });
  }
  if (options.reviewBehaviorCoverage) warnings.push(...reviewShadowBehaviorCoverage(rawBehaviors.filter(b => b && typeof b === 'object') as ShadowBehavior[]));
  const restoredBehaviors = options.behaviorTransport ? restoreFlatBehaviorRows(rawBehaviors) : { rows: rawBehaviors, warnings: [] };
  warnings.push(...restoredBehaviors.warnings);
  const behaviors = restoredBehaviors.rows.map(rawBehavior => {
    const item = object(rawBehavior);
    const rawDirection = item.direction;
    let direction = rawDirection === undefined || rawDirection === null ? null : Number(rawDirection);
    if (direction !== null && ![-2, -1, 0, 1, 2].includes(direction)) {
      direction = null;
      warnings.push({ code: 'cognitive_direction_invalid', target: String(item.code), message: '认知方向值无效，仅暂缓该方向，不阻断其他评价。' });
    }
    let polarity: ShadowBehavior['polarity'];
    let invalidPolarity = false;
    if (item.polarity !== undefined) {
      try {
        const p = object(item.polarity);
        polarity = { negative: strings(p.negative, '负极证据', 20), positive: strings(p.positive, '正极证据', 20),
          resolution: choice(p.resolution, ['single_pole', 'resolved', 'balanced', 'mixed', 'insufficient'], '两极判定状态') };
      } catch {
        invalidPolarity = true;
        warnings.push({ code: 'cognitive_audit_invalid', target: String(item.code), message: '两极核对字段无效，仅暂缓该方向，不阻断其他结果。' });
      }
    }
    return { code: choice(item.code, SHADOW_BEHAVIORS.map(b => b.code), '观察行为'),
      state: choice(item.state, ['observed', 'not_observed', 'uncertain'], '行为状态'),
      direction: (invalidPolarity ? null : direction) as -2 | -1 | 0 | 1 | 2 | null,
      ...(polarity ? { polarity } : {}),
      evidenceIds: strings(item.evidenceIds, '行为证据', 20), reason: text(item.reason, '行为依据', 1000) };
  });
  if (new Set(behaviors.map(b => b.code)).size !== behaviors.length) fail('行为重复');
  if (options.referenceTransport) warnings.push(...reviewShadowReferenceBindings(referenceComparisons, references));
  const allTargets = new Set([...graph.nodes, ...graph.arguments, ...graph.relations].map(target => target.id));
  const issues = list(body.issues, 'issues', 100).map(rawIssue => {
    const item = object(rawIssue);
    const targetIds = strings(item.targetIds, '问题目标', 30);
    if (targetIds.some(id => !allTargets.has(id))) warnings.push({ code: 'issue_target_unlocated', target: String(item.id), message: '问题未绑定已有图元素，仅保留待核对。' });
    return { id: text(item.id, '问题ID', 200), kind: choice(item.kind, ['extraction', 'argument_gap', 'confirmed_internal', 'external_unverified', 'asr_uncertain'], '问题类型'),
      targetIds, evidenceIds: strings(item.evidenceIds, '问题证据', 20),
      severity: choice(item.severity, ['low', 'medium', 'high'], '影响程度'), reason: text(item.reason, '问题依据', 1000) };
  });
  uniqueIds(issues, '问题');
  // A missing/malformed optional display metric must not hold an otherwise usable assessment.
  let clarity: ShadowAssessment['clarity'];
  if (body.clarity !== undefined) {
    try {
      const item = object(body.clarity);
      if (item.score !== null && (typeof item.score !== 'number' || !Number.isFinite(item.score) || item.score < 0 || item.score > 100)) fail('文本清晰度应为0～100或null');
      const evidenceIds = strings(item.evidenceIds, '清晰度证据', 20);
      const comment = text(item.comment, '清晰度说明', 600);
      const nodeIds = new Set(graph.nodes.map(node => node.id));
      const bound = evidenceIds.length > 0 && evidenceIds.every(id => {
        const entry = evidence.find(candidate => candidate.id === id);
        return entry && entry.attribution === 'user' && input.rawText.includes(entry.quote)
          && entry.nodeIds.length > 0 && entry.nodeIds.every(nodeId => nodeIds.has(nodeId));
      });
      clarity = { score: item.score === null || !bound ? null : Number(item.score), comment, evidenceIds };
      if (item.score !== null && !bound) warnings.push({ code: 'clarity_evidence_unbound', target: 'clarity', message: '清晰度没有有效用户原话依据，保留说明但不展示分数。' });
    } catch {
      warnings.push({ code: 'clarity_invalid', target: 'clarity', message: '清晰度字段无效，跳过该项，不阻断论证图与其他评价。' });
    }
  }
  const calculationReviews = options.arithmeticVerification ? parseCalculationReviews(body.calculationReviews) : undefined;
  if (calculationReviews) warnings.push(...calculationReviews.warnings);
  const audited = auditShadowCognitiveEvidence(input, graph, {
    evidence, criteria, referenceComparisons: options.referenceTransport === 'shared-sources-v1'
      ? restoreShadowReferenceComparisons(referenceComparisons, references) : referenceComparisons,
    behaviors, issues, ...(clarity ? { clarity } : {}),
    ...(body.behaviorContract === COGNITIVE_EVIDENCE_CONTRACT ? { behaviorContract: COGNITIVE_EVIDENCE_CONTRACT } : {}),
    ...(calculationReviews ? { localVerification: { contract: LITERAL_ARITHMETIC_CONTRACT,
      arithmeticChecks: checkLiteralArithmetic(input.rawText), calculationReviews: calculationReviews.reviews } } : {}),
    summary: text(body.summary, '本次总结', 2000, true), recommendation: text(body.recommendation, '建议', 2000, true),
  }, options.requireCognitiveAudit);
  return { assessment: audited.assessment, warnings: [...warnings, ...audited.warnings] };
}
