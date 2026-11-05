import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { scenePackEditorServices } from '../src/services/scene/scenePackEditorServices';
import { readSceneInteractionPackManifest } from '../src/services/scene/sceneInteractionPackManifest';
import { ScenePackMaterialError, verifyScenePackMaterialBytes } from '../src/services/scene/sceneInteractionPackMaterialProtocol';
import { describeSceneInteractionPack, readSceneInteractionPack, readScenePackDescription, ScenePackProtocolError, validateScenePackConfig } from '../src/services/scene/sceneInteractionPackProtocol';
import { sceneInteractionPacks } from '../src/services/scene/sceneInteractionPacks';
import { installSceneInteractionCapabilities, s2BuiltinPluginRegistry, s2ComposableCapabilities, s2CapabilityKey } from '../src/services/scene/sceneS2PluginRegistry';
import { readS2Definition, readS2Document } from '../src/services/scene/sceneS2Canvas';
import { assertS2ReadOnlyContent } from '../src/services/scene/sceneS2ReadOnly';
import { prepareS2PublicDefinition } from '../src/services/scene/sceneS2PublicSession';
import { assertS2PublicEdit } from '../src/services/scene/sceneS2PublicAuthoring';
import { scenePackStyles } from '../src/services/scene/sceneInteractionPackStyles';
import { canonicalS2Json, S2PluginProtocolError } from '../src/services/scene/sceneS2PluginProtocol';
import type { ScenePackConfig } from '../src/types/sceneInteractionPack';
import type { S2Json } from '../src/types/sceneS2Plugin';

const limits = { 'manifest.json': 8192, 'main.js': 524288, 'styles.css': 65536, 'agent.json': 262144 } as const;
function failure(code: string, location: string, message: string): never { throw new ScenePackProtocolError(code, location, message); }
function wrap(error: unknown, code: string, location: string): never {
  if (error instanceof ScenePackProtocolError) throw error;
  if (error instanceof ScenePackMaterialError) failure(error.code, error.path, error.message);
  if (error instanceof S2PluginProtocolError) failure(error.code, `/${error.field.replace(/\./g, '/')}`, error.message);
  failure(code, location, error instanceof Error ? error.message : String(error));
}
function json(bytes: Uint8Array, location: string): unknown {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch (error) { wrap(error, 'PACK_FILE_JSON', location); }
}
async function readBounded(file: string, maxBytes: number, location: string) {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(file, 'r');
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) failure('PACK_FILE_LIMIT', location, `需要普通文件，完整大小不得超过 ${maxBytes} 字节`);
    // A concurrent file change cannot turn a bounded check into an unbounded read.
    const bytes = Buffer.alloc(maxBytes + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = await handle.read(bytes, count, bytes.length - count, count);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    if (count > maxBytes) failure('PACK_FILE_LIMIT', location, `完整文件不得超过 ${maxBytes} 字节`);
    return bytes.subarray(0, count);
  } catch (error) { wrap(error, 'PACK_FILE_READ', location); }
  finally { await handle?.close(); }
}

