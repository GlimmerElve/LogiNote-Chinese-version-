import assert from 'node:assert/strict';
import { createReferenceDisclosureFixture } from './reference-disclosure-fixture.ts';
import { buildArgumentReferenceDisclosure } from '../src/services/argumentContext/referenceDisclosure.ts';
import { argumentContextHash } from '../src/services/argumentContext/hash.ts';
import { evaluateFrozenReviewReferenceShadow, FROZEN_SELECTED_ENDPOINT_POLICY,
  type FrozenReferenceShadowInput, type FrozenReferenceShadowModel } from '../src/services/reviewComparison/frozenReferenceShadow.ts';
import { createFrozenAtomicReferenceShadowModel, evaluateFrozenAtomicReviewReferenceShadow } from '../src/services/reviewComparison/frozenAtomicReference.ts';
import { FROZEN_ATOMIC_REFERENCE_EXTRACTION_PROMPT, FROZEN_REFERENCE_EXTRACTION_PROMPT } from '../src/services/reviewComparison/frozenExtractionPrompt.ts';
import { FROZEN_REFERENCE_SHADOW_PROMPT } from '../src/services/reviewComparison/frozenReferenceModel.ts';
import { readableReferenceId, readableUserId } from '../src/services/reviewComparison/frozenReferenceReadable.ts';
import type { ReviewComparisonAnswer } from '../src/services/reviewComparison/types.ts';
import type { LlmCallRequest } from '../src/types.ts';

const originalFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('Atomic shadow checks forbid network');
let checks = 0;
const pass = (label: string) => { checks++; console.log(`PASS ${label}`); };

async function rig(mode: 'separate' | 'nested' | 'unused' | 'compound' | 'derived' | 'proved' | 'reverse' | 'opposite' | 'statement' = 'separate') {
  const statement = mode === 'statement';
  const fixture = await createReferenceDisclosureFixture({ task: statement ? 'definition' : 'reasoning' });
  const reply = await buildArgumentReferenceDisclosure(fixture.frozen);
  assert.ok(reply.status === 'ready');
  const context = reply.context;
  const ordinary = '本次设备读数超过阈值，所以本次设备会报警。设备现在已供电。';
  const text = statement ? fixture.paragraphs.slice(0, 2).join('')
    : mode === 'compound' ? '本次设备读数超过阈值且设备已供电，所以本次设备会报警。'
      : mode === 'proved' ? '本次测得读数为11而阈值为10，因此本次设备读数超过阈值，所以本次设备会报警。设备现在已供电。'
        : mode === 'reverse' ? '本次设备会报警，所以本次设备读数超过阈值。设备现在已供电。'
          : mode === 'opposite' ? '本次设备读数超过阈值，设备现在已供电，但本次设备不会报警。' : ordinary;
  const answer: ReviewComparisonAnswer = { activityId: 'offline-atomic-shadow', questionText: statement ? '说明概念及边界。' : '说明本次事实、条件与推断。',
    evidence: { messageId: 'offline-user', answer: text, hintLevel: 0, targetKnowledgeNames: fixture.selectors.knowledgeTargets,
      questionIntent: { version: 1, questionMessageId: fixture.selectors.questionMessageId,
        knowledgeTargets: fixture.selectors.knowledgeTargets, assessment: fixture.selectors.assessment, referenceRubric: fixture.selectors.referenceRubric,
        referenceStructure: { version: 1, status: 'fixed', originQuestionMessageId: fixture.frozen.originQuestionMessageId,
          freezeId: '12345678-1234-1234-1234-123456789abc', contractHash: fixture.frozen.contractHash,
          selectorsHash: await argumentContextHash(fixture.selectors), reasons: [] } } } };
  const claim = (id: string, role: string, quote: string) => ({ id, role, quote });
  const raw = (packetId: string) => {
    const claims = statement ? [claim('A1', 'definition', text), claim('A2', 'condition', fixture.paragraphs[1])]
      : [claim('A1', mode === 'derived' || mode === 'proved' || mode === 'reverse' ? 'conclusion' : 'fact',
        mode === 'nested' ? '本次设备读数超过阈值，所以本次设备会报警。'
          : mode === 'compound' ? '本次设备读数超过阈值且设备已供电' : '本次设备读数超过阈值'),
      claim('A2', mode === 'reverse' ? 'fact' : 'conclusion', mode === 'opposite' ? '本次设备不会报警' : '本次设备会报警'),
      ...(mode === 'compound' ? [] : [claim('A3', 'condition', '设备现在已供电')])];
    if (mode === 'unused') claims.push(claim('A4', 'fact', '本次设备会报警。设备现在已供电。'));
    if (mode === 'proved') claims.push(claim('A4', 'fact', '本次测得读数为11而阈值为10'));
    const edges = mode === 'opposite' ? [] : [{ id: 'E1', source: mode === 'reverse' ? 'A2' : 'A1',
      target: mode === 'reverse' ? 'A1' : 'A2', relation: 'support', quote: text }];
    if (mode === 'unused') edges.push({ id: 'E2', source: 'A4', target: 'A3', relation: 'support', quote: '本次设备会报警。设备现在已供电。' });
    if (mode === 'proved') edges.push({ id: 'E2', source: 'A4', target: 'A1', relation: 'support', quote: '本次测得读数为11而阈值为10，因此本次设备读数超过阈值' });
    return { version: 1, packetId, claims, edges, requirements: [] };
  };
  const valid = (input: Pick<FrozenReferenceShadowInput, 'evaluationId' | 'reference'>) => ({
    version: 4, evaluationId: input.evaluationId, contractHash: input.reference.contractHash,
    items: input.reference.frames.flatMap(frame => frame.items.map(item => {
      const inference = item.criterionId === 'inference_link';
      const matches = item.nodeIds.map(nodeId => {
        const node = frame.nodes.find(node => node.id === nodeId)!;
        const quote = input.reference.quotes.find(quote => quote.quoteId === node.quoteIds[0])!;
        return { claimId: readableUserId(nodeId === 'N3' && mode === 'compound' ? 'A1' : `A${nodeId.slice(1)}`),
          nodeId: readableReferenceId(frame.frameId, 'node', nodeId), referenceQuoteId: quote.quoteId, referenceQuote: quote.text };
      });
      return { itemId: readableReferenceId(frame.frameId, 'item', item.itemId),
        verdict: inference && mode === 'reverse' ? 'partial' : inference && mode === 'opposite' ? 'contradicted' : 'supported', scope: 'same', matches,
        ...(inference ? { edgeIds: mode === 'opposite' ? [] : ['user/E1'], direction: mode === 'reverse' ? 'reverse' : mode === 'opposite' ? 'not_required' : 'correct',
          premises: mode === 'opposite' ? 'not_required' : 'complete' } : {}),
        ...(inference && mode === 'opposite' ? { opposition: { ...matches.find(pair => pair.nodeId.endsWith('/N2'))!,
          userOutcome: '本次设备不会报警', referenceOutcome: '本次合成设备会报警' } } : {}) };
    })),
  });
  let calls = 0, reads = 0;
  const model: FrozenReferenceShadowModel = { protocol: 'typed-v4',
    extract: async input => { calls++; return raw(input.packetId); },
    review: async input => { calls++; return valid(input); } };
  const dependencies = { readReference: async () => { reads++; return structuredClone(reply); } };
  return { answer, model, dependencies, raw, valid, context, calls: () => calls, reads: () => reads };
}

