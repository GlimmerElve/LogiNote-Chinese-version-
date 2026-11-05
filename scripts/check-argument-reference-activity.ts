import assert from 'node:assert/strict';
import type { KnowledgePointMasteryResult, NoteItem, ReviewAnalysis } from '../src/types.ts';
import type { ReviewEpisodeCapture } from '../src/services/memory/types.ts';
import type { ArgumentContextScope } from '../src/services/argumentContext/types.ts';
import { adaptSavedKnowledgeNote } from '../src/electron/rag/argumentSourceAdapter.ts';
import { noteReferenceSourceHash, buildNoteReferenceChunks } from '../src/electron/rag/noteReferenceChunks.ts';
import { isCurrentNoteReferenceHit } from '../src/electron/rag/noteReferenceAuthority.ts';
import { prepareReviewExitOutcome } from '../src/services/ui/reviewExitWrite.ts';
import { splitSharableFields, splitUserStateFields } from '../src/services/userStateService.ts';
import { markdownFileMap, serializeMetadata } from '../src/services/vaultFsService.ts';
import { argumentContextHash } from '../src/services/argumentContext/hash.ts';

// Only pure production helpers and synthetic data: no filesystem source, LLM or score store.
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('No network allowed in reference activity checks');
let checks = 0;
const pass = (label: string) => { checks++; console.log(`PASS ${label}`); };
const reviewedAt = '2026-10-07T02:15:00.000Z';
const note: NoteItem = { id: 'synthetic-knowledge', title: '选择过载', noteType: 'knowledge',
  content: '# 定义\r\n\r\n选择过载是指选项超过认知处理阈值时难以决策。🧠\r\n\r\n## 条件\r\n\r\n选项超过处理阈值时才可能发生。',
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-06T01:00:00.000Z', tags: [], links: [], backlinks: [], dueDates: [],
  referenceSources: [{ title: '合成参考', type: 'web', url: 'https://example.org/synthetic' }],
  dsrState: { difficulty: 5, stability: 2, lastReviewedAt: null, reviewCount: 2, consecutiveCorrect: 0, consecutiveWrong: 0,
    conceptMastery: 40, conceptMasterySamples: 2, conceptMasteryUpdatedAt: '2026-10-01T01:00:00.000Z' } };
const unrelated: NoteItem = { ...structuredClone(note), id: 'unrelated', title: '无关知识' };
const scope: ArgumentContextScope = { scopeId: 'synthetic-reference', rootScopeId: 'synthetic-reference-root', corpus: 'reference',
  allowedSourceKinds: ['knowledge-note'], allowedNoteIds: [note.id], allowedDocIds: [], allowedRecordIds: [] };
const episode: ReviewEpisodeCapture = { id: 'synthetic-review', startedAt: '2026-10-07T02:00:00.000Z', endedAt: reviewedAt,
  questionText: '请解释选择过载并说明条件', knowledgeContext: note.content, masteryEligible: true,
  messages: [{ id: 'synthetic-answer', role: 'user', content: '选项超过处理能力时，我可能更难决定。', timestamp: reviewedAt }] };
const analysis: ReviewAnalysis = { accuracyScore: 85, completenessScore: 80, logicScore: 80, relevanceScore: 90,
  overallRating: 'easy', feedback: '合成分析，不是模型实测。', suggestion: '继续学习', missingKnowledge: [],
  masteryEvidence: { conceptEvidence: { redefinesInOwnWords: true }, judgmentEvidence: { considersConditions: true },
    reasoningEvidence: { providesPremises: true } } };
const source = (value: NoteItem) => adaptSavedKnowledgeNote({ note: value, rootScopeId: scope.rootScopeId, scope });

