import assert from 'node:assert/strict';
import type { NoteItem } from '../src/types';
import { createMasteryShadowState } from '../src/services/masteryShadow/stateMachine';
import { readKnowledgeMastery, summarizeKnowledgeMastery, matchesKnowledgeMasteryFilter } from '../src/services/masteryReadModel';
import { buildReviewSchedule, buildKnowledgeReviewCandidates } from '../src/services/reviewScheduler';
import { getNoteMasteryBand, buildKnowledgeGraphSlice, getProjectMetrics } from '../src/services/knowledgeGraphModel';
import { computeMasteredCount } from '../src/services/learningAbility/aggregator';
import { selectAnchorsAndWeakPoints } from '../src/services/knowledgePointSelector';
import type { MasteryShadowLayerState } from '../src/services/masteryShadow/types';
import { buildHomeViewModel } from '../src/services/homepage/homepageViewModel';
import { setMasteryLayerFixture } from './fixtures/mastery-evidence';

const at = '2026-10-18T08:00:00.000Z';
const now = Date.parse(at);
function sample(id: string, layers?: MasteryShadowLayerState[], history?: number): NoteItem {
  const state = layers ? createMasteryShadowState(id) : undefined;
  if (state) for (const [index, layer] of (['concept', 'judgment', 'reasoning'] as const).entries()) {
    setMasteryLayerFixture(state, layer, layers![index]);
    state.appliedObservationIds = [`event-${id}`];
  }
  return { id, title: id, content: `${id}的知识点参考正文。`, noteType: 'knowledge', tags: [], links: [], backlinks: [],
    dueDates: [], createdAt: at, updatedAt: at, dsrState: { difficulty: 5, stability: 10,
      lastReviewedAt: at, reviewCount: 2, consecutiveCorrect: 1, consecutiveWrong: 0,
      conceptMastery: history, conceptMasterySamples: history == null ? undefined : 3, masteryShadow: state } };
}
const notes = [sample('unassessed'), sample('history', undefined, 99),
  sample('provisional', ['provisional', 'unassessed', 'unassessed'], 98),
  sample('confirmed', ['confirmed', 'confirmed', 'confirmed'], 1),
  sample('verify', ['needs_review', 'confirmed', 'confirmed'], 99),
  sample('concept-only', ['confirmed', 'unassessed', 'unassessed']),
  sample('judgment-only', ['unassessed', 'confirmed', 'unassessed']),
  { ...sample('incomplete', ['confirmed', 'confirmed', 'confirmed']), content: '请对该知识点进行定义描述' },
  { ...sample('memory', ['confirmed', 'confirmed', 'confirmed']), dsrState: { ...sample('memory', ['confirmed', 'confirmed', 'confirmed']).dsrState!, lastReviewedAt: '2025-01-01T00:00:00.000Z' } },
];
const before = JSON.stringify(notes);
const get = (id: string) => notes.find(note => note.id === id)!;
const read = (id: string) => readKnowledgeMastery(get(id), { now });
assert.equal(read('history').confirmed, false, 'old high scores do not become new confirmation');
assert.equal(read('history').band, 'history');
assert.ok(matchesKnowledgeMasteryFilter(read('history'), 'unassessed'), 'historical high scores still belong to unassessed under the new rubric');
assert.ok(matchesKnowledgeMasteryFilter(read('history'), 'history'));
assert.equal(read('confirmed').confirmed, true, 'old low scores cannot override current confirmation');
assert.equal(read('confirmed').targetMet, null);
assert.equal(read('confirmed').targetGap, null, 'unset target remains unknown');
assert.equal(read('concept-only').confirmedLevel, 1);
assert.equal(read('concept-only').confirmed, false);
assert.equal(read('judgment-only').confirmedLevel, 0, 'higher-layer confirmation never backfills a lower layer');
assert.equal(readKnowledgeMastery(get('concept-only'), { requiredLevel: 1, now }).targetMet, true);
assert.equal(readKnowledgeMastery(get('concept-only'), { requiredLevel: 3, now }).targetGap, 2);
assert.equal(read('verify').reviewCategory, 'verify');
assert.equal(read('memory').reviewCategory, 'memory_refresh');
const newFailure = structuredClone(get('confirmed'));
newFailure.dsrState!.masteryShadow!.layers.concept.criteria!.concept_accuracy.unresolvedFailures = 1;
const retainedConfirmation = readKnowledgeMastery(newFailure, { now });
assert.equal(retainedConfirmation.confirmed, true);
assert.equal(retainedConfirmation.reviewCategory, 'verify', 'one new error raises a verification reminder without downgrading confirmation');
assert.ok(matchesKnowledgeMasteryFilter(retainedConfirmation, 'needs_review'));
assert.equal(read('incomplete').confirmed, true, 'content completeness and understanding remain separate');
assert.ok(matchesKnowledgeMasteryFilter(read('incomplete'), 'confirmed'));
assert.ok(matchesKnowledgeMasteryFilter(read('incomplete'), 'content_incomplete'));
assert.equal(readKnowledgeMastery(get('history'), { mode: 'legacy', now }).confirmed, true);
const invalid = structuredClone(get('confirmed'));
invalid.dsrState!.masteryShadow!.knowledgePointId = 'another-note';
const invalidView = readKnowledgeMastery(invalid, { now });
assert.equal(invalidView.confirmed, false);
assert.equal(invalidView.readWarnings.length, 1, 'one malformed record cannot take down the library');

