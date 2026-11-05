import assert from 'node:assert/strict';
import { REVIEW_PROGRESSIVE_DATASET, judgeReviewProgressiveOutcome, type ReviewProgressiveCase } from './review-progressive-dataset.ts';
import { REVIEW_PROGRESSIVE_ACCEPTANCE_DATASET, REVIEW_PROGRESSIVE_ACCEPTANCE_DATASET_VERSION,
  REVIEW_PROGRESSIVE_ACCEPTANCE_REFERENCES, summarizeReviewProgressiveAcceptanceReport } from './review-progressive-acceptance-dataset.ts';
import { prepareReviewProgressiveFixture, type ReviewProgressiveFixture } from './review-progressive-fixture.ts';
import { buildReviewProgressiveExtractionInput, buildReviewProgressiveReferenceInput } from './review-progressive-transport.ts';
import type { FrozenReferenceShadowResult } from '../src/services/reviewComparison/frozenReferenceShadow.ts';

const oldFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('Offline acceptance dataset checks forbid network');
let checks = 0;
const pass = (label: string) => { checks++; console.log(`PASS ${label}`); };

/** Explicit predicate-only result fixture: no model output or accuracy claim. */
function annotatedReportResult(testCase: ReviewProgressiveCase): FrozenReferenceShadowResult {
  return { version: 1, protocol: 'review-frozen-reference-shadow-v1', evaluationId: `offline-acceptance-${testCase.id}`,
    status: 'reviewed', reasons: [], evidence: testCase.expected.evidence,
    observations: testCase.expected.frames.flatMap(frame => frame.items.map(item => ({ frameId: frame.frameId, itemId: item.itemId,
      verdict: item.verdicts[0], claimIds: ['report-predicate-only'], edgeIds: [], nodeIds: [], relationIds: [], nodeMappings: [],
      axes: { object: 'match', metric: 'not_applicable', condition: 'match', time: 'not_applicable', certainty: 'match' },
      direction: item.direction ?? 'not_required', premises: item.premises ?? 'not_required' }))),
    frames: testCase.expected.frames.map(frame => ({ frameId: frame.frameId, knowledgeTarget: 'synthetic-report-predicate', status: frame.status })),
    scope: 'frozen_question_items', semanticTruth: 'not_certified', scoreWrite: 'disabled', cognitionWrite: 'disabled',
    modelRequests: { extract: 1, reference: 1, total: 2, limit: 2 } };
}

