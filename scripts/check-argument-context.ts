import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { argumentContextFixture, rebindArgumentFixture } from './argument-context-fixture';
import { argumentCanonicalTextHash, argumentContextHash, compareArgumentContextIds } from '../src/services/argumentContext/hash';
import { createArgumentContextPointer, readArgumentContextPack } from '../src/services/argumentContext/reader';
import { normalizeArgumentContextBudget, validateArgumentContextPack } from '../src/services/argumentContext/validator';
import { adaptLegacyKnowledgeArgumentContext, legacyArgumentSourceVersions } from '../src/services/argumentContext/legacy';
import { freezeArgumentSourceFrames, validateFrozenArgumentSourceFrames, type ArgumentSourceFramesInput } from '../src/services/argumentContext/frames';
import type { ArgumentContextBudget, ArgumentContextPack, ArgumentContextTask } from '../src/services/argumentContext/types';
import type { DocumentChunk, KnowledgeArgumentUnit, StructuredDocument } from '../src/types';
import type { KnowledgeShard } from '../src/electron/rag/knowledgeStore';

// No configured vault, persisted index, real user text, model, network or write adapter.
const fetchBefore = globalThis.fetch;
globalThis.fetch = async () => assert.fail('Network is forbidden in argument context checks');
let checks = 0;
const pass = (name: string) => { checks++; console.log(`PASS ${name}`); };
type Fixture = Awaited<ReturnType<typeof argumentContextFixture>>;
async function read(f: Fixture, budget?: Partial<ArgumentContextBudget>, task: ArgumentContextTask = 'reasoning') {
  const pointer = await createArgumentContextPointer(f.projection, f.authority, f.scope, ['result']);
  return readArgumentContextPack(f.projection, f.authority, { pointer, scope: f.scope, task, ...(budget ? { budget } : {}) });
}
async function mutated(mutate: (f: Fixture) => void) {
  const f = await argumentContextFixture(); mutate(f); return rebindArgumentFixture(f);
}
const ids = (rows: { id: string }[]) => rows.map((x) => x.id).sort();
const gaps = (pack: ArgumentContextPack) => pack.completeness.gaps.map((g) => g.code);
async function frameInput(fixture?: Fixture, policy: ArgumentSourceFramesInput['policy'] = 'any_allowed_frame') {
  const f = fixture || await argumentContextFixture();
  const pack = await read(f, undefined, 'fact');
  return { questionMessageId: 'question-test', scope: f.scope, task: 'fact' as const, policy,
    packs: [{ pack, authority: f.authority, projection: f.projection }],
    selections: [{ frameId: 'frame-A', packHash: pack.packHash, scopeEvidence: f.projection.hierarchy.sentences.slice(1, 9).map((_, i) => f.evidence(i + 1)),
      items: [{ itemId: 'item-A', criterionId: 'fact_scope' as const, nodeIds: ['result'], relationIds: [] }] }] };
}
async function legacyFixture() {
  const f = await argumentContextFixture('uploaded-document');
  const canonicalDocument: StructuredDocument = { schemaVersion: 1, docId: f.projection.source.entityId,
    normalizedText: f.authority.canonicalText,
    blocks: f.projection.hierarchy.blocks.map((b) => ({ id: b.id, textStart: b.start, textEnd: b.end, kind: b.kind,
      sectionPath: '合成设备实验', locator: b.locator! })) };
  const chunk: DocumentChunk = { id: 'chunk-test', docId: canonicalDocument.docId, fileName: 'synthetic.txt', index: 0,
    sectionPath: '合成设备实验', content: canonicalDocument.normalizedText, textStart: 0, textEnd: canonicalDocument.normalizedText.length,
    sentenceSpans: f.projection.hierarchy.sentences.map((s) => ({ id: `old-${s.id}`, textStart: s.start, textEnd: s.end })),
    sourceBlockIds: canonicalDocument.blocks.map((b) => b.id), embedding: [] };
  const unit = (id: string, nums: number[]): KnowledgeArgumentUnit => ({ id, docId: chunk.docId, chunkId: chunk.id,
    sentenceIds: nums.map((n) => `old-s${n}`), mainType: '推理', layer: 'logic',
    textStart: f.projection.hierarchy.sentences[nums[0]].start, textEnd: f.projection.hierarchy.sentences[nums.at(-1)!].end,
    text: nums.map((n) => f.lines[n].trim()).join('\n'), mentionedEntityIds: [], confidence: 0.95,
    origin: 'imported-document-extraction', admission: 'admitted' });
  const shard: KnowledgeShard = { schemaVersion: 1, docId: chunk.docId, generationId: f.projection.source.version, status: 'ready',
    extractorVersion: 3, knowledgePromptVersion: 2, committedChunkIds: [chunk.id], failedChunkIds: [],
    entityMentions: [], entityRelations: [], argumentUnits: [unit('old-premise', [1, 2]), unit('old-result', [5])],
    argumentEdges: [{ id: 'old-edge', docId: chunk.docId, chunkId: chunk.id, sourceArgumentId: 'old-premise', targetArgumentId: 'old-result',
      relation: 'support', evidenceSentenceIds: ['old-s1', 'old-s2', 'old-s5'], confidence: 0.95, admission: 'admitted' }],
    validationWarnings: [], createdAt: '2026-10-06T00:00:00.000Z' };
  return { f, input: { source: { ...f.projection.source, ...legacyArgumentSourceVersions(canonicalDocument, shard) }, canonicalDocument, chunks: [chunk], shard } };
}

