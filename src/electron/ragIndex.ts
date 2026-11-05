import { promises as fs, constants as FS_CONSTANTS } from 'fs';
import path from 'path';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import {getBackgroundRagCompute} from './rag/backgroundComputeBridge.ts';
import type {
  UploadedDocument,
  DocumentChunk,
  DocumentSearchResult,
  DocumentSearchOptions,
  DocumentPreview,
  StructuredDocument,
} from '../types';
import { tokenize, buildDf, bm25Score, weightedFusion } from './hybridSearch.ts';
import { detectDocumentType } from './documentParsers.ts';
import {
  chunkSemanticText,
  chunkStructuredDocument,
  DOCUMENT_SEMANTIC_CHUNKING_VERSION,
  estimateEmbeddingTokens,
  semanticEmbeddingViews,
} from './rag/chunking.ts';
import {
  cosineSimilarity,
  generateEmbedding,
  generateEmbeddings,
} from './rag/embedding.ts';
import { buildSearchSnippet } from './rag/snippet.ts';
import { buildSentenceSpans, sourceBlocksForRange } from './rag/structuredDocument.ts';
import { atomicWriteTextFile } from './atomicWrite.ts';
import { withRagSourceTransaction } from './ragSourceTransactions.ts';
import { prepareDocumentRecovery } from './documentManifestRecovery';
import { materialDocIds } from '../services/textbook/materialScope.ts';
import { readActiveKnowledgeShards, readEntityCatalog } from './rag/knowledgeStore.ts';
import { readSavedDocumentGraph } from './rag/documentGraphStore.ts';
import { rankDocumentGraphEntries } from './rag/documentGraphRetrieval.ts';
import { readSavedDocumentArgumentV5 } from './rag/documentArgumentV5Store.ts';
import { rankDocumentArgumentV5Entries,documentArgumentV5TextChunks,isDocumentArgumentNodeTextSource } from './rag/documentArgumentV5Retrieval.ts';
import { isStructuredArgumentSource, readDocumentArgumentSourceBlocks, resolveDocumentArgumentV5Sources } from './rag/documentArgumentV5Sources.ts';
import {
  classifyDocumentQueryIntent,
  classifyDocumentQueryIntentLegacy,
  fuseKnowledgeChannelRanks,
  KNOWLEDGE_RETRIEVAL_VERSION,
  retrieveKnowledgeSignals,
  scopeKnowledgeCatalog,
  retrievalWeights,
} from './rag/knowledgeRetrieval.ts';
import {QA_GRAPH_LIMITS} from '../services/agent/qaDocumentGraph';
import {DEFAULT_DOCUMENT_RETRIEVAL_STRATEGY,mergeRetrievalRoutes,retrievalQueryFacets,selectRetrievalEntries,
  type DocumentRetrievalStrategy,type RetrievalEntryCandidate} from '../services/agent/documentRetrievalPolicy';

export const CURRENT_INDEX_SCHEMA_VERSION = DOCUMENT_SEMANTIC_CHUNKING_VERSION;

// 兼容 main.ts、noteRag.ts 及既有测试；实现已拆到可独立演进的 RAG 基础模块。
export { cosineSimilarity, generateEmbedding, setModelsDir } from './rag/embedding.ts';

/**
 * 资料文档 RAG 后端（运行在 Electron 主进程）。
 *
 * 文件布局：
 * - `<dataRoot>/documents/`        原始上传文件（按 docId 保留扩展名）
 * - `<dataRoot>/rag-index/manifest.json`  文档元数据（UploadedDocument[]）
 * - `<dataRoot>/rag-index/chunks-<docId>.json`  单个文档的分块 + 向量
 *
 * dataRoot 由 main.ts 启动时通过 setDataRoot() 注入。
 */

let dataRoot = '';
const documentSnapshotContext = new AsyncLocalStorage<{ root: string; active: boolean }>();

export function setDataRoot(root: string): void {
  dataRoot = root;
}

function currentRoot(): string {
  const snapshot = documentSnapshotContext.getStore();
  if (snapshot?.active) return snapshot.root;
  if (!dataRoot) throw new Error('rag_source_unconfigured_root');
  return path.resolve(dataRoot);
}

function documentsDirAt(root: string): string {
  return path.join(root, 'documents');
}

function ragIndexDirAt(root: string): string {
  return path.join(root, 'rag-index');
}

async function ensureDirsAt(root: string): Promise<void> {
  await fs.mkdir(documentsDirAt(root), { recursive: true });
  await fs.mkdir(ragIndexDirAt(root), { recursive: true });
}

export async function getDocumentsDir(): Promise<string> {
  const root = currentRoot();
  if (!documentSnapshotContext.getStore()?.active) await ensureDirsAt(root);
  return documentsDirAt(root);
}

export async function getRagIndexDir(): Promise<string> {
  const root = currentRoot();
  if (!documentSnapshotContext.getStore()?.active) await ensureDirsAt(root);
  return ragIndexDirAt(root);
}

/** Read APIs in this short callback remain bound to the root captured before queuing. */
export function withDocumentSourceSnapshot<T>(action: () => Promise<T>): Promise<T> {
  const root = currentRoot();
  return withRagSourceTransaction([root], async () => {
    const snapshot = { root, active: true };
    try { return await documentSnapshotContext.run(snapshot, action); }
    finally { snapshot.active = false; }
  });
}

/* ===== 分块与向量化 ===== */

/** 兼容旧调用名；返回值增加来源偏移，不破坏既有消费者。 */
export function chunkText(text: string) {
  return chunkSemanticText(text);
}

