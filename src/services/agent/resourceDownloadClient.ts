import type { NoteItem, ResourceItem } from '../../types';
import { normalizeResourceUrl } from '../resourceState';
import { resolveNoteByTitleOrAlias } from '../noteResolver';
import { resourceDownloadSnapshot, type ResourceDownloadPlan, type ResourceDownloadBatch, type ResourceDownloadPort } from '../resourceDownloads';

export interface ResourceDownloadApi {
  prepare(input: { projectId: string; urls?: string[] }): Promise<ResourceDownloadPlan>;
  execute(id: string): Promise<ResourceDownloadBatch>;
  executeAutomatic?(id: string): Promise<ResourceDownloadBatch>;
  release?(id: string): Promise<unknown>;
  cancel(id: string): Promise<unknown>;
}
export function publicResourceDownloadPlan(plan: ResourceDownloadPlan) {
  return { planId: plan.id, projectTitle: plan.projectTitle, expiresAt: plan.expiresAt,
    files: plan.files.map(f => ({ title: f.title, url: f.url, fileName: f.fileName, bytes: f.size, indexable: f.indexable })),
    skipped: plan.skipped, maxFileBytes: 100 * 1024 * 1024, maxFiles: 8 };
}
export function createResourceDownloadClient(deps: {
  notes(): NoteItem[]; active(): NoteItem | null; api(): ResourceDownloadApi | undefined;
  automaticAllowed?(): boolean;
  save(plan: ResourceDownloadPlan, batch: ResourceDownloadBatch, assertAllowed?: () => void): Promise<{ bound: number }>;
}) {
  const plans = new Map<string, ResourceDownloadPlan>(), running = new Set<string>();
  const getPlan = (id: string) => {
    const plan = plans.get(id), project = deps.notes().find(n => n.id === plan?.projectId);
    if (!plan || Date.parse(plan.expiresAt) < Date.now()) throw new Error('下载预览已失效，请重新准备');
    if (!project || resourceDownloadSnapshot(project) !== plan.sourceSnapshot) throw new Error('项目资源已变化，请重新准备下载确认');
    return structuredClone(plan);
  };
  const assertAutomatic = () => {
    if (deps.automaticAllowed?.() !== true) throw new Error('自动收录已关闭，停止自动下载；原链接保留');
  };
  const prepare: ResourceDownloadPort['prepare'] = async (input) => {
      const api = deps.api(); if (!api) throw new Error('当前环境不支持资源批量下载');
      const projects = deps.notes().filter(n => n.noteType === 'project');
      const project = input.projectTitle ? resolveNoteByTitleOrAlias(input.projectTitle, projects) : deps.active();
      if (!project || project.noteType !== 'project') throw new Error('请指定要下载资源的项目');
      const snapshot = resourceDownloadSnapshot(project);
      const plan = await api.prepare({ projectId: project.id, urls: input.urls });
      if (plan.projectId !== project.id || plan.sourceSnapshot !== snapshot) throw new Error('项目尚未保存或资源已变化，请保存后重新准备');
      for (const [id, cached] of plans) if (Date.parse(cached.expiresAt) < Date.now()) plans.delete(id);
      if (plans.size >= 24) plans.delete(plans.keys().next().value!);
      plans.set(plan.id, structuredClone(plan)); return plan;
    };
  // Automatic authority comes only from the application setting, never model arguments.
  const execute = async (id: string, execution: { signal?: AbortSignal; userApproved?: boolean } = {}, automatic = false) => {
      if (automatic) assertAutomatic();
      else if (execution.userApproved !== true) throw new Error('请先确认本次独立下载的具体文件清单');
      const assertAllowed = () => { execution.signal?.throwIfAborted(); if (automatic) assertAutomatic(); };
      assertAllowed();
      const plan = getPlan(id), api = deps.api(); if (!api) throw new Error('下载接口不可用');
      if (!plan.files.length) throw new Error('本批没有可直接下载的附件');
      if (running.has(id)) throw new Error('该批次正在下载'); running.add(id);
      const cancel = () => { void api.cancel(id).catch(() => {}); };
      execution.signal?.addEventListener('abort', cancel, { once: true });
      try {
        if (automatic && !api.executeAutomatic) throw new Error('请重启更新后的应用以启用自动下载；原链接保留');
        const batch = automatic ? await api.executeAutomatic!(id) : await api.execute(id); assertAllowed();
        getPlan(id);
        let bound = 0;
        try { if (batch.items.some(i => i.document)) bound = (await deps.save(plan, batch, assertAllowed)).bound; }
        catch { assertAllowed(); throw new Error('下载结果已保留在资料库，但项目绑定未保存；可重试本批绑定，不会重复下载'); }
        plans.delete(id);
        return { status: batch.items.some(i => i.error) || batch.stopped ? 'partial' : 'downloaded', saved: bound > 0,
          projectTitle: plan.projectTitle, planned: plan.files.length, bound, downloaded: batch.items.filter(i => i.document && !i.reused).length,
          reused: batch.items.filter(i => i.reused).length,
          documents: batch.items.filter(i => i.document).map(i => ({ title: i.document!.fileName, documentId: i.document!.id,
            indexing: i.document!.indexable ? '后台解析/索引，不代表已完成' : '仅保存，当前不支持索引' })),
          failed: batch.items.filter(i => i.error).map(i => ({ title: plan.files.find(f => f.id === i.fileId)?.title,
            url: plan.files.find(f => f.id === i.fileId)?.url, error: i.error })),
          notAttempted: plan.files.filter(f => !batch.items.some(i => i.fileId === f.id)).map(f => ({ title: f.title, url: f.url })), stopped: batch.stopped };
      } finally { running.delete(id); execution.signal?.removeEventListener('abort', cancel); }
    };
  return {
    getPlan, prepare,
    execute: (id: string, execution?: { signal?: AbortSignal; userApproved?: boolean }) => execute(id, execution),
    async collectAutomatically(input: { projectId: string; resources: ResourceItem[]; signal?: AbortSignal; onProgress?: (text: string) => void }) {
      const summary = { bound: 0, downloaded: 0, reused: 0, failed: 0, skipped: 0, stopped: false, errors: [] as string[] };
      if (deps.automaticAllowed?.() !== true) { summary.stopped = true; return summary; }
      // Probe only this search's newly selected public resources, including dynamic URLs.
      const urls = [...new Set(input.resources.filter(r => r.kind !== 'local' && r.accessType === 'public' && r.isFree !== false)
        .map(r => normalizeResourceUrl(r.url)))];
      for (let offset = 0; offset < urls.length; offset += 8) {
        let prepared: ResourceDownloadPlan | undefined;
        try {
          input.signal?.throwIfAborted(); assertAutomatic();
          const project = deps.notes().find(n => n.id === input.projectId && n.noteType === 'project');
          if (!project) throw new Error('自动下载目标项目不存在');
          // Exact project ID is authoritative, even if another project has the same title.
          const snapshot = resourceDownloadSnapshot(project), api = deps.api();
          if (!api?.executeAutomatic) throw new Error('自动下载接口不可用；请重启更新后的应用，原链接保留');
          input.onProgress?.('资源已收录，正在识别并下载可用附件到本地资料库…');
          prepared = await api.prepare({ projectId: input.projectId, urls: urls.slice(offset, offset + 8) });
          input.signal?.throwIfAborted(); assertAutomatic();
          if (prepared.projectId !== project.id || prepared.sourceSnapshot !== snapshot) throw new Error('项目资源已变化，停止自动下载');
          for (const [id, cached] of plans) if (Date.parse(cached.expiresAt) < Date.now()) plans.delete(id);
          if (plans.size >= 24) plans.delete(plans.keys().next().value!);
          plans.set(prepared.id, structuredClone(prepared));
          summary.skipped += prepared.skipped.length;
          if (!prepared.files.length) { plans.delete(prepared.id); await api.release?.(prepared.id).catch(() => {}); continue; }
          const result = await execute(prepared.id, { signal: input.signal }, true);
          await api.release?.(prepared.id).catch(() => {});
          summary.bound += result.bound; summary.downloaded += result.downloaded; summary.reused += result.reused;
          summary.failed += result.failed.length + result.notAttempted.length;
          if (result.stopped) { summary.stopped = true; break; }
        } catch (error) {
          summary.failed += prepared?.files.length || urls.slice(offset, offset + 8).length;
          summary.errors.push(error instanceof Error && /[\u4e00-\u9fff]/u.test(error.message) ? error.message : '附件下载未完成，原链接保留');
          if (input.signal?.aborted || deps.automaticAllowed?.() !== true || /项目资源已变化/u.test(summary.errors.at(-1)!)) { summary.stopped = true; break; }
        }
      }
      return summary;
    },
  };
}
