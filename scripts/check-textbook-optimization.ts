import assert from 'node:assert/strict';
import type { TeachingBlueprint, TextbookChapter, TextbookContext, TextbookJob, TextbookReviewFinding, TextbookSource } from '../src/services/textbook/generationTypes';
import { mergeTextbookSectionRepair } from '../src/services/textbook/sectionRepair';
import { acceptTextbookReview, planTextbookReview } from '../src/services/textbook/reviewCache';
import { consumeTextbookRound, reserveTextbookRequest, settleTextbookRequest, textbookCost, TextbookBudgetError } from '../src/services/textbook/cost';
import { defaultTextbookModelPolicy, TEXTBOOK_COST_LIMITS } from '../src/services/textbook/modelPolicy';
import { textbookProgressSnapshot } from '../src/services/textbook/progress';
import { assembleTextbook, validateChapter, validateTextbookJob } from '../src/services/textbook/validation';
import { assessTextbookQuality } from '../src/services/textbook/quality';
import { TEXTBOOK_WRITING_STYLE_PROMPT, TEXTBOOK_BLUEPRINT_PROMPT, TEXTBOOK_CHAPTER_PROMPT,
  TEXTBOOK_SECTION_REPAIR_PROMPT, TEXTBOOK_QUALITY_PROMPT, TEXTBOOK_SOURCE_PROMPT } from '../src/workflows/textbookPrompt';

const context: TextbookContext = { project: { id: 'p', rootId: 'r', title: '条件判断', rootTitle: '行为科学', tasks: ['解释条件并判断迁移问题'], knowledgeTitles: [] },
  profile: '偏好有例子的讲解', preferences: {}, personal: [], mastery: {}, warnings: [] };
const sources: TextbookSource[] = Array.from({ length: 6 }, (_, i) => ({ sourceId: `N${i + 1}`, kind: 'knowledge', id: `n${i + 1}`, title: `原文${i + 1}`, version: 'v1',
  text: `第${i + 1}部分：结果取决于复杂度与偏好，不能把有条件的结论当成必然的因果关系。` }));
const blueprint: TeachingBlueprint = { title: '由概念到迁移', objectives: [{ id: 'O1', text: '解释条件并判断迁移问题' }], focuses: [],
  chapters: sources.map((source, i) => ({ id: `ch${i + 1}`, title: `阶段${i + 1}`, objectiveIds: ['O1'], focusIds: [], sourceIds: [source.sourceId], bridge: '先理解条件，再把判断步骤迁移到新情境。' })) };
const chapters: TextbookChapter[] = blueprint.chapters.map((plan, i) => ({ id: plan.id, sections: {
  explanation: `结果取决于条件，不宜作出无条件的结论。[N${i + 1}]`, boundaries: `偏好清晰度与复杂度需要分别检查，不能相互替代。[N${i + 1}]`,
  workedExample: `假设情境：先比较筛选条件，再判断可推断的范围。[N${i + 1}]` + '\n\n| 条件 | 判断 |\n| --- | --- |\n| 未说明 | 待核实 |\n\n```python\nprint(1)\n```\n\n$$n=1$$',
  practice: '给定条件尚不完整时，说明缺少哪些判断信息。', answer: `先列已知条件，再区分条件推断和未知信息。[N${i + 1}]`,
  selfCheck: '能够给出判断理由，而不是将可能性表述为必然结果。', summary: '由条件辨析转入新情境，保留尚未知的信息和推断边界。',
} }));
const makeJob = (): TextbookJob => ({ schemaVersion: 1, id: 'optimization-test', stage: 'failed', attempt: 1, createdAt: '2026-10-07', updatedAt: '2026-10-07',
  spec: { schemaVersion: 1, projectNoteId: 'p', rootProjectId: 'r', projectTitle: context.project.title, planningHash: '', allowedDocIds: [], documentHashes: {},
    knowledgeHashes: Object.fromEntries(sources.map((source) => [source.id, source.version])), providerHash: '', allowCloud: false, modelPolicy: defaultTextbookModelPolicy() }, checkpoint: structuredClone({ context, sources, blueprint, chapters }) });
