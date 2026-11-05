import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DocumentChunk } from '../src/types.ts';
import {
  commitKnowledgeBatch,
  deleteKnowledgeDocument,
  ensureKnowledgeJob,
  failKnowledgeBatch,
  getPendingKnowledgeBatch,
  readKnowledgeSettings,
  readKnowledgeStatus,
  readEntityCatalog,
  recoverKnowledgeJobs,
  setKnowledgeDataRoot,
  writeKnowledgeSettings,
} from '../src/electron/rag/knowledgeStore.ts';
import type { RagKnowledgeChunkExtraction } from '../src/types.ts';
import { normalizeEntityKey } from '../src/electron/rag/knowledgeValidation.ts';

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'loginote-knowledge-'));
const testEmbedding = async (text: string): Promise<number[]> => [
  text.includes('实体') ? 1 : 0,
  text.includes('论证') || text.includes('定义') ? 1 : 0,
  Math.min(1, text.length / 100),
];
const chunks: DocumentChunk[] = [
  {
    id: 'doc-1#a-1', docId: 'doc-1', fileName: 'a.md', index: 0, sectionPath: '定义',
    content: '实体是可识别的对象。它可以参与关系。', textStart: 10, textEnd: 30,
    sentenceSpans: [
      { id: 'doc-1#a-1:s1', textStart: 10, textEnd: 20 },
      { id: 'doc-1#a-1:s2', textStart: 20, textEnd: 30 },
    ],
    embedding: [1, 0],
  },
  {
    id: 'doc-1#b-1', docId: 'doc-1', fileName: 'a.md', index: 1, sectionPath: '论证',
    content: '证据支持结论。', textStart: 40, textEnd: 48,
    sentenceSpans: [{ id: 'doc-1#b-1:s1', textStart: 40, textEnd: 48 }],
    embedding: [0, 1],
  },
];

function extraction(chunkId: string): RagKnowledgeChunkExtraction {
  if (chunkId.endsWith('#a-1')) {
    return {
      chunkId,
      entityMentions: [
        { localId: 'm1', surfaceText: '实体', entityType: 'concept', sentenceIds: [`${chunkId}:s1`], aliases: ['可识别的对象'], confidence: 0.92 },
        { localId: 'm2', surfaceText: '对象', entityType: 'concept', sentenceIds: [`${chunkId}:s1`], confidence: 0.69 },
        { localId: 'm3', surfaceText: '关系', entityType: 'concept', sentenceIds: [`${chunkId}:s2`], confidence: 0.91 },
        { localId: 'bad', surfaceText: '原文不存在', entityType: 'concept', sentenceIds: [`${chunkId}:s1`], confidence: 0.99 },
      ],
      entityRelations: [{
        localId: 'r1', subjectMentionId: 'm1', predicate: '是', objectMentionId: 'm2',
        evidenceSentenceIds: [`${chunkId}:s1`], confidence: 0.95,
      }, {
        localId: 'r2', subjectMentionId: 'm1', predicate: '参与', objectMentionId: 'm3',
        evidenceSentenceIds: [`${chunkId}:s1`, `${chunkId}:s2`], statementStatus: 'asserted', confidence: 0.93,
      }],
      argumentUnits: [
        { localId: 'a1', mainType: '定义', sentenceIds: [`${chunkId}:s1`], mentionedEntityMentionIds: ['m1', 'm2'], confidence: 0.9 },
        { localId: 'a2', mainType: '事实陈述', sentenceIds: [`${chunkId}:s2`], confidence: 0.6 },
      ],
      argumentEdges: [{
        localId: 'e1', sourceArgumentId: 'a2', targetArgumentId: 'a1', relation: 'support',
        evidenceSentenceIds: [`${chunkId}:s1`, `${chunkId}:s2`], confidence: 0.9,
      }],
    };
  }
  return { chunkId, entityMentions: [], entityRelations: [], argumentUnits: [], argumentEdges: [] };
}

