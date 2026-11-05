import assert from 'node:assert/strict';
import type { KnowledgePointDsr, NoteItem, UserNoteState } from '../src/types';
import { planLegacyMasteryMigration, LEGACY_MASTERY_THRESHOLDS } from '../src/services/masteryShadow/legacyMigration';
import { applyMasteryShadowObservation, createMasteryShadowState, effectiveMasteryShadowState } from '../src/services/masteryShadow/stateMachine';
import { MASTERY_SHADOW_LAYERS, type MasteryShadowObservation, type MasteryShadowState } from '../src/services/masteryShadow/types';
import { MASTERY_SHADOW_CRITERIA, type MasteryShadowCriterionId } from '../src/services/masteryShadow/rubric';
import { matchesKnowledgeMasteryFilter, readKnowledgeMastery, summarizeKnowledgeMastery } from '../src/services/masteryReadModel';
import { buildKnowledgeGraphSlice, getNoteMasteryBand } from '../src/services/knowledgeGraphModel';
import { buildKnowledgeReviewCandidates } from '../src/services/reviewScheduler';
import { buildHomeViewModel } from '../src/services/homepage/homepageViewModel';

// Synthetic in-memory data only. This script performs no IO, LLM calls, indexing,
// profile writes or writes to the user's formal note/state files.
const at = '2026-10-18T08:00:00.000Z';
const options = { migrationId: 'synthetic-migration-v1', migratedAt: at };
const now = Date.parse(at);
function dsr(score?: number, samples?: number, updatedAt?: string): KnowledgePointDsr {
  return { difficulty: 4.5, stability: 12, lastReviewedAt: '2026-10-01T08:00:00.000Z', reviewCount: 7,
    consecutiveCorrect: 2, consecutiveWrong: 1, reviewSessionIds: ['old-review'],
    ...(score !== undefined ? { conceptMastery: score } : {}),
    ...(samples !== undefined ? { conceptMasterySamples: samples } : {}),
    ...(updatedAt !== undefined ? { conceptMasteryUpdatedAt: updatedAt } : {}) };
}
function note(id: string, state: UserNoteState): NoteItem {
  return { id, title: id, noteType: 'knowledge', content: `${id}描述一个现象的定义、条件与应用；本测试不评价这段正文的事实真伪。`,
    tags: [], links: [], backlinks: [], dueDates: [], createdAt: at, updatedAt: at, ...state };
}
const scores: Array<[string, number, 0 | 1 | 2 | 3]> = [
  ['low', 1, 0], ['below-concept', 54.999, 0], ['concept', 55, 1], ['below-judgment', 74.999, 1],
  ['judgment', 75, 2], ['below-reasoning', 89.999, 2], ['reasoning', 90, 3], ['maximum', 100, 3],
];
const states: Record<string, UserNoteState> = Object.fromEntries(scores.map(([id, score]) =>
  [id, { dsrState: dsr(score, 3, '2026-09-30T08:00:00.000Z'), flowSummary: `personal-${id}`, pinned: true }]));
Object.assign(states, {
  'default-zero': { dsrState: dsr(0) }, 'explicit-empty-zero': { dsrState: dsr(0, 0, 'not-a-date') },
  'scored-zero': { dsrState: dsr(0, 1) }, 'dated-zero': { dsrState: dsr(0, 0, at) },
  'missing-score': { dsrState: dsr() }, 'nan-score': { dsrState: dsr(NaN) },
  'infinite-score': { dsrState: dsr(Infinity) }, 'negative-score': { dsrState: dsr(-0.01) },
  'oversized-score': { dsrState: dsr(100.01) },
  'string-score': { dsrState: dsr('90' as unknown as number) },
  'bad-samples': { dsrState: dsr(80, -1) }, 'fractional-samples': { dsrState: dsr(80, 0.5) },
  'nan-samples': { dsrState: dsr(80, NaN) }, 'infinite-samples': { dsrState: dsr(80, Infinity) },
  'string-samples': { dsrState: dsr(80, '2' as unknown as number) },
  'unsafe-samples': { dsrState: dsr(80, Number.MAX_SAFE_INTEGER + 1) },
  'score-only': { dsrState: dsr(80) }, 'invalid-date': { dsrState: dsr(80, 1, 'invalid-date') },
  'empty-current': { dsrState: { ...dsr(80, 1), masteryShadow: createMasteryShadowState('empty-current') } },
  'existing-current': { dsrState: { ...dsr(99, 3), masteryShadow: { ...createMasteryShadowState('existing-current'),
    appliedObservationIds: ['real-old-observation'] } } },
  'updated-current': { dsrState: { ...dsr(99, 3), masteryShadow: { ...createMasteryShadowState('updated-current'), updatedAt: at } } },
  'invalid-current': { dsrState: { ...dsr(99, 3), masteryShadow: { version: 99 } as unknown as MasteryShadowState } },
  'wrong-note-current': { dsrState: { ...dsr(99, 3), masteryShadow: createMasteryShadowState('another-note') } },
  'project': { dsrState: dsr(99, 3) },
});
const notes = Object.entries(states).map(([id, state]) => id === 'project'
  ? { ...note(id, state), noteType: 'project' as const } : note(id, state));
