import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { deriveArgumentLearningScope, parseArgumentEnvironmentSelection } from '../src/electron/rag/argumentLearningScope.ts';
import { createArgumentProjectionEnvironmentRegistry, type ArgumentProjectionEnvironmentReply } from '../src/electron/rag/argumentProjectionEnvironment.ts';
import { createArgumentProjectionRuntime, type ArgumentProjectionRuntimeOptions } from '../src/electron/rag/argumentProjectionRuntime.ts';
import { readSavedArgumentReferenceNotes, readSavedArgumentDocumentChunk } from '../src/electron/rag/argumentSavedSourceReader.ts';
import { withRagSourceTransaction } from '../src/electron/ragSourceTransactions.ts';
import { saveVaultSnapshot } from '../src/electron/vaultSnapshot.ts';
import { setDataRoot, writeManifest, writeStructuredDocumentFile, writeChunksFile } from '../src/electron/ragIndex.ts';
import { buildTextStructuredDocument } from '../src/electron/rag/structuredDocument.ts';
import type { NoteItem, UploadedDocument } from '../src/types.ts';

// All files are disposable, synthetic fixtures. No configured vault, cloud, model or production data.
const fetchBefore = globalThis.fetch;
globalThis.fetch = async () => assert.fail('Network forbidden in learning-scope checks');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'loginote-argument-learning-scope-'));
const rootsFor = (dataRoot: string) => ({ dataRoot, vaultRoot: path.join(dataRoot, 'vault'), userStateDir: path.join(dataRoot, 'user-state') });
const rootA = rootsFor(path.join(temporary, 'A')), rootB = rootsFor(path.join(temporary, 'B'));
let checks = 0;
const pass = (label: string) => { checks += 1; console.log(`PASS ${label}`); };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const resource = (documentId: string) => ({ title: `合成资料 ${documentId}`, url: `document:${documentId}`, documentId });
function note(id: string, title: string, noteType: NoteItem['noteType'] = 'knowledge', extra: Partial<NoteItem> = {}): NoteItem {
  return { id, title, noteType, content: `# 定义\r\n\r\n${title}是纯合成概念，用于检查独立保存来源。🧠`,
    tags: [], links: [], backlinks: [], dueDates: [], createdAt: '2026-10-07T00:00:00.000Z',
    updatedAt: '2026-10-07T00:00:00.000Z', ...extra };
}
const notes: NoteItem[] = [
  note('project-P', '合成根项目', 'project', { links: ['Alpha Alias', 'Ambiguous'], resources: [resource('doc-P')] }),
  note('project-C', '合成子项目', 'project', { parentId: 'project-P', links: ['Nested'], resources: [resource('doc-C')] }),
  note('project-G', '合成孙项目', 'project', { parentId: 'project-C', links: ['Grand'] }),
  note('knowledge-A', 'Alpha', 'knowledge', { aliases: ['Alpha Alias'], resources: [resource('doc-A')] }),
  note('knowledge-N', 'Nested', 'knowledge', { resources: [resource('doc-not-indexable')] }),
  note('knowledge-G', 'Grand'),
  note('knowledge-L', 'Legacy', 'knowledge', { parentId: 'project-C' }),
  note('knowledge-X', 'Outside', 'knowledge', { resources: [resource('doc-outside')] }),
  note('knowledge-D1', 'Dup1', 'knowledge', { aliases: ['Ambiguous'] }),
  note('knowledge-D2', 'Dup2', 'knowledge', { aliases: ['Ambiguous'] }),
  note('knowledge-single', 'Single', 'knowledge', { links: ['Outside'], resources: [resource('doc-single')] }),
  note('project-other', '其他项目', 'project', { links: ['Outside'] }),
];
const documentIds = ['doc-P', 'doc-C', 'doc-A', 'doc-outside', 'doc-single'];
const original = '# 定义\n\n本文件是纯合成参考资料，不代表用户认知或客观真理。';
const metadata: UploadedDocument[] = [...documentIds, 'doc-not-indexable'].map(id => ({ id, fileName: `${id}.md`, fileType: 'md',
  extension: '.md', indexable: id !== 'doc-not-indexable', size: Buffer.byteLength(original), status: 'ready', chunkCount: 0,
  totalChars: original.length, parseStatus: id === 'doc-not-indexable' ? 'unsupported' : 'ready',
  uploadAt: '2026-10-07T00:00:00.000Z', parsedAt: '2026-10-07T00:01:00.000Z' }));
