import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ProgressiveLearningStore } from '../src/electron/progressiveLearningStore';
import { progressiveAdaptation } from '../src/electron/progressiveStudy';
import { createProgressiveController, type ProgressiveStorageAdapter } from '../src/services/progressiveLearning/runtime';
import { progressiveGenerationRequest } from '../src/services/progressiveLearning/generation';
import { ProgressiveStreamParser } from '../src/services/progressiveLearning/stream';
import { editRestatementSpans, pageRestatement } from '../src/services/progressiveLearning/restatement';
import { shareProgressiveTeaching } from '../src/services/progressiveLearning/share';
import { atomicWriteTextFile } from '../src/electron/atomicWrite';
import type { ProgressiveCommand, ProgressiveBeginReply, ProgressiveCourse, ProgressiveMainline,
  ProgressiveQuestion, ProgressiveStudyReply, ProgressivePageStudy } from '../src/services/progressiveLearning/types';
import type { NoteItem } from '../src/types';

const root = await fs.mkdtemp(path.resolve('build/progressive-phase3-contract-'));
const checks: string[] = [];
const quote = '允许的每个输入必须对应唯一的输出。';
const body = `# 输入限制\n\n${quote}不同输入可以有相同的输出。定义域首先说明允许哪些输入。\n\n## 条件与例子\n\n分母不能为零，偶次根式的被开方数需要非负。长度2米与1米相加得到3米。\n\n${'先写出限制条件，再检查允许的输入与对应关系，最后判断是否满足唯一性。'.repeat(35)}`;
const questions = (count: number): ProgressiveQuestion[] => [
  { id: 'q1', kind: 'choice' as const, prompt: '一个允许的输入能否对应两个不同输出？', objective: '识别唯一性', conceptKeys: ['unique'], focus: 'concept' as const,
    options: [{ id: 'A', text: '不能' }, { id: 'B', text: '能' }], correctOptionId: 'A', referenceAnswer: '不能', explanation: '允许的每个输入需要唯一的输出。', referenceQuote: quote },
  { id: 'q2', kind: 'application' as const, prompt: '长度2米与1米相加是多少？写出数值与单位。', objective: '应用数量关系', conceptKeys: ['sum'], focus: 'calculation' as const,
    referenceAnswer: '3米', explanation: '2米+1米=3米。', referenceQuote: '长度2米与1米相加得到3米。' },
  { id: 'q3', kind: 'judgment' as const, prompt: '同一允许输入对应多个不同输出也符合函数定义，对吗？', objective: '核对唯一性条件', conceptKeys: ['unique'], focus: 'concept' as const,
    options: [{ id: 'A', text: '不对' }, { id: 'B', text: '对' }], correctOptionId: 'A', referenceAnswer: '不对', explanation: '输出唯一是函数条件。', referenceQuote: quote },
].slice(0, count);
const plan: ProgressiveMainline = { title: '输入限制与对应', objectives: ['能够判断函数关系'], pages: Array.from({ length: 4 }, (_, i) => ({ id: `main-${i + 1}`, title: `主线讲解 ${i + 1}`, objectives: [`理解第${i + 1}项输入约束`] })) };
const response = (course: ProgressiveCourse, count: number, route: 'mainline' | 'expansion' | 'finish', tail = '') => {
  const routing = course.generation.routePending ? `@@ROUTE\n${JSON.stringify({ kind: route, reason: route === 'expansion' ? '先补充关键概念的边界' : '继续既定主线，局部失误在相关处纠正', correction: '用一个边界例子澄清输入与输出的唯一关系' })}\n` : '';
  if (routing && route === 'finish') return routing + '@@END\n';
  return `${course.plan ? '' : '@@PLAN\n' + JSON.stringify(plan) + '\n'}${routing}@@LESSON\n${tail || body}\n@@CONCEPTS\n[]\n@@QUESTIONS\n${JSON.stringify(questions(count))}\n@@HOOK\n${JSON.stringify({ id: 'hook-' + course.generation.pageId, kind: 'reflection', prompt: '如何说明允许的输入和唯一输出？' })}\n@@END\n`;
};
function harness(name: string, minutes = 60) {
  const at = new Date().toISOString();
  const note: NoteItem = { id: name, title: '函数与定义域', noteType: 'project', projectRole: 'learning', content: '# 人工学习目标\n保留原文。',
    tags: [], links: [], backlinks: [], createdAt: at, updatedAt: at,
    dueDates: [{ id: 'task', noteId: name, noteTitle: '函数与定义域', taskText: '函数与定义域', dueDate: '2026-11-06', estimatedMinutes: minutes, completed: false, priority: 'medium' }] };
  let count = 3, route: 'mainline' | 'expansion' | 'finish' = 'mainline', calls = 0, assessments = 0;
  let failStudy = false, loseSubmitAck = false, loseRouteAck = false, failAssessment = false, failPublish = false;
  let interrupt = false, resume = false;
  let holdAssessment = false, releaseAssessment: (() => void) | undefined;
  let materialGate: (() => Promise<void>) | undefined;
  const changes: string[] = [], requests: any[] = [], materialFocuses: Array<string|undefined> = [];
  const directory = path.join(root, name);
  const store = new ProgressiveLearningStore(directory, { readTarget: async () => ({ note, root: note, isLeaf: true }),
    changed: id => changes.push(id), write: async (file, text) => {
      if (failStudy && file.includes(`${path.sep}study${path.sep}`)) { failStudy = false; throw Error('injected study disk failure'); }
      if (failPublish && file.endsWith('course.json') && JSON.parse(text).generation.status === 'ready') { failPublish = false; throw Error('injected publication failure'); }
      await atomicWriteTextFile(file, text, { allowCopyFallback: false });
    } });
  const command = async (input: ProgressiveCommand): Promise<any> => {
    const result = await store.command(input, 7);
    if (loseSubmitAck && input.op === 'study' && input.request.mutation.kind === 'submit') { loseSubmitAck = false; throw Error('lost submit acknowledgement'); }
    if (loseRouteAck && input.op === 'route') { loseRouteAck = false; throw Error('lost route acknowledgement'); }
    return result;
  };
  const storage: ProgressiveStorageAdapter = {
    load: id => command({ op: 'load', projectNoteId: id }), begin: (id, sources) => command({ op: 'begin', projectNoteId: id, sourcePackets: sources }),
    next: (id, request) => command({ op: 'next', projectNoteId: id, request }), route: (lease, route) => command({ op: 'route', lease, route }),
    study: (id, request) => command({ op: 'study', projectNoteId: id, request }),
    checkpoint: (lease, checkpoint) => command({ op: 'checkpoint', lease, checkpoint }), publish: (lease, teaching) => command({ op: 'publish', lease, teaching }),
    saveProgress: (id, progress) => command({ op: 'save-progress', projectNoteId: id, progress }), interrupt: (lease, error) => command({ op: 'interrupt', lease, error }),
  };
  const create = () => createProgressiveController({ note, allNotes: [note] }, { storage, registerFlush: () => () => {}, loadMaterials: async (_note,_notes,focus) => { materialFocuses.push(focus);await materialGate?.(); return []; },
    assessmentCall: async request => {
      assessments++; const input = JSON.parse(request.userInput); requests.push({ assessment: input });
      if (holdAssessment) await new Promise<void>(resolve => { releaseAssessment = resolve; });
      if (failAssessment) { failAssessment = false; throw Error('injected assessment disconnect'); }
      if (input.feedback) return { content: JSON.stringify({ status: 'confirmed', explanation: '合成核实结果：题目的条件需要核对，保留原题和作答。' }) };
      return { content: JSON.stringify({ results: input.tasks.map((task: any) => ({ attemptId: task.attemptId,
        judgment: { outcome: 'correct', errorKind: 'none', explanation: '2米与1米相加得到3米，单位匹配。', referenceAnswer: '3米', referenceQuote: '长度2米与1米相加得到3米。' } })) }) };
    }, stream: async course => {
      calls++; requests.push({ generation: JSON.parse(progressiveGenerationRequest(course).userInput) });
      if (interrupt) {
        interrupt = false;
        const raw = `${course.generation.routePending ? '@@ROUTE\n' + JSON.stringify({ kind: route, reason: '保留本次编排' }) + '\n' : ''}@@LESSON\n${body.slice(0, 180)}\n\n`;
        return new ReadableStream({ start(controller) { controller.enqueue({ type: 'content', text: raw }); setTimeout(() => controller.error(Error('injected stream disconnect')), 5); } });
      }
      const raw = response(course, count, route, resume ? '\n\n' + body.slice(180) : ''); resume = false;
      return new ReadableStream({ start(controller) { for (const text of raw.match(/[\s\S]{1,67}/gu) || []) controller.enqueue({ type: 'content', text }); controller.close(); } });
    } });
  let runtime = create();
  return { store, storage, note, directory, changes, requests, materialFocuses, get runtime() { return runtime; }, create,
    get course() { return runtime.getSnapshot().course!; }, get study() { return runtime.getSnapshot().study!; },
    get calls() { return calls; }, get assessments() { return assessments; },
    set count(value: number) { count = value; }, set route(value: typeof route) { route = value; },
    set failStudy(value: boolean) { failStudy = value; }, set loseSubmitAck(value: boolean) { loseSubmitAck = value; }, set loseRouteAck(value: boolean) { loseRouteAck = value; },
    set failAssessment(value: boolean) { failAssessment = value; }, set failPublish(value: boolean) { failPublish = value; }, set interrupt(value: boolean) { interrupt = value; }, set resume(value: boolean) { resume = value; },
    set holdAssessment(value: boolean) { holdAssessment = value; }, releaseAssessment() { holdAssessment = false; releaseAssessment?.(); },
    set materialGate(value: (() => Promise<void>) | undefined) { materialGate = value; },
    async reenter() { await runtime.stop(); runtime.dispose(); runtime = create(); await runtime.start(); },
    async studyMutation(mutation: import('../src/services/progressiveLearning/types').ProgressiveStudyMutation) {
      return await command({ op: 'study', projectNoteId: note.id, request: { environmentId: this.course.environmentId,
        courseId: this.course.id, pageId: this.course.page!.id, expectedVersion: this.study.version, mutation } }) as ProgressiveStudyReply;
    },
  };
}

