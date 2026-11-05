import assert from 'node:assert/strict';
import { createReferenceDisclosureFixture } from './reference-disclosure-fixture.ts';
import { buildArgumentReferenceDisclosure } from '../src/services/argumentContext/referenceDisclosure.ts';
import { argumentContextHash } from '../src/services/argumentContext/hash.ts';
import { prepareReferencePropositionReviewInput, finalizeReferencePropositions,
  type ReferencePropositionDraft } from '../src/services/reviewComparison/referencePropositionAnchors.ts';
import { evaluateFrozenPropositionReviewReferenceShadow, type FrozenPropositionShadowModel } from '../src/services/reviewComparison/frozenPropositionShadow.ts';
import { buildFrozenPropositionReferenceInput } from '../src/services/reviewComparison/frozenPropositionReference.ts';
import { evaluateFrozenReviewReferenceShadow, type FrozenReferenceShadowInput } from '../src/services/reviewComparison/frozenReferenceShadow.ts';
import { createReviewArgumentQuestionClient, type ReviewArgumentQuestionApi } from '../src/services/argumentContext/questionBindingClient.ts';
import type { ArgumentReferencePropositionDisclosureReply } from '../src/services/argumentContext/referencePropositionReceipt.ts';
import type { ReviewComparisonAnswer } from '../src/services/reviewComparison/types.ts';

