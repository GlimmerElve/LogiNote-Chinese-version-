import { isLocalRasterDataUrl, MAX_TEXTBOOK_IMAGE_BYTES } from './localImages.ts';
import { createPreviewCache, createPreviewWorkQueue } from './previewCache.ts';
export { rasterContentBounds, rasterContentBoundsAsync } from './rasterBounds';

/** All decode/pixel readback/crop/encoding work belongs to a worker. When that
 * capability is unavailable, show the original instead of blocking the reader. */
async function renderPdfImagePreview(source: string): Promise<string> {
  if (typeof Worker === 'undefined') return source;
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./imagePreviewWorker.ts', import.meta.url), { type: 'module' });
    const finish = () => { clearTimeout(timer); worker.terminate(); };
    const timer = setTimeout(() => { finish(); reject(Error('Preview expired')); }, 10_000);
    worker.onerror = () => { finish(); reject(Error('Preview worker unavailable')); };
    worker.onmessage = (event: MessageEvent<{ preview?: string; error?: string }>) => {
      finish();
      if (typeof event.data.preview === 'string' && isLocalRasterDataUrl(event.data.preview)) resolve(event.data.preview);
      else reject(Error(event.data.error || 'Invalid preview output'));
    };
    try { worker.postMessage(source); } catch (error) { finish(); reject(error); }
  });
}
const cachedPdfPreview = createPreviewCache(renderPdfImagePreview);
export const queueTextbookImageRead = createPreviewWorkQueue(2);
export function compactPdfImagePreview(dataUrl: string): Promise<string> {
  if (dataUrl.length > Math.ceil(MAX_TEXTBOOK_IMAGE_BYTES / 3) * 4 + 32 || !/^data:image\/(png|jpeg);base64,/u.test(dataUrl)) return Promise.resolve(dataUrl);
  return cachedPdfPreview(dataUrl);
}