{
  const concurrent = harness('next-during-progress-save'); await concurrent.runtime.start();
  const teachingRevision = concurrent.course.revision;
  let release!: () => void, entered!: () => void;
  const materialReady = new Promise<void>(resolve => { entered = resolve; });
  concurrent.materialGate = () => { entered(); return new Promise<void>(resolve => { release = resolve; }); };
  const next = concurrent.runtime.next('mainline'); await materialReady;
  concurrent.runtime.saveProgress({ scrollTop: 345, restatementDraft: '素材准备期间新写的复述' });
  await concurrent.runtime.flush();
  const afterSave = concurrent.course.revision;
  assert.equal(afterSave, teachingRevision, 'scroll and restatement saves must not advance the teaching revision');
  release(); await Promise.all([next, concurrent.runtime.next('mainline')]);
  assert.equal(concurrent.runtime.getSnapshot().phase, 'ready', 'own progress save during material preparation cannot invalidate next');
  assert.equal(concurrent.course.pages!.length, 2); assert.equal(concurrent.calls, 2, 'one page only, including a repeated click');
  assert.ok(concurrent.course.revision > afterSave);
  assert.equal(concurrent.course.progress.restatementDraft, '素材准备期间新写的复述');
  await concurrent.runtime.stop(); concurrent.runtime.dispose();
  checks.push('素材准备期间自动保存与重复点击下一页合并最新版本，只生成一页且保留新复述');
}
{
  const external = harness('next-during-content-edit'); await external.runtime.start();
  const original = external.course;
  let release!: () => void, entered!: () => void;
  const materialReady = new Promise<void>(resolve => { entered = resolve; });
  external.materialGate = () => { entered(); return new Promise<void>(resolve => { release = resolve; }); };
  const next = external.runtime.next('mainline'); await materialReady;
  await external.store.command({ op: 'update-page', projectNoteId: external.note.id, environmentId: original.environmentId,
    courseId: original.id, pageId: original.page!.id, expectedHash: original.pages![0].contentHash, body: body + '\n\n其他窗口修改了教材。' }, 8);
  // An own progress acknowledgement may carry a fresher teaching directory.
  // It must not silently legitimize material prepared for the old content.
  (external.runtime as unknown as { receive(course: ProgressiveCourse): void }).receive((await external.storage.load(external.note.id))!);
  release(); await next;
  assert.equal(external.runtime.getSnapshot().phase, 'error', 'true external teaching changes remain protected');
  assert.equal(external.calls, 1, 'stale generation cannot call the model');
  const saved = await external.storage.load(external.note.id);
  assert.equal(saved!.pages!.length, 1); assert.ok(saved!.page!.body.includes('其他窗口修改了教材'));
  await external.runtime.stop(); external.runtime.dispose();
  checks.push('其他窗口实际修改教材仍拦截过期下一页，不重复生成或覆盖新正文');
}

