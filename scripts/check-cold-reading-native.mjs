import { spawn } from 'node:child_process';
const env = { ...process.env, FLOW_LEGACY_COLD: '1', FLOW_LEGACY_WHEEL: '1' };
for (const key of ['FLOW_LEGACY_VAULT', 'FLOW_LEGACY_NOTE_ID', 'FLOW_LEGACY_ASSET_ROOT', 'FLOW_LEGACY_PREVIEW', 'FLOW_LEGACY_RETAIN_EDITOR']) delete env[key];
const child = spawn(process.execPath, ['--experimental-strip-types', 'scripts/check-flow-legacy-performance-native.mjs'], { env, windowsHide: true, stdio: 'inherit' });
process.exitCode = await new Promise(resolve => { child.once('error', error => { console.error(error); resolve(1); }); child.once('exit', code => resolve(code ?? 1)); });
