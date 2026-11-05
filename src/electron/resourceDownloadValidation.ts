import fs from 'node:fs/promises';

/** Lightweight download sanity check, not PDF correctness/OCR or a new parser.
 * Local uploads are unchanged. This runs only before downloaded bytes are
 * admitted to the library, since the real GET can differ from the HEAD probe. */
export function assertResourceDownloadPrefix(prefix: Uint8Array, extension: string): void {
  const ext = extension.replace(/^\./u, '').toLocaleLowerCase();
  const text = Buffer.from(prefix).toString('utf8').replace(/^\uFEFF/u, '').replace(/^[\s\u0000]+/u, '');
  if (ext === 'pdf' && !/^%PDF-\d\.\d(?:\s|$)/u.test(text)) {
    throw new Error('下载内容不是有效的 PDF 文件头，可能是登录、验证或错误页面；未加入资料库');
  }
  if (!['txt', 'md', 'markdown', 'svg'].includes(ext)
    && /^(?:(?:<!--[\s\S]*?-->\s*)*)(?:<!doctype\s+html\b|<html(?:\s|>)|<head(?:\s|>)|<body(?:\s|>))/iu.test(text)) {
    throw new Error('下载返回了 HTML 网页而非所选附件，未加入资料库');
  }
}

export async function assertResourceDownloadFile(filePath: string, extension: string): Promise<void> {
  const file = await fs.open(filePath, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || !info.size) throw new Error('下载文件为空或无效，未加入资料库');
    if (info.size > 100 * 1024 * 1024) throw new Error('下载文件超过 100 MB，未加入资料库');
    const prefix = Buffer.alloc(Math.min(info.size, 4096));
    const { bytesRead } = await file.read(prefix, 0, prefix.length, 0);
    assertResourceDownloadPrefix(prefix.subarray(0, bytesRead), extension);
  } finally { await file.close(); }
}