{
  const isolated = harness('independent-reading-version'); await isolated.runtime.start();
  await isolated.runtime.next('mainline');
  const before = (await isolated.storage.load(isolated.note.id))!;
  let saved = before;
  for (const [currentPageId, scrollTop] of [['main-1', 420], ['main-2', 810], ['main-1', 120]] as const) {
    saved = await isolated.storage.saveProgress(isolated.note.id, { environmentId: before.environmentId, courseId: before.id,
      expectedProgressVersion: saved.progress.version, patch: { currentPageId, scrollTop } });
    assert.equal(saved.revision, before.revision, 'scrolling and page switches change private progress only');
  }
  assert.equal(saved.progress.version, before.progress.version + 3);
  assert.equal(saved.progress.scrollTop, 120);
  await assert.rejects(isolated.storage.saveProgress(isolated.note.id, { environmentId: before.environmentId, courseId: before.id,
    expectedProgressVersion: before.progress.version, patch: { restatementDraft: '不应覆盖的新草稿' } }), /学习进度已更新/u);
  const study = await isolated.store.command({ op: 'study', projectNoteId: isolated.note.id, request: {
    environmentId: before.environmentId, courseId: before.id, pageId: 'main-1', expectedVersion: 0,
    mutation: { kind: 'draft', drafts: { q1: { text: '', optionId: 'A' } } } } }, 8) as ProgressiveStudyReply;
  assert.equal(study.course.revision, before.revision, 'private answer versions do not change teaching');
  // A different window uses a teaching revision captured BEFORE all private writes.
  const reserved = await isolated.store.command({ op: 'next', projectNoteId: isolated.note.id, request: {
    environmentId: before.environmentId, courseId: before.id, expectedRevision: before.revision,
    requestId: 'independent-next-3', intent: 'mainline', fromPageId: 'main-2' } }, 8) as ProgressiveBeginReply;
  assert.equal(reserved.lease?.pageId, 'main-3');
  const published = await isolated.store.command({ op: 'publish', lease: reserved.lease!, teaching: {
    sequence: 1, plan, title: plan.pages[2].title, body, hook: { id: 'hook-3', kind: 'reflection', prompt: '说明唯一输出。' } } }, 8) as ProgressiveCourse;
  const updated = await isolated.store.command({ op: 'update-page', projectNoteId: isolated.note.id, environmentId: before.environmentId,
    courseId: before.id, pageId: 'main-1', expectedHash: published.pages![0].contentHash, body: body + '\n\n真实教材修订。' }, 8) as ProgressiveCourse;
  assert.ok(updated.revision > published.revision);
  await assert.rejects(isolated.store.command({ op: 'next', projectNoteId: isolated.note.id, request: {
    environmentId: before.environmentId, courseId: before.id, expectedRevision: published.revision,
    requestId: 'stale-teaching-4', intent: 'mainline', fromPageId: 'main-3' } }, 8), /课程已更新/u);
  const reopened = new ProgressiveLearningStore(isolated.directory, { readTarget: async () => ({ note: isolated.note, root: isolated.note, isLeaf: true }) });
  const durable = await reopened.command({ op: 'load', projectNoteId: isolated.note.id }, 9) as ProgressiveCourse;
  assert.equal(durable.revision, updated.revision); assert.deepEqual(durable.progress, updated.progress);
  await isolated.runtime.stop(); isolated.runtime.dispose();
  checks.push('滚动/切页/答题与教材版本独立，其他窗口旧内容版本仍可申请下一页；真实正文修订仍拒绝过期请求，重启保留两类版本');
}

