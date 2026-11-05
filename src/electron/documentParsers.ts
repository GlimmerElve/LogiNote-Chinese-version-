import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { unzipSync } from 'fflate';
import type { StructuredDocument, UploadedDocumentFileType } from '../types';
import { extractPdfDocument, extractPdfText } from './pdf.ts';
import {
  buildStructuredDocument,
  buildTextStructuredDocument,
  type LocatedTextBlock,
} from './rag/structuredDocument.ts';

export interface DocumentTypeDescriptor {
  fileType: UploadedDocumentFileType;
  extension: string;
  indexable: boolean;
}

const TYPE_BY_EXTENSION: Record<string, Omit<DocumentTypeDescriptor, 'extension'>> = {
  '.txt': { fileType: 'txt', indexable: true },
  '.md': { fileType: 'md', indexable: true },
  '.markdown': { fileType: 'md', indexable: true },
  '.pdf': { fileType: 'pdf', indexable: true },
  '.docx': { fileType: 'docx', indexable: true },
  '.pptx': { fileType: 'pptx', indexable: true },
  '.doc': { fileType: 'doc', indexable: false },
  '.ppt': { fileType: 'ppt', indexable: false },
  '.xlsx': { fileType: 'xlsx', indexable: false },
  '.xls': { fileType: 'xls', indexable: false },
  '.epub': { fileType: 'epub', indexable: false },
  '.png': { fileType: 'image', indexable: false },
  '.jpg': { fileType: 'image', indexable: false },
  '.jpeg': { fileType: 'image', indexable: false },
  '.gif': { fileType: 'image', indexable: false },
  '.webp': { fileType: 'image', indexable: false },
  '.svg': { fileType: 'image', indexable: false },
  '.mp3': { fileType: 'audio', indexable: false },
  '.wav': { fileType: 'audio', indexable: false },
  '.ogg': { fileType: 'audio', indexable: false },
  '.m4a': { fileType: 'audio', indexable: false },
  '.flac': { fileType: 'audio', indexable: false },
  '.mp4': { fileType: 'video', indexable: false },
  '.webm': { fileType: 'video', indexable: false },
  '.mkv': { fileType: 'video', indexable: false },
  '.mov': { fileType: 'video', indexable: false },
  '.avi': { fileType: 'video', indexable: false },
  '.zip': { fileType: 'archive', indexable: false },
  '.rar': { fileType: 'archive', indexable: false },
  '.7z': { fileType: 'archive', indexable: false },
};

export const SUPPORTED_DOCUMENT_EXTENSIONS = Object.keys(TYPE_BY_EXTENSION).map((item) => item.slice(1));

export function detectDocumentType(fileName: string): DocumentTypeDescriptor | null {
  const extension = path.extname(String(fileName || '')).toLocaleLowerCase();
  const descriptor = TYPE_BY_EXTENSION[extension];
  return descriptor ? { ...descriptor, extension } : null;
}

function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/giu, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/gu, (_match, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, '&');
}

function textNodes(xml: string, namespace: 'w' | 'a'): string[] {
  const expression = new RegExp(`<${namespace}:t(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${namespace}:t>`, 'giu');
  return [...xml.matchAll(expression)]
    .map((match) => decodeXml(match[1]).replace(/\s+/gu, ' ').trim())
    .filter(Boolean);
}

function inspectZip(buffer: Uint8Array): void {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let eocd = -1;
  const start = Math.max(0, buffer.byteLength - 65_557);
  for (let offset = buffer.byteLength - 22; offset >= start; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0) throw new Error('文件不是有效的 OOXML/ZIP 文档');
  const entries = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  let offset = view.getUint32(eocd + 16, true);
  if (entries > 5_000 || centralSize > 20 * 1024 * 1024) throw new Error('Office 文档结构异常或条目过多');
  let totalUncompressed = 0;
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > buffer.byteLength || view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error('Office 文档中央目录损坏');
    }
    const uncompressed = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    totalUncompressed += uncompressed;
    if (uncompressed > 50 * 1024 * 1024 || totalUncompressed > 200 * 1024 * 1024) {
      throw new Error('Office 文档解压后体积过大');
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
}

async function unzipOffice(filePath: string): Promise<Record<string, Uint8Array>> {
  const buffer = new Uint8Array(await readFile(filePath));
  if (buffer.byteLength > 100 * 1024 * 1024) throw new Error('Office 文档超过 100 MB');
  inspectZip(buffer);
  return unzipSync(buffer);
}

function xmlEntry(entries: Record<string, Uint8Array>, name: string): string {
  const value = entries[name];
  return value ? new TextDecoder('utf-8').decode(value) : '';
}

async function extractDocxLocatedBlocks(filePath: string): Promise<LocatedTextBlock[]> {
  const entries = await unzipOffice(filePath);
  const documentXml = xmlEntry(entries, 'word/document.xml');
  if (!documentXml) throw new Error('DOCX 缺少 word/document.xml');
  const paragraphs = [...documentXml.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/giu)];
  const headingStack: string[] = [];
  let sectionPath = '';
  return paragraphs.flatMap((match, paragraphIndex): LocatedTextBlock[] => {
    const body = match[1];
    const text = textNodes(body, 'w').join('').trim();
    if (!text) return [];
    const style = /<w:pStyle[^>]*w:val="([^"]+)"/iu.exec(body)?.[1] || '';
    const heading = /(?:heading|标题)\s*([1-6])/iu.exec(style)?.[1];
    if (heading) {
      const level = Number(heading);
      headingStack.length = level - 1;
      headingStack.push(text);
      sectionPath = headingStack.filter(Boolean).join(' > ');
    }
    return [{
      text: `${heading ? `${'#'.repeat(Number(heading))} ` : ''}${text}`,
      kind: heading ? 'heading' : 'paragraph',
      sectionPath,
      locator: { kind: 'docx', paragraphIndex },
    }];
  });
}

