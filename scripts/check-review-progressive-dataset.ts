import assert from 'node:assert/strict';
import { REVIEW_PROGRESSIVE_DATASET, REVIEW_PROGRESSIVE_REFERENCES, judgeReviewProgressiveOutcome, summarizeReviewProgressiveReport,
  type ReviewProgressiveCase } from './review-progressive-dataset.ts';
import { prepareReviewProgressiveFixture, type ReviewProgressiveFixture } from './review-progressive-fixture.ts';
import { buildReviewProgressiveExtractionInput, buildReviewProgressiveReferenceInput } from './review-progressive-transport.ts';
import type { FrozenReferenceShadowResult } from '../src/services/reviewComparison/frozenReferenceShadow.ts';

const oldFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('Offline synthetic dataset checks forbid network');
let checks = 0;
const pass = (label: string) => { checks++; console.log(`PASS ${label}`); };

/** Explicit report-predicate fixture, NOT model output or semantic-accuracy evidence. */
function annotatedReportResult(testCase: ReviewProgressiveCase): FrozenReferenceShadowResult {
  return { version: 1, protocol: 'review-frozen-reference-shadow-v1', evaluationId: `offline-annotation-${testCase.id}`,
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
  assert.equal(REVIEW_PROGRESSIVE_DATASET.length, 12);
  assert.equal(new Set(REVIEW_PROGRESSIVE_DATASET.map(testCase => testCase.id)).size, 12);
  assert.ok(REVIEW_PROGRESSIVE_DATASET.every(testCase => testCase.origin === 'synthetic' && testCase.annotationStatus === 'assistant_draft'
    && testCase.fixture.theme === 'progressive-device-v1' && testCase.fixture.noteCount === 1 && testCase.consultedMaterialIds.length === 0));
  for (const task of ['definition', 'condition', 'reasoning'] as const) {
    const subset = REVIEW_PROGRESSIVE_DATASET.filter(testCase => testCase.task === task);
    assert.equal(subset.length, 4);
    assert.deepEqual(subset.map(testCase => testCase.category).sort(), ['paraphrase', 'missing_condition', task === 'reasoning' ? 'reverse_inference' : 'direct_opposition', 'strong_hint'].sort());
  }
  assert.equal(REVIEW_PROGRESSIVE_DATASET.filter(testCase => testCase.expected.frames[0].status === 'covered').length, 6);
  assert.equal(REVIEW_PROGRESSIVE_DATASET.filter(testCase => testCase.expected.frames[0].status === 'contradicted').length, 2);
  assert.equal(REVIEW_PROGRESSIVE_DATASET.filter(testCase => testCase.hintLevel === 4).length, 3);
  pass('12条均衡纯合成样本，三类各4；6正例/3遗漏/2真相反/1逆推，明确assistant_draft');

  const fixtures = new Map<string, ReviewProgressiveFixture>();
  for (const testCase of REVIEW_PROGRESSIVE_DATASET) {
    const fixture = await prepareReviewProgressiveFixture(testCase); fixtures.set(testCase.id, fixture);
    const source = REVIEW_PROGRESSIVE_REFERENCES[testCase.task], frame = fixture.context.frames[0];
    assert.equal(fixture.context.coverage, 'complete_required'); assert.equal(fixture.context.taskType, testCase.task);
    assert.equal(fixture.context.frames.length, 1); assert.equal(frame.frameId, 'target-1');
    assert.deepEqual(frame.items.map(({ itemId, criterionId, nodeIds, relationIds }) => ({ itemId, criterionId, nodeIds, relationIds })),
      source.selectedItems.map(({ itemId, criterionId, nodeIds, relationIds }) => ({ itemId, criterionId, nodeIds: [...nodeIds], relationIds: [...relationIds] })));
    assert.deepEqual(frame.nodes.map(({ id, role }) => ({ id, role })), source.structure.nodes.map(({ id, role }) => ({ id, role })));
    assert.deepEqual(frame.relations.map(({ id, sourceNodeId, targetNodeId, kind }) => ({ id, sourceNodeId, targetNodeId, kind })),
      source.structure.relations.map(({ id, sourceNodeId, targetNodeId, kind }) => ({ id, sourceNodeId, targetNodeId, kind })));
    assert.deepEqual(frame.groups, source.structure.groups.map(group => structuredClone(group)));
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
  pass('全部12条真实合成frame题前冻结与原契约回核合法，I/N/E/G及UTF16原文坐标逐项匹配配方');

  for (const testCase of REVIEW_PROGRESSIVE_DATASET) {
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
  const isolated = structuredClone(REVIEW_PROGRESSIVE_DATASET[0]);
  isolated.expected.rationale = 'THIS_ANNOTATION_MUST_NOT_REACH_MODEL'; isolated.expected.frames[0].status = 'contradicted';
  const altered = await prepareReviewProgressiveFixture(isolated), original = fixtures.get(isolated.id)!;
  assert.deepEqual(altered.packet, original.packet); assert.deepEqual(altered.context, original.context); assert.equal(altered.evaluationId, original.evaluationId);
  pass('groundtruth/分类/注释不进入两阶段模型包，改预期不会改实际参考、回答或绑定');

  const annotated = REVIEW_PROGRESSIVE_DATASET.map(testCase => judgeReviewProgressiveOutcome(testCase, annotatedReportResult(testCase)));
  assert.ok(annotated.every(outcome => outcome.passed));
  const report = summarizeReviewProgressiveReport(annotated);
  assert.equal(report.allCasesPass, true); assert.equal(report.annotationStatus, 'assistant_draft'); assert.equal(report.humanGold, false);
  assert.deepEqual(report.metrics.itemAgreement, { matched: 28, total: 28 });
  assert.deepEqual(report.metrics.directOpposition, { recognized: 2, total: 2 });
  assert.deepEqual(report.metrics.reverseInference, { safelyUncovered: 1, total: 1 });
  assert.deepEqual(report.metrics.assistanceClassification, { matched: 3, total: 3 });
  pass('报告predicate接受预审分类但不冒充模型准确率；28原题items及方向/帮助等级可单独统计');

  for (const testCase of REVIEW_PROGRESSIVE_DATASET) {
    const held = annotatedReportResult(testCase); held.status = 'held'; held.reasons = ['unsubstantiated_shadow_verdict']; held.frames = []; held.observations = [];
    held.modelRequests = { extract: 1, reference: 1, total: 2, limit: 2 };
    const outcome = judgeReviewProgressiveOutcome(testCase, held);
    assert.equal(outcome.passed, false); assert.equal(outcome.semanticPass, false); assert.equal(outcome.held, true);
    assert.equal(outcome.itemAgreement.matched, 0); assert.ok(outcome.failures.some(failure => failure.startsWith('status:held')));
  }
  pass('包括真相反在内，held不能作为符合groundtruth通过；模型安全拒绝与语义接受率分开');

  const unsafeCases = REVIEW_PROGRESSIVE_DATASET.filter(testCase => testCase.expected.noFalseCovered);
  const falseCovered = unsafeCases.map(testCase => {
    const result = annotatedReportResult(testCase); result.frames[0].status = 'covered';
    return judgeReviewProgressiveOutcome(testCase, result);
  });
  assert.equal(falseCovered.length, 6); assert.ok(falseCovered.every(outcome => outcome.falseCovered && !outcome.passed));
  assert.equal(summarizeReviewProgressiveReport(falseCovered).metrics.falseCovered, 6);
  pass('遗漏、直接相反、逆向6例误covered显式计数，不靠overall平均掩盖');

  for (const testCase of REVIEW_PROGRESSIVE_DATASET.filter(testCase => testCase.category === 'strong_hint')) {
    const wrong = annotatedReportResult(testCase); wrong.evidence = 'independent';
    const outcome = judgeReviewProgressiveOutcome(testCase, wrong);
    assert.equal(outcome.semanticPass, true); assert.equal(outcome.evidencePass, false); assert.equal(outcome.passed, false);
    assert.ok(outcome.failures.some(failure => failure.startsWith('evidence:')));
  }
  pass('强提示后的内容合格和独立证据是两个轴，不能以covered冒充independent');

  const missing = summarizeReviewProgressiveReport(annotated.slice(1)); assert.equal(missing.allCasesPass, false); assert.deepEqual(missing.missingCaseIds, ['D01']);
  const duplicate = summarizeReviewProgressiveReport([...annotated, annotated[0]]); assert.equal(duplicate.allCasesPass, false); assert.deepEqual(duplicate.duplicateOrUnknownCaseIds, ['D01']);
  assert.equal(duplicate.uniqueCases, 11); assert.equal(duplicate.metrics.endToEnd.total, 11);
  const unknown = structuredClone(annotated[0]); unknown.caseId = 'UNKNOWN';
  assert.equal(summarizeReviewProgressiveReport([...annotated, unknown]).allCasesPass, false);
  assert.deepEqual(summarizeReviewProgressiveReport([...annotated, unknown]).duplicateOrUnknownCaseIds, ['UNKNOWN']);
  assert.equal(summarizeReviewProgressiveReport([]).allCasesPass, false);
  pass('缺失、重复、未知或零样本不能产生全通过，重复不得抬高分母分子');

  const reverse = REVIEW_PROGRESSIVE_DATASET.find(testCase => testCase.category === 'reverse_inference')!;
  assert.deepEqual(reverse.expected.frames[0].items[2].verdicts, ['partial', 'unverifiable']);
  assert.equal(reverse.expected.frames[0].status, 'partial');
  const alternative = annotatedReportResult(reverse); alternative.observations[2].verdict = 'unverifiable';
  assert.equal(judgeReviewProgressiveOutcome(reverse, alternative).passed, true);
  alternative.observations[2].verdict = 'contradicted'; assert.equal(judgeReviewProgressiveOutcome(reverse, alternative).passed, false);
  alternative.observations[2].verdict = 'supported'; assert.equal(judgeReviewProgressiveOutcome(reverse, alternative).passed, false);
  const wrongDirection = annotatedReportResult(reverse); wrongDirection.observations[2].direction = 'correct';
  assert.equal(judgeReviewProgressiveOutcome(reverse, wrongDirection).passed, false);
  pass('逆命题不可据此推出不等于事实必假，只允许指定partial/unverifiable且必须识别reverse');

  const incomplete = annotatedReportResult(REVIEW_PROGRESSIVE_DATASET[0]); incomplete.observations.pop();
  assert.equal(judgeReviewProgressiveOutcome(REVIEW_PROGRESSIVE_DATASET[0], incomplete).passed, false);
  const duplicateItem = annotatedReportResult(REVIEW_PROGRESSIVE_DATASET[0]); duplicateItem.observations[1] = structuredClone(duplicateItem.observations[0]);
  assert.equal(judgeReviewProgressiveOutcome(REVIEW_PROGRESSIVE_DATASET[0], duplicateItem).passed, false);
  for (const mutate of [
    (result: FrozenReferenceShadowResult) => { (result as unknown as { scoreWrite: string }).scoreWrite = 'enabled'; },
    (result: FrozenReferenceShadowResult) => { (result as unknown as { cognitionWrite: string }).cognitionWrite = 'enabled'; },
    (result: FrozenReferenceShadowResult) => { result.modelRequests.total = 3; result.modelRequests.extract = 2; },
  ]) {
    const invalid = annotatedReportResult(REVIEW_PROGRESSIVE_DATASET[0]); mutate(invalid);
    assert.equal(judgeReviewProgressiveOutcome(REVIEW_PROGRESSIVE_DATASET[0], invalid).safetyPass, false);
    assert.equal(judgeReviewProgressiveOutcome(REVIEW_PROGRESSIVE_DATASET[0], invalid).passed, false);
  }
  pass('漏项/重复项/正式写入标签/超过两请求均失败，predicate不是另一个宽松评分通道');
  console.log(`Review progressive dataset: ${checks} offline groups passed; 12 synthetic contracts, assistant draft annotations, 0 cloud/model/real-vault/score/cognition writes.`);
} finally { globalThis.fetch = oldFetch; }
