import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const namespaces = ['progressive-learning', 'progressive-derived', 'learning-preparation'] as const;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
interface MigrationFile { relative: string; hash: string; bytes: number }
export interface LearningStateMigration { source: string; target: string; files: MigrationFile[] }
async function realDirectory(directory: string) {
  const stat = await fs.lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('学习记录迁移路径不能是链接或普通文件');
}
async function absent(file: string) { try { return await fs.lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; } }
/** Inspect before the legacy best-effort copy can touch the target. Private
 * learning files are mandatory data, never disposable Chromium cache files. */
export async function prepareLearningStateMigration(source: string, target: string): Promise<LearningStateMigration> {
  source = path.resolve(source); target = path.resolve(target);
  if (source === target || target.startsWith(source + path.sep) || source.startsWith(target + path.sep)) throw Error('学习记录迁移目录不能重叠');
  await realDirectory(source);
  const targetStat = await absent(target); if (targetStat) await realDirectory(target);
  const result: LearningStateMigration = { source, target, files: [] };
  const walk = async (relative: string) => {
    const location = path.join(source, relative), stat = await absent(location); if (!stat) return;
    if (stat.isSymbolicLink()) throw Error('学习记录中存在链接，未迁移或覆盖原记录');
    const destination = path.join(target, relative), existing = await absent(destination);
    if (existing?.isSymbolicLink()) throw Error('目标学习记录包含链接，未覆盖');
    if (stat.isDirectory()) {
      if (existing && !existing.isDirectory()) throw Error('目标学习记录路径冲突');
      for (const name of await fs.readdir(location)) await walk(path.join(relative, name));
    } else {
      if (!stat.isFile() || stat.size > 24000000 || result.files.length >= 20000) throw Error('学习记录文件异常，未跳过迁移');
      const bytes = await fs.readFile(location), digest = hash(bytes);
      if (existing && (!existing.isFile() || existing.size !== bytes.length || hash(await fs.readFile(destination)) !== digest)) throw Error('目标已有不同的学习记录，请选择空目录，避免覆盖');
      result.files.push({ relative, bytes: bytes.length, hash: digest });
    }
    await new Promise<void>(resolve => setImmediate(resolve));
  };
  for (const namespace of namespaces) await walk(namespace);
  return result;
}
export async function copyLearningStateMigration(migration: LearningStateMigration) {
  await fs.mkdir(migration.target, { recursive: true }); await realDirectory(migration.target);
  for (const file of migration.files) {
    const components = file.relative.split(path.sep);
    if (!namespaces.includes(components[0] as typeof namespaces[number]) || components.some(part => !part || part === '.' || part === '..')) throw Error('学习记录迁移范围无效');
    const source = path.join(migration.source, file.relative), target = path.join(migration.target, file.relative);
    let parent = migration.target;
    for (const part of components.slice(0, -1)) { parent = path.join(parent, part); await fs.mkdir(parent, { recursive: true }); await realDirectory(parent); }
    const stat = await fs.lstat(source); if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.bytes) throw Error('迁移期间学习记录发生变化，未切换存储目录');
    const original = await fs.readFile(source); if (hash(original) !== file.hash) throw Error('迁移期间学习记录发生变化，未切换存储目录');
    const currentTarget = await absent(target); if (currentTarget?.isSymbolicLink() || currentTarget && !currentTarget.isFile()) throw Error('迁移目标被替换，未切换存储目录');
    await fs.copyFile(source, target);
    if (hash(await fs.readFile(target)) !== file.hash) throw Error('学习记录复制校验失败，未切换存储目录');
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}
