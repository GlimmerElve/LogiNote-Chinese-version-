import assert from 'node:assert/strict';
import { createFlowShadowDemo } from '../src/services/flowShadow/demo.ts';
import {
  adaptShadowRecordToFlowV2, createFlowReferenceProvider, FLOW_REVIEW_ANALYSIS_VERSION,
} from '../src/services/flowAnalysis/productionV2.ts';
import { extractFlowEvidence } from '../src/services/memory/evidenceExtractor.ts';
import {
  finishFlowReviewRecord, saveFlowReviewRecord, saveReviewArgument,
} from '../src/services/textbook/reviewRecordStore.ts';

const record = createFlowShadowDemo();
const bundle = adaptShadowRecordToFlowV2(record, '合成复盘');

assert.equal(bundle.analysisV2.pipeline, FLOW_REVIEW_ANALYSIS_VERSION);
assert.equal(bundle.argumentDoc.nodes.length, record.graph.nodes.length);
assert.ok(bundle.argumentDoc.nodes.every((node) => node.role));
assert.deepEqual(new Set(bundle.argumentDoc.edges.map((edge) => edge.relation)),
  new Set(['support', 'context', 'method_for', 'relates']));
assert.equal(bundle.report.clarityScore, undefined, '历史样例未返回清晰度时不得补造分数；文本清晰度不要求音频');
assert.ok(bundle.report.sections.some((section) => section.kind === 'argumentQuality'));
assert.ok(bundle.analysisV2.reviewBlockSummary.length <= 181);

const evidence = extractFlowEvidence({
  episodeId: record.input.attemptId,
  observedAt: record.input.observedAt,
  report: bundle.report,
  profileInsight: bundle.profileInsight,
  analysisV2: bundle.analysisV2,
});
assert.ok(evidence.profileSignals.some((item) => item.dimension === 'ability'));
assert.ok(evidence.profileSignals.some((item) => item.dimension === 'cognitive_style'));
assert.ok(evidence.profileSignals.some((item) => item.dimension === 'expression_style'));
assert.ok(evidence.profileSignals.every((item) => item.rubricVersion === record.rubricVersion));

const projectNote = {
  id: 'project-note', title: '测试教材', noteType: 'project',
  content: '<TextbookBoundary id="region-1" edge="start" />\n\n概念的边界是对象、条件与适用范围。\n\n观察结果只有在条件成立时才支持结论。\n\n<TextbookBoundary id="region-1" edge="end" />',
  textbook: { schemaVersion: 1, textbookId: 'textbook-1', projectNoteId: 'project-note', rootProjectId: 'project-note',
    revisionId: 'revision-1', regionId: 'region-1', createdAt: record.input.observedAt, updatedAt: record.input.observedAt },
  parentId: null, links: ['边界条件'], resources: [], argumentDocs: [], learningReviewRecords: [],
} as any;
const linkedNote = {
  id: 'knowledge-note', title: '边界条件', noteType: 'knowledge', content: '边界条件用于限定一个判断在什么情境下成立。',
  parentId: null, links: [], resources: [],
} as any;
const references = await createFlowReferenceProvider({
  speakingContent: record.input.rawText, noteTitle: projectNote.title, noteId: projectNote.id,
  analysisRunId: record.input.attemptId, allNotes: [projectNote, linkedNote],
}).retrieve(record.input, record.graph, [{ id: 'T-CHECK', layer: 'concept', nodeIds: ['N1'], query: '边界条件是什么' }]);
assert.ok(references.some((item) => item.tier === 1 && item.availability === 'available'), JSON.stringify(references));
assert.ok(!references.some((item) => item.tier === 3 && item.availability === 'available'),
  '教材已命中时不应再把其生成来源知识点重复塞入同一参考包');

const session = {
  id: record.input.attemptId, noteId: projectNote.id, rootProjectId: projectNote.id,
  noteTitle: projectNote.title, startedAt: record.input.observedAt, endedAt: record.input.observedAt,
  restateText: record.input.rawText, incrementalText: record.input.rawText, summary: '复盘摘要', questions: [],
} as any;
const staged = saveFlowReviewRecord(projectNote, session, 'pending_analysis', false);
const analyzed = finishFlowReviewRecord(staged, session.id, 'analyzed', undefined, bundle.analysisV2.reviewBlockSummary);
const persisted = saveReviewArgument(analyzed, bundle.argumentDoc, session.id);
const persistedReview = persisted.learningReviewRecords?.find((item: any) => item.sessionId === session.id);
assert.ok(persisted.content.includes(`<LearningReviewBlock id="${session.id}" />`));
assert.equal(persistedReview?.analysisSummary, bundle.analysisV2.reviewBlockSummary);
assert.deepEqual(persistedReview?.argumentDocIds, [bundle.argumentDoc.doc_id]);
assert.ok(persisted.argumentDocs?.some((item: any) => item.doc_id === bundle.argumentDoc.doc_id));

console.log(JSON.stringify({
  pipeline: bundle.analysisV2.pipeline,
  nodes: bundle.argumentDoc.nodes.length,
  edges: bundle.argumentDoc.edges.length,
  relationKinds: [...new Set(bundle.argumentDoc.edges.map((edge) => edge.relation))],
  profileSignals: evidence.profileSignals.length,
  referenceTiers: [...new Set(references.map((item) => item.tier))],
  persistedReviewGraph: persistedReview?.argumentDocIds[0],
  reviewBlockSummary: bundle.analysisV2.reviewBlockSummary,
}, null, 2));
