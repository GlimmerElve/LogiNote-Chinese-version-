import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import React from 'react';
import ts from 'typescript';
import { expectedNoteArgumentReference } from '../src/services/argumentContext/referenceBuildClient.ts';
import type { NoteItem } from '../src/types.ts';
import type { PreparedReferenceBuild } from '../src/services/argumentContext/referenceBuildClient.ts';
import { createArgumentReferenceNoteObservations, createArgumentReferenceNoteSnapshotQueue,
  argumentReferenceSavedNoteVersion } from '../src/electron/rag/argumentReferenceNoteObservations.ts';

// Execute the actual component and vault:save handler with hook/API mocks. No
// Electron, real vault, transport, index, embeddings or network can be reached.
globalThis.fetch = async () => assert.fail('Network forbidden in reference build UI checks');
const componentPath = resolve('src/components/ReferenceArgumentStatus.tsx'), moduleRequire = createRequire(componentPath);
const source = ts.transpileModule(readFileSync(componentPath, 'utf8'), { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
} }).outputText;
type Element = { type: unknown; props: Record<string, any> };
const sameDeps = (a?: unknown[], b?: unknown[]) => Boolean(a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i])));
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
let checks = 0;
const pass = (label: string) => { checks++; console.log(`PASS ${label}`); };
const note: NoteItem = { id: 'synthetic-ui-note', noteType: 'knowledge', title: '合成定义', content: '合成知识点正文。',
  createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T01:00:00.000Z', tags: [], links: [], backlinks: [], dueDates: [],
  referenceSources: [{ type: 'web', title: '虚构测试出处', url: 'https://example.org/synthetic' }] };
const expected = await expectedNoteArgumentReference(note);
const ticket: PreparedReferenceBuild = { status: 'prepared', environmentId: 'synthetic-environment', ticketId: 'synthetic-ticket',
  expiresAt: '2026-10-07T03:10:00.000Z', summary: { sourceKind: 'knowledge-note', entityId: note.id,
    sourceVersion: expected.version, contentHash: expected.contentHash, characters: note.content.length, sentences: 1, chunks: 1,
    providerLabel: 'Synthetic provider', modelName: 'synthetic-model', isRemote: true, maximumModelRequests: 3, reviewBudget: 'checked-after-extraction' } };
