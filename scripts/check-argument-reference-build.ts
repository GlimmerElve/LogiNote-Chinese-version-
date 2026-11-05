import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { saveVaultSnapshot } from '../src/electron/vaultSnapshot.ts';
import { createArgumentProjectionEnvironmentRegistry } from '../src/electron/rag/argumentProjectionEnvironment.ts';
import { createArgumentReferenceBuildService, ARGUMENT_REFERENCE_BUILD_LIMITS,
  type ArgumentReferenceBuildDiagnostic } from '../src/electron/rag/argumentReferenceBuildService.ts';
import type { ArgumentReferenceModelAdapter, ArgumentReferenceModelConfig } from '../src/electron/rag/argumentReferenceModel.ts';
import { createArgumentSourceAdmissionStore, argumentSourceAdmissionFileName } from '../src/electron/rag/argumentSourceAdmission.ts';
import { argumentProjectionLedgerFileName, createPersistentArgumentProjectionStore } from '../src/electron/rag/argumentProjectionStore.ts';
import { readSavedArgumentReferenceNote, readSavedArgumentReferenceNotes } from '../src/electron/rag/argumentSavedSourceReader.ts';
import { createArgumentSearchBridge } from '../src/electron/rag/argumentSearchBridge.ts';
import { createArgumentQuestionFrameService } from '../src/electron/rag/argumentQuestionFrames.ts';
import { buildNoteReferenceChunks, noteReferenceSourceHash } from '../src/electron/rag/noteReferenceChunks.ts';
import { buildTextStructuredDocument } from '../src/electron/rag/structuredDocument.ts';
import { freezeReviewAssessment } from '../src/services/reviewAssessment.ts';
import { buildReviewReferenceCatalog, freezeReviewReferenceRubric } from '../src/services/reviewReferenceRubric.ts';
import { buildArgumentProjectionReviewInput, finalizeArgumentProjectionBuild } from '../src/services/argumentContext/construction.ts';
import type { ArgumentProjectionBuildInput, ArgumentProjectionDraft, ArgumentProjectionReviewInput } from '../src/services/argumentContext/buildTypes.ts';
import type { ArgumentProjectionModelRequest } from '../src/services/argumentContext/buildPrompts.ts';
import { fixedAcceptProjectionReview } from './argument-projection-build-fixture.ts';
import type { SourceAdmissionReview } from '../src/electron/rag/argumentSourceAdmission.ts';
import type { NoteItem, NoteSearchResult, UploadedDocument } from '../src/types.ts';

// Isolated synthetic saved files and fixed model responses only. Never reads the user's
// vault, calls a provider, certifies source truth or changes production cognition/scores.
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('Network forbidden in reference build checks');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'loginote-reference-build-'));
let checks = 0, fixtures = 0;
const pass = (label: string) => { checks++; console.log(`PASS ${label}`); };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const deadline = async <T>(promise: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('synthetic_deadlock')), 5000); })]); }
  finally { if (timer) clearTimeout(timer); }
};
type Stage = 'quality' | 'extract' | 'review';
type Mode = 'accept' | 'quality_unknown' | 'quality_reject' | 'structure_unknown' | 'structure_reject' | 'empty' | 'bad_json' | 'extra' | 'throw'
  | 'review_missing_decision' | 'review_mixed_fields' | 'review_extra_fields';
const noteFor = (id = 'synthetic-knowledge', references = true): NoteItem => ({ id, title: `合成选择过载-${id}`, noteType: 'knowledge',
  content: '# 定义\r\n\r\n选择过载是指选项超过认知处理范围时难以决策。\r\n\r\n## 边界\r\n\r\n当选项超过可处理范围时，选择过载才可能发生。',
  createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T01:00:00.000Z', tags: [], links: [], backlinks: [], dueDates: [],
  ...(references ? { referenceSources: [{ title: '虚构参考，仅用于程序测试', type: 'web' as const, url: 'https://example.org/synthetic-reference' }] } : {}) });
