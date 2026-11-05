import assert from 'node:assert/strict';
import { applyMasteryShadowObservation, createMasteryShadowState, effectiveMasteryShadowState } from '../src/services/masteryShadow/stateMachine';
import { MASTERY_SHADOW_CRITERIA } from '../src/services/masteryShadow/rubric';
import type { MasteryShadowObservation, MasteryShadowState, MasteryShadowVerdict } from '../src/services/masteryShadow/types';
import { readKnowledgeMastery } from '../src/services/masteryReadModel';
import { buildHomeViewModel } from '../src/services/homepage/homepageViewModel';
import { buildKnowledgeReviewCandidates } from '../src/services/reviewScheduler';
import { getNoteMasteryBand } from '../src/services/knowledgeGraphModel';
import { serializeUserStateFile, deserializeUserStateFile } from '../src/services/userStateService';
import type { NoteItem } from '../src/types';
import { buildReviewTutorContext } from '../src/services/reviewTutorContext';
import { freezeReviewAssessment } from '../src/services/reviewAssessment';

globalThis.fetch = async () => assert.fail('Local criterion tests must never call a model or vault');
let groups = 0;
const pass = (name: string) => { groups++; console.log(`PASS ${name}`); };
const at = '2026-10-18T08:00:00.000Z';
function observation(id: string, criterionId: string, verdict: MasteryShadowVerdict | 'not_applicable' = 'pass', overrides: Partial<MasteryShadowObservation> = {}): MasteryShadowObservation {
  const criterion = MASTERY_SHADOW_CRITERIA.find(row => row.id === criterionId)!;
  return { id, knowledgePointId: 'kp', occurredAt: at, source: 'flow_review', assistance: 'independent',
    referenceBasis: 'grounded', strength: 'natural', coverage: 'assessed',
    results: [{ layer: criterion.layer, verdict: verdict === 'not_applicable' ? 'unverifiable' : verdict,
      criterionIds: [criterionId], userEvidenceIds: [`U-${id}`], referenceIds: ['REF'], criterionResults: [{ id: criterionId,
        verdict, userEvidenceIds: [`U-${id}`], referenceIds: ['REF'], referenceBasis: 'grounded' }] }], ...overrides };
}
const noteFor = (state: MasteryShadowState): NoteItem => ({ id: 'kp', title: '测试知识点', noteType: 'knowledge', content: '测试的已保存正文。',
  tags: [], links: [], backlinks: [], dueDates: [], createdAt: at, updatedAt: at,
  dsrState: { difficulty: 5, stability: 10, reviewCount: 0, lastReviewedAt: null, consecutiveCorrect: 0, consecutiveWrong: 0, masteryShadow: state } });
let state = createMasteryShadowState('kp');
for (let i = 0; i < 5; i++) state = applyMasteryShadowObservation(state, observation(`meaning-${i}`, 'concept_accuracy'));
assert.equal(state.layers.concept.criteria!.concept_accuracy.state, 'confirmed');
assert.equal(state.layers.concept.criteria!.concept_boundary.state, 'unassessed');
assert.equal(state.layers.concept.criteria!.concept_application.state, 'unassessed');
assert.equal(state.layers.concept.state, 'provisional');
assert.equal(readKnowledgeMastery(noteFor(state)).confirmedLevel, 0);
assert.equal(readKnowledgeMastery(noteFor(state)).criterionProgress!.concept.confirmed, 1);
assert.match(readKnowledgeMastery(noteFor(state)).nextAction, /概念边界.*概念应用/u);
pass('重复五次含义仍只能确认含义，不替代边界/应用；首页读取口径为待确认并提示实际缺项');

for (const id of ['concept_boundary', 'concept_application']) {
  state = applyMasteryShadowObservation(state, observation(`${id}-flow`, id));
  assert.equal(state.layers.concept.state, 'provisional');
  state = applyMasteryShadowObservation(state, observation(`${id}-review`, id, 'pass', { source: 'socratic_review' }));
}
assert.equal(state.layers.concept.state, 'confirmed');
assert.equal(readKnowledgeMastery(noteFor(state)).confirmedLevel, 1);
const fullConcept = structuredClone(state);
assert.deepEqual(applyMasteryShadowObservation(state, observation('concept_application-review', 'concept_application')), state);
pass('两入口可跨会话逐项累积，所有概念判据分别确认才确认整层；重复保存不加证据');

state = applyMasteryShadowObservation(state, observation('boundary-fail-1', 'concept_boundary', 'fail'));
assert.equal(state.layers.concept.state, 'confirmed');
assert.equal(readKnowledgeMastery(noteFor(state)).reviewCategory, 'verify');
state = applyMasteryShadowObservation(state, observation('unrelated-success', 'concept_accuracy'));
assert.equal(state.layers.concept.criteria!.concept_boundary.unresolvedFailures, 1);
state = applyMasteryShadowObservation(state, observation('boundary-fail-2', 'concept_boundary', 'fail'));
assert.equal(state.layers.concept.state, 'needs_review');
state = applyMasteryShadowObservation(state, observation('boundary-recover-1', 'concept_boundary'));
assert.equal(state.layers.concept.state, 'provisional');
state = applyMasteryShadowObservation(state, observation('boundary-recover-2', 'concept_boundary'));
assert.equal(state.layers.concept.state, 'confirmed');
assert.equal(state.layers.concept.criteria!.concept_application.state, 'confirmed');
pass('错误只复核对应判据；重复含义成功不能清除边界警报，边界复核不抹除已确认应用');

