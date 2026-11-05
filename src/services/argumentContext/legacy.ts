import type { ArgumentFunctionType, DocumentChunk, StructuredDocument } from '../../types.ts';
import type { KnowledgeShard } from '../../electron/rag/knowledgeStore.ts';
import { argumentCanonicalTextHash, argumentContextHash } from './hash.ts';
import { ARGUMENT_CONTEXT_LIMITS } from './types.ts';
import type {
  ArgumentContextAuthority, ArgumentContextGap, ArgumentContextHierarchy,
  ArgumentContextNode, ArgumentContextProjection, ArgumentContextRelation,
  ArgumentEvidenceSpan, ArgumentSourceIdentity,
} from './types.ts';

export interface LegacyKnowledgeArgumentContextInput {
  /** Bound by the host authority. This function does not read or grant a scope. */
  source: ArgumentSourceIdentity;
  canonicalDocument: StructuredDocument;
  /** Full same-snapshot chunks, not bounded search hits or previews. */
  chunks: DocumentChunk[];
  shard: KnowledgeShard;
}

/**
 * Only persisted legacy version facts are named. No segmentation or original
 * semantic-review version can be recovered from these old records.
 */
export function legacyArgumentSourceVersions(
  document: StructuredDocument, shard: KnowledgeShard,
): Pick<ArgumentSourceIdentity, 'parserVersion' | 'segmentationVersion' | 'extractorVersion' | 'validatorVersion'> {
  const validVersion = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
  if (!document || !shard || !validVersion(shard.extractorVersion) || !validVersion(shard.knowledgePromptVersion)
    || document.materialParserVersion !== undefined && !validVersion(document.materialParserVersion)) {
    throw new Error('invalid_legacy_versions');
  }
  return {
    parserVersion: document.materialParserVersion === undefined
      ? 'legacy-parser-unversioned' : `legacy-material-parser-${document.materialParserVersion}`,
    segmentationVersion: 'legacy-sentence-spans-unversioned',
    extractorVersion: `legacy-knowledge-${shard.extractorVersion}-prompt-${shard.knowledgePromptVersion}`,
    // Names this deterministic compatibility adapter, not a stored semantic approval.
    validatorVersion: 'legacy-adapter-v1',
  };
}

const FUNCTIONS = new Set<ArgumentFunctionType>([
  '定义', '对比', '假设', '举例', '推理', '反例削弱', '建议对策', '命名', '事实陈述',
]);
const BLOCK_KINDS = new Set(['heading', 'paragraph', 'list', 'table', 'code', 'caption', 'notes']);
const opaqueId = (value: unknown): value is string => typeof value === 'string'
  && /^[A-Za-z0-9._:-]{1,200}$/u.test(value);
const rootToken = (value: unknown): value is string => typeof value === 'string'
  && /^[A-Za-z0-9._-]{1,200}$/u.test(value);
const id = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 300 && !/[\u0000-\u001f]/u.test(value);
const confidence = (value: unknown): boolean => typeof value === 'number'
  && Number.isFinite(value) && value >= 0 && value <= 1;
const ids = (value: unknown, maximum = ARGUMENT_CONTEXT_LIMITS.evidence): value is string[] => Array.isArray(value)
  && value.length > 0 && value.length <= maximum && value.every(id) && new Set(value).size === value.length;

function safeRange(text: string, start: unknown, end: unknown): boolean {
  if (!Number.isInteger(start) || !Number.isInteger(end)) return false;
  const left = start as number; const right = end as number;
  const bisectsSurrogate = (offset: number) => offset > 0 && offset < text.length
    && /[\uD800-\uDBFF]/u.test(text[offset - 1]) && /[\uDC00-\uDFFF]/u.test(text[offset]);
  return left >= 0 && right > left && right <= text.length
    && !bisectsSurrogate(left) && !bisectsSurrogate(right);
}

