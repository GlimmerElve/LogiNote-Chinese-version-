import {
  MASTERY_SHADOW_LAYERS,
  MasteryShadowAggregate,
  MasteryShadowAssessmentStatus,
  MasteryShadowProjectionInput,
  MasteryShadowReviewCategory,
  MasteryShadowView,
} from './types';
import { createMasteryShadowState, effectiveMasteryShadowState } from './stateMachine';
import { MASTERY_SHADOW_CRITERIA } from './rubric';

const PRIORITY_BANDS: Record<MasteryShadowReviewCategory, readonly [number, number]> = {
  content_incomplete: [0, 0],
  verify: [90, 100],
  strengthen: [70, 89],
  confirm: [55, 69],
  diagnose: [40, 54],
  memory_refresh: [20, 39],
  stable: [0, 19],
};

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function assessmentStatus(
  states: MasteryShadowView['layers'],
  requiredLevel: 1 | 2 | 3 | null,
): MasteryShadowAssessmentStatus {
  const requiredStates = MASTERY_SHADOW_LAYERS.slice(0, requiredLevel ?? 3).map((layer) => states[layer]);
  if (requiredStates.includes('needs_review')) return 'needs_review';
  if (requiredStates.every((state) => state === 'confirmed')) return 'confirmed';
  if (requiredStates.some((state) => state !== 'unassessed')) return 'provisional';
  return 'unassessed';
}

function highestContiguousConfirmedLevel(states: MasteryShadowView['layers']): 0 | 1 | 2 | 3 {
  let level = 0;
  for (const layer of MASTERY_SHADOW_LAYERS) {
    if (states[layer] !== 'confirmed') break;
    level += 1;
  }
  return level as 0 | 1 | 2 | 3;
}

function categoryFor(
  input: MasteryShadowProjectionInput,
  status: MasteryShadowAssessmentStatus,
  confirmedLevel: 0 | 1 | 2 | 3,
  states: MasteryShadowView['layers'],
): MasteryShadowReviewCategory {
  if (input.contentStatus !== 'ready') return 'content_incomplete';
  if (status === 'needs_review') return 'verify';
  if (MASTERY_SHADOW_LAYERS.slice(0, input.requiredLevel ?? 3).some(layer =>
    (input.state?.layers[layer].unresolvedFailures || 0) > 0)) return 'verify';
  if (confirmedLevel === 3 || input.requiredLevel != null && confirmedLevel >= input.requiredLevel) {
    if (input.retrievability != null && input.retrievability < 0.6) return 'memory_refresh';
    return 'stable';
  }
  const requiredStates = MASTERY_SHADOW_LAYERS.slice(0, input.requiredLevel ?? 3).map(
    (layer) => states[layer],
  );
  if (requiredStates.includes('provisional')) return 'confirm';
  if (confirmedLevel > 0 && input.requiredLevel != null) return 'strengthen';
  if (status === 'unassessed') return 'diagnose';
  return 'diagnose';
}

function priorityFor(
  category: MasteryShadowReviewCategory,
  targetGap: number | null,
  retrievability: number | undefined,
): number {
  const [min, max] = PRIORITY_BANDS[category];
  if (min === max) return min;
  const memoryRisk = retrievability == null ? 0.5 : 1 - clamp01(retrievability);
  const gapRisk = targetGap == null ? 0 : Math.min(1, Math.max(0, targetGap) / 3);
  const risk = category === 'memory_refresh' ? memoryRisk : 0.65 * gapRisk + 0.35 * memoryRisk;
  return Math.round(min + (max - min) * risk);
}

function labelFor(
  input: MasteryShadowProjectionInput,
  status: MasteryShadowAssessmentStatus,
  confirmedLevel: 0 | 1 | 2 | 3,
  targetMet: boolean | null,
): string {
  if (input.contentStatus === 'incomplete') return '资料待补全';
  if (input.contentStatus === 'needs_review') return '资料待审核';
  if (status === 'needs_review') return '待复核';
  if (targetMet) return '达到目标';
  if (confirmedLevel === 3) return '推理已确认';
  if (confirmedLevel === 2) return '判断已确认';
  if (confirmedLevel === 1) return '概念已确认';
  if (status === 'provisional') return '待确认';
  return '未评估';
}

