/** Two desktop compute processes can run concurrently. Each inference session
 * gets one native CPU thread, and only four texts enter one tensor batch. The
 * processes also run below normal priority so input/paint retain CPU time. */
export const BACKGROUND_EMBEDDING_BATCH_SIZE = 4;
export const BACKGROUND_INFERENCE_THREADS = 1;

type SessionFactory = { create: (...args: any[]) => Promise<any> };
const installedFactories = new WeakSet<SessionFactory>();

/** Transformers 2.x does not forward SessionOptions from pipeline(). Configure
 * its shared onnxruntime-node factory BEFORE importing Transformers, only in
 * this compute runtime. No dependency files or browser WASM settings are changed.
 * Keep every existing provider/model option, and support both ONNX overloads. */
export function installNativeInferenceThreadLimit(factory: SessionFactory): void {
  if (installedFactories.has(factory)) return;
  const original = factory.create;
  factory.create = function (...args: any[]) {
    const optionsAt = typeof args[1] === 'number' ? (typeof args[2] === 'number' ? 3 : 2) : 1;
    const previous = args[optionsAt] || {};
    args[optionsAt] = { ...previous,
      intraOpNumThreads: BACKGROUND_INFERENCE_THREADS, interOpNumThreads: 1, executionMode: 'sequential',
    };
    return original.apply(this, args);
  };
  installedFactories.add(factory);
}

/** Preserve order and release each tensor batch before allocating the next.
 * A large textbook must never become one unbounded ONNX batch. */
export async function runEmbeddingBatches<T>(texts: readonly string[], infer: (batch: string[]) => Promise<T[]>,
  yieldTask: () => Promise<void> = () => new Promise(resolve => setImmediate(resolve))): Promise<T[]> {
  const result: T[] = [];
  for (let offset = 0; offset < texts.length; offset += BACKGROUND_EMBEDDING_BATCH_SIZE) {
    const batch = texts.slice(offset, offset + BACKGROUND_EMBEDDING_BATCH_SIZE);
    const values = await infer(batch);
    if (values.length !== batch.length) throw new Error('本地向量批处理返回条数异常');
    result.push(...values);
    if (offset + batch.length < texts.length) await yieldTask();
  }
  return result;
}
