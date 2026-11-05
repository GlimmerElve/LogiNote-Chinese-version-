import assert from 'node:assert/strict';
import { masteryCriterionQuery, masteryTopicContext } from '../src/services/masteryShadow/referenceFocus';
import { referenceProseKind, selectReferenceEvidence } from '../src/services/referenceEvidence';
import { createFlowReferenceProvider } from '../src/services/flowAnalysis/referenceProvider';
import { buildMasteryShadowEvaluationRequest, parseMasteryShadowEvaluation, type MasteryShadowEvaluationInput } from '../src/services/masteryShadow/evaluator';
import type { NoteItem, TextbookReferenceSearchResult } from '../src/types';
import { primaryMasteryReference } from '../src/services/masteryShadow/primaryReferences';
import { applyMasteryShadowObservations, createMasteryShadowState } from '../src/services/masteryShadow/stateMachine';
import { buildNoteReferenceChunks, noteReferenceSourceHash } from '../src/electron/rag/noteReferenceChunks';
import type { NoteSearchResult } from '../src/types';

globalThis.fetch = async () => assert.fail('Local reference-quality tests must not send requests');
const main = '诱饵效应。用两组对照实验核对分组与归因。目标和竞争项的价格、功能需要比较。';
const topic = masteryTopicContext(`${main}\n另外，锚定效应只记得名字。`, '诱饵效应', ['诱饵效应', '锚定效应']);
assert.ok(topic.includes('两组对照实验'));
const incidental = masteryTopicContext(`${main}\n另外，锚定效应只记得名字。`, '锚定效应', ['诱饵效应', '锚定效应']);
assert.ok(!incidental.includes('两组对照实验'), 'Neighbouring knowledge must not supply retrieval context');
assert.match(masteryCriterionQuery('诱饵效应', 'reasoning_sufficiency', topic), /对照实验 分组 控制变量/);
assert.match(masteryCriterionQuery('诱饵效应', 'concept_application', topic), /属性比较 支配关系/);
assert.doesNotMatch(masteryCriterionQuery('诱饵效应', 'concept_application', `${topic}六十五元一定支配六十元。`), /六十五元|一定支配/);

assert.equal(referenceProseKind('- 能说明效应的定义与条件。', '教材 > 学习目标'), 'meta');
assert.equal(referenceProseKind('先把三种效应并排放好。下表由定义整理而成，属于教学对照。'), 'meta');
assert.equal(referenceProseKind('证据未提供效应强度，不能推广到全部人群。'), 'limitation');
assert.equal(referenceProseKind('两组仅改变选项集合，保持介绍方式、分组及作答时间一致。'), 'content');
assert.equal(referenceProseKind('- 来源 2 未提供具体应用案例。\n- 各来源对定义一致，本整理未作补充。', '沉没成本 > 证据限制'), 'meta');
assert.notEqual(referenceProseKind('样本有限，不能推广到全部人群；应用须满足观察条件。', '效应 > 证据限制'), 'meta',
  'real empirical limitations remain usable, unlike editorial source inventory');
assert.equal(referenceProseKind('[N3] 只有同时满足两个条件才能作此判断。'), 'content', 'Leading source citations are not JSON metadata');
assert.equal(referenceProseKind('段落残片\\n\\n这是JSON字符串的一部分。"}\n```'), 'meta');
const table = '| 选项 | 价格 | 功能 |\r\n| --- | --- | --- |\r\n| 目标 | 60 | 多 |\r\n| 诱饵 | 65 | 多 |';
const intro = '先把选项并排放好，下表列出各项属性。';
const body = `## 实例\r\n\r\n${intro}\r\n\r\n${table}\r\n\r\n诱饵比目标贵但功能相同，目标支配诱饵。`;
const introStart = body.indexOf(intro), rowStart = body.indexOf('| 诱饵');
const bundled = selectReferenceEvidence(body, { textStart: introStart, textEnd: introStart + intro.length, sectionPath: '实例' })!;
assert.ok(bundled.text.includes(table), 'A table transition must bring the actual complete table');
assert.equal(bundled.text, body.slice(bundled.textStart, bundled.textEnd));
const row = selectReferenceEvidence(body, { textStart: rowStart, textEnd: rowStart + '| 诱饵 | 65 | 多 |'.length, sectionPath: '实例' })!;
assert.equal(row.text, table, 'One row never loses its headers and comparison rows');
assert.equal(selectReferenceEvidence(body, { textStart: rowStart, textEnd: rowStart + '| 诱饵 | 65 | 多 |'.length, sectionPath: '实例' }, 35), undefined);
const clause = '若仅按立场筛选材料，\n\n则反向信息可能系统性缺席。\n\n## 无关章节\n\n不要跨过标题。';
const completed = selectReferenceEvidence(clause, { textStart: 0, textEnd: clause.indexOf('\n'), sectionPath: '条件', forcedSplit: true })!;
assert.ok(completed.text.includes('则反向信息可能系统性缺席'));
assert.ok(!completed.text.includes('无关章节'));
const longClause = '很长但没有句号的单一条件'.repeat(15000);
assert.equal(selectReferenceEvidence(longClause, { textStart: 80000, textEnd: 80600, sectionPath: '条件', forcedSplit: true }), undefined,
  'An oversized unsplittable clause is not called complete and does not cause a full-book scan');

