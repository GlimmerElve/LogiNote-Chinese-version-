import assert from 'node:assert/strict';
import type { LlmCallRequest, LlmCallResponse } from '../src/types.ts';
import { REVIEW_PROGRESSIVE_DATASET, type ReviewProgressiveCase } from './review-progressive-dataset.ts';
import { prepareReviewProgressiveFixture } from './review-progressive-fixture.ts';
import { buildReviewProgressiveExtractionInput, buildReviewProgressiveReferenceInput, validateReviewProgressiveRequest } from './review-progressive-transport.ts';
import { createFrozenReferenceShadowModel } from '../src/services/reviewComparison/frozenReferenceModel.ts';
import { evaluateFrozenReviewReferenceShadow } from '../src/services/reviewComparison/frozenReferenceShadow.ts';
import type { FrozenReferenceShadowInput } from '../src/services/reviewComparison/frozenReferenceShadow.ts';
import type { FrozenReferenceTypedInputV4 } from '../src/services/reviewComparison/frozenReferenceTyped.ts';
import type { ReviewProgressiveFixture } from './review-progressive-fixture.ts';
import { REVIEW_ASSESSMENT_CRITERIA, type ReviewCriterionId } from '../src/services/reviewAssessment.ts';

// OFFLINE CLOSED-WIRE checks only. Fixed responses are protocol probes, not a
// semantic accuracy result, a new cloud round or human-reviewed gold. Nothing
// reads provider settings, the real vault/profile/cognition, or writes artifacts.
const oldFetch = globalThis.fetch;
const browserNames = ['window', 'localStorage'] as const;
const browserDescriptors = browserNames.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
let networkCalls = 0, mockCalls = 0, checks = 0;
globalThis.fetch = async () => { networkCalls++; return assert.fail('progressive_transport_network_forbidden'); };
for (const name of browserNames) Object.defineProperty(globalThis, name, { configurable: true,
  get: () => assert.fail('progressive_transport_browser_state_forbidden') });
const pass = (label: string) => { checks++; console.log(`PASS ${label}`); };
const draftResponse = (packetId: string, quote: string): LlmCallResponse => ({ content: JSON.stringify({ version: 1, packetId,
  claims: [{ id: 'A1', role: 'fact', quote }], edges: [], requirements: [] }), diagnostics: { finishReason: 'stop' } });
const changeInput = (request: LlmCallRequest, change: (input: any) => void): LlmCallRequest => {
  const copy = structuredClone(request), input = JSON.parse(copy.userInput); change(input); copy.userInput = JSON.stringify(input); return copy;
};
const probeResponse = (input: FrozenReferenceTypedInputV4): LlmCallResponse => ({ content: JSON.stringify({ version: 4,
  evaluationId: input.evaluationId, contractHash: input.contractHash,
  items: input.frames.flatMap(frame => frame.items.map(item => ({ itemId: item.itemId, verdict: 'unverifiable',
    scope: 'unknown', matches: [],
    ...(item.evidenceMode === 'inference' ? { edgeIds: [], direction: 'undetermined', premises: 'missing' } : {}) }))) }), diagnostics: { finishReason: 'stop' } });