try {
  const baseline = await source(note), original = structuredClone(note), rows = [note, unrelated];
  const single = prepareReviewExitOutcome(rows, { noteId: note.id, noteTitle: note.title, analysis, episode });
  const revised = single.notes[0];
  assert.notEqual(revised, note); assert.equal(single.notes[1], unrelated); assert.deepEqual(note, original);
  assert.equal(revised.updatedAt, note.updatedAt); assert.equal(revised.content, note.content);
  assert.deepEqual(splitSharableFields(revised), splitSharableFields(note));
  assert.equal(serializeMetadata(single.notes), serializeMetadata(rows));
  assert.deepEqual(markdownFileMap(single.notes), markdownFileMap(rows));
  const singleSource = await source(revised);
  assert.equal(singleSource.canonicalText, baseline.canonicalText);
  assert.equal(singleSource.source.contentHash, baseline.source.contentHash);
  assert.equal(singleSource.source.version, baseline.source.version);
  assert.equal(await argumentContextHash(singleSource), await argumentContextHash(baseline));
  assert.equal(noteReferenceSourceHash(revised), noteReferenceSourceHash(note));
  pass('单知识点真实复习出口只改变个人状态，metadata/md和完整参考BuildInput保持不变');

  assert.equal(revised.dsrState!.reviewCount, note.dsrState!.reviewCount + 1);
  assert.equal(revised.dsrState!.lastReviewedAt, reviewedAt);
  assert.equal(revised.dsrState!.conceptMasteryUpdatedAt, reviewedAt);
  assert.equal(revised.lastReferencedAt, reviewedAt);
  assert.equal(revised.dsrState!.conceptMasterySamples, note.dsrState!.conceptMasterySamples! + 1);
  assert.ok(revised.dsrState!.conceptMastery! > note.dsrState!.conceptMastery!);
  assert.ok(revised.dsrState!.stability > note.dsrState!.stability);
  assert.equal(revised.dsrState!.consecutiveCorrect, 1);
  assert.ok(single.learningChanges.some(change => change.field === 'mastery'));
  assert.notDeepEqual(splitUserStateFields(revised), splitUserStateFields(note));
  pass('旧评分/DSR真实增量与活动时间正常记录，未把来源版本稳定误做成停止学习更新');

  const segment: KnowledgePointMasteryResult = { name: note.title, level: 'reasoning', conceptDelta: 20, judgmentDelta: 20,
    reasoningDelta: 25, comment: '合成项目复习结果。' };
  const project = prepareReviewExitOutcome(rows, { noteId: 'synthetic-project', noteTitle: '合成项目', analysis: null,
    segmentMastery: [segment, segment], episode });
  const targeted = project.notes[0], projectSource = await source(targeted);
  assert.equal(targeted.updatedAt, note.updatedAt); assert.equal(targeted.lastReferencedAt, reviewedAt);
  assert.equal(targeted.dsrState!.lastReviewedAt, reviewedAt); assert.equal(targeted.dsrState!.conceptMasteryUpdatedAt, reviewedAt);
  assert.equal(targeted.dsrState!.reviewCount, note.dsrState!.reviewCount + 1);
  assert.equal(targeted.dsrState!.conceptMasterySamples, note.dsrState!.conceptMasterySamples! + 1);
  assert.ok(targeted.dsrState!.conceptMastery! > note.dsrState!.conceptMastery!);
  assert.equal(targeted.dsrState!.difficulty, note.dsrState!.difficulty); assert.equal(targeted.dsrState!.stability, note.dsrState!.stability);
  assert.deepEqual(splitSharableFields(targeted), splitSharableFields(note));
  assert.deepEqual(projectSource, baseline); assert.equal(project.notes[1], unrelated);
  assert.equal(project.learningChanges.length, 1);
  pass('项目复习命中知识点的个人状态独立生长，重复结果仅一次，不改变参考原文或源身份');

  const ineligible = prepareReviewExitOutcome(rows, { noteId: note.id, noteTitle: note.title, analysis,
    episode: { ...episode, masteryEligible: false } });
  assert.equal(ineligible.notes[0], note); assert.deepEqual(ineligible.learningChanges, []);
  assert.deepEqual(await source(ineligible.notes[0]), baseline);
  pass('不具评分资格的复习仍守旧写入门槛，不因结构桥存在而改分');

  const dateOnly = { ...note, updatedAt: '2026-10-07T03:00:00.000Z' };
  const activityOnly = { ...dateOnly, pinned: true, isFavorite: true, flowSummary: '新的个人复述', lastReferencedAt: reviewedAt,
    dsrState: { ...note.dsrState!, conceptMastery: 90, lastReviewedAt: reviewedAt } };
  assert.deepEqual((await source(dateOnly)).source, baseline.source);
  assert.deepEqual(await source(activityOnly), baseline);
  assert.equal(noteReferenceSourceHash(dateOnly), noteReferenceSourceHash(note));
  pass('历史纯updatedAt/个人复述/掌握度/收藏变化不升级或吊销内容论证source版本');

  for (const changed of [{ ...note, content: `${note.content}\r\n新增例子。` }, { ...note, title: '新的标题' },
    { ...note, createdAt: '2026-10-02T00:00:00.000Z' },
    { ...note, referenceSources: [{ title: '不同的合成出处', type: 'web' as const, url: 'https://example.org/another' }] }]) {
    const changedSource = await source(changed);
    assert.notEqual(changedSource.source.version, baseline.source.version);
    assert.equal(changedSource.source.contentHash === baseline.source.contentHash, changed.content === note.content);
  }
  await assert.rejects(source({ ...note, noteType: 'project' }));
  await assert.rejects(source({ ...note, updatedAt: undefined }));
  pass('正文/标题/创建身份/实际出处改变必须重评新source版本，非knowledge或未保存元数据拒绝');

  const piece = buildNoteReferenceChunks(note)[0];
  const hit = { noteId: note.id, noteType: 'knowledge' as const, title: note.title, score: 0.8, snippet: piece.content,
    passage: { schemaVersion: 2 as const, chunkId: piece.chunkId, sourceHash: noteReferenceSourceHash(note), sourceUpdatedAt: note.updatedAt,
      textStart: piece.textStart, textEnd: piece.textEnd, sectionPath: piece.sectionPath, sectionKind: piece.sectionKind, forcedSplit: piece.forcedSplit } };
  assert.equal(isCurrentNoteReferenceHit(hit, [revised]), true);
  assert.equal(isCurrentNoteReferenceHit(hit, [targeted]), true);
  assert.equal(isCurrentNoteReferenceHit(hit, [dateOnly]), false);
  pass('真实复习不会无故失效v2命中；历史时间单改仍保持passage保存版freshness门槛，不偷偷放宽');

  console.log(`Argument reference activity checks passed: ${checks} groups (synthetic pure review outcomes; 0 model calls; no real vault/index/score/cognition writes).`);
} finally { globalThis.fetch = originalFetch; }
