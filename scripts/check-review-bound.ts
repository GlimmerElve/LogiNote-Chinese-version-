import assert from 'node:assert/strict';
import { REVIEW_DUAL_DATASET, type ReviewDualCase } from './review-dual-dataset';
import { prepareReviewDualFixture } from './review-dual-fixture';
import { validateReviewDualBoundRequest, validateReviewDualReplayInput } from './review-dual-transport';
import { buildReviewBoundInput, readReviewBoundComparison, type ReviewBoundInput } from '../src/services/reviewComparison/boundProtocol';
import { REVIEW_BOUND_ALIGNMENT_PROMPT, REVIEW_BOUND_EXAMPLE } from '../src/services/reviewComparison/boundPrompts';
import { createReviewSemanticModel } from '../src/services/reviewComparison/semanticClient';
import { evaluateReviewComparisonPacket } from '../src/services/reviewComparison/semanticEvaluator';
import { readReviewPerformanceGraph } from '../src/services/reviewComparison/performanceGraph';
import { validateReviewAlignments } from '../src/services/reviewComparison/semanticValidation';
import { buildReviewMasteryShadow } from '../src/services/reviewComparison/semanticOutputs';
import type { ReviewComparisonPacket } from '../src/services/reviewComparison/types';
import type { ReviewPerformanceGraph } from '../src/services/reviewComparison/semanticTypes';

const fetchBefore = globalThis.fetch;
globalThis.fetch = async () => assert.fail('No network allowed in bound-protocol checks');
let checks = 0;
const pass = (name: string) => { checks++; console.log(`PASS ${name}`); };
const fixture = (id: string) => prepareReviewDualFixture(REVIEW_DUAL_DATASET.find((c) => c.id === id)!);
const na = { status: 'not_applicable', personalQuote: '', documentQuote: '', reason: '命题不涉及该维度' };
const same = (left: string, right = left) => ({ status: 'same', personalQuote: left, documentQuote: right, reason: '测试中给定同一维度' });
function graphFor(packet: ReviewComparisonPacket, layer: 'concept' | 'judgment' | 'reasoning' = 'judgment') {
  return readReviewPerformanceGraph({ version: 1, packetId: packet.packetId,
    claims: [{ id: 'A1', role: 'fact', quote: packet.answer.text }], edges: [],
    requirements: [{ knowledgeTarget: packet.questionIntent.knowledgeTargets[0], layer, quote: packet.questionText }] }, packet);
}
const empty = (input: ReviewBoundInput) => ({ version: 2, bindingId: input.bindingId,
  referenceAudit: { status: 'compatible', sourceIds: input.references.map((s) => s.sourceId) }, alignments: [], edgeChecks: [], personalLinks: [] });
function pair(input: ReviewBoundInput, corpus: 'personal' | 'reference', claimId: string, sourceQuote: string, axes: unknown,
  relation = 'consistent', relationBasis?: unknown) {
  return { pairId: input.alignmentSlots.find((s) => s.corpus === corpus && s.claimId === claimId)!.pairId,
    sourceQuote, confidence: 0.95, sourcesCompatible: true, relation, axes, ...(relationBasis ? { relationBasis } : {}) };
}
async function run(f: Awaited<ReturnType<typeof fixture>>, graph: ReviewPerformanceGraph, response: (input: ReviewBoundInput) => unknown) {
  let calls = 0;
  const before = JSON.stringify(f.packet), sourcesBefore = f.sourceFingerprint;
  const result = await evaluateReviewComparisonPacket(f.packet, f.dependencies, createReviewSemanticModel(async (request) => {
    const input = await validateReviewDualBoundRequest(request, ++calls, f.packet, graph);
    validateReviewDualReplayInput(request, structuredClone(request));
    if (calls === 2) {
      const tampered = { ...request, userInput: JSON.stringify({ ...input, bindingId: 'wrong-binding' }) };
      await assert.rejects(validateReviewDualBoundRequest(tampered, calls, f.packet, graph));
      assert.throws(() => validateReviewDualReplayInput(request, tampered), /replay_input_changed/);
    }
    assert.ok(!request.userInput.includes('"expected"') && !request.userInput.includes('"rationale"'));
    return { content: JSON.stringify(calls === 1 ? graph : response(input)) };
  }, { comparisonProtocol: 'bound-v2' }));
  assert.equal(JSON.stringify(f.packet), before); assert.equal(f.sourceFingerprint, sourcesBefore);
  assert.equal(result.writes, 'disabled'); assert.ok(result.mastery.every((m) => m.scoreWrite === 'disabled'));
  assert.ok(result.growth.proposals.every((p) => p.preserveOriginal && p.status === 'pending_confirmation'));
  return { result, calls };
}

