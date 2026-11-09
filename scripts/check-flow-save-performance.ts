import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import ts from 'typescript';
import type { NoteItem, FlowSession } from '../src/types';
import { saveVaultSnapshot, recoverVaultSnapshot } from '../src/electron/vaultSnapshot';
import { atomicWriteTextFile } from '../src/electron/atomicWrite';
import { saveTextbookReadingPositions } from '../src/electron/textbookReadingSave';
import { deserializeUserStateFile } from '../src/services/userStateService';
import { enqueueLearningWrite, enqueueLatestNotesSave } from '../src/services/ui/learningWriteQueue';
import { trackReadingOnlySave, saveReadingPositionOnly, type ReadingOnlySave } from '../src/services/ui/readingPositionSave';
import { patchTextbookReadingPosition } from '../src/services/textbook/readingState';
import { acknowledgedSaveState } from '../src/services/ui/saveFeedback';
import { flowReviewAdmission } from '../src/services/textbook/reviewAdmission';
import { saveFlowReviewRecord } from '../src/services/textbook/reviewRecordStore';
import { createArgumentReferenceNoteSnapshotQueue } from '../src/electron/rag/argumentReferenceNoteObservations';
import { isPersonalOnlyNoteChange } from '../src/services/personalNoteState';
import { trackPersonalOnlySave, savePersonalStateOnly, acknowledgePersonalSave } from '../src/services/ui/personalNoteSave';
import { NOTE_AUTOSAVE_IDLE_MS, confirmNoteNavigation } from '../src/services/ui/noteAutosave';
import { shouldPublishNoteSnapshot } from '../src/services/ui/noteSnapshotPublication';