const input = (job: TextbookJob) => ({ context: job.checkpoint.context!, sources: job.checkpoint.sources!, blueprint: job.checkpoint.blueprint!, chapters: job.checkpoint.chapters! });
const clean = { schemaVersion: 3, passed: true, findings: [] };
let groups = 0; const pass = (message: string) => { groups++; console.log(`PASS ${message}`); };

const original = structuredClone(chapters[0]);
const revised = mergeTextbookSectionRepair(original, ['answer'], { id: original.id, sections: { answer: '先区分已知条件与未知信息，不把复杂度直接等同偏好。[N1]' } });
assert.equal(original.sections.answer, chapters[0].sections.answer);
for (const key of Object.keys(original.sections) as Array<keyof TextbookChapter['sections']>) if (key !== 'answer') assert.equal(revised.sections[key], original.sections[key]);
validateChapter(revised, 'ch1', ['N1']);
for (const invalid of [null, { id: 'wrong', sections: { answer: '答案' } }, { id: 'ch1', sections: {} }, { id: 'ch1', sections: { answer: '答案', summary: '越权' } },
  { id: 'ch1', sections: { answer: 42 } }, { id: 'ch1', sections: { answer: '答案' }, blueprint: {} }]) assert.throws(() => mergeTextbookSectionRepair(original, ['answer'], invalid));
assert.throws(() => validateChapter(mergeTextbookSectionRepair(original, ['answer'], { id: 'ch1', sections: { answer: '假定这个外部编号合法，可以据此生成教学答案。[N999]' } }), 'ch1', ['N1']));
pass('仅合并授权小节，保留代码/公式/表格和其它六节；拒绝越权键、遗漏、错ID及非法引用');

const job = makeJob();
const blocked: TextbookReviewFinding = { severity: 'blocker', impact: 'critical', certainty: 'clear', category: 'factual_support',
  target: { kind: 'chapter', chapterId: 'ch1', section: 'answer', quote: chapters[0].sections.answer }, message: '本节答案的条件需要按来源进一步核实',
  reason: '条件范围影响最终判断，需核对原文后修正答案。', basis: [{ kind: 'source', sourceId: 'N1', quote: sources[0].text }] };
const warning: TextbookReviewFinding = { ...blocked, severity: 'warning', impact: 'minor', category: 'pedagogy',
  target: { kind: 'chapter', chapterId: 'ch4', section: 'summary', quote: chapters[3].sections.summary }, basis: [], message: '可用更简短的小结来帮助阅读' };
const first = await planTextbookReview(job, input(job));
assert.equal(first.scoped, false); assert.equal(first.input.chapters.length, 6);
acceptTextbookReview(job, first, { schemaVersion: 3, passed: false, findings: [blocked, warning] }, input(job));
const unchanged = await planTextbookReview(job, input(job));
assert.equal(unchanged.cachedQuality?.passed, false);
job.checkpoint.chapters![0] = revised;
const local = await planTextbookReview(job, input(job));
assert.equal(local.scoped, true); assert.deepEqual(local.changed, ['ch1']);
assert.deepEqual(local.input.sources.map((source) => source.sourceId), ['N1']);
assert.equal(Object.keys(local.input.chapters[0].sections).length, 7); assert.equal(Object.keys(local.input.chapters[1].sections).length, 7);
assert.equal(Object.keys(local.input.chapters[3].sections).length, 1);
assert.ok(JSON.stringify(local.input).length < JSON.stringify(first.input).length * 0.7);
const quality = acceptTextbookReview(job, local, clean, input(job));
assert.equal(quality.passed, true); assert.equal(quality.warnings?.length, 1);
job.checkpoint.quality = quality; job.checkpoint.body = assembleTextbook(blueprint, job.checkpoint.chapters!, sources);
validateTextbookJob(job, job.checkpoint.body);
assert.equal((await planTextbookReview(job, input(job))).cachedQuality?.passed, true);
pass('首次完整复核后只重检修改章及相邻关系，不重复发送其它章全文/无关原文；保留旧建议并核验完整出版');

