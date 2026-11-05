import type { NoteItem } from '../types';

/** Patch research content only; retain newer metadata and refuse deleted or edited output. */
export function prepareStormNoteWrite(notes: NoteItem[], output: NoteItem, expected: NoteItem | null, createdIds: Set<string>): NoteItem {
  const current = notes.find(note => note.id === output.id);
  if (expected === null) {
    if (!current && createdIds.has(output.id)) throw new Error('研究笔记已移除，未重新创建，请返回重新设置');
    if (current && (current.noteType !== 'project' || current.content !== output.content)) throw new Error('研究笔记已被编辑，未覆盖内容，请返回重新设置');
    return current || output;
  }
  if (!current) throw new Error('研究笔记已移除，未重新创建，请返回重新设置');
  if (current.noteType !== 'project' || current.content !== expected.content && current.content !== output.content) {
    throw new Error('研究笔记正文已变化，未覆盖用户编辑，请返回重新设置');
  }
  return {...current, content: output.content, updatedAt: output.updatedAt,
    generatedContentBlocks: [...new Set([...(current.generatedContentBlocks || []), ...(output.generatedContentBlocks || [])])]};
}
