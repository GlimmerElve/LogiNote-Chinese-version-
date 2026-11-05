import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ProgressiveLearningStore } from '../src/electron/progressiveLearningStore';
import { createProgressiveController, type ProgressiveStorageAdapter } from '../src/services/progressiveLearning/runtime';
import { parseProgressiveResponse, ProgressiveStreamParser, stableMarkdownBlocks } from '../src/services/progressiveLearning/stream';
import { progressiveGenerationRequest } from '../src/services/progressiveLearning/generation';
import type { ProgressiveBeginReply, ProgressiveCourse, ProgressiveMainline } from '../src/services/progressiveLearning/types';
import type { StreamChunk } from '../src/services/llmStreamService';
import type { NoteItem } from '../src/types';

const root = await fs.mkdtemp(path.resolve('build/progressive-phase1-runtime-'));
const at = '2026-11-01T00:00:00.000Z';
const makeNote = (id: string): NoteItem => ({ id, title: `理解函数 ${id}`, noteType: 'project', content: '',
  dueDates: [], tags: [], links: [], backlinks: [], createdAt: at, updatedAt: at });
const notes = new Map<string, NoteItem>();
const store = new ProgressiveLearningStore(root, { readTarget: async id => {
  const note = notes.get(id); if (!note) throw Error('Missing fixture project');
  return { note, root: note, isLeaf: true };
} });
const adapter = (owner: number): ProgressiveStorageAdapter => ({
  load: id => store.command({ op: 'load', projectNoteId: id }, owner) as Promise<ProgressiveCourse | null>,
  begin: (id, sourcePackets) => store.command({ op: 'begin', projectNoteId: id, sourcePackets }, owner) as Promise<ProgressiveBeginReply>,
  checkpoint: (lease, checkpoint) => store.command({ op: 'checkpoint', lease, checkpoint }, owner) as Promise<ProgressiveCourse>,
  publish: (lease, teaching) => store.command({ op: 'publish', lease, teaching }, owner) as Promise<ProgressiveCourse>,
  saveProgress: (id, progress) => store.command({ op: 'save-progress', projectNoteId: id, progress }, owner) as Promise<ProgressiveCourse>,
  interrupt: (lease, error) => store.command({ op: 'interrupt', lease, error }, owner) as Promise<ProgressiveCourse>,
});
const plan: ProgressiveMainline = { title: '函数与定义域', objectives: ['解释唯一对应与输入限制'], pages: [
  { id: 'main-1', title: '理解函数与定义域', objectives: ['判断唯一对应'] },
  { id: 'main-2', title: '极限入口', objectives: ['描述趋近'] },
] };
const bodyPrefix = '# 理解函数\n\n函数把允许的每个输入对应到唯一的输出。判断关系是不是函数时，应先检查同一个输入是否可能得到两个不同输出。\n\n定义域是允许输入的范围。';
const bodySuffix = '\n\n以平方根为例，根号中的表达式必须非负；以分式为例，分母必须不为零。把所有约束同时考虑，才能确定真实的定义域。\n\n接下来研究极限时，这些输入限制会决定哪些趋近过程是允许的。';
const body = bodyPrefix + bodySuffix;
const hook = { id: 'hook-main-1', kind: 'reflection' as const, prompt: '请说明为什么函数必须同时说明定义域与对应规则。' };
const header = `@@PLAN\n${JSON.stringify(plan)}\n@@LESSON\n`;
const tail = `\n@@HOOK\n${JSON.stringify(hook)}\n@@END`;
const complete = header + body + tail;
const checks: string[] = [];
function streamOf(text: string) {
  return new ReadableStream<StreamChunk>({ start(controller) {
    for (const chunk of text.match(/[\s\S]{1,29}/gu) || []) controller.enqueue({ type: 'content', text: chunk });
    controller.close();
  } });
}
async function until(predicate: () => boolean, label: string) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(label);
}
const parsed = new ProgressiveStreamParser();
parsed.append('@@P');
assert.equal(parsed.append('LAN\n' + JSON.stringify(plan) + '\n@@LESSON\n' + bodyPrefix).plan?.pages.length, 2);
assert.throws(() => parsed.finish(), /尚未完整/u);
parsed.append(bodySuffix + tail);
assert.equal(parsed.finish().body.trim(), body.trim());
assert.equal(parseProgressiveResponse('@@LESSON\n' + bodySuffix + tail, { plan, body: bodyPrefix }).body, body);
assert.throws(() => parseProgressiveResponse(header + body + tail, { plan: { ...plan, title: 'a different saved mainline' } }), /不能替换/u);
assert.throws(() => new ProgressiveStreamParser().append(header.replace(JSON.stringify(plan), JSON.stringify({ ...plan, pages: Array.from({ length: 5 }, (_, i) => ({ ...plan.pages[0], id: `main-${i + 1}` })) }))), /页数/u);
const code = stableMarkdownBlocks('已完成段落。\n\n```js\nconst draft = 1;\n\n');
assert.deepEqual(code.blocks, ['已完成段落。']);
assert.equal(code.incompleteStructure, true);
assert.match(code.pendingText, /const draft/u);
assert.equal(stableMarkdownBlocks('段落\n\n$$\nx^2\n\n').incompleteStructure, true);
checks.push('流式标记跨块、主线先出、缺失钩子、固定主线和未闭合结构均按协议处理');

