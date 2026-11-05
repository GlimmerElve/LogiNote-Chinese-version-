import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fork, type ForkOptions, type Serializable } from 'node:child_process';
import { ProgressiveLearningStore } from '../src/electron/progressiveLearningStore';
import { ProgressiveDerivedQueue } from '../src/electron/progressiveDerivedQueue';
import { materializeProgressiveKnowledge, progressivePageConcepts } from '../src/electron/progressiveKnowledge';
import { shareProgressiveTeaching } from '../src/services/progressiveLearning/share';
import { RagComputeClient } from '../src/electron/ragComputeClient';
import { saveVaultNotesDelta, readSavedVaultNotesByIds } from '../src/electron/vaultNoteDelta';
import { createProgressiveController, type ProgressiveStorageAdapter } from '../src/services/progressiveLearning/runtime';
import { progressiveGenerationRequest } from '../src/services/progressiveLearning/generation';
import { atomicWriteTextFile } from '../src/electron/atomicWrite';
import type { ProgressiveBeginReply, ProgressiveCourse, ProgressiveMainline, ProgressiveLessonPage } from '../src/services/progressiveLearning/types';
import type { NoteItem } from '../src/types';
import { readProjectKnowledgeRows, type ProgressiveKnowledgeChange } from '../src/services/progressiveLearning/knowledgeProjection';

const root = await fs.mkdtemp(path.resolve('build/progressive-phase2-contract-'));
const vault = path.join(root, 'vault'), states = path.join(root, 'user-state');
const at = new Date().toISOString();
const project: NoteItem = { id: 'leaf', title: '函数的输入限制', noteType: 'project', projectRole: 'learning',
  content: '# 保留人工目标\n既有正文不改写。', tags: [], links: [], backlinks: [], dueDates: [{ id: 'task-leaf', noteId: 'leaf', noteTitle: '函数的输入限制', completed: false, priority: 'medium', taskText: '函数的输入限制', dueDate: '2026-11-03', estimatedMinutes: 40 }], createdAt: at, updatedAt: at };
const authored: NoteItem = { ...project, id: 'authored', title: '定义域', noteType: 'knowledge', projectRole: undefined,
  content: '# 手写定义域\n不可被后台概念补全覆盖。', dueDates: [] };
await saveVaultNotesDelta(vault, states, { upserts: [project, authored].map(note => ({ note, before: null })), removed: [] });
let failCourseCommit = false, queue: ProgressiveDerivedQueue;
const store = new ProgressiveLearningStore(states, {
  readTarget: async () => ({ note: project, root: project, isLeaf: true }),
  changed: id => queue?.notify(id),
  write: async (file, content) => {
    if (failCourseCommit && file.endsWith('course.json')) { failCourseCommit = false; throw Error('injected commit failure'); }
    await atomicWriteTextFile(file, content, { allowCopyFallback: false });
  },
});
const events: Array<{ operation: string; projectNoteId: string; pageId: string; count?: number }> = [];
const realEmbedding = process.env.PROGRESSIVE_REAL_EMBEDDING === '1';
const inputs: string[] = [], created: NoteItem[] = [], workerOperations: string[] = [];
const projections: ProgressiveKnowledgeChange[] = [];
const computeClient = new RagComputeClient(() => {
  const child = fork(path.resolve('dist-electron/rag-compute.cjs'), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true } as ForkOptions & { windowsHide: boolean });
  return { postMessage: (message: unknown) => { workerOperations.push((message as { operation: string }).operation); child.send(message as Serializable); },
    on: child.on.bind(child), kill: () => child.kill(), pid: child.pid, removeListener: child.removeListener.bind(child) };
}, () => ({ modelsDir: path.resolve('models'), pdfExtractScript: path.resolve('python/pdf_extract.py') }));
let failBatch = 0, batch = 0, failKnowledge = 0;
const compute = {
  chunkTextbook: (input: Parameters<NonNullable<import('../src/electron/rag/backgroundComputeBridge').BackgroundRagCompute['chunkTextbook']>>[0]) =>
    computeClient.run<import('../src/electron/rag/textbookReferenceChunks').TextbookReferenceChunk[]>('chunk-textbook', { input }),
  embed: async (texts: string[]) => {
    assert.ok(texts.length <= 4); batch++;
    if (failBatch && batch === failBatch) throw Error('injected worker exit');
    inputs.push(...texts);
    if (realEmbedding) return computeClient.run<number[][]>('embed', { texts });
    return texts.map(text => { const seed = createHash('sha256').update(text).digest(); return Array.from({ length: 384 }, (_, i) => (seed[i % 32] + 1) / 256); });
  },
};
const createQueue = () => new ProgressiveDerivedQueue(states, { store, isCurrent: () => true, compute: () => compute,
  event: event => events.push(event), linkKnowledge: (id, courseId, _page, concepts) => {
    if (failKnowledge > 0) { failKnowledge--; throw Error('injected knowledge write failure'); }
    return materializeProgressiveKnowledge(vault, states, id, courseId, concepts, () => true, (notes, change) => { created.push(...notes); if (change) projections.push(change); });
  } });
