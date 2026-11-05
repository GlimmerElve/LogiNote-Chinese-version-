import type { ConceptDraft, NoteItem } from '../../types';

/** Confirmed draft replaces only the original body/references, never newer edits or metadata. */
export function prepareConceptNoteWrite(
  current: NoteItem, expected: NoteItem, content: string, references?: ConceptDraft['references'],
): NoteItem {
  if (current.id !== expected.id || current.noteType !== expected.noteType || !content.trim()) {
    throw new Error('概念写入目标已变化，草稿已保留，请返回核对笔记。');
  }
  const original = current.content === expected.content
    && JSON.stringify(current.referenceSources || []) === JSON.stringify(expected.referenceSources || []);
  const retry = current.content === content
    && JSON.stringify(current.referenceSources || []) === JSON.stringify(references || []);
  if (!original && !retry) throw new Error('笔记正文或引用已有新修改，未覆盖。草稿已保留，请返回核对。');
  return { ...current, content, referenceSources: references, updatedAt: new Date().toISOString() };
}
