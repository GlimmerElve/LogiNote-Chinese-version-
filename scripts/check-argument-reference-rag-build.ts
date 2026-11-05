import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { saveVaultSnapshot } from '../src/electron/vaultSnapshot.ts';
import { createArgumentProjectionEnvironmentRegistry } from '../src/electron/rag/argumentProjectionEnvironment.ts';
import { createArgumentReferenceBuildService } from '../src/electron/rag/argumentReferenceBuildService.ts';
import { createArgumentReferenceRagBuildService, ARGUMENT_REFERENCE_RAG_BUILD_LIMITS } from '../src/electron/rag/argumentReferenceRagBuildService.ts';
import type { ArgumentReferenceModelAdapter, ArgumentReferenceModelConfig } from '../src/electron/rag/argumentReferenceModel.ts';
import type { ArgumentProjectionModelRequest } from '../src/services/argumentContext/buildPrompts.ts';
import type { ArgumentProjectionBuildInput, ArgumentProjectionDraft, ArgumentProjectionReviewInput, ArgumentProjectionSourceReviewInput } from '../src/services/argumentContext/buildTypes.ts';
import type { ArgumentReferenceRagBuildPrepareReply } from '../src/services/argumentContext/referenceRagBuildTypes.ts';
import { fixedAcceptProjectionReview, fixedProjectionSelection } from './argument-projection-build-fixture.ts';
import { buildArgumentProjectionReviewInput, finalizeArgumentProjectionBuild } from '../src/services/argumentContext/construction.ts';
import { sourcePropositionLedgerFileName, createPersistentSourcePropositionStore } from '../src/electron/rag/referenceSourcePropositionStore.ts';
import type { NoteItem } from '../src/types.ts';

// Real host leases and isolated synthetic saved files; all five responses are
// fixed protocol fixtures, not measured semantic quality or real provider calls.
const fetchBefore = globalThis.fetch, clockBefore = Date.now;
globalThis.fetch = async () => assert.fail('Network forbidden in combined reference RAG build checks');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'loginote-reference-rag-build-'));
let fixture = 0, checks = 0;
const pass = (label: string) => { checks++; console.log(`PASS ${label}`); };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const deadline = async <T>(promise: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('synthetic_deadlock')), 5000); })]); }
  finally { if (timer) clearTimeout(timer); }
};
const noteFor = (id: string): NoteItem => ({ id, title: '合成参考选择过载', noteType: 'knowledge',
  content: '# 定义\n\n选择过载是指选项超过认知处理范围时难以决策。\n\n## 条件\n\n当选项超过可处理范围时，选择过载才可能发生。',
  createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T01:00:00.000Z', tags: [], links: [], backlinks: [], dueDates: [],
  referenceSources: [{ title: '合成测试出处，不作真实事实认证', type: 'web', url: 'https://example.org/synthetic-only' }] });
