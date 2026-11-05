import assert from 'node:assert/strict';
import {
  chunkSemanticText,
  chunkStructuredDocument,
  EMBEDDING_VIEW_TOKEN_BUDGET,
  estimateEmbeddingTokens,
  semanticEmbeddingViews,
} from '../src/electron/rag/chunking.ts';
import { buildSentenceSpans, buildStructuredDocument, sourceBlocksForRange } from '../src/electron/rag/structuredDocument.ts';
import { validateKnowledgeExtraction } from '../src/electron/rag/knowledgeValidation.ts';
import type { DocumentChunk, RagKnowledgeChunkExtraction } from '../src/types.ts';

const slices = (text: string) => buildSentenceSpans('c', text, 100, false).map((span) => text.slice(span.textStart - 100, span.textEnd - 100));
assert.equal(buildSentenceSpans('txt', '第一段无句号\n\n第二段无句号', 0).length, 2, 'TXT/Markdown 保留真实段落边界');
assert.deepEqual(slices('结果为 p > 0.180，贡献率 55.513%。下一句。'), ['结果为 p > 0.180，贡献率 55.513%。', '下一句。']);
assert.deepEqual(slices('Dr. P. C. Nemov used e.g. U.S. data. Next result.'), ['Dr. P. C. Nemov used e.g. U.S. data.', 'Next result.']);
assert.deepEqual(slices('不存在心理账\n户效应。下一句！'), ['不存在心理账\n户效应。', '下一句！']);
assert.deepEqual(slices('p > 0.\n180；下一句。'), ['p > 0.\n180；', '下一句。']);
assert.deepEqual(slices('The relationship between the\n\ntwo variables is weak. Next.'), ['The relationship between the\n\ntwo variables is weak.', 'Next.']);
assert.deepEqual(slices('他说：“有依据！”随后说明（见表）。'), ['他说：“有依据！”', '随后说明（见表）。']);

const pdf = buildStructuredDocument('pdf', [
  { text: '研究结果', kind: 'heading', locator: { kind: 'pdf', page: 1 } },
  { text: `${'研究背景'.repeat(48)}心理账`, kind: 'paragraph', locator: { kind: 'pdf', page: 1, bbox: [0, 0, 20, 20] } },
  { text: '户效应不存在。后续结果也不显著。', kind: 'paragraph', locator: { kind: 'pdf', page: 2, bbox: [0, 0, 20, 20] } },
  { text: '局限', kind: 'heading', locator: { kind: 'pdf', page: 2 } },
  { text: '样本有待扩大。', kind: 'paragraph', locator: { kind: 'pdf', page: 2 } },
]);
const pdfChunks = chunkStructuredDocument(pdf);
assert.equal(pdfChunks.length, 2, 'PDF 视觉块达到 minChars 不能截断尚未结束的句子');
assert.match(pdfChunks[0].content, /心理账\n\n户效应/u);
assert.equal(pdfChunks[0].sectionPath, '研究结果');
assert.equal(pdfChunks[1].sectionPath, '局限');
assert.equal(pdfChunks[0].forcedSplit, undefined);
assert.deepEqual(sourceBlocksForRange(pdf, pdfChunks[0].textStart, pdfChunks[0].textEnd).map((b) => b.locator.kind === 'pdf' && b.locator.page), [1, 2]);
for (const chunk of pdfChunks) assert.equal(pdf.normalizedText.slice(chunk.textStart, chunk.textEnd), chunk.content);

const pdfTable = buildStructuredDocument('pdf-table', [
  { text: '表1 实验结果', kind: 'caption', locator: { kind: 'pdf', page: 3, blockIndex: 1 } },
  { text: '| 条件 | 均值 |\n| --- | --- |\n| A | 12 |\n| B | 18 |', kind: 'table',
    locator: { kind: 'pdf', page: 3, tableIndex: 1 } },
  { text: '结果表明B条件的均值更高。', kind: 'paragraph', locator: { kind: 'pdf', page: 3, blockIndex: 2 } },
], { preprocessing: { version: 1, engine: 'test-pdf-projection', rawBlockCount: 3,
  projectedBlockCount: 3, sourceCoverage: 1, issues: [] } });
const tableChunks = chunkStructuredDocument(pdfTable, { maxChars: 30, maxEstimatedTokens: 20 });
assert.equal(tableChunks.length, 2, '表题与表格在本地索引中保持为一个完整对象');
assert.equal(tableChunks[0].content, pdfTable.normalizedText.slice(
  pdfTable.blocks[0].textStart, pdfTable.blocks[1].textEnd));
