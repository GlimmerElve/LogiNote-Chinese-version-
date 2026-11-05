import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { NoteItem } from '../src/types';
import { noteReferenceSourceDescriptor } from '../src/services/noteReferenceSource';
import { REVIEW_ASSESSMENT_TASKS, freezeReviewAssessment, type ReviewAssessmentTaskType } from '../src/services/reviewAssessment';
import { buildReviewReferenceCatalog, freezeReviewReferenceRubric, parseReviewReferenceRubric, recheckQuestionReferenceRubric,
  verifyReviewReferenceRubric, bindReviewReferenceItems, reviewReferenceCatalogPrompt, REVIEW_REFERENCE_LIMITS } from '../src/services/reviewReferenceRubric';
import { parseReviewTutorIntent, inheritReviewQuestionIntent, stripReviewIntentMarkers } from '../src/services/reviewIntent';
import { parseReviewQuestionIntent } from '../src/services/reviewIntentValidation';
import { reviewCognitionObservations } from '../src/services/cognition/observations';
import { buildReviewComparisonPacket, verifyReviewComparisonFreshness, reviewSnapshotHash } from '../src/services/reviewComparison/packet';
import { buildReviewAnchoredChannel, readReviewAnchoredComparison, type ReviewAnchoredInput } from '../src/services/reviewComparison/anchoredProtocol';
import { readReviewPerformanceGraph } from '../src/services/reviewComparison/performanceGraph';
import { validateReviewAlignments } from '../src/services/reviewComparison/semanticValidation';
import { buildReviewMasteryShadow } from '../src/services/reviewComparison/semanticOutputs';
import { createReviewSemanticModel } from '../src/services/reviewComparison/semanticClient';
import { evaluateReviewComparisonPacket } from '../src/services/reviewComparison/semanticEvaluator';
import type { ReviewPerformanceGraph, ReviewSemanticComparison } from '../src/services/reviewComparison/semanticTypes';
import type { ReviewComparisonPacket } from '../src/services/reviewComparison/types';
import { REVIEW_DUAL_DATASET } from './review-dual-dataset';
import { prepareReviewDualFixture } from './review-dual-fixture';
import { validateReviewDualAnchoredRequest, validateReviewDualReplayInput } from './review-dual-transport';

// Only synthetic in-memory notes and mocked model replies. Never opens a configured user vault.
const fetchBefore = globalThis.fetch;
globalThis.fetch = async () => assert.fail('No network allowed in question reference rubric checks');
let checks = 0, requests = 0;
const pass = (name: string) => { checks++; console.log(`PASS ${name}`); };
const at = '2026-10-06T00:00:00.000Z', topic = '选择过载';
const meaning = '选择过载是选项超过处理能力时难以决策的现象。';
const limit = '它并不意味着选项数量越多，所有人都会更难选择。';
const body = `## 含义\r\n${meaning}\r\n\r\n## 限定\r\n${limit}`;
const note = (content = body, id = 'synthetic-note', title = topic): NoteItem => ({ id, title, content, noteType: 'knowledge',
  tags: [], links: [], backlinks: [], dueDates: [], createdAt: at, updatedAt: at });
const catalogFor = (notes = [note()], query = '') => buildReviewReferenceCatalog(notes, [topic], notes.map((n) => n.id), query);
const markerFor = (catalog: Awaited<ReturnType<typeof catalogFor>>) =>
  `concept_meaning=${catalog.candidates.find((c) => c.quote === meaning)!.candidateId};concept_boundary=${catalog.candidates.find((c) => c.quote === limit)!.candidateId}`;
const assessment = freezeReviewAssessment('definition', [topic]);