try {
  for (const c of REVIEW_DUAL_DATASET) {
    const f = await prepareReviewDualFixture(c), graph = graphFor(f.packet);
    const binding = await buildReviewBoundInput(f.packet, graph);
    assert.deepEqual(binding, await buildReviewBoundInput(f.packet, graph));
    assert.deepEqual(binding.references.map((s) => s.text), c.references);
    assert.equal(binding.alignmentSlots.length, (c.personal ? 1 : 0) + c.references.length);
    assert.equal(binding.linkSlots.length, c.personal ? 1 : 0);
    assert.ok(binding.alignmentSlots.every((s) => s.corpus === 'reference' ? s.knowledgeTarget === c.topic : !Object.hasOwn(s, 'knowledgeTarget')));
    assert.equal(binding.personal.status, c.personal ? 'ready' : 'not_requested');
    const { calls, result } = await run(f, graph, empty);
    assert.equal(calls, 2); assert.ok(!result.reasons.includes('semantic_model_unavailable'));
  }
  pass('28个原合成样本：两阶段真实适配器mock、稳定坐标、标签隔离、零网络零写入');

  const x = await fixture('X02'), xGraph = graphFor(x.packet), binding = await buildReviewBoundInput(x.packet, xGraph);
  const xAxes = { object: same('闸门甲'), condition: same('条件B'), time: same('本次'), baseline: na,
    metric: { ...same('状态'), status: 'same_dimension' } };
  const xItem = pair(binding, 'reference', 'A1', x.packet.references[0].text, xAxes, 'contradiction', {
    kind: 'incompatible_facts', personalQuote: '开启状态', documentQuote: '关闭状态', explanation: '同次观测的状态取值互斥' });
  const xResponse = { ...empty(binding), alignments: [xItem] };
  const decoded = await readReviewBoundComparison(xResponse, x.packet, xGraph);
  assert.equal(decoded.alignments[0].personalQuote, xGraph.claims[0].quote);
  assert.equal(decoded.alignments[0].axes.metric.status, 'same');
  assert.equal(validateReviewAlignments(decoded, x.packet, xGraph)[0].accepted, true);
  const correct = await run(x, xGraph, () => xResponse);
  assert.equal(correct.result.mastery[0].layers.judgment.status, 'contradicted');
  const dimensionWrong = structuredClone(xResponse); dimensionWrong.alignments[0].axes = { ...xAxes, metric: { ...xAxes.metric, status: 'different_dimension' } };
  const rejected = await run(x, xGraph, () => dimensionWrong);
  assert.equal(rejected.result.mastery[0].layers.judgment.status, 'unassessed');
  assert.equal(rejected.result.alignments[0].code, 'relation_axis_mismatch');
  pass('同指标相反取值可构成已核对事实冲突；different_dimension不会被程序静默改正');

  // Real failure shape: the model copied old-belief opposition onto an identical answer/reference pair.
  const counter = await fixture('G05'), counterGraph = graphFor(counter.packet);
  const counterInput = await buildReviewBoundInput(counter.packet, counterGraph);
  const counterQuote = counter.packet.answer.text, oldQuote = counter.packet.personal.graph!.nodes[0].text;
  assert.equal(counterQuote, counter.packet.references[0].text);
  const counterAxes = { object: same('设备甲'), condition: same('条件B'), time: na, baseline: na,
    metric: { ...same('产生结果C', '没有产生结果C'), status: 'same_dimension' } };
  const personalCounter = pair(counterInput, 'personal', 'A1', oldQuote, counterAxes, 'contradiction', {
    kind: 'observed_counterexample', personalQuote: oldQuote, documentQuote: counterQuote, explanation: '新观测反驳旧必然性观点' });
  const identicalAxes = { ...counterAxes, metric: { ...same('没有产生结果C'), status: 'same_dimension' } };
  for (const relation of ['contradiction', 'certainty_change']) {
    const mistakenReference = pair(counterInput, 'reference', 'A1', counterQuote, identicalAxes, relation, {
      kind: relation === 'contradiction' ? 'observed_counterexample' : 'evidence_limit',
      personalQuote: counterQuote, documentQuote: counterQuote, explanation: '误将旧认知关系污染参考关系' });
    // Contradiction passes the old grounded gate; certainty may already fail its stricter lexical gate.
    const outcome = await run(counter, counterGraph, () => ({ ...empty(counterInput), alignments: [personalCounter, mistakenReference] }));
    assert.equal(outcome.result.growth.proposals[0].operation, 'review_conflict');
    assert.equal(outcome.result.mastery[0].layers.judgment.status, 'unassessed');
    assert.equal(outcome.result.mastery[0].layers.judgment.observations.length, 0);
    if (relation === 'contradiction') assert.ok(outcome.result.alignments.some((a) => a.code === 'identical_reference_not_conflict'));
  }
  const correctChannels = await run(counter, counterGraph, () => ({ ...empty(counterInput), alignments: [personalCounter,
    pair(counterInput, 'reference', 'A1', counterQuote, identicalAxes)] }));
  assert.equal(correctChannels.result.growth.proposals[0].operation, 'review_conflict');
  assert.equal(correctChannels.result.mastery[0].layers.judgment.status, 'supported');
  // Identity of a SHORT phrase is not sufficient: preserve a real different-value comparison above.
  assert.equal(correct.result.mastery[0].layers.judgment.status, 'contradicted');
  const legacyComparison = await readReviewBoundComparison({ ...empty(counterInput), alignments: [personalCounter,
    pair(counterInput, 'reference', 'A1', counterQuote, identicalAxes, 'contradiction', {
      kind: 'observed_counterexample', personalQuote: counterQuote, documentQuote: counterQuote, explanation: '旧认知冲突误用作评分冲突' })] }, counter.packet, counterGraph);
  const legacyResult = await evaluateReviewComparisonPacket(counter.packet, counter.dependencies,
    { extract: async () => counterGraph, compare: async () => legacyComparison });
  assert.equal(legacyResult.mastery[0].layers.judgment.status, 'unassessed');
  pass('整段回答与参考完全相同不能生成负向证据；个人真实冲突仍保留，v1/v2共用保护且不自动加分');

  for (const mutate of [
    (v: any) => { v.packetId = x.packet.packetId; },
    (v: any) => { v.alignments[0].knowledgeTarget = x.packet.questionIntent.knowledgeTargets[0]; },
    (v: any) => { v.alignments[0].claimId = 'A1'; },
    (v: any) => { v.alignments[0].personalQuote = '模型代写的用户原话'; },
    (v: any) => { v.alignments[0].axes.relationBasis = v.alignments[0].relationBasis; delete v.alignments[0].relationBasis; },
    (v: any) => { v.alignments[0].axes.metric.status = 'same'; },
    (v: any) => { v.alignments[0].axes.metric.reason = ''; },
    (v: any) => { v.writes = 'enabled'; },
  ]) {
    const raw = structuredClone(xResponse); mutate(raw);
    await assert.rejects(readReviewBoundComparison(raw, x.packet, xGraph), /invalid_bound_format/);
  }
  const unknown = structuredClone(xResponse); unknown.alignments[0].pairId = 'P999';
  await assert.rejects(readReviewBoundComparison(unknown, x.packet, xGraph), /unknown_bound_slot/);
  const duplicate = structuredClone(xResponse); duplicate.alignments.push(duplicate.alignments[0]);
  await assert.rejects(readReviewBoundComparison(duplicate, x.packet, xGraph), /duplicate_bound_slot/);
  const malformed = await run(x, xGraph, () => ({ ...xResponse, score: 100 }));
  assert.deepEqual(malformed.result.reasons, ['invalid_bound_format']); assert.equal(malformed.calls, 2);
  pass('禁止模型重写坐标/用户主引文/写入字段；错层、旧指标枚举、未知及重复slot均拒绝且不重试');

  const changedGraph = structuredClone(xGraph); changedGraph.claims[0].role = 'definition';
  await assert.rejects(readReviewBoundComparison(xResponse, x.packet, changedGraph), /wrong_bound_binding/);
  const changedPacket = structuredClone(x.packet); changedPacket.references[0].version.updatedAt = '2026-10-07';
  await assert.rejects(readReviewBoundComparison(xResponse, changedPacket, xGraph), /wrong_bound_binding/);
  const changedBody = structuredClone(x.packet); changedBody.references[0].text += ' 后续限定。';
  await assert.rejects(readReviewBoundComparison(xResponse, changedBody, xGraph), /wrong_bound_binding/);
  const wrongQuote = structuredClone(xResponse); wrongQuote.alignments[0].sourceQuote = '不存在于资料的引文';
  const ungrounded = await run(x, xGraph, () => wrongQuote);
  assert.equal(ungrounded.result.alignments[0].code, 'ungrounded_quote');
  pass('绑定实际正文、版本及抽取图；更换图/同hash改资料均失效，来源引文仍由原准入门校验');

  const contextual = await fixture('G03'), cGraph = graphFor(contextual.packet);
  const cInput = await buildReviewBoundInput(contextual.packet, cGraph);
  const cAxes = { object: same('设备甲'), condition: { ...same('条件B', '条件E'), status: 'different' }, time: na,
    metric: { ...same('结果C'), status: 'same_dimension' }, baseline: na };
  const contextResult = await run(contextual, cGraph, () => ({ ...empty(cInput), alignments: [
    pair(cInput, 'personal', 'A1', contextual.packet.personal.graph!.nodes[0].text, cAxes, 'condition_difference') ] }));
  assert.equal(contextResult.result.growth.proposals[0].operation, 'contextual');
  assert.equal(contextResult.result.growth.proposals[0].alignment.documentQuote, cGraph.claims[0].quote);
  assert.equal(contextResult.result.growth.proposals[0].preserveOriginal, true);
  assert.equal(contextResult.result.mastery[0].layers.judgment.status, 'unassessed');
  pass('不同条件下相反结果形成待确认并存候选，保留旧C；个人一致性不代替参考掌握证据');

  const reasoning = await fixture('G06');
  const [premise, conclusion] = ['本次设备甲的指标P超过阈值T。', '本次设备甲报警。'];
  const rGraph = readReviewPerformanceGraph({ version: 1, packetId: reasoning.packet.packetId,
    claims: [{ id: 'A1', role: 'premise', quote: premise }, { id: 'A2', role: 'conclusion', quote: conclusion }],
    edges: [{ id: 'E1', source: 'A1', target: 'A2', relation: 'support', quote: reasoning.packet.answer.text }],
    requirements: [{ knowledgeTarget: reasoning.packet.questionIntent.knowledgeTargets[0], layer: 'reasoning', quote: reasoning.packet.questionText }] }, reasoning.packet);
  const rInput = await buildReviewBoundInput(reasoning.packet, rGraph);
  const rAxes = { object: same('设备甲'), condition: na, time: same('本次'), baseline: na,
    metric: { ...same('报警'), status: 'same_dimension' } };
  const pAxes = { ...rAxes, metric: { ...same('指标P'), status: 'same_dimension' } };
  const rResponse = { ...empty(rInput), alignments: [pair(rInput, 'reference', 'A1', premise, pAxes), pair(rInput, 'reference', 'A2', conclusion, rAxes)],
    edgeChecks: [{ slotId: rInput.edgeSlots[0].slotId, referenceQuote: reasoning.packet.references[0].text,
      relation: 'support', verdict: 'supported', direction: 'source_to_target', basis: 'source', conclusion: 'target', premiseStatus: 'sufficient', confidence: 0.95 }] };
  const verified = await run(reasoning, rGraph, () => rResponse);
  assert.equal(verified.result.mastery[0].layers.reasoning.status, 'supported');
  const noPremise = { ...rResponse, alignments: rResponse.alignments.slice(1) };
  const missing = await run(reasoning, rGraph, () => noPremise);
  assert.equal(missing.result.mastery[0].layers.reasoning.status, 'unassessed');
  const reverse = structuredClone(rResponse); reverse.edgeChecks[0].basis = 'target'; reverse.edgeChecks[0].conclusion = 'source';
  const reversed = await run(reasoning, rGraph, () => reverse);
  assert.equal(reversed.result.mastery[0].layers.reasoning.status, 'unassessed');
  pass('推理slot仅绑定两端；漏掉实际前提或角色与方向矛盾时不能通过推理核验');

  const growthAxes = { ...rAxes, metric: { ...same('指标P', '报警'), status: 'different_dimension' } };
  const growthResponse = { ...rResponse, alignments: [...rResponse.alignments,
    pair(rInput, 'personal', 'A2', premise, growthAxes, 'supplement')], personalLinks: [
    { slotId: rInput.linkSlots.find((s) => s.claimId === 'A2')!.slotId, answerQuote: conclusion, personalQuote: premise,
      relation: 'support', direction: 'personal_to_answer', basis: 'personal', conclusion: 'answer', premiseStatus: 'sufficient', confidence: 0.95 } ] };
  const grown = await run(reasoning, rGraph, () => growthResponse);
  assert.equal(grown.result.growth.proposals[0].operation, 'supplement');
  assert.equal(grown.result.growth.proposals[0].link!.direction, 'personal_to_answer');
  const linkWrong = { ...structuredClone(growthResponse), personalLinks: [
    { ...growthResponse.personalLinks[0], targetNodeId: 'new-node' } ] };
  await assert.rejects(readReviewBoundComparison(linkWrong, reasoning.packet, rGraph), /invalid_bound_format/);
  pass('个人前提到新结论可形成有方向的待确认补充；link不能写入模型指定的其他节点');

  const noReference = await fixture('B05'), nGraph = graphFor(noReference.packet), nInput = await buildReviewBoundInput(noReference.packet, nGraph);
  assert.equal(nInput.edgeSlots.length, 0); assert.ok(nInput.alignmentSlots.every((s) => s.corpus === 'personal'));
  const nResult = await run(noReference, nGraph, () => ({ ...empty(nInput), alignments: [pair(nInput, 'personal', 'A1', noReference.packet.personal.graph!.nodes[0].text,
    { object: same('设备甲'), condition: same('条件B'), time: na, baseline: na,
      metric: { ...same('结果C', '结果D'), status: 'different_dimension' } }, 'supplement')] }));
  assert.equal(nResult.result.growth.status, 'proposed'); assert.equal(nResult.result.mastery[0].layers.judgment.status, 'unassessed');
  const stale = await fixture('G01');
  const originalLoad = stale.dependencies.loadCognition;
  stale.dependencies.loadCognition = async () => { const file = await originalLoad(); file.records[0].revisions[0].branches[0].graph.nodes[0].text += '已修改'; return file; };
  let staleCalls = 0;
  const staleResult = await evaluateReviewComparisonPacket(stale.packet, stale.dependencies, createReviewSemanticModel(async () => { staleCalls++; return { content: '{}' }; }, { comparisonProtocol: 'bound-v2' }));
  assert.equal(staleCalls, 0); assert.equal(staleResult.status, 'held');
  pass('无参考仍可个人补充但不能评分；旧节点已改则原新鲜度门在调用前阻止全部模型请求');

  const budgetPacket = structuredClone(reasoning.packet);
  budgetPacket.questionIntent.knowledgeTargets = Array.from({ length: 20 }, (_, i) => `知识${i}`);
  budgetPacket.references = Array.from({ length: 7 }, (_, i) => ({ ...reasoning.packet.references[0], sourceId: `R${i + 1}` }));
  const budgetGraph = { ...rGraph, requirements: [] };
  await assert.rejects(buildReviewBoundInput(budgetPacket, budgetGraph), /semantic_binding_budget_exceeded/);
  let compareCalls = 0;
  await assert.rejects(createReviewSemanticModel(async () => { compareCalls++; return { content: '{}' }; }, { comparisonProtocol: 'bound-v2' })
    .compare({ packet: budgetPacket, graph: budgetGraph }), /semantic_binding_budget_exceeded/);
  assert.equal(compareCalls, 0);
  const bigText = structuredClone(reasoning.packet); bigText.references[0].text = '甲'.repeat(90001);
  await assert.rejects(buildReviewBoundInput(bigText, rGraph), /semantic_binding_budget_exceeded/);
  pass('配对数和输入字符超预算直接held，不静默截取配对、不调用比较服务');

  const multi: ReviewDualCase = { ...REVIEW_DUAL_DATASET.find((c) => c.id === 'G06')!, id: 'BOUND-MULTI', references: [reasoning.packet.references[0].text, reasoning.packet.references[0].text] };
  const multiFixture = await prepareReviewDualFixture(multi), multiGraph = { ...rGraph, packetId: multiFixture.packet.packetId };
  const multiInput = await buildReviewBoundInput(multiFixture.packet, multiGraph);
  const duplicatedEdge = { ...empty(multiInput), edgeChecks: multiInput.edgeSlots.map((s) => ({ ...rResponse.edgeChecks[0], slotId: s.slotId })) };
  await assert.rejects(readReviewBoundComparison(duplicatedEdge, multiFixture.packet, multiGraph), /invalid_edge_check/);
  const auditWrong = { ...empty(multiInput), referenceAudit: { status: 'compatible', sourceIds: ['R1'] } };
  await assert.rejects(readReviewBoundComparison(auditWrong, multiFixture.packet, multiGraph), /incomplete_reference_audit/);
  const truncated = structuredClone(x.packet); truncated.references[0].truncated = true;
  const tInput = await buildReviewBoundInput(truncated, xGraph);
  const tComparison = await readReviewBoundComparison({ ...xResponse, bindingId: tInput.bindingId }, truncated, xGraph);
  assert.equal(buildReviewMasteryShadow(truncated, xGraph, tComparison, validateReviewAlignments(tComparison, truncated, xGraph))[0].status, 'held');
  pass('多source slot不放宽同一edge唯一性；资料审计必须覆盖全量；截断仍不准入');

  const hinted = await fixture('B04'), hGraph = graphFor(hinted.packet), hInput = await buildReviewBoundInput(hinted.packet, hGraph);
  const commonAxes = { object: same('设备甲'), condition: same('条件B'), time: na, baseline: na,
    metric: { ...same('结果C'), status: 'same_dimension' } };
  const hResult = await run(hinted, hGraph, () => ({ ...empty(hInput), alignments: [pair(hInput, 'reference', 'A1', hinted.packet.references[0].text, commonAxes)] }));
  assert.equal(hResult.result.mastery[0].layers.judgment.status, 'unassessed');
  const repeated = await fixture('B06'), repeatGraph = graphFor(repeated.packet, 'reasoning'), repeatInput = await buildReviewBoundInput(repeated.packet, repeatGraph);
  const repeatResult = await run(repeated, repeatGraph, () => ({ ...empty(repeatInput), alignments: [
    pair(repeatInput, 'personal', 'A1', repeated.packet.personal.graph!.nodes[0].text, commonAxes)] }));
  assert.equal(repeatResult.result.growth.status, 'no_change');
  pass('强提示正确复述不变成独立掌握；已有原话纯重述不因slot存在而生长');

  assert.deepEqual(JSON.parse(JSON.stringify(REVIEW_BOUND_EXAMPLE)), REVIEW_BOUND_EXAMPLE);
  assert.ok(REVIEW_BOUND_ALIGNMENT_PROMPT.includes(JSON.stringify(REVIEW_BOUND_EXAMPLE)));
  console.log(`${checks} bound-protocol groups passed. Model semantic quality is NOT measured by these mocks.`);
} finally { globalThis.fetch = fetchBefore; }