function mergeEmbeddingViews(vectors: number[][], weights: number[]): number[] {
  if (vectors.length === 0) return [];
  if (vectors.length === 1) return vectors[0];
  const dimensions = vectors[0].length;
  if (!dimensions || vectors.some((vector) => vector.length !== dimensions)) {
    throw new Error('语义分块向量维度不一致');
  }
  const merged = new Array<number>(dimensions).fill(0);
  let totalWeight = 0;
  for (let index = 0; index < vectors.length; index += 1) {
    const weight = Math.max(1, weights[index] || 1);
    totalWeight += weight;
    for (let dimension = 0; dimension < dimensions; dimension += 1) {
      merged[dimension] += vectors[index][dimension] * weight;
    }
  }
  const scale = totalWeight || 1;
  let norm = 0;
  for (let dimension = 0; dimension < dimensions; dimension += 1) {
    merged[dimension] /= scale;
    norm += merged[dimension] * merged[dimension];
  }
  norm = Math.sqrt(norm);
  return norm > 0 ? merged.map((value) => value / norm) : merged;
}

/** 切块并逐块向量化，返回 chunk 列表（不含落地） */
export async function vectorizeDocument(
  docId: string,
  fileName: string,
  text: string,
  structuredDocument?: StructuredDocument,
  progress?: (completed:number,total:number)=>void,
): Promise<DocumentChunk[]> {
  const background=getBackgroundRagCompute();if(background)return background.vectorize(docId,fileName,text,structuredDocument);
  if (structuredDocument && structuredDocument.normalizedText !== text) throw new Error('结构化原文与分块输入不一致');
  const pieces = structuredDocument ? chunkStructuredDocument(structuredDocument) : chunkText(text);
  const chunks: DocumentChunk[] = [];
  const hashOccurrences = new Map<string, number>();
  for (let i = 0; i < pieces.length; i++) {
    // The bundled tokenizer truncates at 128 tokens. Preserve one complete
    // source chunk, embed every sentence-aligned view, then pool locally.
    const embeddingViews = semanticEmbeddingViews(pieces[i].content, pieces[i].sectionPath);
    const viewVectors = await generateEmbeddings(embeddingViews);
    const embedding = mergeEmbeddingViews(viewVectors,
      embeddingViews.map((view) => estimateEmbeddingTokens(view)));
    const contentHash = stableContentHash(`${pieces[i].sectionPath}\n${pieces[i].content}`);
    const occurrence = (hashOccurrences.get(contentHash) || 0) + 1;
    hashOccurrences.set(contentHash, occurrence);
    const sourceBlocks = structuredDocument
      ? sourceBlocksForRange(structuredDocument, pieces[i].textStart, pieces[i].textEnd)
      : [];
    const chunkId = `${docId}#${contentHash}-${occurrence}`;
    chunks.push({
      id: chunkId,
      docId,
      fileName,
      index: i,
      sectionPath: pieces[i].sectionPath,
      content: pieces[i].content,
      textStart: pieces[i].textStart,
      textEnd: pieces[i].textEnd,
      paragraphCount: pieces[i].paragraphCount,
      forcedSplit: pieces[i].forcedSplit,
      sentenceSpans: buildSentenceSpans(chunkId, pieces[i].content, pieces[i].textStart,
        !sourceBlocks.some((block) => block.locator.kind === 'pdf')),
      sourceBlockIds: sourceBlocks.map((block) => block.id),
      sourceLocators: sourceBlocks.flatMap((block) => block.sourceFragments?.map((fragment) => fragment.locator)
        || [block.locator]),
      contentHash,
      schemaVersion: CURRENT_INDEX_SCHEMA_VERSION,
      embeddingModelVersion: 'paraphrase-multilingual-MiniLM-L12-v2:semantic-views-v3',
      embeddingViewCount: embeddingViews.length,
      embedding,
    });
    progress?.(i+1,pieces.length);
  }
  return chunks;
}

function stableContentHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/* ===== chunks 文件读写 ===== */

