import type { UploadedDocument, DocumentSearchResult } from '../types';

type RagDocsApi = {
  chooseFiles: () => Promise<string[]>;
  upload: (filePaths: string[]) => Promise<{ ok: boolean; documents?: unknown[]; error?: string }>;
  list: () => Promise<unknown[]>;
  getStatus: (docId: string) => Promise<{ status: string; chunkCount: number; totalChars: number; error?: string }>;
  retry: (docId: string) => Promise<void>;
  delete: (docId: string) => Promise<void>;
  search: (query: string, k?: number) => Promise<unknown[]>;
  onChanged: (callback: () => void) => () => void;
};

function getApi(): RagDocsApi | null {
  const api = (window as any).electronAPI?.ragDocs;
  return api || null;
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

/** 重试失败文档 */
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
export async function searchDocuments(query: string, k = 5): Promise<DocumentSearchResult[]> {
  const api = getApi();
  if (!api) return [];
  return (await api.search(query, k)) as DocumentSearchResult[];
}

/** 订阅资料变化（状态流转/增删），返回取消订阅函数 */
export function subscribeDocumentChanges(callback: () => void): () => void {
  const api = getApi();
  if (!api) return () => {};
  return api.onChanged(callback);
}