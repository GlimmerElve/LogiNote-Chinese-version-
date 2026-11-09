/** Offline regression: bounded diagram patches and actual durable page storage.
 * Synthetic lessons only. No model, real vault or UI is involved. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ProgressiveLearningStore } from '../src/electron/progressiveLearningStore';
import { atomicWriteTextFile } from '../src/electron/atomicWrite';
import { readProgressiveDiagram, patchProgressiveDiagram } from '../src/services/progressiveLearning/diagramEditing';
import { shareProgressiveTeaching } from '../src/services/progressiveLearning/share';
import type { ProgressiveBeginReply, ProgressiveCommand, ProgressiveCourse, ProgressiveMainline, ProgressiveQuestion,
  ProgressiveStudyReply } from '../src/services/progressiveLearning/types';
import type { NoteItem } from '../src/types';

const originalFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('Diagram editing must not request a model, a source or the network');
const root = await fs.mkdtemp(path.resolve('build/progressive-diagram-editing-'));
const checks: string[] = [];
const firstCode = 'flowchart LR\nX["第一张保持原样"] --> Y["结论保留"]';
const secondCode = 'flowchart TD\nA["给定集合"] --> B{"每个输入都有输出吗"}\nB -- "是" --> C["是函数"]';
const source = '# 函数判断\n\n正文也有“每个输入都有输出吗”这句话，不能修改这段正文。\n\n'
  + '```mermaid\n' + firstCode + '\n```\n\n'
  + '## 第二图的条件\n\n给定 $f:A\\to B$，每个输入须在 $B$ 内有且只有一个输出。[S1]\n\n'
  + '~~~mermaid\n' + secondCode + '\n~~~\n\n'
  + '图后文字及公式 $x^2$、引用[S1]均保持原样。\n\n## 练习\n\n说明为什么要核对输出是否落在陪域内。';
const edits = [{ oldText: '每个输入都有输出吗', newText: '每个输入在B内都有输出吗' }];
const expectedCode = secondCode.replace(edits[0].oldText, edits[0].newText);
const expectedBody = source.replace('~~~mermaid\n' + secondCode + '\n~~~', '~~~mermaid\n' + expectedCode + '\n~~~');
const at = '2026-11-07T00:00:00.000Z';
const target: NoteItem = { id: 'diagram-fixture', title: '函数与陪域', noteType: 'project', projectRole: 'learning', content: '独立合成目标。',
  tags: [], links: [], backlinks: [], dueDates: [], createdAt: at, updatedAt: at };
let failCommit = false, pageChanges = 0, derivedChanges = 0;
const deps = {
  readTarget: async (id: string) => { assert.equal(id, target.id); return { note: target, root: target, isLeaf: true }; },
  write: async (file: string, text: string) => {
    if (failCommit && file.endsWith('course.json')) { failCommit = false; throw Error('Injected course commit failure'); }
    await atomicWriteTextFile(file, text, { allowCopyFallback: false });
  },
  pageChanged: () => { pageChanges++; },
  changed: () => { derivedChanges++; },
};
const courseFile = path.join(root, 'progressive-learning',
  `project-${createHash('sha256').update(target.id).digest('hex')}`, 'course.json');
const command = async <T>(store: ProgressiveLearningStore, input: ProgressiveCommand, owner = 1): Promise<T> =>
  await store.command(input, owner) as T;
const load = (store: ProgressiveLearningStore) => command<ProgressiveCourse>(store, { op: 'load', projectNoteId: target.id });
const plan: ProgressiveMainline = { title: '合成函数讲解', objectives: ['核对函数条件'], pages: [
  { id: 'main-1', title: '输入输出', objectives: ['说明唯一对应'] },
  { id: 'main-2', title: '陪域条件', objectives: ['图文条件一致'] },
] };
const hook = { id: 'reflection', kind: 'reflection' as const, prompt: '请解释输入集合与输出集合的条件。' };
const question: ProgressiveQuestion = { id: 'q1', kind: 'application', prompt: '输出落在陪域之外时，是否构成所声明的映射？',
  objective: '核对陪域', conceptKeys: [], focus: 'concept', referenceAnswer: '不构成该映射。', explanation: '实际输出必须属于所指定的陪域。' };

try {
  const read = readProgressiveDiagram(source, 1);
  assert.equal(read.diagramIndex, 1); assert.equal(read.diagramCount, 2); assert.equal(read.code, secondCode);
  assert.ok(read.before.length <= 600 && read.after.length <= 600);
  assert.ok(!('body' in read), 'reader returns a bounded diagram packet, not an entire lesson');
  const bounded = readProgressiveDiagram('FAR_BEFORE_SENTINEL' + '前'.repeat(1000) + '\n\n```mermaid\n' + secondCode
    + '\n```\n\n' + '后'.repeat(1000) + 'FAR_AFTER_SENTINEL');
  assert.ok(!bounded.before.includes('FAR_BEFORE_SENTINEL') && !bounded.after.includes('FAR_AFTER_SENTINEL'));
  assert.equal(patchProgressiveDiagram(source, 1, edits), expectedBody);
  assert.equal(readProgressiveDiagram(expectedBody, 0).code, firstCode);
  const windowsBody = '## CRLF\r\n\r\n~~~~mermaid\r\n' + secondCode.replaceAll('\n', '\r\n') + '\r\n~~~~\r\n\r\n后文保留。';
  const windowsPatched = patchProgressiveDiagram(windowsBody, 0, edits);
  assert.equal(windowsPatched, windowsBody.replace('每个输入都有输出吗', '每个输入在B内都有输出吗'));
  for (const fence of ['``` mermaid', '~~~ mermaid', '```\tmermaid']) {
    const close = fence[0].repeat(3), spaced = `${fence}\n${secondCode}\n${close}`;
    assert.equal(readProgressiveDiagram(spaced).code, secondCode);
    assert.equal(patchProgressiveDiagram(spaced, 0, edits), `${fence}\n${expectedCode}\n${close}`);
  }
  assert.throws(() => readProgressiveDiagram(source, -1));
  assert.throws(() => readProgressiveDiagram(source, 2));
  assert.throws(() => readProgressiveDiagram(source, .5));
  assert.throws(() => readProgressiveDiagram('```text\n```mermaid\nflowchart TD\nA-->B\n```\n```', 0));
  assert.throws(() => readProgressiveDiagram('> ```mermaid\n> flowchart TD\n> A-->B\n> ```', 0));
  checks.push('同页精确选中第二图；仅有界源码与邻近正文进入修复上下文；围栏、CRLF和所有图外字节保留');

  const repeated = '```mermaid\nflowchart LR\nA["重复"] --> B["重复"]\n```';
  assert.throws(() => patchProgressiveDiagram(repeated, 0, [{ oldText: '重复', newText: '修订' }]));
  assert.throws(() => patchProgressiveDiagram(source, 1, [edits[0], { oldText: '每个输入都', newText: '范围' }]));
  const swap = '```mermaid\nflowchart LR\nA["节点甲"] --> B["节点乙"]\n```';
  const swapped = patchProgressiveDiagram(swap, 0, [{ oldText: '节点甲', newText: '节点乙' }, { oldText: '节点乙', newText: '节点丙' }]);
  assert.equal(readProgressiveDiagram(swapped, 0).code, 'flowchart LR\nA["节点乙"] --> B["节点丙"]', 'all patches resolve against the original code, not previous replacements');
  for (const bad of [
    [], [{ oldText: '', newText: '修改' }], [{ oldText: '不存在的节点', newText: '修改' }],
    [{ oldText: '每个输入都有输出吗', newText: '每个输入都有输出吗' }],
    [{ oldText: '每个输入都有输出吗', newText: '\n~~~\n这里变成正文\n~~~mermaid\n' }],
    [{ oldText: '每个输入都有输出吗', newText: '<script>alert(1)</script>' }],
    [{ oldText: '每个输入都有输出吗', newText: 'https://example.invalid' }],
    [{ oldText: '每个输入都有输出吗', newText: '修改\nclick A callback' }],
    [{ oldText: 'x'.repeat(501), newText: '修改' }],
    [{ oldText: '每个输入都有输出吗', newText: '字'.repeat(801) }],
    Array.from({ length: 5 }, () => edits[0]),
  ]) assert.throws(() => patchProgressiveDiagram(source, 1, bad), JSON.stringify(bad).slice(0, 160));
  const longCode = 'flowchart TD\nA["' + '字'.repeat(5000) + '"] --> B["终点"]';
  assert.throws(() => readProgressiveDiagram('```mermaid\n' + longCode + '\n```', 0));
  checks.push('重复/重叠/空补丁、原图不匹配、数量及长度上限、围栏/HTML/外链/回调注入均拒绝；补丁不会链式误改');

  const store = new ProgressiveLearningStore(root, deps);
  const started = await command<ProgressiveBeginReply>(store, { op: 'begin', projectNoteId: target.id });
  await assert.rejects(command(store, { op: 'patch-diagram', projectNoteId: target.id, environmentId: started.course.environmentId,
    courseId: started.course.id, pageId: 'main-1', expectedHash: '0'.repeat(64), diagramIndex: 0, replacements: edits }));
  let course = await command<ProgressiveCourse>(store, { op: 'publish', lease: started.lease!, teaching: {
    sequence: 1, plan, title: plan.pages[0].title, body: '第一个已发布页面用于说明输入到输出的唯一对应关系。它的内容和版本必须不受第二页图示修补影响。', hook,
  } });
  const firstHash = course.pages![0].contentHash;
  const firstBody = course.page!.body;
  const next = await command<ProgressiveBeginReply>(store, { op: 'next', projectNoteId: target.id, request: {
    environmentId: course.environmentId, courseId: course.id, expectedRevision: course.revision,
    requestId: 'second-diagram-page', intent: 'mainline', fromPageId: 'main-1',
  } });
  course = await command<ProgressiveCourse>(store, { op: 'publish', lease: next.lease!, teaching: {
    sequence: 1, plan, title: plan.pages[1].title, body: source, hook, questions: [question],
  } });
  const drafted = await command<ProgressiveStudyReply>(store, { op: 'study', projectNoteId: target.id, request: {
    environmentId: course.environmentId, courseId: course.id, pageId: 'main-2', expectedVersion: course.study!.version,
    mutation: { kind: 'draft', drafts: { q1: { text: 'PRIVATE_ANSWER_DRAFT' } } },
  } });
  course = drafted.course;
  course = await command<ProgressiveCourse>(store, { op: 'save-progress', projectNoteId: target.id, progress: {
    environmentId: course.environmentId, courseId: course.id, expectedProgressVersion: course.progress.version,
    patch: { scrollTop: 447, restatementDraft: 'PRIVATE_RESTATEMENT', summaryDraft: 'PRIVATE_SUMMARY' },
  } });
  const before = structuredClone(course);
  const originalDescriptor = before.pages!.find(page => page.id === 'main-2')!;
  const originalDisk = await fs.readFile(courseFile, 'utf8');
  const notificationsBefore = { pageChanges, derivedChanges };
  const patch: Extract<ProgressiveCommand, { op: 'patch-diagram' }> = { op: 'patch-diagram', projectNoteId: target.id,
    environmentId: before.environmentId, courseId: before.id, pageId: 'main-2', expectedHash: originalDescriptor.contentHash,
    diagramIndex: 1, replacements: edits };
  for (const invalid of [
    { ...patch, expectedHash: '0'.repeat(64) }, { ...patch, environmentId: 'stale-environment' },
    { ...patch, courseId: 'stale-course' }, { ...patch, diagramIndex: 30 }, { ...patch, replacements: [] },
  ]) {
    await assert.rejects(command(store, invalid));
    assert.equal(await fs.readFile(courseFile, 'utf8'), originalDisk);
  }
  assert.equal(pageChanges, notificationsBefore.pageChanges);
  failCommit = true;
  await assert.rejects(command(store, patch), /Injected course commit failure/u);
  assert.equal(await fs.readFile(courseFile, 'utf8'), originalDisk);
  assert.equal(pageChanges, notificationsBefore.pageChanges, 'failed writes do not publish a page-change event');
  const afterFailure = await load(new ProgressiveLearningStore(root, deps));
  assert.equal(afterFailure.page!.body, source, 'an orphan immutable page cannot change the published pointer');
  assert.equal(afterFailure.pages!.find(page => page.id === 'main-2')!.contentHash, originalDescriptor.contentHash);
  const repaired = await command<ProgressiveCourse>(store, patch);
  assert.equal(repaired.id, before.id); assert.equal(repaired.page!.body, expectedBody);
  assert.deepEqual(repaired.generation, before.generation, 'diagram repair does not start, reset or replace generation');
  assert.deepEqual(repaired.budget, before.budget); assert.deepEqual(repaired.plan, before.plan);
  assert.deepEqual(repaired.progress, before.progress, 'scroll, private drafts and progress version remain unchanged');
  assert.deepEqual(repaired.study, before.study); assert.deepEqual(repaired.studyPages, before.studyPages);
  assert.deepEqual(repaired.page!.questions, before.page!.questions); assert.deepEqual(repaired.page!.hook, before.page!.hook);
  assert.equal(repaired.pages!.find(page => page.id === 'main-1')!.contentHash, firstHash);
  assert.notEqual(repaired.pages!.find(page => page.id === 'main-2')!.contentHash, originalDescriptor.contentHash);
  assert.equal(pageChanges, notificationsBefore.pageChanges + 1); assert.equal(derivedChanges, notificationsBefore.derivedChanges + 1);
  await assert.rejects(command(store, patch), 'a stale retry cannot apply the patch twice');
  assert.equal(pageChanges, notificationsBefore.pageChanges + 1);
  checks.push('真实存储版本保护与提交失败恢复；仅目标图/页哈希更新，正文、题目、主线、预算、生成任务、私人作答和阅读位置保留');

  const restarted = new ProgressiveLearningStore(root, deps);
  const reopened = await load(restarted);
  assert.equal(reopened.page!.body, expectedBody); assert.deepEqual(reopened.generation, before.generation);
  assert.equal(reopened.progress.scrollTop, 447); assert.equal(reopened.study!.drafts.q1.text, 'PRIVATE_ANSWER_DRAFT');
  const first = await command<ProgressiveCourse>(restarted, { op: 'read-page', projectNoteId: target.id, pageId: 'main-1' });
  assert.equal(first.page!.body, firstBody); assert.equal(first.pages![0].contentHash, firstHash);
  const shared = JSON.stringify(shareProgressiveTeaching(reopened));
  assert.ok(shared.includes('每个输入在B内都有输出吗'));
  assert.ok(!shared.includes('PRIVATE_')); assert.ok(!shared.includes('writingPolicy'));
  checks.push('重启读取修补后的不可变页；其它页正文/哈希和旧任务策略保持；Markdown分享只投影已校订图示及教学内容');

  const receipt = { status: 'passed', root, remoteCalls: 0, syntheticOnly: true, checks };
  await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
} finally { globalThis.fetch = originalFetch; }
