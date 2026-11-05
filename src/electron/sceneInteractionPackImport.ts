import fs from 'node:fs/promises';
import path from 'node:path';
import { inspectScenePackImport as inspectScenePackArchive } from '../../apps/community-api/src/scenePackageImport';
import { scenePackStyles } from '../services/scene/sceneInteractionPackStyles';
export { SCENE_PACK_IMPORT_LIMIT } from '../../apps/community-api/src/scenePackageImport';

/** Desktop import and the release CLI use the same CSS contract as loading.
 * No package code is activated and no style is injected during preflight. */
export async function inspectScenePackImport(bytes: Buffer) {
  const result = await inspectScenePackArchive(bytes);
  const css = new TextDecoder('utf-8', { fatal: true }).decode(result.files.get('styles.css')!);
  scenePackStyles({ id: result.manifest.id, version: result.manifest.version }, css);
  return result;
}

/** Immutable, side-by-side releases: never rename/delete an installed version. */
export function createScenePackImporter(root: string) {
  const directory = path.resolve(root); let queue: Promise<unknown> = Promise.resolve(), writes = 0;
  async function safeDirectory(target: string, create = false) {
    const parsed = path.parse(target); let current = parsed.root;
    for (const part of path.relative(parsed.root, target).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      if (create) await fs.mkdir(current).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const info = await fs.lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw Error('S2 安装目录不允许链接或非目录路径');
    }
  }
  async function sameInstalled(target: string, files: Map<string, Buffer>) {
    await safeDirectory(target);
    const found = new Map<string, Buffer>();
    let entries = 0;
    const walk = async (folder: string, depth = 0) => {
      if (depth > 16) return false;
      for (const name of await fs.readdir(folder)) {
        if (++entries > 512) return false;
        const file = path.join(folder, name), info = await fs.lstat(file);
        if (info.isSymbolicLink() || !info.isFile() && !info.isDirectory()) throw Error('已有交互包含不安全文件');
        if (info.isDirectory()) { if (!await walk(file, depth + 1)) return false; continue; }
        const relative = path.relative(target, file).split(path.sep).join('/'), expected = files.get(relative);
        if (!expected || info.size !== expected.length) return false;
        found.set(relative, await fs.readFile(file));
      }
      return true;
    };
    return await walk(target) && found.size === files.size && [...files].every(([name, bytes]) => found.get(name)?.equals(bytes));
  }
  return {
    busy: () => writes > 0,
    install(bytes: Buffer, current: () => boolean = () => true) {
      const snapshot = Buffer.from(bytes); writes++;
      const operation = queue.then(async () => {
        const { manifest, files } = await inspectScenePackImport(snapshot);
        if (!current()) throw Error('应用状态已变化，未安装交互包');
        await safeDirectory(directory, true);
        const parent = path.join(directory, manifest.id), target = path.join(parent, manifest.version);
        await safeDirectory(parent, true);
        try {
          await fs.lstat(target);
          if (!await sameInstalled(target, files)) throw Error('同版本交互包内容不同，未覆盖；请发布新版本号后导入。已有场景和进度不变');
          return { manifest, alreadyInstalled: true };
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        const stage = await fs.mkdtemp(path.join(directory, '.import-stage-'));
        try {
          for (const [name, content] of files) {
            const file = path.join(stage, ...name.split('/'));
            await fs.mkdir(path.dirname(file), { recursive: true });
            const handle = await fs.open(file, 'wx');
            try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
          }
          if (!current()) throw Error('应用状态已变化，未安装交互包');
          await safeDirectory(parent);
          // Reject a concurrently published version rather than replacing it.
          try { await fs.lstat(target); throw Error('相同版本已由其他操作安装，请刷新后重试'); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          await fs.rename(stage, target);
          return { manifest, alreadyInstalled: false };
        } finally {
          // Only this generated staging directory, directly inside our validated root.
          if (path.dirname(stage) !== directory || !path.basename(stage).startsWith('.import-stage-')) throw Error('临时安装目录无效');
          await safeDirectory(directory);
          await fs.rm(stage, { recursive: true, force: true });
        }
      });
      queue = operation.catch(() => {});
      return operation.finally(() => { writes--; });
    },
  };
}
