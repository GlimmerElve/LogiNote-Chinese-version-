import assert from 'node:assert/strict';
import type { DocumentSearchResult, FlowSession, NoteItem, TextbookReferenceSearchResult } from '../src/types';
import { createFlowReferenceProvider, runProductionFlowAnalysisV2 } from '../src/services/flowAnalysis/productionV2';
import { readTextbookBody } from '../src/services/textbook/noteContent';
import { saveFlowReviewRecord, finishFlowReviewRecord, saveReviewArgument } from '../src/services/textbook/reviewRecordStore';
import { createFlowShadowFixture } from '../src/services/flowShadow/demo';
import { COGNITIVE_EVIDENCE_CONTRACT } from '../src/services/flowShadow/types';
import { extractFlowEvidence } from '../src/services/memory/evidenceExtractor';
import { buildNoteReferenceChunks, noteReferenceSourceHash } from '../src/electron/rag/noteReferenceChunks';

const beforeFetch = globalThis.fetch, windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
globalThis.fetch = async () => assert.fail('This regression must never send a cloud request');
const fixture = createFlowShadowFixture(), time = fixture.input.observedAt;
const body = '# 边界条件\n概念的边界由对象、条件和例外共同确定。\n\n观察结果只有在条件成立时才支持结论。';
const project = (text = body): NoteItem => ({ id: 'project-1', title: '合成教材', noteType: 'project',
  content: ['用户计划：边界条件是什么。', '<TextbookBoundary id="region-1" edge="start" />', text,
    '<TextbookBoundary id="region-1" edge="end" />', '<LearningReviewBlock id="old-review" />',
    '用户旧复盘：边界条件就是任意猜测，不能作为参考答案。'].join('\n\n'),
  textbook: { schemaVersion: 1, textbookId: 'textbook-1', projectNoteId: 'project-1', rootProjectId: 'project-1',
    revisionId: 'r1', regionId: 'region-1', createdAt: time, updatedAt: time },
  tags: [], links: ['边界条件'], backlinks: [], dueDates: [], createdAt: time, updatedAt: time,
  resources: [{ title: '合成本地资料', url: '', documentId: 'doc-allowed' }, { title: '不可读在线资料', url: 'https://example.invalid/reference' }] });
const knowledge: NoteItem = { ...project(), id: 'knowledge-1', noteType: 'knowledge', title: '边界条件', textbook: undefined,
  content: '边界条件用于限定一个判断在什么情境下成立。', links: [], resources: [] };
const input = (note: NoteItem) => ({ speakingContent: fixture.input.rawText, noteTitle: note.title, noteId: note.id, allNotes: [note, knowledge] });
const target = [{ id: 'T-C-N1', layer: 'concept' as const, nodeIds: ['N1'], query: '边界条件是什么' }];
const hit = (note: NoteItem, snippet: string): TextbookReferenceSearchResult => {
  const text = readTextbookBody(note.content, note.textbook!)!;
  const textStart = text.indexOf(snippet);
  assert.ok(textStart >= 0);
  return { noteId: note.id, textbookId: note.textbook!.textbookId, revisionId: note.textbook!.revisionId,
    title: note.title, score: .9, snippet, chunkId: 'chunk-1', sourceHash: 'a'.repeat(64), textStart,
    textEnd: textStart + snippet.length, sectionPath: '边界条件', sectionKind: 'definition', forcedSplit: false };
};
const documentHit: DocumentSearchResult = { docId: 'doc-allowed', fileName: '合成资料.pdf', chunkId: 'd1', sectionPath: '定义', score: .8,
  snippet: '边界条件限定对象和条件，观察结果不能超出给定范围。' };
