import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import {
  appendMessage, appendMessages, createRunState, incrementTurn, updateRunMetrics,
  checkEventTriggers, checkCompletion, generateMessageId,
} from '../src/services/scene/sceneRuntime';
import { splitGeneralTurnReply, splitRoleReply } from '../src/services/scene/sceneSignal';
import { evaluateEpisodeMemory } from '../src/services/memory/interactionMemoryPolicy';
import { normalizeLearningEpisodeFile, type LearningEpisode, type ReviewEpisodeCapture } from '../src/services/memory/types';
import { reviewCognitionObservations } from '../src/services/cognition/observations';
import { sceneAllowsNavigation } from '../src/components/useSceneGuard';
import type { SceneMessage, SceneRunState, SceneSpec } from '../src/types';
import { buildReviewDraft, reviewDraftQuestionKey, reviewDraftTutorPrompt } from '../src/services/reviewDraft';

// Run the real component handlers with controlled closures. No mounted app, vault, storage or model calls.
globalThis.fetch = async () => assert.fail('Learning input recovery checks must not access the network');
const sources = new Map<string, ts.SourceFile>();
function source(path: string): ts.SourceFile {
  if (!sources.has(path)) sources.set(path, ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX));
  return sources.get(path)!;
}
function findNode(path: string, predicate: (node: ts.Node) => boolean): ts.Node {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node) => { if (found) return; if (predicate(node)) found = node; else ts.forEachChild(node, visit); };
  visit(source(path));
  assert.ok(found, `Handler/expression not found in ${path}`);
  return found;
}
function namedHandler(path: string, name: string): string {
  const declaration = findNode(path, (node) => ts.isVariableDeclaration(node) && node.name.getText(source(path)) === name) as ts.VariableDeclaration;
  assert.ok(declaration.initializer);
  return declaration.initializer.getText(source(path));
}
function element(path: string, className: string): ts.JsxOpeningElement | ts.JsxSelfClosingElement {
  return findNode(path, (node) => (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
    && node.attributes.properties.some((attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText() === 'className'
      && attribute.initializer?.getText().includes(className))) as ts.JsxOpeningElement | ts.JsxSelfClosingElement;
}
function jsxHandler(path: string, className: string, name: string): string {
  const attribute = element(path, className).attributes.properties.find((item) => ts.isJsxAttribute(item) && item.name.getText() === name) as ts.JsxAttribute;
  assert.ok(attribute?.initializer && ts.isJsxExpression(attribute.initializer) && attribute.initializer.expression);
  return attribute.initializer.expression.getText(source(path));
}
function execute<T = (...args: any[]) => any>(expression: string, environment: Record<string, unknown>): T {
  const javascript = ts.transpileModule(`const extracted = (${expression}); return extracted;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(...Object.keys(environment), javascript)(...Object.values(environment)) as T;
}

const reviewPath = 'src/components/ReviewChat.tsx';
const flowPath = 'src/components/FlowMode.tsx';
const chatPath = 'src/components/scene/SceneChatView.tsx';
const scenePath = 'src/components/SceneMode.tsx';
const flowSourceText = readFileSync(flowPath, 'utf8');
assert.match(flowSourceText, /useDialog\(isReviewing, reviewDialogRef/,
  'timed review reminders must own focus and Escape like the other dialogs');
assert.match(flowSourceText, /className="flow-mode-container flow-focus-workspace" inert=\{isReviewing \|\| undefined\}/,
  'the learning workspace must not remain interactive behind a review reminder');
assert.match(flowSourceText, /createPortal\([\s\S]*role="dialog" aria-modal="true"[\s\S]*document\.body/,
  'the review reminder must stay outside the inert workspace and expose dialog semantics');
const flowCss = readFileSync('src/index.css', 'utf8');
const reviewCss = flowCss.slice(flowCss.indexOf('.flow-review-overlay'), flowCss.indexOf('.flow-review-actions'));
assert.match(reviewCss, /var\(--ln-bg-surface\)/);
assert.match(reviewCss, /var\(--ln-text-primary\)/);
for (const [label, expression, action] of [
  ['review answer', namedHandler(reviewPath, 'handleKeyDown'), 'handleSendMessage'],
  ['flow question', jsxHandler(flowPath, 'flow-question-textarea', 'onKeyDown'), 'addQuestion'],
  ['scene answer', jsxHandler(chatPath, 'scene-chat-textarea', 'onKeyDown'), 'submit'],
  ['scene event', jsxHandler(chatPath, 'scene-input', 'onKeyDown'), 'submitEvent'],
] as const) {
  let submitted = 0, prevented = 0;
  const handler = execute(expression, { [action]: () => submitted++ });
  const event = (isComposing: boolean, keyCode = 13, shiftKey = false) => ({
    key: 'Enter', shiftKey, nativeEvent: { isComposing, keyCode }, preventDefault: () => prevented++,
  });
  handler(event(true));
  handler(event(false, 229));
  assert.equal(submitted, 0, `${label}: committing an IME candidate cannot submit`);
  assert.equal(prevented, 0, `${label}: candidate commit remains available to the IME`);
  if (label !== 'scene event') { handler(event(false, 13, true)); assert.equal(submitted, 0, `${label}: Shift+Enter remains a newline`); }
  handler(event(false));
  assert.equal(submitted, 1, `${label}: ordinary Enter submits once`);
}

let injected = 0, cleared = 0;
const injectWhileSending = execute(namedHandler(chatPath, 'submitEvent'), {
  eventText: '停电', canInject: true, sending: true, onInjectEvent: () => injected++,
  setEventText: () => cleared++, setShowEventBox: () => cleared++,
});
injectWhileSending();
assert.equal(injected, 0);
assert.equal(cleared, 0, 'blocked injection retains the event draft');
assert.equal(execute<boolean>(jsxHandler(chatPath, 'scene-input', 'disabled'), { sending: true, finished: false, turnError: '' }), true);

for (const className of ['focus-flow-record', 'focus-flow-summary-voice']) {
  const opening = element(flowPath, className);
  const button = opening.parent as ts.JsxElement;
  const label = findNode(flowPath, (node) => ts.isJsxExpression(node) && Boolean(node.expression?.getText().includes('停止语音总结'))
    && node.pos >= button.pos && node.end <= button.end) as ts.JsxExpression;
  assert.equal(execute<string>(label.expression!.getText(), { isListening: true, activeVoiceTarget: 'summary' }), '停止语音总结');
  assert.equal(execute<string>(label.expression!.getText(), { isListening: true, activeVoiceTarget: 'restate' }), '停止语音复述');
}

const rawInput = `  原始回答\n${'完整语音内容'.repeat(180)}\n`;
const draftRef = { current: rawInput };
const savedDraftRef = { current: undefined as ReviewEpisodeCapture['draftAnswer'] };
const finishLock = { current: false }, finishedRef = { current: false };
let finalPartial = 0, completions = 0, activityWrites = 0;
let captured: ReviewEpisodeCapture | undefined;
const submittedMessages = [{ id: 'tutor-0', role: 'tutor', content: '请说明你的理解。', timestamp: '2026-10-06T00:00:00Z' }];
const finishEnvironment = {
  materialOpen: { isBusy: () => false },
  allowCognitionLeave: () => true,
  previewOnly: false, onExitSaveStateChange: undefined,
  isDiscardingDraft: false, buildReviewDraft,
  reviewDraftQuestionKey, reviewDraftTutorPrompt, currentQuestionTextRef: { current: submittedMessages[0].content },
  lastQuestionIntentRef: { current: { version: 1 as const, questionMessageId: 'tutor-0', knowledgeTargets: [] } },
  hintLevel: 0, consultedMaterialIds: [], consumedDraftIdsRef: { current: new Set<string>() },
  finishLock, finishedRef, isScoring: false, isTutorResponding: false, isListening: true,
  setIsSavingCognition: () => {}, setCognitionError: () => {}, setExitSaveError: () => {},
  finishEndedAtRef: { current: undefined as string | undefined },
  stopListening: async () => { await Promise.resolve(); draftRef.current += '最后一句。'; finalPartial++; },
  userInputRef: draftRef, draftAnswerRef: savedDraftRef, sessionIdRef: { current: 'review-fixture' },
  sessionStartedAtRef: { current: '2026-10-06T00:00:00Z' }, reviewComparisonRef: { current: undefined },
  reviewMasteryRef: { current: undefined }, reviewFeedbackRef: { current: undefined },
  openingQuestion: { cleanText: '请说明你的理解。' }, knowledgeContext: '知识背景', messages: submittedMessages,
  answerEvidenceRef: { current: [] }, summarizeReviewEvidence: () => ({ masteryEligible: false }),
  previewMessages: [], collectCognition: true, noteId: 'note-fixture', noteTitle: '测试复习',
  captureReviewCognition: async (episode: ReviewEpisodeCapture) => { captured = episode; },
  recordReviewActivity: () => { activityWrites++; return Promise.resolve(); },
  isProjectReview: false, finalAnalysis: null, segmentMasteryResults: [],
  onReviewComplete: () => { completions++; },
};
const finish = execute(namedHandler(reviewPath, 'handleFinishReview'), finishEnvironment);
await Promise.all([finish(), finish()]);
assert.equal(finalPartial, 1, 'the exit lock precedes speech finalization');
assert.equal(completions, 1, 'double exit saves one capture');
assert.equal(captured!.draftAnswer!.content, `${rawInput}最后一句。`, 'raw draft, spacing and final voice partial survive without the 800-char cutoff');
assert.equal(captured!.draftAnswer!.id, 'draft-review-fixture');
assert.equal(captured!.messages.length, 1, 'draft is not converted into a submitted answer');
assert.deepEqual(captured!.answerEvidence, []);
assert.equal(captured!.masteryEligible, false);
assert.equal(activityWrites, 0, 'a draft alone does not complete a review activity');
assert.deepEqual(reviewCognitionObservations(captured!, { id: 'note-fixture', title: '测试复习' }), []);

const retryDraft = { current: undefined as ReviewEpisodeCapture['draftAnswer'] };
const retryLock = { current: false }, retryFinished = { current: false };
let captureAttempts = 0, retryCompletions = 0;
const candidateRetryEnvironment = {
  ...finishEnvironment, isListening: false, finishLock: retryLock, finishedRef: retryFinished,
  userInputRef: { current: rawInput }, draftAnswerRef: retryDraft,
  captureReviewCognition: async () => { if (++captureAttempts === 1) throw new Error('候选保存失败'); },
  onReviewComplete: () => retryCompletions++,
};
const candidateRetry = execute(namedHandler(reviewPath, 'handleFinishReview'), candidateRetryEnvironment);
await candidateRetry();
const failedDraftSnapshot = { ...retryDraft.current };
assert.equal(retryLock.current, false, 'candidate save failure unlocks retry without losing the draft');
await candidateRetry();
assert.deepEqual(retryDraft.current, failedDraftSnapshot, 'retry reuses the same raw draft identity and timestamp');
assert.equal(retryCompletions, 1);

// Exercise the real finish handler with an asynchronous completion callback.
const exitLock = { current: false }, exitFinished = { current: false };
let exitBusy = false, exitError = '', exitActivity = 0, exitAttempts = 0;
let releaseExit!: () => void;
const exitGate = new Promise<void>((resolve) => { releaseExit = resolve; });
const asyncFinish = execute(namedHandler(reviewPath, 'handleFinishReview'), {
  ...finishEnvironment, isListening: false, finishLock: exitLock, finishedRef: exitFinished,
  userInputRef: { current: rawInput }, draftAnswerRef: { current: undefined }, finishEndedAtRef: { current: undefined },
  setIsSavingCognition: (value: boolean) => { exitBusy = value; }, setExitSaveError: (value: string) => { exitError = value; },
  summarizeReviewEvidence: () => ({ masteryEligible: true }),
  onReviewComplete: async () => { exitAttempts++; await exitGate; if (exitAttempts === 1) throw new Error('记录写入失败'); },
  recordReviewActivity: async () => { exitActivity++; },
});
const pendingExit = asyncFinish();
await Promise.resolve(); await Promise.resolve();
assert.equal(exitBusy, true);
assert.equal(exitFinished.current, false, 'exit is not finished while the real callback saves');
assert.equal(exitActivity, 0);
await asyncFinish();
assert.equal(exitAttempts, 1, 'pending exit prevents duplicate completion');
releaseExit(); await pendingExit;
assert.equal(exitBusy, false);
assert.equal(exitLock.current, false);
assert.equal(exitFinished.current, false);
assert.match(exitError, /回答和评分仍保留/);
assert.equal(exitActivity, 0, 'failed exit cannot record completion activity');
await asyncFinish();
assert.equal(exitAttempts, 2);
assert.equal(exitActivity, 1);
assert.equal(exitFinished.current, true);

const draftEpisode: LearningEpisode = {
  id: 'review-fixture', type: 'review', status: 'completed', title: '复习草稿',
  startedAt: '2026-10-06T00:00:00Z', endedAt: '2026-10-06T00:01:00Z',
  createdAt: '2026-10-06T00:01:00Z', updatedAt: '2026-10-06T00:01:00Z', draftAnswer: captured!.draftAnswer,
};
assert.equal(evaluateEpisodeMemory(draftEpisode).persist, true);
assert.equal(evaluateEpisodeMemory(draftEpisode).eligibleForContext, false);
const normalized = normalizeLearningEpisodeFile({ episodes: [draftEpisode] });
assert.equal(normalized.episodes[0].draftAnswer!.content, captured!.draftAnswer!.content);
const evaluatedEpisode = { ...draftEpisode, score: 75, evidenceSnippets: [{ type: 'observation' as const, text: '已提交并核对的回答', importance: 0.8, source: 'user_statement' as const }] };
assert.equal(evaluateEpisodeMemory(evaluatedEpisode).eligibleForContext, true, 'an accompanying draft does not hide evaluated evidence');
const memorySourcePath = 'src/services/memory/memoryContextBuilder.ts';
const renderMemory = findNode(memorySourcePath, (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'renderEpisodes') as ts.FunctionDeclaration;
const memory = execute(renderMemory.getText(), {})([evaluatedEpisode]);
assert.ok(memory.includes('已提交并核对的回答'));
assert.ok(!memory.includes('完整语音内容') && !memory.includes('最后一句。'), 'raw drafts are never rendered into model memory context');

if (process.argv.includes('--review-only')) {
  console.log('PASS review input recovery only: final voice text, full raw draft, duplicate-exit guard, save retry and memory isolation');
  process.exit(0);
}

const spec = {
  sceneId: 'scene-fixture', meta: { name: '恢复测试', sceneSkill: 'S1' }, role: { name: '导师' },
  openingNarrative: '', metrics: [], events: [], completion: { mode: 'signal', maxTurns: 1 }, eventInjection: true,
} as SceneSpec;
const userMessage: SceneMessage = { id: 'user-once', speakerType: 'user', speakerName: '你', content: '我的回答', timestamp: '2026-10-06T00:00:00Z' };
const postUser = incrementTurn(appendMessage(createRunState(spec), userMessage));
let currentRun: SceneRunState = postUser, error = '', partial = '', sending = false;
let modelCalls = 0, metricCalls = 0, completionChecks = 0, readerReleased = 0;
let mode = 'general', outcome = 'failure';
const turnBusyRef = { current: false }, pendingTurnRef = { current: null as any };
const turnEnvironment = {
  turnBusyRef, pendingTurnRef, mountedRef: { current: true },
  setSending: (value: boolean) => { sending = value; },
  setTurnError: (value: string) => { error = value; },
  setPartialReply: (value: string) => { partial = value; },
  setRun: (value: SceneRunState) => { currentRun = value; },
  appendMessage, appendMessages, generateMessageId, resolveSceneParadigm: () => mode,
  generateGeneralTurn: async () => {
    modelCalls++; await Promise.resolve();
    if (outcome === 'failure') throw new Error('网络中断');
    return { content: outcome === 'empty' ? '' : '回复完成', interactionDiagnostic: {}, interaction: undefined };
  },
  streamRoleReply: async () => ({ getReader: () => {
    let reads = 0;
    return { read: async () => { if (++reads === 1) return { done: false, value: { text: '已收到的部分回复' } }; throw new Error('流中断'); }, releaseLock: () => readerReleased++ };
  } }),
  resolveSceneRuntimeInteractionProtocol: () => ({ allowedTypes: ['text'] }), recordSceneInteractionAudit: async () => {},
  splitGeneralTurnReply, splitRoleReply,
  makeActionMessages: () => [], fireEvent: () => assert.fail('No event expected'),
  updateMetrics: async () => { metricCalls++; return { metrics: [], deltas: [], completionStatus: 'ongoing', triggeredEvents: [] }; },
  updateRunMetrics, checkEventTriggers,
  checkCompletion: (s: SceneSpec, r: SceneRunState, options: Parameters<typeof checkCompletion>[2]) => { completionChecks++; return checkCompletion(s, r, options); },
  makeEndMessage: (reason: string) => ({ id: 'end', speakerType: 'system', speakerName: '系统', content: reason, timestamp: '2026-10-06T00:01:00Z' }),
};
const streamTurn = execute(namedHandler(scenePath, 'streamTurn'), turnEnvironment);
await Promise.all([streamTurn(spec, postUser, '我的回答'), streamTurn(spec, postUser, '我的回答')]);
assert.equal(modelCalls, 1, 'concurrent starts cannot duplicate the model turn');
assert.equal(currentRun, postUser, 'failure restores the post-user snapshot');
assert.equal(currentRun.status, 'running', 'a failed reply does not end a max-turn scene');
assert.equal(metricCalls, 0);
assert.equal(completionChecks, 0);
assert.equal(sending, false);
assert.equal(error, '网络中断');
assert.equal(pendingTurnRef.current.run, postUser);
assert.equal(currentRun.messages.filter((message) => message.speakerType === 'user').length, 1);

let eventWrites = 0;
execute(namedHandler(scenePath, 'handleInjectEvent'), {
  run: currentRun, spec, turnBusyRef, pendingTurnRef,
  makeManualEvent: () => { eventWrites++; },
})('突发事件');
assert.equal(eventWrites, 0, 'a pending failed turn cannot receive an event that retry would discard');

outcome = 'success';
const retries: Promise<void>[] = [];
execute(namedHandler(scenePath, 'handleRetryTurn'), {
  run: currentRun, turnBusyRef, pendingTurnRef,
  streamTurn: (...args: unknown[]) => { const promise = streamTurn(...args); retries.push(promise); return promise; },
})();
await Promise.all(retries);
assert.equal(currentRun.turnCount, 1, 'retry does not consume another turn');
assert.equal(currentRun.messages.filter((message) => message.speakerType === 'user').length, 1, 'retry preserves the exact single submitted answer');
assert.equal(currentRun.messages.filter((message) => message.speakerType === 'role').length, 1);
assert.equal(metricCalls, 1);
assert.equal(completionChecks, 1);
assert.equal(pendingTurnRef.current, null);
assert.equal(error, '');
assert.equal(sceneAllowsNavigation('finished'), false, 'successful recovery still requires explicit scene Exit');

outcome = 'empty';
await streamTurn(spec, postUser, '我的回答');
assert.equal(currentRun, postUser);
assert.ok(String(error).includes('没有收到'));
assert.equal(metricCalls, 1, 'empty replies cannot silently score or complete the scene');
mode = 'single-role-dialogue';
await streamTurn(spec, postUser, '我的回答');
assert.equal(partial, '已收到的部分回复', 'partial failed text is preserved for read-only inspection');
assert.equal(readerReleased, 1, 'the stream reader is released even after interruption');
assert.equal(currentRun, postUser);
assert.equal(metricCalls, 1);
assert.equal(sending, false);

execute(namedHandler(scenePath, 'handleEnd'), {
  spec, run: currentRun, turnBusyRef, pendingTurnRef,
  setTurnError: turnEnvironment.setTurnError, setPartialReply: turnEnvironment.setPartialReply,
  checkCompletion, appendMessage, makeEndMessage: turnEnvironment.makeEndMessage, setRun: turnEnvironment.setRun,
})();
assert.notEqual(currentRun.status, 'running', 'explicit End remains available from recovery');
assert.equal(pendingTurnRef.current, null);
assert.equal(sceneAllowsNavigation('finished'), false, 'ending a failed turn cannot bypass the explicit Exit guard');

console.log('PASS learning input recovery: IME, shared microphone labels, event guards, raw draft isolation and scene retry');
await import('./check-cognition-ui-interactions');
await import('./check-argument-editor-ui');
await import('./check-argument-editor-persistence');
await import('./check-note-save-recovery');
await import('./check-vault-startup');
