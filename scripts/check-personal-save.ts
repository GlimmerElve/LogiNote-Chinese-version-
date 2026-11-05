import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import ts from 'typescript';
import type { NoteItem, FlowSession } from '../src/types';
import { savePersonalNoteState } from '../src/electron/personalNoteSave';
import { saveVaultSnapshot, recoverVaultSnapshot } from '../src/electron/vaultSnapshot';
import { saveTextbookReadingPositions } from '../src/electron/textbookReadingSave';
import { atomicWriteTextFile } from '../src/electron/atomicWrite';
import { personalNotePatches, isPersonalOnlyNoteChange } from '../src/services/personalNoteState';
import { trackPersonalOnlySave, savePersonalStateOnly, acknowledgePersonalSave, type PersonalOnlySave } from '../src/services/ui/personalNoteSave';
import { trackReadingOnlySave, saveReadingPositionOnly } from '../src/services/ui/readingPositionSave';
import { patchTextbookReadingPosition, retainLatestTextbookReadingPosition } from '../src/services/textbook/readingState';
import { enqueueLearningWrite, enqueueLatestNotesSave } from '../src/services/ui/learningWriteQueue';
import { acknowledgedSaveState } from '../src/services/ui/saveFeedback';
import { NOTE_AUTOSAVE_IDLE_MS } from '../src/services/ui/noteAutosave';
import { createOptimisticNoteDeletionState, stageOptimisticNoteDeletion, acknowledgeOptimisticNoteDeletion,
  rollbackOptimisticNoteDeletions, rejectLateDeletedNoteUpdate } from '../src/services/ui/optimisticNoteDeletion';
import { saveFlowReviewRecord, patchLearningReviewRecord, finishFlowReviewRecord } from '../src/services/textbook/reviewRecordStore';
import { deserializeUserStateFile } from '../src/services/userStateService';
import { commitPlanWrite } from '../src/services/ui/planWrite';
import { prepareReviewExitOutcome } from '../src/services/ui/reviewExitWrite';
import { applyWorkspaceNoteChange, prepareNoteEdit } from '../src/services/agent/workspaceOperations';
import { commitAgentWorkspaceChange, createAgentOperationStore, prepareOperationUndo } from '../src/services/agent/operationStore';
import { createArgumentReferenceNoteSnapshotQueue } from '../src/electron/rag/argumentReferenceNoteObservations';

globalThis.fetch = async () => assert.fail('No network/model in personal save checks');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'loginote-personal-save-'));
const vault = path.join(temp, 'vault'), stateDir = path.join(temp, 'user-state');
const journal = path.join(stateDir, 'vault-pending-snapshot.json');
let groups = 0;
const pass = (label: string) => { groups++; console.log(`PASS ${label}`); };
const basic = (id: string): NoteItem => ({ id, noteType: 'knowledge', title: id, content: `# ${id}\n\n${'合成资料段落。'.repeat(300)}`,
  tags: [], aliases: [], links: [], backlinks: [], dueDates: [], createdAt: '2026-10-16T00:00:00Z', updatedAt: '2026-10-16T00:00:00Z' });
