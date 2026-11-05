import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const repository = fileURLToPath(new URL('..', import.meta.url));
const inside = (parent, candidate) => {
  const relative = path.relative(parent, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

/** esbuild transports >1 MB transforms through disk. On Windows the service
 * must be able to delete those inputs, so give this invocation a writable,
 * private directory before Vite or an esbuild child process starts. */
export async function runViteBuild({
  rootDir = repository, args = [], env = process.env, spawnProcess = spawn,
  warn = message => console.warn(message),
} = {}) {
  const root = await fs.realpath(rootDir);
  const build = path.join(root, 'build');
  await fs.mkdir(build, { recursive: true });
  const realBuild = await fs.realpath(build);
  if (!inside(root, realBuild)) throw new Error('Vite temporary build directory must stay inside the repository.');
  const parent = path.join(realBuild, 'vite-temp');
  await fs.mkdir(parent, { recursive: true });
  const realParent = await fs.realpath(parent);
  if (!inside(root, realParent)) throw new Error('Vite temporary build directory points outside the repository.');
  const temporary = await fs.mkdtemp(path.join(realParent, 'run-'));
  try {
    return await new Promise((resolve, reject) => {
      const child = spawnProcess(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'build', ...args], {
        cwd: root,
        env: { ...env, TEMP: temporary, TMP: temporary, TMPDIR: temporary },
        stdio: 'inherit', windowsHide: true,
      });
      const interrupt = () => child.kill('SIGINT');
      const terminate = () => child.kill('SIGTERM');
      const detach = () => { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate); };
      process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
      child.once('error', error => { detach(); reject(error); });
      child.once('exit', (code, signal) => { detach(); resolve(code ?? (signal === 'SIGINT' ? 130 : 1)); });
    });
  } finally {
    try {
      const realTemporary = await fs.realpath(temporary);
      const metadata = await fs.lstat(temporary);
      if (metadata.isSymbolicLink() || path.dirname(realTemporary) !== realParent
        || !path.basename(realTemporary).startsWith('run-') || !inside(root, realTemporary)) {
        throw new Error('Temporary cleanup target changed; automatic removal refused.');
      }
      await fs.rm(realTemporary, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
    } catch (error) {
      // A locked scratch file must not turn a successful build into a failure.
      warn(`[vite-build] Temporary files retained at ${temporary}: ${error.message}`);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await runViteBuild({ args: process.argv.slice(2) }); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
