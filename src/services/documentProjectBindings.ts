import type { NoteItem, UploadedDocument } from '../types';
import type { WorkspaceNoteChange } from './agent/workspaceOperations';
import { detectLocalFileType } from './localResource';

export function directDocumentProjects(notes: NoteItem[], documentId: string): string[] {
  return notes.filter(note => note.noteType === 'project' && note.resources?.some(item => item.documentId === documentId)).map(note => note.id);
}

/** Change references only. Never copy/delete the document or rewrite note bodies. */
export function prepareDocumentProjectBindings(notes: NoteItem[], document: UploadedDocument,
  projectIds: string[], expectedProjectIds: string[], now = new Date().toISOString()): WorkspaceNoteChange | null {
  const key = (ids: string[]) => JSON.stringify([...new Set(ids)].sort());
  if (new Set(projectIds).size !== projectIds.length || projectIds.some(id => !notes.some(note => note.id === id && note.noteType === 'project'))) {
    throw new Error('部分目标项目已失效，请重新选择');
  }
  const currentIds = directDocumentProjects(notes, document.id);
  // A previous optimistic save may have failed. Retrying the identical desired
  // state must flush pending data, not overwrite anything or duplicate references.
  if (key(currentIds) === key(projectIds)) return null;
  if (key(currentIds) !== key(expectedProjectIds)) throw new Error('该资料的项目绑定已变化，请关闭整理面板后重新打开');
  const selected = new Set(projectIds), previous = new Set(expectedProjectIds);
  const before = notes.filter(note => note.noteType === 'project' && selected.has(note.id) !== previous.has(note.id));
  if (!before.length) return null;
  const after = before.map(note => ({ ...note, updatedAt: now, resources: selected.has(note.id)
    ? [...(note.resources || []), { title: document.fileName, url: `loginote-document://${document.id}`,
      documentId: document.id, kind: 'local' as const, platform: '本地资料库', fileType: detectLocalFileType(document.fileName),
      ...(document.sourceUrl ? { sourceUrl: document.sourceUrl } : {}) }]
    : (note.resources || []).filter(resource => resource.documentId !== document.id) }));
  return { kind: 'edit', label: `调整资料《${document.fileName}》的项目绑定`, before, after };
}