function assertDocumentId(docId: string): void {
  if (typeof docId !== 'string' || !docId || docId.length > 300 || docId !== docId.trim()
    || /[<>:"/\\|?*\u0000-\u001f\u007f]/u.test(docId) || /[. ]$/u.test(docId)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(docId)) {
    throw new Error('rag_source_invalid_document_id');
  }
}

function chunksFileAt(root: string, docId: string): string {
  assertDocumentId(docId);
  return path.join(ragIndexDirAt(root), `chunks-${docId}.json`);
}

function structuredDocumentFileAt(root: string, docId: string): string {
  assertDocumentId(docId);
  return path.join(ragIndexDirAt(root), `structured-${docId}.json`);
}

async function unlinkIfMissingAllowed(file: string): Promise<void> {
  try { await fs.unlink(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

export async function writeStructuredDocumentFile(document: StructuredDocument,options:{assertCurrent?:()=>void|Promise<void>}={}): Promise<void> {
  const root = currentRoot();
  const file = structuredDocumentFileAt(root, document.docId);
  const text = JSON.stringify(document);
  return withRagSourceTransaction([root], async () => {
    await options.assertCurrent?.();
    await ensureDirsAt(root);
    await atomicWriteTextFile(file, text);
  });
}

export async function readStructuredDocumentFile(docId: string): Promise<StructuredDocument | null> {
  const root = currentRoot();
  try {
    const value = JSON.parse(await fs.readFile(structuredDocumentFileAt(root, docId), 'utf-8')) as StructuredDocument;
    return value?.schemaVersion === 1 && value.docId === docId && Array.isArray(value.blocks)
      ? value
      : null;
  } catch {
    return null;
  }
}

export async function deleteStructuredDocumentFile(docId: string): Promise<void> {
  const root = currentRoot();
  const file = structuredDocumentFileAt(root, docId);
  return withRagSourceTransaction([root], () => unlinkIfMissingAllowed(file));
}

export async function writeChunksFile(docId: string, chunks: DocumentChunk[],options:{assertCurrent?:()=>void|Promise<void>}={}): Promise<void> {
  const root = currentRoot();
  const file = chunksFileAt(root, docId);
  const text = JSON.stringify(chunks);
  return withRagSourceTransaction([root], async () => {
    await options.assertCurrent?.();
    await ensureDirsAt(root);
    await atomicWriteTextFile(file, text);
  });
}

export async function readChunksFile(docId: string): Promise<DocumentChunk[]> {
  const root = currentRoot();
  try {
    const text = await fs.readFile(chunksFileAt(root, docId), 'utf-8');
    return JSON.parse(text) as DocumentChunk[];
  } catch {
    return [];
  }
}

/** 读取指定 docId 集合的所有 chunks（用于检索） */
async function readAllChunks(docIds: string[]): Promise<DocumentChunk[]> {
  const all: DocumentChunk[] = [];
  for (const id of docIds) {
    all.push(...(await readChunksFile(id)));
  }
  return all;
}

export async function deleteChunksFile(docId: string): Promise<void> {
  const root = currentRoot();
  const file = chunksFileAt(root, docId);
  return withRagSourceTransaction([root], () => unlinkIfMissingAllowed(file));
}

/* ===== manifest（文档元数据） ===== */

function manifestFileAt(root: string): string {
  return path.join(ragIndexDirAt(root), 'manifest.json');
}

function assertManifestRow(raw: unknown, ids: Set<string>): void {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('rag_source_invalid_manifest');
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== 'string' || typeof value.fileName !== 'string' || !value.fileName
    || value.fileName.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(value.fileName)) {
    throw new Error('rag_source_invalid_manifest');
  }
  assertDocumentId(value.id);
  const identity = process.platform === 'win32' ? value.id.toLowerCase() : value.id;
  if (ids.has(identity)) throw new Error('rag_source_duplicate_manifest_id');
  ids.add(identity);
  const detected = detectDocumentType(value.fileName);
  // Old rows may omit derived extension/type; the known filename descriptor is sufficient.
  if (!detected || (value.extension !== undefined && (typeof value.extension !== 'string'
    || value.extension.toLocaleLowerCase() !== detected.extension))
    || (value.fileType !== undefined && value.fileType !== detected.fileType)
    || (value.indexable !== undefined && typeof value.indexable !== 'boolean')
    || (value.needsReindex !== undefined && typeof value.needsReindex !== 'boolean')
    || (value.sourceReadOnly !== undefined && typeof value.sourceReadOnly !== 'boolean')) {
    throw new Error('rag_source_invalid_manifest');
  }
  for (const key of ['size', 'chunkCount', 'totalChars', 'indexSchemaVersion', 'knowledgeIndexedChunks',
    'knowledgeTotalChunks', 'knowledgeEntityCount', 'knowledgeArgumentCount', 'knowledgeExtractorVersion', 'knowledgePromptVersion']) {
    if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] < 0)) {
      throw new Error('rag_source_invalid_manifest');
    }
  }
  if (value.communitySource !== undefined) {
    if (!value.communitySource || typeof value.communitySource !== 'object' || Array.isArray(value.communitySource)) throw new Error('rag_source_invalid_manifest');
    const source = value.communitySource as Record<string, unknown>;
    if (!Object.keys(source).every(key => ['accountId','entryId','versionId','role','kind'].includes(key)) || !['accountId','entryId','versionId'].every(key => typeof source[key] === 'string' && /^[a-zA-Z0-9_-]{1,150}$/.test(source[key] as string)) || !['main','attachment'].includes(String(source.role)) || (source.kind!==undefined&&!['snapshot','file'].includes(String(source.kind)))) throw new Error('rag_source_invalid_manifest');
  }
  for (const key of ['error', 'sourceUrl', 'parseError', 'parsedAt', 'knowledgeGenerationId', 'knowledgeError', 'uploadAt', 'category']) {
    if (value[key] !== undefined && typeof value[key] !== 'string') throw new Error('rag_source_invalid_manifest');
  }
  if (typeof value.category === 'string' && (!value.category.trim() || value.category.length > 80
    || /[\u0000-\u001f\u007f]/u.test(value.category))) throw new Error('rag_source_invalid_manifest');
  const enums: Array<[string, string[]]> = [
    ['status', ['stored', 'pending', 'processing', 'ready', 'failed']],
    ['parseStatus', ['pending', 'processing', 'ready', 'failed', 'unsupported']],
    ['knowledgeStatus', ['disabled', 'pending', 'processing', 'ready', 'partial', 'failed']],
    ['processingPolicy', ['body_only']],
  ];
  for (const [key, allowed] of enums) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || !allowed.includes(value[key]))) {
      throw new Error('rag_source_invalid_manifest');
    }
  }
}

