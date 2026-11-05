import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFlowMasteryFixture } from './fixtures/flow-mastery';
import { evaluateFlowKnowledgeMastery, prepareFlowMasteryOutcome } from '../src/services/masteryShadow/flow';
import type { MasteryShadowEvaluationInput } from '../src/services/masteryShadow/evaluator';
import { MASTERY_SHADOW_CRITERIA } from '../src/services/masteryShadow/rubric';
import { parseMasteryShadowEvaluation, buildMasteryShadowEvaluationRequest } from '../src/services/masteryShadow/evaluator';
import { saveFlowReviewRecord } from '../src/services/textbook/reviewRecordStore';
import { saveVaultSnapshot } from '../src/electron/vaultSnapshot';
import { deserializeUserStateFile, mergeNote } from '../src/services/userStateService';
import { deserializeVault } from '../src/services/vaultFsService';
import { adaptShadowRecordToFlowV2 } from '../src/services/flowAnalysis/productionV2';
import { createFlowResultPreview } from './fixtures/flow-result-v2-preview';
import { personalNotePatches } from '../src/services/personalNoteState';
import { masteryBaselineFixture, masteryComparisonFixture } from './fixtures/mastery-baselines';

const fixture = createFlowMasteryFixture();
const baseline = structuredClone(fixture.notes);
let active = 0, peak = 0, calls = 0;
const retrievalQueries: string[] = [];
const referenceReaders = { searchTextbooks: async (query: string) => { retrievalQueries.push(query); return []; }, searchDocuments: async () => [] };
const call = async ({ userInput }: { userInput: string }) => {
  active++; peak = Math.max(peak, active); calls++;
  try {
    const input = JSON.parse(userInput) as MasteryShadowEvaluationInput & { criteria: typeof MASTERY_SHADOW_CRITERIA };
    assert.ok(input.references.length, 'managed textbook passages must be retrieved');
    assert.equal(input.task.evaluationMode, 'natural_recall');
    const substantive = input.knowledgePointTitle === '确认偏误';
    const mentioned = input.knowledgePointTitle === '锚定效应';
    const quote = substantive ? input.answer.split('至于')[0] : mentioned ? '至于锚定效应，我只听过名称，今天还没有展开学习。' : input.answer;
    return { protocol: 'mastery-shadow-evaluator-v1', evaluationId: input.evaluationId,
      knowledgePointId: input.knowledgePointId, evidence: [{ id: 'E1', quote }], baselines: masteryBaselineFixture(input),
      coverage: { concept: substantive ? 'assessed' : mentioned ? 'incidental' : 'not_tested',
        judgment: substantive ? 'assessed' : 'not_tested', reasoning: substantive ? 'assessed' : 'not_tested' },
      criteria: input.criteria.map(c => ({ id: c.id,
        state: substantive ? 'pass' : mentioned && c.layer === 'concept' ? 'partial' : 'not_observed',
        comparison: mentioned && c.layer === 'concept' ? masteryComparisonFixture(input, c.id, ['E1']) : undefined,
        evidenceIds: ['E1'], referenceIds: input.references.filter(r => r.criterionIds?.includes(c.id)).map(r => r.id),
        referenceQuotes: input.references.filter(r => r.criterionIds?.includes(c.id)).slice(0, 3)
          .map(r => ({ referenceId: r.id, quote: r.quote.slice(0, 180) })),
        reason: substantive ? '原话展示了本知识点的对应理解。' : '本次没有展开，不作为错误。' })),
      summary: substantive ? '概念、判断和推理有据。' : '本次未展开。' };
  } finally { active--; }
};
const evaluate = (f: typeof fixture) => evaluateFlowKnowledgeMastery({ sessionId: f.session.id,
  projectNoteId: f.session.noteId, rawText: f.session.incrementalText!, observedAt: f.session.endedAt,
  candidates: [...f.candidates, { ...f.candidates[0], id: 'duplicate' }], notes: f.notes }, { call, referenceReaders });

