import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { createReviewExitNavigationLock, reviewExitNavigationNotice } from '../src/services/ui/reviewExitNavigation';
import { commitReviewExitWrite, prepareReviewExitOutcome, type ReviewExitProgress } from '../src/services/ui/reviewExitWrite';
import type { ReviewEpisodeCapture } from '../src/services/memory/types';
import type { NoteItem } from '../src/types';

globalThis.fetch = async () => assert.fail('Review navigation checks cannot use a network or a real vault.');
const appPath = 'src/App.tsx';
const appText = readFileSync(appPath, 'utf8');
const app = ts.createSourceFile(appPath, appText, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
function find(predicate: (node: ts.Node) => boolean): ts.Node {
  let result: ts.Node | undefined;
  const visit = (node: ts.Node) => { if (result) return; if (predicate(node)) result = node; else ts.forEachChild(node, visit); };
  visit(app); assert.ok(result); return result;
}
function handler(name: string): string {
  const node = find((item) => ts.isVariableDeclaration(item) && item.name.getText(app) === name) as ts.VariableDeclaration;
  assert.ok(node.initializer);
  const expression = ts.isCallExpression(node.initializer) && node.initializer.expression.getText(app) === 'useCallback'
    ? node.initializer.arguments[0] : node.initializer;
  return expression.getText(app);
}
function execute(code: string, environment: Record<string, unknown>): any {
  const compiled = ts.transpileModule(`const tested = ${code};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(environment), `${compiled}\nreturn tested;`)(...Object.values(environment));
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const stateLock = createReviewExitNavigationLock();
assert.equal(stateLock.update('saving', 'session-a'), true);
assert.match(reviewExitNavigationNotice(stateLock.getSnapshot()), /正在保存/);
assert.equal(stateLock.update('failed', 'session-a'), true);
assert.match(reviewExitNavigationNotice(stateLock.getSnapshot()), /重试保存/);
assert.equal(stateLock.update('idle', 'session-b'), false, 'an old/different session cannot release the lock');
assert.equal(stateLock.update('saving', 'session-b'), false, 'a pending retry keeps its original owner');
assert.equal(stateLock.update('saving', 'session-a'), true);
assert.equal(stateLock.update('idle', 'session-a'), true);
assert.equal(stateLock.getSnapshot(), null);

const note: NoteItem = { id: 'review-note', title: '测试复习', content: '原笔记', noteType: 'knowledge', dueDates: [],
  tags: [], links: [], backlinks: [], createdAt: '', updatedAt: '' };
const episode: ReviewEpisodeCapture = { id: 'session-a', startedAt: '2026-10-07T00:00:00Z', endedAt: '2026-10-07T00:03:00Z',
  questionText: '测试提问', knowledgeContext: '测试上下文', messages: [], masteryEligible: false,
  draftAnswer: { id: 'draft-a', content: '  不应丢失的原文\n第二行', timestamp: '2026-10-07T00:03:00Z' } };
function fixture() {
  const lock = createReviewExitNavigationLock();
  let blocked = 0, navigation = 0, contextChanges = 0, noteWrites = 0, recordWrites = 0;
  let gate = deferred(), shouldFail = false;
  const viewRef = { current: 'review' };
  const activationRef = { current: 1 };
  const progress = { current: new Map<string, ReviewExitProgress>() };
  const guard = {
    updateStatus: lock.update,
    allowNavigation: () => { if (!lock.getSnapshot()) return true; blocked++; return false; },
    getSnapshot: lock.getSnapshot,
  };
  const setView = execute(handler('setCurrentView'), {
    requestNoteNavigation: (commit: () => void) => commit(),
    allowCognitionLeave: () => true,
    reviewExitGuard: guard, sceneGuard: { allowNavigation: () => true }, currentViewRef: viewRef,
    navigationRevisionRef: { current: 0 }, contextNavigation: { reset: () => { contextChanges++; } },
    setCurrentViewState: () => { navigation++; },
  });
  const exit = execute(handler('handleExitReview'), {
    reviewExitGuard: guard, currentViewRef: viewRef, reviewActivationRef: activationRef, reviewActivation: 1,
    reviewNoteId: note.id, reviewNoteTitle: note.title, reviewReturnView: 'bubble', reviewExitProgressRef: progress,
    commitReviewExitWrite, prepareReviewExitOutcome,
    persistPlanMutation: async (prepare: (notes: NoteItem[]) => unknown) => { noteWrites++; return prepare([note]); },
    saveLearningEpisode: async (saved: unknown) => { assert.ok(saved); recordWrites++; await gate.promise; if (shouldFail) throw new Error('记录保存失败'); },
    clearReviewDraftsForNote: async (_noteId: string, draftIds: string[]) => { assert.deepEqual(draftIds, []); },
    extractReviewEvidence: () => ({ evidenceSnippets: [], profileSignals: [] }),
    ingestProfileSignals: async () => {}, recordNewMastered: async () => assert.fail('A draft cannot raise mastery'),
    updateWorkflowHandoff: () => assert.fail('A draft cannot create a scored handoff'), setCurrentView: setView,
    recordAgentWorkspaceEvent: () => {},
  });
  return { lock, guard, exit, setView, viewRef, activationRef, progress,
    allowWorkspaceNavigation: () => guard.allowNavigation(),
    changeRecordGate: (fail: boolean) => { gate = deferred(); shouldFail = fail; return gate; },
    release: () => gate.resolve(),
    counts: () => ({ blocked, navigation, contextChanges, noteWrites, recordWrites }),
  };
}
const delayed = fixture();
const failureGate = delayed.changeRecordGate(true);
const pending = delayed.exit(null, undefined, episode);
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
assert.equal(delayed.lock.getSnapshot()?.phase, 'saving');
delayed.setView('graph');
assert.equal(delayed.viewRef.current, 'review');
assert.equal(delayed.counts().navigation, 0);
assert.equal(delayed.counts().contextChanges, 0, 'blocked navigation cannot reset the reference branch');

// Test the actual entry handlers, not just the route setter. No target changes may occur first.
let entryMutationCount = 0;
const entryEnvironment = {
  allowWorkspaceNavigation: delayed.allowWorkspaceNavigation,
  reviewNoteIdRef: { current: note.id },
  reviewActivationRef: delayed.activationRef, setCurrentView: delayed.setView,
  setReviewReturnView: () => entryMutationCount++, setReviewNoteId: () => entryMutationCount++,
  setReviewNoteTitle: () => entryMutationCount++, setReviewQuestion: () => entryMutationCount++, setReviewContext: () => entryMutationCount++,
};
execute(handler('handleEnterReview'), entryEnvironment)('new-note', '新复习', '新问题', '新上下文');
execute(handler('handleEnterReviewFromGraph'), entryEnvironment)(note);
execute(handler('handleEnterBubbleMode'), { ...entryEnvironment, setReviewHubLaunchRequest: () => entryMutationCount++ })(undefined);
execute(handler('handleOpenContextNote'), entryEnvironment)(note.id);
execute(handler('handleSelectPlanWorkspaceNote'), entryEnvironment)(note.id);
execute(handler('handleNewNote'), entryEnvironment)();
execute(handler('handleSelectNote'), entryEnvironment)(note.id);
execute(handler('handleEnterScene'), entryEnvironment)({});
execute(handler('handleEnterFlowMode'), entryEnvironment)(note.id, 20);
execute(handler('handleAgentOpenResource'), entryEnvironment)({});
assert.equal(entryMutationCount, 0);
assert.equal(entryEnvironment.reviewNoteIdRef.current, note.id, 'blocked entry cannot replace the live review target');
assert.equal(delayed.activationRef.current, 1, 'a blocked second review cannot change the session key');
const ipcOpen = find((item) => ts.isVariableDeclaration(item) && item.name.getText(app) === 'offOpenNote') as ts.VariableDeclaration;
assert.ok(ipcOpen.initializer && ts.isCallExpression(ipcOpen.initializer));
execute(ipcOpen.initializer.arguments[0].getText(app), entryEnvironment)({ noteId: note.id });

const agentProperty = (name: string) => (find((item) => ts.isPropertyAssignment(item) && item.name.getText(app) === name) as ts.PropertyAssignment).initializer.getText(app);
assert.throws(() => execute(agentProperty('navigate'), { reviewExitGuard: delayed.guard })( 'graph'), /复习尚未完整保存/);
assert.equal(execute(agentProperty('openNoteByTitle'), entryEnvironment)('测试复习'), false);
assert.equal(execute(agentProperty('openTextbookProject'), entryEnvironment)(note.id), false);
assert.equal(execute(agentProperty('enterLearningMode'), entryEnvironment)({ mode: 'review' }), false);

// A long-running Agent may retain its old context after opening another review.
// Its lookup must follow the synchronous live identity, even before React renders.
const nextReviewNote = { ...note, id: 'next-review-note', title: '下一次复习' };
const liveReviewTarget = { current: note.id };
const focusedNote = execute(handler('getAgentFocusedNote'), {
  contextNavigation: { getSnapshot: () => ({ pages: [], cursor: -1 }) },
  currentViewRef: { current: 'review' }, notesRef: { current: [note, nextReviewNote] },
  reviewNoteIdRef: liveReviewTarget,
});
assert.equal(focusedNote()?.id, note.id);
const newEntryEnvironment = { ...entryEnvironment, allowWorkspaceNavigation: () => true,
  reviewNoteIdRef: liveReviewTarget, reviewActivationRef: { current: 0 }, setCurrentView: () => {} };
execute(handler('handleEnterReview'), newEntryEnvironment)(nextReviewNote.id, nextReviewNote.title, '新问题', '新上下文');
assert.equal(focusedNote()?.id, nextReviewNote.id, 'old Agent context sees the newly opened review immediately');
execute(handler('handleEnterReviewFromGraph'), { ...newEntryEnvironment, notes: [], buildReviewOpeningQuestion: () => '问题' })(note);
assert.equal(focusedNote()?.id, note.id, 'graph entry also updates the live review identity');

failureGate.resolve();
await assert.rejects(pending, /记录保存失败/);
assert.equal(delayed.lock.getSnapshot()?.phase, 'failed');
delayed.setView('graph');
assert.equal(delayed.viewRef.current, 'review', 'a failed save retains the original page and retry');
const retryGate = delayed.changeRecordGate(false);
const retry = delayed.exit(null, undefined, episode);
await Promise.resolve(); await Promise.resolve();
assert.equal(delayed.counts().noteWrites, 1, 'retry cannot repeat the successful notes stage');
retryGate.resolve(); await retry;
assert.equal(delayed.viewRef.current, 'bubble');
assert.equal(delayed.lock.getSnapshot(), null);
assert.equal(delayed.counts().navigation, 1);
assert.equal(delayed.progress.current.size, 0, 'successful checkpoints cannot retain entire note snapshots forever');
delayed.setView('graph'); assert.equal(delayed.viewRef.current, 'graph', 'navigation unlocks after confirmed persistence');

// Defensive identity checks cover even a forced route reset outside the public navigation API.
const stale = fixture();
const late = stale.exit(null, undefined, episode);
await Promise.resolve(); await Promise.resolve();
stale.viewRef.current = 'graph';
stale.release(); await late;
assert.equal(stale.viewRef.current, 'graph', 'an old completion cannot force a return after the page changed');
assert.equal(stale.counts().navigation, 0);
const newer = fixture();
const oldPending = newer.exit(null, undefined, episode);
await Promise.resolve(); await Promise.resolve();
newer.activationRef.current = 2;
newer.lock.update('idle', episode.id);
newer.lock.update('saving', 'session-b');
newer.release(); await oldPending;
assert.equal(newer.lock.getSnapshot()?.sessionId, 'session-b');
assert.equal(newer.counts().navigation, 0, 'an old completion cannot close a newer activation');
await assert.rejects(newer.exit(null, undefined, episode), /会话已离开/);
assert.equal(newer.counts().noteWrites, 1, 'stale entry cannot begin another notes write');

// Check the shared hook's real capture handlers in a tiny in-memory event/history environment.
const hookText = readFileSync('src/components/useReviewExitGuard.ts', 'utf8');
const hookNode = ts.createSourceFile('hook.ts', hookText, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS)
  .statements.find((item) => ts.isFunctionDeclaration(item) && item.name?.text === 'useReviewExitGuard') as ts.FunctionDeclaration;
assert.ok(hookNode);
let cursor = 0;
const slots: any[] = [];
const effects: Array<() => void> = [];
const listeners = new Map<string, (event: any) => void>();
let historyPushes = 0, historyForwards = 0;
const history = { state: {} as Record<string, unknown>, pushState(state: Record<string, unknown>) { this.state = state; historyPushes++; },
  replaceState(state: Record<string, unknown>) { this.state = state; }, forward() { historyForwards++; } };
const events = (prefix: string) => ({ addEventListener: (type: string, fn: (event: any) => void) => listeners.set(prefix + type, fn),
  removeEventListener: (type: string) => listeners.delete(prefix + type) });
class Link { closest() { return this; } getAttribute() { return '/other-page'; } }
const hook = execute(hookNode.getText().replace('export function', 'function'), {
  createReviewExitNavigationLock, reviewExitNavigationNotice,
  useRef: (initial: unknown) => slots[cursor++] ||= { current: initial },
  useState: (initial: unknown) => { const index = cursor++; slots[index] ||= { value: initial }; return [slots[index].value,
    (value: unknown) => { slots[index].value = value; }]; },
  useCallback: (fn: unknown, deps: unknown[]) => {
    const index = cursor++, previous = slots[index];
    if (!previous || deps.some((value, i) => value !== previous.deps[i])) slots[index] = { deps, fn };
    return slots[index].fn;
  },
  useEffect: (effect: () => (() => void) | undefined, deps: unknown[]) => {
    const index = cursor++, previous = slots[index];
    if (!previous || deps.some((value, i) => value !== previous.deps[i])) {
      effects.push(() => { previous?.cleanup?.(); slots[index] = { deps, cleanup: effect() }; });
    }
  },
  window: { ...events('window:'), history }, document: events('document:'), Element: Link,
  crypto: { randomUUID: () => 'sentinel-fixture' }, setTimeout: () => 1, clearTimeout: () => {},
});
const renderHook = () => { cursor = 0; const result = hook(); while (effects.length) effects.shift()!(); return result; };
let mounted = renderHook();
mounted.updateStatus('saving', 'keyboard-session');
assert.equal(mounted.allowNavigation(), false, 'the ref blocks same-tick navigation before a React effect');
mounted = renderHook();
let prevented = 0, stopped = 0;
const event = (extra: Record<string, unknown>) => ({ preventDefault: () => prevented++, stopImmediatePropagation: () => stopped++, ...extra });
for (const key of ['k', 'j']) listeners.get('document:keydown')!(event({ key, ctrlKey: true }));
listeners.get('document:keydown')!(event({ key: 'ArrowLeft', altKey: true }));
listeners.get('document:click')!(event({ target: new Link() }));
listeners.get('window:beforeunload')!(event({ returnValue: undefined }));
assert.equal(prevented, 5); assert.equal(stopped, 4);
history.state = {}; listeners.get('window:popstate')!({}); assert.equal(historyForwards, 1);
mounted.updateStatus('failed', 'keyboard-session'); mounted = renderHook();
mounted.updateStatus('saving', 'keyboard-session'); mounted = renderHook();
assert.equal(historyPushes, 1, 'failure and retry cannot accumulate history sentinels');
mounted.updateStatus('idle', 'keyboard-session'); mounted = renderHook();
assert.equal(listeners.size, 0, 'all browser and keyboard guards are released on success');
assert.equal(mounted.allowNavigation(), true);

assert.match(appText, /key: reviewActivation,[\s\S]*?onExitSaveStateChange: handleReviewExitSaveStateChange/);
assert.match(appText, /navigationRevisionRef\.current !== 0 \|\| currentViewRef\.current !== 'home'/, 'startup recovery cannot override user navigation');
assert.match(appText, /currentViewRef\.current === 'review'.*reviewNoteId/);
assert.match(appText, /isOpen: isCommandPaletteOpen && !reviewExitGuard\.locked/);
const resultBranch = find((node) => ts.isIfStatement(node) && node.expression.getText(app).startsWith('flowResult &&')) as ts.IfStatement;
assert.equal(execute(`() => ${resultBranch.expression.getText(app)}`, { flowResult: {}, currentView: 'review', reviewExitGuard: { locked: false } })(), false,
  'a delayed flow result cannot unmount an active review');
assert.equal(execute(`() => ${resultBranch.expression.getText(app)}`, { flowResult: {}, currentView: 'editor', reviewExitGuard: { locked: true } })(), false);
console.log('Review save navigation checks passed: actual App entries, deferred failure/retry, session ownership, shortcuts, IPC, context links and late completions. All persistence is in-memory.');
