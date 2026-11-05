import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultSource = path.join(repository, 'examples/scene-packs/number-scale');
const defaultOutput = path.join(repository, 'output/scene-pack-examples');
let readerPromise;
/** Exact audited input boundary, shared with its negative regression checks. */
export function assertScenePackProtocolReaderInputs(inputs) {
  const allowed = new Set(['scene-pack-build-readers.ts', 'src/services/scene/sceneInteractionPackProtocol.ts',
      'src/services/scene/sceneInteractionPackManifest.ts', 'src/services/scene/sceneInteractionPackMaterialProtocol.ts',
      // Reviewed shared pure readers extracted from the desktop protocol. Keep
      // exact files: importing server/storage code must still fail closed.
      'apps/community-api/src/scenePackageManifest.ts', 'apps/community-api/src/scenePackageMaterial.ts',
      'src/services/scene/sceneS2PluginProtocol.ts', 'src/services/scene/scenePackCanvasPolicy.ts', 'src/services/scene/scenePackAuthoringCatalog.ts',
      'src/services/scene/sceneS2Controls.ts', 'src/services/scene/sceneS2DataViews.ts', 'src/services/scene/sceneS2ControlIssue.ts',
      'src/services/scene/sceneS2InteractionProtocol.ts'].map(file => path.resolve(repository, file)));
  for (const input of inputs) if (!allowed.has(path.resolve(repository, input)))
    throw new Error(`构建工具的协议读取器不是纯依赖：${input}`);
}
async function protocolReaders() {
  if (!readerPromise) readerPromise = (async () => {
    const result = await build({ absWorkingDir: repository, stdin: { contents:
      `export { readScenePackDescription, readSceneInteractionPack } from './src/services/scene/sceneInteractionPackProtocol.ts';\nexport { readSceneInteractionPackManifest } from './src/services/scene/sceneInteractionPackManifest.ts';\nexport { verifyScenePackMaterialBytes } from './src/services/scene/sceneInteractionPackMaterialProtocol.ts';`,
      resolveDir: repository, loader: 'ts', sourcefile: 'scene-pack-build-readers.ts' },
      bundle: true, write: false, format: 'esm', platform: 'node', target: 'node22', metafile: true, logLevel: 'silent' });
    assertScenePackProtocolReaderInputs(Object.keys(result.metafile.inputs));
    // Only reviewed pure protocol readers run in the tool process. They are never bundled into the user's package.
    return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].contents).toString('base64'));
  })();
  return readerPromise;
}
async function readMetadata(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !['manifest', 'description', 'authoring', 'execution'].includes(key))
    || !Object.hasOwn(raw, 'manifest') || !Object.hasOwn(raw, 'description') && !Object.hasOwn(raw, 'authoring')) throw new Error('scene-pack.json 需要manifest，以及authoring或旧description；不允许其他字段');
  const readers = await protocolReaders();
  if (raw.execution !== undefined && !['none', 'on-demand'].includes(raw.execution)) throw new Error('execution只支持none或on-demand');
  const manifest = readers.readSceneInteractionPackManifest(raw.manifest);
  if (!Object.hasOwn(raw, 'authoring')) return { manifest, guide: readers.readScenePackDescription(raw.description) };
  // Normalize a machine-only metadata entry with inert tool-owned stubs. Never
  // import or evaluate the user's entry to extract a manual or public directory.
  const normalized = readers.readSceneInteractionPack({ manifest, authoring: raw.authoring, capabilities: [], ...(raw.execution === undefined ? {} : { execution: raw.execution }),
    ...(Object.hasOwn(raw, 'description') ? { describe: () => raw.description } : {}),
    validate() { throw new Error('Metadata validation must not execute package code'); },
    createRuntime() { throw new Error('Metadata validation must not start a runtime'); },
    executeLocal() { throw new Error('Metadata validation must not execute a component'); } });
  return { manifest, guide: normalized.describe() };
}
function within(directory, file) {
  const relative = path.relative(directory, file);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

const publications = new Map();
/** Replace only a recognized exact build release, never an output root. The
 * clean staged tree prevents retired materials from leaking into release ZIPs.
 * Windows has no directory exchange: retain the whole old release until the
 * new directory rename succeeds, and restore it if publication fails. */
export async function publishScenePackBuild({ destination, source, manifest, files, io = fs }) {
  const target = path.resolve(destination), parent = path.dirname(target);
  if (path.basename(target) !== manifest.version || path.basename(parent) !== manifest.id
    || within(source, target) || within(target, source)) throw new Error('构建目标必须是源码之外的精确 id/version 目录');
  const prior = publications.get(target) ?? Promise.resolve();
  const operation = prior.catch(() => {}).then(async () => {
    let folder = path.parse(parent).root;
    for (const segment of path.relative(folder, parent).split(path.sep).filter(Boolean)) {
      folder = path.join(folder, segment);
      await io.mkdir(folder).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const info = await io.lstat(folder);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('构建产物父目录不能包含链接或非目录');
    }
    const realParent = await io.realpath(parent);
    if (within(source, realParent)) throw new Error('产物真实目录必须位于源码之外');
    const realTarget = path.join(realParent, manifest.version);
    if (within(realTarget, source)) throw new Error('产物目录不能包含源码');
    const oldInfo = await io.lstat(realTarget).catch(error => { if (error.code !== 'ENOENT') throw error; });
    async function snapshot(directory) {
      const info = await io.lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('已有产物必须为普通版本目录');
      const manifestFile = path.join(directory, 'manifest.json'), manifestInfo = await io.lstat(manifestFile);
      if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.size > 8192) throw new Error('不能识别已有构建产物，请选择新的输出目录');
      const previous = (await protocolReaders()).readSceneInteractionPackManifest(JSON.parse(await io.readFile(manifestFile, 'utf8')));
      if (previous.id !== manifest.id || previous.version !== manifest.version) throw new Error('已有产物身份不同，未替换');
      const names = new Set(['main.js', 'manifest.json', 'agent.json', 'styles.css', 'package.json',
        ...(previous.protocolVersion === 2 ? previous.materials.map(item => item.path) : [])]);
      const result = new Map(); let entries = 0;
      async function walk(folder, prefix = '') {
        for (const name of await io.readdir(folder)) {
          if (++entries > 256) throw new Error('已有产物文件过多，未替换');
          const relative = prefix + name, file = path.join(folder, name), info = await io.lstat(file);
          if (info.isSymbolicLink()) throw new Error('已有产物包含链接，未替换');
          if (info.isDirectory()) {
            if (![...names].some(item => item.startsWith(relative + '/'))) throw new Error(`已有产物包含未知目录，未替换：${relative}`);
            await walk(file, relative + '/');
          } else {
            if (!info.isFile() || !names.has(relative) || info.size > 2 * 1024 * 1024) throw new Error(`已有产物包含未知文件或超限内容，未替换：${relative}`);
            const bytes = await io.readFile(file);
            if (bytes.byteLength > 2 * 1024 * 1024) throw new Error('已有产物读取期间超限，未替换');
            result.set(relative, bytes);
          }
        }
      }
      await walk(directory); return result;
    }
    const previous = oldInfo ? await snapshot(realTarget) : undefined;
    const transaction = await io.mkdtemp(path.join(realParent, `.build-${manifest.version}-`));
    const next = path.join(transaction, 'next'), backup = path.join(transaction, 'previous');
    let moved = false, published = false, preserve = false;
    try {
      await io.mkdir(next);
      for (const [name, contents] of files) {
        const file = path.resolve(next, name);
        if (!within(next, file)) throw new Error('产物文件必须位于当前临时版本目录内');
        await io.mkdir(path.dirname(file), { recursive: true });
        const handle = await io.open(file, 'wx');
        try { await handle.writeFile(contents); await handle.sync(); } finally { await handle.close(); }
      }
      if (previous) {
        try { await io.rename(realTarget, backup); }
        catch (error) {
          if (['EPERM', 'EBUSY'].includes(error.code)) throw Object.assign(new Error(
            `PACK_BUILD_BUSY (${error.code}): 构建产物可能正被打包或其他进程读取，未替换旧版本；请稍后重试。`, { cause: error }), { code: error.code });
          throw error;
        }
        moved = true;
        const current = await snapshot(backup);
        if (current.size !== previous.size || [...previous].some(([name, bytes]) => !current.get(name)?.equals(bytes)))
          throw new Error('已有产物在构建期间变化，未发布新版本');
      } else if (await io.lstat(realTarget).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) {
        throw new Error('其他操作已发布相同版本，请重试');
      }
      await io.rename(next, realTarget); published = true;
    } catch (error) {
      if (moved && !published) {
        try { await io.rename(backup, realTarget); }
        catch (restoreError) { preserve = true; throw new Error(`构建发布失败且无法自动恢复；完整旧产物保留于 ${backup}：${error.message}；${restoreError.message}`); }
      }
      throw error;
    } finally {
      if (!preserve) {
        // Only our generated transaction, directly under this exact package ID.
        if (path.dirname(transaction) !== realParent || !path.basename(transaction).startsWith(`.build-${manifest.version}-`)
          || (await io.lstat(transaction)).isSymbolicLink()) throw new Error('构建临时目录无效，未清理');
        try { await io.rm(transaction, { recursive: true, force: true }); }
        catch (error) { if (!published) throw error; console.warn(`新产物已发布，旧构建备份仍保留于 ${transaction}：${error.message}`); }
      }
    }
  });
  publications.set(target, operation);
  try { await operation; } finally { if (publications.get(target) === operation) publications.delete(target); }
}

