import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { build as bundle } from 'esbuild';
import { build as viteBuild } from 'vite';
import { buildPromptLabPack } from './build-scene-interaction-pack.mjs';
import { s2PackClientBuildConfig } from './vite-s2-pack-client.config';

const root = process.cwd(), require = createRequire(import.meta.url);
const output = path.resolve(root, 'output/scene-pack-client-acceptance');
await fs.mkdir(output, { recursive: true });
const runRoot = await fs.mkdtemp(path.join(output, 'run-'));
const seed = path.join(runRoot, 'seed'), buildRoot = path.join(runRoot, 'client');
await fs.mkdir(buildRoot, { recursive: true });
await buildPromptLabPack(path.join(seed, 'prompt-lab/0.1.0'));
const arithmetic = await bundle({ entryPoints: ['scripts/fixtures/s2-arithmetic-pack.ts'], bundle: true, write: false,
  format: 'esm', platform: 'browser', target: 'es2022' });
const arithmeticModule = await import('data:text/javascript;base64,' + Buffer.from(arithmetic.outputFiles[0].contents).toString('base64'));
const arithmeticPack = arithmeticModule.activate({ editor: {}, ui: { react: {} } });
const arithmeticDir = path.join(seed, 'arithmetic-lab/1.0.0');
await fs.mkdir(arithmeticDir, { recursive: true });
for (const [name, content] of Object.entries({ 'manifest.json': JSON.stringify(arithmeticPack.manifest),
  'agent.json': JSON.stringify(arithmeticPack.describe()), 'main.js': arithmetic.outputFiles[0].contents, 'styles.css': '' }))
  await fs.writeFile(path.join(arithmeticDir, name), content);
const modules = new Set<string>();
await viteBuild({ ...s2PackClientBuildConfig(path.join(buildRoot, 'ui'), id => modules.add(id)), configFile: false, logLevel: 'error' });
for (const [entry, outfile] of [['src/electron/preload.ts', 'preload.cjs'], ['scripts/scene-pack-native-client.ts', 'main.cjs']])
  await bundle({ entryPoints: [entry], outfile: path.join(buildRoot, outfile), bundle: true, platform: 'node',
    format: 'cjs', external: ['electron'], logLevel: 'silent' });
