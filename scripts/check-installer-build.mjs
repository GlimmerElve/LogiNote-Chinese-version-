import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { runInstallerBuild, validateInstallerArtifacts, publishInstallerArtifacts, copyInstallerBytes } from './build-installer.mjs';
import { assertInstallerOutputIntegrity, nearestExistingOutputDirectory, inspectWindowsIntegrity } from './installer-output-integrity.mjs';

const repository = await fs.realpath(new URL('..', import.meta.url));
const build = path.join(repository, 'build');
await fs.mkdir(build, { recursive: true });
const fixture = await fs.mkdtemp(path.join(build, 'installer-build-check-'));
const root = path.join(fixture, 'project');
const output = path.join(fixture, 'external-output');
const version = '1.2.3';
const installer = `LogiNote-Setup-${version}.exe`;
const artifactNames = [installer, `${installer}.blockmap`, 'latest.yml'];
const sha512 = data => createHash('sha512').update(data).digest('base64');
let count = 0;
const warnings = [];
const uncheckedFixture = async () => {}; // Synthetic files intentionally live in the repository's test directory.
const options = { rootDir: root, verifyOutput: uncheckedFixture, warn: message => warnings.push(message) };
const originalEnvironment = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };

async function writeArtifacts(directory, marker = 1) {
  await fs.mkdir(directory, { recursive: true });
  const bytes = Buffer.alloc(1024 * 1024 + 17, marker); bytes.write('MZ', 0, 'ascii');
  const hash = sha512(bytes);
  await fs.writeFile(path.join(directory, installer), bytes);
  await fs.writeFile(path.join(directory, `${installer}.blockmap`), gzipSync(JSON.stringify({ version: '2', files: [
    { name: 'file', offset: 0, checksums: [hash], sizes: [bytes.length] },
  ] })));
  // JSON is also valid YAML, and avoids depending on serialization formatting.
  await fs.writeFile(path.join(directory, 'latest.yml'), JSON.stringify({ version, files: [{ url: installer, size: bytes.length, sha512: hash }], path: installer, sha512: hash }));
}
const snapshot = async directory => Promise.all(artifactNames.map(name => fs.readFile(path.join(directory, name)).then(sha512)));
const absent = file => assert.rejects(fs.lstat(file), { code: 'ENOENT' });
const stagePath = observed => path.dirname(observed.options.env.TEMP);

function fakeBuilder({ code = 0, marker = 2, mutate, onSpawn } = {}) {
  return (executable, command, childOptions) => {
    const observed = { executable, command, options: childOptions };
    const child = new EventEmitter(); child.kill = () => {};
    onSpawn?.(observed);
    setImmediate(async () => {
      try {
        if (!code) {
          const artifactDir = command.find(arg => arg.startsWith('--config.directories.output=')).split('=').slice(1).join('=');
          await writeArtifacts(artifactDir, marker);
          await mutate?.(artifactDir);
        }
        child.emit('exit', code, null); child.emit('close', code, null);
      } catch (error) { child.emit('error', error); }
    });
    return child;
  };
}

