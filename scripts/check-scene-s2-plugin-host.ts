import assert from 'node:assert/strict';
import { S2PluginHost, executeS2JsonCheck, S2_LOCAL_RUN_LIMIT, type S2LocalAdapter } from '../src/services/scene/sceneS2PluginHost';
import { S2_JSON_CHECK_BINDING as capability } from '../src/services/scene/sceneS2PluginRegistry';
import type { S2Document } from '../src/types/sceneS2';
import type { S2InteractionFrame } from '../src/types/sceneS2Plugin';

const strategy = { goal: 'Test JSON syntax', understanding: 'Understand first', planning: 'Only check when requested', response: 'Never equate syntax with truth' };
const document = (text: string): S2Document => ({ nodes: [{ id: 'input', type: 'text', position: { x: 0, y: 0 }, values: { content: text } }], edges: [] });
function prepare(text: string, adapter?: S2LocalAdapter, plugins = [capability]) {
  const host = new S2PluginHost('scene-test', plugins, adapter); host.setDocument(document(text));
  const context = host.prepare('input', strategy, 'Check JSON');
  const request = { ...capability, nodeId: 'input', inputs: { text: [context.bindings[0].artifactId] }, reason: 'Synthetic check' };
  return { host, context, request };
}
const state = prepare('{"正确":true}');
const result = await state.host.execute(state.request, state.context.frame, 'key-first');
assert.equal(result.receipt.status, 'succeeded'); assert.equal(result.receipt.publication, 'current');
assert.equal((result.artifacts[0].payload as any).value.status, 'pass');
assert.equal(state.host.remainingCalls, S2_LOCAL_RUN_LIMIT - 1);
result.artifacts[0].id = 'tampered'; result.receipt.status = 'failed';
assert.notEqual(state.host.history()[0].artifacts[0].id, 'tampered'); assert.equal(state.host.history()[0].receipt.status, 'succeeded');
const observed = state.host.prepare('input', strategy, 'Explain');
assert.equal(observed.frame.observations.length, 1); assert.equal(observed.frame.observations[0].executionStatus, 'succeeded');
assert.equal('permissions' in observed, false); assert.equal('grant' in observed, false);
const replay = await state.host.execute(state.request, state.context.frame, 'key-first');
assert.equal(replay.receipt.id, state.host.history()[0].receipt.id); assert.equal(state.host.remainingCalls, S2_LOCAL_RUN_LIMIT - 1);
assert.throws(() => state.host.execute({ ...state.request, reason: 'Changed' }, state.context.frame, 'key-first'), /幂等/);

for (const text of ['{bad}', '```json\n{}\n```', '', '{"x":}', '[1,]']) {
  const item = prepare(text), execution = await item.host.execute(item.request, item.context.frame, 'key-invalid');
  assert.equal(execution.receipt.status, 'succeeded'); assert.equal((execution.artifacts[0].payload as any).value.status, 'fail'); item.host.close();
}
for (const text of ['null', '42', '"hello"', '[]', '{}', '{"__proto__":{"x":1}}']) {
  const item = prepare(text), execution = await item.host.execute(item.request, item.context.frame, 'key-valid');
  assert.equal((execution.artifacts[0].payload as any).value.status, 'pass'); item.host.close();
}
const denied = prepare('{}', undefined, []);
await assert.rejects(denied.host.execute(denied.request, denied.context.frame, 'key-denied'), /未授权/);
assert.equal(denied.host.remainingCalls, S2_LOCAL_RUN_LIMIT); assert.equal(denied.host.history().length, 0);
const fake = prepare('{}');
await assert.rejects(fake.host.execute({ ...fake.request, pluginId: 'external' }, fake.context.frame, 'key-forged'));
await assert.rejects(fake.host.execute({ ...fake.request, inputs: { text: ['invented'] } }, fake.context.frame, 'key-invented'));
await assert.rejects(fake.host.execute(fake.request, { ...fake.context.frame, runId: 'other-run' }, 'key-cross-run'), /变化/);

state.host.setDocument(document('[]'));
assert.equal(state.host.history()[0].receipt.publication, 'stale'); assert.deepEqual(state.host.history()[0].artifacts, []);
assert.deepEqual(state.host.prepare('input', strategy, 'New').frame.observations, []);
state.host.setDocument(document('{"正确":true}'));
assert.equal(state.host.history()[0].receipt.publication, 'stale', 'Undo cannot resurrect old currentness');
await assert.rejects(state.host.execute(state.request, state.context.frame, 'key-stale'), /变化/);
assert.equal(state.host.remainingCalls, S2_LOCAL_RUN_LIMIT - 1);

let dispatches = 0;
const delayed: S2LocalAdapter = async (call, inputs, signal) => { dispatches++; await new Promise(resolve => setTimeout(resolve, 15)); return executeS2JsonCheck(call, inputs, signal); };
const duplicate = prepare('{}', delayed);
const [first, second] = await Promise.all([duplicate.host.execute(duplicate.request, duplicate.context.frame, 'key-same'), duplicate.host.execute(duplicate.request, duplicate.context.frame, 'key-same')]);
assert.equal(dispatches, 1); assert.equal(first.receipt.id, second.receipt.id);

