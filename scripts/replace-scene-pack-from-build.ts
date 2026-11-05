import path from 'node:path';
import { createSceneInteractionPackStore } from '../src/electron/sceneInteractionPackStore';
import { readSceneInteractionPackRef } from '../src/services/scene/sceneInteractionPackManifest';

// Explicit maintenance command only. No wildcard IDs, inferred user-data paths,
// activation, hot reload or unrelated package/vault cleanup.
const values = new Map<string, string>(), allowed = new Set(['--root', '--seed', '--id', '--version']);
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 2) {
  const flag = args[index], value = args[index + 1];
  if (!allowed.has(flag) || values.has(flag) || !value || value.startsWith('--')) throw new Error('用法：--root 绝对安装目录 --seed 绝对构建目录 --id 包ID --version 精确版本');
  values.set(flag, value);
}
if (values.size !== allowed.size || !path.isAbsolute(values.get('--root')!) || !path.isAbsolute(values.get('--seed')!))
  throw new Error('root和seed必须显式指定绝对目录，并提供精确id/version');
const ref = readSceneInteractionPackRef({ id: values.get('--id'), version: values.get('--version') });
const result = await createSceneInteractionPackStore(values.get('--root')!, values.get('--seed')!).replaceFromSeed(ref);
process.stdout.write(JSON.stringify(result) + '\n');
