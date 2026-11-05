import assert from 'node:assert/strict';
import { chunkSemanticText, estimateEmbeddingTokens } from '../src/electron/rag/chunking.ts';
import { cosineSimilarity } from '../src/electron/rag/embedding.ts';
import { buildSearchSnippet } from '../src/electron/rag/snippet.ts';
import { sanitizePdfText } from '../src/electron/pdf.ts';
import { assessArgumentDoc, computeArgumentRevisionHash, createPublishedSnapshot } from '../src/services/argumentDoc/quality.ts';
import { buildArgumentRagText } from '../src/services/argumentDoc/ragText.ts';
import type { ArgDoc } from '../src/services/argumentDoc/types.ts';
import { buildSentenceSpans, buildTextStructuredDocument, sourceBlocksForRange } from '../src/electron/rag/structuredDocument.ts';

const source = [
  '# 第一章',
  '短段一说明实体。',
  '',
  '短段二补充实体之间的关系。',
  '',
  '这是一段很长的论证。'.repeat(80),
  '## 反例',
  '反例会限制主张的适用范围。',
].join('\n');

const chunks = chunkSemanticText(source, { minChars: 40, maxChars: 160, maxEstimatedTokens: 120 });
assert.ok(chunks.length >= 4, '长文本应形成多个规范块');
assert.equal(chunks[0].sectionPath, '第一章');
assert.equal(chunks.at(-1)?.sectionPath, '第一章 > 反例');
for (const [index, chunk] of chunks.entries()) {
  assert.equal(source.slice(chunk.textStart, chunk.textEnd).trim(), chunk.content, '偏移必须可还原正文');
  assert.ok(chunk.content.length <= 160, '字符上限必须生效');
  assert.ok(estimateEmbeddingTokens(chunk.content) <= 120, '估算 token 上限必须生效');
  if (index > 0) {
    assert.ok(chunks[index - 1].textEnd <= chunk.textStart, '规范块之间不得重叠');
  }
}

const longContent = `${'背景材料。'.repeat(80)}关键反例位于这里。${'结论说明。'.repeat(30)}`;
const snippet = buildSearchSnippet(longContent, '关键反例', 120);
assert.match(snippet.text, /关键反例/u);
assert.equal(snippet.hitStart, longContent.indexOf('关键反例'));
assert.ok(snippet.text.length <= 122, '省略号之外应受摘录长度约束');

const sanitized = sanitizePdfText('ＡＢＣ\u3000证据、反例。\u2e80\u0008');
assert.match(sanitized, /^ABC/u, '全角字母应兼容归一');
assert.match(sanitized, /证据.*反例/u, '中文标点附近的正文不得被删除');
assert.ok(sanitized.includes('\u2e80'), '未知但合法的部首字符必须保留');
assert.ok(!sanitized.includes('\u0008'), '控制符必须删除');

assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
assert.equal(cosineSimilarity([1], [1, 0]), 0);

const structuredText = buildTextStructuredDocument('text-doc', '# 标题\n\n第一段证据。\n\n第二段反例。');
assert.equal(structuredText.blocks.length, 3);
assert.equal(structuredText.blocks[1].sectionPath, '标题');
assert.deepEqual(structuredText.blocks[1].locator, { kind: 'text', charStart: 6, charEnd: 12 });
const evidenceStart = structuredText.normalizedText.indexOf('第一段证据');
assert.equal(sourceBlocksForRange(structuredText, evidenceStart, evidenceStart + 3)[0].id, 'text-doc:block:2');
const sentenceChunks = chunkSemanticText('第一句。第二句！第三句？', { minChars: 1, maxChars: 100 });
assert.equal(sentenceChunks.length, 1);
const sentenceSpans = buildSentenceSpans('chunk-1', sentenceChunks[0].content, 25);
assert.deepEqual(sentenceSpans.map((span) => span.id), ['chunk-1:s1', 'chunk-1:s2', 'chunk-1:s3']);
assert.equal(sentenceSpans[0].textStart, 25);
assert.equal(sentenceSpans[2].textEnd, 37);

const argumentDoc: ArgDoc = {
  doc_id: 'doc_test', title: '学习效果论证', created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z', iteration: 1, status: 'draft',
  nodes: [
    { id: 's1', mainType: '定义', text: '间隔练习是在不同时间重复学习。', position: { x: 0, y: 0 }, status: 'ok', issue: null, severity: null, suggestion: null, user_edited: true, collapsed: false },
    { id: 's2', mainType: '事实陈述', text: '多次延迟测验显示间隔练习提高保持率。', position: { x: 0, y: 0 }, status: 'ok', issue: null, severity: null, suggestion: null, user_edited: true, collapsed: false },
    { id: 's3', mainType: '推理', text: '因此复习计划应分散安排，而不是集中突击。', position: { x: 0, y: 0 }, status: 'ok', issue: null, severity: null, suggestion: null, user_edited: true, collapsed: false },
  ],
  edges: [
    { id: 'e1', source: 's1', target: 's3', relation: 'support' },
    { id: 'e2', source: 's2', target: 's3', relation: 'support' },
  ],
};
const assessment = assessArgumentDoc(argumentDoc, '2026-01-01T00:00:00.000Z');
assert.equal(assessment.admission, 'full');
assert.ok(assessment.score >= 80);
assert.equal(assessment.evidenceGrade, 'ungraded');
assert.equal(computeArgumentRevisionHash(argumentDoc), computeArgumentRevisionHash({
  ...argumentDoc,
  nodes: argumentDoc.nodes.map((node) => ({ ...node, position: { x: node.position.x + 100, y: 20 } })),
}), '单纯拖动画布不得改变语义 revision');
assert.equal(buildArgumentRagText(argumentDoc), '', '未由用户发布的草稿不得进入论证 RAG');
argumentDoc.rag = {
  sourceKind: 'user_graph',
  draftAssessment: assessment,
  publishedSnapshot: createPublishedSnapshot(argumentDoc, assessment, '2026-01-01T00:00:00.000Z'),
};
assert.match(buildArgumentRagText(argumentDoc), /间隔练习/u);

const broken = structuredClone(argumentDoc);
broken.nodes[0].text = '';
broken.edges.push({ id: 'e3', source: 'missing', target: 's3', relation: 'support' });
const brokenAssessment = assessArgumentDoc(broken);
assert.equal(brokenAssessment.admission, 'review_required');
assert.ok(brokenAssessment.issues.some((issue) => issue.severity === 'blocker'));

console.log('RAG foundation checks passed');
