import type { StructuredDocument } from '../types';
import type { MaterialAsset, MaterialCatalog, MaterialCatalogRequest, MaterialDocumentSummary,
  MaterialPage, MaterialReadRequest, MaterialResult, MaterialScope, MaterialSection, MaterialImageRequest, MaterialImage } from '../services/textbook/materialTypes.ts';
import { embeddedLocalImages, PDF_FORMULA_IMAGE_INDEX, MAX_PDF_FORMULA_REGIONS } from '../services/textbook/localImages.ts';
import { materialDocIds, MaterialError } from '../services/textbook/materialScope.ts';
import { loadMaterial, materialHash, materialMetadata, prepareMaterial, materialSourcePath } from './materialStore.ts';
import { readPdfVisual, PDF_PAGE_IMAGE_INDEX } from './pdfMaterial.ts';
import { projectMaterialImageText } from '../services/textbook/imageProjection.ts';
import { readChunksFile } from './ragIndex.ts';
import { blockFormulaEvidence, blockFormulaRegions } from './materialFormula.ts';
import { readTextbookImageAttachment, saveTextbookImageAttachment } from './textbookImageAttachments.ts';

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new MaterialError('INVALID_REQUEST', '分页或读取预算超出安全范围');
  }
  return value;
}
/** 主进程错误不带本机路径；明确错误码用于生成前重新选择/准备来源。 */
export async function materialResult<T>(operation: () => Promise<T>): Promise<MaterialResult<T>> {
  try { return { ok: true, value: await operation() }; }
  catch (error) {
    return error instanceof MaterialError
      ? { ok: false, code: error.code, error: error.message }
      : { ok: false, code: 'INVALID_SOURCE', error: '本地物料读取失败，请检查或重新准备资料' };
  }
}
export function materialSections(document: StructuredDocument): MaterialSection[] {
  const sections: MaterialSection[] = [];
  const blocks = document.blocks;
  const hasHeadings = blocks.some((block) => block.kind === 'heading');
  for (const [index, block] of blocks.entries()) {
    const previous = blocks[index - 1];
    const pageStart = !hasHeadings && block.locator.kind === 'pdf'
      && (!previous || previous.locator.kind !== 'pdf' || previous.locator.page !== block.locator.page);
    if (index !== 0 && block.kind !== 'heading' && !pageStart) continue;
    const text = document.normalizedText.slice(block.textStart, block.textEnd);
    const heading = block.kind === 'heading' ? /^(#{1,6})\s+(.+)/u.exec(text) : null;
    const level = heading ? heading[1].length : block.kind === 'heading' ? Math.max(1, block.sectionPath.split(' > ').length) : 0;
    sections.push({
      id: `section:${block.id}`, title: (heading?.[2] || (block.kind === 'heading' ? text : pageStart && block.locator.kind === 'pdf'
        ? `第 ${block.locator.page} 页` : '正文 / 前言')).slice(0, 300),
      sectionPath: block.sectionPath, level,
      textStart: block.textStart, textEnd: document.normalizedText.length, locator: block.locator,
    });
  }
  const open: MaterialSection[] = [];
  for (const section of sections) {
    while (open.length && (section.level === 0 || open[open.length - 1].level === 0
      || section.level <= open[open.length - 1].level)) {
      open.pop()!.textEnd = section.textStart;
    }
    open.push(section);
  }
  return sections;
}
function materialAssets(document: StructuredDocument): MaterialAsset[] {
  const pages = new Set<number>();
  return document.blocks.flatMap((block): MaterialAsset[] => {
    const text = document.normalizedText.slice(block.textStart, block.textEnd);
    const kinds = new Set<MaterialAsset['kind']>();
    if (block.kind === 'code') kinds.add('code');
    if (block.kind === 'table') kinds.add('table');
    if (block.kind === 'caption') kinds.add('caption');
    if (block.kind !== 'code' && /\$[^$\n]+\$|\$\$|\\\[|\\\(/u.test(text)) kinds.add('formula');
    if (block.kind !== 'code' && /!\[[^\]]*\]\s*\(|!\[[^\]]*\]\s*\[/u.test(text)) kinds.add('image_reference');
    const assets: MaterialAsset[] = [...kinds].map((kind) => ({ id: `asset:${block.id}:${kind}`, blockId: block.id, kind,
      availability: kind === 'image_reference' ? embeddedLocalImages(text).length ? 'local_embedded' : 'reference_only' : 'text', locator: block.locator }));
    for (const [index, evidence] of blockFormulaRegions(document, block).entries()) {
      assets.push({ id: `asset:${block.id}:formula-region:${index}`, blockId: block.id, kind: 'image_reference',
        availability: 'local_rendered', locator: { ...evidence.locator, ...(evidence.locator.kind === 'pdf' ? { bbox: evidence.region } : {}) } });
    }
    if (block.locator.kind === 'pdf' && !pages.has(block.locator.page)) {
      pages.add(block.locator.page);
      assets.push({ id: `asset:${block.id}:pdf_page`, blockId: block.id, kind: 'image_reference', availability: 'local_rendered', locator: block.locator });
    }
    return assets;
  });
}
export async function listMaterialDocuments(scope: MaterialScope): Promise<MaterialDocumentSummary[]> {
  const ids = materialDocIds(scope);
  const results: MaterialDocumentSummary[] = [];
  for (const id of ids) {
    const doc = await materialMetadata(scope, id);
    const base: MaterialDocumentSummary = { docId: id, fileName: doc.fileName, fileType: doc.fileType,
      parseStatus: doc.parseStatus === 'failed' ? 'failed' : 'pending', indexStatus: doc.status };
    const result = await materialResult(() => loadMaterial(scope, id));
    if (result.ok === true) {
      base.parseStatus = 'ready';
      base.version = result.value.version;
      base.totalChars = result.value.document.normalizedText.length;
      base.blockCount = result.value.document.blocks.length;
      base.sectionCount = materialSections(result.value.document).length;
      base.assetCount = materialAssets(result.value.document).length;
    } else {
      base.parseStatus = result.code === 'SOURCE_CHANGED' ? 'stale' : result.code === 'SOURCE_MISSING' ? 'missing'
        : result.code === 'UNSUPPORTED' ? 'unsupported' : result.code === 'NOT_PARSED' ? base.parseStatus : 'failed';
      base.error = result.error;
    }
    results.push(base);
  }
  return results;
}
export async function prepareLocalMaterial(scope: MaterialScope, docId: string): Promise<MaterialDocumentSummary> {
  await prepareMaterial(scope, docId);
  return (await listMaterialDocuments({ allowedDocIds: [docId] }))[0];
}
export async function getMaterialCatalog(request: MaterialCatalogRequest): Promise<MaterialCatalog> {
  materialDocIds(request);
  const offset = boundedInteger(request?.offset, 0, 0, 200_000);
  const limit = boundedInteger(request?.limit, 40, 1, 100);
  if (offset > 0 && !request.version) throw new MaterialError('INVALID_REQUEST', '目录续页需要同一资料版本');
  const { doc, document, version } = await loadMaterial(request, request.docId, request.version);
  const sections = materialSections(document);
  const assets = materialAssets(document);
  if (offset > Math.max(sections.length, assets.length)) throw new MaterialError('INVALID_REQUEST', '目录页码不在范围内');
  return {
    document: { docId: doc.id, fileName: doc.fileName, fileType: doc.fileType, parseStatus: 'ready', indexStatus: doc.status,
      version, totalChars: document.normalizedText.length, blockCount: document.blocks.length,
      sectionCount: sections.length, assetCount: assets.length },
    sections: sections.slice(offset, offset + limit), assets: assets.slice(offset, offset + limit),
    nextOffset: offset + limit < Math.max(sections.length, assets.length) ? offset + limit : undefined,
    assetsTruncated: offset + limit < assets.length,
  };
}
export async function readMaterialPage(request: MaterialReadRequest): Promise<MaterialPage> {
  if (!request?.version || !/^[a-f0-9]{64}$/u.test(request.version)) throw new MaterialError('INVALID_REQUEST', '原文读取必须绑定资料版本');
  const maxChars = boundedInteger(request.maxChars, 8_000, 128, 12_000);
  const { doc, document, version } = await loadMaterial(request, request.docId, request.version);
  let start: number;
  let end: number;
  const target = request.target;
  if (target?.kind === 'document') {
    start = 0; end = document.normalizedText.length;
  } else if (target?.kind === 'section') {
    const section = materialSections(document).find((item) => item.id === target.sectionId);
    if (!section) throw new MaterialError('TARGET_MISSING', '章节不存在');
    start = section.textStart; end = section.textEnd;
  } else if (target?.kind === 'block' || target?.kind === 'chunk') {
    const neighbors = boundedInteger(target.neighbors, 2, 0, 10);
    let first: number;
    let last: number;
    if (target.kind === 'block') {
      first = document.blocks.findIndex((block) => block.id === target.blockId);
      last = first;
    } else {
      const chunk = (await readChunksFile(doc.id)).find((item) => item.id === target.chunkId && item.docId === doc.id);
      if (!chunk || !Number.isSafeInteger(chunk.textStart) || !Number.isSafeInteger(chunk.textEnd)
        || document.normalizedText.slice(chunk.textStart, chunk.textEnd) !== chunk.content) {
        throw new MaterialError('TARGET_MISSING', '检索命中缺少有效原文坐标或来自旧索引，请改用目录读取');
      }
      first = document.blocks.findIndex((block) => block.textEnd > chunk.textStart!);
      last = -1;
      for (let index = document.blocks.length - 1; index >= 0; index--) {
        if (document.blocks[index].textStart < chunk.textEnd!) { last = index; break; }
      }
    }
    if (first < 0 || last < first) throw new MaterialError('TARGET_MISSING', '原文块不存在');
    start = document.blocks[Math.max(0, first - neighbors)].textStart;
    end = document.blocks[Math.min(document.blocks.length - 1, last + neighbors)].textEnd;
  } else { throw new MaterialError('INVALID_REQUEST', '必须选择章节、检索命中或原文块'); }
  const cursor = boundedInteger(request.cursor, start, start, end);
  if (request.omitImageData === true) {
    const excerpts: MaterialPage['excerpts'] = []; let remaining = maxChars, pageEnd = cursor;
    for (const block of document.blocks) {
      if (block.textEnd <= cursor || block.textStart >= end) continue;
      if (!remaining || excerpts.length >= 80) break;
      const textStart = Math.max(cursor, block.textStart);
      const blockEnd = Math.min(block.textEnd, end);
      const original = document.normalizedText.slice(block.textStart, blockEnd);
      const projected = projectMaterialImageText(original, textStart - block.textStart, remaining, block.kind !== 'code');
      if (!projected.text) break;
      const textEnd = block.textStart + projected.rawEnd;
      excerpts.push({ blockId: block.id, kind: block.kind, sectionPath: block.sectionPath, locator: block.locator,
        formulaEvidence: blockFormulaEvidence(document, block),
        text: projected.text, textStart, textEnd, excerptHash: materialHash(projected.text),
        partialBlock: textStart !== block.textStart || textEnd !== block.textEnd,
        ...(projected.imageDataOmitted ? { imageDataOmitted: true, imageReferences: projected.imageReferences } : {}) });
      remaining -= projected.text.length; pageEnd = textEnd;
      if (textEnd < blockEnd) break;
    }
    if (pageEnd >= (document.blocks.filter(block => block.textStart < end).at(-1)?.textEnd || end)) pageEnd = end;
    return { docId: doc.id, fileName: doc.fileName, version, targetStart: start, targetEnd: end,
      excerpts, truncated: pageEnd < end, nextCursor: pageEnd < end ? pageEnd : undefined };
  }
  let pageEnd = Math.min(end, cursor + maxChars);
  // 不切开 UTF-16 代理对，续读仍使用全局坐标。
  if (pageEnd < end && /[\uD800-\uDBFF]/u.test(document.normalizedText[pageEnd - 1])) pageEnd--;
  const selected = document.blocks.filter((block) => block.textEnd > cursor && block.textStart < pageEnd);
  if (selected.length > 80) pageEnd = selected[79].textEnd;
  pageEnd = Math.min(pageEnd, end, cursor + maxChars);
  const excerpts = selected.slice(0, 80).map((block) => {
    const textStart = Math.max(cursor, block.textStart);
    const textEnd = Math.min(pageEnd, block.textEnd);
    const text = document.normalizedText.slice(textStart, textEnd);
    return { blockId: block.id, kind: block.kind, sectionPath: block.sectionPath, locator: block.locator,
      formulaEvidence: blockFormulaEvidence(document, block),
      text, textStart, textEnd, excerptHash: materialHash(text),
      partialBlock: textStart !== block.textStart || textEnd !== block.textEnd };
  });
  return { docId: doc.id, fileName: doc.fileName, version, targetStart: start, targetEnd: end,
    excerpts, truncated: pageEnd < end, nextCursor: pageEnd < end ? pageEnd : undefined };
}

/** Read only an embedded raster from the exact versioned source block; never follow a URL or path. */
export async function readMaterialImage(request: MaterialImageRequest): Promise<MaterialImage> {
  if (!request || !/^[a-f0-9]{64}$/u.test(request.version) || typeof request.blockId !== 'string'
    || !Number.isSafeInteger(request.imageIndex) || request.imageIndex < 0 || request.imageIndex >= PDF_FORMULA_IMAGE_INDEX + MAX_PDF_FORMULA_REGIONS
    || (request.attachmentHash !== undefined && (!/^[a-f0-9]{64}$/u.test(request.attachmentHash) || request.saveAttachment))
    || (request.saveAttachment !== undefined && typeof request.saveAttachment !== 'boolean')) {
    throw new MaterialError('INVALID_REQUEST', '图片引用需要有效的资料版本、原文块和素材编号');
  }
  if (request.attachmentHash) return readTextbookImageAttachment(request);
  const { doc, document } = await loadMaterial(request, request.docId, request.version);
  const block = document.blocks.find((item) => item.id === request.blockId && item.kind !== 'code');
  if (!block) throw new MaterialError('TARGET_MISSING', '图片所在原文块已不存在');
  if (doc.fileType === 'pdf' && block.locator.kind === 'pdf' && request.imageIndex >= PDF_PAGE_IMAGE_INDEX) {
    const region = request.imageIndex === PDF_PAGE_IMAGE_INDEX ? undefined
      : blockFormulaRegions(document, block)[request.imageIndex - PDF_FORMULA_IMAGE_INDEX];
    if (request.imageIndex !== PDF_PAGE_IMAGE_INDEX && (!region || region.locator.kind !== 'pdf')) {
      throw new MaterialError('TARGET_MISSING', '公式候选区域不存在，不接受任意裁剪坐标');
    }
    const page = region?.locator.kind === 'pdf' ? region.locator.page : block.locator.page;
    const result = await readPdfVisual(await materialSourcePath(doc), page, region?.region);
    await loadMaterial(request, request.docId, request.version); // Never return bytes from a replaced source.
    const image = { dataUrl: result.dataUrl!, alt: result.alt! };
    return request.saveAttachment ? saveTextbookImageAttachment(request, image) : image;
  }
  const image = embeddedLocalImages(document.normalizedText.slice(block.textStart, block.textEnd)).find((item) => item.index === request.imageIndex);
  if (!image) throw new MaterialError('UNSUPPORTED', '此图片尚未缓存为本地内嵌素材；不会自动下载或读取任意路径');
  const result = { dataUrl: image.dataUrl, alt: image.alt };
  return request.saveAttachment ? saveTextbookImageAttachment(request, result) : result;
}
