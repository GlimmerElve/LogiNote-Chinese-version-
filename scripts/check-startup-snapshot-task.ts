import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { createStartupSnapshotTask } from '../src/electron/startupSnapshotTask';
import { withRagSourceTransaction } from '../src/electron/ragSourceTransactions';

const source = ts.createSourceFile('main.ts', readFileSync('src/electron/main.ts', 'utf8'), ts.ScriptTarget.ES2022, true);
function find<T extends ts.Node>(predicate: (node: ts.Node) => node is T): T {
  let found: T | undefined;
  const visit = (node: ts.Node) => {
    if (predicate(node)) found = node;
    ts.forEachChild(node, visit);
  };
  visit(source); assert.ok(found); return found;
}
function evaluate(node: ts.Node, env: Record<string, unknown>): any {
  const code = ts.transpileModule(`return (${node.getText(source)});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(...Object.keys(env), code)(...Object.values(env));
}
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const loadCall = find((node): node is ts.CallExpression => ts.isCallExpression(node)
  && node.expression.getText(source) === 'ipcMain.handle'
  && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'vault:load');
const startupTask = find((node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node)
  && node.name.getText(source) === 'startupFlowStatistics');
assert.ok(startupTask.initializer);

let groups = 0;
function scenario() {
  const state = { exiting: false, suspended: false, epoch: 0, root: '/synthetic/vault', directory: '/synthetic/state' };
  const scheduled: Array<() => void> = [];
  const stats: Array<{ directory: string; notes: unknown[] }> = [];
  const locks: string[][] = [];
  let errors = 0, reads = 0, cleanups = 0;
  let read = async (): Promise<unknown[]> => [{ id: 'original', content: 'saved original' }];
  let backfill = async (directory: string, notes: unknown[]) => { stats.push({ directory, notes }); };
  let transaction = async (roots: string[], run: () => Promise<void>) => { locks.push(roots); await run(); };
  const env: Record<string, unknown> = {
    createStartupSnapshotTask: (options: any) => createStartupSnapshotTask({ ...options, schedule: (run: () => void) => scheduled.push(run) }),
    getVaultRoot: () => state.root, getUserStateDir: () => state.directory,
    withRagSourceTransaction: (roots: string[], run: () => Promise<void>) => transaction(roots, run),
    backfillFlowStatistics: (directory: string, notes: unknown[]) => backfill(directory, notes),
    console: { warn: () => { errors++; } },
  };
  const keys = Object.keys(env);
  // Replace only the three module-level state bindings with live test state.
  const initializer = startupTask.initializer.getText(source)
    .replaceAll('applicationExiting', 'state.exiting')
    .replaceAll('referenceEnvironmentSuspended', 'state.suspended')
    .replaceAll('referenceSourceWriteEpoch', 'state.epoch');
  const factoryCode = ts.transpileModule(`return (${initializer});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const task = new Function('state', ...keys, factoryCode)(state, ...Object.values(env));
  // Recreate the IPC closure per invocation so its captured scalar epoch is live.
  const invoke = () => evaluate(loadCall.arguments[1], {
    getVaultRoot: () => state.root, getUserStateDir: () => state.directory,
    referenceSourceWriteEpoch: state.epoch,
    loadMergedNotes: async () => { reads++; return read(); },
    retryDeletedNoteIndexCleanup: () => { cleanups++; }, startupFlowStatistics: task,
  })();
  return {
    state, scheduled, stats, locks, invoke,
    get reads() { return reads; }, get errors() { return errors; }, get cleanups() { return cleanups; },
    setRead: (next: typeof read) => { read = next; },
    setBackfill: (next: typeof backfill) => { backfill = next; },
    setTransaction: (next: typeof transaction) => { transaction = next; },
    drain: async () => { while (scheduled.length) scheduled.shift()!(); await tick(); },
  };
}

{
  const s = scenario(), notes = [{ id: 'recovered', content: 'journal replayed before this result' }];
  s.setRead(async () => notes);
  assert.equal(await s.invoke(), notes);
  assert.equal(s.reads, 1); assert.equal(s.stats.length, 0, 'no synchronous statistics scan before IPC returns');
  assert.equal(s.cleanups, 1, 'interrupted deletion cleanup is still retried');
  await s.drain();
  assert.equal(s.stats.length, 1); assert.equal(s.stats[0].notes, notes, 'reuse the successful snapshot, no second vault read');
  assert.deepEqual(s.locks, [['/synthetic/vault', '/synthetic/state']]);
  await s.invoke(); await s.drain();
  assert.equal(s.reads, 2, 'later reads remain authoritative, not a startup array cache');
  assert.equal(s.stats.length, 1, 'completed startup maintenance is not repeated per load'); groups++;
}
{
  const s = scenario(); s.setRead(async () => { throw Error('original unreadable'); });
  await assert.rejects(s.invoke(), /original unreadable/);
  assert.equal(s.scheduled.length, 0); assert.equal(s.cleanups, 0);
  s.setRead(async () => []);
  assert.deepEqual(await s.invoke(), []); await s.drain();
  assert.equal(s.stats.length, 1, 'a successful retry, including an empty vault, can recover statistics'); groups++;
}
{
  const s = scenario(), gate = deferred<unknown[]>();
  s.setRead(() => gate.promise);
  const a = s.invoke(), b = s.invoke(); gate.resolve([]);
  await Promise.all([a, b]); assert.equal(s.scheduled.length, 1);
  const blocked = deferred(); s.setBackfill(async () => { await blocked.promise; throw Error('statistics damaged'); });
  await s.drain(); assert.equal(s.errors, 0);
  assert.deepEqual(await s.invoke(), [], 'IPC does not explicitly await a statistics job (source locking is checked below)');
  assert.equal(s.scheduled.length, 0, 'concurrent maintenance is deduplicated');
  blocked.resolve(); await tick(); assert.equal(s.errors, 1);
  s.setBackfill(async (directory, notes) => { s.stats.push({ directory, notes }); });
  await s.invoke(); await s.drain(); assert.equal(s.stats.length, 1, 'failure does not consume the retry opportunity'); groups++;
}
for (const change of ['epoch', 'root', 'directory', 'suspended', 'exiting'] as const) {
  const s = scenario(); await s.invoke();
  if (change === 'epoch') s.state.epoch++;
  else if (change === 'root' || change === 'directory') s.state[change] += '-new';
  else s.state[change] = true;
  await s.drain(); assert.equal(s.stats.length, 0, `${change} invalidates queued startup work`); groups++;
}
{
  const s = scenario(), gate = deferred();
  s.setTransaction(async (roots, run) => { s.locks.push(roots); await gate.promise; await run(); });
  await s.invoke(); await s.drain(); s.state.epoch++; gate.resolve(); await tick();
  assert.equal(s.stats.length, 0, 'recheck epoch after acquiring the saved-source transaction');
  s.setTransaction(async (_roots, run) => { await run(); });
  await s.invoke(); await s.drain(); assert.equal(s.stats.length, 1, 'new environment can recover independently'); groups++;
}
{
  const s = scenario(); await s.invoke(); await s.drain();
  s.setRead(async () => [{ id: 'new', content: 'saved after a deletion' }]);
  assert.deepEqual(await s.invoke(), [{ id: 'new', content: 'saved after a deletion' }]);
  s.state.epoch++; await s.invoke(); await s.drain();
  assert.equal(s.stats.length, 2, 'a reset epoch does not inherit the completed flag'); groups++;
}
{
  const s = scenario(), gate = deferred();
  s.setRead(() => withRagSourceTransaction([s.state.root, s.state.directory], async () => []));
  s.setTransaction(withRagSourceTransaction);
  s.setBackfill(async () => { await gate.promise; });
  await s.invoke(); await s.drain();
  let secondReturned = false;
  const second = s.invoke().then(() => { secondReturned = true; });
  await tick(); assert.equal(secondReturned, false, 'later authoritative IO still respects the saved-source transaction');
  gate.resolve(); await second;
  assert.equal(secondReturned, true); assert.equal(s.reads, 2); groups++;
}
{
  let errors = 0;
  const task = createStartupSnapshotTask({ scope: () => 'current', run: async () => {},
    schedule: () => { throw Error('scheduler unavailable'); }, onError: () => { errors++; throw Error('logging unavailable'); } });
  assert.doesNotThrow(() => task.offer('current', []));
  assert.doesNotThrow(() => task.offer('current', [])); assert.equal(errors, 2); groups++;
}
// Verify actual startup wiring without importing Electron or starting any service.
const ready = find((node): node is ts.CallExpression => ts.isCallExpression(node)
  && node.expression.getText(source) === 'app.whenReady().then');
const readyText = ready.arguments[0].getText(source);
assert.doesNotMatch(readyText, /\bloadMergedNotes\s*\(/, 'startup must not separately reread the vault for statistics');
assert.doesNotMatch(readyText, /\binitSympyServer\s*\(/, 'no unconditional math startup');
for (const required of ['recoverProcessingDocs()', 'retryDeletedNoteIndexCleanup()', 'deferredNoteIndex.request()', 'createWindow()']) {
  assert.ok(readyText.includes(required), `${required} recovery wiring preserved`);
}
groups++;
console.log(`Startup snapshot maintenance: ${groups} groups passed (memory-only, no application or private vault).`);
