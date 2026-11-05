import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { NoteItem } from '../src/types.ts';
import { setBackgroundRagCompute } from '../src/electron/rag/backgroundComputeBridge.ts';
import { buildTextbookReferenceChunks } from '../src/electron/rag/textbookReferenceChunks.ts';
import { createTextbookReferenceIndex } from '../src/electron/rag/textbookReferenceIndex.ts';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'textbook-reference-rag-'));
let chunkCalls = 0, embedCalls = 0;
const vector = (seed: number): number[] => Array.from({ length: 384 }, (_, index) => ((index + seed) % 19 + 1) / 20);
setBackgroundRagCompute({
  parse: async () => { throw new Error('unused'); },
  vectorize: async () => { throw new Error('unused'); },
  chunkTextbook: async (input) => { chunkCalls += 1; return buildTextbookReferenceChunks(input); },
  embed: async (texts) => { embedCalls += 1; return texts.map((text) => vector(text.length % 17)); },
});

const body = '# 边界条件\n\n概念的边界由适用对象、条件和例外共同确定。\n\n# 证据\n\n观察结果只有在条件成立时才能支持结论。';
const content = (textbookBody: string, review = '第一次复盘') => [
  '项目计划：不进入教材索引。',
  '<TextbookBoundary id="region-1" edge="start" />',
  textbookBody,
  '<TextbookBoundary id="region-1" edge="end" />',
  `<LearningReviewBlock id="review-1" />\n${review}`,
].join('\n\n');
const note = (revisionId: string, textbookBody = body, review?: string): NoteItem => ({
  id: 'project-1', title: '论证课本', noteType: 'project', content: content(textbookBody, review),
  tags: [], links: [], backlinks: [], dueDates: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: new Date().toISOString(),
  textbook: { schemaVersion: 1, textbookId: 'textbook-1', projectNoteId: 'project-1', rootProjectId: 'project-1',
    revisionId, regionId: 'region-1', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: new Date().toISOString() },
});

const index = createTextbookReferenceIndex(root);
await index.syncNote(note('r1'));
assert.equal((await index.status('project-1')).status, 'ready');
assert.equal(chunkCalls, 1);
assert.equal(embedCalls, 1);
const firstHits = await index.search('边界条件是什么', 2, ['project-1']);
assert.ok(firstHits.length > 0);
assert.match(firstHits[0].snippet, /边界|条件/u);

// A review append changes NoteItem.updatedAt/content outside the managed region only.
// It must not schedule either chunking or embedding again.
await index.syncNote(note('r1', body, '第二次复盘改写'));
assert.equal(chunkCalls, 1);
assert.equal(embedCalls, 2, '检索 query 自身需要一次后台 embedding');

await index.syncNote(note('r2', `${body}\n\n新增的教材正文会触发重建。`));
assert.equal(chunkCalls, 2);
assert.equal(embedCalls, 3);
await index.syncNote(note('r2', `${body}\n\n新增的教材正文会触发重建。`), true);
assert.equal(chunkCalls, 3, '用户显式重建必须绕过幂等快路');
assert.equal(embedCalls, 4);

const failedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'textbook-reference-failed-'));
let failedEmbeds = 0;
setBackgroundRagCompute({
  parse: async () => { throw new Error('unused'); },
  vectorize: async () => { throw new Error('unused'); },
  chunkTextbook: async (input) => buildTextbookReferenceChunks(input),
  embed: async () => { failedEmbeds += 1; throw new Error('embedding_unavailable'); },
});
const failed = createTextbookReferenceIndex(failedRoot);
await assert.rejects(failed.syncNote(note('failed-r1')));
await failed.syncNote(note('failed-r1'));
assert.equal(failedEmbeds, 1, '同源失败不得因普通保存自动重试');
assert.equal((await failed.status('project-1')).status, 'failed');

const corruptRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'textbook-reference-corrupt-'));
await fs.writeFile(path.join(corruptRoot, 'textbook-reference-embeddings.json'), '{not-json', 'utf8');
let repairedChunks = 0;
setBackgroundRagCompute({
  parse: async () => { throw new Error('unused'); },
  vectorize: async () => { throw new Error('unused'); },
  chunkTextbook: async (input) => { repairedChunks += 1; return buildTextbookReferenceChunks(input); },
  embed: async (texts) => texts.map((text) => vector(text.length % 13)),
});
const corrupt = createTextbookReferenceIndex(corruptRoot);
await corrupt.syncNotes([note('repaired-r1')]);
assert.equal((await corrupt.status('project-1')).status, 'ready');
assert.equal(repairedChunks, 1, '损坏的派生索引允许自动隔离并重建一次');
assert.ok((await fs.readdir(corruptRoot)).some((name) => name.startsWith('textbook-reference-embeddings.corrupt-')));

setBackgroundRagCompute(undefined);
await fs.rm(root, { recursive: true, force: true });
await fs.rm(failedRoot, { recursive: true, force: true });
await fs.rm(corruptRoot, { recursive: true, force: true });
console.log(JSON.stringify({
  status: 'passed',
  backgroundChunking: true,
  unchangedReviewDidNotReindex: true,
  sameFailureDidNotRetry: true,
  corruptDerivedIndexRecovered: true,
  priorityReady: firstHits.length,
}, null, 2));
