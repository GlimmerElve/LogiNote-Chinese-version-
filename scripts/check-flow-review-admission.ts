import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import type { FlowSession, NoteItem, StudyQuestionCard } from '../src/types';
import { flowReviewAdmission, hasLearningReviewContent } from '../src/services/textbook/reviewAdmission';
import { saveFlowReviewRecord, finishFlowReviewRecord, saveReviewArgument, patchLearningReviewRecord } from '../src/services/textbook/reviewRecordStore';
import { recoverLearningReviewReferences } from '../src/services/textbook/migration';
import { learningReviewMarker, writeTextbookRegion } from '../src/services/textbook/noteContent';
import { mixedTextbookNote, TEXTBOOK_FIXTURE } from './fixtures/textbook-phase-zero';
import { isPersonalOnlyNoteChange } from '../src/services/personalNoteState';
import { trackPersonalOnlySave, acknowledgePersonalSave } from '../src/services/ui/personalNoteSave';
import { confirmNoteNavigation } from '../src/services/ui/noteAutosave';

globalThis.fetch = async () => assert.fail('Flow review admission checks must not access the network');
let groups = 0;
const pass = (message: string) => { groups++; console.log(`PASS ${message}`); };
const fixtureNote = mixedTextbookNote();
const base = writeTextbookRegion({ ...fixtureNote, content: `${TEXTBOOK_FIXTURE.plan}\n\n已有个人复述\n\n<ArgumentBlock id="${TEXTBOOK_FIXTURE.graphId}" />`,
  flowSummary: '上次已经保存的总结' }, TEXTBOOK_FIXTURE.textbook, {
  schemaVersion: 1, projectNoteId: fixtureNote.id, rootProjectId: TEXTBOOK_FIXTURE.rootProjectId,
  textbookId: 'fixture-textbook', regionId: 'fixture-region', revisionId: TEXTBOOK_FIXTURE.revisionId,
  createdAt: '2026-10-16T03:00:00.000Z', updatedAt: '2026-10-16T03:00:00.000Z',
});
const original = structuredClone(base);
const session: FlowSession = { id: 'empty-review-session', noteId: base.id, noteTitle: base.title,
  startedAt: '2026-10-16T03:00:00.000Z', endedAt: '2026-10-16T03:20:00.000Z', durationSeconds: 1200,
  reviewIntervalMinutes: 20, analyze: true, summary: '', restateText: '', incrementalText: '' };
const heading = '## 复盘 · 2026-10-16 11:20';

for (const raw of ['', '  \n\t\r\n', '\u200B\uFEFF', `${heading}\n\n`, `${heading}\r\n\r\n${heading}\r\n`]) {
  const empty = { ...session, restateText: raw, incrementalText: raw, questions: base.questions || [] };
  assert.equal(flowReviewAdmission(empty).hasContent, false);
  assert.equal(flowReviewAdmission(empty).needsAnalysis, false);
  for (const status of ['text_only', 'pending_analysis', 'analyzed', 'completed', 'analysis_failed'] as const) {
    assert.equal(saveFlowReviewRecord(base, empty, status, true), base);
  }
}
assert.deepEqual(base, original);
assert.equal(flowReviewAdmission({ ...session, incrementalText: '这是尚未更新的旧复述' }).hasContent, false);
assert.equal(flowReviewAdmission({ ...session, restateText: undefined, incrementalText: '旧客户端的真实复述内容' }).hasContent, true);
pass('空白、不可见字符、仅自动语音时间标题、长时间浏览均不准入；明确清空不复活旧增量，旧客户端仍兼容');

const short = saveFlowReviewRecord(base, { ...session, restateText: '懂了' }, 'text_only', true);
assert.ok(short.content.includes(learningReviewMarker(session.id)));
assert.equal(short.learningReviewRecords!.at(-1)!.rawRestatement, '懂了');
assert.equal(flowReviewAdmission({ ...session, restateText: '懂了' }).needsAnalysis, false);
const summaryOnly = saveFlowReviewRecord(base, { ...session, summary: '我发现适用条件必须逐一核对。' }, 'text_only', true);
assert.equal(summaryOnly.learningReviewRecords!.at(-1)!.summary, '我发现适用条件必须逐一核对。');
assert.ok(summaryOnly.content.includes(learningReviewMarker(session.id)));
const spoken = `${heading}\n\n我认为判断效应时必须核对条件，不能把相关关系当因果关系。`;
assert.equal(flowReviewAdmission({ ...session, restateText: spoken }).needsAnalysis, true);
assert.ok(!flowReviewAdmission({ ...session, restateText: spoken }).analysisText.includes(heading));
assert.equal(saveFlowReviewRecord(base, { ...session, restateText: spoken }, 'pending_analysis').learningReviewRecords!.at(-1)!.rawRestatement, spoken);
assert.equal(flowReviewAdmission({ ...session, restateText: spoken, analyze: false }).needsAnalysis, false);
pass('真实短复述和仅填写总结仍保存；分析沿用十字门槛和用户开关，时间标题不充数且原始转写逐字保留');

