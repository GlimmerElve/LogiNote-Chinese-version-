/** Production deadlines/SSE parser with virtual time and synthetic transport. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { createLlmStreamTimeout, normalizeLlmStreamTimeoutPolicy, LlmStreamTimeoutError, type LlmStreamTimeoutClock } from '../src/electron/llmStreamTimeout';
import { requireLlmModel } from '../src/services/llmModelSelection';
import { manualThinkingTimeoutMs, resolveLlmThinkingPolicy } from '../src/services/llmThinkingPolicy';
import { resolveLlmOutputBudget } from '../src/services/llmOutputBudget';
import { buildLlmHttpRequest } from '../src/electron/apiHandlers';
import * as streamToolHelpers from '../src/electron/llmStreamToolCalls';
import { retainLlmToolContinuation } from '../src/electron/llmToolContinuations';
import { sanitizeUnicode } from '../src/services/unicode';
import { ensureJsonObjectPrompt, requestsJsonObject } from '../src/workflows/structuredOutput';
import { ProgressiveLearningStore } from '../src/electron/progressiveLearningStore';
import { createProgressiveController, type ProgressiveStorageAdapter } from '../src/services/progressiveLearning/runtime';
import type { LlmStreamTimeoutPolicy, StreamChunkIpc } from '../src/electron/ipcTypes';
import type { ProgressiveCourse, ProgressiveBeginReply } from '../src/services/progressiveLearning/types';
import type { StreamChunk } from '../src/services/llmStreamService';
import type { NoteItem } from '../src/types';

globalThis.fetch = async () => assert.fail('No network/model calls are permitted');
const root = await fs.mkdtemp(path.resolve('build/llm-stream-timeout-'));
const policy: LlmStreamTimeoutPolicy = { firstResponseMs: 180000, idleMs: 90000, totalMs: 600000 };
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
class Clock implements LlmStreamTimeoutClock {
  now = 0; nextId = 0;
  timers = new Map<number, { at: number; callback: () => void }>();
  history: Array<{ at: number; delay: number }> = [];
  setTimeout(callback: () => void, delay: number) { const id = ++this.nextId; this.timers.set(id, { at: this.now + delay, callback }); this.history.push({ at: this.now, delay }); return id; }
  clearTimeout(handle: unknown) { this.timers.delete(handle as number); }
  async to(value: number) {
    assert.ok(value >= this.now);
    for (;;) {
      const next = [...this.timers].sort((a, b) => a[1].at - b[1].at).find(([, timer]) => timer.at <= value);
      if (!next) break;
      this.now = next[1].at; this.timers.delete(next[0]); next[1].callback(); await flush();
    }
    this.now = value; await flush();
  }
}
const apiSource = await fs.readFile('src/electron/apiHandlers.ts', 'utf8');
const ast = ts.createSourceFile('apiHandlers.ts', apiSource, ts.ScriptTarget.ES2022, true);
const code = ts.transpileModule(ast.statements.filter(node => ts.isFunctionDeclaration(node) && ['buildUrl', 'requestThinkingPolicy', 'streamLlmRequest'].includes(node.name?.text || ''))
  .map(node => node.getText(ast)).join('\n').replace(/^export\s+/gmu, '') + '\nreturn streamLlmRequest;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const observations: any[] = [];
function harness(timeout: unknown, options: { waitingHeaders?: boolean; external?: AbortSignal; onChunk?: (chunk: StreamChunkIpc) => void } = {}) {
  const clock = new Clock(), chunks: Array<{ at: number; chunk: StreamChunkIpc }> = [], encoder = new TextEncoder();
  let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined, fetchCalls = 0, error: any, diagnostics: any, settled = false;
  const bindings = { requireLlmModel, manualThinkingTimeoutMs, resolveLlmThinkingPolicy, resolveLlmOutputBudget, sanitizeUnicode, ensureJsonObjectPrompt, requestsJsonObject, normalizeLlmStreamTimeoutPolicy, LlmStreamTimeoutError,
    buildLlmHttpRequest, ...streamToolHelpers, retainLlmToolContinuation,
    createLlmStreamTimeout: (signal: AbortSignal | undefined, value: unknown) => createLlmStreamTimeout(signal, value, clock),
    proxyLlmRequest: () => assert.fail('The test is a real SSE path, never fallback'), safeLlmHttpError: () => Error('Synthetic HTTP failure'),
    fetch: async (_url: string, init: any) => {
      fetchCalls++; const body = JSON.parse(init.body); assert.equal(body.streamTimeout, undefined, 'Local deadlines are never sent to a supplier');
      if (init.signal.aborted) throw new DOMException('Aborted by synthetic transport', 'AbortError');
      if (options.waitingHeaders) return await new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Generic transport abort', 'AbortError')), { once: true }));
      const stream = new ReadableStream<Uint8Array>({ start(controller) { bodyController = controller;
        init.signal.addEventListener('abort', () => controller.error(new DOMException('Generic body abort', 'AbortError')), { once: true }); } });
      return { ok: true, body: stream };
    } };
  const call = new Function(...Object.keys(bindings), code)(...Object.values(bindings));
  const pending = call({ provider: { apiType: 'openai-compatible', baseUrl: 'https://synthetic.invalid', apiKey: '', selectedModel: 'glm-5.3', models: ['glm-5.3'] },
    systemPrompt: 'Synthetic system', userInput: 'Synthetic lesson', maxTokens: 6500, temperature: .3, ...(timeout === undefined ? {} : { streamTimeout: timeout }) },
  (chunk: StreamChunkIpc) => { chunks.push({ at: clock.now, chunk }); options.onChunk?.(chunk); }, options.external)
    .then((value: any) => { diagnostics = value; settled = true; }, (failure: any) => { error = failure; settled = true; });
  const raw = async (text: string) => { assert.ok(bodyController); bodyController.enqueue(encoder.encode(text)); await flush(); };
  return { clock, pending, chunks, get error() { return error; }, get diagnostics() { return diagnostics; }, get settled() { return settled; }, get fetchCalls() { return fetchCalls; },
    raw, emit: (delta: any, finish?: string) => raw('data: ' + JSON.stringify({ model: 'glm-5.3', choices: [{ delta, ...(finish ? { finish_reason: finish } : {}) }] }) + '\n\n'),
    async close() { bodyController!.close(); await pending; },
  };
}
function receipt(id: string, run: ReturnType<typeof harness>) {
  assert.equal(run.clock.timers.size, 0);
  observations.push({ id, milliseconds: run.clock.now, chunks: run.chunks.length, error: run.error ? { code: run.error.code, message: run.error.message, phase: run.error.phase } : undefined,
    diagnostics: run.diagnostics, remainingTimers: run.clock.timers.size });
}

const invalid = [null, [], {}, { ...policy, totalMs: Infinity }, { ...policy, idleMs: NaN }, { ...policy, idleMs: 0 }, { ...policy, firstResponseMs: -1 },
  { ...policy, firstResponseMs: 1.5 }, { ...policy, totalMs: 900001 }, { ...policy, totalMs: 170000 }, { ...policy, idleMs: 700000 }];
for (const value of invalid) {
  assert.throws(() => normalizeLlmStreamTimeoutPolicy(value), /策略无效/u);
  const run = harness(value); await run.pending; assert.match(run.error.message, /策略无效/u); assert.equal(run.fetchCalls, 0); assert.equal(run.clock.timers.size, 0);
}
const mutable = { ...policy }, checked = normalizeLlmStreamTimeoutPolicy(mutable)!;
mutable.totalMs = 1; assert.equal(checked.totalMs, 600000); assert.equal(Object.isFrozen(checked), true);

let run = harness(undefined); await flush();
for (const time of [20000, 40000, 60000, 80000, 89000]) { await run.clock.to(time); await run.emit({ content: 'Synthetic content' }); }
await run.clock.to(90000); await run.pending; assert.equal(run.error.message, 'LLM 请求超时'); assert.equal(run.error.phase, 'total'); receipt('legacy-90s-total-unchanged', run);

run = harness(policy); await flush();
await run.clock.to(120000); assert.equal(run.settled, false); await run.emit({ reasoning_content: 'SYNTHETIC_REASONING_NEVER_DISPLAY' });
await run.clock.to(160000); await run.emit({ reasoning_content: 'SYNTHETIC_REASONING_NEVER_DISPLAY' });
await run.clock.to(210000); await run.emit({ content: 'Synthetic final lesson' }, 'stop'); await run.close();
assert.equal(run.error, undefined); assert.equal(run.chunks.length, 1); assert.equal(run.diagnostics.hadReasoningContent, true); receipt('reasoning-over-90s-then-content', run);

run = harness(policy); await flush();
for (const time of [20000, 80000, 140000, 200000, 260000]) { await run.clock.to(time); await run.emit({ content: 'Synthetic continuing lesson' }); }
await run.clock.to(280000); await run.emit({}, 'stop'); await run.close(); assert.equal(run.error, undefined); receipt('content-over-90s-continues', run);

for (const waitingHeaders of [false, true]) {
  run = harness(policy, { waitingHeaders }); await flush(); await run.clock.to(179999); assert.equal(run.settled, false);
  await run.clock.to(180000); await run.pending; assert.equal(run.error.code, 'LLM_STREAM_TIMEOUT_FIRST_RESPONSE'); receipt(waitingHeaders ? 'first-response-includes-http-headers' : 'headers-alone-do-not-clear-first-response', run);
}
run = harness(policy); await flush(); await run.clock.to(30000); await run.emit({ reasoning_content: 'SYNTHETIC_REASONING_NEVER_DISPLAY' });
await run.clock.to(120000); await run.pending; assert.equal(run.error.code, 'LLM_STREAM_TIMEOUT_IDLE'); receipt('reasoning-stops-idle-expires', run);

run = harness(policy); await flush(); await run.clock.to(120000); await run.raw(': keepalive\n\n');
await run.clock.to(180000); await run.raw('data: {"choices":'); await run.clock.to(240000); await run.raw(' ');
await run.clock.to(329999); assert.equal(run.settled, false); await run.clock.to(330000); await run.pending;
assert.equal(run.error.code, 'LLM_STREAM_TIMEOUT_IDLE'); receipt('keepalive-partial-bytes-refresh-idle', run);

run = harness(policy); await flush();
for (const time of [120000, 180000, 240000, 300000, 360000, 420000, 480000, 540000, 590000]) { await run.clock.to(time); await run.emit({ reasoning_content: 'SYNTHETIC_REASONING_NEVER_DISPLAY' }); }
await run.clock.to(600000); await run.pending; assert.equal(run.error.code, 'LLM_STREAM_TIMEOUT_TOTAL'); receipt('activity-never-resets-total-ceiling', run);

for (const waitingHeaders of [false, true]) {
  const external = new AbortController(); run = harness(policy, { waitingHeaders, external: external.signal }); await flush();
  await run.clock.to(5000); external.abort(); await run.pending; assert.equal(run.error.name, 'AbortError'); assert.ok(!(run.error instanceof LlmStreamTimeoutError)); receipt('external-cancel-' + (waitingHeaders ? 'headers' : 'body'), run);
}
const alreadyAborted = new AbortController(); alreadyAborted.abort(); const clock = new Clock();
const cancelled = createLlmStreamTimeout(alreadyAborted.signal, policy, clock); assert.equal(cancelled.signal.aborted, true); assert.equal(clock.timers.size, 0);
cancelled.touch(); cancelled.dispose(); cancelled.dispose(); assert.equal(clock.timers.size, 0);

// The unmodified production controller/store must retain partial teaching on a
// typed idle timeout and resume the same reservation only when explicitly asked.
const at = '2026-11-09T00:00:00.000Z';
const note: NoteItem = { id: 'timeout-synthetic-project', title: '函数与定义域', noteType: 'project', content: '', dueDates: [], tags: [], links: [], backlinks: [], createdAt: at, updatedAt: at };
const store = new ProgressiveLearningStore(root, { readTarget: async () => ({ note, root: note, isLeaf: true }) });
const storage: ProgressiveStorageAdapter = {
  load: id => store.command({ op: 'load', projectNoteId: id }, 1) as Promise<ProgressiveCourse | null>,
  begin: (id, sourcePackets) => store.command({ op: 'begin', projectNoteId: id, sourcePackets }, 1) as Promise<ProgressiveBeginReply>,
  checkpoint: (lease, checkpoint) => store.command({ op: 'checkpoint', lease, checkpoint }, 1) as Promise<ProgressiveCourse>,
  publish: (lease, teaching) => store.command({ op: 'publish', lease, teaching }, 1) as Promise<ProgressiveCourse>,
  saveProgress: (id, progress) => store.command({ op: 'save-progress', projectNoteId: id, progress }, 1) as Promise<ProgressiveCourse>,
  interrupt: (lease, error) => store.command({ op: 'interrupt', lease, error }, 1) as Promise<ProgressiveCourse>,
};
const plan = { title: note.title, objectives: ['解释允许输入与唯一输出'], pages: [{ id: 'main-1', title: '函数的输入限制', objectives: ['解释定义域'] }] };
const prefix = '# 函数的输入限制\n\n函数给允许范围内的每个输入指定唯一的输出，允许输入的范围叫定义域。判断函数时，既要检查输入是否被允许，也要检查对应规则是否唯一。\n\n';
const suffix = '例如平方根要求根号内非负，分式要求分母非零。把这些条件一起考虑，才能确认有效输入；定义域与对应规则必须同时给出。';
let live: ReturnType<typeof harness> | undefined, streamCalls = 0, requestId = '';
const controller = createProgressiveController({ note, allNotes: [note] }, { storage, loadMaterials: async () => [], registerFlush: () => () => {}, checkpointIntervalMs: 100000,
  stream: async (course, signal) => {
    streamCalls++; if (!requestId) requestId = course.generation.requestId; assert.equal(course.generation.requestId, requestId);
    if (streamCalls > 1) { assert.equal(course.generation.bodyDraft, prefix); return new ReadableStream<StreamChunk>({ start(output) {
      output.enqueue({ type: 'content', text: '@@LESSON\n' + suffix + '\n@@HOOK\n' + JSON.stringify({ id: 'hook-main-1', kind: 'reflection', prompt: '为什么定义域与对应规则必须同时说明？' }) + '\n@@END' }); output.close(); } }); }
    return new ReadableStream<StreamChunk>({ start(output) {
      live = harness(policy, { external: signal, onChunk: chunk => output.enqueue(chunk as StreamChunk) });
      void live.pending.then(() => { if (live!.error) output.error(live!.error); else { if (live!.diagnostics) output.enqueue({ type: 'diagnostics', text: '', diagnostics: live!.diagnostics }); output.close(); } });
    } });
  } });
const running = controller.start();
for (let i = 0; !live && i < 1000; i++) await new Promise(resolve => setTimeout(resolve, 5));
assert.ok(live, JSON.stringify(controller.getSnapshot()));
await live.clock.to(10000); await live.emit({ content: '@@PLAN\n' + JSON.stringify(plan) + '\n@@LESSON\n' + prefix });
for (let i = 0; controller.getSnapshot().page?.body !== prefix && i < 1000; i++) await new Promise(resolve => setTimeout(resolve, 5));
await controller.flush(); await live.clock.to(100000); await running;
assert.equal(controller.getSnapshot().phase, 'error'); assert.match(controller.getSnapshot().error || '', /响应中断/u);
const interrupted = await storage.load(note.id); assert.equal(interrupted!.generation.bodyDraft, prefix); assert.deepEqual(interrupted!.plan, plan);
assert.equal(streamCalls, 1, 'Timeout must not automatically request another model run');
await controller.retry(); assert.equal(controller.getSnapshot().phase, 'ready'); assert.equal(controller.getSnapshot().page!.body, prefix + suffix);
assert.equal(streamCalls, 2); controller.dispose();
observations.push({ id: 'real-progressive-store-idle-timeout-and-manual-resume', savedPrefixCharacters: prefix.length, sameRequestId: true, automaticRetry: false, published: true });

await fs.writeFile(path.join(root, 'result.json'), JSON.stringify({ status: 'passed', root, realModelRequests: 0, networkRequests: 0,
  policy, invalidPoliciesRejected: invalid.length, observations, scope: 'Production deadline/SSE functions and actual progressive controller/store with synthetic transport/time; no provider compatibility claim.' }, null, 2));
console.log(JSON.stringify({ status: 'passed', root, checks: observations.length, invalidPoliciesRejected: invalid.length, realModelRequests: 0, networkRequests: 0 }));
