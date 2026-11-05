// Actual CLI fault scheduling: no production code or real user data is changed.
import fs from 'node:fs/promises';
import path from 'node:path';

const config = JSON.parse(await fs.readFile(process.argv[2], 'utf8')) as {
  source: string; output: string;
  fault: 'write' | 'sync' | 'close' | 'link' | 'unsupported' | 'cleanup' | 'crash-before' | 'crash-after';
};
const ownStage = (file: unknown) => typeof file === 'string'
  && path.dirname(file) === path.dirname(config.output) && path.basename(file).startsWith('.scene-pack-zip-');
function fail() { console.log(`ZIP_FAULT:${config.fault}`); return Object.assign(Error(`injected ZIP ${config.fault} failure`), { code: 'EIO' }); }
const open = fs.open.bind(fs), link = fs.link.bind(fs), unlink = fs.unlink.bind(fs);
fs.open = (async (...args: Parameters<typeof fs.open>) => {
  const handle = await open(...args);
  if (!ownStage(args[0]) || args[1] !== 'wx') return handle;
  if (config.fault === 'write') {
    const writeFile = handle.writeFile.bind(handle);
    handle.writeFile = async data => { await writeFile((data as Buffer).subarray(0, 64)); throw fail(); };
  } else if (config.fault === 'sync') handle.sync = async () => { throw fail(); };
  else if (config.fault === 'close') {
    const close = handle.close.bind(handle); let first = true;
    handle.close = async () => { await close(); if (first) { first = false; throw fail(); } };
  }
  return handle;
}) as typeof fs.open;
fs.link = async (from, to) => {
  if (!ownStage(from) || String(to) !== config.output) return link(from, to);
  if (config.fault === 'link') throw fail();
  if (config.fault === 'unsupported') throw Object.assign(fail(), { code: 'ENOTSUP' });
  if (config.fault === 'crash-before') { console.log(`ZIP_FAULT:${config.fault}`); process.exit(86); }
  await link(from, to);
  if (config.fault === 'crash-after') { console.log(`ZIP_FAULT:${config.fault}`); process.exit(86); }
};
fs.unlink = async file => {
  if (String(file) === config.output) throw Error('The CLI must never delete its official output');
  if (config.fault === 'cleanup' && ownStage(file)) throw fail();
  return unlink(file);
};
process.argv = [process.execPath, 'scripts/package-scene-interaction-pack.ts', config.source, config.output];
await import('../package-scene-interaction-pack');
