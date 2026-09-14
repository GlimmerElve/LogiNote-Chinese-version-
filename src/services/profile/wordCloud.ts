import {
  CAUSAL_CONNECTORS,
  EXAMPLE_MARKERS,
  ANALOGY_MARKERS,
  DEFINITION_MARKERS,
  CONCLUSION_MARKERS,
  VAGUE_TERMS,
  ABSOLUTIST_TERMS,
} from '../reasoningStyle/lexicons';

/**
 * 词云统计：复用推理用语词库，统计一段口语文本中各「惯用词」的出现次数。
 * 只统计长度 ≥ 2 的词条，避免单字误匹配；返回按次数降序的 Top N。
 */

/** 词库分组（用于展示或后续扩展分类标签） */
const WORD_BANK_GROUPS: Array<{ label: string; words: readonly string[] }> = [
  { label: '因果推导', words: CAUSAL_CONNECTORS },
  { label: '举例', words: EXAMPLE_MARKERS },
  { label: '类比', words: ANALOGY_MARKERS },
  { label: '定义', words: DEFINITION_MARKERS },
  { label: '结论标记', words: CONCLUSION_MARKERS },
  { label: '模糊词', words: VAGUE_TERMS },
  { label: '绝对化', words: ABSOLUTIST_TERMS },
];

/** 统计单个词条出现次数（仅长度 ≥ 2，避免单字误匹配） */
function countOccurrences(text: string, word: string): number {
  if (word.length < 2) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = text.indexOf(word, idx)) !== -1) {
    count += 1;
    idx += word.length;
  }
  return count;
}

/** 计算词云：返回按 count 降序的 Top N 词条 */
export function computeWordCloud(
  text: string,
  topN: number = 20,
): Array<{ word: string; count: number }> {
  if (!text || !text.trim()) return [];
  const map = new Map<string, number>();
  for (const group of WORD_BANK_GROUPS) {
    for (const w of group.words) {
      const c = countOccurrences(text, w);
      if (c > 0) map.set(w, (map.get(w) || 0) + c);
    }
  }
  return Array.from(map.entries())
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, topN);
}