import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { build as bundle } from 'esbuild';
import { build as viteBuild } from 'vite';
import { compileElectron } from './build-electron.mjs';
import { buildPromptLabPack } from './build-scene-interaction-pack.mjs';

// This smoke deliberately boots the production App and production Electron main,
// rather than a feature fixture. It never reads the user's actual vault or anchor.
const root = process.cwd(), require = createRequire(import.meta.url);
const output = path.resolve(root, 'output/scene-pack-app-acceptance');
await fs.mkdir(output, { recursive: true });
const reuse = process.argv.indexOf('--reuse');
const reusedRun = reuse >= 0 ? path.resolve(process.argv[reuse + 1]) : undefined;
if (reusedRun) assert(path.dirname(reusedRun) === output && path.basename(reusedRun).startsWith('run-'));
const runRoot = await fs.mkdtemp(path.join(output, 'run-'));
assert(path.dirname(runRoot) === output && path.basename(runRoot).startsWith('run-'), 'Test runs stay inside the isolated acceptance directory');
const appRoot = path.join(runRoot, 'app'), stateRoot = path.join(runRoot, 'terminal');
await fs.mkdir(path.join(appRoot, 'dist-electron'), { recursive: true });
await fs.mkdir(stateRoot, { recursive: true });
if (reusedRun) {
  // Reuse immutable build outputs while always creating fresh synthetic state.
  await fs.cp(path.join(reusedRun, 'app'), appRoot, { recursive: true });
} else {
  await viteBuild({ configFile: path.join(root, 'vite.config.ts'), logLevel: 'error',
    build: { outDir: path.join(appRoot, 'dist'), emptyOutDir: true } });
  const compiled = await compileElectron(root);
  for (const [name, contents] of compiled) await fs.writeFile(path.join(appRoot, 'dist-electron', name), contents);
  await fs.writeFile(path.join(appRoot, 'package.json'), JSON.stringify({ name: 'loginote-isolated-app-acceptance', version: '1.0.9', main: 'wrapper.cjs' }));
}
await buildPromptLabPack(path.join(stateRoot, 'scene-interaction-packs/prompt-lab/0.1.0'));
await fs.writeFile(path.join(stateRoot, 'scene-interaction-packs/.initialized'), 'isolated full-app test; no first-run reseeding');
await bundle({ entryPoints: ['scripts/scene-pack-app-client.ts'], outfile: path.join(appRoot, 'wrapper.cjs'), bundle: true,
  platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' });
console.log('ISOLATED_APP_RUN_ROOT ' + runRoot);
const run = (scenario: string) => new Promise<void>((resolve, reject) => {
  const env: NodeJS.ProcessEnv = { ...process.env, LOGINOTE_PACK_APP_ROOT: appRoot, LOGINOTE_PACK_APP_STATE: stateRoot,
    LOGINOTE_PACK_APP_PROOF: path.join(runRoot, scenario), LOGINOTE_PACK_APP_CASE: scenario,
    LOGINOTE_COMMUNITY_API_URL: '', LOGINOTE_COMMUNITY_WEB_ORIGIN: '' };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const child = spawn(require('electron'), [appRoot], { cwd: root, env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => { child.kill(); reject(Error('Full application timed out: ' + scenario)); }, 120000);
  child.once('error', error => { clearTimeout(timer); reject(error); });
  child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(Error(`Full application ${scenario} exited ${code}`)); });
});
await run('installed');
const sceneDirectory = path.join(stateRoot, 'vault/scene-skills/scenes');
const fingerprint = async () => Promise.all((await fs.readdir(sceneDirectory)).sort().map(async file =>
  [file, createHash('sha256').update(await fs.readFile(path.join(sceneDirectory, file))).digest('hex')]));
const before = await fingerprint();
const installed = path.join(stateRoot, 'scene-interaction-packs/prompt-lab'), parked = path.join(runRoot, 'removed-prompt-lab');
for (const target of [installed, parked]) assert(target.startsWith(runRoot + path.sep));
await fs.rename(installed, parked);
try { await run('missing'); assert.deepEqual(await fingerprint(), before, 'Opening a missing pack must leave saved scene bytes unchanged'); }
finally { await fs.rename(parked, installed); }
await run('restored');
const cases = await Promise.all(['installed', 'missing', 'restored'].map(async scenario => JSON.parse(await fs.readFile(path.join(runRoot, scenario, 'report.json'), 'utf8'))));
const report = { runRoot, cases, productionAppAndMain: true, packagedInstallerTested: false, liveModelCalls: 0,
  scope: 'Production main/preload/renderer, actual App → LearnHub → SceneBuilderPanel → S2 → save/export/reopen; isolated data and home; unrelated local services and network disabled in test wrapper.' };
await fs.writeFile(path.join(runRoot, 'report.json'), JSON.stringify(report, null, 2));
await fs.writeFile(path.join(output, 'latest.json'), JSON.stringify(report, null, 2));
console.log('Production App scene package acceptance passed: ' + path.join(runRoot, 'report.json'));
