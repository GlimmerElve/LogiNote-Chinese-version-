import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { NoteItem, DocumentPreview } from '../src/types';
import type { CognitionFile } from '../src/services/cognition/types';
import type { ReviewEpisodeCapture } from '../src/services/memory/types';
import type { ReviewComparisonAnswer, ReviewComparisonDependencies } from '../src/services/reviewComparison/types';
import { buildReviewComparisonPacket, reviewSnapshotHash, resolveReviewPersonalSnapshot,
  validateReviewPacketCitation, verifyReviewComparisonFreshness } from '../src/services/reviewComparison/packet.ts';
import { prepareReviewComparisonSession, reviewComparisonAnswers, recheckReviewComparisonSession } from '../src/services/reviewComparison/session.ts';
import { normalizeLearningEpisodeFile } from '../src/services/memory/types.ts';

const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('No network in review comparison checks'); };
let checks = 0;
const pass = (name: string) => { checks++; console.log(`PASS ${name}`); };
const at = '2026-10-06T00:00:00.000Z';
const note: NoteItem = { id: 'knowledge-1', title: '选择过载', noteType: 'knowledge',
  content: '当选项难以比较时，比较成本可能增加，并降低满意度。', tags: [], links: [], backlinks: [], dueDates: [], createdAt: at, updatedAt: at };
const project: NoteItem = { ...note, id: 'project-1', noteType: 'project', content: '我的个人项目复述，不是参考。' };
const cognition: CognitionFile = { schemaVersion: 1, revision: 1, records: [{ id: 'r1', docId: 'r1', revisions: [{
  id: 'v1', number: 1, at, operation: 'initial', reason: '', authorship: 'own_expression',
  source: { kind: 'argument_editor', docId: 'r1' }, factSupport: 'not_assessed', mastery: 'not_assessed',
  branches: [{ id: 'b1', kind: 'primary', context: '选项难以比较的情况', stance: 'endorsed', graph: {
    title: '选择过载', nodes: [
      { id: 'n1', text: '选项数量增加。', mainType: '事实陈述' },
      { id: 'n2', text: '比较成本增加。', mainType: '推理' },
      { id: 'n3', text: '预期后悔增加。', mainType: '推理' },
      { id: 'n4', text: '满意度下降。', mainType: '推理' },
      { id: 'isolated', text: '无关孤立观点。', mainType: '假设' },
    ], edges: [
      { id: 'e1', source: 'n1', target: 'n2', relation: 'support' },
      { id: 'e2', source: 'n2', target: 'n3', relation: 'support' },
      { id: 'e3', source: 'n3', target: 'n4', relation: 'support' },
    ],
  } }],
}] }] };
const docText = '某研究发现，当选项相似且难以比较时，选择者的满意度可能下降。';
const preview: DocumentPreview = { document: { id: 'doc1', fileName: '选择研究.txt', fileType: 'txt', extension: '.txt',
  indexable: true, size: 100, status: 'ready', chunkCount: 1, totalChars: docText.length, uploadAt: at,
  knowledgeGenerationId: 'gen1', indexSchemaVersion: 2 },
  chunks: [{ id: 'chunk1', index: 0, sectionPath: '研究结果', content: docText,
    contentLength: docText.length, contentHash: createHash('sha256').update(docText).digest('hex') }], totalChunkCount: 1, truncated: false };
const intent = { version: 1 as const, questionMessageId: 'tutor-1', knowledgeTargets: ['选择过载'],
  cognitionTarget: { recordId: 'r1', revisionId: 'v1', branchId: 'b1', nodeId: 'n4', purpose: 'give_condition' as const } };
const input: ReviewComparisonAnswer = { activityId: 'review-1', questionText: '在什么情况下不成立？',
  evidence: { messageId: 'user-1', answer: '如果选项很容易比较，就未必降低满意度。', hintLevel: 0,
    targetKnowledgeNames: ['选择过载'], questionIntent: intent } };
