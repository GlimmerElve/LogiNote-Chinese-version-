import type {
  CanonicalKnowledgeEntity,
  DocumentChunk,
  DocumentQueryIntent,
  KnowledgeArgumentEdge,
  KnowledgeArgumentEdgeHit,
  KnowledgeArgumentHit,
  KnowledgeArgumentUnit,
  KnowledgeEntityCatalog,
  KnowledgeEntityHit,
  KnowledgeEntityMention,
  KnowledgeEntityRelation,
  KnowledgeEntityRelationHit,
} from '../../types.ts';
import { buildDf, bm25Score, tokenize, weightedFusion } from '../hybridSearch.ts';
import { cosineSimilarity } from './embedding.ts';
import type { KnowledgeShard } from './knowledgeStore.ts';
import { hasExplicitComparisonTargetMismatch, knowledgeRelationSummary, resolveKnowledgeStatementStatus } from './knowledgeSemantics.ts';
import { retrievalQueryIntent } from '../../services/agent/documentRetrievalPolicy.ts';

export const KNOWLEDGE_RETRIEVAL_VERSION = 2;

export interface RetrievalChannelWeights {
  passage: number;
  entity: number;
  argument: number;
}

/** 生产默认权重。评测脚本直接读取同一份配置，避免测试参数与线上参数漂移。 */
export const DEFAULT_RETRIEVAL_WEIGHT_PROFILE: Record<DocumentQueryIntent, RetrievalChannelWeights> = {
  definition: { passage: 0.35, entity: 0.50, argument: 0.15 },
  fact: { passage: 0.55, entity: 0.30, argument: 0.15 },
  entity_relation: { passage: 0.25, entity: 0.60, argument: 0.15 },
  reason: { passage: 0.35, entity: 0.15, argument: 0.50 },
  support: { passage: 0.25, entity: 0.15, argument: 0.60 },
  opposition: { passage: 0.25, entity: 0.15, argument: 0.60 },
  comparison: { passage: 0.30, entity: 0.40, argument: 0.30 },
  application: { passage: 0.45, entity: 0.20, argument: 0.35 },
  general: { passage: 0.50, entity: 0.25, argument: 0.25 },
};

export interface KnowledgeChunkSignal {
  chunkId: string;
  entityScore: number;
  argumentScore: number;
  entities: KnowledgeEntityHit[];
  entityRelations: KnowledgeEntityRelationHit[];
  arguments: KnowledgeArgumentHit[];
  argumentEdges: KnowledgeArgumentEdgeHit[];
  relationSummaries: string[];
}

interface RankedRecord<T> {
  record: T;
  score: number;
}

export function classifyDocumentQueryIntent(query: string): DocumentQueryIntent {
  return retrievalQueryIntent(query);
}

/** Frozen baseline for host-only retrieval ablations. */
export function classifyDocumentQueryIntentLegacy(query: string): DocumentQueryIntent {
  const value = String(query || '').toLocaleLowerCase();
  if (/(反例|反对|削弱|质疑|局限|缺陷|oppose|counterexample|objection)/u.test(value)) return 'opposition';
  if (/(支持|依据|证据|论据|证明|支撑|support|evidence)/u.test(value)) return 'support';
  if (/(为什么|为何|原因|缘由|因果|怎么会|why|because|reason)/u.test(value)) return 'reason';
  if (/(区别|差异|异同|对比|比较|相比|versus|\bvs\.?\b|compare)/u.test(value)) return 'comparison';
  if (/(关系|关联|联系|属于|包含|组成|依赖|影响|relation|related)/u.test(value)) return 'entity_relation';
  if (/(什么是|何谓|定义|含义|概念|define|definition|meaning)/u.test(value)) return 'definition';
  if (/(如何|怎么做|怎样|应用|实践|步骤|方案|用法|apply|application|how to)/u.test(value)) return 'application';
  if (/(是否|何时|多少|哪一|事实|数据|fact|when|where|which)/u.test(value)) return 'fact';
  return 'general';
}

export function retrievalWeights(intent: DocumentQueryIntent): RetrievalChannelWeights {
  return { ...DEFAULT_RETRIEVAL_WEIGHT_PROFILE[intent] };
}