const aggregate = summarizeKnowledgeMastery(notes, { now });
assert.equal(aggregate.confirmedCount, 3);
assert.equal(aggregate.target.unset, notes.length);
assert.equal(aggregate.target.gap, 0);
assert.equal(computeMasteredCount(notes), aggregate.confirmedCount);
const vm = buildHomeViewModel(notes, { ability: {}, cognitiveStyle: {}, learningAbility: {} } as any,
  { version: 1, weeks: [] } as any, '2026-10-18');
assert.equal(vm.masteredCount, aggregate.confirmedCount);
assert.equal(vm.knowledgeMastery.assessment.needsReview, aggregate.assessment.needsReview);
for (const note of notes) {
  const view = readKnowledgeMastery(note, { now });
  assert.equal(getNoteMasteryBand(note), view.band);
  const graph = buildKnowledgeGraphSlice({ notes, focusKnowledgeId: note.id, density: 'sparse' });
  const node = graph.nodes.find(node => node.noteId === note.id)!;
  assert.equal(node.masteryView!.displayLabel, view.displayLabel);
  assert.equal(node.mastery, undefined, 'graph cannot convert states to fake percentages');
}
const candidates = buildKnowledgeReviewCandidates(notes, 'smart', now);
assert.equal(candidates[0].noteId, 'verify');
assert.ok(candidates.every(item => item.noteId !== 'incomplete'));
assert.ok(candidates.every(item => item.conceptMastery === undefined));
const queue = buildReviewSchedule(notes, now).knowledge;
assert.ok(queue.some(item => item.noteId === 'memory'));
assert.ok(!queue.some(item => ['confirmed', 'incomplete'].includes(item.noteId)));
assert.ok(queue.some(item => item.noteId === 'history' && item.mastery?.reviewCategory === 'diagnose'));
const selection = selectAnchorsAndWeakPoints(notes);
assert.ok(!selection.anchors.some(note => note.id === 'history'));
const project: NoteItem = { ...sample('project'), noteType: 'project', links: notes.map(note => note.title) };
assert.equal(getProjectMetrics(project.id, [...notes, project]).masterySummary!.confirmedCount, aggregate.confirmedCount);
assert.equal(JSON.stringify(notes), before, 'all reads are pure');
const previousMode = process.env.VITE_MASTERY_READ_MODE;
try {
  process.env.VITE_MASTERY_READ_MODE = 'legacy';
  const legacyQueue = buildKnowledgeReviewCandidates(notes, 'smart', now);
  assert.ok(legacyQueue.every(item => !item.mastery), 'rollback restores legacy scheduling instead of mixing policies');
  assert.equal(getNoteMasteryBand(get('history')), 'mastered');
} finally {
  if (previousMode === undefined) delete process.env.VITE_MASTERY_READ_MODE;
  else process.env.VITE_MASTERY_READ_MODE = previousMode;
}
console.log('PASS: graph, review candidates and statistics agree; unknown targets, legacy isolation, independent content state and rollback verified.');
