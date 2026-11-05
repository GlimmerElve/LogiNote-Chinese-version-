import assert from 'node:assert/strict';
import { createReferenceDisclosureFixture } from './reference-disclosure-fixture.ts';
import { buildArgumentReferenceDisclosure } from '../src/services/argumentContext/referenceDisclosure.ts';
import { argumentContextHash } from '../src/services/argumentContext/hash.ts';
import { createFrozenReferenceShadowModel, FROZEN_REFERENCE_SHADOW_PROMPT } from '../src/services/reviewComparison/frozenReferenceModel.ts';
import { evaluateFrozenReviewReferenceShadow, type FrozenReferenceShadowInput, type FrozenReferenceShadowModel } from '../src/services/reviewComparison/frozenReferenceShadow.ts';
import { buildFrozenReferenceTypedInput, readFrozenReferenceTypedOutput, buildFrozenReferenceTypedInputV4,
  readFrozenReferenceTypedOutputV4, type FrozenReferenceTypedInput, type FrozenReferenceTypedInputV4 } from '../src/services/reviewComparison/frozenReferenceTyped.ts';
import { buildFrozenReferenceReadableInput } from '../src/services/reviewComparison/frozenReferenceReadable.ts';
import type { ReviewComparisonAnswer } from '../src/services/reviewComparison/types.ts';
import type { LlmCallRequest } from '../src/types.ts';

const oldFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('Typed protocol checks forbid network');
let checks = 0;
const pass = (label: string) => { checks++; console.log(`PASS ${label}`); };
const last = (id: string) => decodeURIComponent(id.split('/').at(-1)!);
function valid(input: FrozenReferenceTypedInput | FrozenReferenceTypedInputV4): any {
  return { version: input.version, evaluationId: input.evaluationId, contractHash: input.contractHash,
    items: input.frames.flatMap(frame => frame.items.map(item => ({ itemId: item.itemId, verdict: 'supported', scope: 'same',
      matches: item.requiredNodeIds.map(nodeId => {
        const node = frame.nodes.find(node => node.id === nodeId)!;
        return { claimId: `user/A${last(nodeId).slice(1)}`, nodeId,
          referenceQuoteId: node.evidence[0].quoteId, referenceQuote: node.evidence[0].text };
      }), opposition: null,
      ...(item.evidenceMode === 'inference' ? { edgeIds: input.user.edges.map(edge => edge.id), direction: 'correct', premises: 'complete' } : {}) }))) };
}
async function rig(reasoning = false, noteCount = 1) {
  const fixture = await createReferenceDisclosureFixture({ task: reasoning ? 'reasoning' : 'definition', noteCount });
  const reply = await buildArgumentReferenceDisclosure(fixture.frozen);
  assert.ok(reply.status === 'ready');
  const parts = fixture.paragraphs.slice(0, reasoning ? 3 : 2), text = parts.join('\r\n');
  const answer: ReviewComparisonAnswer = { activityId: 'typed-protocol-synthetic', questionText: reasoning ? '说明本次前提、条件及报警推理。' : '说明概念及条件。',
    evidence: { messageId: 'typed-answer', answer: text, hintLevel: 0, targetKnowledgeNames: fixture.selectors.knowledgeTargets,
      questionIntent: { version: 1, questionMessageId: fixture.selectors.questionMessageId,
        knowledgeTargets: fixture.selectors.knowledgeTargets, assessment: fixture.selectors.assessment, referenceRubric: fixture.selectors.referenceRubric,
        referenceStructure: { version: 1, status: 'fixed', originQuestionMessageId: fixture.frozen.originQuestionMessageId,
          freezeId: '12345678-1234-1234-1234-123456789abc', contractHash: fixture.frozen.contractHash,
          selectorsHash: await argumentContextHash(fixture.selectors), reasons: [] } } } };
  const state: { calls: LlmCallRequest[]; input?: FrozenReferenceTypedInputV4;
    extract: (input: Parameters<FrozenReferenceShadowModel['extract']>[0]) => any; review: (input: FrozenReferenceTypedInputV4) => any } = {
    calls: [], extract: input => ({ version: 1, packetId: input.packetId,
      claims: parts.map((quote, index) => ({ id: `A${index + 1}`, role: reasoning ? index === 0 ? 'fact' : index === 1 ? 'conclusion' : 'condition' : index ? 'condition' : 'definition', quote })),
      edges: reasoning ? [{ id: 'E1', source: 'A1', target: 'A2', relation: 'support', quote: text }] : [], requirements: [] }), review: valid };
  const model = createFrozenReferenceShadowModel(async request => {
    state.calls.push(structuredClone(request));
    assert.equal(request.skipMemoryInjection, true); assert.equal(request.skipProfileInjection, true);
    assert.equal(request.thinkingMode, 'disabled');
    const input = JSON.parse(request.userInput);
    if (input.version === 4) { state.input = input; return { content: JSON.stringify(state.review(input)), provider: 'mock', model: 'mock' }; }
    return { content: JSON.stringify(state.extract(input)), provider: 'mock', model: 'mock' };
  });
  const deps = { readReference: async () => structuredClone(reply) };
  return { fixture, reply, parts, text, answer, state, model, deps,
    evaluate: () => evaluateFrozenReviewReferenceShadow(answer, deps, model) };
}
const inference = (output: any) => output.items.find((item: any) => item.itemId.endsWith('/I3'));
async function rejects(change: (output: any, input: FrozenReferenceTypedInputV4) => void, reasoning = false, code?: string, field?: string) {
  const r = await rig(reasoning);
  r.state.review = input => { const output = valid(input); change(output, input); return output; };
  const got = await r.evaluate();
  assert.equal(got.result.status, 'held', JSON.stringify(got.result)); assert.equal(got.result.observations.length, 0);
  assert.equal(got.result.modelRequests.total, 2); assert.equal(r.state.calls.length, 2);
  if (code) assert.deepEqual(got.result.reasons, [code]);
  if (field) assert.equal(got.result.diagnostics?.[0]?.field, field);
  return got;
}
try {
  const base = await rig(); assert.equal(base.state.calls.length, 0); assert.equal(base.model.protocol, 'typed-v4');
  const got = await base.evaluate(); assert.equal(got.result.status, 'reviewed', JSON.stringify(got));
  assert.equal(got.result.frames[0].status, 'covered'); assert.equal(got.result.scoreWrite, 'disabled'); assert.equal(got.result.cognitionWrite, 'disabled');
  const input = base.state.input!;
  assert.equal(input.user.answerText, base.text); assert.deepEqual(input.user.edges, []);
  assert.ok(input.frames[0].items.every(item => item.evidenceMode === 'statement'));
  assert.ok(!Object.hasOwn(valid(input).items[0], 'direction'));
  pass('真实合成题前frame→显式typed-v4 factory→严格v1门禁；零默认请求及生产写入');

  const omitEmpty = await rig();
  omitEmpty.state.review = input => { const out = valid(input); for (const row of out.items) delete row.opposition; return out; };
  assert.equal((await omitEmpty.evaluate()).result.status, 'reviewed');
  const omitInferenceEmpty = await rig(true);
  omitInferenceEmpty.state.review = input => { const out = valid(input); for (const row of out.items) delete row.opposition; return out; };
  assert.equal((await omitInferenceEmpty.evaluate()).result.status, 'reviewed');
  pass('v4非矛盾可省略opposition或显式null，statement/inference均不因空字段误拒');

  assert.equal(input.frames[0].nodes[0].evidence[0].text, base.parts[0]);
  assert.deepEqual(input.user.claims.map(claim => claim.text), base.parts);
  assert.deepEqual(input.taskContext, { questionText: base.answer.questionText, usage: 'question_context_only', taskType: 'definition' });
  pass('CRLF/emoji原话及完整参考上下文保留；题干不进入USER证据');

  for (const extra of ['axes', 'edgeIds', 'relationIds', 'direction', 'premises', 'score'])
    await rejects(output => { output.items[0][extra] = extra === 'axes' ? {} : []; }, false, 'invalid_typed_output', 'item');
  pass('普通项不接受推理字段、旧axes、关系选择或自评分，不静默删除');
  for (const scope of ['different', 'unknown']) await rejects(output => { output.items[0].scope = scope; }, false, 'unsubstantiated_shadow_verdict', 'scope');
  for (const scope of ['not_applicable', 'partial', null]) await rejects(output => { output.items[0].scope = scope; }, false, 'invalid_typed_scope', 'scope');
  pass('supported必须显式核对同范围，未知/不同/旧不适用绝不升级');
  for (const field of ['scope', 'matches', 'verdict', 'itemId']) await rejects(output => { delete output.items[0][field]; });
  for (const field of ['edgeIds', 'direction', 'premises']) await rejects(output => { delete inference(output)[field]; }, true);
  pass('仅非矛盾空见证可省略；scope/matches/verdict/itemId及推理断言缺失不填默认');

  const partial = await rig(); partial.state.review = input => {
    const out = valid(input); Object.assign(out.items[1], { verdict: 'partial', scope: 'unknown', matches: [] }); return out;
  };
  const partialOut = await partial.evaluate(); assert.equal(partialOut.result.status, 'reviewed'); assert.equal(partialOut.result.frames[0].status, 'partial');
  assert.equal(partialOut.result.observations[1].axes.condition, 'unknown');
  pass('遗漏是partial且范围未知照实保留，不当矛盾或整体合格');

  await rejects(output => { output.items[0].matches = []; }, false, 'unsubstantiated_shadow_verdict', 'structure');
  pass('必要节点映射不能因supported标签或host固定关系义务被补齐');
  await rejects(output => { output.items[0].matches[0].referenceQuoteId = 'Q999'; }, false, 'invalid_reference_node_anchor', 'matches');
  await rejects(output => { output.items[0].matches[0].referenceQuote = '用户没有说过或参考没有出现的句子'; }, false, 'invalid_reference_node_anchor', 'matches');
  pass('每个配对必须指向所选节点既有Q中的唯一连续命题锚点');
  await rejects(output => { output.items[0].matches[0].nodeId = 'reference/target-1/node/N2'; }, false, 'invalid_typed_evidence', 'matches');
  await rejects(output => { output.items[0].matches.push(output.items[0].matches[0]); }, false, 'invalid_typed_evidence', 'matches');
  await rejects(output => { output.items[0].matches[0].claimId = 'reference/target-1/node/N1'; }, false, 'invalid_typed_evidence', 'matches');
  pass('本item外节点、重复配对及USER/reference混用仍严格拒绝');
  await rejects(output => { output.items[0].matches[0].nodeId = 'reference/target-2/node/N1'; }, false, 'invalid_typed_evidence');
  pass('不同frame同名节点不能借证');

  const reasoned = await rig(true); const reasonedOut = await reasoned.evaluate();
  assert.equal(reasonedOut.result.status, 'reviewed', JSON.stringify(reasonedOut));
  assert.equal(reasonedOut.result.frames[0].status, 'covered');
  assert.ok(reasoned.state.input!.frames[0].items.some(item => item.evidenceMode === 'inference'));
  assert.equal(reasoned.state.input!.user.edges.length, 1);
  pass('推理项独立保留真实边、同方向配对及ALL条件，不给普通实际前提项增加边要求');
  await rejects(output => { inference(output).matches = inference(output).matches.filter((pair: any) => !pair.nodeId.endsWith('/N3')); }, true, 'incomplete_shadow_structure');
  await rejects(output => { inference(output).edgeIds = []; }, true, 'incomplete_shadow_reasoning');
  await rejects(output => { inference(output).direction = 'reverse'; }, true, 'incomplete_shadow_structure');
  pass('缺供电节点、缺实际边和显式reverse不得supported');
  await rejects(output => { inference(output).matches.find((pair: any) => pair.nodeId.endsWith('/N2')).claimId = 'user/A3'; }, true, 'reference_role_mismatch', 'matches');
  pass('适用条件不得冒充参考结论，原文位置真实也不等于职责正确');
  for (const role of ['premise', 'definition', 'condition']) {
    const roleRig = await rig(true), originalExtract = roleRig.state.extract;
    roleRig.state.extract = input => { const graph = originalExtract(input); graph.claims[0].role = role; return graph; };
    const roleOut = await roleRig.evaluate();
    assert.deepEqual(roleOut.result.reasons, ['reference_role_mismatch']);
    assert.equal(roleOut.result.diagnostics?.[0].field, 'matches');
  }
  const counterexample = await rig(true), counterExtract = counterexample.state.extract;
  counterexample.state.extract = input => { const graph = counterExtract(input); graph.claims[0].role = 'counterexample'; return graph; };
  assert.equal((await counterexample.evaluate()).result.status, 'reviewed');
  pass('v4明确组内实际fact允许具体fact/counterexample/conclusion；一般规则及定义不能冒充已发生前提');
  for (const replayEarlierProof of [false, true]) {
    const chain = await rig(true), priorFact = '本次合成设备测得的读数为11，阈值为10。';
    chain.answer.evidence.answer = (replayEarlierProof ? priorFact + '\r\n因此，' : '') + chain.parts.join('\r\n');
    chain.state.extract = input => ({ version: 1, packetId: input.packetId,
      claims: [
        ...(replayEarlierProof ? [{ id: 'A4', role: 'fact', quote: priorFact }] : []),
        { id: 'A1', role: 'conclusion', quote: chain.parts[0] },
        { id: 'A2', role: 'conclusion', quote: chain.parts[1] },
        { id: 'A3', role: 'condition', quote: chain.parts[2] },
      ], edges: [
        ...(replayEarlierProof ? [{ id: 'E2', source: 'A4', target: 'A1', relation: 'support', quote: priorFact + '\r\n因此，' + chain.parts[0] }] : []),
        { id: 'E1', source: 'A1', target: 'A2', relation: 'support', quote: chain.parts.join('\r\n') },
      ], requirements: [] });
    chain.state.review = input => { const out = valid(input); inference(out).edgeIds = ['user/E1']; return out; };
    const chainOut = await chain.evaluate();
    assert.equal(chainOut.result.status, 'reviewed', JSON.stringify(chainOut));
    assert.equal(chainOut.result.frames[0].status, 'covered');
    assert.equal(chainOut.graph?.claims.find(claim => claim.id === 'A1')?.role, 'conclusion');
    assert.deepEqual(chainOut.result.observations.find(row => row.itemId === 'I3')?.edgeIds, ['E1']);
    assert.ok(chainOut.graph?.edges.some(edge => edge.source === 'A1' && edge.target === 'A2'));
    assert.equal(chainOut.graph?.edges.some(edge => edge.target === 'A1'), replayEarlierProof);
  }
  pass('前一具体结论可成为后续推理实际前提；真实两级连线保留，旧证明可重述也可不重述');
  const ordinaryFact = await rig(true), ordinaryExtract = ordinaryFact.state.extract;
  ordinaryFact.state.extract = input => { const graph = ordinaryExtract(input); graph.claims[0].role = 'premise'; return graph; };
  ordinaryFact.state.review = input => {
    const out = valid(input); Object.assign(inference(out), { verdict: 'partial', scope: 'unknown', matches: [],
      edgeIds: [], direction: 'undetermined', premises: 'missing' }); return out;
  };
  const ordinaryOut = await ordinaryFact.evaluate();
  assert.equal(ordinaryOut.result.status, 'reviewed'); assert.equal(ordinaryOut.result.observations[0].verdict, 'supported');
  pass('新职责门槛不扩到普通事实statement或partial，不因角色给整段评分');

  const reversed = await rig(true); const oldExtract = reversed.state.extract;
  reversed.state.extract = input => { const graph = oldExtract(input); graph.edges[0].source = 'A2'; graph.edges[0].target = 'A1'; return graph; };
  const reversedOut = await reversed.evaluate(); assert.deepEqual(reversedOut.result.reasons, ['incomplete_shadow_reasoning']);
  assert.equal(reversedOut.result.diagnostics?.[0].field, 'structure');
  pass('不能用correct标签把真实逆向边伪装成正向推断，输出安全item/field诊断');

  const compound = await rig(true), combined = compound.parts[0] + compound.parts[2];
  compound.answer.evidence.answer = combined + compound.parts[1];
  compound.state.extract = input => ({ version: 1, packetId: input.packetId,
    claims: [{ id: 'A1', role: 'fact', quote: combined }, { id: 'A2', role: 'conclusion', quote: compound.parts[1] }],
    edges: [{ id: 'E1', source: 'A1', target: 'A2', relation: 'support', quote: compound.answer.evidence.answer }], requirements: [] });
  compound.state.review = input => { const out = valid(input); for (const row of out.items) for (const pair of row.matches)
    if (pair.nodeId.endsWith('/N3')) pair.claimId = 'user/A1'; return out; };
  assert.equal((await compound.evaluate()).result.status, 'reviewed');
  pass('合取复合前提仍可n:m映射事实及条件，不全局强制一对一');

  const crossed = await rig(true), crossedExtract = crossed.state.extract;
  crossed.state.extract = input => { const graph = crossedExtract(input); graph.claims[0].role = 'fact'; return graph; };
  crossed.state.review = input => { const out = valid(input); inference(out).matches.find((pair: any) => pair.nodeId.endsWith('/N2')).claimId = 'user/A1'; return out; };
  assert.deepEqual((await crossed.evaluate()).result.reasons, ['incomplete_shadow_reasoning']);
  pass('同一主张即使被标fact也不能交叉冒充推理理由和结论两端');

  await rejects(output => { output.items[0].verdict = 'contradicted'; }, false, 'invalid_typed_output', 'opposition');
  await rejects(output => { output.items[0].verdict = 'contradicted'; delete output.items[0].opposition; }, false, 'invalid_typed_output', 'item');
  await rejects(output => { output.items[0].opposition = {}; }, false, 'invalid_opposition_witness', 'opposition');
  for (const opposition of [false, 0, 'null', []]) await rejects(output => { output.items[0].opposition = opposition; }, false, 'invalid_opposition_witness', 'opposition');
  pass('矛盾必须提供明确结果见证，非矛盾不夹带冲突见证');

  // Independent failure witness: same outcome is NOT opposite, even when a
  // model calls an invalid reverse proof "contradicted". No historical response
  // is rewritten/reinterpreted as a new model result.
  await rejects((output, input) => {
    const row = inference(output), frame = input.frames[0], node = frame.nodes.find(node => node.id.endsWith('/N2'))!;
    const quote = '本次合成设备会报警';
    const pair = { claimId: 'user/A2', nodeId: node.id, referenceQuoteId: node.evidence[0].quoteId, referenceQuote: quote };
    Object.assign(row, { verdict: 'contradicted', scope: 'same', matches: [pair], edgeIds: [], direction: 'not_required', premises: 'not_required',
      opposition: { ...pair, userOutcome: '会报警', referenceOutcome: '会报警' } });
  }, true, 'invalid_opposition_witness', 'opposition');
  pass('报警对报警即使模型判contradicted也被拒绝，不把逆推失败当反证');

  const opposite = await rig(true);
  const oppositeParts = [...opposite.parts]; oppositeParts[1] = '本次合成设备不会报警。';
  opposite.answer.evidence.answer = oppositeParts.join('\r\n');
  opposite.state.extract = input => ({ version: 1, packetId: input.packetId,
    claims: oppositeParts.map((quote, i) => ({ id: `A${i + 1}`, role: i === 0 ? 'premise' : i === 1 ? 'fact' : 'condition', quote })), edges: [], requirements: [] });
  opposite.state.review = input => {
    const out = valid(input), row = inference(out), node = input.frames[0].nodes.find(node => node.id.endsWith('/N2'))!;
    const pair = { claimId: 'user/A2', nodeId: node.id, referenceQuoteId: node.evidence[0].quoteId, referenceQuote: '本次合成设备会报警' };
    Object.assign(row, { verdict: 'contradicted', scope: 'same', matches: [pair], edgeIds: [], direction: 'not_required', premises: 'not_required',
      opposition: { ...pair, userOutcome: '不会报警', referenceOutcome: '会报警' } }); return out;
  };
  const oppositeOut = await opposite.evaluate(); assert.equal(oppositeOut.result.status, 'reviewed', JSON.stringify(oppositeOut));
  assert.equal(oppositeOut.result.frames[0].status, 'contradicted'); assert.equal(oppositeOut.result.semanticTruth, 'not_certified');
  pass('同范围实际相反结果可无证明边入审，但仅模型语义结论不是宿主事实认证');
  const actualOppositeExtract = opposite.state.extract;
  opposite.state.extract = input => { const graph = actualOppositeExtract(input); graph.claims[1].role = 'premise'; return graph; };
  assert.equal((await opposite.evaluate()).result.status, 'reviewed');
  pass('实际相反结果作为后续推理前提也可入审，不仅凭抽取role标签硬拒反证');
  const reviewOpposite = opposite.state.review;
  opposite.state.review = input => { const out = reviewOpposite(input); inference(out).opposition.userOutcome = '用户从未说过的相反结果'; return out; };
  assert.deepEqual((await opposite.evaluate()).result.reasons, ['invalid_opposition_witness']);
  pass('相反结果不能补造原话、借另一节点或空见证');
  opposite.state.review = input => { const out = reviewOpposite(input); inference(out).direction = 'reverse'; return out; };
  assert.deepEqual((await opposite.evaluate()).result.reasons, ['unsubstantiated_shadow_verdict']);
  opposite.state.review = input => { const out = reviewOpposite(input); inference(out).scope = 'different'; return out; };
  assert.deepEqual((await opposite.evaluate()).result.reasons, ['unsubstantiated_shadow_verdict']);
  pass('即使有不同字面结果，逆推/不同范围也不能作为真实矛盾通过');

  for (const change of [(out: any) => { out.items.pop(); }, (out: any) => { out.items[1] = out.items[0]; },
    (out: any) => { out.version = 2; }, (out: any) => { out.version = 3; }, (out: any) => { out.items[0].matches[0].extra = true; }]) await rejects(change);
  pass('缺项/重复项/旧v2-v3/extra字段整体暂缓，没有回退解析或自动重试');

  // Build only a synthetic local canonical input to verify host preflight
  // budgets separately from the first extraction request.
  const canonical: FrozenReferenceShadowInput = { version: 1, protocol: 'review-frozen-reference-shadow-v1', evaluationId: `frozen-reference:${'a'.repeat(64)}`,
    answer: { text: base.text, hintLevel: 0, consultedMaterialCount: 0 }, taskContext: { questionText: base.answer.questionText, usage: 'question_context_only' },
    graph: { claims: base.parts.map((quote, index) => ({ id: `A${index + 1}`, role: index ? 'condition' : 'definition',
      start: base.text.indexOf(quote), end: base.text.indexOf(quote) + quote.length })), edges: [] }, reference: structuredClone(base.reply.context) };
  const readable = buildFrozenReferenceTypedInput(canonical);
  const canonicalOutput = valid(readable); canonicalOutput.items.forEach((row: any) => { row.verdict = 'unverifiable'; row.scope = 'unknown'; row.matches = []; });
  assert.equal(readFrozenReferenceTypedOutput(canonicalOutput, canonical).version, 1);
  const legacyMissing = structuredClone(canonicalOutput); delete legacyMissing.items[0].opposition;
  assert.throws(() => readFrozenReferenceTypedOutput(legacyMissing, canonical), /invalid_typed_output/u);
  const current = buildFrozenReferenceTypedInputV4(canonical), currentOutput = valid(current);
  assert.equal(readFrozenReferenceTypedOutputV4(currentOutput, canonical).version, 1);
  assert.throws(() => readFrozenReferenceTypedOutputV4(canonicalOutput, canonical), /invalid_typed_output/u);
  assert.throws(() => readFrozenReferenceTypedOutput(currentOutput, canonical), /invalid_typed_output/u);
  for (const row of currentOutput.items) delete row.opposition;
  assert.equal(readFrozenReferenceTypedOutputV4(currentOutput, canonical).version, 1);
  for (const invalidValue of [undefined, {}, false, 'null']) {
    const invalidOutput = structuredClone(currentOutput); invalidOutput.items[0].opposition = invalidValue;
    assert.throws(() => readFrozenReferenceTypedOutputV4(invalidOutput, canonical), /invalid_opposition_witness/u);
  }
  pass('纯v3仍严格要求null且拒v4，v4拒历史v3，不修复旧响应或混版回退');

  const legacy = await rig(true), legacyExtract = legacy.state.extract;
  const legacyModel: FrozenReferenceShadowModel = { protocol: 'typed-v3',
    extract: async input => { const graph = legacyExtract(input); graph.claims[0].role = 'premise'; return graph; },
    review: async input => valid(buildFrozenReferenceTypedInput(input)) };
  assert.equal((await evaluateFrozenReviewReferenceShadow(legacy.answer, legacy.deps, legacyModel)).result.status, 'reviewed');
  pass('显式v3 model保留既有角色门禁与严格legacy解码，不自动套入v4职责新规则');
  canonical.taskContext.questionText = '问'.repeat(4001); assert.throws(() => buildFrozenReferenceTypedInput(canonical));
  pass('typed视图仍拒绝任务超预算，不截断题干');
  canonical.taskContext.questionText = base.answer.questionText;
  const plainSize = JSON.stringify(buildFrozenReferenceReadableInput(canonical)).length;
  const quote = canonical.reference.quotes[0];
  quote.text = '例'.repeat(Math.floor((59900 - plainSize) / 2) + quote.text.length);
  quote.end = quote.start + quote.text.length;
  assert.ok(JSON.stringify(buildFrozenReferenceReadableInput(canonical)).length < 60000);
  assert.throws(() => buildFrozenReferenceTypedInput(canonical), /typed_context_budget_exceeded/u);
  const budgetRig = await rig();
  // Stable synthetic read DTO ONLY, not a real-vault admission/authentication
  // assertion. This isolates pre-request budget accounting.
  const largeContext = structuredClone(canonical.reference);
  const budgetOut = await evaluateFrozenReviewReferenceShadow(budgetRig.answer,
    { readReference: async () => ({ status: 'ready', context: structuredClone(largeContext) }) }, budgetRig.model);
  assert.deepEqual(budgetOut.result.reasons, ['typed_context_budget_exceeded']);
  assert.deepEqual(budgetOut.result.modelRequests, { extract: 1, reference: 0, total: 1, limit: 2 });
  assert.equal(budgetRig.state.calls.length, 1); assert.equal(budgetRig.state.input, undefined);
  pass('v2仍在预算但typed新增义务使整包超限时，第二请求为0，不裁剪或虚报费用');
  assert.ok(FROZEN_REFERENCE_SHADOW_PROMPT.includes('supported明确断言') && FROZEN_REFERENCE_SHADOW_PROMPT.includes('同范围明确相反结果'));
  assert.ok(FROZEN_REFERENCE_SHADOW_PROMPT.includes('statement只输出'));
  assert.ok(FROZEN_REFERENCE_SHADOW_PROMPT.includes('version:4') && FROZEN_REFERENCE_SHADOW_PROMPT.includes('可省略opposition或填null'));
  assert.ok(FROZEN_REFERENCE_SHADOW_PROMPT.includes('组premiseNodeIds里的fact须配用户本次fact/counterexample或已明确表述的本次派生具体结果conclusion')
    && FROZEN_REFERENCE_SHADOW_PROMPT.includes('真正相反的实际结果可作为后续推理premise'));
  pass('提示显式分工、条件范围和关系含义义务，没有把程序坐标验证冒充语义能力');
  console.log(`Typed frozen checks: ${checks} synthetic groups; no cloud, real-vault, production writes or model accuracy claim.`);
} finally { globalThis.fetch = oldFetch; }
