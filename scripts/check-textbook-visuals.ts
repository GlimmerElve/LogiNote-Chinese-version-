import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { textbookVisualGuidance } from '../src/services/textbook/visualGuidance';
import { assembleTeachingBlueprint } from '../src/services/textbook/blueprint';
import { assembleTextbook, validateBlueprint, validateChapter } from '../src/services/textbook/validation';
import { parseTextbookMarkdown } from '../src/services/textbook/markdown';
import { parseControlledTextbookBlock } from '../src/services/textbook/contentSchema';
import { assessTextbookQuality } from '../src/services/textbook/quality';
import { chapterInputIdentity } from '../src/services/textbook/repair';
import { mergeTextbookSectionRepair } from '../src/services/textbook/sectionRepair';
import { defaultTextbookModelPolicy } from '../src/services/textbook/modelPolicy';
import { autoLinkMarkdown } from '../src/services/markdownAutoLink';
import { TEXTBOOK_BLUEPRINT_PROMPT, TEXTBOOK_CHAPTER_PROMPT, TEXTBOOK_SECTION_REPAIR_PROMPT, TEXTBOOK_QUALITY_PROMPT, TEXTBOOK_COMPONENT_CAPABILITIES_PROMPT } from '../src/workflows/textbookPrompt';
import { TEACHING_VISUAL_FORMATS } from '../src/services/textbook/visualGuidance';
import { textbookTimelinePrompt } from '../src/services/textbook/timeline';
import type { TeachingBlueprint, TeachingVisualPlan, TextbookChapter, TextbookContext, TextbookJob, TextbookSource } from '../src/services/textbook/generationTypes';
import { visualMindmap as mindmap, visualBoundaryFlow as boundaryFlow, visualPracticeFlow as practiceFlow, visualFence as fence } from './fixtures/textbook-visuals';
import { visualTimeline } from './fixtures/textbook-visuals';

const context: TextbookContext = { project: { id: 'p', rootId: 'r', title: '学习心理账户', rootTitle: '心理学效应',
  tasks: ['解释心理账户并在新情境中辨析适用条件'], knowledgeTitles: ['心理账户'] },
  profile: '', preferences: {}, personal: [], mastery: {}, warnings: [] };
const sources: TextbookSource[] = [{ sourceId: 'N1', kind: 'knowledge', id: 'k1', title: '心理账户测试原文', version: 'synthetic-v1',
  text: '心理账户涉及对金钱进行心理分类。应区分金钱来源、用途和账户标签；同样金额不必得到同样评价。判断案例前要核对分类和评价的条件，缺少信息时不能确定是否发生该效应。' }];
const book = (count = 3): TeachingBlueprint => ({ title: '心理账户：从分类框架到情境判断', objectives: [{ id: 'O1', text: '区分条件并解释新情境中的判断理由' }], focuses: [],
  chapters: Array.from({ length: count }, (_, i) => ({ id: `ch${i + 1}`, title: `教学步骤${i + 1}`, objectiveIds: ['O1'],
    focusIds: [], sourceIds: ['N1'], bridge: '先辨析条件，再把判断方法用于新情境。' })) });
const chapter = (id: string): TextbookChapter => ({ id, sections: {
  explanation: '心理账户涉及金钱的心理分类，需要区分来源、用途和账户标签。[N1]',
  boundaries: '同样金额不必得到同样评价，须先核对分类与评价条件。[N1]',
  workedExample: '假设情境：比较日常支出与意外收入的用途标签，而不是把假设当研究结论。[N1]',
  practice: '给出一种新情境，先说明已知条件，再识别还缺哪些判断信息。',
  answer: '先列出分类和评价条件；条件不足时只能指出信息缺失，不贸然下结论。[N1]',
  selfCheck: '能够说出分类条件并给出理由，能够保留仍无法判断的事项。',
  summary: '先建立心理分类框架，再核对案例条件，最后迁移判断方法。',
} });
let checks = 0;
function check(name: string, run: () => void) { run(); checks++; console.log(`PASS ${name}`); }

