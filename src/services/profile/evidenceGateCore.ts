import type {
  CognitiveStyle,
  ProfileEvidenceAggregate,
  ProfileEvidenceGateState,
  UserProfile,
} from '../../types';
import type { ProfileSignal } from '../memory/types';
import { evaluateProfileSignal } from '../memory/interactionMemoryPolicy.ts';

export interface GateDecision {
  dimension: ProfileSignal['dimension'];
  indicator: string;
  action: 'reject' | 'hold' | 'aggregate' | 'route';
  reason: string;
}

export interface GateInput {
  episodeId: string;
  signals: ProfileSignal[];
  sampleChars: number;
}

export interface GateResult {
  profile: UserProfile;
  decisions: GateDecision[];
  duplicate: boolean;
}

const ABILITY_KEYS = new Set(['conceptClarity', 'judgmentReasonableness', 'reasoningValidity']);
const COGNITIVE_KEYS = new Set<keyof CognitiveStyle>([
  'abstractVsConcrete',
  'systematicVsScattered',
  'divergentVsConvergent',
  'cautiousVsDogmatic',
  'deepVsSurface',
]);

export function emptyEvidenceGateState(): ProfileEvidenceGateState {
  return { version: 1, processedEpisodeIds: [], aggregates: {} };
}

function initialEvidenceGateState(profile: UserProfile): ProfileEvidenceGateState {
  const state = emptyEvidenceGateState();
  if (profile.ability.evidenceCount < 2 || profile.ability.evidenceChars < 300) return state;
  const observedAt = profile.updatedAt;
  const legacy = (dimension: ProfileEvidenceAggregate['dimension'], indicator: string, value: number): ProfileEvidenceAggregate => ({
    dimension,
    indicator,
    status: 'trusted',
    mean: value,
    confidence: 0.6,
    samples: [{ episodeId: 'legacy-profile', value, weight: 0.6, observedAt }],
    updatedAt: observedAt,
  });
  for (const indicator of ABILITY_KEYS) {
    const key = indicator as keyof Pick<UserProfile['ability'], 'conceptClarity' | 'judgmentReasonableness' | 'reasoningValidity'>;
    state.aggregates[`ability:${indicator}`] = legacy('ability', indicator, profile.ability[key]);
  }
  for (const indicator of COGNITIVE_KEYS) {
    state.aggregates[`cognitive_style:${indicator}`] = legacy('cognitive_style', indicator, profile.cognitiveStyle[indicator]);
  }
  return state;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function blend(current: number, target: number, alpha: number, maxStep: number): number {
  return round1(current + clamp((target - current) * alpha, -maxStep, maxStep));
}

function isInRange(signal: ProfileSignal): signal is ProfileSignal & { value: number } {
  if (typeof signal.value !== 'number' || !Number.isFinite(signal.value)) return false;
  if (signal.dimension === 'cognitive_style') return signal.value >= -100 && signal.value <= 100;
  return signal.value >= 0 && signal.value <= 100;
}

function aggregateKey(signal: ProfileSignal): string {
  return `${signal.dimension}:${signal.indicator}${isVersionedEvidenceRubric(signal.rubricVersion) ? `:${signal.rubricVersion}` : ''}`;
}

function isVersionedEvidenceRubric(version?: string): boolean {
  return isFlowRubric(version) || version === 'review-criteria-v2';
}

export const isFlowRubric = (version?: string): boolean => /^flow-evidence-rubric-v\d+-/u.test(version || '');

const CURRENT_ALPHA: Record<ProfileEvidenceAggregate['dimension'], number> = {
  ability: .35, cognitive_style: .2, expression_style: .25,
};

function emaSamples(samples: ProfileEvidenceAggregate['samples'], alpha: number): number {
  if (!samples.length) return 0;
  return samples.slice(1).reduce((state, sample) => {
    const effectiveAlpha = clamp(alpha * sample.weight, .05, alpha);
    return state + (sample.value - state) * effectiveAlpha;
  }, samples[0].value);
}

function updateAggregate(
  current: ProfileEvidenceAggregate | undefined,
  signal: ProfileSignal & { value: number },
  episodeId: string,
): ProfileEvidenceAggregate {
  const weight = clamp(signal.confidence, 0, 1) * (signal.evidenceType === 'explicit' ? 1 : signal.evidenceType === 'scored' ? 0.9 : 0.75);
  const samples = [
    ...(current?.samples || []).filter((sample) => sample.episodeId !== episodeId),
    {
      episodeId,
      value: signal.value,
      weight,
      observedAt: signal.observedAt,
      evidenceSnippetIds: signal.evidenceSnippetIds,
      matchedCriteria: signal.matchedCriteria,
      rubricVersion: signal.rubricVersion,
    },
  ].sort((a, b) => new Date(a.observedAt).getTime() - new Date(b.observedAt).getTime()
    || a.episodeId.localeCompare(b.episodeId)).slice(-12);
  const totalWeight = samples.reduce((sum, sample) => sum + sample.weight, 0);
  const historicalMean = totalWeight > 0
    ? samples.reduce((sum, sample) => sum + sample.value * sample.weight, 0) / totalWeight
    : signal.value;
  const alpha = CURRENT_ALPHA[signal.dimension as ProfileEvidenceAggregate['dimension']];
  const mean = emaSamples(samples, alpha);
  const baselineMean = emaSamples(samples, Math.max(.05, alpha * .4));
  const confidence = totalWeight > 0
    ? samples.reduce((sum, sample) => sum + sample.weight * sample.weight, 0) / totalWeight
    : 0;
  return {
    dimension: signal.dimension as ProfileEvidenceAggregate['dimension'],
    indicator: signal.indicator,
    ...(isVersionedEvidenceRubric(signal.rubricVersion) ? { rubricVersion: signal.rubricVersion } : {}),
    status: current?.status || 'holding',
    mean: round1(mean),
    historicalMean: round1(historicalMean),
    baselineMean: round1(baselineMean),
    trendDelta: round1(mean - baselineMean),
    confidence: round1(confidence),
    samples,
    updatedAt: signal.observedAt,
  };
}

function canTrust(aggregate: ProfileEvidenceAggregate, explicit: boolean): boolean {
  const values = aggregate.samples.map((sample) => sample.value);
  const days = new Set(aggregate.samples.map((sample) => sample.observedAt.slice(0, 10))).size;
  const spread = Math.max(...values) - Math.min(...values);
  // 明确自述是高质量候选证据，但不能成为“直接修改画像”的后门；至少跨两天重复出现。
  if (explicit) return values.length >= 2 && days >= 2 && spread <= (aggregate.dimension === 'cognitive_style' ? 60 : 25);
  // Comparable ability observations may genuinely improve/decline. Bound the update,
  // not the observed range; old rubrics retain their original admission policy.
  if (aggregate.dimension === 'ability') return values.length >= 2 && (isVersionedEvidenceRubric(aggregate.rubricVersion) || spread <= 35);
  if (aggregate.dimension === 'cognitive_style') {
    const nonNeutral = values.filter((value) => Math.abs(value) >= 10);
    const positive = nonNeutral.filter((value) => value > 0).length;
    const directionalConsistency = nonNeutral.length === 0 || Math.max(positive, nonNeutral.length - positive) / nonNeutral.length >= 0.67;
    return values.length >= 3 && days >= 2 && spread <= 80 && directionalConsistency;
  }
  return values.length >= 3 && days >= 2 && spread <= 35;
}

/** Pure, idempotent partition of previously mixed evidence. No sample/score is invented or discarded. */
export function partitionFlowProfileEvidence(profile: UserProfile): UserProfile {
  if (!profile.evidenceGate) return profile;
  const aggregates: ProfileEvidenceGateState['aggregates'] = {};
  for (const [key, aggregate] of Object.entries(profile.evidenceGate.aggregates)) {
    const flow = aggregate.samples.filter(sample => isVersionedEvidenceRubric(sample.rubricVersion));
    if (!flow.length || aggregate.rubricVersion && flow.every(s => s.rubricVersion === aggregate.rubricVersion)) {
      aggregates[key] = aggregate; continue;
    }
    const legacy = aggregate.samples.filter(sample => !isVersionedEvidenceRubric(sample.rubricVersion));
    const groups = new Map<string, ProfileEvidenceAggregate['samples']>();
    if (legacy.length) groups.set('', legacy);
    for (const sample of flow) groups.set(sample.rubricVersion!, [...(groups.get(sample.rubricVersion!) || []), sample]);
    for (const [rubricVersion, group] of groups) {
      const samples = [...group].sort((a, b) => new Date(a.observedAt).getTime() - new Date(b.observedAt).getTime()
        || a.episodeId.localeCompare(b.episodeId));
      const totalWeight = samples.reduce((sum, s) => sum + s.weight, 0);
      const alpha = CURRENT_ALPHA[aggregate.dimension];
      const mean = round1(emaSamples(samples, alpha));
      const baselineMean = round1(emaSamples(samples, Math.max(.05, alpha * .4)));
      const split: ProfileEvidenceAggregate = { ...aggregate, rubricVersion: rubricVersion || undefined, samples,
        mean, baselineMean, trendDelta: round1(mean - baselineMean),
        confidence: totalWeight ? round1(samples.reduce((sum, s) => sum + s.weight * s.weight, 0) / totalWeight) : 0,
        historicalMean: totalWeight ? round1(samples.reduce((sum, s) => sum + s.value * s.weight, 0) / totalWeight) : mean,
        updatedAt: samples.at(-1)!.observedAt };
      split.status = canTrust(split, false) ? 'trusted' : 'holding';
      const target = `${aggregate.dimension}:${aggregate.indicator}${rubricVersion ? `:${rubricVersion}` : ''}`;
      // Valid state normally has one owner per metric. Never silently overwrite a colliding cohort.
      if (aggregates[target]) throw new Error('画像量规分组重复，未改写证据');
      aggregates[target] = split;
    }
  }
  return { ...profile, evidenceGate: { ...profile.evidenceGate, aggregates } };
}

function applyTrustedAggregate(profile: UserProfile, aggregate: ProfileEvidenceAggregate): void {
  if (aggregate.dimension === 'ability' && ABILITY_KEYS.has(aggregate.indicator)) {
    const key = aggregate.indicator as keyof Pick<UserProfile['ability'], 'conceptClarity' | 'judgmentReasonableness' | 'reasoningValidity'>;
    profile.ability[key] = blend(profile.ability[key], aggregate.mean, 0.25, 6);
  }
  if (aggregate.dimension === 'cognitive_style' && COGNITIVE_KEYS.has(aggregate.indicator as keyof CognitiveStyle)) {
    const key = aggregate.indicator as keyof CognitiveStyle;
    profile.cognitiveStyle[key] = blend(profile.cognitiveStyle[key], aggregate.mean, 0.2, 8);
  }
}

/** 纯函数：评估本次事件信号，并返回更新后的画像和每条证据的门控决策。 */
export function applyProfileEvidenceGate(profile: UserProfile, input: GateInput): GateResult {
  profile = partitionFlowProfileEvidence(profile);
  const previous = profile.evidenceGate || initialEvidenceGateState(profile);
  if (previous.processedEpisodeIds.includes(input.episodeId)) {
    return { profile, decisions: [], duplicate: true };
  }

  const next: UserProfile = {
    ...profile,
    ability: { ...profile.ability },
    cognitiveStyle: { ...profile.cognitiveStyle },
    evidenceGate: {
      version: 1,
      processedEpisodeIds: [...previous.processedEpisodeIds, input.episodeId].slice(-2000),
      aggregates: { ...previous.aggregates },
    },
  };
  const decisions: GateDecision[] = [];
  let validProfileSignal = false;
  let validAbilitySignal = false;
  const seen = new Set<string>();

  for (const candidate of input.signals) {
    if (candidate.sourceEpisodeId !== input.episodeId) {
      decisions.push({ dimension: candidate.dimension, indicator: candidate.indicator, action: 'reject', reason: '证据来源与当前事件不一致' });
      continue;
    }
    const admission = evaluateProfileSignal(candidate, input.sampleChars);
    if (admission.action !== 'accept') {
      decisions.push({
        dimension: candidate.dimension,
        indicator: candidate.indicator,
        action: admission.action,
        reason: admission.reason,
      });
      continue;
    }
    const key = aggregateKey(candidate);
    if (seen.has(key)) {
      decisions.push({ dimension: candidate.dimension, indicator: candidate.indicator, action: 'reject', reason: '同一事件内指标重复' });
      continue;
    }
    seen.add(key);
    if (candidate.confidence < 0.6 || !isInRange(candidate)) {
      decisions.push({ dimension: candidate.dimension, indicator: candidate.indicator, action: 'reject', reason: '置信度或数值范围不合格' });
      continue;
    }

    validProfileSignal = true;
    if (candidate.dimension === 'ability') validAbilitySignal = true;
    const previousAggregate = next.evidenceGate!.aggregates[key];
    const aggregate = updateAggregate(previousAggregate, candidate, input.episodeId);
    // 每次都按滚动样本重新评估；后续证据明显冲突时允许从 trusted 退回 holding。
    const trusted = canTrust(aggregate, candidate.evidenceType === 'explicit');
    aggregate.status = trusted ? 'trusted' : 'holding';
    next.evidenceGate!.aggregates[key] = aggregate;
    if (trusted) applyTrustedAggregate(next, aggregate);
    decisions.push({
      dimension: candidate.dimension,
      indicator: candidate.indicator,
      action: trusted ? 'aggregate' : 'hold',
      reason: trusted ? '达到该画像维度的稳定证据门槛' : '证据有效但样本数或一致性不足',
    });
  }

  if (validProfileSignal) next.analysisCount += 1;
  if (validAbilitySignal) {
    next.ability.evidenceCount += 1;
    next.ability.evidenceChars += Math.max(0, Math.round(input.sampleChars));
  }
  return { profile: next, decisions, duplicate: false };
}
