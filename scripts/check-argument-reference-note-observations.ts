import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { saveVaultSnapshot } from '../src/electron/vaultSnapshot.ts';
import { createArgumentProjectionEnvironmentRegistry } from '../src/electron/rag/argumentProjectionEnvironment.ts';
import { createArgumentReferenceBuildService } from '../src/electron/rag/argumentReferenceBuildService.ts';
import { createArgumentReferenceNoteObservations, argumentReferenceSavedNoteVersion } from '../src/electron/rag/argumentReferenceNoteObservations.ts';
import { expectedNoteArgumentReference } from '../src/services/argumentContext/referenceBuildClient.ts';
import { fixedAcceptProjectionReview } from './argument-projection-build-fixture.ts';
import type { ArgumentReferenceModelConfig } from '../src/electron/rag/argumentReferenceModel.ts';
import type { NoteItem } from '../src/types.ts';

// Only synthetic sources in an owned temporary root and fixed responses. Never
// reads the user's vault, invokes a model provider or changes production scores.
const previousFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('Network forbidden in note observation checks');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'loginote-reference-observations-'));
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const config: ArgumentReferenceModelConfig = { fingerprint: 'a'.repeat(64), providerLabel: 'Synthetic provider', modelName: 'synthetic-model',
  isRemote: true, provider: { apiType: 'openai-compatible', baseUrl: 'https://example.org/synthetic', apiKey: 'synthetic-only',
    selectedModel: 'synthetic-model', models: ['synthetic-model'] } };
const note = (id: string, internal = false): NoteItem => ({ id, title: `合成-${id}`, noteType: 'knowledge',
  content: '# 定义\n\n合成概念是指一种虚构关系。', createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T01:00:00.000Z',
  tags: [], links: [], backlinks: [], dueDates: [], referenceSources: internal
    ? [{ type: 'note', title: '合成内部引用', entityId: 'dependency' }]
    : [{ type: 'web', title: '虚构测试出处', url: 'https://example.org/synthetic-reference' }] });