for (const mutate of [
  (test: TextbookJob) => { test.checkpoint.sources![0].text += '更新后的条件。'; },
  (test: TextbookJob) => { test.checkpoint.context!.profile += '新的讲授偏好'; },
  (test: TextbookJob) => { test.checkpoint.blueprint!.chapters[1].bridge += '新衔接'; },
  (test: TextbookJob) => { test.checkpoint.reviewCache!.environmentHash = '旧审核标准'; },
]) {
  const modified = structuredClone(job); mutate(modified);
  const result = await planTextbookReview(modified, input(modified));
  assert.equal(result.scoped, false); assert.equal(result.cachedQuality, undefined); assert.equal(result.changed.length, 6);
}
pass('来源、画像、蓝图或审核标准改变使复核缓存失效，不能用旧通过报告自动发布');

const cross = makeJob();
const crossFinding: TextbookReviewFinding = { ...warning, category: 'internal_consistency',
  basis: [{ kind: 'textbook', target: { kind: 'chapter', chapterId: 'ch1', section: 'answer', quote: cross.checkpoint.chapters![0].sections.answer } }] };
acceptTextbookReview(cross, await planTextbookReview(cross, input(cross)), { schemaVersion: 3, passed: true, findings: [crossFinding] }, input(cross));
cross.checkpoint.chapters![0] = revised;
assert.equal((await planTextbookReview(cross, input(cross))).scoped, false);
const scopeJob = structuredClone(job); scopeJob.checkpoint.chapters![0].sections.answer += '新增解释。';
const scope = await planTextbookReview(scopeJob, input(scopeJob));
assert.throws(() => acceptTextbookReview(scopeJob, scope, { schemaVersion: 3, passed: true, findings: [warning] }, input(scopeJob)), /范围/u);
assert.throws(() => acceptTextbookReview(scopeJob, scope, { schemaVersion: 3, passed: true, findings: [{ ...warning, target: { ...warning.target, quote: '虚构引句，不存在于教材正文。' } }] }, input(scopeJob)), /引文/u);
pass('跨章引用失效退回完整复核；局部复核越权、虚构引句不缓存、不出版');

const costs = makeJob(); const reservation = reserveTextbookRequest(costs, '系统提示', '资料', 1000);
assert.equal(textbookCost(costs).requests, 1); assert.equal(textbookCost(costs).reservedTokens, reservation);
const afterCrash = JSON.parse(JSON.stringify(costs)) as TextbookJob;
assert.equal(textbookCost(afterCrash).reservedTokens, reservation);
settleTextbookRequest(costs, reservation, { promptTokens: 100, completionTokens: 30 });
assert.deepEqual([textbookCost(costs).promptTokens, textbookCost(costs).completionTokens, textbookCost(costs).reservedTokens], [100, 30, 0]);
const retryReservation = reserveTextbookRequest(costs, '同输入再次截断重试', '资料', 2000);
settleTextbookRequest(costs, retryReservation, { promptTokens: 100, completionTokens: 40 });
assert.equal(textbookCost(costs).requests, 2); assert.equal(textbookCost(costs).completionTokens, 70);
const unknown = reserveTextbookRequest(costs, '未知用量', '资料', 1000); settleTextbookRequest(costs, unknown, { completionTokens: 42 });
assert.equal(textbookCost(costs).reservedTokens, unknown);
pass('每次请求含截断重试都累计；请求前落盘预留跨重启保留，缺失用量不归零，思考不重复累加');

textbookCost(costs).requests = TEXTBOOK_COST_LIMITS.maxRequests;
assert.throws(() => reserveTextbookRequest(costs, '系统', '资料', 100), TextbookBudgetError);
assert.equal(textbookCost(costs).stopped, 'requests'); assert.equal(textbookCost(costs).requests, TEXTBOOK_COST_LIMITS.maxRequests);
const cap = makeJob(); textbookCost(cap).promptTokens = TEXTBOOK_COST_LIMITS.maxTotalTokens;
assert.throws(() => reserveTextbookRequest(cap, '系统', '资料', 100), TextbookBudgetError);
assert.equal(textbookCost(cap).requests, 0); assert.equal(textbookCost(cap).stopped, 'tokens');
for (const kind of ['repairs', 'reviews'] as const) {
  const limited = makeJob(); const originalChapters = structuredClone(limited.checkpoint.chapters);
  consumeTextbookRound(limited, kind); consumeTextbookRound(limited, kind);
  assert.throws(() => consumeTextbookRound(limited, kind), TextbookBudgetError);
  const restored = JSON.parse(JSON.stringify(limited)) as TextbookJob;
  assert.throws(() => consumeTextbookRound(restored, kind), TextbookBudgetError);
  assert.deepEqual(restored.checkpoint.chapters, originalChapters);
}
pass('累计请求/token、两轮修订/报告重检到限前停止，不改草稿，重启不重置');

