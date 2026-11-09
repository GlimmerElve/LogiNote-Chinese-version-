/** Offline contract regression: actual generation requests and durable course
 * checkpoints. Synthetic lessons only; no provider, real vault or UI is used. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ProgressiveLearningStore } from '../src/electron/progressiveLearningStore';
import { progressiveGenerationRequest, PROGRESSIVE_GENERATION_PROMPT, PROGRESSIVE_ADAPTATION_PROMPT } from '../src/services/progressiveLearning/generation';
import { createProgressiveWritingPolicy, progressiveWritingGuidance } from '../src/services/progressiveLearning/writingGuidance';
import { TEXTBOOK_RICH_LAYOUT_GUIDANCE, TEXTBOOK_RICH_LAYOUT_GUIDANCE_V8,
  TEXTBOOK_INTERACTIVE_FIGURE_GUIDANCE, TEXTBOOK_INTERACTIVE_FIGURE_GUIDANCE_V2,
  TEXTBOOK_INTERACTIVE_FIGURE_GUIDANCE_V3 } from '../src/services/textbook/richLayoutGuidance';
import { shareProgressiveTeaching, sharedTeachingMarkdown } from '../src/services/progressiveLearning/share';
import type { ProgressiveBeginReply, ProgressiveCourse, ProgressiveMainline, ProgressiveCommand,
  ProgressiveWritingPolicy } from '../src/services/progressiveLearning/types';
import type { TextbookTeachingType } from '../src/services/textbook/teachingTypes';
import type { NoteItem } from '../src/types';

// Persisted versioned reservations must continue using these exact bytes.
// A future wording change belongs to a new policy version, not this snapshot.
const GUIDANCE_V1_HASH = 'e2f751e5e564e493a72774eeeb528766e8dad71a6cc8eebffeec9b72abf56ad7';
const GUIDANCE_V2_HASH = '39523ef70688c303d2846f3d8f615fdfd64ce2328b23238761fc802ffcd1b3ef';
const GUIDANCE_V3_HASH = '2e3c56f5527469b319068fce89cd0af94982de6ef9231bb282df0f612e02c82e';
const GUIDANCE_V4_HASH = 'f2d945b36a4ed0efe74fe638299fc91b20a24f856a445e82dbd7fa5051082e9d';
const GUIDANCE_V5_HASH = '2c1a08e272d4e06843972b473c508a73be608773c3b0da96f1b9980ace71510c';
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('Writing guidance must not make a model, classification or network call');
const checks: string[] = [];
const root = await fs.mkdtemp(path.resolve('build/progressive-writing-'));
const at = '2026-11-07T00:00:00.000Z';
const notes = new Map<string, NoteItem>();
const note = (id: string, title: string): NoteItem => ({ id, title, noteType: 'project', projectRole: 'learning',
  content: '保留合成人工目标。', tags: [], links: [], backlinks: [], dueDates: [], createdAt: at, updatedAt: at });
const parent = note('synthetic-root', '数学与函数入门');
const dependencies = { readTarget: async (id: string) => {
  const target = notes.get(id); assert.ok(target, 'known synthetic target');
  return { note: target, root: parent, isLeaf: true };
} };
const stateFile = (id: string) => path.join(root, 'progressive-learning',
  `project-${createHash('sha256').update(id).digest('hex')}`, 'course.json');
const command = async <T>(store: ProgressiveLearningStore, input: ProgressiveCommand, owner = 1): Promise<T> =>
  await store.command(input, owner) as T;
const begin = (store: ProgressiveLearningStore, id: string, owner = 1) =>
  command<ProgressiveBeginReply>(store, { op: 'begin', projectNoteId: id }, owner);
// The existing prompt construction is intentionally retained byte for byte for
// courses whose reservations predate writingPolicy, including raw-only drafts.
function legacyPrompt(course: ProgressiveCourse): string {
  return (course.generation.bodyDraft ? PROGRESSIVE_GENERATION_PROMPT : PROGRESSIVE_GENERATION_PROMPT
    .replace(TEXTBOOK_RICH_LAYOUT_GUIDANCE, TEXTBOOK_RICH_LAYOUT_GUIDANCE_V8)
    .replace(TEXTBOOK_INTERACTIVE_FIGURE_GUIDANCE, TEXTBOOK_INTERACTIVE_FIGURE_GUIDANCE_V2)
    .replace('没有授权图片指针时不用textbook-image，不另行请求绘图模型。', '没有授权图片指针时不用textbook-image；本次正文不包含交互图代码。'))
    + PROGRESSIVE_ADAPTATION_PROMPT;
}
function reservedPrompt(course: ProgressiveCourse): string {
  const base = legacyPrompt(course);
  return course.generation.figurePolicy === 1 ? base.replace(course.generation.bodyDraft
    ? TEXTBOOK_INTERACTIVE_FIGURE_GUIDANCE : TEXTBOOK_INTERACTIVE_FIGURE_GUIDANCE_V2,
  TEXTBOOK_INTERACTIVE_FIGURE_GUIDANCE_V3) : base;
}

try {
  const routes: Array<[string, TextbookTeachingType]> = [
    ['函数极限与导数', 'mathematics'], ['历史演变与年代分期', 'history'],
    ['选择过载效应的机制与边界', 'concept'], ['弹簧受力与化学反应', 'science'],
    ['Python编程与代码调试', 'procedure'], ['梳理本页学习内容', 'general'],
  ];
  for (const [title, expected] of routes) {
    const policy = createProgressiveWritingPolicy({ title });
    assert.equal(policy.version, 6);
    assert.deepEqual(policy.teachingTypes, [expected], title);
    assert.ok(progressiveWritingGuidance(policy).length > 0, title);
  }
  const mixed = createProgressiveWritingPolicy({ title: '选择过载效应中的概率函数' });
  assert.deepEqual(new Set(mixed.teachingTypes), new Set(['concept', 'mathematics']));
  assert.deepEqual(createProgressiveWritingPolicy({ title: '函数极限', pageTitle: '历史演变与年代分期',
    rootTitle: 'Python编程', sources: [{ title: '化学讲义', text: '弹簧与受力。' }] }).teachingTypes, ['history'],
  'the current page must outrank the root and unrelated reference material');
  assert.deepEqual(createProgressiveWritingPolicy({ title: '梳理本页内容', rootTitle: '微积分入门' }).teachingTypes, ['mathematics']);
  assert.deepEqual(createProgressiveWritingPolicy({ title: '梳理本页内容',
    sources: [{ title: '化学反应', text: '化学反应的条件及守恒关系。' }] }).teachingTypes, ['science']);
  const scope = createProgressiveWritingPolicy({ title: '梳理本页内容', scope: '用Python代码完成调试并检查输出' });
  assert.ok(scope.teachingTypes.includes('procedure'));
  const quantitativeSource = { id: 'S1', kind: 'document' as const, title: '合成水平弹簧资料',
    text: '水平无摩擦弹簧振子，质量m=0.50 kg，k=8.0 N/m，振幅A=0.10 m，由静止释放。x(t)=0.10cos(4t) m，时间区间0到1.6 s。' };
  const quantPolicy = createProgressiveWritingPolicy({ title: '物理：弹簧的位移和速度', sources: [quantitativeSource] });
  assert.deepEqual(quantPolicy, { version: 6, teachingTypes: ['science'], inlineVisual: 'quantitative' },
    'a bounded explicit numerical relation reserves a quantitative visual intent, not a separate planning call');
  for (const context of [
    { title: '物理：弹簧受力', sources: [{ title: '条件未知', text: '弹簧的质量、振幅和具体规律尚不明确。' }] },
    { title: '物理：弹簧受力', sources: [{ title: '符号关系', text: 'x(t)=A cos(omega t)，各参数还未给定。' }] },
    { title: '物理：弹簧受力', sources: Array.from({ length: 4 }, () => ({ title: '定性说明', text: '仅观察弹簧的方向与形状。' })).concat(quantitativeSource) },
    { title: '物理：弹簧受力', sources: [{ title: '超出选型预算的尾部', text: '定性说明。'.repeat(160) + quantitativeSource.text }] },
    { title: '历史演变与分期', sources: [quantitativeSource] },
  ]) assert.equal(createProgressiveWritingPolicy(context).inlineVisual, undefined,
    'unknown, out-of-budget or unrelated material cannot impose a curve requirement');
  const classes: TextbookTeachingType[] = ['concept', 'history', 'mathematics', 'science', 'procedure', 'general'];
  assert.equal(createHash('sha256').update(JSON.stringify(classes.map(type =>
    progressiveWritingGuidance({ version: 1, teachingTypes: [type] })))).digest('hex'), GUIDANCE_V1_HASH,
  'V1 teaching guidance is frozen for persisted reservations; revised wording requires a new policy version');
  assert.equal(createHash('sha256').update(JSON.stringify(classes.map(type =>
    progressiveWritingGuidance({ version: 2, teachingTypes: [type] })))).digest('hex'), GUIDANCE_V2_HASH,
  'V2 teaching guidance is also frozen once persisted; later corrections require another version');
  assert.equal(createHash('sha256').update(JSON.stringify(classes.map(type =>
    progressiveWritingGuidance({ version: 3, teachingTypes: [type] })))).digest('hex'), GUIDANCE_V3_HASH,
  'V3 figure consistency guidance stays fixed for resumed reservations');
  assert.equal(createHash('sha256').update(JSON.stringify(classes.map(type =>
    progressiveWritingGuidance({ version: 4, teachingTypes: [type] })))).digest('hex'), GUIDANCE_V4_HASH,
  'V4 inline figure guidance is frozen; physics corrections must not change existing reservations');
  assert.equal(createHash('sha256').update(JSON.stringify(classes.map(type =>
    progressiveWritingGuidance({ version: 5, teachingTypes: [type] })))).digest('hex'), GUIDANCE_V5_HASH,
  'V5 physics and unit guidance is frozen; curve intent must not alter its persisted prompt');
  let maxGuidanceChars = 0;
  const guidanceCharsByVersion: Record<number, number> = {};
  for (const version of [1, 2, 3, 4, 5, 6] as const) for (const first of classes) for (const second of classes) {
    const guidance = progressiveWritingGuidance({ version, teachingTypes: [first, second] });
    maxGuidanceChars = Math.max(maxGuidanceChars, guidance.length);
    guidanceCharsByVersion[version] = Math.max(guidanceCharsByVersion[version] || 0, guidance.length);
    assert.ok(guidance.length <= (version >= 5 ? 850 : version === 4 ? 800 : 600), `combined guidance is bounded: v${version} ${first}/${second} = ${guidance.length}`);
  }
  const oldMath = progressiveWritingGuidance({ version: 1, teachingTypes: ['mathematics'] });
  const newMath = progressiveWritingGuidance({ version: 2, teachingTypes: ['mathematics'] });
  const diagramMath = progressiveWritingGuidance({ version: 3, teachingTypes: ['mathematics'] });
  const inlineMath = progressiveWritingGuidance({ version: 6, teachingTypes: ['mathematics'] });
  const oldScience = progressiveWritingGuidance({ version: 3, teachingTypes: ['science'] });
  const reservedInlineScience = progressiveWritingGuidance({ version: 4, teachingTypes: ['science'] });
  const correctedScience = progressiveWritingGuidance({ version: 5, teachingTypes: ['science'] });
  const inlineScience = progressiveWritingGuidance({ version: 6, teachingTypes: ['science'] });
  assert.notEqual(newMath, oldMath, 'new mathematics requests receive revised guidance without replacing V1');
  assert.ok(newMath.includes('学生') && newMath.includes('学号') && newMath.includes('重名'), 'new analogy guidance distinguishes the input object');
  assert.ok(newMath.includes('定义域') && newMath.includes('陪域') && newMath.includes('值域'), 'new function guidance distinguishes all three sets');
  assert.notEqual(diagramMath, newMath, 'new pages receive figure consistency guidance without replacing V2');
  assert.notEqual(inlineScience, oldScience, 'new science pages receive inline visual selection without replacing frozen V3');
  assert.notEqual(inlineScience, reservedInlineScience, 'physics corrections leave the original inline V4 request unchanged');
  assert.equal(inlineScience, correctedScience.replace('正文文风v5：', '正文文风v6：'),
    'the intent version reuses the already reviewed physics guidance rather than expanding it');
  assert.ok(inlineScience.includes('science-diagram') && inlineScience.includes('function-plot'),
    'science instruction names the actual supported inline visual formats');
  assert.match(inlineScience, /同次|同一次|同一响应/u, 'diagrams are emitted during the same lesson request');
  assert.match(inlineScience, /已知|明确/u, 'quantitative graphs require known model conditions');
  assert.match(inlineScience, /未知|不猜|条件不足跳过图/u, 'unknown physics quantities cannot be invented to force a graph');
  assert.match(inlineScience, /继续(?:讲解|正文)|不阻断|不中断/u, 'not having a reliable diagram cannot block the lesson');
  assert.match(inlineScience, /极值/u, 'signed extrema must be distinguished from signed maxima');
  assert.match(inlineScience, /x\s*=\s*-A/u, 'the physics guide gives a concrete negative-displacement boundary');
  assert.match(inlineScience, /最小/u, 'negative maximum magnitude is a signed displacement minimum');
  assert.match(inlineScience, /同一纵轴|共用纵轴/u, 'the supported plot has one declared vertical scale');
  assert.match(inlineScience, /同单位|同量纲/u, 'shared physical axes require compatible units');
  assert.match(inlineScience, /归一化/u, 'comparing different physical quantities requires an explicit scale transformation');
  assert.match(inlineScience, /无量纲/u, 'normalized plots declare dimensionless units');
  assert.ok(inlineScience.includes('x/A') && /v\/\([^)]*(?:ω|omega)/u.test(inlineScience),
    'normalization examples define both displacement and velocity reference scales');
  assert.match(inlineScience, /双轴/u, 'the guide must not invent unsupported dual-axis plot fields');
  for (const type of classes.filter(type => type !== 'science')) {
    const selected = progressiveWritingGuidance({ version: 6, teachingTypes: [type] });
    assert.ok(!selected.includes('science-diagram') && !selected.includes('function-plot'),
      `science-specific inline selection must not enlarge the ${type} policy`);
  }
  assert.equal(progressiveWritingGuidance(), '');
  assert.equal(progressiveWritingGuidance({ version: 99, teachingTypes: ['mathematics'] } as unknown as ProgressiveWritingPolicy), '',
    'an unknown future policy cannot block or silently replace existing generation');
  checks.push('学科/混合类型及当前页优先路由；未知主题回退；仅选中指导进入提示词且总增量有界');

  const store = new ProgressiveLearningStore(root, dependencies);
  const project = note('new-page', '函数极限'); notes.set(project.id, project);
  const initial = await begin(store, project.id);
  const policy = initial.course.generation.writingPolicy;
  assert.ok(policy); assert.equal(policy.version, 6); assert.deepEqual(policy.teachingTypes, ['mathematics']);
  const freshRequest = progressiveGenerationRequest(initial.course);
  const guidance = progressiveWritingGuidance(policy);
  assert.ok(freshRequest.systemPromptOverride!.startsWith(reservedPrompt(initial.course)));
  assert.ok(freshRequest.systemPromptOverride!.endsWith(guidance));
  assert.ok(freshRequest.systemPromptOverride!.length - reservedPrompt(initial.course).length <= 852);
  const withoutPolicy = structuredClone(initial.course); delete withoutPolicy.generation.writingPolicy;
  assert.equal(freshRequest.userInput, progressiveGenerationRequest(withoutPolicy).userInput,
    'writing guidance must not alter the lesson/plan/question protocol or add model metadata fields');
  assert.equal(freshRequest.maxTokensOverride, 6500); assert.equal(freshRequest.temperatureOverride, 0.3);
  assert.equal(freshRequest.thinkingMode, 'disabled');
  const scienceProject = note('inline-science-page', '弹簧受力与位移变化'); notes.set(scienceProject.id, scienceProject);
  const scienceInitial = await begin(store, scienceProject.id, 10);
  assert.deepEqual(scienceInitial.course.generation.writingPolicy, { version: 6, teachingTypes: ['science'] });
  const scienceRequest = progressiveGenerationRequest(scienceInitial.course);
  assert.equal(scienceRequest.systemPromptOverride, reservedPrompt(scienceInitial.course) + inlineScience);
  const unstyledScience = structuredClone(scienceInitial.course); delete unstyledScience.generation.writingPolicy;
  assert.equal(scienceRequest.userInput, progressiveGenerationRequest(unstyledScience).userInput,
    'inline diagrams keep the existing Markdown body protocol instead of adding a planning or repair request');
  assert.equal(scienceRequest.maxTokensOverride, 6500); assert.equal(scienceRequest.thinkingMode, 'disabled');
  store.releaseOwner(10);
  checks.push('新理化页V6复用V5同响应绘图与物理边界：区分位移极值与最大值；同轴同单位或明确参考尺度归一化；不编双轴字段、不增请求或阻断；其它学科不加载理化专项');
  const plan: ProgressiveMainline = { title: '合成跨学科学习', objectives: ['解释关系并比较不同证据'], pages: [
    { id: 'main-1', title: '函数极限', objectives: ['说明函数的趋近过程'] },
    { id: 'main-2', title: '历史演变与年代分期', objectives: ['比较历史时期及转折'] },
  ] };
  const prefix = '# 函数极限\n\n观察允许输入附近的函数值，先比较两侧趋近的结果，再给出极限的判断。';
  const suffix = '\n\n即使一个点处没有定义，只要附近的函数值趋向同一结果，仍可讨论该点处的极限。';
  const raw = `@@PLAN\n${JSON.stringify(plan)}\n@@LESSON\n${prefix}`;
  // Quantitative intent is frozen at reservation, independently of later page
  // metadata or explicit temporary context. It only adds one compact input.
  const quantitativeNote = note('reserved-inline-intent', '物理：弹簧的位移和速度'); notes.set(quantitativeNote.id, quantitativeNote);
  const quantitativeBegin = await command<ProgressiveBeginReply>(store, { op: 'begin', projectNoteId: quantitativeNote.id,
    sourcePackets: [quantitativeSource] }, 11);
  const quantitativePolicy = structuredClone(quantitativeBegin.course.generation.writingPolicy!);
  assert.deepEqual(quantitativePolicy, quantPolicy);
  const quantitativeRequest = progressiveGenerationRequest(quantitativeBegin.course);
  const quantitativeInput = JSON.parse(quantitativeRequest.userInput);
  const frozenIntent = quantitativeInput.inlineVisualDesign;
  assert.equal(frozenIntent.primaryFormat, 'function-plot');
  assert.ok(JSON.stringify(frozenIntent).length <= 220, 'the optional selection instruction remains compact');
  assert.match(frozenIntent.instruction, /随正文同次生成/u);
  assert.match(frozenIntent.instruction, /条件不足.*继续正文/u);
  assert.match(frozenIntent.instruction, /不追加绘图请求/u);
  const noIntentCourse = structuredClone(quantitativeBegin.course); delete noIntentCourse.generation.writingPolicy;
  const { inlineVisualDesign: _ignored, ...quantitativeCore } = quantitativeInput;
  assert.deepEqual(quantitativeCore, JSON.parse(progressiveGenerationRequest(noIntentCourse).userInput),
    'the quantitative hint adds no other lesson, plan or question fields');
  for (const version of [1, 2, 3, 4, 5] as const) {
    const oldIntentCourse = structuredClone(quantitativeBegin.course);
    oldIntentCourse.generation.writingPolicy = { version, teachingTypes: ['science'], inlineVisual: 'quantitative' };
    assert.equal(JSON.parse(progressiveGenerationRequest(oldIntentCourse).userInput).inlineVisualDesign, undefined,
      'even a stray newer private property cannot change an old request payload');
  }
  const quantitativePlan: ProgressiveMainline = { title: quantitativeNote.title, objectives: ['区分各量与相位'],
    pages: [{ id: 'main-1', title: '弹簧的位移与运动', objectives: ['说明位移和速度的关系'] }] };
  const quantitativePrefix = '先约定原点与正方向，再使用已知的位移关系描述振子的变化。';
  const quantitativeRaw = '@@PLAN\n' + JSON.stringify(quantitativePlan) + '\n@@LESSON\n' + quantitativePrefix;
  await command(store, { op: 'checkpoint', lease: quantitativeBegin.lease!, checkpoint: {
    sequence: 1, plan: quantitativePlan, rawDraft: quantitativeRaw, bodyDraft: quantitativePrefix } }, 11);
  await command(store, { op: 'interrupt', lease: quantitativeBegin.lease! }, 11); store.releaseOwner(11);
  quantitativeNote.title = '历史演变与思想史';
  const intentRestarted = new ProgressiveLearningStore(root, dependencies);
  const intentResumed = await command<ProgressiveBeginReply>(intentRestarted, { op: 'begin', projectNoteId: quantitativeNote.id,
    sourcePackets: [{ ...quantitativeSource, text: '替换参数不完整的临时资料。' }] }, 12);
  assert.deepEqual(intentResumed.course.generation.writingPolicy, quantitativePolicy);
  assert.equal(intentResumed.course.generation.requestId, quantitativeBegin.course.generation.requestId);
  assert.equal(intentResumed.course.generation.rawDraft, quantitativeRaw);
  assert.equal(intentResumed.course.generation.bodyDraft, quantitativePrefix);
  assert.deepEqual(JSON.parse(progressiveGenerationRequest(intentResumed.course,
    { title: 'Python程序', rootTitle: '操作与部署' }).userInput).inlineVisualDesign, frozenIntent);
  const replacedContext = structuredClone(intentResumed.course);
  replacedContext.sourcePackets = [{ ...quantitativeSource, text: '在当前视图中暂时没有可读公式。' }];
  assert.deepEqual(JSON.parse(progressiveGenerationRequest(replacedContext).userInput).inlineVisualDesign, frozenIntent,
    'temporary source visibility cannot reselect the frozen request intent');
  const intentDisk = JSON.parse(await fs.readFile(stateFile(quantitativeNote.id), 'utf8'));
  assert.deepEqual(intentDisk.generation.writingPolicy, quantitativePolicy);
  intentRestarted.releaseOwner(12);
  assert.equal(JSON.parse(scienceRequest.userInput).inlineVisualDesign, undefined,
    'a qualitative science reservation with no explicit relation remains valid without a quantitative plan');
  checks.push('V6仅对预算内显式数值关系冻结定量绘图意图，额外输入不超过220字符；无条件、超预算或非理化不规划；重启及标题/临时资料变化不重选；V1–V5无新增输入');
  await command(store, { op: 'checkpoint', lease: initial.lease!, checkpoint: { sequence: 1, plan, rawDraft: raw, bodyDraft: prefix } });
  await command(store, { op: 'interrupt', lease: initial.lease!, error: '合成网络中断' }); store.releaseOwner(1);
  project.title = '化学反应';
  const restarted = new ProgressiveLearningStore(root, dependencies);
  const resumed = await begin(restarted, project.id, 2);
  assert.equal(resumed.course.generation.requestId, initial.course.generation.requestId);
  assert.equal(resumed.course.generation.pageId, initial.course.generation.pageId);
  assert.equal(resumed.course.generation.sequence, 1);
  assert.equal(resumed.course.generation.bodyDraft, prefix); assert.equal(resumed.course.generation.rawDraft, raw);
  assert.deepEqual(resumed.course.generation.writingPolicy, policy);
  assert.ok(progressiveGenerationRequest(resumed.course, { title: '历史演变', rootTitle: '心理学史' }).systemPromptOverride!.endsWith(guidance),
    'resume keeps the reserved style even if the current title or temporary context changes');
  const published = await command<ProgressiveCourse>(restarted, { op: 'publish', lease: resumed.lease!, teaching: {
    sequence: 2, plan, title: '函数极限', body: prefix + suffix, concepts: [], questions: [],
    hook: { id: 'hook-main-1', kind: 'reflection', prompt: '为什么函数在一点未定义仍可讨论极限？' },
  } }, 2);
  const firstHash = published.pages![0].contentHash;
  const next = await command<ProgressiveBeginReply>(restarted, { op: 'next', projectNoteId: project.id, request: {
    environmentId: published.environmentId, courseId: published.id, expectedRevision: published.revision,
    requestId: 'new-history-page', intent: 'mainline', fromPageId: 'main-1',
  } }, 2);
  assert.deepEqual(next.course.generation.writingPolicy?.teachingTypes, ['history']);
  assert.equal(next.course.pages![0].contentHash, firstHash);
  const savedFirst = await command<ProgressiveCourse>(restarted, { op: 'read-page', projectNoteId: project.id, pageId: 'main-1' }, 2);
  assert.equal(savedFirst.page!.body, prefix + suffix);
  const shared = shareProgressiveTeaching(savedFirst);
  assert.ok(!JSON.stringify(shared).includes('writingPolicy'));
  assert.ok(!JSON.stringify(shared).includes('teachingTypes'));
  assert.ok(sharedTeachingMarkdown(shared).includes(prefix + suffix));
  const state = JSON.parse(await fs.readFile(stateFile(project.id), 'utf8'));
  assert.deepEqual(state.generation.writingPolicy, next.course.generation.writingPolicy);
  checks.push('真实存储固定文风路由、同请求中断恢复、按新页重新选择；已发布正文/哈希及Markdown分享不变');

  // Simulate all three relevant pre-upgrade checkpoint shapes on disk. No
  // optional field is retrofitted, including a request with no received token.
  for (const draft of [
    { id: 'legacy-empty', rawDraft: '', bodyDraft: '' },
    { id: 'legacy-plan', rawDraft: `@@PLAN\n${JSON.stringify(plan)}`, bodyDraft: '' },
    { id: 'legacy-body', rawDraft: raw, bodyDraft: prefix },
  ]) {
    const target = note(draft.id, '函数极限'); notes.set(target.id, target);
    const seeded = await begin(store, target.id, 3);
    if (draft.rawDraft) await command(store, { op: 'checkpoint', lease: seeded.lease!,
      checkpoint: { sequence: 1, plan, rawDraft: draft.rawDraft, bodyDraft: draft.bodyDraft } }, 3);
    await command(store, { op: 'interrupt', lease: seeded.lease! }, 3); store.releaseOwner(3);
    const legacyState = JSON.parse(await fs.readFile(stateFile(target.id), 'utf8'));
    delete legacyState.generation.writingPolicy;
    delete legacyState.generation.figurePolicy;
    await fs.writeFile(stateFile(target.id), JSON.stringify(legacyState));
    const reopened = new ProgressiveLearningStore(root, dependencies);
    const old = await begin(reopened, target.id, 4);
    assert.equal(old.course.generation.writingPolicy, undefined, draft.id);
    assert.equal(old.course.generation.requestId, seeded.course.generation.requestId, draft.id);
    assert.equal(old.course.generation.bodyDraft, draft.bodyDraft, draft.id);
    assert.equal(old.course.generation.rawDraft, draft.rawDraft, draft.id);
    assert.equal(progressiveGenerationRequest(old.course).systemPromptOverride, legacyPrompt(old.course), draft.id);
    const disk = JSON.parse(await fs.readFile(stateFile(target.id), 'utf8'));
    assert.equal(disk.generation.writingPolicy, undefined, draft.id);
    reopened.releaseOwner(4);
  }
  checks.push('旧空草稿、仅主线草稿与已有正文均保持原提示词逐字不变、原请求和检查点不重建');

  // Existing versioned reservations are real durable requests, not missing-
  // policy records. V1–V5 must not pick up V6 when explicitly resumed,
  // including science pages where the latest specialty changed.
  for (const version of [1, 2, 3, 4, 5] as const) for (const type of ['mathematics', 'science'] as const) {
    const reservedPolicy: ProgressiveWritingPolicy = { version, teachingTypes: [type] };
    const reservedGuidance = progressiveWritingGuidance(reservedPolicy);
    for (const draft of [
      { id: `v${version}-${type}-empty`, rawDraft: '', bodyDraft: '' },
      { id: `v${version}-${type}-plan`, rawDraft: `@@PLAN\n${JSON.stringify(plan)}`, bodyDraft: '' },
      { id: `v${version}-${type}-body`, rawDraft: raw, bodyDraft: prefix },
    ]) {
      const target = note(draft.id, '函数极限'); notes.set(target.id, target);
      const seeded = await begin(store, target.id, 8);
      if (draft.rawDraft) await command(store, { op: 'checkpoint', lease: seeded.lease!,
        checkpoint: { sequence: 1, plan, rawDraft: draft.rawDraft, bodyDraft: draft.bodyDraft } }, 8);
      await command(store, { op: 'interrupt', lease: seeded.lease! }, 8); store.releaseOwner(8);
      const reservedState = JSON.parse(await fs.readFile(stateFile(target.id), 'utf8'));
      reservedState.generation.writingPolicy = reservedPolicy;
      delete reservedState.generation.figurePolicy;
      await fs.writeFile(stateFile(target.id), JSON.stringify(reservedState));
      target.title = 'Python编程与调试';
      const reopened = new ProgressiveLearningStore(root, dependencies);
      const old = await begin(reopened, target.id, 9);
      assert.deepEqual(old.course.generation.writingPolicy, reservedPolicy, draft.id);
      assert.equal(old.course.generation.requestId, seeded.course.generation.requestId, draft.id);
      assert.equal(old.course.generation.pageId, seeded.course.generation.pageId, draft.id);
      assert.equal(old.course.generation.sequence, draft.rawDraft ? 1 : 0, draft.id);
      assert.equal(old.course.generation.bodyDraft, draft.bodyDraft, draft.id);
      assert.equal(old.course.generation.rawDraft, draft.rawDraft, draft.id);
      const request = progressiveGenerationRequest(old.course, { title: target.title, rootTitle: '代码实践' });
      assert.equal(request.systemPromptOverride, legacyPrompt(old.course) + reservedGuidance, draft.id);
      assert.equal(JSON.parse(request.userInput).inlineVisualDesign, undefined,
        'old reserved requests never acquire a new curve-planning input');
      assert.ok(!request.systemPromptOverride!.endsWith(type === 'science' ? inlineScience : inlineMath), draft.id);
      const disk = JSON.parse(await fs.readFile(stateFile(target.id), 'utf8'));
      assert.deepEqual(disk.generation.writingPolicy, reservedPolicy, draft.id);
      reopened.releaseOwner(9);
    }
  }
  checks.push('旧V1/V2/V3/V4/V5数学和理化任务的空草稿、仅主线和正文重启后沿用各自冻结指导；标题变更不重选，不升级到V6、补入选图字段或替换原草稿');

  const adaptiveNote = note('adaptive-style-route', '函数极限'); notes.set(adaptiveNote.id, adaptiveNote);
  const autoInitial = await begin(store, adaptiveNote.id, 6);
  const autoReady = await command<ProgressiveCourse>(store, { op: 'publish', lease: autoInitial.lease!, teaching: {
    sequence: 1, plan, title: plan.pages[0].title, body: prefix + suffix, concepts: [], questions: [],
    hook: { id: 'hook-auto', kind: 'reflection', prompt: '怎样区分函数定义与极限存在？' },
  } }, 6);
  const autoFirstHash = autoReady.pages![0].contentHash;
  const restatement = '我把函数在一点是否有定义和极限是否存在混为一谈。';
  const withFeedback = await command<ProgressiveCourse>(store, { op: 'save-progress', projectNoteId: adaptiveNote.id,
    progress: { environmentId: autoReady.environmentId, courseId: autoReady.id,
      expectedProgressVersion: autoReady.progress.version, patch: { restatementDraft: restatement,
        restatementSpans: [{ pageId: 'main-1', start: 0, end: restatement.length }] } } }, 6);
  const autoReserved = await command<ProgressiveBeginReply>(store, { op: 'next', projectNoteId: adaptiveNote.id,
    request: { environmentId: autoReady.environmentId, courseId: autoReady.id, expectedRevision: withFeedback.revision,
      requestId: 'auto-mixed-writing', intent: 'auto', fromPageId: 'main-1' } }, 6);
  assert.equal(autoReserved.course.generation.routePending, true);
  assert.ok(autoReserved.course.generation.pageId.startsWith('extra-'));
  const autoPolicy = structuredClone(autoReserved.course.generation.writingPolicy!);
  assert.deepEqual(new Set(autoPolicy.teachingTypes), new Set(['mathematics', 'history']),
    'auto routing reserves both the source-page and next-mainline teaching styles before the model chooses');
  const autoGuidance = progressiveWritingGuidance(autoPolicy);
  const routed = await command<ProgressiveBeginReply>(store, { op: 'route', lease: autoReserved.lease!,
    route: { kind: 'mainline', reason: '在下一历史主线中用简短条件辨析承接，保留原页。' } }, 6);
  assert.equal(routed.course.generation.pageId, 'main-2');
  assert.equal(routed.lease!.pageId, 'main-2', 'route reply rebinds the lease to the actual destination page');
  assert.equal(routed.course.generation.requestId, autoReserved.course.generation.requestId);
  assert.deepEqual(routed.course.generation.writingPolicy, autoPolicy,
    'page/lease rebinding must not silently narrow or reselect a running request policy');
  const routedPrefix = '## 历史演变\n\n比较不同阶段之前，先区分时间先后与论点之间的因果关系。';
  const routedRaw = '@@LESSON\n' + routedPrefix;
  await command(store, { op: 'checkpoint', lease: routed.lease!, checkpoint: {
    sequence: 1, rawDraft: routedRaw, bodyDraft: routedPrefix,
  } }, 6);
  await command(store, { op: 'interrupt', lease: routed.lease!, error: '跨学科编排后的合成中断' }, 6);
  store.releaseOwner(6);
  adaptiveNote.title = 'Python代码调试';
  const autoReopened = new ProgressiveLearningStore(root, dependencies);
  const autoResumed = await begin(autoReopened, adaptiveNote.id, 7);
  assert.equal(autoResumed.course.generation.routePending, false);
  assert.equal(autoResumed.course.generation.route?.kind, 'mainline');
  assert.equal(autoResumed.course.generation.requestId, autoReserved.course.generation.requestId);
  assert.equal(autoResumed.course.generation.pageId, 'main-2');
  assert.equal(autoResumed.course.generation.bodyDraft, routedPrefix);
  assert.equal(autoResumed.course.generation.rawDraft, routedRaw);
  assert.deepEqual(autoResumed.course.generation.writingPolicy, autoPolicy);
  assert.ok(progressiveGenerationRequest(autoResumed.course, { title: adaptiveNote.title,
    rootTitle: '物理化学' }).systemPromptOverride!.endsWith(autoGuidance));
  assert.equal(autoResumed.course.pages![0].contentHash, autoFirstHash);
  const autoOriginal = await command<ProgressiveCourse>(autoReopened, { op: 'read-page',
    projectNoteId: adaptiveNote.id, pageId: 'main-1' }, 7);
  assert.equal(autoOriginal.page!.body, prefix + suffix);
  autoReopened.releaseOwner(7);
  checks.push('跨学科自动编排、页面/lease改绑、中断重启沿用同一文风，不重新推断；已发布原页及哈希不变');

  const resetNote = note('reset-course', '函数极限'); notes.set(resetNote.id, resetNote);
  const resetBegin = await begin(store, resetNote.id, 5);
  const singlePlan: ProgressiveMainline = { title: '函数极限', objectives: ['解释趋近'], pages: [plan.pages[0]] };
  const ready = await command<ProgressiveCourse>(store, { op: 'publish', lease: resetBegin.lease!, teaching: {
    sequence: 1, plan: singlePlan, title: '函数极限', body: prefix + suffix, concepts: [], questions: [],
    hook: { id: 'hook-reset', kind: 'reflection', prompt: '请解释本页关键关系。' },
  } }, 5);
  const reset = await command<ProgressiveCourse>(store, { op: 'delete-page', projectNoteId: resetNote.id,
    environmentId: ready.environmentId, courseId: ready.id, pageId: 'main-1', expectedHash: ready.pages![0].contentHash }, 5);
  assert.notEqual(reset.generation.requestId, resetBegin.course.generation.requestId);
  assert.equal(reset.generation.status, 'prepared'); assert.equal(reset.generation.bodyDraft, '');
  assert.equal(reset.generation.writingPolicy?.version, 6);
  assert.deepEqual(reset.generation.writingPolicy?.teachingTypes, ['mathematics']);
  checks.push('删除全部页面后的显式新请求也获得新文风；既有课程无隐式迁移或重生成');

  const receipt = { status: 'passed', root, remoteCalls: 0, syntheticOnly: true,
    maxGuidanceChars, guidanceCharsByVersion, checks };
  await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
} finally { globalThis.fetch = originalFetch; }