try {
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ version }));
  await fs.writeFile(path.join(root, 'electron-builder.yml'), 'directories:\n  output: release\n');
  await writeArtifacts(output);
  const original = await snapshot(output);

  let observed;
  const result = await runInstallerBuild({ ...options, args: ['--win', 'nsis', '--prepackaged', 'release/win-unpacked', '--output-dir', output],
    env: { ...process.env, INSTALLER_TEST_VALUE: 'preserved' }, spawnProcess: fakeBuilder({ onSpawn: value => { observed = value; } }) });
  assert.equal(result.code, 0);
  assert.deepEqual(result.names, artifactNames);
  assert.equal(observed.executable, process.execPath);
  assert.deepEqual(observed.command.slice(0, 3), ['--require', path.join(root, 'scripts/electron-builder-utf8.cjs'), path.join(root, 'node_modules/electron-builder/cli.js')]);
  assert.deepEqual(observed.command.slice(3, -1), ['--win', 'nsis', '--prepackaged', 'release/win-unpacked', '--publish', 'never']);
  assert.ok(observed.command.at(-1).startsWith(`--config.directories.output=${path.join(root, 'build', 'installer-builds', 'run-')}`));
  assert.ok(!observed.command.some(arg => arg.includes(output)));
  assert.equal(observed.options.cwd, root);
  assert.equal(observed.options.windowsHide, true);
  assert.equal(observed.options.env.INSTALLER_TEST_VALUE, 'preserved');
  assert.equal(observed.options.env.TEMP, observed.options.env.TMP);
  assert.equal(observed.options.env.TEMP, observed.options.env.TMPDIR);
  await absent(stagePath(observed));
  assert.deepEqual(await Promise.all(result.backups.map(file => fs.readFile(file).then(sha512))), original);
  assert.notDeepEqual(await snapshot(output), original);
  assert.deepEqual(await validateInstallerArtifacts(output, version), artifactNames); count++;

  // A failed native builder or spawn never touches the previous complete output.
  const beforeFailure = await snapshot(output);
  const failed = await runInstallerBuild({ ...options, args: [`--config.directories.output=${output}`], spawnProcess: fakeBuilder({ code: 7, onSpawn: value => { observed = value; } }) });
  assert.equal(failed.code, 7);
  assert.ok((await fs.stat(failed.stage)).isDirectory());
  assert.deepEqual(await snapshot(output), beforeFailure); count++;
  await assert.rejects(runInstallerBuild({ ...options, args: ['--output-dir', output], spawnProcess() { throw new Error('synthetic spawn failure'); } }), /synthetic spawn failure/);
  assert.deepEqual(await snapshot(output), beforeFailure); count++;

  for (const mutate of [
    directory => fs.writeFile(path.join(directory, installer), 'MZtruncated shell'),
    async directory => { const file = path.join(directory, installer), bytes = await fs.readFile(file); bytes[100] ^= 1; await fs.writeFile(file, bytes); },
    directory => fs.writeFile(path.join(directory, `${installer}.blockmap`), 'truncated blockmap'),
    directory => fs.unlink(path.join(directory, 'latest.yml')),
    async directory => { const file = path.join(directory, 'latest.yml'), data = JSON.parse(await fs.readFile(file)); data.version = '0.0.0'; await fs.writeFile(file, JSON.stringify(data)); },
    async directory => { const file = path.join(directory, 'latest.yml'), data = JSON.parse(await fs.readFile(file)); data.files[0].url = '../escape.exe'; await fs.writeFile(file, JSON.stringify(data)); },
    async directory => { const file = path.join(directory, 'latest.yml'), data = JSON.parse(await fs.readFile(file)); data.sha512 = 'stale'; await fs.writeFile(file, JSON.stringify(data)); },
  ]) {
    await assert.rejects(runInstallerBuild({ ...options, args: ['--output-dir', output], spawnProcess: fakeBuilder({ mutate }) }));
    assert.deepEqual(await snapshot(output), beforeFailure); count++;
  }
  // Ordinary failure releases its lock, so a subsequent retry succeeds.
  assert.equal((await runInstallerBuild({ ...options, args: [`-c.directories.output=${output}`], spawnProcess: fakeBuilder({ marker: 3 }) })).code, 0); count++;

  // A shared output is locked for the whole build; another output is independent.
  let releaseChild;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const running = runInstallerBuild({ ...options, args: ['--output-dir', output], spawnProcess() {
    const child = new EventEmitter(); child.kill = () => {};
    releaseChild = () => { child.emit('exit', 9); child.emit('close', 9); };
    started(); return child;
  } });
  await ready;
  try {
    await assert.rejects(runInstallerBuild({ ...options, args: ['--output-dir', output], spawnProcess() { assert.fail('a concurrent build must not launch'); } }), /owns.*lock/);
    const independent = await runInstallerBuild({ ...options, args: ['--output-dir', path.join(fixture, 'another-output')], spawnProcess: fakeBuilder() });
    assert.equal(independent.code, 0); count++;
  } finally { releaseChild(); }
  assert.equal((await running).code, 9);
  assert.ok(!(await fs.readdir(path.join(root, 'build/installer-builds'))).some(name => name.endsWith('.lock')));

  const source = path.join(fixture, 'publication-source');
  await writeArtifacts(source, 5);
  for (const failAt of ['copy', 'rename']) {
    const destination = path.join(fixture, `rollback-${failAt}`);
    await writeArtifacts(destination, 6);
    const originalDestination = await snapshot(destination);
    let injected = false;
    const io = { ...fs,
      async open(file, flags) {
        const handle = await fs.open(file, flags);
        if (failAt === 'copy' && file.includes('.blockmap.') && flags === 'wx' && !injected) {
          injected = true;
          await handle.writeFile('partial'); await handle.close();
          throw new Error('synthetic copy denied');
        }
        return handle;
      },
      async rename(from, to) {
        if (failAt === 'rename' && from.endsWith('.next') && to.endsWith('.blockmap') && !injected) { injected = true; throw new Error('synthetic rename denied'); }
        return fs.rename(from, to);
      },
    };
    await assert.rejects(publishInstallerArtifacts(source, destination, artifactNames, io, uncheckedFixture), /synthetic.*denied/);
    assert.equal(injected, true);
    assert.deepEqual(await snapshot(destination), originalDestination);
    assert.deepEqual((await fs.readdir(destination)).sort(), [...artifactNames].sort()); count++;
  }

  const successfulDestination = path.join(fixture, 'publication-order');
  const order = [];
  await publishInstallerArtifacts(source, successfulDestination, artifactNames, { ...fs, async rename(from, to) { order.push(path.basename(to)); return fs.rename(from, to); } }, uncheckedFixture);
  assert.deepEqual(order, artifactNames);
  assert.deepEqual(await snapshot(source), await snapshot(successfulDestination)); count++;

  await assert.rejects(runInstallerBuild({ ...options, args: ['--output-dir', root] }), /workspace or drive root/);
  await assert.rejects(runInstallerBuild({ ...options, args: ['--output-dir'] }), /explicit installer output/);
  await assert.rejects(publishInstallerArtifacts(source, path.join(fixture, 'unsafe'), ['../escape.exe'], fs, uncheckedFixture), /Unsafe publication/); count++;

  // Generated artifacts are re-created as new objects, never via CopyFile or a
  // move of the source. No source metadata or ACL is intentionally copied.
  const copied = path.join(fixture, 'byte-only.exe');
  await copyInstallerBytes(path.join(source, installer), copied, { ...fs, copyFile() { assert.fail('Must not copy source metadata'); } });
  assert.deepEqual(await fs.readFile(copied), await fs.readFile(path.join(source, installer)));
  await assert.rejects(copyInstallerBytes(path.join(source, installer), copied), { code: 'EEXIST' }); count++;

  assert.equal(await nearestExistingOutputDirectory(path.join(fixture, 'missing/child')), fixture);
  await assert.rejects(nearestExistingOutputDirectory(copied), /not a directory/); count++;
  let inspected = 0;
  for (const [processRid, fileRid] of [[4096, 8192], [8192, 4096], [8192, 0]]) {
    await assert.rejects(assertInstallerOutputIntegrity([output], { platform: 'win32', inspect: async paths => {
      inspected++; return { processIntegrityRid: processRid, files: paths.map(file => ({ path: file, integrityRid: fileRid })) };
    } }), { code: 'INSTALLER_OUTPUT_LOW_INTEGRITY' });
  }
  await assertInstallerOutputIntegrity([output], { platform: 'win32', inspect: async paths => ({ processIntegrityRid: 8192,
    files: paths.map(file => ({ path: file, integrityRid: 8192 })) }) });
  await assertInstallerOutputIntegrity([output], { platform: 'linux', inspect: () => assert.fail('Windows probe on non-Windows') });
  assert.equal(inspected, 3); count++;

  // Reject an unsafe output before launching native helpers. An unreadable
  // label is not interpreted as Medium or as a successful check.
  await assert.rejects(runInstallerBuild({ ...options, args: ['--output-dir', output],
    verifyOutput: async () => { throw new Error('synthetic integrity query denied'); },
    spawnProcess() { assert.fail('Unsafe output must fail before native build'); } }), /integrity query denied/); count++;
  const integrityDestination = path.join(fixture, 'integrity-rollback');
  await writeArtifacts(integrityDestination, 8);
  const originalIntegrityDestination = await snapshot(integrityDestination);
  let stagedInspection = false;
  await assert.rejects(publishInstallerArtifacts(source, integrityDestination, artifactNames, fs, async paths => {
    stagedInspection = true;
    assert.equal(paths[0], integrityDestination);
    assert.ok(paths.slice(1).every(file => file.endsWith('.next')));
    throw new Error('synthetic low output label');
  }), /low output label/);
  assert.equal(stagedInspection, true);
  assert.deepEqual(await snapshot(integrityDestination), originalIntegrityDestination);
  assert.deepEqual((await fs.readdir(integrityDestination)).sort(), [...artifactNames].sort()); count++;

  // The native query protocol is UTF-8 JSON, fails closed, and never weakens
  // PowerShell execution policy. Test malformed/partial responses offline.
  const inspectionInput = [path.resolve(output)];
  const validInspection = { processIntegrityRid: 8192, files: [{ path: inspectionInput[0], integrityRid: 8192 }] };
  const inspectionProcess = (response, code = 0) => (file, args, childOptions) => {
    assert.ok(file.endsWith('powershell.exe'));
    assert.ok(!args.some(arg => /bypass|executionpolicy/iu.test(arg)));
    assert.equal(childOptions.windowsHide, true);
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    let input = '';
    child.stdin = new Writable({ write(chunk, _encoding, done) { input += chunk; done(); } });
    child.stdin.once('finish', () => setImmediate(() => {
      assert.deepEqual(JSON.parse(input), inspectionInput);
      child.stdout.end(response); child.stderr.end(code ? 'synthetic label access denied' : ''); child.emit('close', code);
    }));
    child.kill = () => child.emit('close', 1);
    return child;
  };
  assert.deepEqual(await inspectWindowsIntegrity(inspectionInput, { spawnProcess: inspectionProcess(JSON.stringify(validInspection)) }), validInspection); count++;
  for (const response of ['{', '{}', JSON.stringify({ ...validInspection, files: [] }),
    JSON.stringify({ ...validInspection, files: [{ path: 'different', integrityRid: 8192 }] }),
    JSON.stringify({ ...validInspection, processIntegrityRid: '8192' })]) {
    await assert.rejects(inspectWindowsIntegrity(inspectionInput, { spawnProcess: inspectionProcess(response) }), /Cannot verify/); count++;
  }
  await assert.rejects(inspectWindowsIntegrity(inspectionInput, { spawnProcess: inspectionProcess(JSON.stringify(validInspection), 1) }), /access denied/); count++;
  await assert.rejects(inspectWindowsIntegrity(['relative']), /absolute output paths/); count++;
  assert.deepEqual({ TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR }, originalEnvironment);
  const manifest = JSON.parse(await fs.readFile(path.join(repository, 'package.json'), 'utf8'));
  assert.ok(manifest.scripts.dist.endsWith('node scripts/build-installer.mjs --publish never'));
  assert.equal(manifest.scripts['check:installer-build'], 'node scripts/check-installer-build.mjs');
  console.log(`PASS installer build: ${count} checks; native workspace isolation, metadata/header/SHA512/blockmap verification, output locking, failure retry, byte-only publication, Low-integrity rejection, pre-publication rollback, metadata-last publication, unchanged parent environment.`);
} finally {
  const realFixture = await fs.realpath(fixture);
  assert.equal(path.dirname(realFixture), build);
  assert.ok(path.basename(realFixture).startsWith('installer-build-check-'));
  await fs.rm(realFixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
