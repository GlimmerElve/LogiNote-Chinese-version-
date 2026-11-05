import assert from 'node:assert/strict';
import type { CognitionFile } from '../src/services/cognition/types.ts';
import type { ReviewQuestionIntent } from '../src/services/reviewIntent.ts';
import { parseReviewQuestionIntent } from '../src/services/reviewIntentValidation.ts';
import { freezeReviewAssessment } from '../src/services/reviewAssessment.ts';
import type { ReviewReferenceRubric } from '../src/services/reviewReferenceRubric.ts';
import { argumentContextHash } from '../src/services/argumentContext/hash.ts';
import type { ArgumentReferenceDisclosureContext, ArgumentReferenceDisclosureReply } from '../src/services/argumentContext/referenceDisclosure.ts';
import { reviewSnapshotHash, resolveReviewPersonalSnapshot } from '../src/services/reviewComparison/packet.ts';
import type { ReviewComparisonPacket } from '../src/services/reviewComparison/types.ts';
import type { FrozenReferenceShadowInput, FrozenReferenceShadowModel } from '../src/services/reviewComparison/frozenReferenceShadow.ts';
import { createFrozenReferenceShadowModel } from '../src/services/reviewComparison/frozenReferenceModel.ts';
import type { FrozenReferenceTypedInputV4 } from '../src/services/reviewComparison/frozenReferenceTyped.ts';
import { evaluateReviewProgressiveShadow, type ReviewProgressiveShadowDependencies } from '../src/services/reviewComparison/progressiveShadow.ts';