check('旧蓝图默认生成 2–3 幅结构图和一个案例表，分工明确且不修改蓝图', () => {
  for (let count = 2; count <= 6; count++) {
    const blueprint = book(count), original = structuredClone(blueprint);
    const guides = blueprint.chapters.map((plan) => textbookVisualGuidance(blueprint, plan.id));
    assert.deepEqual(blueprint, original);
    assert.ok(guides.every((guide) => guide.origin === 'default' && guide.targets.length <= 2 && guide.nonBlocking));
    const targets = guides.flatMap((guide) => guide.targets);
    assert.equal(targets.filter((item) => item.format === 'table').length, 1);
    assert.equal(targets.filter((item) => item.format !== 'table').length, count === 2 ? 2 : 3);
    assert.equal(guides[0].targets[0].format, 'mindmap');
    assert.ok(guides.at(-1)!.targets.some((item) => item.section === 'practice' && item.purpose.includes('不泄露')));
    assert.ok(!targets.some((item) => item.format === 'chart'), 'No fabricated numeric chart in the default scaffold');
    assert.ok(targets.every((item) => item.purpose && item.readingQuestion));
  }
});

check('模型设计的可视化计划优先，未分配章节不重复套默认图，返回值不共享可变引用', () => {
  const blueprint = book();
  blueprint.chapters[1].visuals = [{ format: 'sequenceDiagram', section: 'workedExample',
    purpose: '呈现材料中明确的参与者交互顺序', readingQuestion: '谁先发起行动，下一步由谁响应？' }];
  assert.equal(textbookVisualGuidance(blueprint, 'ch1').origin, 'blueprint');
  assert.deepEqual(textbookVisualGuidance(blueprint, 'ch1').targets, []);
  const guide = textbookVisualGuidance(blueprint, 'ch2');
  assert.deepEqual(guide.targets, blueprint.chapters[1].visuals);
  guide.targets[0].purpose = 'changed';
  assert.notEqual(blueprint.chapters[1].visuals[0].purpose, 'changed');
  assert.throws(() => textbookVisualGuidance(blueprint, 'unknown'), /不属于/u);
});

check('明确空计划可表示纯文字或证据不足，不强制补图', () => {
  const blueprint = book(); blueprint.chapters.forEach((plan) => { plan.visuals = []; });
  validateBlueprint(blueprint, context, sources);
  for (const plan of blueprint.chapters) assert.deepEqual(textbookVisualGuidance(blueprint, plan.id).targets, []);
  assert.ok(TEXTBOOK_BLUEPRINT_PROMPT.includes('明确要求纯文字'));
});

check('局部修订只收到授权小节的呈现计划，仅修答案不启动补图', () => {
  const blueprint = book();
  assert.deepEqual(textbookVisualGuidance(blueprint, 'ch3', ['answer']).targets, []);
  assert.deepEqual(textbookVisualGuidance(blueprint, 'ch2', ['workedExample']).targets.map((item) => item.section), ['workedExample']);
  assert.equal(textbookVisualGuidance(blueprint, 'ch2', ['boundaries']).targets[0].format, 'flowchart');
  assert.equal(textbookVisualGuidance(blueprint, 'ch2', ['workedExample']).preserveOtherSections, true);
  assert.equal(textbookVisualGuidance(blueprint, 'ch2', ['workedExample']).mode, 'section_repair');
});