try {
  assert.equal(normalizeEntityKey('  ＡＩ  '), 'ai');
  setKnowledgeDataRoot(tempRoot);
  await assert.rejects(() => readKnowledgeStatus('../escape'), /docId 非法/u);
  assert.deepEqual(await readKnowledgeSettings(), { enabled: false, processingMode: 'local-only' });
  const disabled = await ensureKnowledgeJob('doc-1', chunks);
  assert.equal(disabled.status, 'disabled');

  await writeKnowledgeSettings({ enabled: true, processingMode: 'local-only' });
  const initial = await ensureKnowledgeJob('doc-1', chunks);
  assert.equal(initial.status, 'pending');
  assert.equal(initial.totalChunks, 2);
  assert.equal(initial.extractorVersion, 4);
  assert.equal(initial.knowledgePromptVersion, 3);

  const firstBatch = await getPendingKnowledgeBatch(['doc-1'], async () => chunks, 2);
  assert.equal(firstBatch.length, 2);
  assert.equal(firstBatch[0].sentences[0].id, 'doc-1#a-1:s1');
  assert.equal(firstBatch[0].sentences[0].text, '实体是可识别的对象。');

  await recoverKnowledgeJobs(['doc-1']);
  const recoveredBatch = await getPendingKnowledgeBatch(['doc-1'], async () => chunks, 2);
  assert.equal(recoveredBatch.length, 2, '进程退出后 processing batch 必须回到 pending');

  const generationId = recoveredBatch[0].generationId;
  await commitKnowledgeBatch({
    docId: 'doc-1', generationId, items: [extraction(recoveredBatch[0].chunkId)],
  }, async () => chunks, testEmbedding);
  const partial = await failKnowledgeBatch('doc-1', generationId, [recoveredBatch[1].chunkId], '模拟单块失败', testEmbedding);
  assert.equal(partial.status, 'partial');
  assert.equal(partial.indexedChunks, 1);
  assert.equal(partial.failedChunks, 1);
  assert.equal(partial.error, '模拟单块失败');

  const activePath = path.join(tempRoot, 'rag-index', 'knowledge-doc-1.json');
  const firstActive = JSON.parse(await readFile(activePath, 'utf-8')) as {
    generationId: string;
    status: string;
    entityMentions: Array<{ surfaceText: string; textStart: number; admission: string }>;
    entityRelations: Array<{ admission: string; statementStatus?: string; embedding?: number[] }>;
    argumentUnits: Array<{ text: string; admission: string; embedding?: number[] }>;
    argumentEdges: Array<{ admission: string }>;
    validationWarnings: string[];
  };
  assert.equal(firstActive.generationId, generationId);
  assert.equal(firstActive.status, 'partial');
  assert.deepEqual(firstActive.entityMentions.map((item) => item.surfaceText), ['实体', '对象', '关系']);
  assert.equal(firstActive.entityMentions[0].textStart, 10, '主进程必须根据 sentence span 回填偏移');
  assert.equal(firstActive.entityMentions[1].admission, 'low_confidence');
  assert.equal(firstActive.entityRelations[0].admission, 'audit_only', '低置信实体不得产生生产关系');
  assert.equal(firstActive.entityRelations[1].admission, 'admitted');
  assert.equal(firstActive.entityRelations[1].statementStatus, 'asserted', '原文陈述性质必须持久化，不等于客观真理核验');
  assert.equal(firstActive.entityRelations[1].embedding?.length, 3);
  assert.equal(firstActive.argumentUnits[0].text, '实体是可识别的对象。');
  assert.equal(firstActive.argumentUnits[1].admission, 'low_confidence');
  assert.equal(firstActive.argumentUnits[0].embedding?.length, 3);
  assert.equal(firstActive.argumentEdges[0].admission, 'audit_only');
  assert.ok(firstActive.validationWarnings.some((warning) => warning.includes('不是证据句的原文子串')));
  const firstCatalog = await readEntityCatalog();
  assert.equal(firstCatalog.entities.length, 2, '只有准入 mention 可进入实体目录');
  const entityCatalogItem = firstCatalog.entities.find((entity) => entity.canonicalName === '实体');
  assert.ok(entityCatalogItem);
  assert.equal(entityCatalogItem!.embedding.length, 3);

  const retried = await ensureKnowledgeJob('doc-1', chunks, true);
  assert.notEqual(retried.generationId, generationId);
  const unchangedActive = JSON.parse(await readFile(activePath, 'utf-8')) as { generationId: string };
  assert.equal(unchangedActive.generationId, generationId, '新 generation 完成前不得覆盖 active shard');
  const retryBatch = await getPendingKnowledgeBatch(['doc-1'], async () => chunks, 4);
  const ready = await commitKnowledgeBatch({
    docId: 'doc-1',
    generationId: retried.generationId || '',
    items: retryBatch.map((item) => extraction(item.chunkId)),
  }, async () => chunks, testEmbedding);
  assert.equal(ready.status, 'ready');
  const switchedActive = JSON.parse(await readFile(activePath, 'utf-8')) as { generationId: string };
  assert.equal(switchedActive.generationId, retried.generationId);
  await assert.rejects(
    () => commitKnowledgeBatch({ docId: 'doc-1', generationId, items: [extraction('doc-1#a-1')] }, async () => chunks, testEmbedding),
    /generation 已过期/u,
  );

  const secondDocChunks: DocumentChunk[] = [{
    id: 'doc-2#c-1', docId: 'doc-2', fileName: 'b.md', index: 0, sectionPath: '定义',
    content: '可识别的对象在模型中出现。', textStart: 0, textEnd: 13,
    sentenceSpans: [{ id: 'doc-2#c-1:s1', textStart: 0, textEnd: 13 }], embedding: [1, 0],
  }];
  const secondJob = await ensureKnowledgeJob('doc-2', secondDocChunks);
  const secondBatch = await getPendingKnowledgeBatch(['doc-2'], async () => secondDocChunks, 1);
  await commitKnowledgeBatch({
    docId: 'doc-2',
    generationId: secondJob.generationId || '',
    items: [{
      chunkId: secondBatch[0].chunkId,
      entityMentions: [{
        localId: 'm1', surfaceText: '可识别的对象', entityType: 'concept', sentenceIds: ['doc-2#c-1:s1'], confidence: 0.9,
      }],
      entityRelations: [], argumentUnits: [], argumentEdges: [],
    }],
  }, async () => secondDocChunks, testEmbedding);
  const crossDocumentCatalog = await readEntityCatalog();
  assert.equal(crossDocumentCatalog.entities.length, 2, '同类型的原文显式别名应聚合为同一实体');
  const mergedEntity = crossDocumentCatalog.entities.find((entity) => entity.docIds.length === 2);
  assert.ok(mergedEntity);
  assert.equal(mergedEntity!.memberEntityIds.length, 2);
  assert.deepEqual(mergedEntity!.docIds, ['doc-1', 'doc-2']);

  await writeKnowledgeSettings({ enabled: false, processingMode: 'allow-cloud' });
  assert.equal((await readKnowledgeStatus('doc-1')).status, 'disabled');
  await deleteKnowledgeDocument('doc-1', testEmbedding);
  assert.equal((await readKnowledgeStatus('doc-1')).totalChunks, 0);
  assert.deepEqual((await readEntityCatalog()).entities[0].docIds, ['doc-2'], '删除 shard 后目录必须可重建');
  await deleteKnowledgeDocument('doc-2', testEmbedding);
  assert.equal((await readEntityCatalog()).entities.length, 0);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

console.log('knowledge store checks passed');