// Independently inspect every emitted word and reference path. Do not compare
// only against another invocation of the same readability projection helper.
function checkTypedWire(input: FrozenReferenceTypedInputV4, canonical: FrozenReferenceShadowInput, fixture: ReviewProgressiveFixture) {
  assert.deepEqual(Object.keys(input).sort(), ['version', 'protocol', 'evaluationId', 'contractHash', 'taskContext', 'user', 'frames'].sort());
  assert.equal(input.version, 4); assert.equal(input.protocol, 'review-frozen-reference-typed-v4');
  assert.equal(input.evaluationId, fixture.evaluationId); assert.equal(input.contractHash, fixture.context.contractHash);
  assert.deepEqual(input.taskContext, { questionText: fixture.packet.questionText,
    usage: 'question_context_only', taskType: fixture.context.taskType });
  assert.deepEqual(Object.keys(input.user).sort(), ['answerText', 'claims', 'edges'].sort());
  assert.equal(input.user.answerText, fixture.packet.answer.text);
  assert.deepEqual(input.user.claims, canonical.graph.claims.map(claim => ({ id: `user/${claim.id}`, role: claim.role,
    text: fixture.packet.answer.text.slice(claim.start, claim.end) })));
  const needsInference = canonical.reference.frames.some(frame => frame.items.some(item => item.criterionId === 'inference_link'));
  assert.deepEqual(input.user.edges, (needsInference ? canonical.graph.edges : []).map(edge => ({ id: `user/${edge.id}`, source: `user/${edge.source}`,
    target: `user/${edge.target}`, relation: edge.relation, text: fixture.packet.answer.text.slice(edge.start, edge.end) })));
  assert.equal(input.frames.length, fixture.context.frames.length);
  const quotes = new Map(fixture.context.quotes.map(quote => [quote.quoteId, quote]));
  for (const [index, frame] of input.frames.entries()) {
    const frozen = fixture.context.frames[index], prefix = `reference/${frozen.frameId}`;
    assert.equal(frame.frameId, prefix); assert.equal(frame.knowledgeTarget, frozen.knowledgeTarget);
    assert.deepEqual(frame.source, frozen.source);
    assert.deepEqual(frame.items, frozen.items.map(item => ({ itemId: `${prefix}/item/${item.itemId}`,
      criterionId: item.criterionId, criterionDescription: REVIEW_ASSESSMENT_CRITERIA[item.criterionId as ReviewCriterionId],
      referenceText: quotes.get(item.quoteId)!.text,
      requiredNodeIds: item.nodeIds.map(id => `${prefix}/node/${id}`), requiredRelationIds: item.relationIds.map(id => `${prefix}/relation/${id}`),
      evidenceMode: item.criterionId === 'inference_link' ? 'inference' : 'statement',
      scopeRule: 'same_object_property_conditions_time_certainty',
      supportRule: 'complete_required_nodes_and_relation_meanings' })));
    assert.equal(frame.nodes.length, frozen.nodes.length);
    for (const [nodeIndex, node] of frame.nodes.entries()) {
      const original = frozen.nodes[nodeIndex];
      assert.equal(node.id, `${prefix}/node/${original.id}`); assert.equal(node.role, original.role);
      assert.deepEqual(node.evidence, original.quoteIds.map(id => ({ quoteId: id, text: quotes.get(id)!.text })));
      assert.deepEqual(Object.keys(node).sort(), ['id', 'role', 'evidence'].sort());
    }
    assert.equal(frame.relations.length, frozen.relations.length);
    for (const [edgeIndex, edge] of frame.relations.entries()) {
      const original = frozen.relations[edgeIndex];
      assert.equal(edge.id, `${prefix}/relation/${original.id}`); assert.equal(edge.source, `${prefix}/node/${original.sourceNodeId}`);
      assert.equal(edge.target, `${prefix}/node/${original.targetNodeId}`); assert.equal(edge.kind, original.kind);
      assert.deepEqual(edge.evidence, original.quoteIds.map(id => ({ quoteId: id, text: quotes.get(id)!.text })));
      assert.deepEqual(Object.keys(edge).sort(), ['id', 'source', 'target', 'kind', 'evidence'].sort());
    }
    assert.deepEqual(frame.groups, frozen.groups.map(group => ({ id: `${prefix}/group/${group.id}`,
      conclusionNodeId: `${prefix}/node/${group.conclusionNodeId}`, premiseNodeIds: group.premiseNodeIds.map(id => `${prefix}/node/${id}`),
      conditionNodeIds: group.conditionNodeIds.map(id => `${prefix}/node/${id}`), relationIds: group.relationIds.map(id => `${prefix}/relation/${id}`),
      operator: group.operator })));
    assert.deepEqual(Object.keys(frame).sort(), ['frameId', 'knowledgeTarget', 'source', 'items', 'nodes', 'relations', 'groups'].sort());
  }
}