check('新视觉元数据有小规模格式白名单，旧蓝图保持兼容，组装器保留设计', () => {
  const blueprint = book();
  const visual: TeachingVisualPlan = { format: 'mindmap', section: 'explanation', purpose: '组织定义和条件', readingQuestion: '哪些分类需要先分清？' };
  blueprint.chapters[0].visuals = [visual];
  validateBlueprint(blueprint, context, sources);
  assert.deepEqual(assembleTeachingBlueprint(blueprint, context, sources), blueprint);
  validateBlueprint(book(), context, sources);
  for (const invalid of [null, [null], [{ ...visual, format: 'html' }], [{ ...visual, section: 'answer' }],
    [{ ...visual, purpose: '<script>' }], [{ ...visual, readingQuestion: '' }], [visual, visual], [visual, visual, visual]]) {
    const bad = structuredClone(blueprint); (bad.chapters[0] as unknown as { visuals: unknown }).visuals = invalid;
    assert.throws(() => validateBlueprint(bad, context, sources));
  }
});

check('蓝图可安排已授权原图，不把图片组件误判为非法格式；缺图/错来源仍拒绝', () => {
  const imageSource: TextbookSource = { sourceId: 'L1', kind: 'document', id: 'doc', title: '公式原图',
    version: 'a'.repeat(64), text: '公式区域待核对', blockId: 'doc:block:1',
    assets: [{ id: 'L1-formula', sourceId: 'L1', docId: 'doc', version: 'a'.repeat(64), blockId: 'doc:block:1', imageIndex: 1001, alt: '原图' }] };
  const blueprint = book(); blueprint.chapters[0].sourceIds.push('L1');
  blueprint.chapters[0].visuals = [{ format: 'textbook-image', section: 'explanation', purpose: '对照分式原图核对上下排列', readingQuestion: '分子和分母分别是什么？' }];
  validateBlueprint(blueprint, context, [...sources, imageSource]);
  assert.equal(textbookVisualGuidance(blueprint, 'ch1').targets[0].format, 'textbook-image');
  const absent = { ...imageSource, assets: [] };
  assert.throws(() => validateBlueprint(blueprint, context, [...sources, absent]), /没有已采集/u);
  const wrong = structuredClone(imageSource); wrong.assets![0].version = 'b'.repeat(64);
  assert.throws(() => validateBlueprint(blueprint, context, [...sources, wrong]), /没有已采集/u);
  const outOfChapter = structuredClone(blueprint); outOfChapter.chapters[0].sourceIds = ['N1'];
  assert.throws(() => validateBlueprint(outOfChapter, context, [...sources, imageSource]), /没有已采集/u);
});

const illustrated = book().chapters.map((plan) => chapter(plan.id));
illustrated[0].sections.explanation += '\n\n观察问题：哪些分类需要分清，哪些信息决定判断是否充分？\n\n'
  + fence('mermaid', mindmap) + '\n\n读图要点：先看分类信息，再看判断边界；树形连线表示组织关系，不表示因果。请沿一个分支说明要核对的条件。[N1]';
illustrated[1].sections.boundaries += '\n\n观察问题：缺少信息时，判断路径应停在哪里？\n\n'
  + fence('mermaid', boundaryFlow) + '\n\n读图要点：菱形节点只核对信息是否明确；缺失时先补充，而不是猜测。请解释“否”分支为何不能直接下结论。[N1]';
illustrated[1].sections.workedExample += '\n\n观察问题：两个假设案例的已知条件和未知信息有哪些差异？\n\n'
  + '| 假设案例 | 已知条件 | 仍需核对 |\n| --- | --- | --- |\n| 日常支出 | 用途标签明确 | 评价条件 |\n| 意外收入 | 来源标签明确 | 评价条件 |'
  + '\n\n读图要点：同一列比较同一种信息；标签差异不等于评价结果必然不同。请指出两个案例共有的未知事项。[N1]';
illustrated[2].sections.practice += '\n\n观察问题：开始迁移练习时，先做哪一步？\n\n' + fence('mermaid', practiceFlow)
  + '\n\n读图要点：按步骤组织理由，但这条路径不替代题目答案。请先列事实，再说明仍不能判断的部分。[N1]';

