import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import type { ComputeIpcResponse } from '../src/types';

// Execute the actual service module with a closed require allowlist. Neither
// Electron, Python, taskkill nor the production owned-process helper can load.
type Api = typeof import('../src/electron/sympyServer');
type Wire = { id: string; cmd: string; args: Record<string, unknown> };
const source = readFileSync('src/electron/sympyServer.ts', 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
} }).outputText;
const settle = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
let groups = 0;
const pass = (name: string) => { groups++; console.log(`PASS ${name}`); };

class Clock {
  now = 0;
  next = 0;
  timers = new Map<number, { due: number; run: () => void }>();
  setTimeout = (run: () => void, delay: number) => {
    const id = ++this.next; this.timers.set(id, { due: this.now + delay, run }); return id;
  };
  clearTimeout = (id: number) => { this.timers.delete(id); };
  async advance(milliseconds: number) {
    const end = this.now + milliseconds;
    while (true) {
      const next = [...this.timers].filter(([, timer]) => timer.due <= end)
        .sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
      if (!next) break;
      this.now = next[1].due; this.timers.delete(next[0]); next[1].run(); await settle();
    }
    this.now = end; await settle();
  }
}

class FakeChild extends EventEmitter {
  pid: number | undefined;
  killed = false;
  exitCode: number | null = null;
  signalCode: string | null = null;
  killCalls = 0;
  writes: Wire[] = [];
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = Object.assign(new EventEmitter(), { write: (text: string) => {
    if (this.throwWrite) throw Error('synthetic pipe write failure');
    this.writes.push(JSON.parse(text)); return true;
  } });
  throwWrite = false;
  constructor(pid: number) { super(); this.pid = pid; }
  reply(wire: Wire, response: Record<string, unknown> = { ok: true, result: { value: 'fixture' } }) {
    this.stdout.emit('data', JSON.stringify({ id: wire.id, ...response }) + '\n');
  }
  finish(code = 0) { this.exitCode = code; this.emit('exit', code, null); }
  kill() { this.killCalls++; this.killed = true; this.finish(); return true; }
}

function fixture(options: { packaged?: boolean; spawnThrows?: number; stopFailures?: number } = {}) {
  const clock = new Clock(), children: FakeChild[] = [], spawns: Array<{ cmd: string; args: string[]; options: any }> = [];
  const stops: FakeChild[] = [];
  const module = { exports: {} };
  const requireMock = (name: string) => {
    if (name === 'child_process') return { spawn(cmd: string, args: string[], spawnOptions: any) {
      spawns.push({ cmd, args, options: spawnOptions });
      if (options.spawnThrows) { options.spawnThrows--; throw Error('synthetic spawn failure'); }
      const child = new FakeChild(1000 + children.length); children.push(child); return child;
    } };
    if (name === 'path') return path;
    if (name === 'electron') return { app: { isPackaged: options.packaged === true, getAppPath: () => 'synthetic-app' } };
    if (name === '../types') return { COMPUTE_TIMEOUT_MS: 15000 };
    if (name === './ownedProcessShutdown') return { async stopOwnedProcess(child?: FakeChild) {
      if (!child || child.exitCode !== null) return;
      stops.push(child);
      if (options.stopFailures) { options.stopFailures--; throw Error('synthetic stop failure'); }
      child.kill();
    } };
    throw Error(`Forbidden real dependency: ${name}`);
  };
  const context = vm.createContext({ module, exports: module.exports, require: requireMock,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    Buffer, process: { env: {}, resourcesPath: 'synthetic-resources' }, console: { log() {}, warn() {} } });
  new vm.Script(compiled, { filename: 'sympyServer.actual-module.cjs' }).runInContext(context);
  return { api: module.exports as Api, clock, children, spawns, stops };
}

