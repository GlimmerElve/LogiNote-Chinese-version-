/** Isolated local regressions; no cloud or production writes, no claims of LLM semantic success. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { checkLiteralArithmetic, arithmeticVerificationDecision } from '../src/services/flowShadow/literalArithmetic';
import { restoreFlatBehaviorRows } from '../src/services/flowShadow/behaviorTransport';
import { FLAT_BEHAVIOR_TRANSPORT, LITERAL_ARITHMETIC_CONTRACT, FLOW_SHADOW_PROTOCOL, type ShadowAssessment, type ShadowGraph, type ShadowRecord } from '../src/services/flowShadow/types';
import { SHADOW_COGNITIVE_AXES } from '../src/services/flowShadow/profileAlignment';
import { createFlowShadowFixture } from '../src/services/flowShadow/demo';
import { shadowFingerprint, parseShadowAssessment } from '../src/services/flowShadow/protocol';
import { replayShadowResponses, runFlowShadow } from '../src/services/flowShadow/runner';
import { buildShadowReferencePacket, buildShadowReferenceTargets } from '../src/services/flowShadow/references';
import { adaptShadowRecordToFlowV2 } from '../src/services/flowAnalysis/productionV2';
import { extractFlowEvidence } from '../src/services/memory/evidenceExtractor';
import { scoreShadowAssessment } from '../src/services/flowShadow/scoring';
import { buildShadowProfilePreview } from '../src/services/flowShadow/profile';
import { auditShadowCognitiveEvidence } from '../src/services/flowShadow/cognitiveEvidence';
import { FLOW_SHADOW_ASSESSMENT_PROMPT_V45 } from '../src/services/flowShadow/promptsAssessmentV45';
import { oral1000AcceptanceChecks } from './flow-acceptance-semantics';

const priorFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('No network in local flat/verification checks');
try {
  const tests: Array<[string, string | null, string | null]> = [
    ['76%减去33%，差了33个百分点。', '43', 'mismatch'],
    ['76%减去33%，差了43个百分点。', '43', 'match'],
    ['0.1 + 0.2 = 0.3。', '0.3', 'match'], ['0.1 + 0.2 = 0.4。', '0.3', 'mismatch'],
    ['12乘以3等于36。', '36', 'match'], ['12除以4等于3。', '3', 'match'],
    ['1减去2等于-1。', '-1', 'match'], ['10 - 2 = 9。', '8', 'mismatch'],
    ['3+4=7元。', null, null], ['3元加4美元等于7元。', null, null],
    ['增长33%。', null, null], ['1/3=0.33。', null, null], ['1/0=0。', null, null],
    ['3\n+4=7。', null, null], ['33%与76%不同。', null, null],
    ['2 * 3 + 4 = 10。', null, null], ['2^3+4=12。', null, null], ['2+3=5*2。', null, null],
    ['1,000+2=1002。', null, null], ['1+2=3,000。', null, null],
    ['2 *\n3+4=10。', null, null], ['2+3=5\n*2。', null, null],
  ];
  for (const [text, expected, status] of tests) {
    const checks = checkLiteralArithmetic(text);
    assert.equal(checks.length, expected === null ? 0 : 1, text);
    if (expected !== null) { assert.equal(checks[0].expected, expected, text); assert.equal(checks[0].status, status, text);
      assert.equal(text.slice(checks[0].start, checks[0].end), checks[0].quote); }
  }
  const flat = SHADOW_COGNITIVE_AXES.map(a => ({ code: a.behavior, state: 'uncertain', direction: null,
    negativeEvidenceIds: [], positiveEvidenceIds: [], contextEvidenceIds: [], resolution: 'insufficient', reason: '无充分观察机会。' }));
  const originalFlat = JSON.stringify(flat);
  assert.equal(restoreFlatBehaviorRows(flat).rows.length, 5);
  assert.equal(restoreFlatBehaviorRows([]).warnings.length, 5);
  const positive = { ...flat[0], state: 'observed', direction: 1, positiveEvidenceIds: ['EC'], contextEvidenceIds: ['EU'], resolution: 'single_pole' };
  const assembled = restoreFlatBehaviorRows([positive, ...flat.slice(1)]).rows[0] as ShadowAssessment['behaviors'][number];
  assert.deepEqual(assembled.polarity, { negative: [], positive: ['EC'], resolution: 'single_pole' });
  assert.deepEqual(assembled.evidenceIds, ['EC', 'EU'], 'Evidence union is mechanical, not guessed from reason');
  assert.equal(restoreFlatBehaviorRows([{ ...positive, evidenceIds: ['EVIL'] }, ...flat.slice(1)]).warnings[0].code, 'cognitive_transport_conflict');
  assert.equal(restoreFlatBehaviorRows([{ ...positive, positiveEvidenceIds: undefined }, ...flat.slice(1)]).warnings[0].code, 'cognitive_transport_invalid');
  assert.equal(restoreFlatBehaviorRows([positive, positive, ...flat.slice(1)]).warnings[0].code, 'cognitive_transport_duplicate');
  assert.equal(JSON.stringify(flat), originalFlat);

  const f = createFlowShadowFixture();
  // Hand-authored declarations test the existing transport/audit, not model semantic accuracy.
  // Distinct evidence fragments may bind to ONE existing graph node; no graph rewrite is necessary.
  const correctionParts = ['原来我说任何条件下都有效。', '这个说法我收回。', '现在只在这次条件内成立。'];
  const correctionText = correctionParts.join('');
  const correctionInput = { ...f.input, rawText: correctionText };
  const correctionGraph: ShadowGraph = { nodes: [{ id: 'SAME', role: 'claim', text: correctionText, rawQuote: correctionText }],
    arguments: [{ id: 'SAME-A', claim: 'SAME', support: [], oppose: [], status: 'stated_only' }], relations: [], unresolved: [] };
  const correctionRow = { code: 'uncertainty_calibration', state: 'observed', negativeEvidenceIds: ['COR-0'],
    positiveEvidenceIds: ['COR-2'], contextEvidenceIds: ['COR-1'], resolution: 'resolved', direction: 1, reason: '声明为同范围原断言的撤回及限定替代。' };
  const correctionBody = { ...f.assessment,
    evidence: correctionParts.map((quote, i) => ({ id: `COR-${i}`, quote, nodeIds: ['SAME'], attribution: 'user' as const })),
    behaviors: restoreFlatBehaviorRows([correctionRow, ...flat.filter(r => r.code !== correctionRow.code)]).rows as ShadowAssessment['behaviors'] };
  const correctionOriginal = JSON.stringify({ correctionInput, correctionGraph, correctionBody });
  const correctionAudit = auditShadowCognitiveEvidence(correctionInput, correctionGraph, correctionBody, true);
  assert.equal(correctionAudit.assessment.behaviors.find(b => b.code === correctionRow.code)!.direction, 1);
  assert.deepEqual(correctionAudit.warnings, []);
  assert.deepEqual(correctionAudit.assessment.behaviors.find(b => b.code === correctionRow.code)!.evidenceIds, ['COR-0', 'COR-2', 'COR-1']);
  const reusedPole = structuredClone(correctionBody);
  const reusedBehavior = reusedPole.behaviors.find(b => b.code === correctionRow.code)!;
  reusedBehavior.polarity!.positive.push('COR-0');
  assert.equal(auditShadowCognitiveEvidence(correctionInput, correctionGraph, reusedPole, true).assessment.behaviors
    .find(b => b.code === correctionRow.code)!.direction, null, 'Reusing the same pole ID stays unknown, never silently split or repaired');
  assert.equal(JSON.stringify({ correctionInput, correctionGraph, correctionBody }), correctionOriginal);
  const math = '10 - 2 = 9。', concept = '先定义这个对象的含义。', unrelated = '两个比例不同。';
  const input = { ...f.input, rawText: [math, concept, unrelated].join('\n') };
  const graph: ShadowGraph = { nodes: [
    { id: 'N1', role: 'claim', text: math, rawQuote: math }, { id: 'NC', role: 'background', text: concept, rawQuote: concept },
    { id: 'NU', role: 'claim', text: unrelated, rawQuote: unrelated }], arguments: [
    { id: 'A1', claim: 'N1', support: [], oppose: [], status: 'stated_only' },
    { id: 'AU', claim: 'NU', support: [], oppose: [], status: 'stated_only' }], relations: [], unresolved: [] };
  const targets = buildShadowReferenceTargets(graph);
  const candidates = targets.map(t => ({ id: `REF-${t.id}`, targetId: t.id, tier: 1 as const, sourceType: 'project_textbook' as const,
    sourceId: 'synthetic', title: '合成参考', locator: t.id, relation: 'other' as const, availability: 'available' as const, text: concept, similarity: .9 }));
  const references = buildShadowReferencePacket(input, graph, candidates);
  const assessment = { ...structuredClone(f.assessment), evidence: [
    { id: 'EM', quote: math, nodeIds: ['N1'], attribution: 'user' as const },
    { id: 'EC', quote: concept, nodeIds: ['NC'], attribution: 'user' as const },
    { id: 'EU', quote: unrelated, nodeIds: ['NU'], attribution: 'user' as const }],
    criteria: f.assessment.criteria.map(c => ({ ...c, state: 'observed' as const, level: 3, evidenceIds: [c.id === 'reasoning_consistency' ? 'EM' : 'EC'], opportunityKeys: ['fixed'] })),
    referenceComparisons: targets.map((t, i) => ({ id: `RC${i}`, targetId: t.id, layer: t.layer, state: 'aligned' as const, level: 3,
      userEvidenceIds: ['EC'], referenceIds: [`REF-${t.id}`], reason: '固定模型声明，不作为语义真值。' })),
    behaviors: [], issues: [], summary: '固定模型摘要。', recommendation: '固定模型建议。' } as ShadowAssessment;
  const extraction = { protocol: FLOW_SHADOW_PROTOCOL, inputKey: shadowFingerprint(input), graph };
  const wire = (body: unknown) => ({ protocol: FLOW_SHADOW_PROTOCOL, inputKey: shadowFingerprint(input), graphKey: shadowFingerprint(graph),
    referenceKey: shadowFingerprint(references), assessment: body });
  const options = { requireCognitiveAudit: true, behaviorTransport: FLAT_BEHAVIOR_TRANSPORT, arithmeticVerification: true } as const;
  const raw = { ...assessment, cognitiveObservations: [positive, ...flat.slice(1)], calculationReviews: [] };
  const originalRaw = JSON.stringify(raw);
  const legacy = replayShadowResponses(input, extraction, wire(raw), references);
  assert.deepEqual(legacy.scoring.layers.map(l => l.score), [75, 75, 75], 'Historical non-opt-in scoring stays unchanged');
  assert.equal(legacy.assessment.localVerification, undefined);
  const pending = replayShadowResponses(input, extraction, wire(raw), references, options);
  assert.deepEqual(pending.graph, graph);
  assert.deepEqual(pending.scoring.layers.map(l => l.score), [75, 75, null], 'Only affected internal layer is pending, not zero');
  assert.equal(pending.scoring.layers[2].eligibleForProfile, false);
  assert.ok(pending.warnings.some(w => w.code === 'arithmetic_review_pending'));
  assert.deepEqual(pending.assessment.issues, [], 'Local arithmetic never invents an LLM semantic issue');
  const unrelatedTarget = pending.referenceScoring.layers.find(l => l.layer === 'concept')!;
  assert.equal(unrelatedTarget.score, 75);
  assert.equal(unrelatedTarget.eligibleForMastery, true);
  const forged = structuredClone(pending);
  forged.scoring = structuredClone(legacy.scoring);
  forged.assessment.localVerification!.arithmeticChecks[0].status = 'match';
  forged.assessment.localVerification!.arithmeticChecks[0].expected = '9';
  assert.equal(scoreShadowAssessment(forged.input, forged.graph, forged.assessment).layers[2].score, null, 'Never trust forged cached scores/checks');
  const bundle = adaptShadowRecordToFlowV2(forged, '合成核验');
  assert.ok(bundle.report.unscoredLayers!.includes('reasoning'));
  assert.ok(bundle.report.verificationNotes!.some(note => note.includes('8')));
  assert.ok(bundle.analysisV2.reviewBlockSummary.includes('待核验'));
  assert.equal(bundle.argumentDoc.nodes.length, 3);
  const signals = extractFlowEvidence({ episodeId: input.attemptId, observedAt: input.observedAt,
    report: bundle.report, profileInsight: bundle.profileInsight, analysisV2: { ...bundle.analysisV2, record: forged } }).profileSignals;
  assert.ok(!signals.some(s => s.indicator === 'reasoningValidity'));
  assert.ok(signals.some(s => s.indicator === 'conceptClarity'));
  assert.equal(buildShadowProfilePreview([pending]).metrics.find(m => m.key.includes(':ability:reasoning:'))?.sampleCount, 0);

  const reviewed = structuredClone(raw);
  reviewed.calculationReviews = [{ checkId: 'M1', usage: 'current', evidenceIds: ['EM'], criterionIds: ['reasoning_consistency'], reason: '当前计算不正确，正确差值为8。' }] as any;
  reviewed.issues = [{ id: 'I1', kind: 'confirmed_internal', targetIds: ['N1'], evidenceIds: ['EM'], severity: 'medium', reason: '差值计算不成立。' }];
  reviewed.criteria.find(c => c.id === 'reasoning_consistency')!.level = 2;
  reviewed.referenceComparisons.filter(c => c.targetId === 'T-J-N1' || c.targetId === 'T-R-A1').forEach(c => { c.state = 'misaligned' as any; c.level = 1; });
  const accepted = replayShadowResponses(input, extraction, wire(reviewed), references, options);
  assert.deepEqual(accepted.scoring.layers.map(l => l.score), [75, 75, 66.7], 'Same formula, model supplied grades; no automatic fixed deduction');
  assert.equal(accepted.scoring.layers[2].eligibleForProfile, true);
  for (const level of [0, 1, 2, 3, 4]) {
    const graded = structuredClone(reviewed); graded.criteria.find(c => c.id === 'reasoning_consistency')!.level = level;
    const result = replayShadowResponses(input, extraction, wire(graded), references, options);
    assert.equal(result.assessment.criteria.find(c => c.id === 'reasoning_consistency')!.level, level, 'Local checks never rewrite model grades');
    assert.equal(result.scoring.layers[2].score, level >= 3 ? null : Math.round((6 + level) / 3 * 25 * 10) / 10);
    assert.deepEqual(result.scoring.layers.slice(0, 2).map(l => l.score), [75, 75], 'No deduction in unrelated layers');
    assert.deepEqual(result.graph, graph, 'Inconsistent grades cannot cancel the graph');
  }
  const uncertain = structuredClone(raw); uncertain.calculationReviews = [{ ...reviewed.calculationReviews[0] as any, usage: 'uncertain' }];
  assert.equal(replayShadowResponses(input, extraction, wire(uncertain), references, options).scoring.layers[2].score, null);
  for (const usage of ['retracted', 'quoted', 'hypothetical'] as const) {
    const excluded = structuredClone(raw); excluded.calculationReviews = [{ ...reviewed.calculationReviews[0] as any, usage, criterionIds: [] }];
    const result = replayShadowResponses(input, extraction, wire(excluded), references, options);
    assert.deepEqual(result.scoring.layers.map(l => l.score), [75, 75, 75], 'Context classification is declared by model, not inferred by local arithmetic');
    assert.equal(result.assessment.issues.length, 0);
  }
  const correctedQuote = '我收回这个计算，10 - 2 = 8。';
  const correctedInput = { ...input, rawText: `${input.rawText}\n${correctedQuote}` };
  const correctedGraph = structuredClone(graph);
  correctedGraph.nodes.push({ id: 'NF', role: 'claim', text: correctedQuote, rawQuote: correctedQuote });
  const correctedBody = structuredClone(raw);
  correctedBody.evidence.push({ id: 'EF', quote: correctedQuote, nodeIds: ['NF'], attribution: 'user' });
  correctedBody.calculationReviews = [{ ...reviewed.calculationReviews[0] as any, usage: 'retracted', evidenceIds: ['EM', 'EF'], criterionIds: [] }];
  const corrected = replayShadowResponses(correctedInput,
    { protocol: FLOW_SHADOW_PROTOCOL, inputKey: shadowFingerprint(correctedInput), graph: correctedGraph },
    { protocol: FLOW_SHADOW_PROTOCOL, inputKey: shadowFingerprint(correctedInput), graphKey: shadowFingerprint(correctedGraph),
      referenceKey: shadowFingerprint(references), assessment: correctedBody }, references, options);
  assert.deepEqual(corrected.assessment.localVerification!.arithmeticChecks.map(c => c.status), ['mismatch', 'match']);
  assert.deepEqual(corrected.scoring.layers.map(l => l.score), [75, 75, 75], 'Explicitly declared retraction/correction is not penalized as a current wrong claim');
  const injected = { ...raw, localVerification: { contract: LITERAL_ARITHMETIC_CONTRACT, arithmeticChecks: [], calculationReviews: [] } };
  assert.equal(parseShadowAssessment(wire(injected), input, graph, references).assessment.localVerification, undefined, 'LLM cannot opt historical parsing into new verification');
  assert.equal(JSON.stringify(raw), originalRaw);

  let calls = 0;
  const outcome = await runFlowShadow(input, { call: async request => {
    calls++;
    const payload = JSON.parse(request.userInput);
    if (request.stage === 'assess') {
      assert.equal(payload.localArithmeticChecks.items[0].expected, '8');
      assert.equal(request.behaviorTransport, FLAT_BEHAVIOR_TRANSPORT);
      assert.equal(request.arithmeticVerification, LITERAL_ARITHMETIC_CONTRACT);
    }
    return { content: JSON.stringify(request.stage === 'extract' ? extraction : wire(raw)) };
  } }, { referenceProvider: { retrieve: async () => candidates } });
  assert.equal(outcome.status, 'reviewed', outcome.error);
  assert.equal(calls, 2);
  assert.equal(outcome.record!.behaviorTransport, FLAT_BEHAVIOR_TRANSPORT);
  assert.equal(outcome.record!.scoring.layers[2].score, null);
  if (process.argv.includes('--replay-v44')) {
    const directory = '.ui-preview/flow-acceptance/cloud-Kcl9hT';
    const originalText = await readFile(`${directory}/bundle.json`, 'utf8');
    const saved = JSON.parse(originalText).analysisV2.record as ShadowRecord;
    const extract = JSON.parse(await readFile(`${directory}/response-extract.json`, 'utf8'));
    const assess = JSON.parse(await readFile(`${directory}/response-assess.json`, 'utf8'));
    const frozenReplay = replayShadowResponses(saved.input, extract.content, assess.content, saved.references,
      { ...options, referenceTransport: 'shared-sources-v1' });
    assert.deepEqual(frozenReplay.graph, saved.graph);
    assert.deepEqual(frozenReplay.assessment.criteria, saved.assessment.criteria, 'Original LLM grades remain in the evidence record');
    assert.equal(frozenReplay.assessment.localVerification!.arithmeticChecks[0].expected, '43');
    assert.equal(frozenReplay.assessment.localVerification!.arithmeticChecks[0].status, 'mismatch');
    assert.deepEqual(frozenReplay.scoring.layers.map(l => l.score), [100, 100, null]);
    assert.equal(frozenReplay.assessment.issues.length, 0, 'Local detection is not reported as LLM semantic success');
    assert.ok(frozenReplay.assessment.behaviors.filter(b => SHADOW_COGNITIVE_AXES.some(a => a.behavior === b.code)).every(b => b.state === 'uncertain' && b.direction === null));
    assert.equal(await readFile(`${directory}/bundle.json`, 'utf8'), originalText, 'Historical experiment files never changed');
    console.log('PASS: frozen failed V4.4 reply exposes 43pp mismatch and holds related scores under NEW opt-in only; original grades/history preserved, original model semantic checks remain failed.');
  }
  if (process.argv.includes('--replay-v45')) {
    const directory = '.ui-preview/flow-assessment-isolated/cloud-pr06Vm';
    const originalText = await readFile(`${directory}/record-candidate.json`, 'utf8');
    const saved = JSON.parse(originalText) as ShadowRecord;
    const request = JSON.parse(await readFile(`${directory}/request-candidate.json`, 'utf8'));
    assert.equal(request.systemPrompt, FLOW_SHADOW_ASSESSMENT_PROMPT_V45, 'Preserve the exact real V4.5 prompt');
    const extract = JSON.parse(await readFile('.ui-preview/flow-acceptance/cloud-Kcl9hT/response-extract.json', 'utf8'));
    const assessText = await readFile(`${directory}/response-candidate.json`, 'utf8');
    const rawReply = JSON.parse(JSON.parse(assessText).content);
    const frozen = replayShadowResponses(saved.input, extract.content, rawReply, saved.references,
      { ...options, referenceTransport: 'shared-sources-v1', reviewBehaviorCoverage: true });
    assert.deepEqual(frozen.graph, saved.graph);
    assert.deepEqual(frozen.assessment.criteria, saved.assessment.criteria);
    assert.equal(frozen.assessment.behaviors.find(b => b.code === 'uncertainty_calibration')!.direction, null);
    assert.equal(frozen.scoring.layers[2].score, null);
    assert.ok(frozen.warnings.some(w => w.code === 'cognitive_polarity_unbound'));
    assert.ok(frozen.warnings.some(w => w.code === 'arithmetic_review_pending'));
    assert.equal(oral1000AcceptanceChecks(frozen, rawReply.assessment).explicitRetractionRecognized, false);

    // Counterfactual fixture ONLY: prove a correctly declared response is accepted with the SAME graph.
    // Do not save it as a model result or modify any frozen experiment file.
    const declared = structuredClone(rawReply);
    const oldEvidence = declared.assessment.evidence.find((e: { id: string }) => e.id === 'E7');
    oldEvidence.quote = '我刚才差点说，这就证明所有人任何时候都会按局部账户来决策。';
    oldEvidence.nodeIds = ['N13'];
    declared.assessment.evidence.push(
      { id: 'E7-context', quote: '不对，这句话我收回。', nodeIds: ['N14'], attribution: 'user' },
      { id: 'E7-replacement', quote: '两个情景说明不了所有人，也说明不了所有任务，不能这么往外推。', nodeIds: ['N14'], attribution: 'user' });
    const corrected = declared.assessment.cognitiveObservations.find((b: { code: string }) => b.code === 'uncertainty_calibration');
    corrected.positiveEvidenceIds = ['E7-replacement', 'E8', 'E9']; corrected.contextEvidenceIds = ['E7-context'];
    declared.assessment.criteria.find((c: { id: string }) => c.id === 'reasoning_consistency').level = 2;
    const acceptedDeclaration = replayShadowResponses(saved.input, extract.content, declared, saved.references,
      { ...options, referenceTransport: 'shared-sources-v1', reviewBehaviorCoverage: true });
    assert.deepEqual(acceptedDeclaration.graph, saved.graph);
    assert.equal(oral1000AcceptanceChecks(acceptedDeclaration, declared.assessment).explicitRetractionRecognized, true);
    assert.equal(acceptedDeclaration.scoring.layers[2].score, 66.7);
    assert.ok(!acceptedDeclaration.warnings.some(w => ['arithmetic_review_pending', 'cognitive_polarity_unbound'].includes(w.code)));
    assert.equal(await readFile(`${directory}/record-candidate.json`, 'utf8'), originalText);
    assert.equal(await readFile(`${directory}/response-candidate.json`, 'utf8'), assessText);
    console.log('PASS: unchanged real V4.5 failures still held; HAND-AUTHORED counterfactual declarations pass with frozen graph. This is NOT a new LLM semantic test.');
  }
  console.log('PASS: distinct correction fragments may bind the same node; overlapping poles remain unknown; current hard-error grades 3/4 held, 0/1/2 use original formula; bounded exact arithmetic; flat fields; cached-read/profile gates; historical opt-in; two mock calls, zero cloud/production writes. Model semantics not certified.');
} finally { globalThis.fetch = priorFetch; }
