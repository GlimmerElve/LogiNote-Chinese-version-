import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { REVIEW_ASSESSMENT_TASKS, buildReviewOpeningQuestion, freezeReviewAssessment, parseReviewAssessment,
  type ReviewAssessmentTaskType } from '../src/services/reviewAssessment';
import { parseReviewTutorIntent, stripReviewIntentMarkers, inheritReviewQuestionIntent } from '../src/services/reviewIntent';
import { parseReviewQuestionIntent } from '../src/services/reviewIntentValidation';
import { reviewCognitionObservations } from '../src/services/cognition/observations';
import { buildReviewComparisonPacket, verifyReviewComparisonFreshness } from '../src/services/reviewComparison/packet';
import { prepareReviewComparisonSession } from '../src/services/reviewComparison/session';
import { frozenReviewRequirements, readReviewPerformanceGraph } from '../src/services/reviewComparison/performanceGraph';
import { buildReviewAnchoredChannel, reviewAnchoredChannels, type ReviewAnchoredInput } from '../src/services/reviewComparison/anchoredProtocol';
import { createReviewSemanticModel } from '../src/services/reviewComparison/semanticClient';
import { evaluateReviewComparisonPacket } from '../src/services/reviewComparison/semanticEvaluator';
import { buildReviewMasteryShadow } from '../src/services/reviewComparison/semanticOutputs';
import type { ReviewComparisonPacket } from '../src/services/reviewComparison/types';
import type { ReviewPerformanceGraph, ReviewSemanticComparison } from '../src/services/reviewComparison/semanticTypes';
import type { ReviewEpisodeCapture } from '../src/services/memory/types';
import { prepareReviewDualFixture } from './review-dual-fixture';
import { REVIEW_DUAL_DATASET } from './review-dual-dataset';
import { validateReviewDualAnchoredRequest, validateReviewDualReplayInput } from './review-dual-transport';

const fetchBefore = globalThis.fetch;
globalThis.fetch = async () => assert.fail('No network allowed in question-time assessment checks');
let checks = 0;
const pass = (name: string) => { checks++; console.log(`PASS ${name}`); };
const topic = '选择过载';
const parse = (text: string) => parseReviewTutorIntent(text, { questionMessageId: 'question1',
  allowedKnowledgeTargets: [topic], fallbackKnowledgeTargets: [topic], cognitionCandidates: [{ token: 'C1',
    reference: { recordId: 'r1', revisionId: 'v1', branchId: 'b1', nodeId: 'n1' }, title: topic,
    text: '旧观点', context: '', needsReview: false }] });