try {
  assert.equal(REVIEW_PROGRESSIVE_DATASET.length, 12);
  const c = REVIEW_PROGRESSIVE_DATASET[0], fixture = await prepareReviewProgressiveFixture(c);
  const again = await prepareReviewProgressiveFixture(c);
  assert.equal(again.evaluationId, fixture.evaluationId);
  assert.equal(again.contextHash, fixture.contextHash);
  assert.equal(again.sourceFingerprint, fixture.sourceFingerprint);
  assert.deepEqual(again.answer, fixture.answer); assert.deepEqual(again.context, fixture.context); assert.deepEqual(again.packet, fixture.packet);
  pass('合成fixture可复现canonical evaluationId/context/source指纹及thin packet，不依赖浏览器');

  let firstRequests: LlmCallRequest[] = [], firstExtract: LlmCallResponse | undefined;
  for (const sample of REVIEW_PROGRESSIVE_DATASET) {
    const f = await prepareReviewProgressiveFixture(sample), requests: LlmCallRequest[] = [];
    let stage = 0, extracted: LlmCallResponse | undefined;
    const model = createFrozenReferenceShadowModel(async request => {
      stage++; mockCalls++; requests.push(structuredClone(request));
      const verified = await validateReviewProgressiveRequest(request, stage as 1 | 2, f, extracted);
      assert.equal(verified.stats.inputChars, request.userInput.length);
      assert.equal(verified.stats.inputBytes, new TextEncoder().encode(request.userInput).length);
      assert.equal(verified.stats.systemChars, request.systemPromptOverride!.length);
      assert.equal(verified.stats.totalChars, request.userInput.length + request.systemPromptOverride!.length);
      assert.equal(verified.stats.totalBytes, verified.stats.inputBytes + verified.stats.systemBytes);
      if (stage === 1) {
        assert.deepEqual(Object.keys(verified.input).sort(), ['packetId', 'questionText', 'answer', 'knowledgeTargets', 'assessment'].sort());
        assert.equal(verified.stats.frames, 0); assert.equal(verified.stats.quotes, 0);
        extracted = draftResponse(f.evaluationId, sample.answer); return extracted;
      }
      const input = verified.input as FrozenReferenceTypedInputV4;
      const canonical = buildReviewProgressiveReferenceInput(f, extracted!);
      checkTypedWire(input, canonical, f);
      assert.equal(canonical.graph.claims[0].start, 0); assert.equal(canonical.graph.claims[0].end, sample.answer.length);
      assert.equal(Object.hasOwn(input.user.claims[0], 'start'), false);
      assert.equal(Object.hasOwn(input.user.claims[0], 'end'), false);
      assert.equal(input.user.claims[0].text, sample.answer);
      assert.equal(verified.stats.frames, f.context.frames.length);
      assert.equal(verified.stats.items, f.context.frames.flatMap(frame => frame.items).length);
      assert.equal(verified.stats.quotes, f.context.quotes.length);
      assert.equal(verified.stats.statementItems, f.context.frames.flatMap(frame => frame.items).filter(item => item.criterionId !== 'inference_link').length);
      assert.equal(verified.stats.inferenceItems, f.context.frames.flatMap(frame => frame.items).filter(item => item.criterionId === 'inference_link').length);
      assert.equal(verified.stats.statementItems + verified.stats.inferenceItems, verified.stats.items);
      assert.equal(verified.stats.wireEdges, input.user.edges.length);
      // Legal v4 probe omits empty opposition and exercises the strict adapter.
      // certifies no semantic match, and does not count as model accuracy.
      return probeResponse(input);
    });
    await model.extract(buildReviewProgressiveExtractionInput(f));
    assert.ok(extracted);
    await model.review(buildReviewProgressiveReferenceInput(f, extracted));
    assert.equal(stage, 2);
    const ready = await f.dependencies.readReference(f.answer.evidence.questionIntent);
    assert.equal(ready.status, 'ready');
    if (sample.id === c.id) { firstRequests = requests; firstExtract = structuredClone(extracted); }
  }
  assert.equal(firstRequests.length, 2); assert.ok(firstExtract);
  pass('12个真实adapter两阶段24次mock：独立逐句检查v4原文/来源/namespace、statement/inference模式及canonical统计；零云，不宣称语义成绩');

  const reasoningCase = REVIEW_PROGRESSIVE_DATASET.find(sample => sample.id === 'R01')!;
  const reasoningFixture = await prepareReviewProgressiveFixture(reasoningCase);
  let reasoningExtract: LlmCallResponse | undefined, reasoningStage = 0, reasoningRequest: LlmCallRequest | undefined;
  const reasoningModel = createFrozenReferenceShadowModel(async request => {
    reasoningStage++; mockCalls++;
    const verified = await validateReviewProgressiveRequest(request, reasoningStage as 1 | 2, reasoningFixture, reasoningExtract);
    if (reasoningStage === 1) {
      reasoningExtract = { content: JSON.stringify({ version: 1, packetId: reasoningFixture.evaluationId,
        claims: [{ id: 'A1', role: 'premise', quote: '本次设备已经通电，读数也确实超过阈值' },
          { id: 'A2', role: 'conclusion', quote: '本次设备会报警' }],
        edges: [{ id: 'E1', source: 'A1', target: 'A2', relation: 'support', quote: reasoningCase.answer }], requirements: [] }),
        diagnostics: { finishReason: 'stop' } };
      return reasoningExtract;
    }
    const input = verified.input as FrozenReferenceTypedInputV4;
    checkTypedWire(input, buildReviewProgressiveReferenceInput(reasoningFixture, reasoningExtract!), reasoningFixture);
    assert.equal(verified.stats.claims, 2); assert.equal(verified.stats.edges, 1);
    assert.equal(verified.stats.wireEdges, 1); assert.equal(verified.stats.inferenceItems, 1); assert.equal(verified.stats.statementItems, 2);
    assert.deepEqual(input.user.edges, [{ id: 'user/E1', source: 'user/A1', target: 'user/A2', relation: 'support', text: reasoningCase.answer }]);
    reasoningRequest = structuredClone(request);
    return probeResponse(input);
  });
  await reasoningModel.extract(buildReviewProgressiveExtractionInput(reasoningFixture));
  await reasoningModel.review(buildReviewProgressiveReferenceInput(reasoningFixture, reasoningExtract!));
  for (const change of [
    (input: any) => { input.user.edges[0].source = 'reference/target-1/node/N1'; },
    (input: any) => { input.user.edges[0].target = 'user/A1'; },
    (input: any) => { input.user.edges[0].text = '模型重新概述的推理'; },
    (input: any) => { input.frames[0].relations[0].source = 'user/A1'; },
    (input: any) => { input.frames[0].groups[0].operator = 'any'; },
  ]) await assert.rejects(() => validateReviewProgressiveRequest(changeInput(reasoningRequest!, change), 2, reasoningFixture, reasoningExtract));
  pass('实际两主张/一边的用户原句及参考group完整核对；混namespace、反端点、重写推理或改变AND均拒绝');

  let statementExtract: LlmCallResponse | undefined, statementStage = 0, statementRequest: LlmCallRequest | undefined;
  const statementModel = createFrozenReferenceShadowModel(async request => {
    statementStage++; mockCalls++;
    const verified = await validateReviewProgressiveRequest(request, statementStage as 1 | 2, fixture, statementExtract);
    if (statementStage === 1) {
      statementExtract = { content: JSON.stringify({ version: 1, packetId: fixture.evaluationId,
        claims: [{ id: 'A1', role: 'definition', quote: '设备能开始执行训练指令' },
          { id: 'A2', role: 'condition', quote: '它得先有电，而且自检要通过' }],
        edges: [{ id: 'E1', source: 'A2', target: 'A1', relation: 'support', quote: c.answer }], requirements: [] }),
        diagnostics: { finishReason: 'stop' } };
      return statementExtract;
    }
    const input = verified.input as FrozenReferenceTypedInputV4;
    checkTypedWire(input, buildReviewProgressiveReferenceInput(fixture, statementExtract!), fixture);
    assert.equal(verified.stats.edges, 1); assert.equal(verified.stats.wireEdges, 0);
    assert.equal(verified.stats.statementItems, 2); assert.equal(verified.stats.inferenceItems, 0);
    assert.deepEqual(input.user.edges, []);
    statementRequest = structuredClone(request);
    return probeResponse(input);
  });
  await statementModel.extract(buildReviewProgressiveExtractionInput(fixture));
  await statementModel.review(buildReviewProgressiveReferenceInput(fixture, statementExtract!));
  await assert.rejects(() => validateReviewProgressiveRequest(changeInput(statementRequest!, input => {
    input.user.edges = [{ id: 'user/E1', source: 'user/A2', target: 'user/A1', relation: 'support', text: c.answer }];
  }), 2, fixture, statementExtract));
  pass('statement-only模式即使canonical抽到边也不发送用户边；统计区分canonical/实际wire边，重注边被拒绝');

  for (const field of ['context', 'messages', 'tools', 'agentMessages', 'stream', 'profile', 'personal', 'expected']) {
    for (const stage of [1, 2] as const) {
      const request = structuredClone(firstRequests[stage - 1]);
      Object.assign(request, { [field]: undefined });
      await assert.rejects(() => validateReviewProgressiveRequest(request, stage, fixture, stage === 2 ? firstExtract : undefined));
    }
  }
  pass('额外undefined上下文/消息/工具/画像/个人库/gold字段在两阶段均拒绝，不以JSON丢undefined绕过');

  for (const change of [
    (input: any) => { input.knowledgeTargets = ['new-target']; },
    (input: any) => { input.assessment.taskType = 'reasoning'; },
    (input: any) => { input.answer.text += '改写原答'; },
    (input: any) => { input.packetId = 'replacement-packet'; },
    (input: any) => { input.reference = fixture.context; },
    (input: any) => { input.expected = c.expected; },
  ]) await assert.rejects(() => validateReviewProgressiveRequest(changeInput(firstRequests[0], change), 1, fixture));
  pass('抽取包只允许原Q/answer/allowlist/fixed assessment，不接受新目标、任务、参考或gold');

  for (const change of [
    (input: any) => { input.frames[0].source.entityId = 'another-real-source'; },
    (input: any) => { input.frames[0].source.contentHash = '0'.repeat(64); },
    (input: any) => { input.frames[0].frameId = 'new-frame'; },
    (input: any) => { input.frames[0].knowledgeTarget = 'new-target'; },
    (input: any) => { input.frames[0].coverage = 'frame_subset'; },
    (input: any) => { input.contractHash = '0'.repeat(64); },
    (input: any) => { input.frames[0].items[0].requiredNodeIds = []; },
    (input: any) => { input.frames[0].items[0].referenceText += '新的标准'; },
    (input: any) => { input.frames[0].items[0].criterionDescription = 'weaker criterion'; },
    (input: any) => { input.frames[0].items[0].evidenceMode = 'inference'; },
    (input: any) => { input.frames[0].items[0].scopeRule = 'only_same_object'; },
    (input: any) => { input.frames[0].items[0].supportRule = 'any_single_node'; },
    (input: any) => { input.version = 2; },
    (input: any) => { input.version = 3; },
    (input: any) => { input.protocol = 'review-frozen-reference-readable-v2'; },
    (input: any) => { input.protocol = 'review-frozen-reference-typed-v3'; },
    (input: any) => { input.frames[0].nodes[0].evidence[0].text += '新的标准'; },
    (input: any) => { input.frames[0].nodes[0].id = 'user/A1'; },
    (input: any) => { input.user.claims[0].id = 'reference/target-1/node/N1'; },
    (input: any) => { input.user.claims[0].text += '补造用户主张'; },
    (input: any) => { input.user.claims[0].start = 0; },
    (input: any) => { input.user.claims[0].end = c.answer.length; },
    (input: any) => { input.user.answerText += '补造回答'; },
    (input: any) => { input.taskContext.questionText += '改题'; },
    (input: any) => { input.taskContext.usage = 'grading_evidence'; },
    (input: any) => { input.taskContext.taskType = 'reasoning'; },
    (input: any) => { input.evaluationId = 'frozen-reference:' + '0'.repeat(64); },
    (input: any) => { input.profile = { text: 'not-allowed' }; },
    (input: any) => { input.personal = { text: 'not-allowed' }; },
    (input: any) => { input.expected = c.expected; },
  ]) await assert.rejects(() => validateReviewProgressiveRequest(changeInput(firstRequests[1], change), 2, fixture, firstExtract));
  pass('v4参考来源/范围/必要映射/原文/namespace/题目用途/证据模式与scope规则篡改、v2/v3旧wire及画像/个人/gold混入均拒绝');

  for (const change of [
    (request: LlmCallRequest) => { request.providerId = 'different-provider'; },
    (request: LlmCallRequest) => { request.model = 'different-model'; },
    (request: LlmCallRequest) => { request.systemPromptOverride += '\nnew prompt'; },
    (request: LlmCallRequest) => { request.maxTokensOverride = 32768; },
    (request: LlmCallRequest) => { request.thinkingMode = 'enabled'; },
    (request: LlmCallRequest) => { request.skipMemoryInjection = false; },
    (request: LlmCallRequest) => { request.skipProfileInjection = false; },
    (request: LlmCallRequest) => { request.outputSchema = { type: 'object', extra: true }; },
  ]) {
    const request = structuredClone(firstRequests[0]); change(request);
    await assert.rejects(() => validateReviewProgressiveRequest(request, 1, fixture));
  }
  await assert.rejects(() => validateReviewProgressiveRequest(firstRequests[0], 3 as 2, fixture));
  await assert.rejects(() => validateReviewProgressiveRequest(firstRequests[0], 1, fixture, firstExtract));
  await assert.rejects(() => validateReviewProgressiveRequest(firstRequests[1], 2, fixture));
  const wrongExtract = structuredClone(firstExtract), wrongRaw = JSON.parse(wrongExtract.content);
  wrongRaw.packetId = 'other-answer'; wrongExtract.content = JSON.stringify(wrongRaw);
  await assert.rejects(() => validateReviewProgressiveRequest(firstRequests[1], 2, fixture, wrongExtract));
  pass('模型/provider覆写、提示/预算/schema/注入标志变动、第三阶段或错抽取响应均拒绝');

  const goldMarker = 'GOLD_ONLY_SHOULD_NEVER_ENTER_THE_WIRE';
  const changedGold: ReviewProgressiveCase = { ...c, hint: goldMarker,
    expected: { ...c.expected, rationale: goldMarker, frames: c.expected.frames.map(frame => ({ ...frame, status: 'partial',
      items: frame.items.map(item => ({ ...item, rationale: goldMarker, verdicts: ['unverifiable'] })) })) } };
  const noGold = await prepareReviewProgressiveFixture(changedGold);
  assert.deepEqual(noGold.answer, fixture.answer); assert.deepEqual(noGold.context, fixture.context); assert.deepEqual(noGold.packet, fixture.packet);
  assert.equal(noGold.evaluationId, fixture.evaluationId); assert.equal(noGold.sourceFingerprint, fixture.sourceFingerprint);
  assert.deepEqual(buildReviewProgressiveExtractionInput(noGold), buildReviewProgressiveExtractionInput(fixture));
  assert.deepEqual(buildReviewProgressiveReferenceInput(noGold, firstExtract), buildReviewProgressiveReferenceInput(fixture, firstExtract));
  assert.equal(JSON.stringify({ answer: noGold.answer, context: noGold.context, packet: noGold.packet }).includes(goldMarker), false);
  pass('改变gold verdict/rationale和额外hint说明不改变fixture、ID或请求；标签从不入包');

  const mutableCase = structuredClone(c), preparing = prepareReviewProgressiveFixture(mutableCase);
  mutableCase.answer = 'CALLER_CHANGED_AFTER_PREPARE'; mutableCase.question = 'CALLER_CHANGED_QUESTION';
  mutableCase.hintLevel = 4; mutableCase.consultedMaterialIds = ['CALLER_CHANGED_RESOURCE']; mutableCase.fixture.task = 'condition';
  const captured = await preparing;
  assert.deepEqual(captured.answer, fixture.answer); assert.deepEqual(captured.context, fixture.context); assert.equal(captured.evaluationId, fixture.evaluationId);
  pass('fixture首次await前捕获原题/回答/辅助/来源配方，调用者迟改不能污染');

  const cloneProbe = await prepareReviewProgressiveFixture(c), savedContext = structuredClone(cloneProbe.context);
  const heldIntent = structuredClone(cloneProbe.answer.evidence.questionIntent);
  cloneProbe.context.quotes[0].text = 'CONSUMER_CORRUPTS_PUBLIC_CONTEXT'; cloneProbe.packet.answer.text = 'CONSUMER_CORRUPTS_PACKET';
  const firstRead = await cloneProbe.dependencies.readReference(heldIntent);
  assert.equal(firstRead.status, 'ready');
  if (firstRead.status !== 'ready') throw new Error('expected_ready');
  assert.deepEqual(firstRead.context, savedContext); firstRead.context.frames[0].nodes = [];
  const secondRead = await cloneProbe.dependencies.readReference(heldIntent);
  assert.equal(secondRead.status, 'ready');
  if (secondRead.status !== 'ready') throw new Error('expected_ready');
  assert.deepEqual(secondRead.context, savedContext);
  for (const change of [
    (intent: typeof heldIntent) => { intent.questionMessageId = 'replacement-question'; },
    (intent: typeof heldIntent) => { intent.knowledgeTargets = ['new-source-target']; },
    (intent: typeof heldIntent) => { intent.referenceStructure!.freezeId = '12345678-1234-1234-1234-123456789abc'; },
    (intent: typeof heldIntent) => { intent.referenceStructure!.selectorsHash = '0'.repeat(64); },
    (intent: typeof heldIntent) => { intent.referenceRubric!.items[0].quote += 'replacement standard'; },
  ]) { const intent = structuredClone(heldIntent); change(intent); assert.equal((await cloneProbe.dependencies.readReference(intent)).status, 'held'); }
  pass('公开fixture/read DTO无共享可变authority；替换receipt、范围、问题或参考标准held');

  const requestRace = structuredClone(firstRequests[0]), pendingValidation = validateReviewProgressiveRequest(requestRace, 1, fixture);
  requestRace.systemPromptOverride = 'CHANGED_DURING_VALIDATION';
  await assert.rejects(pendingValidation, /progressive_request_changed_during_validation/u);
  const fixtureRace = await prepareReviewProgressiveFixture(c), frozenInput = buildReviewProgressiveExtractionInput(fixtureRace);
  const validRace = validateReviewProgressiveRequest(firstRequests[0], 1, fixtureRace);
  fixtureRace.packet.answer.text = 'LATE_MUTATION'; fixtureRace.context.quotes[0].text = 'LATE_MUTATION';
  assert.deepEqual((await validRace).input, frozenInput);
  pass('校验捕获fixture快照，同时拒绝校验await期间actual request变更');

  let endToEndCalls = 0, extraction: LlmCallResponse | undefined;
  const endToEndModel = createFrozenReferenceShadowModel(async request => {
    endToEndCalls++; mockCalls++;
    const verified = await validateReviewProgressiveRequest(request, endToEndCalls as 1 | 2, fixture, extraction);
    if (endToEndCalls === 1) { extraction = draftResponse(fixture.evaluationId, c.answer); return extraction; }
    return probeResponse(verified.input as FrozenReferenceTypedInputV4);
  });
  const before = JSON.stringify({ answer: fixture.answer, context: fixture.context, packet: fixture.packet });
  const evaluated = await evaluateFrozenReviewReferenceShadow(fixture.answer, fixture.dependencies, endToEndModel);
  assert.equal(evaluated.result.status, 'reviewed', JSON.stringify(evaluated.result));
  assert.equal(evaluated.result.evaluationId, fixture.evaluationId);
  assert.ok(evaluated.result.frames.every(frame => frame.status === 'partial'));
  assert.ok(evaluated.result.observations.every(observation => observation.verdict === 'unverifiable'));
  assert.deepEqual(evaluated.result.modelRequests, { extract: 1, reference: 1, total: 2, limit: 2 });
  assert.equal(evaluated.result.scoreWrite, 'disabled'); assert.equal(evaluated.result.cognitionWrite, 'disabled');
  assert.equal(JSON.stringify({ answer: fixture.answer, context: fixture.context, packet: fixture.packet }), before);
  pass('固定投票下实际engine/adapter/独立重建ID两阶段联通且不改fixture，不声称模型语义通过');

  // V4 has its own explicit decoder. Missing an unused opposition field is
  // permitted, but no old raw response, invented witness or unknown scope can
  // silently become a supported result through a legacy fallback.
  async function evaluateProbe(change: (raw: any) => void) {
    let requests = 0, extraction: LlmCallResponse | undefined;
    const model = createFrozenReferenceShadowModel(async request => {
      requests++; mockCalls++;
      const verified = await validateReviewProgressiveRequest(request, requests as 1 | 2, fixture, extraction);
      if (requests === 1) { extraction = draftResponse(fixture.evaluationId, c.answer); return extraction; }
      const response = probeResponse(verified.input as FrozenReferenceTypedInputV4), raw = JSON.parse(response.content);
      change(raw); response.content = JSON.stringify(raw); return response;
    });
    assert.equal(model.protocol, 'typed-v4');
    const reply = await evaluateFrozenReviewReferenceShadow(fixture.answer, fixture.dependencies, model);
    assert.equal(requests, 2); assert.equal(reply.result.modelRequests.total, 2);
    assert.equal(reply.result.scoreWrite, 'disabled'); assert.equal(reply.result.cognitionWrite, 'disabled');
    return reply.result;
  }
  for (const change of [(raw: any) => { for (const row of raw.items) delete row.opposition; },
    (raw: any) => { for (const row of raw.items) row.opposition = null; }]) {
    const result = await evaluateProbe(change);
    assert.equal(result.status, 'reviewed');
    assert.ok(result.observations.every(row => row.verdict === 'unverifiable'));
  }
  pass('真实factory显式typed-v4：noncontradicted可省空opposition或保留null，未生成语义支持或分数');

  for (const change of [(raw: any) => { raw.version = 3; },
    (raw: any) => { raw.items[0].opposition = {}; },
    (raw: any) => { raw.items[0].verdict = 'supported'; },
    (raw: any) => { raw.items[0].verdict = 'contradicted'; raw.items[0].scope = 'same'; },
    (raw: any) => { raw.profile = {}; }, (raw: any) => { raw.expected = c.expected; }]) {
    const result = await evaluateProbe(change);
    assert.equal(result.status, 'held', JSON.stringify(result));
    assert.deepEqual(result.observations, []); assert.deepEqual(result.frames, []);
  }
  pass('实际V4两阶段拒绝v3 raw回退、非null伪witness、unknown支持、无witness矛盾及画像/gold额外字段；不重试');

  // Fixed, manually declared literal graphs isolate transport/host shape from
  // model ability. We do not alter any case labels or reinterpret saved cloud
  // responses, and these votes are not reported as model accuracy.
  for (const reverse of [false, true]) {
    const sample = REVIEW_PROGRESSIVE_DATASET.find(value => value.id === (reverse ? 'R03' : 'R01'))!;
    const f = await prepareReviewProgressiveFixture(sample), saved = JSON.stringify({ answer: f.answer, context: f.context, packet: f.packet });
    let requests = 0, extraction: LlmCallResponse | undefined;
    const model = createFrozenReferenceShadowModel(async request => {
      requests++; mockCalls++;
      const verified = await validateReviewProgressiveRequest(request, requests as 1 | 2, f, extraction);
      if (requests === 1) {
        const claims = reverse
          ? [{ id: 'A1', role: 'fact', quote: '本次设备已供电' },
            { id: 'A2', role: 'fact', quote: '读数也超过阈值' },
            { id: 'A3', role: 'fact', quote: '本次会报警' },
            { id: 'A4', role: 'conclusion', quote: '本次读数超过阈值' }]
          : [{ id: 'A1', role: 'fact', quote: '本次设备已经通电' },
            { id: 'A2', role: 'fact', quote: '读数也确实超过阈值' },
            { id: 'A3', role: 'premise', quote: '本实验超阈值触发报警的规则' },
            { id: 'A4', role: 'conclusion', quote: '本次设备会报警' }];
        const edges = reverse
          ? [{ id: 'E1', source: 'A3', target: 'A4', relation: 'support', quote: '因为本次会报警，所以能推出本次读数超过阈值' }]
          : [{ id: 'E1', source: 'A2', target: 'A4', relation: 'support', quote: sample.answer },
            { id: 'E2', source: 'A1', target: 'A4', relation: 'support', quote: sample.answer }];
        extraction = { content: JSON.stringify({ version: 1, packetId: f.evaluationId, claims, edges, requirements: [] }),
          diagnostics: { finishReason: 'stop' } };
        return extraction;
      }
      const input = verified.input as FrozenReferenceTypedInputV4;
      checkTypedWire(input, buildReviewProgressiveReferenceInput(f, extraction!), f);
      assert.equal(verified.stats.claims, 4); assert.equal(verified.stats.wireEdges, reverse ? 1 : 2);
      const frame = input.frames[0];
      const pair = (claimId: string, nodeId: string) => {
        const node = frame.nodes.find(value => value.id === `reference/target-1/node/${nodeId}`)!;
        return { claimId: `user/${claimId}`, nodeId: node.id,
          referenceQuoteId: node.evidence[0].quoteId, referenceQuote: node.evidence[0].text };
      };
      const mappings = reverse ? [pair('A4', 'N1'), pair('A3', 'N2'), pair('A1', 'N3')]
        : [pair('A2', 'N1'), pair('A4', 'N2'), pair('A1', 'N3')];
      const items = frame.items.map(item => ({ itemId: item.itemId, scope: 'same',
        verdict: reverse && item.evidenceMode === 'inference' ? 'partial' : 'supported',
        matches: mappings.filter(mapping => item.requiredNodeIds.includes(mapping.nodeId)),
        ...(item.evidenceMode === 'inference' ? { edgeIds: reverse ? ['user/E1'] : ['user/E1', 'user/E2'],
          direction: reverse ? 'reverse' : 'correct', premises: 'complete' } : {}) }));
      return { content: JSON.stringify({ version: 4, evaluationId: input.evaluationId, contractHash: input.contractHash, items }),
        diagnostics: { finishReason: 'stop' } };
    });
    const evaluated = await evaluateFrozenReviewReferenceShadow(f.answer, f.dependencies, model);
    assert.equal(requests, 2); assert.equal(evaluated.result.status, 'reviewed', JSON.stringify(evaluated.result));
    assert.deepEqual(evaluated.result.modelRequests, { extract: 1, reference: 1, total: 2, limit: 2 });
    assert.equal(evaluated.result.frames[0].status, reverse ? 'partial' : 'covered');
    const inference = evaluated.result.observations.find(item => item.itemId === 'I3')!;
    assert.equal(inference.direction, reverse ? 'reverse' : 'correct');
    assert.equal(inference.verdict, reverse ? 'partial' : 'supported');
    assert.equal(evaluated.result.semanticTruth, 'not_certified');
    assert.equal(evaluated.result.scoreWrite, 'disabled'); assert.equal(evaluated.result.cognitionWrite, 'disabled');
    assert.equal(JSON.stringify({ answer: f.answer, context: f.context, packet: f.packet }), saved);
  }
  pass('忠实实际条件/事实/规则/结论及正反向原文连线的两阶段V4 mock可读取；正向覆盖、逆向partial而非矛盾，未变旧gold/分数');

  assert.equal(networkCalls, 0);
  console.log(`Review progressive transport: ${checks} offline groups passed; ${mockCalls} mock calls, 0 cloud/browser/config/real-vault/score/cognition/artifact writes. Existing cloud grades are unchanged.`);
} finally {
  globalThis.fetch = oldFetch;
  for (const [name, descriptor] of browserDescriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
}
