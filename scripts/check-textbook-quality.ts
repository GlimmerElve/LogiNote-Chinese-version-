import assert from 'node:assert/strict';
import type { TeachingBlueprint, TextbookChapter, TextbookContext, TextbookJob, TextbookReviewFinding, TextbookSource } from '../src/services/textbook/generationTypes';
import { assessTextbookQuality, recordUnreliableTextbookReview, TextbookReviewError } from '../src/services/textbook/quality';
import { reconcileTextbookReviewCheckpoint } from '../src/services/textbook/reviewCheckpoint';
import { assembleTextbook, validateTextbookContent, validateTextbookJob } from '../src/services/textbook/validation';
import { textbookProgressSnapshot } from '../src/services/textbook/progress';

const context: TextbookContext = { project: { id: 'p', rootId: 'r', title: '选择的条件', rootTitle: '行为学', tasks: ['解释条件与决策结果之间的关系'], knowledgeTitles: [] },
  profile: '', preferences: {}, personal: [{ evidenceId: 'C1', kind: 'confirmed_view', text: '我认为无论什么条件，选择越多就一定越差。', reference: {}, usableAsFactEvidence: false }], mastery: {}, warnings: [] };
const sources: TextbookSource[] = [
  { sourceId: 'N1', kind: 'knowledge', id: 'n1', title: '条件原文', version: 'v1', text: '选项增加并不必然使所有人的决策变差；结果依赖于任务复杂度与偏好是否清晰。' },
  { sourceId: 'N2', kind: 'knowledge', id: 'n2', title: '实施原文', version: 'v2', text: '在偏好清晰的情境中，可以按个人重要的属性筛选备选项，但这不是普遍有效的固定处方。' },
];
const blueprint: TeachingBlueprint = { title: '有条件的决策', objectives: [{ id: 'O1', text: '解释条件与决策结果之间的关系' }], focuses: [], chapters: [
  { id: 'ch1', title: '原理', objectiveIds: ['O1'], focusIds: [], sourceIds: ['N1'], bridge: '先区分必然结果和有条件的可能结果。' },
  { id: 'ch2', title: '迁移', objectiveIds: ['O1'], focusIds: [], sourceIds: ['N2'], bridge: '在理解条件之后，再讨论新情境中的适用范围。' },
] };
const chapter = (id: string, sourceId: string): TextbookChapter => ({ id, sections: {
  explanation: `条件与偏好会影响判断，不能假设所有情境都相同。[${sourceId}]`, boundaries: `应检查任务是否复杂，以及偏好是否清晰。[${sourceId}]`,
  workedExample: `假设需要买书，先检查筛选条件，再判断备选项。[${sourceId}]`, practice: '假设在短时间选课程，说明缺少哪些判断条件。',
  answer: `先核对偏好清晰度与任务复杂度，再作有条件的判断。[${sourceId}]`, selfCheck: '能否明确区分普遍结论、条件判断与待核实信息？', summary: '本章先识别条件，再用新情境检验适用边界。',
} });
const chapters = [chapter('ch1', 'N1'), chapter('ch2', 'N2')];
const input = { context, sources, blueprint, chapters };
const fact: TextbookReviewFinding = { severity: 'blocker', category: 'factual_support',
  target: { kind: 'chapter', chapterId: 'ch1', section: 'explanation', quote: chapters[0].sections.explanation },
  message: 'ch1.explanation：具体条件论断需要按原文核对', reason: '教材的条件范围与对应原文不一致，必须修正后才能学习。',
  basis: [{ kind: 'source', sourceId: 'N1', quote: sources[0].text }] };
const report = (finding: TextbookReviewFinding, passed = finding.severity === 'warning') => ({ schemaVersion: 2, passed, findings: [finding] });
const makeJob = (): TextbookJob => ({ schemaVersion: 1, id: 'quality-fixture', stage: 'failed', attempt: 1, createdAt: '2026-10-07', updatedAt: '2026-10-07',
  spec: { schemaVersion: 1, projectNoteId: 'p', rootProjectId: 'r', projectTitle: '选择的条件', planningHash: '', allowedDocIds: [], documentHashes: {}, knowledgeHashes: { n1: 'v1', n2: 'v2' }, providerHash: '', allowCloud: false },
  checkpoint: structuredClone({ context, sources, blueprint, chapters, body: assembleTextbook(blueprint, chapters, sources) }) });
