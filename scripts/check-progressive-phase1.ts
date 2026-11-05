import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ProgressiveLearningStore } from '../src/electron/progressiveLearningStore';
import { atomicWriteTextFile } from '../src/electron/atomicWrite';
import { shareProgressiveTeaching } from '../src/services/progressiveLearning/share';
import type { ProgressiveBeginReply, ProgressiveCourse, ProgressiveMainline, ProgressivePublication } from '../src/services/progressiveLearning/types';
import type { NoteItem } from '../src/types';
import { writeTextbookRegion } from '../src/services/textbook/noteContent';

// Production storage, real disk and deliberately injected failure boundaries.
// No network or vector/model runtime is installed by this check.
const root = await fs.mkdtemp(path.resolve('build/progressive-phase1-contract-'));
const at = '2026-11-01T00:00:00.000Z';
function note(id: string, extra: Partial<NoteItem> = {}): NoteItem {
  return { id, title: `函数与定义域 ${id}`, noteType: 'project', projectRole: 'learning',
    content: '# 学习目标\n理解函数的一一对应规则与定义域。', tags: [], links: [], backlinks: [], dueDates: [], createdAt: at, updatedAt: at, ...extra };
}
const projectRoot = note('course-root', { title: '函数与极限', planMeta: { dailyStudyMinutes: 30 } as NoteItem['planMeta'] });
const fresh = note('fresh', { parentId: projectRoot.id });
const failure = note('failure', { parentId: projectRoot.id });
const interrupted = note('interrupted', { parentId: projectRoot.id });
const legacy = writeTextbookRegion(note('legacy'), '# 完整旧教材\n\n原来的内容保持原样。', {
  schemaVersion: 1, textbookId: 'old-book', projectNoteId: 'legacy', rootProjectId: 'legacy',
  regionId: 'old-region', revisionId: 'old-revision', createdAt: at, updatedAt: at,
});
const targets = new Map([projectRoot, fresh, failure, interrupted, legacy,
  note('knowledge', { noteType: 'knowledge', projectRole: undefined }),
  note('reference', { projectRole: 'reference' }),
].map(item => [item.id, item]));
let failReadyCommit = false, writeCount = 0;
const deps = {
  readTarget: async (id: string) => {
    const current = targets.get(id);
    if (!current) throw Error('目标不存在');
    return { note: current, root: current.parentId ? projectRoot : current, isLeaf: current.id !== projectRoot.id };
  },
  write: async (file: string, text: string) => {
    writeCount++;
    if (failReadyCommit && file.endsWith('course.json') && JSON.parse(text).generation?.status === 'ready') {
      failReadyCommit = false;
      throw Error('Injected disk failure before ready acknowledgement');
    }
    await atomicWriteTextFile(file, text, { allowCopyFallback: false });
  },
};
const store = new ProgressiveLearningStore(root, deps);
const checks: string[] = [];
for (const projectNoteId of ['course-root', 'knowledge', 'reference', 'legacy', '../escape']) {
  await assert.rejects(store.command({ op: 'begin', projectNoteId }, 1), `cannot initialize ${projectNoteId}`);
}
checks.push('主进程拒绝非叶子、知识笔记、资料项目、完整旧教材及非法目标');
const writeCountBeforeAdmission = writeCount;
const gated = new ProgressiveLearningStore(path.join(root, 'admission-check'), { ...deps,
  canBegin: () => { throw Error('原整本教材任务仍在执行'); },
});
await assert.rejects(gated.command({ op: 'begin', projectNoteId: fresh.id }, 1), /原整本教材任务/u);
assert.equal(writeCount, writeCountBeforeAdmission);
checks.push('旧整本教材任务占用时拒绝新生成许可，不创建课程或覆盖原任务');

const begin = await store.command({ op: 'begin', projectNoteId: fresh.id, sourcePackets: [{
  id: 'private-document-id', title: 'PRIVATE_SOURCE_TITLE', kind: 'document',
  text: 'PRIVATE_SOURCE_TEXT', locator: 'C:/PRIVATE_SOURCE_PATH.pdf',
}] }, 11) as ProgressiveBeginReply;
assert.ok(begin.lease);
const lease = begin.lease!;
assert.equal(begin.course.firstPage, null);
const duplicate = await store.command({ op: 'begin', projectNoteId: fresh.id }, 12) as ProgressiveBeginReply;
assert.equal(duplicate.course.id, begin.course.id);
assert.equal(duplicate.course.generation.requestId, begin.course.generation.requestId);
assert.equal(duplicate.running, true);
assert.equal(duplicate.lease, undefined, 'a different owner cannot steal an active course');
checks.push('重复进入复用课程和请求，其他入口不能抢占正在生成的任务');

