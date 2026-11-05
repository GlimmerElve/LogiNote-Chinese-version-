const { build } = require('esbuild');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

(async () => {
  const root = path.resolve(__dirname, '..');
  const temp = await fs.mkdtemp(path.join(root, 'node_modules', '.cache', 'textbook-native-browser-'));
  try {
    const key = path.join(temp, 'fixture-key.pem'), cert = path.join(temp, 'fixture-cert.pem');
    await new Promise((resolve, reject) => {
      const openssl = spawn('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', key,
        '-out', cert, '-config', path.join(root, 'scripts', 'fixtures', 'textbook-tls.cnf')], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      let diagnostics = ''; openssl.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-2000); });
      openssl.once('error', reject); openssl.once('exit', code => code === 0 ? resolve() : reject(new Error('Synthetic TLS fixture creation failed: ' + diagnostics)));
    });
    const file = path.join(temp, 'check.cjs');
    await build({ entryPoints: [path.join(root, 'scripts', 'textbook-browser-native-check.ts')], outfile: file, bundle: true,
      platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent' });
    const runtime = require('electron');
    const code = await new Promise((resolve, reject) => {
      const env = { ...process.env, LOGINOTE_BROWSER_TEST_ROOT: root, LOGINOTE_BROWSER_TEST_STATE: path.join(temp, 'runtime'), LOGINOTE_BROWSER_TEST_KEY: key, LOGINOTE_BROWSER_TEST_CERT: cert };
      delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
      const child = spawn(runtime, [file, ...process.argv.slice(2)], { cwd: root, env, windowsHide: true, stdio: 'inherit' });
      const timer = setTimeout(() => { child.kill(); reject(new Error('Native textbook browser test timed out')); }, process.argv.includes('--live') ? 300000 : 90000);
      child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('exit', value => { clearTimeout(timer); resolve(value ?? 1); });
    });
    process.exitCode = code;
  } finally {
    if (!path.resolve(temp).startsWith(path.join(root, 'node_modules', '.cache') + path.sep)) throw new Error('Unsafe test cleanup path');
    await fs.rm(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
