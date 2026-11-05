import assert from 'node:assert/strict';
import { REVIEW_DUAL_DATASET, type ReviewDualCase } from './review-dual-dataset';
import { prepareReviewDualFixture } from './review-dual-fixture';
import { evaluateReviewDual, type ReviewDualOutcome } from './review-dual-evaluation';
import { auditReviewGrowthDirections } from './review-growth-direction-audit';
import { validateReviewDualAnchoredRequest, validateReviewDualReplayInput } from './review-dual-transport';
import { buildReviewQuoteAnchors, readReviewQuoteAnchor, type ReviewQuoteSource } from '../src/services/reviewComparison/quoteAnchors';
import { buildReviewAnchoredChannel, readReviewAnchoredComparison, reviewAnchoredChannels, type ReviewAnchoredInput } from '../src/services/reviewComparison/anchoredProtocol';
import { createReviewSemanticModel } from '../src/services/reviewComparison/semanticClient';
import { evaluateReviewComparisonPacket, evaluateReviewComparisonSession } from '../src/services/reviewComparison/semanticEvaluator';
import { readReviewPerformanceGraph } from '../src/services/reviewComparison/performanceGraph';
import { validateReviewAlignments } from '../src/services/reviewComparison/semanticValidation';
import { buildReviewMasteryShadow } from '../src/services/reviewComparison/semanticOutputs';
import { buildReviewComparisonPacket } from '../src/services/reviewComparison/packet';
import { REVIEW_PERSONAL_ANCHORS_PROMPT } from '../src/services/reviewComparison/anchoredPrompts';
import type { CognitionGraph } from '../src/services/cognition/types';
import type { ReviewComparisonPacket } from '../src/services/reviewComparison/types';
import type { ReviewPerformanceGraph } from '../src/services/reviewComparison/semanticTypes';

const fetchBefore = globalThis.fetch;
globalThis.fetch = async () => assert.fail('No network allowed in anchored-channel checks');
let checks = 0;
const pass = (name: string) => { checks++; console.log(`PASS ${name}`); };
const fixture = (id: string) => prepareReviewDualFixture(REVIEW_DUAL_DATASET.find((c) => c.id === id)!);
type Fixture = Awaited<ReturnType<typeof fixture>>;
function graphFor(packet: ReviewComparisonPacket, layer = 'judgment') {
  return readReviewPerformanceGraph({ version: 1, packetId: packet.packetId,
    claims: [{ id: 'A1', role: 'fact', quote: packet.answer.text }], edges: [],
    requirements: [{ knowledgeTarget: packet.questionIntent.knowledgeTargets[0], layer, quote: packet.questionText }] }, packet);
}
const empty = (input: ReviewAnchoredInput): any => ({ version: 3, channel: input.channel, bindingId: input.bindingId, alignments: [],
  ...(input.channel === 'reference' ? { referenceAudit: { status: 'compatible', sourceIds: input.sources.filter((s) => s.kind === 'reference').map((s) => s.id) }, edgeChecks: [] }
    : { personalLinks: [] }) });
const q = (input: ReviewAnchoredInput, sourceId: string, text: string) => {
  const anchor = input.anchors.find((a) => a.sourceId === sourceId && a.text === text);
  assert.ok(anchor, `Program anchor missing: ${sourceId}`); return anchor.id;
};
const na = { status: 'not_applicable', leftQuoteId: null, rightQuoteId: null, reason: '命题不涉及该维度' };
function pair(input: ReviewAnchoredInput, claimId: string, targetText: string, relation = 'consistent', changes: any = {}): any {
  const slot = input.pairs.find((s) => s.claimId === claimId)!;
  const mainId = input.graph.claims.find((c) => c.id === claimId)!.quoteId;
  const targetId = q(input, slot.targetQuoteSourceId, targetText);
  const axis = { status: 'same', leftQuoteId: input.channel === 'personal' ? targetId : mainId,
    rightQuoteId: input.channel === 'personal' ? mainId : targetId, reason: '替身提供已指定范围的原文依据，非自动语义证明' };
  return { pairId: slot.pairId, targetQuoteId: targetId, relation, confidence: 0.95, sourcesCompatible: true,
    axes: { object: { ...axis }, condition: { ...axis }, time: { ...na }, metric: { ...axis, status: 'same_dimension' }, baseline: { ...na } }, ...changes };
}
async function stores(f: Fixture) {
  return JSON.stringify({ notes: await f.dependencies.readNotes(), cognition: await f.dependencies.loadCognition(),
    documents: await Promise.all(f.packet.references.filter((s) => s.kind === 'external-document').map((s) => f.dependencies.previewDocument(s.entityId, s.chunkId!))) });
}
/** Real bounded branch preparation and freshness reads, with no production store or fixture labels on wire. */
async function withPersonalGraph(base: Fixture, graph: CognitionGraph, reviewNeededNodeIds: string[] = []): Promise<Fixture> {
  const cognition = await base.dependencies.loadCognition();
  const branch = cognition.records[0].revisions.at(-1)!.branches[0];
  branch.graph = structuredClone(graph); branch.reviewNeededNodeIds = [...reviewNeededNodeIds];
  const dependencies = { ...base.dependencies, loadCognition: async () => structuredClone(cognition) };
  const notes = await dependencies.readNotes();
  const packet = await buildReviewComparisonPacket({ activityId: base.packet.activityId, questionText: base.packet.questionText,
    evidence: { messageId: base.packet.messageId, answer: base.packet.answer.text, hintLevel: base.packet.answer.hintLevel,
      consultedMaterialIds: base.packet.answer.consultedMaterialIds, targetKnowledgeNames: base.packet.questionIntent.knowledgeTargets,
      questionIntent: base.packet.questionIntent } }, dependencies, { targetScopeNoteIds: notes.map((n) => n.id) });
  return { ...base, dependencies, packet };
}
async function run(f: Fixture, graph: ReviewPerformanceGraph, response: (input: ReviewAnchoredInput) => unknown, options = {}) {
  let calls = 0;
  const before = JSON.stringify(f.packet), beforeStores = await stores(f);
  const result = await evaluateReviewComparisonPacket(f.packet, f.dependencies, createReviewSemanticModel(async (request) => {
    const input = await validateReviewDualAnchoredRequest(request, ++calls, f.packet, graph);
    validateReviewDualReplayInput(request, structuredClone(request));
    assert.ok(!request.userInput.includes('"expected"') && !request.userInput.includes('"rationale"'));
    if (calls > 1) {
      const tampered = { ...request, userInput: JSON.stringify({ ...input, bindingId: 'changed' }) };
      await assert.rejects(validateReviewDualAnchoredRequest(tampered, calls, f.packet, graph));
      assert.throws(() => validateReviewDualReplayInput(request, tampered), /replay_input_changed/);
    }
    return { content: JSON.stringify(calls === 1 ? graph : response(input)) };
  }, { comparisonProtocol: 'isolated-anchors-v3' }), options);
  assert.equal(JSON.stringify(f.packet), before); assert.equal(await stores(f), beforeStores);
  assert.equal(result.protocol, 'review-isolated-anchors-v3'); assert.equal(result.writes, 'disabled');
  assert.equal(result.modelRequests!.total, calls); assert.ok(calls <= 3);
  assert.ok(result.mastery.every((m) => m.scoreWrite === 'disabled'));
  assert.ok(result.growth.proposals.every((p) => p.preserveOriginal && p.status === 'pending_confirmation'));
  return { calls, result };
}

