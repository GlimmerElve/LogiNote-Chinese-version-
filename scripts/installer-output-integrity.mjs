import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const probeSource = fileURLToPath(new URL('./windows-file-integrity.ps1', import.meta.url));

/** Read labels only. Do not change ACLs, integrity labels, or execution policy. */
export async function inspectWindowsIntegrity(paths, { spawnProcess = spawn, timeoutMs = 15_000 } = {}) {
  if (!Array.isArray(paths) || !paths.length || paths.some(file => typeof file !== 'string' || !path.isAbsolute(file))) {
    throw new Error('Integrity inspection requires absolute output paths');
  }
  const source = await fs.readFile(probeSource, 'utf8');
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const result = await new Promise((resolve, reject) => {
    const child = spawnProcess(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', source], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr = (stderr + value).slice(0, 8192); });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (timedOut || code !== 0) reject(new Error(`Cannot verify Windows installer output integrity: ${timedOut ? 'inspection timed out' : stderr.trim() || code}`));
      else {
        try { resolve(JSON.parse(stdout.replace(/^\uFEFF/u, '').trim())); }
        catch { reject(new Error('Cannot verify Windows installer output integrity: invalid inspection response')); }
      }
    });
    child.stdin.on('error', () => {}); // A spawn/inspection error is reported by the close handler.
    child.stdin.end(JSON.stringify(paths));
  });
  if (!Number.isInteger(result.processIntegrityRid) || !Array.isArray(result.files) || result.files.length !== paths.length
      || result.files.some((file, index) => file.path !== paths[index] || !Number.isInteger(file.integrityRid))) {
    throw new Error('Cannot verify Windows installer output integrity: incomplete inspection response');
  }
  return result;
}

export async function assertInstallerOutputIntegrity(paths, { platform = process.platform, inspect = inspectWindowsIntegrity } = {}) {
  if (platform !== 'win32') return;
  const result = await inspect(paths);
  if (result.processIntegrityRid < 8192 || result.files.some(file => file.integrityRid < 8192)) {
    const error = new Error('Installer output is Low/Untrusted integrity and cannot be safely delivered as a normal Windows installer. '
      + 'Run packaging in a normal PowerShell window and use an ordinary directory outside the sandboxed repository, '
      + 'for example: npm.cmd run dist -- --output-dir "D:\\LogiNoteBuildOutput". '
      + 'No permissions or security labels were changed.');
    error.code = 'INSTALLER_OUTPUT_LOW_INTEGRITY';
    throw error;
  }
}

export async function nearestExistingOutputDirectory(directory, io = fs) {
  let candidate = path.resolve(directory);
  for (;;) {
    try {
      if (!(await io.stat(candidate)).isDirectory()) throw new Error(`Installer output parent is not a directory: ${candidate}`);
      return candidate;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}
