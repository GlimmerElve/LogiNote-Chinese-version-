import assert from 'node:assert/strict';
import type { TeachingBlueprint, TextbookChapter, TextbookContext, TextbookJob, TextbookSource } from '../src/services/textbook/generationTypes';
import { TEXTBOOK_CHAPTER_SECTIONS } from '../src/services/textbook/generationTypes';
import { assembleTeachingBlueprint } from '../src/services/textbook/blueprint';
import { allocateTextbookTeaching, textbookContinuitySummary, TEXTBOOK_COMPACT_REVIEW_GUIDANCE, textbookTeachingReviewPrompt } from '../src/services/textbook/teachingPlan';
import { assembleTextbook, validateBlueprint, validateChapter, validateTextbookContent } from '../src/services/textbook/validation';
import { chapterInputIdentity } from '../src/services/textbook/repair';
import { mergeTextbookSectionRepair } from '../src/services/textbook/sectionRepair';
import { acceptTextbookReview, planTextbookReview } from '../src/services/textbook/reviewCache';
import { defaultTextbookModelPolicy } from '../src/services/textbook/modelPolicy';
import { textbookVisualGuidance } from '../src/services/textbook/visualGuidance';
import { TEXTBOOK_BLUEPRINT_PROMPT, TEXTBOOK_CHAPTER_PROMPT, TEXTBOOK_SECTION_REPAIR_PROMPT } from '../src/workflows/textbookPrompt';
import { textbookRestatementWritingPrompt, TEXTBOOK_RESTATEMENT_WRITING_GUIDANCE, TEXTBOOK_RESTATEMENT_REVIEW_GUIDANCE } from '../src/services/textbook/restatement';

const context: TextbookContext = { project: { id: 'p', rootId: 'r', title: '选择过载', rootTitle: '行为科学', tasks: ['解释条件并作迁移判断'], knowledgeTitles: ['选择过载'] },
  profile: '', preferences: {}, personal: [], mastery: {}, warnings: [] };
const sources: TextbookSource[] = [{ sourceId: 'N1', kind: 'knowledge', id: 'k1', title: '选择过载', version: 'v1', text: '选项增加的结果取决于条件，不能推断选项更多一定更差。' }];
const book = (count = 3): TeachingBlueprint => ({ title: '选择过载：概念、机制和应用', objectives: [{ id: 'O1', text: '解释条件并作迁移判断' }], focuses: [],
  chapters: Array.from({ length: count }, (_, i) => ({ id: `ch${i + 1}`, title: `讲授阶段${i + 1}`, objectiveIds: ['O1'], focusIds: [], sourceIds: ['N1'], bridge: '从概念条件逐步转入实际判断。', visuals: [] })) });
const fullChapter = (id: string): TextbookChapter => ({ id, sections: {
  explanation: '选项增加的结果取决于具体条件，不宜直接断言必然造成过载。[N1]',
  boundaries: '应分别核对偏好是否明确、比较任务是否复杂，不把不同条件混为一谈。[N1]',
  workedExample: '假设情境：比较熟悉商品与复杂产品，先说明差异，再按条件判断。[N1]',
  practice: '面对新的购物情境，列出已知条件及仍缺失的信息，再说明能作何判断。',
  answer: '先核对条件再判断，数量单独不能决定结果，缺少的信息应保留为未知。[N1]',
  selfCheck: '能够区分有条件结论与绝对化结论，并说明每个判断所依据的条件。',
  summary: '从概念辨析进入新情境，关键是核对条件，不把可能性写成必然性。',
} });
function compactChapters(blueprint: TeachingBlueprint): TextbookChapter[] {
  return blueprint.chapters.map(plan => {
    const chapter = fullChapter(plan.id);
    for (const section of TEXTBOOK_CHAPTER_SECTIONS) if (!plan.writingPlan!.sections.includes(section)) chapter.sections[section] = '';
    return chapter;
  });
}
function job(blueprint: TeachingBlueprint, chapters = compactChapters(blueprint)): TextbookJob {
  return { schemaVersion: 1, id: 'synthetic-pacing', stage: 'chapters', createdAt: '2026-10-16', updatedAt: '2026-10-16', attempt: 1,
    spec: { schemaVersion: 1, projectNoteId: 'p', rootProjectId: 'r', projectTitle: '选择过载', planningHash: '', allowedDocIds: [], documentHashes: {}, knowledgeHashes: { k1: 'v1' }, providerHash: '', allowCloud: false, modelPolicy: defaultTextbookModelPolicy() },
    checkpoint: { context, sources, blueprint, chapters } };
}
let groups = 0;
const pass = (message: string) => { groups++; console.log(`PASS ${message}`); };
const raw = book(); const original = structuredClone(raw);
const focused = assembleTeachingBlueprint(raw, context, sources, true);
assert.deepEqual(raw, original);
assert.deepEqual(focused.teachingPlan, { version: 1, depth: 'focused', targetChars: 4500 });
assert.equal(focused.chapters.reduce((sum, chapter) => sum + chapter.writingPlan!.targetChars, 0), 4500);
assert.deepEqual(focused.chapters.map(chapter => chapter.writingPlan!.sections), [
  ['explanation', 'boundaries', 'workedExample', 'selfCheck'], ['explanation', 'workedExample', 'selfCheck'], ['explanation', 'practice', 'answer', 'selfCheck', 'summary'],
]);
assert.deepEqual(focused.objectives, original.objectives);
pass('新蓝图默认4500字、章节按全书分工，总分配一致；不新增目标、不修改输入蓝图');

