import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const repository = fileURLToPath(new URL('..', import.meta.url));
const within = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

/** Exercise Chromium startup without opening a window or loading an app/vault.
 * RUN_AS_NODE skips the startup path that can fail before JavaScript is entered. */
export function probeElectron(executable, { env = process.env, spawnProcess = spawn, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const guiEnvironment = { ...env };
    delete guiEnvironment.ELECTRON_RUN_AS_NODE;
    const child = spawnProcess(executable, ['--version'], {
      env: guiEnvironment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '', errorOutput = '', timedOut = false;
    child.stdout.on('data', chunk => { output = (output + chunk).slice(0, 2048); });
    child.stderr.on('data', chunk => { errorOutput = (errorOutput + chunk).slice(0, 2048); });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, version: code === 0 ? output.trim().replace(/^v/u, '') : undefined, error: errorOutput.trim(), timedOut });
    });
  });
}

/** Keep node_modules intact. An affected Windows runtime is copied into an
 * immutable per-version cache; app code and all original user data stay put. */
export async function prepareElectronRuntime({
  executable = require('electron'), platform = process.platform, temporaryRoot = os.tmpdir(),
  probe = probeElectron, log = message => console.log(message),
} = {}) {
  const source = await fs.realpath(executable);
  if (platform !== 'win32') return source;
  const sourceDirectory = path.dirname(source);
  const version = (await fs.readFile(path.join(sourceDirectory, 'version'), 'utf8')).trim();
  const original = await probe(source);
  if (original.code === 0 && original.version === version) return source;
  // Do not conceal missing executables, access-denied errors or arbitrary app failures.
  if ((original.code >>> 0) !== 0x80000003) {
    throw new Error(`Electron 运行时自检失败（退出码 ${original.code}）：${original.error || source}`);
  }
  log('[electron-start] 当前路径下的 Electron 无法启动，正在检查同版本本地运行时缓存…');
  const temporary = await fs.realpath(temporaryRoot);
  const parent = path.join(temporary, 'loginote-development-runtime');
  await fs.mkdir(parent, { recursive: true });
  const realParent = await fs.realpath(parent);
  if (!within(temporary, realParent)) throw new Error('Electron 运行时缓存目录不在本机临时目录中');
  const revisions = await Promise.all(['electron.exe', 'snapshot_blob.bin', 'v8_context_snapshot.bin', 'icudtl.dat'].map(async name => {
    const stat = await fs.stat(path.join(sourceDirectory, name));
    return [name, stat.size, stat.mtimeMs];
  }));
  const identity = createHash('sha256').update(JSON.stringify([sourceDirectory, version, revisions])).digest('hex').slice(0, 24);
  const pointer = path.join(realParent, `${identity}.json`);
  try {
    const saved = JSON.parse(await fs.readFile(pointer, 'utf8'));
    if (saved.source === sourceDirectory && saved.version === version && /^runtime-[A-Za-z0-9]+$/u.test(saved.directory)) {
      const cachedDirectory = path.join(realParent, saved.directory);
      const realCached = await fs.realpath(cachedDirectory);
      if (path.dirname(realCached) === realParent && !(await fs.lstat(cachedDirectory)).isSymbolicLink()) {
        const cached = path.join(realCached, 'electron.exe');
        const result = await probe(cached);
        if (result.code === 0 && result.version === version) return cached;
      }
    }
  } catch { /* A missing/incomplete old cache never replaces the original runtime. */ }

  const prepared = await fs.mkdtemp(path.join(realParent, 'runtime-'));
  try {
    await fs.cp(sourceDirectory, prepared, { recursive: true, filter: file => path.basename(file) !== 'debug.log' });
    const cached = path.join(prepared, 'electron.exe');
    const result = await probe(cached);
    if (result.code !== 0 || result.version !== version) {
      throw new Error(`同版本 Electron 缓存仍无法启动（退出码 ${result.code}）。缓存目录：${prepared}`);
    }
    const pending = `${pointer}.${process.pid}-${randomUUID()}.tmp`;
    await fs.writeFile(pending, JSON.stringify({ source: sourceDirectory, version, directory: path.basename(prepared) }), 'utf8');
    await fs.rename(pending, pointer);
    log(`[electron-start] Electron ${version} 自检通过，正在打开软件。`);
    return cached;
  } catch (error) {
    const target = await fs.realpath(prepared);
    if (path.dirname(target) === realParent && path.basename(target).startsWith('runtime-')) {
      await fs.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
    throw error;
  }
}

export function launchElectron(executable, { rootDir = repository, args = [], env = process.env, spawnProcess = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const guiEnvironment = { ...env };
    delete guiEnvironment.ELECTRON_RUN_AS_NODE;
    const child = spawnProcess(executable, [rootDir, ...args], {
      cwd: rootDir, env: guiEnvironment, stdio: 'inherit', windowsHide: false,
    });
    const interrupt = () => child.kill('SIGINT'), terminate = () => child.kill('SIGTERM');
    const detach = () => { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate); };
    process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
    child.once('error', error => { detach(); reject(error); });
    child.once('exit', (code, signal) => {
      detach();
      if (code && code > 255) console.error(`[electron-start] Electron 异常退出：0x${(code >>> 0).toString(16).toUpperCase()}`);
      resolve(code === 0 ? 0 : signal === 'SIGINT' ? 130 : 1);
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(`[electron-start] 项目目录：${repository}`);
    const index = await fs.readFile(path.join(repository, 'dist', 'index.html'), 'utf8');
    const entry = /src="\.\/assets\/([^"/]+\.js)"/u.exec(index)?.[1];
    if (entry) console.log(`[electron-start] 前端构建：${entry}`);
    const executable = await prepareElectronRuntime();
    process.exitCode = await launchElectron(executable, { args: process.argv.slice(2) });
  } catch (error) { console.error(`[electron-start] ${error.message}`); process.exitCode = 1; }
}
