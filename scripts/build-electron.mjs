import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const electronFiles = ['preload.cjs', 'mermaid-preload.cjs', 'rag-compute.cjs', 'main.cjs'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const retryable = new Set(['EACCES', 'EPERM', 'EBUSY']);

/** Keep native/heavy top-level dependencies external, but compile the pure-JS
 * Markdown dependency closure. Packaged npm trees can place a shared micromark
 * helper below one sibling only, where another sibling cannot resolve it. */
export async function electronExternalPackages(rootDir) {
  const manifest = JSON.parse(await fs.readFile(path.join(rootDir, 'package.json'), 'utf8'));
  return ['electron', ...Object.keys(manifest.dependencies || {})
    .filter(name => !/^(?:mdast-|micromark(?:-|$)|unist-|hast-)/u.test(name))];
}

async function readOptional(io, file) {
  try { return await io.readFile(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function durableWrite(io, file, contents) {
  const handle = await io.open(file, 'wx');
  try { await handle.writeFile(contents); await handle.sync(); }
  finally { await handle.close(); }
}

export async function compileElectron(rootDir) {
  const esbuild = await import('esbuild');
  const external = await electronExternalPackages(rootDir);
  const jobs = [
    ['main.cjs', 'src/electron/main.ts', { external }],
    ['preload.cjs', 'src/electron/preload.ts', { external: ['electron'] }],
    ['mermaid-preload.cjs', 'src/electron/mermaidPreload.ts', { external: ['electron'] }],
    ['rag-compute.cjs', 'src/electron/ragComputeWorker.ts', { external }],
  ];
  // No compiler writes/truncates a live output file. Wait for every build before
  // stopping this invocation's service, including when one entry fails.
  try {
    const results = await Promise.allSettled(jobs.map(async ([name, entry, extra]) => {
      const result = await esbuild.build({
        absWorkingDir: rootDir, entryPoints: [entry], bundle: true,
        platform: 'node', format: 'cjs', write: false, logLevel: 'silent',
        outfile: path.join(rootDir, 'dist-electron', name), ...extra,
      });
      if (result.outputFiles.length !== 1) throw new Error(`Unexpected output for ${name}`);
      return [name, Buffer.from(result.outputFiles[0].contents)];
    }));
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    return new Map(results.map(result => result.value));
  } finally { esbuild.stop(); }
}

export async function publishElectronFiles(files, {
  rootDir, outDir = path.join(rootDir, 'dist-electron'), io = fs,
  attempts = 10, delay = sleep, warn = console.warn,
} = {}) {
  rootDir = path.resolve(rootDir);
  outDir = path.resolve(outDir);
  const relative = path.relative(rootDir, outDir);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Electron output must be a child directory of the repository.');
  }
  if (files.size !== electronFiles.length || electronFiles.some(name => !files.has(name))) {
    throw new Error('All three Electron bundles are required before publishing.');
  }
  for (const [name, contents] of files) {
    if (!electronFiles.includes(name) || !(contents instanceof Uint8Array) || !contents.length) {
      throw new Error(`Invalid Electron bundle: ${name}`);
    }
  }
  const workspace = path.join(rootDir, 'build', 'electron-builds');
  await io.mkdir(workspace, { recursive: true });
  const key = createHash('sha256').update(outDir).digest('hex').slice(0, 16);
  const lockPath = path.join(workspace, `${key}.lock`);
  let lock;
  try { lock = await io.open(lockPath, 'wx'); }
  catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(`Another or interrupted Electron build owns ${lockPath}. Do not run builds concurrently; inspect this lock before retrying.`);
    }
    throw error;
  }
  let transaction;
  let preserveTransaction = false;
  const changed = [];
  const unchanged = [];
  const entries = [];
  const rename = async (from, to) => {
    for (let attempt = 1; ; attempt++) {
      try { await io.rename(from, to); return; }
      catch (error) {
        if (!retryable.has(error.code) || attempt >= attempts) throw error;
        await delay(150);
      }
    }
  };
  const cleanup = async () => {
    if (!transaction || preserveTransaction) return;
    let retained = false;
    for (const name of electronFiles) {
      for (const suffix of ['next', 'previous', 'failed']) {
        try { await io.unlink(path.join(transaction, `${name}.${suffix}`)); }
        catch (error) { if (error.code !== 'ENOENT') retained = true; }
      }
    }
    if (!retained) {
      try { await io.rmdir(transaction); }
      catch (error) { if (error.code !== 'ENOENT') retained = true; }
    }
    if (retained) warn(`Old build files are still in use; recoverable backup retained at ${transaction}`);
  };
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, output: outDir }));
    await lock.sync();
    await io.mkdir(outDir, { recursive: true });
    transaction = await io.mkdtemp(path.join(workspace, 'transaction-'));
    for (const name of electronFiles) {
      const target = path.join(outDir, name);
      const previous = await readOptional(io, target);
      const next = Buffer.from(files.get(name));
      if (previous?.equals(next)) { unchanged.push(name); continue; }
      const entry = {
        name, target, previous, next, movedOld: false, installed: false,
        staged: path.join(transaction, `${name}.next`),
        backup: path.join(transaction, `${name}.previous`),
      };
      entries.push(entry);
      await durableWrite(io, entry.staged, next);
    }
    // Keep the entry point until last. A mapped file may be renamed but cannot
    // be truncated: move it to a unique backup, then install into an empty path.
    // Do not replace/delete the mapped destination via rename(new, existing).
    for (const entry of entries) {
      const current = await readOptional(io, entry.target);
      if (current === null ? entry.previous !== null : !entry.previous?.equals(current)) {
        throw new Error(`Output changed during build: ${entry.target}`);
      }
      if (entry.previous !== null) {
        await rename(entry.target, entry.backup);
        entry.movedOld = true;
      }
      await rename(entry.staged, entry.target);
      entry.installed = true;
      changed.push(entry.name);
    }
    return { changed, unchanged };
  } catch (error) {
    const failures = [];
    for (const entry of [...entries].reverse()) {
      try {
        if (entry.installed) {
          const current = await readOptional(io, entry.target);
          if (!current?.equals(entry.next)) throw new Error(`Refusing to overwrite modified output: ${entry.target}`);
          await rename(entry.target, path.join(transaction, `${entry.name}.failed`));
        }
        if (entry.movedOld) {
          if (await readOptional(io, entry.target) !== null) {
            throw new Error(`Refusing to overwrite output created by another writer: ${entry.target}`);
          }
          await rename(entry.backup, entry.target);
        }
      } catch (failure) { failures.push(failure.message); }
    }
    preserveTransaction = failures.length > 0;
    const recovery = preserveTransaction
      ? `Recovery files retained at ${transaction}. ${failures.join('; ')}`
      : 'Previous Electron output restored (files unchanged before this build remain unchanged).';
    throw new Error(`Electron output publish failed: ${error.message}\n${recovery}\nIf a file also refuses rename, close the process holding that specific file and retry; no processes were killed.`, { cause: error });
  } finally {
    await cleanup();
    await lock.close();
    // An incomplete rollback owns recoverable artifacts. Do not let another
    // build silently proceed over the mixed output before recovery is checked.
    if (!preserveTransaction) await io.unlink(lockPath);
  }
}

export async function buildElectron(options = {}) {
  const rootDir = options.rootDir ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const files = await (options.compile ?? compileElectron)(rootDir);
  return publishElectronFiles(files, { ...options, rootDir });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--outdir')) {
      throw new Error('Usage: node scripts/build-electron.mjs [--outdir <repository-child-directory>]');
    }
    const result = await buildElectron(args.length ? { outDir: args[1] } : {});
    console.log(`Electron build complete: ${result.changed.length} replaced, ${result.unchanged.length} unchanged.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
