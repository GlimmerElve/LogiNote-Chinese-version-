import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { H5pArchive, H5P_LIMITS } from './h5pPackage';
import { atomicWriteTextFile } from './atomicWrite';
import type { H5pLocalPackage } from '../types/h5p';

export interface H5pProgress {
  version: 1;
  updatedAt: string;
  state?: unknown;
  reportedScore?: { raw: number; max: number };
  reportedCompleted?: boolean;
}
export function readH5pProgress(raw: unknown): H5pProgress {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('H5P 进度格式无效');
  const value = raw as H5pProgress;
  if (Buffer.byteLength(JSON.stringify(value)) > 1_000_000) throw new Error('H5P 进度超过 1 MB 限制');
  const result: H5pProgress = { version: 1, updatedAt: typeof value.updatedAt === 'string' && Number.isFinite(Date.parse(value.updatedAt))
    ? value.updatedAt : new Date().toISOString() };
  if (value.state !== undefined) result.state = value.state;
  if (value.reportedCompleted === true) result.reportedCompleted = true;
  if (value.reportedScore && Number.isFinite(value.reportedScore.raw) && Number.isFinite(value.reportedScore.max)
    && value.reportedScore.max > 0 && value.reportedScore.raw >= 0 && value.reportedScore.raw <= value.reportedScore.max) {
    result.reportedScore = { raw: value.reportedScore.raw, max: value.reportedScore.max };
  }
  return result;
}
export async function h5pSafeDirectory(root: string, create = false) {
  if (create) await fs.mkdir(root, { recursive: true });
  const info = await fs.lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('H5P 存储目录不允许使用链接');
}
async function safeFile(file: string, max: number) {
  const info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1 || info.size > max) throw new Error('H5P 文件类型或大小不安全');
}
export function createH5pStore(dataRoot: string) {
  const root = path.join(dataRoot, 'h5p'), packages = path.join(root, 'packages');
  const states = path.join(dataRoot, 'user-state', 'h5p');
  const pending = new Map<string, Promise<unknown>>();
  let writes = 0;
  const idCheck = (id: unknown): string => {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/u.test(id)) throw new Error('H5P 包编号无效');
    return id;
  };
  const enqueue = <T>(id: string, action: () => Promise<T>): Promise<T> => {
    writes++;
    const operation = (pending.get(id) || Promise.resolve()).catch(() => {}).then(action);
    pending.set(id, operation);
    return operation.finally(() => { writes--; });
  };
  const flush = async (id?: string): Promise<void> => {
    if (id !== undefined) idCheck(id);
    for (;;) {
      const snapshot = id === undefined ? [...pending.entries()] : [[id, pending.get(id)] as const];
      await Promise.all(snapshot.map(([, operation]) => operation));
      if (snapshot.every(([key, operation]) => pending.get(key) === operation)
        && (id !== undefined || pending.size === snapshot.length)) return;
    }
  };
  const ensure = async () => { await h5pSafeDirectory(dataRoot); await h5pSafeDirectory(root, true); await h5pSafeDirectory(packages, true); };
  const stateDirectory = async () => { await h5pSafeDirectory(dataRoot); await h5pSafeDirectory(path.join(dataRoot, 'user-state'), true); await h5pSafeDirectory(states, true); };
  const unlinkTemporary = async (file: string) => {
    for (let attempt = 0; ; attempt++) {
      try { await fs.unlink(file); return; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        if (attempt >= 2) throw new Error('H5P 场景已保存，但临时文件清理失败；请稍后刷新或重新导入重试');
        await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
      }
    }
  };
  const recoverPublication = async (id: string) => {
    const file = path.join(packages, `${id}.h5p`);
    let info;
    try { info = await fs.lstat(file, { bigint: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (!info.isFile() || info.isSymbolicLink() || info.nlink <= 1n) return;
    // Recover only our own interrupted publication links. An unexplained external
    // hard link remains rejected by safeFile; never relax that storage boundary.
    const names = await fs.readdir(packages), owned: string[] = [];
    const pattern = new RegExp(`^${id}\\.[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\\.tmp$`, 'u');
    for (const name of names.filter(name => pattern.test(name))) {
      const candidate = path.join(packages, name), other = await fs.lstat(candidate, { bigint: true });
      if (info.ino !== 0n && other.isFile() && !other.isSymbolicLink() && other.ino === info.ino && other.dev === info.dev) owned.push(candidate);
    }
    if (info.nlink !== BigInt(owned.length + 1)) throw new Error('H5P 文件含未知硬链接，未自动处理');
    for (const candidate of owned) await unlinkTemporary(candidate);
  };
  const progress = async (id: string): Promise<H5pProgress | null> => {
    idCheck(id); await stateDirectory();
    const file = path.join(states, `${id}.json`);
    try { await safeFile(file, 1_000_000); return readH5pProgress(JSON.parse(await fs.readFile(file, 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  };
  const load = async (id: string) => {
    idCheck(id); await ensure();
    const file = path.join(packages, `${id}.h5p`); await recoverPublication(id); await safeFile(file, H5P_LIMITS.archive);
    const bytes = await fs.readFile(file), archive = new H5pArchive(bytes);
    if (archive.id !== id) throw new Error('H5P 包内容与安装时的哈希不一致，请重新导入');
    return { archive, ...(await archive.inspect()) };
  };
  return {
    load, progress, busy: () => writes > 0,
    async importBytes(bytes: Buffer, current: () => boolean = () => true) {
      const archive = new H5pArchive(bytes), inspection = await archive.inspect();
      // Full inspection before committing; package data never grant execution authority.
      await ensure(); if (!current()) throw new Error('应用或存储状态已变化，未导入');
      const target = path.join(packages, `${archive.id}.h5p`);
      try { await recoverPublication(archive.id); await safeFile(target, H5P_LIMITS.archive); await load(archive.id); return inspection.descriptor; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const temporary = path.join(packages, `${archive.id}.${randomUUID()}.tmp`);
      writes++;
      let published = false;
      try {
        const handle = await fs.open(temporary, 'wx');
        try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
        if (!current()) throw new Error('应用或存储状态已变化，未导入');
        // Content-addressed, exclusive publication; a parallel import never replaces a file.
        try { await fs.link(temporary, target); published = true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; await load(archive.id); }
      } finally {
        try { if (published) await unlinkTemporary(temporary); else await fs.unlink(temporary).catch(() => {}); }
        finally { writes--; }
      }
      return inspection.descriptor;
    },
    async list() {
      await ensure();
      const result: { packages: H5pLocalPackage[]; errors: string[] } = { packages: [], errors: [] };
      const entries = await fs.readdir(packages);
      if (entries.length > 1000) throw new Error('本地 H5P 包过多，请先整理备份目录');
      for (const file of entries.filter(name => /^[a-f0-9]{64}\.h5p$/u.test(name))) {
        try {
          const loaded = await load(file.slice(0, -4));
          const descriptor: H5pLocalPackage = loaded.descriptor;
          const info = await fs.stat(path.join(packages, file));
          descriptor.importedAt = info.birthtime.toISOString();
          let state: H5pProgress | null = null;
          try { state = await progress(descriptor.id); }
          catch { descriptor.progressError = '进度读取失败，原记录保留。可备份后重新开始。'; }
          if (state) {
            descriptor.lastPlayedAt = state.updatedAt;
            descriptor.resumeAvailable = state.state !== undefined;
            descriptor.reportedCompleted = state.reportedCompleted;
            descriptor.reportedScore = state.reportedScore;
          }
          result.packages.push(descriptor);
        } catch { result.errors.push(`包 ${file.slice(0, 12)} 无法读取，请检查包或进度备份；未覆盖已有数据`); }
      }
      return result;
    },
    saveProgress(id: string, input: unknown): Promise<void> {
      idCheck(id); const snapshot = { ...structuredClone(readH5pProgress(input)), updatedAt: new Date().toISOString() };
      return enqueue(id, async () => {
        await stateDirectory();
        const file = path.join(states, `${id}.json`);
        try { await safeFile(file, 1_000_000); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        await atomicWriteTextFile(file, JSON.stringify(snapshot), { allowCopyFallback: false });
      });
    },
    restartProgress(id: string, current: () => boolean = () => true): Promise<{ backup?: string }> {
      idCheck(id);
      return enqueue(id, async () => {
        await stateDirectory();
        const file = path.join(states, `${id}.json`);
        try { await safeFile(file, 4_000_000); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
        const backups = path.join(states, 'backups'); await h5pSafeDirectory(backups, true);
        const name = `${id}.${randomUUID()}.json`, backup = path.join(backups, name);
        // UUID destination plus no existing target: a reset never overwrites an
        // earlier backup. The original bytes are moved, including malformed JSON.
        try { await fs.lstat(backup); throw new Error('H5P 备份目标已存在，请重试'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (!current()) throw new Error('应用或存储状态已变化，未重置进度');
        await fs.rename(file, backup);
        return { backup: name };
      });
    },
    flush,
    // Only used after the native close dialog explicitly discards unsaved progress.
    // This does not cancel an in-flight disk write; it still owns its serialization lane.
    acknowledgeSaveFailure: (id: string) => { idCheck(id); const operation = pending.get(id); if (operation) pending.set(id, operation.catch(() => {})); },
  };
}