const liveNote = makeNote('live'); notes.set(liveNote.id, liveNote);
let streamController: ReadableStreamDefaultController<StreamChunk> | undefined, streamCalls = 0;
const live = createProgressiveController({ note: liveNote, allNotes: [liveNote] }, {
  storage: adapter(1), loadMaterials: async () => [], registerFlush: () => () => {}, checkpointIntervalMs: 100000,
  stream: async () => { streamCalls++; return new ReadableStream<StreamChunk>({ start(controller) { streamController = controller; } }); },
});
const firstRun = live.start();
assert.equal(live.start(), firstRun, 'concurrent starts must share the same run');
await until(() => Boolean(streamController), 'stream must start');
streamController!.enqueue({ type: 'content', text: header + bodyPrefix });
await until(() => live.getSnapshot().page?.body === bodyPrefix, 'body must appear while streaming');
assert.equal(live.getSnapshot().phase, 'generating');
assert.deepEqual(live.getSnapshot().blocks, ['# 理解函数', '函数把允许的每个输入对应到唯一的输出。判断关系是不是函数时，应先检查同一个输入是否可能得到两个不同输出。']);
live.saveProgress({ restatementDraft: 'PRIVATE_RUNTIME_RESTATEMENT', scrollTop: 200 });
await live.flush();
const midStream = await adapter(1).load(liveNote.id);
assert.deepEqual(midStream?.plan, plan);
assert.equal(midStream?.generation.bodyDraft, bodyPrefix);
assert.equal(midStream?.progress.restatementDraft, 'PRIVATE_RUNTIME_RESTATEMENT');
streamController!.enqueue({ type: 'content', text: bodySuffix + tail }); streamController!.close();
await firstRun;
assert.equal(live.getSnapshot().phase, 'ready');
assert.equal(streamCalls, 1);
const readyId = live.getSnapshot().course!.id;
live.dispose();
const reopen = createProgressiveController({ note: liveNote, allNotes: [liveNote] }, {
  storage: adapter(2), loadMaterials: async () => { throw Error('Published page must not load materials again'); }, registerFlush: () => () => {},
  stream: async () => { throw Error('Published page must not generate again'); },
});
await reopen.start();
assert.equal(reopen.getSnapshot().phase, 'ready');
assert.equal(reopen.getSnapshot().course?.id, readyId);
assert.equal(reopen.getSnapshot().course?.progress.restatementDraft, 'PRIVATE_RUNTIME_RESTATEMENT');
const requestCourse = reopen.getSnapshot().course!;
const request = progressiveGenerationRequest({ ...requestCourse, progress: { ...requestCourse.progress,
  summaryDraft: 'PRIVATE_RUNTIME_SUMMARY', questionDraft: 'PRIVATE_RUNTIME_QUESTION_DRAFT',
  questions: [{ id: 'private-question', noteId: liveNote.id, question: 'PRIVATE_RUNTIME_QUESTION', answer: 'PRIVATE_RUNTIME_ANSWER', createdAt: at }],
} });
assert.equal(request.skipMemoryInjection, true);
assert.equal(request.skipProfileInjection, true);
const newPagePrompt = progressiveGenerationRequest({ ...requestCourse, generation: { ...requestCourse.generation, bodyDraft: '' } }).systemPromptOverride || '';
const continuedPrompt = progressiveGenerationRequest({ ...requestCourse, generation: { ...requestCourse.generation, bodyDraft: '已保存的正文前缀' } }).systemPromptOverride || '';
assert.ok(newPagePrompt.includes('> **要点**') && !continuedPrompt.includes('> **要点**'), 'new layouts apply to new pages without changing a partially generated page');
assert.ok(newPagePrompt.includes('判断本页是否讲清了可操作的关系') && !newPagePrompt.includes('不另行请求绘图模型'));
assert.ok(!continuedPrompt.includes('判断本页是否讲清了可操作的关系') && continuedPrompt.includes('不另行请求绘图模型'), 'resuming an existing page keeps its original figure instructions');
assert.equal(request.userInput.includes('PRIVATE_RUNTIME_RESTATEMENT'), false);
assert.equal(request.userInput.includes('PRIVATE_RUNTIME_'), false, 'generation prompt must not receive private summaries, question drafts or actual answers');
reopen.dispose();
checks.push('真实存储支持主线及正文增量可读、并发start复用、草稿保存及ready恢复不再请求模型');

