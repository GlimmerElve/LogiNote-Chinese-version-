import {
  MASTERY_SHADOW_LAYERS,
  MasteryShadowLayer,
  MasteryShadowLayerRecord,
  MasteryShadowObservation,
  MasteryShadowState,
  MasteryShadowEvidenceRecord,
} from './types';
import { MASTERY_SHADOW_CRITERIA } from './rubric';

const MAX_APPLIED_OBSERVATIONS = 100;
const MAX_RECENT_EVIDENCE = 6;

function emptyEvidence(): MasteryShadowEvidenceRecord {
  return {
    state: 'unassessed',
    independentPasses: 0,
    unresolvedFailures: 0,
    recentEvidenceIds: [],
  };
}

function emptyLayer(layer: MasteryShadowLayer): MasteryShadowLayerRecord {
  return { ...emptyEvidence(), criteria: Object.fromEntries(MASTERY_SHADOW_CRITERIA
    .filter(criterion => criterion.layer === layer).map(criterion => [criterion.id, emptyEvidence()])) };
}

export function createMasteryShadowState(knowledgePointId: string): MasteryShadowState {
  return {
    version: 1,
    knowledgePointId,
    layers: {
      concept: emptyLayer('concept'),
      judgment: emptyLayer('judgment'),
      reasoning: emptyLayer('reasoning'),
    },
    appliedObservationIds: [],
  };
}

const evidenceCopy = (record: MasteryShadowEvidenceRecord): MasteryShadowEvidenceRecord => ({
  state: record.state,
  independentPasses: Number.isSafeInteger(record.independentPasses) ? Math.max(0, Math.min(2, record.independentPasses)) : 0,
  unresolvedFailures: Number.isSafeInteger(record.unresolvedFailures) ? Math.max(0, record.unresolvedFailures) : 0,
  ...(typeof record.lastObservedAt === 'string' ? { lastObservedAt: record.lastObservedAt } : {}),
  ...(typeof record.lastConfirmedAt === 'string' ? { lastConfirmedAt: record.lastConfirmedAt } : {}),
  recentEvidenceIds: Array.isArray(record.recentEvidenceIds)
    ? record.recentEvidenceIds.filter(id => typeof id === 'string').slice(-MAX_RECENT_EVIDENCE) : [],
});

function refreshLayer(record: MasteryShadowLayerRecord): void {
  const criteria = Object.values(record.criteria!);
  const legacy = record.legacySummary;
  const complete = criteria.every(criterion => criterion.state === 'confirmed');
  record.state = criteria.some(criterion => criterion.state === 'needs_review') ? 'needs_review'
    : complete ? 'confirmed'
      : legacy?.state === 'needs_review' ? 'needs_review'
        : criteria.some(criterion => criterion.state !== 'unassessed') ? 'provisional'
          : legacy && legacy.state !== 'unassessed' ? 'provisional' : 'unassessed';
  // Aggregate counters are compatibility projections only. They cannot replace any criterion.
  record.independentPasses = Math.min(...criteria.map(criterion => criterion.independentPasses));
  record.unresolvedFailures = Math.max(...criteria.map(criterion => criterion.unresolvedFailures), complete ? 0 : legacy?.unresolvedFailures || 0);
  if (record.state === 'confirmed') record.lastConfirmedAt = criteria.map(criterion => criterion.lastConfirmedAt || '').sort().at(-1);
  else delete record.lastConfirmedAt;
}

/** Read-only interpretation of old aggregates: retain history, never infer unobserved criteria. */
export function effectiveMasteryShadowState(state: MasteryShadowState): MasteryShadowState {
  return {
    ...state,
    layers: Object.fromEntries(
      MASTERY_SHADOW_LAYERS.map((layer) => [
        layer,
        (() => {
          const stored = state.layers[layer], record = emptyLayer(layer);
          Object.assign(record, evidenceCopy(stored));
          if (stored.legacySummary) record.legacySummary = evidenceCopy(stored.legacySummary);
          else if (!stored.criteria && (stored.state !== 'unassessed' || stored.recentEvidenceIds?.length)) {
            record.legacySummary = evidenceCopy(stored);
          }
          for (const id of Object.keys(record.criteria!)) {
            const prior = stored.criteria?.[id];
            if (prior && ['unassessed', 'provisional', 'confirmed', 'needs_review'].includes(prior.state)
              && Number.isSafeInteger(prior.independentPasses) && prior.independentPasses >= 0
              && Number.isSafeInteger(prior.unresolvedFailures) && prior.unresolvedFailures >= 0
              && Array.isArray(prior.recentEvidenceIds)
              && (prior.state !== 'confirmed' || (prior.independentPasses >= 1 || prior.unresolvedFailures > 0)
                && prior.recentEvidenceIds.length > 0)) {
              record.criteria![id] = evidenceCopy(prior);
            }
          }
          refreshLayer(record);
          return record;
        })(),
      ]),
    ) as MasteryShadowState['layers'],
    appliedObservationIds: [...state.appliedObservationIds],
    ...(state.migration ? { migration: structuredClone(state.migration) } : {}),
  };
}

function appendEvidence(record: MasteryShadowEvidenceRecord, ids: string[]): void {
  record.recentEvidenceIds = [...new Set([...record.recentEvidenceIds, ...ids])].slice(
    -MAX_RECENT_EVIDENCE,
  );
}

