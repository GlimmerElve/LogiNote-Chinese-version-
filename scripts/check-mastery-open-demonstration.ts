import assert from 'node:assert/strict';
import { buildMasteryShadowEvaluationRequest, parseMasteryShadowEvaluation, type MasteryShadowEvaluationInput } from '../src/services/masteryShadow/evaluator';
import { applyMasteryShadowObservations } from '../src/services/masteryShadow/stateMachine';
import { masteryBaselineFixture, masteryComparisonFixture } from './fixtures/mastery-baselines';

globalThis.fetch = async () => assert.fail('No cloud or production storage');
for (const source of ['flow_review', 'socratic_review'] as const) {
  const input: MasteryShadowEvaluationInput = { evaluationId: `isolated:${source}`, knowledgePointId: 'isolated-note',
    knowledgePointTitle: '观察效应', occurredAt: '2026-10-19T00:00:00Z', source, assistance: 'independent', strength: 'natural',
    task: { evaluationMode: source === 'flow_review' ? 'natural_recall' : 'direct_test', referenceContract: 'criterion-scope-v3',
      confirmationPolicy: 'open-demonstration-v1', responseType: 'open', prompt: '用自己的话说明含义。', requiredLayers: ['concept'],
      criterionIds: ['concept_accuracy', 'concept_boundary'] }, answer: '意识到受到观察可能改变行为，不代表干预本身有效。',
    references: [{ id: 'R1', tier: 3, sourceId: 'isolated-note', sourceRole: 'primary', sourceLabel: '观察效应',
      quote: '意识到受到观察可能改变行为，不代表干预本身有效。', layers: ['concept'], criterionIds: ['concept_accuracy', 'concept_boundary'] }] };
  function packet(config = input, verdict = 'pass', coverage = 'assessed') {
    const payload = JSON.parse(buildMasteryShadowEvaluationRequest(config).userInput);
    return { protocol: 'mastery-shadow-evaluator-v1', evaluationId: config.evaluationId, knowledgePointId: config.knowledgePointId,
      coverage: { concept: coverage }, evidence: [{ id: 'E1', quote: config.answer }], baselines: masteryBaselineFixture(payload),
      criteria: [{ id: 'concept_accuracy', state: verdict, evidenceIds: ['E1'], referenceIds: ['R1'], reason: 'Synthetic verdict only.',
        ...(verdict === 'partial' ? { comparison: masteryComparisonFixture(payload, 'concept_accuracy', ['E1']) } : {}) },
      { id: 'concept_boundary', state: 'not_applicable', evidenceIds: [], referenceIds: [], reason: 'No boundary observation in this fixture.' }] };
  }
  const read = (config = input, raw = packet(config)) => {
    const evaluation = parseMasteryShadowEvaluation(raw, config);
    return { evaluation, state: applyMasteryShadowObservations(undefined, evaluation.observations) };
  };
  assert.match(buildMasteryShadowEvaluationRequest(input).systemPrompt, /开放展示规则/);
  const first = read();
  assert.equal(first.state.layers.concept.criteria!.concept_accuracy.state, 'confirmed');
  assert.equal(first.state.layers.concept.criteria!.concept_accuracy.independentPasses, 1);
  assert.equal(first.state.layers.concept.criteria!.concept_boundary.state, 'unassessed');
  assert.equal(first.state.layers.concept.state, 'provisional', 'a confirmed item never certifies its whole layer');
  assert.equal(first.state.layers.judgment.state, 'unassessed');
  assert.equal(first.evaluation.observations[0].strength, 'natural', 'never elevate whole observation or failures');
  const revalidated = parseMasteryShadowEvaluation(JSON.parse(JSON.stringify(first.evaluation)), input);
  assert.deepEqual(applyMasteryShadowObservations(first.state, revalidated.observations), first.state);
  const legacy = structuredClone(input); delete legacy.task.confirmationPolicy;
  assert.equal(read(legacy).state.layers.concept.criteria!.concept_accuracy.state, 'provisional', 'historical receipts keep their original policy');
  const assisted = read({ ...input, assistance: 'assisted' }).state.layers.concept.criteria!.concept_accuracy;
  assert.equal(assisted.state, 'provisional'); assert.equal(assisted.independentPasses, 0);
  assert.equal(read({ ...input, task: { ...input.task, responseType: 'choice' } }).state.layers.concept.criteria!.concept_accuracy.state, 'provisional');
  assert.equal(read(input, packet(input, 'partial')).state.layers.concept.criteria!.concept_accuracy.state, 'unassessed');
  assert.equal(read(input, packet(input, 'not_observed')).state.layers.concept.criteria!.concept_accuracy.state, 'unassessed');
  const unbound = packet(); unbound.evidence[0].quote = 'Not in user answer';
  assert.equal(read(input, unbound).state.layers.concept.criteria!.concept_accuracy.state, 'unassessed');
  const missing = packet(); missing.baselines[0].referenceQuotes[0].quote = 'Not in reference';
  assert.equal(read(input, missing).state.layers.concept.criteria!.concept_accuracy.state, 'unassessed');
  if (source === 'flow_review') {
    const conflict = read(input, packet(input, 'pass', 'incidental'));
    assert.equal(conflict.state.layers.concept.criteria!.concept_accuracy.state, 'confirmed', 'valid item evidence survives a contradictory layer declaration');
    assert.equal(conflict.evaluation.modelCoverage?.concept, 'incidental');
    assert.match(conflict.evaluation.diagnostics.join('\n'), /coverage conflict/);
  }
}
console.log('PASS flow/review per-item open demonstration once; other criteria/layers untouched; assisted/choice/partial/unverified held; old policy, save revalidation and idempotence. Synthetic contracts only.');