async function ready(f: ReturnType<typeof fixture>) {
  const pending = f.api.runSympyCommand('ping', { marker: 'first-feature-call' });
  await settle();
  const child = f.children.at(-1)!;
  assert.equal(child.writes.length, 1, 'only startup ping may be sent before ready');
  assert.match(child.writes[0].id, /^warmup-/);
  child.reply(child.writes[0]); await settle();
  const feature = child.writes.at(-1)!;
  assert.match(feature.id, /^req-/); child.reply(feature);
  assert.equal((await pending).ok, true);
  return child;
}

{
  const f = fixture();
  assert.equal(f.api.getSympyStatus().ready, false);
  assert.equal(f.api.getSympyStatus().warming, false);
  await f.clock.advance(120000);
  assert.equal(f.spawns.length, 0, 'loading/status/idle must never spawn');
  const closeIdle = await f.api.runSympyCommand('session_close', { sessionId: 'never-created' });
  assert.equal(closeIdle.ok, true); assert.equal((closeIdle.result as { ok: boolean }).ok, true);
  assert.equal(f.spawns.length, 0, 'idle cleanup must not initialize a service');
  const calls = [f.api.runSympyCommand('ping', { n: 1 }), f.api.runSympyCommand('ping', { n: 2 })];
  assert.equal(f.api.getSympyStatus().warming, true);
  await settle(); assert.equal(f.spawns.length, 1);
  const child = f.children[0]; assert.equal(child.writes.length, 1);
  child.stdout.emit('data', 'not JSON\nnull\n"debug value"\n');
  const line = JSON.stringify({ id: child.writes[0].id, ok: true, result: {} }) + '\n';
  child.stdout.emit('data', line.slice(0, 12)); await settle(); assert.equal(child.writes.length, 1);
  child.stdout.emit('data', line.slice(12)); await settle();
  assert.equal(child.writes.length, 3, 'both feature commands follow one successful warmup');
  assert.deepEqual(child.writes.slice(1).map(wire => wire.args.n), [1, 2]);
  child.reply(child.writes[2], { ok: true, result: 2 }); child.reply(child.writes[1], { ok: true, result: 1 });
  assert.deepEqual((await Promise.all(calls)).map(response => response.result), [1, 2]);
  assert.equal(f.api.getSympyStatus().ready, true);
  assert.equal(f.spawns[0].cmd, 'python');
  assert.equal(f.spawns[0].args[0], path.join('synthetic-app', 'python', 'sympy_server.py'));
  assert.equal(f.spawns[0].options.windowsHide, true);
  await f.api.disposeSympyServer(); assert.equal(f.clock.timers.size, 0);
  pass('idle/status never spawn; concurrent first requests share one ping and preserve NDJSON IDs/partial lines');
}

{
  const f = fixture({ packaged: true }); await ready(f);
  assert.equal(f.spawns[0].cmd, path.join('synthetic-resources', 'sympy_server', 'sympy_server.exe'));
  assert.equal(f.spawns[0].args.length, 0);
  await f.api.disposeSympyServer();
  pass('packaged command retains the resource executable path and original wire protocol');
}

{
  const f = fixture(), child = await ready(f);
  const request = f.api.runSympyCommand('session_step', { sessionId: 'fixture-session', expression: 'x + 1' });
  await settle(); const wire = child.writes.at(-1)!;
  assert.equal(wire.cmd, 'session_step'); assert.equal(wire.args.sessionId, 'fixture-session');
  child.reply(wire, { ok: false, error: 'fixture validation error', errorCode: 'INVALID_ARGUMENT' });
  const response = await request;
  assert.equal(response.ok, false); assert.equal(response.errorCode, 'INVALID_ARGUMENT');
  assert.equal(response.error, 'fixture validation error'); assert.equal(f.api.getSympyStatus().ready, true);
  assert.equal(f.spawns.length, 1); await f.api.disposeSympyServer();
  pass('S4 session commands, arguments and structured computation errors pass through without retiring a healthy service');
}