queue = createQueue();
const storage: ProgressiveStorageAdapter = {
  load: async id => await store.command({ op: 'load', projectNoteId: id }, 1) as ProgressiveCourse | null,
  begin: async (id, sources) => await store.command({ op: 'begin', projectNoteId: id, sourcePackets: sources }, 1) as ProgressiveBeginReply,
  next: async (id, request) => await store.command({ op: 'next', projectNoteId: id, request }, 1) as ProgressiveBeginReply,
  checkpoint: async (lease, checkpoint) => await store.command({ op: 'checkpoint', lease, checkpoint }, 1) as ProgressiveCourse,
  publish: async (lease, teaching) => await store.command({ op: 'publish', lease, teaching }, 1) as ProgressiveCourse,
  saveProgress: async (id, progress) => await store.command({ op: 'save-progress', projectNoteId: id, progress }, 1) as ProgressiveCourse,
  interrupt: async (lease, error) => await store.command({ op: 'interrupt', lease, error }, 1) as ProgressiveCourse,
};
const plan: ProgressiveMainline = { title: '函数与定义域', objectives: ['说明输入限制并进行判断'], pages: Array.from({ length: 4 }, (_, i) => ({ id: `main-${i + 1}`, title: `输入限制 ${i + 1}`, objectives: [`目标 ${i + 1}`] })) };
const body = (index: number, count = 8) => Array.from({ length: count }, (_, i) => `## 第${i + 1}个情境\n\n本页${index}情境${i}：一个输入需要对应唯一确定的输出，定义域先规定允许的输入范围。分母不能为零，偶次根式的被开方数应非负。${'判断应先找到限制条件，再逐项检查边界，将满足条件的取值集合写出。'.repeat(7)}\n\n`).join('');
const concepts = [{ key: 'domain', title: '定义域', summary: '函数允许输入的值组成定义域；取值需满足表达式有意义。' },
  { key: 'unique', title: '唯一对应', summary: '每一个允许的输入只能对应一个确定输出；多个输入可以有相同输出。' }];
let calls = 0;
const runtime = createProgressiveController({ note: project, allNotes: [project, authored] }, { storage, registerFlush: () => () => {},
  loadMaterials: async () => [], stream: async course => {
    calls++;
    const index = course.generation.mainlineIndex || 0;
    const response = `${course.plan ? '' : '@@PLAN\n' + JSON.stringify(plan) + '\n'}@@LESSON\n${body(index)}\n@@CONCEPTS\n${JSON.stringify(concepts)}\n@@HOOK\n${JSON.stringify({ id: 'hook-' + course.generation.pageId, kind: 'reflection', prompt: '如何判断输入是否合法？' })}\n@@END\n`;
    return new ReadableStream({ start(controller) { controller.enqueue({ type: 'content', text: response }); controller.close(); } });
  } });