let checks = 0;
const pass = (message: string) => { checks++; console.log(`PASS ${message}`); };
assert.equal(assessTextbookQuality({ schemaVersion: 2, passed: true, findings: [] }, input).status, 'passed');
assert.throws(() => assessTextbookQuality({ passed: true, issues: [] }, input), TextbookReviewError);
pass('新报告显式版本、通过状态及问题结构；旧空报告不作为新任务放行依据');
const warning = { ...fact, severity: 'warning' as const, category: 'pedagogy' as const, basis: [], message: '可增加一个表格以便对照条件' };
const advisory = assessTextbookQuality(report(warning), input);
assert.equal(advisory.passed, true); assert.equal(advisory.warnings?.length, 1); assert.deepEqual(advisory.findings, []);
assert.throws(() => assessTextbookQuality(report({ ...warning, severity: 'blocker' }), input), /呈现改进/u);
pass('呈现改进仅为 warning，允许通过但保留建议；不能升级为教学内容重写');
const relaxedReport = (finding: TextbookReviewFinding) => ({ schemaVersion: 3, passed: false, findings: [{ ...finding, impact: 'critical', certainty: 'clear' }] });
for (const finding of [{ ...fact, impact: 'minor' as const }, { ...fact, certainty: 'uncertain' as const }, { ...warning, severity: 'blocker' as const }]) {
  const relaxed = relaxedReport(finding); Object.assign(relaxed.findings[0], finding);
  const result = assessTextbookQuality(relaxed, input);
  assert.equal(result.passed, true); assert.equal(result.warnings?.length, 1); assert.deepEqual(result.findings, []);
}
pass('v3 将小影响、不确定质疑、呈现建议自动规范为 warning，不因等级标错重新请求模型');
assert.equal(assessTextbookQuality(relaxedReport(fact), input).passed, false);
assert.throws(() => assessTextbookQuality(relaxedReport({ ...fact, basis: [] }), input), /来源原文/u);
assert.throws(() => assessTextbookQuality(relaxedReport({ ...fact, target: { ...fact.target, quote: '这不是教材中出现过的任何语句。' } }), input), /引文/u);
assert.throws(() => assessTextbookQuality({ schemaVersion: 3, passed: false, findings: [] }, input), /通过状态/u);
const malformedImpact = relaxedReport(fact); delete (malformedImpact.findings[0] as TextbookReviewFinding).impact;
assert.throws(() => assessTextbookQuality(malformedImpact, input), /影响程度/u);
pass('进一步放宽不影响重大明确错误、事实依据、真实引文、报告状态和新契约门控');
const grounded = assessTextbookQuality(report(fact), input);
assert.equal(grounded.status, 'blocked'); assert.deepEqual(grounded.findings, [{ stage: 'chapters', chapterId: 'ch1', section: 'explanation', message: fact.message }]);
assert.throws(() => assessTextbookQuality(report({ ...fact, basis: [] }), input), /缺少对应来源原文/u);
pass('事实阻断必须有教材位置和本章来源原文，真正拒绝只定位对应章/节');
for (const patch of [
  { target: { ...fact.target, chapterId: 'ch999' } },
  { target: { ...fact.target, quote: '教材中根本没有出现过的错误论断。' } },
  { basis: [{ kind: 'source', sourceId: 'N1', quote: '假装这段话是资料里面的真实原文。' }] },
  { basis: [{ kind: 'source', sourceId: 'N999', quote: sources[0].text }] },
]) assert.throws(() => assessTextbookQuality(report({ ...fact, ...patch } as TextbookReviewFinding), input), TextbookReviewError);
pass('虚构章节、教材引句、来源编号、来源引句一律拒绝复核报告，不批准出版');
assert.throws(() => assessTextbookQuality(report({ ...fact, basis: [{ kind: 'source', sourceId: 'N2', quote: sources[1].text }] }), input), /范围外/u);
pass('其他章独有的原文不能用于否决本章限定范围的说明');
const logical: TextbookReviewFinding = { ...fact, category: 'internal_consistency', basis: [{ kind: 'textbook', target: { kind: 'chapter', chapterId: 'ch1', section: 'answer', quote: chapters[0].sections.answer } }] };
assert.equal(assessTextbookQuality(report(logical), input).status, 'blocked');
assert.throws(() => assessTextbookQuality(report({ ...logical, basis: [{ kind: 'textbook', target: logical.target }] }), input), /另一处/u);
pass('内部矛盾须引用真实的两处论断，不能把同一句当作自相矛盾证据');
assert.equal(assessTextbookQuality(report({ ...fact, category: 'task_alignment', basis: [{ kind: 'task', index: 0, quote: context.project.tasks[0] }] }), input).passed, false);
assert.throws(() => assessTextbookQuality(report({ ...fact, category: 'task_alignment', basis: [] }), input), /实际任务/u);
pass('任务遗漏必须定位真实任务或学习目标，不能凭空增加教学要求');
const restatementInput = structuredClone(input);
restatementInput.blueprint.chapters[0].writingPlan = { targetChars: 1500,
  sections: ['explanation', 'boundaries', 'workedExample', 'practice', 'answer', 'selfCheck', 'summary'], restatement: 1 };
