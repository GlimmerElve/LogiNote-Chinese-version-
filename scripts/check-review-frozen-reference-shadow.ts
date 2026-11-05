import assert from 'node:assert/strict';
import { createReferenceDisclosureFixture } from './reference-disclosure-fixture.ts';
import { buildArgumentReferenceDisclosure } from '../src/services/argumentContext/referenceDisclosure.ts';
import { argumentContextHash } from '../src/services/argumentContext/hash.ts';
import { evaluateFrozenReviewReferenceShadow, type FrozenReferenceShadowInput, type FrozenReferenceShadowModel } from '../src/services/reviewComparison/frozenReferenceShadow.ts';
import { createFrozenReferenceShadowModel } from '../src/services/reviewComparison/frozenReferenceModel.ts';
import type { ReviewComparisonAnswer } from '../src/services/reviewComparison/types.ts';

const oldFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('Synthetic shadow checks forbid network');
let checks = 0;
const pass = (label: string) => { checks++; console.log(`PASS ${label}`); };
async function rig(reasoning = false, noteCount = 1) {
  const fixture = await createReferenceDisclosureFixture({ task: reasoning ? 'reasoning' : 'definition', noteCount });
  const reply = await buildArgumentReferenceDisclosure(fixture.frozen);
  assert.equal(reply.status, 'ready'); assert.ok(reply.status === 'ready');
  const receipt = { version: 1 as const, status: 'fixed' as const, originQuestionMessageId: fixture.frozen.originQuestionMessageId,
    freezeId: '12345678-1234-1234-1234-123456789abc', contractHash: fixture.frozen.contractHash,
    selectorsHash: await argumentContextHash(fixture.selectors), reasons: [] };
  const text = fixture.paragraphs.slice(0, reasoning ? 3 : 2).join('');
  const input: ReviewComparisonAnswer = { activityId: 'synthetic-shadow-review', questionText: reasoning ? '说明实际前提、适用条件和报警推断。' : '说明合成选择过载的核心含义与适用边界。',
    evidence: { messageId: 'synthetic-user-answer', answer: text, hintLevel: 0, targetKnowledgeNames: [...fixture.selectors.knowledgeTargets],
      questionIntent: { version: 1, questionMessageId: fixture.selectors.questionMessageId, knowledgeTargets: [...fixture.selectors.knowledgeTargets],
        assessment: fixture.selectors.assessment, referenceRubric: fixture.selectors.referenceRubric, referenceStructure: receipt } } };
  const requests: unknown[] = []; let reads = 0;
  const model: FrozenReferenceShadowModel = {
    extract: async value => {
      requests.push(structuredClone(value));
      const claims = fixture.paragraphs.slice(0, reasoning ? 3 : 2).map((quote, i) => ({ id: `A${i + 1}`, role: reasoning ? i === 0 ? 'premise' : i === 1 ? 'conclusion' : 'condition' : i === 0 ? 'definition' : 'condition', quote }));
      return { version: 1, packetId: value.packetId, claims, edges: reasoning ? [{ id: 'E1', source: 'A1', target: 'A2', relation: 'support', quote: text }] : [], requirements: [] };
    },
    review: async value => { requests.push(structuredClone(value)); return valid(value); },
  };
  const deps = { readReference: async () => { reads++; return structuredClone(reply); } };
  return { fixture, input, model, deps, reply, requests, reads: () => reads };
}
function valid(input: FrozenReferenceShadowInput) {
  return { version: 1, evaluationId: input.evaluationId, contractHash: input.reference.contractHash,
    items: input.reference.frames.flatMap(frame => frame.items.map(item => ({ frameId: frame.frameId, itemId: item.itemId, verdict: 'supported',
      claimIds: input.graph.claims.map(claim => claim.id), edgeIds: item.criterionId === 'inference_link' ? input.graph.edges.map(edge => edge.id) : [],
      nodeIds: [...item.nodeIds], relationIds: [...item.relationIds],
      nodeMappings: item.criterionId === 'inference_link' ? item.nodeIds.map(nodeId => ({ claimId: `A${nodeId.slice(1)}`, nodeId })) : [],
      axes: { object: 'match', metric: 'not_applicable', condition: 'match', time: 'not_applicable', certainty: 'match' },
      direction: item.criterionId === 'inference_link' ? 'correct' : 'not_required', premises: item.criterionId === 'inference_link' ? 'complete' : 'not_required' }))) };
}
try {
  const r = await rig();
  const out = await evaluateFrozenReviewReferenceShadow(r.input, r.deps, r.model);
  assert.equal(out.result.status, 'reviewed', JSON.stringify(out)); assert.equal(out.result.frames[0].status, 'covered');
  assert.deepEqual(out.result.modelRequests, { extract: 1, reference: 1, total: 2, limit: 2 }); assert.equal(r.reads(), 3);
  assert.equal(out.result.scoreWrite, 'disabled'); assert.equal(out.result.cognitionWrite, 'disabled');
  pass('真实合成题前frame→去重必需结构→一次抽取一次核对→题后原frame回核，只有shadow无分数写入');

  const extractWire = JSON.stringify(r.requests[0]), reviewWire = JSON.stringify(r.requests[1]);
  assert.ok(!Object.hasOwn(r.requests[0] as object, 'reference') && !extractWire.includes('cognitionTarget'));
  assert.ok(!reviewWire.includes('personal') && !reviewWire.includes('profile') && !reviewWire.includes('账户标签') && !reviewWire.includes('用于举例说明'));
  const sent = r.requests[1] as FrozenReferenceShadowInput;
  assert.ok(!('quote' in sent.graph.claims[0])); assert.equal(sent.answer.text, r.input.evidence.answer);
  assert.equal(sent.reference.quotes.length, 2); assert.equal(sent.reference.frames[0].relations[0].kind, 'requires_condition');
  pass('评分请求不带画像/历史认知/整篇笔记；回答仅一份，保留N1/N2/E1必要条件与引文');

  const withPersonal = structuredClone(r.input);
  withPersonal.evidence.questionIntent.cognitionTarget = { recordId: 'private-record', revisionId: 'private-revision', branchId: 'private-branch', nodeId: 'private-node', purpose: 'give_example' };
  const r2 = await rig(); await evaluateFrozenReviewReferenceShadow(withPersonal, r2.deps, r2.model);
  assert.deepEqual(r2.requests, r.requests);
  pass('相同答前参考和回答下，改个人坐标不改变reference通道实际请求或指纹');

  const assisted = await rig(); assisted.input.evidence.hintLevel = 4;
  assert.equal((await evaluateFrozenReviewReferenceShadow(assisted.input, assisted.deps, assisted.model)).result.evidence, 'assisted_not_independent');
  assisted.input.evidence.hintLevel = 0; assisted.input.evidence.consultedMaterialIds = ['synthetic-material'];
  assert.equal((await evaluateFrozenReviewReferenceShadow(assisted.input, assisted.deps, assisted.model)).result.evidence, 'assisted_not_independent');
  pass('强提示/查阅后覆盖参考不冒充独立掌握');

  const unfixed = await rig(); unfixed.input.evidence.questionIntent.referenceStructure!.status = 'held';
  const held = await evaluateFrozenReviewReferenceShadow(unfixed.input, unfixed.deps, unfixed.model);
  assert.equal(held.result.status, 'held'); assert.equal(held.result.modelRequests.total, 0);
  pass('无fixed题前凭据零模型调用，不答后补标准');

  const empty = await rig(); empty.model.extract = async value => ({ version: 1, packetId: value.packetId, claims: [], edges: [], requirements: [] });
  const emptyOut = await evaluateFrozenReviewReferenceShadow(empty.input, empty.deps, empty.model);
  assert.deepEqual(emptyOut.result.reasons, ['no_user_claims']); assert.equal(emptyOut.result.modelRequests.total, 1);
  pass('没有用户原话主张不消费第二请求/不借参考生成主张');

  for (const change of [
    (v: ReturnType<typeof valid>) => { v.items.pop(); },
    (v: ReturnType<typeof valid>) => { v.items[0].claimIds = ['A99']; },
    (v: ReturnType<typeof valid>) => { v.items[0].nodeIds = []; },
    (v: ReturnType<typeof valid>) => { v.items[0].axes.condition = 'unknown'; },
    (v: ReturnType<typeof valid>) => { v.items[0].axes.certainty = 'not_applicable'; },
    (v: ReturnType<typeof valid>) => { v.items[1].direction = 'reverse'; },
    (v: ReturnType<typeof valid>) => { v.items[1].premises = 'missing'; },
    (v: ReturnType<typeof valid>) => { (v as unknown as { score: number }).score = 100; },
  ]) {
    const broken = await rig(); broken.model.review = async input => { const v = valid(input); change(v); return v; };
    const got = await evaluateFrozenReviewReferenceShadow(broken.input, broken.deps, broken.model);
    assert.equal(got.result.status, 'held'); assert.equal(got.result.modelRequests.total, 2); assert.equal(got.result.observations.length, 0);
  }
  pass('漏项/借证/未知条件/未核确定程度/模型自评分均hold，无修复重试或部分通过');

  const reasoning = await rig(true);
  const reasoned = await evaluateFrozenReviewReferenceShadow(reasoning.input, reasoning.deps, reasoning.model);
  assert.equal(reasoned.result.status, 'reviewed', JSON.stringify(reasoned));
  const reasoningWire = reasoning.requests[1] as FrozenReferenceShadowInput;
  assert.equal(reasoningWire.reference.frames[0].groups[0].operator, 'all');
  for (const direction of ['reverse', 'undetermined']) {
    const reversed = await rig(true); reversed.model.review = async input => { const v = valid(input); v.items.find(i => i.itemId === input.reference.frames[0].items.find(item => item.criterionId === 'inference_link')!.itemId)!.direction = direction; return v; };
    assert.equal((await evaluateFrozenReviewReferenceShadow(reversed.input, reversed.deps, reversed.model)).result.status, 'held');
  }
  pass('推理保留完整ALL必要组；没有正确方向不能以supported通过');
  const fakeDirection = await rig(true); fakeDirection.model.review = async input => {
    const v = valid(input), inference = v.items.find(item => item.nodeMappings.length)!;
    inference.nodeMappings[0].claimId = 'A2'; inference.nodeMappings[1].claimId = 'A1'; return v;
  };
  const faked = await evaluateFrozenReviewReferenceShadow(fakeDirection.input, fakeDirection.deps, fakeDirection.model);
  assert.deepEqual(faked.result.reasons, ['incomplete_shadow_reasoning']);
  pass('不能用correct标签掩盖端点反配；程序核对参考边与用户显式边的同向映射');

  for (const reverseActualEdge of [false, true]) {
    const crossed = await rig(true), extract = crossed.model.extract;
    if (reverseActualEdge) crossed.model.extract = async (...args) => {
      const graph = await extract(...args) as { edges: { source: string; target: string }[] };
      return { ...graph, edges: graph.edges.map(edge => ({ ...edge, source: 'A2', target: 'A1' })) };
    };
    crossed.model.review = async input => {
      const v = valid(input), inference = v.items.find(item => item.nodeMappings.length)!;
      inference.nodeMappings = [{ claimId: 'A1', nodeId: 'N1' }, { claimId: 'A1', nodeId: 'N2' },
        { claimId: 'A2', nodeId: 'N1' }, { claimId: 'A2', nodeId: 'N2' }, { claimId: 'A3', nodeId: 'N3' }];
      return v;
    };
    const crossedOut = await evaluateFrozenReviewReferenceShadow(crossed.input, crossed.deps, crossed.model);
    assert.deepEqual(crossedOut.result.reasons, ['incomplete_shadow_reasoning']);
    assert.equal(crossedOut.result.observations.length, 0); assert.equal(crossedOut.result.modelRequests.total, 2);
  }
  pass('同claim交叉占据同条参考关系两端必须hold，真实反向边也不能靠all-to-all配对通过');

  const compound = await rig(true), compoundPremise = [compound.fixture.paragraphs[0], compound.fixture.paragraphs[2]].join('');
  compound.input.evidence.answer = compoundPremise + compound.fixture.paragraphs[1];
  compound.model.extract = async input => ({ version: 1, packetId: input.packetId,
    claims: [{ id: 'A1', role: 'premise', quote: compoundPremise }, { id: 'A2', role: 'conclusion', quote: compound.fixture.paragraphs[1] }],
    edges: [{ id: 'E1', source: 'A1', target: 'A2', relation: 'support', quote: compound.input.evidence.answer }], requirements: [] });
  compound.model.review = async input => {
    const v = valid(input), inference = v.items.find(item => item.nodeMappings.length)!;
    inference.nodeMappings = [{ claimId: 'A1', nodeId: 'N1' }, { claimId: 'A1', nodeId: 'N3' }, { claimId: 'A2', nodeId: 'N2' }];
    return v;
  };
  assert.equal((await evaluateFrozenReviewReferenceShadow(compound.input, compound.deps, compound.model)).result.status, 'reviewed');
  pass('合取的复合前提仍可映射多个前提/条件节点，不全局强制一对一或降低完整条件门槛');

  for (const mode of ['premise_only', 'no_mapping', 'ambiguous_endpoints', 'reverse', 'undetermined', 'missing'] as const) {
    const counter = await rig(true);
    counter.model.review = async input => {
      const v = valid(input), inference = v.items.find(item => item.nodeMappings.length)!;
      Object.assign(inference, { verdict: 'contradicted', claimIds: mode === 'premise_only' ? ['A1'] : ['A2'], edgeIds: [],
        nodeIds: mode === 'premise_only' ? ['N1'] : mode === 'ambiguous_endpoints' ? ['N1', 'N2'] : ['N2'], relationIds: [],
        nodeMappings: mode === 'premise_only' ? [{ claimId: 'A1', nodeId: 'N1' }]
          : mode === 'no_mapping' ? [] : mode === 'ambiguous_endpoints' ? [{ claimId: 'A2', nodeId: 'N1' }, { claimId: 'A2', nodeId: 'N2' }]
            : [{ claimId: 'A2', nodeId: 'N2' }],
        direction: mode === 'reverse' || mode === 'undetermined' ? mode : 'not_required', premises: mode === 'missing' ? 'missing' : 'not_required' });
      return v;
    };
    const rejected = await evaluateFrozenReviewReferenceShadow(counter.input, counter.deps, counter.model);
    assert.deepEqual(rejected.result.reasons, ['unsubstantiated_shadow_verdict']); assert.equal(rejected.result.observations.length, 0);
  }
  pass('推理矛盾必须有冻结结论的明确映射，未变前提/空配对/两端混淆/逆推/缺前提不是相反结果');

  for (const role of ['counterexample', 'premise'] as const) {
    const observed = await rig(true), pieces = [observed.fixture.paragraphs[0], '本次合成设备并没有报警。', '本次合成设备已经供电。'];
    observed.input.evidence.answer = pieces.join('');
    observed.model.extract = async input => ({ version: 1, packetId: input.packetId,
      claims: pieces.map((quote, index) => ({ id: `A${index + 1}`, role: index === 0 ? 'premise' : index === 1 ? role : 'fact', quote })),
      edges: [], requirements: [] });
    observed.model.review = async input => {
      const v = valid(input), inference = v.items.find(item => item.nodeMappings.length)!;
      Object.assign(inference, { verdict: 'contradicted', claimIds: ['A2'], edgeIds: [], nodeIds: ['N2'], relationIds: [],
        nodeMappings: [{ claimId: 'A2', nodeId: 'N2' }], direction: 'not_required', premises: 'not_required' });
      return v;
    };
    const refuted = await evaluateFrozenReviewReferenceShadow(observed.input, observed.deps, observed.model);
    assert.equal(refuted.result.status, 'reviewed', JSON.stringify(refuted.result)); assert.equal(refuted.result.frames[0].status, 'contradicted');
    assert.equal(refuted.result.semanticTruth, 'not_certified'); assert.equal(refuted.result.cognitionWrite, 'disabled');
  }
  pass('同范围真实相反结果可无推理边，映射结论即可入审；不靠user.role硬拒反例或声称host认证真假');

  for (const axis of ['condition', 'certainty'] as const) {
    const different = await rig(true); different.model.review = async input => {
      const v = valid(input), inference = v.items.find(item => item.nodeMappings.length)!;
      inference.verdict = 'partial'; inference.axes[axis] = 'different'; inference.direction = 'undetermined'; inference.premises = 'missing';
      return v;
    };
    const partialInference = await evaluateFrozenReviewReferenceShadow(different.input, different.deps, different.model);
    assert.equal(partialInference.result.status, 'reviewed'); assert.equal(partialInference.result.frames[0].status, 'partial');
  }
  pass('条件并存/确定程度强弱差异仍能表达partial，不因新增证据门槛变成矛盾或硬拒');

  const synonyms = await rig(true), synonymPieces = ['这台实验装置的示数已越过临界值。',
    '按实验规则，过线就会发出警报，因此它会响。', '只有接通电源，这一判断才成立。'];
  synonyms.input.evidence.answer = synonymPieces.join('');
  synonyms.model.extract = async input => ({ version: 1, packetId: input.packetId,
    claims: synonymPieces.map((quote, index) => ({ id: `A${index + 1}`, role: index === 0 ? 'premise' : index === 1 ? 'conclusion' : 'condition', quote })),
    edges: [{ id: 'E1', source: 'A1', target: 'A2', relation: 'support', quote: synonyms.input.evidence.answer }], requirements: [] });
  assert.equal((await evaluateFrozenReviewReferenceShadow(synonyms.input, synonyms.deps, synonyms.model)).result.status, 'reviewed');
  pass('同义复述仅对用户原文精确锚定，不要求用户引文逐字等于reference原句');

  const noEdges = await rig(true); const extractor = noEdges.model.extract;
  noEdges.model.extract = async (...args) => ({ ...await extractor(...args) as object, edges: [] });
  assert.equal((await evaluateFrozenReviewReferenceShadow(noEdges.input, noEdges.deps, noEdges.model)).result.status, 'held');
  pass('用户节点同时出现不自动补推理连线；定义正确不要求用户推理边');

  const multi = await rig(false, 2); const many = await evaluateFrozenReviewReferenceShadow(multi.input, multi.deps, multi.model);
  assert.equal(many.result.frames.length, 2); assert.ok(many.result.frames.every(frame => frame.status === 'covered'));
  multi.model.review = async input => { const v = valid(input); v.items.splice(2); return v; };
  assert.equal((await evaluateFrozenReviewReferenceShadow(multi.input, multi.deps, multi.model)).result.status, 'held');
  pass('多目标按各自来源框架核对，不能用一个框架替另一个');

  const changed = await rig(); let readCount = 0;
  const changingDeps = { readReference: async () => ++readCount >= 2 ? { status: 'held' as const, reasons: ['source_changed'] } : changed.reply };
  const changedOut = await evaluateFrozenReviewReferenceShadow(changed.input, changingDeps, changed.model);
  assert.equal(changedOut.result.status, 'held'); assert.equal(changedOut.result.modelRequests.total, 1);
  const afterModel = await rig(); let finalReads = 0;
  const afterOut = await evaluateFrozenReviewReferenceShadow(afterModel.input, { readReference: async () => ++finalReads >= 3
    ? { status: 'held', reasons: ['source_changed'] } : afterModel.reply }, afterModel.model);
  assert.equal(afterOut.result.status, 'held'); assert.equal(afterOut.result.observations.length, 0);
  pass('抽取后/审核后源变化均hold，不用最新资料补救原题或保留已过期判断');

  const partial = await rig(); partial.model.review = async input => { const v = valid(input); v.items[1].verdict = 'partial'; return v; };
  const partialOut = await evaluateFrozenReviewReferenceShadow(partial.input, partial.deps, partial.model);
  assert.equal(partialOut.result.status, 'reviewed'); assert.equal(partialOut.result.frames[0].status, 'partial');
  pass('部分覆盖可见但不变成整题合格或正式分数');

  const timeout = await rig(); timeout.model.extract = async () => new Promise(() => {});
  const timed = await evaluateFrozenReviewReferenceShadow(timeout.input, timeout.deps, timeout.model, { timeoutMs: 15 });
  assert.deepEqual(timed.result.reasons, ['shadow_timeout']); assert.equal(timed.result.modelRequests.total, 1);
  const aborted = await rig(), controller = new AbortController(); controller.abort();
  const stopped = await evaluateFrozenReviewReferenceShadow(aborted.input, aborted.deps, aborted.model, { signal: controller.signal });
  assert.deepEqual(stopped.result.reasons, ['shadow_aborted']); assert.equal(stopped.result.modelRequests.total, 0);
  pass('超时/取消不重试、不切模型，已取消时零模型调用');
  const lateAbort = await rig(), laterController = new AbortController(); let lateReads = 0;
  const canceledLate = await evaluateFrozenReviewReferenceShadow(lateAbort.input, { readReference: async () => {
    if (++lateReads === 3) laterController.abort(); return lateAbort.reply;
  } }, lateAbort.model, { signal: laterController.signal });
  assert.deepEqual(canceledLate.result.reasons, ['shadow_aborted']); assert.equal(canceledLate.result.observations.length, 0);
  pass('最终宿主回核await期间取消，不发布迟到reviewed证据');
  const neverRead = await rig();
  const waiting = await evaluateFrozenReviewReferenceShadow(neverRead.input, { readReference: async () => new Promise(() => {}) }, neverRead.model, { readTimeoutMs: 15 });
  assert.deepEqual(waiting.result.reasons, ['shadow_timeout']); assert.equal(waiting.result.modelRequests.total, 0);
  pass('宿主参考读取也有等待上限，悬挂不调用模型或发布结果');

  const isolated = await rig(); let callCount = 0;
  const adapter = createFrozenReferenceShadowModel(async request => {
    callCount++; assert.equal(request.skipMemoryInjection, true); assert.equal(request.skipProfileInjection, true);
    assert.equal(request.thinkingMode, 'disabled'); assert.equal(request.workflow, 'review-scoring');
    const input = JSON.parse(request.userInput);
    if (callCount === 1) return { content: JSON.stringify(await isolated.model.extract(input)), provider: 'mock', model: 'mock' };
    assert.equal(input.version, 4); assert.equal(input.protocol, 'review-frozen-reference-typed-v4');
    return { content: JSON.stringify({ version: 4, evaluationId: input.evaluationId, contractHash: input.contractHash,
      items: input.frames.flatMap((frame: {
        items: { itemId: string; requiredNodeIds: string[] }[];
        nodes: { id: string; evidence: { quoteId: string; text: string }[] }[];
      }) => frame.items.map(item => ({
        itemId: item.itemId, verdict: 'supported', scope: 'same',
        matches: item.requiredNodeIds.map(nodeId => {
          const node = frame.nodes.find(value => value.id === nodeId)!;
          return { claimId: `user/A${nodeId.split('/').at(-1)!.slice(1)}`, nodeId,
            referenceQuoteId: node.evidence[0].quoteId, referenceQuote: node.evidence[0].text };
        }) }))) }), provider: 'mock', model: 'mock' };
  });
  assert.equal(callCount, 0);
  assert.equal((await evaluateFrozenReviewReferenceShadow(isolated.input, isolated.deps, adapter)).result.status, 'reviewed'); assert.equal(callCount, 2);
  pass('生产模型adapter创建不请求，显式调用仅两请求且关闭memory/profile');
  console.log(`Frozen reference shadow checks passed: ${checks} synthetic groups; no real-model accuracy claim.`);
} finally { globalThis.fetch = oldFetch; }