const projectSelection = { kind: 'learning-note' as const, noteId: 'project-P' };
const alphaRef = { kind: 'knowledge-note' as const, entityId: 'knowledge-A' };
const outsideRef = { kind: 'knowledge-note' as const, entityId: 'knowledge-X' };
function available(reply: ArgumentProjectionEnvironmentReply) {
  assert.equal(reply.status, 'available'); if (reply.status !== 'available') assert.fail('Synthetic environment unavailable'); return reply;
}
const sourceRequest = (environmentId: string, ref = alphaRef) => ({ op: 'source', environmentId, ref });

async function setup(roots: ReturnType<typeof rootsFor>) {
  await saveVaultSnapshot(roots.vaultRoot, roots.userStateDir, notes);
  setDataRoot(roots.dataRoot); await writeManifest(metadata);
  await fs.mkdir(path.join(roots.dataRoot, 'documents'), { recursive: true });
  for (const doc of metadata.filter(doc => doc.indexable)) {
    await fs.writeFile(path.join(roots.dataRoot, 'documents', `${doc.id}.md`), original, 'utf8');
    const document = { ...buildTextStructuredDocument(doc.id, original), sourceHash: createHash('sha256').update(original).digest('hex'), materialParserVersion: 1 };
    await writeStructuredDocumentFile(document); await writeChunksFile(doc.id, []);
  }
}

