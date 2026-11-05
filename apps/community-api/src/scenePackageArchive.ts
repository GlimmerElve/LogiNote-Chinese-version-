import { inflateRaw } from 'node:zlib';
import { createHash } from 'node:crypto';
import type { H5pPackageDescriptor } from './scenePackageTypes.js';

export const H5P_LIMITS = { archive: 128 * 1024 * 1024, expanded: 256 * 1024 * 1024, file: 32 * 1024 * 1024, files: 4000 };
type Entry = { start: number; compressed: number; size: number; crc: number; method: number };
const fail = (text: string): never => { throw new Error(`H5P 包检查失败：${text}`); };
export function h5pSafePath(name: string): boolean {
  return name.length <= 400 && !/[\\:%\u0000-\u001f\u007f<>"|?*]/u.test(name)
    && name.split('/').every(part => part.length > 0 && part !== '.' && part !== '..' && !/[. ]$/u.test(part)
      && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part));
}
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});
const crc32 = async (bytes: Buffer) => {
  let value = 0xffffffff;
  for (let start = 0; start < bytes.length; start += 65536) {
    for (const byte of bytes.subarray(start, start + 65536)) value = crcTable[(value ^ byte) & 255] ^ value >>> 8;
    if (start) await new Promise<void>(resolve => setImmediate(resolve));
  }
  return (value ^ 0xffffffff) >>> 0;
};
const object = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
// Official PHP exports use decimal strings in dependency declarations, while
// library.json commonly uses numbers. Do not coerce blanks, signs or exponents.
const versionInteger = (value: unknown, max = 9999): number | undefined => {
  const number = typeof value === 'string' && /^(?:0|[1-9]\d{0,15})$/u.test(value) ? Number(value) : value;
  return typeof number === 'number' && Number.isSafeInteger(number) && number >= 0 && number <= max ? number : undefined;
};
const libraryId = (value: any) => {
  const major = versionInteger(value?.majorVersion), minor = versionInteger(value?.minorVersion);
  if (!object(value) || typeof value.machineName !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,99}$/u.test(value.machineName)
    || major === undefined || minor === undefined) fail('依赖库名称或版本无效');
  return `${value.machineName}-${major}.${minor}`;
};

