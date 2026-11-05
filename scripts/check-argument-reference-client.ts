import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createArgumentReferenceBuildClient, expectedNoteArgumentReference, argumentReferenceBuildReasonLabel,
  type ArgumentReferenceBuildApi, type PreparedReferenceBuild } from '../src/services/argumentContext/referenceBuildClient.ts';
import type { NoteItem } from '../src/types.ts';
import { adaptSavedKnowledgeNote } from '../src/electron/rag/argumentSourceAdapter.ts';
let checks = 0;
const pass = (label: string) => { checks++; console.log(`PASS ${label}`); };
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('No network in reference client checks');
const ref = { kind: 'knowledge-note' as const, entityId: 'synthetic-note' };
const ticket: PreparedReferenceBuild = { status: 'prepared', environmentId: 'build-env', ticketId: 'ticket', expiresAt: '2026-10-07T02:10:00.000Z',
  summary: { sourceKind: ref.kind, entityId: ref.entityId, sourceVersion: 'v', contentHash: 'a'.repeat(64), characters: 30,
    sentences: 2, chunks: 1, providerLabel: 'Synthetic local', modelName: 'mock', isRemote: false, maximumModelRequests: 3, reviewBudget: 'checked-after-extraction' } };
const fake = (patch: Partial<ArgumentReferenceBuildApi> = {}): ArgumentReferenceBuildApi => ({
  getEnvironment: async () => ({ status: 'available', environmentId: 'build-env' }),
  prepare: async () => structuredClone(ticket), status: async () => ({ status: 'held', reasonCode: 'source_pending' }),
  run: async () => ({ status: 'published', counts: { nodes: 2, relations: 1, groups: 0, scopes: 1 } }),
  cancel: async () => ({ status: 'cancelled' }), ...patch,
});
try {
  const missing = createArgumentReferenceBuildClient(() => undefined);
  assert.equal((await missing.prepare(ref)).status, 'held'); assert.equal((await missing.status(ref)).status, 'held');
  assert.equal((await missing.run(ticket)).status, 'held');
  pass('浏览器/接口缺失保守返回held，不使用云或伪造可用结构');

  let leases = 0, runs = 0;
  const shared = createArgumentReferenceBuildClient(() => fake({ getEnvironment: async () => {
    leases++; await Promise.resolve(); return { status: 'available', environmentId: 'build-env' };
  }, run: async () => { runs++; return { status: 'held', reasonCode: 'model_failed' }; } }));
  await Promise.all([shared.status(ref), shared.prepare(ref), shared.status({ ...ref, entityId: 'other' })]);
  assert.equal(leases, 1); assert.equal(runs, 0);
  pass('状态读取和准备共用build lease，不自动请求模型，也不替代review lease');
  shared.invalidate(); await shared.status(ref);
  assert.equal(leases, 2); assert.equal(runs, 0);
  pass('host失效通知清掉旧build lease，后续只续租读取、不自动发送');

  let attempts = 0, renews = 0;
  const renewal = createArgumentReferenceBuildClient(() => fake({ getEnvironment: async () => {
    renews++; return { status: 'available', environmentId: `env-${renews}` };
  }, prepare: async request => {
    attempts++; return attempts === 1 ? { status: 'held', reasonCode: 'environment_changed' } : { ...ticket, environmentId: request.environmentId };
  } }));
  const renewed = await renewal.prepare(ref);
  assert.equal(renewed.status, 'prepared'); assert.equal(attempts, 2); assert.equal(renews, 2);
  pass('只读prepare过期时至多续租一次，不自动run');

  let parallelLeases = 0, oldReaders = 0, releaseOld!: () => void;
  const oldBarrier = new Promise<void>(resolve => { releaseOld = resolve; });
  const parallelRenewal = createArgumentReferenceBuildClient(() => fake({ getEnvironment: async () => {
    parallelLeases++; return { status: 'available', environmentId: `parallel-${parallelLeases}` };
  }, status: async input => {
    if (input.environmentId === 'parallel-1') {
      if (++oldReaders === 2) releaseOld(); await oldBarrier;
      return { status: 'held', reasonCode: 'environment_changed' };
    }
    return { status: 'available', source: { ...ref, version: 'v', contentHash: 'a'.repeat(64) },
      sourceQualification: 'eligible', counts: { nodes: 2, relations: 1, groups: 0, scopes: 1 } };
  } }));
  const parallelReplies = await Promise.all([parallelRenewal.status(ref), parallelRenewal.status(ref)]);
  assert.equal(parallelLeases, 2); assert.ok(parallelReplies.every(reply => reply.status === 'available'));
  pass('多行旧lease同时失效仅续租一次，旧响应不清掉新lease或互相撤销已准备任务');

  attempts = 0;
  const nonEnvironment = createArgumentReferenceBuildClient(() => fake({ prepare: async () => {
    attempts++; return { status: 'held', reasonCode: 'request_budget' };
  } }));
  await nonEnvironment.prepare(ref); assert.equal(attempts, 1);
  pass('预算或质量问题不重试、不截断、不中转到其他模型');

  let resolveLease!: (reply: { status: 'available'; environmentId: string }) => void;
  const delayed = new Promise<{ status: 'available'; environmentId: string }>(resolve => { resolveLease = resolve; });
  let selected = '';
  const clone = createArgumentReferenceBuildClient(() => fake({ getEnvironment: () => delayed,
    prepare: async request => { selected = request.ref.entityId; return ticket; } }));
  const mutableRef = structuredClone(ref), pending = clone.prepare(mutableRef);
  mutableRef.entityId = 'changed-after-await'; resolveLease({ status: 'available', environmentId: 'build-env' });
  await pending; assert.equal(selected, ref.entityId);
  pass('第一次await前捕获source selector，后改对象不能扩大选择');

  let request: unknown;
  const noRunRetry = createArgumentReferenceBuildClient(() => fake({ run: async input => {
    runs++; request = input; throw new Error('private server error');
  } }));
  const before = runs, result = await noRunRetry.run(ticket);
  assert.equal(runs - before, 1); assert.deepEqual(request, { environmentId: ticket.environmentId, ticketId: ticket.ticketId, consent: 'process-reference' });
  assert.deepEqual(result, { status: 'held', reasonCode: 'model_failed' });
  pass('run使用用户确认的原ticket，仅一次调用，不续租/重试/暴露错误');

  const note: NoteItem = { id: ref.entityId, noteType: 'knowledge', title: '合成定义', content: '在条件B下，A可能导致C。🧠\r\n',
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-07T02:00:00.000Z', tags: [], links: [], backlinks: [], dueDates: [],
    referenceSources: [{ title: '合成出处', type: 'web', url: 'https://example.org/synthetic' }] };
  const input = await adaptSavedKnowledgeNote({ note, rootScopeId: 'synthetic-root', scope: {
    scopeId: 'synthetic-scope', rootScopeId: 'synthetic-root', corpus: 'reference', allowedSourceKinds: ['knowledge-note'],
    allowedNoteIds: [note.id], allowedDocIds: [], allowedRecordIds: [] } });
  const expected = await expectedNoteArgumentReference(note);
  assert.equal(expected.version, input.source.version); assert.equal(expected.contentHash, input.source.contentHash);
  assert.deepEqual(await expectedNoteArgumentReference({ ...note, updatedAt: '2026-10-07T03:00:00.000Z', flowSummary: '个人复述' }), expected);
  for (const changed of [{ ...note, content: '改动正文' }, { ...note, title: '改动标题' }, { ...note, referenceSources: [] }]) {
    assert.notEqual((await expectedNoteArgumentReference(changed)).version, expected.version);
  }
  pass('显示正文/标题/出处匹配保存源身份，个人活动不改变版本，草稿变化可检测');

  const [main, preload, component, editor, docs] = await Promise.all([
    fs.readFile(new URL('../src/electron/main.ts', import.meta.url), 'utf8'),
    fs.readFile(new URL('../src/electron/preload.ts', import.meta.url), 'utf8'),
    fs.readFile(new URL('../src/components/ReferenceArgumentStatus.tsx', import.meta.url), 'utf8'),
    fs.readFile(new URL('../src/components/NoteEditor.tsx', import.meta.url), 'utf8'),
    fs.readFile(new URL('../src/components/DocumentsView.tsx', import.meta.url), 'utf8'),
  ]);
  for (const route of ['get-environment', 'prepare', 'status', 'run', 'cancel']) {
    assert.match(main, new RegExp(`ipcMain.handle\\('argument-reference:${route}'`));
    assert.match(preload, new RegExp(`argument-reference:${route}`));
  }
  assert.match(main, /createArgumentReferenceBuildService\(\{ environments: referenceBuildEnvironments, draftProtocol: 'selection-v2',\s*reviewProtocol: 'task-grounded-v3' \}\)/);
  assert.match(main, /referenceCallerAllowed\(event\) \|\| args.length/);
  assert.match(main, /user-state:save-llm'[\s\S]{0,150}revokeReferenceBuilds\(\)/);
  assert.match(main, /did-start-navigation'[\s\S]{0,300}revokeReferenceBuilds\(win.webContents.id\)/);
  assert.match(main, /argument-reference:run'[\s\S]{0,280}referenceBuilds.run/);
  assert.doesNotMatch(preload, /argument-reference:(?:publish|record|submit-review)/);
  pass('主窗口校验/独立build registry/设置与导航撤销接线，不暴露raw publish入口（源码检查）');
  assert.match(component, /role="dialog"/); assert.match(component, /aria-modal="true"/); assert.match(component, /useDialog\(true, dialogRef, onClose, 95\)/);
  assert.match(component, /aria-live="polite"/); assert.match(component, /motion-reduce:animate-none/);
  assert.match(component, /if \(!confirmation \|\| confirmation.key !== key \|\| disabled && disabledBehavior === 'invalidate' \|\| operation.current\) return/);
  assert.match(component, /disabledBehavior = 'invalidate'/);
  assert.match(component, /disabledBehavior === 'invalidate' \? disabled : null/);
  assert.match(component, /if \(!current\(captured, epoch\)\)/); assert.match(component, /contentHash !== expected.contentHash/);
  assert.match(component, /onInvalidated\?\.\(\(\) => \{[\s\S]{0,100}generation.current\+\+/);
  assert.match(component, /epoch === undefined \|\| generation.current === epoch/);
  assert.match(component, /!operation.current && !job.current/);
  assert.match(preload, /argument-reference:invalidated/);
  assert.match(main, /send\('argument-reference:invalidated'\)/);
  assert.match(editor, /note.noteType === 'knowledge' && <ReferenceArgumentStatus/);
  assert.match(editor, /ReferenceArgumentStatus[\s\S]{0,300}disabledBehavior="hold"/);
  assert.match(docs, /doc.parseStatus !== 'ready'/);
  assert.doesNotMatch(docs, /disabledBehavior="hold"/);
  assert.equal(argumentReferenceBuildReasonLabel('unknown-private-error'), '参考论证暂不可用，请稍后重试');
  pass('一次确认、焦点管理、状态播报、草稿及旧回执防误用，笔记/资料入口接线（非真实UI验收）');
  console.log(`Argument reference client checks passed (${checks} groups, no network/real data).`);
} finally { globalThis.fetch = originalFetch; }
