import assert from 'node:assert/strict';
import type { CognitionFile, CognitionGraph } from '../src/services/cognition/types.ts';
import type { NoteItem } from '../src/types.ts';
import type { ReviewComparisonPacket } from '../src/services/reviewComparison/types.ts';
import { buildReviewComparisonPacket, reviewSnapshotHash } from '../src/services/reviewComparison/packet.ts';
import { readReviewPerformanceGraph } from '../src/services/reviewComparison/performanceGraph.ts';
import { buildReviewPersonalDisclosure, verifyReviewPersonalDisclosureFreshness } from '../src/services/reviewComparison/personalDisclosure.ts';

// In-memory synthetic saved-authority fixtures only; no model, browser, filesystem or actual user data.
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('No network allowed in personal disclosure checks');
const at = '2026-10-08T00:00:00.000Z';
const sourceGraph: CognitionGraph = { title: 'PRIVATE_BRANCH_TITLE_NOT_ON_WIRE', nodes: [
  { id: 'target', text: 'A在条件B下可能导致C。', mainType: '推理', stance: 'tentative' },
  { id: 'premise', text: '在条件B下，观察到A。', mainType: '事实陈述' },
  { id: 'antecedent', text: '必须先满足条件B。', mainType: '假设' },
  { id: 'consequence', text: 'C可能进一步导致D。', mainType: '推理' },
  { id: 'other-premise', text: '出现C时还需要条件E。', mainType: '事实陈述' },
  { id: 'sibling', text: 'OMITTED_SIBLING_TEXT', mainType: '推理' },
  { id: 'far', text: 'OMITTED_FAR_TEXT', mainType: '事实陈述' },
  { id: 'isolated', text: 'OTHER_COMPONENT_PRIVATE_TEXT', mainType: '定义' },
], edges: [
  { id: 'p-target', source: 'premise', target: 'target', relation: 'support' },
  { id: 'a-p', source: 'antecedent', target: 'premise', relation: 'support' },
  { id: 't-c', source: 'target', target: 'consequence', relation: 'support' },
  { id: 'x-c', source: 'other-premise', target: 'consequence', relation: 'oppose' },
  { id: 'p-sibling', source: 'premise', target: 'sibling', relation: 'support' },
  { id: 'sibling-far', source: 'sibling', target: 'far', relation: 'oppose' },
] };
let checks = 0;
const pass = (label: string) => { checks++; console.log(`PASS ${label}`); };
async function rehash(packet: ReviewComparisonPacket) {
  const { packetId: _id, snapshotHash: _hash, ...body } = packet;
  const snapshotHash = await reviewSnapshotHash(body);
  return { ...body, snapshotHash, packetId: `review-comparison:${snapshotHash}` };
}
async function fixture(graph = sourceGraph, answer = '观察到了新的例子。所以我认为A在条件B下可能导致C。') {
  let file: CognitionFile = { schemaVersion: 1, revision: 1, records: [{ id: 'record1', docId: 'record1', revisions: [{
    id: 'revision1', number: 1, at, operation: 'initial', reason: '', authorship: 'own_expression', source: { kind: 'argument_editor', docId: 'record1' },
    factSupport: 'not_assessed', mastery: 'not_assessed', branches: [{ id: 'primary', kind: 'primary',
      context: '在条件B的适用范围内讨论。🧠', stance: 'endorsed', graph: structuredClone(graph), reviewNeededNodeIds: ['target'] }],
  }] }] };
  const note: NoteItem = { id: 'reference-note', title: 'SECRET_REFERENCE_TOPIC', content: 'SECRET_REFERENCE_BODY_NEVER_ON_PERSONAL_WIRE',
    noteType: 'knowledge', createdAt: at, updatedAt: at, tags: [], links: [], backlinks: [], dueDates: [] };
  let reads = 0;
  const personal = { loadCognition: async () => { reads++; return structuredClone(file); } };
  const packet = await buildReviewComparisonPacket({ activityId: 'activity1', questionText: 'SECRET_QUESTION_BODY，请给出这个旧观点的一个新例子。',
    evidence: { messageId: 'answer1', answer, hintLevel: 0, targetKnowledgeNames: [note.title], consultedMaterialIds: [],
      questionIntent: { version: 1, questionMessageId: 'question1', knowledgeTargets: [note.title], cognitionTarget: {
        recordId: 'record1', revisionId: 'revision1', branchId: 'primary', nodeId: 'target', purpose: 'give_example' } } } },
  { readNotes: async () => [structuredClone(note)], ...personal, searchNotes: async () => [], searchDocuments: async () => [],
    previewDocument: async () => assert.fail('No document reads in this fixture') }, { targetScopeNoteIds: [note.id] });
  const rawGraph = { version: 1, packetId: packet.packetId, claims: [{ id: 'A1', role: 'example', quote: answer }], edges: [], requirements: [] };
  const performance = readReviewPerformanceGraph(rawGraph, packet);
  reads = 0;
  return { packet, performance, personal, file: () => file, setFile: (value: CognitionFile) => { file = structuredClone(value); }, reads: () => reads };
}