/** Parse central directory before inflating. No extraction paths or executable imports. */
export class H5pArchive {
  readonly entries = new Map<string, Entry>();
  readonly id: string;
  constructor(private bytes: Buffer) {
    if (bytes.length < 22 || bytes.length > H5P_LIMITS.archive) fail('包大小需在 128 MB 以内');
    let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
      if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
    }
    if (end < 0) fail('不是有效 ZIP/H5P 文件');
    const count = bytes.readUInt16LE(end + 10), start = bytes.readUInt32LE(end + 16), length = bytes.readUInt32LE(end + 12);
    if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== count
      || !count || count > H5P_LIMITS.files || start + length !== end) fail('分卷、ZIP64 或过多条目不支持');
    let offset = start, total = 0;
    const names = new Set<string>(), ranges: Array<[number, number]> = [];
    for (let i = 0; i < count; i++) {
      if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) fail('目录损坏');
      const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10);
      const compressed = bytes.readUInt32LE(offset + 20), size = bytes.readUInt32LE(offset + 24);
      const nameLength = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32);
      const local = bytes.readUInt32LE(offset + 42), mode = bytes.readUInt32LE(offset + 38) >>> 16;
      if (offset + 46 + nameLength + extra + comment > end || flags & 1 || ![0, 8].includes(method)
        || bytes.readUInt16LE(offset + 34) || (mode & 0xf000) === 0xa000) fail('加密、链接或不支持的压缩格式');
      const rawName = bytes.subarray(offset + 46, offset + 46 + nameLength);
      const fullName = new TextDecoder('utf-8', { fatal: true }).decode(rawName);
      const directory = fullName.endsWith('/'), name = directory ? fullName.slice(0, -1) : fullName;
      if (!h5pSafePath(name) || names.has(name.toLowerCase())) fail('重复或越界文件路径');
      names.add(name.toLowerCase());
      if (local + 30 > start || bytes.readUInt32LE(local) !== 0x04034b50
        || bytes.readUInt16LE(local + 8) !== method || bytes.readUInt16LE(local + 6) !== flags) fail('文件头不一致');
      const localName = bytes.readUInt16LE(local + 26), localExtra = bytes.readUInt16LE(local + 28);
      const body = local + 30 + localName + localExtra;
      if (localName !== rawName.length || !bytes.subarray(local + 30, local + 30 + localName).equals(rawName)
        || body + compressed > start || size > H5P_LIMITS.file || (total += size) > H5P_LIMITS.expanded) fail('文件越界或展开后超限');
      ranges.push([local, body + compressed]);
      if (!directory) this.entries.set(name, { start: body, compressed, size, method, crc: bytes.readUInt32LE(offset + 16) });
      offset += 46 + nameLength + extra + comment;
    }
    if (offset !== end) fail('目录长度不一致');
    ranges.sort((a, b) => a[0] - b[0]);
    if (ranges.some((range, i) => i > 0 && range[0] < ranges[i - 1][1])) fail('压缩文件范围重叠');
    for (const name of this.entries.keys()) {
      const parts = name.split('/');
      for (let i = 1; i < parts.length; i++) if (this.entries.has(parts.slice(0, i).join('/'))) fail('文件和目录冲突');
    }
    this.id = createHash('sha256').update(bytes).digest('hex');
  }
  async read(name: string): Promise<Buffer> {
    const entry = this.entries.get(name);
    if (!entry) throw new Error('H5P 文件不存在');
    const compressed = this.bytes.subarray(entry.start, entry.start + entry.compressed);
    const result = entry.method === 0 ? compressed : await new Promise<Buffer>((resolve, reject) =>
      inflateRaw(compressed, { maxOutputLength: Math.max(1, entry.size) }, (error, value) => error ? reject(error) : resolve(value)));
    if (result.length !== entry.size || await crc32(result) !== entry.crc) fail('展开大小或校验和错误');
    return result;
  }
  async json(name: string) {
    if ((this.entries.get(name)?.size || 0) > 4_000_000) fail('JSON 文件过大');
    const result = JSON.parse((await this.read(name)).toString('utf8'));
    if (!object(result)) fail('JSON 定义必须是对象');
    return result;
  }
  /** Validate every stored member without extraction, execution or retaining expanded bytes. */
  async verifyAll():Promise<void> { for (const name of this.entries.keys()) await this.read(name); }
  async inspect(): Promise<{ descriptor: H5pPackageDescriptor; files: Map<string, string> }> {
    const metadata = await this.json('h5p.json');
    await this.json('content/content.json');
    if (typeof metadata.title !== 'string' || !metadata.title.trim() || metadata.title.length > 300
      || typeof metadata.mainLibrary !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,99}$/u.test(metadata.mainLibrary)
      || !Array.isArray(metadata.preloadedDependencies) || !metadata.preloadedDependencies.length) fail('缺少标题、主库或依赖声明');
    const libraries = new Map<string, { folder: string; definition: any }>();
    for (const name of this.entries.keys()) if (/^[^/]+\/library\.json$/u.test(name)) {
      const definition = await this.json(name), key = libraryId(definition), folder = name.split('/')[0];
      if (folder !== key && folder !== definition.machineName || libraries.has(key)) fail('库目录名称或版本冲突');
      if (versionInteger(definition.patchVersion, Number.MAX_SAFE_INTEGER) === undefined) fail('库补丁版本无效');
      libraries.set(key, { folder, definition });
    }
    const missing = new Set<string>(), visited = new Set<string>(), files = new Map<string, string>(), runtimeFiles = new Set<string>();
    const visit = (dependency: any) => {
      const key = libraryId(dependency);
      if (visited.has(key)) return;
      visited.add(key);
      const item = libraries.get(key);
      if (!item) { missing.add(key); return; }
      const { folder, definition } = item;
      // Conservative phase-one compatibility baseline; newer core requirements are held for verification.
      if (definition.coreApi) {
        const major = versionInteger(definition.coreApi.majorVersion), minor = versionInteger(definition.coreApi.minorVersion);
        if (major !== 1 || minor === undefined || minor > 28) missing.add(`${key} 需要更新的 H5P 核心 API`);
      }
      for (const kind of ['preloadedJs', 'preloadedCss']) {
        if (definition[kind] !== undefined && !Array.isArray(definition[kind])) fail('库文件声明无效');
        for (const entry of definition[kind] || []) {
          if (!object(entry) || typeof entry.path !== 'string' || !h5pSafePath(entry.path) || !this.entries.has(`${folder}/${entry.path}`))
            missing.add(`${key} 缺少 ${String(entry?.path)}`);
          else runtimeFiles.add(`${folder}/${entry.path}`);
        }
      }
      for (const kind of ['preloadedDependencies', 'dynamicDependencies']) {
        if (definition[kind] !== undefined && !Array.isArray(definition[kind])) fail('嵌套依赖声明无效');
        for (const child of definition[kind] || []) visit(child);
      }
      // Normalize unversioned export folders for the standalone player's URL resolver.
      for (const name of this.entries.keys()) if (name.startsWith(`${folder}/`)) files.set(`${key}/${name.slice(folder.length + 1)}`, name);
    };
    for (const dependency of metadata.preloadedDependencies) visit(dependency);
    if (!metadata.preloadedDependencies.some((dependency: any) => dependency.machineName === metadata.mainLibrary)) fail('主库没有包含在依赖中');
    // Shared children are valid; only a back-edge in the preloaded graph is a
    // cycle. Dynamic references are checked for availability, not preload order.
    const checking = new Set<string>(), checked = new Set<string>();
    const checkPreload = (key: string) => {
      if (checking.has(key)) fail(`循环依赖：${key}`);
      if (checked.has(key)) return;
      checking.add(key);
      for (const dependency of libraries.get(key)?.definition.preloadedDependencies || []) checkPreload(libraryId(dependency));
      checking.delete(key); checked.add(key);
    };
    for (const key of visited) checkPreload(key);
    // Inflate one declared script/style at a time under the existing size limits.
    // No execution and no retained expanded package; bad CRC fails before import/open.
    for (const name of runtimeFiles) {
      try { await this.read(name); } catch { fail(`运行文件损坏或校验失败：${name}`); }
    }
    files.set('h5p.json', 'h5p.json');
    for (const name of this.entries.keys()) if (name.startsWith('content/')) files.set(name, name);
    return { descriptor: { id: this.id, title: metadata.title, mainLibrary: metadata.mainLibrary,
      libraries: [...visited].sort(), missing: [...missing].sort(), bytes: this.bytes.length, importedAt: new Date().toISOString() }, files };
  }
}