const buildCounts = { nodes: 1, relations: 0, groups: 0, scopes: 1 };
function api() {
  const calls = { prepare: 0, run: 0, runReturned: 0, cancel: 0, status: 0, invalidate: 0 };
  let runGate = deferred<any>(), prepareGate: ReturnType<typeof deferred<any>> | undefined;
  let statusReply: any = { status: 'missing', source: expected, sourceQualification: 'unassessed', reasonCode: 'review_incomplete' };
  const changed = new Set<() => void>(), invalidated = new Set<() => void>();
  return {
    calls,
    client: {
      status: async () => { calls.status++; return structuredClone(statusReply); },
      prepare: async () => { calls.prepare++; return prepareGate ? prepareGate.promise : structuredClone(ticket); },
      run: async (_ticket: PreparedReferenceBuild) => { calls.run++; const result = await runGate.promise; calls.runReturned++; return result; },
      cancel: async () => { calls.cancel++; return { status: 'cancelled' }; },
      invalidate: () => { calls.invalidate++; },
    },
    getApi: () => ({ onChanged(callback: () => void) { changed.add(callback); return () => changed.delete(callback); },
      onInvalidated(callback: () => void) { invalidated.add(callback); return () => invalidated.delete(callback); } }),
    releaseRun: (result: any = { status: 'published', counts: buildCounts }) => runGate.resolve(result),
    delayPrepare: () => { prepareGate = deferred<any>(); return prepareGate; },
    setStatus: (reply: any) => { statusReply = reply; },
    invalidate: () => invalidated.forEach(callback => callback()), changed: () => changed.forEach(callback => callback()),
  };
}
function harness(mock = api(), props: Record<string, any> = { source: { kind: 'knowledge-note', entityId: note.id }, note: structuredClone(note),
  disabled: false, disabledBehavior: 'hold' }) {
  const slots: any[] = [], cleanups = new Map<number, () => void>();
  let cursor = 0, changed = false, unmounted = false, tree: Element, pendingReadOnly = 0;
  let effects: { index: number; effect: () => void | (() => void) }[] = [];
  const hooks = {
    ...React,
    useState(initial: any) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], (value: any) => {
        assert.equal(unmounted, false, 'no state update after unmount');
        const next = typeof value === 'function' ? value(slots[index]) : value;
        if (!Object.is(next, slots[index])) { slots[index] = next; changed = true; }
      }];
    },
    useRef(initial: any) { const index = cursor++; return slots[index] ||= { current: initial }; },
    useId() { return `synthetic-ui-${cursor++}`; },
    useEffect(effect: () => void | (() => void), deps?: unknown[]) {
      const index = cursor++;
      if (!slots[index] || !sameDeps(slots[index].deps, deps)) { slots[index] = { deps }; effects.push({ index, effect }); }
    },
  };
  const module = { exports: {} as Record<string, any> };
  runInNewContext(source, { exports: module.exports, module, require(id: string) {
    if (id === 'react') return hooks;
    if (id === 'react/jsx-runtime' || id === 'lucide-react') return moduleRequire(id);
    if (id === 'react-dom') return { createPortal: (element: unknown) => element };
    if (id === './useDialog') return { useDialog: () => {} };
    if (id === '../services/argumentContext/referenceBuildClient') return {
      argumentReferenceBuildClient: { ...mock.client, status: async (...args: unknown[]) => {
        pendingReadOnly++;
        try { return await (mock.client.status as (...args: unknown[]) => Promise<unknown>)(...args); }
        finally { pendingReadOnly--; }
      } },
      expectedNoteArgumentReference: async (captured: NoteItem) => {
        pendingReadOnly++;
        try { return await expectedNoteArgumentReference(captured); }
        finally { pendingReadOnly--; }
      }, getArgumentReferenceBuildApi: mock.getApi,
      argumentReferenceBuildReasonLabel: (value: string) => value,
    };
    if (id === '../services/argumentContext/referenceRagBuildClient') return {
      getArgumentReferenceRagBuildApi: () => undefined,
      argumentReferenceRagBuildClient: new Proxy({}, { get: () => assert.fail('new combined API is unavailable in legacy compatibility checks') }),
      argumentReferenceRagBuildReasonLabel: (value: string) => value,
    };
    throw new Error(`Unmocked import forbidden: ${id}`);
  }, structuredClone, Date, Error, JSON, Set, Map, Promise, Number, String, Boolean, Math });
  const render = () => {
    let passes = 0;
    do {
      changed = false; cursor = 0; effects = [];
      tree = module.exports.ReferenceArgumentStatus(props);
      effects.forEach(({ index, effect }) => { cleanups.get(index)?.(); const cleanup = effect(); if (cleanup) cleanups.set(index, cleanup); else cleanups.delete(index); });
      assert.ok(++passes < 12, 'hook fixture must settle');
    } while (changed);
    return tree;
  };
  render();
  return { mock, props, render, flush: () => unmounted ? tree : render(), get pendingReadOnly() { return pendingReadOnly; },
    get tree() { return tree; }, unmount() { unmounted = true; cleanups.forEach(cleanup => cleanup()); } };
}
function all(element: unknown): Element[] {
  if (Array.isArray(element)) return element.flatMap(all);
  if (!element || typeof element !== 'object' || !('props' in element)) return [];
  const node = element as Element; return [node, ...all(node.props.children)];
}
function text(element: unknown): string {
  if (Array.isArray(element)) return element.map(text).join('');
  if (!element || typeof element !== 'object') return String(element ?? '');
  return 'props' in element ? text((element as Element).props.children) : '';
}
function button(ui: ReturnType<typeof harness>, label: string): Element {
  const found = all(ui.tree).find(node => node.type === 'button' && text(node.props.children) === label); assert.ok(found, `missing button ${label}`); return found;
}
function confirmation(ui: ReturnType<typeof harness>): Element | undefined {
  return all(ui.tree).find(node => typeof node.type === 'function' && node.type.name === 'ReferenceProcessingConfirmation');
}
// WebCrypto digest completes on a worker, not after a fixed number of Promise
// turns. Wait for actual state plus the tracked status/identity reads; advancing
// timers lets worker completion arrive, and rendering also flushes new effects.
async function waitFor(ui: ReturnType<typeof harness>, label: string, ready: () => boolean = () => true) {
  const deadline = performance.now() + 10_000;
  do {
    await new Promise<void>(done => setTimeout(done, 1));
    ui.flush();
    if (ui.pendingReadOnly === 0 && ready()) return;
  } while (performance.now() < deadline);
  assert.fail(`Timed out waiting for ${label}; pending status/identity reads=${ui.pendingReadOnly}; UI=${text(ui.tree)}`);
}
async function prepared(ui: ReturnType<typeof harness>) {
  await waitFor(ui, 'saved-source status');
  button(ui, '建立参考论证').props.onClick();
  await waitFor(ui, 'prepared confirmation', () => Boolean(confirmation(ui)));
}

