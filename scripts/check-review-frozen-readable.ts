import assert from 'node:assert/strict';
import { argumentContextHash } from '../src/services/argumentContext/hash.ts';
import { buildArgumentReferenceDisclosure } from '../src/services/argumentContext/referenceDisclosure.ts';
import { buildFrozenReferenceReadableInput, readFrozenReferenceReadableOutput, readableUserId,
  type FrozenReferenceReadableInput } from '../src/services/reviewComparison/frozenReferenceReadable.ts';
import { evaluateFrozenReviewReferenceShadow, type FrozenReferenceShadowInput, type FrozenReferenceShadowModel } from '../src/services/reviewComparison/frozenReferenceShadow.ts';
import type { ReviewComparisonAnswer } from '../src/services/reviewComparison/types.ts';
import { createReferenceDisclosureFixture } from './reference-disclosure-fixture.ts';

type ExtractInput = Parameters<FrozenReferenceShadowModel['extract']>[0];
interface Row {
  itemId: string; verdict: string; matches: { claimId: string; nodeId: string }[];
  edgeIds: string[]; relationIds: string[];
  axes: { object: string; metric: string; condition: string; time: string; certainty: string };
  direction: string; premises: string;
}
interface Output { version: number; evaluationId: string; contractHash: string; items: Row[] }
const axes = () => ({ object: 'match', metric: 'not_applicable', condition: 'match', time: 'not_applicable', certainty: 'match' });
const originalNodeId = (id: string) => decodeURIComponent(id.split('/').at(-1)!);
function valid(input: FrozenReferenceReadableInput): Output {
  return { version: 2, evaluationId: input.evaluationId, contractHash: input.contractHash,
    items: input.frames.flatMap(frame => frame.items.map(item => ({ itemId: item.itemId, verdict: 'supported',
      matches: item.requiredNodeIds.map(nodeId => ({ claimId: readableUserId(`A${originalNodeId(nodeId).slice(1)}`), nodeId })),
      edgeIds: item.criterionId === 'inference_link' ? [readableUserId('E1')] : [],
      relationIds: [...item.requiredRelationIds], axes: axes(),
      direction: item.criterionId === 'inference_link' ? 'correct' : 'not_required',
      premises: item.criterionId === 'inference_link' ? 'complete' : 'not_required' }))) };
}
const row = (output: Output, id: string) => output.items.find(item => item.itemId.endsWith(`/item/${id}`))!;
const network = globalThis.fetch;
globalThis.fetch = async () => assert.fail('Frozen readable checks forbid all network');
let checks = 0;
const pass = (label: string) => { checks++; console.log(`PASS ${label}`); };

/** Actual in-memory source freeze and canonical evaluator. This legacy v2
 * projection/decoder harness is deliberately independent of the current model
 * factory; its strict old protocol must not be silently repaired by new v3. */
