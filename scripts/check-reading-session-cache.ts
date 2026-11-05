import assert from 'node:assert/strict';
import type { Root } from 'hast';
import { createReadingDocumentSession } from '../src/services/textbook/readingDocumentClient';
const original = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
const workers: FakeWorker[] = [];
class FakeWorker {
  onmessage?: (event: any) => void; onerror?: (event: any) => void;
  reads: number[] = []; terminated = false; blocked = false; units = 100;
  constructor() { workers.push(this); }
  terminate() { this.terminated = true; }
  postMessage(value: any) {
    if (value.page !== undefined) this.reads.push(value.page);
    if (this.blocked) return;
    queueMicrotask(() => this.onmessage?.({ data: value.input ? { id: value.id, index: { pages: [], sections: [] } }
      : { id: value.id, tree: { type: 'root', children: [{ type: 'text', value: String(value.page) }] }, cacheUnits: this.units } }));
  }
}
Object.defineProperty(globalThis, 'Worker', { configurable: true, value: FakeWorker });
try {
  const session = createReadingDocumentSession({ content: 'book A' }); await session.ready;
  const first = await session.page(0);
  assert.equal(session.cachedPage(0), undefined, 'not-yet-presented work cannot bypass first-load scroll deferral');
  session.markPresented(0, first); assert.equal(session.cachedPage(0), first);
  let evicted = 0; const unsubscribe = session.subscribeRetained(0, () => { if (!session.retains(0)) evicted++; });
  for (let page = 1; page <= 6; page++) session.markPresented(page, await session.page(page));
  assert.equal(evicted, 1); assert.equal(session.retains(0), false);
  assert.equal(session.cachedPage(0), first, 'released DOM still has reusable prepared text/math');
  const before = workers[0].reads.length; assert.equal(await session.page(0), first);
  assert.equal(workers[0].reads.length, before, 'return reading does not ask the worker to parse again');
  session.markPresented(0, first); assert.equal(session.retains(0), true); unsubscribe();
  const pair = await Promise.all([session.page(10), session.page(10)]); assert.equal(pair[0], pair[1]);
  assert.equal(workers[0].reads.filter(value => value === 10).length, 1);
  for (let page = 11; page <= 35; page++) session.markPresented(page, await session.page(page));
  assert.equal(session.cachedPage(0), undefined, 'prepared-page count is bounded');
  assert.equal(session.wasPresented(0), true, 'eviction does not make an already-read page wait for scroll idle again');
  assert.ok(Array.from({ length: 36 }, (_, page) => session.retains(page)).filter(Boolean).length <= 4);
  workers[0].units = 2_100_000;
  session.markPresented(100, await session.page(100)); session.markPresented(101, await session.page(101));
  assert.equal(session.cachedPage(100), undefined, 'expanded formula markup obeys the cache size limit');
  assert.equal(session.retains(100), false);
  const other = createReadingDocumentSession({ content: 'book B' }); await other.ready;
  assert.notEqual(other.id, session.id); assert.equal(other.cachedPage(101), undefined);
  workers[0].blocked = true;
  const pending = session.page(200); const rejected = assert.rejects(pending, { name: 'AbortError' }); session.dispose(); await rejected;
  assert.equal(workers[0].terminated, true); assert.equal(session.cachedPage(101), undefined); assert.equal(session.retains(101), false);
  assert.equal(session.wasPresented(0), false);
  other.dispose();
  console.log('PASS shown-page reuse without worker IO, 4 recent DOM slots/16 prepared pages/size limit, first-load deferral, request deduplication, eviction, cancellation and document isolation');
} finally { if (original) Object.defineProperty(globalThis, 'Worker', original); else Reflect.deleteProperty(globalThis, 'Worker'); }
