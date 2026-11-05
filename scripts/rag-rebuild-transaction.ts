import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { DocumentChunk, StructuredDocument, UploadedDocument } from '../src/types.ts';
import { atomicWriteTextFile } from '../src/electron/atomicWrite.ts';
import { CURRENT_INDEX_SCHEMA_VERSION, setDataRoot, updateManifest, writeChunksFile, writeStructuredDocumentFile } from '../src/electron/ragIndex.ts';
import { rebuildEntityCatalog, setKnowledgeDataRoot } from '../src/electron/rag/knowledgeStore.ts';

export interface PreparedRebuild {
  document: UploadedDocument;
  structured: StructuredDocument;
  chunks: DocumentChunk[];
}
export type RebuildSnapshot = Map<string, Buffer | null>;

function safeId(id: string): string {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,159}$/u.test(id)) throw new Error('Unsafe document ID');
  return id;
}

/** All moves/removals are confined to named children of the resolved index/backup directories. */
function inside(root: string, relative: string): string {
  const resolved = path.resolve(root, relative);
  const remainder = path.relative(path.resolve(root), resolved);
  if (!remainder || remainder.startsWith('..') || path.isAbsolute(remainder)) throw new Error('Unsafe rebuild path');
  return resolved;
}

async function assertNoLinks(root: string, relative: string): Promise<void> {
  let current = path.resolve(root);
  for (const part of ['', ...relative.split(/[\\/]/u).filter(Boolean)]) {
    current = path.join(current, part);
    const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (stat?.isSymbolicLink()) throw new Error('Rebuild paths must not contain symlinks/junctions');
  }
}

async function listStaging(indexRoot: string, relative: string): Promise<string[]> {
  await assertNoLinks(indexRoot, relative);
  const entries = await fs.readdir(inside(indexRoot, relative), { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error('Unexpected staging symlink');
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await listStaging(indexRoot, child));
    else if (entry.isFile()) files.push(child);
    else throw new Error('Unexpected staging entry');
  }
  return files;
}

