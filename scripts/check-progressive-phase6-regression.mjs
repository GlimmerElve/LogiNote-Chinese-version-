/** Serial native checks avoid competing desktop/ONNX workloads and keep every
 * test in its existing disposable library. No live model or community publish. */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = await fsp.mkdtemp(path.resolve('build/progressive-phase6-regression-'));
const ts = name => ['scripts/run-tsx-safe.cjs', `scripts/${name}.ts`];
const native = name => ['--experimental-strip-types', `scripts/${name}.mjs`];
const checks = [
  ...['check-progressive-phase1', 'check-progressive-phase1-runtime', 'check-progressive-phase1-stop-retry',
    'check-progressive-phase2', 'check-progressive-phase3', 'check-progressive-phase4', 'check-progressive-phase5',
    'check-application-shutdown', 'check-flow-exit-navigation', 'check-mermaid-process-client',
    'check-plan-write', 'check-resource-download-batch', 'check-resource-auto-download'].map(name => ({ name, args: ts(name) })),
  ...[1, 2, 3, 4, 5].map(phase => ({ name: `check-progressive-phase${phase}-native`, args: native(`check-progressive-phase${phase}-native`) })),
  { name: 'check-progressive-malformed-native', args: native('check-progressive-phase1-native'), env: { PROGRESSIVE_NATIVE_TARGET: 'malformed' } },
  { name: 'check-flow-legacy-performance-native', args: native('check-flow-legacy-performance-native'), env: { FLOW_LEGACY_STALL: '1', FLOW_LEGACY_RETAIN_EDITOR: '1' } },
];
const only = process.argv.find(value => value.startsWith('--only='))?.slice(7).split(',');
const selected = only ? checks.filter(check => only.includes(check.name)) : checks;
if (!selected.length || only?.some(name => !checks.some(check => check.name === name))) throw Error('Unknown or empty regression selection');
const results = [];
console.log(JSON.stringify({ root, checks: selected.length, version: JSON.parse(await fsp.readFile('package.json', 'utf8')).version }));
for (const check of selected) {
  const log = path.join(root, `${check.name}.log`), fd = fs.openSync(log, 'w'), started = Date.now();
  const env = { ...process.env, ...check.env };
  delete env.PHASE5_VISUAL_CHECK;
  delete env.FLOW_LEGACY_VAULT;
  delete env.FLOW_LEGACY_NOTE_ID;
  if (!check.env?.PROGRESSIVE_NATIVE_TARGET) delete env.PROGRESSIVE_NATIVE_TARGET;
  const child = spawn(process.execPath, check.args, { env, windowsHide: true, stdio: ['ignore', fd, fd] });
  let timedOut = false;
  const deadline = setTimeout(() => { timedOut = true; child.kill(); }, 600000);
  const result = await new Promise(resolve => {
    child.once('error', error => resolve({ code: null, error: error.message }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(deadline); fs.closeSync(fd);
  results.push({ name: check.name, ...result, timedOut, ms: Date.now() - started, log });
  console.log(JSON.stringify(results.at(-1)));
  await fsp.writeFile(path.join(root, 'result.json'), JSON.stringify({ root, status: results.every(item => item.code === 0) ? 'passed' : 'failed', complete: results.length === selected.length, results }, null, 2));
}
if (results.some(item => item.code !== 0 || item.timedOut)) process.exitCode = 1;
