import assert from 'node:assert/strict';
import { createReferenceDisclosureFixture } from './reference-disclosure-fixture.ts';
import { buildArgumentReferenceDisclosure } from '../src/services/argumentContext/referenceDisclosure.ts';
import { argumentContextHash } from '../src/services/argumentContext/hash.ts';
import { finalizeReferencePropositions, prepareReferencePropositionReviewInput,
  type ReferencePropositionDraft, type ReferencePropositionReview, type ReferencePropositionBundle } from '../src/services/reviewComparison/referencePropositionAnchors.ts';
import { buildFrozenPropositionReferenceInput, readFrozenPropositionReferenceOutput, referencePropositionId,
  createFrozenPropositionReferenceModel, FROZEN_PROPOSITION_REFERENCE_PROMPT, FROZEN_PROPOSITION_REFERENCE_INPUT_LIMIT,
  type FrozenPropositionReferenceInput } from '../src/services/reviewComparison/frozenPropositionReference.ts';
import { FrozenReferenceTypedError, buildFrozenReferenceTypedInputV4 } from '../src/services/reviewComparison/frozenReferenceTyped.ts';
import { FROZEN_ATOMIC_REFERENCE_EXTRACTION_PROMPT } from '../src/services/reviewComparison/frozenExtractionPrompt.ts';
import type { FrozenReferenceShadowInput } from '../src/services/reviewComparison/frozenReferenceShadow.ts';
import type { LlmCallRequest } from '../src/types.ts';
import { prepareSourcePropositionContext, prepareSourcePropositionReviewInput, finalizeSourcePropositions,
  projectReferenceSourcePropositions, validateReviewedReferencePropositions,
  type SourcePropositionDraft, type SourcePropositionReview, type SourcePropositionProof } from '../src/services/reviewComparison/sourcePropositionAnchors.ts';

