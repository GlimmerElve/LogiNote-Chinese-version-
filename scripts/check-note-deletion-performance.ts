import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import type { NoteItem } from '../src/types';
import { createNoteReferenceIndex } from '../src/electron/rag/noteReferenceIndex';
import { atomicWriteTextFile } from '../src/electron/atomicWrite';
import { cleanupDeletedNoteIndexes } from '../src/electron/deletedNoteIndexCleanup';
import { validateNoteIndexCleanupIds } from '../src/electron/noteIndexCleanupJournal';
import { isCurrentNoteReferenceHit } from '../src/electron/rag/noteReferenceAuthority';
import { finishDeletedNoteIndexCleanup } from '../src/services/ragService';
import { enqueueLearningWrite } from '../src/services/ui/learningWriteQueue';
import { acknowledgedSaveState } from '../src/services/ui/saveFeedback';
import { createOptimisticNoteDeletionState, stageOptimisticNoteDeletion, acknowledgeOptimisticNoteDeletion,
  rollbackOptimisticNoteDeletions } from '../src/services/ui/optimisticNoteDeletion';

// Offline: synthetic notes, temporary files, mock embeddings; no real vault/API.
let checks = 0;
const pass = (label: string) => console.log(`PASS ${++checks}: ${label}`);
const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
};
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const note = (id: string, extra: Partial<NoteItem> = {}): NoteItem => ({ id, title: id, noteType: 'knowledge',
  content: '删除排队测试的合成概念。', tags: [], links: [], backlinks: [], dueDates: [],
  createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z', ...extra });
const vector = () => [1, ...Array<number>(383).fill(0)];
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalIndexedDb = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
const setApi = (api: unknown) => Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: { noteRag: api } } });
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'loginote-delete-regression-'));
const source = await fs.readFile('src/App.tsx', 'utf8');
const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
const nodes: ts.Node[] = [];
const visit = (node: ts.Node) => { nodes.push(node); ts.forEachChild(node, visit); }; visit(ast);
function evaluate(name: string, env: Record<string, unknown>) {
  const declaration = nodes.find(node => ts.isVariableDeclaration(node) && node.name.getText(ast) === name) as ts.VariableDeclaration;
  assert.ok(declaration?.initializer);
  const js = ts.transpileModule(`return (${declaration.initializer.getText(ast)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(env), js)(...Object.values(env));
}
try {
  let writes = 0, fail = false;
  const store = createNoteReferenceIndex(path.join(temp, 'index'), async () => vector(), { write: async (file, text) => {
    if (fail) throw new Error('synthetic disk failure');
    writes++; await atomicWriteTextFile(file, text);
  } });
  const a = note('a'), b = note('b'), keep = note('keep');
  await store.indexAll([a, b, keep]);
  const before = writes;
  await store.removeMany(['a', 'a', 'b', 'absent-project']);
  assert.equal(writes - before, 1);
  assert.equal((await store.status('keep')).status, 'ready');
  const absentBefore = writes;
  await store.removeMany(Array.from({ length: 100 }, (_, i) => `absent-${i}`));
  assert.equal(writes, absentBefore);
  await assert.rejects(store.removeMany(['']), /ID/);
  assert.ok((await fs.readFile(path.join(temp, 'index', 'note-embeddings.json'), 'utf8')).includes('keep'));
  pass('重复ID去重；批量删除只写一次，100个不存在索引零写入，保留其它索引');

  const entered = deferred(), release = deferred();
  const blocked = createNoteReferenceIndex(path.join(temp, 'blocked'), async text => {
    if (text.includes('慢向量')) { entered.resolve(); await release.promise; }
    return vector();
  });
  await blocked.index(a);
  const oldHits = await blocked.search('合成概念', vector());
  assert.ok(oldHits.some(hit => hit.noteId === 'a'));
  const indexing = blocked.index(note('slow', { content: '慢向量用于模拟另一个笔记的模型任务。' }));
  await entered.promise;
  let cleanupFinished = false;
  const jobs: Promise<void>[] = [];
  setApi({ deleteMany: (ids: string[]) => {
    const job = blocked.removeMany(ids).then(() => { cleanupFinished = true; }); jobs.push(job); return job;
  } });
  await finishDeletedNoteIndexCleanup(['a']);
  assert.equal(cleanupFinished, false, '前台完成回执不得等待无关向量任务');
  assert.deepEqual(await blocked.search('合成概念', vector()), [], '排队即撤下旧索引命中');
  assert.equal(isCurrentNoteReferenceHit(oldHits[0], []), false, '即使尚未调度清理，保存快照也拒绝已删来源');
  release.resolve(); await indexing; await Promise.all(jobs);
  assert.equal((await blocked.status('a')).status, 'missing');
  pass('慢向量不阻塞前台删除；等待物理清理期间，索引和保存来源均拒绝已删命中');

  await store.index(a);
  fail = true;
  await assert.rejects(store.removeMany(['a']), /storage_unavailable/);
  assert.equal((await store.status('a')).status, 'failed');
  assert.ok(!(await store.search('合成概念', vector())).some(hit => hit.noteId === 'a'));
  fail = false; await store.removeMany(['a']);
  assert.equal((await store.status('a')).status, 'missing');
  await store.index(a);
  const staleRemoval = store.removeMany(['a']);
  const restoration = store.index({ ...a, content: '恢复后应该保留的新版概念。' });
  await Promise.all([staleRemoval, restoration]);
  assert.equal((await store.status('a')).status, 'ready');
  pass('清理写盘失败不返回旧命中，可重试；旧清理不能删除后来重新索引的版本');

  let current = true, referenceIds: string[] = [], derivativeIds: string[] = [];
  const deps = { isCurrent: () => current, readLiveIds: async () => ['restored'],
    removeReferences: async (ids: string[]) => { referenceIds = ids; },
    removeDerivatives: async (id: string) => { derivativeIds.push(id); } };
  await cleanupDeletedNoteIndexes(['deleted', 'restored', 'deleted'], deps);
  assert.deepEqual(referenceIds, ['deleted']); assert.deepEqual(derivativeIds, ['deleted']);
  current = false; referenceIds = []; derivativeIds = [];
  await assert.rejects(cleanupDeletedNoteIndexes(['deleted'], deps), /资料库已变化/);
  assert.deepEqual(referenceIds, []);
  current = true;
  await assert.rejects(cleanupDeletedNoteIndexes(['deleted'], { ...deps,
    removeReferences: async () => { current = false; } }), /资料库已变化/);
  assert.deepEqual(derivativeIds, []);
  await assert.rejects(cleanupDeletedNoteIndexes(['valid', 42], deps), /范围无效/);
  pass('主进程清理只处理已删除ID；恢复对象、切库、无效批次都不会清错对象');

  const collect = evaluate('collectDescendantIds', {});
  const deep = Array.from({ length: 20000 }, (_, i) => ({ id: `deep-${i}`, parentId: i ? `deep-${i - 1}` : 'root' }));
  assert.equal(collect('root', deep).length, 20000);
  assert.deepEqual(new Set(collect('root', [{ id: 'child', parentId: 'root' }, { id: 'root', parentId: 'child' }])), new Set(['child']));
  pass('两万层项目树迭代收集，无递归溢出；异常循环不重复删除');

  for (const outcome of ['success', 'failure', 'concurrent-edit']) {
    const original = [note('project', { noteType: 'project' }), note('child', { parentId: 'project' }), keep];
    const disk = deferred(); let saveCalls = 0, state = '', active: string | null = 'child', project: string | null = 'project';
    let cleanupCalls = 0;
    const heldCleanup = deferred();
    setApi({ deleteMany: (ids: string[]) => { cleanupCalls++; assert.deepEqual(new Set(ids), new Set(['project', 'child'])); return heldCleanup.promise; } });
    const env: Record<string, any> = { notesRef: { current: original }, pendingNotesRef: { current: null }, saveTimerRef: { current: null },
      readingOnlySaveRef: { current: null }, personalOnlySaveRef: { current: null }, noteSaveRevisionRef: { current: 0 },
      optimisticDeletionsRef: { current: createOptimisticNoteDeletionState() }, stageOptimisticNoteDeletion,
      acknowledgeOptimisticNoteDeletion, rollbackOptimisticNoteDeletions, acknowledgedSaveState,
      setPendingDeletionCount() {}, setRestoredDeletionCount() {}, reportLearningSaveError() {},
      setTimeout: (callback: () => void) => { queueMicrotask(callback); return 0; },
      learningWriteQueueRef: { current: Promise.resolve() }, collectDescendantIds: collect, enqueueLearningWrite, clearTimeout,
      finishDeletedNoteIndexCleanup, setNoteSaveState: (value: string) => { state = value; }, setNotes() {},
      setActiveNoteId: (mutate: (id: string | null) => string | null) => { active = mutate(active); },
      setActiveProjectContextId: (mutate: (id: string | null) => string | null) => { project = mutate(project); },
      saveAllNotesToStorage: async () => { saveCalls++; if (saveCalls === 1) { await disk.promise; if (outcome === 'failure') throw new Error('disk unavailable'); } },
    };
    env.stageNoteDeletion = evaluate('stageNoteDeletion', env);
    let finished = false;
    const deleting = evaluate('handleDeleteProject', env)('project');
    const result = deleting.then(() => { finished = true; return true; }, () => false);
    await tick(); assert.equal(finished, true); assert.equal(env.notesRef.current.length, 1); assert.equal(cleanupCalls, 0);
    if (outcome === 'concurrent-edit') {
      env.notesRef.current = [...env.notesRef.current, note('new-edit')];
      env.pendingNotesRef.current = env.notesRef.current; env.noteSaveRevisionRef.current++;
    }
    disk.resolve();
    assert.equal(await result, true, '弹窗只等待界面删除，不等待后台写盘结果');
    if (outcome !== 'failure') {
      await env.learningWriteQueueRef.current;
      assert.equal(cleanupCalls, 1); assert.equal(state, outcome === 'success' ? 'saved' : 'pending');
      assert.deepEqual(env.notesRef.current.map((n: NoteItem) => n.id), outcome === 'success' ? ['keep'] : ['keep', 'new-edit']);
      assert.equal(active, 'keep'); assert.equal(project, null);
    } else {
      await assert.rejects(env.learningWriteQueueRef.current, /disk unavailable/);
      assert.equal(cleanupCalls, 0); assert.equal(state, 'error');
      assert.equal(env.notesRef.current.length, 3); assert.equal(saveCalls, 1);
    }
    heldCleanup.resolve();
  }
  pass('真实项目入口立即移除并关闭；落盘后清索引，失败恢复，新编辑仍保留待保存');

  const main = await fs.readFile('src/electron/main.ts', 'utf8');
  const mainAst = ts.createSourceFile('main.ts', main, ts.ScriptTarget.ES2022, true);
  let deleteDeclaration: ts.VariableDeclaration | undefined;
  const findDelete = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(mainAst) === 'deleteSavedNoteIndexes') deleteDeclaration = node;
    ts.forEachChild(node, findDelete);
  }; findDelete(mainAst); assert.ok(deleteDeclaration?.initializer);
  let wakes = 0;
  const deleteEnv = { validateNoteIndexCleanupIds, resumeDeletedNoteIndexCleanup: async () => { wakes++; } };
  const deleteJs = ts.transpileModule(`return (${deleteDeclaration!.initializer!.getText(mainAst)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const deleteFromNative = new Function(...Object.keys(deleteEnv), deleteJs)(...Object.values(deleteEnv));
  const ids = ['deleted', 'keep'];
  await deleteFromNative(ids); ids.push('injected-after-enqueue');
  assert.equal(wakes, 1);
  assert.throws(() => deleteFromNative(['deleted', 42]), /范围无效/);
  assert.equal(wakes, 1);
  pass('真实删除IPC只唤醒已有持久化任务，不从请求参数创建删除权限');

  let idbCompleted = false, finishTransaction!: () => void;
  const removedInIdb: string[] = [];
  const fakeDb = { transaction: () => {
    const tx: any = { objectStore: () => ({ delete: (id: string) => removedInIdb.push(id) }) };
    finishTransaction = () => { idbCompleted = true; tx.oncomplete(); };
    return tx;
  } };
  const fakeIndexedDb = { open: () => {
    const request: any = {};
    queueMicrotask(() => { request.result = fakeDb; request.onsuccess(); });
    return request;
  } };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { indexedDB: fakeIndexedDb } });
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: fakeIndexedDb });
  let webFinished = false;
  const webCleanup = finishDeletedNoteIndexCleanup(['a', 'a', 'b']).then(() => { webFinished = true; });
  await tick(); assert.equal(webFinished, false); assert.equal(idbCompleted, false);
  assert.deepEqual(removedInIdb, ['a', 'b']);
  finishTransaction(); await webCleanup; assert.equal(webFinished, true);
  pass('浏览器旧检索路径保留等待，一个IDB事务完成前不冒充清理成功');

  let searchHandler: ts.Expression | undefined;
  const findSearch = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(mainAst) === 'ipcMain.handle'
      && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'user-state:search-cognition') searchHandler = node.arguments[1];
    ts.forEachChild(node, findSearch);
  }; findSearch(mainAst); assert.ok(searchHandler);
  let version = 0;
  const searchEnv = { referenceEnvironmentSuspended: false, referenceSourceWriteEpoch: 0,
    getUserStateDir: () => 'synthetic-root', getDataVersion: () => version,
    searchPersonalCognition: async () => ({ hits: [], warning: '' }),
    searchCognitionMaterials: async () => [{ noteId: 'deleted' }, { noteId: 'keep' }],
    loadMergedNotes: async () => [keep],
  };
  const searchJs = ts.transpileModule(`return (${searchHandler!.getText(mainAst)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const search = new Function(...Object.keys(searchEnv), searchJs)(...Object.values(searchEnv));
  assert.deepEqual((await search({}, '概念')).materials, [{ noteId: 'keep' }]);
  searchEnv.loadMergedNotes = async () => { version++; return [keep]; };
  const changedSearch = new Function(...Object.keys(searchEnv), searchJs)(...Object.values(searchEnv));
  assert.equal((await changedSearch({}, '概念')).materialsStatus, 'unavailable');
  pass('真实个人素材检索入口回核保存来源，删除缓存不泄漏，读取中变更则闭合拒绝');

  console.log(`Note deletion checks passed (${checks} groups; synthetic offline regression).`);
} finally {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window');
  if (originalIndexedDb) Object.defineProperty(globalThis, 'indexedDB', originalIndexedDb); else Reflect.deleteProperty(globalThis, 'indexedDB');
  assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep + 'loginote-delete-regression-'));
  await fs.rm(temp, { recursive: true, force: true });
}
