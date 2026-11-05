import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { zipSync } from 'fflate';
import { inspectScenePackImport, SCENE_PACK_IMPORT_LIMIT } from '../src/electron/sceneInteractionPackImport';
const source = process.argv[2] && path.resolve(process.argv[2]), output = process.argv[3] && path.resolve(process.argv[3]);
if (!source || !output) throw Error('用法：npm run package:scene-pack -- <构建后的包目录> <输出.zip>');
const files: Record<string, Uint8Array> = {}; let total = 0;
const changed = () => Error('PACK_BUILD_CHANGED: 打包期间构建产物已切换，未生成 ZIP；请等待构建完成后重试。');
const rootIdentity = await fs.lstat(source, { bigint: true });
if (!rootIdentity.isDirectory() || rootIdentity.isSymbolicLink()) throw Error('包目录不能是链接');
const anchorPath = path.join(source, 'main.js');
const anchorIdentity = await fs.lstat(anchorPath, { bigint: true });
if (!anchorIdentity.isFile() || anchorIdentity.isSymbolicLink()) throw Error('main.js 必须是普通文件');
// The publisher replaces the entire tree, including main.js. Keep its handle
// alive through the final identity check so a removed generation's file ID
// cannot be recycled during repeated cross-process rebuilds (including ABA).
// No persistent lock, package marker or installed-version mutation is needed.
const anchor = await fs.open(anchorPath, 'r');
const sameFile = (a: typeof anchorIdentity, b: typeof anchorIdentity) => a.dev === b.dev && a.ino === b.ino;
async function walk(directory: string, depth = 0) {
  if (depth > 16 || Object.keys(files).length > 256) throw Error('包层级或文件数超限');
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw Error('包目录不能是链接');
  for (const name of await fs.readdir(directory)) {
    const file = path.join(directory, name), info = await fs.lstat(file);
    if (info.isSymbolicLink()) throw Error('包不允许链接');
    if (info.isDirectory()) await walk(file, depth + 1);
    else {
      if (!info.isFile() || info.size > 2 * 1024 * 1024 || (total += info.size) > 32 * 1024 * 1024) throw Error('包文件超限');
      const bytes = await fs.readFile(file);
      if (bytes.byteLength !== info.size) throw changed();
      files[path.relative(source!, file).split(path.sep).join('/')] = bytes;
    }
  }
}
try {
  const pinned = await anchor.stat({ bigint: true });
  // Filesystems without stable file IDs cannot safely prove a snapshot.
  if (pinned.ino === 0n || !sameFile(anchorIdentity, pinned)) throw changed();
  await walk(source);
  const [currentRoot, currentAnchor, finalPinned] = await Promise.all([
    fs.lstat(source, { bigint: true }), fs.lstat(anchorPath, { bigint: true }), anchor.stat({ bigint: true }),
  ]);
  if (!currentRoot.isDirectory() || currentRoot.isSymbolicLink() || !sameFile(rootIdentity, currentRoot)
    || !currentAnchor.isFile() || currentAnchor.isSymbolicLink() || !sameFile(pinned, currentAnchor)
    || finalPinned.size !== pinned.size || finalPinned.mtimeNs !== pinned.mtimeNs) throw changed();
} catch (error) {
  if (['ENOENT', 'ENOTDIR', 'ESTALE'].includes((error as NodeJS.ErrnoException).code ?? '')) throw changed();
  throw error;
} finally { await anchor.close(); }
// Only the verified in-memory snapshot is used from here on. Later rebuilds
// cannot affect validation or ZIP bytes, and failures above never touch output.
const bytes = Buffer.from(zipSync(files));
if (bytes.length > SCENE_PACK_IMPORT_LIMIT) throw Error('ZIP 超过16MiB');
const { manifest } = await inspectScenePackImport(bytes);
// Keep partial writes out of the official ZIP path. link() publishes a complete
// same-filesystem file atomically and fails if ANY target already exists; a
// check-then-rename or copy fallback would break the no-overwrite guarantee.
const stagedZip = path.join(path.dirname(output), `.scene-pack-zip-${randomUUID()}.tmp`);
let writer: Awaited<ReturnType<typeof fs.open>> | undefined, staged = false, published = false;
try {
  writer = await fs.open(stagedZip, 'wx'); staged = true;
  await writer.writeFile(bytes);
  await writer.sync();
  await writer.close(); writer = undefined;
  try { await fs.link(stagedZip, output); published = true; }
  catch (error) {
    if (['EXDEV', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? ''))
      throw Error('PACK_ZIP_PUBLISH_UNSUPPORTED: 输出文件系统不支持无覆盖原子发布，请选择支持硬链接的本地目录。', { cause: error });
    throw error;
  }
} finally {
  // Only this invocation's exclusively created random staging name is ours.
  // Never remove output: another process may have won publication there.
  if (writer) try { await writer.close(); }
  catch (error) { console.warn(`ZIP 临时句柄关闭失败：${stagedZip}`, error); }
  if (staged) try { await fs.unlink(stagedZip); }
  catch (error) { console.warn(`ZIP 临时文件未能清理（${published ? '正式 ZIP 已完整发布' : '未发布正式 ZIP'}）：${stagedZip}`, error); }
}
console.log(`已生成 ${manifest.id}@${manifest.version}：${output}；未执行包代码，不覆盖已有 ZIP。`);