export async function captureRebuildSnapshot(indexRoot: string, docIds: string[]): Promise<RebuildSnapshot> {
  const files = ['manifest.json', 'entity-catalog.json', 'knowledge-settings.json'];
  for (const rawId of docIds) {
    const id = safeId(rawId);
    files.push(`structured-${id}.json`, `chunks-${id}.json`, `knowledge-${id}.json`, `knowledge-job-${id}.json`);
    files.push(...await listStaging(indexRoot, path.join('staging', id)));
  }
  const snapshot: RebuildSnapshot = new Map();
  for (const relative of [...new Set(files)].sort()) {
    await assertNoLinks(indexRoot, relative);
    const bytes = await fs.readFile(inside(indexRoot, relative)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    snapshot.set(relative, bytes);
  }
  const settings = snapshot.get('knowledge-settings.json');
  if (settings && JSON.parse(settings.toString('utf8')).enabled === true) throw new Error('Pause knowledge indexing before rebuilding');
  return snapshot;
}

function sameSnapshot(left: RebuildSnapshot, right: RebuildSnapshot): boolean {
  return left.size === right.size && [...left].every(([key, bytes]) => {
    const other = right.get(key);
    return bytes === null ? other === null : !!other && bytes.equals(other);
  });
}

async function persistPrepared(item: PreparedRebuild): Promise<void> {
  await writeStructuredDocumentFile(item.structured);
  await writeChunksFile(item.document.id, item.chunks);
  await updateManifest(item.document.id, {
    status: 'ready', chunkCount: item.chunks.length, totalChars: item.structured.normalizedText.trim().length,
    indexSchemaVersion: CURRENT_INDEX_SCHEMA_VERSION, needsReindex: false, error: undefined,
    knowledgeStatus: 'disabled', knowledgeGenerationId: undefined, knowledgeIndexedChunks: 0,
    knowledgeTotalChunks: item.chunks.length, knowledgeEntityCount: 0, knowledgeArgumentCount: 0,
    knowledgeExtractorVersion: 0, knowledgePromptVersion: 0, knowledgeError: undefined,
  });
}

/** Offline maintenance only: callers must stop the app; snapshots detect concurrent changes before mutation. */
export async function commitPreparedRebuild(
  dataRoot: string,
  prepared: PreparedRebuild[],
  snapshot: RebuildSnapshot,
  writeDocument: (item: PreparedRebuild) => Promise<void> = persistPrepared,
): Promise<{ backupRoot: string; quarantined: number }> {
  if (!prepared.length) throw new Error('No prepared documents');
  const indexRoot = path.resolve(dataRoot, 'rag-index');
  const docIds = prepared.map((item) => safeId(item.document.id));
  if (!sameSnapshot(snapshot, await captureRebuildSnapshot(indexRoot, docIds))) throw new Error('Index changed during preparation; no changes applied');
  const backupRelative = path.join('rebuild-backups', `${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID().slice(0, 8)}`);
  await assertNoLinks(indexRoot, backupRelative);
  const backupRoot = inside(indexRoot, backupRelative);
  await fs.mkdir(backupRoot, { recursive: true });
  for (const [relative, bytes] of snapshot) {
    if (bytes === null) continue;
    const target = inside(backupRoot, path.join('snapshot', relative));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes, { flag: 'wx' });
    if (!(await fs.readFile(target)).equals(bytes)) throw new Error('Backup verification failed');
  }
  const journalPath = inside(backupRoot, 'rebuild-journal.json');
  const journal = { status: 'backed_up', docIds, schemaVersion: CURRENT_INDEX_SCHEMA_VERSION,
    files: [...snapshot].map(([relative, bytes]) => ({ relative, existed: bytes !== null,
      sha256: bytes === null ? null : createHash('sha256').update(bytes).digest('hex') })) };
  const saveJournal = () => atomicWriteTextFile(journalPath, JSON.stringify(journal, null, 2));
  await saveJournal();
  if (!sameSnapshot(snapshot, await captureRebuildSnapshot(indexRoot, docIds))) throw new Error('Index changed during backup; no changes applied');
  setDataRoot(dataRoot);
  setKnowledgeDataRoot(dataRoot);
  let quarantined = 0;
  try {
    // Move, never delete, old shards/jobs/staging before publishing changed chunks.
    for (const id of docIds) {
      for (const relative of [`knowledge-${id}.json`, `knowledge-job-${id}.json`, path.join('staging', id)]) {
        await assertNoLinks(indexRoot, relative);
        const source = inside(indexRoot, relative);
        const target = inside(backupRoot, path.join('quarantine', relative));
        await fs.mkdir(path.dirname(target), { recursive: true });
        try { await fs.rename(source, target); quarantined += 1; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
    }
    // Remaining documents keep their entity catalog; removed shards can no longer contribute.
    await rebuildEntityCatalog();
    for (const item of prepared) await writeDocument(item);
    journal.status = 'committed';
    await saveJournal();
  } catch (error) {
    try {
      for (const [relative, bytes] of snapshot) {
        await assertNoLinks(indexRoot, relative);
        const target = inside(indexRoot, relative);
        if (bytes === null) await fs.unlink(target).catch((failure: NodeJS.ErrnoException) => { if (failure.code !== 'ENOENT') throw failure; });
        else { await fs.mkdir(path.dirname(target), { recursive: true }); await atomicWriteTextFile(target, bytes.toString('utf8')); }
      }
      journal.status = 'rolled_back';
      await saveJournal();
    } catch {
      throw new Error(`Rebuild and rollback failed; verified backup retained: ${backupRoot}`);
    }
    throw new Error(`Rebuild failed and was rolled back; backup retained: ${backupRoot}`, { cause: error });
  }
  return { backupRoot, quarantined };
}