const question: StudyQuestionCard = { id: 'new-question', noteId: base.id, question: '这个效应的适用条件是什么？', createdAt: session.endedAt };
const questionOnly = saveFlowReviewRecord(base, { ...session, questions: [question] }, 'text_only', true);
assert.deepEqual(questionOnly.questions, [question]);
assert.equal(questionOnly.content, base.content);
assert.deepEqual(questionOnly.learningReviewRecords, base.learningReviewRecords);
assert.equal(questionOnly.learningContentMigration, base.learningContentMigration);
assert.equal(questionOnly.flowSummary, base.flowSummary);
assert.equal(saveFlowReviewRecord(questionOnly, { ...session, questions: [question] }, 'text_only', true), questionOnly);
pass('只有提问时独立保存问题，不建空块、不迁移正文、不清除旧总结；继承旧问题再次退出无改动');

const previous = saveFlowReviewRecord(base, { ...session, restateText: spoken }, 'pending_analysis');
const edited = patchLearningReviewRecord(previous, session.id, { editedRestatement: '用户补充过的复盘内容', title: '用户修改的复盘标题' });
assert.equal(saveFlowReviewRecord(edited, session, 'text_only', true), edited);
const finished = finishFlowReviewRecord(edited, session.id, 'text_only');
assert.ok(finished.content.includes(learningReviewMarker(session.id)));
assert.equal(finished.learningReviewRecords!.at(-1)!.editedRestatement, '用户补充过的复盘内容');
const emptyRecord = { ...previous.learningReviewRecords!.at(-1)!, rawRestatement: heading, editedRestatement: ' ', summary: '', analysisSummary: '不能作为用户复盘内容', error: '分析错误也不是复盘内容', argumentDocIds: [] };
const legacyEmpty = { ...base, learningReviewRecords: [emptyRecord] };
assert.equal(hasLearningReviewContent(emptyRecord), false);
assert.equal(finishFlowReviewRecord(legacyEmpty, session.id, 'analysis_failed', '错误'), legacyEmpty);
assert.equal(recoverLearningReviewReferences(legacyEmpty), legacyEmpty);
const visibleLegacy = { ...legacyEmpty, content: base.content + '\n\n' + learningReviewMarker(session.id) };
assert.equal(recoverLearningReviewReferences(visibleLegacy), visibleLegacy, 'This fix must not delete previously visible user data');
const graphOnly = saveReviewArgument(legacyEmpty, { ...base.argumentDocs![0], doc_id: 'graph-only-review' }, session.id);
assert.ok(graphOnly.content.includes(learningReviewMarker(session.id)));
assert.equal(hasLearningReviewContent(graphOnly.learningReviewRecords![0]), true);
const interruptedGraph = { ...graphOnly, content: base.content, learningReviewRecords: [{ ...graphOnly.learningReviewRecords![0], status: 'analyzed' as const }] };
assert.ok(recoverLearningReviewReferences(interruptedGraph).content.includes(learningReviewMarker(session.id)));
pass('空占位结束/重启不补造块；空重试不抹去既有复盘，真实图入口保留，不自动删除历史内容');

