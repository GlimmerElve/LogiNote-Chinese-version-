export interface ExportBlock { language: string; code: string; start: number; end: number; topLevel: boolean; error?: string }
/** A single disposable worker handles document parsing and raster validation off the reading thread. */
export function createTextbookExportAssetWorker() {
  const worker = new Worker(new URL('./exportAssets.worker.ts', import.meta.url), { type: 'module' });
  let busy = false;
  const request = <T>(payload: object): Promise<T> => new Promise((resolve, reject) => {
    if (busy) { reject(Error('素材导出任务正在执行')); return; }
    busy = true;
    const timer = setTimeout(() => finish(new Error('素材处理超时')), 30_000);
    const finish = (error?: Error, value?: T) => { clearTimeout(timer); busy = false; worker.onmessage = null; worker.onerror = null; error ? reject(error) : resolve(value!); };
    worker.onmessage = event => event.data?.error ? finish(new Error(event.data.error)) : finish(undefined, event.data);
    worker.onerror = () => finish(new Error('素材处理进程异常'));
    worker.postMessage(payload);
  });
  return {
    plan: async (body: string, sourceIds?: string[]) => (await request<{ items: ExportBlock[] }>({ op: 'plan', body, sourceIds })).items,
    image: (dataUrl: string) => request<{ extension: string; bytes: Uint8Array }>({ op: 'image', dataUrl }),
    svg: (svg: string) => request<{ dataUrl: string }>({ op: 'svg', svg }),
    close: () => worker.terminate(),
  };
}
