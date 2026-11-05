import assert from 'node:assert/strict';
import { commitQuickCheckWrite, type QuickCheckWriteProgress } from '../src/services/ui/quickCheckWrite';
import type { QuickCheckResult } from '../src/services/quickCheck';

const result: QuickCheckResult = { headline: '本次表现已记录', remaining: ['概念边界'], nextAction: '继续简测',
  changed: true, details: [] };
const progress: QuickCheckWriteProgress = {};
let applied = false, passes = 0, persistCalls = 0, flushCalls = 0;
let failSave = true;
let release: (() => void) | undefined;
const dependency = {
  persist: async (capture: (value: QuickCheckResult) => void) => {
    persistCalls++;
    capture(applied ? { ...result, changed: false, headline: '已保存过' } : result);
    if (!applied) { passes++; applied = true; }
    if (release === undefined) await new Promise<void>(resolve => { release = resolve; });
    if (failSave) throw new Error('synthetic disk failure');
  },
  flush: async () => { flushCalls++; },
};
const first = commitQuickCheckWrite(progress, dependency);
assert.equal(commitQuickCheckWrite(progress, dependency), first, 'double submission shares the same pending write');
release!();
await assert.rejects(first, /synthetic disk failure/);
assert.equal(progress.completed, undefined);
assert.equal(flushCalls, 0);
assert.equal(passes, 1);
failSave = false;
assert.deepEqual(await commitQuickCheckWrite(progress, dependency), result, 'a retry retains the original change summary');
assert.equal(passes, 1, 'save retries cannot count a new independent answer');
assert.equal(persistCalls, 2, 'retry still revalidates the current target');
assert.equal(flushCalls, 1, 'only an acknowledged write reports success');
assert.equal(progress.completed, true);
await commitQuickCheckWrite(progress, dependency);
assert.equal(persistCalls, 2);

const concurrent: QuickCheckWriteProgress = {};
let firstConcurrent = true;
await assert.rejects(commitQuickCheckWrite(concurrent, {
  persist: async capture => { capture(result); throw new Error('first write failed'); }, flush: async () => {},
}), /first write failed/);
const refreshed = await commitQuickCheckWrite(concurrent, {
  persist: async capture => { capture({ ...result, changed: false, headline: '已处理过', remaining: ['判断正确性'], nextAction: '补充判断' }); firstConcurrent = false; },
  flush: async () => {},
});
assert.equal(firstConcurrent, false);
assert.equal(refreshed.headline, result.headline);
assert.equal(refreshed.changed, true);
assert.deepEqual(refreshed.remaining, ['判断正确性'], 'other-source mastery changes refresh the remaining gaps after save retry');
assert.equal(refreshed.nextAction, '补充判断');

const flushFailure: QuickCheckWriteProgress = {};
let shouldFailFlush = true;
const flushDependency = {
  persist: async (capture: (value: QuickCheckResult) => void) => { capture(result); },
  flush: async () => { if (shouldFailFlush) throw new Error('synthetic pending save'); },
};
await assert.rejects(commitQuickCheckWrite(flushFailure, flushDependency), /synthetic pending save/);
assert.equal(flushFailure.completed, undefined);
shouldFailFlush = false;
assert.deepEqual(await commitQuickCheckWrite(flushFailure, flushDependency), result);
console.log('PASS: quick-check double-submit, failed-save retry, idempotent observation and flush acknowledgement; no storage or LLM.');
