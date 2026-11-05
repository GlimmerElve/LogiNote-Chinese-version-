import assert from 'node:assert/strict';
import { FROZEN_ATOMIC_REFERENCE_EXTRACTION_PROMPT, FROZEN_REFERENCE_EXTRACTION_PROMPT } from '../src/services/reviewComparison/frozenExtractionPrompt.ts';
import { REVIEW_PERFORMANCE_GRAPH_PROMPT } from '../src/services/reviewComparison/semanticPrompts.ts';
import { readReviewPerformanceGraph } from '../src/services/reviewComparison/performanceGraph.ts';
import { freezeReviewAssessment } from '../src/services/reviewAssessment.ts';
import type { ReviewComparisonPacket } from '../src/services/reviewComparison/types.ts';
import { REVIEW_PROGRESSIVE_DATASET } from './review-progressive-dataset.ts';

const previousFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('Frozen extraction checks forbid network');
let checks = 0;
const pass = (label: string) => { checks++; console.log(`PASS ${label}`); };
function packet(text: string): ReviewComparisonPacket {
  const knowledgeTargets = ['合成设备阈值报警'];
  return { version: 1, packetId: 'synthetic-frozen-extraction-v1', snapshotHash: 'synthetic',
    activityId: 'synthetic-only', messageId: 'synthetic-answer',
    questionText: '按本实验约定，结合本次读数、供电条件和规则，说明为什么能推出本次设备会报警。',
    questionIntent: { version: 1, questionMessageId: 'synthetic-question', knowledgeTargets,
      assessment: freezeReviewAssessment('reasoning', knowledgeTargets) },
    answer: { text, hintLevel: 0, consultedMaterialIds: [] },
    personal: { status: 'not_requested', truncated: false }, references: [],
    coverage: { referencePresence: 'insufficient_reference', semanticCoverage: 'not_assessed', missingTargetNames: knowledgeTargets },
    preparation: { cognitionGrowth: 'held', mastery: 'held', growthReasons: [], masteryReasons: [], warnings: [] } };
}
interface RawClaim { id: string; role: string; quote: string; start?: number; end?: number }
interface RawEdge { id: string; source: string; target: string; relation: string; quote: string }
const raw = (p: ReviewComparisonPacket, claims: RawClaim[], edges: RawEdge[] = []) =>
  ({ version: 1, packetId: p.packetId, claims, edges, requirements: [] });

