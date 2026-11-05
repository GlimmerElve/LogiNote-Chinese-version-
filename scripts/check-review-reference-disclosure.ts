import assert from 'node:assert/strict';
import { buildArgumentReferenceDisclosure, createArgumentReferenceDisclosureReader,
  ARGUMENT_REFERENCE_DISCLOSURE_LIMIT, type ArgumentReferenceDisclosureContext } from '../src/services/argumentContext/referenceDisclosure.ts';
import type { FrozenArgumentQuestionFrames } from '../src/services/argumentContext/questionBindingTypes.ts';
import { createReferenceDisclosureFixture, rehashReferenceDisclosureFixture } from './reference-disclosure-fixture.ts';

// Fully offline protocol/projection checks. Fixed synthetic reviewers do not
// certify semantic accuracy. No provider, real vault, index, score or cognition writes.
const originalFetch = globalThis.fetch;
let networkCalls = 0, checks = 0;
globalThis.fetch = async () => { networkCalls++; return assert.fail('Network forbidden in reference disclosure checks'); };
const pass = (label: string) => { checks++; console.log(`PASS ${label}`); };
async function disclose(value: FrozenArgumentQuestionFrames): Promise<ArgumentReferenceDisclosureContext> {
  const reply = await buildArgumentReferenceDisclosure(value);
  assert.equal(reply.status, 'ready', JSON.stringify(reply));
  if (reply.status !== 'ready') throw new Error('expected_ready_disclosure');
  return reply.context;
}
async function rejectChange(original: FrozenArgumentQuestionFrames, change: (value: FrozenArgumentQuestionFrames) => void, reason?: string) {
  const changed = structuredClone(original); change(changed); await rehashReferenceDisclosureFixture(changed);
  const reply = await buildArgumentReferenceDisclosure(changed); assert.equal(reply.status, 'held');
  if (reply.status !== 'held') throw new Error('expected_held_disclosure');
  if (reason) assert.ok(reply.reasons.includes(reason), JSON.stringify(reply));
}
const readReady = (reader: ReturnType<typeof createArgumentReferenceDisclosureReader>, frameIds: string[]) => {
  const reply = reader.readFrames(frameIds); assert.equal(reply.status, 'ready', JSON.stringify(reply));
  if (reply.status !== 'ready') throw new Error('expected_ready_frame_read'); return reply.context;
};

