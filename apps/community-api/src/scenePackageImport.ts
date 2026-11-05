import { H5pArchive } from './scenePackageArchive.js';
import { readSceneInteractionPackManifest } from './scenePackageManifest.js';
import { verifyScenePackMaterialBytes } from './scenePackageMaterial.js';

export const SCENE_PACK_IMPORT_LIMIT = 16 * 1024 * 1024;
/** Reuse the bounded ZIP/CRC reader only, not H5P metadata or its runtime. */
export async function inspectScenePackImport(bytes: Buffer) {
  if (!bytes.length || bytes.length > SCENE_PACK_IMPORT_LIMIT) throw Error('S2 交互包需在 16 MiB 以内');
  const zip = new H5pArchive(bytes);
  if (zip.entries.size > 256) throw Error('S2 交互包文件不能超过256个');
  const names = [...zip.entries.keys()];
  const manifests = names.filter(name => name === 'manifest.json' || name.endsWith('/manifest.json')).filter(name => {
    const base = name.slice(0, -'manifest.json'.length);
    return ['main.js', 'styles.css', 'agent.json'].every(file => zip.entries.has(base + file));
  });
  if (manifests.length !== 1) throw Error('ZIP 中必须恰好包含一个交互包 manifest.json');
  const prefix = manifests[0].slice(0, -'manifest.json'.length);
  if (names.some(name => !name.startsWith(prefix))) throw Error('ZIP 含交互包目录之外的文件');
  const files = new Map<string, Buffer>(); let total = 0;
  for (const name of names) {
    const relative = name.slice(prefix.length), entry = zip.entries.get(name)!;
    if (!relative || relative.split('/').length > 16 || entry.size > 2 * 1024 * 1024 || (total += entry.size) > 32 * 1024 * 1024)
      throw Error('S2 交互包展开大小或层级超限');
    if (relative.startsWith('.') || relative.split('/').some(part => part.startsWith('.'))) throw Error('S2 交互包不接受隐藏文件');
    files.set(relative, await zip.read(name));
  }
  const read = (name: string, max: number) => {
    const bytes = files.get(name);
    if (!bytes || bytes.length > max) throw Error(`S2 交互包缺少 ${name} 或文件超限`);
    return bytes;
  };
  const manifest = readSceneInteractionPackManifest(JSON.parse(read('manifest.json', 8192).toString('utf8')));
  read('main.js', 2 * 1024 * 1024); read('styles.css', 65536);
  JSON.parse(read('agent.json', 262144).toString('utf8'));
  if (manifest.protocolVersion === 2) for (const material of manifest.materials)
    await verifyScenePackMaterialBytes(material, read(material.path, 1048576));
  return { manifest, files };
}