export function fuseKnowledgeChannelRanks(
  channels: { passage: string[]; entity: string[]; argument: string[] },
  weights: RetrievalChannelWeights,
  rankConstant = 60,
): Map<string, number> {
  const scores = new Map<string, number>();
  (Object.keys(channels) as Array<keyof typeof channels>).forEach((channel) => {
    channels[channel].forEach((id, index) => {
      scores.set(id, (scores.get(id) || 0) + weights[channel] / (rankConstant + index + 1));
    });
  });
  return scores;
}

function hybridRank<T>(
  records: T[],
  getId: (record: T) => string,
  getText: (record: T) => string,
  getEmbedding: (record: T) => number[] | undefined,
  query: string,
  queryEmbedding: number[],
  limit: number,
): RankedRecord<T>[] {
  if (records.length === 0) return [];
  const texts = records.map(getText);
  const queryTokens = tokenize(query);
  const df = buildDf(texts);
  const lengths = texts.map((text) => Math.max(1, tokenize(text).length));
  const avgLength = lengths.reduce((sum, value) => sum + value, 0) / Math.max(1, lengths.length);
  const candidates = records.map((record, index) => {
    const embedding = getEmbedding(record) || [];
    return {
      record,
      id: getId(record),
      text: texts[index],
      dense: Math.max(0, cosineSimilarity(queryEmbedding, embedding)),
      sparse: bm25Score(queryTokens, texts[index], df, records.length, avgLength),
    };
  }).filter((item) => item.dense >= 0.25 || item.sparse > 0);
  const fused = weightedFusion(candidates.map((item) => ({ id: item.id, dense: item.dense, sparse: item.sparse })), 0.40);
  const compact = query.replace(/\s+/gu, '').toLocaleLowerCase();
  return candidates
    .map((item) => ({
      record: item.record,
      score: Math.min(1, Math.max(0, (fused.get(item.id) || 0)
        + (compact.length >= 2 && item.text.replace(/\s+/gu, '').toLocaleLowerCase().includes(compact) ? 0.25 : 0))),
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

function signalFor(map: Map<string, KnowledgeChunkSignal>, chunkId: string): KnowledgeChunkSignal {
  let signal = map.get(chunkId);
  if (!signal) {
    signal = {
      chunkId,
      entityScore: 0,
      argumentScore: 0,
      entities: [],
      entityRelations: [],
      arguments: [],
      argumentEdges: [],
      relationSummaries: [],
    };
    map.set(chunkId, signal);
  }
  return signal;
}

function addEntity(signal: KnowledgeChunkSignal, entity: KnowledgeEntityHit): void {
  const existing = signal.entities.find((item) => item.entityId === entity.entityId);
  if (!existing) signal.entities.push(entity);
  else if (entity.match === 'direct' || entity.score > existing.score) Object.assign(existing, entity);
}

function addEntityRelation(signal: KnowledgeChunkSignal, relation: KnowledgeEntityRelationHit): void {
  const existing = signal.entityRelations.find((item) => item.relationId === relation.relationId);
  if (!existing) signal.entityRelations.push(relation);
  else if (relation.direction === 'direct') Object.assign(existing, relation);
}

function addArgument(signal: KnowledgeChunkSignal, argument: KnowledgeArgumentHit): void {
  const existing = signal.arguments.find((item) => item.argumentId === argument.argumentId);
  if (!existing) signal.arguments.push(argument);
  else if (argument.match === 'direct' || argument.confidence > existing.confidence) Object.assign(existing, argument);
}

function addArgumentEdge(signal: KnowledgeChunkSignal, edge: KnowledgeArgumentEdgeHit): void {
  if (!signal.argumentEdges.some((item) => item.edgeId === edge.edgeId && item.direction === edge.direction)) signal.argumentEdges.push(edge);
}

function addSummary(signal: KnowledgeChunkSignal, summary: string): void {
  if (summary && !signal.relationSummaries.includes(summary)) signal.relationSummaries.push(summary);
}

function admittedMentions(shards: KnowledgeShard[]): KnowledgeEntityMention[] {
  return shards.flatMap((shard) => shard.entityMentions).filter((mention) => mention.admission === 'admitted');
}

function admittedRelations(shards: KnowledgeShard[]): KnowledgeEntityRelation[] {
  return shards.flatMap((shard) => shard.entityRelations).filter((relation) => relation.admission === 'admitted');
}

function admittedUnits(shards: KnowledgeShard[]): KnowledgeArgumentUnit[] {
  return shards.flatMap((shard) => shard.argumentUnits).filter((unit) => unit.admission === 'admitted' && !!unit.embedding?.length);
}

function admittedEdges(shards: KnowledgeShard[]): KnowledgeArgumentEdge[] {
  return shards.flatMap((shard) => shard.argumentEdges).filter((edge) => edge.admission === 'admitted');
}

function entityResolver(catalog: KnowledgeEntityCatalog): {
  memberToEntity: Map<string, CanonicalKnowledgeEntity>;
} {
  const memberToEntity = new Map<string, CanonicalKnowledgeEntity>();
  for (const entity of catalog.entities) {
    for (const memberId of entity.memberEntityIds || [entity.id]) memberToEntity.set(memberId, entity);
  }
  return { memberToEntity };
}

function relationHit(
  relation: KnowledgeEntityRelation,
  subject: CanonicalKnowledgeEntity,
  object: CanonicalKnowledgeEntity,
  direction: KnowledgeEntityRelationHit['direction'],
  chunk: DocumentChunk | undefined,
): KnowledgeEntityRelationHit {
  const evidenceQuotes = relation.evidenceSentenceIds.flatMap((id) => {
    const span = chunk?.sentenceSpans?.find((sentence) => sentence.id === id);
    return span && chunk ? [chunk.content.slice(span.textStart - (chunk.textStart || 0), span.textEnd - (chunk.textStart || 0))] : [];
  });
  return {
    relationId: relation.id,
    subjectEntityId: subject.id,
    subjectName: subject.canonicalName,
    predicate: relation.predicate,
    objectEntityId: object.id,
    objectName: object.canonicalName,
    confidence: relation.confidence,
    qualifiers: [...(relation.qualifiers || [])],
    statementStatus: resolveKnowledgeStatementStatus(relation.statementStatus, evidenceQuotes),
    evidenceQuotes,
    evidenceSentenceIds: relation.evidenceSentenceIds,
    direction,
  };
}

function relationSummary(hit: KnowledgeEntityRelationHit): string {
  return knowledgeRelationSummary({ subject: hit.subjectName, predicate: hit.predicate, object: hit.objectName,
    qualifiers: hit.qualifiers || [], statementStatus: hit.statementStatus || 'unspecified' });
}

/** 显式文档范围的名称/别名也只取范围内 mention，避免全库别名混入教材引用。 */
export function scopeKnowledgeCatalog(catalog: KnowledgeEntityCatalog, shards: KnowledgeShard[]): KnowledgeEntityCatalog {
  const mentions = admittedMentions(shards);
  return { ...catalog, entities: catalog.entities.flatMap((entity) => {
    const memberIds = new Set(entity.memberEntityIds || [entity.id]);
    const local = mentions.filter((mention) => memberIds.has(mention.canonicalEntityId));
    if (!local.length) return [];
    const names = [...new Set(local.flatMap((mention) => [mention.surfaceText, ...mention.aliases]))].filter(Boolean).sort();
    const canonicalName = names.includes(entity.canonicalName) ? entity.canonicalName : local[0].surfaceText;
    return [{ ...entity, canonicalName, aliases: names.filter((name) => name !== canonicalName),
      memberEntityIds: [...new Set(local.map((mention) => mention.canonicalEntityId))],
      mentionIds: local.map((mention) => mention.id), docIds: [...new Set(local.map((mention) => mention.docId))] }];
  }) };
}

export function retrieveKnowledgeSignals(input: {
  query: string;
  queryEmbedding: number[];
  chunks: DocumentChunk[];
  catalog: KnowledgeEntityCatalog;
  shards: KnowledgeShard[];
  mode: 'auto' | 'entity' | 'argument';
  expandGraph: boolean;
  queryIntent?: DocumentQueryIntent;
}): Map<string, KnowledgeChunkSignal> {
  const signals = new Map<string, KnowledgeChunkSignal>();
  const chunkIds = new Set(input.chunks.map((chunk) => chunk.id));
  const chunkById = new Map(input.chunks.map((chunk) => [chunk.id, chunk]));
  const mentions = admittedMentions(input.shards).filter((mention) => chunkIds.has(mention.chunkId));
  const relations = admittedRelations(input.shards).filter((relation) => chunkIds.has(relation.chunkId));
  const units = admittedUnits(input.shards).filter((unit) => chunkIds.has(unit.chunkId));
  const unitByIdForAdmission = new Map(units.map((unit) => [unit.id, unit]));
  // Legacy shards are read-only: suppress the known bad comparison shape at serving time too.
  const edges = admittedEdges(input.shards).filter((edge) => {
    const source = unitByIdForAdmission.get(edge.sourceArgumentId), target = unitByIdForAdmission.get(edge.targetArgumentId);
    return chunkIds.has(edge.chunkId) && !!source && !!target
      && !(edge.relation === 'oppose' && hasExplicitComparisonTargetMismatch(source.text, target.text));
  });
  const { memberToEntity } = entityResolver(input.catalog);
  const mentionsByEntity = new Map<string, KnowledgeEntityMention[]>();
  for (const mention of mentions) {
    const entity = memberToEntity.get(mention.canonicalEntityId);
    if (!entity) continue;
    mentionsByEntity.set(entity.id, [...(mentionsByEntity.get(entity.id) || []), mention]);
  }

  if (input.mode === 'auto' || input.mode === 'entity') {
    const directEntities = hybridRank(
      input.catalog.entities.filter((entity) => entity.embedding?.length),
      (entity) => entity.id,
      (entity) => [entity.canonicalName, ...entity.aliases].join(' '),
      (entity) => entity.embedding,
      input.query,
      input.queryEmbedding,
      12,
    );
    for (const { record: entity, score } of directEntities) {
      for (const mention of mentionsByEntity.get(entity.id) || []) {
        const signal = signalFor(signals, mention.chunkId);
        signal.entityScore = Math.max(signal.entityScore, score);
        addEntity(signal, {
          entityId: entity.id, canonicalName: entity.canonicalName, entityType: entity.entityType,
          match: 'direct', score,
        });
      }
      if (!input.expandGraph) continue;
      const memberIds = new Set(entity.memberEntityIds || [entity.id]);
      const neighbors = relations
        .filter((relation) => memberIds.has(relation.subjectEntityId) || memberIds.has(relation.objectEntityId))
        .sort((left, right) => right.confidence - left.confidence)
        .slice(0, 8);
      for (const relation of neighbors) {
        const outgoing = memberIds.has(relation.subjectEntityId);
        const subject = memberToEntity.get(relation.subjectEntityId);
        const object = memberToEntity.get(relation.objectEntityId);
        if (!subject || !object || subject.id === object.id) continue;
        const neighbor = outgoing ? object : subject;
        const expandedScore = Math.min(1, score * relation.confidence * 0.72);
        const signal = signalFor(signals, relation.chunkId);
        signal.entityScore = Math.max(signal.entityScore, expandedScore);
        addEntity(signal, {
          entityId: neighbor.id, canonicalName: neighbor.canonicalName, entityType: neighbor.entityType,
          match: 'expanded', score: expandedScore,
        });
        const hit = relationHit(relation, subject, object, outgoing ? 'outgoing' : 'incoming', chunkById.get(relation.chunkId));
        addEntityRelation(signal, hit);
        addSummary(signal, relationSummary(hit));
      }
    }

    const relationRecords = relations.flatMap((relation) => {
      const subject = memberToEntity.get(relation.subjectEntityId);
      const object = memberToEntity.get(relation.objectEntityId);
      return subject && object && subject.id !== object.id ? [{ relation, subject, object }] : [];
    });
    const queryIntent = input.queryIntent || classifyDocumentQueryIntent(input.query);
    const directRelations = queryIntent === 'entity_relation' || queryIntent === 'comparison'
      ? hybridRank(
          relationRecords,
          (item) => item.relation.id,
          (item) => `${item.subject.canonicalName} ${item.relation.predicate} ${item.object.canonicalName} ${item.relation.qualifiers.join(' ')}`,
          (item) => item.relation.embedding,
          input.query,
          input.queryEmbedding,
          12,
        )
      : [];
    for (const { record: item, score } of directRelations) {
      const signal = signalFor(signals, item.relation.chunkId);
      signal.entityScore = Math.max(signal.entityScore, score);
      const hit = relationHit(item.relation, item.subject, item.object, 'direct', chunkById.get(item.relation.chunkId));
      addEntityRelation(signal, hit);
      addEntity(signal, { entityId: item.subject.id, canonicalName: item.subject.canonicalName, entityType: item.subject.entityType, match: 'direct', score });
      addEntity(signal, { entityId: item.object.id, canonicalName: item.object.canonicalName, entityType: item.object.entityType, match: 'direct', score });
      addSummary(signal, relationSummary(hit));
    }
  }

  if (input.mode === 'auto' || input.mode === 'argument') {
    const unitById = new Map(units.map((unit) => [unit.id, unit]));
    const directUnits = hybridRank(
      units,
      (unit) => unit.id,
      (unit) => `${unit.mainType} ${unit.text}`,
      (unit) => unit.embedding,
      input.query,
      input.queryEmbedding,
      16,
    );
    for (const { record: unit, score } of directUnits) {
      const signal = signalFor(signals, unit.chunkId);
      signal.argumentScore = Math.max(signal.argumentScore, score);
      addArgument(signal, {
        argumentId: unit.id, mainType: unit.mainType, text: unit.text, confidence: unit.confidence,
        origin: unit.origin, admission: 'admitted', match: 'direct',
      });
      if (!input.expandGraph) continue;
      const neighbors = edges
        .filter((edge) => edge.sourceArgumentId === unit.id || edge.targetArgumentId === unit.id)
        .sort((left, right) => right.confidence - left.confidence)
        .slice(0, 4);
      for (const edge of neighbors) {
        const seedIsSource = edge.sourceArgumentId === unit.id;
        const neighbor = unitById.get(seedIsSource ? edge.targetArgumentId : edge.sourceArgumentId);
        if (!neighbor) continue;
        const expandedScore = Math.min(1, score * edge.confidence * 0.70);
        const neighborSignal = signalFor(signals, neighbor.chunkId);
        neighborSignal.argumentScore = Math.max(neighborSignal.argumentScore, expandedScore);
        addArgument(neighborSignal, {
          argumentId: neighbor.id, mainType: neighbor.mainType, text: neighbor.text, confidence: neighbor.confidence,
          origin: neighbor.origin, admission: 'admitted', match: 'expanded',
        });
        const direction: KnowledgeArgumentEdgeHit['direction'] = edge.relation === 'support'
          ? (seedIsSource ? 'supports' : 'supported_by')
          : (seedIsSource ? 'opposes' : 'opposed_by');
        addArgumentEdge(neighborSignal, {
          edgeId: edge.id,
          sourceArgumentId: edge.sourceArgumentId,
          targetArgumentId: edge.targetArgumentId,
          relation: edge.relation,
          confidence: edge.confidence,
          direction,
        });
        addSummary(neighborSignal, edge.relation === 'support'
          ? (seedIsSource ? `“${unit.text}”支持“${neighbor.text}”` : `“${unit.text}”受到“${neighbor.text}”支持`)
          : (seedIsSource ? `“${unit.text}”削弱“${neighbor.text}”` : `“${unit.text}”受到“${neighbor.text}”削弱`));
      }
    }
  }

  for (const signal of signals.values()) {
    signal.entities = signal.entities.sort((left, right) => right.score - left.score).slice(0, 8);
    signal.entityRelations = signal.entityRelations.slice(0, 8);
    signal.arguments = signal.arguments.slice(0, 6);
    signal.argumentEdges = signal.argumentEdges.slice(0, 6);
    signal.relationSummaries = signal.relationSummaries.slice(0, 4);
  }
  return signals;
}
