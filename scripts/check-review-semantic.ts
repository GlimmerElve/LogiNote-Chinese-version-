import assert from 'node:assert/strict';
import type { NoteItem } from '../src/types';
import type { CognitionFile } from '../src/services/cognition/types';
import type { ReviewComparisonAnswer, ReviewComparisonDependencies, ReviewComparisonPacket } from '../src/services/reviewComparison/types';
import type { ReviewPerformanceGraph, ReviewSemanticComparison, ReviewSemanticModel, ReviewClaimAlignment } from '../src/services/reviewComparison/semanticTypes';
import { buildReviewComparisonPacket } from '../src/services/reviewComparison/packet';
import { readReviewPerformanceGraph } from '../src/services/reviewComparison/performanceGraph';
import { evaluateReviewComparisonPacket, evaluateReviewComparisonSession } from '../src/services/reviewComparison/semanticEvaluator';
import { validateGroundedAlignment } from '../src/services/cognition/alignment';
import { summarizeReviewComparison } from '../src/services/reviewComparison/session';
import { createReviewSemanticModel, readReviewModelJson } from '../src/services/reviewComparison/semanticClient';
import { REVIEW_DUAL_ALIGNMENT_EXAMPLE, REVIEW_DUAL_ALIGNMENT_PROMPT } from '../src/services/reviewComparison/semanticPrompts';

const fetchBefore = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Cloud calls forbidden in semantic checks'); };
const at = '2026-10-06T00:00:00.000Z';
const old = '在条件B下，A会导致C。';
const next = '在条件B下，A也会导致D。';
let checks = 0;
const pass = (name: string) => { checks++; console.log(`PASS ${name}`); };
const span = (quote: string, text = quote) => ({ quote, start: text.indexOf(quote), end: text.indexOf(quote) + quote.length });
const na = { status: 'not_applicable' as const, personalQuote: '', documentQuote: '', reason: '该命题不涉及此维度' };
const axes = (left: string, right: string, metric: 'same' | 'different' = 'same') => ({
  object: { status: 'same' as const, personalQuote: 'A', documentQuote: 'A', reason: '同一对象A' },
  condition: { status: 'same' as const, personalQuote: '条件B', documentQuote: '条件B', reason: '同一条件B' },
  time: na, baseline: na,
  metric: { status: metric, personalQuote: left.includes('C') ? 'C' : 'D', documentQuote: right.includes('C') ? 'C' : 'D', reason: '结果指标核对' },
});

async function fixture(options: { answer?: string; reference?: string; personal?: string; question?: string; hint?: 0 | 1 | 2 | 3 | 4; target?: boolean; noReference?: boolean } = {}) {
  const note: NoteItem = { id: 'k1', title: '知识甲', noteType: 'knowledge', content: options.reference || options.answer || next,
    tags: [], links: [], backlinks: [], dueDates: [], createdAt: at, updatedAt: at };
  const file: CognitionFile = { schemaVersion: 1, revision: 1, records: [{ id: 'r1', docId: 'argument1', revisions: [{
    id: 'v1', number: 1, at, operation: 'initial', reason: '', authorship: 'own_expression',
    source: { kind: 'argument_editor', docId: 'argument1' }, factSupport: 'not_assessed', mastery: 'not_assessed',
    branches: [{ id: 'b1', kind: 'primary', context: '条件B', stance: 'endorsed',
      graph: { title: '知识甲', nodes: [{ id: 'n1', text: options.personal || old, mainType: '事实陈述' }], edges: [] } }],
  }] }] };
  const input: ReviewComparisonAnswer = { activityId: 'session1', questionText: options.question || '在条件B下，A还会导致什么？',
    evidence: { messageId: 'answer1', answer: options.answer || next, hintLevel: options.hint || 0,
      targetKnowledgeNames: ['知识甲'], questionIntent: { version: 1, questionMessageId: 'tutor1', knowledgeTargets: ['知识甲'],
        ...(options.target === false ? {} : { cognitionTarget: { recordId: 'r1', revisionId: 'v1', branchId: 'b1', nodeId: 'n1', purpose: 'give_evidence' } }) } } };
  const dependencies: ReviewComparisonDependencies = {
    readNotes: async () => options.noReference ? [] : structuredClone([note]),
    loadCognition: async () => structuredClone(file), searchNotes: async () => [], searchDocuments: async () => [],
    previewDocument: async () => { throw new Error('No document in fixture'); },
  };
  const packet = await buildReviewComparisonPacket(input, dependencies, { targetScopeNoteIds: [note.id] });
  return { packet, dependencies, note, file };
}

function graphFor(packet: ReviewComparisonPacket, layer: 'concept' | 'judgment' | 'reasoning' = 'judgment'): ReviewPerformanceGraph {
  return { version: 1, packetId: packet.packetId,
    claims: [{ id: 'A1', role: layer === 'concept' ? 'definition' : 'fact', ...span(packet.answer.text) }], edges: [],
    requirements: [{ knowledgeTarget: '知识甲', layer, ...span(packet.questionText) }] };
}