for (const verdict of ['not_applicable', 'not_observed', 'unverifiable', 'partial'] as const) {
  const before = structuredClone(state);
  const after = applyMasteryShadowObservation(state, observation(`nondecisive-${verdict}`, 'concept_boundary', verdict));
  assert.equal(after.layers.concept.criteria!.concept_boundary.state, before.layers.concept.criteria!.concept_boundary.state);
  assert.equal(after.layers.concept.criteria!.concept_boundary.independentPasses, before.layers.concept.criteria!.concept_boundary.independentPasses);
}
const assisted = applyMasteryShadowObservation(createMasteryShadowState('kp'), observation('assisted', 'concept_boundary', 'pass', { assistance: 'assisted' }));
assert.notEqual(assisted.layers.concept.criteria!.concept_boundary.state, 'confirmed');
const ungrounded = observation('ungrounded', 'concept_boundary', 'fail');
ungrounded.results[0].criterionResults![0].referenceBasis = 'model_only';
ungrounded.results[0].criterionResults![0].referenceIds = [];
assert.equal(applyMasteryShadowObservation(state, ungrounded).layers.concept.criteria!.concept_boundary.unresolvedFailures, 0);
pass('不适用/未展示/部分满足/无法核验不补通过，有提示不能确认，无资料硬错不降低状态');

for (const criterion of MASTERY_SHADOW_CRITERIA.filter(row => row.layer !== 'concept')) {
  state = applyMasteryShadowObservation(state, observation(`targeted-${criterion.id}`, criterion.id, 'pass', { source: 'quick_check', strength: 'targeted' }));
}
const fullNote = noteFor(state), view = readKnowledgeMastery(fullNote);
assert.equal(view.confirmedLevel, 3); assert.equal(view.confirmed, true);
assert.equal(getNoteMasteryBand(fullNote), 'confirmed');
assert.ok(buildKnowledgeReviewCandidates([fullNote], 'smart').every(row => row.noteId === 'kp'));
const home = buildHomeViewModel([fullNote], { ability: {}, cognitiveStyle: {}, learningAbility: {} } as any, { version: 1, weeks: [] });
assert.ok(home);
assert.equal(view.criterionProgress!.judgment.confirmed, 3); assert.equal(view.criterionProgress!.reasoning.confirmed, 3);
pass('判断/推理也各需全部判据；首页、图谱、复习筛选继续消费同一三层投影，不引入伪百分比');

const old = structuredClone(fullConcept);
for (const layer of ['concept', 'judgment', 'reasoning'] as const) delete old.layers[layer].criteria;
const beforeOld = JSON.stringify(old);
const interpreted = effectiveMasteryShadowState(old);
assert.equal(interpreted.layers.concept.state, 'provisional');
assert.equal(interpreted.layers.concept.legacySummary!.state, 'confirmed');
assert.equal(JSON.stringify(old), beforeOld);
const oldEvent = observation('aggregate-only', 'concept_accuracy');
delete oldEvent.results[0].criterionResults;
assert.notEqual(applyMasteryShadowObservation(old, oldEvent).layers.concept.state, 'confirmed');
const saved = deserializeUserStateFile(serializeUserStateFile({ kp: { dsrState: fullNote.dsrState } }));
assert.deepEqual(saved.kp.dsrState!.masteryShadow, state);
pass('旧整体确认保留历史，不伪造分项通过、不启动重写；新分项数据可无损保存和重载');
const tutor = buildReviewTutorContext({ mode: 'next-question', noteTitle: '测试知识点', knowledgeContext: '', messages: [],
  currentIntent: { version: 1, questionMessageId: 'q', knowledgeTargets: ['测试知识点'] },
  isProjectReview: false, allowedKnowledgeTargets: ['测试知识点'], hintLevel: 0,
  criterionFocus: [{ knowledgeTarget: '测试知识点', pendingIds: ['concept_boundary', 'concept_application', 'model_invented'] }] });
assert.ok(tutor.userInput.includes('概念边界') && tutor.userInput.includes('概念应用'));
assert.ok(!tutor.userInput.includes('model_invented'));
assert.match(tutor.userInput, /不表示本轮尚未作答/u);
assert.deepEqual(freezeReviewAssessment('attribution', ['测试知识点']).requirements[0].criterionIds, ['attribution_scope']);
pass('导师收到实际缺项而非总分，非法判据不注入；新增归属题型可提供判断层第三项的取证机会');
console.log(`PASS ${groups} comprehensive mastery groups; no network or production writes.`);
