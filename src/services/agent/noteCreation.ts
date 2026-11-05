import type { NoteItem } from '../../types';
import { findNotesByTitleOrAlias, resolveNoteByTitleOrAlias } from '../noteResolver';
import { noteRenameError } from '../noteRename';
import { isReferenceProject } from '../projectRole';
import type { AgentCreateNoteInput } from './types';

/** Shared by the tool preview and the actual write port; never infer purpose from prose. */
export function prepareAgentNoteCreation(args: Record<string, unknown>, notes: NoteItem[]): {
  input: AgentCreateNoteInput; parent?: NoteItem;
} {
  const requiredText = (value: unknown, label: string, max: number) => {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new Error(`${label}长度应为 1 到 ${max} 个字符`);
    return value.trim();
  };
  const title = requiredText(args.title, '笔记标题', 120), content = requiredText(args.content, '笔记正文', 30000);
  if (args.noteType !== 'knowledge' && args.noteType !== 'project') throw new Error('noteType 必须是 knowledge 或 project');
  if (args.projectRole !== undefined && (args.noteType !== 'project' || typeof args.projectRole !== 'string' || !['reference', 'learning'].includes(args.projectRole))) throw new Error('projectRole 仅适用于项目，须为 reference 或 learning');
  if (findNotesByTitleOrAlias(title, notes).length) throw new Error(`同名或同别名笔记已存在：${title}`);
  const titleError = noteRenameError(notes, '', title);
  if (titleError) throw new Error(titleError);
  if (args.parentProjectId !== undefined && args.parentProjectTitle !== undefined) throw new Error('父项目 ID 与标题只提供一种，优先使用稳定 ID');
  const parentId = args.parentProjectId === undefined ? undefined : requiredText(args.parentProjectId, '父项目 ID', 200);
  const parentTitle = args.parentProjectTitle === undefined ? undefined : requiredText(args.parentProjectTitle, '父项目标题', 120);
  const parent = parentId ? notes.find(note => note.id === parentId) : parentTitle ? resolveNoteByTitleOrAlias(parentTitle, notes) : undefined;
  if ((parentId || parentTitle) && (!parent || parent.noteType !== 'project')) throw new Error('未找到明确的父项目，请重新读取');
  if (args.noteType === 'project' && args.projectRole !== 'reference' && isReferenceProject(parent)) throw new Error('资料型项目下不能隐式新增学习项目，请选择学习父项目');
  if (args.projectRole === 'reference' && /<(?:TextbookBoundary|LearningReviewBlock|ArgumentBlock)\b/u.test(content)) throw new Error('资料型项目不能创建受管学习内容');
  let tags: string[] = [];
  if (args.tags !== undefined) {
    if (!Array.isArray(args.tags) || !args.tags.length || args.tags.length > 12) throw new Error('标签必须包含 1 到 12 项');
    tags = [...new Set(args.tags.map(tag => requiredText(tag, '标签', 24)))];
  }
  return { input: { title, content, noteType: args.noteType, ...(tags.length ? { tags } : {}),
    ...(args.projectRole !== undefined ? { projectRole: args.projectRole as 'learning' | 'reference' } : {}),
    ...(parent ? { parentProjectId: parent.id } : {}) }, parent };
}
