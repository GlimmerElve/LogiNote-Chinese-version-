import assert from 'node:assert/strict';
import { createArgumentReferenceRagBuildClient, getArgumentReferenceRagBuildApi, argumentReferenceRagBuildReasonLabel,
  type PreparedReferenceRagBuild } from '../src/services/argumentContext/referenceRagBuildClient.ts';
import type { ArgumentReferenceRagBuildApi } from '../src/services/argumentContext/referenceRagBuildTypes.ts';

globalThis.fetch = async () => assert.fail('Network forbidden in combined reference client checks');
let checks = 0;
const pass = (label: string) => { checks++; console.log(`PASS ${label}`); };
const ref = { kind: 'knowledge-note' as const, entityId: 'synthetic-note' };
const ticket: PreparedReferenceRagBuild = { status: 'prepared', environmentId: 'rag-build-env', ticketId: 'rag-ticket',
  expiresAt: '2026-10-07T03:00:00.000Z', summary: { sourceKind: ref.kind, entityId: ref.entityId,
    sourceVersion: 'synthetic-v1', contentHash: 'a'.repeat(64), characters: 40, chunks: 1, sentences: 2,
    providerLabel: 'Synthetic provider', modelName: 'synthetic-model', isRemote: true, stage: 'structure-and-propositions',
    maximumModelRequests: 5, reviewBudget: 'checked-after-extraction' } };
const counts = { nodes: 2, relations: 1, groups: 0, scopes: 1 };
const fake = (patch: Partial<ArgumentReferenceRagBuildApi> = {}): ArgumentReferenceRagBuildApi => ({
  getEnvironment: async () => ({ status: 'available', environmentId: ticket.environmentId }),
  prepare: async () => structuredClone(ticket), status: async () => ({ status: 'held', reasonCode: 'source_pending' }),
  run: async () => ({ status: 'published', counts, propositionCount: 2 }), cancel: async () => ({ status: 'cancelled' }), ...patch,
});
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

assert.equal(getArgumentReferenceRagBuildApi(), undefined);
const missing = createArgumentReferenceRagBuildClient(() => undefined);
assert.equal((await missing.prepare(ref)).status, 'held'); assert.equal((await missing.status(ref)).status, 'held');
assert.equal((await missing.run(ticket)).status, 'held'); assert.equal((await missing.cancel(ticket)).status, 'held');
pass('absent new bridge holds without accessing the legacy bridge, network or a fabricated ready structure');

let leases = 0, prepares = 0, runs = 0;
const shared = createArgumentReferenceRagBuildClient(() => fake({ getEnvironment: async () => {
  leases++; await Promise.resolve(); return { status: 'available', environmentId: ticket.environmentId };
}, prepare: async () => { prepares++; return ticket; }, run: async () => { runs++; return { status: 'published', counts, propositionCount: 2 }; } }));
await Promise.all([shared.status(ref), shared.prepare(ref), shared.status({ ...ref, entityId: 'other' })]);
assert.equal(leases, 1); assert.equal(prepares, 1); assert.equal(runs, 0);
pass('parallel read-only status and preparation share one build lease and never run a model');
shared.invalidate(); await shared.status(ref); assert.equal(leases, 2); assert.equal(runs, 0);
pass('invalidation renews only the next explicit read, not a consented build');

let renews = 0, attempts = 0;
const retry = createArgumentReferenceRagBuildClient(() => fake({ getEnvironment: async () => {
  renews++; return { status: 'available', environmentId: `renew-${renews}` };
}, prepare: async input => { attempts++; return attempts === 1 ? { status: 'held', reasonCode: 'environment_changed' }
  : { ...ticket, environmentId: input.environmentId }; } }));
assert.equal((await retry.prepare(ref)).status, 'prepared'); assert.equal(renews, 2); assert.equal(attempts, 2);
pass('only environment_changed read-only replies renew once');