try {
  const f = await fixture(), before = JSON.stringify({ packet: f.packet, graph: f.performance, file: f.file() });
  const built = await buildReviewPersonalDisclosure(f.packet, f.performance, f.personal);
  assert.equal(built.status, 'ready'); if (built.status !== 'ready') throw new Error('Expected ready disclosure');
  assert.deepEqual(built.input.personal.nodes.map(node => node.nodeId), ['target', 'premise', 'consequence', 'antecedent', 'other-premise']);
  assert.deepEqual(built.input.personal.edges, sourceGraph.edges.slice(0, 4));
  assert.equal(built.input.personal.closure.omittedNodeCount, 2); assert.equal(built.input.personal.closure.omittedEdgeCount, 2);
  assert.equal(f.reads(), 2); assert.equal(JSON.stringify({ packet: f.packet, graph: f.performance, file: f.file() }), before);
  pass('冻结目标＋全部入向祖先＋直接出向结论的入向祖先，无参考读取、无写入');

  const wire = JSON.stringify(built.input);
  for (const secret of ['SECRET_REFERENCE', 'SECRET_QUESTION', 'PRIVATE_BRANCH_TITLE', 'OMITTED_SIBLING_TEXT', 'OMITTED_FAR_TEXT',
    'OTHER_COMPONENT_PRIVATE_TEXT', 'knowledgeTargets', 'references', 'snapshotHash', 'branchHash', 'requirements']) assert.ok(!wire.includes(secret), secret);
  assert.equal(built.input.legacy_relation_scope, 'structural_closure_only');
  assert.equal(built.authority.legacy_relation_scope, 'structural_closure_only');
  assert.equal(built.input.safeguards.stage, 'pending_proposal_only'); assert.equal(built.input.safeguards.writes, 'disabled');
  assert.equal(built.input.safeguards.necessaryConditionCompleteness, 'not_certified'); assert.equal(built.input.safeguards.purposeCreatesRelation, false);
  assert.equal(built.input.safeguards.newNodesOrRelations, 'not_generated');
  pass('物理隔离个人wire，明确只读待建议、旧结构闭包而非必要条件/事实认证');

  assert.equal(built.input.personal.nodes.find(node => node.nodeId === 'target')!.stance, 'tentative');
  assert.equal(built.input.personal.nodes.find(node => node.nodeId === 'target')!.reviewNeeded, true);
  assert.equal(built.input.personal.nodes.find(node => node.nodeId === 'premise')!.stance, 'endorsed');
  assert.equal(built.input.personal.edges.find(edge => edge.id === 'x-c')!.relation, 'oppose');
  assert.equal(built.input.personal.edges.find(edge => edge.id === 'x-c')!.source, 'other-premise');
  assert.equal(built.input.personal.edges.find(edge => edge.id === 'x-c')!.target, 'consequence');
  pass('旧方向/support-oppose/暂定/待复核原样保留，不升级认同和真实性');

  const u = built.input.sources.find(source => source.sourceId === 'U')!;
  assert.equal(built.input.graph.claims[0].quoteId, u.bodyQuoteId);
  assert.equal(built.input.quotes.filter(q => q.sourceId === 'U' && q.start === 0 && q.end === f.packet.answer.text.length).length, 1);
  const sources = new Map(built.input.sources.map(source => [source.sourceId, built.input.quotes.find(q => q.quoteId === source.bodyQuoteId)!.text]));
  assert.ok(built.input.quotes.every(q => sources.get(q.sourceId)!.slice(q.start, q.end) === q.text));
  pass('同source同UTF16区间复用一条Q，所有引用精确来自绑定正文');

  const changedReferences = structuredClone(f.packet); changedReferences.references[0].text = 'OTHER_REFERENCE_SECRET';
  changedReferences.questionText = 'OTHER_QUESTION_SECRET'; changedReferences.references[0].contentHash = 'a'.repeat(64);
  const otherPacket = await rehash(changedReferences), otherGraph = { ...f.performance, packetId: otherPacket.packetId };
  const other = await buildReviewPersonalDisclosure(otherPacket, otherGraph, f.personal);
  assert.equal(other.status, 'ready'); if (other.status !== 'ready') throw new Error('Expected isolated ready');
  assert.deepEqual(other.input, built.input); assert.notEqual(other.authority.snapshotHash, built.authority.snapshotHash);
  pass('其他通道/问题正文变化不进入个人public input或binding，私有packet审计仍区分');

  const purposePacket = structuredClone(f.packet); purposePacket.questionIntent.cognitionTarget!.purpose = 'give_evidence';
  const purposeRehash = await rehash(purposePacket), purposeBuilt = await buildReviewPersonalDisclosure(purposeRehash,
    { ...f.performance, packetId: purposeRehash.packetId }, f.personal);
  assert.equal(purposeBuilt.status, 'ready'); if (purposeBuilt.status !== 'ready') throw new Error('Expected ready purpose');
  assert.deepEqual(purposeBuilt.input.personal.edges, built.input.personal.edges); assert.deepEqual(purposeBuilt.input.graph.edges, []);
  pass('提问目的只是元数据，不能自动产生支持/证据连线');

  assert.deepEqual(await verifyReviewPersonalDisclosureFreshness(f.packet, f.performance, built.authority, f.personal), { fresh: true, reasons: [] });
  const tamperedAuthority = structuredClone(built.authority); tamperedAuthority.disclosedNodeIds.push('sibling');
  assert.deepEqual(await verifyReviewPersonalDisclosureFreshness(f.packet, f.performance, tamperedAuthority, f.personal), { fresh: false, reasons: ['authority_changed'] });
  pass('后续复核只重建相同冻结范围，私有authority不接受改节点名单');

  const changedPacket = structuredClone(f.packet); changedPacket.personal.graph!.nodes[0].text = '篡改旧目标';
  assert.deepEqual(await buildReviewPersonalDisclosure(changedPacket, f.performance, f.personal), { status: 'held', reasonCode: 'packet_changed' });
  const forged = await rehash(changedPacket);
  assert.deepEqual(await buildReviewPersonalDisclosure(forged, { ...f.performance, packetId: forged.packetId }, f.personal), { status: 'held', reasonCode: 'personal_snapshot_changed' });
  pass('改正文或自重签packet哈希都不能冒充当前冻结个人原文');

  const changedCurrent = structuredClone(f.file()); changedCurrent.records[0].revisions[0].branches[0].graph.nodes[0].text = '用户实际修改了原节点';
  f.setFile(changedCurrent);
  assert.deepEqual(await verifyReviewPersonalDisclosureFreshness(f.packet, f.performance, built.authority, f.personal), { fresh: false, reasons: ['personal_snapshot_changed'] });
  pass('同revisionID的实际目标改动也撤回读取，不靠ID未变误接旧表述');

  const fresh = await fixture(), stale = structuredClone(fresh.file());
  stale.records[0].revisions.push({ ...structuredClone(stale.records[0].revisions[0]), id: 'revision2', number: 2 }); fresh.setFile(stale);
  assert.deepEqual(await buildReviewPersonalDisclosure(fresh.packet, fresh.performance, fresh.personal), { status: 'held', reasonCode: 'stale_target' });
  pass('新增认知revision不能在答后换成新目标，原题保持stale held');

  const missing = await fixture(), missingFile = structuredClone(missing.file()); missingFile.records = []; missing.setFile(missingFile);
  assert.deepEqual(await buildReviewPersonalDisclosure(missing.packet, missing.performance, missing.personal), { status: 'held', reasonCode: 'target_missing' });
  const unavailable = await fixture();
  assert.deepEqual(await buildReviewPersonalDisclosure(unavailable.packet, unavailable.performance,
    { loadCognition: async () => { throw new Error('private I/O detail must not leak'); } }), { status: 'held', reasonCode: 'personal_unavailable' });
  pass('遗失或不可读个人权威不被当作空库/可写，错误详情不泄漏');

  const held = await fixture(), incomplete = await rehash({ ...structuredClone(held.packet), personal: { ...held.packet.personal, truncated: true } });
  assert.deepEqual(await buildReviewPersonalDisclosure(incomplete, { ...held.performance, packetId: incomplete.packetId }, held.personal), { status: 'held', reasonCode: 'incomplete_personal_context' });
  const stalePacket = await rehash({ ...structuredClone(held.packet), personal: { ...held.packet.personal, status: 'stale_target' } });
  assert.deepEqual(await buildReviewPersonalDisclosure(stalePacket, { ...held.performance, packetId: stalePacket.packetId }, held.personal), { status: 'held', reasonCode: 'stale_target' });
  pass('已有packet截断/陈旧标记不能因只取小窗口而升级可用');

  const heldGrowth = await rehash({ ...structuredClone(held.packet), preparation: { ...held.packet.preparation, cognitionGrowth: 'held' } });
  assert.deepEqual(await buildReviewPersonalDisclosure(heldGrowth, { ...held.performance, packetId: heldGrowth.packetId }, held.personal),
    { status: 'held', reasonCode: 'personal_growth_held' });
  const multiple = structuredClone(held.packet); multiple.questionIntent.cognitionTarget!.purpose = 'connect_nodes';
  const multiplePacket = await rehash(multiple);
  assert.deepEqual(await buildReviewPersonalDisclosure(multiplePacket, { ...held.performance, packetId: multiplePacket.packetId }, held.personal),
    { status: 'held', reasonCode: 'personal_growth_held' });
  pass('旧growth held或需要双目标的目的不因精简成单目标而升级ready');

  const changedEdge = await fixture(), changedEdgeReady = await buildReviewPersonalDisclosure(changedEdge.packet, changedEdge.performance, changedEdge.personal);
  assert.equal(changedEdgeReady.status, 'ready'); if (changedEdgeReady.status !== 'ready') throw new Error('Expected ready edge baseline');
  const edgeFile = structuredClone(changedEdge.file()); edgeFile.records[0].revisions[0].branches[0].graph.edges.splice(0, 1); changedEdge.setFile(edgeFile);
  assert.deepEqual(await verifyReviewPersonalDisclosureFreshness(changedEdge.packet, changedEdge.performance, changedEdgeReady.authority, changedEdge.personal),
    { fresh: false, reasons: ['personal_snapshot_changed'] });
  pass('必要旧连线被删除也撤回authority，不用新闭包假装原冻结逻辑仍在');

  const missingEndpoint = await fixture(), broken = structuredClone(missingEndpoint.packet);
  broken.personal.graph!.edges.push({ id: 'missing-node-edge', source: 'absent', target: 'target', relation: 'support' });
  const brokenPacket = await rehash(broken);
  assert.deepEqual(await buildReviewPersonalDisclosure(brokenPacket, { ...missingEndpoint.performance, packetId: brokenPacket.packetId }, missingEndpoint.personal),
    { status: 'held', reasonCode: 'missing_stored_endpoint' });
  pass('缺必要已有节点不丢边、不截前缀，明确held');

  const budgets = await fixture();
  for (const budget of [{ nodes: 4 }, { edges: 3 }, { quotes: 2 }, { sourceCharacters: 10 }, { inputCharacters: 100 }]) {
    assert.deepEqual(await buildReviewPersonalDisclosure(budgets.packet, budgets.performance, budgets.personal, budget), { status: 'held', reasonCode: 'disclosure_budget_exceeded' });
  }
  assert.deepEqual(await buildReviewPersonalDisclosure(budgets.packet, budgets.performance, budgets.personal, { nodes: 25 }), { status: 'held', reasonCode: 'invalid_disclosure_budget' });
  pass('节点/边/Q/字符/总装配预算超限均held，不能提预算或截断闭包');

  const graphBad = await fixture(), badClaim = structuredClone(graphBad.performance); badClaim.claims[0].quote = '不在用户原文中';
  assert.deepEqual(await buildReviewPersonalDisclosure(graphBad.packet, badClaim, graphBad.personal), { status: 'held', reasonCode: 'invalid_performance_graph' });
  const noGraph = { ...graphBad.performance, claims: [] };
  assert.deepEqual(await buildReviewPersonalDisclosure(graphBad.packet, noGraph, graphBad.personal), { status: 'held', reasonCode: 'invalid_performance_graph' });
  pass('一次抽取图仍重验用户引文，不能把模型补写内容当用户认知');

  const sameTextGraph = structuredClone(sourceGraph); sameTextGraph.nodes.find(node => node.id === 'premise')!.text = sameTextGraph.nodes[0].text;
  const same = await fixture(sameTextGraph, 'A在条件B下可能导致C。A在条件B下可能导致C。');
  const repeatedQuote = sameTextGraph.nodes[0].text;
  const repeatedGraph = readReviewPerformanceGraph({ version: 1, packetId: same.packet.packetId,
    claims: [{ id: 'A1', role: 'fact', quote: repeatedQuote, start: 0, end: repeatedQuote.length },
      { id: 'A2', role: 'fact', quote: repeatedQuote, start: repeatedQuote.length, end: repeatedQuote.length * 2 }], edges: [], requirements: [] }, same.packet);
  const repeated = await buildReviewPersonalDisclosure(same.packet, repeatedGraph, same.personal);
  assert.equal(repeated.status, 'ready'); if (repeated.status !== 'ready') throw new Error('Expected repeated ready');
  const occurrences = repeated.input.quotes.filter(q => q.text === repeatedQuote);
  assert.equal(occurrences.length, 4); assert.equal(new Set(occurrences.map(q => q.quoteId)).size, 4);
  assert.equal(new Set(occurrences.map(q => JSON.stringify([q.sourceId, q.start, q.end]))).size, 4);
  pass('同词跨个人节点/用户来源及重复位置保持不同Q，不合并掉坐标意义');

  const cycleGraph = structuredClone(sourceGraph); cycleGraph.edges.push({ id: 'cycle', source: 'target', target: 'antecedent', relation: 'support' });
  const cycles = await fixture(cycleGraph), cyclic = await buildReviewPersonalDisclosure(cycles.packet, cycles.performance, cycles.personal);
  assert.equal(cyclic.status, 'ready'); if (cyclic.status !== 'ready') throw new Error('Expected cycle read');
  assert.ok(cyclic.input.personal.edges.some(edge => edge.id === 'cycle')); assert.equal(cyclic.input.safeguards.storedRelationTruth, 'not_certified');
  pass('旧循环关系只读保留，闭包终止且不宣称循环推理有效');

  const race = await fixture(), racedCurrent = structuredClone(race.file()); let reads = 0;
  assert.deepEqual(await buildReviewPersonalDisclosure(race.packet, race.performance, { loadCognition: async () => {
    if (++reads === 2) racedCurrent.records[0].revisions[0].branches[0].context += '实际发生改变'; return structuredClone(racedCurrent);
  } }), { status: 'held', reasonCode: 'personal_snapshot_changed' });
  pass('装配期间观察到权威改变时hold，不返回开始读时旧基线');

  const delayed = await fixture(), pending = buildReviewPersonalDisclosure(delayed.packet, delayed.performance, delayed.personal);
  delayed.packet.personal.graph!.nodes[0].text = '调用者异步修改'; delayed.performance.claims[0].quote = '调用者异步修改';
  const frozen = await pending;
  assert.equal(frozen.status, 'ready'); if (frozen.status !== 'ready') throw new Error('Expected early cloned input');
  assert.ok(!JSON.stringify(frozen.input).includes('调用者异步修改'));
  pass('第一次await前捕获caller packet和graph，不被异步调用方篡改');
  console.log(`Personal disclosure checks passed: ${checks} synthetic groups; 0 model calls, reference reads or writes.`);
} finally { globalThis.fetch = originalFetch; }
