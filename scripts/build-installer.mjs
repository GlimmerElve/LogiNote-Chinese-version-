import * as fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { assertInstallerOutputIntegrity, nearestExistingOutputDirectory } from './installer-output-integrity.mjs';

const require = createRequire(import.meta.url);
const { load: loadYaml } = require('js-yaml');
const repository = fileURLToPath(new URL('..', import.meta.url));
const inside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const digest = async (file, algorithm = 'sha512') => {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('base64');
};
const exists = async file => {
  try { await fs.lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
};

/** Reject a truncated NSIS shell or stale metadata before touching final artifacts. */
export async function validateInstallerArtifacts(directory, version) {
  const metadataPath = path.join(directory, 'latest.yml');
  if (!(await fs.lstat(metadataPath)).isFile()) throw new Error('Update metadata must be a regular file');
  const metadata = loadYaml(await fs.readFile(metadataPath, 'utf8'));
  if (metadata?.version !== version || !Array.isArray(metadata.files) || !metadata.files.length) throw new Error('Missing or stale installer update metadata');
  const names = [];
  for (const entry of metadata.files) {
    const name = typeof entry.url === 'string' ? decodeURIComponent(entry.url) : '';
    if (!name || path.basename(name) !== name || /[\\/]/u.test(name) || !name.endsWith('.exe') || names.includes(name)) throw new Error('Unsafe or duplicate installer artifact name');
    const file = path.join(directory, name), info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1024 * 1024 || info.size !== entry.size) throw new Error(`Incomplete installer: ${name}`);
    const handle = await fs.open(file, 'r');
    const header = Buffer.alloc(2);
    try { await handle.read(header, 0, 2, 0); } finally { await handle.close(); }
    if (header.toString('ascii') !== 'MZ' || await digest(file) !== entry.sha512) throw new Error(`Installer checksum/header mismatch: ${name}`);
    const blockmap = `${name}.blockmap`, blockInfo = await fs.lstat(path.join(directory, blockmap));
    if (!blockInfo.isFile() || blockInfo.isSymbolicLink() || !blockInfo.size) throw new Error(`Missing blockmap: ${blockmap}`);
    const map = JSON.parse(gunzipSync(await fs.readFile(path.join(directory, blockmap)), { maxOutputLength: 32 * 1024 * 1024 }));
    if (map.version !== '2' || !Array.isArray(map.files) || !map.files.length) throw new Error(`Invalid blockmap: ${blockmap}`);
    let covered = 0;
    for (const part of map.files) {
      if (part.offset !== covered || !Array.isArray(part.sizes) || !Array.isArray(part.checksums) || part.sizes.length !== part.checksums.length ||
          !part.sizes.length || part.sizes.some(size => !Number.isSafeInteger(size) || size <= 0)) throw new Error(`Incomplete blockmap: ${blockmap}`);
      covered += part.sizes.reduce((sum, size) => sum + size, 0);
    }
    if (covered !== info.size) throw new Error(`Blockmap size mismatch: ${blockmap}`);
    names.push(name, blockmap);
  }
  const primary = metadata.files.find(entry => decodeURIComponent(entry.url) === metadata.path);
  if (!primary || metadata.sha512 !== primary.sha512) throw new Error('Update metadata references an absent or inconsistent installer');
  return [...names, 'latest.yml']; // Publish update metadata last.
}

/** Generated build artifacts only: create a new file in the destination rather
 * than copying the source file's metadata/security attributes. The destination
 * still inherits its parent's labels, which are independently checked below. */
export async function copyInstallerBytes(from, to, io = fs) {
  const source = await io.open(from, 'r');
  let target;
  try {
    target = await io.open(to, 'wx');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      await target.writeFile(buffer.subarray(0, bytesRead));
    }
    await target.sync();
  } finally {
    try { await target?.close(); } finally { await source.close(); }
  }
}

/** Native helpers stay in the workspace. Only Node publishes complete artifacts. */
export async function publishInstallerArtifacts(source, destination, names, io = fs, verifyOutput = assertInstallerOutputIntegrity) {
  await io.mkdir(destination, { recursive: true });
  const token = randomUUID(), entries = [];
  try {
    for (const name of names) {
      if (path.basename(name) !== name || /[\\/]/u.test(name)) throw new Error('Unsafe publication target');
      const target = path.join(destination, name);
      const entry = { name, target, next: `${target}.${token}.next`, previous: `${target}.${token}.previous`, saved: false, installed: false };
      entries.push(entry);
      const from = path.join(source, name);
      await copyInstallerBytes(from, entry.next, io);
      if (await digest(from) !== await digest(entry.next)) throw new Error(`Artifact copy verification failed: ${name}`);
    }
    // Check fully written new objects before replacing any older complete set.
    // Renaming within this directory retains each checked object's label.
    await verifyOutput([destination, ...entries.map(entry => entry.next)]);
    for (const entry of entries) {
      if (await exists(entry.target)) {
        if (!(await io.lstat(entry.target)).isFile()) throw new Error(`Publication target is not a file: ${entry.name}`);
        await io.rename(entry.target, entry.previous); entry.saved = true;
      }
      await io.rename(entry.next, entry.target); entry.installed = true;
    }
    return entries.filter(entry => entry.saved).map(entry => entry.previous);
  } catch (error) {
    const rollback = [];
    for (const entry of [...entries].reverse()) {
      try {
        if (entry.installed) await io.unlink(entry.target);
        if (entry.saved) await io.rename(entry.previous, entry.target);
      } catch (failure) { rollback.push(failure.message); }
    }
    if (rollback.length) throw new Error(`${error.message}; restore retained .previous files manually: ${rollback.join('; ')}`);
    throw error;
  } finally {
    for (const entry of entries) await io.unlink(entry.next).catch(error => { if (error.code !== 'ENOENT') console.warn(`Retained staging file: ${entry.next}`); });
  }
}

