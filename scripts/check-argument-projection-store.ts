import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { argumentProjectionBuildFixture, fixedAcceptProjectionReview } from './argument-projection-build-fixture.ts';
import { adaptSavedKnowledgeNote, adaptSavedUploadedDocument, ARGUMENT_PHYSICAL_SOURCE_VERSION } from '../src/electron/rag/argumentSourceAdapter.ts';
import { buildTextStructuredDocument } from '../src/electron/rag/structuredDocument.ts';
import { createPersistentArgumentProjectionStore, argumentProjectionLedgerFileName } from '../src/electron/rag/argumentProjectionStore.ts';
import { createStoredArgumentContextPointer, readStoredArgumentContextPack } from '../src/electron/rag/argumentProjectionReader.ts';
import { validateArgumentProjectionSourceRef } from '../src/electron/rag/argumentProjectionAuthority.ts';
import { readSavedArgumentProjectionSource } from '../src/electron/rag/argumentSavedSourceReader.ts';
import { serializeMetadata } from '../src/services/vaultFsService.ts';
import type { ArgumentProjectionAuthorityHost, ArgumentProjectionSourceRef } from '../src/electron/rag/argumentProjectionAuthority.ts';
import { prepareArgumentProjectionBuild, buildArgumentProjectionReviewInput, finalizeArgumentProjectionBuild } from '../src/services/argumentContext/construction.ts';
import type { ArgumentProjectionBuildInput, ArgumentProjectionDraft, ArgumentProjectionReview } from '../src/services/argumentContext/buildTypes.ts';
import type { NoteItem, UploadedDocument } from '../src/types.ts';
import { argumentContextHash } from '../src/services/argumentContext/hash.ts';

// Synthetic sources and a fresh temporary ledger only. No actual vault, model or embedding.
const fetchBefore = globalThis.fetch;
globalThis.fetch = async () => assert.fail('No network allowed in argument projection store checks');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'loginote-argument-projection-'));
let checks = 0, directories = 0;
const pass = (label: string) => { checks++; console.log(`PASS ${label}`); };
async function directory() { const dir = path.join(temp, String(++directories)); await fs.mkdir(dir); return dir; }
const refOf = (input: ArgumentProjectionBuildInput): ArgumentProjectionSourceRef => ({ kind: input.source.kind as ArgumentProjectionSourceRef['kind'], entityId: input.source.entityId });
function hostFor(initial: ArgumentProjectionBuildInput | null, rootScopeId: string) {
  let current = structuredClone(initial), tail: Promise<void> = Promise.resolve();
  function serial<T>(action: () => Promise<T>): Promise<T> {
    const next = tail.then(action); tail = next.then(() => undefined, () => undefined); return next;
  }
  const host: ArgumentProjectionAuthorityHost = { rootScopeId,
    withSource: (ref, action) => serial(async () => {
      validateArgumentProjectionSourceRef(ref);
      const matches = current && current.source.kind === ref.kind && current.source.entityId === ref.entityId;
      return action(matches ? structuredClone(current) : null);
    }) };
  return { host, set: (input: ArgumentProjectionBuildInput | null) => serial(async () => { current = structuredClone(input); }) };
}
async function publication(input: ArgumentProjectionBuildInput, draft: ArgumentProjectionDraft, review: ArgumentProjectionReview,
  publicationId: string, expectedActiveHash: string | null = null) {
  return { publicationId, result: await finalizeArgumentProjectionBuild(input, draft, review),
    proof: { input, draft, review }, expectedActiveHash };
}
function oneNodeDraft(input: ArgumentProjectionBuildInput, fragment: string): ArgumentProjectionDraft {
  const q = input.quotes.find((quote) => quote.completeSentence && quote.evidence.quote.includes(fragment))!;
  assert.ok(q);
  return { version: 1, buildId: input.buildId, nodes: [{ id: 'N1', role: 'definition', quoteIds: [q.quoteId] }], relations: [], groups: [],
    scopes: [{ id: 'S1', seedNodeId: 'N1', task: 'definition', requiredNodeIds: ['N1'], requiredRelationIds: [], requiredGroupIds: [], quoteIds: [q.quoteId] }] };
}