function structureDraft(input: Pick<ArgumentProjectionBuildInput, 'buildId' | 'quotes'>): ArgumentProjectionDraft {
  const first = input.quotes.find(q => q.completeSentence && q.evidence.quote.includes('是指'))!;
  const condition = input.quotes.find(q => q.completeSentence && q.evidence.quote.includes('才可能'))!;
  assert.ok(first && condition);
  return { version: 1, buildId: input.buildId,
    nodes: [{ id: 'N1', role: 'definition', quoteIds: [first.quoteId] }, { id: 'N2', role: 'condition', quoteIds: [condition.quoteId] }],
    relations: [{ id: 'E1', sourceNodeId: 'N2', targetNodeId: 'N1', kind: 'requires_condition', quoteIds: [condition.quoteId] }], groups: [],
    scopes: [{ id: 'S1', seedNodeId: 'N1', task: 'definition', requiredNodeIds: ['N1', 'N2'], requiredRelationIds: ['E1'],
      requiredGroupIds: [], quoteIds: [first.quoteId, condition.quoteId] }] };
}
type Stage = 'quality' | 'structure-draft' | 'structure-review' | 'proposition-draft' | 'proposition-review';
function stageOf(request: ArgumentProjectionModelRequest): Stage {
  const payload = JSON.parse(request.userInput);
  if (payload.protocol === 'review-source-proposition-review-input-v1') return 'proposition-review';
  if (['review-source-proposition-context-v1', 'review-task-source-proposition-context-v2'].includes(payload.reference?.protocol)) return 'proposition-draft';
  return request.bindingId.startsWith('source-review:') ? 'quality' : request.stage === 'extract' ? 'structure-draft' : 'structure-review';
}
function fixedResponse(request: ArgumentProjectionModelRequest, reject: boolean): string {
  const payload = JSON.parse(request.userInput), stage = stageOf(request);
  if (stage === 'quality') return JSON.stringify({ version: 1, reviewId: payload.reviewId, decision: 'eligible',
    relevantContentPresent: true, noCriticalSourceGaps: true,
    quoteIds: [payload.quotes.find((q: ArgumentProjectionBuildInput['quotes'][number]) => q.completeSentence && q.evidence.quote.includes('是指')).quoteId],
    reason: '合成独立来源审核票，仅验证程序协议。' });
  if (stage === 'structure-draft') {
    const draft = structureDraft(payload);
    if (payload.protocol === 'argument-projection-selection-v2') {
      const selection = fixedProjectionSelection(draft);
      selection.scopes[0].selectedNodeIds = []; // The host must close the selected E1 endpoints.
      return JSON.stringify(selection);
    }
    return JSON.stringify(draft);
  }
  if (stage === 'structure-review' && ['argument-projection-source-review-v2', 'argument-projection-task-review-v3'].includes(payload.protocol)) {
    const vote = fixedAcceptProjectionReview(payload as ArgumentProjectionReviewInput);
    // Independent, explicitly authored source obligations for this synthetic text,
    // not generated from candidate acceptance or used as model-quality evidence.
    const first = payload.quotes.find((q: ArgumentProjectionBuildInput['quotes'][number]) => q.completeSentence && q.evidence.quote.includes('是指'));
    const condition = payload.quotes.find((q: ArgumentProjectionBuildInput['quotes'][number]) => q.completeSentence && q.evidence.quote.includes('才可能'));
    return JSON.stringify({ ...vote, version: payload.protocol === 'argument-projection-task-review-v3' ? 3 : 2, protocol: payload.protocol,
      nodes: vote.nodes.map(row => ({ ...row, completeMeaning: true })),
      sourceCoverage: (payload as ArgumentProjectionSourceReviewInput).sourceCoverageTargets.map(row => ({ ...row, decision: 'accept',
        reason: 'Fixed synthetic full-source obligation, not a real semantic review.',
        restrictions: row.quoteId === condition.quoteId ? [{ kind: 'requires_condition', sourceQuoteIds: [condition.quoteId], targetQuoteIds: [first.quoteId],
          ...(payload.protocol === 'argument-projection-task-review-v3' ? { representation: 'edge' } : {}) }] : [],
        inferences: [] })) });
  }
  if (stage === 'structure-review') return JSON.stringify(fixedAcceptProjectionReview(payload as ArgumentProjectionReviewInput));
  if (stage === 'proposition-draft' && payload.protocol === 'review-source-proposition-parent-selection-input-v3')
    return JSON.stringify({ version: 3, protocol: 'review-source-proposition-parent-selection-v3', contextHash: payload.contextHash,
      anchors: payload.parentChoices.map((parent: { parentChoiceId: string }) => ({ parentChoiceId: parent.parentChoiceId })) });
  if (stage === 'proposition-draft' && payload.protocol === 'review-source-proposition-selection-input-v2')
    return JSON.stringify({ version: 2, protocol: 'review-source-proposition-selection-v2', contextHash: payload.contextHash,
      anchors: payload.parentChoices.map((parent: { parentChoiceId: string; text: string }) => ({ parentChoiceId: parent.parentChoiceId, text: parent.text })) });
  if (stage === 'proposition-draft') return JSON.stringify({ version: 1, protocol: 'review-source-proposition-draft-v1', contextHash: payload.contextHash,
    anchors: payload.reference.projection.nodes.map((node: any, index: number) => {
      const span = node.evidence[0], quote = payload.reference.quotes.find((q: any) => q.evidence.start === span.start
        && q.evidence.end === span.end && q.evidence.quote === span.quote);
      assert.ok(quote);
      return { id: `P${index + 1}`, nodeId: node.id, quoteId: quote.quoteId, start: span.start, end: span.end, text: span.quote };
    }) });
  const scoped = payload.reference.protocol === 'review-task-source-proposition-context-v2';
  return JSON.stringify({ version: scoped ? 2 : 1, protocol: scoped ? 'review-task-source-proposition-review-v2' : 'review-source-proposition-review-v1', reviewId: payload.reviewId,
    contextHash: payload.contextHash, draftHash: payload.draftHash,
    anchors: payload.draft.anchors.map((anchor: any) => ({ id: anchor.id, decision: reject ? 'unknown' : 'accept', roleSupported: !reject,
      completeMeaning: !reject, scopePreserved: !reject, reason: '合成第二请求审核；不宣称真值或用户已掌握。' })) });
}
async function rig(protocol: 'legacy-v1' | 'selection-v2' | 'source-grounded-v2' | 'task-grounded-v3' = 'legacy-v1') {
  const dataRoot = path.join(temporary, `fixture-${++fixture}`), roots = { dataRoot, vaultRoot: path.join(dataRoot, 'vault'), userStateDir: path.join(dataRoot, 'state') };
  let notes = [noteFor(`synthetic-note-${fixture}`)], available = true, reject = false;
  await saveVaultSnapshot(roots.vaultRoot, roots.userStateDir, notes);
  const registry = createArgumentProjectionEnvironmentRegistry(() => roots, () => available);
  const config: ArgumentReferenceModelConfig = { fingerprint: 'a'.repeat(64), providerLabel: 'Synthetic provider', modelName: 'synthetic-fixed-model', isRemote: true,
    provider: { apiType: 'openai-compatible', baseUrl: 'https://example.org/no-network', apiKey: 'synthetic-private-key', selectedModel: 'synthetic-fixed-model', models: ['synthetic-fixed-model'] } };
  const calls: Stage[] = []; let reads = 0, hook: ((stage: Stage, signal: AbortSignal) => Promise<void>) | undefined, readHook: (() => Promise<void>) | undefined;
  let sourceFault: 'none' | 'unknown' | 'v1' = 'none';
  const model: ArgumentReferenceModelAdapter = { read: async () => { reads++; await readHook?.(); return structuredClone(config); },
    invoke: async (_config, request, signal) => {
      assert.equal(request.skipMemoryInjection, true); assert.equal(request.skipProfileInjection, true); assert.equal(request.thinkingMode, 'disabled');
      const stage = stageOf(request); calls.push(stage); await hook?.(stage, signal);
      if (['source-grounded-v2', 'task-grounded-v3'].includes(protocol) && stage === 'structure-review' && sourceFault !== 'none') {
        const payload = JSON.parse(request.userInput);
        if (sourceFault === 'v1') return JSON.stringify(fixedAcceptProjectionReview(payload));
        const value = JSON.parse(fixedResponse(request, reject)); value.sourceCoverage[0].decision = 'unknown'; return JSON.stringify(value);
      }
      return fixedResponse(request, reject);
    } };
  const structure = createArgumentReferenceBuildService({ environments: registry, model,
    draftProtocol: protocol === 'source-grounded-v2' || protocol === 'task-grounded-v3' ? 'selection-v2' : protocol,
    reviewProtocol: protocol === 'source-grounded-v2' || protocol === 'task-grounded-v3' ? protocol : 'legacy-v1' });
  const service = createArgumentReferenceRagBuildService({ environments: registry, structure, model,
    propositionDraftProtocol: protocol === 'source-grounded-v2' || protocol === 'task-grounded-v3' ? 'owned-parent-choice-v3' : protocol === 'selection-v2' ? 'owned-parent-text-v2' : 'legacy-v1' });
  const owner = 11, env = await registry.getEnvironment(owner); assert.ok(env.status === 'available');
  const environmentId = env.environmentId, ref = { kind: 'knowledge-note' as const, entityId: notes[0].id }, request = { environmentId, ref };
  const prepare = () => service.prepare(owner, request);
  const runTicket = (ticket: Extract<ArgumentReferenceRagBuildPrepareReply, { status: 'prepared' }>) =>
    service.run(owner, { environmentId, ticketId: ticket.ticketId, consent: 'process-reference-with-propositions' });
  const ticket = async () => { const ready = await prepare(); assert.ok(ready.status === 'prepared', JSON.stringify(ready)); return ready; };
  const save = async (next: NoteItem[]) => {
    const previous = structuredClone(notes); service.observeNoteSnapshot(next, previous); structure.observeNoteSnapshot(next, previous);
    notes = structuredClone(next); await saveVaultSnapshot(roots.vaultRoot, roots.userStateDir, notes);
  };
  return { roots, registry, model, config, structure, service, owner, environmentId, ref, request, calls, prepare, runTicket, ticket, save,
    notes: () => structuredClone(notes), reads: () => reads, reject: () => { reject = true; }, suspend: () => { available = false; },
    sourceFault: (fault: typeof sourceFault) => { sourceFault = fault; },
    hook: (next: typeof hook) => { hook = next; }, readHook: (next: typeof readHook) => { readHook = next; } };
}
function small(reply: unknown, root: string) {
  const text = JSON.stringify(reply);
  for (const forbidden of [root, 'synthetic-private-key', 'canonicalText', 'systemPrompt', 'proof', 'rootScopeId', 'fingerprint', 'apiKey', '"provider":'])
    assert.ok(!text.includes(forbidden), forbidden);
}
async function republish(r: Awaited<ReturnType<typeof rig>>, suffix: string) {
  await r.registry.withEnvironment(r.owner, r.environmentId, async runtime => {
    const input = await runtime.host.withSource(r.ref, async input => input); assert.ok(input);
    const draft = structureDraft(input), review = fixedAcceptProjectionReview(await buildArgumentProjectionReviewInput(input, draft));
    const result = await finalizeArgumentProjectionBuild(input, draft, review);
    const publication = await runtime.store.publish({ publicationId: `synthetic-republication-${suffix}`, result, proof: { input, draft, review },
      expectedActiveHash: result.authority.structureHash });
    assert.equal(publication.status, 'published');
  });
}
try {
  const taskGrounded = await rig('task-grounded-v3');
  assert.equal((await deadline(taskGrounded.runTicket(await taskGrounded.ticket()))).status, 'published');
  assert.deepEqual(taskGrounded.calls, ['quality', 'structure-draft', 'structure-review', 'proposition-draft', 'proposition-review']);
  const taskRestart = createArgumentReferenceRagBuildService({ environments: taskGrounded.registry,
    structure: taskGrounded.structure, model: taskGrounded.model, propositionDraftProtocol: 'owned-parent-choice-v3' });
  assert.equal((await taskRestart.status(taskGrounded.owner, taskGrounded.request)).status, 'available');
  assert.equal(taskGrounded.calls.length, 5);
  taskRestart.revoke(); taskGrounded.service.revoke(); taskGrounded.structure.revoke(); taskGrounded.registry.revoke();
  pass('main v3源审实际五阶段合成dispatch／保存／重建读取，不额外调用模型或省略命题独立审核');
  for (const fault of ['unknown', 'v1'] as const) {
    const blocked = await rig('task-grounded-v3'); blocked.sourceFault(fault);
    assert.equal((await deadline(blocked.runTicket(await blocked.ticket()))).status, 'held');
    assert.deepEqual(blocked.calls, ['quality', 'structure-draft', 'structure-review']);
    blocked.service.revoke(); blocked.structure.revoke(); blocked.registry.revoke();
  }
  pass('v3原文unknown或旧v1票仍3次held，不以局部可用名义猜测来源覆盖或fallback');
  const selected = await rig('selection-v2'), selectedTicket = await selected.ticket();
  assert.equal(selected.calls.length, 0);
  const selectionReady = await deadline(selected.runTicket(selectedTicket));
  assert.ok(selectionReady.status === 'published', JSON.stringify({ selectionReady, calls: selected.calls }));
  assert.equal(selectionReady.propositionCount, 2);
  assert.deepEqual(selected.calls, ['quality', 'structure-draft', 'structure-review', 'proposition-draft', 'proposition-review']);
  await selected.registry.withEnvironment(selected.owner, selected.environmentId, async (runtime, _roots, scope) => {
    const active = await runtime.store.read(selected.ref); assert.ok(active);
    assert.deepEqual(active.projection.build.scopes[0].requiredNodeIds, ['N1', 'N2']);
    const proof = await createPersistentSourcePropositionStore(path.join(selected.roots.dataRoot, 'argument-propositions'), runtime.store, scope.rootScopeId).read(selected.ref);
    assert.ok(proof); assert.deepEqual(proof.draft.anchors.map(anchor => anchor.id), ['P1', 'P2']);
    assert.equal(proof.draft.version, 1); // New wire, unchanged canonical proof/store.
  });
  const selectionRestart = createArgumentReferenceRagBuildService({ environments: selected.registry, structure: selected.structure, model: selected.model,
    propositionDraftProtocol: 'owned-parent-text-v2' });
  assert.equal((await selectionRestart.status(selected.owner, selected.request)).status, 'available');
  assert.equal(selected.calls.length, 5); selectionRestart.revoke(); selected.service.revoke(); selected.structure.revoke(); selected.registry.revoke();
  pass('显式新图/父原话协议→原canonical审票→真实临时持久资产五阶段联验；重建服务读取新增0请求');
  const grounded = await rig('source-grounded-v2'), groundedTicket = await grounded.ticket();
  assert.equal(grounded.calls.length, 0);
  const groundedReady = await deadline(grounded.runTicket(groundedTicket));
  assert.ok(groundedReady.status === 'published', JSON.stringify({ groundedReady, calls: grounded.calls }));
  assert.deepEqual(grounded.calls, ['quality', 'structure-draft', 'structure-review', 'proposition-draft', 'proposition-review']);
  await grounded.registry.withEnvironment(grounded.owner, grounded.environmentId, async (runtime, _roots, scope) => {
    const proof = await createPersistentSourcePropositionStore(path.join(grounded.roots.dataRoot, 'argument-propositions'), runtime.store, scope.rootScopeId).read(grounded.ref);
    assert.ok(proof); assert.deepEqual(proof.result.projection.build.scopes[0].requiredNodeIds, ['N1', 'N2']);
    for (const anchor of proof.bundle.anchors) {
      assert.equal(anchor.start, anchor.parent.evidence.start); assert.equal(anchor.end, anchor.parent.evidence.end);
      assert.equal(anchor.text, anchor.parent.evidence.quote);
    }
  });
  assert.equal((await grounded.structure.status(grounded.owner, grounded.request)).status, 'available');
  const groundedRestart = createArgumentReferenceRagBuildService({ environments: grounded.registry, structure: grounded.structure, model: grounded.model,
    propositionDraftProtocol: 'owned-parent-choice-v3' });
  assert.equal((await groundedRestart.status(grounded.owner, grounded.request)).status, 'available');
  assert.equal(grounded.calls.length, 5);
  groundedRestart.revoke(); grounded.service.revoke(); grounded.structure.revoke(); grounded.registry.revoke();
  pass('main同协议：源独立v2审＋整父Q v3选择实际五阶段合成dispatch，持久proof/重建读取0新增请求');
  for (const fault of ['unknown', 'v1'] as const) {
    const blocked = await rig('source-grounded-v2'); blocked.sourceFault(fault);
    const reply = await deadline(blocked.runTicket(await blocked.ticket())); assert.equal(reply.status, 'held');
    assert.deepEqual(blocked.calls, ['quality', 'structure-draft', 'structure-review']);
    await blocked.registry.withEnvironment(blocked.owner, blocked.environmentId, async runtime => assert.equal(await runtime.store.read(blocked.ref), null));
    assert.equal((await blocked.service.status(blocked.owner, blocked.request)).status, 'missing');
    blocked.service.revoke(); blocked.structure.revoke(); blocked.registry.revoke();
  }
  pass('新host源审unknown或旧v1响应均只3次held：不fallback、不存完整图、不调用命题模型');
  const r = await rig();
  const missing = await r.service.status(r.owner, r.request); assert.ok(missing.status === 'missing' && missing.reasonCode === 'review_incomplete');
  const prepared = await r.ticket(); assert.equal(prepared.summary.stage, 'structure-and-propositions'); assert.equal(prepared.summary.maximumModelRequests, 5);
  assert.equal(prepared.summary.reviewBudget, 'checked-after-extraction'); assert.equal(r.calls.length, 0);
  assert.equal((await r.ticket()).ticketId, prepared.ticketId); small(prepared, r.roots.dataRoot); small(missing, r.roots.dataRoot);
  pass('prepare/status零模型请求，缺结构明示5阶段许可，重复prepare复用小票不泄露私有信息');

  const oldConsent = await r.service.run(r.owner, { environmentId: r.environmentId, ticketId: prepared.ticketId, consent: 'process-reference' });
  assert.deepEqual(oldConsent, { status: 'held', reasonCode: 'invalid_request' }); assert.equal(r.calls.length, 0);
  assert.equal((await r.service.run(r.owner + 1, { environmentId: r.environmentId, ticketId: prepared.ticketId, consent: 'process-reference-with-propositions' })).status, 'held');
  pass('旧3次consent不能批准新流程，owner隔离在任何模型调用之前');

  const ready = await deadline(r.runTicket(prepared)); assert.ok(ready.status === 'published', JSON.stringify({ ready, calls: r.calls })); assert.equal(ready.propositionCount, 2);
  assert.deepEqual(r.calls, ['quality', 'structure-draft', 'structure-review', 'proposition-draft', 'proposition-review']);
  assert.deepEqual(await r.runTicket(prepared), ready); assert.equal(r.calls.length, 5);
  const available = await r.service.status(r.owner, r.request); assert.ok(available.status === 'available'); assert.equal(available.propositionCount, 2);
  assert.ok((await r.prepare()).status === 'available'); small(ready, r.roots.dataRoot); small(available, r.roots.dataRoot);
  pass('真实临时saved-source→质量→结构→独立结构审→命题→独立命题审→持久保存恰5请求，重复run不重试');

  const restart = createArgumentReferenceRagBuildService({ environments: r.registry, structure: r.structure, model: r.model });
  assert.ok((await restart.status(r.owner, r.request)).status === 'available'); assert.equal(r.calls.length, 5);
  pass('重建服务读取持久资产仍available，零模型调用而非内存缓存冒充持久化');

  const p = await rig(), old = await p.structure.prepare(p.owner, p.request); assert.ok(old.status === 'prepared');
  assert.equal(old.summary.maximumModelRequests, 3);
  assert.ok((await p.structure.run(p.owner, { environmentId: p.environmentId, ticketId: old.ticketId, consent: 'process-reference' })).status === 'published');
  const incomplete = await p.service.status(p.owner, p.request);
  assert.ok(incomplete.status === 'missing' && incomplete.reasonCode === 'propositions_missing' && incomplete.counts?.nodes === 2);
  const propositionTicket = await p.ticket(); assert.equal(propositionTicket.summary.stage, 'propositions'); assert.equal(propositionTicket.summary.maximumModelRequests, 2);
  const oldCalls = p.calls.length; assert.ok((await p.runTicket(propositionTicket)).status === 'published'); assert.equal(p.calls.length - oldCalls, 2);
  pass('旧service仍3次；已审结构只补2次命题审核，status不把仅结构已审标成整体available');

  const failed = await rig(); failed.reject(); const failedTicket = await failed.ticket(), failedReply = await failed.runTicket(failedTicket);
  assert.deepEqual(failedReply, { status: 'held', reasonCode: 'proposition_review_held', structureStatus: 'published', counts: { nodes: 2, relations: 1, groups: 0, scopes: 1 } });
  assert.equal(failed.calls.length, 5); assert.deepEqual(await failed.runTicket(failedTicket), failedReply); assert.equal(failed.calls.length, 5);
  const failedState = await failed.service.status(failed.owner, failed.request); assert.ok(failedState.status === 'missing' && failedState.reasonCode === 'propositions_missing');
  pass('命题unknown整体held，如实保留已published结构状态，失败不自动重试或虚构rollback');

  const changed = await rig(), changedTicket = await changed.ticket(); changed.config.fingerprint = 'b'.repeat(64);
  assert.deepEqual(await changed.runTicket(changedTicket), { status: 'held', reasonCode: 'model_changed' }); assert.equal(changed.calls.length, 0);
  r.config.fingerprint = 'b'.repeat(64); assert.deepEqual(await r.runTicket(prepared), { status: 'held', reasonCode: 'model_changed' }); assert.equal(r.calls.length, 5);
  pass('配置变化撤销未运行票及已缓存run结果，不能复用旧许可或迟到ready');

  const aba = await rig(), abaTicket = await aba.ticket(), sourceA = aba.notes(), sourceB = structuredClone(sourceA);
  sourceB[0].content += '\n合成新条件。'; await aba.save(sourceB); await aba.save(sourceA);
  assert.ok((await aba.runTicket(abaTicket)).status === 'held'); assert.equal(aba.calls.length, 0);
  pass('宿主明确观察保存A→B→A，原文字面恢复也不复活旧票');

  const cancelled = await rig(), cancelTicket = await cancelled.ticket(), entered = deferred(), release = deferred();
  cancelled.hook(async stage => { if (stage === 'quality') { entered.resolve(); await release.promise; } });
  const waiting = cancelled.runTicket(cancelTicket); await deadline(entered.promise);
  const cancel = await cancelled.service.cancel(cancelled.owner, { environmentId: cancelled.environmentId, ticketId: cancelTicket.ticketId });
  assert.deepEqual(cancel, { status: 'cancelled' }); release.resolve(); assert.ok((await deadline(waiting)).status === 'held');
  assert.deepEqual(cancelled.calls, ['quality']); assert.ok((await cancelled.service.status(cancelled.owner, cancelled.request)).status !== 'available');
  pass('第一阶段等待中取消同时取消旧内部票，迟到响应不进入第二阶段或ready');

  const late = await rig(), lateTicket = await late.ticket(), reviewEnter = deferred(), reviewRelease = deferred();
  late.hook(async stage => { if (stage === 'proposition-review') { reviewEnter.resolve(); await reviewRelease.promise; } });
  const lateRun = late.runTicket(lateTicket); await deadline(reviewEnter.promise);
  late.service.revoke(late.owner); reviewRelease.resolve(); const lateReply = await deadline(lateRun);
  assert.ok(lateReply.status === 'held' && lateReply.structureStatus === 'published');
  assert.equal(late.calls.length, 5); const lateStatus = await late.service.status(late.owner, late.request);
  assert.ok(lateStatus.status === 'missing' && lateStatus.reasonCode === 'propositions_missing');
  pass('第五阶段撤销，虽已发5请求仍不保存迟到审核票；已完成结构明确保留');

  const expired = await rig(), expiredTicket = await expired.ticket();
  Date.now = () => Date.parse(expiredTicket.expiresAt) + 1;
  assert.deepEqual(await expired.runTicket(expiredTicket), { status: 'held', reasonCode: 'ticket_expired' }); assert.equal(expired.calls.length, 0);
  Date.now = clockBefore;
  const suspended = await rig(), suspendedTicket = await suspended.ticket(); suspended.suspend();
  assert.deepEqual(await suspended.runTicket(suspendedTicket), { status: 'held', reasonCode: 'environment_changed' }); assert.equal(suspended.calls.length, 0);
  pass('TTL过期和环境不可用在云调用前阻断');

  const shared = await rig(), sharedTicket = await shared.ticket(), firstEnter = deferred(), firstRelease = deferred();
  shared.hook(async stage => { if (stage === 'quality') { firstEnter.resolve(); await firstRelease.promise; } });
  const first = shared.runTicket(sharedTicket); await deadline(firstEnter.promise); const second = shared.runTicket(sharedTicket);
  firstRelease.resolve(); assert.deepEqual(await deadline(first), await deadline(second)); assert.equal(shared.calls.length, 5);
  pass('同票并发run共享单一job，不出现10次重复计费');

  await republish(shared, 'after-ready');
  assert.deepEqual(await shared.runTicket(sharedTicket), { status: 'held', reasonCode: 'source_changed' }); assert.equal(shared.calls.length, 5);
  const republishedStatus = await shared.service.status(shared.owner, shared.request);
  assert.ok(republishedStatus.status === 'missing' && republishedStatus.reasonCode === 'propositions_missing');
  pass('同源同resultHash重发布后旧published run回执也held，独立publication绑定不被物理hash掩盖');

  const raced = await rig(), racedTicket = await raced.ticket(); let republished = false;
  const originalLstat = fs.lstat;
  try {
    fs.lstat = (async (...args: Parameters<typeof fs.lstat>) => {
      const result = await originalLstat(...args);
      // After the persistent proposition asset exists, change the active source
      // publication outside its own read transaction, during the final host checks.
      if (!republished && String(args[0]).includes('argument-propositions') && String(args[0]).endsWith('.json')) {
        republished = true; await republish(raced, 'final-window');
      }
      return result;
    }) as typeof fs.lstat;
    const raceReply = await deadline(raced.runTicket(racedTicket));
    assert.ok(raceReply.status === 'held' && raceReply.structureStatus === 'published'); assert.ok(republished);
    assert.equal(raced.calls.length, 5);
  } finally { fs.lstat = originalLstat; }
  pass('持久命题提交到最终ready的窗口发生同hash重发布，独立最终复查阻断迟到ready');

  const inspectRace = await rig(), inspectTicket = await inspectRace.ticket(); assert.ok((await inspectRace.runTicket(inspectTicket)).status === 'published');
  const raceHost = await inspectRace.registry.withEnvironment(inspectRace.owner, inspectRace.environmentId,
    async (runtime, _roots, scope) => ({ runtime, scope }));
  const raceStore = createPersistentSourcePropositionStore(path.join(inspectRace.roots.dataRoot, 'argument-propositions'), raceHost.runtime.store, raceHost.scope.rootScopeId);
  const retained = await raceStore.read(inspectRace.ref); assert.ok(retained);
  const originalBindingReader = raceHost.runtime.store.withActiveBinding!; let swap = true;
  try {
    raceHost.runtime.store.withActiveBinding = (async (ref, action) => {
      const oldRead = await originalBindingReader(ref, action);
      if (swap) {
        swap = false;
        // First active transaction has released. Replace publication and its
        // authentic asset before inspect's independent proposition read begins.
        await republish(inspectRace, 'inside-inspect');
        const binding = await originalBindingReader(inspectRace.ref, async (_result, _input, binding) => binding); assert.ok(binding);
        assert.equal((await raceStore.publish(inspectRace.ref, binding, retained)).status, 'stored');
      }
      return oldRead;
    }) as typeof originalBindingReader;
    assert.deepEqual(await inspectRace.service.status(inspectRace.owner, inspectRace.request), { status: 'held', reasonCode: 'source_changed' });
    assert.equal(inspectRace.calls.length, 5);
  } finally { raceHost.runtime.store.withActiveBinding = originalBindingReader; }
  pass('inspect的旧active与新的真实持久asset不能互相自证，资产读取后独立再读publication发现竞态');

  const storage = await rig(), storageTicket = await storage.ticket(); assert.ok((await storage.runTicket(storageTicket)).status === 'published');
  const rootScopeId = await storage.registry.withEnvironment(storage.owner, storage.environmentId, async (_runtime, _roots, scope) => scope.rootScopeId);
  const ledgerFile = path.join(storage.roots.dataRoot, 'argument-propositions', sourcePropositionLedgerFileName(rootScopeId));
  await fs.writeFile(ledgerFile, '{synthetic corrupt asset');
  assert.deepEqual(await storage.runTicket(storageTicket), { status: 'held', reasonCode: 'proposition_storage_unavailable' });
  assert.deepEqual(await storage.service.status(storage.owner, storage.request), { status: 'held', reasonCode: 'proposition_storage_unavailable' });
  assert.equal(storage.calls.length, 5);
  pass('持久proof损坏时缓存run和status都held，不以旧内存结果冒称ready或自动付费重建');

  const blockedRead = await rig(), blockedTicket = await blockedRead.ticket(), configEnter = deferred(), configRelease = deferred();
  blockedRead.readHook(async () => { configEnter.resolve(); await configRelease.promise; });
  const blockedRun = blockedRead.runTicket(blockedTicket); await deadline(configEnter.promise);
  assert.deepEqual(await blockedRead.service.cancel(blockedRead.owner, { environmentId: blockedRead.environmentId, ticketId: blockedTicket.ticketId }), { status: 'cancelled' });
  assert.ok((await deadline(blockedRun)).status === 'held'); assert.equal(blockedRead.calls.length, 0);
  configRelease.resolve(); blockedRead.readHook(undefined);
  pass('模型配置读取等待中取消立即结束新job，迟到只读结果也不能启动首个模型请求');

  const bound = await rig(), boundStructure = await bound.structure.prepare(bound.owner, bound.request); assert.ok(boundStructure.status === 'prepared');
  assert.ok((await bound.structure.run(bound.owner, { environmentId: bound.environmentId, ticketId: boundStructure.ticketId, consent: 'process-reference' })).status === 'published');
  const options = { environments: { withEnvironment: bound.registry.withEnvironment.bind(bound.registry) }, structure: {
    prepare: bound.structure.prepare.bind(bound.structure), status: bound.structure.status.bind(bound.structure),
    run: bound.structure.run.bind(bound.structure), cancel: bound.structure.cancel.bind(bound.structure) }, model: { ...bound.model } };
  const capturedService = createArgumentReferenceRagBuildService(options), capturedTicket = await capturedService.prepare(bound.owner, bound.request);
  assert.ok(capturedTicket.status === 'prepared' && capturedTicket.summary.maximumModelRequests === 2);
  options.environments.withEnvironment = async () => assert.fail('Late environments replacement');
  options.model.read = async () => assert.fail('Late model.read replacement');
  options.model.invoke = async () => assert.fail('Late model.invoke replacement');
  options.structure.run = async () => assert.fail('Late structure.run replacement');
  assert.ok((await capturedService.run(bound.owner, { environmentId: bound.environmentId, ticketId: capturedTicket.ticketId, consent: 'process-reference-with-propositions' })).status === 'published');
  assert.equal(bound.calls.length, 5);
  pass('宿主options及model/structure方法在首次await前捕获，迟改对象不能替换执行器');

  const concurrent = await Promise.all([rig(), rig(), rig()]), tickets = await Promise.all(concurrent.map(r => r.ticket()));
  const enterOne = deferred(), enterTwo = deferred(), capacityRelease = deferred();
  concurrent[0].hook(async stage => { if (stage === 'quality') { enterOne.resolve(); await capacityRelease.promise; } });
  concurrent[1].hook(async stage => { if (stage === 'quality') { enterTwo.resolve(); await capacityRelease.promise; } });
  const one = concurrent[0].runTicket(tickets[0]), two = concurrent[1].runTicket(tickets[1]);
  await deadline(Promise.all([enterOne.promise, enterTwo.promise]));
  assert.deepEqual(await concurrent[2].runTicket(tickets[2]), { status: 'held', reasonCode: 'capacity' }); assert.equal(concurrent[2].calls.length, 0);
  capacityRelease.resolve(); assert.ok((await deadline(one)).status === 'published'); assert.ok((await deadline(two)).status === 'published');
  assert.equal(concurrent[0].calls.length, 5); assert.equal(concurrent[1].calls.length, 5);
  pass('多个service实例共享2个全局运行上限，第三票0请求held，释放后无隐藏重试');

  const bounded = await rig();
  for (let index = 0; index < ARGUMENT_REFERENCE_RAG_BUILD_LIMITS.ticketsPerOwner; index++) {
    bounded.config.fingerprint = String(index).padStart(64, '0'); assert.ok((await bounded.prepare()).status === 'prepared');
  }
  bounded.config.fingerprint = 'f'.repeat(64);
  assert.deepEqual(await bounded.prepare(), { status: 'held', reasonCode: 'capacity' }); assert.equal(bounded.calls.length, 0);
  bounded.service.revoke(); bounded.structure.revoke();
  pass('每owner最多8个待确认票，配置不同不能无限积累许可，capacity仍0模型请求');

  const invalid = await rig(); const readsBefore = invalid.reads();
  for (const request of [{ ...invalid.request, proof: {} }, { ...invalid.request, ref: { ...invalid.ref, path: 'private' } },
    { environmentId: invalid.environmentId, ref: { kind: 'knowledge-note', entityId: '..' } }]) assert.ok((await invalid.service.prepare(invalid.owner, request)).status === 'held');
  const getter = Object.defineProperty({ environmentId: invalid.environmentId }, 'ref', { enumerable: true, get: () => assert.fail('Getter must not execute') });
  assert.deepEqual(await invalid.service.prepare(invalid.owner, getter), { status: 'held', reasonCode: 'invalid_request' });
  assert.equal(invalid.reads(), readsBefore); assert.equal(invalid.calls.length, 0);
  assert.equal(ARGUMENT_REFERENCE_RAG_BUILD_LIMITS.inflight, 2);
  pass('闭合selector拒绝path/proof/getter/非法ID，无模型或配置读取');
  console.log(`\n${checks} combined reference RAG build groups passed; cloud requests 0; production writes 0.`);
} finally {
  globalThis.fetch = fetchBefore; Date.now = clockBefore;
  const absolute = path.resolve(temporary), parent = path.resolve(os.tmpdir());
  assert.ok(absolute.startsWith(parent + path.sep) && path.basename(absolute).startsWith('loginote-reference-rag-build-'));
  await fs.rm(absolute, { recursive: true, force: true });
}
