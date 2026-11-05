import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import type { NoteItem } from '../src/types';
import { saveVaultSnapshot, recoverVaultSnapshot, recoverVaultSnapshotInTransaction } from '../src/electron/vaultSnapshot';
import { atomicWriteTextFile } from '../src/electron/atomicWrite';
import { withRagSourceTransaction } from '../src/electron/ragSourceTransactions';
import { cleanupDeletedNoteIndexes } from '../src/electron/deletedNoteIndexCleanup';
import { NOTE_INDEX_CLEANUP_FILE, acknowledgeNoteIndexCleanup, createNoteIndexCleanupWorker,
  readPendingNoteIndexCleanup, copyNoteIndexCleanupForMigration } from '../src/electron/noteIndexCleanupJournal';
import { readSavedVaultNoteIds } from '../src/electron/vaultNoteDelta';
import { CommunityImportFence } from '../src/services/community/importSnapshot';

// Synthetic temporary libraries only. No real vault, process killing or model/API.
let checks = 0, sequence = 0;
const pass = (label: string) => console.log(`PASS ${++checks}: ${label}`);
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve };
};
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'loginote-cleanup-recovery-'));
const note = (id: string): NoteItem => ({ id, title: id, noteType: 'knowledge', content: `合成原文：${id}`,
  tags: [], links: [], backlinks: [], dueDates: [], createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z' });
const a = note('a'), b = note('b'), keep = note('keep');
async function fixture(notes = [a, b, keep]) {
  const dir = path.join(temp, String(++sequence)), root = path.join(dir, 'vault'), states = path.join(dir, 'user-state');
  const save = (next: NoteItem[]) => saveVaultSnapshot(root, states, next);
  await save(notes);
  return { dir, root, states, save, pending: () => readPendingNoteIndexCleanup(root, states, () => true),
    live: async () => Object.keys(JSON.parse(await fs.readFile(path.join(root, 'metadata.json'), 'utf8')).notesMeta),
    acknowledge: (jobs: Parameters<typeof acknowledgeNoteIndexCleanup>[2]) => acknowledgeNoteIndexCleanup(root, states, jobs, () => true),
  };
}
try {
  const base = await fixture();
  const written: string[] = [];
  await saveVaultSnapshot(base.root, base.states, [keep], async (file, text) => {
    written.push(path.basename(file)); return atomicWriteTextFile(file, text);
  });
  assert.deepEqual(new Set((await base.pending()).map(job => job.noteId)), new Set(['a', 'b']));
  assert.ok(written.indexOf(NOTE_INDEX_CLEANUP_FILE) < written.indexOf('metadata.json'));
  assert.equal(await fs.readFile(path.join(base.root, 'notes', 'a.md'), 'utf8'), a.content);
  assert.deepEqual(await base.live(), ['keep']);
  pass('删除快照先持久化待清理任务，再提交目录；原始md保持原有可恢复策略');

  for (const phase of ['snapshot-journal', 'cleanup-file', 'metadata', 'after-metadata']) {
    const f = await fixture([a, keep]);
    await assert.rejects(saveVaultSnapshot(f.root, f.states, [keep], async (file, text) => {
      const name = path.basename(file);
      if (phase === 'snapshot-journal' && name === 'vault-pending-snapshot.json') throw new Error('synthetic interruption');
      if (phase === 'cleanup-file' && name === NOTE_INDEX_CLEANUP_FILE) throw new Error('synthetic interruption');
      if (phase === 'metadata' && name === 'metadata.json') throw new Error('synthetic interruption');
      await atomicWriteTextFile(file, text);
      if (phase === 'after-metadata' && name === 'metadata.json') throw new Error('synthetic interruption');
    }), /synthetic interruption/);
    await recoverVaultSnapshot(f.root, f.states); // Simulates a fresh process recovering saved bytes.
    assert.deepEqual(await f.live(), phase === 'snapshot-journal' ? ['a', 'keep'] : ['keep']);
    assert.deepEqual((await f.pending()).map(job => job.noteId), phase === 'snapshot-journal' ? [] : ['a']);
    assert.equal(await fs.readFile(path.join(f.root, 'notes', 'a.md'), 'utf8'), a.content);
  }
  pass('在事务日志、任务文件、目录提交前后四个中断点恢复，不出现已删但漏记任务的窗口');

  const partial = await fixture(); await partial.save([keep]);
  const physicalCache = new Set(['a', 'b']);
  const dependencies = { isCurrent: () => true, read: partial.pending, acknowledge: partial.acknowledge,
    clean: async (ids: string[]) => { physicalCache.delete(ids[0]); throw new Error('synthetic cleanup failure'); } };
  await assert.rejects(createNoteIndexCleanupWorker(dependencies).wake(), /cleanup failure/);
  assert.equal((await partial.pending()).length, 2);
  await createNoteIndexCleanupWorker({ ...dependencies, clean: async ids => { ids.forEach(id => physicalCache.delete(id)); } }).wake();
  assert.equal(physicalCache.size, 0); assert.deepEqual(await partial.pending(), []);
  pass('部分清理失败不核销，重启重试幂等；全部成功后才移除清单');

  const interrupted = await fixture([a, keep]); await interrupted.save([keep]);
  const entered = deferred(), release = deferred(); let finished = false;
  const slowWorker = createNoteIndexCleanupWorker({ isCurrent: () => true, read: interrupted.pending,
    acknowledge: interrupted.acknowledge, clean: async () => { entered.resolve(); await release.promise; } });
  const slow = slowWorker.wake().then(() => { finished = true; }); await entered.promise;
  slowWorker.stop(); assert.equal(finished, false);
  assert.equal((await interrupted.pending()).length, 1);
  release.resolve(); await slow; assert.equal((await interrupted.pending()).length, 1);
  await createNoteIndexCleanupWorker({ isCurrent: () => true, read: interrupted.pending,
    acknowledge: interrupted.acknowledge, clean: async () => {} }).wake();
  assert.deepEqual(await interrupted.pending(), []);
  pass('退出停止不等慢模型；迟到完成不核销，下一次启动继续处理持久化任务');

  const restored = await fixture([a, keep]); await restored.save([keep]); const receipt = await restored.pending();
  await restored.save([a, keep]);
  const cleaned: string[] = [];
  await createNoteIndexCleanupWorker({ isCurrent: () => true, read: restored.pending, acknowledge: restored.acknowledge,
    clean: ids => cleanupDeletedNoteIndexes(ids, { isCurrent: () => true, readLiveIds: restored.live,
      removeReferences: async ids => { cleaned.push(...ids); }, removeDerivatives: async () => {} }) }).wake();
  assert.deepEqual(cleaned, []); assert.deepEqual(await restored.pending(), []);
  await restored.save([keep]);
  const newer = await restored.pending(); assert.notEqual(newer[0].token, receipt[0].token);
  await restored.acknowledge(receipt); assert.deepEqual(await restored.pending(), newer);
  pass('撤销/恢复的笔记跳过清理；同ID再次删除使用新凭据，旧回执不能核销新任务');

  const concurrent = await fixture(); await concurrent.save([b, keep]);
  const batchEntered = deferred(), batchRelease = deferred(); const batches: string[][] = [];
  const worker = createNoteIndexCleanupWorker({ isCurrent: () => true, read: concurrent.pending, acknowledge: concurrent.acknowledge,
    clean: async ids => { batches.push(ids); if (batches.length === 1) { batchEntered.resolve(); await batchRelease.promise; } } });
  const working = worker.wake(); await batchEntered.promise;
  await concurrent.save([keep]); worker.wake(); batchRelease.resolve(); await working;
  assert.deepEqual(batches, [['a'], ['b']]); assert.deepEqual(await concurrent.pending(), []);
  pass('清理期间追加删除不会被旧整表回执抹掉，同一后台工作器继续下一批');

  const invalidated = await fixture(); await invalidated.save([b, keep]);
  const errorEntered = deferred(), errorRelease = deferred(); let attempts = 0;
  const retryWorker = createNoteIndexCleanupWorker({ isCurrent: () => true, read: invalidated.pending, acknowledge: invalidated.acknowledge,
    clean: async () => { if (++attempts === 1) { errorEntered.resolve(); await errorRelease.promise; throw new Error('source version changed'); } } });
  const retrying = retryWorker.wake(); await errorEntered.promise;
  await invalidated.save([keep]); const additionalWake = retryWorker.wake(); errorRelease.resolve();
  await Promise.all([retrying, additionalWake]);
  assert.equal(attempts, 2); assert.deepEqual(await invalidated.pending(), []);
  pass('新保存使在途批次失效时，其同时发出的唤醒不会丢失；无新请求时不循环重试');

  const stale = await fixture([a, keep]); await stale.save([keep]); const oldJobs = await stale.pending();
  const lockEntered = deferred(), lockRelease = deferred(); let current = true;
  const lock = withRagSourceTransaction([stale.root, stale.states], async () => { lockEntered.resolve(); await lockRelease.promise; });
  await lockEntered.promise;
  const oldAck = acknowledgeNoteIndexCleanup(stale.root, stale.states, oldJobs, () => current);
  current = false; lockRelease.resolve(); await lock;
  await assert.rejects(oldAck, /资料库已变化/); assert.deepEqual(await stale.pending(), oldJobs);
  pass('排队期间重置/切库使旧回执失效，不重建或覆盖新库清单');

  const rename = fs.rename, copy = fs.copyFile; let fallbackCopies = 0;
  try {
    fs.rename = (async (from, to) => {
      if (String(to) === path.join(stale.states, NOTE_INDEX_CLEANUP_FILE)) throw Object.assign(new Error('synthetic file lock'), { code: 'EBUSY' });
      return rename(from, to);
    }) as typeof fs.rename;
    fs.copyFile = (async (...args: Parameters<typeof fs.copyFile>) => { fallbackCopies++; return copy(...args); }) as typeof fs.copyFile;
    await assert.rejects(stale.acknowledge(oldJobs), /file lock/);
    assert.deepEqual(await stale.pending(), oldJobs); assert.equal(fallbackCopies, 0);
  } finally { fs.rename = rename; fs.copyFile = copy; }
  pass('核销遇文件锁时保留完整旧清单，不回退成可能被中断的覆盖复制');

  const corrupt = await fixture([a, keep]);
  const bad = '{broken pending list';
  await fs.writeFile(path.join(corrupt.states, NOTE_INDEX_CLEANUP_FILE), bad);
  await assert.rejects(corrupt.pending());
  await assert.rejects(corrupt.save([keep]));
  assert.deepEqual(await corrupt.live(), ['a', 'keep']);
  assert.equal(await fs.readFile(path.join(corrupt.states, NOTE_INDEX_CLEANUP_FILE), 'utf8'), bad);
  const foreign = await fixture([keep]);
  await fs.copyFile(path.join(stale.states, NOTE_INDEX_CLEANUP_FILE), path.join(foreign.states, NOTE_INDEX_CLEANUP_FILE));
  await assert.rejects(foreign.pending(), /不属于当前资料库/);
  pass('损坏/外库清单闭合拒绝，登记失败不提交删除，也不覆盖坏文件冒充空清单');

  const tampered = await fixture([a, keep]);
  await assert.rejects(saveVaultSnapshot(tampered.root, tampered.states, [keep], async (file, text) => {
    if (path.basename(file) === NOTE_INDEX_CLEANUP_FILE) throw new Error('interrupted before cleanup write');
    return atomicWriteTextFile(file, text);
  }), /interrupted/);
  const snapshotPath = path.join(tampered.states, 'vault-pending-snapshot.json');
  const originalJournal = await fs.readFile(snapshotPath, 'utf8'), poisoned = JSON.parse(originalJournal);
  const cleanupEntry = poisoned.files.find((file: { target: string }) => file.target === 'index-cleanup');
  const foreignList = JSON.parse(cleanupEntry.text); foreignList.vaultRoot = foreign.root;
  cleanupEntry.text = JSON.stringify(foreignList);
  poisoned.files.unshift({ target: 'body', noteId: 'keep', text: 'MUST NOT BE WRITTEN' });
  await fs.writeFile(snapshotPath, JSON.stringify(poisoned));
  await assert.rejects(recoverVaultSnapshot(tampered.root, tampered.states), /不属于当前资料库/);
  assert.equal(await fs.readFile(path.join(tampered.root, 'notes', 'keep.md'), 'utf8'), keep.content);
  assert.deepEqual(await tampered.live(), ['a', 'keep']);
  await fs.writeFile(snapshotPath, originalJournal); await recoverVaultSnapshot(tampered.root, tampered.states);
  assert.deepEqual((await tampered.pending()).map(job => job.noteId), ['a']);
  pass('恢复日志中的清理目标也做完整作用域校验，畸形清单不会导致前面的正文先被写入');

  const migrating = await fixture([a, keep]);
  await assert.rejects(saveVaultSnapshot(migrating.root, migrating.states, [keep], async (file, text) => {
    if (path.basename(file) === 'metadata.json') throw new Error('interrupted migration fixture');
    return atomicWriteTextFile(file, text);
  }), /interrupted/);
  const target = await fixture([keep]);
  await withRagSourceTransaction([migrating.root, migrating.states, target.root, target.states], async () => {
    await recoverVaultSnapshotInTransaction(migrating.root, migrating.states);
    await copyNoteIndexCleanupForMigration(migrating.root, migrating.states, target.root, target.states);
  });
  assert.deepEqual(await migrating.live(), ['keep']);
  assert.deepEqual(await target.pending(), await migrating.pending());
  await target.acknowledge(await target.pending());
  assert.equal((await migrating.pending()).length, 1);
  pass('显式整库迁移可转移并重新绑定待清理清单；新旧库回执相互隔离');

  const main = await fs.readFile('src/electron/main.ts', 'utf8');
  const ast = ts.createSourceFile('main.ts', main, ts.ScriptTarget.ES2022, true);
  let resume: ts.FunctionDeclaration | undefined;
  const handlers = new Map<string, ts.Expression>();
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'resumeDeletedNoteIndexCleanup') resume = node;
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'ipcMain.handle' && ts.isStringLiteral(node.arguments[0])) handlers.set(node.arguments[0].text, node.arguments[1]);
    ts.forEachChild(node, visit);
  }; visit(ast); assert.ok(resume);
  const native = await fixture([a, keep]); await native.save([keep]);
  let active = native, nativeCleaned: string[] = [], textbookCleaned: string[] = [], flowCleaned: string[] = [], forgotten: string[] = [];
  let switchDuringTextbook: Awaited<ReturnType<typeof fixture>> | undefined;
  const nativeGate = deferred();
  const env = { getVaultRoot: () => active.root, getUserStateDir: () => active.states, getDataVersion: () => 0,
    createNoteIndexCleanupWorker, readPendingNoteIndexCleanup, acknowledgeNoteIndexCleanup, cleanupDeletedNoteIndexes,
    serializeNoteSourceIndex: async (action: () => Promise<void>) => { await nativeGate.promise; return action(); },
    readSavedVaultNoteIds,
    loadMergedNotes: async () => { throw new Error('删除清理不应读取全部正文'); },
    noteRagDeleteIndexes: async (ids: string[]) => { nativeCleaned.push(...ids); },
    deleteUserArgumentNote: async () => {}, deleteCognitionMaterialNote: async () => {},
    deleteTextbookReferenceNote: async (id: string) => { textbookCleaned.push(id); if (switchDuringTextbook) active = switchDuringTextbook; },
    deleteSavedFlowReviewNote: async (id: string) => { flowCleaned.push(id); }, changedNoteIndex: { forget: (ids: string[]) => forgotten.push(...ids) },
  };
  const code = ts.transpileModule(`let noteCleanupWorker, referenceEnvironmentSuspended = false, applicationExiting = false, referenceSourceWriteEpoch = 0;
    ${resume!.getText(ast)}; return { wake: resumeDeletedNoteIndexCleanup, exit() { applicationExiting = true; noteCleanupWorker?.worker.stop(); } };`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const coordinator = new Function(...Object.keys(env), code)(...Object.values(env));
  const background = coordinator.wake();
  active = await fixture([keep]); nativeGate.resolve();
  await assert.rejects(background, /资料库已变化/);
  assert.deepEqual(nativeCleaned, []); assert.equal((await native.pending()).length, 1);
  active = native; const restarted = new Function(...Object.keys(env), code)(...Object.values(env));
  await restarted.wake(); assert.deepEqual(nativeCleaned, ['a']); assert.deepEqual(await native.pending(), []);
  assert.deepEqual(textbookCleaned, ['a']); assert.deepEqual(flowCleaned, ['a']); assert.deepEqual(forgotten, ['a']);
  assert.match(handlers.get('vault:load')!.getText(ast), /retryDeletedNoteIndexCleanup/);
  assert.match(handlers.get('vault:save')!.getText(ast), /retryDeletedNoteIndexCleanup/);
  assert.match(handlers.get('vault:save-delta')!.getText(ast), /retryDeletedNoteIndexCleanup/);
  assert.match(main, /initDataCenter\([^\n]+\);\s*retryDeletedNoteIndexCleanup\(\)/u);
  assert.match(main, /applicationExiting = true;\s*deferredNoteIndex.stop\(\);\s*deferredChangedNoteIndex.stop\(\);\s*noteCleanupWorker\?\.worker.stop\(\)/u);
  pass('真实主进程协调器恢复磁盘任务，切库不清错对象；启动/加载/保存/退出入口接线完整');

  const midCleanup = await fixture([a, keep]); await midCleanup.save([keep]);
  active = midCleanup; switchDuringTextbook = await fixture([keep]);
  const switched = new Function(...Object.keys(env), code)(...Object.values(env));
  await assert.rejects(switched.wake(), /资料库已变化/);
  assert.deepEqual(textbookCleaned, ['a', 'a']);
  assert.deepEqual(flowCleaned, ['a'], '教材清理期间切库后不得开始新库的复盘清理');
  assert.deepEqual(forgotten, ['a']); assert.equal((await midCleanup.pending()).length, 1);
  switchDuringTextbook = undefined;
  pass('教材清理await期间切库立即停止后续复盘清理，保留原库任务供下次恢复');

  const ipc = await fixture([a, keep]); let committedJobs: ReturnType<typeof ipc.pending> | undefined;
  const saveEnv = { referenceEnvironmentSuspended: false, referenceSourceWriteEpoch: 0,
    getVaultRoot: () => ipc.root, getUserStateDir: () => ipc.states, mainWindow: null,
    referenceEnvironments: { revoke() {} }, referenceNoteSnapshotSaves: { run: (work: () => Promise<void>) => work() },
    communityImportFence: new CommunityImportFence(),
    loadMergedNotes: async () => [a, keep], referenceBuilds: { observeNoteSnapshot() {} }, referenceRagBuilds: { observeNoteSnapshot() {} },
    saveVaultSnapshot, atomicWriteTextFile, onWriteCommitted() {}, retryDeletedNoteIndexCleanup: () => { committedJobs = ipc.pending(); },
    noteRagIndexNotes: () => new Promise<void>(() => {}), deferredNoteIndex: { request() {} }, syncTextbookReferenceNotes: async () => {}, syncSavedFlowReviewNotes: async () => {}, console,
  };
  const saveJs = ts.transpileModule(`return (${handlers.get('vault:save')!.getText(ast)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  await new Function(...Object.keys(saveEnv), saveJs)(...Object.values(saveEnv))({}, [keep]);
  assert.ok(committedJobs); assert.deepEqual((await committedJobs!).map(job => job.noteId), ['a']);
  assert.deepEqual(await ipc.live(), ['keep']);
  pass('真实vault:save回执前任务已落盘；后台索引永不返回也不延迟删除保存回执');

  console.log(`Note cleanup recovery passed (${checks} groups; isolated synthetic disk and native-handler fixtures only).`);
} finally {
  assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep + 'loginote-cleanup-recovery-'));
  await fs.rm(temp, { recursive: true, force: true });
}