const legacy = makeJob(); legacy.spec.modelPolicy = defaultTextbookModelPolicy(1);
legacy.checkpoint.modelAttempts = [{ stage: 'chapter', inputHash: 'legacy', truncations: 0, exhausted: false, maxTokens: 12000, outputChars: 100,
  promptTokens: 200, completionTokens: 400, reasoningTokens: 350 }];
assert.equal(textbookCost(legacy).completionTokens, 400); assert.equal(textbookCost(legacy).legacyUsageIncomplete, true);
const safe = textbookProgressSnapshot(legacy, false);
assert.equal(safe.cost?.completionTokens, 400); assert.ok(!JSON.stringify(safe).includes('inputHash')); assert.ok(!JSON.stringify(safe).includes(context.profile));
assert.equal(legacy.spec.modelPolicy.stages.chapter.thinkingMode, 'enabled');
assert.equal(defaultTextbookModelPolicy(2).costControl, undefined);
assert.equal(defaultTextbookModelPolicy(3).stages.chapter.thinkingMode, 'disabled');
pass('旧策略 v1/v2 保持原批准对象与思考模式；恢复历史用量标注不完整，进度仅含数字不含资料/画像');

assert.ok(TEXTBOOK_WRITING_STYLE_PROMPT.length < 1200, 'Style guidance stays compact within existing request budgets');
assert.equal(TEXTBOOK_CHAPTER_PROMPT.split(TEXTBOOK_WRITING_STYLE_PROMPT).length - 1, 1);
assert.equal(TEXTBOOK_SECTION_REPAIR_PROMPT.split(TEXTBOOK_WRITING_STYLE_PROMPT).length - 1, 1);
assert.ok(TEXTBOOK_BLUEPRINT_PROMPT.includes('风格只落实到现有 strategy、bridge 与章节顺序'));
for (const phrase of ['严谨但通俗', '规范术语与定义', '通俗话解释', '符号含义', '一段一个重点', '80–180 汉字',
  '列表用于步骤', '不能类比之处', '不逐段复读', '保留影响结论的条件', '不猜测年龄、学历或能力',
  '专业/学术文风请求可覆盖默认语气', '既有预算不变', '不增加写作分析', '不因段长、语气或类比数量不合偏好反复生成']) {
  assert.ok(TEXTBOOK_WRITING_STYLE_PROMPT.includes(phrase), `Missing authoring guidance: ${phrase}`);
}
assert.ok(!TEXTBOOK_SOURCE_PROMPT.includes('默认讲授文风'));
assert.ok(!TEXTBOOK_QUALITY_PROMPT.includes(TEXTBOOK_WRITING_STYLE_PROMPT));
pass('统一文风只接入蓝图设计、章节生成和局部修订；术语、段落、类比、语气有指导且不扩大输出预算');

for (const message of ['长段落可以拆为短段落来帮助阅读', '术语首次出现时可增加一句通俗解释', '语气可改为平等自然的讲授语气']) {
  const styleFinding: TextbookReviewFinding = { severity: 'blocker', impact: 'critical', certainty: 'clear', category: 'pedagogy',
    target: { kind: 'chapter', chapterId: 'ch1', section: 'explanation', quote: chapters[0].sections.explanation },
    message, reason: '这仅是文风和阅读节奏建议，不改变事实与题目判断。', basis: [] };
  const styled = assessTextbookQuality({ schemaVersion: 3, passed: false, findings: [styleFinding] }, input(makeJob()));
  assert.equal(styled.passed, true); assert.equal(styled.findings.length, 0);
  assert.equal(styled.warnings?.[0]?.severity, 'warning');
}
assert.equal((await planTextbookReview(job, input(job))).cachedQuality?.passed, true);
validateChapter(chapters[0], 'ch1', ['N1']);
pass('普通文风意见即使被误标为重大否决也只保留建议；旧合格章节和已核验复核缓存不因新文风失效');
console.log(`textbook optimization: ${groups} groups passed; synthetic data, no model/network/user vault`);