export async function extractDocxText(filePath: string): Promise<string> {
  return (await extractDocxLocatedBlocks(filePath)).map((block) => block.text).join('\n\n').trim();
}

function numberedEntryNames(entries: Record<string, Uint8Array>, expression: RegExp): string[] {
  return Object.keys(entries)
    .filter((name) => expression.test(name))
    .sort((left, right) => {
      const leftNumber = Number(/(\d+)\.xml$/u.exec(left)?.[1] || 0);
      const rightNumber = Number(/(\d+)\.xml$/u.exec(right)?.[1] || 0);
      return leftNumber - rightNumber;
    });
}

async function extractPptxLocatedBlocks(filePath: string): Promise<LocatedTextBlock[]> {
  const entries = await unzipOffice(filePath);
  const slideNames = numberedEntryNames(entries, /^ppt\/slides\/slide\d+\.xml$/u);
  if (slideNames.length === 0) throw new Error('PPTX 中没有可读取的幻灯片');
  return slideNames.flatMap((name, index): LocatedTextBlock[] => {
    const slideIndex = index + 1;
    const slideText = textNodes(xmlEntry(entries, name), 'a');
    const title = slideText[0] || `第 ${slideIndex} 页`;
    const body = slideText.slice(1);
    const sectionPath = `第 ${slideIndex} 页 · ${title}`;
    const notes = textNodes(xmlEntry(entries, `ppt/notesSlides/notesSlide${slideIndex}.xml`), 'a')
      .filter((item) => item !== String(slideIndex));
    return [
      {
        text: `# ${sectionPath}`,
        kind: 'heading',
        sectionPath,
        locator: { kind: 'pptx', slideIndex, shapeIndex: 0 },
      },
      ...body.map((text, shapeIndex): LocatedTextBlock => ({
        text,
        kind: 'paragraph',
        sectionPath,
        locator: { kind: 'pptx', slideIndex, shapeIndex: shapeIndex + 1 },
      })),
      ...(notes.length ? [{
        text: '## 演讲者备注',
        kind: 'heading' as const,
        sectionPath: `${sectionPath} > 演讲者备注`,
        locator: { kind: 'pptx' as const, slideIndex, notes: true },
      }, ...notes.map((text, shapeIndex): LocatedTextBlock => ({
        text,
        kind: 'notes',
        sectionPath: `${sectionPath} > 演讲者备注`,
        locator: { kind: 'pptx', slideIndex, shapeIndex, notes: true },
      }))] : []),
    ];
  });
}

export async function extractPptxText(filePath: string): Promise<string> {
  return (await extractPptxLocatedBlocks(filePath))
    .map((block) => block.text)
    .join('\n\n')
    .replace(/(## 演讲者备注)\n\n/gu, '$1\n')
    .trim();
}

type DocumentTextParser = (filePath: string) => Promise<string>;

const DOCUMENT_PARSERS: Partial<Record<UploadedDocumentFileType, DocumentTextParser>> = {
  txt: (filePath) => readFile(filePath, 'utf-8'),
  md: (filePath) => readFile(filePath, 'utf-8'),
  pdf: extractPdfText,
  docx: extractDocxText,
  pptx: extractPptxText,
};

export function hasDocumentParser(fileType: UploadedDocumentFileType): boolean {
  return typeof DOCUMENT_PARSERS[fileType] === 'function';
}

export async function extractDocumentText(filePath: string, fileType: UploadedDocumentFileType): Promise<string> {
  const parser = DOCUMENT_PARSERS[fileType];
  if (!parser) throw new Error(`当前没有 ${fileType.toUpperCase()} 文本解析器`);
  return parser(filePath);
}

/** 新的 L0 入口；旧纯文本入口继续用于兼容测试和非 RAG 消费者。 */
export async function extractStructuredDocument(
  filePath: string,
  fileType: UploadedDocumentFileType,
  docId: string,
): Promise<StructuredDocument> {
  if (fileType === 'txt' || fileType === 'md') {
    return buildTextStructuredDocument(docId, await readFile(filePath, 'utf-8'));
  }
  if (fileType === 'pdf') {
    const extracted = await extractPdfDocument(filePath);
    const blocks: LocatedTextBlock[] = extracted.blocks.map((block) => ({
      text: block.text,
      kind: block.kind,
      locator: block.sourceFragments[0]?.locator || {
        kind: 'pdf', page: block.page, bbox: block.bbox, blockIndex: block.blockIndex,
      },
      sourceFragments: block.sourceFragments,
    }));
    if (blocks.length === 0 && extracted.text) {
      blocks.push({ text: extracted.text, kind: 'paragraph', locator: { kind: 'pdf', page: 1 } });
    }
    return buildStructuredDocument(docId, blocks, { preprocessing: extracted.preprocessing });
  }
  if (fileType === 'docx') {
    return buildStructuredDocument(docId, await extractDocxLocatedBlocks(filePath));
  }
  if (fileType === 'pptx') {
    return buildStructuredDocument(docId, await extractPptxLocatedBlocks(filePath));
  }
  throw new Error(`当前没有 ${fileType.toUpperCase()} 结构化解析器`);
}