function applyPass(
  record: MasteryShadowEvidenceRecord,
  observation: MasteryShadowObservation,
): void {
  const confirmable =
    observation.assistance === 'independent' && observation.referenceBasis === 'grounded';

  if (!confirmable) {
    if (record.state === 'unassessed') {
      record.state = 'provisional';
    }
    return;
  }

  record.unresolvedFailures = 0;

  if (observation.strength === 'targeted') {
    record.state = 'confirmed';
    record.independentPasses = Math.max(record.independentPasses, 1);
    record.lastConfirmedAt = observation.occurredAt;
    return;
  }

  if (record.state === 'needs_review') {
    record.state = 'provisional';
    record.independentPasses = 1;
    return;
  }

  record.independentPasses = Math.min(2, record.independentPasses + 1);
  if (record.independentPasses >= 2) {
    record.state = 'confirmed';
    record.lastConfirmedAt = observation.occurredAt;
  } else if (record.state !== 'confirmed') {
    record.state = 'provisional';
  }
}

function applyFail(
  record: MasteryShadowEvidenceRecord,
  observation: MasteryShadowObservation,
): void {
  // 没有可读参考依据时，不能仅凭模型常识把长期掌握状态拉低。
  if (observation.referenceBasis !== 'grounded' || observation.assistance !== 'independent') return;

  const strongFailure =
    observation.strength === 'targeted' &&
    observation.assistance === 'independent' &&
    observation.referenceBasis === 'grounded';

  record.independentPasses = 0;
  if (record.state !== 'confirmed' || strongFailure) {
    record.state = 'needs_review';
    record.unresolvedFailures = Math.max(1, record.unresolvedFailures + 1);
    return;
  }

  record.unresolvedFailures += 1;
  if (record.unresolvedFailures >= 2) record.state = 'needs_review';
}

/**
 * 将单次语义评价结果折算成长期状态。该函数无 IO、不修改输入，也不推断未评价层级。
 */
export function applyMasteryShadowObservation(
  current: MasteryShadowState | undefined,
  observation: MasteryShadowObservation,
): MasteryShadowState {
  const source = current ?? createMasteryShadowState(observation.knowledgePointId);
  if (source.knowledgePointId !== observation.knowledgePointId) {
    throw new Error('mastery-shadow knowledgePointId mismatch');
  }
  if (source.appliedObservationIds.includes(observation.id)) return structuredClone(source);

  const next = effectiveMasteryShadowState(source);
  next.appliedObservationIds = [...next.appliedObservationIds, observation.id].slice(
    -MAX_APPLIED_OBSERVATIONS,
  );
  next.updatedAt = observation.occurredAt;

  // 一句带过、未测试或无法核实，只记录事件已处理，不改变掌握状态。
  if (observation.coverage !== 'assessed') return next;

  const seenLayers = new Set<MasteryShadowLayer>();
  for (const result of observation.results) {
    if (seenLayers.has(result.layer)) continue;
    seenLayers.add(result.layer);

    const record = next.layers[result.layer];
    record.lastObservedAt = observation.occurredAt;
    appendEvidence(record, [observation.id, ...result.userEvidenceIds, ...result.referenceIds]);

    const seenCriteria = new Set<string>();
    for (const criterion of result.criterionResults || []) {
      const definition = MASTERY_SHADOW_CRITERIA.find(item => item.id === criterion.id && item.layer === result.layer);
      if (!definition || seenCriteria.has(criterion.id) || !result.criterionIds.includes(criterion.id)) continue;
      seenCriteria.add(criterion.id);
      if (!['pass', 'fail', 'partial'].includes(criterion.verdict) || !criterion.userEvidenceIds.length) continue;
      const grounded = criterion.referenceBasis === 'grounded' && criterion.referenceIds.length > 0;
      // Logical/attribution criteria can be grounded in the user's actual text without external facts.
      const textGrounded = !definition.referenceRequired && criterion.userEvidenceIds.length > 0;
      const proof = { ...observation, referenceBasis: grounded || textGrounded ? 'grounded' as const : 'unavailable' as const };
      if ((criterion.verdict === 'pass' || criterion.verdict === 'fail')
        && proof.referenceBasis === 'grounded' && proof.assistance === 'independent'
        && Array.isArray(next.migration?.activeLayers) && next.migration.activeLayers.includes(result.layer)) {
        // A historical estimate must not remain a permanent review warning or
        // substitute for real criterion evidence after a new assessment takes over.
        delete record.legacySummary;
        next.migration.activeLayers = next.migration.activeLayers.filter(layer => layer !== result.layer);
      }
      const target = record.criteria![criterion.id];
      target.lastObservedAt = observation.occurredAt;
      appendEvidence(target, [observation.id, ...criterion.userEvidenceIds, ...criterion.referenceIds]);
      if (criterion.verdict === 'pass') applyPass(target, {
        ...proof, strength: criterion.passStrength === 'targeted' ? 'targeted' : proof.strength,
      });
      if (criterion.verdict === 'fail') applyFail(target, proof);
      // Partial evidence remains visible, but does not upgrade or downgrade the criterion.
    }
    // Layer-only historical observations are recorded, not expanded into fake criterion passes.
    if (!result.criterionResults && ['pass', 'partial'].includes(result.verdict) && record.state === 'unassessed') {
      record.legacySummary = { ...emptyEvidence(), state: 'provisional', recentEvidenceIds: [observation.id] };
    }
    refreshLayer(record);
  }

  return next;
}

export function applyMasteryShadowObservations(
  initial: MasteryShadowState | undefined,
  observations: MasteryShadowObservation[],
): MasteryShadowState {
  if (!initial && observations.length === 0) {
    throw new Error('mastery-shadow requires a state or at least one observation');
  }
  return observations.reduce<MasteryShadowState | undefined>(
    (state, observation) => applyMasteryShadowObservation(state, observation),
    initial,
  ) as MasteryShadowState;
}
