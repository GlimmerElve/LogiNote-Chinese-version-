const { existsSync, rmSync } = require('fs');
const { resolve } = require('path');
const { spawnSync } = require('child_process');

const root = resolve(__dirname, '..');
const workDir = 'release\\sympy_build';
const distDir = 'release\\sympy_dist\\sympy_server';
const output = resolve(root, distDir, 'sympy_server.exe');

if (!existsSync(resolve(root, 'python', 'sympy_server.py'))) {
  console.error('[build-sympy] python/sympy_server.py was not found.');
  process.exit(1);
}

rmSync(resolve(root, distDir), { recursive: true, force: true });

const args = [
  '--noconfirm',
  '--clean',
  '--onefile',
  '--name', 'sympy_server',
  '--distpath', distDir,
  '--workpath', workDir,
  '--specpath', workDir,
  '--hidden-import', 'sympy',
  '--hidden-import', 'antlr4',
  ...[
    'numpy', 'scipy', 'matplotlib', 'IPython', 'pytest', 'sphinx',
    'pandas', 'torch', 'torchaudio', 'onnxruntime', 'tensorflow',
    'dask', 'distributed', 'PyQt5', 'tkinter', 'notebook',
    'jupyterlab', 'bokeh',
  ].flatMap((name) => ['--exclude-module', name]),
  '--console',
  'python\\sympy_server.py',
];

console.log(`[build-sympy] Project root: ${root}`);
console.log('[build-sympy] Building one-file executable...');

const command = process.platform === 'win32' ? 'pyinstaller.exe' : 'pyinstaller';
const result = spawnSync(command, args, {
  cwd: root,
  encoding: 'utf8',
  windowsHide: true,
  detached: process.platform === 'win32',
  maxBuffer: 16 * 1024 * 1024,
  env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
});

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);

if (result.error) {
  console.error(`[build-sympy] Failed to start PyInstaller: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`[build-sympy] PyInstaller failed with exit code ${result.status}.`);
  process.exit(result.status || 1);
}
if (!existsSync(output)) {
  console.error('[build-sympy] Build failed: sympy_server.exe was not created.');
  process.exit(1);
}

console.log(`[build-sympy] Built: ${output}`);