const at = '2026-10-18T12:00:00.000Z';
const note = (id: string, title: string, content: string, noteType: NoteItem['noteType']): NoteItem => ({ id, title, content, noteType,
  tags: [], links: [], backlinks: [], dueDates: [], createdAt: at, updatedAt: at });
const goal = '- 能说明边界条件。';
const project: NoteItem = { ...note('project', '项目', `<TextbookBoundary id="book" edge="start" />\n\n## 学习目标\n\n${goal}\n\n<TextbookBoundary id="book" edge="end" />`, 'project'),
  links: ['边界条件'], textbook: { schemaVersion: 1, textbookId: 'textbook', projectNoteId: 'project', rootProjectId: 'project',
    revisionId: 'r1', regionId: 'book', createdAt: at, updatedAt: at } };
const knowledge = note('knowledge', '边界条件', '边界条件限定判断在什么对象和情境下成立。', 'knowledge');
const provider = createFlowReferenceProvider({ noteId: project.id, noteTitle: project.title, speakingContent: '', allNotes: [project, knowledge] }, {
  searchTextbooks: async (_query, _ids, k) => {
    assert.equal(k, 6);
    const textbookBody = `## 学习目标\n\n${goal}`;
    return [{ noteId: project.id, textbookId: 'textbook', revisionId: 'r1', title: project.title, score: .9, snippet: goal,
      chunkId: 'goals', sourceHash: 'a'.repeat(64), textStart: textbookBody.indexOf(goal), textEnd: textbookBody.length,
      sectionPath: '学习目标', sectionKind: 'general', forcedSplit: false } satisfies TextbookReferenceSearchResult];
  }, searchDocuments: async () => [], searchNotes: async () => [],
}, { purpose: 'mastery' });
const refs = await provider.retrieve({} as any, {} as any, [{ id: 'test', layer: 'concept', nodeIds: [], query: '边界条件定义' }]);
assert.ok(!refs.some(reference => reference.tier === 1 && reference.availability === 'available'));
assert.ok(refs.some(reference => reference.tier === 3 && reference.text === knowledge.content), 'Goals cannot suppress lower-tier real content');

const input: MasteryShadowEvaluationInput = { evaluationId: 'quality', knowledgePointId: 'knowledge', knowledgePointTitle: '边界条件',
  occurredAt: at, source: 'flow_review', strength: 'natural', assistance: 'independent',
  task: { referenceContract: 'criterion-quotes-v1', responseType: 'open', prompt: '核对含义和推理',
    requiredLayers: ['concept', 'reasoning'], criterionIds: ['concept_accuracy', 'reasoning_relevance'] },
  answer: '它限定判断成立的对象和情境，因此不能跨范围推断。',
  references: [{ id: 'REF', tier: 3, sourceLabel: '笔记', quote: knowledge.content }] };
const raw = { protocol: 'mastery-shadow-evaluator-v1', evaluationId: input.evaluationId, knowledgePointId: input.knowledgePointId,
  evidence: [{ id: 'E1', quote: input.answer }], criteria: [
    { id: 'concept_accuracy', state: 'pass', evidenceIds: ['E1'], referenceIds: ['REF'],
      referenceQuotes: [{ referenceId: 'REF', quote: '限定判断在什么对象和情境下成立。' }], reason: '用户保留对象与情境限制。' },
    { id: 'reasoning_relevance', state: 'pass', evidenceIds: ['E1'], referenceIds: [], reason: '限制直接指向不跨范围推断。' },
  ] };
assert.equal(parseMasteryShadowEvaluation(raw, input).criteria[0].state, 'pass');
const forged = structuredClone(raw); forged.criteria[0].referenceQuotes![0].quote = '资料未曾说过的结论';
const guarded = parseMasteryShadowEvaluation(forged, input);
assert.equal(guarded.criteria[0].state, 'unverifiable');
assert.equal(guarded.criteria[1].state, 'pass', 'A bad excerpt never rejects the entire result');
const legacy = { ...input, task: { ...input.task, referenceContract: undefined } };
assert.equal(parseMasteryShadowEvaluation({ ...raw, criteria: raw.criteria.map(criterion => ({ ...criterion, referenceQuotes: undefined })) }, legacy).criteria[0].state, 'pass');
assert.match(buildMasteryShadowEvaluationRequest(input).systemPrompt, /各有取舍/);