globalThis.fetch = async () => assert.fail('No model/network requests in save performance checks');
let groups = 0;
const pass = (message: string) => { groups++; console.log(`PASS ${message}`); };
const project: NoteItem = { id: 'project', title: '合成教材', noteType: 'project', content: '# 合成教材\n\n保留正文。',
  tags: [], links: [], backlinks: [], dueDates: [], createdAt: '2026-10-16T00:00:00Z', updatedAt: '2026-10-16T00:00:00Z',
  textbook: { schemaVersion: 1, textbookId: 'book', projectNoteId: 'project', rootProjectId: 'project', regionId: 'region',
    revisionId: 'rev-1', createdAt: '2026-10-16T00:00:00Z', updatedAt: '2026-10-16T00:00:00Z' },
  flowSummary: '已有学习总结', questions: [{ id: 'question', noteId: 'project', question: '已有问题', createdAt: '2026-10-16T00:00:00Z' }],
};
const session: FlowSession = { id: 'session', noteId: project.id, noteTitle: project.title, startedAt: '2026-10-16T00:00:00Z',
  endedAt: '2026-10-16T00:20:00Z', durationSeconds: 1200, reviewIntervalMinutes: 20, restateText: '', summary: '', analyze: false };
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'loginote-flow-save-'));
const vault = path.join(temp, 'vault'), states = path.join(temp, 'user-state');
try {
  let files: string[] = [];
  const writer = async (file: string, text: string) => { files.push(path.basename(file)); return atomicWriteTextFile(file, text); };
  let notes = [project, ...Array.from({ length: 252 }, (_, index) => ({ ...project, id: `note-${index}`, textbook: undefined, content: `# 合成正文 ${index}` }))];
  await saveVaultSnapshot(vault, states, notes, writer);
  assert.equal(files.length, 256);
  files = []; await saveVaultSnapshot(vault, states, structuredClone(notes), writer); assert.deepEqual(files, []);
  pass('253篇初次保存完整，完全相同快照零文件写入/零新journal');

  notes = notes.map(note => note.id === project.id ? { ...note, content: note.content + '\n\n真实新增复盘', updatedAt: session.endedAt, flowSummary: '新总结' } : note);
  await saveVaultSnapshot(vault, states, notes, writer);
  assert.deepEqual(files, ['vault-pending-snapshot.json', 'user-state.json', 'project.md', 'metadata.json']);
  assert.equal(await fs.readFile(path.join(vault, 'notes', 'note-1.md'), 'utf8'), '# 合成正文 1');
  pass('单篇图文复盘只写4个必要文件，其他252篇正文不重写');

  files = [];
  notes = notes.map(note => note.id === project.id ? { ...note, flowSummary: '仅个人记录变化' } : note);
  await saveVaultSnapshot(vault, states, notes, writer);
  assert.deepEqual(files, ['vault-pending-snapshot.json', 'user-state.json']);
  await fs.writeFile(path.join(vault, 'notes', 'project.md'), '合成外部修改');
  files = []; await saveVaultSnapshot(vault, states, notes, writer);
  assert.deepEqual(files, ['vault-pending-snapshot.json', 'project.md']);
  // Simulate a missing body without deleting any real vault data.
  await fs.rename(path.join(vault, 'notes', 'note-1.md'), path.join(temp, 'held-note-1.md'));
  files = []; await saveVaultSnapshot(vault, states, notes, writer);
  assert.deepEqual(files, ['vault-pending-snapshot.json', 'note-1.md']);
  pass('个人记录不重写教材；比较真实磁盘字节，可修复缺失或已变化正文，不依赖失效缓存');

  const newer = notes.map(note => note.id === project.id ? { ...note, content: note.content + '\n中断恢复', updatedAt: '2026-10-16T01:00:00Z', flowSummary: '恢复的新总结' } : note);
  await assert.rejects(saveVaultSnapshot(vault, states, newer, async (file, text) => {
    if (file.endsWith('metadata.json')) throw Error('synthetic crash');
    return atomicWriteTextFile(file, text);
  }), /synthetic crash/);
  assert.ok(await fs.readFile(path.join(states, 'vault-pending-snapshot.json'), 'utf8'));
  await recoverVaultSnapshot(vault, states);
  assert.equal(await fs.readFile(path.join(vault, 'notes', 'project.md'), 'utf8'), newer[0].content);
  assert.equal(deserializeUserStateFile(await fs.readFile(path.join(states, 'user-state.json'), 'utf8')).project.flowSummary, '恢复的新总结');
  await assert.rejects(fs.readFile(path.join(states, 'vault-pending-snapshot.json')), { code: 'ENOENT' });
  await recoverVaultSnapshot(vault, states); notes = newer;
  pass('中途写入失败仍报错、保留完整旧版兼容journal，恢复幂等，不跳过未完成文件');

  const position = { revisionId: 'rev-1', blockAnchor: 'chapter-2', scrollTop: 610, lastReadAt: '2026-10-16T02:00:00Z' };
  const beforeMetadata = await fs.readFile(path.join(vault, 'metadata.json'), 'utf8');
  const beforeBody = await fs.readFile(path.join(vault, 'notes', 'project.md'), 'utf8');
  files = [];
  await saveTextbookReadingPositions(vault, states, [{ noteId: 'project', state: { ...position, content: '禁止覆盖正文' } }], undefined, writer);
  assert.deepEqual(files, ['user-state.json']);
  let personal = deserializeUserStateFile(await fs.readFile(path.join(states, 'user-state.json'), 'utf8'));
  assert.deepEqual(personal.project.textbookReadingState, position);
  assert.deepEqual(personal.project.questions, project.questions);
  assert.equal(personal.project.flowSummary, '恢复的新总结');
  assert.equal(await fs.readFile(path.join(vault, 'metadata.json'), 'utf8'), beforeMetadata);
  assert.equal(await fs.readFile(path.join(vault, 'notes', 'project.md'), 'utf8'), beforeBody);
  files = []; await saveTextbookReadingPositions(vault, states, [{ noteId: 'project', state: position }], undefined, writer);
  assert.deepEqual(files, []);
  await saveTextbookReadingPositions(vault, states, [{ noteId: 'project', state: { ...position, scrollTop: 12, lastReadAt: session.startedAt } }], undefined, writer);
  assert.deepEqual(files, []);
  pass('阅读位置仅原子写一个个人文件；保留问题/旧复盘/正文/目录，重复和迟到旧进度零写入');

  for (const input of [
    [{ noteId: 'project', state: { ...position, revisionId: 'old' } }],
    [{ noteId: 'deleted', state: position }],
    [{ noteId: 'project', state: { ...position, scrollTop: -1 } }],
    [{ noteId: 'project', state: { ...position, lastReadAt: 'invalid' } }],
    [{ noteId: 'project', state: position }, { noteId: 'project', state: position }],
  ]) await assert.rejects(saveTextbookReadingPositions(vault, states, input, undefined, writer));
  await assert.rejects(saveTextbookReadingPositions(vault, states, [{ noteId: 'project', state: position }], () => false, writer));
  assert.deepEqual(files, []);
  await assert.rejects(saveTextbookReadingPositions(vault, states, [{ noteId: 'project', state: { ...position, scrollTop: 999 } }], undefined,
    async () => { throw Error('atomic write failed'); }), /atomic write failed/);
  assert.deepEqual(deserializeUserStateFile(await fs.readFile(path.join(states, 'user-state.json'), 'utf8')).project.textbookReadingState, position);
  pass('无效/重复/过期修订/已删项目/旧环境请求拒绝，原子保存失败不伪装成功或抹去旧记录');

  const stateFile = path.join(states, 'user-state.json'), validState = await fs.readFile(stateFile, 'utf8');
  await fs.writeFile(stateFile, '{synthetic-corrupt');
  await assert.rejects(saveTextbookReadingPositions(vault, states, [{ noteId: 'project', state: position }], undefined, writer));
  assert.equal(await fs.readFile(stateFile, 'utf8'), '{synthetic-corrupt'); await fs.writeFile(stateFile, validState);
  pass('损坏个人文件不回退成空库，不覆盖原文');

  // Recover an interrupted full save before patching progress; a later restart
  // must not replay the old journal over the newly acknowledged reading state.
  await fs.writeFile(path.join(states, 'vault-pending-snapshot.json'), JSON.stringify({ version: 1, notes }));
  await saveTextbookReadingPositions(vault, states, [{ noteId: 'project', state: position }]);
  await recoverVaultSnapshot(vault, states);
  assert.deepEqual(deserializeUserStateFile(await fs.readFile(stateFile, 'utf8')).project.textbookReadingState, position);
  pass('轻量阅读保存先恢复既有journal，重启不会用旧快照抹去已确认的新进度');

  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve };
  }
  const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  {
    const hold = deferred(), queue = { current: hold.promise };
    let latest = 1; const writes: number[] = [];
    const save = async (value: number) => { writes.push(value); };
    const a = enqueueLatestNotesSave(queue, () => latest, save);
    latest = 2; const b = enqueueLatestNotesSave(queue, () => latest, save);
    assert.equal(a, b); hold.resolve(); await Promise.all([a, b]); assert.deepEqual(writes, [2]);
    const hold2 = deferred(); queue.current = hold2.promise;
    latest = 3; const c = enqueueLatestNotesSave(queue, () => latest, save);
    const mutation = enqueueLearningWrite(queue, async () => { writes.push(4); latest = 5; });
    const d = enqueueLatestNotesSave(queue, () => latest, save);
    assert.notEqual(c, d); hold2.resolve(); await Promise.all([c, mutation, d]); assert.deepEqual(writes, [2, 3, 4, 5]);
    await assert.rejects(enqueueLatestNotesSave(queue, () => latest, async () => { throw Error('save failed'); }));
    await enqueueLatestNotesSave(queue, () => 6, save); assert.equal(writes.at(-1), 6);
    pass('连续排队自动保存合并为最新一次；不跨复盘/教材发布边界、不吞失败，后续可重试');
  }

  // Extract and execute the real App handlers with memory-only dependencies.
  const ast = ts.createSourceFile('App.tsx', readFileSync('src/App.tsx', 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  function handler(name: string, env: Record<string, unknown>): any {
    let expression: ts.Expression | undefined;
    const visit = (node: ts.Node) => { if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) expression = node.initializer; else ts.forEachChild(node, visit); };
    visit(ast); assert.ok(expression, name);
    if (ts.isCallExpression(expression)) expression = expression.arguments[0];
    const compiled = ts.transpileModule(`return (${expression.getText(ast)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    return new Function(...Object.keys(env), compiled)(...Object.values(env));
  }
  function app() {
    let view = 'flow', state = 'saved', failReading = false;
    let readingHold: ReturnType<typeof deferred> | undefined;
    const calls = { full: [] as NoteItem[][], reading: [] as unknown[] };
    const timers = new Map<number, { callback: () => void; delay: number }>(); let timerId = 0;
    const env: Record<string, any> = {
      notesRef: { current: [structuredClone(project)] }, publishedNotesRef: { current: [structuredClone(project)] }, shouldPublishNoteSnapshot,
      pendingNotesRef: { current: null }, readingOnlySaveRef: { current: null as ReadingOnlySave | null },
      personalOnlySaveRef: { current: null }, isPersonalOnlyNoteChange, trackPersonalOnlySave, savePersonalStateOnly, acknowledgePersonalSave,
      learningWriteQueueRef: { current: Promise.resolve() }, noteSaveRevisionRef: { current: 0 }, saveTimerRef: { current: null },
      enqueueLatestNotesSave, enqueueLearningWrite, acknowledgedSaveState, trackReadingOnlySave, saveReadingPositionOnly, patchTextbookReadingPosition, NOTE_AUTOSAVE_IDLE_MS,
      saveAllNotesToStorage: async (value: NoteItem[]) => { calls.full.push(structuredClone(value)); },
      setNotes: () => {}, recalculateBacklinks: (value: NoteItem[]) => value,
      prepareNotesMetadata: async (value: NoteItem[]) => value,
      setNoteSaveState: (value: string) => { state = value; }, setNoteSaveError() {}, console: { error: () => {} },
      setTimeout: (callback: () => void, delay: number) => { timers.set(++timerId, { callback, delay }); return timerId; },
      clearTimeout: (id: number) => { timers.delete(id); },
    };
    Object.assign(globalThis, { window: { electronAPI: { vault: { saveReadingPositions: async (updates: unknown[]) => {
      calls.reading.push(structuredClone(updates)); if (readingHold) await readingHold.promise;
      if (failReading) throw Error('reading save failed');
    } } } } });
    env.flushSave = handler('flushSave', env);
    env.persistLearningMutation = handler('persistLearningMutation', { ...env, indexNote: async () => {} });
    const reading = handler('handleTextbookReadingPosition', env);
    const exit = handler('handleExitFlowMode', { ...env, flowReviewAdmission, saveFlowReviewRecord, captureRestatementCognition: async () => {},
      confirmNoteNavigation, requestNoteNavigation: (commit: () => void) => commit(), allowWorkspaceNavigation: () => true,
      getLearningCompletionTarget: () => null, flowTaskBindingRef: { current: null }, setFlowCompletionPrompt: () => {},
      flowSessionRef: { current: null }, setFlowReviewSession: () => {}, recordStudyDuration: async () => {},
      setFlowSummaryText: () => {}, setFlowQuestions: () => {}, flowEpisodeIdRef: { current: null }, saveLearningEpisode: async () => {},
      setActiveNoteId: () => {}, setCurrentView: (value: string) => { view = value; }, recordAgentWorkspaceEvent: () => {},
      setFlowSpeakingContent: () => {}, setIsSelectionOpen: () => {}, knowledgeDiscovery: { start: () => assert.fail('No model calls') },
    });
    return { env, calls, timers, reading, exit, view: () => view, state: () => state,
      fail: (value: boolean) => { failReading = value; }, hold: (value: ReturnType<typeof deferred>) => { readingHold = value; } };
  }
  {
    const a = app(); a.reading('project', 'rev-1', { scrollTop: 10 }); a.reading('project', 'rev-1', { scrollTop: 20 });
    assert.equal(a.timers.size, 1); assert.equal([...a.timers.values()][0].delay, 2000);
    await a.exit(session); assert.equal(a.view(), 'editor'); assert.equal(a.calls.full.length, 0); assert.equal(a.calls.reading.length, 1);
    assert.equal((a.calls.reading[0] as any)[0].state.scrollTop, 20);
    assert.equal(a.env.notesRef.current[0].learningReviewRecords, undefined); assert.equal(a.timers.size, 0);
    pass('真实App：只看教材后退出只保存最终阅读位置，不建复盘块、不全库保存、不留重复定时器');
  }
  {
    const a = app(); a.reading('project', 'rev-1', { scrollTop: 25 });
    const hold = deferred(); a.env.learningWriteQueueRef.current = hold.promise;
    const exiting = a.exit({ ...session, restateText: '我的真实复述' });
    const redundant = a.env.flushSave(a.env.notesRef.current); await tick();
    assert.equal(a.view(), 'flow'); assert.equal(a.timers.size, 0); hold.resolve(); await Promise.all([exiting, redundant]);
    assert.equal(a.calls.full.length, 1); assert.equal(a.calls.reading.length, 0); assert.equal(a.view(), 'editor');
    assert.equal(a.calls.full[0][0].textbookReadingState?.scrollTop, 25); assert.equal(a.calls.full[0][0].learningReviewRecords?.length, 1);
    pass('真实App：有复述时与最新位置合并保存一次；退出等待回执，尾部冗余flush跳过');
  }
  {
    const a = app(); a.env.notesRef.current = [{ ...project, content: '尚未保存的手动编辑' }];
    a.env.pendingNotesRef.current = a.env.notesRef.current;
    a.reading('project', 'rev-1', { scrollTop: 30 }); await a.exit(session);
    assert.equal(a.calls.reading.length, 0); assert.equal(a.calls.full.length, 1); assert.equal(a.calls.full[0][0].content, '尚未保存的手动编辑');
    pass('有其他未保存编辑时自动回退完整快照，轻量阅读保存不能冒充正文保存成功');
  }
  {
    const a = app(); Object.assign(globalThis, { window: { electronAPI: { vault: {} } } });
    a.reading('project', 'rev-1', { scrollTop: 35 }); await a.exit(session);
    assert.equal(a.calls.full.length, 1); assert.equal(a.calls.reading.length, 0); assert.equal(a.view(), 'editor');
    assert.equal(a.calls.full[0][0].textbookReadingState?.scrollTop, 35);
    pass('浏览器或旧预加载缺少新接口时回退已验证的快照保存，不丢阅读位置');
  }
  {
    const a = app(); a.reading('project', 'rev-1', { scrollTop: 40 }); a.fail(true);
    await assert.rejects(a.exit(session), /reading save failed/);
    assert.equal(a.view(), 'flow'); assert.equal(a.state(), 'error'); assert.ok(a.env.pendingNotesRef.current);
    a.fail(false); await a.exit(session); assert.equal(a.view(), 'editor'); assert.equal(a.env.pendingNotesRef.current, null);
    pass('阅读保存失败留在心流页并保留可重试最新位置，重试成功才退出');
  }
  {
    const a = app(), hold = deferred(); a.hold(hold);
    a.reading('project', 'rev-1', { scrollTop: 50 }); const saving = a.env.flushSave(a.env.notesRef.current); await tick();
    a.reading('project', 'rev-1', { scrollTop: 60 }); hold.resolve(); await saving;
    assert.equal(a.state(), 'saved', 'reading position does not dirty visible source content'); assert.ok(a.env.pendingNotesRef.current, 'the newer position still protects exit until persisted');
    await a.env.flushSave(a.env.notesRef.current); assert.equal(a.calls.full.length, 0);
    assert.equal((a.calls.reading.at(-1) as any)[0].state.scrollTop, 60); assert.equal(a.state(), 'saved');
    pass('保存期间继续滚动保留新位置，旧回执不能清掉新修改，下一次仍走轻量保存');
  }
  const main = readFileSync('src/electron/main.ts', 'utf8');
  const readingHandler = main.slice(main.indexOf("ipcMain.handle('vault:save-reading-positions'"), main.indexOf("ipcMain.handle('vault:save'"));
  assert.ok(readingHandler.includes('referenceNoteSnapshotSaves.run'));
  for (const forbidden of ['loadMergedNotes', 'noteRagIndexNotes', 'syncTextbookReferenceNotes', 'observeNoteSnapshot']) assert.ok(!readingHandler.includes(forbidden));
  assert.ok(readFileSync('src/electron/preload.ts', 'utf8').includes("ipcRenderer.invoke('vault:save-reading-positions', updates)"));
  pass('轻量IPC接线使用同一有序队列；不读取整库正文、不观察/重建任何RAG来源');

  const mainAst = ts.createSourceFile('main.ts', main, ts.ScriptTarget.ES2022, true);
  let ipcExpression: ts.Expression | undefined;
  const visitIpc = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(mainAst) === 'ipcMain.handle'
      && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'vault:save-reading-positions') ipcExpression = node.arguments[1];
    ts.forEachChild(node, visitIpc);
  };
  visitIpc(mainAst); assert.ok(ipcExpression);
  {
    let currentRoot = vault, notifications = 0;
    const queue = createArgumentReferenceNoteSnapshotQueue(), hold = deferred();
    const blocker = queue.run(() => hold.promise);
    const env = { referenceEnvironmentSuspended: false, referenceSourceWriteEpoch: 0, structuredClone,
      getVaultRoot: () => currentRoot, getUserStateDir: () => states, referenceNoteSnapshotSaves: queue,
      saveTextbookReadingPositions, onWriteCommitted: () => { notifications++; },
    };
    const compiled = ts.transpileModule(`return (${ipcExpression.getText(mainAst)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const save = new Function(...Object.keys(env), compiled)(...Object.values(env));
    const payload = [{ noteId: 'project', state: { ...position, scrollTop: 501, lastReadAt: '2026-10-16T03:00:00Z' } }];
    const queued = save({}, payload); payload[0].state.scrollTop = 902;
    hold.resolve(); await Promise.all([blocker, queued]);
    assert.equal(deserializeUserStateFile(await fs.readFile(stateFile, 'utf8')).project.textbookReadingState?.scrollTop, 501);
    assert.equal(notifications, 1);
    const hold2 = deferred(), blocker2 = queue.run(() => hold2.promise);
    const obsolete = save({}, payload); currentRoot = path.join(temp, 'obsolete-root');
    hold2.resolve(); await assert.rejects(obsolete, /environment_changed/); await blocker2;
    assert.equal(notifications, 1);
    assert.equal(deserializeUserStateFile(await fs.readFile(stateFile, 'utf8')).project.textbookReadingState?.scrollTop, 501);
    pass('真实主进程IPC处理器→有序队列→临时磁盘：捕获调用快照，排队期间换根拒绝，成功才发保存通知');
  }
  console.log(`${groups} flow save performance groups passed; synthetic 253-note disk and real handler fixtures only.`);
} finally {
  assert.equal(path.dirname(temp), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temp).startsWith('loginote-flow-save-'));
  await fs.rm(temp, { recursive: true, force: true });
}