const noisy = book(2);
noisy.teachingPlan = { version: 1, depth: 'focused', targetChars: 12000 };
noisy.chapters[0].writingPlan = { targetChars: 80000, sections: ['answer', 'answer', 'script'] as never };
noisy.chapters[1].writingPlan = { targetChars: NaN, sections: [] };
const normalized = assembleTeachingBlueprint(noisy, context, sources, true);
assert.equal(normalized.teachingPlan!.targetChars, 5500);
assert.ok(normalized.chapters[0].writingPlan!.sections.includes('practice'));
assert.ok(!JSON.stringify(normalized).includes('script'));
validateBlueprint(normalized, context, sources);
const undersized = book(); undersized.teachingPlan = { version: 1, depth: 'focused', targetChars: 1 };
allocateTextbookTeaching(undersized); assert.equal(undersized.teachingPlan!.targetChars, 3500);
pass('过大/过小/缺失篇幅提示本地归一化，非法小节提示忽略、练习答案成对，教学环节在全书覆盖');

const extended = book(6); extended.teachingPlan = { version: 1, depth: 'extended', targetChars: 7200 };
extended.chapters[1].reasoning = 'derivation';
allocateTextbookTeaching(extended); validateBlueprint(extended, context, sources);
assert.equal(extended.chapters.reduce((sum, chapter) => sum + chapter.writingPlan!.targetChars, 0), 7200);
assert.ok(extended.chapters[1].writingPlan!.targetChars > extended.chapters[0].writingPlan!.targetChars);
assert.equal(defaultTextbookModelPolicy().stages.chapter.maxTokens, 12000);
assert.equal(defaultTextbookModelPolicy().stages.chapter.retryMaxTokens, 24000);
pass('综合教材按7200字分配，复杂推导可多分篇幅；既有计算/截断预算不下降、不放宽');

const visual = book(); visual.chapters[1].visuals = [{ format: 'flowchart', section: 'boundaries', purpose: '逐项判断条件', readingQuestion: '下一步核对哪个条件？' }];
visual.chapters[1].writingPlan = { targetChars: 1500, sections: ['explanation'] };
const visualBook = assembleTeachingBlueprint(visual, context, sources, true);
assert.ok(visualBook.chapters[1].writingPlan!.sections.includes('boundaries'));
assert.deepEqual(visualBook.chapters[1].visuals, visual.chapters[1].visuals);
assert.equal(textbookVisualGuidance(visualBook, 'ch2').targets[0].format, 'flowchart');
pass('图示计划对应的小节自动保留，不因精简丢图，不强迫覆盖所有绘图插件');

