import assert from 'node:assert/strict';
import vm from 'node:vm';
import { h5pBootstrap } from '../src/electron/h5pPlayerPage';

// Execute the actual generated bootstrap. No app window, disk, model or network.
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function fixture(mode: 'ready' | 'empty' | 'throws' = 'ready') {
  let position = 1;
  const elements = new Map<string, any>(), timers: Array<() => void> = [];
  const requests: Array<{ body: { state: { position: number } }; reply: (ok: boolean) => void }> = [];
  const window: any = {};
  let rootAvailable = mode === 'ready', expire!: () => void;
  const deadline = {};
  const element = (id: string) => { if (!elements.has(id)) elements.set(id, {}); return elements.get(id); };
  vm.runInNewContext(h5pBootstrap(null), {
    URL, location: { href: 'http://127.0.0.1:1234/token/' }, window,
    setTimeout: (run: () => void, ms: number) => { if (ms === 15000) { expire = run; return deadline; } return setTimeout(run, ms); },
    clearTimeout: (timer: any) => { if (timer !== deadline) clearTimeout(timer); },
    document: {
      documentElement: { classList: { toggle() {} }, style: { setProperty() {} } }, getElementById: element,
      querySelector: () => ({ contentWindow: { H5P: { instances: rootAvailable ? [{ getCurrentState: () => ({ position }) }] : [] } } }),
    },
    H5PStandalone: { H5P: function () { if (mode === 'throws') throw Error('synthetic startup error'); return Promise.resolve(); } },
    setInterval: (run: () => void) => { timers.push(run); },
    fetch: (_url: string, options: { body: string }) => new Promise(resolve => {
      requests.push({ body: JSON.parse(options.body), reply: ok => resolve({ ok }) });
    }),
  });
  await tick();
  return { requests, timers, element, expire: () => expire(), setRoot: (value: boolean) => { rootAvailable = value; },
    save: () => window.logiH5pCheckpoint() as Promise<void>, setPosition: (value: number) => { position = value; } };
}

const parallel = await fixture();
parallel.timers[0](); await tick(); assert.equal(parallel.requests.length, 1);
parallel.setPosition(2);
const closing = parallel.save();
parallel.timers[0](); await tick(); assert.equal(parallel.requests.length, 1, 'close waits; timer cannot enqueue extra saves');
parallel.requests[0].reply(true); await tick();
assert.equal(parallel.requests.length, 2); assert.equal(parallel.requests[1].body.state.position, 2, 'queued checkpoint reads state after the previous save, not a stale captured payload');
parallel.requests[1].reply(true); await closing;
assert.match(parallel.element('status').textContent, /进度已保存/);
console.log('PASS autosave/close collision: serial requests, fresh latest state and no false saving-in-progress rejection');

const recovery = await fixture();
const failed = assert.rejects(recovery.save(), /本地进度保存失败/); await tick();
recovery.setPosition(3); const retry = recovery.save();
recovery.requests[0].reply(false); await failed; await tick();
assert.equal(recovery.requests.length, 2); assert.equal(recovery.requests[1].body.state.position, 3);
recovery.requests[1].reply(true); await retry;
recovery.timers[0](); await tick(); assert.equal(recovery.requests.length, 3, 'completed queue releases the autosave gate');
recovery.requests[2].reply(true); await tick();
console.log('PASS a failed earlier save rejects truthfully; a queued explicit retry and later autosave can still succeed');

const failure = await fixture();
const rejectedClose = assert.rejects(failure.save(), /本地进度保存失败/); await tick(); failure.requests[0].reply(false); await rejectedClose;
assert.match(failure.element('status').textContent, /本地进度保存失败/);
console.log('PASS genuine final checkpoint failure still propagates to native close protection, never masked as successful');

const empty = await fixture('empty');
assert.equal(empty.element('save').disabled, true); assert.equal(empty.timers.length, 0);
empty.expire(); await tick();
assert.equal(empty.element('status').textContent, '场景加载失败');
await empty.save(); assert.equal(empty.requests.length, 0, 'failed initialization cannot overwrite progress');
assert.equal(empty.element('save').disabled, true);
const throws = await fixture('throws');
assert.equal(throws.element('status').textContent, '场景加载失败'); assert.equal(throws.timers.length, 0);
console.log('PASS actual root instance gates loaded status and autosave; constructor/startup errors and timeouts stay failed without writes');

const lost = await fixture(); lost.setRoot(false);
await assert.rejects(lost.save(), /场景尚未就绪或已失效/); assert.equal(lost.requests.length, 0);
console.log('PASS a lost root instance cannot turn an old snapshot into a false successful checkpoint');
