import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { confirmNoteNavigation, createNoteNavigationSave } from '../src/services/ui/noteAutosave';
import { flowReviewAdmission } from '../src/services/textbook/reviewAdmission';
import { saveFlowReviewRecord } from '../src/services/textbook/reviewRecordStore';
import type { NoteItem } from '../src/types';

function handler(file: string, name: string, env: Record<string, unknown>) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  let expression: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) expression = node.initializer;
    ts.forEachChild(node, visit);
  }; visit(source); assert.ok(expression, name);
  const js = ts.transpileModule(`return (${expression.getText(source)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(env), js)(...Object.values(env));
}
const tick = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
const deferred = () => { let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const note: NoteItem = { id: 'flow-exit-test', title: '合成退出验证', noteType: 'project', content: '# 学习材料',
  tags: [], links: [], backlinks: [], dueDates: [], createdAt: '2026-10-31T00:00:00Z', updatedAt: '2026-10-31T00:00:00Z' };

function app() {
  const navigation = createNoteNavigationSave();
  let view = 'flow', revision = 0, dirty = false, exiting = false, error = '', allowed = true;
  let capture = () => {};
  let write = deferred();
  const notesRef = { current: [note] };
  const episodes = new Map<string, { status: string }>();
  const counts = { duration: 0, episodes: 0, analysis: 0, events: 0 };
  const io = { capture: () => capture(), dirty: () => dirty, revision: () => revision,
    flush: async () => { const saved = revision; await write.promise; if (revision === saved) dirty = false; } };
  const exitApp = handler('src/App.tsx', 'handleExitFlowMode', {
    notesRef, saveTimerRef: { current: null }, pendingNotesRef: { current: null }, flowReviewAdmission, saveFlowReviewRecord,
    persistLearningMutation: async (id: string, mutate: (value: NoteItem) => NoteItem) => {
      notesRef.current = notesRef.current.map(value => value.id === id ? mutate(value) : value);
    },
    captureRestatementCognition: async () => {}, confirmNoteNavigation,
    requestNoteNavigation: (commit: () => void, cancel: () => void) => navigation.request(commit, io, cancel),
    allowWorkspaceNavigation: () => allowed, setActiveNoteId: () => {}, setCurrentView: (value: string) => { view = value; },
    getLearningCompletionTarget: () => null, flowTaskBindingRef: { current: null }, setFlowCompletionPrompt: () => {},
    flowSessionRef: { current: null }, setFlowReviewSession: () => {}, recordStudyDuration: async () => { counts.duration++; },
    setFlowSummaryText: () => {}, setFlowQuestions: () => {}, flowEpisodeIdRef: { current: null },
    saveLearningEpisode: async (value: { id: string; status: string }) => { counts.episodes++; episodes.set(value.id, value); }, recordAgentWorkspaceEvent: () => { counts.events++; },
    setFlowSpeakingContent: () => {}, setIsSelectionOpen: () => {}, knowledgeDiscovery: { start: async () => { counts.analysis++; } },
  });
  const restatement = '我理解函数的关键是每个输入都有唯一的输出，定义域决定允许哪些输入。';
  const exit = handler('src/components/FlowMode.tsx', 'handleExit', {
    exitGuardRef: { current: false }, setIsExiting: (value: boolean) => { exiting = value; }, setExitError: (value: string) => { error = value; },
    isListeningRef: { current: false }, stopListeningAndSave: async () => {}, stopWhiteNoise: () => {}, document: { fullscreenElement: null },
    restateTextRef: { current: restatement }, sessionIdRef: { current: 'same-flow-session' }, note,
    startTimeRef: { current: Date.parse('2026-10-31T00:00:00Z') }, elapsedSeconds: 111, reviewIntervalMinutes: 20,
    summary: '', questions: [], questionsRef: { current: [] }, questionAbortRef: { current: null }, analyzeOnExit: true, onExit: exitApp, progressiveController: null,
  });
  return { exit, counts, episodes, notesRef, restatement, state: () => ({ view, exiting, error, dirty }),
    update: () => { revision++; dirty = true; }, setCapture: (value: () => void) => { capture = value; },
    write: () => write, nextWrite: () => { write = deferred(); }, disallow: () => { allowed = false; } };
}

const race = app();
let captureOnce = true;
race.setCapture(() => { if (captureOnce) { captureOnce = false; race.update(); } });
const leaving = race.exit(); await tick(); assert.equal(race.state().exiting, true);
race.update(); race.write().resolve(); await leaving;
assert.equal(race.state().view, 'flow'); assert.equal(race.state().exiting, false);
assert.match(race.state().error, /重试退出/); assert.equal(race.state().dirty, true);
assert.deepEqual(race.counts, { duration: 0, episodes: 1, analysis: 0, events: 0 });
assert.equal(race.episodes.get('same-flow-session')?.status, 'pending_analysis', 'Only the recoverable input checkpoint precedes navigation');
assert.equal(race.notesRef.current[0].learningReviewRecords?.[0].rawRestatement, race.restatement);
console.log('PASS 实际 App → 导航门控 → FlowMode：保存中阅读位置更新取消跳转后，退出按钮恢复、复述保留，不提前记时或启动分析');

race.nextWrite(); const retry = race.exit(); await tick(); race.write().resolve(); await retry;
assert.equal(race.state().view, 'editor');
assert.equal(race.notesRef.current[0].learningReviewRecords?.length, 1);
assert.deepEqual(race.counts, { duration: 1, episodes: 2, analysis: 1, events: 1 });
assert.equal(race.episodes.size, 1, 'Exit retry updates the same durable checkpoint, not a second activity');
console.log('PASS 同一会话重试确认最新保存后才离开，只有一份复述和一次时长、事件、分析');

const failed = app(); failed.update(); const failure = failed.exit(); await tick(); failed.write().reject(Error('Synthetic disk failure')); await failure;
assert.equal(failed.state().view, 'flow'); assert.equal(failed.state().exiting, false); assert.equal(failed.state().dirty, true);
assert.equal(failed.counts.episodes, 1);
assert.equal(failed.episodes.get('same-flow-session')?.status, 'pending_analysis');
failed.nextWrite(); const recovered = failed.exit(); await tick(); failed.write().resolve(); await recovered;
assert.equal(failed.state().view, 'editor'); assert.equal(failed.counts.episodes, 2); assert.equal(failed.episodes.size, 1);
console.log('PASS 导航追加保存失败不锁死页面，保留待保存内容，重试成功后才退出');

const blocked = app(); blocked.disallow(); await blocked.exit();
assert.equal(blocked.state().view, 'flow'); assert.equal(blocked.state().exiting, false); assert.equal(blocked.counts.episodes, 1);
assert.equal(blocked.counts.analysis, 0); assert.equal(blocked.counts.duration, 0);
assert.match(blocked.state().error, /未保存的编辑/);
await assert.rejects(confirmNoteNavigation(() => { throw Error('capture failed'); }, () => {}), /capture failed/);
console.log('PASS 当前编辑阻止跳转、捕获失败均能返回明确错误，不遗留无法结束的退出等待');
