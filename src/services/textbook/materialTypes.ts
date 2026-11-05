import type { DocumentStatus, SourceBlockKind, SourceLocator, UploadedDocumentFileType } from '../../types';

/** 这里只限制本次教材物料读取，不改变资料库/推荐工作台的用户添加数量。 */
export interface MaterialScope { allowedDocIds: string[] }
export type MaterialErrorCode = 'INVALID_REQUEST' | 'OUT_OF_SCOPE' | 'SOURCE_MISSING'
  | 'SOURCE_CHANGED' | 'NOT_PARSED' | 'UNSUPPORTED' | 'INVALID_SOURCE' | 'TARGET_MISSING';
export type MaterialResult<T> = { ok: true; value: T }
  | { ok: false; code: MaterialErrorCode; error: string };

export interface MaterialSection {
  id: string;
  title: string;
  level: number;
  sectionPath: string;
  textStart: number;
  textEnd: number;
  locator: SourceLocator;
}
export interface MaterialAsset {
  id: string;
  blockId: string;
  kind: 'code' | 'table' | 'formula' | 'image_reference' | 'caption';
  /** PDF pages can be rendered without recognising their content. */
  availability: 'text' | 'reference_only' | 'local_embedded' | 'local_rendered';
  locator: SourceLocator;
}
export interface MaterialDocumentSummary {
  docId: string;
  fileName: string;
  fileType: UploadedDocumentFileType;
  parseStatus: 'pending' | 'ready' | 'failed' | 'unsupported' | 'stale' | 'missing';
  indexStatus: DocumentStatus;
  version?: string;
  totalChars?: number;
  blockCount?: number;
  sectionCount?: number;
  assetCount?: number;
  error?: string;
}
export interface MaterialCatalogRequest extends MaterialScope {
  docId: string;
  version?: string;
  offset?: number;
  limit?: number;
}
export interface MaterialCatalog {
  document: MaterialDocumentSummary;
  sections: MaterialSection[];
  assets: MaterialAsset[];
  nextOffset?: number;
  assetsTruncated: boolean;
}
export interface MaterialSearchRequest extends MaterialScope {
  docId: string;
  version?: string;
  query: string;
  /** Leaf-project anchors retain the subject when a page title is generic. */
  subject?: string;
  topic?: string;
  limit?: number;
}
export interface MaterialSearch {
  document: MaterialDocumentSummary;
  hits: Array<{blockId:string;sectionPath:string;locator:SourceLocator;textStart:number;textEnd:number;matchStart?:number;score:number;matchedTerms:string[]}>;
}
export type MaterialTarget = { kind: 'document' } | { kind: 'section'; sectionId: string }
  | { kind: 'chunk'; chunkId: string; neighbors?: number }
  | { kind: 'block'; blockId: string; neighbors?: number };
export interface MaterialReadRequest extends MaterialScope {
  /** Textbook-only projection; retain source offsets, omit inline raster bytes. */
  omitImageData?: boolean;
  docId: string;
  version: string;
  target: MaterialTarget;
  /** 全局归一化文本坐标；只能位于所选目标范围内，续读必须携带同一版本。 */
  cursor?: number;
  maxChars?: number;
}
export interface MaterialExcerpt {
  formulaEvidence?: Array<import('../../types').FormulaEvidence & { locator: SourceLocator }>;
  imageDataOmitted?: boolean;
  imageReferences?: Array<{ imageIndex: number; alt: string }>;
  blockId: string;
  kind: SourceBlockKind;
  sectionPath: string;
  locator: SourceLocator;
  text: string;
  textStart: number;
  textEnd: number;
  excerptHash: string;
  partialBlock: boolean;
}
export interface MaterialPage {
  docId: string;
  fileName: string;
  version: string;
  targetStart: number;
  targetEnd: number;
  excerpts: MaterialExcerpt[];
  nextCursor?: number;
  truncated: boolean;
}

export type DocumentReadingSource = { docId: string; fileName: string } & (
  { kind: 'pdf'; url: string } | { kind: 'text' }
);

export interface MaterialImageRequest extends MaterialScope {
  /** Read a durable textbook attachment, independent from the original source. */
  attachmentHash?: string;
  /** Save only after a strict original-version read; never upload pixels. */
  saveAttachment?: boolean;
  docId: string;
  version: string;
  blockId: string;
  imageIndex: number;
}
export interface MaterialImage { dataUrl: string; alt: string; attachmentHash?: string }