// Extract the actual production handlers, keeping their sequencing and guards.
// Dependencies are bounded in-memory fixtures; no app mount, real storage or LLM.
function handler(file: string, name: string): string {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  let expression: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) expression = node.initializer;
    else ts.forEachChild(node, visit);
  }; visit(source); assert.ok(expression, `${name} exists in ${file}`); return expression.getText(source);
}
function execute<T extends (...args: any[]) => any>(expression: string, environment: Record<string, unknown>): T {
  const compiled = ts.transpileModule(`return (${expression});`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(environment), compiled)(...Object.values(environment)) as T;
}
const persistSource = handler('src/App.tsx', 'persistLearningMutation');
const exitSource = handler('src/App.tsx', 'handleExitFlowMode');
function appHarness() {
  const notesRef = { current: [{ ...base, parentId: undefined }] as NoteItem[] };
  const initial = notesRef.current;
  const saveTimerRef = { current: null }, pendingNotesRef = { current: null as NoteItem[] | null };
  const counts = { saves: 0, index: 0, duration: 0, episodes: 0, analysis: 0 };
  let view = 'flow', speaking = '';
  const persist = execute<(id: string, mutate: (note: NoteItem) => NoteItem) => Promise<void>>(persistSource, {
    notesRef, enqueueLearningWrite: (_queue: unknown, work: () => Promise<void>) => work(), learningWriteQueueRef: {},
    isPersonalOnlyNoteChange, trackPersonalOnlySave, acknowledgePersonalSave,
    personalOnlySaveRef: { current: null }, savePersonalStateOnly: async () => false,
    recalculateBacklinks: (notes: NoteItem[]) => notes, saveTimerRef, pendingNotesRef,
    setNotes: () => {}, noteSaveRevisionRef: { current: 0 }, setNoteSaveState: () => {}, acknowledgedSaveState: () => 'saved',
    saveAllNotesToStorage: async () => { counts.saves++; }, indexNote: async () => { counts.index++; },
  });
  const exit = execute<(session: FlowSession) => Promise<void>>(exitSource, {
    notesRef, saveTimerRef, pendingNotesRef, flushSave: async () => { counts.saves++; pendingNotesRef.current = null; },
    flowReviewAdmission, persistLearningMutation: persist, saveFlowReviewRecord, captureRestatementCognition: async () => {},
    confirmNoteNavigation, requestNoteNavigation: (commit: () => void) => commit(), allowWorkspaceNavigation: () => true,
    getLearningCompletionTarget: () => null, flowTaskBindingRef: { current: null }, setFlowCompletionPrompt: () => {},
    flowSessionRef: { current: null }, setFlowReviewSession: () => {},
    recordStudyDuration: async () => { counts.duration++; }, setFlowSummaryText: () => {}, setFlowQuestions: () => {},
    flowEpisodeIdRef: { current: null }, saveLearningEpisode: async () => { counts.episodes++; }, setActiveNoteId: () => {},
    setCurrentView: (value: string) => { view = value; }, recordAgentWorkspaceEvent: () => {},
    setFlowSpeakingContent: (value: string) => { speaking = value; }, setIsSelectionOpen: () => {},
    knowledgeDiscovery: { start: async () => { counts.analysis++; } },
  });
  return { exit, notesRef, initial, counts, view: () => view, speaking: () => speaking };
}
for (const raw of ['', `\n${heading}\n`]) {
  const app = appHarness();
  await app.exit({ ...session, restateText: raw, incrementalText: raw });
  assert.equal(app.view(), 'editor'); assert.equal(app.counts.saves, 0); assert.equal(app.counts.index, 0); assert.equal(app.counts.analysis, 0);
  assert.equal(app.counts.duration, 1, 'Normal learning-time accounting stays independent of review blocks');
  assert.equal(app.notesRef.current, app.initial);
}
const entered = appHarness();
await entered.exit({ ...session, restateText: spoken, incrementalText: spoken });
assert.equal(entered.counts.saves, 1); assert.equal(entered.counts.analysis, 1);
assert.equal(entered.speaking(), flowReviewAdmission({ ...session, restateText: spoken }).analysisText);
assert.equal(entered.notesRef.current[0].learningReviewRecords!.at(-1)!.rawRestatement, spoken);
const summaryApp = appHarness();
await summaryApp.exit({ ...session, summary: '我需要先明确判断条件。' });
assert.equal(summaryApp.counts.saves, 1); assert.equal(summaryApp.counts.analysis, 0);
assert.ok(summaryApp.notesRef.current[0].content.includes(learningReviewMarker(session.id)));
const questionsApp = appHarness();
await questionsApp.exit({ ...session, questions: [question] });
assert.equal(questionsApp.counts.saves, 1); assert.equal(questionsApp.counts.analysis, 0);
assert.equal(questionsApp.notesRef.current[0].content, base.content);
assert.deepEqual(questionsApp.notesRef.current[0].questions, [question]);
pass('执行真实 App 退出与持久化处理器：预览/空语音零笔记写入、零分析；总结/提问/真实复述各按原用途保存');

const flowExitSource = handler('src/components/FlowMode.tsx', 'handleExit');
const flowApp = appHarness();
let exits = 0;
const restateRef = { current: '' };
const exitFlow = execute<() => Promise<void>>(flowExitSource, {
  exitGuardRef: { current: false }, setIsExiting: () => {}, setExitError: () => {}, isListeningRef: { current: true },
  stopListeningAndSave: async () => { restateRef.current = `${heading}\n\n`; }, stopWhiteNoise: () => {},
  document: { fullscreenElement: null }, restateTextRef: restateRef, sessionIdRef: { current: session.id },
  note: { ...base }, startTimeRef: { current: Date.parse(session.startedAt) }, elapsedSeconds: 1200,
  reviewIntervalMinutes: 20, summary: '', questions: [], questionsRef: { current: [] }, questionAbortRef: { current: null }, analyzeOnExit: true, progressiveController: null,
  onExit: async (captured: FlowSession) => { exits++; await flowApp.exit(captured); },
});
await Promise.all([exitFlow(), exitFlow()]);
assert.equal(exits, 1); assert.equal(flowApp.counts.saves, 0); assert.equal(flowApp.counts.analysis, 0);
assert.equal(flowApp.view(), 'editor'); assert.equal(flowApp.notesRef.current, flowApp.initial);
pass('真实 FlowMode 麦克风停止→App 退出链路：无识别结果仅留下时间标题时不造块，重复退出仍只处理一次');

assert.equal(base.textbook?.revisionId, TEXTBOOK_FIXTURE.revisionId);
assert.deepEqual(base, original);
console.log(`Flow review admission: ${groups} groups passed; real handlers, synthetic state, no model/network/user vault.`);
