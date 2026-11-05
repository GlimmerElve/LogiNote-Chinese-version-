import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import type { SceneInteractionPackRef } from '../types/sceneInteractionPack';
import { readSceneInteractionPackManifest, readSceneInteractionPackRef } from '../services/scene/sceneInteractionPackManifest';
import { verifyScenePackMaterialBytes } from '../services/scene/sceneInteractionPackMaterialProtocol';

export const SCENE_PACK_SEED_RECEIPT = '.seed-receipt.json';
export const SCENE_PACK_SEED_EXCLUSIONS = '.seed-exclusions.json';
type SeedFile = { path: string; bytes: number; sha256: string };
type Receipt = { version: 1; packages: Record<string, { files: SeedFile[] }> };
const emptyReceipt = (): Receipt => ({ version: 1, packages: Object.create(null) });
const identity = (ref: SceneInteractionPackRef) => `${ref.id}@${ref.version}`;
const exists = (file: string) => fs.lstat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
const sameFiles = (a: SeedFile[], b: SeedFile[]) => JSON.stringify(a) === JSON.stringify(b);
const inside = (root: string, target: string) => {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};

/** Reject reparse points before creating, moving or recursively removing managed paths. */
async function noLinks(absolute: string) {
  const parsed = path.parse(absolute); let current = parsed.root;
  for (const part of path.relative(parsed.root, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let info;
    try { info = await fs.lstat(current); } catch (error: any) { if (error.code === 'ENOENT') return; throw error; }
    if (info.isSymbolicLink()) throw new Error('交互包更新拒绝符号链接或目录联接');
    if (current !== absolute && !info.isDirectory()) throw new Error('交互包目录的上级路径不是目录');
  }
}
async function directoryIsSafe(directory: string) {
  await noLinks(directory);
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || path.relative(directory, await fs.realpath(directory)) !== '') throw new Error('交互包目录必须是指定位置的真实目录');
}
async function fingerprint(directory: string): Promise<SeedFile[]> {
  await directoryIsSafe(directory); const files: SeedFile[] = []; let entries = 0;
  async function visit(folder: string, depth: number) {
    if (depth > 64) throw new Error('交互包目录层级过深');
    for (const name of (await fs.readdir(folder)).sort()) {
      if (++entries > 16384) throw new Error('交互包文件数过多');
      const file = path.resolve(folder, name);
      if (!inside(directory, file)) throw new Error('交互包文件超出精确版本目录');
      const before = await fs.lstat(file);
      if (before.isSymbolicLink()) throw new Error('交互包更新拒绝符号链接或目录联接');
      if (before.isDirectory()) { await visit(file, depth + 1); continue; }
      if (!before.isFile()) throw new Error('交互包只能包含普通文件和目录');
      if (!inside(directory, await fs.realpath(file))) throw new Error('交互包文件超出精确版本目录');
      const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const start = await handle.stat();
        if (!start.isFile() || start.ino !== before.ino || start.dev !== before.dev) throw new Error('交互包文件在核对期间已变化');
        const hash = createHash('sha256'), buffer = Buffer.alloc(65536); let bytes = 0;
        while (true) { const read = await handle.read(buffer, 0, buffer.length, null); if (!read.bytesRead) break; bytes += read.bytesRead; hash.update(buffer.subarray(0, read.bytesRead)); }
        const end = await handle.stat();
        if (bytes !== start.size || end.size !== start.size || end.mtimeMs !== start.mtimeMs || end.ctimeMs !== start.ctimeMs) throw new Error('交互包文件在核对期间已变化');
        files.push({ path: path.relative(directory, file).split(path.sep).join('/'), bytes, sha256: hash.digest('hex') });
      } finally { await handle.close(); }
    }
  }
  await visit(directory, 0); return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

async function validatePackage(directory: string, ref: SceneInteractionPackRef) {
  const read = async (name: string, max: number) => {
    const file = path.resolve(directory, name);
    if (!inside(directory, file)) throw new Error('交互包文件超出精确版本目录');
    await noLinks(file); const info = await fs.lstat(file);
    if (!info.isFile() || info.size > max) throw new Error('交互包文件类型或大小无效');
    const bytes = await fs.readFile(file); if (bytes.length > max) throw new Error('交互包文件超限'); return bytes;
  };
  const manifest = readSceneInteractionPackManifest(JSON.parse((await read('manifest.json', 8192)).toString('utf8')));
  if (manifest.id !== ref.id || manifest.version !== ref.version) throw new Error('交互包清单与目录身份不一致');
  await read('main.js', 2 * 1024 * 1024); await read('styles.css', 65536);
  JSON.parse((await read('agent.json', 262144)).toString('utf8'));
  if (manifest.protocolVersion === 2) for (const material of manifest.materials)
    await verifyScenePackMaterialBytes(material, await read(material.path, 1048576));
}

