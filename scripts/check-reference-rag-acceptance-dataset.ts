import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { NoteItem } from '../src/types.ts';
import type { ArgumentReferenceDisclosureContext } from '../src/services/argumentContext/referenceDisclosure.ts';
import type { FrozenReferenceShadowResult } from '../src/services/reviewComparison/frozenReferenceShadow.ts';
import { freezeReviewAssessment } from '../src/services/reviewAssessment.ts';
import { buildReviewReferenceCatalog, freezeReviewReferenceRubric, type ReviewReferenceRubric } from '../src/services/reviewReferenceRubric.ts';
import { ACCEPTANCE_FIXTURE_CONDITION, ACCEPTANCE_FIXTURE_DEFINITION, ACCEPTANCE_FIXTURE_REASONING } from './reference-disclosure-fixture.ts';
import { REVIEW_PROGRESSIVE_ACCEPTANCE_DATASET, REVIEW_PROGRESSIVE_ACCEPTANCE_REFERENCES } from './review-progressive-acceptance-dataset.ts';
import type { ReviewProgressiveCase } from './review-progressive-dataset.ts';
import { REFERENCE_RAG_ACCEPTANCE_BUDGET, REFERENCE_RAG_ACCEPTANCE_DATASET, REFERENCE_RAG_ACCEPTANCE_DATASET_VERSION,
  REFERENCE_RAG_ACCEPTANCE_SOURCES, assertPreAnswerRubric, judgeReferenceRagAcceptanceOutcome,
  referenceRagAcceptanceFingerprintContent, summarizeReferenceRagAcceptanceReport,
  type ReferenceRagAcceptanceSourceOutcome } from './reference-rag-acceptance-dataset.ts';

const oldFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('Synthetic dataset checks forbid network');
let checks = 0;
const pass = (label: string) => { checks++; console.log(`PASS ${label}`); };
const tasks = ['definition', 'condition', 'reasoning'] as const;

/** Predicate-only disclosure DTO: deliberately not a production graph, authority
 * receipt, fixed-review builder, persistent source store or model result. The
 * catalog/assessment/rubric below do use their real pure source selectors. */
