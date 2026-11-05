import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { NoteItem } from '../src/types';
import { NoteSaveRecovery } from '../src/components/NoteSaveRecovery';
import { createRendererExitPreparation } from '../src/services/ui/applicationExit';
import { enqueueLearningWrite, enqueueLatestNotesSave } from '../src/services/ui/learningWriteQueue';
import { acknowledgedSaveState } from '../src/services/ui/saveFeedback';
import { shouldPublishNoteSnapshot } from '../src/services/ui/noteSnapshotPublication';
import { createOptimisticNoteDeletionState, stageOptimisticNoteDeletion, acknowledgeOptimisticNoteDeletion,
  rollbackOptimisticNoteDeletions, rejectLateDeletedNoteUpdate } from '../src/services/ui/optimisticNoteDeletion';

// Actual App/Sidebar handlers, memory-only writes, synthetic notes. No real vault/model.
let checks = 0;
const pass = (label: string) => console.log(`PASS ${++checks}: ${label}`);
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; };
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function handler(name: string, env: Record<string, any>, file = 'src/App.tsx') {
  const ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  let declaration: ts.VariableDeclaration | undefined;
  const find = (node: ts.Node) => { if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) declaration = node; ts.forEachChild(node, find); }; find(ast);
  assert.ok(declaration?.initializer);
  const init = ts.isCallExpression(declaration.initializer) ? declaration.initializer.arguments[0] : declaration.initializer;
  const js = ts.transpileModule(`return (${init.getText(ast)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(env), js)(...Object.values(env));
}
const note = (id: string, extra: Partial<NoteItem> = {}): NoteItem => ({ id, title: id, content: '合成正文', noteType: 'knowledge',
  tags: [], links: [], backlinks: [], dueDates: [], createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z', ...extra });
function fixture() {
  // Knowledge-note removal now opens the maintenance workflow; use a project
  // child when testing the direct optimistic-delete queue and its retry order.
  const initial = [note('root', { noteType: 'project' }), note('child', { noteType: 'project', parentId: 'root' }), note('keep')];
  const paint: Array<() => void> = [], writes: NoteItem[][] = [], cleaned: string[][] = [], errors: unknown[] = [];
  const events: Array<{ type: string; init?: any }> = [];
  let state = 'saved', pendingCount = 0, restoredCount = 0, active: string | null = 'child', project: string | null = 'root';
  let persist: (notes: NoteItem[]) => Promise<void> = async () => {};
  const env: Record<string, any> = {
    notesRef: { current: initial }, publishedNotesRef: { current: initial }, pendingNotesRef: { current: null }, learningWriteQueueRef: { current: Promise.resolve() },
    optimisticDeletionsRef: { current: createOptimisticNoteDeletionState() }, noteSaveRevisionRef: { current: 0 },
    readingOnlySaveRef: { current: null }, personalOnlySaveRef: { current: null }, saveTimerRef: { current: null },
    createOptimisticNoteDeletionState, stageOptimisticNoteDeletion, acknowledgeOptimisticNoteDeletion,
    rollbackOptimisticNoteDeletions, rejectLateDeletedNoteUpdate, enqueueLearningWrite, enqueueLatestNotesSave, acknowledgedSaveState,
    clearTimeout() {}, setTimeout: (callback: () => void) => { paint.push(callback); return paint.length; },
    setNotes(notes: NoteItem[]) { env.publishedNotesRef.current = notes; }, setNoteSaveState: (value: string) => { state = value; },
    setNoteSaveError() {},
    setPendingDeletionCount: (value: number) => { pendingCount = value; },
    setRestoredDeletionCount: (value: number | ((previous: number) => number)) => { restoredCount = typeof value === 'number' ? value : value(restoredCount); },
    setActiveNoteIdState: (update: (id: string | null) => string | null) => { active = update(active); },
    setActiveProjectContextId: (update: (id: string | null) => string | null) => { project = update(project); },
    saveAllNotesToStorage: async (notes: NoteItem[]) => { writes.push(notes); await persist(notes); },
    finishDeletedNoteIndexCleanup: async (ids: string[]) => { if (ids.length) cleaned.push(ids); },
    reportLearningSaveError: (error: unknown) => errors.push(error), console: { error() {}, warn() {} },
    window: { dispatchEvent: (event: { type: string; init?: unknown }) => { events.push(event); return true; } },
    CustomEvent: class { constructor(public type: string, public init?: unknown) {} },
    saveReadingPositionOnly: async () => false, savePersonalStateOnly: async () => false, acknowledgePersonalSave: () => null,
    prepareNotesMetadata: async (notes: NoteItem[]) => notes,
    shouldPublishNoteSnapshot,
  };
  env.collectDescendantIds = handler('collectDescendantIds', {});
  env.stageNoteDeletion = handler('stageNoteDeletion', env);
  env.flushSave = handler('flushSave', env);
  return { env, initial, paint, writes, cleaned, errors, events,
    remove: handler('handleDeleteNote', env), removeProject: handler('handleDeleteProject', env),
    setPersist: (value: typeof persist) => { persist = value; },
    afterPaint: async () => { await tick(); paint.splice(0).forEach(callback => callback()); await tick(); },
    status: () => ({ state, pendingCount, restoredCount, active, project }),
    edit: (notes: NoteItem[]) => { env.notesRef.current = notes; env.pendingNotesRef.current = notes; env.noteSaveRevisionRef.current++; },
  };
}

{
  const f = fixture(), prior = deferred(), disk = deferred();
  f.env.learningWriteQueueRef.current = prior.promise; f.setPersist(async () => disk.promise);
  let confirm: unknown = { id: 'root', title: '合成项目', childCount: 1 }, busy = false;
  const closeDialog = handler('confirmProjectDelete', { showDeleteConfirm: confirm, deleteBusy: false, onDeleteProject: f.removeProject,
    setDeleteBusy: (value: boolean) => { busy = value; }, setDeleteError() {}, setShowDeleteConfirm: (value: unknown) => { confirm = value; } }, 'src/components/Sidebar.tsx');
  await closeDialog();
  assert.equal(confirm, null); assert.equal(busy, false); assert.equal(f.writes.length, 0);
  assert.deepEqual(f.env.notesRef.current.map((n: NoteItem) => n.id), ['keep']);
  assert.deepEqual(f.status(), { state: 'pending', pendingCount: 2, restoredCount: 0, active: 'keep', project: null });
  assert.ok(f.env.pendingNotesRef.current); assert.notEqual(f.env.learningWriteQueueRef.current, prior.promise);
  prior.resolve(); await f.afterPaint(); assert.equal(f.writes.length, 1); assert.equal(f.status().state, 'saving');
  disk.resolve(); await f.env.learningWriteQueueRef.current;
  assert.equal(f.status().state, 'saved'); assert.equal(f.status().pendingCount, 0);
  assert.equal(f.env.pendingNotesRef.current, null); assert.deepEqual(new Set(f.cleaned[0]), new Set(['root', 'child']));
  pass('真实确认弹窗立即关闭，旧写队列/慢磁盘均不阻塞前端；同帧已有退出保护，成功后才清索引');
}
{
  const f = fixture(), disk = deferred(); f.setPersist(async () => { await disk.promise; throw new Error('synthetic failure'); });
  await f.removeProject('root'); await f.afterPaint();
  const edited = { ...f.env.notesRef.current[0], content: '等待删除时的新编辑' }, added = note('new');
  f.edit([edited, added]); disk.resolve(); await assert.rejects(f.env.learningWriteQueueRef.current, /synthetic failure/);
  assert.equal(f.status().state, 'error'); assert.equal(f.status().restoredCount, 2);
  assert.equal(f.env.notesRef.current.find((n: NoteItem) => n.id === 'keep'), edited);
  assert.equal(f.env.notesRef.current.find((n: NoteItem) => n.id === 'new'), added);
  assert.deepEqual(new Set(f.env.notesRef.current.map((n: NoteItem) => n.id)), new Set(['root', 'child', 'keep', 'new']));
  assert.equal(f.cleaned.length, 0); assert.ok(f.env.pendingNotesRef.current);
  f.setPersist(async () => {}); await f.env.flushSave(f.env.notesRef.current);
  assert.equal(f.status().state, 'saved'); assert.equal(f.status().restoredCount, 2, '恢复提示保留到用户知晓，不因自动保存闪退');
  pass('保存失败只合并恢复待删项目，不回滚新编辑/新笔记；重试保存恢复结果，失败提示仍可见');
}
{
  const f = fixture(), disk = deferred(); let attempt = 0;
  f.setPersist(async () => { if (++attempt === 1) { await disk.promise; throw new Error('first write failed'); } });
  f.remove('child', { stopPropagation() {} }); await f.afterPaint();
  await f.removeProject('root'); disk.resolve();
  await f.afterPaint(); await f.env.learningWriteQueueRef.current;
  assert.deepEqual(new Set(f.env.notesRef.current.map((n: NoteItem) => n.id)), new Set(['root', 'child', 'keep']));
  assert.equal(f.status().restoredCount, 2); assert.equal(f.status().state, 'saved'); assert.equal(f.cleaned.length, 0);
  pass('先删子项再删父项时，失败不会留下孤儿；后续队列可保存恢复结果而不继续误删');
}
{
  const f = fixture(); f.remove('child', { stopPropagation() {} }); await f.removeProject('root');
  await f.afterPaint(); await f.afterPaint(); await f.env.learningWriteQueueRef.current;
  assert.equal(f.writes.length, 1, '连续删除的第一项保存最新状态，后一项不重复整库写入');
  assert.equal(f.status().pendingCount, 0);
  handler('handleUpdateNote', f.env)(note('child', { content: '迟到的编辑器回调' }));
  assert.deepEqual(f.env.notesRef.current.map((n: NoteItem) => n.id), ['keep']);
  assert.equal(rejectLateDeletedNoteUpdate(f.env.optimisticDeletionsRef.current, [note('child')], 'child'), false);
  pass('连续删除合并落盘；迟到的编辑回调不能复活已删笔记，显式恢复后仍允许编辑');
}
{
  const tracker = createOptimisticNoteDeletionState(), original = [note('a'), note('b')];
  stageOptimisticNoteDeletion(tracker, original, ['a']); const first = new Map(tracker.pending);
  const replacement = note('a', { content: '显式恢复的新版本' });
  stageOptimisticNoteDeletion(tracker, [replacement, original[1]], ['a']);
  acknowledgeOptimisticNoteDeletion(tracker, first, [original[1]], [original[1]]);
  assert.equal(tracker.pending.size, 1, '旧回执不核销重新删除的新版本');
  const recovery = rollbackOptimisticNoteDeletions(tracker, [replacement, original[1]]);
  assert.equal(recovery.notes[0], replacement); assert.equal(recovery.restoredCount, 0);
  pass('同ID新版本不会被旧删除回执核销，也不会被失败恢复的旧正文覆盖');
}
{
  const f = fixture(), disk = deferred(); f.setPersist(async () => disk.promise);
  f.remove('child', { stopPropagation() {} }); let ready = false;
  const exit = createRendererExitPreparation(async () => {
    await f.env.learningWriteQueueRef.current.catch(() => {});
    if (f.env.pendingNotesRef.current) await f.env.flushSave(f.env.pendingNotesRef.current);
  });
  const leaving = exit.run('prepare').then(() => { ready = true; });
  await f.afterPaint(); assert.equal(ready, false); disk.resolve(); await leaving;
  assert.equal(ready, true); assert.equal(f.status().state, 'saved');
  pass('正常退出仍等待已排队的删除保存，不因弹窗已关而漏掉未落盘删除');
}
{
  const pending = renderToStaticMarkup(createElement(NoteSaveRecovery, { state: 'pending', pendingDeletionCount: 3, onRetry() {} }));
  assert.match(pending, /role="status"/); assert.match(pending, /正在后台保存删除/); assert.match(pending, /3/);
  const failed = renderToStaticMarkup(createElement(NoteSaveRecovery, { state: 'error', restoredDeletionCount: 2, onRetry() {} }));
  assert.match(failed, /role="alert"/); assert.match(failed, /已在界面恢复/); assert.match(failed, /重试保存/);
  const recovered = renderToStaticMarkup(createElement(NoteSaveRecovery, { state: 'saved', restoredDeletionCount: 2, onRetry() {}, onDismissDeletionNotice() {} }));
  assert.match(recovered, /role="alert"/); assert.match(recovered, /知道了/);
  assert.equal(renderToStaticMarkup(createElement(NoteSaveRecovery, { state: 'saved', onRetry() {} })), '');
  pass('沿用现有状态栏：后台保存可播报、失败恢复可重试，恢复通知保留且可关闭');
}
{
  const f = fixture(); f.remove('keep', { stopPropagation() {} }); await f.afterPaint();
  assert.deepEqual(f.events.map(event => [event.type, event.init?.detail]),
    [['loginote:knowledge-maintenance', { kind: 'delete', ids: ['keep'] }]]);
  assert.equal(f.env.notesRef.current, f.initial); assert.equal(f.env.pendingNotesRef.current, null);
  assert.equal(f.writes.length, 0); assert.equal(f.status().pendingCount, 0);
  pass('知识笔记删除仍进入维护审核入口，不绕过确认直接进入通用乐观删除队列');
}
console.log(`Optimistic note deletion passed (${checks} groups; real handlers, synthetic memory-only IO).`);
