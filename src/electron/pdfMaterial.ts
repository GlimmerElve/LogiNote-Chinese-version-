import { spawn } from 'node:child_process';
import path from 'node:path';
import { getPdfExtractScriptPath } from './pdf.ts';
import { isLocalRasterDataUrl } from '../services/textbook/localImages.ts';
import { MaterialError } from '../services/textbook/materialScope.ts';

export { PDF_PAGE_IMAGE_INDEX } from '../services/textbook/localImages.ts';
/** Independent from the text parser and resource browser; no OCR or model downloads. */
export function readPdfVisual(file: string, page?: number, region?: [number, number, number, number]): Promise<{ pageCount?: number; dataUrl?: string; alt?: string }> {
  const script = getPdfExtractScriptPath();
  if (!script) return Promise.reject(new MaterialError('UNSUPPORTED', 'PDF 原图读取脚本尚未配置'));
  if (page !== undefined && (!Number.isSafeInteger(page) || page < 1)) return Promise.reject(new MaterialError('INVALID_REQUEST', 'PDF 页码无效'));
  if (region && (!page || region.length !== 4 || !region.every(Number.isFinite) || region[2] <= region[0] || region[3] <= region[1])) {
    return Promise.reject(new MaterialError('INVALID_REQUEST', 'PDF 区域无效'));
  }
  return new Promise((resolve, reject) => {
    const child = spawn('python', [path.join(path.dirname(script), 'material_visual.py'), file, ...(page ? [String(page)] : []), ...(region ? region.map(String) : [])],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', done = false;
    const finish = (error?: Error, result?: { pageCount?: number; dataUrl?: string; alt?: string }) => {
      if (done) return; done = true; clearTimeout(timer);
      error ? reject(error) : resolve(result!);
    };
    const timer = setTimeout(() => { child.kill(); finish(new MaterialError('UNSUPPORTED', 'PDF 原图渲染超时，已跳过')); }, 15_000);
    child.stderr.on('data', () => { /* Do not leak paths or buffer unbounded parser diagnostics. */ });
    child.stdout.on('data', (data: Buffer) => {
      output += data.toString('utf8');
      if (output.length > 1_500_000) { child.kill(); finish(new MaterialError('INVALID_SOURCE', 'PDF 原图超过安全上限')); }
    });
    child.on('error', () => finish(new MaterialError('UNSUPPORTED', 'PDF 原图渲染不可用')));
    child.on('close', () => {
      if (done) return;
      try {
        const value = JSON.parse(output);
        if (!value.ok || (page === undefined ? !Number.isSafeInteger(value.pageCount) || value.pageCount < 1 || value.pageCount > 2000
          : typeof value.dataUrl !== 'string' || !isLocalRasterDataUrl(value.dataUrl))) throw new Error();
        finish(undefined, { pageCount: value.pageCount, dataUrl: value.dataUrl, alt: value.alt });
      } catch { finish(new MaterialError('UNSUPPORTED', 'PDF 原图暂不可读取，未执行本地识别')); }
    });
  });
}
