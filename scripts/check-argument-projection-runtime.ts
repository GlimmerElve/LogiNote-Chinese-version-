import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { withRagSourceTransaction } from '../src/electron/ragSourceTransactions.ts';
import { saveVaultSnapshot, withSavedVaultSnapshot } from '../src/electron/vaultSnapshot.ts';
import { atomicWriteTextFile } from '../src/electron/atomicWrite.ts';
import { setDataRoot, writeManifest, readManifest, updateManifest, upsertManifestEntries, writeStructuredDocumentFile,
  writeChunksFile, withDocumentSourceSnapshot, deleteDocumentSourceFiles, deleteManifestEntry, commitDocumentSourceImports } from '../src/electron/ragIndex.ts';
import { createArgumentProjectionRuntime, createArgumentProjectionSourceScope } from '../src/electron/rag/argumentProjectionRuntime.ts';
import { createArgumentProjectionEnvironmentRegistry } from '../src/electron/rag/argumentProjectionEnvironment.ts';
import { createArgumentSourceAdmissionStore } from '../src/electron/rag/argumentSourceAdmission.ts';
import { readSavedArgumentProjectionSource } from '../src/electron/rag/argumentSavedSourceReader.ts';
import { adaptSavedKnowledgeNote } from '../src/electron/rag/argumentSourceAdapter.ts';
import { buildTextStructuredDocument } from '../src/electron/rag/structuredDocument.ts';
import { buildArgumentProjectionReviewInput, finalizeArgumentProjectionBuild } from '../src/services/argumentContext/construction.ts';
import { fixedAcceptProjectionReview } from './argument-projection-build-fixture.ts';
import type { NoteItem, UploadedDocument } from '../src/types.ts';
import type { ArgumentContextScope } from '../src/services/argumentContext/types.ts';
import type { ArgumentProjectionBuildInput, ArgumentProjectionDraft } from '../src/services/argumentContext/buildTypes.ts';
import type { SourceAdmissionReview } from '../src/electron/rag/argumentSourceAdmission.ts';

