import { spawnSync } from 'node:child_process';

const steps = [
  'lint',
  'check:ui-contracts',
  'check:profile',
  'check:memory',
  'check:rag-foundation',
  'check:agent',
  'check:agent-e2e',
  'check:scene',
  'check:atomic-write',
  'check:resource-browser',
  'check:document-parsers',
];

const results = [];
for (const script of steps) {
  const startedAt = Date.now();
  console.log(`\n[ui-refactor-ready] ${script}`);
  const command = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'npm';
  const args = process.platform === 'win32'
    ? ['/d', '/s', '/c', `npm.cmd run ${script}`]
    : ['run', script];
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });
  const passed = result.status === 0;
  results.push({ script, passed, durationMs: Date.now() - startedAt });
  if (!passed) break;
}

const gitStatus = spawnSync('git', ['status', '--porcelain'], {
  cwd: process.cwd(),
  encoding: 'utf8',
});
const dirtyEntries = gitStatus.status === 0
  ? gitStatus.stdout.split(/\r?\n/u).filter(Boolean).length
  : undefined;

console.log('\n[ui-refactor-ready] summary');
for (const result of results) {
  console.log(`${result.passed ? 'PASS' : 'FAIL'} ${result.script} (${result.durationMs} ms)`);
}
if (typeof dirtyEntries === 'number' && dirtyEntries > 0) {
  console.warn(`WARN working tree contains ${dirtyEntries} changed/untracked entries; preserve a recoverable baseline before UI replacement work.`);
}

const failed = results.find((result) => !result.passed);
if (failed) process.exit(1);
console.log('UI refactor behavioral baseline passed. Run `npm run build` and `npm run build:electron` as standalone build gates.');
