/** Real-store regression for nested/manual continuations and saved learning
 * records. Synthetic-only: no provider, network, real vault or UI. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ProgressiveLearningStore, progressivePageHash } from '../src/electron/progressiveLearningStore';
import { progressiveAutomaticExpansionAvailable, progressiveBudgetedPageCount } from '../src/services/progressiveLearning/budget';
import type { NoteItem } from '../src/types';
import type { ProgressiveBeginReply, ProgressiveCommand, ProgressiveCourse, ProgressiveMainline,
  ProgressiveQuestion, ProgressiveStudyMutation, ProgressiveStudyReply } from '../src/services/progressiveLearning/types';

const originalFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('Continuity acceptance must not call a model or network');
const root = await fs.mkdtemp(path.resolve('build/progressive-supplement-continuity-'));
const checks: string[] = [];
const at = new Date().toISOString(), id = 'synthetic-supplement-records';
const note: NoteItem = { id, title: '函数对应与输入范围', content: '合成学习目标。', noteType: 'project', projectRole: 'learning',
  tags: [], links: [], backlinks: [], createdAt: at, updatedAt: at,
  dueDates: [{ id: 'deadline', noteId: id, noteTitle: '函数对应与输入范围', taskText: '函数对应与输入范围', dueDate: '2026-11-10', estimatedMinutes: 15, completed: false, priority: 'medium' }] };
const plan: ProgressiveMainline = { title: '合成函数主线', objectives: ['解释唯一对应与输入范围'], pages: [
  { id: 'main-1', title: '唯一对应', objectives: ['判断一个输入只有一个输出'] },
  { id: 'main-2', title: '输入范围', objectives: ['先确定允许的输入'] },
] };
const questions: ProgressiveQuestion[] = [
  { id: 'q1', kind: 'choice', prompt: '同一个允许输入可以同时有两个不同输出吗？', objective: '识别唯一对应', conceptKeys: [], focus: 'concept',
    options: [{ id: 'A', text: '不能' }, { id: 'B', text: '可以' }], correctOptionId: 'A', referenceAnswer: '不能。', explanation: '每个允许输入应对应唯一输出。' },
  { id: 'q2', kind: 'application', prompt: '规则为二倍映射，输入2得到什么？', objective: '应用对应规则', conceptKeys: [], focus: 'calculation',
    referenceAnswer: '4', explanation: '二倍规则把2映到4。' },
];
const lesson = (label: string) => `${label}。判断对应关系时，先确定允许输入的范围，再检查同一个输入是否只有一个输出。不同输入可以得到相同输出，但同一个允许输入不能同时得到两个不同结果。规则若为二倍映射，允许输入2时得到4。这里保留正文、原题和已记录的学习活动，追加补充不会覆盖它们。`;
const dependencies = { readTarget: async () => ({ note, root: note, isLeaf: true }) };
let owner = 1, store = new ProgressiveLearningStore(root, dependencies);
const command = <T>(input: ProgressiveCommand): Promise<T> => store.command(input, owner) as Promise<T>;
const load = () => command<ProgressiveCourse>({ op: 'load', projectNoteId: id });
const begin = () => command<ProgressiveBeginReply>({ op: 'begin', projectNoteId: id });
const restart = () => { store.releaseOwner(owner); owner++; store = new ProgressiveLearningStore(root, dependencies); };
async function publish(reply: ProgressiveBeginReply, label: string) {
  return command<ProgressiveCourse>({ op: 'publish', lease: reply.lease!, teaching: {
    sequence: reply.course.generation.sequence + 1, plan, title: label, body: lesson(label), questions,
    hook: { id: 'hook-' + reply.course.generation.pageId, kind: 'reflection', prompt: '请用自己的话解释输入与唯一输出。' }, concepts: [],
  } });
}
async function next(course: ProgressiveCourse, intent: 'expansion' | 'mainline' | 'auto', requestId: string) {
  const source = course.page!;
  const descriptor = course.pages!.find(page => page.id === source.id)!;
  return command<ProgressiveBeginReply>({ op: 'next', projectNoteId: id, request: {
    environmentId: course.environmentId, courseId: course.id, expectedRevision: course.revision, requestId, intent, fromPageId: source.id,
    ...(intent === 'expansion' ? { scope: { text: source.body.slice(0, 100), pageHash: descriptor.contentHash, before: '选区前文', after: '选区后文' } } : {}),
  } });
}
async function study(pageId: string, mutation: ProgressiveStudyMutation) {
  const current = await command<ProgressiveCourse>({ op: 'read-page', projectNoteId: id, pageId });
  return command<ProgressiveStudyReply>({ op: 'study', projectNoteId: id, request: {
    environmentId: current.environmentId, courseId: current.id, pageId, expectedVersion: current.study!.version, mutation,
  } });
}
const projectDirectory = path.join(root, 'progressive-learning', 'project-' + createHash('sha256').update(id).digest('hex'));

try {
  let course = await publish(await begin(), '唯一对应');
  const mainHash = course.pages![0].contentHash, immutableBody = course.page!.body;
  assert.equal(course.budget.totalPageLimit, 3); assert.equal(course.plan!.pages.length, 2);
  await study('main-1', { kind: 'draft', drafts: {
    q1: { text: '我选择唯一输出', optionId: 'A' }, q2: { text: '尚未提交的计算', formulaDraft: '2\\times2' },
  } });
  const submitted = await study('main-1', { kind: 'submit', submissionId: 'preserved-submission', questionIds: ['q1'] });
  const attemptId = submitted.study.attempts[0].id;
  await study('main-1', { kind: 'grade', results: [{ attemptId, judgment: { outcome: 'correct', errorKind: 'none', referenceAnswer: '不能。', explanation: '允许输入应有唯一输出。' } }] });
  await study('main-1', { kind: 'view-explanation', attemptId });
  await study('main-1', { kind: 'feedback', feedback: { id: 'preserved-feedback', questionId: 'q1', attemptId, category: 'question', text: '请保留题目中的允许输入条件。' } });
  await study('main-1', { kind: 'verify-feedback', feedbackId: 'preserved-feedback', status: 'not-confirmed', explanation: '原题已经写明允许输入，保留原反馈及核实记录。' });
  course = await load();
  const restatement = '我理解同一个允许输入要对应唯一输出，不同输入可以得到相同输出。';
  const privateFields = { restatementDraft: restatement, restatementSpans: [{ pageId: 'main-1', start: 0, end: restatement.length }], summaryDraft: '已有学习总结，追加页面时保留。',
    questionDraft: '尚未新增的问题草稿', questions: [
      { id: 'learning-clue-answered', noteId: id, question: '同输入的唯一性是什么？', answer: '对应一个确定输出。', createdAt: at, answeredAt: at },
      { id: 'learning-clue-pending', noteId: id, question: '输入范围怎样判断？', createdAt: at },
    ] };
  course = await command<ProgressiveCourse>({ op: 'save-progress', projectNoteId: id, progress: { environmentId: course.environmentId, courseId: course.id,
    expectedProgressVersion: course.progress.version, patch: { ...privateFields, scrollTop: 731 } } });
  const initialBudget = structuredClone(course.budget), initialPlan = structuredClone(course.plan);
  const baseline = (await command<ProgressiveCourse>({ op: 'read-page', projectNoteId: id, pageId: 'main-1' })).study!;
  const baselineStudySummary = structuredClone(course.studyPages!.find(ref => ref.pageId === 'main-1'));
  const studyFile = path.join(projectDirectory, 'study', `main-1.${baseline.version}.json`);
  const studyBytes = await fs.readFile(studyFile, 'utf8');
  const initialPrivateProgress = structuredClone(privateFields);
  async function assertPreserved(label: string, expectedPrivate = initialPrivateProgress) {
    const now = await load();
    const selected = await command<ProgressiveCourse>({ op: 'read-page', projectNoteId: id, pageId: 'main-1' });
    assert.deepEqual(selected.study, baseline, label + ': original drafts, attempts, judgments, feedback and explanation views');
    assert.deepEqual(now.studyPages!.find(ref => ref.pageId === 'main-1'), baselineStudySummary, label + ': original study pointer');
    assert.equal(await fs.readFile(studyFile, 'utf8'), studyBytes, label + ': immutable study file');
    assert.equal(selected.page!.body, immutableBody); assert.equal(progressivePageHash(selected.page!), mainHash);
    assert.equal(now.pages!.find(ref => ref.id === 'main-1')!.contentHash, mainHash);
    assert.deepEqual(now.budget, initialBudget); assert.deepEqual(now.plan, initialPlan);
    for (const key of Object.keys(expectedPrivate) as Array<keyof typeof expectedPrivate>) assert.deepEqual(now.progress[key], expectedPrivate[key], label + ': ' + key);
  }
  assert.equal(baseline.attempts.length, 1); assert.equal(baseline.attempts[0].judgment!.outcome, 'correct');
  assert.equal(baseline.feedback[0].status, 'not-confirmed'); assert.equal(baseline.explanationViews!.length, 1);
  assert.equal(baseline.drafts.q2.formulaDraft, '2\\times2');
  await assertPreserved('baseline');
  checks.push('真实学习接口保存选择作答、判定、已读解析、反馈及核实，保留另一题未提交的文字/公式草稿和学习问题');

  const first = await next(course, 'expansion', 'manual-first');
  assert.equal(first.course.generation.originScrollTop, 731);
  course = await publish(first, '第一层补充');
  await assertPreserved('first manual');
  let previousId = course.page!.id;
  const nested = await next(course, 'expansion', 'manual-nested');
  assert.equal(nested.course.generation.fromPageId, previousId);
  assert.equal(nested.course.generation.scope!.pageHash, course.pages!.find(p => p.id === previousId)!.contentHash);
  assert.equal(nested.course.generation.previousTeaching!.title, '第一层补充');
  course = await publish(nested, '补充页再次补充');
  assert.equal(course.page!.parentPageId, 'main-1'); assert.equal(course.page!.manualExpansion, true);
  await assertPreserved('nested manual');
  checks.push('从补充页再次补充时保留真实来源页、选区版本与衔接标题，目录归属原主线，已有学习记录逐项不变');

  previousId = course.page!.id;
  const interrupted = await next(course, 'expansion', 'manual-interrupted');
  const prefix = lesson('中断补充').slice(0, 120);
  await command({ op: 'checkpoint', lease: interrupted.lease!, checkpoint: { sequence: 1, plan, rawDraft: '@@LESSON\n' + prefix, bodyDraft: prefix } });
  await command({ op: 'interrupt', lease: interrupted.lease!, error: '合成断流，留待重启续写' });
  restart(); const resumed = await begin();
  assert.equal(resumed.course.generation.pageId, interrupted.course.generation.pageId);
  assert.equal(resumed.course.generation.requestId, 'manual-interrupted');
  assert.equal(resumed.course.generation.fromPageId, previousId); assert.equal(resumed.course.generation.manualExpansion, true);
  assert.equal(resumed.course.generation.bodyDraft, prefix);
  course = await publish(resumed, '重启后续写完成');
  await assertPreserved('restart interrupted manual');
  checks.push('补充页生成中断后重建存储实例，沿原请求和原页续写，免预算属性及原学习数据保留');

  for (let i = 0; i < 4; i++) {
    const before = course.page!.id, beforeCount = course.pages!.length;
    restart(); course = await load(); assert.equal(course.page!.id, before);
    const request = await next(course, 'expansion', 'after-ready-restart-' + i);
    assert.notEqual(request.course.generation.pageId, before);
    assert.equal(request.course.generation.fromPageId, before);
    course = await publish(request, '退出重启后主动新增 ' + i);
    assert.equal(course.pages!.length, beforeCount + 1); assert.equal(course.page!.manualExpansion, true);
    assert.equal(progressiveBudgetedPageCount(course.pages), 1); assert.equal(progressiveAutomaticExpansionAvailable(course), true);
    await assertPreserved('new manual after restart ' + i);
  }
  assert.ok(course.pages!.length > course.budget.totalPageLimit);
  checks.push('完成页退出重启后可反复新增独立补充请求，超过总页数预算仍可继续，主线与自动补充余额不被消耗');

  // A fresh, page-scoped restatement may drive one automatic detour. Appending
  // it must preserve the older mainline restatement and all saved study data.
  const appendFeedback = async (state: ProgressiveCourse, text: string) => {
    const old = state.progress.restatementDraft, nextText = old + '\n' + text;
    const spans = [...(state.progress.restatementSpans || []), { pageId: state.page!.id, start: old.length + 1, end: nextText.length }];
    return command<ProgressiveCourse>({ op: 'save-progress', projectNoteId: id, progress: { environmentId: state.environmentId, courseId: state.id,
      expectedProgressVersion: state.progress.version, patch: { restatementDraft: nextText, restatementSpans: spans } } });
  };
  course = await appendFeedback(course, '此补充中的条件还需要一个反例来帮助理解。');
  const afterFeedbackPrivate = { ...initialPrivateProgress, restatementDraft: course.progress.restatementDraft, restatementSpans: structuredClone(course.progress.restatementSpans!) };
  const auto = await next(course, 'auto', 'one-automatic-supplement');
  assert.equal(auto.course.generation.manualExpansion, undefined);
  const routed = await command<ProgressiveBeginReply>({ op: 'route', lease: auto.lease!, route: { kind: 'expansion', reason: '使用唯一剩余自动补充额度' } });
  course = await publish(routed, '自动补充只用一个额度');
  assert.equal(course.page!.manualExpansion, undefined); assert.equal(progressiveBudgetedPageCount(course.pages), 2);
  assert.equal(progressiveAutomaticExpansionAvailable(course), false);
  await assertPreserved('automatic detour', afterFeedbackPrivate);
  course = await appendFeedback(course, '自动补充之后还有一个新的疑问，但不能挤占剩余主线额度。');
  const afterAutoPrivate = { ...initialPrivateProgress, restatementDraft: course.progress.restatementDraft, restatementSpans: structuredClone(course.progress.restatementSpans!) };
  const exhausted = await next(course, 'auto', 'automatic-budget-exhausted');
  await assert.rejects(command({ op: 'route', lease: exhausted.lease!, route: { kind: 'expansion', reason: '不允许第二次自动补充' } }), /预算/u);
  const mainline = await command<ProgressiveBeginReply>({ op: 'route', lease: exhausted.lease!, route: { kind: 'mainline', reason: '继续原先预留的第二页主线' } });
  course = await publish(mainline, '输入范围');
  assert.equal(course.page!.id, 'main-2'); assert.equal(course.page!.manualExpansion, undefined);
  assert.equal(progressiveBudgetedPageCount(course.pages), 3); assert.equal(progressiveAutomaticExpansionAvailable(course), false);
  await assertPreserved('mainline after exhausted auto', afterAutoPrivate);
  checks.push('多次手动补充后仍恰好保留一个自动补充额度与第二页主线；自动页不继承手动豁免，额度耗尽后不能继续自动扩展');

  restart(); course = await load();
  course = await publish(await next(course, 'expansion', 'manual-after-completed-mainline'), '全部主线完成后仍可新增');
  assert.equal(course.page!.parentPageId, 'main-2'); assert.equal(course.page!.manualExpansion, true);
  await assertPreserved('manual after completed mainline', afterAutoPrivate);
  const finalMainOne = await command<ProgressiveCourse>({ op: 'read-page', projectNoteId: id, pageId: 'main-1' });
  const report = { status: 'passed', root, remoteCalls: 0, checks, pageCount: course.pages!.length,
    manualPages: course.pages!.filter(page => page.manualExpansion).length, automaticBudgetedPages: progressiveBudgetedPageCount(course.pages), budget: course.budget,
    preservedMainlineHash: mainHash, originalStudyVersion: baseline.version, finalStudyVersion: finalMainOne.study!.version,
    originalAttempts: baseline.attempts.length, finalAttempts: finalMainOne.study!.attempts.length,
    originalFeedback: baseline.feedback.length, finalFeedback: finalMainOne.study!.feedback.length, studyFileBytesUnchanged: true };
  await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, root, checks: checks.length, pageCount: report.pageCount, remoteCalls: 0 }));
} finally { globalThis.fetch = originalFetch; }