async function readManifestAt(root: string, strict = false): Promise<UploadedDocument[]> {
  try {
    const text = await fs.readFile(manifestFileAt(root), 'utf-8');
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) {
      if (strict) throw new Error('rag_source_invalid_manifest');
      return [];
    }
    if (strict) {
      const ids = new Set<string>();
      for (const row of arr) assertManifestRow(row, ids);
    }
    return arr.flatMap((raw): UploadedDocument[] => {
      if (!raw || typeof raw !== 'object') return [];
      const value = raw as Partial<UploadedDocument> & { fileName?: string };
      const detected = detectDocumentType(String(value.fileName || ''));
      const extension = String(value.extension || detected?.extension || '').toLocaleLowerCase();
      const fileType = detected?.fileType || value.fileType;
      if (!value.id || !value.fileName || !fileType || !extension) return [];
      const indexable = typeof value.indexable === 'boolean' ? value.indexable : Boolean(detected?.indexable);
      return [{
        id: String(value.id),
        fileName: String(value.fileName),
        category: typeof value.category === 'string' && value.category.trim() ? value.category.trim() : undefined,
        fileType,
        extension,
        indexable,
        size: Number(value.size) || 0,
        status: indexable ? (value.status || 'pending') : 'stored',
        chunkCount: Number(value.chunkCount) || 0,
        totalChars: Number(value.totalChars) || 0,
        error: value.error ? String(value.error) : undefined,
        sourceUrl: value.sourceUrl ? String(value.sourceUrl) : undefined,
        communitySource: value.communitySource,
        sourceReadOnly: value.sourceReadOnly===true,
        parseStatus: ['pending', 'processing', 'ready', 'failed', 'unsupported'].includes(value.parseStatus || '')
          ? value.parseStatus : undefined,
        parseError: value.parseError ? String(value.parseError) : undefined,
        parsedAt: value.parsedAt ? String(value.parsedAt) : undefined,
        indexSchemaVersion: Math.max(0, Math.floor(Number(value.indexSchemaVersion) || 0)),
        needsReindex: value.status === 'ready'
          && Math.max(0, Math.floor(Number(value.indexSchemaVersion) || 0)) < CURRENT_INDEX_SCHEMA_VERSION,
        knowledgeStatus: value.knowledgeStatus || 'disabled',
        processingPolicy: value.processingPolicy === 'body_only' ? 'body_only' : undefined,
        knowledgeGenerationId: value.knowledgeGenerationId ? String(value.knowledgeGenerationId) : undefined,
        knowledgeIndexedChunks: Math.max(0, Math.floor(Number(value.knowledgeIndexedChunks) || 0)),
        knowledgeTotalChunks: Math.max(0, Math.floor(Number(value.knowledgeTotalChunks) || 0)),
        knowledgeEntityCount: Math.max(0, Math.floor(Number(value.knowledgeEntityCount) || 0)),
        knowledgeArgumentCount: Math.max(0, Math.floor(Number(value.knowledgeArgumentCount) || 0)),
        knowledgeExtractorVersion: Math.max(0, Math.floor(Number(value.knowledgeExtractorVersion) || 0)),
        knowledgePromptVersion: Math.max(0, Math.floor(Number(value.knowledgePromptVersion) || 0)),
        knowledgeError: value.knowledgeError ? String(value.knowledgeError) : undefined,
        uploadAt: String(value.uploadAt || new Date(0).toISOString()),
      }];
    });
  } catch (error) {
    if (strict && (error as NodeJS.ErrnoException).code !== 'ENOENT') {
      if (error instanceof Error && error.message.startsWith('rag_source_')) throw error;
      throw new Error('rag_source_invalid_manifest');
    }
    return [];
  }
}

export async function readManifest(strict = false): Promise<UploadedDocument[]> {
  const root = currentRoot();
  if (!documentSnapshotContext.getStore()?.active) await ensureDirsAt(root);
  return readManifestAt(root, strict);
}

/** Keep original rows byte-equivalent as JSON values, including unknown metadata.
 * A missing manifest may be recovered; an unreadable/corrupt one is never replaced. */
export function prepareDocumentManifestRecovery() {
  const root = currentRoot();
  return prepareDocumentRecovery(root, {
    validateId: assertDocumentId,
    transaction: action => withRagSourceTransaction([root], action),
    read: async () => {
      try {
        const rows = JSON.parse(await fs.readFile(manifestFileAt(root), 'utf8'));
        if (!Array.isArray(rows)) throw new Error('资料清单损坏，请先备份并恢复原清单，扫描不会覆盖它');
        const ids = new Set<string>();
        for (const row of rows) assertManifestRow(row, ids);
        return rows as UploadedDocument[];
      }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    },
    write: async documents => {
      await fs.mkdir(ragIndexDirAt(root), { recursive: true });
      await atomicWriteTextFile(manifestFileAt(root), JSON.stringify(documents, null, 2), { allowCopyFallback: false });
    },
  });
}

async function writeManifestUnlocked(root: string, docs: UploadedDocument[]): Promise<void> {
  await ensureDirsAt(root);
  await atomicWriteTextFile(manifestFileAt(root), JSON.stringify(docs, null, 2));
}

export function writeManifest(docs: UploadedDocument[]): Promise<void> {
  const root = currentRoot();
  const snapshot = JSON.parse(JSON.stringify(docs)) as UploadedDocument[];
  return withRagSourceTransaction([root], () => writeManifestUnlocked(root, snapshot));
}

export async function upsertManifestEntries(entries: UploadedDocument[]): Promise<UploadedDocument[]> {
  const root = currentRoot();
  const snapshot = JSON.parse(JSON.stringify(entries)) as UploadedDocument[];
  return withRagSourceTransaction([root], async () => {
    const docs = await readManifestAt(root, true);
    const map = new Map(docs.map((d) => [d.id, d]));
    for (const e of snapshot) map.set(e.id, e);
    const next = Array.from(map.values());
    await writeManifestUnlocked(root, next);
    return next;
  });
}

