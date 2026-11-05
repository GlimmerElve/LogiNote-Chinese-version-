import assert from 'node:assert/strict';
import { createFlowMasteryFixture } from './fixtures/flow-mastery';
import { masteryBaselineFixture } from './fixtures/mastery-baselines';
import { evaluateFlowKnowledgeMastery, prepareFlowMasteryOutcome } from '../src/services/masteryShadow/flow';

globalThis.fetch = async () => assert.fail('No network in save-time verification tests');
const fixture = createFlowMasteryFixture();
const batch = await evaluateFlowKnowledgeMastery({ sessionId: fixture.session.id, projectNoteId: fixture.session.noteId,
  observedAt: fixture.session.endedAt, rawText: fixture.session.incrementalText!, candidates: fixture.candidates.slice(0, 1),
  notes: fixture.notes }, { referenceReaders: { searchNotes: async () => [], searchTextbooks: async () => [], searchDocuments: async () => [] },
  call: async ({ userInput }) => {
    const input = JSON.parse(userInput);
    return { protocol: 'mastery-shadow-evaluator-v1', evaluationId: input.evaluationId, knowledgePointId: input.knowledgePointId,
      baselines: masteryBaselineFixture(input), evidence: [{ id: 'E1', quote: input.answer }],
      coverage: { concept: 'assessed', judgment: 'assessed', reasoning: 'assessed' },
      criteria: input.criteria.map((row: { id: string }) => ({ id: row.id, state: 'pass', evidenceIds: ['E1'], reason: 'Mock transport only.' })),
      summary: 'Mock transport only.' };
  } });
assert.equal(batch.schemaVersion, 2);
assert.ok(batch.items[0].input);
const id = batch.items[0].knowledgePointId;
const layers = (notes: typeof fixture.notes) => notes.find(note => note.id === id)!.dsrState?.masteryShadow?.layers;
const good = prepareFlowMasteryOutcome(fixture.notes, batch);
assert.ok(layers(good.notes));
assert.equal(JSON.stringify(fixture.notes), JSON.stringify(createFlowMasteryFixture().notes), 'Pure write preparation');
for (const mutate of [
  (value: typeof batch) => { delete value.items[0].input; },
  (value: typeof batch) => { value.items[0].input!.answer = '别的复盘原文'; },
  (value: typeof batch) => { value.items[0].input!.task.referenceContract = 'criterion-baseline-v2'; },
]) {
  const changed = structuredClone(batch); mutate(changed);
  const outcome = prepareFlowMasteryOutcome(fixture.notes, changed);
  assert.equal(layers(outcome.notes), undefined);
  assert.ok(outcome.batch.items[0].error);
  assert.equal(outcome.batch.items[0].evaluation, undefined);
}
const forged = structuredClone(batch);
forged.items[0].evaluation!.baselines!.forEach(row => { row.applicability = 'out_of_scope'; });
// Keep the precomputed observations as pass: the writer must regenerate them from guarded criteria.
assert.equal(forged.items[0].evaluation!.observations[0].results[0].verdict, 'pass');
const guarded = prepareFlowMasteryOutcome(fixture.notes, forged);
assert.equal(layers(guarded.notes), undefined);
assert.ok(guarded.batch.items[0].evaluation!.criteria.every(row => row.state === 'unverifiable'));
assert.ok(guarded.batch.items[0].evaluation!.observations.every(row => row.results[0].verdict === 'unverifiable'));
const replay = prepareFlowMasteryOutcome(good.notes, batch);
assert.deepEqual(replay.notes, good.notes);
console.log('PASS new flow receipts revalidate scope/answer bindings, ignore forged observations, preserve other state and remain idempotent. No cloud or formal writes.');
