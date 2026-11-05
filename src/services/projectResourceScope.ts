import type { NoteItem } from '../types';

/** A binding grants descendant projects access, never siblings or other roots. */
export function projectAncestors(project: NoteItem, notes: NoteItem[]): NoteItem[] {
  if (project.noteType !== 'project') throw new Error('资源范围必须属于项目');
  const byId = new Map(notes.map(note => [note.id, note]));
  const chain: NoteItem[] = [], seen = new Set<string>();
  let current: NoteItem | undefined = project;
  while (current) {
    if (seen.has(current.id)) throw new Error('项目父级关系存在循环，不能确定资料范围');
    seen.add(current.id); chain.push(current);
    if (!current.parentId) break;
    current = byId.get(current.parentId);
    if (!current || current.noteType !== 'project') throw new Error('项目父级已失效，不能确定资料范围');
  }
  return chain;
}

export function projectDocumentBindings(project: NoteItem, notes: NoteItem[]) {
  const found = new Set<string>();
  return projectAncestors(project, notes).flatMap((owner, depth) => (owner.resources || []).flatMap(resource => {
    if (!resource.documentId || found.has(resource.documentId)) return [];
    found.add(resource.documentId);
    return [{ documentId: resource.documentId, projectNoteId: owner.id, projectTitle: owner.title,
      inherited: depth > 0 }];
  }));
}

export function projectDisplayPath(project: NoteItem, notes: NoteItem[]): string {
  try { return projectAncestors(project, notes).reverse().map(note => note.title).join(' / '); }
  catch { return `${project.title}（父级关系异常）`; }
}