try {
  const f = await argumentContextFixture();
  const pack = await read(f);
  assert.equal(pack.completeness.status, 'complete_for_scope');
  for (const id of ['result', 'p1', 'p2', 'rule', 'threshold', 'law']) assert.ok(ids(pack.nodes).includes(id), id);
  for (const id of ['e1', 'e2', 'e3', 'e4', 'e5']) assert.ok(ids(pack.relations).includes(id), id);
  assert.deepEqual(ids(pack.prerequisiteGroups), ['g-main', 'g-rule']);
  assert.equal(pack.prerequisiteGroups[0].operator, 'all');
  assert.equal(pack.limitations.semanticTruth, 'not_certified'); assert.equal(pack.limitations.writes, 'disabled');
  assert.equal(pack.limitations.questionCoverage, 'not_assessed');
  assert.ok(!ids(pack.nodes).includes('unrelated'));
  assert.ok(!JSON.stringify(pack).includes(f.lines[10]));
  assert.deepEqual(pack, await read(f));
  await validateArgumentContextPack(pack, f.authority, f.scope, f.projection);
  pass('多段多步的必要前提/条件/关系组完整读取，原方向保留，无关正文不输出，范围完整不等于真理或掌握');

  assert.equal(await argumentCanonicalTextHash(f.authority.canonicalText), createHash('sha256').update(f.authority.canonicalText).digest('hex'));
  assert.equal(await argumentContextHash({ z: 1, a: { y: 2, x: 3 } }), await argumentContextHash({ a: { x: 3, y: 2 }, z: 1 }));
  assert.notEqual(await argumentContextHash(['p1', 'p2']), await argumentContextHash(['p2', 'p1']));
  assert.deepEqual(['ä', 'a', 'z', '甲'].sort(compareArgumentContextIds), ['a', 'z', 'ä', '甲']);
  for (const row of [...pack.nodes, ...pack.relations]) for (const e of row.evidence) {
    assert.equal(f.authority.canonicalText.slice(e.start, e.end), e.quote);
  }
  pass('精确CRLF/UTF16原文哈希与区间，键顺序无关但数组顺序有别，不拼造句子');

  for (const budget of [{ maxNodes: 1 }, { maxRelations: 0 }, { maxCharacters: 0 }]) {
    const bounded = await read(f, budget);
    assert.notEqual(bounded.completeness.status, 'complete_for_scope');
    assert.ok(bounded.completeness.gaps.length);
    assert.ok(bounded.completeness.omittedNodeIds.length || bounded.completeness.omittedRelationIds.length || bounded.completeness.omittedGroupIds.length);
    assert.ok(bounded.relations.every((e) => ids(bounded.nodes).includes(e.sourceNodeId) && ids(bounded.nodes).includes(e.targetNodeId)));
    await validateArgumentContextPack(bounded, f.authority, f.scope, f.projection);
  }
  for (const budget of [{ maxNodes: -1 }, { maxDepth: 1.5 }, { maxCharacters: NaN }, { maxRelations: Infinity },
    { maxNodes: 129 }, { maxDepth: 17 }, { maxCharacters: 20001 }, { unknown: 1 }] as any[]) {
    assert.throws(() => normalizeArgumentContextBudget(budget));
  }
  assert.equal(normalizeArgumentContextBudget({ maxDepth: 0 }).maxDepth, 0);
  pass('节点/关系/字符预算均显式缺口与未读指针，不返回孤边；负数/小数/NaN/超上限/新增字段拒绝');

  const depth = await mutated((x) => { x.projection.build.scopes = []; });
  const depthPack = await read(depth, { maxDepth: 0 });
  assert.ok(gaps(depthPack).includes('depth_budget')); assert.notEqual(depthPack.completeness.status, 'complete_for_scope');
  assert.ok(depthPack.completeness.omittedNodeIds.includes('p1'));
  const declaredSeedOnly = await read(f, { maxDepth: 0 });
  assert.deepEqual(ids(declaredSeedOnly.nodes), ['result']); assert.ok(gaps(declaredSeedOnly).includes('depth_budget'));
  const declaredOneHop = await read(f, { maxDepth: 1 });
  assert.ok(!ids(declaredOneHop.nodes).includes('law')); assert.ok(declaredOneHop.completeness.omittedNodeIds.includes('law'));
  assert.notEqual(declaredOneHop.completeness.status, 'complete_for_scope');
  const isolated = await mutated((x) => { x.projection.relations = []; x.projection.prerequisiteGroups = []; x.projection.build.scopes = []; });
  const isolatedPack = await read(isolated);
  assert.deepEqual(ids(isolatedPack.nodes), ['result']); assert.equal(isolatedPack.relations.length, 0);
  assert.equal(isolatedPack.hierarchy.sentences.length, 1);
  pass('深度预算不因声明必要项而绕过，seed-only/一跳缺口明确；物理邻段/章节不会被当逻辑边');

  const missing = await mutated((x) => {
    x.projection.prerequisiteGroups[0].premiseNodeIds.push('known-missing-premise');
    x.projection.build.scopes[0].requiredNodeIds.push('known-missing-premise');
  });
  const missingPack = await read(missing);
  assert.notEqual(missingPack.completeness.status, 'complete_for_scope');
  assert.ok(missingPack.completeness.gaps.some((g) => g.targetId === 'known-missing-premise'));
  assert.ok(missingPack.completeness.omittedNodeIds.includes('known-missing-premise'));
  const ambiguous = await mutated((x) => { x.projection.prerequisiteGroups[0].operator = 'unknown'; });
  assert.notEqual((await read(ambiguous)).completeness.status, 'complete_for_scope');
  assert.ok(gaps(await read(ambiguous)).includes('unknown_prerequisite_operator'));
  const alternative = await mutated((x) => { x.projection.prerequisiteGroups[0].operator = 'any'; });
  assert.equal((await read(alternative)).prerequisiteGroups.find((g) => g.id === 'g-main')!.operator, 'any');
  pass('已知缺前提不猜补、未知联合/替代关系不冒称完整，any保留所有已声明备选而不替用户作答');

  const cycle = await mutated((x) => { x.projection.relations.push({ ...x.projection.relations[0], id: 'cycle', sourceNodeId: 'result', targetNodeId: 'p1' }); });
  const cyclePack = await read(cycle);
  assert.equal(cyclePack.relations.find((e) => e.id === 'cycle')!.sourceNodeId, 'result');
  assert.equal(cyclePack.relations.find((e) => e.id === 'e1')!.sourceNodeId, 'p1');
  assert.equal(new Set(ids(cyclePack.nodes)).size, cyclePack.nodes.length);
  const self = await mutated((x) => { x.projection.relations[0].targetNodeId = 'p1'; });
  await assert.rejects(read(self));
  const copied = await mutated((x) => {
    x.projection.nodes.push({ ...structuredClone(x.projection.nodes[0]), id: 'p1-copy' });
    x.projection.relations.push({ ...structuredClone(x.projection.relations[0]), id: 'copied-support', sourceNodeId: 'p1', targetNodeId: 'p1-copy' });
  });
  await assert.rejects(read(copied));
  const orphan = await mutated((x) => { x.projection.relations[0].sourceNodeId = 'foreign-node'; });
  await assert.rejects(read(orphan));
  pass('循环终止且所有实际边保持原方向；同ID/复制命题自支持及跨源不存在端点不会伪修复');

  for (const status of ['review_only', 'unassessed'] as const) {
    const x = await mutated((v) => { v.projection.quality.status = status; });
    assert.notEqual((await read(x)).completeness.status, 'complete_for_scope');
  }
  const notReviewed = await mutated((x) => { x.projection.nodes[0].semanticStatus = 'unreviewed'; });
  assert.notEqual((await read(notReviewed)).completeness.status, 'complete_for_scope');
  const unadmitted = await mutated((x) => { x.projection.nodes[0].admission = 'audit_only'; });
  const uPack = await read(unadmitted);
  assert.notEqual(uPack.completeness.status, 'complete_for_scope'); assert.ok(!ids(uPack.nodes).includes('p1'));
  assert.ok(gaps(uPack).includes('unadmitted_node'));
  const undeclared = await mutated((x) => { x.projection.build.scopes = []; });
  assert.equal((await read(undeclared)).completeness.status, 'unknown');
  const oldOrigin = await mutated((x) => { x.projection.build.origin = 'legacy-adapter'; x.projection.build.scopes = []; });
  assert.equal((await read(oldOrigin)).completeness.status, 'unknown');
  pass('来源质量、准入、语义审核、范围声明分别约束完整性，图全读及ready也不能替代未知审核');

  for (const modify of [
    (x: any) => { x.scope.allowedNoteIds = []; },
    (x: any) => { x.scope.rootScopeId = 'another-vault'; },
    (x: any) => { x.scope.corpus = 'personal'; },
    (x: any) => { x.scope.allowedSourceKinds = ['uploaded-document']; },
    (x: any) => { x.scope.allowedNoteIds.push('unrelated-permission-change'); },
    (x: any) => { x.pointer.scopeId = 'another-scope'; },
    (x: any) => { x.pointer.source.version = 'another-generation'; },
    (x: any) => { x.pointer.structureHash = '0'.repeat(64); },
    (x: any) => { x.pointer.seedNodeIds = ['foreign-node']; },
    (x: any) => { x.pointer.source.rootScopeId = 'C:\\Users\\private'; },
    (x: any) => { x.authority.canonicalText += 'changed'; },
    (x: any) => { x.projection.source.validatorVersion = 'new-validator'; },
  ]) {
    const x = { projection: structuredClone(f.projection), authority: structuredClone(f.authority),
      scope: structuredClone(f.scope), pointer: await createArgumentContextPointer(f.projection, f.authority, f.scope, ['result']) };
    modify(x);
    await assert.rejects(readArgumentContextPack(x.projection, x.authority, { pointer: x.pointer, scope: x.scope, task: 'reasoning' }));
  }
  const changed = structuredClone(f.projection); changed.nodes[0].role = 'fact';
  await assert.rejects(readArgumentContextPack(changed, f.authority, { pointer: await createArgumentContextPointer(f.projection, f.authority, f.scope, ['result']), scope: f.scope, task: 'reasoning' }));
  pass('指针不是授权：根/库/白名单/角色/版本/hash/内容/seed范围变化全部拒绝，源相同ID不复活旧版本');

  for (const modify of [
    (x: Fixture) => { x.projection.source.personal!.revisionId = 'another-revision'; },
    (x: Fixture) => { x.projection.source.personal!.recordId = 'another-record'; x.scope.allowedRecordIds.push('another-record'); },
  ]) {
    const x = await argumentContextFixture('personal-cognition'); modify(x); await rebindArgumentFixture(x); await assert.rejects(read(x));
  }
  const pDenied = await argumentContextFixture('personal-cognition'); pDenied.scope.allowedRecordIds = [];
  await assert.rejects(read(pDenied));
  pass('个人record/revision/branch与源快照独立绑定，不能换record借白名单或复活旧revision');

  const clauses = await mutated((x) => {
    const sentence = x.projection.hierarchy.sentences[9], split = sentence.start + sentence.quote.indexOf('因此');
    x.projection.nodes.push({ id: 'clause-premise', role: 'premise', evidence: [{ sentenceId: sentence.id, start: sentence.start, end: split, quote: sentence.quote.slice(0, split - sentence.start) }], admission: 'admitted', semanticStatus: 'reviewed' },
      { id: 'clause-result', role: 'conclusion', evidence: [{ sentenceId: sentence.id, start: split, end: sentence.end, quote: sentence.quote.slice(split - sentence.start) }], admission: 'admitted', semanticStatus: 'reviewed' });
    x.projection.relations.push({ id: 'clause-edge', sourceNodeId: 'clause-premise', targetNodeId: 'clause-result', kind: 'support',
      evidence: [x.evidence(9)], admission: 'admitted', semanticStatus: 'reviewed' });
  });
  const clausePointer = await createArgumentContextPointer(clauses.projection, clauses.authority, clauses.scope, ['clause-result']);
  const clausePack = await readArgumentContextPack(clauses.projection, clauses.authority, { pointer: clausePointer, scope: clauses.scope, task: 'reasoning' });
  assert.ok(ids(clausePack.nodes).includes('clause-premise')); assert.ok(ids(clausePack.relations).includes('clause-edge'));
  const splitSurrogate = { ...clauses, projection: structuredClone(clauses.projection), authority: structuredClone(clauses.authority), scope: structuredClone(clauses.scope) };
  const e = splitSurrogate.projection.nodes.at(-2)!.evidence[0];
  e.start++; e.quote = splitSurrogate.authority.canonicalText.slice(e.start, e.end);
  await rebindArgumentFixture(splitSurrogate); await assert.rejects(read(splitSurrogate));
  const forgedQuote = await mutated((x) => { x.projection.nodes[0].evidence[0].quote = '不存在的原话'; });
  await assert.rejects(read(forgedQuote));
  const wrongSentence = await mutated((x) => { x.projection.nodes[0].evidence[0].sentenceId = 's2'; });
  await assert.rejects(read(wrongSentence));
  pass('同句不同子句职责与真实关系可读取、合法引文复用不禁；伪造引文/借句坐标/拆emoji拒绝');

  for (const modify of [
    (x: Fixture) => { x.projection.source.parserVersion = 'C:/private/parser'; },
    (x: Fixture) => { x.projection.source.validatorVersion = ' bad-version '; },
    (x: Fixture) => { x.projection.source.segmentationVersion = 'bad\u0000version'; },
  ]) await assert.rejects(read(await mutated(modify)));
  pass('版本/身份元数据禁止本机路径、控制符及歧义空格，构建与重读闭集一致');

  for (const modify of [
    (x: any) => { x.projection.hierarchy.sections[0].parentId = 'section-test'; },
    (x: any) => { x.projection.hierarchy.blocks[0].nextId = 'b3'; },
    (x: any) => { x.projection.hierarchy.sentences[1].blockId = 'b2'; },
    (x: any) => { x.projection.nodes[0].score = 100; },
    (x: any) => { x.projection.nodes.push(structuredClone(x.projection.nodes[0])); },
    (x: any) => { x.projection.relations[0].direction = 'reversed'; },
    (x: any) => { x.projection.quality.provenTrue = true; },
    (x: any) => { x.projection.prerequisiteGroups[0].operator = 'guess'; },
  ]) await assert.rejects(read(await mutated(modify)));
  pass('文章层级循环/错误相邻/越block句子与闭合schema非法字段、重ID、猜关系全部拒绝');

  const mutable = await argumentContextFixture(), requestPointer = await createArgumentContextPointer(mutable.projection, mutable.authority, mutable.scope, ['result']);
  const pending = readArgumentContextPack(mutable.projection, mutable.authority, { pointer: requestPointer, scope: mutable.scope, task: 'reasoning' });
  mutable.projection.nodes[0].evidence[0].quote = 'await期间伪造'; mutable.scope.allowedNoteIds = [];
  assert.deepEqual(await pending, pack);
  const output = structuredClone(pack); output.nodes[0].role = 'hypothesis';
  assert.notEqual(output.nodes[0].role, f.projection.nodes.find((n) => n.id === output.nodes[0].id)!.role);
  pass('读取前快照克隆：await期间调用方修改不污染结果，结果不共享可变存图对象');

  for (const modify of [
    (x: any) => { x.quality.status = 'review_only'; },
    (x: any) => { x.nodes[0].role = 'fact'; },
    (x: any) => { x.completeness.gaps = []; x.completeness.omittedNodeIds = []; x.completeness.status = 'complete_for_scope'; },
    (x: any) => { x.budget.maxNodes = 1; },
    (x: any) => { x.limitations.writes = 'enabled'; },
    (x: any) => { x.nodes.push(structuredClone(f.projection.nodes.at(-1))); },
  ]) {
    const forged = structuredClone(pack); modify(forged); const { packHash: _oldHash, ...body } = forged;
    forged.packHash = await argumentContextHash(body);
    // Even recomputing a self hash must not replace authoritative membership/quality/completeness.
    if (JSON.stringify(forged) !== JSON.stringify(pack)) await assert.rejects(validateArgumentContextPack(forged, f.authority, f.scope, f.projection));
  }
  pass('结构包可重放权威存图验证：攻击者自重算hash仍不能改职责、质量、预算或补入无关事实');

  const legacy = await legacyFixture(), before = JSON.stringify(legacy.input);
  const adapted = await adaptLegacyKnowledgeArgumentContext(legacy.input);
  assert.equal(JSON.stringify(legacy.input), before);
  assert.equal(adapted.projection.build.origin, 'legacy-adapter'); assert.equal(adapted.projection.quality.status, 'unassessed');
  assert.equal(adapted.projection.prerequisiteGroups.length, 0); assert.equal(adapted.projection.build.scopes.length, 0);
  assert.ok(adapted.projection.nodes.every((n) => n.semanticStatus === 'unreviewed' && n.legacyFunctionType === '推理'));
  assert.ok(adapted.projection.relations.every((e) => e.semanticStatus === 'unreviewed'));
  assert.equal(adapted.projection.relations[0].sourceNodeId, 'old-premise');
  assert.equal(adapted.projection.relations[0].targetNodeId, 'old-result');
  for (const n of adapted.projection.nodes) for (const e of n.evidence) assert.equal(adapted.authority.canonicalText.slice(e.start, e.end), e.quote);
  const lp = await createArgumentContextPointer(adapted.projection, adapted.authority, legacy.f.scope, [adapted.projection.relations[0].targetNodeId]);
  const legacyPack = await readArgumentContextPack(adapted.projection, adapted.authority, { pointer: lp, scope: legacy.f.scope, task: 'reasoning' });
  assert.equal(legacyPack.completeness.status, 'unknown'); assert.ok(gaps(legacyPack).includes('legacy_structure'));
  assert.ok(legacyPack.relations.some((e) => e.kind === 'support'));
  await validateArgumentContextPack(legacyPack, adapted.authority, legacy.f.scope, adapted.projection);
  pass('旧ready graph纯内存适配保留support方向与真实原句，trim/join不造大引文，未审核/质量/必要组仍unknown');

  for (const modify of [
    (x: any) => { x.source.version = 'wrong-generation'; },
    (x: any) => { x.source.contentHash = '0'.repeat(64); },
    (x: any) => { x.source.kind = 'knowledge-note'; },
    (x: any) => { x.shard.extractorVersion++; },
    (x: any) => { x.shard.knowledgePromptVersion++; },
    (x: any) => { x.canonicalDocument.materialParserVersion = 2; },
  ]) { const x = structuredClone(legacy.input); modify(x); await assert.rejects(adaptLegacyKnowledgeArgumentContext(x)); }
  const badChunk = structuredClone(legacy.input); badChunk.chunks[0].content += 'forged';
  const rejectedChunk = await adaptLegacyKnowledgeArgumentContext(badChunk);
  assert.equal(rejectedChunk.projection.nodes.length, 0); assert.ok(rejectedChunk.projection.build.gaps.length);
  const broken = structuredClone(legacy.input); broken.shard.argumentEdges[0].evidenceSentenceIds = ['missing'];
  const badAdapter = await adaptLegacyKnowledgeArgumentContext(broken);
  assert.equal(badAdapter.projection.relations.length, 0); assert.ok(badAdapter.projection.build.gaps.some((g) => g.code === 'invalid_legacy_relation'));
  const partialLegacy = structuredClone(legacy.input); partialLegacy.shard.status = 'partial'; partialLegacy.shard.failedChunkIds = ['failed-test'];
  assert.ok((await adaptLegacyKnowledgeArgumentContext(partialLegacy)).projection.build.gaps.some((g) => g.code === 'incomplete_extraction'));
  pass('旧数据同代正文/root/来源约束不放宽，坏边不升级；partial与failed chunks显式不完整');

  const crossBlock = structuredClone(legacy.input), firstSentence = crossBlock.chunks[0].sentenceSpans![1];
  const secondSentence = crossBlock.chunks[0].sentenceSpans![2]; firstSentence.textEnd = secondSentence.textEnd;
  crossBlock.chunks[0].sentenceSpans!.splice(2, 1);
  crossBlock.shard.argumentUnits[0].sentenceIds = [firstSentence.id];
  crossBlock.shard.argumentUnits[0].text = crossBlock.canonicalDocument.normalizedText.slice(firstSentence.textStart, firstSentence.textEnd).trim();
  crossBlock.shard.argumentEdges[0].evidenceSentenceIds = [firstSentence.id, 'old-s5'];
  const split = await adaptLegacyKnowledgeArgumentContext(crossBlock);
  assert.equal(split.projection.nodes[0].evidence.length, 2);
  assert.ok(split.projection.nodes[0].evidence.every((e) => split.projection.hierarchy.sentences.find((s) => s.id === e.sentenceId)!.blockId
    === split.projection.hierarchy.blocks.find((b) => b.start <= e.start && b.end >= e.end)!.id));
  const wrongChunk = structuredClone(legacy.input); wrongChunk.shard.argumentEdges[0].chunkId = 'another-chunk';
  assert.equal((await adaptLegacyKnowledgeArgumentContext(wrongChunk)).projection.relations.length, 0);
  pass('旧跨block句子拆成精确源子区间；跨chunk借local句子/端点不会升级关系');

  const input = await frameInput(), fixed = await freezeArgumentSourceFrames(input);
  assert.equal(fixed.status, 'fixed'); assert.equal(fixed.policy, 'any_allowed_frame');
  assert.deepEqual(fixed.limitations, { answerEvaluation: 'not_performed', scoreWrite: 'disabled', cognitionWrite: 'disabled' });
  assert.equal(fixed.frames.length, 1); assert.equal(fixed.frames[0].source.kind, 'knowledge-note');
  await validateFrozenArgumentSourceFrames(fixed, input);
  assert.equal((await freezeArgumentSourceFrames({ ...input, policy: 'all_selected_frames' })).policy, 'all_selected_frames');
  const invalidated = structuredClone(input); invalidated.questionMessageId = 'question-after-answer';
  await assert.rejects(validateFrozenArgumentSourceFrames(fixed, invalidated));
  pass('题前固定来源框架/检验项及any/all政策，保留来源限定，不评答案、不写分、不写认知，不答后换题');

  for (const modify of [
    (x: any) => { x.selections[0].items = []; },
    (x: any) => { x.selections[0].items[0].criterionId = 'concept_meaning'; },
    (x: any) => { x.selections[0].items[0].nodeIds = ['unrelated']; },
    (x: any) => { x.selections[0].packHash = '0'.repeat(64); },
    (x: any) => { x.selections[0].scopeEvidence[0].quote = '伪造范围'; },
  ]) {
    const x = structuredClone(input); modify(x);
    let held;
    try { held = await freezeArgumentSourceFrames(x); } catch (error) {
      assert.match((error as Error).message, /^(来源框架契约无效|argument_context_)/);
    }
    if (held) assert.equal(held.status, 'held');
  }
  const unselected = await argumentContextFixture(); unselected.projection.quality.status = 'unassessed'; await rebindArgumentFixture(unselected);
  const uFrame = await frameInput(unselected);
  assert.equal((await freezeArgumentSourceFrames(uFrame)).status, 'held');
  const boundedFrame = structuredClone(input);
  boundedFrame.packs[0].pack = await read(f, { maxNodes: 1 }, 'fact');
  boundedFrame.selections[0].packHash = boundedFrame.packs[0].pack.packHash;
  boundedFrame.selections[0].scopeEvidence = [f.evidence(5)];
  assert.equal((await freezeArgumentSourceFrames(boundedFrame)).status, 'held');
  const personal = await argumentContextFixture('personal-cognition'), personalPack = await read(personal, undefined, 'fact');
  assert.equal(personalPack.completeness.status, 'complete_for_scope');
  const personalInput = await frameInput(personal);
  assert.equal((await freezeArgumentSourceFrames(personalInput)).status, 'held');
  pass('空/错criterion/借未读节点/伪quote/未知包及个人认知不能当自动评分参考，缺标准只held');

  const definitionInput = structuredClone(input); definitionInput.task = 'definition' as any;
  definitionInput.packs[0].pack = await read(f, undefined, 'definition'); definitionInput.selections[0].packHash = definitionInput.packs[0].pack.packHash;
  definitionInput.selections[0].items = [{ itemId: 'meaning', criterionId: 'concept_meaning' as any, nodeIds: ['rule'], relationIds: [] }];
  assert.equal((await freezeArgumentSourceFrames(definitionInput)).status, 'held');
  definitionInput.selections[0].items.push({ itemId: 'boundary', criterionId: 'concept_boundary' as any, nodeIds: ['law'], relationIds: [] });
  assert.equal((await freezeArgumentSourceFrames(definitionInput)).status, 'fixed');
  const spliced = structuredClone(definitionInput);
  spliced.selections[0].items = [definitionInput.selections[0].items[0]];
  spliced.selections.push({ ...structuredClone(definitionInput.selections[0]), frameId: 'frame-B', items: [definitionInput.selections[0].items[1]] });
  assert.equal((await freezeArgumentSourceFrames(spliced)).status, 'held');
  const reasoningInput: ArgumentSourceFramesInput = { ...structuredClone(input), task: 'reasoning' };
  reasoningInput.packs[0].pack = pack; reasoningInput.selections[0].packHash = pack.packHash;
  reasoningInput.selections[0].items = [{ itemId: 'premise', criterionId: 'actual_premise', nodeIds: ['p1', 'p2', 'threshold', 'law'], relationIds: [] },
    { itemId: 'inference', criterionId: 'inference_link', nodeIds: ['p1', 'p2', 'threshold', 'law', 'rule', 'result'], relationIds: ['e1', 'e2', 'e3', 'e4', 'e5'] }];
  assert.equal((await freezeArgumentSourceFrames(reasoningInput)).status, 'fixed');
  reasoningInput.selections[0].items[1].relationIds = [];
  assert.equal((await freezeArgumentSourceFrames(reasoningInput)).status, 'held');
  for (const task of ['application', 'comparison', 'general'] as const) {
    assert.equal((await freezeArgumentSourceFrames({ ...input, task, policy: task === 'comparison' ? 'all_selected_frames' : input.policy })).status, 'held');
  }
  pass('各框架内六类既有量规不缺项，推理项须本包实际边及两端；新增应用/比较读取意图不擅自升级正式评分');

  for (const [task, criterionId, nodeIds] of [
    ['example', 'example_fit', ['example']], ['condition', 'condition_scope', ['threshold']], ['distinguish', 'distinction', ['rule', 'law']],
  ] as const) {
    const other = await argumentContextFixture();
    other.projection.build.scopes.push({ ...structuredClone(other.projection.build.scopes[0]), task });
    await rebindArgumentFixture(other); const otherPack = await read(other, undefined, task);
    const request: ArgumentSourceFramesInput = { ...await frameInput(other), task, packs: [{ pack: otherPack, authority: other.authority, projection: other.projection }],
      selections: [{ frameId: 'task-frame', packHash: otherPack.packHash,
        scopeEvidence: otherPack.hierarchy.sentences.map((s) => ({ sentenceId: s.id, start: s.start, end: s.end, quote: s.quote })),
        items: [{ itemId: 'task-item', criterionId, nodeIds: [...nodeIds], relationIds: [] }] }] };
    assert.equal((await freezeArgumentSourceFrames(request)).status, 'fixed');
  }
  pass('举例/条件/区分三种既有量规题前冻结兼容，不偷增应用题或更改分值');

  const second = await argumentContextFixture();
  second.projection.source.entityId = 'note-B'; second.scope.allowedNoteIds = ['note-test', 'note-B']; await rebindArgumentFixture(second);
  const first = await argumentContextFixture(); first.scope.allowedNoteIds.push('note-B');
  const firstInput = await frameInput(first);
  const secondInput = await frameInput(second);
  const multi: ArgumentSourceFramesInput = { ...firstInput, packs: [...firstInput.packs, ...secondInput.packs],
    selections: [...firstInput.selections, { ...secondInput.selections[0], frameId: 'frame-B',
      items: secondInput.selections[0].items.map((i) => ({ ...i, itemId: 'item-B' })) }] };
  const multiFixed = await freezeArgumentSourceFrames(multi);
  assert.equal(multiFixed.status, 'fixed'); assert.deepEqual(multiFixed.frames.map((x) => x.source.entityId), ['note-test', 'note-B']);
  await validateFrozenArgumentSourceFrames(multiFixed, multi);
  const unselectedB = structuredClone(multi); unselectedB.packs[1].pack = await read(second, { maxNodes: 1 }, 'fact');
  unselectedB.selections = [firstInput.selections[0]];
  assert.equal((await freezeArgumentSourceFrames(unselectedB)).status, 'fixed');
  const requiredB = structuredClone(unselectedB); requiredB.policy = 'all_selected_frames';
  requiredB.selections.push({ ...secondInput.selections[0], packHash: unselectedB.packs[1].pack.packHash, frameId: 'frame-B',
    scopeEvidence: [second.evidence(5)], items: [{ ...secondInput.selections[0].items[0], itemId: 'item-B' }] });
  assert.equal((await freezeArgumentSourceFrames(requiredB)).status, 'held');
  const omittedPermission = structuredClone(multi); omittedPermission.scope.allowedNoteIds = ['note-test'];
  await assert.rejects(freezeArgumentSourceFrames(omittedPermission));
  const unusedChange = structuredClone(input); unusedChange.scope.allowedNoteIds.push('unselected-new-permission');
  await assert.rejects(validateFrozenArgumentSourceFrames(fixed, unusedChange));
  pass('多源同名节点各自绑定独立快照；未选B不污染A，但题前选中不完整B暂缓，不能沿框架扩权限');

  const snapshotInput = await frameInput(); const freezing = freezeArgumentSourceFrames(snapshotInput);
  snapshotInput.selections[0].items = []; snapshotInput.packs[0].projection.quality.status = 'unassessed';
  const snapshotContract = await freezing; assert.equal(snapshotContract.status, 'fixed');
  assert.ok(Object.isFrozen(snapshotContract) && Object.isFrozen(snapshotContract.frames[0].items));
  await assert.rejects(validateFrozenArgumentSourceFrames(snapshotContract, snapshotInput));
  pass('题前来源框架异步快照隔离、不可变返回；后续标准/审核状态变更仅使旧题过期');

  const altered = structuredClone(fixed); altered.policy = 'all_selected_frames';
  const { contractHash: _hash, ...alteredBody } = altered; altered.contractHash = await argumentContextHash(alteredBody);
  await assert.rejects(validateFrozenArgumentSourceFrames(altered, input));
  const weak = structuredClone(fixed); weak.frames[0].items = [];
  await assert.rejects(validateFrozenArgumentSourceFrames(weak, input));
  const extra = structuredClone(input) as any; extra.answer = '不能答后提供匹配的用户答案';
  await assert.rejects(freezeArgumentSourceFrames(extra));
  pass('契约闭合且题前input独立回放：自重算hash仍不能改政策/删检验项，禁止答后输入/写入字段');

  console.log(`Argument context checks passed: ${checks} groups (synthetic memory only; 0 model requests; 0 production writes).`);
} finally { globalThis.fetch = fetchBefore; }
