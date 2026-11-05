import assert from 'node:assert/strict';
import type { KnowledgePointDsr, NoteItem, UserNoteState } from '../src/types';
import { createMasteryShadowState } from '../src/services/masteryShadow/stateMachine';
import type { MasteryShadowLayerState } from '../src/services/masteryShadow/types';
import { planLegacyMasteryMigration } from '../src/services/masteryShadow/legacyMigration';
import { readKnowledgeMastery } from '../src/services/masteryReadModel';
import { buildKnowledgeReviewCandidates, buildReviewSchedule, summarizeKnowledgeReviewPool } from '../src/services/reviewScheduler';
import { setMasteryLayerFixture } from './fixtures/mastery-evidence';

// Synthetic data and pure functions only: no file, database, LLM, index or profile APIs.
const at = '2026-10-18T08:00:00.000Z';
const now = Date.parse(at);
function memory(score?: number): KnowledgePointDsr {
  return { difficulty: 5, stability: 10, lastReviewedAt: at, reviewCount: 3,
    consecutiveCorrect: 2, consecutiveWrong: 0,
    ...(score === undefined ? {} : { conceptMastery: score, conceptMasterySamples: 3 }) };
}
function knowledge(id: string, layers?: MasteryShadowLayerState[], score?: number): NoteItem {
  const masteryShadow = layers ? createMasteryShadowState(id) : undefined;
  if (masteryShadow) {
    for (const [index, layer] of (['concept', 'judgment', 'reasoning'] as const).entries()) {
      setMasteryLayerFixture(masteryShadow, layer, layers![index]);
    }
    masteryShadow.appliedObservationIds = [`synthetic-${id}`];
  }
  return { id, title: id, noteType: 'knowledge', content: `${id}的定义、条件和应用构成可用于复习的参考正文。`,
    tags: [], links: [], backlinks: [], dueDates: [], createdAt: at, updatedAt: at,
    parentId: id.startsWith('other-') ? 'project-other' : 'project-current',
    dsrState: { ...memory(score), ...(masteryShadow ? { masteryShadow } : {}) } };
}
function migrated(id: string, score: number): NoteItem {
  const note = knowledge(id, undefined, score);
  const states: Record<string, UserNoteState> = { [id]: { dsrState: note.dsrState } };
  const plan = planLegacyMasteryMigration([note], states, { migrationId: 'synthetic-pool-migration', migratedAt: at });
  assert.equal(plan.changes.length, 1);
  return { ...note, dsrState: { ...note.dsrState!, masteryShadow: plan.changes[0].after } };
}
function freezeTree(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freezeTree(child);
  Object.freeze(value);
}
function ids(items: Array<{ noteId: string }>): string[] { return items.map(item => item.noteId); }
function sorted(values: string[]): string[] { return [...values].sort(); }

