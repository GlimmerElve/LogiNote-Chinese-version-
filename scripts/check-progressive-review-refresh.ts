import assert from 'node:assert/strict';
import { createProgressiveReviewRefreshQueue } from '../src/services/progressiveLearning/reviewRefresh';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
{
  const gate = deferred(), commits: number[] = [];
  let reads = 0, concurrent = 0, peak = 0;
  const queue = createProgressiveReviewRefreshQueue(async () => {
    const id = ++reads; peak = Math.max(peak, ++concurrent);
    if (id === 1) await gate.promise;
    commits.push(id); concurrent--;
  });
  const first = queue.refresh();
  for (let i = 0; i < 80; i++) assert.equal(queue.refresh(), first);
  assert.equal(reads, 1);
  gate.resolve(); await first;
  assert.equal(reads, 2); assert.equal(peak, 1); assert.deepEqual(commits, [1, 2]);
  queue.stop();
  console.log('PASS slow reads are retained; 80 notifications coalesce into one follow-up with one reader at a time');
}
{
  const gate = deferred(); let reads = 0;
  const queue = createProgressiveReviewRefreshQueue(async () => { reads++; await gate.promise; });
  const first = queue.refresh(); void queue.refresh(); queue.stop(); gate.resolve(); await first;
  await queue.refresh(); assert.equal(reads, 1);
  console.log('PASS closing stops queued and future reads without discarding or retrying an accepted operation');
}
{
  let reads = 0;
  const queue = createProgressiveReviewRefreshQueue(async () => { if (++reads === 1) throw Error('synthetic read refusal'); });
  await assert.rejects(queue.refresh(), /synthetic read refusal/);
  assert.equal(reads, 1);
  await queue.refresh(); assert.equal(reads, 2); queue.stop();
  console.log('PASS a rejected read clears the single-flight lock and allows an explicit successful retry');
}
{
  const oldGate = deferred(); let oldCommits = 0, newCommits = 0, oldActive = true;
  const old = createProgressiveReviewRefreshQueue(async () => { await oldGate.promise; if (oldActive) oldCommits++; });
  const first = old.refresh(); oldActive = false; old.stop();
  const current = createProgressiveReviewRefreshQueue(async () => { newCommits++; });
  await current.refresh(); oldGate.resolve(); await first; await current.refresh();
  assert.equal(oldCommits, 0); assert.equal(newCommits, 2); current.stop();
  console.log('PASS a replacement scope remains independent of a stopped old reader and its late completion');
}
console.log('Progressive review refresh: 4 offline groups passed; no IO, private data, model or network.');
