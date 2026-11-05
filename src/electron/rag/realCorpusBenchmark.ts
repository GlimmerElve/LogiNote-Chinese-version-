import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DOCUMENT_SEMANTIC_CHUNKING_VERSION } from './chunking.ts';

export type RealCorpusReadiness = 'empty' | 'passage_only' | 'unified_ready';

export interface AnonymousRagCorpusSnapshot {
  version: 1;
  corpusFingerprint: string;
  readiness: RealCorpusReadiness;
  blockers: string[];
  counts: {
    manifestDocuments: number;
    readyDocuments: number;
    chunks: number;
    knowledgeShards: number;
    knowledgeEntities: number;
    knowledgeArguments: number;
    userArgumentShards: number;
    userArgumentNodes: number;
  };
  quality: {
    locatorCoverage: number;
    currentChunkSchemaCoverage: number;
    embeddingDimensions: number[];
  };
  storageBytes: {
    total: number;
    chunks: number;
    structured: number;
    knowledge: number;
    userArguments: number;
    jobsAndSettings: number;
    other: number;
  };
}

interface FileEntry {
  absolutePath: string;
  relativePath: string;
  bytes: number;
}

async function listFiles(root: string, current = root): Promise<FileEntry[]> {
  let entries: Array<import('node:fs').Dirent> = [];
  try {
    entries = await fs.readdir(current, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: FileEntry[] = [];
  for (const entry of entries) {
    const absolutePath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(root, absolutePath));
    } else if (entry.isFile()) {
      const stat = await fs.stat(absolutePath);
      files.push({
        absolutePath,
        relativePath: path.relative(root, absolutePath).replace(/\\/gu, '/'),
        bytes: stat.size,
      });
    }
  }
  return files;
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function fileKind(relativePath: string): keyof AnonymousRagCorpusSnapshot['storageBytes'] {
  // 重建备份是可恢复历史，不属于当前活动索引；体积仍计入 other。
  if (relativePath.startsWith('rebuild-backups/')) return 'other';
  const name = path.posix.basename(relativePath);
  if (/^chunks-.+\.json$/u.test(name)) return 'chunks';
  if (/^structured-.+\.json$/u.test(name)) return 'structured';
  if (/^user-argument-.+\.json$/u.test(name)) return 'userArguments';
  if (/^knowledge-(?!job-|settings\.json$).+\.json$/u.test(name) || relativePath.startsWith('staging/')) return 'knowledge';
  if (/^(?:knowledge-job-|knowledge-settings|entity-catalog)/u.test(name)) return 'jobsAndSettings';
  return 'other';
}

function roundedRatio(numerator: number, denominator: number): number {
  return denominator ? Math.round((numerator / denominator) * 10_000) / 10_000 : 0;
}

/**
 * 只输出计数、覆盖率、体积和不可逆 corpus fingerprint。
 * 文件名、标题、正文、chunkId、noteId 均不会进入返回值。
 */
export async function inspectAnonymousRagCorpus(dataRoot: string): Promise<AnonymousRagCorpusSnapshot> {
  const indexDir = path.join(path.resolve(dataRoot), 'rag-index');
  const files = await listFiles(indexDir);
  const manifest = await readJson<Array<{ status?: unknown }>>(path.join(indexDir, 'manifest.json')) || [];
  const activeRootFiles = files.filter((file) => !file.relativePath.includes('/'));
  const chunkFiles = activeRootFiles.filter((file) => /^chunks-.+\.json$/u.test(file.relativePath));
  const knowledgeFiles = activeRootFiles.filter((file) => /^knowledge-(?!job-|settings\.json$).+\.json$/u.test(file.relativePath));
  const userArgumentFiles = activeRootFiles.filter((file) => /^user-argument-.+\.json$/u.test(file.relativePath));

  let chunkCount = 0;
  let locatedChunks = 0;
  let currentSchemaChunks = 0;
  const embeddingDimensions = new Set<number>();
  for (const file of chunkFiles) {
    const chunks = await readJson<Array<{
      sourceLocators?: unknown[];
      schemaVersion?: unknown;
      embedding?: unknown[];
    }>>(file.absolutePath) || [];
    chunkCount += chunks.length;
    locatedChunks += chunks.filter((chunk) => Array.isArray(chunk.sourceLocators) && chunk.sourceLocators.length > 0).length;
    currentSchemaChunks += chunks.filter((chunk) => chunk.schemaVersion === DOCUMENT_SEMANTIC_CHUNKING_VERSION).length;
    for (const chunk of chunks) {
      if (Array.isArray(chunk.embedding) && chunk.embedding.length > 0) embeddingDimensions.add(chunk.embedding.length);
    }
  }

  let knowledgeEntityCount = 0;
  let knowledgeArgumentCount = 0;
  for (const file of knowledgeFiles) {
    const shard = await readJson<{ entityMentions?: unknown[]; argumentUnits?: unknown[] }>(file.absolutePath);
    knowledgeEntityCount += Array.isArray(shard?.entityMentions) ? shard.entityMentions.length : 0;
    knowledgeArgumentCount += Array.isArray(shard?.argumentUnits) ? shard.argumentUnits.length : 0;
  }

  let userArgumentNodeCount = 0;
  for (const file of userArgumentFiles) {
    const shard = await readJson<{ nodes?: unknown[] }>(file.absolutePath);
    userArgumentNodeCount += Array.isArray(shard?.nodes) ? shard.nodes.length : 0;
  }

  const storageBytes: AnonymousRagCorpusSnapshot['storageBytes'] = {
    total: 0,
    chunks: 0,
    structured: 0,
    knowledge: 0,
    userArguments: 0,
    jobsAndSettings: 0,
    other: 0,
  };
  for (const file of files) {
    storageBytes.total += file.bytes;
    storageBytes[fileKind(file.relativePath)] += file.bytes;
  }

  const readyDocuments = manifest.filter((document) => document?.status === 'ready').length;
  const blockers: string[] = [];
  if (readyDocuments === 0 || chunkCount === 0) blockers.push('no_ready_passage_index');
  if (knowledgeFiles.length === 0) blockers.push('no_active_knowledge_shard');
  if (roundedRatio(locatedChunks, chunkCount) < 0.95) blockers.push('source_locator_coverage_below_95_percent');
  if (currentSchemaChunks < chunkCount) blockers.push('outdated_chunk_segmentation');
  const readiness: RealCorpusReadiness = readyDocuments === 0 || chunkCount === 0
    ? 'empty'
    : blockers.length > 0 ? 'passage_only' : 'unified_ready';
  const fingerprint = createHash('sha256')
    .update(files
      .map((file) => `${createHash('sha256').update(file.relativePath).digest('hex')}:${file.bytes}`)
      .sort()
      .join('|'))
    .digest('hex')
    .slice(0, 24);

  return {
    version: 1,
    corpusFingerprint: fingerprint,
    readiness,
    blockers,
    counts: {
      manifestDocuments: manifest.length,
      readyDocuments,
      chunks: chunkCount,
      knowledgeShards: knowledgeFiles.length,
      knowledgeEntities: knowledgeEntityCount,
      knowledgeArguments: knowledgeArgumentCount,
      userArgumentShards: userArgumentFiles.length,
      userArgumentNodes: userArgumentNodeCount,
    },
    quality: {
      locatorCoverage: roundedRatio(locatedChunks, chunkCount),
      currentChunkSchemaCoverage: roundedRatio(currentSchemaChunks, chunkCount),
      embeddingDimensions: [...embeddingDimensions].sort((left, right) => left - right),
    },
    storageBytes,
  };
}

export function anonymizeBenchmarkId(value: string, corpusFingerprint: string): string {
  return createHash('sha256')
    .update(`${corpusFingerprint}\u0000${String(value || '')}`)
    .digest('hex')
    .slice(0, 16);
}
