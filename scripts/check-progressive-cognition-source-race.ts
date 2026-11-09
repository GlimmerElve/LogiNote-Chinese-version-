/** Production main IPC callbacks + real native course/cognition stores. Synthetic, offline inputs only. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { ProgressiveLearningStore } from '../src/electron/progressiveLearningStore';
import { ProgressiveReviewWorker } from '../src/services/progressiveLearning/reviewWorker';
import { analyzeProgressivePart } from '../src/services/progressiveLearning/reviewAnalysis';
import { progressiveCognitionSourceKey } from '../src/services/progressiveLearning/reviewCognitionSource';
import { progressiveReviewModelReply } from './fixtures/progressive-phase4';
import { loadCognition, mutateCognition, withCognitionFile } from '../src/electron/cognitionStore';
import { withSavedVaultSnapshot } from '../src/electron/vaultSnapshot';
import { latestCognition } from '../src/services/cognition/core';
import type { NoteItem } from '../src/types';
import type { ProgressiveReviewRecord } from '../src/services/progressiveLearning/reviewTypes';

globalThis.fetch = async () => assert.fail('No network or real model in cognition source-race checks');
const root = await fs.mkdtemp(path.resolve('build/progressive-cognition-source-race-'));
const source = await fs.readFile('src/electron/main.ts', 'utf8');
const syntax = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
let options = '', environment = '';
const handlers = new Map<string, string>();
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(syntax) === 'progressiveStore')
    options = (node.initializer as ts.NewExpression).arguments![1].getText(syntax);
  if (ts.isVariableDeclaration(node) && node.name.getText(syntax) === 'progressiveEnvironmentCurrent')
    environment = node.initializer!.getText(syntax);
  if (ts.isCallExpression(node) && node.expression.getText(syntax) === 'ipcMain.handle'
    && ts.isStringLiteral(node.arguments[0])) handlers.set(node.arguments[0].text, node.getText(syntax));
  ts.forEachChild(node, visit);
}
visit(syntax);
assert.ok(options && environment && handlers.has('progressive-learning:command') && handlers.has('user-state:mutate-cognition'));
function evaluate(code: string, context: any) {
  return vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS } }).outputText, context, { timeout: 3000 });
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => resolve = r); return { promise, resolve }; }
async function eventually(predicate: () => boolean) {
  for (let i = 0; i < 1000 && !predicate(); i++) await new Promise(r => setTimeout(r, 1));
  assert.ok(predicate(), 'Synthetic operation did not reach its expected boundary');
}
const raw = '我认为时间接近和刺激相似是两个应分别控制的变量，不能仅凭一次反应推广到任何条件。改变时间间隔后的反应差异能够支持这一判断，但不能证明相似性在所有条件下都足够。';
const long = Array.from({ length: 55 }, (_, i) => `第${i + 1}次观察：${raw}`).join('\n\n');
let groups = 0;
const pass = (message: string) => { groups++; console.log('PASS ' + message); };

async function harness(name: string, text = raw) {
  const directory = path.join(root, name), vault = path.join(directory, 'vault'), state = path.join(directory, 'user-state');
  await fs.mkdir(path.join(vault, 'notes'), { recursive: true });
  const at = new Date().toISOString(), projectId = 'synthetic-' + name;
  let notes: NoteItem[] = [{ id: projectId, noteType: 'project', projectRole: 'learning', title: '合成认知课程',
    content: '# 合成课程目标', tags: [], links: [], backlinks: [], createdAt: at, updatedAt: at,
    dueDates: [{ id: 'deadline', noteId: projectId, noteTitle: '合成认知课程', taskText: '合成认知课程',
      dueDate: '2026-11-08', priority: 'medium', completed: false }] }];
  await fs.writeFile(path.join(vault, 'metadata.json'), JSON.stringify({ version: 1, notesMeta: { [projectId]: notes[0] } }));
  await fs.writeFile(path.join(vault, 'notes', projectId + '.md'), notes[0].content);
  const registered = new Map<string, (...args: any[]) => Promise<any>>();
  let current = true, fail = 0, writes = 0, queuedWrites = 0, modelCalls = 0, notices = 0;
  let mutationGate: { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | undefined;
  let profileGate: { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | undefined;
  const changeListeners = new Set<(id: string) => void>();
  const context: any = { fs, path, withSavedVaultSnapshot, console,
    progressiveVaultRoot: vault, progressiveUserStateRoot: state, referenceEnvironmentSuspended: false,
    referenceSourceWriteEpoch: 0, learningMigrationPending: false,
    getVaultRoot: () => current ? vault : vault + '-other', getUserStateDir: () => current ? state : state + '-other',
    mutateCognition: async (...args: Parameters<typeof mutateCognition>) => {
      writes++; if (fail) { fail--; throw Error('synthetic private write refused'); }
      if (mutationGate) { const gate = mutationGate; mutationGate = undefined; gate.entered.resolve(); await gate.release.promise; }
      queuedWrites++;
      return mutateCognition(...args);
    },
    BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: () => { notices++; } } }] },
    onWriteCommitted() {}, mainWindow: { isDestroyed: () => false,
      webContents: { send: (_channel: string, id: string) => { for (const listener of changeListeners) listener(id); } } }, progressiveDerived: undefined,
    textbookStore: { hasRunningProject: () => false }, progressiveOwners: new Set<number>(),
    referenceCallerAllowed: () => true, admitTeaching: (work: () => Promise<any>) => work(), taskScope: () => 'synthetic-scope',
    ipcMain: { handle: (channel: string, callback: (...args: any[]) => Promise<any>) => registered.set(channel, callback) },
  };
  evaluate('globalThis.progressiveEnvironmentCurrent = (' + environment + '); globalThis.options = (' + options + ');', context);
  let store = new ProgressiveLearningStore(state, context.options);
  context.progressiveStore = store;
  evaluate(handlers.get('progressive-learning:command')! + ';' + handlers.get('user-state:mutate-cognition')!, context);
  const event = { sender: { id: 17, once() {}, on() {} } };
  const command = async <T = any>(input: any): Promise<T> => registered.get('progressive-learning:command')!(event, input);
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: { progressiveLearning: {
    command, onChange: (listener: (id: string) => void) => { changeListeners.add(listener); return () => changeListeners.delete(listener); },
  } } } });
  const load = () => command<any>({ op: 'load', projectNoteId: projectId });
  const begin = await command<any>({ op: 'begin', projectNoteId: projectId });
  await command({ op: 'publish', lease: begin.lease, teaching: { sequence: begin.course.generation.sequence + 1,
    plan: { title: '合成主线', objectives: ['区分实验变量'], pages: [{ id: 'main-1', title: '实验控制', objectives: ['区分变量'] }] },
    title: '实验控制', body: '# 合成教材，不应成为个人表达\n\n' + raw.repeat(8), concepts: [], questions: [],
    hook: { id: 'hook', kind: 'reflection', prompt: '说说你的认识。' } } });
  let course = await load();
  await command({ op: 'save-progress', projectNoteId: projectId, progress: { environmentId: course.environmentId,
    courseId: course.id, expectedProgressVersion: course.progress.version,
    patch: { restatementDraft: text, restatementSpans: [{ pageId: 'main-1', start: 0, end: text.length }] } } });
  course = await load();
  const exit = await command<any>({ op: 'review-exit', projectNoteId: projectId, environmentId: course.environmentId,
    courseId: course.id, exitId: 'synthetic-exit', expectedProgressVersion: course.progress.version, analyze: true });
  await command({ op: 'review-activate', projectNoteId: projectId, environmentId: course.environmentId, courseId: course.id, exitId: 'synthetic-exit' });
  const read = () => command<ProgressiveReviewRecord>({ op: 'review-read', projectNoteId: projectId, reviewId: exit.record.id });
  const worker = () => new ProgressiveReviewWorker({ command, loadCourse: load, readNotes: () => notes,
    persist: async prepare => { notes = prepare(notes); }, profile: async () => {
      if (profileGate) { const gate = profileGate; profileGate = undefined; gate.entered.resolve(); await gate.release.promise; }
    },
    analyze: packet => analyzeProgressivePart(packet, { call: async request => {
      modelCalls++; const input = JSON.parse(request.userInput), reply: any = progressiveReviewModelReply(input);
      if (!input.graph) {
        reply.graph.nodes = [{ id: 'N1', role: 'claim', text: input.rawText.slice(0, 38), rawQuote: input.rawText.slice(0, 38) },
          { id: 'N2', role: 'premise', text: input.rawText.slice(-35), rawQuote: input.rawText.slice(-35) }];
        reply.graph.arguments = [{ id: 'A1', claim: 'N1', support: ['N2'], oppose: [], status: 'argued' }];
      }
      return { content: JSON.stringify(reply) };
    } }) });
  async function run() { const w = worker(); w.kick(projectId); await w.idle(); w.stop(); return read(); }
  const editInput = (r: ProgressiveReviewRecord, value: string) => ({ op: 'review-edit', projectNoteId: projectId,
    reviewId: r.id, expectedVersion: r.version, text: value });
  const claim = () => command<any>({ op: 'review-claim', projectNoteId: projectId, reviewId: exit.record.id });
  const cognitionInput = (claimed: any) => ({ op: 'review-cognition-confirm', projectNoteId: projectId,
    reviewId: claimed.record.id, environmentId: course.environmentId, courseId: course.id,
    expectedVersion: claimed.record.version, confirmed: true });
  const confirm = async () => command(cognitionInput({ record: await read() }));
  async function restart() { store.releaseOwner(17); store = new ProgressiveLearningStore(state, context.options); context.progressiveStore = store; }
  return { command, read, run, claim, editInput, cognitionInput, confirm, restart, worker, directory: state, projectId,
    cognition: () => loadCognition(state), fail() { fail++; }, switchEnvironment() { current = false; },
    generic: (input: unknown) => registered.get('user-state:mutate-cognition')!(event, input),
    holdNextMutation() { const gate = { entered: deferred(), release: deferred() }; mutationGate = gate; return gate; },
    holdNextProfile() { const gate = { entered: deferred(), release: deferred() }; profileGate = gate; return gate; },
    get writes() { return writes; }, get queuedWrites() { return queuedWrites; }, get modelCalls() { return modelCalls; }, get notices() { return notices; } };
}

const queued = await harness('queued-old');
await queued.run();
await queued.confirm();
let claimed = await queued.claim();
const editedFirst = queued.command(queued.editInput(claimed.record, ''));
const staleWrite = queued.command(queued.cognitionInput(claimed));
await editedFirst;
await assert.rejects(staleWrite, /执行许可已变化|复述或分析版本已变化|复述已更新|清空/);
assert.ok((await queued.cognition()).records.every(row => row.withdrawn));
pass('edit ordered first invalidates the old native write before it can reach cognition; cleared sources stay withdrawn');

const inFlight = await harness('private-queue');
await inFlight.run(); await inFlight.confirm(); claimed = await inFlight.claim();
const mutationGate = inFlight.holdNextMutation(), previousWrites = inFlight.queuedWrites;
const commit = inFlight.command(inFlight.cognitionInput(claimed));
await mutationGate.entered.promise; // Target snapshot transaction has already released its roots.
const gate = deferred(), entered = deferred();
const blocker = withCognitionFile(inFlight.directory, async () => { entered.resolve(); await gate.promise; });
await entered.promise;
mutationGate.release.resolve(); await eventually(() => inFlight.queuedWrites > previousWrites);
let editDone = false;
const clear = inFlight.command(inFlight.editInput(claimed.record, '')).then(value => { editDone = true; return value; });
await new Promise(r => setTimeout(r, 10)); assert.equal(editDone, false, 'Edit must not falsely succeed while an older native mutation is queued');
gate.resolve(); await blocker; await commit; await clear;
assert.ok((await inFlight.cognition()).records.every(row => row.withdrawn));
await assert.rejects(inFlight.command({ op: 'review-acknowledge', lease: claimed.lease,
  auxiliaryHash: claimed.record.auxiliaryHash, cognitionSourceKey: progressiveCognitionSourceKey(claimed.record) }), /执行许可已变化/);
const calls = inFlight.modelCalls; await inFlight.run(); assert.equal(inFlight.modelCalls, calls);
assert.ok((await inFlight.cognition()).records.every(row => row.withdrawn));
pass('real private queue contention cannot let a successful archive clear be overtaken by old cognition or acknowledgement');

const multi = await harness('multi-edited', long);
let record = await multi.run(); await multi.confirm(); record = await multi.read(); const originalCalls = multi.modelCalls;
const replacement = '我现在认为：时间接近只是影响条件之一，只有控制刺激强度等变量后才可以比较。';
await multi.command(multi.editInput(record, replacement));
assert.ok((await multi.cognition()).records.filter(row => !row.withdrawn).length > 1,
  'A non-empty archive edit must not silently replace already-confirmed beliefs');
let graph = await multi.command<any>({ op: 'review-graph-read', projectNoteId: multi.projectId, reviewId: record.id, partId: 'part-1' });
const revised = structuredClone(graph.doc); revised.nodes = [{ ...revised.nodes[0], text: replacement }]; revised.edges = [];
await multi.command({ op: 'review-graph-save', projectNoteId: multi.projectId, reviewId: record.id, partId: 'part-1',
  environmentId: (await multi.command<any>({ op: 'load', projectNoteId: multi.projectId })).environmentId,
  courseId: record.courseId, expectedVersion: graph.record.version, expectedGraphHash: graph.graphHash, doc: revised });
await multi.confirm();
let file = await multi.cognition(), active = file.records.filter(row => !row.withdrawn);
assert.equal(active.length, 1); assert.equal(latestCognition(active[0]).branches[0].graph.edges.length, 0);
assert.equal(latestCognition(active[0]).branches[0].graph.nodes[0].text, replacement);
assert.ok(file.records.filter(row => row.id !== active[0].id).every(row => row.withdrawn));
assert.ok(record.chunks.length > 1);
await multi.run(); assert.equal(multi.modelCalls, originalCalls);
record = await multi.read(); await multi.command(multi.editInput(record, ''));
assert.ok((await multi.cognition()).records.every(row => row.withdrawn));
pass('multi-segment text/graph edits do not replace beliefs until explicit confirmation; clearing synchronously withdraws every automatic segment');

const retry = await harness('failed-clear');
record = await retry.run(); await retry.confirm(); record = await retry.read(); const retryCalls = retry.modelCalls, input = retry.editInput(record, '');
retry.fail(); await assert.rejects(retry.command(input), /private write refused/);
record = await retry.read(); assert.equal(record.editedText, ''); assert.equal(record.cognitionWithdrawalPending, true);
assert.equal(record.cognitionSourceKey, undefined);
await retry.command(input); // exact retry with the UI's pre-failure version must work
assert.ok((await retry.cognition()).records.every(row => row.withdrawn));
await retry.restart(); record = await retry.run(); assert.equal(record.auxiliary, 'ready');
assert.equal(retry.modelCalls, retryCalls);
pass('partial edit failure leaves a durable pending source and supports the same UI retry plus restart recovery without re-analysis');

const recovery = await harness('restart-clear'); record = await recovery.run(); await recovery.confirm(); record = await recovery.read(); const recoveryCalls = recovery.modelCalls;
recovery.fail(); await assert.rejects(recovery.command(recovery.editInput(record, '')), /private write refused/);
await recovery.restart(); record = await recovery.run();
assert.equal(record.auxiliary, 'ready'); assert.equal(record.cognitionVersion, undefined); assert.equal(record.cognitionWithdrawalPending, false);
assert.ok((await recovery.cognition()).records.every(row => row.withdrawn)); assert.equal(recovery.modelCalls, recoveryCalls);
pass('restart alone resumes an unfinished source withdrawal using saved analysis, not the old automatic graph');

const background = await harness('active-worker-edit'), profileGate = background.holdNextProfile();
const activeWorker = background.worker().start(); await profileGate.entered.promise;
record = await background.read(); const backgroundCalls = background.modelCalls;
await background.command(background.editInput(record, ''));
profileGate.release.resolve(); await activeWorker.idle(); activeWorker.stop();
record = await background.read(); assert.equal(record.auxiliary, 'ready'); assert.equal(record.cognitionVersion, undefined);
assert.equal(background.modelCalls, backgroundCalls);
assert.ok((await background.cognition()).records.every(row => row.withdrawn));
pass('a running worker observes source edits, drops the old lease, then automatically finishes the edited source without another model call');

const protectedData = await harness('protected'); record = await protectedData.run(); await protectedData.confirm(); record = await protectedData.read(); file = await protectedData.cognition();
const kept = file.records[0], revision = latestCognition(kept);
await protectedData.generic({ kind: 'edit_graph', confirmed: true, expectedRevision: file.revision,
  edit: { action: 'update_node', target: { recordId: kept.id, revisionId: revision.id, branchId: 'primary', nodeId: revision.branches[0].graph.nodes[0].id },
    text: '用户保留的手工条件修订。', role: 'claim', stance: 'endorsed', operation: 'revise', reason: '合成保护回归' } });
await protectedData.command(protectedData.editInput(record, ''));
const manual = (await protectedData.cognition()).records[0]; assert.equal(manual.withdrawn, false);
assert.equal(latestCognition(manual).branches[0].graph.nodes[0].text, '用户保留的手工条件修订。');
file = await protectedData.cognition();
await protectedData.generic({ kind: 'forget', confirmed: true, expectedRevision: file.revision, recordId: kept.id });
record = await protectedData.read(); await protectedData.command(protectedData.editInput(record, raw));
assert.equal((await protectedData.cognition()).records.length, 0);
await assert.rejects(protectedData.generic({ kind: 'record_restatements', observations: [{ recordId: 'progressive:unsafe' }] }), /明确确认/);
assert.ok(protectedData.notices > 0);
pass('production generic IPC still supports manual revisions/forgetting but cannot bypass native progressive source validation');

const stale = await harness('environment'); await stale.run(); await stale.confirm(); claimed = await stale.claim();
const lateGate = stale.holdNextMutation(), count = stale.queuedWrites;
const late = stale.command(stale.cognitionInput(claimed)); await lateGate.entered.promise;
const environmentGate = deferred(), environmentEntered = deferred();
const environmentBlocker = withCognitionFile(stale.directory, async () => { environmentEntered.resolve(); await environmentGate.promise; });
await environmentEntered.promise;
lateGate.release.resolve(); await eventually(() => stale.queuedWrites > count);
stale.switchEnvironment(); environmentGate.resolve(); await environmentBlocker;
await assert.rejects(late, /环境已变化|不能访问渐进/);
const stillOriginal = await loadCognition(stale.directory);
assert.equal(stillOriginal.records.length, 1); assert.equal(stillOriginal.records[0].withdrawn, false);
pass('environment guards are rechecked inside the queued real private transaction; a late write cannot cross storage scopes');

console.log(JSON.stringify({ status: 'passed-offline', groups, root, networkCalls: 0,
  boundary: 'actual main IPC expressions and native file transactions with deterministic replies; no real-library, live-model or semantic-quality acceptance' }, null, 2));
