import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NoteSaveRecovery } from '../src/components/NoteSaveRecovery';
import { acknowledgedSaveState } from '../src/services/ui/saveFeedback';
import { enqueueLearningWrite } from '../src/services/ui/learningWriteQueue';
import { isPersonalOnlyNoteChange } from '../src/services/personalNoteState';
import { trackPersonalOnlySave, acknowledgePersonalSave } from '../src/services/ui/personalNoteSave';
import { prepareNoteSaveRecovery } from '../src/services/noteSaveRecovery';
import type { NoteItem } from '../src/types';

// Execute production handlers with memory-only writes. Never mount App or open a real vault.
function nodes(file: string) {
  const ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const all: ts.Node[] = []; const visit = (n: ts.Node) => { all.push(n); ts.forEachChild(n, visit); }; visit(ast);
  return { ast, all };
}
function execute(expression: string, env: Record<string, any>): any {
  const js = ts.transpileModule(`return (${expression});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(env), js)(...Object.values(env));
}
function handler(name: string, env: Record<string, any>) {
  const { ast, all } = nodes('src/App.tsx');
  const node = all.find(n => ts.isVariableDeclaration(n) && n.name.getText(ast) === name) as ts.VariableDeclaration;
  assert.ok(node?.initializer);
  const init = ts.isCallExpression(node.initializer) ? node.initializer.arguments[0] : node.initializer;
  return execute(init.getText(ast), env);
}
function deferred() {
  let resolve!: () => void, reject!: (e: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
for (const outcome of ['success', 'new-edit', 'load-failure', 'write-failure', 'queued-undo']) {
  const stamp = '2026-10-29T00:00:00Z';
  const base: NoteItem = { id: 'a', title: 'A', content: 'original', noteType: 'knowledge', tags: [], links: [], backlinks: [], dueDates: [], createdAt: stamp, updatedAt: stamp };
  const saved = [{ ...base, content: 'newer saved copy' }];
  const loading = deferred(), writing = deferred(), preceding = deferred(); let state = 'error', recovering = false, captures = 0, writes = 0, selected: string | null = 'a';
  let baseline = [base], baselineReads = 0;
  let payload: NoteItem[] = [], error = '';
  const env = {
    noteSaveRetryLockRef: { current: false }, allowCognitionLeave: () => true,
    notesRef: { current: [{ ...base, content: outcome === 'queued-undo' ? base.content : 'local draft' }] }, pendingNotesRef: { current: null as NoteItem[] | null },
    capturePendingChanges: () => { if (++captures === 2 && outcome !== 'queued-undo') env.notesRef.current = [{ ...base, content: '中文 typed while loading' }]; },
    persistedNoteSaveBaseline: { snapshot: () => { baselineReads++; return baseline; } }, saveTimerRef: { current: null },
    learningWriteQueueRef: { current: outcome === 'queued-undo' ? preceding.promise : Promise.resolve() }, enqueueLearningWrite,
    loadNotesFromStorage: async () => { await loading.promise; return saved; }, prepareNoteSaveRecovery,
    recalculateBacklinks: (notes: NoteItem[]) => notes, readingOnlySaveRef: { current: null }, personalOnlySaveRef: { current: null },
    optimisticDeletionsRef: { current: {} }, createOptimisticNoteDeletionState: () => ({}), setPendingDeletionCount() {}, setRestoredDeletionCount() {},
    noteSaveRevisionRef: { current: 1 }, setNotes() {}, setNoteSaveState: (value: string) => { state = value; },
    activeNoteId: 'a', contextNavigation: { reset() {} }, setActiveNoteIdState: (value: string | null) => { selected = value; },
    saveAllNotesToStorage: async (notes: NoteItem[]) => { writes++; payload = notes; await writing.promise; }, acknowledgedSaveState,
    setNoteRecoveryNotice() {}, setNoteSaveError: (value: string) => { error = value; },
    setRecoveringNoteDrafts: (value: boolean) => { recovering = value; },
  };
  const recover = handler('recoverNoteDrafts', env); recover(); recover(); await tick();
  assert.equal(recovering, true); assert.equal(captures, 1, 'repeated clicks cannot queue a second recovery');
  if (outcome === 'queued-undo') {
    assert.equal(baselineReads, 0, 'take the recovery baseline after all preceding writes acknowledge');
    baseline = saved; preceding.resolve(); await tick();
  }
  if (outcome === 'load-failure') {
    loading.reject(new Error('disk offline')); await tick();
    assert.equal(writes, 0); assert.equal(env.notesRef.current[0].content, 'local draft'); assert.equal(state, 'error'); assert.match(error, /disk offline/);
  } else {
    loading.resolve(); await tick(); assert.equal(writes, 1); assert.equal(payload[0], saved[0]);
    assert.equal(payload.at(-1)!.content, outcome === 'queued-undo' ? base.content : '中文 typed while loading', 'preserve buffered text and an undo made during a preceding save');
    assert.equal(selected, payload.at(-1)!.id); assert.equal(env.pendingNotesRef.current, payload);
    if (outcome === 'new-edit') {
      env.notesRef.current = payload.map(note => note.id === selected ? { ...note, content: 'even newer edit' } : note);
      env.pendingNotesRef.current = env.notesRef.current; env.noteSaveRevisionRef.current++;
    }
    if (outcome === 'write-failure') writing.reject(new Error('write offline')); else writing.resolve();
    await tick(); assert.equal(state, outcome === 'new-edit' ? 'pending' : outcome === 'write-failure' ? 'error' : 'saved');
    assert.equal(env.pendingNotesRef.current, outcome === 'success' || outcome === 'queued-undo' ? null : env.notesRef.current);
  }
  assert.equal(recovering, false); assert.equal(env.noteSaveRetryLockRef.current, false);
}
{
  const { ast, all } = nodes('src/components/useNoteSaveLeaveProtection.ts');
  const callback = all.find(n => ts.isVariableDeclaration(n) && n.name.getText(ast) === 'beforeUnload') as ts.VariableDeclaration;
  for (const state of ['saved', 'pending', 'saving', 'error']) {
    const pending = { current: null as any }; let prevented = 0;
    const unload = execute(callback.initializer!.getText(ast), { latestState: { current: state }, pending });
    const event = { returnValue: 'unchanged', preventDefault: () => prevented++ };
    unload(event); assert.equal(prevented, state === 'saved' ? 0 : 1);
    pending.current = ['same-frame-edit']; unload(event);
    assert.equal(prevented, state === 'saved' ? 1 : 2, 'an edit is protected before React renders');
    assert.equal(event.returnValue, '');
  }
  const effect = all.find(n => ts.isCallExpression(n) && n.expression.getText(ast) === 'useEffect') as ts.CallExpression;
  const listeners = new Map();
  const cleanup = execute(effect.arguments[0].getText(ast), { latestState: { current: 'saved' }, pending: { current: null }, window: {
    addEventListener: (type: string, cb: any) => listeners.set(type, cb),
    removeEventListener: (type: string, cb: any) => { assert.equal(listeners.get(type), cb); listeners.delete(type); },
  } })();
  assert.equal(listeners.size, 1); cleanup(); assert.equal(listeners.size, 0);
}
for (const outcome of ['success', 'failure', 'new-edit-success', 'new-edit-failure']) {
  const note = { id: 'a', content: 'current draft' }; const disk = deferred(); let state = '';
  const env = {
    learningWriteQueueRef: { current: Promise.resolve() }, notesRef: { current: [note] },
    isPersonalOnlyNoteChange, trackPersonalOnlySave, acknowledgePersonalSave,
    personalOnlySaveRef: { current: null }, savePersonalStateOnly: async () => false,
    pendingNotesRef: { current: null as any }, noteSaveRevisionRef: { current: 2 }, saveTimerRef: { current: null },
    enqueueLearningWrite, recalculateBacklinks: (n: any) => n, setNotes() {},
    saveAllNotesToStorage: async () => disk.promise, setNoteSaveState: (s: string) => { state = s; },
    acknowledgedSaveState, indexNote: async () => {},
  };
  const mutate = handler('persistLearningMutation', env);
  const task = mutate('a', (old: any) => ({ ...old, content: 'learning result' }));
  const result = task.then(() => true, () => false); await tick();
  assert.equal(state, 'saving'); assert.equal(env.noteSaveRevisionRef.current, 3);
  assert.equal(env.pendingNotesRef.current, env.notesRef.current);
  if (outcome.startsWith('new-edit')) {
    env.notesRef.current = [{ ...note, content: 'newer unsaved edit' }];
    env.pendingNotesRef.current = env.notesRef.current; env.noteSaveRevisionRef.current++;
  }
  if (outcome.endsWith('failure')) disk.reject(new Error('disk unavailable')); else disk.resolve();
  assert.equal(await result, !outcome.endsWith('failure'));
  assert.equal(state, outcome.startsWith('new-edit') ? 'pending' : outcome === 'success' ? 'saved' : 'error');
  assert.equal(env.pendingNotesRef.current, outcome === 'success' ? null : env.notesRef.current);
}
{
  let writes = 0, state = ''; const disk = deferred(); const note = { content: 'latest draft' };
  const env = { noteSaveRetryLockRef: { current: false }, saveTimerRef: { current: null },
    pendingNotesRef: { current: null as any }, notesRef: { current: [note] },
    setNoteSaveState: (s: string) => { state = s; },
    flushSave: async (latest: any) => { writes++; assert.equal(latest, env.notesRef.current); await disk.promise; },
  };
  const retry = handler('retryNoteSave', env); retry(); retry();
  assert.equal(writes, 1); assert.equal(state, 'saving'); assert.equal(env.noteSaveRetryLockRef.current, true);
  disk.reject(new Error('disk down')); await tick(); assert.equal(env.noteSaveRetryLockRef.current, false);
  retry(); assert.equal(writes, 2); await tick();
}
{
  const { ast, all } = nodes('src/electron/main.ts');
  const create = all.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'createWindow')!;
  const native = all.find(n => n.pos >= create.pos && n.end <= create.end && ts.isCallExpression(n)
    && n.expression.getText(ast) === 'win.webContents.on' && n.arguments[0].getText(ast) === "'will-prevent-unload'") as ts.CallExpression;
  assert.ok(native); let details: any;
  execute(native.arguments[1].getText(ast), { win: {}, dialog: { showMessageBoxSync: (_win: any, value: any) => { details = value; } } })({
    preventDefault: () => assert.fail('native warning must not bypass any scene/review/cognition guard'),
  });
  assert.deepEqual(details.buttons, ['返回页面']); assert.equal(details.defaultId, 0);
  const close = all.find(n => n.pos >= create.pos && n.end <= create.end && ts.isCallExpression(n)
    && n.expression.getText(ast) === 'win.on' && n.arguments[0].getText(ast) === "'close'") as ts.CallExpression;
  let busy = true, blocked = 0;
  const guard = execute(close.arguments[1].getText(ast), { win: {}, argumentPersistence: { busy: () => busy },
    applicationShutdown: { getPhase: () => 'ready', request: () => assert.fail('Ready phase must not restart shutdown') },
    process: { platform: 'win32' },
    dialog: { showMessageBoxSync() {} } });
  guard({ preventDefault: () => blocked++ }); assert.equal(blocked, 1);
  busy = false; guard({ preventDefault: () => blocked++ }); assert.equal(blocked, 1);
}
const markup = renderToStaticMarkup(createElement(NoteSaveRecovery, { state: 'error', onRetry() {} }));
assert.match(markup, /role="alert"/); assert.match(markup, /重试保存/); assert.match(markup, /当前窗口/);
assert.equal(renderToStaticMarkup(createElement(NoteSaveRecovery, { state: 'saved', onRetry() {} })), '');
assert.equal(renderToStaticMarkup(createElement(NoteSaveRecovery, { state: 'pending', onRetry() {} })), '');
assert.match(readFileSync('src/App.tsx', 'utf8'), /useNoteSaveLeaveProtection\(noteSaveState, pendingNotesRef\)/);
assert.match(readFileSync('src/App.tsx', 'utf8'), /React.createElement\(NoteSaveRecovery, \{ state: noteSaveState, onRetry: retryNoteSave,[\s\S]*?pendingDeletionCount, restoredDeletionCount/u);
assert.match(readFileSync('src/App.tsx', 'utf8'), /recoveryContent: React.createElement\(NoteSaveRecovery/);
assert.match(readFileSync('src/components/FlowResultView.tsx', 'utf8'), /\{recoveryContent\}/);
{
  const { ast, all } = nodes('src/components/NoteSaveRecovery.tsx');
  const effect = all.find(n => ts.isCallExpression(n) && n.expression.getText(ast) === 'useEffect'
    && n.arguments[0].getText(ast).includes('button.focus')) as ts.CallExpression;
  let focused = 0;
  const button = { isConnected: true, focus: () => focused++ };
  const document: any = { body: {}, activeElement: null }; document.activeElement = document.body;
  const env = { state: 'error', retryButton: { current: button }, retryOrigin: { current: button }, document };
  const focus = execute(effect.arguments[0].getText(ast), env); focus(); assert.equal(focused, 1);
  document.activeElement = {}; focus(); assert.equal(focused, 1, 'failure does not steal focus');
  document.activeElement = document.body; button.isConnected = false; focus(); assert.equal(focused, 1);
}
assert.match(readFileSync('src/components/Header.tsx', 'utf8'), /学习数据仅在本地存储/);
assert.match(readFileSync('src/components/NoteSaveRecovery.css', 'utf8'), /min-height: 44px/);
console.log('PASS note save recovery: same-frame leave guards, mutation acknowledgments, concurrent edits, single retry, accessible feedback and native guard ownership');