const frozenStates = structuredClone(states), frozenNotes = structuredClone(notes);
const profileSentinel = { ability: { concept: 61 }, cognition: { abstract: -12 } };
const ragSentinel = { vectors: [[0.1, 0.2]], graphEntries: ['formal-rag-entry'] };
const externalBefore = structuredClone({ profileSentinel, ragSentinel });
const plan = planLegacyMasteryMigration(notes, states, options);
assert.deepEqual(plan.thresholds, LEGACY_MASTERY_THRESHOLDS);
assert.equal(plan.policy, 'legacy-score-estimate-v1');
assert.deepEqual(states, frozenStates, 'planning must not mutate personal states');
assert.deepEqual(notes, frozenNotes, 'planning must not mutate notes');
assert.deepEqual({ profileSentinel, ragSentinel }, externalBefore, 'no profile/RAG side effects');
assert.equal(plan.changes.length, scores.length + 5);
assert.ok(!plan.changes.some(row => row.noteId === 'project'), 'projects never receive knowledge-point migration');
for (const [id, score, level] of [...scores, ['scored-zero', 0, 0], ['dated-zero', 0, 0],
  ['score-only', 80, 2], ['invalid-date', 80, 2], ['empty-current', 80, 2]] as typeof scores) {
  const row = plan.changes.find(change => change.noteId === id)!;
  assert.ok(row, `expected change: ${id}`);
  assert.equal(row.sourceScore, score);
  assert.equal(row.estimatedLevel, level);
  assert.equal(row.after.migration!.estimatedLevel, level);
  assert.deepEqual(row.after.appliedObservationIds, [], 'migration is not a user answer/observation');
  assert.deepEqual(row.after.migration!.activeLayers, MASTERY_SHADOW_LAYERS.slice(0, level || 1));
  for (const layer of MASTERY_SHADOW_LAYERS) {
    const record = row.after.layers[layer];
    const active = row.after.migration!.activeLayers.includes(layer);
    assert.equal(record.state, active ? level === 0 ? 'needs_review' : 'provisional' : 'unassessed');
    assert.equal(record.independentPasses, 0);
    assert.equal(record.unresolvedFailures, 0, 'old low score is not a confirmed failure');
    assert.deepEqual(record.recentEvidenceIds, []);
    for (const criterion of Object.values(record.criteria!)) {
      assert.equal(criterion.state, 'unassessed');
      assert.equal(criterion.independentPasses, 0);
      assert.equal(criterion.unresolvedFailures, 0);
      assert.deepEqual(criterion.recentEvidenceIds, [], 'no synthetic evidence is manufactured');
    }
  }
  assert.deepEqual(effectiveMasteryShadowState(row.after), row.after, 'estimate survives normal normalization');
}
for (const id of ['default-zero', 'explicit-empty-zero']) {
  assert.equal(plan.skipped.find(row => row.noteId === id)?.reason, 'default_zero_without_assessment');
}
for (const id of ['missing-score', 'nan-score', 'infinite-score', 'negative-score', 'oversized-score', 'string-score']) {
  assert.equal(plan.skipped.find(row => row.noteId === id)?.reason, 'no_valid_legacy_score');
}
for (const id of ['bad-samples', 'fractional-samples', 'nan-samples', 'infinite-samples', 'string-samples', 'unsafe-samples']) {
  assert.equal(plan.skipped.find(row => row.noteId === id)?.reason, 'invalid_legacy_samples');
}
for (const id of ['existing-current', 'updated-current', 'invalid-current', 'wrong-note-current']) {
  assert.equal(plan.skipped.find(row => row.noteId === id)?.reason, 'existing_new_state');
}
assert.equal(plan.changes.find(row => row.noteId === 'invalid-date')!.after.migration!.sourceUpdatedAt, undefined);
assert.deepEqual(plan.changes.find(row => row.noteId === 'empty-current')!.before, states['empty-current'].dsrState!.masteryShadow);
assert.throws(() => planLegacyMasteryMigration(notes, states, { ...options, migrationId: ' ' }));
assert.throws(() => planLegacyMasteryMigration(notes, states, { ...options, migratedAt: 'invalid' }));
for (const thresholds of [{ concept: 0, judgment: 75, reasoning: 90 }, { concept: 75, judgment: 55, reasoning: 90 },
  { concept: 55, judgment: 75, reasoning: 101 }, { concept: 55, judgment: 55, reasoning: 90 },
  { concept: 55, judgment: 75, reasoning: NaN }]) {
  assert.throws(() => planLegacyMasteryMigration(notes, states, { ...options, thresholds }));
}
assert.throws(() => planLegacyMasteryMigration([notes[0], notes[0]], states, options));
const custom = planLegacyMasteryMigration([note('custom', {})], { custom: { dsrState: dsr(55, 1) } },
  { ...options, thresholds: { concept: 60, judgment: 80, reasoning: 95 } });