for (const count of [0, 1, 2, 3]) {
  const raw = `@@PLAN\n${JSON.stringify(plan)}\n@@LESSON\n${body}\n@@QUESTIONS\n${JSON.stringify(questions(count))}\n@@HOOK\n${JSON.stringify({ id: 'hook', kind: 'reflection', prompt: '说明唯一性。' })}\n@@END\n`;
  const parser = new ProgressiveStreamParser(); for (const text of raw.match(/[\s\S]{1,21}/gu)!) parser.append(text);
  assert.equal(parser.finish().questions?.length, count);
}
const broken = new ProgressiveStreamParser();
const parsedBroken = broken.append(`@@PLAN\n${JSON.stringify(plan)}\n@@LESSON\n${body}\n@@QUESTIONS\n${JSON.stringify([{ ...questions(1)[0], correctOptionId: 'absent-option' }])}\n@@HOOK\n{"id":"h","kind":"reflection","prompt":"解释"}\n@@END\n`);
assert.equal(parsedBroken.body.trim(), body); assert.throws(() => broken.finish(), /选项/u);
for (const referenceQuote of ['概括本页规则，不是逐字原句', '', undefined]) {
  const parser = new ProgressiveStreamParser();
  parser.append(`@@PLAN\n${JSON.stringify(plan)}\n@@LESSON\n${body}\n@@QUESTIONS\n${JSON.stringify([{...questions(1)[0],referenceQuote}])}\n@@HOOK\n{"id":"h","kind":"reflection","prompt":"解释"}\n@@END\n`);
  assert.equal(parser.finish().questions?.length,1,'nonliteral or absent citation does not block a question');
}
checks.push('生产解析器支持0/1/2/3题与流式边界；错误题目不发布且保留已生成正文');

const focusCheck=harness('material-target-focus');focusCheck.count=0;await focusCheck.runtime.start();
await focusCheck.runtime.next('mainline');assert.ok(focusCheck.materialFocuses.at(-1)?.startsWith('主线讲解 2\n'));
await focusCheck.runtime.next();assert.ok(focusCheck.materialFocuses.at(-2)?.startsWith('主线讲解 3\n'));assert.ok(focusCheck.materialFocuses.at(-1)?.startsWith('主线讲解 2\n'));
const selected=body.slice(0,100),page=focusCheck.course.pages!.find(p=>p.id===focusCheck.course.page!.id)!;
await focusCheck.runtime.next('expansion',{text:selected,pageHash:page.contentHash});assert.ok(focusCheck.materialFocuses.at(-1)?.includes(selected));
await focusCheck.runtime.stop();focusCheck.runtime.dispose();checks.push('取材按下一主线目标；自动编排分别准备下一主线与当前薄弱点，选区补充保留当前页具体范围');

