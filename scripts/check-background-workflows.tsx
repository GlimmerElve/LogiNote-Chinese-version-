import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { NoteItem } from '../src/types';
import type { AgentRuntimeContext } from '../src/services/agent/types';
import { createBackgroundWorkflowRuntime, BackgroundBlocker, BackgroundBoundaryError } from '../src/services/agent/backgroundWorkflowRuntime';
import { normalizeBackgroundWorkflows, type BackgroundWorkflowJob } from '../src/services/agent/backgroundWorkflowTypes';
import { applyAgentTaskStatePatch, normalizeAgentTaskState } from '../src/services/agent/taskStateCodec';
import { todayLearningProjects } from '../src/services/agent/homeLearningState';
import { BackgroundWorkflowProgress } from '../src/components/BackgroundWorkflowProgress';
import { backgroundWorkflowResumeCall, AGENT_WORKFLOW_TOOLS } from '../src/services/agent/workflowToolNames';
import { validateWorkflowStudyTasks, runStudyTaskWorkflow } from '../src/services/agent/studyTaskWorkflow';
import { getWorkflowById } from '../src/workflows/workflowRegistry';
import { generateConcept } from '../src/services/conceptFillService';
import { initializeWikiKnowledge } from '../src/services/wikiKnowledge';
import { AGENT_ROLES, runAgentTurn } from '../src/services/agent/agentEngine';
import { bootstrapAgentRuntime } from '../src/services/agent/bootstrap';
import { getTool, toolRequiresApproval, registerTool } from '../src/services/agent/toolRegistry';

globalThis.fetch = async () => assert.fail('No live network in workflow checks');
const h = (char = 'a') => char.repeat(64), ctx = { ensureDataFresh: async () => {}, getNotes: () => [], getActiveNote: () => null,
  getPlanDraftSession: () => null, getResourceDraftSession: () => null } as unknown as AgentRuntimeContext;