const scope = { targetScopeNoteIds: [note.id] };
const dependencies: ReviewComparisonDependencies = {
  readNotes: async () => structuredClone([note, project]),
  loadCognition: async () => structuredClone(cognition),
  searchNotes: async () => [{ noteId: project.id, noteType: 'knowledge', title: '伪装的项目', score: 1, snippet: project.content },
    { noteId: note.id, noteType: 'knowledge', title: note.title, score: 1, snippet: '检索缓存不能作为真实正文' }],
  searchDocuments: async () => [{ docId: 'doc1', chunkId: 'chunk1', fileName: '旧缓存标题', snippet: '伪造的缓存片段',
    score: 1, sectionPath: '旧章节', retrievalVersion: 1 },
    { docId: 'doc1', chunkId: 'chunk1', fileName: '重复', snippet: docText, score: 1, sectionPath: '' }],
  previewDocument: async () => structuredClone(preview),
};

try {
  const before = JSON.stringify([note, project, cognition, input]);
  const packet = await buildReviewComparisonPacket(input, dependencies, scope);
  assert.equal(JSON.stringify([note, project, cognition, input]), before);
  assert.equal(packet.references.length, 2);
  assert.deepEqual(packet.references.map((source) => source.sourceId), ['R1', 'R2']);
  assert.equal(packet.references[0].text, note.content);
  assert.equal(packet.references[1].text, docText);
  assert.ok(packet.references.every((source) => source.corpus === 'reference' && source.entityId !== project.id));
  assert.equal(packet.coverage.semanticCoverage, 'not_assessed');
  assert.equal(packet.preparation.mastery, 'pending_alignment');
  pass('双库来源隔离、参考正文回读、资料分块去重，不修改输入或生成分数');

  assert.deepEqual(new Set(packet.personal.graph!.nodes.map((node) => node.id)), new Set(['n1', 'n2', 'n3', 'n4']));
  assert.deepEqual(packet.personal.graph!.edges.map((edge) => edge.id), ['e1', 'e2', 'e3']);
  assert.equal(packet.personal.truncated, false);
  assert.equal(packet.personal.graph!.edges[2].target, 'n4');
  pass('围绕精确坐标展开三跳论证，保留原有边方向，不复制无关孤立节点');

  assert.equal(validateReviewPacketCitation(packet, { corpus: 'answer', quote: '未必降低满意度' }), true);
  assert.equal(validateReviewPacketCitation(packet, { corpus: 'personal', nodeId: 'n2', quote: '比较成本增加' }), true);
  assert.equal(validateReviewPacketCitation(packet, { corpus: 'reference', sourceId: 'R1', quote: '比较成本可能增加' }), true);
  assert.equal(validateReviewPacketCitation(packet, { corpus: 'reference', sourceId: 'r1', quote: '比较成本增加' }), false);
  assert.equal(validateReviewPacketCitation(packet, { corpus: 'reference', sourceId: 'R1', quote: '比较成本必然增加' }), false);
  assert.equal(validateReviewPacketCitation(packet, { corpus: 'answer', quote: note.content }), false);
  pass('逐字引用与来源编号严格核对，个人原话不能充当资料引文');

  assert.equal((await buildReviewComparisonPacket(input, dependencies, scope)).snapshotHash, packet.snapshotHash);
  assert.deepEqual(await verifyReviewComparisonFreshness(packet, dependencies), { fresh: true, reasons: [] });
  const tampered = structuredClone(packet); tampered.answer.text += '模型追加的总结';
  assert.deepEqual(await verifyReviewComparisonFreshness(tampered, dependencies), { fresh: false, reasons: ['packet_changed'] });
  pass('相同快照产生相同标识，回答或资料载荷篡改使快照校验失败');

  const stale = await buildReviewComparisonPacket(input, { ...dependencies, loadCognition: async () => {
    const changed = structuredClone(cognition); changed.records[0].revisions[0].id = 'v2'; return changed;
  } }, scope);
  assert.equal(stale.personal.status, 'stale_target');
  assert.equal(stale.personal.graph, undefined);
  assert.equal(stale.preparation.cognitionGrowth, 'held');
  assert.equal(stale.preparation.mastery, 'pending_alignment');
  pass('个人认知版本过期保持待处理，资料侧可独立准备，不暗中重定向节点');

  const refreshed = await verifyReviewComparisonFreshness(packet, { ...dependencies, loadCognition: async () => {
    const changed = structuredClone(cognition); changed.records[0].revisions[0].branches[0].graph.nodes[0].text += '变更'; return changed;
  } });
  assert.equal(refreshed.fresh, false); assert.ok(refreshed.reasons.includes('personal_snapshot_changed'));
  const noteChanged = await verifyReviewComparisonFreshness(packet, { ...dependencies,
    readNotes: async () => [{ ...note, content: note.content + '内容改变但未更改时间' }] });
  assert.ok(noteChanged.reasons.includes('note_snapshot_changed'));
  pass('模型工作后重读认知分支与笔记完整正文，时间未变化也能发现内容更新');

  const longText = '资料正文'.repeat(400);
  const longPreview = structuredClone(preview);
  longPreview.chunks[0] = { ...longPreview.chunks[0], content: longText.slice(0, 1200), contentLength: longText.length,
    contentHash: createHash('sha256').update(longText).digest('hex') };
  const longDeps = { ...dependencies, previewDocument: async () => structuredClone(longPreview) };
  const longPacket = await buildReviewComparisonPacket(input, longDeps, scope);
  assert.equal(longPacket.references[1].truncated, true);
  const tailChanged = await verifyReviewComparisonFreshness(longPacket, { ...longDeps, previewDocument: async () => {
    const changed = structuredClone(longPreview);
    changed.chunks[0].contentHash = createHash('sha256').update(longText.slice(0, -1) + '改').digest('hex'); return changed;
  } });
  assert.ok(tailChanged.reasons.includes('document_snapshot_changed'));
  const genChanged = await verifyReviewComparisonFreshness(packet, { ...dependencies, previewDocument: async () => {
    const changed = structuredClone(preview); changed.document.knowledgeGenerationId = 'gen2'; return changed;
  } });
  assert.ok(genChanged.reasons.includes('document_snapshot_changed'));
  pass('预览截断明示，资料尾部变化与generation切换均使评估快照过期');

  const noReferences = await buildReviewComparisonPacket(input, { ...dependencies,
    readNotes: async () => [project], searchNotes: async () => [], searchDocuments: async () => [] }, scope);
  assert.equal(noReferences.coverage.referencePresence, 'insufficient_reference');
  assert.equal(noReferences.preparation.mastery, 'held');
  assert.deepEqual(noReferences.references, []);
  assert.equal(noReferences.preparation.cognitionGrowth, 'pending_alignment');
  pass('资料无命中明确不可评估，个人认知不能补足参考覆盖，也不生成负分');

  const legacy = await buildReviewComparisonPacket(input, { ...dependencies, readNotes: async () => [],
    searchNotes: async () => [], previewDocument: async () => {
      const old = structuredClone(preview); delete old.chunks[0].contentHash; delete old.chunks[0].contentLength; return old;
    } }, scope);
  assert.equal(legacy.references.length, 0);
  assert.ok(legacy.preparation.warnings.includes('document_snapshot_unverifiable'));
  const unavailable = await buildReviewComparisonPacket(input, { ...dependencies,
    readNotes: async () => { throw new Error('Storage permission failure'); },
    loadCognition: async () => { throw new Error('Private storage corruption'); } }, scope);
  assert.equal(unavailable.personal.status, 'unavailable');
  assert.equal(unavailable.preparation.mastery, 'held');
  assert.ok(!JSON.stringify(unavailable).includes('Storage permission failure'));
  pass('旧预览缺少完整指纹及读取失败均明确降级，错误载荷不进入资料与摘要');

  const assisted = await buildReviewComparisonPacket({ ...input, evidence: { ...input.evidence, hintLevel: 3,
    consultedMaterialIds: ['resource1'] } }, dependencies, scope);
  assert.equal(assisted.answer.hintLevel, 3);
  assert.deepEqual(assisted.answer.consultedMaterialIds, ['resource1']);
  assert.equal(assisted.preparation.mastery, 'pending_alignment');
  assert.equal('conceptDelta' in assisted, false);
  const materialOnly = await buildReviewComparisonPacket({ ...input, evidence: { ...input.evidence,
    consultedMaterialIds: ['resource1'] } }, dependencies, scope);
  assert.equal(materialOnly.answer.hintLevel, 3, '资料查阅不能被旧提示字段误标为无提示');
  pass('提示依赖保留在同一数据包，尚未对齐时不提前生成正向掌握证据');

  const large = structuredClone(cognition);
  large.records[0].revisions[0].branches[0].graph = {
    title: '长链', nodes: Array.from({ length: 30 }, (_, index) => ({ id: `n${index + 1}`, text: `主张${index}`, mainType: '推理' })),
    edges: Array.from({ length: 30 }, (_, index) => ({ id: `e${index}`, source: `n${index + 1}`, target: `n${(index + 1) % 30 + 1}`, relation: 'support' })),
  };
  const limited = await resolveReviewPersonalSnapshot(large, intent);
  assert.equal(limited.truncated, true); assert.ok(limited.graph!.nodes.length <= 24);
  pass('循环论证遍历终止，图预算截断不伪装为完整论证链');

  const episode: ReviewEpisodeCapture = { id: input.activityId, startedAt: at, endedAt: at, knowledgeContext: '',
    questionText: input.questionText, messages: [
      { id: 'tutor-1', role: 'assistant', content: input.questionText, timestamp: at },
      { id: 'user-1', role: 'user', content: input.evidence.answer, timestamp: at },
    ], answerEvidence: [input.evidence] };
  const session = await prepareReviewComparisonSession(episode, dependencies, scope);
  assert.equal(session.packets.length, 1); assert.equal(session.summary.status, 'partial');
  assert.ok(session.summary.holdReasons.includes('note_reference_semantic_fallback'), 'legacy mock retrieval is explicitly a local semantic fallback');
  assert.equal(session.summary.cognitionTargetsResolved, 1);
  assert.ok(!JSON.stringify(session.summary).includes(input.evidence.answer));
  assert.ok(!JSON.stringify(session.summary).includes(docText));
  const staleSummary = await recheckReviewComparisonSession(session, { ...dependencies, readNotes: async () => [] });
  assert.equal(staleSummary.status, 'partial'); assert.ok(staleSummary.holdReasons.includes('note_snapshot_changed'));
  pass('复习会话真实调用比对包，压缩摘要只有计数与指纹，结束时复核当前来源');

  assert.throws(() => reviewComparisonAnswers({ ...episode, messages: [...episode.messages, episode.messages[1]] }), /重复/);
  assert.throws(() => reviewComparisonAnswers({ ...episode, answerEvidence: [input.evidence, input.evidence] }), /重复/);
  assert.throws(() => reviewComparisonAnswers({ ...episode, answerEvidence: [{ ...input.evidence,
    questionIntent: { ...intent, questionMessageId: 'other-tutor' } }] }), /不匹配/);
  const legacySession = await prepareReviewComparisonSession({ ...episode, answerEvidence: [{ ...input.evidence, questionIntent: undefined }] }, dependencies, scope);
  assert.equal(legacySession.packets.length, 0); assert.equal(legacySession.summary.omittedAnswers, 1);
  pass('重复消息、重复证据、伪造问题归属被拒绝，旧活动不补猜认知坐标');

  const longNote = { ...note, content: '前言。'.repeat(1000) + '\n' + note.content };
  const windowPacket = await buildReviewComparisonPacket({ ...input, questionText: '比较成本可能增加的条件是什么？' },
    { ...dependencies, readNotes: async () => [longNote] }, scope);
  const noteSource = windowPacket.references[0];
  assert.equal(longNote.content.slice(noteSource.textStart, noteSource.textEnd), noteSource.text);
  assert.ok(noteSource.text.includes('比较成本可能增加')); assert.equal(noteSource.truncated, true);
  assert.ok(noteSource.text.length <= 1200, 'legacy retrieval no longer falls back to a 2400-character window');
  assert.equal(noteSource.contentHash, await reviewSnapshotHash({ title: longNote.title, noteType: longNote.noteType, content: longNote.content }));
  pass('长笔记引用窗口定位到原始字符区间，指纹仍覆盖完整正文');

  const stored = normalizeLearningEpisodeFile({ version: 2, episodes: [{
    id: 'review-1', type: 'review', status: 'completed', title: '复习', startedAt: at, endedAt: at, createdAt: at, updatedAt: at,
    comparisonSummary: { ...session.summary, rawPacket: packet, holdReasons: ['no_cognition_target', 'PRIVATE raw text'] },
  }] });
  assert.ok(!JSON.stringify(stored).includes(docText));
  assert.ok(!JSON.stringify(stored).includes(input.evidence.answer));
  assert.ok(!JSON.stringify(stored).includes('PRIVATE'));
  assert.deepEqual(stored.episodes[0].comparisonSummary?.holdReasons, ['no_cognition_target']);
  pass('长期学习事件只采纳摘要允许字段，额外原文载荷与自由文本错误被剥离');

  console.log(`\n${checks} review comparison checks passed.`);
} finally { globalThis.fetch = originalFetch; }
