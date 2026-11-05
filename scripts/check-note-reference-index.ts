import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { NoteItem, NoteRagIndexInput, NoteReferenceIndexStatus } from '../src/types';
import { atomicWriteTextFile } from '../src/electron/atomicWrite';
import { createNoteReferenceIndex } from '../src/electron/rag/noteReferenceIndex';
import { saveVaultSnapshot } from '../src/electron/vaultSnapshot';
import { buildNoteReferenceChunks, noteReferenceSourceHash, noteReferenceSources } from '../src/electron/rag/noteReferenceChunks';
import { currentNoteReferenceInput, isCurrentNoteReferenceHit } from '../src/electron/rag/noteReferenceAuthority';
import { buildNoteRagIndexInput, normalizeNoteSearchResults } from '../src/services/ragService';
import { readNoteReferenceStatus, noteReferenceStatusLabel } from '../src/services/noteReferenceStatus';
import { splitSharableFields, splitUserStateFields } from '../src/services/userStateService';
import { deserializeVault } from '../src/services/vaultFsService';
import { buildReviewComparisonPacket, verifyReviewComparisonFreshness } from '../src/services/reviewComparison/packet';
import type { ReviewComparisonDependencies } from '../src/services/reviewComparison/types';
import { emptyCognitionFile } from '../src/services/cognition/core';
import { NoteReferenceIndexStatus as StatusLine } from '../src/components/NoteReferenceIndexStatus';

// Synthetic fixtures only. No model loading, downloads, vault access, API calls, cognition writes or scoring.
const originalFetch = globalThis.fetch, originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
globalThis.fetch = async () => { throw new Error('Network forbidden in note reference checks'); };
const temp = await mkdtemp(path.join(os.tmpdir(), 'loginote-note-reference-'));
let checks = 0, dirs = 0;
const pass = (label: string) => { checks++; console.log(`PASS ${label}`); };
const root = async () => { const value = path.join(temp, String(++dirs)); await mkdir(value); return value; };
const vector = () => [1, ...Array<number>(383).fill(0)];
const note = (id: string, content: string, extra: Partial<NoteItem> = {}): NoteItem => ({
  id, title: '合成学习概念', content, noteType: 'knowledge', createdAt: '2026-10-06T00:00:00.000Z',
  updatedAt: '2026-10-06T00:00:00.000Z', tags: [], links: [], backlinks: [], dueDates: [], ...extra,
});
const base = note('base', '# 定义\n\n主动回忆是主动从记忆中提取信息。\n\n# 条件\n\n在不先查看答案的条件下练习。\n\n# 例子\n\n合上笔记复述概念。[1]');
const changed = (value: NoteItem, content: string) => ({ ...value, content, updatedAt: '2026-10-06T01:00:00.000Z' });
const disk = async (dir: string) => JSON.parse(await readFile(path.join(dir, 'note-embeddings.json'), 'utf8'));
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve };
};
const setStatusApi = (raw: unknown) => Object.defineProperty(globalThis, 'window', {
  configurable: true, value: { electronAPI: { noteRag: { status: async () => raw } } },
});