let exhaustedReads = 0, exhaustedLeases = 0;
const exhausted = createArgumentReferenceRagBuildClient(() => fake({ getEnvironment: async () => {
  exhaustedLeases++; return { status: 'available', environmentId: `exhausted-${exhaustedLeases}` };
}, status: async () => { exhaustedReads++; return { status: 'held', reasonCode: 'environment_changed' }; } }));
assert.deepEqual(await exhausted.status(ref), { status: 'held', reasonCode: 'environment_changed' });
assert.equal(exhaustedLeases, 2); assert.equal(exhaustedReads, 2);
pass('repeated environment invalidation is bounded to two read-only attempts');

let failedReads = 0;
const readFailure = createArgumentReferenceRagBuildClient(() => fake({ status: async () => { failedReads++; throw new Error('private host error'); } }));
assert.deepEqual(await readFailure.status(ref), { status: 'held', reasonCode: 'environment_changed' }); assert.equal(failedReads, 1);
pass('thrown read failures sanitize and stop instead of retrying through another bridge');

let invalidEnvironmentReads = 0;
for (const environmentId of ['', 'x'.repeat(301)]) {
  const invalidEnvironment = createArgumentReferenceRagBuildClient(() => fake({ getEnvironment: async () => ({ status: 'available', environmentId }),
    status: async () => { invalidEnvironmentReads++; return { status: 'held', reasonCode: 'source_pending' }; } }));
  assert.deepEqual(await invalidEnvironment.status(ref), { status: 'held', reasonCode: 'environment_changed' });
}
assert.equal(invalidEnvironmentReads, 0);
pass('empty or oversized leases cannot reach source/status operations');

let parallelLeases = 0, oldReaders = 0;
const oldGate = deferred<void>();
const parallel = createArgumentReferenceRagBuildClient(() => fake({ getEnvironment: async () => {
  parallelLeases++; return { status: 'available', environmentId: `parallel-${parallelLeases}` };
}, status: async input => {
  if (input.environmentId === 'parallel-1') {
    if (++oldReaders === 2) oldGate.resolve(); await oldGate.promise;
    return { status: 'held', reasonCode: 'environment_changed' };
  }
  return { status: 'available', source: { ...ref, version: 'v', contentHash: 'a'.repeat(64) }, sourceQualification: 'eligible', counts, propositionCount: 2 };
} }));
assert.ok((await Promise.all([parallel.status(ref), parallel.status(ref)])).every(reply => reply.status === 'available'));
assert.equal(parallelLeases, 2);
pass('late responses from an old lease do not revoke a concurrently renewed lease');

for (const reasonCode of ['request_budget', 'proposition_review_held', 'proposition_storage_unavailable'] as const) {
  attempts = 0;
  const quality = createArgumentReferenceRagBuildClient(() => fake({ prepare: async () => { attempts++; return { status: 'held', reasonCode }; } }));
  assert.deepEqual(await quality.prepare(ref), { status: 'held', reasonCode }); assert.equal(attempts, 1);
}
pass('budget and proposition failures never retry or change the model');

for (const summary of [{ ...ticket.summary, stage: undefined, maximumModelRequests: 3 },
  { ...ticket.summary, stage: 'propositions', maximumModelRequests: 5 },
  { ...ticket.summary, stage: 'structure-and-propositions', maximumModelRequests: 2 }]) {
  const mismatched = createArgumentReferenceRagBuildClient(() => fake({ prepare: async () => ({ ...ticket, summary }) as any }));
  assert.deepEqual(await mismatched.prepare(ref), { status: 'held', reasonCode: 'model_response_invalid' });
}
pass('legacy or mismatched stage budgets from the new bridge cannot become a consent ticket');