let checks = 0, fixtures = 0;
const pass = (label: string) => { checks++; console.log(`PASS ${label}`); };
async function rig(internal = false, delayPrepare = false) {
  const dataRoot = path.join(temporary, `fixture-${++fixtures}`), roots = { dataRoot, vaultRoot: path.join(dataRoot, 'vault'), userStateDir: path.join(dataRoot, 'user-state') };
  let saved = [note('source', internal), note('dependency'), note('unrelated')], calls = 0, reads = 0;
  await saveVaultSnapshot(roots.vaultRoot, roots.userStateDir, saved);
  const registry = createArgumentProjectionEnvironmentRegistry(() => roots), response = deferred<void>(), started = deferred<void>();
  const prepareGate = deferred<void>(), prepareStarted = deferred<void>();
  const service = createArgumentReferenceBuildService({ environments: registry, model: {
    read: async () => { if (++reads === 2 && delayPrepare) { prepareStarted.resolve(); await prepareGate.promise; } return structuredClone(config); },
    invoke: async (_config, request) => {
      calls++; const payload = JSON.parse(request.userInput);
      if (request.bindingId.startsWith('source-review:')) {
        started.resolve(); await response.promise;
        return JSON.stringify({ version: 1, reviewId: payload.reviewId, decision: 'eligible', relevantContentPresent: true,
          noCriticalSourceGaps: true, quoteIds: [payload.quotes.find((q: any) => q.completeSentence && q.evidence.quote.includes('是指')).quoteId],
          reason: '固定合成内容审核，不认证事实真理。' });
      }
      if (request.stage === 'extract') {
        const quoteId = payload.quotes.find((q: any) => q.completeSentence && q.evidence.quote.includes('是指')).quoteId;
        return JSON.stringify({ version: 1, buildId: payload.buildId, nodes: [{ id: 'N1', role: 'definition', quoteIds: [quoteId] }],
          relations: [], groups: [], scopes: [{ id: 'S1', seedNodeId: 'N1', task: 'definition', requiredNodeIds: ['N1'],
            requiredRelationIds: [], requiredGroupIds: [], quoteIds: [quoteId] }] });
      }
      return JSON.stringify(fixedAcceptProjectionReview(payload));
    },
  } });
  const environment = await registry.getEnvironment(1); assert.equal(environment.status, 'available');
  if (environment.status !== 'available') throw new Error('synthetic environment unavailable');
  const sourceRequest = { environmentId: environment.environmentId, ref: { kind: 'knowledge-note' as const, entityId: 'source' } };
  async function change(id: string, mutate: (value: NoteItem) => NoteItem, partial = false) {
    const next = saved.map(value => value.id === id ? mutate(structuredClone(value)) : structuredClone(value));
    if (partial) service.observeNoteDelta(next.filter(value => value.id === id), saved.filter(value => value.id === id));
    else service.observeNoteSnapshot(next, saved);
    await saveVaultSnapshot(roots.vaultRoot, roots.userStateDir, next); saved = next;
  }
  async function run() {
    const prepared = await service.prepare(1, sourceRequest); assert.equal(prepared.status, 'prepared');
    if (prepared.status !== 'prepared') throw new Error('synthetic prepare failed');
    const running = service.run(1, { environmentId: prepared.environmentId, ticketId: prepared.ticketId, consent: 'process-reference' });
    await started.promise; return { prepared, running };
  }
  return { service, sourceRequest, started, response, prepareGate, prepareStarted, change, run,
    deltaChange: (id: string, mutate: (value: NoteItem) => NoteItem) => change(id, mutate, true),
    original: (id: string) => structuredClone(saved.find(value => value.id === id)!), calls: () => calls };
}
try {
  const synthetic = note('identity');
  assert.equal(argumentReferenceSavedNoteVersion(synthetic), (await expectedNoteArgumentReference(synthetic)).version);
  assert.equal(argumentReferenceSavedNoteVersion({ ...synthetic, updatedAt: '2026-10-07T09:00:00.000Z', lastReferencedAt: '2026-10-07T09:00:00.000Z' }),
    argumentReferenceSavedNoteVersion(synthetic));
  pass('host synchronous observation identity exactly matches canonical source identity and excludes activity timestamps');

  const own = await rig(), ownA = own.original('source'), ownRun = await own.run();
  await own.change('source', value => ({ ...value, content: '临时 B 正文。' })); await own.change('source', () => ownA);
  own.response.resolve(); const ownResult = await ownRun.running;
  assert.deepEqual(ownResult, { status: 'held', reasonCode: 'source_changed' }); assert.equal(own.calls(), 1);
  assert.deepEqual(await own.service.run(1, { environmentId: ownRun.prepared.environmentId, ticketId: ownRun.prepared.ticketId, consent: 'process-reference' }), ownResult);
  pass('application-observed source A→B→A cannot revive a pending or repeated consented ticket');
  const fresh = await own.service.prepare(1, own.sourceRequest); assert.equal(fresh.status, 'prepared'); assert.equal(own.calls(), 1);
  if (fresh.status !== 'prepared') throw new Error('synthetic fresh prepare failed');
  assert.notEqual(fresh.ticketId, ownRun.prepared.ticketId);
  assert.equal((await own.service.run(1, { environmentId: fresh.environmentId, ticketId: fresh.ticketId, consent: 'process-reference' })).status, 'published');
  assert.equal(own.calls(), 4);
  pass('a fresh explicit consent can rebuild restored content, without reviving or automatically retrying the old ticket');

  const internal = await rig(true), dependencyA = internal.original('dependency'), internalRun = await internal.run();
  await internal.change('dependency', value => ({ ...value, content: '内部出处临时变为 B。' })); await internal.change('dependency', () => dependencyA);
  internal.response.resolve(); assert.deepEqual(await internalRun.running, { status: 'held', reasonCode: 'source_changed' }); assert.equal(internal.calls(), 1);
  pass('application-observed internal citation A→B→A cannot revive an unchanged main-source ticket');

  const independent = await rig(true), independentRun = await independent.run();
  await independent.change('source', value => ({ ...value, lastReferencedAt: '2026-10-07T06:00:00.000Z', updatedAt: '2026-10-07T06:00:00.000Z' }));
  await independent.change('dependency', value => ({ ...value, pinned: true, updatedAt: '2026-10-07T07:00:00.000Z' }));
  await independent.change('unrelated', value => ({ ...value, content: '另一个项目的合成正文变化。' }));
  independent.response.resolve(); assert.equal((await independentRun.running).status, 'published'); assert.equal(independent.calls(), 3);
  pass('personal source/dependency activity and unrelated note content changes preserve a single three-stage build');

  for (const internalReference of [false, true]) {
    const preparing = await rig(internalReference, true), target = internalReference ? 'dependency' : 'source', original = preparing.original(target);
    const pending = preparing.service.prepare(1, preparing.sourceRequest); await preparing.prepareStarted.promise;
    await preparing.change(target, value => ({ ...value, content: '准备票安装前的临时 B。' })); await preparing.change(target, () => original);
    preparing.prepareGate.resolve(); assert.deepEqual(await pending, { status: 'held', reasonCode: 'source_changed' }); assert.equal(preparing.calls(), 0);
    pass(`prepare snapshot→installation race observes ${internalReference ? 'internal dependency' : 'source'} B→A before any model invocation`);
  }
  const preparingActivity = await rig(true, true), activity = preparingActivity.service.prepare(1, preparingActivity.sourceRequest);
  await preparingActivity.prepareStarted.promise;
  await preparingActivity.change('dependency', value => ({ ...value, updatedAt: '2026-10-07T07:00:00.000Z', pinned: true }));
  await preparingActivity.change('unrelated', value => ({ ...value, content: '准备期间无关笔记变化。' }));
  preparingActivity.prepareGate.resolve(); assert.equal((await activity).status, 'prepared'); assert.equal(preparingActivity.calls(), 0);
  pass('prepare-time unrelated edits and personal activity do not become a global snapshot epoch rejection');

  const pure = createArgumentReferenceNoteObservations(), start = pure.begin(), original = note('delete-readd');
  const observation = pure.capture(start, [{ kind: 'knowledge-note', entityId: original.id, version: argumentReferenceSavedNoteVersion(original) } as any]);
  pure.observe([], [original]); assert.equal(pure.current(observation), false);
  pure.observe([original], []); assert.equal(pure.current(observation), false);
  pass('deleted/re-added identical content has a new observation and cannot restore an old note token');
  const partialUnrelated = await rig(true), partialRun = await partialUnrelated.run();
  await partialUnrelated.deltaChange('unrelated', value => ({ ...value, content: '局部保存无关笔记' }));
  partialUnrelated.response.resolve(); assert.equal((await partialRun.running).status, 'published');
  pass('局部保存无关笔记不删除其他源的观察，不撤销已同意的构建');
  const partialSource = await rig(), partialSourceRun = await partialSource.run();
  await partialSource.deltaChange('source', value => ({ ...value, content: '局部保存改变了当前来源' }));
  partialSource.response.resolve(); assert.deepEqual(await partialSourceRun.running, { status: 'held', reasonCode: 'source_changed' });
  assert.equal(partialSource.calls(), 1);
  pass('局部保存来源正文会撤销相关构建；不会继续使用旧证据');
  console.log(`Argument reference note observation checks passed (${checks} groups; synthetic local sources; zero network/provider calls).`);
} finally {
  globalThis.fetch = previousFetch;
  const resolved = path.resolve(temporary), prefix = path.resolve(os.tmpdir()) + path.sep;
  assert.ok(resolved.startsWith(prefix) && path.basename(resolved).startsWith('loginote-reference-observations-'));
  await fs.rm(resolved, { recursive: true, force: true });
}