try {
  const raw = '# 定义\r\n\r\n定义包含完整原文和🧠标记。\r\n\r\n# 条件\r\n\r\n条件第一行\r\n条件第二行。\r\n\r\n# 实验\r\n\r\n实验结果仅是参考，不是用户信念。[2]';
  const pieces = buildNoteReferenceChunks(note('offsets', raw));
  assert.equal(pieces.length, 3);
  assert.deepEqual(pieces.map((p) => p.sectionKind), ['definition', 'condition', 'fact']);
  pieces.forEach((piece, i) => {
    assert.equal(raw.slice(piece.textStart, piece.textEnd), piece.content);
    assert.ok(i === 0 || piece.textStart >= pieces[i - 1].textEnd);
  });
  assert.match(pieces[1].content, /\r\n/); assert.match(pieces[0].content, /🧠/);
  assert.deepEqual(pieces[2].citationIds, ['2']);
  pass('全文分块映射原始 CRLF / UTF-16 坐标；标题分类只是提示，引文不改写');

  const many = note('long', Array.from({ length: 60 }, (_, i) => `普通段落${i}：记录学习过程和复述条件。`).join('\n\n')
    + '\n\n尾部特殊证据：检索尾巴专用关键词位于很长笔记的末端。');
  const longPieces = buildNoteReferenceChunks(many);
  assert.ok(longPieces.length > 20); assert.ok(longPieces.at(-1)!.textStart > 800);
  assert.ok(longPieces.at(-1)!.content.includes('检索尾巴专用关键词'));
  assert.equal(buildNoteReferenceChunks({ ...base, noteType: 'project' }).length, 0);
  assert.equal(buildNoteReferenceChunks(note('blank', '请对该知识点进行定义描述')).length, 0);
  assert.equal(buildNoteReferenceChunks(note('html', '<div></div>')).length, 0);
  pass('全文尾部不截断，项目正文/占位符/纯渲染块不作为参考');

  const force = buildNoteReferenceChunks(note('forced', '边界文字🧠'.repeat(300)));
  assert.ok(force.length > 1); assert.ok(force.every((p) => p.forcedSplit));
  assert.equal(force.map((p) => p.content).join(''), '边界文字🧠'.repeat(300));
  force.forEach((p) => { assert.doesNotMatch(p.content, /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u); });
  assert.throws(() => buildNoteReferenceChunks(note('budget', '文'.repeat(500001))), /index_budget_exceeded/);
  pass('超长单句显式强制分块，保留完整正文；超预算明确拒绝');

  const oldPieces = buildNoteReferenceChunks(base), movedPieces = buildNoteReferenceChunks({ ...base, content: '新加前言。\n\n' + base.content });
  for (const old of oldPieces) assert.equal(movedPieces.find((p) => p.content === old.content)?.chunkId, old.chunkId);
  const duplicated = buildNoteReferenceChunks(note('dupe', '同一个重复段落。\n\n同一个重复段落。'));
  assert.notEqual(duplicated[0].chunkId, duplicated[1].chunkId);
  assert.equal(duplicated[0].embeddingKey, duplicated[1].embeddingKey);
  assert.equal(noteReferenceSourceHash(base), noteReferenceSourceHash({ ...base, updatedAt: 'other-date' }));
  assert.notEqual(noteReferenceSourceHash(base), noteReferenceSourceHash({ ...base, title: '改名' }));
  pass('块 ID 不随原文位置移动；重复块坐标独立、向量可复用；版本与全文指纹分开');

  const withSources = { ...base, referenceSources: [{ sourceId: '1', type: 'web' as const, title: '合成参考',
    url: 'https://example.invalid/reference', snippet: '这里只记录来源。' }] };
  const sources = noteReferenceSources(withSources);
  assert.equal(sources[0].sourceId, '1'); assert.equal(sources[0].url, withSources.referenceSources[0].url);
  assert.notEqual(noteReferenceSourceHash(base), noteReferenceSourceHash(withSources));
  assert.deepEqual(buildNoteRagIndexInput(withSources).referenceSources, withSources.referenceSources);
  assert.deepEqual(splitSharableFields(withSources).referenceSources, withSources.referenceSources);
  assert.equal('referenceSources' in splitUserStateFields(withSources), false);
  assert.equal(noteReferenceSources({ ...base, referenceSources: [{ title: 1 } as any] }).length, 0);
  pass('引用元数据进入可分享笔记和来源指纹，不成为个人立场或权威认证');

  const mainRoot = await root(); let embeds = 0;
  const store = createNoteReferenceIndex(mainRoot, async () => { embeds++; return vector(); });
  await store.index(withSources);
  const ready = await store.status(base.id);
  assert.equal(ready.status, 'ready'); assert.equal(ready.chunkCount, 3); assert.equal(embeds, 3);
  assert.deepEqual((await disk(mainRoot)).entries[0].referenceSources, JSON.parse(JSON.stringify(sources)));
  assert.equal((await createNoteReferenceIndex(mainRoot, async () => { throw new Error('No reload embed'); }).status(base.id)).status, 'ready');
  pass('本地 v2 索引与来源可持久化，重启读取不依赖模型重新加载');

  await store.index(withSources); assert.equal(embeds, 3);
  const dateOnly = { ...withSources, updatedAt: '2026-10-06T02:00:00.000Z' };
  await store.index(dateOnly); assert.equal(embeds, 3); assert.equal((await store.status(base.id)).sourceUpdatedAt, dateOnly.updatedAt);
  const editOne = { ...dateOnly, content: dateOnly.content.replace('合上笔记复述概念。', '合上笔记解释核心含义。') };
  await store.index(editOne); assert.equal(embeds, 4);
  await store.index({ ...editOne, content: '新加前言。\n\n' + editOne.content }); assert.equal(embeds, 5);
  await store.index({ ...editOne, referenceSources: [{ ...sources[0], title: '改正来源标题' }] }); assert.equal(embeds, 5);
  pass('相同正文/仅时间变化/仅来源变化零重复向量；只重算改动与新增块');

  await store.index(many);
  const tailHits = await store.search('检索尾巴专用关键词', []);
  assert.equal(tailHits[0].noteId, many.id); assert.ok(tailHits[0].passage!.textStart > 800);
  assert.match(tailHits[0].snippet, /检索尾巴专用关键词/);
  assert.equal(many.content.slice(tailHits[0].passage!.textStart, tailHits[0].passage!.textEnd).startsWith(tailHits[0].snippet), true);
  assert.equal((await store.search('学习', vector())).filter((hit) => hit.noteId === many.id).length, 1);
  assert.deepEqual(await store.search('学习', [], 0), []);
  for (const queryVector of [[], [1], Array<number>(384).fill(NaN), Array<number>(384).fill(0)]) {
    assert.match((await store.search('检索尾巴专用关键词', queryVector))[0].snippet, /检索尾巴专用关键词/);
  }
  pass('混合检索返回尾部原文和出处；按笔记去重；查询向量失败仍可词法检索');

  const failRoot = await root(); let fail = false;
  const failStore = createNoteReferenceIndex(failRoot, async () => { if (fail) throw new Error('Synthetic embed failure'); return vector(); });
  await failStore.index(base); fail = true;
  const failedVersion = changed(base, base.content + '\n\n新增一条证据。');
  await assert.rejects(failStore.index(failedVersion), /embedding_unavailable/);
  assert.equal((await failStore.status(base.id)).status, 'failed'); assert.deepEqual(await failStore.search('主动回忆', vector()), []);
  assert.equal((await disk(failRoot)).entries[0].chunks.length, oldPieces.length);
  const restartedFailed = createNoteReferenceIndex(failRoot, async () => vector());
  assert.deepEqual(await restartedFailed.search('主动回忆', vector()), []);
  await restartedFailed.index(failedVersion); assert.equal((await restartedFailed.status(base.id)).status, 'ready');
  assert.match((await restartedFailed.search('新增一条证据', []))[0].snippet, /新增一条证据/);
  pass('更新失败不返回旧版/半成品，保留可复用向量，重启后重试可恢复');

  for (const bad of [[1], Array<number>(384).fill(0), [Infinity, ...Array<number>(383).fill(0)]]) {
    const invalidStore = createNoteReferenceIndex(await root(), async () => bad);
    await assert.rejects(invalidStore.index(base), /embedding_unavailable/);
    assert.equal((await invalidStore.status(base.id)).status, 'failed');
    assert.deepEqual(await invalidStore.search('主动回忆', vector()), []);
  }
  pass('维度错误、非有限或零向量拒绝为就绪索引');

  const queueRoot = await root(), entered = deferred<void>(), release = deferred<number[]>(); let once = true;
  const queueStore = createNoteReferenceIndex(queueRoot, async () => { if (once) { once = false; entered.resolve(); return release.promise; } return vector(); });
  const oldWork = queueStore.index(note('race', '旧版观点。')); await entered.promise;
  assert.equal((await queueStore.status('race')).status, 'processing');
  const newer = note('race', '新版观点只在保存后成为参考。'), newWork = queueStore.index(newer);
  assert.equal((await queueStore.status('race')).status, 'queued');
  assert.deepEqual(await queueStore.search('旧版观点', vector()), []);
  release.resolve(vector()); await Promise.all([oldWork, newWork]);
  assert.equal((await queueStore.status('race')).sourceHash, noteReferenceSourceHash(newer));
  assert.equal((await disk(queueRoot)).entries[0].chunks[0].content, newer.content);
  pass('新版本排队立即隔离旧命中；慢旧请求不得覆盖新版本');

  const cloneRoot = await root(), cloneEnter = deferred<void>(), cloneRelease = deferred<number[]>(); let first = true;
  const cloneStore = createNoteReferenceIndex(cloneRoot, async () => { if (first) { first = false; cloneEnter.resolve(); return cloneRelease.promise; } return vector(); });
  const blocking = cloneStore.index(note('block', '阻塞合成任务。')); await cloneEnter.promise;
  const mutable = note('clone', '提交时的正文。'), cloneWork = cloneStore.index(mutable); mutable.content = '提交后的篡改。';
  cloneRelease.resolve(vector()); await Promise.all([blocking, cloneWork]);
  assert.equal((await disk(cloneRoot)).entries.find((e: any) => e.noteId === 'clone').chunks[0].content, '提交时的正文。');
  pass('提交时深拷贝输入，排队期间调用者修改不会污染固定版本');

  const delEnter = deferred<void>(), delRelease = deferred<number[]>(), delRoot = await root();
  const delStore = createNoteReferenceIndex(delRoot, async () => { delEnter.resolve(); return delRelease.promise; });
  const resurrection = delStore.index(note('deleted', '删除前正文。')); await delEnter.promise;
  const removal = delStore.remove('deleted'); delRelease.resolve(vector()); await Promise.all([resurrection, removal]);
  assert.equal((await delStore.status('deleted')).status, 'missing'); assert.deepEqual((await disk(delRoot)).entries, []);
  pass('索引过程中删除不会被旧向量任务复活');

  const allRoot = await root(), allStore = createNoteReferenceIndex(allRoot, async () => vector());
  await allStore.index(base); await allStore.index(note('discard', '应撤下的资料。'));
  await allStore.indexAll([{ ...base, noteType: 'project' }]); assert.equal(await allStore.count(), 0);
  assert.deepEqual(await allStore.search('主动回忆', vector()), []);
  await allStore.index(note('empty', '')); assert.equal((await allStore.status('empty')).status, 'empty');
  pass('全量同步撤下删除/改类型笔记；空正文不产生向量');

  const pruneRoot = await root(), pruneEnter = deferred<void>(), pruneRelease = deferred<number[]>(); let pruneFirst = true;
  const pruneStore = createNoteReferenceIndex(pruneRoot, async () => { if (pruneFirst) { pruneFirst = false; pruneEnter.resolve(); return pruneRelease.promise; } return vector(); });
  const batch = pruneStore.indexAll([note('batch', '旧快照包含的笔记。')]); await pruneEnter.promise;
  const newNote = note('created-later', '快照之后新创建的笔记。'), newNoteWork = pruneStore.index(newNote);
  pruneRelease.resolve(vector()); await Promise.all([batch, newNoteWork]);
  assert.equal((await pruneStore.status(newNote.id)).status, 'ready'); assert.equal(await pruneStore.count(), 2);
  pass('旧全量快照不会删除提交在它之后的新笔记');

  const partialStore = createNoteReferenceIndex(await root(), async (text) => { if (text.includes('失败任务')) throw new Error('mock failure'); return vector(); });
  await assert.rejects(partialStore.indexAll([note('bad', '失败任务。'), note('good', '独立成功任务。')]), /index_unavailable/);
  assert.equal((await partialStore.status('bad')).status, 'failed'); assert.equal((await partialStore.status('good')).status, 'ready');
  pass('单篇失败不阻断批次其他笔记成功，批次失败仍显式报告');

  const corruptRoot = await root(), corruptText = '{ broken derived cache';
  await writeFile(path.join(corruptRoot, 'note-embeddings.json'), corruptText);
  const corruptStore = createNoteReferenceIndex(corruptRoot, async () => vector());
  await assert.rejects(corruptStore.index(base), /storage_unavailable/);
  assert.equal(await readFile(path.join(corruptRoot, 'note-embeddings.json'), 'utf8'), corruptText);
  assert.equal((await corruptStore.status(base.id)).errorCode, 'storage_unavailable');
  pass('损坏缓存明确报错、不按空库覆盖；笔记原文不在衍生写入范围');

  const ioRoot = await root(); let diskFail = false;
  const ioStore = createNoteReferenceIndex(ioRoot, async () => vector(), { write: async (file, content) => {
    if (diskFail) throw new Error('mock disk failure'); return atomicWriteTextFile(file, content);
  } });
  await ioStore.index(base); const priorFile = await readFile(path.join(ioRoot, 'note-embeddings.json'), 'utf8'); diskFail = true;
  await assert.rejects(ioStore.index(failedVersion), /storage_unavailable/);
  assert.equal(await readFile(path.join(ioRoot, 'note-embeddings.json'), 'utf8'), priorFile);
  assert.deepEqual(await ioStore.search('主动回忆', vector()), []);
  assert.equal((await ioStore.status(base.id)).errorCode, 'storage_unavailable');
  pass('磁盘写入失败保留旧文件，但本进程不误报新版本就绪');

  const interruptedRoot = await root(); await createNoteReferenceIndex(interruptedRoot, async () => vector()).index(base);
  const interruptedData = await disk(interruptedRoot); interruptedData.entries[0].status = 'processing'; interruptedData.entries[0].chunkCount = 0;
  await writeFile(path.join(interruptedRoot, 'note-embeddings.json'), JSON.stringify(interruptedData));
  const restarted = createNoteReferenceIndex(interruptedRoot, async () => vector());
  assert.equal((await restarted.status(base.id)).errorCode, 'interrupted'); assert.deepEqual(await restarted.search('主动回忆', vector()), []);
  await restarted.index(base); assert.equal((await restarted.status(base.id)).status, 'ready');
  pass('启动时识别中断的半成品，不搜索，重建后恢复');

  const legacyRoot = await root(), legacyText = JSON.stringify([
    { noteId: 'unknown', title: '无类型旧行', embedding: [1] },
    { noteId: 'project', noteType: 'project', title: '个人资料', embedding: [1] },
    { noteId: base.id, noteType: 'knowledge', title: base.title, embedding: [1] },
  ]);
  await writeFile(path.join(legacyRoot, 'note-embeddings.json'), legacyText);
  const legacy = createNoteReferenceIndex(legacyRoot, async () => vector());
  assert.equal(await legacy.count(), 1); assert.equal((await legacy.status(base.id)).status, 'legacy');
  assert.deepEqual(await legacy.search('主动回忆', vector()), []);
  await legacy.index(base); assert.equal(await legacy.count(), 1);
  const backup = (await readdir(legacyRoot)).find((f) => f.startsWith('note-embeddings.legacy-'))!;
  assert.ok(backup); assert.equal(await readFile(path.join(legacyRoot, backup), 'utf8'), legacyText);
  assert.equal((await disk(legacyRoot)).schemaVersion, 2);
  pass('旧索引只接纳已知参考类型，全文重建前不可搜，迁移保留逐字备份');

  const isolatedA = createNoteReferenceIndex(await root(), async () => vector()), isolatedB = createNoteReferenceIndex(await root(), async () => vector());
  await isolatedA.index(base); assert.equal((await isolatedB.status(base.id)).status, 'missing');
  await isolatedB.index(note(base.id, '另一目录正文。'));
  assert.equal((await isolatedA.status(base.id)).sourceHash, noteReferenceSourceHash(base));
  assert.notEqual((await isolatedA.status(base.id)).sourceHash, (await isolatedB.status(base.id)).sourceHash);
  pass('每个数据根目录独立存储和排队，不共享同 ID 内容');

  const input = buildNoteRagIndexInput(base), draft = { ...input, content: '未保存草稿不应索引。' };
  assert.equal(currentNoteReferenceInput(draft, [base]).content, base.content);
  assert.equal(currentNoteReferenceInput(draft, []).noteType, undefined);
  assert.equal(currentNoteReferenceInput(draft, [{ ...base, noteType: 'project' }]).noteType, 'project');
  const authRoot = await root(), authStore = createNoteReferenceIndex(authRoot, async () => vector()); await authStore.index(base);
  const hit = (await authStore.search('主动回忆', []))[0]; assert.equal(isCurrentNoteReferenceHit(hit, [base]), true);
  for (const notes of [[], [{ ...base, noteType: 'project' as const }], [{ ...base, updatedAt: 'changed' }], [{ ...base, content: base.content + '新增' }]]) {
    assert.equal(isCurrentNoteReferenceHit(hit, notes), false);
  }
  assert.equal(isCurrentNoteReferenceHit({ ...hit, snippet: '伪造引文' }, [base]), false);
  assert.equal(isCurrentNoteReferenceHit({ ...hit, snippet: '' }, [base]), false);
  assert.equal(isCurrentNoteReferenceHit({ ...hit, passage: { ...hit.passage!, textStart: NaN } }, [base]), false);
  pass('保存原文优先于编辑草稿；搜索二次回核类型、日期、全文指纹和引文位置');

  assert.deepEqual(normalizeNoteSearchResults([hit])[0].passage, hit.passage);
  for (const passage of [{ ...hit.passage!, sourceHash: 'bad' }, { ...hit.passage!, textEnd: -1 }, { ...hit.passage!, sectionKind: 'authoritative' }]) {
    assert.deepEqual(normalizeNoteSearchResults([{ ...hit, passage }]), []);
  }
  assert.deepEqual(normalizeNoteSearchResults([{ ...hit, noteType: 'project' }]), []);
  assert.equal(normalizeNoteSearchResults([{ ...hit, passage: undefined }]).length, 1, 'Historical browser fallback still has no v2 positions');
  pass('前端保留有效出处，畸形出处和个人素材闭合拒绝，旧浏览器接口兼容');

  const rawStatus: NoteReferenceIndexStatus = { ...await authStore.status(base.id) }; setStatusApi(rawStatus);
  assert.equal((await readNoteReferenceStatus(base)).status, 'ready');
  assert.equal((await readNoteReferenceStatus({ ...base, content: base.content + '未保存改动' })).status, 'queued');
  assert.equal((await readNoteReferenceStatus({ ...base, updatedAt: 'changed' })).status, 'queued');
  setStatusApi({ ...rawStatus, sourceHash: 'invalid' }); assert.equal((await readNoteReferenceStatus(base)).status, 'failed');
  setStatusApi({ ...rawStatus, noteId: 'wrong' }); assert.equal((await readNoteReferenceStatus(base)).status, 'failed');
  setStatusApi({ ...rawStatus, status: 'failed', errorCode: 'untrusted-text' }); assert.equal((await readNoteReferenceStatus(base)).errorCode, undefined);
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  assert.equal((await readNoteReferenceStatus(base)).status, 'unavailable');
  pass('编辑器状态核对正文哈希和日期，不显示旧版就绪；浏览器明确提示桌面能力');

  const pipelineRoot = await root(), vault = path.join(pipelineRoot, 'vault'), userState = path.join(pipelineRoot, 'user-state');
  const saved = { ...withSources, id: 'saved-pipeline', title: '尾部参考', content: '普通前言。'.repeat(600) + '\n\n检索尾巴专用关键词解释实际条件。[1]' };
  const originalScore = { stability: 1, difficulty: 2, retrievability: 0.5 };
  await saveVaultSnapshot(vault, userState, [{ ...saved, dsrState: originalScore as any }]);
  const originalMd = await readFile(path.join(vault, 'notes', saved.id + '.md'), 'utf8');
  const readSaved = async () => deserializeVault(await readFile(path.join(vault, 'metadata.json'), 'utf8'),
    new Map([[saved.id + '.md', await readFile(path.join(vault, 'notes', saved.id + '.md'), 'utf8')]]));
  const savedNotes = await readSaved(); assert.deepEqual(savedNotes[0].referenceSources, saved.referenceSources);
  const savedIndex = createNoteReferenceIndex(pipelineRoot, async () => vector());
  await savedIndex.indexAll(savedNotes);
  const savedHits = normalizeNoteSearchResults(await savedIndex.search('检索尾巴专用关键词', []));
  assert.equal(isCurrentNoteReferenceHit(savedHits[0], savedNotes), true);
  assert.ok(savedHits[0].passage!.textStart > 2400);
  const privateStateBefore = await readFile(path.join(userState, 'user-state.json'), 'utf8');
  const deps: ReviewComparisonDependencies = { readNotes: readSaved, loadCognition: async () => emptyCognitionFile(),
    searchNotes: async () => savedHits, searchDocuments: async () => [], previewDocument: async () => { throw new Error('Not used'); } };
  const packet = await buildReviewComparisonPacket({ activityId: 'synthetic-review', questionText: '解释检索尾巴专用关键词的条件。',
    evidence: { messageId: 'answer', answer: '检索尾巴专用关键词解释实际条件。', hintLevel: 0, targetKnowledgeNames: ['未直接匹配标题'],
      questionIntent: { version: 1, questionMessageId: 'question', knowledgeTargets: ['未直接匹配标题'] } } }, deps, { targetScopeNoteIds: [] });
  assert.equal(packet.references.length, 1); assert.equal(packet.references[0].kind, 'related-note');
  assert.match(packet.references[0].text, /检索尾巴专用关键词/); assert.ok(packet.references[0].textStart > 0);
  assert.equal(packet.coverage.semanticCoverage, 'not_assessed'); assert.equal(packet.preparation.mastery, 'pending_alignment');
  assert.equal((await verifyReviewComparisonFreshness(packet, deps)).fresh, true);
  assert.equal(await readFile(path.join(vault, 'notes', saved.id + '.md'), 'utf8'), originalMd);
  assert.equal(await readFile(path.join(userState, 'user-state.json'), 'utf8'), privateStateBefore);
  assert.equal((await readdir(userState)).some((name) => /cognition|mastery/u.test(name)), false);
  pass('合成落盘链路：保存→来源回读→全文向量索引→尾部检索→复习参考准备，原文/分数/认知不写回');

  const markup = renderToStaticMarkup(React.createElement(StatusLine, { note: base, saveState: 'pending' }));
  assert.match(markup, /参考索引等待正文保存/); assert.match(markup, /role="status"/); assert.match(markup, /aria-live="polite"/);
  assert.match(markup, /motion-reduce:animate-none/); assert.match(markup, /不表示你已掌握/);
  assert.equal(renderToStaticMarkup(React.createElement(StatusLine, { note: { ...base, noteType: 'project' } })), '');
  assert.match(noteReferenceStatusLabel({ noteId: base.id, status: 'failed', chunkCount: 0 }), /正文不受影响/);
  pass('状态行可访问、减少动画，不给项目显示参考认证、不将索引等同于掌握');

  const main = await readFile(new URL('../src/electron/main.ts', import.meta.url), 'utf8');
  const saveHandler = main.slice(main.indexOf("ipcMain.handle('vault:save'"), main.indexOf("ipcMain.handle('vault:get-root'"));
  assert.ok(saveHandler.includes('await saveVaultSnapshot') && saveHandler.includes('deferredNoteIndex.request()'));
  assert.ok(saveHandler.indexOf('await saveVaultSnapshot') < saveHandler.indexOf('deferredNoteIndex.request()'));
  assert.ok(!saveHandler.includes('void noteRagIndexNotes(noteList)'), 'autosave requests maintenance, not an index build');
  assert.match(saveHandler, /root === getVaultRoot\(\)/);
  const singleIndex = main.slice(main.indexOf("ipcMain.handle('noteRag:index'"), main.indexOf("ipcMain.handle('noteRag:index-all'"));
  assert.match(singleIndex, /readSavedVaultNotesByIds/);
  assert.match(singleIndex, /currentNoteReferenceInput\(input, notes\)/);
  assert.match(singleIndex, /changedNoteIndex\.requestIds\(\[input\.id\]\)/);
  assert.match(main, /hits\.filter\(\(hit\) => isCurrentNoteReferenceHit\(hit, notes\)\)/);
  assert.match(main, /version !== getDataVersion\(\)/);
  const searchHandler = main.slice(main.indexOf("ipcMain.handle('noteRag:search'"), main.indexOf("ipcMain.handle('noteRag:search'") + 4000);
  assert.match(searchHandler, /readSavedVaultNotesByIds\(root, states, \[\.\.\.new Set\(hits\.map\(hit => hit\.noteId\)\)\]/);
  assert.ok(!searchHandler.includes('loadMergedNotes()'), 'ranked results validate only their saved originals');
  const modal = await readFile(new URL('../src/components/ConceptFillModal.tsx', import.meta.url), 'utf8');
  assert.ok(/onConfirm\(draft\.content, draft\.references\)/.test(modal), 'Confirmed concept keeps the draft reference metadata');
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /prepareConceptNoteWrite\(current, expected, content, references\)/);
  assert.match(await readFile(new URL('../src/services/ui/conceptNoteWrite.ts', import.meta.url), 'utf8'), /referenceSources: references/);
  assert.match(app, /if \(!personalOnly\) indexNote\(/);
  const ui = await readFile(new URL('../src/components/NoteReferenceIndexStatus.tsx', import.meta.url), 'utf8');
  assert.match(ui, /<button type="button"/); assert.match(ui, /focus-visible:/); assert.match(ui, /重试索引/);
  assert.match(ui, /note\.referenceSources, saveState, retry/);
  pass('源码接线核对：保存成功后异步索引、搜索回核、引用保留和原个人图同步不移除');

  if (process.argv.includes('--local-model')) {
    const { setModelsDir, generateEmbedding } = await import('../src/electron/rag/embedding');
    setModelsDir(fileURLToPath(new URL('../models/', import.meta.url)));
    const modelRoot = await root(); let localCalls = 0;
    const localIndex = createNoteReferenceIndex(modelRoot, async (text) => { localCalls++; return generateEmbedding(text); });
    const tail = '分布式系统采用幂等请求标识，重复提交不会产生重复写入。';
    const localNote = note('local-model-smoke', Array<string>(50).fill('这是无关的前言段落，记录日常安排。').join('\n\n') + '\n\n' + tail,
      { title: '合成参考样本' });
    await localIndex.index(localNote);
    assert.equal((await localIndex.status(localNote.id)).status, 'ready'); assert.equal(localCalls, 2);
    const query = await generateEmbedding('幂等请求标识如何避免重复写入');
    assert.equal(query.length, 384); assert.ok(query.every(Number.isFinite));
    const hits = await localIndex.search('幂等请求标识如何避免重复写入', query);
    assert.equal(hits[0].snippet, tail); assert.ok(hits[0].passage!.textStart > 800);
    assert.equal(isCurrentNoteReferenceHit(hits[0], [localNote]), true);
    await localIndex.index(localNote); assert.equal(localCalls, 2);
    pass('实际离线中文模型：384维、重复块仅生成一次向量、长文尾部混合检索；单例不代表通用召回率');
  }

  console.log(`\n${checks} note reference index checks passed (synthetic, offline; ${process.argv.includes('--local-model') ? 'one real local-model smoke group, other groups use mock embeddings' : 'mock embeddings'}; no general semantic-quality claim).`);
} finally {
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window');
  const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(temp));
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(temp).startsWith('loginote-note-reference-'));
  await rm(temp, { recursive: true, force: true });
}
