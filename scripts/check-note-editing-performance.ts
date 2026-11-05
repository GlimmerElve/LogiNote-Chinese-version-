import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import type { NoteItem } from '../src/types';
import { calculateNoteMetadata, recalculateBacklinks, parseNoteMetadata } from '../src/services/noteMetadata';
import { prepareNotesMetadata } from '../src/services/noteMetadataClient';
import { createNoteMetadataSession } from '../src/services/noteMetadataProtocol';
import { NOTE_AUTOSAVE_IDLE_MS } from '../src/services/ui/noteAutosave';
import { getNoteEditorContext } from '../src/services/ui/noteEditorContext';
import { createDeferredNoteIndex } from '../src/services/deferredNoteIndex';
import { createHash } from 'node:crypto';
import { enqueueLatestNotesSave } from '../src/services/ui/learningWriteQueue';
import { acknowledgedSaveState } from '../src/services/ui/saveFeedback';
import { patchTextbookReadingPosition, retainLatestTextbookReadingPosition } from '../src/services/textbook/readingState';
import { trackReadingOnlySave } from '../src/services/ui/readingPositionSave';
import { trackPersonalOnlySave } from '../src/services/ui/personalNoteSave';
import { createNoteEditorMetadataDraft, sameEditorMetadataList } from '../src/services/ui/noteEditorMetadataDraft';
import { applyNoteRenameReferences } from '../src/services/noteRename';
import { createContext } from 'react';
import { ReadingWorkerProvider } from '../src/components/textbook/ReadingWorkerContext';
import { TextbookEditorLiveContext } from '../src/components/textbook/TextbookCodeEditor';
import { createMdxEditorRuntime } from '../src/components/MdxEditorRuntime';
import { appendProjectKnowledgeRows, pendingProjectKnowledgeRows } from '../src/services/progressiveLearning/knowledgeProjection';
import { shouldPublishNoteSnapshot } from '../src/services/ui/noteSnapshotPublication';
import { Realm } from '@mdxeditor/gurx';