try {
  const fixture = await createReferenceDisclosureFixture(), original = JSON.stringify(fixture.frozen);
  const context = await disclose(fixture.frozen), frame = context.frames[0];
  assert.equal(context.protocol, 'review-frozen-reference-context-v1');
  assert.equal(context.coverage, 'complete_required'); assert.equal(context.policy, 'all_target_frames');
  assert.equal(context.taskType, 'definition'); assert.deepEqual(context.assessment, fixture.frozen.assessment);
  assert.deepEqual(frame.nodes.map(node => node.id), ['N1', 'N2']);
  assert.deepEqual(frame.relations.map(edge => edge.id), ['E1']);
  assert.deepEqual(frame.relations[0], { id: 'E1', sourceNodeId: 'N2', targetNodeId: 'N1', kind: 'requires_condition', quoteIds: [frame.items[1].quoteId] });
  assert.deepEqual(frame.items.map(item => item.criterionId), ['concept_meaning', 'concept_boundary']);
  assert.deepEqual(frame.items[1].relationIds, ['E1']); assert.deepEqual(frame.groups, []);
  pass('真实原题frame投影保留定义＋必要条件N1/N2/E1，不把只读ready当回答正确');

  const serialized = JSON.stringify(context);
  for (const absent of ['canonicalText', 'hierarchy', 'authority', 'proof', 'rootScopeId', 'sourceScopeHash', 'sourceBindingHash',
    'parserVersion', 'selectorHash', 'selectorsHash', 'N3', 'N4', 'E2', fixture.paragraphs[2], fixture.paragraphs[3]]) assert.ok(!serialized.includes(absent), absent);
  assert.deepEqual(Object.keys(frame.source).sort(), ['kind', 'entityId', 'version', 'contentHash', 'coordinateSpace', 'structureHash'].sort());
  assert.deepEqual(context.limitations, { semanticTruth: 'not_certified', writes: 'disabled' });
  assert.equal(JSON.stringify(fixture.frozen), original); assert.equal((await fixture.service.verify(fixture.frozen)).status, 'current');
  pass('只披露既定闭包和source精简身份，不泄全文/句容器/私有scope/proof/路径，也不修改原合同');

  assert.equal(context.quotes.length, 2);
  for (const quote of context.quotes) {
    assert.equal(fixture.notes[0].content.slice(quote.start, quote.end), quote.text);
    assert.equal(quote.end - quote.start, quote.text.length); assert.match(quote.sourceKey, /^[a-f0-9]{64}$/u);
  }
  assert.ok(context.quotes[0].text.includes('🧠')); assert.equal(context.quotes[1].start, fixture.paragraphs[0].length + 4);
  assert.equal(frame.items[0].quoteId, frame.nodes[0].quoteIds[0]);
  assert.equal(frame.items[1].quoteId, frame.nodes[1].quoteIds[0]);
  assert.equal(frame.items[1].quoteId, frame.relations[0].quoteIds[0]);
  pass('CRLF/emoji保存UTF16位置真实回核，I/N/E同一次精确原文只保留一条quote');

  const twoNotes = await createReferenceDisclosureFixture({ noteCount: 2 }), two = await disclose(twoNotes.frozen);
  assert.equal(two.frames.length, 2); assert.equal(two.quotes.length, 4);
  assert.equal(two.quotes[0].text, two.quotes[2].text); assert.notEqual(two.quotes[0].sourceKey, two.quotes[2].sourceKey);
  assert.notEqual(two.frames[0].source.entityId, two.frames[1].source.entityId);
  pass('同字同偏移但不同来源不合并quote，节点同名仍按frame隔离');

  const aliases = await createReferenceDisclosureFixture({ aliasTargets: true }), aliasContext = await disclose(aliases.frozen);
  assert.equal(aliasContext.frames.length, 2); assert.equal(aliasContext.quotes.length, 2);
  assert.equal(aliasContext.frames[0].items[0].quoteId, aliasContext.frames[1].items[0].quoteId);
  assert.equal(aliasContext.frames[0].items[1].quoteId, aliasContext.frames[1].items[1].quoteId);
  pass('同一已存source＋structure＋精确位置的两个题前alias框架可去重，不重加证据');

  const occurrences = await createReferenceDisclosureFixture({ repeatedOccurrences: true }), repeated = await disclose(occurrences.frozen);
  assert.equal(repeated.quotes.length, 2); assert.equal(repeated.quotes[0].text, repeated.quotes[1].text);
  assert.notEqual(repeated.quotes[0].start, repeated.quotes[1].start); assert.notEqual(repeated.quotes[0].quoteId, repeated.quotes[1].quoteId);
  pass('同一来源重复出现的同字原文按位置保留，不能用另一出现位置代证');

  const reasoning = await createReferenceDisclosureFixture({ task: 'reasoning' }), reasoningContext = await disclose(reasoning.frozen);
  assert.equal(reasoningContext.taskType, 'reasoning');
  assert.deepEqual(reasoningContext.frames[0].nodes.map(node => node.id), ['N1', 'N2', 'N3']);
  assert.deepEqual(reasoningContext.frames[0].relations.map(edge => edge.id), ['E1', 'E2']);
  assert.deepEqual(reasoningContext.frames[0].groups, [{ id: 'G1', conclusionNodeId: 'N2', premiseNodeIds: ['N1'], conditionNodeIds: ['N3'], relationIds: ['E1', 'E2'], operator: 'all' }]);
  pass('推理必要组保留operator、实际前提、条件、结论和所有成员边，不只回结论');

  const held = structuredClone(fixture.frozen); held.status = 'held'; held.reasons = ['projection_unavailable'];
  assert.equal((await buildArgumentReferenceDisclosure(held)).status, 'held');
  const tamperedHash = structuredClone(fixture.frozen); tamperedHash.contractHash = '0'.repeat(64);
  assert.equal((await buildArgumentReferenceDisclosure(tamperedHash)).status, 'held');
  await rejectChange(fixture.frozen, value => { value.referenceRubric.status = 'unavailable'; });
  await rejectChange(fixture.frozen, value => { value.assessment.status = 'unavailable'; });
  pass('原held、坏contractHash和无固定任务/参考不披露，更不事后补新标准');

  for (const change of [
    (value: FrozenArgumentQuestionFrames) => { value.frames[0].pack.nodes.pop(); },
    (value: FrozenArgumentQuestionFrames) => { value.frames[0].pack.relations = []; },
    (value: FrozenArgumentQuestionFrames) => { value.frames[0].pack.completeness.requiredNodeIds.push('missing-node'); },
    (value: FrozenArgumentQuestionFrames) => { value.frames[0].pack.completeness.requiredRelationIds.push('missing-edge'); },
    (value: FrozenArgumentQuestionFrames) => { value.frames[0].pack.completeness.omittedNodeIds.push('N2'); },
    (value: FrozenArgumentQuestionFrames) => { value.frames[0].pack.completeness.gaps.push({ code: 'node_budget', targetId: 'N2' }); },
    (value: FrozenArgumentQuestionFrames) => { value.frames[0].pack.completeness.status = 'partial'; },
    (value: FrozenArgumentQuestionFrames) => { value.frames[0].pack.quality.status = 'unassessed'; },
  ]) await rejectChange(fixture.frozen, change, 'required_structure_incomplete');
  pass('漏必需节点/边、omitted、预算gap、partial或未准入都held，不截短伪完整');

  for (const change of [
    (value: FrozenArgumentQuestionFrames) => { value.frames[0].pack.nodes[0].admission = 'audit_only'; },
    (value: FrozenArgumentQuestionFrames) => { value.frames[0].pack.nodes[0].semanticStatus = 'unreviewed'; },
    (value: FrozenArgumentQuestionFrames) => { value.frames[0].pack.nodes[0].evidence = []; },
    (value: FrozenArgumentQuestionFrames) => { value.frames[0].pack.relations[0].admission = 'audit_only'; },
    (value: FrozenArgumentQuestionFrames) => { value.frames[0].pack.relations[0].sourceNodeId = 'outside-node'; },
    (value: FrozenArgumentQuestionFrames) => { value.frames[0].pack.relations[0].evidence = []; },
  ]) await rejectChange(fixture.frozen, change, 'required_structure_incomplete');
  pass('未审核/未准入/无引文节点边及越闭包端点不得成为评价输入');

  for (const change of [
    (value: FrozenArgumentQuestionFrames) => { value.frames[0].items[1].relationIds = []; },
    (value: FrozenArgumentQuestionFrames) => { value.frames[0].items[1].nodeIds = []; },
    (value: FrozenArgumentQuestionFrames) => { value.frames[0].items[0].quote += '额外文字'; },
    (value: FrozenArgumentQuestionFrames) => { value.frames[0].items[0].start++; },
    (value: FrozenArgumentQuestionFrames) => { value.frames[0].items[0].criterionId = 'example_fit'; },
    (value: FrozenArgumentQuestionFrames) => { value.frames[0].items[0].nodeIds.push('N4'); },
  ]) await rejectChange(fixture.frozen, change, 'required_structure_incomplete');
  pass('原I项与criterion/精确出现位置及N/E映射一致，不能换检验项或借不相关节点');

  for (const change of [
    (value: FrozenArgumentQuestionFrames) => { value.frames[0].pack.prerequisiteGroups[0].operator = 'unknown'; },
    (value: FrozenArgumentQuestionFrames) => { value.frames[0].pack.prerequisiteGroups[0].conditionNodeIds.push('missing-condition'); },
    (value: FrozenArgumentQuestionFrames) => { value.frames[0].pack.prerequisiteGroups[0].relationIds.push('missing-member-edge'); },
    (value: FrozenArgumentQuestionFrames) => { value.frames[0].pack.prerequisiteGroups[0].admission = 'audit_only'; },
  ]) await rejectChange(reasoning.frozen, change, 'required_structure_incomplete');
  pass('unknown/缺成员/缺关系/未准入必要组held，不拆组、不补猜all或条件');

  // A large but structurally retained synthetic projection: repeat existing required
  // condition edges under distinct fixture IDs, then cover every ID in the original I.
  // This is only a payload budget probe, not a semantic model accuracy fixture.
  const large = structuredClone(fixture.frozen), required = large.frames[0], condition = required.pack.relations[0];
  required.pack.relations = Array.from({ length: 600 }, (_, index) => ({ ...structuredClone(condition), id: `E${index + 1}` }));
  required.pack.completeness.requiredRelationIds = required.pack.relations.map(edge => edge.id);
  required.pack.completeness.readRelationIds = [...required.pack.completeness.requiredRelationIds];
  required.items[1].relationIds = [...required.pack.completeness.requiredRelationIds];
  await rehashReferenceDisclosureFixture(large);
  const overBudget = await buildArgumentReferenceDisclosure(large);
  assert.equal(overBudget.status, 'held'); if (overBudget.status !== 'held') throw new Error('expected_budget_held');
  assert.ok(overBudget.reasons.includes('context_budget_exceeded'));
  assert.ok(JSON.stringify(context).length <= ARGUMENT_REFERENCE_DISCLOSURE_LIMIT);
  pass('总payload硬上限32000 UTF16字符，超出整体held而非裁掉必要关系');

  const mutable = structuredClone(fixture.frozen), pending = buildArgumentReferenceDisclosure(mutable);
  mutable.frames[0].items[0].quote = 'caller changes after await'; mutable.frames[0].pack.nodes = [];
  const captured = await pending; assert.equal(captured.status, 'ready');
  if (captured.status !== 'ready') throw new Error('expected_captured_snapshot');
  assert.deepEqual(captured.context, context);
  captured.context.quotes[0].text = 'consumer mutable copy';
  assert.deepEqual(await disclose(fixture.frozen), context);
  pass('首次await前克隆原合同，返回DTO无共享可变引用，也不改原frame');

  const reader = createArgumentReferenceDisclosureReader(two), index = reader.index();
  assert.equal(index.frames.length, 2);
  assert.ok(!JSON.stringify(index).includes(fixture.paragraphs[0]));
  assert.ok(!JSON.stringify(index).includes('quoteId')); assert.ok(!Object.hasOwn(index, 'quotes'));
  index.frames[0].knowledgeTarget = 'caller mutable index';
  assert.notEqual(reader.index().frames[0].knowledgeTarget, 'caller mutable index');
  pass('index仅无引文路由元数据，不作为评分依据且不泄正文/节点证据');

  const subset = readReady(reader, ['target-2']);
  assert.equal(subset.coverage, 'frame_subset'); assert.deepEqual(subset.frames.map(item => item.frameId), ['target-2']);
  assert.equal(subset.quotes.length, 2);
  const usedQuotes = new Set(subset.frames.flatMap(item => [...item.items.map(entry => entry.quoteId),
    ...item.nodes.flatMap(entry => entry.quoteIds), ...item.relations.flatMap(entry => entry.quoteIds)]));
  assert.deepEqual([...usedQuotes].sort(), subset.quotes.map(item => item.quoteId).sort());
  assert.ok(subset.quotes.every(quote => quote.sourceKey === two.quotes[2].sourceKey));
  assert.equal(subset.policy, 'all_target_frames');
  pass('单frame补读只返回该冻结frame及所有必要quote，frame_subset明确不可假装整题完备');

  subset.quotes[0].text = 'consumer corrupts first read'; subset.frames[0].nodes = [];
  const all = readReady(reader, ['target-2', 'target-1']);
  assert.equal(all.coverage, 'complete_required'); assert.deepEqual(all.frames.map(item => item.frameId), ['target-1', 'target-2']);
  assert.deepEqual(all, two);
  assert.equal(reader.readFrames(['target-1']).status, 'held');
  const exhausted = reader.readFrames(['target-2']); assert.equal(exhausted.status, 'held');
  if (exhausted.status === 'held') assert.ok(exhausted.reasons.includes('disclosure_read_budget_exceeded'));
  pass('选全既有frames才complete_required，返回独立副本；两次有界补读后不再扩展');

  const invalidReader = createArgumentReferenceDisclosureReader(two);
  const sparse = Array(1), extra = Object.assign(['target-1'], { extra: undefined });
  const invalidSelections: unknown[] = [undefined, null, '', 'target-1', [], ['new-frame'], ['target-1', 'target-1'],
    ['target-1', 'target-2', 'target-3'], [1], [undefined], sparse, extra,
    { frameIds: ['target-1'] }, { frameIds: ['target-1'], extra: undefined }];
  for (const selection of invalidSelections) {
    const reply = invalidReader.readFrames(selection); assert.equal(reply.status, 'held', JSON.stringify(selection));
    if (reply.status === 'held') assert.ok(reply.reasons.includes('disclosure_out_of_scope'));
  }
  assert.equal(readReady(invalidReader, ['target-1']).coverage, 'frame_subset');
  assert.equal(readReady(invalidReader, ['target-1', 'target-2']).coverage, 'complete_required');
  pass('空/新ID/重复/extra/sparse/非数组请求均held，不耗合法读取次数或放宽冻结范围');

  const readerInput = structuredClone(context), copiedReader = createArgumentReferenceDisclosureReader(readerInput);
  readerInput.frames[0].nodes = []; readerInput.quotes[0].text = 'later caller mutation';
  for (let i = 0; i < 5; i++) copiedReader.index();
  assert.deepEqual(readReady(copiedReader, ['target-1']), context);
  assert.deepEqual(readReady(copiedReader, ['target-1']), context);
  assert.equal(copiedReader.readFrames(['target-1']).status, 'held');
  pass('reader构造捕获完整context，index不占补读额度，不因外部修改丢必要证据');

  const aliasedReader = createArgumentReferenceDisclosureReader(aliasContext), aliasSubset = readReady(aliasedReader, ['target-2']);
  assert.equal(aliasSubset.coverage, 'frame_subset'); assert.equal(aliasSubset.quotes.length, 2);
  assert.deepEqual(aliasSubset.frames[0], aliasContext.frames[1]);
  pass('共享quote的alias frame仍可独立有界披露，不因去重丢引用或越到别的frame');

  assert.equal(networkCalls, 0); assert.equal(JSON.stringify(fixture.frozen), original);
  console.log(`Review reference disclosure: ${checks} synthetic groups passed; fixed reviewer votes, 0 network/model/real-vault/index/score/cognition writes.`);
} finally { globalThis.fetch = originalFetch; }
