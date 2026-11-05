import assert from 'node:assert/strict';
import { argumentContextFixture } from './argument-context-fixture.ts';
import { fixedAcceptProjectionReview, fixedProjectionSelection } from './argument-projection-build-fixture.ts';
import { argumentCanonicalTextHash } from '../src/services/argumentContext/hash.ts';
import { prepareArgumentProjectionBuild, readArgumentProjectionDraft, buildArgumentProjectionReviewInput,
  buildArgumentProjectionSourceReviewInput, readArgumentProjectionSourceReview, finalizeArgumentProjectionBuild,
  verifyArgumentProjectionBuildResult } from '../src/services/argumentContext/construction.ts';
import { readArgumentProjectionSelection } from '../src/services/argumentContext/modelDraftSelection.ts';
import { buildArgumentProjectionSourceReviewRequest, ARGUMENT_PROJECTION_SOURCE_REVIEW_PROMPT,
  ARGUMENT_PROJECTION_EXTRACTION_PROMPT, ARGUMENT_PROJECTION_SELECTION_PROMPT } from '../src/services/argumentContext/buildPrompts.ts';
import { ARGUMENT_PROJECTION_SOURCE_REVIEW_PROTOCOL, ARGUMENT_PROJECTION_BUILD_LIMITS,
  type ArgumentProjectionBuildInput, type ArgumentProjectionDraft, type ArgumentProjectionSourceReview,
  type ArgumentProjectionSourceReviewInput } from '../src/services/argumentContext/buildTypes.ts';

// All votes/obligations below are explicit test fixtures. They are neither cloud-model accuracy
// evidence nor automatically inferred edges. No files, private source/config, network or writes.
const previousFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('Source-grounded review checks forbid network');
const copy = <T>(value: T): T => structuredClone(value);
let checks = 0;
const pass = (label: string) => { checks++; console.log(`PASS ${label}`); };
async function source(lines: string[]): Promise<ArgumentProjectionBuildInput> {
  const f = await argumentContextFixture('uploaded-document'), canonicalText = lines.join('\r\n');
  let offset = 0;
  const sentences = lines.map((quote, i) => {
    const row = { id: `s${i + 1}`, blockId: `b${i + 1}`, start: offset, end: offset + quote.length, quote };
    offset += quote.length + 2; return row;
  });
  return prepareArgumentProjectionBuild({ source: { ...f.projection.source,
    contentHash: await argumentCanonicalTextHash(canonicalText) }, canonicalText, scope: f.scope,
    hierarchy: { sections: [{ id: 'test-section', path: '合成原文审核', parentId: null }], sentences,
      blocks: sentences.map((s, i) => ({ id: s.blockId, kind: 'paragraph', sectionId: 'test-section',
        start: s.start, end: s.end, previousId: i ? sentences[i - 1].blockId : null,
        nextId: i + 1 < sentences.length ? sentences[i + 1].blockId : null,
        locator: { kind: 'text', charStart: s.start, charEnd: s.end } })) },
    chunks: [{ id: 'test-chunk', start: 0, end: canonicalText.length, content: canonicalText,
      sentenceIds: sentences.map(s => s.id), forcedSplit: false }],
    sourceQualification: { status: 'eligible', policyVersion: 'synthetic-policy-test-only', evidence: [{
      sentenceId: sentences[0].id, start: 0, end: sentences[0].end, quote: sentences[0].quote }] } });
}
function quote(input: ArgumentProjectionBuildInput, text: string): string {
  const item = input.quotes.find(q => q.evidence.quote === text);
  assert.ok(item, `Synthetic fixture needs real exact Q: ${text}`); return item.quoteId;
}
/** Explicit synthetic all-accept votes and explicit empty source inventory, never repair/production. */
function votes(input: ArgumentProjectionSourceReviewInput): ArgumentProjectionSourceReview {
  const v1 = fixedAcceptProjectionReview(input);
  return { ...v1, version: 2, protocol: ARGUMENT_PROJECTION_SOURCE_REVIEW_PROTOCOL,
    nodes: v1.nodes.map(row => ({ ...row, completeMeaning: true })),
    sourceCoverage: input.sourceCoverageTargets.map(row => ({ ...row, decision: 'accept',
      reason: '合成固定原文扫描票：该句检查完毕。', restrictions: [], inferences: [] })) };
}
const lines = ['本次合成包裹带有蓝印。',
  '本实验约定带有蓝印的包裹会进入二号通道，所以本次合成包裹会进入二号通道。',
  '只有系统已联网时，本次分拣推断才成立。'];
