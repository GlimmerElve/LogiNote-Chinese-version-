import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { argumentProjectionBuildFixture } from './argument-projection-build-fixture.ts';
import { prepareArgumentProjectionBuild, finalizeArgumentProjectionBuild, buildArgumentProjectionReviewInput } from '../src/services/argumentContext/construction.ts';
import { fixedAcceptProjectionReview } from './argument-projection-build-fixture.ts';
import { argumentContextHash } from '../src/services/argumentContext/hash.ts';
import { createPersistentArgumentProjectionStore, type ArgumentProjectionActiveBinding } from '../src/electron/rag/argumentProjectionStore.ts';
import { createPersistentSourcePropositionStore, sourcePropositionLedgerFileName, SOURCE_PROPOSITION_STORE_LIMITS } from '../src/electron/rag/referenceSourcePropositionStore.ts';
import { prepareSourcePropositionContext, prepareSourcePropositionReviewInput, finalizeSourcePropositions,
  type SourcePropositionDraft, type SourcePropositionProof, type SourcePropositionReview } from '../src/services/reviewComparison/sourcePropositionAnchors.ts';
import type { ArgumentProjectionAuthorityHost, ArgumentProjectionSourceRef } from '../src/electron/rag/argumentProjectionAuthority.ts';
import type { ArgumentProjectionBuildInput } from '../src/services/argumentContext/buildTypes.ts';

const oldFetch = globalThis.fetch; globalThis.fetch = async () => assert.fail('Persistent source proposition tests forbid network');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'loginote-source-proposition-store-'));
const clone = <T>(value: T): T => structuredClone(value);
let checks = 0, directoryCount = 0;
const pass = (label: string) => { checks++; console.log(`PASS ${label}`); };
async function directory() { const value = path.join(temporary, String(++directoryCount)); await fs.mkdir(value); return value; }
const held = (value: { status: string; reasons?: string[] }, code?: string) => {
  assert.equal(value.status, 'held', JSON.stringify(value)); if (code) assert.deepEqual(value.reasons, [`source_proposition_store_${code}`]);
};
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
async function rehashLedger(file: string, mutate: (value: any) => void) {
  const value = JSON.parse(await fs.readFile(file, 'utf8')); mutate(value);
  const { ledgerHash: _hash, ...body } = value; value.ledgerHash = await argumentContextHash(body);
  await fs.writeFile(file, JSON.stringify(value));
}
async function sourceProof(input: ArgumentProjectionBuildInput, result: SourcePropositionProof['result']): Promise<SourcePropositionProof> {
  const context = await prepareSourcePropositionContext(input, result);
  const draft: SourcePropositionDraft = { version: 1, protocol: 'review-source-proposition-draft-v1', contextHash: await argumentContextHash(context),
    anchors: context.projection.nodes.map(node => {
      const span = node.evidence[0], quote = input.quotes.find(q => q.evidence.sentenceId === span.sentenceId
        && q.evidence.start === span.start && q.evidence.end === span.end)!;
      return { id: `P-${node.id}`, nodeId: node.id, quoteId: quote.quoteId, start: span.start, end: span.end, text: span.quote };
    }) };
  const prepared = await prepareSourcePropositionReviewInput(context, draft);
  const review: SourcePropositionReview = { version: 1, protocol: 'review-source-proposition-review-v1', reviewId: prepared.reviewId,
    contextHash: prepared.contextHash, draftHash: prepared.draftHash, anchors: draft.anchors.map(anchor => ({ id: anchor.id, decision: 'accept',
      roleSupported: true, completeMeaning: true, scopePreserved: true, reason: '纯合成固定审核票；仅验证程序合同，不认证语义。' })) };
  const ready = await finalizeSourcePropositions(context, draft, review); assert.ok(ready.status === 'ready', JSON.stringify(ready));
  return { input: clone(input), result: clone(result), draft, review, bundle: ready.bundle };
}
function hostFor(input: ArgumentProjectionBuildInput) {
  let saved: ArgumentProjectionBuildInput | null = clone(input), denied = false, revoked = false, physicalChange = false, physicalOnExit = false;
  let tail = Promise.resolve();
  function serial<T>(action: () => Promise<T>) { const job = tail.then(action); tail = job.then(() => undefined, () => undefined); return job; }
  const guard = () => { if (revoked) throw new Error('synthetic_root_lease_revoked'); if (denied) throw new Error('synthetic_scope_denied'); };
  const host: ArgumentProjectionAuthorityHost = { rootScopeId: input.source.rootScopeId, assertCurrent: guard,
    withSource: (ref, action) => serial(async () => {
      guard(); const current = saved && saved.source.kind === ref.kind && saved.source.entityId === ref.entityId ? clone(saved) : null;
      const result = await action(current); guard(); return result;
    }),
    withSourceValidity: (ref, action, onChanged) => serial(async () => {
      guard(); if (physicalChange) return onChanged() as Promise<never>;
      const current = saved && saved.source.kind === ref.kind && saved.source.entityId === ref.entityId ? clone(saved) : null;
      const result = await action(current); guard(); if (physicalOnExit) physicalChange = true;
      if (physicalChange) return onChanged() as Promise<never>; return result;
    }) };
  return { host, set: (next: ArgumentProjectionBuildInput | null) => serial(async () => { saved = clone(next); }),
    deny: (value: boolean) => { denied = value; }, revoke: (value: boolean) => { revoked = value; },
    physical: (value: boolean) => { physicalChange = value; }, physicalOnExit: (value: boolean) => { physicalOnExit = value; } };
}

