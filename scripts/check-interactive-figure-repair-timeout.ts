/** Real local-patch pipeline with a virtual clock; no model/network/settings. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { repairFigureLocally } from '../src/services/textbook/interactiveFigureRepair';
import { prepareInteractiveFigure, interactiveFigureKey } from '../src/services/textbook/interactiveFigure';
import { INTERACTIVE_TEACHING_MODE_FIXTURES } from './fixtures/interactive-teaching-modes';
import { webcrypto } from 'node:crypto';
import type { FigureDesign } from '../src/services/textbook/interactiveFigureDesign';
import type { FigureRepairReceipt } from '../src/services/textbook/figureRepairReceipt';
import type { FigureArtifact } from '../src/electron/interactiveFigureStore';
import type { LlmProvider } from '../src/types';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
globalThis.fetch = async () => assert.fail('Repair timeout regression must not use network');
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
Object.defineProperty(globalThis, 'window', { configurable: true, get: () => assert.fail('Injected generators must not access user configuration') });
Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => assert.fail('Injected generators must not access browser storage') });
const originalSetTimeout = globalThis.setTimeout, originalClearTimeout = globalThis.clearTimeout;
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
class Clock {
  now = 0; sequence = 0;
  timers = new Map<number, { at: number; action: () => void }>();
  delays: number[] = [];
  install() {
    globalThis.setTimeout = ((action: () => void, milliseconds = 0) => { const id = ++this.sequence; this.delays.push(milliseconds); this.timers.set(id, { at: this.now + milliseconds, action }); return id; }) as any;
    globalThis.clearTimeout = ((id: number) => { this.timers.delete(id); }) as any;
  }
  async to(value: number) {
    assert.ok(value >= this.now);
    for (;;) {
      const due = [...this.timers].sort((a, b) => a[1].at - b[1].at).find(([, timer]) => timer.at <= value);
      if (!due) break;
      this.now = due[1].at; this.timers.delete(due[0]); due[1].action(); await flush();
    }
    this.now = value; await flush();
  }
  restore() { globalThis.setTimeout = originalSetTimeout; globalThis.clearTimeout = originalClearTimeout; }
}
const glm: LlmProvider = { id: 'synthetic-glm', name: 'Synthetic GLM', apiType: 'openai-compatible', baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  apiKey: '', models: ['glm-5.3'], selectedModel: 'glm-5.3', enabled: true, createdAt: '' };
const deepseek = { ...glm, id: 'synthetic-ds', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-chat'], selectedModel: 'deepseek-chat' };
const html = '<div data-figure="visual"><p>错误反馈</p><p>保留说明</p></div><button data-figure="reset">重置</button>';
const patched = html.replace('错误反馈', '正确反馈');
const good = { patches: [{ search: '错误反馈', replacement: '正确反馈' }] };
const design: FigureDesign = { kind: 'comparison', anchor: '合成', goal: '比较', action: '调整', observation: '观察', model: '示意', prediction: '预测', caveat: '假设', transfer: '迁移' };
const initial = { interaction: 'observed' as const, reset: 'restored' as const, warnings: ['prediction-consistency' as const] };
const clean = { interaction: 'observed' as const, reset: 'restored' as const, checks: { predictionConsistency: true as const } };
const checks: Array<{ id: string; deadline: number; elapsed: number; calls: number }> = [];
async function run(id: string, input: { provider?: LlmProvider; providerSnapshot?: LlmProvider; resolveProvider?: () => Promise<LlmProvider | undefined>; deadline: number; outcome: 'success' | 'timeout' | 'cancel' }) {
  const clock = new Clock(); clock.install();
  let calls = 0, settled = false, signal: AbortSignal | undefined, receipt: FigureRepairReceipt | undefined;
  let release!: (value: any) => void, reject!: (error: unknown) => void;
  const pending = repairFigureLocally({ html, lesson: '合成教材', brief: '比较反馈', design,
    provider: input.provider, providerSnapshot: input.providerSnapshot, resolveProvider: input.resolveProvider,
    api: { diagnose: async source => source === html ? initial : clean, preflight: async source => { assert.equal(source, patched); } },
    validateHtml: value => String(value), onOutcome: value => { receipt = value; },
    generate: async (request, options) => {
      calls++; assert.equal(request.maxTokensOverride, 1800); assert.equal(request.thinkingMode, 'disabled');
      assert.equal(request.tokenBudgetMode, undefined, 'central GLM response-budget adaptation remains enabled for the small repair request');
      assert.ok(request.skipMemoryInjection && request.skipProfileInjection);
      assert.ok(request.systemPromptOverride?.includes('局部修复员') && !request.systemPromptOverride.includes('自包含HTML片段'));
      signal = options?.signal; assert.ok(signal instanceof AbortSignal);
      assert.equal(options?.providerSnapshot, input.providerSnapshot);
      return new Promise((resolve, fail) => { release = resolve; reject = fail; signal!.addEventListener('abort', () => fail(new DOMException('Synthetic timeout abort', 'AbortError')), { once: true }); });
    },
  }).then(value => { settled = true; return value; });
  try {
    for (let i = 0; i < 40 && !release; i++) await flush();
    assert.equal(calls, 1); assert.ok(clock.delays.includes(input.deadline));
    if (input.outcome === 'success') {
      await clock.to(30_000); assert.equal(settled, false); assert.equal(signal!.aborted, false);
      release({ content: JSON.stringify(good) }); assert.equal(await pending, patched);
      assert.equal(receipt?.status, 'repaired'); assert.equal(receipt?.reason, 'verified');
    } else if (input.outcome === 'cancel') {
      await clock.to(7_000); reject(new DOMException('Synthetic IPC sender closed/cancelled', 'AbortError'));
      assert.equal(await pending, html); assert.equal(clock.now, 7_000); assert.equal(receipt?.reason, 'model-unavailable');
    } else {
      await clock.to(input.deadline - 1); assert.equal(settled, false); assert.equal(signal!.aborted, false);
      await clock.to(input.deadline); assert.equal(await pending, html); assert.equal(signal!.aborted, true);
      assert.equal(receipt?.status, 'unresolved'); assert.equal(receipt?.reason, 'model-unavailable');
    }
    assert.equal(calls, 1, 'local repair must never automatically regenerate or retry');
    assert.equal(clock.timers.size, 0, 'all timers are cleaned after resolution, timeout or cancellation');
    checks.push({ id, deadline: input.deadline, elapsed: clock.now, calls });
  } finally { clock.restore(); }
}
try {
  await run('official-glm-returns-after-old-25s', { provider: glm, deadline: 90_000, outcome: 'success' });
  await run('official-zai-returns-after-old-25s', { provider: { ...glm, baseUrl: 'https://api.z.ai/api/paas/v4' }, deadline: 90_000, outcome: 'success' });
  await run('official-glm-still-bounded-at-90s', { provider: glm, deadline: 90_000, outcome: 'timeout' });
  await run('official-glm-ipc-close-rejects-immediately', { provider: glm, deadline: 90_000, outcome: 'cancel' });
  await run('deepseek-keeps-25s', { provider: deepseek, deadline: 25_000, outcome: 'timeout' });
  await run('unknown-gateway-keeps-25s', { provider: { ...glm, baseUrl: 'https://gateway.synthetic.invalid/v1' }, deadline: 25_000, outcome: 'timeout' });
  await run('unknown-version-keeps-25s', { provider: { ...glm, selectedModel: 'glm-5.2', models: ['glm-5.2'] }, deadline: 25_000, outcome: 'timeout' });
  await run('false-official-host-keeps-25s', { provider: { ...glm, baseUrl: 'https://open.bigmodel.cn.attacker.invalid/v1' }, deadline: 25_000, outcome: 'timeout' });
  await run('pinned-approved-provider-wins', { provider: glm, providerSnapshot: deepseek, resolveProvider: async () => assert.fail('Pinned model must win'), deadline: 25_000, outcome: 'timeout' });
  await run('injected-generator-without-provider-stays-isolated', { deadline: 25_000, outcome: 'timeout' });
  let lazyReads = 0;
  await run('lazy-resolver-after-diagnostic', { resolveProvider: async () => { lazyReads++; return glm; }, deadline: 90_000, outcome: 'success' });
  assert.equal(lazyReads, 1);
  const noWarning = await repairFigureLocally({ html, lesson: '合成教材', brief: '比较反馈', design,
    api: { diagnose: async () => clean, preflight: async () => {} }, generate: async () => assert.fail('No warning means no model'),
    resolveProvider: async () => assert.fail('No warning means no provider/settings access'), validateHtml: value => String(value) });
  assert.equal(noWarning, html);
  {
    const clock = new Clock(); clock.install(); let resolved = false, receipt: FigureRepairReceipt | undefined;
    try {
      const pending = repairFigureLocally({ html, lesson: '合成教材', brief: '比较反馈', design,
        api: { diagnose: async () => initial, preflight: async () => {} }, generate: async () => assert.fail('Unresolved provider cannot dispatch'),
        resolveProvider: async () => new Promise(() => {}), validateHtml: value => String(value), onOutcome: value => { receipt = value; },
      }).then(value => { resolved = true; return value; });
      for (let i = 0; i < 40 && !clock.delays.includes(8000); i++) await flush();
      await flush(); await clock.to(7999); assert.equal(resolved, false);
      await clock.to(8000); assert.equal(await pending, html); assert.equal(receipt?.requested, false);
      assert.equal(receipt?.reason, 'model-unavailable'); assert.equal(clock.timers.size, 0);
      checks.push({ id: 'stalled-provider-lookup-is-bounded-without-model', deadline: 8000, elapsed: clock.now, calls: 0 });
    } finally { clock.restore(); }
  }

  // Production ready-attachment entry passes the provider lazily to the repair
  // wrapper, and one new model-generated figure passes its resolved provider.
  for (const ready of [true, false]) {
    const fixture = INTERACTIVE_TEACHING_MODE_FIXTURES.find(item => item.mode === 'step')!;
    const clock = new Clock(); clock.install();
    const replacement = fixture.html.replace('先读当前队列', '先检查当前队列');
    const sourceBody = fixture.lesson + '\n' + fixture.brief;
    const key = await interactiveFigureKey(ready ? 'ready-repair-timeout' : 'new-repair-timeout', sourceBody, fixture.brief);
    const records = new Map<string, FigureArtifact>();
    if (ready) records.set(key, { status: 'ready', html: fixture.html, design: fixture.design });
    let modelCalls = 0, repairCalls = 0;
    const api = { read: async (id: string) => records.get(id) || null,
      write: async (id: string, value: FigureArtifact) => { records.set(id, value); },
      compareReady: async (id: string, expected: unknown, value: FigureArtifact) => { if (records.get(id) !== expected) return false; records.set(id, value); return true; },
      diagnose: async (source: string) => source === fixture.html ? initial : clean,
      preflight: async () => {}, open: async () => ({ processId: 1 }), bounds: async () => {}, visible: async () => {}, close: async () => {}, onFailure: () => () => {},
    };
    try {
      const value = await prepareInteractiveFigure(key, sourceBody, fixture.brief, false, { api, provider: glm, generate: async request => {
        modelCalls++;
        if (request.systemPromptOverride?.includes('局部修复员')) { repairCalls++; return { content: JSON.stringify({ patches: [{ search: '先读当前队列', replacement: '先检查当前队列' }] }) }; }
        return { content: JSON.stringify({ design: fixture.design, html: fixture.html }) };
      } }, { projectId: 'synthetic', legacy: false, teachingPolicy: 1 });
      assert.equal(value, replacement); assert.equal(repairCalls, 1); assert.equal(modelCalls, ready ? 1 : 2);
      assert.ok(clock.delays.includes(90_000)); assert.ok(!clock.delays.includes(25_000)); assert.equal(clock.timers.size, 0);
      assert.equal(records.get(key)?.status, 'ready');
      checks.push({ id: ready ? 'ready-entry-provider-reaches-repair' : 'new-entry-provider-reaches-repair', deadline: 90_000, elapsed: clock.now, calls: repairCalls });
    } finally { clock.restore(); }
  }
  await fs.mkdir('build', { recursive: true }); const root = await fs.mkdtemp(path.resolve('build/interactive-figure-repair-timeout-'));
  const report = { passed: true, root, checks, noWarningSkipsProvider: true, unmodifiedLocalDiagnosticTimeoutMs: 8000, realModelRequests: 0, networkCalls: 0, realSettingsAccessed: false };
  await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  globalThis.setTimeout = originalSetTimeout; globalThis.clearTimeout = originalClearTimeout;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window');
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage); else Reflect.deleteProperty(globalThis, 'localStorage');
}
