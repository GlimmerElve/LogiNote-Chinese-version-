/** Export work is isolated from scrolling, editing and autosave. */
import type { StyledExportAssets } from './exportAssetTypes';
export function renderStyledTextbookHtmlInWorker(title: string, body: string, assets?: StyledExportAssets): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./styledTextbookHtml.worker.ts', import.meta.url), { type: 'module' });
    const timeout = setTimeout(() => finish(new Error('HTML 导出超时，请稍后重试')), 60_000);
    const finish = (error?: Error, html?: string) => { clearTimeout(timeout); worker.terminate(); error ? reject(error) : resolve(html!); };
    worker.onmessage = (event: MessageEvent<{ html?: string; error?: string }>) => event.data.html ? finish(undefined, event.data.html) : finish(new Error(event.data.error || 'HTML 导出失败'));
    worker.onerror = () => finish(new Error('HTML 导出进程启动失败'));
    worker.postMessage({ title, body, assets });
  });
}