const fetchBefore = globalThis.fetch;
globalThis.fetch = async () => assert.fail('Proposition shadow checks forbid network');
let checks = 0;
const pass = (label: string) => { checks++; console.log(`PASS ${label}`); };
const clone = <T>(value: T): T => structuredClone(value);
async function rig(mode: 'forward' | 'reverse' | 'opposite' | 'nested' | 'compound' = 'forward') {
  const fixture = await createReferenceDisclosureFixture({ task: 'reasoning', theme: 'progressive-parcel-v1' });
  const reference = await buildArgumentReferenceDisclosure(fixture.frozen); assert.ok(reference.status === 'ready');
  const context = reference.context;
  const draft: ReferencePropositionDraft = { version: 1, protocol: 'review-reference-proposition-draft-v1',
    contractHash: context.contractHash, contextHash: await argumentContextHash(context),
    anchors: context.frames.flatMap(frame => frame.nodes.map(node => {
      const parent = context.quotes.find(quote => quote.quoteId === node.quoteIds[0])!;
      const text = node.id === 'N2' ? '本次合成包裹会进入二号通道' : parent.text;
      const start = parent.start + parent.text.indexOf(text);
      return { id: `P-${frame.frameId}-${node.id}`, frameId: frame.frameId, nodeId: node.id,
        quoteId: parent.quoteId, start, end: start + text.length, text };
    })) };
  const input = await prepareReferencePropositionReviewInput(context, draft);
  const finalized = await finalizeReferencePropositions(context, draft, {
    version: 1, protocol: 'review-reference-proposition-review-v1', reviewId: input.reviewId,
    contextHash: input.contextHash, draftHash: input.draftHash,
    anchors: draft.anchors.map(anchor => ({ id: anchor.id, decision: 'accept', roleSupported: true,
      completeMeaning: true, scopePreserved: true, reason: 'Synthetic fixed vote, not semantic certification.' })) });
  assert.ok(finalized.status === 'ready'); const bundle = finalized.bundle;
  const freezeId = '12345678-1234-1234-1234-123456789abc';
  const reply: Extract<ArgumentReferencePropositionDisclosureReply, {status:'ready'}> = { status: 'ready', context, bundle,
    binding: { freezeId, contractHash: context.contractHash, contextHash: bundle.contextHash, bundleHash: bundle.bundleHash } };
  const premise = '本次合成包裹带有蓝印', outcome = mode === 'opposite' ? '本次合成包裹不会进入二号通道' : '本次合成包裹会进入二号通道';
  const text = mode === 'reverse' ? `${outcome}，所以${premise}。系统已联网。`
    : mode === 'compound' ? `${premise}且系统已联网，所以${outcome}。` : `${premise}，所以${outcome}。系统已联网。`;
  const answer: ReviewComparisonAnswer = { activityId: 'synthetic-proposition-shadow', questionText: '说明本次分拣推理。',
    evidence: { messageId: 'synthetic-answer', answer: text, hintLevel: 0, targetKnowledgeNames: fixture.selectors.knowledgeTargets,
      questionIntent: { version: 1, questionMessageId: fixture.selectors.questionMessageId,
        knowledgeTargets: fixture.selectors.knowledgeTargets, assessment: fixture.selectors.assessment, referenceRubric: fixture.selectors.referenceRubric,
        referenceStructure: { version: 1, status: 'fixed', originQuestionMessageId: fixture.frozen.originQuestionMessageId,
          freezeId, contractHash: fixture.frozen.contractHash, selectorsHash: await argumentContextHash(fixture.selectors), reasons: [] } } } };
  let calls = 0, reads = 0;
  const requests: unknown[] = [];
  const raw = (packetId: string) => ({ version: 1, packetId, requirements: [],
    claims: [{ id: 'A1', role: 'fact', quote: mode === 'nested' ? `${premise}，所以${outcome}`
      : mode === 'compound' ? `${premise}且系统已联网` : premise },
    { id: 'A2', role: 'conclusion', quote: outcome }, ...(mode === 'compound' ? [] : [{ id: 'A3', role: 'condition', quote: '系统已联网' }])],
    edges: mode === 'opposite' ? [] : [{ id: 'E1', source: mode === 'reverse' ? 'A2' : 'A1',
      target: mode === 'reverse' ? 'A1' : 'A2', relation: 'support', quote: text }] });
  const valid = (canonical: FrozenReferenceShadowInput) => {
    const wire = buildFrozenPropositionReferenceInput(canonical, bundle);
    return { version: 5, evaluationId: canonical.evaluationId, contractHash: context.contractHash, bundleHash: bundle.bundleHash,
      items: wire.frames.flatMap(frame => frame.items.map(item => {
        const inference = item.criterionId === 'inference_link';
        const matches = item.requiredNodeIds.map(nodeId => {
          const node = frame.nodes.find(node => node.id === nodeId)!;
          return { claimId: nodeId.endsWith('/N3') && mode === 'compound' ? 'user/A1' : `user/A${nodeId.slice(-1)}`,
            propositionId: node.propositions[0].id };
        });
        return { itemId: item.itemId, verdict: inference && mode === 'reverse' ? 'partial' : inference && mode === 'opposite' ? 'contradicted' : 'supported',
          scope: 'same', matches,
          ...(inference ? { edgeIds: mode === 'opposite' ? [] : ['user/E1'],
            direction: mode === 'reverse' ? 'reverse' : mode === 'opposite' ? 'not_required' : 'correct',
            premises: mode === 'opposite' ? 'not_required' : 'complete' } : {}),
          ...(inference && mode === 'opposite' ? { opposition: { ...matches.find(pair => pair.claimId === 'user/A2')!,
            userOutcome: '不会进入二号通道', referenceOutcome: '会进入二号通道' } } : {}) };
      })) };
  };
  const model: FrozenPropositionShadowModel = { extract: async value => { calls++; requests.push(clone(value)); return raw(value.packetId); },
    review: async value => { calls++; requests.push(buildFrozenPropositionReferenceInput(value, bundle)); return valid(value); } };
  const deps = { readReferencePropositions: async () => { reads++; return clone(reply) as ArgumentReferencePropositionDisclosureReply; } };
  return { fixture, context, bundle, reply, answer, model, deps, valid, raw, calls: () => calls, reads: () => reads, requests };
}
try {
  for (const mode of ['forward', 'compound', 'reverse', 'opposite', 'nested'] as const) {
    const r = await rig(mode), out = await evaluateFrozenPropositionReviewReferenceShadow(r.answer, r.deps, r.model);
    assert.equal(out.result.status, mode === 'nested' ? 'held' : 'reviewed', JSON.stringify(out.result));
    if (mode === 'nested') assert.deepEqual(out.result.reasons, ['non_atomic_inference_endpoint']);
    else assert.equal(out.result.frames[0].status, mode === 'reverse' ? 'partial' : mode === 'opposite' ? 'contradicted' : 'covered');
    assert.equal(out.result.modelRequests.total, 2); assert.equal(r.calls(), 2);
    assert.equal(out.result.scoreWrite, 'disabled'); assert.equal(out.result.cognitionWrite, 'disabled');
    assert.equal(out.result.semanticTruth, 'not_certified'); assert.equal(out.result.propositionBinding?.bundleHash, r.bundle.bundleHash);
    if (mode !== 'nested') assert.equal(r.reads(), 4);
    pass(`${mode}: authenticated-reader mock→v5 P pairing→original complete-structure host gate; fixed votes not accuracy`);
  }
  const noAnchors = await rig();
  const absent = await evaluateFrozenPropositionReviewReferenceShadow(noAnchors.answer,
    { readReferencePropositions: async () => ({ status: 'held', reasons: ['propositions_unavailable'] }) }, noAnchors.model);
  assert.equal(absent.result.status, 'held'); assert.equal(noAnchors.calls(), 0);
  pass('missing pre-question anchors held before extraction, no lazy creation/default protocol fallback');

  for (const failure of ['missing-condition', 'missing-edge', 'legacy-wire', 'borrowed-proposition'] as const) {
    const r = await rig();
    r.model.review = async input => {
      const raw = r.valid(input), inference = raw.items.find(item => item.itemId.endsWith('/I3'))! as any;
      if (failure === 'missing-condition') inference.matches = inference.matches.filter((pair: any) => pair.claimId !== 'user/A3');
      else if (failure === 'missing-edge') inference.edgeIds = [];
      else if (failure === 'legacy-wire') raw.version = 4;
      else inference.matches[0].propositionId = 'reference/other/proposition/P-N1';
      return raw;
    };
    const out = await evaluateFrozenPropositionReviewReferenceShadow(r.answer, r.deps, r.model);
    assert.equal(out.result.status, 'held'); assert.equal(out.result.observations.length, 0);
    assert.equal(out.result.modelRequests.total, 2);
    assert.notDeepEqual(out.result.reasons, ['shadow_evaluation_unavailable']);
    pass(`${failure}: new v5 strict evidence/controlled diagnostic, no completion repair or v4 fallback`);
  }

  for (const when of [2, 3, 4]) {
    const r = await rig(); let reads = 0;
    const out = await evaluateFrozenPropositionReviewReferenceShadow(r.answer, { readReferencePropositions: async () => {
      const reply = clone(r.reply); if (++reads === when) reply.binding.bundleHash = 'b'.repeat(64); return reply;
    } }, r.model);
    assert.equal(out.result.status, 'held'); assert.deepEqual(out.result.reasons, ['frozen_reference_changed']);
    assert.equal(out.result.observations.length, 0); assert.equal(r.calls(), when - 2);
    pass(`source/bundle changed at read ${when} held; no stale observations or extra requests`);
  }
  const forged = await rig();
  const bad = clone(forged.reply); bad.binding.freezeId = '00000000-0000-0000-0000-000000000000';
  const mismatched = await evaluateFrozenPropositionReviewReferenceShadow(forged.answer, { readReferencePropositions: async () => bad }, forged.model);
  assert.equal(mismatched.result.status, 'held'); assert.equal(forged.calls(), 0);
  pass('binding freezeId must equal original host receipt, not merely a well-formed self-hash');

  const abort = await rig(), controller = new AbortController(); controller.abort();
  assert.deepEqual((await evaluateFrozenPropositionReviewReferenceShadow(abort.answer, abort.deps, abort.model,
    { signal: controller.signal })).result.reasons, ['shadow_aborted']); assert.equal(abort.reads(), 0);
  const timeout = await evaluateFrozenPropositionReviewReferenceShadow(abort.answer,
    { readReferencePropositions: () => new Promise(() => {}) }, abort.model, { readTimeoutMs: 1 });
  assert.deepEqual(timeout.result.reasons, ['shadow_timeout']); assert.equal(abort.calls(), 0);
  pass('first host read also bounded/abortable; a hang cannot consume model budget');

  const capture = await rig();
  let release!: () => void; const pause = new Promise<void>(resolve => { release = resolve; }); let reads = 0;
  const deps = { readReferencePropositions: async () => { if (++reads === 1) await pause; return clone(capture.reply); } };
  const options = { readTimeoutMs: 1000, timeoutMs: 1000 };
  const work = evaluateFrozenPropositionReviewReferenceShadow(capture.answer, deps, capture.model, options);
  deps.readReferencePropositions = async () => assert.fail('late method replacement');
  capture.model.review = async () => assert.fail('late model replacement'); options.timeoutMs = 1;
  capture.answer.evidence.answer = 'late user replacement'; release();
  assert.equal((await work).result.status, 'reviewed');
  pass('answer/read/model/options captured before first await; late changes cannot switch authority or wire');

  const privacy = await rig(); privacy.answer.evidence.questionIntent.cognitionTarget = { recordId: 'PRIVATE-RECORD',
    revisionId: 'PRIVATE-REV', branchId: 'PRIVATE-BRANCH', nodeId: 'PRIVATE-NODE', purpose: 'give_evidence' };
  let sawPersonal = false;
  const privacyOut = await evaluateFrozenPropositionReviewReferenceShadow(privacy.answer, { readReferencePropositions: async intent => {
    sawPersonal ||= JSON.stringify(intent).includes('PRIVATE'); return clone(privacy.reply);
  } }, privacy.model);
  assert.equal(privacyOut.result.status, 'reviewed'); assert.equal(sawPersonal, false);
  assert.ok(!JSON.stringify(privacy.requests).includes('PRIVATE'));
  pass('personal coordinate/profile remains absent from all reference reader/model inputs');

  const hook = await rig(); let reviews = 0;
  const asyncHook = await evaluateFrozenReviewReferenceShadow(hook.answer,
    { readReference: async () => ({ status: 'ready', context: clone(hook.context) }) }, {
      extract: async value => hook.raw(value.packetId), prepareReview: async () => undefined,
      review: async () => { reviews++; return {}; },
    });
  assert.equal(asyncHook.result.status, 'held'); assert.deepEqual(asyncHook.result.reasons, ['invalid_review_preflight']);
  assert.equal(asyncHook.result.modelRequests.reference, 0); assert.equal(reviews, 0);
  pass('asynchronous preflight is not success; second invocation counted only after synchronous preparation');

  const client = await rig(); let hostReads = 0;
  const api: ReviewArgumentQuestionApi = {
    getEnvironment: async () => ({ status: 'available', environmentId: 'offline-environment', rootScopeId: 'offline-root' } as any),
    freezeQuestion: async () => assert.fail('no question creation on read'), verifyQuestion: async () => ({ status: 'current', reasons: [] }),
    readQuestion: async () => ({ status: 'ready', context: clone(client.context) }),
    readQuestionPropositions: async () => { hostReads++; return clone(client.reply); },
  };
  const reader = createReviewArgumentQuestionClient('offline-project', 'offline-session', () => api);
  assert.equal((await reader.readReferencePropositions(client.answer.evidence.questionIntent)).status, 'ready'); assert.equal(hostReads, 1);
  api.readQuestionPropositions = async () => ({ ...clone(client.reply), binding: { ...client.reply.binding, contextHash: 'b'.repeat(64) } });
  assert.equal((await reader.readReferencePropositions(client.answer.evidence.questionIntent)).status, 'held');
  pass('client explicitly reads independent baseline then retained anchors; mismatched host view cannot pass');
} finally { globalThis.fetch = fetchBefore; }
console.log(`Proposition shadow checks: ${checks} offline groups; no cloud, real vault, score/cognition writes or semantic accuracy claim.`);
