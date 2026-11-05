import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createFlowShadowFixture, createFlowShadowDemo } from '../src/services/flowShadow/demo';
import { FLOW_ORAL_ACCEPTANCE, FLOW_ORAL_1000 } from './fixtures/flow-oral-acceptance';
import { assessmentContractChecks, oralAcceptanceChecks, oral1000AcceptanceChecks, lowQualityAcceptanceChecks } from './flow-acceptance-semantics';
import type { ShadowRecord } from '../src/services/flowShadow/types';

const priorFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('No network in fixture checks/rechecks');
try {
  const fixture = createFlowShadowFixture();
  const r = structuredClone(createFlowShadowDemo());
  r.input = { ...fixture.input, rawText: FLOW_ORAL_ACCEPTANCE.rawText };
  const paragraphs = FLOW_ORAL_ACCEPTANCE.rawText.split('\n');
  const originals = [paragraphs[1], paragraphs[2], paragraphs[3],
    '我刚才差点说，这就证明所有人任何时候都会按局部账户来决策。',
    '嗯，不对，这句话我收回。', '两个情景说明不了所有人，也说明不了所有任务，不能这么往外推。'];
  r.graph = {
    nodes: originals.map((rawQuote, i) => ({ id: `arbitrary-${i}`, role: i === 1 ? 'premise' : i === 4 ? 'background' : 'claim', text: rawQuote, rawQuote })),
    arguments: [{ id: 'arg', claim: 'arbitrary-0', support: [], oppose: ['arbitrary-1'], status: 'stated_only' },
      { id: 'summary', claim: 'arbitrary-2', support: ['arbitrary-1'], oppose: [], status: 'argued' }],
    relations: [{ id: 'meta', kind: 'context', from: 'arbitrary-4', to: 'arbitrary-3', reason: '撤回同一旧判断' }], unresolved: [],
  };
  r.assessment = { ...fixture.assessment,
    evidence: originals.map((quote, i) => ({ id: `EV-${i}`, quote, nodeIds: [`arbitrary-${i}`], attribution: 'user' })),
    criteria: fixture.assessment.criteria.map(c => ({ ...c, evidenceIds: ['EV-0'], opportunityKeys: ['fixture-only'] })),
    behaviors: [{ code: 'uncertainty_calibration', state: 'observed', direction: 1,
      evidenceIds: ['EV-3', 'EV-5'], polarity: { negative: ['EV-3'], positive: ['EV-5'], resolution: 'resolved' }, reason: '同一对象明确撤回' }],
    issues: [],
  };
  const original = structuredClone(r);
  assert.ok(Object.values(oralAcceptanceChecks(r)).every(Boolean), 'Direct ratio evidence and separate linked meta-discourse accepted');
  const summary = structuredClone(r);
  summary.graph.arguments[0].oppose = ['arbitrary-2'];
  assert.equal(oralAcceptanceChecks(summary).actualOpposesExpectation, true, 'Also accept result-summary nodes');
  const renamed = JSON.parse(JSON.stringify(r).replaceAll('arbitrary-', 'renamed-').replaceAll('EV-', 'new-evidence-'));
  assert.deepEqual(oralAcceptanceChecks(renamed), oralAcceptanceChecks(r), 'No hard-coded IDs');
  const missingOppose = structuredClone(r); missingOppose.graph.arguments[0].oppose = [];
  assert.equal(oralAcceptanceChecks(missingOppose).actualOpposesExpectation, false);
  const wrongDirection = structuredClone(r); wrongDirection.graph.arguments[0].claim = 'arbitrary-1'; wrongDirection.graph.arguments[0].oppose = ['arbitrary-0'];
  assert.equal(oralAcceptanceChecks(wrongDirection).actualOpposesExpectation, false);
  const method = structuredClone(r); method.graph.nodes[1].role = 'method';
  assert.equal(oralAcceptanceChecks(method).actualOpposesExpectation, false);
  const inventedQuote = structuredClone(r); inventedQuote.graph.nodes[1].rawQuote = '33%和76%：原话中不存在的引文';
  assert.equal(oralAcceptanceChecks(inventedQuote).actualOpposesExpectation, false);
  const duplicate = structuredClone(r); duplicate.graph.relations.push({ id: 'duplicate', kind: 'relates', from: 'arbitrary-1', to: 'arbitrary-0', reason: '同一反对功能' });
  assert.equal(oralAcceptanceChecks(duplicate).noSamePairRelates, false);
  const unlinked = structuredClone(r); unlinked.graph.relations = [];
  assert.equal(oralAcceptanceChecks(unlinked).explicitRetractionRecognized, false, 'Unrelated keyword elsewhere cannot pass');
  const reasonOnly = structuredClone(r); reasonOnly.assessment.evidence = reasonOnly.assessment.evidence.filter(e => e.id !== 'EV-4');
  assert.equal(oralAcceptanceChecks(reasonOnly).explicitRetractionRecognized, false, 'Model reason alone cannot prove withdrawal');
  const single = structuredClone(r); single.assessment.behaviors[0].polarity!.resolution = 'single_pole';
  assert.equal(oralAcceptanceChecks(single).explicitRetractionRecognized, false);
  const overlap = structuredClone(r); overlap.assessment.behaviors[0].polarity!.positive = ['EV-3'];
  assert.equal(oralAcceptanceChecks(overlap).explicitRetractionRecognized, false);
  const absentPole = structuredClone(r); absentPole.assessment.behaviors[0].polarity!.negative = [];
  assert.equal(oralAcceptanceChecks(absentPole).explicitRetractionRecognized, false);
  const malformed = structuredClone(r.assessment); malformed.criteria[0].level = 100;
  assert.equal(assessmentContractChecks(malformed).legalLevelsAndEvidence, false);
  assert.equal(assessmentContractChecks({ ...r.assessment, criteria: r.assessment.criteria.slice(1) }).nineDistinctCriteria, false);
  assert.equal(assessmentContractChecks({ ...r.assessment, totalScore: 100 }).noModelTotalScore, false);
  const unknown = structuredClone(r.assessment); unknown.criteria[0] = { ...unknown.criteria[0], state: 'uncertain', level: null, evidenceIds: [], opportunityKeys: [] };
  assert.equal(assessmentContractChecks(unknown).legalLevelsAndEvidence, true, 'Unknown remains null, not zero');
  const unknownZero = structuredClone(unknown); unknownZero.criteria[0].level = 0;
  assert.equal(assessmentContractChecks(unknownZero).legalLevelsAndEvidence, false);
  const perfect = structuredClone(r);
  perfect.scoring.layers = ['concept', 'judgment', 'reasoning'].map(layer => ({ layer, score: 100 })) as ShadowRecord['scoring']['layers'];
  assert.equal(lowQualityAcceptanceChecks(perfect, perfect.assessment).notAllPerfect, false);
  assert.equal(lowQualityAcceptanceChecks(perfect, perfect.assessment).meanAtMost60, false);
  const long = structuredClone(r);
  long.input.rawText = FLOW_ORAL_1000.rawText;
  assert.ok(FLOW_ORAL_1000.rawText.replace(/\s/gu, '').length >= 950 && FLOW_ORAL_1000.rawText.replace(/\s/gu, '').length <= 1100);
  assert.deepEqual(FLOW_ORAL_1000.referenceParagraphs, FLOW_ORAL_ACCEPTANCE.referenceParagraphs);
  const arithmeticQuote = '76%减去33%，差了33个百分点。';
  assert.ok(long.input.rawText.includes(arithmeticQuote));
  long.graph.nodes.push({ id: 'calc', role: 'claim', text: arithmeticQuote, rawQuote: arithmeticQuote });
  long.assessment.evidence.push({ id: 'calc-evidence', quote: arithmeticQuote, nodeIds: ['calc'], attribution: 'user' });
  assert.equal(oral1000AcceptanceChecks(long, long.assessment).arithmeticErrorDetected, false);
  long.assessment.issues.push({ id: 'calc-issue', kind: 'confirmed_internal', targetIds: ['calc'], evidenceIds: ['calc-evidence'],
    severity: 'medium', reason: '差值计算错误，应为43个百分点而不是33。' });
  assert.equal(oral1000AcceptanceChecks(long, long.assessment).arithmeticErrorDetected, true);
  const unverifiedArithmetic = structuredClone(long);
  unverifiedArithmetic.assessment.evidence.find(e => e.id === 'calc-evidence')!.quote = '资料没有出现的差了33个百分点';
  assert.equal(oral1000AcceptanceChecks(unverifiedArithmetic, unverifiedArithmetic.assessment).arithmeticErrorDetected, false);
  const noArithmeticBinding = structuredClone(long);
  noArithmeticBinding.assessment.issues[0].evidenceIds = ['EV-0'];
  assert.equal(oral1000AcceptanceChecks(noArithmeticBinding, noArithmeticBinding.assessment).arithmeticErrorDetected, false);
  const rawMissing = structuredClone(long.assessment); rawMissing.criteria.pop();
  assert.equal(oral1000AcceptanceChecks(long, rawMissing).nineDistinctCriteria, false, 'Missing raw criteria cannot hide behind parser defaults');
  assert.deepEqual(r, original, 'Acceptance never changes graph, evidence or score');
  console.log('PASS: data/summary alternatives, arbitrary IDs, linked withdrawal evidence; missing/wrong-direction/method/unlocated evidence/duplicate relations/unrelated markers rejected; level contract, unknown-null, low-quality thresholds; immutable inputs. No cloud calls.');

  if (process.argv.includes('--recheck-saved')) {
    for (const directory of ['cloud-ojXdI6', 'cloud-PW1ZnA']) {
      const root = `.ui-preview/flow-acceptance/${directory}`;
      const bundleText = await readFile(`${root}/bundle.json`, 'utf8');
      const saved = JSON.parse(bundleText).analysisV2.record as ShadowRecord;
      const semanticChecks = oralAcceptanceChecks(saved);
      const review = { version: 'fixture-semantic-v2', semanticChecks, passed: Object.values(semanticChecks).every(Boolean),
        originalResultUnchanged: true, modelCalls: 0, limit: 'Only targeted fixture assertions, not whole-graph accuracy or score calibration.' };
      await writeFile(`${root}/semantic-recheck-v2.json`, JSON.stringify(review, null, 2), { flag: 'wx' });
      assert.equal(await readFile(`${root}/bundle.json`, 'utf8'), bundleText);
      console.log(JSON.stringify({ directory, ...review }));
    }
  }
} finally { globalThis.fetch = priorFetch; }