const h = harness('answers'); await h.runtime.start();
assert.equal(h.course.page?.questions?.length, 3);
await assert.rejects(h.studyMutation({ kind: 'grade', results: [{ attemptId: 'invented', judgment: { outcome: 'correct', errorKind: 'none', explanation: '伪造', referenceAnswer: 'A', referenceQuote: quote } }] }), /未提交/u);
await assert.rejects(h.studyMutation({ kind: 'submit', submissionId: 'empty', questionIds: ['q1'] }), /草稿|作答/u);
h.runtime.saveAnswerDraft!('q1', { text: '', optionId: 'B' });
h.failStudy = true; await h.runtime.submitAnswers!(['q1']);
assert.equal(h.study.attempts.length, 0); assert.equal(h.study.drafts.q1.optionId, 'B'); assert.equal(h.runtime.getSnapshot().isDirty, true);
await h.runtime.flush(); assert.equal(h.study.attempts.length, 0, 'save retry must not submit on the user behalf');
await Promise.all([h.runtime.submitAnswers!(['q1']), h.runtime.submitAnswers!(['q1'])]);
assert.equal(h.study.attempts.length, 1); assert.equal(h.study.attempts[0].judgment?.outcome, 'incorrect');
assert.equal(h.course.studyPages?.[0].submitted, 1); assert.equal(h.course.studyPages?.[0].pending, 2); assert.equal(h.assessments, 0);
const sourceHash = h.course.pages![0].contentHash, changedCount = h.changes.length;
h.runtime.saveAnswerDraft!('q2', { text: '3米', formulaDraft: '\\frac{1}{2}' });
await h.runtime.flush(); await h.reenter();
assert.equal(h.study.drafts.q2.formulaDraft, '\\frac{1}{2}'); assert.equal(h.calls, 1); assert.equal(h.study.attempts.length, 1);
assert.equal(h.changes.length, changedCount); assert.equal(h.course.pages![0].contentHash, sourceHash);
checks.push('草稿/公式与仅答题记录真实落盘，空白不能伪提交，重复点击一次提交；答错计已提交，私人保存零教材派生通知');

h.failAssessment = true;
await h.runtime.submitAnswers!(['q2']);
assert.equal(h.study.attempts.at(-1)?.judgment, undefined); assert.equal(h.course.studyPages?.[0].submitted, 2);
await h.runtime.retryGrading!(); assert.equal(h.study.attempts.at(-1)?.judgment?.outcome, 'correct'); assert.equal(h.study.attempts.length, 2);
assert.equal(h.assessments, 2);
h.runtime.saveAnswerDraft!('q1', { text: '', optionId: 'A' }); h.loseSubmitAck = true;
await h.runtime.submitAnswers!(['q1']);
assert.equal(h.study.attempts.length, 3); assert.equal(h.study.attempts[0].judgment?.outcome, 'incorrect');
assert.equal(h.study.attempts.at(-1)?.judgment, undefined);
await h.runtime.retryGrading!(); assert.equal(h.study.attempts.at(-1)?.judgment?.outcome, 'correct');
checks.push('短数值/单位应用题不受复盘字数门槛限制；判题失败只重判待判作答，提交回执丢失不重复提交，重答保留首次记录');

const questionBefore = JSON.stringify(h.course.page!.questions);
await h.runtime.sendFeedback!('q1', 'grading', 'PRIVATE_DISPUTE：请核实本题条件');
assert.equal(h.study.feedback[0].status, 'confirmed');
assert.equal(JSON.stringify(h.course.page!.questions), questionBefore);
assert.equal(h.course.currentFeedback?.answers.some(item => item.question === questions(1)[0].prompt), false);
assert.equal(h.changes.length, changedCount);
checks.push('组件反馈单独保存并核实；争议题不提供负向扩展依据，原题/原答案/旧判定不被改写，也不触发教材重算');