// Transport/contract tests, not a mock claim that the model understands the sources.
const primary = await primaryMasteryReference(knowledge, 'concept_accuracy', '边界条件定义', {
  searchNotes: async (_query, k, options) => {
    assert.equal(k, 1);
    assert.deepEqual(options?.allowedNoteIds, [knowledge.id], 'Primary retrieval stays in the actual target note');
    return [];
  },
});
assert.equal(primary?.sourceRole, 'primary');
assert.equal(primary?.sourceId, knowledge.id);
assert.ok(primary && knowledge.content.includes(primary.quote));
assert.equal(await primaryMasteryReference(project, 'concept_accuracy', '定义'), undefined);

// Real-world regression: the first vector hit can be a valid, current bibliography.
// It must not block a later prose hit or the current-body semantic fallback.
const conformity = note('conformity-fixture', '从众效应',
  '## 定义\n\n从众效应指在群体压力下调整自己的判断以符合多数意见。\n\n## 区别与边界\n\n从众是向群体多数意见靠拢，服从是遵从权威命令，两者不能混为一谈。\n\n## 来源\n\n* [从众效应资料](https://example.test/conformity)', 'knowledge');
const conformityBefore = JSON.stringify(conformity);
const conformityChunks = buildNoteReferenceChunks(conformity);
const conformityHit = (section: string): NoteSearchResult => {
  const piece = conformityChunks.find(row => row.sectionPath === section)!;
  assert.ok(piece);
  return { noteId: conformity.id, noteType: 'knowledge', title: conformity.title, score: .9,
    snippet: piece.content, evidenceOrigin: 'note-passage', matchKinds: ['note'],
    passage: { schemaVersion: 2, chunkId: piece.chunkId, sourceHash: noteReferenceSourceHash(conformity),
      sourceUpdatedAt: conformity.updatedAt, textStart: piece.textStart, textEnd: piece.textEnd,
      sectionPath: piece.sectionPath, sectionKind: piece.sectionKind, forcedSplit: piece.forcedSplit } };
};
const sourceHit = conformityHit('来源'), boundaryHit = conformityHit('区别与边界');
const laterProse = await primaryMasteryReference(conformity, 'concept_boundary', '从众效应 边界', {
  searchNotes: async (_query, k, options) => {
    assert.equal(k, 1); assert.deepEqual(options?.allowedNoteIds, [conformity.id]);
    return [sourceHit, boundaryHit];
  },
});
assert.equal(laterProse?.quote, boundaryHit.snippet, 'a usable lower-ranked prose hit survives a bibliography head hit');
assert.ok(laterProse?.locator?.includes(boundaryHit.passage!.chunkId));
const proseFallback = await primaryMasteryReference(conformity, 'concept_boundary', '从众效应 边界', {
  searchNotes: async () => [sourceHit],
});
assert.ok(proseFallback && conformity.content.includes(proseFallback.quote));
assert.doesNotMatch(proseFallback.quote, /https:\/\/|## 来源/u, 'only-bibliography vector hits trigger real body fallback');
const sourcesOnly = { ...conformity, content: '## 来源\n\n* [从众效应资料](https://example.test/conformity)' };
assert.equal(await primaryMasteryReference(sourcesOnly, 'concept_boundary', '从众效应 边界', {
  searchNotes: async () => [],
}), undefined, 'a source list alone must never be promoted to factual standards');
assert.equal(JSON.stringify(conformity), conformityBefore, 'reference selection never rewrites source notes');
// Sunk-cost regression: a high-ranked editorial note says "应用/操作" many
// times, but the example section is the usable application standard.
const sunk = note('sunk-cost-fixture', '沉没成本',
  '## 定义\n\n沉没成本是已发生且无法收回的成本，决策应比较未来增量成本与收益。\n\n## 示例与应用\n\n评估项目投资时应排除过去已支付且无法收回的研发投入，比较未来收益与成本。\n\n## 边界\n\n不意味着项目短期亏损就必须放弃，应检查未来条件。\n\n## 证据限制\n\n- 来源 2 只给出沉没成本定义，未提供应用实例或操作说明。\n- 各来源未展开更多应用案例，本整理未作补充。', 'knowledge');
const sunkChunk = buildNoteReferenceChunks(sunk).find(chunk => chunk.sectionPath === '证据限制')!;
const sunkMetaHit: NoteSearchResult = { noteId: sunk.id, noteType: 'knowledge', title: sunk.title, score: .99,
  snippet: sunkChunk.content, evidenceOrigin: 'note-passage', matchKinds: ['note'],
  passage: { schemaVersion: 2, chunkId: sunkChunk.chunkId, sourceHash: noteReferenceSourceHash(sunk), sourceUpdatedAt: sunk.updatedAt,
    textStart: sunkChunk.textStart, textEnd: sunkChunk.textEnd, sectionPath: sunkChunk.sectionPath,
    sectionKind: sunkChunk.sectionKind, forcedSplit: sunkChunk.forcedSplit } };
for (const hits of [[], [sunkMetaHit]]) {
  const ref = await primaryMasteryReference(sunk, 'concept_application', '沉没成本 应用 实例 操作 如何识别', { searchNotes: async () => hits });
  assert.match(ref!.quote, /评估项目投资/u);
  assert.doesNotMatch(ref!.quote, /来源 2|本整理/u);
  assert.ok(sunk.content.includes(ref!.quote));
}
const v2: MasteryShadowEvaluationInput = { ...input, task: { ...input.task, referenceContract: 'criterion-baseline-v2' },
  references: [{ ...input.references[0], id: 'BOOK', tier: 1, sourceRole: 'supplement' }, primary!] };
assert.equal(JSON.parse(buildMasteryShadowEvaluationRequest(v2).userInput).references[0].sourceRole, 'primary',
  'Mastery priority differs from the physical source tier');
const baselineRaw = { ...raw, baselines: [{ id: 'concept_accuracy', coverage: 'insufficient', rule: '',
  referenceIds: [], referenceQuotes: [], reason: '当前片段没有提供本项比较标准。' },
  { id: 'reasoning_relevance', coverage: 'not_required', reason: '从原话判断联系。' }],
  criteria: raw.criteria.map(criterion => ({ ...criterion, state: criterion.id === 'concept_accuracy' ? 'fail' : 'pass' })) };
const missingCoverage = parseMasteryShadowEvaluation(baselineRaw, v2);
assert.equal(missingCoverage.criteria[0].state, 'unverifiable', 'Missing reference standards are not user errors');
assert.equal(missingCoverage.criteria[1].state, 'pass', 'An insufficient reference never rejects other evidenced criteria');
assert.equal(missingCoverage.observations[0].results[0].verdict, 'unverifiable');
const unchanged = createMasteryShadowState(v2.knowledgePointId);
assert.deepEqual(applyMasteryShadowObservations(unchanged, missingCoverage.observations.filter(row =>
  row.results[0].layer === 'concept')).layers, unchanged.layers, 'Insufficient standards never increase passes or failures');
const covered = { ...baselineRaw, baselines: [{ id: 'concept_accuracy', coverage: 'covered', rule: knowledge.content,
  referenceIds: [primary!.id], referenceQuotes: [{ referenceId: primary!.id, quote: primary!.quote }], reason: '完整定义可对照。' }] };
assert.equal(parseMasteryShadowEvaluation(covered, v2).criteria[0].state, 'fail', 'An evidenced contradiction is still allowed');
const fakeBaseline = { ...covered, baselines: covered.baselines.map(row => ({ ...row,
  referenceQuotes: [{ referenceId: primary!.id, quote: '笔记中不存在的实验要求' }] })) };
assert.equal(parseMasteryShadowEvaluation(fakeBaseline, v2).criteria[0].state, 'unverifiable');
assert.equal(parseMasteryShadowEvaluation({ ...covered, baselines: [] }, v2).criteria[0].state, 'unverifiable');
const listSource = '- 目标不差于诱饵。\n- 至少一项更好。';
const listInput = { ...v2, references: [{ ...primary!, quote: listSource }] };
const listRaw = { ...covered, baselines: [{ ...covered.baselines[0],
  referenceQuotes: [{ referenceId: primary!.id, quote: '目标不差于诱饵。至少一项更好。' }] }] };
assert.equal(parseMasteryShadowEvaluation(listRaw, listInput).criteria[0].referenceQuotes?.[0].quote,
  '目标不差于诱饵。\n- 至少一项更好。', 'Formatting is restored to the exact source, not a model paraphrase');
for (const [source, quote] of [['目标不优于诱饵。', '目标优于诱饵。'], ['结果为- 33个百分点。', '结果为33个百分点。'],
  ['not able', 'notable'], ['至少两个条件。', '至少三个条件。']]) {
  assert.equal(parseMasteryShadowEvaluation({ ...covered, baselines: [{ ...covered.baselines[0],
    referenceQuotes: [{ referenceId: primary!.id, quote }] }] }, { ...v2, references: [{ ...primary!, quote: source }] })
    .criteria[0].state, 'unverifiable', 'Meaning-bearing differences cannot be normalized away');
}
console.log('PASS topic-scoped neutral retrieval, structural filtering, complete bounded tables/conditions, source-priority fallback, per-criterion excerpts and legacy compatibility. No network or production writes.');
