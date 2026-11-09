/** Synthetic supplement design/title regression. No provider or user data. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ProgressiveLearningStore } from '../src/electron/progressiveLearningStore';
import { createProgressiveController, type ProgressiveStorageAdapter } from '../src/services/progressiveLearning/runtime';
import { progressiveGenerationRequest } from '../src/services/progressiveLearning/generation';
import { shareProgressiveTeaching } from '../src/services/progressiveLearning/share';
import { atomicWriteTextFile } from '../src/electron/atomicWrite';
import type { NoteItem } from '../src/types';
import type { ProgressiveBeginReply, ProgressiveCommand, ProgressiveCourse, ProgressiveMainline } from '../src/services/progressiveLearning/types';

const originalFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('Supplement design regression must not use a provider or network');
const root = await fs.mkdtemp(path.resolve('build/progressive-supplement-design-'));
const checks: string[] = [];
const sourceText = '同一位置不能直接确定位移变化率的方向，需要结合正在向哪边运动来判断。判断时要把位置、运动方向和条件分别说明，不能把位置的正负直接当作运动方向。';
const baseBody = '# 位置与运动方向\n\n' + sourceText.repeat(18) + '\n\n先核对允许条件，再用反例检验判断。';
const hook = { id: 'hook', kind: 'reflection' as const, prompt: '为什么只看位置不能直接判断运动方向？' };
const selected = sourceText.repeat(9);
let owner = 1;

async function harness(name: string) {
  const at = new Date().toISOString(), id = 'supplement-design-' + name;
  const note: NoteItem = { id, title: '位置与运动方向', content: '保留人工学习目标。', noteType: 'project', projectRole: 'learning',
    tags: [], links: [], backlinks: [], createdAt: at, updatedAt: at,
    dueDates: [{ id: 'deadline', noteId: id, noteTitle: '位置与运动方向', taskText: '位置与运动方向', dueDate: '2026-11-10', estimatedMinutes: 5, completed: false, priority: 'medium' }] };
  const directory = path.join(root, name); let failReady = 0;
  const dependencies = { readTarget: async () => ({ note, root: note, isLeaf: true }), write: async (file: string, text: string) => {
    if (failReady > 0 && file.endsWith('course.json') && JSON.parse(text).generation.status === 'ready') { failReady--; throw Error('injected publication failure'); }
    await atomicWriteTextFile(file, text, { allowCopyFallback: false });
  } };
  let store = new ProgressiveLearningStore(directory, dependencies);
  const command = <T>(input: ProgressiveCommand): Promise<T> => store.command(input, owner) as Promise<T>;
  const plan: ProgressiveMainline = { title: '辨析位置与运动', objectives: ['用条件和反例说明位置与运动的关系'],
    pages: [{ id: 'main-1', title: '位置与运动方向', objectives: ['区分位置和运动方向'] }] };
  const begin = () => command<ProgressiveBeginReply>({ op: 'begin', projectNoteId: id });
  let course = await command<ProgressiveCourse>({ op: 'publish', lease: (await begin()).lease!, teaching: { sequence: 1, plan, title: plan.pages[0].title, body: baseBody, concepts: [], questions: [], hook } });
  course = await command<ProgressiveCourse>({ op: 'save-progress', projectNoteId: id, progress: { environmentId: course.environmentId,
    courseId: course.id, expectedProgressVersion: course.progress.version, patch: { restatementDraft: 'PRIVATE_SAVED_RESTATEMENT', summaryDraft: 'PRIVATE_SAVED_SUMMARY', questionDraft: 'PRIVATE_QUESTION' } } });
  const baselineHash = course.pages![0].contentHash;
  const reserve = async (scope?: { text: string; pageHash: string; before?: string; after?: string }) => {
    const loaded = await command<ProgressiveCourse>({ op: 'load', projectNoteId: id });
    return command<ProgressiveBeginReply>({ op: 'next', projectNoteId: id, request: { environmentId: loaded.environmentId, courseId: loaded.id,
      expectedRevision: loaded.revision, requestId: 'request-' + Math.random().toString(36).slice(2), intent: 'expansion', fromPageId: loaded.page!.id, ...(scope ? { scope } : {}) } });
  };
  const storage: ProgressiveStorageAdapter = {
    load: () => command<ProgressiveCourse>({ op: 'load', projectNoteId: id }), begin: (_id, sourcePackets) => command({ op: 'begin', projectNoteId: id, sourcePackets }),
    next: (_id, request) => command({ op: 'next', projectNoteId: id, request }),
    checkpoint: (lease, checkpoint) => command({ op: 'checkpoint', lease, checkpoint }), publish: (lease, teaching) => command({ op: 'publish', lease, teaching }),
    saveProgress: (_id, progress) => command({ op: 'save-progress', projectNoteId: id, progress }), interrupt: (lease, error) => command({ op: 'interrupt', lease, error }),
  };
  const requests: Array<{ course: ProgressiveCourse; request: ReturnType<typeof progressiveGenerationRequest> }> = [];
  const raw = (body: string) => `@@LESSON\n${body}\n@@CONCEPTS\n[]\n@@QUESTIONS\n[]\n@@HOOK\n${JSON.stringify(hook)}\n@@END\n`;
  const controller = (body: string, noStream = false) => createProgressiveController({ note, allNotes: [note] }, {
    storage, registerFlush: () => () => {}, checkpointIntervalMs: 100000, loadMaterials: async () => [], stream: async (value, _signal, goal) => {
      assert.equal(noStream, false, 'Complete saved publications must not request another generation');
      requests.push({ course: structuredClone(value), request: progressiveGenerationRequest(value, goal) });
      const text = raw(body);
      return new ReadableStream({ start(stream) { for (let i = 0; i < text.length; i += 31) stream.enqueue({ type: 'content', text: text.slice(i, i + 31) }); stream.close(); } });
    },
  });
  const restart = () => { store.releaseOwner(owner); owner++; store = new ProgressiveLearningStore(directory, dependencies); };
  return { id, note, plan, command, begin, reserve, storage, requests, raw, controller, restart, baselineHash, initial: course,
    get store() { return store; }, failNextPublication: () => { failReady = 2; },
    courseFile: path.join(directory, 'progressive-learning', `project-${createHash('sha256').update(id).digest('hex')}`, 'course.json') };
}

try {
  const selection = await harness('selection');
  const scope = { text: selected, pageHash: selection.baselineHash, before: '选中位置前的条件。', after: '选中位置后的对照。' };
  const focused = await selection.reserve(scope);
  const selectionDesign = (focused.course.generation as any).supplementDesign;
  assert.ok(selectionDesign); assert.equal(selectionDesign.version, 1); assert.equal(selectionDesign.mode, 'selection');
  assert.equal(selectionDesign.sourceTitle, selection.initial.page!.title);
  assert.deepEqual(focused.course.generation.scope, scope);
  const focusedRequest = progressiveGenerationRequest(focused.course), focusedInput = JSON.parse(focusedRequest.userInput);
  assert.deepEqual(focusedInput.supplementScope, scope);
  assert.equal(focusedInput.currentPage.title, undefined, 'A new supplement must not inherit the root mainline title as its prescribed new title');
  assert.equal(focusedInput.currentPageObjective, undefined);
  assert.equal(focusedRequest.maxTokensOverride, 6500); assert.equal(focusedRequest.thinkingMode, 'disabled');
  assert.ok(focusedRequest.systemPromptOverride!.includes('选中') || focusedRequest.userInput.includes('选中'));
  const focusedLegacy = structuredClone(focused.course); delete (focusedLegacy.generation as any).supplementDesign;
  const focusedLegacyRequest = progressiveGenerationRequest(focusedLegacy);
  assert.ok(focusedRequest.systemPromptOverride !== focusedLegacyRequest.systemPromptOverride || focusedRequest.userInput !== focusedLegacyRequest.userInput,
    'Only reservations carrying the new design receive its focused teaching instruction');
  assert.ok(Math.max(0, focusedRequest.systemPromptOverride!.length - focusedLegacyRequest.systemPromptOverride!.length)
    + Math.max(0, focusedRequest.userInput.length - focusedLegacyRequest.userInput.length) <= 800,
    'Supplement design must stay compact instead of copying selected material into a second prompt');
  await selection.command({ op: 'interrupt', lease: focused.lease!, error: 'synthetic pause before teaching' });
  selection.note.title = '修改后的临时项目标题不应重选补充策略';
  selection.restart();
  const resumed = await selection.begin();
  assert.deepEqual((resumed.course.generation as any).supplementDesign, selectionDesign);
  assert.deepEqual(resumed.course.generation.scope, scope);
  assert.equal(resumed.course.generation.requestId, focused.course.generation.requestId);
  selection.store.releaseOwner(owner);
  const targetedBody = '# 为什么同一位置会有两个运动方向\n\n先把选中语句中的“位置”与“变化方向”分开。' + sourceText.repeat(3);
  const targetedController = selection.controller(targetedBody);
  await targetedController.retry();
  assert.equal(targetedController.getSnapshot().phase, 'ready');
  assert.equal(targetedController.getSnapshot().page!.title, '为什么同一位置会有两个运动方向');
  assert.equal(selection.requests.length, 1);
  assert.equal(targetedController.getSnapshot().course!.pages![0].contentHash, selection.baselineHash);
  assert.equal(targetedController.getSnapshot().course!.progress.restatementDraft, 'PRIVATE_SAVED_RESTATEMENT');
  assert.equal(targetedController.getSnapshot().course!.progress.summaryDraft, 'PRIVATE_SAVED_SUMMARY');
  assert.deepEqual(targetedController.getSnapshot().course!.budget, selection.initial.budget);
  assert.ok(!targetedController.getSnapshot().page!.body.trimStart().startsWith('# 为什么同一位置会有两个运动方向'),
    'The promoted page title is not repeated as the first body heading');
  const targetedShared = shareProgressiveTeaching(targetedController.getSnapshot().course!);
  assert.equal(targetedShared.pages[0].title, '为什么同一位置会有两个运动方向');
  assert.ok(!JSON.stringify(targetedShared).includes('supplementDesign'));
  targetedController.dispose();
  checks.push('选区模式精确保留内容与前后文；新标题取生成的具体问题，原主线、预算和学习草稿不变');

  const whole = await harness('whole-page');
  const wholeReserved = await whole.reserve({ text: '', pageHash: whole.baselineHash });
  const wholeDesign = (wholeReserved.course.generation as any).supplementDesign;
  assert.ok(wholeDesign); assert.equal(wholeDesign.mode, 'page');
  assert.equal(wholeDesign.sourceTitle, whole.initial.page!.title);
  assert.equal(wholeReserved.course.generation.scope!.text, whole.initial.page!.body);
  assert.notDeepEqual(wholeDesign, selectionDesign, 'A whole-page request must not become a giant selected-text explanation');
  const wholeRequest = progressiveGenerationRequest(wholeReserved.course);
  assert.ok(wholeRequest.systemPromptOverride!.includes('换') || wholeRequest.userInput.includes('换'));
  const wholeLegacy = structuredClone(wholeReserved.course); delete (wholeLegacy.generation as any).supplementDesign;
  const wholeLegacyRequest = progressiveGenerationRequest(wholeLegacy);
  assert.ok(wholeRequest.systemPromptOverride !== wholeLegacyRequest.systemPromptOverride || wholeRequest.userInput !== wholeLegacyRequest.userInput,
    'Page-wide reservations must also receive the new teaching design');
  assert.ok(Math.max(0, wholeRequest.systemPromptOverride!.length - wholeLegacyRequest.systemPromptOverride!.length)
    + Math.max(0, wholeRequest.userInput.length - wholeLegacyRequest.userInput.length) <= 800);
  await whole.command({ op: 'interrupt', lease: wholeReserved.lease!, error: 'synthetic whole-page pause' }); whole.restart();
  const wholeAgain = await whole.begin();
  assert.deepEqual((wholeAgain.course.generation as any).supplementDesign, wholeDesign);
  assert.equal(wholeAgain.course.generation.scope!.text, wholeReserved.course.generation.scope!.text);
  whole.store.releaseOwner(owner);
  const wholeBody = '# 用往返小车看清位置与运动\n\n换一个具体情境：同一地点的小车可以往返经过，地点相同而方向不同。' + sourceText.repeat(3);
  const wholeController = whole.controller(wholeBody); await wholeController.retry();
  assert.equal(wholeController.getSnapshot().phase, 'ready'); assert.equal(wholeController.getSnapshot().page!.title, '用往返小车看清位置与运动');
  wholeController.dispose();
  checks.push('未选区模式即使保存整页范围仍保留独立设计；重启不误判为选区，换讲法标题保持内容目的');

  const previousSupplement = await whole.command<ProgressiveCourse>({ op: 'load', projectNoteId: whole.id });
  const nestedScope = { text: previousSupplement.page!.body.slice(0, 260), pageHash: previousSupplement.pages!.find(p => p.id === previousSupplement.page!.id)!.contentHash };
  const nestedController = whole.controller('# 同一路口的两次经过为什么方向不同\n\n从刚才的小车情境继续，只核对来回经过的这一点。' + sourceText.repeat(3));
  await nestedController.start(); await nestedController.next('expansion', nestedScope);
  assert.equal(nestedController.getSnapshot().phase, 'ready');
  const nestedRequest = JSON.parse(whole.requests.at(-1)!.request.userInput);
  assert.equal(nestedRequest.previousTeaching.title, previousSupplement.page!.title);
  assert.equal(nestedRequest.sourcePage.title, previousSupplement.page!.title);
  assert.equal((whole.requests.at(-1)!.course.generation as any).supplementDesign.sourceTitle, previousSupplement.page!.title);
  assert.equal(nestedRequest.supplementScope.text, nestedScope.text);
  assert.equal(nestedController.getSnapshot().page!.title, '同一路口的两次经过为什么方向不同');
  assert.equal((await whole.command<ProgressiveCourse>({ op: 'load', projectNoteId: whole.id })).page!.parentPageId, 'main-1');
  nestedController.dispose();
  checks.push('补充页再次补充承接实际来源页及选区，标题不退回根主线加后缀，目录归属仍为原主线');

  const recover = await harness('recover');
  const recoverReserved = await recover.reserve({ text: selected, pageHash: recover.baselineHash });
  const recoveredBody = '# 从反例拆解位置判断的条件\n\n一个位置可能在不同时刻被经过，先分别写出前提和运动方向。' + sourceText.repeat(3);
  await recover.command({ op: 'checkpoint', lease: recoverReserved.lease!, checkpoint: { sequence: 1, plan: recover.plan, rawDraft: recover.raw(recoveredBody), bodyDraft: recoveredBody } });
  await recover.command({ op: 'interrupt', lease: recoverReserved.lease!, error: 'synthetic completed response, save pending' }); recover.restart();
  const recoverController = recover.controller('', true); await recoverController.retry();
  assert.equal(recoverController.getSnapshot().phase, 'ready'); assert.equal(recoverController.getSnapshot().page!.title, '从反例拆解位置判断的条件');
  assert.equal(recover.requests.length, 0); recoverController.dispose();
  checks.push('完整响应检查点重启后仅重试发布，沿用同一标题和正文，不再请求生成');

  const failed = await harness('publish-retry');
  const retryBody = '# 用正反两个例子区分位置和方向\n\n先看同一地点向右经过，再看稍后向左经过。' + sourceText.repeat(3);
  const retryController = failed.controller(retryBody); await retryController.start(); failed.failNextPublication();
  await retryController.next('expansion', { text: selected, pageHash: failed.baselineHash });
  assert.ok(retryController.getSnapshot().saveError || retryController.getSnapshot().error);
  const requestCount = failed.requests.length; await retryController.flush();
  assert.equal(retryController.getSnapshot().phase, 'ready'); assert.equal(retryController.getSnapshot().page!.title, '用正反两个例子区分位置和方向');
  assert.equal(failed.requests.length, requestCount); retryController.dispose();
  checks.push('发布失败后的保存重试不重做教材，最终标题与正常路径一致');

  const fallback = await harness('missing-title');
  const fallbackController = fallback.controller('先换一个例子解释这个判断。' + sourceText.repeat(4));
  await fallbackController.start(); await fallbackController.next('expansion');
  assert.equal(fallbackController.getSnapshot().phase, 'ready');
  assert.ok(fallbackController.getSnapshot().page!.title.trim());
  assert.ok(!fallbackController.getSnapshot().page!.title.endsWith(' · 补充讲解'));
  assert.ok(fallbackController.getSnapshot().page!.title.length <= 300);
  fallbackController.dispose();
  checks.push('模型未给标题时本地安全回退，不新增必填字段或阻断生成，不恢复旧的机械标题');

  const fenced = await harness('fenced-title');
  const fencedController = fenced.controller('```text\n# 代码里的标题不应成为页名\n```\n\n先从另一种情境解释。' + sourceText.repeat(3));
  await fencedController.start(); await fencedController.next('expansion');
  assert.equal(fencedController.getSnapshot().phase, 'ready');
  assert.notEqual(fencedController.getSnapshot().page!.title, '代码里的标题不应成为页名');
  fencedController.dispose();
  checks.push('标题抽取跳过代码围栏中的伪标题，缺少有效页标题也不触发额外生成');

  const legacy = await harness('legacy');
  const legacyReserved = await legacy.reserve({ text: selected, pageHash: legacy.baselineHash });
  await legacy.command({ op: 'interrupt', lease: legacyReserved.lease!, error: 'synthetic legacy reservation' });
  const legacyState = JSON.parse(await fs.readFile(legacy.courseFile, 'utf8')); delete legacyState.generation.supplementDesign;
  await fs.writeFile(legacy.courseFile, JSON.stringify(legacyState)); legacy.restart();
  const legacyBefore = await legacy.command<ProgressiveCourse>({ op: 'load', projectNoteId: legacy.id });
  const legacyRequest = progressiveGenerationRequest(legacyBefore);
  const legacyController = legacy.controller('# 一个旧任务正文中的标题\n\n' + sourceText.repeat(3)); await legacyController.retry();
  assert.equal(legacyController.getSnapshot().phase, 'ready');
  assert.equal(legacyController.getSnapshot().page!.title, legacy.plan.pages[0].title + ' · 补充讲解');
  assert.equal(legacy.requests.length, 1); assert.equal(legacy.requests[0].request.systemPromptOverride, legacyRequest.systemPromptOverride);
  const shared = shareProgressiveTeaching(legacyController.getSnapshot().course!);
  assert.ok(!JSON.stringify(shared).includes('supplementDesign')); legacyController.dispose();
  checks.push('旧无设计标记任务不升级提示词、不改既定标题恢复规则；设计数据不进入Markdown分享');

  await fs.writeFile(path.join(root, 'result.json'), JSON.stringify({ status: 'passed', root, remoteCalls: 0, checks }, null, 2));
  console.log(JSON.stringify({ status: 'passed', root, checks: checks.length, remoteCalls: 0 }));
} finally { globalThis.fetch = originalFetch; }
