import { NoteItem, KnowledgePointCandidate } from "../types";

/**
 * 纯代码识别「已知知识点（known）」：扫描复盘文本，命中任意笔记的标题或别名即判定为 known。
 * - 不修改正文、不修改任何喂给 LLM 的文本；
 * - 仿照「自动关联扫描」的标题+别名词表子串匹配，但只识别、不做替换；
 * - 返回的 name 用文本实际出现的 token（可能是别名），existingNoteTitle 用笔记原始标题。
 */

export function matchKnownKnowledgePoints(
  text: string,
  knowledgeNotes: NoteItem[],
): KnowledgePointCandidate[] {
  const source = text || "";
  const lowerSource = source.toLowerCase();

  interface Entry {
    token: string;
    noteId: string;
    noteTitle: string;
  }

  const entries: Entry[] = [];
  for (const n of knowledgeNotes) {
    const title = (n.title || "").trim();
    const aliases = (n.aliases || []).map((a) => a.trim()).filter(Boolean);

    if (title.length >= 2) entries.push({ token: title, noteId: n.id, noteTitle: title });
    for (const a of aliases) {
      if (a.length >= 2) entries.push({ token: a, noteId: n.id, noteTitle: title });
    }
  }

  // 长度降序，避免短别名误伤长标题的子串
  entries.sort((a, b) => b.token.length - a.token.length);

  const matched = new Map<string, KnowledgePointCandidate>(); // key: noteId，去重
  let seq = 0;

  for (const e of entries) {
    if (matched.has(e.noteId)) continue; // 同名/别名只保留一个候选
    if (!lowerSource.includes(e.token.toLowerCase())) continue;

    matched.set(e.noteId, {
      id: `known-${Date.now()}-${seq++}`,
      name: e.token,
      category: "known",
      existingNoteTitle: e.noteTitle,
    });
  }

  return Array.from(matched.values());
}