// Memory-only real handlers/worker entry/editor hooks. No private vault or models.
// UI imports require the test-only CSS loader:
// node --require ./scripts/node-os-userinfo-fallback.cjs --import ./scripts/test-ui-assets.mjs --import tsx scripts/check-note-editing-performance.ts
let groups = 0;
const pass = (label: string) => console.log(`PASS ${++groups}: ${label}`);
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
function handler(name: string, env: Record<string, any>, file = 'src/App.tsx') {
  const ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  let init: ts.Expression | undefined;
  const visit = (node: ts.Node) => { if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) init = node.initializer; ts.forEachChild(node, visit); }; visit(ast);
  assert.ok(init);
  const expression = ts.isCallExpression(init) ? init.arguments[0] : init;
  const js = ts.transpileModule(`return (${expression.getText(ast)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
  return new Function(...Object.keys(env), js)(...Object.values(env));
}
const note = (id: string, extra: Partial<NoteItem> = {}): NoteItem => ({ id, title: id, content: '合成正文', noteType: 'project',
  tags: [], links: [], backlinks: [], dueDates: [], createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z', ...extra });
function fixture() {
  let timer = 0, state = 'saved', paints = 0, parses = 0;
  const initialNotes = [note('project'), note('knowledge', { noteType: 'knowledge' })];
  const timers = new Map<number, { callback: () => void; delay: number }>(), writes: NoteItem[][] = [], leases: boolean[] = [];
  let prepare: (notes: NoteItem[]) => Promise<NoteItem[]> = async notes => recalculateBacklinks(notes);
  let persist: () => Promise<void> = async () => {};
  const env: Record<string, any> = {
    notesRef: { current: initialNotes }, publishedNotesRef: { current: initialNotes }, pendingNotesRef: { current: null },
    learningWriteQueueRef: { current: Promise.resolve() }, noteSaveRevisionRef: { current: 0 },
    personalOnlySaveRef: { current: null }, readingOnlySaveRef: { current: null }, saveTimerRef: { current: null },
    editingIndexLeaseRef: { current: false }, editingIdleTimerRef: { current: null }, editingActivityRef: { current: 0 },
    setNotes: (next: NoteItem[]) => { paints++; env.publishedNotesRef.current = next; }, setNoteSaveState: (next: string) => { state = next; },
    setNoteSaveError() {},
    NOTE_AUTOSAVE_IDLE_MS,
    setTimeout: (callback: () => void, delay: number) => { timers.set(++timer, { callback, delay }); return timer; },
    clearTimeout: (id: number) => { timers.delete(id); },
    prepareNotesMetadata: async (notes: NoteItem[]) => { parses++; return prepare(notes); },
    saveReadingPositionOnly: async () => false, savePersonalStateOnly: async () => false, acknowledgePersonalSave: () => null,
    saveAllNotesToStorage: async (notes: NoteItem[]) => { writes.push(notes); await persist(); },
    enqueueLatestNotesSave, acknowledgedSaveState, patchTextbookReadingPosition, trackReadingOnlySave, trackPersonalOnlySave, applyNoteRenameReferences,
    shouldPublishNoteSnapshot,
    setNoteIndexEditing: async (active: boolean) => { leases.push(active); }, requestNoteIndexRefresh: async () => {},
    indexNote: () => assert.fail('typing must never submit an index job'),
    recalculateBacklinks: () => assert.fail('typing must not synchronously parse metadata'),
    console: { error() {} },
  };
  env.flushSave = handler('flushSave', env);
  const edit = handler('handleEditNote', env), finish = handler('handleFinishNoteEditing', env);
  return { env, edit, finish, writes, leases, timers, state: () => state, paints: () => paints, parses: () => parses,
    prepare: (value: typeof prepare) => { prepare = value; }, persist: (value: typeof persist) => { persist = value; },
    fire: async (delay: number) => { for (const [id, job] of timers) if (job.delay === delay) { timers.delete(id); job.callback(); } await tick(); } };
}

{
  const f = fixture();
  for (let i = 0; i < 100; i++) f.edit('project', { content: `中文输入${i}` });
  assert.equal(f.env.notesRef.current[0].content, '中文输入99'); assert.equal(f.env.pendingNotesRef.current, f.env.notesRef.current);
  assert.equal(f.env.noteSaveRevisionRef.current, 100); assert.equal(f.paints(), 0); assert.equal(f.parses(), 0);
  assert.equal(f.timers.size, 2); assert.deepEqual(f.leases, [true]);
  await f.fire(NOTE_AUTOSAVE_IDLE_MS); assert.equal(f.writes.length, 1); assert.equal(f.state(), 'saved'); assert.equal(f.writes[0][0].content, '中文输入99');
  pass('100次输入：即时草稿/退出保护，零逐字索引、全库解析和App笔记状态重绘；8秒空闲合并保存');
}
{
  const f = fixture(); f.edit('project', { title: '新标题' });
  f.env.notesRef.current = f.env.notesRef.current.map((item: NoteItem) => item.id === 'project' ? { ...item, resources: [{ id: 'new-resource' }] } : item);
  f.edit('project', { content: '新正文' }); assert.equal(f.env.notesRef.current[0].title, '新标题');
  assert.equal(f.env.notesRef.current[0].resources[0].id, 'new-resource');
  f.env.notesRef.current = f.env.notesRef.current.filter((item: NoteItem) => item.id !== 'project');
  f.edit('project', { content: '过期回调' }); assert.equal(f.env.notesRef.current.length, 1);
  pass('正文/标题按字段合并最新状态，不覆盖异步资源变更，不复活已删笔记');
}
{
  const f = fixture(), worker = deferred();
  f.prepare(async notes => { await worker.promise; return recalculateBacklinks(notes); });
  f.edit('project', { content: '第一版 [[knowledge]]' });
  const save = f.env.flushSave(f.env.notesRef.current); await tick();
  f.edit('project', { content: '第二版中文输入' }); worker.resolve(); await save;
  assert.equal(f.writes[0][0].content, '第一版 [[knowledge]]'); assert.equal(f.env.notesRef.current[0].content, '第二版中文输入');
  assert.equal(f.state(), 'pending'); assert.equal(f.paints(), 0); assert.ok(f.env.pendingNotesRef.current);
  await f.env.flushSave(f.env.notesRef.current); assert.equal(f.state(), 'saved'); assert.equal(f.env.pendingNotesRef.current, null);
  pass('Worker旧快照回执不覆盖新输入，不清除新草稿；下一次保存完成最新版本');
}
{
  const f = fixture();
  f.env.notesRef.current[0].textbook = { revisionId: 'synthetic-reading' };
  const positions: number[] = [];
  f.env.saveReadingPositionOnly = async (notes: NoteItem[]) => { positions.push(notes[0].textbookReadingState!.scrollTop!); return true; };
  // Reload the real save closure to use the synthetic reading-only IO.
  f.env.flushSave = handler('flushSave', f.env);
  const read = handler('handleTextbookReadingPosition', f.env);
  read('project', 'synthetic-reading', { scrollTop: 1 });
  const timer = f.env.saveTimerRef.current;
  for (let i = 2; i <= 100; i++) read('project', 'synthetic-reading', { scrollTop: i });
  assert.equal(f.env.saveTimerRef.current, timer, 'continuous scrolling must retain the first deadline');
  assert.equal(f.timers.size, 1); assert.equal(f.state(), 'saved', 'viewport updates do not dirty saved content');
  assert.equal(f.paints(), 0, 'reading never publishes a new content array');
  await f.fire(2000);
  assert.deepEqual(positions, [100]); assert.equal(f.state(), 'saved');
  assert.equal(f.env.pendingNotesRef.current, null); assert.equal(f.env.saveTimerRef.current, null);
  assert.equal(f.parses(), 0); assert.equal(f.writes.length, 0);
  read('project', 'synthetic-reading', { scrollTop: 100 }); assert.equal(f.timers.size, 0, 'unchanged position does not mark dirty');
  read('project', 'synthetic-reading', { scrollTop: 101 }); await f.fire(2000);
  assert.deepEqual(positions, [100, 101]); assert.equal(f.state(), 'saved');
  const get = handler('getTextbookReadingPosition', f.env);
  assert.equal(get('project', 'synthetic-reading')?.scrollTop, 101, 'reopened reader sees latest authoritative position without content publication');
  assert.equal(get('project', 'other-revision'), undefined); assert.equal(get('missing', 'synthetic-reading'), undefined);
  pass('连续100次阅读位置更新不推迟首次保存，2秒窗口保存最新位置；过期计时器清空，后续滚动继续保存，零正文解析/全量写入');
}
{
  // Real Reader scroll -> capture/flush -> real App handler/save queue. The
  // clock advances while scrolling, so a trailing-only reader cannot pass.
  const f = fixture(); let now = 0, serial = 0;
  const scheduled = new Map<number, { at: number; work: () => void }>();
  const persisted: Array<{ at: number; top: number }> = [];
  f.env.notesRef.current[0].textbook = { revisionId: 'reader-to-app' };
  const setTimer = (work: () => void, delay: number) => { scheduled.set(++serial, { at: now + delay, work }); return serial; };
  const clearTimer = (id: number) => { scheduled.delete(id); };
  f.env.setTimeout = setTimer; f.env.clearTimeout = clearTimer;
  f.env.saveReadingPositionOnly = async (notes: NoteItem[]) => {
    persisted.push({ at: now, top: notes[0].textbookReadingState!.scrollTop! }); return true;
  };
  f.env.flushSave = handler('flushSave', f.env);
  const read = handler('handleTextbookReadingPosition', f.env);
  const root = { scrollTop: 0, getBoundingClientRect: () => ({ top: 0 }), querySelectorAll: () => [] };
  const readerEnv: Record<string, any> = { active: true, restoring: { current: false }, reader: { current: root },
    viewport: { current: undefined }, pendingPosition: { current: undefined }, timer: { current: undefined },
    callback: { current: (position: any) => read('project', 'reader-to-app', position) }, note: { id: 'project' },
    manifest: { revisionId: 'reader-to-app' }, setTimeout: setTimer, clearTimeout: clearTimer };
  const readerFile = 'src/components/textbook/TextbookReader.tsx';
  readerEnv.capturePosition = handler('capturePosition', readerEnv, readerFile);
  readerEnv.flushPosition = handler('flushPosition', readerEnv, readerFile);
  const scroll = handler('scroll', readerEnv, readerFile);
  const advance = async (target: number) => {
    while (true) {
      const next = [...scheduled].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > target) break;
      now = next[1].at; scheduled.delete(next[0]); next[1].work(); await tick();
    }
    now = target;
  };
  for (let time = 0; time <= 10000; time += 100) {
    await advance(time); root.scrollTop = time; scroll();
    if (time === 0) assert.ok(f.env.pendingNotesRef.current, 'first reader scroll immediately protects close');
  }
  assert.ok(persisted.length >= 4, 'continuous reader events must persist multiple times before scrolling ends');
  assert.equal(persisted[0].at, 2000);
  for (const saved of persisted) assert.ok(saved.at - saved.top <= 300, 'each write contains a recent reader position');
  await advance(12500);
  assert.equal(persisted.at(-1)!.top, 10000); assert.equal(f.env.pendingNotesRef.current, null);
  assert.equal(f.paints(), 0); assert.equal(f.parses(), 0); assert.equal(f.writes.length, 0); assert.equal(f.state(), 'saved');
  assert.equal(scheduled.size, 0, 'idle reader and App keep no polling timers');
  pass('真实Reader→App→保存队列：连续10秒滚动期间多次轻量落盘，首次2秒保存；最终位置正确，零正文重绘/全库解析及空闲轮询');
}
{
  const before = note('project', { textbook: { revisionId: 'r1' } as any });
  const current = patchTextbookReadingPosition([before], 'project', 'r1', { scrollTop: 456 }, '2026-10-24T10:00:00Z')[0];
  const staleEdit = { ...before, title: '资源修改后的标题' };
  const merged = retainLatestTextbookReadingPosition(current, staleEdit);
  assert.equal(merged.title, staleEdit.title); assert.equal(merged.textbookReadingState, current.textbookReadingState);
  const newer = patchTextbookReadingPosition([before], 'project', 'r1', { scrollTop: 789 }, '2026-10-24T10:01:00Z')[0];
  assert.equal(retainLatestTextbookReadingPosition(current, newer), newer);
  const replaced = { ...before, textbook: { revisionId: 'r2' } as any };
  assert.equal(retainLatestTextbookReadingPosition(current, replaced), replaced);
  assert.equal(retainLatestTextbookReadingPosition(undefined, before), before);
  pass('旧可见属性的整笔记更新保留最新阅读位置；显式更新和新教材修订不被旧状态覆盖');
}
{
  const f = fixture();
  f.env.notesRef.current[0].textbook = { revisionId: 'synthetic-reading' };
  const read = handler('handleTextbookReadingPosition', f.env);
  f.edit('project', { content: '需要保存的正文' });
  const bodyDeadline = f.env.saveTimerRef.current;
  for (let i = 1; i <= 100; i++) read('project', 'synthetic-reading', { scrollTop: i });
  assert.equal(f.env.saveTimerRef.current, bodyDeadline, 'reading cannot postpone an existing body save');
  await f.fire(NOTE_AUTOSAVE_IDLE_MS); assert.equal(f.writes.length, 1); assert.equal(f.state(), 'saved');
  assert.equal(f.writes[0][0].content, '需要保存的正文'); assert.equal(f.writes[0][0].textbookReadingState!.scrollTop, 100);
  read('project', 'synthetic-reading', { scrollTop: 101 });
  assert.ok(f.timers.get(f.env.saveTimerRef.current)?.delay === 2000, 'an expired body timer cannot block future reading saves');
  f.edit('project', { content: '后续编辑' }); await f.fire(NOTE_AUTOSAVE_IDLE_MS);
  assert.equal(f.writes.length, 2); assert.equal(f.writes[1][0].content, '后续编辑'); assert.equal(f.state(), 'saved');
  pass('位置回写不推迟已排队的8秒正文保存，过期计时器不阻挡后续轻量阅读保存；实际操作另由活动监听延后正文保存');
}
{
  const f = fixture(), disk = deferred(); let attempt = 0;
  f.env.notesRef.current[0].textbook = { revisionId: 'synthetic-reading' };
  f.env.saveReadingPositionOnly = async () => { attempt++; if (attempt === 1) await disk.promise; if (attempt === 2) throw Error('synthetic reading save failure'); return true; };
  f.env.flushSave = handler('flushSave', f.env);
  const read = handler('handleTextbookReadingPosition', f.env);
  read('project', 'synthetic-reading', { scrollTop: 1 }); await f.fire(2000);
  assert.equal(f.state(), 'saved', 'background viewport IO does not rerender the content save indicator');
  read('project', 'synthetic-reading', { scrollTop: 2 });
  disk.resolve(); await tick();
  assert.equal(f.state(), 'saved'); assert.equal(f.env.pendingNotesRef.current[0].textbookReadingState.scrollTop, 2);
  await f.fire(2000); assert.equal(f.state(), 'error'); assert.ok(f.env.pendingNotesRef.current);
  assert.equal(f.timers.size, 0, 'failure does not automatically loop');
  await f.env.flushSave(f.env.notesRef.current);
  assert.equal(f.state(), 'saved'); assert.equal(f.env.pendingNotesRef.current, null);
  assert.equal(f.parses(), 0); assert.equal(f.writes.length, 0);
  pass('阅读写入期间的新位置保留下一窗口，旧回执不冒充成功；失败保留草稿且不忙重试，手动重试后才显示已保存');
}
{
  const f = fixture(); f.edit('project', { content: '保留失败草稿' });
  f.prepare(async () => { throw Error('worker failed'); });
  await assert.rejects(f.env.flushSave(f.env.notesRef.current));
  assert.equal(f.state(), 'error'); assert.equal(f.env.pendingNotesRef.current[0].content, '保留失败草稿'); assert.equal(f.writes.length, 0);
  f.prepare(async notes => recalculateBacklinks(notes)); await f.env.flushSave(f.env.notesRef.current); assert.equal(f.state(), 'saved');
  pass('后台解析失败不冒充保存成功，草稿可重试');
}
{
  const f = fixture(), disk = deferred(); f.persist(async () => disk.promise);
  f.edit('project', { content: '离页前内容' }); f.finish(); await tick();
  f.edit('knowledge', { content: '新页面正在编辑' }); disk.resolve(); await tick();
  assert.deepEqual(f.leases, [true], 'old page completion cannot release new editing lease');
  await f.fire(30_000); assert.deepEqual(f.leases, [true, false]);
  pass('离页先保存再唤醒索引；跨页新输入阻止旧回调释放租约，30秒静默结束编辑');
}

function scheduler(run: () => Promise<void>) {
  let id = 0; const jobs = new Map<number, { work: () => void; delay: number }>(), errors: unknown[] = [];
  const queue = createDeferredNoteIndex({ run, onError: error => errors.push(error),
    schedule: (work, delay) => { jobs.set(++id, { work, delay }); return id as any; }, cancel: key => { jobs.delete(key as any); } });
  return { queue, jobs, errors, fire: async () => { const current = [...jobs.values()]; jobs.clear(); current.forEach(job => job.work()); await tick(); } };
}
{
  const hold = deferred(); let runs = 0;
  const f = scheduler(async () => { runs++; if (runs === 1) { await hold.promise; throw Error('obsolete source'); } });
  f.queue.request(); await f.fire(); f.queue.request(); f.queue.flush(); hold.resolve(); await tick();
  assert.equal(f.jobs.size, 1); await f.fire(); assert.equal(runs, 2); assert.equal(f.jobs.size, 0);
  pass('失败的旧批次不吞掉运行期间到达的新保存/离页唤醒，也不自行循环重试');
}
{
  let runs = 0; const f = scheduler(async () => { runs++; });
  for (let i = 0; i < 100; i++) f.queue.request(); assert.equal(f.jobs.size, 1); assert.equal(runs, 0);
  f.queue.setEditing(1, true); f.queue.setEditing(2, true); assert.equal(f.jobs.size, 0);
  f.queue.flush(); await f.fire(); assert.equal(runs, 0);
  f.queue.setEditing(1, false); assert.equal(f.jobs.size, 0);
  f.queue.setEditing(2, false); assert.equal([...f.jobs.values()][0].delay, 0); await f.fire(); assert.equal(runs, 1);
  pass('后台索引100次保存合并一次，多窗口编辑租约期间不启动索引');
}
{
  const disk = deferred(); let runs = 0, version = 1; const seen: number[] = [];
  const f = scheduler(async () => { runs++; seen.push(version); if (runs === 1) await disk.promise; });
  f.queue.request(); await f.fire(); version = 2; f.queue.request(); f.queue.flush(); disk.resolve(); await tick();
  assert.equal(f.jobs.size, 1); await f.fire(); assert.deepEqual(seen, [1, 2]);
  f.queue.request(); f.queue.stop(); await f.fire(); assert.equal(runs, 2);
  pass('运行中更新不丢，下一轮读取最新源；退出取消待运行任务、不等待索引');
}
{
  let fail = true; const f = scheduler(async () => { if (fail) throw Error('index unavailable'); });
  f.queue.request(); await f.fire(); assert.equal(f.errors.length, 1); assert.equal(f.jobs.size, 0); assert.ok(f.queue.isPending());
  fail = false; f.queue.flush(); await f.fire(); assert.equal(f.queue.isPending(), false);
  const main = readFileSync('src/electron/main.ts', 'utf8');
  assert.match(main, /deferredNoteIndex\.request\(\); \/\/ Reconstruct unfinished/);
  assert.match(main, /const version = getDataVersion\(\), notes = await loadMergedNotes\(\)/);
  assert.match(main, /hits\.filter\(\(hit\) => isCurrentNoteReferenceHit\(hit, notes\)\)/);
  pass('索引失败不忙重试；可唤醒恢复；启动从已保存原文恢复，检索保留旧版本拒绝边界');
}
{
  const notes = [note('source', { content: '[[别名]] [[目标]]\n- [ ] 普通任务 @due(2026-10-24)' }),
    note('target', { title: '目标', aliases: ['别名'], noteType: 'knowledge' }),
    note('reference', { projectRole: 'reference', content: '- [ ] 不应成为任务 @due(2026-10-24)' })];
  const derived = recalculateBacklinks(notes);
  assert.deepEqual(derived[0].links, ['目标']); assert.deepEqual(derived[1].backlinks, ['source']);
  assert.equal(derived[0].dueDates.length, 1); assert.equal(parseNoteMetadata(notes[2]).dueDates.length, 0);
  assert.equal(recalculateBacklinks(derived), derived, 'unchanged metadata retains identity');
  assert.equal(derived[2], notes[2]);
  const again = await prepareNotesMetadata(derived); assert.equal(again, derived);
  pass('元数据提取保持别名/双链/任务规则，未变对象保留身份，同一已解析快照不重复解析');
}
{
  const original = globalThis.Worker; const messages: any[] = [];
  class FakeWorker {
    calculate = createNoteMetadataSession();
    onmessage: ((event: any) => void) | null = null; onerror: (() => void) | null = null;
    postMessage(value: any) { messages.push(value); queueMicrotask(() => this.onmessage?.({ data: { id: value.id, metadata: this.calculate(value) } })); }
    terminate() {}
  }
  Object.assign(globalThis, { Worker: FakeWorker });
  try {
    const notes = [note('worker', { content: '[[目标]]', personalCognition: 'never-transfer' } as any)];
    const [a, b] = await Promise.all([prepareNotesMetadata(notes), prepareNotesMetadata(notes)]);
    assert.equal(a, b); assert.equal(messages.length, 1); assert.equal(messages[0].notes[0].personalCognition, undefined);
    assert.deepEqual(a[0].links, ['目标']); assert.equal(await prepareNotesMetadata(a), a); assert.equal(messages.length, 1);
    const workerSource = readFileSync('src/services/noteMetadataWorker.ts', 'utf8'); assert.match(workerSource, /createNoteMetadataSession\(\)/);
  } finally { Object.assign(globalThis, { Worker: original }); }
  pass('Worker请求按快照去重，仅传解析字段，返回元数据不回传全文或私人活动状态');
}
{
  const root = note('root'), child = note('child', { parentId: 'root', links: ['concept'] }), knowledge = note('concept', { noteType: 'knowledge' });
  const notes = [root, child, knowledge];
  const first = getNoteEditorContext(child, notes), second = getNoteEditorContext(child, notes);
  assert.equal(first, second); assert.equal(first.rootProject?.id, 'root'); assert.deepEqual(first.rootKnowledgeNotes.map(item => item.id), ['concept']);
  assert.notEqual(first, getNoteEditorContext(child, [...notes]));
  pass('局部编辑重绘复用项目进度/知识关联；发布快照变化后重新派生');
}

{
  let root = 'scope-A', version = 1, requested = 0;
  let saved = [note('saved', { content: '已保存原文' })];
  let beforeRead: (() => void) | undefined, beforeQueue: (() => void) | undefined;
  const calls: string[] = [];
  const configuration = handler('deferredNoteIndex', {
    getVaultRoot: () => root, getUserStateDir: () => root + '/private', referenceSourceWriteEpoch: 1,
    applicationExiting: false, referenceEnvironmentSuspended: false, getDataVersion: () => version,
    serializeNoteSourceIndex: async (work: () => Promise<void>) => { beforeQueue?.(); await work(); },
    loadMergedNotes: async () => { beforeRead?.(); return saved; }, indexedSavedChannelKeys: new Map(), createHash,
    changedNoteIndex: { remember() {} },
    deferredNoteIndex: { request: () => { requested++; } },
    syncCognitionMaterialNotes: async (inputs: any[]) => { assert.equal(inputs[0].content, saved[0].content); calls.push('private-material'); },
    noteRagIndexNotes: async (notes: NoteItem[]) => { assert.equal(notes, saved); calls.push('reference'); },
    syncUserArgumentNotes: async () => { calls.push('published-graph'); }, generateRagEmbedding: () => assert.fail('no model'),
    syncTextbookReferenceNotes: async () => { calls.push('textbook'); }, syncSavedFlowReviewNotes: async () => { calls.push('review'); }, console,
  }, 'src/electron/main.ts');
  await configuration.run(); assert.equal(calls.length, 5); await configuration.run(); assert.equal(calls.length, 5, 'same saved hash skips maintenance');
  saved = [note('saved', { content: '最新已保存原文' })]; version++; await configuration.run(); assert.equal(calls.length, 10);
  beforeRead = () => { version++; }; await configuration.run(); assert.equal(calls.length, 10); assert.equal(requested, 1);
  beforeRead = undefined; beforeQueue = () => { root = 'scope-B'; }; await configuration.run(); assert.equal(calls.length, 10);
  pass('真实主进程后台回调只读已保存源，同哈希不重建，读取中更新及排队期间切库均拒绝旧快照');
}

function editorFixture() {
  let cursor = 0, parses = 0, plugins = 0; const slots: any[] = [], effects: Array<() => void> = [], options: any[] = [];
  const effectSetups = new Map<number, () => unknown>(), effectCleanups = new Map<number, () => void>();
  let runtime: ReturnType<typeof createMdxEditorRuntime>;
  let textbookContext: any;
  let imperative: { setMarkdown(value: string): void };
  const applied: string[] = [], editor = { setMarkdown: (value: string) => applied.push(value) };
  // Keep production surface/provider identities in the extracted component's
  // environment. This hook fixture records elements rather than mounting the
  // editor/providers, so it still performs no DOM, Worker or vault operations.
  const toolbarBusinessContext = createContext<unknown>(null);
  const toolbarSourceSwitchContext = createContext<unknown>(null);
  const env: Record<string, any> = {
    React: { createElement: (type: unknown, props: any, ...children: any[]) => { if (type === 'MDX') props.ref.current = editor; return { type, props: { ...props, children } }; } },
    StableMDXEditor: 'MDX', ToolbarBusinessContext: toolbarBusinessContext,
    ToolbarSourceSwitchContext: toolbarSourceSwitchContext, ReadingWorkerProvider, TextbookEditorLiveContext,
    createMdxEditorRuntime: (...args: Parameters<typeof createMdxEditorRuntime>) => runtime = createMdxEditorRuntime(...args),
    useRef: (value: any) => { const index = cursor++; return slots[index] ||= { current: value }; },
    useMemo: (work: () => any, deps: any[]) => { const index = cursor++, old = slots[index];
      if (old && deps.every((value, i) => value === old.deps[i])) return old.value;
      const value = work(); slots[index] = { deps, value }; return value; },
    useEffect: (work: () => void, deps?: any[]) => { const index = cursor++, old = slots[index];
      effectSetups.set(index, work);
      if (!old || !deps || deps.some((value, i) => value !== old[i])) effects.push(() => {
        effectCleanups.get(index)?.(); const cleanup = work() as unknown;
        if (typeof cleanup === 'function') effectCleanups.set(index, cleanup as () => void); else effectCleanups.delete(index);
      }); slots[index] = deps; },
    useImperativeHandle(_ref: unknown, create: () => typeof imperative) { imperative = create(); }, prepareMdxEditorInput: (value: string) => { parses++; return value; },
    mdxNoteContentPlugins: (value: any) => { plugins++; options.push(value); return []; }, fileToCompressedDataUrl() {},
    incrementalMarkdownPlugin: () => ({}), editorCompositionPlugin: () => ({}), markdownShortcutPlugin: () => ({}), diffSourcePlugin: () => ({}), mdxMarkdownCompatibilityPlugin: () => ({}), toolbarPlugin: (value: any) => value,
  };
  env.useCallback = (work: () => any, deps: any[]) => env.useMemo(() => work, deps);
  const render = handler('MdxNoteEditor', env, 'src/components/MdxNoteEditor.tsx');
  return { render: (props: any) => {
    cursor = 0; const tree = render(props, {}); effects.splice(0).forEach(work => work());
    const nodes = (value: any): any[] => !value || typeof value !== 'object' ? []
      : [value, ...(value.props?.children || []).flatMap(nodes)];
    const rendered = nodes(tree);
    assert.ok(rendered.some(node => node.type === ReadingWorkerProvider), 'the editor retains its shared reading Worker surface');
    const business = rendered.find(node => node.type === toolbarBusinessContext.Provider);
    const sourceSwitch = rendered.find(node => node.type === toolbarSourceSwitchContext.Provider);
    textbookContext = rendered.find(node => node.type === TextbookEditorLiveContext.Provider)?.props.value;
    assert.ok(textbookContext, 'live textbook business context remains outside the stable editor schema');
    assert.ok(business && sourceSwitch, 'both toolbar contexts remain mounted around the editor');
    assert.equal(business.props.value, props.toolbarExtra); assert.equal(sourceSwitch.props.value, props.sourceModeSwitch);
    const inner = rendered.find(node => node.type === env.StableMDXEditor);
    assert.ok(inner, 'find the actual editor through its context wrappers, not a fixed wrapper depth');
    return inner;
  },
    applied, options, textbookContext: () => textbookContext, runtime: () => runtime,
    replayEffects: () => {
      for (const cleanup of effectCleanups.values()) cleanup(); effectCleanups.clear();
      for (const [index, setup] of effectSetups) { const cleanup = setup(); if (typeof cleanup === 'function') effectCleanups.set(index, cleanup as () => void); }
    },
    handle: () => imperative, counts: () => ({ parses, plugins }) };
}
{
  const f = editorFixture(), notes: NoteItem[] = [], calls: string[] = [];
  let props = { content: '初始 <TextbookBoundary />', allNotes: notes, onWikiLinkClick: (value: string) => calls.push('old:' + value) };
  let tree = f.render(props);
  const originalPlugins = tree.props.plugins, originalChange = tree.props.onChange;
  for (let i = 0; i < 100; i++) { const content = `中文输入${i}`; tree.props.onChange(content, false); props = { ...props, content }; tree = f.render(props); }
  assert.equal(tree.props.plugins, originalPlugins, 'toolbar/content plugins must not reinstall on each character');
  assert.equal(tree.props.onChange, originalChange, 'stable inner editor callback avoids a Realm update per character');
  assert.deepEqual(f.counts(), { parses: 1, plugins: 1 }); assert.deepEqual(f.applied, []);
  props = { ...props, onWikiLinkClick: value => calls.push('latest:' + value) }; f.render(props); f.options[0].wiki.onClick('concept');
  assert.deepEqual(calls, ['latest:concept']);
  const callbacks = f.options[0]; props = { ...props, allNotes: [...notes] }; f.render(props);
  for (const kind of ['wiki', 'argument', 'review']) assert.equal(f.options.at(-1)[kind], callbacks[kind], 'saved snapshots must not notify every unchanged decorator');
  props = { ...props, allNotes: [note('with-review', { learningReviewRecords: [] })] }; f.render(props);
  assert.equal(f.options.at(-1).review, callbacks.review, 'unreferenced review arrays must not rebuild the content schema; used-data refresh is checked with a real Realm in check-mdx-editor-runtime');
  assert.equal(f.textbookContext().allNotes, props.allNotes, 'source citations receive the latest snapshot even while plugins stay stable');
  props = { ...props, content: '外部替换正文' }; f.render(props); assert.deepEqual(f.applied, ['外部替换正文']); assert.equal(f.counts().parses, 2);
  const other = editorFixture(); other.render({ content: '另一实例', allNotes: notes, onWikiLinkClick: (value: string) => calls.push('other:' + value) });
  other.options[0].wiki.onClick('B'); f.options[0].wiki.onClick('A'); assert.deepEqual(calls.slice(-2), ['other:B', 'latest:A']);
  const surface = editorFixture(), unusedLibrary = new Array(50_000); let libraryReads = 0;
  const opaqueSnapshot = () => new Proxy(unusedLibrary, { get() { libraryReads++; throw Error('editor render must not enumerate the library'); } });
  const firstSurface = surface.render({ content: '合成正文', allNotes: opaqueSnapshot() });
  assert.equal(surface.options[0].textbook.allNotes, undefined, 'lifetime-long schema must not retain the initial full-library snapshot');
  for (let i = 0; i < 30; i++) {
    const snapshot = opaqueSnapshot(), active = Boolean(i % 2), scope = active ? 'all' : 'knowledge-section';
    const manifest = { revisionId: `synthetic-${i}` };
    const next = surface.render({ content: '合成正文', allNotes: snapshot, active, mathRecovery: scope, textbookManifest: manifest });
    assert.equal(next.props.plugins, firstSurface.props.plugins, 'saved snapshot, active and manifest changes preserve plugin identity');
    assert.equal(surface.textbookContext().allNotes, snapshot); assert.equal(surface.textbookContext().active, active);
    assert.equal(surface.textbookContext().manifest, manifest);
    assert.deepEqual(surface.options[0].liveImportOptions(), { scope, textbook: true });
  }
  assert.equal(libraryReads, 0); assert.equal(surface.counts().plugins, 1); assert.deepEqual(surface.applied, []);
  const strict = editorFixture(), strictRealm = new Realm(); let strictDoc = { doc_id: 'seen', title: 'before' }, strictPublications = 0;
  const strictPublish = strictRealm.pub.bind(strictRealm);
  (strictRealm as any).pub = (node: any, value: any) => { if (value?.getDoc) strictPublications++; return strictPublish(node, value); };
  const strictProps = { content: '严格生命周期', getArgumentDoc: () => strictDoc };
  strict.render(strictProps); strict.runtime().plugin.init?.(strictRealm);
  strict.options[0].argument.getDoc('seen');
  // Exercise the actual extracted component's cleanup/setup replay WITHOUT a
  // second plugin.init. The already-mounted Realm/dependencies must survive.
  strict.replayEffects(); strictDoc = { ...strictDoc, title: 'after replay' }; strict.render(strictProps);
  assert.equal(strictPublications, 1, 'effect replay must not detach the live Realm or forget mounted decorators');
  assert.deepEqual(strict.applied, [], 'lifecycle replay must not reimport content or clear undo');
  tree.props.onChange('初始化回写', true); assert.equal(f.counts().parses, 2);
  pass('真实编辑器Hook：100次输入零全文回灌/重复兼容解析，插件复用且读取最新回调，多实例互不串线');
}
{
  const f = editorFixture(), allNotes: NoteItem[] = [];
  const first = f.render({ content: 'A', allNotes });
  first.props.onChange('B', false); f.render({ content: 'B', allNotes });
  assert.deepEqual(f.applied, []);
  f.handle().setMarkdown('C'); f.render({ content: 'C', allNotes });
  assert.deepEqual(f.applied, ['C'], 'accepted external document is imported only once');
  f.render({ content: 'B', allNotes });
  assert.deepEqual(f.applied, ['C', 'B'], 'an old self-emission cannot hide a real external replacement');
  const second = f.render({ content: 'D', allNotes }); second.props.onChange('E', false); f.render({ content: 'E', allNotes });
  f.render({ content: 'F', allNotes }); f.render({ content: 'E', allNotes });
  assert.deepEqual(f.applied.slice(-3), ['D', 'F', 'E'], 'prop-driven imports also invalidate stale self-emission identity');
  pass('显式替换不重复导入；显式/属性替换均清除旧本地输出标识，往返旧版本不再跳过同步');
}
{
  const file = 'src/services/ragService.ts', ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
  const env: Record<string, any> = { noteRagApi: () => null, hasSubstantiveContent: () => true,
    buildEmbeddingText: (note: NoteItem) => note.title + '\n' + note.content, generateEmbedding: async () => [1, 0], cosineSimilarity: () => 1,
    hasSubstantiveReferenceText: () => true, normalizeNoteSearchResults: (value: unknown) => value, console,
    deleteNoteEmbeddings: async () => {} };
  let records: any[] = [], embeds = 0;
  env.generateEmbedding = async () => { embeds++; return [1, 0]; };
  env.readAllNoteEmbeddings = async () => records;
  env.writeNoteEmbeddings = async (value: any[]) => { records = value; };
  const load = (name: string) => {
    const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name) as ts.FunctionDeclaration;
    const text = declaration.getText(ast).replace(/^export\s+/u, '');
    const js = ts.transpileModule(`return (${text});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    return new Function(...Object.keys(env), js)(...Object.values(env));
  };
  env.indexNote = load('indexNote'); const indexAll = load('indexAllNotes');
  const source = note('browser', { noteType: 'knowledge' });
  await indexAll([source]); await indexAll([source]); assert.equal(embeds, 1);
  env.readNotesForCognition = async () => [{ ...source, updatedAt: 'new-version' }];
  assert.deepEqual(await load('searchNotes')('query'), [], 'old cache cannot be returned during delayed rebuild');
  env.readNotesForCognition = async () => [source];
  assert.equal((await load('searchNotes')('query')).length, 1);
  records[0].sourceUpdatedAt = undefined; assert.deepEqual(await load('searchNotes')('query'), []);
  pass('浏览器回退：未改版本零重复向量；延后重建期间拒绝旧版本和缺少源版本的旧缓存');
}
{
  const file = 'src/components/NoteEditor.tsx', ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  let effect: ts.Expression | undefined;
  const find = (node: ts.Node) => { if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect'
    && node.arguments[0]?.getText(ast).includes('const completionVersion')) effect = node.arguments[0]; ts.forEachChild(node, find); }; find(ast); assert.ok(effect);
  const js = ts.transpileModule(`return (${effect.getText(ast)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const source = note('same-note', { content: '另一实例已保存的新正文' }); const contentChanges: string[] = [];
  const env: Record<string, any> = { note: source, content: '隐藏页旧正文', latestContentRef: { current: '隐藏页旧正文' }, latestNoteRef: { current: source },
    mdxEditorRef: { current: null }, title: source.title, isActive: false, readTextbook: false,
    pendingKnowledgeRef: { current: { noteId: source.id, rows: [] } }, appendProjectKnowledgeRows, pendingProjectKnowledgeRows,
    titleDraftRef: { current: { noteId: source.id, baseline: source.title, value: source.title } },
    previousActiveRef: { current: true }, prevNoteIdRef: { current: source.id }, isLocalTypingRef: { current: true },
    previousTaskCompletionRef: { current: JSON.stringify([source.id, []]) }, localTypingTimeoutRef: { current: null },
    metadataDraftRef: { current: createNoteEditorMetadataDraft(source) }, tagsText: '', aliasesText: '',
    invalidAliasesDraftRef: { current: null }, setAliasesError() {},
    sameEditorMetadataList, splitAliasTokens: (text: string) => text.split(/[,，、；;]/).map(item => item.trim()).filter(Boolean),
    setContent: (value: string) => contentChanges.push(value), setTitle() {}, setResources() {}, setTagsText() {}, setAliasesText() {} };
  const apply = () => new Function(...Object.keys(env), js)(...Object.values(env))();
  apply(); assert.deepEqual(contentChanges, []); env.isActive = true; apply();
  assert.deepEqual(contentChanges, [source.content]); assert.equal(env.isLocalTypingRef.current, false);
  pass('真实接收Effect：隐藏编辑器重新激活时同步另一实例的新正文，不把旧草稿带回画布');

  // The shell's React snapshot deliberately lags local typing. An external
  // rollback to that same snapshot must still replace the live Lexical draft.
  const imports: string[] = [];
  env.content = '初始版本A'; env.note = { ...source, content: env.content };
  env.latestContentRef.current = '本地编辑版本B';
  env.latestNoteRef = { current: { ...source, content: '本地编辑版本B' } };
  env.mdxEditorRef = { current: { setMarkdown: (value: string) => imports.push(value) } };
  apply();
  assert.deepEqual(imports, ['初始版本A']);
  assert.equal(env.latestContentRef.current, '初始版本A');
  assert.equal(env.latestNoteRef.current.content, '初始版本A', 'whole-note actions must not restore the rejected B draft');
  apply(); assert.equal(imports.length, 1, 'an acknowledged rollback must not repeatedly import');
  env.latestContentRef.current = '继续编辑C'; env.latestNoteRef.current.content = '继续编辑C'; env.isLocalTypingRef.current = true;
  apply(); assert.equal(imports.length, 1); assert.equal(env.latestContentRef.current, '继续编辑C');
  pass('外部回滚到未变React快照仍同步实时编辑器及业务草稿，仅导入一次，保留本地输入保护');
}
{
  const f = editorFixture(), allNotes: NoteItem[] = [], calls: string[] = [];
  const initial = { content: '合成引用测试', allNotes };
  f.render(initial);
  assert.equal(f.options[0].textbook.onOpenDocument, undefined, 'missing callback must allow SourceReference default file opener');
  assert.equal(f.options[0].textbook.onOpenKnowledge, undefined, 'missing navigation must not masquerade as a successful callback');
  f.render({ ...initial, onOpenDocument: async (id: string) => { calls.push(`old:${id}`); } });
  const forwarded = f.textbookContext().onOpenDocument;
  assert.equal(typeof forwarded, 'function'); await forwarded('doc-A');
  f.render({ ...initial, onOpenDocument: async (id: string) => { calls.push(`new:${id}`); throw Error('synthetic open failure'); } });
  assert.equal(f.counts().plugins, 1, 'enabling/disabling navigation and callback identity changes must not recreate schema plugins');
  await assert.rejects(forwarded('doc-B'), /synthetic open failure/);
  assert.deepEqual(calls, ['old:doc-A', 'new:doc-B']);
  f.render(initial); assert.equal(f.textbookContext().onOpenDocument, undefined);
  pass('引用打开回调缺省时保留默认文件打开；可动态启停，最新异步回调与错误回传不丢失');
}
{
  const f = fixture(), source = f.env.notesRef.current[0]; let paints = 0;
  const env = { note: source, content: source.content, editingNoteIdRef: { current: source.id },
    latestContentRef: { current: source.content }, latestNoteRef: { current: source },
    pendingKnowledgeRef: { current: { noteId: source.id, rows: [] } }, appendProjectKnowledgeRows,
    setContent: () => { paints++; }, onEditNote: f.edit, onUpdateNote: () => assert.fail('must use immediate field draft') };
  const input = handler('handleContentChange', env, 'src/components/NoteEditor.tsx');
  for (let i = 0; i < 100; i++) input(`正文中文${i}`);
  assert.equal(paints, 0); assert.equal(env.latestContentRef.current, '正文中文99');
  assert.equal(env.latestNoteRef.current.content, '正文中文99'); assert.equal(f.env.notesRef.current[0].content, '正文中文99');
  assert.equal(f.state(), 'pending'); assert.deepEqual(f.leases, [true]);
  env.editingNoteIdRef.current = 'another-note'; input('过期输入');
  assert.equal(env.latestContentRef.current, '正文中文99');
  await f.fire(NOTE_AUTOSAVE_IDLE_MS); assert.equal(f.writes[0][0].content, '正文中文99');
  pass('实际正文输入处理：100次输入零整页重绘，草稿/保存队列/RAG租约即时更新；换笔记的过期事件被拒绝');
}
console.log(`note editing performance: ${groups} groups passed`);
