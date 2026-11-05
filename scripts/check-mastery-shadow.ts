import assert from 'node:assert/strict';
import {
  aggregateMasteryShadowViews,
  applyMasteryShadowObservation,
  createMasteryShadowState,
  MasteryShadowObservation,
  projectMasteryShadow,
  sortMasteryShadowViewsForReview,
} from '../src/services/masteryShadow/index.ts';
import { deserializeUserStateFile, serializeUserStateFile } from '../src/services/userStateService.ts';
import { MASTERY_SHADOW_CRITERIA } from '../src/services/masteryShadow/rubric';

const observedAt = (day: number) => `2026-10-${String(day).padStart(2, '0')}T08:00:00.000Z`;

function observation(
  id: string,
  overrides: Partial<MasteryShadowObservation> = {},
): MasteryShadowObservation {
  const result: MasteryShadowObservation = {
    id,
    knowledgePointId: 'kp-1',
    occurredAt: observedAt(Number(id.replace(/\D/g, '')) || 1),
    source: 'flow_review',
    coverage: 'assessed',
    assistance: 'independent',
    referenceBasis: 'grounded',
    strength: 'natural',
    results: [
      {
        layer: 'concept',
        verdict: 'pass',
        criterionIds: ['defines-boundary'],
        userEvidenceIds: [`user-${id}`],
        referenceIds: ['textbook-1'],
      },
    ],
    ...overrides,
  };
  // These historical cases exercise complete-layer events; make the per-criterion proof
  // explicit so the test no longer depends on the removed aggregate-only confirmation.
  result.results = result.results.map(row => {
    const ids = MASTERY_SHADOW_CRITERIA.filter(criterion => criterion.layer === row.layer).map(criterion => criterion.id);
    return { ...row, criterionIds: ids, criterionResults: ids.map(id => ({ id, verdict: row.verdict,
      userEvidenceIds: row.userEvidenceIds, referenceIds: row.referenceIds, referenceBasis: result.referenceBasis })) };
  });
  return result;
}

let state = createMasteryShadowState('kp-1');
const pristine = structuredClone(state);

state = applyMasteryShadowObservation(
  state,
  observation('o1', { coverage: 'incidental' }),
);
assert.equal(state.layers.concept.state, 'unassessed', '一句带过不得拉低或抬高状态');
assert.deepEqual(pristine.layers, createMasteryShadowState('kp-1').layers, '输入状态不得被修改');

state = applyMasteryShadowObservation(
  state,
  observation('o2', { referenceBasis: 'model_only', strength: 'targeted' }),
);
assert.equal(state.layers.concept.state, 'provisional', '仅靠模型常识不得直接确认');

state = applyMasteryShadowObservation(state, observation('o3'));
assert.equal(state.layers.concept.state, 'provisional', '一次自然通过仍需第二个独立证据');
state = applyMasteryShadowObservation(state, observation('o3b'));
assert.equal(state.layers.concept.state, 'confirmed', '两次独立自然通过应确认');
const afterNaturalConfirmation = structuredClone(state);
state = applyMasteryShadowObservation(state, observation('o3b'));
assert.deepEqual(state, afterNaturalConfirmation, '重复事件必须幂等');

state = applyMasteryShadowObservation(
  state,
  observation('o4', {
    results: [
      {
        layer: 'concept',
        verdict: 'fail',
        criterionIds: ['boundary-error'],
        userEvidenceIds: ['user-o4'],
        referenceIds: ['textbook-1'],
      },
    ],
  }),
);
assert.equal(state.layers.concept.state, 'confirmed', '一次自然失败不应立即抹掉既有确认');
assert.equal(state.layers.concept.unresolvedFailures, 1);

state = applyMasteryShadowObservation(
  state,
  observation('o5', {
    results: [
      {
        layer: 'concept',
        verdict: 'fail',
        criterionIds: ['boundary-error'],
        userEvidenceIds: ['user-o5'],
        referenceIds: ['textbook-1'],
      },
    ],
  }),
);
assert.equal(state.layers.concept.state, 'needs_review', '重复失败应进入待复核');

state = applyMasteryShadowObservation(
  state,
  observation('o6', { source: 'quick_check', strength: 'targeted' }),
);
assert.equal(state.layers.concept.state, 'confirmed', '定向独立简测可解除待复核');

const ungroundedFailure = applyMasteryShadowObservation(
  state,
  observation('o6b', {
    referenceBasis: 'model_only',
    strength: 'targeted',
    results: [
      {
        layer: 'concept',
        verdict: 'fail',
        criterionIds: ['model-only-disagreement'],
        userEvidenceIds: ['user-o6b'],
        referenceIds: [],
      },
    ],
  }),
);
assert.equal(ungroundedFailure.layers.concept.state, 'confirmed', '无参考依据不得拉低长期状态');