async function rig(reasoning = false, noteCount = 1) {
  const fixture = await createReferenceDisclosureFixture({ task: reasoning ? 'reasoning' : 'definition', noteCount });
  const reply = await buildArgumentReferenceDisclosure(fixture.frozen);
  assert.ok(reply.status === 'ready');
  const receipt = { version: 1 as const, status: 'fixed' as const, originQuestionMessageId: fixture.frozen.originQuestionMessageId,
    freezeId: '12345678-1234-1234-1234-123456789abc', contractHash: fixture.frozen.contractHash,
    selectorsHash: await argumentContextHash(fixture.selectors), reasons: [] };
  const parts = fixture.paragraphs.slice(0, reasoning ? 3 : 2), text = parts.join('\r\n');
  const answer: ReviewComparisonAnswer = { activityId: 'synthetic-readable-review', questionText: reasoning ? '说明本次实际前提、供电条件和报警推断。' : '说明选择过载的核心含义和适用边界。',
    evidence: { messageId: 'synthetic-readable-answer', answer: text, hintLevel: 0, targetKnowledgeNames: [...fixture.selectors.knowledgeTargets],
      questionIntent: { version: 1, questionMessageId: fixture.selectors.questionMessageId, knowledgeTargets: [...fixture.selectors.knowledgeTargets],
        assessment: fixture.selectors.assessment, referenceRubric: fixture.selectors.referenceRubric, referenceStructure: receipt } } };
  const state: { requests: unknown[]; readable?: FrozenReferenceReadableInput; shadow?: FrozenReferenceShadowInput;
    extractor: (input: ExtractInput) => unknown; reviewer: (input: FrozenReferenceReadableInput) => unknown } = {
    requests: [],
    extractor: input => ({ version: 1, packetId: input.packetId,
      claims: parts.map((quote, index) => ({ id: `A${index + 1}`, role: reasoning ? index === 0 ? 'premise' : index === 1 ? 'conclusion' : 'condition' : index ? 'condition' : 'definition', quote })),
      edges: reasoning ? [{ id: 'E1', source: 'A1', target: 'A2', relation: 'support', quote: text }] : [], requirements: [] }),
    reviewer: valid,
  };
  const model: FrozenReferenceShadowModel = {
    extract: async input => { state.requests.push(structuredClone(input)); return state.extractor(input); },
    review: async input => {
      state.shadow = structuredClone(input);
      const readable = buildFrozenReferenceReadableInput(input);
      state.readable = structuredClone(readable); state.requests.push(structuredClone(readable));
      return readFrozenReferenceReadableOutput(state.reviewer(readable), input);
    },
  };
  const dependencies = { readReference: async () => structuredClone(reply) };
  const evaluate = () => evaluateFrozenReviewReferenceShadow(answer, dependencies, model);
  return { fixture, reply, parts, answer, state, model, evaluate };
}
async function reject(change: (output: Output, input: FrozenReferenceReadableInput) => void, reasoning = false, noteCount = 1) {
  const r = await rig(reasoning, noteCount);
  r.state.reviewer = input => { const output = valid(input); change(output, input); return output; };
  const got = await r.evaluate();
  assert.equal(got.result.status, 'held', JSON.stringify(got.result)); assert.equal(got.result.observations.length, 0);
  assert.equal(got.result.modelRequests.total, 2); assert.equal(r.state.requests.length, 2);
  return got;
}

