import type { NoteItem } from "../types";

/**
 * 按标题或别名解析笔记（标题优先，别名次之，大小写不敏感）。
 * 用于「点击/跳转/匹配/回写/去重」等所有需要从文本反查笔记对象的场景，
 * 保证原名与别名指向同一个 NoteItem 对象。
 */
export function resolveNoteByTitleOrAlias(
  target: string,
  notes: NoteItem[],
): NoteItem | undefined {
  const t = (target || "").trim().toLowerCase();
  if (!t) return undefined;
  return (
    notes.find((n) => n.title.trim().toLowerCase() === t) ??
    notes.find((n) =>
      (n.aliases || []).some((a) => a.trim().toLowerCase() === t),
    )
  );
}

/**
 * 解析 wiki 链接文本的「真正目标标题」。
 * `[[原名|别名]]` → 返回 `原名`；无 pipe 时原样返回。
 */
export function parseWikiLinkTarget(raw: string): string {
  const s = (raw || "").trim();
  const idx = s.indexOf("|");
  return (idx >= 0 ? s.slice(0, idx) : s).trim();
}

/**
 * 归一化链接目标：命中某笔记的标题或别名时返回其「标题」（原名），
 * 否则原样返回。用于反向链接/知识图谱计算，让 `[[别名]]` 也能指向原名笔记。
 */
export function normalizeLinkTarget(target: string, notes: NoteItem[]): string {
  const resolved = resolveNoteByTitleOrAlias(target, notes);
  return resolved ? resolved.title : target;
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