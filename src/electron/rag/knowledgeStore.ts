import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  CanonicalKnowledgeEntity,
  DocumentChunk,
  KnowledgeArgumentEdge,
  KnowledgeArgumentUnit,
  KnowledgeEntityCatalog,
  KnowledgeEntityMention,
  KnowledgeEntityRelation,
  RagKnowledgeBatchCommit,
  RagKnowledgeDocumentStatus,
  RagKnowledgePendingChunk,
  RagKnowledgeSettings,
} from '../../types.ts';
import { atomicWriteTextFile } from '../atomicWrite.ts';
import { generateEmbedding } from './embedding.ts';
import { normalizeEntityKey, validateKnowledgeExtraction } from './knowledgeValidation.ts';

type ChunkJobStatus = 'pending' | 'processing' | 'committed' | 'failed';

interface KnowledgeChunkJob {
  status: ChunkJobStatus;
  attempts: number;
  error?: string;
}

interface KnowledgeJob {
  schemaVersion: 1;
  docId: string;
  generationId: string;
  chunkSetHash: string;
  extractorVersion: number;
  knowledgePromptVersion: number;
  activeGenerationId?: string;
  status: Exclude<RagKnowledgeDocumentStatus['status'], 'disabled'>;
  chunks: Record<string, KnowledgeChunkJob>;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export interface KnowledgeShard {
  schemaVersion: 1;
  docId: string;
  generationId: string;
  status: 'ready' | 'partial';
  extractorVersion: number;
  knowledgePromptVersion: number;
  committedChunkIds: string[];
  failedChunkIds: string[];
  entityMentions: KnowledgeEntityMention[];
  entityRelations: KnowledgeEntityRelation[];
  argumentUnits: KnowledgeArgumentUnit[];
  argumentEdges: KnowledgeArgumentEdge[];
  validationWarnings: string[];
  createdAt: string;
}

const DEFAULT_SETTINGS: RagKnowledgeSettings = { enabled: false, processingMode: 'local-only' };
export const KNOWLEDGE_EXTRACTOR_VERSION = 4;
export const KNOWLEDGE_PROMPT_VERSION = 3;
type EmbeddingGenerator = (text: string) => Promise<number[]>;
let dataRoot = '';

export function setKnowledgeDataRoot(root: string): void {
  dataRoot = root;
}

function indexDir(): string {
  return path.join(dataRoot, 'rag-index');
}

function settingsFile(): string {
  return path.join(indexDir(), 'knowledge-settings.json');
}

function entityCatalogFile(): string {
  return path.join(indexDir(), 'entity-catalog.json');
}

function safePathId(value: string, label: string): string {
  if (!/^[A-Za-z0-9._-]{1,160}$/u.test(value)) throw new Error(`${label} 非法`);
  return value;
}

function jobFile(docId: string): string {
  return path.join(indexDir(), `knowledge-job-${safePathId(docId, 'docId')}.json`);
}

function activeShardFile(docId: string): string {
  return path.join(indexDir(), `knowledge-${safePathId(docId, 'docId')}.json`);
}

function stagingFile(docId: string, generationId: string): string {
  return path.join(
    indexDir(),
    'staging',
    safePathId(docId, 'docId'),
    safePathId(generationId, 'generationId'),
    'knowledge.json',
  );
}

async function ensureParent(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await ensureParent(filePath);
  await atomicWriteTextFile(filePath, JSON.stringify(value, null, 2));
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function stableHash(values: string[]): string {
  let hash = 0x811c9dc5;
  for (const value of values) {
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    hash ^= 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

async function summarize(job: KnowledgeJob, enabled = true): Promise<RagKnowledgeDocumentStatus> {
  const states = Object.values(job.chunks);
  const shard = job.activeGenerationId
    ? await readJson<KnowledgeShard>(activeShardFile(job.docId))
    : null;
  return {
    docId: job.docId,
    status: enabled ? job.status : 'disabled',
    generationId: job.generationId,
    indexedChunks: states.filter((item) => item.status === 'committed').length,
    failedChunks: states.filter((item) => item.status === 'failed').length,
    totalChunks: states.length,
    entityCount: shard
      ? new Set(shard.entityMentions.filter((item) => item.admission === 'admitted').map((item) => item.canonicalEntityId)).size
      : 0,
    argumentCount: shard?.argumentUnits.filter((item) => item.admission === 'admitted').length || 0,
    extractorVersion: job.extractorVersion,
    knowledgePromptVersion: job.knowledgePromptVersion,
    error: job.error,
    updatedAt: job.updatedAt,
  };
}

export async function readKnowledgeSettings(): Promise<RagKnowledgeSettings> {
  const value = await readJson<Partial<RagKnowledgeSettings>>(settingsFile());
  return {
    enabled: value?.enabled === true,
    processingMode: value?.processingMode === 'allow-cloud' ? 'allow-cloud' : 'local-only',
  };
}

export async function writeKnowledgeSettings(value: RagKnowledgeSettings): Promise<RagKnowledgeSettings> {
  const normalized: RagKnowledgeSettings = {
    enabled: value.enabled === true,
    processingMode: value.processingMode === 'allow-cloud' ? 'allow-cloud' : 'local-only',
  };
  await writeJsonAtomic(settingsFile(), normalized);
  return normalized;
}

export async function ensureKnowledgeJob(
  docId: string,
  chunks: DocumentChunk[],
  force = false,
): Promise<RagKnowledgeDocumentStatus> {
  const now = new Date().toISOString();
  const chunkSetHash = stableHash(chunks.map((chunk) => chunk.id));
  const existing = await readJson<KnowledgeJob>(jobFile(docId));
  if (!force
    && existing?.schemaVersion === 1
    && existing.chunkSetHash === chunkSetHash
    && existing.extractorVersion === KNOWLEDGE_EXTRACTOR_VERSION
    && existing.knowledgePromptVersion === KNOWLEDGE_PROMPT_VERSION) {
    return summarize(existing, (await readKnowledgeSettings()).enabled);
  }

  const generationId = `kg-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const active = await readJson<KnowledgeShard>(activeShardFile(docId));
  const job: KnowledgeJob = {
    schemaVersion: 1,
    docId,
    generationId,
    chunkSetHash,
    extractorVersion: KNOWLEDGE_EXTRACTOR_VERSION,
    knowledgePromptVersion: KNOWLEDGE_PROMPT_VERSION,
    activeGenerationId: active?.generationId,
    status: chunks.length > 0 ? 'pending' : 'failed',
    chunks: Object.fromEntries(chunks.map((chunk) => [chunk.id, { status: 'pending', attempts: 0 }])),
    createdAt: now,
    updatedAt: now,
    error: chunks.length > 0 ? undefined : '文档没有可标注的 L1 chunk',
  };
  const staging: KnowledgeShard = {
    schemaVersion: 1,
    docId,
    generationId,
    status: 'ready',
    extractorVersion: KNOWLEDGE_EXTRACTOR_VERSION,
    knowledgePromptVersion: KNOWLEDGE_PROMPT_VERSION,
    committedChunkIds: [],
    failedChunkIds: [],
    entityMentions: [],
    entityRelations: [],
    argumentUnits: [],
    argumentEdges: [],
    validationWarnings: [],
    createdAt: now,
  };
  await writeJsonAtomic(stagingFile(docId, generationId), staging);
  await writeJsonAtomic(jobFile(docId), job);
  return summarize(job, (await readKnowledgeSettings()).enabled);
}

export async function readKnowledgeStatus(docId: string): Promise<RagKnowledgeDocumentStatus> {
  const settings = await readKnowledgeSettings();
  const job = await readJson<KnowledgeJob>(jobFile(docId));
  if (!job) {
    return { docId, status: settings.enabled ? 'pending' : 'disabled', indexedChunks: 0, failedChunks: 0, totalChunks: 0 };
  }
  return summarize(job, settings.enabled);
}

export async function getPendingKnowledgeBatch(
  docIds: string[],
  loadChunks: (docId: string) => Promise<DocumentChunk[]>,
  maxChunks = 4,
): Promise<RagKnowledgePendingChunk[]> {
  const settings = await readKnowledgeSettings();
  if (!settings.enabled) return [];
  const limit = Math.max(1, Math.min(12, Math.floor(maxChunks) || 4));
  const result: RagKnowledgePendingChunk[] = [];

  for (const docId of docIds) {
    if (result.length >= limit) break;
    const chunks = await loadChunks(docId);
    const status = await ensureKnowledgeJob(docId, chunks);
    const job = await readJson<KnowledgeJob>(jobFile(docId));
    if (!job || status.status === 'ready' || status.status === 'partial' || status.status === 'failed') continue;
    const chunkById = new Map(chunks.map((chunk) => [chunk.id, chunk]));
    for (const [chunkId, state] of Object.entries(job.chunks)) {
      if (result.length >= limit) break;
      if (state.status !== 'pending') continue;
      const chunk = chunkById.get(chunkId);
      if (!chunk) continue;
      state.status = 'processing';
      state.attempts += 1;
      const base = chunk.textStart || 0;
      const spans = chunk.sentenceSpans || [];
      result.push({
        docId,
        generationId: job.generationId,
        chunkId,
        sectionPath: chunk.sectionPath,
        sentences: spans.map((span) => ({
          id: span.id,
          text: chunk.content.slice(Math.max(0, span.textStart - base), Math.max(0, span.textEnd - base)),
        })).filter((sentence) => sentence.text.trim()),
      });
    }
    if (result.some((item) => item.docId === docId)) {
      job.status = 'processing';
      job.updatedAt = new Date().toISOString();
      await writeJsonAtomic(jobFile(docId), job);
    }
  }
  return result;
}

export async function rebuildEntityCatalog(
  embedText: EmbeddingGenerator = generateEmbedding,
  overrideShard?: KnowledgeShard,
): Promise<KnowledgeEntityCatalog> {
  await fs.mkdir(indexDir(), { recursive: true });
  const names = await fs.readdir(indexDir());
  const shards: KnowledgeShard[] = [];
  for (const name of names.filter((value) => /^knowledge-(?!job-|settings\.json$).+\.json$/u.test(value))) {
    const shard = await readJson<KnowledgeShard>(path.join(indexDir(), name));
    if (shard?.schemaVersion === 1 && Array.isArray(shard.entityMentions) && shard.docId !== overrideShard?.docId) shards.push(shard);
  }
  if (overrideShard) shards.push(overrideShard);

  const mentions = shards.flatMap((shard) => shard.entityMentions)
    .filter((mention) => mention.admission === 'admitted');
  const parents = mentions.map((_, index) => index);
  const find = (index: number): number => {
    let current = index;
    while (parents[current] !== current) {
      parents[current] = parents[parents[current]];
      current = parents[current];
    }
    return current;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[Math.max(leftRoot, rightRoot)] = Math.min(leftRoot, rightRoot);
  };
  const keyOwner = new Map<string, number>();
  mentions.forEach((mention, index) => {
    const keys = Array.from(new Set([
      mention.normalizedKey,
      ...mention.aliases.map(normalizeEntityKey),
    ].filter(Boolean)));
    for (const normalized of keys) {
      const key = `${mention.entityType}\n${normalized}`;
      const owner = keyOwner.get(key);
      if (owner === undefined) keyOwner.set(key, index);
      else union(index, owner);
    }
  });
  const grouped = new Map<number, KnowledgeEntityMention[]>();
  mentions.forEach((mention, index) => {
    const root = find(index);
    grouped.set(root, [...(grouped.get(root) || []), mention]);
  });
  const records: Array<Omit<CanonicalKnowledgeEntity, 'embedding'>> = Array.from(grouped.values()).map((groupMentions) => {
    const nameCounts = new Map<string, number>();
    for (const mention of groupMentions) nameCounts.set(mention.surfaceText, (nameCounts.get(mention.surfaceText) || 0) + 1);
    const canonicalName = Array.from(nameCounts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'))[0]?.[0] || groupMentions[0].surfaceText;
    const memberEntityIds = Array.from(new Set(groupMentions.map((mention) => mention.canonicalEntityId))).sort();
    return {
      id: memberEntityIds[0],
      memberEntityIds,
      canonicalName,
      normalizedKey: normalizeEntityKey(canonicalName),
      entityType: groupMentions[0].entityType,
      aliases: Array.from(new Set(groupMentions.flatMap((mention) => [mention.surfaceText, ...mention.aliases])))
        .filter((name) => name !== canonicalName)
        .sort((a, b) => a.localeCompare(b, 'zh-CN')),
      mentionIds: groupMentions.map((mention) => mention.id).sort(),
      docIds: Array.from(new Set(groupMentions.map((mention) => mention.docId))).sort(),
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
  const previous = await readJson<KnowledgeEntityCatalog>(entityCatalogFile());
  const previousBySignature = new Map((previous?.entities || []).map((entity) => [
    `${entity.entityType}\n${entity.canonicalName}\n${entity.aliases.join('\n')}`,
    entity.embedding,
  ]));
  const entities: CanonicalKnowledgeEntity[] = [];
  for (const record of records) {
    const signature = `${record.entityType}\n${record.canonicalName}\n${record.aliases.join('\n')}`;
    const cached = previousBySignature.get(signature);
    entities.push({
      ...record,
      embedding: Array.isArray(cached) && cached.length > 0
        ? cached
        : await embedText([record.canonicalName, ...record.aliases].join('\n')),
    });
  }
  const catalog: KnowledgeEntityCatalog = { schemaVersion: 1, generatedAt: new Date().toISOString(), entities };
  await writeJsonAtomic(entityCatalogFile(), catalog);
  return catalog;
}

export async function readEntityCatalog(): Promise<KnowledgeEntityCatalog> {
  return await readJson<KnowledgeEntityCatalog>(entityCatalogFile())
    || { schemaVersion: 1, generatedAt: '', entities: [] };
}

export async function readActiveKnowledgeShards(docIds?: string[]): Promise<KnowledgeShard[]> {
  await fs.mkdir(indexDir(), { recursive: true });
  const ids = docIds || (await fs.readdir(indexDir()))
    .filter((name) => /^knowledge-(?!job-|settings\.json$).+\.json$/u.test(name))
    .map((name) => name.slice('knowledge-'.length, -'.json'.length));
  const shards: KnowledgeShard[] = [];
  for (const docId of ids) {
    const shard = await readJson<KnowledgeShard>(activeShardFile(docId));
    if (shard?.schemaVersion === 1 && (shard.status === 'ready' || shard.status === 'partial')) {
      const replaced=await fs.stat(path.join(indexDir(),`argument-graph-v5-${safePathId(docId,'docId')}.json`)).then(()=>true,()=>false);
      shards.push(replaced?{...shard,argumentUnits:[],argumentEdges:[]}:shard);
    }
  }
  return shards;
}

async function finalizeIfTerminal(job: KnowledgeJob, embedText: EmbeddingGenerator): Promise<void> {
  const entries = Object.entries(job.chunks);
  if (entries.some(([, state]) => state.status === 'pending' || state.status === 'processing')) return;
  const staging = await readJson<KnowledgeShard>(stagingFile(job.docId, job.generationId));
  if (!staging) throw new Error('knowledge staging shard 不存在');
  staging.validationWarnings ||= [];
  staging.committedChunkIds = entries.filter(([, state]) => state.status === 'committed').map(([id]) => id);
  staging.failedChunkIds = entries.filter(([, state]) => state.status === 'failed').map(([id]) => id);
  staging.status = staging.failedChunkIds.length > 0 ? 'partial' : 'ready';
  if(await fs.stat(path.join(indexDir(),`argument-graph-v5-${safePathId(job.docId,'docId')}.json`)).then(()=>true,()=>false)){
    staging.argumentUnits=[];staging.argumentEdges=[];
  }
  await writeJsonAtomic(stagingFile(job.docId, job.generationId), staging);
  await rebuildEntityCatalog(embedText, staging);
  await writeJsonAtomic(activeShardFile(job.docId), staging);
  job.activeGenerationId = job.generationId;
  job.status = staging.status;
}

export async function commitKnowledgeBatch(
  input: RagKnowledgeBatchCommit,
  loadChunks: (docId: string) => Promise<DocumentChunk[]>,
  embedText: EmbeddingGenerator = generateEmbedding,
): Promise<RagKnowledgeDocumentStatus> {
  if (!(await readKnowledgeSettings()).enabled) throw new Error('knowledge 索引已暂停');
  const job = await readJson<KnowledgeJob>(jobFile(input.docId));
  if (!job || job.generationId !== input.generationId) throw new Error('knowledge generation 已过期');
  if (!Array.isArray(input.items)) throw new Error('knowledge items 必须是数组');
  if (input.items.length === 0 || input.items.length > 12) throw new Error('knowledge batch 大小无效');
  const ids = Array.from(new Set(input.items.map((item) => String(item?.chunkId || ''))));
  if (ids.length !== input.items.length || ids.some((id) => !id)) throw new Error('knowledge batch chunkId 重复或为空');
  for (const chunkId of ids) {
    const state = job.chunks[chunkId];
    if (!state) throw new Error(`chunk 不属于当前 generation：${chunkId}`);
    if (state.status !== 'processing' && state.status !== 'pending') {
      throw new Error(`chunk 当前不可提交：${chunkId}`);
    }
  }
  const chunks = await loadChunks(input.docId);
  const chunkById = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  const staging = await readJson<KnowledgeShard>(stagingFile(job.docId, job.generationId));
  if (!staging) throw new Error('knowledge staging shard 不存在');
  staging.validationWarnings ||= [];
  const idSet = new Set(ids);
  staging.entityMentions = staging.entityMentions.filter((item) => !idSet.has(item.chunkId));
  staging.entityRelations = staging.entityRelations.filter((item) => !idSet.has(item.chunkId));
  staging.argumentUnits = staging.argumentUnits.filter((item) => !idSet.has(item.chunkId));
  staging.argumentEdges = staging.argumentEdges.filter((item) => !idSet.has(item.chunkId));

  for (const item of input.items) {
    const chunk = chunkById.get(item.chunkId);
    if (!chunk) throw new Error(`chunk 原文不存在：${item.chunkId}`);
    const validated = validateKnowledgeExtraction(input.docId, chunk, item);
    const entityNameById = new Map(validated.entityMentions.map((mention) => [mention.canonicalEntityId, mention.surfaceText]));
    for (const relation of validated.entityRelations) {
      if (relation.admission !== 'admitted') continue;
      relation.embedding = await embedText([
        entityNameById.get(relation.subjectEntityId) || '',
        relation.predicate,
        entityNameById.get(relation.objectEntityId) || '',
        ...relation.qualifiers,
        relation.statementStatus || 'unspecified',
      ].filter(Boolean).join(' '));
    }
    for (const unit of validated.argumentUnits) {
      if (unit.admission !== 'admitted') continue;
      unit.embedding = await embedText(`${unit.mainType}\n${unit.text}`);
    }
    staging.entityMentions.push(...validated.entityMentions);
    staging.entityRelations.push(...validated.entityRelations);
    staging.argumentUnits.push(...validated.argumentUnits);
    staging.argumentEdges.push(...validated.argumentEdges);
    staging.validationWarnings.push(...validated.warnings.map((warning) => `${item.chunkId}: ${warning}`));
  }
  staging.validationWarnings = staging.validationWarnings.slice(-500);
  await writeJsonAtomic(stagingFile(job.docId, job.generationId), staging);
  for (const chunkId of ids) {
    const state = job.chunks[chunkId];
    state.status = 'committed';
    state.error = undefined;
  }
  await finalizeIfTerminal(job, embedText);
  job.updatedAt = new Date().toISOString();
  await writeJsonAtomic(jobFile(job.docId), job);
  return summarize(job);
}

export async function failKnowledgeBatch(
  docId: string,
  generationId: string,
  chunkIds: string[],
  error: string,
  embedText: EmbeddingGenerator = generateEmbedding,
): Promise<RagKnowledgeDocumentStatus> {
  if (!(await readKnowledgeSettings()).enabled) throw new Error('knowledge 索引已暂停');
  const job = await readJson<KnowledgeJob>(jobFile(docId));
  if (!job || job.generationId !== generationId) throw new Error('knowledge generation 已过期');
  const safeError = String(error || '知识抽取失败').slice(0, 500);
  job.error = safeError;
  const ids = Array.from(new Set(chunkIds.map(String)));
  if (ids.length === 0 || ids.length > 12) throw new Error('knowledge failure batch 大小无效');
  for (const chunkId of ids) {
    const state = job.chunks[chunkId];
    if (!state) throw new Error(`chunk 不属于当前 generation：${chunkId}`);
    if (state.status !== 'processing' && state.status !== 'pending') throw new Error(`chunk 当前不可标记失败：${chunkId}`);
    state.status = 'failed';
    state.error = safeError;
  }
  const staging = await readJson<KnowledgeShard>(stagingFile(docId, generationId));
  if (staging) {
    const idSet = new Set(ids);
    staging.entityMentions = staging.entityMentions.filter((item) => !idSet.has(item.chunkId));
    staging.entityRelations = staging.entityRelations.filter((item) => !idSet.has(item.chunkId));
    staging.argumentUnits = staging.argumentUnits.filter((item) => !idSet.has(item.chunkId));
    staging.argumentEdges = staging.argumentEdges.filter((item) => !idSet.has(item.chunkId));
    await writeJsonAtomic(stagingFile(docId, generationId), staging);
  }
  await finalizeIfTerminal(job, embedText);
  job.updatedAt = new Date().toISOString();
  await writeJsonAtomic(jobFile(docId), job);
  return summarize(job);
}

export async function recoverKnowledgeJobs(docIds: string[]): Promise<void> {
  for (const docId of docIds) {
    const job = await readJson<KnowledgeJob>(jobFile(docId));
    if (!job) continue;
    let changed = false;
    for (const state of Object.values(job.chunks)) {
      if (state.status === 'processing') {
        state.status = 'pending';
        changed = true;
      }
    }
    if (changed) {
      job.status = 'pending';
      job.updatedAt = new Date().toISOString();
      await writeJsonAtomic(jobFile(docId), job);
    }
  }
}

export async function deleteKnowledgeDocument(
  docId: string,
  embedText: EmbeddingGenerator = generateEmbedding,
): Promise<void> {
  await Promise.all([
    fs.rm(jobFile(docId), { force: true }),
    fs.rm(activeShardFile(docId), { force: true }),
  ]);
  const stagingRoot = path.resolve(indexDir(), 'staging');
  const target = path.resolve(stagingRoot, docId);
  if (path.dirname(target) !== stagingRoot) throw new Error('非法 knowledge staging 路径');
  await fs.rm(target, { recursive: true, force: true });
  await rebuildEntityCatalog(embedText);
}

export const KNOWLEDGE_DEFAULT_SETTINGS = DEFAULT_SETTINGS;