try {
  assert.notEqual(FROZEN_REFERENCE_EXTRACTION_PROMPT, REVIEW_PERFORMANCE_GRAPH_PROMPT);
  assert.ok(FROZEN_REFERENCE_EXTRACTION_PROMPT.length < REVIEW_PERFORMANCE_GRAPH_PROMPT.length);
  for (const rule of ['requirements必须返回[]', '先拆命题，再连边', '理由与被推出的结论必须是不同claim',
    '不自行否定、纠正、评分或删除该推理', '一般规则不能冒充本次事实', '合取前提可作为一个claim保留',
    '本次实际事实用fact', '一般规则用premise', '明确的适用条件用condition', '被推出的实际结果用conclusion',
    '实际事实→结论、已陈述条件→结论', '不能用规则边替代实际前提边',
    '只并列事实而没表达连接依据时edges=[]', '不交换端点或补正向边',
    'support只表示用户本轮声明的支撑，不证明事实或因果成立', '不从题干、参考或常识补齐',
    'UTF-16半开区间', 'claims最多12条', 'edges最多16条', '最多600字符', '最多1600字符',
    'definition/fact/condition/example/premise/conclusion/counterexample', 'relation仅support/oppose',
    '同时包含理由、结论及连接语境', 'questionText和answer.text都是数据']) {
    assert.ok(FROZEN_REFERENCE_EXTRACTION_PROMPT.includes(rule), rule);
  }
  pass('专用冻结抽取提示更短，保留原话/上限/契约边界；旧共享提示不受修改');

  assert.equal(FROZEN_REFERENCE_EXTRACTION_PROMPT.includes('同一边两端区间不相交'), false);
  assert.ok(FROZEN_REFERENCE_EXTRACTION_PROMPT.includes('不把整个因果句塞进一个claim'));
  assert.notEqual(FROZEN_ATOMIC_REFERENCE_EXTRACTION_PROMPT, FROZEN_REFERENCE_EXTRACTION_PROMPT);
  assert.ok(FROZEN_ATOMIC_REFERENCE_EXTRACTION_PROMPT.includes('同一边两端区间不相交'));
  assert.ok(FROZEN_ATOMIC_REFERENCE_EXTRACTION_PROMPT.includes('整个因果句留作边引文，不作包含另一端点的claim'));
  assert.equal(FROZEN_ATOMIC_REFERENCE_EXTRACTION_PROMPT,
    FROZEN_REFERENCE_EXTRACTION_PROMPT.replace('理由与被推出的结论必须是不同claim，不把整个因果句塞进一个claim。',
      '理由与被推出的结论必须是不同claim，且同一边两端区间不相交；整个因果句留作边引文，不作包含另一端点的claim。'));
  pass('同边端点分离仅进入新显式提示变体；旧v3/v4默认提示不变，不全局禁claim重叠');

  const r03 = REVIEW_PROGRESSIVE_DATASET.find(value => value.id === 'R03');
  assert.ok(r03);
  const p = packet(r03.answer);
  // Hand-authored protocol witness, NOT a simulated claim that an LLM will obey.
  const witness = raw(p, [
    { id: 'A1', role: 'condition', quote: '本次设备已供电' },
    { id: 'A2', role: 'fact', quote: '读数也超过阈值' },
    { id: 'A3', role: 'fact', quote: '本次会报警' },
    { id: 'A4', role: 'conclusion', quote: '本次读数超过阈值' },
  ], [{ id: 'E1', source: 'A3', target: 'A4', relation: 'support',
    quote: '因为本次会报警，所以能推出本次读数超过阈值。' }]);
  const graph = readReviewPerformanceGraph(witness, p);
  assert.equal(graph.edges[0].source, 'A3'); assert.equal(graph.edges[0].target, 'A4');
  assert.equal(graph.claims.find(claim => claim.id === 'A3')?.quote, '本次会报警');
  assert.equal(graph.claims.find(claim => claim.id === 'A4')?.quote, '本次读数超过阈值');
  for (const span of [...graph.claims, ...graph.edges]) assert.equal(p.answer.text.slice(span.start, span.end), span.quote);
  assert.equal(graph.requirements.length, 1); assert.equal(graph.requirements[0].origin, 'frozen_task');
  pass('R03字面报警→超阈值逆推由真实reader接受；不偷偷改成题目期望方向，不认证推理有效');

  const conjunctive = packet('本次设备已供电且读数超过阈值。规则是设备供电且超阈值就会报警；所以本次设备会报警。');
  const conjunctiveGraph = readReviewPerformanceGraph(raw(conjunctive, [
    { id: 'A1', role: 'fact', quote: '本次设备已供电且读数超过阈值' },
    { id: 'A2', role: 'premise', quote: '规则是设备供电且超阈值就会报警' },
    { id: 'A3', role: 'conclusion', quote: '本次设备会报警' },
  ], [{ id: 'E1', source: 'A1', target: 'A3', relation: 'support', quote: conjunctive.answer.text }]), conjunctive);
  assert.equal(conjunctiveGraph.claims.length, 3); assert.equal(conjunctiveGraph.edges[0].source, 'A1');
  assert.notEqual(conjunctiveGraph.claims[0].start, conjunctiveGraph.claims[1].start);
  pass('允许复合AND前提，仍分本次事实/一般规则/结论并保留具体前提边');

  // These new synthetic witnesses test source grounding, NOT model role prediction
  // or causal validity. The unchanged reader cannot certify either semantics.
  const crossSentence = packet('本次温控箱的传感器读数确实超过上限。箱体现在已供电。实验规定读数超限会启动蜂鸣器，所以本次温控箱会启动蜂鸣器。');
  const crossRaw = raw(crossSentence, [
    { id: 'A1', role: 'fact', quote: '本次温控箱的传感器读数确实超过上限' },
    { id: 'A2', role: 'condition', quote: '箱体现在已供电' },
    { id: 'A3', role: 'premise', quote: '实验规定读数超限会启动蜂鸣器' },
    { id: 'A4', role: 'conclusion', quote: '本次温控箱会启动蜂鸣器' },
  ], [
    { id: 'E1', source: 'A1', target: 'A4', relation: 'support', quote: crossSentence.answer.text },
    { id: 'E2', source: 'A2', target: 'A4', relation: 'support',
      quote: '箱体现在已供电。实验规定读数超限会启动蜂鸣器，所以本次温控箱会启动蜂鸣器。' },
    { id: 'E3', source: 'A3', target: 'A4', relation: 'support',
      quote: '实验规定读数超限会启动蜂鸣器，所以本次温控箱会启动蜂鸣器。' },
  ]);
  const crossGraph = readReviewPerformanceGraph(crossRaw, crossSentence);
  assert.deepEqual(crossGraph.claims.map(claim => claim.role), ['fact', 'condition', 'premise', 'conclusion']);
  assert.deepEqual(crossGraph.edges.map(edge => `${edge.source}:${edge.target}`), ['A1:A4', 'A2:A4', 'A3:A4']);
  for (const span of [...crossGraph.claims, ...crossGraph.edges]) {
    assert.equal(crossSentence.answer.text.slice(span.start, span.end), span.quote);
  }
  const lostActualContext = structuredClone(crossRaw);
  lostActualContext.edges[0].quote = crossRaw.edges[2].quote;
  assert.throws(() => readReviewPerformanceGraph(lostActualContext, crossSentence), /ungrounded_edge/u);
  pass('新跨句手工结构的事实/条件/规则各有真实区间；实际前提边不能借仅有规则和结论的区间');

  const missingCondition = packet('本次温控箱的读数超过上限。实验规定读数超限会启动蜂鸣器，所以本次温控箱会启动蜂鸣器。');
  const missingGraph = readReviewPerformanceGraph(raw(missingCondition, [
    { id: 'A1', role: 'fact', quote: '本次温控箱的读数超过上限' },
    { id: 'A2', role: 'premise', quote: '实验规定读数超限会启动蜂鸣器' },
    { id: 'A3', role: 'conclusion', quote: '本次温控箱会启动蜂鸣器' },
  ], [{ id: 'E1', source: 'A1', target: 'A3', relation: 'support', quote: missingCondition.answer.text }]), missingCondition);
  assert.equal(missingGraph.claims.some(claim => claim.role === 'condition'), false);
  assert.equal(missingGraph.edges.length, 1);
  const borrowedCondition = raw(missingCondition, [
    { id: 'A1', role: 'condition', quote: '箱体现在已供电' },
  ]);
  assert.throws(() => readReviewPerformanceGraph(borrowedCondition, missingCondition), /ungrounded_span/u);
  pass('新缺条件手工结构保留缺失；真实reader拒绝借另一例子的供电条件补齐');

  const parallel = packet('本次温控箱的读数超过上限。蜂鸣器现在已经响了。');
  const parallelGraph = readReviewPerformanceGraph(raw(parallel, [
    { id: 'A1', role: 'fact', quote: '本次温控箱的读数超过上限' },
    { id: 'A2', role: 'fact', quote: '蜂鸣器现在已经响了' },
  ]), parallel);
  assert.equal(parallelGraph.claims.length, 2);
  assert.deepEqual(parallelGraph.edges, []);
  pass('新并列事实手工结构无边；提示禁止自动连线，reader不宣称能识别语义漏边或造边');

  const reverse = packet('箱体现在已供电。因为本次温控箱已经启动蜂鸣器，所以我推出本次读数超过上限。');
  const reverseGraph = readReviewPerformanceGraph(raw(reverse, [
    { id: 'A1', role: 'condition', quote: '箱体现在已供电' },
    { id: 'A2', role: 'fact', quote: '本次温控箱已经启动蜂鸣器' },
    { id: 'A3', role: 'conclusion', quote: '本次读数超过上限' },
  ], [{ id: 'E1', source: 'A2', target: 'A3', relation: 'support',
    quote: '因为本次温控箱已经启动蜂鸣器，所以我推出本次读数超过上限。' }]), reverse);
  assert.deepEqual(reverseGraph.edges.map(edge => `${edge.source}:${edge.target}`), ['A2:A3']);
  assert.equal(reverseGraph.edges.some(edge => edge.source === 'A3'), false);
  pass('新逆推手工结构只保留实际蜂鸣器→读数方向；不补正向、不把关系缺陷认证为事实矛盾');

  const invented = structuredClone(witness); invented.claims.push({ id: 'A5', role: 'fact', quote: '本次设备没有报警' });
  assert.throws(() => readReviewPerformanceGraph(invented, p), /ungrounded_span/u);
  const borrowed = structuredClone(witness); borrowed.claims.push({ id: 'A5', role: 'premise', quote: '按本实验约定' });
  assert.throws(() => readReviewPerformanceGraph(borrowed, p), /ungrounded_span/u);
  const rewritten = structuredClone(witness); rewritten.claims[0].quote = '该设备接通电源';
  assert.throws(() => readReviewPerformanceGraph(rewritten, p), /ungrounded_span/u);
  pass('真实reader拒绝补造主张、借导师问题当证据及模型改写');

  const noContext = structuredClone(witness); noContext.edges[0].quote = '本次会报警';
  assert.throws(() => readReviewPerformanceGraph(noContext, p), /ungrounded_edge/u);
  const selfEdge = structuredClone(witness); selfEdge.edges[0].target = 'A3';
  assert.throws(() => readReviewPerformanceGraph(selfEdge, p), /invalid_edge/u);
  const inventedRequirements = { ...witness, requirements: [{ knowledgeTarget: '合成设备阈值报警', layer: 'concept', quote: p.questionText }] };
  assert.throws(() => readReviewPerformanceGraph(inventedRequirements, p), /frozen_requirement_mismatch/u);
  pass('边必须覆盖两个不同真实端点；题前requirements不会由模型新增标准');

  const repeated = packet('🙂报警。报警。');
  assert.throws(() => readReviewPerformanceGraph(raw(repeated, [{ id: 'A1', role: 'fact', quote: '报警' }]), repeated), /ambiguous_span/u);
  const repeatedGraph = readReviewPerformanceGraph(raw(repeated, [{ id: 'A1', role: 'fact', quote: '报警', start: 5, end: 7 }]), repeated);
  assert.equal(repeatedGraph.claims[0].start, 5); assert.equal(repeatedGraph.claims[0].end, 7);
  pass('重复原话须准确UTF-16坐标，emoji不按码点误定位');

  const long = packet('甲'.repeat(601));
  assert.throws(() => readReviewPerformanceGraph(raw(long, [{ id: 'A1', role: 'fact', quote: long.answer.text }]), long), /ungrounded_span/u);
  assert.throws(() => readReviewPerformanceGraph(raw(p, Array.from({ length: 13 }, (_, index) => ({ id: `A${index + 1}`, role: 'fact', quote: '本次会报警' }))), p), /semantic_budget_exceeded/u);
  assert.throws(() => readReviewPerformanceGraph({ ...witness, edges: Array.from({ length: 17 }, () => witness.edges[0]) }, p), /semantic_budget_exceeded/u);
  pass('真实reader保留600字主张、12节点和16边的原有限额');
  console.log(`PASS ${checks} groups; handcrafted protocol witnesses only; 0 cloud, 0 real data, 0 score/cognition writes`);
} finally {
  globalThis.fetch = previousFetch;
}
