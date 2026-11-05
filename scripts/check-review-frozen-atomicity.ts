import assert from 'node:assert/strict';
import { assertFrozenInferenceAtomicity } from '../src/services/reviewComparison/frozenInferenceAtomicity.ts';
import { readReviewPerformanceGraph } from '../src/services/reviewComparison/performanceGraph.ts';
import { freezeReviewAssessment } from '../src/services/reviewAssessment.ts';
import type { ReviewComparisonPacket } from '../src/services/reviewComparison/types.ts';
import type { ReviewPerformanceGraph } from '../src/services/reviewComparison/semanticTypes.ts';

const previousFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('Frozen atomicity checks forbid network');
let checks = 0;
const pass = (label: string) => { checks++; console.log(`PASS ${label}`); };
function packet(text: string): ReviewComparisonPacket {
  const knowledgeTargets = ['纯合成原话边界'];
  return { version: 1, packetId: 'synthetic-frozen-atomicity-v1', snapshotHash: 'synthetic',
    activityId: 'synthetic-only', messageId: 'synthetic-answer', questionText: '说明你的推断方向。',
    questionIntent: { version: 1, questionMessageId: 'synthetic-question', knowledgeTargets,
      assessment: freezeReviewAssessment('reasoning', knowledgeTargets) },
    answer: { text, hintLevel: 0, consultedMaterialIds: [] },
    personal: { status: 'not_requested', truncated: false }, references: [],
    coverage: { referencePresence: 'insufficient_reference', semanticCoverage: 'not_assessed', missingTargetNames: knowledgeTargets },
    preparation: { cognitionGrowth: 'held', mastery: 'held', growthReasons: [], masteryReasons: [], warnings: [] } };
}
type Claim = Pick<ReviewPerformanceGraph['claims'][number], 'id' | 'role' | 'quote'> & { start?: number; end?: number };
type Edge = Pick<ReviewPerformanceGraph['edges'][number], 'id' | 'source' | 'target' | 'relation' | 'quote'>;
function grounded(text: string, claims: Claim[], edges: Edge[] = []) {
  const p = packet(text);
  return readReviewPerformanceGraph({ version: 1, packetId: p.packetId, claims, edges, requirements: [] }, p);
}
function rejectsWithoutMutation(graph: ReviewPerformanceGraph, code = 'non_atomic_inference_endpoint') {
  const before = structuredClone(graph);
  assert.throws(() => assertFrozenInferenceAtomicity(graph), { message: code });
  assert.deepEqual(graph, before);
}

