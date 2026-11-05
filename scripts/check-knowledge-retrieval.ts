import assert from 'node:assert/strict';
import type { DocumentChunk, KnowledgeEntityCatalog } from '../src/types.ts';
import type { KnowledgeShard } from '../src/electron/rag/knowledgeStore.ts';
import {
  classifyDocumentQueryIntent,
  fuseKnowledgeChannelRanks,
  retrieveKnowledgeSignals,
  retrievalWeights,
} from '../src/electron/rag/knowledgeRetrieval.ts';

const chunk: DocumentChunk = {
  id: 'doc-1#chunk', docId: 'doc-1', fileName: 'test.md', index: 0, sectionPath: '论证',
  content: '实体A会影响实体B。原因支持结论。', embedding: [0.5, 0.5],
};
const catalog: KnowledgeEntityCatalog = {
  schemaVersion: 1,
  generatedAt: '2026-10-01T00:00:00.000Z',
  entities: [
    {
      id: 'entity:a', memberEntityIds: ['entity:a'], canonicalName: '实体A', normalizedKey: '实体a',
      entityType: 'concept', aliases: [], mentionIds: ['m-a'], docIds: ['doc-1'], embedding: [1, 0],
    },
    {
      id: 'entity:b', memberEntityIds: ['entity:b'], canonicalName: '实体B', normalizedKey: '实体b',
      entityType: 'concept', aliases: [], mentionIds: ['m-b'], docIds: ['doc-1'], embedding: [0, 1],
    },
  ],
};
const shard: KnowledgeShard = {
  schemaVersion: 1,
  docId: 'doc-1',
  generationId: 'kg-test',
  status: 'ready',
  extractorVersion: 2,
  knowledgePromptVersion: 1,
  committedChunkIds: [chunk.id],
  failedChunkIds: [],
  createdAt: '2026-10-01T00:00:00.000Z',
  validationWarnings: [],
  entityMentions: [
    {
      id: 'm-a', docId: 'doc-1', chunkId: chunk.id, sentenceIds: ['s1'], surfaceText: '实体A',
      normalizedKey: '实体a', entityType: 'concept', canonicalEntityId: 'entity:a', textStart: 0, textEnd: 3,
      aliases: [], confidence: 0.95, admission: 'admitted',
    },
    {
      id: 'm-b', docId: 'doc-1', chunkId: chunk.id, sentenceIds: ['s1'], surfaceText: '实体B',
      normalizedKey: '实体b', entityType: 'concept', canonicalEntityId: 'entity:b', textStart: 6, textEnd: 9,
      aliases: [], confidence: 0.94, admission: 'admitted',
    },
  ],
  entityRelations: [{
    id: 'rel-1', docId: 'doc-1', chunkId: chunk.id, subjectEntityId: 'entity:a', objectEntityId: 'entity:b',
    predicate: '影响', qualifiers: [], evidenceSentenceIds: ['s1'], confidence: 0.9, admission: 'admitted', embedding: [0.8, 0.2],
  }],
  argumentUnits: [
    {
      id: 'arg-reason', docId: 'doc-1', chunkId: chunk.id, sentenceIds: ['s2'], mainType: '推理', layer: 'logic',
      textStart: 10, textEnd: 12, text: '原因', mentionedEntityIds: [], confidence: 0.9,
      origin: 'imported-document-extraction', admission: 'admitted', embedding: [1, 0],
    },
    {
      id: 'arg-conclusion', docId: 'doc-1', chunkId: chunk.id, sentenceIds: ['s2'], mainType: '事实陈述', layer: 'judgment',
      textStart: 14, textEnd: 16, text: '结论', mentionedEntityIds: [], confidence: 0.9,
      origin: 'imported-document-extraction', admission: 'admitted', embedding: [0, 1],
    },
  ],
  argumentEdges: [{
    id: 'edge-1', docId: 'doc-1', chunkId: chunk.id, sourceArgumentId: 'arg-reason', targetArgumentId: 'arg-conclusion',
    relation: 'support', evidenceSentenceIds: ['s2'], confidence: 0.9, admission: 'admitted',
  }],
};