async function predicateRubric(testCase: ReviewProgressiveCase) {
  const source = REFERENCE_RAG_ACCEPTANCE_SOURCES[testCase.task], noteId = `predicate-note-${testCase.task}`;
  const note: NoteItem = { id: noteId, title: `predicate-${testCase.task}`, noteType: 'knowledge', content: source.content,
    createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T01:00:00.000Z', tags: [], links: [], backlinks: [], dueDates: [] };
  const catalog = await buildReviewReferenceCatalog([note], [note.title], [note.id]);
  const assessment = freezeReviewAssessment(testCase.task, [note.title]);
  const byCriterion = new Map<string, string[]>();
  for (const selector of source.selectors) {
    const candidate = catalog.candidates.find(value => value.start === selector.start && value.end === selector.end && value.quote === selector.text);
    assert.ok(candidate, `No fixed paragraph candidate: ${testCase.task}/${selector.itemId}`);
    const ids = byCriterion.get(selector.criterionId) ?? []; ids.push(candidate.candidateId); byCriterion.set(selector.criterionId, ids);
  }
  const marker = [...byCriterion].map(([criterion, ids]) => `${criterion}=${ids.join(',')}`).join(';');
  const rubric = freezeReviewReferenceRubric(marker, assessment, catalog);
  assert.equal(rubric.status, 'fixed');
  const frame: ArgumentReferenceDisclosureContext['frames'][number] = { frameId: 'target-1', knowledgeTarget: note.title,
    source: { kind: 'knowledge-note', entityId: note.id, version: note.updatedAt, coordinateSpace: 'saved-note-utf16',
      contentHash: 'a'.repeat(64), structureHash: 'b'.repeat(64) },
    items: source.selectors.map((selector, index) => ({ itemId: selector.itemId, criterionId: selector.criterionId,
      quoteId: `Q${index + 1}`, nodeIds: [`model-node-${index + 7}`], relationIds: [] })),
    nodes: source.selectors.map((_selector, index) => ({ id: `model-node-${index + 7}`, role: 'fact', quoteIds: [`Q${index + 1}`] })),
    relations: [], groups: [] };
  const context: ArgumentReferenceDisclosureContext = { version: 1, protocol: 'review-frozen-reference-context-v1',
    contractHash: 'c'.repeat(64), rubricHash: 'd'.repeat(64), originQuestionMessageId: `predicate-question-${testCase.id}`,
    taskType: testCase.task, assessment, policy: 'all_target_frames', coverage: 'complete_required', frames: [frame],
    quotes: source.selectors.map((selector, index) => ({ quoteId: `Q${index + 1}`, sourceKey: 'e'.repeat(64),
      start: selector.start, end: selector.end, text: selector.text })), limitations: { semanticTruth: 'not_certified', writes: 'disabled' } };
  return { rubric, context };
}
function predicateResult(testCase: ReviewProgressiveCase): FrozenReferenceShadowResult {
  return { version: 1, protocol: 'review-frozen-reference-shadow-v1', evaluationId: `predicate-result-${testCase.id}`,
    status: 'reviewed', reasons: [], evidence: testCase.expected.evidence,
    observations: testCase.expected.frames.flatMap(frame => frame.items.map(item => ({ frameId: frame.frameId, itemId: item.itemId,
      verdict: item.verdicts[0], claimIds: ['predicate-only'], edgeIds: [], nodeIds: [], relationIds: [], nodeMappings: [],
      axes: { object: 'match', metric: 'not_applicable', condition: 'match', time: 'not_applicable', certainty: 'match' },
      direction: item.direction ?? 'not_required', premises: item.premises ?? 'not_required' }))),
    frames: testCase.expected.frames.map(frame => ({ frameId: frame.frameId, knowledgeTarget: `predicate-${testCase.task}`, status: frame.status })),
    scope: 'frozen_question_items', semanticTruth: 'not_certified', scoreWrite: 'disabled', cognitionWrite: 'disabled',
    modelRequests: { extract: 1, reference: 1, total: 2, limit: 2 } };
}
const sources: ReferenceRagAcceptanceSourceOutcome[] = tasks.map(task => ({ sourceId: REFERENCE_RAG_ACCEPTANCE_SOURCES[task].sourceId,
  task, status: 'published', modelRequests: { structure: 3, propositions: 2, total: 5 } }));

try {
  assert.equal(REFERENCE_RAG_ACCEPTANCE_DATASET_VERSION, 'reference-rag-source-to-answer-acceptance-v1');
  assert.equal(REFERENCE_RAG_ACCEPTANCE_DATASET, REVIEW_PROGRESSIVE_ACCEPTANCE_DATASET);
  assert.equal(REFERENCE_RAG_ACCEPTANCE_DATASET.length, 8);
  assert.deepEqual(tasks.map(task => REFERENCE_RAG_ACCEPTANCE_DATASET.filter(value => value.task === task).length), [3, 2, 3]);
  assert.deepEqual(REFERENCE_RAG_ACCEPTANCE_DATASET.map(value => value.id), ['VD01', 'VD02', 'VD03', 'VC01', 'VC02', 'VR01', 'VR02', 'VR03']);
  assert.equal(REFERENCE_RAG_ACCEPTANCE_DATASET.flatMap(value => value.expected.frames[0].items).length, 19);
  pass('沿用原8题3/2/3分布及19固定item，原expected/方向/证据等级未改动');

  for (const [task, paragraphs] of [['definition', ACCEPTANCE_FIXTURE_DEFINITION], ['condition', ACCEPTANCE_FIXTURE_CONDITION],
    ['reasoning', ACCEPTANCE_FIXTURE_REASONING]] as const) {
    const source = REFERENCE_RAG_ACCEPTANCE_SOURCES[task], prior = REVIEW_PROGRESSIVE_ACCEPTANCE_REFERENCES[task];
    assert.deepEqual(source.sourceParagraphs, paragraphs); assert.equal(source.content, paragraphs.join('\n\n'));
    assert.equal(source.content.includes('\r'), false); assert.equal(source.selectors.length, prior.selectedItems.length);
    for (const [index, selector] of source.selectors.entries()) {
      const original = prior.selectedItems[index];
      assert.equal(selector.itemId, original.itemId); assert.equal(selector.criterionId, original.criterionId);
      assert.equal(selector.paragraphIndex, original.paragraphIndex); assert.equal(selector.text, paragraphs[original.paragraphIndex]);
      assert.equal(source.content.slice(selector.start, selector.end), selector.text);
      assert.equal(selector.end - selector.start, selector.text.length);
    }
  }
  const implementation = await readFile(new URL('./reference-rag-acceptance-dataset.ts', import.meta.url), 'utf8');
  assert.ok(!/createReferenceDisclosureFixture|prepareReviewProgressiveFixture|fixedAcceptProjectionReview/u.test(implementation));
  assert.ok(!/from\s+['"].*(?:config|apiConfig|referenceSourcePropositionStore|argumentProjectionStore)/u.test(implementation));
  pass('3个共享源固定原始LF正文/坐标，只复用数据常量，不导入调用旧固定图/审核构建器');

  assert.deepEqual(REFERENCE_RAG_ACCEPTANCE_BUDGET, { sources: 3, sourceCallsPerSource: 5, sourceRequests: 15,
    answerCallsPerCase: 2, answerRequests: 16, totalRequests: 31, authorizationMaximum: 56, automaticRetries: 0 });
  assert.ok(REFERENCE_RAG_ACCEPTANCE_BUDGET.totalRequests <= REFERENCE_RAG_ACCEPTANCE_BUDGET.authorizationMaximum);
  const fingerprint = referenceRagAcceptanceFingerprintContent();
  assert.deepEqual(fingerprint.cases, REVIEW_PROGRESSIVE_ACCEPTANCE_DATASET); assert.deepEqual(fingerprint.sources, REFERENCE_RAG_ACCEPTANCE_SOURCES);
  assert.equal(fingerprint.rubricRegistration.mapping, 'identity_only_pre_answer'); assert.equal(fingerprint.rubricRegistration.sourceLineEndings, 'LF');
  pass('共享源最多15＋8题回答16=31次无重试，56只是授权上限，fingerprint包含预登记数据');

  const prepared = new Map<string, Awaited<ReturnType<typeof predicateRubric>>>();
  const registered = new Map<string, ReturnType<typeof assertPreAnswerRubric>>();
  for (const testCase of REFERENCE_RAG_ACCEPTANCE_DATASET) {
    const value = await predicateRubric(testCase); prepared.set(testCase.id, value);
    const registration = assertPreAnswerRubric(testCase, value); registered.set(testCase.id, registration);
    assert.deepEqual(registration.itemMappings.map(item => [item.expectedItemId, item.actualItemId, item.criterionId]),
      testCase.expected.frames[0].items.map(item => [item.itemId, item.itemId, item.criterionId]));
    assert.ok(Object.isFrozen(registration) && Object.isFrozen(registration.itemMappings));
    assert.ok(registration.itemMappings.every(Object.isFrozen));
  }
  pass('逐题答前核对真实纯catalog/rubric和DTO原段落，登记不可变identity映射；不猜模型图节点');

  const first = REFERENCE_RAG_ACCEPTANCE_DATASET[0], original = prepared.get(first.id)!;
  const mutations: Array<(value: { rubric: ReviewReferenceRubric; context: ArgumentReferenceDisclosureContext }) => void> = [
    value => { value.rubric.status = 'unavailable'; }, value => { value.context.coverage = 'frame_subset'; },
    value => { value.context.frames[0].frameId = 'target-2'; }, value => { value.rubric.items[0].itemId = 'I9'; },
    value => { value.context.frames[0].items[0].criterionId = 'fact_scope'; }, value => { value.rubric.items[0].criterionId = 'condition_scope'; },
    value => { value.context.quotes[0].start++; value.context.quotes[0].end++; }, value => { value.context.quotes[0].text = '根据响应重新选的资料'; },
    value => { value.context.frames[0].source.entityId = 'another-note'; }, value => { value.rubric.items.reverse(); },
    value => { value.context.frames[0].items.pop(); }, value => { value.context.quotes.push(structuredClone(value.context.quotes[0])); },
  ];
  for (const mutation of mutations) { const altered = structuredClone(original); mutation(altered); assert.throws(() => assertPreAnswerRubric(first, altered)); }
  assert.throws(() => assertPreAnswerRubric(first, { rubric: original.rubric, context: undefined! }));
  const changedExpected = structuredClone(first); changedExpected.expected.frames[0].items[0].verdicts = ['contradicted'];
  assert.throws(() => assertPreAnswerRubric(changedExpected, original));
  pass('held/缺context/不同frame/item/criterion/原文坐标/源/乱序及修改expected均拒绝答前登记');

  const complete = REFERENCE_RAG_ACCEPTANCE_DATASET.map(testCase => judgeReferenceRagAcceptanceOutcome(testCase,
    predicateResult(testCase), registered.get(testCase.id)));
  assert.ok(complete.every(value => value.passed));
  const report = summarizeReferenceRagAcceptanceReport(complete, sources);
  assert.equal(report.allCasesPass, true); assert.equal(report.sourceSetComplete, true); assert.equal(report.budgetValid, true);
  assert.deepEqual(report.metrics.itemAgreement, { matched: 19, total: 19 }); assert.equal(report.sourceRequests, 15);
  assert.equal(report.answerRequestUpperBound, 16); assert.equal(report.totalRequestUpperBound, 31);
  assert.equal(report.referenceReviewer, 'configured_model_with_host_replay'); assert.equal(report.humanGold, false);
  assert.equal(report.semanticTruth, 'not_certified'); assert.equal(report.scoreWrite, 'disabled'); assert.equal(report.cognitionWrite, 'disabled');
  pass('完整8题predicate-only结果＋3已处理源才能全通过，19项/31预算；非模型正确率或正式掌握度');

  for (const testCase of REFERENCE_RAG_ACCEPTANCE_DATASET) {
    const held = predicateResult(testCase); held.status = 'held'; held.reasons = ['source_or_question_not_ready']; held.frames = []; held.observations = [];
    for (const registration of [registered.get(testCase.id), null]) {
      const outcome = judgeReferenceRagAcceptanceOutcome(testCase, held, registration);
      assert.equal(outcome.passed, false); assert.equal(outcome.semanticPass, false); assert.equal(outcome.held, true);
    }
    const noRegistration = judgeReferenceRagAcceptanceOutcome(testCase, predicateResult(testCase));
    assert.equal(noRegistration.passed, false); assert.ok(noRegistration.failures.includes('pre_answer_rubric_not_registered'));
    const clonedRegistration = structuredClone(registered.get(testCase.id)!);
    assert.equal(judgeReferenceRagAcceptanceOutcome(testCase, predicateResult(testCase), clonedRegistration).passed, false);
  }
  assert.equal(judgeReferenceRagAcceptanceOutcome(first, predicateResult(first), registered.get('VD02')).passed, false);
  pass('held/无答前登记/克隆伪造登记/别题登记都失败，不以安全拒绝冒充语义通过');

  const reverse = REFERENCE_RAG_ACCEPTANCE_DATASET.find(value => value.id === 'VR02')!, reverseRegistration = registered.get('VR02');
  const alternate = predicateResult(reverse); alternate.observations[2].verdict = 'unverifiable';
  assert.equal(judgeReferenceRagAcceptanceOutcome(reverse, alternate, reverseRegistration).passed, true);
  for (const verdict of ['contradicted', 'supported'] as const) {
    const wrong = predicateResult(reverse); wrong.observations[2].verdict = verdict;
    assert.equal(judgeReferenceRagAcceptanceOutcome(reverse, wrong, reverseRegistration).passed, false);
  }
  const wrongDirection = predicateResult(reverse); wrongDirection.observations[2].direction = 'correct';
  assert.equal(judgeReferenceRagAcceptanceOutcome(reverse, wrongDirection, reverseRegistration).passed, false);
  const assisted = REFERENCE_RAG_ACCEPTANCE_DATASET.find(value => value.id === 'VC01')!, wrongEvidence = predicateResult(assisted);
  wrongEvidence.evidence = 'independent'; assert.equal(judgeReferenceRagAcceptanceOutcome(assisted, wrongEvidence, registered.get('VC01')).passed, false);
  pass('逆推保持partial/unverifiable且reverse，不能报实际相反；强提示不能冒充独立掌握');

  for (const alteredSources of [[], sources.slice(1), [...sources, sources[0]],
    sources.map((source, index) => index ? source : { ...source, status: 'held' as const }),
    sources.map((source, index) => index ? source : { ...source, status: 'not_processed' as const, modelRequests: { structure: 0, propositions: 0, total: 0 } }),
    sources.map((source, index) => index ? source : { ...source, modelRequests: { structure: 4, propositions: 2, total: 6 } }),
    sources.map((source, index) => index ? source : { ...source, modelRequests: { structure: 3, propositions: 2, total: 4 } }),
  ]) assert.equal(summarizeReferenceRagAcceptanceReport(complete, alteredSources).allCasesPass, false);
  assert.equal(summarizeReferenceRagAcceptanceReport([], sources).allCasesPass, false);
  assert.equal(summarizeReferenceRagAcceptanceReport(complete.slice(1), sources).allCasesPass, false);
  assert.equal(summarizeReferenceRagAcceptanceReport([...complete, complete[0]], sources).allCasesPass, false);
  const differentTask = structuredClone(complete[0]); differentTask.task = 'condition';
  assert.equal(summarizeReferenceRagAcceptanceReport([differentTask, ...complete.slice(1)], sources).allCasesPass, false);
  const changedGold = structuredClone(complete[0]); changedGold.expected.frames[0].status = 'contradicted';
  assert.equal(summarizeReferenceRagAcceptanceReport([changedGold, ...complete.slice(1)], sources).allCasesPass, false);
  pass('源未处理/源held/重复/越预算/漏题不能全通过，期望与结果始终按固定case匹配');

  const badItem = predicateResult(first); badItem.observations[0].itemId = 'I99';
  assert.equal(judgeReferenceRagAcceptanceOutcome(first, badItem, registered.get(first.id)).passed, false);
  const badFrame = predicateResult(first); badFrame.observations[0].frameId = 'target-2';
  assert.equal(judgeReferenceRagAcceptanceOutcome(first, badFrame, registered.get(first.id)).passed, false);
  const missingItem = predicateResult(first); missingItem.observations.pop();
  assert.equal(judgeReferenceRagAcceptanceOutcome(first, missingItem, registered.get(first.id)).passed, false);
  pass('结果少item/换item/换frame均失败，不依据响应重新映射参考项');
  console.log(`Reference RAG acceptance dataset: ${checks} offline groups passed; 3 shared synthetic sources, unchanged 8 cases/19 items, maximum 31 requests, 0 cloud/config/real-vault/score/cognition writes.`);
} finally { globalThis.fetch = oldFetch; }