{
  const f = fixture();
  const initialization = f.api.runSympyCommand('session_init', { sessionId: 'cancelled-during-warmup', symbols: [] });
  await settle(); const child = f.children[0];
  const earlyClose = await f.api.runSympyCommand('session_close', { sessionId: 'cancelled-during-warmup' });
  assert.equal(earlyClose.ok, true); assert.equal(child.writes.length, 1);
  assert.equal(f.api.getSympyStatus().warming, true, 'cleanup does not wait for or interrupt startup');
  child.reply(child.writes[0]); await settle();
  assert.equal(child.writes[1].cmd, 'session_init');
  child.reply(child.writes[1]); assert.equal((await initialization).ok, true);
  const actualClose = f.api.runSympyCommand('session_close', { sessionId: 'cancelled-during-warmup' });
  await settle(); assert.equal(child.writes[2].cmd, 'session_close');
  assert.equal(child.writes[2].args.sessionId, 'cancelled-during-warmup');
  child.reply(child.writes[2], { ok: true, result: { ok: true } }); assert.equal((await actualClose).ok, true);
  assert.equal(f.spawns.length, 1); await f.api.disposeSympyServer();
  pass('warming cleanup is an immediate no-op; late cleanup after session_init reaches the existing ready process');
}

for (const mode of ['sync-spawn', 'async-spawn', 'ping-error', 'ping-timeout', 'invalid-ping', 'pipe-error'] as const) {
  const f = fixture({ spawnThrows: mode === 'sync-spawn' ? 1 : 0 });
  const calls = [f.api.runSympyCommand('ping', {}), f.api.runSympyCommand('ping', {})];
  await settle();
  const old = f.children[0];
  if (mode === 'async-spawn') { old.pid = undefined; old.emit('error', Error('synthetic ENOENT')); }
  if (mode === 'ping-error') old.reply(old.writes[0], { ok: false, error: 'synthetic warmup failure' });
  if (mode === 'invalid-ping') old.reply(old.writes[0], { result: 'missing ok must not become ready' });
  if (mode === 'pipe-error') old.stdin.emit('error', Error('synthetic EPIPE'));
  if (mode === 'ping-timeout') {
    await f.clock.advance(29999); assert.equal(f.api.getSympyStatus().warming, true);
    await f.clock.advance(1);
  }
  const responses = await Promise.all(calls);
  assert(responses.every(response => response.ok === false && response.errorCode === 'SERVICE_DOWN'));
  assert.equal(f.api.getSympyStatus().warming, false);
  assert.equal((await f.api.runSympyCommand('session_close', { sessionId: 'failed-session' })).ok, true);
  await f.clock.advance(120000); assert.equal(f.spawns.length, 1, 'failure never starts an idle retry loop');
  await ready(f); assert.equal(f.spawns.length, 2, 'the next real request retries a failed startup');
  await f.api.disposeSympyServer(); assert.equal(f.clock.timers.size, 0);
  pass(`startup ${mode} resolves all callers and allows one explicit retry without hanging`);
}

{
  const f = fixture(), old = await ready(f);
  const active = f.api.runSympyCommand('ping', {}); await settle();
  old.finish(9); assert.equal((await active).errorCode, 'SERVICE_DOWN');
  assert.equal((await f.api.runSympyCommand('session_close', { sessionId: 'crashed-session' })).ok, true);
  await f.clock.advance(120000); assert.equal(f.spawns.length, 1);
  const again = f.api.runSympyCommand('ping', {}); await settle(); const current = f.children[1];
  const warmup = current.writes[0];
  old.stdout.emit('data', JSON.stringify({ id: warmup.id, ok: true }) + '\n');
  old.emit('error', Error('late retired error')); old.emit('exit', 9, null);
  await settle(); assert.equal(current.writes.length, 1); assert.equal(f.api.getSympyStatus().warming, true);
  current.reply(warmup); await settle(); current.reply(current.writes[1]); assert.equal((await again).ok, true);
  assert.equal(f.api.getSympyStatus().ready, true);
  await f.api.disposeSympyServer();
  pass('crash rejects active work; after the mocked full-stop receipt demand restarts once; retired events cannot corrupt its successor');
}