function conditional(input: ArgumentProjectionBuildInput): ArgumentProjectionDraft {
  const fact = quote(input, lines[0]), rule = quote(input, '本实验约定带有蓝印的包裹会进入二号通道，');
  const actual = quote(input, '所以本次合成包裹会进入二号通道。'), link = quote(input, lines[1]);
  const condition = quote(input, '只有系统已联网时，'), limitingSentence = quote(input, lines[2]);
  return { version: 1, buildId: input.buildId,
    nodes: [{ id: 'N1', role: 'fact', quoteIds: [fact] }, { id: 'N2', role: 'premise', quoteIds: [rule] },
      { id: 'N3', role: 'conclusion', quoteIds: [actual] }, { id: 'N4', role: 'condition', quoteIds: [condition] }],
    relations: [{ id: 'E1', sourceNodeId: 'N1', targetNodeId: 'N3', kind: 'support', quoteIds: [link] },
      { id: 'E2', sourceNodeId: 'N2', targetNodeId: 'N3', kind: 'support', quoteIds: [link] },
      { id: 'E3', sourceNodeId: 'N4', targetNodeId: 'N3', kind: 'requires_condition', quoteIds: [limitingSentence] }],
    groups: [{ id: 'G1', conclusionNodeId: 'N3', premiseNodeIds: ['N1', 'N2'], conditionNodeIds: ['N4'],
      relationIds: ['E1', 'E2', 'E3'], operator: 'all', quoteIds: [fact, link, limitingSentence] }],
    scopes: [{ id: 'S1', seedNodeId: 'N3', task: 'reasoning', requiredNodeIds: ['N1', 'N2', 'N3', 'N4'],
      requiredRelationIds: ['E1', 'E2', 'E3'], requiredGroupIds: ['G1'], quoteIds: [fact, link, limitingSentence] }] };
}
function obligations(input: ArgumentProjectionBuildInput, reviewInput: ArgumentProjectionSourceReviewInput): ArgumentProjectionSourceReview {
  const review = votes(reviewInput), q = (text: string) => quote(input, text);
  review.sourceCoverage[1].inferences = [{ conclusionQuoteIds: [q('所以本次合成包裹会进入二号通道。')],
    premiseQuoteIds: [q(lines[0]), q('本实验约定带有蓝印的包裹会进入二号通道，')],
    conditionQuoteIds: [q('只有系统已联网时，')], operator: 'all' }];
  review.sourceCoverage[2].restrictions = [{ kind: 'requires_condition', sourceQuoteIds: [q('只有系统已联网时，')],
    targetQuoteIds: [q('所以本次合成包裹会进入二号通道。')] }];
  return review;
}
function orphan(input: ArgumentProjectionBuildInput): ArgumentProjectionDraft {
  const draft = conditional(input);
  draft.groups[0].conditionNodeIds = []; draft.groups[0].relationIds = ['E1', 'E2'];
  draft.nodes.push({ id: 'N5', role: 'claim', quoteIds: [quote(input, '本次分拣推断才成立。')] });
  draft.relations[2].targetNodeId = 'N5';
  draft.groups.push({ id: 'G2', conclusionNodeId: 'N5', premiseNodeIds: [], conditionNodeIds: ['N4'],
    relationIds: ['E3'], operator: 'all', quoteIds: [quote(input, lines[2])] });
  draft.scopes[0].requiredNodeIds = ['N1', 'N2', 'N3']; draft.scopes[0].requiredRelationIds = ['E1', 'E2'];
  draft.scopes.push({ id: 'S2', seedNodeId: 'N5', task: 'condition', requiredNodeIds: ['N4', 'N5'],
    requiredRelationIds: ['E3'], requiredGroupIds: ['G2'], quoteIds: [quote(input, lines[2])] });
  return draft;
}
try {
  const input = await source(lines), draft = conditional(input), reviewInput = await buildArgumentProjectionSourceReviewInput(input, draft);
  const legacyInput = await buildArgumentProjectionReviewInput(input, draft), review = obligations(input, reviewInput);
  assert.notEqual(reviewInput.reviewId, legacyInput.reviewId);
  assert.equal(reviewInput.draftHash, legacyInput.draftHash); assert.equal(reviewInput.sourceBindingHash, input.sourceBindingHash);
  assert.deepEqual(reviewInput.sourceCoverageTargets.map(row => row.sentenceId), input.hierarchy.sentences.map(row => row.id));
  assert.ok(reviewInput.sourceCoverageTargets.every(row => input.quotes.find(q => q.quoteId === row.quoteId)!.completeSentence));
  pass('v2 review binds unchanged draft/full source plus every true complete-sentence target; legacy hash stays distinct');

  const request = await buildArgumentProjectionSourceReviewRequest(input, draft), payload = JSON.parse(request.userInput);
  assert.equal(request.bindingId, reviewInput.reviewId); assert.equal(payload.protocol, ARGUMENT_PROJECTION_SOURCE_REVIEW_PROTOCOL);
  assert.equal(payload.outputContract.suppliedVotes, 'none'); assert.ok(payload.outputContract.rowSchemas.nodes.fields.includes('completeMeaning'));
  assert.equal(request.skipProfileInjection, true); assert.equal(request.skipMemoryInjection, true);
  assert.ok(request.systemPrompt.length + request.userInput.length <= ARGUMENT_PROJECTION_BUILD_LIMITS.requestCharacters);
  assert.ok(!Object.hasOwn(payload, 'sourceQualification') && !Object.hasOwn(payload, 'scope'));
  pass('new bounded source review request carries closed type-only contracts, not votes/profile/quality hints');

  assert.deepEqual(await readArgumentProjectionSourceReview(JSON.stringify(review), reviewInput), review);
  assert.deepEqual(await readArgumentProjectionSourceReview(review, reviewInput), review);
  const result = await finalizeArgumentProjectionBuild(input, draft, review);
  assert.equal(result.status, 'reviewed_complete'); assert.deepEqual(result.projection.build.gaps, []);
  assert.equal(result.projection.nodes.find(n => n.id === 'N4')!.admission, 'admitted');
  assert.equal(result.projection.build.scopes[0].status, 'reviewed_for_scope');
  await verifyArgumentProjectionBuildResult(result, { input, draft, review });
  pass('real rule/fact/complete condition predicate + actual conclusion obligations pass; source-v2 proof roundtrip replays');

  const bad = orphan(input), badInput = await buildArgumentProjectionSourceReviewInput(input, bad), badReview = obligations(input, badInput);
  const v1BadInput = await buildArgumentProjectionReviewInput(input, bad);
  assert.equal((await finalizeArgumentProjectionBuild(input, bad, fixedAcceptProjectionReview(v1BadInput))).status, 'reviewed_complete');
  const held = await finalizeArgumentProjectionBuild(input, bad, badReview);
  assert.equal(held.status, 'reviewed_partial'); assert.equal(held.projection.build.scopes[0].status, 'partial');
  assert.ok(held.projection.build.gaps.some(g => g.code === 'missing_prerequisite' && g.targetId === 'N3'));
  assert.equal(held.projection.relations.find(e => e.id === 'E3')!.targetNodeId, 'N5');
  assert.deepEqual(held.projection.prerequisiteGroups[0].conditionNodeIds, []);
  await verifyArgumentProjectionBuildResult(held, { input, draft: bad, review: badReview });
  pass('actual bad graph only constrains orphan N5: independent original Q points to N3, host holds without repairing graph');

  const omitted = copy(draft); omitted.nodes.pop(); omitted.relations.pop();
  omitted.groups[0].conditionNodeIds = []; omitted.groups[0].relationIds = ['E1', 'E2'];
  omitted.scopes[0].requiredNodeIds = ['N1', 'N2', 'N3']; omitted.scopes[0].requiredRelationIds = ['E1', 'E2'];
  const omittedReview = obligations(input, await buildArgumentProjectionSourceReviewInput(input, omitted));
  assert.equal((await finalizeArgumentProjectionBuild(input, omitted, omittedReview)).status, 'reviewed_partial');
  pass('candidate omits condition entirely: real source obligation cannot self-authorise an absent node/edge/group member');

  const wrongScope = copy(draft); wrongScope.scopes[0].requiredGroupIds = [];
  wrongScope.scopes[0].requiredNodeIds = ['N1', 'N2', 'N3']; wrongScope.scopes[0].requiredRelationIds = ['E1', 'E2'];
  const scopeResult = await finalizeArgumentProjectionBuild(input, wrongScope,
    obligations(input, await buildArgumentProjectionSourceReviewInput(input, wrongScope)));
  assert.equal(scopeResult.status, 'reviewed_partial'); assert.equal(scopeResult.projection.build.scopes[0].status, 'partial');
  pass('correct global graph cannot wash a task scope that omits the real condition or necessary group');

  const contradictory = copy(draft); contradictory.groups[0].conditionNodeIds = [];
  contradictory.groups[0].relationIds = ['E1', 'E2'];
  const contradictoryInput = await buildArgumentProjectionSourceReviewInput(input, contradictory);
  const contradictoryReview = obligations(input, contradictoryInput);
  contradictoryReview.sourceCoverage[1].inferences[0].conditionQuoteIds = [];
  const contradictionResult = await finalizeArgumentProjectionBuild(input, contradictory, contradictoryReview);
  assert.equal(contradictionResult.status, 'reviewed_partial'); assert.equal(contradictionResult.projection.build.scopes[0].status, 'partial');
  assert.ok(contradictionResult.projection.build.gaps.some(g => g.code === 'missing_prerequisite' && g.targetId === 'N3'));
  pass('inconsistent independent inventories cannot disclose requires_condition then accept an empty-condition inference group');

  const scanMissedInference = copy(contradictoryReview); scanMissedInference.sourceCoverage[1].inferences = [];
  const groupMismatch = await finalizeArgumentProjectionBuild(input, contradictory, scanMissedInference);
  assert.equal(groupMismatch.status, 'reviewed_partial'); assert.equal(groupMismatch.projection.build.scopes[0].status, 'partial');
  assert.ok(groupMismatch.projection.build.gaps.some(g => g.code === 'missing_prerequisite' && g.targetId === 'G1'));
  pass('disclosed source condition also constrains every existing actual-conclusion necessary group even when inference inventory missed it');

  const extraGroup = copy(draft); extraGroup.groups.push({ ...copy(draft.groups[0]), id: 'G2',
    premiseNodeIds: ['N1'], relationIds: ['E1', 'E3'] });
  extraGroup.scopes[0].requiredGroupIds.push('G2');
  const extraGroupReview = obligations(input, await buildArgumentProjectionSourceReviewInput(input, extraGroup));
  const extraGroupResult = await finalizeArgumentProjectionBuild(input, extraGroup, extraGroupReview);
  assert.equal(extraGroupResult.status, 'reviewed_partial'); assert.equal(extraGroupResult.projection.build.scopes[0].status, 'partial');
  assert.ok(extraGroupResult.projection.build.gaps.some(g => g.code === 'missing_prerequisite' && g.targetId === 'G2'));
  pass('a correct G1 cannot launder another accepted G2 that omits an independently disclosed actual premise');

  const routeLines = ['包裹甲带蓝印。', '包裹甲已经登记许可。',
    '本实验规定：蓝印包裹或已经登记许可的包裹可以进入二号通道。', '所以包裹甲可以进入二号通道。'];
  const routeInput = await source(routeLines), qr = (i: number) => quote(routeInput, routeLines[i]);
  const routes: ArgumentProjectionDraft = { version: 1, buildId: routeInput.buildId,
    nodes: [{ id: 'N1', role: 'fact', quoteIds: [qr(0)] }, { id: 'N2', role: 'fact', quoteIds: [qr(1)] },
      { id: 'N3', role: 'premise', quoteIds: [qr(2)] }, { id: 'N4', role: 'conclusion', quoteIds: [qr(3)] }],
    relations: [{ id: 'E1', sourceNodeId: 'N1', targetNodeId: 'N4', kind: 'support', quoteIds: [qr(2)] },
      { id: 'E2', sourceNodeId: 'N3', targetNodeId: 'N4', kind: 'support', quoteIds: [qr(2)] },
      { id: 'E3', sourceNodeId: 'N2', targetNodeId: 'N4', kind: 'support', quoteIds: [qr(2)] }],
    groups: [{ id: 'G1', conclusionNodeId: 'N4', premiseNodeIds: ['N1', 'N3'], conditionNodeIds: [],
      relationIds: ['E1', 'E2'], operator: 'all', quoteIds: [qr(0), qr(2), qr(3)] },
    { id: 'G2', conclusionNodeId: 'N4', premiseNodeIds: ['N2', 'N3'], conditionNodeIds: [],
      relationIds: ['E3', 'E2'], operator: 'all', quoteIds: [qr(1), qr(2), qr(3)] }],
    scopes: [{ id: 'S1', seedNodeId: 'N4', task: 'reasoning', requiredNodeIds: ['N1', 'N2', 'N3', 'N4'],
      requiredRelationIds: ['E1', 'E2', 'E3'], requiredGroupIds: ['G1', 'G2'], quoteIds: routeLines.map((_, i) => qr(i)) }] };
  const routeReview = votes(await buildArgumentProjectionSourceReviewInput(routeInput, routes));
  routeReview.sourceCoverage[3].inferences = [{ conclusionQuoteIds: [qr(3)], premiseQuoteIds: [qr(0), qr(2)], conditionQuoteIds: [], operator: 'all' },
    { conclusionQuoteIds: [qr(3)], premiseQuoteIds: [qr(1), qr(2)], conditionQuoteIds: [], operator: 'all' }];
  assert.equal((await finalizeArgumentProjectionBuild(routeInput, routes, routeReview)).status, 'reviewed_complete');
  pass('two original independent legitimate routes to the same conclusion are each matched, not hard-locked to a unique group');

  const definitionLines = ['蓝印就绪指本次包裹可以接收派送任务。', '只有系统已联网时，蓝印就绪才成立。',
    '离线维护中的包裹是蓝印就绪的例外，不能接收派送任务。', '示例包裹甲可用于说明蓝印就绪，但例子不构成定义。'];
  const definitionInput = await source(definitionLines), qd = (i: number) => quote(definitionInput, definitionLines[i]);
  const definition: ArgumentProjectionDraft = { version: 1, buildId: definitionInput.buildId,
    nodes: [{ id: 'N1', role: 'definition', quoteIds: [qd(0)] }, { id: 'N2', role: 'condition', quoteIds: [qd(1)] },
      { id: 'N3', role: 'exception', quoteIds: [qd(2)] }, { id: 'N4', role: 'example', quoteIds: [qd(3)] }],
    relations: [{ id: 'E1', sourceNodeId: 'N2', targetNodeId: 'N1', kind: 'requires_condition', quoteIds: [qd(1)] },
      { id: 'E2', sourceNodeId: 'N3', targetNodeId: 'N1', kind: 'exception_of', quoteIds: [qd(2)] },
      { id: 'E3', sourceNodeId: 'N4', targetNodeId: 'N1', kind: 'illustrates', quoteIds: [qd(3)] }], groups: [],
    scopes: [{ id: 'S1', seedNodeId: 'N1', task: 'definition', requiredNodeIds: ['N1', 'N2', 'N3'],
      requiredRelationIds: ['E1', 'E2'], requiredGroupIds: [], quoteIds: [qd(0), qd(1), qd(2)] },
    { id: 'S2', seedNodeId: 'N4', task: 'example', requiredNodeIds: ['N4'], requiredRelationIds: [], requiredGroupIds: [], quoteIds: [qd(3)] }] };
  const definitionReview = votes(await buildArgumentProjectionSourceReviewInput(definitionInput, definition));
  definitionReview.sourceCoverage[1].restrictions = [{ kind: 'requires_condition', sourceQuoteIds: [qd(1)], targetQuoteIds: [qd(0)] }];
  definitionReview.sourceCoverage[2].restrictions = [{ kind: 'exception_of', sourceQuoteIds: [qd(2)], targetQuoteIds: [qd(0)] }];
  const definitionResult = await finalizeArgumentProjectionBuild(definitionInput, definition, definitionReview);
  assert.equal(definitionResult.status, 'reviewed_complete');
  assert.ok(!definitionResult.projection.build.scopes[0].requiredNodeIds.includes('N4'));
  assert.equal(definitionResult.projection.build.scopes[1].status, 'reviewed_for_scope');
  assert.deepEqual(definitionResult.projection.prerequisiteGroups, []);
  pass('minimal definition retains necessary condition + exception; optional example has independent legal scope, no fabricated proof');

  const missingException = copy(definition); missingException.scopes[0].requiredNodeIds = ['N1', 'N2'];
  missingException.scopes[0].requiredRelationIds = ['E1'];
  const missingExceptionReview = copy(definitionReview);
  missingExceptionReview.reviewId = (await buildArgumentProjectionSourceReviewInput(definitionInput, missingException)).reviewId;
  const exceptionResult = await finalizeArgumentProjectionBuild(definitionInput, missingException, missingExceptionReview);
  assert.equal(exceptionResult.status, 'reviewed_partial'); assert.equal(exceptionResult.projection.build.scopes[0].status, 'partial');
  pass('definition cannot omit source-named exception, even when exception exists globally and all scope votes true');

  const badExceptionGroup = copy(definition); badExceptionGroup.groups = [{ id: 'G1', conclusionNodeId: 'N1', premiseNodeIds: [],
    conditionNodeIds: ['N3'], relationIds: ['E2'], operator: 'all', quoteIds: [qd(2)] }];
  await assert.rejects(readArgumentProjectionDraft(badExceptionGroup, definitionInput), /argument_projection_invalid_group_relation/u);
  await assert.rejects(readArgumentProjectionSelection(fixedProjectionSelection(badExceptionGroup), definitionInput), /argument_projection_invalid_group_relation/u);
  const wrongTarget = copy(draft); wrongTarget.groups[0].conclusionNodeId = 'N2';
  await assert.rejects(readArgumentProjectionDraft(wrongTarget, input), /argument_projection_invalid_group_members|argument_projection_invalid_group_relation/u);
  pass('exception_of and wrong-target group edges retain strict upstream rejection in both draft protocols, never auto-reconnected');

  for (const modify of [(r: ArgumentProjectionSourceReview) => { r.sourceCoverage.pop(); },
    (r: ArgumentProjectionSourceReview) => { r.sourceCoverage[1].decision = 'unknown'; },
    (r: ArgumentProjectionSourceReview) => { r.sourceCoverage[1].decision = 'reject'; },
    (r: ArgumentProjectionSourceReview) => { r.sourceCoverage = []; }]) {
    const partial = copy(review); modify(partial);
    await readArgumentProjectionSourceReview(partial, reviewInput);
    const actual = await finalizeArgumentProjectionBuild(input, draft, partial);
    assert.equal(actual.status, 'reviewed_partial'); assert.equal(actual.projection.build.scopes[0].status, 'partial');
    assert.ok(actual.projection.build.gaps.some(g => g.code === 'structure_unreviewed'));
  }
  pass('missing/reject/unknown sentence coverage is explicit partial rather than implicit accept or discarded obligation');

  const incompleteNode = copy(review); incompleteNode.nodes[2].completeMeaning = false;
  await assert.rejects(readArgumentProjectionSourceReview(incompleteNode, reviewInput), /argument_projection_unsupported_accept/u);
  incompleteNode.nodes[2].decision = 'unknown';
  const nodeHeld = await finalizeArgumentProjectionBuild(input, draft, incompleteNode);
  assert.equal(nodeHeld.projection.nodes.find(n => n.id === 'N3')!.admission, 'audit_only');
  assert.equal(nodeHeld.status, 'reviewed_partial');
  const missingMeaning = copy(review); delete (missingMeaning.nodes[0] as Partial<typeof missingMeaning.nodes[0]>).completeMeaning;
  await assert.rejects(readArgumentProjectionSourceReview(missingMeaning, reviewInput), /argument_projection_invalid_shape/u);
  pass('completeMeaning is an explicit required semantic vote; missing/false accept rejected, unknown never promoted');

  for (const modify of [
    (r: ArgumentProjectionSourceReview) => { r.sourceCoverage[0].quoteId = quote(input, '只有系统已联网时，'); },
    (r: ArgumentProjectionSourceReview) => { r.sourceCoverage[0].sentenceId = 'unknown'; },
    (r: ArgumentProjectionSourceReview) => { r.sourceCoverage[0] = copy(r.sourceCoverage[1]); },
    (r: ArgumentProjectionSourceReview) => { r.sourceCoverage[2].restrictions[0].targetQuoteIds = ['Q999']; },
    (r: ArgumentProjectionSourceReview) => { r.sourceCoverage[0].restrictions = copy(r.sourceCoverage[2].restrictions); },
    (r: ArgumentProjectionSourceReview) => { Object.assign(r.sourceCoverage[2].restrictions[0], { kind: 'support' }); },
    (r: ArgumentProjectionSourceReview) => { Object.assign(r.sourceCoverage[2].restrictions[0], { targetNodeId: 'N3' }); },
    (r: ArgumentProjectionSourceReview) => { Object.assign(r.sourceCoverage[2], { complete: true }); },
    (r: ArgumentProjectionSourceReview) => { delete (r as Partial<typeof r>).sourceCoverage; },
  ]) { const malformed = copy(review); modify(malformed); await assert.rejects(readArgumentProjectionSourceReview(malformed, reviewInput)); }
  pass('closed source scan rejects fabricated targets, duplicate sentences, nonlocal obligations, node IDs/extra fields; no patch-up');

  let getterCalls = 0; const getter = copy(review);
  Object.defineProperty(getter.sourceCoverage[0], 'reason', { enumerable: true, get: () => { getterCalls++; return 'not run'; } });
  await assert.rejects(readArgumentProjectionSourceReview(getter, reviewInput));
  await assert.rejects(finalizeArgumentProjectionBuild(input, draft, getter)); assert.equal(getterCalls, 0);
  const inputGetter = copy(reviewInput);
  Object.defineProperty(inputGetter, 'canonicalText', { enumerable: true, get: () => { getterCalls++; return 'not run'; } });
  await assert.rejects(readArgumentProjectionSourceReview(review, inputGetter)); assert.equal(getterCalls, 0);
  for (const modify of [(r: ArgumentProjectionSourceReview) => Object.defineProperty(r, 'hidden', { value: true }),
    (r: ArgumentProjectionSourceReview) => Object.defineProperty(r, 'length', { value: true }),
    (r: ArgumentProjectionSourceReview) => Object.defineProperty(r.nodes[0], 'length', { value: true }),
    (r: ArgumentProjectionSourceReview) => Object.assign(r, { [Symbol('extra')]: 1 }),
    (r: ArgumentProjectionSourceReview) => { delete r.sourceCoverage[0]; },
  ]) { const malformed = copy(review); modify(malformed); await assert.rejects(readArgumentProjectionSourceReview(malformed, reviewInput)); }
  pass('raw/read/finalize never execute getters; hidden/symbol fields and sparse scans rejected before snapshot');

  const hiddenInput = copy(input); Object.defineProperty(hiddenInput, 'length', { value: 1 });
  await assert.rejects(buildArgumentProjectionSourceReviewInput(hiddenInput, draft));
  const hiddenDraft = copy(draft); Object.defineProperty(hiddenDraft.nodes[0], 'length', { value: 1 });
  await assert.rejects(buildArgumentProjectionSourceReviewInput(input, hiddenDraft));
  const hiddenReviewInput = copy(reviewInput); Object.defineProperty(hiddenReviewInput, 'length', { value: 1 });
  await assert.rejects(readArgumentProjectionSourceReview(review, hiddenReviewInput));
  pass('non-enumerable length is an exception only for arrays, never plain source/draft/review data objects');

  const serialized = JSON.stringify(review);
  for (const invalid of [serialized.replace('"version":2', '"version":1,"version":2'),
    serialized.replace('"version":2', '"ver\\u0073ion":1,"version":2'), '```json\n' + serialized + '\n```']) {
    await assert.rejects(readArgumentProjectionSourceReview(invalid, reviewInput));
    await assert.rejects(finalizeArgumentProjectionBuild(input, draft, invalid));
  }
  await assert.rejects(readArgumentProjectionSourceReview(fixedAcceptProjectionReview(legacyInput), reviewInput));
  await assert.rejects(finalizeArgumentProjectionBuild(input, draft, { ...review, protocol: 'old-or-invented' }));
  await assert.rejects(readArgumentProjectionSourceReview(' '.repeat(ARGUMENT_PROJECTION_BUILD_LIMITS.requestCharacters + 1), reviewInput), /response_budget/u);
  pass('actual raw path rejects duplicate/escaped keys, Markdown, legacy fallback, unknown protocol and response overbudget');

  const delayedInput = copy(reviewInput), delayedReview = copy(review), pending = readArgumentProjectionSourceReview(delayedReview, delayedInput);
  delayedInput.canonicalText = 'late mutation'; delayedReview.sourceCoverage[0].decision = 'unknown';
  assert.deepEqual(await pending, review);
  const delayedBuild = copy(input), delayedDraft = copy(draft), delayedVotes = copy(review);
  const finalPending = finalizeArgumentProjectionBuild(delayedBuild, delayedDraft, delayedVotes);
  delayedBuild.canonicalText = 'late'; delayedDraft.nodes[0].role = 'hypothesis'; delayedVotes.nodes[0].decision = 'unknown';
  assert.deepEqual(await finalPending, result);
  pass('full input/draft/raw captured before first await; late mutations cannot change the bound review or final result');

  for (const modify of [(i: ArgumentProjectionSourceReviewInput) => { i.sourceBindingHash = 'a'.repeat(64); },
    (i: ArgumentProjectionSourceReviewInput) => { i.draftHash = 'b'.repeat(64); },
    (i: ArgumentProjectionSourceReviewInput) => { i.sourceCoverageTargets.pop(); },
    (i: ArgumentProjectionSourceReviewInput) => { i.draft.nodes[0].role = 'hypothesis'; },
  ]) { const rebound = copy(reviewInput); modify(rebound); await assert.rejects(readArgumentProjectionSourceReview(review, rebound), /review_binding_mismatch/u); }
  const changedSource = copy(input); changedSource.source.version = 'different-generation';
  await assert.rejects(finalizeArgumentProjectionBuild(changedSource, draft, review));
  const changedResult = copy(result); changedResult.projection.build.scopes[0].requiredNodeIds = ['N3'];
  await assert.rejects(verifyArgumentProjectionBuildResult(changedResult, { input, draft, review }), /result_replay_mismatch/u);
  await assert.rejects(verifyArgumentProjectionBuildResult(result, { input, draft, review: fixedAcceptProjectionReview(legacyInput) }), /result_replay_mismatch/u);
  pass('source/draft/coverage hash substitution and forged result or legacy proof cannot authenticate v2 publication');

  let replayGetters = 0;
  const getterProof = { input: copy(input), draft: copy(draft), review: copy(review) };
  Object.defineProperty(getterProof, 'review', { enumerable: true, get: () => { replayGetters++; return review; } });
  await assert.rejects(verifyArgumentProjectionBuildResult(result, getterProof));
  const getterSourceProof = { input: copy(input), draft: copy(draft), review: copy(review) };
  Object.defineProperty(getterSourceProof.input, 'canonicalText', { enumerable: true,
    get: () => { replayGetters++; return input.canonicalText; } });
  await assert.rejects(verifyArgumentProjectionBuildResult(result, getterSourceProof));
  const getterResult = copy(result); Object.defineProperty(getterResult, 'status', { enumerable: true,
    get: () => { replayGetters++; return result.status; } });
  await assert.rejects(verifyArgumentProjectionBuildResult(getterResult, { input, draft, review }));
  const hiddenProof = { input: copy(input), draft: copy(draft), review: copy(review) };
  Object.defineProperty(hiddenProof.review, 'length', { value: 1 });
  await assert.rejects(verifyArgumentProjectionBuildResult(result, hiddenProof)); assert.equal(replayGetters, 0);
  const legacyReview = fixedAcceptProjectionReview(legacyInput);
  const legacyResult = await finalizeArgumentProjectionBuild(input, draft, legacyReview);
  await verifyArgumentProjectionBuildResult(legacyResult, { input, draft, review: legacyReview });
  pass('proof/result replay checks data before clone: all getters stay 0, hidden length rejected, plain historical v1 DTO still replays');

  const unknownOperator = copy(review); unknownOperator.sourceCoverage[1].inferences[0].operator = 'unknown';
  assert.equal((await finalizeArgumentProjectionBuild(input, draft, unknownOperator)).status, 'reviewed_partial');
  pass('unknown original joint operator stays a missing prerequisite, never auto-changed to all/accept');

  const missedAudit = votes(badInput), stillPossible = await finalizeArgumentProjectionBuild(input, bad, missedAudit);
  assert.equal(stillPossible.status, 'reviewed_complete');
  pass('KNOWN-RISK: model that semantically misses original restrictions/inference and falsely accepts all can still miss; not truth/completeness certification');

  for (const prompt of [ARGUMENT_PROJECTION_EXTRACTION_PROMPT, ARGUMENT_PROJECTION_SELECTION_PROMPT,
    ARGUMENT_PROJECTION_SOURCE_REVIEW_PROMPT]) {
    assert.match(prompt, /exception_of/u); assert.match(prompt, /example/u); assert.match(prompt, /实际/u);
    assert.match(prompt, /主语/u); assert.match(prompt, /不.*改写|不.*改图|不改写/u);
  }
  assert.match(ARGUMENT_PROJECTION_SOURCE_REVIEW_PROMPT, /不硬要求语法整句/u);
  pass('extraction/audit contracts distinguish complete role units, real conclusion targets, exception edges and minimal optional-example scope');
} finally { globalThis.fetch = previousFetch; }
console.log(`Argument source-grounded review checks passed: ${checks} groups (synthetic fixed votes; 0 model calls; 0 files/production writes).`);
