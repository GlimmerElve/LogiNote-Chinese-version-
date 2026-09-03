/**
 * 浏览器端本地向量嵌入服务
 * 使用 @xenova/transformers 调用 all-MiniLM-L6-v2 模型
 */

let pipelinePromise: Promise<any> | null = null;
let modelLoaded = false;

async function getPipeline() {
  if (!pipelinePromise) {
    const { pipeline } = await import('@xenova/transformers');
    pipelinePromise = pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }
  return pipelinePromise;
}

/** 生成文本的 384 维向量嵌入 */
export async function generateEmbedding(text: string): Promise<number[]> {
  try {
    const pipe = await getPipeline();
    const result = await pipe(text, { pooling: 'mean', normalize: true });
    return Array.from(result.data as Float32Array);
  } catch (err: any) {
    console.warn('本地嵌入模型加载失败，回退到关键词匹配:', err.message);
    return [];
  }
}

/** 余弦相似度，返回值 0~1 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}