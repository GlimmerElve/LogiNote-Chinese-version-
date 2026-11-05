import type { NoteItem } from '../types';

export const KNOWLEDGE_PLACEHOLDER = '请对该知识点进行定义描述';

/** Shared Wiki initialization, deliberately without navigation or model calls. */
export function initializeWikiKnowledge(title: string, id: string, now = new Date().toISOString()): NoteItem {
  title = title.trim();
  if (!title || title.length > 120 || /[\r\n\[\]]/u.test(title)) throw new Error('Wiki 知识点名称无效，请先检查链接');
  return { id, title, content: KNOWLEDGE_PLACEHOLDER, noteType: 'knowledge', tags: ['新建图谱节点'],
    links: [], backlinks: [], dueDates: [], createdAt: now, updatedAt: now };
}

export function isUnfilledWikiKnowledge(note: NoteItem): boolean {
  return note.noteType === 'knowledge' && !note.textbook
    && (!note.content.trim() || note.content.trim() === KNOWLEDGE_PLACEHOLDER);
}