const defer = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const tick = async () => { for (let n = 0; n < 30; n++) await Promise.resolve(); };
let groups = 0;
async function test(name: string, run: () => Promise<void> | void) { await run(); groups++; console.log(`PASS ${name}`); }
function fixture(id = 'workflow-fixture'): BackgroundWorkflowJob {
  return { version: 1, id, title: '合成组合任务', scopeId: 'scope', status: 'prepared', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    modelFingerprint: h(), modelLabels: ['本机合成模型'], modelSteps: ['study-tasks', 'wiki-concepts', 'textbook'], allowCloud: false, documentHashes: {},
    projects: [{ id: 'p', title: '项目', baseline: h('b'), documentIds: [], knowledgeHashes: {},
      steps: ['study-tasks', 'wiki-concepts', 'textbook'].map(kind => ({ kind, status: 'pending', attempts: 0 })) as BackgroundWorkflowJob['projects'][number]['steps'] }] };
}
function harness(initial: BackgroundWorkflowJob[] = []) {
  let data = structuredClone(initial), scope = 'scope', failWrite = false, changed = false, count = 0;
  const events: string[] = [];
  let onExecute = async (_kind: string, signal: AbortSignal) => { signal.throwIfAborted(); };
  const runtime = createBackgroundWorkflowRuntime({ scope: async () => scope, load: async () => ({ scopeId: scope, jobs: data }),
    save: async (_scope, jobs) => { if (failWrite) throw new Error('synthetic disk failure'); data = structuredClone(jobs); events.push('checkpoint'); },
    build: async () => fixture(`workflow-${++count}`), assert: async (_job, _ctx, _project, signal) => { signal?.throwIfAborted(); if (changed) throw new BackgroundBoundaryError('合成前置状态变化'); },
    execute: async (_job, project, step, _ctx, signal) => { events.push(`${project.id}:${step.kind}`); await onExecute(step.kind, signal); step.receipt = h('c'); return 'completed'; }, canRun: () => true });
  return { runtime, events, data: () => structuredClone(data), failWrite: (value: boolean) => { failWrite = value; }, change: () => { changed = true; },
    scope: (value: string) => { scope = value; }, execute: (run: typeof onExecute) => { onExecute = run; } };
}
await test('准备零模型/零写入；确认后先持久化授权，再按依赖执行并保存收据', async () => {
  const x = harness(), job = await x.runtime.prepare({ projectNoteIds: ['p'], steps: ['textbook'] }, ctx);
  assert.deepEqual(x.events, []); assert.equal(x.runtime.getSnapshot().length, 0);
  await x.runtime.start(job.id, ctx); await x.runtime.waitForIdle();
  assert.equal(x.events[0], 'checkpoint');
  assert.deepEqual(x.events.filter(value => value !== 'checkpoint'), ['p:study-tasks', 'p:wiki-concepts', 'p:textbook']);
  assert.equal(x.runtime.getSnapshot()[0].status, 'completed');
  assert.ok(x.data()[0].projects[0].steps.every(step => step.receipt));
});
await test('知识点未保存前教材不能开始；切换页面/关闭UI不拥有后台任务', async () => {
  const x = harness(), gate = defer(); x.execute(async kind => { if (kind === 'wiki-concepts') await gate.promise; });
  const job = await x.runtime.prepare({ projectNoteIds: ['p'], steps: ['textbook'] }, ctx);
  await x.runtime.start(job.id, ctx); await tick();
  assert.ok(!x.events.includes('p:textbook')); assert.equal(x.runtime.getSnapshot()[0].status, 'running');
  // A closed UI unsubscribes only; no cancel operation is attached to it.
  x.runtime.subscribe(() => {})(); gate.resolve(); await x.runtime.waitForIdle();
  assert.ok(x.events.includes('p:textbook'));
});
await test('停止传播取消信号，保留已保存步骤，不运行后续教材', async () => {
  const x = harness(); x.execute(async (kind, signal) => { signal.throwIfAborted(); if (kind === 'wiki-concepts') await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); });
  const job = await x.runtime.prepare({ projectNoteIds: ['p'], steps: ['textbook'] }, ctx);
  await x.runtime.start(job.id, ctx); for (let i = 0; i < 10 && !x.events.includes('p:wiki-concepts'); i++) await tick();
  assert.ok(x.events.includes('p:wiki-concepts')); await x.runtime.stop(job.id); await x.runtime.waitForIdle();
  assert.equal(x.runtime.getSnapshot()[0].status, 'paused');
  assert.equal(x.runtime.getSnapshot()[0].projects[0].steps[0].status, 'completed');
  assert.ok(!x.events.includes('p:textbook'));
});
await test('重启只恢复暂停状态；重新确认续办不重跑已有收据步骤', async () => {
  const job = fixture(); job.status = 'running'; job.projects[0].steps[0] = { kind: 'study-tasks', status: 'completed', attempts: 1, receipt: h('c') };
  const x = harness([job]); await x.runtime.ensureReady(); assert.equal(x.runtime.getSnapshot()[0].status, 'paused'); assert.deepEqual(x.events, []);
  await x.runtime.start(job.id, ctx); await x.runtime.waitForIdle();
  assert.ok(!x.events.includes('p:study-tasks')); assert.equal(x.runtime.getSnapshot()[0].status, 'completed');
});
await test('重复开始不并行重放；重叠项目的另一个流程不能抢占', async () => {
  const x = harness(), gate = defer(); x.execute(async () => gate.promise);
  const a = await x.runtime.prepare({ projectNoteIds: ['p'], steps: ['textbook'] }, ctx);
  const b = await x.runtime.prepare({ projectNoteIds: ['p'], steps: ['textbook'] }, ctx);
  await Promise.all([x.runtime.start(a.id, ctx), x.runtime.start(a.id, ctx)]);
  await assert.rejects(x.runtime.start(b.id, ctx), /已有组合任务/);
  gate.resolve(); await x.runtime.waitForIdle(); assert.equal(x.events.filter(value => value === 'p:study-tasks').length, 1);
});
await test('检查点或授权前置状态失败零后续模型；不报告完成', async () => {
  const x = harness(), a = await x.runtime.prepare({ projectNoteIds: ['p'], steps: ['textbook'] }, ctx);
  x.failWrite(true); await assert.rejects(x.runtime.start(a.id, ctx), /检查点/);
  assert.ok(x.events.every(value => value === 'checkpoint')); assert.equal(x.runtime.getSnapshot()[0].status, 'paused');
  x.failWrite(false); x.change(); await assert.rejects(x.runtime.start(a.id, ctx), /前置状态变化/);
});
await test('单项目证据缺口保留阻碍且不执行依赖步骤，其它批准项目可继续', async () => {
  const job = fixture(); job.projects.push({ ...structuredClone(job.projects[0]), id: 'p2' }); job.status = 'paused';
  const x = harness([job]); let first = true; x.execute(async kind => { if (kind === 'wiki-concepts' && first) { first = false; throw new BackgroundBlocker('无绑定证据'); } });
  await x.runtime.start(job.id, ctx); await x.runtime.waitForIdle();
  assert.equal(x.runtime.getSnapshot()[0].status, 'blocked'); assert.ok(!x.events.includes('p:textbook')); assert.ok(x.events.includes('p2:textbook'));
});
await test('私有文件闭合协议与其它类别合并；污染/无收据完成/伪造完成拒绝', () => {
  const job = fixture(); const state = applyAgentTaskStatePatch(null, { kind: 'workflows', jobs: [job] });
  assert.deepEqual(normalizeAgentTaskState(state).workflows, [job]);
  assert.deepEqual(applyAgentTaskStatePatch(state, { kind: 'documents', jobs: [] }).workflows, [job]);
  assert.throws(() => normalizeBackgroundWorkflows([{ ...job, status: 'completed' }]), /未完成/);
  const invalid = structuredClone(job); invalid.projects[0].steps[0].status = 'completed';
  assert.throws(() => normalizeBackgroundWorkflows([invalid]), /步骤/);
  const polluted = structuredClone(job); polluted.projects[0].id = '__proto__'; assert.throws(() => normalizeBackgroundWorkflows([polluted]), /范围/);
});
await test('未完成流程可归档并恢复，草稿/预算保留且恢复不自动执行', async () => {
  const job = fixture(); job.status = 'paused'; job.projects[0].steps[0].draftTasks = ['解释 [[心流]] 的条件']; job.projects[0].steps[0].attempts = 1;
  const x = harness([job]); await x.runtime.ensureReady();
  await x.runtime.archive(job.id, true); assert.ok(x.runtime.getSnapshot()[0].archivedAt);
  assert.equal(x.data()[0].projects[0].steps[0].attempts, 1);
  await assert.rejects(x.runtime.start(job.id, ctx), /已归档/);
  await x.runtime.archive(job.id, false);
  assert.equal(x.runtime.getSnapshot()[0].archivedAt, undefined);
  assert.deepEqual(x.runtime.getSnapshot()[0].projects[0].steps[0].draftTasks, job.projects[0].steps[0].draftTasks);
  assert.ok(x.events.every(value => value === 'checkpoint'));
});
await test('首页同源日期/开始/叶子/完成规则，六十条旧项目不会截掉今日目标', () => {
  const note = (id: string, parentId?: string): NoteItem => ({ id, parentId, title: id, noteType: 'project', content: '', tags: [], links: [], backlinks: [], dueDates: [], createdAt: '', updatedAt: '' });
  const root = note('root'); root.planMeta = { schemaVersion: 2, status: 'active' };
  const projects = Array.from({ length: 61 }, (_, i) => { const leaf = note(`p${i}`, root.id); leaf.dueDates = [{ id: `${leaf.id}-deadline`, noteId: leaf.id, noteTitle: leaf.title, taskText: leaf.title,
    dueDate: i === 60 ? '2026-11-10' : '2026-01-01', startDate: '2026-01-01', completed: false, priority: 'medium' }]; return leaf; });
  const future = note('future', root.id); future.dueDates = [{ ...projects[0].dueDates[0], noteId: future.id, noteTitle: future.title, taskText: future.title, startDate: '2026-11-01', dueDate: '2026-11-10' }];
  const result = todayLearningProjects([root, ...projects, future], '2026-10-17');
  assert.equal(result.total, 61); assert.ok(result.projects.some(project => project.projectNoteId === 'p60')); assert.ok(!result.projects.some(project => project.projectNoteId === 'future'));
  assert.equal(result.projects[0].studyTaskCount, 0); assert.deepEqual(result.projects[0].wiki, []);
});
await test('任务实际工作流与白名单输入，不修补截断JSON或将控制代码写成任务', async () => {
  const project = { id: 'p', title: '心流', content: '', noteType: 'project', tags: [], links: [], backlinks: [], dueDates: [], createdAt: '', updatedAt: '' } as NoteItem;
  assert.throws(() => validateWorkflowStudyTasks({ tasks: ['理解概念，没有关联'] }), /Wiki/);
  assert.throws(() => validateWorkflowStudyTasks({ tasks: ['理解 [[心流]] @due(2026-10-17)'] }), /控制代码/);
  let model = 0, guarded = 0;
  const config = { provider: { id: 'fake', apiType: 'ollama', baseUrl: 'http://localhost', models: ['fake'], selectedModel: 'fake', enabled: true, name: 'fake', createdAt: '' } as const, workflow: getWorkflowById('study-task-generation')! };
  const tasks = await runStudyTaskWorkflow(project, [project], config as any, new AbortController().signal, async () => { guarded++; }, async request => {
    model++; assert.equal(request.workflow, 'study-task-generation'); assert.equal(request.skipMemoryInjection, true); return { content: '{"tasks":["解释 [[心流]] 的条件"]}' }; });
  assert.equal(guarded, 1); assert.equal(model, 1); assert.equal(tasks.length, 1);
});
await test('概念白名单空数组不搜索全库；旧宿主混入越界命中也不进入模型', async () => {
  const previous = (globalThis as any).window; let searches = 0, models = 0;
  (globalThis as any).window = { electronAPI: { ragDocs: { search: async (_query: string, _k: number, scope: any) => {
    searches++; assert.deepEqual(scope.allowedDocIds, ['allowed']);
    return [{ docId: 'allowed', fileName: '允许文档', snippet: '合成术语的限定证据', score: 1 }, { docId: 'outside', fileName: '越界', snippet: 'FORBIDDEN_PRIVATE_TEXT', score: 2 }];
  } }, llm: { request: async (input: any) => { models++; assert.ok(!input.userInput.includes('FORBIDDEN_PRIVATE_TEXT'));
    return { content: '# 合成术语\n\n仅解释允许文档中给出的限定证据，不从其它资料扩展结论。[1]' }; } } } };
  try {
    const note = initializeWikiKnowledge('合成术语', 'fixture-term');
    await assert.rejects(generateConcept(note, 'rag', { evidenceScope: { allowedDocIds: [], allowedNoteIds: [] } }));
    assert.equal(searches, 0); assert.equal(models, 0);
    const provider = { id: 'mock', name: 'mock', apiType: 'ollama', baseUrl: 'http://127.0.0.1:11434', models: ['mock'], selectedModel: 'mock', enabled: true, createdAt: '' } as const;
    const filled = await generateConcept(note, 'rag', { providerSnapshot: provider as any, workflowSnapshot: getWorkflowById('concept-generation')!,
      evidenceScope: { allowedDocIds: ['allowed'], allowedNoteIds: [] } });
    assert.equal(models, 1); assert.ok(filled.references!.every(ref => ref.entityId === 'allowed'));
  } finally { (globalThis as any).window = previous; }
});
await test('真实Agent只在开始前请求整批确认；取消零执行，UI续办锁定原ID', async () => {
  bootstrapAgentRuntime(AGENT_ROLES.default);
  for (const name of AGENT_WORKFLOW_TOOLS) assert.ok(getTool(name));
  assert.ok(toolRequiresApproval(getTool('start_background_workflow')!, { jobId: 'workflow-fixture' }, ctx));
  assert.equal(toolRequiresApproval(getTool('stop_background_workflow')!, { jobId: 'workflow-fixture' }, ctx), false);
  const call = backgroundWorkflowResumeCall('workflow-fixture'); assert.equal(call.arguments.jobId, 'workflow-fixture');
  assert.throws(() => backgroundWorkflowResumeCall('../../other'), /无效/);
  let started = 0;
  const definition = getTool(call.name)!;
  registerTool({ ...definition, approvalSnapshot: async () => fixture(), confirmation: () => ({ title: '整批确认', description: '合成范围' }), execute: async () => { started++; return { status: 'background_started', saved: false }; } });
  const result = await runAgentTurn({ role: AGENT_ROLES.default, userText: '请准备接下来的学习材料', history: [], ctx, memoryPrefixLoader: async () => '', enableMultiAgent: false,
    callLlm: async () => ({ content: '整批开始前请确认', toolCalls: [call] }) });
  assert.equal(started, 0); assert.equal(result.pendingApproval?.items[0]?.call.name, 'start_background_workflow');
  registerTool(definition);
});
await test('状态面板使用真实完成/阻碍状态与停止按钮；独立于聊天清除及页面生命周期', () => {
  const job = fixture(); job.status = 'blocked'; job.projects[0].steps[1].status = 'blocked'; job.projects[0].steps[1].error = '缺少绑定资料';
  const runtime = { getSnapshot: () => [job], subscribe: () => () => {}, ensureReady: async () => {}, getPersistenceError: () => undefined } as any;
  const html = renderToStaticMarkup(<BackgroundWorkflowProgress runtime={runtime} onResume={() => {}} />);
  assert.ok(html.includes('缺少绑定资料')); assert.ok(html.includes('重新确认续办')); assert.ok(!html.includes('已完成'));
  const app = readFileSync('src/App.tsx', 'utf8'), panel = readFileSync('src/components/AgentPanel.tsx', 'utf8');
  assert.ok(app.includes('backgroundWorkflows.stopAll()')); assert.ok(panel.includes('backgroundWorkflowResumeCall(backgroundResumeJobId)'));
  assert.ok(!readFileSync('src/components/BackgroundWorkflowProgress.tsx', 'utf8').includes('stopAll()'));
});
console.log(`${groups} background workflow groups passed; synthetic ports/Agent/SSR only, no live model/private vault or semantic accuracy claim.`);