function comparisonFor(packet: ReviewComparisonPacket): ReviewSemanticComparison {
  const claim = packet.answer.text, previous = packet.personal.graph?.nodes[0]?.text || '';
  const alignments: ReviewClaimAlignment[] = [];
  if (packet.personal.status === 'ready') alignments.push({ claimId: 'A1', corpus: 'personal', targetId: 'n1', confidence: 0.95,
    relation: 'supplement', personalQuote: previous, documentQuote: claim, sourcesCompatible: true, axes: axes(previous, claim, 'different') });
  if (packet.references.length) alignments.push({ claimId: 'A1', corpus: 'reference', targetId: 'R1', knowledgeTarget: '知识甲', confidence: 0.95,
    relation: 'consistent', personalQuote: claim, documentQuote: packet.references[0].text, sourcesCompatible: true,
    axes: axes(claim, packet.references[0].text) });
  return { version: 1, packetId: packet.packetId,
    referenceAudit: { status: 'compatible', sourceIds: packet.references.map((s) => s.sourceId) },
    alignments, edgeChecks: [], personalLinks: [] };
}

function mock(packet: ReviewComparisonPacket, options: {
  graph?: unknown; comparison?: unknown; onExtract?: () => void; onCompare?: () => void;
} = {}) {
  const calls = { extract: 0, compare: 0 };
  const model: ReviewSemanticModel = {
    extract: async (input) => {
      calls.extract++;
      assert.deepEqual(Object.keys(input).sort(), ['answer', 'knowledgeTargets', 'packetId', 'questionText']);
      options.onExtract?.();
      return structuredClone(options.graph ?? graphFor(packet));
    },
    compare: async () => { calls.compare++; options.onCompare?.(); return structuredClone(options.comparison ?? comparisonFor(packet)); },
  };
  return { model, calls };
}