const batch = await evaluate(fixture);
assert.equal(batch.items.length, 3, 'same knowledge note is evaluated once');
assert.equal(calls, 3);
assert.equal(new Set(retrievalQueries).size, 27, 'Nine neutral rubric queries for each of three knowledge targets');
for (const item of batch.items) {
  assert.ok(item.referenceSelection);
  assert.ok(item.references.length <= 12 && item.references.every(reference => reference.quote.length <= 1400));
  assert.ok(item.references.reduce((sum, reference) => sum + reference.quote.length, 0) <= 6000);
  assert.ok(JSON.stringify(item.references).length <= 10000, 'actual evaluation references include metadata in the hard budget');
  assert.ok(item.references.every(reference => reference.criterionIds?.length), 'Every flow reference declares eligible criteria');
  assert.equal(new Set(item.references.map(reference => `${reference.sourceId}:${reference.locator}:${reference.quote}`)).size,
    item.references.length, 'Identical source passages are sent once with merged criterion eligibility');
}
assert.ok(peak <= 2);
assert.deepEqual(fixture.notes, baseline, 'evaluation does not mutate notes');
const outcome = prepareFlowMasteryOutcome(fixture.notes, batch);
const displayed = outcome.results.find(result => result.name === '确认偏误')!.shadow!.layers.concept.assessment!;
assert.equal(displayed.criteria.length, 3, 'display preserves three separate concept criteria');
assert.equal(displayed.criteria[0].label, '概念含义');
assert.ok(displayed.evidence.length > 0 && displayed.references.length > 0, 'actual quoted evidence remains available to the result page');
assert.ok(displayed.evidence.every(evidence => batch.items[0].evaluation!.evidence.some(source => source.id === evidence.id && source.quote === evidence.quote)));
assert.ok(displayed.references.every(reference => batch.items[0].references.some(source => source.id === reference.id && source.quote === reference.quote)));
assert.ok(personalNotePatches(fixture.notes, outcome.notes), 'mastery updates use personal-state saves without rebuilding textbook indexes');
assert.equal(outcome.notes.find(n => n.id === 'kp-confirmation')!.dsrState!.masteryShadow!.layers.concept.state, 'confirmed', 'all three sufficiently demonstrated concept items can confirm in one recap');
const anchoringBefore = baseline.find(n => n.id === 'kp-anchoring')!, anchoringAfter = outcome.notes.find(n => n.id === 'kp-anchoring')!;
// This mock deliberately emits a contradictory, grounded partial + incidental.
// New policy records the validated partial but never upgrades/downgrades it.
assert.deepEqual(Object.values(anchoringAfter.dsrState!.masteryShadow!.layers.concept.criteria!).map(row => row.state),
  Object.values(anchoringBefore.dsrState!.masteryShadow!.layers.concept.criteria!).map(row => row.state));
for (const field of ['difficulty', 'stability', 'lastReviewedAt', 'reviewCount'] as const)
  assert.equal(anchoringAfter.dsrState![field], anchoringBefore.dsrState![field], 'partial evidence never manufactures scheduling or mastery changes');
assert.ok(batch.items.find(item => item.knowledgePointId === anchoringAfter.id)!.evaluation!.diagnostics.some(row => row.includes('coverage conflict')));
assert.deepEqual(outcome.notes.find(n => n.id === 'kp-loss'), baseline.find(n => n.id === 'kp-loss'), 'uncovered knowledge remains untouched');
assert.equal(outcome.notes.find(n => n.id === 'kp-confirmation')!.dsrState!.conceptMastery, 72);
assert.equal(outcome.notes.find(n => n.id === 'kp-confirmation')!.dsrState!.reviewCount, 3);
assert.equal(prepareFlowMasteryOutcome(outcome.notes, batch).duplicate, true);
assert.deepEqual(prepareFlowMasteryOutcome(outcome.notes, batch).notes, outcome.notes);
const resaved = saveFlowReviewRecord(outcome.notes[0], fixture.session, 'pending_analysis');
assert.ok(resaved.learningReviewRecords![0].masteryAssessment, 'reopening same review preserves its assessment receipt');
const withPriorText = { ...fixture.session, restateText: `旧复述不应再次评价。\n${fixture.session.incrementalText}` };
const incrementalNotes = fixture.notes.map(note => note.id === fixture.session.noteId
  ? saveFlowReviewRecord({ ...note, learningReviewRecords: [] }, withPriorText, 'pending_analysis') : note);
assert.doesNotThrow(() => prepareFlowMasteryOutcome(incrementalNotes, batch), 'saved full text and evaluated increment can have different coordinates');

const later = createFlowMasteryFixture('flow-mastery-fixture-2', outcome.notes);
const second = prepareFlowMasteryOutcome(later.notes, await evaluate(later));
assert.equal(second.notes.find(n => n.id === 'kp-confirmation')!.dsrState!.masteryShadow!.layers.concept.state, 'confirmed', 'later recap preserves valid confirmation');
assert.throws(() => prepareFlowMasteryOutcome(fixture.notes, { ...batch, rawTextKey: 'wrong' }), /不匹配/u);
assert.throws(() => prepareFlowMasteryOutcome(fixture.notes, { ...batch, items: [batch.items[0], batch.items[0]] }), /重复/u);
const deleted = fixture.notes.filter(n => n.id !== 'kp-confirmation');
assert.equal(prepareFlowMasteryOutcome(deleted, batch).notes.some(n => n.id === 'kp-confirmation'), false, 'deleted knowledge is not resurrected');

