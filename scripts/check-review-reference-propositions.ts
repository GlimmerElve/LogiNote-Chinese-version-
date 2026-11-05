import assert from 'node:assert/strict';
import { createReferenceDisclosureFixture } from './reference-disclosure-fixture.ts';
import { buildArgumentReferenceDisclosure } from '../src/services/argumentContext/referenceDisclosure.ts';
import { argumentContextHash } from '../src/services/argumentContext/hash.ts';
import { prepareReferencePropositionReviewInput, finalizeReferencePropositions, validateReferencePropositions,
  REFERENCE_PROPOSITION_LIMITS, type ReferencePropositionDraft, type ReferencePropositionReview,
  type ReferencePropositionBundle, type ReferencePropositionReply } from '../src/services/reviewComparison/referencePropositionAnchors.ts';
import type { ArgumentReferenceDisclosureContext } from '../src/services/argumentContext/referenceDisclosure.ts';

const originalFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('Proposition checks forbid network');
let checks = 0;
const pass = (label: string) => { checks++; console.log(`PASS ${label}`); };
const clone = <T>(value: T): T => structuredClone(value);
function held(reply: ReferencePropositionReply, reason?: string) {
  assert.equal(reply.status, 'held', JSON.stringify(reply));
  if (reply.status === 'held' && reason) assert.deepEqual(reply.reasons, [reason]);
}
function ready(reply: ReferencePropositionReply): ReferencePropositionBundle {
  assert.equal(reply.status, 'ready', JSON.stringify(reply));
  assert.ok(reply.status === 'ready'); return reply.bundle;
}
async function makeDraft(context: ArgumentReferenceDisclosureContext): Promise<ReferencePropositionDraft> {
  // Explicit fixture-author candidates, not connector/keyword extraction.
  // N2 is deliberately bound to the authored concrete outcome inside a compound
  // quotation; this function is only synthetic fixture construction.
  const anchors = context.frames.flatMap(frame => [...new Set(frame.items.flatMap(item => item.nodeIds))].map(nodeId => {
    const node = frame.nodes.find(node => node.id === nodeId)!, parent = context.quotes.find(quote => quote.quoteId === node.quoteIds[0])!;
    const text = node.role === 'conclusion' && parent.text.includes('本次合成包裹会进入二号通道')
      ? '本次合成包裹会进入二号通道' : parent.text;
    const start = parent.start + parent.text.indexOf(text);
    return { id: `P-${frame.frameId}-${nodeId}`, frameId: frame.frameId, nodeId, quoteId: parent.quoteId,
      start, end: start + text.length, text };
  }));
  return { version: 1, protocol: 'review-reference-proposition-draft-v1', contractHash: context.contractHash,
    contextHash: await argumentContextHash(context), anchors };
}
async function makeReview(context: ArgumentReferenceDisclosureContext, draft: ReferencePropositionDraft): Promise<ReferencePropositionReview> {
  const input = await prepareReferencePropositionReviewInput(context, draft);
  return { version: 1, protocol: 'review-reference-proposition-review-v1', reviewId: input.reviewId,
    contextHash: input.contextHash, draftHash: input.draftHash, anchors: draft.anchors.map(anchor => ({ id: anchor.id,
      decision: 'accept', roleSupported: true, completeMeaning: true, scopePreserved: true,
      reason: '仅离线合成固定审核票，测试协议而非宣称语义准确率。' })) };
}
async function rig(options: Parameters<typeof createReferenceDisclosureFixture>[0] = { task: 'reasoning', theme: 'progressive-parcel-v1' }) {
  const fixture = await createReferenceDisclosureFixture(options), disclosure = await buildArgumentReferenceDisclosure(fixture.frozen);
  assert.ok(disclosure.status === 'ready');
  const context = disclosure.context, draft = await makeDraft(context), review = await makeReview(context, draft);
  const bundle = ready(await finalizeReferencePropositions(context, draft, review));
  return { context, draft, review, bundle, fixture };
}
try {
  const base = await rig(), input = await prepareReferencePropositionReviewInput(base.context, base.draft);
  assert.deepEqual(input.reference, base.context); assert.deepEqual(input.draft, base.draft);
  assert.equal(input.contextHash, await argumentContextHash(base.context)); assert.equal(input.draftHash, await argumentContextHash(base.draft));
  assert.ok(input.reviewId.startsWith('reference-propositions:'));
  ready(await validateReferencePropositions(base.context, base.bundle, { draft: base.draft, review: base.review }));
  assert.equal(base.bundle.semanticTruth, 'not_certified'); assert.equal(base.bundle.writes, 'disabled');
  pass('真实合成已冻结参考→显式候选→独立绑定审核→proof重建；纯只读且不认证世界事实');

  const actual = base.bundle.anchors.find(anchor => anchor.nodeId === 'N2')!;
  assert.equal(actual.role, 'conclusion'); assert.equal(actual.text, '本次合成包裹会进入二号通道');
  assert.equal(actual.parent.text, '本实验约定带有蓝印的包裹会进入二号通道，所以本次合成包裹会进入二号通道。');
  assert.equal(actual.start, actual.parent.start + 22); assert.equal(actual.end - actual.start, actual.text.length);
  assert.deepEqual(actual.source, base.context.frames[0].source);
  assert.equal(actual.sourceKey, base.context.quotes.find(quote => quote.quoteId === actual.quoteId)!.sourceKey);
  pass('复合N2只选显式本次具体结论锚点，完整规则/条件语境及原来源坐标另行保留');

  const guessed = clone(base.draft), guessedN2 = guessed.anchors.find(anchor => anchor.nodeId === 'N2')!;
  guessedN2.text = '本实验约定带有蓝印的包裹会进入二号通道';
  guessedN2.start = actual.parent.start; guessedN2.end = guessedN2.start + guessedN2.text.length;
  const guessedReview = await makeReview(base.context, guessed);
  guessedReview.anchors.find(row => row.id === guessedN2.id)!.roleSupported = false;
  held(await finalizeReferencePropositions(base.context, guessed, guessedReview), 'proposition_semantic_review_held');
  // A fallible/forged approving vote is not detectable semantic truth. This is
  // why the caller must obtain it independently and every bundle is not_certified.
  guessedReview.anchors.find(row => row.id === guessedN2.id)!.roleSupported = true;
  assert.equal(ready(await finalizeReferencePropositions(base.context, guessed, guessedReview)).semanticTruth, 'not_certified');
  pass('宿主不凭所以或存储role赋义；语义反对票暂缓，错误赞成票仍不等于真值认证');

  for (const decision of ['reject', 'unknown'] as const) {
    const review = clone(base.review); review.anchors[0].decision = decision;
    held(await finalizeReferencePropositions(base.context, base.draft, review), 'proposition_semantic_review_held');
  }
  for (const field of ['roleSupported', 'completeMeaning', 'scopePreserved'] as const) {
    const review = clone(base.review); review.anchors[0][field] = false;
    held(await finalizeReferencePropositions(base.context, base.draft, review), 'proposition_semantic_review_held');
  }
  pass('任何候选拒绝/未知/职责、完整含义、范围不支持均整体held，不静默丢弃候选');

  for (const field of ['reviewId', 'contextHash', 'draftHash'] as const) {
    const review = clone(base.review); review[field] = field === 'reviewId' ? 'other-review' : 'b'.repeat(64);
    held(await finalizeReferencePropositions(base.context, base.draft, review), 'proposition_review_binding_changed');
  }
  const missing = clone(base.review); missing.anchors.pop();
  held(await finalizeReferencePropositions(base.context, base.draft, missing), 'proposition_review_incomplete');
  const extra = clone(base.review); extra.anchors.push({ ...extra.anchors[0], id: 'not-a-candidate' });
  held(await finalizeReferencePropositions(base.context, base.draft, extra), 'proposition_review_incomplete');
  pass('审核绑定原reviewId/context/draft；漏票或增加陌生候选不能入库');

  const incomplete = clone(base.draft); incomplete.anchors = incomplete.anchors.filter(anchor => anchor.nodeId !== 'N3');
  held(await finalizeReferencePropositions(base.context, incomplete, await makeReview(base.context, incomplete)), 'proposition_required_nodes_missing');
  const empty = clone(base.draft); empty.anchors = [];
  held(await finalizeReferencePropositions(base.context, empty, await makeReview(base.context, empty)), 'proposition_required_nodes_missing');
  pass('每个原题required node至少一个合法候选；少条件或空候选不能靠全赞成票通过');

  for (const change of [
    (draft: ReferencePropositionDraft) => { draft.anchors[0].start++; draft.anchors[0].end++; },
    (draft: ReferencePropositionDraft) => { draft.anchors[0].text = draft.anchors[0].text.replace('带有', '没有'); },
    (draft: ReferencePropositionDraft) => { draft.anchors[0].quoteId = 'Q999'; },
    (draft: ReferencePropositionDraft) => { draft.anchors[0].frameId = 'target-other'; },
    (draft: ReferencePropositionDraft) => { draft.anchors[0].nodeId = 'N999'; },
  ]) {
    const draft = clone(base.draft); change(draft);
    await assert.rejects(() => prepareReferencePropositionReviewInput(base.context, draft), /invalid_proposition_(anchor|draft)/u);
  }
  pass('错绝对坐标、改写文本、不存在Q/frame/node均拒绝，绝不规范化或猜相近位置');

  const two = await rig({ task: 'reasoning', theme: 'progressive-parcel-v1', noteCount: 2 });
  const borrowed = clone(two.draft); borrowed.anchors[0].frameId = 'target-2';
  await assert.rejects(() => prepareReferencePropositionReviewInput(two.context, borrowed), /invalid_proposition_anchor/u);
  const swappedBundle = clone(two.bundle); swappedBundle.anchors[0].source = clone(swappedBundle.anchors.at(-1)!.source);
  held(await validateReferencePropositions(two.context, swappedBundle, { draft: two.draft, review: two.review }), 'proposition_bundle_changed');
  pass('同名节点相同原话也不能跨frame借Q/source；别处来源不能取代本节点父引文');

  for (const field of ['version', 'contentHash', 'structureHash'] as const) {
    const context = clone(base.context); context.frames[0].source[field] = field === 'version' ? 'changed-version' : 'c'.repeat(64);
    held(await validateReferencePropositions(context, base.bundle, { draft: base.draft, review: base.review }), 'proposition_binding_changed');
  }
  const changedKey = clone(base.context); changedKey.quotes.forEach(quote => { quote.sourceKey = 'd'.repeat(64); });
  held(await validateReferencePropositions(changedKey, base.bundle, { draft: base.draft, review: base.review }), 'proposition_binding_changed');
  const mixedKey = clone(base.context); mixedKey.quotes[0].sourceKey = 'd'.repeat(64);
  held(await finalizeReferencePropositions(mixedKey, base.draft, base.review), 'invalid_proposition_context');
  pass('source版本/正文hash/结构hash/sourceKey均绑定；一个frame混合来源直接拒绝');

  for (const change of [
    (context: ArgumentReferenceDisclosureContext) => { context.coverage = 'frame_subset'; },
    (context: ArgumentReferenceDisclosureContext) => { (context.assessment as any).status = 'unavailable'; },
    (context: ArgumentReferenceDisclosureContext) => { (context.limitations as any).semanticTruth = 'certified'; },
    (context: ArgumentReferenceDisclosureContext) => { delete (context as any).limitations; },
  ]) {
    const context = clone(base.context); change(context);
    held(await finalizeReferencePropositions(context, base.draft, base.review), 'invalid_proposition_context');
  }
  pass('缺完整题前资格/未固定任务/假真值证书或缺限制字段不能准备候选审核');

  for (const change of [
    (draft: ReferencePropositionDraft) => { (draft as any).score = 100; },
    (draft: ReferencePropositionDraft) => { (draft.anchors[0] as any).role = 'fact'; },
    (draft: ReferencePropositionDraft) => { (draft.anchors[0] as any).start = '0'; },
    (draft: ReferencePropositionDraft) => { draft.anchors[0].end = Number.NaN; },
    (draft: ReferencePropositionDraft) => { draft.anchors[0].text = '\uD83E'; },
    (draft: ReferencePropositionDraft) => { draft.anchors.push(clone(draft.anchors[0])); },
    (draft: ReferencePropositionDraft) => { draft.anchors.push({ ...draft.anchors[0], id: 'same-occurrence-again' }); },
    (draft: ReferencePropositionDraft) => { delete draft.anchors[0]; },
    (draft: ReferencePropositionDraft) => { (draft.anchors as any).extra = 'not-dense'; },
  ]) {
    const draft = clone(base.draft); change(draft);
    await assert.rejects(() => prepareReferencePropositionReviewInput(base.context, draft), /invalid_proposition_draft/u);
  }
  pass('draft闭合/稠密/唯一ID与同节点同坐标；不接受自封role、分数、字符串坐标或坏UTF16');

  for (const change of [
    (review: ReferencePropositionReview) => { delete (review.anchors[0] as any).completeMeaning; },
    (review: ReferencePropositionReview) => { (review.anchors[0] as any).roleSupported = 'true'; },
    (review: ReferencePropositionReview) => { (review.anchors[0] as any).confidence = 1; },
    (review: ReferencePropositionReview) => { review.anchors[0].reason = ''; },
    (review: ReferencePropositionReview) => { review.anchors.push(clone(review.anchors[0])); },
    (review: ReferencePropositionReview) => { delete review.anchors[0]; },
  ]) {
    const review = clone(base.review); change(review);
    held(await finalizeReferencePropositions(base.context, base.draft, review), 'invalid_proposition_review');
  }
  pass('review闭合/稠密/明确布尔票；遗漏、字符串true、额外信心或重复审核行不填默认');

  const repeated = await rig({ task: 'definition', repeatedOccurrences: true }), repeatedDraft = clone(repeated.draft);
  assert.equal(repeatedDraft.anchors[0].text, repeatedDraft.anchors[1].text);
  assert.notEqual(repeatedDraft.anchors[0].start, repeatedDraft.anchors[1].start);
  const first = repeatedDraft.anchors[0], second = repeatedDraft.anchors[1], secondNode = repeated.context.frames[0].nodes.find(node => node.id === second.nodeId)!;
  // The caller-authenticated synthetic node explicitly owns both occurrences.
  secondNode.quoteIds.push(first.quoteId);
  repeatedDraft.contextHash = await argumentContextHash(repeated.context);
  repeatedDraft.anchors.push({ ...first, id: 'second-node-first-occurrence', nodeId: second.nodeId });
  const repeatedBundle = ready(await finalizeReferencePropositions(repeated.context, repeatedDraft, await makeReview(repeated.context, repeatedDraft)));
  assert.equal(repeatedBundle.anchors.filter(anchor => anchor.nodeId === second.nodeId).length, 2);
  pass('真实重复相同短语按绝对坐标区分；同节点两个已拥有的父Q可分别审核，绝不猜first occurrence');

  const repeatedPredicate = clone(base.draft), phrase = '会进入二号通道';
  const firstPredicate = actual.parent.text.indexOf(phrase), secondPredicate = actual.parent.text.indexOf(phrase, firstPredicate + 1);
  assert.deepEqual([firstPredicate, secondPredicate], [12, 28]);
  repeatedPredicate.anchors.push(...[firstPredicate, secondPredicate].map((offset, index) => ({
    id: `Q3-repeated-predicate-${index}`, frameId: actual.frameId, nodeId: actual.nodeId, quoteId: actual.quoteId,
    start: actual.parent.start + offset, end: actual.parent.start + offset + phrase.length, text: phrase,
  })));
  const predicateReview = await makeReview(base.context, repeatedPredicate);
  predicateReview.anchors.find(row => row.id === 'Q3-repeated-predicate-0')!.roleSupported = false;
  held(await finalizeReferencePropositions(base.context, repeatedPredicate, predicateReview), 'proposition_semantic_review_held');
  const selectedPredicate = clone(repeatedPredicate);
  selectedPredicate.anchors = selectedPredicate.anchors.filter(anchor => anchor.id !== 'Q3-repeated-predicate-0');
  const predicateBundle = ready(await finalizeReferencePropositions(base.context, selectedPredicate, await makeReview(base.context, selectedPredicate)));
  const actualPredicate = predicateBundle.anchors.find(anchor => anchor.id === 'Q3-repeated-predicate-1')!;
  assert.equal(actualPredicate.start, actual.parent.start + 28); assert.equal(actualPredicate.parent.text, actual.parent.text);
  pass('同一个Q中重复结果谓词亦按坐标区分；前半句职责否决不被静默丢弃，后半句独立审核');

  const emoji = await rig({ task: 'definition' }), emojiDraft = clone(emoji.draft);
  const emojiAnchor = emojiDraft.anchors[0], emojiOffset = emojiAnchor.text.indexOf('🧠');
  assert.ok(emojiOffset >= 0); emojiAnchor.start += emojiOffset; emojiAnchor.text = '\uD83E'; emojiAnchor.end = emojiAnchor.start + 1;
  await assert.rejects(() => prepareReferencePropositionReviewInput(emoji.context, emojiDraft), /invalid_proposition_draft/u);
  const exactEmoji = clone(emoji.draft); exactEmoji.anchors[0].start += emojiOffset;
  exactEmoji.anchors[0].end = exactEmoji.anchors[0].start + 2; exactEmoji.anchors[0].text = '🧠';
  const exactReview = await makeReview(emoji.context, exactEmoji); exactReview.anchors[0].completeMeaning = false;
  held(await finalizeReferencePropositions(emoji.context, exactEmoji, exactReview), 'proposition_semantic_review_held');
  pass('UTF16半个emoji拒绝；完整emoji可定位但不由坐标证明命题完整');

  const condition = await rig({ task: 'condition', theme: 'progressive-parcel-v1' });
  const exception = condition.bundle.anchors.find(anchor => anchor.role === 'exception')!;
  assert.ok(exception.parent.text.includes('即使') && exception.parent.text.includes('也不按'));
  const chopped = clone(condition.draft), candidate = chopped.anchors.find(anchor => anchor.nodeId === exception.nodeId)!;
  candidate.text = '包裹带蓝印'; candidate.start = exception.parent.start + exception.parent.text.indexOf(candidate.text); candidate.end = candidate.start + candidate.text.length;
  const choppedReview = await makeReview(condition.context, chopped); choppedReview.anchors.find(row => row.id === candidate.id)!.scopePreserved = false;
  held(await finalizeReferencePropositions(condition.context, chopped, choppedReview), 'proposition_semantic_review_held');
  pass('否定/例外/适用条件的完整父上下文保留；截掉限制不能仅凭literal坐标获准');

  const shared = clone(base.context), node3 = shared.frames[0].nodes.find(node => node.id === 'N3')!, node1 = shared.frames[0].nodes.find(node => node.id === 'N1')!;
  node3.quoteIds.push(node1.quoteIds[0]);
  const sharedDraft = await makeDraft(shared); sharedDraft.anchors.push({ ...sharedDraft.anchors[0], id: 'shared-n3', nodeId: 'N3' });
  ready(await finalizeReferencePropositions(shared, sharedDraft, await makeReview(shared, sharedDraft)));
  assert.deepEqual(base.context.frames[0].groups[0].premiseNodeIds, ['N1']);
  assert.deepEqual(base.context.frames[0].groups[0].conditionNodeIds, ['N3']);
  pass('n:m候选映射兼容，原论证组/必要条件不增加或合并，独立审核仍负责职责语义');

  const intermediate = clone(base.context);
  intermediate.frames[0].nodes.find(node => node.id === 'N1')!.role = 'conclusion';
  const intermediateDraft = await makeDraft(intermediate), intermediateReview = await makeReview(intermediate, intermediateDraft);
  const intermediateBundle = ready(await finalizeReferencePropositions(intermediate, intermediateDraft, intermediateReview));
  assert.equal(intermediateBundle.anchors.find(anchor => anchor.nodeId === 'N1')!.role, 'conclusion');
  assert.deepEqual(intermediate.frames[0].groups[0].premiseNodeIds, ['N1']);
  assert.deepEqual(intermediate.frames[0].groups[0].conclusionNodeId, 'N2');
  assert.deepEqual(intermediate.frames[0].items, base.context.frames[0].items);
  ready(await validateReferencePropositions(intermediate, intermediateBundle, { draft: intermediateDraft, review: intermediateReview }));
  pass('前一已存conclusion可成为下一组premise；命题合同不强制重放旧证明或改原题标准');

  const before = clone(base.bundle), mutated = clone(base.bundle); mutated.anchors[0].role = 'conclusion';
  const { bundleHash: _oldHash, ...mutatedBody } = mutated; mutated.bundleHash = await argumentContextHash(mutatedBody);
  held(await validateReferencePropositions(base.context, mutated, { draft: base.draft, review: base.review }), 'proposition_bundle_changed');
  for (const field of ['sourceKey', 'text', 'parent'] as const) {
    const changed = clone(base.bundle);
    if (field === 'sourceKey') changed.anchors[0].sourceKey = 'e'.repeat(64);
    else if (field === 'text') changed.anchors[0].text = changed.anchors[0].text.replace('带有', '没有');
    else changed.anchors[0].parent.text = changed.anchors[0].parent.text.replace('带有', '没有');
    held(await validateReferencePropositions(base.context, changed, { draft: base.draft, review: base.review }), 'proposition_bundle_changed');
  }
  assert.deepEqual(base.bundle, before);
  pass('篡改role/来源/原话/父上下文即使自重算hash仍不能冒充独立重建proof');

  held(await validateReferencePropositions(base.context, base.bundle, undefined as any), 'invalid_proposition_proof');
  const forgedProof = { draft: base.draft, review: clone(base.review) }; forgedProof.review.anchors[0].decision = 'reject';
  held(await validateReferencePropositions(base.context, base.bundle, forgedProof), 'proposition_semantic_review_held');
  held(await validateReferencePropositions(base.context, { ...base.bundle, selfCertified: true } as any, { draft: base.draft, review: base.review }), 'invalid_proposition_bundle');
  pass('bundle不能自认证：缺独立proof、proof不通过或附加自认证字段全部held');

  for (const change of [
    (context: ArgumentReferenceDisclosureContext) => { (context.frames[0].nodes[0] as any).admission = 'admitted'; },
    (context: ArgumentReferenceDisclosureContext) => { delete context.frames[0].nodes[0]; },
    (context: ArgumentReferenceDisclosureContext) => { (context.frames[0].groups[0] as any).operator = 'unknown'; },
    (context: ArgumentReferenceDisclosureContext) => { context.quotes[0].text = '\uD83E'; context.quotes[0].end = context.quotes[0].start + 1; },
    (context: ArgumentReferenceDisclosureContext) => { (context.quotes as any).extra = true; },
  ]) {
    const context = clone(base.context); change(context);
    held(await finalizeReferencePropositions(context, base.draft, base.review), 'invalid_proposition_context');
  }
  let getterReads = 0;
  const getterDraft = clone(base.draft);
  Object.defineProperty(getterDraft.anchors[0], 'text', { enumerable: true, get: () => { getterReads++; return base.draft.anchors[0].text; } });
  await assert.rejects(() => prepareReferencePropositionReviewInput(base.context, getterDraft), /invalid_proposition_draft/u);
  assert.equal(getterReads, 0);
  const symbolic = clone(base.draft); (symbolic as any)[Symbol('hidden-authority')] = true;
  await assert.rejects(() => prepareReferencePropositionReviewInput(base.context, symbolic), /invalid_proposition_draft/u);
  pass('完整context嵌套closed/dense和坏UTF16拒绝；不执行候选getter或忽略symbol权限字段');

  const draftSnapshot = clone(base.draft), contextSnapshot = clone(base.context), pending = prepareReferencePropositionReviewInput(contextSnapshot, draftSnapshot);
  draftSnapshot.anchors[0].text = '异步篡改'; contextSnapshot.frames[0].source.version = '异步篡改';
  assert.deepEqual((await pending).draft, base.draft); assert.deepEqual((await pending).reference, base.context);
  const pendingReview = clone(base.review), finalizing = finalizeReferencePropositions(base.context, base.draft, pendingReview);
  pendingReview.anchors[0].decision = 'reject'; ready(await finalizing);
  const proofSnapshot = { draft: clone(base.draft), review: clone(base.review) }, bundleSnapshot = clone(base.bundle);
  const validating = validateReferencePropositions(base.context, bundleSnapshot, proofSnapshot);
  bundleSnapshot.semanticTruth = 'certified' as any; proofSnapshot.review.anchors[0].decision = 'reject'; ready(await validating);
  input.reference.frames[0].source.version = 'mutated-return'; input.draft.anchors[0].text = 'mutated-return';
  assert.notEqual(base.context.frames[0].source.version, 'mutated-return'); assert.notEqual(base.draft.anchors[0].text, 'mutated-return');
  pass('首次await前捕获完整context/draft/review/proof快照；返回对象不反向污染调用方');

  const tooMany = clone(base.draft); tooMany.anchors = Array.from({ length: REFERENCE_PROPOSITION_LIMITS.anchors + 1 }, (_, index) => ({ ...base.draft.anchors[0], id: `limit-${index}` }));
  await assert.rejects(() => prepareReferencePropositionReviewInput(base.context, tooMany), /invalid_proposition_draft/u);
  const tooLong = clone(base.draft); tooLong.anchors[0].text = '字'.repeat(REFERENCE_PROPOSITION_LIMITS.text + 1); tooLong.anchors[0].end = tooLong.anchors[0].start + tooLong.anchors[0].text.length;
  await assert.rejects(() => prepareReferencePropositionReviewInput(base.context, tooLong), /invalid_proposition_draft/u);
  const overContext = clone(base.context); overContext.quotes[0].text = '字'.repeat(REFERENCE_PROPOSITION_LIMITS.context); overContext.quotes[0].end = overContext.quotes[0].start + overContext.quotes[0].text.length;
  held(await finalizeReferencePropositions(overContext, base.draft, base.review), 'proposition_context_budget_exceeded');
  pass('候选数/锚点长度/完整参考字符预算超限fail closed，不裁剪任何必要标准');

  // A structurally consistent synthetic DTO isolates budget accounting, NOT a
  // claim that altered source DTOs have independently passed real-vault admission.
  const expansive = clone(base.context), firstQuote = expansive.quotes.find(quote => quote.quoteId === base.draft.anchors[0].quoteId)!;
  firstQuote.text = '字'.repeat(1500); firstQuote.end = firstQuote.start + firstQuote.text.length;
  const orderedQuotes = [...expansive.quotes].sort((left, right) => left.start - right.start);
  let nextStart = 0;
  for (const quote of orderedQuotes) { quote.start = nextStart; quote.end = nextStart + quote.text.length; nextStart = quote.end + 4; }
  const expansiveDraft = await makeDraft(expansive);
  for (let index = 1; expansiveDraft.anchors.length < REFERENCE_PROPOSITION_LIMITS.anchors; index++)
    expansiveDraft.anchors.push({ ...expansiveDraft.anchors[0], id: `additional-literal-${index}`,
      start: firstQuote.start + index, end: firstQuote.start + index + 1, text: '字' });
  assert.ok(JSON.stringify(expansiveDraft).length < REFERENCE_PROPOSITION_LIMITS.draft);
  const expansiveReview = await makeReview(expansive, expansiveDraft);
  held(await finalizeReferencePropositions(expansive, expansiveDraft, expansiveReview), 'proposition_bundle_budget_exceeded');
  const verboseReview = clone(expansiveReview); verboseReview.anchors.forEach(row => { row.reason = '审'.repeat(320); });
  assert.ok(JSON.stringify(verboseReview).length > REFERENCE_PROPOSITION_LIMITS.review);
  held(await finalizeReferencePropositions(expansive, expansiveDraft, verboseReview), 'proposition_review_budget_exceeded');
  pass('完整父上下文重复形成bundle超预算或审核票超预算整体held，不删候选/缩理由/截来源');
  console.log(`Reference proposition checks: ${checks} synthetic groups; zero cloud, production writes or semantic-accuracy claim.`);
} finally { globalThis.fetch = originalFetch; }
