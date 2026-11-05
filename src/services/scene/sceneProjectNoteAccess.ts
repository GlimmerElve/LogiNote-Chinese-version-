import type { NoteItem } from '../../types';
import { collectProjectKnowledgeNotes } from '../knowledgePointSelector';
import { hasSubstantiveReferenceText } from '../ragSourcePolicy';
import { S2ProjectNoteSource } from './sceneS2ProjectNotes';

/** App-side boundary ONLY. Never import this private-state bridge into the isolated S2 preview graph.
 * Reuses the existing linked/descendant knowledge-note selector, not global storage or an IPC vault load.
 */
export function createSceneProjectNoteSource(projectId: string | undefined, getNotes: () => NoteItem[]): S2ProjectNoteSource | undefined {
  if (!projectId || !getNotes().some(note => note.id === projectId && note.noteType === 'project')) return undefined;
  const inScope = () => collectProjectKnowledgeNotes(projectId, getNotes());
  return new S2ProjectNoteSource({ projectId,
    list: () => inScope().map(note => ({ noteId: note.id, label: note.title, updatedAt: note.updatedAt })),
    read: async (noteId, signal) => {
      if (signal.aborted) throw new DOMException('已停止', 'AbortError');
      const note = inScope().find(item => item.id === noteId && item.noteType === 'knowledge');
      if (!note) throw new Error('笔记已移出所选项目或已删除，未读取。');
      // No spread/serialization of NoteItem: exclude argumentDocs, mastery, profile and other personal sidecars.
      const text = note.content;
      if (typeof text !== 'string' || !hasSubstantiveReferenceText(text)) throw new Error('该知识笔记尚无有效正文；未用标题或默认占位符代替资料。');
      return { noteId: note.id, updatedAt: note.updatedAt, text };
    },
  });
}
