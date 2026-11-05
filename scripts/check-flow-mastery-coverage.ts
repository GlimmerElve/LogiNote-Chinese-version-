import assert from 'node:assert/strict';
import { createFlowMasteryFixture } from './fixtures/flow-mastery';
import { masteryBaselineFixture, masteryComparisonFixture } from './fixtures/mastery-baselines';
import { evaluateFlowKnowledgeMastery, prepareFlowMasteryOutcome } from '../src/services/masteryShadow/flow';
import { parseMasteryShadowEvaluation } from '../src/services/masteryShadow/evaluator';

globalThis.fetch = async () => assert.fail('No network or production data');
const fixture = createFlowMasteryFixture();
const original = JSON.stringify(fixture.notes);
async function evaluate(mode = 'all') {
  return evaluateFlowKnowledgeMastery({ sessionId: fixture.session.id, projectNoteId: fixture.session.noteId,
    rawText: fixture.session.incrementalText!, observedAt: fixture.session.endedAt,
    candidates: fixture.candidates.slice(0, 1), notes: fixture.notes }, {
    referenceReaders: { searchNotes: async () => [], searchTextbooks: async () => [], searchDocuments: async () => [] },
    call: async ({ userInput, systemPrompt }) => {
      assert.match(systemPrompt, /命中概念不能停止判断\/推理检查/);
      const input = JSON.parse(userInput);
      assert.equal(input.criteria.length, 9);
      assert.deepEqual(input.task.requiredLayers, ['concept', 'judgment', 'reasoning']);
      const baselines = masteryBaselineFixture(input);
      if (mode === 'bad_reference') baselines.find(row => row.id === 'judgment_conditions')!.referenceQuotes[0].quote = '不存在的原文';
      const onePerLayer = ['concept_accuracy', 'judgment_conditions', 'reasoning_relevance'];
      return { protocol: 'mastery-shadow-evaluator-v1', evaluationId: input.evaluationId, knowledgePointId: input.knowledgePointId,
        ...(mode === 'missing_coverage' ? {} : { coverage: { concept: 'assessed', judgment: 'not_tested', reasoning: 'incidental' } }),
        baselines, evidence: [{ id: 'E1', quote: mode === 'bad_evidence' ? '不是用户原文' : input.answer }],
        criteria: input.criteria.map((criterion: any) => {
          const verdict = mode === 'all' || mode === 'missing_coverage' || mode === 'bad_evidence' ? 'pass'
            : mode === 'bad_reference' ? criterion.id === 'judgment_conditions' ? 'pass' : 'not_observed'
              : onePerLayer.includes(criterion.id) ? mode === 'partial' ? 'partial' : mode === 'fail' ? 'fail' : 'pass' : 'not_observed';
          return { id: criterion.id, state: verdict, evidenceIds: verdict === 'not_observed' ? [] : ['E1'], reason: 'Synthetic transport only.',
            ...(['partial', 'fail'].includes(verdict) ? { comparison: masteryComparisonFixture(input, criterion.id, ['E1']) } : {}) };
        }), summary: 'Synthetic, not a semantic-quality proof.' };
    },
  });
}
const batch = await evaluate(), saved = prepareFlowMasteryOutcome(fixture.notes, batch);
const id = batch.items[0].knowledgePointId;
const state = saved.notes.find(note => note.id === id)!.dsrState!.masteryShadow!;
for (const layer of ['concept', 'judgment', 'reasoning'] as const) assert.equal(state.layers[layer].state, 'confirmed');
assert.equal(saved.batch.items[0].evaluation!.modelCoverage!.judgment, 'not_tested');
assert.equal(saved.batch.items[0].evaluation!.modelCoverage!.reasoning, 'incidental');
assert.ok(saved.batch.items[0].evaluation!.diagnostics.some(row => row.includes('judgment: not_tested -> assessed')));
assert.equal(saved.results[0].shadow!.layers.judgment.coverage, 'assessed');
const restored = JSON.parse(JSON.stringify(saved.batch));
const rechecked = parseMasteryShadowEvaluation(restored.items[0].evaluation, restored.items[0].input);
assert.deepEqual(rechecked.modelCoverage, saved.batch.items[0].evaluation!.modelCoverage);
assert.deepEqual(rechecked.diagnostics, saved.batch.items[0].evaluation!.diagnostics, 'original conflict stays auditable on revalidation');
assert.deepEqual(prepareFlowMasteryOutcome(saved.notes, restored).notes, saved.notes, 'save replay cannot add evidence');
const sparse = prepareFlowMasteryOutcome(fixture.notes, await evaluate('sparse'));
const sparseState = sparse.notes.find(note => note.id === id)!.dsrState!.masteryShadow!;
for (const [layer, criterion] of [['concept', 'concept_accuracy'], ['judgment', 'judgment_conditions'], ['reasoning', 'reasoning_relevance']] as const) {
  assert.equal(sparseState.layers[layer].state, 'provisional', 'only actual valid items confirm, not the whole layer');
  assert.equal(sparseState.layers[layer].criteria![criterion].state, 'confirmed');
  assert.equal(Object.values(sparseState.layers[layer].criteria!).filter(row => row.state === 'confirmed').length, 1);
}
for (const mode of ['bad_evidence', 'bad_reference']) {
  const held = prepareFlowMasteryOutcome(fixture.notes, await evaluate(mode));
  assert.equal(held.notes.find(note => note.id === id)!.dsrState!.masteryShadow, undefined, 'invalid proof is never rescued by layer reconciliation');
}
const missing = await evaluate('missing_coverage');
assert.equal(missing.items[0].evaluation!.coverage.judgment, 'assessed');
assert.equal(missing.items[0].evaluation!.modelCoverage!.judgment, 'missing');
for (const mode of ['partial', 'fail']) {
  const evaluated = await evaluate(mode), outcome = prepareFlowMasteryOutcome(fixture.notes, evaluated);
  assert.equal(evaluated.items[0].evaluation!.coverage.judgment, 'assessed');
  const criterion = outcome.notes.find(note => note.id === id)!.dsrState!.masteryShadow!.layers.judgment.criteria!.judgment_conditions;
  assert.equal(criterion.state, mode === 'fail' ? 'needs_review' : 'unassessed', 'coverage correction does not turn partial/fail into pass');
}
assert.equal(JSON.stringify(fixture.notes), original);
console.log('PASS actual flow evaluate/save/display: 9 independent items; positive and negative coverage conflicts audited; missing coverage recovered only with validated proof; invalid refs/evidence held; per-item updates, save/replay and no original writes. Synthetic only.');