/** Reads and activates trusted package code. This is a contract validator, not an execution sandbox. */
export async function validateScenePackDirectory(input: string, sceneFile?: string) {
  const directory = path.resolve(input);
  let realRoot: string;
  try {
    realRoot = await fs.realpath(directory);
    if (!(await fs.stat(realRoot)).isDirectory()) failure('PACK_DIRECTORY', '/', '请输入打包后的 id/version 目录');
  } catch (error) { wrap(error, 'PACK_DIRECTORY', '/'); }
  const files = await Promise.all((Object.keys(limits) as Array<keyof typeof limits>).map(async name => {
    const location = `/${name}`;
    let realFile: string;
    try { realFile = await fs.realpath(path.join(realRoot, name)); }
    catch (error) { wrap(error, 'PACK_FILE_READ', location); }
    const relative = path.relative(realRoot, realFile);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
      failure('PACK_FILE_SCOPE', location, '固定文件必须位于当前插件包目录内');
    return [name, await readBounded(realFile, limits[name], location)] as const;
  }));
  const bytes = Object.fromEntries(files) as Record<keyof typeof limits, Buffer>;
  let manifest: ReturnType<typeof readSceneInteractionPackManifest>;
  try { manifest = readSceneInteractionPackManifest(json(bytes['manifest.json'], '/manifest.json')); }
  catch (error) { wrap(error, 'PACK_CONTRACT_MANIFEST', '/manifest.json'); }
  if (path.basename(directory) !== manifest.version || path.basename(path.dirname(directory)) !== manifest.id)
    failure('PACK_DIRECTORY_IDENTITY', '/manifest', '目录必须以清单声明的 id/version 结尾');
  for (const material of manifest.protocolVersion === 2 ? manifest.materials : []) {
    const location = `/${material.path}`;
    let materialFile: string;
    try { materialFile = await fs.realpath(path.join(realRoot, material.path)); }
    catch (error) { wrap(error, 'PACK_MATERIAL_READ', location); }
    const relative = path.relative(realRoot, materialFile);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
      failure('PACK_FILE_SCOPE', location, '声明物料必须位于当前插件包 id/version 目录内');
    try { await verifyScenePackMaterialBytes(material, await readBounded(materialFile, material.bytes, location)); }
    catch (error) { wrap(error, 'PACK_MATERIAL_INVALID', location); }
  }
  // Check UTF-8 without applying styles or creating a UI.
  for (const name of ['styles.css', 'main.js'] as const) {
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes[name]); }
    catch (error) { wrap(error, 'PACK_FILE_ENCODING', `/${name}`); }
  }
  // The exact production parser/scoper, without injecting CSS or activating code.
  try { scenePackStyles({ id: manifest.id, version: manifest.version }, new TextDecoder('utf-8', { fatal: true }).decode(bytes['styles.css'])); }
  catch (error) { wrap(error, 'PACK_STYLES_INVALID', '/styles.css'); }
  const agent = readScenePackDescription(json(bytes['agent.json'], '/agent.json'));
  let module: Record<string, unknown>;
  try { module = await import('data:text/javascript;base64,' + bytes['main.js'].toString('base64')); }
  catch (error) { wrap(error, 'PACK_ENTRY_IMPORT', '/main.js'); }
  if (typeof module.activate !== 'function') failure('PACK_ENTRY_ACTIVATE', '/activate', 'main.js 需要导出同步 activate(services)');
  let pack: ReturnType<typeof readSceneInteractionPack>;
  try {
    pack = readSceneInteractionPack(module.activate({ editor: scenePackEditorServices, ui: { react: React } }),
      { sharedCapabilities: s2BuiltinPluginRegistry().catalog() });
  } catch (error) { wrap(error, 'PACK_ENTRY_ACTIVATE', '/activate'); }
  if (canonicalS2Json(pack.manifest as unknown as S2Json) !== canonicalS2Json(manifest as unknown as S2Json))
    failure('PACK_ENTRY_IDENTITY', '/manifest', 'activate 返回清单与 manifest.json 不一致');
  if (canonicalS2Json(describeSceneInteractionPack(pack) as unknown as S2Json) !== canonicalS2Json(agent as unknown as S2Json))
    failure('PACK_AGENT_MISMATCH', '/agent.json', 'Agent 说明与实际 describe() 结果不一致，请重新生成 agent.json');
  // Installation validates the same capability dependencies, data types and host
  // service bridges as the terminal. Only this isolated process is changed.
  try { installSceneInteractionCapabilities(pack); sceneInteractionPacks.register(pack); }
  catch (error) { wrap(error, 'PACK_CAPABILITY_INSTALL', '/capabilities'); }
  if (sceneFile) {
    const value = json(await readBounded(path.resolve(sceneFile), 524288, '/scene'), '/scene');
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'definition') || !Object.hasOwn(value, 'document'))
      failure('PACK_SCENE_CONFIG', '/scene', '--scene 需要只包含 definition、document 的 ScenePackConfig JSON');
    const raw = value as ScenePackConfig;
    let config: ScenePackConfig;
    try {
      const definition = prepareS2PublicDefinition(pack, readS2Definition(raw.definition));
      const current = readS2Document(raw.document, definition);
      // Normalize legacy unambiguous component identities exactly as opening a
      // saved public scene does. Its internal baseline comes from the package,
      // never from a caller's rewritten definition.initial.
      const document = prepareS2PublicDefinition(pack, { ...definition, initial: current }).initial;
      assertS2ReadOnlyContent(definition.initial, document, { requirePresence: true });
      assertS2PublicEdit(pack, { definition, document: definition.initial }, { definition, document }, definition.initial);
      const allowed = new Set(s2ComposableCapabilities({ id: pack.manifest.id, version: pack.manifest.version }).map(s2CapabilityKey));
      if (definition.plugins?.some(capability => !allowed.has(s2CapabilityKey(capability))))
        failure('PACK_SCENE_SCOPE', '/scene/definition/plugins', '场景声明了当前包及共享底座之外的能力');
      config = { definition, document };
    } catch (error) { wrap(error, 'PACK_SCENE_CONFIG', '/scene'); }
    let issues: ReturnType<typeof validateScenePackConfig>;
    try { issues = validateScenePackConfig(pack, structuredClone(config)); }
    catch (error) { wrap(error, 'PACK_SCENE_VALIDATE', '/validate'); }
    if (issues.length) failure('PACK_CONFIG_INVALID', issues[0].path, `${issues[0].message}${issues.length > 1 ? `；共 ${issues.length} 项问题` : ''}`);
  }
  return { id: manifest.id, version: manifest.version, plugins: pack.capabilities.length,
    capabilities: pack.capabilities.reduce((sum, plugin) => sum + plugin.capabilities.length, 0), sceneChecked: !!sceneFile };
}

function options(args: string[]) {
  let directory: string | undefined, scene: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--help' || flag === '-h') return { help: true } as const;
    if (!['--dir', '--scene'].includes(flag) || !args[index + 1] || args[index + 1].startsWith('--'))
      failure('PACK_CLI_ARGUMENT', '/', '用法：--dir <打包后的 id/version 目录> [--scene <ScenePackConfig.json>]');
    const value = args[++index];
    if (flag === '--dir') { if (directory) failure('PACK_CLI_ARGUMENT', '/--dir', '不能重复声明'); directory = value; }
    else { if (scene) failure('PACK_CLI_ARGUMENT', '/--scene', '不能重复声明'); scene = value; }
  }
  if (!directory) failure('PACK_CLI_ARGUMENT', '/--dir', '需要指定打包后的 id/version 目录');
  return { help: false, directory, scene } as const;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const input = options(process.argv.slice(2));
    if (input.help) console.log('用法：node scripts/run-tsx-safe.cjs scripts/validate-scene-pack.ts --dir <id/version目录> [--scene <ScenePackConfig.json>]\n只验证可信插件包；激活入口会执行代码，此工具不是隔离沙箱。不创建运行器、不执行场景、不申请模型服务，也不写入输入目录。');
    else {
      const result = await validateScenePackDirectory(input.directory, input.scene);
      console.log(`验包通过：${result.id}@${result.version}；${result.plugins} 个插件、${result.capabilities} 个能力${result.sceneChecked ? '；场景配置校验通过' : ''}。`);
      console.log('已检查固定文件、声明物料完整性、接口、Agent 说明和能力安装契约；未创建运行器或执行场景。仅用于可信包，不是隔离沙箱。');
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;
  }
}