try {
  // Hand-authored synthetic protocol witnesses, not simulated model accuracy.
  const forwardText = '本次指示灯亮，所以本次闸门打开。';
  const forward = grounded(forwardText, [
    { id: 'A1', role: 'fact', quote: '本次指示灯亮' },
    { id: 'A2', role: 'conclusion', quote: '本次闸门打开' },
  ], [{ id: 'E1', source: 'A1', target: 'A2', relation: 'support', quote: forwardText }]);
  const beforeForward = structuredClone(forward);
  assertFrozenInferenceAtomicity(forward);
  assert.deepEqual(forward, beforeForward);
  pass('正向边原话端点不相交；纯断言不改图、不认证推理');

  const reverseText = '本次闸门打开，因此我推断本次指示灯亮。';
  const reverse = grounded(reverseText, [
    { id: 'A1', role: 'fact', quote: '本次闸门打开' },
    { id: 'A2', role: 'conclusion', quote: '本次指示灯亮' },
  ], [{ id: 'E1', source: 'A1', target: 'A2', relation: 'support', quote: reverseText }]);
  assertFrozenInferenceAtomicity(reverse);
  assert.deepEqual(reverse.edges.map(edge => `${edge.source}:${edge.target}`), ['A1:A2']);
  pass('逆向表达可通过位置检查，既不纠正方向也不宣称有效');

  // Matches the observed nested VR02 SHAPE but is authored here, not a replay
  // modification of a saved response, a fixture/gold change, or a cloud call.
  const nestedText = '本次包裹带有蓝印，系统也已经联网。我把实验约定倒过来作为推断：因为本次包裹会进入二号通道，所以可推出它带有蓝印。';
  const nested = grounded(nestedText, [
    { id: 'A1', role: 'fact', quote: '本次包裹带有蓝印，系统也已经联网。' },
    { id: 'A2', role: 'premise', quote: '我把实验约定倒过来作为推断：因为本次包裹会进入二号通道，所以可推出它带有蓝印。' },
    { id: 'A3', role: 'fact', quote: '因为本次包裹会进入二号通道，所以可推出它带有蓝印。' },
    { id: 'A4', role: 'conclusion', quote: '所以可推出它带有蓝印。' },
  ], [{ id: 'E1', source: 'A3', target: 'A4', relation: 'support',
    quote: '因为本次包裹会进入二号通道，所以可推出它带有蓝印。' }]);
  assert.equal(nested.claims[2].start, 31); assert.equal(nested.claims[2].end, 56);
  assert.equal(nested.claims[3].start, 45); assert.equal(nested.claims[3].end, 56);
  rejectsWithoutMutation(nested);
  pass('共享reader仍接受嵌套VR02形状；只有显式新断言拒绝包含另一端点的整段关系');

  const partialOverlap = grounded('甲乙丙丁', [
    { id: 'A1', role: 'fact', quote: '甲乙丙' },
    { id: 'A2', role: 'conclusion', quote: '乙丙丁' },
  ], [{ id: 'E1', source: 'A1', target: 'A2', relation: 'support', quote: '甲乙丙丁' }]);
  rejectsWithoutMutation(partialOverlap);
  const invertedOverlap = structuredClone(partialOverlap);
  invertedOverlap.edges[0].source = 'A2'; invertedOverlap.edges[0].target = 'A1';
  rejectsWithoutMutation(invertedOverlap);
  pass('部分相交也拒绝，检查对区间方向对称但不改用户有向边');

  const adjacent = grounded('甲乙', [
    { id: 'A1', role: 'fact', quote: '甲' },
    { id: 'A2', role: 'conclusion', quote: '乙' },
  ], [{ id: 'E1', source: 'A1', target: 'A2', relation: 'support', quote: '甲乙' }]);
  assert.equal(adjacent.claims[0].end, adjacent.claims[1].start);
  assertFrozenInferenceAtomicity(adjacent);
  pass('UTF-16半开区间相接不等于重叠；没有词法/因果判断');

  const emoji = grounded('🙂甲乙', [
    { id: 'A1', role: 'fact', quote: '🙂甲' },
    { id: 'A2', role: 'conclusion', quote: '乙' },
  ], [{ id: 'E1', source: 'A1', target: 'A2', relation: 'support', quote: '🙂甲乙' }]);
  assert.deepEqual(emoji.claims.map(claim => [claim.start, claim.end]), [[0, 3], [3, 4]]);
  assertFrozenInferenceAtomicity(emoji);
  pass('emoji使用已回核UTF-16坐标，不按码点重算');

  const conjunctiveText = '本次已供电且读数超限，所以本次会报警。';
  const conjunctive = grounded(conjunctiveText, [
    { id: 'A1', role: 'fact', quote: '本次已供电且读数超限' },
    { id: 'A2', role: 'conclusion', quote: '本次会报警' },
  ], [{ id: 'E1', source: 'A1', target: 'A2', relation: 'support', quote: conjunctiveText }]);
  assertFrozenInferenceAtomicity(conjunctive);
  assert.equal(conjunctive.claims.length, 2);
  assert.equal(conjunctive.claims[0].quote, '本次已供电且读数超限');
  pass('复合AND事实原样允许，不拆关键词、不限制一事实匹配多个参考前提');

  const legalOverlap = grounded('本次已供电且读数超限，所以本次会报警。', [
    { id: 'A1', role: 'fact', quote: '本次已供电且读数超限' },
    { id: 'A2', role: 'condition', quote: '本次已供电' },
    { id: 'A3', role: 'conclusion', quote: '本次会报警' },
  ], [{ id: 'E1', source: 'A1', target: 'A3', relation: 'support', quote: conjunctiveText },
    { id: 'E2', source: 'A2', target: 'A3', relation: 'support', quote: conjunctiveText }]);
  assert.ok(legalOverlap.claims[0].start <= legalOverlap.claims[1].start
    && legalOverlap.claims[0].end >= legalOverlap.claims[1].end);
  assertFrozenInferenceAtomicity(legalOverlap);
  pass('不同边的复合事实与条件可以嵌套，禁止的仅是同一边两端相交');

  const chainText = '本次开关接通，因此本次灯亮；本次灯亮，所以本次闸门打开。';
  const firstIntermediateStart = chainText.indexOf('本次灯亮');
  const chain = grounded(chainText, [
    { id: 'A1', role: 'fact', quote: '本次开关接通' },
    { id: 'A2', role: 'conclusion', quote: '本次灯亮', start: firstIntermediateStart, end: firstIntermediateStart + '本次灯亮'.length },
    { id: 'A3', role: 'conclusion', quote: '本次闸门打开' },
  ], [{ id: 'E1', source: 'A1', target: 'A2', relation: 'support', quote: '本次开关接通，因此本次灯亮；' },
    { id: 'E2', source: 'A2', target: 'A3', relation: 'support', quote: '本次灯亮；本次灯亮，所以本次闸门打开。' }]);
  assertFrozenInferenceAtomicity(chain);
  assert.deepEqual(chain.edges.map(edge => `${edge.source}:${edge.target}`), ['A1:A2', 'A2:A3']);
  pass('A→B→C中上一结论可复用为下一前提，不禁跨边复用、不重建旧证明义务');

  const newInferenceText = '此前我已经确认本次灯亮，所以本次闸门打开。';
  const newInference = grounded(newInferenceText, [
    { id: 'A1', role: 'conclusion', quote: '本次灯亮' },
    { id: 'A2', role: 'conclusion', quote: '本次闸门打开' },
  ], [{ id: 'E1', source: 'A1', target: 'A2', relation: 'support', quote: newInferenceText }]);
  assertFrozenInferenceAtomicity(newInference);
  assert.equal(newInference.claims.length, 2); assert.equal(newInference.edges.length, 1);
  pass('本轮只表达B→C也允许，位置断言不要求重述A→B的旧证明');

  const parallel = grounded('本次已供电且读数超限。', [
    { id: 'A1', role: 'fact', quote: '本次已供电且读数超限' },
    { id: 'A2', role: 'condition', quote: '本次已供电' },
  ]);
  assertFrozenInferenceAtomicity(parallel);
  assert.deepEqual(parallel.edges, []);
  pass('无边时允许命题重叠，不从词语或位置补边');

  const selectionText = '本次读数超限，所以本次会报警。这个因果说明支持其中的报警。';
  const withUnselectedNestedEdge = grounded(selectionText, [
    { id: 'A1', role: 'fact', quote: '本次读数超限' },
    { id: 'A2', role: 'conclusion', quote: '本次会报警' },
    { id: 'A3', role: 'premise', quote: '这个因果说明支持其中的报警' },
    { id: 'A4', role: 'conclusion', quote: '其中的报警' },
  ], [{ id: 'E1', source: 'A1', target: 'A2', relation: 'support', quote: '本次读数超限，所以本次会报警。' },
    { id: 'E2', source: 'A3', target: 'A4', relation: 'support', quote: '这个因果说明支持其中的报警。' }]);
  rejectsWithoutMutation(withUnselectedNestedEdge);
  const selectedOnly = { claims: withUnselectedNestedEdge.claims,
    edges: withUnselectedNestedEdge.edges.filter(edge => edge.id === 'E1') };
  const beforeSelected = structuredClone(withUnselectedNestedEdge);
  assertFrozenInferenceAtomicity(selectedOnly);
  assert.equal(selectedOnly.claims.length, 4);
  assert.deepEqual(withUnselectedNestedEdge, beforeSelected);
  pass('调用者可只传本项已选边并保留全部claims，旁侧未选嵌套边不污染位置检查');

  // Simulates only the caller's required fail-closed classification. Actual
  // opt-in shadow wiring is checked separately; no semantic grade is produced.
  let classification: { status: 'reviewed' | 'held'; reason?: string; scoreWrite: 'disabled'; cognitionWrite: 'disabled' }
    = { status: 'reviewed', scoreWrite: 'disabled', cognitionWrite: 'disabled' };
  try { assertFrozenInferenceAtomicity(nested); }
  catch (error) { classification = { status: 'held', reason: (error as Error).message,
    scoreWrite: 'disabled', cognitionWrite: 'disabled' }; }
  assert.deepEqual(classification, { status: 'held', reason: 'non_atomic_inference_endpoint',
    scoreWrite: 'disabled', cognitionWrite: 'disabled' });
  assert.equal(Object.hasOwn(classification, 'score'), false);
  pass('结构失败只能暂缓该比较，不产生回答错误/零分/认知否定');

  const missingEndpoint = structuredClone(forward);
  missingEndpoint.edges[0].target = 'A12';
  rejectsWithoutMutation(missingEndpoint, 'invalid_frozen_inference_endpoint');
  pass('独立调用时不静默略过不存在的端点');

  console.log(`PASS ${checks} groups; source-grounded handwritten witnesses only; 0 cloud, 0 real data, 0 score/cognition writes`);
} finally {
  globalThis.fetch = previousFetch;
}