let cases = 0;
try {
  const note = project(), snapshot = structuredClone(note);
  let textbookCalls = 0, documentCalls = 0;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: {
    textbookRag: { search: async (query: string, k: number, ids: string[]) => {
      textbookCalls++; assert.equal(query, target[0].query); assert.equal(k, 2); assert.deepEqual(ids, [note.id]);
      return [hit(note, '概念的边界由对象、条件和例外共同确定。')];
    }, rebuild: async () => assert.fail('Searching must not rebuild indexes') },
    ragDocs: { search: async () => { documentCalls++; return [documentHit]; } },
    noteRag: { search: async () => [] },
  } } });
  const indexed = await createFlowReferenceProvider(input(note)).retrieve(fixture.input, fixture.graph, target);
  assert.equal(textbookCalls, 1, 'Default production reader must call the actual textbook IPC client');
  assert.equal(documentCalls, 0, 'A textbook hit prevents unnecessary lower-tier searches');
  assert.ok(indexed.every(candidate => candidate.tier === 1));
  assert.equal(indexed[0].locator, 'chunk-1'); cases++;

  const duplicateTargets = [...target, { ...target[0], id: 'T-R-identical', layer: 'reasoning' as const }];
  let mergedCalls = 0;
  const sharedProvider = createFlowReferenceProvider(input(note), { searchTextbooks: async () => {
    mergedCalls++; return [hit(note, '概念的边界由对象、条件和例外共同确定。')];
  }, searchDocuments: async () => assert.fail('Textbook match prevents lower-tier search') });
  const grouped = await sharedProvider.retrieve(fixture.input, fixture.graph, duplicateTargets);
  assert.equal(mergedCalls, 1, 'Identical claim/argument searches run once');
  assert.deepEqual(grouped.map(c => c.targetId), duplicateTargets.map(t => t.id));
  assert.deepEqual(grouped.map(c => c.relation), ['definition', 'premise'], 'Keep distinct evaluation purposes');
  await sharedProvider.retrieve(fixture.input, fixture.graph, duplicateTargets);
  assert.equal(mergedCalls, 2, 'Never cache across runs/revisions'); cases++;

  for (const unavailable of ['empty', 'throw'] as const) {
    const fallback = await createFlowReferenceProvider(input(note), { searchTextbooks: async () => {
      if (unavailable === 'throw') throw new Error('synthetic_index_unavailable'); return [];
    }, searchDocuments: async () => assert.fail('Managed fallback already has a relevant passage') }).retrieve(fixture.input, fixture.graph, target);
    assert.ok(fallback.some(c => c.text.includes('概念的边界由对象、条件和例外共同确定。')));
    assert.ok(fallback.every(c => !/用户计划|旧复盘|TextbookBoundary|LearningReviewBlock/u.test(c.text)));
    assert.ok(!fallback.some(c => c.tier === 3)); cases++;
  }
  const fresh = hit(note, '概念的边界由对象、条件和例外共同确定。');
  const stale = await createFlowReferenceProvider(input(note), { searchTextbooks: async () => [
    { ...fresh, noteId: 'other-project' }, { ...fresh, revisionId: 'old' }, { ...fresh, textbookId: 'other-book' },
    { ...fresh, snippet: '用户旧复盘', textStart: 0, textEnd: 5 },
  ], searchDocuments: async () => assert.fail('Fallback remains within current managed text') }).retrieve(fixture.input, fixture.graph, target);
  assert.ok(stale.every(c => c.sourceId === note.id && c.locator.startsWith('managed-textbook:'))); cases++;

  const invalid = project(); invalid.content = invalid.content.replace('<TextbookBoundary id="region-1" edge="end" />', '');
  const resource = await createFlowReferenceProvider(input(invalid), {
    searchTextbooks: async () => assert.fail('Invalid body must not authorize reading old textbook index'),
    searchDocuments: async (_query, _k, options) => {
      assert.deepEqual(options, { allowedDocIds: ['doc-allowed'], mode: 'passage', expandGraph: false });
      return [{ ...documentHit, docId: 'other-project-doc' }, documentHit];
    },
  }).retrieve(fixture.input, fixture.graph, target);
  assert.ok(resource.some(c => c.tier === 2 && c.availability === 'available'));
  assert.ok(!resource.some(c => c.tier === 3 || c.sourceId === 'other-project-doc')); cases++;

  const linked = await createFlowReferenceProvider(input(invalid), { searchDocuments: async () => [] }).retrieve(fixture.input, fixture.graph, target);
  assert.ok(linked.some(c => c.tier === 3 && c.text === knowledge.content));
  assert.ok(linked.some(c => c.tier === 2 && c.availability === 'unreadable'));
  assert.ok(!linked.some(c => c.tier === 1 && c.availability === 'available')); cases++;
  const vectorKnowledge = { ...knowledge, content: `## 历史\r\n${'无关的介绍文字。'.repeat(70)}\r\n\r\n## 含义\r\n${knowledge.content}\r\n\r\n## 其他\r\n无关的后文。` };
  const vectorChunk = buildNoteReferenceChunks(vectorKnowledge).find(chunk => chunk.content === knowledge.content)!;
  assert.ok(vectorChunk);
  const vectorHit = { noteId: vectorKnowledge.id, noteType: 'knowledge' as const, title: vectorKnowledge.title,
    score: .8, snippet: vectorChunk.content, evidenceOrigin: 'note-passage' as const,
    passage: { schemaVersion: 2 as const, chunkId: vectorChunk.chunkId, sourceHash: noteReferenceSourceHash(vectorKnowledge),
      sourceUpdatedAt: vectorKnowledge.updatedAt, textStart: vectorChunk.textStart, textEnd: vectorChunk.textEnd,
      sectionPath: vectorChunk.sectionPath, sectionKind: vectorChunk.sectionKind, forcedSplit: vectorChunk.forcedSplit } };
  let scopedKnowledgeCalls = 0;
  const vectorInput = { ...input(invalid), allNotes: [invalid, vectorKnowledge] };
  const vectorRefs = await createFlowReferenceProvider(vectorInput, { searchDocuments: async () => [],
    searchNotes: async (query, k, options) => {
      scopedKnowledgeCalls++; assert.equal(query, target[0].query); assert.equal(k, 2);
      assert.deepEqual(options, { allowedNoteIds: [knowledge.id] });
      return [{ ...vectorHit, noteId: 'foreign-project-knowledge' }, vectorHit];
    } }).retrieve(fixture.input, fixture.graph, target);
  assert.equal(scopedKnowledgeCalls, 1);
  assert.equal(vectorRefs.find(c => c.tier === 3)!.text, knowledge.content);
  assert.ok(vectorRefs.find(c => c.tier === 3)!.locator.includes(vectorChunk.chunkId));
  assert.ok(!vectorRefs.some(c => c.sourceId === 'foreign-project-knowledge' || c.text.includes('无关的介绍'))); cases++;
  const staleKnowledge = await createFlowReferenceProvider(vectorInput, { searchDocuments: async () => [],
    searchNotes: async () => [{ ...vectorHit, snippet: '缓存伪造答案', passage: { ...vectorHit.passage, sourceHash: '0'.repeat(64) } }] })
    .retrieve(fixture.input, fixture.graph, target);
  assert.ok(staleKnowledge.find(c => c.tier === 3)!.locator.startsWith('semantic-fallback:'));
  assert.ok(!staleKnowledge.some(c => c.text.includes('缓存伪造答案'))); cases++;
  const noTextbook = { ...note, textbook: undefined };
  const outside = await createFlowReferenceProvider(input(noTextbook), { searchDocuments: async () => [] }).retrieve(fixture.input, fixture.graph, target);
  assert.ok(!outside.some(c => c.tier === 1 && c.availability === 'available'), 'Unmarked project/recap text is never promoted to textbook evidence'); cases++;
  const placeholder = { ...knowledge, content: '请对该知识点进行定义描述' };
  const absent = await createFlowReferenceProvider({ ...input(invalid), allNotes: [invalid, placeholder] },
    { searchDocuments: async () => [] }).retrieve(fixture.input, fixture.graph, target);
  assert.ok(!absent.some(c => c.availability === 'available')); cases++;

  const large = project('边界条件由对象和条件限定。'.repeat(2500));
  const largeFallback = await createFlowReferenceProvider(input(large), { searchTextbooks: async () => [], searchDocuments: async () => [documentHit] })
    .retrieve(fixture.input, fixture.graph, target);
  assert.ok(!largeFallback.some(c => c.tier === 1 && c.availability === 'available'), 'No full-text lexical scan for a large unavailable textbook index');
  assert.ok(largeFallback.some(c => c.tier === 2 && c.availability === 'available')); cases++;
  const controller = new AbortController();
  await assert.rejects(createFlowReferenceProvider(input(note), { searchTextbooks: async () => { controller.abort(); return []; },
    searchDocuments: async () => assert.fail('Cancelled analysis must not continue retrieval') }).retrieve(fixture.input, fixture.graph, target, controller.signal), /停止/u); cases++;
  assert.deepEqual(note, snapshot, 'All reads preserve notes, indexes and profile data');

  // Exercise the actual production entry through dynamic reference construction and result/save adapters.
  const flowNote = project('蓝印指包裹上的蓝色印记。包裹同时有蓝印且系统联网时进入二号通道；系统离线时，仅凭蓝印不能判断进入二号通道。');
  const flowBody = readTextbookBody(flowNote.content, flowNote.textbook!)!;
  const stages: string[] = [];
  const bundle = await runProductionFlowAnalysisV2({ ...input(flowNote), analysisRunId: 'synthetic-reference-e2e' }, [], undefined, {
    referenceReaders: { searchTextbooks: async () => [hit(flowNote, flowBody)], searchDocuments: async () => assert.fail('Textbook already matched') },
    model: { call: async request => {
      stages.push(request.stage); assert.ok(stages.length <= 2);
      const payload = JSON.parse(request.userInput);
      if (request.stage === 'extract') return { content: JSON.stringify({ protocol: payload.protocol, inputKey: payload.inputKey, graph: fixture.graph }) };
      const assessment = structuredClone(fixture.assessment);
      assessment.behaviorContract = COGNITIVE_EVIDENCE_CONTRACT;
      const cognitive = assessment.behaviors.find(b => b.code === 'uncertainty_calibration')!;
      cognitive.polarity = { negative: [], positive: ['E7'], resolution: 'single_pole' };
      assessment.clarity = { score: 82, comment: '模拟返回，仅验证文本清晰度字段接入。', evidenceIds: ['E1'] };
      assessment.referenceComparisons = payload.referencePacket.targets.map((t: { id: string; layer: 'concept' | 'judgment' | 'reasoning'; nodeIds: string[] }, index: number) => ({
        id: `RC${index + 1}`, targetId: t.id, layer: t.layer, state: 'aligned', level: 3,
        userEvidenceIds: t.nodeIds.map(id => `E${id.slice(1)}`),
        referenceIds: payload.referencePacket.selection.find((s: { targetId: string }) => s.targetId === t.id).itemIds,
        reason: '人工模拟，仅验证参考包版本绑定和数据流，不认证语义准确性。',
      }));
      assert.ok(payload.referencePacket.items.every((r: { text: string }) => !r.text.includes('用户旧复盘')));
      return { content: JSON.stringify({ protocol: payload.protocol, inputKey: payload.inputKey, graphKey: payload.graphKey,
        referenceKey: payload.referenceKey, assessment }) };
    } },
  });
  assert.deepEqual(stages, ['extract', 'assess']);
  assert.equal(bundle.report.clarityScore, 82);
  assert.ok(bundle.analysisV2.record.references.items.every(item => item.tier === 1));
  assert.equal(bundle.argumentDoc.nodes.length, fixture.graph.nodes.length);
  const session: FlowSession = { id: bundle.analysisV2.analysisRunId, noteId: flowNote.id, noteTitle: flowNote.title,
    startedAt: time, endedAt: time, durationSeconds: 60, reviewIntervalMinutes: 0, restateText: fixture.input.rawText };
  const staged = saveFlowReviewRecord(flowNote, session, 'pending_analysis', false);
  const analyzed = finishFlowReviewRecord(staged, session.id, 'analyzed', undefined, bundle.analysisV2.reviewBlockSummary);
  const saved: NoteItem = JSON.parse(JSON.stringify(saveReviewArgument(analyzed, bundle.argumentDoc, session.id)));
  assert.equal(saved.learningReviewRecords?.[0].status, 'completed');
  assert.deepEqual(saved.learningReviewRecords?.[0].argumentDocIds, [bundle.argumentDoc.doc_id]);
  assert.equal(readTextbookBody(saved.content, saved.textbook!), flowBody);
  const signals = extractFlowEvidence({ episodeId: session.id, observedAt: time, report: bundle.report,
    profileInsight: bundle.profileInsight, analysisV2: bundle.analysisV2 }).profileSignals;
  assert.ok(signals.some(s => s.dimension === 'ability') && signals.some(s => s.dimension === 'cognitive_style')); cases++;
  console.log(JSON.stringify({ status: 'PASS', cases, actualProductionEntry: true, injectedModelStages: stages,
    cloudRequests: 0, productionWrites: 0, diskPersistenceTested: false, semanticAccuracy: 'not_tested' }, null, 2));
} finally {
  globalThis.fetch = beforeFetch;
  if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor); else Reflect.deleteProperty(globalThis, 'window');
}
