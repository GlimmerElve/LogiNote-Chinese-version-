import assert from 'node:assert/strict';
import { argumentProjectionBuildFixture, fixedAcceptProjectionReview } from './argument-projection-build-fixture';
import { argumentContextHash, argumentCanonicalTextHash } from '../src/services/argumentContext/hash';
import { prepareArgumentProjectionBuild, validateArgumentProjectionBuildInput, readArgumentProjectionDraft,
  buildArgumentProjectionReviewInput, finalizeArgumentProjectionBuild, verifyArgumentProjectionBuildResult } from '../src/services/argumentContext/construction';
import { getArgumentProjectionReviewRowDiagnostic } from '../src/services/argumentContext/construction';
import { ARGUMENT_PROJECTION_REVIEW_ROW_SCHEMAS } from '../src/services/argumentContext/buildTypes';
import { buildArgumentProjectionExtractionRequest, buildArgumentProjectionReviewRequest } from '../src/services/argumentContext/buildPrompts';
import { createArgumentProjectionPublicationStore, type ArgumentProjectionPublicationRequest } from '../src/services/argumentContext/publication';
import { createArgumentContextPointer, readArgumentContextPack } from '../src/services/argumentContext/reader';
import type { ArgumentProjectionBuildProof } from '../src/services/argumentContext/buildTypes';

const fetchBefore = globalThis.fetch;
globalThis.fetch = async () => assert.fail('No network permitted in projection construction checks');
let checks = 0;
const pass = (name: string) => { checks++; console.log(`PASS ${name}`); };
const fixture = argumentProjectionBuildFixture;
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function finish(f: Fixture) { return finalizeArgumentProjectionBuild(f.input, f.draft, f.review); }
function proof(f: Fixture): ArgumentProjectionBuildProof { return { input: f.input, draft: f.draft, review: f.review }; }
async function publicationRequest(f: Fixture, publicationId = 'publication-A', expectedActiveHash: string | null = null): Promise<ArgumentProjectionPublicationRequest> {
  return { publicationId, result: await finish(f), proof: proof(f), scope: f.input.scope, currentSource: f.input.source, expectedActiveHash };
}
async function rejectDraft(f: Fixture, mutate: (x: any) => void) { const raw = structuredClone(f.draft); mutate(raw); await assert.rejects(readArgumentProjectionDraft(raw, f.input)); }
async function rejectReview(f: Fixture, mutate: (x: any) => void) { const raw = structuredClone(f.review); mutate(raw); await assert.rejects(finalizeArgumentProjectionBuild(f.input, f.draft, raw)); }