const judgmentOnly = applyMasteryShadowObservation(
  createMasteryShadowState('kp-2'),
  observation('o7', {
    knowledgePointId: 'kp-2',
    source: 'quick_check',
    strength: 'targeted',
    results: [
      {
        layer: 'judgment',
        verdict: 'pass',
        criterionIds: ['applies-condition'],
        userEvidenceIds: ['user-o7'],
        referenceIds: ['resource-2'],
      },
    ],
  }),
);
assert.equal(judgmentOnly.layers.judgment.state, 'confirmed');
assert.equal(judgmentOnly.layers.concept.state, 'unassessed', '高层通过不得反推低层通过');

const legacyOnly = projectMasteryShadow({
  knowledgePointId: 'legacy-kp',
  contentStatus: 'ready',
  requiredLevel: 2,
  retrievability: 0.9,
  legacy: { score: 92, samples: 3 },
});
assert.equal(legacyOnly.assessmentStatus, 'unassessed');
assert.equal(legacyOnly.targetMet, false);
assert.equal(legacyOnly.legacyOnly, true, '旧高分只能作为旧估计，不能伪造成新确认');
assert.equal(legacyOnly.reviewCategory, 'diagnose');

const strengthenView = projectMasteryShadow({
  knowledgePointId: 'kp-1',
  state,
  contentStatus: 'ready',
  requiredLevel: 2,
  retrievability: 0.85,
});
assert.equal(strengthenView.reviewCategory, 'strengthen', '已有低层确认时应补强目标层');

const confirmedView = projectMasteryShadow({
  knowledgePointId: 'kp-1',
  state,
  contentStatus: 'ready',
  requiredLevel: 1,
  retrievability: 0.85,
});
assert.equal(confirmedView.targetMet, true);
assert.equal(confirmedView.reviewCategory, 'stable');

const memoryView = projectMasteryShadow({
  knowledgePointId: 'kp-1',
  state,
  contentStatus: 'ready',
  requiredLevel: 1,
  retrievability: 0.25,
});
assert.equal(memoryView.targetMet, true);
assert.equal(memoryView.reviewCategory, 'memory_refresh', '理解达标与记忆变弱必须分开');

const incompleteView = projectMasteryShadow({
  knowledgePointId: 'kp-incomplete',
  contentStatus: 'incomplete',
  requiredLevel: 1,
});
assert.equal(incompleteView.reviewCategory, 'content_incomplete');
assert.equal(incompleteView.reviewPriority, 0, '资料未补全应去补全队列，不进入复习优先级');

const contentReviewView = projectMasteryShadow({
  knowledgePointId: 'kp-content-review',
  contentStatus: 'needs_review',
  requiredLevel: 1,
});
assert.equal(contentReviewView.reviewCategory, 'content_incomplete');
assert.equal(contentReviewView.displayLabel, '资料待审核');
assert.equal(contentReviewView.reviewPriority, 0);

const aggregate = aggregateMasteryShadowViews([
  legacyOnly,
  confirmedView,
  memoryView,
  incompleteView,
]);
assert.equal(aggregate.total, 4);
assert.equal(aggregate.assessment.unassessed, 2);
assert.equal(aggregate.assessment.confirmed, 2);
assert.equal(aggregate.legacyOnly, 1);
assert.equal(aggregate.target.met, 2);

const ordered = sortMasteryShadowViewsForReview([
  confirmedView,
  memoryView,
  legacyOnly,
  incompleteView,
]);
assert.equal(ordered[0].reviewCategory, 'diagnose');
assert.equal(ordered.at(-1)?.reviewCategory, 'content_incomplete');

// 现有用户状态序列化是透传结构；影子字段的兼容性测试不写磁盘，也不接入正式状态。
const fakeNoteState = {
  dsrState: {
    difficulty: 5,
    stability: 2,
    lastReviewedAt: null,
    reviewCount: 1,
    consecutiveCorrect: 0,
    consecutiveWrong: 0,
    conceptMastery: 92,
    conceptMasterySamples: 3,
    masteryShadow: state,
  },
};
const roundTrip = deserializeUserStateFile(
  serializeUserStateFile({ 'kp-1': fakeNoteState } as never),
) as Record<string, typeof fakeNoteState>;
assert.equal(roundTrip['kp-1'].dsrState.conceptMastery, 92, '旧字段不得被覆盖');
assert.deepEqual(roundTrip['kp-1'].dsrState.masteryShadow, state, '未来影子状态可无损持久化');

console.log(
  JSON.stringify(
    {
      ok: true,
      isolation: 'local fixtures only; no production writes',
      cases: 17,
      compatibility: {
        legacyScoreRemainsLegacy: true,
        incidentalMentionIgnored: true,
        noHigherLayerBackfill: true,
        duplicateEventIdempotent: true,
        serializerRoundTrip: true,
      },
      sampleProjection: {
        legacyOnly,
        confirmedView,
        memoryView,
      },
      aggregate,
    },
    null,
    2,
  ),
);
