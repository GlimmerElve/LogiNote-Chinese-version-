/**
 * 混合检索（Dense + Sparse + RRF）纯函数工具。
 *
 * 不依赖 @xenova 模型与 IO，仅做中文/英文词元化、BM25 打分与 RRF 融合，
 * 便于独立测试与复用。语义分数由调用方（ragIndex.searchDocuments）计算后
 * 与这里的稀疏分数一起交给 rrfFusion 融合。
 *
 * 背景：项目离线运行，不引入 nodejieba 等原生分词依赖（esbuild/Electron
 * 打包原生 .node 会带来额外成本），改用「字符 bigram + 英文/数字连续词」
 * 的零依赖词元化，对中文短标题召回足够有效。
 */

/** 是否为中日韩统一表意字符（CJK 基本区 + 扩展 A） */
function isCJK(ch: string): boolean {
  const c = ch.codePointAt(0)!;
  return (c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf);
}

/**
 * 词元化：中文 bigram（相邻两字）+ 英文/数字连续词。
 * 有意不加「单 CJK 字符」兜底，避免「的/了/是」等高频虚词噪声拉高所有块的稀疏分。
 */
export function tokenize(text: string): string[] {
  const s = String(text || '').toLowerCase();
  const tokens: string[] = [];

  // 英文/数字连续词（如 "AI"、"gpu"、"2024"）
  const words = s.match(/[a-z0-9]+/g) || [];
  for (const w of words) tokens.push(w);

  // 中文 bigram
  for (let i = 0; i < s.length - 1; i++) {
    if (isCJK(s[i]) && isCJK(s[i + 1])) {
      tokens.push(s[i] + s[i + 1]);
    }
  }

  return tokens;
}

/** 文档频率表：每个词元出现在多少个 chunk 中 */
export function buildDf(chunkTexts: string[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const text of chunkTexts) {
    const uniq = new Set(tokenize(text));
    for (const t of uniq) df.set(t, (df.get(t) || 0) + 1);
  }
  return df;
}

/**
 * BM25 打分（Lucene 风格，默认 k1=1.2, b=0.75）。
 * 分数非负、无上界，仅用于排序/融合，不直接与语义分数比较绝对值。
 */
export function bm25Score(
  queryTokens: string[],
  chunkText: string,
  df: Map<string, number>,
  totalDocs: number,
  avgLen: number,
): number {
  if (queryTokens.length === 0) return 0;

  const chunkTokens = tokenize(chunkText);
  const len = Math.max(chunkTokens.length, 1);
  const tf = new Map<string, number>();
  for (const t of chunkTokens) tf.set(t, (tf.get(t) || 0) + 1);

  const k1 = 1.2;
  const b = 0.75;
  let score = 0;
  for (const qt of queryTokens) {
    const f = tf.get(qt);
    if (!f) continue;
    const n = df.get(qt) || 0;
    const idf = Math.log(1 + (totalDocs - n + 0.5) / (n + 0.5));
    score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (len / avgLen))));
  }
  return score;
}

/**
 * 倒数排名融合（Reciprocal Rank Fusion）。
 * 输入两套各自降序排好的 chunkId 列表，返回每个 id 的融合分。
 * 融合分不归一化，仅用于相对排序。
 */
export function rrfFusion(
  denseRankedIds: string[],
  sparseRankedIds: string[],
  k = 60,
): Map<string, number> {
  const fused = new Map<string, number>();
  denseRankedIds.forEach((id, i) => {
    fused.set(id, (fused.get(id) || 0) + 1 / (i + 1 + k));
  });
  sparseRankedIds.forEach((id, i) => {
    fused.set(id, (fused.get(id) || 0) + 1 / (i + 1 + k));
  });
  return fused;
}

/**
 * 加权融合（Weighted Fusion）：把语义分与关键词分各自做 max 归一化后加权求和。
 *
 * 相比 RRF，加权融合能保留信号的「绝对强弱」（例如关键词断层领先时不会被稀释），
 * 更契合「知识点标题字面命中的内容优先」的补全场景。
 *
 * @param items 每个候选的 { id, dense(余弦 0~1), sparse(BM25 无上界) }
 * @param denseWeight 密集分权重，默认 0.35（关键词分占 0.65，略占优）
 */
export function weightedFusion(
  items: Array<{ id: string; dense: number; sparse: number }>,
  denseWeight = 0.35,
): Map<string, number> {
  if (items.length === 0) return new Map();

  let denseMax = 0;
  let sparseMax = 0;
  for (const it of items) {
    if (it.dense > denseMax) denseMax = it.dense;
    if (it.sparse > sparseMax) sparseMax = it.sparse;
  }
  // 避免除零
  denseMax = denseMax || 1e-9;
  sparseMax = sparseMax || 1e-9;

  const fused = new Map<string, number>();
  for (const it of items) {
    const dNorm = it.dense / denseMax;
    const sNorm = it.sparse / sparseMax;
    fused.set(it.id, denseWeight * dNorm + (1 - denseWeight) * sNorm);
  }
  return fused;
}