const plan: ProgressiveMainline = {
  title: '函数与定义域', objectives: ['能辨别输入是否具有唯一输出'],
  pages: [{ id: 'main-1', title: '唯一对应与定义域', objectives: ['识别函数关系'] },
    { id: 'main-2', title: '极限的两种入口', objectives: ['识别趋近过程'] },
    { id: 'main-3', title: '综合判断', objectives: ['说明成立条件'] }],
};
const body = '# 唯一对应与定义域\n\n函数把允许的每个输入对应到唯一的输出。判断一个关系是不是函数，先检查有没有同一个输入同时对应两个不同输出。\n\n定义域描述允许输入的范围；它与输出规则共同确定函数，不能只凭一个公式忽略输入限制。\n\n例如平方根要求根号内的表达式非负，分式要求分母不为零。把这些限制求交集，就得到实际定义域。';
await store.command({ op: 'checkpoint', lease, checkpoint: {
  sequence: 1, rawDraft: '@@PLAN\nPRIVATE_RAW_CHECKPOINT', bodyDraft: body, plan,
} }, 11);
const stale = store.command({ op: 'checkpoint', lease, checkpoint: {
  sequence: 0, rawDraft: 'stale', bodyDraft: 'stale',
} }, 11);
await stale.catch(() => undefined);
assert.equal((await store.command({ op: 'load', projectNoteId: fresh.id }, 11) as ProgressiveCourse).generation.bodyDraft, body);
const publication: ProgressivePublication = { sequence: 2, plan, title: plan.pages[0].title, body,
  hook: { id: 'hook-main-1', kind: 'reflection', prompt: '为什么判断函数时必须同时说明定义域与对应规则？' } };
const ready = await store.command({ op: 'publish', lease, teaching: publication }, 11) as ProgressiveCourse;
assert.equal(ready.generation.status, 'ready');
assert.equal(ready.firstPage?.body, body);
assert.equal(ready.firstPage?.id, begin.course.generation.pageId);
checks.push('主线与第一页真实落盘，旧序号检查点不能覆盖最新内容');
const writesBeforeLostAckRetry = writeCount;
const replayed = await store.command({ op: 'publish', lease, teaching: publication }, 11) as ProgressiveCourse;
assert.equal(replayed.id, ready.id);
assert.equal(replayed.firstPage?.body, body);
assert.equal(writeCount, writesBeforeLostAckRetry, 'lost publication acknowledgement retry must return its receipt without writing again');
await assert.rejects(store.command({ op: 'publish', lease, teaching: { ...publication, body: body + '\nChanged payload' } }, 11));
assert.equal(writeCount, writesBeforeLostAckRetry);
checks.push('发布成功但答复丢失后可幂等重试，内容不同的迟到重放不能覆盖已发布页');

const privateProgress = { currentPageId: ready.firstPage!.id, scrollTop: 468,
  restatementDraft: 'PRIVATE_RESTATEMENT', summaryDraft: 'PRIVATE_SUMMARY',
  questions: [{ id: 'private-question-1', question: 'PRIVATE_QUESTION', answer: 'PRIVATE_ANSWER', noteId: fresh.id, createdAt: at }],
  questionDraft: 'PRIVATE_UNSENT_QUESTION',
};
const progressed = await store.command({ op: 'save-progress', projectNoteId: fresh.id,
  progress: { environmentId: ready.environmentId, courseId: ready.id, expectedProgressVersion: ready.progress.version, patch: privateProgress } }, 11) as ProgressiveCourse;
const reopened = new ProgressiveLearningStore(root, deps);
const restored = await reopened.command({ op: 'load', projectNoteId: fresh.id }, 20) as ProgressiveCourse;
assert.equal(restored.id, ready.id);
assert.deepEqual(restored.plan, plan);
assert.equal(restored.firstPage?.id, ready.firstPage?.id);
assert.deepEqual(restored.progress, progressed.progress);
const readyBegin = await reopened.command({ op: 'begin', projectNoteId: fresh.id }, 20) as ProgressiveBeginReply;
assert.equal(readyBegin.course.generation.status, 'ready');
assert.equal(readyBegin.lease, undefined, 'published page must not initiate a new generation');
await assert.rejects(reopened.command({ op: 'save-progress', projectNoteId: fresh.id,
  progress: { environmentId: ready.environmentId, courseId: ready.id, expectedProgressVersion: ready.progress.version, patch: { scrollTop: 1 } } }, 20));
assert.equal((await reopened.command({ op: 'load', projectNoteId: fresh.id }, 20) as ProgressiveCourse).progress.scrollTop, 468);
await assert.rejects(reopened.command({ op: 'save-progress', projectNoteId: fresh.id,
  progress: { environmentId: ready.environmentId, courseId: ready.id, expectedProgressVersion: progressed.progress.version,
    patch: { questions: [{ ...privateProgress.questions[0], noteId: 'another-project' }] } } }, 20));
checks.push('重新构造存储恢复原主线、页与私人草稿，过期进度写入不覆盖新记录');

