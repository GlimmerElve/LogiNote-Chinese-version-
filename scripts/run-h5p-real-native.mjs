import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
const require = createRequire(import.meta.url);
const fixtures = path.resolve(process.argv[2] || '.ui-preview/h5p-real');
const output = path.resolve('.ui-preview/h5p-real/acceptance');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'loginote-h5p-real-runner-'));
try {
  await fs.mkdir(output, { recursive: true });
  const outfile = path.join(directory, 'check.cjs'), root = path.join(directory, 'data');
  await fs.mkdir(root);
  await build({ entryPoints: ['scripts/check-h5p-real-native.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], outfile });
  for (const phase of ['prepare', 'restore']) {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    Object.assign(env, { LOGINOTE_H5P_REAL_ROOT: root, LOGINOTE_H5P_REAL_FIXTURES: fixtures, LOGINOTE_H5P_REAL_OUTPUT: output, LOGINOTE_H5P_REAL_PHASE: phase });
    const child = spawn(require('electron'), [outfile], { env, stdio: 'inherit', windowsHide: true });
    const timeout = setTimeout(() => { console.error('Real H5P child deadline'); child.kill(); }, 75000);
    let code;
    try { code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', value => resolve(value ?? 1)); }); }
    finally { clearTimeout(timeout); }
    if (code !== 0) { process.exitCode = code; break; }
  }
} finally {
  if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('loginote-h5p-real-runner-')) throw Error('invalid isolated directory');
  await fs.rm(directory, { recursive: true, force: true });
}
