import { NoteItem } from '../types';

/**
 * 递归收集项目及其所有后代子项目下的 knowledge 笔记。
 * 项目树由 note.parentId 关联；返回的数组按 project → 后代 的深度优先顺序。
 */
export function collectProjectKnowledgeNotes(projectId: string, allNotes: NoteItem[]): NoteItem[] {
  const visited = new Set<string>();
  const result: NoteItem[] = [];

  const walk = (id: string) => {
    const note = allNotes.find((n) => n.id === id);
    if (!note || visited.has(id)) return;
    visited.add(id);

    if (note.noteType === 'knowledge') {
      result.push(note);
    }

    // 收集所有直接子节点（无论 project 还是 knowledge），沿树继续深入
    allNotes
      .filter((n) => n.parentId === id)
      .forEach((child) => walk(child.id));
  };

  walk(projectId);
  return result;
}

/**
 * 按 conceptMastery 排序，取掌握度最高的作「锚点」、最低的作「薄弱点」。
 * 掌握度未定义时按 50（中性）处理。
 */
export function selectAnchorsAndWeakPoints(
  knowledgeNotes: NoteItem[],
  anchorCount = 3,
  weakCount = 5,
): { anchors: NoteItem[]; weakPoints: NoteItem[] } {
  if (knowledgeNotes.length === 0) {
    return { anchors: [], weakPoints: [] };
  }

  const scored = knowledgeNotes.map((note) => ({
    note,
    mastery: note.dsrState?.conceptMastery ?? 50,
  }));

  // 降序：掌握度高的在前（锚点候选）
  const desc = [...scored].sort((a, b) => b.mastery - a.mastery);
  const anchors = desc.slice(0, Math.min(anchorCount, desc.length)).map((s) => s.note);

  // 升序：掌握度低的在前（薄弱点候选）
  const asc = [...scored].sort((a, b) => a.mastery - b.mastery);
  const weakPoints = asc.slice(0, Math.min(weakCount, asc.length)).map((s) => s.note);

  return { anchors, weakPoints };
}