function duplicateIds(items: { id: string }[]): Set<string> {
  const seen = new Set<string>(); const duplicates = new Set<string>();
  for (const item of items) {
    if (!item || !id(item.id)) continue;
    if (seen.has(item.id)) duplicates.add(item.id);
    seen.add(item.id);
  }
  return duplicates;
}

/** Legacy function labels are not evidence for a newly inferred premise/conclusion. */
function legacyRole(mainType: ArgumentFunctionType): ArgumentContextNode['role'] {
  switch (mainType) {
    case '定义': return 'definition';
    case '对比': return 'comparison';
    case '假设': return 'hypothesis';
    case '举例': return 'example';
    case '反例削弱': return 'counterexample';
    case '事实陈述': return 'fact';
    default: return 'claim';
  }
}

/**
 * Pure compatibility projection. Old readiness/confidence is never promoted to a
 * semantic review, source quality decision or reviewed prerequisite closure.
 */
export async function adaptLegacyKnowledgeArgumentContext(
  input: LegacyKnowledgeArgumentContextInput,
): Promise<{ projection: ArgumentContextProjection; authority: ArgumentContextAuthority }> {
  // Snapshot every input before the first await: later caller mutations cannot rebind a pack.
  const { source, canonicalDocument: document, chunks, shard } = structuredClone(input);
  if (source.kind !== 'uploaded-document' || source.coordinateSpace !== 'parsed-text-utf16'
    || source.personal !== undefined || !id(source.entityId) || !rootToken(source.rootScopeId)
    || !opaqueId(source.version) || !/^[a-f0-9]{64}$/u.test(source.contentHash)
    || ![source.parserVersion, source.segmentationVersion, source.extractorVersion, source.validatorVersion]
      .every((value) => typeof value === 'string' && value.length > 0 && value.length <= 200)
    || document.schemaVersion !== 1 || shard.schemaVersion !== 1
    || document.docId !== source.entityId || shard.docId !== source.entityId
    || shard.generationId !== source.version || !['ready', 'partial'].includes(shard.status)
    || typeof document.normalizedText !== 'string' || !document.normalizedText.length
    || document.normalizedText.length > ARGUMENT_CONTEXT_LIMITS.sourceCharacters
    || !Array.isArray(document.blocks) || document.blocks.length > ARGUMENT_CONTEXT_LIMITS.blocks
    || !Array.isArray(chunks) || chunks.length > ARGUMENT_CONTEXT_LIMITS.blocks
    || !Array.isArray(shard.argumentUnits) || shard.argumentUnits.length > ARGUMENT_CONTEXT_LIMITS.nodes
    || !Array.isArray(shard.argumentEdges) || shard.argumentEdges.length > ARGUMENT_CONTEXT_LIMITS.relations
    || !Array.isArray(shard.committedChunkIds) || !Array.isArray(shard.failedChunkIds)
    || shard.committedChunkIds.length > ARGUMENT_CONTEXT_LIMITS.blocks || shard.failedChunkIds.length > ARGUMENT_CONTEXT_LIMITS.blocks
    || !shard.committedChunkIds.every(id) || !shard.failedChunkIds.every(id)
    || new Set(shard.committedChunkIds).size !== shard.committedChunkIds.length
    || new Set(shard.failedChunkIds).size !== shard.failedChunkIds.length
    || shard.committedChunkIds.some((chunkId) => shard.failedChunkIds.includes(chunkId))) {
    throw new Error('invalid_legacy_source');
  }
  const versions = legacyArgumentSourceVersions(document, shard);
  if (Object.entries(versions).some(([key, value]) => source[key as keyof typeof versions] !== value)) {
    throw new Error('legacy_source_version_mismatch');
  }
  const text = document.normalizedText;
  if (await argumentCanonicalTextHash(text) !== source.contentHash) throw new Error('legacy_source_hash_mismatch');

  const gaps: ArgumentContextGap[] = [
    { code: 'legacy_structure' }, { code: 'structure_unreviewed' }, { code: 'source_quality_unknown' },
  ];
  const addGap = (code: ArgumentContextGap['code'], targetId?: string) => {
    if (!gaps.some((gap) => gap.code === code && gap.targetId === targetId)) {
      if (gaps.length >= ARGUMENT_CONTEXT_LIMITS.gaps) throw new Error('legacy_gap_limit');
      gaps.push(targetId && id(targetId) ? { code, targetId } : { code });
    }
  };
  if (shard.status === 'partial' || shard.failedChunkIds.length > 0) addGap('incomplete_extraction');
  for (const failed of shard.failedChunkIds) addGap('incomplete_extraction', failed);

  const hierarchy: ArgumentContextHierarchy = { sections: [], blocks: [], sentences: [] };
  const sectionIds = new Map<string, string>();
  const sectionFor = (path: string): string | null => {
    if (!path) return null;
    const existing = sectionIds.get(path); if (existing) return existing;
    if (hierarchy.sections.length >= ARGUMENT_CONTEXT_LIMITS.sections) throw new Error('legacy_section_limit');
    // Prefixes are physical stored section paths, never logical support relations.
    const delimiter = path.lastIndexOf(' > ');
    const parentId = delimiter > 0 ? sectionFor(path.slice(0, delimiter)) : null;
    if (hierarchy.sections.length >= ARGUMENT_CONTEXT_LIMITS.sections) throw new Error('legacy_section_limit');
    const sectionId = `${source.entityId}:section:${hierarchy.sections.length + 1}`;
    sectionIds.set(path, sectionId);
    hierarchy.sections.push({ id: sectionId, path, parentId });
    return sectionId;
  };
  const duplicateBlocks = duplicateIds(document.blocks);
  let adjacent = true;
  for (const block of document.blocks) {
    const previous = hierarchy.blocks[hierarchy.blocks.length - 1];
    if (!block || !id(block.id) || duplicateBlocks.has(block.id) || !BLOCK_KINDS.has(block.kind)
      || !safeRange(text, block.textStart, block.textEnd) || (previous && block.textStart < previous.end)
      || typeof block.sectionPath !== 'string' || block.sectionPath.length > 2000) {
      addGap('hierarchy_incomplete', block?.id); adjacent = false; continue;
    }
    hierarchy.blocks.push({ id: block.id, kind: block.kind, sectionId: sectionFor(block.sectionPath),
      start: block.textStart, end: block.textEnd, previousId: adjacent ? previous?.id || null : null, nextId: null,
      ...(block.locator ? { locator: block.locator } : {}) });
    if (previous && adjacent) previous.nextId = block.id;
    adjacent = true;
  }
  if (!hierarchy.blocks.length) addGap('hierarchy_incomplete');

  type SentenceAuthority = { start: number; end: number; quote: string; evidence: ArgumentEvidenceSpan[] };
  const chunkById = new Map<string, DocumentChunk>();
  const sentencesByChunk = new Map<string, Map<string, SentenceAuthority>>();
  const sentencesByRange = new Map<string, ArgumentContextHierarchy['sentences'][number]>();
  const duplicateChunks = duplicateIds(chunks);
  const committed = new Set(shard.committedChunkIds);
  let spanCount = 0;
  for (const chunk of chunks) {
    if (!chunk || !id(chunk.id) || duplicateChunks.has(chunk.id) || chunk.docId !== source.entityId
      || !safeRange(text, chunk.textStart, chunk.textEnd)
      || text.slice(chunk.textStart, chunk.textEnd) !== chunk.content || !Array.isArray(chunk.sentenceSpans)
      || chunk.sentenceSpans.length > ARGUMENT_CONTEXT_LIMITS.sentences) {
      addGap('hierarchy_incomplete', chunk?.id); continue;
    }
    spanCount += chunk.sentenceSpans.length;
    if (spanCount > ARGUMENT_CONTEXT_LIMITS.sentences) throw new Error('legacy_sentence_limit');
    chunkById.set(chunk.id, chunk);
    const sentenceMap = new Map<string, SentenceAuthority>();
    const duplicateSentences = duplicateIds(chunk.sentenceSpans);
    let previousEnd = chunk.textStart as number;
    for (const span of chunk.sentenceSpans) {
      if (!span || !id(span.id) || duplicateSentences.has(span.id) || !safeRange(text, span.textStart, span.textEnd)
        || span.textStart < (chunk.textStart as number) || span.textEnd > (chunk.textEnd as number)
        || span.textStart < previousEnd) {
        addGap('hierarchy_incomplete', span?.id); continue;
      }
      previousEnd = span.textEnd;
      const evidence: ArgumentEvidenceSpan[] = [];
      let cursor = span.textStart;
      let covered = true;
      for (const block of hierarchy.blocks) {
        if (block.end <= span.textStart || block.start >= span.textEnd) continue;
        const start = Math.max(block.start, span.textStart); const end = Math.min(block.end, span.textEnd);
        if (text.slice(cursor, start).trim()) { covered = false; break; }
        cursor = end;
        const quote = text.slice(start, end);
        if (!quote.trim()) continue;
        const rangeKey = `${start}:${end}`;
        let sentence = sentencesByRange.get(rangeKey);
        if (!sentence) {
          if (sentencesByRange.size >= ARGUMENT_CONTEXT_LIMITS.sentences) throw new Error('legacy_sentence_limit');
          sentence = { id: `${source.entityId}:sentence:${rangeKey}`, blockId: block.id, start, end, quote };
          sentencesByRange.set(rangeKey, sentence);
        }
        evidence.push({ sentenceId: sentence.id, start, end, quote });
      }
      if (!covered || text.slice(cursor, span.textEnd).trim() || !evidence.length
        || evidence.length > ARGUMENT_CONTEXT_LIMITS.evidence) {
        addGap('hierarchy_incomplete', span.id); continue;
      }
      sentenceMap.set(span.id, { start: span.textStart, end: span.textEnd,
        quote: text.slice(span.textStart, span.textEnd), evidence });
    }
    sentencesByChunk.set(chunk.id, sentenceMap);
  }
  hierarchy.sentences = [...sentencesByRange.values()].sort((left, right) => left.start - right.start || left.end - right.end);
  for (const chunkId of committed) if (!chunkById.has(chunkId)) addGap('incomplete_extraction', chunkId);

  const flattenEvidence = (values: SentenceAuthority[]) => {
    const unique = new Map<string, ArgumentEvidenceSpan>();
    for (const value of values) for (const span of value.evidence) unique.set(span.sentenceId, span);
    return [...unique.values()].sort((left, right) => left.start - right.start || left.end - right.end);
  };
  const nodes: ArgumentContextNode[] = [];
  const unitsById = new Map<string, KnowledgeShard['argumentUnits'][number]>();
  const duplicateUnits = duplicateIds(shard.argumentUnits);
  for (const unit of shard.argumentUnits) {
    const chunk = unit && chunkById.get(unit.chunkId);
    const sentenceMap = unit && sentencesByChunk.get(unit.chunkId);
    const sentenceValues = unit && ids(unit.sentenceIds) && sentenceMap
      ? unit.sentenceIds.map((sentenceId) => sentenceMap.get(sentenceId)) : [];
    const resolved = sentenceValues.filter((value): value is SentenceAuthority => !!value);
    const evidence = flattenEvidence(resolved);
    const valid = unit && id(unit.id) && !duplicateUnits.has(unit.id) && unit.docId === source.entityId
      && chunk && committed.has(unit.chunkId) && FUNCTIONS.has(unit.mainType)
      && unit.origin === 'imported-document-extraction' && confidence(unit.confidence)
      && ['admitted', 'low_confidence'].includes(unit.admission) && ids(unit.sentenceIds)
      && resolved.length === unit.sentenceIds.length && evidence.length > 0 && evidence.length <= ARGUMENT_CONTEXT_LIMITS.evidence
      && unit.textStart === resolved[0].start && unit.textEnd === resolved[resolved.length - 1].end
      // The legacy label is joined trimmed sentences, not necessarily a contiguous source quote.
      && unit.text === resolved.map((value) => value.quote.trim()).filter(Boolean).join('\n');
    if (!valid) { addGap('invalid_legacy_node', unit?.id); continue; }
    // A rejected intermediate sentence must not make non-contiguous old IDs look contiguous.
    const orderedIds = chunk.sentenceSpans!.map((span) => span.id);
    const first = orderedIds.indexOf(unit.sentenceIds[0]);
    if (unit.sentenceIds.some((sentenceId, offset) => orderedIds[first + offset] !== sentenceId)) {
      addGap('invalid_legacy_node', unit.id); continue;
    }
    nodes.push({ id: unit.id, role: legacyRole(unit.mainType), legacyFunctionType: unit.mainType, evidence,
      admission: unit.admission === 'admitted' && !chunk.forcedSplit ? 'admitted' : 'audit_only', semanticStatus: 'unreviewed' });
    unitsById.set(unit.id, unit);
  }

  const relations: ArgumentContextRelation[] = [];
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const duplicateEdges = duplicateIds(shard.argumentEdges);
  const edgeSignatures = new Set<string>();
  for (const edge of shard.argumentEdges) {
    const from = edge && unitsById.get(edge.sourceArgumentId); const to = edge && unitsById.get(edge.targetArgumentId);
    const sentenceMap = edge && sentencesByChunk.get(edge.chunkId);
    const values = edge && ids(edge.evidenceSentenceIds) && sentenceMap
      ? edge.evidenceSentenceIds.map((sentenceId) => sentenceMap.get(sentenceId)) : [];
    const resolved = values.filter((value): value is SentenceAuthority => !!value);
    const evidence = flattenEvidence(resolved);
    if (!edge || !id(edge.id) || duplicateEdges.has(edge.id) || edge.docId !== source.entityId
      || !committed.has(edge.chunkId) || !from || !to || from.id === to.id
      || from.chunkId !== edge.chunkId || to.chunkId !== edge.chunkId
      || !['support', 'oppose'].includes(edge.relation) || !confidence(edge.confidence)
      || !['admitted', 'audit_only'].includes(edge.admission) || !ids(edge.evidenceSentenceIds)
      || resolved.length !== edge.evidenceSentenceIds.length || !evidence.length || evidence.length > ARGUMENT_CONTEXT_LIMITS.evidence
      || !from.sentenceIds.some((sentenceId) => edge.evidenceSentenceIds.includes(sentenceId))
      || !to.sentenceIds.some((sentenceId) => edge.evidenceSentenceIds.includes(sentenceId))
      || from.sentenceIds.some((sentenceId) => to.sentenceIds.includes(sentenceId))) {
      addGap('invalid_legacy_relation', edge?.id); continue;
    }
    const edgeSignature = `${from.id}\n${edge.relation}\n${to.id}`;
    if (edgeSignatures.has(edgeSignature)) { addGap('invalid_legacy_relation', edge.id); continue; }
    edgeSignatures.add(edgeSignature);
    relations.push({ id: edge.id, sourceNodeId: from.id, targetNodeId: to.id, kind: edge.relation, evidence,
      admission: edge.admission === 'admitted' && nodeById.get(from.id)?.admission === 'admitted'
        && nodeById.get(to.id)?.admission === 'admitted' ? 'admitted' : 'audit_only', semanticStatus: 'unreviewed' });
  }
  const projection: ArgumentContextProjection = { version: 1, source, hierarchy, nodes, relations,
    prerequisiteGroups: [], quality: { status: 'unassessed' }, build: { origin: 'legacy-adapter', scopes: [], gaps } };
  const structureHash = await argumentContextHash(projection);
  return { projection, authority: { source: structuredClone(source), canonicalText: text, structureHash } };
}