const state = path.join(runRoot, 'terminal-a');
await fs.mkdir(state, { recursive: true });
const native = require('electron');
const run = (scenario: string, stateRoot = state, useSeed = true) => new Promise<void>((resolve, reject) => {
  const env: NodeJS.ProcessEnv = { ...process.env, LOGINOTE_PACK_NATIVE_STATE: stateRoot, LOGINOTE_PACK_NATIVE_BUILD: buildRoot,
    LOGINOTE_PACK_NATIVE_PROOF: path.join(runRoot, scenario), LOGINOTE_PACK_NATIVE_SEED: useSeed ? seed : '',
    LOGINOTE_PACK_NATIVE_CASE: scenario };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const child = spawn(native, [path.join(buildRoot, 'main.cjs')], { cwd: root, env, windowsHide: scenario !== 'inspect', stdio: 'inherit' });
  const timer = scenario === 'inspect' ? undefined : setTimeout(() => { child.kill(); reject(new Error('Native client timed out: ' + scenario)); }, 90000);
  child.once('error', error => { clearTimeout(timer); reject(error); });
  child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Native client ${scenario} exited ${code}`)); });
});
const partialState = path.join(runRoot, 'partial-restart'), refreshState = path.join(runRoot, 'partial-refresh');
await fs.mkdir(partialState); await fs.mkdir(refreshState);
await run('partial-seed-failed', partialState);
const receiptState = path.join(runRoot, 'receipt-retry'), unmanagedState = path.join(runRoot, 'unmanaged-restart');
await fs.mkdir(receiptState); await fs.mkdir(unmanagedState);
await fs.cp(path.join(partialState, 'scene-interaction-packs'), path.join(receiptState, 'scene-interaction-packs'), { recursive: true });
const receiptDeleted = path.join(receiptState, 'scene-interaction-packs/arithmetic-lab/1.0.0'), receiptParked = path.join(runRoot, 'user-removed-receipted-version');
for (const target of [receiptDeleted, receiptParked]) assert(target.startsWith(runRoot + path.sep));
await fs.rename(receiptDeleted, receiptParked);
await run('receipt-retry', receiptState);
await fs.mkdir(path.join(unmanagedState, 'scene-interaction-packs/prompt-lab'), { recursive: true });
await fs.cp(path.join(seed, 'prompt-lab/0.1.0'), path.join(unmanagedState, 'scene-interaction-packs/prompt-lab/0.1.0'), { recursive: true });
await run('unmanaged-partial', unmanagedState);
const unmanagedDeleted = path.join(unmanagedState, 'scene-interaction-packs/prompt-lab/0.1.0'), unmanagedParked = path.join(runRoot, 'user-removed-unmanaged-version');
for (const target of [unmanagedDeleted, unmanagedParked]) assert(target.startsWith(runRoot + path.sep));
await fs.rename(unmanagedDeleted, unmanagedParked);
await run('unmanaged-restarted', unmanagedState);
const healthyFile = path.join(partialState, 'scene-interaction-packs/arithmetic-lab/1.0.0/main.js');
const healthyBefore = await fs.readFile(healthyFile);
await run('partial-seed-restarted', partialState);
assert.deepEqual(await fs.readFile(healthyFile), healthyBefore, 'Restart recovery cannot replace a healthy exact version');
await run('partial-seed-refresh', refreshState);
await run('initialization-retry');
await run('installed');
const sceneDirectory = path.join(state, 'vault/scene-skills/scenes');
const fingerprint = async () => {
  const files = (await fs.readdir(sceneDirectory)).sort();
  return Promise.all(files.map(async file => [file, createHash('sha256').update(await fs.readFile(path.join(sceneDirectory, file))).digest('hex')]));
};
const before = await fingerprint();
const installed = path.resolve(state, 'scene-interaction-packs/prompt-lab'), parked = path.join(runRoot, 'removed-prompt-lab');
for (const target of [installed, parked]) assert(target.startsWith(runRoot + path.sep), 'All move targets stay in this isolated run');
await fs.rename(installed, parked);
try {
  await run('missing');
  assert.deepEqual(await fingerprint(), before, 'Removing a package cannot modify any saved scene bytes');
} finally { await fs.rename(parked, installed); }
const manifestFile = path.join(installed, '0.1.0/manifest.json');
const originalManifest = await fs.readFile(manifestFile, 'utf8');
try {
  await fs.writeFile(manifestFile, JSON.stringify({ ...JSON.parse(originalManifest), version: '0.2.0' }));
  await run('wrong-version');
  assert.deepEqual(await fingerprint(), before, 'A mismatched package cannot modify saved scene bytes');
} finally { await fs.writeFile(manifestFile, originalManifest); }
await run('restored');
const second = path.join(runRoot, 'terminal-b');
await fs.mkdir(second, { recursive: true });
await fs.cp(path.join(state, 'scene-interaction-packs'), path.join(second, 'scene-interaction-packs'), { recursive: true });
await fs.cp(path.join(state, 'vault'), path.join(second, 'vault'), { recursive: true });
await run('second-terminal', second, false);
const cases = await Promise.all(['partial-seed-failed', 'receipt-retry', 'unmanaged-partial', 'unmanaged-restarted', 'partial-seed-restarted', 'partial-seed-refresh', 'initialization-retry', 'installed', 'missing', 'wrong-version', 'restored', 'second-terminal']
  .map(async name => JSON.parse(await fs.readFile(path.join(runRoot, name, 'report.json'), 'utf8'))));
const report = { runRoot, auditedRendererModules: modules.size, cases, retainedSyntheticDataOnly: true,
  fullInstalledApplicationTested: false, liveModelCalls: 0 };
await fs.writeFile(path.join(runRoot, 'report.json'), JSON.stringify(report, null, 2));
await fs.writeFile(path.join(output, 'latest.json'), JSON.stringify(report, null, 2));
console.log('Native S2 interaction package acceptance passed. Evidence: ' + path.join(runRoot, 'report.json'));
if (process.argv.includes('--inspect')) await run('inspect');
