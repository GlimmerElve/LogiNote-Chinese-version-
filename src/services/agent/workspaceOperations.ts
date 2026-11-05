import type { NoteItem } from '../../types';
import { readTextbookBody, hasTextbookBoundaryMarker, projectPlanningContent } from '../textbook/noteContent';
import { findNotesByTitleOrAlias, noteAliasesError } from '../noteResolver';
import { applyNoteRenameReferences, noteRenameError } from '../noteRename';
import { isPersonalOnlyNoteChange } from '../personalNoteState';
import { assertProjectRole, isLearningProject, isReferenceProject } from '../projectRole';

export interface WorkspaceNoteChange {
  kind: 'create' | 'edit' | 'move' | 'remove' | 'rename' | 'restore' | 'merge';
  label: string;
  before: NoteItem[];
  after: NoteItem[];
  /** Parent and other dependencies that must still match when the queue starts. */
  dependencies?: NoteItem[];
  knowledgeOnly?: boolean;
  knowledgeMerges?: Array<{ sourceId: string; targetId: string }>;
}

export function workspaceNoteVersion(note: NoteItem | undefined): string {
  if (!note) return 'absent';
  // These are derived from the entire vault, not edited or restored independently.
  const { links, backlinks, dueDates, ...source } = note;
  return JSON.stringify(source, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
}

function protectManagedContent(before: NoteItem, content: string): void {
  if (before.textbook) {
    const oldBody = readTextbookBody(before.content, before.textbook);
    if (oldBody === null || readTextbookBody(content, before.textbook) !== oldBody) throw new Error('该改动涉及受管教材区域，请使用教材章节工具');
  } else if (hasTextbookBoundaryMarker(before.content) || hasTextbookBoundaryMarker(content)) {
    throw new Error('教材边界未绑定，不能通过普通正文编辑处理');
  }
  const markers = (value: string) => value.match(/<(?:TextbookBoundary|LearningReviewBlock|ArgumentBlock)\b[^>]*>/gu) || [];
  if (JSON.stringify(markers(before.content)) !== JSON.stringify(markers(content))) throw new Error('不能用普通正文编辑新增、删除或修改教材、复盘及论证控制块');
}

export function prepareNoteEdit(notes: NoteItem[], input: {
  noteId: string; replacements?: Array<{ oldText: string; newText: string }>; appendText?: string;
  title?: string; tags?: string[]; aliases?: string[]; pinned?: boolean; isFavorite?: boolean;
}): WorkspaceNoteChange {
  const note = notes.find(item => item.id === input.noteId);
  if (!note) throw new Error('目标笔记不存在');
  const title = input.title === undefined ? note.title : input.title.trim();
  if (!title || title.length > 120) throw new Error('笔记标题应为 1 至 120 个字符');
  if (title !== note.title) {
    const error = noteRenameError(notes, note.id, title);
    if (error) throw new Error(error);
  }
  if (input.aliases !== undefined && (!Array.isArray(input.aliases) || input.aliases.length > 30
    || input.aliases.some(alias => typeof alias !== 'string' || !alias.trim() || alias.trim().length > 120 || /[\u0000-\u001f\[\]|]/u.test(alias)))) throw new Error('别名须为最多 30 个有效名称，每个不超过 120 字');
  const aliases = input.aliases === undefined ? [...(note.aliases || [])] : [...new Map(input.aliases.map(alias => [alias.trim().toLowerCase(), alias.trim()])).values()];
  if (title !== note.title && !aliases.some(alias => alias.toLowerCase() === note.title.toLowerCase())) aliases.push(note.title);
  const nextAliases = aliases.filter(alias => alias.toLowerCase() !== title.toLowerCase());
  if (input.aliases !== undefined || title !== note.title) {
    const error = noteAliasesError(notes, note.id, nextAliases);
    if (error) throw new Error(error);
  }
  let content = note.content;
  const replacements = input.replacements || [];
  if (replacements.length > 20) throw new Error('单次最多替换 20 处正文');
  for (const replacement of replacements) {
    if (typeof replacement.oldText !== 'string' || !replacement.oldText || typeof replacement.newText !== 'string'
      || replacement.oldText.length > 30_000 || replacement.newText.length > 30_000) throw new Error('请提供真实且完整的待替换片段');
    const index = content.indexOf(replacement.oldText);
    if (index < 0 || content.indexOf(replacement.oldText, index + 1) >= 0) throw new Error('待替换片段不存在或出现多次，请重新读取并定位唯一片段');
    content = content.slice(0, index) + replacement.newText + content.slice(index + replacement.oldText.length);
  }
  if (input.appendText !== undefined) {
    if (typeof input.appendText !== 'string' || input.appendText.length > 30_000) throw new Error('追加正文过长或无效');
    content += (content && input.appendText ? '\n\n' : '') + input.appendText;
  }
  if (content.length > Math.max(note.content.length + 60_000, 300_000)) throw new Error('本次正文变更过大，请拆分操作');
  protectManagedContent(note, content);
  if (isLearningProject(note)) {
    const tasks = (value: string) => projectPlanningContent(value, note.textbook).split('\n').filter(line => /@due\(|^\s*[-*+]\s*\[[ xX]\]|loginote-task/u.test(line));
    if (JSON.stringify(tasks(note.content)) !== JSON.stringify(tasks(content))) throw new Error('项目任务的增删改请使用计划任务草案工具，以同步时间线及任务身份');
  }
  if (input.tags && (input.tags.length > 30 || input.tags.some(tag => typeof tag !== 'string' || !tag.trim() || tag.length > 40))) throw new Error('标签格式无效');
  const after: NoteItem = { ...note, title, content,
    ...(input.aliases !== undefined || title !== note.title ? { aliases: nextAliases } : {}),
    ...(input.tags !== undefined ? { tags: [...new Set(input.tags.map(tag => tag.trim()))] } : {}),
    ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
    ...(input.isFavorite !== undefined ? { isFavorite: input.isFavorite } : {}),
    ...(title !== note.title ? { resources: note.resources?.map(resource => resource.projectTitle === note.title ? { ...resource, projectTitle: title } : resource) } : {}),
  };
  if (workspaceNoteVersion(note) === workspaceNoteVersion(after)) throw new Error('没有需要修改的内容');
  if (!isPersonalOnlyNoteChange(note, after)) after.updatedAt = new Date().toISOString();
  // Record the target's rewritten self-links too, so recovery compares against
  // the version that was actually saved. Other notes are rebased at apply time;
  // undoing the rename must not restore their unrelated historical body text.
  const savedTarget = title !== note.title ? applyNoteRenameReferences(notes, [after], note.id)[0] : after;
  return { kind: title !== note.title ? 'rename' : 'edit', label: `修改笔记《${note.title}》`, before: [note], after: [savedTarget] };
}

function assertReferenceSubtree(notes: NoteItem[], root: NoteItem): void {
  const pending = [root], seen = new Set<string>();
  const children = new Map<string, NoteItem[]>();
  for (const note of notes) if (note.parentId) {
    const siblings = children.get(note.parentId) || []; siblings.push(note); children.set(note.parentId, siblings);
  }
  while (pending.length) {
    const item = pending.pop()!;
    if (seen.has(item.id)) throw new Error('资料型项目下级存在循环');
    seen.add(item.id); assertProjectRole(item);
    if (isLearningProject(item)) throw new Error('资料型项目中含学习项目，请先通过计划结构草案整理');
    for (const child of children.get(item.id) || []) pending.push(child);
  }
}

export function prepareNoteMove(notes: NoteItem[], ids: string[], parentId: string | null): WorkspaceNoteChange {
  if (!ids.length || ids.length > 50 || new Set(ids).size !== ids.length) throw new Error('请选择 1 至 50 篇不同笔记');
  const parent = parentId ? notes.find(note => note.id === parentId && note.noteType === 'project') : undefined;
  if (parentId && !parent) throw new Error('目标父项目不存在');
  const before = ids.map(id => { const note = notes.find(item => item.id === id); if (!note) throw new Error('部分笔记已不存在'); return note; });
  const plannedRoot = (note: NoteItem) => {
    const visited = new Set<string>(); let item: NoteItem | undefined = note;
    while (item && !visited.has(item.id)) { if (item.planMeta) return true; visited.add(item.id); item = notes.find(candidate => candidate.id === item!.parentId); }
    return false;
  };
  for (const note of before) {
    if (note.id === parentId) throw new Error('不能把项目移动到自身');
    if (isReferenceProject(note)) assertReferenceSubtree(notes, note);
    if (isLearningProject(note) && (plannedRoot(note) || (parent && plannedRoot(parent)))) throw new Error('计划项目的层级变更请使用计划结构草案，以同步里程碑和执行事项');
    const seen = new Set([note.id]); let ancestor = parent;
    while (ancestor) { if (seen.has(ancestor.id)) throw new Error('移动会形成项目层级循环'); seen.add(ancestor.id); ancestor = notes.find(item => item.id === ancestor!.parentId); }
  }
  const after = before.map(note => ({ ...note, parentId: parent?.id, updatedAt: new Date().toISOString() }));
  const dependencies = new Map<string, NoteItem>();
  for (const start of [...before.map(note => notes.find(item => item.id === note.parentId)), parent]) {
    let ancestor = start;
    while (ancestor && !dependencies.has(ancestor.id)) { dependencies.set(ancestor.id, ancestor); ancestor = notes.find(item => item.id === ancestor!.parentId); }
  }
  return { kind: 'move', label: `移动 ${before.length} 篇笔记到${parent ? `《${parent.title}》` : '根目录'}`, before, after, dependencies: [...dependencies.values()] };
}

/** Apply only the selected objects; never restore a snapshot of the whole vault. */
export function applyWorkspaceNoteChange(notes: NoteItem[], change: WorkspaceNoteChange): NoteItem[] {
  const before = new Map(change.before.map(note => [note.id, note]));
  const after = new Map(change.after.map(note => [note.id, note]));
  for (const [id, expected] of before) if (workspaceNoteVersion(notes.find(note => note.id === id)) !== workspaceNoteVersion(expected)) throw new Error('目标笔记在确认后发生修改，请重新确认');
  for (const dependency of change.dependencies || []) if (workspaceNoteVersion(notes.find(note => note.id === dependency.id)) !== workspaceNoteVersion(dependency)) throw new Error('父项目在确认后发生变化，请重新确认');
  for (const [id, note] of after) {
    assertProjectRole(note);
    if (!before.has(id) && notes.some(item => item.id === id)) throw new Error('恢复或创建的笔记 ID 已存在');
    const previous = before.get(id);
    const preservesName = previous?.title === note.title && JSON.stringify(previous.aliases || []) === JSON.stringify(note.aliases || []);
    // Existing project titles may repeat across roots. An ID-bound body/resource
    // edit must preserve that state, not misclassify it as a new name collision.
    const other = previous?.title === note.title ? [] : findNotesByTitleOrAlias(note.title, [...notes.filter(item => item.id !== id && !before.has(item.id)), ...change.after.filter(item => item.id !== id)]);
    if (other.length) throw new Error(`笔记标题或别名已被占用：${note.title}`);
    if (!preservesName) for (const alias of note.aliases || []) {
      if (findNotesByTitleOrAlias(alias, [...notes.filter(item => item.id !== id && !before.has(item.id)), ...change.after.filter(item => item.id !== id)]).length) throw new Error(`笔记别名已被占用：${alias}`);
    }
  }
  for (const id of before.keys()) if (!after.has(id)) {
    if (notes.some(note => note.parentId === id && !before.has(note.id))) throw new Error('项目新增了未选中的下级内容，请重新确认');
    let ancestor = notes.find(note => note.id === before.get(id)?.parentId);
    const seen = new Set<string>();
    while (ancestor && !seen.has(ancestor.id)) {
      seen.add(ancestor.id);
      if (before.get(id)?.noteType === 'project' && !(change.kind === 'restore' && isReferenceProject(before.get(id)))
        && ancestor.planMeta && !before.has(ancestor.id)) throw new Error('该项目仍属于已发布计划，请先用计划结构草案解除关联，避免留下失效执行事项');
      ancestor = notes.find(note => note.id === ancestor!.parentId);
    }
  }
  for (const note of change.after) if (!before.has(note.id) && isLearningProject(note) && change.kind === 'create') {
    let ancestor = notes.find(item => item.id === note.parentId); const seen = new Set<string>();
    while (ancestor && !seen.has(ancestor.id)) {
      seen.add(ancestor.id); if (ancestor.planMeta) throw new Error('计划下的项目请通过计划结构草案新增，以同步时间线与任务');
      ancestor = notes.find(item => item.id === ancestor!.parentId);
    }
  }
  let result = notes.flatMap(note => before.has(note.id) ? (after.has(note.id) ? [after.get(note.id)!] : []) : [note]);
  result.push(...change.after.filter(note => !before.has(note.id)));
  for (const note of change.after) if (isReferenceProject(note) && before.get(note.id)?.parentId !== note.parentId) assertReferenceSubtree(result, note);
  for (const note of change.after) if (note.parentId && !result.some(parent => parent.id === note.parentId && parent.noteType === 'project')) throw new Error('父项目已不存在，不能恢复或移动');
  for (const note of change.after) {
    const seen = new Set<string>(); let current: NoteItem | undefined = note;
    while (current) {
      if (seen.has(current.id)) throw new Error('恢复或移动会形成层级循环');
      if (current.id !== note.id && isLearningProject(note) && isReferenceProject(current)) throw new Error('资料型项目下不能挂载学习项目');
      seen.add(current.id); current = result.find(item => item.id === current!.parentId);
    }
  }
  for (const note of change.after) {
    if (before.get(note.id)?.title !== undefined && before.get(note.id)!.title !== note.title) {
      result = applyNoteRenameReferences(notes, result, note.id);
    }
  }
  return result;
}
