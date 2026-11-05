import assert from 'node:assert/strict';
import { masteryBaselineFixture, masteryComparisonFixture } from './fixtures/mastery-baselines';
import type { NoteItem, NoteSearchResult } from '../src/types';
import type { ReviewComparisonAnswer, ReviewComparisonDependencies } from '../src/services/reviewComparison/types';
import type { ReviewEpisodeCapture } from '../src/services/memory/types';
import { buildNoteReferenceChunks, noteReferenceSourceHash } from '../src/electron/rag/noteReferenceChunks';
import { buildReviewComparisonPacket, verifyReviewComparisonFreshness } from '../src/services/reviewComparison/packet';
import { summarizeReviewComparison } from '../src/services/reviewComparison/session';
import { buildReviewReferenceCatalog, freezeReviewReferenceRubric, bindReviewReferenceItems } from '../src/services/reviewReferenceRubric';
import { freezeReviewAssessment } from '../src/services/reviewAssessment';
import { planReviewMastery, evaluateReviewMastery, recheckReviewMasteryReferences } from '../src/services/masteryShadow/review';
import { incompleteReviewReferenceContext } from '../src/services/reviewComparison/referenceScope';
import { selectReviewNotePassage } from '../src/services/reviewComparison/notePassages';

// Isolated current-source fixtures and deterministic model substitutes only. No configured
// LLM, embedding model, user vault, profile or persistent index is accessed or modified.
globalThis.fetch = async () => assert.fail('No network allowed');
let groups = 0;
const pass = (name: string) => { groups++; console.log(`PASS ${name}`); };
const at = '2026-10-18T01:00:00.000Z';
const definition = '人在知道自己受到观察时，行为可能改变；行为改变不能直接证明干预有效。';
const condition = '应保持对照组和实验组受到的关注程度相近，再比较干预效果。';
const note: NoteItem = { id: 'target', title: '霍桑效应', noteType: 'knowledge',
  content: `## 简介\r\n${'这是无关的历史介绍。'.repeat(80)}\r\n\r\n## 含义\r\n${definition}\r\n\r\n## 研究控制\r\n${condition}\r\n\r\n## 补充\r\n${'这是无关的背景资料。'.repeat(80)}`,
  tags: [], links: [], backlinks: [], dueDates: [], createdAt: at, updatedAt: at };
const related = { ...note, id: 'related', title: '对照实验', content: `## 对照\n${condition}\n\n## 历史\n无关的实验历史。` };
const pieces = buildNoteReferenceChunks(note);
const chunk = pieces.find(piece => piece.content === definition)!;
assert.ok(chunk);
function hitFor(owner: NoteItem, text: string): NoteSearchResult {
  const p = buildNoteReferenceChunks(owner).find(piece => piece.content === text)!;
  assert.ok(p);
  return { noteId: owner.id, noteType: 'knowledge', title: owner.title, score: .8, snippet: p.content.slice(0, 450),
    evidenceOrigin: 'note-passage', matchKinds: ['note'], passage: { schemaVersion: 2, chunkId: p.chunkId,
      sourceHash: noteReferenceSourceHash(owner), sourceUpdatedAt: owner.updatedAt, textStart: p.textStart,
      textEnd: p.textEnd, sectionPath: p.sectionPath, sectionKind: p.sectionKind, forcedSplit: p.forcedSplit } };
}
const hit = hitFor(note, definition);
const assessment = freezeReviewAssessment('definition', [note.title]);
const input: ReviewComparisonAnswer = { activityId: 'fixture-review', questionText: '解释霍桑效应的含义，以及为什么行为改变不能直接证明干预有效。',
  evidence: { messageId: 'a', answer: '知道自己被观察会改变表现，但不能把变化都当成干预效果。', hintLevel: 0,
    targetKnowledgeNames: [note.title], questionIntent: { version: 1, questionMessageId: 'q', knowledgeTargets: [note.title], assessment } } };
const scope = { targetScopeNoteIds: [note.id] };
const calls: Array<{ query: string; limit: number; ids?: string[] }> = [];
const deps: ReviewComparisonDependencies = {
  readNotes: async () => structuredClone([note, related]),
  loadCognition: async () => assert.fail('No cognition target'),
  searchNotes: async (query, limit, options) => {
    calls.push({ query, limit, ids: options?.allowedNoteIds });
    return structuredClone(options?.allowedNoteIds ? [hit] : [hitFor(related, condition)]);
  },
  searchDocuments: async () => [], previewDocument: async () => assert.fail('No document fixture'),
};
const before = JSON.stringify([note, related, input]);
const packet = await buildReviewComparisonPacket(input, deps, scope);
const source = packet.references.find(row => row.kind === 'target-note')!;
assert.equal(source.text, definition);
assert.equal(source.chunkId, chunk.chunkId);
assert.equal(source.textStart, chunk.textStart);
assert.equal(note.content.slice(source.textStart, source.textEnd), source.text);
assert.ok(!source.text.includes('历史介绍'));
assert.equal(source.truncated, true, 'an intact passage is still an excerpt of the whole note');
assert.deepEqual(calls.find(call => call.ids)?.ids, [note.id]);
assert.ok(calls.every(call => !call.query.includes(input.evidence.answer)), 'wrong answers cannot shift reference retrieval');
assert.equal(packet.references.find(row => row.kind === 'related-note')!.text, condition);
assert.ok(!packet.preparation.warnings.includes('note_reference_semantic_fallback'));
assert.deepEqual(await verifyReviewComparisonFreshness(packet, deps), { fresh: true, reasons: [] });
pass('受测知识点独立限定检索，不被全库头部挤掉；目标及关联笔记均使用命中块原文而非整篇');

