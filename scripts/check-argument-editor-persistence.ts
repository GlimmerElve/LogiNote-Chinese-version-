import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import ts from 'typescript';
import { createArgumentEditorPersistence } from '../src/electron/argumentEditorPersistence';
import { ArgumentEditorWriteFeedback } from '../src/components/ArgumentEditorWriteFeedback';

// Actual relay and extracted production callbacks; all persistence is deferred memory IO.
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
class Sender extends EventEmitter {
  destroyed = false; sent: any[] = [];
  isDestroyed() { return this.destroyed; }
  send(channel: string, payload: any) { this.sent.push({ channel, payload }); }
}
const sources = new Map<string, { ast: ts.SourceFile; nodes: ts.Node[] }>();
function source(file: string) {
  if (sources.has(file)) return sources.get(file)!;
  const ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const nodes: ts.Node[] = []; const visit = (n: ts.Node) => { nodes.push(n); ts.forEachChild(n, visit); }; visit(ast);
  const value = { ast, nodes }; sources.set(file, value); return value;
}
function compile(file: string, name: string, env: Record<string, any>) {
  const { ast, nodes } = source(file);
  const declaration = nodes.find(n => ts.isVariableDeclaration(n) && n.name.getText(ast) === name) as ts.VariableDeclaration;
  assert.ok(declaration?.initializer, name);
  const expression = ts.isCallExpression(declaration.initializer) ? declaration.initializer.arguments[0] : declaration.initializer;
  const code = ts.transpileModule(`return (${expression.getText(ast)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(env), code)(...Object.values(env));
}
function ipc(channel: string, env: Record<string, any>) {
  const { ast, nodes } = source('src/electron/main.ts');
  const call = nodes.find(n => ts.isCallExpression(n) && n.expression.getText(ast) === 'ipcMain.handle'
    && ts.isStringLiteral(n.arguments[0]) && n.arguments[0].text === channel) as ts.CallExpression;
  assert.ok(call);
  const code = ts.transpileModule(`return (${call.arguments[1].getText(ast)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(env), code)(...Object.values(env));
}
{
  const target = new Sender(), editor = new Sender(); const relay = createArgumentEditorPersistence();
  const env = { argumentWindow: { webContents: editor }, mainWindow: { webContents: target, isDestroyed: () => false },
    pendingArgumentData: { noteId: 'note-a', entryMode: 'edit', doc: { doc_id: 'a' } }, argumentPersistence: relay };
  const save = ipc('argument-editor:save', env), remove = ipc('argument-editor:delete', env);
  assert.equal((await save({ sender: target }, { noteId: 'note-a', doc: { doc_id: 'a' } })).ok, false);
  assert.equal((await save({ sender: editor }, { noteId: 'other', doc: { doc_id: 'a' } })).ok, false);
  assert.equal((await remove({ sender: editor }, { docId: 'other' })).ok, false);
  assert.equal(target.sent.length, 0);
  const request = save({ sender: editor }, { noteId: 'note-a', entryMode: 'new', doc: { doc_id: 'a' } });
  assert.equal(target.sent[0].payload.entryMode, 'edit', 'caller cannot change the initial write mode');
  relay.acknowledge(target, { requestId: target.sent[0].payload.requestId, ok: true }); await request;
  const deleting = remove({ sender: editor }, { docId: 'a', noteId: 'other' });
  assert.equal(target.sent[1].payload.noteId, 'note-a', 'delete retains the original note identity');
  relay.acknowledge(target, { requestId: target.sent[1].payload.requestId, ok: false, error: 'disk failed' });
  assert.equal((await deleting).ok, false);
}
{
  const relay = createArgumentEditorPersistence(), editor = new Sender(), target = new Sender();
  const result = relay.request(editor, target, 'argument-editor:saved', { doc: { doc_id: 'a' } });
  const id = target.sent[0].payload.requestId;
  assert.equal(relay.busy(), true);
  assert.equal((await relay.request(editor, target, 'argument-editor:deleted', {})).ok, false);
  assert.equal(target.sent.length, 1, 'duplicate native writes cannot relay twice');
  assert.equal(relay.acknowledge(editor, { requestId: id, ok: true }), false);
  assert.equal(relay.acknowledge(target, { requestId: 'old', ok: true }), false);
  assert.equal(relay.acknowledge(target, { requestId: id, ok: true }), true);
  assert.deepEqual(await result, { ok: true, error: undefined });
  assert.equal(relay.busy(), false); assert.equal(target.listenerCount('destroyed'), 0);
  const retry = relay.request(editor, target, 'argument-editor:saved', {});
  target.emit('did-start-navigation', {}, 'new', false, false);
  assert.equal(relay.busy(), true, 'subframe navigation does not abort');
  target.emit('did-start-navigation', {}, 'new', false, true);
  assert.match((await retry).error!, /可能已经写入/);
  assert.equal(relay.busy(), false); assert.equal(editor.listenerCount('destroyed'), 0);
  assert.equal(relay.acknowledge(target, { requestId: id, ok: true }), false);
}
for (const outcome of ['success', 'failure', 'exception', 'changed', 'unmounted', 'close-failure'] as const) {
  const save = deferred<any>(), close = deferred<boolean>();
  let graph: any = { doc_id: 'a', nodes: [], edges: [], title: 'original' };
  const writeLock = { current: false }, modelLock = { current: false }, evidencePending = { current: 0 };
  const mountedRef = { current: true }, allowCloseRef = { current: false }, baselineRef = { current: '' };
  let saves = 0, deletes = 0, closes = 0, writing: any = null, error = '', finished = false;
  const env = { doc: graph, writeLock, modelLock, evidencePending, mountedRef, allowCloseRef, baselineRef, writeFinishedRef: { current: false },
    noteIdRef: { current: 'note-a' }, entryModeRef: { current: 'edit' },
    setWriting: (value: any) => { writing = value; }, setWriteError: (value: string) => { error = value; },
    setWriteFinished: (value: boolean) => { finished = value; },
    readDoc: () => graph,
    getArgumentApi: () => ({ save: () => { saves++; return save.promise; }, delete: () => { deletes++; return save.promise; },
      close: () => { closes++; return close.promise; } }),
  };
  const perform = compile('src/components/useArgumentEditorWrite.ts', 'performWrite', env);
  const first = perform('save'); await perform('save'); await perform('delete');
  assert.equal(saves, 1); assert.equal(deletes, 0); assert.equal(writing, 'save'); assert.equal(closes, 0);
  if (outcome === 'exception') save.reject(new Error('disk unavailable'));
  else {
    if (outcome === 'changed') graph = { ...graph, title: 'newer edit' };
    if (outcome === 'unmounted') mountedRef.current = false;
    save.resolve(outcome === 'failure' ? { ok: false, error: 'disk unavailable' } : { ok: true });
  }
  await tick();
  if (outcome === 'success' || outcome === 'close-failure') {
    assert.equal(closes, 1); assert.equal(allowCloseRef.current, true); assert.equal(finished, true);
    close.resolve(outcome !== 'close-failure');
  } else assert.equal(closes, 0);
  await first;
  assert.equal(writeLock.current, false); assert.equal(allowCloseRef.current, false);
  if (outcome === 'failure' || outcome === 'exception') assert.match(error, /仍保留/);
  if (outcome === 'changed') { assert.match(error, /仍有新修改/); assert.equal(finished, false); }
  if (outcome === 'close-failure') { assert.match(error, /已保存/); await perform('save'); assert.equal(saves, 1); }
  if (outcome !== 'unmounted') assert.equal(writing, null);
}
for (const state of ['model-pending', 'evidence-pending', 'missing-api', 'delete-retry'] as const) {
  let deletes = 0, closes = 0, error = '', writing: any = null;
  const graph = { doc_id: 'a', nodes: [], edges: [] };
  const env: any = { doc: graph, writeLock: { current: false }, modelLock: { current: state === 'model-pending' }, writeFinishedRef: { current: false },
    evidencePending: { current: state === 'evidence-pending' ? 1 : 0 }, mountedRef: { current: true },
    allowCloseRef: { current: false }, baselineRef: { current: '' }, noteIdRef: { current: 'note-a' }, entryModeRef: { current: 'edit' },
    setWriting: (value: any) => { writing = value; }, setWriteError: (value: string) => { error = value; }, setWriteFinished() {},
    readDoc: () => graph,
    getArgumentApi: () => state === 'missing-api' ? {} : { save: async () => ({ ok: true }),
      delete: async () => { deletes++; return { ok: deletes > 1, error: 'disk failed' }; }, close: async () => { closes++; return true; } },
  };
  const perform = compile('src/components/useArgumentEditorWrite.ts', 'performWrite', env);
  await perform('delete'); assert.equal(closes, 0);
  assert.equal(env.writeLock.current, false); assert.equal(writing, null);
  if (state === 'delete-retry') {
    assert.equal(deletes, 1); assert.match(error, /仍保留/); await perform('delete'); assert.equal(deletes, 2); assert.equal(closes, 1);
  } else assert.equal(deletes, 0);
}
{
  const current = { doc_id: 'a', title: 'unchanged' };
  const env: any = { allowCloseRef: { current: false }, loadedRef: { current: true }, writeLock: { current: false },
    modelLock: { current: false }, evidencePending: { current: 0 }, baselineRef: { current: JSON.stringify(current) },
    useCanvasStore: { getState: () => ({ getDoc: () => current }) } };
  const unload = compile('src/ArgumentEditorApp.tsx', 'beforeUnload', env);
  let prevented = false;
  unload({ preventDefault() { prevented = true; } }); assert.equal(prevented, false);
  current.title = 'edited'; unload({ preventDefault() { prevented = true; } }); assert.equal(prevented, true);
  env.baselineRef.current = JSON.stringify(current); prevented = false; env.writeLock.current = true;
  unload({ preventDefault() { prevented = true; } }); assert.equal(prevented, true);
  env.writeLock.current = false; env.baselineRef.current = ''; prevented = false;
  unload({ preventDefault() { prevented = true; } }); assert.equal(prevented, true, 'new unsaved graphs also require leave confirmation');
}
{
  const { ast, nodes } = source('src/electron/main.ts');
  const creator = nodes.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'createArgumentWindow')!;
  let busy = true, response = 0, confirmations = 0;
  const env = { argumentPersistence: { busy: () => busy }, win: {}, dialog: {
    showMessageBoxSync: (_win: any, options: any) => { confirmations++; assert.equal(options.cancelId, 0); return response; },
  } };
  const native = (event: string) => {
    const node = nodes.find(n => n.pos > creator.pos && n.end < creator.end && ts.isCallExpression(n)
      && n.arguments.length > 0 && ts.isStringLiteral(n.arguments[0]) && n.arguments[0].text === event) as ts.CallExpression;
    assert.ok(node);
    const code = ts.transpileModule(`return (${node.arguments[1].getText(ast)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    return new Function(...Object.keys(env), code)(...Object.values(env));
  };
  let prevented = false; native('close')({ preventDefault() { prevented = true; } }); assert.equal(prevented, true);
  native('will-prevent-unload')({ preventDefault() { throw new Error('pending write cannot leave'); } }); assert.equal(confirmations, 0);
  busy = false; prevented = false; native('will-prevent-unload')({ preventDefault() { prevented = true; } }); assert.equal(prevented, false);
  response = 1; native('will-prevent-unload')({ preventDefault() { prevented = true; } }); assert.equal(prevented, true);
}
for (const mode of ['save', 'failure', 'invalid', 'delete', 'unready'] as const) {
  const disk = deferred<void>(); const acks: any[] = []; let mutated: any = null;
  const input = { id: 'note-a', content: 'before\n<ArgumentBlock id="graph.a" />\nafter',
    argumentDocs: [{ doc_id: 'graph.a' }, { doc_id: 'other' }] };
  const env = {
    notesReadyRef: { current: mode !== 'unready' },
    notesRef: { current: [input] },
    api: { writeApplied: async (reply: any) => { acks.push(reply); } },
    saveArgumentDoc: async (...args: any[]) => { assert.equal(args[4], false, 'independent save does not navigate the main window');
      if (mode === 'invalid') return false; await disk.promise; return true; },
    persistLearningMutation: async (id: string, mutate: any) => { assert.equal(id, 'note-a'); mutated = mutate(input); await disk.promise; },
    detachReviewArgument: (note: any) => note,
    console: { warn() {} },
  };
  const apply = compile('src/App.tsx', 'applyWrite', env);
  const task = apply({ requestId: 'request-a', noteId: 'note-a', docId: 'graph.a', doc: { doc_id: 'graph.a' } }, mode === 'delete');
  await tick();
  if (mode !== 'invalid' && mode !== 'unready') assert.equal(acks.length, 0, 'no success ack before storage resolves');
  if (mode === 'failure') disk.reject(new Error('disk failed')); else disk.resolve();
  await task;
  assert.equal(acks[0].ok, mode === 'save' || mode === 'delete');
  assert.equal(acks[0].requestId, 'request-a');
  if (mode === 'delete') {
    assert.equal(mutated.argumentDocs.length, 1); assert.equal(mutated.argumentDocs[0].doc_id, 'other');
    assert.equal(mutated.content, 'before\n\nafter');
  }
}
for (const navigate of [false, true]) {
  const disk = deferred<void>(); const navigation: string[] = [];
  const note = { id: 'note-a', argumentDocs: [{ doc_id: 'a' }] };
  const env = { notesRef: { current: [note] }, prepareArgumentPublication: () => ({
      assessment: { score: 50, admission: 'review_required', issues: [] }, revisionHash: 'revision-a',
      semanticAssessment: undefined, semanticFresh: false, evidenceAssessment: { grade: 'ungraded' },
      effective: { score: 50, admission: 'review_required' }, canPublish: false, corrections: [], draftReason: '需要质量复核', now: new Date().toISOString(),
    }),
    persistLearningMutation: async (id: string, mutate: any) => { assert.equal(id, 'note-a'); mutate(note); await disk.promise; },
    saveReviewArgument: (latest: any, graph: any) => ({ ...latest, argumentDocs: [graph] }),
    setActiveNoteId: (id: string) => navigation.push(id), setCurrentView: (view: string) => navigation.push(view),
  };
  const save = compile('src/App.tsx', 'saveArgumentDoc', env);
  const task = save({ doc_id: 'a' }, 'note-a', 'edit', undefined, navigate);
  await tick(); assert.equal(navigation.length, 0);
  disk.resolve(); assert.equal(await task, true);
  assert.deepEqual(navigation, navigate ? ['note-a', 'editor'] : [], 'background save preserves the active main workspace');
}
{
  const { ast, nodes } = source('src/components/useArgumentEditorWrite.ts');
  const effect = nodes.find(n => ts.isCallExpression(n) && n.expression.getText(ast) === 'useEffect'
    && n.arguments[0].getText(ast).includes('origin.focus')) as ts.CallExpression;
  assert.ok(effect);
  let focused = 0, disabled = false;
  const origin = { isConnected: true, matches: () => disabled, focus: () => { focused++; } };
  const document: any = { body: {}, activeElement: null }; document.activeElement = document.body;
  const env = { writing: null, writeError: 'failed', writeOrigin: { current: origin }, document };
  const code = ts.transpileModule(`return (${effect.arguments[0].getText(ast)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const focus = new Function(...Object.keys(env), code)(...Object.values(env));
  focus(); assert.equal(focused, 1);
  document.activeElement = {}; focus(); assert.equal(focused, 1, 'failure does not steal focus from another control');
  document.activeElement = document.body; disabled = true; focus(); assert.equal(focused, 1);
  disabled = false; origin.isConnected = false; focus(); assert.equal(focused, 1);
}
assert.equal(ArgumentEditorWriteFeedback({}), null);
assert.equal(ArgumentEditorWriteFeedback({ writing: 'save' })!.props.role, 'status');
assert.equal(ArgumentEditorWriteFeedback({ error: 'failed' })!.props.role, 'alert');
assert.match(readFileSync('src/components/ArgumentEditorFrame.css', 'utf8'), /@media \(max-height: 480px\)/);
assert.match(readFileSync('src/ArgumentEditorApp.tsx', 'utf8'), /useArgumentEditorWrite\(\{/);
assert.doesNotMatch(readFileSync('src/components/useArgumentEditorWrite.ts', 'utf8'), /window\.confirm/);
assert.match(readFileSync('src/ArgumentEditorApp.tsx', 'utf8'), /role="alertdialog"/);
console.log('PASS argument editor persistence: acknowledged writes, ownership, interruption, snapshot/close safety, main-workspace preservation and retry focus');
