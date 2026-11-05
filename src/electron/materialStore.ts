import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SourceLocator, StructuredDocument, UploadedDocument } from '../types';
import type { MaterialScope } from '../services/textbook/materialTypes.ts';
import { assertMaterialDocument, MaterialError } from '../services/textbook/materialScope.ts';
import { extractStructuredDocument } from './documentParsers.ts';
import {getBackgroundRagCompute} from './rag/backgroundComputeBridge.ts';
import { readPdfVisual } from './pdfMaterial.ts';
import { buildStructuredDocument } from './rag/structuredDocument.ts';
import { getDocumentsDir, getRagIndexDir, readManifest, readStructuredDocumentFile,
  updateManifest, writeStructuredDocumentFile } from './ragIndex.ts';

export const MATERIAL_PARSER_VERSION = 4;
const MAX_SOURCE_BYTES = 100 * 1024 * 1024;
const parsing = new Map<string, Promise<StructuredDocument>>();
export function materialHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
export function materialVersion(document: StructuredDocument): string {
  return materialHash(JSON.stringify([document.sourceHash, document.materialParserVersion,
    document.normalizedText, document.blocks, document.preprocessing]));
}
export async function materialMetadata(scope: MaterialScope, docId: string): Promise<UploadedDocument> {
  assertMaterialDocument(scope, docId);
  const doc = (await readManifest()).find((item) => item.id === docId);
  if (!doc) throw new MaterialError('SOURCE_MISSING', '资料已删除或不存在');
  return doc;
}
export async function materialSourcePath(doc: UploadedDocument): Promise<string> {
  if (!/^\.[a-z0-9]{1,10}$/u.test(doc.extension)) throw new MaterialError('INVALID_SOURCE', '资料扩展名无效');
  const dir = await getDocumentsDir();
  const file = path.join(dir, `${doc.id}${doc.extension}`);
  try {
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SOURCE_BYTES) {
      throw new MaterialError('INVALID_SOURCE', '资料不是普通文件或超过 100 MB 安全读取上限');
    }
    return file;
  } catch (error) {
    if (error instanceof MaterialError) throw error;
    throw new MaterialError('SOURCE_MISSING', '原始资料已删除或不可读取');
  }
}
async function sourceHash(doc: UploadedDocument): Promise<string> {
  const file = await materialSourcePath(doc);
  const handle = await fs.open(file, 'r');
  try {
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      bytes += chunk.length;
      if (bytes > MAX_SOURCE_BYTES) throw new MaterialError('INVALID_SOURCE', '原始资料超过安全读取上限');
      hash.update(chunk);
    }
    return hash.digest('hex');
  } finally { await handle.close(); }
}
/** Approval snapshot: hash original bytes without parsing or invoking any model. */
export async function fingerprintMaterialSource(scope: MaterialScope, docId: string): Promise<string> {
  return sourceHash(await materialMetadata(scope, docId));
}
function validLocator(locator: SourceLocator): boolean {
  const integer = (value: number, min = 0) => Number.isSafeInteger(value) && value >= min;
  if (!locator || typeof locator !== 'object') return false;
  if (locator.kind === 'text') return integer(locator.charStart) && integer(locator.charEnd) && locator.charEnd >= locator.charStart;
  if (locator.kind === 'pdf') return integer(locator.page, 1)
    && (locator.blockIndex === undefined || integer(locator.blockIndex))
    && (locator.tableIndex === undefined || integer(locator.tableIndex))
    && (!locator.bbox || (locator.bbox.length === 4 && locator.bbox.every(Number.isFinite)));
  if (locator.kind === 'docx') return integer(locator.paragraphIndex);
  if (locator.kind === 'pptx') return integer(locator.slideIndex, 1);
  return false;
}
const validNonNegativeInteger = (value: number) => Number.isSafeInteger(value) && value >= 0;
export function validateMaterialDocument(document: StructuredDocument, docId: string): void {
  if (!document || document.docId !== docId || document.schemaVersion !== 1
    || typeof document.normalizedText !== 'string' || !document.normalizedText.trim()
    || document.normalizedText.length > 20_000_000 || !Array.isArray(document.blocks)
    || !document.blocks.length || document.blocks.length > 200_000) {
    throw new MaterialError('INVALID_SOURCE', '结构化原文缺失或超出安全范围');
  }
  let end = 0;
  const ids = new Set<string>();
  for (const block of document.blocks) {
    if (!block || typeof block.id !== 'string' || ids.has(block.id) || !block.id.startsWith(`${docId}:block:`)
      || !['heading', 'paragraph', 'list', 'table', 'code', 'caption', 'notes'].includes(block.kind)
      || typeof block.sectionPath !== 'string' || !Number.isSafeInteger(block.textStart)
      || !Number.isSafeInteger(block.textEnd) || block.textStart < end || block.textEnd <= block.textStart
      || block.textEnd > document.normalizedText.length || !validLocator(block.locator)) {
      throw new MaterialError('INVALID_SOURCE', '资料块或原文定位损坏，不能引用');
    }
    if (block.sourceFragments && (!Array.isArray(block.sourceFragments) || block.sourceFragments.length > 100
      || block.sourceFragments.some((fragment) => !fragment || !validLocator(fragment.locator)
        || typeof fragment.rawText !== 'string' || fragment.rawText.length > 2_000_000))) {
      throw new MaterialError('INVALID_SOURCE', '资料来源片段损坏，不能引用');
    }
    for (const fragment of block.sourceFragments || []) {
      const evidence = fragment.formulaEvidence;
      if (evidence && (!['native_latex', 'pdf_layout'].includes(evidence.origin)
        || !['structured_unverified', 'needs_visual_check'].includes(evidence.status)
        || !Array.isArray(evidence.reasons) || evidence.reasons.length > 16
        || evidence.reasons.some(reason => typeof reason !== 'string' || reason.length > 200)
        || (evidence.region && (evidence.region.length !== 4 || !evidence.region.every(Number.isFinite)
          || evidence.region[2] <= evidence.region[0] || evidence.region[3] <= evidence.region[1])))) {
        throw new MaterialError('INVALID_SOURCE', '公式提取证据或区域定位损坏');
      }
    }
    ids.add(block.id);
    end = block.textEnd;
  }
  const preprocessing = document.preprocessing;
  if (preprocessing && (preprocessing.version !== 1 || typeof preprocessing.engine !== 'string'
    || !validNonNegativeInteger(preprocessing.rawBlockCount)
    || !validNonNegativeInteger(preprocessing.projectedBlockCount)
    || !Number.isFinite(preprocessing.sourceCoverage) || preprocessing.sourceCoverage < 0
    || preprocessing.sourceCoverage > 1 || !Array.isArray(preprocessing.issues)
    || preprocessing.issues.length > 100_000)) {
    throw new MaterialError('INVALID_SOURCE', '资料预处理审计信息损坏');
  }
}

