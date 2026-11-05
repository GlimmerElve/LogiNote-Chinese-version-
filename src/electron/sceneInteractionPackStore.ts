import fs from 'node:fs/promises';
import path from 'node:path';
import { readSceneInteractionPackManifest, readSceneInteractionPackRef } from '../services/scene/sceneInteractionPackRegistry';
import type { SceneInteractionPackRef, ScenePackMaterialDescriptor } from '../types/sceneInteractionPack';
import { findScenePackMaterial, verifyScenePackMaterialBytes } from '../services/scene/sceneInteractionPackMaterialProtocol';
import { createScenePackSeedManager } from './sceneInteractionPackSeed';

/** Trusted local code packages only. Main reads fixed assets; it never evaluates plugin code. */
export function createSceneInteractionPackStore(root: string, seed?: string, options: { refreshSeed?: boolean } = {}) {
  const directory = path.resolve(root);
  const seeds = createScenePackSeedManager(directory, seed, options);
  const initialize = () => seeds.initialize();
  async function readAsset(ref: SceneInteractionPackRef, name: string, maxBytes: number) {
    const safe = readSceneInteractionPackRef(ref);
    const file = path.join(directory, safe.id, safe.version, name);
    const [realRoot, realFile] = await Promise.all([fs.realpath(directory), fs.realpath(file)]);
    const relative = path.relative(realRoot, realFile);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('交互包文件必须位于指定插件目录内');
    const info = await fs.stat(realFile);
    if (!info.isFile() || info.size > maxBytes) throw new Error('交互包文件类型或大小无效');
    const bytes = await fs.readFile(realFile);
    if (bytes.byteLength > maxBytes) throw new Error('交互包文件超限');
    return bytes;
  }
  async function manifest(ref: SceneInteractionPackRef) {
    const value = readSceneInteractionPackManifest(JSON.parse((await readAsset(ref, 'manifest.json', 8192)).toString('utf8')));
    if (value.id !== ref.id || value.version !== ref.version) throw new Error('交互包清单与目录身份不一致');
    return value;
  }
  async function readMaterialBytes(ref: SceneInteractionPackRef, descriptor: ScenePackMaterialDescriptor) {
    const safe = readSceneInteractionPackRef(ref), realRoot = await fs.realpath(directory);
    const expectedVersion = path.join(realRoot, safe.id, safe.version), realVersion = await fs.realpath(expectedVersion);
    if (path.relative(expectedVersion, realVersion) !== '') throw new Error('PACK_MATERIAL_SCOPE: 物料版本目录不能指向其他包或版本');
    const realFile = await fs.realpath(path.join(realVersion, descriptor.path));
    const relative = path.relative(realVersion, realFile);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
      throw new Error('PACK_MATERIAL_SCOPE: 物料必须位于当前交互包的精确版本目录内');
    const handle = await fs.open(realFile, 'r');
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 1048576) throw new Error('PACK_MATERIAL_LIMIT: 物料必须为不超过1MiB的完整文件');
      const buffer = Buffer.alloc(Math.min(descriptor.bytes, 1048576) + 1);
      let count = 0;
      while (count < buffer.length) {
        const read = await handle.read(buffer, count, buffer.length - count, count);
        if (!read.bytesRead) break;
        count += read.bytesRead;
      }
      const bytes = buffer.subarray(0, count);
      await verifyScenePackMaterialBytes(descriptor, bytes);
      return bytes;
    } finally { await handle.close(); }
  }
  return {
    async list() {
      const managed = await initialize() || await fs.stat(directory).then(info => info.isDirectory(), error => {
        if (error.code === 'ENOENT') return false; throw error;
      }), packs = [], errors: string[] = [...seeds.errors];
      if (managed) for (const id of await fs.readdir(directory, { withFileTypes: true })) {
        if (!id.isDirectory() || !/^[a-z][a-z0-9-]{0,63}$/.test(id.name)) continue;
        for (const version of await fs.readdir(path.join(directory, id.name), { withFileTypes: true })) {
          if (!version.isDirectory()) continue;
          try { packs.push(await manifest({ id: id.name, version: version.name })); }
          catch (error) { errors.push(`${id.name}@${version.name}: ${error instanceof Error ? error.message : '清单无效'}`); }
        }
      }
      return { managed, packs, errors };
    },
    async load(raw: SceneInteractionPackRef) {
      await initialize(); const ref = readSceneInteractionPackRef(raw), value = await manifest(ref);
      const [code, styles, guide] = await Promise.all([readAsset(ref, 'main.js', 2 * 1024 * 1024),
        readAsset(ref, 'styles.css', 65536), readAsset(ref, 'agent.json', 262144)]);
      // Guide is plain discovery data. Executable descriptions are checked after activation.
      JSON.parse(guide.toString('utf8'));
      // Reject incomplete or changed package materials before renderer activation.
      if (value.protocolVersion === 2) for (const material of value.materials) await readMaterialBytes(ref, material);
      return { manifest: value, codeBase64: code.toString('base64'), styles: styles.toString('utf8') };
    },
    async readMaterial(raw: SceneInteractionPackRef, id: string) {
      await initialize(); const ref = readSceneInteractionPackRef(raw), value = await manifest(ref);
      const descriptor = findScenePackMaterial(value, id);
      return { dataBase64: (await readMaterialBytes(ref, descriptor)).toString('base64') };
    },
    /** Explicit caller-authorized replacement on disk; activated modules still require restart. */
    replaceFromSeed: seeds.replaceFromSeed,
  };
}
