/** Structural regression; no model semantics are inferred or repaired by these assertions. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { FLOW_SHADOW_ASSESSMENT_PROMPT, FLOW_SHADOW_EXTRACTION_PROMPT, SHADOW_ASSESSMENT_PROMPT_ID } from '../src/services/flowShadow/prompts';
import { FLOW_SHADOW_EXTRACTION_PROMPT_V42, FLOW_SHADOW_ASSESSMENT_PROMPT_V42 } from '../src/services/flowShadow/promptsV42';
import { createFlowShadowFixture } from '../src/services/flowShadow/demo';
import { parseShadowAssessment, parseShadowExtraction, shadowFingerprint } from '../src/services/flowShadow/protocol';
import { requiresAssessmentCoverageReview, reviewShadowBehaviorCoverage } from '../src/services/flowShadow/assessmentCoverage';
import { SHARED_REFERENCE_TRANSPORT, projectShadowReferencePacket, reviewShadowReferenceBindings } from '../src/services/flowShadow/referenceTransport';
import { replayShadowResponses, runFlowShadow } from '../src/services/flowShadow/runner';
import type { ShadowBehavior, ShadowRecord } from '../src/services/flowShadow/types';

const priorFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('No network in repair regression');
try {
  const prompt = FLOW_SHADOW_ASSESSMENT_PROMPT;
  assert.equal(requiresAssessmentCoverageReview(SHADOW_ASSESSMENT_PROMPT_ID), true);
  assert.equal(requiresAssessmentCoverageReview('flow-shadow-assess-v4.2-light'), false);
  assert.ok(FLOW_SHADOW_EXTRACTION_PROMPT.includes('"oppose":["N2"]'));
  for (const marker of ['被撤回的原判断、撤回说明、替代判断分别成块', '最后回查预期与实际', '用户自行计算出的差值'])
    assert.ok(FLOW_SHADOW_EXTRACTION_PROMPT.includes(marker));
  for (const marker of ['不限于图中claim或资料targets', '原话内部可核验',
    '分别扫描expression与strategy', 'referenceIds只能逐字取当前targetId对应selection.itemIds']) assert.ok(prompt.includes(marker));
  const example = JSON.parse(prompt.split('\n').find(line => line.startsWith('{"protocol"'))!);
  const expression = example.assessment.behaviors.find((b: ShadowBehavior) => b.code === 'concept_framing');
  const strategy = example.assessment.cognitiveObservations.find((b: ShadowBehavior) => b.code === 'uncertainty_calibration');
  assert.equal(expression.code, 'concept_framing');
  assert.equal(expression.direction, null);
  assert.equal(strategy.code, 'uncertainty_calibration');
  assert.equal(strategy.resolution, 'insufficient');
  assert.equal(strategy.direction, null);
  assert.deepEqual(strategy.negativeEvidenceIds, []);
  assert.deepEqual(strategy.positiveEvidenceIds, []);
  assert.ok(FLOW_SHADOW_EXTRACTION_PROMPT_V42.includes('v4.2') && FLOW_SHADOW_ASSESSMENT_PROMPT_V42.includes('v4.2'));

  const fixture = createFlowShadowFixture();
  const raw = structuredClone(fixture.assessResponse);
  const original = JSON.stringify(raw);
  const options = { requireCognitiveAudit: true, reviewBehaviorCoverage: true, referenceTransport: SHARED_REFERENCE_TRANSPORT } as const;
  raw.assessment.behaviors = [];
  const empty = parseShadowAssessment(raw, fixture.input, fixture.graph, fixture.referencePacket, options);
  assert.equal(empty.warnings.filter(w => w.code === 'behavior_domain_unreported').length, 2);
  assert.deepEqual(empty.assessment.behaviors, [], 'Missing domains must not generate behaviors or directions');
  assert.deepEqual(parseShadowAssessment(raw, fixture.input, fixture.graph, fixture.referencePacket).warnings
    .filter(w => w.code === 'behavior_domain_unreported'), [], 'Historical parse does not get silently opted in');
  assert.deepEqual(reviewShadowBehaviorCoverage([expression, strategy] as ShadowBehavior[]), []);
  assert.deepEqual(reviewShadowBehaviorCoverage([strategy] as ShadowBehavior[]).map(w => w.target), ['expression']);

  const transport = projectShadowReferencePacket(fixture.referencePacket);
  for (const comparison of fixture.assessment.referenceComparisons) {
    const selected = fixture.referencePacket.selection.find(s => s.targetId === comparison.targetId)!.itemIds;
    const allowed = selected.map(id => transport.itemToAlias.get(id)!);
    assert.deepEqual(reviewShadowReferenceBindings([{ ...comparison, referenceIds: allowed }], fixture.referencePacket), []);
    const unknown = { ...comparison, referenceIds: ['UNKNOWN-SOURCE'] };
    assert.equal(reviewShadowReferenceBindings([unknown], fixture.referencePacket)[0].code, 'reference_selection_mismatch');
  }
  const stages: string[] = [];
  const outcome = await runFlowShadow(fixture.input, { call: async request => {
    stages.push(request.stage);
    return { content: JSON.stringify(request.stage === 'extract' ? fixture.extractResponse : raw) };
  } }, { referenceProvider: { retrieve: async () => fixture.referenceCandidates } });
  assert.equal(outcome.status, 'reviewed', outcome.error);
  assert.deepEqual(stages, ['extract', 'assess']);
  assert.equal(outcome.record!.warnings.filter(w => w.code === 'behavior_domain_unreported').length, 2);
  assert.deepEqual(outcome.graph, fixture.graph, 'Warnings cannot manufacture an oppose edge or change roles');
  assert.equal(JSON.stringify(fixture.assessResponse), original, 'Input fixture remains untouched');

  if (process.argv.includes('--replay-failed')) {
    const directory = '.ui-preview/flow-acceptance/cloud-EjLixi';
    const savedText = await readFile(`${directory}/bundle.json`, 'utf8');
    const saved = JSON.parse(savedText).analysisV2.record as ShadowRecord;
    const oldExtractRequest = JSON.parse(await readFile(`${directory}/request-extract.json`, 'utf8'));
    const oldAssessRequest = JSON.parse(await readFile(`${directory}/request-assess.json`, 'utf8'));
    assert.equal(oldExtractRequest.systemPrompt, FLOW_SHADOW_EXTRACTION_PROMPT_V42);
    assert.equal(oldAssessRequest.systemPrompt, FLOW_SHADOW_ASSESSMENT_PROMPT_V42);
    const extract = JSON.parse(await readFile(`${directory}/response-extract.json`, 'utf8'));
    const assess = JSON.parse(await readFile(`${directory}/response-assess.json`, 'utf8'));
    const replay = replayShadowResponses(saved.input, extract.content, assess.content, saved.references, options);
    const baseline = parseShadowExtraction(extract.content, saved.input);
    assert.deepEqual(replay.graph, baseline.graph);
    assert.deepEqual(replay.scoring, saved.scoring);
    assert.deepEqual(replay.referenceScoring, saved.referenceScoring);
    assert.deepEqual(replay.assessment, saved.assessment, 'Diagnostics cannot fill missing poles, reassign sources, or invent arithmetic issues');
    assert.ok(replay.warnings.some(w => w.code === 'behavior_domain_unreported' && w.target === 'expression'));
    assert.ok(replay.warnings.some(w => w.code === 'reference_selection_mismatch' && w.target === 'RC4'));
    assert.equal(replay.warnings.filter(w => w.code === 'cognitive_audit_missing').length, 5);
    assert.equal(replay.assessment.issues.length, 0, 'The original model missed the arithmetic error; local replay must not pretend it found it');
    assert.equal(await readFile(`${directory}/bundle.json`, 'utf8'), savedText);
    assert.equal(shadowFingerprint(replay.graph), shadowFingerprint(saved.graph));
    console.log('PASS: failed real reply diagnoses omitted expression, 5 missing polarity declarations and wrong-target RC4; original semantic failures remain failures. No history rewrites.');
  }
  console.log(JSON.stringify({ status: 'PASS', promptCharacters: { extract: FLOW_SHADOW_EXTRACTION_PROMPT.length, assess: prompt.length },
    extraCalls: 0, cloudCalls: 0, productionWrites: 0, semanticRepairVerified: false }));
} finally { globalThis.fetch = priorFetch; }
