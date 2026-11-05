import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { publishScenePackBuild } from './build-scene-pack-example.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function buildPromptLabPack(destination = path.join(root, 'output/scene-interaction-packs/prompt-lab/0.1.0')) {
  const packageRoot = path.join(root, 'src/interaction-packs/prompt-lab');
  const result = await build({ entryPoints: [path.join(packageRoot, 'entry.ts')], bundle: true, write: false,
    format: 'esm', platform: 'browser', target: 'es2022', jsx: 'transform', tsconfigRaw: { compilerOptions: { jsx: 'react' } }, metafile: true,
    plugins: [{ name: 'terminal-react-peer', setup(api) { api.onResolve({ filter: /^react$/ }, () => ({ path: path.join(packageRoot, 'reactBridge.ts') })); } }],
  });
  const forbidden = Object.keys(result.metafile.inputs).filter(file => {
    const absolute = path.resolve(root, file);
    return !absolute.startsWith(packageRoot + path.sep);
  });
  if (forbidden.length) throw new Error(`交互包包含宿主运行代码：${forbidden.join(', ')}`);
  // Read metadata from an in-memory build of the pure entry, without loading any terminal state.
  const metadata = await build({ entryPoints: [path.join(packageRoot, 'index.ts')], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' });
  const { default: pack } = await import('data:text/javascript;base64,' + Buffer.from(metadata.outputFiles[0].contents).toString('base64'));
  const css = await fs.readFile(path.join(packageRoot, 'styles.css'), 'utf8');
  // Every supported writer must publish whole generations. In-place writes
  // would bypass the packager's pinned-generation identity check.
  await publishScenePackBuild({ destination, source: await fs.realpath(packageRoot), manifest: pack.manifest, files: [
    ['main.js', result.outputFiles[0].contents], ['manifest.json', JSON.stringify(pack.manifest, null, 2)],
    ['agent.json', JSON.stringify(pack.describe(), null, 2)], ['styles.css', css],
    ['package.json', JSON.stringify({ private: true, type: 'module' })],
  ] });
  return { destination, bytes: result.outputFiles[0].contents.length, modules: Object.keys(result.metafile.inputs).length };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(await buildPromptLabPack());
}
