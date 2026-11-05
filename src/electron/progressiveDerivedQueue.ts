import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWriteTextFile } from './atomicWrite';
import { progressivePageConcepts } from './progressiveKnowledge';
import type { ProgressiveLearningStore } from './progressiveLearningStore';
import type { ProgressiveConcept, ProgressiveLessonPage, ProgressivePageSummary } from '../services/progressiveLearning/types';
import { getBackgroundRagCompute, type BackgroundRagCompute } from './rag/backgroundComputeBridge';
import { cosineSimilarity } from './rag/embedding';
import { TEXTBOOK_REFERENCE_MODEL, textbookReferenceHash, type TextbookReferenceChunk } from './rag/textbookReferenceChunks';

export const PROGRESSIVE_CHUNKER_VERSION = 'textbook-semantic-220-v1';
const KNOWLEDGE_PROJECTION_VERSION = 2;
const model = TEXTBOOK_REFERENCE_MODEL;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const yieldTask = () => new Promise<void>(resolve => setTimeout(resolve, 12));
const vector = (value: unknown): value is number[] => Array.isArray(value) && value.length === 384
  && value.every(item => typeof item === 'number' && Number.isFinite(item)) && value.some(item => item !== 0);
type IndexedChunk = TextbookReferenceChunk & { embedding?: number[] };
const validChunk = (chunk: IndexedChunk) => chunk && typeof chunk.embeddingText === 'string'
  && chunk.embeddingKey === textbookReferenceHash({ model, text: chunk.embeddingText })
  && typeof chunk.content === 'string' && Number.isSafeInteger(chunk.textStart) && Number.isSafeInteger(chunk.textEnd)
  && chunk.textStart >= 0 && chunk.textEnd - chunk.textStart === chunk.content.length;
interface PageIndex { schemaVersion: 1; courseId: string; pageId: string; fingerprint: string; pageHash: string; model: string; chunker: string; chunks: IndexedChunk[] }
export interface ProgressiveDerivedJob {
  schemaVersion: 1; projectNoteId: string; courseId: string; pageId: string; pageHash: string; fingerprint: string;
  status: 'queued' | 'running' | 'ready' | 'failed'; knowledgeReady: boolean; indexReady: boolean;
  attempts: number; error?: string; updatedAt: string;
  knowledgeIds?: string[];
  knowledgeProjectionVersion?: number;
}
interface Options {
  store: ProgressiveLearningStore;
  isCurrent(): boolean;
  compute?: () => Pick<BackgroundRagCompute, 'chunkTextbook' | 'embed'> | undefined;
  linkKnowledge(projectNoteId: string, courseId: string, page: ProgressiveLessonPage, concepts: ProgressiveConcept[]): Promise<string[] | void>;
  event?(event: { operation: string; projectNoteId: string; pageId: string; count?: number }): void;
}

