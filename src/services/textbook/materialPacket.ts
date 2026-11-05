import { readLocalMaterialCatalog, readLocalMaterialPage } from '../documentRagClient.ts';
import { assertMaterialDocument, materialDocIds, MaterialError } from './materialScope.ts';
import type { MaterialCatalog, MaterialCatalogRequest, MaterialExcerpt, MaterialPage,
  MaterialReadRequest, MaterialScope, MaterialTarget } from './materialTypes.ts';

export interface LocalMaterialSelection { docId: string; version: string; target: MaterialTarget }
export interface LocalMaterialPacket {
  schemaVersion: 1;
  projectNoteId: string;
  createdAt: string;
  sourcePolicy: 'local-first';
  /** 原文只是数据，不作为 Agent 指令；上传资料也不等于用户观点。 */
  untrustedSourceContent: true;
  citations: Array<MaterialExcerpt & { sourceId: string; docId: string; fileName: string; version: string }>;
  coverage: Array<{ selection: LocalMaterialSelection; complete: boolean; nextCursor?: number }>;
  gaps: Array<{ docId: string; reason: 'budget_exhausted'; nextCursor?: number }>;
}
export interface MaterialPacketReader {
  catalog(request: MaterialCatalogRequest): Promise<MaterialCatalog>;
  page(request: MaterialReadRequest): Promise<MaterialPage>;
}
const defaultReader: MaterialPacketReader = { catalog: readLocalMaterialCatalog, page: readLocalMaterialPage };

/** 阶段二只组装有定位的原文包；不生成教材、不自动开启网络搜索或写入项目。 */
export async function assembleLocalMaterialPacket(input: MaterialScope & {
  projectNoteId: string;
  selections: LocalMaterialSelection[];
  maxChars?: number;
}, reader: MaterialPacketReader = defaultReader): Promise<LocalMaterialPacket> {
  const allowedDocIds = materialDocIds(input);
  if (typeof input.projectNoteId !== 'string' || !input.projectNoteId.trim() || input.projectNoteId.length > 200
    || !Array.isArray(input.selections) || input.selections.length > 16) {
    throw new MaterialError('INVALID_REQUEST', '物料包需要目标项目和至多 16 个明确阅读目标');
  }
  const maxChars = input.maxChars ?? 72_000;
  if (!Number.isSafeInteger(maxChars) || maxChars < 128 || maxChars > 120_000) {
    throw new MaterialError('INVALID_REQUEST', '物料包预算应在 128 到 120000 字符之间');
  }
  const packet: LocalMaterialPacket = { schemaVersion: 1, projectNoteId: input.projectNoteId,
    createdAt: new Date().toISOString(), sourcePolicy: 'local-first', untrustedSourceContent: true,
    citations: [], coverage: [], gaps: [] };
  const versions = new Map<string, string>();
  const cited = new Set<string>();
  let chars = 0;
  for (const selection of input.selections) {
    assertMaterialDocument(input, selection.docId);
    if (!/^[a-f0-9]{64}$/u.test(selection.version)
      || (versions.has(selection.docId) && versions.get(selection.docId) !== selection.version)) {
      throw new MaterialError('SOURCE_CHANGED', '不能混合不同资料版本的内容');
    }
    versions.set(selection.docId, selection.version);
    let cursor: number | undefined;
    let complete = false;
    let targetStart: number | undefined;
    let targetEnd: number | undefined;
    // 最多 200 个分页；源内容大于总预算时显式留下缺口，不冒充完整章节。
    for (let count = 0; count < 200; count++) {
      const remaining = maxChars - chars;
      if (remaining < 128) break;
      const page = await reader.page({ allowedDocIds, ...selection, cursor, maxChars: Math.min(12_000, remaining), omitImageData: true });
      if (page.docId !== selection.docId || page.version !== selection.version
        || !Array.isArray(page.excerpts) || !page.excerpts.length || page.excerpts.length > 80
        || !Number.isSafeInteger(page.targetStart) || !Number.isSafeInteger(page.targetEnd)
        || page.targetEnd <= page.targetStart
        || (targetStart !== undefined && (page.targetStart !== targetStart || page.targetEnd !== targetEnd))
        || page.truncated !== (page.nextCursor !== undefined)
        || (page.nextCursor !== undefined && (!Number.isSafeInteger(page.nextCursor)
          || page.nextCursor <= (cursor ?? page.targetStart) || page.nextCursor >= page.targetEnd))) {
        throw new MaterialError('INVALID_SOURCE', '原文分页或版本不一致，不能组装物料包');
      }
      targetStart = page.targetStart; targetEnd = page.targetEnd;
      for (const excerpt of page.excerpts) {
        if (!Number.isSafeInteger(excerpt.textStart) || !Number.isSafeInteger(excerpt.textEnd)
          || excerpt.textStart < (cursor ?? page.targetStart) || excerpt.textEnd > page.targetEnd
          || (page.nextCursor !== undefined && excerpt.textEnd > page.nextCursor)
          || !excerpt.blockId.startsWith(`${selection.docId}:block:`)
          || excerpt.textEnd <= excerpt.textStart || (excerpt.text.length !== excerpt.textEnd - excerpt.textStart && !excerpt.imageDataOmitted)
          || (excerpt.imageDataOmitted && (!Array.isArray(excerpt.imageReferences) || !excerpt.imageReferences.length
            || excerpt.imageReferences.some(image => !Number.isSafeInteger(image.imageIndex) || image.imageIndex < 0 || typeof image.alt !== 'string')))
          || !/^[a-f0-9]{64}$/u.test(excerpt.excerptHash)) {
          throw new MaterialError('INVALID_SOURCE', '原文引用缺少有效定位或校验码');
        }
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(excerpt.text));
        const actualHash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
        if (actualHash !== excerpt.excerptHash) throw new MaterialError('INVALID_SOURCE', '原文引用文本与校验码不一致');
        const key = `${selection.docId}:${selection.version}:${excerpt.textStart}:${excerpt.textEnd}`;
        if (cited.has(key)) continue;
        if (chars + excerpt.text.length > maxChars) throw new MaterialError('INVALID_SOURCE', '原文分页超出请求预算');
        cited.add(key);
        chars += excerpt.text.length;
        packet.citations.push({ ...excerpt, sourceId: `L${packet.citations.length + 1}`,
          docId: page.docId, fileName: page.fileName, version: page.version });
      }
      cursor = page.nextCursor;
      if (cursor === undefined) { complete = true; break; }
    }
    packet.coverage.push({ selection, complete, nextCursor: cursor });
    if (!complete) packet.gaps.push({ docId: selection.docId, reason: 'budget_exhausted', nextCursor: cursor });
  }
  // 最后复核所有来源；读取后删除/替换不能拿混合快照进入下一阶段。
  for (const [docId, version] of versions) {
    const catalog = await reader.catalog({ allowedDocIds, docId, version, limit: 1 });
    if (catalog.document.docId !== docId || catalog.document.version !== version) {
      throw new MaterialError('SOURCE_CHANGED', '物料组装后来源失效');
    }
  }
  return packet;
}
