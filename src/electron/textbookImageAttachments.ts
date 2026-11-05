import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getDocumentsDir } from './ragIndex.ts';
import { assertMaterialDocument, MaterialError } from '../services/textbook/materialScope.ts';
import { isLocalRasterDataUrl } from '../services/textbook/localImages.ts';
import type { MaterialImage, MaterialImageRequest } from '../services/textbook/materialTypes.ts';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const identity = (request: MaterialImageRequest) => JSON.stringify([request.docId, request.version, request.blockId, request.imageIndex]);
async function directory() {
  // Independent of original-document / index deletion. Include this directory in
  // a complete data-root backup; notes alone do not contain attachment bytes.
  const dir = path.join(path.dirname(await getDocumentsDir()), 'textbook-assets');
  await fs.mkdir(dir, { recursive: true });
  const info = await fs.lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new MaterialError('INVALID_SOURCE', '教材附件目录无效');
  return dir;
}
export async function readTextbookImageAttachment(request: MaterialImageRequest): Promise<MaterialImage> {
  assertMaterialDocument(request, request.docId);
  if (!/^[a-f0-9]{64}$/u.test(request.attachmentHash || '')) throw new MaterialError('INVALID_REQUEST', '教材附件哈希无效');
  const file = path.join(await directory(), `${hash(identity(request))}-${request.attachmentHash}.json`);
  try {
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1_500_000) throw new Error();
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    if (saved.identity !== identity(request) || !isLocalRasterDataUrl(saved.dataUrl)
      || hash(saved.dataUrl) !== request.attachmentHash || typeof saved.alt !== 'string' || saved.alt.length > 1000) throw new Error();
    return { dataUrl: saved.dataUrl, alt: saved.alt, attachmentHash: request.attachmentHash };
  } catch { throw new MaterialError('SOURCE_MISSING', '教材图片附件缺失或损坏，请恢复完整数据备份'); }
}
/** Caller must first read and revalidate the exact original material version. */
export async function saveTextbookImageAttachment(request: MaterialImageRequest, image: MaterialImage): Promise<MaterialImage> {
  assertMaterialDocument(request, request.docId);
  if (!isLocalRasterDataUrl(image.dataUrl)) throw new MaterialError('INVALID_SOURCE', '教材图片不符合本地图片限制');
  const attachmentHash = hash(image.dataUrl);
  const file = path.join(await directory(), `${hash(identity(request))}-${attachmentHash}.json`);
  const temporary = `${file}.${randomUUID()}.pending`;
  let handle;
  try {
    handle = await fs.open(temporary, 'wx');
    await handle.writeFile(JSON.stringify({ identity: identity(request), dataUrl: image.dataUrl, alt: image.alt.slice(0, 1000) }), 'utf8');
    await handle.sync();
    await handle.close(); handle = undefined;
    // Atomically publish a completely written immutable inode. Concurrent saves
    // cannot expose partial JSON or replace an existing attachment/symlink.
    await fs.link(temporary, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  } finally { await handle?.close(); await fs.unlink(temporary).catch(() => {}); }
  // Also validates an existing immutable attachment, never follows a symlink.
  return readTextbookImageAttachment({ ...request, attachmentHash });
}