try {
  const outcomes: ReviewDualOutcome[] = []; let total = 0;
  for (const c of REVIEW_DUAL_DATASET) {
    const f = await prepareReviewDualFixture(c), graph = graphFor(f.packet);
    for (const channel of reviewAnchoredChannels(f.packet)) {
      const input = await buildReviewAnchoredChannel(f.packet, graph, channel);
      assert.deepEqual(input, await buildReviewAnchoredChannel(f.packet, graph, channel));
      assert.ok(input.anchors.every((a) => input.sources.find((s) => s.id === a.sourceId)!.text.slice(a.start, a.end) === a.text));
      if (channel === 'reference') {
        assert.ok(input.sources.every((s) => s.kind === 'answer' || s.kind === 'reference'));
        assert.ok(!Object.hasOwn(input, 'personalGraph'));
      } else {
        assert.ok(input.sources.every((s) => s.kind !== 'reference'));
        assert.equal(input.personalGraph!.targetNodeId, f.packet.questionIntent.cognitionTarget!.nodeId);
        assert.deepEqual(input.personalGraph!.edges, f.packet.personal.graph!.edges);
        assert.ok(input.personalGraph!.nodes.every((n) => input.sources.some((s) => s.id === n.sourceId && s.id === `B:node:${n.nodeId}`)));
      }
    }
    const outcome = await run(f, graph, empty); total += outcome.calls;
    assert.equal(outcome.calls, 1 + reviewAnchoredChannels(f.packet).length);
    assert.ok(!outcome.result.reasons.includes('semantic_model_unavailable'));
    outcomes.push({ id: c.id, requests: outcome.calls, result: outcome.result });
  }
  assert.equal(total, 63);
  assert.throws(() => evaluateReviewDual(REVIEW_DUAL_DATASET, outcomes, 'cloud'), /Invalid/);
  const metrics = evaluateReviewDual(REVIEW_DUAL_DATASET, outcomes, 'local', { requestLimitPerCase: 3 });
  assert.equal(metrics.completed, 28); assert.equal(metrics.protocolFailures, 0); assert.equal(metrics.pilotPassed, false); assert.equal(metrics.productionApproved, false);
  pass('28冻结合成样本、63次本地替身请求：真实适配器/输入重建/零网络零写入；不冒充语义实测');

  const source: ReviewQuoteSource = { id: 'U', kind: 'answer', text: '🙂甲，甲。乙。', truncated: false };
  const anchors = buildReviewQuoteAnchors([source], [{ sourceId: 'U', start: 4, end: 5 }]);
  assert.deepEqual(anchors, buildReviewQuoteAnchors([source], [{ sourceId: 'U', start: 4, end: 5 }]));
  assert.ok(anchors.every((a) => source.text.slice(a.start, a.end) === a.text));
  assert.equal(anchors[0].text, '甲');
  const firstOccurrence = anchors.find((a) => a.text === '🙂甲')!;
  assert.throws(() => readReviewQuoteAnchor(firstOccurrence.id, anchors, ['U'], 600, anchors[0]), /quote_anchor_outside_claim/);
  assert.throws(() => buildReviewQuoteAnchors([source], [{ sourceId: 'U', start: 1, end: 3 }]), /invalid_anchor_interval/);
  assert.throws(() => readReviewQuoteAnchor('Q999', anchors, ['U'], 600), /unknown_quote_anchor/);
  assert.throws(() => readReviewQuoteAnchor(anchors[0].id, anchors, ['R1'], 600), /wrong_quote_source/);
  const long = buildReviewQuoteAnchors([{ ...source, text: '甲'.repeat(599) }]);
  assert.throws(() => readReviewQuoteAnchor(long[0].id, long, ['U'], 200), /quote_anchor_too_long/);
  assert.throws(() => buildReviewQuoteAnchors([{ ...source, text: '甲'.repeat(60001) }]), /anchor_budget_exceeded/);
  assert.throws(() => buildReviewQuoteAnchors([{ ...source, text: '甲。'.repeat(300) }]), /anchor_budget_exceeded/);
  pass('连续原文、UTF16/emoji边界、重复出现位置、来源限制和显式字符/片段预算');

  const counter = await fixture('G05'), counterGraph = graphFor(counter.packet);
  const refInput = await buildReviewAnchoredChannel(counter.packet, counterGraph, 'reference');
  const personalInput = await buildReviewAnchoredChannel(counter.packet, counterGraph, 'personal');
  const changedPersonal = structuredClone(counter.packet);
  changedPersonal.personal.context += '只允许个人审核看到的旧观点';
  changedPersonal.personal.graph!.nodes[0].text += '只允许个人审核看到的旧观点';
  changedPersonal.personal.branchHash = 'changed-personal-version';
  changedPersonal.questionIntent.cognitionTarget!.revisionId = 'changed-personal-revision';
  changedPersonal.questionText = '只允许抽取阶段看到的问题';
  const noRequirements = { ...counterGraph, requirements: [] };
  assert.deepEqual(await buildReviewAnchoredChannel(counter.packet, noRequirements, 'reference'),
    await buildReviewAnchoredChannel(changedPersonal, noRequirements, 'reference'));
  assert.ok(!JSON.stringify(refInput).includes(counter.packet.personal.graph!.nodes[0].text));
  assert.ok(!Object.hasOwn(refInput.graph, 'requirements') && !Object.hasOwn(refInput, 'questionText'));
  const changedReference = structuredClone(counter.packet); changedReference.references[0].text = '资料一侧专用的改变';
  changedReference.references[0].version.updatedAt = 'changed-reference-version';
  assert.deepEqual(personalInput, await buildReviewAnchoredChannel(changedReference, counterGraph, 'personal'));
  const correctPersonal = (input: ReviewAnchoredInput) => {
    const item = pair(input, 'A1', counter.packet.personal.graph!.nodes[0].text, 'contradiction');
    item.relationBasis = { kind: 'observed_counterexample', leftQuoteId: item.targetQuoteId,
      rightQuoteId: input.graph.claims[0].quoteId, explanation: '本地指定的实际观测反例' };
    return { ...empty(input), alignments: [item] };
  };
  const correctReference = (input: ReviewAnchoredInput) => ({ ...empty(input), alignments: [pair(input, 'A1', counter.packet.references[0].text)] });
  const counterResult = await run(counter, counterGraph, (input) => input.channel === 'reference' ? correctReference(input) : correctPersonal(input));
  assert.equal(counterResult.result.growth.proposals[0].operation, 'review_conflict');
  assert.equal(counterResult.result.mastery[0].layers.judgment.status, 'supported');
  assert.deepEqual(counterResult.result.modelRequests, { extract: 1, reference: 1, personal: 1, total: 3, limit: 3 });
  const mistaken = await run(counter, counterGraph, (input) => {
    if (input.channel === 'personal') return correctPersonal(input);
    const raw = correctReference(input), item = raw.alignments[0]; item.relation = 'contradiction';
    item.relationBasis = { kind: 'observed_counterexample', leftQuoteId: input.graph.claims[0].quoteId,
      rightQuoteId: item.targetQuoteId, explanation: '模拟引用合法但语义错误的模型输出' }; return raw;
  });
  assert.ok(mistaken.result.alignments.some((a) => a.code === 'identical_reference_not_conflict'));
  assert.equal(mistaken.result.mastery[0].layers.judgment.status, 'unassessed');
  assert.equal(mistaken.result.growth.proposals[0].operation, 'review_conflict');
  pass('参考payload及私有绑定无旧认知/导师问题；个人payload无资料；个人冲突不污染一致参考评分');

  const storedGraph: CognitionGraph = { title: '仅供个人审核的旧论证链', nodes: [
    { id: 'A1', text: '选项难以比较。', mainType: '事实陈述' },
    { id: 'cost', text: '比较成本增加。', mainType: '推理', stance: 'tentative' },
    { id: 'node1', text: counter.packet.personal.graph!.nodes[0].text, mainType: '推理' },
    { id: 'objection', text: '偏好明确时可能不出现这一结果。', mainType: '反例削弱' },
  ], edges: [
    { id: 'E1', source: 'A1', target: 'cost', relation: 'support' },
    { id: 'E2', source: 'cost', target: 'node1', relation: 'support' },
    { id: 'E3', source: 'objection', target: 'node1', relation: 'oppose' },
  ] };
  const chain = await withPersonalGraph(counter, storedGraph, ['cost']);
  const chainGraph = graphFor(chain.packet);
  const chainInput = await buildReviewAnchoredChannel(chain.packet, chainGraph, 'personal');
  assert.equal(chainInput.personalGraph!.version, 1); assert.equal(chainInput.personalGraph!.truncated, false);
  assert.deepEqual(chainInput.personalGraph!.edges, storedGraph.edges);
  const cost = chainInput.personalGraph!.nodes.find((n) => n.nodeId === 'cost')!;
  assert.equal(cost.mainType, '推理'); assert.equal(cost.stance, 'tentative'); assert.equal(cost.reviewNeeded, true);
  assert.equal(chainInput.personalGraph!.nodes.find((n) => n.nodeId === 'node1')!.stance, 'endorsed');
  assert.equal(chainInput.graph.claims[0].id, 'A1'); assert.deepEqual(chainInput.graph.edges, []);
  assert.ok(chainInput.personalGraph!.nodes.some((n) => n.nodeId === 'A1' && n.sourceId === 'B:node:A1'));
  assert.ok(chainInput.personalGraph!.nodes.every((n) => !Object.hasOwn(n, 'text')));
  assert.deepEqual(await buildReviewAnchoredChannel(chain.packet, chainGraph, 'reference'), refInput);
  const sentChain = await run(chain, chainGraph, (input) => {
    if (input.channel === 'personal') assert.deepEqual(input.personalGraph, chainInput.personalGraph);
    return empty(input);
  });
  assert.equal(sentChain.calls, 3); assert.equal(sentChain.result.growth.proposals.length, 0);
  assert.ok(REVIEW_PERSONAL_ANCHORS_PROMPT.includes('personalGraph是冻结的旧个人论证分支'));
  assert.ok(REVIEW_PERSONAL_ANCHORS_PROMPT.includes('不能把旧边直接复制成personalLinks或反转方向'));
  pass('真实分支准备→实际请求：完整多跳/反对旧边、类型/暂定/待复核元数据；旧图与同名本轮节点隔离且不造新证据');

  const chainRaw = empty(chainInput);
  for (const mutate of [
    (p: ReviewComparisonPacket) => { Object.assign(p.personal.graph!.edges[0], { source: 'cost', target: 'A1' }); },
    (p: ReviewComparisonPacket) => { p.personal.graph!.edges[0].relation = 'oppose'; },
    (p: ReviewComparisonPacket) => { p.personal.graph!.nodes[0].mainType = '假设'; },
    (p: ReviewComparisonPacket) => { p.personal.graph!.nodes[0].stance = 'tentative'; },
    (p: ReviewComparisonPacket) => { p.personal.reviewNeededNodeIds = ['node1']; },
    (p: ReviewComparisonPacket) => { p.personal.truncated = true; },
  ]) {
    const changed = structuredClone(chain.packet); mutate(changed);
    const changedInput = await buildReviewAnchoredChannel(changed, chainGraph, 'personal');
    assert.notEqual(changedInput.bindingId, chainInput.bindingId);
    await assert.rejects(readReviewAnchoredComparison(chainRaw, changed, chainGraph, 'personal'), /wrong_anchored_binding/);
    assert.deepEqual(await buildReviewAnchoredChannel(changed, chainGraph, 'reference'), refInput);
  }
  const reversedWire = structuredClone(chainInput);
  Object.assign(reversedWire.personalGraph!.edges[0], { source: 'cost', target: 'A1' });
  const reversedRequest = { workflow: 'review-scoring' as const, providerId: '', model: '', userInput: JSON.stringify(reversedWire),
    systemPromptOverride: REVIEW_PERSONAL_ANCHORS_PROMPT, maxTokensOverride: 8192,
    skipMemoryInjection: true, skipProfileInjection: true, thinkingMode: 'disabled' as const };
  await assert.rejects(validateReviewDualAnchoredRequest(reversedRequest, 3, chain.packet, chainGraph));
  const previousWire = structuredClone(chainInput); delete previousWire.personalGraph;
  assert.throws(() => validateReviewDualReplayInput({ ...reversedRequest, userInput: JSON.stringify(chainInput) },
    { ...reversedRequest, userInput: JSON.stringify(previousWire) }), /replay_input_changed/);
  const foreignTarget = { ...empty(chainInput), personalLinks: [{ slotId: 'L1', answerQuoteId: chainInput.graph.claims[0].quoteId,
    personalQuoteId: q(chainInput, 'B:node:cost', '比较成本增加。'), relation: 'support',
    direction: 'answer_to_personal', basis: 'answer', conclusion: 'personal', premiseStatus: 'sufficient', confidence: 0.95 }] };
  await assert.rejects(readReviewAnchoredComparison(foreignTarget, chain.packet, chainGraph, 'personal'), /wrong_quote_source/);
  const noStance = structuredClone(chain.packet); delete noStance.personal.stance;
  for (const node of noStance.personal.graph!.nodes) delete node.stance;
  assert.ok((await buildReviewAnchoredChannel(noStance, chainGraph, 'personal')).personalGraph!.nodes.every((n) => n.stance === 'unknown'));
  pass('旧边方向/关系/类型/认同/待复核/截断均纳入个人绑定；篡改请求和邻居替代目标拒绝；缺认同不猜已确认');

  for (const mutate of [
    (p: ReviewComparisonPacket) => { p.personal.graph!.nodes.push(p.personal.graph!.nodes[0]); },
    (p: ReviewComparisonPacket) => { p.personal.graph!.edges.push(p.personal.graph!.edges[0]); },
    (p: ReviewComparisonPacket) => { p.personal.graph!.edges[0].target = 'missing'; },
    (p: ReviewComparisonPacket) => { (p.personal.graph!.edges[0] as any).relation = 'causes'; },
    (p: ReviewComparisonPacket) => { (p.personal.graph!.nodes[0] as any).mainType = 'invalid'; },
    (p: ReviewComparisonPacket) => { (p.personal.graph!.nodes[0] as any).stance = 'invalid'; },
    (p: ReviewComparisonPacket) => { p.personal.reviewNeededNodeIds = ['missing']; },
  ]) {
    const invalid = structuredClone(chain.packet); mutate(invalid);
    await assert.rejects(buildReviewAnchoredChannel(invalid, chainGraph, 'personal'), /invalid_personal_graph/);
    assert.deepEqual(await buildReviewAnchoredChannel(invalid, chainGraph, 'reference'), refInput);
  }
  const corrupt = structuredClone(storedGraph); (corrupt.nodes[1] as any).mainType = 'invalid';
  const corruptFixture = await withPersonalGraph(counter, corrupt);
  const corruptResult = await run(corruptFixture, graphFor(corruptFixture.packet), correctReference);
  assert.equal(corruptResult.calls, 2); assert.equal(corruptResult.result.modelRequests!.personal, 0);
  assert.deepEqual(corruptResult.result.channels!.personal.reasons, ['invalid_personal_graph']);
  assert.equal(corruptResult.result.mastery[0].layers.judgment.status, 'supported');
  pass('损坏旧图拒绝且不修补/静默丢边；个人零审核请求、参考有效结果仍保留');

  for (const kind of ['nodes', 'edges'] as const) {
    const oversized = structuredClone(chain.packet);
    if (kind === 'nodes') oversized.personal.graph!.nodes = Array.from({ length: 25 }, (_, i) => ({
      id: i ? `extra${i}` : 'node1', text: '短观点。', mainType: '事实陈述' as const }));
    else oversized.personal.graph!.edges = Array.from({ length: 65 }, (_, i) => ({ id: `extra${i}`, source: 'A1', target: 'cost', relation: 'support' as const }));
    await assert.rejects(buildReviewAnchoredChannel(oversized, chainGraph, 'personal'), /anchor_budget_exceeded/);
  }
  const exactLimit: CognitionGraph = { title: '完整预算边界', nodes: Array.from({ length: 24 }, (_, i) => ({
    id: i ? `n${i}` : 'node1', text: `边界观点${i}。`, mainType: '事实陈述' as const })),
    edges: Array.from({ length: 64 }, (_, i) => ({ id: `e${i}`, source: 'node1', target: `n${i % 23 + 1}`, relation: 'support' as const })) };
  const atLimit = await withPersonalGraph(counter, exactLimit);
  const limitInput = await buildReviewAnchoredChannel(atLimit.packet, graphFor(atLimit.packet), 'personal');
  assert.equal(limitInput.personalGraph!.nodes.length, 24); assert.equal(limitInput.personalGraph!.edges.length, 64);
  assert.equal(limitInput.personalGraph!.truncated, false);
  const largeGraph: CognitionGraph = { title: '超限旧图', nodes: Array.from({ length: 26 }, (_, i) => ({
    id: i ? `n${i}` : 'node1', text: '短观点。', mainType: '事实陈述' as const })),
    edges: Array.from({ length: 70 }, (_, i) => ({ id: `e${i}`, source: 'node1', target: `n${i % 25 + 1}`, relation: 'support' as const })) };
  const bounded = await withPersonalGraph(counter, largeGraph), boundedGraph = graphFor(bounded.packet);
  assert.equal(bounded.packet.personal.graph!.nodes.length, 24); assert.equal(bounded.packet.personal.graph!.edges.length, 64);
  assert.equal(bounded.packet.personal.truncated, true);
  const retainedIds = new Set(bounded.packet.personal.graph!.nodes.map((n) => n.id));
  assert.ok(bounded.packet.personal.graph!.edges.every((e) => retainedIds.has(e.source) && retainedIds.has(e.target)));
  await assert.rejects(buildReviewAnchoredChannel(bounded.packet, boundedGraph, 'personal'), /review_channel_unavailable/);
  const boundedResult = await run(bounded, boundedGraph, correctReference);
  assert.equal(boundedResult.calls, 2); assert.equal(boundedResult.result.modelRequests!.personal, 0);
  assert.ok(boundedResult.result.channels!.personal.reasons.includes('incomplete_personal_context'));
  pass('旧图24节点/64边预算显式拒绝；真实上游截断无悬空边并阻断个人请求，不伪装完整论证链');

  for (const channel of ['reference', 'personal'] as const) {
    const partial = await run(counter, counterGraph, (input) => input.channel === channel ? { ...empty(input), score: 100 }
      : input.channel === 'reference' ? correctReference(input) : correctPersonal(input));
    assert.equal(partial.calls, 3); assert.equal(partial.result.channels![channel].status, 'held');
    assert.ok(partial.result.channels![channel].reasons.includes('invalid_anchored_format'));
    if (channel === 'reference') {
      assert.equal(partial.result.growth.proposals[0].operation, 'review_conflict');
      assert.equal(partial.result.mastery[0].layers.judgment.status, 'unassessed');
    } else {
      assert.equal(partial.result.mastery[0].layers.judgment.status, 'supported');
      assert.equal(partial.result.growth.proposals.length, 0);
    }
  }
  pass('一侧格式拒绝不重试、不污染另一侧结果；下游证据分别通过原门槛');

  const raw = correctReference(refInput);
  for (const mutate of [
    (v: any) => { v.alignments[0].sourceQuote = counter.packet.references[0].text; },
    (v: any) => { v.alignments[0].start = 0; },
    (v: any) => { v.personalLinks = []; },
    (v: any) => { v.alignments[0].axes.metric.status = 'same'; },
    (v: any) => { v.alignments[0].axes.time.leftQuoteId = refInput.graph.claims[0].quoteId; },
    (v: any) => { v.alignments[0].axes.object.reason = ''; },
  ]) { const wrong = structuredClone(raw); mutate(wrong); await assert.rejects(readReviewAnchoredComparison(wrong, counter.packet, counterGraph, 'reference'), /invalid_anchored_format/); }
  const swapped = structuredClone(raw); swapped.alignments[0].targetQuoteId = refInput.graph.claims[0].quoteId;
  await assert.rejects(readReviewAnchoredComparison(swapped, counter.packet, counterGraph, 'reference'), /wrong_quote_source/);
  const axisSwapped = structuredClone(raw); axisSwapped.alignments[0].axes.object.rightQuoteId = refInput.graph.claims[0].quoteId;
  await assert.rejects(readReviewAnchoredComparison(axisSwapped, counter.packet, counterGraph, 'reference'), /wrong_quote_source/);
  const unknown = structuredClone(raw); unknown.alignments[0].targetQuoteId = 'Q9999';
  await assert.rejects(readReviewAnchoredComparison(unknown, counter.packet, counterGraph, 'reference'), /unknown_quote_anchor/);
  const duplicate = structuredClone(raw); duplicate.alignments.push(duplicate.alignments[0]);
  await assert.rejects(readReviewAnchoredComparison(duplicate, counter.packet, counterGraph, 'reference'), /duplicate_anchored_slot/);
  const unknownSlot = structuredClone(raw); unknownSlot.alignments[0].pairId = 'P999';
  await assert.rejects(readReviewAnchoredComparison(unknownSlot, counter.packet, counterGraph, 'reference'), /unknown_anchored_slot/);
  const badBinding = structuredClone(raw); badBinding.bindingId = 'prior-run';
  await assert.rejects(readReviewAnchoredComparison(badBinding, counter.packet, counterGraph, 'reference'), /wrong_anchored_binding/);
  await assert.rejects(readReviewAnchoredComparison(raw, changedReference, counterGraph, 'reference'), /wrong_anchored_binding/);
  pass('自由引文/偏移/跨通道字段、错侧Q、未知Q、重复slot及旧绑定均严格拒绝');

  const x = await fixture('X02'), xGraph = graphFor(x.packet);
  const xResponse = (input: ReviewAnchoredInput) => {
    const item = pair(input, 'A1', x.packet.references[0].text, 'contradiction');
    item.relationBasis = { kind: 'incompatible_facts', leftQuoteId: input.graph.claims[0].quoteId,
      rightQuoteId: item.targetQuoteId, explanation: '同次观测的互斥状态' };
    return { ...empty(input), alignments: [item] };
  };
  const contradicted = await run(x, xGraph, xResponse);
  assert.equal(contradicted.result.mastery[0].layers.judgment.status, 'contradicted');
  const differentDimension = await run(x, xGraph, (input) => { const value = xResponse(input); value.alignments[0].axes.metric.status = 'different_dimension'; return value; });
  assert.equal(differentDimension.result.mastery[0].layers.judgment.status, 'unassessed');
  assert.equal(differentDimension.result.alignments[0].code, 'relation_axis_mismatch');
  const uncertain = await fixture('G04'), uncertainGraph = graphFor(uncertain.packet);
  const certainty = await run(uncertain, uncertainGraph, (input) => {
    const item = pair(input, 'A1', input.channel === 'personal' ? uncertain.packet.personal.graph!.nodes[0].text : uncertain.packet.references[0].text,
      input.channel === 'personal' ? 'certainty_change' : 'consistent');
    if (input.channel === 'personal') item.relationBasis = { kind: 'evidence_limit', leftQuoteId: item.targetQuoteId,
      rightQuoteId: input.graph.claims[0].quoteId, explanation: '明确证据局限，非发生反例' };
    return { ...empty(input), alignments: [item] };
  });
  assert.equal(certainty.result.growth.proposals[0].operation, 'certainty_review');
  assert.equal(certainty.result.mastery[0].layers.judgment.status, 'supported');
  pass('实际互斥冲突/证据局限仍能准入；引用ID不放宽指标维度门槛');

  const contextual = await fixture('G03'), cGraph = graphFor(contextual.packet);
  const contextualResult = await run(contextual, cGraph, (input) => {
    const item = pair(input, 'A1', input.channel === 'personal' ? contextual.packet.personal.graph!.nodes[0].text : contextual.packet.references[0].text,
      input.channel === 'personal' ? 'condition_difference' : 'consistent');
    if (input.channel === 'personal') item.axes.condition.status = 'different';
    return { ...empty(input), alignments: [item] };
  });
  assert.equal(contextualResult.result.growth.proposals[0].operation, 'contextual');
  const absent = await fixture('B05'), aGraph = graphFor(absent.packet);
  const absentResult = await run(absent, aGraph, (input) => {
    const item = pair(input, 'A1', absent.packet.personal.graph!.nodes[0].text, 'supplement'); item.axes.metric.status = 'different_dimension';
    return { ...empty(input), alignments: [item] };
  });
  assert.equal(absentResult.calls, 2); assert.equal(absentResult.result.modelRequests!.reference, 0);
  assert.equal(absentResult.result.growth.status, 'proposed'); assert.equal(absentResult.result.mastery[0].layers.judgment.status, 'unassessed');
  const repeat = await fixture('B06');
  const repeated = await run(repeat, graphFor(repeat.packet, 'reasoning'), (input) => ({ ...empty(input), alignments: [pair(input, 'A1', input.channel === 'personal'
    ? repeat.packet.personal.graph!.nodes[0].text : repeat.packet.references[0].text)] }));
  assert.equal(repeated.result.growth.status, 'no_change');
  const hinted = await fixture('B04');
  const hintedResult = await run(hinted, graphFor(hinted.packet), (input) => ({ ...empty(input), alignments: [pair(input, 'A1', hinted.packet.references[0].text)] }));
  assert.equal(hintedResult.result.mastery[0].layers.judgment.status, 'unassessed');
  pass('不同条件保留旧分支；无参考只审个人；纯重述不生长，强提示不证明独立掌握');

  const reasoning = await fixture('G06');
  const premise = '本次设备甲的指标P超过阈值T。', conclusion = '本次设备甲报警。';
  const rGraph = readReviewPerformanceGraph({ version: 1, packetId: reasoning.packet.packetId,
    claims: [{ id: 'A1', role: 'premise', quote: premise }, { id: 'A2', role: 'conclusion', quote: conclusion }],
    edges: [{ id: 'E1', source: 'A1', target: 'A2', relation: 'support', quote: reasoning.packet.answer.text }],
    requirements: [{ knowledgeTarget: reasoning.packet.questionIntent.knowledgeTargets[0], layer: 'reasoning', quote: reasoning.packet.questionText }] }, reasoning.packet);
  const reasoningResponse = (input: ReviewAnchoredInput): any => {
    if (input.channel === 'reference') return { ...empty(input), alignments: [pair(input, 'A1', premise), pair(input, 'A2', conclusion)],
      edgeChecks: [{ slotId: input.edgeSlots[0].slotId, referenceQuoteId: q(input, 'R1', reasoning.packet.references[0].text), relation: 'support', verdict: 'supported',
        direction: 'source_to_target', basis: 'source', conclusion: 'target', premiseStatus: 'sufficient', confidence: 0.95 }] };
    const item = pair(input, 'A2', premise, 'supplement'); item.axes.metric.status = 'different_dimension';
    return { ...empty(input), alignments: [item], personalLinks: [{ slotId: input.linkSlots.find((s) => s.claimId === 'A2')!.slotId,
      answerQuoteId: input.graph.claims.find((c) => c.id === 'A2')!.quoteId, personalQuoteId: item.targetQuoteId, relation: 'support',
      direction: 'personal_to_answer', basis: 'personal', conclusion: 'answer', premiseStatus: 'sufficient', confidence: 0.95 }] };
  };
  const reasoned = await run(reasoning, rGraph, reasoningResponse);
  assert.equal(reasoned.result.mastery[0].layers.reasoning.status, 'supported');
  assert.equal(reasoned.result.growth.proposals[0].link!.direction, 'personal_to_answer');
  const oldReasoning = await withPersonalGraph(reasoning, { title: '旧前提和中间结论', nodes: [
    { id: 'node1', text: premise, mainType: '事实陈述' },
    { id: 'A1', text: '本次设备甲满足触发条件。', mainType: '推理' },
  ], edges: [{ id: 'E1', source: 'node1', target: 'A1', relation: 'support' }] });
  const currentReasoningGraph = readReviewPerformanceGraph({ ...rGraph, packetId: oldReasoning.packet.packetId }, oldReasoning.packet);
  const simultaneous = await buildReviewAnchoredChannel(oldReasoning.packet, currentReasoningGraph, 'personal');
  assert.deepEqual(simultaneous.personalGraph!.edges, [{ id: 'E1', source: 'node1', target: 'A1', relation: 'support' }]);
  assert.deepEqual(simultaneous.graph.edges, [{ id: 'E1', source: 'A1', target: 'A2', relation: 'support', quote: reasoning.packet.answer.text }]);
  assert.equal(simultaneous.anchors.find((a) => a.id === simultaneous.graph.claims[0].quoteId)!.sourceId, 'U');
  const simultaneousResult = await run(oldReasoning, currentReasoningGraph, empty);
  assert.equal(simultaneousResult.calls, 3); assert.equal(simultaneousResult.result.growth.proposals.length, 0);
  pass('旧/新图同时有同名E1/A1时各自方向和原文来源独立，旧推理不能直接复制成新增关系');
  // A fully self-consistent WRONG semantic direction can still pass formal enum gates.
  // Expose it in the separately versioned fixture audit, never claim IDs alone fixed this risk.
  const wrongSemanticDirection = await run(reasoning, rGraph, (input) => {
    const value = reasoningResponse(input);
    if (input.channel === 'personal') Object.assign(value.personalLinks[0], { direction: 'answer_to_personal', basis: 'answer', conclusion: 'personal' });
    return value;
  });
  assert.equal(wrongSemanticDirection.result.growth.proposals[0].link!.direction, 'answer_to_personal');
  assert.equal(auditReviewGrowthDirections([{ id: 'G06', result: reasoned.result, requests: 3 }]).entries[1].status, 'passed');
  const directionAudit = auditReviewGrowthDirections([{ id: 'G06', result: wrongSemanticDirection.result, requests: 3 }]);
  assert.equal(directionAudit.entries[1].status, 'failed'); assert.equal(directionAudit.wrongDirectionCount, 1);
  assert.equal(directionAudit.ready, false); assert.equal(directionAudit.productionApproved, false);
  const observation = await fixture('G02'), observationGraph = graphFor(observation.packet);
  const observed = await run(observation, observationGraph, (input) => {
    const item = pair(input, 'A1', input.channel === 'personal' ? observation.packet.personal.graph!.nodes[0].text : observation.packet.references[0].text);
    return { ...empty(input), alignments: [item], ...(input.channel === 'personal' ? { personalLinks: [{ slotId: input.linkSlots[0].slotId,
      answerQuoteId: input.graph.claims[0].quoteId, personalQuoteId: item.targetQuoteId, relation: 'support', direction: 'answer_to_personal',
      basis: 'answer', conclusion: 'personal', premiseStatus: 'sufficient', confidence: 0.95 }] } : {}) };
  });
  const goodAudit = auditReviewGrowthDirections([{ id: 'G02', result: observed.result, requests: 3 },
    { id: 'G06', result: reasoned.result, requests: 3 }, { id: 'B06', result: repeated.result, requests: 3 }]);
  assert.equal(goodAudit.ready, true); assert.equal(goodAudit.passed, 3); assert.equal(goodAudit.productionApproved, false);
  for (const failure of ['missing', 'reversed', 'no-premise']) {
    const result = await run(reasoning, rGraph, (input) => {
      const value = reasoningResponse(input);
      if (input.channel === 'reference') {
        if (failure === 'no-premise') value.alignments.shift();
        else if (failure === 'missing') value.edgeChecks[0].premiseStatus = 'missing';
        else { value.edgeChecks[0].basis = 'target'; value.edgeChecks[0].conclusion = 'source'; }
      } else { value.personalLinks[0].basis = 'answer'; value.personalLinks[0].conclusion = 'personal'; }
      return value;
    });
    assert.equal(result.result.mastery[0].layers.reasoning.status, 'unassessed');
    assert.ok(result.result.growth.proposals.every((p) => !p.link));
  }
  pass('推理实际两端、充分前提及方向角色门仍生效；个人链接方向独立，不把形式一致当语义证明');

  const repeatedCase: ReviewDualCase = { ...REVIEW_DUAL_DATASET.find((c) => c.id === 'B06')!, id: 'ANCHOR-REPEATED', answer: '甲。甲。', personal: {
    ...REVIEW_DUAL_DATASET.find((c) => c.id === 'B06')!.personal!, text: '甲。' }, references: ['甲。'] };
  const repeatedFixture = await prepareReviewDualFixture(repeatedCase);
  const repeatedGraph = readReviewPerformanceGraph({ version: 1, packetId: repeatedFixture.packet.packetId,
    claims: [{ id: 'A1', role: 'fact', quote: '甲。', start: 2, end: 4 }], edges: [], requirements: [] }, repeatedFixture.packet);
  const repeatedInput = await buildReviewAnchoredChannel(repeatedFixture.packet, repeatedGraph, 'personal');
  const early = repeatedInput.anchors.find((a) => a.sourceId === 'U' && a.start === 0 && a.end === 2)!;
  const late = repeatedInput.anchors.find((a) => a.sourceId === 'U' && a.start === 2 && a.end === 4)!;
  const repeatedRaw = { ...empty(repeatedInput), personalLinks: [{ slotId: 'L1', answerQuoteId: early.id,
    personalQuoteId: q(repeatedInput, 'B:node:node1', '甲。'), relation: 'support', direction: 'answer_to_personal',
    basis: 'answer', conclusion: 'personal', premiseStatus: 'sufficient', confidence: 0.95 }] };
  await assert.rejects(readReviewAnchoredComparison(repeatedRaw, repeatedFixture.packet, repeatedGraph, 'personal'), /quote_anchor_outside_claim/);
  repeatedRaw.personalLinks[0].answerQuoteId = late.id;
  await readReviewAnchoredComparison(repeatedRaw, repeatedFixture.packet, repeatedGraph, 'personal');
  const multiCase = { ...REVIEW_DUAL_DATASET.find((c) => c.id === 'X02')!, id: 'ANCHOR-MULTI', references: [x.packet.references[0].text, x.packet.references[0].text] };
  const multi = await prepareReviewDualFixture(multiCase), multiGraph = graphFor(multi.packet);
  const multiInput = await buildReviewAnchoredChannel(multi.packet, multiGraph, 'reference');
  const multiRaw = { ...empty(multiInput), alignments: [pair(multiInput, 'A1', multi.packet.references[0].text)] };
  multiRaw.alignments[0].targetQuoteId = q(multiInput, 'R2', multi.packet.references[1].text);
  await assert.rejects(readReviewAnchoredComparison(multiRaw, multi.packet, multiGraph, 'reference'), /wrong_quote_source/);
  const incomplete = empty(multiInput); incomplete.referenceAudit.sourceIds = ['R1'];
  await assert.rejects(readReviewAnchoredComparison(incomplete, multi.packet, multiGraph, 'reference'), /incomplete_reference_audit/);
  const truncated = structuredClone(x.packet); truncated.references[0].truncated = true;
  const truncatedInput = await buildReviewAnchoredChannel(truncated, xGraph, 'reference');
  const truncatedComparison = await readReviewAnchoredComparison(xResponse(truncatedInput), truncated, xGraph, 'reference');
  assert.equal(buildReviewMasteryShadow(truncated, xGraph, truncatedComparison, validateReviewAlignments(truncatedComparison, truncated, xGraph))[0].status, 'held');
  pass('重复原话按实际位置绑定；同文本R1/R2不能互借；全来源审计、截断门未放宽');

  for (const afterChannel of ['reference', 'personal'] as const) {
    const freshFixture = await fixture('G05'), freshGraph = graphFor(freshFixture.packet), originalLoad = freshFixture.dependencies.loadCognition;
    let changed = false, calls = 0;
    freshFixture.dependencies.loadCognition = async () => {
      const file = await originalLoad(); if (changed) file.records[0].revisions[0].branches[0].graph.nodes[0].text += '已变更'; return file;
    };
    const result = await evaluateReviewComparisonPacket(freshFixture.packet, freshFixture.dependencies, createReviewSemanticModel(async (request) => {
      calls++; if (calls === 1) return { content: JSON.stringify(freshGraph) };
      const input = JSON.parse(request.userInput); if (input.channel === afterChannel) changed = true;
      return { content: JSON.stringify(empty(input)) };
    }, { comparisonProtocol: 'isolated-anchors-v3' }));
    assert.equal(calls, afterChannel === 'reference' ? 2 : 3); assert.equal(result.status, 'held');
    assert.equal(result.growth.proposals.length, 0); assert.ok(result.mastery.every((m) => m.status === 'held'));
  }
  for (const afterChannel of ['reference', 'personal'] as const) {
    let changed = false, calls = 0;
    const dependencies = { ...chain.dependencies, loadCognition: async () => {
      const file = await chain.dependencies.loadCognition();
      if (changed) Object.assign(file.records[0].revisions.at(-1)!.branches[0].graph.edges[0], { source: 'cost', target: 'A1' });
      return file;
    } };
    const result = await evaluateReviewComparisonPacket(chain.packet, dependencies, createReviewSemanticModel(async (request) => {
      if (++calls === 1) return { content: JSON.stringify(chainGraph) };
      const input = JSON.parse(request.userInput); if (input.channel === afterChannel) changed = true;
      return { content: JSON.stringify(input.channel === 'reference' ? correctReference(input) : empty(input)) };
    }, { comparisonProtocol: 'isolated-anchors-v3' }));
    assert.equal(calls, afterChannel === 'reference' ? 2 : 3); assert.equal(result.status, 'held');
    assert.ok(result.reasons.includes('personal_snapshot_changed'));
    assert.equal(result.growth.proposals.length, 0); assert.ok(result.mastery.every((m) => m.status === 'held'));
  }
  const stopped = await fixture('G05'); let stoppedCalls = 0;
  const controller = new AbortController(); controller.abort();
  const canceled = await evaluateReviewComparisonPacket(stopped.packet, stopped.dependencies, createReviewSemanticModel(async () => {
    stoppedCalls++; return { content: '{}' };
  }, { comparisonProtocol: 'isolated-anchors-v3' }), { signal: controller.signal });
  assert.equal(stoppedCalls, 0); assert.deepEqual(canceled.reasons, ['semantic_aborted']);
  const timed = await evaluateReviewComparisonPacket(stopped.packet, stopped.dependencies, createReviewSemanticModel(async () => {
    stoppedCalls++; return new Promise(() => {});
  }, { comparisonProtocol: 'isolated-anchors-v3' }), { timeoutMs: 5 });
  assert.equal(stoppedCalls, 1); assert.deepEqual(timed.reasons, ['semantic_timeout']);
  let failedCalls = 0;
  const failed = await evaluateReviewComparisonPacket(stopped.packet, stopped.dependencies, createReviewSemanticModel(async () => {
    if (++failedCalls === 1) return { content: JSON.stringify(graphFor(stopped.packet)) }; throw new Error('provider failed');
  }, { comparisonProtocol: 'isolated-anchors-v3' }));
  assert.equal(failedCalls, 2); assert.deepEqual(failed.reasons, ['semantic_model_unavailable']);
  const lateCanceled = await fixture('G05'), lateController = new AbortController();
  let lateLoads = 0, lateCalls = 0;
  const lateLoad = lateCanceled.dependencies.loadCognition;
  lateCanceled.dependencies.loadCognition = async () => {
    const file = await lateLoad(); if (++lateLoads === 6) lateController.abort(); return file;
  };
  const lateResult = await evaluateReviewComparisonPacket(lateCanceled.packet, lateCanceled.dependencies, createReviewSemanticModel(async (request) => {
    if (++lateCalls === 1) return { content: JSON.stringify(graphFor(lateCanceled.packet)) };
    return { content: JSON.stringify(empty(JSON.parse(request.userInput))) };
  }, { comparisonProtocol: 'isolated-anchors-v3' }), { signal: lateController.signal });
  assert.equal(lateCalls, 3); assert.equal(lateController.signal.aborted, true);
  assert.deepEqual(lateResult.reasons, ['semantic_aborted']);
  pass('审核间/审核后重读版本；过期清空结果，取消/超时/服务失败停止后续请求且无重试');

  const oversizedCase = { ...REVIEW_DUAL_DATASET.find((c) => c.id === 'G05')!, id: 'ANCHOR-BUDGET', references: ['甲。'.repeat(300)] };
  const oversized = await prepareReviewDualFixture(oversizedCase), oGraph = graphFor(oversized.packet);
  const budgetResult = await run(oversized, oGraph, empty);
  assert.equal(budgetResult.calls, 2); assert.equal(budgetResult.result.modelRequests!.reference, 0);
  assert.deepEqual(budgetResult.result.channels!.reference.reasons, ['anchor_budget_exceeded']);
  assert.equal(budgetResult.result.channels!.personal.status, 'reviewed');
  const byteBudget = structuredClone(reasoning.packet); byteBudget.references[0].text = '甲'.repeat(45000);
  await assert.rejects(buildReviewAnchoredChannel(byteBudget, rGraph, 'reference'), /anchor_budget_exceeded/);
  const slotBudget = structuredClone(reasoning.packet);
  slotBudget.questionIntent.knowledgeTargets = Array.from({ length: 20 }, (_, i) => `知识${i}`);
  slotBudget.references = Array.from({ length: 7 }, (_, i) => ({ ...reasoning.packet.references[0], sourceId: `R${i + 1}` }));
  await assert.rejects(buildReviewAnchoredChannel(slotBudget, { ...rGraph, requirements: [] }, 'reference'), /anchor_budget_exceeded/);
  const emptyGraph = { ...counterGraph, claims: [], edges: [], requirements: [] };
  const emptyResult = await run(counter, emptyGraph, empty);
  assert.equal(emptyResult.calls, 1); assert.deepEqual(emptyResult.result.reasons, ['answer_claim_unobserved']);
  let compareCalls = 0;
  const splitModel = createReviewSemanticModel(async () => { compareCalls++; return { content: '{}' }; }, { comparisonProtocol: 'isolated-anchors-v3' });
  await assert.rejects(splitModel.compare({ packet: counter.packet, graph: counterGraph }), /split_protocol_requires_engine/);
  assert.equal(compareCalls, 0);
  pass('预算超限一侧无审核请求，另一侧仍可审；无主张只抽取；禁止旧compare隐式多调用');

  const sessionModel = createReviewSemanticModel(async () => { compareCalls++; return { content: '{}' }; }, { comparisonProtocol: 'isolated-anchors-v3' });
  const session = { packets: [counter.packet, counter.packet], summary: { version: 1 as const, status: 'prepared' as const,
    preparedAnswers: 2, omittedAnswers: 0, referencesAvailable: 2, cognitionTargetsResolved: 2, holdReasons: [], snapshots: [] } };
  for (const maxAnswers of [0, 2]) {
    const results = await evaluateReviewComparisonSession(session, counter.dependencies, sessionModel, { maxAnswers });
    assert.ok(results.every((r) => r.protocol === 'review-isolated-anchors-v3' && r.modelRequests?.total === 0));
    assert.equal(compareCalls, 0);
    assert.ok(results.every((r) => r.reasons.includes(maxAnswers ? 'duplicate_semantic_answer' : 'semantic_answer_budget_exceeded')));
  }
  pass('会话零预算/重复回答不请求；v3标识和实际请求计数不降回旧两阶段协议');
  console.log(`${checks} anchored-channel groups passed. These mocks do NOT measure model semantic quality.`);
} finally { globalThis.fetch = fetchBefore; }
