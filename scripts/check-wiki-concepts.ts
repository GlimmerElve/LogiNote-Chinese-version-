import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { ConceptDraft, NoteItem } from '../src/types';
import { createConceptBatchRuntime, type ConceptBatchConfiguration, type ConceptBatchContext } from '../src/services/conceptBatchRuntime';
import { normalizeConceptBatchJobs, normalizeConceptDraft, type ConceptBatchJob } from '../src/services/conceptBatchTypes';
import { previewWikiConceptBatch } from '../src/services/conceptBatchScope';
import { initializeWikiKnowledge, KNOWLEDGE_PLACEHOLDER } from '../src/services/wikiKnowledge';
import { applyWorkspaceNoteChange } from '../src/services/agent/workspaceOperations';
import { applyAgentTaskStatePatch, normalizeAgentTaskState } from '../src/services/agent/taskStateCodec';
import { textbookRegionMarkers } from '../src/services/textbook/noteContent';
import { bootstrapAgentRuntime } from '../src/services/agent/bootstrap';
import { AGENT_ROLES, runAgentTurn, resolveAgentApproval } from '../src/services/agent/agentEngine';
import { registerConceptTools } from '../src/services/agent/tools/conceptTools';
import { getTool, toolRequiresApproval } from '../src/services/agent/toolRegistry';
import { createAgentApprovalBinding, validateAgentApprovalBinding } from '../src/services/agent/approvalBinding';
import type { AgentRuntimeContext } from '../src/services/agent/types';
import { generateConcept } from '../src/services/conceptFillService';
import { getWorkflowById } from '../src/workflows/workflowRegistry';
import { loadLlmSettings, saveLlmSettings, flushLlmSettingsWrites } from '../src/services/llmStorage';
import type { LlmProvider } from '../src/types';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConceptBatchProgress } from '../src/components/ConceptBatchProgress';

globalThis.fetch = async () => { throw new Error('Network/model calls forbidden in offline checks'); };
const cache = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => cache.get(key) ?? null, setItem: (key: string, value: string) => cache.set(key, value), removeItem: (key: string) => cache.delete(key),
} });
const project = (id = 'p', content = '学习 [[心流]] 与 [[反馈]]'): NoteItem => ({ ...initializeWikiKnowledge('学习项目', id), noteType: 'project', content });
const request = { projectNoteId: 'p', source: 'rag' as const, allowCloud: false };
const draft = (note: NoteItem): ConceptDraft => ({ noteId: note.id, title: note.title, source: 'rag', content: `# ${note.title}\n\n可核对的概念说明 [1]。`,
  references: [{ sourceId: '1', type: 'document', title: '合成证据', entityId: 'fixture-doc' }], createdAt: new Date().toISOString() });
const defer = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
let groups = 0;
async function test(name: string, run: () => Promise<void> | void) { await run(); console.log(`PASS ${name}`); groups++; }
function fixture(initial = [project()], restored: ConceptBatchJob[] = []) {
  let notes = structuredClone(initial), stored = structuredClone(restored), scope = 'fixture-vault';
  let fingerprint = 'a'.repeat(64), local = true, calls = 0, failSave = false;
  const applied: string[] = [], writes: ConceptBatchJob[][] = [];
  let generate: ConceptBatchConfiguration['generate'] = async note => draft(note);
  let applyHook: ((change: Parameters<ConceptBatchContext['apply']>[0]) => void | Promise<void>) | undefined;
  let saveHook: ((jobs: ConceptBatchJob[]) => void | Promise<void>) | undefined;
  const configuration = async (): Promise<ConceptBatchConfiguration> => ({ fingerprint, local, label: local ? '本机 · fixture' : '远程 · fixture',
    generate: async (note, source, options) => { calls++; return generate(note, source, options); } });
  const runtime = createConceptBatchRuntime({ scope: async () => scope,
    load: async () => ({ scopeId: scope, jobs: structuredClone(stored) }),
    save: async (owner, jobs) => {
      assert.equal(owner, scope, 'Never save into another vault');
      if (failSave) throw new Error('disk unavailable');
      await saveHook?.(jobs); stored = structuredClone(jobs); writes.push(structuredClone(jobs));
    }, configuration });
  const ctx: ConceptBatchContext = { notes: () => notes, flush: async () => {}, apply: async (change, owner) => {
    assert.equal(owner, scope); await applyHook?.(change); notes = applyWorkspaceNoteChange(notes, change); applied.push(change.kind);
  } };
  return { runtime, ctx, configuration, calls: () => calls, notes: () => notes, stored: () => structuredClone(stored), writes, applied,
    edit: (mutate: (notes: NoteItem[]) => NoteItem[]) => { notes = mutate(notes); },
    setGenerate: (fn: typeof generate) => { generate = fn; }, setApply: (fn: typeof applyHook) => { applyHook = fn; },
    setSave: (fn: typeof saveHook) => { saveHook = fn; }, failSave: (value: boolean) => { failSave = value; },
    changeScope: () => { scope = 'other-vault'; }, changeModel: () => { fingerprint = 'b'.repeat(64); }, remote: () => { local = false; },
  };
}

