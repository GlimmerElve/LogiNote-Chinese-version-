import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DocumentChunk, StructuredDocument } from '../../types.ts';
import type { SavedDocumentArgumentV5 } from '../../services/documentArgumentV5Types.ts';
import { assertGraphDocumentId, documentGraphFingerprint } from './documentGraphStore.ts';

export const STRUCTURED_ARGUMENT_SOURCE = 'structured-document-v1' as const;
export const isStructuredArgumentSource = (docId: string, id: string) => id.startsWith(`${docId}:block:`);

/** Coordinate adapters, NOT vector chunks or model-created semantic nodes.
 * chunkId is the legacy wire field for an opaque source ID. It now names the
 * preprocessed paragraph/table/title itself, with local character offsets. */
export function documentArgumentSourceBlocks(document: StructuredDocument, fileName: string): DocumentChunk[] {
  assertGraphDocumentId(document.docId);
  if (document.schemaVersion !== 1 || typeof document.normalizedText !== 'string'
    || document.normalizedText.length > 20_000_000 || !Array.isArray(document.blocks) || !document.blocks.length
    || document.blocks.length > 200_000) {
    throw new Error('预处理原文缺失，请先解析资料');
  }
  let end = 0;
  const ids = new Set<string>();
  return document.blocks.map((block, index) => {
    if (!block || typeof block.id !== 'string' || !isStructuredArgumentSource(document.docId, block.id)
      || ids.has(block.id) || !Number.isSafeInteger(block.textStart) || !Number.isSafeInteger(block.textEnd)
      || block.textStart < end || block.textEnd <= block.textStart || block.textEnd > document.normalizedText.length
      || !block.locator || typeof block.sectionPath !== 'string') throw new Error('预处理原文段落或坐标损坏，请重新解析资料');
    ids.add(block.id); end = block.textEnd;
    return {
      id: block.id, docId: document.docId, fileName, index, sectionPath: block.sectionPath,
      sourceBasis: STRUCTURED_ARGUMENT_SOURCE, schemaVersion: 1,
      content: document.normalizedText.slice(block.textStart, block.textEnd),
      textStart: block.textStart, textEnd: block.textEnd, sourceBlockIds: [block.id],
      sourceLocators: block.sourceFragments?.map(f => f.locator) || [block.locator],
      contentHash: createHash('sha256').update(JSON.stringify([document.sourceHash, document.materialParserVersion,
        block.kind, block.locator, block.sourceFragments])).digest('hex'),
      embedding: [],
    };
  });
}

export function documentArgumentSourceFingerprint(docId: string, sources: DocumentChunk[]): string {
  const rows = sources.filter(s => s.docId === docId);
  if (!rows.length || !rows.every(s => isStructuredArgumentSource(docId, s.id))) return documentGraphFingerprint(docId, sources);
  return createHash('sha256').update(JSON.stringify([STRUCTURED_ARGUMENT_SOURCE, docId,
    rows.map(s => [s.id, s.content, s.textStart, s.textEnd, s.sectionPath, s.contentHash])])).digest('hex');
}

export async function readDocumentArgumentSourceBlocks(dir: string, docId: string): Promise<DocumentChunk[]> {
  assertGraphDocumentId(docId);
  const file = path.join(dir, `structured-${docId}.json`);
  const info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024 * 1024) throw new Error('预处理原文文件无效');
  const document = JSON.parse(await fs.readFile(file, 'utf8')) as StructuredDocument;
  if (document.docId !== docId) throw new Error('预处理原文身份不匹配');
  const manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'));
  const rows = Array.isArray(manifest) ? manifest.filter(d => d?.id === docId) : [];
  const metadata = rows.length === 1 && rows[0];
  if (!metadata || typeof metadata.fileName !== 'string') throw new Error('资料已删除或不存在');
  return documentArgumentSourceBlocks(document, metadata.fileName);
}

export async function resolveDocumentArgumentV5Sources(dir: string, graph: SavedDocumentArgumentV5,
  legacyChunks: DocumentChunk[]): Promise<DocumentChunk[]> {
  const sources = graph.sourceBasis === STRUCTURED_ARGUMENT_SOURCE
    ? readDocumentArgumentSourceBlocks(dir, graph.docId)
    : legacyChunks.filter(c => c.docId === graph.docId);
  const resolved = await sources;
  if (documentArgumentSourceFingerprint(graph.docId, resolved) !== graph.sourceFingerprint) throw new Error('论证图原文来源已变化');
  return resolved;
}