try {
  const baseline = await rig('nested');
  const legacy = await evaluateFrozenReviewReferenceShadow(baseline.answer, baseline.dependencies, baseline.model);
  assert.equal(legacy.result.status, 'reviewed'); assert.equal(legacy.result.frames[0].status, 'covered');
  assert.equal(Object.hasOwn(legacy.result, 'inferenceAtomicity'), false);
  pass('默认v4仍保留原合同与结果，无新策略标记；手工嵌套票不是模型正确率');

  const nested = await rig('nested');
  const held = await evaluateFrozenAtomicReviewReferenceShadow(nested.answer, nested.dependencies, nested.model);
  assert.equal(held.result.status, 'held'); assert.deepEqual(held.result.reasons, ['non_atomic_inference_endpoint']);
  assert.deepEqual(held.result.diagnostics, [{ stage: 'reference', itemId: 'reference/target-1/item/I3', field: 'inference_endpoints', code: 'non_atomic_inference_endpoint' }]);
  assert.equal(held.result.modelRequests.total, 2); assert.equal(held.result.observations.length, 0);
  assert.equal(held.result.scoreWrite, 'disabled'); assert.equal(held.result.cognitionWrite, 'disabled');
  assert.equal(held.result.inferenceAtomicity, FROZEN_SELECTED_ENDPOINT_POLICY);
  pass('显式策略拒绝整段理由包含目标结论；两次上限、暂缓无分数或认知写入');

  for (const mode of ['separate', 'compound', 'derived', 'proved'] as const) {
    const r = await rig(mode);
    const out = await evaluateFrozenAtomicReviewReferenceShadow(r.answer, r.dependencies, r.model);
    assert.equal(out.result.status, 'reviewed', JSON.stringify(out.result));
    assert.equal(out.result.frames[0].status, 'covered'); assert.equal(out.result.modelRequests.total, 2);
    assert.equal(r.reads(), 3);
    pass(`${mode}：独立端点/合取n:m/前一步结论作前提兼容，旧证明非新增义务`);
  }

  for (const mode of ['unused', 'statement'] as const) {
    const r = await rig(mode);
    const out = await evaluateFrozenAtomicReviewReferenceShadow(r.answer, r.dependencies, r.model);
    assert.equal(out.result.status, 'reviewed', JSON.stringify(out.result));
    assert.equal(out.result.frames[0].status, 'covered');
    pass(`${mode}：仅检验已选推理边，未选嵌套边及普通题不会新增门槛`);
  }

  const reverse = await rig('reverse');
  const inverse = await evaluateFrozenAtomicReviewReferenceShadow(reverse.answer, reverse.dependencies, reverse.model);
  assert.equal(inverse.result.status, 'reviewed'); assert.equal(inverse.result.frames[0].status, 'partial');
  assert.equal(inverse.result.observations.find(item => item.itemId === 'I3')!.direction, 'reverse');
  pass('真实逆向独立端点保留reverse/partial，不翻正向也不升级事实矛盾');

  const opposite = await rig('opposite');
  const refuted = await evaluateFrozenAtomicReviewReferenceShadow(opposite.answer, opposite.dependencies, opposite.model);
  assert.equal(refuted.result.status, 'reviewed', JSON.stringify(refuted.result));
  assert.equal(refuted.result.frames[0].status, 'contradicted'); assert.deepEqual(refuted.graph!.edges, []);
  pass('直接实际反证无证明边合法，原子性策略不强制补边；语义仍不认证');

  const invalid = await rig();
  const invalidOut = await evaluateFrozenReviewReferenceShadow(invalid.answer, invalid.dependencies, invalid.model,
    { inferenceAtomicity: 'unknown' as typeof FROZEN_SELECTED_ENDPOINT_POLICY });
  assert.equal(invalidOut.result.status, 'held'); assert.deepEqual(invalidOut.result.reasons, ['invalid_inference_atomicity_policy']);
  assert.equal(invalid.calls(), 0); assert.equal(invalid.reads(), 0);
  pass('未知显式策略在任何来源读取或调用前拒绝，不回退默认');

  const late = await rig('nested'), lateOptions: { inferenceAtomicity?: typeof FROZEN_SELECTED_ENDPOINT_POLICY } = { inferenceAtomicity: FROZEN_SELECTED_ENDPOINT_POLICY };
  const strictOut = await evaluateFrozenReviewReferenceShadow(late.answer,
    { readReference: async () => { delete lateOptions.inferenceAtomicity; return late.dependencies.readReference(); } }, late.model, lateOptions);
  assert.deepEqual(strictOut.result.reasons, ['non_atomic_inference_endpoint']);
  const lateDefault = await rig('nested'), defaultOptions: { inferenceAtomicity?: typeof FROZEN_SELECTED_ENDPOINT_POLICY } = {};
  const defaultOut = await evaluateFrozenReviewReferenceShadow(lateDefault.answer,
    { readReference: async () => { defaultOptions.inferenceAtomicity = FROZEN_SELECTED_ENDPOINT_POLICY; return lateDefault.dependencies.readReference(); } }, lateDefault.model, defaultOptions);
  assert.equal(defaultOut.result.status, 'reviewed'); assert.equal(Object.hasOwn(defaultOut.result, 'inferenceAtomicity'), false);
  assert.equal(defaultOut.result.evaluationId, legacy.result.evaluationId);
  assert.notEqual(strictOut.result.evaluationId, legacy.result.evaluationId);
  pass('首await前捕获策略，晚改无效；新策略参与绑定，默认历史ID保持不变');

  const actual = await rig(); const requests: LlmCallRequest[] = [];
  const factory = createFrozenAtomicReferenceShadowModel(async request => {
    requests.push(structuredClone(request));
    const input = JSON.parse(request.userInput);
    return { content: JSON.stringify(requests.length === 1 ? actual.raw(input.packetId)
      : actual.valid({ evaluationId: input.evaluationId, reference: actual.context })) };
  });
  assert.equal(requests.length, 0);
  const out = await evaluateFrozenAtomicReviewReferenceShadow(actual.answer, actual.dependencies, factory);
  assert.equal(out.result.status, 'reviewed', JSON.stringify(out.result)); assert.equal(requests.length, 2);
  assert.equal(requests[0].systemPromptOverride, FROZEN_ATOMIC_REFERENCE_EXTRACTION_PROMPT);
  assert.notEqual(requests[0].systemPromptOverride, FROZEN_REFERENCE_EXTRACTION_PROMPT);
  assert.equal(requests[1].systemPromptOverride, FROZEN_REFERENCE_SHADOW_PROMPT);
  assert.equal(JSON.parse(requests[1].userInput).version, 4);
  assert.ok(requests.every(request => request.skipMemoryInjection && request.skipProfileInjection && request.thinkingMode === 'disabled'));
  pass('实际显式factory零默认调用；两阶段mock只换专用抽取提示，无额外请求/画像/个人上下文');
  console.log(`Atomic shadow checks: ${checks} offline groups; no cloud, real data, production writes or semantic accuracy claim.`);
} finally { globalThis.fetch = originalFetch; }
