import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { NoteItem } from '../types';
import type { TextbookJob, TextbookJobCommand, TextbookJobReply, TextbookJobSummary } from '../services/textbook/generationTypes';
import { validateTextbookJob } from '../services/textbook/validation.ts';
import { readTextbookBody } from '../services/textbook/noteContent.ts';
import { atomicWriteTextFile } from './atomicWrite.ts';
import { validateTextbookModelPolicy } from '../services/textbook/modelPolicy';
import { validateTextbookThinkingSnapshot } from '../services/textbook/thinkingSnapshot';
import { validateTextbookPromptVersion } from '../services/textbook/promptVersion';
import { initialTextbookProgress, textbookProgressSnapshot } from '../services/textbook/progress';
import { textbookBoundUrls } from '../services/textbook/boundUrls';
import { projectPlanningSnapshot, planningBeforePublication, textbookHash } from '../services/textbook/fingerprint';
import type { TextbookWebEvidenceRequest, TextbookWebReadRequest, TextbookWebSnapshot, TextbookBoundUrl } from '../services/textbook/webTypes';
import type { ReadWebBody } from './textbookWebReader';
import { readTextbookBoundBodyWithBrowser } from './textbookWebFallback';
import { isTextbookVideoPage, isTextbookCatalogPage } from './textbookWebContent';
import { safeTextbookWebError, safeTextbookTaskError } from '../services/textbook/webErrors';
import { sameTextbookJobScope, preferredTextbookJob } from '../services/textbook/jobReuse';
import { clearTextbookDraftCache } from '../services/textbook/draftCache';
import { validatePublishedChapterRegeneration, queueTextbookChapterRegeneration } from '../services/textbook/chapterRegeneration';
import { collectTextbookSupplement, type TextbookSupplementDependencies } from './textbookSupplement';
import { textbookSupplementQuery, type TextbookSupplementRequest, type TextbookSupplementResult } from '../services/textbook/supplement';