try {
  const pureScope = deriveArgumentLearningScope(notes, documentIds, 'synthetic-root', projectSelection);
  assert.deepEqual(pureScope.allowedNoteIds, ['knowledge-A', 'knowledge-G', 'knowledge-L', 'knowledge-N']);
  assert.deepEqual(pureScope.allowedDocIds, ['doc-A', 'doc-C', 'doc-P']);
  assert.ok(!pureScope.allowedNoteIds.includes('knowledge-X')); assert.ok(!pureScope.allowedNoteIds.includes('knowledge-D1'));
  assert.ok(!pureScope.allowedNoteIds.includes('knowledge-D2'));
  pass('项目后代/显式alias及旧parent知识点闭包，歧义alias不任选且不读取其他项目');

  const single = deriveArgumentLearningScope(notes, documentIds, 'synthetic-root', { kind: 'learning-note', noteId: 'knowledge-single' });
  assert.deepEqual(single.allowedNoteIds, ['knowledge-single']); assert.deepEqual(single.allowedDocIds, ['doc-single']);
  const cyclic = structuredClone(notes); cyclic.find(n => n.id === 'project-P')!.parentId = 'project-G';
  assert.deepEqual(deriveArgumentLearningScope(cyclic, documentIds, 'synthetic-root', projectSelection).allowedNoteIds, pureScope.allowedNoteIds);
  const library = deriveArgumentLearningScope(notes, documentIds, 'synthetic-root', { kind: 'library' });
  assert.equal(library.allowedNoteIds.length, notes.filter(n => n.noteType === 'knowledge').length);
  assert.deepEqual(library.allowedDocIds, [...documentIds].sort());
  pass('单knowledge不沿链接扩展，只有自己的resources；项目cycle终止；全库scope明确独立');

  for (const selection of [{ kind: 'learning-note', noteId: '../outside' }, { kind: 'learning-note', noteId: 'C:\\outside' },
    { kind: 'library', allowedNoteIds: ['knowledge-X'] }, { kind: 'library', rootScopeId: 'fake' }, { kind: 'learning-note', noteId: 'project-P', path: 'outside' }]) {
    assert.throws(() => parseArgumentEnvironmentSelection(selection), /invalid_selection/);
  }
  assert.throws(() => deriveArgumentLearningScope(notes, documentIds, 'synthetic-root', { kind: 'learning-note', noteId: 'missing' }), /selection_missing/);
  pass('selector只允许稳定ID，路径/自供allowlist/root/新增字段与不存在目标拒绝');

  await setup(rootA); await setup(rootB); setDataRoot(rootA.dataRoot);
  let activeRoots = rootA, suspended = false;
  const environments = createArgumentProjectionEnvironmentRegistry(() => activeRoots, () => !suspended);
  const env = available(await environments.getEnvironment(1, projectSelection));
  assert.equal(env.scope, 'learning_note'); assert.equal(env.noteCount, 4); assert.equal(env.documentCount, 3);
  const alpha = await environments.execute(1, sourceRequest(env.environmentId));
  assert.equal(alpha.status, 'physical_source'); if (alpha.status !== 'physical_source') assert.fail('Missing synthetic Alpha');
  assert.equal(alpha.input.source.entityId, 'knowledge-A'); assert.equal(alpha.input.sourceQualification.status, 'unassessed');
  assert.deepEqual(alpha.input.scope.allowedNoteIds, ['knowledge-A']);
  assert.deepEqual(alpha.input.scope.allowedDocIds, []);
  assert.ok(!JSON.stringify(alpha).includes(rootA.dataRoot));
  assert.equal((await environments.execute(1, sourceRequest(env.environmentId, outsideRef))).status, 'held');
  pass('真实saved目录发放learning-note scope，runtime独立核验单源且默认unassessed，不泄本机路径');

  for (const [docId, expected] of [['doc-P', 'physical_source'], ['doc-A', 'physical_source'], ['doc-C', 'physical_source'],
    ['doc-outside', 'held'], ['doc-not-indexable', 'held'], ['doc-single', 'held']] as const) {
    assert.equal((await environments.execute(1, { op: 'source', environmentId: env.environmentId,
      ref: { kind: 'uploaded-document', entityId: docId } })).status, expected);
  }
  const singleEnv = available(await environments.getEnvironment(2, { kind: 'learning-note', noteId: 'knowledge-single' }));
  assert.equal(singleEnv.noteCount, 1); assert.equal(singleEnv.documentCount, 1);
  assert.equal((await environments.execute(2, { op: 'source', environmentId: singleEnv.environmentId,
    ref: { kind: 'uploaded-document', entityId: 'doc-single' } })).status, 'physical_source');
  assert.equal((await environments.execute(2, sourceRequest(singleEnv.environmentId, outsideRef))).status, 'held');
  pass('上传资料只有saved resources∩indexable可读，单knowledge不借链接或其他资源扩权');

  assert.equal((await environments.execute(1, { ...sourceRequest(env.environmentId), scope: { allowedNoteIds: ['knowledge-X'] } })).status, 'held');
  assert.equal((await environments.execute(1, { ...sourceRequest(env.environmentId), path: rootA.vaultRoot })).status, 'held');
  assert.equal((await environments.execute(1, { op: 'source', environmentId: env.environmentId,
    ref: { kind: 'knowledge-note', entityId: '../outside' } })).status, 'held');
  assert.equal((await environments.execute(3, sourceRequest(env.environmentId))).status, 'held');
  pass('只读request闭schema和owner隔离，前端自授scope/路径/traversal不能扩权');

  const fullEnv = available(await environments.getEnvironment(4));
  assert.equal((await environments.execute(4, sourceRequest(fullEnv.environmentId, outsideRef))).status, 'physical_source');
  assert.equal((await environments.getEnvironment(4, { kind: 'library', allowedNoteIds: ['knowledge-X'] })).status, 'held');
  assert.equal((await environments.execute(4, sourceRequest(fullEnv.environmentId, outsideRef))).status, 'held');
  const beforeBadPath = available(await environments.getEnvironment(4));
  assert.equal((await environments.getEnvironment(4, { kind: 'learning-note', noteId: 'C:\\outside' })).status, 'held');
  assert.equal((await environments.execute(4, sourceRequest(beforeBadPath.environmentId, outsideRef))).status, 'held');
  pass('非法替换selector也先撤销旧全库lease，失败不能保留之前宽授权');

  const stateEnv = available(await environments.getEnvironment(5, projectSelection));
  const sourceBefore = await environments.execute(5, sourceRequest(stateEnv.environmentId));
  assert.equal(sourceBefore.status, 'physical_source'); if (sourceBefore.status !== 'physical_source') assert.fail('Missing source before state update');
  const stateOnly = notes.map(n => n.id === 'knowledge-A' ? { ...n, updatedAt: '2026-10-07T09:00:00.000Z', flowSummary: '合成个人状态变化',
    dsrState: { difficulty: 5, stability: 10, lastReviewedAt: '2026-10-07T09:00:00.000Z', reviewCount: 1,
      consecutiveCorrect: 1, consecutiveWrong: 0, conceptMastery: 90 } } : n);
  await saveVaultSnapshot(rootA.vaultRoot, rootA.userStateDir, stateOnly);
  const sourceAfter = await environments.execute(5, sourceRequest(stateEnv.environmentId));
  assert.equal(sourceAfter.status, 'physical_source'); if (sourceAfter.status !== 'physical_source') assert.fail('State-only update falsely invalidated source');
  assert.deepEqual(sourceAfter.input.source, sourceBefore.input.source);
  assert.deepEqual(sourceAfter.input.scope, sourceBefore.input.scope);
  const unrelated = note('knowledge-added-outside', 'Unlinked Added');
  await saveVaultSnapshot(rootA.vaultRoot, rootA.userStateDir, [...stateOnly, unrelated]);
  assert.equal((await environments.execute(5, sourceRequest(stateEnv.environmentId))).status, 'physical_source');
  pass('纯资格层中mastery/updatedAt和无关新增资料不改选中scope或参考sourceidentity；不覆盖main保守revoke策略');

  const documentRequest = { op: 'source', environmentId: stateEnv.environmentId, ref: { kind: 'uploaded-document', entityId: 'doc-P' } };
  const documentBefore = await environments.execute(5, documentRequest);
  assert.equal(documentBefore.status, 'physical_source'); if (documentBefore.status !== 'physical_source') assert.fail('Missing synthetic saved document');
  await writeManifest(metadata.map(doc => doc.id === 'doc-P' ? { ...doc, status: 'failed', chunkCount: 42,
    error: '合成向量化失败，但原始解析仍ready', knowledgeStatus: 'processing', knowledgeIndexedChunks: 1 } : doc));
  const documentAfter = await environments.execute(5, documentRequest);
  assert.equal(documentAfter.status, 'physical_source'); if (documentAfter.status !== 'physical_source') assert.fail('Vector-only state invalidated saved original');
  assert.deepEqual(documentAfter.input.source, documentBefore.input.source);
  assert.deepEqual(documentAfter.input.scope, documentBefore.input.scope);
  assert.equal(documentAfter.input.sourceQualification.status, 'unassessed');
  await writeManifest(metadata);
  pass('上传资料向量/知识索引状态变化不改saved原文身份或scope，parse-ready仍可读且不自动合格');

  const removedLink = notes.map(n => n.id === 'project-P' ? { ...n, links: ['Ambiguous'] } : n);
  await saveVaultSnapshot(rootA.vaultRoot, rootA.userStateDir, removedLink);
  assert.equal((await environments.execute(5, sourceRequest(stateEnv.environmentId))).status, 'held');
  await saveVaultSnapshot(rootA.vaultRoot, rootA.userStateDir, notes);
  assert.equal((await environments.execute(5, sourceRequest(stateEnv.environmentId))).status, 'held');
  const renewed = available(await environments.getEnvironment(5, projectSelection));
  assert.notEqual(renewed.environmentId, stateEnv.environmentId);
  assert.equal((await environments.execute(5, sourceRequest(renewed.environmentId))).status, 'physical_source');
  pass('saved成员变化由每次source锁内刷新识别，观测成员A→B→A旧lease永久held');

  const rootEnv = available(await environments.getEnvironment(6, projectSelection));
  activeRoots = rootB;
  assert.equal((await environments.execute(6, sourceRequest(rootEnv.environmentId))).status, 'held');
  activeRoots = rootA;
  assert.equal((await environments.execute(6, sourceRequest(rootEnv.environmentId))).status, 'held');
  const pausedEnv = available(await environments.getEnvironment(6, projectSelection));
  suspended = true; assert.equal((await environments.execute(6, sourceRequest(pausedEnv.environmentId))).status, 'held');
  suspended = false; assert.equal((await environments.execute(6, sourceRequest(pausedEnv.environmentId))).status, 'held');
  pass('观测root A→B→A及存储暂停后恢复都不复活旧token，不宣称识别未观测外部ABA');

  const concurrent = await Promise.all([environments.getEnvironment(7, projectSelection), environments.getEnvironment(7, { kind: 'learning-note', noteId: 'knowledge-single' })]);
  const newest = available(concurrent[1]);
  assert.equal((await environments.execute(7, { op: 'source', environmentId: newest.environmentId,
    ref: { kind: 'knowledge-note', entityId: 'knowledge-single' } })).status, 'physical_source');
  if (concurrent[0].status === 'available') assert.equal((await environments.execute(7, sourceRequest(concurrent[0].environmentId))).status, 'held');
  const enter = deferred(), release = deferred();
  const heldLock = withRagSourceTransaction(Object.values(rootA), async () => { enter.resolve(); await release.promise; });
  await enter.promise;
  const issuing = environments.getEnvironment(8, projectSelection); environments.revoke(8); release.resolve(); await heldLock;
  assert.equal((await issuing).status, 'held');
  pass('同owner并发issuance最新selector获lease，发放排队中被撤销不会安装旧权限');

  const helperEnv = available(await environments.getEnvironment(9, projectSelection));
  const helperResult = await environments.withEnvironment(9, helperEnv.environmentId, async (runtime, roots, libraryScope) => {
    return runtime.host.withSource(alphaRef, async input => {
      assert.ok(input);
      const catalog = await readSavedArgumentReferenceNotes({ ...roots, scope: libraryScope }, ['Alpha']);
      const absentChunk = await readSavedArgumentDocumentChunk(roots.dataRoot, 'doc-P', 'missing-synthetic-chunk');
      return { noteIds: catalog.map(n => n.id), absentChunk };
    });
  });
  assert.deepEqual(helperResult, { noteIds: ['knowledge-A'], absentChunk: null });
  await assert.rejects(environments.withEnvironment(9, helperEnv.environmentId, (runtime) => runtime.host.withSource(alphaRef,
    () => runtime.host.withSource(alphaRef, async () => null))), /nested_transaction/);
  assert.equal((await environments.execute(9, sourceRequest(helperEnv.environmentId))).status, 'physical_source');
  pass('host bridge不持锁等待callback，raw saved catalog/chunk可在source锁内读而不嵌套；违规嵌套失败后释放');

  const journal = path.join(rootA.userStateDir, 'vault-pending-snapshot.json');
  await fs.writeFile(journal, JSON.stringify({ version: 1, notes }), 'utf8');
  const pending = await environments.execute(9, sourceRequest(helperEnv.environmentId));
  assert.equal(pending.status, 'held'); if (pending.status === 'held') assert.equal(pending.reasonCode, 'environment_changed');
  assert.equal((await environments.getEnvironment(12, projectSelection)).status, 'held');
  await assert.rejects(environments.withEnvironment(9, helperEnv.environmentId, async (runtime, roots, scope) =>
    runtime.host.withSource(alphaRef, () => readSavedArgumentReferenceNotes({ ...roots, scope }, ['Alpha']))), /environment_changed/);
  const pendingRuntime = createArgumentProjectionRuntime({ ...rootA, environmentId: 'synthetic-journal',
    rootScopeId: pureScope.rootScopeId, scope: pureScope, isCurrent: () => true });
  const rawPending = await pendingRuntime.execute(sourceRequest('synthetic-journal'));
  assert.equal(rawPending.status, 'held'); if (rawPending.status === 'held') assert.equal(rawPending.reasonCode, 'source_pending');
  await assert.rejects(withRagSourceTransaction(Object.values(rootA), () =>
    readSavedArgumentReferenceNotes({ ...rootA, scope: pureScope }, ['Alpha'])), /save_in_progress/);
  assert.equal((JSON.parse(await fs.readFile(journal, 'utf8')) as { version: number }).version, 1);
  await fs.rm(journal);
  assert.equal((await environments.execute(9, sourceRequest(helperEnv.environmentId))).status, 'held');
  const recoveredEnv = available(await environments.getEnvironment(9, projectSelection));
  assert.equal((await environments.execute(9, sourceRequest(recoveredEnv.environmentId))).status, 'physical_source');
  pass('pending journal使环境/source/helper held且不擅自恢复半份快照；移除合成journal后须新lease');

  let authorityCalls = 0;
  const customOptions: ArgumentProjectionRuntimeOptions = { ...rootA, environmentId: 'synthetic-captured-authority',
    rootScopeId: pureScope.rootScopeId, scope: pureScope, isCurrent: () => true,
    assertScopeCurrent: async () => { authorityCalls += 1; throw new Error('argument_projection_runtime_environment_changed'); } };
  const custom = createArgumentProjectionRuntime(customOptions);
  customOptions.assertScopeCurrent = undefined; customOptions.scope.allowedNoteIds.push('knowledge-X');
  const protectedResponse = await custom.execute(sourceRequest('synthetic-captured-authority'));
  assert.equal(protectedResponse.status, 'held'); assert.equal(authorityCalls, 1);
  assert.equal((await custom.execute(sourceRequest('synthetic-captured-authority', outsideRef))).status, 'held');
  pass('runtime捕获host刷新回调和scope快照，构造参数后改不能跳过saved权限或增白名单');

  const metadataFile = path.join(rootA.vaultRoot, 'metadata.json'), bytes = await fs.readFile(metadataFile);
  const corruptionEnv = available(await environments.getEnvironment(10, projectSelection));
  await fs.writeFile(metadataFile, '{synthetic malformed catalog', 'utf8');
  assert.equal((await environments.execute(10, sourceRequest(corruptionEnv.environmentId))).status, 'held');
  assert.equal((await environments.getEnvironment(11, projectSelection)).status, 'held');
  await fs.writeFile(metadataFile, bytes);
  assert.equal((await environments.execute(10, sourceRequest(corruptionEnv.environmentId))).status, 'held');
  assert.equal((await environments.getEnvironment(11, projectSelection)).status, 'available');
  pass('坏saved目录不发放或回退旧权限，修复原字节须新lease，不静默当空库');

  console.log(`Argument learning scope: ${checks} synthetic check groups passed; 0 model/network/production writes.`);
} finally {
  globalThis.fetch = fetchBefore;
  const checked = path.resolve(temporary);
  assert.equal(path.dirname(checked), path.resolve(os.tmpdir()));
  assert.ok(path.basename(checked).startsWith('loginote-argument-learning-scope-'));
  await fs.rm(checked, { recursive: true, force: true });
}