const incompleteReady = createArgumentReferenceRagBuildClient(() => fake({
  prepare: async () => ({ status: 'available', environmentId: ticket.environmentId, source: { ...ref, version: 'v', contentHash: 'a'.repeat(64) },
    sourceQualification: 'eligible', counts }) as any,
  status: async () => ({ status: 'available', source: { ...ref, version: 'v', contentHash: 'a'.repeat(64) }, sourceQualification: 'eligible', counts }) as any,
  run: async () => ({ status: 'published', counts }) as any,
}));
for (const reply of [await incompleteReady.prepare(ref), await incompleteReady.status(ref), await incompleteReady.run(ticket)]) {
  assert.deepEqual(reply, { status: 'held', reasonCode: 'model_response_invalid' });
}
pass('new ready/published replies must include an audited proposition count, never structure-only readiness');

const leaseGate = deferred<{ status: 'available'; environmentId: string }>();
let selected = '';
const capture = createArgumentReferenceRagBuildClient(() => fake({ getEnvironment: () => leaseGate.promise,
  prepare: async input => { selected = input.ref.entityId; return ticket; } }));
const mutableRef = structuredClone(ref), pending = capture.prepare(mutableRef); mutableRef.entityId = 'changed-after-await';
leaseGate.resolve({ status: 'available', environmentId: ticket.environmentId }); await pending; assert.equal(selected, ref.entityId);
pass('source selector is captured before the first await');

let sent: unknown, runLeases = 0, runCalls = 0;
const exact = createArgumentReferenceRagBuildClient(() => fake({ getEnvironment: async () => {
  runLeases++; return { status: 'available', environmentId: 'not-used' };
}, run: async input => { runCalls++; sent = input; return { status: 'held', reasonCode: 'environment_changed' }; } }));
const mutableTicket = structuredClone(ticket), runPending = exact.run(mutableTicket); mutableTicket.ticketId = 'altered-ticket';
assert.deepEqual(await runPending, { status: 'held', reasonCode: 'environment_changed' });
assert.deepEqual(sent, { environmentId: ticket.environmentId, ticketId: ticket.ticketId, consent: 'process-reference-with-propositions' });
assert.equal(runCalls, 1); assert.equal(runLeases, 0);
pass('one run uses the exact ticket and new five/two-request consent, never the legacy three-request authorization');

let failRuns = 0;
const failed = createArgumentReferenceRagBuildClient(() => fake({ run: async () => { failRuns++; throw new Error('private URL and model secret'); } }));
assert.deepEqual(await failed.run(ticket), { status: 'held', reasonCode: 'model_failed' }); assert.equal(failRuns, 1);
pass('thrown model failure is sanitized and never replayed');

const partial = createArgumentReferenceRagBuildClient(() => fake({ run: async () => ({ status: 'held',
  reasonCode: 'proposition_review_held', structureStatus: 'published', counts }) }));
assert.deepEqual(await partial.run(ticket), { status: 'held', reasonCode: 'proposition_review_held', structureStatus: 'published', counts });
pass('a stored structure with failed propositions is preserved as partial held, not overall ready');

let cancelled: unknown, cancelLeases = 0;
const cancellation = createArgumentReferenceRagBuildClient(() => fake({ getEnvironment: async () => {
  cancelLeases++; return { status: 'available', environmentId: 'never-used' };
}, cancel: async input => { cancelled = input; return { status: 'cancelled' }; } }));
await cancellation.cancel(ticket); assert.deepEqual(cancelled, { environmentId: ticket.environmentId, ticketId: ticket.ticketId });
assert.equal(cancelLeases, 0);
pass('cancel addresses the original ticket without obtaining a new lease');

assert.equal(argumentReferenceRagBuildReasonLabel('propositions_missing'), '论证结构已保存，关键命题尚待审核');
assert.equal(argumentReferenceRagBuildReasonLabel('private-unknown-error'), '参考论证暂不可用，请稍后重试');
pass('public labels distinguish the incomplete proposition stage and never expose private errors');
console.log(`Argument reference RAG client checks passed (${checks} groups; zero model/network/production writes).`);