assert.equal(custom.changes[0].estimatedLevel, 0, 'custom thresholds are applied, not just recorded');

// Applying the plan here means replacing only masteryShadow in an isolated clone.
const appliedStates = structuredClone(states);
for (const row of plan.changes) {
  const dsrBefore = structuredClone(appliedStates[row.noteId].dsrState!);
  appliedStates[row.noteId].dsrState!.masteryShadow = structuredClone(row.after);
  const { masteryShadow: _ignored, ...actualUnchanged } = appliedStates[row.noteId].dsrState!;
  const { masteryShadow: _prior, ...expectedUnchanged } = dsrBefore;
  assert.deepEqual(actualUnchanged, expectedUnchanged, 'old score and memory scheduling are untouched');
}
const secondPlan = planLegacyMasteryMigration(notes, appliedStates, { ...options, migrationId: 'second-batch' });
assert.equal(secondPlan.changes.length, 0, 'rerunning with a different batch does not migrate twice');
for (const row of plan.changes) assert.equal(secondPlan.skipped.find(item => item.noteId === row.noteId)?.reason, 'already_migrated');
const reloadedStates = JSON.parse(JSON.stringify(appliedStates)) as Record<string, UserNoteState>;
const migratedNotes = plan.changes.map(row => note(row.noteId, reloadedStates[row.noteId]));
const aggregates = summarizeKnowledgeMastery(migratedNotes, { now });
assert.equal(aggregates.confirmedCount, 0, 'even 100 historical points cannot certify the new rubric');
for (const migrated of migratedNotes) {
  const view = readKnowledgeMastery(migrated, { mode: 'current', now });
  const level = migrated.dsrState!.masteryShadow!.migration!.estimatedLevel;
  assert.equal(view.confirmed, false);
  assert.equal(view.confirmedLevel, 0);
  assert.equal(view.displayLabel, level === 0 ? '待复核（历史估计）'
    : `历史估计至${['', '概念', '判断', '推理'][level]}层（待确认）`);
  assert.ok(!matchesKnowledgeMasteryFilter(view, 'confirmed'));
  assert.ok(matchesKnowledgeMasteryFilter(view, level === 0 ? 'needs_review' : 'provisional'));
  assert.equal(getNoteMasteryBand(migrated), view.band);
  const graph = buildKnowledgeGraphSlice({ notes: migratedNotes, focusKnowledgeId: migrated.id, density: 'sparse' });
  assert.equal(graph.nodes.find(row => row.noteId === migrated.id)!.masteryView!.displayLabel, view.displayLabel);
  assert.equal(graph.nodes.find(row => row.noteId === migrated.id)!.mastery, undefined, 'no fake percentage in graph');
}
const home = buildHomeViewModel(migratedNotes, { ability: {}, cognitiveStyle: {}, learningAbility: {} } as any,
  { version: 1, weeks: [] } as any, '2026-10-18');
assert.equal(home.masteredCount, 0);
assert.deepEqual(home.knowledgeMastery.assessment, aggregates.assessment, 'home uses the shared projection');
const candidates = buildKnowledgeReviewCandidates(migratedNotes, 'smart', now);
assert.ok(candidates.length > 0);
for (const candidate of candidates) {
  const source = migratedNotes.find(row => row.id === candidate.noteId)!;
  assert.equal(candidate.mastery!.displayLabel, readKnowledgeMastery(source, { mode: 'current', now }).displayLabel);
}

