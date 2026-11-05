import type { NoteItem, ResourceItem } from '../types';
import { projectAncestors } from './projectResourceScope';

export interface FlowResourceEntry {
  resource: ResourceItem;
  ownerNoteId?: string;
  ownerTitle: string;
  inherited: boolean;
  temporary: boolean;
}

/** Session/tab identity only. Do not change URLs, login partitions or persisted feedback keys. */
export function flowResourceKey(resource: ResourceItem): string {
  if (resource.documentId) return `document:${resource.documentId}`;
  const raw = resource.url.trim();
  if (!raw) return '';
  // Keep fragments and query strings: they can identify different lessons/pages.
  try { return `url:${new URL(raw).href}`; } catch { return `url:${raw}`; }
}

/** Read-only flow shelf: self, nearest parent, then root; never siblings or other roots.
 * This is not the textbook/web-search permission scope and must not widen it. */
export function flowResourceShelf(note: NoteItem, notes: NoteItem[], initialResource?: ResourceItem): {
  entries: FlowResourceEntry[]; warning?: string;
} {
  let chain = [note], warning: string | undefined;
  if (note.noteType === 'project') {
    try {
      const ancestors = projectAncestors(note, notes);
      const counts = new Map<string, number>();
      for (const item of notes) counts.set(item.id, (counts.get(item.id) || 0) + 1);
      for (const ancestor of ancestors) {
        if ((counts.get(ancestor.id) || 0) > 1) throw new Error('ambiguous ancestor');
      }
      chain = ancestors;
    } catch {
      // Preserve explicitly bound resources, but do not guess ancestry after corruption.
      warning = '项目父级关系异常，仅显示当前项目资源；请检查项目层级。';
    }
  }
  const entries: FlowResourceEntry[] = [], found = new Set<string>();
  chain.forEach((owner, depth) => {
    for (const resource of owner.resources || []) {
      const key = flowResourceKey(resource);
      if (!key || found.has(key)) continue;
      found.add(key);
      entries.push({ resource, ownerNoteId: owner.id, ownerTitle: owner.title, inherited: depth > 0, temporary: false });
    }
  });
  if (initialResource) {
    const key = flowResourceKey(initialResource);
    if (key && !found.has(key)) entries.unshift({ resource: initialResource, ownerTitle: '本次临时资源', inherited: false, temporary: true });
  }
  return { entries, warning };
}