const oldFetch = globalThis.fetch; globalThis.fetch = async () => assert.fail('v5 codec tests forbid network');
let groups = 0; const pass = (label: string) => { groups++; console.log(`PASS ${label}`); };
const clone = <T>(value: T): T => structuredClone(value);
function error(call: () => unknown, code?: string, field?: string) {
  assert.throws(call, (value: unknown) => value instanceof FrozenReferenceTypedError
    && (!code || value.message === code) && (!field || value.field === field));
}
async function makeBundle(reference: FrozenReferenceShadowInput['reference'], extraAnchors: ReferencePropositionDraft['anchors'] = []) {
  const draft: ReferencePropositionDraft = { version: 1, protocol: 'review-reference-proposition-draft-v1',
    contractHash: reference.contractHash, contextHash: await argumentContextHash(reference), anchors: reference.frames.flatMap(frame =>
      frame.nodes.map(node => {
        const quote = reference.quotes.find(quote => quote.quoteId === node.quoteIds[0])!;
        // Explicit synthetic fixture candidates, not machine connector parsing.
        const text = node.id === 'N2' && node.role === 'conclusion' ? '本次合成包裹会进入二号通道' : quote.text;
        const start = quote.start + quote.text.indexOf(text);
        return { id: `P-${frame.frameId}-${node.id}`, frameId: frame.frameId, nodeId: node.id, quoteId: quote.quoteId,
          start, end: start + text.length, text };
      })).concat(extraAnchors) };
  const prepared = await prepareReferencePropositionReviewInput(reference, draft);
  const review: ReferencePropositionReview = { version: 1, protocol: 'review-reference-proposition-review-v1', reviewId: prepared.reviewId,
    contextHash: prepared.contextHash, draftHash: prepared.draftHash, anchors: draft.anchors.map(anchor => ({ id: anchor.id,
      decision: 'accept', roleSupported: true, completeMeaning: true, scopePreserved: true, reason: '离线固定票仅测试合同，不是模型准确率。' })) };
  const result = await finalizeReferencePropositions(reference, draft, review); assert.ok(result.status === 'ready', JSON.stringify(result));
  return result.bundle;
}
async function rig(reasoning = true, noteCount = 1) {
  const fixture = await createReferenceDisclosureFixture({ task: reasoning ? 'reasoning' : 'definition', theme: 'progressive-parcel-v1', noteCount });
  const disclosure = await buildArgumentReferenceDisclosure(fixture.frozen); assert.ok(disclosure.status === 'ready');
  const parts = reasoning ? ['本次合成包裹带有蓝印。', '本次合成包裹会进入二号通道。', '系统已联网。'] : fixture.paragraphs.slice(0, 2);
  const text = parts.join('\r\n');
  const canonical: FrozenReferenceShadowInput = { version: 1, protocol: 'review-frozen-reference-shadow-v1', evaluationId: `frozen-reference:${'a'.repeat(64)}`,
    answer: { text, hintLevel: 0, consultedMaterialCount: 0 }, taskContext: { questionText: reasoning ? '说明本次分拣推理。' : '说明定义与条件。', usage: 'question_context_only' },
    graph: { claims: parts.map((quote, index) => ({ id: `A${index + 1}`, role: reasoning ? index === 0 ? 'fact' : index === 1 ? 'conclusion' : 'condition' : index === 0 ? 'definition' : 'condition',
      start: text.indexOf(quote), end: text.indexOf(quote) + quote.length })),
    edges: reasoning ? [{ id: 'E1', source: 'A1', target: 'A2', relation: 'support', start: 0, end: text.length }] : [] }, reference: disclosure.context };
  const bundle = await makeBundle(canonical.reference), wire = buildFrozenPropositionReferenceInput(canonical, bundle);
  return { fixture, canonical, bundle, wire, parts };
}
async function sourceReuse(r: Awaited<ReturnType<typeof rig>>) {
  const sources: SourcePropositionProof[] = [];
  for (const [key, input] of r.fixture.inputs) {
    const result = r.fixture.results.get(key)!, context = await prepareSourcePropositionContext(input, result);
    const draft: SourcePropositionDraft = { version: 1, protocol: 'review-source-proposition-draft-v1', contextHash: await argumentContextHash(context),
      anchors: context.projection.nodes.map(node => {
        const parent = context.quotes.find(quote => quote.evidence.start === node.evidence[0].start && quote.evidence.end === node.evidence[0].end)!;
        const text = node.role === 'conclusion' ? '本次合成包裹会进入二号通道' : parent.evidence.quote;
        const start = parent.evidence.start + parent.evidence.quote.indexOf(text);
        return { id: `source-P-${node.id}`, nodeId: node.id, quoteId: parent.quoteId, start, end: start + text.length, text };
      }) };
    const prepared = await prepareSourcePropositionReviewInput(context, draft);
    const review: SourcePropositionReview = { version: 1, protocol: 'review-source-proposition-review-v1', reviewId: prepared.reviewId,
      contextHash: prepared.contextHash, draftHash: prepared.draftHash, anchors: draft.anchors.map(anchor => ({ id: anchor.id, decision: 'accept',
        roleSupported: true, completeMeaning: true, scopePreserved: true, reason: '离线固定源审票，不认证模型。' })) };
    const finalized = await finalizeSourcePropositions(context, draft, review); assert.ok(finalized.status === 'ready', JSON.stringify(finalized));
    sources.push({ input, result, draft, review, bundle: finalized.bundle });
  }
  const projected = await projectReferenceSourcePropositions(r.canonical.reference, sources); assert.ok(projected.status === 'ready', JSON.stringify(projected));
  assert.equal((await validateReviewedReferencePropositions(r.canonical.reference, projected.bundle, projected.proof)).status, 'ready');
  return projected;
}
function valid(input: FrozenPropositionReferenceInput): any {
  return { version: 5, evaluationId: input.evaluationId, contractHash: input.contractHash, bundleHash: input.bundleHash,
    items: input.frames.flatMap(frame => frame.items.map(item => ({ itemId: item.itemId, verdict: 'supported', scope: 'same',
      matches: item.requiredNodeIds.map(nodeId => ({ claimId: `user/A${nodeId.split('/').at(-1)!.slice(1)}`,
        propositionId: frame.nodes.find(node => node.id === nodeId)!.propositions[0].id })),
      ...(item.evidenceMode === 'inference' ? { edgeIds: ['user/E1'], direction: 'correct', premises: 'complete' } : {}) }))) };
}
const inference = (output: any) => output.items.find((item: any) => item.itemId.endsWith('/I3'));
function decode(r: Awaited<ReturnType<typeof rig>>, raw = valid(r.wire)) { return readFrozenPropositionReferenceOutput(raw, r.canonical, r.bundle); }
try {
  const base = await rig(), output = decode(base);
  assert.equal(output.version, 1); assert.equal(output.items[2].verdict, 'supported');
  assert.deepEqual(output.items[2].nodeIds, ['N1', 'N2', 'N3']); assert.deepEqual(output.items[2].relationIds, ['E1', 'E2']);
  assert.equal(base.wire.version, 5); assert.equal(base.wire.protocol, 'review-frozen-reference-propositions-v5');
  assert.equal(base.wire.semanticTruth, 'not_certified'); assert.equal(base.wire.bundleHash, base.bundle.bundleHash);
  pass('v5严格闭合选已审核命题ID→canonical原节点观察；固定节点与关系义务完整保留');

  const n2 = base.wire.frames[0].nodes.find(node => node.id.endsWith('/N2'))!;
  assert.equal(n2.propositions[0].text, '本次合成包裹会进入二号通道');
  assert.equal(n2.evidence[0].text, base.fixture.paragraphs[1]);
  assert.deepEqual(base.wire.frames[0].groups[0].premiseNodeIds, ['reference/target-1/node/N1']);
  assert.deepEqual(base.wire.frames[0].groups[0].conditionNodeIds, ['reference/target-1/node/N3']);
  assert.deepEqual(base.wire.taskContext.usage, 'question_context_only');
  pass('具体结论小锚点附完整父证据、来源、ALL条件与原标准，不把小锚点当新标准');

  for (const field of ['version', 'evaluationId', 'contractHash', 'bundleHash']) {
    const raw = valid(base.wire); raw[field] = field === 'version' ? 4 : 'other';
    error(() => decode(base, raw), 'invalid_proposition_output');
  }
  const old = valid(base.wire); old.version = 3; error(() => decode(base, old), 'invalid_proposition_output');
  const expanded = valid(base.wire); expanded.score = 100; error(() => decode(base, expanded), 'invalid_proposition_output');
  pass('旧v3/v4、错误evaluation/contract/bundleHash及额外root字段不兼容、不修复');

  for (const field of ['nodeId', 'referenceQuote', 'referenceQuoteId', 'start']) {
    const raw = valid(base.wire); raw.items[0].matches[0][field] = 'not-allowed';
    error(() => decode(base, raw), 'invalid_proposition_output', 'matches');
  }
  for (const field of ['axes', 'relationIds', 'edgeIds', 'direction', 'premises']) {
    const raw = valid(base.wire); raw.items[0][field] = [];
    error(() => decode(base, raw), 'invalid_proposition_output', 'item');
  }
  pass('模型只能claimId/propositionId配对，不能补猜quote/node/坐标或给statement加推理字段');

  for (const field of ['scope', 'matches', 'verdict']) {
    const raw = valid(base.wire); delete raw.items[0][field]; error(() => decode(base, raw));
  }
  for (const field of ['edgeIds', 'direction', 'premises']) {
    const raw = valid(base.wire); delete inference(raw)[field]; error(() => decode(base, raw));
  }
  for (const scope of ['different', 'unknown']) {
    const raw = valid(base.wire); raw.items[0].scope = scope; error(() => decode(base, raw), 'unsubstantiated_shadow_verdict', 'scope');
  }
  pass('缺语义断言不补默认，同范围仍是显式五维核对，不因ID相同推断');

  for (const propositionId of ['reference/target-2/proposition/P-target-1-N1', n2.propositions[0].id, 'reference/target-1/proposition/unknown', 'user/A1']) {
    const raw = valid(base.wire); raw.items[0].matches[0].propositionId = propositionId;
    error(() => decode(base, raw), 'invalid_proposition_evidence', 'matches');
  }
  const duplicate = valid(base.wire); duplicate.items[0].matches.push(clone(duplicate.items[0].matches[0]));
  error(() => decode(base, duplicate), 'invalid_proposition_evidence', 'matches');
  pass('别frame、本item外节点、未知/混USER命题及重复原配对拒绝');

  for (const role of ['premise', 'definition', 'condition'] as const) {
    const changed = { ...base, canonical: clone(base.canonical) }; changed.canonical.graph.claims[0].role = role;
    error(() => decode(changed), 'reference_role_mismatch', 'matches');
  }
  const wrongConclusion = valid(base.wire); inference(wrongConclusion).matches[1].claimId = 'user/A3';
  error(() => decode(base, wrongConclusion), 'reference_role_mismatch', 'matches');
  const priorConclusion = { ...base, canonical: clone(base.canonical) }; priorConclusion.canonical.graph.claims[0].role = 'conclusion';
  assert.equal(decode(priorConclusion).items[2].verdict, 'supported');
  pass('保留v4实际fact/结论职责门禁；前一conclusion可作后续前提，不隐藏要求旧证明');

  const noNode = valid(base.wire); inference(noNode).matches.pop(); error(() => decode(base, noNode), 'incomplete_shadow_structure');
  const noEdge = valid(base.wire); inference(noEdge).edgeIds = []; error(() => decode(base, noEdge), 'incomplete_shadow_reasoning');
  const reverseEdge = { ...base, canonical: clone(base.canonical) }; reverseEdge.canonical.graph.edges[0].source = 'A2'; reverseEdge.canonical.graph.edges[0].target = 'A1';
  error(() => decode(reverseEdge), 'incomplete_shadow_reasoning');
  const crossed = valid(base.wire); inference(crossed).matches[1].claimId = 'user/A1';
  error(() => decode(base, crossed), 'incomplete_shadow_reasoning');
  pass('漏required node/真实边、正确标签伪装逆向边或同claim占两端均拒绝');

  const reversed = valid(base.wire); Object.assign(inference(reversed), { verdict: 'partial', direction: 'reverse', premises: 'complete' });
  assert.equal(decode(base, reversed).items[2].direction, 'reverse');
  assert.equal(decode(base, reversed).items[2].verdict, 'partial');
  const partial = valid(base.wire); Object.assign(inference(partial), { verdict: 'partial', scope: 'unknown', matches: [], edgeIds: [], direction: 'undetermined', premises: 'missing' });
  assert.equal(decode(base, partial).items[2].axes.condition, 'unknown');
  pass('逆推/缺条件只保留partial及真实方向，未知范围不变成矛盾或合格');

  const compound = { ...base, canonical: clone(base.canonical) }, joined = base.parts[0] + base.parts[2];
  compound.canonical.answer.text = joined + base.parts[1];
  compound.canonical.graph.claims = [{ id: 'A1', role: 'fact', start: 0, end: joined.length },
    { id: 'A2', role: 'conclusion', start: joined.length, end: compound.canonical.answer.text.length }];
  compound.canonical.graph.edges = [{ id: 'E1', source: 'A1', target: 'A2', relation: 'support', start: 0, end: compound.canonical.answer.text.length }];
  const compoundRaw = valid(base.wire);
  for (const row of compoundRaw.items) for (const pair of row.matches) if (pair.propositionId.endsWith('-N3')) pair.claimId = 'user/A1';
  assert.equal(decode(compound, compoundRaw).items[2].nodeMappings.length, 3);
  pass('合取实际事实可n:m配事实和条件，不强制一对一或给条件另造评分义务');

  const both = await rig(true, 2), aliasRaw = valid(both.wire);
  const sourceProposition = both.wire.frames[1].nodes[0].propositions[0].id;
  aliasRaw.items[0].matches[0].propositionId = sourceProposition;
  error(() => decode(both, aliasRaw), 'invalid_proposition_evidence', 'matches');
  pass('两来源同名节点、相同短语仍不能跨frame借已审核命题');

  const extraContext = clone(base.canonical.reference), firstAnchor = base.bundle.anchors[0];
  const extraBundle = await makeBundle(extraContext, [{ id: 'P-small-N1', frameId: firstAnchor.frameId, nodeId: firstAnchor.nodeId,
    quoteId: firstAnchor.quoteId, start: firstAnchor.start, end: firstAnchor.end - 1, text: firstAnchor.text.slice(0, -1) }]);
  const dedup = { ...base, bundle: extraBundle, wire: buildFrozenPropositionReferenceInput(base.canonical, extraBundle) };
  const dedupRaw = valid(dedup.wire); inference(dedupRaw).matches.push({ claimId: 'user/A1', propositionId: referencePropositionId(firstAnchor.frameId, 'P-small-N1') });
  assert.equal(decode(dedup, dedupRaw).items[2].nodeMappings.filter(mapping => mapping.nodeId === 'N1').length, 1);
  pass('同claim选同node的不同合法P只派生一个node mapping；不重复计算标准');

  const opposite = { ...base, canonical: clone(base.canonical) };
  const oppositeParts = [base.parts[0], '本次合成包裹不会进入二号通道。', base.parts[2]];
  opposite.canonical.answer.text = oppositeParts.join('\r\n');
  opposite.canonical.graph.claims = oppositeParts.map((text, index) => ({ id: `A${index + 1}`, role: index === 0 ? 'fact' : index === 1 ? 'premise' : 'condition',
    start: opposite.canonical.answer.text.indexOf(text), end: opposite.canonical.answer.text.indexOf(text) + text.length })); opposite.canonical.graph.edges = [];
  const oppositionRaw = valid(base.wire), pair = { claimId: 'user/A2', propositionId: n2.propositions[0].id };
  Object.assign(inference(oppositionRaw), { verdict: 'contradicted', matches: [pair], edgeIds: [], direction: 'not_required', premises: 'not_required',
    opposition: { ...pair, userOutcome: '不会进入二号通道', referenceOutcome: '会进入二号通道' } });
  assert.equal(decode(opposite, oppositionRaw).items[2].verdict, 'contradicted');
  assert.equal(n2.evidence[0].text.indexOf('会进入二号通道', n2.evidence[0].text.indexOf('会进入二号通道') + 1) >= 0, true);
  pass('无边实际反证可入审，见证在已审核具体P内唯一；父Q重复结果不再猜首位置');

  for (const change of [
    (raw: any) => { delete inference(raw).opposition; }, (raw: any) => { inference(raw).opposition = null; },
    (raw: any) => { inference(raw).opposition.claimId = 'user/A1'; },
    (raw: any) => { inference(raw).opposition.propositionId = base.wire.frames[0].nodes[0].propositions[0].id; },
    (raw: any) => { inference(raw).opposition.referenceOutcome = '原文没有这个结果'; },
  ]) {
    const raw = clone(oppositionRaw); change(raw); error(() => decode(opposite, raw));
  }
  const same = clone(oppositionRaw); same.items[2].opposition.userOutcome = '会进入二号通道';
  error(() => decode(base, same), 'invalid_opposition_witness', 'opposition');
  const reversedConflict = clone(oppositionRaw); inference(reversedConflict).direction = 'reverse';
  error(() => decode(opposite, reversedConflict), 'unsubstantiated_shadow_verdict', 'reasoning');
  pass('见证必须同一明确配对、真实唯一相反结果；缺证/借证/同结果/逆推矛盾均拒绝');

  const artificialMeaning = clone(oppositionRaw); artificialMeaning.items[2].opposition.userOutcome = '本次合成包裹会进入二号通道';
  // Different literal slices of the same actual outcome are not mechanically
  // recognizable synonyms. A shape pass is not a semantic-accuracy assertion.
  assert.equal(decode(base, artificialMeaning).items[2].verdict, 'contradicted');
  assert.equal(base.wire.semanticTruth, 'not_certified');
  pass('程序仅出处/结构防护，不把不同字符串或审核role当事实语义认证');

  for (const change of [
    (bundle: ReferencePropositionBundle) => { bundle.contractHash = 'f'.repeat(64); },
    (bundle: ReferencePropositionBundle) => { bundle.anchors[0].role = 'conclusion'; },
    (bundle: ReferencePropositionBundle) => { bundle.anchors[0].source.version = 'changed'; },
    (bundle: ReferencePropositionBundle) => { bundle.anchors[0].sourceKey = 'f'.repeat(64); },
    (bundle: ReferencePropositionBundle) => { bundle.anchors[0].parent.text += '篡改'; },
    (bundle: ReferencePropositionBundle) => { bundle.anchors[0].start++; bundle.anchors[0].end++; },
    (bundle: ReferencePropositionBundle) => { (bundle.anchors[0] as any).score = 100; },
  ]) {
    const bundle = clone(base.bundle); change(bundle); error(() => buildFrozenPropositionReferenceInput(base.canonical, bundle), 'invalid_proposition_bundle');
  }
  const missingP = clone(base.bundle); missingP.anchors.pop();
  error(() => buildFrozenPropositionReferenceInput(base.canonical, missingP), 'proposition_required_nodes_missing');
  pass('builder复核bundle闭schema/绝对坐标/派生role/当前来源父Q和覆盖，仍非hash权限认证');

  const ordinary = await rig(false); assert.deepEqual(ordinary.wire.user.edges, []); assert.equal(decode(ordinary).items.length, 2);
  const nulls = valid(ordinary.wire); nulls.items.forEach((row: any) => { row.opposition = null; }); decode(ordinary, nulls);
  const fakeWitness = valid(ordinary.wire); fakeWitness.items[0].opposition = {};
  error(() => decode(ordinary, fakeWitness), 'invalid_opposition_witness');
  pass('纯statement隐藏无关用户边，非矛盾见证省略或null合法，不接受假冲突见证');

  const malformed = valid(base.wire); malformed.items.pop(); error(() => decode(base, malformed), 'incomplete_shadow_items');
  const sparse = valid(base.wire); delete sparse.items[0]; error(() => decode(base, sparse), 'invalid_proposition_evidence');
  const repeatedItem = valid(base.wire); repeatedItem.items[1] = repeatedItem.items[0]; error(() => decode(base, repeatedItem), 'invalid_proposition_output');
  pass('漏项/稀疏数组/重复项整体拒绝；安全诊断只使用所选item与受控字段');

  let accessorReads = 0;
  const accessor = valid(base.wire); Object.defineProperty(accessor.items[0], 'itemId', { enumerable: true,
    get: () => { accessorReads++; return base.wire.frames[0].items[0].itemId; } });
  error(() => decode(base, accessor), 'invalid_proposition_output'); assert.equal(accessorReads, 0);
  const hidden = valid(base.wire); hidden.items[0][Symbol('scope-authority')] = true;
  error(() => decode(base, hidden), 'invalid_proposition_output');
  const malformedPairs = valid(base.wire); delete malformedPairs.items[0].matches[0];
  error(() => decode(base, malformedPairs), 'invalid_proposition_evidence');
  pass('闭合schema不执行行getter、不忽略symbol字段或稀疏matches');

  const calls: LlmCallRequest[] = [], signal = new AbortController().signal;
  const model = createFrozenPropositionReferenceModel(async (request, options) => {
    calls.push(clone(request)); assert.equal(options?.signal, signal);
    return { content: JSON.stringify(JSON.parse(request.userInput).version === 5 ? valid(base.wire) : { version: 1 }), provider: 'mock', model: 'mock' };
  });
  assert.equal(calls.length, 0);
  await model.extract({ packetId: base.canonical.evaluationId, questionText: base.canonical.taskContext.questionText,
    answer: { text: base.canonical.answer.text, hintLevel: 0, messageId: 'synthetic', consultedMaterialIds: [] },
    knowledgeTargets: [], assessment: base.canonical.reference.assessment } as any, signal);
  const rawModel = await model.review(base.canonical, base.bundle, signal); assert.deepEqual(rawModel, valid(base.wire));
  assert.equal(calls.length, 2); assert.equal(calls[0].systemPromptOverride, FROZEN_ATOMIC_REFERENCE_EXTRACTION_PROMPT);
  assert.equal(calls[1].systemPromptOverride, FROZEN_PROPOSITION_REFERENCE_PROMPT);
  assert.deepEqual(JSON.parse(calls[1].userInput), base.wire);
  for (const request of calls) {
    assert.equal(request.maxTokensOverride, 4096); assert.equal(request.skipMemoryInjection, true); assert.equal(request.skipProfileInjection, true);
    assert.equal(request.thinkingMode, 'disabled'); assert.equal(request.workflow, 'review-scoring');
  }
  pass('显式工厂创建0calls、一次抽取一次核对raw；atomic提示/4096/禁画像记忆/无重试');

  const invalidBeforeCall = clone(base.bundle); invalidBeforeCall.anchors[0].role = 'conclusion';
  await assert.rejects(() => model.review(base.canonical, invalidBeforeCall, signal)); assert.equal(calls.length, 2);
  const rawFactory = createFrozenPropositionReferenceModel(async () => ({ content: JSON.stringify({ version: 4 }), provider: 'mock', model: 'mock' }));
  assert.deepEqual(await rawFactory.review(base.canonical, base.bundle), { version: 4 });
  error(() => readFrozenPropositionReferenceOutput({ version: 4 }, base.canonical, base.bundle), 'invalid_proposition_output');
  pass('factory预投影失败不发请求；即使返回旧raw也由host严格decoder拒绝，无doubledecode/重试');

  const over = clone(base.canonical); over.taskContext.questionText = '问'.repeat(4001);
  error(() => buildFrozenPropositionReferenceInput(over, base.bundle));
  const invalidBudget = clone(base.bundle); invalidBudget.anchors.push(...Array.from({ length: 97 }, () => clone(invalidBudget.anchors[0])));
  error(() => buildFrozenPropositionReferenceInput(base.canonical, invalidBudget), 'invalid_proposition_bundle');
  assert.ok(JSON.stringify(base.wire).length < FROZEN_PROPOSITION_REFERENCE_INPUT_LIMIT);
  pass('题干/候选计数与整包预算严格fail closed；不裁剪、自动选择或截断标准');

  // A local synthetic reference DTO isolates wire-budget accounting. Fixed
  // votes are NOT an assertion that a changed DTO passed real host admission.
  const wireBudget = clone(base.canonical), originalPlain = JSON.stringify(buildFrozenReferenceTypedInputV4(wireBudget)).length;
  const added = Math.floor((59900 - originalPlain) / 3), conditionQuote = wireBudget.reference.quotes.find(quote => quote.quoteId === base.bundle.anchors[2].quoteId)!;
  conditionQuote.text += '填'.repeat(added); conditionQuote.end += added;
  const priorSize = JSON.stringify(buildFrozenReferenceTypedInputV4(wireBudget)).length;
  assert.ok(priorSize < 60000 && priorSize > 59800);
  const budgetDraft: ReferencePropositionDraft = { version: 1, protocol: 'review-reference-proposition-draft-v1',
    contractHash: wireBudget.reference.contractHash, contextHash: await argumentContextHash(wireBudget.reference),
    anchors: base.bundle.anchors.map(({ id, frameId, nodeId, quoteId, start, end, text }) => ({ id, frameId, nodeId, quoteId, start, end, text })) };
  const budgetInput = await prepareReferencePropositionReviewInput(wireBudget.reference, budgetDraft);
  const budgetReview: ReferencePropositionReview = { version: 1, protocol: 'review-reference-proposition-review-v1', reviewId: budgetInput.reviewId,
    contextHash: budgetInput.contextHash, draftHash: budgetInput.draftHash, anchors: budgetDraft.anchors.map(anchor => ({ id: anchor.id,
      decision: 'accept', roleSupported: true, completeMeaning: true, scopePreserved: true, reason: '合成预算探针' })) };
  const budgetFrozen = await finalizeReferencePropositions(wireBudget.reference, budgetDraft, budgetReview);
  assert.ok(budgetFrozen.status === 'ready');
  error(() => buildFrozenPropositionReferenceInput(wireBudget, budgetFrozen.bundle), 'proposition_context_budget_exceeded', 'context');
  await assert.rejects(() => model.review(wireBudget, budgetFrozen.bundle, signal)); assert.equal(calls.length, 2);
  pass('完整v4投影尚未超限但v5新增P使整包超限时，factory本地拒绝0追加调用、不截断');

  const sourceProjected = await sourceReuse(base), sourceWire = buildFrozenPropositionReferenceInput(base.canonical, sourceProjected.bundle);
  assert.equal(Object.hasOwn(base.wire, 'reviewBasis'), false);
  assert.deepEqual(sourceWire.reviewBasis, sourceProjected.bundle.reviewBasis);
  assert.equal(sourceWire.reviewBasis?.questionSpecificReview, 'not_performed');
  const sourceCanonical = readFrozenPropositionReferenceOutput(valid(sourceWire), base.canonical, sourceProjected.bundle);
  assert.deepEqual(sourceCanonical, output);
  let sourceCalls = 0;
  const sourceFactory = createFrozenPropositionReferenceModel(async request => { sourceCalls++; assert.deepEqual(JSON.parse(request.userInput), sourceWire);
    return { content: JSON.stringify(valid(sourceWire)), provider: 'mock', model: 'mock' }; });
  assert.equal(sourceCalls, 0); assert.deepEqual(await sourceFactory.review(base.canonical, sourceProjected.bundle), valid(sourceWire));
  assert.equal(sourceCalls, 1);
  pass('v2已审源复用显式投影v5，wire注明题级未审核；v1旧wire不增字段，factory仍只发raw一次');

  for (const mutate of [
    (bundle: any) => { bundle.reviewId = 'fake-new-question-review'; },
    (bundle: any) => { bundle.version = 1; bundle.protocol = 'review-reference-proposition-bundle-v1'; },
    (bundle: any) => { bundle.reviewBasis.questionSpecificReview = 'performed'; },
    (bundle: any) => { bundle.reviewBasis.kind = 'question-reviewed'; },
    (bundle: any) => { bundle.reviewBasis.sourceBundleHashes = []; },
    (bundle: any) => { bundle.reviewBasis.sourceBundleHashes.push(bundle.reviewBasis.sourceBundleHashes[0]); },
    (bundle: any) => { bundle.anchors[0].role = 'conclusion'; },
    (bundle: any) => { bundle.anchors[0].parent.text += '改'; },
  ]) { const bundle = clone(sourceProjected.bundle); mutate(bundle); error(() => buildFrozenPropositionReferenceInput(base.canonical, bundle), 'invalid_proposition_bundle'); }
  const crossBinding = valid(sourceWire); crossBinding.bundleHash = base.bundle.bundleHash;
  error(() => readFrozenPropositionReferenceOutput(crossBinding, base.canonical, sourceProjected.bundle), 'invalid_proposition_output');
  const fakeOldBasis = { ...clone(base.bundle), reviewBasis: clone(sourceProjected.bundle.reviewBasis) };
  error(() => buildFrozenPropositionReferenceInput(base.canonical, fakeOldBasis), 'invalid_proposition_bundle');
  pass('v2/v1闭分支拒伪新题票、版本换标、假basis、空/重复源hash、父文角色换绑与跨bundle响应');
  console.log(`Frozen proposition codec checks: ${groups} synthetic groups; no cloud, old response rewrites or production writes.`);
} finally { globalThis.fetch = oldFetch; }
