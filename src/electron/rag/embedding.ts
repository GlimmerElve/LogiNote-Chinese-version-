import {getBackgroundRagCompute} from './backgroundComputeBridge.ts';
import { installNativeInferenceThreadLimit, runEmbeddingBatches } from './backgroundEmbeddingPolicy';
let modelsDir = '';
let pipelinePromise: Promise<any> | null = null;

/** 注入离线模型根目录。切换目录时清空已缓存的 pipeline。 */
export function setModelsDir(dir: string): void {
  if (modelsDir === dir) return;
  modelsDir = dir;
  pipelinePromise = null;
}

function getPipeline(): Promise<any> {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const native = await import('onnxruntime-node');
      const { InferenceSession } = native.default ?? native;
      installNativeInferenceThreadLimit(InferenceSession);
      const { pipeline, env } = await import('@xenova/transformers');
      env.localModelPath = modelsDir;
      env.allowRemoteModels = false;
      return pipeline('feature-extraction', 'Xenova/paraphrase-multilingual-MiniLM-L12-v2');
    })();
  }
  return pipelinePromise;
}

/** 生成 384 维归一化向量。 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const background=getBackgroundRagCompute();if(background)return (await background.embed([text]))[0];
  return (await generateEmbeddings([text]))[0];
}

/** Batch local inference for the views of one semantic chunk. */
export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  if (!texts.length) return [];
  const background=getBackgroundRagCompute();if(background)return background.embed(texts);
  const pipe = await getPipeline();
  return runEmbeddingBatches(texts, async batch => {
    const result = await pipe(batch.length === 1 ? batch[0] : batch, { pooling: 'mean', normalize: true });
    const data = Array.from(result.data as Float32Array);
    const width = data.length / batch.length;
    if (!Number.isInteger(width) || width < 1) throw new Error('本地向量批处理返回维度异常');
    return batch.map((_, index) => data.slice(index * width, (index + 1) * width));
  });
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