try {
  const f = await argumentProjectionBuildFixture(), rootScopeId = f.input.source.rootScopeId;
  const note: NoteItem = { id: 'synthetic-note', title: '合成选择过载', noteType: 'knowledge',
    content: '# 选择过载\r\n\r\n选择过载是指选项过多时难以决策。🧠\r\n\r\n## 条件\r\n\r\n- 超过处理阈值时可能发生。\r\n\r\n```md\r\n# 围栏不是章节\r\n```',
    createdAt: '2026-10-06T00:00:00.000Z', updatedAt: '2026-10-06T01:00:00.000Z', tags: [], links: [], backlinks: [], dueDates: [] };
  const noteScope = { ...structuredClone(f.input.scope), allowedSourceKinds: ['knowledge-note' as const], allowedNoteIds: [note.id] };
  const noteInput = await adaptSavedKnowledgeNote({ note, rootScopeId, scope: noteScope });
  assert.equal(noteInput.canonicalText, note.content); assert.equal(noteInput.source.coordinateSpace, 'saved-note-utf16');
  assert.equal(noteInput.sourceQualification.status, 'unassessed');
  assert.equal(noteInput.hierarchy.sections.length, 2);
  assert.equal(noteInput.hierarchy.sections[1].parentId, noteInput.hierarchy.sections[0].id);
  assert.ok(noteInput.chunks.every((chunk) => chunk.id.startsWith(ARGUMENT_PHYSICAL_SOURCE_VERSION)));
  assert.ok(noteInput.hierarchy.blocks.some((block) => block.kind === 'heading'));
  assert.ok(noteInput.hierarchy.blocks.some((block) => block.kind === 'code'));
  for (const q of noteInput.quotes) assert.equal(note.content.slice(q.evidence.start, q.evidence.end), q.evidence.quote);
  pass('保存版笔记CRLF/emoji及标题/列表/围栏精确物理目录，全源容器不是旧L1索引，默认未评估');

  const unchangedPersonal = { ...note, tags: ['仅个人展示标签'], pinned: true, flowSummary: '个人复述不会成为来源身份' };
  assert.equal((await adaptSavedKnowledgeNote({ note: unchangedPersonal, rootScopeId, scope: noteScope })).source.version, noteInput.source.version);
  assert.equal((await adaptSavedKnowledgeNote({ note: { ...note, updatedAt: '2026-10-06T02:00:00.000Z' }, rootScopeId, scope: noteScope })).source.version, noteInput.source.version);
  for (const altered of [{ ...note, title: '新版标题' },
    { ...note, referenceSources: [{ title: '合成来源', type: 'web' as const, url: 'https://example.org/source' }] }]) {
    assert.notEqual((await adaptSavedKnowledgeNote({ note: altered, rootScopeId, scope: noteScope })).source.version, noteInput.source.version);
  }
  for (const altered of [{ ...note, noteType: 'project' as const }, { ...note, content: '# 定义\r\n\r\n请对该知识点进行定义描述' },
    { ...note, updatedAt: undefined }, { ...note, content: '<div></div>' }]) {
    await assert.rejects(adaptSavedKnowledgeNote({ note: altered, rootScopeId, scope: noteScope }));
  }
  await assert.rejects(adaptSavedKnowledgeNote({ note, rootScopeId, scope: { ...noteScope, allowedNoteIds: [] } }));
  pass('源版本绑定正文/真实溯源/创建身份，个人活动时间不混入；项目/占位/无版本/越范围拒绝');

  const document = { ...buildTextStructuredDocument('synthetic-doc', '# 定义\n\n选择过载是指选项过多时难以决策。\n\n## 条件\n\n超过处理阈值时可能发生。'), sourceHash: 'a'.repeat(64), materialParserVersion: 1 };
  const metadata: UploadedDocument = { id: document.docId, fileName: 'synthetic.md', fileType: 'md', extension: '.md', indexable: true,
    size: 100, status: 'failed', chunkCount: 0, totalChars: document.normalizedText.length,
    parseStatus: 'ready', parsedAt: '2026-10-06T01:00:00.000Z', uploadAt: '2026-10-06T00:00:00.000Z' };
  const docScope = { ...structuredClone(f.input.scope), allowedDocIds: [metadata.id] };
  const docInput = await adaptSavedUploadedDocument({ document, metadata, rootScopeId, scope: docScope });
  assert.equal(docInput.canonicalText, document.normalizedText); assert.equal(docInput.source.coordinateSpace, 'parsed-text-utf16');
  assert.equal(docInput.sourceQualification.status, 'unassessed');
  assert.equal(docInput.chunks.length, document.blocks.length);
  assert.equal(docInput.hierarchy.sections[1].parentId, docInput.hierarchy.sections[0].id);
  const vectorReady = await adaptSavedUploadedDocument({ document, metadata: { ...metadata, status: 'ready', chunkCount: 10 }, rootScopeId, scope: docScope });
  assert.equal(vectorReady.source.version, docInput.source.version);
  for (const altered of [{ ...metadata, parseStatus: 'processing' as const }, { ...metadata, indexable: false }, { ...metadata, id: 'another-doc' }]) {
    await assert.rejects(adaptSavedUploadedDocument({ document, metadata: altered, rootScopeId, scope: docScope }));
  }
  await assert.rejects(adaptSavedUploadedDocument({ document: { ...document, sourceHash: undefined }, metadata, rootScopeId, scope: docScope }));
  const invalidLocator = structuredClone(document); invalidLocator.blocks[0].locator = { kind: 'pdf', page: 1 };
  await assert.rejects(adaptSavedUploadedDocument({ document: invalidLocator, metadata, rootScopeId, scope: docScope }));
  pass('上传只读已保存同代解析目录/locator，不以向量成功当资格；旧未版本/解析中/借doc拒绝');

  const savedRoot = await directory(), vaultRoot = path.join(savedRoot, 'vault'), userStateDir = path.join(savedRoot, 'user-state');
  await fs.mkdir(path.join(vaultRoot, 'notes'), { recursive: true }); await fs.mkdir(userStateDir);
  await fs.writeFile(path.join(vaultRoot, 'metadata.json'), serializeMetadata([note]));
  await fs.writeFile(path.join(vaultRoot, 'notes', `${note.id}.md`), note.content);
  const noteReaderOptions = { dataRoot: savedRoot, vaultRoot, userStateDir, scope: noteScope };
  assert.deepEqual(await readSavedArgumentProjectionSource(noteReaderOptions, refOf(noteInput)), noteInput);
  const unsavedDraft = { ...note, content: '这个草稿没有保存，不会作为参考' };
  assert.notEqual((await readSavedArgumentProjectionSource(noteReaderOptions, refOf(noteInput)))!.canonicalText, unsavedDraft.content);
  const journal = path.join(userStateDir, 'vault-pending-snapshot.json'); await fs.writeFile(journal, '{"syntheticPending":true}');
  await assert.rejects(readSavedArgumentProjectionSource(noteReaderOptions, refOf(noteInput)), /save_in_progress/);
  assert.equal(await fs.readFile(journal, 'utf8'), '{"syntheticPending":true}'); await fs.unlink(journal);
  await fs.writeFile(path.join(vaultRoot, 'metadata.json'), serializeMetadata([{ ...note, noteType: 'project' }]));
  assert.equal(await readSavedArgumentProjectionSource(noteReaderOptions, refOf(noteInput)), null);
  await assert.rejects(readSavedArgumentProjectionSource(noteReaderOptions, { kind: 'knowledge-note', entityId: '../escape' }));
  await fs.writeFile(path.join(vaultRoot, 'metadata.json'), '{broken');
  await assert.rejects(readSavedArgumentProjectionSource(noteReaderOptions, refOf(noteInput)), /corrupt_json/);
  assert.equal(await fs.readFile(path.join(vaultRoot, 'metadata.json'), 'utf8'), '{broken');
  pass('临时保存版metadata+目标md读取不取草稿，pending保存拒绝且不恢复，改类型/越路径/坏源明确拒绝');

  await fs.mkdir(path.join(savedRoot, 'rag-index')); await fs.mkdir(path.join(savedRoot, 'documents'));
  const originalBytes = Buffer.from('synthetic original bytes, not a user document');
  const savedDocument = { ...document, sourceHash: createHash('sha256').update(originalBytes).digest('hex') };
  await fs.writeFile(path.join(savedRoot, 'rag-index', 'manifest.json'), JSON.stringify([metadata]));
  await fs.writeFile(path.join(savedRoot, 'rag-index', `structured-${document.docId}.json`), JSON.stringify(savedDocument));
  const originalFile = path.join(savedRoot, 'documents', `${document.docId}.md`); await fs.writeFile(originalFile, originalBytes);
  const docReaderOptions = { dataRoot: savedRoot, vaultRoot, userStateDir, scope: docScope };
  assert.equal((await readSavedArgumentProjectionSource(docReaderOptions, refOf(docInput)))!.canonicalText, document.normalizedText);
  await fs.writeFile(originalFile, 'changed original');
  await assert.rejects(readSavedArgumentProjectionSource(docReaderOptions, refOf(docInput)), /source_changed/);
  await fs.unlink(originalFile); assert.equal(await readSavedArgumentProjectionSource(docReaderOptions, refOf(docInput)), null);
  await fs.writeFile(path.join(savedRoot, 'rag-index', 'manifest.json'), JSON.stringify([]));
  assert.equal(await readSavedArgumentProjectionSource(docReaderOptions, refOf(docInput)), null);
  pass('临时上传manifest+已保存parse+原始字节SHA独立回核，文件变化/删除/孤立缓存不返回旧原文');

  const unassessedHost = hostFor(noteInput, rootScopeId), unassessedDir = await directory();
  const unassessedStore = createPersistentArgumentProjectionStore(unassessedDir, unassessedHost.host);
  const noteDraft = oneNodeDraft(noteInput, '是指'), noteReviewInput = await buildArgumentProjectionReviewInput(noteInput, noteDraft);
  const noteRequest = await publication(noteInput, noteDraft, fixedAcceptProjectionReview(noteReviewInput), 'unassessed');
  const held = await unassessedStore.publish(noteRequest); assert.equal(held.status, 'held');
  assert.equal(held.persistence.strategy, 'rename-only'); assert.equal(await unassessedStore.read(refOf(noteInput)), null);
  assert.deepEqual(await createPersistentArgumentProjectionStore(unassessedDir, unassessedHost.host).readStaged(refOf(noteInput), 'unassessed'), noteRequest.result);
  pass('真实适配默认未评估，即使合成全accept审核也只持久化待审，重启不能成为自动评分参考');

  const dir = await directory(), state = hostFor(f.input, rootScopeId), ref = refOf(f.input);
  const store = createPersistentArgumentProjectionStore(dir, state.host);
  const request = await publication(f.input, f.draft, f.review, 'published-A');
  assert.equal(await store.read(ref), null);
  assert.equal((await store.publish(request)).status, 'published');
  const ledgerFile = path.join(dir, argumentProjectionLedgerFileName(rootScopeId));
  const bytes = await fs.readFile(ledgerFile, 'utf8'); assert.ok(bytes.includes('published-A'));
  assert.deepEqual(await store.read(ref), request.result);
  const reopened = createPersistentArgumentProjectionStore(dir, state.host);
  assert.deepEqual(await reopened.read(ref), request.result);
  assert.deepEqual(await reopened.publish(request), await store.publish(request));
  assert.equal(await fs.readFile(ledgerFile, 'utf8'), bytes);
  const clone = await reopened.read(ref); clone!.projection.nodes[0].role = 'fact';
  assert.deepEqual(await store.read(ref), request.result);
  pass('独立源核对后rename-only单ledger落盘，重建实例回放读取/回执幂等，无共享可变图');

  const pointer = await createStoredArgumentContextPointer(reopened, ref, ['N5']); assert.ok(pointer);
  const pack = await readStoredArgumentContextPack(reopened, { pointer: pointer!, task: 'reasoning' });
  assert.equal(pack!.completeness.status, 'complete_for_scope'); assert.equal(pack!.limitations.writes, 'disabled');
  const limited = await readStoredArgumentContextPack(reopened, { pointer: pointer!, task: 'reasoning', budget: { maxDepth: 0 } });
  assert.equal(limited!.completeness.status, 'partial');
  const forgedPointer = structuredClone(pointer!); forgedPointer.scopeHash = '0'.repeat(64);
  await assert.rejects(readStoredArgumentContextPack(reopened, { pointer: forgedPointer, task: 'reasoning' }));
  const fakeRef = { kind: 'personal-cognition', entityId: ref.entityId } as any;
  await assert.rejects(store.read(fakeRef));
  await assert.rejects(readStoredArgumentContextPack(reopened, { pointer: pointer!, task: 'general', authority: request.result.authority } as any));
  pass('磁盘权威投影→宿主范围指针→S1多步包，预算缺口明确；不能借私人库、伪权限或注入authority');

  const partialReview = structuredClone(f.review); partialReview.nodes[0].decision = 'unknown'; partialReview.nodes[0].roleSupported = false;
  const partialRequest = await publication(f.input, f.draft, partialReview, 'partial-A', request.result.authority.structureHash);
  assert.equal((await reopened.publish(partialRequest)).status, 'held');
  assert.deepEqual(await store.read(ref), request.result);
  assert.deepEqual(await createPersistentArgumentProjectionStore(dir, state.host).readStaged(ref, 'partial-A'), partialRequest.result);
  await assert.rejects(store.publish({ ...request, expectedActiveHash: '0'.repeat(64) }), /idempotency/);
  pass('partial/reject审计重启保留、不覆盖active；同ID不能换内容或覆盖基线');

  const sourceB = structuredClone(f.sourceInput); sourceB.source.version = 'synthetic-B';
  const inputB = await prepareArgumentProjectionBuild(sourceB), draftB = { ...structuredClone(f.draft), buildId: inputB.buildId };
  const reviewB = fixedAcceptProjectionReview(await buildArgumentProjectionReviewInput(inputB, draftB));
  const requestB = await publication(inputB, draftB, reviewB, 'published-B');
  await state.set(inputB);
  assert.equal(await store.read(ref), null); assert.equal(await reopened.readStaged(ref, 'partial-A'), null);
  assert.equal(await readStoredArgumentContextPack(reopened, { pointer: pointer!, task: 'reasoning' }), null);
  assert.equal((await reopened.publish(requestB)).status, 'published');
  await state.set(f.input); assert.equal(await reopened.read(ref), null);
  await assert.rejects(store.publish(request), /source_changed/);
  assert.equal((await reopened.publish({ ...request, publicationId: 'A-fresh' })).status, 'published');
  pass('已观察A→B→A持久世代隔离旧指针/待审/回执，新世代null基线可激活，不能复活旧ID');

  await state.set(null); assert.equal(await reopened.read(ref), null);
  await state.set(f.input); assert.equal(await createPersistentArgumentProjectionStore(dir, state.host).read(ref), null);
  await assert.rejects(reopened.publish({ ...request, publicationId: 'A-fresh' }), /source_changed/);
  const deletedFresh = { ...request, publicationId: 'after-recreate' };
  await reopened.publish(deletedFresh);
  const deniedInput = await prepareArgumentProjectionBuild({ ...f.sourceInput, scope: { ...f.input.scope, scopeId: 'changed-selection' } });
  await state.set(deniedInput); assert.equal(await reopened.read(ref), null);
  await state.set(f.input); assert.equal(await store.read(ref), null);
  pass('删除/再创建与选择范围变化登记tombstone/世代，重启及同ID不退回旧active');

  const raceDir = await directory(), raceHost = hostFor(f.input, rootScopeId);
  const raceA = createPersistentArgumentProjectionStore(raceDir, raceHost.host), raceB = createPersistentArgumentProjectionStore(raceDir, raceHost.host);
  const races = await Promise.allSettled([raceA.publish({ ...request, publicationId: 'race-A' }), raceB.publish({ ...request, publicationId: 'race-B' })]);
  assert.equal(races.filter((result) => result.status === 'fulfilled').length, 1);
  assert.match((races.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason.message, /cas_mismatch/);
  assert.equal((await raceA.publish({ ...request, publicationId: 'after-race', expectedActiveHash: request.result.authority.structureHash })).status, 'published');
  pass('两实例共享同目录完整事务队列，并发旧基线仅一成功，失败不毒化后续发布');

  const leasedDir = await directory(), leasedHost = hostFor(f.input, rootScopeId);
  let enterWrite!: () => void, releaseWrite!: () => void, sourceChanged = false;
  const enteredWrite = new Promise<void>((resolve) => { enterWrite = resolve; });
  const releasedWrite = new Promise<void>((resolve) => { releaseWrite = resolve; });
  const leasedStore = createPersistentArgumentProjectionStore(leasedDir, leasedHost.host, { write: async (file, text) => {
    enterWrite(); await releasedWrite; await fs.writeFile(file, text);
  } });
  const leasedPublish = leasedStore.publish({ ...request, publicationId: 'source-lease' });
  await enteredWrite;
  const mutateDuringCommit = leasedHost.set(inputB).then(() => { sourceChanged = true; });
  assert.equal(sourceChanged, false); releaseWrite();
  assert.equal((await leasedPublish).status, 'published'); await mutateDuringCommit;
  assert.equal(await createPersistentArgumentProjectionStore(leasedDir, leasedHost.host).read(ref), null);
  pass('确定性暂停临时写入时同host源变更必须等待事务，提交后变更立即隔离旧active');

  const failDir = await directory(), failHost = hostFor(f.input, rootScopeId);
  const baselineStore = createPersistentArgumentProjectionStore(failDir, failHost.host); await baselineStore.publish(request);
  const beforeFailure = await fs.readFile(path.join(failDir, argumentProjectionLedgerFileName(rootScopeId)), 'utf8');
  const failedStore = createPersistentArgumentProjectionStore(failDir, failHost.host, { write: async () => { throw new Error('synthetic disk failure'); } });
  await assert.rejects(failedStore.publish({ ...request, publicationId: 'disk-failed', expectedActiveHash: request.result.authority.structureHash }));
  assert.equal(await fs.readFile(path.join(failDir, argumentProjectionLedgerFileName(rootScopeId)), 'utf8'), beforeFailure);
  assert.deepEqual(await baselineStore.read(ref), request.result);
  assert.equal((await baselineStore.publish({ ...request, publicationId: 'disk-failed', expectedActiveHash: request.result.authority.structureHash })).status, 'published');
  assert.equal((await fs.readdir(failDir)).filter((file) => file.endsWith('.tmp')).length, 0);
  pass('磁盘失败不改旧ledger、不报成功、不推进内存，临时文件清理、原请求可重试');

  const corruptDir = await directory(), corruptHost = hostFor(f.input, rootScopeId);
  const corruptStore = createPersistentArgumentProjectionStore(corruptDir, corruptHost.host); await corruptStore.publish(request);
  const corruptFile = path.join(corruptDir, argumentProjectionLedgerFileName(rootScopeId));
  await fs.writeFile(corruptFile, '{broken', 'utf8');
  await assert.rejects(corruptStore.read(ref)); await assert.rejects(corruptStore.publish({ ...request, publicationId: 'cannot-overwrite-corruption' }));
  assert.equal(await fs.readFile(corruptFile, 'utf8'), '{broken');
  const wrongHost = hostFor(f.input, 'other-root'), wrongStore = createPersistentArgumentProjectionStore(await directory(), wrongHost.host);
  await assert.rejects(wrongStore.publish(request));
  const independent = createPersistentArgumentProjectionStore(await directory(), state.host); assert.equal(await independent.read(ref), null);
  pass('坏JSON不冒空库覆盖，根/目录隔离，当前host身份与客户端声明不同则拒绝');

  const tamperDir = await directory(), tamperStore = createPersistentArgumentProjectionStore(tamperDir, hostFor(f.input, rootScopeId).host);
  await tamperStore.publish(request);
  const tamperFile = path.join(tamperDir, argumentProjectionLedgerFileName(rootScopeId));
  const forgedLedger = JSON.parse(await fs.readFile(tamperFile, 'utf8'));
  forgedLedger.sources[0].operations[0].request.proof.review.nodes[0].roleSupported = false;
  const { ledgerHash: _tamperHash, ...tamperBody } = forgedLedger; forgedLedger.ledgerHash = await argumentContextHash(tamperBody);
  await fs.writeFile(tamperFile, JSON.stringify(forgedLedger));
  await assert.rejects(tamperStore.read(ref), /unsupported_accept/);
  const oversizeDir = await directory(), oversizedFile = path.join(oversizeDir, argumentProjectionLedgerFileName(rootScopeId));
  const oversizedHandle = await fs.open(oversizedFile, 'wx');
  try { await oversizedHandle.truncate(32 * 1024 * 1024 + 1); } finally { await oversizedHandle.close(); }
  await assert.rejects(createPersistentArgumentProjectionStore(oversizeDir, state.host).read(ref), /unsafe_ledger_file/);
  const badWriterDir = await directory(), badWriterHost = hostFor(f.input, rootScopeId);
  const badWriter = createPersistentArgumentProjectionStore(badWriterDir, badWriterHost.host, { write: async (file) => { await fs.writeFile(file, 'wrong temporary payload'); } });
  await assert.rejects(badWriter.publish(request), /temporary_payload_changed/);
  assert.equal((await fs.readdir(badWriterDir)).length, 0);
  pass('回算ledgerHash仍须独立proof回放，超大文件/错误临时载荷拒绝，不生成半成品active');

  const forged = structuredClone(request) as any; forged.proof.review.nodes[0].extra = undefined;
  await state.set(f.input);
  await assert.rejects(store.publish({ ...forged, publicationId: 'undefined-field' }));
  const snapshot = structuredClone(request); const pending = independent.publish({ ...snapshot, publicationId: 'snapshot' });
  snapshot.result.projection.nodes[0].role = 'fact'; snapshot.proof.input.scope.allowedDocIds = [];
  await pending; assert.deepEqual(await independent.read(ref), request.result);
  pass('持久化重放保持闭合schema和首次await前输入克隆，不因自hash或undefined字段放宽');

  console.log(`Argument projection store checks passed: ${checks} groups (synthetic temporary files, fixed reviewer votes; 0 model calls; no real vault/index/score/cognition writes).`);
} finally {
  globalThis.fetch = fetchBefore;
  assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temp).startsWith('loginote-argument-projection-'));
  await fs.rm(temp, { recursive: true, force: true });
}