/** Host-generated records and selected local files only; no parser/model/network work. */
export function commitDocumentSourceImports(entries: Array<{ document: UploadedDocument; sourcePath: string }>,
  isCurrent?: () => boolean, reuseIdenticalHash?: string): Promise<UploadedDocument[]> {
  const root = currentRoot();
  if (!Array.isArray(entries) || !entries.length || entries.length > 10_000) throw new Error('rag_source_invalid_import');
  const snapshot = structuredClone(entries);
  return withRagSourceTransaction([root], async () => {
    if (isCurrent && !isCurrent()) throw new Error('rag_source_environment_changed');
    const docs = await readManifestAt(root, true);
    const identities = new Set(docs.map(doc => process.platform === 'win32' ? doc.id.toLowerCase() : doc.id));
    const documents = documentsDirAt(root), index = ragIndexDirAt(root);
    await assertSourceDeleteDirectory(root);
    await assertSourceDeleteDirectory(documents);
    await assertSourceDeleteDirectory(index);
    await assertSourceDeleteFile(manifestFileAt(root));
    const targets: Array<{ source: string; target: string; document: UploadedDocument }> = [];
    for (const entry of snapshot) {
      if (!entry || typeof entry !== 'object' || !entry.document || typeof entry.sourcePath !== 'string'
        || !path.isAbsolute(entry.sourcePath) || /[\u0000-\u001f\u007f]/u.test(entry.sourcePath)) {
        throw new Error('rag_source_invalid_import');
      }
      assertManifestRow(entry.document, identities);
      const descriptor = detectDocumentType(entry.document.fileName)!;
      const readonlySnapshot = entry.document.communitySource?.kind === 'snapshot'
        && entry.document.sourceReadOnly === true && descriptor.extension === '.md'
        && entry.document.status === 'stored' && entry.document.knowledgeStatus === 'disabled';
      if (entry.document.extension !== descriptor.extension || entry.document.fileType !== descriptor.fileType
        || entry.document.indexable !== (readonlySnapshot ? false : descriptor.indexable)) throw new Error('rag_source_invalid_import');
      const source = path.resolve(entry.sourcePath);
      const info = await fs.lstat(source);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 100 * 1024 * 1024) throw new Error('rag_source_invalid_import');
      const target = path.resolve(documents, `${entry.document.id}${entry.document.extension}`);
      if (path.dirname(target) !== documents) throw new Error('rag_source_invalid_import');
      targets.push({ source, target, document: entry.document });
    }
    await ensureDirsAt(root);
    // New opaque IDs never overwrite existing raw files, including unreferenced orphans.
    // A failed commit may leave new orphans; without a manifest entry they gain no source authority.
    for (const entry of targets) {
      try { await fs.copyFile(entry.source, entry.target, FS_CONSTANTS.COPYFILE_EXCL); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !reuseIdenticalHash || targets.length !== 1
          || !/^[a-f\d]{64}$/.test(reuseIdenticalHash)) throw error;
        const stat = await fs.lstat(entry.target);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.document.size) throw error;
        const existing=createHash('sha256').update(await fs.readFile(entry.target)).digest('hex');
        const incoming=createHash('sha256').update(await fs.readFile(entry.source)).digest('hex');
        if(existing!==reuseIdenticalHash||incoming!==reuseIdenticalHash)throw error;
      }
    }
    const created = targets.map(entry => entry.document);
    await writeManifestUnlocked(root, [...docs, ...created]);
    return structuredClone(created);
  });
}

export async function updateManifest(docId: string, patch: Partial<UploadedDocument>): Promise<void> {
  const root = currentRoot();
  // Keep explicit undefined values: callers use them to clear stale errors/status fields.
  const snapshot = { ...patch };
  return withRagSourceTransaction([root], async () => {
    const docs = await readManifestAt(root, true);
    const idx = docs.findIndex((d) => d.id === docId);
    if (idx === -1) return;
    docs[idx] = { ...docs[idx], ...snapshot };
    await writeManifestUnlocked(root, docs);
  });
}

export async function deleteManifestEntry(docId: string): Promise<void> {
  const root = currentRoot();
  return withRagSourceTransaction([root], async () => {
    const docs = await readManifestAt(root, true);
    await writeManifestUnlocked(root, docs.filter((d) => d.id !== docId));
  });
}

