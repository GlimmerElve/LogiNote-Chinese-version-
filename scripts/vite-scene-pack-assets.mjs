import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

let protocolReaders;
function readers() {
  // Reuse the terminal's pure TypeScript readers without duplicating protocol rules
  // or importing any package implementation into Vite's renderer graph.
  if (!protocolReaders) protocolReaders = (async () => {
    const codeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const compiled = await build({ stdin: { resolveDir: codeRoot, loader: 'ts', contents:
      "export { readSceneInteractionPackManifest } from './src/services/scene/sceneInteractionPackManifest';\nexport { verifyScenePackMaterialBytes } from './src/services/scene/sceneInteractionPackMaterialProtocol';" },
      bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', logLevel: 'silent' });
    return import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].contents).toString('base64'));
  })();
  return protocolReaders;
}

async function readMaterial(folder, descriptor) {
  const expected = path.resolve(folder), realFolder = await fs.realpath(expected);
  if (path.relative(expected, realFolder) !== '') throw new Error('PACK_MATERIAL_SCOPE: Package version folder cannot alias another directory');
  const realFile = await fs.realpath(path.join(realFolder, descriptor.path)), relative = path.relative(realFolder, realFile);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
    throw new Error('PACK_MATERIAL_SCOPE: Material must stay in its exact package version');
  const handle = await fs.open(realFile, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 1048576) throw new Error('PACK_MATERIAL_LIMIT: Material must be a bounded complete file');
    const buffer = Buffer.alloc(Math.min(descriptor.bytes, 1048576) + 1); let count = 0;
    while (count < buffer.length) {
      const result = await handle.read(buffer, count, buffer.length - count, count);
      if (!result.bytesRead) break;
      count += result.bytesRead;
    }
    const bytes = buffer.subarray(0, count);
    await (await readers()).verifyScenePackMaterialBytes(descriptor, bytes); return bytes;
  } finally { await handle.close(); }
}

/** Package files are separate assets, never imports in the renderer module graph. */
export function scenePackAssetsPlugin(root) {
  const source = path.join(root, 'output/scene-interaction-packs');
  const inventory = async () => {
    const assets = new Map(), mediaTypes = new Map(), manifests = [], protocol = await readers();
    for (const id of await fs.readdir(source).catch(() => [])) {
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) continue;
      for (const version of await fs.readdir(path.join(source, id)).catch(() => [])) {
        if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) continue;
        const folder = path.join(source, id, version);
        const manifest = protocol.readSceneInteractionPackManifest(JSON.parse(await fs.readFile(path.join(folder, 'manifest.json'), 'utf8')));
        if (manifest.id !== id || manifest.version !== version) throw new Error('Package asset identity mismatch');
        manifests.push(manifest);
        for (const file of ['manifest.json', 'main.js', 'styles.css', 'agent.json'])
          assets.set(`${id}/${version}/${file}`, await fs.readFile(path.join(folder, file)));
        if (manifest.protocolVersion === 2) for (const material of manifest.materials) {
          const file = `${id}/${version}/${material.path}`;
          assets.set(file, await readMaterial(folder, material)); mediaTypes.set(file, material.mediaType);
        }
      }
    }
    assets.set('index.json', Buffer.from(JSON.stringify(manifests)));
    return { assets, mediaTypes };
  };
  return {
    name: 'independent-scene-pack-assets',
    async generateBundle() {
      for (const [file, bytes] of (await inventory()).assets) this.emitFile({ type: 'asset', fileName: 'scene-interaction-packs/' + file, source: bytes });
    },
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const prefix = '/scene-interaction-packs/', route = request.url?.split('?')[0];
        if (!route?.startsWith(prefix)) return next();
        if (!['GET', 'HEAD'].includes(request.method || '')) { response.statusCode = 405; response.end(); return; }
        try {
          const file = route.slice(prefix.length), { assets, mediaTypes } = await inventory(), bytes = assets.get(file);
          if (!bytes) { response.statusCode = 404; response.end(); return; }
          response.setHeader('Content-Type', mediaTypes.get(file) ?? (file.endsWith('.js') ? 'text/javascript; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/json; charset=utf-8'));
          response.setHeader('Cache-Control', 'no-store'); response.end(request.method === 'HEAD' ? undefined : bytes);
        } catch { response.statusCode = 500; response.end(); }
      });
    },
  };
}