const chapters = compactChapters(focused);
chapters.forEach((chapter, i) => validateChapter(chapter, chapter.id, ['N1'], [], focused.chapters[i].writingPlan));
for (const section of focused.chapters[0].writingPlan!.sections) {
  const missing = structuredClone(chapters[0]); missing.sections[section] = '';
  if (section === 'selfCheck') validateChapter(missing, missing.id, ['N1'], [], focused.chapters[0].writingPlan);
  else assert.throws(() => validateChapter(missing, missing.id, ['N1'], [], focused.chapters[0].writingPlan));
}
const unsafe = structuredClone(chapters[0]); unsafe.sections.practice = '<script>这是没有选择的小节里的非法内容，仍必须阻断。</script>';
assert.throws(() => validateChapter(unsafe, unsafe.id, ['N1'], [], focused.chapters[0].writingPlan), /控制块/u);
const undefinedSlot = structuredClone(chapters[0]); delete (undefinedSlot.sections as Partial<TextbookChapter['sections']>).summary;
validateChapter(undefinedSlot, undefinedSlot.id, ['N1'], [], focused.chapters[0].writingPlan);
assert.equal(undefinedSlot.sections.summary, '');
pass('未选小节缺键在本地补空，选定教学内容仍须完整；非空未选小节的安全问题不能绕过校验');