{
  const f = fixture(), child = await ready(f);
  const timedOut: ComputeIpcResponse[] = [];
  for (let i = 0; i < 3; i++) {
    const request = f.api.runSympyCommand('ping', {}); await settle();
    await f.clock.advance(15000); timedOut.push(await request);
  }
  assert(timedOut.every(response => response.errorCode === 'TIMEOUT'));
  assert.equal(child.killCalls, 1); assert.equal(f.api.getSympyStatus().ready, false);
  await f.clock.advance(120000); assert.equal(f.spawns.length, 1);
  await ready(f); assert.equal(f.spawns.length, 2);
  await f.api.disposeSympyServer(); assert.equal(f.clock.timers.size, 0);
  pass('three consecutive request timeouts retire the hung process, with no duplicate computation or idle restart');
}

{
  const f = fixture(), child = await ready(f);
  const first = f.api.runSympyCommand('ping', {}); await settle(); await f.clock.advance(15000); await first;
  const success = f.api.runSympyCommand('ping', {}); await settle(); child.reply(child.writes.at(-1)!); await success;
  for (let i = 0; i < 2; i++) {
    const request = f.api.runSympyCommand('ping', {}); await settle(); await f.clock.advance(15000); await request;
  }
  assert.equal(child.killCalls, 0, 'a real response resets the consecutive-timeout streak');
  child.throwWrite = true;
  assert.equal((await f.api.runSympyCommand('ping', {})).errorCode, 'SERVICE_DOWN');
  await ready(f); await f.api.disposeSympyServer();
  pass('successful responses reset timeout streak; synchronous stdin failures are retryable');
}

for (const phase of ['before-spawn', 'warming', 'ready', 'crashed'] as const) {
  const f = fixture();
  let pending: Promise<ComputeIpcResponse> | undefined;
  let child: FakeChild | undefined;
  if (phase === 'before-spawn' || phase === 'warming') pending = f.api.runSympyCommand('ping', {});
  if (phase === 'warming') { await settle(); child = f.children[0]; }
  if (phase === 'ready' || phase === 'crashed') child = await ready(f);
  if (phase === 'crashed') child!.finish(3);
  await f.api.disposeSympyServer();
  if (pending) assert.equal((await pending).errorCode, 'SERVICE_DOWN');
  if (child) { child.emit('exit', 2, null); child.emit('error', Error('late after dispose')); }
  const count = f.spawns.length;
  await f.clock.advance(120000);
  assert.equal((await f.api.runSympyCommand('session_close', { sessionId: 'exiting-session' })).ok, true);
  await f.api.initSympyServer(); assert.equal((await f.api.runSympyCommand('ping', {})).errorCode, 'SERVICE_DOWN');
  assert.equal(f.spawns.length, count); assert.equal(f.api.getSympyStatus().ready, false);
  assert.equal(f.api.getSympyStatus().warming, false); assert.equal(f.clock.timers.size, 0);
  pass(`dispose during ${phase} cancels callers/timers and permanently prevents resurrection`);
}

{
  const f = fixture({ stopFailures: 2 }), old = await ready(f);
  old.stdin.emit('error', Error('synthetic pipe failure')); await settle();
  assert.equal((await f.api.runSympyCommand('ping', {})).errorCode, 'SERVICE_DOWN');
  assert.equal(f.spawns.length, 1, 'unconfirmed old process stop cannot spawn a second process');
  await ready(f); assert.equal(old.killCalls, 1);
  await f.api.disposeSympyServer();
  pass('failed owned-process stopping retains its handle and blocks overlapping replacement until retry succeeds');
}

console.log(`SymPy lifecycle: ${groups} groups passed. Only synthetic processes/timers; no Python, Electron, network or user data.`);