await test('Wiki scope deduplicates aliases and excludes filled/project/code/textbook links', () => {
  const p = project('p', '[[心流]] [[flow|显示名]] [[有正文]] [[另一个项目]]\n`[[内联示例]]`\n<!-- [[注释]] -->\n![[图片]]\n```md\n[[代码示例]]\n```');
  const existing = initializeWikiKnowledge('心流', 'k'); existing.aliases = ['flow'];
  const filled = { ...initializeWikiKnowledge('有正文', 'filled'), content: '用户原文' };
  const preview = previewWikiConceptBatch([p, existing, filled, { ...project('other', ''), title: '另一个项目' }], request);
  assert.equal(preview.eligible, 1); assert.equal(preview.candidates.length, 4);
  assert.equal(preview.candidates[1].action, 'skip-duplicate');
  const manifest = { projectNoteId: 'p', regionId: 'tb' } as NonNullable<NoteItem['textbook']>;
  const [start, end] = textbookRegionMarkers('tb');
  const managed = { ...project('p', `[[真实概念]]\n${start}\n[[教材示例]]\n${end}`), textbook: manifest };
  assert.deepEqual(previewWikiConceptBatch([managed], request).candidates.map(item => item.title), ['真实概念']);
  assert.throws(() => previewWikiConceptBatch([{ ...managed, content: `[[真实概念]]\n${start}` }], request), /边界/);
  assert.throws(() => previewWikiConceptBatch([p, existing, { ...existing, id: 'duplicate' }], request), /歧义/);
  assert.throws(() => previewWikiConceptBatch([p], { ...request, titles: ['项目未引用的笔记'] }), /真实 Wiki/);
});
await test('read-only preview creates nothing; remote model needs explicit approved scope', async () => {
  const f = fixture(); f.remote(); await f.runtime.preview(request, f.ctx);
  assert.equal(f.notes().length, 1); assert.equal(f.calls(), 0); assert.equal(f.writes.length, 0);
  await assert.rejects(f.runtime.start(request, f.ctx), /远程模型/);
  assert.equal(f.applied.length, 0);
});
await test('durable job precedes initialization/model; per-note real save preserves project', async () => {
  const p = project(); const f = fixture([p]);
  f.setGenerate(async note => { assert.ok(f.stored()[0].items.find(item => item.noteId === note.id)?.attempts); return draft(note); });
  await f.runtime.start(request, f.ctx); await f.runtime.waitForIdle();
  assert.equal(f.calls(), 2); assert.equal(f.runtime.getSnapshot()[0].status, 'completed');
  assert.deepEqual(f.notes().find(note => note.id === 'p'), p);
  assert.deepEqual(f.applied, ['create', 'edit', 'create', 'edit']);
  assert.ok(f.notes().filter(note => note.noteType === 'knowledge').every(note => note.referenceSources?.length === 1));
});
await test('checkpoint failure starts no model and can be explicitly resumed', async () => {
  const f = fixture(); f.failSave(true);
  await assert.rejects(f.runtime.start(request, f.ctx), /检查点/);
  assert.equal(f.calls(), 0); assert.equal(f.applied.length, 0);
  assert.equal(f.runtime.getSnapshot()[0].status, 'paused');
  f.failSave(false); await f.runtime.resume(f.runtime.getSnapshot()[0].id, f.ctx); await f.runtime.waitForIdle();
  assert.equal(f.calls(), 2);
});
await test('page/assistant lifetime does not bind task target; explicit stop retains checkpoint', async () => {
  const f = fixture(); const started = defer<void>();
  f.setGenerate(async (_note, _source, options) => {
    started.resolve(); return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('stopped', 'AbortError')), { once: true }));
  });
  const job = await f.runtime.start(request, f.ctx); await started.promise;
  const unsubscribe = f.runtime.subscribe(() => {}); unsubscribe(); // Closing a UI only unsubscribes.
  assert.equal(f.runtime.getSnapshot()[0].status, 'running');
  await f.runtime.stop(job.id); await f.runtime.waitForIdle();
  assert.equal(f.runtime.getSnapshot()[0].status, 'paused');
  assert.equal(f.notes().filter(note => note.content === KNOWLEDGE_PLACEHOLDER).length, 1);
  assert.equal(f.calls(), 1);
});
await test('edits during generation become per-note conflicts without overwriting', async () => {
  const f = fixture(); f.setGenerate(async note => {
    if (note.title === '心流') f.edit(notes => notes.map(item => item.id === note.id ? { ...item, content: '用户正在编辑的正文' } : item));
    return draft(note);
  });
  await f.runtime.start(request, f.ctx); await f.runtime.waitForIdle();
  assert.equal(f.notes().find(note => note.title === '心流')?.content, '用户正在编辑的正文');
  const job = f.runtime.getSnapshot()[0]; assert.equal(job.status, 'partial');
  assert.equal(job.items[0].status, 'conflict'); assert.ok(job.items[0].draft); assert.equal(job.items[1].status, 'completed');
});
await test('save retry reuses persisted draft and never regenerates successful notes', async () => {
  const f = fixture(); let failed = false;
  f.setApply(change => { if (change.kind === 'edit' && !failed) { failed = true; throw new Error('synthetic save failure'); } });
  const job = await f.runtime.start(request, f.ctx); await f.runtime.waitForIdle();
  assert.equal(f.calls(), 2); assert.ok(f.stored()[0].items[0].draft);
  await assert.rejects(f.runtime.start(request, f.ctx), /未完成任务/);
  await f.runtime.resume(job.id, f.ctx); await f.runtime.waitForIdle();
  assert.equal(f.calls(), 2); assert.equal(f.runtime.getSnapshot()[0].status, 'completed');
});
await test('new project request never resumes the old project failure', async () => {
  const other = { ...project('p2', '[[心理账户]]'), title: '学习心理账户' };
  const f = fixture([project('p', '[[心流]]'), other]);
  f.setGenerate(async note => { if (note.title === '心流') throw new Error('old project failure'); return draft(note); });
  await f.runtime.start(request, f.ctx); await f.runtime.waitForIdle();
  await f.runtime.start({ ...request, projectNoteId: 'p2' }, f.ctx); await f.runtime.waitForIdle();
  const jobs = f.runtime.getSnapshot(); assert.equal(jobs[0].status, 'partial'); assert.equal(jobs[1].status, 'completed');
  assert.equal(jobs[1].projectNoteId, 'p2'); assert.deepEqual(jobs[1].items.map(item => item.wikiTitle), ['心理账户']);
});
await test('restart pauses without replay; uncertain saved write reconciles without extra tokens', async () => {
  const f = fixture([project('p', '[[心流]]')]);
  f.setSave(jobs => { if (jobs[0]?.items[0].status === 'completed') throw new Error('metadata write failure after note saved'); });
  const job = await f.runtime.start(request, f.ctx); await assert.rejects(f.runtime.waitForIdle(), /metadata write failure/);
  assert.ok(f.runtime.getPersistenceError());
  assert.equal(f.calls(), 1); assert.ok(f.stored()[0].items[0].draft);
  const restored = fixture(f.notes(), f.stored()); await restored.runtime.ensureReady();
  assert.equal(restored.calls(), 0); assert.equal(restored.runtime.getSnapshot()[0].status, 'paused');
  await restored.runtime.resume(job.id, restored.ctx); await restored.runtime.waitForIdle();
  assert.equal(restored.calls(), 0); assert.equal(restored.applied.length, 0); assert.equal(restored.runtime.getSnapshot()[0].status, 'completed');
});
await test('storage/model changes stop old work; deleted initialized notes are not recreated', async () => {
  const changed = fixture(); changed.setGenerate(async note => { changed.changeModel(); return draft(note); });
  await changed.runtime.start(request, changed.ctx); await changed.runtime.waitForIdle();
  assert.equal(changed.calls(), 1); assert.equal(changed.applied.filter(kind => kind === 'edit').length, 0);
  await assert.rejects(changed.runtime.resume(changed.runtime.getSnapshot()[0].id, changed.ctx), /配置已变化/);
  const moved = fixture(); moved.setGenerate(async note => { moved.changeScope(); return draft(note); });
  await moved.runtime.start(request, moved.ctx); await moved.runtime.waitForIdle().catch(() => {});
  assert.equal(moved.calls(), 1); assert.equal(moved.applied.filter(kind => kind === 'edit').length, 0);
  const deleted = fixture([project('p', '[[心流]]')]); deleted.setGenerate(async () => { throw new Error('fail'); });
  const job = await deleted.runtime.start(request, deleted.ctx); await deleted.runtime.waitForIdle();
  deleted.edit(notes => notes.filter(note => note.noteType === 'project'));
  await deleted.runtime.resume(job.id, deleted.ctx); await deleted.runtime.waitForIdle();
  assert.equal(deleted.notes().length, 1); assert.equal(deleted.calls(), 1); assert.equal(deleted.runtime.getSnapshot()[0].items[0].status, 'conflict');
});
await test('model changes require a newly bound approval and keep original targets/attempts', async () => {
  const f = fixture([project('p', '[[心流]]')]); f.setGenerate(async () => { throw new Error('old provider failure'); });
  const job = await f.runtime.start(request, f.ctx); await f.runtime.waitForIdle();
  const targetId = f.runtime.getSnapshot()[0].items[0].noteId;
  f.changeModel(); await assert.rejects(f.runtime.resume(job.id, f.ctx), /配置已变化/);
  f.setGenerate(async note => draft(note));
  await f.runtime.resume(job.id, f.ctx, { fingerprint: (await f.configuration()).fingerprint, allowCloud: false });
  await f.runtime.waitForIdle();
  assert.equal(f.runtime.getSnapshot()[0].items[0].noteId, targetId);
  assert.equal(f.runtime.getSnapshot()[0].items[0].attempts, 2); assert.equal(f.calls(), 2);
  assert.equal(f.runtime.getSnapshot()[0].status, 'completed');
});
await test('whole-app stop preserves running and queued concept jobs without starting the next model', async () => {
  const f = fixture([project('p', '[[心流]]'), { ...project('p2', '[[心理账户]]'), title: '另一个项目' }]);
  const started = defer<void>();
  f.setGenerate(async (_note, _source, options) => { started.resolve(); return new Promise((_yes, no) => options.signal.addEventListener('abort', () => no(new DOMException('stop', 'AbortError')), { once: true })); });
  await f.runtime.start(request, f.ctx); await started.promise;
  await f.runtime.start({ ...request, projectNoteId: 'p2' }, f.ctx);
  await f.runtime.stopAll(); assert.equal(f.calls(), 1);
  assert.ok(f.runtime.getSnapshot().every(job => job.status === 'paused'));
  assert.ok(f.stored().every(job => job.status === 'paused'));
});
await test('concurrent starts/resumes do not duplicate jobs or paid work', async () => {
  const f = fixture([project('p', '[[心流]]')]); const started = defer<void>(), finish = defer<ConceptDraft>();
  f.setGenerate(async note => { started.resolve(); await finish.promise; return draft(note); });
  const results = await Promise.allSettled([f.runtime.start(request, f.ctx), f.runtime.start(request, f.ctx)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  await started.promise; assert.equal(f.runtime.getSnapshot().length, 1); assert.equal(f.calls(), 1);
  finish.resolve(draft(initializeWikiKnowledge('心流', 'unused'))); await f.runtime.waitForIdle();
});
await test('bad drafts cannot write and failed generation has no implicit retry', async () => {
  const f = fixture([project('p', '[[心流]]')]); f.setGenerate(async note => ({ ...draft(note), references: [] }));
  const job = await f.runtime.start(request, f.ctx); await f.runtime.waitForIdle();
  assert.equal(f.calls(), 1); assert.equal(f.applied.filter(kind => kind === 'edit').length, 0);
  assert.throws(() => normalizeConceptDraft({ ...draft(initializeWikiKnowledge('心流', 'k')), content: '<ArgumentBlock id="bad" /> [1]' }, 'k', 'rag'), /结构/);
  for (let attempt = 0; attempt < 3; attempt++) { await f.runtime.resume(job.id, f.ctx); await f.runtime.waitForIdle(); }
  assert.equal(f.calls(), 3); assert.equal(f.runtime.getSnapshot()[0].status, 'partial');
});
await test('private task codec merges categories and rejects polluted/invalid targets', async () => {
  const f = fixture(); await f.runtime.start(request, f.ctx); await f.runtime.waitForIdle();
  const merged = applyAgentTaskStatePatch(null, { kind: 'concepts', jobs: f.stored() });
  const after = applyAgentTaskStatePatch(merged, { kind: 'documents', jobs: [] });
  assert.equal(after.concepts?.length, 1); assert.deepEqual(after.sequences, {});
  assert.deepEqual(normalizeAgentTaskState({ version: 1, documents: [], sequences: {} }).documents, []);
  const polluted = JSON.parse(JSON.stringify(f.stored())); polluted[0].apiKey = 'must-not-survive';
  assert.ok(!JSON.stringify(normalizeConceptBatchJobs(polluted)).includes('must-not-survive'));
  polluted[0].items[0].noteId = ''; assert.throws(() => normalizeConceptBatchJobs(polluted));
});
await test('actual concept workflow uses pinned configuration, real citation validation and pre-model boundary', async () => {
  const provider: LlmProvider = { id: 'fixture', name: 'Fixture', apiType: 'ollama', baseUrl: 'http://127.0.0.1:11434',
    apiKey: '', selectedModel: 'fixture-model', models: ['fixture-model'], enabled: true, createdAt: new Date().toISOString() };
  const workflow = structuredClone(getWorkflowById('concept-generation')!);
  const previousSettings = loadLlmSettings();
  let calls = 0, truncated = false;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: {
    conceptResearch: { search: async () => [{ type: 'web', title: '合成网页', url: 'https://example.org/fixture', snippet: '合成术语的定义证据。' }] },
    llm: { request: async (input: { provider: { selectedModel: string }; systemPrompt: string }) => {
      calls++; assert.equal(input.provider.selectedModel, 'fixture-model'); assert.equal(input.systemPrompt, workflow.systemPrompt);
      return { content: '完整的概念说明 [1]。', diagnostics: { finishReason: truncated ? 'length' : 'stop' } };
    } },
  } } });
  try {
    saveLlmSettings({ ...previousSettings, providers: [provider], defaultProviderId: provider.id });
    await flushLlmSettingsWrites();
    const note = initializeWikiKnowledge('合成概念', 'native-fixture');
    const result = await generateConcept(note, 'browser', { providerSnapshot: provider, workflowSnapshot: workflow, beforeModel: async () => {} });
    assert.equal(result.references?.[0].url, 'https://example.org/fixture'); assert.match(result.content, /## 来源/);
    assert.equal(calls, 1);
    await assert.rejects(generateConcept(note, 'browser', { providerSnapshot: provider, workflowSnapshot: workflow,
      beforeModel: async () => { throw new Error('storage boundary changed'); } }), /boundary changed/);
    assert.equal(calls, 1);
    truncated = true;
    await assert.rejects(generateConcept(note, 'browser', { providerSnapshot: provider, workflowSnapshot: workflow }), /截断/);
    assert.equal(calls, 2);
  } finally { saveLlmSettings(previousSettings); await flushLlmSettingsWrites(); Reflect.deleteProperty(globalThis, 'window'); }
});
await test('real Agent approval binds batch targets and starts once only after confirmation', async () => {
  const f = fixture([project('p', '[[心流]]')]); bootstrapAgentRuntime(AGENT_ROLES.default);
  registerConceptTools({ jobs: f.runtime, configuration: f.configuration });
  const ctx = { getNotes: f.ctx.notes, getActiveNote: () => f.notes()[0], ensureDataFresh: f.ctx.flush,
    applyConceptBatchChange: f.ctx.apply, getPlanDraftSession: () => null, getResourceDraftSession: () => null,
    navigate: () => { throw new Error('Must not navigate'); }, openNoteByTitle: () => false } as unknown as AgentRuntimeContext;
  assert.equal(toolRequiresApproval(getTool('start_wiki_concept_batch')!, {}, ctx), true);
  let round = 0;
  const turn = await runAgentTurn({ ctx, role: AGENT_ROLES.default, userText: '先创建这个项目关联的知识点笔记然后补全概念', history: [],
    memoryPrefixLoader: async () => '', enableMultiAgent: false,
    callLlm: async input => input.workflow === 'agent-intent-routing'
      ? { content: JSON.stringify({ skillId: 'general', confidence: 0.99, standaloneRequest: '创建并补全当前项目 Wiki 知识点', referenceResolution: 'resolved' }) }
      : ++round === 1 ? { content: '', toolCalls: [{ id: 'preview', name: 'preview_wiki_concepts', arguments: { projectNoteId: 'p', source: 'rag' } }] }
        : { content: '', toolCalls: [{ id: 'start', name: 'start_wiki_concept_batch', arguments: { projectNoteId: 'p', source: 'rag' } }] },
  });
  assert.ok(turn.pendingApproval); assert.equal(f.calls(), 0); assert.equal(f.notes().length, 1);
  const declined = await resolveAgentApproval({ approval: turn.pendingApproval!, approved: false, history: turn.updatedHistory,
    ctx, role: AGENT_ROLES.default, callLlm: async () => ({ content: '已取消本次批处理。' }) });
  assert.equal(f.calls(), 0); assert.equal(f.runtime.getSnapshot().length, 0); assert.ok(declined);
  await resolveAgentApproval({ approval: turn.pendingApproval!, approved: true, history: turn.updatedHistory, ctx, role: AGENT_ROLES.default,
    callLlm: async () => ({ content: '后台任务已登记，可以查看逐篇进度。', toolCalls: [] }) });
  await f.runtime.waitForIdle(); assert.equal(f.calls(), 1); assert.equal(f.runtime.getSnapshot()[0].status, 'completed');
  // The approval fingerprint changes if the source list changes; it is not a global grant.
  const next = fixture([project('p', '[[心流]]')]); registerConceptTools({ jobs: next.runtime, configuration: next.configuration });
  const nextCtx = { ...ctx, getNotes: next.ctx.notes, getActiveNote: () => next.notes()[0], ensureDataFresh: next.ctx.flush, applyConceptBatchChange: next.ctx.apply };
  const call = { id: 'bound', name: 'start_wiki_concept_batch', arguments: { projectNoteId: 'p', source: 'rag' } };
  const binding = await createAgentApprovalBinding(call, nextCtx);
  next.edit(notes => notes.map(note => ({ ...note, content: '[[另一个概念]]' })));
  await assert.rejects(validateAgentApprovalBinding({ call, binding, title: 'test', description: 'test' }, nextCtx), /发生变化/);
  assert.equal(next.calls(), 0);
});
await test('entrypoints reuse initialization/generation/save and app exit, not UI clicks', () => {
  const app = readFileSync('src/App.tsx', 'utf8'), fill = readFileSync('src/services/conceptFillService.ts', 'utf8');
  const facade = readFileSync('src/services/conceptBatchService.ts', 'utf8');
  assert.match(app, /const created = initializeWikiKnowledge/);
  assert.match(app, /applyConceptBatchChange/); assert.match(app, /conceptBatchJobs\.stopAll/);
  assert.match(facade, /generateConcept\(note, source/); assert.match(fill, /finishReason === 'length'/);
  assert.match(readFileSync('src/services/conceptBatchRuntime.ts', 'utf8'), /prepareConceptNoteWrite\(latest/);
  assert.ok(!facade.includes('.click('));
});
await test('progress card renders per-note saved status and accessible error feedback', async () => {
  const f = fixture(); await f.runtime.start(request, f.ctx); await f.runtime.waitForIdle();
  const html = renderToStaticMarkup(React.createElement(ConceptBatchProgress, { runtime: f.runtime }));
  assert.match(html, /aria-live="polite"/); assert.match(html, /<details>/); assert.match(html, /<summary>/);
  assert.match(html, /心流/); assert.match(html, /逐篇结果/); assert.match(html, /已保存 2\/2/);
  const failed = fixture(); failed.failSave(true); await assert.rejects(failed.runtime.start(request, failed.ctx));
  assert.match(renderToStaticMarkup(React.createElement(ConceptBatchProgress, { runtime: failed.runtime })), /role="alert"/);
});
console.log(`${groups} Wiki concept groups passed; synthetic ports only, no live model/private vault or semantic accuracy claim.`);
