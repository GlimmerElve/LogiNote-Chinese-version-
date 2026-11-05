import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
const require = createRequire(import.meta.url);
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'loginote-h5p-runner-'));
try {
  const outfile = path.join(directory, 'check.cjs');
  await build({ entryPoints: ['scripts/check-h5p-native.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], outfile });
  await build({ entryPoints: ['scripts/fixtures/h5p-library-preview.tsx'], bundle: true, platform: 'browser', format: 'iife', outfile: path.join(directory, 'ui.js') });
  const ui = path.join(directory, 'ui.html');
  await fs.writeFile(ui, '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="ui.css"><style>body{margin:0;padding:24px;background:var(--ln-bg-app);box-sizing:border-box}*{box-sizing:border-box}</style><div id="app"></div><script src="ui.js"></script></html>');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  env.LOGINOTE_H5P_UI_FILE = ui;
  const child = spawn(require('electron'), [outfile], { env, stdio: 'inherit', windowsHide: true });
  const timeout = setTimeout(() => { console.error('Native H5P child startup timed out'); child.kill(); }, 60000);
  try { process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)); }); }
  finally { clearTimeout(timeout); }
} finally {
  if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('loginote-h5p-runner-')) throw new Error('invalid temp directory');
  await fs.rm(directory, { recursive: true, force: true });
}