try {
  const f = await fixture();
  const before = JSON.stringify([f.packet, f.note, f.file]);
  const m = mock(f.packet);
  const result = await evaluateReviewComparisonPacket(f.packet, f.dependencies, m.model);
  assert.deepEqual(m.calls, { extract: 1, compare: 1 });
  assert.equal(result.status, 'reviewed'); assert.equal(result.writes, 'disabled');
  assert.equal(result.growth.status, 'proposed'); assert.equal(result.growth.proposals[0].operation, 'supplement');
  assert.equal(result.growth.proposals[0].preserveOriginal, true); assert.equal(result.growth.proposals[0].claim.quote, next);
  assert.equal(result.growth.proposals[0].link, undefined); // give_evidence intent alone proves no link.
  assert.equal(result.mastery[0].layers.judgment.status, 'supported');
  assert.equal(result.mastery[0].layers.reasoning.status, 'not_required');
  assert.equal(result.mastery[0].scoreWrite, 'disabled');
  assert.equal(JSON.stringify([f.packet, f.note, f.file]), before);
  assert.equal(JSON.stringify(result).includes('conceptDelta'), false);
  assert.equal(result.growth.proposals[0].proposalId, (await evaluateReviewComparisonPacket(f.packet, f.dependencies, m.model)).growth.proposals[0].proposalId);
  pass('抽取一次供双渠道使用；新增D保留C，导师证据意图不自动产生连线或分数');

  for (const quote of [f.packet.questionText, old, '模型虚构的完整回答']) {
    const bad = graphFor(f.packet); bad.claims[0] = { ...bad.claims[0], ...span(quote, f.packet.answer.text) };
    const badMock = mock(f.packet, { graph: bad });
    const rejected = await evaluateReviewComparisonPacket(f.packet, f.dependencies, badMock.model);
    assert.equal(rejected.status, 'held'); assert.deepEqual(rejected.reasons, ['ungrounded_span']);
    assert.equal(badMock.calls.compare, 0);
  }
  const emoji = await fixture({ answer: '🙂在条件B下，A导致D。' });
  const emojiGraph = graphFor(emoji.packet); emojiGraph.claims[0] = { ...emojiGraph.claims[0], ...span('在条件B下，A导致D。', emoji.packet.answer.text) };
  assert.equal(readReviewPerformanceGraph(emojiGraph, emoji.packet).claims[0].start, 2);
  emojiGraph.claims[0].start = 1;
  assert.equal(readReviewPerformanceGraph(emojiGraph, emoji.packet).claims[0].start, 2);
  emojiGraph.requirements[0].end = -1;
  assert.equal(readReviewPerformanceGraph(emojiGraph, emoji.packet).requirements[0].end, emoji.packet.questionText.length);
  pass('导师、旧认知和改写不能冒充用户输出；唯一原文不因模型数错UTF-16下标误拒');

  const automatic = structuredClone(emojiGraph) as any;
  delete automatic.claims[0].start; delete automatic.claims[0].end;
  delete automatic.requirements[0].start; delete automatic.requirements[0].end;
  assert.equal(readReviewPerformanceGraph(automatic, emoji.packet).claims[0].start, 2);
  const repeatedAnswer = await fixture({ answer: 'A导致C。A导致C。' });
  const ambiguous = graphFor(repeatedAnswer.packet) as any;
  ambiguous.claims[0] = { id: 'A1', role: 'fact', quote: 'A导致C。' };
  assert.throws(() => readReviewPerformanceGraph(ambiguous, repeatedAnswer.packet), /ambiguous_span/);
  ambiguous.claims[0] = { ...ambiguous.claims[0], start: 5, end: 10 };
  assert.equal(readReviewPerformanceGraph(ambiguous, repeatedAnswer.packet).claims[0].start, 5);
  ambiguous.claims[0].start = 4;
  assert.throws(() => readReviewPerformanceGraph(ambiguous, repeatedAnswer.packet), /ungrounded_span/);
  pass('唯一引文由程序计算位置，重复原文必须定位，不依赖模型数长文本字符');

  for (const mutate of [
    (c: ReviewSemanticComparison) => { c.alignments[1].targetId = 'n1'; },
    (c: ReviewSemanticComparison) => { c.alignments[1].knowledgeTarget = '未授权知识'; },
    (c: ReviewSemanticComparison) => { c.packetId = 'another-packet'; },
    (c: ReviewSemanticComparison) => { c.alignments.push(c.alignments[0]); },
    (c: ReviewSemanticComparison) => { c.alignments[0].targetId = 'unknown-node'; },
  ]) {
    const c = comparisonFor(f.packet); mutate(c);
    const rejected = await evaluateReviewComparisonPacket(f.packet, f.dependencies, mock(f.packet, { comparison: c }).model);
    assert.equal(rejected.status, 'held'); assert.equal(rejected.growth.proposals.length, 0);
    assert.ok(rejected.mastery.every((v) => v.status === 'held'));
  }
  pass('未知来源、伪造知识点、重复配对和错误快照不能获得任一输出');

  const ungrounded = comparisonFor(f.packet);
  ungrounded.alignments[0].documentQuote = '伪造证据'; ungrounded.alignments[1].documentQuote = old;
  const rejectedQuotes = await evaluateReviewComparisonPacket(f.packet, f.dependencies, mock(f.packet, { comparison: ungrounded }).model);
  assert.equal(rejectedQuotes.growth.status, 'held'); assert.equal(rejectedQuotes.mastery[0].layers.judgment.status, 'unassessed');
  assert.ok(rejectedQuotes.alignments.every((a) => a.code === 'ungrounded_quote'));
  pass('左右引用按渠道分别回核，个人原话不能替代参考依据');

  for (const mutate of [
    (c: ReviewSemanticComparison) => { c.alignments.forEach((a) => { a.axes.condition = { ...na, status: 'unknown', reason: '必要条件未知' }; }); },
    (c: ReviewSemanticComparison) => { c.alignments.forEach((a) => { a.confidence = 0.4; }); },
  ]) {
    const c = comparisonFor(f.packet); mutate(c);
    const rejected = await evaluateReviewComparisonPacket(f.packet, f.dependencies, mock(f.packet, { comparison: c }).model);
    assert.equal(rejected.growth.status, 'held'); assert.equal(rejected.mastery[0].layers.judgment.status, 'unassessed');
    assert.equal(rejected.mastery[0].layers.judgment.observations.length, 0);
  }
  pass('必要范围未知、低置信度只保持未评估，不记用户错误');

  const different = await fixture({ answer: '在条件E下，A会导致C。', reference: '在条件B下，A会导致C。' });
  const d = comparisonFor(different.packet);
  for (const a of d.alignments) {
    a.relation = 'condition_difference'; a.axes.metric = { status: 'same', personalQuote: 'C', documentQuote: 'C', reason: '同一结果C' };
    a.axes.condition = { status: 'different', personalQuote: a.corpus === 'personal' ? '条件B' : '条件E',
      documentQuote: a.corpus === 'personal' ? '条件E' : '条件B', reason: '明确不同的适用条件' };
  }
  const coexist = await evaluateReviewComparisonPacket(different.packet, different.dependencies, mock(different.packet, { comparison: d }).model);
  assert.equal(coexist.growth.proposals[0].operation, 'contextual');
  assert.equal(coexist.mastery[0].layers.judgment.status, 'unassessed');
  pass('条件不同形成并存提议，不能作为参考反驳或负向掌握证据');

  const uncertain = await fixture({ answer: '在条件B下，A必然导致C。', reference: '在条件B下，A可能导致C。', target: false });
  const uc = comparisonFor(uncertain.packet); uc.alignments[0].relation = 'contradiction';
  uc.alignments[0].relationBasis = { kind: 'observed_counterexample', personalQuote: uncertain.packet.answer.text,
    documentQuote: uncertain.packet.references[0].text, explanation: '草稿错误地把可能当反例' };
  const noFalseConflict = await evaluateReviewComparisonPacket(uncertain.packet, uncertain.dependencies, mock(uncertain.packet, { comparison: uc }).model);
  assert.equal(noFalseConflict.mastery[0].layers.judgment.status, 'unassessed');
  assert.equal(noFalseConflict.alignments[0].code, 'conflict_not_established');
  pass('可能、不保证和证据不足不能冒充已发生反例');

  const certainty = await fixture({ personal: '在条件B下，A必然导致C。', answer: '在条件B下，尚不能证明A必然导致C。' });
  const cc = comparisonFor(certainty.packet); const ca = cc.alignments[0];
  ca.relation = 'certainty_change'; ca.axes.metric.status = 'same';
  ca.relationBasis = { kind: 'evidence_limit', personalQuote: '必然', documentQuote: '尚不能证明', explanation: '旧主张的必然性尚无依据' };
  const qualify = await evaluateReviewComparisonPacket(certainty.packet, certainty.dependencies, mock(certainty.packet, { comparison: cc }).model);
  assert.equal(qualify.growth.proposals[0].operation, 'certainty_review');
  assert.equal(qualify.growth.proposals[0].alignment.personalQuote, certainty.packet.personal.graph!.nodes[0].text);
  assert.equal(qualify.growth.proposals[0].alignment.documentQuote, certainty.packet.answer.text);
  assert.equal(qualify.growth.proposals[0].preserveOriginal, true);
  pass('确定程度调整按旧认知→新回答方向核对，仍须用户确认、不直接降级');

  const noRef = await fixture({ noReference: true });
  const noReference = await evaluateReviewComparisonPacket(noRef.packet, noRef.dependencies, mock(noRef.packet).model);
  assert.equal(noReference.growth.status, 'proposed'); assert.equal(noReference.mastery[0].status, 'held');
  assert.ok(noReference.mastery[0].reasons.includes('insufficient_reference'));
  assert.equal(noReference.mastery[0].layers.judgment.observations.length, 0);
  pass('无参考仍可提议个人认知补充，但不从个人库补出掌握依据');

  const staleFile = structuredClone(f.file); staleFile.records[0].revisions[0].id = 'v2';
  const staleDeps = { ...f.dependencies, loadCognition: async () => staleFile };
  const stalePacket = await buildReviewComparisonPacket({ activityId: 'session1', questionText: f.packet.questionText,
    evidence: { messageId: 'answer1', answer: next, hintLevel: 0, targetKnowledgeNames: ['知识甲'], questionIntent: f.packet.questionIntent } }, staleDeps, { targetScopeNoteIds: ['k1'] });
  const independent = await evaluateReviewComparisonPacket(stalePacket, staleDeps, mock(stalePacket).model);
  assert.equal(independent.growth.status, 'held'); assert.equal(independent.mastery[0].layers.judgment.status, 'supported');
  pass('准备时个人坐标过期不重定向，参考侧仍可独立生成本轮证据');

  for (const status of ['conflict', 'unknown'] as const) {
    const c = comparisonFor(f.packet); c.referenceAudit.status = status;
    const audited = await evaluateReviewComparisonPacket(f.packet, f.dependencies, mock(f.packet, { comparison: c }).model);
    assert.equal(audited.growth.status, 'proposed'); assert.equal(audited.mastery[0].status, 'held');
  }
  const incompleteAudit = comparisonFor(f.packet); incompleteAudit.referenceAudit.sourceIds = [];
  assert.equal((await evaluateReviewComparisonPacket(f.packet, f.dependencies, mock(f.packet, { comparison: incompleteAudit }).model)).status, 'held');
  pass('参考分歧和未核对兼容性阻止评分证据；审核不得遗漏获准来源');

  const trunc = await fixture({ reference: next + '后续上下文。'.repeat(600) });
  const tc = comparisonFor(trunc.packet); tc.alignments[1].documentQuote = next;
  const truncated = await evaluateReviewComparisonPacket(trunc.packet, trunc.dependencies, mock(trunc.packet, { comparison: tc }).model);
  assert.equal(truncated.mastery[0].status, 'held'); assert.ok(truncated.mastery[0].reasons.includes('incomplete_reference_context'));
  assert.equal(truncated.growth.status, 'proposed');
  pass('截断参考不能证明完整条件或无例外，不把预览命中当可评分');

  const assisted = await fixture({ hint: 3 });
  const assistedResult = await evaluateReviewComparisonPacket(assisted.packet, assisted.dependencies, mock(assisted.packet).model);
  assert.equal(assistedResult.growth.proposals[0].authorship, 'adopted_with_assistance');
  assert.equal(assistedResult.mastery[0].layers.judgment.status, 'unassessed');
  assert.ok(assistedResult.mastery[0].layers.judgment.reasons.includes('assisted_positive_held'));
  const wrong = await fixture({ answer: '在条件B下，A导致C。', reference: '在条件B下，A不导致C。', target: false, hint: 3 });
  const wc = comparisonFor(wrong.packet); wc.alignments[0].relation = 'contradiction';
  wc.alignments[0].relationBasis = { kind: 'incompatible_facts', personalQuote: wrong.packet.answer.text,
    documentQuote: wrong.packet.references[0].text, explanation: '同范围下相反事实' };
  const negative = await evaluateReviewComparisonPacket(wrong.packet, wrong.dependencies, mock(wrong.packet, { comparison: wc }).model);
  assert.equal(negative.mastery[0].layers.judgment.status, 'contradicted');
  assert.equal(negative.mastery[0].scoreWrite, 'disabled');
  pass('强提示不能形成正向掌握证据；明确冲突仅留影子证据，不写分数');

  const duplicate = await fixture({ answer: old, reference: old });
  const repeated = comparisonFor(duplicate.packet); repeated.alignments[0].axes.metric.status = 'same';
  const repeatedResult = await evaluateReviewComparisonPacket(duplicate.packet, duplicate.dependencies, mock(duplicate.packet, { comparison: repeated }).model);
  assert.equal(repeatedResult.growth.status, 'no_change'); assert.equal(repeatedResult.growth.proposals.length, 0);
  const linked = comparisonFor(f.packet);
  linked.personalLinks = [{ claimId: 'A1', targetNodeId: 'n1', answerQuote: next, personalQuote: old, relation: 'support',
    direction: 'personal_to_answer', basis: 'personal', conclusion: 'answer', premiseStatus: 'sufficient', confidence: 0.95 }];
  const linkedResult = await evaluateReviewComparisonPacket(f.packet, f.dependencies, mock(f.packet, { comparison: linked }).model);
  assert.equal(linkedResult.growth.proposals[0].link?.direction, 'personal_to_answer');
  linked.personalLinks[0].basis = 'answer';
  const misdirected = await evaluateReviewComparisonPacket(f.packet, f.dependencies, mock(f.packet, { comparison: linked }).model);
  assert.equal(misdirected.growth.proposals[0].link, undefined);
  pass('已存相同原话不重复生长；个人连线保留真实方向，端点角色不一致则舍弃');

  const evidence = await fixture({ answer: '在条件B下，三次实测都观察到A导致C。', hint: 1 });
  const ec = comparisonFor(evidence.packet); ec.alignments[0].relation = 'consistent'; ec.alignments[0].axes.metric.status = 'same';
  const restateOnly = await evaluateReviewComparisonPacket(evidence.packet, evidence.dependencies, mock(evidence.packet, { comparison: ec }).model);
  assert.equal(restateOnly.growth.status, 'no_change');
  ec.personalLinks = [{ claimId: 'A1', targetNodeId: 'n1', answerQuote: evidence.packet.answer.text, personalQuote: old,
    relation: 'support', direction: 'answer_to_personal', basis: 'answer', conclusion: 'personal', premiseStatus: 'sufficient', confidence: 0.95 }];
  const additionalEvidence = await evaluateReviewComparisonPacket(evidence.packet, evidence.dependencies, mock(evidence.packet, { comparison: ec }).model);
  assert.equal(additionalEvidence.growth.proposals[0].operation, 'supplement');
  assert.equal(additionalEvidence.growth.proposals[0].link?.direction, 'answer_to_personal');
  assert.equal(additionalEvidence.growth.proposals[0].authorship, 'adopted_with_assistance');
  assert.equal(additionalEvidence.assistance.hintLevel, 1);
  ec.personalLinks[0].direction = 'personal_to_answer'; ec.personalLinks[0].basis = 'personal'; ec.personalLinks[0].conclusion = 'answer';
  assert.equal((await evaluateReviewComparisonPacket(evidence.packet, evidence.dependencies, mock(evidence.packet, { comparison: ec }).model)).growth.status, 'no_change');
  pass('相容的新观察须独立支持审核才形成证据生长；弱提示也不标成独立表达');

  const concept = await fixture({ answer: '选择过载是选项过多且难以比较的状态。',
    reference: '选择过载指选项过多且难以比较的状态。', question: '请用自己的话定义选择过载。', target: false });
  const cp = comparisonFor(concept.packet); const ax = cp.alignments[0].axes;
  ax.object = { status: 'same', personalQuote: '选择过载', documentQuote: '选择过载', reason: '同一概念' };
  ax.condition = { status: 'same', personalQuote: '选项过多且难以比较', documentQuote: '选项过多且难以比较', reason: '保留定义条件' };
  ax.metric = na;
  const conceptResult = await evaluateReviewComparisonPacket(concept.packet, concept.dependencies, mock(concept.packet, { graph: graphFor(concept.packet, 'concept'), comparison: cp }).model);
  assert.equal(conceptResult.mastery[0].layers.concept.status, 'supported');
  assert.equal(conceptResult.mastery[0].layers.reasoning.status, 'not_required');
  assert.deepEqual(conceptResult.mastery[0].layers.reasoning.reasons, []);
  pass('引文文字不同的同义定义可产生概念证据；定义题不要求完整推理链');

  const reasoning = await fixture({ answer: '在条件B下，A导致C。因此在条件B下，A也导致D。',
    reference: '在条件B下，A导致C。因此在条件B下，A也导致D。', question: '请说明理由和结论。', target: false });
  const rg = graphFor(reasoning.packet, 'reasoning');
  const q1 = '在条件B下，A导致C。', q2 = '在条件B下，A也导致D。';
  rg.claims = [{ id: 'A1', role: 'premise', ...span(q1, reasoning.packet.answer.text) }, { id: 'A2', role: 'conclusion', ...span(q2, reasoning.packet.answer.text) }];
  rg.edges = [{ id: 'E1', source: 'A1', target: 'A2', relation: 'support', ...span(reasoning.packet.answer.text) }];
  const rc = comparisonFor(reasoning.packet);
  rc.alignments = rg.claims.map((claim) => ({ claimId: claim.id, corpus: 'reference', targetId: 'R1', knowledgeTarget: '知识甲',
    confidence: 0.95, relation: 'consistent', personalQuote: claim.quote, documentQuote: claim.quote, axes: axes(claim.quote, claim.quote), sourcesCompatible: true }));
  rc.edgeChecks = [{ edgeId: 'E1', knowledgeTarget: '知识甲', sourceId: 'R1', referenceQuote: reasoning.packet.references[0].text,
    relation: 'support', verdict: 'supported', direction: 'source_to_target', basisClaimId: 'A1', conclusionClaimId: 'A2', premiseStatus: 'sufficient', confidence: 0.95 }];
  const reasoningResult = await evaluateReviewComparisonPacket(reasoning.packet, reasoning.dependencies, mock(reasoning.packet, { graph: rg, comparison: rc }).model);
  assert.equal(reasoningResult.mastery[0].layers.reasoning.status, 'supported');
  assert.equal(JSON.stringify(reasoningResult).includes('completeChain'), false);
  for (const mutate of [
    (c: ReviewSemanticComparison) => { c.edgeChecks[0].direction = 'target_to_source'; c.edgeChecks[0].basisClaimId = 'A2'; c.edgeChecks[0].conclusionClaimId = 'A1'; },
    (c: ReviewSemanticComparison) => { c.edgeChecks[0].basisClaimId = 'A2'; },
    (c: ReviewSemanticComparison) => { c.edgeChecks[0].premiseStatus = 'missing'; },
    (c: ReviewSemanticComparison) => { c.edgeChecks[0].verdict = 'unverifiable'; },
    (c: ReviewSemanticComparison) => { c.edgeChecks[0].referenceQuote = q1; },
  ]) {
    const c = structuredClone(rc); mutate(c);
    const edgeHeld = await evaluateReviewComparisonPacket(reasoning.packet, reasoning.dependencies, mock(reasoning.packet, { graph: rg, comparison: c }).model);
    assert.equal(edgeHeld.mastery[0].layers.reasoning.status, 'unassessed');
    assert.ok(edgeHeld.mastery[0].layers.reasoning.reasons.includes('edge_not_established'));
  }
  pass('显式关系须两端参考对齐及方向校验；反向、缺前提和两个孤立事实不能判完整链');

  const another: NoteItem = { ...f.note, id: 'k2', title: '资料乙' };
  const multipleDeps: ReviewComparisonDependencies = { ...f.dependencies, readNotes: async () => structuredClone([f.note, another]),
    searchNotes: async () => [{ noteId: 'k2', noteType: 'knowledge', title: '资料乙', snippet: another.content, score: 1 }] };
  const multipleInput: ReviewComparisonAnswer = { activityId: 'session1', questionText: f.packet.questionText,
    evidence: { messageId: 'answer1', answer: next, hintLevel: 0, targetKnowledgeNames: ['知识甲'], questionIntent: f.packet.questionIntent } };
  const multiplePacket = await buildReviewComparisonPacket(multipleInput, multipleDeps, { targetScopeNoteIds: ['k1'] });
  const multi = comparisonFor(multiplePacket); multi.alignments.push({ ...structuredClone(multi.alignments[1]), targetId: 'R2' });
  const agree = await evaluateReviewComparisonPacket(multiplePacket, multipleDeps, mock(multiplePacket, { comparison: multi }).model);
  assert.equal(agree.mastery[0].layers.judgment.observations.length, 1);
  another.content = '在条件B下，A不会导致D。';
  const divergentPacket = await buildReviewComparisonPacket(multipleInput, multipleDeps, { targetScopeNoteIds: ['k1'] });
  const divergent = comparisonFor(divergentPacket); const refA = structuredClone(divergent.alignments[1]);
  refA.targetId = 'R2'; refA.relation = 'contradiction'; refA.documentQuote = another.content;
  refA.relationBasis = { kind: 'incompatible_facts', personalQuote: next, documentQuote: another.content, explanation: '同范围结果相反' };
  divergent.alignments.push(refA);
  const disagree = await evaluateReviewComparisonPacket(divergentPacket, multipleDeps, mock(divergentPacket, { comparison: divergent }).model);
  assert.equal(disagree.mastery[0].status, 'held'); assert.deepEqual(disagree.mastery[0].reasons, ['reference_conflict']);
  pass('多份一致资料不重复计证据；配对结果相反时不信兼容声明、不选边评分');

  const duplicateSpan = graphFor(f.packet); duplicateSpan.claims.push({ ...duplicateSpan.claims[0], id: 'A2' });
  assert.throws(() => readReviewPerformanceGraph(duplicateSpan, f.packet), /duplicate_claim_span/);
  const missingEndpoint = structuredClone(rg); missingEndpoint.edges[0].target = 'A3';
  assert.throws(() => readReviewPerformanceGraph(missingEndpoint, reasoning.packet), /invalid_edge/);
  const shortEdge = structuredClone(rg); Object.assign(shortEdge.edges[0], span(q1, reasoning.packet.answer.text));
  assert.throws(() => readReviewPerformanceGraph(shortEdge, reasoning.packet), /ungrounded_edge/);
  pass('临时表达图拒绝重复区间、虚构端点和未覆盖两端的边引文');

  const changedAtCompare = await fixture();
  const afterCompare = await evaluateReviewComparisonPacket(changedAtCompare.packet, changedAtCompare.dependencies,
    mock(changedAtCompare.packet, { onCompare: () => { changedAtCompare.note.content += '来源变更'; } }).model);
  assert.deepEqual(afterCompare.reasons, ['note_snapshot_changed']); assert.equal(afterCompare.growth.proposals.length, 0);
  const changedAtExtract = await fixture();
  const em = mock(changedAtExtract.packet, { onExtract: () => { changedAtExtract.file.records[0].revisions[0].branches[0].graph.nodes[0].text += '认知变更'; } });
  const beforeCompare = await evaluateReviewComparisonPacket(changedAtExtract.packet, changedAtExtract.dependencies, em.model);
  assert.ok(beforeCompare.reasons.includes('personal_snapshot_changed')); assert.equal(em.calls.compare, 0);
  const changedPacket = structuredClone(f.packet); changedPacket.answer.text += '被篡改'; const pm = mock(changedPacket);
  assert.equal((await evaluateReviewComparisonPacket(changedPacket, f.dependencies, pm.model)).reasons[0], 'packet_changed');
  assert.deepEqual(pm.calls, { extract: 0, compare: 0 });
  pass('调用前、两阶段之间、输出前回读版本；模型处理中变更导致提议和证据一并失效');

  const unavailable = await evaluateReviewComparisonPacket(f.packet, f.dependencies, { extract: async () => { throw new Error('PRIVATE RAW TEXT'); }, compare: async () => assert.fail('No retry') });
  assert.deepEqual(unavailable.reasons, ['semantic_model_unavailable']); assert.equal(JSON.stringify(unavailable).includes('PRIVATE'), false);
  const aborted = new AbortController(); aborted.abort(); const am = mock(f.packet);
  assert.equal((await evaluateReviewComparisonPacket(f.packet, f.dependencies, am.model, { signal: aborted.signal })).reasons[0], 'semantic_aborted');
  assert.deepEqual(am.calls, { extract: 0, compare: 0 });
  let timeouts = 0;
  const timeout = await evaluateReviewComparisonPacket(f.packet, f.dependencies, { extract: () => { timeouts++; return new Promise(() => {}); }, compare: async () => assert.fail('No retry') }, { timeoutMs: 5 });
  assert.deepEqual(timeout.reasons, ['semantic_timeout']); assert.equal(timeouts, 1);
  pass('取消、超时和服务错误降级为代码；不重试、不保存错误原文或伪造空回答');

  const session = { packets: [f.packet, f.packet], summary: summarizeReviewComparison([f.packet, f.packet], 0) };
  const sm = mock(f.packet);
  const duplicates = await evaluateReviewComparisonSession(session, f.dependencies, sm.model, { maxAnswers: 12 });
  assert.ok(duplicates.every((r) => r.reasons.includes('duplicate_semantic_answer'))); assert.equal(sm.calls.extract, 0);
  const zero = await evaluateReviewComparisonSession({ packets: [f.packet], summary: summarizeReviewComparison([f.packet], 0) }, f.dependencies, sm.model, { maxAnswers: 0 });
  assert.deepEqual(zero[0].reasons, ['semantic_answer_budget_exceeded']); assert.equal(sm.calls.extract, 0);
  const laterPacket = await buildReviewComparisonPacket({ ...multipleInput, evidence: { ...multipleInput.evidence, messageId: 'answer2' } }, f.dependencies, { targetScopeNoteIds: ['k1'] });
  const laterMock = mock(laterPacket);
  const bounded = await evaluateReviewComparisonSession({ packets: [f.packet, laterPacket], summary: summarizeReviewComparison([f.packet, laterPacket], 0) }, f.dependencies, laterMock.model, { maxAnswers: 1 });
  assert.deepEqual(bounded[0].reasons, ['semantic_answer_budget_exceeded']); assert.equal(bounded[1].status, 'reviewed');
  assert.deepEqual(laterMock.calls, { extract: 1, compare: 1 });
  pass('会话重复回答、零预算不调用模型，评估不产生任何持久化写入');

  const dirtyTarget = await fixture(); dirtyTarget.file.records[0].revisions[0].branches[0].reviewNeededNodeIds = ['n1'];
  const dt = await buildReviewComparisonPacket({ activityId: 'session1', questionText: dirtyTarget.packet.questionText,
    evidence: { messageId: 'answer1', answer: next, hintLevel: 0, targetKnowledgeNames: ['知识甲'], questionIntent: dirtyTarget.packet.questionIntent } }, dirtyTarget.dependencies, { targetScopeNoteIds: ['k1'] });
  const needsReview = await evaluateReviewComparisonPacket(dt, dirtyTarget.dependencies, mock(dt).model);
  assert.ok(needsReview.growth.reasons.includes('target_needs_review')); assert.equal(needsReview.mastery[0].layers.judgment.status, 'supported');
  pass('旧节点待复核阻止生长合并，但不阻断本轮回答独立核对参考');

  const direct = comparisonFor(f.packet).alignments[1];
  assert.equal(validateGroundedAlignment(direct, { claim: next, comparison: next }).accepted, true);
  assert.equal(validateGroundedAlignment({ ...direct, axes: null }, { claim: next, comparison: next }).code, 'invalid_axes');
  pass('双库语义层复用既有五轴准入逻辑，而非另造宽松评分标准');

  const outputExample = JSON.parse(REVIEW_DUAL_ALIGNMENT_EXAMPLE);
  assert.ok(REVIEW_DUAL_ALIGNMENT_PROMPT.includes(REVIEW_DUAL_ALIGNMENT_EXAMPLE));
  const ef = await fixture({ answer: outputExample.alignments[0].personalQuote, target: false });
  outputExample.packetId = ef.packet.packetId;
  outputExample.alignments[0].knowledgeTarget = '知识甲';
  const exampleResult = await evaluateReviewComparisonPacket(ef.packet, ef.dependencies,
    mock(ef.packet, { comparison: outputExample }).model);
  assert.equal(exampleResult.mastery[0].layers.judgment.status, 'supported');
  assert.equal(exampleResult.growth.status, 'held'); assert.equal(exampleResult.writes, 'disabled');
  const validResponse = JSON.stringify(outputExample);
  const malformedResponse = validResponse.replace('}}}],"edgeChecks"', '}}]}],"edgeChecks"');
  assert.notEqual(malformedResponse, validResponse);
  assert.throws(() => readReviewModelJson({ content: malformedResponse, diagnostics: { finishReason: 'stop' } }), /invalid_model_json/);
  pass('完整响应示例由JSON生成且通过真实门控；正常结束但闭合符号错误仍拒绝，不修补成证据');

  const absentPersonal = structuredClone(outputExample);
  absentPersonal.alignments.push({ ...absentPersonal.alignments[0], corpus: 'personal', targetId: 'none' });
  delete absentPersonal.alignments[1].knowledgeTarget;
  const placeholderResult = await evaluateReviewComparisonPacket(ef.packet, ef.dependencies,
    mock(ef.packet, { comparison: absentPersonal }).model);
  assert.deepEqual(placeholderResult.reasons, ['invalid_personal_target']);
  assert.equal(placeholderResult.growth.proposals.length, 0);
  assert.ok(placeholderResult.mastery.every((m) => m.status === 'held'));
  const borrowedAxis = comparisonFor(f.packet);
  borrowedAxis.alignments[0].axes.object.personalQuote = '报警';
  const axisResult = await evaluateReviewComparisonPacket(f.packet, f.dependencies,
    mock(f.packet, { comparison: borrowedAxis }).model);
  assert.equal(axisResult.growth.status, 'held'); assert.equal(axisResult.growth.proposals.length, 0);
  assert.ok(axisResult.alignments.some((a) => a.corpus === 'personal' && a.code === 'ungrounded_axis'));
  assert.equal(axisResult.mastery[0].layers.judgment.status, 'supported');
  pass('未请求渠道不接受none占位节点；另一侧词语不能充当旧节点轴引用，个人拒绝不冒充补充');

  for (const response of [
    { content: '', parsedJson: graphFor(f.packet) },
    { content: '```json\n{}\n```' },
    { content: '{}', diagnostics: { finishReason: 'length' } },
    { content: '{}', diagnostics: { finishReason: 'max_tokens' } },
  ]) assert.throws(() => readReviewModelJson(response), /invalid_model_json/);
  assert.deepEqual(readReviewModelJson({ content: '{"version":1}', parsedJson: { version: 999 } }), { version: 1 });
  const windowBefore = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const storageBefore = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const ipc: Array<Record<string, unknown>> = [];
  try {
    // Settings hydration now maintains a renderer cache. Permit that cache only in memory;
    // real settings persistence and all vault/profile writes remain forbidden.
    const settingsCache = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => settingsCache.get(key) ?? null,
      setItem: (key: string, value: string) => { assert.equal(key, 'loginote_llm_settings'); settingsCache.set(key, value); } } });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: {
      llm: { request: async (request: Record<string, unknown>) => {
        ipc.push(request);
        return { content: JSON.stringify(ipc.length === 1 ? graphFor(f.packet) : comparisonFor(f.packet)) };
      } }, userState: { loadLearningEpisodes: () => assert.fail('No private memory injection'),
        saveLlm: () => assert.fail('No settings persistence'),
        mutateCognition: () => assert.fail('No belief writes') },
    } } });
    const actualAdapter = await evaluateReviewComparisonPacket(f.packet, f.dependencies, createReviewSemanticModel());
    assert.equal(actualAdapter.status, 'reviewed', JSON.stringify(actualAdapter.reasons)); assert.equal(ipc.length, 2);
    assert.deepEqual(ipc.map((r) => r.maxTokens), [4096, 8192]);
    assert.ok(ipc.every((r) => r.outputSchema && r.thinkingMode === 'disabled'));
    assert.equal(JSON.parse(ipc[0].userInput as string).personal, undefined);
    assert.equal(JSON.parse(ipc[1].userInput as string).packet.personal.graph.nodes[0].text, old);
  } finally {
    if (windowBefore) Object.defineProperty(globalThis, 'window', windowBefore); else delete (globalThis as any).window;
    if (storageBefore) Object.defineProperty(globalThis, 'localStorage', storageBefore); else delete (globalThis as any).localStorage;
  }
  pass('真实调用适配器经IPC替身验证：两阶段JSON、关闭思考、无记忆注入与外部请求');
  console.log(`\n${checks} review semantic checks passed (synthetic/mock only, no cloud or store writes).`);
} finally { globalThis.fetch = fetchBefore; }
