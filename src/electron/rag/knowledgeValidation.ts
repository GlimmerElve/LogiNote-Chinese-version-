import type {
  ArgumentFunctionType,
  DocumentChunk,
  KnowledgeArgumentEdge,
  KnowledgeArgumentUnit,
  KnowledgeEntityMention,
  KnowledgeEntityRelation,
  KnowledgeEntityType,
  RagKnowledgeChunkExtraction,
  SentenceSpan,
} from '../../types.ts';
import { hasExplicitComparisonTargetMismatch, isKnowledgeStatementStatus, resolveKnowledgeStatementStatus } from './knowledgeSemantics.ts';

const ENTITY_TYPES = new Set<KnowledgeEntityType>([
  'concept', 'person', 'organization', 'method', 'theory', 'technology',
  'event', 'place', 'metric', 'material', 'other',
]);
const ARGUMENT_TYPES = new Set<ArgumentFunctionType>([
  '定义', '对比', '假设', '举例', '推理', '反例削弱', '建议对策', '命名', '事实陈述',
]);

interface EvidenceSentence {
  span: SentenceSpan;
  text: string;
}

export interface KnowledgeValidationResult {
  entityMentions: KnowledgeEntityMention[];
  entityRelations: KnowledgeEntityRelation[];
  argumentUnits: KnowledgeArgumentUnit[];
  argumentEdges: KnowledgeArgumentEdge[];
  warnings: string[];
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function normalizeEntityKey(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().trim().replace(/\s+/gu, ' ');
}

function cleanString(value: unknown, maxLength: number): string {
  // 证据子串必须保留原文字符；NFKC 只用于后续 normalizedKey，不用于改写引用。
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function confidence(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

function uniqueIds(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) return [];
  return Array.from(new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0)));
}

function argumentLayer(mainType: ArgumentFunctionType): KnowledgeArgumentUnit['layer'] {
  if (mainType === '定义' || mainType === '命名' || mainType === '对比') return 'concept';
  if (mainType === '推理' || mainType === '反例削弱' || mainType === '建议对策') return 'logic';
  return 'judgment';
}

function mentionsResolveTogether(left: KnowledgeEntityMention, right: KnowledgeEntityMention): boolean {
  if (left.entityType !== right.entityType) return false;
  const leftKeys = new Set([left.normalizedKey, ...left.aliases.map(normalizeEntityKey)]);
  return [right.normalizedKey, ...right.aliases.map(normalizeEntityKey)].some((key) => leftKeys.has(key));
}

function sentenceMap(chunk: DocumentChunk): Map<string, EvidenceSentence> {
  const base = chunk.textStart || 0;
  return new Map((chunk.sentenceSpans || []).map((span) => [span.id, {
    span,
    text: chunk.content.slice(Math.max(0, span.textStart - base), Math.max(0, span.textEnd - base)),
  }]));
}

function resolveSentences(
  rawIds: unknown,
  evidence: Map<string, EvidenceSentence>,
  maxItems = 12,
): EvidenceSentence[] | null {
  const ids = uniqueIds(rawIds, maxItems);
  if (ids.length === 0) return null;
  const values = ids.map((id) => evidence.get(id));
  return values.every((item): item is EvidenceSentence => !!item)
    ? values.sort((left, right) => left.span.textStart - right.span.textStart || left.span.id.localeCompare(right.span.id))
    : null;
}