const episode: ReviewEpisodeCapture = { id: input.activityId, startedAt: at, endedAt: at,
  questionText: input.questionText, knowledgeContext: '', masteryEligible: true,
  messages: [{ id: 'q', role: 'assistant', content: input.questionText, timestamp: at },
    { id: 'a', role: 'user', content: input.evidence.answer, timestamp: at }], answerEvidence: [input.evidence] };
const batch = planReviewMastery([note], note.id, episode, { packets: [packet], summary: summarizeReviewComparison([packet], 0) });
assert.equal(batch.items.length, 1);
assert.equal(batch.items[0].input.references[0].quote, definition);
let modelCalls = 0;
const evaluated = await evaluateReviewMastery(batch, async ({ userInput }) => {
  modelCalls++;
  const request = JSON.parse(userInput);
  assert.deepEqual(request.references.map((row: any) => row.quote), [definition]);
  assert.ok(!userInput.includes('历史介绍') && !userInput.includes('背景资料'));
  return { protocol: 'mastery-shadow-evaluator-v1', evaluationId: request.evaluationId, knowledgePointId: request.knowledgePointId,
    baselines: masteryBaselineFixture(request),
    evidence: [{ id: 'E1', quote: input.evidence.answer }], criteria: request.criteria.map((row: any) => ({ id: row.id,
      state: 'partial', evidenceIds: ['E1'], referenceIds: ['REF1'], referenceQuotes: [{ referenceId: 'REF1', quote: request.references[0].quote.slice(0, 180) }],
      comparison: masteryComparisonFixture(request, row.id, ['E1']),
      reason: '仅验证给定参考确实进入原有评价请求，语义结论为替身。' })), summary: '合成替身评价。' };
});
assert.equal(modelCalls, 1); assert.ok(evaluated.items[0].evaluation && !evaluated.items[0].error);
assert.ok(!(await recheckReviewMasteryReferences(evaluated, deps)).items[0].error);
pass('命中短片段真实进入原有掌握度评价请求，解析及保存前回读通过，不新增评价调用');

const catalog = await buildReviewReferenceCatalog([note], [note.title], [note.id]);
const selected = catalog.candidates.find(row => row.quote === definition)!;
const fixed = freezeReviewReferenceRubric(`concept_meaning=${selected.candidateId};concept_boundary=${selected.candidateId}`, assessment, catalog);
assert.equal(fixed.status, 'fixed');
const fixedInput = structuredClone(input); fixedInput.evidence.questionIntent.referenceRubric = fixed;
let scopedCalls = 0;
const fixedPacket = await buildReviewComparisonPacket(fixedInput, { ...deps, searchNotes: async (_q, _k, options) => {
  if (options) scopedCalls++; return [hitFor(note, condition)];
} }, scope);
assert.equal(scopedCalls, 0, 'frozen baseline requires no extra target retrieval');
assert.deepEqual(fixedPacket.references.map(row => row.text), [definition]);
assert.equal(bindReviewReferenceItems(fixedPacket).length, 2, 'same interval can serve two criteria without duplicate source text');
assert.equal(incompleteReviewReferenceContext(fixedPacket, fixedPacket.references[0]), false);
assert.equal(incompleteReviewReferenceContext(packet, source), true, 'a retrieved excerpt does not certify complete whole-note knowledge');
assert.equal(fixedPacket.references[0].truncated, true);
pass('固定题目项优先且原位保留、同区间去重；本题片段完整与整篇未覆盖明确分开');