async function fixture(marker: string | undefined, changes: { question?: string; answer?: string; personal?: boolean; hintLevel?: 0 | 1 | 2 | 3 | 4 } = {}) {
  const c = structuredClone(REVIEW_DUAL_DATASET.find((item) => item.id === 'G05')!);
  if (changes.question) c.question = changes.question;
  if (changes.answer) c.answer = changes.answer;
  if (changes.personal === false) c.personal = undefined;
  if (changes.hintLevel !== undefined) c.hintLevel = changes.hintLevel;
  const base = await prepareReviewDualFixture(c);
  const intent = { ...base.packet.questionIntent, assessment: freezeReviewAssessment(marker, [c.topic]) };
  const packet = await buildReviewComparisonPacket({ activityId: base.packet.activityId, questionText: c.question,
    evidence: { messageId: base.packet.messageId, answer: c.answer, hintLevel: c.hintLevel,
      targetKnowledgeNames: [c.topic], questionIntent: intent } }, base.dependencies,
  { targetScopeNoteIds: (await base.dependencies.readNotes()).map((note) => note.id) });
  return { ...base, packet };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const extracted = (packet: ReviewComparisonPacket) => ({ version: 1, packetId: packet.packetId,
  claims: [{ id: 'A1', role: 'fact', quote: packet.answer.text }], edges: [], requirements: [] });
const empty = (input: ReviewAnchoredInput) => ({ version: 3, channel: input.channel, bindingId: input.bindingId, alignments: [],
  ...(input.channel === 'reference' ? { referenceAudit: { status: 'compatible',
    sourceIds: input.sources.filter((source) => source.kind === 'reference').map((source) => source.id) }, edgeChecks: [] } : { personalLinks: [] }) });
/** Explicit synthetic semantics, not a measurement of the real model's understanding. */
function aligned(input: ReviewAnchoredInput) {
  const pair = input.pairs[0], main = input.graph.claims[0].quoteId;
  const target = input.anchors.find((anchor) => anchor.sourceId === pair.targetQuoteSourceId
    && anchor.text === input.sources.find((source) => source.id === pair.targetQuoteSourceId)!.text)!;
  const axis = { status: 'same', leftQuoteId: input.channel === 'personal' ? target.id : main,
    rightQuoteId: input.channel === 'personal' ? main : target.id, reason: '合成替身指定的同对象同条件同结果维度' };
  const absent = { status: 'not_applicable', leftQuoteId: null, rightQuoteId: null, reason: '该合成命题不涉及此维度' };
  return { ...empty(input), alignments: [{ pairId: pair.pairId, targetQuoteId: target.id,
    relation: input.channel === 'personal' ? 'contradiction' : 'consistent', confidence: 0.95, sourcesCompatible: true,
    axes: { object: axis, condition: axis, time: absent, metric: { ...axis, status: 'same_dimension' }, baseline: absent },
    ...(input.channel === 'personal' ? { relationBasis: { kind: 'observed_counterexample', leftQuoteId: target.id,
      rightQuoteId: main, explanation: '当前合成回答包含实际观测的反例；不自动更正旧观点' } } : {}) }] };
}
async function run(f: Fixture, response: (input: ReviewAnchoredInput) => unknown = empty, raw: unknown = extracted(f.packet)) {
  let calls = 0;
  const before = JSON.stringify({ notes: await f.dependencies.readNotes(), personal: await f.dependencies.loadCognition(), packet: f.packet });
  const graph = readReviewPerformanceGraph(extracted(f.packet), f.packet);
  const result = await evaluateReviewComparisonPacket(f.packet, f.dependencies, createReviewSemanticModel(async (request) => {
    const input = await validateReviewDualAnchoredRequest(request, ++calls, f.packet, graph);
    validateReviewDualReplayInput(request, structuredClone(request));
    return { content: JSON.stringify(calls === 1 ? raw : response(input)) };
  }, { comparisonProtocol: 'isolated-anchors-v3' }));
  assert.equal(JSON.stringify({ notes: await f.dependencies.readNotes(), personal: await f.dependencies.loadCognition(), packet: f.packet }), before);
  assert.equal(result.writes, 'disabled');
  assert.ok(result.mastery.every((item) => item.scoreWrite === 'disabled'));
  assert.equal(result.modelRequests?.total, calls);
  return { result, calls };
}

try {
  for (const task of Object.keys(REVIEW_ASSESSMENT_TASKS) as ReviewAssessmentTaskType[]) {
    const parsed = parse(`请回答本题。\n[检验:${task}]\n[意图:${topic}]\n[认知意图:C1|give_evidence]`);
    assert.equal(parsed.cleanText, '请回答本题。');
    assert.deepEqual(parsed.intent.assessment, freezeReviewAssessment(task, [topic]));
    assert.equal(parsed.intent.cognitionTarget?.purpose, 'give_evidence');
    assert.equal(stripReviewIntentMarkers(`问题\n[意图:${topic}]\n[认知意图:无]\n[检验:${task}]`), '问题');
  }
  pass('七种任务由提问标记选择预设，三种隐藏标记同时解析且不成为用户正文');

  for (const text of ['问题', '问题\n[检验:unknown]', '问题\n[检验:fact|reasoning]', '问题\n[检验:fact]\n[检验:fact]']) {
    assert.equal(parse(text).intent.assessment?.status, 'unavailable');
  }
  assert.equal(parse('为什么？\n[认知意图:C1|give_reason]').intent.assessment?.status, 'unavailable', '不能从认知目的推断掌握度任务');
  const none = parse(`普通澄清？\n[意图:无]\n[检验:definition]`);
  assert.deepEqual(none.intent.knowledgeTargets, [], '明确无目标不能回退到整篇知识点');
  assert.equal(none.intent.assessment?.reason, 'no_knowledge_target');
  assert.equal(parse('普通澄清？\n[检验:无]').intent.assessment?.status, 'not_assessed');
  pass('缺失/非法/重复标记不补猜标准，明确无目标与不评估任务安全暂停');

  const original = parse(`说明含义。\n[检验:definition]`).intent;
  const inherited = inheritReviewQuestionIntent(original, 'rephrased');
  assert.deepEqual(inherited.assessment, original.assessment);
  inherited.assessment!.requirements[0].criterionIds.pop();
  assert.equal(original.assessment!.requirements[0].criterionIds.length, 2);
  assert.equal(parse('解释理由。\n[检验:reasoning]').intent.assessment!.taskType, 'reasoning');
  assert.equal(original.assessment!.taskType, 'definition');
  pass('换问法/提示后重答继承独立契约副本，下一题不能改变已回答问题的标准');

  const valid = freezeReviewAssessment('definition', [topic]);
  assert.deepEqual(parseReviewAssessment(valid, [topic]), valid);
  const badContracts = [
    { ...valid, rubricVersion: 'unknown' }, { ...valid, score: 100 }, { ...valid, taskType: 'fact' },
    { ...valid, requirements: [] }, { ...valid, requirements: [{ ...valid.requirements[0], layer: 'reasoning' }] },
    { ...valid, requirements: [{ ...valid.requirements[0], criterionIds: ['concept_meaning'] }] },
    { ...valid, requirements: [{ ...valid.requirements[0], knowledgeTarget: '另一个目标' }] },
    { ...valid, requirements: [{ ...valid.requirements[0], expectedAnswer: '不允许模型新增答案' }] },
  ];
  for (const bad of badContracts) assert.throws(() => parseReviewAssessment(bad, [topic]), /无效/);
  const legacy = { version: 1, questionMessageId: 'question1', knowledgeTargets: [topic] };
  assert.deepEqual(parseReviewQuestionIntent(legacy), legacy);
  assert.ok(!Object.hasOwn(parseReviewQuestionIntent(legacy), 'assessment'));
  pass('持久化边界拒绝改层级/削减标准/增字段/换目标，历史无契约数据保持显式兼容');

  const opening = parse(buildReviewOpeningQuestion(topic, false));
  assert.equal(opening.intent.assessment?.taskType, 'definition');
  assert.ok(!opening.cleanText.includes('[检验:'));
  const project = parseReviewTutorIntent(buildReviewOpeningQuestion('项目甲', true), {
    questionMessageId: 'question1', allowedKnowledgeTargets: [topic], fallbackKnowledgeTargets: [] });
  assert.deepEqual(project.intent.knowledgeTargets, []);
  assert.equal(project.intent.assessment?.status, 'not_assessed');
  const selected = buildReviewOpeningQuestion('项目甲', true, ['  选择的题目？  ', '另一道题？']);
  assert.match(selected, /已选 2 个问题，先从第 1 题开始/);
  assert.match(selected, /选择的题目？/);
  assert.ok(!selected.includes('自由复述'));
  assert.equal(parseReviewTutorIntent(selected, { questionMessageId: 'selected', allowedKnowledgeTargets: [topic], fallbackKnowledgeTargets: [] }).intent.assessment?.status, 'not_assessed', 'an arbitrary selected question does not invent an assessment task');
  assert.equal(parse('自定义开场问题？').intent.assessment?.status, 'unavailable');
  pass('程序开场自带任务，项目自由回忆不硬判单知识点，自定义无标记不猜评估范围');

  const f = await fixture('fact');
  const at = '2026-10-06T00:00:00.000Z';
  const episode: ReviewEpisodeCapture = { id: f.packet.activityId, startedAt: at, endedAt: at,
    questionText: f.packet.questionText, knowledgeContext: '', messages: [
      { id: 'question1', role: 'assistant', content: f.packet.questionText, timestamp: at },
      { id: f.packet.messageId, role: 'user', content: f.packet.answer.text, timestamp: at }],
    answerEvidence: [{ messageId: f.packet.messageId, answer: f.packet.answer.text, hintLevel: 0,
      targetKnowledgeNames: f.packet.questionIntent.knowledgeTargets, questionIntent: f.packet.questionIntent }] };
  const observations = reviewCognitionObservations(episode, { title: f.packet.questionIntent.knowledgeTargets[0] });
  assert.deepEqual(observations[0].questionIntent?.assessment, f.packet.questionIntent.assessment);
  const session = await prepareReviewComparisonSession(episode, f.dependencies, {
    targetScopeNoteIds: (await f.dependencies.readNotes()).map((note) => note.id) });
  assert.equal(session.packets.length, 1);
  assert.deepEqual(session.packets[0].questionIntent.assessment, f.packet.questionIntent.assessment);
  assert.equal(session.packets[0].preparation.mastery, 'pending_alignment');
  pass('真实候选采集与会话准备保留提问时的契约，不靠抽取时再生成');

  const graph = readReviewPerformanceGraph(extracted(f.packet), f.packet);
  assert.deepEqual(graph.requirements, frozenReviewRequirements(f.packet));
  assert.equal(graph.requirements[0].origin, 'frozen_task');
  assert.equal(graph.requirements[0].layer, 'judgment');
  assert.deepEqual(readReviewPerformanceGraph(graph, f.packet), graph, '归一化可重复读取');
  for (const changed of [{ ...graph.requirements[0], layer: 'reasoning' },
    { ...graph.requirements[0], criterionIds: [] }, { ...graph.requirements[0], origin: undefined }]) {
    assert.throws(() => readReviewPerformanceGraph({ ...graph, requirements: [changed] }, f.packet), /frozen_requirement_mismatch/);
  }
  const failed = await run(f, empty, { ...extracted(f.packet), requirements: [
    { knowledgeTarget: f.packet.questionIntent.knowledgeTargets[0], layer: 'reasoning', quote: f.packet.questionText },
  ] });
  assert.equal(failed.calls, 1);
  assert.ok(failed.result.reasons.includes('frozen_requirement_mismatch'));
  pass('程序展开固定标准且可重复读取，模型增加/改写要求被明确拒绝且不重试');

  for (const task of Object.keys(REVIEW_ASSESSMENT_TASKS) as ReviewAssessmentTaskType[]) {
    const taskFixture = await fixture(task, { question: '为什么？请给一个例子。', answer: '我暂时无法完整作答。' });
    const outcome = await run(taskFixture);
    assert.equal(outcome.calls, 3);
    const requiredLayer = REVIEW_ASSESSMENT_TASKS[task].layer;
    for (const layer of ['concept', 'judgment', 'reasoning'] as const) {
      assert.equal(outcome.result.mastery[0].layers[layer].status, layer === requiredLayer ? 'unassessed' : 'not_required');
    }
    assert.ok(!outcome.result.mastery[0].layers[requiredLayer].observations.length);
  }
  const emoji = await fixture('fact', { question: '甲'.repeat(599) + '🙂' + '本题重复文字本题重复文字' });
  const context = frozenReviewRequirements(emoji.packet)![0];
  assert.equal(context.end, 599);
  assert.equal(emoji.packet.questionText.slice(context.start, context.end), context.quote);
  pass('回答内容/角色/问题措辞不重选任务，仅检验指定层，未观测不判错；审计片段不切断emoji');

  const reference = await buildReviewAnchoredChannel(f.packet, graph, 'reference');
  const personal = await buildReviewAnchoredChannel(f.packet, graph, 'personal');
  assert.deepEqual(reference.assessment, f.packet.questionIntent.assessment);
  assert.ok(!Object.hasOwn(reference, 'questionText') && !Object.hasOwn(reference.graph, 'requirements'));
  assert.ok(!Object.hasOwn(personal, 'assessment') && !Object.hasOwn(personal, 'knowledgeTargets'));
  const changedPacket = structuredClone(f.packet);
  changedPacket.questionIntent.assessment = freezeReviewAssessment('condition', changedPacket.questionIntent.knowledgeTargets);
  const changedGraph = readReviewPerformanceGraph(extracted(changedPacket), changedPacket);
  assert.deepEqual(personal, await buildReviewAnchoredChannel(changedPacket, changedGraph, 'personal'));
  const changedReference = await buildReviewAnchoredChannel(changedPacket, changedGraph, 'reference');
  assert.notEqual(reference.bindingId, changedReference.bindingId);
  assert.throws(() => validateReviewDualReplayInput({ userInput: JSON.stringify(reference) } as any,
    { userInput: JSON.stringify(changedReference) } as any), /replay_input_changed/);
  const freshness = await verifyReviewComparisonFreshness(changedPacket, f.dependencies);
  assert.deepEqual(freshness.reasons, ['packet_changed']);
  pass('参考渠道收到固定任务但无个人/问题正文；个人渠道无评分标准；任务改动使参考绑定/快照失效');

  for (const marker of [undefined, '无', 'illegal']) {
    const heldFixture = await fixture(marker);
    assert.equal(heldFixture.packet.preparation.mastery, 'held');
    assert.equal(heldFixture.packet.preparation.cognitionGrowth, 'pending_alignment');
    assert.deepEqual(reviewAnchoredChannels(heldFixture.packet), ['personal']);
    const outcome = await run(heldFixture);
    assert.equal(outcome.calls, 2, '缺任务仅跳过参考审核，不阻塞个人补充');
    assert.equal(outcome.result.channels?.personal.status, 'reviewed');
    assert.ok(outcome.result.mastery.every((item) => item.status === 'held'));
    assert.deepEqual(outcome.result.graph?.requirements, []);
  }
  const noPersonal = await fixture('illegal', { personal: false });
  assert.equal((await run(noPersonal)).calls, 0, '两渠道都无法处理时零调用');
  pass('缺失/非法/不评估任务仅暂停新掌握度审核，个人渠道保持独立，两渠道均暂停时零调用');

  const positive = await run(f, aligned);
  assert.equal(positive.result.mastery[0].layers.judgment.status, 'supported', '只是本轮判断证据，不是完整掌握结论');
  assert.equal(positive.result.mastery[0].layers.reasoning.status, 'not_required');
  assert.equal(positive.result.growth.proposals[0].operation, 'review_conflict');
  assert.equal(positive.result.growth.proposals[0].status, 'pending_confirmation');
  const missingTaskGrowth = await run(await fixture(undefined), aligned);
  assert.equal(missingTaskGrowth.calls, 2);
  assert.equal(missingTaskGrowth.result.growth.proposals[0].operation, 'review_conflict');
  assert.equal(missingTaskGrowth.result.mastery[0].status, 'held');
  const assisted = await run(await fixture('fact', { hintLevel: 3 }), aligned);
  assert.equal(assisted.result.mastery[0].layers.judgment.status, 'unassessed');
  assert.ok(assisted.result.mastery[0].layers.judgment.reasons.includes('assisted_positive_held'));
  assert.equal(assisted.result.growth.proposals[0].authorship, 'adopted_with_assistance');
  pass('固定任务可保留参考正向影子证据和待确认个人冲突；缺任务不阻断个人提议，强提示仍无正向掌握证据');

  const comparison: ReviewSemanticComparison = { version: 1, packetId: f.packet.packetId,
    referenceAudit: { status: 'compatible', sourceIds: f.packet.references.map((source) => source.sourceId) },
    alignments: [], edgeChecks: [], personalLinks: [] };
  const bypass = { ...graph, requirements: [{ ...graph.requirements[0], layer: 'reasoning' as const }] };
  const shadow = buildReviewMasteryShadow(f.packet, bypass, comparison, []);
  assert.equal(shadow[0].layers.judgment.status, 'unassessed');
  assert.equal(shadow[0].layers.reasoning.status, 'not_required');
  const corrupt = structuredClone(f.packet); corrupt.questionIntent.assessment!.requirements[0].criterionIds = [];
  let called = 0;
  const stopped = await evaluateReviewComparisonPacket(corrupt, f.dependencies, createReviewSemanticModel(async () => {
    called++; assert.fail('Changed packet must stop before model work');
  }, { comparisonProtocol: 'isolated-anchors-v3' }));
  assert.equal(called, 0); assert.ok(stopped.reasons.includes('packet_changed'));
  pass('输出投影不信任外部草稿要求，契约变动在模型请求前拒绝，仍禁用分数和认知写入');

  const chatSource = await fs.readFile('src/components/ReviewChat.tsx', 'utf8');
  const hubSource = await fs.readFile('src/components/ReviewHub.tsx', 'utf8');
  const appSource = await fs.readFile('src/App.tsx', 'utf8');
  assert.ok(chatSource.includes('buildReviewTutorContext'));
  assert.ok((await fs.readFile('src/services/reviewTutorContext.ts', 'utf8')).includes('REVIEW_ASSESSMENT_MARKER_PROMPT'));
  assert.ok(chatSource.includes('questionText: openingQuestion.cleanText'));
  assert.ok(chatSource.includes('content: parsed.cleanText'));
  assert.ok(chatSource.includes('...inheritReviewQuestionIntent(lastQuestionIntentRef.current'));
  assert.ok(chatSource.includes('const targets = [...lastIntentRef.current]'));
  assert.ok(hubSource.includes('buildReviewOpeningQuestion(activeNote.title, false)'));
  assert.ok(hubSource.includes('buildReviewOpeningQuestion(selectedProject.title, true, selectedQuestions.map'));
  assert.ok(appSource.includes('question || buildReviewOpeningQuestion'));
  assert.ok(appSource.includes('setReviewQuestion(buildReviewOpeningQuestion'));
  pass('复习中心/图谱/Agent默认入口与回答绑定已接线（源码契约检查，非浏览器端到端实测）');
  console.log(`检验任务契约检查通过：${checks} 组；本地替身、零网络、零生产写入。`);
} finally { globalThis.fetch = fetchBefore; }