const late = harness('late-grade'); await late.runtime.start();
const mutateLate = async (mutation: import('../src/services/progressiveLearning/types').ProgressiveStudyMutation) => {
  const current = await late.storage.load(late.note.id);
  return late.storage.study!(late.note.id, { environmentId: current!.environmentId, courseId: current!.id,
    pageId: 'main-1', expectedVersion: current!.study!.version, mutation });
};
await mutateLate({ kind: 'draft', drafts: { q2: { text: '2米' } } });
const earlier = await mutateLate({ kind: 'submit', submissionId: 'earlier', questionIds: ['q2'] });
const earlyId = earlier.study.attempts.at(-1)!.id;
await mutateLate({ kind: 'draft', drafts: { q2: { text: '3米' } } });
const later = await mutateLate({ kind: 'submit', submissionId: 'later', questionIds: ['q2'] });
const laterId = later.study.attempts.at(-1)!.id;
const correct = { outcome: 'correct' as const, errorKind: 'none' as const, explanation: '数值与单位匹配', referenceAnswer: '3米', referenceQuote: '长度2米与1米相加得到3米。' };
await mutateLate({ kind: 'grade', results: [{ attemptId: laterId, judgment: correct }] });
await mutateLate({ kind: 'grade', results: [{ attemptId: earlyId, judgment: { ...correct, outcome: 'incorrect', errorKind: 'calculation' } }] });
const afterLate = await late.storage.load(late.note.id);
assert.equal(afterLate!.study!.attempts.at(-1)!.judgment!.outcome, 'correct');
assert.equal(afterLate!.currentFeedback!.answers[0].outcome, 'correct');
await assert.rejects(mutateLate({ kind: 'grade', results: [{ attemptId: laterId, judgment: { ...correct, outcome: 'incorrect' } }] }), /迟到/u);
checks.push('落盘失败保留答案草稿且重试不代提交；旧判定迟到仅归档原尝试，不覆盖新作答、新判定或最新编排依据');

const a = harness('adaptive'); await a.runtime.start();
a.runtime.saveAnswerDraft!('q1', { text: '', optionId: 'B' }); a.runtime.saveAnswerDraft!('q3', { text: '', optionId: 'B' });
await a.runtime.submitAnswers!(['q1', 'q3']);
a.route = 'expansion'; a.loseRouteAck = true;
await Promise.all([a.runtime.next(), a.runtime.next()]);
assert.equal(a.course.page?.kind, 'expansion'); assert.equal(a.course.page?.mainlineIndex, 0); assert.equal(a.course.page?.parentPageId, 'main-1');
assert.equal(a.course.pages?.length, 2); assert.equal(a.calls, 2);
const expansionId = a.course.page!.id;
await a.runtime.navigate('main-1'); const beforeSame = a.calls;
await a.runtime.next();
assert.equal(a.course.page?.id, 'main-2'); assert.equal(a.calls, beforeSame + 1);
assert.equal(a.course.pages?.filter(page => page.kind === 'expansion').length, 1);
checks.push('同一次流完成编排与讲解：扩展归属正确，菜单连点/路由回执丢失仍一页；同份反馈不重复自动扩展且主线继续到正确位置');

await a.runtime.navigate(expansionId); a.runtime.recordRestatement!('PRIVATE_EXPANSION：一个输入也能得到两个输出。');
await a.runtime.flush(); a.interrupt = true; a.route = 'expansion'; await a.runtime.next();
const interruptedId = a.course.generation.pageId, interruptedRequest = a.course.generation.requestId;
assert.equal(a.course.generation.kind, 'expansion'); await a.reenter();
assert.equal(a.runtime.getSnapshot().phase, 'interrupted'); const interruptedCalls = a.calls;
a.resume = true; await a.runtime.retry();
assert.equal(a.course.page?.id, interruptedId); assert.equal(a.course.generation.requestId, interruptedRequest); assert.equal(a.calls, interruptedCalls + 1);
assert.equal(a.course.pages?.filter(page => page.kind === 'expansion').length, 2);
checks.push('扩展页的新复述可再次扩展；编排后的断流和重启沿同一决定/页面续写，不重新评估或重复扣预算');

const r = harness('restatement'); r.count = 0; await r.runtime.start();
r.runtime.recordRestatement!('PRIVATE_PAGE_ONE：函数有输入范围。'); await r.runtime.flush();
await r.runtime.next('mainline');
assert.equal(r.course.page?.id, 'main-2');
r.runtime.recordRestatement!(r.course.progress.restatementDraft + '\nPRIVATE_PAGE_TWO：我还不理解边界。');
r.runtime.recordRestatement!(r.course.progress.restatementDraft + '\nPRIVATE_LATE_VOICE_ONE', 'main-1');
await r.runtime.flush();
assert.ok(pageRestatement(r.course.progress.restatementDraft, r.course.progress.restatementSpans!, 'main-1').includes('PRIVATE_LATE_VOICE_ONE'));
const relevant = r.course.currentFeedback!.restatement;
assert.ok(relevant.includes('PRIVATE_PAGE_TWO')); assert.ok(!relevant.includes('PRIVATE_PAGE_ONE')); assert.ok(!relevant.includes('PRIVATE_LATE_VOICE_ONE'));
await r.runtime.next('mainline');
const request = r.requests.filter(item => item.generation).at(-1)!.generation;
assert.ok(request.adaptation.restatement.includes('PRIVATE_PAGE_TWO')); assert.ok(!JSON.stringify(request).includes('PRIVATE_PAGE_ONE'));
checks.push('复述按输入页增量定位，迟到语音保留采集页；下一页仅取当前页反馈，不持续追加全局私人全文');

