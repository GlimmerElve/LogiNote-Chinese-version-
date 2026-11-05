import type { UploadedDocument, DocumentPreview, DocumentSearchOptions, DocumentSearchResult } from '../types';
import type { DocumentMaintenanceCommand } from './documentMaintenance';
import type { MaterialScope, MaterialCatalogRequest, MaterialReadRequest, MaterialCatalog,
  MaterialDocumentSummary, MaterialPage, MaterialResult, MaterialImageRequest, MaterialImage, DocumentReadingSource } from './textbook/materialTypes';
import { MaterialError } from './textbook/materialScope';
import type { MaterialSearchRequest, MaterialSearch } from './textbook/materialTypes';
import { emptyQaDocumentGraph, validateQaGraphAnchors, type QaGraphAnchor, type QaDocumentGraph } from './agent/qaDocumentGraph';
import type {DocumentGraphCommit, DocumentGraphSourceSnapshot} from './documentGraphTypes';
import type {DocumentArgumentV5Commit, DocumentArgumentV5Snapshot,DocumentArgumentGraphView,DocumentArgumentV5ResponseRecord} from './documentArgumentV5Types';
import type {DocumentArgumentBridgeTask} from './documentArgumentV5Pipeline';

type RagDocsApi = {
  maintain?: (input: DocumentMaintenanceCommand) => Promise<void>;
  processingContext?:()=>Promise<string>;
  chooseFiles: () => Promise<string[]>;
  upload: (filePaths: string[]) => Promise<{ ok: boolean; documents?: unknown[]; error?: string }>;
  list: () => Promise<unknown[]>;
  setCategory?: (docId: string, category?: string) => Promise<void>;
  materialList: (scope: MaterialScope) => Promise<MaterialResult<MaterialDocumentSummary[]>>;
  materialPrepare: (scope: MaterialScope, docId: string) => Promise<MaterialResult<MaterialDocumentSummary>>;
  materialCatalog: (request: MaterialCatalogRequest) => Promise<MaterialResult<MaterialCatalog>>;
  materialRead: (request: MaterialReadRequest) => Promise<MaterialResult<MaterialPage>>;
  materialSearch?: (request: MaterialSearchRequest) => Promise<MaterialResult<MaterialSearch>>;
  materialImage: (request: MaterialImageRequest) => Promise<MaterialResult<MaterialImage>>;
  preview: (docId: string, chunkId?: string) => Promise<{ ok: boolean; preview?: unknown; error?: string }>;
  getStatus: (docId: string) => Promise<{ status: string; chunkCount: number; totalChars: number; error?: string;
    parseStatus?: UploadedDocument['parseStatus']; parseError?: string; parsedAt?: string }>;
  retry: (docId: string) => Promise<void>;
  resetArgumentV5?: (docId:string)=>Promise<void>;
  argumentV5View?: (docId:string)=>Promise<DocumentArgumentGraphView>;
  open: (docId: string) => Promise<{ ok: boolean; error?: string }>;
  readingSource?: (docId: string) => Promise<MaterialResult<DocumentReadingSource>>;
  delete: (docId: string) => Promise<void>;
  search: (query: string, k?: number, options?: DocumentSearchOptions) => Promise<unknown[]>;
  readArgumentEvidence?: (anchors: QaGraphAnchor[], query?:string, intentQuery?:string) => Promise<QaDocumentGraph>;
  prepareDocumentGraph?: (docId: string) => Promise<DocumentGraphSourceSnapshot>;
  commitDocumentGraph?: (input: DocumentGraphCommit,environmentId?:string) => Promise<{revision:string;nodes:number;relations:number}>;
  recallDocumentGraphCandidates?: (input:DocumentGraphCommit,targetIds:string[]) => Promise<Record<string,string[]>>;
  prepareArgumentV5?: (docId: string) => Promise<DocumentArgumentV5Snapshot>;
  commitArgumentV5?: (input: DocumentArgumentV5Commit, environmentId: string) => Promise<{revision:string;nodes:number;relations:number}>;
  recordArgumentV5Response?: (input:DocumentArgumentV5ResponseRecord,environmentId:string)=>Promise<void>;
  recallArgumentV5Bridges?: (input: DocumentArgumentV5Commit, environmentId: string) => Promise<DocumentArgumentBridgeTask[]>;
  onChanged: (callback: () => void) => () => void;
};

