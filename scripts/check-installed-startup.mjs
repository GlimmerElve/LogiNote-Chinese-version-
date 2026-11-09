import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { assertInstallerOutputIntegrity } from './installer-output-integrity.mjs';

// Explicitly opt in to testing an already installed executable. Never run an
// installer, alter an existing profile, read the user's anchor, or call a model.
const [executableInput, parentInput] = process.argv.slice(2);
assert.ok(executableInput && parentInput, 'Usage: node scripts/check-installed-startup.mjs <installed.exe> <evidence-parent>');
const executable = await fs.realpath(executableInput);
assert.equal(path.basename(executable).toLowerCase(), 'loginote.exe');
await assertInstallerOutputIntegrity([executable]);
const parent = await fs.realpath(parentInput);
const root = await fs.mkdtemp(path.join(parent, 'installed-startup-'));
const profile = path.join(root, 'synthetic-home');
const dataRoot = path.join(root, 'synthetic-data');
const temporary = path.join(root, 'temporary');
const roaming = path.join(profile, 'AppData/Roaming');
const local = path.join(profile, 'AppData/Local');
for (const directory of [path.join(profile, '.logi-note'), dataRoot, temporary, roaming, local]) await fs.mkdir(directory, { recursive: true });
await fs.writeFile(path.join(profile, '.logi-note/storage-config.json'), JSON.stringify({ dataRoot }));
let chromium;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); }
catch {
  const moduleDirectory = process.env.LOGINOTE_PLAYWRIGHT_MODULES
    || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules');
  try { ({ chromium } = createRequire(path.join(moduleDirectory, 'package.json'))('playwright')); }
  catch { throw new Error('Installed startup acceptance requires a development Playwright runtime; set LOGINOTE_PLAYWRIGHT_MODULES to its node_modules directory. Packaging itself does not require it.'); }
}
const proof = { executable, root, dataRoot, launches: [], ok: false };
const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'COMSPEC', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE']
  .filter(name => process.env[name]).map(name => [name, process.env[name]]));
Object.assign(env, { USERPROFILE: profile, APPDATA: roaming, LOCALAPPDATA: local, TEMP: temporary, TMP: temporary, TMPDIR: temporary,
  ELECTRON_ENABLE_LOGGING: '1', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_DATASETS_OFFLINE: '1' });
const bounded = async (promise, message, ms = 30_000) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
  finally { clearTimeout(timer); }
};
// Verify this environment's home resolution before entering the packaged app.
const home = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['-e', 'process.stdout.write(require("node:os").homedir())'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', value => { output += value; });
  child.once('error', reject); child.once('close', code => code === 0 ? resolve(output) : reject(new Error('Synthetic home preflight failed')));
});
assert.equal(path.resolve(home), profile);
try {
  for (let attempt = 1; attempt <= 2; attempt++) {
    let log = '', browser, child;
    const pageErrors = [];
    const run = { attempt, loaded: false, pageErrors };
    proof.launches.push(run);
    try {
      child = spawn(executable, [`--user-data-dir=${dataRoot}`, '--remote-debugging-port=0', '--enable-logging=stderr'],
        { cwd: path.dirname(executable), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
      child.stdout.on('data', value => { log += value; }); child.stderr.on('data', value => { log += value; });
      let endpoint;
      for (let i = 0; i < 300; i++) {
        endpoint = log.match(/DevTools listening on (ws:\/\/[^\s]+)/u)?.[1];
        if (endpoint) break;
        if (child.exitCode !== null) throw new Error(`Installed executable exited before its renderer: ${child.exitCode}`);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.ok(endpoint, 'Installed executable did not expose a renderer within 30 seconds');
      browser = await chromium.connectOverCDP(endpoint);
      const context = browser.contexts()[0];
      await context.route(/^https?:\/\//u, route => {
        const hostname = new URL(route.request().url()).hostname;
        return ['127.0.0.1', 'localhost', '[::1]'].includes(hostname) ? route.continue() : route.abort();
      });
      const page = context.pages().find(candidate => candidate.url().includes('index.html')) || context.pages()[0] || await context.waitForEvent('page');
      page.on('pageerror', error => pageErrors.push(error.message));
      await page.waitForFunction(() => !!window.electronAPI?.storage?.getRoot && document.body.innerText.includes('学习'), undefined, { timeout: 45_000 });
      const storage = await page.evaluate(() => window.electronAPI.storage.getRoot());
      assert.equal(path.resolve(storage.root), dataRoot, 'Installed app must use only the synthetic data root');
      assert.equal(storage.custom, true);
      assert.ok(page.url().includes('app.asar') && page.url().includes('dist/index.html'), 'Must load the actual installed app.asar renderer');
      assert.deepEqual(pageErrors, [], 'Installed renderer must not throw uncaught errors');
      run.loaded = true; run.url = page.url(); run.dataRoot = storage.root;
      await page.evaluate(() => window.electronAPI.windowControls.close());
      const result = await bounded(exited, 'Installed app did not exit cleanly within 30 seconds');
      assert.equal(result.code, 0); run.exitCode = result.code;
      console.log(JSON.stringify({ attempt, loaded: true, isolatedData: true, exitCode: result.code }));
    } finally {
      await fs.writeFile(path.join(root, `launch-${attempt}.log`), log);
      await browser?.close().catch(() => {});
      // Only this owned acceptance process, never an application found by name.
      if (child && child.exitCode === null) child.kill();
    }
  }
  proof.ok = true;
  console.log(`PASS actual installed executable: two isolated launches, real preload/renderer/storage IPC, clean exit and restart. Evidence: ${root}`);
} finally { await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(proof, null, 2)); }