const unicodeNote = { ...note, content: '## 引言\r\n无关前言。\r\n\r\n## 示例\r\n🙂第一行解释\r\n第二行仍属于这个句子。' };
const unicodeText = '🙂第一行解释\r\n第二行仍属于这个句子。';
const unicodeResult = selectReviewNotePassage(unicodeNote, [hitFor(unicodeNote, unicodeText)], noteReferenceSourceHash(unicodeNote), '示例');
assert.equal(unicodeResult.passage!.text, unicodeText);
assert.equal(unicodeNote.content.slice(unicodeResult.passage!.textStart, unicodeResult.passage!.textEnd), unicodeText);
assert.equal(unicodeResult.passage!.textEnd - unicodeResult.passage!.textStart, unicodeText.length);
const longClause = { ...note, content: `## 长句\n${'甲'.repeat(5000)}。` };
const clausePieces = buildNoteReferenceChunks(longClause);
const middle = clausePieces[4];
assert.ok(middle.forcedSplit);
const clauseResult = selectReviewNotePassage(longClause, [hitFor(longClause, middle.content)], noteReferenceSourceHash(longClause), '长句');
assert.ok(clauseResult.passage!.text.length <= 1200);
assert.ok(clauseResult.passage!.text.includes(middle.content));
assert.ok(clauseResult.warnings.includes('note_reference_forced_split'), 'forced clauses are not presented as a complete semantic proof');
assert.equal(longClause.content.slice(clauseResult.passage!.textStart, clauseResult.passage!.textEnd), clauseResult.passage!.text);
pass('CRLF/emoji/跨行原文坐标不变；长句仅有限补邻，不硬截新窗口，也不宣称语义已完整');

const threeNotes = ['甲', '乙', '丙'].map(suffix => ({ ...note, id: `target-${suffix}`, title: `知识${suffix}`, content: definition }));
const titles = threeNotes.map(row => row.title), ids = threeNotes.map(row => row.id);
const threeCatalog = await buildReviewReferenceCatalog(threeNotes, titles, ids);
const threeTask = freezeReviewAssessment('definition', titles);
const allIds = threeCatalog.candidates.map(row => row.candidateId).join(',');
const threeRubric = freezeReviewReferenceRubric(`concept_meaning=${allIds};concept_boundary=${allIds}`, threeTask, threeCatalog);
assert.equal(threeRubric.status, 'fixed');
const threeInput = structuredClone(input);
threeInput.evidence.targetKnowledgeNames = titles;
threeInput.evidence.questionIntent = { version: 1, questionMessageId: 'q', knowledgeTargets: titles, assessment: threeTask, referenceRubric: threeRubric };
const threePacket = await buildReviewComparisonPacket(threeInput, { ...deps, readNotes: async () => threeNotes, searchNotes: async () => [] }, { targetScopeNoteIds: ids });
assert.equal(threePacket.references.length, 3);
assert.deepEqual(threePacket.coverage.missingTargetNames, []);
assert.equal(bindReviewReferenceItems(threePacket).length, 6, 'fixed items never disappear behind the two ordinary-retrieval target budget');
pass('多知识点固定参考项全部保留，不被普通两目标检索预算误裁剪');

for (const mutate of [
  (row: NoteSearchResult) => row.passage!.sourceHash = '0'.repeat(64),
  (row: NoteSearchResult) => row.passage!.sourceUpdatedAt = '2000-01-01',
  (row: NoteSearchResult) => row.passage!.textStart++,
  (row: NoteSearchResult) => row.passage!.textEnd += 10,
  (row: NoteSearchResult) => row.snippet = '缓存杜撰的参考答案',
]) {
  const bad = structuredClone(hit); mutate(bad);
  const degraded = await buildReviewComparisonPacket(input, { ...deps, searchNotes: async () => [bad] }, scope);
  assert.ok(degraded.preparation.warnings.includes('note_passage_unverifiable'));
  assert.ok(degraded.preparation.warnings.includes('note_reference_semantic_fallback'));
  assert.equal(degraded.references[0].chunkId, undefined);
  assert.ok(degraded.references[0].text.length <= 1200 && !degraded.references[0].text.includes('杜撰'));
  assert.equal(note.content.slice(degraded.references[0].textStart, degraded.references[0].textEnd), degraded.references[0].text);
}
const failedSearch = await buildReviewComparisonPacket(input, { ...deps, searchNotes: async () => { throw Error('fixture'); } }, scope);
assert.ok(failedSearch.preparation.warnings.includes('target_note_retrieval_unavailable'));
assert.ok(failedSearch.references[0].text.includes('不能直接证明干预有效'));
pass('指纹/版本/坐标/缓存文字无效或检索失败时，明确记录降级，只使用当前正文的短语义块');

const changedNote = { ...note, referenceSources: [{ title: '新增出处', type: 'web' as const, url: 'https://example.test' }] };
assert.ok((await verifyReviewComparisonFreshness(packet, { ...deps, readNotes: async () => [changedNote, related] })).reasons.includes('note_snapshot_changed'));
assert.ok((await recheckReviewMasteryReferences(evaluated, { ...deps, readNotes: async () => [changedNote] })).items[0].error);
const stale = await buildReviewComparisonPacket(fixedInput, { ...deps, readNotes: async () => [{ ...note, content: note.content + '改动' }] }, scope);
assert.ok(stale.preparation.masteryReasons.includes('question_reference_changed'));
assert.ok(!stale.references.some(row => row.kind === 'target-note'), 'stale frozen item is never replaced by a new passage');
assert.equal(JSON.stringify([note, related, input]), before);
pass('出处元数据变化也会被保存前复核发现；过期固定标准不替换，真实笔记/画像/索引零写入');

console.log(`\n${groups} review passage retrieval groups passed (deterministic fixtures, no cloud semantic acceptance).`);