assert.equal(classifyDocumentQueryIntent('为什么会得到这个结论？'), 'reason');
assert.equal(classifyDocumentQueryIntent('有什么反例会削弱该主张？'), 'opposition');
assert.equal(classifyDocumentQueryIntent('实体A和实体B是什么关系？'), 'entity_relation');
assert.ok(retrievalWeights('reason').argument > retrievalWeights('reason').entity);
assert.ok(retrievalWeights('entity_relation').entity > retrievalWeights('entity_relation').passage);
const fusedReason = fuseKnowledgeChannelRanks(
  { passage: ['passage-only', 'shared'], entity: ['entity-only'], argument: ['shared', 'argument-only'] },
  retrievalWeights('reason'),
);
assert.ok((fusedReason.get('shared') || 0) > (fusedReason.get('passage-only') || 0));

const entitySignals = retrieveKnowledgeSignals({
  query: '实体A', queryEmbedding: [1, 0], chunks: [chunk], catalog, shards: [shard], mode: 'entity', expandGraph: true,
});
const entitySignal = entitySignals.get(chunk.id);
assert.ok(entitySignal);
assert.ok(entitySignal!.entities.some((entity) => entity.entityId === 'entity:a' && entity.match === 'direct'));
assert.ok(entitySignal!.entities.some((entity) => entity.entityId === 'entity:b'));
assert.equal(entitySignal!.entityRelations[0].direction, 'outgoing');
assert.match(entitySignal!.relationSummaries.join(' '), /实体A 影响 实体B/u);
const directRelationSignals = retrieveKnowledgeSignals({
  query: '实体A与实体B的关系', queryEmbedding: [0.8, 0.2], chunks: [chunk], catalog, shards: [shard], mode: 'entity', expandGraph: true,
});
assert.equal(directRelationSignals.get(chunk.id)!.entityRelations[0].direction, 'direct');

const argumentSignals = retrieveKnowledgeSignals({
  query: '原因', queryEmbedding: [1, 0], chunks: [chunk], catalog, shards: [shard], mode: 'argument', expandGraph: true,
});
const argumentSignal = argumentSignals.get(chunk.id);
assert.ok(argumentSignal);
assert.ok(argumentSignal!.arguments.some((argument) => argument.argumentId === 'arg-reason' && argument.match === 'direct'));
assert.ok(argumentSignal!.arguments.some((argument) => argument.argumentId === 'arg-conclusion' && argument.match === 'expanded'));
assert.equal(argumentSignal!.argumentEdges[0].direction, 'supports');

const reverseSignals = retrieveKnowledgeSignals({
  query: '结论', queryEmbedding: [0, 1], chunks: [chunk], catalog, shards: [shard], mode: 'argument', expandGraph: true,
});
assert.ok(reverseSignals.get(chunk.id)!.argumentEdges.some((edge) => edge.direction === 'supported_by'));

const opposeShard = structuredClone(shard);
opposeShard.argumentEdges[0] = { ...opposeShard.argumentEdges[0], id: 'edge-oppose', relation: 'oppose' };
const opposeForward = retrieveKnowledgeSignals({
  query: '原因', queryEmbedding: [1, 0], chunks: [chunk], catalog, shards: [opposeShard], mode: 'argument', expandGraph: true,
});
assert.ok(opposeForward.get(chunk.id)!.argumentEdges.some((edge) => edge.direction === 'opposes'));
const opposeReverse = retrieveKnowledgeSignals({
  query: '结论', queryEmbedding: [0, 1], chunks: [chunk], catalog, shards: [opposeShard], mode: 'argument', expandGraph: true,
});
assert.ok(opposeReverse.get(chunk.id)!.argumentEdges.some((edge) => edge.direction === 'opposed_by'));

console.log('knowledge retrieval checks passed');