// PURE MOCKS. No filesystem, cloud/provider/configuration, search, user data or writes.
// The synthetic retained-reference mock is not a host-authority integration test,
// and fixed reviewer votes claim no semantic model accuracy or factual truth.
const oldFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('Progressive shadow mocks forbid network');
const at = '2026-10-07T00:00:00.000Z';
const answer = '在条件B下观察到A。因此A可能导致C。';
const answerParts = ['在条件B下观察到A。', '因此A可能导致C。'];
let checks = 0;
const pass = (label: string) => { checks++; console.log(`PASS ${label}`); };
async function rehash(packet: ReviewComparisonPacket): Promise<ReviewComparisonPacket> {
  const { packetId: _id, snapshotHash: _hash, ...body } = packet;
  const snapshotHash = await reviewSnapshotHash(body);
  return { ...body, snapshotHash, packetId: `review-comparison:${snapshotHash}` };
}
function accepted(input: FrozenReferenceShadowInput) {
  return { version: 1, evaluationId: input.evaluationId, contractHash: input.reference.contractHash,
    items: input.reference.frames.flatMap(frame => frame.items.map(item => ({ frameId: frame.frameId, itemId: item.itemId,
      verdict: 'supported', claimIds: input.graph.claims.map(claim => claim.id), edgeIds: [], nodeMappings: [], nodeIds: [...item.nodeIds],
      relationIds: [...item.relationIds], axes: { object: 'match', metric: 'not_applicable', condition: 'match',
        time: 'not_applicable', certainty: 'match' }, direction: 'not_required', premises: 'not_required' }))) };
}
async function rig() {
  let file: CognitionFile = { schemaVersion: 1, revision: 1, records: [{ id: 'PRIVATE_RECORD', docId: 'PRIVATE_RECORD', revisions: [{
    id: 'PRIVATE_REVISION', number: 1, at, operation: 'initial', reason: '', authorship: 'own_expression',
    source: { kind: 'argument_editor', docId: 'PRIVATE_RECORD' }, factSupport: 'not_assessed', mastery: 'not_assessed',
    branches: [{ id: 'PRIVATE_BRANCH', kind: 'primary', context: 'PRIVATE_STORED_CONTEXT', stance: 'tentative',
      graph: { title: 'PRIVATE_BRANCH_TITLE', nodes: [{ id: 'PRIVATE_TARGET', text: 'PRIVATE_OLD_TARGET', mainType: '推理' },
        { id: 'PRIVATE_PREMISE', text: 'PRIVATE_OLD_PREMISE', mainType: '事实陈述' },
        { id: 'PRIVATE_CONCLUSION', text: 'PRIVATE_OLD_CONCLUSION', mainType: '推理' }],
      edges: [{ id: 'private-edge1', source: 'PRIVATE_PREMISE', target: 'PRIVATE_TARGET', relation: 'support' },
        { id: 'private-edge2', source: 'PRIVATE_TARGET', target: 'PRIVATE_CONCLUSION', relation: 'oppose' }] },
      reviewNeededNodeIds: ['PRIVATE_TARGET'] }] }] }] };
  const targets = ['合成概念'], assessment = freezeReviewAssessment('definition', targets);
  const referenceQuotes = ['REFERENCE_MEANING', 'REFERENCE_BOUNDARY'];
  const rubric: ReviewReferenceRubric = { version: 1, rubricVersion: 'note-reference-items-v1', scope: 'question_items', status: 'fixed',
    taskType: 'definition', catalogId: `reference-catalog:${'a'.repeat(64)}`, items: referenceQuotes.map((quote, index) => ({
      candidateId: `K${index + 1}`, itemId: `I${index + 1}`, knowledgeTarget: targets[0], noteId: 'fixed-reference',
      sourceHash: 'b'.repeat(64), sourceUpdatedAt: at, sectionPath: '', quote, start: index * 100, end: index * 100 + quote.length,
      criterionId: index ? 'concept_boundary' : 'concept_meaning' })) };
  const intent = parseReviewQuestionIntent({ version: 1, questionMessageId: 'question1', knowledgeTargets: targets,
    assessment, referenceRubric: rubric, referenceStructure: { version: 1, status: 'fixed', originQuestionMessageId: 'question1',
      freezeId: '12345678-1234-1234-1234-123456789abc', contractHash: 'c'.repeat(64),
      selectorsHash: await argumentContextHash({ questionMessageId: 'question1', knowledgeTargets: targets, assessment, referenceRubric: rubric }), reasons: [] },
    cognitionTarget: { recordId: 'PRIVATE_RECORD', revisionId: 'PRIVATE_REVISION', branchId: 'PRIVATE_BRANCH',
      nodeId: 'PRIVATE_TARGET', purpose: 'give_example' } });
  const context: ArgumentReferenceDisclosureContext = { version: 1, protocol: 'review-frozen-reference-context-v1',
    contractHash: intent.referenceStructure!.contractHash!, rubricHash: await argumentContextHash(rubric),
    originQuestionMessageId: 'question1', taskType: 'definition', assessment, policy: 'all_target_frames', coverage: 'complete_required',
    frames: [{ frameId: 'target-1', knowledgeTarget: targets[0],
      source: { kind: 'knowledge-note', entityId: 'fixed-reference', version: at, contentHash: 'b'.repeat(64), coordinateSpace: 'note', structureHash: 'e'.repeat(64) },
      items: rubric.items.map((item, index) => ({ itemId: item.itemId, criterionId: item.criterionId, quoteId: `Q${index + 1}`,
        nodeIds: [`N${index + 1}`], relationIds: index ? ['R1'] : [] })),
      nodes: [{ id: 'N1', role: 'definition', quoteIds: ['Q1'] }, { id: 'N2', role: 'condition', quoteIds: ['Q2'] }],
      relations: [{ id: 'R1', sourceNodeId: 'N2', targetNodeId: 'N1', kind: 'requires_condition', quoteIds: ['Q2'] }], groups: [] }],
    quotes: rubric.items.map((item, index) => ({ quoteId: `Q${index + 1}`, sourceKey: 'e'.repeat(64), start: item.start, end: item.end, text: item.quote })),
    limitations: { semanticTruth: 'not_certified', writes: 'disabled' } };
  let reply: ArgumentReferenceDisclosureReply = { status: 'ready', context };
  const personal = await resolveReviewPersonalSnapshot(file, intent);
  const packet = await rehash({ version: 1, packetId: '', snapshotHash: '', activityId: 'activity1', messageId: 'answer1',
    questionText: '请说明这个概念的核心含义及适用边界。', questionIntent: intent,
    answer: { text: answer, hintLevel: 0, consultedMaterialIds: [] }, personal,
    references: [{ sourceId: 'local-new-reference', corpus: 'reference', kind: 'target-note', entityId: 'new-reference',
      title: 'NEW_REFERENCE_NOT_FROZEN', text: 'NEW_REFERENCE_BODY_NOT_FROZEN', textStart: 0, textEnd: 29,
      contentLength: 29, contentHash: 'f'.repeat(64), truncated: false, version: { updatedAt: at } }],
    coverage: { referencePresence: 'available', semanticCoverage: 'not_assessed', missingTargetNames: [] },
    preparation: { cognitionGrowth: 'pending_alignment', mastery: 'pending_alignment', masteryReasons: [], growthReasons: [], warnings: [] } });
  let referenceReads = 0, personalReads = 0;
  const readIntents: ReviewQuestionIntent[] = [], extracted: unknown[] = [], reviewed: FrozenReferenceShadowInput[] = [];
  const deps: ReviewProgressiveShadowDependencies = {
    readReference: async value => { referenceReads++; readIntents.push(structuredClone(value)); return structuredClone(reply); },
    loadCognition: async () => { personalReads++; return structuredClone(file); },
  };
  const model: FrozenReferenceShadowModel = {
    extract: async input => { extracted.push(structuredClone(input)); return { version: 1, packetId: input.packetId,
      claims: answerParts.map((quote, index) => ({ id: `A${index + 1}`, role: index ? 'conclusion' : 'premise', quote })),
      edges: [{ id: 'E1', source: 'A1', target: 'A2', relation: 'support', quote: answer }], requirements: [] }; },
    review: async input => { reviewed.push(structuredClone(input)); return accepted(input); },
  };
  return { packet, deps, model, extracted, reviewed, readIntents, file: () => file,
    setFile: (value: CognitionFile) => { file = structuredClone(value); }, setReply: (value: ArgumentReferenceDisclosureReply) => { reply = structuredClone(value); },
    reply: () => structuredClone(reply), counts: () => ({ reference: referenceReads, personal: personalReads }) };
}
try {
  const f = await rig(), before = JSON.stringify({ packet: f.packet, file: f.file() });
  const built = await evaluateReviewProgressiveShadow(f.packet, f.deps, f.model);
  assert.equal(built.referenceShadow.status, 'reviewed', JSON.stringify(built)); assert.equal(built.personalDisclosure.status, 'ready', JSON.stringify(built));
  assert.deepEqual(built.referenceShadow.modelRequests, { extract: 1, reference: 1, total: 2, limit: 2 });
  assert.deepEqual(built.modelRequests, { sharedExtract: 1, reference: 1, total: 2, limit: 2 });
  assert.deepEqual(f.counts(), { reference: 3, personal: 2 }); assert.equal(built.personalModelRequests, 0);
  assert.equal(JSON.stringify({ packet: f.packet, file: f.file() }), before);
  assert.equal(built.writes, 'disabled'); assert.equal(built.scoreWrite, 'disabled'); assert.equal(built.cognitionWrite, 'disabled');
  assert.equal(built.growthProposals, 'not_generated'); assert.ok(!('score' in built)); assert.ok(!('proposals' in built));
  pass('显式入口一次抽取一次参考审核、个人零模型准备，无写入或正式分数/生长提案');

  const referenceWire = JSON.stringify({ extracted: f.extracted, reviewed: f.reviewed, readIntents: f.readIntents });
  for (const forbidden of ['PRIVATE_', 'cognitionTarget', 'personal', 'NEW_REFERENCE', 'profile']) assert.ok(!referenceWire.includes(forbidden), forbidden);
  assert.ok(!JSON.stringify(f.extracted).includes('REFERENCE_MEANING'));
  if (built.personalDisclosure.status !== 'ready') throw new Error('Expected ready');
  const personalWire = JSON.stringify(built.personalDisclosure.input);
  for (const forbidden of ['REFERENCE_MEANING', 'REFERENCE_BOUNDARY', 'NEW_REFERENCE', 'referenceStructure', 'referenceRubric', 'knowledgeTargets'])
    assert.ok(!personalWire.includes(forbidden), forbidden);
  pass('参考 reader/抽取/审核均不接个人坐标，个人输入不接参考及答后新资料');

  assert.equal(f.extracted.length, 1); assert.equal(f.reviewed.length, 1);
  assert.notEqual(f.reviewed[0].evaluationId, f.packet.packetId); assert.equal(built.normalizedGraph!.packetId, f.packet.packetId);
  assert.deepEqual(built.normalizedGraph!.claims.map(({ quote: _quote, ...claim }) => claim), f.reviewed[0].graph.claims);
  assert.deepEqual(built.normalizedGraph!.edges.map(({ quote: _quote, ...edge }) => edge), f.reviewed[0].graph.edges);
  assert.equal(built.normalizedGraph!.requirements[0].quote, f.packet.questionText);
  assert.deepEqual(built.normalizedGraph!.requirements[0].criterionIds, ['concept_meaning', 'concept_boundary']);
  assert.equal(built.personalDisclosure.input.graph.claims.length, 2); assert.equal(built.personalDisclosure.input.graph.edges.length, 1);
  assert.equal(built.personalDisclosure.input.safeguards.purposeCreatesRelation, false);
  assert.equal(built.personalDisclosure.input.personal.edges[1].relation, 'oppose');
  assert.equal(built.personalDisclosure.input.safeguards.storedRelationTruth, 'not_certified');
  pass('graph仅换packetId后复核原答/原题/固定任务，共用原边但不将目的/参考通过当个人真实关系');

  // Exercise the actual dormant factory through the progressive entry, not a
  // canonical-v1 mock that would miss the model's explicit typed-v4 routing marker.
  const typed = await rig(), typedRequests: unknown[] = [];
  const typedModel = createFrozenReferenceShadowModel(async request => {
    assert.equal(request.workflow, 'review-scoring');
    assert.equal(request.skipMemoryInjection, true); assert.equal(request.skipProfileInjection, true);
    assert.equal(request.thinkingMode, 'disabled');
    const value = JSON.parse(request.userInput);
    typedRequests.push(structuredClone(value));
    if (typedRequests.length === 1) return {
      content: JSON.stringify(await typed.model.extract(value)), provider: 'mock', model: 'mock',
    };
    const input = value as FrozenReferenceTypedInputV4;
    assert.equal(input.version, 4); assert.equal(input.protocol, 'review-frozen-reference-typed-v4');
    return { content: JSON.stringify({ version: 4, evaluationId: input.evaluationId, contractHash: input.contractHash,
      items: input.frames.flatMap(frame => frame.items.map(item => ({
        itemId: item.itemId, verdict: 'supported', scope: 'same',
        matches: item.requiredNodeIds.map(nodeId => {
          const node = frame.nodes.find(node => node.id === nodeId)!;
          return { claimId: `user/A${nodeId.split('/').at(-1)!.slice(1)}`, nodeId,
            referenceQuoteId: node.evidence[0].quoteId, referenceQuote: node.evidence[0].text };
        }),
      }))) }), provider: 'mock', model: 'mock' };
  });
  assert.equal(typedModel.protocol, 'typed-v4'); assert.equal(typedRequests.length, 0);
  const typedPending = evaluateReviewProgressiveShadow(typed.packet, typed.deps, typedModel);
  // The entry's first await is packet hashing. A caller's immediate mutation
  // must not downgrade routing or replace either captured factory method.
  delete typedModel.protocol;
  typedModel.extract = async () => assert.fail('Late replacement typed extractor must not run');
  typedModel.review = async () => assert.fail('Late replacement typed reviewer must not run');
  const typedBuilt = await typedPending;
  assert.equal(typedBuilt.referenceShadow.status, 'reviewed', JSON.stringify(typedBuilt));
  assert.equal(typedBuilt.referenceShadow.frames[0].status, 'covered');
  assert.equal(typedBuilt.personalDisclosure.status, 'ready'); assert.equal(typedRequests.length, 2);
  assert.deepEqual(typedBuilt.modelRequests, { sharedExtract: 1, reference: 1, total: 2, limit: 2 });
  assert.equal(typedBuilt.personalModelRequests, 0); assert.equal(typedBuilt.writes, 'disabled');
  for (const forbidden of ['PRIVATE_', 'NEW_REFERENCE', 'cognitionTarget', 'profile'])
    assert.ok(!JSON.stringify(typedRequests).includes(forbidden), forbidden);
  pass('真实typed-v4工厂经progressive入口允许省空反证但保持协议，首次await前捕获且晚删protocol/改方法不降级');

  const tampered = await rig(); tampered.packet.answer.text = '篡改而未重签';
  const tamperedOut = await evaluateReviewProgressiveShadow(tampered.packet, tampered.deps, tampered.model);
  assert.deepEqual(tamperedOut.referenceShadow.reasons, ['packet_changed']);
  assert.deepEqual(tamperedOut.personalDisclosure, { status: 'held', reasonCode: 'packet_changed' });
  assert.deepEqual(tampered.counts(), { reference: 0, personal: 0 }); assert.equal(tampered.extracted.length, 0);
  pass('原packet哈希不匹配，任何权威读取或模型调用之前双侧held');

  const raced = await rig(), options = { personalBudget: { nodes: 3 } };
  const pending = evaluateReviewProgressiveShadow(raced.packet, raced.deps, raced.model, options);
  raced.packet.answer.text = 'CALLER_CHANGED_ANSWER'; raced.packet.questionText = 'CALLER_CHANGED_QUESTION';
  raced.packet.personal.graph!.nodes[0].text = 'CALLER_CHANGED_OLD_NODE';
  options.personalBudget.nodes = 1;
  raced.deps.readReference = async () => assert.fail('Late changed reference function must not run');
  raced.deps.loadCognition = async () => assert.fail('Late changed cognition function must not run');
  raced.model.extract = async () => assert.fail('Late changed model function must not run');
  raced.model.review = async () => assert.fail('Late changed model function must not run');
  raced.model.protocol = 'typed-v3';
  const captured = await pending;
  assert.equal(captured.referenceShadow.status, 'reviewed'); assert.equal(captured.personalDisclosure.status, 'ready');
  assert.ok(!JSON.stringify(captured).includes('CALLER_CHANGED'));
  pass('首次await前克隆packet/预算并捕获方法及legacy协议，晚添加typed标记不升级或污染任一通道');

  const failReview = await rig(); failReview.model.review = async () => { throw new Error('model review failure'); };
  const failed = await evaluateReviewProgressiveShadow(failReview.packet, failReview.deps, failReview.model);
  assert.equal(failed.referenceShadow.status, 'held'); assert.equal(failed.personalDisclosure.status, 'ready');
  assert.equal(failed.referenceShadow.observations.length, 0); assert.equal(failed.personalModelRequests, 0);
  if (failed.personalDisclosure.status !== 'ready') throw new Error('Expected independent preparation');
  assert.deepEqual(failed.personalDisclosure.input, built.personalDisclosure.input);
  pass('参考审核失败但已有原答graph，个人仅独立只读准备，不能借失败升级推断');

  const invalidReview = await rig(); invalidReview.model.review = async input => ({ ...accepted(input), score: 100 });
  const invalid = await evaluateReviewProgressiveShadow(invalidReview.packet, invalidReview.deps, invalidReview.model);
  assert.deepEqual(invalid.referenceShadow.reasons, ['invalid_shadow_output']); assert.equal(invalid.personalDisclosure.status, 'ready');
  pass('参考模型自评分/无效封闭输出仅hold参考，不借局部结果作正式掌握度');

  for (const changedAt of [2, 3]) {
    const staleRef = await rig(); let reads = 0;
    const output = await evaluateReviewProgressiveShadow(staleRef.packet, { ...staleRef.deps,
      readReference: async () => ++reads >= changedAt ? { status: 'held', reasons: ['source_changed'] } : staleRef.reply() }, staleRef.model);
    assert.equal(output.referenceShadow.status, 'held'); assert.equal(output.personalDisclosure.status, 'ready');
    assert.ok(output.normalizedGraph); assert.equal(output.referenceShadow.modelRequests.extract, 1);
    assert.equal(output.referenceShadow.modelRequests.reference, changedAt === 2 ? 0 : 1);
  }
  pass('抽取后/参考审核后参考陈旧不新检索补救，个人冻结坐标准备不借参考权限');

  const stalePersonal = await rig(); const newFile = structuredClone(stalePersonal.file());
  newFile.records[0].revisions.push({ ...structuredClone(newFile.records[0].revisions[0]), id: 'revision2', number: 2 });
  stalePersonal.setFile(newFile);
  const stale = await evaluateReviewProgressiveShadow(stalePersonal.packet, stalePersonal.deps, stalePersonal.model);
  assert.equal(stale.referenceShadow.status, 'reviewed'); assert.deepEqual(stale.personalDisclosure, { status: 'held', reasonCode: 'stale_target' });
  assert.deepEqual(stalePersonal.extracted, f.extracted); assert.deepEqual(stalePersonal.reviewed, f.reviewed);
  pass('个人版本变化只hold个人，相同原答/参考下reference实际请求完全相同');

  const changedPersonal = await rig(), changedFile = structuredClone(changedPersonal.file());
  changedFile.records[0].revisions[0].branches[0].graph.nodes[0].text = '当前真实旧节点已改变'; changedPersonal.setFile(changedFile);
  const changed = await evaluateReviewProgressiveShadow(changedPersonal.packet, changedPersonal.deps, changedPersonal.model);
  assert.equal(changed.referenceShadow.status, 'reviewed');
  assert.deepEqual(changed.personalDisclosure, { status: 'held', reasonCode: 'personal_snapshot_changed' });
  pass('同revisionID节点实际变化仍hold个人，不用reference通过授权旧个人数据');

  const unreadable = await rig(); unreadable.deps.loadCognition = async () => { throw new Error('private IO error'); };
  const unread = await evaluateReviewProgressiveShadow(unreadable.packet, unreadable.deps, unreadable.model);
  assert.equal(unread.referenceShadow.status, 'reviewed'); assert.deepEqual(unread.personalDisclosure, { status: 'held', reasonCode: 'personal_unavailable' });
  assert.ok(!JSON.stringify(unread).includes('private IO error'));
  pass('个人不可读不拖垮参考，也不把读失败当空库或泄露底层错误');

  const unavailable = await rig(); unavailable.setReply({ status: 'held', reasons: ['scope_denied'] });
  const noGraph = await evaluateReviewProgressiveShadow(unavailable.packet, unavailable.deps, unavailable.model);
  assert.deepEqual(noGraph.referenceShadow.reasons, ['frozen_reference_unavailable']);
  assert.equal(noGraph.personalDisclosure.status, 'ready'); assert.ok(noGraph.normalizedGraph);
  assert.equal(unavailable.counts().personal, 3); assert.equal(unavailable.extracted.length, 1); assert.equal(unavailable.reviewed.length, 0);
  assert.deepEqual(noGraph.referenceShadow.modelRequests, { extract: 0, reference: 0, total: 0, limit: 2 });
  assert.deepEqual(noGraph.modelRequests, { sharedExtract: 1, reference: 0, total: 1, limit: 2 });
  assert.ok(!JSON.stringify(unavailable.extracted).includes('PRIVATE_')); assert.ok(!JSON.stringify(unavailable.extracted).includes('reference'));
  pass('参考在抽取前held不成为个人前置门槛：当前个人权威先核，一次独立共享抽取、准确计费，不升级参考');

  const alternate = await rig(); alternate.packet.questionIntent.referenceStructure!.contractHash = 'f'.repeat(64);
  alternate.packet = await rehash(alternate.packet);
  const alternateOut = await evaluateReviewProgressiveShadow(alternate.packet, alternate.deps, alternate.model);
  assert.equal(alternateOut.referenceShadow.status, 'held'); assert.equal(alternateOut.personalDisclosure.status, 'ready');
  assert.deepEqual(alternate.extracted, unavailable.extracted);
  pass('个人独立抽取binding只由原题/答/目标/任务组成，参考receipt变化不污染payload/指纹');

  const noTask = await rig(); noTask.packet.questionIntent.assessment = freezeReviewAssessment('无', noTask.packet.questionIntent.knowledgeTargets);
  delete noTask.packet.questionIntent.referenceRubric; delete noTask.packet.questionIntent.referenceStructure; noTask.packet = await rehash(noTask.packet);
  const noTaskOut = await evaluateReviewProgressiveShadow(noTask.packet, noTask.deps, noTask.model);
  assert.deepEqual(noTaskOut.referenceShadow.reasons, ['frozen_task_unavailable']); assert.equal(noTaskOut.personalDisclosure.status, 'ready');
  assert.equal(noTask.counts().reference, 0);
  assert.deepEqual(noTaskOut.modelRequests, { sharedExtract: 1, reference: 0, total: 1, limit: 2 });
  assert.deepEqual(noTaskOut.normalizedGraph!.requirements, []);
  pass('无本题参考检验任务仍可个人只读准备，不假造掌握度任务或答后评分基线');

  const malformedPersonal = await rig();
  (malformedPersonal.packet.questionIntent.cognitionTarget! as unknown as { purpose: string }).purpose = 'INVALID_PERSONAL_PURPOSE';
  malformedPersonal.packet = await rehash(malformedPersonal.packet);
  const malformedOut = await evaluateReviewProgressiveShadow(malformedPersonal.packet, malformedPersonal.deps, malformedPersonal.model);
  assert.equal(malformedOut.referenceShadow.status, 'reviewed'); assert.equal(malformedOut.personalDisclosure.status, 'held');
  assert.deepEqual(malformedPersonal.extracted, f.extracted); assert.deepEqual(malformedPersonal.reviewed, f.reviewed);
  pass('个人坐标元数据无效也不进入参考解析/请求，不能阻断合法参考通道');

  const staleFallback = await rig(); staleFallback.setReply({ status: 'held', reasons: ['scope_denied'] });
  const fallbackFile = structuredClone(staleFallback.file());
  fallbackFile.records[0].revisions.push({ ...structuredClone(fallbackFile.records[0].revisions[0]), id: 'later-revision', number: 2 });
  staleFallback.setFile(fallbackFile);
  const staleOnly = await evaluateReviewProgressiveShadow(staleFallback.packet, staleFallback.deps, staleFallback.model);
  assert.deepEqual(staleOnly.personalDisclosure, { status: 'held', reasonCode: 'stale_target' });
  assert.deepEqual(staleOnly.modelRequests, { sharedExtract: 0, reference: 0, total: 0, limit: 2 });
  assert.equal(staleFallback.extracted.length, 0); assert.equal(staleFallback.counts().personal, 1);
  const changedFallback = await rig(); changedFallback.setReply({ status: 'held', reasons: ['scope_denied'] });
  const editedFallbackFile = structuredClone(changedFallback.file()); editedFallbackFile.records[0].revisions[0].branches[0].graph.nodes[0].text = 'changed node';
  changedFallback.setFile(editedFallbackFile);
  const editedOnly = await evaluateReviewProgressiveShadow(changedFallback.packet, changedFallback.deps, changedFallback.model);
  assert.deepEqual(editedOnly.personalDisclosure, { status: 'held', reasonCode: 'personal_snapshot_changed' }); assert.equal(editedOnly.modelRequests.total, 0);
  pass('个人独立路线在stale版本/同ID原文变化时先host拦截，零模型调用');

  for (const mode of ['not_requested', 'growth_held'] as const) {
    const blocked = await rig(); blocked.setReply({ status: 'held', reasons: ['scope_denied'] });
    if (mode === 'not_requested') { delete blocked.packet.questionIntent.cognitionTarget; blocked.packet.personal = { status: 'not_requested', truncated: false }; }
    else blocked.packet.preparation.cognitionGrowth = 'held';
    blocked.packet = await rehash(blocked.packet);
    const output = await evaluateReviewProgressiveShadow(blocked.packet, blocked.deps, blocked.model);
    assert.equal(output.personalDisclosure.status, 'held'); assert.equal(output.modelRequests.total, 0);
    assert.equal(blocked.extracted.length, 0); assert.equal(blocked.counts().personal, 0);
  }
  pass('没有个人冻结坐标/原growth held时不借无参考启动额外模型');

  const badExtract = await rig(); badExtract.model.extract = async input => ({ version: 1, packetId: input.packetId,
    claims: [{ id: 'A1', role: 'fact', quote: 'NOT_A_USER_QUOTE' }], edges: [], requirements: [] });
  const bad = await evaluateReviewProgressiveShadow(badExtract.packet, badExtract.deps, badExtract.model);
  assert.equal(bad.referenceShadow.status, 'held'); assert.deepEqual(bad.personalDisclosure, { status: 'held', reasonCode: 'extraction_unavailable' });
  assert.equal(bad.normalizedGraph, undefined); assert.equal(badExtract.counts().personal, 0);
  assert.deepEqual(bad.modelRequests, { sharedExtract: 1, reference: 0, total: 1, limit: 2 });
  const requirements = await rig(); const extractor = requirements.model.extract;
  requirements.model.extract = async (...args) => ({ ...await extractor(...args) as object, requirements: [{ knowledgeTarget: 'invented' }] });
  const invented = await evaluateReviewProgressiveShadow(requirements.packet, requirements.deps, requirements.model);
  assert.deepEqual(invented.personalDisclosure, { status: 'held', reasonCode: 'extraction_unavailable' });
  pass('抽取幻造用户引文/评分任务不能流入个人，只用原题冻结要求且无修复重试');

  const fallbackBad = await rig(); fallbackBad.setReply({ status: 'held', reasons: ['scope_denied'] }); let fallbackAttempts = 0;
  fallbackBad.model.extract = async input => { fallbackAttempts++; return { version: 1, packetId: input.packetId,
    claims: [{ id: 'A1', role: 'fact', quote: 'NOT_FROM_ANSWER' }], edges: [], requirements: [] }; };
  const fallbackInvalid = await evaluateReviewProgressiveShadow(fallbackBad.packet, fallbackBad.deps, fallbackBad.model);
  assert.deepEqual(fallbackInvalid.personalDisclosure, { status: 'held', reasonCode: 'extraction_unavailable' });
  assert.equal(fallbackAttempts, 1); assert.equal(fallbackInvalid.modelRequests.total, 1); assert.equal(fallbackBad.reviewed.length, 0);
  pass('独立个人抽取同样严格原话锚定；失败不重试、不参考审核/补写关系');

  const empty = await rig(); empty.model.extract = async input => ({ version: 1, packetId: input.packetId, claims: [], edges: [], requirements: [] });
  const emptyOut = await evaluateReviewProgressiveShadow(empty.packet, empty.deps, empty.model);
  assert.deepEqual(emptyOut.referenceShadow.reasons, ['no_user_claims']);
  assert.deepEqual(emptyOut.personalDisclosure, { status: 'held', reasonCode: 'invalid_performance_graph' });
  assert.equal(emptyOut.referenceShadow.modelRequests.total, 1); assert.equal(empty.counts().personal, 0);
  pass('空回答graph保留审计但不能准备个人/补参考主张，不调用第二模型');

  const budget = await rig(); const small = await evaluateReviewProgressiveShadow(budget.packet, budget.deps, budget.model, { personalBudget: { nodes: 2 } });
  assert.equal(small.referenceShadow.status, 'reviewed'); assert.deepEqual(small.personalDisclosure, { status: 'held', reasonCode: 'disclosure_budget_exceeded' });
  const growth = await rig(); growth.packet.preparation.cognitionGrowth = 'held'; growth.packet = await rehash(growth.packet);
  const heldGrowth = await evaluateReviewProgressiveShadow(growth.packet, growth.deps, growth.model);
  assert.equal(heldGrowth.referenceShadow.status, 'reviewed'); assert.deepEqual(heldGrowth.personalDisclosure, { status: 'held', reasonCode: 'personal_growth_held' });
  pass('个人缺完整预算/已有growth held不因参考通过解锁，参考也不受个人预算影响');

  const slowPersonal = await rig(); slowPersonal.deps.loadCognition = async () => new Promise(() => {});
  const timedPersonal = await evaluateReviewProgressiveShadow(slowPersonal.packet, slowPersonal.deps, slowPersonal.model, { readTimeoutMs: 15 });
  assert.equal(timedPersonal.referenceShadow.status, 'reviewed');
  assert.deepEqual(timedPersonal.personalDisclosure, { status: 'held', reasonCode: 'personal_unavailable' });
  const slowFallbackPersonal = await rig(); slowFallbackPersonal.setReply({ status: 'held', reasons: ['scope_denied'] });
  slowFallbackPersonal.deps.loadCognition = async () => new Promise(() => {});
  const timedPrecheck = await evaluateReviewProgressiveShadow(slowFallbackPersonal.packet, slowFallbackPersonal.deps, slowFallbackPersonal.model, { readTimeoutMs: 15 });
  assert.deepEqual(timedPrecheck.personalDisclosure, { status: 'held', reasonCode: 'personal_unavailable' }); assert.equal(timedPrecheck.modelRequests.total, 0);
  pass('个人host读取与独立抽取前核查都有界，挂起只hold个人不拖垮参考/泄露IO细节');

  const slowReference = await rig(); slowReference.deps.readReference = async () => new Promise(() => {});
  const timedReference = await evaluateReviewProgressiveShadow(slowReference.packet, slowReference.deps, slowReference.model, { readTimeoutMs: 15 });
  assert.deepEqual(timedReference.referenceShadow.reasons, ['shadow_timeout']); assert.equal(timedReference.personalDisclosure.status, 'ready');
  assert.deepEqual(timedReference.modelRequests, { sharedExtract: 1, reference: 0, total: 1, limit: 2 });
  const slowExtract = await rig(); slowExtract.setReply({ status: 'held', reasons: ['scope_denied'] });
  let timedAttempts = 0; slowExtract.model.extract = async () => { timedAttempts++; return new Promise(() => {}); };
  const timedExtraction = await evaluateReviewProgressiveShadow(slowExtract.packet, slowExtract.deps, slowExtract.model, { timeoutMs: 15 });
  assert.deepEqual(timedExtraction.personalDisclosure, { status: 'held', reasonCode: 'shadow_timeout' }); assert.equal(timedAttempts, 1);
  assert.deepEqual(timedExtraction.modelRequests, { sharedExtract: 1, reference: 0, total: 1, limit: 2 });
  pass('转发reference read deadline，个人独立抽取deadline计一次不重试、无隐含超额');

  const cancelDuringPersonal = await rig(), personalController = new AbortController();
  cancelDuringPersonal.deps.loadCognition = async () => { personalController.abort(); return structuredClone(cancelDuringPersonal.file()); };
  const stoppedPersonal = await evaluateReviewProgressiveShadow(cancelDuringPersonal.packet, cancelDuringPersonal.deps, cancelDuringPersonal.model,
    { signal: personalController.signal });
  assert.equal(stoppedPersonal.referenceShadow.status, 'reviewed');
  assert.deepEqual(stoppedPersonal.personalDisclosure, { status: 'held', reasonCode: 'shadow_aborted' });
  pass('个人装配期间取消再次回核，只保留已完成参考shadow不返回个人ready');

  const noDefault = await rig();
  const absentModel = await evaluateReviewProgressiveShadow(noDefault.packet, noDefault.deps, undefined as unknown as FrozenReferenceShadowModel);
  assert.deepEqual(absentModel.referenceShadow.reasons, ['explicit_model_required']);
  assert.deepEqual(absentModel.personalDisclosure, { status: 'held', reasonCode: 'explicit_model_required' });
  assert.deepEqual(noDefault.counts(), { reference: 0, personal: 0 });
  const cancel = await rig(), controller = new AbortController(); controller.abort();
  const cancelled = await evaluateReviewProgressiveShadow(cancel.packet, cancel.deps, cancel.model, { signal: controller.signal });
  assert.deepEqual(cancelled.referenceShadow.reasons, ['shadow_aborted']); assert.equal(cancelled.referenceShadow.modelRequests.total, 0);
  assert.deepEqual(cancel.counts(), { reference: 0, personal: 0 });
  pass('没有显式模型无默认provider，已取消零读取/模型，无自动UI或云启动');

  console.log(`Progressive shadow checks passed: ${checks} synthetic mock groups; one extraction max, zero personal model calls or writes.`);
} finally { globalThis.fetch = oldFetch; }