try {
  const f = await fixture();
  assert.deepEqual(f.input, await prepareArgumentProjectionBuild(f.sourceInput));
  await validateArgumentProjectionBuildInput(f.input);
  assert.ok(f.input.quotes.some((q) => !q.completeSentence));
  for (const q of f.input.quotes) assert.equal(f.input.canonicalText.slice(q.evidence.start, q.evidence.end), q.evidence.quote);
  assert.ok(f.input.quotes.every((q) => q.chunkIds.length));
  assert.equal(f.input.limitations.productionWrites, 'disabled');
  pass('全源版本目录+实际chunks逐字回核，整句/子句Q不改CRLF或emoji，物理候选不自动生成逻辑');

  const result = await finish(f);
  assert.equal(result.status, 'reviewed_complete'); assert.equal(result.projection.quality.status, 'eligible');
  assert.ok(result.projection.nodes.every((n) => n.admission === 'admitted' && n.semanticStatus === 'reviewed'));
  assert.equal(result.projection.relations.find((e) => e.id === 'E4')!.sourceNodeId, 'N4');
  assert.equal(result.projection.relations.find((e) => e.id === 'E4')!.targetNodeId, 'N5');
  assert.deepEqual(result.projection.prerequisiteGroups.map((g) => g.operator), ['all', 'all']);
  await verifyArgumentProjectionBuildResult(result, proof(f));
  const ptr = await createArgumentContextPointer(result.projection, result.authority, f.input.scope, ['N5']);
  const pack = await readArgumentContextPack(result.projection, result.authority, { pointer: ptr, scope: f.input.scope, task: 'reasoning' });
  assert.equal(pack.completeness.status, 'complete_for_scope'); assert.equal(pack.limitations.semanticTruth, 'not_certified');
  pass('固定合成独立审核票→版本投影→S1多步读取贯通，必要组与跨chunk原方向保留，不冒充真实语义准确率');

  const clauses = structuredClone(f.draft), whole = f.input.quotes.find((q) => q.evidence.sentenceId === 's9' && q.completeSentence)!;
  const parts = f.input.quotes.filter((q) => q.evidence.sentenceId === 's9' && !q.completeSentence);
  assert.ok(parts.length >= 2);
  clauses.nodes.push({ id: 'N9', role: 'premise', quoteIds: [parts[0].quoteId] },
    { id: 'N10', role: 'conclusion', quoteIds: [parts[1].quoteId] });
  clauses.relations.push({ id: 'E8', sourceNodeId: 'N9', targetNodeId: 'N10', kind: 'support', quoteIds: [whole.quoteId] });
  clauses.groups.push({ id: 'G3', conclusionNodeId: 'N10', premiseNodeIds: ['N9'], conditionNodeIds: [], relationIds: ['E8'], operator: 'all', quoteIds: [whole.quoteId] });
  clauses.scopes.push({ id: 'S2', seedNodeId: 'N10', task: 'reasoning', requiredNodeIds: ['N9', 'N10'], requiredRelationIds: ['E8'], requiredGroupIds: ['G3'], quoteIds: [whole.quoteId] });
  const clauseReview = await buildArgumentProjectionReviewInput(f.input, clauses);
  const clauseResult = await finalizeArgumentProjectionBuild(f.input, clauses, fixedAcceptProjectionReview(clauseReview));
  assert.equal(clauseResult.status, 'reviewed_complete');
  assert.equal(clauseResult.projection.relations.find((e) => e.id === 'E8')!.admission, 'admitted');
  const quotedReuse = structuredClone(f.draft); quotedReuse.relations[3].quoteIds = [...quotedReuse.nodes[3].quoteIds];
  const reuseReview = await buildArgumentProjectionReviewInput(f.input, quotedReuse);
  assert.equal((await finalizeArgumentProjectionBuild(f.input, quotedReuse, fixedAcceptProjectionReview(reuseReview))).status, 'reviewed_complete');
  pass('同句精确子句能分别做前提/结论，整句关系与端点合法复用Q，不强索第三条引文');

  const anyDraft = structuredClone(f.draft); anyDraft.groups[0].operator = 'any';
  const mixedReview = await buildArgumentProjectionReviewInput(f.input, anyDraft);
  const mixedResult = await finalizeArgumentProjectionBuild(f.input, anyDraft, fixedAcceptProjectionReview(mixedReview));
  assert.equal(mixedResult.status, 'reviewed_partial');
  assert.ok(mixedResult.projection.build.gaps.some((g) => g.code === 'unknown_prerequisite_operator'));
  anyDraft.groups[0].conditionNodeIds = [];
  anyDraft.groups[0].relationIds = anyDraft.groups[0].relationIds.filter((id) => id !== 'E3');
  const anyReview = await buildArgumentProjectionReviewInput(f.input, anyDraft);
  assert.equal((await finalizeArgumentProjectionBuild(f.input, anyDraft, fixedAcceptProjectionReview(anyReview))).projection.prerequisiteGroups[0].operator, 'any');
  const unknownDraft = structuredClone(f.draft); unknownDraft.groups[0].operator = 'unknown';
  const unknownReview = await buildArgumentProjectionReviewInput(f.input, unknownDraft);
  await assert.rejects(finalizeArgumentProjectionBuild(f.input, unknownDraft, fixedAcceptProjectionReview(unknownReview)), /unknown_operator_accept/);
  const allowedUnknown = fixedAcceptProjectionReview(unknownReview); allowedUnknown.groups[0].decision = 'unknown'; allowedUnknown.groups[0].operatorSupported = false;
  assert.equal((await finalizeArgumentProjectionBuild(f.input, unknownDraft, allowedUnknown)).status, 'reviewed_partial');
  pass('纯替代any保留，混合OR+AND不偷偷改语义；unknown operator即使accept票也不能发布完整');

  const extractRequest = await buildArgumentProjectionExtractionRequest(f.input), reviewRequest = await buildArgumentProjectionReviewRequest(f.input, f.draft);
  for (const request of [extractRequest, reviewRequest]) {
    assert.ok(request.skipMemoryInjection && request.skipProfileInjection && request.thinkingMode === 'disabled');
    assert.ok(request.userInput.length <= 24000); assert.doesNotThrow(() => JSON.parse(request.userInput));
    assert.ok(!request.userInput.includes('sourceQualification') && !request.userInput.includes('"decision":"accept"'));
    assert.ok(request.systemPrompt.includes('不执行'));
  }
  assert.equal(extractRequest.bindingId, f.input.buildId); assert.equal(reviewRequest.bindingId, f.reviewInput.reviewId);
  assert.notEqual(extractRequest.stage, reviewRequest.stage); assert.ok(!JSON.parse(extractRequest.userInput).draft);
  assert.deepEqual(JSON.parse(reviewRequest.userInput).draft, f.draft);
  assert.ok(reviewRequest.systemPrompt.includes('同义'));
  pass('抽取与独立审核分别组装绑定请求，只有固定原文/目录/草稿，无用户画像/质量暗示/金标签，无实际传输');

  const contract = JSON.parse(reviewRequest.userInput).outputContract;
  assert.deepEqual(contract.rowSchemas, ARGUMENT_PROJECTION_REVIEW_ROW_SCHEMAS);
  assert.equal(contract.additionalProperties, false); assert.equal(contract.allListedFieldsRequired, true);
  assert.equal(contract.suppliedVotes, 'none'); assert.deepEqual(contract.decisionValues, ['accept', 'reject', 'unknown']);
  for (const [kind, schema] of Object.entries(ARGUMENT_PROJECTION_REVIEW_ROW_SCHEMAS)) {
    assert.ok(reviewRequest.systemPrompt.includes(`${kind}行恰为{${schema.fields.join(',')}}`));
    assert.deepEqual([...schema.fields].sort(), Object.keys(f.review[kind as keyof typeof ARGUMENT_PROJECTION_REVIEW_ROW_SCHEMAS][0]).sort());
    assert.deepEqual([...schema.booleanFields].sort(), Object.entries(f.review[kind as keyof typeof ARGUMENT_PROJECTION_REVIEW_ROW_SCHEMAS][0])
      .filter(([, value]) => typeof value === 'boolean').map(([name]) => name).sort());
    assert.ok(schema.fields.includes('decision'));
  }
  assert.ok(!JSON.stringify(contract).includes('"decision":"accept"') && !JSON.stringify(contract).includes('roleSupported":true'));
  assert.ok(reviewRequest.systemPrompt.includes('不能代替decision'));
  pass('四类完整封闭字段同源于decoder，类型合同无预填票/true/accept，不再依赖共有加另有描述');

  for (const kind of ['nodes', 'relations', 'groups', 'scopes'] as const) {
    const raw = structuredClone(f.review) as any; delete raw[kind][0].decision;
    const before = JSON.stringify(raw);
    await assert.rejects(finalizeArgumentProjectionBuild(f.input, f.draft, raw), error => {
      assert.match((error as Error).message, /argument_projection_invalid_shape/u);
      assert.deepEqual(getArgumentProjectionReviewRowDiagnostic(error), { kind, rowIndex: 0, missingFields: ['decision'], unexpectedFieldCount: 0 });
      return true;
    });
    assert.equal(JSON.stringify(raw), before);
  }
  pass('所有类型漏decision仍严格拒绝，宿主可定位kind/index/缺字段，不补accept或改原响应');

  for (const kind of ['nodes', 'relations', 'groups', 'scopes'] as const) {
    const raw = structuredClone(f.review) as any;
    raw[kind][0]['secret-model-key-/private/path'] = 'synthetic-secret';
    await assert.rejects(finalizeArgumentProjectionBuild(f.input, f.draft, raw), error => {
      const diagnostic = getArgumentProjectionReviewRowDiagnostic(error)!;
      assert.deepEqual(diagnostic, { kind, rowIndex: 0, missingFields: [], unexpectedFieldCount: 1 });
      diagnostic.missingFields.push('modified');
      assert.deepEqual(getArgumentProjectionReviewRowDiagnostic(error)!.missingFields, []);
      assert.ok(!JSON.stringify(getArgumentProjectionReviewRowDiagnostic(error)).includes('secret'));
      return true;
    });
    for (const flag of ARGUMENT_PROJECTION_REVIEW_ROW_SCHEMAS[kind].booleanFields) {
      const missing = structuredClone(f.review) as any; delete missing[kind][0][flag];
      await assert.rejects(finalizeArgumentProjectionBuild(f.input, f.draft, missing));
    }
  }
  assert.equal(getArgumentProjectionReviewRowDiagnostic(new Error('argument_projection_invalid_shape')), undefined);
  assert.equal(getArgumentProjectionReviewRowDiagnostic({ diagnostic: { kind: 'nodes', missingFields: ['secret'] } }), undefined);
  pass('复制候选extra/漏boolean仍拒绝，诊断只含已知缺字段和未知字段数量，不输出未知键/值且不能自报');

  const groupCopy = structuredClone(f.review) as any;
  Object.assign(groupCopy.groups[0], f.draft.groups[0]);
  await assert.rejects(finalizeArgumentProjectionBuild(f.input, f.draft, groupCopy));
  const scopeCopy = structuredClone(f.review) as any;
  Object.assign(scopeCopy.scopes[0], f.draft.scopes[0]);
  await assert.rejects(finalizeArgumentProjectionBuild(f.input, f.draft, scopeCopy));
  for (const decision of ['reject', 'unknown'] as const) {
    const review = structuredClone(f.review); review.groups[0].decision = decision; review.groups[0].necessarySetComplete = false;
    assert.equal((await finalizeArgumentProjectionBuild(f.input, f.draft, review)).status, 'reviewed_partial');
  }
  assert.ok(extractRequest.systemPrompt.includes('跨句') && extractRequest.systemPrompt.includes('孤立claim'));
  assert.ok(reviewRequest.systemPrompt.includes('主结论的必要组或scope漏该条件'));
  pass('真实失败形态候选group/scope混入审核仍拒绝，合法reject/unknown保留partial，提示核对跨句条件归属');

  let jointBudgetChecked = false;
  for (let length = 100; length <= 3000; length += 100) {
    const source = structuredClone(f.sourceInput); source.canonicalText += '界'.repeat(length);
    source.source.contentHash = await argumentCanonicalTextHash(source.canonicalText);
    source.hierarchy.blocks.at(-1)!.end = source.canonicalText.length;
    const sentence = source.hierarchy.sentences.at(-1)!;
    sentence.end = source.canonicalText.length; sentence.quote = source.canonicalText.slice(sentence.start);
    source.chunks.at(-1)!.end = source.canonicalText.length;
    source.chunks.at(-1)!.content = source.canonicalText.slice(source.chunks.at(-1)!.start);
    let input, review;
    try {
      input = await prepareArgumentProjectionBuild(source);
      review = await buildArgumentProjectionReviewInput(input, { ...structuredClone(f.draft), buildId: input.buildId });
    } catch (error) {
      assert.match((error as Error).message, /request_budget/u); break;
    }
    const userLength = JSON.stringify({ ...review, outputContract: contract }).length;
    if (userLength <= 24000 && userLength + reviewRequest.systemPrompt.length > 24000) {
      await assert.rejects(buildArgumentProjectionReviewRequest(input, { ...structuredClone(f.draft), buildId: input.buildId }),
        /argument_projection_request_budget/u);
      jointBudgetChecked = true; break;
    }
  }
  assert.equal(jointBudgetChecked, true);
  pass('临界输入本身未超24k但加system/类型合同超限时组装即拒绝，未增预算/裁原文/进入模型');

  for (const mutate of [
    (x: any) => { x.chunks[0].content += '伪造'; },
    (x: any) => { x.chunks[0].sentenceIds.push('foreign-sentence'); },
    (x: any) => { x.chunks[0].start = 1; },
    (x: any) => { x.source.contentHash = '0'.repeat(64); },
    (x: any) => { x.scope.allowedDocIds = []; },
    (x: any) => { x.source.rootScopeId = 'C:/private'; },
    (x: any) => { x.sourceQualification.evidence = []; },
    (x: any) => { x.sourceQualification.evidence[0].quote = '伪造资格依据'; },
    (x: any) => { x.sourceQualification.confidence = 1; },
  ]) { const input = structuredClone(f.sourceInput); mutate(input); await assert.rejects(prepareArgumentProjectionBuild(input)); }
  const personal = structuredClone(f.sourceInput); personal.scope.corpus = 'personal'; personal.source.kind = 'personal-cognition';
  await assert.rejects(prepareArgumentProjectionBuild(personal));
  pass('host来源质量独立且不默认合格；伪原文/借chunk/路径根/无授权/私人库与未知字段拒绝');

  for (const mutate of [
    (x: any) => { x.nodes[0].quality = 'eligible'; }, (x: any) => { x.nodes[0].confidence = 1; },
    (x: any) => { x.nodes[0].quoteIds = ['Q999']; }, (x: any) => { x.nodes[0].quoteIds = []; },
    (x: any) => { x.nodes[0].role = 'mastered'; }, (x: any) => { x.nodes.push(x.nodes[0]); },
    (x: any) => { x.relations[0].targetNodeId = 'N999'; }, (x: any) => { x.relations[0].targetNodeId = x.relations[0].sourceNodeId; },
    (x: any) => { x.groups[0].operator = 'p1-or-p2-and-condition'; },
    (x: any) => { x.groups[0].relationIds = ['E999']; },
    (x: any) => { x.scopes[0].requiredNodeIds = ['N999']; },
    (x: any) => { x.scopes[0].requiredNodeIds = ['N1']; },
    (x: any) => { x.buildId = 'another-source-build'; }, (x: any) => { x.scoreWrite = 'enabled'; },
  ]) await rejectDraft(f, mutate);
  pass('抽取草稿闭合：模型不能自授质量/准入/分数，也不能跨源借ID、造端点/方向或削掉seed');

  for (const mutate of [
    (x: any) => { x.nodes.pop(); }, (x: any) => { x.nodes.push(x.nodes[0]); },
    (x: any) => { x.nodes[0].id = 'N999'; }, (x: any) => { x.nodes[0].reason = ''; },
    (x: any) => { x.nodes[0].quoteIds = ['Q999']; },
    (x: any) => { x.nodes[0].roleSupported = false; },
    (x: any) => { x.relations[0].directionSupported = false; },
    (x: any) => { x.relations[0].sourceNodeId = 'N5'; },
    (x: any) => { x.groups[0].operator = 'any'; },
    (x: any) => { x.scopes[0].attributionSupported = false; },
    (x: any) => { x.reviewId = 'another-draft-review'; }, (x: any) => { x.quality = 'eligible'; },
  ]) await rejectReview(f, mutate);
  pass('独立审核逐slot恰一次，accept与支持标记矛盾拒绝，不改方向/operator/来源策略，不修补缺响应');

  for (const change of [
    (r: any) => { r.nodes[0].decision = 'unknown'; r.nodes[0].roleSupported = false; },
    (r: any) => { r.relations[3].decision = 'reject'; r.relations[3].directionSupported = false; },
    (r: any) => { r.groups[0].decision = 'unknown'; r.groups[0].necessarySetComplete = false; },
    (r: any) => { r.scopes[0].decision = 'unknown'; r.scopes[0].attributionSupported = false; },
  ]) {
    const review = structuredClone(f.review); change(review);
    const partial = await finalizeArgumentProjectionBuild(f.input, f.draft, review);
    assert.equal(partial.status, 'reviewed_partial'); assert.ok(partial.projection.build.gaps.length);
    assert.ok(partial.projection.build.scopes.some((s) => s.status !== 'reviewed_for_scope'));
    assert.ok([...partial.audit.nodes, ...partial.audit.relations, ...partial.audit.groups, ...partial.audit.scopes].some((r) => r.decision !== 'accept'));
    await verifyArgumentProjectionBuildResult(partial, { ...proof(f), review });
  }
  const unsupported = structuredClone(f.review); unsupported.relations[3].decision = 'unknown'; unsupported.relations[3].crossChunkSupported = false;
  const unlinked = await finalizeArgumentProjectionBuild(f.input, f.draft, unsupported);
  assert.equal(unlinked.projection.relations.find((e) => e.id === 'E4')!.admission, 'audit_only');
  pass('不明职责/错误方向/漏必要条件/不明归属/跨chunk无依据留audit+gap，依赖不能被另一accept洗白');

  for (const status of ['unassessed', 'review_only'] as const) {
    const source = structuredClone(f.sourceInput); source.sourceQualification.status = status;
    const input = await prepareArgumentProjectionBuild(source), draft = { ...structuredClone(f.draft), buildId: input.buildId };
    const ri = await buildArgumentProjectionReviewInput(input, draft), review = { ...structuredClone(f.review), reviewId: ri.reviewId };
    const qualified = await finalizeArgumentProjectionBuild(input, draft, review);
    assert.equal(qualified.projection.quality.status, status); assert.equal(qualified.status, 'reviewed_partial');
  }
  pass('结构全accept仍不等于来源资格：未知/待审来源不能发布完整参考');

  const splitSource = structuredClone(f.sourceInput); splitSource.chunks[0].forcedSplit = true;
  const splitInput = await prepareArgumentProjectionBuild(splitSource), splitDraft = { ...structuredClone(f.draft), buildId: splitInput.buildId };
  const splitReviewInput = await buildArgumentProjectionReviewInput(splitInput, splitDraft), splitReview = { ...structuredClone(f.review), reviewId: splitReviewInput.reviewId };
  const splitResult = await finalizeArgumentProjectionBuild(splitInput, splitDraft, splitReview);
  assert.equal(splitResult.status, 'reviewed_partial'); assert.ok(splitResult.projection.nodes.some((n) => n.admission !== 'admitted'));
  pass('forcedSplit-only证据不因审核票全部true升级完整，保留原文但不得准入');

  const changedDraft = structuredClone(f.draft); changedDraft.nodes[0].role = 'fact';
  assert.notEqual((await buildArgumentProjectionReviewInput(f.input, changedDraft)).reviewId, f.reviewInput.reviewId);
  await assert.rejects(finalizeArgumentProjectionBuild(f.input, changedDraft, f.review));
  const forged = structuredClone(result); forged.projection.nodes[0].role = 'fact';
  forged.authority.structureHash = await argumentContextHash(forged.projection);
  const { resultHash: _old, ...forgedBody } = forged; forged.resultHash = await argumentContextHash(forgedBody);
  await assert.rejects(verifyArgumentProjectionBuildResult(forged, proof(f)));
  const mutatedInput = structuredClone(f.input); mutatedInput.quotes[0].evidence.quote += '篡改';
  await assert.rejects(validateArgumentProjectionBuildInput(mutatedInput));
  for (const mutate of [
    (r: any) => { r.extra = undefined; }, (r: any) => { r.projection.extra = undefined; },
    (r: any) => { r.authority.extra = undefined; }, (r: any) => { r.audit.nodes[0].extra = undefined; },
    (r: any) => { r.limitations.extra = undefined; },
  ]) { const value = structuredClone(result); mutate(value); await assert.rejects(verifyArgumentProjectionBuildResult(value, proof(f))); }
  const undefinedQuote = structuredClone(f.input) as any; undefinedQuote.quotes[0].extra = undefined;
  await assert.rejects(validateArgumentProjectionBuildInput(undefinedQuote));
  pass('目录/草稿/审核/投影四层绑定，旧审核不审新图，自重算resultHash也不能伪准入');

  const store = createArgumentProjectionPublicationStore(), publish = await publicationRequest(f);
  await assert.rejects(store.publish(publish), /source_not_registered/);
  await store.registerSource(f.input);
  const receipt = await store.publish(publish); assert.equal(receipt.status, 'published');
  assert.deepEqual(receipt, await store.publish(publish));
  const active = await store.read({ source: f.input.source, scope: f.input.scope }); assert.deepEqual(active, result);
  active!.projection.nodes[0].role = 'fact'; assert.deepEqual(await store.read({ source: f.input.source, scope: f.input.scope }), result);
  await assert.rejects(store.publish({ ...publish, expectedActiveHash: '0'.repeat(64) }), /idempotency_content_changed/);
  pass('内存发布先独立登记host快照，审核回放+CAS原子激活，回执幂等且读取无共享可变图');

  const partialF = { ...f, review: structuredClone(f.review) }; partialF.review.nodes[0].decision = 'unknown'; partialF.review.nodes[0].roleSupported = false;
  const heldRequest = await publicationRequest(partialF, 'partial-publication', result.authority.structureHash);
  const held = await store.publish(heldRequest); assert.equal(held.status, 'held');
  assert.deepEqual(await store.read({ source: f.input.source, scope: f.input.scope }), result);
  assert.deepEqual(await store.readStaged({ publicationId: 'partial-publication', source: f.input.source, scope: f.input.scope }), heldRequest.result);
  const denied = structuredClone(f.input.scope); denied.allowedDocIds = [];
  assert.equal(await store.read({ source: f.input.source, scope: denied }), null);
  assert.equal(await store.readStaged({ publicationId: 'partial-publication', source: f.input.source, scope: denied }), null);
  pass('partial保留待审与拒绝记录但不覆盖active；权限/选择变化不回退旧库');

  const concurrent = createArgumentProjectionPublicationStore(); await concurrent.registerSource(f.input);
  const racing = await Promise.allSettled([concurrent.publish({ ...publish, publicationId: 'race-A' }), concurrent.publish({ ...publish, publicationId: 'race-B' })]);
  assert.equal(racing.filter((r) => r.status === 'fulfilled').length, 1);
  assert.match((racing.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.message, /cas_mismatch/);
  assert.equal((await concurrent.publish({ ...publish, publicationId: 'after-cas-failure', expectedActiveHash: result.authority.structureHash })).status, 'published');
  pass('同旧active并发发布仅一个成功，失败不毒化队列，后续正确CAS可继续');

  const nextSource = structuredClone(f.sourceInput); nextSource.source.version = 'generation-next';
  const nextInput = await prepareArgumentProjectionBuild(nextSource);
  await store.registerSource(nextInput);
  assert.equal(await store.read({ source: f.input.source, scope: f.input.scope }), null);
  assert.equal(await store.read({ source: nextInput.source, scope: nextInput.scope }), null);
  await assert.rejects(store.publish(publish), /source_changed/);
  assert.equal(await store.readStaged({ publicationId: 'partial-publication', source: f.input.source, scope: f.input.scope }), null);
  const another = createArgumentProjectionPublicationStore(); assert.equal(await another.read({ source: f.input.source, scope: f.input.scope }), null);
  await store.registerSource(f.input);
  assert.equal(await store.read({ source: f.input.source, scope: f.input.scope }), null);
  await assert.rejects(store.publish(publish), /source_changed/);
  pass('源版本登记变更立即隔离旧active/staged，旧回执不复活；独立registry不共享库');

  const nextDraft = { ...structuredClone(f.draft), buildId: nextInput.buildId };
  const nextReviewInput = await buildArgumentProjectionReviewInput(nextInput, nextDraft);
  const nextFixture = { ...f, sourceInput: nextSource, input: nextInput, draft: nextDraft,
    reviewInput: nextReviewInput, review: fixedAcceptProjectionReview(nextReviewInput) };
  const evolving = createArgumentProjectionPublicationStore();
  await evolving.registerSource(f.input); await evolving.publish(publish);
  await evolving.registerSource(nextInput);
  const nextPartial = { ...nextFixture, review: structuredClone(nextFixture.review) };
  nextPartial.review.nodes[0].decision = 'unknown'; nextPartial.review.nodes[0].roleSupported = false;
  const nextHeld = await evolving.publish(await publicationRequest(nextPartial, 'next-held'));
  assert.equal(nextHeld.status, 'held'); assert.equal(nextHeld.activeHash, null);
  assert.equal(await evolving.read({ source: nextInput.source, scope: nextInput.scope }), null);
  const nextPublication = await publicationRequest(nextFixture, 'next-complete');
  assert.equal((await evolving.publish(nextPublication)).status, 'published');
  assert.deepEqual(await evolving.read({ source: nextInput.source, scope: nextInput.scope }), nextPublication.result);
  assert.equal(await evolving.read({ source: f.input.source, scope: f.input.scope }), null);
  await evolving.registerSource(f.input);
  assert.equal((await evolving.publish({ ...publish, publicationId: 'return-A-new-publication' })).status, 'published');
  await assert.rejects(evolving.publish(publish), /source_changed/);
  pass('新世代没有可读active时以null为CAS基线，旧槽不阻塞新发布；held回执不借旧hash，返回A仍须新发布ID');

  const during = createArgumentProjectionPublicationStore(); await during.registerSource(f.input);
  let paused = false, signal!: () => void, resume!: () => void;
  const entered = new Promise<void>((resolve) => { signal = resolve; });
  const resumed = new Promise<void>((resolve) => { resume = resolve; });
  const digestBefore = crypto.subtle.digest;
  crypto.subtle.digest = async function (algorithm, data) {
    const encoded = new TextDecoder().decode(data);
    if (!paused && encoded.includes('"resultHash"') && !encoded.includes('"publicationId"')) {
      paused = true; signal(); await resumed;
    }
    return digestBefore.call(this, algorithm, data);
  };
  try {
    const slow = during.publish({ ...publish, publicationId: 'during-review' });
    const rejectedSlow = assert.rejects(slow, /source_changed/);
    await entered;
    await during.registerSource(nextInput);
    resume(); await rejectedSlow;
    assert.equal(await during.read({ source: f.input.source, scope: f.input.scope }), null);
    assert.equal(await during.read({ source: nextInput.source, scope: nextInput.scope }), null);
  } finally { resume(); crypto.subtle.digest = digestBefore; }
  pass('确定性暂停审核回放期间登记新版本，旧候选发布拒绝，无短暂旧active可读');

  const snapshot = structuredClone(f.sourceInput), preparing = prepareArgumentProjectionBuild(snapshot);
  snapshot.chunks[0].content += 'await突变'; snapshot.scope.allowedDocIds = [];
  assert.deepEqual(await preparing, f.input);
  const source = structuredClone(f.sourceInput); source.canonicalText = 'x'.repeat(24001);
  await assert.rejects(prepareArgumentProjectionBuild(source));
  const large = structuredClone(f.sourceInput); large.canonicalText += '有界源'.repeat(3000);
  large.source.contentHash = await argumentCanonicalTextHash(large.canonicalText);
  large.hierarchy.blocks.at(-1)!.end = large.canonicalText.length;
  const lastSentence = large.hierarchy.sentences.at(-1)!;
  lastSentence.end = large.canonicalText.length; lastSentence.quote = large.canonicalText.slice(lastSentence.start);
  large.chunks.at(-1)!.end = large.canonicalText.length; large.chunks.at(-1)!.content = large.canonicalText.slice(large.chunks.at(-1)!.start);
  await assert.rejects(prepareArgumentProjectionBuild(large), /request_budget/);
  pass('首次await前快照克隆防重绑定；超预算/截断源明确拒绝而不是前缀complete');

  console.log(`Argument projection build checks passed: ${checks} groups (synthetic fixed reviewer votes; 0 model calls; 0 production writes).`);
} finally { globalThis.fetch = fetchBefore; }
