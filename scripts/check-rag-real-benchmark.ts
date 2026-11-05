import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  anonymizeBenchmarkId,
  inspectAnonymousRagCorpus,
} from '../src/electron/rag/realCorpusBenchmark.ts';

const root = await mkdtemp(path.join(os.tmpdir(), 'loginote-rag-benchmark-'));
const indexDir = path.join(root, 'rag-index');
await mkdir(indexDir, { recursive: true });

try {
  await writeFile(path.join(indexDir, 'manifest.json'), JSON.stringify([
    { id: 'private-document-id', fileName: '敏感标题.pdf', status: 'ready' },
  ]));
  await writeFile(path.join(indexDir, 'chunks-private-document-id.json'), JSON.stringify([
    { id: 'private-chunk-1', content: '敏感正文不得出现在报告中', schemaVersion: 2, sourceLocators: [{ kind: 'pdf', page: 1 }], embedding: [1, 0] },
    { id: 'private-chunk-2', content: '另一段敏感正文', schemaVersion: 2, sourceLocators: [{ kind: 'pdf', page: 2 }], embedding: [0, 1] },
  ]));
  await writeFile(path.join(indexDir, 'structured-private-document-id.json'), '{}');
  await writeFile(path.join(indexDir, 'knowledge-private-document-id.json'), JSON.stringify({
    schemaVersion: 1,
    status: 'ready',
    entityMentions: [{ id: 'private-entity' }],
    argumentUnits: [{ id: 'private-argument' }],
  }));
  await writeFile(path.join(indexDir, 'user-argument-private-note.json'), JSON.stringify({
    schemaVersion: 1,
    noteId: 'private-note',
    noteTitle: '私人笔记标题',
    nodes: [{ id: 'private-node', text: '私人论证' }],
  }));
  const backupDir = path.join(indexDir, 'rebuild-backups', '2026-10-04');
  await mkdir(backupDir, { recursive: true });
  await writeFile(path.join(backupDir, 'chunks-private-document-id.json'), JSON.stringify([
    { id: 'old-private-chunk', content: '旧备份不得被视为活动分块', embedding: [1, 0] },
  ]));
  await writeFile(path.join(backupDir, 'knowledge-private-document-id.json'), JSON.stringify({
    entityMentions: [{ id: 'old-private-entity' }],
    argumentUnits: [{ id: 'old-private-argument' }],
  }));
  await writeFile(path.join(backupDir, 'user-argument-private-note.json'), JSON.stringify({
    nodes: [{ id: 'old-private-node' }],
  }));

  const snapshot = await inspectAnonymousRagCorpus(root);
  assert.equal(snapshot.readiness, 'unified_ready');
  assert.equal(snapshot.counts.readyDocuments, 1);
  assert.equal(snapshot.counts.chunks, 2);
  assert.equal(snapshot.counts.knowledgeShards, 1);
  assert.equal(snapshot.counts.knowledgeEntities, 1);
  assert.equal(snapshot.counts.knowledgeArguments, 1);
  assert.equal(snapshot.counts.userArgumentNodes, 1);
  assert.equal(snapshot.counts.userArgumentShards, 1, '重建备份不得被视为活动 user argument shard');
  assert.equal(snapshot.quality.locatorCoverage, 1);
  assert.deepEqual(snapshot.quality.embeddingDimensions, [2]);
  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /敏感|私人|private-document|private-note/u);

  const first = anonymizeBenchmarkId('private-chunk-1', snapshot.corpusFingerprint);
  const second = anonymizeBenchmarkId('private-chunk-1', snapshot.corpusFingerprint);
  assert.equal(first, second);
  assert.notEqual(first, 'private-chunk-1');
  assert.equal(first.length, 16);
  await writeFile(path.join(root, 'rag-index', 'chunks-private-document-id.json'), JSON.stringify([
    { id: 'legacy', schemaVersion: 1, sourceLocators: [{ kind: 'pdf', page: 1 }], embedding: [1, 0] },
  ]));
  const outdated = await inspectAnonymousRagCorpus(root);
  assert.equal(outdated.readiness, 'passage_only', '旧切分版本不能被标为融合就绪');
  assert.ok(outdated.blockers.includes('outdated_chunk_segmentation'));
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('real corpus benchmark privacy checks passed');