function getApi(): RagDocsApi | null {
  const api = (window as any).electronAPI?.ragDocs;
  return api || null;
}

export async function maintainDocument(input: DocumentMaintenanceCommand): Promise<void> {
  const api = getApi();
  if (!api?.maintain) throw new Error('资料维护需要重启更新后的桌面版；未降级为无版本校验的写入');
  await api.maintain(input);
}

/** 判断当前是否运行在支持资料文档 RAG 的 Electron 环境 */
export function isDocumentRagAvailable(): boolean {
  return !!getApi();
}

/** 弹出文件选择框（多选 txt/md/pdf），返回绝对路径数组 */
export async function chooseDocumentFiles(): Promise<string[]> {
  const api = getApi();
  if (!api) return [];
  return api.chooseFiles();
}

/** 上传文档，返回成功后的文档列表 */
export async function uploadDocuments(filePaths: string[]): Promise<UploadedDocument[]> {
  const api = getApi();
  if (!api) throw new Error('资料文档功能仅在桌面版可用');
  const res = await api.upload(filePaths);
  if (!res.ok) throw new Error(res.error || '上传失败');
  return (res.documents || []) as UploadedDocument[];
}

/** 列出全部文档 */
export async function listDocuments(): Promise<UploadedDocument[]> {
  const api = getApi();
  if (!api) return [];
  return (await api.list()) as UploadedDocument[];
}

/** Body-only local reparse/chunk/embed. Never calls or resets argument extraction. */
export async function retryDocument(docId: string): Promise<void> {
  const api = getApi();
  if (!api) return;
  await api.retry(docId);
}

/** 删除文档及其向量分块 */
export async function deleteDocument(docId: string): Promise<void> {
  const api = getApi();
  if (!api) return;
  await api.delete(docId);
}

/** 检索资料文档（仅已向量化完成的文档） */
export async function searchDocuments(query: string, k = 5, options?: DocumentSearchOptions): Promise<DocumentSearchResult[]> {
  const api = getApi();
  if (!api) return [];
  return (await api.search(query, k, options)) as DocumentSearchResult[];
}

/** 订阅资料变化（状态流转/增删），返回取消订阅函数 */
export function subscribeDocumentChanges(callback: () => void): () => void {
  const api = getApi();
  if (!api) return () => {};
  return api.onChanged(callback);
}

/** 只修改资料库展示分类，不重建正文索引或论证图。 */
export async function setDocumentCategory(docId: string, category?: string): Promise<void> {
  const api = getApi();
  if (!api?.setCategory) throw new Error('请重启更新后的桌面版后再整理资料分类');
  await api.setCategory(docId, category?.trim() || undefined);
}
export async function documentProcessingContext():Promise<string>{
  const api=getApi();if(!api?.processingContext)throw new Error('后台资料处理需要重启更新后的桌面版');
  return api.processingContext();
}
export async function resetDocumentArgumentGraph(docId:string){
  const api=getApi();if(!api?.resetArgumentV5)throw new Error('请重启更新后的桌面版以重新生成论证图');
  await api.resetArgumentV5(docId);
}
export async function readDocumentArgumentGraphView(docId:string){
  const api=getApi();if(!api?.argumentV5View)throw new Error('请重启更新后的桌面版以查看论证图');
  return api.argumentV5View(docId);
}

/** No cloud calls or writes; old desktop versions keep passage QA available. */
export async function readDocumentArgumentEvidence(anchors: QaGraphAnchor[], query?:string, intentQuery?:string): Promise<QaDocumentGraph> {
  const validated = validateQaGraphAnchors(anchors);
  const api = getApi();
  if (!api?.readArgumentEvidence) return emptyQaDocumentGraph('desktop_graph_reader_unavailable');
  return api.readArgumentEvidence(validated,query?.slice(0,2000),intentQuery?.slice(0,2000));
}

/** Explicit ingestion adapter; never imports experimental files or calls a cloud model on its own. */
export async function prepareDocumentGraph(docId: string): Promise<DocumentGraphSourceSnapshot> {
  const api=getApi(); if (!api?.prepareDocumentGraph) throw new Error('新版资料图谱存储仅在更新后的桌面版可用');
  return api.prepareDocumentGraph(docId);
}
export async function commitExtractedDocumentGraph(input: DocumentGraphCommit,environmentId?:string) {
  const api=getApi(); if (!api?.commitDocumentGraph) throw new Error('新版资料图谱存储仅在更新后的桌面版可用');
  return api.commitDocumentGraph(input,environmentId);
}
export async function recallDocumentGraphCandidates(input:DocumentGraphCommit,targetIds:string[]){
  const api=getApi();if(!api?.recallDocumentGraphCandidates)throw new Error('需要更新桌面版的跨图候选读取器');
  return api.recallDocumentGraphCandidates(input,targetIds);
}