try {
  const f = await argumentProjectionBuildFixture(), result = await finalizeArgumentProjectionBuild(f.input, f.draft, f.review);
  const proof = await sourceProof(f.input, result), root = f.input.source.rootScopeId;
  const ref: ArgumentProjectionSourceRef = { kind: f.input.source.kind as ArgumentProjectionSourceRef['kind'], entityId: f.input.source.entityId };
  const state = hostFor(f.input), projectionDir = await directory();
  const projections = createPersistentArgumentProjectionStore(projectionDir, state.host);
  const publication = { publicationId: 'synthetic-source-store-publication-A', result, proof: { input: f.input, draft: f.draft, review: f.review }, expectedActiveHash: null };
  assert.equal((await projections.publish(publication)).status, 'published');
  async function binding(): Promise<ArgumentProjectionActiveBinding> {
    const value = await projections.withActiveBinding!(ref, async (_result, _input, current) => current); assert.ok(value); return value;
  }
  const initialBinding = await binding(), dir = await directory(), file = path.join(dir, sourcePropositionLedgerFileName(root));
  const store = createPersistentSourcePropositionStore(dir, projections, root);
  assert.equal(await store.read(ref), null); await assert.rejects(fs.access(file));
  const neverCreated = path.join(temporary, 'never-created', 'child');
  assert.equal(await createPersistentSourcePropositionStore(neverCreated, projections, root).read(ref), null);
  await assert.rejects(fs.access(path.join(temporary, 'never-created')));
  pass('构造及缺失read无写入、不创建目录，宿主active publication独立回读；全程禁用network/model');

  assert.equal((await store.publish(ref, initialBinding, proof)).status, 'stored');
  const firstBytes = await fs.readFile(file, 'utf8'), ledger = JSON.parse(firstBytes);
  assert.equal(ledger.contractVersion, 'reference-source-proposition-ledger-v1'); assert.equal(ledger.rootScopeId, root);
  assert.deepEqual(ledger.sources[0].active.binding, initialBinding); assert.deepEqual(ledger.sources[0].active.proof, proof);
  assert.equal((await store.publish(ref, initialBinding, proof)).status, 'stored'); assert.equal(await fs.readFile(file, 'utf8'), firstBytes);
  assert.deepEqual(await createPersistentSourcePropositionStore(dir, projections, root).read(ref), proof);
  const detached = await store.read(ref); detached!.bundle.anchors[0].text = '不能修改共享缓存'; assert.deepEqual(await store.read(ref), proof);
  pass('完整原始proof/独立审票/源版本/scope/实际pubId+epoch原子落盘，重启零调用复用、幂等与副本隔离');

  held(await store.publish(ref, { ...initialBinding, publicationId: 'self-claimed-publication' }, proof), 'publication_changed');
  held(await store.publish(ref, { ...initialBinding, epoch: initialBinding.epoch + 1 }, proof), 'publication_changed');
  assert.deepEqual(await store.read(ref), proof);
  const wrongRoot = createPersistentSourcePropositionStore(await directory(), projections, 'different-synthetic-root');
  held(await wrongRoot.publish(ref, initialBinding, proof), 'wrong_source');
  assert.equal(await wrongRoot.read(ref), null);
  held(await store.publish({ ...ref, entityId: 'different-entity' }, initialBinding, proof), 'wrong_source');
  for (const value of [{ ...ref, kind: 'personal-cognition' }, { ...ref, entityId: '../escape' }, { ...ref, secret: 'reject-extra-field' }])
    held(await store.publish(value as ArgumentProjectionSourceRef, initialBinding, proof));
  pass('错误root/ref/私人库/路径/扩展字段/自报pubId+epoch均不能授权，错误候选不抹除当前合法资产');

  const badProof = clone(proof); badProof.review.anchors[0].roleSupported = false;
  held(await store.publish(ref, initialBinding, badProof), 'proof_invalid');
  const accessor: Record<string, unknown> = { ...clone(ref) }; Object.defineProperty(accessor, 'kind', { enumerable: true, get() { assert.fail('Getter must not execute'); } });
  held(await store.publish(accessor as unknown as ArgumentProjectionSourceRef, initialBinding, proof), 'invalid_data');
  const symbolic = clone(proof) as SourcePropositionProof & { [key: symbol]: string }; symbolic[Symbol('injection')] = 'hidden';
  held(await store.publish(ref, initialBinding, symbolic), 'invalid_data');
  const huge = clone(proof); huge.input.canonicalText = 'x'.repeat(SOURCE_PROPOSITION_STORE_LIMITS.proofCharacters + 1);
  held(await store.publish(ref, initialBinding, huge), 'proof_budget');
  pass('proof必须闭合重建；getter/symbol/拒绝票和超256k字符候选模型前held，不采自哈希或调用访问器');

  const hiddenProofLength = clone(proof); Object.defineProperty(hiddenProofLength, 'length', { value: 0, enumerable: false });
  held(await store.publish(ref, initialBinding, hiddenProofLength), 'invalid_data');
  const hiddenRefLength = clone(ref); Object.defineProperty(hiddenRefLength, 'length', { value: 0, enumerable: false });
  held(await store.publish(hiddenRefLength, initialBinding, proof), 'invalid_data');
  assert.equal(await fs.readFile(file, 'utf8'), firstBytes);
  pass('只有数组length可不枚举；普通proof/ref隐藏length在复制及写盘前拒绝，保留原资产字节');

  const otherReview = clone(proof.review); otherReview.anchors[0].reason = '另一份虽有效但不是原审票';
  const alternate = await finalizeSourcePropositions(await prepareSourcePropositionContext(proof.input, proof.result), proof.draft, otherReview); assert.ok(alternate.status === 'ready');
  held(await store.publish(ref, initialBinding, { ...clone(proof), review: otherReview, bundle: alternate.bundle }), 'audit_conflict');
  assert.equal(await fs.readFile(file, 'utf8'), firstBytes);
  pass('同一publication的不同审核不能悄悄覆盖已保存票；明确audit conflict保持旧账本');

  state.deny(true); await assert.rejects(store.read(ref), /read_unavailable/); state.deny(false);
  assert.equal(await fs.readFile(file, 'utf8'), firstBytes); assert.deepEqual(await store.read(ref), proof);
  state.revoke(true); await assert.rejects(store.read(ref), /read_unavailable/); state.revoke(false);
  assert.equal(await fs.readFile(file, 'utf8'), firstBytes);
  pass('scope拒绝/根lease暂不可用fail closed，不把权限异常当删除或持久抹除其它scope资产');

  assert.equal((await projections.publish({ ...publication, publicationId: 'synthetic-source-store-publication-A2', expectedActiveHash: result.authority.structureHash })).status, 'published');
  const secondBinding = await binding(); assert.notEqual(secondBinding.publicationId, initialBinding.publicationId);
  assert.equal(secondBinding.resultHash, initialBinding.resultHash); assert.equal(secondBinding.structureHash, initialBinding.structureHash);
  assert.equal(await store.read(ref), null); const retired = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(retired.sources[0].active, null); assert.equal(retired.sources[0].tombstone.reason, 'publication_changed');
  assert.equal(await createPersistentSourcePropositionStore(dir, projections, root).read(ref), null);
  held(await store.publish(ref, initialBinding, proof), 'publication_changed');
  assert.equal((await store.publish(ref, secondBinding, proof)).status, 'stored');
  pass('同hash重发布也以真实pubId隔离旧资产，持久tombstone跨重启保留，不借旧票自动激活');

  const changedInput = await prepareArgumentProjectionBuild({ ...clone(f.sourceInput), source: { ...clone(f.sourceInput.source), version: 'synthetic-source-B' } });
  await state.set(changedInput); assert.equal(await store.read(ref), null);
  await state.set(f.input); assert.equal(await createPersistentSourcePropositionStore(dir, projections, root).read(ref), null);
  assert.equal(await projections.read(ref), null);
  const requestA3 = { ...publication, publicationId: 'synthetic-source-store-A3-after-ABA' };
  assert.equal((await projections.publish(requestA3)).status, 'published'); const thirdBinding = await binding(); assert.ok(thirdBinding.epoch > secondBinding.epoch);
  held(await store.publish(ref, secondBinding, proof), 'publication_changed'); assert.equal((await store.publish(ref, thirdBinding, proof)).status, 'stored');
  pass('已观察源A→B→A持久隔离，重启读不能复活，旧epoch不得借新源发布；显式新publication才可重新保存');

  await state.set(null); assert.equal(await store.read(ref), null); await state.set(f.input);
  assert.equal(await createPersistentSourcePropositionStore(dir, projections, root).read(ref), null);
  assert.equal((await projections.publish({ ...publication, publicationId: 'synthetic-source-after-delete' })).status, 'published');
  const afterDeletionBinding = await binding(); assert.equal((await store.publish(ref, afterDeletionBinding, proof)).status, 'stored');
  pass('宿主确认源删除时仅derived tombstone，恢复源/重启不会自动恢复旧审核资产');

  state.physical(true); assert.equal(await store.read(ref), null); state.physical(false);
  assert.equal(await createPersistentSourcePropositionStore(dir, projections, root).read(ref), null);
  assert.equal((await projections.publish({ ...publication, publicationId: 'synthetic-source-after-physical-change' })).status, 'published');
  let currentBinding = await binding(); assert.equal((await store.publish(ref, currentBinding, proof)).status, 'stored');
  pass('可信projection确认的物理source_changed也持久invalidate，不把通用异常扩大成权限');

  const physicalRaceDir = await directory(), physicalRaceFile = path.join(physicalRaceDir, sourcePropositionLedgerFileName(root));
  state.physicalOnExit(true);
  held(await createPersistentSourcePropositionStore(physicalRaceDir, projections, root).publish(ref, currentBinding, proof), 'source_unavailable');
  const afterPhysicalRace = JSON.parse(await fs.readFile(physicalRaceFile, 'utf8'));
  assert.equal(afterPhysicalRace.sources[0].active, null); assert.equal(afterPhysicalRace.sources[0].tombstone.reason, 'source_unavailable');
  state.physicalOnExit(false); state.physical(false);
  assert.equal((await projections.publish({ ...publication, publicationId: 'synthetic-source-after-commit-race' })).status, 'published');
  currentBinding = await binding(); assert.equal((await store.publish(ref, currentBinding, proof)).status, 'stored');
  pass('资料在derived rename后、源事务退出前变化：不给stored票，已写资产持久tombstone，提交竞态不泄露旧proof');

  const validBytes = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, '{broken'); await assert.rejects(store.read(ref), /corrupt_json/); assert.equal(await fs.readFile(file, 'utf8'), '{broken');
  await fs.writeFile(file, validBytes); await rehashLedger(file, value => { value.sources[0].active.proof.review.anchors[0].completeMeaning = false; });
  await assert.rejects(store.read(ref), /proof_invalid/);
  await fs.writeFile(file, validBytes); await rehashLedger(file, value => { value.sources[0].keyHash = 'f'.repeat(64); });
  await assert.rejects(store.read(ref), /invalid_source_key/);
  await fs.writeFile(file, validBytes); await rehashLedger(file, value => { value.sources[0].ref.extra = true; });
  await assert.rejects(store.read(ref), /invalid_shape/);
  await fs.writeFile(file, Buffer.from([0xff, 0xfe])); await assert.rejects(store.read(ref), /invalid_utf8/);
  await fs.writeFile(file, validBytes);
  pass('坏JSON/UTF8/闭合schema/源键与票篡改拒绝；重算ledgerHash不能绕过proof重建，不自动恢复或覆写坏文件');

  let cancelled = true;
  held(await store.publish(ref, currentBinding, proof, () => { if (cancelled) throw new Error('synthetic_cancel'); }));
  await assert.rejects(store.read(ref, () => { if (cancelled) throw new Error('synthetic_cancel'); }), /synthetic_cancel/);
  assert.equal(await fs.readFile(file, 'utf8'), validBytes); cancelled = false;
  pass('请求开始前取消不会read/write或虚构保存回执');

  const cancelDir = await directory(), cancelFile = path.join(cancelDir, sourcePropositionLedgerFileName(root));
  let cancelBeforeRename = false;
  const cancelledStore = createPersistentSourcePropositionStore(cancelDir, projections, root, { write: async (temp, text) => {
    await fs.writeFile(temp, text, { flag: 'wx' }); cancelBeforeRename = true;
  } });
  held(await cancelledStore.publish(ref, currentBinding, proof, () => { if (cancelBeforeRename) throw new Error('synthetic_cancel'); }));
  await assert.rejects(fs.access(cancelFile)); assert.deepEqual(await fs.readdir(cancelDir), []);
  pass('临时文件完成后、rename前取消不提交，精确临时文件回收，无copy fallback');

  const afterDir = await directory(), afterFile = path.join(afterDir, sourcePropositionLedgerFileName(root));
  const rename = fs.rename; let afterRenameCancelled = false;
  fs.rename = async (...args) => { await rename(...args); if (args[1] === afterFile) afterRenameCancelled = true; };
  try {
    const afterStore = createPersistentSourcePropositionStore(afterDir, projections, root);
    held(await afterStore.publish(ref, currentBinding, proof, () => { if (afterRenameCancelled) throw new Error('synthetic_cancel'); }), 'committed_lease_revoked');
    assert.ok((await fs.readFile(afterFile, 'utf8')).includes(proof.bundle.bundleHash)); assert.deepEqual(await fs.readdir(afterDir), [path.basename(afterFile)]);
  } finally { fs.rename = rename; }
  assert.deepEqual(await createPersistentSourcePropositionStore(afterDir, projections, root).read(ref), proof);
  pass('rename后取消如实held committed_lease_revoked，已提交文件不假装回滚；以后新合法lease独立读取');

  const failedDir = await directory(), failedFile = path.join(failedDir, sourcePropositionLedgerFileName(root));
  fs.rename = async () => { throw Object.assign(new Error('synthetic rename failure'), { code: 'EPERM' }); };
  try { held(await createPersistentSourcePropositionStore(failedDir, projections, root).publish(ref, currentBinding, proof)); }
  finally { fs.rename = rename; }
  await assert.rejects(fs.access(failedFile)); assert.deepEqual(await fs.readdir(failedDir), []);
  pass('rename失败不copy、不给stored票，临时文件清理且目标不存在');

  const poisonedDir = await directory();
  held(await createPersistentSourcePropositionStore(poisonedDir, projections, root, { write: async (temp) => fs.writeFile(temp, 'changed', { flag: 'wx' }) })
    .publish(ref, currentBinding, proof), 'temporary_payload_changed');
  assert.deepEqual(await fs.readdir(poisonedDir), []);
  const linkDestination = await directory(), linkDirectory = path.join(temporary, 'linked-derived-directory');
  await fs.symlink(linkDestination, linkDirectory, 'junction');
  await assert.rejects(createPersistentSourcePropositionStore(linkDirectory, projections, root).read(ref), /unsafe_directory/);
  held(await createPersistentSourcePropositionStore(linkDirectory, projections, root).publish(ref, currentBinding, proof), 'unsafe_directory');
  assert.deepEqual(await fs.readdir(linkDestination), []);
  const fileLinkDir = await directory(), fileLink = path.join(fileLinkDir, sourcePropositionLedgerFileName(root));
  // Windows file symlinks require a privilege not assumed by offline checks.
  // A real directory junction at the ledger target exercises the same unsafe
  // final-target boundary without elevating the test process.
  await fs.symlink(dir, fileLink, 'junction'); await assert.rejects(createPersistentSourcePropositionStore(fileLinkDir, projections, root).read(ref), /unsafe_file/);
  held(await createPersistentSourcePropositionStore(fileLinkDir, projections, root).publish(ref, currentBinding, proof), 'unsafe_file');
  assert.equal(await fs.readFile(file, 'utf8'), validBytes);
  pass('custom writer仅临时路径且必须exact UTF8/fsync；真实目录和目标junction拒绝，不触碰外部目标');

  const sparseDir = await directory(), sparseFile = path.join(sparseDir, sourcePropositionLedgerFileName(root));
  const sparse = await fs.open(sparseFile, 'wx'); await sparse.truncate(SOURCE_PROPOSITION_STORE_LIMITS.bytes + 1); await sparse.close();
  await assert.rejects(createPersistentSourcePropositionStore(sparseDir, projections, root).read(ref), /unsafe_file/);
  pass('32MiB文件预算在读入前拒绝大文件，未分配无限JSON内存');

  const capacityDir = await directory(), capacityFile = path.join(capacityDir, sourcePropositionLedgerFileName(root));
  const sources = Array.from({ length: SOURCE_PROPOSITION_STORE_LIMITS.sources }, (_, index) => {
    const syntheticRef = { kind: ref.kind, entityId: `synthetic-retired-capacity-${index}` };
    return { keyHash: sha(JSON.stringify([root, 'reference-propositions', syntheticRef.kind, syntheticRef.entityId])), ref: syntheticRef,
      revision: 1, active: null, tombstone: { bindingHash: 'a'.repeat(64), reason: 'source_unavailable' } };
  });
  const capacityLedger = { version: 1, contractVersion: 'reference-source-proposition-ledger-v1', rootScopeId: root, generation: 1, sources };
  await fs.writeFile(capacityFile, JSON.stringify({ ...capacityLedger, ledgerHash: await argumentContextHash(capacityLedger) }));
  held(await createPersistentSourcePropositionStore(capacityDir, projections, root).publish(ref, currentBinding, proof), 'source_capacity');
  assert.equal(JSON.parse(await fs.readFile(capacityFile, 'utf8')).sources.length, SOURCE_PROPOSITION_STORE_LIMITS.sources);
  pass('256源（包括持久tombstone）容量保守拒绝第257源，不静默驱逐审计记录');

  const independentDir = await directory(), a = createPersistentSourcePropositionStore(independentDir, projections, root), b = createPersistentSourcePropositionStore(independentDir, projections, root);
  const outputs = await Promise.all([a.publish(ref, currentBinding, proof), b.publish(ref, currentBinding, proof)]);
  assert.ok(outputs.every(output => output.status === 'stored')); assert.equal(JSON.parse(await fs.readFile(path.join(independentDir, sourcePropositionLedgerFileName(root)), 'utf8')).generation, 1);
  pass('同进程同目录实例共享串行队列，并发同票幂等；不虚称跨进程锁已解决');

  const unqualifiedInput = await prepareArgumentProjectionBuild({ ...clone(f.sourceInput), sourceQualification: { ...clone(f.sourceInput.sourceQualification), status: 'unassessed' } });
  await state.set(unqualifiedInput); assert.equal(await store.read(ref), null); await state.set(f.input);
  assert.equal(await createPersistentSourcePropositionStore(dir, projections, root).read(ref), null);
  pass('资格撤回/变更不再可用，即使旧proof全accept也须源当前active资格，恢复源不隐式复活');

  assert.throws(() => createPersistentSourcePropositionStore('relative/path', projections, root), /absolute_directory_required/);
  assert.throws(() => createPersistentSourcePropositionStore(dir, { ...projections, withActiveBinding: undefined }, root), /active_binding_required/);
  assert.throws(() => createPersistentSourcePropositionStore(dir, projections, '../root'), /invalid_root/);
  pass('工厂必须绝对安全目录、有效root和独立active binding宿主，旧hash-only内存store不能冒充authority');
  console.log(`Reference source proposition store: ${checks} check groups passed (offline, synthetic sources/votes only).`);
} finally {
  globalThis.fetch = oldFetch;
  // Exact mkdtemp fixture only; never a user vault/workspace/root directory.
  await fs.rm(temporary, { recursive: true, force: true });
}