function validateArray(value: unknown, label: string, maxItems: number): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} 必须是数组`);
  if (value.length > maxItems) throw new Error(`${label} 超过数量上限 ${maxItems}`);
  return value;
}

/**
 * Treat model output as untrusted labels. All source text and offsets are recovered
 * from the canonical L1 chunk, and invalid candidates are omitted with an audit warning.
 */
export function validateKnowledgeExtraction(
  docId: string,
  chunk: DocumentChunk,
  extraction: RagKnowledgeChunkExtraction,
): KnowledgeValidationResult {
  if (chunk.docId !== docId || extraction.chunkId !== chunk.id) throw new Error('knowledge chunk 归属不一致');
  const rawMentions = validateArray(extraction.entityMentions, 'entityMentions', 40);
  const rawRelations = validateArray(extraction.entityRelations, 'entityRelations', 40);
  const rawUnits = validateArray(extraction.argumentUnits, 'argumentUnits', 30);
  const rawEdges = validateArray(extraction.argumentEdges, 'argumentEdges', 40);
  const evidence = sentenceMap(chunk);
  if (evidence.size === 0) throw new Error('chunk 缺少 sentence spans');

  const warnings: string[] = [];
  const entityMentions: KnowledgeEntityMention[] = [];
  const mentionByLocalId = new Map<string, KnowledgeEntityMention>();
  const mentionSignatures = new Set<string>();

  for (const [index, raw] of rawMentions.entries()) {
    const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const localId = cleanString(item.localId, 80);
    const surfaceText = cleanString(item.surfaceText, 120);
    const entityType = item.entityType as KnowledgeEntityType;
    const score = confidence(item.confidence);
    const sentences = resolveSentences(item.sentenceIds, evidence, 4);
    if (!localId || mentionByLocalId.has(localId) || !surfaceText || !ENTITY_TYPES.has(entityType) || score === null || !sentences) {
      warnings.push(`entityMention[${index}] 结构无效，已丢弃`);
      continue;
    }
    if (score < 0.55) {
      warnings.push(`entityMention:${localId} 置信度低于 0.55，已丢弃`);
      continue;
    }
    const containing = sentences.find((sentence) => sentence.text.includes(surfaceText));
    if (!containing) {
      warnings.push(`entityMention:${localId} 不是证据句的原文子串，已丢弃`);
      continue;
    }
    const localOffset = containing.text.indexOf(surfaceText);
    const normalizedKey = normalizeEntityKey(surfaceText);
    if (!normalizedKey) continue;
    const explicitAliases = Array.isArray(item.aliases) ? item.aliases : [];
    const aliases = Array.from(new Set(explicitAliases
      .slice(0, 8)
      .map((alias) => cleanString(alias, 120))
      .filter((alias) => alias && alias !== surfaceText && sentences.some((sentence) => sentence.text.includes(alias)))));
    const canonicalEntityId = `entity:${stableHash(`${entityType}\n${normalizedKey}`)}`;
    const mentionSignature = `${entityType}\n${normalizedKey}\n${containing.span.id}\n${localOffset}`;
    if (mentionSignatures.has(mentionSignature)) {
      warnings.push(`entityMention:${localId} 与已有标注重复，已丢弃`);
      continue;
    }
    mentionSignatures.add(mentionSignature);
    const mention: KnowledgeEntityMention = {
      id: `${chunk.id}:entity:${stableHash(localId)}`,
      docId,
      chunkId: chunk.id,
      sentenceIds: sentences.map((sentence) => sentence.span.id),
      surfaceText,
      normalizedKey,
      entityType,
      canonicalEntityId,
      textStart: containing.span.textStart + localOffset,
      textEnd: containing.span.textStart + localOffset + surfaceText.length,
      aliases,
      confidence: score,
      admission: score >= 0.70 ? 'admitted' : 'low_confidence',
    };
    entityMentions.push(mention);
    mentionByLocalId.set(localId, mention);
  }

  const entityRelations: KnowledgeEntityRelation[] = [];
  const relationLocalIds = new Set<string>();
  const relationSignatures = new Set<string>();
  for (const [index, raw] of rawRelations.entries()) {
    const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const localId = cleanString(item.localId, 80);
    const subject = mentionByLocalId.get(cleanString(item.subjectMentionId, 80));
    const object = mentionByLocalId.get(cleanString(item.objectMentionId, 80));
    const predicate = cleanString(item.predicate, 80);
    const score = confidence(item.confidence);
    const sentences = resolveSentences(item.evidenceSentenceIds, evidence, 8);
    const relationEvidenceIds = sentences?.map((sentence) => sentence.span.id) || [];
    const evidenceSet = new Set(relationEvidenceIds);
    const coversEndpoints = !!subject && !!object
      && subject.sentenceIds.some((id) => evidenceSet.has(id))
      && object.sentenceIds.some((id) => evidenceSet.has(id));
    if (!localId || relationLocalIds.has(localId) || !subject || !object || subject.id === object.id || mentionsResolveTogether(subject, object) || !predicate || score === null || !sentences || !coversEndpoints) {
      warnings.push(`entityRelation[${index}] 端点或证据无效，已丢弃`);
      continue;
    }
    relationLocalIds.add(localId);
    if (score < 0.55) {
      warnings.push(`entityRelation:${localId} 置信度低于 0.55，已丢弃`);
      continue;
    }
    const qualifiers = Array.from(new Set((Array.isArray(item.qualifiers) ? item.qualifiers : [])
      .slice(0, 8).map((value) => cleanString(value, 120)).filter(Boolean)));
    if (item.statementStatus !== undefined && !isKnowledgeStatementStatus(item.statementStatus)) {
      warnings.push(`entityRelation:${localId} [invalid_statement_status] 陈述性质无效，已丢弃`);
      continue;
    }
    const statementStatus = resolveKnowledgeStatementStatus(
      isKnowledgeStatementStatus(item.statementStatus) ? item.statementStatus : undefined,
      sentences.map((sentence) => sentence.text),
    );
    const relationSignature = `${subject.canonicalEntityId}\n${predicate}\n${object.canonicalEntityId}\n${relationEvidenceIds.join(',')}`;
    if (relationSignatures.has(relationSignature)) {
      warnings.push(`entityRelation:${localId} 与已有关系重复，已丢弃`);
      continue;
    }
    relationSignatures.add(relationSignature);
    const admitted = score >= 0.75 && subject.admission === 'admitted' && object.admission === 'admitted';
    entityRelations.push({
      id: `${chunk.id}:relation:${stableHash(localId)}`,
      docId,
      chunkId: chunk.id,
      subjectEntityId: subject.canonicalEntityId,
      objectEntityId: object.canonicalEntityId,
      predicate,
      qualifiers,
      statementStatus,
      evidenceSentenceIds: relationEvidenceIds,
      confidence: score,
      admission: admitted ? 'admitted' : 'audit_only',
    });
  }

  const argumentUnits: KnowledgeArgumentUnit[] = [];
  const unitByLocalId = new Map<string, KnowledgeArgumentUnit>();
  const unitSignatures = new Set<string>();
  for (const [index, raw] of rawUnits.entries()) {
    const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const localId = cleanString(item.localId, 80);
    const mainType = item.mainType as ArgumentFunctionType;
    const score = confidence(item.confidence);
    const sentences = resolveSentences(item.sentenceIds, evidence, 12);
    if (!localId || unitByLocalId.has(localId) || !ARGUMENT_TYPES.has(mainType) || score === null || !sentences) {
      warnings.push(`argumentUnit[${index}] 结构无效，已丢弃`);
      continue;
    }
    if (score < 0.55) {
      warnings.push(`argumentUnit:${localId} 置信度低于 0.55，已丢弃`);
      continue;
    }
    const mentionedEntityIds = uniqueIds(item.mentionedEntityMentionIds, 20)
      .map((id) => {
        const mention = mentionByLocalId.get(id);
        return mention?.admission === 'admitted' ? mention.canonicalEntityId : undefined;
      })
      .filter((id): id is string => !!id);
    const unitSentenceIds = sentences.map((sentence) => sentence.span.id);
    const orderedIds = [...evidence.keys()];
    const firstSentence = orderedIds.indexOf(unitSentenceIds[0]);
    if (unitSentenceIds.some((id, i) => orderedIds[firstSentence + i] !== id)) {
      warnings.push(`argumentUnit:${localId} [non_contiguous_sentences] 证据句不连续，已丢弃`);
      continue;
    }
    const unitSignature = unitSentenceIds.join(',');
    if (unitSignatures.has(unitSignature)) {
      warnings.push(`argumentUnit:${localId} 与已有论证单元重复，已丢弃`);
      continue;
    }
    unitSignatures.add(unitSignature);
    const unit: KnowledgeArgumentUnit = {
      id: `${chunk.id}:argument:${stableHash(localId)}`,
      docId,
      chunkId: chunk.id,
      sentenceIds: unitSentenceIds,
      mainType,
      layer: argumentLayer(mainType),
      textStart: Math.min(...sentences.map((sentence) => sentence.span.textStart)),
      textEnd: Math.max(...sentences.map((sentence) => sentence.span.textEnd)),
      text: sentences.map((sentence) => sentence.text.trim()).filter(Boolean).join('\n'),
      mentionedEntityIds: Array.from(new Set(mentionedEntityIds)),
      confidence: score,
      origin: 'imported-document-extraction',
      admission: score >= 0.70 && !chunk.forcedSplit ? 'admitted' : 'low_confidence',
    };
    if (chunk.forcedSplit) warnings.push(`argumentUnit:${localId} [forced_split] 所在分块含硬切句子，仅保留审计`);
    argumentUnits.push(unit);
    unitByLocalId.set(localId, unit);
  }

  const argumentEdges: KnowledgeArgumentEdge[] = [];
  const edgeLocalIds = new Set<string>();
  const edgeSignatures = new Set<string>();
  for (const [index, raw] of rawEdges.entries()) {
    const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const localId = cleanString(item.localId, 80);
    const source = unitByLocalId.get(cleanString(item.sourceArgumentId, 80));
    const target = unitByLocalId.get(cleanString(item.targetArgumentId, 80));
    const relation = item.relation;
    const score = confidence(item.confidence);
    // Legacy omitted field can derive endpoint evidence; an explicit malformed/empty list must not bypass validation.
    const candidateEvidenceIds = item.evidenceSentenceIds === undefined
      ? Array.from(new Set([...(source?.sentenceIds || []), ...(target?.sentenceIds || [])]))
      : item.evidenceSentenceIds;
    const validEvidenceShape = Array.isArray(candidateEvidenceIds) && candidateEvidenceIds.length > 0
      && candidateEvidenceIds.length <= 12 && candidateEvidenceIds.every((id) => typeof id === 'string' && id.length > 0);
    const sentences = resolveSentences(candidateEvidenceIds, evidence, 12);
    const evidenceIds = sentences?.map((sentence) => sentence.span.id) || [];
    const edgeEvidenceSet = new Set(evidenceIds);
    const coversEndpoints = !!source && !!target
      && source.sentenceIds.some((id) => edgeEvidenceSet.has(id))
      && target.sentenceIds.some((id) => edgeEvidenceSet.has(id));
    const rejection = !localId ? 'missing_id'
      : edgeLocalIds.has(localId) ? 'duplicate_id'
      : !source || !target ? 'missing_endpoint'
      : source.id === target.id ? 'self_edge'
      : relation !== 'support' && relation !== 'oppose' ? 'invalid_relation'
      : score === null ? 'invalid_confidence'
      : !validEvidenceShape || !sentences ? 'invalid_evidence'
      : !coversEndpoints ? 'evidence_missing_endpoint'
      : source.sentenceIds.some((id) => target.sentenceIds.includes(id)) ? 'overlapping_endpoints'
      : null;
    if (rejection || !source || !target || score === null || (relation !== 'support' && relation !== 'oppose')) {
      warnings.push(`argumentEdge[${index}] [${rejection}] 端点或证据无效，已丢弃`);
      continue;
    }
    edgeLocalIds.add(localId);
    if (score < 0.55) {
      warnings.push(`argumentEdge:${localId} 置信度低于 0.55，已丢弃`);
      continue;
    }
    const comparisonMismatch = relation === 'oppose' && hasExplicitComparisonTargetMismatch(source.text, target.text);
    if (comparisonMismatch) warnings.push(`argumentEdge:${localId} [comparison_target_mismatch] 明确比较对象不在目标节点，仅保留审计`);
    const admitted = score >= 0.75 && source.admission === 'admitted' && target.admission === 'admitted' && !comparisonMismatch;
    const edgeSignature = `${source.id}\n${relation}\n${target.id}`;
    if (edgeSignatures.has(edgeSignature)) {
      warnings.push(`argumentEdge:${localId} 与已有论证边重复，已丢弃`);
      continue;
    }
    edgeSignatures.add(edgeSignature);
    argumentEdges.push({
      id: `${chunk.id}:argument-edge:${stableHash(localId)}`,
      docId,
      chunkId: chunk.id,
      sourceArgumentId: source.id,
      targetArgumentId: target.id,
      relation,
      evidenceSentenceIds: evidenceIds,
      confidence: score,
      admission: admitted ? 'admitted' : 'audit_only',
    });
  }

  return { entityMentions, entityRelations, argumentUnits, argumentEdges, warnings };
}