const movedRoot = path.join(root, 'moved-state');
await fs.mkdir(movedRoot);
await fs.cp(path.join(root, 'progressive-learning'), path.join(movedRoot, 'progressive-learning'), { recursive: true });
const movedStore = new ProgressiveLearningStore(movedRoot, deps);
const movedCourse = await movedStore.command({ op: 'load', projectNoteId: fresh.id }, 22) as ProgressiveCourse;
assert.notEqual(movedCourse.environmentId, restored.environmentId);
assert.equal(movedCourse.id, restored.id);
assert.deepEqual(movedCourse.progress, restored.progress);
await assert.rejects(movedStore.command({ op: 'save-progress', projectNoteId: fresh.id,
  progress: { environmentId: restored.environmentId, courseId: restored.id,
    expectedProgressVersion: restored.progress.version, patch: { scrollTop: 9 } } }, 22));
assert.equal((await movedStore.command({ op: 'load', projectNoteId: fresh.id }, 22) as ProgressiveCourse).progress.scrollTop, 468);
checks.push('迁移保留私人记录并重绑环境，旧环境迟到请求不能覆盖新位置');

const shared = shareProgressiveTeaching({ ...restored, privateUnexpected: 'PRIVATE_UNKNOWN' } as ProgressiveCourse);
assert.deepEqual(Object.keys(shared).sort(), ['pages', 'schemaVersion', 'title']);
assert.deepEqual(Object.keys(shared.pages[0]).sort(), ['body', 'hook', 'title']);
assert.deepEqual(Object.keys(shared.pages[0].hook).sort(), ['kind', 'prompt']);
assert.ok(shared.pages[0].body.includes('函数'));
assert.equal(/PRIVATE_|course-root|private-document-id|C:\//u.test(JSON.stringify(shared)), false);
shared.pages[0].hook.prompt = 'modified exported copy';
assert.notEqual(restored.firstPage!.hook.prompt, shared.pages[0].hook.prompt);
assert.equal(shareProgressiveTeaching({ ...begin.course, title: 'PRIVATE_PROJECT_TITLE' }).title, '学习教材');
checks.push('分享仅教学正文与静态钩子，私人草稿、来源物料、路径及新增私有字段均不泄漏');

const interruptedBegin = await store.command({ op: 'begin', projectNoteId: interrupted.id }, 31) as ProgressiveBeginReply;
await store.command({ op: 'checkpoint', lease: interruptedBegin.lease!, checkpoint: {
  sequence: 1, rawDraft: '@@PLAN\n...', bodyDraft: body.slice(0, 100), plan,
} }, 31);
await store.releaseOwner(31);
const interruptedCourse = await new ProgressiveLearningStore(root, deps).command({ op: 'load', projectNoteId: interrupted.id }, 32) as ProgressiveCourse;
assert.equal(interruptedCourse.id, interruptedBegin.course.id);
assert.equal(interruptedCourse.generation.status, 'interrupted');
assert.equal(interruptedCourse.generation.bodyDraft, body.slice(0, 100));
assert.deepEqual(interruptedCourse.plan, plan);
checks.push('生成窗口关闭后保留主线和可读前缀，重启识别为可续写的中断任务');

const failureBegin = await store.command({ op: 'begin', projectNoteId: failure.id }, 41) as ProgressiveBeginReply;
await store.command({ op: 'checkpoint', lease: failureBegin.lease!, checkpoint: {
  sequence: 1, rawDraft: 'complete but not acknowledged', bodyDraft: body, plan,
} }, 41);
failReadyCommit = true;
await assert.rejects(store.command({ op: 'publish', lease: failureBegin.lease!, teaching: publication }, 41), /Injected disk failure/);
const afterFailure = await new ProgressiveLearningStore(root, deps).command({ op: 'load', projectNoteId: failure.id }, 42) as ProgressiveCourse;
assert.notEqual(afterFailure.generation.status, 'ready');
assert.equal(afterFailure.firstPage, null, 'orphan static page cannot make a failed course commit appear saved');
const retry = await store.command({ op: 'publish', lease: failureBegin.lease!, teaching: publication }, 41) as ProgressiveCourse;
assert.equal(retry.generation.status, 'ready');
assert.equal(retry.firstPage!.body, body);
checks.push('发布落盘失败不虚报完成，同一请求重试成功且不需要重做教材');

const files = async (directory: string): Promise<string[]> => (await fs.readdir(directory, { withFileTypes: true })).flatMap(entry => [entry.name]);
assert.ok((await files(path.join(root, 'progressive-learning'))).every(name => name.startsWith('project-')));
await fs.writeFile(path.join(root, 'result.json'), JSON.stringify({ status: 'passed', checks, model: 'not used', root }, null, 2));
console.log(JSON.stringify({ status: 'passed', checks: checks.length, root, coverage: checks }, null, 2));