export async function prepareDocumentArgumentV5(docId: string) {
  const api = getApi();
  if (!api?.prepareArgumentV5) throw new Error('v5.0 资料处理需要重启更新后的桌面版');
  return api.prepareArgumentV5(docId);
}
export async function commitDocumentArgumentV5(input: DocumentArgumentV5Commit, environmentId: string) {
  const api = getApi();
  if (!api?.commitArgumentV5) throw new Error('v5.0 资料图谱存储接口不可用');
  return api.commitArgumentV5(input, environmentId);
}
export async function recordDocumentArgumentV5Response(input:DocumentArgumentV5ResponseRecord,environmentId:string){
  const api=getApi();
  if(!api?.recordArgumentV5Response)throw new Error('请重启更新后的桌面版以保留模型响应');
  await api.recordArgumentV5Response(input,environmentId);
}
export async function recallDocumentArgumentV5Bridges(input: DocumentArgumentV5Commit, environmentId: string) {
  const api = getApi();
  if (!api?.recallArgumentV5Bridges) throw new Error('v5.0 局部补链接口不可用');
  return api.recallArgumentV5Bridges(input, environmentId);
}

export async function previewDocument(docId: string, chunkId?: string): Promise<DocumentPreview> {
  const api = getApi();
  if (!api) throw new Error('资料文档功能仅在桌面版可用');
  const result = await api.preview(docId, chunkId);
  if (!result.ok || !result.preview) throw new Error(result.error || '无法读取资料索引预览');
  return result.preview as DocumentPreview;
}

export async function openDocument(docId: string): Promise<void> {
  const api = getApi();
  if (!api) throw new Error('资料文档功能仅在桌面版可用');
  const result = await api.open(docId);
  if (!result.ok) throw new Error(result.error || '无法打开资料');
}

export async function readDocumentSource(docId: string): Promise<DocumentReadingSource> {
  const api = getApi();
  if (!api?.readingSource) throw new Error('请重启更新后的桌面版以在心流中阅读本地资料');
  return unwrapMaterial(await api.readingSource(docId));
}

function getMaterialApi(): RagDocsApi {
  const api = getApi();
  if (!api?.materialRead || !api.materialCatalog || !api.materialPrepare || !api.materialList) {
    throw new Error('本地教材物料深读需要更新后的桌面版，请重启应用');
  }
  return api;
}
function unwrapMaterial<T>(result: MaterialResult<T>): T {
  if (result.ok === false) throw new MaterialError(result.code, result.error);
  return result.value;
}
export async function listLocalMaterials(scope: MaterialScope): Promise<MaterialDocumentSummary[]> {
  return unwrapMaterial(await getMaterialApi().materialList(scope));
}
export async function prepareLocalMaterial(scope: MaterialScope, docId: string): Promise<MaterialDocumentSummary> {
  return unwrapMaterial(await getMaterialApi().materialPrepare(scope, docId));
}
export async function readLocalMaterialCatalog(request: MaterialCatalogRequest): Promise<MaterialCatalog> {
  return unwrapMaterial(await getMaterialApi().materialCatalog(request));
}
export async function readLocalMaterialPage(request: MaterialReadRequest): Promise<MaterialPage> {
  return unwrapMaterial(await getMaterialApi().materialRead(request));
}
export async function searchLocalMaterial(request: MaterialSearchRequest): Promise<MaterialSearch> {
  const api=getMaterialApi();
  if(!api.materialSearch)throw new Error('本地原文检索需要重启更新后的桌面版');
  return unwrapMaterial(await api.materialSearch(request));
}
export async function readLocalMaterialImage(request: MaterialImageRequest): Promise<MaterialImage> {
  const api = getMaterialApi();
  if (!api.materialImage) throw new Error('本地图片读取需要更新后的桌面版，请重启应用');
  return unwrapMaterial(await api.materialImage(request));
}