let release!: () => void, entered!: () => void;
let started = new Promise<void>(resolve => { entered = resolve; });
const slow: S2LocalAdapter = async (call, inputs, signal) => { entered(); await new Promise<void>(resolve => { release = resolve; }); return executeS2JsonCheck(call, inputs, signal); };
const stale = prepare('{}', slow), pending = stale.host.execute(stale.request, stale.context.frame, 'key-slow');
await started; stale.host.setDocument(document('changed')); release();
const late = await pending; assert.equal(late.receipt.status, 'succeeded'); assert.equal(late.receipt.publication, 'stale'); assert.deepEqual(late.observation.artifacts, []);

started = new Promise<void>(resolve => { entered = resolve; });
const cancelled = prepare('{}', slow), controller = new AbortController();
const waiting = cancelled.host.execute(cancelled.request, cancelled.context.frame, 'key-cancel', controller.signal);
await started; controller.abort();
const stopped = await waiting; assert.equal(stopped.receipt.status, 'cancelled'); assert.equal(cancelled.host.remainingCalls, S2_LOCAL_RUN_LIMIT - 1);
release(); await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(cancelled.host.history().length, 1);

started = new Promise<void>(resolve => { entered = resolve; });
const ended = prepare('{}', slow), ending = ended.host.execute(ended.request, ended.context.frame, 'key-end');
await started; ended.host.close(); assert.equal((await ending).receipt.status, 'cancelled');
assert.equal(ended.host.history()[0].receipt.publication, 'stale'); release();
assert.throws(() => ended.host.prepare('input', strategy, 'No'), /已结束/);
assert.throws(() => ended.host.execute(ended.request, ended.context.frame, 'key-after-end'), /已结束/);

const broken = prepare('{}', async () => ({ status: 'succeeded', outputs: {} }));
const failed = await broken.host.execute(broken.request, broken.context.frame, 'key-broken');
assert.equal(failed.receipt.status, 'failed'); assert.equal(failed.receipt.error?.code, 'INVALID_OUTPUT'); assert.deepEqual(failed.artifacts, []);
assert.equal(broken.host.remainingCalls, S2_LOCAL_RUN_LIMIT - 1);
const exception = prepare('{}', async () => { throw null; });
assert.equal((await exception.host.execute(exception.request, exception.context.frame, 'key-null')).receipt.error?.code, 'ADAPTER_FAILURE');
const collisions = prepare('{}', async (call, inputs, signal) => {
  const raw = await executeS2JsonCheck(call, inputs, signal) as any; raw.outputs.assessment[0].id = 'artifact-shared'; return raw;
});
const collisionResults = await Promise.all([collisions.host.execute(collisions.request, collisions.context.frame, 'key-collision-a'), collisions.host.execute(collisions.request, collisions.context.frame, 'key-collision-b')]);
assert.equal(collisionResults.filter(item => item.receipt.status === 'succeeded').length, 1);
assert.equal(collisionResults.filter(item => item.receipt.status === 'failed').length, 1);
assert.equal(collisions.host.history().length, 2, 'Conflicting adapter output is contained and still has a receipt');
const immutable = prepare('{}'), callerRequest = structuredClone(immutable.request);
const immutableRun = immutable.host.execute(callerRequest, immutable.context.frame, 'key-immutable');
callerRequest.inputs.text = ['forged-after-confirmation'];
assert.equal((await immutableRun).receipt.status, 'succeeded', 'Confirmed input is snapshotted before dispatch');
const timeout = prepare('{}', async () => new Promise(() => {}));
const timed = await timeout.host.execute(timeout.request, timeout.context.frame, 'key-timeout');
assert.equal(timed.receipt.status, 'unknown'); assert.equal(timed.receipt.error?.code, 'TIMEOUT');
assert.equal(timeout.host.remainingCalls, S2_LOCAL_RUN_LIMIT - 1);

const budget = prepare('{}');
const settled = await Promise.allSettled(Array.from({ length: S2_LOCAL_RUN_LIMIT + 1 }, (_, i) => {
  try { return budget.host.execute(budget.request, budget.context.frame, `key-budget-${i}`); } catch (error) { return Promise.reject(error); }
}));
assert.equal(settled.filter(item => item.status === 'fulfilled').length, S2_LOCAL_RUN_LIMIT);
assert.equal(budget.host.remainingCalls, 0); assert.equal(budget.host.history().length, S2_LOCAL_RUN_LIMIT);
const noExecuteBeforeReservation = prepare('{}');
const abortBefore = new AbortController(); abortBefore.abort();
await assert.rejects(noExecuteBeforeReservation.host.execute(noExecuteBeforeReservation.request, noExecuteBeforeReservation.context.frame, 'key-before', abortBefore.signal), /停止/);
assert.equal(noExecuteBeforeReservation.host.remainingCalls, S2_LOCAL_RUN_LIMIT);
const frameClone: S2InteractionFrame = structuredClone(noExecuteBeforeReservation.context.frame);
frameClone.availableArtifactIds.push('forged');
await assert.rejects(noExecuteBeforeReservation.host.execute({ ...noExecuteBeforeReservation.request, inputs: { text: ['forged'] } }, frameClone, 'key-forged-frame'), /不存在/);
console.log('S2 real builtin JSON adapter + host passed: full-field input, syntax pass/fail vs execution status, immutable store, run grants, input/type/scope checks, idempotent concurrent dispatch, budget reservation, revision/undo/late isolation, cancellation/end, malformed output and timeout. Synthetic data only; no model/network/note access.');
