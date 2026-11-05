import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureRebuildSnapshot, commitPreparedRebuild, type PreparedRebuild } from './rag-rebuild-transaction.ts';
import { DOCUMENT_SEMANTIC_CHUNKING_VERSION } from '../src/electron/rag/chunking.ts';

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'loginote-rebuild-'));
const prepared: PreparedRebuild = {
  document: { id: 'doc-1', fileName: 'test.pdf', fileType: 'pdf', extension: '.pdf', indexable: true, status: 'ready',
    size: 1, chunkCount: 1, totalChars: 3, uploadAt: '2026-01-01T00:00:00Z', indexSchemaVersion: 1 },
  structured: { schemaVersion: 1, docId: 'doc-1', normalizedText: '新正文。', blocks: [] },
  chunks: [{ id: 'doc-1#new', docId: 'doc-1', fileName: 'test.pdf', index: 0, sectionPath: '', content: '新正文。',
    embedding: [1, 0], schemaVersion: DOCUMENT_SEMANTIC_CHUNKING_VERSION }],
};
async function fixture(name: string) {
  const root = path.join(tempRoot, name);
  const index = path.join(root, 'rag-index');
  await fs.mkdir(path.join(index, 'staging/doc-1/old'), { recursive: true });
  const files: Record<string, unknown> = {
    'manifest.json': [prepared.document],
    'chunks-doc-1.json': [{ content: '旧正文。' }],
    'structured-doc-1.json': { normalizedText: '旧正文。' },
    'knowledge-doc-1.json': { schemaVersion: 1, docId: 'doc-1', entityMentions: [], argumentUnits: [] },
    'knowledge-job-doc-1.json': { generationId: 'old' },
    'staging/doc-1/old/knowledge.json': { pending: true },
    'entity-catalog.json': { schemaVersion: 1, generatedAt: '', entities: [{ id: 'old-entity', aliases: [], canonicalName: '旧实体', entityType: 'concept', embedding: [1, 0] }] },
    'knowledge-settings.json': { enabled: false, processingMode: 'local-only' },
    'user-argument-user-note.json': { keep: true },
  };
  for (const [file, data] of Object.entries(files)) await fs.writeFile(path.join(index, file), JSON.stringify(data));
  return { root, index };
}
try {
  const success = await fixture('success');
  const before = await captureRebuildSnapshot(success.index, ['doc-1']);
  const result = await commitPreparedRebuild(success.root, [prepared], before);
  assert.equal(result.quarantined, 3);
  for (const [file, bytes] of before) if (bytes) assert.ok((await fs.readFile(path.join(result.backupRoot, 'snapshot', file))).equals(bytes));
  for (const file of ['knowledge-doc-1.json', 'knowledge-job-doc-1.json', 'staging/doc-1']) {
    await assert.rejects(fs.access(path.join(success.index, file)));
    await fs.access(path.join(result.backupRoot, 'quarantine', file));
  }
  const manifest = JSON.parse(await fs.readFile(path.join(success.index, 'manifest.json'), 'utf8'));
  assert.equal(manifest[0].indexSchemaVersion, DOCUMENT_SEMANTIC_CHUNKING_VERSION);
  assert.equal(manifest[0].knowledgeStatus, 'disabled');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(success.index, 'entity-catalog.json'), 'utf8')).entities, []);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(success.index, 'user-argument-user-note.json'), 'utf8')), { keep: true });
  assert.equal(JSON.parse(await fs.readFile(path.join(result.backupRoot, 'rebuild-journal.json'), 'utf8')).status, 'committed');

  const failure = await fixture('failure');
  const original = await captureRebuildSnapshot(failure.index, ['doc-1']);
  await assert.rejects(commitPreparedRebuild(failure.root, [prepared], original, async () => {
    await fs.writeFile(path.join(failure.index, 'chunks-doc-1.json'), 'partial write');
    throw new Error('Injected failure');
  }), /rolled back/u);
  const restored = await captureRebuildSnapshot(failure.index, ['doc-1']);
  assert.deepEqual(restored, original, '失败后 L0/L1/L2、任务、目录及设置必须逐字节恢复');

  const concurrent = await fixture('concurrent');
  const old = await captureRebuildSnapshot(concurrent.index, ['doc-1']);
  await fs.writeFile(path.join(concurrent.index, 'manifest.json'), '[]');
  await assert.rejects(commitPreparedRebuild(concurrent.root, [prepared], old), /Index changed/u);
  assert.equal(await fs.readFile(path.join(concurrent.index, 'manifest.json'), 'utf8'), '[]');
  await assert.rejects(captureRebuildSnapshot(concurrent.index, ['../outside']), /Unsafe/u);
  await fs.writeFile(path.join(concurrent.index, 'knowledge-settings.json'), '{"enabled":true}');
  await assert.rejects(captureRebuildSnapshot(concurrent.index, ['doc-1']), /Pause knowledge/u);
} finally {
  assert.equal(path.dirname(path.resolve(tempRoot)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(tempRoot).startsWith('loginote-rebuild-'));
  await fs.rm(tempRoot, { recursive: true, force: true });
}
console.log('RAG rebuild backup, quarantine, rollback and concurrency checks passed');