const resumeNote = makeNote('resume'); notes.set(resumeNote.id, resumeNote);
let resumeCalls = 0, savedRequestId = '';
const interruptedRuntime = createProgressiveController({ note: resumeNote, allNotes: [resumeNote] }, {
  storage: adapter(3), loadMaterials: async () => [], registerFlush: () => () => {},
  stream: async course => {
    resumeCalls++; savedRequestId = course.generation.requestId;
    return new ReadableStream<StreamChunk>({ start(controller) {
      controller.enqueue({ type: 'content', text: header + bodyPrefix });
      setTimeout(() => controller.error(new Error('Injected interrupted stream')), 10);
    } });
  },
});
await interruptedRuntime.start();
assert.equal(interruptedRuntime.getSnapshot().phase, 'error');
assert.equal(interruptedRuntime.getSnapshot().page?.body, bodyPrefix);
assert.deepEqual(interruptedRuntime.getSnapshot().plan, plan);
interruptedRuntime.dispose();
const resumed = createProgressiveController({ note: resumeNote, allNotes: [resumeNote] }, {
  storage: adapter(4), loadMaterials: async () => [], registerFlush: () => () => {},
  stream: async course => {
    resumeCalls++;
    assert.equal(course.generation.requestId, savedRequestId);
    assert.equal(course.generation.bodyDraft, bodyPrefix);
    return streamOf('@@LESSON\n' + bodySuffix + tail);
  },
});
await resumed.start();
assert.equal(resumed.getSnapshot().phase, 'interrupted');
assert.equal(resumeCalls, 1, 'opening an interrupted page is not an implicit paid retry');
await resumed.retry();
assert.equal(resumed.getSnapshot().phase, 'ready');
assert.equal(resumed.getSnapshot().page?.body, body);
assert.equal(resumeCalls, 2);
resumed.dispose();
checks.push('断流保留正文与主线，重新进入不隐式重试，显式继续沿同一请求续写');

const failureNote = makeNote('publication-failure'); notes.set(failureNote.id, failureNote);
const failureStorage = adapter(5);
let allowPublish = false, failureStreamCalls = 0;
const failRuntime = createProgressiveController({ note: failureNote, allNotes: [failureNote] }, {
  storage: { ...failureStorage, publish: async (...args) => {
    if (!allowPublish) throw Error('Injected persistent publication IO failure');
    return failureStorage.publish(...args);
  } },
  loadMaterials: async () => [], registerFlush: () => () => {},
  stream: async () => { failureStreamCalls++; return streamOf(complete); },
});
await failRuntime.start();
assert.notEqual(failRuntime.getSnapshot().phase, 'ready');
assert.equal(failRuntime.getSnapshot().page?.body.trim(), body.trim());
assert.equal(failRuntime.getSnapshot().isDirty, true);
assert.match(failRuntime.getSnapshot().saveError!, /IO failure/u);
assert.equal((await failureStorage.load(failureNote.id))?.firstPage, null);
allowPublish = true;
await failRuntime.retry();
assert.equal(failRuntime.getSnapshot().phase, 'ready');
assert.equal(failureStreamCalls, 1);
failRuntime.dispose();
checks.push('发布保存失败仍保留可读完整页与dirty状态，恢复磁盘后仅重试保存、不重做模型生成');

const restartNote = makeNote('publication-restart'); notes.set(restartNote.id, restartNote);
const restartStorage = adapter(7);
const beforeRestart = createProgressiveController({ note: restartNote, allNotes: [restartNote] }, {
  storage: { ...restartStorage, publish: async () => { throw Error('Publication disk unavailable before restart'); } },
  loadMaterials: async () => [], registerFlush: () => () => {}, stream: async () => streamOf(complete),
});
await beforeRestart.start();
assert.equal(beforeRestart.getSnapshot().isDirty, true);
const restartCourseId = beforeRestart.getSnapshot().course!.id;
beforeRestart.dispose();
await store.releaseOwner(7);
let unexpectedRestartGeneration = 0;
const afterRestart = createProgressiveController({ note: restartNote, allNotes: [restartNote] }, {
  storage: adapter(8), loadMaterials: async () => [], registerFlush: () => () => {},
  stream: async () => { unexpectedRestartGeneration++; throw Error('Complete checkpoint must publish without a model'); },
});
await afterRestart.start();
assert.equal(afterRestart.getSnapshot().phase, 'ready');
assert.equal(afterRestart.getSnapshot().course?.id, restartCourseId);
assert.equal(afterRestart.getSnapshot().page?.body.trim(), body.trim());
assert.equal(unexpectedRestartGeneration, 0);
afterRestart.dispose();
checks.push('完整页发布失败后重启，从真实检查点恢复钩子并仅补做落盘，不调用模型');