const beforeManual = r.course.pages!.length;
const current = r.course.pages!.find(page => page.id === r.course.page!.id)!;
const exactSelection = r.course.page!.body.slice(100, 1100);
await r.runtime.next('expansion', { pageHash: current.contentHash, text: exactSelection, before: '前文', after: '后文' });
assert.equal(r.course.page?.kind, 'expansion'); assert.equal(r.course.generation.scope?.text, exactSelection); assert.ok(exactSelection.length > 800);
assert.equal(r.course.pages!.length, beforeManual + 1);
await r.runtime.next('expansion'); assert.equal(r.course.pages!.length, beforeManual + 2);
const wrongBefore = r.course.pages!.length;
await r.runtime.next('expansion', { pageHash: 'outdated-version', text: '不属于当前页的选区' });
assert.equal(r.course.pages!.length, wrongBefore);
checks.push('显式补充绕过自动编排，精确保留超过800字的选区；主动再次补充是新意图，过期选区不生成或扣预算');

const budget = harness('budget', 20); await budget.runtime.start();
budget.runtime.saveAnswerDraft!('q1', { text: '', optionId: 'B' }); await budget.runtime.submitAnswers!(['q1']);
budget.route = 'mainline'; await budget.runtime.next();
assert.equal(budget.course.page?.id, 'main-2'); assert.equal(budget.course.generation.adaptation?.expansionAvailable, false);
await budget.runtime.next('mainline'); await budget.runtime.next('mainline');
assert.equal(budget.course.pages?.length, 4); assert.equal(budget.course.pages?.filter(page => page.kind === 'expansion').length, 0);
const beforeFinish = budget.calls; await budget.runtime.next(); assert.equal(budget.calls, beforeFinish);
checks.push('补充预算不能挤占预留主线；显式继续主线不变扩展，四页主线结束且无新需求不会继续生成');

const f = harness('finish'); f.count = 0; await f.runtime.start();
for (let i = 0; i < 3; i++) await f.runtime.next('mainline');
f.runtime.recordRestatement!('已理解这个关系，可以结束本次讲解。'); await f.runtime.flush();
f.route = 'finish'; await f.runtime.next();
assert.equal(f.course.pages?.length, 4); assert.equal(f.course.generation.status, 'ready'); assert.equal(f.course.currentFeedback?.fresh, false);
const finishCalls = f.calls; await f.runtime.next(); assert.equal(f.calls, finishCalls);
checks.push('主线后的新反馈可以由同一任务明确结束；不生成空页，消费反馈后再点也不重复请求模型');

const signals = harness('consumed-signals'); await signals.runtime.start();
signals.runtime.recordRestatement!('PRIVATE_ALREADY_CONSUMED：同一个输入可以得到多个不同输出。'); await signals.runtime.flush();
signals.route = 'expansion'; await signals.runtime.next(); await signals.runtime.navigate('main-1');
assert.equal(signals.course.currentFeedback?.fresh, false);
await signals.studyMutation({ kind: 'draft', drafts: { q2: { text: '3米' } } });
await signals.runtime.start(); await signals.studyMutation({ kind: 'submit', submissionId: 'pending-only', questionIds: ['q2'] });
await signals.runtime.start();
assert.equal(signals.course.currentFeedback?.fresh, false, 'a pending answer must not reactivate consumed prose');
assert.equal(signals.course.currentFeedback?.restatement, '');
await signals.studyMutation({ kind: 'grade', results: [{ attemptId: signals.study.attempts[0].id, judgment: correct }] });
await signals.runtime.start(); assert.equal(signals.course.currentFeedback?.fresh, true);
assert.equal(signals.course.currentFeedback?.restatement, ''); assert.equal(signals.course.currentFeedback?.answers.length, 1);
checks.push('反馈消费按复述内容和有效作答分别记账；新增未判题不会复活旧复述，新判定只传递新的有效证据');