/** Shared read-only projection. A missing target remains unknown, never an inferred level 3. */
export function projectMasteryShadow(input: MasteryShadowProjectionInput): MasteryShadowView {
  const state = input.state ? effectiveMasteryShadowState(input.state) : createMasteryShadowState(input.knowledgePointId);
  input = { ...input, state };
  if (state.knowledgePointId !== input.knowledgePointId) {
    throw new Error('mastery-shadow projection knowledgePointId mismatch');
  }
  const layers = Object.fromEntries(
    MASTERY_SHADOW_LAYERS.map((layer) => [layer, state.layers[layer].state]),
  ) as MasteryShadowView['layers'];
  const confirmedLevel = highestContiguousConfirmedLevel(layers);
  const status = assessmentStatus(layers, input.requiredLevel);
  const targetGap = input.requiredLevel == null ? null : Math.max(0, input.requiredLevel - confirmedLevel) as 0 | 1 | 2 | 3;
  const targetMet = targetGap == null ? null : status === 'confirmed' && targetGap === 0;
  const reviewCategory = categoryFor(input, status, confirmedLevel, layers);

  return {
    knowledgePointId: input.knowledgePointId,
    contentStatus: input.contentStatus,
    assessmentStatus: status,
    layers,
    confirmedLevel,
    requiredLevel: input.requiredLevel,
    targetGap,
    targetMet,
    retrievability: input.retrievability == null ? null : clamp01(input.retrievability),
    reviewCategory,
    reviewPriority: priorityFor(reviewCategory, targetGap, input.retrievability),
    displayLabel: labelFor(input, status, confirmedLevel, targetMet),
    criterionProgress: Object.fromEntries(MASTERY_SHADOW_LAYERS.map(layer => {
      const ids = MASTERY_SHADOW_CRITERIA.filter(criterion => criterion.layer === layer).map(criterion => criterion.id);
      const pendingIds = ids.filter(id => state.layers[layer].criteria![id].state !== 'confirmed');
      return [layer, { confirmed: ids.length - pendingIds.length, total: ids.length, pendingIds }];
    })) as MasteryShadowView['criterionProgress'],
    legacy: input.legacy,
    legacyOnly:
      Boolean(input.legacy?.samples || input.legacy?.score != null) &&
      MASTERY_SHADOW_LAYERS.every((layer) => layers[layer] === 'unassessed'),
  };
}

export function aggregateMasteryShadowViews(views: MasteryShadowView[]): MasteryShadowAggregate {
  const aggregate: MasteryShadowAggregate = {
    total: views.length,
    content: { ready: 0, incomplete: 0, needsReview: 0 },
    assessment: { unassessed: 0, provisional: 0, confirmed: 0, needsReview: 0 },
    highestConfirmedLevel: { none: 0, concept: 0, judgment: 0, reasoning: 0 },
    target: { met: 0, gap: 0, unset: 0 },
    reviewCategories: {
      content_incomplete: 0,
      verify: 0,
      strengthen: 0,
      confirm: 0,
      diagnose: 0,
      memory_refresh: 0,
      stable: 0,
    },
    legacyOnly: 0,
  };

  for (const view of views) {
    if (view.contentStatus === 'ready') aggregate.content.ready += 1;
    if (view.contentStatus === 'incomplete') aggregate.content.incomplete += 1;
    if (view.contentStatus === 'needs_review') aggregate.content.needsReview += 1;

    if (view.assessmentStatus === 'unassessed') aggregate.assessment.unassessed += 1;
    if (view.assessmentStatus === 'provisional') aggregate.assessment.provisional += 1;
    if (view.assessmentStatus === 'confirmed') aggregate.assessment.confirmed += 1;
    if (view.assessmentStatus === 'needs_review') aggregate.assessment.needsReview += 1;

    if (view.confirmedLevel === 0) aggregate.highestConfirmedLevel.none += 1;
    if (view.confirmedLevel === 1) aggregate.highestConfirmedLevel.concept += 1;
    if (view.confirmedLevel === 2) aggregate.highestConfirmedLevel.judgment += 1;
    if (view.confirmedLevel === 3) aggregate.highestConfirmedLevel.reasoning += 1;

    if (view.targetMet === true) aggregate.target.met += 1;
    else if (view.targetMet === false) aggregate.target.gap += 1;
    else aggregate.target.unset += 1;
    aggregate.reviewCategories[view.reviewCategory] += 1;
    if (view.legacyOnly) aggregate.legacyOnly += 1;
  }

  return aggregate;
}

export function sortMasteryShadowViewsForReview(views: MasteryShadowView[]): MasteryShadowView[] {
  return [...views].sort(
    (left, right) =>
      right.reviewPriority - left.reviewPriority ||
      left.knowledgePointId.localeCompare(right.knowledgePointId),
  );
}