/** Durable page-scoped outbox. Only the existing low-priority embedding utility process runs CPU work. */
export class ProgressiveDerivedQueue {
  private root: string;
  private pending = new Set<string>();
  private retries = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;
  constructor(userStateDir: string, private options: Options) {
    this.root = path.resolve(userStateDir, 'progressive-derived');
  }
  private project(id: string) { return path.join(this.root, `project-${hash(id)}`); }
  private async directory(id: string) {
    for (const directory of [this.root, this.project(id)]) {
      await fs.mkdir(directory, { recursive: true });
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('后台页面目录无效');
    }
    return this.project(id);
  }
  private async read<T>(file: string): Promise<T | null> {
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4_000_000) throw Error('后台页面文件无效');
      return JSON.parse(await fs.readFile(file, 'utf8')) as T;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  private current() { if (this.stopped || !this.options.isCurrent()) throw Error('后台课程环境已停止'); }
  private async write(file: string, value: unknown) {
    this.current();
    await atomicWriteTextFile(file, JSON.stringify(value), { allowCopyFallback: false });
    this.current();
  }
  notify = (projectNoteId: string, retry = false) => {
    if (this.stopped) return;
    if (retry) this.retries.add(projectNoteId);
    this.pending.add(projectNoteId);
    if (this.timer || this.running) return;
    this.timer = setTimeout(() => { this.timer = null; void this.drain(); }, 100);
  };
  private async drain() {
    if (this.running || this.stopped) return;
    const run = (async () => {
      while (this.pending.size && !this.stopped && this.options.isCurrent()) {
        const id = this.pending.values().next().value!; this.pending.delete(id);
        const retry = this.retries.delete(id);
        try { await this.syncProject(id, retry); }
        catch (error) { console.warn('[progressive-derived]', error instanceof Error ? error.message : '后台任务失败'); }
        await yieldTask();
      }
    })();
    this.running = run;
    try { await run; } finally { this.running = null; if (this.pending.size && !this.stopped) this.notify(this.pending.values().next().value!); }
  }
  async recover(): Promise<void> {
    const courses = await this.options.store.listPublished();
    for (const course of courses) this.notify(course.projectNoteId, true);
  }
  /** Used by maintenance/tests. Production saves never await derived work. */
  async idle(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    do { await this.drain(); await this.running; } while (this.pending.size && !this.stopped);
  }
  stop(): Promise<void> { this.stopped = true; this.pending.clear(); this.retries.clear(); if (this.timer) clearTimeout(this.timer); this.timer = null; return this.running || Promise.resolve(); }
  async resume(): Promise<void> { await this.running; this.stopped = false; await this.recover(); }
  private fingerprint(page: ProgressivePageSummary) { return hash({ page: page.contentHash, model, chunker: PROGRESSIVE_CHUNKER_VERSION }); }
  private async stillCurrent(projectNoteId: string, courseId: string, page: ProgressivePageSummary) {
    this.current();
    const snapshot = (await this.options.store.listPublished(projectNoteId))[0];
    return snapshot?.courseId === courseId && snapshot.pages.some(entry => entry.id === page.id && entry.contentHash === page.contentHash);
  }
  private async syncProject(projectNoteId: string, retry: boolean) {
    const directory = await this.directory(projectNoteId);
    const course = (await this.options.store.listPublished(projectNoteId))[0];
    const pages = course?.pages || [];
    // Deletion touches only orphan page shards. Knowledge originals remain user-owned.
    for (const name of await fs.readdir(directory)) {
      const match = name.match(/^((?:main-[1-4]|extra-[a-f0-9-]{36}))\.(?:job|index)\.json$/u);
      if (match && !pages.some(page => page.id === match[1])) {
        await fs.unlink(path.join(directory, name));
        this.options.event?.({ operation: 'remove-shard', projectNoteId, pageId: match[1] });
      }
    }
    if (!course) return;
    for (const page of pages) {
      this.current();
      const file = path.join(directory, `${page.id}.job.json`);
      const stored = await this.read<ProgressiveDerivedJob>(file);
      const old = stored?.courseId === course.courseId && stored.projectNoteId === projectNoteId && stored.pageId === page.id ? stored : null;
      const fingerprint = this.fingerprint(page);
      const needsProjection = old?.knowledgeProjectionVersion !== KNOWLEDGE_PROJECTION_VERSION;
      if (old?.fingerprint === fingerprint && old.status === 'ready' && !needsProjection) continue;
      if (old?.fingerprint === fingerprint && old.status === 'failed' && !retry) continue;
      const job: ProgressiveDerivedJob = old?.fingerprint === fingerprint ? old : {
        schemaVersion: 1, projectNoteId, courseId: course.courseId, pageId: page.id, pageHash: page.contentHash,
        fingerprint, status: 'queued', knowledgeReady: false, indexReady: false, attempts: 0, updatedAt: new Date().toISOString(),
      };
      if (needsProjection) job.knowledgeReady = false;
      // Failed work is tried once per explicit notification/startup, never in a hot loop.
      await this.processPage(directory, page, job);
      await yieldTask();
    }
  }
  private async processPage(directory: string, descriptor: ProgressivePageSummary, job: ProgressiveDerivedJob) {
    const jobFile = path.join(directory, `${job.pageId}.job.json`), indexFile = path.join(directory, `${job.pageId}.index.json`);
    const saveJob = async () => { job.updatedAt = new Date().toISOString(); await this.write(jobFile, job); };
    const valid = () => this.stillCurrent(job.projectNoteId, job.courseId, descriptor);
    try {
      job.status = 'running'; job.attempts++; delete job.error; await saveJob();
      const page = await this.options.store.readPublished(job.projectNoteId, job.pageId, descriptor.contentHash);
      if (!page || !await valid()) return;
      let knowledgeError: string | undefined;
      if (!job.knowledgeReady) {
        // No per-concept model calls. Older pages use literal definition sections only.
        try {
          const ids = await this.options.linkKnowledge(job.projectNoteId, job.courseId, page, progressivePageConcepts(page));
          job.knowledgeReady = true; job.knowledgeIds = ids || []; job.knowledgeProjectionVersion = KNOWLEDGE_PROJECTION_VERSION;
        } catch (error) { knowledgeError = (error instanceof Error ? error.message : '知识点关联失败').slice(0, 1000); }
        if (!await valid()) return;
        await saveJob();
        if(job.knowledgeReady)this.options.event?.({operation:'knowledge-ready',projectNoteId:job.projectNoteId,pageId:job.pageId});
      }
      let index = await this.read<PageIndex>(indexFile);
      if (index && (index.schemaVersion !== 1 || !Array.isArray(index.chunks) || index.chunks.length > 500
        || index.chunks.some(chunk => !validChunk(chunk)))) throw Error('本页索引校验失败，原索引已保留');
      // A knowledge-link upgrade/retry must not initialize an embedding model
      // or redo unchanged page chunks that have already committed.
      if (index?.fingerprint === job.fingerprint && index.courseId === job.courseId && index.pageId === job.pageId
        && index.chunks.every(chunk => vector(chunk.embedding))) {
        job.indexReady = true; job.status = job.knowledgeReady ? 'ready' : 'failed'; job.error = knowledgeError; await saveJob();
        this.options.event?.({ operation: job.status, projectNoteId: job.projectNoteId, pageId: page.id }); return;
      }
      const compute = (this.options.compute || getBackgroundRagCompute)();
      if (!compute) throw Error('本地向量进程尚不可用，可稍后重试本页');
      if (index?.fingerprint !== job.fingerprint || index.courseId !== job.courseId || index.pageId !== job.pageId) {
        this.options.event?.({ operation: 'chunk', projectNoteId: job.projectNoteId, pageId: page.id, count: 1 });
        const pieces = await compute.chunkTextbook({ noteId: job.projectNoteId, title: page.title,
          textbookId: job.courseId, revisionId: descriptor.contentHash, regionId: page.id, body: page.body });
        if (!await valid()) return;
        // Reuse only identical actual embedding inputs and model, independent of course revision/offset.
        const cache = new Map(index?.model === model ? index.chunks.filter(chunk => validChunk(chunk) && vector(chunk.embedding))
          .map(chunk => [chunk.embeddingKey, chunk.embedding!] as const) : []);
        index = { schemaVersion: 1, courseId: job.courseId, pageId: job.pageId, fingerprint: job.fingerprint, pageHash: descriptor.contentHash, model,
          chunker: PROGRESSIVE_CHUNKER_VERSION, chunks: pieces.map(piece => ({ ...piece,
            ...(cache.has(piece.embeddingKey) ? { embedding: cache.get(piece.embeddingKey) } : {}) })) };
        await this.write(indexFile, index);
      }
      for (;;) {
        const missing = index.chunks.filter(chunk => !vector(chunk.embedding)).slice(0, 4);
        if (!missing.length) break;
        this.options.event?.({ operation: 'embed', projectNoteId: job.projectNoteId, pageId: page.id, count: missing.length });
        const embeddings = await compute.embed(missing.map(chunk => chunk.embeddingText));
        if (!await valid()) return;
        if (embeddings.length !== missing.length || embeddings.some(item => !vector(item))) throw Error('本页向量返回格式无效');
        missing.forEach((chunk, i) => { chunk.embedding = embeddings[i]; });
        await this.write(indexFile, index); // Durable batch checkpoint: restart only computes remaining vectors.
        await yieldTask();
      }
      if (!await valid()) return;
      job.indexReady = true; job.status = job.knowledgeReady ? 'ready' : 'failed'; job.error = knowledgeError; await saveJob();
      this.options.event?.({ operation: job.status, projectNoteId: job.projectNoteId, pageId: page.id });
    } catch (error) {
      if (this.stopped || !this.options.isCurrent()) return;
      job.status = 'failed'; job.error = (error instanceof Error ? error.message : '后台处理失败').slice(0, 1000);
      await saveJob();
    }
  }
  async statuses(projectNoteId: string): Promise<ProgressiveDerivedJob[]> {
    const course = (await this.options.store.listPublished(projectNoteId))[0];
    const results: ProgressiveDerivedJob[] = [];
    for (const page of course?.pages || []) {
      const job = await this.read<ProgressiveDerivedJob>(path.join(this.project(projectNoteId), `${page.id}.job.json`));
      if (job?.courseId === course!.courseId && job.projectNoteId === projectNoteId && job.pageId === page.id && job.fingerprint === this.fingerprint(page)) results.push(job);
    }
    return results;
  }
  /** Explicit leaf-scoped retrieval; never scans a vault-wide vector JSON. */
  async search(projectNoteId: string, query: string, limit = 8) {
    if (typeof query !== 'string' || !query.trim() || query.length > 2000) return [];
    const course = (await this.options.store.listPublished(projectNoteId))[0];
    if (!course) return [];
    const candidates: Array<{ pageId: string; chunkId: string; content: string; score: number }> = [];
    const compute = (this.options.compute || getBackgroundRagCompute)();
    if (!compute) return [];
    const [queryVector] = await compute.embed([query]);
    for (const page of course.pages) {
      const index = await this.read<PageIndex>(path.join(this.project(projectNoteId), `${page.id}.index.json`));
      if (index?.courseId !== course.courseId || index.pageId !== page.id || index.fingerprint !== this.fingerprint(page)) continue;
      for (const chunk of index.chunks) if (vector(chunk.embedding)) candidates.push({ pageId: page.id,
        chunkId: chunk.chunkId, content: chunk.content, score: cosineSimilarity(queryVector, chunk.embedding) });
      await yieldTask();
    }
    return candidates.sort((a, b) => b.score - a.score).slice(0, Math.min(20, Math.max(1, limit)));
  }
}