function observation(state: MasteryShadowState, id: string, criterionId: MasteryShadowCriterionId,
  verdict: 'pass' | 'partial' | 'fail' | 'unverifiable' = 'pass',
  patch: Partial<MasteryShadowObservation> = {}): MasteryShadowObservation {
  const layer = MASTERY_SHADOW_CRITERIA.find(row => row.id === criterionId)!.layer;
  return { id, knowledgePointId: state.knowledgePointId, occurredAt: '2026-10-19T08:00:00.000Z', source: 'flow_review',
    coverage: 'assessed', assistance: 'independent', referenceBasis: 'grounded', strength: 'natural',
    results: [{ layer, verdict, criterionIds: [criterionId], userEvidenceIds: [`${id}-user`], referenceIds: [`${id}-ref`],
      criterionResults: [{ id: criterionId, verdict, userEvidenceIds: [`${id}-user`], referenceIds: [`${id}-ref`], referenceBasis: 'grounded' }] }], ...patch };
}
const low = plan.changes.find(row => row.noteId === 'low')!.after;
const lowBefore = structuredClone(low);
const first = applyMasteryShadowObservation(low, observation(low, 'real-pass-1', 'concept_accuracy'));
assert.deepEqual(low, lowBefore, 'new assessment must not mutate its historical seed input');
assert.equal(first.layers.concept.legacySummary, undefined, 'new independent grounded outcome retires the layer estimate');
assert.deepEqual(first.migration!.activeLayers, []);
assert.equal(first.layers.concept.state, 'provisional', 'old low score cannot permanently keep a real pass in needs_review');
assert.equal(first.layers.concept.criteria!.concept_accuracy.independentPasses, 1);
assert.equal(first.layers.concept.criteria!.concept_accuracy.state, 'provisional', 'old score does not add a pass');
for (const [id, verdict, patch] of [
  ['partial', 'partial', {}], ['unknown', 'unverifiable', {}], ['assisted', 'pass', { assistance: 'assisted' }],
  ['incidental', 'pass', { coverage: 'incidental' }], ['unavailable', 'pass', {}],
] as Array<[string, 'pass' | 'partial' | 'unverifiable', Partial<MasteryShadowObservation>]>) {
  const obs = observation(low, `no-retire-${id}`, 'concept_accuracy', verdict, patch);
  if (id === 'unavailable') {
    obs.results[0].criterionResults![0].referenceBasis = 'unavailable';
    obs.results[0].criterionResults![0].referenceIds = [];
  }
  const next = applyMasteryShadowObservation(low, obs);
  assert.deepEqual(next.migration!.activeLayers, ['concept'], `${id} cannot retire historical seed`);
  assert.equal(next.layers.concept.legacySummary!.state, 'needs_review');
}
const high = plan.changes.find(row => row.noteId === 'reasoning')!.after;
const failed = applyMasteryShadowObservation(high, observation(high, 'real-failure', 'judgment_conditions', 'fail'));
assert.deepEqual(failed.migration!.activeLayers, ['concept', 'reasoning'], 'only the evaluated layer retires');
assert.equal(failed.layers.judgment.legacySummary, undefined);
assert.equal(failed.layers.judgment.state, 'needs_review');
assert.equal(failed.layers.judgment.criteria!.judgment_conditions.unresolvedFailures, 1);
const failedView = readKnowledgeMastery(note('reasoning', { dsrState: { ...dsr(90, 3), masteryShadow: failed } }), { now });
assert.equal(failedView.displayLabel, '待复核', 'A real problem must not be hidden by remaining historical estimates');
assert.equal(failedView.nextAction, '复核有据的问题');
assert.equal(high.layers.judgment.legacySummary!.state, 'provisional');
let real = first;
real = applyMasteryShadowObservation(real, observation(real, 'real-pass-2', 'concept_accuracy'));
assert.equal(real.layers.concept.criteria!.concept_accuracy.state, 'confirmed');
assert.equal(real.layers.concept.state, 'provisional', 'repeated definitions still do not confirm concept boundary/application');
for (const criterion of MASTERY_SHADOW_CRITERIA) {
  if (criterion.id === 'concept_accuracy') continue;
  for (let repeat = 1; repeat <= 2; repeat += 1) {
    real = applyMasteryShadowObservation(real, observation(real, `real-${criterion.id}-${repeat}`, criterion.id));
  }
}
assert.ok(MASTERY_SHADOW_LAYERS.every(layer => real.layers[layer].state === 'confirmed'));
assert.equal(readKnowledgeMastery(note('low', { dsrState: { ...dsr(1, 3), masteryShadow: real } }), { now }).confirmed, true,
  'all nine real criteria, not imported score, complete confirmation');
assert.deepEqual(applyMasteryShadowObservation(real, observation(real, 'real-reasoning_consistency-2', 'reasoning_consistency')), real,
  'normal observation replay remains idempotent');
assert.deepEqual(states, frozenStates, 'all verification remains isolated from source states');
console.log('PASS: legacy mastery migration thresholds, invalid/default data, preservation, idempotency, shared projections, seed retirement and real nine-criterion confirmation.');