const checks: string[] = [];
const course = () => runtime.getSnapshot().course!;
const pageSummary = (id: string) => course().pages!.find(page => page.id === id)!;
const shardRoot = () => path.join(states, 'progressive-derived', `project-${createHash('sha256').update(JSON.stringify(project.id)).digest('hex')}`);
const indexBytes = (id: string) => fs.readFile(path.join(shardRoot(), `${id}.index.json`));
try {
  await runtime.start(); await queue.idle();
  assert.equal(course().pages?.length, 1); assert.equal((await queue.statuses(project.id))[0].status, 'ready');
  assert.equal(created.length, 1); assert.equal(created[0].title, '唯一对应'); assert.equal(created[0].dsrState, undefined);
  assert.equal((await readSavedVaultNotesByIds(vault, states, [authored.id]))[0].content, authored.content);
  assert.deepEqual(new Set((await queue.statuses(project.id))[0].knowledgeIds), new Set([authored.id, created[0].id]));
  const [projected, reused] = await readSavedVaultNotesByIds(vault, states, [project.id, authored.id]);
  assert.ok(projected.content.startsWith(project.content));
  assert.deepEqual(readProjectKnowledgeRows(projected.content), concepts.map(({ title, summary }) => ({ title, summary })));
  assert.deepEqual(new Set(projected.links), new Set(concepts.map(concept => concept.title)));
  assert.ok(reused.backlinks.includes(project.title));
  assert.equal(projections[0].before.content, project.content); assert.equal(projections[0].note.content, projected.content);
  checks.push('本地后台创建并关联实际知识点对象，复用手写笔记且不覆盖正文、不制造掌握度证据');
  const firstBytes = await indexBytes('main-1');
  const firstPageFile = await store.readPublished(project.id, 'main-1', pageSummary('main-1').contentHash);
  // Simulate an older already-indexed course: upgrade only the links, without
  // touching its unchanged chunks, vectors or initializing their worker again.
  const jobFile = path.join(shardRoot(), 'main-1.job.json');
  const legacyJob = JSON.parse(await fs.readFile(jobFile, 'utf8')); delete legacyJob.knowledgeProjectionVersion;
  await fs.writeFile(jobFile, JSON.stringify(legacyJob));
  const upgradeEvents = events.length, upgradeOps = workerOperations.length, upgradeInputs = inputs.length;
  queue.notify(project.id, true); await queue.idle();
  assert.deepEqual(await indexBytes('main-1'), firstBytes);
  assert.equal(workerOperations.length, upgradeOps); assert.equal(inputs.length, upgradeInputs);
  assert.equal(events.slice(upgradeEvents).filter(event => ['chunk', 'embed'].includes(event.operation)).length, 0);
  assert.equal(readProjectKnowledgeRows((await readSavedVaultNotesByIds(vault, states, [project.id]))[0].content).length, 2);
  assert.equal(JSON.parse(await fs.readFile(jobFile, 'utf8')).knowledgeProjectionVersion, 2);
  checks.push('已生成课程补齐正文双链时只运行关联升级，既有教材分块和向量逐字节不变、模型初始化为0');
  const before = events.length;
  await Promise.all([runtime.next(), runtime.next(), runtime.next()]); await queue.idle();
  assert.equal(calls, 2); assert.equal(course().page?.id, 'main-2'); assert.equal(course().pages?.length, 2);
  assert.equal(events.slice(before).filter(event => ['chunk', 'embed'].includes(event.operation) && event.pageId === 'main-1').length, 0);
  const secondBytes = await indexBytes('main-2'), beforeThird = events.length;
  await runtime.next(); await queue.idle();
  assert.equal(course().page?.id, 'main-3');
  assert.deepEqual(await indexBytes('main-1'), firstBytes); assert.deepEqual(await indexBytes('main-2'), secondBytes);
  assert.equal(events.slice(beforeThird).filter(event => ['chunk', 'embed'].includes(event.operation) && event.pageId !== 'main-3').length, 0);
  assert.equal((await store.readPublished(project.id, 'main-1', pageSummary('main-1').contentHash))?.body, firstPageFile?.body);
  checks.push('并发下一页只生成一次；新增第3页时前两页分块/推理均为0且索引分片逐字节不变');
  const count = events.length;
  runtime.saveProgress({ restatementDraft: 'PRIVATE_RESTATEMENT', summaryDraft: 'PRIVATE_SUMMARY', scrollTop: 80 });
  await runtime.flush(); await queue.idle(); assert.equal(events.length, count);
  await runtime.navigate('main-1'); assert.equal(runtime.getSnapshot().page?.id, 'main-1');
  assert.equal(calls, 3); assert.equal(course().progress.restatementDraft, 'PRIVATE_RESTATEMENT');
  await runtime.navigate('main-3');
  checks.push('复述/摘要/阅读位置保存不排队分块向量；目录回看只读所选页，草稿保留且不请求模型');
  const thirdBytes = await indexBytes('main-3');
  const second = pageSummary('main-2');
  failCourseCommit = true;
  await assert.rejects(store.command({ op: 'update-page', projectNoteId: project.id, environmentId: course().environmentId,
    courseId: course().id, pageId: second.id, expectedHash: second.contentHash, body: body(1) + '\n补充边界。' }, 1));
  assert.equal((await store.readPublished(project.id, second.id, second.contentHash))!.body, body(1).trim());
  const priorInputs = inputs.length, beforeEdit = events.length;
  const edited = await store.command({ op: 'update-page', projectNoteId: project.id, environmentId: course().environmentId,
    courseId: course().id, pageId: second.id, expectedHash: second.contentHash, body: body(1) + '\n新增一个边界示例。' }, 1) as ProgressiveCourse;
  await queue.idle();
  const oldIndex = JSON.parse(secondBytes.toString()), changedIndex = JSON.parse((await indexBytes('main-2')).toString());
  const oldKeys = new Set(oldIndex.chunks.map((chunk: { embeddingKey: string }) => chunk.embeddingKey));
  const missing = changedIndex.chunks.filter((chunk: { embeddingKey: string }) => !oldKeys.has(chunk.embeddingKey));
  assert.ok(missing.length > 0 && missing.length < changedIndex.chunks.length);
  assert.equal(inputs.length - priorInputs, missing.length);
  assert.ok(events.slice(beforeEdit).filter(event => event.operation === 'chunk').every(event => event.pageId === 'main-2'));
  assert.deepEqual(await indexBytes('main-1'), firstBytes); assert.deepEqual(await indexBytes('main-3'), thirdBytes);
  checks.push('单页修改失败保持旧版本可读；成功后仅重分该页，按实际向量输入复用未变化块');
  const editedSummary = edited.pages!.find(page => page.id === 'main-2')!;
  await store.command({ op: 'delete-page', projectNoteId: project.id, environmentId: edited.environmentId, courseId: edited.id,
    pageId: 'main-2', expectedHash: editedSummary.contentHash }, 1);
  await queue.idle();
  await assert.rejects(indexBytes('main-2'), { code: 'ENOENT' });
  assert.deepEqual(await indexBytes('main-1'), firstBytes); assert.deepEqual(await indexBytes('main-3'), thirdBytes);
  checks.push('删除只移除目标页的索引及任务分片，其余页面和知识点原文保留');
  // Re-enter loads the same durable course. Regenerate the deleted mainline slot before advancing.
  await runtime.start(); await runtime.next(); await queue.idle();
  const beforeFailure = events.length;
  failBatch = batch + 2;
  await runtime.next(); await queue.idle();
  assert.equal(course().page?.id, 'main-4'); assert.equal((await queue.statuses(project.id)).find(job => job.pageId === 'main-4')?.status, 'failed');
  const partial = JSON.parse((await indexBytes('main-4')).toString());
  const pending = partial.chunks.filter((chunk: { embedding?: number[] }) => !chunk.embedding).length;
  assert.ok(pending > 0 && pending < partial.chunks.length);
  const recoveredInputStart = inputs.length, beforeRecovery = events.length;
  await queue.stop(); queue = createQueue(); failBatch = 0;
  await queue.recover(); await queue.idle();
  assert.equal(inputs.length - recoveredInputStart, pending);
  assert.equal(events.slice(beforeRecovery).filter(event => event.operation === 'chunk').length, 0);
  assert.ok(events.slice(beforeRecovery).filter(event => event.operation === 'embed').every(event => event.pageId === 'main-4'));
  assert.equal((await queue.statuses(project.id)).find(job => job.pageId === 'main-4')?.status, 'ready');
  checks.push('向量第二批失败保留首批和分块；重启仅恢复第4页缺失向量，已完成页和步骤不重放');
  // Four mainline slots remain reserved even when expansions are inserted before mainline completion.
  const reservedStates = path.join(root, 'reservation');
  const reservedStore = new ProgressiveLearningStore(reservedStates, { readTarget: async () => ({ note: { ...project, dueDates: [{ ...project.dueDates[0], estimatedMinutes: 20 }] }, root: project, isLeaf: true }) });
  let reserved = await reservedStore.command({ op: 'begin', projectNoteId: project.id }, 2) as ProgressiveBeginReply;
  await reservedStore.command({ op: 'publish', lease: reserved.lease!, teaching: { sequence: 1, plan, title: plan.pages[0].title, body: body(0), hook: { id: 'h', kind: 'reflection', prompt: '解释。' } } }, 2);
  const reservedCourse = await reservedStore.command({ op: 'load', projectNoteId: project.id }, 2) as ProgressiveCourse;
  await assert.rejects(reservedStore.command({ op: 'next', projectNoteId: project.id, request: { environmentId: reservedCourse.environmentId,
    courseId: reservedCourse.id, expectedRevision: reservedCourse.revision, requestId: 'unique-expansion', intent: 'expansion', fromPageId: 'main-1' } }, 2), /预算/u);
  const payload = progressiveGenerationRequest(course(), { title: project.title, rootTitle: project.title });
  assert.ok(!payload.userInput.includes('PRIVATE_RESTATEMENT')); assert.ok(!payload.userInput.includes('PRIVATE_SUMMARY'));
  checks.push('补充页不能消耗主线预留预算；单页请求不携带全局私人复述与摘要');
  const beforeExpansion = events.length;
  failKnowledge = 1;
  await runtime.next('expansion'); await queue.idle();
  assert.equal(course().page?.kind, 'expansion'); assert.equal(course().page?.parentPageId, 'main-4');
  const expansionId = course().page!.id, expansionCalls = calls;
  const failedKnowledge = (await queue.statuses(project.id)).find(job => job.pageId === expansionId)!;
  assert.equal(failedKnowledge.status, 'failed'); assert.equal(failedKnowledge.indexReady, true); assert.equal(failedKnowledge.knowledgeReady, false);
  await runtime.start(); assert.equal(runtime.getSnapshot().page?.id, expansionId); assert.equal(calls, expansionCalls);
  assert.ok(events.slice(beforeExpansion).filter(event => event.operation === 'chunk').every(event => event.pageId === expansionId));
  const beforeKnowledgeRetry = events.length;
  queue.notify(project.id, true); await queue.idle();
  assert.equal((await queue.statuses(project.id)).find(job => job.pageId === expansionId)!.status, 'ready');
  assert.equal(events.slice(beforeKnowledgeRetry).filter(event => ['chunk', 'embed'].includes(event.operation)).length, 0);
  checks.push('扩展页使用独立ID并恢复原页；知识点写入失败不阻断索引，重试只补知识点不重分块/推理');
  const lesson = course().page!;
  const fallback = progressivePageConcepts({ ...lesson, concepts: undefined, body: '# 教学\n\n## 定义域的概念\n\n函数允许输入的值组成的集合称为定义域。分式中分母不得为零，因此应先写出所有限制条件，再求交集。\n\n## 小结\n\n不当成新知识点。' });
  assert.equal(fallback.length, 1); assert.equal(fallback[0].title, '定义域的概念');
  const share = JSON.stringify(shareProgressiveTeaching(course(), [lesson]));
  assert.ok(!/PRIVATE_|knowledgeIds|previousTeaching|contentHash|sourcePackets|progress|concepts/u.test(share));
  checks.push('第一阶段缺少知识点元数据的旧页可用真实定义段落建立对象；多页分享投影继续只输出正文与静态钩子');
  const recoveryStore = new ProgressiveLearningStore(path.join(root, 'later-page-recovery'), {
    readTarget: async () => ({ note: project, root: project, isLeaf: true }),
  });
  const recoveryStorage: ProgressiveStorageAdapter = {
    load: async id => await recoveryStore.command({ op: 'load', projectNoteId: id }, 5) as ProgressiveCourse,
    begin: async id => await recoveryStore.command({ op: 'begin', projectNoteId: id }, 5) as ProgressiveBeginReply,
    next: async (id, request) => await recoveryStore.command({ op: 'next', projectNoteId: id, request }, 5) as ProgressiveBeginReply,
    checkpoint: async (lease, checkpoint) => await recoveryStore.command({ op: 'checkpoint', lease, checkpoint }, 5) as ProgressiveCourse,
    publish: async (lease, teaching) => await recoveryStore.command({ op: 'publish', lease, teaching }, 5) as ProgressiveCourse,
    saveProgress: async (id, progress) => await recoveryStore.command({ op: 'save-progress', projectNoteId: id, progress }, 5) as ProgressiveCourse,
    interrupt: async (lease, error) => await recoveryStore.command({ op: 'interrupt', lease, error }, 5) as ProgressiveCourse,
  };
  let recoveryCalls = 0;
  const recoveryRuntime = () => createProgressiveController({ note: project, allNotes: [project] }, {
    storage: recoveryStorage, registerFlush: () => () => {}, loadMaterials: async () => [],
    stream: async item => {
      recoveryCalls++;
      if (recoveryCalls === 2) return new ReadableStream({ start(controller) {
        controller.enqueue({ type: 'content', text: '@@LESSON\n' + body(1, 1) });
        setTimeout(() => controller.error(Error('injected page-two disconnect')), 5);
      } });
      const response = `${item.plan ? '' : '@@PLAN\n' + JSON.stringify(plan) + '\n'}@@LESSON\n${recoveryCalls === 3 ? '继续讨论趋近路径与边界，输入只能沿定义域允许的路径变化。' : body(0, 1)}\n@@HOOK\n${JSON.stringify({ id: 'hook-' + item.generation.pageId, kind: 'reflection', prompt: '如何解释边界？' })}\n@@END\n`;
      return new ReadableStream({ start(controller) { controller.enqueue({ type: 'content', text: response }); controller.close(); } });
    },
  });
  const interruptedRuntime = recoveryRuntime(); await interruptedRuntime.start(); await interruptedRuntime.next();
  assert.equal(interruptedRuntime.getSnapshot().phase, 'error');
  const pendingCourse = interruptedRuntime.getSnapshot().course!, requestId = pendingCourse.generation.requestId;
  assert.equal(pendingCourse.generation.pageId, 'main-2'); assert.ok(pendingCourse.generation.previousTeaching?.excerpt);
  interruptedRuntime.dispose();
  const restoredRuntime = recoveryRuntime(); await restoredRuntime.start();
  assert.equal(restoredRuntime.getSnapshot().phase, 'interrupted'); assert.equal(recoveryCalls, 2);
  await restoredRuntime.retry();
  assert.equal(restoredRuntime.getSnapshot().page?.id, 'main-2'); assert.equal(restoredRuntime.getSnapshot().phase, 'ready');
  assert.equal(restoredRuntime.getSnapshot().course?.generation.requestId, requestId);
  assert.ok(restoredRuntime.getSnapshot().page?.body.startsWith(body(1, 1).trim()));
  assert.equal(restoredRuntime.getSnapshot().course?.pages?.length, 2);
  restoredRuntime.dispose();
  checks.push('第2页断流后重进不自动调用模型；显式续写保留原页ID、请求、固定主线和前页衔接，未覆盖第1页');
  const found = await queue.search(project.id, '定义域与输入限制');
  assert.ok(found.length > 0);
  assert.ok(found.every(hit => course().pages?.some(page => page.id === hit.pageId) && !/PRIVATE_/u.test(hit.content)));
  assert.deepEqual(await queue.search('different-project', '定义域'), []);
  checks.push('真实页级索引可按当前叶子检索，未包含私人复述，其他项目查询不读取本课程或进行推理');
  assert.ok(workerOperations.length > 0 && workerOperations.every(op => op === 'chunk-textbook' || realEmbedding && op === 'embed'));
  assert.equal((await fs.readFile(path.join(vault, 'notes', project.id + '.md'), 'utf8')), projected.content);
  const proof = { status: 'passed', checks: checks.length, root, coverage: checks, compute: {
    chunking: 'production utility worker via real Node IPC', embedding: realEmbedding ? 'real offline ONNX shared worker' : 'deterministic injected vectors; real ONNX measured separately',
    workerOperations, events, totalEmbeddingInputs: inputs.length }, failedPageEvents: events.slice(beforeFailure, beforeRecovery) };
  await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(proof, null, 2));
  console.log(JSON.stringify({ status: proof.status, checks: checks.length, root, coverage: checks }, null, 2));
} finally { runtime.dispose(); await queue.stop(); await computeClient.shutdown(async child => { child.kill(); }); }