const running = harness();
await waitFor(running, 'mount status'); assert.equal(running.mock.calls.run, 0); assert.equal(running.mock.calls.prepare, 0);
pass('mount and read-only status never call a model or prepare a consent ticket');
await prepared(running); confirmation(running)!.props.onConfirm(); await waitFor(running, 'consented run', () => running.mock.calls.run === 1);
assert.equal(running.mock.calls.run, 1);
for (const disabled of [true, false, true, false]) {
  running.props.disabled = disabled; running.render(); await waitFor(running, 'unrelated save flag while running');
  running.mock.changed(); await waitFor(running, 'unrelated change notification while running');
  assert.equal(running.mock.calls.cancel, 0); assert.equal(running.mock.calls.run, 1);
}
assert.match(text(running.tree), /正在审核来源/);
running.mock.releaseRun(); await waitFor(running, 'published run', () => /参考论证已发布/u.test(text(running.tree)));
pass('actual component keeps one consented run across unrelated global pending/saving/acknowledgement');

const waiting = harness(); await prepared(waiting);
waiting.props.disabled = true; waiting.render(); assert.ok(confirmation(waiting), 'global saving must not hide an unchanged-source confirmation');
waiting.mock.changed(); await waitFor(waiting, 'preserved confirmation', () => Boolean(confirmation(waiting)));
const confirm = confirmation(waiting)!.props.onConfirm; confirm(); confirm(); await waitFor(waiting, 'single double-confirm run', () => waiting.mock.calls.run === 1);
assert.equal(waiting.mock.calls.run, 1); assert.equal(waiting.mock.calls.cancel, 0);
waiting.mock.releaseRun(); await waitFor(waiting, 'double-confirm published run', () => /参考论证已发布/u.test(text(waiting.tree)));
pass('hold preserves prepared confirmation during global saving and double confirm issues only one run');

const pending = harness(api(), { source: { kind: 'knowledge-note', entityId: note.id }, note: structuredClone(note), disabled: true, disabledBehavior: 'hold' });
await waitFor(pending, 'pending source status'); assert.equal(all(pending.tree).some(node => node.type === 'button' && text(node.props.children) === '建立参考论证'), false);
pending.props.disabled = false; pending.render(); await waitFor(pending, 'save acknowledgement status');
assert.equal(pending.mock.calls.prepare, 0); assert.equal(pending.mock.calls.run, 0); assert.ok(button(pending, '建立参考论证'));
pass('first preparation waits for save, and save acknowledgement never starts a model automatically');

const changed = harness(); await prepared(changed); confirmation(changed)!.props.onConfirm(); await waitFor(changed, 'run before source edit', () => changed.mock.calls.run === 1);
changed.props.note = { ...changed.props.note, content: '真正修改后的合成正文。' }; changed.render(); await waitFor(changed, 'edited source cancellation', () => changed.mock.calls.cancel === 1);
assert.equal(changed.mock.calls.cancel, 1);
changed.mock.releaseRun(); await waitFor(changed, 'obsolete run completion', () => changed.mock.calls.runReturned === 1); assert.doesNotMatch(text(changed.tree), /参考论证已发布/);
pass('real source text key changes still cancel the run and reject late published UI receipts');

const personal = harness(); await prepared(personal); confirmation(personal)!.props.onConfirm(); await waitFor(personal, 'run before activity edit', () => personal.mock.calls.run === 1);
personal.props.note = { ...personal.props.note, updatedAt: '2026-10-07T05:00:00.000Z', lastReferencedAt: '2026-10-07T05:00:00.000Z',
  textbookReadingState: { bookRevision: 'synthetic', sectionId: 'synthetic', updatedAt: '2026-10-07T05:00:00.000Z' } };