let notes = Array.from({ length: 253 }, (_, index) => basic(`note-${index}`));
const stateText = () => fs.readFile(path.join(stateDir, 'user-state.json'), 'utf8');
const readState = async () => deserializeUserStateFile(await stateText());
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; };
const tick = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };
try {
  await saveVaultSnapshot(vault, stateDir, notes);
  const originals = { metadata: await fs.readFile(path.join(vault, 'metadata.json'), 'utf8'), body: await fs.readFile(path.join(vault, 'notes', 'note-0.md'), 'utf8') };
  const personal = notes.map((note, index) => index === 0 ? { ...note, pinned: true, isFavorite: true } : note);
  const patches = personalNotePatches(notes, personal)!;
  const written: string[] = [];
  const writer = async (file: string, text: string) => { written.push(path.basename(file)); return atomicWriteTextFile(file, text); };
  await savePersonalNoteState(vault, stateDir, patches, undefined, writer);
  assert.deepEqual(written, ['user-state.json']); assert.equal((await readState())['note-0'].pinned, true);
  assert.equal(await fs.readFile(path.join(vault, 'metadata.json'), 'utf8'), originals.metadata);
  assert.equal(await fs.readFile(path.join(vault, 'notes', 'note-0.md'), 'utf8'), originals.body);
  written.length = 0; await savePersonalNoteState(vault, stateDir, patches, undefined, writer); assert.equal(written.length, 0);
  pass('253篇库中收藏/置顶只写1个个人文件，正文/目录不变，同补丁重试幂等且零重复写入');

  const withMastery = notes.map((note, index) => index === 0 ? { ...note, dsrState: { difficulty: 5, stability: 2, lastReviewedAt: null, reviewCount: 1, consecutiveCorrect: 1, consecutiveWrong: 0, conceptMastery: 55 } } : note);
  await savePersonalNoteState(vault, stateDir, personalNotePatches(notes, withMastery));
  assert.equal((await readState())['note-0'].pinned, true); assert.equal((await readState())['note-0'].dsrState?.conceptMastery, 55);
  const conflict = structuredClone(withMastery); conflict[0].dsrState!.conceptMastery = 70;
  await assert.rejects(savePersonalNoteState(vault, stateDir, personalNotePatches(notes, conflict)), /已被更新/);
  assert.equal((await readState())['note-0'].dsrState?.conceptMastery, 55);
  const unpinned = personal.map((note, index) => index === 0 ? { ...note, pinned: undefined } : note);
  await savePersonalNoteState(vault, stateDir, personalNotePatches(personal, unpinned));
  assert.equal((await readState())['note-0'].pinned, undefined); assert.equal((await readState())['note-0'].isFavorite, true);
  assert.equal((await readState())['note-0'].dsrState?.conceptMastery, 55);
  pass('不同个人字段独立合并；同字段陈旧补丁拒绝覆盖，显式删除只删除指定字段');

  const beforeFailure = await stateText();
  for (const invalid of [
    [{ ...patches[0], changes: [{ ...patches[0].changes[0], field: 'content' }] }],
    [{ ...patches[0], changes: [{ ...patches[0].changes[0], field: 'updatedAt' }] }],
    [{ ...patches[0], noteId: '../outside' }], [{ ...patches[0], noteType: 'project' }], [patches[0], patches[0]],
    [{ ...patches[0], changes: [patches[0].changes[0], patches[0].changes[0]] }],
    [{ ...patches[0], scope: 'library' }],
  ]) await assert.rejects(savePersonalNoteState(vault, stateDir, invalid));
  await assert.rejects(savePersonalNoteState(vault, stateDir, patches, () => false));
  await assert.rejects(savePersonalNoteState(vault, stateDir, patches, undefined, async () => { throw Error('atomic failure'); }), /atomic failure/);
  assert.equal(await stateText(), beforeFailure);
  await fs.writeFile(path.join(stateDir, 'user-state.json'), '{synthetic-invalid');
  await assert.rejects(savePersonalNoteState(vault, stateDir, patches)); assert.equal(await stateText(), '{synthetic-invalid');
  await fs.writeFile(path.join(stateDir, 'user-state.json'), beforeFailure);
  pass('字段越权、重复、错目标、旧环境、坏文件及写入故障拒绝；不冒充成功、不覆盖旧字节');

  // A body-only update journals only that body, not 252 unrelated textbooks.
  const bodyChanged = notes.map((note, index) => index === 0 ? { ...note, content: note.content + '\n变更正文' } : note);
  await assert.rejects(saveVaultSnapshot(vault, stateDir, bodyChanged, async (file, text) => {
    if (file.endsWith('note-0.md')) throw Error('body crash'); return atomicWriteTextFile(file, text);
  }));
  const delta = JSON.parse(await fs.readFile(journal, 'utf8'));
  assert.equal(delta.version, 2); assert.equal(delta.notes, undefined);
  assert.ok(delta.files.some((item: any) => item.target === 'body' && item.noteId === 'note-0'));
  assert.ok(!delta.files.some((item: any) => item.target === 'body' && item.noteId === 'note-1'));
  assert.ok(!JSON.stringify(delta).includes(notes[1].content));
  assert.ok(JSON.stringify(delta).length < JSON.stringify({ version: 1, notes }).length / 20);
  await recoverVaultSnapshot(vault, stateDir);
  assert.equal(await fs.readFile(path.join(vault, 'notes', 'note-0.md'), 'utf8'), bodyChanged[0].content);
  await recoverVaultSnapshot(vault, stateDir); notes = bodyChanged;
  pass('V2恢复日志只含变化文件，不带未变教材；合成库日志小于旧完整快照的1/20，中断恢复幂等');

  const badJournals = [
    { version: 2, files: [{ target: 'body', noteId: '../outside', text: 'bad' }] },
    { version: 2, files: [{ target: 'body', noteId: 'note-0', text: 'must not write' }, { target: 'arbitrary', path: 'outside', text: 'bad' }] },
    { version: 2, files: [{ target: 'body', noteId: 'note-0', text: 'first' }, { target: 'body', noteId: 'note-0', text: 'duplicate' }] },
    { version: 2, files: [{ target: 'metadata', text: '{}' }] },
  ];
  for (const value of badJournals) {
    await fs.writeFile(journal, JSON.stringify(value)); await assert.rejects(recoverVaultSnapshot(vault, stateDir));
    assert.equal(await fs.readFile(path.join(vault, 'notes', 'note-0.md'), 'utf8'), bodyChanged[0].content);
  }
  await fs.writeFile(journal, JSON.stringify({ version: 1, notes })); await recoverVaultSnapshot(vault, stateDir);
  await assert.rejects(fs.readFile(journal), { code: 'ENOENT' });
  pass('V2完整校验后才重放，越界/重复/未知目标不部分落盘；旧版V1完整日志仍可恢复');

  const appAst = ts.createSourceFile('App.tsx', readFileSync('src/App.tsx', 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  function handler(name: string, env: Record<string, unknown>): any {
    let value: ts.Expression | undefined;
    const visit = (node: ts.Node) => { if (ts.isVariableDeclaration(node) && node.name.getText(appAst) === name) value = node.initializer; else ts.forEachChild(node, visit); };
    visit(appAst); assert.ok(value, name); if (ts.isCallExpression(value)) value = value.arguments[0];
    const js = ts.transpileModule(`return (${value.getText(appAst)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    return new Function(...Object.keys(env), js)(...Object.values(env));
  }
  let serial = 0;
  async function app() {
    const directory = path.join(temp, `app-${++serial}`), appVault = path.join(directory, 'vault'), appState = path.join(directory, 'state');
    const reviewSession: FlowSession = { id: 'review', noteId: 'project', noteTitle: 'project', startedAt: '2026-10-16T00:00:00Z',
      endedAt: '2026-10-16T01:00:00Z', durationSeconds: 60, reviewIntervalMinutes: 20, restateText: '我对条件进行了核对', summary: '', analyze: false };
    const project = saveFlowReviewRecord({ ...basic('project'), noteType: 'project' }, reviewSession, 'pending_analysis', true);
    const initial = [project, basic('knowledge')]; await saveVaultSnapshot(appVault, appState, initial);
    const counts = { full: 0, personal: 0, index: 0, recalc: 0, deletedIndex: 0, cognition: 0 };
    let saveState = 'saved', fail = false, ioHold: ReturnType<typeof deferred> | undefined;
    const timers = new Map<number, () => void>(); let timerId = 0;
    const env: Record<string, any> = {
      notesRef: { current: initial }, notes: initial, pendingNotesRef: { current: null }, readingOnlySaveRef: { current: null }, personalOnlySaveRef: { current: null as PersonalOnlySave | null },
      learningWriteQueueRef: { current: Promise.resolve() }, noteSaveRevisionRef: { current: 0 }, saveTimerRef: { current: null },
      optimisticDeletionsRef: { current: createOptimisticNoteDeletionState() }, stageOptimisticNoteDeletion,
      acknowledgeOptimisticNoteDeletion, rollbackOptimisticNoteDeletions, rejectLateDeletedNoteUpdate,
      setPendingDeletionCount: () => {}, setRestoredDeletionCount: () => {},
      trackPersonalOnlySave, savePersonalStateOnly, acknowledgePersonalSave, isPersonalOnlyNoteChange, patchLearningReviewRecord, finishFlowReviewRecord,
      trackReadingOnlySave, saveReadingPositionOnly, patchTextbookReadingPosition, retainLatestTextbookReadingPosition, enqueueLearningWrite, enqueueLatestNotesSave, acknowledgedSaveState,
      commitPlanWrite, NOTE_AUTOSAVE_IDLE_MS,
      captureRestatementCognition: async () => { counts.cognition++; },
      personalNotePatches, applyWorkspaceNoteChange, assertNoPendingAgentPlanEditorDraft: () => {}, setActiveProjectContextId: () => {},
      setNoteSaveState: (value: string) => { saveState = value; }, setNotes: () => {},
      setNoteSaveError() {},
      indexNote: async () => { counts.index++; }, recalculateBacklinks: (value: NoteItem[]) => { counts.recalc++; return value; },
      prepareNotesMetadata: async (value: NoteItem[]) => value,
      adjustPlanAfterNoteUpdate: (value: NoteItem[]) => ({ notes: value }),
      setTimeout: (callback: () => void) => { timers.set(++timerId, callback); return timerId; }, clearTimeout: (id: number) => { timers.delete(id); },
      deleteNoteIndex: async () => { counts.deletedIndex++; }, setActiveNoteId: () => {}, setActiveNoteIdState: () => {}, activeNoteId: null,
      finishDeletedNoteIndexCleanup: async (ids: string[]) => { counts.deletedIndex += ids.length; },
      reportLearningSaveError: () => {}, console: { error() {}, warn() {} },
      saveAllNotesToStorage: async (value: NoteItem[]) => { counts.full++; if (ioHold) await ioHold.promise; if (fail) throw Error('synthetic failure'); await saveVaultSnapshot(appVault, appState, value); },
    };
    Object.assign(globalThis, { window: { electronAPI: { vault: {
      savePersonalState: async (patches: unknown) => { counts.personal++; if (ioHold) await ioHold.promise; if (fail) throw Error('synthetic failure'); await savePersonalNoteState(appVault, appState, patches); },
      saveReadingPositions: (updates: unknown) => saveTextbookReadingPositions(appVault, appState, updates),
    } } } });
    env.flushSave = handler('flushSave', env); env.handleUpdateNote = handler('handleUpdateNote', env);
    env.stageNoteDeletion = handler('stageNoteDeletion', env);
    env.persistLearningMutation = handler('persistLearningMutation', env);
    env.persistPlanMutation = handler('persistPlanMutation', env);
    let operations: unknown = null;
    const store = createAgentOperationStore({ read: async () => structuredClone(operations), write: async value => { operations = structuredClone(value); } });
    env.commitAgentWorkspaceChange = (change: any, deps: any) => commitAgentWorkspaceChange(change, { ...deps, store });
    const read = async () => deserializeUserStateFile(await fs.readFile(path.join(appState, 'user-state.json'), 'utf8'));
    return { env, counts, initial, reviewSession, timers, read, state: () => saveState, fail: (value: boolean) => { fail = value; }, hold: (value: ReturnType<typeof deferred>) => { ioHold = value; },
      patch: handler('handleLearningReviewPatch', env), favorite: handler('handleToggleFavorite', env), pin: handler('handleTogglePin', env),
      finish: handler('finishStoredFlowReview', env), remove: handler('handleDeleteNote', env),
      agentCommit: handler('commitAgentNoteChange', env), store,
    };
  }
  const event = { stopPropagation() {} };
  {
    const a = await app(); await a.patch('project', 'review', { expanded: true }); await a.patch('project', 'review', { expanded: false });
    await a.patch('project', 'review', { title: '用户修改标题', editedRestatement: '用户修改复述' });
    await a.finish(a.reviewSession, 'analyzed', undefined, '只保存分析状态');
    assert.equal(a.counts.full, 0); assert.equal(a.counts.personal, 4); assert.equal(a.counts.index, 0); assert.equal(a.counts.recalc, 0);
    assert.equal(a.counts.cognition, 1, 'only the changed user restatement syncs private cognition; layout/title/stage changes do not');
    const record = (await a.read()).project.learningReviewRecords![0];
    assert.equal(record.title, '用户修改标题'); assert.equal(record.editedRestatement, '用户修改复述'); assert.equal(record.status, 'analyzed');
    assert.equal(a.env.notesRef.current[0].updatedAt, a.initial[0].updatedAt);
    pass('真实App→真实磁盘：折叠/复述编辑/复盘阶段更新零整库提交、零回链重算、零事实RAG调用；仅复述编辑同步私人认知');
  }
  {
    const a = await app(); a.favorite('knowledge', event); a.pin('knowledge', event);
    const knowledge = a.env.notesRef.current[1];
    a.env.handleUpdateNote({ ...knowledge, dsrState: { difficulty: 5, stability: 2, lastReviewedAt: null, reviewCount: 1, consecutiveCorrect: 0, consecutiveWrong: 0, conceptMastery: 60 } });
    await a.env.flushSave(a.env.notesRef.current);
    assert.equal(a.counts.full, 0); assert.equal(a.counts.personal, 1); assert.equal(a.counts.recalc, 0); assert.equal(a.counts.index, 0);
    const state = (await a.read()).knowledge;
    assert.equal(state.isFavorite, true); assert.equal(state.pinned, true); assert.equal(state.dsrState?.conceptMastery, 60);
    assert.equal(a.env.notesRef.current[1].updatedAt, knowledge.updatedAt);
    pass('真实App：收藏/置顶/掌握度合并成1次轻量写入，不改正文更新时间、不重算全库');
  }
  {
    const a = await app();
    await a.env.persistPlanMutation((current: NoteItem[]) => prepareReviewExitOutcome(current, {
      noteId: 'knowledge', noteTitle: 'knowledge', analysis: null,
      segmentMastery: [{ name: 'knowledge', level: 'basic', conceptDelta: 5, judgmentDelta: 3, reasoningDelta: 2 } as any],
    }, '2026-10-16T02:00:00Z'));
    assert.equal(a.counts.full, 0); assert.equal(a.counts.personal, 1); assert.equal(a.counts.index, 0);
    assert.equal((await a.read()).knowledge?.dsrState?.reviewCount, undefined);
    assert.equal(a.env.notesRef.current[1].dsrState, undefined);
    pass('真实复习结束适配器仍走个人通道；只有旧分数增量而无可信评价凭据时不写掌握度或复习次数');
  }
  {
    const a = await app();
    const change = prepareNoteEdit(a.env.notesRef.current, { noteId: 'knowledge', pinned: true, isFavorite: true });
    const result = await a.agentCommit(change);
    assert.equal(a.counts.full, 0); assert.equal(a.counts.personal, 1); assert.equal(a.counts.index, 0);
    const record = await a.store.get(result.operationId);
    await a.agentCommit(prepareOperationUndo(a.env.notesRef.current, record), record.id);
    assert.equal(a.counts.full, 0); assert.equal(a.counts.personal, 2);
    assert.equal((await a.read()).knowledge.pinned, undefined);
    assert.equal((await a.store.get(record.id)).status, 'undone');
    pass('Agent收藏/置顶及撤销同样走轻量写入，原操作记录/确认与撤销保护完整保留');
  }
  {
    const a = await app();
    const external = a.initial.map(note => note.id === 'knowledge' ? { ...note, dsrState: { difficulty: 5, stability: 2, lastReviewedAt: null, reviewCount: 3, consecutiveCorrect: 0, consecutiveWrong: 0, conceptMastery: 70 } } : note);
    // Apply another writer's newer mastery without changing this renderer's baseline.
    const api = (window as any).electronAPI.vault;
    await api.savePersonalState(personalNotePatches(a.initial, external)); a.counts.personal = 0;
    await assert.rejects(a.env.persistPlanMutation((current: NoteItem[]) => ({ notes: current.map(note => note.id === 'knowledge'
      ? { ...note, dsrState: { ...external[1].dsrState!, conceptMastery: 55 } } : note) })), /已被更新/);
    assert.equal(a.counts.full, 0); assert.equal((await a.read()).knowledge.dsrState?.conceptMastery, 70);
    assert.equal(a.state(), 'error'); assert.ok(a.env.pendingNotesRef.current);
    pass('批量个人补丁冲突不触发完整快照补偿，不能绕过CAS覆盖磁盘上的新掌握度');
  }
  {
    const a = await app(), hold = deferred(); a.hold(hold);
    a.favorite('knowledge', event); const first = a.env.flushSave(a.env.notesRef.current); await tick();
    assert.equal(a.counts.personal, 1); a.pin('knowledge', event); hold.resolve(); await first;
    assert.equal(a.state(), 'pending'); await a.env.flushSave(a.env.notesRef.current);
    assert.equal(a.counts.full, 0); assert.equal(a.counts.personal, 2); assert.equal((await a.read()).knowledge.pinned, true);
    assert.equal(a.state(), 'saved'); assert.equal(a.env.pendingNotesRef.current, null);
    pass('轻量保存途中继续修改：旧回执仅推进基线，新补丁不丢失、不因自身旧基线冲突或退回整库');
  }
  {
    const a = await app(); a.env.handleUpdateNote({ ...a.env.notesRef.current[1], content: '未保存正文' });
    await a.patch('project', 'review', { expanded: true });
    assert.equal(a.counts.full, 1); assert.equal(a.counts.personal, 0);
    assert.equal(a.env.notesRef.current[1].content, '未保存正文');
    pass('有正文草稿时不以个人保存冒充全保存；一次必要快照同时保全正文和折叠状态');
  }
  {
    const a = await app(); a.fail(true); await assert.rejects(a.patch('project', 'review', { expanded: true }), /synthetic failure/);
    assert.equal(a.state(), 'error'); assert.ok(a.env.pendingNotesRef.current); assert.equal(a.counts.full, 0);
    a.fail(false); await a.env.flushSave(a.env.notesRef.current);
    assert.equal((await a.read()).project.learningReviewRecords![0].expanded, true); assert.equal(a.state(), 'saved');
    pass('失败保留个人草稿与重试基线，再试仍走轻量通道，确认落盘后才显示成功');
  }
  {
    const a = await app(), hold = deferred(); a.hold(hold); a.remove('knowledge', event); await tick();
    assert.equal(a.env.notesRef.current.length, 1); assert.equal(a.counts.deletedIndex, 0);
    for (const [id, timer] of a.timers) { a.timers.delete(id); timer(); }
    hold.resolve(); await a.env.learningWriteQueueRef.current;
    assert.equal(a.env.notesRef.current.length, 1); assert.equal(a.counts.deletedIndex, 1);
    const b = await app(), hold2 = deferred(); b.hold(hold2); b.remove('knowledge', event); await tick();
    for (const [id, timer] of b.timers) { b.timers.delete(id); timer(); }
    await tick();
    b.env.notesRef.current = b.env.notesRef.current.map((note: NoteItem) => note.id === 'project' ? { ...note, content: '保存中新增的编辑' } : note);
    b.env.pendingNotesRef.current = b.env.notesRef.current; b.env.noteSaveRevisionRef.current++;
    hold2.resolve(); await b.env.learningWriteQueueRef.current;
    assert.equal(b.env.notesRef.current.length, 1); assert.equal(b.counts.full, 1); assert.equal(b.counts.deletedIndex, 1);
    assert.equal(b.env.notesRef.current[0].content, '保存中新增的编辑'); assert.ok(b.env.pendingNotesRef.current);
    const c = await app(); c.fail(true); c.remove('knowledge', event); await tick();
    for (const [id, timer] of c.timers) { c.timers.delete(id); timer(); }
    await assert.rejects(c.env.learningWriteQueueRef.current);
    assert.equal(c.env.notesRef.current.length, 2); assert.equal(c.state(), 'error'); assert.ok(c.env.pendingNotesRef.current);
    pass('真实删除入口先移除后排队落盘；新编辑仍保留待保存，失败只恢复待删笔记且不删索引');
  }

  // Audit every remaining full-save call in App, not only one keyword window.
  const allowed = new Set(['flushSave', 'handleStormUpdateNote', 'persistLearningMutation', 'stageNoteDeletion', 'commitAgentNoteChange', 'recoverNoteDrafts']);
  const fullCalls: string[] = [];
  const audit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(appAst) === 'saveAllNotesToStorage') {
      let parent: ts.Node | undefined = node.parent, owner = '';
      while (parent) { if (ts.isVariableDeclaration(parent)) { owner = parent.name.getText(appAst); break; } parent = parent.parent; }
      assert.ok(allowed.has(owner), `uncontrolled full save in ${owner}`); fullCalls.push(owner);
    }
    ts.forEachChild(node, audit);
  }; audit(appAst); assert.ok(fullCalls.length > 0);
  const text = appAst.text;
  for (const name of ['applyTrustedAutoResources(current', 'appendProjectStudyTasks(current', 'appendProjectStudyTaskBatch(current', 'buildPlanDraftMutation(current', 'buildResourceDraftMutation(current']) assert.ok(text.includes(name));
  const main = readFileSync('src/electron/main.ts', 'utf8');
  const block = main.slice(main.indexOf("ipcMain.handle('vault:save-personal-state'"), main.indexOf("ipcMain.handle('vault:get-root'"));
  for (const forbidden of ['loadMergedNotes', 'noteRagIndexNotes', 'observeNoteSnapshot', 'syncTextbookReferenceNotes', 'syncSavedFlowReviewNotes']) assert.ok(!block.includes(forbidden));
  assert.ok(block.includes('referenceNoteSnapshotSaves.run'));
  pass('全部剩余整库调用均归属受控保存/删除队列；资源和Agent准备在最新快照上，个人IPC不触发任何索引');

  const mainAst = ts.createSourceFile('main.ts', main, ts.ScriptTarget.ES2022, true);
  let ipc: ts.Expression | undefined;
  const findIpc = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(mainAst) === 'ipcMain.handle'
      && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'vault:save-personal-state') ipc = node.arguments[1];
    ts.forEachChild(node, findIpc);
  }; findIpc(mainAst); assert.ok(ipc);
  {
    let root = vault, notifications = 0;
    const queue = createArgumentReferenceNoteSnapshotQueue(), hold = deferred();
    const blocker = queue.run(() => hold.promise);
    const env = { referenceEnvironmentSuspended: false, referenceSourceWriteEpoch: 0, structuredClone,
      getVaultRoot: () => root, getUserStateDir: () => stateDir, referenceNoteSnapshotSaves: queue,
      savePersonalNoteState, onWriteCommitted: () => { notifications++; },
    };
    const save = new Function(...Object.keys(env), ts.transpileModule(`return (${ipc.getText(mainAst)});`,
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(env));
    const desired = notes.map((note, index) => index === 0 ? { ...note, pinned: true } : note);
    const payload = personalNotePatches(notes, desired)!;
    const saving = save({}, payload); payload[0].changes[0].after = { present: true, value: false };
    hold.resolve(); await Promise.all([blocker, saving]); assert.equal((await readState())['note-0'].pinned, true); assert.equal(notifications, 1);
    const hold2 = deferred(), blocker2 = queue.run(() => hold2.promise);
    const stale = save({}, payload); root = path.join(temp, 'another-root'); hold2.resolve();
    await assert.rejects(stale, /environment_changed/); await blocker2;
    assert.equal((await readState())['note-0'].pinned, true); assert.equal(notifications, 1);
    pass('真实个人IPC处理器→队列→磁盘：请求快照冻结，排队期间换库拒绝，成功才确认保存');
  }
  console.log(`${groups} personal/delta save groups passed; only synthetic temporary files and actual App handlers, no user vault/model/network.`);
} finally {
  assert.equal(path.dirname(temp), path.resolve(os.tmpdir())); assert.ok(path.basename(temp).startsWith('loginote-personal-save-'));
  await fs.rm(temp, { recursive: true, force: true });
}
