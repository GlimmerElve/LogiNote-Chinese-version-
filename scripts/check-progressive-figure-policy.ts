/** Offline regression of optional interaction placement and frozen old requests. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ProgressiveLearningStore } from '../src/electron/progressiveLearningStore';
import { progressiveGenerationRequest, PROGRESSIVE_GENERATION_PROMPT, PROGRESSIVE_ADAPTATION_PROMPT } from '../src/services/progressiveLearning/generation';
import { progressiveWritingGuidance } from '../src/services/progressiveLearning/writingGuidance';
import { TEXTBOOK_INTERACTIVE_FIGURE_GUIDANCE, TEXTBOOK_INTERACTIVE_FIGURE_GUIDANCE_V2,
  TEXTBOOK_INTERACTIVE_FIGURE_GUIDANCE_V3, TEXTBOOK_RICH_LAYOUT_GUIDANCE, TEXTBOOK_RICH_LAYOUT_GUIDANCE_V8 } from '../src/services/textbook/richLayoutGuidance';
import { shareProgressiveTeaching, sharedTeachingMarkdown } from '../src/services/progressiveLearning/share';
import { findInteractiveFigure } from '../src/services/textbook/interactiveFigureMarker';
import type { NoteItem } from '../src/types';
import type { ProgressiveBeginReply, ProgressiveCourse, ProgressiveCommand, ProgressiveMainline } from '../src/services/progressiveLearning/types';

const originalFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('Figure policy tests never call models or the network');
const root = await fs.mkdtemp(path.resolve('build/progressive-figure-policy-'));
const checks: string[] = [], notes = new Map<string, NoteItem>();
const at = new Date().toISOString();
const dependencies = { readTarget: async (id: string) => { const note = notes.get(id)!; return { note, root: note, isLeaf: true }; } };
let store = new ProgressiveLearningStore(root, dependencies), owner = 1;
const command = <T>(input: ProgressiveCommand): Promise<T> => store.command(input, owner) as Promise<T>;
const begin = (projectNoteId: string) => command<ProgressiveBeginReply>({ op: 'begin', projectNoteId });
const stateFile = (id: string) => path.join(root, 'progressive-learning', `project-${createHash('sha256').update(id).digest('hex')}`, 'course.json');
const note = (id: string) => {
  const value: NoteItem = { id, title: '位移与运动方向', content: '保留原学习目标。', noteType: 'project', projectRole: 'learning', tags: [], links: [], backlinks: [], createdAt: at, updatedAt: at,
    dueDates: [{ id: 'deadline', noteId: id, noteTitle: '位移与运动方向', taskText: '判断位置和运动方向', dueDate: '2026-11-12', estimatedMinutes: 10, completed: false, priority: 'medium' }] };
  notes.set(id, value); return value;
};
const plan: ProgressiveMainline = { title: '区分位置与运动', objectives: ['根据状态判断位置与运动'], pages: [
  { id: 'main-1', title: '位置与方向', objectives: ['区分位置与运动方向'] }, { id: 'main-2', title: '速率的变化', objectives: ['根据力与速度的方向判断速率变化'] }] };
const body = '先区分位置与运动方向。同一位置可以在不同时刻被两次经过，两次经过的运动方向可以相反；只有给出运动阶段才能判断速度的方向。';
const hook = { id: 'hook-main-1', kind: 'reflection' as const, prompt: '同一位置为什么能有两个运动方向？' };
const restart = () => { store.releaseOwner(owner++); store = new ProgressiveLearningStore(root, dependencies); };
const legacyPrompt = (course: ProgressiveCourse) => (course.generation.bodyDraft ? PROGRESSIVE_GENERATION_PROMPT : PROGRESSIVE_GENERATION_PROMPT
  .replace(TEXTBOOK_RICH_LAYOUT_GUIDANCE, TEXTBOOK_RICH_LAYOUT_GUIDANCE_V8)
  .replace(TEXTBOOK_INTERACTIVE_FIGURE_GUIDANCE, TEXTBOOK_INTERACTIVE_FIGURE_GUIDANCE_V2)
  .replace('没有授权图片指针时不用textbook-image，不另行请求绘图模型。', '没有授权图片指针时不用textbook-image；本次正文不包含交互图代码。'))
  + PROGRESSIVE_ADAPTATION_PROMPT + progressiveWritingGuidance(course.generation.writingPolicy);

try {
  assert.ok(TEXTBOOK_INTERACTIVE_FIGURE_GUIDANCE_V3.length <= 320);
  for (const phrase of ['0–1', '上限不是配额', '静态图', '动态演示', '逐步演进', '对照观察', '不强套预测检查', '不额外规划请求'])
    assert.ok(TEXTBOOK_INTERACTIVE_FIGURE_GUIDANCE_V3.includes(phrase), phrase);
  assert.ok(!TEXTBOOK_INTERACTIVE_FIGURE_GUIDANCE_V3.includes('优先'));
  checks.push('新指导不把卡片上限当配额，以新增教学价值决定0–1个；按需选演示、步骤或对照，保持提示词320字以内');

  const target = note('new-policy');
  const first = await begin(target.id);
  assert.equal(first.course.generation.figurePolicy, 1);
  const fresh = progressiveGenerationRequest(first.course);
  assert.ok(fresh.systemPromptOverride!.includes(TEXTBOOK_INTERACTIVE_FIGURE_GUIDANCE_V3));
  assert.ok(!fresh.systemPromptOverride!.includes(TEXTBOOK_INTERACTIVE_FIGURE_GUIDANCE_V2));
  const oldCopy = structuredClone(first.course); delete oldCopy.generation.figurePolicy;
  const oldRequest = progressiveGenerationRequest(oldCopy);
  assert.equal(fresh.userInput, oldRequest.userInput, 'No new model metadata or planning request');
  assert.equal(oldRequest.systemPromptOverride, legacyPrompt(oldCopy));
  assert.equal(fresh.maxTokensOverride, oldRequest.maxTokensOverride); assert.equal(fresh.thinkingMode, oldRequest.thinkingMode);
  assert.ok(fresh.systemPromptOverride!.length - oldRequest.systemPromptOverride!.length <= 160);
  await command({ op: 'checkpoint', lease: first.lease!, checkpoint: { sequence: 1, plan, rawDraft: '@@LESSON\n' + body, bodyDraft: body } });
  await command({ op: 'interrupt', lease: first.lease!, error: 'synthetic interruption' }); restart();
  const resumed = await begin(target.id);
  assert.equal(resumed.course.generation.requestId, first.course.generation.requestId);
  assert.equal(resumed.course.generation.figurePolicy, 1); assert.equal(resumed.course.generation.bodyDraft, body);
  assert.ok(progressiveGenerationRequest(resumed.course).systemPromptOverride!.includes(TEXTBOOK_INTERACTIVE_FIGURE_GUIDANCE_V3),
    'New marked jobs retain V3 even during body continuation');
  checks.push('新begin冻结策略；带正文检查点重启仍同请求与V3，不扩大输出协议或模型请求');

  let ready = await command<ProgressiveCourse>({ op: 'publish', lease: resumed.lease!, teaching: { sequence: 2, plan,
    title: plan.pages[0].title, body, concepts: [], questions: [], hook } });
  const originalHash = ready.pages![0].contentHash, originalBudget = structuredClone(ready.budget);
  for (const intent of ['expansion', 'mainline'] as const) {
    const next = await command<ProgressiveBeginReply>({ op: 'next', projectNoteId: target.id, request: { environmentId: ready.environmentId,
      courseId: ready.id, expectedRevision: ready.revision, requestId: 'next-policy-' + intent, intent, fromPageId: ready.page!.id } });
    assert.equal(next.course.generation.figurePolicy, 1);
    assert.deepEqual(next.course.budget, originalBudget); assert.equal(next.course.pages![0].contentHash, originalHash);
    if (intent === 'expansion') { assert.equal(next.course.generation.manualExpansion, true); assert.equal(next.course.generation.supplementDesign?.version, 1); }
    const expectedTitle = intent === 'expansion' ? '用往返过程区分位置与方向' : plan.pages[1].title;
    ready = await command<ProgressiveCourse>({ op: 'publish', lease: next.lease!, teaching: { sequence: 1, plan, title: expectedTitle,
      body, concepts: [], questions: [], hook: { ...hook, id: 'hook-' + next.course.generation.pageId } } });
  }
  const shared = shareProgressiveTeaching(ready);
  assert.ok(!JSON.stringify(shared).includes('figurePolicy')); assert.ok(sharedTeachingMarkdown(shared).includes(body));
  assert.equal(findInteractiveFigure('> **交互探索**\n>\n> 逐步移动滑块，观察相同位置上两次经过的速度方向。'), '逐步移动滑块，观察相同位置上两次经过的速度方向。');
  checks.push('新主线与主动补充均带新策略，原页哈希/主线预算/补充设计不变；同Markdown标记及分享保持兼容');

  for (const state of ['empty', 'plan', 'body'] as const) {
    const oldTarget = note('legacy-' + state);
    const seeded = await begin(oldTarget.id);
    if (state !== 'empty') await command({ op: 'checkpoint', lease: seeded.lease!, checkpoint: { sequence: 1, plan,
      rawDraft: state === 'plan' ? '@@PLAN\n' + JSON.stringify(plan) : '@@LESSON\n' + body, bodyDraft: state === 'body' ? body : '' } });
    await command({ op: 'interrupt', lease: seeded.lease! }); restart();
    const file = stateFile(oldTarget.id), disk = JSON.parse(await fs.readFile(file, 'utf8'));
    delete disk.generation.figurePolicy;
    await fs.writeFile(file, JSON.stringify(disk));
    const old = await begin(oldTarget.id);
    const request = progressiveGenerationRequest(old.course);
    assert.equal(old.course.generation.figurePolicy, undefined); assert.equal(request.systemPromptOverride, legacyPrompt(old.course));
    await command({ op: 'interrupt', lease: old.lease! }); restart();
    const again = await begin(oldTarget.id);
    assert.deepEqual(progressiveGenerationRequest(again.course), request);
    assert.equal(again.course.generation.requestId, seeded.course.generation.requestId);
    assert.equal(again.course.generation.rawDraft, old.course.generation.rawDraft);
    assert.equal(again.course.generation.bodyDraft, old.course.generation.bodyDraft);
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).generation.figurePolicy, undefined);
    store.releaseOwner(owner);
  }
  checks.push('旧无标记的空/仅主线/已有正文任务逐字保留原提示词及输入，重启不自动升级、原请求与草稿不变');

  const legacyFinished = await begin('legacy-body');
  const legacyReady = await command<ProgressiveCourse>({ op: 'publish', lease: legacyFinished.lease!, teaching: {
    sequence: legacyFinished.course.generation.sequence + 1, plan, title: plan.pages[0].title, body, concepts: [], questions: [], hook } });
  const legacyNext = await command<ProgressiveBeginReply>({ op: 'next', projectNoteId: 'legacy-body', request: {
    environmentId: legacyReady.environmentId, courseId: legacyReady.id, expectedRevision: legacyReady.revision,
    requestId: 'new-page-after-legacy', intent: 'mainline', fromPageId: 'main-1' } });
  assert.equal(legacyNext.course.generation.figurePolicy, 1);
  assert.equal(legacyNext.course.pages![0].contentHash, legacyReady.pages![0].contentHash);
  store.releaseOwner(owner);
  const resetTarget = note('reset-policy'), resetSeed = await begin(resetTarget.id);
  const resetReady = await command<ProgressiveCourse>({ op: 'publish', lease: resetSeed.lease!, teaching: {
    sequence: 1, plan: { ...plan, pages: [plan.pages[0]] }, title: plan.pages[0].title, body, concepts: [], questions: [], hook } });
  const reset = await command<ProgressiveCourse>({ op: 'delete-page', projectNoteId: resetTarget.id,
    environmentId: resetReady.environmentId, courseId: resetReady.id, pageId: 'main-1', expectedHash: resetReady.pages![0].contentHash });
  assert.notEqual(reset.generation.requestId, resetSeed.course.generation.requestId);
  assert.equal(reset.generation.figurePolicy, 1); assert.equal(reset.generation.bodyDraft, '');
  checks.push('旧课程完成后明确新增页及删除全部页后的新请求才启用V3，既有已发布页内容哈希不变');

  const invalidTarget = note('invalid-policy'); const invalid = await begin(invalidTarget.id);
  await command({ op: 'interrupt', lease: invalid.lease! }); restart();
  const invalidFile = stateFile(invalidTarget.id), corrupted = JSON.parse(await fs.readFile(invalidFile, 'utf8'));
  corrupted.generation.figurePolicy = 2; await fs.writeFile(invalidFile, JSON.stringify(corrupted));
  const before = await fs.readFile(invalidFile, 'utf8');
  await assert.rejects(() => command({ op: 'load', projectNoteId: invalidTarget.id }), /策略标记无效/u);
  assert.equal(await fs.readFile(invalidFile, 'utf8'), before);
  checks.push('未知策略标记拒绝读取且不覆盖原文件，不静默改写旧任务');

  const result = { status: 'passed', root, remoteCalls: 0, guidanceCharacters: TEXTBOOK_INTERACTIVE_FIGURE_GUIDANCE_V3.length, checks };
  await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} finally { store.releaseOwner(owner); globalThis.fetch = originalFetch; }
