import type { NoteItem, ResourceItem, UploadedDocument } from '../types';
import { normalizeResourceUrl } from './resourceState';

export interface ResourceDownloadFile { id: string; title: string; url: string; downloadUrl: string; extension: string; fileName: string; size?: number; indexable: boolean }
export interface ResourceDownloadPlan { id: string; projectId: string; projectTitle: string; createdAt: string; expiresAt: string;
  sourceSnapshot: string; files: ResourceDownloadFile[]; skipped: Array<{ title: string; reason: string }> }
export interface ResourceDownloadBatch { planId: string; items: Array<{ fileId: string; document?: UploadedDocument; reused?: boolean; error?: string }>; stopped: boolean }
export interface ResourceDownloadPort {
  prepare(input: { projectTitle?: string; urls?: string[] }): Promise<ResourceDownloadPlan>;
  getPlan(id: string): ResourceDownloadPlan;
  execute(id: string, execution?: { signal?: AbortSignal; userApproved?: boolean }): Promise<unknown>;
}
/** Only target identity/resources are frozen; unrelated note edits stay intact. */
export function resourceDownloadSnapshot(project: NoteItem): string {
  return JSON.stringify({ id: project.id, title: project.title, resources: project.resources || [] });
}
export function bindDownloadedProjectResources(notes: NoteItem[], plan: ResourceDownloadPlan, batch: ResourceDownloadBatch): { notes: NoteItem[]; bound: number } {
  if (batch.planId !== plan.id) throw new Error('下载结果与确认批次不一致');
  const project = notes.find(n => n.id === plan.projectId && n.noteType === 'project');
  if (!project || resourceDownloadSnapshot(project) !== plan.sourceSnapshot) throw new Error('项目资源已变化，文件仍保留在资料库；请重新准备绑定');
  let bound = 0;
  const files = new Map(plan.files.map(f => [f.id, f]));
  const succeeded = new Map<string, { document: UploadedDocument; sourceUrl: string }>();
  for (const item of batch.items) {
    const file = files.get(item.fileId);
    if (!file) throw new Error('下载结果包含未批准文件');
    if (item.document) {
      if (!item.document.id || !/^doc-[a-zA-Z0-9_-]+$/u.test(item.document.id)) throw new Error('资料编号无效');
      succeeded.set(normalizeResourceUrl(file.url), { document: item.document, sourceUrl: file.url });
    }
  }
  const resources = (project.resources || []).map(resource => {
    const downloaded = succeeded.get(normalizeResourceUrl(resource.url));
    if (!downloaded || resource.kind === 'local') return resource;
    const { document, sourceUrl } = downloaded;
    bound++;
    return { title: resource.title, url: `loginote-document://${document.id}`, kind: 'local', documentId: document.id,
      sourceUrl, platform: '本地资料库', fileType: document.fileType === 'pdf' ? 'pdf' : ['txt', 'md'].includes(document.fileType) ? 'text'
        : ['image', 'audio', 'video'].includes(document.fileType) ? document.fileType : ['doc', 'docx', 'ppt', 'pptx', 'xlsx', 'xls', 'epub'].includes(document.fileType) ? 'office' : 'other',
      taskText: resource.taskText, knowledgeTitles: resource.knowledgeTitles, searchCategory: resource.searchCategory,
      collectionOrigin: resource.collectionOrigin, reason: '资源统筹已下载到本地资料库并绑定项目，保留原始来源。',
      resourceType: resource.resourceType, indexable: document.indexable, verifiedAt: document.uploadAt } as ResourceItem;
  });
  return { notes: bound ? notes.map(n => n.id === project.id ? { ...n, resources, updatedAt: new Date().toISOString() } : n) : notes, bound };
}
