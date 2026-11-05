import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { prepareElectronRuntime } from './start-electron.mjs';
await mkdir('build', { recursive: true });
const folder = await mkdtemp(path.resolve('build/interactive-figure-test-'));
const entry = path.join(folder, 'main.cjs');
await build({ entryPoints: ['scripts/check-interactive-figure-native.ts'], outfile: entry, bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'katex'] });
const env = { ...process.env, LOGINOTE_FIGURE_TEST_ROOT: folder }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
// Optional same-version local runtime keeps this isolated check usable when
// node_modules/electron/dist is incomplete; production startup is unchanged.
if (process.env.LOGINOTE_TEST_ELECTRON_PATH) {
  const expected = JSON.parse(await readFile('node_modules/electron/package.json', 'utf8')).version;
  const actual = (await readFile(path.join(path.dirname(process.env.LOGINOTE_TEST_ELECTRON_PATH), 'version'), 'utf8')).trim();
  if (actual !== expected) throw Error(`test runtime version mismatch: ${actual} != ${expected}`);
}
const executable = await prepareElectronRuntime(process.env.LOGINOTE_TEST_ELECTRON_PATH ? { executable: process.env.LOGINOTE_TEST_ELECTRON_PATH } : {});
const child = spawn(executable, ['--no-sandbox', entry], { env, windowsHide: true, stdio: 'inherit' });
const timer = setTimeout(() => child.kill(), 45000);
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
clearTimeout(timer);
if (code !== 0) throw Error(`interactive figure native test exited ${code}`);