check('含观察问题、读图解释和读图动作的导图/流程/对照表通过现有章节门控', () => {
  for (const written of illustrated) validateChapter(written, written.id, ['N1']);
  for (const code of [mindmap, boundaryFlow, practiceFlow]) assert.equal(parseControlledTextbookBlock('mermaid', code), code);
  const body = assembleTextbook(book(), illustrated, sources);
  assert.equal(parseTextbookMarkdown(body).children.filter((node) => node.type === 'code' && node.lang === 'mermaid').length, 3);
  assert.ok(parseTextbookMarkdown(body).children.some((node) => node.type === 'table'));
  assert.equal((body.match(/观察问题/gu) || []).length, 4);
  assert.equal((body.match(/读图要点/gu) || []).length, 4);
});

check('无图章节仍可通过，缺图意见保持非阻断，不修改审核标准', () => {
  const blueprint = book(), chapters = blueprint.chapters.map((plan) => chapter(plan.id));
  chapters.forEach((written) => validateChapter(written, written.id, ['N1']));
  const quality = assessTextbookQuality({ schemaVersion: 3, passed: false, findings: [{
    severity: 'blocker', impact: 'minor', certainty: 'clear', category: 'pedagogy',
    target: { kind: 'chapter', chapterId: 'ch1', section: 'explanation', quote: chapters[0].sections.explanation },
    message: '可以补充一幅概念导图以帮助把握分类框架', reason: '可视化是呈现改进，不影响已有内容的学习判断。', basis: [],
  }] }, { context, sources, blueprint, chapters });
  assert.equal(quality.passed, true); assert.equal(quality.findings!.length, 0); assert.equal(quality.warnings!.length, 1);
  assert.ok(TEXTBOOK_QUALITY_PROMPT.includes('可选格式未使用'));
});

check('答案局部修订逐字保留其它图示，自动关联也不改 Mermaid 源码', () => {
  const revised = mergeTextbookSectionRepair(illustrated[1], ['answer'], { id: 'ch2', sections: {
    answer: '先分别列出来源、用途标签和评价条件，不把仍缺失的条件当成已知。[N1]',
  } });
  for (const key of Object.keys(revised.sections) as Array<keyof TextbookChapter['sections']>) {
    if (key !== 'answer') assert.equal(revised.sections[key], illustrated[1].sections[key]);
  }
  const body = assembleTextbook(book(), illustrated, sources);
  const linked = autoLinkMarkdown(body, [{ token: '心理账户', target: '心理账户' }, { token: '条件', target: '条件' }]);
  for (const code of [mindmap, boundaryFlow, practiceFlow]) assert.ok(linked.updatedContent.includes(fence('mermaid', code)));
});

check('旧检查点依赖哈希不因生成引导而变化，不增加模型额度或额外调用阶段', () => {
  const blueprint = book();
  const job = { checkpoint: { blueprint, chapters: illustrated } } as TextbookJob;
  const before = chapterInputIdentity(job, blueprint.chapters[0]);
  textbookVisualGuidance(blueprint, 'ch1');
  assert.equal(chapterInputIdentity(job, blueprint.chapters[0]), before);
  const policy = defaultTextbookModelPolicy();
  assert.equal(policy.stages.blueprint.maxTokens, 8000); assert.equal(policy.stages.chapter.maxTokens, 12000);
  const generation = readFileSync(new URL('../src/services/textbook/generation.ts', import.meta.url), 'utf8');
  assert.ok(generation.includes('visualizationGuidance: textbookVisualGuidance(blueprint, chapter.id, repairSections)'));
  assert.ok(generation.includes('visualizationGuidance: textbookVisualGuidance(blueprint, chapter.id)'));
  assert.ok(!generation.includes("model('textbook-visual"));
});

