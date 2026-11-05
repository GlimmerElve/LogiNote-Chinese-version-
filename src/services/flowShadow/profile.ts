import { SHADOW_BEHAVIORS, SHADOW_LAYER_LABELS } from './rubric.ts';
import { SHADOW_COGNITIVE_AXES, SHADOW_EXPRESSION_STYLES, SHADOW_EXPRESSION_STYLE_LABELS,
  SHADOW_EXPRESSION_WEIGHTS, cognitiveDirectionLabel } from './profileAlignment.ts';
import { scoreShadowAssessment, shadowLayerCriterionSignature, verifiedShadowUserEvidence } from './scoring.ts';
import { scoreShadowReferenceAssessment } from './referenceScoring.ts';
import { auditShadowCognitiveEvidence } from './cognitiveEvidence';
import { normalizeShadowInput, parseShadowGraph } from './protocol.ts';
import { FLOW_SHADOW_PROTOCOL, FLOW_SHADOW_RUBRIC, SHADOW_WRITES } from './types.ts';
import type { ShadowBehaviorCode, ShadowProfileMetric, ShadowProfilePreview, ShadowRecord } from './types.ts';

/** Deliberately local: this module never imports profile/DSR stores, transports or files. */
const shanghaiDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
const round = (value: number) => Math.round(value * 10) / 10;
const PROFILE_DYNAMICS: Record<ShadowProfileMetric['dimension'], { currentAlpha: number; baselineAlpha: number }> = {
  ability: { currentAlpha: .35, baselineAlpha: .15 },
  knowledge: { currentAlpha: .4, baselineAlpha: .15 },
  cognitive_style: { currentAlpha: .2, baselineAlpha: .08 },
  expression_style: { currentAlpha: .25, baselineAlpha: .1 },
};
function ema(values: readonly number[], alpha: number): number | null {
  if (!values.length) return null;
  return values.slice(1).reduce((state, value) => value * alpha + state * (1 - alpha), values[0]);
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}
function localDay(value: string): string | null {
  const time = new Date(value);
  return Number.isFinite(time.getTime()) ? shanghaiDay.format(time) : null;
}
function identity(record: ShadowRecord): string {
  return stable({ rubric: record.rubricVersion, rawText: record.input.rawText, task: record.input.task,
    assistance: record.input.assistance, observedAt: record.input.observedAt });
}
function revisionPayload(record: ShadowRecord): string {
  // Cached scoring, transport warnings and usage receipts are not semantic authority.
  return stable({ graph: record.graph, references: record.references, assessment: record.assessment });
}

function recordShape(record: ShadowRecord, warnings: Set<string>): ShadowRecord {
  const input = normalizeShadowInput(record.input);
  const parsed = parseShadowGraph(record.graph, input);
  parsed.warnings.forEach(warning => warnings.add(`${input.attemptId}：${warning.code} (${warning.target})`));
  const body = record.assessment;
  const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
  if (!body || !Array.isArray(body.evidence) || !Array.isArray(body.criteria) || !Array.isArray(body.behaviors)
    || !Array.isArray(body.referenceComparisons) || !Array.isArray(body.issues) || typeof body.summary !== 'string' || typeof body.recommendation !== 'string'
    || body.evidence.some(item => !item || typeof item.id !== 'string' || typeof item.quote !== 'string'
      || typeof item.attribution !== 'string' || !strings(item.nodeIds))
    || body.criteria.some(item => !item || typeof item.id !== 'string' || typeof item.state !== 'string'
      || typeof item.reason !== 'string' || !strings(item.evidenceIds) || !strings(item.opportunityKeys))
    || body.referenceComparisons.some(item => !item || typeof item.id !== 'string' || typeof item.targetId !== 'string'
      || typeof item.layer !== 'string' || typeof item.state !== 'string' || typeof item.reason !== 'string'
      || !strings(item.userEvidenceIds) || !strings(item.referenceIds))
    || body.issues.some(item => !item || typeof item.id !== 'string' || typeof item.kind !== 'string'
      || typeof item.reason !== 'string' || !strings(item.evidenceIds) || !strings(item.targetIds))) throw new Error('invalid_shadow_assessment_shape');
  if (!record.references || !Array.isArray(record.references.targets) || !Array.isArray(record.references.items)
    || !Array.isArray(record.references.selection) || !Array.isArray(record.references.gaps)) throw new Error('invalid_shadow_reference_shape');
  const behaviors = body.behaviors.filter(item => {
    const validDirection = item?.direction === undefined || item?.direction === null
      || [-2, -1, 0, 1, 2].includes(item.direction);
    const valid = item && SHADOW_BEHAVIORS.some(definition => definition.code === item.code)
      && ['observed', 'not_observed', 'uncertain'].includes(item.state)
      && strings(item.evidenceIds) && typeof item.reason === 'string' && Boolean(item.reason.trim()) && validDirection;
    if (!valid) warnings.add(`${input.attemptId}：未知或无效行为观察已忽略。`);
    return valid;
  });
  const audited = auditShadowCognitiveEvidence(input, parsed.graph, { ...body, behaviors });
  audited.warnings.forEach(warning => warnings.add(`${input.attemptId}：${warning.code} (${warning.target})`));
  return { ...record, input, graph: parsed.graph, assessment: audited.assessment };
}