const loadingNote = makeNote('input-during-loading'); notes.set(loadingNote.id, loadingNote);
const loadingStorage = adapter(9);
let releaseBegin: (() => void) | undefined;
const loading = createProgressiveController({ note: loadingNote, allNotes: [loadingNote] }, {
  storage: { ...loadingStorage, begin: async (...args) => {
    await new Promise<void>(resolve => { releaseBegin = resolve; });
    return loadingStorage.begin(...args);
  } },
  loadMaterials: async () => [], registerFlush: () => () => {}, stream: async () => streamOf(complete),
});
try {
  const starting = loading.start();
  await until(() => Boolean(releaseBegin), 'initial storage admission is delayed');
  loading.saveProgress({ restatementDraft: 'Input entered before initial course response' });
  releaseBegin!();
  await starting;
  await loading.flush();
  assert.equal(loading.getSnapshot().course?.progress.restatementDraft, 'Input entered before initial course response');
  assert.equal((await loadingStorage.load(loadingNote.id))?.progress.restatementDraft, 'Input entered before initial course response');
} finally { loading.dispose(); }
checks.push('初次读取或创建课程期间的输入不被稍后返回的空草稿覆盖');

const progressNote = makeNote('progress-race'); notes.set(progressNote.id, progressNote);
const progressStorage = adapter(6);
let releaseSave: (() => void) | undefined, savingProgress = false;
const progressRuntime = createProgressiveController({ note: progressNote, allNotes: [progressNote] }, {
  storage: { ...progressStorage, saveProgress: async (...args) => {
    if (!savingProgress) {
      savingProgress = true;
      await new Promise<void>(resolve => { releaseSave = resolve; });
    }
    return progressStorage.saveProgress(...args);
  } },
  loadMaterials: async () => [], registerFlush: () => () => {}, stream: async () => streamOf(complete), checkpointIntervalMs: 100000,
});
await progressRuntime.start();
progressRuntime.saveProgress({ restatementDraft: 'first saved text' });
const writing = progressRuntime.flush();
await until(() => Boolean(releaseSave), 'progress write must wait at boundary');
progressRuntime.saveProgress({ restatementDraft: 'new text entered while saving' });
releaseSave!(); await writing;
assert.equal(progressRuntime.getSnapshot().course?.progress.restatementDraft, 'new text entered while saving');
assert.equal((await progressStorage.load(progressNote.id))?.progress.restatementDraft, 'new text entered while saving');
progressRuntime.dispose();
checks.push('旧进度保存确认不会抹掉写入期间新增复述，flush持久化最新草稿');

const lifecycleNote = makeNote('flush-lifecycle'); notes.set(lifecycleNote.id, lifecycleNote);
const registered = new Set<() => Promise<void>>();
let registrations = 0, releases = 0;
const registerFlush = (flush: () => Promise<void>) => {
  registrations++; registered.add(flush);
  return () => { releases++; registered.delete(flush); };
};
const abandoned = createProgressiveController({ note: lifecycleNote, allNotes: [lifecycleNote] }, {
  storage: adapter(10), loadMaterials: async () => [], stream: async () => streamOf(complete), registerFlush,
});
assert.equal(registrations, 0, 'constructing a controller during an abandoned render must not register a global flusher');
abandoned.dispose();
assert.equal(releases, 0);
let lifecycleAllowPublish = false;
const lifecycleStorage = adapter(11);
const lifecycle = createProgressiveController({ note: lifecycleNote, allNotes: [lifecycleNote] }, {
  storage: { ...lifecycleStorage, publish: async (...args) => {
    if (!lifecycleAllowPublish) throw Error('Lifecycle publication remains unsaved');
    return lifecycleStorage.publish(...args);
  } },
  loadMaterials: async () => [], stream: async () => streamOf(complete), registerFlush,
});
await lifecycle.start();
assert.equal(registrations, 1);
assert.equal(registered.size, 1);
lifecycle.dispose();
await until(() => lifecycle.getSnapshot().saveError !== null, 'dirty disposed controller must retain its unsaved work');
assert.equal(registered.size, 1, 'unsaved disposed participant must remain available for a real retry');
lifecycleAllowPublish = true;
await [...registered][0]();
assert.equal(lifecycle.getSnapshot().phase, 'ready');
assert.equal(registered.size, 0);
assert.equal(releases, 1);
checks.push('未挂载的控制器不注册保存钩子，dirty卸载保留重试参与者，真正落盘后只解除一次');

await fs.writeFile(path.join(root, 'result.json'), JSON.stringify({ status: 'passed', checks, root, generationQuality: 'not assessed; deterministic protocol inputs' }, null, 2));
console.log(JSON.stringify({ status: 'passed', checks: checks.length, root, coverage: checks }, null, 2));