check('蓝图按教学价值选择图种，不预设Mermaid数量；保留读图教学和安全边界', () => {
  for (const term of ['不预设全书图示数量或优先图种', 'visuals', 'readingQuestion']) assert.ok(TEXTBOOK_BLUEPRINT_PROMPT.includes(term));
  assert.ok(!TEXTBOOK_BLUEPRINT_PROMPT.includes('2–4 幅 Mermaid'));
  assert.ok(TEXTBOOK_BLUEPRINT_PROMPT.includes('visuals空数组不是要求全书纯文字'));
  for (const term of ['visualizationGuidance', '观察问题', '读图要点', '读图动作', '不泄露', '800', '替换同义重复段落', '因果']) {
    assert.ok(TEXTBOOK_CHAPTER_PROMPT.includes(term), term);
  }
  assert.ok(TEXTBOOK_SECTION_REPAIR_PROMPT.includes('若只修答案'));
});

check('组件能力清单同时进入蓝图、章节与局部修订，涵盖全部格式和禁用范围', () => {
  for (const prompt of [TEXTBOOK_BLUEPRINT_PROMPT, TEXTBOOK_CHAPTER_PROMPT, TEXTBOOK_SECTION_REPAIR_PROMPT]) {
    assert.ok(prompt.includes(TEXTBOOK_COMPONENT_CAPABILITIES_PROMPT));
    assert.equal(textbookTimelinePrompt(prompt), prompt, '旧任务提示词逐字不变');
    const current = textbookTimelinePrompt(prompt, 2);
    for (const format of TEACHING_VISUAL_FORMATS) assert.ok(current.includes(format), format);
    for (const rule of ['不补造年份', '并列主题', '不增加图片生成或语义审核阶段', '不借此扩课']) assert.ok(current.includes(rule), rule);
  }
  for (const limit of ['静态二维', '最多48图元', '最多160字符/60原子', '最多4条曲线/8个', '类别轴', '不支持点号分隔', '不支持隐式方程', '没有内置求力', '不新增formula', '不自动验真', '本章已提供assets']) {
    assert.ok(TEXTBOOK_COMPONENT_CAPABILITIES_PROMPT.includes(limit), limit);
  }
  assert.ok(!TEXTBOOK_QUALITY_PROMPT.includes(TEXTBOOK_COMPONENT_CAPABILITIES_PROMPT), 'Presentation catalog is not a new review gate');
});

check('时间轴贯通蓝图、写作计划、组装和自动关联；局部修订不丢图', () => {
  const blueprint = book();
  blueprint.chapters[0].visuals = [{ format: 'timeline', section: 'explanation', purpose: '按资料阶段梳理演进', readingQuestion: '哪个阶段先出现？' }];
  validateBlueprint(blueprint, context, sources);
  const allocated = assembleTeachingBlueprint(blueprint, context, sources);
  assert.equal(allocated.chapters[0].visuals![0].format, 'timeline');
  assert.equal(textbookVisualGuidance(allocated, 'ch1').targets[0].format, 'timeline');
  const chapters = blueprint.chapters.map(plan => chapter(plan.id));
  chapters[0].sections.explanation += '\n\n观察问题：各阶段按何种先后展开？\n\n' + fence('mermaid', visualTimeline)
    + '\n\n读图要点：这是合成阶段关系示例，不代表等比例时间或因果；实际阶段必须核对资料。[N1]';
  validateChapter(chapters[0], 'ch1', ['N1']);
  const updated = mergeTextbookSectionRepair(chapters[0], ['answer'], { id: 'ch1', sections: { answer: chapters[0].sections.answer } });
  assert.equal(updated.sections.explanation, chapters[0].sections.explanation);
  const body = assembleTextbook(blueprint, chapters, sources);
  assert.ok(autoLinkMarkdown(body, [{ token: '阶段', target: '阶段' }]).updatedContent.includes(fence('mermaid', visualTimeline)));
});

console.log(`\nTextbook visualization checks passed: ${checks} groups; synthetic fixtures, no model/network/user vault. Mermaid schema is checked here; native SVG rendering is a separate browser check.`);
