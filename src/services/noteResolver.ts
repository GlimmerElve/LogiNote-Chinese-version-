import type { NoteItem } from "../types";
import { migratedKnowledge } from './knowledgeLifecycle';

type NamedNote = Pick<NoteItem, 'id' | 'title' | 'aliases'>;
export const noteNameKey = (value: string): string => value.trim().toLowerCase();

/** Titles and aliases share one namespace. Count a note once even if its own
 * title and aliases repeat; old conflicting vault data must never pick by order. */
export function findNotesByTitleOrAlias<T extends NamedNote>(target: string, notes: readonly T[]): T[] {
  const key = noteNameKey(target || '');
  if (!key) return [];
  const matches = notes.filter(note => [note.title, ...(note.aliases || [])].some(name => noteNameKey(name) === key));
  return [...new Map(matches.map(note => [note.id, note])).values()];
}

export type NoteReferenceResolution<T extends NamedNote = NoteItem> =
  | { status: 'missing' }
  | { status: 'unique'; note: T }
  | { status: 'ambiguous'; matches: T[] };

export function resolveNoteReference<T extends NamedNote>(target: string, notes: readonly T[]): NoteReferenceResolution<T> {
  const matches = findNotesByTitleOrAlias(target, notes);
  const migrated = !matches.length ? migratedKnowledge(target, notes) : undefined;
  return matches.length > 1 ? { status: 'ambiguous', matches } : matches.length === 1 ? { status: 'unique', note: matches[0] }
    : migrated ? { status: 'unique', note: migrated } : { status: 'missing' };
}

export function ambiguousNoteReferenceMessage(target: string, matches: readonly NamedNote[]): string {
  const names = [...new Set(matches.map(note => `《${note.title}》`))].join('、');
  return `引用「${target}」匹配 ${matches.length} 篇笔记（${names}），请在目录中修改重复的标题或别名后再打开。`;
}

/** Validate edits before publishing them. Existing conflicts may still be read
 * and repaired, but no edit may introduce another ambiguous destination. */
export function noteAliasesError(notes: readonly NamedNote[], noteId: string, aliases: readonly string[]): string | null {
  if (aliases.length > 30 || aliases.some(alias => !alias.trim() || alias.trim() === '#' || alias.trim().length > 120 || /[\u0000-\u001f\[\]|]/u.test(alias))) {
    return '别名最多 30 个，每个为 1 至 120 个字符，不能包含换行、方括号或 |，也不能仅为 #';
  }
  for (const alias of aliases) {
    const conflicts = findNotesByTitleOrAlias(alias, notes.filter(note => note.id !== noteId));
    if (conflicts.length) return `别名「${alias.trim()}」与笔记${[...new Set(conflicts.map(note => `《${note.title}》`))].join('、')}的标题或别名冲突，尚未保存。`;
  }
  return null;
}

/** Compatibility lookup: ambiguity is deliberately unresolved. Creation and
 * collision checks must use the structured result or all matches above. */
export function resolveNoteByTitleOrAlias(
  target: string,
  notes: readonly NoteItem[],
): NoteItem | undefined {
  const result = resolveNoteReference(target, notes);
  return result.status === 'unique' ? result.note : undefined;
}

export interface WikiLinkDestination { noteTitle: string; heading?: string; label?: string }
export type WikiNames = readonly NamedNote[] | ((name: string) => boolean);

/** Prefer a complete saved name, then the longest existing name before a #.
 * Without a namespace this remains a syntax-only parser for Markdown rendering. */
export function parseWikiLink(raw: string, names?: WikiNames): WikiLinkDestination {
  const value = (raw || '').trim();
  const pipe = value.indexOf('|');
  const destination = (pipe >= 0 ? value.slice(0, pipe) : value).trim();
  const exists = typeof names === 'function' ? names : names ? (name: string) => findNotesByTitleOrAlias(name, names).length > 0 : undefined;
  let hash = destination.indexOf('#');
  if (exists?.(destination)) hash = -1;
  else if (exists) {
    for (let index = destination.lastIndexOf('#'); index > 0; index = destination.lastIndexOf('#', index - 1)) {
      if (exists(destination.slice(0, index).trim())) { hash = index; break; }
    }
  }
  return {
    noteTitle: (hash >= 0 ? destination.slice(0, hash) : destination).trim(),
    ...(hash >= 0 ? { heading: destination.slice(hash + 1).trim() } : {}),
    ...(pipe >= 0 ? { label: value.slice(pipe + 1).trim() } : {}),
  };
}

/** Resolve only the note name; a #heading remains separate from identity. */
export function parseWikiLinkTarget(raw: string, names?: WikiNames): string {
  return parseWikiLink(raw, names).noteTitle;
}

/**
 * 归一化链接目标：命中某笔记的标题或别名时返回其「标题」（原名），
 * 否则原样返回。用于反向链接/知识图谱计算，让 `[[别名]]` 也能指向原名笔记。
 */
export function normalizeLinkTarget(target: string, notes: NoteItem[]): string {
  const title = parseWikiLinkTarget(target, notes);
  const resolved = resolveNoteByTitleOrAlias(title, notes);
  return resolved ? resolved.title : title;
}

/**
 * 判断某文本是否命中笔记的标题或别名（大小写不敏感的子串匹配）。
 * 用于搜索/查询类 UI 过滤。
 */
export function matchesTitleOrAlias(note: NoteItem, query: string): boolean {
  const q = (query || "").trim().toLowerCase();
  if (!q) return true;
  if (note.title.toLowerCase().includes(q)) return true;
  return (note.aliases || []).some((a) => a.toLowerCase().includes(q));
}