assert.equal(sourceBlocksForRange(pdfTable, tableChunks[0].textStart, tableChunks[0].textEnd).length, 2);
assert.equal(pdfTable.preprocessing?.engine, 'test-pdf-projection', '分块必须直接消费共用 PDF 预处理投影');

const completeDiscourse = '实验先记录观察结果，然后根据同一条件进行解释。'.repeat(30);
const completeChunks = chunkSemanticText(completeDiscourse);
assert.equal(completeChunks.length, 1, '未超过硬上限的完整论述不应被旧的180字阈值切碎');
const embeddingViews = semanticEmbeddingViews(completeChunks[0].content, '实验结果');
assert.ok(embeddingViews.length > 1, '完整语义块应为本地短上下文模型生成多个向量视图');
assert.ok(embeddingViews.every((view) => estimateEmbeddingTokens(view) <= EMBEDDING_VIEW_TOKEN_BUDGET));

const chinese = '完整的一句话。'.repeat(100);
const packed = chunkSemanticText(chinese, { maxChars: 80, maxEstimatedTokens: 100 });
assert.equal(packed.map((chunk) => chunk.content).join(''), chinese);
assert.ok(packed.every((chunk) => chunk.content.endsWith('。') && !chunk.forcedSplit), '有自然句界时不得硬切或误标为硬切');
const oversized = chunkSemanticText('无标点长句'.repeat(60), { maxChars: 80, maxEstimatedTokens: 60 });
assert.ok(oversized.every((chunk) => chunk.forcedSplit));
assert.ok(oversized.every((chunk) => chunk.content.length <= 80 && estimateEmbeddingTokens(chunk.content) <= 60));
assert.equal(oversized.map((chunk) => chunk.content).join(''), '无标点长句'.repeat(60));

const content = '实验观察到差异。因此推测存在关联。仍需复现实验。';
const chunk: DocumentChunk = { id: 'doc#c', docId: 'doc', fileName: 'test.pdf', index: 0, sectionPath: '', content,
  textStart: 100, textEnd: 100 + content.length, sentenceSpans: buildSentenceSpans('doc#c', content, 100), embedding: [] };
const [s1, s2, s3] = chunk.sentenceSpans!.map((span) => span.id);
const valid: RagKnowledgeChunkExtraction = { chunkId: chunk.id, entityMentions: [], entityRelations: [],
  argumentUnits: [
    { localId: 'a', mainType: '事实陈述', sentenceIds: [s1], confidence: 0.95 },
    { localId: 'b', mainType: '推理', sentenceIds: [s2], confidence: 0.95 },
  ], argumentEdges: [{ localId: 'e', sourceArgumentId: 'a', targetArgumentId: 'b', relation: 'support', evidenceSentenceIds: [s1, s2], confidence: 0.95 }] };
const validate = (value: RagKnowledgeChunkExtraction, input = chunk) => validateKnowledgeExtraction('doc', input, value);
assert.equal(validate(valid).argumentEdges[0].admission, 'admitted');
const missingEvidence = structuredClone(valid);
delete missingEvidence.argumentEdges[0].evidenceSentenceIds;
assert.equal(validate(missingEvidence).argumentEdges.length, 1, '兼容旧的省略字段');
for (const ids of [[], ['unknown'], [s1], Array(13).fill(s1), [s1, 42, s2]]) {
  const candidate = structuredClone(valid);
  candidate.argumentEdges[0].evidenceSentenceIds = ids as string[];
  const result = validate(candidate);
  assert.equal(result.argumentEdges.length, 0);
  assert.match(result.warnings.join(' '), /invalid_evidence|evidence_missing_endpoint/u);
}
const overlap = structuredClone(valid);
overlap.argumentUnits[1].sentenceIds = [s1, s2];
assert.match(validate(overlap).warnings.join(' '), /overlapping_endpoints/u);
assert.equal(validate(overlap).argumentEdges.length, 0);
const nonContiguous = structuredClone(valid);
nonContiguous.argumentUnits[0].sentenceIds = [s1, s3];
assert.match(validate(nonContiguous).warnings.join(' '), /non_contiguous_sentences/u);
assert.match(validate(nonContiguous).warnings.join(' '), /missing_endpoint/u);
const duplicate = structuredClone(valid);
duplicate.argumentUnits[1].sentenceIds = [s1];
assert.equal(validate(duplicate).argumentUnits.length, 1, '同一句不同类型不能重复作为两个论证端点');
const forced = validate(valid, { ...chunk, forcedSplit: true });
assert.ok(forced.argumentUnits.every((unit) => unit.admission === 'low_confidence'));
assert.equal(forced.argumentEdges[0].admission, 'audit_only');
assert.match(forced.warnings.join(' '), /forced_split/u);
console.log('RAG semantic boundary and argument evidence checks passed');