/** One current revision per immutable attempt. Conflicts hold the ENTIRE attempt, independent of order. */
function currentAttempts(records: readonly ShadowRecord[], warnings: Set<string>): ShadowRecord[] {
  const grouped = new Map<string, ShadowRecord[]>();
  for (const record of records) {
    if (typeof record?.input?.attemptId !== 'string' || !record.input.attemptId.trim()) { warnings.add('记录缺少尝试身份，未聚合。'); continue; }
    const group = grouped.get(record.input.attemptId) || [];
    group.push(record); grouped.set(record.input.attemptId, group);
  }
  const current: ShadowRecord[] = [];
  for (const [attemptId, rawGroup] of [...grouped].sort(([a], [b]) => a.localeCompare(b))) {
    let group: ShadowRecord[];
    try { group = rawGroup.map(record => recordShape(record, warnings)); }
    catch { warnings.add(`${attemptId}：记录字段或图格式无效，整次尝试暂缓，其他有效记录保留。`); continue; }
    if (group.some(record => record.protocol !== FLOW_SHADOW_PROTOCOL || record.mode !== 'shadow'
      || record.semanticCertification !== 'not_certified'
      || stable(record.writes) !== stable(SHADOW_WRITES)
      || !Number.isSafeInteger(record.input.assessmentRevision) || record.input.assessmentRevision < 1
      || !localDay(record.input.observedAt))) {
      warnings.add(`${attemptId}：记录身份、版本或隔离声明无效，整次尝试暂缓。`); continue;
    }
    if (new Set(group.map(record => record.rubricVersion)).size !== 1
      || group.some(record => record.rubricVersion !== FLOW_SHADOW_RUBRIC)) {
      warnings.add(`${attemptId}：量规版本冲突或不受支持，整次尝试暂缓，未混算。`); continue;
    }
    if (new Set(group.map(identity)).size !== 1) {
      warnings.add(`${attemptId}：同次尝试的原文、任务、辅助或发生时间不一致，整次暂缓。`); continue;
    }
    const byRevision = new Map<number, string>();
    let conflict = false;
    for (const record of rawGroup) {
      const payload = revisionPayload(record), prior = byRevision.get(record.input.assessmentRevision);
      if (prior !== undefined && prior !== payload) conflict = true;
      byRevision.set(record.input.assessmentRevision, payload);
    }
    if (conflict) { warnings.add(`${attemptId}：相同评估修订包含不同结果，整次暂缓。`); continue; }
    const latest = Math.max(...byRevision.keys());
    current.push(group.find(record => record.input.assessmentRevision === latest)!);
  }
  return current;
}

interface Group {
  metric: ShadowProfileMetric;
  samples: Array<{ record: ShadowRecord; value: number }>;
}

