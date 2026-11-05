import type { NoteItem, ResourceItem, PlanMeta } from '../../types';
import { projectAncestors } from '../projectResourceScope';
import { automaticResourceContentIssue } from '../resourceContentAdmission';
import { textbookPublicUrl } from '../textbook/boundUrls';

export interface LearningPreparation {
  version: 1; rootId: string; title: string; goalKey: string;
  status: 'pending' | 'searching' | 'recommended' | 'collecting' | 'ready' | 'failed';
  candidates: ResourceItem[]; selected: string[]; approved: boolean; automatic: boolean;
  bound: number; updatedAt: string; error?: string;
}
export type LearningPreparationCommand = { op: 'status' | 'enqueue' | 'retry' | 'upload'; rootId: string }
  | { op: 'accept'; rootId: string; goalKey: string; urls: string[] };
export interface LearningPreparationApi {
  command(input: LearningPreparationCommand): Promise<LearningPreparation | null>;
  onChange(callback: (rootId: string, change?: PreparedResourceChange) => void): () => void;
  materials?(projectId: string): Promise<import('./types').ProgressiveSourcePacket[]>;
}
export interface PreparedResourceChange { noteId: string; before: ResourceItem[]; resources: ResourceItem[]; updatedAt: string }
/** Rebase only resources. A pending body/title, local removal or edited resource
 * remains the user's draft; the acknowledged baseline advances separately. */
export function rebasePreparedResources(current: NoteItem, baseline: NoteItem, change: PreparedResourceChange): { note: NoteItem; saved: NoteItem } | null {
  if (current.id !== change.noteId || baseline.id !== change.noteId || JSON.stringify(baseline.resources || []) !== JSON.stringify(change.before)) return null;
  const key = (item: ResourceItem) => item.sourceUrl || item.url;
  const before = new Map(change.before.map(item => [key(item), item])), after = new Map(change.resources.map(item => [key(item), item]));
  const seen = new Set<string>();
  const resources = (current.resources || []).flatMap(item => {
    const id = key(item); seen.add(id); const original = before.get(id);
    if (!original || JSON.stringify(original) !== JSON.stringify(item)) return [item];
    const saved = after.get(id); return saved ? [saved] : [];
  });
  for (const item of change.resources) if (!seen.has(key(item)) && !before.has(key(item))) resources.push(item);
  return { note: { ...current, resources, updatedAt: current.updatedAt === baseline.updatedAt ? change.updatedAt : current.updatedAt },
    saved: { ...baseline, resources: change.resources, updatedAt: change.updatedAt } };
}
export function preparationRoot(note: NoteItem, notes: NoteItem[]): NoteItem | undefined {
  if (note.noteType !== 'project' || note.projectRole === 'reference') return;
  try { const root = projectAncestors(note, notes).at(-1); return root?.planMeta && root.projectRole !== 'reference' ? root : undefined; }
  catch { return; }
}
export function preparationGoal(root: NoteItem): string {
  return root.title.trim().replace(/\s+/gu, ' ').slice(0, 160);
}
export function plannedPreparationDocuments(documents: PlanMeta['preparationDocuments']): ResourceItem[] {
  return (Array.isArray(documents) ? documents : []).slice(0, 8).filter(document => document && /^doc-[a-zA-Z0-9_-]+$/u.test(document.id) && typeof document.title === 'string' && document.title.trim())
    .map(document => ({ title: document.title.slice(0, 300), kind: 'local', documentId: document.id, url: `loginote-document://${document.id}`, indexable: document.indexable, platform: '本地资料库' }));
}
/** A closed projection of actual public search hits; no cookies, partitions,
 * filesystem pointers, private descriptions or invented download targets. */
export function preparationCandidates(resources: ResourceItem[], title: string): ResourceItem[] {
  const seen = new Set<string>(), result: ResourceItem[] = [];
  for (const resource of resources.slice(0, 30)) {
    if (resource.kind === 'local' || resource.accessType !== 'public' || resource.isFree === false) continue;
    let url: string;
    try {
      url = textbookPublicUrl(resource.url);
      const host = new URL(url).hostname;
      if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.localhost') || host.includes(':') || /^\d+(?:\.\d+){3}$/u.test(host)) continue;
    } catch { continue; }
    if (seen.has(url) || automaticResourceContentIssue(resource, { projectTitle: title, knowledgeTitles: [title] })) continue;
    seen.add(url);
    result.push({ title: resource.title.slice(0, 300), url, kind: 'online', accessType: 'public',
      resourceType: resource.resourceType, platform: resource.platform?.slice(0, 100), isFree: resource.isFree,
      searchCategory: resource.searchCategory, downloadable: resource.downloadable, isAttachment: resource.isAttachment,
      description: resource.description?.slice(0, 1800),
      reason: '围绕根项目目标推荐，子项目可继承使用。', taskText: `学习${title}`, knowledgeTitles: [title], collectionOrigin: 'agent' });
    if (result.length === 3) break;
  }
  return result;
}
export function mergePreparationResources(note: NoteItem, resources: ResourceItem[]): NoteItem {
  const existing = new Set((note.resources || []).flatMap(item => [item.url, item.sourceUrl].filter(Boolean)));
  const added = resources.filter(item => !existing.has(item.url) && (!item.documentId || !note.resources?.some(old => old.documentId === item.documentId)));
  return added.length ? { ...note, resources: [...(note.resources || []), ...added], updatedAt: new Date().toISOString() } : note;
}
