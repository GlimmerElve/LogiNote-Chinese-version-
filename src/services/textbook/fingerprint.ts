import type { NoteItem } from '../../types';
import { projectPlanningContent, removeLearningBlockMarkers } from './noteContent.ts';
import { projectAncestors, projectDocumentBindings } from '../projectResourceScope';

export function stableTextbookValue(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
}
export async function textbookHash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stableTextbookValue(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
export function projectPlanningSnapshot(note: NoteItem, notes?: NoteItem[], allowedDocIds: string[] = []): unknown {
  // Only pinned inherited documents affect this job. Unrelated parent edits and
  // newly bound documents must not cancel or silently expand a long-running job.
  const inherited = notes ? projectDocumentBindings(note, notes).filter(item => item.inherited && allowedDocIds.includes(item.documentId)) : [];
  return { id: note.id, parentId: note.parentId, title: note.title, noteType: note.noteType,
    content: removeLearningBlockMarkers(projectPlanningContent(note.content, note.textbook)).trim(), resources: note.resources || [], textbook: note.textbook || null,
    ...(inherited.length ? { inheritedDocumentScope: { chain: projectAncestors(note, notes!).map(item => item.id),
      bindings: inherited.map(item => ({ documentId: item.documentId, projectNoteId: item.projectNoteId })) } } : {}) };
}
/** A published manifest is new, but original planning/resources/ancestor scope must still match. */
export function planningBeforePublication(note: NoteItem, notes: NoteItem[], allowedDocIds: string[]): unknown {
  return { ...(projectPlanningSnapshot(note, notes, allowedDocIds) as Record<string, unknown>), textbook: null };
}
export function textbookRoot(note: NoteItem, notes: NoteItem[]): NoteItem {
  const seen = new Set<string>();
  let current = note;
  while (current.parentId) {
    if (seen.has(current.id)) throw new Error('项目父级关系存在循环，不能生成教材');
    seen.add(current.id);
    const parent = notes.find((item) => item.id === current.parentId && item.noteType === 'project');
    if (!parent) throw new Error('项目父级已失效，不能生成教材');
    current = parent;
  }
  return current;
}
