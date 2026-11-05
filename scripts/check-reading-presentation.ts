import assert from 'node:assert/strict';
import { createReadingPresentation } from '../src/services/ui/readingPresentation';
let serial = 0;
const frames = new Map<number, () => void>(), timers = new Map<number, () => void>();
const presentation = createReadingPresentation({
  requestFrame: run => { frames.set(++serial, run); return serial; },
  cancelFrame: id => { frames.delete(id); },
  setTimer: run => { timers.set(++serial, run); return serial as unknown as ReturnType<typeof setTimeout>; },
  clearTimer: id => { timers.delete(id as unknown as number); },
});
const frame = () => { const batch = [...frames.values()]; frames.clear(); batch.forEach(run => run()); };
const quiet = () => { const batch = [...timers.values()]; timers.clear(); batch.forEach(run => run()); };
const published: number[] = [];
presentation.enqueue(() => published.push(1));
presentation.interact(); frame(); assert.deepEqual(published, []);
presentation.enqueue(() => published.push(2));
for (let i = 0; i < 20; i++) { presentation.interact(); frame(); assert.deepEqual(published, []); assert.equal(timers.size, 1); }
quiet(); frame(); assert.deepEqual(published, [1]); frame(); assert.deepEqual(published, [1, 2]);
const cancel = presentation.enqueue(() => published.push(3)); cancel(); frame(); assert.deepEqual(published, [1, 2]);
presentation.enqueue(() => published.push(4)); presentation.dispose(); frame(); quiet(); assert.deepEqual(published, [1, 2]);
presentation.resume(); presentation.enqueue(() => published.push(5)); frame(); assert.deepEqual(published, [1, 2, 5]);
presentation.interact(); presentation.dispose(); presentation.resume(); presentation.enqueue(() => published.push(6)); frame(); assert.deepEqual(published, [1, 2, 5, 6]);
assert.equal(frames.size, 0); assert.equal(timers.size, 0);
console.log('PASS: prepared content waits throughout continuous input, publishes one item per quiet frame; cancellation and StrictMode resume recover without polling');