function draftFor(input: Pick<ArgumentProjectionBuildInput, 'buildId' | 'quotes'>): ArgumentProjectionDraft {
  const definition = input.quotes.find(q => q.completeSentence && q.evidence.quote.includes('是指'))!;
  const condition = input.quotes.find(q => q.completeSentence && q.evidence.quote.includes('才可能'))!;
  assert.ok(definition && condition);
  return { version: 1, buildId: input.buildId,
    nodes: [{ id: 'N1', role: 'definition', quoteIds: [definition.quoteId] }, { id: 'N2', role: 'condition', quoteIds: [condition.quoteId] }],
    relations: [{ id: 'E1', sourceNodeId: 'N2', targetNodeId: 'N1', kind: 'requires_condition', quoteIds: [condition.quoteId] }], groups: [],
    scopes: [{ id: 'S1', seedNodeId: 'N1', task: 'definition', requiredNodeIds: ['N1', 'N2'], requiredRelationIds: ['E1'],
      requiredGroupIds: [], quoteIds: [definition.quoteId, condition.quoteId] }] };
}
function stageOf(request: ArgumentProjectionModelRequest): Stage {
  return request.bindingId.startsWith('source-review:') ? 'quality' : request.stage === 'extract' ? 'extract' : 'review';
}
function fixedResponse(request: ArgumentProjectionModelRequest, mode: Mode): string {
  const payload = JSON.parse(request.userInput);
  if (mode === 'throw') throw new Error('synthetic private failure at C:\\private\\file with synthetic-secret');
  if (mode === 'empty') return '';
  if (mode === 'bad_json') return '{not-json';
  const stage = stageOf(request);
  if (stage === 'quality') {
    const response = { version: 1, reviewId: payload.reviewId, decision: mode === 'quality_unknown' ? 'unknown' : mode === 'quality_reject' ? 'review_only' : 'eligible',
      relevantContentPresent: true, noCriticalSourceGaps: mode !== 'quality_reject',
      quoteIds: [payload.quotes.find((q: ArgumentProjectionBuildInput['quotes'][number]) => q.completeSentence && q.evidence.quote.includes('是指')).quoteId],
      reason: '固定合成审核，仅验证协议；不认证事实真理。' };
    return JSON.stringify(mode === 'extra' ? { ...response, quality: 'eligible' } : response);
  }
  if (stage === 'extract') return JSON.stringify(mode === 'extra' ? { ...draftFor(payload), authority: {} } : draftFor(payload));
  const response = fixedAcceptProjectionReview(payload as ArgumentProjectionReviewInput);
  if (mode === 'structure_unknown' || mode === 'structure_reject') {
    response.relations[0].decision = mode === 'structure_unknown' ? 'unknown' : 'reject';
    response.relations[0].relationSupported = false;
    response.relations[0].reason = '固定合成拒绝或不确定：关系未获审核准入。';
  }
  if (mode === 'review_missing_decision' || mode === 'review_mixed_fields' || mode === 'review_extra_fields') {
    const row = response.nodes[0] as unknown as Record<string, unknown>;
    if (mode !== 'review_extra_fields') delete row.decision;
    if (mode !== 'review_missing_decision') row['synthetic-secret-C:\\private\\file'] = 'never expose model field names';
    if (mode === 'review_mixed_fields') row.sourceNodeId = 'N2';
  }
  return JSON.stringify(mode === 'extra' ? { ...response, quality: 'eligible' } : response);
}
async function rig(notes = [noteFor()]) {
  const dataRoot = path.join(temporary, `fixture-${++fixtures}`), roots = { dataRoot, vaultRoot: path.join(dataRoot, 'vault'), userStateDir: path.join(dataRoot, 'user-state') };
  let savedNotes = structuredClone(notes), available = true, time = Date.parse('2026-10-07T03:00:00.000Z');
  await saveVaultSnapshot(roots.vaultRoot, roots.userStateDir, savedNotes);
  const registry = createArgumentProjectionEnvironmentRegistry(() => roots, () => available);
  const config: ArgumentReferenceModelConfig = { fingerprint: 'a'.repeat(64), providerLabel: 'Synthetic provider', modelName: 'synthetic-fixed-model', isRemote: true,
    provider: { apiType: 'openai-compatible', baseUrl: 'https://example.org/no-network', apiKey: 'synthetic-secret', selectedModel: 'synthetic-fixed-model', models: ['synthetic-fixed-model'] } };
  const calls: ArgumentProjectionModelRequest[] = [];
  const modes: Partial<Record<Stage, Mode>> = {};
  let hook: ((stage: Stage, signal: AbortSignal) => Promise<void>) | undefined;
  const diagnostics: ArgumentReferenceBuildDiagnostic[] = [];
  let diagnosticHook: ((diagnostic: Readonly<ArgumentReferenceBuildDiagnostic>) => void) | undefined;
  const model: ArgumentReferenceModelAdapter = {
    read: async () => structuredClone(config),
    invoke: async (_config, request, signal) => {
      assert.equal(request.skipMemoryInjection, true); assert.equal(request.skipProfileInjection, true); assert.equal(request.thinkingMode, 'disabled');
      const captured = structuredClone(request), stage = stageOf(captured); calls.push(captured);
      await hook?.(stage, signal);
      return fixedResponse(captured, modes[stage] ?? 'accept');
    },
  };
  const service = createArgumentReferenceBuildService({ environments: registry, model, now: () => time,
    onDiagnostic: diagnostic => { diagnostics.push(structuredClone(diagnostic)); return diagnosticHook?.(diagnostic); } });
  const owner = 7;
  const environment = await registry.getEnvironment(owner); assert.equal(environment.status, 'available');
  if (environment.status !== 'available') throw new Error('synthetic_fixture_environment');
  const environmentId = environment.environmentId, ref = { kind: 'knowledge-note' as const, entityId: savedNotes[0].id };
  const sourceRequest = { environmentId, ref }, prepare = () => service.prepare(owner, sourceRequest);
  const run = async () => {
    const prepared = await prepare(); assert.equal(prepared.status, 'prepared', JSON.stringify(prepared));
    if (prepared.status !== 'prepared') throw new Error('synthetic_expected_prepared');
    return service.run(owner, { environmentId, ticketId: prepared.ticketId, consent: 'process-reference' });
  };
  const save = async (next: NoteItem[]) => { savedNotes = structuredClone(next); await saveVaultSnapshot(roots.vaultRoot, roots.userStateDir, savedNotes); };
  return { roots, registry, service, model, config, calls, modes, diagnostics, owner, environmentId, ref, sourceRequest, prepare, run, save,
    notes: () => structuredClone(savedNotes), setHook: (next?: typeof hook) => { hook = next; },
    setDiagnosticHook: (next?: typeof diagnosticHook) => { diagnosticHook = next; },
    advance: (amount: number) => { time += amount; }, suspend: () => { available = false; } };
}
async function runtimeFor(r: Awaited<ReturnType<typeof rig>>) {
  return r.registry.withEnvironment(r.owner, r.environmentId, async runtime => runtime);
}
async function inputFor(r: Awaited<ReturnType<typeof rig>>) {
  const response = await r.registry.execute(r.owner, { op: 'source', ...r.sourceRequest }); assert.equal(response.status, 'physical_source');
  if (response.status !== 'physical_source') throw new Error('synthetic_expected_source');
  return response.input;
}
function sourceReview(input: ArgumentProjectionBuildInput, id: string): SourceAdmissionReview {
  return { reviewId: id, policyVersion: 'synthetic-only-v1', decision: 'eligible', evidence: [input.quotes.find(q => q.completeSentence && q.evidence.quote.includes('是指'))!.evidence],
    checks: { provenanceVerified: true, relevantContentPresent: true, noCriticalSourceGaps: true, reviewIndependent: true },
    reason: '固定合成来源票，不证明事实真理。', reviewedAt: '2026-10-07T03:00:00.000Z' };
}
function noPrivate(reply: unknown, note: NoteItem, root: string): void {
  const text = JSON.stringify(reply);
  for (const secret of [root, note.content, 'synthetic-secret', 'C:\\private\\file', 'systemPrompt', 'canonicalText', 'sourceBindingHash', 'apiKey', 'provider:']) assert.ok(!text.includes(secret), secret);
}
async function durableFiles(r: Awaited<ReturnType<typeof rig>>): Promise<{ admission: Buffer | null; projection: Buffer | null }> {
  const runtime = await runtimeFor(r);
  const read = async (file: string) => fs.readFile(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  return { admission: await read(path.join(r.roots.userStateDir, 'argument-source-admission', argumentSourceAdmissionFileName(runtime.host.rootScopeId))),
    projection: await read(path.join(r.roots.userStateDir, 'argument-projections', argumentProjectionLedgerFileName(runtime.host.rootScopeId))) };
}

try {
  const hostRig = await rig(), runtime = await runtimeFor(hostRig), base = await inputFor(hostRig);
  const qualified = await deadline(runtime.recordSourceReview(base, sourceReview(base, 'host-current-review')));
  assert.equal(qualified.sourceQualification.status, 'eligible'); assert.notEqual(qualified.buildId, base.buildId);
  assert.equal(qualified.source.version, base.source.version);
  assert.deepEqual(await inputFor(hostRig), qualified);
  await assert.rejects(runtime.recordSourceReview(base, sourceReview(base, 'host-stale-input')), /source_changed/);
  await assert.rejects(runtime.recordSourceReview({ ...qualified, injected: undefined } as any, sourceReview(qualified, 'host-unknown-field')));
  pass('宿主质量票单源事务合法更新qualification/build绑定；旧快照和undefined未知字段不能重用');

  const earlyGuardDirectory = path.join(temporary, 'guard-before-key');
  await assert.rejects(createArgumentSourceAdmissionStore(earlyGuardDirectory, base.source.rootScopeId).record(base, sourceReview(base, 'guard-before-key'), () => { throw new Error('synthetic_revoked'); }), /synthetic_revoked/);
  await assert.rejects(fs.stat(earlyGuardDirectory), (error: any) => error.code === 'ENOENT');
  const beforeReview = await durableFiles(hostRig);
  await assert.rejects(runtime.recordSourceReview(qualified, sourceReview(qualified, 'guard-reject'), () => { throw new Error('synthetic_run_cancelled'); }), /synthetic_run_cancelled/);
  assert.deepEqual(await durableFiles(hostRig), beforeReview);
  pass('过期宿主/run guard不创建准入key或票，取消的质量提交保留旧字节');

  const originalLstat = fs.lstat;
  try {
    let revoked = false;
    fs.lstat = (async (...args: Parameters<typeof fs.lstat>) => {
      const result = await originalLstat(...args);
      if (String(args[0]).includes('argument-source-admission') && String(args[0]).endsWith('.tmp')) revoked = true;
      return result;
    }) as typeof fs.lstat;
    await assert.rejects(runtime.recordSourceReview(qualified, sourceReview(qualified, 'guard-before-admission-rename'),
      () => { if (revoked) throw new Error('synthetic_revoke_before_rename'); }), /synthetic_revoke_before_rename/);
  } finally { fs.lstat = originalLstat; }
  assert.deepEqual(await durableFiles(hostRig), beforeReview);
  pass('质量票写临时载荷期间撤销，在rename前拒绝且不覆盖旧准入账本');

  const draft = draftFor(qualified), review = fixedAcceptProjectionReview(await buildArgumentProjectionReviewInput(qualified, draft));
  const publication = { publicationId: 'guarded-publication', result: await finalizeArgumentProjectionBuild(qualified, draft, review), proof: { input: qualified, draft, review }, expectedActiveHash: null };
  await assert.rejects(runtime.store.publish(publication, () => { throw new Error('synthetic_run_cancelled'); }), /synthetic_run_cancelled/);
  assert.deepEqual(await durableFiles(hostRig), beforeReview);
  let publishRevoked = false;
  const guardedStoreDirectory = path.join(temporary, 'guard-before-projection-rename');
  const guardedStore = createPersistentArgumentProjectionStore(guardedStoreDirectory, runtime.host,
    { write: async (target, text) => { await fs.writeFile(target, text); publishRevoked = true; } });
  await assert.rejects(guardedStore.publish(publication, () => { if (publishRevoked) throw new Error('synthetic_revoke_before_projection_rename'); }), /synthetic_revoke_before_projection_rename/);
  await assert.rejects(fs.stat(path.join(guardedStoreDirectory, argumentProjectionLedgerFileName(runtime.host.rootScopeId))), (error: any) => error.code === 'ENOENT');
  assert.ok(!(await fs.readdir(guardedStoreDirectory)).some(name => name.endsWith('.tmp')));
  pass('投影写临时载荷期间撤销，在rename前拒绝且清理临时文件，不产生活跃结构');
  assert.equal((await runtime.store.publish(publication)).status, 'published');
  const beforeLate = await durableFiles(hostRig), originalRename = fs.rename;
  try {
    let cancelled = false;
    fs.rename = async (from, to) => {
      if (String(to).includes('argument-projections')) cancelled = true;
      return originalRename(from, to);
    };
    await assert.rejects(runtime.store.publish({ ...publication, publicationId: 'cancel-after-commit', expectedActiveHash: publication.result.authority.structureHash },
      () => { if (cancelled) throw new Error('synthetic_cancelled_after_commit'); }), /synthetic_cancelled_after_commit/);
  } finally { fs.rename = originalRename; }
  assert.notDeepEqual((await durableFiles(hostRig)).projection, beforeLate.projection);
  assert.ok(await runtime.store.read(hostRig.ref));
  pass('发布取消检查在持久rename边界；rename已提交后拒绝当前回执但不谎称文件未写');

  const success = await rig(), beforeSource = success.notes();
  const prepared = await success.prepare(); assert.equal(prepared.status, 'prepared'); noPrivate(prepared, beforeSource[0], success.roots.dataRoot);
  if (prepared.status !== 'prepared') throw new Error('synthetic_expected_prepared');
  assert.equal(prepared.summary.maximumModelRequests, 3); assert.equal(success.calls.length, 0);
  const result = await success.service.run(success.owner, { environmentId: success.environmentId, ticketId: prepared.ticketId, consent: 'process-reference' });
  assert.equal(result.status, 'published', JSON.stringify(result)); assert.deepEqual(success.calls.map(stageOf), ['quality', 'extract', 'review']);
  assert.deepEqual(success.diagnostics, []);
  noPrivate(result, beforeSource[0], success.roots.dataRoot);
  assert.deepEqual(success.notes(), beforeSource);
  const status = await success.service.status(success.owner, success.sourceRequest); assert.equal(status.status, 'available'); noPrivate(status, beforeSource[0], success.roots.dataRoot);
  const repeated = await success.service.run(success.owner, { environmentId: success.environmentId, ticketId: prepared.ticketId, consent: 'process-reference' });
  assert.deepEqual(repeated, result); assert.equal(success.calls.length, 3);
  const already = await success.prepare(); assert.equal(already.status, 'available'); assert.equal(success.calls.length, 3);
  pass('真实saved-reader/registry/准入/持久发布三阶段闭环，prepare无发送，run幂等，公共响应不泄漏原文/key/路径');

  await success.registry.withEnvironment(success.owner, success.environmentId, async (host, roots, scope) => {
    const saved = await host.host.withSource(success.ref, async () => readSavedArgumentReferenceNote({ ...roots, scope }, success.ref.entityId)); assert.ok(saved);
    const piece = buildNoteReferenceChunks(saved!).find(item => item.sectionPath.endsWith('定义'))!; assert.ok(piece);
    const hit: NoteSearchResult = { noteId: saved!.id, noteType: 'knowledge', title: saved!.title, score: 0.7, snippet: piece.content.slice(0, 450), matchKinds: ['note'], evidenceOrigin: 'note-passage',
      passage: { schemaVersion: 2, chunkId: piece.chunkId, sourceHash: noteReferenceSourceHash(saved!), sourceUpdatedAt: saved!.updatedAt,
        textStart: piece.textStart, textEnd: piece.textEnd, sectionPath: piece.sectionPath, sectionKind: piece.sectionKind, forcedSplit: piece.forcedSplit } };
    const bridge = createArgumentSearchBridge({ environmentId: success.environmentId, store: host.store,
      readSavedKnowledgeNote: id => readSavedArgumentReferenceNote({ ...roots, scope }, id) });
    const attached = await bridge.attachNoteHits([hit]); assert.equal(attached[0].argumentContext.status, 'available', JSON.stringify(attached[0].argumentContext));
    if (attached[0].argumentContext.status !== 'available') throw new Error('synthetic_expected_pointer');
    const read = await host.execute({ op: 'read-task', environmentId: success.environmentId, pointer: attached[0].argumentContext.pointer, task: 'definition' });
    assert.equal(read.status, 'available'); if (read.status !== 'available' || !('pack' in read)) throw new Error('synthetic_expected_pack');
    assert.equal(read.pack.version, 2); assert.equal(read.pack.relations.length, 1);
    const targets = [saved!.title], assessment = freezeReviewAssessment('definition', targets), catalog = await buildReviewReferenceCatalog([saved!], targets, [saved!.id]);
    const meaning = catalog.candidates.find(item => item.quote.includes('是指'))!, boundary = catalog.candidates.find(item => item.quote.includes('才可能'))!;
    assert.ok(meaning && boundary);
    const referenceRubric = freezeReviewReferenceRubric(`concept_meaning=${meaning.candidateId};concept_boundary=${boundary.candidateId}`, assessment, catalog);
    assert.equal(referenceRubric.status, 'fixed');
    const frames = createArgumentQuestionFrameService({ runtime: host, readReferenceNotes: () => readSavedArgumentReferenceNotes({ ...roots, scope }, targets) });
    const fixed = await frames.prepare({ questionMessageId: 'synthetic-question', knowledgeTargets: targets, assessment, referenceRubric });
    assert.equal(fixed.status, 'fixed', JSON.stringify(fixed.reasons)); assert.equal((await frames.verify(fixed)).status, 'current');
  });
  pass('实际持久发布可被搜索pointer、v2任务闭包和题前固定参考frame读取，不只返回成功通知');

  const restarted = createArgumentProjectionEnvironmentRegistry(() => success.roots), restartedEnv = await restarted.getEnvironment(success.owner);
  assert.equal(restartedEnv.status, 'available'); if (restartedEnv.status !== 'available') throw new Error('synthetic_expected_environment');
  const reopenedService = createArgumentReferenceBuildService({ environments: restarted, model: success.model });
  assert.equal((await reopenedService.status(success.owner, { environmentId: restartedEnv.environmentId, ref: success.ref })).status, 'available');
  const oldTicket = await reopenedService.run(success.owner, { environmentId: restartedEnv.environmentId, ticketId: prepared.ticketId, consent: 'process-reference' });
  assert.equal(oldTicket.status, 'held'); assert.equal(success.calls.length, 3);
  pass('新registry/service模拟重启可验证持久结构，内存审核票不跨进程恢复');

  const uploaded = await rig(), docId = 'synthetic-uploaded', original = '# 定义\n\n选择过载是指选项超过认知处理范围时难以决策。\n\n## 边界\n\n当选项超过可处理范围时，选择过载才可能发生。';
  const structured = { ...buildTextStructuredDocument(docId, original), sourceHash: createHash('sha256').update(original).digest('hex'), materialParserVersion: 1 };
  const document: UploadedDocument = { id: docId, fileName: 'synthetic-upload.md', fileType: 'md', extension: '.md', indexable: true,
    size: Buffer.byteLength(original), status: 'ready', chunkCount: 0, totalChars: structured.normalizedText.length,
    parseStatus: 'ready', parsedAt: '2026-10-07T01:00:00.000Z', uploadAt: '2026-10-07T00:00:00.000Z' };
  await fs.mkdir(path.join(uploaded.roots.dataRoot, 'documents')); await fs.mkdir(path.join(uploaded.roots.dataRoot, 'rag-index'));
  await fs.writeFile(path.join(uploaded.roots.dataRoot, 'documents', `${docId}.md`), original);
  await fs.writeFile(path.join(uploaded.roots.dataRoot, 'rag-index', `structured-${docId}.json`), JSON.stringify(structured));
  await fs.writeFile(path.join(uploaded.roots.dataRoot, 'rag-index', 'manifest.json'), JSON.stringify([document]));
  const uploadedEnvironment = await uploaded.registry.getEnvironment(uploaded.owner); assert.equal(uploadedEnvironment.status, 'available');
  if (uploadedEnvironment.status !== 'available') throw new Error('synthetic_expected_environment');
  const docRequest = { environmentId: uploadedEnvironment.environmentId, ref: { kind: 'uploaded-document' as const, entityId: docId } };
  const docPrepared = await uploaded.service.prepare(uploaded.owner, docRequest); assert.equal(docPrepared.status, 'prepared');
  if (docPrepared.status !== 'prepared') throw new Error('synthetic_expected_prepared');
  assert.equal((await uploaded.service.run(uploaded.owner, { environmentId: uploadedEnvironment.environmentId, ticketId: docPrepared.ticketId, consent: 'process-reference' })).status, 'published');
  assert.equal((await uploaded.service.status(uploaded.owner, docRequest)).status, 'available');
  await fs.writeFile(path.join(uploaded.roots.dataRoot, 'documents', `${docId}.md`), '外部改变合成原始字节');
  assert.equal((await uploaded.service.status(uploaded.owner, docRequest)).status, 'held');
  assert.equal(uploaded.calls.length, 3);
  pass('上传源原始SHA＋同代parse可经相同链路发布；原始字节变化不能读取旧结构');

  const dependency = noteFor('internal-dependency'), citing = { ...noteFor('citing-knowledge'),
    referenceSources: [{ title: dependency.title, type: 'note' as const, entityId: dependency.id }] };
  const internal = await rig([citing, dependency]); assert.equal((await internal.run()).status, 'published');
  assert.equal((await internal.service.status(internal.owner, internal.sourceRequest)).status, 'available');
  await internal.save([citing, { ...dependency, content: dependency.content + '\r\n\r\n内部出处的合成正文变化。' }]);
  const staleDependency = await internal.service.status(internal.owner, internal.sourceRequest); assert.equal(staleDependency.status, 'missing');
  if (staleDependency.status !== 'missing') throw new Error('synthetic_expected_missing'); assert.equal(staleDependency.sourceQualification, 'unassessed');
  assert.equal(await (await runtimeFor(internal)).store.read(internal.ref), null);
  await internal.save([citing, dependency]);
  assert.equal((await internal.service.status(internal.owner, internal.sourceRequest)).status, 'missing');
  assert.equal((await internal.run()).status, 'published');
  pass('正式准入持续回核内部出处：已发布依赖改变降回unassessed并隔离active，恢复原文也不自动复活旧投影');

  await internal.save([citing, dependency, noteFor('unrelated-library-growth')]);
  const grownEnvironment = await internal.registry.getEnvironment(internal.owner); assert.equal(grownEnvironment.status, 'available');
  if (grownEnvironment.status !== 'available') throw new Error('synthetic_expected_environment');
  assert.equal((await internal.service.status(internal.owner, { environmentId: grownEnvironment.environmentId, ref: internal.ref })).status, 'available');
  pass('无关库目录增长只换读取lease，不改变已审核最小出处依赖或稳定源scope');

  const scopedMain = { ...noteFor('scoped-citing'), referenceSources: [{ title: '合成上传出处', type: 'document' as const, entityId: docId }] };
  const narrowProject = { ...noteFor('narrow-project'), noteType: 'project' as const, links: [scopedMain.title], resources: [] };
  const completeProject = { ...noteFor('complete-project'), noteType: 'project' as const, links: [scopedMain.title],
    resources: [{ title: document.fileName, url: `document:${docId}`, documentId: docId }] };
  const scoped = await rig([scopedMain, narrowProject, completeProject]);
  await fs.mkdir(path.join(scoped.roots.dataRoot, 'documents')); await fs.mkdir(path.join(scoped.roots.dataRoot, 'rag-index'));
  await fs.writeFile(path.join(scoped.roots.dataRoot, 'documents', `${docId}.md`), original);
  await fs.writeFile(path.join(scoped.roots.dataRoot, 'rag-index', `structured-${docId}.json`), JSON.stringify(structured));
  await fs.writeFile(path.join(scoped.roots.dataRoot, 'rag-index', 'manifest.json'), JSON.stringify([document]));
  const libraryEnv = await scoped.registry.getEnvironment(scoped.owner); assert.equal(libraryEnv.status, 'available');
  if (libraryEnv.status !== 'available') throw new Error('synthetic_expected_environment');
  const scopedLibraryRequest = { environmentId: libraryEnv.environmentId, ref: scoped.ref }, scopedTicket = await scoped.service.prepare(scoped.owner, scopedLibraryRequest);
  assert.equal(scopedTicket.status, 'prepared'); if (scopedTicket.status !== 'prepared') throw new Error('synthetic_expected_prepared');
  assert.equal((await scoped.service.run(scoped.owner, { environmentId: libraryEnv.environmentId, ticketId: scopedTicket.ticketId, consent: 'process-reference' })).status, 'published');
  const scopedRuntime = await scoped.registry.withEnvironment(scoped.owner, libraryEnv.environmentId, async host => host);
  const scopedLedgerPath = path.join(scoped.roots.userStateDir, 'argument-projections', argumentProjectionLedgerFileName(scopedRuntime.host.rootScopeId));
  const beforeNarrowRead = await fs.readFile(scopedLedgerPath);
  const narrowEnv = await scoped.registry.getEnvironment(scoped.owner + 1, { kind: 'learning-note', noteId: narrowProject.id }); assert.equal(narrowEnv.status, 'available');
  if (narrowEnv.status !== 'available') throw new Error('synthetic_expected_environment');
  const narrowStatus = await scoped.service.status(scoped.owner + 1, { environmentId: narrowEnv.environmentId, ref: scoped.ref });
  assert.equal(narrowStatus.status, 'held'); if (narrowStatus.status !== 'held') throw new Error('synthetic_expected_held'); assert.equal(narrowStatus.reasonCode, 'scope_denied');
  assert.deepEqual(await fs.readFile(scopedLedgerPath), beforeNarrowRead);
  assert.equal((await scoped.service.status(scoped.owner, scopedLibraryRequest)).status, 'available');
  const completeEnv = await scoped.registry.getEnvironment(scoped.owner + 2, { kind: 'learning-note', noteId: completeProject.id }); assert.equal(completeEnv.status, 'available');
  if (completeEnv.status !== 'available') throw new Error('synthetic_expected_environment');
  assert.equal((await scoped.service.status(scoped.owner + 2, { environmentId: completeEnv.environmentId, ref: scoped.ref })).status, 'available');
  pass('项目缺内部出处权限只scope_denied，不读越权依赖也不tombstone全库active；完整项目正常读取');

  await fs.unlink(path.join(scoped.roots.dataRoot, 'documents', `${docId}.md`));
  const actuallyDeleted = await scoped.service.status(scoped.owner, scopedLibraryRequest); assert.equal(actuallyDeleted.status, 'missing');
  if (actuallyDeleted.status !== 'missing') throw new Error('synthetic_expected_missing'); assert.equal(actuallyDeleted.sourceQualification, 'unassessed');
  assert.equal(await scopedRuntime.store.read(scoped.ref), null);
  assert.notDeepEqual(await fs.readFile(scopedLedgerPath), beforeNarrowRead);
  pass('全库权限下真实内部原始资料删除才撤回准入并持久隔离旧投影，不混淆项目权限不足');

  for (const observer of ['status', 'prepare'] as const) {
    const citingDocument = { ...noteFor(`corrupt-citation-${observer}`),
      referenceSources: [{ title: '合成上传出处', type: 'document' as const, entityId: docId }] };
    const corrupt = await rig([citingDocument]);
    await fs.mkdir(path.join(corrupt.roots.dataRoot, 'documents')); await fs.mkdir(path.join(corrupt.roots.dataRoot, 'rag-index'));
    const originalPath = path.join(corrupt.roots.dataRoot, 'documents', `${docId}.md`);
    await fs.writeFile(originalPath, original);
    await fs.writeFile(path.join(corrupt.roots.dataRoot, 'rag-index', `structured-${docId}.json`), JSON.stringify(structured));
    await fs.writeFile(path.join(corrupt.roots.dataRoot, 'rag-index', 'manifest.json'), JSON.stringify([document]));
    const environment = await corrupt.registry.getEnvironment(corrupt.owner); assert.equal(environment.status, 'available');
    if (environment.status !== 'available') throw new Error('synthetic_expected_environment');
    const sourceRequest = { environmentId: environment.environmentId, ref: corrupt.ref };
    const prepared = await corrupt.service.prepare(corrupt.owner, sourceRequest); assert.equal(prepared.status, 'prepared');
    if (prepared.status !== 'prepared') throw new Error('synthetic_expected_prepared');
    assert.equal((await corrupt.service.run(corrupt.owner, { environmentId: environment.environmentId, ticketId: prepared.ticketId, consent: 'process-reference' })).status, 'published');
    const host = await corrupt.registry.withEnvironment(corrupt.owner, environment.environmentId, async runtime => runtime);
    const ledgerPath = path.join(corrupt.roots.userStateDir, 'argument-projections', argumentProjectionLedgerFileName(host.host.rootScopeId));
    const before = await fs.readFile(ledgerPath);
    // Observe B only through the requested UI service, not an extra store/read call.
    await fs.writeFile(originalPath, '内部出处合成原始字节坏SHA-B');
    const observed = await corrupt.service[observer](corrupt.owner, sourceRequest);
    assert.equal(observed.status, 'held');
    assert.notDeepEqual(await fs.readFile(ledgerPath), before, `${observer} must persist invalidation before provenance throws`);
    await fs.writeFile(originalPath, original);
    assert.equal((await corrupt.service.status(corrupt.owner, sourceRequest)).status, 'missing');
    const fresh = await corrupt.service.prepare(corrupt.owner, sourceRequest); assert.equal(fresh.status, 'prepared');
    if (fresh.status !== 'prepared') throw new Error('synthetic_expected_new_ticket');
    assert.equal(await host.store.read(corrupt.ref), null); assert.equal(corrupt.calls.length, 3);
    assert.equal((await corrupt.service.run(corrupt.owner, { environmentId: environment.environmentId, ticketId: fresh.ticketId, consent: 'process-reference' })).status, 'published');
    pass(`内部上传出处坏SHA经${observer}观测先持久失效；恢复A不复活旧投影，须新票完整审核发布`);
    if (observer === 'status') {
      const beforeTransient = await fs.readFile(ledgerPath), openBeforeTransient = fs.open;
      try {
        fs.open = (async (...args: Parameters<typeof fs.open>) => {
          if (path.resolve(String(args[0])).toLowerCase() === originalPath.toLowerCase()) throw Object.assign(new Error('synthetic_transient_dependency_io'), { code: 'EACCES' });
          return openBeforeTransient(...args);
        }) as typeof fs.open;
        assert.equal((await corrupt.service.status(corrupt.owner, sourceRequest)).status, 'held');
        assert.deepEqual(await fs.readFile(ledgerPath), beforeTransient);
      } finally { fs.open = openBeforeTransient; }
      assert.equal((await corrupt.service.status(corrupt.owner, sourceRequest)).status, 'available');
      assert.equal(corrupt.calls.length, 6);
      pass('内部上传出处瞬态EACCES只hold，不撤回已审资格或改变投影；恢复读取无需模型重建');
    }
  }

  for (const observer of ['status', 'prepare', 'source'] as const) {
    const corrupt = await rig();
    await fs.mkdir(path.join(corrupt.roots.dataRoot, 'documents')); await fs.mkdir(path.join(corrupt.roots.dataRoot, 'rag-index'));
    const originalPath = path.join(corrupt.roots.dataRoot, 'documents', `${docId}.md`);
    await fs.writeFile(originalPath, original);
    await fs.writeFile(path.join(corrupt.roots.dataRoot, 'rag-index', `structured-${docId}.json`), JSON.stringify(structured));
    await fs.writeFile(path.join(corrupt.roots.dataRoot, 'rag-index', 'manifest.json'), JSON.stringify([document]));
    const environment = await corrupt.registry.getEnvironment(corrupt.owner); assert.equal(environment.status, 'available');
    if (environment.status !== 'available') throw new Error('synthetic_expected_environment');
    const sourceRequest = { environmentId: environment.environmentId, ref: { kind: 'uploaded-document' as const, entityId: docId } };
    const prepared = await corrupt.service.prepare(corrupt.owner, sourceRequest); assert.equal(prepared.status, 'prepared');
    if (prepared.status !== 'prepared') throw new Error('synthetic_expected_prepared');
    assert.equal((await corrupt.service.run(corrupt.owner, { environmentId: environment.environmentId, ticketId: prepared.ticketId, consent: 'process-reference' })).status, 'published');
    const host = await corrupt.registry.withEnvironment(corrupt.owner, environment.environmentId, async runtime => runtime);
    const ledgerPath = path.join(corrupt.roots.userStateDir, 'argument-projections', argumentProjectionLedgerFileName(host.host.rootScopeId));
    const before = await fs.readFile(ledgerPath);
    await fs.writeFile(originalPath, '自身上传合成原始字节坏SHA-B');
    const observed = observer === 'source'
      ? await corrupt.registry.execute(corrupt.owner, { op: 'source', ...sourceRequest })
      : await corrupt.service[observer](corrupt.owner, sourceRequest);
    assert.equal(observed.status, 'held');
    if (observed.status !== 'held') throw new Error('synthetic_expected_held'); assert.equal(observed.reasonCode, 'source_changed');
    assert.notDeepEqual(await fs.readFile(ledgerPath), before, `${observer} must isolate a source whose raw reader throws before returning input`);
    await fs.writeFile(originalPath, original);
    assert.equal((await corrupt.service.status(corrupt.owner, sourceRequest)).status, 'missing');
    assert.equal(await host.store.read(sourceRequest.ref), null); assert.equal(corrupt.calls.length, 3);
    pass(`自身上传坏SHA经${observer}观测由host精确changed边界持久隔离；恢复A不复活旧投影`);
    if (observer === 'status') {
      const fresh = await corrupt.service.prepare(corrupt.owner, sourceRequest); assert.equal(fresh.status, 'prepared');
      if (fresh.status !== 'prepared') throw new Error('synthetic_expected_new_ticket');
      assert.equal((await corrupt.service.run(corrupt.owner, { environmentId: environment.environmentId, ticketId: fresh.ticketId, consent: 'process-reference' })).status, 'published');
      let consumerCalls = 0;
      await assert.rejects(host.store.withActive(sourceRequest.ref, async () => {
        consumerCalls++;
        await fs.writeFile(originalPath, '消费者回调后的原始SHA坏B');
        return 'do-not-return-stale-upload';
      }), /source_changed/);
      assert.equal(consumerCalls, 1);
      await fs.writeFile(originalPath, original);
      assert.equal(await host.store.read(sourceRequest.ref), null);
      assert.equal((await corrupt.service.status(corrupt.owner, sourceRequest)).status, 'missing');
      pass('post-reader原始上传SHA错误仍走独立changed隔离，消费回调不重放，恢复A不能复活');
    }
  }

  const transientSource = await rig(); assert.equal((await transientSource.run()).status, 'published');
  const transientHost = await runtimeFor(transientSource);
  const transientLedgerPath = path.join(transientSource.roots.userStateDir, 'argument-projections', argumentProjectionLedgerFileName(transientHost.host.rootScopeId));
  const beforeTransientSource = await fs.readFile(transientLedgerPath), openBeforeSourceFailure = fs.open;
  const transientSourcePath = path.join(transientSource.roots.vaultRoot, 'notes', `${transientSource.ref.entityId}.md`);
  try {
    fs.open = (async (...args: Parameters<typeof fs.open>) => {
      if (path.resolve(String(args[0])).toLowerCase() === transientSourcePath.toLowerCase()) throw Object.assign(new Error('synthetic_transient_source_io'), { code: 'EACCES' });
      return openBeforeSourceFailure(...args);
    }) as typeof fs.open;
    assert.equal((await transientSource.service.status(transientSource.owner, transientSource.sourceRequest)).status, 'held');
    assert.equal((await transientSource.service.prepare(transientSource.owner, transientSource.sourceRequest)).status, 'held');
    assert.equal((await transientSource.registry.execute(transientSource.owner, { op: 'source', ...transientSource.sourceRequest })).status, 'held');
    assert.deepEqual(await fs.readFile(transientLedgerPath), beforeTransientSource);
  } finally { fs.open = openBeforeSourceFailure; }
  assert.equal((await transientSource.service.status(transientSource.owner, transientSource.sourceRequest)).status, 'available');
  assert.equal(transientSource.calls.length, 3);
  pass('自身源瞬态EACCES在status/prepare/source均只hold，不持久隔离或将其冒充删除');

  const pendingPath = path.join(transientSource.roots.userStateDir, 'vault-pending-snapshot.json');
  await fs.writeFile(pendingPath, 'synthetic pending snapshot');
  assert.equal((await transientSource.service.status(transientSource.owner, transientSource.sourceRequest)).status, 'held');
  assert.deepEqual(await fs.readFile(transientLedgerPath), beforeTransientSource);
  await fs.unlink(pendingPath);
  const afterPending = await transientSource.registry.getEnvironment(transientSource.owner); assert.equal(afterPending.status, 'available');
  if (afterPending.status !== 'available') throw new Error('synthetic_expected_environment');
  assert.equal((await transientSource.service.status(transientSource.owner, { environmentId: afterPending.environmentId, ref: transientSource.ref })).status, 'available');
  assert.equal(transientSource.calls.length, 3);
  pass('pending保存日志只hold且保留账本，新有效lease恢复原结构而非要求模型重建');

  const afterRead = await rig(); assert.equal((await afterRead.run()).status, 'published');
  const afterReadHost = await runtimeFor(afterRead), afterReadOriginal = afterRead.notes()[0], afterReadPath = path.join(afterRead.roots.vaultRoot, 'notes', `${afterReadOriginal.id}.md`);
  let readerCalls = 0;
  await assert.rejects(afterReadHost.store.withActive(afterRead.ref, async () => {
    readerCalls++;
    await fs.writeFile(afterReadPath, afterReadOriginal.content + '\r\n\r\n回调期间的外部合成正文变化。');
    return 'do-not-return-stale-content';
  }), /source_changed/);
  assert.equal(readerCalls, 1);
  await fs.writeFile(afterReadPath, afterReadOriginal.content);
  assert.equal(await afterReadHost.store.read(afterRead.ref), null);
  assert.equal((await afterRead.service.status(afterRead.owner, afterRead.sourceRequest)).status, 'missing');
  pass('post-reader才观察源变化也持久隔离；消费者回调仅一次，不重放业务读取或返回旧内容');

  const afterPublish = await rig(); assert.equal((await afterPublish.run()).status, 'published');
  const afterPublishHost = await runtimeFor(afterPublish), afterPublishInput = await inputFor(afterPublish);
  const afterPublishDraft = draftFor(afterPublishInput), afterPublishReview = fixedAcceptProjectionReview(await buildArgumentProjectionReviewInput(afterPublishInput, afterPublishDraft));
  const afterPublishResult = await finalizeArgumentProjectionBuild(afterPublishInput, afterPublishDraft, afterPublishReview);
  const afterPublishOriginal = afterPublish.notes()[0], afterPublishPath = path.join(afterPublish.roots.vaultRoot, 'notes', `${afterPublishOriginal.id}.md`);
  const renameBeforePostChange = fs.rename; let publicationRenames = 0;
  try {
    fs.rename = async (from, to) => {
      const result = await renameBeforePostChange(from, to);
      if (String(to).includes('argument-projections')) {
        publicationRenames++;
        if (publicationRenames === 1) await fs.writeFile(afterPublishPath, afterPublishOriginal.content + '\r\n\r\n发布已rename后外部合成正文变化。');
      }
      return result;
    };
    await assert.rejects(afterPublishHost.store.publish({ publicationId: 'post-publish-source-change', result: afterPublishResult,
      proof: { input: afterPublishInput, draft: afterPublishDraft, review: afterPublishReview }, expectedActiveHash: afterPublishResult.authority.structureHash }), /source_changed/);
  } finally { fs.rename = renameBeforePostChange; }
  // One publication rename, followed by one invalidation-only rename; no publication replay.
  assert.equal(publicationRenames, 2);
  await fs.writeFile(afterPublishPath, afterPublishOriginal.content);
  assert.equal(await afterPublishHost.store.read(afterPublish.ref), null);
  pass('post-publish已rename才观察变化不假装回滚；追加独立隔离事务，不重放publish，恢复A无active');

  const missingProvenance = await rig([noteFor('no-provenance', false)]), missingResult = await missingProvenance.prepare();
  assert.equal(missingResult.status, 'held'); assert.equal((await missingProvenance.service.status(missingProvenance.owner, missingProvenance.sourceRequest)).status, 'missing');
  assert.equal(missingProvenance.calls.length, 0);
  assert.equal(await (await runtimeFor(missingProvenance)).store.read(missingProvenance.ref), null);
  pass('无出处知识点不能因固定eligible模型票成为正式参考，无active结构');

  const mixedReference = { ...noteFor('mixed-provenance'), referenceSources: [
    { title: '合成可解析URL', type: 'web' as const, url: 'https://example.org/synthetic-reference' },
    { title: '合成缺失内部出处', type: 'document' as const, entityId: 'synthetic-missing-document' },
  ] };
  const incompleteReferences = await rig([mixedReference]);
  assert.equal((await incompleteReferences.prepare()).status, 'held');
  assert.equal(incompleteReferences.calls.length, 0);
  assert.equal((await incompleteReferences.service.status(incompleteReferences.owner, incompleteReferences.sourceRequest)).status, 'missing');
  assert.equal(await (await runtimeFor(incompleteReferences)).store.read(incompleteReferences.ref), null);
  pass('有效URL不能洗白缺失的明确内部出处：完整依赖硬门在模型发送前hold，不产出正式结构');

  for (const mode of ['quality_unknown', 'quality_reject'] as const) {
    const r = await rig(); r.modes.quality = mode;
    const result = await r.run(); assert.equal(result.status, 'held'); assert.deepEqual(r.calls.map(stageOf), ['quality']);
    const status = await r.service.status(r.owner, r.sourceRequest); assert.equal(status.status, 'missing');
    if (status.status !== 'missing') throw new Error('synthetic_expected_missing');
    assert.equal(status.sourceQualification, mode === 'quality_unknown' ? 'unassessed' : 'review_only');
    assert.equal(await (await runtimeFor(r)).store.read(r.ref), null);
  }
  pass('质量unknown/review_only保留审计，不发起结构抽取或升级评分基线');

  for (const mode of ['structure_unknown', 'structure_reject'] as const) {
    const r = await rig(); r.modes.review = mode;
    const result = await r.run(); assert.equal(result.status, 'held'); assert.deepEqual(r.calls.map(stageOf), ['quality', 'extract', 'review']);
    assert.equal(await (await runtimeFor(r)).store.read(r.ref), null);
    r.modes.review = 'accept'; assert.equal((await r.run()).status, 'published', 'a new build after a held structural review must be possible');
  }
  pass('关系unknown/reject保持partial不可用；新票重建可修复，不复用冲突审核ID');

  for (const stage of ['quality', 'extract', 'review'] as const) {
    for (const mode of ['empty', 'bad_json', 'extra', 'throw'] as const) {
      const r = await rig(); r.modes[stage] = mode;
      const result = await r.run(); assert.equal(result.status, 'held');
      assert.equal(r.calls.length, stage === 'quality' ? 1 : stage === 'extract' ? 2 : 3);
      assert.equal(await (await runtimeFor(r)).store.read(r.ref), null); noPrivate(result, r.notes()[0], r.roots.dataRoot);
      assert.equal(r.diagnostics.length, 1);
      assert.equal(r.diagnostics[0].stage, stage === 'quality' ? 'source-quality' : stage === 'extract' ? 'structure-extraction' : 'structure-review');
      assert.equal(r.diagnostics[0].code, mode === 'throw' ? 'model_failed' : mode === 'extra'
        ? stage === 'quality' ? 'argument_reference_policy_invalid_shape' : 'argument_projection_invalid_shape'
        : 'model_response_invalid');
      assert.equal(r.diagnostics[0].row, undefined);
      noPrivate(r.diagnostics, r.notes()[0], r.roots.dataRoot);
    }
  }
  pass('质量/抽取/审核任一空输出、坏JSON、unknown字段、模型失败均无重试且不泄漏异常');

  for (const mode of ['review_missing_decision', 'review_mixed_fields', 'review_extra_fields'] as const) {
    const r = await rig(); r.modes.review = mode;
    const result = await r.run(); assert.deepEqual(result, { status: 'held', reasonCode: 'model_response_invalid' });
    assert.equal(r.calls.length, 3); assert.equal(await (await runtimeFor(r)).store.read(r.ref), null);
    assert.deepEqual(r.diagnostics, [{ stage: 'structure-review', code: 'argument_projection_invalid_shape', row: {
      kind: 'nodes', rowIndex: 0, missingFields: mode === 'review_extra_fields' ? [] : ['decision'],
      unexpectedFieldCount: mode === 'review_missing_decision' ? 0 : mode === 'review_extra_fields' ? 1 : 2,
    } }]);
    noPrivate(result, r.notes()[0], r.roots.dataRoot); noPrivate(r.diagnostics, r.notes()[0], r.roots.dataRoot);
  }
  pass('审核缺decision/混入结构字段可定位宿主阶段及行；仅公开已知缺字段和未知字段数量，IPC保持原held码');

  const diagnosticObserver = await rig(); diagnosticObserver.modes.review = 'review_missing_decision';
  diagnosticObserver.setDiagnosticHook(diagnostic => {
    assert.ok(Object.isFrozen(diagnostic));
    if (diagnostic.row) diagnostic.row.missingFields.length = 0;
    throw new Error('synthetic-secret-C:\\private\\file');
  });
  assert.deepEqual(await diagnosticObserver.run(), { status: 'held', reasonCode: 'model_response_invalid' });
  assert.equal(diagnosticObserver.calls.length, 3); assert.equal(await (await runtimeFor(diagnosticObserver)).store.read(diagnosticObserver.ref), null);
  assert.deepEqual(diagnosticObserver.diagnostics[0].row?.missingFields, ['decision']);
  pass('诊断克隆不携带授权，观察回调修改/抛错不改变held结果、不补票、不增加请求或发布');

  let unhandledDiagnostics = 0, foreignThenReads = 0, nativeThenReads = 0;
  const onUnhandledDiagnostic = () => { unhandledDiagnostics++; };
  process.on('unhandledRejection', onUnhandledDiagnostic);
  try {
    for (const observer of ['async_reject', 'cross_realm_reject', 'native_then_getter', 'foreign_thenable'] as const) {
      const r = await rig(); r.modes.review = 'review_missing_decision';
      r.setDiagnosticHook(() => {
        if (observer === 'async_reject') return (async () => { throw new Error('synthetic-secret async observer'); })();
        if (observer === 'cross_realm_reject') return runInNewContext('Promise.reject(new Error("synthetic-secret cross-realm observer"))');
        if (observer === 'native_then_getter') {
          const rejected = Promise.reject(new Error('synthetic-secret native observer'));
          Object.defineProperty(rejected, 'then', { get: () => { nativeThenReads++; throw new Error('native then getter must not run'); } });
          return rejected;
        }
        return { [Symbol.toStringTag]: 'Promise', get then() { foreignThenReads++; return () => assert.fail('foreign thenable must not run'); } };
      });
      assert.deepEqual(await r.run(), { status: 'held', reasonCode: 'model_response_invalid' });
      assert.equal(r.calls.length, 3); assert.equal(await (await runtimeFor(r)).store.read(r.ref), null);
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.equal(unhandledDiagnostics, 0); assert.equal(foreignThenReads, 0); assert.equal(nativeThenReads, 0);
  } finally { process.removeListener('unhandledRejection', onUnhandledDiagnostic); }
  pass('异步/跨realm诊断拒绝安全吞下且不await；原生Promise不读then getter，陌生thenable不读取或执行');

  const invalid = await rig(), valid = await invalid.prepare(); assert.equal(valid.status, 'prepared'); if (valid.status !== 'prepared') throw new Error('synthetic_expected_prepared');
  for (const request of [{ ...invalid.sourceRequest, path: invalid.roots.dataRoot }, { ...invalid.sourceRequest, scope: {} },
    { ...invalid.sourceRequest, quality: 'eligible' }, { ...invalid.sourceRequest, ref: { ...invalid.ref, arbitrary: undefined } }]) {
    assert.equal((await invalid.service.prepare(invalid.owner, request)).status, 'held');
  }
  for (const request of [{ environmentId: invalid.environmentId, ticketId: valid.ticketId },
    { environmentId: invalid.environmentId, ticketId: valid.ticketId, consent: 'process-reference', provider: {} },
    { environmentId: invalid.environmentId, ticketId: valid.ticketId, consent: 'process-reference', draft: {} }]) {
    assert.equal((await invalid.service.run(invalid.owner, request)).status, 'held');
  }
  assert.equal((await invalid.service.run(invalid.owner + 1, { environmentId: invalid.environmentId, ticketId: valid.ticketId, consent: 'process-reference' })).status, 'held');
  assert.equal(invalid.calls.length, 0);
  pass('closed selectors/consent及owner隔离，不接受renderer原文、权限、资格、模型或结构注入');

  for (const change of ['content', 'provenance', 'model', 'selection', 'environment', 'cancel', 'ttl'] as const) {
    const r = await rig(), entered = deferred(), release = deferred();
    r.setHook(async stage => { if (stage === 'quality') { entered.resolve(); await release.promise; } });
    const prepared = await r.prepare(); assert.equal(prepared.status, 'prepared'); if (prepared.status !== 'prepared') throw new Error('synthetic_expected_prepared');
    const request = { environmentId: r.environmentId, ticketId: prepared.ticketId, consent: 'process-reference' };
    const pending = r.service.run(r.owner, request); await deadline(entered.promise);
    if (change === 'content') await deadline(r.save([{ ...r.notes()[0], content: r.notes()[0].content + '\r\n\r\n新的保存正文。' }]));
    else if (change === 'provenance') await deadline(r.save([{ ...r.notes()[0], referenceSources: [{ title: '另一合成出处', type: 'web', url: 'https://example.org/new-reference' }] }]));
    else if (change === 'model') r.config.fingerprint = 'b'.repeat(64);
    else if (change === 'selection') await deadline(r.registry.getEnvironment(r.owner, { kind: 'learning-note', noteId: r.ref.entityId }));
    else if (change === 'environment') r.registry.revoke(r.owner);
    else if (change === 'cancel') assert.equal((await deadline(r.service.cancel(r.owner, { environmentId: r.environmentId, ticketId: prepared.ticketId }))).status, 'cancelled');
    else r.advance(11 * 60 * 1000);
    release.resolve(); const result = await deadline(pending); assert.equal(result.status, 'held'); assert.equal(r.calls.length, 1);
    noPrivate(result, r.notes()[0], r.roots.dataRoot);
    const nextEnv = await r.registry.getEnvironment(r.owner); assert.equal(nextEnv.status, 'available'); if (nextEnv.status !== 'available') throw new Error('synthetic_expected_environment');
    const status = await r.service.status(r.owner, { environmentId: nextEnv.environmentId, ref: r.ref }); assert.notEqual(status.status, 'available');
  }
  pass('模型等待不占源事务，正文/出处/model/selection/env/cancel/TTL变化拒绝晚到质量票，无嵌套死锁');

  for (const stage of ['extract', 'review'] as const) {
    for (const change of ['content', 'cancel', 'environment'] as const) {
      const r = await rig(), entered = deferred(), release = deferred();
      r.setHook(async currentStage => { if (currentStage === stage) { entered.resolve(); await release.promise; } });
      const prepared = await r.prepare(); assert.equal(prepared.status, 'prepared'); if (prepared.status !== 'prepared') throw new Error('synthetic_expected_prepared');
      const pending = r.service.run(r.owner, { environmentId: r.environmentId, ticketId: prepared.ticketId, consent: 'process-reference' }); await deadline(entered.promise);
      if (change === 'content') await deadline(r.save([{ ...r.notes()[0], content: r.notes()[0].content + '\r\n\r\n新的合成正文。' }]));
      else if (change === 'cancel') await deadline(r.service.cancel(r.owner, { environmentId: r.environmentId, ticketId: prepared.ticketId }));
      else r.registry.revoke(r.owner);
      release.resolve(); assert.equal((await deadline(pending)).status, 'held');
      assert.equal(r.calls.length, stage === 'extract' ? 2 : 3);
      const renewed = await r.registry.getEnvironment(r.owner); assert.equal(renewed.status, 'available'); if (renewed.status !== 'available') throw new Error('synthetic_expected_environment');
      assert.notEqual((await r.service.status(r.owner, { environmentId: renewed.environmentId, ref: r.ref })).status, 'available');
    }
  }
  pass('已准入后的抽取/结构审核晚返同样拒绝旧源、取消、撤销，不误发布结构');

  const concurrency = await rig(), entered = deferred(), release = deferred();
  concurrency.setHook(async stage => { if (stage === 'quality') { entered.resolve(); await release.promise; } });
  const one = await concurrency.prepare(); assert.equal(one.status, 'prepared'); if (one.status !== 'prepared') throw new Error('synthetic_expected_prepared');
  const request = { environmentId: concurrency.environmentId, ticketId: one.ticketId, consent: 'process-reference' };
  const first = concurrency.service.run(concurrency.owner, request); await deadline(entered.promise);
  const second = concurrency.service.run(concurrency.owner, request); release.resolve();
  assert.deepEqual(await deadline(first), await deadline(second)); assert.equal(concurrency.calls.length, 3);
  pass('同票并发run合并为一次三阶段链路，不重复发送或竞争持久发布');

  const ticketCapacity = await rig(Array.from({ length: ARGUMENT_REFERENCE_BUILD_LIMITS.ticketsPerOwner + 1 }, (_, index) => noteFor(`capacity-${index}`)));
  for (const note of ticketCapacity.notes().slice(0, ARGUMENT_REFERENCE_BUILD_LIMITS.ticketsPerOwner)) {
    assert.equal((await ticketCapacity.service.prepare(ticketCapacity.owner, { environmentId: ticketCapacity.environmentId,
      ref: { kind: 'knowledge-note', entityId: note.id } })).status, 'prepared');
  }
  const excessRequest = { environmentId: ticketCapacity.environmentId, ref: { kind: 'knowledge-note', entityId: ticketCapacity.notes().at(-1)!.id } };
  const capacityResult = await ticketCapacity.service.prepare(ticketCapacity.owner, excessRequest); assert.equal(capacityResult.status, 'held');
  if (capacityResult.status !== 'held') throw new Error('synthetic_expected_held'); assert.equal(capacityResult.reasonCode, 'capacity');
  ticketCapacity.advance(ARGUMENT_REFERENCE_BUILD_LIMITS.ticketTtlMs + 1);
  assert.equal((await ticketCapacity.service.prepare(ticketCapacity.owner, excessRequest)).status, 'prepared'); assert.equal(ticketCapacity.calls.length, 0);
  pass('每owner审核票容量有限；TTL清理后可继续准备，不靠无界保留原文快照');

  const inflightRigs = await Promise.all([rig(), rig(), rig()]), inflightEntered = [deferred(), deferred()], inflightRelease = deferred();
  for (const [index, r] of inflightRigs.slice(0, 2).entries()) r.setHook(async stage => { if (stage === 'quality') { inflightEntered[index].resolve(); await inflightRelease.promise; } });
  const inflightTickets = await Promise.all(inflightRigs.map(r => r.prepare()));
  const runRequest = (index: number) => {
    const ticket = inflightTickets[index]; assert.equal(ticket.status, 'prepared'); if (ticket.status !== 'prepared') throw new Error('synthetic_expected_prepared');
    return { environmentId: inflightRigs[index].environmentId, ticketId: ticket.ticketId, consent: 'process-reference' };
  };
  const inflightFirst = inflightRigs[0].service.run(inflightRigs[0].owner, runRequest(0)), inflightSecond = inflightRigs[1].service.run(inflightRigs[1].owner, runRequest(1));
  await deadline(Promise.all(inflightEntered.map(item => item.promise)));
  const inflightThird = await inflightRigs[2].service.run(inflightRigs[2].owner, runRequest(2)); assert.equal(inflightThird.status, 'held');
  if (inflightThird.status !== 'held') throw new Error('synthetic_expected_held'); assert.equal(inflightThird.reasonCode, 'capacity'); assert.equal(inflightRigs[2].calls.length, 0);
  inflightRelease.resolve(); assert.equal((await deadline(inflightFirst)).status, 'published'); assert.equal((await deadline(inflightSecond)).status, 'published');
  assert.equal((await inflightRigs[2].service.run(inflightRigs[2].owner, runRequest(2))).status, 'published');
  pass('跨service全局同时构建上限生效，capacity不耗请求不毒化票，槽位释放后原票可执行');

  const oversized = await rig([{ ...noteFor('oversized'), content: noteFor().content + '\r\n\r\n' + '纯合成超预算长文本'.repeat(2500) }]);
  assert.equal((await oversized.prepare()).status, 'held'); assert.equal(oversized.calls.length, 0);
  pass('过长全源保守held，不截前缀冒充完整参考，也不发送超预算请求');

  const expired = await rig(), ttlTicket = await expired.prepare(); assert.equal(ttlTicket.status, 'prepared'); if (ttlTicket.status !== 'prepared') throw new Error('synthetic_expected_prepared');
  expired.advance(11 * 60 * 1000);
  const ttl = await expired.service.run(expired.owner, { environmentId: expired.environmentId, ticketId: ttlTicket.ticketId, consent: 'process-reference' });
  assert.equal(ttl.status, 'held'); assert.equal(expired.calls.length, 0);
  const cancelled = await rig(), cancelTicket = await cancelled.prepare(); assert.equal(cancelTicket.status, 'prepared'); if (cancelTicket.status !== 'prepared') throw new Error('synthetic_expected_prepared');
  assert.equal((await cancelled.service.cancel(cancelled.owner, { environmentId: cancelled.environmentId, ticketId: cancelTicket.ticketId })).status, 'cancelled');
  assert.equal((await cancelled.service.run(cancelled.owner, { environmentId: cancelled.environmentId, ticketId: cancelTicket.ticketId, consent: 'process-reference' })).status, 'held');
  assert.equal(cancelled.calls.length, 0);
  pass('未开始的过期/取消票不发请求，不生成准入或投影');

  const revoked = await rig(), revokeTicket = await revoked.prepare(); assert.equal(revokeTicket.status, 'prepared'); if (revokeTicket.status !== 'prepared') throw new Error('synthetic_expected_prepared');
  revoked.service.revoke(revoked.owner);
  assert.equal((await revoked.service.run(revoked.owner, { environmentId: revoked.environmentId, ticketId: revokeTicket.ticketId, consent: 'process-reference' })).status, 'held');
  assert.equal(revoked.calls.length, 0);
  pass('service owner撤销独立于读取registry，旧票不能在导航后继续执行');

  console.log(`Argument reference build: ${checks} synthetic groups passed; fixed responses, 0 network/real-vault/production-score/cognition writes.`);
} finally {
  globalThis.fetch = originalFetch;
  assert.ok(path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await fs.rm(temporary, { recursive: true, force: true });
}