async function fixture(options: { content?: string; answer?: string; marker?: string; task?: ReviewAssessmentTaskType;
  personal?: boolean; hint?: 0 | 1 | 2 | 3 | 4; unavailable?: boolean; legacy?: boolean } = {}) {
  const c = structuredClone(REVIEW_DUAL_DATASET.find((item) => item.id === 'G05')!);
  c.topic = topic; c.question = '请用自己的话说明本题的含义和限定。';
  c.answer = options.answer || `${meaning}\n${limit}`;
  c.references = [options.content || body]; c.hintLevel = options.hint || 0;
  if (options.personal === false) c.personal = undefined;
  const base = await prepareReviewDualFixture(c);
  const notes = await base.dependencies.readNotes();
  const dependencies = { ...base.dependencies, readNotes: async () => structuredClone(notes) };
  const catalog = await catalogFor(notes), task = freezeReviewAssessment(options.task || 'definition', [topic]);
  const rubric = freezeReviewReferenceRubric(options.unavailable ? undefined : options.marker || markerFor(catalog), task, catalog);
  const intent = { ...base.packet.questionIntent, assessment: task, ...(options.legacy ? {} : { referenceRubric: rubric }) };
  const packet = await buildReviewComparisonPacket({ activityId: base.packet.activityId, questionText: c.question,
    evidence: { messageId: base.packet.messageId, answer: c.answer, hintLevel: c.hintLevel,
      targetKnowledgeNames: [topic], questionIntent: intent } }, dependencies, { targetScopeNoteIds: notes.map((n) => n.id) });
  return { packet, dependencies, notes, catalog };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function graphFor(packet: ReviewComparisonPacket, role: ReviewPerformanceGraph['claims'][number]['role'] = 'definition') {
  return readReviewPerformanceGraph({ version: 1, packetId: packet.packetId,
    claims: [{ id: 'A1', role, quote: meaning }, { id: 'A2', role, quote: limit }], edges: [], requirements: [] }, packet);
}
function empty(input: ReviewAnchoredInput): any {
  return { version: 3, channel: input.channel, bindingId: input.bindingId, alignments: [],
    ...(input.channel === 'reference' ? { referenceAudit: { status: 'compatible', sourceIds: input.references!.map((r) => r.sourceId) }, edgeChecks: [],
      ...(input.referenceRubric ? { criterionChecks: input.referenceRubric.items.map((i) => ({ itemId: i.itemId,
        verdict: 'unobserved', pairIds: [], edgeSlotIds: [], confidence: 0.95 })) } : {}) } : { personalLinks: [] }) };
}
function alignment(input: ReviewAnchoredInput, claimId: string, quoteId: string, relation = 'consistent'): any {
  const anchor = input.anchors.find((a) => a.id === quoteId)!;
  const pair = input.pairs.find((p) => p.claimId === claimId && p.targetQuoteSourceId === anchor.sourceId)!;
  assert.ok(pair, 'Pair must be provided by the engine');
  const main = input.graph.claims.find((c) => c.id === claimId)!.quoteId;
  const axis = { status: 'same', leftQuoteId: input.channel === 'personal' ? quoteId : main,
    rightQuoteId: input.channel === 'personal' ? main : quoteId, reason: '合成替身指定的范围，不代表真实模型验证' };
  const absent = { status: 'not_applicable', leftQuoteId: null, rightQuoteId: null, reason: '本合成命题不涉及此维度' };
  return { pairId: pair.pairId, targetQuoteId: quoteId, relation, confidence: 0.95, sourcesCompatible: true,
    axes: { object: axis, condition: axis, time: absent, metric: { ...axis, status: 'same_dimension' }, baseline: absent } };
}
function complete(input: ReviewAnchoredInput): any {
  if (input.channel === 'personal') return empty(input);
  const result = empty(input);
  result.alignments = input.referenceRubric!.items.map((item, index) => alignment(input, `A${index + 1}`, item.quoteId));
  result.criterionChecks = input.referenceRubric!.items.map((item, index) => ({ itemId: item.itemId, verdict: 'covered',
    pairIds: [result.alignments[index].pairId], edgeSlotIds: [], confidence: 0.95 }));
  return result;
}
async function run(f: Fixture, graph = graphFor(f.packet), respond: (input: ReviewAnchoredInput) => unknown = complete,
  mutate?: (stage: number) => void) {
  let calls = 0;
  const packetBefore = JSON.stringify(f.packet), notesBefore = JSON.stringify(f.notes), cognitionBefore = JSON.stringify(await f.dependencies.loadCognition());
  const result = await evaluateReviewComparisonPacket(f.packet, f.dependencies, createReviewSemanticModel(async (request) => {
    const input = await validateReviewDualAnchoredRequest(request, ++calls, f.packet, graph);
    validateReviewDualReplayInput(request, structuredClone(request));
    if (calls === 1) {
      assert.ok(!Object.hasOwn(input, 'referenceRubric') && !Object.hasOwn(input, 'references') && !Object.hasOwn(input, 'personal'));
    }
    const response = calls === 1 ? graph : respond(input);
    mutate?.(calls);
    return { content: JSON.stringify(response) };
  }, { comparisonProtocol: 'isolated-anchors-v3' }));
  assert.equal(JSON.stringify(f.packet), packetBefore);
  if (!mutate) assert.equal(JSON.stringify(f.notes), notesBefore);
  assert.equal(JSON.stringify(await f.dependencies.loadCognition()), cognitionBefore);
  assert.equal(result.writes, 'disabled'); assert.ok(result.mastery.every((m) => m.scoreWrite === 'disabled'));
  assert.equal(result.modelRequests?.total, calls); assert.ok(calls <= 3); requests += calls;
  assert.ok(result.growth.proposals.every((p) => p.preserveOriginal && p.status === 'pending_confirmation'));
  return { result, calls };
}
const coverage = (outcome: Awaited<ReturnType<typeof run>>) => outcome.result.mastery[0].referenceCoverage!;

try {
  const catalog = await catalogFor();
  assert.equal(catalog.candidates.length, 2);
  for (const item of catalog.candidates) {
    assert.equal(note().content.slice(item.start, item.end), item.quote);
    assert.equal(item.sourceHash, createHash('sha256').update(JSON.stringify(noteReferenceSourceDescriptor(note()))).digest('hex'));
  }
  const unicode = await catalogFor([note(`## 含义\r\n🙂第一行原文\r\n第二行原文。`)]);
  assert.equal(unicode.candidates[0].quote, '🙂第一行原文\r\n第二行原文。');
  assert.equal(unicode.candidates[0].end - unicode.candidates[0].start, unicode.candidates[0].quote.length);
  assert.deepEqual(catalog, await catalogFor());
  pass('保存原文CRLF/UTF16/emoji坐标与本地索引v2来源指纹一致，候选构建可重现');

  const unrelated = { ...note('私人答案', 'private'), noteType: 'project' as const };
  const scoped = await buildReviewReferenceCatalog([note(), note('其他项目同名正文', 'other'), unrelated], [topic], ['synthetic-note', 'private']);
  assert.equal(scoped.candidates.length, 2);
  const ambiguous = await catalogFor([note(), note('第二份同名正文', 'other')]);
  assert.equal(ambiguous.candidates.length, 0); assert.ok(ambiguous.warnings.includes('ambiguous_reference_note'));
  const alias = await buildReviewReferenceCatalog([{ ...note(), aliases: ['别名'] }], ['别名'], ['synthetic-note']);
  assert.equal(alias.candidates[0].knowledgeTarget, '别名');
  assert.equal((await catalogFor([note('请对该知识点进行定义描述')])).candidates.length, 0);
  pass('参考仅来自指定知识点ID范围，项目复述/占位符不准入，同名歧义不猜，支持别名');

  const filtered = await catalogFor([note(`## 正文\n${meaning}\n\n## 来源\n不能作为检验项的引用列表\n\n## 超长句\n${'甲'.repeat(1000)}`)]);
  assert.ok(filtered.candidates.every((c) => c.quote === meaning));
  assert.equal((await catalogFor([note(`## 来源机制\n${meaning}`)])).candidates.length, 1, '来源机制正文不是引用列表');
  assert.equal((await catalogFor([note(`## Preferences\n${meaning}`)])).candidates.length, 1, '英文合法章节不得因包含references子串被丢弃');
  const long = await catalogFor([note(Array.from({ length: 90 }, (_, i) => `## 章节${i}\n这是第${i}个独立段落。`).join('\n\n'))]);
  assert.ok(long.candidates.length <= 48 && long.candidates.every((c) => c.quote.length <= 320));
  assert.ok(long.candidates.map((c) => JSON.stringify(c)).join('\n').length <= REVIEW_REFERENCE_LIMITS.contextCharacters);
  assert.ok(long.warnings.includes('reference_catalog_bounded'));
  const tail = await catalogFor([note(Array.from({ length: 90 }, (_, i) => `## 章节${i}\n${i === 89 ? '末尾机制匹配' : '普通独立段落'}。`).join('\n\n'))], '末尾机制匹配');
  assert.equal(tail.candidates[0].quote, '末尾机制匹配。');
  assert.ok(reviewReferenceCatalogPrompt(long).includes('不证明语义选择正确或整篇知识已覆盖'));
  const oversized = await catalogFor([note('甲'.repeat(500001))]);
  assert.ok(oversized.warnings.includes('reference_note_budget_exceeded'));
  pass('正文候选不含引用列表/强制断句；候选/字符/单篇预算明确，截断不宣称完整金标准');

  for (const task of Object.keys(REVIEW_ASSESSMENT_TASKS) as ReviewAssessmentTaskType[]) {
    const contract = freezeReviewAssessment(task, [topic]);
    const marker = contract.requirements[0].criterionIds.map((id) => `${id}=K1`).join(';');
    const fixed = freezeReviewReferenceRubric(marker, contract, catalog);
    assert.equal(fixed.status, 'fixed'); assert.deepEqual(parseReviewReferenceRubric(fixed, contract, [topic]), fixed);
  }
  const fixed = freezeReviewReferenceRubric(markerFor(catalog), assessment, catalog);
  assert.equal(fixed.items.length, 2);
  assert.equal(freezeReviewReferenceRubric(undefined, assessment, catalog).reason, 'missing_selection');
  assert.equal(freezeReviewReferenceRubric('无', assessment, catalog).reason, 'missing_selection');
  assert.equal(freezeReviewReferenceRubric('concept_meaning=K1', assessment, catalog).reason, 'incomplete_selection');
  for (const bad of ['unknown=K1', 'concept_meaning=K99;concept_boundary=K2', 'fact_scope=K1',
    'concept_meaning=K1,K1;concept_boundary=K2', 'concept_meaning=K1=K2', 'concept_meaning=K1;']) {
    assert.equal(freezeReviewReferenceRubric(bad, assessment, catalog).status, 'unavailable');
  }
  assert.equal(freezeReviewReferenceRubric('anything', freezeReviewAssessment('无', [topic]), catalog).status, 'not_assessed');
  pass('七类任务按完整预设选择本题原文，不选/缺项/非法/重复均暂缓；标题不自动等于参考标准');

  const otherCatalog = await buildReviewReferenceCatalog([note(), note('另一个知识点正文', 'other', '其他目标')], [topic, '其他目标'], ['synthetic-note', 'other']);
  const foreignId = otherCatalog.candidates.find((c) => c.knowledgeTarget === '其他目标')!.candidateId;
  assert.equal(freezeReviewReferenceRubric(`concept_meaning=${foreignId};concept_boundary=K1`, assessment, otherCatalog).status, 'unavailable');
  const many = await catalogFor([note(Array.from({ length: 20 }, (_, i) => `## 项${i}\n第${i}个句子。`).join('\n\n'))]);
  assert.equal(freezeReviewReferenceRubric(`concept_meaning=${many.candidates.slice(0, 12).map((c) => c.candidateId).join(',')};concept_boundary=K13`, assessment, many).status, 'unavailable');
  pass('跨知识点借用候选及超出12项预算不能形成固定基线');

  for (const mutate of [
    (r: any) => r.score = 100, (r: any) => r.scope = 'whole_knowledge', (r: any) => r.catalogId = 'fake',
    (r: any) => r.items.pop(), (r: any) => r.items[0].sourceHash = 'fake', (r: any) => r.items[0].start++,
    (r: any) => r.items[0].sourceUpdatedAt = 'not a date', (r: any) => r.items[0].expectedAnswer = '新增答案',
    (r: any) => r.items[0].criterionId = 'fact_scope',
  ]) { const bad = structuredClone(fixed); mutate(bad); assert.throws(() => parseReviewReferenceRubric(bad, assessment, [topic]), /invalid_reference_rubric/); }
  const reused = freezeReviewReferenceRubric('concept_meaning=K1;concept_boundary=K1', assessment, catalog);
  const forged = structuredClone(reused); forged.items[1] = { ...fixed.items[1], candidateId: 'K1' };
  assert.throws(() => parseReviewReferenceRubric(forged, assessment, [topic]), /invalid_reference_rubric/);
  const reordered = structuredClone(reused); reordered.items[1] = Object.fromEntries(Object.entries(reordered.items[1]).reverse()) as any;
  assert.deepEqual(parseReviewReferenceRubric(reordered, assessment, [topic]), reordered);
  pass('持久化闭合协议拒绝削减标准、伪造范围/来源/坐标，同一K#跨criterion不能更换原文');

  const options = { questionMessageId: 'q1', allowedKnowledgeTargets: [topic], fallbackKnowledgeTargets: [topic], referenceCatalog: catalog,
    cognitionCandidates: [{ token: 'C1', reference: { recordId: 'r1', revisionId: 'v1', branchId: 'b1', nodeId: 'n1' },
      title: topic, text: '旧观点', context: '', needsReview: false }] };
  const marked = `说明含义及边界。\n[意图:${topic}]\n[检验:definition]\n[认知意图:C1|give_evidence]\n[核对:${markerFor(catalog)}]`;
  const parsed = parseReviewTutorIntent(marked, options);
  assert.equal(parsed.cleanText, '说明含义及边界。'); assert.equal(stripReviewIntentMarkers(marked), parsed.cleanText);
  assert.equal(parsed.intent.referenceRubric?.status, 'fixed'); assert.equal(parsed.intent.cognitionTarget?.nodeId, 'n1');
  assert.deepEqual(parseReviewQuestionIntent(parsed.intent), parsed.intent);
  const duplicated = parseReviewTutorIntent(`${marked}\n[核对:${markerFor(catalog)}]`, options);
  assert.equal(duplicated.intent.referenceRubric?.status, 'unavailable'); assert.equal(duplicated.intent.cognitionTarget?.nodeId, 'n1');
  assert.deepEqual(duplicated.intent.knowledgeTargets, [topic]);
  const overflow = `${marked}${`\n[核对:${markerFor(catalog)}]`.repeat(9)}`;
  assert.equal(stripReviewIntentMarkers(overflow), parsed.cleanText);
  assert.equal(parseReviewTutorIntent(overflow, options).cleanText, parsed.cleanText);
  assert.equal(parseReviewTutorIntent(overflow, options).intent.referenceRubric?.status, 'unavailable');
  const legacy = parseReviewTutorIntent(marked, { ...options, referenceCatalog: undefined });
  assert.ok(!Object.hasOwn(legacy.intent, 'referenceRubric'));
  pass('四类隐藏标记分离解析；坏核对标记仅阻断参考，不抹去认知坐标，历史不事后补基线');

  const inherited = inheritReviewQuestionIntent(parsed.intent, 'q2');
  inherited.referenceRubric!.items[0].quote = '不能修改上一问';
  assert.equal(parsed.intent.referenceRubric!.items[0].quote, meaning);
  const observation = reviewCognitionObservations({ id: 'synthetic-episode', startedAt: at, endedAt: at, questionText: parsed.cleanText,
    knowledgeContext: '', messages: [{ id: 'q1', role: 'assistant', content: parsed.cleanText, timestamp: at },
      { id: 'answer1', role: 'user', content: meaning, timestamp: at }], answerEvidence: [{ messageId: 'answer1', answer: meaning,
        hintLevel: 0, targetKnowledgeNames: [topic], questionIntent: parsed.intent }] }, { title: topic });
  assert.deepEqual(observation[0].questionIntent?.referenceRubric, fixed);
  assert.equal(observation[0].answer, meaning);
  pass('提示/重述继承深拷贝，认知候选保留核对元数据但正文仍只取用户原话');

  assert.equal(await verifyReviewReferenceRubric(fixed, [note(), note('其他项目同名内容', 'elsewhere')]), true);
  for (const mutate of [(n: any) => n.content += '\n更新', (n: any) => n.updatedAt = '2026-10-07T00:00:00Z',
    (n: any) => n.title = '改名', (n: any) => n.noteType = 'project',
    (n: any) => n.referenceSources = [{ title: '新来源', type: 'web', url: 'https://example.test/reference' }]]) {
    const changed = note(); mutate(changed); assert.equal(await verifyReviewReferenceRubric(fixed, [changed]), false);
    const stale = await recheckQuestionReferenceRubric(fixed, async () => [changed]);
    assert.equal(stale.reason, 'source_changed'); assert.equal(stale.items.length, 0); assert.equal(stale.catalogId, fixed.catalogId);
  }
  assert.equal(await verifyReviewReferenceRubric(fixed, []), false);
  assert.equal(await verifyReviewReferenceRubric(fixed, [note(), note()]), false);
  assert.equal((await recheckQuestionReferenceRubric(fixed, async () => { throw Error('unavailable'); })).status, 'unavailable');
  pass('显示问题前复读原文/时间/类型/引用元数据；变化只能暂缓不能换新标准，其他项目同名不替换ID');

  const f = await fixture();
  assert.equal(f.packet.preparation.mastery, 'pending_alignment');
  assert.deepEqual(f.packet.questionIntent.referenceRubric!.items.map((i) => i.quote), [meaning, limit]);
  assert.equal(bindReviewReferenceItems(f.packet).length, 2);
  const unselected = await fixture({ unavailable: true });
  assert.equal(unselected.packet.preparation.mastery, 'held');
  assert.equal(unselected.packet.preparation.cognitionGrowth, 'pending_alignment');
  const unavailableResult = await run(unselected, graphFor(unselected.packet), empty);
  assert.equal(unavailableResult.calls, 2); assert.equal(unavailableResult.result.modelRequests!.reference, 0);
  assert.equal(unavailableResult.result.channels!.personal.status, 'reviewed');
  const withoutPersonal = await fixture({ unavailable: true, personal: false });
  assert.equal((await run(withoutPersonal)).calls, 0);
  pass('真实准备包绑定问题基线，未选参考只暂停参考侧；个人侧独立，双侧暂停零请求');

  const graph = graphFor(f.packet);
  const reference = await buildReviewAnchoredChannel(f.packet, graph, 'reference');
  const personal = await buildReviewAnchoredChannel(f.packet, graph, 'personal');
  assert.equal(reference.referenceRubric!.items.length, 2);
  assert.ok(reference.sources.every((s) => s.kind !== 'personal_node' && s.kind !== 'personal_context'));
  assert.ok(!Object.hasOwn(reference, 'questionText'));
  assert.ok(!Object.hasOwn(personal, 'referenceRubric') && !Object.hasOwn(personal, 'assessment') && !Object.hasOwn(personal, 'knowledgeTargets'));
  const changed = structuredClone(f.packet); changed.questionIntent.referenceRubric!.catalogId = `reference-catalog:${'f'.repeat(64)}`;
  assert.notEqual((await buildReviewAnchoredChannel(changed, graph, 'reference')).bindingId, reference.bindingId);
  assert.deepEqual(await buildReviewAnchoredChannel(changed, graph, 'personal'), personal);
  pass('参考侧I#绑定确切Q#位置和来源版本；个人侧不接收标准，指纹严格隔离');

  const positive = await run(f);
  assert.equal(positive.calls, 3); assert.equal(positive.result.channels!.reference.status, 'reviewed');
  assert.equal(coverage(positive).status, 'complete'); assert.equal(coverage(positive).scope, 'question_items');
  assert.ok(coverage(positive).items.every((i) => i.status === 'covered'));
  const onlyReference = await fixture({ personal: false });
  assert.equal((await run(onlyReference)).calls, 2);
  pass('真实适配器/传输重建/两侧审核投影通过：完整仅指本题所选项，无分数/认知写入');

  const partial = await run(f, graph, (input) => {
    const result = complete(input); if (input.channel === 'reference') {
      result.alignments.pop(); result.criterionChecks[1] = { ...result.criterionChecks[1], verdict: 'unobserved', pairIds: [] };
    } return result;
  });
  assert.equal(coverage(partial).status, 'partial');
  assert.deepEqual(coverage(partial).items.map((i) => i.status), ['covered', 'unobserved']);
  assert.equal(partial.result.mastery[0].status, 'evidence_ready');
  pass('一项匹配不能代表其余项或整篇已掌握，未表达为未观测不判错');

  for (const transform of [(r: any) => r.criterionChecks.pop(), (r: any) => r.criterionChecks[1] = r.criterionChecks[0],
    (r: any) => r.criterionChecks[0].itemId = 'I99', (r: any) => r.criterionChecks[0].pairIds = ['P99'],
    (r: any) => r.criterionChecks[0].pairIds.push(r.criterionChecks[0].pairIds[0]),
    (r: any) => r.criterionChecks[0].verdict = 'unobserved', (r: any) => delete r.criterionChecks]) {
    const rejected = await run(f, graph, (input) => { const response = complete(input); if (input.channel === 'reference') transform(response); return response; });
    assert.equal(rejected.calls, 3); assert.equal(rejected.result.channels!.reference.status, 'held');
    assert.equal(rejected.result.channels!.personal.status, 'reviewed'); assert.notEqual(coverage(rejected).status, 'complete');
  }
  pass('漏项/重复/伪造/不存在的匹配/缺协议均拒绝参考侧且不重试，仍审个人侧');

  const shared = structuredClone(f.packet);
  shared.questionIntent.referenceRubric = freezeReviewReferenceRubric('concept_meaning=K1;concept_boundary=K1', assessment, f.catalog);
  const sharedGraph = graphFor(shared), sharedInput = await buildReviewAnchoredChannel(shared, sharedGraph, 'reference');
  const sharedResponse = empty(sharedInput); sharedResponse.alignments = [alignment(sharedInput, 'A1', sharedInput.referenceRubric!.items[0].quoteId)];
  sharedResponse.criterionChecks = sharedInput.referenceRubric!.items.map((item) => ({ itemId: item.itemId, verdict: 'covered',
    pairIds: [sharedResponse.alignments[0].pairId], edgeSlotIds: [], confidence: 0.95 }));
  assert.equal((await readReviewAnchoredComparison(sharedResponse, shared, sharedGraph, 'reference')).rubricChecks!.length, 2);
  pass('两个criterion可以引用同一实际记录：引用复用不是重复输出，记录重复仍受原门禁保护');

  const duplicateText = `${meaning}\n\n${meaning}\n\n${limit}`;
  const df = await fixture({ content: duplicateText });
  const ds = structuredClone(df.packet), duplicateCandidate = df.catalog.candidates.filter((c) => c.quote === meaning).at(-1)!;
  // Deliberately provide both occurrences to exercise the negative binding guard. Production
  // now retains only the frozen items, not an incidental whole-note preview containing both.
  ds.references = [{ ...ds.references[0], text: duplicateText, textStart: 0, textEnd: duplicateText.length, truncated: false }];
  ds.questionIntent.referenceRubric = freezeReviewReferenceRubric(`concept_meaning=${duplicateCandidate.candidateId};concept_boundary=${df.catalog.candidates.find((c) => c.quote === limit)!.candidateId}`, assessment, df.catalog);
  const dg = graphFor(ds), di = await buildReviewAnchoredChannel(ds, dg, 'reference'), dr = complete(di);
  const oldOccurrence = di.anchors.find((a) => a.sourceId === 'R1' && a.text === meaning && a.start < duplicateCandidate.start)!;
  assert.ok(oldOccurrence); dr.alignments[0] = alignment(di, 'A1', oldOccurrence.id);
  await assert.rejects(readReviewAnchoredComparison(dr, ds, dg, 'reference'), /quote_anchor_outside_claim/);
  const outOfWindow = structuredClone(ds); outOfWindow.references[0].text = meaning; outOfWindow.references[0].textEnd = meaning.length;
  assert.throws(() => bindReviewReferenceItems(outOfWindow), /rubric_reference_outside_window/);
  pass('重复文字必须匹配所选原始位置，窗口之外不能借用首处同文或拼造锚点');

  const wrongRole = await run(f, graphFor(f.packet, 'fact'));
  assert.ok(coverage(wrongRole).items.every((i) => i.status === 'unobserved'));
  const low = await run(f, graph, (input) => { const r = complete(input); if (input.channel === 'reference') r.criterionChecks[1].confidence = 0.5; return r; });
  assert.equal(coverage(low).status, 'partial'); assert.ok(coverage(low).items[1].reasons.includes('low_criterion_confidence'));
  const lowAlignment = await run(f, graph, (input) => { const r = complete(input); if (input.channel === 'reference') r.alignments[1].confidence = 0.5; return r; });
  assert.equal(coverage(lowAlignment).status, 'partial');
  pass('仅有covered标签不能绕过角色及匹配/检验双重置信门禁');

  for (const hint of [1, 3] as const) {
    const assisted = await fixture({ hint }); const outcome = await run(assisted);
    assert.equal(coverage(outcome).status, 'held'); assert.notEqual(coverage(outcome).status, 'complete');
  }
  for (const status of ['conflict', 'unknown']) {
    const conflict = await run(f, graph, (input) => { const r = complete(input); if (input.channel === 'reference') r.referenceAudit.status = status; return r; });
    assert.equal(coverage(conflict).status, 'held');
  }
  pass('提示依赖不能证明独立完整掌握；现有资料冲突/未知兼容门禁不因逐项覆盖而放宽');

  const incorrectLimit = '选项数量越多，所有人都会更难选择。';
  const negativeFixture = await fixture({ answer: `${meaning}\n${incorrectLimit}` });
  const negativeGraph = readReviewPerformanceGraph({ version: 1, packetId: negativeFixture.packet.packetId,
    claims: [{ id: 'A1', role: 'definition', quote: meaning }, { id: 'A2', role: 'definition', quote: incorrectLimit }],
    edges: [], requirements: [] }, negativeFixture.packet);
  const contradicted = await run(negativeFixture, negativeGraph, (input) => {
    const r = complete(input); if (input.channel === 'reference') {
      r.alignments[1].relation = 'contradiction'; r.criterionChecks[1].verdict = 'contradicted';
      const pair = r.alignments[1]; pair.relationBasis = { kind: 'incompatible_facts',
        leftQuoteId: input.graph.claims[1].quoteId, rightQuoteId: pair.targetQuoteId, explanation: '合成审核替身指定的互斥范围，仅验证门禁而非语义准确率' };
    } return r;
  });
  // The negative fixture is actually opposite in scope; the semantic decision is explicitly mocked, not measured.
  assert.equal(coverage(contradicted).items[1].status, 'contradicted');
  const certainty = await run(negativeFixture, negativeGraph, (input) => {
    const r = complete(input); if (input.channel === 'reference') {
      r.alignments[1].relation = 'certainty_change'; r.criterionChecks[1].verdict = 'contradicted';
      r.alignments[1].relationBasis = { kind: 'evidence_limit', leftQuoteId: input.graph.claims[1].quoteId,
        rightQuoteId: r.alignments[1].targetQuoteId, explanation: '确定程度差异不是已证实错误' };
    } return r;
  });
  assert.notEqual(coverage(certainty).items[1].status, 'contradicted');
  pass('逐项负证据要求已通过共享语义门禁的互斥判定；确定程度差异不硬判本题错误');

  const relation = '在条件B下，A发生会触发机制M，因此C发生。';
  const reasoning = await fixture({ content: relation, answer: relation, task: 'reasoning', marker: 'actual_premise=K1;inference_link=K1' });
  const rg = readReviewPerformanceGraph({ version: 1, packetId: reasoning.packet.packetId,
    claims: [{ id: 'A1', role: 'premise', quote: '在条件B下，A发生会触发机制M' }, { id: 'A2', role: 'conclusion', quote: 'C发生' }],
    edges: [{ id: 'E1', source: 'A1', target: 'A2', relation: 'support', quote: relation }], requirements: [] }, reasoning.packet);
  const reasoningResponse = (input: ReviewAnchoredInput) => {
    if (input.channel === 'personal') return empty(input);
    const r = empty(input), quoteId = input.referenceRubric!.items[0].quoteId;
    r.alignments = [alignment(input, 'A1', quoteId), alignment(input, 'A2', quoteId)];
    r.edgeChecks = [{ slotId: input.edgeSlots[0].slotId, referenceQuoteId: quoteId, relation: 'support', verdict: 'supported',
      direction: 'source_to_target', basis: 'source', conclusion: 'target', premiseStatus: 'sufficient', confidence: 0.95 }];
    r.criterionChecks = [{ itemId: 'I1', verdict: 'covered', pairIds: [r.alignments[0].pairId], edgeSlotIds: [], confidence: 0.95 },
      { itemId: 'I2', verdict: 'covered', pairIds: [], edgeSlotIds: [r.edgeChecks[0].slotId], confidence: 0.95 }];
    return r;
  };
  assert.equal(coverage(await run(reasoning, rg, reasoningResponse)).status, 'complete');
  for (const edit of [(r: any) => r.edgeChecks[0].direction = 'target_to_source', (r: any) => r.edgeChecks[0].premiseStatus = 'missing',
    (r: any) => r.alignments.pop()]) {
    const outcome = await run(reasoning, rg, (input) => { const r = reasoningResponse(input); if (input.channel === 'reference') edit(r); return r; });
    assert.equal(coverage(outcome).items[1].status, 'unobserved');
  }
  const noEdge = readReviewPerformanceGraph({ ...rg, edges: [] }, reasoning.packet);
  const isolated = await run(reasoning, noEdge, (input) => {
    if (input.channel === 'personal') return empty(input);
    const r = empty(input), quoteId = input.referenceRubric!.items[0].quoteId;
    r.alignments = [alignment(input, 'A1', quoteId), alignment(input, 'A2', quoteId)];
    r.criterionChecks = input.referenceRubric!.items.map((i) => ({ itemId: i.itemId, verdict: 'covered', pairIds: [r.alignments[0].pairId], edgeSlotIds: [], confidence: 0.95 }));
    return r;
  });
  assert.equal(coverage(isolated).items[1].status, 'unobserved');
  pass('推理项须真实有向边/两端匹配/充分规则；反向、缺前提、单端或两孤立事实不能替代');

  const direct = await readReviewAnchoredComparison(complete(reference), f.packet, graph, 'reference');
  const truncated = structuredClone(f.packet); truncated.references[0].truncated = true;
  const intactItems = buildReviewMasteryShadow(truncated, graph, direct, validateReviewAlignments(direct, truncated, graph))[0].referenceCoverage!;
  assert.equal(intactItems.status, 'complete'); assert.equal(intactItems.scope, 'question_items');
  const cutItem = structuredClone(truncated);
  cutItem.references[0].text = cutItem.references[0].text.slice(0, -1); cutItem.references[0].textEnd--;
  assert.equal(buildReviewMasteryShadow(cutItem, graph, direct, validateReviewAlignments(direct, cutItem, graph))[0].referenceCoverage!.status, 'held');
  const stale = await fixture(); stale.notes[0].referenceSources = [{ title: '变化的来源', type: 'web' }];
  assert.ok((await verifyReviewComparisonFreshness(stale.packet, stale.dependencies)).reasons.includes('question_reference_changed'));
  assert.equal((await run(stale)).calls, 0);
  const during = await fixture();
  const after = await run(during, graphFor(during.packet), complete, (stage) => { if (stage === 2) during.notes[0].content += '\n后续修改'; });
  assert.equal(after.calls, 2); assert.equal(after.result.status, 'held');
  assert.ok(after.result.reasons.includes('question_reference_changed'));
  assert.equal(coverage(after).status, 'held'); assert.equal(coverage(after).scope, 'question_items');
  pass('完整本题项不冒充整篇掌握，切断本题项仍暂停；审核前/期间来源变化停止新请求、不回写');

  const legacyModel = createReviewSemanticModel(async () => assert.fail('New rubric cannot use a legacy mixed protocol'));
  const legacyHeld = await evaluateReviewComparisonPacket(f.packet, f.dependencies, legacyModel);
  assert.ok(legacyHeld.reasons.includes('rubric_requires_anchored_protocol'));
  const historical = await fixture({ legacy: true });
  const legacyOutcome = await run(historical, graphFor(historical.packet), empty);
  assert.equal(legacyOutcome.calls, 3); assert.ok(!Object.hasOwn(legacyOutcome.result.mastery[0], 'referenceCoverage'));
  pass('新基线不走旧混合审核；历史缺字段保留显式旧行为而不是事后自动升级');

  // Re-signing a modified packet does not allow a selected interval outside its prepared original window.
  const omitted = structuredClone(f.packet); omitted.references[0].text = '当前窗口不含选定内容';
  omitted.references[0].textEnd = omitted.references[0].text.length;
  const { packetId: _id, snapshotHash: _sha, ...omittedBody } = omitted;
  const digest = await reviewSnapshotHash(omittedBody); omitted.snapshotHash = digest; omitted.packetId = `review-comparison:${digest}`;
  assert.throws(() => bindReviewReferenceItems(omitted), /rubric_reference_outside_window/);
  const chat = await fs.readFile('src/components/ReviewChat.tsx', 'utf8');
  assert.ok(chat.includes('referenceCatalog,') && chat.includes('await recheckQuestionReferenceRubric(nextIntent.referenceRubric'));
  assert.ok(chat.includes('buildReviewTutorContext'));
  assert.ok(chat.includes('skipMemoryInjection: true, skipProfileInjection: true'));
  assert.ok(chat.includes('content: fallback.cleanText') && !chat.includes('didInitRef'), 'Optional preparation and strict effect replay cannot leave an empty opener');
  assert.ok(chat.includes('tutorOperationRef.current || isTutorResponding'));
  const runner = await fs.readFile('scripts/run-review-dual-experiment.ts', 'utf8');
  assert.ok(runner.includes('rubricCoverage.ts') && runner.includes('reviewReferenceRubric.ts'));
  pass('真实复习入口读取保存版、显示前回核、操作锁/继承/非空降级和上下文预算接线；实验指纹含新协议');

  console.log(`PASS ${checks} question-reference rubric groups; ${requests} local mock requests; zero network, production data or writes`);
} finally { globalThis.fetch = fetchBefore; }