try {
  assert.equal(REVIEW_PROGRESSIVE_ACCEPTANCE_DATASET_VERSION, 'review-progressive-acceptance-v3-draft-v1');
  assert.equal(REVIEW_PROGRESSIVE_ACCEPTANCE_DATASET.length, 8);
  assert.equal(new Set(REVIEW_PROGRESSIVE_ACCEPTANCE_DATASET.map(testCase => testCase.id)).size, 8);
  assert.ok(REVIEW_PROGRESSIVE_ACCEPTANCE_DATASET.every(testCase => testCase.origin === 'synthetic'
    && testCase.annotationStatus === 'assistant_draft' && testCase.fixture.theme === 'progressive-parcel-v1'
    && testCase.fixture.noteCount === 1 && testCase.consultedMaterialIds.length === 0));
  assert.deepEqual(['definition', 'condition', 'reasoning'].map(task => REVIEW_PROGRESSIVE_ACCEPTANCE_DATASET.filter(testCase => testCase.task === task).length), [3, 2, 3]);
  assert.deepEqual(['paraphrase', 'missing_condition', 'direct_opposition', 'reverse_inference', 'strong_hint']
    .map(category => REVIEW_PROGRESSIVE_ACCEPTANCE_DATASET.filter(testCase => testCase.category === category).length), [2, 2, 2, 1, 1]);
  assert.equal(REVIEW_PROGRESSIVE_ACCEPTANCE_DATASET.filter(testCase => testCase.expected.frames[0].status === 'covered').length, 3);
  assert.equal(REVIEW_PROGRESSIVE_ACCEPTANCE_DATASET.filter(testCase => testCase.expected.frames[0].status === 'contradicted').length, 2);
  assert.equal(REVIEW_PROGRESSIVE_ACCEPTANCE_DATASET.filter(testCase => testCase.hintLevel === 4).length, 1);
  pass('8条有限合成pilot：3完整/2遗漏/2实际反义/1逆推，19固定items；assistant_draft非human gold');

  for (const testCase of REVIEW_PROGRESSIVE_ACCEPTANCE_DATASET) {
    assert.ok(!REVIEW_PROGRESSIVE_DATASET.some(old => old.id === testCase.id || old.answer === testCase.answer || old.question === testCase.question));
    assert.ok(!/青灯|训练指令|超阈值|报警/u.test(testCase.question + testCase.answer + (testCase.hint ?? '')));
    assert.equal(testCase.expected.noFalseCovered, testCase.expected.frames[0].status !== 'covered');
    assert.equal(testCase.fixture.task, testCase.task);
    assert.ok(testCase.expected.frames[0].items.every(item => item.rationale.trim() && item.verdicts.length));
  }
  const sourceText = Object.values(REVIEW_PROGRESSIVE_ACCEPTANCE_REFERENCES).flatMap(reference => reference.sourceParagraphs).join('\n');
  assert.ok(sourceText.includes('蓝印') && !/青灯|训练指令|超阈值|报警/u.test(sourceText));
  pass('独立新措辞与新虚构事实，不修改原12题，不声称完全盲测或独立人工标注');

  const fixtures = new Map<string, ReviewProgressiveFixture>();
  for (const testCase of REVIEW_PROGRESSIVE_ACCEPTANCE_DATASET) {
    const fixture = await prepareReviewProgressiveFixture(testCase); fixtures.set(testCase.id, fixture);
    const source = REVIEW_PROGRESSIVE_ACCEPTANCE_REFERENCES[testCase.task], frame = fixture.context.frames[0];
    assert.equal(fixture.context.coverage, 'complete_required'); assert.equal(fixture.context.taskType, testCase.task);
    assert.equal(fixture.context.frames.length, 1); assert.equal(frame.frameId, 'target-1');
    assert.deepEqual(frame.items.map(({ itemId, criterionId, nodeIds, relationIds }) => ({ itemId, criterionId, nodeIds, relationIds })),
      source.selectedItems.map(({ itemId, criterionId, nodeIds, relationIds }) => ({ itemId, criterionId, nodeIds: [...nodeIds], relationIds: [...relationIds] })));
    assert.deepEqual(frame.nodes.map(({ id, role }) => ({ id, role })), source.nodes.map(node => structuredClone(node)));
    assert.deepEqual(frame.relations.map(({ id, sourceNodeId, targetNodeId, kind }) => ({ id, sourceNodeId, targetNodeId, kind })),
      source.relations.map(relation => structuredClone(relation)));
    assert.deepEqual(frame.groups, source.groups.map(group => structuredClone(group)));
    assert.deepEqual(frame.items.map(({ itemId, criterionId }) => ({ itemId, criterionId })), testCase.expected.frames[0].items.map(({ itemId, criterionId }) => ({ itemId, criterionId })));
    for (const selection of source.selectedItems) {
      const selectedItem = frame.items.find(item => item.itemId === selection.itemId)!;
      const quote = fixture.context.quotes.find(quote => quote.quoteId === selectedItem.quoteId)!;
      assert.equal(quote.text, source.sourceParagraphs[selection.paragraphIndex]);
      assert.equal(source.sourceParagraphs.join('\r\n\r\n').slice(quote.start, quote.end), quote.text);
    }
    const encoded = JSON.stringify(fixture.context);
    assert.ok(!encoded.includes(source.sourceParagraphs[3]) && !encoded.includes(source.sourceParagraphs[testCase.task === 'reasoning' ? 3 : 2]));
    assert.equal((await fixture.dependencies.readReference(fixture.answer.evidence.questionIntent)).status, 'ready');
  }
  pass('8题真实内存资料frame题前冻结、I/N/E/G与原文UTF16坐标匹配；固定synthetic reviewer不冒充语义证书');

  for (const testCase of REVIEW_PROGRESSIVE_ACCEPTANCE_DATASET) {
    const fixture = fixtures.get(testCase.id)!, extractInput = buildReviewProgressiveExtractionInput(fixture);
    const extraction = { content: JSON.stringify({ version: 1, packetId: fixture.packet.packetId,
      claims: [{ id: 'A1', role: 'fact', quote: testCase.answer }], edges: [], requirements: [] }), provider: 'offline-mock', model: 'offline-mock' };
    const reviewInput = buildReviewProgressiveReferenceInput(fixture, extraction);
    for (const value of [extractInput, reviewInput, fixture.packet, fixture.context]) {
      const encoded = JSON.stringify(value);
      for (const key of ['"expected"', '"annotationStatus"', '"rationale"', '"category"', '"noFalseCovered"', 'assistant_draft']) assert.ok(!encoded.includes(key));
      assert.ok(!encoded.includes(testCase.expected.rationale));
    }
    assert.equal(extractInput.answer.text, testCase.answer);
    assert.ok(!Object.hasOwn(extractInput, 'reference') && !Object.hasOwn(extractInput, 'personal'));
    assert.ok(!Object.hasOwn(reviewInput, 'personal') && !Object.hasOwn(reviewInput, 'profile'));
  }
  const isolated = structuredClone(REVIEW_PROGRESSIVE_ACCEPTANCE_DATASET[0]);
  isolated.expected.rationale = 'ACCEPTANCE_ANNOTATION_MUST_NOT_REACH_MODEL'; isolated.expected.frames[0].status = 'contradicted';
  const altered = await prepareReviewProgressiveFixture(isolated), original = fixtures.get(isolated.id)!;
  assert.deepEqual(altered.packet, original.packet); assert.deepEqual(altered.context, original.context); assert.equal(altered.evaluationId, original.evaluationId);
  pass('预标注/分类/expected不泄漏到两阶段模型包，改expected不改参考、回答、receipt或evaluation绑定');

  const annotated = REVIEW_PROGRESSIVE_ACCEPTANCE_DATASET.map(testCase => judgeReviewProgressiveOutcome(testCase, annotatedReportResult(testCase)));
  assert.ok(annotated.every(outcome => outcome.passed));
  const report = summarizeReviewProgressiveAcceptanceReport(annotated);
  assert.equal(report.allCasesPass, true); assert.equal(report.datasetVersion, REVIEW_PROGRESSIVE_ACCEPTANCE_DATASET_VERSION);
  assert.equal(report.annotationStatus, 'assistant_draft'); assert.equal(report.humanGold, false);
  assert.equal(report.blindHoldout, false); assert.equal(report.referenceReviewer, 'fixed_synthetic');
  assert.deepEqual(report.metrics.itemAgreement, { matched: 19, total: 19 });
  assert.deepEqual(report.metrics.directionAgreement, { matched: 2, total: 2 });
  assert.deepEqual(report.metrics.directOpposition, { recognized: 2, total: 2 });
  assert.deepEqual(report.metrics.reverseInference, { safelyUncovered: 1, total: 1 });
  assert.deepEqual(report.metrics.assistanceClassification, { matched: 1, total: 1 });
  pass('新摘要只统计8题19项及2方向；predicate-only结果不冒充模型正确率或正式掌握度');

  for (const testCase of REVIEW_PROGRESSIVE_ACCEPTANCE_DATASET) {
    const held = annotatedReportResult(testCase); held.status = 'held'; held.reasons = ['unsubstantiated_shadow_verdict']; held.frames = []; held.observations = [];
    const outcome = judgeReviewProgressiveOutcome(testCase, held);
    assert.equal(outcome.passed, false); assert.equal(outcome.semanticPass, false); assert.equal(outcome.held, true); assert.equal(outcome.itemAgreement.matched, 0);
  }
  const falseCovered = REVIEW_PROGRESSIVE_ACCEPTANCE_DATASET.filter(testCase => testCase.expected.noFalseCovered).map(testCase => {
    const result = annotatedReportResult(testCase); result.frames[0].status = 'covered'; return judgeReviewProgressiveOutcome(testCase, result);
  });
  assert.equal(falseCovered.length, 5); assert.ok(falseCovered.every(outcome => outcome.falseCovered && !outcome.passed));
  assert.equal(summarizeReviewProgressiveAcceptanceReport(falseCovered).metrics.falseCovered, 5);
  pass('held不是符合预期，5个遗漏/反义/逆推误covered单独计数，不能靠安全拒绝冒充语义通过');

  const assisted = REVIEW_PROGRESSIVE_ACCEPTANCE_DATASET.find(testCase => testCase.category === 'strong_hint')!;
  assert.ok(assisted.hint && assisted.hintLevel === 4); assert.equal(assisted.expected.evidence, 'assisted_not_independent');
  const assistedWrong = annotatedReportResult(assisted); assistedWrong.evidence = 'independent';
  const assistedOutcome = judgeReviewProgressiveOutcome(assisted, assistedWrong);
  assert.equal(assistedOutcome.semanticPass, true); assert.equal(assistedOutcome.evidencePass, false); assert.equal(assistedOutcome.passed, false);
  pass('强提示后的完整回答只是帮助后表现，不能当独立掌握证据');

  const reverse = REVIEW_PROGRESSIVE_ACCEPTANCE_DATASET.find(testCase => testCase.category === 'reverse_inference')!;
  assert.equal(reverse.expected.frames[0].status, 'partial'); assert.deepEqual(reverse.expected.frames[0].items[2].verdicts, ['partial', 'unverifiable']);
  assert.equal(reverse.expected.frames[0].items[2].direction, 'reverse'); assert.equal(reverse.expected.frames[0].items[2].premises, 'complete');
  const alternative = annotatedReportResult(reverse); alternative.observations[2].verdict = 'unverifiable';
  assert.equal(judgeReviewProgressiveOutcome(reverse, alternative).passed, true);
  for (const verdict of ['contradicted', 'supported'] as const) {
    alternative.observations[2].verdict = verdict; assert.equal(judgeReviewProgressiveOutcome(reverse, alternative).passed, false);
  }
  const wrongDirection = annotatedReportResult(reverse); wrongDirection.observations[2].direction = 'correct';
  assert.equal(judgeReviewProgressiveOutcome(reverse, wrongDirection).passed, false);
  const actualOpposition = REVIEW_PROGRESSIVE_ACCEPTANCE_DATASET.find(testCase => testCase.id === 'VR03')!;
  assert.deepEqual(actualOpposition.expected.frames[0].items[2].verdicts, ['contradicted']);
  assert.equal(actualOpposition.expected.frames[0].items[2].direction, undefined);
  assert.equal(actualOpposition.expected.frames[0].items[2].premises, undefined);
  pass('同结论逆推只能partial/unverifiable且标reverse；实际结论反义允许协议内直接见证不强锁推理编码');

  const empty = summarizeReviewProgressiveAcceptanceReport([]);
  assert.equal(empty.allCasesPass, false); assert.equal(empty.observedCases, 0); assert.equal(empty.expectedCases, 8);
  assert.deepEqual(empty.metrics.endToEnd, { matched: 0, total: 0 }); assert.equal(empty.missingCaseIds.length, 8);
  const missing = summarizeReviewProgressiveAcceptanceReport(annotated.slice(1)); assert.equal(missing.allCasesPass, false); assert.deepEqual(missing.missingCaseIds, ['VD01']);
  const duplicate = summarizeReviewProgressiveAcceptanceReport([...annotated, annotated[0]]); assert.equal(duplicate.allCasesPass, false);
  assert.deepEqual(duplicate.duplicateOrUnknownCaseIds, ['VD01']); assert.equal(duplicate.uniqueCases, 7); assert.equal(duplicate.metrics.endToEnd.total, 7);
  const unknown = structuredClone(annotated[0]); unknown.caseId = 'D01';
  const mixed = summarizeReviewProgressiveAcceptanceReport([...annotated, unknown]); assert.equal(mixed.allCasesPass, false);
  assert.deepEqual(mixed.duplicateOrUnknownCaseIds, ['D01']); assert.equal(mixed.uniqueCases, 8);
  pass('空准备/缺题/重复/旧题混入均不产生全通过，重复不能抬高分子分母');

  const first = REVIEW_PROGRESSIVE_ACCEPTANCE_DATASET[0];
  const incomplete = annotatedReportResult(first); incomplete.observations.pop(); assert.equal(judgeReviewProgressiveOutcome(first, incomplete).passed, false);
  for (const mutate of [
    (result: FrozenReferenceShadowResult) => { (result as unknown as { scoreWrite: string }).scoreWrite = 'enabled'; },
    (result: FrozenReferenceShadowResult) => { (result as unknown as { cognitionWrite: string }).cognitionWrite = 'enabled'; },
    (result: FrozenReferenceShadowResult) => { result.modelRequests.total = 3; result.modelRequests.extract = 2; },
  ]) {
    const invalid = annotatedReportResult(first); mutate(invalid);
    assert.equal(judgeReviewProgressiveOutcome(first, invalid).safetyPass, false); assert.equal(judgeReviewProgressiveOutcome(first, invalid).passed, false);
  }
  pass('漏固定item/正式分数或认知写入/超过2请求均失败，新pilot不打开宽松旁路');
  console.log(`Review progressive acceptance dataset: ${checks} offline groups passed; 8 synthetic contracts, 19 fixed items, assistant draft only, 0 cloud/model/real-vault/score/cognition writes.`);
} finally { globalThis.fetch = oldFetch; }