const notes: NoteItem[] = [
  knowledge('ready-unassessed'),
  { ...knowledge('ready-no-memory'), dsrState: undefined },
  knowledge('new-problem-old-high', ['needs_review', 'confirmed', 'confirmed'], 99),
  knowledge('new-provisional-old-high', ['provisional', 'unassessed', 'unassessed'], 98),
  knowledge('new-stable-old-low', ['confirmed', 'confirmed', 'confirmed'], 1),
  knowledge('concept-confirmed-only', ['confirmed', 'unassessed', 'unassessed']),
  { ...knowledge('other-memory-refresh', ['confirmed', 'confirmed', 'confirmed']), dsrState: {
    ...knowledge('other-memory-refresh', ['confirmed', 'confirmed', 'confirmed']).dsrState!,
    lastReviewedAt: '2025-01-01T00:00:00.000Z',
  } },
  knowledge('other-ready-unassessed'),
  knowledge('legacy-only-low', undefined, 59),
  knowledge('legacy-only-high', undefined, 99),
  migrated('migrated-low', 54.9),
  migrated('migrated-concept', 55),
  migrated('migrated-judgment', 75),
  migrated('migrated-reasoning', 90),
  { ...knowledge('placeholder', ['needs_review', 'unassessed', 'unassessed']), content: '请对该知识点进行定义描述' },
  { ...knowledge('blank', ['provisional', 'unassessed', 'unassessed']), content: '  \n\t' },
  { ...knowledge('empty-html'), content: '<p><br></p><p>&nbsp;</p>' },
  { ...knowledge('project-current'), noteType: 'project', links: ['ready-unassessed', 'new-problem-old-high'] },
  { ...knowledge('project-other'), noteType: 'project', links: ['other-memory-refresh', 'other-ready-unassessed'] },
];
const before = JSON.stringify(notes);
freezeTree(notes);
const previousMode = process.env.VITE_MASTERY_READ_MODE;
const originalRandom = Math.random;
try {
  process.env.VITE_MASTERY_READ_MODE = 'current';
  const view = (id: string) => readKnowledgeMastery(notes.find(note => note.id === id)!, { now });
  assert.equal(view('ready-unassessed').reviewCategory, 'diagnose');
  assert.equal(view('new-problem-old-high').reviewCategory, 'verify');
  assert.equal(view('new-provisional-old-high').reviewCategory, 'confirm');
  assert.equal(view('new-stable-old-low').reviewCategory, 'stable');
  assert.equal(view('other-memory-refresh').reviewCategory, 'memory_refresh');
  assert.equal(view('migrated-low').reviewCategory, 'verify');
  for (const id of ['migrated-concept', 'migrated-judgment', 'migrated-reasoning']) {
    assert.equal(view(id).reviewCategory, 'confirm', 'high historical estimates are not new confirmations');
  }
  assert.equal(view('concept-confirmed-only').reviewCategory, 'diagnose', 'the scheduler does not invent a target');
  assert.equal(readKnowledgeMastery(notes.find(note => note.id === 'concept-confirmed-only')!, { requiredLevel: 3, now })
    .reviewCategory, 'strengthen', 'explicit target gaps retain the existing strengthen category');

  const eligibleIds = notes.filter(note => note.noteType === 'knowledge'
    && readKnowledgeMastery(note, { now }).contentStatus === 'ready').map(note => note.id);
  const expectedWeak = ['new-problem-old-high', 'new-provisional-old-high', 'migrated-low',
    'migrated-concept', 'migrated-judgment', 'migrated-reasoning'];
  const smart = buildKnowledgeReviewCandidates(notes, 'smart', now);
  const weak = buildKnowledgeReviewCandidates(notes, 'weak', now);
  assert.deepEqual(sorted(ids(smart)), sorted(eligibleIds), 'smart uses the complete ready pool, not just due/current-project notes');
  assert.deepEqual(sorted(ids(weak)), sorted(expectedWeak), 'weak is an independent verify/confirm/strengthen subset');
  assert.ok(weak.length < smart.length, 'weak and smart must not collapse back to the same pool');
  assert.ok(weak.every(target => ['verify', 'confirm', 'strengthen'].includes(target.mastery!.reviewCategory)));
  for (const id of ['ready-unassessed', 'new-stable-old-low', 'other-memory-refresh', 'legacy-only-low',
    'legacy-only-high', 'placeholder', 'blank', 'empty-html']) {
    assert.ok(!ids(weak).includes(id), `${id} must not be mistaken for current weakness`);
  }
  assert.ok(ids(smart).includes('new-stable-old-low'));
  assert.ok(!ids(buildReviewSchedule(notes, now).knowledge).includes('new-stable-old-low'),
    'a non-due stable note is still eligible for smart/random exploration');
  assert.ok(ids(smart).includes('other-ready-unassessed'), 'another project is not excluded');
  const oldRanking = [...smart].sort((a, b) => b.riskScore - a.riskScore || a.noteTitle.localeCompare(b.noteTitle));
  assert.deepEqual(ids(smart), ids(oldRanking), 'smart ranking remains priority/risk then title');
  assert.deepEqual(ids(weak), ids(smart.filter(target => expectedWeak.includes(target.noteId))),
    'weak preserves the existing current-mode priority ordering');
  assert.equal(smart[0].mastery!.reviewCategory, 'verify');

  Math.random = () => { throw new Error('statistics must not consume or reshuffle randomness'); };
  const summary = summarizeKnowledgeReviewPool(notes, now);
  assert.deepEqual(summary, { eligibleCount: smart.length, weakCount: weak.length, randomCount: smart.length });
  assert.deepEqual(summarizeKnowledgeReviewPool([], now), { eligibleCount: 0, weakCount: 0, randomCount: 0 });
  assert.deepEqual(buildKnowledgeReviewCandidates([], 'smart', now), []);
  assert.deepEqual(buildKnowledgeReviewCandidates([], 'weak', now), []);
  assert.deepEqual(buildKnowledgeReviewCandidates([], 'random', now), []);

  for (const value of [0, 0.25, 0.5, 0.999999]) {
    let calls = 0;
    const random = buildKnowledgeReviewCandidates(notes, 'random', now, () => { calls += 1; return value; });
    assert.equal(calls, Math.max(0, smart.length - 1), 'Fisher-Yates uses exactly one draw per remaining position');
    assert.deepEqual(sorted(ids(random)), sorted(eligibleIds), 'random must not lose, duplicate or weight-filter candidates');
    assert.equal(new Set(ids(random)).size, random.length);
    for (const id of ['new-stable-old-low', 'other-memory-refresh', 'ready-unassessed', 'other-ready-unassessed']) {
      assert.ok(ids(random).includes(id), `${id} remains in random even when stable, cross-project or unassessed`);
    }
  }
  // Enumerate all six equally likely Fisher-Yates draw combinations for three
  // notes with different mastery/risk. Each note must lead exactly two orders.
  const randomSample = notes.filter(note => ['new-problem-old-high', 'new-stable-old-low', 'other-memory-refresh'].includes(note.id));
  const permutations = new Set<string>();
  const firstCounts = new Map<string, number>();
  for (let first = 0; first < 3; first += 1) for (let second = 0; second < 2; second += 1) {
    const draws = [(first + 0.5) / 3, (second + 0.5) / 2];
    const result = buildKnowledgeReviewCandidates(randomSample, 'random', now, () => draws.shift()!);
    permutations.add(ids(result).join(','));
    firstCounts.set(result[0].noteId, (firstCounts.get(result[0].noteId) || 0) + 1);
    assert.equal(draws.length, 0);
  }
  assert.equal(permutations.size, 6, 'random is an unweighted permutation, not a priority-weighted selector');
  assert.deepEqual([...firstCounts.values()], [2, 2, 2]);

  process.env.VITE_MASTERY_READ_MODE = 'legacy';
  const legacySmart = buildKnowledgeReviewCandidates(notes, 'smart', now);
  const legacyWeak = buildKnowledgeReviewCandidates(notes, 'weak', now);
  const expectedLegacyWeak = legacySmart.filter(target => (target.conceptMastery ?? 50) < 60);
  assert.ok(legacySmart.every(target => !target.mastery), 'legacy rollback does not accidentally read new-state categories');
  assert.deepEqual(sorted(ids(legacyWeak)), sorted(ids(expectedLegacyWeak)), 'legacy weak predicate stays aligned with the old <60 UI');
  assert.ok(ids(legacyWeak).includes('new-stable-old-low'), 'rollback intentionally uses its old low score, not new stable state');
  assert.ok(!ids(legacyWeak).includes('new-problem-old-high'), 'rollback intentionally ignores a new problem when the old score is high');
  assert.ok(ids(legacyWeak).includes('legacy-only-low'));
  assert.ok(!ids(legacyWeak).includes('legacy-only-high'));
  assert.ok(ids(legacyWeak).includes('ready-no-memory'), 'legacy unknown score keeps the existing 50-point fallback');
  for (let index = 1; index < legacyWeak.length; index += 1) {
    assert.ok((legacyWeak[index - 1].conceptMastery ?? 50) <= (legacyWeak[index].conceptMastery ?? 50),
      'legacy weak ordering remains lowest old score first');
  }
  assert.deepEqual(summarizeKnowledgeReviewPool(notes, now), {
    eligibleCount: legacySmart.length, weakCount: legacyWeak.length, randomCount: legacySmart.length,
  });
  assert.equal(JSON.stringify(notes), before, 'selection and statistics never mutate notes, state, history or project links');
  console.log(`PASS: review smart/weak/random pools, shared statistics, unweighted permutations, content/cross-project scope, migration estimates, legacy rollback and purity (${smart.length} eligible / ${weak.length} weak).`);
} finally {
  Math.random = originalRandom;
  if (previousMode === undefined) delete process.env.VITE_MASTERY_READ_MODE;
  else process.env.VITE_MASTERY_READ_MODE = previousMode;
}
