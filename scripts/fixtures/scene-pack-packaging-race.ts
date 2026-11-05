// Deterministic offline scheduling fixture for the actual packaging CLI.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildScenePack, publishScenePackBuild } from '../build-scene-pack-example.mjs';

const config = JSON.parse(await fs.readFile(process.argv[2], 'utf8')) as {
  destination: string; source: string; originalSource: string; outputRoot: string; output: string;
  mode: 'replace' | 'roundtrip' | 'rollback' | 'unrelated' | 'last-read';
  emulateRenameableHandle?: boolean;
};
const readFile = fs.readFile.bind(fs);
// Windows prevents renaming a directory containing an open descendant. Also
// exercise the identity-check path used on systems that permit that rename.
// Only this fixture substitutes the anchor's OS lifetime; real builder/CLI,
// directory switches and final path/file-ID checks remain production code.
if (config.emulateRenameableHandle) {
  const open = fs.open.bind(fs);
  fs.open = (async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (String(args[0]) !== path.join(config.destination, 'main.js') || args[1] !== 'r') return handle;
    const identity = await handle.stat({ bigint: true }); await handle.close();
    return { stat: async () => identity, close: async () => {} };
  }) as typeof fs.open;
}
let scheduled = false;
fs.readFile = (async (...args: Parameters<typeof fs.readFile>) => {
  const bytes = await readFile(...args);
  const trigger = path.join(config.destination, config.mode === 'last-read' ? 'styles.css' : 'main.js');
  if (!scheduled && String(args[0]) === trigger) {
    scheduled = true;
    try { if (config.mode === 'rollback') {
      const manifest = JSON.parse(await readFile(path.join(config.destination, 'manifest.json'), 'utf8'));
      const entries = await fs.readdir(config.destination);
      const files = await Promise.all(entries.map(async name => [name, await readFile(path.join(config.destination, name))]));
      try {
        await publishScenePackBuild({ destination: config.destination, source: config.source, manifest, files,
          io: { ...fs, rename: async (from: string, to: string) => {
            if (path.basename(String(from)) === 'next') throw Error('expected fixture publication failure');
            return fs.rename(from, to);
          } } });
        throw Error('Rollback fixture did not fail');
      } catch (error) { if (!(error as Error).message.includes('expected fixture publication failure')) throw error; }
    } else {
      const outputRoot = config.mode === 'unrelated' ? path.join(config.outputRoot, 'unrelated') : config.outputRoot;
      await promisify(execFile)(process.execPath, ['scripts/build-scene-pack-example.mjs', '--source', config.source, '--out', outputRoot], { windowsHide: true });
      if (config.mode === 'roundtrip') await buildScenePack({ sourceDir: config.originalSource, outputRoot });
    } } catch (error) {
      if (process.platform !== 'win32' || config.emulateRenameableHandle
        || !/EPERM|EBUSY/.test((error as Error).message)) throw error;
      console.log('RACE_BLOCKED_BY_OPEN_HANDLE');
    }
    console.log(`RACE_SCHEDULED:${config.mode}`);
  }
  return bytes;
}) as typeof fs.readFile;
process.argv = [process.execPath, 'scripts/package-scene-interaction-pack.ts', config.destination, config.output];
await import('../package-scene-interaction-pack');
if (!scheduled) throw Error('Packaging race fixture did not reach its scheduling point');