personal.props.disabled = true; personal.render(); await waitFor(personal, 'personal activity while running'); assert.equal(personal.mock.calls.cancel, 0);
personal.mock.releaseRun(); await waitFor(personal, 'activity-preserved published run', () => /参考论证已发布/u.test(text(personal.tree)));
pass('personal reading/activity timestamps do not become reference source key changes');

const document = harness(api(), { source: { kind: 'uploaded-document', entityId: 'synthetic-document' }, disabled: false });
await prepared(document); document.props.disabled = true; document.render(); await waitFor(document, 'document invalidation', () => document.mock.calls.cancel === 1);
assert.equal(document.mock.calls.cancel, 1); assert.equal(confirmation(document), undefined);
pass('documents retain default source-invalidating disabled behavior');

const invalidated = harness(); await prepared(invalidated); invalidated.mock.invalidate(); await waitFor(invalidated, 'root/model/navigation invalidation', () => invalidated.mock.calls.cancel === 1);
assert.equal(invalidated.mock.calls.cancel, 1); assert.equal(confirmation(invalidated), undefined); assert.equal(invalidated.mock.calls.run, 0);
pass('model/root/navigation invalidation still clears confirmation without an automatic run');

const dependencyMock = api(); dependencyMock.setStatus({ status: 'available', source: expected, sourceQualification: 'eligible', counts: buildCounts });
const dependency = harness(dependencyMock); await waitFor(dependency, 'initial available dependency badge', () => /参考论证已就绪/u.test(text(dependency.tree)));
dependencyMock.setStatus({ status: 'missing', source: expected, sourceQualification: 'unassessed', reasonCode: 'review_incomplete' });
dependencyMock.changed(); await waitFor(dependency, 'changed dependency badge', () => !/已就绪/u.test(text(dependency.tree)));
assert.ok(button(dependency, '建立参考论证')); assert.doesNotMatch(text(dependency.tree), /已就绪/);
assert.equal(dependencyMock.calls.prepare, 0); assert.equal(dependencyMock.calls.run, 0); assert.equal(dependencyMock.calls.cancel, 0);
pass('idle dependency changes refresh the badge/readiness without revoking tickets or starting a model');

const late = harness(), prepareGate = late.mock.delayPrepare();
await waitFor(late, 'status before delayed preparation'); button(late, '建立参考论证').props.onClick();
await waitFor(late, 'delayed preparation requested', () => late.mock.calls.prepare === 1);
late.props.note = { ...late.props.note, title: '真正改变后的标题' }; late.render(); prepareGate.resolve(ticket);
await waitFor(late, 'obsolete prepared ticket cancelled', () => late.mock.calls.cancel === 1);
assert.equal(late.mock.calls.cancel, 1); assert.equal(confirmation(late), undefined); assert.equal(late.mock.calls.run, 0);
pass('late preparation for an obsolete source cannot reopen confirmation');

const stopped = harness(); await prepared(stopped); confirmation(stopped)!.props.onConfirm(); await waitFor(stopped, 'run before unmount', () => stopped.mock.calls.run === 1);
stopped.unmount(); assert.equal(stopped.mock.calls.cancel, 1); stopped.mock.releaseRun(); await waitFor(stopped, 'run response after unmount', () => stopped.mock.calls.runReturned === 1);
pass('component unmount still cancels work and refuses late UI state changes');