const failed = await evaluateFlowKnowledgeMastery({ sessionId: fixture.session.id, projectNoteId: fixture.session.noteId,
  rawText: fixture.session.incrementalText!, observedAt: fixture.session.endedAt,
  candidates: fixture.candidates, notes: fixture.notes }, { referenceReaders, call: async () => { throw new Error('model unavailable'); } });
const failedOutcome = prepareFlowMasteryOutcome(fixture.notes, failed);
assert.ok(failedOutcome.results.every(r => r.shadow?.status === 'failed'));
assert.deepEqual(failedOutcome.notes.filter(n => n.noteType === 'knowledge'), fixture.notes.filter(n => n.noteType === 'knowledge'));

const refs = batch.items[0].references;
const directInput: MasteryShadowEvaluationInput = { evaluationId: 'guard', knowledgePointId: 'guard-kp',
  knowledgePointTitle: '测试', occurredAt: fixture.session.endedAt, source: 'flow_review', assistance: 'independent',
  strength: 'natural', task: { evaluationMode: 'natural_recall', responseType: 'open', prompt: '复盘',
    requiredLayers: ['concept'], criterionIds: ['concept_accuracy'] }, answer: '我听过这个名称。',
  references: [{ ...refs[0], id: 'OTHER-LAYER', layers: ['judgment'], criterionIds: ['judgment_accuracy'] }] };
const badReference = { protocol: 'mastery-shadow-evaluator-v1', evaluationId: 'guard', knowledgePointId: 'guard-kp',
  evidence: [{ id: 'E1', quote: directInput.answer }], coverage: { concept: 'assessed' },
  criteria: [{ id: 'concept_accuracy', state: 'pass', evidenceIds: ['E1'],
    referenceIds: ['OTHER-LAYER'], reason: '错误借用其他层的资料。' }] };
assert.equal(parseMasteryShadowEvaluation(badReference, directInput).criteria[0].state, 'unverifiable');
const notObserved = parseMasteryShadowEvaluation({ ...badReference, coverage: { concept: 'incidental' },
  criteria: [{ id: 'concept_accuracy', state: 'not_observed', evidenceIds: ['E1'], referenceIds: [], reason: '只提及名称。' }] }, directInput);
assert.equal(notObserved.observations[0].coverage, 'incidental');
assert.equal(notObserved.observations[0].results[0].verdict, 'not_observed', 'absence cannot become partial correctness');
assert.throws(() => parseMasteryShadowEvaluation({ ...badReference, evaluationId: 'another-session' }, directInput), /不匹配/u);
assert.equal(JSON.parse(buildMasteryShadowEvaluationRequest(directInput).userInput).assistance, 'independent');

// The real persisted contract uses the existing transactional writer, then the usual vault/state readers.
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'loginote-flow-mastery-'));
const vault = path.join(temp, 'vault'), stateDir = path.join(temp, 'user-state');
await saveVaultSnapshot(vault, stateDir, second.notes);
const md = new Map(await Promise.all((await fs.readdir(path.join(vault, 'notes'))).map(async name =>
  [name, await fs.readFile(path.join(vault, 'notes', name), 'utf8')] as const)));
const reloaded = deserializeVault(await fs.readFile(path.join(vault, 'metadata.json'), 'utf8'), md);
const states = deserializeUserStateFile(await fs.readFile(path.join(stateDir, 'user-state.json'), 'utf8'));
const merged = reloaded.map(n => mergeNote(n, states[n.id]));
assert.deepEqual(merged.find(n => n.id === 'kp-confirmation')!.dsrState, second.notes.find(n => n.id === 'kp-confirmation')!.dsrState);
assert.ok(merged[0].learningReviewRecords!.every(r => r.masteryAssessment));
const { bundle, record } = createFlowResultPreview();
const report = adaptShadowRecordToFlowV2(record, '合成项目', second.results).report;
assert.deepEqual(report.sections.find(s => s.kind === 'mastery')!.items, second.results);
assert.deepEqual(report.stylePresentation, bundle.report.stylePresentation, 'mastery integration cannot alter cognitive/expression profile analysis');
const source = await fs.readFile('src/App.tsx', 'utf8');
assert.ok(source.includes('evaluateFlowKnowledgeMastery({') && source.includes('prepareFlowMasteryOutcome(current, batch)'));
assert.ok(!source.includes('scoreKnowledgePointsInParallel(') && !source.includes('computeLayeredMastery('), 'old scoring writes are disconnected from flow');
console.log(JSON.stringify({ ok: true, checks: ['bounded reference retrieval', 'two concurrent calls', 'alias deduplication',
  'mention and uncovered knowledge unchanged', 'legacy scores and memory state preserved', 'natural evidence accumulated across sessions',
  'same-session replay idempotent', 'per-point failure preserves state', 'stale-source rejection',
  'private transactional persistence and reload', 'report and profile compatibility'], isolatedStorage: temp }, null, 2));