const recallAdvice: TextbookReviewFinding = { ...fact, category: 'task_alignment',
  target: { kind: 'chapter', chapterId: 'ch1', section: 'selfCheck', quote: chapters[0].sections.selfCheck },
  message: '复述问题可以更明确对应项目任务', reason: '补充任务标签会更容易理解复述问题的用途。',
  basis: [{ kind: 'task', index: 0, quote: context.project.tasks[0] }] };
const recallResult = assessTextbookQuality(relaxedReport(recallAdvice), restatementInput);
assert.equal(recallResult.passed, true); assert.equal(recallResult.warnings!.length, 1); assert.equal(recallResult.findings!.length, 0);
assert.equal(assessTextbookQuality(relaxedReport(recallAdvice), input).passed, false, 'Old task policy is unchanged');
assert.equal(assessTextbookQuality(report(recallAdvice), restatementInput).passed, false, 'Old review report contract is unchanged');
assert.equal(assessTextbookQuality(relaxedReport({ ...fact, target: recallAdvice.target }), restatementInput).passed, false, 'Facts in a recall question still need real evidence');
assert.equal(assessTextbookQuality(relaxedReport({ ...recallAdvice, target: fact.target }), restatementInput).passed, false, 'Core teaching task omissions remain blocking');
const invalidRecallAdvice = assessTextbookQuality(relaxedReport({ ...recallAdvice, target: { ...recallAdvice.target, quote: '这是教材中没有出现的虚构复述问题。' } }), restatementInput);
assert.equal(invalidRecallAdvice.passed, true); assert.equal(invalidRecallAdvice.reviewDiagnostics?.[0].disposition, 'ignored_advice');
pass('新章末复述任务标签/覆盖建议不触发重写，无法定位的建议留诊断；真实事实错误、核心讲授遗漏和旧报告规则不放宽');
const personal = { kind: 'personal' as const, evidenceId: 'C1', quote: context.personal[0].text };
assert.throws(() => assessTextbookQuality(report({ ...fact, basis: [personal] }), input), /个人观点/u);
assert.equal(assessTextbookQuality(report({ ...fact, category: 'personalization', basis: [personal] }), input).passed, false);
pass('个人记录仅支持教学适配，不能作事实来源或事实否决依据');
for (const message of ['引用编号 N1 不在本章白名单中', 'N1 不在提供的来源中', '来源编号不存在，需要重做教学蓝图', 'N1 is not in the allowed source IDs', 'Source ID N1 was not provided']) {
  assert.throws(() => assessTextbookQuality(report({ ...fact, message }), input), /编号检查/u);
}
pass('已由代码通过的编号检查不能被模型臆测推翻');
assert.equal(assessTextbookQuality(report({ ...fact, message: 'N1 原文未包含该因果结论，不能用原文原则证明固定结果。' }), input).passed, false);
pass('编号有效不等于事实有支持：真实的原文支持性质疑仍可进入语义阻断，不与白名单误判混淆');
for (const value of [report(fact, true), report(warning, false), { ...report(fact), issues: ['另一条没有定位的错误'] }, report({ ...fact, category: 'source_membership' } as never)]) {
  assert.throws(() => assessTextbookQuality(value, input), TextbookReviewError);
}
pass('等级与通过状态矛盾、旧额外否决和越权检查全部 fail closed，不静默删除问题');
const whitespace = structuredClone(fact); whitespace.basis[0] = { kind: 'source', sourceId: 'N1', quote: sources[0].text.replace('；', '；\n') };
const spacedInput = structuredClone(input); spacedInput.sources[0].text = sources[0].text.replace('；', '； ');
assert.equal(assessTextbookQuality(report(whitespace), spacedInput).passed, false);
pass('引文可归一空白，不能用语义相似度伪造逐字证据');
const shortInput = structuredClone(input); shortInput.blueprint.objectives[0].text = '理解条件'; shortInput.context.project.tasks[0] = '画表格';
shortInput.context.previousLearning = { id: 'previous', title: '内驱力', endedAt: '2026-10-06', summary: '', unresolvedQuestions: [] };
assert.equal(assessTextbookQuality(report({ ...fact, category: 'task_alignment', target: { kind: 'objective', id: 'O1', quote: '理解条件' }, basis: [{ kind: 'task', index: 0, quote: '画表格' }] }), shortInput).passed, false);
assert.equal(assessTextbookQuality(report({ ...fact, category: 'personalization', basis: [{ kind: 'previous_learning', quote: '内驱力' }] }), shortInput).passed, false);
pass('短目标、任务与上一学习主题可引用完整原条目，不强迫模型编造八字引文');
for (const applied of [false, true]) {
  const job = makeJob(); const before = structuredClone(job.checkpoint);
  job.checkpoint.quality = { passed: false, issues: ['蓝图：N1/N2 不在白名单，所有章节都需重写'] };
  job.checkpoint.repair = { applied, findings: [{ stage: 'blueprint', message: job.checkpoint.quality.issues[0] }] };
  job.checkpoint.repairIssues = job.checkpoint.quality.issues;
  assert.equal(reconcileTextbookReviewCheckpoint(job), 'retained');
  assert.deepEqual(job.checkpoint.blueprint, before.blueprint); assert.deepEqual(job.checkpoint.chapters, before.chapters);
  assert.equal(job.checkpoint.quality, undefined); assert.equal(job.checkpoint.repair, undefined); assert.equal(job.checkpoint.repairIssues, undefined);
}
pass('旧版无证据拒绝与已应用的陈旧意见都不触发蓝图重写，完整草稿保留供重新复核');
const oldStandards = makeJob(); const oldChapters = structuredClone(oldStandards.checkpoint.chapters);
oldStandards.checkpoint.quality = grounded;
oldStandards.checkpoint.repair = { applied: false, origin: 'reviewer', findings: grounded.findings! };
assert.equal(reconcileTextbookReviewCheckpoint(oldStandards), 'retained');
assert.deepEqual(oldStandards.checkpoint.chapters, oldChapters); assert.equal(oldStandards.checkpoint.repair, undefined);
assert.equal(oldStandards.checkpoint.quality?.status, 'needs_recheck');
const currentStandards = makeJob(); currentStandards.checkpoint.quality = { ...grounded, reviewCriteriaVersion: 3 };
currentStandards.checkpoint.repair = { applied: false, origin: 'reviewer', findings: grounded.findings! };
assert.equal(reconcileTextbookReviewCheckpoint(currentStandards), null);
assert.equal(currentStandards.checkpoint.repair?.applied, false);
pass('已定位的旧标准语义拒绝也先按新标准重评、不直接重写；当前标准确认的实质错误仍保留修复位置');
const badLegacy = makeJob(); badLegacy.checkpoint.chapters![0].sections.explanation += ' [N999]';
badLegacy.checkpoint.quality = { passed: false, issues: ['旧校验失败'] };
assert.equal(reconcileTextbookReviewCheckpoint(badLegacy), 'reproduced');
assert.equal(badLegacy.checkpoint.repair?.origin, 'deterministic');
assert.equal(badLegacy.checkpoint.repair?.findings[0].chapterId, 'ch1');
pass('旧草稿中的真实非法引用可由代码复现，仍执行原定点修复');
const unreliable = makeJob(); recordUnreliableTextbookReview(unreliable, '复核引文不存在');
const snapshot = textbookProgressSnapshot(unreliable, false);
assert.equal(snapshot.qualityReview?.status, 'needs_recheck'); assert.deepEqual(snapshot.repairTargets, []);
assert.equal(snapshot.completed, 2); assert.ok(!JSON.stringify(snapshot).includes(context.personal[0].text));
assert.throws(() => validateTextbookJob(unreliable, unreliable.checkpoint.body!), /质量门控/u);
pass('不可信报告只能重新复核：安全进度有状态，无私人引文，不将合格章节标为重写');
const tampered = makeJob(); tampered.checkpoint.quality = { ...grounded, report: { ...grounded.report!, findings: [{ ...fact, target: { ...fact.target, quote: '不存在的教材句子，不能重写。' } }] } };
tampered.checkpoint.repair = { applied: false, origin: 'reviewer', findings: grounded.findings! };
assert.equal(reconcileTextbookReviewCheckpoint(tampered), 'retained'); assert.equal(tampered.checkpoint.repair, undefined);
assert.equal(tampered.checkpoint.quality?.status, 'needs_recheck');
pass('恢复时重新核验已保存模型否决，失效或不匹配的证据不能触发阶段失效');
const published = makeJob(); published.checkpoint.quality = advisory;
validateTextbookContent(published, published.checkpoint.body!); validateTextbookJob(published, published.checkpoint.body!);
published.checkpoint.quality.report = undefined;
assert.throws(() => validateTextbookJob(published, published.checkpoint.body!), /新版报告/u);
pass('出版仍重做完整确定性门控与新版报告核验；伪造 passed=true 不能代替真实复核');
console.log(`textbook quality: ${checks} groups passed; synthetic data only, no model/network/user vault`);