/** Build this convention's arbitrary source directory. Metadata is inert JSON; entry code is NEVER imported/evaluated here. */
export async function buildScenePack({ sourceDir = defaultSource, outputRoot = defaultOutput } = {}) {
  const source = await fs.realpath(path.resolve(sourceDir));
  const ownedFile = async name => {
    const file = await fs.realpath(path.join(source, name));
    if (!within(source, file)) throw new Error(`源码文件必须位于包目录内：${name}`);
    return file;
  };
  const metadata = JSON.parse(await fs.readFile(await ownedFile('scene-pack.json'), 'utf8'));
  const { manifest, guide } = await readMetadata(metadata);
  const destination = path.resolve(outputRoot, manifest.id, manifest.version);
  if (within(source, destination)) throw new Error('产物目录必须位于源码目录外');
  const materials = [];
  for (const descriptor of manifest.protocolVersion === 2 ? manifest.materials : []) {
    const file = await ownedFile(descriptor.path), handle = await fs.open(file, 'r');
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size !== descriptor.bytes) throw new Error(`物料完整大小与清单不符：${descriptor.id}`);
      // One extra byte also detects a file growing after stat without an unbounded read.
      const buffer = Buffer.alloc(descriptor.bytes + 1); let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      const contents = buffer.subarray(0, length);
      await (await protocolReaders()).verifyScenePackMaterialBytes(descriptor, contents);
      materials.push([descriptor.path, contents]);
    } finally { await handle.close(); }
  }
  const result = await build({ absWorkingDir: source, entryPoints: [await ownedFile('entry.ts')], bundle: true, write: false,
    format: 'esm', platform: 'browser', target: 'es2022', jsx: 'transform', tsconfigRaw: { compilerOptions: { jsx: 'react' } },
    metafile: true, logLevel: 'silent' });
  for (const input of Object.keys(result.metafile.inputs)) {
    const real = await fs.realpath(path.resolve(source, input));
    if (!within(source, real)) throw new Error(`交互包不得打入宿主实现或包外依赖：${input}`);
  }
  if (result.outputFiles.length !== 1 || result.metafile.outputs[Object.keys(result.metafile.outputs)[0]].imports.length)
    throw new Error('entry.ts 必须构建为无剩余模块依赖的单文件 ESM；样式请放 styles.css');
  if (!Object.values(result.metafile.outputs).some(output => output.exports.includes('activate'))) throw new Error('entry.ts 必须导出 activate(services)');
  const styles = await fs.readFile(await ownedFile('styles.css'), 'utf8');
  const files = { 'main.js': result.outputFiles[0].contents, 'manifest.json': JSON.stringify(manifest, null, 2),
    'agent.json': JSON.stringify(guide, null, 2), 'styles.css': styles, 'package.json': JSON.stringify({ private: true, type: 'module' }) };
  const limits = { 'main.js': 524288, 'manifest.json': 8192, 'agent.json': 262144, 'styles.css': 65536 };
  for (const [name, max] of Object.entries(limits)) if (Buffer.byteLength(files[name]) > max) throw new Error(`${name} 超过跨终端示例构建上限 ${max} 字节`);
  await publishScenePackBuild({ destination, source, manifest, files: [...Object.entries(files), ...materials] });
  return { destination, manifest: structuredClone(manifest), description: structuredClone(guide), bytes: result.outputFiles[0].contents.byteLength, modules: Object.keys(result.metafile.inputs).length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {};
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index], value = process.argv[index + 1];
    if (!['--source', '--out'].includes(key) || !value) throw new Error('用法：node scripts/build-scene-pack-example.mjs [--source 源码目录] [--out 安装包根目录]');
    options[key === '--source' ? 'sourceDir' : 'outputRoot'] = value;
  }
  console.log(await buildScenePack(options));
}