/** 不触发向量或 LLM；只能显式准备范围内的一份资料，成功后先保存可离线深读的原文。 */
export async function prepareMaterial(scope: MaterialScope, docId: string,options:{assertCurrent?:()=>void|Promise<void>}={}): Promise<StructuredDocument> {
  await options.assertCurrent?.();
  const doc = await materialMetadata(scope, docId);
  if (!doc.indexable) throw new MaterialError('UNSUPPORTED', '此格式目前只保存附件，尚无文本解析器');
  const key = `${await getDocumentsDir()}\0${docId}`;
  const running = parsing.get(key);
  if (running) {const result=await running;await options.assertCurrent?.();return result;}
  const operation = (async () => {
    await updateManifest(docId, { parseStatus: 'processing', parseError: undefined });
    try {
      const before = await sourceHash(doc);
      const file=await materialSourcePath(doc),background=getBackgroundRagCompute();
      let document = await (background?background.parse(file,doc.fileType,docId):extractStructuredDocument(file,doc.fileType,docId));
      if (doc.fileType === 'pdf' && !document.normalizedText.trim()) {
        const { pageCount } = await readPdfVisual(file);
        document = buildStructuredDocument(docId, Array.from({ length: pageCount! }, (_, index) => ({
          text: `PDF 第 ${index + 1} 页：没有可读文字层，仅有原图物料；未执行本地 OCR，不可据此猜写公式或事实。`,
          kind: 'paragraph' as const, sectionPath: `第 ${index + 1} 页原图`, locator: { kind: 'pdf' as const, page: index + 1 },
        })));
      }
      await options.assertCurrent?.();
      validateMaterialDocument(document, docId);
      if (before !== await sourceHash(doc)) throw new MaterialError('SOURCE_CHANGED', '解析期间资料发生变化，请重新准备');
      // 删除期间不得复活 manifest；索引文件即使孤立也不会被读取。
      await materialMetadata(scope, docId);
      document.sourceHash = before;
      document.materialParserVersion = MATERIAL_PARSER_VERSION;
      await writeStructuredDocumentFile(document,options);
      await options.assertCurrent?.();
      await updateManifest(docId, { parseStatus: 'ready', parseError: undefined, parsedAt: new Date().toISOString() });
      return document;
    } catch (error) {
      try {
        await options.assertCurrent?.();
        await updateManifest(docId, { parseStatus: 'failed', parseError: error instanceof MaterialError
          ? error.message : '资料解析失败，请检查文件格式或重新准备' });
      }catch{/* A stopped old environment must not write a new environment's status. */}
      throw error;
    }
  })();
  parsing.set(key, operation);
  try { return await operation; } finally { parsing.delete(key); }
}

/** 每次深读校验原文件哈希；旧/缺失/变化的缓存不降级为可信原文。 */
export async function loadMaterial(scope: MaterialScope, docId: string, expectedVersion?: string) {
  const doc = await materialMetadata(scope, docId);
  if (!doc.indexable) throw new MaterialError('UNSUPPORTED', '此格式尚不支持文本深读');
  const file = path.join(await getRagIndexDir(), `structured-${docId}.json`);
  try {
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024 * 1024) {
      throw new MaterialError('INVALID_SOURCE', '结构化原文文件无效或过大');
    }
  } catch (error) {
    if (error instanceof MaterialError) throw error;
    throw new MaterialError('NOT_PARSED', '资料尚未准备可定位原文，请先解析');
  }
  const document = await readStructuredDocumentFile(docId);
  if (!document) throw new MaterialError('INVALID_SOURCE', '结构化原文损坏');
  validateMaterialDocument(document, docId);
  // Old versioned references remain readable; explicit prepare reparses with v4.
  if (!document.sourceHash || ![3, MATERIAL_PARSER_VERSION].includes(document.materialParserVersion!)) {
    throw new MaterialError('NOT_PARSED', '旧资料缺少原文件版本，请显式重新准备');
  }
  if (document.sourceHash !== await sourceHash(doc)) throw new MaterialError('SOURCE_CHANGED', '原始资料已变化，引用已失效，请重新准备');
  const version = materialVersion(document);
  if (expectedVersion !== undefined && version !== expectedVersion) throw new MaterialError('SOURCE_CHANGED', '资料版本已变化，不能混合旧分页或旧引用');
  await materialMetadata(scope, docId);
  return { doc, document, version };
}
