import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { UploadedDocument } from '../types';
import { detectDocumentType } from './documentParsers';

type Candidate = { document: UploadedDocument; storedName: string; stamp: string };
type Ports = {
  read: () => Promise<UploadedDocument[]>;
  write: (documents: UploadedDocument[]) => Promise<void>;
  transaction: <T>(action: () => Promise<T>) => Promise<T>;
  validateId: (id: string) => void;
};
const identity = (id: string) => id.toLowerCase();
const stamp = (stat: Awaited<ReturnType<typeof fs.lstat>>) =>
  [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');

async function safeDirectory(directory: string, missing = false) {
  try {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('恢复已停止：数据目录不能是链接或普通文件');
  } catch (error) {
    if (!missing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/** Host-owned, bounded metadata recovery. Never parses a document, reuses an index,
 * starts a model, guesses a project binding, or changes the original file. */
export async function prepareDocumentRecovery(root: string, ports: Ports) {
  const documents = path.join(root, 'documents');
  const checkDirectories = async () => {
    await safeDirectory(root);
    await safeDirectory(documents, true);
    await safeDirectory(path.join(root, 'rag-index'), true);
    try {
      const info = await fs.lstat(path.join(root, 'rag-index', 'manifest.json'));
      if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) throw new Error('恢复已停止：资料清单不是安全的普通文件');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  };
  await checkDirectories();
  const existing = await ports.read(); // Malformed manifests must fail closed, not become [].
  const known = new Set(existing.map(doc => identity(doc.id)));
  const groups = new Map<string, Candidate[]>();
  let skipped = 0;
  const directory = await fs.opendir(documents).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  let inspected = 0;
  if (directory) for await (const entry of directory) {
    if (++inspected > 10_000) throw new Error('文件超过单次扫描上限（10000），未修改清单，请先分批整理');
    const extension = path.extname(entry.name), id = entry.name.slice(0, -extension.length);
    const descriptor = detectDocumentType(entry.name);
    try { ports.validateId(id); } catch { skipped++; continue; }
    if (!descriptor || extension !== descriptor.extension || !entry.isFile() || entry.isSymbolicLink()) { skipped++; continue; }
    if (known.has(identity(id))) continue;
    const stat = await fs.lstat(path.join(documents, entry.name));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) { skipped++; continue; }
    const document: UploadedDocument = {
      id, fileName: entry.name, extension, fileType: descriptor.fileType,
      indexable: descriptor.indexable, size: stat.size, uploadAt: new Date().toISOString(),
      category: '待整理', status: 'stored', chunkCount: 0, totalChars: 0,
      processingPolicy: 'body_only', knowledgeStatus: 'disabled',
    };
    const group = groups.get(identity(id)) || [];
    group.push({ document, storedName: entry.name, stamp: stamp(stat) });
    groups.set(identity(id), group);
  }
  const candidates: Candidate[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) candidates.push(group[0]);
    else skipped += group.length; // One ID with several extensions is ambiguous.
  }
  candidates.sort((a, b) => a.storedName.localeCompare(b.storedName));
  return {
    count: candidates.length, skipped,
    names: candidates.slice(0, 20).map(candidate => candidate.storedName),
    commit: (isCurrent: () => boolean) => ports.transaction(async () => {
      if (!isCurrent()) throw new Error('数据目录或处理状态已变化，请重新扫描');
      await checkDirectories();
      const latest = await ports.read();
      const ids = new Set(latest.map(doc => identity(doc.id)));
      const wanted = new Set(candidates.filter(candidate => !ids.has(identity(candidate.document.id)))
        .map(candidate => identity(candidate.document.id)));
      const physicalIds = new Map<string, number>();
      // A second file with the same ID may have arrived while the native dialog was open.
      if (wanted.size) {
        let count = 0;
        for await (const entry of await fs.opendir(documents)) {
          if (++count > 10_000) throw new Error('目录内容已变化并超过扫描上限，请重新整理后扫描');
          if (!entry.isFile() || entry.isSymbolicLink()) continue;
          const extension = path.extname(entry.name), descriptor = detectDocumentType(entry.name);
          if (!descriptor || descriptor.extension !== extension) continue;
          const key = identity(entry.name.slice(0, -extension.length));
          if (wanted.has(key)) physicalIds.set(key, (physicalIds.get(key) || 0) + 1);
        }
      }
      const additions: UploadedDocument[] = [];
      for (const candidate of candidates) {
        if (ids.has(identity(candidate.document.id))) continue;
        if (physicalIds.get(identity(candidate.document.id)) !== 1) throw new Error('扫描后的文件标识发生冲突，未修改清单，请重新扫描');
        const stat = await fs.lstat(path.join(documents, candidate.storedName));
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stamp(stat) !== candidate.stamp) {
          throw new Error('扫描后的文件发生变化，未修改清单，请重新扫描');
        }
        ids.add(identity(candidate.document.id));
        additions.push(candidate.document);
      }
      if (!isCurrent()) throw new Error('数据目录或处理状态已变化，请重新扫描');
      if (additions.length) await ports.write([...latest, ...additions]);
      return additions.length;
    }),
  };
}
