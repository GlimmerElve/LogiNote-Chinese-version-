import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import type { ComputeIpcResponse } from '../src/types';

// Exercise BOTH actual modules. Only OS processes, Electron paths, constants and
// timers are synthetic; never replace the production owned-process stop helper.
type SympyApi = typeof import('../src/electron/sympyServer');
type OwnedApi = typeof import('../src/electron/ownedProcessShutdown');
type Wire = { id: string; cmd: string; args: Record<string, unknown> };
const compile = (file: string) => ts.transpileModule(readFileSync(file, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText;
const serviceCode = compile('src/electron/sympyServer.ts');
const ownedCode = compile('src/electron/ownedProcessShutdown.ts');
const settle = async () => { for (let i = 0; i < 48; i++) await Promise.resolve(); };

class Clock {
  now = 0;
  next = 0;
  timers = new Map<number, { at: number; run: () => void }>();
  setTimeout = (run: () => void, delay: number) => {
    const id = ++this.next; this.timers.set(id, { at: this.now + delay, run }); return id;
  };
  clearTimeout = (id: number) => { this.timers.delete(id); };
  async advance(milliseconds: number) {
    const end = this.now + milliseconds;
    while (true) {
      const next = [...this.timers].filter(([, t]) => t.at <= end)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      this.now = next[1].at; this.timers.delete(next[0]); next[1].run(); await settle();
    }
    this.now = end; await settle();
  }
}

class FakeMath extends EventEmitter {
  exitCode: number | null = null;
  signalCode: string | null = null;
  killed = false;
  killCalls = 0;
  finishOnKill = true;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  writes: Wire[] = [];
  stdin = Object.assign(new EventEmitter(), { write: (text: string) => { this.writes.push(JSON.parse(text)); return true; } });
  constructor(public pid: number) { super(); }
  reply(wire: Wire, result: unknown = { pong: true }) {
    this.stdout.emit('data', JSON.stringify({ id: wire.id, ok: true, result }) + '\n');
  }
  finish(code = 0) { if (this.exitCode !== null) return; this.exitCode = code; this.emit('exit', code, null); }
  kill() { this.killCalls++; this.killed = true; if (this.finishOnKill) this.finish(); return true; }
}

class FakeTaskkill extends EventEmitter {
  exitCode: number | null = null;
  killed = false;
  constructor(public pid: number, public targetPid: number) { super(); }
  finish(code = 0) { if (this.exitCode !== null) return; this.exitCode = code; this.emit('exit', code, null); }
  // A hung utility does not produce an invented success receipt on cancellation.
  kill() { this.killed = true; return true; }
}

function watch<T>(promise: Promise<T>) {
  const state: { status: 'pending' | 'fulfilled' | 'rejected'; value?: T; error?: unknown } = { status: 'pending' };
  void promise.then(value => { state.status = 'fulfilled'; state.value = value; }, error => {
    state.status = 'rejected'; state.error = error;
  });
  return state;
}

function fixture() {
  const clock = new Clock(), children: FakeMath[] = [], trees: FakeTaskkill[] = [];
  const newChild = () => { const child = new FakeMath(3000 + children.length); children.push(child); return child; };
  const spawn = (command: string, args: string[], options: any) => {
    assert.equal(options.windowsHide, true, 'synthetic services must retain hidden-window launch options');
    if (command === 'taskkill.exe') {
      assert.deepEqual(Array.from(args), ['/PID', args[1], '/T', '/F']);
      const pid = Number(args[1]); assert.ok(children.some(c => c.pid === pid), 'only an owned PID is ever targeted');
      const tree = new FakeTaskkill(6000 + trees.length, pid); trees.push(tree); return tree;
    }
    assert.equal(command, 'python', 'no real or unexpected process can be started by this VM');
    assert.equal(args[0], path.join('synthetic-app', 'python', 'sympy_server.py'));
    return newChild();
  };
  class ClockDate extends Date { static now() { return clock.now; } }
  const common = { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, Date: ClockDate, Buffer,
    process: { platform: 'win32', env: {}, resourcesPath: 'synthetic-resources' }, console: { warn() {}, log() {} } };
  const ownedModule = { exports: {} };
  new vm.Script(ownedCode, { filename: 'ownedProcessShutdown.actual.cjs' }).runInNewContext({
    ...common, module: ownedModule, exports: ownedModule.exports,
    require: (name: string) => {
      assert.equal(name, 'node:child_process', `forbidden real dependency in stop helper: ${name}`);
      return { spawn };
    },
  });
  const serviceModule = { exports: {} };
  new vm.Script(serviceCode, { filename: 'sympyServer.actual.cjs' }).runInNewContext({
    ...common, module: serviceModule, exports: serviceModule.exports,
    require: (name: string) => {
      if (name === 'child_process') return { spawn };
      if (name === 'path') return path;
      if (name === 'electron') return { app: { isPackaged: false, getAppPath: () => 'synthetic-app' } };
      if (name === '../types') return { COMPUTE_TIMEOUT_MS: 15000 };
      if (name === './ownedProcessShutdown') return ownedModule.exports;
      throw Error(`forbidden real dependency in service: ${name}`);
    },
  });
  return { api: serviceModule.exports as SympyApi, owned: ownedModule.exports as OwnedApi,
    clock, children, trees, newChild };
}

async function answerFirstUse(f: ReturnType<typeof fixture>, count: number, calls: ReturnType<typeof watch<ComputeIpcResponse>>[]) {
  await settle();
  assert.equal(f.children.length, count, 'at most one next generation can be spawned');
  const child = f.children.at(-1)!;
  assert.equal(child.writes.length, 1, 'functional requests must wait for the shared startup ping');
  assert.match(child.writes[0].id, /^warmup-/);
  child.reply(child.writes[0]); await settle();
  const requests = child.writes.filter(wire => wire.id.startsWith('req-'));
  assert.equal(requests.length, calls.length);
  for (const request of requests) child.reply(request, { marker: request.args.marker });
  await settle();
  assert.ok(calls.every(call => call.status === 'fulfilled' && call.value?.ok), 'every independent request gets its response');
  assert.equal(f.clock.timers.size, 0);
  return child;
}

async function ready(f: ReturnType<typeof fixture>) {
  const call = watch(f.api.runSympyCommand('ping', { marker: 'first-use' }));
  return answerFirstUse(f, 1, [call]);
}
async function retire(f: ReturnType<typeof fixture>, child: FakeMath) {
  child.stdin.emit('error', Error('synthetic broken pipe')); await settle();
  assert.equal(f.trees.length, 1, 'a service failure starts exactly one owned-tree stop');
  assert.equal(f.trees[0].targetPid, child.pid);
}
async function disposeReady(f: ReturnType<typeof fixture>) {
  const call = watch(f.api.disposeSympyServer()); await settle();
  for (let round = 0; round < 3 && call.status === 'pending'; round++) {
    for (const tree of f.trees) if (tree.exitCode === null) tree.finish(0);
    for (const child of f.children) if (child.exitCode === null) child.finish(0);
    await settle();
  }
  assert.equal(call.status, 'fulfilled'); assert.equal(f.clock.timers.size, 0);
}

let groups = 0;
const failures: string[] = [];
async function check(name: string, run: () => Promise<void>) {
  try { await run(); groups++; console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`); }
}

await check('first demand remains lazy; concurrent startup uses one process and one ping', async () => {
  const f = fixture(); await f.clock.advance(120000);
  assert.equal(f.children.length, 0); assert.equal(f.trees.length, 0);
  const calls = [1, 2, 3].map(marker => watch(f.api.runSympyCommand('ping', { marker })));
  await answerFirstUse(f, 1, calls); await disposeReady(f);
});

await check('parent exit cannot release the original tree barrier; concurrent retries spawn only after confirmation', async () => {
  const f = fixture(), old = await ready(f); await retire(f, old);
  old.finish(7); await settle();
  const calls = [1, 2, 3].map(marker => watch(f.api.runSympyCommand('ping', { marker })));
  await settle();
  assert.equal(f.children.length, 1, 'retry must wait for the original taskkill receipt after parent exit');
  assert.equal(f.trees.length, 1, 'do not re-kill an exited PID or replace the original in-flight stop');
  assert.ok(calls.every(call => call.status === 'pending'));
  f.trees[0].finish(0);
  await answerFirstUse(f, 2, calls); await disposeReady(f);
});

await check('dispose waits for the same original tree stop after parent exit', async () => {
  const f = fixture(), old = await ready(f); await retire(f, old);
  old.finish(7); await settle();
  const stopped = watch(f.api.disposeSympyServer()); await settle();
  assert.equal(stopped.status, 'pending', 'normal exit cannot report the unconfirmed process tree as stopped');
  assert.equal(f.trees.length, 1, 'dispose must join the already accepted tree stop');
  f.trees[0].finish(0); await settle();
  assert.equal(stopped.status, 'fulfilled'); assert.equal(f.children.length, 1);
  assert.equal(f.clock.timers.size, 0);
});

await check('actual strict stop helper keeps its in-flight Promise even after root exit', async () => {
  const f = fixture(), child = f.newChild();
  const options = { requireTreeStop: true };
  const original = f.owned.stopOwnedProcess(child, options);
  const receipt = watch(original); await settle();
  child.finish(0); await settle();
  const joined = watch(f.owned.stopOwnedProcess(child, options)); await settle();
  assert.equal(joined.status, 'pending', 'root exit must not bypass the outstanding stop Promise');
  assert.equal(receipt.status, 'pending'); assert.equal(f.trees.length, 1);
  f.trees[0].finish(0); await settle(); assert.equal(receipt.status, 'fulfilled'); assert.equal(joined.status, 'fulfilled');
  assert.equal(f.clock.timers.size, 0);
});

await check('tree confirmation alone cannot release retries before parent exit', async () => {
  const f = fixture(), old = await ready(f); await retire(f, old);
  const call = watch(f.api.runSympyCommand('ping', { marker: 'wait-for-root' }));
  f.trees[0].finish(0); await settle();
  assert.equal(f.children.length, 1); assert.equal(call.status, 'pending');
  old.finish(0); await answerFirstUse(f, 2, [call]); await disposeReady(f);
});

await check('an exited parent plus failed tree stop stays failed without targeting a reusable old PID', async () => {
  const f = fixture(), old = await ready(f); await retire(f, old);
  old.finish(7); f.trees[0].finish(2); await settle();
  const call = watch(f.api.runSympyCommand('ping', {})); await settle();
  assert.equal(f.children.length, 1, 'a failed tree stop must not admit a replacement process');
  assert.equal(call.status, 'fulfilled'); assert.equal(call.value?.ok, false);
  assert.equal(call.value?.errorCode, 'SERVICE_DOWN'); assert.ok(call.value?.error);
  const stopped = watch(f.api.disposeSympyServer()); await settle();
  assert.equal(stopped.status, 'rejected', 'normal exit must expose an unconfirmed tree stop');
  assert.equal(f.trees.length, 1, 'never issue a second taskkill against the already-exited old PID');
  await f.clock.advance(120000);
  assert.equal(f.children.length, 1); assert.equal(f.trees.length, 1); assert.equal(f.clock.timers.size, 0);
});

await check('an exited parent plus timed-out tree stop cannot become a false success or idle restart', async () => {
  const f = fixture(), old = await ready(f); await retire(f, old);
  old.finish(7); await f.clock.advance(5000);
  const call = watch(f.api.runSympyCommand('ping', {})); await settle();
  assert.equal(call.status, 'pending', 'the underlying timed-out utility still has no exit receipt');
  await f.clock.advance(4000);
  assert.equal(f.children.length, 1); assert.equal(call.status, 'fulfilled'); assert.equal(call.value?.ok, false);
  const stopped = watch(f.api.disposeSympyServer()); await settle();
  assert.equal(stopped.status, 'pending'); await f.clock.advance(4000);
  assert.equal(stopped.status, 'rejected'); assert.equal(f.trees.length, 1);
  f.trees[0].finish(2); await settle();
  await f.clock.advance(120000); assert.equal(f.children.length, 1); assert.equal(f.trees.length, 1);
  assert.equal(f.clock.timers.size, 0);
});

await check('a late positive tree receipt permits the next explicit demand without reusing the exited parent PID', async () => {
  const f = fixture(), old = await ready(f); await retire(f, old);
  old.finish(7); await f.clock.advance(5000);
  assert.equal(f.trees[0].killed, true); assert.equal(f.trees[0].exitCode, null);
  assert.equal(f.children.length, 1);
  f.trees[0].finish(0); await settle();
  assert.equal(f.children.length, 1, 'a late successful receipt must not itself start an idle replacement');
  const retry = watch(f.api.runSympyCommand('ping', { marker: 'confirmed-after-timeout' }));
  await answerFirstUse(f, 2, [retry]);
  assert.equal(f.trees.filter(tree => tree.targetPid === old.pid).length, 1, 'reuse the original positive receipt, never target the old PID again');
  await disposeReady(f);
});

await check('natural parent exit without any tree receipt fails closed instead of claiming orphan-free crash recovery', async () => {
  const f = fixture(), old = await ready(f); old.finish(3); await settle();
  assert.equal(f.trees.length, 0, 'an already-exited parent PID must never be targeted');
  const retry = watch(f.api.runSympyCommand('ping', {})); await settle();
  assert.equal(retry.status, 'fulfilled'); assert.equal(retry.value?.ok, false);
  assert.equal(retry.value?.errorCode, 'SERVICE_DOWN'); assert.ok(retry.value?.error);
  const stopped = watch(f.api.disposeSympyServer()); await settle();
  assert.equal(stopped.status, 'rejected', 'without tree evidence normal exit cannot report complete cleanup');
  await f.clock.advance(120000);
  assert.equal(f.children.length, 1); assert.equal(f.trees.length, 0); assert.equal(f.clock.timers.size, 0);
});

for (const failure of ['nonzero', 'timeout'] as const) {
  await check(`a still-live parent permits explicit safe stop retry after ${failure}, never an overlapping generation`, async () => {
    const f = fixture(), old = await ready(f); old.finishOnKill = false; await retire(f, old);
    if (failure === 'nonzero') f.trees[0].finish(2);
    else {
      await f.clock.advance(5000);
      assert.equal(f.trees[0].killed, true, 'timeout cancels only the owned taskkill utility');
      f.trees[0].finish(2); // Confirm that the timed-out utility itself has now stopped.
    }
    await settle(); assert.equal(old.exitCode, null);
    const call = watch(f.api.runSympyCommand('ping', { marker: failure })); await settle();
    assert.equal(f.children.length, 1, 'safe retry cannot spawn while the original parent is still alive');
    assert.equal(f.trees.length, 2, 'an explicit retry may re-target the still-owned live parent');
    assert.equal(f.trees[1].targetPid, old.pid);
    assert.equal(call.status, 'pending');
    f.trees[1].finish(0); old.finish(0);
    await answerFirstUse(f, 2, [call]); await disposeReady(f);
  });
}

await check('timeout without a taskkill exit receipt cannot overlap stop commands, even across explicit retries', async () => {
  const f = fixture(), old = await ready(f); old.finishOnKill = false; await retire(f, old);
  await f.clock.advance(5000);
  assert.equal(f.trees[0].killed, true); assert.equal(f.trees[0].exitCode, null);
  const calls = [1, 2].map(marker => watch(f.api.runSympyCommand('ping', { marker })));
  await settle();
  assert.equal(f.children.length, 1); assert.equal(f.trees.length, 1);
  assert.ok(calls.every(call => call.status === 'pending'));
  f.trees[0].finish(2); await settle();
  assert.ok(calls.every(call => call.status === 'fulfilled' && call.value?.ok === false));
  assert.equal(f.children.length, 1); assert.equal(f.trees.length, 1);
  const retry = watch(f.api.runSympyCommand('ping', { marker: 'safe-explicit-retry' })); await settle();
  assert.equal(f.trees.length, 2); assert.equal(f.children.length, 1);
  f.trees[1].finish(0); old.finish(0);
  await answerFirstUse(f, 2, [retry]); await disposeReady(f);
});

await check('taskkill errors during timeout cleanup retain the receipt without recursive signals or overlapping retries', async () => {
  const f = fixture(), old = await ready(f); await retire(f, old);
  const command = f.trees[0]; let signals = 0;
  command.kill = () => {
    signals++; command.killed = true;
    command.emit('error', Error('synthetic taskkill signal failure'));
    return false;
  };
  command.emit('error', Error('synthetic running taskkill error')); await settle();
  const failed = watch(f.api.runSympyCommand('ping', {})); await settle();
  assert.equal(failed.status, 'pending'); assert.equal(signals, 0);
  await f.clock.advance(5000);
  assert.equal(signals, 1, 'error handling must not recursively signal the utility');
  assert.equal(f.children.length, 1); assert.equal(f.trees.length, 1);
  assert.equal(failed.value?.ok, false);
  command.finish(2); await settle();
  const retry = watch(f.api.runSympyCommand('ping', {})); await settle();
  assert.equal(f.trees.length, 2, 'only a finished utility and still-live parent allow a fresh stop attempt');
  f.trees[1].finish(0); old.finish(0);
  await answerFirstUse(f, 2, [retry]); await disposeReady(f);
});

await check('dispose racing queued retries cannot spawn a new generation after tree completion', async () => {
  const f = fixture(), old = await ready(f); await retire(f, old); old.finish(7);
  const calls = [1, 2].map(marker => watch(f.api.runSympyCommand('ping', { marker })));
  await settle(); const stopped = watch(f.api.disposeSympyServer()); await settle();
  assert.equal(f.children.length, 1); assert.equal(stopped.status, 'pending');
  f.trees[0].finish(0); await settle();
  assert.equal(stopped.status, 'fulfilled'); assert.equal(f.children.length, 1);
  assert.ok(calls.every(call => call.status === 'fulfilled' && call.value?.ok === false));
  assert.equal(f.clock.timers.size, 0);
});

await check('default non-math stop behavior retains its original parent-exit fallback', async () => {
  const f = fixture(), child = f.newChild();
  const stopped = watch(f.owned.stopOwnedProcess(child)); await settle();
  child.finish(0); f.trees[0].finish(2); await settle();
  assert.equal(stopped.status, 'fulfilled', 'strict math policy must not silently change other service stop semantics');
  assert.equal(f.clock.timers.size, 0);
});

if (failures.length) {
  console.error(`SymPy stop barrier: ${groups} passed, ${failures.length} failed.`);
  process.exitCode = 1;
} else {
  console.log(`SymPy stop barrier: ${groups} groups passed. Actual service + actual stop helper; synthetic Windows processes/timers only.`);
}
