import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { NoteItem, ResourceItem, UploadedDocument } from '../types';
import { resourceDownloadSnapshot, type ResourceDownloadPlan, type ResourceDownloadBatch } from '../services/resourceDownloads';
import { normalizeResourceUrl } from '../services/resourceState';
import { textbookPublicUrl } from '../services/textbook/boundUrls';
import { classifyBrowserResource, safeAttachmentFileName } from './resourceBrowserCore';
import { checkPublicResourceUrl } from './resourceHealth';

interface Dependencies {
  notes(): Promise<NoteItem[]>; scope(): string;
  health?: typeof checkPublicResourceUrl;
  documents(): Promise<UploadedDocument[]>;
  documentExists?(document: UploadedDocument): Promise<boolean>;
  download(resource: ResourceItem, signal: AbortSignal): Promise<{ filePath?: string }>;
  importFile(filePath: string, sourceUrl: string): Promise<{ ok: boolean; documents?: UploadedDocument[]; error?: string }>;
}
async function abortablePreparation<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cancel = () => { signal.removeEventListener('abort', cancel); reject(signal.reason); };
    signal.addEventListener('abort', cancel, { once: true });
    void work.then(value => { signal.removeEventListener('abort', cancel); if (!signal.aborted) resolve(value); }, error => { signal.removeEventListener('abort', cancel); reject(error); });
  });
}
export function safeResourceDownloadError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return message && /[\u4e00-\u9fff]/u.test(message) && !/[a-z]:[\\/]|\\\\|\n\s*at\s|\/(?:Users|home|tmp|private|workspace)\//iu.test(message)
    ? message.slice(0, 240) : '本机项目读取或下载失败，请检查存储和网络；原链接保留';
}
/** Host-owned, bounded, expiring batches. No arbitrary URL/path accepted at execute. */
export class ResourceDownloadBatchStore {
  private running = false;
  private plans = new Map<string, { plan: ResourceDownloadPlan; owner: number; scope: string; controller?: AbortController; result?: ResourceDownloadBatch }>();
  constructor(private deps: Dependencies) {}
  async prepare(owner: number, projectId: string, requested?: string[], signal?: AbortSignal): Promise<ResourceDownloadPlan> {
    signal?.throwIfAborted();
    for (const [id, entry] of this.plans) if (!entry.controller && Date.parse(entry.plan.expiresAt) < Date.now()) this.plans.delete(id);
    if (this.plans.size >= 24) throw new Error('待确认下载批次过多，请稍后重试');
    const scope = this.deps.scope();
    const project = (await this.deps.notes()).find(n => n.id === projectId && n.noteType === 'project');
    if (!project) throw new Error('下载目标项目不存在');
    if (requested !== undefined && (!Array.isArray(requested) || !requested.length || requested.length > 12 || requested.some(u => typeof u !== 'string'))) throw new Error('每次仅检查 1～12 个已绑定 URL');
    const selected = requested ? new Set(requested.map(normalizeResourceUrl)) : null;
    const online = (project.resources || []).filter(r => r.kind !== 'local' && /^https?:\/\//iu.test(r.url));
    if (selected && [...selected].some(u => !online.some(r => normalizeResourceUrl(r.url) === u))) throw new Error('不能下载项目未收录的 URL，请先搜索并收录');
    const plan: ResourceDownloadPlan = { id: randomUUID(), projectId: project.id, projectTitle: project.title,
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      sourceSnapshot: resourceDownloadSnapshot(project), files: [], skipped: [] };
    const candidates = online.filter(r => !selected || selected.has(normalizeResourceUrl(r.url)));
    if (candidates.length > 12) plan.skipped.push({ title: '其余资源', reason: '本批只检查前 12 个链接，可指定 URL 分批处理' });
    const seen = new Set<string>();
    for (const resource of candidates.slice(0, 12)) {
      signal?.throwIfAborted();
      if (seen.has(normalizeResourceUrl(resource.url))) continue;
      seen.add(normalizeResourceUrl(resource.url));
      let reason = '';
      try {
        const url = textbookPublicUrl(resource.url);
        const health = await abortablePreparation((this.deps.health || checkPublicResourceUrl)(url), signal);
        if (!['available', 'redirected'].includes(health.status)) reason = `当前不能直接下载${health.httpStatus ? `（HTTP ${health.httpStatus}）` : ''}；需登录/验证或链接不可用`;
        else {
          const downloadUrl = textbookPublicUrl(health.finalUrl || url);
          const info = classifyBrowserResource({ title: resource.title, url: downloadUrl, contentType: health.contentType, downloadName: health.suggestedFileName });
          if (!info.downloadable || !info.fileExtension) reason = '这是网页或未支持的附件，不以搜索摘要冒充文件';
          else if (health.contentLength && health.contentLength > 100 * 1024 * 1024) reason = '超过单文件 100 MB 上限';
          else if (plan.files.length >= 8) reason = '本批最多 8 个文件，请分批下载';
          else plan.files.push({ id: `F${plan.files.length + 1}`, title: resource.title, url, downloadUrl,
            extension: info.fileExtension, indexable: info.indexable, size: health.contentLength,
            fileName: safeAttachmentFileName(resource.title, downloadUrl, health.suggestedFileName, info.fileExtension) });
        }
      } catch { reason = 'URL 不符合公开资源规则或核验失败；原链接保留'; }
      if (reason) plan.skipped.push({ title: resource.title, reason });
    }
    if (this.deps.scope() !== scope) throw new Error('存储范围已变化，请重新准备');
    if (this.plans.size >= 24) throw new Error('待确认下载批次过多，请稍后重试');
    signal?.throwIfAborted();
    this.plans.set(plan.id, { plan: structuredClone(plan), owner, scope });
    return plan;
  }
  cancel(owner: number, id?: string): void {
    for (const [key, entry] of this.plans) if (entry.owner === owner && (!id || key === id)) entry.controller?.abort();
  }
  releaseOwner(owner: number): void {
    for (const [id, entry] of this.plans) if (entry.owner === owner) { entry.controller?.abort(); this.plans.delete(id); }
  }
  release(owner: number, id: string): void {
    const entry = this.plans.get(id);
    if (entry?.owner === owner && !entry.controller) this.plans.delete(id);
  }
  private async assertCurrent(entry: { plan: ResourceDownloadPlan; scope: string }): Promise<void> {
    if (this.deps.scope() !== entry.scope) throw new Error('存储范围已变化，下载已停止');
    const project = (await this.deps.notes()).find(n => n.id === entry.plan.projectId && n.noteType === 'project');
    if (!project || resourceDownloadSnapshot(project) !== entry.plan.sourceSnapshot) throw new Error('项目资源已变化，请重新准备下载');
  }
  async execute(owner: number, id: string, assertAllowed?: () => Promise<void>): Promise<ResourceDownloadBatch> {
    const entry = this.plans.get(id);
    if (!entry || entry.owner !== owner || Date.parse(entry.plan.expiresAt) < Date.now()) throw new Error('下载确认批次已失效，请重新准备');
    if (this.running) throw new Error('已有批次正在下载，请勿重复执行');
    // Acquire synchronously before IO, including the first scope check.
    const controller = new AbortController(); entry.controller = controller; this.running = true;
    const result: ResourceDownloadBatch = { planId: id, items: [], stopped: false };
    try {
      await assertAllowed?.(); await this.assertCurrent(entry); controller.signal.throwIfAborted();
      if (entry.result) return structuredClone(entry.result);
      for (const file of entry.plan.files) {
        let temporary = '';
        try {
          controller.signal.throwIfAborted(); await assertAllowed?.(); await this.assertCurrent(entry); controller.signal.throwIfAborted();
          const existing = (await this.deps.documents()).find(d => d.sourceUrl && normalizeResourceUrl(d.sourceUrl) === normalizeResourceUrl(file.url));
          controller.signal.throwIfAborted();
          if (existing && (!this.deps.documentExists || await this.deps.documentExists(existing))) {
            controller.signal.throwIfAborted(); result.items.push({ fileId: file.id, document: existing, reused: true }); continue;
          }
          const downloaded = await this.deps.download({ title: file.title, url: file.downloadUrl, kind: 'online',
            downloadable: true, fileExtension: file.extension, suggestedFileName: file.fileName, indexable: file.indexable }, controller.signal);
          temporary = downloaded.filePath || ''; if (!temporary) throw new Error('下载未产生文件');
          controller.signal.throwIfAborted(); await assertAllowed?.(); await this.assertCurrent(entry); controller.signal.throwIfAborted();
          const imported = await this.deps.importFile(temporary, file.url);
          if (!imported.ok || !imported.documents?.[0]) throw new Error('文件入库失败');
          result.items.push({ fileId: file.id, document: imported.documents[0] });
        } catch (error) {
          result.items.push({ fileId: file.id, error: '下载或入库未完成，原链接保留；可重新准备失败项' });
          if (controller.signal.aborted || this.deps.scope() !== entry.scope || (error instanceof Error && /项目资源已变化|存储范围已变化|自动收录已关闭/u.test(error.message))) { result.stopped = true; break; }
        } finally {
          if (temporary) { await fs.unlink(temporary).catch(() => {}); await fs.rmdir(path.dirname(temporary)).catch(() => {}); }
        }
      }
      entry.result = structuredClone(result); return result;
    } finally { entry.controller = undefined; this.running = false; }
  }
}