const lastPlan = focused.chapters.at(-1)!;
assert.ok(!lastPlan.writingPlan!.sections.includes('workedExample'));
for (const value of [undefined, null, '', '见上章', '参见前文。', '本节略', '不适用']) {
  const last = structuredClone(chapters.at(-1)!);
  if (value === undefined) delete (last.sections as Partial<TextbookChapter['sections']>).workedExample;
  else (last.sections as Record<string, unknown>).workedExample = value;
  validateChapter(last, last.id, ['N1'], [], lastPlan.writingPlan);
  assert.equal(last.sections.workedExample, '');
  const bookChapters = [...chapters.slice(0, -1), last];
  const body = assembleTextbook(focused, bookChapters, sources);
  validateTextbookContent(job(focused, bookChapters), body);
  assert.equal((body.match(/### 例子与反例/gu) || []).length, 2, 'No empty optional heading in the final chapter');
  assert.deepEqual(last.sections.practice, chapters.at(-1)!.sections.practice);
}
pass('末章案例缺键/null/空占位全部本地兼容，组装、全书校验和章节正文完整保留');

const shortOptional = structuredClone(chapters.at(-1)!);
shortOptional.sections.workedExample = '按条件判断。[N1]';
validateChapter(shortOptional, shortOptional.id, ['N1'], [], lastPlan.writingPlan);
assert.equal(shortOptional.sections.workedExample, '按条件判断。[N1]', 'Keep real short prose exact');
for (const invalid of ['按条件判断。', '按条件判断。[N999]', '见上章[C1]', '<b>见上章</b>', '```chart\n{}\n```', {}, [], 0, false, '字'.repeat(14001)]) {
  const candidate = structuredClone(chapters.at(-1)!);
  (candidate.sections as Record<string, unknown>).workedExample = invalid;
  assert.throws(() => validateChapter(candidate, candidate.id, ['N1'], [], lastPlan.writingPlan));
}
const atomicNormalization = structuredClone(chapters.at(-1)!);
delete (atomicNormalization.sections as Partial<TextbookChapter['sections']>).boundaries;
atomicNormalization.sections.answer = '错误引用。[N999]';
assert.throws(() => validateChapter(atomicNormalization, atomicNormalization.id, ['N1'], [], lastPlan.writingPlan));
assert.equal(Object.hasOwn(atomicNormalization.sections, 'boundaries'), false, 'Failed validation must not partly mutate a draft');
pass('真实短正文保留且检查引用；未选小节的非法格式/来源/隐私/超长仍阻断，失败不部分改写草稿');

for (const value of [undefined, null, '', '见上章', '按条件判断。[N1]']) {
  const candidate = structuredClone(chapters.at(-1)!);
  if (value === undefined) delete (candidate.sections as Partial<TextbookChapter['sections']>).explanation;
  else (candidate.sections as Record<string, unknown>).explanation = value;
  assert.throws(() => validateChapter(candidate, candidate.id, ['N1'], [], lastPlan.writingPlan), /explanation.*必填/u);
}
pass('最低字数仅约束蓝图选定小节，必填项缺失/null/空占位/过短继续阻断且明确报错');

chapters[0].sections.explanation += '\n\n$$k < 1/9$$\n\n```mermaid\nflowchart LR\nV1["核对条件"] --> V2["说明判断"]\n```';
const current = job(focused, chapters);
const markdown = assembleTextbook(focused, chapters, sources);
validateTextbookContent(current, markdown);
assert.equal((markdown.match(/### 迁移练习/gu) || []).length, 1);
assert.equal((markdown.match(/### 自检/gu) || []).length, 0);
assert.equal((markdown.match(/### 试着复述/gu) || []).length, focused.chapters.length);
assert.equal((markdown.match(/### 学习小结/gu) || []).length, 1);
assert.ok(!markdown.includes('### 本章小结'));
assert.ok(markdown.includes('$$k < 1/9$$') && markdown.includes('```mermaid'));
assert.ok(!/### [^\n]+\n\n### /u.test(markdown));
const long = structuredClone(chapters[0]); long.sections.explanation += '\n\n' + '必要解释。'.repeat(1000);
validateChapter(long, long.id, ['N1'], [], focused.chapters[0].writingPlan);
pass('实际教材组装逐章复述、仅一组练习/总结，保留公式和Mermaid；超过软字数不触发失败');

assert.ok(textbookContinuitySummary(chapters[0])!.startsWith('上一章讲解摘录'));
assert.ok(textbookContinuitySummary(chapters[0])!.length < 1100);
const beforeHash = chapterInputIdentity(current, focused.chapters[1]);
const changed = structuredClone(current); changed.checkpoint.chapters![0].sections.explanation = '前一章已修改，需要更新后续承接。' + changed.checkpoint.chapters![0].sections.explanation;
assert.notEqual(chapterInputIdentity(changed, focused.chapters[1]), beforeHash);
assert.equal(textbookContinuitySummary(fullChapter('old')), fullChapter('old').sections.summary);
pass('不强迫生成逐章小结：下一章复用有界原文摘录；前章实际内容改变仍使承接检查点失效，旧摘要原样保留');

const full = { context, sources, blueprint: focused, chapters };
const plan = await planTextbookReview(current, full);
acceptTextbookReview(current, plan, { schemaVersion: 3, passed: true, findings: [] }, full);
assert.equal((await planTextbookReview(current, full)).cachedQuality!.passed, true);
const patched = mergeTextbookSectionRepair(chapters[2], ['answer'], { id: chapters[2].id, sections: { answer: '先依据条件作判断，再保留未知信息，不把选项增多写成必然更差。[N1]' } });
validateChapter(patched, patched.id, ['N1'], [], focused.chapters[2].writingPlan);
const revisedChapters = chapters.map(chapter => chapter.id === patched.id ? patched : chapter);
assert.equal((await planTextbookReview(current, { ...full, chapters: revisedChapters })).scoped, true);
assert.equal(patched.sections.boundaries, '');
pass('精简结构支持同任务复核缓存和定点小节修复；未选小节不会被补写，未修改章节仍复用');

const legacy = book();
assert.deepEqual(assembleTeachingBlueprint(legacy, context, sources), legacy);
const legacyChapter = fullChapter('ch1'); validateChapter(legacyChapter, 'ch1', ['N1']);
const validLegacyBytes = JSON.stringify(legacyChapter); validateChapter(legacyChapter, 'ch1', ['N1']);
assert.equal(JSON.stringify(legacyChapter), validLegacyBytes);
legacyChapter.sections.summary = '';
assert.throws(() => validateChapter(legacyChapter, 'ch1', ['N1']));
const missingLegacy = fullChapter('ch1'); delete (missingLegacy.sections as Partial<TextbookChapter['sections']>).workedExample;
assert.throws(() => validateChapter(missingLegacy, 'ch1', ['N1']), /workedExample.*必填/u);
assert.ok(!legacy.teachingPlan && !legacy.chapters[0].writingPlan);
assert.equal(textbookTeachingReviewPrompt('legacy-criteria', legacy), 'legacy-criteria');
assert.ok(textbookTeachingReviewPrompt('base-criteria', focused).includes(TEXTBOOK_COMPACT_REVIEW_GUIDANCE));
pass('没有新分配元数据的旧蓝图/章节按原结构验证，读取和续跑不迁移、不清空已保存内容');

for (const value of [undefined, null, '', '见上章', '为什么？', '对应任务：解释条件\n不看教材，说明哪些条件会影响判断？']) {
  const candidate = structuredClone(chapters[0]);
  if (value === undefined) delete (candidate.sections as Partial<TextbookChapter['sections']>).selfCheck;
  else (candidate.sections as Record<string, unknown>).selfCheck = value;
  validateChapter(candidate, candidate.id, ['N1'], [], focused.chapters[0].writingPlan);
  assert.equal(candidate.sections.selfCheck, value == null || value === '见上章' ? '' : value);
  assembleTextbook(focused, [candidate, ...chapters.slice(1)], sources);
}
for (const value of ['问题[N999]', '<script>x</script>', '个人记录[C1]', '- [ ] 勾选任务', '```chart\n{}\n```', {}, []]) {
  const candidate = structuredClone(chapters[0]); (candidate.sections as Record<string, unknown>).selfCheck = value;
  assert.throws(() => validateChapter(candidate, candidate.id, ['N1'], [], focused.chapters[0].writingPlan));
}
for (const chapter of focused.chapters) {
  assert.equal(chapter.writingPlan!.restatement, 1);
  assert.ok(textbookRestatementWritingPrompt(TEXTBOOK_CHAPTER_PROMPT, chapter).endsWith(TEXTBOOK_RESTATEMENT_WRITING_GUIDANCE));
  assert.ok(textbookRestatementWritingPrompt(TEXTBOOK_SECTION_REPAIR_PROMPT, chapter).endsWith(TEXTBOOK_RESTATEMENT_WRITING_GUIDANCE));
  assert.equal(textbookRestatementWritingPrompt(TEXTBOOK_SECTION_REPAIR_PROMPT, chapter, ['answer']), TEXTBOOK_SECTION_REPAIR_PROMPT);
  assert.ok(textbookRestatementWritingPrompt(TEXTBOOK_SECTION_REPAIR_PROMPT, chapter, ['selfCheck']).endsWith(TEXTBOOK_RESTATEMENT_WRITING_GUIDANCE));
}
assert.ok(textbookTeachingReviewPrompt('base', focused).endsWith(TEXTBOOK_RESTATEMENT_REVIEW_GUIDANCE));
const frozenCompact = structuredClone(focused); frozenCompact.chapters.forEach(chapter => { delete chapter.writingPlan!.restatement; });
assert.equal(textbookRestatementWritingPrompt('old-writing-prompt', frozenCompact.chapters[0]), 'old-writing-prompt');
assert.equal(textbookTeachingReviewPrompt('old-review-prompt', frozenCompact), `old-review-prompt\n${TEXTBOOK_COMPACT_REVIEW_GUIDANCE}`);
assert.ok(assembleTextbook(frozenCompact, chapters, sources).includes('### 自检'));
assert.throws(() => validateChapter({ ...chapters[0], sections: { ...chapters[0].sections, selfCheck: '' } }, chapters[0].id, ['N1'], [], frozenCompact.chapters[0].writingPlan), /selfCheck.*必填/u);
for (const chunk of markdown.split(/^## \d+\. /mu).slice(1)) {
  const headings = [...chunk.matchAll(/^### (.+)$/gmu)].map(match => match[1]);
  assert.equal(headings.at(-1), '试着复述');
}
pass('逐章复述沿用selfCheck七键，缺失/null/短提示不阻断；真实内容仍过安全门，旧精简蓝图提示/顺序/校验完全兼容');

for (const phrase of ['2–3 章', '3,500–5,500', '6,000–8,500', '不以根项目标题扩张', '不要求每章重复七套', 'writingPlan']) assert.ok(TEXTBOOK_BLUEPRINT_PROMPT.includes(phrase), phrase);
assert.ok(!TEXTBOOK_CHAPTER_PROMPT.includes('8,000–12,000'));
assert.ok(TEXTBOOK_CHAPTER_PROMPT.includes('空字符串') && TEXTBOOK_CHAPTER_PROMPT.includes('字数是软目标'));
assert.ok(TEXTBOOK_SECTION_REPAIR_PROMPT.includes('不把短答案、自检或小结扩成300–900字'));
assert.ok(TEXTBOOK_COMPACT_REVIEW_GUIDANCE.includes('不要仅因'));
pass('设计、写作、修订、复核统一全书分工；字数偏差不是新的重生成门槛');
console.log(`textbook pacing: ${groups} groups passed; synthetic data, no model/network/user vault`);