// Protocol/race checks with synthetic sources in an isolated temp directory only.
// Fixed review votes do not measure a model's semantics or certify source truth.
const previousFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('Network forbidden in projection runtime checks');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'loginote-argument-runtime-'));
let checks = 0;
const pass = (label: string) => { checks++; console.log(`PASS ${label}`); };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const roots = (dataRoot: string) => ({ dataRoot, vaultRoot: path.join(dataRoot, 'vault'), userStateDir: path.join(dataRoot, 'user-state') });
const rootA = roots(path.join(temp, 'A')), rootB = roots(path.join(temp, 'B'));
const note: NoteItem = { id: 'synthetic-definition', title: '合成选择过载', noteType: 'knowledge',
  content: '# 定义\r\n\r\n选择过载是指选项过多时难以决策。🧠\r\n\r\n超过处理阈值时可能发生。',
  createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T01:00:00.000Z', tags: [], links: [], backlinks: [], dueDates: [] };
const scope: ArgumentContextScope = { scopeId: 'synthetic-library', rootScopeId: 'synthetic-root', corpus: 'reference',
  allowedSourceKinds: ['knowledge-note', 'uploaded-document'], allowedNoteIds: [note.id], allowedDocIds: ['synthetic-doc'], allowedRecordIds: [] };
const ref = { kind: 'knowledge-note' as const, entityId: note.id };
const reviewFor = (base: ArgumentProjectionBuildInput, reviewId = 'synthetic-source-review'): SourceAdmissionReview => ({
  reviewId, policyVersion: 'synthetic-source-policy-v1', decision: 'eligible', evidence: [base.quotes.find(q => q.completeSentence && q.evidence.quote.includes('是指'))!.evidence],
  checks: { provenanceVerified: true, relevantContentPresent: true, noCriticalSourceGaps: true, reviewIndependent: true },
  reason: '纯合成固定来源审核，用于验证协议；不是语义效果或客观真实性认证。', reviewedAt: '2026-10-07T02:00:00.000Z',
});
function oneNodeDraft(input: ArgumentProjectionBuildInput): ArgumentProjectionDraft {
  const quote = input.quotes.find(q => q.completeSentence && q.evidence.quote.includes('是指'))!;
  return { version: 1, buildId: input.buildId, nodes: [{ id: 'N1', role: 'definition', quoteIds: [quote.quoteId] }],
    relations: [], groups: [], scopes: [{ id: 'S1', seedNodeId: 'N1', task: 'definition', requiredNodeIds: ['N1'], requiredRelationIds: [], requiredGroupIds: [], quoteIds: [quote.quoteId] }] };
}
const sourceRequest = (environmentId = 'synthetic-env-A') => ({ op: 'source', environmentId, ref });

try {
  await saveVaultSnapshot(rootA.vaultRoot, rootA.userStateDir, [note]);
  await saveVaultSnapshot(rootB.vaultRoot, rootB.userStateDir, [{ ...note, title: '另一个合成库' }]);
  const a = path.join(temp, 'lock-A'), b = path.join(temp, 'lock-B');
  const entered = deferred(), release = deferred(); let secondEntered = false;
  const first = withRagSourceTransaction([a, b], async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const second = withRagSourceTransaction([b, a], async () => { secondEntered = true; });
  await tick(); assert.equal(secondEntered, false); release.resolve(); await Promise.all([first, second]);
  assert.equal(secondEntered, true);
  await assert.rejects(withRagSourceTransaction([a], async () => withRagSourceTransaction([b], async () => {})), /nested_transaction/);
  await assert.rejects(withRagSourceTransaction(['relative-root'], async () => {}), /invalid_root/);
  await assert.rejects(withRagSourceTransaction([a], async () => { throw new Error('synthetic failure'); }), /synthetic failure/);
  await withRagSourceTransaction([a], async () => {});
  pass('多根逆序排队可完成，nested明确拒绝，失败释放队列，不接受相对根');

  const untouchedDir = path.join(temp, 'missing-admission');
  const base = (await readSavedArgumentProjectionSource({ ...rootA, scope }, ref))!;
  const admission = createArgumentSourceAdmissionStore(untouchedDir, scope.rootScopeId);
  assert.deepEqual(await admission.apply(base), base);
  await assert.rejects(fs.stat(untouchedDir), (error: any) => error.code === 'ENOENT');
  const forgedBase = structuredClone(base); forgedBase.sourceQualification.status = 'eligible';
  await assert.rejects(admission.apply(forgedBase));
  pass('无资格记录保持unassessed且不创建目录，调用方自封eligible拒绝');

  const review = reviewFor(base);
  const qualified = await admission.record(base, review);
  assert.equal(qualified.sourceQualification.status, 'eligible');
  const afterRecord = await fs.readdir(untouchedDir);
  const qualifiedAgain = await createArgumentSourceAdmissionStore(untouchedDir, scope.rootScopeId).apply(base);
  assert.deepEqual(qualifiedAgain, qualified);
  assert.deepEqual(await admission.record(base, review), qualified);
  await assert.rejects(admission.record(base, { ...review, reason: '同ID另一审核' }));
  pass('主机私有资格可重建验证，reviewId幂等且不同审核不能复用');

  const changedScope = { ...scope, scopeId: 'another-synthetic-scope' };
  const scopedBase = await adaptSavedKnowledgeNote({ note, rootScopeId: scope.rootScopeId, scope: changedScope });
  assert.equal((await admission.apply(scopedBase)).sourceQualification.status, 'eligible');
  const changedBase = await adaptSavedKnowledgeNote({ note: { ...note, title: '改变保存来源版本' }, rootScopeId: scope.rootScopeId, scope });
  assert.equal((await admission.apply(changedBase)).sourceQualification.status, 'unassessed');
  await assert.rejects(admission.record(base, { ...review, reviewId: 'bad-checks', checks: { ...review.checks, reviewIndependent: false } }));
  await assert.rejects(admission.record(base, { ...review, reviewId: 'bad-quote', evidence: [{ ...review.evidence[0], quote: '伪造原话' }] }));
  await assert.rejects(admission.record(base, { ...review, reviewId: 'bad-extra', quality: 'eligible' } as any));
  pass('资格绑定全来源而非题目scope，源版本变化不沿用；独立审核/精确证据/closed字段缺一拒绝');

  const ledgerFile = afterRecord.find(name => name.endsWith('.json'))!;
  assert.ok(ledgerFile);
  const ledgerPath = path.join(untouchedDir, ledgerFile), savedLedger = await fs.readFile(ledgerPath);
  const altered = JSON.parse(savedLedger.toString('utf8')); // Editing any signed ledger field must not be silently accepted.
  altered.syntheticForgery = true;
  await fs.writeFile(ledgerPath, JSON.stringify(altered));
  await assert.rejects(admission.apply(base)); await fs.writeFile(ledgerPath, savedLedger);
  const keyFile = afterRecord.find(name => !name.endsWith('.json'))!;
  assert.ok(keyFile); const keyPath = path.join(untouchedDir, keyFile), savedKey = await fs.readFile(keyPath);
  await fs.unlink(keyPath); await assert.rejects(admission.apply(base));
  await fs.writeFile(keyPath, Buffer.alloc(32, 3)); await assert.rejects(admission.apply(base));
  await fs.writeFile(keyPath, savedKey);
  assert.deepEqual(await admission.apply(base), qualified);
  pass('坏签名/缺key/错key不会当空库，原记录恢复后可读');

  await admission.record(base, { ...review, reviewId: 'synthetic-downreview', decision: 'review_only', checks: { ...review.checks, noCriticalSourceGaps: false } });
  assert.equal((await admission.apply(base)).sourceQualification.status, 'review_only');
  assert.equal((await admission.record(base, review)).sourceQualification.status, 'review_only');
  pass('新的待复核决定保留并覆盖旧资格，不把曾eligible永久锁定');

  const reopenedAdmission = createArgumentSourceAdmissionStore(untouchedDir, scope.rootScopeId);
  await Promise.all([admission.record(base, { ...review, reviewId: 'synthetic-concurrent-1', decision: 'review_only' }),
    reopenedAdmission.record(base, { ...review, reviewId: 'synthetic-concurrent-2', decision: 'review_only' })]);
  const concurrentLedger = await fs.readFile(ledgerPath), concurrentRows = JSON.parse(concurrentLedger.toString('utf8'));
  assert.ok(concurrentRows.records.some((row: any) => row.review.reviewId === 'synthetic-concurrent-1'));
  assert.ok(concurrentRows.records.some((row: any) => row.review.reviewId === 'synthetic-concurrent-2'));
  concurrentRows.records.reverse(); await fs.writeFile(ledgerPath, JSON.stringify(concurrentRows));
  await assert.rejects(admission.apply(base)); await fs.writeFile(ledgerPath, concurrentLedger);
  pass('资格双实例并发不丢记录，重排有效签名票不能绕过整账本签名');

  const originalRename = fs.rename;
  try {
    fs.rename = async () => { throw Object.assign(new Error('synthetic rename denied'), { code: 'EBUSY' }); };
    await assert.rejects(admission.record(base, { ...review, reviewId: 'synthetic-failed-write', decision: 'review_only' }), /synthetic rename denied/);
    assert.deepEqual(await fs.readFile(ledgerPath), concurrentLedger);
  } finally { fs.rename = originalRename; }
  assert.ok(!(await fs.readdir(untouchedDir)).some(name => name.endsWith('.tmp')));
  await admission.record(base, { ...review, reviewId: 'synthetic-failed-write', decision: 'review_only' });
  assert.equal((await admission.apply(base)).sourceQualification.status, 'review_only');
  pass('资格rename失败保留旧字节，不走copy、不残留tmp，原操作可重试且队列未毒化');

  const budgetLedger = await fs.readFile(ledgerPath);
  await fs.writeFile(ledgerPath, Buffer.alloc(4 * 1024 * 1024 + 1, 32)); await assert.rejects(admission.apply(base));
  await fs.writeFile(ledgerPath, Buffer.from([0xff, 0xfe])); await assert.rejects(admission.apply(base));
  await fs.writeFile(ledgerPath, budgetLedger);
  const admissionLink = path.join(temp, 'admission-junction');
  await fs.symlink(untouchedDir, admissionLink, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createArgumentSourceAdmissionStore(admissionLink, scope.rootScopeId).apply(base), /unsafe_directory/);
  pass('超预算/非UTF8/目录链接资格文件拒绝，不读取链接外权限或改为空库');

  let current = true;
  const runtime = createArgumentProjectionRuntime({ ...rootA, scope, rootScopeId: scope.rootScopeId, environmentId: 'synthetic-env-A', isCurrent: () => current });
  const source = await runtime.execute(sourceRequest());
  assert.equal(source.status, 'physical_source');
  if (source.status !== 'physical_source') assert.fail('Missing synthetic physical source');
  assert.equal(source.input.sourceQualification.status, 'unassessed');
  assert.equal((await runtime.execute({ op: 'pointer', environmentId: 'synthetic-env-A', ref, seedNodeIds: ['N1'] })).status, 'held');
  pass('生产适配只取保存版原文，无资格/无结构明确held，不能用物理索引冒充完整论证');

  for (const request of [
    { ...sourceRequest(), scope }, { ...sourceRequest(), path: rootA.vaultRoot }, { ...sourceRequest(), quality: 'eligible' },
    { ...sourceRequest(), ref: { ...ref, authority: base } }, { op: 'publish', environmentId: 'synthetic-env-A', result: qualified },
    { op: 'pointer', environmentId: 'synthetic-env-A', ref, seedNodeIds: [] },
  ]) { const answer = await runtime.execute(request); assert.equal(answer.status, 'held'); if (answer.status === 'held') assert.equal(answer.reasonCode, 'invalid_request'); }
  const denied = await runtime.execute({ ...sourceRequest(), ref: { kind: 'knowledge-note', entityId: 'not-in-host-scope' } });
  assert.equal(denied.status, 'held'); if (denied.status === 'held') assert.equal(denied.reasonCode, 'scope_denied');
  const old = await runtime.execute(sourceRequest('old-env')); assert.equal(old.status, 'held');
  current = false; assert.equal((await runtime.execute(sourceRequest())).status, 'held'); current = true;
  pass('closed只读入口拒绝path/scope/quality/authority/publish、越范围与旧environment');

  const saveEntered = deferred(), saveRelease = deferred(); let answered = false;
  const newerNote = { ...note, updatedAt: '2026-10-07T03:00:00.000Z', content: note.content.replace('难以决策', '决策更困难') };
  const pendingSave = saveVaultSnapshot(rootA.vaultRoot, rootA.userStateDir, [newerNote], async (file, text) => {
    if (file.endsWith(`${note.id}.md`)) { saveEntered.resolve(); await saveRelease.promise; }
    return atomicWriteTextFile(file, text);
  });
  await saveEntered.promise;
  const pendingRead = runtime.execute(sourceRequest()).then(result => { answered = true; return result; });
  await tick(); assert.equal(answered, false);
  saveRelease.resolve(); await pendingSave; const afterSave = await pendingRead;
  assert.equal(afterSave.status, 'physical_source'); if (afterSave.status === 'physical_source') assert.equal(afterSave.input.canonicalText, newerNote.content);
  await saveVaultSnapshot(rootA.vaultRoot, rootA.userStateDir, [note]);
  pass('实际vault写到一半时runtime等待同锁，恢复后只读完整新快照');

  await assert.rejects(withSavedVaultSnapshot(rootA.vaultRoot, rootA.userStateDir, () => saveVaultSnapshot(rootA.vaultRoot, rootA.userStateDir, [note])), /nested_transaction/);
  const journal = path.join(rootA.userStateDir, 'vault-pending-snapshot.json');
  await fs.writeFile(journal, JSON.stringify({ version: 1, notes: [newerNote] }));
  const pending = await runtime.execute(sourceRequest()); assert.equal(pending.status, 'held');
  if (pending.status === 'held') assert.equal(pending.reasonCode, 'source_pending');
  assert.ok(await fs.stat(journal));
  await withSavedVaultSnapshot(rootA.vaultRoot, rootA.userStateDir, async () => assert.equal(await fs.readFile(path.join(rootA.vaultRoot, 'notes', `${note.id}.md`), 'utf8'), newerNote.content));
  await assert.rejects(fs.stat(journal), (error: any) => error.code === 'ENOENT');
  await saveVaultSnapshot(rootA.vaultRoot, rootA.userStateDir, [note]);
  pass('只读入口不擅自恢复pending journal，显式vault恢复同锁完成，无nested死锁');

  const qualifiedInput = await withRagSourceTransaction(Object.values(rootA), async () => {
    const saved = (await readSavedArgumentProjectionSource({ ...rootA, scope: createArgumentProjectionSourceScope(scope, ref) }, ref))!;
    return runtime.admission.record(saved, reviewFor(saved, 'runtime-synthetic-review'));
  });
  const draft = oneNodeDraft(qualifiedInput), reviewInput = await buildArgumentProjectionReviewInput(qualifiedInput, draft);
  const structureReview = fixedAcceptProjectionReview(reviewInput), result = await finalizeArgumentProjectionBuild(qualifiedInput, draft, structureReview);
  assert.equal((await runtime.store.publish({ publicationId: 'synthetic-publication', result, proof: { input: qualifiedInput, draft, review: structureReview }, expectedActiveHash: null })).status, 'published');
  const pointer = await runtime.execute({ op: 'pointer', environmentId: 'synthetic-env-A', ref, seedNodeIds: ['N1'] });
  assert.equal(pointer.status, 'available'); if (pointer.status !== 'available' || !('pointer' in pointer)) assert.fail('Missing pointer');
  const pack = await runtime.execute({ op: 'read', environmentId: 'synthetic-env-A', pointer: pointer.pointer, task: 'definition' });
  assert.equal(pack.status, 'available'); if (pack.status === 'available' && 'pack' in pack) {
    assert.equal(pack.pack.completeness.status, 'complete_for_scope'); assert.equal(pack.pack.limitations.writes, 'disabled');
  }
  const forgedPointer = structuredClone(pointer.pointer); forgedPointer.scopeHash = '0'.repeat(64);
  const taskPack = await runtime.execute({ op: 'read-task', environmentId: 'synthetic-env-A', pointer: pointer.pointer, task: 'definition' });
  assert.equal(taskPack.status, 'available'); if (taskPack.status === 'available' && 'pack' in taskPack) {
    assert.equal(taskPack.pack.version, 2); assert.equal(taskPack.pack.completeness.status, 'complete_for_scope');
    assert.equal((taskPack.pack as any).readPolicy, 'reviewed-task-closure-v2');
  }
  for (const badTask of ['reference_lookup', 'application', 'comparison']) {
    assert.equal((await runtime.execute({ op: 'read-task', environmentId: 'synthetic-env-A', pointer: pointer.pointer, task: badTask })).status, 'held');
  }
  assert.equal((await runtime.execute({ op: 'read-task', environmentId: 'synthetic-env-A', pointer: forgedPointer, task: 'definition' })).status, 'held');
  assert.equal((await runtime.execute({ op: 'read-task', environmentId: 'synthetic-env-A', pointer: pointer.pointer, task: 'definition', budget: { maxDepth: -1 } })).status, 'held');
  assert.equal((await runtime.execute({ op: 'read', environmentId: 'synthetic-env-A', pointer: forgedPointer, task: 'definition' })).status, 'held');
  assert.equal((await runtime.execute({ op: 'read', environmentId: 'synthetic-env-A', pointer: pointer.pointer, task: 'definition', budget: { maxDepth: -1 } })).status, 'held');
  pass('内部合成准入+固定审核票发布后可发放权威pointer/pack，伪指针/坏budget拒绝，仍不写分数/认知');

  const additionalNote = { ...note, id: 'synthetic-unrelated', title: '无关合成知识点' };
  await saveVaultSnapshot(rootA.vaultRoot, rootA.userStateDir, [note, additionalNote]);
  const expandedScope = { ...scope, scopeId: 'expanded-synthetic-library', allowedNoteIds: [note.id, additionalNote.id] };
  const expandedRuntime = createArgumentProjectionRuntime({ ...rootA, scope: expandedScope, rootScopeId: scope.rootScopeId,
    environmentId: 'synthetic-env-expanded', isCurrent: () => true });
  const reused = await expandedRuntime.execute({ op: 'pointer', environmentId: 'synthetic-env-expanded', ref, seedNodeIds: ['N1'] });
  assert.equal(reused.status, 'available');
  if (reused.status === 'available' && 'pointer' in reused) assert.equal(reused.pointer.structureHash, pointer.pointer.structureHash);
  const forbiddenSource = createArgumentProjectionRuntime({ ...rootA, scope: { ...scope, allowedNoteIds: [] }, rootScopeId: scope.rootScopeId,
    environmentId: 'synthetic-env-denied', isCurrent: () => true });
  const replay = await forbiddenSource.execute({ op: 'read', environmentId: 'synthetic-env-denied', pointer: pointer.pointer, task: 'definition' });
  assert.equal(replay.status, 'held'); if (replay.status === 'held') assert.equal(replay.reasonCode, 'scope_denied');
  await saveVaultSnapshot(rootA.vaultRoot, rootA.userStateDir, [note]);
  pass('无关目录增长不重建未变来源；源级稳定scope不授予外层library拒绝的读取权限');

  await saveVaultSnapshot(rootA.vaultRoot, rootA.userStateDir, [newerNote]);
  assert.equal((await runtime.execute({ op: 'read', environmentId: 'synthetic-env-A', pointer: pointer.pointer, task: 'definition' })).status, 'held');
  await saveVaultSnapshot(rootA.vaultRoot, rootA.userStateDir, [note]);
  assert.equal((await runtime.execute({ op: 'pointer', environmentId: 'synthetic-env-A', ref, seedNodeIds: ['N1'] })).status, 'held');
  pass('观测保存源A→B后撤销active，源恢复A不复活旧结构');

  await assert.rejects(runtime.host.withSource(ref, async () => {
    // Simulate an external editor that does NOT participate in the application queue.
    await fs.writeFile(path.join(rootA.vaultRoot, 'notes', `${note.id}.md`), newerNote.content);
  }), /source_changed/);
  await saveVaultSnapshot(rootA.vaultRoot, rootA.userStateDir, [note]);
  pass('外部编辑不受JS锁控制，短回调前后复核可拒绝已观测变化');

  const doc: UploadedDocument = { id: 'synthetic-doc', fileName: 'synthetic.md', extension: '.md', fileType: 'md', indexable: true, size: 5,
    status: 'pending', chunkCount: 0, totalChars: 0, parseStatus: 'ready', parsedAt: '2026-10-07T01:00:00.000Z', uploadAt: '2026-10-07T00:00:00.000Z' };
  setDataRoot(rootA.dataRoot);
  await writeManifest([doc, { ...doc, id: 'synthetic-second' }]);
  await Promise.all([updateManifest(doc.id, { chunkCount: 4, error: 'clear me' }), updateManifest('synthetic-second', { totalChars: 6 })]);
  assert.equal((await readManifest()).find(d => d.id === doc.id)!.chunkCount, 4);
  assert.equal((await readManifest()).find(d => d.id === 'synthetic-second')!.totalChars, 6);
  await updateManifest(doc.id, { error: undefined }); assert.equal((await readManifest()).find(d => d.id === doc.id)!.error, undefined);
  pass('实际manifest并发完整读改写不丢不同doc更新，explicit undefined清字段兼容');

  const heldRoot = deferred(), releaseRoot = deferred();
  const hold = withRagSourceTransaction([rootA.dataRoot], async () => { heldRoot.resolve(); await releaseRoot.promise; });
  await heldRoot.promise;
  const queuedUpdate = updateManifest(doc.id, { chunkCount: 9 });
  setDataRoot(rootB.dataRoot); releaseRoot.resolve(); await Promise.all([hold, queuedUpdate]);
  assert.equal((JSON.parse(await fs.readFile(path.join(rootA.dataRoot, 'rag-index', 'manifest.json'), 'utf8')) as UploadedDocument[]).find(d => d.id === doc.id)!.chunkCount, 9);
  await writeManifest([{ ...doc, id: 'root-B-doc' }]); setDataRoot(rootA.dataRoot);
  await withDocumentSourceSnapshot(async () => {
    setDataRoot(rootB.dataRoot);
    assert.ok((await readManifest()).some(d => d.id === doc.id));
    await assert.rejects(updateManifest(doc.id, { chunkCount: 99 }), /nested_transaction/);
  });
  assert.equal((await readManifest())[0].id, 'root-B-doc'); setDataRoot(rootA.dataRoot);
  pass('排队写和快照读绑定进入时根，不被setDataRoot重定向，callback内public写拒绝');

  const originalMetadata = await fs.readFile(path.join(rootA.vaultRoot, 'metadata.json'));
  const guardEntered = deferred(), guardRelease = deferred(); let writeGeneration = 0;
  const oldGeneration = writeGeneration;
  const guardedHold = withRagSourceTransaction(Object.values(rootA), async () => { guardEntered.resolve(); await guardRelease.promise; });
  await guardEntered.promise;
  const rejectedSave = saveVaultSnapshot(rootA.vaultRoot, rootA.userStateDir, [newerNote], atomicWriteTextFile, () => writeGeneration === oldGeneration);
  const rejectedRecovery = withSavedVaultSnapshot(rootA.vaultRoot, rootA.userStateDir, async () => {}, () => writeGeneration === oldGeneration);
  // Attach rejection handlers before releasing a queued job.
  const saveCheck = assert.rejects(rejectedSave, /environment_changed/), recoveryCheck = assert.rejects(rejectedRecovery, /environment_changed/);
  writeGeneration++; guardRelease.resolve(); await Promise.all([guardedHold, saveCheck, recoveryCheck]);
  assert.deepEqual(await fs.readFile(path.join(rootA.vaultRoot, 'metadata.json')), originalMetadata);
  await assert.rejects(fs.stat(journal), (error: any) => error.code === 'ENOENT');
  pass('排队期间存储epoch变化时旧save/recovery在触盘前拒绝，不在reset后重新产生journal或旧源');

  const importSource = path.join(temp, 'synthetic-import.md'); await fs.writeFile(importSource, '# 合成导入\n\n导入测试不包含用户资料。');
  const importDoc = { ...doc, id: 'synthetic-import', fileName: 'synthetic-import.md', parseStatus: 'pending' as const };
  const importHoldEntered = deferred(), importRelease = deferred(); let importLive = true;
  const importHold = withRagSourceTransaction([rootA.dataRoot], async () => { importHoldEntered.resolve(); await importRelease.promise; });
  await importHoldEntered.promise;
  const staleImport = commitDocumentSourceImports([{ document: importDoc, sourcePath: importSource }], () => importLive);
  const staleImportCheck = assert.rejects(staleImport, /environment_changed/);
  importLive = false; importRelease.resolve(); await Promise.all([importHold, staleImportCheck]);
  await assert.rejects(fs.stat(path.join(rootA.dataRoot, 'documents', `${importDoc.id}.md`)), (error: any) => error.code === 'ENOENT');
  const imported = await commitDocumentSourceImports([{ document: importDoc, sourcePath: importSource }], () => true);
  assert.equal(imported[0].id, importDoc.id);
  assert.equal(await fs.readFile(path.join(rootA.dataRoot, 'documents', `${importDoc.id}.md`), 'utf8'), await fs.readFile(importSource, 'utf8'));
  assert.ok((await readManifest()).some(d => d.id === importDoc.id));
  await assert.rejects(commitDocumentSourceImports([{ document: importDoc, sourcePath: importSource }]));
  await deleteDocumentSourceFiles(importDoc.id);
  pass('实际本地导入同锁复制+manifest，过期任务先拒绝，无重复ID覆盖原文');

  const original = Buffer.from('# 定义\n\n选择过载是指选项过多时难以决策。');
  const document = { ...buildTextStructuredDocument(doc.id, original.toString('utf8')), sourceHash: createHash('sha256').update(original).digest('hex'), materialParserVersion: 1 };
  await fs.writeFile(path.join(rootA.dataRoot, 'documents', `${doc.id}.md`), original);
  await writeStructuredDocumentFile(document); await writeChunksFile(doc.id, []);
  const sourceDoc = await runtime.execute({ op: 'source', environmentId: 'synthetic-env-A', ref: { kind: 'uploaded-document', entityId: doc.id } });
  assert.equal(sourceDoc.status, 'physical_source');
  if (sourceDoc.status === 'physical_source') assert.equal(sourceDoc.input.sourceQualification.status, 'unassessed');
  await deleteDocumentSourceFiles(doc.id);
  assert.equal((await runtime.execute({ op: 'source', environmentId: 'synthetic-env-A', ref: { kind: 'uploaded-document', entityId: doc.id } })).status, 'source_missing');
  assert.equal((await readManifest()).some(d => d.id === doc.id), false);
  await assert.rejects(async () => deleteDocumentSourceFiles('../outside'));
  pass('保存上传原始SHA+parse可独立读取，整次源删除隐藏原文及结构，越界delete拒绝');

  const manifestPath = path.join(rootA.dataRoot, 'rag-index', 'manifest.json'), savedManifest = await fs.readFile(manifestPath);
  const preservedCache = path.join(rootA.dataRoot, 'rag-index', 'chunks-synthetic-second.json');
  await fs.writeFile(preservedCache, 'synthetic preserved cache bytes');
  for (const invalidManifest of ['{synthetic broken manifest', '{}', '[null]', JSON.stringify([doc, doc]), JSON.stringify([{ ...doc, extension: '../bad' }])]) {
    await fs.writeFile(manifestPath, invalidManifest);
    await assert.rejects(upsertManifestEntries([doc])); await assert.rejects(updateManifest(doc.id, { totalChars: 99 }));
    await assert.rejects(deleteManifestEntry(doc.id)); await assert.rejects(deleteDocumentSourceFiles('synthetic-second'));
    assert.equal(await fs.readFile(manifestPath, 'utf8'), invalidManifest);
    assert.equal(await fs.readFile(preservedCache, 'utf8'), 'synthetic preserved cache bytes');
  }
  await fs.writeFile(manifestPath, savedManifest);
  pass('坏JSON/非array/坏row/重ID/非法extension时四个RMW拒绝，manifest及cache原字节保留');

  let actualRoots = rootA, suspended = false;
  const environments = createArgumentProjectionEnvironmentRegistry(() => actualRoots, () => !suspended);
  const envA = await environments.getEnvironment(1); assert.equal(envA.status, 'available'); if (envA.status !== 'available') assert.fail('environment absent');
  assert.equal(envA.scope, 'reference_library'); assert.equal(envA.noteCount, 1);
  assert.equal((await environments.execute(1, sourceRequest(envA.environmentId))).status, 'physical_source');
  assert.equal((await environments.execute(2, sourceRequest(envA.environmentId))).status, 'held');
  actualRoots = rootB;
  assert.equal((await environments.execute(1, sourceRequest(envA.environmentId))).status, 'held');
  actualRoots = rootA;
  assert.equal((await environments.execute(1, sourceRequest(envA.environmentId))).status, 'held');
  // A root change is always paired with explicit host revocation, even returning to A.
  environments.revoke();
  assert.equal((await environments.execute(1, sourceRequest(envA.environmentId))).status, 'held');
  const renewed = await environments.getEnvironment(1); assert.equal(renewed.status, 'available');
  if (renewed.status === 'available') assert.notEqual(renewed.environmentId, envA.environmentId);
  environments.revoke(1); assert.equal((await environments.execute(1, sourceRequest(envA.environmentId))).status, 'held');
  suspended = true; assert.equal((await environments.getEnvironment(1)).status, 'held'); suspended = false;
  pass('host保存目录发放库scope，owner隔离/根变化/显式A→B→A撤销/导航替代/存储暂停拒绝旧token');

  const issuing = await Promise.all([environments.getEnvironment(1), environments.getEnvironment(1)]);
  assert.equal(issuing[1].status, 'available'); if (issuing[1].status === 'available') {
    assert.equal((await environments.execute(1, sourceRequest(issuing[1].environmentId))).status, 'physical_source');
  }
  if (issuing[0].status === 'available') assert.equal((await environments.execute(1, sourceRequest(issuing[0].environmentId))).status, 'held');
  pass('同owner并发发放latest-wins，不让较旧异步issuance覆盖新lease');

  const issueEntered = deferred(), issueRelease = deferred();
  const issueHold = withRagSourceTransaction(Object.values(rootA), async () => { issueEntered.resolve(); await issueRelease.promise; });
  await issueEntered.promise;
  const issuePending = environments.getEnvironment(4);
  environments.revoke(4); issueRelease.resolve(); await issueHold;
  assert.equal((await issuePending).status, 'held');
  const beforeSuspend = await environments.getEnvironment(4); assert.equal(beforeSuspend.status, 'available');
  if (beforeSuspend.status === 'available') {
    suspended = true; assert.equal((await environments.execute(4, sourceRequest(beforeSuspend.environmentId))).status, 'held');
    suspended = false; assert.equal((await environments.execute(4, sourceRequest(beforeSuspend.environmentId))).status, 'held');
  }
  pass('发放中撤销不安装lease，观测存储暂停后恢复不复活旧token');

  await fs.writeFile(path.join(rootA.vaultRoot, 'metadata.json'), '{synthetic corrupt metadata');
  assert.equal((await environments.getEnvironment(3)).status, 'held');
  await saveVaultSnapshot(rootA.vaultRoot, rootA.userStateDir, [note]);
  environments.revoke();
  await withRagSourceTransaction(Object.values(rootA), async () => {
    // Explicit, validated synthetic subdirectory only; never the real user state.
    assert.equal(path.dirname(rootA.userStateDir), rootA.dataRoot);
    await fs.rm(rootA.userStateDir, { recursive: true, force: true });
  });
  assert.equal((await environments.execute(1, sourceRequest(envA.environmentId))).status, 'held');
  assert.equal((await runtime.execute(sourceRequest())).status, 'source_missing');
  pass('坏host目录不发scope，合成reset删除私有源状态后不复活旧环境/缓存');

  const main = await fs.readFile(path.join(process.cwd(), 'src/electron/main.ts'), 'utf8');
  const preload = await fs.readFile(path.join(process.cwd(), 'src/electron/preload.ts'), 'utf8');
  assert.ok(main.includes("ipcMain.handle('argument-context:get-environment'"));
  assert.ok(main.includes("ipcMain.handle('argument-context:read'"));
  assert.ok(main.includes('event.senderFrame !== event.sender.mainFrame') && main.includes('fileURLToPath(url)'));
  assert.ok(main.includes('withSavedVaultSnapshot(root, userStateDirectory') && main.includes('deleteDocumentSourceFiles(docId)'));
  assert.ok(!/argument-context:(?:publish|review|record)/u.test(main + preload));
  assert.ok(!/argumentSourceAdmission/u.test(preload));
  pass('IPC静态接线为main-frame本地页面只读，不暴露资格record/key/publish或改AgentSkill权限');

  console.log(`Argument projection runtime: ${checks} synthetic checks passed; 0 model/network/production writes.`);
} finally {
  globalThis.fetch = previousFetch;
  const checked = path.resolve(temp);
  assert.equal(path.dirname(checked), path.resolve(os.tmpdir()));
  assert.ok(path.basename(checked).startsWith('loginote-argument-runtime-'));
  await fs.rm(checked, { recursive: true, force: true });
}