export async function runInstallerBuild({ rootDir = repository, args = [], env = process.env, spawnProcess = spawn,
  verifyOutput = assertInstallerOutputIntegrity, warn = message => console.warn(message) } = {}) {
  const root = await fs.realpath(rootDir);
  const config = loadYaml(await fs.readFile(path.join(root, 'electron-builder.yml'), 'utf8'));
  let output = config?.directories?.output || 'release';
  const forwarded = [];
  for (let i = 0; i < args.length; i++) {
    const match = /^(?:--output-dir|--config\.directories\.output|-c\.directories\.output)(?:=(.*))?$/u.exec(args[i]);
    if (match) {
      output = match[1] ?? args[++i];
      if (!output) throw new Error('An explicit installer output directory is required');
    } else forwarded.push(args[i]);
  }
  const finalOutput = path.resolve(root, output);
  if (finalOutput === root || finalOutput === path.parse(finalOutput).root) throw new Error('Installer output must not be a workspace or drive root');
  await verifyOutput([await nearestExistingOutputDirectory(finalOutput)]);
  if (!forwarded.some(arg => ['--publish', '-p'].includes(arg) || /^--publish=/u.test(arg))) forwarded.push('--publish', 'never');
  const build = path.join(root, 'build');
  await fs.mkdir(build, { recursive: true });
  if (!inside(root, await fs.realpath(build))) throw new Error('Installer workspace must stay inside the repository');
  const parent = path.join(build, 'installer-builds');
  await fs.mkdir(parent, { recursive: true });
  const realParent = await fs.realpath(parent);
  if (!inside(root, realParent)) throw new Error('Installer temporary parent escapes the repository');
  const lockName = createHash('sha256').update(process.platform === 'win32' ? finalOutput.toLowerCase() : finalOutput).digest('hex').slice(0, 20);
  const lockPath = path.join(parent, `${lockName}.lock`);
  let lock;
  try { lock = await fs.open(lockPath, 'wx'); }
  catch (error) { if (error.code === 'EEXIST') throw new Error(`Another or interrupted installer build owns ${lockPath}; inspect it before retrying`); throw error; }
  let stage;
  let published = false;
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, output: finalOutput }));
    stage = await fs.mkdtemp(path.join(realParent, 'run-'));
    const temporary = path.join(stage, 'temp'), artifacts = path.join(stage, 'artifacts');
    await fs.mkdir(temporary); await fs.mkdir(artifacts);
    const command = ['--require', path.join(root, 'scripts/electron-builder-utf8.cjs'), path.join(root, 'node_modules/electron-builder/cli.js'),
      ...forwarded, `--config.directories.output=${artifacts}`];
    const code = await new Promise((resolve, reject) => {
      const child = spawnProcess(process.execPath, command, { cwd: root, env: { ...env, TEMP: temporary, TMP: temporary, TMPDIR: temporary }, stdio: 'inherit', windowsHide: true });
      let cancelled = false;
      const interrupt = () => { cancelled = true; child.kill('SIGINT'); }, terminate = () => { cancelled = true; child.kill('SIGTERM'); };
      const detach = () => { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate); };
      process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
      child.once('error', error => { detach(); reject(error); });
      // Wait for native helpers' stdio handles as well; never publish a cancelled build.
      child.once('close', (exitCode, signal) => { detach(); resolve(cancelled ? 130 : exitCode ?? (signal === 'SIGINT' ? 130 : 1)); });
    });
    if (code !== 0) { warn(`[installer-build] Failed workspace retained at ${stage}`); return { code, stage }; }
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
    const names = await validateInstallerArtifacts(artifacts, manifest.version);
    const backups = await publishInstallerArtifacts(artifacts, finalOutput, names, fs, verifyOutput);
    await validateInstallerArtifacts(finalOutput, manifest.version);
    published = true;
    console.log(`Installer build complete: ${names.length} verified artifacts published to ${finalOutput}`);
    if (backups.length) warn(`[installer-build] Previous artifacts retained: ${backups.join(', ')}`);
    return { code: 0, output: finalOutput, names, backups };
  } catch (error) {
    if (stage) warn(`[installer-build] Recovery workspace retained at ${stage}`);
    throw error;
  } finally {
    if (published && stage) {
      try {
        if ((await fs.lstat(stage)).isSymbolicLink() || path.dirname(await fs.realpath(stage)) !== realParent || !path.basename(stage).startsWith('run-')) throw new Error('Installer cleanup target changed');
        await fs.rm(stage, { recursive: true, force: true });
      } catch (error) { warn(`[installer-build] Scratch files retained at ${stage}: ${error.message}`); }
    }
    await lock.close(); await fs.unlink(lockPath);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = (await runInstallerBuild({ args: process.argv.slice(2) })).code; }
  catch (error) { console.error(error); process.exitCode = 1; }
}