/** Generic seed ownership and explicit disk replacement. No code evaluation, runtime swap or business-specific IDs. */
export function createScenePackSeedManager(root: string, seed?: string, options: { refreshSeed?: boolean } = {}) {
  const directory = path.resolve(root), source = seed && path.resolve(seed), errors: string[] = [];
  let initialized: Promise<boolean> | undefined, queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>) => { const pending = queue.then(work); queue = pending.catch(() => {}); return pending; };
  async function ensureRoot() { await noLinks(directory); await fs.mkdir(directory, { recursive: true }); await directoryIsSafe(directory); }
  function versionPath(base: string, ref: SceneInteractionPackRef) {
    const target = path.resolve(base, ref.id, ref.version);
    if (!inside(base, target) || target === base) throw new Error('交互包目标必须位于指定插件目录'); return target;
  }
  async function readReceipt(): Promise<Receipt> {
    const file = path.join(directory, SCENE_PACK_SEED_RECEIPT);
    if (!await exists(file)) return emptyReceipt();
    try {
      await noLinks(file); const info = await fs.lstat(file);
      if (!info.isFile() || info.size > 4 * 1024 * 1024) throw new Error('更新记录类型或大小无效');
      const raw = JSON.parse(await fs.readFile(file, 'utf8'));
      if (!raw || raw.version !== 1 || !raw.packages || typeof raw.packages !== 'object' || Array.isArray(raw.packages)
        || Object.keys(raw).some(key => !['version', 'packages'].includes(key))) throw new Error('更新记录格式无效');
      const receipt = emptyReceipt();
      for (const [name, value] of Object.entries(raw.packages) as Array<[string, any]>) {
        const split = name.lastIndexOf('@'), ref = readSceneInteractionPackRef({ id: name.slice(0, split), version: name.slice(split + 1) });
        if (identity(ref) !== name || !value || Object.keys(value).length !== 1 || !Array.isArray(value.files) || value.files.length > 16384) throw new Error('更新记录身份或文件列表无效');
        const seen = new Set<string>();
        const files = value.files.map((item: any) => {
          if (!item || Object.keys(item).sort().join(',') !== 'bytes,path,sha256' || typeof item.path !== 'string' || !item.path
            || item.path.includes('\\') || item.path.includes(':') || item.path.split('/').some((part: string) => !part || part === '.' || part === '..')
            || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)
            || seen.has(item.path)) throw new Error('更新记录含无效或重复文件');
          seen.add(item.path); return { path: item.path, bytes: item.bytes, sha256: item.sha256 };
        }).sort((a: SeedFile, b: SeedFile) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
        receipt.packages[name] = { files };
      }
      return receipt;
    } catch (error) {
      const message = `交互包受管记录不可用，未自动安装或覆盖：${error instanceof Error ? error.message : String(error)}`;
      throw new Error(message, { cause: error });
    }
  }
  /** Independent from seed ownership: an observed pre-existing version must
   * never be silently adopted, overwritten or recreated after user removal. */
  async function readExclusions(): Promise<Set<string>> {
    const file = path.join(directory, SCENE_PACK_SEED_EXCLUSIONS);
    if (!await exists(file)) return new Set();
    try {
      await noLinks(file); const info = await fs.lstat(file);
      if (!info.isFile() || info.size > 1048576) throw new Error('排除记录类型或大小无效');
      const raw = JSON.parse(await fs.readFile(file, 'utf8'));
      if (!raw || raw.version !== 1 || Object.keys(raw).sort().join(',') !== 'references,version'
        || !Array.isArray(raw.references) || raw.references.length > 4096) throw new Error('排除记录格式无效');
      const refs = raw.references.map((item: unknown) => identity(readSceneInteractionPackRef(item)));
      if (new Set(refs).size !== refs.length) throw new Error('排除记录含重复版本');
      return new Set(refs);
    } catch (error) {
      const message = `交互包排除记录不可用，未自动安装或覆盖：${error instanceof Error ? error.message : String(error)}`;
      throw new Error(message, { cause: error });
    }
  }
  async function writeExclusions(exclusions: Set<string>) {
    if (exclusions.size > 4096) throw new Error('交互包排除版本数量超限');
    const references = [...exclusions].sort().map(key => {
      const split = key.lastIndexOf('@');
      return readSceneInteractionPackRef({ id: key.slice(0, split), version: key.slice(split + 1) });
    });
    const bytes = JSON.stringify({ version: 1, references }) + '\n';
    if (Buffer.byteLength(bytes) > 1048576) throw new Error('交互包排除记录大小超限');
    await directoryIsSafe(directory);
    const file = path.join(directory, SCENE_PACK_SEED_EXCLUSIONS), temporary = path.join(directory, `.seed-exclusions-${randomUUID()}.tmp`);
    await noLinks(file);
    try {
      const handle = await fs.open(temporary, 'wx');
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await noLinks(file); await directoryIsSafe(directory); await fs.rename(temporary, file);
    } finally { if (await exists(temporary)) { await noLinks(temporary); await fs.unlink(temporary); } }
  }
  async function writeReceipt(receipt: Receipt) {
    await directoryIsSafe(directory);
    const file = path.join(directory, SCENE_PACK_SEED_RECEIPT), temporary = path.join(directory, `.seed-receipt-${randomUUID()}.tmp`);
    if (await exists(file)) await noLinks(file);
    try {
      await fs.writeFile(temporary, JSON.stringify({ version: 1, packages: Object.fromEntries(Object.entries(receipt.packages).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) }, null, 2) + '\n', { flag: 'wx' });
      await noLinks(file); await directoryIsSafe(directory); await fs.rename(temporary, file);
    } finally { if (await exists(temporary)) { await noLinks(temporary); await fs.unlink(temporary); } }
  }
  async function markInitialized() {
    const marker = path.join(directory, '.initialized'); await noLinks(marker);
    await fs.writeFile(marker, 'scene-interaction-packs-v1\n', { flag: 'wx' }).catch((error: any) => { if (error.code !== 'EEXIST') throw error; });
  }
  async function removeTemporary(target: string, kind: '.seed-stage-' | '.seed-backup-') {
    const absolute = path.resolve(target);
    if (path.dirname(absolute) !== directory || !path.basename(absolute).startsWith(kind)) throw new Error('临时交互包清理目标无效');
    await directoryIsSafe(directory); await fingerprint(absolute); // Checks every descendant before recursive deletion.
    await fs.rm(absolute, { recursive: true });
  }
  async function replace(ref: SceneInteractionPackRef, expected?: SeedFile[]) {
    if (!source) throw new Error('未指定交互包构建目录');
    await ensureRoot(); await directoryIsSafe(source);
    const from = versionPath(source, ref), target = versionPath(directory, ref);
    if (inside(from, target) || inside(target, from)) throw new Error('构建目录与安装目标不能重叠');
    await noLinks(from); await noLinks(target);
    const wasInstalled = await exists(target), before = wasInstalled ? await fingerprint(target) : undefined;
    if (expected && (!before || !sameFiles(before, expected))) throw new Error('交互包已有本地修改或已删除，未自动更新');
    const seedFiles = await fingerprint(from); await validatePackage(from, ref);
    const stage = await fs.mkdtemp(path.join(directory, '.seed-stage-'));
    const backup = path.join(directory, `.seed-backup-${randomUUID()}`); let movedOld = false, published = false, committed = false;
    try {
      for (const file of seedFiles) {
        const fromFile = path.resolve(from, ...file.path.split('/')), toFile = path.resolve(stage, ...file.path.split('/'));
        if (!inside(from, fromFile) || !inside(stage, toFile)) throw new Error('交互包复制目标超出范围');
        await noLinks(fromFile); await noLinks(path.dirname(toFile)); await fs.mkdir(path.dirname(toFile), { recursive: true });
        await fs.copyFile(fromFile, toFile, constants.COPYFILE_EXCL);
      }
      if (!sameFiles(await fingerprint(stage), seedFiles) || !sameFiles(await fingerprint(from), seedFiles)) throw new Error('构建目录在更新期间变化，原包已保留');
      await validatePackage(stage, ref); await directoryIsSafe(directory); await noLinks(target);
      const stillInstalled = await exists(target);
      if (stillInstalled !== wasInstalled || before && !sameFiles(await fingerprint(target), before)) throw new Error('安装目录在更新期间变化，原包已保留');
      await fs.mkdir(path.dirname(target), { recursive: true }); await directoryIsSafe(path.dirname(target));
      if (wasInstalled) {
        if (await exists(backup)) throw new Error('交互包备份目标已存在');
        await fs.rename(target, backup); movedOld = true;
        if (!sameFiles(await fingerprint(backup), before!)) throw new Error('安装目录在替换期间变化，原包已保留');
      }
      await fs.rename(stage, target); published = true;
      const receipt = await readReceipt(); receipt.packages[identity(ref)] = { files: seedFiles }; await writeReceipt(receipt);
      committed = true;
    } catch (error) {
      if (published && await exists(target)) {
        await noLinks(target); await fingerprint(target); await fs.rename(target, stage); published = false;
      }
      if (movedOld) { await directoryIsSafe(directory); await noLinks(path.dirname(target)); await fs.rename(backup, target); movedOld = false; }
      throw error;
    } finally {
      if (await exists(stage)) await removeTemporary(stage, '.seed-stage-');
      // A failed rollback must leave its recoverable old directory intact.
      if (committed && movedOld && await exists(backup)) await removeTemporary(backup, '.seed-backup-');
    }
    return { reference: ref, replaced: wasInstalled, files: seedFiles.length, restartRequired: true as const };
  }
  async function seedReferences(): Promise<SceneInteractionPackRef[]> {
    if (!source || !await exists(source)) return [];
    await directoryIsSafe(source); const result: SceneInteractionPackRef[] = [];
    for (const id of (await fs.readdir(source, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(id.name)) continue;
      const parent = path.join(source, id.name); await noLinks(parent); if (!id.isDirectory()) continue;
      for (const version of await fs.readdir(parent, { withFileTypes: true })) {
        if (!version.isDirectory() && !version.isSymbolicLink()) continue;
        await noLinks(path.join(parent, version.name));
        result.push(readSceneInteractionPackRef({ id: id.name, version: version.name }));
      }
    }
    return result;
  }
  return {
    errors,
    initialize() {
      if (!initialized) {
        let incomplete = false;
        const pending = serial(async () => {
          // Publish only current-attempt diagnostics; a recovered package must
          // not retain an old failure forever or accumulate duplicates on retry.
          errors.length = 0;
          const marker = path.join(directory, '.initialized'); await noLinks(marker);
          const marked = await exists(marker);
          if (!marked && (!source || !await exists(source))) return exists(directory);
          await ensureRoot();
          const receipt = await readReceipt(), exclusions = await readExclusions(), references = await seedReferences();
          if (!marked) {
            let changed = false;
            // Persist all existing exclusions BEFORE copying any missing seed.
            // If this write fails, do not proceed with partial initialization.
            for (const ref of references) if (!receipt.packages[identity(ref)] && !exclusions.has(identity(ref)) && await exists(versionPath(directory, ref))) {
              exclusions.add(identity(ref)); changed = true;
            }
            if (changed) await writeExclusions(exclusions);
          }
          for (const ref of references) {
            const target = versionPath(directory, ref), owned = receipt.packages[identity(ref)];
            // A receipt proves this exact version was already installed. Even
            // before the whole seed set finishes, its later absence is a user
            // removal, not a failed first copy that we may silently resurrect.
            if (!marked) {
              if (owned || exclusions.has(identity(ref))) continue;
              // A manual import may arrive after the initial scan. Persist its
              // non-ownership before allowing another seed copy or retry.
              if (await exists(target)) { exclusions.add(identity(ref)); await writeExclusions(exclusions); continue; }
            }
            else if (!options.refreshSeed || !owned || !await exists(target)) continue;
            try {
              if (marked) {
                await noLinks(target); const installed = await fingerprint(target);
                if (!sameFiles(installed, owned.files)) continue;
                const currentSeed = await fingerprint(versionPath(source!, ref)); if (sameFiles(installed, currentSeed)) continue;
              }
              await replace(ref, marked ? owned.files : undefined);
            } catch (error) {
              incomplete = true;
              errors.push(`${identity(ref)} 未自动更新：${error instanceof Error ? error.message : String(error)}`);
            }
          }
          // Healthy installed packages remain discoverable during partial
          // failure. No completion marker until every eligible copy succeeded.
          if (!incomplete) await markInitialized();
          return true;
        });
        initialized = pending;
        // One shared attempt, including retries. Cache only complete success;
        // a partial result or a rejected attempt can be retried on the next read.
        const release = () => { if (initialized === pending) initialized = undefined; };
        void pending.then(() => { if (incomplete) release(); }, release);
      }
      return initialized;
    },
    replaceFromSeed(raw: SceneInteractionPackRef) {
      const ref = readSceneInteractionPackRef(raw);
      return serial(async () => { const result = await replace(ref); await markInitialized(); return result; });
    },
  };
}
