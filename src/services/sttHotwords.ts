import type { NoteItem } from '../types';

/**
 * 收集语音识别热词：全部 knowledge 类型笔记的标题 + 别名。
 * 规则：
 *  - 仅取 knowledge 笔记（项目笔记不作为热词）
 *  - 收集 title 与 aliases，去除空白项
 *  - 去重（保留首次出现顺序）
 *  - 过滤长度 < 3 的字词（两字词容许 1 字偏差会产生大量误替换）
 *  - 按长度降序排列，保证更长的专有名词优先参与纠错匹配
 */
export function collectKnowledgeHotwords(allNotes: NoteItem[]): string[] {
  const words = new Map<string, string>();

  for (const note of allNotes) {
    if (note.noteType !== 'knowledge') continue;

    const candidates = [note.title, ...(note.aliases ?? [])];
    for (const raw of candidates) {
      const w = (raw ?? '').trim();
      if (w.length < 3) continue;
      words.set(w, w);
    }
  }

  return Array.from(words.keys()).sort((a, b) => b.length - a.length);
}