const mainFile = ts.createSourceFile('src/electron/main.ts', readFileSync('src/electron/main.ts', 'utf8'), ts.ScriptTarget.ES2022, true);
let saveHandler: ts.Expression | undefined;
const visit = (node: ts.Node) => {
  if (ts.isCallExpression(node) && node.expression.getText(mainFile) === 'ipcMain.handle'
    && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'vault:save') saveHandler = node.arguments[1];
  ts.forEachChild(node, visit);
}; visit(mainFile); assert.ok(saveHandler);
const compiled = ts.transpileModule(`const tested = ${saveHandler.getText(mainFile)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
let buildsRevoked = 0, saved = 0, ordinaryReferenceRevoked = 0, summaryNotifications = 0;
const environment = { referenceEnvironmentSuspended: false, referenceSourceWriteEpoch: 1,
  getVaultRoot: () => '/synthetic-vault', getUserStateDir: () => '/synthetic-state',
  referenceEnvironments: { revoke: () => { ordinaryReferenceRevoked++; } }, revokeReferenceBuilds: () => { buildsRevoked++; },
  referenceNoteSnapshotSaves: createArgumentReferenceNoteSnapshotQueue(), loadMergedNotes: async () => [structuredClone(note)],
  referenceBuilds: { observeNoteSnapshot: (_next: NoteItem[], _previous: NoteItem[]) => {} },
  referenceRagBuilds: { observeNoteSnapshot: (_next: NoteItem[], _previous: NoteItem[]) => {} },
  mainWindow: { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (channel: string) => {
    assert.equal(channel, 'argument-reference:changed'); summaryNotifications++;
  } } },
  saveVaultSnapshot: async (_vault: string, _state: string, _notes: NoteItem[], _write: unknown, current: () => boolean) => { assert.equal(current(), true); saved++; },
  atomicWriteTextFile: () => assert.fail('no real writer'), onWriteCommitted: () => {}, noteRagIndexNotes: async () => {},
  retryDeletedNoteIndexCleanup: () => {},
  deferredNoteIndex: { request() {} },
  syncTextbookReferenceNotes: async () => {}, syncSavedFlowReviewNotes: async () => {}, console,
};
const save = new Function(...Object.keys(environment), `${compiled}\nreturn tested;`)(...Object.values(environment));
await save({}, [{ ...note, lastReferencedAt: '2026-10-07T06:00:00.000Z' }]);
await save({}, [note, { ...note, id: 'unrelated-note', content: '另一项目合成正文' }]);
assert.equal(saved, 2); assert.equal(buildsRevoked, 0); assert.equal(ordinaryReferenceRevoked, 2);
assert.equal(summaryNotifications, 2);
pass('actual main vault:save handler keeps build tickets for personal/unrelated snapshots without weakening the saved-source transaction');

const serialTracker = createArgumentReferenceNoteObservations();
const serialObservation = serialTracker.capture(serialTracker.begin(), [{ kind: 'knowledge-note', entityId: note.id,
  version: argumentReferenceSavedNoteVersion(note) } as any]);
let serialSaved = [structuredClone(note)], reads = 0, writes = 0;
const firstWrite = deferred<void>(), firstStarted = deferred<void>();
const serialEnvironment = { ...environment, referenceNoteSnapshotSaves: createArgumentReferenceNoteSnapshotQueue(),
  loadMergedNotes: async () => { reads++; return structuredClone(serialSaved); },
  referenceBuilds: { observeNoteSnapshot: serialTracker.observe },
  saveVaultSnapshot: async (_vault: string, _state: string, snapshot: NoteItem[]) => {
    if (++writes === 1) { firstStarted.resolve(); await firstWrite.promise; }
    serialSaved = structuredClone(snapshot);
  },
};
const serialSave = new Function(...Object.keys(serialEnvironment), `${compiled}\nreturn tested;`)(...Object.values(serialEnvironment));
const changing = { ...note, content: '应用内暂时更改为 B。' };
const saveB = serialSave({}, [changing]), saveA = serialSave({}, [structuredClone(note)]);
await firstStarted.promise; assert.equal(reads, 1); assert.equal(writes, 1);
assert.equal(serialTracker.current(serialObservation), false);
firstWrite.resolve(); await Promise.all([saveB, saveA]);
assert.equal(reads, 2); assert.equal(writes, 2); assert.equal(serialSaved[0].content, note.content);
assert.equal(serialTracker.current(serialObservation), false, 'restoring A cannot revive the prior source observation');
pass('actual main handler serializes concurrent previous→observe→save and rejects observed B→A despite a deferred first write');
const editor = readFileSync('src/components/NoteEditor.tsx', 'utf8');
assert.match(editor, /ReferenceArgumentStatus[\s\S]{0,300}disabledBehavior="hold"/u);
pass('NoteEditor explicitly treats its workspace-wide saveState as hold, not source invalidation');
console.log(`Argument reference build UI checks passed (${checks} groups; actual component handlers; zero network/production-file/model calls).`);