try {
  const base = await rig(); assert.equal(base.state.requests.length, 0);
  const baseline = await base.evaluate(); assert.equal(baseline.result.status, 'reviewed', JSON.stringify(baseline.result));
  assert.equal(baseline.result.frames[0].status, 'covered'); assert.equal(base.state.requests.length, 2);
  assert.equal(base.state.readable!.version, 2); assert.equal(baseline.result.scoreWrite, 'disabled'); assert.equal(baseline.result.cognitionWrite, 'disabled');
  pass('真实题前frame→独立legacy v2 projection/decoder→旧v1门禁；两次mock且不接生产写入');

  assert.ok(base.answer.evidence.answer.includes('\r\n')); assert.ok(base.answer.evidence.answer.includes('🧠'));
  const literal = base.state.readable!;
  assert.equal(literal.user.answerText, base.answer.evidence.answer);
  assert.deepEqual(literal.user.claims.map(claim => claim.text), base.parts);
  assert.deepEqual(literal.frames[0].nodes[0].evidence.map(quote => quote.text), [base.parts[0]]);
  assert.equal(literal.frames[0].items[0].referenceText, base.parts[0]);
  assert.ok(!JSON.stringify(literal.user.claims).includes('start') && !JSON.stringify(literal.user.claims).includes('end'));
  pass('UTF-16坐标还原原话，不改写、不拆emoji，保留CRLF回答与逐字参考引文');

  const reasoning = await rig(true); assert.equal((await reasoning.evaluate()).result.status, 'reviewed');
  const reasoningInput = reasoning.state.readable!;
  assert.equal(reasoningInput.user.edges[0].id, 'user/E1');
  assert.equal(reasoningInput.frames[0].relations[0].id, 'reference/target-1/relation/E1');
  assert.equal(reasoningInput.user.edges[0].source, 'user/A1'); assert.equal(reasoningInput.user.edges[0].target, 'user/A2');
  assert.equal(reasoningInput.frames[0].groups[0].operator, 'all');
  pass('用户/参考关系同名E1不混淆，frame/node/item/relation/group完整namespace及ALL组保留');

  assert.equal(literal.taskContext.usage, 'question_context_only'); assert.equal(literal.taskContext.questionText, base.answer.questionText);
  assert.ok(!Object.hasOwn(literal.taskContext, 'claims'));
  assert.ok(!Object.hasOwn(literal.user, 'questionText'));
  assert.ok(!JSON.stringify(literal).includes('personal') && !JSON.stringify(literal).includes('profile') && !JSON.stringify(literal).includes('账户标签'));
  pass('原问题作为单独只读taskContext，不进入user证据、画像或未选中的资料');

  const borrowed = await rig(true); borrowed.answer.evidence.answer = '所以本次设备会报警。';
  borrowed.answer.questionText = '本次设备已供电，且读数超过阈值，请说明为什么会报警。';
  borrowed.state.extractor = input => ({ version: 1, packetId: input.packetId,
    claims: [{ id: 'A1', role: 'fact', quote: '本次设备已供电' }], edges: [], requirements: [] });
  const borrowedOut = await borrowed.evaluate();
  assert.equal(borrowedOut.result.status, 'held'); assert.equal(borrowedOut.result.modelRequests.total, 1); assert.equal(borrowed.state.requests.length, 1);
  pass('题设已有供电也不能抽成用户claim；不在用户回答中的引文在第一请求后hold');

  assert.equal(literal.user.edges.length, 0);
  assert.ok(baseline.result.observations.every(item => item.direction === 'not_required' && item.premises === 'not_required'));
  assert.ok(baseline.result.observations.every(item => item.edgeIds.length === 0));
  pass('完整定义与边界无需推理edges，参考条件连接仍受完整映射门禁检查');

  const unknown = await reject(output => { output.items[0].axes.condition = 'unknown'; });
  assert.deepEqual(unknown.result.reasons, ['unsubstantiated_shadow_verdict']);
  pass('supported的unknown轴不得由host升级成match');

  const different = await reject(output => { output.items[0].axes.certainty = 'different'; });
  assert.deepEqual(different.result.reasons, ['unsubstantiated_shadow_verdict']);
  pass('supported的different轴不得修复或升级');

  const badAxis = await reject(output => { output.items[0].axes.condition = 'partial'; });
  assert.deepEqual(badAxis.result.reasons, ['invalid_shadow_axes']);
  pass('partial不是合法axes枚举，不自动纠正模型字段');

  const partial = await rig(); partial.state.reviewer = input => {
    const output = valid(input); output.items[1].verdict = 'partial'; output.items[1].axes.condition = 'different'; return output;
  };
  const partialOut = await partial.evaluate(); assert.equal(partialOut.result.status, 'reviewed'); assert.equal(partialOut.result.frames[0].status, 'partial');
  assert.equal(partialOut.result.observations[1].axes.condition, 'different');
  pass('明确partial和different照原样保留，不升级、不硬拒也不当真矛盾');

  const missing = await rig(true), missingParts = [missing.parts[0], missing.parts[1]];
  missing.answer.evidence.answer = missingParts.join('\r\n');
  missing.answer.questionText = '本次设备已供电，结合读数和规则说明报警推断。';
  missing.state.extractor = input => ({ version: 1, packetId: input.packetId,
    claims: missingParts.map((quote, index) => ({ id: `A${index + 1}`, role: index ? 'conclusion' : 'premise', quote })),
    edges: [{ id: 'E1', source: 'A1', target: 'A2', relation: 'support', quote: missing.answer.evidence.answer }], requirements: [] });
  missing.state.reviewer = input => {
    const output = valid(input), condition = row(output, 'I2'), inference = row(output, 'I3');
    Object.assign(condition, { verdict: 'unverifiable', matches: [], relationIds: [], axes: { object: 'unknown', metric: 'unknown', condition: 'unknown', time: 'unknown', certainty: 'unknown' } });
    Object.assign(inference, { verdict: 'partial', matches: inference.matches.filter(pair => !pair.nodeId.endsWith('/N3')), direction: 'correct', premises: 'missing' });
    return output;
  };
  const omitted = await missing.evaluate(); assert.equal(omitted.result.status, 'reviewed', JSON.stringify(omitted.result));
  assert.equal(omitted.result.frames[0].status, 'partial'); assert.equal(omitted.result.observations[1].verdict, 'unverifiable');
  assert.deepEqual(omitted.result.observations[1].claimIds, []); assert.deepEqual(omitted.result.observations[1].nodeIds, []);
  assert.ok(!missing.state.readable!.user.claims.some(claim => claim.text.includes('供电')));
  pass('实际供电遗漏保持无配对，原问题不能填补；已有规则/结论不冒充缺失实际前提');

  const noRelation = await reject(output => { output.items[1].relationIds = []; });
  assert.deepEqual(noRelation.result.reasons, ['incomplete_shadow_structure']);
  pass('host不会自动填满必要参考关系，supported漏选关系仍hold');

  const compound = await rig(true), compoundPremise = [compound.parts[0], compound.parts[2]].join('\r\n');
  compound.answer.evidence.answer = compoundPremise + '\r\n' + compound.parts[1];
  compound.state.extractor = input => ({ version: 1, packetId: input.packetId,
    claims: [{ id: 'A1', role: 'premise', quote: compoundPremise }, { id: 'A2', role: 'conclusion', quote: compound.parts[1] }],
    edges: [{ id: 'E1', source: 'A1', target: 'A2', relation: 'support', quote: compound.answer.evidence.answer }], requirements: [] });
  compound.state.reviewer = input => {
    const output = valid(input); for (const item of output.items) for (const pair of item.matches)
      if (pair.nodeId.endsWith('/N3')) pair.claimId = 'user/A1';
    return output;
  };
  const compoundOut = await compound.evaluate(); assert.equal(compoundOut.result.status, 'reviewed', JSON.stringify(compoundOut.result));
  assert.equal(compoundOut.result.frames[0].status, 'covered');
  pass('合取用户前提可n:m映射N1/N3，仍与结论分离且必须有真实正向边');

  const crossed = await reject(output => {
    const inference = row(output, 'I3'); inference.matches.push({ claimId: 'user/A1', nodeId: 'reference/target-1/node/N2' });
  }, true);
  assert.deepEqual(crossed.result.reasons, ['incomplete_shadow_reasoning']);
  pass('同USER claim占support两端/all-to-all配对仍hold，不以简化协议绕过');

  const reversed = await rig(true), reverseExtract = reversed.state.extractor;
  reversed.state.extractor = input => {
    const graph = reverseExtract(input) as { version: number; packetId: string; claims: unknown[]; edges: { source: string; target: string }[]; requirements: unknown[] };
    graph.edges[0].source = 'A2'; graph.edges[0].target = 'A1'; return graph;
  };
  assert.deepEqual((await reversed.evaluate()).result.reasons, ['incomplete_shadow_reasoning']);
  pass('actual逆向用户边即使direction=correct也不能通过，host核真实端点');

  reversed.state.reviewer = input => { const output = valid(input), inference = row(output, 'I3');
    Object.assign(inference, { verdict: 'partial', direction: 'reverse', premises: 'complete' }); return output; };
  const reversePartial = await reversed.evaluate(); assert.equal(reversePartial.result.status, 'reviewed');
  assert.equal(reversePartial.result.frames[0].status, 'partial'); assert.equal(reversePartial.result.observations[2].direction, 'reverse');
  pass('逆推可显式partial且不等于事实反证，不污染其他正确前提');

  const premiseOnly = await reject(output => {
    const inference = row(output, 'I3'); Object.assign(inference, { verdict: 'contradicted', matches: [{ claimId: 'user/A1', nodeId: 'reference/target-1/node/N1' }],
      edgeIds: [], relationIds: [], direction: 'not_required', premises: 'not_required' });
  }, true);
  assert.deepEqual(premiseOnly.result.reasons, ['unsubstantiated_shadow_verdict']);
  pass('推理contradicted只配未变前提不能通过，必须映射实际相反结论');

  const counterexample = await rig(true), counterParts = [counterexample.parts[0], '本次合成设备并没有报警。', counterexample.parts[2]];
  counterexample.answer.evidence.answer = counterParts.join('\r\n');
  counterexample.state.extractor = input => ({ version: 1, packetId: input.packetId,
    claims: counterParts.map((quote, index) => ({ id: `A${index + 1}`, role: index === 1 ? 'counterexample' : 'fact', quote })), edges: [], requirements: [] });
  counterexample.state.reviewer = input => {
    const output = valid(input); Object.assign(row(output, 'I3'), { verdict: 'contradicted', matches: [{ claimId: 'user/A2', nodeId: 'reference/target-1/node/N2' }],
      edgeIds: [], relationIds: [], direction: 'not_required', premises: 'not_required' }); return output;
  };
  const counterOut = await counterexample.evaluate(); assert.equal(counterOut.result.status, 'reviewed', JSON.stringify(counterOut.result));
  assert.equal(counterOut.result.frames[0].status, 'contradicted'); assert.equal(counterOut.result.semanticTruth, 'not_certified');
  pass('明确相反实际结果可无推理edge，但host仍不声称认证语义真值');

  const crossFrame = await reject(output => { output.items[2].matches[0].nodeId = 'reference/target-1/node/N1'; }, false, 2);
  assert.deepEqual(crossFrame.result.reasons, ['invalid_readable_evidence']);
  pass('F2不能借F1同名N1，namespace回译仍严格按本item/本frame');

  const outOfItem = await reject(output => { output.items[0].matches[0].nodeId = 'reference/target-1/node/N2'; });
  assert.deepEqual(outOfItem.result.reasons, ['invalid_readable_evidence']);
  pass('同frame也不能借本item未授权节点');

  for (const change of [
    (output: Output) => { output.items[0].edgeIds = ['reference/target-1/relation/E1']; },
    (output: Output) => { output.items[1].relationIds = ['user/E1']; },
    (output: Output) => { output.items[0].matches[0].claimId = 'reference/target-1/node/N1'; },
    (output: Output) => { output.items[0].relationIds = ['reference/target-1/relation/E1']; },
  ]) assert.deepEqual((await reject(change)).result.reasons, ['invalid_readable_evidence']);
  pass('USER/reference ID混用和本item未授权关系均hold，不自动清理字段');

  for (const itemId of ['I1', 'I2']) {
    const unusedEdge = await reject(output => { row(output, itemId).edgeIds = ['user/E1']; }, true);
    assert.deepEqual(unusedEdge.result.reasons, ['invalid_readable_evidence']);
  }
  pass('普通实际前提项不借合法但非必需USER edge作为证据；inference_link选边契约独立');

  for (const change of [
    (output: Output) => { output.version = 1; },
    (output: Output) => { Object.assign(output, { score: 100 }); },
    (output: Output) => { Object.assign(output.items[0], { frameId: 'target-1' }); },
    (output: Output) => { Object.assign(output.items[0].matches[0], { quote: '额外原话' }); },
  ]) assert.deepEqual((await reject(change)).result.reasons, ['invalid_readable_output']);
  pass('v1及root/item/pair extra字段不自动接受，没有兼容修复或第二轮重试');

  for (const change of [
    (output: Output) => { output.items.pop(); },
    (output: Output) => { output.items[1] = structuredClone(output.items[0]); },
    (output: Output) => { delete output.items[1]; },
    (output: Output) => { output.items[0].matches.push(structuredClone(output.items[0].matches[0])); },
  ]) { const got = await reject(change); assert.ok(got.result.reasons[0].startsWith('invalid_readable_')); }
  pass('每个原item恰好一次；缺项/重复/稀疏/null/重复配对不靠host补齐');

  const huge = structuredClone(base.state.shadow!);
  huge.reference.quotes[0].text = '本题冻结参考原文。'.repeat(3500);
  huge.reference.quotes[0].end = huge.reference.quotes[0].start + huge.reference.quotes[0].text.length;
  assert.ok(JSON.stringify(huge).length < 60000);
  assert.throws(() => buildFrozenReferenceReadableInput(huge), /readable_context_budget_exceeded/u);
  assert.equal(huge.reference.quotes[0].text.length, '本题冻结参考原文。'.length * 3500);
  pass('完整可读视图超过whole budget即hold；旧紧凑input未超限也不截断原文/节点/关系');

  const budgetRig = await rig(), fixedMockContext = structuredClone(budgetRig.reply.context);
  fixedMockContext.quotes[0].text = huge.reference.quotes[0].text;
  fixedMockContext.quotes[0].end = fixedMockContext.quotes[0].start + fixedMockContext.quotes[0].text.length;
  // A stable synthetic read dependency, not a claim that this modified DTO is
  // an authenticated production publication. This isolates evaluator accounting.
  const canonical = { ...structuredClone(base.state.shadow!), reference: fixedMockContext };
  assert.ok(JSON.stringify(canonical).length < 60000);
  const budgetOut = await evaluateFrozenReviewReferenceShadow(budgetRig.answer,
    { readReference: async () => ({ status: 'ready', context: structuredClone(fixedMockContext) }) }, budgetRig.model);
  assert.deepEqual(budgetOut.result.reasons, ['readable_context_budget_exceeded']);
  assert.deepEqual(budgetOut.result.modelRequests, { extract: 1, reference: 0, total: 1, limit: 2 });
  assert.equal(budgetRig.state.requests.length, 1); assert.equal(budgetRig.state.readable, undefined);
  assert.equal(budgetOut.result.observations.length, 0);
  pass('evaluator在第二请求计数前拒绝超限readable；canonical未超限也不裁剪、无reference调用');

  const brokenStart = structuredClone(base.state.shadow!), emoji = brokenStart.answer.text.indexOf('🧠');
  brokenStart.graph.claims[0].start = emoji + 1;
  assert.throws(() => buildFrozenReferenceReadableInput(brokenStart), /invalid_readable_context/u);
  const brokenEnd = structuredClone(base.state.shadow!); brokenEnd.graph.claims[0].end = emoji + 1;
  assert.throws(() => buildFrozenReferenceReadableInput(brokenEnd), /invalid_readable_context/u);
  pass('不接受在UTF-16代理对中间切开的恢复坐标，也不替它猜另一段引文');

  const absentQuote = structuredClone(base.state.shadow!); absentQuote.reference.frames[0].nodes[0].quoteIds = ['missing'];
  assert.throws(() => buildFrozenReferenceReadableInput(absentQuote), /invalid_readable_context/u);
  const emptyQuote = structuredClone(base.state.shadow!); emptyQuote.reference.frames[0].nodes[0].quoteIds = [];
  assert.throws(() => buildFrozenReferenceReadableInput(emptyQuote), /invalid_readable_context/u);
  pass('必要节点引文缺失即hold，不能输出空证据节点或悄悄删除节点');

  const decoded = readFrozenReferenceReadableOutput(valid(reasoningInput), reasoning.state.shadow!);
  const inference = decoded.items.find(item => item.itemId === 'I3')!;
  assert.ok(inference.claimIds.includes('A1') && inference.claimIds.includes('A2'));
  assert.deepEqual(inference.nodeMappings, [{ claimId: 'A1', nodeId: 'N1' }, { claimId: 'A2', nodeId: 'N2' }, { claimId: 'A3', nodeId: 'N3' }]);
  assert.equal(inference.verdict, 'supported'); assert.equal(inference.axes.condition, 'match');
  const edgeOnly = valid(reasoningInput); row(edgeOnly, 'I3').matches = [];
  const edgeDecoded = readFrozenReferenceReadableOutput(edgeOnly, reasoning.state.shadow!).items.find(item => item.itemId === 'I3')!;
  assert.deepEqual(edgeDecoded.claimIds, ['A1', 'A2']); assert.deepEqual(edgeDecoded.nodeIds, []);
  pass('选已知edge只推导已知两端USER ID，不推导参考配对、必要节点或语义结论');

  const tooLongQuestion = structuredClone(base.state.shadow!); tooLongQuestion.taskContext.questionText = '问'.repeat(4001);
  assert.throws(() => buildFrozenReferenceReadableInput(tooLongQuestion), /invalid_readable_context/u);
  assert.equal(tooLongQuestion.taskContext.questionText.length, 4001);
  pass('taskContext超4000原字符拒绝，不截断后改变题意');

  console.log(`Frozen readable checks passed: ${checks} synthetic groups; no network, production writes or real-model accuracy claim.`);
} finally { globalThis.fetch = network; }