export function buildShadowProfilePreview(records: readonly ShadowRecord[]): ShadowProfilePreview {
  const warnings = new Set<string>();
  const current = currentAttempts(records, warnings);
  const groups = new Map<string, Group>();
  const errors: ShadowProfilePreview['errors'] = { confirmed: 0, gaps: 0, extraction: 0, unverified: 0, unclear: 0, evaluatedAttempts: current.length };
  const add = (key: string, dimension: ShadowProfileMetric['dimension'], label: string, record: ShadowRecord,
    value: number | null, reasons: string[] = [], scale: ShadowProfileMetric['scale'] = 'score_0_100',
    poles?: ShadowProfileMetric['poles']) => {
    let group = groups.get(key);
    if (!group) {
      const aggregation = PROFILE_DYNAMICS[dimension];
      group = { metric: { key, dimension, label, value: null, state: 'insufficient', sampleCount: 0, days: 0,
        taskCount: 0, sampleAttemptIds: [], reasons: [], scale, poles, historicalMean: null, baselineValue: null,
        trendDelta: null, aggregation, observations: [] }, samples: [] };
      groups.set(key, group);
    }
    group.metric.reasons.push(...reasons);
    if (value === null) return;
    if (!group.samples.some(item => item.record.input.attemptId === record.input.attemptId)) {
      group.samples.push({ record, value });
    }
  };
  for (const record of current) {
    const prefix = `${record.rubricVersion}:${record.input.task.family}`;
    const scoring = scoreShadowAssessment(record.input, record.graph, record.assessment);
    for (const warning of scoring.warnings) warnings.add(`${record.input.attemptId}：${warning.code} (${warning.target})`);
    for (const layer of scoring.layers) {
      const signature = shadowLayerCriterionSignature(record.assessment, layer.layer);
      add(`${prefix}:ability:${layer.layer}:${signature}`, 'ability', `${SHADOW_LAYER_LABELS[layer.layer]}能力`, record,
        layer.eligibleForProfile ? layer.score : null, layer.reasons);
    }
    const referenceScoring = scoreShadowReferenceAssessment(record.input, record.graph, record.references, record.assessment);
    for (const warning of referenceScoring.warnings) warnings.add(`${record.input.attemptId}：${warning.code} (${warning.target})`);
    for (const layer of referenceScoring.layers) {
      const scope = stable(record.references.selection.filter(item => record.references.targets
        .some(target => target.id === item.targetId && target.layer === layer.layer))
        .map(item => ({ targetId: item.targetId, primaryTier: item.primaryTier,
          sources: item.itemIds.map(id => record.references.items.find(source => source.id === id)?.sourceId || id) })));
      add(`${prefix}:knowledge:${layer.layer}:${scope}`, 'knowledge', `${SHADOW_LAYER_LABELS[layer.layer]}资料一致性`, record,
        layer.eligibleForMastery ? layer.score : null, layer.reasons);
    }
    const checked = verifiedShadowUserEvidence(record.input, record.graph, record.assessment);
    const usableBehaviors = new Map<ShadowBehaviorCode, ShadowRecord['assessment']['behaviors'][number]>();
    for (const definition of SHADOW_BEHAVIORS) {
      const observations = record.assessment.behaviors.filter(item => item.code === definition.code);
      const usable = record.input.assistance === 'none' && !record.input.task.promptedBehaviors.includes(definition.code)
        && observations.length === 1 && observations[0].state === 'observed'
        && observations[0].evidenceIds.length > 0 && observations[0].evidenceIds.every(id => checked.evidence.has(id));
      if (usable) usableBehaviors.set(definition.code, observations[0]);
    }
    for (const axis of SHADOW_COGNITIVE_AXES) {
      add(`${prefix}:cognitive_style:${axis.key}`, 'cognitive_style', axis.label, record, null,
        [], 'bipolar_-100_100', { negative: axis.negative, positive: axis.positive });
      const behavior = usableBehaviors.get(axis.behavior);
      if (!behavior) continue;
      if (behavior.direction == null) {
        warnings.add(`${record.input.attemptId}：${axis.label}缺少双极方向，只保留本次行为证据，未聚合画像。`);
        continue;
      }
      const value = behavior.direction * 50;
      add(`${prefix}:cognitive_style:${axis.key}`, 'cognitive_style', axis.label, record, value,
        [`证据锚点：${SHADOW_BEHAVIORS.find(item => item.code === axis.behavior)?.label || axis.behavior}（${cognitiveDirectionLabel(axis, behavior.direction)}）。`],
        'bipolar_-100_100', { negative: axis.negative, positive: axis.positive });
    }
    const expressionCodes = [...usableBehaviors.keys()].filter(code => SHADOW_BEHAVIORS
      .some(definition => definition.code === code && definition.dimension === 'expression'));
    for (const style of SHADOW_EXPRESSION_STYLES) add(`${prefix}:expression_style:${style}`, 'expression_style',
      SHADOW_EXPRESSION_STYLE_LABELS[style], record, null, [], 'relative_0_100');
    if (expressionCodes.length) {
      const raw = Object.fromEntries(SHADOW_EXPRESSION_STYLES.map(style => [style,
        expressionCodes.reduce((sum, code) => sum + (SHADOW_EXPRESSION_WEIGHTS[code][style] || 0), 0)])) as Record<(typeof SHADOW_EXPRESSION_STYLES)[number], number>;
      const total = Object.values(raw).reduce((sum, value) => sum + value, 0);
      if (total > 0) for (const style of SHADOW_EXPRESSION_STYLES) {
        add(`${prefix}:expression_style:${style}`, 'expression_style', SHADOW_EXPRESSION_STYLE_LABELS[style], record,
          round(raw[style] / total * 100),
          [`本次依据：${expressionCodes.map(code => SHADOW_BEHAVIORS.find(item => item.code === code)?.label || code).join('、')}。`],
          'relative_0_100');
      }
    }
    const targetIds = new Set([...record.graph.nodes, ...record.graph.arguments, ...record.graph.relations].map(item => item.id));
    const seenIds = new Set<string>(), seenRoots = new Set<string>();
    for (const issue of record.assessment.issues) {
      if (!issue.id?.trim() || !issue.reason?.trim() || !issue.targetIds.length || issue.targetIds.some(id => !targetIds.has(id))) {
        warnings.add(`${record.input.attemptId}：问题缺少有效目标，未纳入统计。`); continue;
      }
      const evidence = issue.evidenceIds.map(id => checked.evidence.get(id));
      if (issue.kind !== 'extraction' && (!evidence.length || evidence.some(item => !item))) {
        warnings.add(`${record.input.attemptId}：问题 ${issue.id} 缺少用户原文证据，未纳入统计。`); continue;
      }
      // IDs and source-grounded roots both deduplicate repeated/split presentations.
      const root = stable({ kind: issue.kind, reason: issue.reason.replace(/\s+/gu, ' ').trim(),
        quotes: [...new Set(evidence.flatMap(item => item ? [item.quote] : []))].sort() });
      if (seenIds.has(issue.id) || seenRoots.has(root)) continue;
      seenIds.add(issue.id); seenRoots.add(root);
      if (issue.kind === 'confirmed_internal') errors.confirmed++;
      else if (issue.kind === 'argument_gap') errors.gaps++;
      else if (issue.kind === 'extraction') errors.extraction++;
      else if (issue.kind === 'external_unverified') errors.unverified++;
      else if (issue.kind === 'asr_uncertain') errors.unclear++;
    }
  }
  for (const group of groups.values()) {
    const { metric } = group;
    const samples = [...group.samples].sort((a, b) => new Date(a.record.input.observedAt).getTime() - new Date(b.record.input.observedAt).getTime()
      || a.record.input.attemptId.localeCompare(b.record.input.attemptId));
    const values = samples.map(item => item.value);
    metric.observations = samples.map(item => ({ attemptId: item.record.input.attemptId,
      observedAt: item.record.input.observedAt, taskId: item.record.input.task.id, value: item.value }));
    metric.sampleCount = samples.length;
    metric.sampleAttemptIds = samples.map(item => item.record.input.attemptId);
    metric.days = new Set(samples.map(item => localDay(item.record.input.observedAt))).size;
    metric.taskCount = new Set(samples.map(item => item.record.input.task.id)).size;
    const sufficient = metric.sampleCount >= 3 && metric.days >= 2 && metric.taskCount >= 2;
    metric.state = sufficient ? 'provisional' : 'insufficient';
    if (sufficient && values.length) {
      const historicalMean = values.reduce((sum, value) => sum + value, 0) / values.length;
      const current = ema(values, metric.aggregation.currentAlpha)!;
      const baseline = ema(values, metric.aggregation.baselineAlpha)!;
      metric.value = round(current);
      metric.historicalMean = round(historicalMean);
      metric.baselineValue = round(baseline);
      metric.trendDelta = round(current - baseline);
    }
    if (!sufficient) metric.reasons.push('至少需要 3 次独立尝试，覆盖 2 个上海自然日和 2 个任务。');
    if (metric.sampleCount === 0 && metric.dimension === 'cognitive_style') metric.reasons.push('尚无可用于该双极方向的独立原话锚点。');
    if (metric.sampleCount === 0 && metric.dimension === 'expression_style') metric.reasons.push('尚无可用于该表达风格的独立行为锚点。');
    if (metric.dimension === 'expression_style') metric.reasons.push('当前值提高近期观察权重；仅表示已观察表达行为之间的相对构成，不是人格标签。');
    if (metric.dimension === 'cognitive_style') metric.reasons.push('当前值提高近期方向证据权重；缺少方向或观察机会时保持未知。');
    if (sufficient) metric.reasons.push(`当前值按 α=${metric.aggregation.currentAlpha} 递减加权；慢速基线按 α=${metric.aggregation.baselineAlpha} 更新，历史均值仅供回顾。`);
    metric.reasons = [...new Set(metric.reasons)];
  }
  return { mode: 'shadow', writes: SHADOW_WRITES, rubricVersion: FLOW_SHADOW_RUBRIC,
    metrics: [...groups.values()].map(group => group.metric).sort((a, b) => a.key.localeCompare(b.key)),
    warnings: [...warnings].sort(), attempts: current.length, errors };
}