const readonlyBefore = await f.store.listPublished(f.note.id);
const progressBefore = structuredClone(f.course.progress), callsBeforeRead = f.calls;
const viewed = await f.store.command({ op: 'read-page', projectNoteId: f.note.id, pageId: 'main-1' }, 7) as ProgressiveCourse;
assert.equal(viewed.page?.id, 'main-1');
const saved = await f.storage.load(f.note.id); assert.deepEqual(saved!.progress, progressBefore); assert.equal(f.calls, callsBeforeRead);
assert.deepEqual(await f.store.listPublished(f.note.id), readonlyBefore);
const shared = JSON.stringify(shareProgressiveTeaching(h.course));
assert.ok(shared.includes('referenceAnswer')); assert.ok(!/PRIVATE_|attempts|drafts|gradedAt|feedbackKey|submissionId/u.test(shared));
checks.push('教材和记录回看为只读，不改学习游标、不生成/分析/提交；公开投影有静态题目但没有个人作答、判定或复述');

const exiting = harness('exit-while-grading'); await exiting.runtime.start();
exiting.runtime.saveAnswerDraft!('q2', { text: '3米' }); exiting.holdAssessment = true;
const inFlight = exiting.runtime.submitAnswers!(['q2']);
for (let i = 0; i < 100 && !exiting.assessments; i++) await new Promise(resolve => setTimeout(resolve, 5));
assert.equal(exiting.assessments, 1);
assert.deepEqual(exiting.runtime.getSnapshot().studyBusyQuestions, ['q2']);
exiting.runtime.saveAnswerDraft!('q1', { text: '', optionId: 'B' }); await exiting.runtime.submitAnswers!(['q1']);
assert.equal(exiting.study.attempts.find(attempt => attempt.questionId === 'q1')?.judgment?.outcome, 'incorrect');
const stopAt = performance.now(); await exiting.runtime.stop(); assert.ok(performance.now() - stopAt < 500);
assert.equal(exiting.study.attempts.length, 2); assert.equal(exiting.study.attempts[0].judgment, undefined);
exiting.releaseAssessment(); await inFlight;
assert.equal(exiting.study.attempts[0].judgment, undefined, 'late remote result after stop is not applied');
await exiting.reenter(); assert.equal(exiting.assessments, 1); await exiting.runtime.retryGrading!();
assert.equal(exiting.study.attempts.length, 2); assert.equal(exiting.study.attempts[0].judgment?.outcome, 'correct');
checks.push('判题服务迟迟不返回时退出只等待实际保存，未判作答重进仍在，不自动重判；显式重试不重复提交');

// Pure range mapping covers edits and deletions, not only append-only transcription.
const envelope = response(h.course, 1, 'mainline').replace(/@@END\s*$/u, '');
const stopped = new ProgressiveStreamParser({ plan }); stopped.append(envelope);
assert.throws(() => stopped.finish(), /尚未完整/u);
assert.throws(() => stopped.finish({ finishReason: 'length' }), /尚未完整/u);
assert.equal(stopped.finish({ finishReason: 'stop' }).questions?.length, 1);
assert.ok(stopped.raw.endsWith('@@END\n'));
const brokenHook = new ProgressiveStreamParser({ plan }); brokenHook.append(envelope.slice(0, -8));
assert.throws(() => brokenHook.finish({ finishReason: 'stop' }));
const metadataRepair = new ProgressiveStreamParser({ plan, body });
metadataRepair.append(`@@LESSON\n@@CONCEPTS\n[]\n@@QUESTIONS\n${JSON.stringify(questions(1))}\n@@HOOK\n${JSON.stringify({ id: 'hook-repair', kind: 'reflection', prompt: '说明唯一性。' })}\n@@END`);
assert.equal(metadataRepair.finish().body, body);
assert.ok(!metadataRepair.finish().body.includes('@@CONCEPTS'));
checks.push('仅服务明确正常结束且正文、题目与钩子完整时兼容缺少结束标记；截断、异常EOF和未闭合JSON仍保留草稿');
checks.push('正文已完整时相邻协议标记可只补互动元数据；不把知识点JSON混入教材正文，不重复追加讲解');
let spans = editRestatementSpans('', '甲乙丙丁', [], 'main-1');
spans = editRestatementSpans('甲乙丙丁', '甲新乙丙丁', spans, 'main-2');
assert.equal(pageRestatement('甲新乙丙丁', spans, 'main-1'), '甲\n乙丙丁'); assert.equal(pageRestatement('甲新乙丙丁', spans, 'main-2'), '新');
assert.deepEqual(editRestatementSpans('甲新乙丙丁', '', spans, 'main-2'), []);
for (const item of [h, a, r, budget, f, late, exiting, signals]) { await item.runtime.stop(); item.runtime.dispose(); }
const proof = { status: 'passed', checks: checks.length, root, coverage: checks,
  model: 'deterministic injected streams and bounded assessment fixtures; no network, no user vault',
  artifacts: { courseDirectories: [h.directory, a.directory, r.directory, budget.directory, f.directory] } };
await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(proof, null, 2));
console.log(JSON.stringify({ status: proof.status, checks: proof.checks, root, coverage: checks }, null, 2));