/** Private checkpoints only. Leases are process-local: restart requires a fresh approval. */
export class TextbookStore {
  private leases = new Map<string, { token: string; owner: number; projectId: string }>();
  private queue: Promise<unknown> = Promise.resolve();
  private directory: string;
  private reads = new Map<string, { owner: number; controller: AbortController }>();
  constructor(userStateDir: string) { this.directory = path.resolve(userStateDir, 'textbook-jobs'); }
  /** Shared desktop admission gate uses this without exposing lease tokens. */
  hasRunningProject(projectId: string): boolean { return [...this.leases.values()].some(lease => lease.projectId === projectId); }
  private file(id: string): string {
    if (!/^[a-zA-Z0-9_-]{1,80}$/u.test(id)) throw new Error('教材任务编号无效');
    return path.join(this.directory, `${id}.json`);
  }
  private async read(id: string): Promise<TextbookJob> {
    const file = this.file(id);
    let text: string;
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4_000_000) throw new Error('invalid file');
      text = await fs.readFile(file, 'utf8');
    } catch { throw new Error('教材任务不存在或不可读取，请重新准备'); }
    const job = JSON.parse(text) as TextbookJob;
    if (job.schemaVersion !== 1 || job.id !== id || !job.spec || !job.checkpoint) throw new Error('教材任务格式无效');
    if (job.spec.modelPolicy !== undefined) validateTextbookModelPolicy(job.spec.modelPolicy);
    validateTextbookThinkingSnapshot(job.spec.thinkingSnapshot, job.spec.modelPolicy);
    validateTextbookPromptVersion(job.spec.promptVersion);
    if (job.spec.visualCapabilitiesVersion !== undefined && ![2, 3].includes(job.spec.visualCapabilitiesVersion)) throw new Error('教材可视化能力版本无效');
    return job;
  }
  private async save(job: TextbookJob, atomicOnly = false): Promise<void> {
    const text = JSON.stringify(job);
    if (text.length > 1_500_000 || Buffer.byteLength(text, 'utf8') > 4_000_000) throw new Error('教材草稿超过安全保存上限');
    await fs.mkdir(this.directory, { recursive: true }); await atomicWriteTextFile(this.file(job.id), text, atomicOnly ? {
      // Cache deletion must not fall back to a possibly partial in-place copy.
      operations: { writeFile: (file, content, encoding) => fs.writeFile(file, content, encoding), rename: (from, to) => fs.rename(from, to),
        copyFile: async () => { throw new Error('缓存文件被占用，清理未完成；原缓存保留，请稍后重新确认'); }, rm: (file, options) => fs.rm(file, options) },
    } : undefined);
  }
  private indexFile(projectId: string): string {
    if (typeof projectId !== 'string' || !projectId || projectId.length > 300) throw new Error('教材项目编号无效');
    return path.join(this.directory, `project-${createHash('sha256').update(projectId).digest('hex')}.json`);
  }
  private async index(projectId: string): Promise<string[]> {
    const file = this.indexFile(projectId);
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 40_000) throw new Error('invalid index');
      const ids = JSON.parse(await fs.readFile(file, 'utf8'));
      if (!Array.isArray(ids) || ids.length > 64 || ids.some((id) => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/u.test(id))) throw new Error('invalid index');
      return ids;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw new Error('教材任务目录不可读，请稍后重试'); }
  }
  async list(projectId: string): Promise<TextbookJobSummary[]> {
    await this.queue.catch(() => {});
    const jobs: TextbookJob[] = [];
    for (const id of await this.index(projectId)) {
      const job = await this.read(id);
      if (job.spec.projectNoteId !== projectId) throw new Error('教材任务目录与项目不一致');
      jobs.push(job);
    }
    jobs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const active = jobs.find((job) => this.leases.has(job.id));
    const latest = jobs.find((job) => !job.archivedAt) || jobs[0];
    const preferred = active || (latest && preferredTextbookJob(jobs.filter((job) => sameTextbookJobScope(job.spec, latest.spec)), () => false));
    // Keep the preferred old draft in the bounded summary, even after many newer preparations.
    return [...(preferred ? [preferred] : []), ...jobs.filter((job) => job.id !== preferred?.id)].slice(0, 12).map((job) => {
      const progress = textbookProgressSnapshot(job, this.leases.has(job.id));
      return { jobId: job.id, projectNoteId: projectId, stage: job.stage, title: job.spec.projectTitle,
        completedChapters: job.checkpoint.chapters?.length || 0, totalChapters: job.checkpoint.blueprint?.chapters.length || 0,
        updatedAt: job.updatedAt, error: progress.error, progress, preferred: job.id === preferred?.id, archivedAt: job.archivedAt };
    });
  }
  releaseOwner(owner: number): void {
    for (const [id, lease] of this.leases) if (lease.owner === owner) this.leases.delete(id);
    for (const read of this.reads.values()) if (read.owner === owner) read.controller.abort();
  }
  /** Send to the running owner without stealing its lease or discarding checkpoints. */
  requestStop(jobId: string, deliver: (owner: number, request: import('../services/textbook/stop').TextbookStopRequest) => boolean): Promise<import('../services/textbook/stop').TextbookStopReply> {
    const next = this.queue.catch(() => {}).then(async () => {
      await this.read(jobId); // Validate the exact ID and existence even when no lease remains.
      const lease = this.leases.get(jobId);
      if (!lease) return { jobId, status: 'not-running' as const };
      if (!deliver(lease.owner, { jobId, token: lease.token })) throw new Error('教材执行窗口不可达，请重新查询原任务状态');
      this.cancelWebRead(jobId, lease.token, lease.owner);
      return { jobId, status: 'stopping' as const };
    });
    this.queue = next; return next;
  }
  cancelWebRead(jobId: string, token: string, owner: number): void {
    const lease = this.leases.get(jobId);
    if (lease?.owner !== owner || lease.token !== token) return;
    for (const [key, read] of this.reads) if (key.startsWith(`${jobId}:`)) read.controller.abort();
  }
  private snapshotFile(jobId: string, resourceId: string): string {
    this.file(jobId); if (!/^(?:U\d{1,2}|S[1-3])$/u.test(resourceId)) throw new Error('网页来源编号无效');
    return path.join(this.directory, 'web-snapshots', `${jobId}-${resourceId}.json`);
  }
  private async webSnapshot(jobId: string, resourceId: string): Promise<TextbookWebSnapshot | undefined> {
    const file = this.snapshotFile(jobId, resourceId);
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_000_000) throw new Error('网页快照格式无效');
      const value = JSON.parse(await fs.readFile(file, 'utf8')) as TextbookWebSnapshot;
      if (value.schemaVersion !== 1 || value.jobId !== jobId || value.resourceId !== resourceId
        || value.web.snapshotId !== `${jobId}-${resourceId}` || typeof value.text !== 'string' || value.text.length > 200_000
        || await textbookHash({ text: value.text, web: value.web }) !== value.version) throw new Error('网页快照版本校验失败');
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      if (error instanceof SyntaxError) throw new Error('网页快照已损坏，不能复用；不会自动以当前网页替换旧证据');
      throw new Error(safeTextbookWebError(error));
    }
  }
  private async approvedWebRead(input: TextbookWebReadRequest, owner: number, notes: () => Promise<NoteItem[]>): Promise<TextbookJob> {
    const lease = this.leases.get(input.jobId);
    if (!lease || lease.owner !== owner || lease.token !== input.token) throw new Error('网页读取许可已失效，请重新确认教材任务');
    const job = await this.read(input.jobId), currentNotes = await notes(), project = currentNotes.find((note) => note.id === job.spec.projectNoteId && note.noteType === 'project');
    if (!job.spec.readBoundUrls || !job.spec.boundUrls?.some((item) => item.id === input.resourceId)) throw new Error('该 URL 不在批准读取范围');
    if (!project || await textbookHash(projectPlanningSnapshot(project, currentNotes, job.spec.allowedDocIds)) !== job.spec.planningHash
      || JSON.stringify(textbookBoundUrls(project)) !== JSON.stringify(job.spec.boundUrls)) throw new Error('项目或绑定 URL 已变化，请重新准备并确认');
    const currentLease = this.leases.get(input.jobId);
    if (!currentLease || currentLease.token !== input.token || currentLease.owner !== owner) throw new Error('网页读取许可已失效，请重新确认教材任务');
    return job;
  }
  /** Generation admission only: do not rewrite snapshots or block historical citation reading. */
  private assertWebEvidenceAdmissible(job: TextbookJob, snapshot: TextbookWebSnapshot): void {
    const resource = job.spec.boundUrls?.find(item => item.id === snapshot.resourceId);
    const supplemental = /^S[1-3]$/u.test(snapshot.resourceId) && job.spec.webSupplement?.version === 1;
    if (!supplemental && (!resource || snapshot.web.url !== resource.url)) throw new Error('网页快照与批准来源不一致');
    if (snapshot.web.format === 'html' && (isTextbookVideoPage(snapshot.web.finalUrl, resource?.resourceType)
      || isTextbookCatalogPage(snapshot.web.finalUrl))) {
      throw new Error('旧网页快照属于视频/课程或书目介绍，不能作为教材正文；快照和草稿已保留，请绑定真实正文或公开字幕后重新准备教材任务');
    }
  }
  private supplementFile(jobId: string): string { this.file(jobId); return path.join(this.directory, 'web-snapshots', `${jobId}-supplement.json`); }
  private async savedSupplement(jobId: string): Promise<TextbookSupplementResult | undefined> {
    try {
      const file = this.supplementFile(jobId), stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16000) throw new Error('补缺记录不可读取');
      const record = JSON.parse(await fs.readFile(file, 'utf8'));
      if (!Array.isArray(record.ids) || record.ids.length > 3 || record.ids.some((id: string) => !/^S[1-3]$/u.test(id))
        || !Array.isArray(record.queries) || record.queries.length > 2 || record.queries.some((q: unknown) => typeof q !== 'string')
        || !Array.isArray(record.warnings) || record.warnings.length > 8 || record.warnings.some((w: unknown) => typeof w !== 'string')) throw new Error('补缺记录不可读取');
      const snapshots: TextbookWebSnapshot[] = [];
      for (const id of record.ids) { const snapshot = await this.webSnapshot(jobId, id); if (!snapshot) throw new Error('补缺快照不可读取'); snapshots.push(snapshot); }
      return { snapshots, queries: record.queries, warnings: record.warnings };
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  private async approvedSupplement(input: TextbookSupplementRequest, owner: number, notes: () => Promise<NoteItem[]>): Promise<TextbookJob> {
    const lease = this.leases.get(input.jobId);
    if (!lease || lease.owner !== owner || lease.token !== input.token) throw new Error('教材联网补缺许可已失效');
    const job = await this.read(input.jobId), allNotes = await notes(), project = allNotes.find(n => n.id === job.spec.projectNoteId);
    if (!job.spec.webSupplement || !project || await textbookHash(projectPlanningSnapshot(project, allNotes, job.spec.allowedDocIds)) !== job.spec.planningHash) throw new Error('教材补缺范围或项目已变化');
    if (this.leases.get(input.jobId)?.token !== input.token) throw new Error('教材联网补缺许可已失效');
    return job;
  }
  async supplement(input: TextbookSupplementRequest, owner: number, notes: () => Promise<NoteItem[]>, deps: TextbookSupplementDependencies = {}): Promise<TextbookSupplementResult> {
    await this.queue.catch(() => {});
    const job = await this.approvedSupplement(input, owner, notes), policy = job.spec.webSupplement!;
    if (!Array.isArray(input.gaps) || input.gaps.length > 2 || input.gaps.some(g => !policy.topics.includes(g.term)
      || !['topic', 'table', 'image'].includes(g.reason) || g.query !== textbookSupplementQuery(policy, g.term, g.reason))) throw new Error('联网补缺词条不在批准范围');
    const cached = await this.savedSupplement(job.id);
    if (cached) { await this.approvedSupplement(input, owner, notes); return cached; }
    const key = `${job.id}:supplement`;
    if (this.reads.has(key)) throw new Error('联网补缺正在执行');
    const controller = new AbortController(); this.reads.set(key, { owner, controller });
    try {
      const result = await collectTextbookSupplement(job.id, policy, input.gaps, controller.signal, deps);
      const next = this.queue.catch(() => {}).then(async () => {
        controller.signal.throwIfAborted(); await this.approvedSupplement(input, owner, notes);
        await fs.mkdir(path.join(this.directory, 'web-snapshots'), { recursive: true });
        for (const snapshot of result.snapshots) await atomicWriteTextFile(this.snapshotFile(job.id, snapshot.resourceId), JSON.stringify(snapshot));
        await atomicWriteTextFile(this.supplementFile(job.id), JSON.stringify({ ids: result.snapshots.map(s => s.resourceId), warnings: result.warnings, queries: result.queries }));
      });
      this.queue = next; await next; return result;
    } finally { this.reads.delete(key); }
  }
  /** Never accepts a URL from IPC. Lookup the frozen resource by ID under an owned lease. */
  async readBoundUrl(input: TextbookWebReadRequest, owner: number, notes: () => Promise<NoteItem[]>,
    reader: (resource: TextbookBoundUrl, signal?: AbortSignal) => Promise<ReadWebBody> = readTextbookBoundBodyWithBrowser): Promise<TextbookWebSnapshot> {
    await this.queue.catch(() => {});
    const job = await this.approvedWebRead(input, owner, notes);
    const cached = await this.webSnapshot(job.id, input.resourceId);
    if (cached) { await this.approvedWebRead(input, owner, notes); this.assertWebEvidenceAdmissible(job, cached); return cached; }
    if (job.checkpoint.webReads?.some((item) => item.id === input.resourceId && item.status === 'saved')
      || job.checkpoint.sources?.some((item) => item.kind === 'web' && item.id === input.resourceId)) {
      throw new Error('已保存的网页快照丢失，不能用当前网页替换生成时证据；请检查本机存储或重新准备新任务');
    }
    const key = `${job.id}:${input.resourceId}`;
    if (this.reads.has(key)) throw new Error('该网页正在读取，请等待当前请求');
    const controller = new AbortController(); this.reads.set(key, { owner, controller });
    try {
      const resource = job.spec.boundUrls!.find((item) => item.id === input.resourceId)!;
      const body: ReadWebBody = await reader(resource, controller.signal); controller.signal.throwIfAborted();
      const web = { snapshotId: `${job.id}-${resource.id}`, url: resource.url, finalUrl: body.finalUrl,
        readAt: new Date().toISOString(), contentType: body.contentType, format: body.format, coverage: 'full_text' as const,
        ...(body.transcriptUrl ? { transcriptUrl: body.transcriptUrl } : {}), ...(body.contentKind ? { contentKind: body.contentKind } : {}),
        ...(body.acquisition ? { acquisition: body.acquisition } : {}) };
      const snapshot: TextbookWebSnapshot = { schemaVersion: 1, jobId: job.id, resourceId: resource.id,
        title: resource.title, text: body.text, web, version: await textbookHash({ text: body.text, web }) };
      this.assertWebEvidenceAdmissible(job, snapshot);
      // Serialize commit with stop/lease changes. Each successful URL survives a later failure/crash.
      const next = this.queue.catch(() => {}).then(async () => {
        controller.signal.throwIfAborted(); await this.approvedWebRead(input, owner, notes);
        controller.signal.throwIfAborted(); await fs.mkdir(path.join(this.directory, 'web-snapshots'), { recursive: true });
        await atomicWriteTextFile(this.snapshotFile(job.id, resource.id), JSON.stringify(snapshot));
      });
      this.queue = next; await next; return snapshot;
    } catch (error) { throw new Error(safeTextbookWebError(error)); }
    finally { this.reads.delete(key); }
  }
  /** Citation reading is offline and exposes only the published range, never the private job. */
  async readWebEvidence(input: TextbookWebEvidenceRequest, notes: () => Promise<NoteItem[]>): Promise<{ text: string; nextCursor?: number }> {
    const project = (await notes()).find((note) => note.id === input.projectNoteId && note.noteType === 'project');
    const source = project?.textbook?.sources?.find((item) => item.sourceId === input.sourceId && item.kind === 'web');
    const jobId = project?.textbook?.generationJobId;
    if (!source?.web || !jobId || source.web.snapshotId !== input.snapshotId || source.version !== input.version) throw new Error('来源未在已发布教材中授权');
    const snapshot = await this.webSnapshot(jobId, source.id);
    if (!snapshot || snapshot.version !== source.version) throw new Error('生成时网页快照不可读；不会用当前网页替换旧证据');
    const start = source.textStart!, end = source.textEnd!, cursor = input.cursor ?? start;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end > snapshot.text.length || end <= start
      || !Number.isSafeInteger(cursor) || cursor < start || cursor >= end) throw new Error('网页证据坐标无效');
    const pageEnd = Math.min(end, cursor + 8000);
    return { text: snapshot.text.slice(cursor, pageEnd), nextCursor: pageEnd < end ? pageEnd : undefined };
  }
  private async verifyWebSources(job: TextbookJob): Promise<void> {
    for (const source of job.checkpoint.sources || []) if (source.kind === 'web') {
      const snapshot = await this.webSnapshot(job.id, source.id);
      const allowed = source.id.startsWith('S') ? job.spec.webSupplement?.version === 1 && (await this.savedSupplement(job.id))?.snapshots.some(s => s.resourceId === source.id && s.web.url === source.web?.url)
        : job.spec.readBoundUrls && job.spec.boundUrls?.some((item) => item.id === source.id && item.url === source.web?.url);
      if (!allowed
        || !snapshot || source.version !== snapshot.version || !source.web || source.web.snapshotId !== snapshot.web.snapshotId
        || !Number.isSafeInteger(source.textStart) || !Number.isSafeInteger(source.textEnd) || source.textStart! < 0
        || source.textEnd! <= source.textStart! || source.textEnd! > snapshot.text.length
        || source.text !== snapshot.text.slice(source.textStart, source.textEnd)
        || JSON.stringify({ ...source.web, coverage: 'full_text' }) !== JSON.stringify(snapshot.web)
        || JSON.stringify(source.assets || []) !== JSON.stringify((snapshot.assets || []).map(asset => ({ ...asset, sourceId: source.sourceId })))) throw new Error('教材网页证据未绑定生成时快照');
      this.assertWebEvidenceAdmissible(job, snapshot);
    }
  }
  command(input: TextbookJobCommand, owner: number, notes: () => Promise<NoteItem[]>): Promise<TextbookJobReply> {
    const next = this.queue.catch(() => {}).then(() => this.execute(input, owner, notes));
    this.queue = next; return next;
  }
  private async execute(input: TextbookJobCommand, owner: number, notes: () => Promise<NoteItem[]>): Promise<TextbookJobReply> {
    if (input.op === 'create') {
      const spec = input.spec;
      if (spec?.webSupplement && (spec.webSupplement.version !== 1 || !Array.isArray(spec.webSupplement.topics)
        || spec.webSupplement.topics.length < 1 || spec.webSupplement.topics.length > 4
        || spec.webSupplement.topics.some(t => typeof t !== 'string' || !t.trim() || t.length > 60)
        || typeof spec.webSupplement.domain !== 'string' || spec.webSupplement.domain.length > 24
        || typeof spec.webSupplement.tables !== 'boolean' || typeof spec.webSupplement.images !== 'boolean')) throw new Error('教材联网补缺范围无效');
      if (spec?.boundUrls !== undefined && (!Array.isArray(spec.boundUrls) || spec.boundUrls.length > 12
        || new Set(spec.boundUrls.map((item) => item.id)).size !== spec.boundUrls.length
        || spec.boundUrls.some((item) => !/^U\d{1,2}$/u.test(item.id) || typeof item.url !== 'string' || item.url.length > 4096 || typeof item.title !== 'string')
        || typeof spec.readBoundUrls !== 'boolean')) throw new Error('教材绑定 URL 范围无效');
      if (spec?.modelPolicy !== undefined) validateTextbookModelPolicy(spec.modelPolicy);
      validateTextbookThinkingSnapshot(spec?.thinkingSnapshot, spec?.modelPolicy);
      validateTextbookPromptVersion(spec?.promptVersion);
      if (spec?.visualCapabilitiesVersion !== undefined && ![2, 3].includes(spec.visualCapabilitiesVersion)) throw new Error('教材可视化能力版本无效');
      if (spec?.schemaVersion !== 1 || !spec.projectNoteId || !spec.rootProjectId || typeof spec.allowCloud !== 'boolean'
        || !/^[a-f0-9]{64}$/u.test(spec.planningHash) || !/^[a-f0-9]{64}$/u.test(spec.providerHash)
        || !Array.isArray(spec.allowedDocIds) || spec.allowedDocIds.length > 12
        || new Set(spec.allowedDocIds).size !== spec.allowedDocIds.length || !spec.documentHashes || !spec.knowledgeHashes
        || [...Object.keys(spec.documentHashes)].sort().join('|') !== [...spec.allowedDocIds].sort().join('|')
        || [...Object.values(spec.documentHashes), ...Object.values(spec.knowledgeHashes)].some((hash) => !/^[a-f0-9]{64}$/u.test(hash))) throw new Error('教材批准范围无效');
      if (input.reuseExisting) {
        // Serialized with creation/claim: two preparations cannot create duplicate jobs.
        const candidates: TextbookJob[] = [];
        for (const id of await this.index(spec.projectNoteId)) {
          const existing = await this.read(id);
          if (existing.spec.projectNoteId !== spec.projectNoteId) throw new Error('教材任务目录与项目不一致');
          // Upgrading optional discovery must not abandon an old partial book or
          // silently grant that old task new network authority. Reuse its narrower frozen scope.
          const compatibleLegacy = !existing.spec.webSupplement && !!spec.webSupplement
            && sameTextbookJobScope(existing.spec, { ...spec, webSupplement: undefined });
          const compatible = sameTextbookJobScope(existing.spec, spec) || compatibleLegacy;
          if (this.leases.has(existing.id) && !compatible) throw new Error('该项目已有不同范围的教材任务正在执行，请先等待或停止原任务；不另建任务');
          if (compatible) candidates.push(existing);
        }
        const existing = preferredTextbookJob(candidates, (id) => this.leases.has(id));
        if (existing) return { job: existing, reused: true, running: this.leases.has(existing.id) };
      }
      const at = new Date().toISOString();
      const job: TextbookJob = { schemaVersion: 1, id: randomUUID(), spec: JSON.parse(JSON.stringify(spec)), stage: 'prepared', createdAt: at, updatedAt: at, attempt: 0, checkpoint: {} };
      await this.save(job);
      await atomicWriteTextFile(this.indexFile(spec.projectNoteId), JSON.stringify([job.id, ...await this.index(spec.projectNoteId)].slice(0, 64)));
      return { job };
    }
    const job = await this.read(input.jobId);
    if (input.op === 'get') return { job };
    if (input.op === 'preview-clear-cache' || input.op === 'clear-cache') {
      try {
        if (this.leases.has(job.id) || [...this.reads.keys()].some((key) => key.startsWith(`${job.id}:`))) {
          throw new Error('教材任务仍在运行或读取资料，请先停止后再清理；未删除任何缓存');
        }
        // A crash can leave a durable note while its private task is still failed.
        if ((await notes()).some((note) => note.textbook?.generationJobId === job.id)) throw new Error('该任务已被项目教材引用，不能清理已发布教材的缓存');
        const revision = await textbookHash(job);
        if (input.op === 'clear-cache' && (typeof input.expectedRevision !== 'string' || input.expectedRevision !== revision)) {
          throw new Error('教材缓存自确认后已变化，未执行清理；请重新检查目标并确认');
        }
        const cleared = clearTextbookDraftCache(job, input, new Date().toISOString());
        if (cleared.hasContent && input.scope !== 'backups_only') {
          const history = job.checkpoint.progress?.history || [];
          cleared.job.checkpoint.progress = initialTextbookProgress(cleared.job);
          cleared.job.checkpoint.progress.label = input.scope === 'all_generated' ? '生成缓存已清空，任务已归档；原资料与累计用量保留' : '指定章节缓存已清理，确认后才继续生成；其它章节保留';
          cleared.job.checkpoint.progress.history = [...history, { at: cleared.job.updatedAt, stage: 'chapters' as const, label: cleared.job.checkpoint.progress.label }].slice(-24);
        }
        if (cleared.hasContent) cleared.job.cacheClearRevision = revision;
        const beforeBytes = Buffer.byteLength(JSON.stringify(job), 'utf8'), afterBytes = Buffer.byteLength(JSON.stringify(cleared.job), 'utf8');
        const cacheClear = { jobId: job.id, projectNoteId: job.spec.projectNoteId, projectTitle: job.spec.projectTitle, revision,
          scope: input.scope, chapterIds: cleared.chapterIds, backupChapterIds: cleared.backupChapterIds,
          clearsAssembledBody: cleared.clearsAssembledBody, autoArchive: cleared.hasContent && input.scope === 'all_generated', hasContent: cleared.hasContent,
          beforeBytes, afterBytes, freedBytes: Math.max(0, beforeBytes - afterBytes) };
        if (input.op === 'clear-cache' && cleared.hasContent) await this.save(cleared.job, true);
        return { job: input.op === 'clear-cache' ? cleared.job : job, cacheClear };
      } catch (error) { throw new Error(safeTextbookTaskError(error instanceof Error ? error.message : '教材缓存清理失败，未完成删除')); }
    }
    if (input.op === 'archive') {
      if (typeof input.archived !== 'boolean') throw new Error('教材任务归档参数无效');
      if (this.leases.has(job.id)) throw new Error('教材任务仍在运行，请先停止后再归档；未清理任何草稿');
      if (job.stage === 'published') throw new Error('已发布教材不通过未完成任务清理入口处理');
      if (input.archived) job.archivedAt ||= new Date().toISOString(); else delete job.archivedAt;
      job.updatedAt = new Date().toISOString(); await this.save(job); return { job };
    }
    if (input.op === 'claim') {
      if (job.archivedAt) throw new Error('教材任务已归档，请先明确恢复原任务；不会新建任务或重置用量');
      if (input.expectedCacheClearRevision !== undefined && input.expectedCacheClearRevision !== (job.cacheClearRevision || '')) throw new Error('教材缓存已被清理，旧继续请求已失效；请重新检查并确认');
      if ([...this.leases.values()].some((lease) => lease.projectId === job.spec.projectNoteId)) throw new Error('该项目已有教材任务正在执行，请等待或停止原任务');
      if (input.publishedRevision) {
        const allNotes = await notes(), note = allNotes.find(item => item.id === job.spec.projectNoteId);
        if (!note || note.textbook?.revisionId !== input.publishedRevision.expectedRevisionId) throw new Error('教材版本自确认后已变化，未覆盖');
        validatePublishedChapterRegeneration(job, note, input.publishedRevision.chapterIds);
        const originalPlanningHash = job.checkpoint.publishedRevision?.originalPlanningHash || job.spec.planningHash;
        if (await textbookHash(planningBeforePublication(note, allNotes, job.spec.allowedDocIds)) !== originalPlanningHash) throw new Error('原计划或继承资料绑定已变化，请重新核对；未开始章节重生成');
        const body = job.checkpoint.body!;
        job.stage = 'context';
        queueTextbookChapterRegeneration(job, input.publishedRevision.chapterIds);
        job.checkpoint.publishedRevision = { revisionId: note.textbook.revisionId, nextRevisionId: `revision-${randomUUID()}`, originalPlanningHash,
          body, chapterIds: [...input.publishedRevision.chapterIds] };
        job.spec.planningHash = await textbookHash(projectPlanningSnapshot(note, allNotes, job.spec.allowedDocIds));
      } else if (job.stage === 'published') return { job };
      const token = randomUUID();
      job.attempt++; job.stage = 'context'; job.error = undefined; job.updatedAt = new Date().toISOString();
      await this.save(job);
      // Resuming an older job must put it back into the bounded project index,
      // so a reopened panel can find it even after many later preparations.
      await atomicWriteTextFile(this.indexFile(job.spec.projectNoteId), JSON.stringify([job.id, ...(await this.index(job.spec.projectNoteId)).filter((id) => id !== job.id)].slice(0, 64)));
      this.leases.set(job.id, { token, owner, projectId: job.spec.projectNoteId }); return { job, token };
    }
    const lease = this.leases.get(job.id);
    if (!lease || lease.token !== input.token || lease.owner !== owner) throw new Error('教材执行许可已失效，请重新确认');
    if (input.op === 'checkpoint') {
      if (!['context', 'materials', 'blueprint', 'chapters', 'validating', 'publishing'].includes(input.stage)) throw new Error('教材进度不可由草稿标记为已发布');
      job.stage = input.stage; job.checkpoint = JSON.parse(JSON.stringify(input.checkpoint));
      await this.verifyWebSources(job);
    } else if (input.op === 'stop') {
      this.cancelWebRead(job.id, input.token, owner);
      job.stage = input.cancelled ? 'cancelled' : 'failed'; job.error = input.error.slice(0, 400);
      const progress = job.checkpoint.progress ||= initialTextbookProgress(job);
      const step = progress.steps.find((item) => item.stage === progress.currentStage);
      if (step) step.status = input.cancelled ? 'cancelled' : 'failed';
      progress.label = input.cancelled ? '已停止，已保存检查点可在确认后继续' : '当前阶段失败，已保存检查点保留';
      progress.history = [...progress.history, { at: new Date().toISOString(), stage: progress.currentStage, label: progress.label }].slice(-24);
    } else if (input.op === 'finish') {
      await this.verifyWebSources(job);
      validateTextbookJob(job, job.checkpoint.body || '');
      const published = (await notes()).find((note) => note.id === job.spec.projectNoteId);
      if (published?.textbook?.generationJobId !== job.id || readTextbookBody(published.content, published.textbook) !== job.checkpoint.body?.trim()) throw new Error('尚未验证教材落盘，不报告写入成功');
      job.stage = 'published';
      const progress = job.checkpoint.progress ||= initialTextbookProgress(job);
      progress.currentStage = 'publishing'; progress.label = '完整教材已保存到项目笔记';
      progress.steps.forEach((step) => { step.status = 'saved'; });
      progress.history = [...progress.history, { at: new Date().toISOString(), stage: 'publishing' as const, label: progress.label }].slice(-24);
    } else throw new Error('教材任务操作无效');
    job.updatedAt = new Date().toISOString(); await this.save(job);
    if (input.op === 'finish' || input.op === 'stop') this.leases.delete(job.id);
    return { job };
  }
}
