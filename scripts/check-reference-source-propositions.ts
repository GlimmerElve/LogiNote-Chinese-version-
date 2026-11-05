import assert from 'node:assert/strict';
import { createReferenceDisclosureFixture } from './reference-disclosure-fixture.ts';
import { buildArgumentReferenceDisclosure } from '../src/services/argumentContext/referenceDisclosure.ts';
import { argumentContextHash } from '../src/services/argumentContext/hash.ts';
import { prepareSourcePropositionContext, prepareSourcePropositionReviewInput, finalizeSourcePropositions,
  validateSourcePropositions, projectReferenceSourcePropositions, validateReviewedReferencePropositions,
  SOURCE_PROPOSITION_LIMITS, SourcePropositionError, type SourcePropositionContext, type SourcePropositionDraft,
  type SourcePropositionReview, type SourcePropositionProof } from '../src/services/reviewComparison/sourcePropositionAnchors.ts';
import { finalizeReferencePropositions, prepareReferencePropositionReviewInput,
  type ReferencePropositionDraft, type ReferencePropositionReview } from '../src/services/reviewComparison/referencePropositionAnchors.ts';
import { adaptSavedKnowledgeNote } from '../src/electron/rag/argumentSourceAdapter.ts';
import { prepareArgumentProjectionBuild, buildArgumentProjectionReviewInput, finalizeArgumentProjectionBuild } from '../src/services/argumentContext/construction.ts';
import { fixedAcceptProjectionReview } from './argument-projection-build-fixture.ts';
import type { ArgumentProjectionDraft } from '../src/services/argumentContext/buildTypes.ts';

