import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { zipSync, strToU8 } from 'fflate';
const require = createRequire(import.meta.url), root = await fs.mkdtemp(path.join(os.tmpdir(), 'loginote-s2-update-'));
try {
  const source = await build({ entryPoints: ['scripts/fixtures/s2-arithmetic-pack.ts'], bundle: true, format: 'esm', platform: 'browser', write: false });
  const original = source.outputFiles[0].text;
  const module = await import('data:text/javascript;base64,' + Buffer.from(original).toString('base64'));
  const pack = module.activate({ ui: { react: {} } });
  const sharedBundle = await build({ entryPoints: ['src/services/scene/sceneS2PluginRegistry.ts'], bundle: true, format: 'esm', platform: 'node', write: false });
  const { S2_JSON_CHECK_PLUGIN } = await import('data:text/javascript;base64,' + Buffer.from(sharedBundle.outputFiles[0].contents).toString('base64'));
  for (const version of ['1.0.0', '2.0.0']) {
    let code = version === '1.0.0' ? original.replace('async executeLocal(call, inputs) {', 'async executeLocal(call, inputs) { await new Promise(r=>globalThis.__oldRelease=r);')
      : original.replace('version: "1.0.0"', 'version: "2.0.0"').replace('String(a + b)', 'String(a + b + 100)');
    if (version === '2.0.0') code = code.replace(/export \{[\s\S]*\};\s*$/, '') + `\nfunction hotActivate(services){const pack=activate(services);pack.capabilities.push(${JSON.stringify(S2_JSON_CHECK_PLUGIN)});return pack;}export {hotActivate as activate,arithmeticConfig};`;
    const color = version === '1.0.0' ? 'green' : 'purple';
    const bytes = zipSync({ 'manifest.json': strToU8(JSON.stringify({ ...pack.manifest, version })), 'main.js': strToU8(code),
      'agent.json': strToU8(JSON.stringify(pack.describe())), 'styles.css': strToU8(`@keyframes pulse{from{color:${color}}to{color:${color}}}.update-style-probe{animation:pulse 10s linear infinite}`) });
    await fs.writeFile(path.join(root, version === '1.0.0' ? 'v1.zip' : 'v2.zip'), bytes);
  }
  const scene = JSON.stringify({ interactionPack: { id: 'arithmetic-lab', version: '1.0.0' }, progress: { answer: 'unchanged' } });
  await fs.writeFile(path.join(root, 'existing-scene.json'), scene); await fs.writeFile(path.join(root, 'expected-scene.json'), scene);
  await build({ entryPoints: ['scripts/fixtures/s2-update-client.tsx'], bundle: true, platform: 'browser', format: 'esm', conditions: ['style'], outfile: path.join(root, 'client.js'), loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl', '.png': 'dataurl', '.svg': 'dataurl', '.jpg': 'dataurl', '.mp3': 'dataurl' } });
  await fs.writeFile(path.join(root, 'client.html'), '<!doctype html><html><meta charset="utf-8"><link rel="stylesheet" href="client.css"><div id="app" style="height:820px;padding:24px"></div><script type="module" src="client.js"></script></html>');
  for (const [entry, outfile] of [['src/electron/preload.ts', 'preload.cjs'], ['scripts/check-scene-pack-update-native.ts', 'main.cjs']])
    await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: path.join(root, outfile) });
  const env = { ...process.env, LOGINOTE_S2_UPDATE_TEST_ROOT: root }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [path.join(root, 'main.cjs')], { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => { console.error('S2 update test timeout'); child.kill(); }, 60000);
  try { process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)); }); }
  finally { clearTimeout(timer); }
} finally {
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('loginote-s2-update-')) throw Error('invalid test root');
  await fs.rm(root, { recursive: true, force: true });
}
