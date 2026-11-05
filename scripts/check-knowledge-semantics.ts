import assert from 'node:assert/strict';
import type { DocumentChunk, KnowledgeEntityCatalog, RagKnowledgeChunkExtraction } from '../src/types.ts';
import type { KnowledgeShard } from '../src/electron/rag/knowledgeStore.ts';
import { buildSentenceSpans } from '../src/electron/rag/structuredDocument.ts';
import { validateKnowledgeExtraction } from '../src/electron/rag/knowledgeValidation.ts';
import { retrieveKnowledgeSignals } from '../src/electron/rag/knowledgeRetrieval.ts';
import { hasExplicitComparisonTargetMismatch, resolveKnowledgeStatementStatus } from '../src/electron/rag/knowledgeSemantics.ts';
import { DOCUMENT_KNOWLEDGE_EXTRACT_PROMPT } from '../src/workflows/documentKnowledgeExtractPrompt.ts';

assert.equal(resolveKnowledgeStatementStatus('asserted', ['实验目的：探究时间价值感对决策偏好的影响。']), 'research_question');
assert.equal(resolveKnowledgeStatementStatus(undefined, ['We investigate whether X influences Y.']), 'research_question');
assert.equal(resolveKnowledgeStatementStatus('asserted', ['本研究假设X影响Y，尚待证实。']), 'hypothesis');
assert.equal(resolveKnowledgeStatementStatus(undefined, ['在金钱账户下，决策受到局部账户影响。']), 'unspecified');
assert.equal(resolveKnowledgeStatementStatus('asserted', ['结果表明，在金钱账户下，决策受到局部账户影响。']), 'asserted');
assert.equal(resolveKnowledgeStatementStatus('asserted', ['实验验证了在条件B下，X对Y有影响。']), 'asserted', '验证了影响不等于询问是否有影响');
assert.ok(hasExplicitComparisonTargetMismatch('这样的结果与 Duxbury 等(2005)的实验结果并不一致。', 'Leclerc的研究观察到时间账户效应。'));
assert.ok(!hasExplicitComparisonTargetMismatch('这样的结果与 Duxbury 等(2005)的实验结果并不一致。', 'Duxbury 等(2005)的研究未观察到时间账户效应。'));
assert.ok(!hasExplicitComparisonTargetMismatch('实验没有观察到影响。', '在这些条件下，X一定影响Y。'));
assert.match(DOCUMENT_KNOWLEDGE_EXTRACT_PROMPT, /statementStatus/u);
assert.match(DOCUMENT_KNOWLEDGE_EXTRACT_PROMPT, /不生成猜测连线/u);

const text = '实验目的：探究在时间心理账户下，时间价值感对决策偏好的影响。Leclerc的研究观察到时间账户效应。这样的结果与Duxbury等(2005)的实验结果并不一致。';
const chunk: DocumentChunk = { id: 'doc#c', docId: 'doc', fileName: 'test.pdf', index: 0, sectionPath: '',
  content: text, textStart: 0, textEnd: text.length, sentenceSpans: buildSentenceSpans('doc#c', text, 0), embedding: [1, 0] };
const [s1, s2, s3] = chunk.sentenceSpans!.map(s => s.id);
const extraction: RagKnowledgeChunkExtraction = { chunkId: chunk.id,
  entityMentions: [
    { localId: 'm1', surfaceText: '时间价值感', entityType: 'concept', sentenceIds: [s1], confidence: .95 },
    { localId: 'm2', surfaceText: '决策偏好', entityType: 'concept', sentenceIds: [s1], confidence: .95 },
  ],
  entityRelations: [{ localId: 'r', subjectMentionId: 'm1', objectMentionId: 'm2', predicate: '影响',
    qualifiers: ['在时间心理账户下'], statementStatus: 'asserted', evidenceSentenceIds: [s1], confidence: .95 }],
  argumentUnits: [
    { localId: 'a', mainType: '事实陈述', sentenceIds: [s2], confidence: .95 },
    { localId: 'b', mainType: '对比', sentenceIds: [s3], confidence: .95 },
  ],
  argumentEdges: [{ localId: 'bad', sourceArgumentId: 'b', targetArgumentId: 'a', relation: 'oppose',
    evidenceSentenceIds: [s2, s3], confidence: .95 }],
};
const validated = validateKnowledgeExtraction('doc', chunk, extraction);
assert.equal(validated.entityRelations[0].statementStatus, 'research_question', '模型自称 asserted 不能盖过明确研究目的');
assert.equal(validated.argumentEdges[0].admission, 'audit_only', '错指自己的结果只能保留审计');
assert.match(validated.warnings.join('\n'), /comparison_target_mismatch/u);
const invalidStatus = structuredClone(extraction);
invalidStatus.entityRelations[0].statementStatus = 'proven' as never;
assert.equal(validateKnowledgeExtraction('doc', chunk, invalidStatus).entityRelations.length, 0);

const shard: KnowledgeShard = { schemaVersion: 1, docId: 'doc', generationId: 'test', status: 'ready',
  extractorVersion: 3, knowledgePromptVersion: 2, committedChunkIds: [chunk.id], failedChunkIds: [],
  createdAt: '', validationWarnings: [], ...validated };
shard.argumentUnits.forEach(u => { u.embedding = [1, 0]; });
shard.entityRelations[0].embedding = [1, 0];
// Exercise serving-time protection for unmodified legacy shards as well.
delete shard.entityRelations[0].statementStatus;
shard.argumentEdges[0].admission = 'admitted';
const catalog: KnowledgeEntityCatalog = { schemaVersion: 1, generatedAt: '', entities: shard.entityMentions.map(m => ({
  id: m.canonicalEntityId, memberEntityIds: [m.canonicalEntityId], canonicalName: m.surfaceText,
  normalizedKey: m.normalizedKey, entityType: m.entityType, aliases: [], mentionIds: [m.id], docIds: ['doc'], embedding: [1, 0],
})) };
const retrieve = (mode: 'entity' | 'argument') => retrieveKnowledgeSignals({ query: '时间价值感如何影响决策偏好',
  queryEmbedding: [1, 0], chunks: [chunk], catalog, shards: [shard], mode, expandGraph: true }).get(chunk.id)!;
const entity = retrieve('entity');
assert.equal(entity.entityRelations[0].statementStatus, 'research_question');
assert.deepEqual(entity.entityRelations[0].qualifiers, ['在时间心理账户下']);
assert.deepEqual(entity.entityRelations[0].evidenceQuotes, ['实验目的：探究在时间心理账户下，时间价值感对决策偏好的影响。']);
assert.match(entity.relationSummaries.join('\n'), /研究问题，非研究结论/u);
assert.match(entity.relationSummaries.join('\n'), /适用条件：在时间心理账户下/u);
assert.equal(retrieve('argument').argumentEdges.length, 0);
assert.equal(shard.argumentEdges[0].admission, 'admitted', '检索保护不得改写旧索引');

console.log('knowledge semantics checks passed');