const oldFetch = globalThis.fetch; globalThis.fetch = async () => assert.fail('source proposition checks forbid network');
const clone = <T>(value: T): T => structuredClone(value);
let groups = 0; const pass = (label: string) => { groups++; console.log(`PASS ${label}`); };
const isHeld = (value: { status: string }, code?: string) => {
  assert.equal(value.status, 'held', JSON.stringify(value));
  if (code) assert.deepEqual((value as unknown as { reasons: string[] }).reasons, [code]);
};
async function reject(call: () => Promise<unknown>, code?: string) {
  await assert.rejects(call, (error: unknown) => error instanceof SourcePropositionError && (!code || error.message === code));
}
async function draftFor(context: SourcePropositionContext, specificConclusion = true): Promise<SourcePropositionDraft> {
  return { version: 1, protocol: 'review-source-proposition-draft-v1', contextHash: await argumentContextHash(context),
    anchors: context.projection.nodes.map(node => {
      const span = node.evidence[0], quote = context.quotes.find(row => row.evidence.start === span.start && row.evidence.end === span.end)!;
      // Explicit authored fixture selection, never automatic parsing of 因此/所以.
      const text = specificConclusion && node.role === 'conclusion' ? '本次合成包裹会进入二号通道' : span.quote;
      const start = span.start + span.quote.indexOf(text); assert.ok(start >= span.start);
      return { id: `P-${node.id}`, nodeId: node.id, quoteId: quote.quoteId, start, end: start + text.length, text };
    }) };
}
async function reviewFor(context: SourcePropositionContext, draft: SourcePropositionDraft): Promise<SourcePropositionReview> {
  const prepared = await prepareSourcePropositionReviewInput(context, draft);
  return { version: 1, protocol: 'review-source-proposition-review-v1', reviewId: prepared.reviewId,
    contextHash: prepared.contextHash, draftHash: prepared.draftHash, anchors: draft.anchors.map(anchor => ({ id: anchor.id,
      decision: 'accept', roleSupported: true, completeMeaning: true, scopePreserved: true,
      reason: '独立离线固定审票只验合同，不认证语义。' })) };
}
async function rig(options: Parameters<typeof createReferenceDisclosureFixture>[0] = { task: 'reasoning', theme: 'progressive-parcel-v1' }) {
  const fixture = await createReferenceDisclosureFixture(options), proofs: SourcePropositionProof[] = [];
  for (const [key, input] of fixture.inputs) {
    const result = fixture.results.get(key)!, context = await prepareSourcePropositionContext(input, result);
    const draft = await draftFor(context, options.task === 'reasoning'), review = await reviewFor(context, draft);
    const reply = await finalizeSourcePropositions(context, draft, review); assert.ok(reply.status === 'ready', JSON.stringify(reply));
    proofs.push({ input, result, draft, review, bundle: reply.bundle });
  }
  const disclosed = await buildArgumentReferenceDisclosure(fixture.frozen); assert.ok(disclosed.status === 'ready');
  const projected = await projectReferenceSourcePropositions(disclosed.context, proofs); assert.ok(projected.status === 'ready', JSON.stringify(projected));
  return { fixture, proofs, reference: disclosed.context, projected,
    context: await prepareSourcePropositionContext(proofs[0].input, proofs[0].result) };
}
async function rehashResult(proof: SourcePropositionProof) {
  proof.result.authority.structureHash = await argumentContextHash(proof.result.projection);
  const { resultHash: _hash, ...body } = proof.result; proof.result.resultHash = await argumentContextHash(body);
}
async function multiStep(base: Awaited<ReturnType<typeof rig>>) {
  const texts = ['本次合成包裹带有蓝印。', '本次合成包裹进入二号通道。', '只有系统已联网时，本次连续分拣才适用。', '本次合成包裹到达二号柜。'];
  const note = { ...clone(base.fixture.notes[0]), content: texts.join('\r\n\r\n') }, scope = clone(base.proofs[0].input.scope);
  const adapted = await adaptSavedKnowledgeNote({ note, rootScopeId: scope.rootScopeId, scope });
  const input = await prepareArgumentProjectionBuild({ source: adapted.source, canonicalText: adapted.canonicalText,
    hierarchy: adapted.hierarchy, scope, chunks: adapted.chunks,
    sourceQualification: { status: 'eligible', policyVersion: 'offline-multistep', evidence: [adapted.quotes[0].evidence] } });
  const quoteIds = texts.map(text => input.quotes.find(quote => quote.completeSentence && quote.evidence.quote === text)!.quoteId);
  const draft: ArgumentProjectionDraft = { version: 1, buildId: input.buildId,
    nodes: [{ id: 'N1', role: 'fact', quoteIds: [quoteIds[0]] }, { id: 'N2', role: 'conclusion', quoteIds: [quoteIds[1]] },
      { id: 'N3', role: 'condition', quoteIds: [quoteIds[2]] }, { id: 'N4', role: 'conclusion', quoteIds: [quoteIds[3]] }],
    relations: [{ id: 'E1', sourceNodeId: 'N1', targetNodeId: 'N2', kind: 'support', quoteIds: [quoteIds[1]] },
      { id: 'E2', sourceNodeId: 'N3', targetNodeId: 'N2', kind: 'requires_condition', quoteIds: [quoteIds[2]] },
      { id: 'E3', sourceNodeId: 'N2', targetNodeId: 'N4', kind: 'support', quoteIds: [quoteIds[3]] },
      { id: 'E4', sourceNodeId: 'N3', targetNodeId: 'N4', kind: 'requires_condition', quoteIds: [quoteIds[2]] }],
    groups: [{ id: 'G1', conclusionNodeId: 'N2', premiseNodeIds: ['N1'], conditionNodeIds: ['N3'], relationIds: ['E1', 'E2'], operator: 'all', quoteIds: [quoteIds[1], quoteIds[2]] },
      { id: 'G2', conclusionNodeId: 'N4', premiseNodeIds: ['N2'], conditionNodeIds: ['N3'], relationIds: ['E3', 'E4'], operator: 'all', quoteIds: [quoteIds[2], quoteIds[3]] }],
    scopes: [{ id: 'S1', seedNodeId: 'N4', task: 'reasoning', requiredNodeIds: ['N1', 'N2', 'N3', 'N4'],
      requiredRelationIds: ['E1', 'E2', 'E3', 'E4'], requiredGroupIds: ['G1', 'G2'], quoteIds }] };
  const result = await finalizeArgumentProjectionBuild(input, draft, fixedAcceptProjectionReview(await buildArgumentProjectionReviewInput(input, draft)));
  assert.equal(result.status, 'reviewed_complete');
  const context = await prepareSourcePropositionContext(input, result), sourceDraft = await draftFor(context, false), review = await reviewFor(context, sourceDraft);
  const ready = await finalizeSourcePropositions(context, sourceDraft, review); assert.ok(ready.status === 'ready');
  const source: SourcePropositionProof = { input, result, draft: sourceDraft, review, bundle: ready.bundle };
  const reference = clone(base.reference), frame = reference.frames[0];
  frame.source = { kind: 'knowledge-note', entityId: input.source.entityId, version: input.source.version, contentHash: input.source.contentHash,
    coordinateSpace: input.source.coordinateSpace, structureHash: result.authority.structureHash };
  reference.quotes = texts.map((text, index) => { const quote = input.quotes.find(quote => quote.quoteId === quoteIds[index])!;
    return { quoteId: `Q${index + 1}`, sourceKey: context.sourceKey, start: quote.evidence.start, end: quote.evidence.end, text }; });
  frame.nodes = draft.nodes.map((node, index) => ({ id: node.id, role: node.role, quoteIds: [`Q${index + 1}`] }));
  frame.relations = draft.relations.map(relation => ({ ...relation, quoteIds: relation.quoteIds.map(id => `Q${quoteIds.indexOf(id) + 1}`) }));
  frame.groups = draft.groups.map(({ quoteIds: _quotes, ...group }) => group);
  frame.items[0].quoteId = 'Q1'; frame.items[0].nodeIds = ['N1']; frame.items[0].relationIds = [];
  frame.items[1].quoteId = 'Q3'; frame.items[1].nodeIds = ['N3']; frame.items[1].relationIds = [];
  frame.items[2].quoteId = 'Q4'; frame.items[2].nodeIds = draft.scopes[0].requiredNodeIds; frame.items[2].relationIds = draft.scopes[0].requiredRelationIds;
  // Synthetic complete DTO only; this check does not grant active host authority.
  return { reference, source };
}
try {
  const base = await rig(), proof = base.proofs[0];
  assert.equal(base.context.source.kind, 'knowledge-note');
  assert.equal(base.context.sourceKey, await argumentContextHash({ source: proof.input.source, structureHash: proof.result.authority.structureHash }));
  assert.deepEqual(base.context.quotes, proof.input.quotes);
  assert.deepEqual(base.context.projection, proof.result.projection);
  assert.equal(proof.bundle.anchors.length, 4); assert.equal(base.projected.bundle.anchors.length, 3);
  assert.equal(JSON.stringify(base.context).includes('questionMessageId'), false);
  pass('源合同完整保存身份/正文/真实quoteId/图与scopes，不含题目、画像或回答；审核覆盖全部源节点');

  const n2 = proof.bundle.anchors.find(anchor => anchor.nodeId === 'N2')!;
  assert.equal(n2.text, '本次合成包裹会进入二号通道');
  assert.equal(n2.parent.evidence.quote, base.fixture.paragraphs[1]);
  assert.equal(n2.parent.evidence.quote.split('会进入二号通道').length - 1, 2);
  assert.equal(n2.role, 'conclusion');
  pass('复合N2显式选具体结论，完整复合父原文仍保留；重复谓词不猜第一次');

  assert.equal((await validateSourcePropositions(proof.input, proof.result, proof.bundle, { draft: proof.draft, review: proof.review })).status, 'ready');
  assert.equal((await validateReviewedReferencePropositions(base.reference, base.projected.bundle, base.projected.proof)).status, 'ready');
  assert.equal(base.projected.bundle.version, 2);
  assert.deepEqual(base.projected.bundle.reviewBasis, { kind: 'source-reviewed', sourceBundleHashes: [proof.bundle.bundleHash], questionSpecificReview: 'not_performed' });
  assert.equal(Object.hasOwn(base.projected.bundle, 'reviewId'), false);
  assert.equal(base.projected.bundle.semanticTruth, 'not_certified'); assert.equal(base.projected.bundle.writes, 'disabled');
  pass('原生源证明独立重建，题前v2明确复用源审票且未作新题审核，不伪造v1票');

  const nextFrozen = await base.fixture.service.prepare({ ...base.fixture.selectors, questionMessageId: 'offline-next-question' });
  const nextReference = await buildArgumentReferenceDisclosure(nextFrozen); assert.ok(nextReference.status === 'ready');
  const nextProjection = await projectReferenceSourcePropositions(nextReference.context, base.proofs); assert.ok(nextProjection.status === 'ready');
  assert.notEqual(nextProjection.bundle.contractHash, base.projected.bundle.contractHash);
  assert.deepEqual(nextProjection.bundle.reviewBasis.sourceBundleHashes, base.projected.bundle.reviewBasis.sourceBundleHashes);
  assert.deepEqual(nextProjection.proof.sources, base.projected.proof.sources);
  pass('同一已审源bundle可跨两道新题机械复用，原源proof不变、不补模型请求');

  const missing = clone(proof.draft); missing.anchors = missing.anchors.filter(anchor => anchor.nodeId !== 'N4');
  await reject(() => prepareSourcePropositionReviewInput(base.context, missing), 'source_proposition_required_nodes_missing');
  isHeld(await finalizeSourcePropositions(base.context, missing, proof.review));
  pass('未披露的源N4也须源阶段审核覆盖；漏节点在第二请求前拒绝');

  for (const mutate of [
    (review: SourcePropositionReview) => { review.anchors[0].decision = 'unknown'; },
    (review: SourcePropositionReview) => { review.anchors[0].decision = 'reject'; },
    (review: SourcePropositionReview) => { review.anchors[0].completeMeaning = false; },
    (review: SourcePropositionReview) => { review.anchors[0].roleSupported = false; },
    (review: SourcePropositionReview) => { review.anchors[0].scopePreserved = false; },
  ]) { const review = clone(proof.review); mutate(review); isHeld(await finalizeSourcePropositions(base.context, proof.draft, review), 'source_proposition_review_held'); }
  const incomplete = clone(proof.review); incomplete.anchors.pop(); isHeld(await finalizeSourcePropositions(base.context, proof.draft, incomplete), 'source_proposition_review_incomplete');
  pass('所有候选都须独立accept+职责/完整/范围三项true，不静默删拒绝或未知候选');

  for (const field of ['reviewId', 'contextHash', 'draftHash'] as const) {
    const review = clone(proof.review); review[field] = field === 'reviewId' ? 'other-review' : 'f'.repeat(64);
    isHeld(await finalizeSourcePropositions(base.context, proof.draft, review), 'source_proposition_review_binding_changed');
  }
  const oldTicket = { ...clone(proof.review), protocol: 'review-reference-proposition-review-v1' };
  isHeld(await finalizeSourcePropositions(base.context, proof.draft, oldTicket as any));
  pass('审核严格绑定源context/draft/reviewId，旧题级票和别源票不混用');

  for (const mutate of [
    (draft: SourcePropositionDraft) => { draft.anchors[0].start++; draft.anchors[0].end++; },
    (draft: SourcePropositionDraft) => { draft.anchors[0].text += ' '; },
    (draft: SourcePropositionDraft) => { draft.anchors[0].quoteId = 'missing'; },
    (draft: SourcePropositionDraft) => { draft.anchors[0].nodeId = 'N2'; },
    (draft: SourcePropositionDraft) => { draft.anchors.push(clone(draft.anchors[0])); },
  ]) { const draft = clone(proof.draft); mutate(draft); await reject(() => prepareSourcePropositionReviewInput(base.context, draft)); }
  pass('准确绝对UTF16子串、节点父quote归属、重复id/坐标严格核对，无修剪或归一化');

  const repeated = await rig({ task: 'definition', repeatedOccurrences: true });
  const repeatAnchors = repeated.proofs[0].bundle.anchors.slice(0, 2);
  assert.equal(repeatAnchors[0].text, repeatAnchors[1].text); assert.notEqual(repeatAnchors[0].start, repeatAnchors[1].start);
  const borrowed = clone(repeated.proofs[0].draft); Object.assign(borrowed.anchors[1], { start: repeatAnchors[0].start, end: repeatAnchors[0].end });
  await reject(() => prepareSourcePropositionReviewInput(repeated.context, borrowed));
  pass('两个真实重复短语按不同源坐标保留；第二处不能借第一处坐标');

  const astral = await rig({ task: 'definition' }), astralDraft = clone(astral.proofs[0].draft), first = astralDraft.anchors[0];
  const offset = first.text.indexOf('🧠'); assert.ok(offset >= 0);
  first.start += offset; first.end = first.start + 1; first.text = '🧠'.slice(0, 1);
  await reject(() => prepareSourcePropositionReviewInput(astral.context, astralDraft), 'invalid_source_proposition_anchor');
  pass('UTF16不能切半个代理对，emoji坐标不按字符数猜测');

  for (const mutate of [
    (context: SourcePropositionContext) => { context.qualification.status = 'unassessed'; },
    (context: SourcePropositionContext) => { context.projection.nodes[0].admission = 'audit_only'; },
    (context: SourcePropositionContext) => { context.projection.nodes[0].semanticStatus = 'unreviewed'; },
    (context: SourcePropositionContext) => { context.projection.build.scopes[0].status = 'partial'; },
    (context: SourcePropositionContext) => { context.projection.prerequisiteGroups[0].operator = 'unknown'; },
    (context: SourcePropositionContext) => { context.source.kind = 'personal-cognition'; },
  ]) { const context = clone(base.context); mutate(context); await reject(() => prepareSourcePropositionReviewInput(context, proof.draft), 'source_proposition_not_qualified'); }
  pass('无资格/未审/局部scope/未知组和个人认知源fail-closed，不把自己声称质量当授权');

  for (const mutate of [
    (source: SourcePropositionProof) => { source.input.source.version = 'changed'; },
    (source: SourcePropositionProof) => { source.input.canonicalText += 'new'; },
    (source: SourcePropositionProof) => { source.result.buildId = 'f'.repeat(64); },
    (source: SourcePropositionProof) => { source.result.authority.structureHash = 'f'.repeat(64); },
    (source: SourcePropositionProof) => { source.result.resultHash = 'f'.repeat(64); },
  ]) { const source = clone(proof); mutate(source); isHeld(await validateSourcePropositions(source.input, source.result, source.bundle, { draft: source.draft, review: source.review })); }
  pass('源完整身份/正文/版本/buildId/resultHash/structureHash不可换绑');

  const changedGraph = clone(proof); changedGraph.result.projection.nodes[0].role = 'hypothesis'; await rehashResult(changedGraph);
  isHeld(await validateSourcePropositions(changedGraph.input, changedGraph.result, changedGraph.bundle, { draft: changedGraph.draft, review: changedGraph.review }));
  const changedBundle = clone(proof.bundle); changedBundle.anchors[1].parent.evidence.quote += '伪造';
  const { bundleHash: _old, ...changedBody } = changedBundle; changedBundle.bundleHash = await argumentContextHash(changedBody);
  isHeld(await validateSourcePropositions(proof.input, proof.result, changedBundle, { draft: proof.draft, review: proof.review }), 'source_proposition_bundle_changed');
  pass('重算自带hash不能修复独立源proof/派生role/完整父原文；纯模块仍要求caller当前host认证');

  isHeld(await projectReferenceSourcePropositions(base.reference, []), 'source_proposition_source_missing_or_ambiguous');
  isHeld(await projectReferenceSourcePropositions(base.reference, [proof, clone(proof)]), 'source_proposition_source_missing_or_ambiguous');
  const other = await rig({ task: 'reasoning', theme: 'progressive-parcel-v1', noteCount: 2 });
  isHeld(await projectReferenceSourcePropositions(base.reference, other.proofs), 'source_proposition_source_out_of_scope');
  pass('缺源/同源歧义/额外非题目来源严格held，不自行扩大检索范围');

  for (const mutate of [
    (reference: typeof base.reference) => { reference.frames[0].source.version = 'changed'; },
    (reference: typeof base.reference) => { reference.frames[0].source.structureHash = 'f'.repeat(64); },
    (reference: typeof base.reference) => { reference.frames[0].nodes[0].role = 'definition'; },
    (reference: typeof base.reference) => { reference.quotes[0].sourceKey = 'f'.repeat(64); },
    (reference: typeof base.reference) => { reference.quotes[0].text += '改'; reference.quotes[0].end++; },
    (reference: typeof base.reference) => { reference.frames[0].relations[0].kind = 'oppose'; },
  ]) { const reference = clone(base.reference); mutate(reference); isHeld(await projectReferenceSourcePropositions(reference, base.proofs)); }
  pass('题前identity/structure/node-role/父文/sourceKey/真实关系必须精确取自当前源');

  const changedGroup = clone(base.reference); changedGroup.frames[0].groups[0].conditionNodeIds = [];
  isHeld(await projectReferenceSourcePropositions(changedGroup, base.proofs), 'source_proposition_group_changed');
  const omittedCondition = clone(base.reference), inference = omittedCondition.frames[0].items.find(item => item.criterionId === 'inference_link')!;
  inference.nodeIds = inference.nodeIds.filter(id => id !== 'N3');
  isHeld(await projectReferenceSourcePropositions(omittedCondition, base.proofs), 'source_proposition_required_closure_missing');
  const omittedGroup = clone(base.reference); omittedGroup.frames[0].groups = [];
  isHeld(await projectReferenceSourcePropositions(omittedGroup, base.proofs), 'source_proposition_required_closure_missing');
  const lowerStandard = clone(base.reference); lowerStandard.frames[0].groups = [];
  lowerStandard.frames[0].relations = lowerStandard.frames[0].relations.filter(relation => relation.id !== 'E2');
  lowerStandard.frames[0].nodes = lowerStandard.frames[0].nodes.filter(node => node.id !== 'N3');
  for (const item of lowerStandard.frames[0].items) { item.nodeIds = item.nodeIds.filter(id => id !== 'N3'); item.relationIds = item.relationIds.filter(id => id !== 'E2'); }
  isHeld(await projectReferenceSourcePropositions(lowerStandard, base.proofs));
  pass('ALL组及推理item必要条件不因小锚点遗漏，题前不降低原required闭包');

  const alias = await rig({ task: 'reasoning', theme: 'progressive-parcel-v1', aliasTargets: true });
  assert.equal(alias.projected.proof.sources.length, 1); assert.equal(alias.projected.bundle.anchors.length, 6);
  assert.equal(new Set(alias.projected.bundle.anchors.map(anchor => anchor.id)).size, 6);
  assert.deepEqual(alias.projected.bundle.anchors[0].parent, alias.projected.bundle.anchors[3].parent);
  const compoundDraft = clone(proof.draft); compoundDraft.anchors.push({ ...n2, id: 'P-N2-second', text: n2.parent.evidence.quote,
    start: n2.parent.evidence.start, end: n2.parent.evidence.end } as any); delete (compoundDraft.anchors.at(-1) as any).role; delete (compoundDraft.anchors.at(-1) as any).parent;
  const compoundReview = await reviewFor(base.context, compoundDraft), compound = await finalizeSourcePropositions(base.context, compoundDraft, compoundReview);
  assert.ok(compound.status === 'ready');
  const compoundProjection = await projectReferenceSourcePropositions(base.reference, [{ ...proof, draft: compoundDraft, review: compoundReview, bundle: compound.bundle }]);
  assert.ok(compoundProjection.status === 'ready'); assert.equal(compoundProjection.bundle.anchors.filter(anchor => anchor.nodeId === 'N2').length, 2);
  pass('同源多frame及同节点多个独立合法命题兼容，不强制一对一、不新造多步证明标准');

  const chain = await multiStep(base), chainProjection = await projectReferenceSourcePropositions(chain.reference, [chain.source]);
  assert.ok(chainProjection.status === 'ready', JSON.stringify(chainProjection));
  assert.equal(chainProjection.bundle.anchors.length, 4);
  assert.equal(chainProjection.bundle.anchors.find(anchor => anchor.nodeId === 'N2')!.role, 'conclusion');
  assert.equal(chain.reference.frames[0].groups[1].premiseNodeIds[0], 'N2');
  const brokenChain = clone(chain.reference); brokenChain.frames[0].groups.pop();
  isHeld(await projectReferenceSourcePropositions(brokenChain, [chain.source]), 'source_proposition_required_closure_missing');
  pass('两级真实结构N1→N2→N4保留，前段conclusion作为后段premise合法；漏原组不可降标准');

  const condition = await rig({ task: 'condition', theme: 'progressive-parcel-v1' });
  assert.ok(condition.projected.bundle.anchors[1].parent.text.includes('即使'));
  assert.ok(condition.projected.bundle.anchors[1].parent.text.includes('也不'));
  pass('条件和否定语境完整保留，是否截掉含义由独立审核决定而非关键词裁剪');

  const v1Draft: ReferencePropositionDraft = { version: 1, protocol: 'review-reference-proposition-draft-v1', contractHash: base.reference.contractHash,
    contextHash: await argumentContextHash(base.reference), anchors: base.projected.bundle.anchors.map(({ id, frameId, nodeId, quoteId, start, end, text }) => ({ id, frameId, nodeId, quoteId, start, end, text })) };
  const v1Input = await prepareReferencePropositionReviewInput(base.reference, v1Draft);
  const v1Review: ReferencePropositionReview = { version: 1, protocol: 'review-reference-proposition-review-v1', reviewId: v1Input.reviewId,
    contextHash: v1Input.contextHash, draftHash: v1Input.draftHash, anchors: v1Draft.anchors.map(anchor => ({ id: anchor.id,
      decision: 'accept', roleSupported: true, completeMeaning: true, scopePreserved: true, reason: '独立固定题级票。' })) };
  const legacy = await finalizeReferencePropositions(base.reference, v1Draft, v1Review); assert.ok(legacy.status === 'ready');
  assert.equal((await validateReviewedReferencePropositions(base.reference, legacy.bundle, { draft: v1Draft, review: v1Review })).status, 'ready');
  isHeld(await validateReviewedReferencePropositions(base.reference, base.projected.bundle, { draft: v1Draft, review: v1Review }));
  isHeld(await validateReviewedReferencePropositions(base.reference, legacy.bundle, base.projected.proof));
  const fakeTicket = { ...clone(base.projected.bundle), reviewId: v1Input.reviewId };
  isHeld(await validateReviewedReferencePropositions(base.reference, fakeTicket as any, base.projected.proof));
  pass('v1原合同原票保持有效；v2/v1跨版本或添加伪新题票严格拒绝');

  const tampered = clone(base.projected.bundle); tampered.reviewBasis.questionSpecificReview = 'performed' as any;
  isHeld(await validateReviewedReferencePropositions(base.reference, tampered, base.projected.proof));
  const rehashed = clone(base.projected.bundle); rehashed.anchors[0].role = 'claim';
  const { bundleHash: _hash, ...body } = rehashed; rehashed.bundleHash = await argumentContextHash(body);
  isHeld(await validateReviewedReferencePropositions(base.reference, rehashed, base.projected.proof), 'source_proposition_question_bundle_changed');
  pass('v2不自认证来源审票/当前题角色；篡改后重算bundleHash依然held');

  const sparse = clone(proof.draft); delete sparse.anchors[0]; await reject(() => prepareSourcePropositionReviewInput(base.context, sparse));
  const extra = clone(proof.draft); (extra as any).answer = 'pollution'; await reject(() => prepareSourcePropositionReviewInput(base.context, extra));
  let reads = 0; const getter = clone(proof.draft); Object.defineProperty(getter.anchors[0], 'text', { enumerable: true, get() { reads++; return 'unsafe'; } });
  await reject(() => prepareSourcePropositionReviewInput(base.context, getter)); assert.equal(reads, 0);
  const symbol = clone(proof.review); (symbol as any)[Symbol('authority')] = true;
  isHeld(await finalizeSourcePropositions(base.context, proof.draft, symbol));
  pass('闭合schema/稠密数组/无getter或隐藏symbol；不读取恶意getter');

  const hiddenLength = clone(proof.draft); Object.defineProperty(hiddenLength, 'length', { value: 0, enumerable: false });
  await reject(() => prepareSourcePropositionReviewInput(base.context, hiddenLength));
  const hiddenContextLength = clone(base.context); Object.defineProperty(hiddenContextLength, 'length', { value: 0, enumerable: false });
  await reject(() => prepareSourcePropositionReviewInput(hiddenContextLength, proof.draft));
  pass('普通DTO的隐藏length不是数组结构字段，首clone前拒绝，不因快照抹掉扩展键而放行');

  const huge = clone(proof.draft); huge.anchors[0].id = 'a'.repeat(301); await reject(() => prepareSourcePropositionReviewInput(base.context, huge));
  const tooMany = clone(proof.draft); while (tooMany.anchors.length <= SOURCE_PROPOSITION_LIMITS.anchors) tooMany.anchors.push({ ...tooMany.anchors[0], id: `many-${tooMany.anchors.length}` });
  await reject(() => prepareSourcePropositionReviewInput(base.context, tooMany));
  const manyProofs = Array.from({ length: 21 }, () => clone(proof)); isHeld(await projectReferenceSourcePropositions(base.reference, manyProofs));
  pass('源/题前候选与proof预算有界，超限整体暂停不截断');

  const savedDraft = clone(proof.draft), promise = prepareSourcePropositionReviewInput(base.context, savedDraft); savedDraft.anchors[0].text = 'changed-after-await';
  assert.equal((await promise).draft.anchors[0].text, proof.draft.anchors[0].text);
  const sources = clone(base.proofs), projectPromise = projectReferenceSourcePropositions(base.reference, sources); sources[0].review.anchors[0].decision = 'reject';
  assert.equal((await projectPromise).status, 'ready');
  pass('首次await前捕获源/题前输入，运行中外部修改不换绑；全程零网络');
  console.log(`SOURCE PROPOSITION CHECKS PASSED ${groups} groups`);
} finally { globalThis.fetch = oldFetch; }