async function assertSourceDeleteDirectory(directory: string): Promise<void> {
  try {
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('rag_source_unsafe_delete_directory');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

async function assertSourceDeleteFile(file: string): Promise<void> {
  try {
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('rag_source_unsafe_delete_file');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

/** One source mutation: never mix raw files from one root with another root's manifest. */
export function deleteDocumentSourceFiles(docId: string): Promise<void> {
  const root = currentRoot();
  assertDocumentId(docId);
  return withRagSourceTransaction([root], async () => {
    const documents = documentsDirAt(root);
    const index = ragIndexDirAt(root);
    await assertSourceDeleteDirectory(root);
    await assertSourceDeleteDirectory(documents);
    await assertSourceDeleteDirectory(index);
    const docs = await readManifestAt(root, true);
    const document = docs.find((item) => item.id === docId);
    const files = [chunksFileAt(root, docId), structuredDocumentFileAt(root, docId), path.join(index,`argument-graph-${docId}.json`), path.join(index,`argument-graph-v5-${docId}.json`),
      path.join(index,`argument-graph-v5-${docId}.pending.json`),path.join(index,`argument-rebuild-${docId}.json`),path.join(index,`entity-graph-${docId}.json`),
      ...['extract','bridge'].map(stage=>path.join(index,`argument-response-v5-${docId}-${stage}.json`))];
    const archivePrefix=`argument-graph-v5-${docId}.archive-`;
    for(const name of await fs.readdir(index))if(name.startsWith(archivePrefix)&&/^[0-9a-f-]{36}\.json$/u.test(name.slice(archivePrefix.length)))files.push(path.join(index,name));
    if (document) {
      if (!/^\.[a-z0-9]{1,10}$/u.test(document.extension)) throw new Error('rag_source_invalid_document_extension');
      const original = path.resolve(documents, `${docId}${document.extension}`);
      if (path.dirname(original) !== documents) throw new Error('rag_source_unsafe_delete_path');
      files.unshift(original);
    }
    // Validate every target before the first unlink; only ENOENT is harmless.
    for (const file of files) await assertSourceDeleteFile(file);
    await assertSourceDeleteFile(manifestFileAt(root));
    for (const file of files) await unlinkIfMissingAllowed(file);
    await writeManifestUnlocked(root, docs.filter((item) => item.id !== docId));
  });
}

/** 判定文档是否仍存在于 manifest（删除取消检查） */
export async function documentExists(docId: string): Promise<boolean> {
  const docs = await readManifest();
  return docs.some((d) => d.id === docId);
}

/**
 * 仅向渲染进程返回可审计的文本分块，不返回 embedding 或原始绝对路径。
 * 内容和条目数均设上限，避免大文档一次性占用过多 IPC/界面内存。
 */
export async function getDocumentPreview(
  docId: string,
  limit = 40,
  focusChunkId?: string,
): Promise<DocumentPreview | null> {
  const document = (await readManifest()).find((item) => item.id === String(docId || ''));
  if (!document) return null;
  let allChunks = focusChunkId && isStructuredArgumentSource(document.id, focusChunkId)
    ? await readDocumentArgumentSourceBlocks(await getRagIndexDir(), document.id)
    : document.status === 'ready' ? await readChunksFile(document.id) : [];
  if(focusChunkId&&isDocumentArgumentNodeTextSource(document.id,focusChunkId)){
    const dir=await getRagIndexDir(),graph=await readSavedDocumentArgumentV5(dir,document.id,allChunks);
    if(graph){const sources=await resolveDocumentArgumentV5Sources(dir,graph,allChunks);allChunks=documentArgumentV5TextChunks([graph],sources);}
  }
  const safeLimit = Math.max(1, Math.min(80, Math.floor(limit) || 40));
  const requestedFocus = String(focusChunkId || '').slice(0, 200);
  const focusIndex = requestedFocus
    ? allChunks.findIndex((chunk) => chunk.id === requestedFocus)
    : -1;
  const start = focusIndex >= 0
    ? Math.max(0, Math.min(focusIndex - Math.floor(safeLimit / 2), allChunks.length - safeLimit))
    : 0;
  const chunks = allChunks.slice(start, start + safeLimit).map((chunk) => ({
    id: chunk.id,
    index: chunk.index,
    sectionPath: String(chunk.sectionPath || '').slice(0, 300),
    content: String(chunk.content || '').slice(0, 1_200),
    contentLength: String(chunk.content || '').length,
    contentHash: createHash('sha256').update(String(chunk.content || ''), 'utf8').digest('hex'),
    sourceLocators: chunk.sourceLocators,
  }));
  return {
    document,
    chunks,
    totalChunkCount: allChunks.length,
    truncated: allChunks.length > chunks.length,
    focusedChunkId: focusIndex >= 0 ? requestedFocus : undefined,
  };
}

/* ===== 检索 ===== */

async function searchPassageDocuments(
  query: string,
  k = 5,
  queryEmbedding?: number[],
  allowedDocIds?: string[],
): Promise<DocumentSearchResult[]> {
  const q = (query || '').trim();
  if (!q) return [];
  // 未传范围时保留旧入口的模型调用顺序；教材 scoped 调用则先检查范围内是否有索引。
  const originalQueryVector = queryEmbedding || (allowedDocIds === undefined ? await generateEmbedding(q) : undefined);
  const manifest = await readManifest();
  const readyIds = manifest.filter((d) => d.status === 'ready'
    && (allowedDocIds === undefined || allowedDocIds.includes(d.id))).map((d) => d.id);
  if (readyIds.length === 0) return [];

  const allChunks = await readAllChunks(readyIds);
  if (allChunks.length === 0) return [];

  const qv = originalQueryVector || await generateEmbedding(q);
  // 稀疏检索：中文 bigram + 英文词的 BM25 分数
  const queryTokens = tokenize(q);
  const df = buildDf(allChunks.map((c) => c.content));
  const lens = allChunks.map((c) => Math.max(tokenize(c.content).length, 1));
  const avgLen = lens.reduce((a, b) => a + b, 0) / Math.max(allChunks.length, 1);
  const sparseScore = allChunks.map((c) =>
    bm25Score(queryTokens, c.content, df, allChunks.length, avgLen),
  );

  // 密集检索：余弦相似度
  const denseScore = allChunks.map((c) => cosineSimilarity(qv, c.embedding));

  // 相似度阈值：语义与关键词「都无关」的块直接丢弃（治本：压住纯语义误命中）
  const SEMANTIC_THRESHOLD = 0.28;
  const survivors = allChunks
    .map((c, i) => ({ chunk: c, dense: denseScore[i], sparse: sparseScore[i] }))
    .filter((r) => r.dense >= SEMANTIC_THRESHOLD || r.sparse > 0);

  if (survivors.length === 0) return [];

  // 加权融合：关键词分（0.65 权重）略占优，保留分数的绝对强弱（避免 RRF 排名稀释）
  const fused = weightedFusion(
    survivors.map((r) => ({ id: r.chunk.id, dense: r.dense, sparse: r.sparse })),
    0.35,
  );

  // 精确短语加成：完整命中查询串的块额外加分（去除空白后比较，区分「上游产业链」vs「产业链协同」）
  const qCompact = q.replace(/\s+/g, '');
  const scored = survivors
    .map((r) => {
      const contentCompact = r.chunk.content.replace(/\s+/g, '');
      const bonus = qCompact.length >= 2 && contentCompact.includes(qCompact) ? 0.5 : 0;
      const snippet = buildSearchSnippet(r.chunk.content, q);
      return {
        docId: r.chunk.docId,
        fileName: r.chunk.fileName,
        chunkId: r.chunk.id,
        sectionPath: r.chunk.sectionPath,
        score: r.dense, // 保留语义分（0~1）供前端可选展示，排序以下方 fusedScore 为准
        fusedScore: (fused.get(r.chunk.id) || 0) + bonus,
        snippet: snippet.text,
        hitStart: snippet.hitStart,
        sourceLocators: r.chunk.sourceLocators,
      };
    })
    .sort((a, b) => b.fusedScore - a.fusedScore);

  // 暂保留已评测基线的资料多样性限制；取消配额需在重建后的索引上重新验收。
  const perDoc = new Map<string, number>();
  return scored.filter((r) => {
    const count = perDoc.get(r.docId) || 0;
    if (count >= 3) return false;
    perDoc.set(r.docId, count + 1);
    return true;
  }).slice(0, k).map((r) => ({
      docId: r.docId,
      fileName: r.fileName,
      chunkId: r.chunkId,
      sectionPath: r.sectionPath,
      score: r.score,
      snippet: r.snippet,
      hitStart: r.hitStart,
      sourceLocators: r.sourceLocators,
    }));
}

/**
 * 兼容入口：knowledge 层关闭时仍使用 passage-only；
 * 用户显式开启 knowledge 层后，在内部进行 passage/entity/argument 三路融合。
 */
export async function searchDocuments(
  query: string,
  k = 5,
  options?: DocumentSearchOptions,
  // Host-only dependency injection for deterministic integration tests; never exposed through IPC options.
  dependencies: {embed?: (text: string) => Promise<number[]>;retrievalStrategy?:DocumentRetrievalStrategy} = {},
): Promise<DocumentSearchResult[]> {
  const q = String(query || '').trim();
  if (!q) return [];
  const safeK = Math.max(1, Math.min(20, Math.floor(k) || 5));
  const allowedDocIds = options?.allowedDocIds === undefined ? undefined : materialDocIds({ allowedDocIds: options.allowedDocIds });
  if (allowedDocIds?.length === 0) return [];
  const requestedMode = options?.mode;
  const mode = requestedMode === 'auto' || requestedMode === 'passage' || requestedMode === 'entity' || requestedMode === 'argument'
    ? requestedMode
    : 'auto';
  if (mode === 'passage') return searchPassageDocuments(q, safeK, undefined, allowedDocIds);

  const embed = dependencies.embed || generateEmbedding;
  const strategy=dependencies.retrievalStrategy||DEFAULT_DOCUMENT_RETRIEVAL_STRATEGY;
  const intent=strategy==='intent'?classifyDocumentQueryIntent(q):classifyDocumentQueryIntentLegacy(q);
  const originalQueryVector = allowedDocIds === undefined ? await embed(q) : undefined;
  const manifest = await readManifest();
  const readyDocs = manifest.filter((document) => (document.status === 'ready' || document.parseStatus === 'ready')
    && (allowedDocIds === undefined || allowedDocIds.includes(document.id)));
  const readyIds = readyDocs.map((document) => document.id);
  if (readyIds.length === 0) return [];
  const allChunks = await readAllChunks(readyIds);
  const queryEmbedding = originalQueryVector || await embed(q);
  const [passageResults, catalog, shards] = await Promise.all([
    mode === 'auto' ? searchPassageDocuments(q, safeK * 6, queryEmbedding, allowedDocIds) : Promise.resolve([]),
    readEntityCatalog(),
    readActiveKnowledgeShards(readyIds),
  ]);
  const nativeDir = await getRagIndexDir();
  // One active argument index per document. A leftover legacy file must never
  // re-enter retrieval after v5 publication, even if cleanup was interrupted.
  const v5Graphs=(await Promise.all(readyDocs.map(d=>readSavedDocumentArgumentV5(nativeDir,d.id,allChunks))))
    .filter(g=>g!==null).filter(g=>g.sourceBasis || readyDocs.some(d=>d.id===g.docId&&d.status==='ready'&&!d.needsReindex));
  const originalArgumentSources = (await Promise.all(v5Graphs.map(g => resolveDocumentArgumentV5Sources(nativeDir, g, allChunks)))).flat();
  const argumentSources = [...originalArgumentSources,...documentArgumentV5TextChunks(v5Graphs,originalArgumentSources)];
  const v5Ids=new Set(v5Graphs.map(g=>g.docId));
  const activeShards=shards.map(s=>v5Ids.has(s.docId)?{...s,argumentUnits:[],argumentEdges:[]}:s);
  const signals = retrieveKnowledgeSignals({
    query: q,
    queryEmbedding,
    chunks: allChunks,
    catalog: allowedDocIds === undefined ? catalog : scopeKnowledgeCatalog(catalog, shards),
    shards:activeShards,
    mode,
    expandGraph: options?.expandGraph !== false,
    queryIntent:intent,
  });
  // Extraction permission controls model calls, not read-only retrieval of existing graphs.
  const nativeGraphs = (await Promise.all(readyDocs.filter(d => !d.needsReindex&&!v5Ids.has(d.id)).map(d => readSavedDocumentGraph(nativeDir,d.id,allChunks)))).filter(g => g !== null);
  const entityGraphs=await Promise.all(v5Graphs.map(async g=>{try{return JSON.parse(await fs.readFile(path.join(nativeDir,`entity-graph-${g.docId}.json`),'utf8'));}catch{return null;}}));
  const facetVectors=strategy==='intent'&&v5Graphs.length?await Promise.all(retrievalQueryFacets(q).map(embed)):[];
  const nativeEntries:Array<{docId:string;nodeId:string;chunkIds:string[];score:number;entityScore:number;text:string;denseRank?:number;sparseRank?:number;facetRanks?:Array<number|undefined>}>
    = [...rankDocumentGraphEntries(nativeGraphs,q,queryEmbedding),...rankDocumentArgumentV5Entries(v5Graphs,q,queryEmbedding,entityGraphs.filter(Boolean),allChunks,argumentSources,
    {preserveHeads:strategy!=='legacy',facetVectors})]
    .sort((a,b)=>(b.score+b.entityScore)-(a.score+a.entityScore));
  if (mode === 'auto' || mode === 'argument' || mode === 'entity') for (const entry of nativeEntries) for (const chunkId of entry.chunkIds) {
    const signal = signals.get(chunkId) || {chunkId,entityScore:0,argumentScore:0,entities:[],entityRelations:[],arguments:[],argumentEdges:[],relationSummaries:[]};
    signal.argumentScore = Math.max(signal.argumentScore,entry.score);
    signal.entityScore = Math.max(signal.entityScore,entry.entityScore);
    signals.set(chunkId,signal);
  }
  if (signals.size === 0) return mode === 'auto' ? passageResults.slice(0, safeK) : [];

  const weights = mode === 'entity'
    ? { passage: 0, entity: 1, argument: 0 }
    : mode === 'argument'
      ? { passage: 0, entity: 0, argument: 1 }
      : retrievalWeights(intent);
  const rankScores = fuseKnowledgeChannelRanks({
    passage: passageResults.map((result) => result.chunkId),
    entity: [...signals.values()]
      .filter((signal) => signal.entityScore > 0)
      .sort((left, right) => right.entityScore - left.entityScore)
      .map((signal) => signal.chunkId),
    argument: [...signals.values()]
      .filter((signal) => signal.argumentScore > 0)
      .sort((left, right) => right.argumentScore - left.argumentScore)
      .map((signal) => signal.chunkId),
  }, weights);
  if (rankScores.size === 0) return mode === 'auto' ? passageResults.slice(0, safeK) : [];

  const passageByChunk = new Map(passageResults.map((result) => [result.chunkId, result]));
  const chunkById = new Map([...allChunks, ...argumentSources].map((chunk) => [chunk.id, chunk]));
  const maxRankScore = Math.max(...rankScores.values(), 1e-9);
  const ranked = [...rankScores.entries()]
    .sort((left, right) => right[1] - left[1])
    .flatMap(([chunkId, rankScore]): DocumentSearchResult[] => {
      const chunk = chunkById.get(chunkId);
      if (!chunk) return [];
      const passage = passageByChunk.get(chunkId);
      const signal = signals.get(chunkId);
      const focusText = signal?.arguments.find((item) => item.match === 'direct')?.text
        || signal?.entities.find((item) => item.match === 'direct')?.canonicalName
        || q;
      const snippet = passage || buildSearchSnippet(chunk.content, focusText);
      const matchKinds: NonNullable<DocumentSearchResult['matchKinds']> = [];
      if (passage) matchKinds.push('passage');
      if (signal?.entityScore) matchKinds.push('entity');
      if (signal?.argumentScore) matchKinds.push('argument');
      return [{
        docId: chunk.docId,
        fileName: chunk.fileName,
        chunkId: chunk.id,
        sectionPath: chunk.sectionPath,
        score: Math.min(1, Math.max(0, rankScore / maxRankScore)),
        snippet: typeof snippet === 'object' && 'snippet' in snippet ? snippet.snippet : snippet.text,
        hitStart: passage?.hitStart,
        sourceLocators: chunk.sourceLocators,
        matchKinds,
        entities: signal?.entities,
        entityRelations: signal?.entityRelations,
        arguments: signal?.arguments,
        documentGraphAnchors: nativeEntries.filter(e => e.docId === chunk.docId && e.chunkIds.includes(chunk.id))
          .slice(0,3).map(({docId,nodeId}) => ({docId,nodeId})),
        argumentEdges: signal?.argumentEdges,
        relationSummary: signal?.relationSummaries.join('；').slice(0, 1_200) || undefined,
        retrievalVersion: KNOWLEDGE_RETRIEVAL_VERSION,
      }];
    });

  const perDocument = new Map<string, number>();
  if(strategy==='legacy')return ranked.filter((item) => {
    const count = perDocument.get(item.docId) || 0;
    if (count >= 3) return false;
    perDocument.set(item.docId, count + 1);
    return true;
  }).slice(0, safeK);
  const result=mergeRetrievalRoutes(ranked,mode==='auto'?passageResults.map(h=>h.chunkId):[],
    mode==='entity'?[]:nativeEntries.flatMap(e=>e.chunkIds),safeK,
    hit=>JSON.stringify([hit.docId,chunkById.get(hit.chunkId)?.content.trim()||hit.chunkId]));
  const selectedDocs=new Set(result.map(h=>h.docId));
  const entries:RetrievalEntryCandidate[]=nativeEntries.filter(e=>selectedDocs.has(e.docId)&&(mode!=='entity'||e.entityScore>0)).map(e=>({
    docId:e.docId,nodeId:e.nodeId,score:e.score+e.entityScore,channels:['argument'],
    denseRank:e.denseRank,sparseRank:e.sparseRank,facetRanks:e.facetRanks,
  }));
  const independent=selectRetrievalEntries(entries,QA_GRAPH_LIMITS.anchors),attached=new Set<string>();
  for(const hit of result) {
    if(attached.has(hit.docId))continue;attached.add(hit.docId);
    hit.documentGraphEntryCandidates=independent.filter(e=>e.docId===hit.docId).map(e=>({...e,channels:[...e.channels,
      ...(e.denseRank===1?['dense' as const]:[]),...(e.sparseRank===1?['sparse' as const]:[]),
      ...(e.facetRanks?.includes(1)?['facet' as const]:[])]}));
  }
  return result;
}
